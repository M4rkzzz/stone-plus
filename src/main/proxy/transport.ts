import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { socksDispatcher } from 'fetch-socks'
import type {
  Account,
  OutboundNetworkMode,
  Pool,
  PublicProxyDefinition,
  SystemProxyDetectionResult,
  SystemProxyTargetStatus
} from '@shared/types'
import {
  isLocalTarget,
  parseSystemProxyChain,
  summarizeSystemProxyChain,
  type SystemProxyDirective
} from './system-proxy'
import { BuiltInProxyRouteCoordinator } from './built-in/route-coordinator'

const PROBE_TARGETS = [
  { url: 'https://api.ipify.org?format=json', parse: parseJsonIp },
  { url: 'https://icanhazip.com', parse: parseTextIp }
] as const
// This is a per-origin ceiling, not a preconnect count. Undici creates sockets
// lazily, so a quiet origin still owns only the connection(s) it actually uses.
// The wider budget prevents long-lived, non-idempotent generation streams from
// forming a second queue inside the transport after the scheduler has already
// admitted them.
const DEFAULT_OUTBOUND_CONNECTION_BUDGET = 200
const OUTBOUND_CONNECT_TIMEOUT_MS = 10_000
const OUTBOUND_KEEP_ALIVE_TIMEOUT_MS = 5 * 60_000
const OUTBOUND_KEEP_ALIVE_MAX_TIMEOUT_MS = 10 * 60_000
const OUTBOUND_H2_PING_INTERVAL_MS = 30_000
const DEFAULT_SYSTEM_PROXY_CACHE_TTL_MS = 30_000
const DEFAULT_SYSTEM_PROXY_RELOAD_TIMEOUT_MS = 5_000

interface TransportGeneration {
  updatedAt: number
  authenticationFingerprint: string
  createDispatcher: (connections: number) => Dispatcher
  fetchImplementation: typeof fetch
  originPools: Map<string, OriginTransportPool>
  warmups: Map<string, Promise<void>>
}

interface OriginTransportPool {
  dispatcher: Dispatcher
  fetchImplementation: typeof fetch
  usedByApplication: boolean
  warmed: boolean
}

interface TransportHandle {
  generation: TransportGeneration
  fetchImplementation: typeof fetch
}

export interface OutboundTransportManagerOptions {
  connectionCountForOrigin?: (origin: string) => number
  /** @deprecated Kept for compatibility with pre-pool transport tests/configuration. */
  laneCountForOrigin?: (origin: string) => number
  outboundNetworkMode?: OutboundNetworkMode
  /** Chromium/Electron fetch bound to the default session. In production this
   * is the authoritative executor for Windows system proxy/PAC traffic. */
  systemProxyFetch?: typeof fetch
  /** Reloads WinINET/PAC configuration without closing in-flight requests. */
  reloadSystemProxy?: () => Promise<void>
  /** Bounds an operating-system/PAC reload so startup, diagnostics and
   * shutdown cannot wait forever on WinINET/WPAD. */
  systemProxyReloadTimeoutMs?: number
  resolveSystemProxy?: (url: string) => Promise<string>
  systemProxyCacheTtlMs?: number
  localGatewayPort?: number
  onSystemProxyWarning?: (message: string) => void
  now?: () => number
  /** Route pointer fed by SingBoxService/main. It has no Electron dependency. */
  builtInRouteCoordinator?: BuiltInProxyRouteCoordinator
}

interface SystemProxyResolution {
  directives: SystemProxyDirective[]
  warning?: string
}

interface CachedSystemProxyResolution {
  expiresAt: number
  resolution: Promise<SystemProxyResolution>
  refreshing?: Promise<void>
}

export interface ProxyProbeResult {
  exitIp: string
  latencyMs: number
}

export class OutboundTransportManager {
  public readonly builtInRoutes: BuiltInProxyRouteCoordinator
  private readonly cache = new Map<string, TransportGeneration>()
  private readonly systemCache = new Map<string, TransportGeneration>()
  private readonly rotations = new Map<string, Promise<void>>()
  private readonly retirements = new Set<Promise<void>>()
  private readonly handles = new Map<string, TransportHandle>()
  private readonly connectionCountForOrigin: (origin: string) => number
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly systemProxyFetch?: typeof fetch
  private readonly reloadSystemProxy?: () => Promise<void>
  private readonly systemProxyReloadTimeoutMs: number
  private readonly systemProxyCacheTtlMs: number
  private readonly onSystemProxyWarning: (message: string) => void
  private readonly now: () => number
  private readonly systemProxyCache = new Map<string, CachedSystemProxyResolution>()
  private outboundNetworkMode: OutboundNetworkMode
  private localGatewayPort?: number
  private systemProxyResolutionWarningReported = false
  private systemProxyReloadFlight?: Promise<void>
  private direct?: TransportGeneration
  private closed = false
  private readonly routedFetches = new WeakMap<typeof fetch, typeof fetch>()
  private readonly loopbackFetchImplementation: typeof fetch
  private readonly externalImplicitFetchImplementation: typeof fetch
  private readonly implicitFetchImplementation: typeof fetch

