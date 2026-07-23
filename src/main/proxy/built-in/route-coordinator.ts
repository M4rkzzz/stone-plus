import type {
  BuiltInProxyErrorCategory,
  BuiltInProxyLifecycleStatus,
  EffectiveOutboundRoute,
  OutboundNetworkMode
} from '@shared/types'
import { isLocalTarget, isLoopbackHostname } from '../system-proxy'

export type BuiltInProxyRouteStatus = BuiltInProxyLifecycleStatus
export type BuiltInProxyEffectiveRouteKind = EffectiveOutboundRoute['kind']

export interface BuiltInProxyRouteError {
  category: BuiltInProxyErrorCategory
  message: string
  retryable: boolean
  cause?: unknown
}

export type BuiltInProxyEffectiveRoute = EffectiveOutboundRoute

export interface BuiltInProxyRouteSnapshot {
  desiredEnabled: boolean
  status: BuiltInProxyRouteStatus
  hasActivated: boolean
  effectiveRoute: BuiltInProxyEffectiveRoute
  error?: BuiltInProxyRouteError
}

export interface BuiltInProxyRouteActivation {
  /** Electron session.fetch from the Stone+-only Chromium partition. */
  fetchImplementation: typeof fetch
  /** The checked sing-box mixed listener. Only a loopback HTTP endpoint is accepted. */
  mixedEndpoint: string
  routeKind?: 'built-in-mixed' | 'built-in-tun'
  profileId?: string
  nodeId?: string
  activatedAt?: number
  /** Hidden controller and other verified local control-plane listeners. */
  directLoopbackPorts?: readonly number[]
  /** Refreshes sing-box connections and the dedicated Chromium proxy session. */
  refresh?: (origins: readonly string[]) => Promise<void> | void
  /** Runs only after requests captured by this generation have drained. */
  dispose?: () => Promise<void> | void
}

export interface BuiltInProxyRouteCoordinatorOptions {
  externalMode?: OutboundNetworkMode
  now?: () => number
  retry?: () => Promise<void> | void
  directLoopbackPorts?: readonly number[]
  /** Maximum grace period for a response body captured by a retired route. */
  retirementDrainTimeoutMs?: number
  /** Maximum time retirement waits for Chromium/core disposal callbacks. */
  disposalTimeoutMs?: number
}

interface ExternalRouteGeneration {
  generation: number
  kind: 'external'
}

interface BuiltInRouteGeneration {
  generation: number
  kind: 'built-in-mixed' | 'built-in-tun'
  fetchImplementation: typeof fetch
  refresh?: (origins: readonly string[]) => Promise<void> | void
  dispose?: () => Promise<void> | void
  effectiveRoute: BuiltInProxyEffectiveRoute
  directLoopbackPorts: ReadonlySet<number>
  inFlight: number
  retired: boolean
  disposalStarted: boolean
  finishRetirement?: () => void
  retirementTimer?: ReturnType<typeof setTimeout>
}

interface BlockedRouteGeneration {
  generation: number
  kind: 'blocked'
  error: BuiltInProxyRouteError
  effectiveRoute: BuiltInProxyEffectiveRoute
  directLoopbackPorts: ReadonlySet<number>
}

type RouteGeneration = ExternalRouteGeneration | BuiltInRouteGeneration | BlockedRouteGeneration
type StateListener = (snapshot: BuiltInProxyRouteSnapshot) => void

/**
 * Raised instead of consulting an account proxy, pool proxy, system proxy, or
 * DIRECT whenever a previously published built-in route is unavailable.
 */
export class BuiltInProxyRouteUnavailableError extends Error {
  public readonly code = 'BUILT_IN_PROXY_FAIL_CLOSED'
  public readonly routeGeneration: number
  public readonly category: string
  public readonly retryable: boolean

  constructor(routeGeneration: number, failure: BuiltInProxyRouteError) {
    super(`Built-in proxy is unavailable: ${failure.message}`, { cause: failure.cause })
    this.name = 'BuiltInProxyRouteUnavailableError'
    this.routeGeneration = routeGeneration
    this.category = failure.category
    this.retryable = failure.retryable
  }
}

/**
 * Owns the atomic route pointer used by Stone+ requests. The coordinator is
 * deliberately independent of Electron and sing-box: main/index prepares a
 * dedicated Chromium session, verifies the mixed listener, then publishes its
 * fetch implementation with activate().
 */
