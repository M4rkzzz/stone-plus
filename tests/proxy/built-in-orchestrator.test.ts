import { describe, expect, it, vi } from 'vitest'
import type {
  BuiltInProxyProfileSummary,
  BuiltInProxySettings,
  GatewaySettings,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '../../src/shared/types'
import type { BuiltInProxyProfileSecrets, BuiltInProxyProfileStoreInput } from '../../src/main/store/types'
import { BuiltInProxyRouteCoordinator } from '../../src/main/proxy/built-in/route-coordinator'
import {
  BuiltInProxyOrchestrator,
  type BuiltInProxyCore,
  type BuiltInProxyPersistence,
  type BuiltInSystemProxyLease,
  type BuiltInTunController,
} from '../../src/main/proxy/built-in/orchestrator'
import type {
  ParsedBuiltInProxyProfile,
} from '../../src/main/proxy/built-in/profile-types'
import type {
  SingBoxRuntimeEvent,
  SingBoxRuntimeState,
  SingBoxStartRequest,
} from '../../src/main/proxy/built-in/sing-box-service'

describe('BuiltInProxyOrchestrator', () => {
  it('recovers a stale system lease before the strict core -> access -> Chromium -> route activation sequence', async () => {
    const harness = createHarness({ desiredEnabled: true, autoStart: true })
    const routeStatuses: string[] = []
    harness.routes.subscribe((state) => routeStatuses.push(state.status))

    await harness.orchestrator.initialize()

    expect(harness.events).toEqual([
      'lease:recover',
      'core:start',
      'lease:acquire',
      'chromium:create',
      'store:activated',
    ])
    expect(routeStatuses).toContain('starting')
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'ready',
      desiredEnabled: true,
      effectiveRoute: {
        kind: 'built-in-mixed',
        profileId: 'profile-one',
        nodeId: 'node-one',
        mixedPort: 17890,
      },
    })
    expect(harness.store.settings.hasEverActivated).toBe(true)
    expect(harness.store.settings.mixedPort).toBe(17890)
  })

  it('fails closed when stale-lease recovery fails for a previously activated enabled route', async () => {
    const harness = createHarness({ desiredEnabled: true, autoStart: true, hasEverActivated: true })
    harness.system.recoverStaleLease.mockRejectedValueOnce(Object.assign(new Error('journal restore failed'), {
      code: 'restore_failed',
    }))

    await expect(harness.orchestrator.initialize()).rejects.toMatchObject({ category: 'system-proxy' })

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
    })
    expect(harness.core.start).not.toHaveBeenCalled()
  })

  it('blocks a persisted enabled route when auto-start is off until the user retries', async () => {
    const harness = createHarness({ desiredEnabled: true, autoStart: false, hasEverActivated: true })

    await harness.orchestrator.initialize()

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
      error: { category: 'health-check', retryable: true },
    })
    expect(harness.core.start).not.toHaveBeenCalled()

    await harness.orchestrator.retry()
    expect(harness.routes.getSnapshot()).toMatchObject({ status: 'ready', effectiveRoute: { kind: 'built-in-mixed' } })
  })

  it('remembers first-run intent without starting or taking over when no profile exists', async () => {
    const harness = createHarness({ withProfile: false })

    await harness.orchestrator.setEnabled(true)

    expect(harness.store.settings.desiredEnabled).toBe(true)
    expect(harness.core.start).not.toHaveBeenCalled()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'disabled',
      effectiveRoute: { kind: 'external' },
    })
  })

  it('fails closed when a previously activated installation no longer has a usable profile', async () => {
    const harness = createHarness({ withProfile: false, hasEverActivated: true })

    await expect(harness.orchestrator.setEnabled(true)).rejects.toMatchObject({
      category: 'configuration-invalid',
      retryable: false,
    })

    expect(harness.core.start).not.toHaveBeenCalled()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
    })
  })

  it('passes the LAN preference only to the mixed listener start request', async () => {
    const harness = createHarness()
    harness.store.settings.lanEnabled = true

    await harness.orchestrator.setEnabled(true)

    expect(harness.core.start).toHaveBeenCalledWith(expect.objectContaining({ allowLan: true }))
  })

  it('keeps the core route alive until access restore and the external system reload complete', async () => {
    const harness = createHarness({ outboundNetworkMode: 'system' })
    await harness.orchestrator.setEnabled(true)
    harness.events.length = 0

    await harness.orchestrator.setEnabled(false)

    expect(harness.events).toEqual([
      'lease:release',
      'tun:stop',
      'external:reload',
      'chromium:dispose',
      'core:stop',
    ])
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'disabled',
      effectiveRoute: { kind: 'external', externalMode: 'system' },
    })
    // The independent external preference is read, never overwritten.
    expect(harness.store.gateway.outboundNetworkMode).toBe('system')
  })

  it('keeps built-in routing and the core alive when access restoration fails, then retries safely', async () => {
    const harness = createHarness({ outboundNetworkMode: 'direct' })
    await harness.orchestrator.setEnabled(true)
    harness.system.release.mockRejectedValueOnce(Object.assign(new Error('restore failed'), { code: 'restore_failed' }))

    await expect(harness.orchestrator.setEnabled(false)).rejects.toMatchObject({
      category: 'system-proxy',
      retryable: true,
    })
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'built-in-mixed' },
    })
    expect(harness.core.stop).not.toHaveBeenCalled()

    await harness.orchestrator.retry()
    expect(harness.routes.getSnapshot()).toMatchObject({ status: 'disabled', effectiveRoute: { kind: 'external' } })
    expect(harness.core.stop).toHaveBeenCalledOnce()
  })

  it('publishes fail-closed synchronously on a core crash and releases access best-effort', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    harness.events.length = 0

    harness.coreControl.crash()

    // No microtask/queue flush is required for the route pointer to block.
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
      error: { category: 'core-crashed' },
    })
    await vi.waitFor(() => expect(harness.system.release).toHaveBeenCalled())
    expect(harness.events).toContain('lease:release')
  })

  it('fails closed on first-start TUN elevation denial and never falls back to the external route', async () => {
    const harness = createHarness({ accessMode: 'tun' })
    harness.tun.start.mockRejectedValueOnce(Object.assign(new Error('user denied elevation'), {
      code: 'tun_elevation_denied',
    }))

    await expect(harness.orchestrator.setEnabled(true)).rejects.toMatchObject({ category: 'tun-elevation' })

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      desiredEnabled: true,
      effectiveRoute: { kind: 'blocked' },
    })
    expect(harness.system.acquire).not.toHaveBeenCalled()
  })

  it('rolls persisted rule changes back and restores the prior ready generation when reconciliation fails', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const normalBuilder = harness.options.buildConfiguration!
    harness.options.buildConfiguration = ((input) => {
      if (input.mode === 'global') throw Object.assign(new Error('bad generated config'), { code: 'config_invalid' })
      return normalBuilder(input)
    }) as typeof normalBuilder
    // Re-create with the same state/dependencies so the injected builder above is observed.
    await harness.orchestrator.close()
    harness.resetOrchestrator()
    await harness.orchestrator.setEnabled(true)

    await expect(harness.orchestrator.coordinateMutation('rule-mode-changed', async () => {
      await harness.orchestrator.updateSettings({ ruleMode: 'global' })
    })).rejects.toThrow('bad generated config')

    expect(harness.store.settings.ruleMode).toBe('rule')
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'ready',
      effectiveRoute: { kind: 'built-in-mixed', nodeId: 'node-one' },
    })
  })

  it('refreshes subscriptions through the injected Stone-routed fetch and keeps URL/token only in encrypted secrets', async () => {
    const harness = createHarness({ withProfile: false })
    harness.subscriptionFetch.mockResolvedValue(new Response(
      'socks5://user:password@proxy.example:1080#Remote',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    ))

    await harness.orchestrator.importProfile({
      source: 'subscription',
      name: 'Remote list',
      url: 'https://subscription.example/private-path',
      token: 'subscription-private-token',
      format: 'uri-list',
    })

    expect(harness.subscriptionFetch).toHaveBeenCalledWith(
      'https://subscription.example/private-path',
      expect.objectContaining({ redirect: 'error' }),
    )
    const requestHeaders = new Headers(harness.subscriptionFetch.mock.calls[0][1]?.headers)
    expect(requestHeaders.get('authorization')).toBe('Bearer subscription-private-token')
    expect(JSON.stringify(harness.store.profiles)).not.toContain('subscription.example')
    expect(JSON.stringify(harness.store.profiles)).not.toContain('subscription-private-token')
    const storedSecrets = harness.store.secrets.get(harness.store.profiles[0].id)
    expect(storedSecrets).toMatchObject({
      subscriptionUrl: 'https://subscription.example/private-path',
      subscriptionToken: 'subscription-private-token',
    })
  })

  it('persists latency outcomes and annotates controller connections without exposing node credentials', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    harness.core.testLatency.mockResolvedValue({ proxyName: 'stone-node-one', delayMs: 37, testedAt: 100 })
    harness.core.getConnections.mockResolvedValue([connectionSummary()])

    const nodes = await harness.orchestrator.testLatency('profile-one', ['node-one'])
    const connections = await harness.orchestrator.listConnections()

    expect(nodes[0]).toMatchObject({ latencyStatus: 'available', latencyMs: 37, lastTestedAt: 100 })
    expect(connections[0]).toMatchObject({ profileId: 'profile-one', nodeId: 'node-one' })
    expect(JSON.stringify(connections)).not.toContain('password-one')
  })
})

