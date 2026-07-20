import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import { valid as validSemver } from 'semver'
import { clientNativeProtocols, supportsFastServiceTier } from '@shared/types'
import { summarizeAccountCodexQuotaCycleCosts, summarizeOpenAiTokenCosts } from '@shared/openai-pricing'
import {
  appendRuntimeRouteSourcePools,
  hasRouteSourceIdCollision,
  isAvailableRouteAccount,
  resolveRouteSource,
} from '@shared/route-sources'
import type {
  Account,
  AccountCodexQuotaSnapshot,
  AccountInput,
  AccountQuotaSnapshot,
  AccountTagAssignmentInput,
  AccountTagDefinition,
  AccountTagInput,
  AggregateRelayInput,
  ApiSourceInput,
  AppSnapshot,
  ClientConfigProfile,
  ClientConfigProfileInput,
  ChatGptAccountExportFormat,
  ChatGptAccountImportInput,
  ChatGptAccountImportProxyMode,
  CodexQuotaHistoryPoint,
  CodexQuotaCycleCosts,
  GatewaySettings,
  GatewayStatus,
  HealthEvent,
  ModelPolicy,
  Pool,
  PoolInput,
  PoolMember,
  ProxyDefinition,
  ProxyInput,
  PublicProxyDefinition,
  ProviderDefinition,
  ProviderInput,
  RequestLog,
  Route,
  RouteClient,
  RouteSourceFastModeInput,
  SetupRoutingInput,
  SetupRoutingResult,
  SetupWizardProgressInput,
  SetupWizardState,
  TokenRateSeries
} from '@shared/types'
import {
  LEGACY_JSON_FILENAME,
  SQLITE_DATABASE_FILENAME,
  SqliteStateStore
} from './sqlite-state-store'
import type { PersistedState } from './types'
import { getProviderAdapter } from '../providers'
import {
  chatGptAccessTokenOnlyWarning,
  deserializeChatGptCredential,
  matchesChatGptCredential,
  parseChatGptAccountImport,
  serializeChatGptCredential
} from '../auth'
import { applySetupRoutingDraft } from '../setup/setup-routing'
import { SetupWizardRepository } from '../setup/setup-state'
import {
  deleteApiSourceDraft,
  saveAggregateRelayDraft,
  saveApiSourceDraft,
  setRouteSourceFastModeDraft,
  type SavedApiSourceDraft,
} from '../sources/source-state'

const DEFAULT_GATEWAY: GatewaySettings = {
  host: '127.0.0.1',
  port: 15721,
  autoStart: false,
  logPayloads: false,
  requestTimeoutSeconds: 120,
  launchAtLogin: false,
  desktopNotifications: true,
  automaticBackups: true,
  backupRetention: 10,
  outboundNetworkMode: 'direct'
}

const DEFAULT_STATUS: GatewayStatus = {
  running: false,
  host: DEFAULT_GATEWAY.host,
  port: DEFAULT_GATEWAY.port,
  activeRequests: 0,
  totalRequests: 0,
  successRequests: 0
}

const MAX_PERSISTED_REQUEST_LOGS = 20_000
const MAX_RENDERER_REQUEST_LOGS = 500
const FITNESS_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000
const FITNESS_HISTORY_ROWS_PER_ACCOUNT = 400
const IGNORED_UPDATE_VERSION_KEY = 'ignored_update_version'
const OBSERVABILITY_CACHE_TTL_MS = 1_000
const DEFAULT_ACCOUNT_TAGS: ReadonlyArray<Pick<AccountTagDefinition, 'id' | 'name'>> = [
  { id: 'tag-k12', name: 'K12' },
  { id: 'tag-plus', name: 'Plus' }
]

type AccountCheckPatch = Partial<Pick<Account,
  'status' |
  'latencyMs' |
  'lastError' |
  'lastUsedAt' |
  'cooldownUntil' |
  'cooldownReason' |
  'circuitState' |
  'consecutiveFailures' |
  'quota' |
  'codexQuota'
>>

export class AppStore {
  private readonly store: SqliteStateStore<PersistedState>
  private readonly setupWizard: SetupWizardRepository
  private status: GatewayStatus = { ...DEFAULT_STATUS }
  private requestLogRevision = 0
  private observabilityCache?: {
    revision: number
    expiresAt: number
    value: AppSnapshot['observability']
  }
  private readonly vaultAvailable: boolean
  private readonly vaultBackend: string
  private readonly decryptedCredentialCache = new Map<string, string>()

  public constructor(userDataPath: string) {
    const vault = inspectCredentialVault()
    this.vaultAvailable = vault.available
    this.vaultBackend = vault.backend
    this.store = new SqliteStateStore({
      databasePath: join(userDataPath, SQLITE_DATABASE_FILENAME),
      legacyJsonPath: join(userDataPath, LEGACY_JSON_FILENAME),
      initialData: createInitialState(),
      normalize: normalizePersistedState
    })
    this.setupWizard = new SetupWizardRepository(this.store)
  }

  public async initialize(): Promise<void> {
    await this.store.initialize()
    if (this.store.select((state) => state.requestLogs.some((log) => log.status === 'streaming'))) {
      await this.store.update((state) => {
        state.requestLogs = state.requestLogs.map((log) => log.status === 'streaming'
          ? {
              ...log,
              status: 'error',
              statusCode: 499,
              failureStage: 'client',
              error: 'Gateway stopped before the request completed'
            }
          : log)
      })
      this.requestLogRevision += 1
    }
    await this.sanitizePersistedData()
  }

  public async sanitizePersistedData(): Promise<void> {
    await this.sanitizePersistedMessages()
    await this.store.pruneCodexQuotaHistory(Date.now() - 14 * 24 * 60 * 60 * 1000)
  }

  public async close(): Promise<void> {
    await this.store.close()
  }

  public getStateRepository(): SqliteStateStore<PersistedState> {
    return this.store
  }

  public getIgnoredUpdateVersion(): string | undefined {
    const value = this.store.readAppMetadata(IGNORED_UPDATE_VERSION_KEY)
    return value === undefined ? undefined : validSemver(value) ?? undefined
  }

  public async setIgnoredUpdateVersion(version?: string): Promise<void> {
    if (version === undefined || version.length === 0) {
      await this.store.removeAppMetadata(IGNORED_UPDATE_VERSION_KEY)
      return
    }

    const normalized = validSemver(version)
    if (!normalized) throw new Error('Ignored update version must be a valid semantic version.')
    await this.store.writeAppMetadata(IGNORED_UPDATE_VERSION_KEY, normalized)
  }

  public getSnapshot(): AppSnapshot {
    const state = this.store.select((current) => ({
      ...current,
      requestLogs: current.requestLogs.slice(0, MAX_RENDERER_REQUEST_LOGS)
    }))
    return toSnapshot(
      state,
      this.status,
      this.vaultAvailable,
      this.vaultBackend,
      this.getObservability()
    )
  }

  /**
   * Returns a bounded, persisted history for the moving account evaluator.
   * Request logs are the compatibility layer here: existing installations can
   * immediately derive a long-term rating without a schema migration.
   */
  public getAccountFitnessHistory(now = Date.now()): RequestLog[] {
    const cutoff = now - FITNESS_HISTORY_WINDOW_MS
    return this.store.select((state) => {
      const counts = new Map<string, number>()
      const selected: RequestLog[] = []
      for (const log of state.requestLogs) {
        if (!log.accountId || log.timestamp < cutoff || log.status === 'streaming') continue
        const count = counts.get(log.accountId) ?? 0
        if (count >= FITNESS_HISTORY_ROWS_PER_ACCOUNT) continue
        counts.set(log.accountId, count + 1)
        selected.push(log)
      }
      return selected
    })
  }

  private getObservability(): AppSnapshot['observability'] {
    const now = Date.now()
    // Observability is derived from up to 20k rows. Keep its recomputation rate
    // bounded even while new logs continuously advance the revision.
    if (this.observabilityCache && this.observabilityCache.expiresAt > now) {
      return structuredClone(this.observabilityCache.value)
    }
    const value = this.store.select((state) => ({
      last24Hours: summarizeObservability(state.requestLogs, now - 24 * 60 * 60 * 1000, now),
      last7Days: summarizeObservability(state.requestLogs, now - 7 * 24 * 60 * 60 * 1000, now),
      hourly: summarizeHourly(state.requestLogs, now),
      tokenRates: summarizeTokenRates(state.requestLogs, now),
      tokenCosts: summarizeOpenAiTokenCosts(state.requestLogs, now)
    }))
    this.observabilityCache = {
      revision: this.requestLogRevision,
      expiresAt: now + OBSERVABILITY_CACHE_TTL_MS,
      value
    }
    return structuredClone(value)
  }

  public getRuntimeAccounts(): Account[] {
    return this.store.select((state) => state.accounts)
  }

  public getRuntimeAccount(id: string): Account | undefined {
    return this.store.select((state) => state.accounts.find((account) => account.id === id))
  }

  public getRuntimeProvider(id: string): ProviderDefinition | undefined {
    return this.store.select((state) => state.providers.find((provider) => provider.id === id))
  }

  public getRuntimeProxies(): ProxyDefinition[] {
    return this.store.select((state) => state.proxies)
  }

  public getRuntimeConfiguration(): {
    providers: ProviderDefinition[]
    accounts: Account[]
    proxies: PublicProxyDefinition[]
    pools: Pool[]
    routes: Route[]
    gateway: GatewaySettings
  } {
    return this.store.select((state) => ({
      providers: state.providers,
      accounts: state.accounts,
      proxies: state.proxies.map(({ credentialId: _credentialId, ...proxy }) => ({
        ...proxy,
        hasPassword: Boolean(_credentialId && state.credentials[_credentialId])
      })),
      pools: appendRuntimeRouteSourcePools(
        state.routes.map((route) => route.poolId),
        state,
      ),
      routes: state.routes,
      gateway: state.gateway
    }))
  }

  public setGatewayStatus(status: GatewayStatus): void {
    this.status = { ...status }
  }

