import { agentRouteClient, type AgentTarget } from '@shared/agent-lifecycle'
import { analyzeRouteSourceCompatibility, resolveRouteSource } from '@shared/route-sources'
import { clientNativeProtocols, type AppSnapshot } from '@shared/types'
import type { AgentRouteState } from './service'

/** Evaluate the selected upstream, not merely the protocol of the local entrypoint. */
export function resolveAgentRouteState(
  snapshot: Pick<AppSnapshot, 'routes' | 'pools' | 'providers' | 'accounts'>,
  target: AgentTarget,
): AgentRouteState {
  const client = agentRouteClient(target)
  const route = snapshot.routes.find((candidate) => candidate.client === client && candidate.enabled)
  if (!route) return { enabled: false, compatibility: 'unsupported' }
  const source = resolveRouteSource(route.poolId, snapshot)
  const analysis = analyzeRouteSourceCompatibility(client, source, snapshot)
  const nativeEntry = route.inboundProtocol === clientNativeProtocols[client]
  return {
    enabled: true,
    compatibility: !nativeEntry || !analysis.eligible ? 'unsupported'
      : analysis.mode === 'native' ? 'native' : 'compatible',
    sourceId: route.poolId,
    sourceName: source?.summary.name ?? route.poolId,
    ...(!nativeEntry ? { reason: 'The route does not use this client’s native inbound protocol.' }
      : analysis.reason ? { reason: analysis.reason } : {}),
  }
}
