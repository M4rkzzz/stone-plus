import { describe, expect, it } from 'vitest'
import { summarizeBuiltInProxyNetworkPolicy } from '../../src/shared/built-in-proxy-policy'

describe('built-in proxy network policy summary', () => {
  it('describes platform DNS without exposing upstream values', () => {
    const summary = summarizeBuiltInProxyNetworkPolicy({ ruleMode: 'global' })

    expect(summary.dns).toEqual({
      owner: 'platform',
      upstreams: 'system-resolver',
      transport: 'platform',
      detour: 'direct',
      strategy: 'prefer-ipv4',
      importedDnsUsed: false,
      rendererConfigurable: false,
    })
    expect(summary.rules).toMatchObject({
      policy: 'global',
      importedRules: 'not-used',
      chinaRuleSets: 'not-used',
      ruleSetDownload: 'not-used',
    })
  })

  it('never reports Stone-managed remote rules and ignores legacy custom settings', () => {
    expect(summarizeBuiltInProxyNetworkPolicy({
      ruleMode: 'rule',
      profile: { format: 'uri-list', ruleStatus: 'fallback' },
    }).rules).toMatchObject({
      policy: 'subscription-fallback',
      importedRules: 'downgraded',
      chinaRuleSets: 'not-used',
      ruleSetDownload: 'not-used',
    })

    expect(summarizeBuiltInProxyNetworkPolicy({
      ruleMode: 'rule',
      customRules: {
        rules: [{ id: 'cn', condition: 'mainland-china', values: [], action: 'direct' }],
        finalAction: 'proxy',
      },
    }).rules).toMatchObject({
      policy: 'subscription-fallback',
      importedRules: 'not-used',
      chinaRuleSets: 'not-used',
      ruleSetDownload: 'not-used',
    })
  })

  it('describes safely converted inline rules without external rule-set downloads', () => {
    expect(summarizeBuiltInProxyNetworkPolicy({
      ruleMode: 'rule',
      profile: { format: 'sing-box-json', ruleStatus: 'preserved' },
    }).rules).toMatchObject({
      policy: 'safe-imported',
      importedRules: 'safe-converted',
      chinaRuleSets: 'not-used',
    })
    expect(summarizeBuiltInProxyNetworkPolicy({
      ruleMode: 'rule',
      profile: { format: 'clash-meta-yaml', ruleStatus: 'preserved' },
    }).rules).toMatchObject({
      policy: 'safe-imported',
      importedRules: 'safe-converted',
      chinaRuleSets: 'not-used',
      ruleSetDownload: 'not-used',
    })
  })

  it('never spreads untrusted URL, path, script, or controller fields into the summary', () => {
    const summary = summarizeBuiltInProxyNetworkPolicy({
      ruleMode: 'rule',
      profile: {
        format: 'clash-meta-yaml',
        ruleStatus: 'preserved',
        url: 'https://attacker.invalid/rules.srs',
        path: 'C:\\private\\rules.srs',
        script: 'run-me',
        controllerSecret: 'private-controller-secret',
      },
    } as never)
    const serialized = JSON.stringify(summary)

    expect(serialized).not.toContain('attacker.invalid')
    expect(serialized).not.toContain('private\\rules')
    expect(serialized).not.toContain('run-me')
    expect(serialized).not.toContain('private-controller-secret')
    expect(summary.rules).toMatchObject({
      importedRuleSetSourcesUsed: false,
      importedProvidersExecuted: false,
      importedLocalFilesUsed: false,
      importedScriptsExecuted: false,
      rendererControlsRuntime: false,
    })
  })
})