interface HarnessOptions {
  withProfile?: boolean
  desiredEnabled?: boolean
  autoStart?: boolean
  accessMode?: BuiltInProxySettings['accessMode']
  outboundNetworkMode?: 'direct' | 'system'
  hasEverActivated?: boolean
}

function createHarness(input: HarnessOptions = {}) {
  const events: string[] = []
  const store = new MemoryBuiltInProxyStore({
    withProfile: input.withProfile ?? true,
    desiredEnabled: input.desiredEnabled ?? false,
    autoStart: input.autoStart ?? true,
    accessMode: input.accessMode ?? 'system',
    outboundNetworkMode: input.outboundNetworkMode ?? 'direct',
    hasEverActivated: input.hasEverActivated ?? false,
    events,
  })
  const routes = new BuiltInProxyRouteCoordinator({
    externalMode: input.outboundNetworkMode ?? 'direct',
  })
  const { core, control: coreControl } = fakeCore(events)
  const system = fakeSystemLease(events)
  const tun = fakeTunController(events)
  const subscriptionFetch = vi.fn<typeof fetch>()
  const createChromiumGeneration = vi.fn(async (mixedEndpoint: string) => {
    events.push('chromium:create')
    return {
      mixedEndpoint,
      fetchImplementation: vi.fn(async () => new Response('ok')) as unknown as typeof fetch,
      refresh: vi.fn(async () => undefined),
      dispose: vi.fn(async () => { events.push('chromium:dispose') }),
    }
  })
  const buildConfiguration = vi.fn((options: Parameters<typeof import('../../src/main/proxy/built-in/config-builder').buildSingBoxConfig>[0]) => {
    // The real builder is loaded synchronously through the production default;
    // this wrapper is replaced below after construction for fault injection.
    return defaultBuildConfiguration(options)
  })
  const options = {
    store: store as unknown as BuiltInProxyPersistence,
    core,
    routes,
    systemProxyLease: system,
    tunController: tun,
    createChromiumGeneration,
    subscriptionFetch: subscriptionFetch as unknown as typeof fetch,
    localGateway: { host: '127.0.0.1', port: 15721, transport: 'tcp' as const },
    reloadExternalSystemProxy: vi.fn(async () => { events.push('external:reload') }),
    now: () => 50,
    logger: { warn: vi.fn(), error: vi.fn() },
    buildConfiguration,
  }
  let orchestrator = new BuiltInProxyOrchestrator(options)
  return {
    events,
    store,
    routes,
    core,
    coreControl,
    system,
    tun,
    subscriptionFetch,
    createChromiumGeneration,
    options,
    get orchestrator() { return orchestrator },
    resetOrchestrator() { orchestrator = new BuiltInProxyOrchestrator(options) },
  }
}

