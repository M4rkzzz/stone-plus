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
  owner: 'platform'
  upstreams: 'system-resolver'
  transport: 'platform'
  detour: 'direct'
  strategy: 'prefer-ipv4'
  importedDnsUsed: false
  rendererConfigurable: false
}

export type BuiltInProxyEffectiveRulePolicy =
  | 'direct'
  | 'global'
  | 'safe-imported'
  | 'subscription-fallback'

export interface BuiltInProxyRuleSourceSummary {
  policy: BuiltInProxyEffectiveRulePolicy
  importedRules: 'not-used' | 'safe-converted' | 'downgraded'
  /**
   * Custom rules are a global additive overlay placed ahead of the imported
   * rules. `partially-applied` means at least one saved rule uses a condition
   * Stone+ can no longer honour and was skipped.
   */
  customOverlay: 'not-used' | 'applied' | 'partially-applied'
  chinaRuleSets: 'not-used'
  ruleSetDownload: 'not-used'
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
  owner: 'platform',
  upstreams: 'system-resolver',
  transport: 'platform',
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

function summarizeCustomOverlay(
  customRules: BuiltInProxyCustomRuleSet | undefined,
): BuiltInProxyRuleSourceSummary['customOverlay'] {
  const rules = customRules?.rules ?? []
  if (rules.length === 0) return 'not-used'
  const honoured = rules.filter((rule) => rule.condition !== 'mainland-china')
  if (honoured.length === 0) return 'not-used'
  return honoured.length === rules.length ? 'applied' : 'partially-applied'
}

function summarizeRules(input: BuiltInProxyPolicySummaryInput): BuiltInProxyRuleSourceSummary {
  let policy: BuiltInProxyEffectiveRulePolicy
  let importedRules: BuiltInProxyRuleSourceSummary['importedRules']
  const chinaRuleSets: BuiltInProxyRuleSourceSummary['chinaRuleSets'] = 'not-used'

  if (input.ruleMode === 'direct') {
    policy = 'direct'
    importedRules = 'not-used'
  } else if (input.ruleMode === 'global') {
    policy = 'global'
    importedRules = 'not-used'
  } else if (input.profile?.ruleStatus === 'preserved') {
    policy = 'safe-imported'
    importedRules = 'safe-converted'
  } else {
    policy = 'subscription-fallback'
    importedRules = input.profile ? 'downgraded' : 'not-used'
  }

  return {
    policy,
    importedRules,
    customOverlay: summarizeCustomOverlay(input.customRules),
    chinaRuleSets,
    ruleSetDownload: 'not-used',
    importedRuleSetSourcesUsed: false,
    importedProvidersExecuted: false,
    importedLocalFilesUsed: false,
    importedScriptsExecuted: false,
    rendererControlsRuntime: false,
  }
}