  public async saveProvider(input: ProviderInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Provider name')
    if (!getProviderAdapter(input.kind).capabilities.protocols[input.protocol]) {
      throw new Error(`${input.kind} does not support the ${input.protocol} protocol.`)
    }
    const timestamp = Date.now()
    await this.store.update((state) => {
      const existing = input.id ? state.providers.find((provider) => provider.id === input.id) : undefined
      const sourceType = input.sourceType ?? existing?.sourceType ?? inferProviderSourceType(input.kind, input.baseUrl)
      const provider: ProviderDefinition = {
        id: existing?.id ?? createId(),
        name,
        sourceType,
        kind: input.kind,
        baseUrl: normalizeUrl(input.baseUrl),
        protocol: input.protocol,
        models: normalizeModels(input.models),
        icon: existing?.icon,
        color: existing?.color,
        forceFastMode: sourceType === 'relay'
          && supportsFastServiceTier(input.protocol)
          && existing?.forceFastMode === true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (existing) {
        replaceById(state.providers, provider)
      } else {
        state.providers.push(provider)
      }
    })
    return this.getSnapshot()
  }

  public async deleteProvider(id: string): Promise<AppSnapshot> {
    await this.store.update((state) => {
      if (state.accounts.some((account) => account.providerId === id)) {
        throw new Error('Delete the accounts under this provider first.')
      }
      state.providers = state.providers.filter((provider) => provider.id !== id)
      const timestamp = Date.now()
      state.routes = state.routes.map((route) => route.poolId === id
        ? { ...route, enabled: false, poolId: '', updatedAt: timestamp }
        : route)
    })
    return this.getSnapshot()
  }

  public async saveApiSource(input: ApiSourceInput): Promise<{ snapshot: AppSnapshot; source: SavedApiSourceDraft }> {
    let saved: SavedApiSourceDraft | undefined
    await this.store.update((state) => {
      saved = saveApiSourceDraft(state, input, (credential) => this.encrypt(credential))
    })
    if (!saved) throw new Error('API source could not be saved.')
    return { snapshot: this.getSnapshot(), source: saved }
  }

  public getApiSourceCredential(sourceId: string): string | undefined {
    const state = this.store.read()
    const provider = state.providers.find((candidate) => candidate.id === sourceId)
    if (!provider || provider.sourceType === 'oauth-system') return undefined
    const account = state.accounts.find((candidate) => candidate.providerId === sourceId && candidate.credentialType !== 'chatgpt-oauth')
    if (!account) return undefined
    const encrypted = state.credentials[account.credentialId]
    return encrypted ? this.decrypt(encrypted) : undefined
  }

  public async deleteApiSource(id: string): Promise<AppSnapshot> {
    await this.store.update((state) => {
      deleteApiSourceDraft(state, id)
    })
    return this.getSnapshot()
  }

  public async saveAggregateRelay(input: AggregateRelayInput): Promise<AppSnapshot> {
    await this.store.update((state) => {
      saveAggregateRelayDraft(state, input)
    })
    return this.getSnapshot()
  }

  public async setProviderModels(id: string, models: string[]): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.update((state) => {
      const provider = state.providers.find((candidate) => candidate.id === id)
      if (!provider) throw new Error('Provider not found.')
      provider.models = normalizeModels(models)
      provider.updatedAt = timestamp
    })
    return this.getSnapshot()
  }

  public getAccountModelDiscoveryFingerprint(id: string): string {
    return accountModelDiscoveryFingerprint(this.store.read(), id)
  }

  public async setAccountModels(
    id: string,
    models: string[],
    expectedDiscoveryFingerprint?: string
  ): Promise<AppSnapshot> {
    const availableModels = normalizeModels(models)
    if (availableModels.length === 0) throw new Error('Provider returned an empty model list.')
    const timestamp = Date.now()
    await this.store.update((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new Error('Account not found.')
      if (
        expectedDiscoveryFingerprint !== undefined
        && accountModelDiscoveryFingerprint(state, id) !== expectedDiscoveryFingerprint
      ) {
        throw new Error('Account or provider configuration changed while models were refreshing. Refresh again.')
      }
      account.availableModels = availableModels
      account.modelsRefreshedAt = timestamp
      account.modelAllowlist = account.modelPolicy === 'selected'
        ? intersectModels(account.modelAllowlist, availableModels)
        : []
      account.updatedAt = timestamp
      reconcilePoolModelAllowlists(state, timestamp, new Set([account.id]))
    })
    return this.getSnapshot()
  }