// Kept out of the harness closure so tests exercise the real allow-listed builder.
import { buildSingBoxConfig as defaultBuildConfiguration } from '../../src/main/proxy/built-in/config-builder'

class MemoryBuiltInProxyStore {
  public settings: BuiltInProxySettings
  public profiles: BuiltInProxyProfileSummary[]
  public readonly secrets = new Map<string, BuiltInProxyProfileSecrets>()
  public readonly gateway: GatewaySettings
  private readonly events: string[]

  public constructor(options: Required<Omit<HarnessOptions, 'withProfile'>> & { withProfile: boolean; events: string[] }) {
    this.events = options.events
    this.settings = {
      desiredEnabled: options.desiredEnabled,
      ...(options.withProfile ? { activeProfileId: 'profile-one' } : {}),
      accessMode: options.accessMode,
      ruleMode: 'rule',
      mixedPort: 0,
      lanEnabled: false,
      autoStart: options.autoStart,
      hasEverActivated: options.hasEverActivated,
      updatedAt: 1,
    }
    this.profiles = options.withProfile ? [profileSummary()] : []
    if (options.withProfile) this.secrets.set('profile-one', { configuration: parsedProfile() })
    this.gateway = {
      host: '127.0.0.1',
      port: 15721,
      autoStart: false,
      desktopNotifications: false,
      logRetentionDays: 7,
      requestTimeoutMs: 120_000,
      outboundNetworkMode: options.outboundNetworkMode,
    }
  }

