import type {
  BuiltInProxyCustomRuleSet,
  BuiltInProxyProfileFormat,
  BuiltInProxyRuleMode,
} from './types'

export interface BuiltInProxyPolicyProfileInput {
  format: BuiltInProxyProfileFormat
  ruleStatus: 'preserved' | 'fallback'
}

export interface BuiltInProxyPolicySummaryInput {
  ruleMode: BuiltInProxyRuleMode
  customRules?: BuiltInProxyCustomRuleSet
  profile?: BuiltInProxyPolicyProfileInput
}

/** Credential-free description of the DNS configuration Stone+ actually generates. */
export interface BuiltInProxyDnsPolicySummary {
  owner: 'stone'
  upstreams: 'one-to-four-validated-non-loopback-ips'
  transport: 'udp-53'
  detour: 'direct'
  strategy: 'prefer-ipv4'
  importedDnsUsed: false
  rendererConfigurable: false
}

export type BuiltInProxyEffectiveRulePolicy =
  | 'direct'
  | 'global'
  | 'stone-custom'
  | 'safe-imported'
  | 'stone-fallback'

export interface BuiltInProxyRuleSourceSummary {
  policy: BuiltInProxyEffectiveRulePolicy
  importedRules: 'not-used' | 'safe-converted' | 'downgraded'
  chinaRuleSets: 'not-used' | 'stone-managed' | 'stone-managed-if-referenced'
  ruleSetDownload: 'not-used' | 'selected-node'
  importedRuleSetSourcesUsed: false
  importedProvidersExecuted: false
  importedLocalFilesUsed: false
  importedScriptsExecuted: false
  rendererControlsRuntime: false
}

export interface BuiltInProxyNetworkPolicySummary {
  dns: BuiltInProxyDnsPolicySummary
  rules: BuiltInProxyRuleSourceSummary
}

const DNS_POLICY = Object.freeze<BuiltInProxyDnsPolicySummary>({
  owner: 'stone',
  upstreams: 'one-to-four-validated-non-loopback-ips',
  transport: 'udp-53',
  detour: 'direct',
  strategy: 'prefer-ipv4',
  importedDnsUsed: false,
  rendererConfigurable: false,
})

/**
 * Projects only static Stone-owned policy and renderer-safe profile metadata.
 * It never accepts or returns controller secrets, subscription URLs, node
 * credentials, arbitrary rule-set URLs, scripts, or local file paths.
 */
export function summarizeBuiltInProxyNetworkPolicy(
  input: BuiltInProxyPolicySummaryInput,
): BuiltInProxyNetworkPolicySummary {
  return {
    dns: { ...DNS_POLICY },
    rules: summarizeRules(input),
  }
}

function summarizeRules(input: BuiltInProxyPolicySummaryInput): BuiltInProxyRuleSourceSummary {
  let policy: BuiltInProxyEffectiveRulePolicy
  let importedRules: BuiltInProxyRuleSourceSummary['importedRules']
  let chinaRuleSets: BuiltInProxyRuleSourceSummary['chinaRuleSets'] = 'not-used'

  if (input.ruleMode === 'direct') {
    policy = 'direct'
    importedRules = 'not-used'
  } else if (input.ruleMode === 'global') {
    policy = 'global'
    importedRules = 'not-used'
  } else if (input.customRules !== undefined) {
    policy = 'stone-custom'
    importedRules = 'not-used'
    if (input.customRules.rules.some((rule) => rule.condition === 'mainland-china')) {
      chinaRuleSets = 'stone-managed'
    }
  } else if (input.profile?.ruleStatus === 'preserved') {
    policy = 'safe-imported'
    importedRules = 'safe-converted'
    // The sing-box allow-list excludes rule_set references entirely. Clash
    // GEOIP/GEOSITE CN rules are the only preserved import that can request
    // Stone's fixed China rule sets, but the renderer-safe profile projection
    // intentionally does not expose individual rule contents.
    if (input.profile.format === 'clash-meta-yaml') {
      chinaRuleSets = 'stone-managed-if-referenced'
    }
  } else {
    policy = 'stone-fallback'
    importedRules = input.profile ? 'downgraded' : 'not-used'
    chinaRuleSets = 'stone-managed'
  }

  return {
    policy,
    importedRules,
    chinaRuleSets,
    ruleSetDownload: chinaRuleSets === 'not-used' ? 'not-used' : 'selected-node',
    importedRuleSetSourcesUsed: false,
    importedProvidersExecuted: false,
    importedLocalFilesUsed: false,
    importedScriptsExecuted: false,
    rendererControlsRuntime: false,
  }
}
