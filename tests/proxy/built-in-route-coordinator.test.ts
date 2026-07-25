import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BuiltInProxyRouteCoordinator,
  BuiltInProxyRouteUnavailableError
} from '../../src/main/proxy/built-in/route-coordinator'
import { OutboundTransportManager } from '../../src/main/proxy/transport'
import type { PublicProxyDefinition } from '../../src/shared/types'

const coordinators = new Set<BuiltInProxyRouteCoordinator>()
const managers = new Set<OutboundTransportManager>()

afterEach(async () => {
  await Promise.allSettled([...managers].map((manager) => manager.close()))
  await Promise.allSettled([...coordinators].map((coordinator) => coordinator.close({ force: true })))
  managers.clear()
  coordinators.clear()
})

describe('BuiltInProxyRouteCoordinator', () => {
  it('keeps the external priority route until the dedicated mixed session is ready', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator({ externalMode: 'system' }))
    const externalFetch = fetchSpy('external')
    const mixedFetch = fetchSpy('mixed')
    const loopbackFetch = fetchSpy('loopback')
    const routed = coordinator.bind(externalFetch, loopbackFetch)

    coordinator.requestEnable()
    expect(coordinator.getSnapshot()).toMatchObject({
      desiredEnabled: true,
      status: 'starting',
      effectiveRoute: { generation: 0, kind: 'external', externalMode: 'system' }
    })
    expect(await (await routed('https://api.example/before-ready')).text()).toBe('external')

    coordinator.activate({
      fetchImplementation: mixedFetch,
      mixedEndpoint: 'http://127.0.0.1:19090',
      profileId: 'profile-1',
      nodeId: 'node-1'
    })
    expect(await (await routed('https://api.example/after-ready')).text()).toBe('mixed')
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      hasActivated: true,
      effectiveRoute: {
        generation: 1,
        kind: 'built-in-mixed',
        profileId: 'profile-1',
        nodeId: 'node-1',
        mixedPort: 19090
      }
    })
    expect(externalFetch).toHaveBeenCalledTimes(1)
    expect(mixedFetch).toHaveBeenCalledTimes(1)
  })

  it('captures one generation per request and drains it only after its response body completes', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    let resolveFirst!: (response: Response) => void
    const firstFetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFirst = resolve })) as unknown as typeof fetch
    const secondFetch = fetchSpy('second generation')
    const disposeFirst = vi.fn(async () => undefined)
    const routed = coordinator.bind(fetchSpy('external'), fetchSpy('loopback'))

    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: firstFetch,
      mixedEndpoint: 'http://127.0.0.1:19091',
      dispose: disposeFirst
    })
    const oldRequest = routed('https://api.example/old')

    coordinator.activate({
      fetchImplementation: secondFetch,
      mixedEndpoint: 'http://127.0.0.1:19092'
    })
    const newResponse = await routed('https://api.example/new')
    expect(await newResponse.text()).toBe('second generation')
    expect(coordinator.getSnapshot().effectiveRoute.generation).toBe(2)
    expect(disposeFirst).not.toHaveBeenCalled()

    resolveFirst(new Response('first generation'))
    const oldResponse = await oldRequest
    await Promise.resolve()
    expect(disposeFirst).not.toHaveBeenCalled()
    expect(await oldResponse.text()).toBe('first generation')
    await coordinator.drainRetired()

    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(secondFetch).toHaveBeenCalledTimes(1)
    expect(disposeFirst).toHaveBeenCalledTimes(1)
  })

  it('forces retirement after the drain grace when a response body is abandoned', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator({
      retirementDrainTimeoutMs: 10,
      disposalTimeoutMs: 20,
    }))
    const dispose = vi.fn(async () => undefined)
    const routed = coordinator.bind(fetchSpy('external'), fetchSpy('loopback'))
    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: vi.fn(async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch,
      mixedEndpoint: 'http://127.0.0.1:19110',
      dispose,
    })

    const abandoned = await routed('https://api.example/abandoned')
    coordinator.activate({
      fetchImplementation: fetchSpy('replacement'),
      mixedEndpoint: 'http://127.0.0.1:19111',
    })
    await coordinator.drainRetired()

    expect(dispose).toHaveBeenCalledOnce()
    await abandoned.body?.cancel()
  })

  it('bounds a generation disposer that never settles', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator({ disposalTimeoutMs: 10 }))
    const dispose = vi.fn(() => new Promise<void>(() => undefined))
    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: fetchSpy('first'),
      mixedEndpoint: 'http://127.0.0.1:19112',
      dispose,
    })
    coordinator.activate({
      fetchImplementation: fetchSpy('replacement'),
      mixedEndpoint: 'http://127.0.0.1:19113',
    })

    await coordinator.drainRetired()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('fails closed immediately after a core crash without consulting any external route', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    const externalFetch = fetchSpy('external leak')
    const mixedFetch = fetchSpy('mixed')
    const loopbackFetch = fetchSpy('loopback')
    const routed = coordinator.bind(externalFetch, loopbackFetch)

    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: mixedFetch,
      mixedEndpoint: 'http://127.0.0.1:19093'
    })
    coordinator.failClosed({
      category: 'core-crashed',
      message: 'sing-box exited unexpectedly',
      retryable: true
    })

    await expect(routed('https://api.example/must-not-leak')).rejects.toMatchObject({
      name: 'BuiltInProxyRouteUnavailableError',
      code: 'BUILT_IN_PROXY_FAIL_CLOSED',
      category: 'core-crashed',
      routeGeneration: 2
    } satisfies Partial<BuiltInProxyRouteUnavailableError>)
    expect(externalFetch).not.toHaveBeenCalled()
    expect(mixedFetch).not.toHaveBeenCalled()

    // Gateway, mixed and controller loopback calls are control-plane traffic
    // and remain direct even while internet traffic is blocked.
    expect(await (await routed('http://127.0.0.1:19093/health')).text()).toBe('loopback')
    expect(loopbackFetch).toHaveBeenCalledTimes(1)
  })

  it('normalizes underscore-form runtime error categories at the route boundary', () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    coordinator.failClosed({
      category: 'core_crashed' as never,
      message: 'core exited',
      retryable: true,
    })
    expect(coordinator.getSnapshot().error?.category).toBe('core-crashed')
  })

  it('does not restore external routing until disable restoration commits', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator({ externalMode: 'system' }))
    const externalFetch = fetchSpy('external')
    const mixedFetch = fetchSpy('mixed')
    const routed = coordinator.bind(externalFetch, fetchSpy('loopback'))

    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: mixedFetch,
      mixedEndpoint: 'http://127.0.0.1:19094'
    })
    coordinator.beginDisable()
    expect(await (await routed('https://api.example/while-restoring')).text()).toBe('mixed')

    coordinator.disableFailed({
      category: 'system-proxy',
      message: 'comparison restore failed',
      retryable: true
    })
    expect(await (await routed('https://api.example/after-restore-error')).text()).toBe('mixed')
    expect(externalFetch).not.toHaveBeenCalled()

    coordinator.completeDisable()
    expect(await (await routed('https://api.example/restored')).text()).toBe('external')
    expect(coordinator.getSnapshot()).toMatchObject({
      desiredEnabled: false,
      status: 'disabled',
      effectiveRoute: { kind: 'external', externalMode: 'system' }
    })
  })

  it('rejects non-loopback mixed endpoints before publishing a route', () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    coordinator.requestEnable()

    expect(() => coordinator.activate({
      fetchImplementation: fetchSpy('mixed'),
      mixedEndpoint: 'http://192.0.2.1:1080'
    })).toThrow('loopback HTTP address')
    expect(coordinator.getSnapshot().effectiveRoute.kind).toBe('external')
  })

  it('releases generation-owned loopback ports when the generation is replaced or disabled', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator({ directLoopbackPorts: [15721] }))
    const routed = coordinator.bind(fetchSpy('external'), fetchSpy('loopback'))

    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: fetchSpy('first'),
      mixedEndpoint: 'http://127.0.0.1:19101',
      directLoopbackPorts: [19102],
    })
    expect(await (await routed('http://127.0.0.1:19102/control')).text()).toBe('loopback')

    coordinator.activate({
      fetchImplementation: fetchSpy('second'),
      mixedEndpoint: 'http://127.0.0.1:19103',
      directLoopbackPorts: [19104],
    })
    expect(await (await routed('http://127.0.0.1:19102/control')).text()).toBe('second')
    expect(await (await routed('http://127.0.0.1:19104/control')).text()).toBe('loopback')

    coordinator.beginDisable()
    coordinator.completeDisable()
    expect(await (await routed('http://127.0.0.1:19104/control')).text()).toBe('external')
    expect(await (await routed('http://127.0.0.1:15721/control')).text()).toBe('loopback')
  })
})

