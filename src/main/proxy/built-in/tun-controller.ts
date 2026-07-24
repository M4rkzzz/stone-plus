import { isIP } from 'node:net'
import { isLoopbackHostname } from '../system-proxy'

const LOOPBACK_CIDRS = Object.freeze(['127.0.0.0/8', '::1/128'])

export type TunEndpointTransport = 'tcp' | 'udp' | 'any'
export type TunBypassEndpointRole =
  | 'local-gateway'
  | 'mixed'
  | 'controller'
  | 'node'
  | 'dns'

export interface TunEndpoint {
  host: string
  port?: number
  transport?: TunEndpointTransport
}

export interface TunRoutingContext {
  localGateway: TunEndpoint
  mixed: TunEndpoint
  controller: TunEndpoint
  /** The running sing-box process must never send itself back into its TUN. */
  singBoxProcessId: number
  nodeServers?: readonly TunEndpoint[]
  dnsUpstreams?: readonly TunEndpoint[]
  additionalExcludedCidrs?: readonly string[]
}

export interface TunBypassEndpoint extends TunEndpoint {
  role: TunBypassEndpointRole
}

export interface TunBypassPlan {
  excludedCidrs: readonly string[]
  excludedProcessIds: readonly number[]
  excludedEndpoints: readonly TunBypassEndpoint[]
}

export interface TunPlatformStartRequest {
  bypass: TunBypassPlan
}

export interface TunPlatformSession {
  /** Process-scoped identifier; it must not name a persistent service. */
  id: string
  pid?: number
  /** Resolves for early or late sidecar exits and never rejects. */
  exit?: Promise<TunProcessExit>
}

export interface TunProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Bounded native-launcher diagnostics; renderer projection sanitizes it. */
  stderr?: string
}

/**
 * The deliberately small adapter surface only permits a temporary elevated
 * session. There is no install/start-service operation, so a platform adapter
 * cannot make a resident privileged helper part of the controller lifecycle.
 */
export interface TunPlatformAdapter {
  startTemporaryElevated(request: TunPlatformStartRequest): Promise<TunPlatformSession>
  stopTemporary(session: TunPlatformSession): Promise<void>
  /** Retries cleanup for a process that failed before a session could be returned. */
  cleanupPending?(): Promise<void>
  isElevationDenied?(error: unknown): boolean
}

export type TunControllerStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'error'

export type TunControllerErrorCode =
  | 'tun_invalid_bypass'
  | 'tun_elevation_denied'
  | 'tun_start_failed'
  | 'tun_stop_failed'

export class TunControllerError extends Error {
  public readonly code: TunControllerErrorCode

  public constructor(code: TunControllerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TunControllerError'
    this.code = code
  }
}

/** An adapter can throw this after the user rejects the native elevation UI. */
export class TunElevationDeniedError extends Error {
  public readonly code = 'TUN_ELEVATION_DENIED'

  public constructor(message = 'The user declined temporary TUN elevation.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'TunElevationDeniedError'
  }
}

export interface TunControllerState {
  status: TunControllerStatus
  desiredEnabled: boolean
  session?: { id: string; pid?: number; startedAt: number }
  bypass?: TunBypassPlan
  lastError?: { code: TunControllerErrorCode; message: string }
}

export interface TunControllerOptions {
  adapter: TunPlatformAdapter
  now?: () => number
}

export type TunControllerEvent = {
  type: 'unexpected-exit'
  state: TunControllerState
  exit: TunProcessExit
}

/** Serializes temporary TUN elevation, teardown, and retries. */
export class TunController {
  private readonly adapter: TunPlatformAdapter
  private readonly now: () => number
  private operationTail: Promise<void> = Promise.resolve()
  private status: TunControllerStatus = 'stopped'
  private desiredEnabled = false
  private session?: TunPlatformSession
  private startedAt?: number
  private bypass?: TunBypassPlan
  private lastRoutingContext?: TunRoutingContext
  private lastError?: { code: TunControllerErrorCode; message: string }
  private readonly eventListeners = new Set<(event: TunControllerEvent) => void>()

  public constructor(options: TunControllerOptions) {
    this.adapter = options.adapter
    this.now = options.now ?? Date.now
  }

