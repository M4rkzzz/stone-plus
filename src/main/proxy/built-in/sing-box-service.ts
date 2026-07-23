import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, connect, type Server } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  ProxyConnectionSummary as SharedProxyConnectionSummary,
  ProxyTrafficSnapshot as SharedProxyTrafficSnapshot
} from '@shared/types'
import {
  SING_BOX_VERSION,
  SingBoxManifestError,
  verifyBundledSingBoxRuntime,
  type VerifiedSingBoxRuntime
} from './binary-manifest'
import {
  executeFile,
  exitDescription,
  terminateProcessTree,
  waitForProcessSpawn,
  type ExecuteFile,
  type TerminateProcessTree
} from './process-utils'

const LOOPBACK_HOST = '127.0.0.1'
const CONFIG_SIZE_LIMIT = 8 * 1024 * 1024
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000
const DEFAULT_HEALTH_INTERVAL_MS = 100
const DEFAULT_RESTART_DELAYS_MS = [250, 1_000, 3_000] as const
const MAX_EVENT_LOG_LENGTH = 2_000

export type SingBoxRuntimeStatus = 'idle' | 'starting' | 'ready' | 'stopping' | 'error'

export type SingBoxServiceErrorCode =
  | 'closed'
  | 'core_missing'
  | 'core_untrusted'
  | 'core_version'
  | 'config_invalid'
  | 'mixed_port'
  | 'controller_port'
  | 'check_failed'
  | 'start_failed'
  | 'health_check'
  | 'unexpected_exit'
  | 'not_ready'
  | 'controller_request'

export interface SingBoxRuntimeError {
  code: SingBoxServiceErrorCode
  message: string
}

export interface SingBoxRuntimeState {
  revision: number
  generation: number
  desiredEnabled: boolean
  status: SingBoxRuntimeStatus
  version: typeof SING_BOX_VERSION
  target?: string
  pid?: number
  mixedPort?: number
  mixedEndpoint?: string
  controllerPort?: number
  startedAt?: number
  restartAttempt: number
  error?: SingBoxRuntimeError
}

export type SingBoxRuntimeEvent =
  | { type: 'state'; state: SingBoxRuntimeState }
  | { type: 'crash'; state: SingBoxRuntimeState; exit: string }
  | { type: 'restart-scheduled'; state: SingBoxRuntimeState; attempt: number; delayMs: number }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }

export type ProxyTrafficSnapshot = SharedProxyTrafficSnapshot
export type ProxyConnectionSummary = SharedProxyConnectionSummary

export interface ProxyLatencyResult {
  proxyName: string
  delayMs: number
  testedAt: number
}

export type SingBoxConfiguration = string | Record<string, unknown>

export interface SingBoxStartRequest {
  config: SingBoxConfiguration
  /** A missing or zero port asks the OS for a free mixed-listener port. */
  mixedPort?: number
  /** A missing or zero port asks the OS for a free loopback port. */
  controllerPort?: number
  /** Exposes only the mixed proxy listener to the IPv4 LAN. The controller stays loopback-only. */
  allowLan?: boolean
}

export interface LoopbackPortLease {
  port: number
  release: () => Promise<void>
}

export type ReserveLoopbackPort = (requestedPort: number, host?: string) => Promise<LoopbackPortLease>

export interface SingBoxServiceOptions {
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
  executeFile?: ExecuteFile
  spawnProcess?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  terminateProcess?: TerminateProcessTree
  reservePort?: ReserveLoopbackPort
  probeTcp?: (host: string, port: number, timeoutMs: number) => Promise<void>
  fetchImplementation?: typeof fetch
  createSecret?: () => string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  setTimeoutImplementation?: typeof setTimeout
  clearTimeoutImplementation?: typeof clearTimeout
  healthTimeoutMs?: number
  healthIntervalMs?: number
  restartDelaysMs?: readonly number[]
}

export class SingBoxServiceError extends Error {
  public readonly code: SingBoxServiceErrorCode

  public constructor(code: SingBoxServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SingBoxServiceError'
    this.code = code
  }
}

interface NormalizedStartRequest {
  config: Record<string, unknown>
  mixedPort: number
  controllerPort: number
  allowLan: boolean
  key: string
}

