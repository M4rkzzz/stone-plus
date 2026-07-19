import type {
  Account,
  AccountTagDefinition,
  ClientConfigProfile,
  HealthEvent,
  GatewaySettings,
  Pool,
  ProxyDefinition,
  ProviderDefinition,
  RequestLog,
  Route
} from '@shared/types'

export interface PersistedState {
  version: 1
  providers: ProviderDefinition[]
  accounts: Account[]
  accountTags: AccountTagDefinition[]
  proxies: ProxyDefinition[]
  pools: Pool[]
  routes: Route[]
  gateway: GatewaySettings
  requestLogs: RequestLog[]
  credentials: Record<string, string>
  clientProfiles: ClientConfigProfile[]
  healthEvents: HealthEvent[]
}