  public getState(): TunControllerState {
    return {
      status: this.status,
      desiredEnabled: this.desiredEnabled,
      ...(this.session && this.startedAt !== undefined
        ? {
            session: {
              id: this.session.id,
              ...(this.session.pid !== undefined ? { pid: this.session.pid } : {}),
              startedAt: this.startedAt
            }
          }
        : {}),
      ...(this.bypass ? { bypass: cloneBypassPlan(this.bypass) } : {}),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {})
    }
  }

  public onEvent(listener: (event: TunControllerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  public start(routing: TunRoutingContext): Promise<TunControllerState> {
    return this.enqueue(async () => {
      this.desiredEnabled = true
      this.lastRoutingContext = cloneRoutingContext(routing)
      if (this.session) {
        if (this.status === 'ready') return this.getState()
        throw this.fail(
          'tun_stop_failed',
          'A previous temporary TUN session still needs to be stopped before restarting.'
        )
      }

      let bypass: TunBypassPlan
      try {
        bypass = createTunBypassPlan(routing)
      } catch (error) {
        if (error instanceof TunControllerError) {
          this.status = 'error'
          this.lastError = { code: error.code, message: error.message }
          throw error
        }
        throw this.fail('tun_invalid_bypass', 'The TUN bypass plan is invalid.', error)
      }

      this.status = 'starting'
      this.bypass = bypass
      this.lastError = undefined
      try {
        // This call is intentionally made for every stopped -> starting
        // transition. Adapters must show/request native elevation each time.
        const session = validatePlatformSession(
          await this.adapter.startTemporaryElevated({ bypass: cloneBypassPlan(bypass) })
        )
        this.session = session
        this.startedAt = this.now()
        this.status = 'ready'
        this.observeSessionExit(session)
        return this.getState()
      } catch (error) {
        const denied = this.isElevationDenied(error)
        throw this.fail(
          denied ? 'tun_elevation_denied' : 'tun_start_failed',
          denied
            ? 'Temporary TUN elevation was declined; Stone+ will not fall back to another route.'
            : 'Could not start the temporary TUN session.',
          error
        )
      }
    })
  }

  /** Retries a failed start without changing the requested routing context. */
  public retryStart(): Promise<TunControllerState> {
    const routing = this.lastRoutingContext
    if (!routing) {
      return Promise.reject(new TunControllerError(
        'tun_start_failed',
        'No previous TUN start request is available to retry.'
      ))
    }
    return this.start(routing)
  }

  public stop(): Promise<TunControllerState> {
    return this.enqueue(async () => {
      this.desiredEnabled = false
      const session = this.session
      if (!session) {
        this.status = 'stopping'
        this.lastError = undefined
        try {
          await this.adapter.cleanupPending?.()
          this.finishStopped()
          return this.getState()
        } catch (error) {
          throw this.fail(
            'tun_stop_failed',
            'Could not clean up a pending temporary TUN session; retry is available.',
            error
          )
        }
      }
      this.status = 'stopping'
      this.lastError = undefined
      try {
        await this.adapter.stopTemporary(session)
      } catch (error) {
        // Retain the handle and bypass plan. stop()/retryStop() can safely call
        // the adapter again instead of losing ownership of a privileged session.
        throw this.fail(
          'tun_stop_failed',
          'Could not stop the temporary TUN session; retry is available.',
          error
        )
      }
      // The active session is gone even if cleanup of an earlier failed start
      // still needs another retry.
      this.session = undefined
      this.startedAt = undefined
      try {
        await this.adapter.cleanupPending?.()
      } catch (error) {
        throw this.fail(
          'tun_stop_failed',
          'Could not clean up a pending temporary TUN session; retry is available.',
          error
        )
      }
      this.finishStopped()
      return this.getState()
    })
  }

  public retryStop(): Promise<TunControllerState> {
    return this.stop()
  }

  public async close(): Promise<void> {
    await this.stop()
    this.eventListeners.clear()
  }

  private finishStopped(): void {
    this.status = 'stopped'
    this.session = undefined
    this.startedAt = undefined
    this.bypass = undefined
    this.lastError = undefined
  }

  private fail(
    code: TunControllerErrorCode,
    message: string,
    cause?: unknown
  ): TunControllerError {
    const diagnosticMessage = appendCauseDetails(message, cause)
    this.status = 'error'
    this.lastError = { code, message: diagnosticMessage }
    return new TunControllerError(code, diagnosticMessage, cause === undefined ? undefined : { cause })
  }

  private isElevationDenied(error: unknown): boolean {
    if (error instanceof TunElevationDeniedError) return true
    try {
      if (this.adapter.isElevationDenied?.(error)) return true
    } catch {
      // Classification must never replace the original start failure.
    }
    if (error === null || typeof error !== 'object') return false
    const candidate = error as { code?: unknown; errno?: unknown }
    return candidate.errno === 1223 || [
      'EACCES',
      'EPERM',
      'ERROR_CANCELLED',
      'USER_CANCELLED',
      'TUN_ELEVATION_DENIED'
    ].includes(String(candidate.code ?? '').toUpperCase())
  }

  private observeSessionExit(session: TunPlatformSession): void {
    if (!session.exit) return
    const publish = (exit: TunProcessExit): void => {
      if (
        // Compare the validated session object, not only its runner-provided
        // string ID. A launcher is allowed to reuse an ID after stop; a late
        // exit notification from that retired process must never poison the
        // replacement TUN session.
        this.session !== session
        || !this.desiredEnabled
        || this.status === 'stopping'
        || this.status === 'stopped'
      ) return
      const failure = {
        code: 'tun_start_failed' as const,
        message: describeUnexpectedExit(exit)
      }
      this.status = 'error'
      this.lastError = failure
      const event: TunControllerEvent = { type: 'unexpected-exit', state: this.getState(), exit }
      for (const listener of this.eventListeners) {
        try {
          listener(event)
        } catch {
          // One observer must not suppress fail-closed notification to the
          // remaining owners or create an unhandled promise rejection.
        }
      }
    }
    void session.exit.then(publish, (error) => publish({
      code: null,
      signal: null,
      stderr: appendCauseDetails('The TUN process exit monitor failed.', error),
    }))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function createTunBypassPlan(context: TunRoutingContext): TunBypassPlan {
  if (!Number.isInteger(context.singBoxProcessId) || context.singBoxProcessId <= 0) {
    throw invalidBypass('A running sing-box process ID is required for TUN self-exclusion.')
  }
  const localGateway = normalizeEndpoint(context.localGateway, 'local-gateway', true, true)
  const mixed = normalizeEndpoint(context.mixed, 'mixed', true, true)
  const controller = normalizeEndpoint(context.controller, 'controller', true, true)

  const endpoints: TunBypassEndpoint[] = [localGateway, mixed, controller]
  for (const endpoint of context.nodeServers ?? []) {
    endpoints.push(normalizeEndpoint(endpoint, 'node', false, false))
  }
  for (const endpoint of context.dnsUpstreams ?? []) {
    endpoints.push(normalizeEndpoint(endpoint, 'dns', false, false))
  }

  const excludedCidrs: string[] = []
  const seenCidrs = new Set<string>()
  for (const rawCidr of [...LOOPBACK_CIDRS, ...(context.additionalExcludedCidrs ?? [])]) {
    const cidr = normalizeCidr(rawCidr)
    const key = cidr.toLowerCase()
    if (seenCidrs.has(key)) continue
    seenCidrs.add(key)
    excludedCidrs.push(cidr)
  }

  const seenEndpoints = new Set<string>()
  const excludedEndpoints = endpoints.filter((endpoint) => {
    const key = `${endpoint.role}:${endpoint.host.toLowerCase()}:${endpoint.port ?? ''}:${endpoint.transport ?? 'any'}`
    if (seenEndpoints.has(key)) return false
    seenEndpoints.add(key)
    return true
  })

  return {
    excludedCidrs,
    excludedProcessIds: [context.singBoxProcessId],
    excludedEndpoints
  }
}

function normalizeEndpoint(
  endpoint: TunEndpoint,
  role: TunBypassEndpointRole,
  requireLoopback: boolean,
  requirePort: boolean
): TunBypassEndpoint {
  const host = endpoint.host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host.length > 512 || hasInvalidHostCharacter(host)) {
    throw invalidBypass(`The ${role} bypass host is invalid.`)
  }
  if (requireLoopback && !isLoopbackHostname(host)) {
    throw invalidBypass(`The ${role} endpoint must listen on loopback.`)
  }
  if (requirePort && endpoint.port === undefined) {
    throw invalidBypass(`The ${role} bypass endpoint requires a port.`)
  }
  if (endpoint.port !== undefined && !validPort(endpoint.port)) {
    throw invalidBypass(`The ${role} bypass port is invalid.`)
  }
  if (endpoint.transport && !['tcp', 'udp', 'any'].includes(endpoint.transport)) {
    throw invalidBypass(`The ${role} bypass transport is invalid.`)
  }
  return {
    role,
    host,
    ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
    ...(endpoint.transport ? { transport: endpoint.transport } : {})
  }
}

function hasInvalidHostCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return character === '/' || (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f))
  })
}