  public getBuiltInProxySettings() { return structuredClone(this.settings) }
  public listBuiltInProxyProfiles() { return structuredClone(this.profiles) }
  public getBuiltInProxyProfile(id: string) { return structuredClone(this.profiles.find((profile) => profile.id === id)) }
  public getBuiltInProxyProfileSecrets(id: string) { return structuredClone(this.secrets.get(id)) }
  public getRuntimeGatewaySettings() { return structuredClone(this.gateway) }

  public async saveBuiltInProxyProfile(input: BuiltInProxyProfileStoreInput) {
    const id = input.id ?? `profile-${this.profiles.length + 1}`
    const existing = this.profiles.find((profile) => profile.id === id)
    const profile: BuiltInProxyProfileSummary = {
      id,
      name: input.name,
      source: input.source,
      format: input.format,
      nodes: structuredClone(input.nodes),
      nodeCount: input.nodes.length,
      groupCount: input.groupCount,
      ruleStatus: input.ruleStatus,
      ...(input.activeNodeId ? { activeNodeId: input.activeNodeId } : {}),
      ...(input.warning ? { warning: input.warning } : {}),
      createdAt: existing?.createdAt ?? 1,
      updatedAt: 2,
      ...(input.lastRefreshAt !== undefined ? { lastRefreshAt: input.lastRefreshAt } : {}),
    }
    if (existing) this.profiles = this.profiles.map((candidate) => candidate.id === id ? profile : candidate)
    else this.profiles.push(profile)
    if (input.secrets) this.secrets.set(id, structuredClone(input.secrets))
    if (!this.settings.activeProfileId) this.settings.activeProfileId = id
    if (this.profiles.length === 1 && !existing) {
      this.settings.desiredEnabled = true
      this.settings.ruleMode = 'rule'
      this.settings.accessMode = 'system'
      this.settings.autoStart = true
    }
    return structuredClone(profile)
  }

