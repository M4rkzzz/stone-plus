import { randomUUID } from 'node:crypto'
import { supportsFastServiceTier, supportsPoolFastServiceTier } from '@shared/types'
import {
  buildModelCatalog,
  inferUpstreamCapabilities,
  normalizeCapabilityProfile,
  normalizeModelCatalog,
} from '@shared/source-capabilities'
import { providerSourceFamily, type ProviderSourceFamily } from '@shared/source-family'
import { accountMatchesPoolProtocol } from '@shared/pool-protocol'
import { hasVerifiedKiroToolBridge, isNativeGrokRouteSource, resolveRouteSource } from '@shared/route-sources'
import type {
  Account,
  AggregateRelayInput,
  ApiSourceInput,
  ApiSourceProbeResult,
  Pool,
  PoolProtocol,
  Protocol,
  ProviderDefinition,
  ProviderKind,
  ResponsesCompactMode,
  RouteSourceFastModeInput
} from '@shared/types'
import type { PersistedState } from '../store/types'

export type CredentialEncryptor = (credential: string) => string

export interface SavedApiSourceDraft {
  sourceId: string
  providerId: string
  accountId: string
  credentialId: string
  created: boolean
  credentialChanged: boolean
  connectionChanged: boolean
}

export interface DeletedApiSourceDraft {
  sourceId: string
  accountIds: string[]
  deletedAggregatePoolIds: string[]
}

export interface SavedAggregateRelayDraft {
  poolId: string
  created: boolean
}

export interface RouteSourceFastModeDraftResult {
  sourceId: string
  enabled: boolean
  target: 'pool' | 'relay'
}

export class SourcePoolCompatibilityError extends Error {
  constructor(readonly poolIds: string[]) {
    super('Change or remove incompatible pool memberships before changing the source protocol or family.')
    this.name = 'SourcePoolCompatibilityError'
  }
}

const OFFICIAL_SOURCES: Readonly<Partial<Record<ProviderKind, {
  baseUrl: string
  protocols: readonly Protocol[]
}>>> = Object.freeze({
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    protocols: ['openai-responses', 'openai-chat']
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    protocols: ['openai-responses']
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    protocols: ['anthropic-messages']
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocols: ['gemini']
  }
})

const RELAY_PROTOCOLS: Readonly<Partial<Record<ProviderKind, readonly Protocol[]>>> = Object.freeze({
  'openai-compatible': ['openai-responses', 'openai-chat'],
  'xai-compatible': ['openai-responses', 'openai-chat'],
  'anthropic-compatible': ['anthropic-messages'],
  'kiro-compatible': ['kiro-claude'],
  custom: ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini']
})

export function requiresApiSourceToolRoundtripEvidence(source: Pick<
  ProviderDefinition,
  'sourceType' | 'kind' | 'protocol'
>): boolean {
  return source.protocol === 'kiro-claude'
    || (source.sourceType === 'relay'
      && source.kind === 'anthropic-compatible'
      && source.protocol === 'anthropic-messages')
}

export function hasSuccessfulApiSourceToolRoundtrip(
  result: Pick<ApiSourceProbeResult, 'ok' | 'capabilityProfile' | 'toolRoundtrip'>,
): boolean {
  const profile = result.capabilityProfile
  const diagnostics = result.toolRoundtrip
  return result.ok
    && profile.origin === 'probed'
    && typeof profile.checkedAt === 'number'
    && Number.isFinite(profile.checkedAt)
    && profile.checkedAt > 0
    && profile.toolCalls === true
    && diagnostics !== undefined
    && diagnostics.firstTurn.toolsCount === 1
    && diagnostics.firstTurn.toolUseCount === 1
    && diagnostics.firstTurn.stopReason === 'tool_use'
    && diagnostics.secondTurn.toolResultCount === 1
    && diagnostics.secondTurn.toolUseCount === 0
    && diagnostics.secondTurn.stopReason === 'end_turn'
}

