import { clientNativeProtocols, supportsFastServiceTier } from './types'
import { accountMatchesPoolProtocol, accountPoolProtocol } from './pool-protocol'
import { providerSourceFamily } from './source-family'
import {
  isRouteAccountBindable,
  isRouteAccountCurrentlySchedulable,
  routeAccountConcurrencyLimit,
  routeAccountInFlight,
} from './source-eligibility'
import type {
  Account,
  Pool,
  PoolKind,
  PoolProtocol,
  Protocol,
  ProviderDefinition,
  PublicAccount,
  RouteClient,
  UpstreamSourceType,
} from './types'

type RouteSourceAccount = Pick<
  Account,
  | 'id'
  | 'providerId'
  | 'credentialType'
  | 'status'
  | 'cooldownUntil'
  | 'inFlight'
  | 'maxConcurrency'
  | 'updatedAt'
>
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

export interface RouteSourceCompatibility {
  eligible: boolean
  inboundProtocol: Protocol
  sourceProtocol?: PoolProtocol
  mode: 'native' | 'translated' | 'kiro-claude' | 'unsupported'
  reason?: string
}

export type RouteSourceAvailability = 'all' | 'bindable' | 'schedulable'

export interface PoolCapacitySummary<TAccount extends RouteSourceAccount = RouteSourceAccount> {
  enabledAccounts: TAccount[]
  bindableAccounts: TAccount[]
  schedulableAccounts: TAccount[]
  inFlight: number
  capacity: number
}

export interface RouteSourceTopologyIndex<TAccount extends RouteSourceAccount = RouteSourceAccount> {
  accountsById: ReadonlyMap<string, TAccount>
  providersById: ReadonlyMap<string, ProviderDefinition>
  duplicateAccountIds: ReadonlySet<string>
  duplicateProviderIds: ReadonlySet<string>
}

/** Builds a first-wins index once and retains duplicate-id evidence. */
export function createRouteSourceTopologyIndex<TAccount extends RouteSourceAccount>(
  collections: Pick<RouteSourceCollections<TAccount>, 'accounts' | 'providers'>,
): RouteSourceTopologyIndex<TAccount> {
  const accountsById = new Map<string, TAccount>()
  const providersById = new Map<string, ProviderDefinition>()
  const duplicateAccountIds = new Set<string>()
  const duplicateProviderIds = new Set<string>()
  for (const account of collections.accounts) {
    if (accountsById.has(account.id)) duplicateAccountIds.add(account.id)
    else accountsById.set(account.id, account)
  }
  for (const provider of collections.providers) {
    if (providersById.has(provider.id)) duplicateProviderIds.add(provider.id)
    else providersById.set(provider.id, provider)
  }
  return { accountsById, providersById, duplicateAccountIds, duplicateProviderIds }
}

/**
 * Validates every declared member, including disabled members, against the
 * pool's persisted protocol and source-family boundary. Disabled corrupt
 * members must not become a latent bypass that activates when toggled later.
 *
 * `grok` is a logical protocol and therefore keeps its explicit account-level
 * rules. Every other relay-backed standard pool must match the concrete wire
 * protocol exactly; cross-wire conversion belongs at the route boundary, not
 * inside one pool. Relay aggregates retain the same exact-protocol rule.
 */
export function isRouteSourcePoolTopologyValid<TAccount extends RouteSourceAccount>(
  pool: Pick<Pool, 'kind' | 'protocol' | 'members'>,
  source: Pick<RouteSourceCollections<TAccount>, 'accounts' | 'providers'> | RouteSourceTopologyIndex<TAccount>,
): boolean {
  if (pool.members.length === 0) return false
  const index = 'accountsById' in source ? source : createRouteSourceTopologyIndex(source)
  const declared: Array<{ account: TAccount; provider: ProviderDefinition }> = []
  for (const member of pool.members) {
    if (index.duplicateAccountIds.has(member.accountId)) return false
    const account = index.accountsById.get(member.accountId)
    if (!account || index.duplicateProviderIds.has(account.providerId)) return false
    const provider = index.providersById.get(account.providerId)
    if (!provider) return false
    declared.push({ account, provider })
  }
  const families = new Set(declared.map(({ provider }) => providerSourceFamily(provider.kind)))
  if (families.size !== 1) return false

  if (pool.kind === 'relay-aggregate') {
    return declared.every(({ provider }) => (
      provider.sourceType === 'relay' && provider.protocol === pool.protocol
    ))
  }
  if (pool.protocol === 'grok') {
    return declared.every(({ account, provider }) => provider.sourceType === 'relay'
      ? account.credentialType === 'api-key'
        && providerSourceFamily(provider.kind) === 'grok'
        && accountPoolProtocol(account, provider) === 'grok'
      : accountMatchesPoolProtocol('grok', account, provider))
  }
  return declared.every(({ account, provider }) => provider.sourceType === 'relay'
    ? account.credentialType !== 'grok-oauth' && provider.protocol === pool.protocol
    : accountMatchesPoolProtocol(pool.protocol, account, provider))
}