interface RunningChildContext {
  child: ChildProcess
  ready: boolean
  intentional: boolean
}

interface ControllerConnectionPayload {
  uploadTotal?: unknown
  downloadTotal?: unknown
  connections?: unknown
}

export class SingBoxService {
  private state: SingBoxRuntimeState = {
    revision: 0,
    generation: 0,
    desiredEnabled: false,
    status: 'idle',
    version: SING_BOX_VERSION,
    restartAttempt: 0
  }

  private readonly stateListeners = new Set<(state: SingBoxRuntimeState) => void>()
  private readonly eventListeners = new Set<(event: SingBoxRuntimeEvent) => void>()
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly verifyRuntime: NonNullable<SingBoxServiceOptions['verifyRuntime']>
  private readonly execute: ExecuteFile
  private readonly spawnProcess: NonNullable<SingBoxServiceOptions['spawnProcess']>
  private readonly terminateProcess: TerminateProcessTree
  private readonly reservePort: ReserveLoopbackPort
  private readonly probeTcp: NonNullable<SingBoxServiceOptions['probeTcp']>
  private readonly fetchImplementation: typeof fetch
  private readonly createSecret: () => string
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly setTimeoutImplementation: typeof setTimeout
  private readonly clearTimeoutImplementation: typeof clearTimeout
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number
  private readonly restartDelaysMs: readonly number[]
  private readonly runtimeConfigPath: string
  private childContext?: RunningChildContext
  private controllerSecret?: string
  private lastRequest?: NormalizedStartRequest
  private operationTail: Promise<void> = Promise.resolve()
  private restartTimer?: ReturnType<typeof setTimeout>
  private previousTraffic?: { capturedAt: number; uploadBytes: number; downloadBytes: number }
  private readonly seenConnectionIds = new Set<string>()
  private closed = false
  private closing = false

  public constructor(private readonly options: SingBoxServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.environment = options.environment ?? process.env
    this.verifyRuntime = options.verifyRuntime ?? verifyBundledSingBoxRuntime
    this.execute = options.executeFile ?? executeFile
    this.spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => spawn(executable, [...args], spawnOptions))
    this.terminateProcess = options.terminateProcess ?? terminateProcessTree
    this.reservePort = options.reservePort ?? reserveLoopbackPort
    this.probeTcp = options.probeTcp ?? probeTcpPort
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.setTimeoutImplementation = options.setTimeoutImplementation ?? setTimeout
    this.clearTimeoutImplementation = options.clearTimeoutImplementation ?? clearTimeout
    this.healthTimeoutMs = Math.max(100, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
    this.healthIntervalMs = Math.max(1, options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS)
    this.restartDelaysMs = sanitizeRestartDelays(options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS)
    this.runtimeConfigPath = join(options.userDataPath, 'built-in-proxy', 'sing-box.runtime.json')
  }

  public getState(): SingBoxRuntimeState {
    return structuredClone(this.state)
  }

