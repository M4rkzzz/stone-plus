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

  it('generates private/China direct fallback rules while bootstrapping rule data through the selected proxy', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'tun' })

    expect(result.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
      expect.objectContaining({ ip_is_private: true, outbound: 'stone-direct' }),
      { action: 'sniff', timeout: '300ms' },
      expect.objectContaining({ rule_set: ['stone-geosite-cn', 'stone-geoip-cn'], outbound: 'stone-direct' })
    ])
    expect(result.config.route.rule_set).toEqual([
      expect.objectContaining({ tag: 'stone-geosite-cn', download_detour: result.activeOutboundTag }),
      expect.objectContaining({ tag: 'stone-geoip-cn', download_detour: result.activeOutboundTag })
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
      { action: 'sniff', timeout: '300ms' },
      { domain: ['ads.example'], action: 'reject', method: 'default' },
      { domain_suffix: ['internal.example'], action: 'route', outbound: 'stone-direct' }
    ])
    expect(result.config.route.final).toBe(result.activeOutboundTag)
  })

  it('compiles visual rules in order and completely replaces profile rules', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' }
      ],
      route: { rules: [{ domain: ['must-not-survive.example'], outbound: 'direct' }] }
    }))
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'system',
      customRules: {
        rules: [
          { id: 'private', condition: 'private-network', values: [], action: 'direct' },
          { id: 'china', condition: 'mainland-china', values: [], action: 'direct' },
          { id: 'ports', condition: 'port', values: ['80', '443'], action: 'proxy' },
          { id: 'ads', condition: 'domain-suffix', values: ['ads.example'], action: 'block' }
        ],
        finalAction: 'direct'
      }
    })

    expect(result.routePolicy).toBe('custom')
    expect(result.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
      expect.objectContaining({ ip_is_private: true, outbound: 'stone-direct' }),
      { action: 'sniff', timeout: '300ms' },
      expect.objectContaining({ rule_set: ['stone-geosite-cn', 'stone-geoip-cn'], outbound: 'stone-direct' }),
      expect.objectContaining({ port: [80, 443], outbound: result.activeOutboundTag }),
      { domain_suffix: ['ads.example'], action: 'reject', method: 'default' }
    ])
    expect(result.config.route.rule_set).toHaveLength(2)
    expect(result.config.route.rule_set).toEqual([
      expect.objectContaining({ download_detour: result.activeOutboundTag }),
      expect.objectContaining({ download_detour: result.activeOutboundTag })
    ])
    expect(result.config.route.final).toBe('stone-direct')
    expect(JSON.stringify(result.config)).not.toContain('must-not-survive.example')
  })

  it('distinguishes an explicit empty visual rule set and ignores it outside rule mode', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const customRules = { rules: [], finalAction: 'direct' as const }
    const rule = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'system', customRules })
    const global = buildSingBoxConfig({ profile, mode: 'global', accessMode: 'system', customRules })
    const direct = buildSingBoxConfig({ profile, mode: 'direct', accessMode: 'system', customRules })

    expect(rule.routePolicy).toBe('custom')
    expect(rule.config.route.rules).toHaveLength(1)
    expect(rule.config.route.final).toBe('stone-direct')
    expect(global.routePolicy).toBe('global')
    expect(global.config.route.final).toBe(global.activeOutboundTag)
    expect(direct.routePolicy).toBe('direct')
    expect(direct.config.route.final).toBe('stone-direct')
  })

  it('maps every generic visual condition without changing its rule order', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'system',
      customRules: {
        rules: [
          { id: 'domain', condition: 'domain', values: ['api.example.com'], action: 'proxy' },
          { id: 'suffix', condition: 'domain-suffix', values: ['example.org'], action: 'direct' },
          { id: 'keyword', condition: 'domain-keyword', values: ['video'], action: 'block' },
          { id: 'cidr', condition: 'ip-cidr', values: ['198.51.100.0/24'], action: 'proxy' },
          { id: 'port', condition: 'port', values: ['443'], action: 'direct' },
          { id: 'range', condition: 'port-range', values: ['1000:2000'], action: 'proxy' },
          { id: 'network', condition: 'network', values: ['tcp', 'udp'], action: 'direct' },
          { id: 'protocol', condition: 'protocol', values: ['http', 'tls'], action: 'block' },
          { id: 'private', condition: 'private-network', values: [], action: 'direct' },
          { id: 'china', condition: 'mainland-china', values: [], action: 'proxy' },
        ],
        finalAction: 'proxy',
      },
    })

    expect(result.config.route.rules.slice(1)).toEqual([
      { action: 'sniff', timeout: '300ms' },
      { domain: ['api.example.com'], action: 'route', outbound: result.activeOutboundTag },
      { domain_suffix: ['example.org'], action: 'route', outbound: 'stone-direct' },
      { domain_keyword: ['video'], action: 'reject', method: 'default' },
      { ip_cidr: ['198.51.100.0/24'], action: 'route', outbound: result.activeOutboundTag },
      { port: [443], action: 'route', outbound: 'stone-direct' },
      { port_range: ['1000:2000'], action: 'route', outbound: result.activeOutboundTag },
      { network: ['tcp', 'udp'], action: 'route', outbound: 'stone-direct' },
      { protocol: ['http', 'tls'], action: 'reject', method: 'default' },
      { ip_is_private: true, action: 'route', outbound: 'stone-direct' },
      { rule_set: ['stone-geosite-cn', 'stone-geoip-cn'], action: 'route', outbound: result.activeOutboundTag },
    ])
  })

  it('does not add sniffing when every visual rule can be matched from packet metadata', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'tun',
      customRules: {
        rules: [
          { id: 'private', condition: 'private-network', values: [], action: 'direct' },
          { id: 'cidr', condition: 'ip-cidr', values: ['198.51.100.0/24'], action: 'proxy' },
          { id: 'port', condition: 'port', values: ['443'], action: 'direct' },
          { id: 'network', condition: 'network', values: ['tcp'], action: 'proxy' },
        ],
        finalAction: 'proxy',
      },
    })

    expect(result.config.route.rules).not.toContainEqual(expect.objectContaining({ action: 'sniff' }))
  })

  it('keeps loopback and packet-metadata rules ahead of the first required sniff action', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'tun',
      customRules: {
        rules: [
          { id: 'private', condition: 'private-network', values: [], action: 'direct' },
          { id: 'cidr', condition: 'ip-cidr', values: ['198.51.100.0/24'], action: 'direct' },
          { id: 'port', condition: 'port', values: ['443'], action: 'direct' },
          { id: 'domain', condition: 'domain-suffix', values: ['example.com'], action: 'proxy' },
          { id: 'protocol', condition: 'protocol', values: ['tls'], action: 'proxy' },
        ],
        finalAction: 'proxy',
      },
    })

    expect(result.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
      { ip_is_private: true, action: 'route', outbound: 'stone-direct' },
      { ip_cidr: ['198.51.100.0/24'], action: 'route', outbound: 'stone-direct' },
      { port: [443], action: 'route', outbound: 'stone-direct' },
      { action: 'sniff', timeout: '300ms' },
      { domain_suffix: ['example.com'], action: 'route', outbound: result.activeOutboundTag },
      { protocol: ['tls'], action: 'route', outbound: result.activeOutboundTag },
    ])
  })

  it('supports global/direct modes without allowing loopback into the proxy', () => {
    const profile = parseBuiltInProxyProfile(`trojan://password@edge.example.com:443#Node`)
    const global = buildSingBoxConfig({ profile, mode: 'global', accessMode: 'tun' })
    const direct = buildSingBoxConfig({ profile, mode: 'direct', accessMode: 'system' })

    expect(global.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' })
    ])
    expect(global.config.route.rules).not.toContainEqual(expect.objectContaining({ action: 'sniff' }))
    expect(global.config.route.final).toBe(global.activeOutboundTag)
    expect(direct.config.outbounds).toEqual([
      expect.objectContaining({ type: 'direct', tag: 'stone-direct' })
    ])
    expect(direct.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' })
    ])
    expect(direct.config.route.rules).not.toContainEqual(expect.objectContaining({ action: 'sniff' }))
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
