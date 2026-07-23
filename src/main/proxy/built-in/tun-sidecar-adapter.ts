import { randomBytes, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isIP } from 'node:net'
import {
  SING_BOX_VERSION,
  verifyBundledSingBoxRuntime,
  type VerifiedSingBoxRuntime
} from './binary-manifest'
import {
  reserveLoopbackPort,
  type LoopbackPortLease,
  type ReserveLoopbackPort
} from './sing-box-service'
import {
  NativeTemporaryElevationProcessRunner,
  defaultPlatformCommandRunner,
  type PlatformCommandRequest,
  type PlatformCommandResult,
  type PlatformCommandRunner,
  type TemporaryElevatedProcessHandle,
  type TemporaryElevationLauncher,
  type TemporaryElevationProcessRunner
} from './platform-adapters'
import {
  TunElevationDeniedError,
  type TunBypassEndpoint,
  type TunBypassPlan,
  type TunPlatformAdapter,
  type TunPlatformSession,
  type TunPlatformStartRequest
} from './tun-controller'

const DIRECT_OUTBOUND = 'stone-tun-direct'
const MIXED_OUTBOUND = 'stone-tun-upstream-mixed'
const TUN_INBOUND = 'stone-tun-in'
const DEFAULT_TUN_ADDRESSES = Object.freeze([
  '172.30.255.1/30',
  'fdfe:dcba:9876::1/126'
])

export type ElevatedSingBoxTunErrorCode =
  | 'tun_runtime_invalid'
  | 'tun_config_invalid'
  | 'tun_start_failed'
  | 'tun_cleanup_failed'

export class ElevatedSingBoxTunError extends Error {
  public readonly code: ElevatedSingBoxTunErrorCode

  public constructor(code: ElevatedSingBoxTunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ElevatedSingBoxTunError'
    this.code = code
  }
}

export interface TunSidecarFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  writeFile(
    path: string,
    content: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number }
  ): Promise<unknown>
  rename(source: string, destination: string): Promise<unknown>
  rm(path: string, options: { force: true }): Promise<unknown>
}

const DEFAULT_FILE_SYSTEM: TunSidecarFileSystem = { mkdir, writeFile, rename, rm }

export interface ElevatedSingBoxTunAdapterOptions {
  userDataPath: string
  runtimeRoot: string
  manifestPath?: string
  platform?: NodeJS.Platform
  architecture?: string
  environment?: NodeJS.ProcessEnv
  verifyRuntime?: (options: {
    runtimeRoot: string
    manifestPath?: string
    platform?: NodeJS.Platform
    architecture?: string
  }) => Promise<VerifiedSingBoxRuntime>
  commandRunner?: PlatformCommandRunner
  processRunner?: TemporaryElevationProcessRunner
  fileSystem?: TunSidecarFileSystem
  randomId?: () => string
  /** Resolved before TUN activation so node/DNS addresses can bypass auto-route. */
  resolveHost?: (host: string) => Promise<readonly string[]>
  reservePort?: ReserveLoopbackPort
  fetchImplementation?: typeof fetch
  createSecret?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  healthTimeoutMs?: number
  healthIntervalMs?: number
}

export interface BuildElevatedTunSidecarConfigOptions {
  bypass: TunBypassPlan
  executablePath: string
  executableName?: string
  tunAddresses?: readonly string[]
  controllerPort?: number
  controllerSecret?: string
}

interface ActiveTunSidecar {
  handle: TemporaryElevatedProcessHandle
  configPath: string
  processStopped: boolean
  exit?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

type ElevatedProcessExit = Awaited<NonNullable<TemporaryElevatedProcessHandle['exit']>>

/**
 * A directly constructible TUN adapter for main. It verifies the complete
 * bundled runtime before every start, writes a process-scoped 0600 config, and
 * launches that exact runtime through UAC/sudo/pkexec. No service lifecycle is
 * exposed or installed.
 */
export class ElevatedSingBoxTunAdapter implements TunPlatformAdapter {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly verifyRuntime: NonNullable<ElevatedSingBoxTunAdapterOptions['verifyRuntime']>
  private readonly commandRunner: PlatformCommandRunner
  private readonly processRunner: TemporaryElevationProcessRunner
  private readonly fileSystem: TunSidecarFileSystem
  private readonly randomId: () => string
  private readonly resolveHost: (host: string) => Promise<readonly string[]>
  private readonly reservePort: ReserveLoopbackPort
  private readonly fetchImplementation: typeof fetch
  private readonly createSecret: () => string
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number
  private readonly configDirectory: string
  private readonly sessions = new Map<string, ActiveTunSidecar>()
  private readonly pendingCleanup = new Set<ActiveTunSidecar>()