export class BuiltInProxyRouteCoordinator {
  private externalMode: OutboundNetworkMode
  private readonly now: () => number
  private readonly retirementDrainTimeoutMs: number
  private readonly disposalTimeoutMs: number
  private retry?: () => Promise<void> | void
  private nextGeneration = 1
  private route: RouteGeneration = { generation: 0, kind: 'external' }
  private desiredEnabled = false
  private status: BuiltInProxyRouteStatus = 'disabled'
  private hasActivated = false
  private error?: BuiltInProxyRouteError
  private readonly listeners = new Set<StateListener>()
  private readonly retirements = new Set<Promise<void>>()
  private readonly retiredRoutes = new Set<BuiltInRouteGeneration>()
  private readonly pendingRebuildOrigins = new Set<string>()
  private readonly permanentDirectLoopbackPorts = new Set<number>()
  private rebuildFlight?: Promise<void>
  private closed = false

  constructor(options: BuiltInProxyRouteCoordinatorOptions = {}) {
    this.externalMode = options.externalMode ?? 'direct'
    this.now = options.now ?? (() => Date.now())
    this.retirementDrainTimeoutMs = Math.max(1, options.retirementDrainTimeoutMs ?? 5_000)
    this.disposalTimeoutMs = Math.max(1, options.disposalTimeoutMs ?? 5_000)
    this.retry = options.retry
    this.addDirectLoopbackPorts(options.directLoopbackPorts ?? [])
  }

  public getSnapshot(): BuiltInProxyRouteSnapshot {
    return {
      desiredEnabled: this.desiredEnabled,
      status: this.status,
      hasActivated: this.hasActivated,
      effectiveRoute: this.effectiveRouteSnapshot(),
      ...(this.error ? { error: { ...this.error } } : {})
    }
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Preserve the user's external setting while built-in routing is active. */
  public setExternalMode(mode: OutboundNetworkMode): void {
    if (this.externalMode === mode) return
    this.externalMode = mode
    this.emit()
  }

  public setRetryHandler(retry: (() => Promise<void> | void) | undefined): void {
    this.retry = retry
  }

  /** Register only verified Stone+/sing-box control-plane listeners. */
  public addDirectLoopbackPorts(ports: readonly number[]): void {
    for (const port of ports) {
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) this.permanentDirectLoopbackPorts.add(port)
    }
  }

  /** Starting before the first healthy configuration intentionally keeps the external route. */
  public requestEnable(): void {
    this.assertOpen()
    this.desiredEnabled = true
    this.status = 'starting'
    this.error = undefined
    this.emit()
  }

  public markStarting(): void {
    this.assertOpen()
    this.desiredEnabled = true
    this.status = 'starting'
    this.error = undefined
    this.emit()
  }