/** Mutates a transactional PersistedState draft after validating the complete change. */
export function saveApiSourceDraft(
  state: PersistedState,
  input: ApiSourceInput,
  encrypt: CredentialEncryptor,
  now = Date.now()
): SavedApiSourceDraft {
  const timestamp = validTimestamp(now)
  const name = requiredName(input.name, 'Source name')
  const sourceConfiguration = normalizeSourceConfiguration(input)
  const models = normalizeModels(input.models)
  const defaultModel = normalizeOptionalModel(input.defaultModel)
  if (defaultModel) moveModelToFront(models, defaultModel)
  if (sourceConfiguration.protocol === 'kiro-claude' && models.length === 0) {
    throw new Error('Kiro Claude relay sources require a manually configured model.')
  }
  const proxyId = optionalProxyId(input.proxyId, state)

  const existingProvider = input.id
    ? state.providers.find((provider) => provider.id === input.id)
    : undefined
  if (input.id && !existingProvider) throw new Error('API source not found.')
  if (existingProvider?.sourceType === 'oauth-system') {
    throw new Error('The system OAuth source cannot be edited as an API source.')
  }

  const existingAccounts = existingProvider
    ? state.accounts.filter((account) => account.providerId === existingProvider.id)
    : []
  if (existingAccounts.some((account) => account.credentialType === 'chatgpt-oauth'
    || account.credentialType === 'chatgpt-agent-identity'
    || account.credentialType === 'grok-oauth')) {
    throw new Error('OAuth accounts cannot be converted into API-key sources.')
  }
  if (existingAccounts.length > 1) {
    throw new Error('This source has multiple accounts and must be migrated before it can be edited.')
  }
  const existingAccount = existingAccounts[0]
  const responsesCompactMode = resolveResponsesCompactModeInput(
    input.responsesCompactMode,
    existingProvider?.responsesCompactMode,
    input.sourceType,
    sourceConfiguration.protocol
  )

  const suppliedCredential = input.credential?.trim() || undefined
  if (!existingAccount && !suppliedCredential) throw new Error('An API Key is required for a new source.')
  const trustBoundaryChanged = existingProvider !== undefined && (
    existingProvider.sourceType !== input.sourceType
    || providerSourceFamily(existingProvider.kind) !== providerSourceFamily(sourceConfiguration.kind)
  )
  if (existingAccount && trustBoundaryChanged && !suppliedCredential) {
    throw new Error('Enter the API Key again when changing the source type or family.')
  }
  if (existingAccount && !suppliedCredential && !state.credentials[existingAccount.credentialId]) {
    throw new Error('The stored API Key is unavailable; enter it again before saving.')
  }
  const protocolChanged = existingProvider !== undefined
    && existingProvider.protocol !== sourceConfiguration.protocol
  const familyChanged = existingProvider !== undefined
    && providerSourceFamily(existingProvider.kind) !== providerSourceFamily(sourceConfiguration.kind)
  if ((protocolChanged || familyChanged || trustBoundaryChanged) && existingAccount) {
    const nextFamily = providerSourceFamily(sourceConfiguration.kind)
    const incompatiblePoolIds = state.pools
      .filter((pool) => pool.members.some((member) => member.accountId === existingAccount.id))
      .filter((pool) => !poolAcceptsSourceChange(
        pool,
        existingAccount.id,
        sourceConfiguration.protocol,
        nextFamily,
        input.sourceType,
        state,
      ))
      .map((pool) => pool.id)
    if (incompatiblePoolIds.length > 0) {
      if (!input.unlinkIncompatiblePools) throw new SourcePoolCompatibilityError(incompatiblePoolIds)
      unlinkIncompatiblePoolMemberships(
        state,
        existingAccount.id,
        sourceConfiguration.protocol,
        nextFamily,
        input.sourceType,
        timestamp,
      )
    }
  }

  const encryptedCredential = suppliedCredential === undefined ? undefined : encryptCredential(encrypt, suppliedCredential)
  const providerId = existingProvider?.id ?? randomUUID()
  const accountId = existingAccount?.id ?? randomUUID()
  const credentialId = existingAccount?.credentialId ?? randomUUID()

  const credentialChanged = suppliedCredential !== undefined
  const requiresToolRoundtripEvidence = requiresApiSourceToolRoundtripEvidence({
    sourceType: input.sourceType,
    kind: sourceConfiguration.kind,
    protocol: sourceConfiguration.protocol,
  })
  const toolRoundtripModelChanged = requiresToolRoundtripEvidence
    && existingProvider !== undefined
    && existingProvider.models[0] !== models[0]
  const connectionChanged = !existingProvider
    || !existingAccount
    || existingProvider.sourceType !== input.sourceType
    || existingProvider.kind !== sourceConfiguration.kind
    || existingProvider.baseUrl !== sourceConfiguration.baseUrl
    || existingProvider.protocol !== sourceConfiguration.protocol
    || existingAccount.proxyId !== proxyId
    || credentialChanged
    || toolRoundtripModelChanged
  const capabilityConfigurationChanged = connectionChanged
    || existingProvider?.responsesCompactMode !== responsesCompactMode

  const inferredCapabilities = inferUpstreamCapabilities({
    protocol: sourceConfiguration.protocol,
    kind: sourceConfiguration.kind,
    sourceType: input.sourceType,
    responsesCompactMode,
    ...(requiresToolRoundtripEvidence
      ? {
          ...(sourceConfiguration.protocol === 'kiro-claude' ? { modelDiscovery: false } : {}),
          toolCalls: false,
        }
      : {}),
  })
  // A newly created source may carry the successful probe performed against
  // the exact unsaved draft. Connection edits still discard renderer-supplied
  // evidence and must use the main-process persistent probe revision flow.
  const acceptsInitialProbe = !existingProvider
    && !existingAccount
    && input.capabilityProfile?.origin === 'probed'
    && typeof input.capabilityProfile.checkedAt === 'number'
  let capabilityProfile = normalizeCapabilityProfile(
    capabilityConfigurationChanged && !acceptsInitialProbe
      ? undefined
      : input.capabilityProfile ?? existingProvider?.capabilityProfile,
    inferredCapabilities,
  )
  const toolRoundtripVerified = requiresToolRoundtripEvidence && (
    (acceptsInitialProbe
      && input.toolRoundtripVerified === true
      && input.capabilityProfile?.toolCalls === true)
    || (!capabilityConfigurationChanged && existingProvider?.toolRoundtripVerified === true)
  )
  if (requiresToolRoundtripEvidence) {
    capabilityProfile = { ...capabilityProfile, toolCalls: toolRoundtripVerified }
  }
  let modelCatalog = (acceptsInitialProbe || !capabilityConfigurationChanged) && input.modelCatalog
    ? normalizeModelCatalog(input.modelCatalog, models, capabilityProfile)
    : capabilityConfigurationChanged
      ? buildModelCatalog(models, capabilityProfile)
      : normalizeModelCatalog(existingProvider?.modelCatalog, models, capabilityProfile)
  if (requiresToolRoundtripEvidence) {
    modelCatalog = modelCatalog.map((model) => ({
      ...model,
      capabilities: { ...model.capabilities, toolCalls: toolRoundtripVerified },
    }))
  }

  const provider: ProviderDefinition = {
    id: providerId,
    name,
    sourceType: input.sourceType,
    kind: sourceConfiguration.kind,
    baseUrl: sourceConfiguration.baseUrl,
    protocol: sourceConfiguration.protocol,
    models,
    icon: existingProvider?.icon,
    color: existingProvider?.color,
    forceFastMode: input.sourceType === 'relay'
      && supportsFastServiceTier(sourceConfiguration.protocol)
      && existingProvider?.forceFastMode === true,
    ...(responsesCompactMode ? { responsesCompactMode } : {}),
    capabilityProfile,
    ...(requiresToolRoundtripEvidence ? { toolRoundtripVerified } : {}),
    modelCatalog,
    createdAt: existingProvider?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  const account = buildApiSourceAccount({
    existing: existingAccount,
    accountId,
    providerId,
    credentialId,
    name,
    suppliedCredential,
    defaultModel,
    proxyId,
    input,
    preserveRelayModelPolicy: existingProvider?.sourceType === 'relay'
      && input.sourceType === 'relay',
    connectionChanged,
    timestamp
  })

  if (existingProvider) replaceById(state.providers, provider)
  else state.providers.push(provider)
  if (existingAccount) replaceById(state.accounts, account)
  else state.accounts.push(account)
  if (encryptedCredential !== undefined) state.credentials[credentialId] = encryptedCredential
  if (existingAccount && sourceConfiguration.protocol === 'kiro-claude' && connectionChanged) {
    disableKiroSourceBindingsDraft(state, providerId, timestamp)
  }
  assertBoundGrokBuildSource(state, providerId)

  return {
    sourceId: providerId,
    providerId,
    accountId,
    credentialId,
    created: !existingProvider,
    credentialChanged,
    connectionChanged
  }
}

function unlinkIncompatiblePoolMemberships(
  state: PersistedState,
  accountId: string,
  nextProtocol: Protocol,
  nextFamily: ProviderSourceFamily,
  nextSourceType: ApiSourceInput['sourceType'],
  timestamp: number
): void {
  const deletedPoolIds = new Set<string>()
  state.pools = state.pools.flatMap((pool) => {
    if (!pool.members.some((member) => member.accountId === accountId)
      || poolAcceptsSourceChange(pool, accountId, nextProtocol, nextFamily, nextSourceType, state)) return [pool]
    const members = pool.members.filter((member) => member.accountId !== accountId)
    if ((pool.kind === 'relay-aggregate' && members.length < 2) || members.length === 0) {
      deletedPoolIds.add(pool.id)
      return []
    }
    return [{
      ...pool,
      members: pool.kind === 'relay-aggregate'
        ? members.sort(memberOrder).map((member, order) => ({ ...member, order }))
        : members,
      modelAllowlist: pool.modelPolicy === 'selected'
        ? trimPoolModelAllowlist(pool.modelAllowlist, members, state.accounts, state.providers)
        : [],
      updatedAt: timestamp
    }]
  })
  state.routes = state.routes.map((route) => deletedPoolIds.has(route.poolId)
    ? { ...route, enabled: false, poolId: '', updatedAt: timestamp }
    : route)
}

function poolAcceptsSourceChange(
  pool: Pool,
  accountId: string,
  nextProtocol: Protocol,
  nextFamily: ProviderSourceFamily,
  nextSourceType: ApiSourceInput['sourceType'],
  state: PersistedState,
): boolean {
  if (pool.kind === 'relay-aggregate') {
    if (pool.protocol !== nextProtocol || nextSourceType !== 'relay') return false
  } else {
    const nextPoolProtocol: PoolProtocol = nextFamily === 'grok' ? 'grok' : nextProtocol
    if (pool.protocol !== nextPoolProtocol || nextSourceType === 'relay') return false
  }
  return pool.members
    .filter((member) => member.accountId !== accountId)
    .every((member) => {
      const account = state.accounts.find((candidate) => candidate.id === member.accountId)
      const provider = state.providers.find((candidate) => candidate.id === account?.providerId)
      if (!account || !provider || providerSourceFamily(provider.kind) !== nextFamily) return false
      return pool.kind === 'relay-aggregate'
        ? provider.sourceType === 'relay' && provider.protocol === pool.protocol
        : accountMatchesPoolProtocol(pool.protocol, account, provider)
    })
}

/**
 * Cascades a source deletion through its account, credential and pool members.
 * Aggregate relays that would have fewer than two members are removed and their
 * routes are disabled while preserving the local route token.
 */
export function deleteApiSourceDraft(
  state: PersistedState,
  sourceId: string,
  now = Date.now()
): DeletedApiSourceDraft {
  const timestamp = validTimestamp(now)
  const provider = state.providers.find((candidate) => candidate.id === sourceId)
  if (!provider) throw new Error('API source not found.')
  if (provider.sourceType === 'oauth-system') throw new Error('The system OAuth source cannot be deleted here.')
  const accounts = state.accounts.filter((account) => account.providerId === sourceId)
  if (accounts.some((account) => account.credentialType === 'chatgpt-oauth'
    || account.credentialType === 'chatgpt-agent-identity'
    || account.credentialType === 'grok-oauth')) {
    throw new Error('OAuth accounts must be managed from the account page.')
  }
  const accountIds = accounts.map((account) => account.id)
  const accountIdSet = new Set(accountIds)
  const remainingAccounts = state.accounts.filter((account) => !accountIdSet.has(account.id))
  const remainingProviders = state.providers.filter((candidate) => candidate.id !== sourceId)
  const deletedAggregatePoolIds: string[] = []
  const deletedPoolIds = new Set<string>()
  const pools: Pool[] = []

  for (const pool of state.pools) {
    const members = pool.members.filter((member) => !accountIdSet.has(member.accountId))
    if (members.length === pool.members.length) {
      pools.push(pool)
      continue
    }
    if (pool.kind === 'relay-aggregate' && members.length < 2) {
      deletedAggregatePoolIds.push(pool.id)
      deletedPoolIds.add(pool.id)
      continue
    }
    if (pool.kind === 'standard' && members.length === 0) {
      deletedPoolIds.add(pool.id)
      continue
    }
    pools.push({
      ...pool,
      members: pool.kind === 'relay-aggregate'
        ? members
          .sort(memberOrder)
          .map((member, order) => ({ ...member, order }))
        : members,
      modelAllowlist: pool.modelPolicy === 'selected'
        ? trimPoolModelAllowlist(pool.modelAllowlist, members, remainingAccounts, remainingProviders)
        : [],
      updatedAt: timestamp
    })
  }

  state.providers = remainingProviders
  state.accounts = remainingAccounts
  state.pools = pools
  state.routes = state.routes.map((route) => route.poolId === sourceId || deletedPoolIds.has(route.poolId)
    ? { ...route, enabled: false, poolId: '', updatedAt: timestamp }
    : route)
  for (const account of accounts) delete state.credentials[account.credentialId]

  return { sourceId, accountIds, deletedAggregatePoolIds }
}

/** Mutates a transactional PersistedState draft after validating every aggregate member. */
export function saveAggregateRelayDraft(
  state: PersistedState,
  input: AggregateRelayInput,
  now = Date.now()
): SavedAggregateRelayDraft {
  const timestamp = validTimestamp(now)
  const name = requiredName(input.name, 'Aggregate relay name')
  const existing = input.id ? state.pools.find((pool) => pool.id === input.id) : undefined
  if (input.id && !existing) throw new Error('Aggregate relay not found.')
  if (existing && existing.kind !== 'relay-aggregate') {
    throw new Error('A standard pool cannot be converted into an aggregate relay.')
  }
  if (!['priority', 'round-robin', 'weighted-round-robin'].includes(input.strategy)) {
    throw new Error('Unsupported aggregate relay strategy.')
  }
  const proxyId = optionalProxyId(input.proxyId, state)
  const normalizedMembers = normalizeAggregateMembers(input, state)
  const stickyTtlMinutes = boundedInteger(input.stickyTtlMinutes, 1, 1_440, 'Sticky TTL')
  const maxRetries = boundedInteger(input.maxRetries, 0, 10, 'Maximum retries')
  const pool: Pool = {
    id: existing?.id ?? randomUUID(),
    name,
    kind: 'relay-aggregate',
    protocol: input.protocol,
    strategy: input.strategy,
    members: normalizedMembers,
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: input.protocol === 'kiro-claude' || Boolean(input.stickySessions),
    stickyTtlMinutes,
    maxRetries,
    forceFastMode: supportsFastServiceTier(input.protocol) && existing?.forceFastMode === true,
    quotaProtection: input.quotaProtection ?? existing?.quotaProtection,
    proxyId,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  if (existing) replaceById(state.pools, pool)
  else state.pools.push(pool)
  if (existing && aggregateEditInvalidatesKiroRoute(existing, pool)) {
    state.routes = state.routes.map((route) => route.enabled && route.poolId === pool.id
      ? { ...route, enabled: false, updatedAt: timestamp }
      : route)
  }
  assertBoundGrokBuildSource(state, pool.id)
  return { poolId: pool.id, created: !existing }
}

/**
 * Atomically toggles FAST for a persisted pool or one standalone relay source.
 * Enabling is deliberately rejected for protocols that do not define OpenAI's
 * service_tier field; disabling remains allowed so imported/corrupt state can
 * always be repaired safely.
 */
export function setRouteSourceFastModeDraft(
  state: PersistedState,
  input: RouteSourceFastModeInput,
  now = Date.now()
): RouteSourceFastModeDraftResult {
  const timestamp = validTimestamp(now)
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
  if (!sourceId) throw new Error('A pool or relay source is required.')
  if (typeof input.enabled !== 'boolean') throw new Error('FAST mode must be enabled or disabled explicitly.')

  const pool = state.pools.find((candidate) => candidate.id === sourceId)
  const provider = state.providers.find((candidate) => candidate.id === sourceId)
  if (pool && provider) throw new Error('The source id conflicts with an existing pool id.')

  if (pool) {
    assertFastProtocol(pool.protocol, input.enabled)
    if (pool.forceFastMode !== input.enabled) {
      replaceById(state.pools, { ...pool, forceFastMode: input.enabled, updatedAt: timestamp })
    }
    return { sourceId, enabled: input.enabled, target: 'pool' }
  }

  if (!provider) throw new Error('Pool or relay source not found.')
  if (provider.sourceType === 'oauth-system') {
    throw new Error('The system OAuth source cannot be configured as a standalone FAST relay.')
  }
  if (provider.sourceType !== 'relay') {
    throw new Error('FAST can be toggled directly only for relay sources; use a pool for other sources.')
  }
  assertFastProtocol(provider.protocol, input.enabled)
  if (provider.forceFastMode !== input.enabled) {
    replaceById(state.providers, { ...provider, forceFastMode: input.enabled, updatedAt: timestamp })
  }
  return { sourceId, enabled: input.enabled, target: 'relay' }
}

function assertFastProtocol(protocol: PoolProtocol, enabled: boolean): void {
  if (enabled && !supportsPoolFastServiceTier(protocol)) {
    throw new Error('FAST is supported only by OpenAI Responses and OpenAI Chat sources.')
  }
}

function isResponsesCompactMode(value: unknown): value is ResponsesCompactMode {
  return value === 'auto' || value === 'legacy' || value === 'passthrough' || value === 'native'
}

function resolveResponsesCompactModeInput(
  requested: unknown,
  existing: unknown,
  sourceType: ApiSourceInput['sourceType'],
  protocol: Protocol
): ResponsesCompactMode | undefined {
  const supported = sourceType === 'relay' && protocol === 'openai-responses'
  if (requested !== undefined) {
    if (!isResponsesCompactMode(requested)) {
      throw new Error('Responses compact mode must be auto, legacy, passthrough, or native.')
    }
    if (!supported) {
      throw new Error('Responses compact mode can be configured only for OpenAI Responses relay sources.')
    }
    return requested
  }
  // Preserve an existing explicit relay capability when an older renderer
  // edits unrelated fields, while clearing it on a source/protocol change.
  return supported ? (isResponsesCompactMode(existing) ? existing : 'auto') : undefined
}

function normalizeSourceConfiguration(input: ApiSourceInput): {
  kind: ProviderKind
  protocol: Protocol
  baseUrl: string
} {
  if (input.sourceType === 'official-api') {
    const definition = OFFICIAL_SOURCES[input.kind]
    if (!definition) throw new Error('Official API sources support OpenAI, xAI, Anthropic, or Google only.')
    if (!definition.protocols.includes(input.protocol)) {
      throw new Error(`${input.kind} does not support the ${input.protocol} protocol.`)
    }
    return { kind: input.kind, protocol: input.protocol, baseUrl: definition.baseUrl }
  }
  if (input.sourceType !== 'relay') throw new Error('OAuth system sources cannot be saved as API-key sources.')
  const protocols = RELAY_PROTOCOLS[input.kind]
  if (!protocols) throw new Error('Relay sources must use a compatible or custom provider type.')
  if (!protocols.includes(input.protocol)) {
    throw new Error(`${input.kind} does not support the ${input.protocol} protocol.`)
  }
  return {
    kind: input.kind,
    protocol: input.protocol,
    baseUrl: input.protocol === 'kiro-claude'
      ? normalizeExactEndpoint(input.baseUrl)
      : normalizeUrl(input.baseUrl)
  }
}

function buildApiSourceAccount(input: {
  existing: Account | undefined
  accountId: string
  providerId: string
  credentialId: string
  name: string
  suppliedCredential: string | undefined
  defaultModel: string | undefined
  proxyId: string | undefined
  input: ApiSourceInput
  preserveRelayModelPolicy: boolean
  connectionChanged: boolean
  timestamp: number
}): Account {
  const existing = input.existing
  const preserveRelayModelPolicy = input.preserveRelayModelPolicy && existing !== undefined
  return {
    id: input.accountId,
    providerId: input.providerId,
    name: input.name,
    credentialId: input.credentialId,
    maskedCredential: input.suppliedCredential
      ? maskCredential(input.suppliedCredential)
      : existing?.maskedCredential ?? '',
    credentialType: 'api-key',
    status: input.connectionChanged ? 'active' : existing?.status ?? 'active',
    priority: positiveInteger(input.input.priority, 1),
    weight: positiveInteger(input.input.weight, 1),
    maxConcurrency: positiveInteger(input.input.maxConcurrency, 1),
    inFlight: input.connectionChanged ? 0 : existing?.inFlight ?? 0,
    availableModels: input.connectionChanged ? [] : existing?.availableModels ?? [],
    modelsRefreshedAt: input.connectionChanged ? undefined : existing?.modelsRefreshedAt,
    // The probe/default model is connection-test input, not an authorization
    // decision. Relay catalogs stay open unless the user explicitly restricts
    // the account later through the account model-policy editor.
    modelPolicy: input.input.sourceType === 'relay'
      ? preserveRelayModelPolicy ? existing.modelPolicy : 'all'
      : input.defaultModel ? 'selected' : 'all',
    modelAllowlist: input.input.sourceType === 'relay'
      ? preserveRelayModelPolicy ? [...existing.modelAllowlist] : []
      : input.defaultModel ? [input.defaultModel] : [],
    proxyId: input.proxyId,
    quotaRemaining: input.connectionChanged ? undefined : existing?.quotaRemaining,
    quotaUnit: input.connectionChanged ? undefined : existing?.quotaUnit,
    quota: input.connectionChanged ? undefined : existing?.quota,
    codexQuota: undefined,
    cooldownUntil: input.connectionChanged ? undefined : existing?.cooldownUntil,
    cooldownReason: input.connectionChanged ? undefined : existing?.cooldownReason,
    circuitState: input.connectionChanged ? 'closed' : existing?.circuitState ?? 'closed',
    consecutiveFailures: input.connectionChanged ? 0 : existing?.consecutiveFailures ?? 0,
    latencyMs: input.connectionChanged ? undefined : existing?.latencyMs,
    lastUsedAt: input.connectionChanged ? undefined : existing?.lastUsedAt,
    lastError: input.connectionChanged ? undefined : existing?.lastError,
    createdAt: existing?.createdAt ?? input.timestamp,
    updatedAt: input.timestamp
  }
}

function normalizeAggregateMembers(input: AggregateRelayInput, state: PersistedState): Pool['members'] {
  if (input.members.length < 2) throw new Error('An aggregate relay requires at least two members.')
  const accountIds = new Set<string>()
  const orders = new Set<number>()
  let aggregateFamily: ProviderSourceFamily | undefined
  const indexed = input.members.map((member, index) => {
    const accountId = member.accountId.trim()
    if (!accountId || accountIds.has(accountId)) throw new Error('Aggregate relay members must be unique.')
    accountIds.add(accountId)
    const account = state.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('One of the selected aggregate relay members no longer exists.')
    if (account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity' || account.credentialType === 'grok-oauth') {
      throw new Error('OAuth accounts cannot be aggregate relay members.')
    }
    const provider = state.providers.find((candidate) => candidate.id === account.providerId)
    if (!provider || provider.sourceType !== 'relay') {
      throw new Error('Aggregate relay members must be relay API-key sources.')
    }
    if (provider.protocol !== input.protocol) {
      throw new Error('Every aggregate relay member must use the aggregate protocol.')
    }
    if (input.protocol === 'kiro-claude' && !hasVerifiedKiroToolBridge(provider)) {
      throw new Error('Every enabled Kiro Claude aggregate member must pass the two-turn tool probe.')
    }
    const family = providerSourceFamily(provider.kind)
    if (aggregateFamily !== undefined && aggregateFamily !== family) {
      throw new Error('Every aggregate relay member must use the same source family.')
    }
    aggregateFamily = family
    if (!Number.isInteger(member.order) || member.order < 0 || orders.has(member.order)) {
      throw new Error('Aggregate relay member order must be unique non-negative integers.')
    }
    orders.add(member.order)
    const weight = boundedInteger(member.weight, 1, 100, 'Aggregate member weight')
    return { accountId, order: member.order, weight, index }
  })
  return indexed
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((member, order) => ({ accountId: member.accountId, enabled: true, order, weight: member.weight }))
}

function aggregateEditInvalidatesKiroRoute(existing: Pool, replacement: Pool): boolean {
  if (existing.protocol !== 'kiro-claude') return false
  if (replacement.protocol !== 'kiro-claude') return true
  const existingAccountIds = existing.members.map((member) => member.accountId).sort()
  const replacementAccountIds = replacement.members.map((member) => member.accountId).sort()
  return !sameStrings(existingAccountIds, replacementAccountIds)
}

/** Fail-closed binding invalidation shared by connection edits and failed
 * persistent Kiro capability probes. Source and pool ids remain intact so the
 * renderer can explain the disabled selection and the user can retry it. */
export function disableKiroSourceBindingsDraft(
  state: PersistedState,
  providerId: string,
  timestamp: number,
): void {
  const accountIds = new Set(state.accounts
    .filter((account) => account.providerId === providerId)
    .map((account) => account.id))
  const invalidatedSourceIds = new Set([providerId])
  state.pools = state.pools.map((pool) => {
    if (pool.kind !== 'relay-aggregate'
      || pool.protocol !== 'kiro-claude'
      || !pool.members.some((member) => accountIds.has(member.accountId))) return pool
    invalidatedSourceIds.add(pool.id)
    const members = pool.members.map((member) => accountIds.has(member.accountId)
      ? { ...member, enabled: false }
      : member)
    return members.some((member, index) => member.enabled !== pool.members[index]?.enabled)
      ? { ...pool, members, updatedAt: timestamp }
      : pool
  })
  state.routes = state.routes.map((route) => route.enabled && invalidatedSourceIds.has(route.poolId)
    ? { ...route, enabled: false, updatedAt: timestamp }
    : route)
}

/**
 * Source editors run independently from the route editor. A Grok Build route
 * therefore has to be revalidated inside the same transaction whenever its
 * bound source is rewritten, otherwise a family/protocol edit could leave the
 * saved route pointing at an ordinary OpenAI source until the next UI visit.
 */
function assertBoundGrokBuildSource(state: PersistedState, sourceId: string): void {
  if (!state.routes.some((route) => route.client === 'grokbuild' && route.poolId === sourceId)) return
  if (!isNativeGrokRouteSource(resolveRouteSource(sourceId, state), state)) {
    throw new Error('A source used by Grok Build must remain a Responses-native Grok account pool or relay source.')
  }
}

function trimPoolModelAllowlist(
  models: readonly string[],
  members: readonly Pool['members'][number][],
  accounts: readonly Account[],
  providers: readonly ProviderDefinition[]
): string[] {
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const available = new Set<string>()
  for (const member of members) {
    if (!member.enabled) continue
    const account = accountsById.get(member.accountId)
    if (!account) continue
    if (account.modelPolicy === 'selected') {
      for (const model of account.modelAllowlist) available.add(model)
      continue
    }
    const catalog = account.modelsRefreshedAt === undefined
      ? providersById.get(account.providerId)?.models ?? []
      : account.availableModels
    for (const model of catalog) available.add(model)
  }
  return models.filter((model) => available.has(model))
}

function normalizeUrl(value: string): string {
  return validatedSourceUrl(value).toString().replace(/\/$/, '')
}

function normalizeExactEndpoint(value: string): string {
  return validatedSourceUrl(value).toString()
}

function validatedSourceUrl(value: string): URL {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Source URLs must use HTTP or HTTPS.')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('Source URLs must use HTTPS unless they are local.')
  }
  if (url.username || url.password) throw new Error('Credentials cannot be embedded in the source URL.')
  if (url.search || url.hash) throw new Error('Source base URLs cannot contain a query string or fragment.')
  return url
}

function optionalProxyId(value: string | undefined, state: PersistedState): string | undefined {
  const id = value?.trim()
  if (!id) return undefined
  if (!state.proxies.some((proxy) => proxy.id === id)) throw new Error('Choose an existing proxy.')
  return id
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const model = normalizeOptionalModel(candidate)
    if (!model || seen.has(model)) continue
    seen.add(model)
    result.push(model)
  }
  return result
}