  constructor(options: OutboundTransportManagerOptions = {}) {
    this.connectionCountForOrigin = options.connectionCountForOrigin
      ?? options.laneCountForOrigin
      ?? defaultConnectionCountForOrigin
    this.outboundNetworkMode = options.outboundNetworkMode ?? 'direct'
    this.systemProxyFetch = options.systemProxyFetch
    this.reloadSystemProxy = options.reloadSystemProxy
    this.systemProxyReloadTimeoutMs = Math.max(1, options.systemProxyReloadTimeoutMs ?? DEFAULT_SYSTEM_PROXY_RELOAD_TIMEOUT_MS)
    this.resolveSystemProxy = options.resolveSystemProxy
    this.systemProxyCacheTtlMs = Math.max(1_000, options.systemProxyCacheTtlMs ?? DEFAULT_SYSTEM_PROXY_CACHE_TTL_MS)
    this.localGatewayPort = options.localGatewayPort
    this.onSystemProxyWarning = options.onSystemProxyWarning ?? ((message) => console.warn(message))
    this.now = options.now ?? (() => Date.now())
    this.builtInRoutes = options.builtInRouteCoordinator ?? new BuiltInProxyRouteCoordinator({
      externalMode: this.outboundNetworkMode,
      now: this.now,
      directLoopbackPorts: this.localGatewayPort ? [this.localGatewayPort] : []
    })
    this.builtInRoutes.setExternalMode(this.outboundNetworkMode)
    if (this.localGatewayPort) this.builtInRoutes.addDirectLoopbackPorts([this.localGatewayPort])
    this.loopbackFetchImplementation = (async (input, init) => {
      if (this.closed) throw new Error('Outbound transport manager is closed.')
      return this.directFetch()(input, init)
    }) as typeof fetch
    this.externalImplicitFetchImplementation = (async (input, init) => {
      if (this.closed) throw new Error('Outbound transport manager is closed.')
      if (this.outboundNetworkMode === 'direct' || isLocalTarget(input)) {
        return this.directFetch()(input, init)
      }
      return this.fetchUsingSystemProxy(input, init)
    }) as typeof fetch
    this.implicitFetchImplementation = this.routeFetch(this.externalImplicitFetchImplementation)
  }

  public fetchFor(proxy: PublicProxyDefinition | undefined, password?: string): typeof fetch {
    if (this.closed) throw new Error('Outbound transport manager is closed.')
    if (!proxy) {
      return this.implicitFetchImplementation
    }
    // Do not even instantiate an account/pool Undici dispatcher while a
    // built-in generation owns Stone+ traffic. The lazy external closure is
    // retained only so a request captured after an atomic disable can either
    // use its exact explicit route or fail safely when credentials are absent.
    const externalFetch = this.builtInRoutes.isIntercepting()
      ? this.suspendedExternalFetch(proxy, password)
      : this.fetchForResolvedProxy(proxy, password, false)
    return this.routeFetch(externalFetch)
  }

  /** Reuses an already-authenticated explicit proxy generation without asking
   * the credential vault for its password on every upstream attempt. */
  public fetchForCached(proxy: PublicProxyDefinition): typeof fetch | undefined {
    if (this.closed) throw new Error('Outbound transport manager is closed.')
    if (this.builtInRoutes.isIntercepting()) {
      return this.routeFetch(this.suspendedExternalFetch(proxy))
    }
    const cached = this.cache.get(proxy.id)
    if (!cached || cached.updatedAt !== proxy.updatedAt) return undefined
    return this.routeFetch(this.handleFor(
      `explicit:${transportHandleKey(proxy, cached.authenticationFingerprint)}`,
      cached
    ).fetchImplementation)
  }

  private routeFetch(externalFetch: typeof fetch): typeof fetch {
    const cached = this.routedFetches.get(externalFetch)
    if (cached) return cached
    const bound = this.builtInRoutes.bind(externalFetch, this.loopbackFetchImplementation)
    const routed = (async (input, init) => {
      if (this.closed) throw new Error('Outbound transport manager is closed.')
      return bound(input, init)
    }) as typeof fetch
    this.routedFetches.set(externalFetch, routed)
    return routed
  }

  /**
   * Keeps explicit proxy construction and credential validation off the hot
   * path while built-in routing is active. If the facade survives an atomic
   * switch back to external routing, it may use an existing authenticated
   * generation or the exact password captured by fetchFor(); it never falls
   * through to DIRECT.
   */
  private suspendedExternalFetch(
    proxy: PublicProxyDefinition,
    password?: string
  ): typeof fetch {
    return (async (input, init) => {
      const cached = this.cache.get(proxy.id)
      const requestedFingerprint = password !== undefined || !proxy.hasPassword
        ? proxyAuthenticationFingerprint(proxy, password)
        : undefined
      const canUseCached = cached?.updatedAt === proxy.updatedAt && (
        requestedFingerprint === undefined
        || cached.authenticationFingerprint === requestedFingerprint
      )
      const externalFetch = canUseCached
        ? this.handleFor(
            `explicit:${transportHandleKey(proxy, cached!.authenticationFingerprint)}`,
            cached!
          ).fetchImplementation
        : this.fetchForResolvedProxy(proxy, password, false)
      return externalFetch(input, init)
    }) as typeof fetch
  }

