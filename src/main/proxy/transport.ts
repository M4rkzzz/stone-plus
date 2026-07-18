import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { socksDispatcher } from 'fetch-socks'
import type { Account, Pool, PublicProxyDefinition } from '@shared/types'

const PROBE_TARGETS = [
  { url: 'https://api.ipify.org?format=json', parse: parseJsonIp },
  { url: 'https://icanhazip.com', parse: parseTextIp }
] as const
// Warm origin lanes deliberately own one connection each. Four lazy lanes can
// therefore carry four simultaneous HTTP/1.1 streams, while HTTP/2 can
// multiplex more work on each connection. The fallback remains wider so an
// un-warmed/custom origin does not become artificially serialized.
const OUTBOUND_LANE_CONNECTIONS = 1
const OUTBOUND_FALLBACK_CONNECTIONS = 4
const OUTBOUND_CONNECT_TIMEOUT_MS = 10_000
const OUTBOUND_KEEP_ALIVE_TIMEOUT_MS = 5 * 60_000
const OUTBOUND_KEEP_ALIVE_MAX_TIMEOUT_MS = 10 * 60_000
const OUTBOUND_H2_PING_INTERVAL_MS = 30_000
const OPPORTUNISTIC_WARM_WAIT_MS = 100

interface TransportGeneration {
  updatedAt: number
  authenticationFingerprint: string
  createDispatcher: (connections: number) => Dispatcher
  fallbackDispatcher: Dispatcher
  fetchImplementation: typeof fetch
  originPools: Map<string, OriginLanePool>
  warmups: Map<string, Promise<void>>
}

interface OriginLane {
  dispatcher: Dispatcher
  fetchImplementation: typeof fetch
  busy: number
}

interface OriginLanePool {
  lanes: OriginLane[]
  cursor: number
  maximumLanes: number
  createLane: () => OriginLane
}

interface TransportHandle {
  generation: TransportGeneration
  fetchImplementation: typeof fetch
}

export interface OutboundTransportManagerOptions {
  laneCountForOrigin?: (origin: string) => number
}

export interface ProxyProbeResult {
  exitIp: string
  latencyMs: number
}

export class OutboundTransportManager {
  private readonly cache = new Map<string, TransportGeneration>()
  private readonly rotations = new Map<string, Promise<void>>()
  private readonly retirements = new Set<Promise<void>>()
  private readonly handles = new Map<string, TransportHandle>()
  private readonly laneCountForOrigin: (origin: string) => number
  private direct?: TransportGeneration
  private closed = false

  constructor(options: OutboundTransportManagerOptions = {}) {
    this.laneCountForOrigin = options.laneCountForOrigin ?? defaultLaneCountForOrigin
  }

  public fetchFor(proxy: PublicProxyDefinition | undefined, password?: string): typeof fetch {
    if (this.closed) throw new Error('Outbound transport manager is closed.')
    if (!proxy) {
      if (!this.direct) this.direct = this.createGeneration(0, '', createDirectDispatcher)
      return this.handleFor('direct', this.direct).fetchImplementation
    }
    if (proxy.hasPassword && !password) throw new Error('Proxy authentication is unavailable from the credential vault.')
    const authenticationFingerprint = proxyAuthenticationFingerprint(proxy, password)
    const cached = this.cache.get(proxy.id)
    if (cached?.updatedAt === proxy.updatedAt && cached.authenticationFingerprint === authenticationFingerprint) {
      return this.handleFor(transportHandleKey(proxy, authenticationFingerprint), cached).fetchImplementation
    }
    const generation = this.createGeneration(
      proxy.updatedAt,
      authenticationFingerprint,
      (connections) => createDispatcher(proxy, password, connections)
    )
    this.cache.set(proxy.id, generation)
    if (cached) this.retire(cached)
    return this.handleFor(transportHandleKey(proxy, authenticationFingerprint), generation).fetchImplementation
  }

  public async close(): Promise<void> {
    this.closed = true
    const generations = [...this.cache.values(), ...(this.direct ? [this.direct] : [])]
    this.cache.clear()
    this.direct = undefined
    await Promise.allSettled([...this.rotations.values()])
    this.rotations.clear()
    await Promise.all(generations.map(closeGeneration))
    await Promise.allSettled([...this.retirements])
    this.handles.clear()
  }