  public async saveAccount(input: AccountInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Account name')
    const timestamp = Date.now()
    await this.store.update((state) => {
      if (!state.providers.some((provider) => provider.id === input.providerId)) {
        throw new Error('Choose an existing provider before saving an account.')
      }
      const existing = input.id ? state.accounts.find((account) => account.id === input.id) : undefined
      if (existing?.credentialType === 'chatgpt-oauth' && (
        existing.providerId !== input.providerId || input.credential?.trim()
      )) {
        throw new Error('ChatGPT OAuth credentials and providers must be updated by importing a new session.')
      }
      if (!existing && !input.credential?.trim()) {
        throw new Error('A credential is required for a new account.')
      }
      if (existing && existing.providerId !== input.providerId && !input.credential?.trim()) {
        throw new Error('Changing an account provider requires a new credential.')
      }
      if (input.tagId !== undefined && existing?.credentialType !== 'chatgpt-oauth') {
        throw new Error('Only ChatGPT OAuth accounts can use account tags.')
      }
      const accountId = existing?.id ?? createId()
      const credentialId = existing?.credentialId ?? createId()
      const credentialChanged = input.credential !== undefined
      const requestedModelAllowlist = normalizeModels(input.modelAllowlist)
      const modelPolicy = resolveAccountInputModelPolicy(input.modelPolicy, requestedModelAllowlist)
      const availableModels = credentialChanged ? [] : existing?.availableModels ?? []
      const modelsRefreshedAt = credentialChanged ? undefined : existing?.modelsRefreshedAt
      if (modelPolicy === 'selected' && modelsRefreshedAt !== undefined) {
        const unavailable = requestedModelAllowlist.filter((model) => !availableModels.includes(model))
        if (unavailable.length > 0) {
          throw new Error(`Selected account models are not available: ${unavailable.join(', ')}`)
        }
      }
      let maskedCredential = existing?.maskedCredential ?? ''
      if (input.credential !== undefined) {
        const credential = input.credential.trim()
        if (!credential) {
          throw new Error('Credential cannot be empty.')
        }
        state.credentials[credentialId] = this.encrypt(credential)
        maskedCredential = maskCredential(credential)
      }
      const account: Account = {
        id: accountId,
        providerId: input.providerId,
        name,
        credentialId,
        maskedCredential,
        status: credentialChanged ? 'active' : existing?.status ?? 'active',
        priority: positiveInteger(input.priority, 1),
        weight: positiveInteger(input.weight, 1),
        maxConcurrency: positiveInteger(input.maxConcurrency, 1),
        inFlight: existing?.inFlight ?? 0,
        availableModels,
        modelsRefreshedAt,
        modelPolicy,
        modelAllowlist: modelPolicy === 'selected' ? requestedModelAllowlist : [],
        proxyId: input.proxyId === undefined ? existing?.proxyId : optionalProxyId(input.proxyId, state.proxies),
        credentialType: existing?.credentialType,
        chatgptAccountId: existing?.chatgptAccountId,
        credentialExpiresAt: existing?.credentialExpiresAt,
        renewable: existing?.renewable,
        tagId: input.tagId === undefined ? existing?.tagId : optionalAccountTagId(input.tagId, state.accountTags),
        quotaRemaining: existing?.quotaRemaining,
        quotaUnit: existing?.quotaUnit,
        quota: existing?.quota,
        codexQuota: existing?.codexQuota,
        cooldownUntil: credentialChanged ? undefined : existing?.cooldownUntil,
        cooldownReason: credentialChanged ? undefined : existing?.cooldownReason,
        circuitState: credentialChanged ? 'closed' : existing?.circuitState,
        consecutiveFailures: credentialChanged ? 0 : existing?.consecutiveFailures,
        latencyMs: existing?.latencyMs,
        lastUsedAt: existing?.lastUsedAt,
        lastError: credentialChanged ? undefined : existing?.lastError,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      const selectedPolicyChanged = modelPolicy === 'selected' && (
        existing?.modelPolicy !== 'selected'
        || !sameModels(account.modelAllowlist, existing.modelAllowlist)
      )
      if (existing) {
        replaceById(state.accounts, account)
      } else {
        state.accounts.push(account)
      }
      if (selectedPolicyChanged) {
        reconcilePoolModelAllowlists(state, timestamp, new Set([account.id]))
      }
    })
    return this.getSnapshot()
  }

  public async saveAccountTag(input: AccountTagInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Tag name')
    if (name.length > 24) throw new Error('Tag name cannot exceed 24 characters.')
    const timestamp = Date.now()
    await this.store.update((state) => {
      const existing = input.id ? state.accountTags.find((tag) => tag.id === input.id) : undefined
      if (input.id && !existing) throw new Error('Account tag not found.')
      if (!existing && state.accountTags.length >= 50) throw new Error('No more than 50 account tags can be created.')
      if (state.accountTags.some((tag) => tag.id !== existing?.id && tag.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error('An account tag with this name already exists.')
      }
      const tag: AccountTagDefinition = {
        id: existing?.id ?? createId(),
        name,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (existing) replaceById(state.accountTags, tag)
      else state.accountTags.push(tag)
    })
    return this.getSnapshot()
  }

  public async deleteAccountTag(id: string): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.update((state) => {
      if (!state.accountTags.some((tag) => tag.id === id)) throw new Error('Account tag not found.')
      state.accountTags = state.accountTags.filter((tag) => tag.id !== id)
      for (const account of state.accounts) {
        if (account.tagId !== id) continue
        account.tagId = undefined
        account.updatedAt = timestamp
      }
    })
    return this.getSnapshot()
  }

  public async setAccountTags(input: AccountTagAssignmentInput): Promise<AppSnapshot> {
    const accountIds = [...new Set(input.accountIds.filter((id) => typeof id === 'string' && id.trim()))]
    if (accountIds.length === 0) throw new Error('Select at least one account.')
    const timestamp = Date.now()
    await this.store.update((state) => {
      const missing = accountIds.filter((id) => !state.accounts.some((account) => account.id === id))
      if (missing.length > 0) throw new Error('One of the selected accounts no longer exists.')
      if (state.accounts.some((account) => accountIds.includes(account.id) && account.credentialType !== 'chatgpt-oauth')) {
        throw new Error('Only ChatGPT OAuth accounts can use account tags.')
      }
      const tagId = optionalAccountTagId(input.tagId, state.accountTags)
      const selected = new Set(accountIds)
      for (const account of state.accounts) {
        if (!selected.has(account.id) || account.tagId === tagId) continue
        account.tagId = tagId
        account.updatedAt = timestamp
      }
    })
    return this.getSnapshot()
  }

  public async importChatGptAccounts(input: ChatGptAccountImportInput) {
    const parsed = parseChatGptAccountImport(input.content)
    const importedAccountIds: string[] = []
    const createdAccountIds: string[] = []
    const updatedAccountIds: string[] = []
    let accessTokenOnlyCount = 0
    let ignoredFileProxyCount = 0
    const timestamp = Date.now()
    await this.store.update((state) => {
      const proxySelection = normalizeAccountImportProxySelection(input.proxyMode, input.proxyId, state.proxies)
      const tagId = optionalAccountTagId(input.tagId ?? null, state.accountTags)
      validateChatGptImportPoolId(input.poolId ?? null, state.pools)
      const provider = ensureOAuthSystemProvider(state, timestamp)
      for (const [index, bundle] of parsed.accounts.entries()) {
        let existing: Account | undefined
        let existingBundle: ReturnType<typeof deserializeChatGptCredential> = undefined
        for (const candidate of state.accounts) {
          if (candidate.credentialType !== 'chatgpt-oauth') continue
          const encrypted = state.credentials[candidate.credentialId]
          const serialized = encrypted ? this.decrypt(encrypted) : undefined
          const candidateBundle = serialized ? deserializeChatGptCredential(serialized) : undefined
          if (!candidateBundle || !matchesChatGptCredential(bundle, candidateBundle)) continue
          existing = candidate
          existingBundle = candidateBundle
          break
        }
        const credentialBundle = existingBundle?.refreshToken && !bundle.refreshToken
          ? {
              ...existingBundle,
              ...bundle,
              refreshToken: existingBundle.refreshToken,
              idToken: bundle.idToken ?? existingBundle.idToken,
              userId: bundle.userId ?? existingBundle.userId
            }
          : bundle
        const accountId = existing?.id ?? createId()
        const credentialId = existing?.credentialId ?? createId()
        const fileProxyId = parsed.proxyIds[index]
        const proxyId = resolveImportedAccountProxyId(proxySelection, fileProxyId, state.proxies)
        if (proxySelection.mode === 'preserve' && fileProxyId && !proxyId) ignoredFileProxyCount += 1
        state.credentials[credentialId] = this.encrypt(serializeChatGptCredential(credentialBundle))
        const account: Account = {
          id: accountId,
          providerId: provider.id,
          name: requiredName(input.name?.trim() || existing?.name || credentialBundle.email || `ChatGPT account ${index + 1}`, 'Account name'),
          credentialId,
          maskedCredential: maskAccountId(credentialBundle.accountId),
          credentialType: 'chatgpt-oauth',
          chatgptAccountId: credentialBundle.accountId,
          credentialExpiresAt: credentialBundle.expiresAt,
          renewable: Boolean(credentialBundle.refreshToken),
          tagId,
          status: credentialBundle.expiresAt <= timestamp ? 'expired' : 'active',
          priority: existing?.priority ?? 10,
          weight: existing?.weight ?? 10,
          maxConcurrency: existing?.maxConcurrency ?? 4,
          inFlight: existing?.inFlight ?? 0,
          availableModels: existing?.availableModels ?? [],
          modelsRefreshedAt: existing?.modelsRefreshedAt,
          modelPolicy: existing?.modelPolicy ?? (existing?.modelAllowlist.length ? 'selected' : 'all'),
          modelAllowlist: existing?.modelAllowlist ?? [],
          proxyId,
          quota: existing?.quota,
          codexQuota: existing?.codexQuota,
          cooldownUntil: undefined,
          cooldownReason: undefined,
          circuitState: 'closed',
          consecutiveFailures: 0,
          latencyMs: existing?.latencyMs,
          lastUsedAt: existing?.lastUsedAt,
          lastError: undefined,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp
        }
        if (existing) {
          replaceById(state.accounts, account)
          updatedAccountIds.push(accountId)
        } else {
          state.accounts.push(account)
          createdAccountIds.push(accountId)
        }
        importedAccountIds.push(accountId)
        if (!credentialBundle.refreshToken) accessTokenOnlyCount += 1
      }
    })
    const parsedAccessTokenWarning = chatGptAccessTokenOnlyWarning(parsed.accessTokenOnlyCount)
    const warnings = parsed.warnings.filter((warning) => warning !== parsedAccessTokenWarning)
    const finalAccessTokenWarning = chatGptAccessTokenOnlyWarning(accessTokenOnlyCount)
    if (finalAccessTokenWarning) warnings.push(finalAccessTokenWarning)
    if (ignoredFileProxyCount > 0) {
      warnings.push(`已忽略 ${ignoredFileProxyCount} 个不存在的文件代理配置，相关账号改为直连。`)
    }
    return {
      snapshot: this.getSnapshot(),
      importedAccountIds,
      createdAccountIds,
      updatedAccountIds,
      warnings
    }
  }

  public validateChatGptImportAssignments(tagId: string | null | undefined, poolId: string | null | undefined): void {
    const state = this.store.read()
    optionalAccountTagId(tagId ?? null, state.accountTags)
    validateChatGptImportPoolId(poolId ?? null, state.pools)
  }

  public async addDetectedChatGptAccountsToPool(
    poolId: string | null | undefined,
    accountIds: string[]
  ): Promise<{ added: number; alreadyPresent: number }> {
    if (!poolId) return { added: 0, alreadyPresent: 0 }
    const uniqueAccountIds = [...new Set(accountIds.filter((id) => typeof id === 'string' && id.trim()))]
    let added = 0
    let alreadyPresent = 0
    await this.store.update((state) => {
      const pool = validateChatGptImportPoolId(poolId, state.pools)
      if (!pool) return
      const providersById = new Map(state.providers.map((provider) => [provider.id, provider]))
      for (const accountId of uniqueAccountIds) {
        const account = state.accounts.find((candidate) => candidate.id === accountId)
        if (!account || account.credentialType !== 'chatgpt-oauth') continue
        if (providersById.get(account.providerId)?.protocol !== 'openai-responses') continue
        if (pool.members.some((member) => member.accountId === accountId)) {
          alreadyPresent += 1
          continue
        }
        pool.members.push({ accountId, enabled: true })
        added += 1
      }
      if (added > 0) pool.updatedAt = Date.now()
    })
    return { added, alreadyPresent }
  }

  public async deleteAccount(id: string): Promise<AppSnapshot> {
    return this.deleteAccounts([id])
  }

  public exportChatGptAccounts(
    accountIds: string[],
    format: ChatGptAccountExportFormat
  ): { content: string; exportedAccounts: number } {
    if (format !== 'cpa' && format !== 'sub2api') throw new Error('Unsupported account export format.')
    const selectedIds = [...new Set(accountIds.filter((id) => typeof id === 'string' && id.trim()))]
    if (!selectedIds.length) throw new Error('Select at least one account to export.')
    const state = this.store.read()
    const selected = selectedIds.map((id) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new Error('One of the selected accounts no longer exists.')
      if (account.credentialType !== 'chatgpt-oauth') {
        throw new Error(`Account “${account.name}” is not a ChatGPT OAuth account.`)
      }
      const encrypted = state.credentials[account.credentialId]
      const serialized = encrypted ? this.decrypt(encrypted) : undefined
      const credential = serialized ? deserializeChatGptCredential(serialized) : undefined
      if (!credential) throw new Error(`Credential for “${account.name}” is unavailable.`)
      return { account, credential }
    })
    const exportedAt = new Date().toISOString()
    const cpaAccounts = selected.map(({ account, credential }) => ({
      type: 'codex',
      name: account.name,
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken ?? '',
      id_token: credential.idToken ?? '',
      account_id: credential.accountId,
      chatgpt_account_id: credential.accountId,
      user_id: credential.userId ?? '',
      email: credential.email ?? '',
      expired: new Date(credential.expiresAt).toISOString(),
      expires_at: Math.floor(credential.expiresAt / 1000)
    }))
    const payload = format === 'cpa'
      ? cpaAccounts.length === 1 ? cpaAccounts[0] : cpaAccounts
      : {
          type: 'sub2api-data',
          version: 1,
          exported_at: exportedAt,
          proxies: [],
          accounts: selected.map(({ account, credential }) => ({
            name: account.name,
            platform: 'openai',
            type: 'oauth',
            credentials: {
              access_token: credential.accessToken,
              refresh_token: credential.refreshToken ?? '',
              id_token: credential.idToken ?? '',
              account_id: credential.accountId,
              user_id: credential.userId ?? '',
              email: credential.email ?? ''
            },
            expires_at: Math.floor(credential.expiresAt / 1000),
            concurrency: account.maxConcurrency,
            priority: account.priority
          }))
        }
    return { content: `${JSON.stringify(payload, null, 2)}\n`, exportedAccounts: selected.length }
  }

  public async deleteAccounts(ids: string[]): Promise<AppSnapshot> {
    const selectedIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
    if (!selectedIds.length) throw new Error('Select at least one account to delete.')
    const selectedIdSet = new Set(selectedIds)
    const timestamp = Date.now()
    await this.store.update((state) => {
      const missing = selectedIds.filter((id) => !state.accounts.some((account) => account.id === id))
      if (missing.length) throw new Error('One of the selected accounts no longer exists.')
      for (const pool of state.pools) {
        const members = pool.members.filter((member) => !selectedIdSet.has(member.accountId))
        if (members.length === pool.members.length) continue
        pool.members = members
        pool.updatedAt = timestamp
      }
      for (const account of state.accounts) {
        if (selectedIdSet.has(account.id)) delete state.credentials[account.credentialId]
      }
      state.accounts = state.accounts.filter((candidate) => !selectedIdSet.has(candidate.id))
      const orphanedSourceIds = new Set(state.providers
        .filter((provider) => provider.sourceType === 'official-api' || provider.sourceType === 'relay')
        .filter((provider) => !state.accounts.some((account) => account.providerId === provider.id))
        .map((provider) => provider.id))
      state.routes = state.routes.map((route) => orphanedSourceIds.has(route.poolId)
        ? { ...route, enabled: false, poolId: '', updatedAt: timestamp }
        : route)
      reconcilePoolModelAllowlists(state, timestamp)
    })
    await Promise.all(selectedIds.map((id) => this.store.deleteCodexQuotaHistory(id)))
    return this.getSnapshot()
  }

  public async saveProxy(input: ProxyInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Proxy name')
    if (!['http', 'https', 'socks4', 'socks5'].includes(input.protocol)) {
      throw new Error('Unsupported proxy protocol.')
    }
    const host = normalizeProxyHost(input.host)
    const port = boundedInteger(input.port, 1, 65_535, 0)
    if (port === 0) throw new Error('Proxy port must be between 1 and 65535.')
    const username = input.username?.trim() || undefined
    if (username && username.length > 200) throw new Error('Proxy username cannot exceed 200 characters.')
    if (input.password && input.password.length > 2_048) throw new Error('Proxy password cannot exceed 2048 characters.')
    if (input.protocol === 'socks4' && input.password) throw new Error('SOCKS4 supports a user ID but not password authentication.')
    const timestamp = Date.now()
    await this.store.update((state) => {
      const existing = input.id ? state.proxies.find((proxy) => proxy.id === input.id) : undefined
      if (input.id && !existing) throw new Error('Proxy not found.')
      const password = input.password === undefined || input.password === '' ? undefined : input.password
      if (input.protocol === 'socks4' && existing?.hasPassword && !input.clearPassword) {
        throw new Error('Clear the saved password before changing this proxy to SOCKS4.')
      }
      let credentialId = existing?.credentialId
      let hasPassword = existing?.hasPassword ?? false
      if (input.clearPassword) {
        if (credentialId) delete state.credentials[credentialId]
        credentialId = undefined
        hasPassword = false
      } else if (password) {
        credentialId ??= createId()
        state.credentials[credentialId] = this.encrypt(password)
        hasPassword = true
      }
      const connectionChanged = !existing
        || existing.protocol !== input.protocol
        || existing.host !== host
        || existing.port !== port
        || existing.username !== username
        || Boolean(password)
        || Boolean(input.clearPassword)
      const proxy: ProxyDefinition = {
        id: existing?.id ?? createId(),
        name,
        protocol: input.protocol,
        host,
        port,
        username,
        credentialId,
        hasPassword,
        status: connectionChanged ? 'unchecked' : existing.status,
        exitIp: connectionChanged ? undefined : existing.exitIp,
        latencyMs: connectionChanged ? undefined : existing.latencyMs,
        lastCheckedAt: connectionChanged ? undefined : existing.lastCheckedAt,
        lastError: connectionChanged ? undefined : existing.lastError,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (existing) replaceById(state.proxies, proxy)
      else state.proxies.push(proxy)
    })
    return this.getSnapshot()
  }

  public async deleteProxy(id: string): Promise<AppSnapshot> {
    await this.store.update((state) => {
      if (state.accounts.some((account) => account.proxyId === id)) {
        throw new Error('Remove this proxy from its accounts before deleting it.')
      }
      if (state.pools.some((pool) => pool.proxyId === id)) {
        throw new Error('Remove this proxy from its pools before deleting it.')
      }
      const proxy = state.proxies.find((candidate) => candidate.id === id)
      if (!proxy) throw new Error('Proxy not found.')
      if (proxy.credentialId) delete state.credentials[proxy.credentialId]
      state.proxies = state.proxies.filter((candidate) => candidate.id !== id)
    })
    return this.getSnapshot()
  }

  public async setProxyCheckResult(
    id: string,
    patch: Pick<ProxyDefinition, 'status' | 'lastCheckedAt'> & Partial<Pick<ProxyDefinition, 'exitIp' | 'latencyMs' | 'lastError'>>
  ): Promise<AppSnapshot> {
    await this.store.update((state) => {
      const proxy = state.proxies.find((candidate) => candidate.id === id)
      if (!proxy) throw new Error('Proxy not found.')
      const safePatch = patch.lastError === undefined
        ? patch
        : { ...patch, lastError: this.safePersistedMessage(state, patch.lastError) }
      Object.assign(proxy, safePatch, { updatedAt: Date.now() })
    })
    return this.getSnapshot()
  }

  public async saveClientProfile(input: ClientConfigProfileInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Profile name')
    const directoryInput = input.directory?.trim() || undefined
    if (directoryInput && !isAbsolute(directoryInput)) {
      throw new Error('A custom client configuration directory must be absolute.')
    }
    const directory = directoryInput ? normalize(directoryInput) : undefined
    const backupRetention = boundedInteger(input.backupRetention, 1, 100, 10)
    const timestamp = Date.now()
    await this.store.update((state) => {
      const existing = input.id
        ? state.clientProfiles.find((profile) => profile.id === input.id)
        : undefined
      if (input.id && !existing) throw new Error('Client configuration profile not found.')
      if (existing?.isDefault) throw new Error('Default client profiles cannot be edited.')
      if (existing && existing.client !== input.client) {
        throw new Error('An existing client profile cannot change its client.')
      }
      const profile: ClientConfigProfile = {
        id: existing?.id ?? createId(),
        name,
        client: existing?.client ?? input.client,
        directory,
        backupRetention,
        isDefault: false,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (existing) replaceById(state.clientProfiles, profile)
      else state.clientProfiles.push(profile)
    })
    return this.getSnapshot()
  }

  public exportClientProfile(id: string): { format: 'stone-client-profile'; version: 1; profile: ClientConfigProfileInput } {
    const profile = this.store.read().clientProfiles.find((candidate) => candidate.id === id)
    if (!profile) throw new Error('Client configuration profile not found.')
    return {
      format: 'stone-client-profile',
      version: 1,
      profile: {
        name: profile.name,
        client: profile.client,
        directory: profile.directory,
        backupRetention: profile.backupRetention
      }
    }
  }

  public async importClientProfile(bundle: unknown): Promise<AppSnapshot> {
    if (!bundle || typeof bundle !== 'object') throw new Error('Invalid client profile bundle.')
    const candidate = bundle as { format?: unknown; version?: unknown; profile?: Partial<ClientConfigProfileInput> }
    if (candidate.format !== 'stone-client-profile' || candidate.version !== 1 || !candidate.profile) {
      throw new Error('Unsupported client profile bundle.')
    }
    if (candidate.profile.client !== 'claude' && candidate.profile.client !== 'codex' && candidate.profile.client !== 'gemini') {
      throw new Error('Unsupported client profile target.')
    }
    return this.saveClientProfile({
      name: requiredName(candidate.profile.name ?? '', 'Profile name'),
      client: candidate.profile.client,
      directory: candidate.profile.directory,
      backupRetention: boundedInteger(candidate.profile.backupRetention ?? 10, 1, 100, 10)
    })
  }

  public async deleteClientProfile(id: string): Promise<AppSnapshot> {
    await this.store.update((state) => {
      const profile = state.clientProfiles.find((candidate) => candidate.id === id)
      if (profile?.isDefault) throw new Error('Default client profiles cannot be deleted.')
      state.clientProfiles = state.clientProfiles.filter((candidate) => candidate.id !== id)
    })
    return this.getSnapshot()
  }

  public async savePool(input: PoolInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Pool name')
    const timestamp = Date.now()
    await this.store.update((state) => {
      const existing = input.id ? state.pools.find((pool) => pool.id === input.id) : undefined
      if (input.kind === 'relay-aggregate' || existing?.kind === 'relay-aggregate') {
        throw new Error('Aggregate relays must be managed from the relay editor.')
      }
      const accountIds = [...new Set(input.accountIds)].filter((id) => state.accounts.some((account) => account.id === id))
      if (accountIds.length === 0) {
        throw new Error('Choose at least one account for the pool.')
      }
      const relayAccountSelected = accountIds.some((accountId) => {
        const account = state.accounts.find((candidate) => candidate.id === accountId)
        return state.providers.find((candidate) => candidate.id === account?.providerId)?.sourceType === 'relay'
      })
      if (relayAccountSelected) {
        throw new Error('Relay sources can only be members of aggregate relays.')
      }
      const incompatible = accountIds.some((accountId) => {
        const account = state.accounts.find((candidate) => candidate.id === accountId)
        const provider = state.providers.find((candidate) => candidate.id === account?.providerId)
        return provider?.protocol !== input.protocol
      })
      if (incompatible) {
        throw new Error('Every account in a pool must use the pool protocol.')
      }
      const requestedModelAllowlist = normalizeModels(input.modelAllowlist ?? existing?.modelAllowlist ?? [])
      const modelPolicy = resolvePoolInputModelPolicy(input.modelPolicy, input.modelAllowlist !== undefined, existing)
      const pool: Pool = {
        id: existing?.id ?? createId(),
        name,
        kind: 'standard',
        protocol: input.protocol,
        strategy: input.strategy,
        members: mergeStandardPoolMembers(existing?.members ?? [], accountIds, input.protocol, state.accounts, state.providers),
        modelPolicy,
        modelAllowlist: modelPolicy === 'selected' ? requestedModelAllowlist : [],
        stickySessions: input.stickySessions,
        stickyTtlMinutes: positiveInteger(input.stickyTtlMinutes, 60),
        maxRetries: nonNegativeInteger(input.maxRetries),
        forceFastMode: supportsFastServiceTier(input.protocol)
          && (input.forceFastMode ?? existing?.forceFastMode) === true,
        hedgedRequests: input.protocol === 'openai-responses'
          && (input.hedgedRequests ?? existing?.hedgedRequests) === true,
        hedgeDelayMs: Math.max(250, Math.min(15_000, positiveInteger(input.hedgeDelayMs ?? existing?.hedgeDelayMs ?? 2_500, 2_500))),
        firstBodyTimeoutMs: Math.max(1_000, Math.min(12_000, positiveInteger(input.firstBodyTimeoutMs ?? existing?.firstBodyTimeoutMs ?? 8_000, 8_000))),
        proxyId: input.proxyId === undefined ? existing?.proxyId : optionalProxyId(input.proxyId, state.proxies),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (pool.modelPolicy === 'selected') {
        const availableModels = new Set(enumeratePoolAvailableModels(pool, state.accounts, state.providers))
        const unavailable = pool.modelAllowlist.filter((model) => !availableModels.has(model))
        if (unavailable.length > 0) {
          throw new Error(`Selected pool models are not available from its accounts: ${unavailable.join(', ')}`)
        }
      }
      if (existing) {
        replaceById(state.pools, pool)
      } else {
        state.pools.push(pool)
      }
    })
    return this.getSnapshot()
  }

  public async deletePool(id: string): Promise<AppSnapshot> {
    await this.store.update((state) => {
      if (state.routes.some((route) => route.poolId === id)) {
        throw new Error('Switch or unassign the routes that use this pool before deleting it.')
      }
      state.pools = state.pools.filter((pool) => pool.id !== id)
    })
    return this.getSnapshot()
  }

  public async setRouteSourceFastMode(input: RouteSourceFastModeInput): Promise<AppSnapshot> {
    await this.store.update((state) => {
      setRouteSourceFastModeDraft(state, input)
    })
    return this.getSnapshot()
  }

  public async updateRoute(route: Route): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.update((state) => {
      if (route.inboundProtocol !== clientNativeProtocols[route.client]) {
        throw new Error(`The ${route.client} route must use its native inbound protocol.`)
      }
      if (route.enabled && hasRouteSourceIdCollision(route.poolId, state)) {
        throw new Error('The selected source id conflicts with an existing pool id.')
      }
      const routeSource = resolveRouteSource(route.poolId, state)
      if (route.enabled && !routeSource) {
        throw new Error('Choose an existing pool or API source for the route.')
      }
      if (route.enabled && routeSource?.provider && !routeSource.accounts.some(isAvailableRouteAccount)) {
        throw new Error('The selected API source has no available account.')
      }
      if (!route.localToken.trim() && route.enabled) {
        throw new Error('An enabled route requires a local token.')
      }
      const cleanRoute: Route = {
        ...route,
        localToken: route.localToken.trim() || createLocalToken(),
        modelMap: normalizeModelMap(route.modelMap),
        createdAt: route.createdAt || timestamp,
        updatedAt: timestamp
      }
      const existing = state.routes.find((candidate) => candidate.id === route.id)
      if (existing) {
        replaceById(state.routes, cleanRoute)
      } else {
        state.routes.push({ ...cleanRoute, id: cleanRoute.id || createId() })
      }
    })
    return this.getSnapshot()
  }

  /**
   * Atomically switch a client's upstream route source without replacing the
   * rest of the route with a potentially stale renderer snapshot.
   *
   * Source availability is intentionally validated by the caller so this
   * narrow mutation can also be reused by trusted setup and repair flows.
   */
  public async setRouteSource(client: RouteClient, sourceId: string): Promise<AppSnapshot> {
    const cleanSourceId = sourceId.trim()
    if (!cleanSourceId) throw new Error('Choose a route source before switching.')
    await this.store.update((state) => {
      const route = state.routes.find((candidate) => candidate.client === client)
      if (!route) throw new Error(`The ${client} client route does not exist.`)
      replaceById(state.routes, {
        ...route,
        poolId: cleanSourceId,
        updatedAt: Date.now()
      })
    })
    return this.getSnapshot()
  }

  public getSetupWizardState(): SetupWizardState | null {
    return this.setupWizard.get()
  }

  public saveSetupWizardProgress(input: SetupWizardProgressInput): Promise<SetupWizardState> {
    if (input.tagId && !this.store.select((state) => state.accountTags.some((tag) => tag.id === input.tagId))) {
      return this.setupWizard.save({ ...input, tagId: null })
    }
    return this.setupWizard.save(input)
  }

  public markSetupWizardVerified(sessionId: string): Promise<SetupWizardState> {
    return this.setupWizard.markVerified(sessionId)
  }

  public async discardSetupWizard(): Promise<void> {
    const wizard = this.setupWizard.get()
    if (wizard && !wizard.completed) {
      const timestamp = Date.now()
      await this.store.update((state) => {
        const route = wizard.routeId
          ? state.routes.find((candidate) => candidate.id === wizard.routeId)
          : wizard.client ? state.routes.find((candidate) => candidate.client === wizard.client) : undefined
        if (route && wizard.poolId && route.poolId === wizard.poolId) {
          route.enabled = false
          route.updatedAt = timestamp
        }
        const pool = wizard.poolId ? state.pools.find((candidate) => candidate.id === wizard.poolId) : undefined
        const createdByWizard = pool
          && pool.name.startsWith('向导·')
          && pool.createdAt >= wizard.createdAt
          && !state.routes.some((candidate) => candidate.enabled && candidate.poolId === pool.id)
        if (createdByWizard) state.pools = state.pools.filter((candidate) => candidate.id !== pool.id)
      })
    }
    await this.setupWizard.reset()
  }

  public async completeSetupWizard(sessionId: string): Promise<void> {
    const wizard = this.setupWizard.get()
    if (!wizard || wizard.sessionId !== sessionId) throw new Error('配置向导会话不存在或已过期。')
    if (!wizard.verifiedAt || (wizard.step !== 'client-config' && wizard.step !== 'complete')) {
      throw new Error('只有端到端真实请求成功后才能完成配置向导。')
    }
    await this.setupWizard.complete(sessionId)
  }

  public async applySetupRouting(input: SetupRoutingInput): Promise<SetupRoutingResult> {
    const wizard = this.setupWizard.get()
    if (!wizard || wizard.sessionId !== input.sessionId) {
      throw new Error('配置向导会话不存在或已过期。')
    }
    let result: Omit<SetupRoutingResult, 'snapshot'> | undefined
    await this.store.update((state) => {
      result = applySetupRoutingDraft(state, input, { preferredPoolId: wizard.poolId })
    })
    if (!result) throw new Error('无法应用向导路由。')
    await this.setupWizard.save({
      sessionId: input.sessionId,
      step: 'gateway',
      sourceId: input.sourceId,
      poolId: result.poolId,
      routeId: result.routeId,
      client: input.client,
      model: input.model,
    })
    return { ...result, snapshot: this.getSnapshot() }
  }

  public async updateGateway(settings: GatewaySettings): Promise<AppSnapshot> {
    const normalized = normalizeGatewaySettings(settings)
    await this.store.update((state) => {
      state.gateway = normalized
    })
    this.status = { ...this.status, host: normalized.host, port: normalized.port }
    return this.getSnapshot()
  }

  public async setAccountCheckResult(
    id: string,
    patch: AccountCheckPatch
  ): Promise<AppSnapshot> {
    await this.updateAccountRuntimeState(id, patch)
    return this.getSnapshot()
  }

  public async updateAccountRuntimeState(id: string, patch: AccountCheckPatch): Promise<void> {
    let codexQuotaToSample: AccountCodexQuotaSnapshot | undefined
    const safePatch = patch.lastError === undefined
      ? patch
      : { ...patch, lastError: this.safePersistedMessage(this.store.read(), patch.lastError) }
    await this.store.updateAccount<Account>(id, (account) => {
      const mergedQuota = patch.quota ? mergeAccountQuota(account.quota, patch.quota) : undefined
      const mergedCodexQuota = patch.codexQuota
        ? mergeAccountCodexQuota(account.codexQuota, patch.codexQuota)
        : undefined
      Object.assign(account, safePatch, {
        ...(mergedQuota ? { quota: mergedQuota } : {}),
        ...(mergedCodexQuota ? { codexQuota: mergedCodexQuota } : {}),
        updatedAt: Date.now()
      })
      codexQuotaToSample = mergedCodexQuota
    })
    if (codexQuotaToSample) await this.appendCodexQuotaSample(id, codexQuotaToSample)
  }

  public getAccountCodexQuotaHistory(accountId: string, from?: number, to?: number): CodexQuotaHistoryPoint[] {
    const end = Number.isFinite(to) ? Number(to) : Date.now()
    const start = Number.isFinite(from) ? Number(from) : end - 14 * 24 * 60 * 60 * 1000
    return this.store.readCodexQuotaHistory(accountId, start, end)
  }

  public getAccountCodexQuotaCycleCosts(accountId: string): CodexQuotaCycleCosts {
    return this.store.select((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error('Account not found.')
      return summarizeAccountCodexQuotaCycleCosts(state.requestLogs, accountId, account.codexQuota)
    })
  }

  public async appendLog(log: RequestLog): Promise<void> {
    const safeLog = log.error === undefined
      ? log
      : { ...log, error: this.safePersistedMessage(this.store.read(), log.error) }
    await this.store.appendRequestLog(safeLog, MAX_PERSISTED_REQUEST_LOGS)
    this.requestLogRevision += 1
  }

  public async refreshRequestConversationTitles(resolve: (conversationId: string) => string | undefined): Promise<void> {
    await this.store.update((state) => {
      state.requestLogs = state.requestLogs.map((log) => {
        if (!log.conversationId || (log.conversationName && !log.conversationName.startsWith('对话 '))) return log
        const conversationName = resolve(log.conversationId)
        return conversationName && conversationName !== log.conversationName
          ? { ...log, conversationName }
          : log
      })
    })
  }

  public async clearLogs(): Promise<AppSnapshot> {
    await this.store.update((state) => {
      state.requestLogs = []
    })
    this.requestLogRevision += 1
    return this.getSnapshot()
  }

  public async clearHealthEvents(): Promise<AppSnapshot> {
    await this.store.update((state) => {
      state.healthEvents = []
    })
    return this.getSnapshot()
  }

  public async appendHealthEvent(event: HealthEvent): Promise<AppSnapshot> {
    await this.store.update((state) => {
      state.healthEvents.unshift({
        ...event,
        message: this.safePersistedMessage(state, event.message) ?? ''
      })
      state.healthEvents = state.healthEvents.slice(0, 2_000)
    })
    return this.getSnapshot()
  }

  public getCredential(credentialId: string): string | undefined {
    const encryptedCredential = this.store.select((state) => state.credentials[credentialId])
    if (!encryptedCredential) return undefined
    return this.decrypt(encryptedCredential)
  }

  public getProxyPassword(proxyId: string): string | undefined {
    const proxy = this.store.select((state) => state.proxies.find((candidate) => candidate.id === proxyId))
    return proxy?.credentialId ? this.getCredential(proxy.credentialId) : undefined
  }

  private decrypt(encryptedCredential: string): string | undefined {
    if (this.decryptedCredentialCache.has(encryptedCredential)) {
      return this.decryptedCredentialCache.get(encryptedCredential)
    }
    if (!this.vaultAvailable) return undefined
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(encryptedCredential, 'base64'))
      this.decryptedCredentialCache.set(encryptedCredential, decrypted)
      return decrypted
    } catch {
      return undefined
    }
  }

  private sensitiveCredentialValues(state: PersistedState): string[] {
    const values = new Set<string>()
    for (const account of state.accounts) {
      if (account.chatgptAccountId) values.add(account.chatgptAccountId)
      const encrypted = state.credentials[account.credentialId]
      if (!encrypted) continue
      const decrypted = this.decrypt(encrypted)
      for (const sensitive of decrypted
        ? credentialSensitiveValues(decrypted, account.credentialType === 'chatgpt-oauth')
        : []) values.add(sensitive)
    }
    for (const proxy of state.proxies) {
      if (!proxy.credentialId) continue
      const encrypted = state.credentials[proxy.credentialId]
      if (!encrypted) continue
      const decrypted = this.decrypt(encrypted)
      if (decrypted) values.add(decrypted)
    }
    for (const route of state.routes) values.add(route.localToken)
    return [...values].filter(Boolean).sort((left, right) => right.length - left.length)
  }

  private safePersistedMessage(state: PersistedState, value: string | undefined): string | undefined {
    return sanitizePersistedMessage(
      value,
      this.vaultAvailable ? this.sensitiveCredentialValues(state) : undefined
    )
  }

  private async sanitizePersistedMessages(): Promise<void> {
    const current = this.store.read()
    const sensitiveValues = this.vaultAvailable ? this.sensitiveCredentialValues(current) : undefined
    const sanitize = (value: string | undefined) => sanitizePersistedMessage(value, sensitiveValues)
    const accounts = current.accounts.map((account) => ({ ...account, lastError: sanitize(account.lastError) }))
    const proxies = current.proxies.map((proxy) => ({ ...proxy, lastError: sanitize(proxy.lastError) }))
    const requestLogs = current.requestLogs.map((log) => ({ ...log, error: sanitize(log.error) }))
    const healthEvents = current.healthEvents.map((event) => ({ ...event, message: sanitize(event.message) ?? '' }))
    if (
      JSON.stringify(accounts) === JSON.stringify(current.accounts)
      && JSON.stringify(proxies) === JSON.stringify(current.proxies)
      && JSON.stringify(requestLogs) === JSON.stringify(current.requestLogs)
      && JSON.stringify(healthEvents) === JSON.stringify(current.healthEvents)
    ) return
    await this.store.update((state) => {
      state.accounts = accounts
      state.proxies = proxies
      state.requestLogs = requestLogs
      state.healthEvents = healthEvents
    })
  }

  public getChatGptCredential(credentialId: string) {
    const serialized = this.getCredential(credentialId)
    return serialized ? deserializeChatGptCredential(serialized) : undefined
  }

  public async updateChatGptCredential(
    accountId: string,
    serialized: string,
    expectedSourceSerialized?: string
  ): Promise<void> {
    const bundle = deserializeChatGptCredential(serialized)
    if (!bundle) throw new Error('Refreshed ChatGPT credential is invalid.')
    const account = this.store.select((state) => state.accounts.find((candidate) => candidate.id === accountId))
    if (!account || account.credentialType !== 'chatgpt-oauth') throw new Error('ChatGPT account not found.')
    const previousEncrypted = this.store.select((state) => state.credentials[account.credentialId])
    if (expectedSourceSerialized !== undefined && (
      previousEncrypted === undefined || this.decrypt(previousEncrypted) !== expectedSourceSerialized
    )) {
      throw new Error('Account credential changed while it was being rotated.')
    }
    const encrypted = this.encrypt(serialized)
    await this.store.updateAccountCredential<Account>(accountId, account.credentialId, encrypted, (candidate) => {
      if (candidate.credentialType !== 'chatgpt-oauth') throw new Error('ChatGPT account not found.')
      candidate.chatgptAccountId = bundle.accountId
      candidate.credentialExpiresAt = bundle.expiresAt
      candidate.renewable = Boolean(bundle.refreshToken)
      candidate.updatedAt = Date.now()
    }, previousEncrypted)
    if (previousEncrypted) this.decryptedCredentialCache.delete(previousEncrypted)
    this.decryptedCredentialCache.set(encrypted, serialized)
  }

  private encrypt(credential: string): string {
    if (!this.vaultAvailable) {
      throw new Error('The operating system credential vault is unavailable. A credential cannot be stored securely.')
    }
    return safeStorage.encryptString(credential).toString('base64')
  }

  private async appendCodexQuotaSample(accountId: string, quota: AccountCodexQuotaSnapshot): Promise<void> {
    if (!quota.fiveHour && !quota.sevenDay) return
    await this.store.appendCodexQuotaSample({
      accountId,
      observedAt: quota.observedAt,
      fiveHourUsedPercent: quota.fiveHour?.usedPercent,
      fiveHourResetAt: quota.fiveHour?.resetAt,
      sevenDayUsedPercent: quota.sevenDay?.usedPercent,
      sevenDayResetAt: quota.sevenDay?.resetAt,
      source: quota.source
    })
  }
}

function createInitialState(): PersistedState {
  const timestamp = Date.now()
  return {
    version: 1,
    providers: [
      {
        id: 'provider-anthropic',
        name: 'Anthropic',
        sourceType: 'official-api',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        protocol: 'anthropic-messages',
        color: '#d97757',
        models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'provider-openai',
        name: 'OpenAI',
        sourceType: 'official-api',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai-responses',
        color: '#10a37f',
        models: ['gpt-5', 'gpt-5-mini', 'o3'],
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'provider-google',
        name: 'Google AI Studio',
        sourceType: 'official-api',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'gemini',
        color: '#4285f4',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    accounts: [],
    accountTags: DEFAULT_ACCOUNT_TAGS.map((tag) => ({ ...tag, createdAt: timestamp, updatedAt: timestamp })),
    proxies: [],
    pools: [],
    routes: [
      {
        id: 'route-claude',
        client: 'claude',
        enabled: false,
        poolId: '',
        inboundProtocol: 'anthropic-messages',
        modelMap: {},
        localToken: createLocalToken(),
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'route-codex',
        client: 'codex',
        enabled: false,
        poolId: '',
        inboundProtocol: 'openai-responses',
        modelMap: {},
        localToken: createLocalToken(),
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'route-gemini',
        client: 'gemini',
        enabled: false,
        poolId: '',
        inboundProtocol: 'gemini',
        modelMap: {},
        localToken: createLocalToken(),
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    gateway: { ...DEFAULT_GATEWAY },
    requestLogs: [],
    credentials: {},
    clientProfiles: createDefaultClientProfiles(timestamp),
    healthEvents: []
  }
}

function normalizePersistedState(state: PersistedState): PersistedState {
  const timestamp = Date.now()
  const profiles = Array.isArray(state.clientProfiles) ? state.clientProfiles : []
  const proxies = Array.isArray(state.proxies) ? state.proxies : []
  const proxyIds = new Set(proxies.map((proxy) => proxy.id))
  const defaults = createDefaultClientProfiles(timestamp)
  const accountTags = Array.isArray(state.accountTags)
    ? normalizePersistedAccountTags(state.accountTags)
    : DEFAULT_ACCOUNT_TAGS.map((tag) => ({ ...tag, createdAt: timestamp, updatedAt: timestamp }))
  const accountTagIds = new Set(accountTags.map((tag) => tag.id))
  let providers: ProviderDefinition[] = state.providers.map((provider) => {
    const sourceType = isUpstreamSourceType(provider.sourceType)
      ? provider.sourceType
      : inferProviderSourceType(provider.kind, provider.baseUrl)
    return {
      ...provider,
      sourceType,
      forceFastMode: sourceType === 'relay'
        && supportsFastServiceTier(provider.protocol)
        && provider.forceFastMode === true
    }
  })
  let accounts: Account[] = state.accounts.map((account) => {
    const credentialType = account.credentialType === 'chatgpt-oauth' || Boolean(account.chatgptAccountId)
      ? 'chatgpt-oauth' as const
      : 'api-key' as const
    const availableModels = normalizeModels(account.availableModels)
    const modelsRefreshedAt = normalizeTimestamp(account.modelsRefreshedAt)
    const persistedAllowlist = normalizeModels(account.modelAllowlist)
    const modelPolicy = normalizePersistedModelPolicy(account.modelPolicy, persistedAllowlist)
    const modelAllowlist = modelPolicy === 'selected'
      ? modelsRefreshedAt === undefined
        ? persistedAllowlist
        : intersectModels(persistedAllowlist, availableModels)
      : []
    return {
      ...account,
      credentialType,
      availableModels,
      modelsRefreshedAt,
      modelPolicy,
      modelAllowlist,
      ...(credentialType !== 'chatgpt-oauth' || (account.tagId && !accountTagIds.has(account.tagId)) ? { tagId: undefined } : {}),
      ...(account.proxyId && !proxyIds.has(account.proxyId) ? { proxyId: undefined } : {})
    }
  })
  ;({ providers, accounts } = migrateSourceTopology(providers, accounts, timestamp))
  const pools: Pool[] = state.pools.map((pool): Pool => {
    const persistedAllowlist = normalizeModels(pool.modelAllowlist)
    const modelPolicy = normalizePersistedModelPolicy(pool.modelPolicy, persistedAllowlist)
    return {
      ...pool,
      kind: pool.kind === 'relay-aggregate' ? 'relay-aggregate' : 'standard',
      forceFastMode: supportsFastServiceTier(pool.protocol) && pool.forceFastMode === true,
      members: pool.members.map((member, index) => ({
        accountId: member.accountId,
        enabled: member.enabled,
        ...(positiveOptionalNumber(member.weight) !== undefined ? { weight: positiveOptionalNumber(member.weight) } : {}),
        ...(nonNegativeOptionalInteger(member.order) !== undefined
          ? { order: nonNegativeOptionalInteger(member.order) }
          : pool.kind === 'relay-aggregate' ? { order: index } : {})
      })),
      modelPolicy,
      modelAllowlist: modelPolicy === 'selected' ? persistedAllowlist : [],
      ...(pool.proxyId && !proxyIds.has(pool.proxyId) ? { proxyId: undefined } : {})
    }
  })
  const normalized: PersistedState = {
    ...state,
    version: 1,
    providers,
    accountTags,
    proxies: proxies.map((proxy) => ({
      ...proxy,
      hasPassword: Boolean(proxy.credentialId && state.credentials[proxy.credentialId]),
      status: proxy.status === 'available' || proxy.status === 'error' ? proxy.status : 'unchecked'
    })),
    accounts,
    pools,
    gateway: {
      ...DEFAULT_GATEWAY,
      ...state.gateway,
      outboundNetworkMode: state.gateway.outboundNetworkMode === 'system' ? 'system' : 'direct'
    },
    requestLogs: state.requestLogs.slice(0, MAX_PERSISTED_REQUEST_LOGS),
    clientProfiles: [
      ...defaults.map((profile) => profiles.find((candidate) => candidate.id === profile.id) ?? profile),
      ...profiles.filter((profile) => !profile.isDefault)
    ],
    healthEvents: Array.isArray(state.healthEvents) ? state.healthEvents.slice(0, 2_000) : []
  }
  return normalized
}

/** Finite catalog for configuration UI. It is not the runtime wildcard authorization check. */
export function enumerateAccountOpenModels(
  account: Account,
  provider: ProviderDefinition | undefined
): string[] {
  if (account.modelPolicy === 'selected') return normalizeModels(account.modelAllowlist)
  return account.modelsRefreshedAt === undefined
    ? normalizeModels(provider?.models)
    : normalizeModels(account.availableModels)
}

/** Stable member-order union used as the set from which a pool can expose models. */
export function enumeratePoolAvailableModels(
  pool: Pool,
  accounts: readonly Account[],
  providers: readonly ProviderDefinition[]
): string[] {
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const models: string[] = []
  for (const member of pool.members) {
    if (!member.enabled) continue
    const account = accountsById.get(member.accountId)
    if (!account) continue
    models.push(...enumerateAccountOpenModels(account, providersById.get(account.providerId)))
  }
  return normalizeModels(models)
}

export function enumeratePoolOpenModels(
  pool: Pool,
  accounts: readonly Account[],
  providers: readonly ProviderDefinition[]
): string[] {
  const availableModels = enumeratePoolAvailableModels(pool, accounts, providers)
  return pool.modelPolicy === 'selected'
    ? intersectModels(pool.modelAllowlist, availableModels)
    : availableModels
}

function createDefaultClientProfiles(timestamp: number): ClientConfigProfile[] {
  return (['claude', 'codex', 'gemini'] as const).map((client) => ({
    id: `default-${client}`,
    name: '默认配置',
    client,
    backupRetention: 10,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp
  }))
}

function toSnapshot(
  state: PersistedState,
  status: GatewayStatus,
  vaultAvailable: boolean,
  vaultBackend: string,
  observability: AppSnapshot['observability']
): AppSnapshot {
  const { credentials: _credentials, accounts, proxies, ...safeState } = state
  return {
    ...safeState,
    accounts: accounts.map(({
      chatgptAccountId: _chatgptAccountId,
      credentialId: _credentialId,
      ...account
    }) => account),
    proxies: proxies.map(({ credentialId: _credentialId, ...proxy }) => ({
      ...proxy,
      hasPassword: Boolean(_credentialId && state.credentials[_credentialId])
    })),
    requestLogs: state.requestLogs,
    healthEvents: state.healthEvents,
    observability,
    gatewayStatus: { ...status },
    vaultAvailable,
    vaultBackend
  }
}

function redactKnownValues(value: string | undefined, sensitiveValues: readonly string[]): string | undefined {
  if (value === undefined) return undefined
  return sensitiveValues.reduce(
    (safe, sensitive) => sensitive && safe.includes(sensitive) ? safe.split(sensitive).join('[REDACTED]') : safe,
    value
  )
}

function sanitizePersistedMessage(
  value: string | undefined,
  sensitiveValues: readonly string[] | undefined
): string | undefined {
  if (value === undefined || value === '') return value
  if (!sensitiveValues) return 'Error details are unavailable while the system credential vault is locked.'
  const redacted = redactKnownValues(value, sensitiveValues) ?? ''
  return stripControlCharacters(redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(https?|socks[45]):\/\/[^\s/@]+@/gi, '$1://[REDACTED]@')
    .replace(
      /\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]'
    ))
    .trim()
    .slice(0, 1_000)
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}

function credentialSensitiveValues(decrypted: string, chatGptOAuth: boolean): string[] {
  if (!chatGptOAuth) return [decrypted]
  const bundle = deserializeChatGptCredential(decrypted)
  return bundle
    ? [decrypted, bundle.accessToken, bundle.accountId, bundle.userId, bundle.refreshToken, bundle.idToken]
      .filter((value): value is string => Boolean(value))
    : [decrypted]
}

function summarizeHourly(requestLogs: RequestLog[], now: number) {
  const hourMs = 60 * 60 * 1000
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const timestamp = now - (23 - index) * 60 * 60 * 1000
    return {
      timestamp,
      requestCount: 0,
      errorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyTotal: 0,
      failoverCount: 0
    }
  })
  for (const log of requestLogs) {
    if (log.timestamp > now) continue
    const hoursAgo = Math.floor((now - log.timestamp) / hourMs)
    const index = 23 - hoursAgo
    if (index < 0 || index >= buckets.length) continue
    const bucket = buckets[index]
    bucket.requestCount += 1
    if (log.status === 'error') bucket.errorCount += 1
    bucket.inputTokens += log.inputTokens ?? 0
    bucket.outputTokens += log.outputTokens ?? 0
    bucket.latencyTotal += log.latencyMs
    bucket.failoverCount += log.failoverCount ?? 0
  }
  return buckets.map(({ latencyTotal, ...bucket }) => ({
    ...bucket,
    averageLatencyMs: bucket.requestCount ? Math.round(latencyTotal / bucket.requestCount) : 0
  }))
}

function summarizeTokenRates(requestLogs: RequestLog[], now: number): TokenRateSeries {
  const configurations: Array<{
    key: keyof TokenRateSeries
    windowMs: number
    bucketCount: number
  }> = [
    { key: 'last30Minutes', windowMs: 30 * 60 * 1000, bucketCount: 30 },
    { key: 'last4Hours', windowMs: 4 * 60 * 60 * 1000, bucketCount: 48 },
    { key: 'last24Hours', windowMs: 24 * 60 * 60 * 1000, bucketCount: 48 },
    { key: 'last7Days', windowMs: 7 * 24 * 60 * 60 * 1000, bucketCount: 56 }
  ]
  const series = Object.fromEntries(configurations.map((configuration) => [
    configuration.key,
    Array.from({ length: configuration.bucketCount }, (_, index) => ({
      timestamp: now - configuration.windowMs + index * configuration.windowMs / configuration.bucketCount,
      requestCount: 0,
      outputTokens: 0,
      rateTotal: 0
    }))
  ])) as Record<keyof TokenRateSeries, Array<{
    timestamp: number
    requestCount: number
    outputTokens: number
    rateTotal: number
  }>>

  for (const log of requestLogs) {
    if (log.status !== 'success' || log.timestamp > now) continue
    if (!log.outputTokens || log.outputTokens <= 0 || log.latencyMs <= 0) continue
    // `firstTokenMs` is the first user-visible semantic token. Reasoning tokens
    // are generated before that point, so using it as the start while counting
    // all output tokens creates huge artificial rates. The first upstream body
    // byte marks the beginning of the streamed generation envelope instead.
    const generationStartedMs = log.upstreamFirstByteMs
      ?? log.clientFirstWriteMs
      ?? log.firstTokenMs
      ?? 0
    const generationDurationMs = log.latencyMs - generationStartedMs
    if (generationDurationMs <= 0) continue
    const tokensPerSecond = log.outputTokens * 1000 / generationDurationMs
    for (const configuration of configurations) {
      const windowStart = now - configuration.windowMs
      if (log.timestamp < windowStart) continue
      const bucketMs = configuration.windowMs / configuration.bucketCount
      const bucketIndex = Math.min(
        configuration.bucketCount - 1,
        Math.floor((log.timestamp - windowStart) / bucketMs)
      )
      const bucket = series[configuration.key][bucketIndex]
      bucket.requestCount += 1
      bucket.outputTokens += log.outputTokens
      bucket.rateTotal += tokensPerSecond
    }
  }

  return Object.fromEntries(configurations.map(({ key }) => [
    key,
    series[key].map(({ rateTotal, ...bucket }) => ({
      ...bucket,
      tokensPerSecond: bucket.requestCount
        ? Math.round(rateTotal / bucket.requestCount * 10) / 10
        : 0
    }))
  ])) as unknown as TokenRateSeries
}

function summarizeObservability(requestLogs: RequestLog[], windowStart: number, windowEnd: number) {
  let requestCount = 0
  let successCount = 0
  let errorCount = 0
  let latencyTotal = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let reasoningTokens = 0
  let failoverCount = 0
  const errorsByStatus: Record<string, number> = {}
  for (const log of requestLogs) {
    if (log.timestamp < windowStart || log.timestamp > windowEnd) continue
    requestCount += 1
    if (log.status === 'success') successCount += 1
    if (log.status === 'error') {
      errorCount += 1
      const key = String(log.statusCode ?? 'unknown')
      errorsByStatus[key] = (errorsByStatus[key] ?? 0) + 1
    }
    latencyTotal += log.latencyMs
    inputTokens += log.inputTokens ?? 0
    outputTokens += log.outputTokens ?? 0
    cachedInputTokens += log.cachedInputTokens ?? 0
    reasoningTokens += log.reasoningTokens ?? 0
    failoverCount += log.failoverCount ?? 0
  }
  return {
    windowStart,
    windowEnd,
    requestCount,
    successCount,
    errorCount,
    successRate: requestCount ? successCount / requestCount : 0,
    averageLatencyMs: requestCount ? Math.round(latencyTotal / requestCount) : 0,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    failoverCount,
    errorsByStatus
  }
}

function replaceById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) {
    items[index] = item
  }
}