  private fetchForResolvedProxy(
    proxy: PublicProxyDefinition,
    password: string | undefined,
    system: boolean
  ): typeof fetch {
    if (proxy.hasPassword && !password) throw new Error('Proxy authentication is unavailable from the credential vault.')
    const authenticationFingerprint = proxyAuthenticationFingerprint(proxy, password)
    const cache = system ? this.systemCache : this.cache
    const cached = cache.get(proxy.id)
    if (cached?.updatedAt === proxy.updatedAt && cached.authenticationFingerprint === authenticationFingerprint) {
      return this.handleFor(
        `${system ? 'system' : 'explicit'}:${transportHandleKey(proxy, authenticationFingerprint)}`,
        cached
      ).fetchImplementation
    }
    const generation = this.createGeneration(
      proxy.updatedAt,
      authenticationFingerprint,
      (connections) => createDispatcher(proxy, password, connections)
    )
    cache.set(proxy.id, generation)
    if (cached) this.retire(cached)
    return this.handleFor(
      `${system ? 'system' : 'explicit'}:${transportHandleKey(proxy, authenticationFingerprint)}`,
      generation
    ).fetchImplementation
  }

  public async close(): Promise<void> {
    this.closed = true
    await this.builtInRoutes.close({ force: true })
    await Promise.allSettled(this.systemProxyReloadFlight ? [this.systemProxyReloadFlight] : [])
    const generations = [
      ...this.cache.values(),
      ...this.systemCache.values(),
      ...(this.direct ? [this.direct] : [])
    ]
    this.cache.clear()
    this.systemCache.clear()
    this.direct = undefined
    await Promise.allSettled([...this.rotations.values()])
    this.rotations.clear()
    await Promise.all(generations.map(closeGeneration))
    await Promise.allSettled([...this.retirements])
    this.handles.clear()
    this.systemProxyCache.clear()
  }

  public configureOutboundNetwork(mode: OutboundNetworkMode, localGatewayPort?: number): void {
    const changed = this.outboundNetworkMode !== mode || this.localGatewayPort !== localGatewayPort
    this.outboundNetworkMode = mode
    this.builtInRoutes.setExternalMode(mode)
    this.localGatewayPort = localGatewayPort
    if (localGatewayPort) this.builtInRoutes.addDirectLoopbackPorts([localGatewayPort])
    if (changed) {
      this.invalidateSystemProxyCache()
      this.systemProxyResolutionWarningReported = false
    }
  }

  /**
   * Refresh the operating-system proxy/PAC snapshot for subsequent requests.
   * Chromium owns active session.fetch connections, so reloading its proxy
   * configuration does not cancel a response that is already streaming.
   * Fallback Undici system generations are retired gracefully as well.
   */
  public reloadSystemProxyConfiguration(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Outbound transport manager is closed.'))
    if (this.systemProxyReloadFlight) return this.systemProxyReloadFlight
    const flight = (async () => {
      try {
        if (this.reloadSystemProxy) {
          await withBoundedSystemProxyReload(
            this.reloadSystemProxy(),
            this.systemProxyReloadTimeoutMs
          )
        }
      } finally {
        this.invalidateSystemProxyCache()
        this.systemProxyResolutionWarningReported = false
        const generations = [...this.systemCache.values()]
        this.systemCache.clear()
        for (const generation of generations) this.retire(generation)
      }
    })().finally(() => {
      if (this.systemProxyReloadFlight === flight) this.systemProxyReloadFlight = undefined
    })
    this.systemProxyReloadFlight = flight
    return flight
  }

  public invalidateSystemProxyCache(origin?: string): void {
    if (!origin) {
      this.systemProxyCache.clear()
      return
    }
    const normalizedOrigin = normalizeOrigin(origin)
    for (const target of this.systemProxyCache.keys()) {
      if (normalizeOrigin(target) === normalizedOrigin) this.systemProxyCache.delete(target)
    }
  }

  public async detectSystemProxy(targets: readonly string[]): Promise<SystemProxyDetectionResult> {
    const statuses = await Promise.all(targets.map((target) => this.detectSystemProxyTarget(target)))
    return { detectedAt: this.now(), targets: statuses }
  }

  public async warmFor(
    proxy: PublicProxyDefinition | undefined,
    password: string | undefined,
    origin: string,
    signal: AbortSignal = AbortSignal.timeout(5_000)
  ): Promise<void> {
    if (this.builtInRoutes.shouldDirectLoopback(origin) || (!proxy && isLocalTarget(origin))) {
      await this.warmGeneration(this.generationFor(undefined), normalizeOrigin(origin), signal)
      return
    }
    if (this.builtInRoutes.isIntercepting()) {
      await this.builtInRoutes.warm([origin], signal)
      return
    }
    if (!proxy && this.outboundNetworkMode === 'system' && !isLocalTarget(origin)) {
      if (this.systemProxyFetch) {
        await this.warmNativeSystemProxy(origin, signal)
        return
      }
      const resolution = await this.resolveSystemProxyRoute(origin, true)
      await this.warmSystemProxyChain(resolution.directives, normalizeOrigin(origin), signal)
      return
    }
    const generation = this.generationFor(proxy, password)
    await this.warmGeneration(generation, normalizeOrigin(origin), signal)
  }