  public async warmFor(
    proxy: PublicProxyDefinition | undefined,
    password: string | undefined,
    origin: string,
    signal: AbortSignal = AbortSignal.timeout(5_000)
  ): Promise<void> {
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
    if (proxy?.hasPassword && !password) {
      throw new Error('Proxy authentication is unavailable from the credential vault.')
    }
    // Configuration revisions/authentication fingerprints must not share a
    // rotation flight. An older in-progress rebuild is allowed to finish, but
    // it must not make a caller with newer proxy credentials believe its own
    // generation was rebuilt.
    const key = proxy
      ? transportHandleKey(proxy, proxyAuthenticationFingerprint(proxy, password))
      : 'direct'
    const running = this.rotations.get(key)
    if (running) return running
    const rotation = this.rotateGeneration(proxy, password, origins).finally(() => {
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
    this.fetchFor(proxy, password)
    const generation = proxy ? this.cache.get(proxy.id) : this.direct
    if (!generation) throw new Error('Outbound transport generation was not created.')
    return generation
  }

  private createGeneration(
    updatedAt: number,
    authenticationFingerprint: string,
    createDispatcher: (connections: number) => Dispatcher
  ): TransportGeneration {
    const fallbackDispatcher = createDispatcher(OUTBOUND_FALLBACK_CONNECTIONS)
    const generation: TransportGeneration = {
      updatedAt,
      authenticationFingerprint,
      createDispatcher,
      fallbackDispatcher,
      fetchImplementation: undefined as unknown as typeof fetch,
      originPools: new Map(),
      warmups: new Map()
    }
    const fallbackFetch = fetchWithDispatcher(fallbackDispatcher)
    generation.fetchImplementation = (async (input, init) => {
      const origin = originOf(input)
      const warming = generation.warmups.get(origin)
      // Warming is speculative: a failed/slow HEAD request must never fail or
      // stall the real POST on the gateway hot path. Give it only a very small
      // chance to finish, then use the generation's fallback dispatcher.
      if (warming) await waitForOpportunisticWarmup(warming)
      const pool = generation.originPools.get(origin)
      if (!pool) return fallbackFetch(input, init)
      return fetchThroughLane(selectLane(pool), input, init)
    }) as typeof fetch
    return generation
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
    if (generation.originPools.has(origin)) return Promise.resolve()
    const running = generation.warmups.get(origin)
    if (running) return running
    const warmup = this.createAndWarmOriginPool(generation, origin, signal).finally(() => {
      if (generation.warmups.get(origin) === warmup) generation.warmups.delete(origin)
    })
    generation.warmups.set(origin, warmup)
    return warmup
  }

  private async createAndWarmOriginPool(
    generation: TransportGeneration,
    origin: string,
    signal: AbortSignal
  ): Promise<void> {
    const maximumLanes = clampLaneCount(this.laneCountForOrigin(origin))
    const createLane = (): OriginLane => {
      const dispatcher = generation.createDispatcher(OUTBOUND_LANE_CONNECTIONS)
      return { dispatcher, fetchImplementation: fetchWithDispatcher(dispatcher), busy: 0 }
    }
    // Warm only the stable primary lane. Additional lanes are a concurrency
    // escape hatch and are created lazily only while every existing lane is
    // carrying a response body. This keeps sequential Codex turns on one hot
    // H2/TLS session instead of round-robining them across four sessions.
    const primary = createLane()
    try {
      const response = await primary.fetchImplementation(new URL('/', origin), {
        method: 'HEAD',
        redirect: 'manual',
        signal
      })
      await response.arrayBuffer()
      generation.originPools.set(origin, {
        lanes: [primary],
        cursor: 0,
        maximumLanes,
        createLane
      })
    } catch (error) {
      await primary.dispatcher.close().catch(() => undefined)
      throw error
    }
  }

  private async rotateGeneration(
    proxy: PublicProxyDefinition | undefined,
    password: string | undefined,
    origins: readonly string[]
  ): Promise<void> {
    const previous = proxy ? this.cache.get(proxy.id) : this.direct
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
    const current = proxy ? this.cache.get(proxy.id) : this.direct
    if (this.closed || current !== previous) {
      await closeGeneration(replacement)
      return
    }
    if (proxy) this.cache.set(proxy.id, replacement)
    else this.direct = replacement
    this.handleFor(
      proxy ? transportHandleKey(proxy, authenticationFingerprint) : 'direct',
      replacement
    )
    if (previous) this.retire(previous)
  }

  private retire(generation: TransportGeneration): void {
    const retirement = closeGeneration(generation).finally(() => {
      this.retirements.delete(retirement)
    })
    this.retirements.add(retirement)
    void retirement.catch(() => undefined)
  }
}

async function waitForOpportunisticWarmup(warming: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      warming.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OPPORTUNISTIC_WARM_WAIT_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
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

function selectLane(pool: OriginLanePool): OriginLane {
  const primary = pool.lanes[0]
  if (primary.busy === 0) return primary

  // Once a primary stream is active, reuse an already-created idle backup.
  // Prefer the least-recent candidate so simultaneous requests spread across
  // the available lanes without disturbing sequential primary affinity.
  for (let offset = 1; offset <= pool.lanes.length; offset += 1) {
    const index = (pool.cursor + offset) % pool.lanes.length
    if (index === 0 || pool.lanes[index].busy !== 0) continue
    pool.cursor = index
    return pool.lanes[index]
  }

  // A cold backup is cheaper than queueing behind a long streaming response,
  // but it should not exist until real concurrency demonstrates a need for it.
  if (pool.lanes.length < pool.maximumLanes) {
    const lane = pool.createLane()
    pool.lanes.push(lane)
    pool.cursor = pool.lanes.length - 1
    return lane
  }

  const minimumBusy = Math.min(...pool.lanes.map(({ busy }) => busy))
  for (let offset = 0; offset < pool.lanes.length; offset += 1) {
    const index = (pool.cursor + offset) % pool.lanes.length
    if (pool.lanes[index].busy !== minimumBusy) continue
    pool.cursor = (index + 1) % pool.lanes.length
    return pool.lanes[index]
  }
  return pool.lanes[0]
}

async function fetchThroughLane(
  lane: OriginLane,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  lane.busy += 1
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    lane.busy = Math.max(0, lane.busy - 1)
  }
  try {
    const response = await lane.fetchImplementation(input, init)
    if (!response.body) {
      release()
      return response
    }
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            release()
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      }
    })
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
    // Reconstructing the body lets lane occupancy follow the whole stream;
    // retain the observable fetch metadata that ResponseInit cannot express.
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type }
    })
    return wrapped
  } catch (error) {
    release()
    throw error
  }
}

async function closeGeneration(generation: TransportGeneration): Promise<void> {
  await Promise.allSettled([...generation.warmups.values()])
  const dispatchers = [
    generation.fallbackDispatcher,
    ...[...generation.originPools.values()].flatMap(({ lanes }) => lanes.map(({ dispatcher }) => dispatcher))
  ]
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

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin
}

function clampLaneCount(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(4, Math.trunc(value)))
}

function defaultLaneCountForOrigin(origin: string): number {
  const hostname = new URL(origin).hostname.toLowerCase()
  if (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) return 4
  if (hostname === 'api.openai.com' || hostname.endsWith('.openai.com')) return 2
  if (hostname === 'api.anthropic.com' || hostname === 'generativelanguage.googleapis.com') return 2
  return 1
}

export function resolveEffectiveProxy(
  account: Pick<Account, 'proxyId'>,
  pool: Pick<Pool, 'proxyId'> | undefined,
  proxies: readonly PublicProxyDefinition[]
): PublicProxyDefinition | undefined {
  const proxyId = account.proxyId ?? pool?.proxyId
  if (!proxyId) return undefined
  const proxy = proxies.find((candidate) => candidate.id === proxyId)
  if (!proxy) throw new Error('The configured outbound proxy no longer exists.')
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