function mergeAccountQuota(
  earlier: AccountQuotaSnapshot | undefined,
  later: AccountQuotaSnapshot
): AccountQuotaSnapshot {
  return {
    observedAt: later.observedAt,
    requests: later.requests ? { ...earlier?.requests, ...later.requests } : earlier?.requests,
    tokens: later.tokens ? { ...earlier?.tokens, ...later.tokens } : earlier?.tokens,
    inputTokens: later.inputTokens ? { ...earlier?.inputTokens, ...later.inputTokens } : earlier?.inputTokens,
    outputTokens: later.outputTokens ? { ...earlier?.outputTokens, ...later.outputTokens } : earlier?.outputTokens
  }
}

function mergeAccountCodexQuota(
  earlier: AccountCodexQuotaSnapshot | undefined,
  later: AccountCodexQuotaSnapshot
): AccountCodexQuotaSnapshot {
  return {
    observedAt: later.observedAt,
    source: later.source,
    allowed: later.allowed ?? earlier?.allowed,
    limitReached: later.limitReached ?? earlier?.limitReached,
    fiveHour: later.fiveHour ? { ...earlier?.fiveHour, ...later.fiveHour } : earlier?.fiveHour,
    sevenDay: later.sevenDay ? { ...earlier?.sevenDay, ...later.sevenDay } : earlier?.sevenDay
  }
}

