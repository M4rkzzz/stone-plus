import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, HealthEvent, RequestLog } from '../../src/shared/types'
import {
  applyRuntimeDelta,
  RuntimeSnapshotReloadCoordinator,
  shouldAcceptSnapshotRevision,
} from '../../src/renderer/src/runtime-delta'

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

  it('single-flights full snapshot reloads and catches the newest requested revision', async () => {
    const resolvers: Array<(snapshot: AppSnapshot) => void> = []
    const fetchSnapshot = vi.fn(() => new Promise<AppSnapshot>((resolve) => resolvers.push(resolve)))
    const accepted: number[] = []
    let acceptedRevision = -1
    const coordinator = new RuntimeSnapshotReloadCoordinator({
      fetchSnapshot,
      acceptSnapshot: (snapshot) => {
        acceptedRevision = snapshot.runtimeRevision ?? acceptedRevision
        accepted.push(acceptedRevision)
      },
      acceptedRevision: () => acceptedRevision,
      onError: vi.fn(),
    })

    const first = coordinator.request(11)
    const shared = coordinator.request(14)
    coordinator.request(13)
    expect(shared).toBe(first)
    expect(fetchSnapshot).toHaveBeenCalledOnce()

    resolvers.shift()?.({ ...baseSnapshot(), runtimeRevision: 12 })
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2))
    resolvers.shift()?.({ ...baseSnapshot(), runtimeRevision: 14 })
    await first

    expect(accepted).toEqual([12, 14])
  })

  it('reactivates an in-flight reload after a StrictMode-style effect cleanup', async () => {
    let resolveSnapshot: ((snapshot: AppSnapshot) => void) | undefined
    const accepted: number[] = []
    let acceptedRevision = -1
    const coordinator = new RuntimeSnapshotReloadCoordinator({
      fetchSnapshot: () => new Promise<AppSnapshot>((resolve) => { resolveSnapshot = resolve }),
      acceptSnapshot: (snapshot) => {
        acceptedRevision = snapshot.runtimeRevision ?? acceptedRevision
        accepted.push(acceptedRevision)
      },
      acceptedRevision: () => acceptedRevision,
      onError: vi.fn(),
    })

    const firstMount = coordinator.request()
    coordinator.dispose()
    coordinator.activate()
    const secondMount = coordinator.request()
    expect(secondMount).toBe(firstMount)

    resolveSnapshot?.({ ...baseSnapshot(), runtimeRevision: 10 })
    await secondMount
    expect(accepted).toEqual([10])
  })

  it('reconciles 1,000 log events in 20 bounded updates and keeps the latest terminal state', () => {
    let snapshot = baseSnapshot()
    let updateCount = 0
    const startedAt = performance.now()

    for (let batch = 0; batch < 20; batch += 1) {
      const requestLogs = Array.from({ length: 50 }, (_, offset) => {
        const index = batch * 50 + offset
        return { ...log(`request-${index}`), timestamp: index, latencyMs: index }
      })
      snapshot = applyRuntimeDelta(snapshot, {
        revision: 11 + batch,
        requestLogs,
      })
      updateCount += 1
    }

    expect(performance.now() - startedAt).toBeLessThan(250)
    expect(updateCount).toBe(20)
    expect(snapshot.requestLogs).toHaveLength(500)
    expect(snapshot.requestLogs[0]?.id).toBe('request-999')
    expect(snapshot.requestLogs.at(-1)?.id).toBe('request-500')

    snapshot = applyRuntimeDelta(snapshot, {
      revision: 31,
      requestLogs: [{
        ...log('request-999'),
        status: 'success',
        statusCode: 200,
        latencyMs: 1_100,
      }],
    })

    expect(snapshot.requestLogs).toHaveLength(500)
    expect(snapshot.requestLogs[0]).toMatchObject({
      id: 'request-999',
      status: 'success',
      statusCode: 200,
      latencyMs: 1_100,
    })
  })
})
