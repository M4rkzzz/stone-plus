export type Protocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'gemini'

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'custom'

export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'expired' | 'checking'
export type AccountCircuitState = 'closed' | 'open' | 'half-open'
export type ModelPolicy = 'all' | 'selected'

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5'
export type ProxyStatus = 'unchecked' | 'available' | 'error'

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
export type ClientConfigFieldValue = string | boolean | string[] | null
export type ClientConfigFieldControl = 'text' | 'select' | 'toggle' | 'string-list'

export interface ClientConfigFieldOption {
  value: string
  label: string
}

export interface ClientConfigEditorField {
  id: string
  section: string
  label: string
  control: ClientConfigFieldControl
  value: ClientConfigFieldValue
  options?: ClientConfigFieldOption[]
  placeholder?: string
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
  createdAt: number
  size: number
}

export interface ClientConfigApplyResult {
  client: RouteClient
  changedFiles: string[]
  backups: ClientConfigBackup[]
  removedBackups: string[]
  retentionWarning?: string
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
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  icon?: string
  color?: string
  models: string[]
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
  circuitState?: AccountCircuitState
  consecutiveFailures?: number
  latencyMs?: number
  lastUsedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type PublicAccount = Omit<Account, 'chatgptAccountId' | 'credentialId'>

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

export interface PoolMember {
  accountId: string
  enabled: boolean
}

export type PoolStrategy = 'balanced' | 'autobalanced' | 'priority' | 'round-robin' | 'weighted-random'

export interface Pool {
  id: string
  name: string
  protocol: Protocol
  strategy: PoolStrategy
  members: PoolMember[]
  modelPolicy: ModelPolicy
  modelAllowlist: string[]
  stickySessions: boolean
  stickyTtlMinutes: number
  maxRetries: number
  forceFastMode?: boolean
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
  accountId?: string
  conversationId?: string
  conversationName?: string
  timestamp: number
  client: RouteClient
  protocol: Protocol
  providerName: string
  accountName: string
  model: string
  status: 'success' | 'error' | 'streaming'
  statusCode?: number
  latencyMs: number
  firstTokenMs?: number
  inputTokens?: number
  outputTokens?: number
  error?: string
  cachedInputTokens?: number
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
  }
  vaultAvailable: boolean
  vaultBackend: string
}

export interface ProviderInput {
  id?: string
  name: string
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
  providerId: string
  content: string
  name?: string
}

export interface ChatGptAccountImportResult {
  snapshot: AppSnapshot
  importedAccountIds: string[]
  createdAccountIds: string[]
  updatedAccountIds: string[]
  warnings: string[]
}

export interface ChatGptAccountFileImportInput {
  providerId: string
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
}

export interface PoolInput {
  id?: string
  name: string
  protocol: Protocol
  strategy: PoolStrategy
  accountIds: string[]
  modelPolicy?: ModelPolicy
  modelAllowlist?: string[]
  stickySessions: boolean
  stickyTtlMinutes: number
  maxRetries: number
  forceFastMode?: boolean
  proxyId?: string
}

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  protocol: Protocol
  models: string[]
}

export interface ProviderOnboardingInput {
  presetId: string
  providerName?: string
  accountName: string
  credential: string
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

export interface GatewayApi {
  getSnapshot(): Promise<AppSnapshot>
  saveProvider(input: ProviderInput): Promise<AppSnapshot>
  refreshProviderModels(id: string): Promise<AppSnapshot>
  deleteProvider(id: string): Promise<AppSnapshot>
  saveAccount(input: AccountInput): Promise<AppSnapshot>
  refreshAccountModels(id: string): Promise<AppSnapshot>
  testAccountModel(accountId: string, model: string): Promise<AccountModelTestResult>
  importChatGptAccounts(input: ChatGptAccountImportInput): Promise<ChatGptAccountImportResult>
  importChatGptAccountFiles(input: ChatGptAccountFileImportInput): Promise<ChatGptAccountFileImportResult>
  deleteAccount(id: string): Promise<AppSnapshot>
  saveProxy(input: ProxyInput): Promise<AppSnapshot>
  deleteProxy(id: string): Promise<AppSnapshot>
  checkProxy(id: string): Promise<AppSnapshot>
  savePool(input: PoolInput): Promise<AppSnapshot>
  deletePool(id: string): Promise<AppSnapshot>
  updateRoute(route: Route): Promise<AppSnapshot>
  updateGateway(settings: GatewaySettings): Promise<AppSnapshot>
  startGateway(): Promise<AppSnapshot>
  stopGateway(): Promise<AppSnapshot>
  checkAccount(id: string): Promise<AppSnapshot>
  refreshAccountCodexQuota(id: string): Promise<AppSnapshot>
  getAccountCodexQuotaHistory(id: string, from?: number, to?: number): Promise<CodexQuotaHistoryPoint[]>
  clearLogs(): Promise<AppSnapshot>
  clearHealthEvents(): Promise<AppSnapshot>
  listProviderPresets(): Promise<ProviderPreset[]>
  onboardProvider(input: ProviderOnboardingInput): Promise<AppSnapshot>
  saveClientProfile(input: ClientConfigProfileInput): Promise<AppSnapshot>
  deleteClientProfile(id: string): Promise<AppSnapshot>
  exportClientProfile(id: string): Promise<ProfileBundle>
  importClientProfile(bundle: ProfileBundle): Promise<AppSnapshot>
  getClientConfigs(profileId?: string): Promise<ClientConfigStatus[]>
  previewClientConfig(client: RouteClient, profileId?: string): Promise<ClientConfigPreview>
  applyClientConfig(client: RouteClient, profileId?: string): Promise<ClientConfigApplyResult>
  listClientConfigBackups(client: RouteClient, profileId?: string): Promise<ClientConfigBackup[]>
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
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  onUpdateState(listener: (state: AppUpdateState) => void): () => void
}
