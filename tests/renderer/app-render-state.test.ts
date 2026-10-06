import { describe, expect, it } from 'vitest'
import type { AgentLifecycleSnapshot } from '../../src/shared/agent-lifecycle'
import type { AppSnapshot } from '../../src/shared/types'
import {
  agentLifecycleRenderKey,
  appSnapshotAffectsPage,
} from '../../src/renderer/src/app-render-state'

function snapshot(): AppSnapshot {
  return {
    runtimeRevision: 1,
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    gateway: {
      host: '127.0.0.1',
      port: 15720,
      autoStart: true,
      logPayloads: false,
      requestTimeoutSeconds: 120,
      launchAtLogin: false,
      desktopNotifications: false,
      automaticBackups: true,
      backupRetention: 10,
      outboundNetworkMode: 'direct',
    },
    gatewayStatus: {
      running: true,
      host: '127.0.0.1',
      port: 15720,
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
    },
    requestLogs: [],
    clientProfiles: [],
    healthEvents: [],
    observability: {
      last24Hours: summary(),
      last7Days: summary(),
      hourly: [],
      tokenRates: { points: [] },
      tokenCosts: {
        today: tokenCost(),
        allTime: tokenCost(),
      },
    },
    vaultAvailable: true,
    vaultBackend: 'test',
  }
}

function summary() {
  return {
    windowStart: 0,
    windowEnd: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    successRate: 0,
    averageLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    failoverCount: 0,
    errorsByStatus: {},
  }
}

function tokenCost() {
  return {
    totalTokens: 0,
    totalCostUsd: 0,
    pricedRequestCount: 0,
    unpricedTokens: 0,
    standardInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }
}

describe('App render state selection', () => {
  it('keeps unrelated heavy workspaces stable for gateway-only runtime deltas', () => {
    const before = snapshot()
    const after = {
      ...before,
      runtimeRevision: 2,
      gatewayStatus: { ...before.gatewayStatus, activeRequests: 8 },
    }

    expect(appSnapshotAffectsPage('overview', before, after)).toBe(true)
    expect(appSnapshotAffectsPage('clients', before, after)).toBe(true)
    expect(appSnapshotAffectsPage('session-repair', before, after)).toBe(false)
    expect(appSnapshotAffectsPage('diagnostics', before, after)).toBe(false)
  })

  it('updates account workspaces without waking pages that never read accounts', () => {
    const before = snapshot()
    const after = { ...before, runtimeRevision: 2, accounts: [...before.accounts] }

    expect(appSnapshotAffectsPage('providers', before, after)).toBe(true)
    expect(appSnapshotAffectsPage('routes', before, after)).toBe(true)
    expect(appSnapshotAffectsPage('tunnel', before, after)).toBe(false)
  })

  it('always refreshes the active page for durable configuration changes', () => {
    const before = snapshot()
    const after = { ...before, runtimeRevision: 2, routes: [...before.routes] }

    expect(appSnapshotAffectsPage('session-repair', before, after)).toBe(true)
    expect(appSnapshotAffectsPage('diagnostics', before, after)).toBe(true)
  })

  it('ignores lifecycle capture metadata but notices visible lifecycle changes', () => {
    const base = {
      revision: 1,
      capturedAt: 100,
      busy: false,
      agents: { codex: { running: false } },
    } as unknown as AgentLifecycleSnapshot
    const laterCapture = { ...base, revision: 2, capturedAt: 200 }
    const running = {
      ...laterCapture,
      agents: { codex: { running: true } },
    } as unknown as AgentLifecycleSnapshot

    expect(agentLifecycleRenderKey(laterCapture)).toBe(agentLifecycleRenderKey(base))
    expect(agentLifecycleRenderKey(running)).not.toBe(agentLifecycleRenderKey(base))
  })
})
