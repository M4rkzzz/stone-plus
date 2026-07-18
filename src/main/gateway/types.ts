import type {
  Account,
  AccountCircuitState,
  AccountCodexQuotaSnapshot,
  AccountQuotaSnapshot,
  AccountStatus,
  GatewaySettings,
  GatewayStatus,
  Pool,
  PublicProxyDefinition,
  ProviderDefinition,
  Protocol,
  RequestLog,
  Route
} from '../../shared/types'

export interface GatewayConfig {
  accounts: Account[]
  pools: Pool[]
  proxies?: PublicProxyDefinition[]
  providers: ProviderDefinition[]
  routes: Route[]
  settings: GatewaySettings
}

export interface ResolvedGatewayCredential {
  secret: string
  kind: 'api-key' | 'chatgpt-oauth'
  accountId?: string
}

export type CredentialResolver = (account: Account, fetchImplementation?: typeof fetch) =>
  Promise<ResolvedGatewayCredential | string | undefined> | ResolvedGatewayCredential | string | undefined

export type OutboundFetchResolver = (account: Account, pool: Pool) => typeof fetch

export type GatewayLogHandler = (log: RequestLog) => void

export interface GatewayAccountState {
  accountId: string
  status: AccountStatus
  circuitState: AccountCircuitState
  consecutiveFailures: number
  cooldownUntil?: number
  latencyMs?: number
  lastError?: string
  lastUsedAt?: number
  quota?: AccountQuotaSnapshot
  codexQuota?: AccountCodexQuotaSnapshot
}

export type GatewayAccountStateHandler = (state: GatewayAccountState) => void

export type ConversationTitleResolver = (conversationId: string) => Promise<string | undefined> | string | undefined

export interface GatewayServerOptions {
  config: GatewayConfig
  credentialResolver: CredentialResolver
  onLog?: GatewayLogHandler
  onAccountState?: GatewayAccountStateHandler
  fetchImplementation?: typeof fetch
  outboundFetchResolver?: OutboundFetchResolver
  conversationTitleResolver?: ConversationTitleResolver
  now?: () => number
  random?: () => number
}

export interface GatewayController {
  start(settings?: GatewaySettings, credentialResolver?: CredentialResolver): Promise<void>
  stop(): Promise<void>
  getStatus(): GatewayStatus
  updateConfig(config: GatewayConfig): void
  resetAccountHealth(accountId: string): void
  onLog(listener: GatewayLogHandler): () => void
  onAccountState(listener: GatewayAccountStateHandler): () => void
}

export interface ScheduledAccount {
  account: Account
  release(): void
}

export interface SchedulerSelectionInput {
  pool: Pool
  accounts: Account[]
  model: string
  sessionId?: string
}

export interface ProtocolRequest {
  protocol: Protocol
  body: Record<string, unknown>
  model: string
}
