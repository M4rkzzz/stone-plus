import { describe, expect, it, vi } from 'vitest'
import type {
  BuiltInProxyProfileSummary,
  BuiltInProxySettings,
  GatewaySettings,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '../../src/shared/types'
import type { BuiltInProxyProfileSecrets, BuiltInProxyProfileStoreInput } from '../../src/main/store/types'
import { outboundTagForNodeId } from '../../src/main/proxy/built-in/config-builder'
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
      'lease:verify',
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
    expect(harness.system.startMonitoring).toHaveBeenCalledOnce()
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

  it('keeps the built-in generation and core alive when the external Chromium reload fails', async () => {
    const harness = createHarness({ outboundNetworkMode: 'system' })
    await harness.orchestrator.setEnabled(true)
    harness.options.reloadExternalSystemProxy.mockRejectedValueOnce(new Error('reload timed out'))

    await expect(harness.orchestrator.setEnabled(false)).rejects.toMatchObject({
      category: 'system-proxy',
      retryable: true,
    })

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'built-in-mixed' },
    })
    expect(harness.core.stop).not.toHaveBeenCalled()
  })

  it('fails closed when another Windows proxy manager replaces the verified lease', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)

    harness.system.drift()

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
      accessState: { mode: 'system', status: 'error' },
      error: {
        category: 'system-proxy',
        message: expect.stringContaining('another proxy manager'),
      },
    })
    await vi.waitFor(() => expect(harness.system.release).toHaveBeenCalled())
  })

  it('ignores a drift event from an already retired system-proxy lease', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const releaseCalls = harness.system.release.mock.calls.length

    harness.system.emitDrift({ leaseId: 'retired-lease', port: 17_890 })
    await Promise.resolve()

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      effectiveRoute: { kind: 'built-in-mixed', mixedPort: 17_890 },
      accessState: { mode: 'system', status: 'ready' },
    })
    expect(harness.system.release).toHaveBeenCalledTimes(releaseCalls)
  })

  it('removes the system-lease observer when the orchestrator closes', async () => {
    const harness = createHarness()
    expect(harness.system.listenerCount()).toBe(1)

    await harness.orchestrator.close()

    expect(harness.system.listenerCount()).toBe(0)
  })

  it('does not stop a newly started core when rollback cannot release the system-proxy lease', async () => {
    const harness = createHarness()
    harness.createChromiumGeneration.mockRejectedValueOnce(new Error('Chromium generation failed'))
    harness.system.release.mockRejectedValueOnce(Object.assign(new Error('restore failed'), {
      code: 'restore_failed',
    }))

    await expect(harness.orchestrator.setEnabled(true)).rejects.toMatchObject({
      category: 'system-proxy',
      retryable: true,
    })

    expect(harness.core.stop).not.toHaveBeenCalled()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
    })
  })

  it('does not close the core when shutdown cannot release process-owned access', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    harness.system.release.mockRejectedValueOnce(Object.assign(new Error('restore failed'), {
      code: 'restore_failed',
    }))

    await expect(harness.orchestrator.close()).rejects.toThrow('restore failed')
    expect(harness.core.close).not.toHaveBeenCalled()
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

  it('never publishes a Chromium generation prepared for a core that crashed in the meantime', async () => {
    const harness = createHarness()
    let publishChromium!: (generation: Awaited<ReturnType<typeof harness.createChromiumGeneration>>) => void
    const staleDispose = vi.fn(async () => undefined)
    harness.createChromiumGeneration.mockImplementationOnce((mixedEndpoint) => new Promise((resolve) => {
      publishChromium = resolve
      void mixedEndpoint
    }))

    const enabling = harness.orchestrator.setEnabled(true)
    await vi.waitFor(() => expect(harness.createChromiumGeneration).toHaveBeenCalledOnce())
    harness.coreControl.crash()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
      error: { category: 'core-crashed' },
    })

    publishChromium({
      mixedEndpoint: 'http://127.0.0.1:20800',
      fetchImplementation: vi.fn(async () => new Response('stale')) as unknown as typeof fetch,
      refresh: vi.fn(async () => undefined),
      dispose: staleDispose,
    })
    await expect(enabling).rejects.toMatchObject({ category: 'core-crashed' })
    expect(staleDispose).toHaveBeenCalledOnce()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
    })
    expect(harness.store.settings.hasEverActivated).toBe(false)
  })

  it('gates new operations, drains accepted work, and closes once for concurrent callers', async () => {
    const harness = createHarness()
    let mutationStarted!: () => void
    let releaseMutation!: () => void
    const started = new Promise<void>((resolve) => { mutationStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseMutation = resolve })
    const accepted = harness.orchestrator.coordinateMutation('auto-start-changed', async () => {
      mutationStarted()
      await gate
      await harness.orchestrator.updateSettings({ autoStart: false })
    })
    await started

    const firstClose = harness.orchestrator.close()
    const secondClose = harness.orchestrator.close()
    const lateMutation = vi.fn(async () => undefined)
    await expect(harness.orchestrator.coordinateMutation('auto-start-changed', lateMutation))
      .rejects.toThrow('closing')
    expect(lateMutation).not.toHaveBeenCalled()
    expect(harness.core.close).not.toHaveBeenCalled()

    releaseMutation()
    await Promise.all([accepted, firstClose, secondClose])
    expect(harness.core.close).toHaveBeenCalledOnce()
    expect(harness.system.release).toHaveBeenCalledOnce()
    expect(harness.tun.stop).toHaveBeenCalledOnce()
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

  it('fails closed synchronously when a ready temporary TUN sidecar exits', async () => {
    const harness = createHarness({ accessMode: 'tun' })
    await harness.orchestrator.setEnabled(true)

    harness.tun.crash()

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'blocked' },
      error: { category: 'tun-elevation' },
    })
    await vi.waitFor(() => expect(harness.tun.stop).toHaveBeenCalled())
  })

  it('switches system to TUN without restarting or disposing the committed core', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const previous = harness.orchestrator.getState()

    await harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))

    const state = harness.orchestrator.getState()
    expect(harness.core.start).toHaveBeenCalledOnce()
    expect(harness.core.disposeGeneration).not.toHaveBeenCalledWith(1, { force: true })
    expect(state).toMatchObject({
      status: 'ready',
      settings: { accessMode: 'tun' },
      effectiveRoute: { kind: 'built-in-tun', mixedPort: previous.effectiveRoute.mixedPort },
      accessState: { mode: 'tun', status: 'ready' },
    })
    expect(harness.system.getState()).toMatchObject({ status: 'idle' })
    expect(harness.tun.getState()).toMatchObject({ status: 'ready' })
  })

  it('does not let a retired system-lease event stop the newly committed TUN session', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const retired = harness.system.getState()
    await harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))
    const stopCalls = harness.tun.stop.mock.calls.length

    harness.system.emitDrift({
      leaseId: retired.leaseId,
      port: retired.target?.mixed.port,
    })
    await Promise.resolve()

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      effectiveRoute: { kind: 'built-in-tun' },
      accessState: { mode: 'tun', status: 'ready' },
    })
    expect(harness.tun.getState()).toMatchObject({ status: 'ready' })
    expect(harness.tun.stop).toHaveBeenCalledTimes(stopCalls)
  })

  it('rolls a failed candidate TUN back to the same system lease, route, and core', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const previous = harness.orchestrator.getState()
    harness.tun.crashOnNextStart()

    await expect(harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))).rejects.toMatchObject({ category: 'tun-elevation' })

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      routeGeneration: previous.routeGeneration,
      settings: { accessMode: 'system' },
      effectiveRoute: { kind: 'built-in-mixed', mixedPort: previous.effectiveRoute.mixedPort },
      accessState: { mode: 'system', status: 'ready' },
    })
    expect(harness.core.start).toHaveBeenCalledOnce()
    expect(harness.system.getState()).toMatchObject({ status: 'active' })
    expect(harness.tun.getState()).toMatchObject({ status: 'stopped' })
  })

  it('does not publish ready when the final system-proxy readback detects drift', async () => {
    const harness = createHarness()
    const createChromium = harness.createChromiumGeneration.getMockImplementation()!
    harness.createChromiumGeneration.mockImplementationOnce(async (mixedEndpoint) => {
      const generation = await createChromium(mixedEndpoint)
      harness.system.failNextVerification()
      return generation
    })

    await expect(harness.orchestrator.setEnabled(true)).rejects.toMatchObject({
      category: 'system-proxy',
      message: expect.stringContaining('another proxy application'),
    })
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error', hasActivated: false, effectiveRoute: { kind: 'external' },
    })
    expect(harness.store.settings).toMatchObject({ hasEverActivated: false, mixedPort: 0 })
    expect(harness.system.acquire).toHaveBeenCalledOnce()
    expect(harness.system.verifyActive).toHaveBeenCalledOnce()
    expect(harness.system.startMonitoring).not.toHaveBeenCalled()
    expect(harness.events.indexOf('chromium:create')).toBeLessThan(harness.events.indexOf('lease:verify'))
    expect(harness.system.getState()).toMatchObject({ status: 'idle' })
    expect(harness.events).not.toContain('store:activated')
  })

  it('restores TUN when the final system-proxy readback fails after the old TUN stopped', async () => {
    const harness = createHarness({ accessMode: 'tun' })
    await harness.orchestrator.setEnabled(true)
    const previous = harness.orchestrator.getState()
    harness.system.failNextVerification()

    await expect(harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'system' })
    ))).rejects.toMatchObject({ category: 'system-proxy' })

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      routeGeneration: previous.routeGeneration,
      settings: { accessMode: 'tun' },
      effectiveRoute: { kind: 'built-in-tun', mixedPort: previous.effectiveRoute.mixedPort },
      accessState: { mode: 'tun', status: 'ready' },
    })
    expect(harness.core.start).toHaveBeenCalledOnce()
    expect(harness.system.getState()).toMatchObject({ status: 'idle' })
    expect(harness.tun.getState()).toMatchObject({ status: 'ready' })
    expect(harness.tun.start).toHaveBeenCalledTimes(2)
    expect(harness.system.startMonitoring).not.toHaveBeenCalled()
  })

  it('keeps the old LAN route and lease when its replacement Chromium session fails', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const previous = harness.orchestrator.getState()
    harness.createChromiumGeneration.mockRejectedValueOnce(new Error('candidate Chromium failed'))

    await expect(harness.orchestrator.coordinateMutation('lan-changed', () => (
      harness.orchestrator.updateSettings({ lanEnabled: true })
    ))).rejects.toThrow('candidate Chromium failed')

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      routeGeneration: previous.routeGeneration,
      settings: { lanEnabled: false },
      accessState: { mode: 'system', status: 'ready' },
    })
    expect(harness.core.start).toHaveBeenCalledTimes(2)
    expect(harness.core.restoreGeneration).toHaveBeenCalledWith(1)
    expect(harness.core.disposeGeneration).toHaveBeenCalledWith(2, { force: true })
    expect(harness.system.getState()).toMatchObject({ status: 'active' })
  })

  it('keeps the old LAN route and lease when replacement core health fails', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const previous = harness.orchestrator.getState()
    harness.core.start.mockRejectedValueOnce(Object.assign(new Error('candidate core health failed'), {
      code: 'health_check',
    }))

    await expect(harness.orchestrator.coordinateMutation('lan-changed', () => (
      harness.orchestrator.updateSettings({ lanEnabled: true })
    ))).rejects.toMatchObject({ category: 'health-check' })

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready', routeGeneration: previous.routeGeneration,
      settings: { lanEnabled: false },
      effectiveRoute: { kind: 'built-in-mixed', mixedPort: previous.effectiveRoute.mixedPort },
      accessState: { mode: 'system', status: 'ready' },
    })
    expect(harness.core.restoreGeneration).toHaveBeenCalledWith(1)
    expect(harness.system.getState()).toMatchObject({ status: 'active' })
    expect(harness.system.release).not.toHaveBeenCalled()
  })

  it('persists port zero selection and keeps the actual port across access-only switches', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const actualPort = harness.store.settings.mixedPort
    expect(actualPort).toBe(17_890)

    await harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))
    await harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'system' })
    ))

    expect(harness.core.start).toHaveBeenCalledOnce()
    expect(harness.core.start).toHaveBeenCalledWith(expect.objectContaining({ mixedPort: 0 }))
    expect(harness.core.disposeGeneration).not.toHaveBeenCalledWith(1, { force: true })
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      settings: { accessMode: 'system', mixedPort: actualPort },
      effectiveRoute: { kind: 'built-in-mixed', mixedPort: actualPort },
      accessState: { mode: 'system', status: 'ready' },
    })
  })

  it('does not resurrect a newly committed TUN route when it crashes during a failed metadata write', async () => {
    const harness = createHarness({ accessMode: 'tun' })
    let markStarted!: () => void
    let releaseMark!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseMark = resolve })
    vi.spyOn(harness.store, 'markBuiltInProxyActivated').mockImplementationOnce(async () => {
      markStarted()
      await gate
      throw new Error('metadata write failed')
    })

    const enabling = harness.orchestrator.setEnabled(true)
    await started
    expect(harness.routes.getSnapshot()).toMatchObject({ status: 'ready', effectiveRoute: { kind: 'built-in-tun' } })
    harness.tun.crash()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error', effectiveRoute: { kind: 'blocked' }, error: { category: 'tun-elevation' },
    })
    releaseMark()
    await enabling
    await vi.waitFor(() => expect(harness.tun.getState()).toMatchObject({ status: 'stopped' }))

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'error', effectiveRoute: { kind: 'blocked' }, accessState: { status: 'error' },
    })
    expect(harness.options.logger.error).toHaveBeenCalledWith(
      '[built-in-proxy] Could not persist the activated mixed endpoint',
      expect.objectContaining({ message: 'metadata write failed' }),
    )
  })

  it('never resurrects a TUN route whose active sidecar died during a switch to system', async () => {
    const harness = createHarness({ accessMode: 'tun' })
    await harness.orchestrator.setEnabled(true)
    let releaseChromium!: (value: Awaited<ReturnType<typeof harness.createChromiumGeneration>>) => void
    harness.createChromiumGeneration.mockImplementationOnce(() => new Promise((resolve) => {
      releaseChromium = resolve
    }))

    const switching = harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'system' })
    ))
    await vi.waitFor(() => expect(harness.createChromiumGeneration).toHaveBeenCalledTimes(2))
    harness.tun.crash()
    expect(harness.routes.getSnapshot()).toMatchObject({ status: 'error', effectiveRoute: { kind: 'blocked' } })
    releaseChromium({
      mixedEndpoint: 'http://127.0.0.1:17890',
      fetchImplementation: vi.fn(async () => new Response('candidate')) as unknown as typeof fetch,
      refresh: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    })

    await expect(switching).rejects.toMatchObject({ category: 'tun-elevation' })
    await vi.waitFor(() => expect(harness.tun.getState()).toMatchObject({ status: 'stopped' }))
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'error',
      settings: { accessMode: 'tun' },
      effectiveRoute: { kind: 'blocked' },
      accessState: { status: 'error' },
    })
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

  it('passes the global visual rule override into each generated rule-mode configuration', async () => {
    const harness = createHarness()
    const customRules = {
      rules: [{ id: 'private', condition: 'private-network' as const, values: [], action: 'direct' as const }],
      finalAction: 'proxy' as const,
    }
    await harness.orchestrator.updateSettings({ customRules })
    await harness.orchestrator.setEnabled(true)

    expect(harness.options.buildConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'rule',
      customRules,
    }))
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

  it('preserves timeout and non-timeout latency failure classifications', async () => {
    const timeoutHarness = createHarness()
    await timeoutHarness.orchestrator.setEnabled(true)
    timeoutHarness.core.testLatency.mockRejectedValue(Object.assign(new Error('probe timed out'), {
      code: 'controller_timeout',
    }))

    const timedOutNodes = await timeoutHarness.orchestrator.testLatency('profile-one', ['node-one'])
    expect(timedOutNodes[0]).toMatchObject({ latencyStatus: 'timeout', lastTestedAt: 50 })

    const errorHarness = createHarness()
    await errorHarness.orchestrator.setEnabled(true)
    errorHarness.core.testLatency.mockRejectedValue(new Error('controller refused request'))

    const failedNodes = await errorHarness.orchestrator.testLatency('profile-one', ['node-one'])
    expect(failedNodes[0]).toMatchObject({ latencyStatus: 'error', lastTestedAt: 50 })
  })

  it('bounds batch latency work, preserves node order, and isolates individual failures', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const profile = harness.store.profiles[0]
    profile.nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `node-${index}`,
      name: `Node ${index}`,
      type: 'socks' as const,
      groupIds: ['group-one'],
      latencyStatus: 'untested' as const,
    }))
    profile.nodeCount = profile.nodes.length
    profile.activeNodeId = profile.nodes[0].id

    const indexes = new Map(profile.nodes.map((node, index) => [outboundTagForNodeId(node.id), index]))
    let active = 0
    let peakActive = 0
    let completed = 0
    harness.core.testLatency.mockImplementation(async (proxyName: string) => {
      const index = indexes.get(proxyName)
      if (index === undefined) throw new Error(`unexpected proxy ${proxyName}`)
      active += 1
      peakActive = Math.max(peakActive, active)
      try {
        // Stagger completion order so the returned profile order cannot be an
        // accidental reflection of controller response order.
        await new Promise((resolve) => setTimeout(resolve, 3 + ((9 - index) % 3)))
        if (index === 2) {
          throw Object.assign(new Error('probe timed out'), { code: 'controller_timeout' })
        }
        if (index === 7) throw new Error('controller refused request')
        return { proxyName, delayMs: 20 + index, testedAt: 100 + index }
      } finally {
        active -= 1
        completed += 1
      }
    })

    const nodes = await harness.orchestrator.testLatency('profile-one')

    expect(peakActive).toBe(4)
    expect(completed).toBe(10)
    expect(nodes.map((node) => node.id)).toEqual(profile.nodes.map((node) => node.id))
    expect(nodes[2]).toMatchObject({ latencyStatus: 'timeout', lastTestedAt: 50 })
    expect(nodes[7]).toMatchObject({ latencyStatus: 'error', lastTestedAt: 50 })
    expect(nodes[9]).toMatchObject({ latencyStatus: 'available', latencyMs: 29, lastTestedAt: 109 })

    // A failed member must not reject the batch or leave the serialized
    // orchestrator operation queue stuck behind unfinished workers.
    await expect(harness.orchestrator.testLatency('profile-one', ['node-0'])).resolves.toHaveLength(10)
    expect(completed).toBe(11)
  })

  it('writes first-activation metadata only after the verified route is atomically ready', async () => {
    const harness = createHarness()
    const persistActivation = harness.store.markBuiltInProxyActivated.bind(harness.store)
    const markActivated = vi.spyOn(harness.store, 'markBuiltInProxyActivated')
      .mockImplementation(async (mixedPort, activatedAt) => {
        expect(harness.routes.getSnapshot()).toMatchObject({
          status: 'ready',
          effectiveRoute: { kind: 'built-in-mixed', mixedPort },
        })
        expect(harness.system.getState()).toMatchObject({
          status: 'active',
          target: { mixed: { host: '127.0.0.1', port: mixedPort } },
        })
        return persistActivation(mixedPort, activatedAt)
      })

    await harness.orchestrator.setEnabled(true)

    expect(markActivated).toHaveBeenCalledOnce()
    expect(harness.store.settings).toMatchObject({
      hasEverActivated: true,
      mixedPort: 17_890,
      lastActivatedAt: 50,
    })
  })

  it('does not mark first activation when the final system-proxy readback detects drift', async () => {
    const harness = createHarness()
    const markActivated = vi.spyOn(harness.store, 'markBuiltInProxyActivated')
    // The lease is prepared first; verifyActive performs a non-mutating native
    // readback after Chromium preparation and immediately before publication.
    harness.system.failNextVerification()

    await expect(harness.orchestrator.setEnabled(true)).rejects.toMatchObject({ category: 'system-proxy' })

    expect(markActivated).not.toHaveBeenCalled()
    expect(harness.store.settings).toMatchObject({
      hasEverActivated: false,
      mixedPort: 0,
    })
    expect(harness.store.settings.lastActivatedAt).toBeUndefined()
    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'error',
      effectiveRoute: { kind: 'external' },
    })
  })

  it('does not mark first activation when atomic route publication itself fails', async () => {
    const harness = createHarness()
    const markActivated = vi.spyOn(harness.store, 'markBuiltInProxyActivated')
    vi.spyOn(harness.routes, 'activate').mockImplementationOnce(() => {
      throw new Error('route publication failed')
    })

    await expect(harness.orchestrator.setEnabled(true)).rejects.toThrow('route publication failed')

    expect(markActivated).not.toHaveBeenCalled()
    expect(harness.store.settings.hasEverActivated).toBe(false)
    expect(harness.store.settings.lastActivatedAt).toBeUndefined()
    expect(harness.routes.getSnapshot().effectiveRoute.kind).toBe('external')
  })

  it('keeps an already committed healthy route when only activation metadata persistence fails', async () => {
    const harness = createHarness()
    vi.spyOn(harness.store, 'markBuiltInProxyActivated')
      .mockRejectedValueOnce(new Error('SQLite write failed'))

    await harness.orchestrator.setEnabled(true)

    expect(harness.routes.getSnapshot()).toMatchObject({
      status: 'ready',
      effectiveRoute: { kind: 'built-in-mixed', mixedPort: 17_890 },
    })
    expect(harness.system.getState()).toMatchObject({ status: 'active' })
    expect(harness.store.settings.hasEverActivated).toBe(false)
    expect(harness.options.logger.error).toHaveBeenCalledWith(
      '[built-in-proxy] Could not persist the activated mixed endpoint',
      expect.objectContaining({ message: 'SQLite write failed' }),
    )
  })

  it('stops a candidate TUN when the active system lease drifts mid-transition', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const startCandidate = harness.tun.start.getMockImplementation()!
    harness.tun.start.mockImplementationOnce(async (...args: unknown[]) => {
      const state = await startCandidate(...args)
      harness.system.drift()
      return state
    })

    await expect(harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))).rejects.toMatchObject({ category: 'system-proxy' })

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'error',
      settings: { accessMode: 'system' },
      effectiveRoute: { kind: 'blocked' },
      accessState: { status: 'error' },
    })
    await vi.waitFor(() => expect(harness.tun.getState()).toMatchObject({ status: 'stopped' }))
    expect(harness.tun.stop).toHaveBeenCalled()
    expect(harness.core.retainGeneration).toHaveBeenCalledWith(1)
  })

  it('does not let drift cleanup stop the next TUN session queued immediately after rejection', async () => {
    const harness = createHarness()
    await harness.orchestrator.setEnabled(true)
    const startCandidate = harness.tun.start.getMockImplementation()!
    harness.tun.start.mockImplementationOnce(async (...args: unknown[]) => {
      const state = await startCandidate(...args)
      harness.system.drift()
      return state
    })

    await expect(harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))).rejects.toMatchObject({ category: 'system-proxy' })

    // Deliberately do not wait for the drift cleanup before queuing the retry.
    await harness.orchestrator.coordinateMutation('access-mode-changed', () => (
      harness.orchestrator.updateSettings({ accessMode: 'tun' })
    ))

    expect(harness.tun.getState()).toMatchObject({ status: 'ready', session: { id: 'tun-2' } })
    expect(harness.tun.stop).toHaveBeenCalledOnce()
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'ready',
      settings: { accessMode: 'tun' },
      effectiveRoute: { kind: 'built-in-tun' },
      accessState: { mode: 'tun', status: 'ready' },
    })
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
  let nextGeneration = 1
  const generations = new Map<number, SingBoxRuntimeState>()
  const listeners = new Set<(event: SingBoxRuntimeEvent) => void>()
  const start = vi.fn(async (request: SingBoxStartRequest) => {
    events.push('core:start')
    lastRequest = request
    state = readyCoreState(nextGeneration, 17_889 + nextGeneration)
    nextGeneration += 1
    generations.set(state.generation, structuredClone(state))
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
    retainGeneration: vi.fn(() => undefined),
    restoreGeneration: vi.fn(async (generation: number) => {
      const restored = generations.get(generation)
      if (!restored) throw new Error(`generation ${generation} unavailable`)
      state = structuredClone(restored)
      return structuredClone(state)
    }),
    disposeGeneration: vi.fn(async (generation: number) => {
      if (state.generation !== generation) generations.delete(generation)
    }),
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
        for (const listener of listeners) listener({
          type: 'crash', state: structuredClone(state), generation: state.generation, exit: 'code 1',
        })
      },
    },
  }
}

