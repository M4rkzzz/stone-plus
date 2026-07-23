import { describe, expect, it, vi } from 'vitest'
import type {
  Account,
  Pool,
  ProviderDefinition,
  PublicProxyDefinition,
  Route,
  SystemProxyDetectionResult
} from '../../src/shared/types'
import type { AppStore } from '../../src/main/store/app-store'
import {
  EXTERNAL_SYSTEM_PROXY_DETECTION_TARGETS,
  OutboundReloadCoordinator,
  collectEnabledOutboundTargets,
  type EnabledOutboundTarget
} from '../../src/main/proxy/outbound-reload-coordinator'

describe('outbound reload coordinator', () => {
  it('collects only enabled route sources and preserves the complete PAC-sensitive URL', () => {
    const direct = account('direct-account')
    const explicit = { ...account('explicit-account'), proxyId: 'proxy-explicit' }
    const discarded = account('discarded-account')
    const proxy = proxyDefinition('proxy-explicit')
    const activePool = pool('pool-active', [direct.id, explicit.id])
    const discardedPool = pool('pool-discarded', [discarded.id])
    const configuration = {
      providers: [provider],
      accounts: [direct, explicit, discarded],
      proxies: [proxy],
      pools: [activePool, discardedPool],
      routes: [
        route('route-active', activePool.id, true),
        route('route-disabled', discardedPool.id, false)
      ]
    }
    const store = {
      getRuntimeConfiguration: () => configuration,
      getSnapshot: () => ({ pools: [activePool, discardedPool] }),
      getProxyPassword: vi.fn(() => 'proxy-password')
    } as unknown as AppStore

    const targets = [...collectEnabledOutboundTargets(store).values()]

    expect(targets).toHaveLength(2)
    expect(targets.map((target) => target.targetUrl)).toEqual([
      'https://relay.example/custom/v1/responses?tenant=stone',
      'https://relay.example/custom/v1/responses?tenant=stone'
    ])
    expect([...new Set(targets.flatMap((target) => [...target.accountIds]))].sort()).toEqual([
      direct.id,
      explicit.id
    ])
    expect(targets.find((target) => target.proxy)?.password).toBe('proxy-password')
    expect(targets.some((target) => target.accountIds.has(discarded.id))).toBe(false)
  })

  it('preserves the external detection result and excludes explicitly bound targets', async () => {
    const detection = {
      detectedAt: 123,
      targets: [{
        target: 'https://relay.example/custom/v1/responses?tenant=stone',
        summary: 'PROXY proxy.example:8080',
        reachable: true
      }]
    } satisfies SystemProxyDetectionResult
    const reload = vi.fn(async () => undefined)
    const detect = vi.fn(async () => detection)
    const coordinator = coordinatorHarness({
      reload,
      detect,
      targets: [
        outboundTarget('direct', undefined, ['direct-account']),
        outboundTarget('explicit', proxyDefinition('proxy-explicit'), ['explicit-account'])
      ]
    }).coordinator

    const result = await coordinator.detectExternalSystemProxy()

    expect(result).toBe(detection)
    expect(reload).toHaveBeenCalledOnce()
    expect(detect).toHaveBeenCalledOnce()
    const detectedTargets = detect.mock.calls[0][0]
    expect(detectedTargets.slice(0, EXTERNAL_SYSTEM_PROXY_DETECTION_TARGETS.length))
      .toEqual(EXTERNAL_SYSTEM_PROXY_DETECTION_TARGETS)
    expect(detectedTargets).toContain('https://direct.example/custom/path?pac=full')
    expect(detectedTargets).not.toContain('https://explicit.example/custom/path?pac=full')
  })

  it('continues detection with the last Chromium snapshot when PAC reload fails', async () => {
    const warning = vi.fn()
    const detection = { detectedAt: 1, targets: [] } satisfies SystemProxyDetectionResult
    const harness = coordinatorHarness({
      reload: vi.fn(async () => { throw new Error('WPAD stalled') }),
      detect: vi.fn(async () => detection),
      logger: { warn: warning, error: vi.fn() }
    })

    await expect(harness.coordinator.detectExternalSystemProxy()).resolves.toBe(detection)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('before detection'),
      expect.objectContaining({ message: 'WPAD stalled' })
    )
  })

  it('detects every enabled built-in target and rechecks failure cooldowns including paused explicit bindings', async () => {
    const accounts = [
      coolingAccount('direct-account'),
      coolingAccount('explicit-account'),
      coolingAccount('quota-account'),
      coolingAccount('unused-account')
    ]
    const detector = vi.fn(async () => ({ ok: true }))
    const probe = vi.fn(async (accountId: string) => {
      const current = accounts.find((candidate) => candidate.id === accountId)
      if (current) current.status = 'active'
    })
    const harness = coordinatorHarness({
      accounts,
      probe,
      quotaAccountIds: new Set(['quota-account']),
      targets: [
        outboundTarget('direct', undefined, ['direct-account', 'quota-account']),
        outboundTarget('explicit', proxyDefinition('proxy-explicit'), ['explicit-account'])
      ]
    })

    const result = await harness.coordinator.coordinateBuiltInRouteChange(detector)

    expect(detector).toHaveBeenCalledWith([
      'https://direct.example/custom/path?pac=full',
      'https://explicit.example/custom/path?pac=full'
    ])
    expect(probe.mock.calls.map(([id]) => id).sort()).toEqual(['direct-account', 'explicit-account'])
    expect(result.recheckedAccountIds.sort()).toEqual(['direct-account', 'explicit-account'])
    expect(result.detection).toEqual({ ok: true })
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('debounces profile/node/rule changes without ever reloading the external PAC', async () => {
    vi.useFakeTimers()
    try {
      const firstDetector = vi.fn(async () => undefined)
      const latestDetector = vi.fn(async () => undefined)
      const harness = coordinatorHarness({ debounceMs: 50 })

      harness.coordinator.scheduleBuiltInRouteChange(firstDetector)
      await vi.advanceTimersByTimeAsync(25)
      harness.coordinator.scheduleBuiltInRouteChange(latestDetector)
      await vi.advanceTimersByTimeAsync(49)
      expect(firstDetector).not.toHaveBeenCalled()
      expect(latestDetector).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await harness.coordinator.settle()
      expect(firstDetector).not.toHaveBeenCalled()
      expect(latestDetector).toHaveBeenCalledOnce()
      expect(harness.reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps concurrent reloads on the transport-owned single flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let flight: Promise<void> | undefined
    const underlyingReload = vi.fn(async () => gate)
    const reload = vi.fn(() => {
      if (flight) return flight
      const current = underlyingReload().finally(() => {
        if (flight === current) flight = undefined
      })
      flight = current
      return current
    })
    const harness = coordinatorHarness({ reload })

    const first = harness.coordinator.detectExternalSystemProxy()
    const second = harness.coordinator.detectExternalSystemProxy()
    expect(underlyingReload).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])

    expect(underlyingReload).toHaveBeenCalledOnce()
    expect(harness.detect).toHaveBeenCalledTimes(2)
  })
})

function coordinatorHarness(options: {
  reload?: () => Promise<void>
  detect?: (targets: readonly string[]) => Promise<SystemProxyDetectionResult>
  targets?: EnabledOutboundTarget[]
  accounts?: Account[]
  probe?: (accountId: string) => Promise<unknown>
  quotaAccountIds?: Set<string>
  debounceMs?: number
  logger?: Pick<Console, 'warn' | 'error'>
} = {}) {
  const accounts = options.accounts ?? []
  const reload = vi.fn(options.reload ?? (async () => undefined))
  const detect = vi.fn(options.detect ?? (async () => ({ detectedAt: 1, targets: [] })))
  const targets = new Map((options.targets ?? []).map((target, index) => [String(index), target]))
  const coordinator = new OutboundReloadCoordinator({
    transport: {
      reloadSystemProxyConfiguration: reload,
      detectSystemProxy: detect
    },
    collectTargets: () => targets,
    getRuntimeAccounts: () => accounts,
    getRuntimeAccount: (id) => accounts.find((candidate) => candidate.id === id),
    probeAccount: options.probe ?? (async () => undefined),
    isQuotaExhausted: (candidate) => options.quotaAccountIds?.has(candidate.id) ?? false,
    debounceMs: options.debounceMs,
    logger: options.logger
  })
  return { coordinator, reload, detect }
}

function outboundTarget(
  name: string,
  proxy: PublicProxyDefinition | undefined,
  accountIds: string[]
): EnabledOutboundTarget {
  return {
    proxy,
    password: proxy ? 'password' : undefined,
    targetUrl: `https://${name}.example/custom/path?pac=full`,
    accountIds: new Set(accountIds)
  }
}

const provider: ProviderDefinition = {
  id: 'provider-relay',
  name: 'Relay',
  sourceType: 'relay',
  kind: 'openai',
  baseUrl: 'https://relay.example/custom/v1/responses?tenant=stone',
  protocol: 'openai-responses',
  models: [],
  createdAt: 1,
  updatedAt: 1
}

function account(id: string): Account {
  return {
    id,
    providerId: provider.id,
    name: id,
    credentialId: `credential-${id}`,
    maskedCredential: '****',
    credentialType: 'api-key',
    status: 'active',
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    circuitState: 'closed',
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function coolingAccount(id: string): Account {
  return {
    ...account(id),
    status: 'cooldown',
    cooldownReason: 'failure',
    cooldownUntil: Date.now() + 60_000,
    circuitState: 'open'
  }
}

function proxyDefinition(id: string): PublicProxyDefinition {
  return {
    id,
    name: id,
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    hasPassword: true,
    status: 'available',
    createdAt: 1,
    updatedAt: 1
  }
}

function pool(id: string, accountIds: string[]): Pool {
  return {
    id,
    name: id,
    kind: 'standard',
    protocol: 'openai-responses',
    strategy: 'priority',
    members: accountIds.map((accountId, order) => ({ accountId, enabled: true, order, weight: 1 })),
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    forceFastMode: false,
    createdAt: 1,
    updatedAt: 1
  }
}

function route(id: string, poolId: string, enabled: boolean): Route {
  return {
    id,
    client: 'codex',
    enabled,
    poolId,
    inboundProtocol: 'openai-responses',
    modelMap: {},
    localToken: `token-${id}`,
    createdAt: 1,
    updatedAt: 1
  }
}
