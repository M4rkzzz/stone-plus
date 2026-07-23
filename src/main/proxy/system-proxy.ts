import { isIP } from 'node:net'
import type { ProxyProtocol, PublicProxyDefinition } from '@shared/types'

export type SystemProxyDirective =
  | { kind: 'direct' }
  | { kind: 'proxy'; proxy: PublicProxyDefinition; summary: string }

export interface ParseSystemProxyOptions {
  blockedLoopbackPorts?: readonly number[]
}

/** Parse Chromium/Electron resolveProxy output without retaining credentials. */
export function parseSystemProxyChain(
  value: string,
  options: ParseSystemProxyOptions = {}
): SystemProxyDirective[] {
  const directives: SystemProxyDirective[] = []
  const seen = new Set<string>()
  for (const raw of value.split(';')) {
    const token = raw.trim()
    if (!token) continue
    if (/^DIRECT$/i.test(token)) {
      if (!seen.has('direct')) {
        seen.add('direct')
        directives.push({ kind: 'direct' })
      }
      continue
    }
    const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i.exec(token)
    if (!match) continue
    const protocol = proxyProtocol(match[1])
    const endpoint = parseProxyEndpoint(match[2], protocol)
    if (!endpoint) continue
    if (
      isLoopbackHostname(endpoint.host)
      && options.blockedLoopbackPorts?.includes(endpoint.port)
    ) continue
    const key = `${protocol}:${endpoint.host.toLowerCase()}:${endpoint.port}`
    if (seen.has(key)) continue
    seen.add(key)
    const timestamp = 0
    directives.push({
      kind: 'proxy',
      summary: `${proxySummaryProtocol(protocol)} ${formatHost(endpoint.host)}:${endpoint.port}`,
      proxy: {
        id: `__stone_system_proxy__:${key}`,
        name: 'System proxy',
        protocol,
        host: endpoint.host,
        port: endpoint.port,
        hasPassword: false,
        status: 'unchecked',
        createdAt: timestamp,
        updatedAt: timestamp
      }
    })
  }
  return directives
}

export function summarizeSystemProxyChain(directives: readonly SystemProxyDirective[]): string {
  if (directives.length === 0) return 'DIRECT'
  return directives.map((directive) => directive.kind === 'direct' ? 'DIRECT' : directive.summary).join(' → ')
}

export function isLocalTarget(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
    return isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  return false
}

function proxyProtocol(keyword: string): ProxyProtocol {
  switch (keyword.toUpperCase()) {
    case 'HTTPS': return 'https'
    case 'SOCKS':
    case 'SOCKS4': return 'socks4'
    case 'SOCKS5': return 'socks5'
    default: return 'http'
  }
}

function parseProxyEndpoint(value: string, protocol: ProxyProtocol): { host: string; port: number } | undefined {
  try {
    // URL parsing safely strips any accidental userinfo from the result. The
    // returned public definition never stores or displays it.
    const url = new URL(`${protocol === 'socks4' || protocol === 'socks5' ? 'http' : protocol}://${value.trim()}`)
    const port = Number(url.port || defaultProxyPort(protocol))
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return undefined
  }
}

function defaultProxyPort(protocol: ProxyProtocol): number {
  if (protocol === 'https') return 443
  if (protocol === 'socks4' || protocol === 'socks5') return 1080
  return 80
}

function proxySummaryProtocol(protocol: ProxyProtocol): string {
  if (protocol === 'http') return 'HTTP'
  if (protocol === 'https') return 'HTTPS'
  if (protocol === 'socks4') return 'SOCKS4'
  return 'SOCKS5'
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}