  public subscribe(listener: (state: SingBoxRuntimeState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  public onEvent(listener: (event: SingBoxRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  public start(request: SingBoxStartRequest): Promise<SingBoxRuntimeState> {
    return this.enqueue(async () => {
      this.assertOpen()
      const normalized = normalizeStartRequest(request)
      if (this.state.status === 'ready' && this.lastRequest?.key === normalized.key) return this.getState()

      this.cancelRestart()
      this.lastRequest = normalized
      this.setDesiredEnabled(true)
      this.setState({ restartAttempt: 0, error: undefined })
      if (this.childContext) await this.stopChild(false)
      return this.startAttempt(normalized)
    })
  }

  public retry(): Promise<SingBoxRuntimeState> {
    return this.enqueue(async () => {
      this.assertOpen()
      if (!this.state.desiredEnabled || !this.lastRequest) {
        throw new SingBoxServiceError('config_invalid', 'There is no enabled sing-box configuration to retry.')
      }
      this.cancelRestart()
      this.setState({ restartAttempt: 0, error: undefined })
      if (this.childContext) await this.stopChild(false)
      return this.startAttempt(this.lastRequest)
    })
  }

  public stop(): Promise<SingBoxRuntimeState> {
    return this.enqueue(async () => this.stopInternal())
  }

  public async close(): Promise<void> {
    if (this.closed || this.closing) {
      await this.operationTail
      return
    }
    this.closing = true
    await this.enqueue(async () => {
      await this.stopInternal()
      this.closed = true
      this.closing = false
      this.stateListeners.clear()
      this.eventListeners.clear()
    })
  }

  public async getTraffic(): Promise<ProxyTrafficSnapshot> {
    const payload = await this.readConnectionsPayload()
    const connections = Array.isArray(payload.connections) ? payload.connections : []
    for (const value of connections) {
      if (isRecord(value) && typeof value.id === 'string' && value.id) this.seenConnectionIds.add(value.id)
    }
    const capturedAt = this.now()
    const uploadBytes = nonNegativeInteger(payload.uploadTotal)
    const downloadBytes = nonNegativeInteger(payload.downloadTotal)
    const elapsedSeconds = this.previousTraffic
      ? Math.max(0, capturedAt - this.previousTraffic.capturedAt) / 1_000
      : 0
    const snapshot: ProxyTrafficSnapshot = {
      capturedAt,
      uploadBytes,
      downloadBytes,
      uploadRateBytesPerSecond: elapsedSeconds > 0
        ? Math.max(0, Math.floor((uploadBytes - this.previousTraffic!.uploadBytes) / elapsedSeconds))
        : 0,
      downloadRateBytesPerSecond: elapsedSeconds > 0
        ? Math.max(0, Math.floor((downloadBytes - this.previousTraffic!.downloadBytes) / elapsedSeconds))
        : 0,
      activeConnections: connections.length,
      totalConnections: Math.max(connections.length, this.seenConnectionIds.size)
    }
    this.previousTraffic = { capturedAt, uploadBytes, downloadBytes }
    return snapshot
  }

  public async getConnections(): Promise<ProxyConnectionSummary[]> {
    const payload = await this.readConnectionsPayload()
    const result = Array.isArray(payload.connections)
      ? payload.connections.map(parseConnectionSummary).filter((value): value is ProxyConnectionSummary => Boolean(value))
      : []
    for (const connection of result) this.seenConnectionIds.add(connection.id)
    return result
  }

  public async closeConnection(id: string): Promise<void> {
    const normalized = normalizeControllerIdentifier(id, 'connection id')
    await this.controllerRequest(`/connections/${encodeURIComponent(normalized)}`, { method: 'DELETE' })
  }

  public async refreshConnections(): Promise<void> {
    await this.controllerRequest('/connections', { method: 'DELETE' })
  }

  public async testLatency(
    proxyName: string,
    url = 'https://www.gstatic.com/generate_204',
    timeoutMs = 5_000
  ): Promise<ProxyLatencyResult> {
    const normalizedName = normalizeControllerIdentifier(proxyName, 'proxy name')
    const testUrl = normalizeLatencyUrl(url)
    const timeout = Math.max(250, Math.min(30_000, Math.floor(timeoutMs)))
    const query = new URLSearchParams({ url: testUrl, timeout: String(timeout) })
    const payload = await this.controllerRequest(
      `/proxies/${encodeURIComponent(normalizedName)}/delay?${query.toString()}`
    )
    const delay = isRecord(payload) ? nonNegativeInteger(payload.delay, -1) : -1
    if (delay < 0) throw new SingBoxServiceError('controller_request', 'sing-box did not return a valid latency result.')
    return { proxyName: normalizedName, delayMs: delay, testedAt: this.now() }
  }

  private async startAttempt(request: NormalizedStartRequest): Promise<SingBoxRuntimeState> {
    this.setState({
      status: 'starting',
      error: undefined,
      pid: undefined,
      startedAt: undefined,
      mixedPort: undefined,
      mixedEndpoint: undefined,
      controllerPort: undefined
    })

    let runtime: VerifiedSingBoxRuntime
    try {
      runtime = await this.verifyRuntime({
        runtimeRoot: this.options.runtimeRoot,
        manifestPath: this.options.manifestPath,
        platform: this.platform,
        architecture: this.architecture
      })
      await this.verifyExecutableVersion(runtime)
    } catch (error) {
      return this.failStart(mapRuntimeError(error))
    }

    let mixedLease: LoopbackPortLease | undefined
    let controllerLease: LoopbackPortLease | undefined
    try {
      mixedLease = await this.acquirePort(
        request.mixedPort,
        'mixed_port',
        request.allowLan ? '0.0.0.0' : LOOPBACK_HOST
      )
      controllerLease = await this.acquirePort(request.controllerPort, 'controller_port', LOOPBACK_HOST)
    } catch (error) {
      await mixedLease?.release().catch(() => undefined)
      await controllerLease?.release().catch(() => undefined)
      return this.failStart(asServiceError(error, 'start_failed', 'Unable to reserve sing-box loopback ports.'))
    }

    if (mixedLease.port === controllerLease.port) {
      await Promise.allSettled([mixedLease.release(), controllerLease.release()])
      return this.failStart(new SingBoxServiceError('controller_port', 'Mixed and controller ports must be different.'))
    }

    let secret: string
    try {
      secret = this.createSecret()
    } catch (error) {
      await Promise.allSettled([mixedLease.release(), controllerLease.release()])
      return this.failStart(new SingBoxServiceError('start_failed', 'Controller secret generation failed.', { cause: error }))
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      await Promise.allSettled([mixedLease.release(), controllerLease.release()])
      return this.failStart(new SingBoxServiceError('start_failed', 'Controller secret generation failed.'))
    }
    this.controllerSecret = secret
    const config = buildRuntimeConfiguration(
      request.config,
      mixedLease.port,
      controllerLease.port,
      secret,
      request.allowLan
    )

    try {
      await writeRuntimeConfig(this.runtimeConfigPath, config)
      await this.checkConfiguration(runtime)
    } catch (error) {
      await Promise.allSettled([mixedLease.release(), controllerLease.release()])
      await this.removeRuntimeConfig()
      const failure = error instanceof SingBoxServiceError
        ? error
        : new SingBoxServiceError('check_failed', 'sing-box configuration validation failed.', { cause: error })
      return this.failStart(failure)
    }

    try {
      await Promise.all([mixedLease.release(), controllerLease.release()])
    } catch (error) {
      await this.removeRuntimeConfig()
      return this.failStart(new SingBoxServiceError('start_failed', 'Unable to release reserved loopback ports.', {
        cause: error
      }))
    }
    const env = runtimeEnvironment(runtime.runtimePath, this.platform, this.environment)
    let context: RunningChildContext | undefined
    try {
      const child = this.spawnProcess(runtime.executablePath, ['run', '-c', this.runtimeConfigPath], {
        cwd: runtime.runtimePath,
        env,
        windowsHide: true,
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      context = { child, ready: false, intentional: false }
      this.childContext = context
      this.attachChild(context)
      await waitForProcessSpawn(child)
      this.setState({
        target: runtime.target,
        pid: child.pid,
        mixedPort: mixedLease.port,
        mixedEndpoint: `http://${LOOPBACK_HOST}:${mixedLease.port}`,
        controllerPort: controllerLease.port
      })
      await this.waitUntilHealthy(context, controllerLease.port, mixedLease.port, secret)
      context.ready = true
      this.setState({
        status: 'ready',
        generation: this.state.generation + 1,
        startedAt: this.now(),
        restartAttempt: this.state.restartAttempt,
        error: undefined
      })
      this.previousTraffic = undefined
      this.seenConnectionIds.clear()
      return this.getState()
    } catch (error) {
      if (context) {
        context.intentional = true
        if (this.childContext === context) this.childContext = undefined
        await this.terminateProcess(context.child, this.platform).catch(() => undefined)
      }
      await this.removeRuntimeConfig()
      return this.failStart(asServiceError(error, 'start_failed', 'sing-box failed to start.'))
    }
  }

  private async verifyExecutableVersion(runtime: VerifiedSingBoxRuntime): Promise<void> {
    let result
    try {
      result = await this.execute(runtime.executablePath, ['version'], {
        cwd: runtime.runtimePath,
        env: runtimeEnvironment(runtime.runtimePath, this.platform, this.environment),
        timeoutMs: 10_000
      })
    } catch (error) {
      throw new SingBoxServiceError('core_version', 'Unable to verify the bundled sing-box version.', { cause: error })
    }
    const output = `${result.stdout}\n${result.stderr}`
    const match = /\bsing-box\s+version\s+([^\s]+)/i.exec(output)
    if (!match || match[1] !== SING_BOX_VERSION) {
      throw new SingBoxServiceError(
        'core_version',
        `Bundled sing-box executable is not the required ${SING_BOX_VERSION} build.`
      )
    }
  }

  private async checkConfiguration(runtime: VerifiedSingBoxRuntime): Promise<void> {
    try {
      await this.execute(runtime.executablePath, ['check', '-c', this.runtimeConfigPath], {
        cwd: runtime.runtimePath,
        env: runtimeEnvironment(runtime.runtimePath, this.platform, this.environment),
        timeoutMs: 15_000
      })
    } catch (error) {
      const detail = sanitizeProcessFailure(error)
      throw new SingBoxServiceError(
        'check_failed',
        `sing-box configuration validation failed${detail ? `: ${detail}` : '.'}`,
        { cause: error }
      )
    }
  }

  private async acquirePort(
    requestedPort: number,
    code: 'mixed_port' | 'controller_port',
    host: string
  ): Promise<LoopbackPortLease> {
    try {
      return await this.reservePort(requestedPort, host)
    } catch (error) {
      const label = code === 'mixed_port' ? 'Mixed' : 'Controller'
      const requested = requestedPort ? ` ${requestedPort}` : ''
      throw new SingBoxServiceError(code, `${label} loopback port${requested} is unavailable.`, { cause: error })
    }
  }

  private async waitUntilHealthy(
    context: RunningChildContext,
    controllerPort: number,
    mixedPort: number,
    secret: string
  ): Promise<void> {
    const attempts = Math.max(1, Math.ceil(this.healthTimeoutMs / this.healthIntervalMs))
    const deadline = Date.now() + this.healthTimeoutMs
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.childContext !== context || context.child.exitCode !== null || context.child.signalCode !== null) {
        throw new SingBoxServiceError('health_check', 'sing-box exited before its loopback endpoints became ready.')
      }
      try {
        const remainingMs = Math.max(1, deadline - Date.now())
        const version = await this.controllerRequestAt(controllerPort, secret, '/version', {
          signal: AbortSignal.timeout(remainingMs)
        })
        assertControllerVersion(version)
        await this.probeTcp(LOOPBACK_HOST, mixedPort, Math.max(1, Math.min(1_000, deadline - Date.now())))
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < attempts && Date.now() < deadline) {
        await this.sleep(Math.min(this.healthIntervalMs, Math.max(0, deadline - Date.now())))
      }
    }
    throw new SingBoxServiceError(
      'health_check',
      'sing-box did not make both loopback endpoints healthy before the startup deadline.',
      { cause: lastError }
    )
  }

  private attachChild(context: RunningChildContext): void {
    const { child } = context
    pipeProcessLines(child.stdout, (line) => this.emit({ type: 'log', stream: 'stdout', line }))
    pipeProcessLines(child.stderr, (line) => this.emit({ type: 'log', stream: 'stderr', line }))
    child.on('error', (error) => {
      this.emit({ type: 'log', stream: 'stderr', line: sanitizeLogLine(error.message) })
    })
    child.once('exit', (code, signal) => this.handleChildExit(context, code, signal))
  }

  private handleChildExit(
    context: RunningChildContext,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.childContext === context) this.childContext = undefined
    if (context.intentional || !context.ready || !this.state.desiredEnabled || this.closed || this.closing) return

    const exit = exitDescription(code, signal)
    const error = new SingBoxServiceError('unexpected_exit', `sing-box exited unexpectedly (${exit}).`)
    this.setState({ status: 'error', pid: undefined, startedAt: undefined, error: runtimeError(error) })
    this.emit({ type: 'crash', state: this.getState(), exit })
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (
      this.restartTimer
      || !this.state.desiredEnabled
      || !this.lastRequest
      || this.closed
      || this.closing
    ) return
    const attempt = this.state.restartAttempt + 1
    const delayMs = this.restartDelaysMs[attempt - 1]
    if (delayMs === undefined) return
    this.setState({ restartAttempt: attempt })
    this.emit({ type: 'restart-scheduled', state: this.getState(), attempt, delayMs })
    this.restartTimer = this.setTimeoutImplementation(() => {
      this.restartTimer = undefined
      void this.enqueue(async () => {
        if (!this.state.desiredEnabled || !this.lastRequest || this.closed || this.closing) return
        try {
          await this.startAttempt(this.lastRequest)
        } catch {
          // startAttempt reports a classified state error. Continue only within
          // the bounded restart schedule.
          this.scheduleRestart()
        }
      })
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private async stopInternal(): Promise<SingBoxRuntimeState> {
    this.cancelRestart()
    this.setDesiredEnabled(false)
    this.lastRequest = undefined
    if (this.childContext) await this.stopChild(true)
    else await this.removeRuntimeConfig()
    this.controllerSecret = undefined
    this.previousTraffic = undefined
    this.seenConnectionIds.clear()
    this.setState({
      status: 'idle',
      target: undefined,
      pid: undefined,
      mixedPort: undefined,
      mixedEndpoint: undefined,
      controllerPort: undefined,
      startedAt: undefined,
      restartAttempt: 0,
      error: undefined
    })
    return this.getState()
  }

  private async stopChild(publishStopping: boolean): Promise<void> {
    const context = this.childContext
    if (!context) return
    if (publishStopping) this.setState({ status: 'stopping', error: undefined })
    context.intentional = true
    this.childContext = undefined
    await this.terminateProcess(context.child, this.platform)
    await this.removeRuntimeConfig()
  }

  private failStart(error: SingBoxServiceError): never {
    this.controllerSecret = undefined
    this.setState({ status: 'error', pid: undefined, startedAt: undefined, error: runtimeError(error) })
    throw error
  }

  private async readConnectionsPayload(): Promise<ControllerConnectionPayload> {
    const payload = await this.controllerRequest('/connections')
    if (!isRecord(payload)) {
      throw new SingBoxServiceError('controller_request', 'sing-box returned an invalid connections payload.')
    }
    return payload
  }

  private async controllerRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    if (
      this.state.status !== 'ready'
      || !this.childContext?.ready
      || !this.state.controllerPort
      || !this.controllerSecret
    ) {
      throw new SingBoxServiceError('not_ready', 'The built-in proxy core is not ready.')
    }
    return this.controllerRequestAt(this.state.controllerPort, this.controllerSecret, path, init)
  }

  private async controllerRequestAt(
    port: number,
    secret: string,
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set('Accept', 'application/json')
      headers.set('Authorization', `Bearer ${secret}`)
      response = await this.fetchImplementation(`http://${LOOPBACK_HOST}:${port}${path}`, {
        ...init,
        redirect: 'error',
        headers,
        signal: init.signal ?? AbortSignal.timeout(5_000)
      })
    } catch (error) {
      throw new SingBoxServiceError('controller_request', 'Unable to reach the sing-box controller.', { cause: error })
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new SingBoxServiceError('controller_request', `sing-box controller returned status ${response.status}.`)
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined
    try {
      return await response.json()
    } catch (error) {
      throw new SingBoxServiceError('controller_request', 'sing-box controller returned invalid JSON.', { cause: error })
    }
  }

  private setDesiredEnabled(value: boolean): void {
    if (this.state.desiredEnabled === value) return
    this.setState({ desiredEnabled: value })
  }

  private setState(patch: Partial<SingBoxRuntimeState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    const state = this.getState()
    for (const listener of this.stateListeners) listener(state)
    this.emit({ type: 'state', state })
  }

  private emit(event: SingBoxRuntimeEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return
    this.clearTimeoutImplementation(this.restartTimer)
    this.restartTimer = undefined
  }

  private assertOpen(): void {
    if (this.closed || this.closing) throw new SingBoxServiceError('closed', 'The sing-box service is closed.')
  }

  private async removeRuntimeConfig(): Promise<void> {
    await rm(this.runtimeConfigPath, { force: true }).catch(() => undefined)
  }
}

export function buildRuntimeConfiguration(
  source: Record<string, unknown>,
  mixedPort: number,
  controllerPort: number,
  controllerSecret: string,
  allowLan = false
): Record<string, unknown> {
  const cloned = cloneConfiguration(source)
  // Imported inbounds and experimental APIs are never trusted. Stone+ owns the
  // only mixed endpoint and the authenticated controller on loopback.
  delete cloned.inbounds
  delete cloned.experimental
  return {
    ...cloned,
    inbounds: [{
      type: 'mixed',
      tag: 'stone-mixed-in',
      listen: allowLan ? '0.0.0.0' : LOOPBACK_HOST,
      listen_port: mixedPort
    }],
    experimental: {
      clash_api: {
        external_controller: `${LOOPBACK_HOST}:${controllerPort}`,
        secret: controllerSecret
      }
    }
  }
}

export async function reserveLoopbackPort(
  requestedPort: number,
  host = LOOPBACK_HOST
): Promise<LoopbackPortLease> {
  const port = normalizePort(requestedPort, true)
  if (host !== LOOPBACK_HOST && host !== '0.0.0.0') {
    throw new Error('Stone+ rejected an unsafe proxy listener address.')
  }
  const server = createServer()
  server.unref()
  await listen(server, port, host)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Loopback port reservation did not return an IP address.')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) return
      released = true
      await closeServer(server)
    }
  }
}

export function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => finish(new Error('TCP probe timed out.')), Math.max(1, timeoutMs))
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}

function normalizeStartRequest(request: SingBoxStartRequest): NormalizedStartRequest {
  const config = parseConfiguration(request.config)
  const mixedPort = normalizePort(request.mixedPort ?? 0, true)
  const controllerPort = normalizePort(request.controllerPort ?? 0, true)
  const allowLan = request.allowLan === true
  if (mixedPort !== 0 && mixedPort === controllerPort) {
    throw new SingBoxServiceError('controller_port', 'Mixed and controller ports must be different.')
  }
  const serialized = JSON.stringify(config)
  return {
    config,
    mixedPort,
    controllerPort,
    allowLan,
    key: `${mixedPort}:${controllerPort}:${allowLan ? 'lan' : 'loopback'}:${serialized}`
  }
}

function parseConfiguration(input: SingBoxConfiguration): Record<string, unknown> {
  let value: unknown = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > CONFIG_SIZE_LIMIT) {
      throw new SingBoxServiceError('config_invalid', 'sing-box configuration is too large.')
    }
    try {
      value = JSON.parse(input)
    } catch (error) {
      throw new SingBoxServiceError('config_invalid', 'sing-box configuration is not valid JSON.', { cause: error })
    }
  }
  if (!isRecord(value)) throw new SingBoxServiceError('config_invalid', 'sing-box configuration must be a JSON object.')
  return cloneConfiguration(value)
}

