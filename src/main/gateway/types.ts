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
  kind: 'api-key' | 'chatgpt-oauth' | 'chatgpt-agent-identity' | 'grok-oauth'
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
  /**
   * Static model/capability matching succeeded, but every matching source was
   * unavailable at scheduling time. The desktop layer may use this narrow set
   * to re-probe stale disabled/cooldown state without scanning unrelated
   * accounts or treating concurrency saturation as an account failure.
   */
  noEligibleAccounts?: {
    /** Gateway topology generation pinned by the request that exhausted candidates. */
    configGeneration?: number
    /** Exact enabled route used by the request. Missing legacy context is not safe to re-probe. */
    routeId?: string
    poolId: string
    accountIds: readonly string[]
  }
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
  /** Monotonic topology handoff generation. Optional only for compatibility with older adapters. */
  getConfigGeneration?(): number
  updateConfig(config: GatewayConfig): void
  updateRuntimeAccounts(accounts: readonly Account[]): void
  resetAccountHealth(accountId: string, options?: { clearPerformance?: boolean }): void
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
  /** Optional request-scoped state used by a provider dialect bridge. */
  conversionContext?: ProtocolConversionContext
}

export type ProtocolConversionDialect = 'xai-grok'

export interface ToolBridgeBinding {
  sourceType: 'function' | 'custom'
  sourceName: string
  /** Original Codex namespace for a flattened function declaration. */
  sourceNamespace?: string
  wireName: string
  /** Declarations from the current request may be called by the upstream model. */
  declared?: boolean
}

export interface ToolCallBridgeBinding {
  callId: string
  sourceType: 'function' | 'custom'
  sourceName?: string
  sourceNamespace?: string
  wireName?: string
}

/** JSON-safe, request-scoped mapping between Responses tools and Chat tools. */
export interface ToolBridgePlan {
  dialect: ProtocolConversionDialect
  tools: ToolBridgeBinding[]
  calls: ToolCallBridgeBinding[]
  /** Same-protocol Responses traffic must pass through the response restorer. */
  requiresResponseBridge?: boolean
  /** Preserve the originating Responses request's execution constraint. */
  parallelToolCalls?: boolean
}

export interface ProtocolConversionContext {
  dialect?: ProtocolConversionDialect
  toolBridgePlan?: ToolBridgePlan
}