  /**
   * Builds and warms a replacement transport before publishing it. Existing
   * streams remain attached to the previous generation until they finish.
   */
  public async rotate(
    proxy?: PublicProxyDefinition,
    password?: string,
    origins: readonly string[] = []
  ): Promise<void> {
    if (this.closed) throw new Error('Outbound transport manager is closed.')
    if (this.builtInRoutes.isIntercepting()) {
      await this.builtInRoutes.rebuild(origins)
      return
    }
    if (proxy?.hasPassword && !password) {
      throw new Error('Proxy authentication is unavailable from the credential vault.')
    }
    if (!proxy && this.outboundNetworkMode === 'system') {
      await this.rebuildSystemProxyOrigins(origins)
      return
    }
    return this.rotateResolved(proxy, password, origins)
  }

  private rotateResolved(
    proxy?: PublicProxyDefinition,
    password?: string,
    origins: readonly string[] = [],
    system = false
  ): Promise<void> {
    // Configuration revisions/authentication fingerprints must not share a
    // rotation flight. An older in-progress rebuild is allowed to finish, but
    // it must not make a caller with newer proxy credentials believe its own
    // generation was rebuilt.
    const key = proxy
      ? `${system ? 'system' : 'explicit'}:${transportHandleKey(proxy, proxyAuthenticationFingerprint(proxy, password))}`
      : 'direct'
    const running = this.rotations.get(key)
    if (running) return running
    const rotation = this.rotateGeneration(proxy, password, origins, system).finally(() => {
      if (this.rotations.get(key) === rotation) this.rotations.delete(key)
    })
    this.rotations.set(key, rotation)
    return rotation
  }

  public rebuild(
    proxy?: PublicProxyDefinition,
    password?: string,
    origins: readonly string[] = []
  ): Promise<void> {
    return this.rotate(proxy, password, origins)
  }

  private generationFor(proxy?: PublicProxyDefinition, password?: string): TransportGeneration {
    if (!proxy) this.directFetch()
    else this.fetchForResolvedProxy(proxy, password, false)
    const generation = proxy ? this.cache.get(proxy.id) : this.direct
    if (!generation) throw new Error('Outbound transport generation was not created.')
    return generation
  }

  private systemGenerationFor(proxy: PublicProxyDefinition): TransportGeneration {
    this.fetchForResolvedProxy(proxy, undefined, true)
    const generation = this.systemCache.get(proxy.id)
    if (!generation) throw new Error('System proxy transport generation was not created.')
    return generation
  }

  private directFetch(): typeof fetch {
    if (!this.direct) this.direct = this.createGeneration(0, '', createDirectDispatcher)
    return this.handleFor('direct', this.direct).fetchImplementation
  }

  private async fetchUsingSystemProxy(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    if (this.systemProxyFetch) return this.fetchUsingNativeSystemProxy(input, init)
    const resolution = await this.resolveSystemProxyRoute(requestUrlOf(input))
    return this.fetchSystemProxyChain(resolution.directives, input, init)
  }

  private async fetchUsingNativeSystemProxy(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    try {
      return await this.systemProxyFetch!(cloneRequestInput(input), init)
    } catch (error) {
      this.invalidateSystemProxyCache(originOf(input))
      throw new Error(
        `System proxy request failed: ${safeTransportFailure(error)}`,
        { cause: error }
      )
    }
  }

  private async fetchSystemProxyChain(
    directives: readonly SystemProxyDirective[],
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    let lastError: unknown
    const replayable = requestCanBeReplayed(input, init)
    for (const directive of directives.length > 0 ? directives : [{ kind: 'direct' } as const]) {
      try {
        const fetchImplementation = directive.kind === 'direct'
          ? this.directFetch()
          : this.fetchForResolvedProxy(directive.proxy, undefined, true)
        return await fetchImplementation(cloneRequestInput(input), init)
      } catch (error) {
        if (requestWasAborted(init?.signal)) throw error
        lastError = error
        if (directive.kind === 'proxy') this.invalidateSystemProxyCache(originOf(input))
        // Never duplicate a one-shot stream body. Gateway/OAuth requests use
        // replayable strings or buffers and may safely advance through PAC
        // fallbacks; arbitrary stream callers fail on the first route instead.
        if (!replayable) break
      }
    }
    const summary = summarizeSystemProxyChain(directives)
    throw new Error(
      `System proxy request failed via ${summary}: ${safeTransportFailure(lastError)}`,
      { cause: lastError }
    )
  }

  private async resolveSystemProxyRoute(target: string, refresh = false): Promise<SystemProxyResolution> {
    const normalizedTarget = new URL(target).toString()
    if (refresh) this.systemProxyCache.delete(normalizedTarget)
    const cached = this.systemProxyCache.get(normalizedTarget)
    if (cached) {
      if (cached.expiresAt > this.now()) return cached.resolution
      this.refreshSystemProxyRoute(normalizedTarget, cached)
      // PAC/system-proxy discovery is control-plane work. Keep an expired route
      // available to hot requests while it is refreshed in the background;
      // explicit invalidation and transport failures delete the entry first and
      // therefore still force the next request to await a fresh resolution.
      return cached.resolution
    }
    const resolution = this.resolveSystemProxyRouteUncached(normalizedTarget)
    this.systemProxyCache.set(normalizedTarget, {
      expiresAt: this.now() + this.systemProxyCacheTtlMs,
      resolution
    })
    return resolution
  }

