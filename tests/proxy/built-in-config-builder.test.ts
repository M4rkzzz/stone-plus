import { describe, expect, it } from 'vitest'
import {
  BuiltInProxyConfigError,
  buildSingBoxConfig,
} from '../../src/main/proxy/built-in/config-builder'
import { parseBuiltInProxyProfile } from '../../src/main/proxy/built-in/profile-parser'

const UUID = '9f1c5f42-7702-4a12-b50c-2fb36b7bba4a'

describe('built-in sing-box config builder', () => {
  it('reconstructs a listener-free allow-listed source config with platform DNS', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      inbounds: [{ type: 'mixed', listen: '0.0.0.0', listen_port: 9999 }],
      experimental: { clash_api: { external_controller: '0.0.0.0:9090', secret: 'must-not-survive' } },
      outbounds: [{
        type: 'vless', tag: 'Node', server: 'edge.example.com', server_port: 443, uuid: UUID,
        tls: { enabled: true, server_name: 'edge.example.com' },
        transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
      }],
    }))
    const result = buildSingBoxConfig({
      profile, activeNodeId: profile.nodes[0].id, mode: 'rule', accessMode: 'system',
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
      domain_resolver: 'stone-direct-dns',
    })
    expect(result.config.dns.servers).toEqual([{ type: 'local', tag: 'stone-direct-dns' }])
  })

  it('uses the selected node when a subscription has no rules without downloading Stone-owned rule data', () => {
    const profile = parseBuiltInProxyProfile('trojan://password@edge.example.com:443#Node')
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'tun' })

    expect(result.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
    ])
    expect(result.config.route.rule_set).toBeUndefined()
    expect(JSON.stringify(result.config)).not.toContain('githubusercontent.com')
    expect(JSON.stringify(result.config)).not.toContain('geosite')
    expect(JSON.stringify(result.config)).not.toContain('geoip')
    expect(result.config.route.final).toBe(result.activeOutboundTag)
  })

  it('preserves supported subscription rule order and compiles reject/final actions', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' },
        { type: 'block', tag: 'block' },
      ],
      route: { rules: [
        { domain: ['ads.example'], action: 'route', outbound: 'block' },
        { domain_suffix: ['internal.example'], action: 'route', outbound: 'direct' },
        { action: 'route', outbound: 'Node' },
      ] },
    }))
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'system' })

    expect(result.routePolicy).toBe('preserved')
    expect(result.config.route.rules.slice(1)).toEqual([
      { action: 'sniff', timeout: '300ms' },
      { domain: ['ads.example'], action: 'reject', method: 'default' },
      { domain_suffix: ['internal.example'], action: 'route', outbound: 'stone-direct' },
    ])
    expect(result.config.route.final).toBe(result.activeOutboundTag)
  })

  it('adds only missing mandatory service and configured relay domains ahead of subscription rules', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' },
      ],
      route: { rules: [
        { domain_suffix: ['openai.com'], outbound: 'Node' },
        { domain_suffix: ['internal.example'], outbound: 'direct' },
        { outbound: 'direct' },
      ] },
    }))
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'system',
      requiredProxyDomains: ['relay.vendor.example'],
    })
    const supplemental = result.config.route.rules.find((rule) => Array.isArray(rule.domain_suffix))

    expect(supplemental).toMatchObject({ action: 'route', outbound: result.activeOutboundTag })
    expect(supplemental?.domain_suffix).toContain('relay.vendor.example')
    expect(supplemental?.domain_suffix).toContain('chatgpt.com')
    expect(supplemental?.domain_suffix).not.toContain('openai.com')
    expect(result.config.route.rules.indexOf(supplemental!)).toBeLessThan(
      result.config.route.rules.findIndex((rule) => rule.domain_suffix?.includes?.('internal.example')),
    )
    expect(result.config.route.final).toBe('stone-direct')
  })

  it('overrides a subscription direct rule for a mandatory service domain', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' },
      ],
      route: { rules: [
        { domain_suffix: ['openai.com'], outbound: 'direct' },
        { outbound: 'Node' },
      ] },
    }))
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'system' })
    const supplemental = result.config.route.rules.find((rule) => (
      Array.isArray(rule.domain_suffix) && rule.domain_suffix.includes('openai.com')
      && rule.outbound === result.activeOutboundTag
    ))

    expect(supplemental).toBeDefined()
    expect(result.config.route.rules.indexOf(supplemental!)).toBeLessThan(
      result.config.route.rules.findIndex((rule) => rule.outbound === 'stone-direct' && rule.domain_suffix?.includes?.('openai.com')),
    )
  })

  it('ignores legacy standalone custom rules and keeps subscription rules', () => {
    const profile = parseBuiltInProxyProfile(JSON.stringify({
      outbounds: [
        { type: 'trojan', tag: 'Node', server: 'edge.example.com', server_port: 443, password: 'password' },
        { type: 'direct', tag: 'direct' },
      ],
      route: { rules: [
        { domain_suffix: ['subscription.example'], outbound: 'direct' },
        { outbound: 'Node' },
      ] },
    }))
    const result = buildSingBoxConfig({
      profile,
      mode: 'rule',
      accessMode: 'system',
      customRules: {
        rules: [{ id: 'old', condition: 'domain-suffix', values: ['custom.example'], action: 'direct' }],
        finalAction: 'direct',
      },
    })

    expect(result.routePolicy).toBe('preserved')
    expect(JSON.stringify(result.config)).toContain('subscription.example')
    expect(JSON.stringify(result.config)).not.toContain('custom.example')
    expect(result.warnings.join(' ')).toContain('standalone custom rule set was ignored')
  })

  it('skips legacy external-database rules without losing the supported subset', () => {
    const parsed = parseBuiltInProxyProfile('trojan://password@edge.example.com:443#Node')
    const profile = {
      ...parsed,
      rules: [
        { ruleSetTags: ['geoip-cn'] as const, action: 'direct' as const },
        { domainSuffixes: ['internal.example'], action: 'direct' as const },
        { action: 'proxy' as const },
      ],
    }
    const result = buildSingBoxConfig({ profile, mode: 'rule', accessMode: 'system' })

    expect(result.routePolicy).toBe('preserved')
    expect(JSON.stringify(result.config)).not.toContain('geoip')
    expect(JSON.stringify(result.config)).toContain('internal.example')
    expect(result.warnings.join(' ')).toContain('requiring an external database were skipped')
  })

  it('supports global/direct modes without allowing loopback into the proxy', () => {
    const profile = parseBuiltInProxyProfile('trojan://password@edge.example.com:443#Node')
    const global = buildSingBoxConfig({ profile, mode: 'global', accessMode: 'tun' })
    const direct = buildSingBoxConfig({ profile, mode: 'direct', accessMode: 'system' })

    expect(global.config.route.rules).toEqual([
      expect.objectContaining({ ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'stone-direct' }),
    ])
    expect(global.config.route.final).toBe(global.activeOutboundTag)
    expect(direct.config.outbounds).toEqual([
      expect.objectContaining({ type: 'direct', tag: 'stone-direct' }),
    ])
    expect(direct.config.route.final).toBe('stone-direct')
    expect(JSON.stringify(direct.config)).not.toContain('password')
  })

  it('falls back atomically when the active node disappears and validates explicit legacy DNS overrides', () => {
    const profile = parseBuiltInProxyProfile(`
trojan://first-password@one.example.com:443#First
trojan://second-password@two.example.com:443#Second
`)
    const result = buildSingBoxConfig({
      profile, activeNodeId: 'node-that-was-removed', mode: 'global', accessMode: 'system',
    })

    expect(result.requestedNodeMissing).toBe(true)
    expect(result.activeNodeId).toBe(profile.nodes[0].id)
    expect(result.warnings[0]).toContain('no longer available')
    expect(() => buildSingBoxConfig({
      profile, mode: 'global', accessMode: 'system', dnsServers: ['127.0.0.1'],
    })).toThrowError(expect.objectContaining({ code: 'invalid-dns-server' }))
    expect(() => buildSingBoxConfig({
      profile: { ...profile, nodes: [{ ...profile.nodes[0], serverPort: 70_000 }] },
      mode: 'global', accessMode: 'system',
    })).toThrow(BuiltInProxyConfigError)
  })
})