  public constructor(private readonly options: ElevatedSingBoxTunAdapterOptions) {
    if (!options.userDataPath.trim()) throw new Error('A user data path is required for the TUN sidecar.')
    if (!options.runtimeRoot.trim()) throw new Error('A sing-box runtime root is required for the TUN sidecar.')
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.environment = options.environment ?? process.env
    this.verifyRuntime = options.verifyRuntime ?? verifyBundledSingBoxRuntime
    this.commandRunner = options.commandRunner ?? defaultPlatformCommandRunner
    this.processRunner = options.processRunner ?? new NativeTemporaryElevationProcessRunner({
      commandRunner: this.commandRunner
    })
    this.fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM
    this.randomId = options.randomId ?? randomUUID
    this.resolveHost = options.resolveHost ?? resolveAllAddresses
    this.reservePort = options.reservePort ?? reserveLoopbackPort
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'))
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.healthTimeoutMs = Math.max(250, options.healthTimeoutMs ?? 10_000)
    this.healthIntervalMs = Math.max(10, options.healthIntervalMs ?? 100)
    this.configDirectory = join(options.userDataPath, 'built-in-proxy', 'tun-sidecar')
    elevationLauncher(this.platform)
  }

  public async startTemporaryElevated(
    request: TunPlatformStartRequest
  ): Promise<TunPlatformSession> {
    let runtime: VerifiedSingBoxRuntime
    try {
      runtime = await this.verifyRuntime({
        runtimeRoot: this.options.runtimeRoot,
        manifestPath: this.options.manifestPath,
        platform: this.platform,
        architecture: this.architecture
      })
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_runtime_invalid',
        'The bundled sing-box TUN runtime is missing or failed integrity verification.',
        { cause: error }
      )
    }

    let bypass: TunBypassPlan
    try {
      bypass = await resolveTunEndpointAddresses(request.bypass, this.resolveHost)
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_config_invalid',
        'A proxy node or DNS upstream could not be resolved before TUN activation.',
        { cause: error }
      )
    }

