import type { ModelPolicy, Pool, PublicAccount } from '@shared/types'

export type ModelCatalogSource = 'account' | 'provider-fallback'

export type ModelPolicyAccount = Pick<
  PublicAccount,
  'id' | 'providerId' | 'availableModels' | 'modelsRefreshedAt' | 'modelPolicy' | 'modelAllowlist'
>

export interface AccountModelCatalog {
  models: string[]
  source: ModelCatalogSource
}

export interface PoolModelCoverage {
  model: string
  supportCount: number
  totalAccounts: number
}

export interface PoolModelCoverageSummary {
  options: PoolModelCoverage[]
  totalAccounts: number
  fallbackAccountCount: number
}

export function normalizeModelNames(models: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const candidate of models) {
    const model = candidate.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    normalized.push(model)
  }
  return normalized
}

export function accountModelCatalog(
  account: ModelPolicyAccount,
  providerModels: readonly string[] = [],
): AccountModelCatalog {
  if (account.modelsRefreshedAt !== undefined) {
    return {
      models: normalizeModelNames(account.availableModels),
      source: 'account',
    }
  }

  return {
    models: normalizeModelNames([...providerModels, ...account.modelAllowlist]),
    source: 'provider-fallback',
  }
}

export function effectiveAccountModels(
  account: ModelPolicyAccount,
  providerModels: readonly string[] = [],
): string[] {
  const catalog = accountModelCatalog(account, providerModels).models
  if (account.modelPolicy === 'all') return catalog
  const selected = new Set(normalizeModelNames(account.modelAllowlist))
  return catalog.filter((model) => selected.has(model))
}

export function isAccountModelWildcard(
  account: Pick<ModelPolicyAccount, 'modelPolicy' | 'modelsRefreshedAt'>,
): boolean {
  return account.modelPolicy === 'all' && account.modelsRefreshedAt === undefined
}

export function isPoolModelWildcard(
  pool: Pick<Pool, 'modelPolicy' | 'members'>,
  accounts: readonly Pick<ModelPolicyAccount, 'id' | 'modelPolicy' | 'modelsRefreshedAt'>[],
): boolean {
  if (pool.modelPolicy !== 'all') return false
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  return pool.members.some((member) => {
    const account = accountById.get(member.accountId)
    return Boolean(member.enabled && account && isAccountModelWildcard(account))
  })
}

export function buildPoolModelCoverage(
  accounts: readonly ModelPolicyAccount[],
  providerModelsFor: (providerId: string) => readonly string[] = () => [],
): PoolModelCoverageSummary {
  const support = new Map<string, number>()
  let fallbackAccountCount = 0

  for (const account of accounts) {
    const providerModels = providerModelsFor(account.providerId)
    if (accountModelCatalog(account, providerModels).source === 'provider-fallback') {
      fallbackAccountCount += 1
    }
    for (const model of effectiveAccountModels(account, providerModels)) {
      support.set(model, (support.get(model) ?? 0) + 1)
    }
  }

  const totalAccounts = accounts.length
  return {
    options: [...support.entries()]
      .map(([model, supportCount]) => ({ model, supportCount, totalAccounts }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    totalAccounts,
    fallbackAccountCount,
  }
}

export function effectivePoolModels(
  pool: Pick<Pool, 'modelPolicy' | 'modelAllowlist'>,
  coverage: readonly Pick<PoolModelCoverage, 'model'>[],
): string[] {
  const candidates = coverage.map((item) => item.model)
  if (pool.modelPolicy === 'all') return candidates
  const selected = new Set(normalizeModelNames(pool.modelAllowlist))
  return candidates.filter((model) => selected.has(model))
}

export function pruneModelSelection(selected: readonly string[], candidates: readonly string[]): string[] {
  const available = new Set(candidates)
  return normalizeModelNames(selected).filter((model) => available.has(model))
}

export function withExplicitModelPolicy(policy: ModelPolicy | undefined): ModelPolicy {
  return policy ?? 'all'
}