  private refreshSystemProxyRoute(origin: string, cached: CachedSystemProxyResolution): void {
    if (cached.refreshing) return
    const resolution = this.resolveSystemProxyRouteUncached(origin)
    cached.refreshing = resolution.then((fresh) => {
      if (this.systemProxyCache.get(origin) !== cached) return
      this.systemProxyCache.set(origin, {
        expiresAt: this.now() + this.systemProxyCacheTtlMs,
        resolution: Promise.resolve(fresh)
      })
    }).catch(() => undefined).finally(() => {
      if (this.systemProxyCache.get(origin) === cached) cached.refreshing = undefined
    })
  }

  private async resolveSystemProxyRouteUncached(target: string): Promise<SystemProxyResolution> {
    if (!this.resolveSystemProxy) {
      return this.directSystemProxyFallback('System proxy resolver is unavailable; using DIRECT.')
    }
    try {
      const value = await this.resolveSystemProxy(target)
      const directives = parseSystemProxyChain(value, {
        blockedLoopbackPorts: this.localGatewayPort ? [this.localGatewayPort] : []
      })
      if (directives.length > 0) {
        this.systemProxyResolutionWarningReported = false
        return { directives }
      }
      return this.directSystemProxyFallback('System proxy returned no usable route; using DIRECT.')
    } catch {
      return this.directSystemProxyFallback('System proxy resolution failed; using DIRECT.')
    }
  }

  private directSystemProxyFallback(message: string): SystemProxyResolution {
    if (!this.systemProxyResolutionWarningReported) {
      this.systemProxyResolutionWarningReported = true
      this.onSystemProxyWarning(message)
    }
    return { directives: [{ kind: 'direct' }], warning: message }
  }

