import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isIP } from 'node:net'
import {
  verifyBundledSingBoxRuntime,
  type VerifiedSingBoxRuntime
} from './binary-manifest'
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
}

export interface BuildElevatedTunSidecarConfigOptions {
  bypass: TunBypassPlan
  executablePath: string
  executableName?: string
  tunAddresses?: readonly string[]
}

interface ActiveTunSidecar {
  handle: TemporaryElevatedProcessHandle
  configPath: string
  processStopped: boolean
}

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
  private readonly configDirectory: string
  private readonly sessions = new Map<string, ActiveTunSidecar>()

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
    const configuration = buildElevatedTunSidecarConfig({
      bypass,
      executablePath: runtime.executablePath,
      executableName: runtime.executable
    })
    await this.writeConfiguration(configPath, configuration)
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
      await this.removeConfiguration(configPath)
      throw new ElevatedSingBoxTunError(
        'tun_config_invalid',
        'The generated sing-box TUN configuration failed validation.',
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
    if (!handle.id?.trim() || this.sessions.has(handle.id)) {
      await handle.stop().catch(() => undefined)
      await this.removeConfiguration(configPath)
      throw new ElevatedSingBoxTunError(
        'tun_start_failed',
        'The elevation runner returned an invalid or duplicate TUN sidecar handle.'
      )
    }

    this.sessions.set(handle.id, { handle, configPath, processStopped: false })
    return { id: handle.id, ...(handle.pid !== undefined ? { pid: handle.pid } : {}) }
  }

  public async stopTemporary(session: TunPlatformSession): Promise<void> {
    const active = this.sessions.get(session.id)
    if (!active) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        `Temporary TUN sidecar '${session.id}' is no longer owned by Stone+.`
      )
    }
    if (!active.processStopped) {
      try {
        await active.handle.stop()
        active.processStopped = true
      } catch (error) {
        throw new ElevatedSingBoxTunError(
          'tun_cleanup_failed',
          'Could not stop the elevated sing-box TUN sidecar; retry is available.',
          { cause: error }
        )
      }
    }
    try {
      await this.fileSystem.rm(active.configPath, { force: true })
    } catch (error) {
      throw new ElevatedSingBoxTunError(
        'tun_cleanup_failed',
        'The TUN sidecar stopped, but its temporary configuration could not be removed; retry is available.',
        { cause: error }
      )
    }
    this.sessions.delete(session.id)
  }

  public isElevationDenied(error: unknown): boolean {
    return isElevationDenied(error)
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
    }
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
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown }
  return candidate.errno === 1223
    || ['EACCES', 'EPERM', 'ERROR_CANCELLED', 'USER_CANCELLED', 'TUN_ELEVATION_DENIED']
      .includes(String(candidate.code ?? '').toUpperCase())
    || /cancel(?:led|ed)|declined|not authorized|dismissed/i.test(String(candidate.message ?? ''))
    || (candidate.cause !== undefined && isElevationDenied(candidate.cause))
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