    const id = validateRandomId(this.randomId())
    const configPath = join(this.configDirectory, `sidecar-${id}.json`)
    let controllerLease: LoopbackPortLease
    try {
      controllerLease = await this.reservePort(0, '127.0.0.1')
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'Could not reserve the temporary TUN health-controller port.',
        { cause: error }
      )
    }
    const controllerSecret = this.createSecret()
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(controllerSecret)) {
      await controllerLease.release().catch(() => undefined)
      throw new ElevatedSingBoxTunError('tun_start_failed', 'Could not create the TUN controller secret.')
    }
    const configuration = buildElevatedTunSidecarConfig({
      bypass,
      executablePath: runtime.executablePath,
      executableName: runtime.executable,
      controllerPort: controllerLease.port,
      controllerSecret
    })
    try {
      await this.writeConfiguration(configPath, configuration)
    } catch (error) {
      await controllerLease.release().catch(() => undefined)
      throw error
    }
    const environment = runtimeEnvironment(runtime, this.environment, this.platform)

    try {
      await runChecked(this.commandRunner, {
        file: runtime.executablePath,
        args: ['check', '-c', configPath],
        cwd: runtime.runtimePath,
        env: environment,
        timeoutMs: 15_000,
        operation: 'tun.sidecar.check'
      })
    } catch (error) {
      await controllerLease.release().catch(() => undefined)
      await this.removeConfiguration(configPath)
      throw new ElevatedSingBoxTunError(
        'tun_config_invalid',
        'The generated sing-box TUN configuration failed validation.',
        { cause: error }
      )
    }

    try {
      await controllerLease.release()
    } catch (error) {
      await this.removeConfiguration(configPath)
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'Could not release the temporary TUN controller reservation.',
        { cause: error }
      )
    }

    let handle: TemporaryElevatedProcessHandle
    try {
      handle = await this.processRunner.start({
        launcher: elevationLauncher(this.platform),
        executablePath: runtime.executablePath,
        args: ['run', '-c', configPath],
        cwd: runtime.runtimePath,
        env: environment
      })
    } catch (error) {
      await this.removeConfiguration(configPath)
      if (isElevationDenied(error)) throw error
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'The elevated sing-box TUN sidecar did not start.',
        { cause: error }
      )
    }
    const active: ActiveTunSidecar = {
      handle,
      configPath,
      processStopped: false,
      ...(handle.exit ? { exit: handle.exit } : {})
    }
    this.observeExit(active)
    if (!handle.id?.trim() || this.sessions.has(handle.id)) {
      try {
        await this.cleanupSidecar(active)
      } catch (error) {
        this.pendingCleanup.add(active)
        throw new ElevatedSingBoxTunError(
          'tun_cleanup_failed',
          'The invalid TUN sidecar handle could not be cleaned up; retry is available.',
          { cause: error }
        )
      }
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'The elevation runner returned an invalid or duplicate TUN sidecar handle.'
      )
    }

    try {
      await this.waitUntilHealthy(controllerLease.port, controllerSecret, handle.exit)
    } catch (error) {
      try {
        await this.cleanupSidecar(active)
      } catch (cleanupError) {
        this.pendingCleanup.add(active)
        throw new ElevatedSingBoxTunError(
          'tun_cleanup_failed',
          'The unhealthy TUN sidecar could not be cleaned up; retry is available.',
          { cause: cleanupError }
        )
      }
      if (isElevationDenied(error)) throw error
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'The elevated sing-box TUN sidecar did not become healthy.',
        { cause: error }
      )
    }

    this.sessions.set(handle.id, active)
    return {
      id: handle.id,
      ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
      ...(handle.exit ? { exit: handle.exit } : {})
    }
  }

  public async stopTemporary(session: TunPlatformSession): Promise<void> {
    const active = this.sessions.get(session.id)
    if (!active) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        `Temporary TUN sidecar '${session.id}' is no longer owned by Stone+.`
      )
    }
    try {
      await this.cleanupSidecar(active)
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        'Could not fully clean up the elevated TUN sidecar; retry is available.',
        { cause: error }
      )
    }
    this.sessions.delete(session.id)
  }

  public async cleanupPending(): Promise<void> {
    const results = await Promise.allSettled([...this.pendingCleanup].map(async (active) => {
      await this.cleanupSidecar(active)
      this.pendingCleanup.delete(active)
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        'Could not clean up every pending elevated TUN sidecar; retry is available.',
        { cause: failure.reason }
      )
    }
  }

  public isElevationDenied(error: unknown): boolean {
    return isElevationDenied(error)
  }

  private observeExit(active: ActiveTunSidecar): void {
    if (!active.exit) return
    void active.exit.then(() => { active.processStopped = true })
  }

  private async cleanupSidecar(active: ActiveTunSidecar): Promise<void> {
    if (!active.processStopped) {
      await active.handle.stop()
      active.processStopped = true
    }
    await this.fileSystem.rm(active.configPath, { force: true })
  }

  private async waitUntilHealthy(
    controllerPort: number,
    controllerSecret: string,
    exit: TemporaryElevatedProcessHandle['exit']
  ): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    let lastError: unknown
    let exitResult: ElevatedProcessExit | undefined
    if (exit) void exit.then((result) => { exitResult = result })
    await Promise.resolve()
    while (Date.now() < deadline) {
      if (exitResult) throw elevatedProcessExitError(exitResult)
      try {
        const attemptTimeoutMs = Math.max(1, Math.min(1_000, deadline - Date.now()))
        const response = await rejectAfter(
          this.fetchImplementation(`http://127.0.0.1:${controllerPort}/version`, {
            headers: { Authorization: `Bearer ${controllerSecret}` },
            redirect: 'error',
            signal: AbortSignal.timeout(attemptTimeoutMs)
          }),
          attemptTimeoutMs,
          'The TUN controller health request timed out.'
        )
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`TUN controller returned HTTP ${response.status}.`)
        }
        const payload = await response.json()
        const version = payload && typeof payload === 'object'
          ? (payload as { version?: unknown }).version
          : undefined
        const versionMatch = typeof version === 'string'
          ? /(?:^|\s)(\d+\.\d+\.\d+)(?:$|[-+\s])/.exec(version)
          : null
        if (
          !payload
          || typeof payload !== 'object'
          || versionMatch?.[1] !== SING_BOX_VERSION
        ) {
          throw new Error('TUN controller did not identify the verified sing-box version.')
        }
        if (exitResult) throw elevatedProcessExitError(exitResult)
        return
      } catch (error) {
        if (exitResult) throw elevatedProcessExitError(exitResult)
        lastError = error
      }
      if (exit) {
        const exitedDuringDelay = await Promise.race([
          exit,
          this.sleep(Math.min(this.healthIntervalMs, Math.max(1, deadline - Date.now()))).then(() => undefined)
        ])
        if (exitedDuringDelay) throw elevatedProcessExitError(exitedDuringDelay)
      } else {
        await this.sleep(Math.min(this.healthIntervalMs, Math.max(1, deadline - Date.now())))
      }
    }
    throw new Error('Timed out waiting for the elevated TUN controller.', { cause: lastError })
  }

  private async writeConfiguration(
    path: string,
    configuration: Record<string, unknown>
  ): Promise<void> {
    const temporaryPath = `${path}.tmp`
    try {
      await this.fileSystem.mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await this.fileSystem.writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      await this.fileSystem.rename(temporaryPath, path)
    } catch (error) {
      await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw new ElevatedSingBoxTunError(
        'tun_config_invalid',
        'Could not write the protected temporary TUN configuration.',
        { cause: error }
      )
    }
  }

  private async removeConfiguration(path: string): Promise<void> {
    try {
      await this.fileSystem.rm(path, { force: true })
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        'Could not remove the temporary TUN configuration.',
        { cause: error }
      )
    }
  }
}

