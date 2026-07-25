import { supportsFastServiceTier } from './types'
import { accountPoolProtocol } from './pool-protocol'
import { providerSourceFamily } from './source-family'
import type {
  Account,
  Pool,
  PoolKind,
  PoolProtocol,
  ProviderDefinition,
  PublicAccount,
  UpstreamSourceType,
} from './types'

type RouteSourceAccount = Pick<Account, 'id' | 'providerId' | 'credentialType' | 'status' | 'updatedAt'>
type RouteSourceModelAccount = RouteSourceAccount & Pick<
  Account,
  'modelPolicy' | 'modelAllowlist' | 'availableModels' | 'modelsRefreshedAt'
>

export type RouteSourceKind = PoolKind | Exclude<UpstreamSourceType, 'oauth-system'>

export interface RouteSourceSummary {
  id: string
  name: string
  kind: RouteSourceKind
  protocol: PoolProtocol
  accountCount: number
}

export interface ResolvedRouteSource<TAccount extends RouteSourceAccount = RouteSourceAccount> {
  summary: RouteSourceSummary
  pool: Pool
  accounts: TAccount[]
  persistedPool?: Pool
  provider?: ProviderDefinition
}

export interface RouteSourceCollections<TAccount extends RouteSourceAccount = RouteSourceAccount> {
  pools: readonly Pool[]
  providers: readonly ProviderDefinition[]
  accounts: readonly TAccount[]
}

/**
 * Resolve the legacy Route.poolId field as a route source reference. A source
 * can be either a persisted pool (including aggregate relays), or a one-key
 * official/relay provider. Provider-backed pools are runtime-only and are
 * deliberately never written to the application snapshot or database.
 */
export function resolveRouteSource<TAccount extends RouteSourceAccount>(
  sourceId: string,
  collections: RouteSourceCollections<TAccount>,
): ResolvedRouteSource<TAccount> | undefined {
  if (!sourceId) return undefined
  const persistedPool = collections.pools.find((pool) => pool.id === sourceId)
  const provider = collections.providers.find((candidate) => candidate.id === sourceId)
  // A reference must never silently change meaning when corrupt/imported data
  // contains colliding provider and pool ids.
  if (persistedPool && provider) return undefined

  if (persistedPool) {
    const accountIds = new Set(
      persistedPool.members.filter((member) => member.enabled).map((member) => member.accountId),
    )
    const accounts = collections.accounts.filter((account) => accountIds.has(account.id))
    return {
      summary: {
        id: persistedPool.id,
        name: persistedPool.name,
        kind: persistedPool.kind,
        protocol: persistedPool.protocol,
        accountCount: accounts.length,
      },
      pool: persistedPool,
      accounts,
      persistedPool,
    }
  }

  if (!provider || (provider.sourceType !== 'official-api' && provider.sourceType !== 'relay')) {
    return undefined
  }
  const providerAccounts = collections.accounts.filter((account) => account.providerId === provider.id)
  if (providerAccounts.length !== 1 || providerAccounts[0].credentialType !== 'api-key') return undefined
  const account = providerAccounts[0]
  const logicalProtocol = accountPoolProtocol(account, provider)
  const pool: Pool = {
    id: provider.id,
    name: provider.name,
    kind: 'standard',
    protocol: logicalProtocol,
    strategy: 'priority',
    members: [{ accountId: account.id, enabled: true, order: 0, weight: 1 }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    forceFastMode: supportsFastServiceTier(provider.protocol) && provider.forceFastMode === true,
    createdAt: provider.createdAt,
    updatedAt: Math.max(provider.updatedAt, accountUpdatedAt(account)),
  }
  return {
    summary: {
      id: provider.id,
      name: provider.name,
      kind: provider.sourceType,
      protocol: logicalProtocol,
      accountCount: 1,
    },
    pool,
    accounts: [account],
    provider,
  }
}

/** Returns every valid route target. Temporarily unavailable sources remain
 * resolvable at runtime, but are omitted from new-selection menus by default. */
export function listRouteSources<TAccount extends RouteSourceAccount>(
  collections: RouteSourceCollections<TAccount>,
  options: { availableOnly?: boolean } = {},
): RouteSourceSummary[] {
  const availableOnly = options.availableOnly ?? true
  const ids = [
    ...collections.pools.map((pool) => pool.id),
    ...collections.providers.map((provider) => provider.id),
  ]
  const seen = new Set<string>()
  const result: RouteSourceSummary[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const resolved = resolveRouteSource(id, collections)
    if (!resolved) continue
    if (availableOnly && !resolved.accounts.some(isAvailableRouteAccount)) continue
    result.push(resolved.summary)
  }
  return result
}

/** Effective upstream models exposed by the currently enabled, available
 * members of one route source. Account selections remain authoritative over a
 * broader provider catalog. */
export function enumerateRouteSourceModels<TAccount extends RouteSourceModelAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): string[] {
  if (!source) return []
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  const models: string[] = []
  for (const account of source.accounts.filter(isAvailableRouteAccount)) {
    const providerModels = providersById.get(account.providerId)?.models ?? []
    const catalog = account.modelsRefreshedAt === undefined
      ? [...providerModels, ...account.modelAllowlist]
      : account.availableModels
    const allowed = account.modelPolicy === 'selected'
      ? new Set(account.modelAllowlist.map((model) => model.trim()).filter(Boolean))
      : undefined
    for (const candidate of catalog) {
      const model = candidate.trim()
      if (!model || allowed && !allowed.has(model) || models.includes(model)) continue
      models.push(model)
    }
  }
  if (source.pool.modelPolicy !== 'selected') return models
  const available = new Set(models)
  return source.pool.modelAllowlist
    .map((model) => model.trim())
    .filter((model, index, all) => Boolean(model) && available.has(model) && all.indexOf(model) === index)
}

