import { describe, expect, it } from 'vitest'
import {
  BuiltInProxyConfigError,
  buildSingBoxConfig
} from '../../src/main/proxy/built-in/config-builder'
import { parseBuiltInProxyProfile } from '../../src/main/proxy/built-in/profile-parser'

const UUID = '9f1c5f42-7702-4a12-b50c-2fb36b7bba4a'

describe('built-in sing-box config builder', () => {
  it('reconstructs a listener-free allow-listed source config', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      inbounds: [{ type: 'mixed', listen: '0.0.0.0', listen_port: 9999 }],
      experimental: { clash_api: { external_controller: '0.0.0.0:9090', secret: 'must-not-survive' } },
      outbounds: [{
        type: 'vless', tag: 'Node', server: 'edge.example.com', server_port: 443, uuid: UUID,
        tls: { enabled: true, server_name: 'edge.example.com' },
        transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } }
      }]
    }))
    const result = buildSingBoxConfig({
      profile, activeNodeId: profile.nodes[0].id, mode: 'rule', accessMode: 'system'
    })
    const serialized = JSON.stringify(result.config)

    expect(result.routePolicy).toBe('fallback')
    expect(result.requestedNodeMissing).toBe(false)
    expect(result.config).not.toHaveProperty('inbounds')
    expect(result.config).not.toHaveProperty('experimental')
    expect(serialized).not.toContain('must-not-survive')
    expect(serialized).not.toContain('0.0.0.0')
    expect(result.config.outbounds[0]).toMatchObject({
      type: 'vless', server: 'edge.example.com', server_port: 443, uuid: UUID,
      domain_resolver: 'stone-direct-dns'
    })
    expect(result.config.dns.servers[0]).toMatchObject({ detour: 'stone-direct' })
  })

  it('generates private/China direct fallback rules with rule-set downloads forced direct', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'tun' })

    expect(result.config.route.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
      expect.objectContaining({ ip_is_private: true, outbound: 'stone-direct' }),
      expect.objectContaining({ rule_set: ['stone-geosite-cn', 'stone-geoip-cn'], outbound: 'stone-direct' })
    ]))
    expect(result.config.route.rule_set).toEqual([
      expect.objectContaining({ tag: 'stone-geosite-cn', download_detour: 'stone-direct' }),
      expect.objectContaining({ tag: 'stone-geoip-cn', download_detour: 'stone-direct' })
    ])
    expect(result.config.route.final).toBe(result.activeOutboundTag)
  })

  it('preserves safe rule order and compiles reject/final actions', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' },
        { type: 'block', tag: 'block' }
      ],
      route: { rules: [
        { domain: ['ads.example'], action: 'route', outbound: 'block' },
        { domain_suffix: ['internal.example'], action: 'route', outbound: 'direct' },
        { action: 'route', outbound: 'Node' }
      ] }
    }))
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'system' })

    expect(result.routePolicy).toBe('preserved')
    expect(result.config.route.rules.slice(1)).toEqual([
      { domain: ['ads.example'], action: 'reject', method: 'default' },
      { domain_suffix: ['internal.example'], action: 'route', outbound: 'stone-direct' }
    ])
    expect(result.config.route.final).toBe(result.activeOutboundTag)
  })

  it('supports global/direct modes without allowing loopback into the proxy', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const global = buildSingBoxConfig({ profile, mode: 'global', accessMode: 'tun' })
    const direct = buildSingBoxConfig({ profile, mode: 'direct', accessMode: 'system' })

    expect(global.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' })
    ])
    expect(global.config.route.final).toBe(global.activeOutboundTag)
    expect(direct.config.outbounds).toEqual([
      expect.objectContaining({ type: 'direct', tag: 'stone-direct' })
    ])
    expect(direct.config.route.final).toBe('stone-direct')
    expect(JSON.stringify(direct.config)).not.toContain('password')
  })

  it('falls back atomically when the previously active node disappears', () => {
    const profile = parseBuiltInProxyProfile(`
trojan://first-password@one.example.com:443#First
trojan://second-password@two.example.com:443#Second
`)
    const result = buildSingBoxConfig({
      profile, activeNodeId: 'node-that-was-removed', mode: 'global', accessMode: 'system'
    })

    expect(result.requestedNodeMissing).toBe(true)
    expect(result.activeNodeId).toBe(profile.nodes[0].id)
    expect(result.warnings[0]).toContain('no longer available')
  })

  it('rejects loopback DNS and malformed decrypted profiles', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    expect(() => buildSingBoxConfig({
      profile, mode: 'global', accessMode: 'system', dnsServers: ['127.0.0.1']
    })).toThrowError(expect.objectContaining({ code: 'invalid-dns-server' }))

    expect(() => buildSingBoxConfig({
      profile: { ...profile, nodes: [{ ...profile.nodes[0], serverPort: 70000 }] },
      mode: 'global', accessMode: 'system'
    })).toThrow(BuiltInProxyConfigError)
  })
})
