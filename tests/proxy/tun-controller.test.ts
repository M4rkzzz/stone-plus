import { describe, expect, it, vi } from 'vitest'
import {
  TunController,
  TunControllerError,
  TunElevationDeniedError,
  createTunBypassPlan,
  type TunPlatformAdapter,
  type TunPlatformSession,
  type TunRoutingContext
} from '../../src/main/proxy/built-in/tun-controller'

describe('built-in TUN controller', () => {
  it('excludes every self-routing edge from the temporary TUN', () => {
    const plan = createTunBypassPlan(routingContext())

    expect(plan.excludedCidrs).toEqual([
      '127.0.0.0/8',
      '::1/128',
      '10.55.0.0/16',
      '2001:db8:55::/48'
    ])
    expect(plan.excludedProcessIds).toEqual([44221])
    expect(plan.excludedEndpoints).toEqual([
      { role: 'local-gateway', host: '127.0.0.1', port: 15721, transport: 'tcp' },
      { role: 'mixed', host: 'localhost', port: 20800, transport: 'any' },
      { role: 'controller', host: '::1', port: 20801, transport: 'tcp' },
      { role: 'node', host: 'node-a.example', port: 443, transport: 'tcp' },
      { role: 'node', host: '203.0.113.9', port: 8443, transport: 'udp' },
      { role: 'dns', host: 'dns.example', port: 853, transport: 'tcp' },
      { role: 'dns', host: '1.1.1.1', port: 53, transport: 'udp' }
    ])
  })

  it('serializes duplicate starts and requests fresh temporary elevation after each stop', async () => {
    const adapter = new FakeTunAdapter()
    const controller = new TunController({ adapter, now: () => 9001 })
    const context = routingContext()

    const [first, duplicate] = await Promise.all([
      controller.start(context),
      controller.start(context)
    ])
    expect(first.status).toBe('ready')
    expect(duplicate.status).toBe('ready')
    expect(adapter.startTemporaryElevated).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({
      desiredEnabled: true,
      session: { id: 'temporary-1', pid: 7001, startedAt: 9001 }
    })
    expect(adapter.startTemporaryElevated).toHaveBeenCalledWith({
      bypass: expect.objectContaining({ excludedProcessIds: [44221] })
    })

    await controller.stop()
    expect(adapter.stopTemporary).toHaveBeenCalledWith({ id: 'temporary-1', pid: 7001 })
    expect(controller.getState()).toEqual({ status: 'stopped', desiredEnabled: false })

    await controller.start(context)
    expect(adapter.startTemporaryElevated).toHaveBeenCalledTimes(2)
    expect(controller.getState().session?.id).toBe('temporary-2')
  })

  it('keeps elevation refusal in an explicit error state and retries without fallback', async () => {
    const adapter = new FakeTunAdapter()
    adapter.startErrors.push(new TunElevationDeniedError())
    const controller = new TunController({ adapter })

    await expect(controller.start(routingContext())).rejects.toMatchObject({
      code: 'tun_elevation_denied',
      message: expect.stringContaining('The user declined temporary TUN elevation.'),
    })
    expect(controller.getState()).toMatchObject({
      status: 'error',
      desiredEnabled: true,
      lastError: { code: 'tun_elevation_denied' }
    })
    expect(adapter.stopTemporary).not.toHaveBeenCalled()

    await expect(controller.retryStart()).resolves.toMatchObject({ status: 'ready' })
    expect(adapter.startTemporaryElevated).toHaveBeenCalledTimes(2)
  })

  it('retries adapter-owned cleanup when startup failed before returning a session', async () => {
    const cleanupPending = vi.fn()
      .mockRejectedValueOnce(new Error('privileged child is still alive'))
      .mockResolvedValueOnce(undefined)
    const adapter: TunPlatformAdapter = {
      startTemporaryElevated: vi.fn(async () => { throw new Error('health gate failed') }),
      stopTemporary: vi.fn(async () => undefined),
      cleanupPending,
    }
    const controller = new TunController({ adapter })
    await expect(controller.start(routingContext())).rejects.toMatchObject({
      code: 'tun_start_failed',
      message: expect.stringContaining('health gate failed'),
    })

    await expect(controller.stop()).rejects.toMatchObject({ code: 'tun_stop_failed' })
    expect(controller.getState()).toMatchObject({ status: 'error', desiredEnabled: false })
    await expect(controller.retryStop()).resolves.toEqual({ status: 'stopped', desiredEnabled: false })
    expect(cleanupPending).toHaveBeenCalledTimes(2)
  })

  it('retains a failed teardown handle so stopping can be retried', async () => {
    const adapter = new FakeTunAdapter()
    const controller = new TunController({ adapter })
    await controller.start(routingContext())
    adapter.stopErrors.push(new Error('route deletion failed'))

    await expect(controller.stop()).rejects.toMatchObject({ code: 'tun_stop_failed' })
    expect(controller.getState()).toMatchObject({
      status: 'error',
      desiredEnabled: false,
      session: { id: 'temporary-1' },
      lastError: { code: 'tun_stop_failed' }
    })

    await expect(controller.retryStop()).resolves.toEqual({
      status: 'stopped',
      desiredEnabled: false
    })
    expect(adapter.stopTemporary).toHaveBeenCalledTimes(2)
  })

  it('rejects non-loopback control endpoints before invoking the elevated adapter', async () => {
    const adapter = new FakeTunAdapter()
    const controller = new TunController({ adapter })
    const context = routingContext()
    context.controller = { host: '192.0.2.10', port: 20801, transport: 'tcp' }

    await expect(controller.start(context)).rejects.toBeInstanceOf(TunControllerError)
    await expect(controller.start(context)).rejects.toMatchObject({ code: 'tun_invalid_bypass' })
    expect(adapter.startTemporaryElevated).not.toHaveBeenCalled()
  })

  it('classifies a native Windows cancellation code as elevation denial', async () => {
    const adapter = new FakeTunAdapter()
    adapter.startErrors.push(Object.assign(new Error('The operation was canceled by the user.'), {
      errno: 1223
    }))
    const controller = new TunController({ adapter })

    await expect(controller.start(routingContext())).rejects.toMatchObject({
      code: 'tun_elevation_denied'
    })
  })

  it('moves to an observable error state when a ready sidecar exits late', async () => {
    let publishExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      publishExit = resolve
    })
    const adapter: TunPlatformAdapter = {
      startTemporaryElevated: vi.fn(async () => ({ id: 'watched-sidecar', pid: 7100, exit })),
      stopTemporary: vi.fn(async () => undefined),
    }
    const controller = new TunController({ adapter })
    const listener = vi.fn()
    controller.onEvent(listener)
    await controller.start(routingContext())

    publishExit({ code: 9, signal: null })
    await vi.waitFor(() => expect(controller.getState()).toMatchObject({
      status: 'error',
      desiredEnabled: true,
      lastError: {
        code: 'tun_start_failed',
        message: expect.stringContaining('exit code 9'),
      },
    }))
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'unexpected-exit',
      exit: { code: 9, signal: null },
    }))

    await controller.stop()
    expect(adapter.stopTemporary).toHaveBeenCalledOnce()
    expect(controller.getState()).toEqual({ status: 'stopped', desiredEnabled: false })
  })

  it('ignores a retired sidecar exit after a replacement reuses the same runner ID', async () => {
    type Exit = { code: number | null; signal: NodeJS.Signals | null }
    const exits: Array<(exit: Exit) => void> = []
    const adapter: TunPlatformAdapter = {
      startTemporaryElevated: vi.fn(async () => ({
        id: 'reused-runner-id',
        pid: 7200 + exits.length,
        exit: new Promise<Exit>((resolve) => { exits.push(resolve) }),
      })),
      stopTemporary: vi.fn(async () => undefined),
    }
    const controller = new TunController({ adapter })
    const listener = vi.fn()
    controller.onEvent(listener)

    await controller.start(routingContext())
    await controller.stop()
    await controller.start(routingContext())
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      desiredEnabled: true,
      session: { id: 'reused-runner-id', pid: 7201 },
    })

    exits[0]({ code: 9, signal: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getState().status).toBe('ready')
    expect(listener).not.toHaveBeenCalled()

    exits[1]({ code: 9, signal: null })
    await vi.waitFor(() => expect(controller.getState().status).toBe('error'))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('fails closed on a broken exit monitor and still notifies after another observer throws', async () => {
    let rejectExit!: (error: Error) => void
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_resolve, reject) => {
      rejectExit = reject
    })
    const adapter: TunPlatformAdapter = {
      startTemporaryElevated: vi.fn(async () => ({ id: 'broken-monitor', pid: 7300, exit })),
      stopTemporary: vi.fn(async () => undefined),
    }
    const controller = new TunController({ adapter })
    const survivingListener = vi.fn()
    controller.onEvent(() => { throw new Error('observer failed') })
    controller.onEvent(survivingListener)
    await controller.start(routingContext())

    rejectExit(new Error('native process watcher closed'))
    await vi.waitFor(() => expect(controller.getState()).toMatchObject({
      status: 'error',
      lastError: { message: expect.stringContaining('native process watcher closed') },
    }))
    expect(survivingListener).toHaveBeenCalledOnce()
  })
})