  private async warmSystemProxyChain(
    directives: readonly SystemProxyDirective[],
    origin: string,
    signal: AbortSignal
  ): Promise<void> {
    let lastError: unknown
    for (const directive of directives.length > 0 ? directives : [{ kind: 'direct' } as const]) {
      try {
        const generation = directive.kind === 'direct'
          ? this.generationFor(undefined)
          : this.systemGenerationFor(directive.proxy)
        await this.warmGeneration(generation, origin, signal)
        return
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    throw new Error(
      `System proxy warmup failed via ${summarizeSystemProxyChain(directives)}: ${safeTransportFailure(lastError)}`,
      { cause: lastError }
    )
  }

  private async rebuildSystemProxyOrigins(origins: readonly string[]): Promise<void> {
    this.invalidateSystemProxyCache()
    if (this.systemProxyFetch) {
      if (origins.length === 0) return
      const results = await Promise.allSettled([...new Set(origins.map(normalizeTargetUrl))].map((target) =>
        this.warmNativeSystemProxy(target, AbortSignal.timeout(5_000))
      ))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) {
        throw failure.reason
      }
      return
    }
    if (origins.length === 0) {
      await this.rotateResolved(undefined, undefined, [])
      return
    }
    const groups = new Map<string, {
      directive: SystemProxyDirective
      origins: string[]
    }>()
    for (const origin of origins.map(normalizeOrigin)) {
      const resolution = await this.resolveSystemProxyRoute(origin, true)
      for (const directive of resolution.directives.length > 0
        ? resolution.directives
        : [{ kind: 'direct' } as const]) {
        const key = directive.kind === 'direct' ? 'direct' : directive.proxy.id
        const group: { directive: SystemProxyDirective; origins: string[] } = groups.get(key)
          ?? { directive, origins: [] }
        group.origins.push(origin)
        groups.set(key, group)
      }
    }
    const results = await Promise.allSettled([...groups.values()].map(({ directive, origins: targets }) =>
      directive.kind === 'direct'
        ? this.rotateResolved(undefined, undefined, targets)
        : this.rotateResolved(directive.proxy, undefined, targets, true)
    ))
    if (results.length > 0 && results.every((result) => result.status === 'rejected')) {
      throw (results[0] as PromiseRejectedResult).reason
    }
  }

  private async detectSystemProxyTarget(target: string): Promise<SystemProxyTargetStatus> {
    const url = new URL(target).toString()
    const startedAt = this.now()
    const resolution = await this.resolveSystemProxyRoute(url, true)
    const summary = summarizeSystemProxyChain(resolution.directives)
    try {
      const response = this.systemProxyFetch
        ? await this.fetchUsingNativeSystemProxy(url, {
            method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000)
          })
        : await this.fetchSystemProxyChain(
            resolution.directives,
            url,
            { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) }
          )
      cancelResponseBody(response)
      if (response.status === 407) {
        return {
          target: url,
          summary,
          reachable: false,
          latencyMs: Math.max(0, this.now() - startedAt),
          error: 'PROXY_AUTH_REQUIRED'
        }
      }
      return {
        target: url,
        summary,
        reachable: true,
        latencyMs: Math.max(0, this.now() - startedAt),
        ...(resolution.warning ? { error: resolution.warning } : {})
      }
    } catch (error) {
      return {
        target: url,
        summary,
        reachable: false,
        latencyMs: Math.max(0, this.now() - startedAt),
        error: safeTransportFailure(error)
      }
    }
  }

  private async warmNativeSystemProxy(target: string, signal: AbortSignal): Promise<void> {
    // Preserve the full URL for Chromium/PAC. Some PAC files deliberately
    // choose different routes for paths on the same origin.
    const response = await this.fetchUsingNativeSystemProxy(normalizeTargetUrl(target), {
      method: 'HEAD',
      redirect: 'manual',
      signal,
    })
    cancelResponseBody(response)
    if (response.status === 407) throw new Error('System proxy requires authentication.')
  }

  private createGeneration(
    updatedAt: number,
    authenticationFingerprint: string,
    createDispatcher: (connections: number) => Dispatcher
  ): TransportGeneration {
    const generation: TransportGeneration = {
      updatedAt,
      authenticationFingerprint,
      createDispatcher,
      fetchImplementation: undefined as unknown as typeof fetch,
      originPools: new Map(),
      warmups: new Map()
    }
    generation.fetchImplementation = (async (input, init) => {
      const origin = originOf(input)
      const pool = this.originPoolFor(generation, origin)
      pool.usedByApplication = true
      // A real request never waits for a speculative HEAD. Both use the same
      // origin-scoped dispatcher, so a slow warmup can open another connection
      // without creating a second, unrelated TLS/session pool.
      return pool.fetchImplementation(input, init)
    }) as typeof fetch
    return generation
  }

  private originPoolFor(generation: TransportGeneration, origin: string): OriginTransportPool {
    const existing = generation.originPools.get(origin)
    if (existing) return existing
    const connections = normalizeConnectionCount(this.connectionCountForOrigin(origin))
    const dispatcher = generation.createDispatcher(connections)
    const pool: OriginTransportPool = {
      dispatcher,
      fetchImplementation: fetchWithDispatcher(dispatcher),
      usedByApplication: false,
      warmed: false
    }
    generation.originPools.set(origin, pool)
    return pool
  }

  private handleFor(key: string, generation: TransportGeneration): TransportHandle {
    const existing = this.handles.get(key)
    if (existing) {
      existing.generation = generation
      return existing
    }
    const handle: TransportHandle = {
      generation,
      fetchImplementation: undefined as unknown as typeof fetch
    }
    handle.fetchImplementation = (async (input, init) => {
      if (this.closed) throw new Error('Outbound transport manager is closed.')
      return handle.generation.fetchImplementation(input, init)
    }) as typeof fetch
    this.handles.set(key, handle)
    return handle
  }

  private warmGeneration(
    generation: TransportGeneration,
    origin: string,
    signal: AbortSignal
  ): Promise<void> {
    const pool = this.originPoolFor(generation, origin)
    if (pool.warmed) return Promise.resolve()
    const running = generation.warmups.get(origin)
    if (running) return running
    const warmup = this.warmOriginPool(generation, origin, pool, signal).finally(() => {
      if (generation.warmups.get(origin) === warmup) generation.warmups.delete(origin)
    })
    generation.warmups.set(origin, warmup)
    return warmup
  }

  private async warmOriginPool(
    generation: TransportGeneration,
    origin: string,
    pool: OriginTransportPool,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const response = await pool.fetchImplementation(new URL('/', origin), {
        method: 'HEAD',
        redirect: 'manual',
        signal
      })
      await response.arrayBuffer()
      pool.warmed = true
    } catch (error) {
      // A request may have started on this pool while the speculative HEAD was
      // in flight. Never close the shared dispatcher underneath that request.
      // An unused failed pool is removed so a later warmup/request gets a clean
      // dispatcher rather than retaining a failed connector indefinitely.
      if (!pool.usedByApplication && generation.originPools.get(origin) === pool) {
        generation.originPools.delete(origin)
        await pool.dispatcher.close().catch(() => undefined)
      }
      throw error
    }
  }

  private async rotateGeneration(
    proxy: PublicProxyDefinition | undefined,
    password: string | undefined,
    origins: readonly string[],
    system: boolean
  ): Promise<void> {
    const cache = system ? this.systemCache : this.cache
    const previous = proxy ? cache.get(proxy.id) : this.direct
    const authenticationFingerprint = proxy
      ? proxyAuthenticationFingerprint(proxy, password)
      : ''
    const replacement = this.createGeneration(
      proxy?.updatedAt ?? 0,
      authenticationFingerprint,
      proxy ? (connections) => createDispatcher(proxy, password, connections) : createDirectDispatcher
    )
    try {
      const targets = new Set([
        ...(previous ? previous.originPools.keys() : []),
        ...(previous ? previous.warmups.keys() : []),
        ...origins.map(normalizeOrigin)
      ])
      await Promise.all([...targets].map((origin) =>
        this.warmGeneration(replacement, origin, AbortSignal.timeout(5_000))
      ))
    } catch (error) {
      await closeGeneration(replacement)
      throw error
    }
    const current = proxy ? cache.get(proxy.id) : this.direct
    if (this.closed || current !== previous) {
      await closeGeneration(replacement)
      return
    }
    if (proxy) cache.set(proxy.id, replacement)
    else this.direct = replacement
    this.handleFor(
      proxy
        ? `${system ? 'system' : 'explicit'}:${transportHandleKey(proxy, authenticationFingerprint)}`
        : 'direct',
      replacement
    )
    if (previous) this.retire(previous)
  }

  private retire(generation: TransportGeneration): void {
    // A new proxy revision gets a distinct handle key. Drop handles that still
    // point at the retired generation so repeated edits cannot grow the map
    // forever. In-flight callers retain their closure over the handle object;
    // deleting the lookup entry does not interrupt those requests.
    for (const [key, handle] of this.handles) {
      if (handle.generation === generation) this.handles.delete(key)
    }
    const retirement = closeGeneration(generation).finally(() => {
      this.retirements.delete(retirement)
    })
    this.retirements.add(retirement)
    void retirement.catch(() => undefined)
  }
}