  /**
   * Cancels a failed replacement without republishing or retiring the current
   * healthy generation. Call only after its previous access resource has been
   * restored and verified.
   */
  public restoreReady(): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    if (this.route.kind !== 'built-in-mixed' && this.route.kind !== 'built-in-tun') {
      throw new Error('There is no built-in proxy route generation to restore.')
    }
    this.desiredEnabled = true
    this.status = 'ready'
    this.error = undefined
    this.emit()
    return this.getSnapshot()
  }

  /** Atomically publishes a checked, healthy dedicated Chromium mixed route. */
  public activate(activation: BuiltInProxyRouteActivation): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    const mixedPort = validateMixedEndpoint(activation.mixedEndpoint)
    const generationDirectLoopbackPorts = validPortSet([
      mixedPort,
      ...(activation.directLoopbackPorts ?? [])
    ])
    const generation = this.nextGeneration++
    const effectiveRoute: BuiltInProxyEffectiveRoute = {
      generation,
      kind: activation.routeKind ?? 'built-in-mixed',
      ...(activation.profileId ? { profileId: activation.profileId } : {}),
      ...(activation.nodeId ? { nodeId: activation.nodeId } : {}),
      mixedPort,
      activatedAt: activation.activatedAt ?? this.now()
    }
    const next: BuiltInRouteGeneration = {
      generation,
      kind: effectiveRoute.kind as 'built-in-mixed' | 'built-in-tun',
      fetchImplementation: activation.fetchImplementation,
      refresh: activation.refresh,
      dispose: activation.dispose,
      effectiveRoute,
      directLoopbackPorts: generationDirectLoopbackPorts,
      inFlight: 0,
      retired: false,
      disposalStarted: false,
      finishRetirement: undefined,
      retirementTimer: undefined
    }
    this.publish(next)
    this.desiredEnabled = true
    this.status = 'ready'
    this.hasActivated = true
    this.error = undefined
    this.emit()
    return this.getSnapshot()
  }

  /**
   * Records a preparation error. Before the first activation the previous
   * external route remains live; after activation this becomes fail-closed.
   */
  public reportError(error: BuiltInProxyRouteError | Error | string): BuiltInProxyRouteSnapshot {
    const failure = normalizeRouteError(error)
    if (this.hasActivated || this.route.kind !== 'external') return this.failClosed(failure)
    this.status = 'error'
    this.error = failure
    this.emit()
    return this.getSnapshot()
  }

  /** Explicitly blocks all non-loopback Stone+ requests, including first-start TUN failures. */
  public failClosed(error: BuiltInProxyRouteError | Error | string): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    const failure = normalizeRouteError(error)
    const previousMetadata = this.route.kind === 'external'
      ? undefined
      : this.route.effectiveRoute
    const directLoopbackPorts = this.route.kind === 'external'
      ? new Set<number>()
      : new Set(this.route.directLoopbackPorts)
    const generation = this.nextGeneration++
    this.publish({
      generation,
      kind: 'blocked',
      error: failure,
      directLoopbackPorts,
      effectiveRoute: {
        generation,
        kind: 'blocked',
        ...(previousMetadata?.profileId ? { profileId: previousMetadata.profileId } : {}),
        ...(previousMetadata?.nodeId ? { nodeId: previousMetadata.nodeId } : {}),
        ...(previousMetadata?.mixedPort ? { mixedPort: previousMetadata.mixedPort } : {}),
        ...(previousMetadata?.activatedAt ? { activatedAt: previousMetadata.activatedAt } : {})
      }
    })
    this.status = 'error'
    this.error = failure
    this.emit()
    return this.getSnapshot()
  }

  /** A disable attempt keeps the current built-in/blocked route until restoration commits. */
  public beginDisable(): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    this.desiredEnabled = false
    this.error = undefined
    if (this.route.kind === 'external') {
      this.status = 'disabled'
    } else {
      this.status = 'stopping'
    }
    this.emit()
    return this.getSnapshot()
  }

  /** Restoration failed: keep the current route and expose a retryable error. */
  public disableFailed(error: BuiltInProxyRouteError | Error | string): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    this.desiredEnabled = false
    this.status = 'error'
    this.error = normalizeRouteError(error)
    this.emit()
    return this.getSnapshot()
  }

  /** Call only after the system-proxy lease/TUN has been restored successfully. */
  public completeDisable(): BuiltInProxyRouteSnapshot {
    this.assertOpen()
    this.desiredEnabled = false
    this.status = 'disabled'
    this.error = undefined
    if (this.route.kind !== 'external') {
      this.publish({ generation: this.nextGeneration++, kind: 'external' })
    }
    this.emit()
    return this.getSnapshot()
  }

  public isIntercepting(): boolean {
    return this.route.kind !== 'external'
  }

  public isReady(): boolean {
    return this.route.kind === 'built-in-mixed' || this.route.kind === 'built-in-tun'
  }

  /**
   * Returns a fetch facade whose route is captured synchronously at each
   * invocation. A route change cannot move an already-started request, while
   * the next invocation observes the newly published generation.
   */
  public bind(externalFetch: typeof fetch, loopbackFetch: typeof fetch): typeof fetch {
    return (async (input, init) => {
      if (this.closed) throw new Error('Built-in proxy route coordinator is closed.')
      if (this.shouldDirectLoopback(input)) return loopbackFetch(input, init)
      const captured = this.route
      if (captured.kind === 'external') return externalFetch(input, init)
      if (captured.kind === 'blocked') {
        throw new BuiltInProxyRouteUnavailableError(captured.generation, captured.error)
      }
      return this.executeBuiltIn(captured, input, init)
    }) as typeof fetch
  }

  /** Warm checked built-in routing without refreshing sing-box or Chromium. */
  public async warm(
    origins: readonly string[],
    signal: AbortSignal = AbortSignal.timeout(5_000)
  ): Promise<void> {
    const targets = normalizeWarmTargets(origins)
    const results = await Promise.allSettled(targets.map((target) => this.warmTarget(target, signal)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  /**
   * Built-in rebuild single-flight: refresh sing-box/Chromium, then prewarm all
   * targets accumulated by concurrent account/pool groups. It never touches
   * the external PAC/system route.
   */
  public rebuild(origins: readonly string[] = []): Promise<void> {
    this.assertOpen()
    for (const target of normalizeWarmTargets(origins)) this.pendingRebuildOrigins.add(target)
    if (this.rebuildFlight) return this.rebuildFlight
    const flight = Promise.resolve().then(() => this.runRebuild()).finally(() => {
      if (this.rebuildFlight === flight) this.rebuildFlight = undefined
    })
    this.rebuildFlight = flight
    return flight
  }

  /** Wait for dispose callbacks belonging to atomically retired generations. */
  public async drainRetired(): Promise<void> {
    while (this.retirements.size > 0) {
      await Promise.allSettled([...this.retirements])
    }
  }

  public async close(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pendingRebuildOrigins.clear()
    await settleWithin(
      Promise.allSettled(this.rebuildFlight ? [this.rebuildFlight] : []),
      this.disposalTimeoutMs,
    )
    if (this.route.kind === 'built-in-mixed' || this.route.kind === 'built-in-tun') {
      this.retire(this.route)
    }
    if (options.force) {
      for (const route of this.retiredRoutes) this.startDisposal(route)
    }
    await this.drainRetired()
  }

  private async runRebuild(): Promise<void> {
    // Let callers in the same turn contribute all enabled origins to one
    // refresh flight before taking the first snapshot.
    await Promise.resolve()
    if (this.route.kind === 'blocked') {
      if (!this.retry) throw new BuiltInProxyRouteUnavailableError(this.route.generation, this.route.error)
      await this.retry()
    }
    const refreshRoute = this.route
    if (refreshRoute.kind !== 'built-in-mixed' && refreshRoute.kind !== 'built-in-tun') {
      if (refreshRoute.kind === 'blocked') {
        throw new BuiltInProxyRouteUnavailableError(refreshRoute.generation, refreshRoute.error)
      }
      throw new Error('Built-in proxy route is not active.')
    }
    await refreshRoute.refresh?.([...this.pendingRebuildOrigins])
    while (this.pendingRebuildOrigins.size > 0) {
      const targets = [...this.pendingRebuildOrigins]
      this.pendingRebuildOrigins.clear()
      await this.warm(targets)
    }
  }

  private async warmTarget(target: string, signal: AbortSignal): Promise<void> {
    const captured = this.route
    if (captured.kind === 'blocked') {
      throw new BuiltInProxyRouteUnavailableError(captured.generation, captured.error)
    }
    if (captured.kind === 'external') throw new Error('Built-in proxy route is not active.')
    const response = await this.executeBuiltIn(captured, target, {
      method: 'HEAD',
      redirect: 'manual',
      signal
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 407) throw new Error('Built-in mixed proxy requires authentication.')
  }

  private async executeBuiltIn(
    route: BuiltInRouteGeneration,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    route.inFlight += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      route.inFlight = Math.max(0, route.inFlight - 1)
      if (route.retired && route.inFlight === 0) this.startDisposal(route)
    }
    try {
      const response = await route.fetchImplementation(input, init)
      if (!response.body) {
        release()
        return response
      }
      return responseWithTrackedBody(response, release)
    } catch (error) {
      release()
      throw error
    }
  }

  private publish(next: RouteGeneration): void {
    const previous = this.route
    this.route = next
    if (previous.kind === 'built-in-mixed' || previous.kind === 'built-in-tun') this.retire(previous)
  }

  private retire(route: BuiltInRouteGeneration): void {
    if (route.retired) return
    route.retired = true
    this.retiredRoutes.add(route)
    let finishRetirement!: () => void
    const retirement = new Promise<void>((resolve) => { finishRetirement = resolve })
    route.finishRetirement = finishRetirement
    this.retirements.add(retirement)
    void retirement.finally(() => this.retirements.delete(retirement)).catch(() => undefined)
    if (route.inFlight === 0) {
      this.startDisposal(route)
    } else {
      route.retirementTimer = setTimeout(() => this.startDisposal(route), this.retirementDrainTimeoutMs)
      route.retirementTimer.unref?.()
    }
  }

  private startDisposal(route: BuiltInRouteGeneration): void {
    if (route.disposalStarted) return
    route.disposalStarted = true
    if (route.retirementTimer) {
      clearTimeout(route.retirementTimer)
      route.retirementTimer = undefined
    }
    const disposal = Promise.resolve().then(() => route.dispose?.())
    void settleWithin(disposal, this.disposalTimeoutMs).finally(() => {
      this.retiredRoutes.delete(route)
      route.finishRetirement?.()
      route.finishRetirement = undefined
    }).catch(() => undefined)
  }

  private effectiveRouteSnapshot(): BuiltInProxyEffectiveRoute {
    if (this.route.kind === 'external') {
      return {
        generation: this.route.generation,
        kind: 'external',
        externalMode: this.externalMode
      }
    }
    return { ...this.route.effectiveRoute }
  }

  public shouldDirectLoopback(input: Parameters<typeof fetch>[0]): boolean {
    if (!isLocalTarget(input)) return false
    try {
      const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      return this.permanentDirectLoopbackPorts.has(port)
        || (this.route.kind !== 'external' && this.route.directLoopbackPorts.has(port))
    } catch {
      return false
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // State observers cannot participate in the atomic route commit.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Built-in proxy route coordinator is closed.')
  }
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeRouteError(error: BuiltInProxyRouteError | Error | string): BuiltInProxyRouteError {
  if (typeof error === 'string') {
    return { category: 'unknown', message: error, retryable: true }
  }
  if (error instanceof Error) {
    const category = 'code' in error && typeof error.code === 'string'
      ? builtInErrorCategory(error.code)
      : 'unknown'
    return { category, message: error.message, retryable: true, cause: error }
  }
  return {
    category: builtInErrorCategory(error.category),
    message: error.message,
    retryable: error.retryable,
    ...(error.cause === undefined ? {} : { cause: error.cause })
  }
}

function builtInErrorCategory(value: string): BuiltInProxyErrorCategory {
  const normalized = value.toLowerCase().replaceAll('_', '-')
  switch (normalized) {
    case 'core-missing':
    case 'core-integrity':
    case 'configuration-invalid':
    case 'node-handshake':
    case 'mixed-port':
    case 'tun-elevation':
    case 'subscription-update':
    case 'system-proxy':
    case 'health-check':
    case 'core-crashed':
      return normalized
    default:
      return 'unknown'
  }
}

function validateMixedEndpoint(endpoint: string): number {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('Built-in proxy mixed endpoint is invalid.')
  }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:'
    || !isLoopbackHostname(url.hostname)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
  ) {
    throw new Error('Built-in proxy mixed endpoint must be an unauthenticated loopback HTTP address with an explicit port.')
  }
  return port
}

function normalizeWarmTargets(origins: readonly string[]): string[] {
  const targets = new Set<string>()
  for (const origin of origins) {
    try {
      const url = new URL(origin)
      if (isLoopbackHostname(url.hostname)) continue
      targets.add(new URL('/', url.origin).toString())
    } catch {
      // Preserve existing rebuild semantics: malformed optional targets do not
      // prevent valid enabled sources from being refreshed and warmed.
    }
  }
  return [...targets]
}

function validPortSet(ports: readonly number[]): ReadonlySet<number> {
  return new Set(ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535))
}

function responseWithTrackedBody(response: Response, release: () => void): Response {
  try {
    const reader = response.body!.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            release()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      cancel(reason) {
        // The generation can retire as soon as cancellation is requested; a
        // misbehaving Chromium cancel promise must not pin shutdown forever.
        release()
        return reader.cancel(reason)
      }
    })
    const tracked = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
    Object.defineProperties(tracked, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type }
    })
    return tracked
  } catch {
    // Unusual/opaque response types cannot be reconstructed. The Chromium
    // session still owns their body, so keep behavior correct and conservatively
    // release the generation lease at the headers boundary.
    release()
    return response
  }
}