export function buildElevatedTunSidecarConfig(
  options: BuildElevatedTunSidecarConfigOptions
): Record<string, unknown> {
  const mixed = requireEndpoint(options.bypass.excludedEndpoints, 'mixed')
  if (!isLoopback(mixed.host) || !validPort(mixed.port)) {
    throw new ElevatedSingBoxTunError(
      'tun_config_invalid',
      'The TUN sidecar requires a loopback mixed SOCKS endpoint.'
    )
  }
  if (
    options.bypass.excludedProcessIds.length === 0
    || options.bypass.excludedProcessIds.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new ElevatedSingBoxTunError(
      'tun_config_invalid',
      'The TUN sidecar requires the verified sing-box process exclusion.'
    )
  }

  const excludedCidrs = new Set<string>()
  for (const value of options.bypass.excludedCidrs) excludedCidrs.add(validateCidr(value))
  const directDomains = new Set<string>()
  for (const endpoint of options.bypass.excludedEndpoints) {
    const host = endpoint.host.trim().replace(/^\[|\]$/g, '').toLowerCase()
    const family = isIP(host)
    if (family === 4) excludedCidrs.add(`${host}/32`)
    else if (family === 6) excludedCidrs.add(`${host}/128`)
    else if (host) directDomains.add(host)
  }
  const routeExcludeAddress = [...excludedCidrs]
  const directRules: Array<Record<string, unknown>> = [
    {
      process_path: [options.executablePath],
      process_name: [options.executableName ?? basename(options.executablePath)],
      action: 'route',
      outbound: DIRECT_OUTBOUND
    },
    {
      ip_cidr: routeExcludeAddress,
      action: 'route',
      outbound: DIRECT_OUTBOUND
    }
  ]
  if (directDomains.size > 0) {
    directRules.push({
      domain: [...directDomains],
      action: 'route',
      outbound: DIRECT_OUTBOUND
    })
  }

  const addresses = options.tunAddresses?.length
    ? options.tunAddresses.map(validateCidr)
    : [...DEFAULT_TUN_ADDRESSES]
  if (
    (options.controllerPort === undefined) !== (options.controllerSecret === undefined)
    || (options.controllerPort !== undefined && !validPort(options.controllerPort))
    || (options.controllerSecret !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(options.controllerSecret))
  ) {
    throw new ElevatedSingBoxTunError('tun_config_invalid', 'The TUN health controller is invalid.')
  }
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{
      type: 'tun',
      tag: TUN_INBOUND,
      address: addresses,
      auto_route: true,
      strict_route: true,
      route_exclude_address: routeExcludeAddress,
      stack: 'mixed'
    }],
    outbounds: [
      {
        type: 'socks',
        tag: MIXED_OUTBOUND,
        server: mixed.host,
        server_port: mixed.port,
        version: '5'
      },
      { type: 'direct', tag: DIRECT_OUTBOUND }
    ],
    route: {
      auto_detect_interface: true,
      rules: directRules,
      final: MIXED_OUTBOUND
    },
    ...(options.controllerPort !== undefined && options.controllerSecret !== undefined
      ? {
          experimental: {
            clash_api: {
              external_controller: `127.0.0.1:${options.controllerPort}`,
              secret: options.controllerSecret
            }
          }
        }
      : {})
  }
}

function requireEndpoint(
  endpoints: readonly TunBypassEndpoint[],
  role: TunBypassEndpoint['role']
): TunBypassEndpoint {
  const endpoint = endpoints.find((candidate) => candidate.role === role)
  if (!endpoint) {
    throw new ElevatedSingBoxTunError('tun_config_invalid', `The TUN bypass plan is missing ${role}.`)
  }
  return endpoint
}