function createDirectDispatcher(connections: number): Dispatcher {
  return new Agent({
    connections,
    pipelining: 1,
    allowH2: true,
    pingInterval: OUTBOUND_H2_PING_INTERVAL_MS,
    keepAliveTimeout: OUTBOUND_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: OUTBOUND_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connectTimeout: OUTBOUND_CONNECT_TIMEOUT_MS,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250
  })
}

function fetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof fetch
}

async function closeGeneration(generation: TransportGeneration): Promise<void> {
  await Promise.allSettled([...generation.warmups.values()])
  const dispatchers = [...generation.originPools.values()].map(({ dispatcher }) => dispatcher)
  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)))
}

function proxyAuthenticationFingerprint(proxy: PublicProxyDefinition, password?: string): string {
  return createHash('sha256')
    .update(`${proxy.username ?? ''}\0${password ?? ''}`)
    .digest('hex')
}

function transportHandleKey(proxy: PublicProxyDefinition, authenticationFingerprint: string): string {
  return `proxy:${proxy.id}:${proxy.updatedAt}:${authenticationFingerprint}`
}

function originOf(input: Parameters<typeof fetch>[0]): string {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input).origin
    return new URL(input.url).origin
  } catch {
    return ''
  }
}

function requestUrlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return new URL(input).toString()
  if (input instanceof URL) return input.toString()
  return new URL(input.url).toString()
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin
}

function normalizeTargetUrl(target: string): string {
  return new URL(target).toString()
}

function requestWasAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true
}

function requestCanBeReplayed(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): boolean {
  const body = init?.body
  if (body === undefined || body === null) return true
  if (typeof body === 'string' || body instanceof URLSearchParams || body instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(body)) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  // A Request input can be cloned for each attempt only when init does not
  // replace it with a one-shot body, handled by the cases above.
  return false
}

function cloneRequestInput(input: Parameters<typeof fetch>[0]): Parameters<typeof fetch>[0] {
  return typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input
}

function safeTransportFailure(error: unknown): string {
  const chain = transportErrorChain(error)
  // Prefer structured codes, including those on nested socket causes, over a
  // Chromium wrapper such as net::ERR_FAILED in an outer error message.
  const code = chain.map(explicitTransportErrorCode).find((candidate): candidate is string => Boolean(candidate))
    ?? chain.map(messageTransportErrorCode).find((candidate): candidate is string => Boolean(candidate))
  if (chain.some((candidate) => (
    candidate instanceof DOMException && candidate.name === 'TimeoutError'
  ) || (
    candidate instanceof Error && /timeout/i.test(`${candidate.name} ${candidate.message}`)
  )) || code && /(?:^|_)TIMEOUT(?:_|$)|ETIMEDOUT/i.test(code)) {
    return code ? `connection timed out (${code})` : 'connection timed out'
  }
  if (chain.some((candidate) => candidate instanceof Error && /abort/i.test(`${candidate.name} ${candidate.message}`))) {
    return 'request was aborted'
  }
  if (code && /ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return `DNS resolution failed (${code})`
  if (code && /CERT|TLS|SSL|SELF_SIGNED/i.test(code)) return `TLS/certificate validation failed (${code})`
  if (code && /ECONNREFUSED/i.test(code)) return `connection was refused (${code})`
  if (code && /ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code)) return `connection was reset (${code})`
  if (code) return `connection failed (${code})`
  return 'connection failed'
}

function transportErrorChain(error: unknown, maximumDepth = 6): unknown[] {
  const chain: unknown[] = []
  const visited = new Set<object>()
  let current = error
  while (chain.length < maximumDepth && current !== undefined && current !== null) {
    chain.push(current)
    if (typeof current !== 'object' || visited.has(current)) break
    visited.add(current)
    current = 'cause' in current ? current.cause : undefined
  }
  return chain
}

function explicitTransportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string') {
    return sanitizeTransportErrorCode(error.code)
  }
  return undefined
}

function messageTransportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('message' in error && typeof error.message === 'string') {
    const match = /\b((?:ERR_|UND_ERR_)[A-Z0-9_]+)\b/i.exec(error.message)
    return match ? sanitizeTransportErrorCode(match[1]) : undefined
  }
  return undefined
}

