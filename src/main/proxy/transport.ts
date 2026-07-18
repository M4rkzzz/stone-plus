import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { socksDispatcher } from 'fetch-socks'
import type { Account, Pool, PublicProxyDefinition } from '@shared/types'

const PROBE_TARGETS = [
  { url: 'https://api.ipify.org?format=json', parse: parseJsonIp },
  { url: 'https://icanhazip.com', parse: parseTextIp }
] as const

interface CachedDispatcher {
  updatedAt: number
  authenticationFingerprint: string
  dispatcher: Dispatcher
  fetchImplementation: typeof fetch
}

export interface ProxyProbeResult {
  exitIp: string
  latencyMs: number
}

export class OutboundTransportManager {
  private readonly cache = new Map<string, CachedDispatcher>()
  private direct?: Pick<CachedDispatcher, 'dispatcher' | 'fetchImplementation'>

  public fetchFor(proxy: PublicProxyDefinition | undefined, password?: string): typeof fetch {
    if (!proxy) {
      if (!this.direct) {
        const dispatcher = new Agent({
          connections: 16,
          pipelining: 1,
          allowH2: true,
          keepAliveTimeout: 60_000,
          keepAliveMaxTimeout: 10 * 60_000,
          connect: {
            timeout: 10_000,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 250
          }
        })
        this.direct = { dispatcher, fetchImplementation: fetchWithDispatcher(dispatcher) }
      }
      return this.direct.fetchImplementation
    }
    if (proxy.hasPassword && !password) throw new Error('Proxy authentication is unavailable from the credential vault.')
    const authenticationFingerprint = createHash('sha256')
      .update(`${proxy.username ?? ''}\0${password ?? ''}`)
      .digest('hex')
    const cached = this.cache.get(proxy.id)
    if (cached?.updatedAt === proxy.updatedAt && cached.authenticationFingerprint === authenticationFingerprint) {
      return cached.fetchImplementation
    }
    if (cached) void cached.dispatcher.close().catch(() => undefined)

    const dispatcher = createDispatcher(proxy, password)
    const fetchImplementation = fetchWithDispatcher(dispatcher)
    this.cache.set(proxy.id, { updatedAt: proxy.updatedAt, authenticationFingerprint, dispatcher, fetchImplementation })
    return fetchImplementation
  }

  public async close(): Promise<void> {
    const dispatchers = [
      ...[...this.cache.values()].map(({ dispatcher }) => dispatcher),
      ...(this.direct ? [this.direct.dispatcher] : [])
    ]
    this.cache.clear()
    this.direct = undefined
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)))
  }
}

function fetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof fetch
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

function createDispatcher(proxy: PublicProxyDefinition, password?: string): Dispatcher {
  if (proxy.hasPassword && !password) throw new Error('Proxy authentication is unavailable from the credential vault.')
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
    return socksDispatcher({
      type: proxy.protocol === 'socks4' ? 4 : 5,
      host: proxy.host,
      port: proxy.port,
      ...(proxy.username ? { userId: proxy.username } : {}),
      ...(password ? { password } : {})
    })
  }

  const uri = new URL(proxyEntryAddress(proxy))
  if (proxy.username) uri.username = proxy.username
  if (password) uri.password = password
  return new ProxyAgent({ uri: uri.toString() })
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