function normalizeCidr(value: string): string {
  const cidr = value.trim()
  const match = /^(.+)\/(\d{1,3})$/.exec(cidr)
  if (!match) throw invalidBypass(`Invalid TUN bypass CIDR: ${cidr || '(empty)'}.`)
  const family = isIP(match[1])
  const prefix = Number(match[2])
  if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw invalidBypass(`Invalid TUN bypass CIDR: ${cidr}.`)
  }
  return `${match[1].toLowerCase()}/${prefix}`
}

function validatePlatformSession(value: TunPlatformSession): TunPlatformSession {
  if (!value || typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error('The TUN platform adapter returned an invalid temporary session.')
  }
  if (value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid <= 0)) {
    throw new Error('The TUN platform adapter returned an invalid process ID.')
  }
  if (value.exit !== undefined && (typeof value.exit !== 'object' || typeof value.exit.then !== 'function')) {
    throw new Error('The TUN platform adapter returned an invalid exit monitor.')
  }
  return {
    id: value.id,
    ...(value.pid !== undefined ? { pid: value.pid } : {}),
    ...(value.exit ? { exit: value.exit } : {})
  }
}

function appendCauseDetails(message: string, cause: unknown): string {
  if (cause === undefined) return message
  const details: string[] = []
  const seen = new Set<object>()
  let current: unknown = cause
  while (current && typeof current === 'object' && details.length < 4 && !seen.has(current)) {
    seen.add(current)
    const record = current as { message?: unknown; cause?: unknown }
    const detail = typeof record.message === 'string'
      ? record.message.replace(/\s+/g, ' ').trim().slice(0, 500)
      : ''
    if (detail && detail !== message && !details.includes(detail)) details.push(detail)
    current = record.cause
  }
  return details.length > 0 ? `${message} Detail: ${details.join(' → ')}` : message
}

