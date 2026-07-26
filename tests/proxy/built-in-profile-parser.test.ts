import { describe, expect, it } from 'vitest'
import {
  BuiltInProxyProfileError,
  parseBuiltInProxyProfile,
  stableNodeId
} from '../../src/main/proxy/built-in/profile-parser'
import { summarizeBuiltInProxyProfile } from '../../src/main/proxy/built-in/profile-types'

const UUID = '9f1c5f42-7702-4a12-b50c-2fb36b7bba4a'

describe('built-in proxy profile parser', () => {
  it('normalizes sing-box JSON without retaining foreign listeners or controllers', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      inbounds: [{ type: 'mixed', listen: '0.0.0.0', listen_port: 1234 }],
      experimental: { clash_api: { external_controller: '0.0.0.0:9090', secret: 'foreign-secret' } },
      outbounds: [
        { type: 'direct', tag: 'direct' },
        {
          type: 'vless', tag: 'Primary', server: 'edge.example.com', server_port: 443,
          uuid: UUID,
          tls: { enabled: true, server_name: 'edge.example.com', utls: { enabled: true, fingerprint: 'chrome' } },
          transport: { type: 'ws', path: '/socket', headers: { Host: 'cdn.example.com' } }
        },
        { type: 'selector', tag: 'Proxy', outbounds: ['Primary'] }
      ],
      route: {
        rules: [
          { domain_suffix: ['example.org'], action: 'route', outbound: 'direct' },
          { action: 'route', outbound: 'Proxy' }
        ]
      }
    }), { name: 'Production' })

    expect(profile).toMatchObject({
      name: 'Production', format: 'sing-box-json', ruleStatus: 'preserved'
    })
    expect(profile.nodes).toHaveLength(1)
    expect(profile.nodes[0]).toMatchObject({
      type: 'vless', server: 'edge.example.com', serverPort: 443,
      credentials: { uuid: UUID }, transport: { type: 'ws', path: '/socket' }
    })
    expect(profile.groups[0].nodeIds).toEqual([profile.nodes[0].id])
    expect(profile.rules).toEqual([
      { domainSuffixes: ['example.org'], action: 'direct' },
      { action: 'proxy' }
    ])
    expect(profile.warnings.join(' ')).toContain('inbounds')
    expect(JSON.stringify(profile)).not.toContain('foreign-secret')
    expect(JSON.stringify(profile)).not.toContain('external_controller')
  })

  it('keeps node IDs stable across names and subscription ordering', () => {
    const node = {
      type: 'trojan', server: 'edge.example.com', server_port: 443, password: 'node-password'
    }
    const first = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [{ ...node, tag: 'Old name' }]
    }))
    const second = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [{ type: 'direct', tag: 'direct' }, { ...node, tag: 'Renamed' }]
    }))

    expect(first.nodes[0].id).toBe(second.nodes[0].id)
    expect(stableNodeId(first.nodes[0])).toBe(first.nodes[0].id)
  })

  it('parses controlled Clash Meta YAML including groups, transports and safe rules', () => {
    const profile = parseBuiltInProxyProfile(`
proxies:
  - name: Hong Kong 01
    type: vless
    server: hk.example.com
    port: 443
    uuid: ${UUID}
    tls: true
    servername: hk.example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - { name: Backup, type: ss, server: 203.0.113.8, port: 8388, cipher: aes-256-gcm, password: second-secret }
proxy-groups:
  - name: Auto
    type: url-test
    proxies: [Hong Kong 01, Backup]
rules:
  - DOMAIN-SUFFIX,example.cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,Auto
`)

    expect(profile.format).toBe('clash-meta-yaml')
    expect(profile.nodes).toHaveLength(2)
    expect(profile.groups).toEqual([expect.objectContaining({
      name: 'Auto', type: 'urltest', nodeIds: profile.nodes.map((node) => node.id)
    })])
    expect(profile.nodes[0].transport).toMatchObject({
      type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' }
    })
    expect(profile.rules).toEqual([
      { domainSuffixes: ['example.cn'], action: 'direct' },
      { ruleSetTags: ['geoip-cn'], action: 'direct' },
      { action: 'proxy' }
    ])
  })

  it('decodes Base64 subscriptions and parses common URI nodes', () => {
    const ssAuth = Buffer.from('aes-128-gcm:uri-password').toString('base64url')
    const text = [
      `ss://${ssAuth}@ss.example.com:8388#Fast%20SS`,
      `vless://${UUID}@vless.example.com:443?security=reality&type=grpc&sni=www.example.com&pbk=public-key&sid=abcd&serviceName=tunnel#Reality`
    ].join('\n')
    const profile = parseBuiltInProxyProfile(Buffer.from(text).toString('base64'))

    expect(profile.format).toBe('uri-list')
    expect(profile.nodes).toHaveLength(2)
    expect(profile.nodes[0]).toMatchObject({
      name: 'Fast SS', type: 'shadowsocks', credentials: { method: 'aes-128-gcm', password: 'uri-password' }
    })
    expect(profile.nodes[1]).toMatchObject({
      type: 'vless', transport: { type: 'grpc', serviceName: 'tunnel' },
      tls: { enabled: true, reality: { publicKey: 'public-key', shortId: 'abcd' } }
    })
    expect(profile.ruleStatus).toBe('fallback')
    expect(profile.ruleDowngrade?.code).toBe('no-rules')
  })

  it('downgrades the complete rule set when an external provider or unsafe rule is referenced', () => {
    const profile = parseBuiltInProxyProfile(`
proxy-providers:
  vendor:
    type: http
    url: https://untrusted.invalid/provider.yaml
proxies:
  - { name: Safe, type: trojan, server: safe.example.com, port: 443, password: safe-password }
proxy-groups:
  - { name: Proxy, type: select, proxies: [Safe], use: [vendor] }
rules:
  - RULE-SET,vendor,Proxy
  - MATCH,Proxy
`)

    expect(profile.ruleStatus).toBe('fallback')
    expect(profile.rules).toEqual([])
    expect(profile.ruleDowngrade).toMatchObject({ code: 'unsupported-rules', unsupportedCount: 1 })
    expect(profile.warnings.join(' ')).toContain('not imported or executed')
    expect(JSON.stringify(profile)).not.toContain('untrusted.invalid')
  })

  it('rejects YAML anchors/scripts and ignores executable proxy plugins', () => {
    expect(() => parseBuiltInProxyProfile(`
proxies: &nodes
  - { name: Unsafe, type: ss, server: edge.example.com, port: 8388, cipher: aes-256-gcm, password: secret }
`)).toThrow(BuiltInProxyProfileError)

    const profile = parseBuiltInProxyProfile(`
proxies:
  - { name: Plugin, type: ss, server: bad.example.com, port: 8388, cipher: aes-256-gcm, password: do-not-run, plugin: arbitrary-command }
  - { name: Safe, type: trojan, server: good.example.com, port: 443, password: accepted }
`)
    expect(profile.nodes).toHaveLength(1)
    expect(profile.nodes[0].name).toBe('Safe')
    expect(JSON.stringify(profile)).not.toContain('arbitrary-command')
    expect(JSON.stringify(profile)).not.toContain('do-not-run')
  })

  it('produces a non-secret summary and enforces size/format limits', () => {
    const profile = parseBuiltInProxyProfile(`trojan://very-secret@secret.internal.example:443#Private`)
    const summary = summarizeBuiltInProxyProfile(profile)
    expect(JSON.stringify(summary)).not.toContain('very-secret')
    expect(JSON.stringify(summary)).not.toContain('secret.internal.example')
    expect(summary.nodes[0]).toMatchObject({ name: 'Private', latencyStatus: 'untested' })

    expect(() => parseBuiltInProxyProfile('not a proxy profile')).toThrowError(
      expect.objectContaining({ code: 'unsupported-format' })
    )
    expect(() => parseBuiltInProxyProfile('x'.repeat(5 * 1024 * 1024 + 1))).toThrowError(
      expect.objectContaining({ code: 'input-too-large' })
    )
  })
})