/**
 * Accepts Kiro tool capability evidence only when it is paired with the
 * main-process-owned two-turn marker. A declared/probed capability profile by
 * itself is not proof that the structured tool round trip completed.
 */
export function hasVerifiedKiroToolBridge(
  provider: ProviderDefinition | undefined,
): boolean {
  const profile = provider?.capabilityProfile
  return provider?.sourceType === 'relay'
    && provider.kind === 'kiro-compatible'
    && provider.protocol === 'kiro-claude'
    && provider.toolRoundtripVerified === true
    && profile?.origin === 'probed'
    && typeof profile.checkedAt === 'number'
    && Number.isFinite(profile.checkedAt)
    && profile.checkedAt > 0
    && profile.toolCalls === true
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
    stickySessions: provider.protocol === 'kiro-claude',
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
  options: {
    /** @deprecated Use availability. Retained for UI/IPC compatibility. */
    availableOnly?: boolean
    availability?: RouteSourceAvailability
    client?: RouteClient
    now?: number
  } = {},
): RouteSourceSummary[] {
  const availability = options.availability ?? (options.availableOnly === false ? 'all' : 'bindable')
  const topologyIndex = createRouteSourceTopologyIndex(collections)
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
    if (!isRouteSourcePoolTopologyValid(resolved.pool, topologyIndex)) continue
    if (availability === 'bindable' && !resolved.accounts.some(isBindableRouteAccount)) continue
    if (availability === 'schedulable'
      && !resolved.accounts.some((account) => isCurrentlySchedulableRouteAccount(account, options.now))) continue
    if (options.client
      && !isRouteSourceEligibleForClient(options.client, resolved, collections, topologyIndex)) continue
    result.push(resolved.summary)
  }
  return result
}

/** Client-scoped route menu helper. The currently persisted selection should
 * be resolved separately so an invalid legacy selection can still be shown
 * with the reason returned by `analyzeRouteSourceCompatibility`. */
export function listRouteSourcesForClient<TAccount extends RouteSourceAccount>(
  client: RouteClient,
  collections: RouteSourceCollections<TAccount>,
  options: {
    /** @deprecated Use availability. Retained for UI/IPC compatibility. */
    availableOnly?: boolean
    availability?: RouteSourceAvailability
    now?: number
  } = {},
): RouteSourceSummary[] {
  return listRouteSources(collections, { ...options, client })
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

/**
 * A Kiro Claude route is fail-closed until every enabled relay member has
 * persisted evidence from the real tool round-trip probe. Merely selecting the
 * protocol or declaring tool support is intentionally insufficient.
 */
export function isKiroClaudeRouteSource<TAccount extends RouteSourceAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): boolean {
  if (!source || source.summary.protocol !== 'kiro-claude') return false
  if (source.pool.kind === 'relay-aggregate' && !source.pool.stickySessions) return false
  if (source.pool.kind !== 'relay-aggregate' && !source.provider) return false

  const enabledAccountIds = new Set(
    source.pool.members.filter((member) => member.enabled).map((member) => member.accountId),
  )
  if (enabledAccountIds.size === 0) return false
  const accountsById = new Map(source.accounts.map((account) => [account.id, account]))
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  return [...enabledAccountIds].every((accountId) => {
    const account = accountsById.get(accountId)
    const provider = account ? providersById.get(account.providerId) : undefined
    return hasVerifiedKiroToolBridge(provider)
  })
}

/**
 * Shared route/source authorization boundary. Renderers may use this to hide
 * invalid choices, while main-process callers must still enforce it on every
 * write path because route records are importable JSON payloads.
 */
export function isRouteSourceEligibleForClient<TAccount extends RouteSourceAccount>(
  client: RouteClient,
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'accounts' | 'providers'>,
  topologyIndex?: RouteSourceTopologyIndex<TAccount>,
): boolean {
  return analyzeRouteSourceCompatibility(client, source, collections, topologyIndex).eligible
}