class FakeTunAdapter implements TunPlatformAdapter {
  public readonly startErrors: unknown[] = []
  public readonly stopErrors: unknown[] = []
  private startCount = 0

  public readonly startTemporaryElevated = vi.fn(async (): Promise<TunPlatformSession> => {
    const error = this.startErrors.shift()
    if (error) throw error
    this.startCount += 1
    return { id: `temporary-${this.startCount}`, pid: 7000 + this.startCount }
  })

  public readonly stopTemporary = vi.fn(async (): Promise<void> => {
    const error = this.stopErrors.shift()
    if (error) throw error
  })
}

function routingContext(): TunRoutingContext {
  return {
    localGateway: { host: '127.0.0.1', port: 15721, transport: 'tcp' },
    mixed: { host: 'localhost', port: 20800, transport: 'any' },
    controller: { host: '[::1]', port: 20801, transport: 'tcp' },
    singBoxProcessId: 44221,
    nodeServers: [
      { host: 'NODE-A.EXAMPLE', port: 443, transport: 'tcp' },
      { host: '203.0.113.9', port: 8443, transport: 'udp' }
    ],
    dnsUpstreams: [
      { host: 'dns.example', port: 853, transport: 'tcp' },
      { host: '1.1.1.1', port: 53, transport: 'udp' }
    ],
    additionalExcludedCidrs: ['10.55.0.0/16', '2001:db8:55::/48', '127.0.0.0/8']
  }
}