function cloneConfiguration(value: Record<string, unknown>): Record<string, unknown> {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new SingBoxServiceError('config_invalid', 'sing-box configuration is not serializable.', { cause: error })
  }
  if (Buffer.byteLength(serialized, 'utf8') > CONFIG_SIZE_LIMIT) {
    throw new SingBoxServiceError('config_invalid', 'sing-box configuration is too large.')
  }
  const cloned: unknown = JSON.parse(serialized)
  if (!isRecord(cloned)) throw new SingBoxServiceError('config_invalid', 'sing-box configuration must be a JSON object.')
  return cloned
}

async function writeRuntimeConfig(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rm(path, { force: true })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function mapRuntimeError(error: unknown): SingBoxServiceError {
  if (error instanceof SingBoxServiceError) return error
  if (error instanceof SingBoxManifestError) {
    if (error.code === 'manifest_missing' || error.code === 'runtime_incomplete') {
      return new SingBoxServiceError('core_missing', error.message, { cause: error })
    }
    return new SingBoxServiceError('core_untrusted', error.message, { cause: error })
  }
  return new SingBoxServiceError('core_missing', 'The bundled sing-box runtime is unavailable.', { cause: error })
}

function asServiceError(
  error: unknown,
  fallbackCode: SingBoxServiceErrorCode,
  fallbackMessage: string
): SingBoxServiceError {
  return error instanceof SingBoxServiceError
    ? error
    : new SingBoxServiceError(fallbackCode, fallbackMessage, { cause: error })
}

function runtimeError(error: SingBoxServiceError): SingBoxRuntimeError {
  return { code: error.code, message: error.message }
}

function runtimeEnvironment(
  runtimePath: string,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...source }
  if (platform === 'linux') env.LD_LIBRARY_PATH = prependPath(runtimePath, source.LD_LIBRARY_PATH)
  if (platform === 'darwin') env.DYLD_LIBRARY_PATH = prependPath(runtimePath, source.DYLD_LIBRARY_PATH)
  return env
}

