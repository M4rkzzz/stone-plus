import type {
  Account,
  AccountTagDefinition,
  BuiltInProxyProfileSummary,
  BuiltInProxySettings,
  ClientConfigProfile,
  HealthEvent,
  GatewaySettings,
  Pool,
  ProxyDefinition,
  ProviderDefinition,
  RequestLog,
  Route
} from '@shared/types'

/** Persisted profile metadata. The referenced credential contains every sensitive field. */
export interface PersistedBuiltInProxyProfile extends BuiltInProxyProfileSummary {
  credentialId?: string
}

/** Main-process-only opaque payload encrypted through Electron safeStorage. */
export interface BuiltInProxyProfileSecrets {
  configuration: unknown
  subscriptionUrl?: string
  subscriptionToken?: string
}

export type BuiltInProxyProfileStoreInput = Omit<
  BuiltInProxyProfileSummary,
  'id' | 'nodeCount' | 'createdAt' | 'updatedAt'
> & {
  id?: string
  secrets?: BuiltInProxyProfileSecrets
}

export interface PersistedState {
  version: 1
  providers: ProviderDefinition[]
  accounts: Account[]
  accountTags: AccountTagDefinition[]
  proxies: ProxyDefinition[]
  /** Optional only for source compatibility with legacy JSON/schema v8 fixtures. */
  builtInProxySettings?: BuiltInProxySettings
  /** Optional only for source compatibility with legacy JSON/schema v8 fixtures. */
  proxyProfiles?: PersistedBuiltInProxyProfile[]
  pools: Pool[]
  routes: Route[]
  gateway: GatewaySettings
  requestLogs: RequestLog[]
  credentials: Record<string, string>
  clientProfiles: ClientConfigProfile[]
  healthEvents: HealthEvent[]
}