function createId(): string {
  return randomUUID()
}

function createLocalToken(): string {
  return randomUUID().replaceAll('-', '')
}

function maskCredential(credential: string): string {
  return credential.length <= 4 ? '****' : `****${credential.slice(-4)}`
}

function maskAccountId(accountId: string): string {
  return accountId.length <= 8 ? 'chatgpt-****' : `chatgpt-****${accountId.slice(-4)}`
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Provider URLs must use HTTP or HTTPS.')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('Provider URLs must use HTTPS unless they are local.')
  }
  if (url.username || url.password) {
    throw new Error('Provider credentials must be stored on the account, not in the URL.')
  }
  if (url.search || url.hash) {
    throw new Error('Provider base URLs cannot contain a query string or fragment.')
  }
  return url.toString().replace(/\/$/, '')
}

function normalizeProxyHost(value: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('Proxy host is required.')
  if (raw.includes('://') || /[\s/@?#]/.test(raw)) {
    throw new Error('Proxy host must contain only a hostname or IP address.')
  }
  const candidate = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
  try {
    const parsed = new URL(`http://${candidate}:1`)
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    if (!host) throw new Error()
    return host
  } catch {
    throw new Error('Proxy host is invalid.')
  }
}

function optionalProxyId(value: string | undefined, proxies: ProxyDefinition[]): string | undefined {
  const id = value?.trim()
  if (!id) return undefined
  if (!proxies.some((proxy) => proxy.id === id)) throw new Error('Choose an existing proxy.')
  return id
}

function optionalAccountTagId(
  value: string | null | undefined,
  tags: readonly AccountTagDefinition[]
): string | undefined {
  const id = value?.trim()
  if (!id) return undefined
  if (!tags.some((tag) => tag.id === id)) throw new Error('Choose an existing account tag.')
  return id
}

function validateChatGptImportPoolId(value: string | null | undefined, pools: readonly Pool[]): Pool | undefined {
  const id = value?.trim()
  if (!id) return undefined
  const pool = pools.find((candidate) => candidate.id === id)
  if (!pool) throw new Error('The selected pool no longer exists.')
  if (pool.kind !== 'standard' || pool.protocol !== 'openai-responses') {
    throw new Error('Imported ChatGPT accounts can only join a standard OpenAI Responses pool.')
  }
  return pool
}

function ensureOAuthSystemProvider(state: PersistedState, timestamp: number): ProviderDefinition {
  const existing = state.providers.find((provider) =>
    provider.sourceType === 'oauth-system'
    && provider.kind === 'openai'
    && provider.protocol === 'openai-responses')
  if (existing) return existing
  const preferredId = 'provider-chatgpt-oauth'
  const provider: ProviderDefinition = {
    id: state.providers.some((candidate) => candidate.id === preferredId) ? createId() : preferredId,
    name: 'ChatGPT OAuth',
    sourceType: 'oauth-system',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    color: '#10a37f',
    models: ['gpt-5', 'gpt-5-mini', 'o3'],
    createdAt: timestamp,
    updatedAt: timestamp
  }
  state.providers.push(provider)
  return provider
}

function migrateSourceTopology(
  sourceProviders: ProviderDefinition[],
  sourceAccounts: Account[],
  timestamp: number
): { providers: ProviderDefinition[]; accounts: Account[] } {
  const providers = sourceProviders.map((provider) => ({ ...provider }))
  const accounts = sourceAccounts.map((account) => ({ ...account }))
  const oauthAccounts = accounts.filter((account) => account.credentialType === 'chatgpt-oauth')
  let oauthProvider = providers.find((provider) => provider.sourceType === 'oauth-system')
  if (oauthAccounts.length > 0 && !oauthProvider) {
    let id = 'provider-chatgpt-oauth'
    let suffix = 1
    while (providers.some((provider) => provider.id === id)) id = `provider-chatgpt-oauth-${suffix++}`
    oauthProvider = {
      id,
      name: 'ChatGPT OAuth',
      sourceType: 'oauth-system',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      color: '#10a37f',
      models: ['gpt-5', 'gpt-5-mini', 'o3'],
      createdAt: timestamp,
      updatedAt: timestamp
    }
    providers.push(oauthProvider)
  }
  if (oauthProvider) {
    Object.assign(oauthProvider, {
      name: 'ChatGPT OAuth',
      sourceType: 'oauth-system',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    } satisfies Partial<ProviderDefinition>)
    for (const account of oauthAccounts) account.providerId = oauthProvider.id
  }

  // Corrupt/legacy API-key accounts must never remain under the hidden OAuth provider.
  for (const account of accounts.filter((candidate) => candidate.credentialType !== 'chatgpt-oauth')) {
    const provider = providers.find((candidate) => candidate.id === account.providerId)
    if (!provider || provider.sourceType !== 'oauth-system') continue
    const id = uniqueMigratedProviderId(providers, `${provider.id}--api-${account.id}`)
    const clone: ProviderDefinition = {
      ...provider,
      id,
      name: account.name || provider.name,
      sourceType: inferProviderSourceType(provider.kind, provider.baseUrl),
      createdAt: account.createdAt || timestamp,
      updatedAt: timestamp
    }
    providers.push(clone)
    account.providerId = clone.id
  }

  // Legacy Providers allowed multiple keys. Split them into one stable source per account.
  for (const provider of [...providers]) {
    if (provider.sourceType === 'oauth-system') continue
    const members = accounts.filter((account) => account.providerId === provider.id && account.credentialType !== 'chatgpt-oauth')
    for (const account of members.slice(1)) {
      const id = uniqueMigratedProviderId(providers, `${provider.id}--account-${account.id}`)
      providers.push({
        ...provider,
        id,
        name: account.name || provider.name,
        createdAt: account.createdAt || provider.createdAt,
        updatedAt: Math.max(provider.updatedAt, account.updatedAt)
      })
      account.providerId = id
    }
  }

  const referencedProviderIds = new Set(accounts.map((account) => account.providerId))
  return {
    providers: providers.filter((provider) => provider.sourceType !== 'oauth-system'
      || provider.id === oauthProvider?.id
      || referencedProviderIds.has(provider.id)),
    accounts
  }
}

function uniqueMigratedProviderId(providers: readonly ProviderDefinition[], preferred: string): string {
  if (!providers.some((provider) => provider.id === preferred)) return preferred
  let suffix = 1
  while (providers.some((provider) => provider.id === `${preferred}-${suffix}`)) suffix += 1
  return `${preferred}-${suffix}`
}

function inferProviderSourceType(kind: ProviderInput['kind'], baseUrl: string): ProviderDefinition['sourceType'] {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (
      (kind === 'openai' && hostname === 'api.openai.com')
      || (kind === 'anthropic' && hostname === 'api.anthropic.com')
      || (kind === 'google' && hostname === 'generativelanguage.googleapis.com')
    ) return 'official-api'
  } catch {
    // URL validation happens before this inference is persisted.
  }
  return 'relay'
}