function prependPath(value: string, existing: string | undefined): string {
  return existing ? `${value}${delimiter}${existing}` : value
}

function assertControllerVersion(payload: unknown): void {
  if (!isRecord(payload) || typeof payload.version !== 'string') {
    throw new SingBoxServiceError('health_check', 'Loopback controller did not identify itself as sing-box.')
  }
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:$|[-+\s])/.exec(payload.version)
  if (!match || match[1] !== SING_BOX_VERSION) {
    throw new SingBoxServiceError('health_check', 'Loopback controller version does not match the verified sing-box core.')
  }
}

function parseConnectionSummary(value: unknown): ProxyConnectionSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const chains = Array.isArray(value.chains)
    ? value.chains.filter((item): item is string => typeof item === 'string').slice(0, 32)
    : []
  const source = formatConnectionEndpoint(metadata.sourceIP, metadata.sourcePort) ?? ''
  const destination = formatConnectionEndpoint(metadata.destinationIP, metadata.destinationPort) ?? ''
  const network = stringValue(metadata.network)?.toLowerCase() === 'udp' ? 'udp' : 'tcp'
  const startedAt = typeof value.start === 'number'
    ? nonNegativeInteger(value.start)
    : Date.parse(stringValue(value.start) ?? '')
  return {
    id: value.id.slice(0, 512),
    network,
    ...(stringValue(metadata.type) ? { protocol: stringValue(metadata.type) } : {}),
    source,
    destination,
    outbound: chains[0] ?? 'unknown',
    uploadBytes: nonNegativeInteger(value.upload),
    downloadBytes: nonNegativeInteger(value.download),
    startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : 0
  }
}