/**
 * ProviderDefinition has no separate default-model field. Keep the selected
 * probe/default model at index zero so it survives restarts and can invalidate
 * model-specific tool evidence without changing the persisted schema. The
 * remaining catalog order stays stable.
 */
function moveModelToFront(models: string[], defaultModel: string): void {
  const existingIndex = models.indexOf(defaultModel)
  if (existingIndex >= 0) models.splice(existingIndex, 1)
  models.unshift(defaultModel)
}

function normalizeOptionalModel(value: string | undefined): string | undefined {
  const model = value?.trim()
  if (!model) return undefined
  if (model.length > 256 || hasControlCharacters(model)) throw new Error('The model name is invalid.')
  return model
}

function requiredName(value: string, label: string): string {
  const name = value.trim()
  if (!name) throw new Error(`${label} is required.`)
  if (name.length > 120 || hasControlCharacters(name)) throw new Error(`${label} is invalid.`)
  return name
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return value
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('A valid state-change timestamp is required.')
  return value
}

function encryptCredential(encrypt: CredentialEncryptor, credential: string): string {
  const encrypted = encrypt(credential)
  if (typeof encrypted !== 'string' || !encrypted) throw new Error('The API Key could not be encrypted.')
  return encrypted
}

function maskCredential(credential: string): string {
  return credential.length <= 4 ? '****' : `****${credential.slice(-4)}`
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function memberOrder(left: Pool['members'][number], right: Pool['members'][number]): number {
  return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
}

function replaceById<T extends { id: string }>(values: T[], replacement: T): void {
  const index = values.findIndex((value) => value.id === replacement.id)
  if (index < 0) throw new Error('The state changed before the update could be applied.')
  values[index] = replacement
}