function fakeSystemLease(events: string[]) {
  let status: 'idle' | 'active' | 'error' = 'idle'
  let target: { mixed: { host: string; port: number }; proxyUrl: string; bypassRules: string[] } | undefined
  let leaseId: string | undefined
  let nextLease = 1
  let failNextVerification = false
  const listeners = new Set<(event: import('../../src/main/proxy/built-in/system-proxy-lease').SystemProxyLeaseEvent) => void>()
  return {
    getState: vi.fn(() => ({ status, recoveryPending: false, ...(target ? { target: structuredClone(target) } : {}), ...(leaseId ? { leaseId } : {}) })),
    recoverStaleLease: vi.fn(async () => { events.push('lease:recover'); status = 'idle'; target = undefined; leaseId = undefined; return { status: 'none' as const } }),
    acquire: vi.fn(async (request: { mixed: { host: string; port: number } }) => {
      events.push('lease:acquire')
      status = 'active'
      leaseId ??= `lease-${nextLease++}`
      target = { mixed: { ...request.mixed }, proxyUrl: `http://${request.mixed.host}:${request.mixed.port}`, bypassRules: [] }
      return { status: 'active' as const, recoveryPending: false, target: structuredClone(target), leaseId }
    }),
    verifyActive: vi.fn(async (
      request: { mixed: { host: string; port: number } },
      expectedLeaseId?: string,
    ) => {
      events.push('lease:verify')
      const ownsTarget = status === 'active'
        && target?.mixed.host === request.mixed.host
        && target.mixed.port === request.mixed.port
        && (expectedLeaseId === undefined || leaseId === expectedLeaseId)
      if (failNextVerification || !ownsTarget) {
        failNextVerification = false
        status = 'error'
        throw Object.assign(
          new Error('Windows or another proxy application changed the Stone+ system-proxy lease.'),
          { code: 'apply_failed' },
        )
      }
      return { status: 'active' as const, recoveryPending: false, target: structuredClone(target), leaseId }
    }),
    startMonitoring: vi.fn(() => undefined),
    release: vi.fn(async () => { events.push('lease:release'); status = 'idle'; target = undefined; leaseId = undefined; return { status: 'restored' as const } }),
    retryRelease: vi.fn(async () => { status = 'idle'; return { status: 'restored' as const } }),
    onEvent: vi.fn((listener: (event: import('../../src/main/proxy/built-in/system-proxy-lease').SystemProxyLeaseEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    listenerCount: vi.fn(() => listeners.size),
    emitDrift: vi.fn((input: { leaseId?: string; port?: number } = {}) => {
      const eventTarget = target
        ? {
            ...structuredClone(target),
            mixed: {
              ...target.mixed,
              ...(input.port !== undefined ? { port: input.port } : {}),
            },
          }
        : input.port !== undefined
          ? {
              mixed: { host: '127.0.0.1', port: input.port },
              proxyUrl: `http://127.0.0.1:${input.port}`,
              bypassRules: [],
            }
          : undefined
      const state = {
        status: 'error' as const,
        recoveryPending: true,
        ...(eventTarget ? { target: eventTarget } : {}),
        ...(input.leaseId ?? leaseId ? { leaseId: input.leaseId ?? leaseId } : {}),
      }
      for (const listener of listeners) {
        listener({ type: 'unexpected-drift', state })
      }
    }),
    drift: vi.fn(() => {
      status = 'error'
      const state = { status, recoveryPending: true, ...(target ? { target: structuredClone(target) } : {}), ...(leaseId ? { leaseId } : {}) }
      for (const listener of listeners) listener({ type: 'unexpected-drift', state } as import('../../src/main/proxy/built-in/system-proxy-lease').SystemProxyLeaseEvent)
    }),
    failNextVerification: vi.fn(() => { failNextVerification = true }),
  } as unknown as BuiltInSystemProxyLease & Record<string, ReturnType<typeof vi.fn>>
}

function fakeTunController(events: string[]) {
  let status: 'stopped' | 'ready' | 'error' = 'stopped'
  let bypass: import('../../src/main/proxy/built-in/tun-controller').TunBypassPlan | undefined
  let session: { id: string; startedAt: number } | undefined
  let nextSession = 1
  let crashOnNextStart = false
  const listeners = new Set<(event: unknown) => void>()
  const emitCrash = () => {
    status = 'error'
    for (const listener of listeners) {
      listener({
        type: 'unexpected-exit',
        state: {
          status: 'error', desiredEnabled: true,
          ...(session ? { session: { ...session } } : {}),
          ...(bypass ? { bypass: structuredClone(bypass) } : {}),
        },
        exit: { code: 1, signal: null },
      })
    }
  }
  return {
    getState: vi.fn(() => ({ status, desiredEnabled: status === 'ready', ...(session ? { session: { ...session } } : {}), ...(bypass ? { bypass: structuredClone(bypass) } : {}) })),
    start: vi.fn(async (routing: import('../../src/main/proxy/built-in/tun-controller').TunRoutingContext) => {
      events.push('tun:start')
      status = 'ready'
      session = { id: `tun-${nextSession++}`, startedAt: 1 }
      bypass = {
        excludedCidrs: ['127.0.0.0/8'],
        excludedProcessIds: [routing.singBoxProcessId],
        excludedEndpoints: [
          { role: 'mixed', ...routing.mixed },
          { role: 'controller', ...routing.controller },
        ],
      }
      if (crashOnNextStart) {
        crashOnNextStart = false
        emitCrash()
      }
      return { status: 'ready' as const, desiredEnabled: true, session: { ...session }, bypass: structuredClone(bypass) }
    }),
    retryStart: vi.fn(async () => ({ status: 'ready' as const, desiredEnabled: true })),
    stop: vi.fn(async () => { events.push('tun:stop'); status = 'stopped'; bypass = undefined; session = undefined; return { status: 'stopped' as const, desiredEnabled: false } }),
    retryStop: vi.fn(async () => ({ status: 'stopped' as const, desiredEnabled: false })),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    crash: vi.fn(emitCrash),
    crashOnNextStart: vi.fn(() => { crashOnNextStart = true }),
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

function readyCoreState(generation = 1, mixedPort = 17890): SingBoxRuntimeState {
  return {
    revision: 1,
    generation,
    desiredEnabled: true,
    status: 'ready',
    version: '1.13.14',
    pid: 1234,
    mixedPort,
    mixedEndpoint: `http://127.0.0.1:${mixedPort}`,
    controllerPort: 19_089 + generation,
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