function validateCidr(value: string): string {
  const normalized = value.trim().toLowerCase()
  const match = /^(.+)\/(\d{1,3})$/.exec(normalized)
  if (!match) throw new ElevatedSingBoxTunError('tun_config_invalid', `Invalid TUN CIDR: ${value}.`)
  const family = isIP(match[1])
  const prefix = Number(match[2])
  if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new ElevatedSingBoxTunError('tun_config_invalid', `Invalid TUN CIDR: ${value}.`)
  }
  return `${match[1]}/${prefix}`
}

function validPort(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 65_535
}

function isLoopback(host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || value.startsWith('127.')
}

function elevationLauncher(platform: NodeJS.Platform): TemporaryElevationLauncher {
  if (platform === 'win32') return 'windows-uac'
  if (platform === 'darwin') return 'macos-sudo'
  if (platform === 'linux') return 'linux-pkexec'
  throw new ElevatedSingBoxTunError(
    'tun_runtime_invalid',
    `Temporary sing-box TUN elevation is unsupported on ${platform}.`
  )
}

function validateRandomId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new ElevatedSingBoxTunError('tun_config_invalid', 'The temporary TUN configuration ID is invalid.')
  }
  return value
}

function runtimeEnvironment(
  runtime: VerifiedSingBoxRuntime,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value
  }
  const appendPath = (name: string): void => {
    environment[name] = environment[name]
      ? `${runtime.runtimePath}${platform === 'win32' ? ';' : ':'}${environment[name]}`
      : runtime.runtimePath
  }
  if (platform === 'win32') appendPath('PATH')
  else if (platform === 'linux' && runtime.cronetLibraryPath) appendPath('LD_LIBRARY_PATH')
  else if (platform === 'darwin' && runtime.cronetLibraryPath) appendPath('DYLD_LIBRARY_PATH')
  return environment
}

async function runChecked(
  runner: PlatformCommandRunner,
  request: PlatformCommandRequest
): Promise<PlatformCommandResult> {
  const result = await runner(request)
  if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(0, 500)
    throw new Error(`${request.operation ?? request.file} failed${detail ? `: ${detail}` : '.'}`)
  }
  return result
}

function isElevationDenied(error: unknown): boolean {
  if (error instanceof TunElevationDeniedError) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    code?: unknown
    errno?: unknown
    message?: unknown
    stderr?: unknown
    cause?: unknown
  }
  return candidate.errno === 1223
    || candidate.code === 126
    || candidate.code === 127
    || ['EACCES', 'EPERM', 'ERROR_CANCELLED', 'USER_CANCELLED', 'TUN_ELEVATION_DENIED']
      .includes(String(candidate.code ?? '').toUpperCase())
    || /cancel(?:led|ed)|declined|not authorized|dismissed|no password|password.*required|authentication fail/i
      .test(`${String(candidate.message ?? '')}\n${String(candidate.stderr ?? '')}`)
    || (candidate.cause !== undefined && isElevationDenied(candidate.cause))
}

function elevatedProcessExitError(exit: ElevatedProcessExit): Error {
  const detail = exit.stderr?.trim()
  if (isElevationDenied({ code: exit.code, stderr: detail })) {
    return new TunElevationDeniedError(detail || undefined)
  }
  const status = exit.code !== null
    ? `code ${exit.code}`
    : exit.signal
      ? `signal ${exit.signal}`
      : 'an unknown status'
  return new Error(`The elevated TUN sidecar exited with ${status}${detail ? `: ${detail}` : '.'}`)
}

async function resolveTunEndpointAddresses(
  plan: TunBypassPlan,
  resolveHost: (host: string) => Promise<readonly string[]>
): Promise<TunBypassPlan> {
  const excludedCidrs = new Set(plan.excludedCidrs)
  const hosts = new Set(plan.excludedEndpoints
    .filter((endpoint) => endpoint.role === 'node' || endpoint.role === 'dns')
    .map((endpoint) => endpoint.host.trim().replace(/^\[|\]$/g, '').toLowerCase())
    .filter((host) => isIP(host) === 0))
  for (const host of hosts) {
    const addresses = await resolveHost(host)
    if (addresses.length === 0) throw new Error(`No address was returned for ${host}.`)
    for (const rawAddress of addresses) {
      const address = rawAddress.trim().replace(/^\[|\]$/g, '').toLowerCase()
      const family = isIP(address)
      if (!family) throw new Error(`Resolver returned an invalid address for ${host}.`)
      excludedCidrs.add(`${address}/${family === 4 ? 32 : 128}`)
    }
  }
  return {
    excludedCidrs: [...excludedCidrs],
    excludedProcessIds: [...plan.excludedProcessIds],
    excludedEndpoints: plan.excludedEndpoints.map((endpoint) => ({ ...endpoint }))
  }
}

async function resolveAllAddresses(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
}

async function rejectAfter<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