function isUpstreamSourceType(value: unknown): value is ProviderDefinition['sourceType'] {
  return value === 'oauth-system' || value === 'official-api' || value === 'relay'
}

function normalizePersistedAccountTags(value: unknown): AccountTagDefinition[] {
  if (!Array.isArray(value)) return []
  const tags: AccountTagDefinition[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const candidate of value) {
    if (tags.length >= 50) break
    if (!candidate || typeof candidate !== 'object') continue
    const tag = candidate as Partial<AccountTagDefinition>
    const id = typeof tag.id === 'string' ? tag.id.trim() : ''
    const name = typeof tag.name === 'string' ? tag.name.trim() : ''
    const normalizedName = name.toLocaleLowerCase()
    if (!id || !name || name.length > 24 || ids.has(id) || names.has(normalizedName)) continue
    ids.add(id)
    names.add(normalizedName)
    tags.push({
      id,
      name,
      createdAt: normalizeTimestamp(tag.createdAt) ?? Date.now(),
      updatedAt: normalizeTimestamp(tag.updatedAt) ?? normalizeTimestamp(tag.createdAt) ?? Date.now()
    })
  }
  return tags
}

function positiveOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonNegativeOptionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

interface AccountImportProxySelection {
  mode: ChatGptAccountImportProxyMode
  proxyId?: string
}

