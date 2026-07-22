import type { Session } from 'electron'
import { isLoopbackHostname } from '../system-proxy'

const DEFAULT_PROXY_RELOAD_TIMEOUT_MS = 5_000
const BUILT_IN_PROXY_BYPASS_RULES = '<local>,localhost,127.0.0.1,127.0.0.0/8,[::1]'

export interface ChromiumMixedSessionGeneration {
  fetchImplementation: typeof fetch
  mixedEndpoint: string
  refresh(): Promise<void>
  dispose(): Promise<void>
}

export interface ChromiumMixedSessionOptions {
  mixedEndpoint: string
  /** A fresh, non-persistent Electron session must be returned for every call. */
  createSession(): Session
  reloadTimeoutMs?: number
}

/**
 * Creates one Stone+-only Chromium proxy generation. A generation never
 * changes its mixed endpoint; route-coordinator retirement closes its
 * connections only after all requests captured by that generation drain.
 */
export async function createChromiumMixedSessionGeneration(
  options: ChromiumMixedSessionOptions,
): Promise<ChromiumMixedSessionGeneration> {
  const endpoint = normalizeMixedEndpoint(options.mixedEndpoint)
  const electronSession = options.createSession()
  const reloadTimeoutMs = Math.max(1, options.reloadTimeoutMs ?? DEFAULT_PROXY_RELOAD_TIMEOUT_MS)
  let disposed = false

  const applyProxy = async (): Promise<void> => {
    if (disposed) throw new Error('The built-in Chromium proxy generation is closed.')
    await electronSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: endpoint,
      proxyBypassRules: BUILT_IN_PROXY_BYPASS_RULES,
    })
    await bounded(electronSession.forceReloadProxyConfig(), reloadTimeoutMs, 'Chromium proxy reload')
    const resolution = await bounded(
      electronSession.resolveProxy('https://stone.invalid/'),
      reloadTimeoutMs,
      'Chromium proxy verification',
    )
    if (!routesToMixed(resolution, endpoint)) {
      throw new Error(`The Stone+ Chromium session did not resolve through its mixed endpoint (${resolution || 'empty result'}).`)
    }
  }

  try {
    await applyProxy()
  } catch (error) {
    await electronSession.closeAllConnections().catch(() => undefined)
    throw error
  }

  const fetchImplementation = ((input, init) => electronSession.fetch(
    input instanceof URL ? input.toString() : input,
    { ...init, bypassCustomProtocolHandlers: true },
  )) as typeof fetch

  return {
    mixedEndpoint: endpoint,
    fetchImplementation,
    refresh: async () => {
      if (disposed) throw new Error('The built-in Chromium proxy generation is closed.')
      await electronSession.closeAllConnections()
      await applyProxy()
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      await electronSession.closeAllConnections().catch(() => undefined)
      // This is a private in-memory partition. Resetting it prevents an
      // accidentally retained reference from sending traffic to a stopped
      // mixed listener; it does not touch the user's system proxy setting.
      await electronSession.setProxy({ mode: 'direct' }).catch(() => undefined)
    },
  }
}

function normalizeMixedEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The built-in mixed endpoint is invalid.')
  }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:'
    || !isLoopbackHostname(url.hostname)
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    throw new Error('The built-in mixed endpoint must be an unauthenticated loopback HTTP origin with an explicit port.')
  }
  return `http://${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${port}`
}

function routesToMixed(resolution: string, endpoint: string): boolean {
  const url = new URL(endpoint)
  const expectedHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const expectedPort = url.port
  return resolution.split(';').some((rawDirective) => {
    const directive = rawDirective.trim()
    const match = /^(?:PROXY|HTTPS|SOCKS|SOCKS5)\s+(.+):(\d+)$/i.exec(directive)
    if (!match) return false
    const host = match[1].replace(/^\[|\]$/g, '').toLowerCase()
    return host === expectedHost && match[2] === expectedPort
  })
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const BUILT_IN_CHROMIUM_PROXY_BYPASS_RULES = BUILT_IN_PROXY_BYPASS_RULES
