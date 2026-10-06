import type { AppSnapshot } from '@shared/types'

export interface DiagnosticRuntimeInfo {
  version: string
  platform: string
  arch: string
  now?: () => number
}

export function serializeDiagnostics(snapshot: AppSnapshot, runtime: DiagnosticRuntimeInfo): string {
  const now = runtime.now ?? Date.now
  return JSON.stringify({
    generatedAt: new Date(now()).toISOString(),
    version: runtime.version,
    platform: runtime.platform,
    arch: runtime.arch,
    gateway: snapshot.gatewayStatus,
    counts: {
      providers: snapshot.providers.length,
      accounts: snapshot.accounts.length,
      proxies: snapshot.proxies?.length ?? 0,
      pools: snapshot.pools.length,
      routes: snapshot.routes.length
    },
    observability: snapshot.observability,
    healthEvents: snapshot.healthEvents.slice(0, 100).map((event) => ({
      timestamp: event.timestamp,
      kind: event.kind,
      severity: event.severity
    })),
    accounts: snapshot.accounts.map((account) => ({
      credentialType: account.credentialType ?? 'api-key',
      status: account.status,
      circuitState: account.circuitState,
      consecutiveFailures: account.consecutiveFailures
    }))
  }, null, 2)
}