/** Renderer-safe explanation paired with the main-process eligibility guard. */
export function analyzeRouteSourceCompatibility<TAccount extends RouteSourceAccount>(
  client: RouteClient,
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'accounts' | 'providers'>,
  topologyIndex?: RouteSourceTopologyIndex<TAccount>,
): RouteSourceCompatibility {
  const inboundProtocol = clientNativeProtocols[client]
  if (!source) {
    return { eligible: false, inboundProtocol, mode: 'unsupported', reason: 'Route source not found.' }
  }
  const sourceProtocol = source.summary.protocol
  if (!isRouteSourcePoolTopologyValid(source.pool, topologyIndex ?? collections)) {
    return {
      eligible: false,
      inboundProtocol,
      sourceProtocol,
      mode: 'unsupported',
      reason: 'Route source members must use one valid pool protocol and source family.',
    }
  }
  if (routeSourceUsesKiroClaude(source, collections)) {
    if (client !== 'claude') {
      return {
        eligible: false,
        inboundProtocol,
        sourceProtocol,
        mode: 'unsupported',
        reason: 'Kiro Claude sources are available only to Claude Code clients.',
      }
    }
    if (!isKiroClaudeRouteSource(source, collections)) {
      return {
        eligible: false,
        inboundProtocol,
        sourceProtocol,
        mode: 'unsupported',
        reason: 'Complete the Kiro Claude two-round tool test before binding this source.',
      }
    }
    return { eligible: true, inboundProtocol, sourceProtocol, mode: 'kiro-claude' }
  }
  if (routeSourceUsesDeepSeek(source, collections)
    && client !== 'codex'
    && client !== 'deepseek-harness') {
    return {
      eligible: false,
      inboundProtocol,
      sourceProtocol,
      mode: 'unsupported',
      reason: 'DeepSeek sources are available only to Codex and DeepSeek Harness clients.',
    }
  }
  if (client === 'grokbuild' && !isNativeGrokRouteSource(source, collections)) {
    return {
      eligible: false,
      inboundProtocol,
      sourceProtocol,
      mode: 'unsupported',
      reason: 'Grok Build requires a Responses-native Grok source.',
    }
  }
  return {
    eligible: true,
    inboundProtocol,
    sourceProtocol,
    mode: inboundProtocol === sourceProtocol ? 'native' : 'translated',
  }
}

/** Detect malformed Kiro-shaped records as restricted instead of allowing
 * them to fall through the ordinary compatibility path. */
export function routeSourceUsesKiroClaude<TAccount extends RouteSourceAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): boolean {
  if (!source) return false
  if (source.summary.protocol === 'kiro-claude'
    || source.provider?.kind === 'kiro-compatible'
    || source.provider?.protocol === 'kiro-claude') return true
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  return source.accounts.some((account) => {
    const provider = providersById.get(account.providerId)
    return provider?.kind === 'kiro-compatible' || provider?.protocol === 'kiro-claude'
  })
}

/** DeepSeek is restricted to clients with a complete DeepSeek tool bridge. */
export function routeSourceUsesDeepSeek<TAccount extends RouteSourceAccount>(
  source: ResolvedRouteSource<TAccount> | undefined,
  collections: Pick<RouteSourceCollections<TAccount>, 'providers'>,
): boolean {
  if (!source) return false
  if (source.provider && providerSourceFamily(source.provider.kind) === 'deepseek') return true
  const providersById = new Map(collections.providers.map((provider) => [provider.id, provider]))
  return source.accounts.length > 0 && source.accounts.every((account) => {
    const provider = providersById.get(account.providerId)
    return provider !== undefined && providerSourceFamily(provider.kind) === 'deepseek'
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

/** Long-lived binding predicate. Cooldowns/checks remain selectable and recover in place. */
export function isBindableRouteAccount(account: Pick<Account | PublicAccount, 'status'>): boolean {
  return isRouteAccountBindable(account)
}

/** Legacy name retained so existing UI/IPC writes keep their binding semantics. */
export function isAvailableRouteAccount(account: Pick<Account | PublicAccount, 'status'>): boolean {
  return isBindableRouteAccount(account)
}

/** Snapshot-level readiness used by diagnostics, not long-lived route authorization. */
export function isCurrentlySchedulableRouteAccount(
  account: Pick<Account | PublicAccount, 'status' | 'cooldownUntil' | 'inFlight' | 'maxConcurrency'>,
  now = Date.now(),
): boolean {
  return isRouteAccountCurrentlySchedulable(account, now)
}

/** Enabled membership is authoritative; duplicate/corrupt member ids count once. */
export function enabledPoolAccounts<TAccount extends Pick<Account | PublicAccount, 'id'>>(
  pool: Pick<Pool, 'members'>,
  accounts: readonly TAccount[],
): TAccount[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const seen = new Set<string>()
  return pool.members.flatMap((member) => {
    if (!member.enabled || seen.has(member.accountId)) return []
    const account = accountById.get(member.accountId)
    if (!account) return []
    seen.add(member.accountId)
    return [account]
  })
}

/** Shared pool-card/preview capacity semantics, excluding disabled membership. */
export function summarizePoolCapacity<TAccount extends RouteSourceAccount>(
  pool: Pick<Pool, 'members'>,
  accounts: readonly TAccount[],
  now = Date.now(),
): PoolCapacitySummary<TAccount> {
  const enabledAccounts = enabledPoolAccounts(pool, accounts)
  const bindableAccounts = enabledAccounts.filter(isBindableRouteAccount)
  const schedulableAccounts = bindableAccounts.filter((account) => (
    isCurrentlySchedulableRouteAccount(account, now)
  ))
  return {
    enabledAccounts,
    bindableAccounts,
    schedulableAccounts,
    inFlight: bindableAccounts.reduce((sum, account) => sum + routeAccountInFlight(account.inFlight), 0),
    capacity: bindableAccounts.reduce((sum, account) => (
      sum + routeAccountConcurrencyLimit(account.maxConcurrency)
    ), 0),
  }
}

function accountUpdatedAt(account: RouteSourceAccount): number {
  return account.updatedAt
}
