import type {
  Account,
  AccountCircuitState,
  AccountCodexQuotaSnapshot,
  AccountFitnessSnapshot,
  AccountQuotaSnapshot,
  AccountStatus,
  GatewaySettings,
  GatewayStatus,
  Pool,
  PublicProxyDefinition,
  ProviderDefinition,
  Protocol,
  RequestLog,
  RequestReplayResult,
  RequestReplayTemplate,
  Route,
  UpstreamCapabilityRequirement
} from '../../shared/types'

export interface GatewayConfig {
  accounts: Account[]
  pools: Pool[]
  proxies?: PublicProxyDefinition[]
  providers: ProviderDefinition[]
  routes: Route[]
  settings: GatewaySettings
  /** Recent persisted logs used only to seed autobalanced runtime performance. */
  recentRequestLogs?: RequestLog[]
}

export interface ResolvedGatewayCredential {
  secret: string
  kind: 'api-key' | 'chatgpt-oauth' | 'chatgpt-agent-identity'
  accountId?: string
  fedramp?: boolean
  /** Re-registers an invalid Agent Identity task and returns a fresh assertion. */
  recoverInvalidTask?: (expectedTaskId?: string) => Promise<ResolvedGatewayCredential>
}

export type CredentialResolver = (account: Account, fetchImplementation?: typeof fetch, signal?: AbortSignal) =>
  Promise<ResolvedGatewayCredential | string | undefined> | ResolvedGatewayCredential | string | undefined

export type OutboundFetchResolver = (
  account: Account,
  pool: Pool,
  proxies: readonly PublicProxyDefinition[]
) => typeof fetch

export type GatewayLogHandler = (log: RequestLog) => void

export interface GatewayAccountState {
  accountId: string
  status: AccountStatus
  circuitState: AccountCircuitState
  consecutiveFailures: number
  cooldownUntil?: number
  cooldownReason?: 'quota' | 'failure'
  latencyMs?: number
  lastError?: string
  lastUsedAt?: number
  quota?: AccountQuotaSnapshot
  codexQuota?: AccountCodexQuotaSnapshot
}

export type GatewayAccountStateHandler = (state: GatewayAccountState) => void

export interface GatewayRuntimeStateUpdate {
  gatewayStatus?: boolean
  accountIds?: readonly string[]
  allAccounts?: boolean
}

export type GatewayRuntimeStateHandler = (update: GatewayRuntimeStateUpdate) => void

export type ConversationTitleResolver = (conversationId: string) => Promise<string | undefined> | string | undefined

export interface GatewayServerOptions {
  config: GatewayConfig
  credentialResolver: CredentialResolver
  onLog?: GatewayLogHandler
  onAccountState?: GatewayAccountStateHandler
  fetchImplementation?: typeof fetch
  /** Optional loopback transport for request replay tests; production uses global fetch. */
  loopbackFetchImplementation?: typeof fetch
  outboundFetchResolver?: OutboundFetchResolver
  conversationTitleResolver?: ConversationTitleResolver
  now?: () => number
  random?: () => number
  /** Internal protocol-stall guard; primarily injectable for deterministic tests. */
  responsesProgressIdleTimeoutMs?: number
}

export interface GatewayController {
  start(settings?: GatewaySettings, credentialResolver?: CredentialResolver): Promise<void>
  stop(options?: { force?: boolean; drainTimeoutMs?: number }): Promise<void>
  getStatus(): GatewayStatus
  updateConfig(config: GatewayConfig): void
  updateRuntimeAccounts(accounts: readonly Account[]): void
  resetAccountHealth(accountId: string): void
  getAccountFitness(accountIds?: readonly string[]): Record<string, AccountFitnessSnapshot>
  getAccountInFlight(accountIds?: readonly string[]): Record<string, number>
  getRequestReplayTemplate(id: string): RequestReplayTemplate | undefined
  replayRequest(id: string): Promise<RequestReplayResult>
  clearRequestReplays(): void
  onLog(listener: GatewayLogHandler): () => void
  onAccountState(listener: GatewayAccountStateHandler): () => void
  onRuntimeState(listener: GatewayRuntimeStateHandler): () => void
}

export interface ScheduledAccount {
  account: Account
  release(): void
}

export interface SchedulerSelectionInput {
  pool: Pool
  accounts: readonly Account[]
  model: string
  sessionId?: string
  /** Accounts already proven bad during this request's retry chain. */
  excludedAccountIds?: readonly string[]
  /** Provider metadata used to enforce model-specific upstream capabilities. */
  providers?: readonly ProviderDefinition[]
  /** Capabilities required by the normalized protocol request. */
  requiredCapabilities?: readonly UpstreamCapabilityRequirement[]
}

export interface ProtocolRequest {
  protocol: Protocol
  body: Record<string, unknown>
  model: string
}