function sanitizeTransportErrorCode(value: string): string | undefined {
  const normalized = value.trim().toUpperCase()
  return /^[A-Z0-9_]{2,80}$/.test(normalized) ? normalized : undefined
}

function cancelResponseBody(response: Response): void {
  // The response status is already available. Initiate cancellation, but never
  // let a transport whose cancel promise does not settle hold up diagnostics,
  // warmup, shutdown, or the next real request.
  void response.body?.cancel().catch(() => undefined)
}

function withBoundedSystemProxyReload(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(
        new Error(`System proxy configuration reload timed out after ${timeoutMs} ms.`),
        { code: 'SYSTEM_PROXY_RELOAD_TIMEOUT' }
      ))
    }, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function normalizeConnectionCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTBOUND_CONNECTION_BUDGET
  return Math.max(1, Math.trunc(value))
}

function defaultConnectionCountForOrigin(_origin: string): number {
  return DEFAULT_OUTBOUND_CONNECTION_BUDGET
}

export function resolveEffectiveProxy(
  account: Pick<Account, 'proxyId'>,
  pool: Pick<Pool, 'proxyId'> | undefined,
  proxies: readonly PublicProxyDefinition[]
): PublicProxyDefinition | undefined {
  const proxyId = account.proxyId ?? pool?.proxyId
  if (!proxyId) return undefined
  const proxy = proxies.find((candidate) => candidate.id === proxyId)
  if (!proxy) throw new Error('The configured proxy no longer exists.')
  return proxy
}

export function proxyEntryAddress(proxy: PublicProxyDefinition): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${host}:${proxy.port}`
}

export async function probeProxy(
  transport: OutboundTransportManager,
  proxy: PublicProxyDefinition,
  password?: string,
  signal = AbortSignal.timeout(15_000)
): Promise<ProxyProbeResult> {
  const fetchImplementation = transport.fetchFor(proxy, password)
  let lastError: unknown
  for (const target of PROBE_TARGETS) {
    const startedAt = Date.now()
    try {
      const response = await fetchImplementation(target.url, {
        method: 'GET',
        headers: { accept: target.parse === parseJsonIp ? 'application/json' : 'text/plain' },
        redirect: 'error',
        signal
      })
      if (!response.ok) throw new Error(`Probe returned HTTP ${response.status}`)
      const body = await readLimitedText(response, 16 * 1024)
      const exitIp = target.parse(body)
      if (!exitIp) throw new Error('Probe response did not contain a public IP address')
      return { exitIp, latencyMs: Math.max(0, Date.now() - startedAt) }
    } catch (error) {
      lastError = error
      if (signal.aborted) break
    }
  }
  throw new Error(proxyProbeErrorMessage(lastError))
}

function createDispatcher(
  proxy: PublicProxyDefinition,
  password: string | undefined,
  connections: number
): Dispatcher {
  if (proxy.hasPassword && !password) throw new Error('Proxy authentication is unavailable from the credential vault.')
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
    return socksDispatcher(
      {
        type: proxy.protocol === 'socks4' ? 4 : 5,
        host: proxy.host,
        port: proxy.port,
        ...(proxy.username ? { userId: proxy.username } : {}),
        ...(password ? { password } : {})
      },
      {
        connections,
        pipelining: 1,
        allowH2: true,
        pingInterval: OUTBOUND_H2_PING_INTERVAL_MS,
        keepAliveTimeout: OUTBOUND_KEEP_ALIVE_TIMEOUT_MS,
        keepAliveMaxTimeout: OUTBOUND_KEEP_ALIVE_MAX_TIMEOUT_MS,
        connect: {
          allowH2: true,
          timeout: OUTBOUND_CONNECT_TIMEOUT_MS
        }
      }
    )
  }

  const uri = new URL(proxyEntryAddress(proxy))
  if (proxy.username) uri.username = proxy.username
  if (password) uri.password = password
  return new ProxyAgent({
    uri: uri.toString(),
    connections,
    pipelining: 1,
    allowH2: true,
    pingInterval: OUTBOUND_H2_PING_INTERVAL_MS,
    keepAliveTimeout: OUTBOUND_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: OUTBOUND_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connectTimeout: OUTBOUND_CONNECT_TIMEOUT_MS,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    requestTls: {
      allowH2: true,
      timeout: OUTBOUND_CONNECT_TIMEOUT_MS,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250
    },
    proxyTls: {
      timeout: OUTBOUND_CONNECT_TIMEOUT_MS,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250
    }
  })
}

async function readLimitedText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new Error('Proxy probe response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function parseJsonIp(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as { ip?: unknown }
    return validIp(parsed.ip)
  } catch {
    return undefined
  }
}

function parseTextIp(value: string): string | undefined {
  return validIp(value.trim().split(/[\s,]/)[0])
}

function validIp(value: unknown): string | undefined {
  return typeof value === 'string' && isIP(value) > 0 ? value : undefined
}

function proxyProbeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Proxy probe timed out.'
  if (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)) return 'Proxy probe timed out.'
  return 'Proxy could not reach an external IP service.'
}
