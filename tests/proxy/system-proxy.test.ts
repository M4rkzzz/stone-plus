import { describe, expect, it } from 'vitest'
import {
  isLocalTarget,
  parseSystemProxyChain,
  summarizeSystemProxyChain
} from '../../src/main/proxy'

describe('system proxy PAC parsing', () => {
  it('preserves an ordered mixed proxy chain and DIRECT fallback', () => {
    const chain = parseSystemProxyChain(
      'PROXY 127.0.0.1:7890; HTTPS secure.example:8443; SOCKS socks.example:1080; SOCKS5 backup.example:1081; DIRECT'
    )

    expect(chain.map((directive) => directive.kind === 'direct'
      ? 'direct'
      : `${directive.proxy.protocol}:${directive.proxy.host}:${directive.proxy.port}`)).toEqual([
      'http:127.0.0.1:7890',
      'https:secure.example:8443',
      'socks4:socks.example:1080',
      'socks5:backup.example:1081',
      'direct'
    ])
    expect(summarizeSystemProxyChain(chain)).toBe(
      'HTTP 127.0.0.1:7890 → HTTPS secure.example:8443 → SOCKS4 socks.example:1080 → SOCKS5 backup.example:1081 → DIRECT'
    )
  })

  it('supports HTTP, SOCKS4, defaults, duplicates and a plain DIRECT decision', () => {
    expect(parseSystemProxyChain('DIRECT')).toEqual([{ kind: 'direct' }])
    const chain = parseSystemProxyChain('HTTP proxy.example; SOCKS4 [::1]; HTTP proxy.example:80')
    expect(chain).toHaveLength(2)
    expect(chain[0]).toMatchObject({ kind: 'proxy', proxy: { protocol: 'http', port: 80 } })
    expect(chain[1]).toMatchObject({ kind: 'proxy', proxy: { protocol: 'socks4', host: '::1', port: 1080 } })
  })

  it('drops a loopback proxy that points back at the Stone gateway and never exposes userinfo', () => {
    const chain = parseSystemProxyChain(
      'PROXY user:secret@127.0.0.1:15721; PROXY user:secret@127.0.0.1:7890; DIRECT',
      { blockedLoopbackPorts: [15721] }
    )

    expect(summarizeSystemProxyChain(chain)).toBe('HTTP 127.0.0.1:7890 → DIRECT')
    expect(JSON.stringify(chain)).not.toContain('secret')
    expect(JSON.stringify(chain)).not.toContain('user')
  })

  it('keeps local destinations out of system proxy routing', () => {
    expect(isLocalTarget('http://localhost:15721/v1')).toBe(true)
    expect(isLocalTarget('http://127.99.2.1/test')).toBe(true)
    expect(isLocalTarget('http://[::1]/test')).toBe(true)
    expect(isLocalTarget('https://chatgpt.com/')).toBe(false)
  })
})