function formatConnectionEndpoint(hostValue: unknown, portValue: unknown): string | undefined {
  const host = stringValue(hostValue)
  if (!host) return undefined
  const port = portNumber(portValue)
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port > 0 && port <= 65_535 ? `${formattedHost}:${port}` : formattedHost
}

function portNumber(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 0
}

function normalizeControllerIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || hasAsciiControlCharacter(normalized)) {
    throw new SingBoxServiceError('controller_request', `Invalid ${label}.`)
  }
  return normalized
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function normalizeLatencyUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new SingBoxServiceError('controller_request', 'Latency test URL is invalid.', { cause: error })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new SingBoxServiceError('controller_request', 'Latency test URL must be an HTTP(S) URL without credentials.')
  }
  return url.toString()
}

function normalizePort(value: number, allowAutomatic: boolean): number {
  if (allowAutomatic && value === 0) return 0
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new SingBoxServiceError('config_invalid', 'Proxy ports must be integers from 1 to 65535.')
  }
  return value
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sanitizeRestartDelays(values: readonly number[]): readonly number[] {
  return values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value))
    .slice(0, 10)
}

function sanitizeProcessFailure(error: unknown): string {
  if (!isRecord(error)) return ''
  const stderr = typeof error.stderr === 'string' ? error.stderr : ''
  const stdout = typeof error.stdout === 'string' ? error.stdout : ''
  return sanitizeLogLine(stderr || stdout)
}

function sanitizeLogLine(value: string): string {
  return value
    .replace(/(?:https?|socks\d?):\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => match.replace(/\/\/.*@/, '//[REDACTED]@'))
    .replace(/(["']?\b(?:secret|password|passwd|token|authorization|uuid|private_key|pre_shared_key|psk|auth)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EVENT_LOG_LENGTH)
}

function pipeProcessLines(stream: Readable | null | undefined, listener: (line: string) => void): void {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const sanitized = sanitizeLogLine(line)
      if (sanitized) listener(sanitized)
    }
  })
  stream.on('end', () => {
    const sanitized = sanitizeLogLine(buffer)
    if (sanitized) listener(sanitized)
  })
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onListening = (): void => finish()
    const onError = (error: Error): void => finish(error)
    const finish = (error?: Error): void => {
      server.off('listening', onListening)
      server.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen({ host, port, exclusive: true })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
