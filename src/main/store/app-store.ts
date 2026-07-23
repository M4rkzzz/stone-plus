import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { isAbsolute, join, normalize } from 'node:path'
import { valid as validSemver } from 'semver'
import { clientNativeProtocols, supportsFastServiceTier } from '@shared/types'
import {
  accumulateOpenAiTokenCost,
  createOpenAiTokenCostAccumulator,
  finishOpenAiTokenCostAccumulator,
  localNaturalDayStart,
  summarizeAccountCodexQuotaCycleCosts
} from '@shared/openai-pricing'
import {
  appendRuntimeRouteSourcePools,
  hasRouteSourceIdCollision,
  isAvailableRouteAccount,
  resolveRouteSource,
} from '@shared/route-sources'
import {
  inferUpstreamCapabilities,
  normalizeCapabilityProfile,
  normalizeModelCatalog,
} from '@shared/source-capabilities'
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
  ApiSourceProbeInput,
  ApiSourceProbeResult,
  AppSnapshot,
  BuiltInProxyNodeSummary,
  BuiltInProxyCustomRuleSet,
  BuiltInProxyEditableRule,
  BuiltInProxyProfileSummary,
  BuiltInProxySettings,
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
  OpenAiTokenCostBreakdown,
  Pool,
  PoolInput,
  PoolMember,
  ProxyDefinition,
  ProxyInput,
  PublicProxyDefinition,
  QuotaProtectionPolicy,
  ProviderDefinition,
  ProviderInput,
  ResponsesCompactMode,
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
import type {
  BuiltInProxyProfileSecrets,
  BuiltInProxyProfileStoreInput,
  PersistedBuiltInProxyProfile,
  PersistedState
} from './types'
import type { SqliteStateSection } from './sqlite-state-store'
import { getProviderAdapter } from '../providers'
import {
  chatGptAccessTokenOnlyWarning,
  agentIdentitySensitiveValues,
  deserializeChatGptAgentIdentity,
  deserializeChatGptCredential,
  matchesChatGptCredential,
  parseChatGptAccountImport,
  parseChatGptAgentIdentityImport,
  serializeChatGptAgentIdentity,
  serializeChatGptCredential
} from '../auth'
import { applySetupRoutingDraft } from '../setup/setup-routing'
import { SetupWizardRepository } from '../setup/setup-state'
import { PersistentTaskRunner } from '../tasks'
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
  responsesWebSocketEnabled: false,
  disableCodexMicro: false,
  launchAtLogin: false,
  desktopNotifications: true,
  automaticBackups: true,
  backupRetention: 10,
  outboundNetworkMode: 'direct'
}