  public async deleteBuiltInProxyProfile(id: string) {
    this.profiles = this.profiles.filter((profile) => profile.id !== id)
    this.secrets.delete(id)
    if (this.settings.activeProfileId === id) this.settings.activeProfileId = this.profiles[0]?.id
  }

  public async selectBuiltInProxyProfile(id: string) { this.settings.activeProfileId = id; return this.getBuiltInProxySettings() }
  public async selectBuiltInProxyNode(profileId: string, nodeId: string) {
    const profile = this.profiles.find((candidate) => candidate.id === profileId)!
    profile.activeNodeId = nodeId
    this.settings.activeProfileId = profileId
    return structuredClone(profile)
  }
  public async updateBuiltInProxySettings(patch: Partial<BuiltInProxySettings>) {
    Object.assign(this.settings, patch)
    return this.getBuiltInProxySettings()
  }
  public async setBuiltInProxyDesiredEnabled(enabled: boolean) {
    this.settings.desiredEnabled = enabled
    return this.getBuiltInProxySettings()
  }
  public async markBuiltInProxyActivated(mixedPort: number, activatedAt: number) {
    this.events.push('store:activated')
    Object.assign(this.settings, {
      mixedPort,
      hasEverActivated: true,
      lastActivatedAt: activatedAt,
    })
    return this.getBuiltInProxySettings()
  }
  public async setBuiltInProxyNodeLatency(
    profileId: string,
    nodeId: string,
    patch: Partial<BuiltInProxyProfileSummary['nodes'][number]>,
  ) {
    const node = this.profiles.find((profile) => profile.id === profileId)!.nodes.find((candidate) => candidate.id === nodeId)!
    Object.assign(node, patch)
    return structuredClone(node)
  }
}

function fakeCore(events: string[]): { core: BuiltInProxyCore & Record<string, ReturnType<typeof vi.fn>>; control: { crash(): void } } {
  let state: SingBoxRuntimeState = idleCoreState()
  let lastRequest: SingBoxStartRequest | undefined
  const listeners = new Set<(event: SingBoxRuntimeEvent) => void>()
  const start = vi.fn(async (request: SingBoxStartRequest) => {
    events.push('core:start')
    lastRequest = request
    state = readyCoreState()
    for (const listener of listeners) listener({ type: 'state', state: structuredClone(state) })
    return structuredClone(state)
  })
  const core = {
    getState: vi.fn(() => structuredClone(state)),
    start,
    retry: vi.fn(async () => {
      if (!lastRequest) throw new Error('no request')
      return start(lastRequest)
    }),
    stop: vi.fn(async () => {
      events.push('core:stop')
      state = idleCoreState()
      return structuredClone(state)
    }),
    close: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: SingBoxRuntimeEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    refreshConnections: vi.fn(async () => undefined),
    testLatency: vi.fn(async (proxyName: string) => ({ proxyName, delayMs: 20, testedAt: 20 })),
    getTraffic: vi.fn(async () => trafficSnapshot()),
    getConnections: vi.fn(async () => [] as ProxyConnectionSummary[]),
    closeConnection: vi.fn(async () => undefined),
  } as unknown as BuiltInProxyCore & Record<string, ReturnType<typeof vi.fn>>
  return {
    core,
    control: {
      crash: () => {
        state = {
          ...readyCoreState(),
          status: 'error',
          pid: undefined,
          mixedEndpoint: undefined,
          error: { code: 'unexpected_exit', message: 'core crashed' },
        }
        for (const listener of listeners) listener({ type: 'crash', state: structuredClone(state), exit: 'code 1' })
      },
    },
  }
}