describe('OutboundTransportManager built-in integration', () => {
  it('overrides an already-cached explicit proxy dispatcher and its credential requirement', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    const manager = trackManager(new OutboundTransportManager({ builtInRouteCoordinator: coordinator }))
    const proxy = proxyDefinition({ hasPassword: true })

    // Seed the legacy explicit-proxy generation. No request is made through it.
    manager.fetchFor(proxy, 'old secret')
    const mixedFetch = fetchSpy('forced through mixed')
    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: mixedFetch,
      mixedEndpoint: 'http://127.0.0.1:19095'
    })

    const cachedFacade = manager.fetchForCached(proxy)
    expect(cachedFacade).toBeTypeOf('function')
    expect(await (await cachedFacade!('https://api.example/cached')).text()).toBe('forced through mixed')
    // The paused explicit binding must not require a vault read while mixed is ready.
    expect(await (await manager.fetchFor(proxy)('https://api.example/no-password')).text()).toBe('forced through mixed')
    expect(mixedFetch).toHaveBeenCalledTimes(2)

    coordinator.failClosed({ category: 'core-crashed', message: 'crashed', retryable: true })
    await expect(cachedFacade!('https://api.example/no-fallback')).rejects.toMatchObject({
      code: 'BUILT_IN_PROXY_FAIL_CLOSED'
    })
  })

  it('rebuilds only sing-box/Chromium and prewarms all concurrent enabled targets', async () => {
    const coordinator = trackCoordinator(new BuiltInProxyRouteCoordinator())
    const reloadSystemProxy = vi.fn(async () => undefined)
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      reloadSystemProxy,
      builtInRouteCoordinator: coordinator
    }))
    const mixedFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const refresh = vi.fn(async () => undefined)
    coordinator.requestEnable()
    coordinator.activate({
      fetchImplementation: mixedFetch,
      mixedEndpoint: 'http://127.0.0.1:19096',
      refresh
    })

    const first = manager.rebuild(undefined, undefined, ['https://one.example/v1'])
    const second = manager.rebuild(proxyDefinition(), undefined, ['https://two.example/v1'])
    await Promise.all([first, second])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(new Set(refresh.mock.calls[0][0])).toEqual(new Set([
      'https://one.example/',
      'https://two.example/'
    ]))
    expect(new Set(mixedFetch.mock.calls.map(([input]) => String(input)))).toEqual(new Set([
      'https://one.example/',
      'https://two.example/'
    ]))
    expect(reloadSystemProxy).not.toHaveBeenCalled()

    coordinator.beginDisable()
    coordinator.completeDisable()
    expect(coordinator.getSnapshot().effectiveRoute.externalMode).toBe('system')
  })
})

function fetchSpy(body: string): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(body)) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

function proxyDefinition(overrides: Partial<PublicProxyDefinition> = {}): PublicProxyDefinition {
  return {
    id: 'explicit-proxy',
    name: 'Explicit proxy',
    protocol: 'http',
    host: '127.0.0.1',
    port: 3128,
    hasPassword: false,
    status: 'unchecked',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function trackCoordinator(coordinator: BuiltInProxyRouteCoordinator): BuiltInProxyRouteCoordinator {
  coordinators.add(coordinator)
  return coordinator
}

function trackManager(manager: OutboundTransportManager): OutboundTransportManager {
  managers.add(manager)
  return manager
}