function normalizeAccountImportProxySelection(
  mode: ChatGptAccountImportProxyMode | undefined,
  proxyId: string | undefined,
  proxies: readonly ProxyDefinition[]
): AccountImportProxySelection {
  const normalizedMode = mode ?? 'preserve'
  if (!['preserve', 'direct', 'proxy'].includes(normalizedMode)) {
    throw new Error('不支持的账号导入代理选项。')
  }
  if (normalizedMode !== 'proxy') return { mode: normalizedMode }
  const normalizedProxyId = proxyId?.trim()
  if (!normalizedProxyId) throw new Error('请选择一个出口代理后再导入账号。')
  if (!proxies.some((proxy) => proxy.id === normalizedProxyId)) {
    throw new Error('选择的出口代理已被删除，请重新选择后再导入。')
  }
  return { mode: 'proxy', proxyId: normalizedProxyId }
}

export function validateAccountImportProxySelection(
  mode: ChatGptAccountImportProxyMode | undefined,
  proxyId: string | undefined,
  proxies: readonly ProxyDefinition[]
): void {
  normalizeAccountImportProxySelection(mode, proxyId, proxies)
}

export function resolveImportedAccountProxyId(
  selection: AccountImportProxySelection,
  fileProxyId: string | undefined,
  proxies: readonly Pick<ProxyDefinition, 'id'>[]
): string | undefined {
  if (selection.mode === 'direct') return undefined
  if (selection.mode === 'proxy') {
    if (!selection.proxyId || !proxies.some((proxy) => proxy.id === selection.proxyId)) {
      throw new Error('选择的出口代理已被删除，请重新选择后再导入。')
    }
    return selection.proxyId
  }
  const normalizedFileProxyId = fileProxyId?.trim()
  return normalizedFileProxyId && proxies.some((proxy) => proxy.id === normalizedFileProxyId)
    ? normalizedFileProxyId
    : undefined
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return [...new Set(models
    .filter((model): model is string => typeof model === 'string')
    .map((model) => model.trim())
    .filter(Boolean))]
}