function describeUnexpectedExit(exit: TunProcessExit): string {
  const status = exit.code !== null
    ? `exit code ${exit.code}`
    : exit.signal
      ? `signal ${exit.signal}`
      : 'the process disappeared'
  const detail = exit.stderr?.replace(/\s+/g, ' ').trim().slice(0, 500)
  return `The temporary elevated TUN sidecar exited unexpectedly (${status}).${detail ? ` Detail: ${detail}` : ''}`
}

function invalidBypass(message: string): TunControllerError {
  return new TunControllerError('tun_invalid_bypass', message)
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function cloneBypassPlan(plan: TunBypassPlan): TunBypassPlan {
  return {
    excludedCidrs: [...plan.excludedCidrs],
    excludedProcessIds: [...plan.excludedProcessIds],
    excludedEndpoints: plan.excludedEndpoints.map((endpoint) => ({ ...endpoint }))
  }
}

function cloneRoutingContext(context: TunRoutingContext): TunRoutingContext {
  return {
    localGateway: { ...context.localGateway },
    mixed: { ...context.mixed },
    controller: { ...context.controller },
    singBoxProcessId: context.singBoxProcessId,
    ...(context.nodeServers ? { nodeServers: context.nodeServers.map((endpoint) => ({ ...endpoint })) } : {}),
    ...(context.dnsUpstreams ? { dnsUpstreams: context.dnsUpstreams.map((endpoint) => ({ ...endpoint })) } : {}),
    ...(context.additionalExcludedCidrs
      ? { additionalExcludedCidrs: [...context.additionalExcludedCidrs] }
      : {})
  }
}