const DEFAULT_BUILT_IN_PROXY_SETTINGS: Omit<BuiltInProxySettings, 'updatedAt'> = {
  desiredEnabled: false,
  accessMode: 'system',
  ruleMode: 'rule',
  // Zero means unassigned. SingBoxService selects a free loopback port on the
  // first activation and persists the concrete lease before route takeover.
  mixedPort: 0,
  lanEnabled: false,
  autoStart: true,
  hasEverActivated: false
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
const MAX_LIVE_REQUEST_LOGS = MAX_RENDERER_REQUEST_LOGS
const MAX_CLEARED_REQUEST_LOG_TOMBSTONES = MAX_PERSISTED_REQUEST_LOGS * 2
const FITNESS_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000
const FITNESS_HISTORY_ROWS_PER_ACCOUNT = 400
const IGNORED_UPDATE_VERSION_KEY = 'ignored_update_version'
const OBSERVABILITY_CACHE_TTL_MS = 1_000
const OBSERVABILITY_IDLE_CACHE_TTL_MS = 60_000
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
  private readonly persistentTasks: PersistentTaskRunner
  private status: GatewayStatus = { ...DEFAULT_STATUS }
  /**
   * In-flight request telemetry is renderer state, not durable application
   * configuration. Keeping it outside the SQLite snapshot prevents frequent
   * streaming progress from cloning and committing the full request history.
   */
  private readonly liveRequestLogs = new Map<string, { log: RequestLog; version: number }>()
  private readonly liveRequestLogOrder: string[] = []
  private readonly uncheckpointedLiveRequestLogIds = new Set<string>()
  private readonly terminalizingRequestLogIds = new Set<string>()
  /** Terminal lifecycle tombstones prevent a delayed progress callback from
   * resurrecting a row after its durable completion was accepted. */
  private readonly terminalRequestLogIds = new Set<string>()
  /** IDs observed before a clear operation. Delayed terminal/title callbacks
   * for those lifecycles must not recreate rows after the user cleared logs. */
  private readonly clearedRequestLogIds = new Set<string>()
  /** Active requests may finish after history is cleared. Preserve only their
   * last durable checkpoints so lifetime totals can apply the terminal delta
   * without recreating a visible request row. */
  private readonly clearedLiveRequestLogBaselines = new Map<string, RequestLog | null>()
  private readonly clearedLifetimeTokenWrites = new Map<string, Promise<void>>()
  /** A terminal callback that races history clearing must wait until the clear
   * transaction has captured any queued durable checkpoint it replaces. */
  private requestLogClearBarrier: Promise<void> | undefined
  private liveRequestLogVersion = 0
  private requestLogRevision = 0
  private observabilityCache?: {
    revision: number
    expiresAt: number
    idleExpiresAt: number
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
    this.persistentTasks = new PersistentTaskRunner(this.store)
  }

  public async initialize(): Promise<void> {
    await this.store.initialize()
    await this.persistentTasks.recover()
    await this.persistentTasks.pruneTerminalTasks()
    if (this.store.select((state) => state.requestLogs.some((log) => log.status === 'streaming'))) {
      await this.store.updateRequestLogs<RequestLog>((log) => log.status === 'streaming'
        ? {
            ...log,
            status: 'error',
            statusCode: 499,
            failureStage: 'client',
            error: 'Gateway stopped before the request completed'
          }
        : undefined)
      this.requestLogRevision += 1
    }
    await this.sanitizePersistedData()
  }

  public async sanitizePersistedData(): Promise<void> {
    await this.sanitizePersistedMessages()
    await this.store.pruneCodexQuotaHistory(Date.now() - 14 * 24 * 60 * 60 * 1000)
  }

  public async close(): Promise<void> {
    // Plaintext credentials are an in-memory optimization only. Drop them as
    // soon as shutdown starts, including when later persistence cleanup fails.
    this.invalidateCredentialCache()
    // A clear keeps the old live generation in memory until its SQLite delete
    // commits so it can roll back safely. Do not checkpoint that generation
    // behind the delete during shutdown, or it would resurrect cleared rows.
    while (this.requestLogClearBarrier) await this.requestLogClearBarrier
    // A clean shutdown keeps the existing restart reconciliation behaviour for
    // genuinely long-running requests. Short requests normally reach a terminal
    // row without ever touching SQLite while streaming.
    // If every terminal retry failed, retain the last live row as a restart
    // checkpoint rather than dropping the lifecycle entirely. Initialization
    // will convert that streaming row into an explicit 499 terminal record.
    await this.checkpointLiveRequestLogs({ force: true, includeTerminalizing: true })
    this.liveRequestLogs.clear()
    this.liveRequestLogOrder.length = 0
    this.uncheckpointedLiveRequestLogIds.clear()
    this.terminalizingRequestLogIds.clear()
    this.terminalRequestLogIds.clear()
    this.clearedRequestLogIds.clear()
    this.clearedLiveRequestLogBaselines.clear()
    this.clearedLifetimeTokenWrites.clear()
    this.requestLogClearBarrier = undefined
    try {
      await this.store.close()
    } finally {
      this.invalidateCredentialCache()
    }
  }

  public getStateRepository(): SqliteStateStore<PersistedState> {
    return this.store
  }

  /** Restore/lifecycle hook: discard every plaintext derived from old state. */
  public invalidateCredentialCache(): void {
    this.decryptedCredentialCache.clear()
  }

  public getPersistentTaskRunner(): PersistentTaskRunner {
    return this.persistentTasks
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
    const liveLogs = this.liveRequestLogOrder
      .slice(-MAX_RENDERER_REQUEST_LOGS)
      .reverse()
      .map((id) => this.liveRequestLogs.get(id)?.log)
      .filter((log): log is RequestLog => Boolean(log))
    const liveIds = new Set(liveLogs.map((log) => log.id))
    const state = this.store.select((current) => {
      const requestLogs = liveLogs.slice(0, MAX_RENDERER_REQUEST_LOGS)
      for (const log of current.requestLogs) {
        if (requestLogs.length >= MAX_RENDERER_REQUEST_LOGS) break
        if (!liveIds.has(log.id)) requestLogs.push(log)
      }
      // Do not spread the repository snapshot here: although the renderer
      // receives only a bounded log window, spreading the whole state makes it
      // too easy for a future field to pull the retained 20k-row history into
      // structuredClone. Keep the projection explicit and bounded.
      return {
        version: current.version,
        providers: current.providers,
        accounts: current.accounts,
        accountTags: current.accountTags,
        proxies: current.proxies,
        builtInProxySettings: current.builtInProxySettings,
        proxyProfiles: current.proxyProfiles,
        pools: current.pools,
        routes: current.routes,
        gateway: current.gateway,
        requestLogs,
        credentials: current.credentials,
        clientProfiles: current.clientProfiles,
        healthEvents: current.healthEvents
      }
    })
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
    // bounded even while new logs continuously advance the revision. An idle
    // cache still expires periodically so sliding 24-hour/7-day windows cannot
    // retain old requests forever merely because no new terminal log arrived.
    if (this.observabilityCache && (
      (
        this.observabilityCache.revision === this.requestLogRevision
        && this.observabilityCache.idleExpiresAt > now
      )
      || this.observabilityCache.expiresAt > now
    )) {
      return structuredClone(this.observabilityCache.value)
    }
    // Derive every dashboard series in one traversal. The previous independent
    // helpers each walked the retained 20k rows (pricing walked them twice), so
    // one terminal log could trigger several redundant full-history passes.
    const lifetimeTokenCosts = this.store.readLifetimeTokenCosts()
    const value = this.store.select((state) => summarizeAppObservability(
      state.requestLogs,
      now,
      lifetimeTokenCosts
    ))
    this.observabilityCache = {
      revision: this.requestLogRevision,
      expiresAt: now + OBSERVABILITY_CACHE_TTL_MS,
      idleExpiresAt: now + OBSERVABILITY_IDLE_CACHE_TTL_MS,
      value
    }
    return structuredClone(value)
  }

  public getRuntimeAccounts(): Account[] {
    return this.store.select((state) => state.accounts)
  }

  public getRuntimeAccount(id: string): Account | undefined {
    return this.store.selectAccount<Account>(id)
  }

  public getPublicRuntimeAccounts(ids?: ReadonlySet<string>): AppSnapshot['accounts'] {
    return this.store.select((state) => state.accounts
      .filter((account) => !ids || ids.has(account.id))
      .map(({ chatgptAccountId: _chatgptAccountId, credentialId: _credentialId, ...account }) => account))
  }

  public getRuntimeGatewaySettings(): GatewaySettings {
    return this.store.select((state) => state.gateway)
  }

  public getRuntimeObservability(): AppSnapshot['observability'] {
    return this.getObservability()
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
    await this.store.mutate((state) => {
      const existing = input.id ? state.providers.find((provider) => provider.id === input.id) : undefined
      const sourceType = input.sourceType ?? existing?.sourceType ?? inferProviderSourceType(input.kind, input.baseUrl)
      const responsesCompactMode = resolveResponsesCompactModeInput(
        input.responsesCompactMode,
        existing?.responsesCompactMode,
        sourceType,
        input.protocol
      )
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
        ...(responsesCompactMode ? { responsesCompactMode } : {}),
        capabilityProfile: normalizeCapabilityProfile(
          input.capabilityProfile ?? existing?.capabilityProfile,
          inferUpstreamCapabilities({ protocol: input.protocol, sourceType, responsesCompactMode }),
        ),
        modelCatalog: normalizeModelCatalog(
          input.modelCatalog ?? existing?.modelCatalog,
          normalizeModels(input.models),
          normalizeCapabilityProfile(
            input.capabilityProfile ?? existing?.capabilityProfile,
            inferUpstreamCapabilities({ protocol: input.protocol, sourceType, responsesCompactMode }),
          ),
        ),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      if (existing) {
        replaceById(state.providers, provider)
      } else {
        state.providers.push(provider)
      }
    }, ['providers', 'accounts'])
    return this.getSnapshot()
  }

  public async deleteProvider(id: string): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      if (state.accounts.some((account) => account.providerId === id)) {
        throw new Error('Delete the accounts under this provider first.')
      }
      state.providers = state.providers.filter((provider) => provider.id !== id)
      const timestamp = Date.now()
      state.routes = state.routes.map((route) => route.poolId === id
        ? { ...route, enabled: false, poolId: '', updatedAt: timestamp }
        : route)
    }, ['providers', 'routes'])
    return this.getSnapshot()
  }

  public async saveApiSource(
    input: ApiSourceInput,
    options: { acceptInitialProbeEvidence?: boolean } = {},
  ): Promise<{ snapshot: AppSnapshot; source: SavedApiSourceDraft }> {
    const { probeEvidenceToken: _probeEvidenceToken, ...sourceInput } = input
    const authorizedInput: ApiSourceInput = !sourceInput.id && !options.acceptInitialProbeEvidence
      ? { ...sourceInput, capabilityProfile: undefined, modelCatalog: undefined }
      : sourceInput
    let saved: SavedApiSourceDraft | undefined
    await this.store.mutate((state) => {
      saved = saveApiSourceDraft(state, authorizedInput, (credential) => this.encrypt(credential))
    }, ['providers', 'accounts', 'credentials', 'pools', 'routes'])
    this.pruneCredentialCache()
    if (!saved) throw new Error('API source could not be saved.')
    return { snapshot: this.getSnapshot(), source: saved }
  }

  public async saveApiSourceCapabilityProbe(
    sourceId: string,
    result: Pick<ApiSourceProbeResult, 'capabilityProfile' | 'modelCatalog' | 'models'>,
    expectedConnectionFingerprint: string,
  ): Promise<AppSnapshot | undefined> {
    const timestamp = Date.now()
    let persisted = false
    await this.store.mutate((state) => {
      const provider = state.providers.find((candidate) => candidate.id === sourceId)
      if (!provider || provider.sourceType === 'oauth-system') throw new Error('API source not found.')
      if (apiSourceConnectionFingerprint(state, sourceId, (encrypted) => this.decrypt(encrypted))
        !== expectedConnectionFingerprint) return
      const fallback = inferUpstreamCapabilities({
        protocol: provider.protocol,
        sourceType: provider.sourceType,
        responsesCompactMode: provider.responsesCompactMode,
      })
      const capabilityProfile = normalizeCapabilityProfile(result.capabilityProfile, fallback)
      const models = result.models.length ? normalizeModels(result.models) : provider.models
      replaceById(state.providers, {
        ...provider,
        models,
        capabilityProfile,
        modelCatalog: normalizeModelCatalog(result.modelCatalog, models, capabilityProfile),
        // `updatedAt` also acts as the optimistic probe revision below. Keep it
        // monotonic even when two probes finish within the same millisecond.
        updatedAt: Math.max(timestamp, provider.updatedAt + 1),
      })
      persisted = true
    }, ['providers'])
    return persisted ? this.getSnapshot() : undefined
  }

  /**
   * Fingerprint the exact connection and capability revision used by a source
   * probe. The digest never leaves the main process. Display/scheduling fields
   * remain excluded, while the revision prevents an older concurrent probe
   * from overwriting a newer capability result on the same connection.
   */
  public getApiSourceProbeConnectionFingerprint(input: ApiSourceProbeInput): string {
    if (!input.id?.trim()) throw new Error('API source id is required for a persistent capability probe.')
    return this.store.select((state) => apiSourceProbeInputFingerprint(
      state,
      input,
      (encrypted) => this.decrypt(encrypted),
    ))
  }

  public getApiSourceCredential(sourceId: string): string | undefined {
    const state = this.store.read()
    const provider = state.providers.find((candidate) => candidate.id === sourceId)
    if (!provider || provider.sourceType === 'oauth-system') return undefined
    const account = state.accounts.find((candidate) => candidate.providerId === sourceId
      && candidate.credentialType !== 'chatgpt-oauth'
      && candidate.credentialType !== 'chatgpt-agent-identity')
    if (!account) return undefined
    const encrypted = state.credentials[account.credentialId]
    return encrypted ? this.decrypt(encrypted) : undefined
  }

  public async deleteApiSource(id: string): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      deleteApiSourceDraft(state, id)
    }, ['providers', 'accounts', 'credentials', 'pools', 'routes'])
    this.pruneCredentialCache()
    return this.getSnapshot()
  }

  public async saveAggregateRelay(input: AggregateRelayInput): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      saveAggregateRelayDraft(state, input)
    }, ['pools'])
    return this.getSnapshot()
  }

  public async setProviderModels(id: string, models: string[]): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.mutate((state) => {
      const provider = state.providers.find((candidate) => candidate.id === id)
      if (!provider) throw new Error('Provider not found.')
      provider.models = normalizeModels(models)
      provider.updatedAt = timestamp
    }, ['providers', 'accounts'])
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
    await this.store.mutate((state) => {
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
    }, ['accounts', 'pools'])
    return this.getSnapshot()
  }

  public async saveAccount(input: AccountInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Account name')
    const timestamp = Date.now()
    await this.store.mutate((state) => {
      if (!state.providers.some((provider) => provider.id === input.providerId)) {
        throw new Error('Choose an existing provider before saving an account.')
      }
      const existing = input.id ? state.accounts.find((account) => account.id === input.id) : undefined
      if ((existing?.credentialType === 'chatgpt-oauth' || existing?.credentialType === 'chatgpt-agent-identity') && (
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
      if (input.tagId !== undefined && existing?.credentialType !== 'chatgpt-oauth' && existing?.credentialType !== 'chatgpt-agent-identity') {
        throw new Error('Only ChatGPT accounts can use account tags.')
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
        quotaProtection: input.quotaProtection === undefined
          ? existing?.quotaProtection
          : normalizeQuotaProtection(input.quotaProtection),
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
    }, ['providers', 'accounts', 'credentials', 'pools'])
    this.pruneCredentialCache()
    return this.getSnapshot()
  }

  public async saveAccountTag(input: AccountTagInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Tag name')
    if (name.length > 24) throw new Error('Tag name cannot exceed 24 characters.')
    const timestamp = Date.now()
    await this.store.mutate((state) => {
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
    }, ['accountTags'])
    return this.getSnapshot()
  }

  public async deleteAccountTag(id: string): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.mutate((state) => {
      if (!state.accountTags.some((tag) => tag.id === id)) throw new Error('Account tag not found.')
      state.accountTags = state.accountTags.filter((tag) => tag.id !== id)
      for (const account of state.accounts) {
        if (account.tagId !== id) continue
        account.tagId = undefined
        account.updatedAt = timestamp
      }
    }, ['accountTags', 'accounts'])
    return this.getSnapshot()
  }

  public async setAccountTags(input: AccountTagAssignmentInput): Promise<AppSnapshot> {
    const accountIds = [...new Set(input.accountIds.filter((id) => typeof id === 'string' && id.trim()))]
    if (accountIds.length === 0) throw new Error('Select at least one account.')
    const timestamp = Date.now()
    await this.store.mutate((state) => {
      const missing = accountIds.filter((id) => !state.accounts.some((account) => account.id === id))
      if (missing.length > 0) throw new Error('One of the selected accounts no longer exists.')
      if (state.accounts.some((account) => accountIds.includes(account.id)
        && account.credentialType !== 'chatgpt-oauth'
        && account.credentialType !== 'chatgpt-agent-identity')) {
        throw new Error('Only ChatGPT accounts can use account tags.')
      }
      const tagId = optionalAccountTagId(input.tagId, state.accountTags)
      const selected = new Set(accountIds)
      for (const account of state.accounts) {
        if (!selected.has(account.id) || account.tagId === tagId) continue
        account.tagId = tagId
        account.updatedAt = timestamp
      }
    }, ['accounts'])
    return this.getSnapshot()
  }

  public async importChatGptAccounts(input: ChatGptAccountImportInput) {
    const parsedAgentIdentities = parseChatGptAgentIdentityImport(input.content)
    let parsed: ReturnType<typeof parseChatGptAccountImport>
    try {
      parsed = parseChatGptAccountImport(input.content)
    } catch (error) {
      if (!parsedAgentIdentities.identities.length) throw error
      parsed = {
        accounts: [], proxyIds: [], warnings: [],
        accessTokenOnlyCount: 0, repairedAccountIdCount: 0
      }
    }
    const importedAccountIds: string[] = []
    const createdAccountIds: string[] = []
    const updatedAccountIds: string[] = []
    let accessTokenOnlyCount = 0
    let ignoredFileProxyCount = 0
    const timestamp = Date.now()
    await this.store.mutate((state) => {
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
          quotaProtection: existing?.quotaProtection,
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
      for (const [index, bundle] of parsedAgentIdentities.identities.entries()) {
        let existing: Account | undefined
        for (const candidate of state.accounts) {
          if (candidate.credentialType !== 'chatgpt-agent-identity') continue
          const encrypted = state.credentials[candidate.credentialId]
          const serialized = encrypted ? this.decrypt(encrypted) : undefined
          const saved = serialized ? deserializeChatGptAgentIdentity(serialized) : undefined
          if (!saved || saved.accountId !== bundle.accountId || saved.userId !== bundle.userId) continue
          existing = candidate
          break
        }
        const accountId = existing?.id ?? createId()
        const credentialId = existing?.credentialId ?? createId()
        state.credentials[credentialId] = this.encrypt(serializeChatGptAgentIdentity(bundle))
        const account: Account = {
          id: accountId,
          providerId: provider.id,
          name: requiredName(input.name?.trim() || existing?.name || bundle.email || `Agent Identity ${index + 1}`, 'Account name'),
          credentialId,
          maskedCredential: maskAccountId(bundle.accountId),
          credentialType: 'chatgpt-agent-identity',
          chatgptAccountId: bundle.accountId,
          renewable: true,
          tagId,
          status: 'active',
          priority: existing?.priority ?? 10,
          weight: existing?.weight ?? 10,
          maxConcurrency: existing?.maxConcurrency ?? 4,
          inFlight: existing?.inFlight ?? 0,
          availableModels: existing?.availableModels ?? [],
          modelsRefreshedAt: existing?.modelsRefreshedAt,
          modelPolicy: existing?.modelPolicy ?? (existing?.modelAllowlist.length ? 'selected' : 'all'),
          modelAllowlist: existing?.modelAllowlist ?? [],
          proxyId: existing?.proxyId,
          quota: existing?.quota,
          codexQuota: existing?.codexQuota,
          circuitState: 'closed',
          consecutiveFailures: 0,
          latencyMs: existing?.latencyMs,
          lastUsedAt: existing?.lastUsedAt,
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
      }
    }, ['providers', 'accounts', 'credentials'])
    this.pruneCredentialCache()
    const parsedAccessTokenWarning = chatGptAccessTokenOnlyWarning(parsed.accessTokenOnlyCount)
    const warnings = [
      ...parsed.warnings.filter((warning) => warning !== parsedAccessTokenWarning),
      ...parsedAgentIdentities.warnings
    ]
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
    await this.store.mutate((state) => {
      const pool = validateChatGptImportPoolId(poolId, state.pools)
      if (!pool) return
      const providersById = new Map(state.providers.map((provider) => [provider.id, provider]))
      for (const accountId of uniqueAccountIds) {
        const account = state.accounts.find((candidate) => candidate.id === accountId)
        if (!account || (account.credentialType !== 'chatgpt-oauth' && account.credentialType !== 'chatgpt-agent-identity')) continue
        if (providersById.get(account.providerId)?.protocol !== 'openai-responses') continue
        if (pool.members.some((member) => member.accountId === accountId)) {
          alreadyPresent += 1
          continue
        }
        pool.members.push({ accountId, enabled: true })
        added += 1
      }
      if (added > 0) pool.updatedAt = Date.now()
    }, ['pools'])
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
      if (account.credentialType !== 'chatgpt-oauth' && account.credentialType !== 'chatgpt-agent-identity') {
        throw new Error(`Account “${account.name}” is not a ChatGPT account.`)
      }
      const encrypted = state.credentials[account.credentialId]
      const serialized = encrypted ? this.decrypt(encrypted) : undefined
      const credential = serialized
        ? account.credentialType === 'chatgpt-agent-identity'
          ? deserializeChatGptAgentIdentity(serialized)
          : deserializeChatGptCredential(serialized)
        : undefined
      if (!credential) throw new Error(`Credential for “${account.name}” is unavailable.`)
      return { account, credential }
    })
    if (format === 'cpa' && selected.some(({ account }) => account.credentialType === 'chatgpt-agent-identity')) {
      throw new Error('CPA format does not support Codex Agent Identity accounts; use Sub2API export.')
    }
    const exportedAt = new Date().toISOString()
    const cpaAccounts = selected.map(({ account, credential }) => {
      if (account.credentialType === 'chatgpt-agent-identity' || !('accessToken' in credential)) {
        throw new Error('CPA format does not support Codex Agent Identity accounts; use Sub2API export.')
      }
      return ({
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
    })})
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
            credentials: account.credentialType === 'chatgpt-agent-identity' && 'agentRuntimeId' in credential
              ? {
                  auth_mode: 'agentIdentity',
                  agent_runtime_id: credential.agentRuntimeId,
                  agent_private_key: credential.agentPrivateKey,
                  task_id: credential.taskId ?? '',
                  account_id: credential.accountId,
                  chatgpt_account_id: credential.accountId,
                  chatgpt_user_id: credential.userId,
                  email: credential.email ?? '',
                  plan_type: credential.planType ?? '',
                  chatgpt_account_is_fedramp: credential.fedramp
                }
              : 'accessToken' in credential
                ? {
                    access_token: credential.accessToken,
                    refresh_token: credential.refreshToken ?? '',
                    id_token: credential.idToken ?? '',
                    account_id: credential.accountId,
                    user_id: credential.userId ?? '',
                    email: credential.email ?? ''
                  }
                : {},
            ...('expiresAt' in credential ? { expires_at: Math.floor(credential.expiresAt / 1000) } : {}),
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
    await this.store.mutate((state) => {
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
    }, ['providers', 'accounts', 'credentials', 'pools', 'routes'])
    this.pruneCredentialCache()
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
    await this.store.mutate((state) => {
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
    }, ['proxies', 'credentials'])
    this.pruneCredentialCache()
    return this.getSnapshot()
  }

  public async deleteProxy(id: string): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
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
    }, ['proxies', 'credentials'])
    this.pruneCredentialCache()
    return this.getSnapshot()
  }

  public async setProxyCheckResult(
    id: string,
    patch: Pick<ProxyDefinition, 'status' | 'lastCheckedAt'> & Partial<Pick<ProxyDefinition, 'exitIp' | 'latencyMs' | 'lastError'>>
  ): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      const proxy = state.proxies.find((candidate) => candidate.id === id)
      if (!proxy) throw new Error('Proxy not found.')
      const safePatch = patch.lastError === undefined
        ? patch
        : { ...patch, lastError: this.safePersistedMessage(state, patch.lastError) }
      Object.assign(proxy, safePatch, { updatedAt: Date.now() })
    }, ['proxies'])
    return this.getSnapshot()
  }

  public getBuiltInProxySettings(): BuiltInProxySettings {
    return this.store.select((state) => state.builtInProxySettings
      ?? createDefaultBuiltInProxySettings())
  }

  public listBuiltInProxyProfiles(): BuiltInProxyProfileSummary[] {
    return this.store.select((state) => (state.proxyProfiles ?? []).map(toBuiltInProxyProfileSummary))
  }

  public getBuiltInProxyProfile(id: string): BuiltInProxyProfileSummary | undefined {
    return this.store.select((state) => {
      const profile = (state.proxyProfiles ?? []).find((candidate) => candidate.id === id)
      return profile ? toBuiltInProxyProfileSummary(profile) : undefined
    })
  }

  /** Main-process-only access to the encrypted profile payload. */
  public getBuiltInProxyProfileSecrets(id: string): BuiltInProxyProfileSecrets | undefined {
    const encrypted = this.store.select((state) => {
      const profile = (state.proxyProfiles ?? []).find((candidate) => candidate.id === id)
      return profile?.credentialId ? state.credentials[profile.credentialId] : undefined
    })
    const decrypted = encrypted ? this.decrypt(encrypted) : undefined
    if (!decrypted) return undefined
    return parseBuiltInProxyProfileSecrets(decrypted)
  }

  /**
   * Creates or replaces one renderer-safe profile summary while keeping its
   * subscription and full normalized configuration in the existing vault.
   */
  public async saveBuiltInProxyProfile(
    input: BuiltInProxyProfileStoreInput
  ): Promise<BuiltInProxyProfileSummary> {
    const requestedId = input.id?.trim() || undefined
    if (requestedId && requestedId.length > 512) throw new Error('Built-in proxy profile id is too long.')
    const name = requiredName(input.name, 'Built-in proxy profile name')
    if (input.source !== 'subscription' && input.source !== 'import') {
      throw new Error('Unsupported built-in proxy profile source.')
    }
    const source = input.source === 'subscription' ? 'subscription' as const : 'import' as const
    if (!['sing-box-json', 'clash-meta-yaml', 'uri-list'].includes(input.format)) {
      throw new Error('Unsupported built-in proxy profile format.')
    }
    const nodes = normalizeBuiltInProxyNodes(input.nodes)
    if (nodes.length === 0) throw new Error('A built-in proxy profile must contain at least one supported node.')
    const groupCount = boundedInteger(input.groupCount, 0, 100_000, 0)
    const activeNodeId = nodes.some((node) => node.id === input.activeNodeId)
      ? input.activeNodeId
      : nodes[0].id
    const warning = normalizeBuiltInProxyWarning(input.warning)
    const lastRefreshAt = normalizeTimestamp(input.lastRefreshAt)
    const serializedSecrets = input.secrets === undefined
      ? undefined
      : serializeBuiltInProxyProfileSecrets(input.secrets, source)
    const timestamp = Date.now()
    let savedId = ''

    await this.store.mutate((state) => {
      const profiles = state.proxyProfiles ?? []
      const existing = requestedId
        ? profiles.find((profile) => profile.id === requestedId)
        : undefined
      if (!existing?.credentialId && serializedSecrets === undefined) {
        throw new Error('A built-in proxy profile requires an encrypted configuration payload.')
      }
      let credentialId = existing?.credentialId
      if (serializedSecrets !== undefined) {
        credentialId ??= createId()
        state.credentials[credentialId] = this.encrypt(serializedSecrets)
      }
      savedId = existing?.id ?? requestedId ?? createId()
      const profile: PersistedBuiltInProxyProfile = {
        id: savedId,
        name,
        source,
        format: input.format,
        nodes,
        nodeCount: nodes.length,
        groupCount,
        ruleStatus: input.ruleStatus === 'preserved' ? 'preserved' : 'fallback',
        activeNodeId,
        ...(warning ? { warning } : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(lastRefreshAt !== undefined ? { lastRefreshAt } : {}),
        credentialId
      }
      if (existing) replaceById(profiles, profile)
      else profiles.push(profile)
      state.proxyProfiles = profiles

      const settings = normalizeBuiltInProxySettings(
        state.builtInProxySettings,
        profiles,
        timestamp
      )
      if (!existing && profiles.length === 1) {
        // The first valid configuration opts into the documented defaults. It
        // does not claim activation history; takeover still waits for health.
        Object.assign(settings, {
          desiredEnabled: true,
          activeProfileId: profile.id,
          accessMode: 'system',
          ruleMode: 'rule',
          autoStart: true,
          updatedAt: timestamp
        } satisfies Partial<BuiltInProxySettings>)
      } else if (!settings.activeProfileId) {
        settings.activeProfileId = profile.id
        settings.updatedAt = timestamp
      }
      state.builtInProxySettings = settings
    }, ['proxyProfiles', 'credentials', 'builtInProxySettings'])
    this.pruneCredentialCache()

    const saved = this.getBuiltInProxyProfile(savedId)
    if (!saved) throw new Error('Built-in proxy profile could not be saved.')
    return saved
  }

  public async deleteBuiltInProxyProfile(id: string): Promise<void> {
    await this.store.mutate((state) => {
      const profiles = state.proxyProfiles ?? []
      const profile = profiles.find((candidate) => candidate.id === id)
      if (!profile) throw new Error('Built-in proxy profile not found.')
      const wasActive = state.builtInProxySettings?.activeProfileId === id
      if (profile.credentialId) delete state.credentials[profile.credentialId]
      state.proxyProfiles = profiles.filter((candidate) => candidate.id !== id)
      const settings = normalizeBuiltInProxySettings(
        state.builtInProxySettings,
        state.proxyProfiles,
        Date.now()
      )
      if (wasActive || settings.activeProfileId === id || !state.proxyProfiles.some((candidate) => (
        candidate.id === settings.activeProfileId
      ))) {
        settings.activeProfileId = state.proxyProfiles[0]?.id
        settings.updatedAt = Date.now()
      }
      state.builtInProxySettings = settings
    }, ['proxyProfiles', 'credentials', 'builtInProxySettings'])
    this.pruneCredentialCache()
  }

  public async selectBuiltInProxyProfile(id: string): Promise<BuiltInProxySettings> {
    return this.updateBuiltInProxySettings({ activeProfileId: id })
  }

  public async selectBuiltInProxyNode(
    profileId: string,
    nodeId: string
  ): Promise<BuiltInProxyProfileSummary> {
    await this.store.mutate((state) => {
      const profile = (state.proxyProfiles ?? []).find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error('Built-in proxy profile not found.')
      if (!profile.nodes.some((node) => node.id === nodeId)) {
        throw new Error('Built-in proxy node not found.')
      }
      profile.activeNodeId = nodeId
      profile.updatedAt = Date.now()
      const settings = normalizeBuiltInProxySettings(
        state.builtInProxySettings,
        state.proxyProfiles ?? [],
        Date.now()
      )
      settings.activeProfileId = profileId
      settings.updatedAt = Date.now()
      state.builtInProxySettings = settings
    }, ['proxyProfiles', 'builtInProxySettings'])
    const profile = this.getBuiltInProxyProfile(profileId)
    if (!profile) throw new Error('Built-in proxy profile not found.')
    return profile
  }

  public async updateBuiltInProxySettings(
    patch: Partial<Pick<
      BuiltInProxySettings,
      'desiredEnabled' | 'activeProfileId' | 'accessMode' | 'ruleMode' | 'customRules' | 'mixedPort' | 'lanEnabled' | 'autoStart'
    >>
  ): Promise<BuiltInProxySettings> {
    const timestamp = Date.now()
    await this.store.mutate((state) => {
      const profiles = state.proxyProfiles ?? []
      if (patch.activeProfileId !== undefined && !profiles.some((profile) => profile.id === patch.activeProfileId)) {
        throw new Error('Built-in proxy profile not found.')
      }
      if (patch.accessMode !== undefined && patch.accessMode !== 'system' && patch.accessMode !== 'tun') {
        throw new Error('Unsupported built-in proxy access mode.')
      }
      if (patch.ruleMode !== undefined && !['rule', 'global', 'direct'].includes(patch.ruleMode)) {
        throw new Error('Unsupported built-in proxy rule mode.')
      }
      const customRules = Object.prototype.hasOwnProperty.call(patch, 'customRules')
        ? normalizeBuiltInProxyCustomRules(patch.customRules, true)
        : state.builtInProxySettings?.customRules
      if (patch.mixedPort !== undefined && !isBuiltInProxyPort(patch.mixedPort)) {
        throw new Error('Built-in proxy mixed port must be zero or between 1024 and 65535.')
      }
      state.builtInProxySettings = normalizeBuiltInProxySettings({
        ...state.builtInProxySettings,
        ...patch,
        ...(customRules ? { customRules } : { customRules: undefined }),
        updatedAt: timestamp
      }, profiles, timestamp)
    }, ['builtInProxySettings'])
    return this.getBuiltInProxySettings()
  }

  public async setBuiltInProxyDesiredEnabled(enabled: boolean): Promise<BuiltInProxySettings> {
    return this.updateBuiltInProxySettings({ desiredEnabled: enabled })
  }

  public async markBuiltInProxyActivated(
    mixedPort: number,
    activatedAt = Date.now()
  ): Promise<BuiltInProxySettings> {
    if (!isBuiltInProxyPort(mixedPort) || mixedPort === 0) {
      throw new Error('Built-in proxy activation requires a concrete mixed port.')
    }
    const timestamp = normalizeTimestamp(activatedAt) ?? Date.now()
    await this.store.mutate((state) => {
      const profiles = state.proxyProfiles ?? []
      const settings = normalizeBuiltInProxySettings(state.builtInProxySettings, profiles, timestamp)
      state.builtInProxySettings = {
        ...settings,
        mixedPort,
        hasEverActivated: true,
        lastActivatedAt: timestamp,
        updatedAt: timestamp
      }
    }, ['builtInProxySettings'])
    return this.getBuiltInProxySettings()
  }

  public async setBuiltInProxyNodeLatency(
    profileId: string,
    nodeId: string,
    patch: Pick<BuiltInProxyNodeSummary, 'latencyStatus'>
      & Partial<Pick<BuiltInProxyNodeSummary, 'latencyMs' | 'lastTestedAt'>>
  ): Promise<BuiltInProxyNodeSummary> {
    let result: BuiltInProxyNodeSummary | undefined
    await this.store.mutate((state) => {
      const profile = (state.proxyProfiles ?? []).find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error('Built-in proxy profile not found.')
      const node = profile.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) throw new Error('Built-in proxy node not found.')
      const [normalized] = normalizeBuiltInProxyNodes([{
        ...node,
        latencyStatus: patch.latencyStatus,
        latencyMs: patch.latencyMs,
        lastTestedAt: patch.lastTestedAt
      }])
      Object.assign(node, normalized)
      profile.updatedAt = Date.now()
      result = { ...normalized, groupIds: [...normalized.groupIds] }
    }, ['proxyProfiles'])
    if (!result) throw new Error('Built-in proxy node not found.')
    return result
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
    await this.store.mutate((state) => {
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
    }, ['clientProfiles'])
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
    await this.store.mutate((state) => {
      const profile = state.clientProfiles.find((candidate) => candidate.id === id)
      if (profile?.isDefault) throw new Error('Default client profiles cannot be deleted.')
      state.clientProfiles = state.clientProfiles.filter((candidate) => candidate.id !== id)
    }, ['clientProfiles'])
    return this.getSnapshot()
  }

  public async savePool(input: PoolInput): Promise<AppSnapshot> {
    const name = requiredName(input.name, 'Pool name')
    const timestamp = Date.now()
    await this.store.mutate((state) => {
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
        quotaProtection: input.quotaProtection === undefined
          ? existing?.quotaProtection
          : normalizeQuotaProtection(input.quotaProtection),
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
    }, ['pools'])
    return this.getSnapshot()
  }

  public async deletePool(id: string): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      if (state.routes.some((route) => route.poolId === id)) {
        throw new Error('Switch or unassign the routes that use this pool before deleting it.')
      }
      state.pools = state.pools.filter((pool) => pool.id !== id)
    }, ['pools'])
    return this.getSnapshot()
  }

  public async setRouteSourceFastMode(input: RouteSourceFastModeInput): Promise<AppSnapshot> {
    await this.store.mutate((state) => {
      setRouteSourceFastModeDraft(state, input)
    }, ['pools', 'providers', 'accounts'])
    return this.getSnapshot()
  }

  public async updateRoute(route: Route): Promise<AppSnapshot> {
    const timestamp = Date.now()
    await this.store.mutate((state) => {
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
      const existing = state.routes.find((candidate) => candidate.id === route.id)
      const cleanRoute: Route = {
        ...route,
        // The field was introduced after Route's public IPC shape. Callers
        // compiled against the older shape may omit it while updating another
        // setting; omission must preserve the saved mode, while explicit false
        // remains the opt-out operation.
        highConcurrencyMode: route.highConcurrencyMode === undefined
          ? existing?.highConcurrencyMode === true
          : route.highConcurrencyMode === true,
        localToken: route.localToken.trim() || createLocalToken(),
        modelMap: normalizeModelMap(route.modelMap),
        createdAt: route.createdAt || timestamp,
        updatedAt: timestamp
      }
      if (existing) {
        replaceById(state.routes, cleanRoute)
      } else {
        state.routes.push({ ...cleanRoute, id: cleanRoute.id || createId() })
      }
    }, ['routes'])
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
    await this.store.mutate((state) => {
      const route = state.routes.find((candidate) => candidate.client === client)
      if (!route) throw new Error(`The ${client} client route does not exist.`)
      replaceById(state.routes, {
        ...route,
        poolId: cleanSourceId,
        updatedAt: Date.now()
      })
    }, ['routes'])
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
      await this.store.mutate((state) => {
        const recordedPoolIds = new Set<string>()
        for (const rollback of wizard.routingRollbacks ?? []) {
          for (const poolId of rollback.createdPoolIds) recordedPoolIds.add(poolId)
          const route = state.routes.find((candidate) => candidate.id === rollback.routeId)
          if (!route || route.updatedAt !== rollback.expectedUpdatedAt) continue
          if (rollback.routeCreated) {
            state.routes = state.routes.filter((candidate) => candidate.id !== route.id)
          } else if (rollback.previous) {
            Object.assign(route, rollback.previous, { updatedAt: timestamp })
          }
        }
        if (!wizard.routingRollbacks?.length) {
          const route = wizard.routeId ? state.routes.find((candidate) => candidate.id === wizard.routeId) : undefined
          if (route && route.createdAt >= wizard.createdAt && route.poolId === wizard.poolId) {
            state.routes = state.routes.filter((candidate) => candidate.id !== route.id)
          }
          const legacyPool = wizard.poolId ? state.pools.find((candidate) => candidate.id === wizard.poolId) : undefined
          if (legacyPool?.name.startsWith('向导·') && legacyPool.createdAt >= wizard.createdAt) recordedPoolIds.add(legacyPool.id)
        }
        state.pools = state.pools.filter((pool) => !recordedPoolIds.has(pool.id)
          || state.routes.some((route) => route.poolId === pool.id))
      }, ['routes', 'pools'])
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
    const previousRoute = this.store.select((state) => {
      const route = state.routes.find((candidate) => candidate.client === input.client)
      return route ? {
        id: route.id,
        poolId: route.poolId,
        enabled: route.enabled,
        highConcurrencyMode: route.highConcurrencyMode === true,
        inboundProtocol: route.inboundProtocol,
        modelMap: { ...route.modelMap },
      } : undefined
    })
    let result: Omit<SetupRoutingResult, 'snapshot'> | undefined
    await this.store.mutate((state) => {
      result = applySetupRoutingDraft(state, input, { preferredPoolId: wizard.poolId })
    }, ['pools', 'routes'])
    if (!result) throw new Error('无法应用向导路由。')
    const appliedRoute = this.store.select((state) => state.routes.find((candidate) => candidate.id === result?.routeId))
    if (!appliedRoute) throw new Error('无法记录向导路由回滚边界。')
    await this.setupWizard.recordRoutingMutation(input.sessionId, {
      routeId: appliedRoute.id,
      routeCreated: !previousRoute,
      expectedUpdatedAt: appliedRoute.updatedAt,
      createdPoolId: result.createdPool ? result.poolId : undefined,
      previous: previousRoute ? {
        poolId: previousRoute.poolId,
        enabled: previousRoute.enabled,
        highConcurrencyMode: previousRoute.highConcurrencyMode,
        inboundProtocol: previousRoute.inboundProtocol,
        modelMap: previousRoute.modelMap,
      } : undefined,
    })
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
    await this.store.mutate((state) => {
      state.gateway = normalized
    }, ['gateway'])
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

  /**
   * Apply a probe result only while its caller still owns the account probe.
   * The predicate is evaluated inside the queued store mutation, immediately
   * before the account is changed, closing the gap between an IPC-side owner
   * check and the eventual durable write.
   */
  public async setAccountCheckResultIf(
    id: string,
    patch: AccountCheckPatch,
    isCurrent: () => boolean,
  ): Promise<{ applied: boolean; snapshot: AppSnapshot }> {
    const safePatch = patch.lastError === undefined
      ? patch
      : { ...patch, lastError: this.safeCurrentPersistedMessage(patch.lastError) }
    let applied = false
    await this.store.updateAccounts<Account>([id], (account) => {
      if (!isCurrent()) return
      applied = true
      const mergedQuota = safePatch.quota ? mergeAccountQuota(account.quota, safePatch.quota) : undefined
      const mergedCodexQuota = safePatch.codexQuota
        ? mergeAccountCodexQuota(account.codexQuota, safePatch.codexQuota)
        : undefined
      Object.assign(account, safePatch, {
        ...(mergedQuota ? { quota: mergedQuota } : {}),
        ...(mergedCodexQuota ? { codexQuota: mergedCodexQuota } : {}),
        updatedAt: Date.now()
      })
    }, (account) => applied && safePatch.codexQuota && account.codexQuota
      ? codexQuotaSample(id, account.codexQuota)
      : undefined)
    return { applied, snapshot: this.getSnapshot() }
  }

  public async updateAccountRuntimeState(id: string, patch: AccountCheckPatch): Promise<void> {
    await this.updateAccountRuntimeStates([{ id, patch }])
  }

  public async updateAccountRuntimeStates(
    updates: readonly { id: string; patch: AccountCheckPatch }[]
  ): Promise<void> {
    const patches = new Map(updates.map(({ id, patch }) => [id, patch.lastError === undefined
      ? patch
      : { ...patch, lastError: this.safeCurrentPersistedMessage(patch.lastError) }]))
    if (patches.size === 0) return
    await this.store.updateAccounts<Account>([...patches.keys()], (account, id) => {
      const patch = patches.get(id)
      if (!patch) return
      const mergedQuota = patch.quota ? mergeAccountQuota(account.quota, patch.quota) : undefined
      const mergedCodexQuota = patch.codexQuota
        ? mergeAccountCodexQuota(account.codexQuota, patch.codexQuota)
        : undefined
      Object.assign(account, patch, {
        ...(mergedQuota ? { quota: mergedQuota } : {}),
        ...(mergedCodexQuota ? { codexQuota: mergedCodexQuota } : {}),
        updatedAt: Date.now()
      })
    }, (account, id) => {
      const patch = patches.get(id)
      return patch?.codexQuota && account.codexQuota
        ? codexQuotaSample(id, account.codexQuota)
        : undefined
    })
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

  public async appendLog(log: RequestLog): Promise<RequestLog | undefined> {
    const safeLog = log.error === undefined
      ? { ...log }
      : { ...log, error: this.safeCurrentPersistedMessage(log.error) }
    // A clear operation advances the visible request-log generation. Old rows
    // must stay cleared, but an active request that finishes afterwards still
    // belongs in the monotonic lifetime token ledger.
    if (this.clearedRequestLogIds.has(safeLog.id)) {
      while (this.clearedRequestLogIds.has(safeLog.id) && this.requestLogClearBarrier) {
        await this.requestLogClearBarrier
      }
      // A failed clear restores the previous generation. Continue through the
      // normal append path instead of dropping the callback that waited on it.
      if (this.clearedRequestLogIds.has(safeLog.id)) {
        if (
          safeLog.status === 'streaming'
          || !this.clearedLiveRequestLogBaselines.has(safeLog.id)
          || this.terminalRequestLogIds.has(safeLog.id)
        ) return undefined
        const existingWrite = this.clearedLifetimeTokenWrites.get(safeLog.id)
        if (existingWrite) {
          await existingWrite
          return undefined
        }
        const baseline = this.clearedLiveRequestLogBaselines.get(safeLog.id) ?? undefined
        this.terminalizingRequestLogIds.add(safeLog.id)
        const write = this.store.replaceLifetimeRequestLogContribution(safeLog, baseline)
        this.clearedLifetimeTokenWrites.set(safeLog.id, write)
        try {
          await write
        } catch (error) {
          this.terminalizingRequestLogIds.delete(safeLog.id)
          throw error
        } finally {
          this.clearedLifetimeTokenWrites.delete(safeLog.id)
        }
        this.clearedLiveRequestLogBaselines.delete(safeLog.id)
        this.terminalizingRequestLogIds.delete(safeLog.id)
        this.terminalRequestLogIds.add(safeLog.id)
        this.trimTerminalRequestLogIds()
        this.requestLogRevision += 1
        return undefined
      }
    }
    if (safeLog.status === 'streaming') {
      // A terminal write may be retrying after a transient SQLite failure. Do
      // not allow a late progress callback to replace that lifecycle outcome.
      if (this.terminalizingRequestLogIds.has(safeLog.id) || this.terminalRequestLogIds.has(safeLog.id)) return undefined
      const current = this.liveRequestLogs.get(safeLog.id)
      const entry = { log: safeLog, version: ++this.liveRequestLogVersion }
      this.liveRequestLogs.set(safeLog.id, entry)
      this.uncheckpointedLiveRequestLogIds.add(safeLog.id)
      if (!current) {
        this.liveRequestLogOrder.push(safeLog.id)
        this.trimLiveRequestLogs()
      }
      return safeLog
    }

    this.terminalizingRequestLogIds.add(safeLog.id)
    // The IPC owner retries terminal durability. If this rejects, deliberately
    // retain the guard so delayed progress cannot resurrect the lifecycle.
    await this.store.appendRequestLog(safeLog, MAX_PERSISTED_REQUEST_LOGS)
    this.removeLiveRequestLog(safeLog.id)
    this.terminalizingRequestLogIds.delete(safeLog.id)
    this.terminalRequestLogIds.add(safeLog.id)
    this.trimTerminalRequestLogIds()
    this.requestLogRevision += 1
    return safeLog
  }

  public hasLiveRequestLogs(): boolean {
    return this.liveRequestLogs.size > 0
  }

  public hasUncheckpointedLiveRequestLogs(): boolean {
    return this.uncheckpointedLiveRequestLogIds.size > 0
  }

  /**
   * Periodic crash-recovery checkpoint for long requests. Gateway IPC invokes
   * this on a low-frequency timer; ordinary progress events remain memory-only.
   */
  public async checkpointLiveRequestLogs(
    options: { force?: boolean; includeTerminalizing?: boolean } = {}
  ): Promise<number> {
    const ids = options.force
      ? [...this.liveRequestLogs.keys()]
      : [...this.uncheckpointedLiveRequestLogIds]
    const checkpoints = ids
      .filter((id) => options.includeTerminalizing || !this.terminalizingRequestLogIds.has(id))
      .map((id) => {
        const entry = this.liveRequestLogs.get(id)
        return entry ? { id, version: entry.version, log: entry.log } : undefined
      })
      .filter((entry): entry is { id: string; version: number; log: RequestLog } => Boolean(entry))
    if (checkpoints.length === 0) return 0
    await Promise.all(checkpoints.map(({ log }) => (
      this.store.appendRequestLog(log, MAX_PERSISTED_REQUEST_LOGS)
    )))
    for (const checkpoint of checkpoints) {
      const current = this.liveRequestLogs.get(checkpoint.id)
      if (current?.version === checkpoint.version) {
        this.uncheckpointedLiveRequestLogIds.delete(checkpoint.id)
      }
    }
    return checkpoints.length
  }

  private trimLiveRequestLogs(): void {
    while (this.liveRequestLogOrder.length > MAX_LIVE_REQUEST_LOGS) {
      // Keep older active lifecycles in the Map for crash recovery and
      // terminal reconciliation; only the renderer order is bounded here.
      this.liveRequestLogOrder.shift()
    }
  }

  private removeLiveRequestLog(id: string): void {
    this.liveRequestLogs.delete(id)
    this.uncheckpointedLiveRequestLogIds.delete(id)
    const orderIndex = this.liveRequestLogOrder.indexOf(id)
    if (orderIndex >= 0) this.liveRequestLogOrder.splice(orderIndex, 1)
  }

  private trimTerminalRequestLogIds(): void {
    while (this.terminalRequestLogIds.size > MAX_PERSISTED_REQUEST_LOGS) {
      const oldest = this.terminalRequestLogIds.values().next().value
      if (typeof oldest !== 'string') break
      this.terminalRequestLogIds.delete(oldest)
    }
  }

  public async finalizeOrphanedStreamingLogs(now = Date.now()): Promise<RequestLog[]> {
    const orphaned = new Map(
      this.store.select((state) => state.requestLogs
        .filter((log) => log.status === 'streaming')
        .map((log) => [log.id, log] as const))
    )
    for (const { log } of this.liveRequestLogs.values()) {
      orphaned.set(log.id, log)
    }
    if (orphaned.size === 0) return []

    const terminalLogs = [...orphaned.values()].map((log): RequestLog => ({
      ...log,
      timestamp: now,
      status: 'error',
      statusCode: 499,
      progressStage: undefined,
      failureStage: 'client',
      latencyMs: Math.max(0, now - (log.startedAt ?? log.timestamp)),
      error: 'Gateway request ended without a final log'
    }))
    for (const log of terminalLogs) this.terminalizingRequestLogIds.add(log.id)
    try {
      await Promise.all(terminalLogs.map((log) => (
        this.store.appendRequestLog(log, MAX_PERSISTED_REQUEST_LOGS)
      )))
    } catch (error) {
      // A transient repository failure must not strand the lifecycle guard;
      // reconciliation can safely retry the same terminal rows later.
      for (const log of terminalLogs) this.terminalizingRequestLogIds.delete(log.id)
      throw error
    }
    for (const log of terminalLogs) {
      this.removeLiveRequestLog(log.id)
      this.terminalizingRequestLogIds.delete(log.id)
      this.terminalRequestLogIds.add(log.id)
    }
    while (this.terminalRequestLogIds.size > MAX_PERSISTED_REQUEST_LOGS) {
      const oldest = this.terminalRequestLogIds.values().next().value
      if (typeof oldest !== 'string') break
      this.terminalRequestLogIds.delete(oldest)
    }
    this.requestLogRevision += 1
    return terminalLogs.map((log) => ({ ...log }))
  }

  public async refreshRequestConversationTitles(resolve: (conversationId: string) => string | undefined): Promise<void> {
    for (const [id, entry] of this.liveRequestLogs) {
      const log = entry.log
      if (!log.conversationId || (log.conversationName && !log.conversationName.startsWith('对话 '))) continue
      const conversationName = resolve(log.conversationId)
      if (conversationName && conversationName !== log.conversationName) {
        this.liveRequestLogs.set(id, {
          log: { ...log, conversationName },
          version: ++this.liveRequestLogVersion
        })
        this.uncheckpointedLiveRequestLogIds.add(id)
      }
    }
    await this.store.updateRequestLogs<RequestLog>((log) => {
      if (!log.conversationId || (log.conversationName && !log.conversationName.startsWith('对话 '))) return undefined
      const conversationName = resolve(log.conversationId)
      return conversationName && conversationName !== log.conversationName
        ? { ...log, conversationName }
        : undefined
    })
  }

  public async clearLogs(additionalRequestLogIds: readonly string[] = []): Promise<AppSnapshot> {
    while (this.requestLogClearBarrier) await this.requestLogClearBarrier
    const liveIds = new Set(this.liveRequestLogs.keys())
    const clearedIds = this.store.select((state) => state.requestLogs.map((log) => log.id))
    let releaseClear!: () => void
    const clearBarrier = new Promise<void>((resolve) => { releaseClear = resolve })
    this.requestLogClearBarrier = clearBarrier
    const previousClearedIds = [...this.clearedRequestLogIds]
    const previousClearedBaselines = new Map(this.clearedLiveRequestLogBaselines)
    // Persisted history is newest-first. Insert oldest-first so bounded
    // tombstone eviction retains the recent IDs most likely to receive a late
    // title or terminal callback.
    this.rememberClearedRequestLogIds(clearedIds.reverse())
    this.rememberClearedRequestLogIds(liveIds)
    this.rememberClearedRequestLogIds(additionalRequestLogIds)
    const clearedGenerationIds = new Set([
      ...clearedIds,
      ...liveIds,
      ...additionalRequestLogIds
    ])
    try {
      const liveBaselines = await this.store.clearRequestLogs<RequestLog>(liveIds)
      const persistedLiveBaselines = new Map(liveBaselines.map((log) => [log.id, log] as const))
      for (const id of liveIds) {
        if (this.clearedRequestLogIds.has(id)) {
          this.clearedLiveRequestLogBaselines.set(id, persistedLiveBaselines.get(id) ?? null)
        }
      }
      // Requests created after the clear boundary are a newer generation and
      // may have entered memory while SQLite was deleting the old rows. Remove
      // only IDs captured above; a global clear would lose those new requests.
      for (const id of liveIds) this.removeLiveRequestLog(id)
      for (const id of clearedGenerationIds) {
        this.terminalizingRequestLogIds.delete(id)
        this.terminalRequestLogIds.delete(id)
      }
      this.requestLogRevision += 1
      return this.getSnapshot()
    } catch (error) {
      this.clearedRequestLogIds.clear()
      for (const id of previousClearedIds) this.clearedRequestLogIds.add(id)
      this.clearedLiveRequestLogBaselines.clear()
      for (const [id, baseline] of previousClearedBaselines) {
        this.clearedLiveRequestLogBaselines.set(id, baseline)
      }
      throw error
    } finally {
      releaseClear()
      if (this.requestLogClearBarrier === clearBarrier) this.requestLogClearBarrier = undefined
    }
  }

  private rememberClearedRequestLogIds(ids: Iterable<string>): void {
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue
      this.clearedRequestLogIds.delete(id)
      this.clearedRequestLogIds.add(id)
    }
    while (this.clearedRequestLogIds.size > MAX_CLEARED_REQUEST_LOG_TOMBSTONES) {
      const oldest = this.clearedRequestLogIds.values().next().value
      if (typeof oldest !== 'string') break
      this.clearedRequestLogIds.delete(oldest)
      this.clearedLiveRequestLogBaselines.delete(oldest)
    }
  }

  public async clearHealthEvents(): Promise<AppSnapshot> {
    await this.store.clearHealthEvents()
    return this.getSnapshot()
  }

  public async appendHealthEvent(event: HealthEvent): Promise<AppSnapshot> {
    await this.persistHealthEvent(event)
    return this.getSnapshot()
  }

  /** Durable-only health telemetry path; avoids constructing an AppSnapshot. */
  public async persistHealthEvent(event: HealthEvent): Promise<HealthEvent> {
    const safeEvent = {
      ...event,
      message: this.safeCurrentPersistedMessage(event.message) ?? ''
    }
    await this.store.appendHealthEvent(safeEvent, 2_000)
    return safeEvent
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

  private pruneCredentialCache(): void {
    if (this.decryptedCredentialCache.size === 0) return
    const retained = new Set(this.store.select((state) => Object.values(state.credentials)))
    for (const encrypted of this.decryptedCredentialCache.keys()) {
      if (!retained.has(encrypted)) this.decryptedCredentialCache.delete(encrypted)
    }
  }

  private sensitiveCredentialValues(
    state: Pick<PersistedState, 'accounts' | 'credentials' | 'proxies' | 'routes'>
  ): string[] {
    const values = new Set<string>()
    for (const account of state.accounts) {
      if (account.chatgptAccountId) values.add(account.chatgptAccountId)
      const encrypted = state.credentials[account.credentialId]
      if (!encrypted) continue
      const decrypted = this.decrypt(encrypted)
      for (const sensitive of decrypted
        ? account.credentialType === 'chatgpt-agent-identity'
          ? agentIdentitySensitiveValues(decrypted)
          : credentialSensitiveValues(decrypted, account.credentialType === 'chatgpt-oauth')
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

  private safeCurrentPersistedMessage(value: string | undefined): string | undefined {
    if (!this.vaultAvailable) return sanitizePersistedMessage(value, undefined)
    const sensitiveState = this.store.select((state) => ({
      accounts: state.accounts,
      credentials: state.credentials,
      proxies: state.proxies,
      routes: state.routes
    }))
    return sanitizePersistedMessage(
      value,
      this.sensitiveCredentialValues(sensitiveState)
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
    await this.store.mutate((state) => {
      state.accounts = accounts
      state.proxies = proxies
      state.requestLogs = requestLogs
      state.healthEvents = healthEvents
    }, ['accounts', 'proxies', 'requestLogs', 'healthEvents'])
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
    const account = this.store.selectAccount<Account>(accountId)
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

  public async updateChatGptAgentIdentityCredential(
    accountId: string,
    serialized: string,
    expectedSourceSerialized?: string
  ): Promise<void> {
    const bundle = deserializeChatGptAgentIdentity(serialized)
    if (!bundle) throw new Error('Updated Agent Identity credential is invalid.')
    const account = this.store.selectAccount<Account>(accountId)
    if (!account || account.credentialType !== 'chatgpt-agent-identity') {
      throw new Error('Agent Identity account not found.')
    }
    const previousEncrypted = this.store.select((state) => state.credentials[account.credentialId])
    if (expectedSourceSerialized !== undefined && (
      previousEncrypted === undefined || this.decrypt(previousEncrypted) !== expectedSourceSerialized
    )) throw new Error('Account credential changed while its Agent Identity task was being registered.')
    const encrypted = this.encrypt(serialized)
    await this.store.updateAccountCredential<Account>(accountId, account.credentialId, encrypted, (candidate) => {
      if (candidate.credentialType !== 'chatgpt-agent-identity') throw new Error('Agent Identity account not found.')
      candidate.chatgptAccountId = bundle.accountId
      candidate.renewable = true
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

}

function codexQuotaSample(
  accountId: string,
  quota: AccountCodexQuotaSnapshot
): CodexQuotaHistoryPoint | undefined {
  if (!quota.fiveHour && !quota.sevenDay) return undefined
  return {
    accountId,
    observedAt: quota.observedAt,
    fiveHourUsedPercent: quota.fiveHour?.usedPercent,
    fiveHourResetAt: quota.fiveHour?.resetAt,
    sevenDayUsedPercent: quota.sevenDay?.usedPercent,
    sevenDayResetAt: quota.sevenDay?.resetAt,
    source: quota.source
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
    builtInProxySettings: createDefaultBuiltInProxySettings(timestamp),
    proxyProfiles: [],
    pools: [],
    routes: [
      {
        id: 'route-claude',
        client: 'claude',
        enabled: false,
        highConcurrencyMode: false,
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
        highConcurrencyMode: false,
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
        highConcurrencyMode: false,
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

function createDefaultBuiltInProxySettings(timestamp = Date.now()): BuiltInProxySettings {
  return { ...DEFAULT_BUILT_IN_PROXY_SETTINGS, updatedAt: timestamp }
}

function normalizeBuiltInProxySettings(
  value: Partial<BuiltInProxySettings> | undefined,
  profiles: readonly PersistedBuiltInProxyProfile[],
  timestamp: number
): BuiltInProxySettings {
  const candidate = (value ?? {}) as Partial<BuiltInProxySettings>
  const lastActivatedAt = normalizeTimestamp(candidate.lastActivatedAt)
  const hasEverActivated = candidate.hasEverActivated === true || lastActivatedAt !== undefined
  const activeProfileId = typeof candidate.activeProfileId === 'string'
    && profiles.some((profile) => profile.id === candidate.activeProfileId)
    ? candidate.activeProfileId
    : profiles[0]?.id
  const customRules = normalizeBuiltInProxyCustomRules(candidate.customRules)
  return {
    desiredEnabled: candidate.desiredEnabled === true,
    ...(activeProfileId ? { activeProfileId } : {}),
    accessMode: candidate.accessMode === 'tun' ? 'tun' : 'system',
    ruleMode: candidate.ruleMode === 'global' || candidate.ruleMode === 'direct'
      ? candidate.ruleMode
      : 'rule',
    ...(customRules ? { customRules } : {}),
    mixedPort: isBuiltInProxyPort(candidate.mixedPort) ? candidate.mixedPort : 0,
    lanEnabled: candidate.lanEnabled === true,
    autoStart: candidate.autoStart !== false,
    hasEverActivated,
    ...(hasEverActivated && lastActivatedAt !== undefined ? { lastActivatedAt } : {}),
    updatedAt: normalizeTimestamp(candidate.updatedAt) ?? timestamp
  }
}

const BUILT_IN_PROXY_RULE_CONDITIONS = new Set([
  'domain', 'domain-suffix', 'domain-keyword', 'ip-cidr', 'port', 'port-range',
  'network', 'protocol', 'private-network', 'mainland-china'
])
const MAX_BUILT_IN_PROXY_EDITABLE_RULES = 500
const MAX_BUILT_IN_PROXY_RULE_VALUES = 128
const MAX_BUILT_IN_PROXY_RULE_TOTAL_VALUES = 5_000

function normalizeBuiltInProxyCustomRules(
  value: unknown,
  strict = false
): BuiltInProxyCustomRuleSet | undefined {
  if (value === undefined) return undefined
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Custom proxy rules must be an object.')
    const raw = value as Record<string, unknown>
    if (Object.keys(raw).some((key) => key !== 'rules' && key !== 'finalAction')) {
      throw new Error('Custom proxy rules contain unsupported fields.')
    }
    if (!Array.isArray(raw.rules) || raw.rules.length > MAX_BUILT_IN_PROXY_EDITABLE_RULES) {
      throw new Error(`Custom proxy rules must contain at most ${MAX_BUILT_IN_PROXY_EDITABLE_RULES} rules.`)
    }
    if (raw.finalAction !== 'proxy' && raw.finalAction !== 'direct') {
      throw new Error('Custom proxy rules require a direct or proxy final action.')
    }
    const totalValues = raw.rules.reduce((total, candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return total
      const values = (candidate as Record<string, unknown>).values
      return total + (Array.isArray(values) ? values.length : 0)
    }, 0)
    if (totalValues > MAX_BUILT_IN_PROXY_RULE_TOTAL_VALUES) {
      throw new Error(`Custom proxy rules must contain at most ${MAX_BUILT_IN_PROXY_RULE_TOTAL_VALUES} values.`)
    }
    const ids = new Set<string>()
    const rules = raw.rules.map((candidate, index) => {
      const rule = normalizeBuiltInProxyEditableRule(candidate, index)
      if (ids.has(rule.id)) throw new Error('Custom proxy rule ids must be unique.')
      ids.add(rule.id)
      return rule
    })
    return { rules, finalAction: raw.finalAction }
  } catch (error) {
    if (strict) throw error
    return undefined
  }
}

function normalizeBuiltInProxyEditableRule(value: unknown, index: number): BuiltInProxyEditableRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Custom proxy rule ${index + 1} is invalid.`)
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['id', 'condition', 'values', 'action'].includes(key))) {
    throw new Error(`Custom proxy rule ${index + 1} contains unsupported fields.`)
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(`Custom proxy rule ${index + 1} has an invalid id.`)
  }
  const condition = typeof raw.condition === 'string' ? raw.condition : ''
  if (!BUILT_IN_PROXY_RULE_CONDITIONS.has(condition)) {
    throw new Error(`Custom proxy rule ${index + 1} has an unsupported condition.`)
  }
  if (raw.action !== 'proxy' && raw.action !== 'direct' && raw.action !== 'block') {
    throw new Error(`Custom proxy rule ${index + 1} has an unsupported action.`)
  }
  if (!Array.isArray(raw.values) || raw.values.length > MAX_BUILT_IN_PROXY_RULE_VALUES) {
    throw new Error(`Custom proxy rule ${index + 1} has invalid values.`)
  }
  const typedCondition = condition as BuiltInProxyEditableRule['condition']
  const fixedCondition = typedCondition === 'private-network' || typedCondition === 'mainland-china'
  if (fixedCondition && raw.values.length !== 0) {
    throw new Error(`Custom proxy rule ${index + 1} does not accept values.`)
  }
  if (!fixedCondition && raw.values.length === 0) {
    throw new Error(`Custom proxy rule ${index + 1} requires at least one value.`)
  }
  const values = raw.values.map((entry) => normalizeBuiltInProxyRuleValue(entry, typedCondition, index))
  if (new Set(values).size !== values.length) {
    throw new Error(`Custom proxy rule ${index + 1} contains duplicate values.`)
  }
  return { id, condition: typedCondition, values, action: raw.action }
}

function normalizeBuiltInProxyRuleValue(
  value: unknown,
  condition: BuiltInProxyEditableRule['condition'],
  index: number
): string {
  if (typeof value !== 'string') throw new Error(`Custom proxy rule ${index + 1} contains a non-text value.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 253 || hasAsciiControlCharacter(trimmed)) {
    throw new Error(`Custom proxy rule ${index + 1} contains an invalid value.`)
  }
  if (condition === 'domain' || condition === 'domain-suffix') {
    const domain = trimmed.toLowerCase().replace(condition === 'domain-suffix' ? /^\./ : /$^/, '')
    if (isIP(domain) || !/^(?=.{1,253}$)(?:[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?\.)*[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?$/i.test(domain)) {
      throw new Error(`Custom proxy rule ${index + 1} contains an invalid domain.`)
    }
    return domain
  }
  if (condition === 'domain-keyword') {
    if (trimmed.length > 128) throw new Error(`Custom proxy rule ${index + 1} contains an invalid keyword.`)
    return trimmed
  }
  if (condition === 'ip-cidr') {
    const [address, prefix, extra] = trimmed.split('/')
    const version = isIP(address)
    const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix)
    if (!version || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
      throw new Error(`Custom proxy rule ${index + 1} contains an invalid CIDR.`)
    }
    return `${address}/${bits}`
  }
  if (condition === 'port') {
    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Custom proxy rule ${index + 1} contains an invalid port.`)
    return String(port)
  }
  if (condition === 'port-range') {
    const match = /^(\d+):(\d+)$/.exec(trimmed)
    const start = Number(match?.[1]); const end = Number(match?.[2])
    if (!match || !Number.isInteger(start) || start < 1 || end > 65535 || start > end) {
      throw new Error(`Custom proxy rule ${index + 1} contains an invalid port range.`)
    }
    return `${start}:${end}`
  }
  if (condition === 'network') {
    const network = trimmed.toLowerCase()
    if (network !== 'tcp' && network !== 'udp') throw new Error(`Custom proxy rule ${index + 1} contains an invalid network.`)
    return network
  }
  if (condition === 'protocol') {
    const protocol = trimmed.toLowerCase()
    if (!/^[a-z0-9_-]{1,32}$/.test(protocol)) throw new Error(`Custom proxy rule ${index + 1} contains an invalid protocol.`)
    return protocol
  }
  throw new Error(`Custom proxy rule ${index + 1} does not accept values.`)
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function normalizePersistedBuiltInProxyProfiles(
  value: PersistedBuiltInProxyProfile[] | undefined,
  credentials: Readonly<Record<string, string>>,
  timestamp: number
): PersistedBuiltInProxyProfile[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const result: PersistedBuiltInProxyProfile[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const id = normalizeBuiltInProxyIdentifier(candidate.id)
    if (!id || ids.has(id)) continue
    ids.add(id)
    const nodes = normalizeBuiltInProxyNodes(candidate.nodes)
    const activeNodeId = nodes.some((node) => node.id === candidate.activeNodeId)
      ? candidate.activeNodeId
      : nodes[0]?.id
    const credentialId = typeof candidate.credentialId === 'string'
      && candidate.credentialId.length <= 512
      && credentials[candidate.credentialId]
      ? candidate.credentialId
      : undefined
    const warning = normalizeBuiltInProxyWarning(candidate.warning)
    const lastRefreshAt = normalizeTimestamp(candidate.lastRefreshAt)
    result.push({
      id,
      name: normalizeBuiltInProxyDisplayText(candidate.name, 'Imported profile', 256),
      source: candidate.source === 'subscription' ? 'subscription' : 'import',
      format: candidate.format === 'clash-meta-yaml' || candidate.format === 'uri-list'
        ? candidate.format
        : 'sing-box-json',
      nodes,
      nodeCount: nodes.length,
      groupCount: boundedInteger(candidate.groupCount, 0, 100_000, 0),
      ruleStatus: candidate.ruleStatus === 'preserved' ? 'preserved' : 'fallback',
      ...(activeNodeId ? { activeNodeId } : {}),
      ...(warning ? { warning } : {}),
      createdAt: normalizeTimestamp(candidate.createdAt) ?? timestamp,
      updatedAt: normalizeTimestamp(candidate.updatedAt) ?? timestamp,
      ...(lastRefreshAt !== undefined ? { lastRefreshAt } : {}),
      ...(credentialId ? { credentialId } : {})
    })
  }
  return result
}

function normalizeBuiltInProxyNodes(value: unknown): BuiltInProxyNodeSummary[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const nodes: BuiltInProxyNodeSummary[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as Partial<BuiltInProxyNodeSummary>
    const id = normalizeBuiltInProxyIdentifier(raw.id)
    if (!id || ids.has(id)) continue
    ids.add(id)
    const latencyMs = typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs) && raw.latencyMs >= 0
      ? Math.floor(raw.latencyMs)
      : undefined
    const lastTestedAt = normalizeTimestamp(raw.lastTestedAt)
    const latencyStatus = raw.latencyStatus === 'testing'
      || raw.latencyStatus === 'available'
      || raw.latencyStatus === 'timeout'
      || raw.latencyStatus === 'error'
      ? raw.latencyStatus
      : 'untested'
    const groupIds = Array.isArray(raw.groupIds)
      ? [...new Set(raw.groupIds
          .map(normalizeBuiltInProxyIdentifier)
          .filter((groupId): groupId is string => Boolean(groupId)))]
      : []
    nodes.push({
      id,
      name: normalizeBuiltInProxyDisplayText(raw.name, 'Unnamed node', 256),
      type: normalizeBuiltInProxyDisplayText(raw.type, 'unknown', 64),
      groupIds: groupIds.slice(0, 10_000),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      latencyStatus,
      ...(lastTestedAt !== undefined ? { lastTestedAt } : {})
    })
  }
  return nodes.slice(0, 100_000)
}

function normalizeBuiltInProxyIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= 512 ? normalized : undefined
}

function normalizeBuiltInProxyDisplayText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== 'string') return fallback
  const normalized = stripControlCharacters(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, '[REDACTED]@')
    .replace(/([?&](?:token|password|secret|credential|authorization)=)[^\s&#]+/gi, '$1[REDACTED]')
    .trim()
    .slice(0, maximum)
  return normalized || fallback
}

function normalizeBuiltInProxyWarning(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = stripControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s]+/gi, '[REDACTED URL]')
    .replace(
      /\b(token|password|secret|credential|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]'
    )
    .trim()
    .slice(0, 1_000)
  return normalized || undefined
}

function isBuiltInProxyPort(value: unknown): value is number {
  return Number.isInteger(value) && (value === 0 || (Number(value) >= 1_024 && Number(value) <= 65_535))
}

function serializeBuiltInProxyProfileSecrets(
  value: BuiltInProxyProfileSecrets,
  source: BuiltInProxyProfileSummary['source']
): string {
  if (value.configuration === undefined) {
    throw new Error('Built-in proxy configuration payload is missing.')
  }
  if (source === 'subscription' && !value.subscriptionUrl?.trim()) {
    throw new Error('A subscription profile requires its protected subscription URL.')
  }
  const secrets: BuiltInProxyProfileSecrets = {
    configuration: value.configuration,
    ...(value.subscriptionUrl?.trim() ? { subscriptionUrl: value.subscriptionUrl.trim() } : {}),
    ...(value.subscriptionToken ? { subscriptionToken: value.subscriptionToken } : {})
  }
  try {
    const serialized = JSON.stringify(secrets)
    const parsed = JSON.parse(serialized) as Partial<BuiltInProxyProfileSecrets>
    if (!Object.prototype.hasOwnProperty.call(parsed, 'configuration')) {
      throw new Error('missing serialized configuration')
    }
    return serialized
  } catch {
    throw new Error('Built-in proxy configuration payload is not serializable.')
  }
}

function parseBuiltInProxyProfileSecrets(value: string): BuiltInProxyProfileSecrets | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<BuiltInProxyProfileSecrets> | null
    if (!parsed || typeof parsed !== 'object' || !('configuration' in parsed)) return undefined
    return {
      configuration: structuredClone(parsed.configuration),
      ...(typeof parsed.subscriptionUrl === 'string' ? { subscriptionUrl: parsed.subscriptionUrl } : {}),
      ...(typeof parsed.subscriptionToken === 'string' ? { subscriptionToken: parsed.subscriptionToken } : {})
    }
  } catch {
    return undefined
  }
}

function toBuiltInProxyProfileSummary(profile: PersistedBuiltInProxyProfile): BuiltInProxyProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    source: profile.source,
    format: profile.format,
    nodes: profile.nodes.map((node) => ({ ...node, groupIds: [...node.groupIds] })),
    nodeCount: profile.nodes.length,
    groupCount: profile.groupCount,
    ruleStatus: profile.ruleStatus,
    ...(profile.activeNodeId ? { activeNodeId: profile.activeNodeId } : {}),
    ...(profile.warning ? { warning: profile.warning } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.lastRefreshAt !== undefined ? { lastRefreshAt: profile.lastRefreshAt } : {})
  }
}

function normalizePersistedState(
  state: PersistedState,
  sections?: readonly SqliteStateSection[]
): PersistedState {
  const timestamp = Date.now()
  const profiles = Array.isArray(state.clientProfiles) ? state.clientProfiles : []
  const proxies = Array.isArray(state.proxies) ? state.proxies : []
  const proxyProfiles = normalizePersistedBuiltInProxyProfiles(
    state.proxyProfiles,
    state.credentials,
    timestamp
  )
  const builtInProxySettings = normalizeBuiltInProxySettings(
    state.builtInProxySettings,
    proxyProfiles,
    timestamp
  )
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
    const responsesCompactMode = normalizePersistedResponsesCompactMode(
      provider.responsesCompactMode,
      sourceType,
      provider.protocol
    )
    // Provider rows are JSON payloads, so this capability is forward-compatible
    // without a SQLite schema migration. Rebuild the row to remove stale or
    // unknown values before it can enter the runtime gateway configuration.
    const { responsesCompactMode: _discardedCompactMode, ...baseProvider } = provider
    const capabilityProfile = normalizeCapabilityProfile(
      provider.capabilityProfile,
      inferUpstreamCapabilities({
        protocol: provider.protocol,
        sourceType,
        responsesCompactMode,
      }),
    )
    return {
      ...baseProvider,
      sourceType,
      forceFastMode: sourceType === 'relay'
        && supportsFastServiceTier(provider.protocol)
        && provider.forceFastMode === true,
      ...(responsesCompactMode ? { responsesCompactMode } : {}),
      capabilityProfile,
      modelCatalog: normalizeModelCatalog(provider.modelCatalog, provider.models, capabilityProfile),
    }
  })
  let accounts: Account[] = state.accounts.map((account) => {
    const credentialType = account.credentialType === 'chatgpt-agent-identity'
      ? 'chatgpt-agent-identity' as const
      : account.credentialType === 'chatgpt-oauth' || Boolean(account.chatgptAccountId)
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
      quotaProtection: normalizeQuotaProtection(account.quotaProtection),
      ...((credentialType !== 'chatgpt-oauth' && credentialType !== 'chatgpt-agent-identity')
        || (account.tagId && !accountTagIds.has(account.tagId)) ? { tagId: undefined } : {}),
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
      quotaProtection: normalizeQuotaProtection(pool.quotaProtection),
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
    builtInProxySettings,
    proxyProfiles,
    accounts,
    pools,
    routes: state.routes.map((route) => ({
      ...route,
      highConcurrencyMode: route.highConcurrencyMode === true,
    })),
    gateway: {
      ...DEFAULT_GATEWAY,
      ...state.gateway,
      outboundNetworkMode: state.gateway.outboundNetworkMode === 'system' ? 'system' : 'direct'
    },
    // Section-scoped configuration edits cannot change telemetry history. Do
    // not even allocate a 20k-row slice for those writes; the repository keeps
    // the original array/index reference when requestLogs is not writable.
    requestLogs: sections && !sections.includes('requestLogs')
      ? state.requestLogs
      : state.requestLogs.slice(0, MAX_PERSISTED_REQUEST_LOGS),
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
  const {
    credentials: _credentials,
    accounts,
    proxies,
    proxyProfiles = [],
    builtInProxySettings,
    ...safeState
  } = state
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
    builtInProxySettings: builtInProxySettings
      ? { ...builtInProxySettings }
      : createDefaultBuiltInProxySettings(),
    builtInProxyProfiles: proxyProfiles.map(toBuiltInProxyProfileSummary),
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

interface ObservabilityAccumulator {
  requestCount: number
  successCount: number
  errorCount: number
  latencyTotal: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  failoverCount: number
  errorsByStatus: Record<string, number>
}

interface HourlyAccumulator {
  timestamp: number
  requestCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  latencyTotal: number
  failoverCount: number
}

interface TokenRateAccumulator {
  timestamp: number
  requestCount: number
  outputTokens: number
  rateTotal: number
}

const TOKEN_RATE_CONFIGURATIONS: ReadonlyArray<{
  key: keyof TokenRateSeries
  windowMs: number
  bucketCount: number
}> = [
  { key: 'last30Minutes', windowMs: 30 * 60 * 1000, bucketCount: 30 },
  { key: 'last4Hours', windowMs: 4 * 60 * 60 * 1000, bucketCount: 48 },
  { key: 'last24Hours', windowMs: 24 * 60 * 60 * 1000, bucketCount: 48 },
  { key: 'last7Days', windowMs: 7 * 24 * 60 * 60 * 1000, bucketCount: 56 }
]

/** Builds every observability view in one pass over retained request history. */
export function summarizeAppObservability(
  requestLogs: readonly RequestLog[],
  now: number,
  lifetimeTokenCosts?: Readonly<OpenAiTokenCostBreakdown>
): AppSnapshot['observability'] {
  const hourMs = 60 * 60 * 1000
  const last24HoursStart = now - 24 * hourMs
  const last7DaysStart = now - 7 * 24 * hourMs
  const last24Hours = createObservabilityAccumulator()
  const last7Days = createObservabilityAccumulator()
  const hourly: HourlyAccumulator[] = Array.from({ length: 24 }, (_, index) => ({
    timestamp: now - (23 - index) * hourMs,
    requestCount: 0,
    errorCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyTotal: 0,
    failoverCount: 0
  }))
  const tokenRates = Object.fromEntries(TOKEN_RATE_CONFIGURATIONS.map((configuration) => [
    configuration.key,
    Array.from({ length: configuration.bucketCount }, (_, index) => ({
      timestamp: now - configuration.windowMs + index * configuration.windowMs / configuration.bucketCount,
      requestCount: 0,
      outputTokens: 0,
      rateTotal: 0
    }))
  ])) as Record<keyof TokenRateSeries, TokenRateAccumulator[]>
  const todayStart = localNaturalDayStart(now)
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStart = tomorrow.getTime()
  const todayCosts = createOpenAiTokenCostAccumulator()
  const retainedAllTimeCosts = lifetimeTokenCosts ? undefined : createOpenAiTokenCostAccumulator()

  for (const log of requestLogs) {
    if (retainedAllTimeCosts) accumulateOpenAiTokenCost(retainedAllTimeCosts, log)
    if (log.timestamp >= todayStart && log.timestamp < tomorrowStart) {
      accumulateOpenAiTokenCost(todayCosts, log)
    }

    // Windowed summaries and rate charts deliberately exclude future-dated
    // rows, matching the previous independent summarizers.
    if (log.timestamp > now) continue
    if (log.timestamp >= last7DaysStart) accumulateObservability(last7Days, log)
    if (log.timestamp >= last24HoursStart) accumulateObservability(last24Hours, log)

    const hoursAgo = Math.floor((now - log.timestamp) / hourMs)
    const hourlyIndex = 23 - hoursAgo
    if (hourlyIndex >= 0 && hourlyIndex < hourly.length) {
      const bucket = hourly[hourlyIndex]
      bucket.requestCount += 1
      if (log.status === 'error') bucket.errorCount += 1
      bucket.inputTokens += log.inputTokens ?? 0
      bucket.outputTokens += log.outputTokens ?? 0
      bucket.latencyTotal += log.latencyMs
      bucket.failoverCount += log.failoverCount ?? 0
    }

    if (log.status !== 'success' || !log.outputTokens || log.outputTokens <= 0 || log.latencyMs <= 0) {
      continue
    }
    // `firstTokenMs` is the first user-visible semantic token. Reasoning tokens
    // are generated before that point, so count generation from the first
    // upstream body byte (or the nearest available transport milestone).
    const generationStartedMs = log.upstreamFirstByteMs
      ?? log.clientFirstWriteMs
      ?? log.firstTokenMs
      ?? 0
    const generationDurationMs = log.latencyMs - generationStartedMs
    if (generationDurationMs <= 0) continue
    const tokensPerSecond = log.outputTokens * 1000 / generationDurationMs
    for (const configuration of TOKEN_RATE_CONFIGURATIONS) {
      const windowStart = now - configuration.windowMs
      if (log.timestamp < windowStart) continue
      const bucketMs = configuration.windowMs / configuration.bucketCount
      const bucketIndex = Math.min(
        configuration.bucketCount - 1,
        Math.floor((log.timestamp - windowStart) / bucketMs)
      )
      const bucket = tokenRates[configuration.key][bucketIndex]
      bucket.requestCount += 1
      bucket.outputTokens += log.outputTokens
      bucket.rateTotal += tokensPerSecond
    }
  }

  return {
    last24Hours: finishObservability(last24Hours, last24HoursStart, now),
    last7Days: finishObservability(last7Days, last7DaysStart, now),
    hourly: hourly.map(({ latencyTotal, ...bucket }) => ({
      ...bucket,
      averageLatencyMs: bucket.requestCount ? Math.round(latencyTotal / bucket.requestCount) : 0
    })),
    tokenRates: Object.fromEntries(TOKEN_RATE_CONFIGURATIONS.map(({ key }) => [
      key,
      tokenRates[key].map(({ rateTotal, ...bucket }) => ({
        ...bucket,
        tokensPerSecond: bucket.requestCount
          ? Math.round(rateTotal / bucket.requestCount * 10) / 10
          : 0
      }))
    ])) as unknown as TokenRateSeries,
    tokenCosts: {
      generatedAt: now,
      todayStart,
      today: finishOpenAiTokenCostAccumulator(todayCosts),
      allTime: lifetimeTokenCosts
        ? structuredClone(lifetimeTokenCosts)
        : finishOpenAiTokenCostAccumulator(retainedAllTimeCosts!)
    }
  }
}

function createObservabilityAccumulator(): ObservabilityAccumulator {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    latencyTotal: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    failoverCount: 0,
    errorsByStatus: {}
  }
}

function accumulateObservability(accumulator: ObservabilityAccumulator, log: Readonly<RequestLog>): void {
  accumulator.requestCount += 1
  if (log.status === 'success') accumulator.successCount += 1
  if (log.status === 'error') {
    accumulator.errorCount += 1
    const key = String(log.statusCode ?? 'unknown')
    accumulator.errorsByStatus[key] = (accumulator.errorsByStatus[key] ?? 0) + 1
  }
  accumulator.latencyTotal += log.latencyMs
  accumulator.inputTokens += log.inputTokens ?? 0
  accumulator.outputTokens += log.outputTokens ?? 0
  accumulator.cachedInputTokens += log.cachedInputTokens ?? 0
  accumulator.reasoningTokens += log.reasoningTokens ?? 0
  accumulator.failoverCount += log.failoverCount ?? 0
}

function finishObservability(
  accumulator: ObservabilityAccumulator,
  windowStart: number,
  windowEnd: number
) {
  const { latencyTotal, ...summary } = accumulator
  return {
    windowStart,
    windowEnd,
    ...summary,
    successRate: summary.requestCount ? summary.successCount / summary.requestCount : 0,
    averageLatencyMs: summary.requestCount ? Math.round(latencyTotal / summary.requestCount) : 0
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
  const oauthAccounts = accounts.filter((account) => account.credentialType === 'chatgpt-oauth'
    || account.credentialType === 'chatgpt-agent-identity')
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
  for (const account of accounts.filter((candidate) => candidate.credentialType !== 'chatgpt-oauth'
    && candidate.credentialType !== 'chatgpt-agent-identity')) {
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
    const members = accounts.filter((account) => account.providerId === provider.id
      && account.credentialType !== 'chatgpt-oauth'
      && account.credentialType !== 'chatgpt-agent-identity')
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

function isResponsesCompactMode(value: unknown): value is ResponsesCompactMode {
  return value === 'legacy' || value === 'passthrough' || value === 'native'
}

function supportsExplicitResponsesCompactMode(
  sourceType: ProviderDefinition['sourceType'],
  protocol: ProviderDefinition['protocol']
): boolean {
  return sourceType === 'relay' && protocol === 'openai-responses'
}

function resolveResponsesCompactModeInput(
  requested: unknown,
  existing: unknown,
  sourceType: ProviderDefinition['sourceType'],
  protocol: ProviderDefinition['protocol']
): ResponsesCompactMode | undefined {
  if (requested !== undefined) {
    if (!isResponsesCompactMode(requested)) {
      throw new Error('Responses compact mode must be legacy, passthrough, or native.')
    }
    if (!supportsExplicitResponsesCompactMode(sourceType, protocol)) {
      throw new Error('Responses compact mode can be configured only for OpenAI Responses relay sources.')
    }
    return requested
  }
  // Editing an existing source through an older renderer must not silently
  // reset its capability. A source/protocol change, however, clears the field.
  return supportsExplicitResponsesCompactMode(sourceType, protocol) && isResponsesCompactMode(existing)
    ? existing
    : undefined
}

function normalizePersistedResponsesCompactMode(
  value: unknown,
  sourceType: ProviderDefinition['sourceType'],
  protocol: ProviderDefinition['protocol']
): ResponsesCompactMode | undefined {
  return supportsExplicitResponsesCompactMode(sourceType, protocol) && isResponsesCompactMode(value)
    ? value
    : undefined
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
  if (!normalizedProxyId) throw new Error('请选择一个代理后再导入账号。')
  if (!proxies.some((proxy) => proxy.id === normalizedProxyId)) {
    throw new Error('选择的代理已被删除，请重新选择后再导入。')
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
      throw new Error('选择的代理已被删除，请重新选择后再导入。')
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
  const credentialIdentity = account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity'
    ? { type: account.credentialType, accountId: account.chatgptAccountId ?? '' }
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

function apiSourceConnectionFingerprint(
  state: PersistedState,
  sourceId: string,
  decryptCredential: (encrypted: string) => string | undefined,
): string {
  const provider = state.providers.find((candidate) => candidate.id === sourceId)
  if (!provider || provider.sourceType === 'oauth-system') throw new Error('API source not found.')
  const account = state.accounts.find((candidate) => candidate.providerId === sourceId
    && candidate.credentialType !== 'chatgpt-oauth'
    && candidate.credentialType !== 'chatgpt-agent-identity')
  if (!account) throw new Error('API source account not found.')
  const encrypted = state.credentials[account.credentialId]
  const credential = encrypted ? decryptCredential(encrypted) : undefined
  return hashApiSourceConnection({
    sourceId,
    accountId: account.id,
    credentialId: account.credentialId,
    sourceType: provider.sourceType,
    kind: provider.kind,
    baseUrl: normalizeUrl(provider.baseUrl),
    protocol: provider.protocol,
    responsesCompactMode: provider.responsesCompactMode ?? null,
    proxyId: account.proxyId ?? null,
    credential: credential ?? '',
    probeRevision: apiSourceProbeRevision(provider),
  })
}

function apiSourceProbeInputFingerprint(
  state: PersistedState,
  input: ApiSourceProbeInput,
  decryptCredential: (encrypted: string) => string | undefined,
): string {
  const sourceId = input.id?.trim()
  if (!sourceId) throw new Error('API source id is required for a persistent capability probe.')
  const provider = state.providers.find((candidate) => candidate.id === sourceId)
  if (!provider || provider.sourceType === 'oauth-system') throw new Error('API source not found.')
  const account = state.accounts.find((candidate) => candidate.providerId === sourceId
    && candidate.credentialType !== 'chatgpt-oauth'
    && candidate.credentialType !== 'chatgpt-agent-identity')
  if (!account) throw new Error('API source account not found.')
  const suppliedCredential = input.credential?.trim()
  const encrypted = state.credentials[account.credentialId]
  const credential = suppliedCredential
    || (encrypted ? decryptCredential(encrypted) : undefined)
    || ''
  const selectedProxyId = input.proxyId?.trim() || account.proxyId || null
  return hashApiSourceConnection({
    sourceId,
    accountId: account.id,
    credentialId: account.credentialId,
    sourceType: input.sourceType,
    kind: input.kind,
    baseUrl: normalizeUrl(input.baseUrl),
    protocol: input.protocol,
    responsesCompactMode: input.responsesCompactMode ?? null,
    proxyId: selectedProxyId,
    credential,
    probeRevision: apiSourceProbeRevision(provider),
  })
}

function apiSourceProbeRevision(provider: ProviderDefinition): object {
  return {
    updatedAt: provider.updatedAt,
    models: provider.models,
    capabilityProfile: provider.capabilityProfile ?? null,
    modelCatalog: provider.modelCatalog ?? [],
  }
}

function hashApiSourceConnection(value: {
  sourceId: string
  accountId: string
  credentialId: string
  sourceType: ProviderDefinition['sourceType']
  kind: ProviderDefinition['kind']
  baseUrl: string
  protocol: ProviderDefinition['protocol']
  responsesCompactMode: ResponsesCompactMode | null
  proxyId: string | null
  credential: string
  probeRevision: object
}): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url')
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

function normalizeQuotaProtection(policy: QuotaProtectionPolicy | undefined): QuotaProtectionPolicy | undefined {
  if (!policy) return undefined
  const percent = (value: number | undefined): number | undefined => Number.isFinite(value)
    ? Math.max(0, Math.min(100, Number(value)))
    : undefined
  const fiveHourRemainingPercent = percent(policy.fiveHourRemainingPercent)
  const sevenDayRemainingPercent = percent(policy.sevenDayRemainingPercent)
  if (fiveHourRemainingPercent === undefined && sevenDayRemainingPercent === undefined) return undefined
  return {
    ...(fiveHourRemainingPercent !== undefined ? { fiveHourRemainingPercent } : {}),
    ...(sevenDayRemainingPercent !== undefined ? { sevenDayRemainingPercent } : {}),
    unavailableBehavior: policy.unavailableBehavior === 'block' ? 'block' : 'allow',
    ...(Number.isFinite(policy.staleAfterMinutes) && policy.staleAfterMinutes! > 0
      ? { staleAfterMinutes: Math.min(7 * 24 * 60, Number(policy.staleAfterMinutes)) }
      : {})
  }
}

function normalizeGatewaySettings(settings: GatewaySettings): GatewaySettings {
  if (settings.host !== '127.0.0.1' && settings.host !== '::1' && settings.host !== 'localhost') {
    throw new Error('Stone+ only listens on a local loopback address.')
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
    responsesWebSocketEnabled: settings.responsesWebSocketEnabled === true,
    disableCodexMicro: settings.disableCodexMicro === true,
    launchAtLogin: Boolean(settings.launchAtLogin),
    desktopNotifications: settings.desktopNotifications !== false,
    automaticBackups: settings.automaticBackups !== false,
    backupRetention: boundedInteger(settings.backupRetention ?? 10, 1, 100, 10),
    outboundNetworkMode: settings.outboundNetworkMode === 'system' ? 'system' : 'direct'
  }
}