function fakeSystemLease(events: string[]) {
  let status: 'idle' | 'active' | 'error' = 'idle'
  return {
    getState: vi.fn(() => ({ status, recoveryPending: false })),
    recoverStaleLease: vi.fn(async () => { events.push('lease:recover'); status = 'idle'; return { status: 'none' as const } }),
    acquire: vi.fn(async () => { events.push('lease:acquire'); status = 'active'; return { status: 'active' as const, recoveryPending: false } }),
    release: vi.fn(async () => { events.push('lease:release'); status = 'idle'; return { status: 'restored' as const } }),
    retryRelease: vi.fn(async () => { status = 'idle'; return { status: 'restored' as const } }),
  } as unknown as BuiltInSystemProxyLease & Record<string, ReturnType<typeof vi.fn>>
}

function fakeTunController(events: string[]) {
  let status: 'stopped' | 'ready' | 'error' = 'stopped'
  return {
    getState: vi.fn(() => ({ status, desiredEnabled: status === 'ready' })),
    start: vi.fn(async () => { events.push('tun:start'); status = 'ready'; return { status: 'ready' as const, desiredEnabled: true } }),
    retryStart: vi.fn(async () => ({ status: 'ready' as const, desiredEnabled: true })),
    stop: vi.fn(async () => { events.push('tun:stop'); status = 'stopped'; return { status: 'stopped' as const, desiredEnabled: false } }),
    retryStop: vi.fn(async () => ({ status: 'stopped' as const, desiredEnabled: false })),
  } as unknown as BuiltInTunController & Record<string, ReturnType<typeof vi.fn>>
}

function parsedProfile(): ParsedBuiltInProxyProfile {
  return {
    version: 1,
    id: 'profile-one',
    name: 'Profile one',
    format: 'uri-list',
    sourceFingerprint: 'fingerprint',
    nodes: [{
      id: 'node-one',
      name: 'Node one',
      type: 'socks',
      server: 'proxy.example',
      serverPort: 1080,
      credentials: { username: 'user-one', password: 'password-one' },
    }],
    groups: [{ id: 'group-one', name: 'Global', type: 'selector', nodeIds: ['node-one'] }],
    rules: [],
    ruleStatus: 'fallback',
    warnings: [],
  }
}

function profileSummary(): BuiltInProxyProfileSummary {
  return {
    id: 'profile-one',
    name: 'Profile one',
    source: 'import',
    format: 'uri-list',
    nodes: [{
      id: 'node-one',
      name: 'Node one',
      type: 'socks',
      groupIds: ['group-one'],
      latencyStatus: 'untested',
    }],
    nodeCount: 1,
    groupCount: 1,
    ruleStatus: 'fallback',
    activeNodeId: 'node-one',
    createdAt: 1,
    updatedAt: 1,
  }
}

function idleCoreState(): SingBoxRuntimeState {
  return {
    revision: 0,
    generation: 0,
    desiredEnabled: false,
    status: 'idle',
    version: '1.13.14',
    restartAttempt: 0,
  }
}

function readyCoreState(): SingBoxRuntimeState {
  return {
    revision: 1,
    generation: 1,
    desiredEnabled: true,
    status: 'ready',
    version: '1.13.14',
    pid: 1234,
    mixedPort: 17890,
    mixedEndpoint: 'http://127.0.0.1:17890',
    controllerPort: 19090,
    startedAt: 10,
    restartAttempt: 0,
  }
}

function trafficSnapshot(): ProxyTrafficSnapshot {
  return {
    capturedAt: 1,
    uploadBytes: 2,
    downloadBytes: 3,
    uploadRateBytesPerSecond: 4,
    downloadRateBytesPerSecond: 5,
    activeConnections: 1,
    totalConnections: 1,
  }
}

function connectionSummary(): ProxyConnectionSummary {
  return {
    id: 'connection-one',
    network: 'tcp',
    source: '127.0.0.1:5000',
    destination: 'api.openai.com:443',
    outbound: 'stone-node-one',
    uploadBytes: 10,
    downloadBytes: 20,
    startedAt: 1,
  }
}
