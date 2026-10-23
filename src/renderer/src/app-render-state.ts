import type { AgentLifecycleSnapshot } from '@shared/agent-lifecycle'
import type { AppSnapshot } from '@shared/types'

type RuntimeSnapshotField = 'accounts' | 'gatewayStatus' | 'healthEvents' | 'observability' | 'requestLogs'

const durableSnapshotFields = [
  'providers',
  'accountTags',
  'proxies',
  'builtInProxySettings',
  'builtInProxyProfiles',
  'builtInProxyRuntimeState',
  'pools',
  'routes',
  'gateway',
  'clientProfiles',
  'vaultAvailable',
  'vaultBackend',
] as const satisfies readonly (keyof AppSnapshot)[]

const runtimeFieldsByPage: Readonly<Record<string, readonly RuntimeSnapshotField[]>> = {
  overview: ['accounts', 'gatewayStatus', 'healthEvents', 'observability', 'requestLogs'],
  setup: ['accounts', 'gatewayStatus'],
  providers: ['accounts'],
  proxies: ['accounts'],
  pools: ['accounts'],
  routes: ['accounts'],
  clients: ['accounts', 'gatewayStatus'],
  'session-repair': [],
  tunnel: [],
  browser: ['accounts'],
  diagnostics: [],
  requests: ['accounts', 'gatewayStatus', 'requestLogs'],
  settings: ['gatewayStatus', 'requestLogs'],
  help: ['accounts'],
}

/**
 * Runtime deltas keep untouched top-level collections referentially stable.
 * Use those references to avoid re-rendering the active, potentially large,
 * workspace when a delta only changes data that workspace never reads.
 */
export function appSnapshotAffectsPage(
  page: string,
  previous: AppSnapshot,
  next: AppSnapshot,
): boolean {
  if (previous === next) return false
  if (durableSnapshotFields.some((field) => previous[field] !== next[field])) return true
  const runtimeFields = runtimeFieldsByPage[page]
    ?? ['accounts', 'gatewayStatus', 'healthEvents', 'observability', 'requestLogs']
  return runtimeFields.some((field) => previous[field] !== next[field])
}

/** capturedAt and revision are transport metadata and never affect the panel. */
export function agentLifecycleRenderKey(snapshot: AgentLifecycleSnapshot): string {
  return JSON.stringify({
    busy: snapshot.busy,
    agents: snapshot.agents,
  })
}
