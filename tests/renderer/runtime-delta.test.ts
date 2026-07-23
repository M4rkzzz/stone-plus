import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HealthEvent, RequestLog } from '../../src/shared/types'
import { applyRuntimeDelta, shouldAcceptSnapshotRevision } from '../../src/renderer/src/runtime-delta'

const baseSnapshot = (): AppSnapshot => ({
  runtimeRevision: 10,
  providers: [], accounts: [], accountTags: [], proxies: [], pools: [], routes: [],
  gateway: { host: '127.0.0.1', port: 15721, autoStart: false, logPayloads: false,
    requestTimeoutSeconds: 120, launchAtLogin: false, desktopNotifications: true,
    automaticBackups: true, backupRetention: 10, outboundNetworkMode: 'direct' },
  gatewayStatus: { running: true, host: '127.0.0.1', port: 15721, activeRequests: 0, totalRequests: 0, successRequests: 0 },
  requestLogs: [], clientProfiles: [], healthEvents: [],
  observability: {
    last24Hours: { windowStart: 0, windowEnd: 0, requestCount: 0, successCount: 0, errorCount: 0, successRate: 0, averageLatencyMs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, failoverCount: 0, errorsByStatus: {} },
    last7Days: { windowStart: 0, windowEnd: 0, requestCount: 0, successCount: 0, errorCount: 0, successRate: 0, averageLatencyMs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, failoverCount: 0, errorsByStatus: {} },
    hourly: [], tokenRates: { points: [] }, tokenCosts: { today: { totalTokens: 0, totalCostUsd: 0, pricedRequestCount: 0, unpricedTokens: 0, standardInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, allTime: { totalTokens: 0, totalCostUsd: 0, pricedRequestCount: 0, unpricedTokens: 0, standardInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 } }
  },
  vaultAvailable: true, vaultBackend: 'test'
})

const log = (id: string): RequestLog => ({
  id, timestamp: Date.now(), client: 'codex', protocol: 'openai-responses',
  providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'streaming', latencyMs: 1
})

const healthEvent = (id: string, timestamp: number): HealthEvent => ({
  id,
  timestamp,
  accountId: 'account-1',
  accountName: 'Account',
  providerName: 'OpenAI',
  kind: 'account-recovered',
  severity: 'info',
  message: id
})

describe('runtime delta reconciliation', () => {
  it('rejects a stale snapshot after a newer delta has already applied', () => {
    expect(shouldAcceptSnapshotRevision(11, 10)).toBe(false)
    expect(shouldAcceptSnapshotRevision(11, 11)).toBe(true)
    expect(shouldAcceptSnapshotRevision(-1, 1)).toBe(true)
  })

  it('upserts request logs and advances the renderer revision', () => {
    const result = applyRuntimeDelta(baseSnapshot(), {
      revision: 11,
      requestLogs: [log('request-1')]
    })
    expect(result.runtimeRevision).toBe(11)
    expect(result.requestLogs.map((entry) => entry.id)).toEqual(['request-1'])
  })

  it('prepends newly emitted health events while updating existing events in place', () => {
    const snapshot = baseSnapshot()
    snapshot.healthEvents = [healthEvent('existing', 1)]

    const result = applyRuntimeDelta(snapshot, {
      revision: 11,
      healthEvents: [
        healthEvent('existing', 2),
        healthEvent('newer', 3),
        healthEvent('newest', 4)
      ]
    })

    expect(result.healthEvents.map((event) => event.id)).toEqual(['newest', 'newer', 'existing'])
    expect(result.healthEvents.at(-1)?.timestamp).toBe(2)
  })
})
