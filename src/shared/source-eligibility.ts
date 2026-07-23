import { providerModelCapabilities } from './source-capabilities'
import type {
  Account,
  ProviderDefinition,
  PublicAccount,
  UpstreamCapabilityRequirement,
} from './types'

export type SourceAccount = Pick<
  Account | PublicAccount,
  'id' | 'providerId' | 'modelPolicy' | 'modelAllowlist' | 'availableModels' | 'modelsRefreshedAt'
>

export type CapabilityEligibility = 'verified' | 'unknown' | 'unsupported'

export interface SourceEligibilityResult<T extends SourceAccount> {
  modelEligible: T[]
  verified: T[]
  unknown: T[]
  unsupported: T[]
  schedulable: T[]
}

/**
 * Shared static/runtime source eligibility. Capability=false is a hard
 * exclusion. Missing capability metadata remains a backward-compatible
 * fallback, but verified members are always preferred over unknown members.
 */
export function evaluateSourceEligibility<T extends SourceAccount>(input: {
  accounts: readonly T[]
  providers: readonly ProviderDefinition[]
  model?: string
  poolModelPolicy?: 'all' | 'selected'
  poolModelAllowlist?: readonly string[]
  requiredCapabilities?: readonly UpstreamCapabilityRequirement[]
  /** Require every account to resolve to provider metadata. */
  requireProvider?: boolean
}): SourceEligibilityResult<T> {
  const required = [...new Set(input.requiredCapabilities ?? [])]
  const providerById = new Map(input.providers.map((provider) => [provider.id, provider]))
  const modelEligible = input.accounts.filter((account) => accountSupportsModel(
    account,
    input.model,
    providerById.get(account.providerId),
    input.poolModelPolicy,
    input.poolModelAllowlist,
    input.requireProvider,
  ))
  const verified: T[] = []
  const unknown: T[] = []
  const unsupported: T[] = []
  for (const account of modelEligible) {
    const status = accountCapabilityEligibility(
      providerById.get(account.providerId),
      input.model,
      required,
      input.requireProvider,
    )
    if (status === 'verified') verified.push(account)
    else if (status === 'unknown') unknown.push(account)
    else unsupported.push(account)
  }
  return {
    modelEligible,
    verified,
    unknown,
    unsupported,
    schedulable: verified.length ? verified : unknown,
  }
}

export function accountSupportsModel(
  account: SourceAccount,
  model: string | undefined,
  provider: ProviderDefinition | undefined,
  poolModelPolicy?: 'all' | 'selected',
  poolModelAllowlist?: readonly string[],
  requireProvider = false,
): boolean {
  // An orphaned account cannot be executed: the gateway needs provider
  // protocol, endpoint and adapter metadata even when the request has no
  // explicit model/capability constraint. Do not let it inflate preview counts
  // or reach the scheduler only to fail as a 503 after acquiring a slot.
  if (requireProvider && !provider) return false
  if (!model) return true
  if (poolModelPolicy === 'selected' && !(poolModelAllowlist ?? []).includes(model)) return false
  if (account.modelPolicy === 'selected' && !account.modelAllowlist.includes(model)) return false
  // Before an account has been probed, provider catalogs are advisory and may
  // contain aliases or only a subset of models exposed by OAuth credentials.
  // Preserve the scheduler's established permissive behavior until the
  // account owns a refreshed model snapshot.
  if (account.modelsRefreshedAt === undefined) return true
  return account.availableModels.includes(model)
}

export function accountCapabilityEligibility(
  provider: ProviderDefinition | undefined,
  model: string | undefined,
  requiredCapabilities: readonly UpstreamCapabilityRequirement[],
  requireProvider = false,
): CapabilityEligibility {
  if (!provider) return requireProvider ? 'unsupported' : requiredCapabilities.length ? 'unknown' : 'verified'
  if (!requiredCapabilities.length) return 'verified'
  const capabilities = providerModelCapabilities(provider, model)
  let unknown = false
  for (const capability of requiredCapabilities) {
    const value = capabilities[capability]
    if (value === false) return 'unsupported'
    if (value !== true) unknown = true
  }
  return unknown ? 'unknown' : 'verified'
}