function intersectModels(models: unknown, availableModels: unknown): string[] {
  const available = new Set(normalizeModels(availableModels))
  return normalizeModels(models).filter((model) => available.has(model))
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function isModelPolicy(value: unknown): value is ModelPolicy {
  return value === 'all' || value === 'selected'
}

function normalizePersistedModelPolicy(value: unknown, modelAllowlist: readonly string[]): ModelPolicy {
  return isModelPolicy(value) ? value : modelAllowlist.length > 0 ? 'selected' : 'all'
}

function resolveAccountInputModelPolicy(
  value: ModelPolicy | undefined,
  modelAllowlist: readonly string[]
): ModelPolicy {
  if (value !== undefined) {
    if (!isModelPolicy(value)) throw new Error('Unsupported account model policy.')
    return value
  }
  return modelAllowlist.length > 0 ? 'selected' : 'all'
}

function resolvePoolInputModelPolicy(
  value: ModelPolicy | undefined,
  modelAllowlistProvided: boolean,
  existing: Pool | undefined
): ModelPolicy {
  if (value !== undefined) {
    if (!isModelPolicy(value)) throw new Error('Unsupported pool model policy.')
    return value
  }
  if (!modelAllowlistProvided && existing) return existing.modelPolicy
  return 'all'
}

function mergeStandardPoolMembers(
  existingMembers: readonly PoolMember[],
  enabledAccountIds: readonly string[],
  protocol: ProviderDefinition['protocol'],
  accounts: readonly Account[],
  providers: readonly ProviderDefinition[],
): PoolMember[] {
  const remainingEnabledIds = new Set(enabledAccountIds)
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const members: PoolMember[] = []

  for (const existingMember of existingMembers) {
    if (remainingEnabledIds.delete(existingMember.accountId)) {
      members.push({ ...existingMember, enabled: true })
      continue
    }
    const account = accountById.get(existingMember.accountId)
    const provider = account ? providerById.get(account.providerId) : undefined
    if (!existingMember.enabled && provider?.protocol === protocol && provider.sourceType !== 'relay') {
      members.push({ ...existingMember, enabled: false })
    }
  }

  for (const accountId of enabledAccountIds) {
    if (remainingEnabledIds.delete(accountId)) members.push({ accountId, enabled: true })
  }
  return members
}

function sameModels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index])
}

function accountModelDiscoveryFingerprint(state: PersistedState, accountId: string): string {
  const account = state.accounts.find((candidate) => candidate.id === accountId)
  if (!account) throw new Error('Account not found.')
  const provider = state.providers.find((candidate) => candidate.id === account.providerId)
  if (!provider) throw new Error('The account provider no longer exists.')
  const credentialIdentity = account.credentialType === 'chatgpt-oauth'
    ? { type: 'chatgpt-oauth', accountId: account.chatgptAccountId ?? '' }
    : {
        type: 'api-key',
        credentialId: account.credentialId,
        encryptedCredential: state.credentials[account.credentialId] ?? ''
      }
  return createHash('sha256').update(JSON.stringify({
    account: {
      id: account.id,
      providerId: account.providerId,
      name: account.name,
      proxyId: account.proxyId ?? null,
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelPolicy: account.modelPolicy,
      modelAllowlist: account.modelAllowlist,
      availableModels: account.availableModels,
      modelsRefreshedAt: account.modelsRefreshedAt ?? null,
      credential: credentialIdentity
    },
    provider: {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      models: provider.models
    }
  })).digest('hex')
}

function reconcilePoolModelAllowlists(
  state: Pick<PersistedState, 'accounts' | 'pools'>,
  timestamp: number,
  affectedAccountIds?: ReadonlySet<string>
): void {
  const accountsById = new Map(state.accounts.map((account) => [account.id, account]))
  for (const pool of state.pools) {
    if (pool.modelPolicy !== 'selected') continue
    if (affectedAccountIds && !pool.members.some((member) => affectedAccountIds.has(member.accountId))) continue
    const modelAllowlist = pool.modelAllowlist.filter((model) => pool.members.some((member) => {
      if (!member.enabled) return false
      const account = accountsById.get(member.accountId)
      if (!account) return false
      if (account.modelPolicy === 'selected') return account.modelAllowlist.includes(model)
      if (account.modelsRefreshedAt !== undefined) return account.availableModels.includes(model)
      return true
    }))
    if (sameModels(modelAllowlist, pool.modelAllowlist)) continue
    pool.modelAllowlist = modelAllowlist
    pool.updatedAt = timestamp
  }
}

function normalizeModelMap(modelMap: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(modelMap)
      .map(([source, target]) => [source.trim(), target.trim()] as const)
      .filter(([source, target]) => source.length > 0 && target.length > 0)
  )
}

function requiredName(value: string, label: string): string {
  const name = value.trim()
  if (!name) throw new Error(`${label} is required.`)
  if (name.length > 120) throw new Error(`${label} cannot exceed 120 characters.`)
  return name
}

function inspectCredentialVault(): { available: boolean; backend: string } {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { available: false, backend: 'Unavailable' }
    }
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') {
        return { available: false, backend: `Linux ${backend} (insecure)` }
      }
      return { available: true, backend: `Linux ${backend}` }
    }
    return {
      available: true,
      backend: process.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI'
    }
  } catch {
    return { available: false, backend: 'Unavailable' }
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? Math.floor(value)
    : fallback
}

function normalizeGatewaySettings(settings: GatewaySettings): GatewaySettings {
  if (settings.host !== '127.0.0.1' && settings.host !== '::1' && settings.host !== 'localhost') {
    throw new Error('Stone only listens on a local loopback address.')
  }
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
    throw new Error('Gateway port must be between 1024 and 65535.')
  }
  return {
    host: settings.host,
    port: settings.port,
    autoStart: Boolean(settings.autoStart),
    // Payload persistence is intentionally disabled until retention and redaction policies exist.
    logPayloads: false,
    requestTimeoutSeconds: Math.max(5, Math.min(600, Math.floor(settings.requestTimeoutSeconds))),
    launchAtLogin: Boolean(settings.launchAtLogin),
    desktopNotifications: settings.desktopNotifications !== false,
    automaticBackups: settings.automaticBackups !== false,
    backupRetention: boundedInteger(settings.backupRetention ?? 10, 1, 100, 10),
    outboundNetworkMode: settings.outboundNetworkMode === 'system' ? 'system' : 'direct'
  }
}
