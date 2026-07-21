export type Protocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'gemini'

/** Protocols whose OpenAI-compatible request body supports the priority service tier. */
export function supportsFastServiceTier(protocol: Protocol): boolean {
  return protocol === 'openai-responses' || protocol === 'openai-chat'
}

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'custom'

export type UpstreamSourceType = 'oauth-system' | 'official-api' | 'relay'

export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'expired' | 'checking'
export type AccountCircuitState = 'closed' | 'open' | 'half-open'
export type ModelPolicy = 'all' | 'selected'

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5'
export type ProxyStatus = 'unchecked' | 'available' | 'error'
export type OutboundNetworkMode = 'direct' | 'system'

export interface ProxyDefinition {
  id: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  credentialId?: string
  hasPassword: boolean
  status: ProxyStatus
  exitIp?: string
  latencyMs?: number
  lastCheckedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type PublicProxyDefinition = Omit<ProxyDefinition, 'credentialId'>

export type RouteClient = 'claude' | 'codex' | 'gemini'

export const clientNativeProtocols: Readonly<Record<RouteClient, Protocol>> = {
  claude: 'anthropic-messages',
  codex: 'openai-responses',
  gemini: 'gemini'
}

export type ClientConfigFileRole =
  | 'claude-settings'
  | 'claude-mcp'
  | 'codex-config'
  | 'codex-auth'
  | 'gemini-settings'
  | 'gemini-env'

export type ClientConfigFileFormat = 'json' | 'toml' | 'dotenv'
export type ClientConfigFieldValue = string | number | boolean | string[] | null
export type ClientConfigFieldControl = 'text' | 'number' | 'select' | 'toggle' | 'string-list'

export interface ClientConfigFieldOption {
  value: string
  label: string
  /** A short, user-facing explanation of the behavior selected by this option. */
  description?: string
  /** Marks the generally sensible choice without forcing it onto an existing file. */
  recommended?: boolean
}

export interface ClientConfigEditorField {
  id: string
  /** File containing this value. Useful for linking a form row to the live preview. */
  role: ClientConfigFileRole
  /** Exact JSON/TOML path represented by this field. */
  path: string[]
  section: string
  label: string
  description: string
  control: ClientConfigFieldControl
  value: ClientConfigFieldValue
  options?: ClientConfigFieldOption[]
  placeholder?: string
  /** Upstream default. Null means that omitting the key lets the client choose. */
  defaultValue?: ClientConfigFieldValue
  /** Suggested value for a guided "recommended settings" action. */
  recommendedValue?: ClientConfigFieldValue
  advanced?: boolean
  /** Discovered values stay visible but are edited only in the complete-file editor. */
  readOnly?: boolean
  /** Stone rewrites this connection field when applying a client profile. */
  managedByStone?: boolean
  /** The current value is intentionally withheld from the renderer. */
  sensitive?: boolean
  source?: 'catalog' | 'discovered'
  min?: number
  max?: number
  step?: number
}

export interface ClientConfigEditorFile {
  role: ClientConfigFileRole
  path: string
  format: ClientConfigFileFormat
  exists: boolean
  editable: boolean
  containsCredential: boolean
  content?: string
  revision: string
  protectedValueCount: number
}

export interface ClientConfigEditorState {
  client: RouteClient
  profileId: string
  fields: ClientConfigEditorField[]
  files: ClientConfigEditorFile[]
}

export interface ClientConfigFieldPatch {
  id: string
  value: ClientConfigFieldValue
}

export interface ClientConfigFileDraft {
  role: ClientConfigFileRole
  revision: string
  content: string
}

export interface ClientConfigEditorSaveInput {
  client: RouteClient
  profileId?: string
  patches: ClientConfigFieldPatch[]
  files: ClientConfigFileDraft[]
}

export interface ClientConfigFileStatus {
  role: ClientConfigFileRole
  path: string
  exists: boolean
  containsCredential: boolean
  size?: number
  modifiedAt?: number
}

export interface ClientConfigStatus {
  client: RouteClient
  directory: string
  directoryExists: boolean
  configured: boolean
  files: ClientConfigFileStatus[]
  backupCount: number
  lastBackupAt?: number
}

export interface ClientConfigPreview {
  client: RouteClient
  profileId: string
  files: Array<{
    role: ClientConfigFileRole
    path: string
    existed: boolean
    changed: boolean
    containsCredential: boolean
    managedFields: string[]
  }>
}

export interface ClientConfigProfile {
  id: string
  name: string
  client: RouteClient
  directory?: string
  backupRetention: number
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface ClientConfigProfileInput {
  id?: string
  name: string
  client: RouteClient
  directory?: string
  backupRetention: number
}

export interface ClientConfigBackup {
  client: RouteClient
  role: ClientConfigFileRole
  targetPath: string
  backupPath: string
  /** Stable id shared by files captured in the same backup operation. */
  groupId: string
  createdAt: number
  size: number
}

export interface ClientConfigBackupSet {
  client: RouteClient
  groupId: string
  createdAt: number
  backups: ClientConfigBackup[]
}

export interface ClientConfigBackupCreateResult extends ClientConfigBackupSet {
  removedBackups: string[]
  retentionWarning?: string
}

export interface ClientConfigBackupSetRestoreResult {
  client: RouteClient
  groupId: string
  createdAt: number
  restoredFiles: string[]
  sourceBackups: ClientConfigBackup[]
  safetyBackupSet?: ClientConfigBackupSet
}

export interface ClientConfigApplyResult {
  client: RouteClient
  changedFiles: string[]
  backups: ClientConfigBackup[]
  removedBackups: string[]
  retentionWarning?: string
}

/** Result of restoring StonePlus connectivity without replacing valid user settings. */
export interface ClientConfigRepairResult extends ClientConfigApplyResult {
  /** Documents that were syntactically unusable and had to be minimally rebuilt. */
  rebuiltRoles: ClientConfigFileRole[]
}

export interface ClientConfigRestoreResult {
  client: RouteClient
  role: ClientConfigFileRole
  restoredFile: string
  sourceBackup: string
  safetyBackup?: ClientConfigBackup
}

export interface ProviderDefinition {
  id: string
  name: string
  sourceType: UpstreamSourceType
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  icon?: string
  color?: string
  models: string[]
  /** Force the OpenAI priority service tier for this standalone relay source. */
  forceFastMode?: boolean
  createdAt: number
  updatedAt: number
}

export interface AccountTagDefinition {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface Account {
  id: string
  providerId: string
  name: string
  credentialId: string
  maskedCredential: string
  credentialType?: 'api-key' | 'chatgpt-oauth'
  chatgptAccountId?: string
  credentialExpiresAt?: number
  renewable?: boolean
  tagId?: string
  status: AccountStatus
  priority: number
  weight: number
  maxConcurrency: number
  inFlight: number
  availableModels: string[]
  modelsRefreshedAt?: number
  modelPolicy: ModelPolicy
  modelAllowlist: string[]
  proxyId?: string
  quotaRemaining?: number
  quotaUnit?: 'usd' | 'requests' | 'tokens' | 'percent'
  quota?: AccountQuotaSnapshot
  codexQuota?: AccountCodexQuotaSnapshot
  cooldownUntil?: number
  cooldownReason?: 'quota' | 'failure'
  circuitState?: AccountCircuitState
  consecutiveFailures?: number
  latencyMs?: number
  lastUsedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface AccountFitnessSnapshot {
  /** Absolute moving fitness rating. It is not normalized against the currently available peers. */
  score?: number
  sampleCount: number
  /** Number of successful and failed historical observations used by the moving evaluator. */
  successCount?: number
  failureCount?: number
  /** Bayesian long-term success rate, expressed as a percentage. */
  successRate?: number
  /** Failure-sensitive exponentially weighted recent success rate, expressed as a percentage. */
  recentSuccessRate?: number
  /** Confidence in the rating, from 0 to 100, based on effective historical sample weight. */
  confidence?: number
  firstTokenMs?: number
  outputTokensPerSecond?: number
  failurePenalty: number
  components?: {
    reliability: number
    responsiveness: number
    throughput: number
    stability: number
  }
  updatedAt?: number
  stale: boolean
  dynamicConcurrency?: number
}

export type PublicAccount = Omit<Account, 'chatgptAccountId' | 'credentialId'> & {
  fitness?: AccountFitnessSnapshot
}

export interface QuotaWindow {
  limit?: number
  remaining?: number
  resetAt?: number
}

export interface AccountQuotaSnapshot {
  requests?: QuotaWindow
  tokens?: QuotaWindow
  inputTokens?: QuotaWindow
  outputTokens?: QuotaWindow
  observedAt: number
}

export interface CodexQuotaWindow {
  usedPercent: number
  windowSeconds?: number
  resetAt?: number
}

export type CodexQuotaSource = 'usage-endpoint' | 'response-headers'

export interface AccountCodexQuotaSnapshot {
  fiveHour?: CodexQuotaWindow
  sevenDay?: CodexQuotaWindow
  allowed?: boolean
  limitReached?: boolean
  observedAt: number
  source: CodexQuotaSource
}

export interface CodexQuotaHistoryPoint {
  accountId: string
  observedAt: number
  fiveHourUsedPercent?: number
  fiveHourResetAt?: number
  sevenDayUsedPercent?: number
  sevenDayResetAt?: number
  source: CodexQuotaSource
}

export interface CodexQuotaCycleCosts {
  fiveHourUsd?: number
  sevenDayUsd?: number
}

export interface PoolMember {
  accountId: string
  enabled: boolean
  weight?: number
  order?: number
}

export type PoolKind = 'standard' | 'relay-aggregate'

export type PoolStrategy = 'balanced' | 'autobalanced' | 'priority' | 'round-robin' | 'weighted-random' | 'weighted-round-robin'

export interface Pool {
  id: string
  name: string
  kind: PoolKind
  protocol: Protocol
  strategy: PoolStrategy
  members: PoolMember[]
  modelPolicy: ModelPolicy
  modelAllowlist: string[]
  stickySessions: boolean
  stickyTtlMinutes: number
  maxRetries: number
  forceFastMode?: boolean
  hedgedRequests?: boolean
  hedgeDelayMs?: number
  firstBodyTimeoutMs?: number
  proxyId?: string
  createdAt: number
  updatedAt: number
}

export interface Route {
  id: string
  client: RouteClient
  enabled: boolean
  poolId: string
  inboundProtocol: Protocol
  modelMap: Record<string, string>
  localToken: string
  createdAt: number
  updatedAt: number
}

export interface GatewaySettings {
  host: string
  port: number
  autoStart: boolean
  logPayloads: boolean
  requestTimeoutSeconds: number
  launchAtLogin?: boolean
  desktopNotifications?: boolean
  automaticBackups?: boolean
  backupRetention?: number
  outboundNetworkMode?: OutboundNetworkMode
}

export interface SystemProxyTargetStatus {
  target: string
  summary: string
  reachable: boolean
  latencyMs?: number
  error?: string
}

export interface SystemProxyDetectionResult {
  detectedAt: number
  targets: SystemProxyTargetStatus[]
}

export type HealthEventKind = 'account-disabled' | 'account-cooldown' | 'account-recovered' | 'quota-exhausted' | 'quota-restored'

export interface HealthEvent {
  id: string
  timestamp: number
  accountId: string
  accountName: string
  providerName: string
  kind: HealthEventKind
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface ObservabilityPoint {
  timestamp: number
  requestCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  averageLatencyMs: number
  failoverCount: number
}

export interface TokenRatePoint {
  timestamp: number
  requestCount: number
  outputTokens: number
  tokensPerSecond: number
}

export interface TokenRateSeries {
  last30Minutes: TokenRatePoint[]
  last4Hours: TokenRatePoint[]
  last24Hours: TokenRatePoint[]
  last7Days: TokenRatePoint[]
}

export type OpenAiPricedModelFamily =
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  | 'gpt-5.5'
  | 'gpt-5.5-pro'
  | 'gpt-5.4'
  | 'gpt-5.4-pro'
  | 'gpt-5.4-mini'
  | 'gpt-5.4-nano'

export interface OpenAiModelPricing {
  family: OpenAiPricedModelFamily
  inputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  cacheWriteUsdPerMillion: number
  outputUsdPerMillion: number
  longContextThresholdTokens?: number
  longContextInputMultiplier?: number
  longContextOutputMultiplier?: number
}

export interface OpenAiTokenCostBreakdown {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  standardInputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  pricedTokens: number
  unpricedTokens: number
  inputCostUsd: number
  cachedInputCostUsd: number
  cacheWriteCostUsd: number
  outputCostUsd: number
  totalCostUsd: number
  pricedRequestCount: number
  unpricedRequestCount: number
  longContextRequestCount: number
  unknownModels: string[]
}

export interface OpenAiTokenCostOverview {
  generatedAt: number
  todayStart: number
  today: OpenAiTokenCostBreakdown
  allTime: OpenAiTokenCostBreakdown
}

export interface GatewayStatus {
  running: boolean
  host: string
  port: number
  startedAt?: number
  activeRequests: number
  totalRequests: number
  successRequests: number
}

export interface RequestLog {
  id: string
  /** Logical request purpose. Compaction is buffered and has no first-token metric. */
  requestKind?: 'generation' | 'search' | 'compaction'
  accountId?: string
  conversationId?: string
  conversationName?: string
  timestamp: number
  /** Request acceptance time. Present on live rows and new persisted records. */
  startedAt?: number
  client: RouteClient
  protocol: Protocol
  providerName: string
  accountName: string
  model: string
  status: 'success' | 'error' | 'streaming'
  /** Fine-grained lifecycle stage for an in-progress request. */
  progressStage?: 'receiving-body' | 'scheduling' | 'resolving-credential' | 'connecting' | 'waiting-first-byte' | 'streaming' | 'retrying'
  /** Stage in which a failed request terminated. */
  failureStage?: 'body' | 'scheduler' | 'credential' | 'connect' | 'first-byte' | 'stream' | 'client'
  statusCode?: number
  latencyMs: number
  /** Time from request acceptance until the complete JSON request body has been read and parsed. */
  bodyReadMs?: number
  /** Time spent selecting and acquiring the account used by the logged attempt. */
  schedulerSelectMs?: number
  /** Time spent resolving the credential for the account used by the logged attempt. */
  credentialResolveMs?: number
  /** Time from request acceptance until Stone starts the logged attempt's outbound fetch. */
  outboundFetchStartMs?: number
  /** Time from request acceptance until upstream response headers. */
  upstreamHeadersMs?: number
  /** Time from request acceptance until the first upstream response byte. */
  upstreamFirstByteMs?: number
  /** Time from request acceptance until Stone first writes response bytes to the client. */
  clientFirstWriteMs?: number
  /** Semantic first-token latency of the successful account attempt only. */
  accountFirstTokenMs?: number
  firstTokenMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Upstream response bytes observed while a stream is in progress. */
  streamedBytes?: number
  /** Upstream response chunks observed while a stream is in progress. */
  streamedChunks?: number
  /** Protocol-level reason the streaming attempt ended. */
  streamEndReason?: 'protocol-terminal' | 'upstream-eof' | 'terminal-timeout' | 'stream-idle-timeout' | 'client-closed' | 'explicit-error'
  /** Exact terminal event observed from an upstream Responses stream. */
  streamTerminalEvent?: 'response.completed' | 'response.incomplete' | 'response.failed'
  /** Last valid upstream Responses event type, or the non-standard `[DONE]` sentinel. */
  streamLastEventType?: string
  /** Last upstream Responses sequence number observed. */
  streamLastSequenceNumber?: number
  /** Total time from the first completed output item until stream termination. */
  terminalWaitMs?: number
  error?: string
  cachedInputTokens?: number
  /** Input tokens written into a prompt cache when the upstream reports them separately. */
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  failoverCount?: number
}

export interface ObservabilitySummary {
  windowStart: number
  windowEnd: number
  requestCount: number
  successCount: number
  errorCount: number
  successRate: number
  averageLatencyMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  failoverCount: number
  errorsByStatus: Record<string, number>
}

export interface AppSnapshot {
  providers: ProviderDefinition[]
  accounts: PublicAccount[]
  accountTags: AccountTagDefinition[]
  proxies: PublicProxyDefinition[]
  pools: Pool[]
  routes: Route[]
  gateway: GatewaySettings
  gatewayStatus: GatewayStatus
  requestLogs: RequestLog[]
  clientProfiles: ClientConfigProfile[]
  healthEvents: HealthEvent[]
  observability: {
    last24Hours: ObservabilitySummary
    last7Days: ObservabilitySummary
    hourly: ObservabilityPoint[]
    tokenRates: TokenRateSeries
    tokenCosts: OpenAiTokenCostOverview
  }
  vaultAvailable: boolean
  vaultBackend: string
}

export interface ProviderInput {
  id?: string
  name: string
  sourceType?: UpstreamSourceType
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  models: string[]
}

export interface AccountInput {
  id?: string
  providerId: string
  name: string
  credential?: string
  priority: number
  weight: number
  maxConcurrency: number
  modelPolicy?: ModelPolicy
  modelAllowlist: string[]
  proxyId?: string
  tagId?: string | null
}

export interface AccountTagInput {
  id?: string
  name: string
}

export interface AccountTagAssignmentInput {
  accountIds: string[]
  tagId: string | null
}

export interface ProxyInput {
  id?: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  clearPassword?: boolean
}

export interface ChatGptAccountImportInput {
  content: string
  name?: string
  tagId: string | null
  poolId: string | null
  progressId?: string
  /** Preserve a valid file proxy by default, explicitly clear it, or override the whole batch. */
  proxyMode?: ChatGptAccountImportProxyMode
  proxyId?: string
}

export type ChatGptAccountImportProxyMode = 'preserve' | 'direct' | 'proxy'

export interface ChatGptAccountImportResult {
  snapshot: AppSnapshot
  importedAccountIds: string[]
  createdAccountIds: string[]
  updatedAccountIds: string[]
  warnings: string[]
  detectionResults: ChatGptAccountDetectionResult[]
  assignmentSummary: ChatGptAccountImportAssignmentSummary
}

export interface ChatGptOAuthStartInput {
  name?: string
  tagId: string | null
  poolId: string | null
  proxyMode?: ChatGptAccountImportProxyMode
  proxyId?: string
}

export interface ChatGptOAuthSessionStart {
  sessionId: string
  authorizationUrl: string
  redirectUri: string
  expiresAt: number
  loopbackListening: boolean
  status: 'waiting'
}

export interface ChatGptOAuthCallbackInput {
  sessionId: string
  callbackUrl: string
}

export interface ChatGptAccountImportAssignmentSummary {
  tagId: string | null
  tagUpdatedAccountCount: number
  poolId: string | null
  poolMembersAdded: number
  poolMembersAlreadyPresent: number
  poolMembersSkipped: number
  poolAppendError?: string
}

export interface ChatGptAccountFileImportInput {
  tagId: string | null
  poolId: string | null
  proxyMode?: ChatGptAccountImportProxyMode
  proxyId?: string
  progressId?: string
}

export type AccountImportProgressPhase = 'importing' | 'refreshing' | 'assigning' | 'complete'

export interface AccountImportProgress {
  progressId: string
  phase: AccountImportProgressPhase
  completed: number
  total: number
  percent: number
  message: string
}

export interface ChatGptAccountFileImportFileResult {
  fileName: string
  status: 'imported' | 'failed'
  importedAccounts: number
  createdAccounts: number
  updatedAccounts: number
  error?: string
}

export interface ChatGptAccountDetectionResult {
  accountId: string
  accountName: string
  ok: boolean
  latencyMs?: number
  error?: string
  availableModelCount?: number
  modelRefreshError?: string
}

export interface ChatGptAccountFileImportResult {
  snapshot: AppSnapshot
  cancelled: boolean
  selectedFiles: number
  fileResults: ChatGptAccountFileImportFileResult[]
  importedAccountIds: string[]
  createdAccountIds: string[]
  updatedAccountIds: string[]
  detectionResults: ChatGptAccountDetectionResult[]
  warnings: string[]
  assignmentSummary: ChatGptAccountImportAssignmentSummary
}

export type BrowserPendingJsonStatus = 'downloading' | 'ready' | 'failed'

export interface BrowserPendingJsonItem {
  id: string
  fileName: string
  sourceUrl: string
  receivedAt: number
  sizeBytes: number
  status: BrowserPendingJsonStatus
  error?: string
}

export interface BrowserImportQueueState {
  items: BrowserPendingJsonItem[]
  readyCount: number
  totalBytes: number
  revision: number
}

export interface BrowserCachedJsonItem {
  id: string
  fileName: string
  receivedAt: number
  sizeBytes: number
}

export interface BrowserJsonCacheState {
  items: BrowserCachedJsonItem[]
  totalBytes: number
}

export interface BrowserJsonCacheSaveResult {
  cancelled: boolean
  filePath?: string
}

export interface BrowserOpenTabRequest {
  url: string
  guestId: number
}

export interface BrowserJsonImportInput extends ChatGptAccountFileImportInput {
  itemIds: string[]
}

export type ChatGptAccountExportFormat = 'sub2api' | 'cpa'
export type ChatGptAccountExportMode = 'merged' | 'separate'

export interface ChatGptAccountExportInput {
  accountIds: string[]
  format: ChatGptAccountExportFormat
  mode: ChatGptAccountExportMode
}

export interface ChatGptAccountExportResult {
  cancelled: boolean
  exportedAccounts: number
  exportedFiles: number
  filePath?: string
  directoryPath?: string
}

export interface PoolInput {
  id?: string
  name: string
  kind?: PoolKind
  protocol: Protocol
  strategy: PoolStrategy
  accountIds: string[]
  modelPolicy?: ModelPolicy
  modelAllowlist?: string[]
  stickySessions: boolean
  stickyTtlMinutes: number
  maxRetries: number
  forceFastMode?: boolean
  hedgedRequests?: boolean
  hedgeDelayMs?: number
  firstBodyTimeoutMs?: number
  proxyId?: string
}

export interface ApiSourceInput {
  id?: string
  name: string
  sourceType: Exclude<UpstreamSourceType, 'oauth-system'>
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  credential?: string
  models: string[]
  defaultModel?: string
  priority: number
  weight: number
  maxConcurrency: number
  proxyId?: string
  unlinkIncompatiblePools?: boolean
}

export interface ApiSourceProbeInput {
  id?: string
  name: string
  sourceType: Exclude<UpstreamSourceType, 'oauth-system'>
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  credential?: string
  model?: string
  proxyId?: string
}

export type ApiSourceProbeStageId = 'network' | 'authentication' | 'models' | 'generation'
export type ApiSourceProbeStageStatus = 'success' | 'warning' | 'error' | 'skipped'

export interface ApiSourceProbeStage {
  id: ApiSourceProbeStageId
  status: ApiSourceProbeStageStatus
  message: string
  latencyMs?: number
}

export interface ApiSourceProbeResult {
  ok: boolean
  stages: ApiSourceProbeStage[]
  models: string[]
  latencyMs?: number
  error?: string
  warnings: string[]
}

export interface AggregateRelayMemberInput {
  accountId: string
  order: number
  weight: number
}

export interface AggregateRelayInput {
  id?: string
  name: string
  protocol: Protocol
  strategy: Extract<PoolStrategy, 'priority' | 'round-robin' | 'weighted-round-robin'>
  members: AggregateRelayMemberInput[]
  stickySessions: boolean
  stickyTtlMinutes: number
  maxRetries: number
  proxyId?: string
}

export interface RouteSourceFastModeInput {
  sourceId: string
  enabled: boolean
}

export interface ClientRouteSourceInput {
  client: RouteClient
  sourceId: string
}

export type SetupWizardStep =
  | 'scan'
  | 'source'
  | 'source-config'
  | 'network'
  | 'upstream-test'
  | 'client'
  | 'routing'
  | 'gateway'
  | 'verify'
  | 'client-config'
  | 'complete'

/** Credential-free source selection used only to resume the setup UI. */
export type SetupSourceMethod =
  | 'existing'
  | 'oauth'
  | 'token-json'
  | 'official-api'
  | 'relay'
  | 'aggregate'

export interface SetupWizardState {
  sessionId: string
  step: SetupWizardStep
  completed: boolean
  dismissed: boolean
  sourceType?: UpstreamSourceType
  sourceMethod?: SetupSourceMethod
  sourceId?: string
  /** Local Account Tag resource id only; never OAuth/session material. */
  tagId?: string
  poolId?: string
  routeId?: string
  client?: RouteClient
  model?: string
  proxyId?: string
  lastError?: string
  /** Written only by the main process after a successful loopback end-to-end request. */
  verifiedAt?: number
  createdAt: number
  updatedAt: number
}

export interface SetupWizardProgressInput {
  sessionId?: string
  step: SetupWizardStep
  sourceType?: UpstreamSourceType
  sourceMethod?: SetupSourceMethod | null
  sourceId?: string | null
  tagId?: string | null
  poolId?: string | null
  routeId?: string | null
  client?: RouteClient
  model?: string
  proxyId?: string | null
  lastError?: string
}

export interface SetupRoutingInput {
  sessionId: string
  sourceId: string
  client: RouteClient
  model: string
  aggregatePoolId?: string
}

export interface SetupRoutingResult {
  snapshot: AppSnapshot
  poolId: string
  routeId: string
  createdPool: boolean
}

export interface EnsureGatewayRunningInput {
  host?: string
  port?: number
}

export interface EnsureGatewayRunningResult {
  snapshot: AppSnapshot
  host: string
  port: number
  changedPort: boolean
  started: boolean
}

export interface SetupRouteVerificationInput {
  client: RouteClient
  model: string
}

export interface SetupRouteVerificationResult {
  ok: boolean
  latencyMs: number
  status?: number
  responsePreview?: string
  error?: string
}

export interface ProfileBundle {
  format: 'stone-client-profile'
  version: 1
  profile: Omit<ClientConfigProfileInput, 'id'>
}

export interface BackupRecordSummary {
  path: string
  createdAt: number
  size: number
  integrity: 'valid' | 'invalid'
  automatic: boolean
}

export interface BackupOperationResult {
  backup?: BackupRecordSummary
  restored?: BackupRecordSummary
  restartRequired?: boolean
}

export interface DesktopRuntimeSettings {
  launchAtLogin: boolean
  supported: boolean
}

export interface AccountModelTestResult {
  ok: boolean
  model: string
  latencyMs: number
  statusCode?: number
  responsePreview?: string
}

export type AppUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface AppUpdateRelease {
  version: string
  tagName: string
  title: string
  notes: string
  publishedAt: string
  url: string
}

export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  revision: number
  currentVersion: string
  status: AppUpdateStatus
  checkedAt?: number
  ignoredVersion?: string
  release?: AppUpdateRelease
  progress?: AppUpdateProgress
  automaticUpdateSupported: boolean
  automaticUpdateReason?: string
  error?: string
}

export interface FrpTunnelState {
  config: string
  configSaved: boolean
  binaryAvailable: boolean
  running: boolean
  pid?: number
  startedAt?: number
  remoteAddress?: string
  serverAddress?: string
  remotePort?: number
  lastError?: string
  logs: string[]
}

export type CodexSessionRepairTargetSource = 'config' | 'rollout' | 'sqlite'

export interface CodexSessionRepairTarget {
  id: string
  sources: CodexSessionRepairTargetSource[]
  isCurrentProvider: boolean
}

export interface CodexSessionRepairOverview {
  codexHome: string
  currentProvider: string
  targets: CodexSessionRepairTarget[]
  sessionFiles: number
  archivedSessionFiles: number
  indexedThreads: number
  sqliteDatabases: string[]
  skippedFiles: string[]
}

export interface CodexSessionRepairPreview extends CodexSessionRepairOverview {
  targetProvider: string
  revision: string
  rolloutFilesToUpdate: number
  sqliteProviderRowsToUpdate: number
  sqliteUserEventRowsToUpdate: number
  sqliteCwdRowsToUpdate: number
  encryptedSessionFiles: number
  encryptedSourceProviders: string[]
}

export interface CodexSessionRepairResult {
  targetProvider: string
  repairedRolloutFiles: number
  sqliteProviderRowsUpdated: number
  sqliteUserEventRowsUpdated: number
  sqliteCwdRowsUpdated: number
  skippedFiles: string[]
  encryptedSessionFiles: number
  encryptedSourceProviders: string[]
  backupPath?: string
  retentionWarning?: string
}

export interface ChatGptDesktopRestartState {
  wasRunning: boolean
  /** AppUserModelId or executable path captured before ChatGPT is closed. */
  launchTarget: string
}

export interface CodexSessionRepairRestartResult {
  repair: CodexSessionRepairResult
  chatGptWasRunning: boolean
  chatGptRestarted: boolean
}

export type NetworkDiagnosticStatus = 'success' | 'warning' | 'error' | 'skipped'

export interface NetworkDiagnosticInput {
  proxyId?: string
}

export interface NetworkDiagnosticTargetResult {
  id: string
  label: string
  target: string
  kind: 'dns' | 'tls' | 'http'
  status: NetworkDiagnosticStatus
  latencyMs: number
  message: string
  httpStatus?: number
  addresses?: string[]
  errorCode?: string
}

export interface NetworkDiagnosticReport {
  startedAt: number
  finishedAt: number
  route: {
    kind: 'direct' | 'proxy' | 'system'
    name: string
    proxyId?: string
  }
  summary: NetworkDiagnosticStatus
  results: NetworkDiagnosticTargetResult[]
  diagnoses: string[]
}

/** Resolved renderer language used by native dialogs and main-process progress text. */
export type UiLanguage = 'zh-CN' | 'en'

export interface GatewayApi {
  setUiLanguage(language: UiLanguage): Promise<void>
  getSnapshot(): Promise<AppSnapshot>
  saveProvider(input: ProviderInput): Promise<AppSnapshot>
  refreshProviderModels(id: string): Promise<AppSnapshot>
  deleteProvider(id: string): Promise<AppSnapshot>
  saveAccount(input: AccountInput): Promise<AppSnapshot>
  saveAccountTag(input: AccountTagInput): Promise<AppSnapshot>
  deleteAccountTag(id: string): Promise<AppSnapshot>
  setAccountTags(input: AccountTagAssignmentInput): Promise<AppSnapshot>
  refreshAccountModels(id: string): Promise<AppSnapshot>
  testAccountModel(accountId: string, model: string): Promise<AccountModelTestResult>
  importChatGptAccounts(input: ChatGptAccountImportInput): Promise<ChatGptAccountImportResult>
  importChatGptAccountFiles(input: ChatGptAccountFileImportInput): Promise<ChatGptAccountFileImportResult>
  startChatGptOAuth(input: ChatGptOAuthStartInput): Promise<ChatGptOAuthSessionStart>
  openChatGptOAuth(sessionId: string): Promise<void>
  waitChatGptOAuth(sessionId: string): Promise<ChatGptAccountImportResult>
  submitChatGptOAuthCallback(input: ChatGptOAuthCallbackInput): Promise<void>
  /** False means token exchange crossed the persistence commit boundary. */
  cancelChatGptOAuth(sessionId: string): Promise<boolean>
  getBrowserImportQueue(): Promise<BrowserImportQueueState>
  removeBrowserImportItem(id: string): Promise<BrowserImportQueueState>
  clearBrowserImportQueue(): Promise<BrowserImportQueueState>
  getBrowserJsonCache(): Promise<BrowserJsonCacheState>
  saveBrowserJsonCacheItem(id: string): Promise<BrowserJsonCacheSaveResult>
  removeBrowserJsonCacheItem(id: string): Promise<BrowserJsonCacheState>
  clearBrowserJsonCache(): Promise<BrowserJsonCacheState>
  importBrowserJsonQueue(input: BrowserJsonImportInput): Promise<ChatGptAccountFileImportResult>
  exportChatGptAccounts(input: ChatGptAccountExportInput): Promise<ChatGptAccountExportResult>
  deleteAccount(id: string): Promise<AppSnapshot>
  deleteAccounts(ids: string[]): Promise<AppSnapshot>
  saveProxy(input: ProxyInput): Promise<AppSnapshot>
  deleteProxy(id: string): Promise<AppSnapshot>
  checkProxy(id: string): Promise<AppSnapshot>
  savePool(input: PoolInput): Promise<AppSnapshot>
  deletePool(id: string): Promise<AppSnapshot>
  setRouteSourceFastMode(input: RouteSourceFastModeInput): Promise<AppSnapshot>
  saveApiSource(input: ApiSourceInput): Promise<AppSnapshot>
  probeApiSource(input: ApiSourceProbeInput): Promise<ApiSourceProbeResult>
  deleteApiSource(id: string): Promise<AppSnapshot>
  saveAggregateRelay(input: AggregateRelayInput): Promise<AppSnapshot>
  getSetupWizardState(): Promise<SetupWizardState | null>
  saveSetupWizardProgress(input: SetupWizardProgressInput): Promise<SetupWizardState>
  discardSetupWizard(): Promise<void>
  completeSetupWizard(sessionId: string): Promise<void>
  applySetupRouting(input: SetupRoutingInput): Promise<SetupRoutingResult>
  ensureGatewayRunning(input?: EnsureGatewayRunningInput): Promise<EnsureGatewayRunningResult>
  verifySetupRoute(input: SetupRouteVerificationInput): Promise<SetupRouteVerificationResult>
  setClientRouteSource(input: ClientRouteSourceInput): Promise<AppSnapshot>
  updateRoute(route: Route): Promise<AppSnapshot>
  updateGateway(settings: GatewaySettings): Promise<AppSnapshot>
  startGateway(): Promise<AppSnapshot>
  stopGateway(): Promise<AppSnapshot>
  rebuildOutboundConnections(): Promise<void>
  detectSystemProxy(): Promise<SystemProxyDetectionResult>
  runNetworkDiagnostics(input?: NetworkDiagnosticInput): Promise<NetworkDiagnosticReport>
  checkAccount(id: string): Promise<AppSnapshot>
  refreshAccountCodexQuota(id: string): Promise<AppSnapshot>
  getAccountCodexQuotaHistory(id: string, from?: number, to?: number): Promise<CodexQuotaHistoryPoint[]>
  getAccountCodexQuotaCycleCosts(id: string): Promise<CodexQuotaCycleCosts>
  clearLogs(): Promise<AppSnapshot>
  clearHealthEvents(): Promise<AppSnapshot>
  saveClientProfile(input: ClientConfigProfileInput): Promise<AppSnapshot>
  deleteClientProfile(id: string): Promise<AppSnapshot>
  exportClientProfile(id: string): Promise<ProfileBundle>
  importClientProfile(bundle: ProfileBundle): Promise<AppSnapshot>
  chooseClientConfigDirectory(client: RouteClient, currentDirectory?: string): Promise<string | null>
  getClientConfigs(profileId?: string): Promise<ClientConfigStatus[]>
  previewClientConfig(client: RouteClient, profileId?: string): Promise<ClientConfigPreview>
  applyClientConfig(client: RouteClient, profileId?: string): Promise<ClientConfigApplyResult>
  repairClientConfig(client: RouteClient, profileId?: string): Promise<ClientConfigRepairResult>
  listClientConfigBackups(client: RouteClient, profileId?: string): Promise<ClientConfigBackup[]>
  createClientConfigBackup(client: RouteClient, profileId?: string): Promise<ClientConfigBackupCreateResult>
  restoreLatestClientConfigBackup(client: RouteClient, profileId?: string): Promise<ClientConfigBackupSetRestoreResult>
  restoreClientConfigBackupSet(groupId: string, client: RouteClient, profileId?: string): Promise<ClientConfigBackupSetRestoreResult>
  restoreClientConfig(backupPath: string, client: RouteClient, profileId?: string): Promise<ClientConfigRestoreResult>
  getClientConfigEditor(client: RouteClient, profileId?: string): Promise<ClientConfigEditorState>
  saveClientConfigEditor(input: ClientConfigEditorSaveInput): Promise<ClientConfigApplyResult>
  listStateBackups(): Promise<BackupRecordSummary[]>
  createStateBackup(): Promise<BackupOperationResult>
  verifyStateBackup(path: string): Promise<BackupRecordSummary>
  restoreStateBackup(path: string): Promise<BackupOperationResult>
  getDesktopRuntimeSettings(): Promise<DesktopRuntimeSettings>
  updateDesktopRuntimeSettings(settings: Pick<DesktopRuntimeSettings, 'launchAtLogin'>): Promise<DesktopRuntimeSettings>
  exportDiagnostics(): Promise<string>
  getUpdateState(): Promise<AppUpdateState>
  checkForUpdates(): Promise<AppUpdateState>
  ignoreUpdate(version: string): Promise<AppUpdateState>
  downloadUpdate(): Promise<AppUpdateState>
  installUpdate(): Promise<void>
  openUpdatePage(): Promise<void>
  getFrpTunnelState(): Promise<FrpTunnelState>
  saveFrpTunnelConfig(content: string): Promise<FrpTunnelState>
  startFrpTunnel(): Promise<FrpTunnelState>
  stopFrpTunnel(): Promise<FrpTunnelState>
  clearFrpTunnelLogs(): Promise<FrpTunnelState>
  inspectCodexSessionRepair(): Promise<CodexSessionRepairOverview>
  previewCodexSessionRepair(targetProvider: string): Promise<CodexSessionRepairPreview>
  repairCodexSessions(targetProvider: string, expectedRevision: string): Promise<CodexSessionRepairResult>
  repairCodexSessionsAndRestartChatGpt(): Promise<CodexSessionRepairRestartResult>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  onAccountImportProgress(listener: (progress: AccountImportProgress) => void): () => void
  onBrowserImportQueue(listener: (state: BrowserImportQueueState) => void): () => void
  onBrowserOpenTab(listener: (request: BrowserOpenTabRequest) => void): () => void
  onUpdateState(listener: (state: AppUpdateState) => void): () => void
}