/**
 * Grok Build is deliberately a Grok-only client. Logical Grok pools and
 * standalone xAI-compatible relays expose `protocol: grok`; older aggregate
 * relay records retain their concrete wire protocol, so validate their member
 * family explicitly instead of treating every Responses relay as Grok.
 */
export function isGrokRouteSource<TAccount extends RouteSourceAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): boolean {
  if (!source) return false
  if (source.summary.protocol === 'grok') return true
  if (source.pool.kind !== 'relay-aggregate' || source.accounts.length === 0) return false
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  return source.accounts.every((account) => {
    const provider = providersById.get(account.providerId)
    return provider?.sourceType === 'relay'
      && provider.protocol === source.pool.protocol
      && providerSourceFamily(provider.kind) === 'grok'
  })
}

/**
 * Grok Build speaks the Responses wire protocol natively. It may therefore
 * bind only to enabled Grok-family members whose providers also speak
 * OpenAI Responses on the wire; Chat-compatible Grok relays require a bridge
 * and are intentionally excluded from this native path.
 */
export function isNativeGrokRouteSource<TAccount extends RouteSourceAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): boolean {
  if (!source) return false
  const enabledAccountIds = new Set(
    source.pool.members.filter((member) => member.enabled).map((member) => member.accountId),
  )
  if (enabledAccountIds.size === 0) return false
  const accountsById = new Map(source.accounts.map((account) => [account.id, account]))
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  return [...enabledAccountIds].every((accountId) => {
    const account = accountsById.get(accountId)
    const provider = account ? providersById.get(account.providerId) : undefined
    return provider?.protocol === 'openai-responses'
      && providerSourceFamily(provider.kind) === 'grok'
  })
}

/** Adds only provider-backed virtual pools that are referenced by a route. */
export function appendRuntimeRouteSourcePools<TAccount extends RouteSourceAccount>(
  routeSourceIds: readonly string[],
  collections: RouteSourceCollections<TAccount>,
): Pool[] {
  const pools = [...collections.pools]
  const seen = new Set(pools.map((pool) => pool.id))
  for (const sourceId of routeSourceIds) {
    if (!sourceId) continue
    if (hasRouteSourceIdCollision(sourceId, collections)) {
      throw new Error('A route source id conflicts with an existing pool id.')
    }
    if (seen.has(sourceId)) continue
    const resolved = resolveRouteSource(sourceId, collections)
    if (!resolved?.provider) continue
    pools.push(resolved.pool)
    seen.add(sourceId)
  }
  return pools
}

export function hasRouteSourceIdCollision(
  sourceId: string,
  collections: Pick<RouteSourceCollections, 'pools' | 'providers'>,
): boolean {
  return collections.pools.some((pool) => pool.id === sourceId)
    && collections.providers.some((provider) => provider.id === sourceId)
}

export function isAvailableRouteAccount(account: Pick<Account | PublicAccount, 'status'>): boolean {
  return account.status !== 'disabled' && account.status !== 'expired'
}

function accountUpdatedAt(account: RouteSourceAccount): number {
  return account.updatedAt
}
