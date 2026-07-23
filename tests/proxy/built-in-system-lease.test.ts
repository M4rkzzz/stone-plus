import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileSystemProxyLeaseRecoveryStore,
  type SystemProxySnapshot
} from '../../src/main/proxy/built-in/lease-recovery'
import {
  SystemProxyLease,
  SystemProxyLeaseError,
  type SystemProxyLeaseEvent,
  type NormalizedSystemProxyLeaseTarget,
  type SystemProxyCompareResult,
  type SystemProxyPlatformAdapter
} from '../../src/main/proxy/built-in/system-proxy-lease'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('built-in system proxy lease', () => {
  it('persists the complete native snapshot before applying mixed and restores it losslessly', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: true,
      proxyServer: 'http=old.example:8080;https=secure.example:8443',
      pacUrl: 'https://pac.example/corp/path/proxy.pac?profile=full#v2',
      autoDetect: true,
      bypassRules: '<local>;localhost;*.internal.example;10.*',
      nativeFlags: { policyScope: 'user', preserveMe: 17 }
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      now: () => 1234,
      createLeaseId: () => 'lease-1'
    })

    const active = await lease.acquire({
      mixed: { host: '127.0.0.1', port: 20800 },
      additionalBypassRules: ['stone-controller.local', 'localhost']
    })

    expect(active.status).toBe('active')
    expect(adapter.current.settings).toMatchObject({
      proxyEnable: true,
      proxyServer: 'http://127.0.0.1:20800',
      pacUrl: null,
      autoDetect: false
    })
    expect(adapter.current.settings.bypassRules).toEqual([
      '<local>', 'localhost', '127.0.0.0/8', '::1', 'stone-controller.local'
    ])
    const journal = await store.load()
    expect(journal).toMatchObject({
      leaseId: 'lease-1',
      createdAt: 1234,
      mixedProxyUrl: 'http://127.0.0.1:20800'
    })
    expect(journal?.original).toEqual(original)

    await expect(lease.release()).resolves.toEqual({ status: 'restored', leaseId: 'lease-1' })
    expect(adapter.current).toEqual(original)
    await expect(store.load()).resolves.toBeUndefined()
    expect(lease.getState()).toMatchObject({ status: 'idle', recoveryPending: false })
  })

  it('uses compare-and-apply so a user change made during the lease is never overwritten', async () => {
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const lease = new SystemProxyLease({ adapter, recoveryStore: store })
    await lease.acquire({ mixed: { host: 'localhost', port: 20801 } })

    const userSettings = nativeSnapshot({
      proxyEnable: true,
      proxyServer: 'http://user-new-proxy.example:9090',
      pacUrl: 'https://new.example/manual-change.pac',
      autoDetect: false,
      bypassRules: 'user.example'
    })
    adapter.current = clone(userSettings)

    await expect(lease.release()).resolves.toMatchObject({
      status: 'preserved-user-settings'
    })
    expect(adapter.current).toEqual(userSettings)
    expect(adapter.applyCalls).toHaveLength(1)
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('reports a field-level restore that preserved user settings as partial, not fully restored', async () => {
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: 'https://original.example/proxy.pac',
      autoDetect: true,
      bypassRules: '<local>'
    }))
    const lease = new SystemProxyLease({ adapter, recoveryStore: store })
    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20805 } })
    adapter.nextRestoreResult = 'partial'

    await expect(lease.release()).resolves.toMatchObject({
      status: 'preserved-user-settings'
    })
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('repairs a crash journal before normal startup networking', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: 'https://pac.example/original.pac',
      autoDetect: true,
      bypassRules: '<local>;original.example'
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const crashedProcessLease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'crashed-lease'
    })
    await crashedProcessLease.acquire({ mixed: { host: '::1', port: 20802 } })
    expect(adapter.current.settings.proxyServer).toBe('http://[::1]:20802')

    // A fresh instance represents the next Stone+ process after an unclean exit.
    const nextProcessLease = new SystemProxyLease({ adapter, recoveryStore: store })
    await expect(nextProcessLease.recoverStaleLease()).resolves.toEqual({
      status: 'restored',
      leaseId: 'crashed-lease'
    })
    expect(adapter.current).toEqual(original)
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('retains ownership after a failed release and allows an explicit retry', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'retry-lease'
    })
    await lease.acquire({ mixed: { host: '127.9.8.7', port: 20803 } })
    adapter.restoreFailures = 1

    await expect(lease.release()).rejects.toMatchObject({ code: 'restore_failed' })
    expect(lease.getState()).toMatchObject({
      status: 'error',
      recoveryPending: true,
      leaseId: 'retry-lease'
    })
    await expect(store.load()).resolves.toMatchObject({ leaseId: 'retry-lease' })

    await expect(lease.retryRelease()).resolves.toEqual({
      status: 'restored',
      leaseId: 'retry-lease'
    })
    expect(adapter.current).toEqual(original)
  })

  it('retries idempotently when native restore succeeded but journal clearing failed', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: 'https://original.example/proxy.pac',
      autoDetect: true,
      bypassRules: '<local>'
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'clear-retry-lease'
    })
    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20806 } })
    const clear = store.clear.bind(store)
    let failClear = true
    store.clear = async () => {
      if (failClear) {
        failClear = false
        throw new Error('simulated journal clear failure')
      }
      await clear()
    }

    await expect(lease.release()).rejects.toMatchObject({ code: 'restore_failed' })
    expect(adapter.current).toEqual(original)
    await expect(store.load()).resolves.toMatchObject({ leaseId: 'clear-retry-lease' })

    await expect(lease.retryRelease()).resolves.toEqual({
      status: 'restored',
      leaseId: 'clear-retry-lease'
    })
    expect(adapter.current).toEqual(original)
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('serializes duplicate acquisition and rejects a non-loopback mixed endpoint', async () => {
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const lease = new SystemProxyLease({ adapter, recoveryStore: store })

    await Promise.all([
      lease.acquire({ mixed: { host: '127.0.0.1', port: 20804 } }),
      lease.acquire({ mixed: { host: '127.0.0.1', port: 20804 } })
    ])
    expect(adapter.applyCalls).toHaveLength(1)
    await lease.release()

    await expect(lease.acquire({ mixed: { host: '192.0.2.8', port: 20804 } }))
      .rejects.toBeInstanceOf(SystemProxyLeaseError)
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it('does not report an active lease when a successful setter did not change the native route', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const adapter = new FakeSystemProxyAdapter(original)
    adapter.ignoreApply = true
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'silent-noop-lease'
    })

    await expect(lease.acquire({ mixed: { host: '127.0.0.1', port: 20810 } }))
      .rejects.toMatchObject({
        code: 'apply_failed',
        message: expect.stringContaining('another proxy application')
      })
    expect(lease.getState()).toMatchObject({
      status: 'error',
      leaseId: 'silent-noop-lease',
      recoveryPending: true
    })
    expect(adapter.verificationCalls).toBe(1)
    await expect(store.load()).resolves.toMatchObject({ leaseId: 'silent-noop-lease' })
  })

  it('reports an immediate competing proxy rewrite and never overwrites the competing settings on cleanup', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const competing = nativeSnapshot({
      proxyEnable: true,
      proxyServer: 'http://127.0.0.1:7897',
      pacUrl: null,
      autoDetect: false,
      bypassRules: '<local>;localhost'
    })
    const adapter = new FakeSystemProxyAdapter(original)
    adapter.afterApply = () => {
      // A competing proxy manager can react to WinINet's change notification
      // before acquire() performs its mandatory native readback.
      adapter.current = clone(competing)
    }
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'competing-manager-lease'
    })

    await expect(lease.acquire({ mixed: { host: '127.0.0.1', port: 20813 } }))
      .rejects.toMatchObject({
        code: 'apply_failed',
        message: expect.stringContaining('another proxy application')
      })
    expect(lease.getState()).toMatchObject({
      status: 'error',
      leaseId: 'competing-manager-lease',
      recoveryPending: true
    })
    expect(adapter.current).toEqual(competing)

    await expect(lease.release()).resolves.toMatchObject({
      status: 'preserved-user-settings',
      leaseId: 'competing-manager-lease'
    })
    expect(adapter.current).toEqual(competing)
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('revalidates an active same-target lease instead of trusting stale in-memory ownership', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({ adapter, recoveryStore: store })
    const request = { mixed: { host: '127.0.0.1', port: 20811 } }
    await lease.acquire(request)
    expect(adapter.verificationCalls).toBe(1)

    adapter.current = clone(original)
    await expect(lease.acquire(request)).rejects.toMatchObject({ code: 'apply_failed' })
    expect(lease.getState()).toMatchObject({ status: 'error', recoveryPending: true })
    expect(adapter.verificationCalls).toBe(2)
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it('performs a non-mutating native readback for the expected lease immediately before publication', async () => {
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      createLeaseId: () => 'publication-proof-lease'
    })
    const request = { mixed: { host: '127.0.0.1', port: 20818 } }
    await lease.acquire(request)

    await expect(lease.verifyActive(request, 'publication-proof-lease')).resolves.toMatchObject({
      status: 'active',
      leaseId: 'publication-proof-lease'
    })
    expect(adapter.verificationCalls).toBe(2)
    expect(adapter.applyCalls).toHaveLength(1)

    adapter.current = clone(original)
    await expect(lease.verifyActive(request, 'publication-proof-lease')).rejects.toMatchObject({
      code: 'apply_failed',
      message: expect.stringContaining('another proxy application')
    })
    expect(lease.getState()).toMatchObject({
      status: 'error',
      leaseId: 'publication-proof-lease',
      recoveryPending: true
    })
    expect(adapter.verificationCalls).toBe(3)
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it('does not monitor or re-apply a candidate when final publication proof observes user drift', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    })
    const competing = nativeSnapshot({
      proxyEnable: true,
      proxyServer: 'http://user-selected.example:7897',
      pacUrl: null,
      autoDetect: false,
      bypassRules: 'user-selected.local'
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100,
      createLeaseId: () => 'candidate-lease'
    })
    const listener = vi.fn()
    lease.onEvent(listener)
    const request = { mixed: { host: '127.0.0.1', port: 20819 } }
    await lease.acquire(request)

    adapter.current = clone(competing)
    await vi.advanceTimersByTimeAsync(500)

    expect(adapter.verificationCalls).toBe(1)
    expect(adapter.applyCalls).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    await expect(lease.verifyActive(request, 'candidate-lease')).rejects.toMatchObject({
      code: 'apply_failed',
      message: expect.stringContaining('another proxy application')
    })
    expect(adapter.current).toEqual(competing)
    expect(adapter.applyCalls).toHaveLength(1)
    await expect(lease.release()).resolves.toMatchObject({ status: 'preserved-user-settings' })
    expect(adapter.current).toEqual(competing)
  })

  it('does not schedule polling when the platform has no native ownership readback', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const backing = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const adapter: SystemProxyPlatformAdapter = {
      captureSnapshot: () => backing.captureSnapshot(),
      createMixedProxySnapshot: (original, target) => backing.createMixedProxySnapshot(original, target),
      applySnapshot: (snapshot) => backing.applySnapshot(snapshot),
      compareAndApplySnapshot: (expected, replacement) => (
        backing.compareAndApplySnapshot(expected, replacement)
      )
    }
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100
    })

    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20820 } })
    lease.startMonitoring()
    await vi.advanceTimersByTimeAsync(500)

    expect(vi.getTimerCount()).toBe(0)
    expect(backing.verificationCalls).toBe(0)
    await lease.release()
  })

  it('detects post-ready takeover drift and preserves the competing settings on release', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const original = nativeSnapshot({
      proxyEnable: false,
      proxyServer: 'http://remembered.example:8080',
      pacUrl: 'https://original.example/private/proxy.pac?token=do-not-emit',
      autoDetect: true,
      bypassRules: '<local>'
    })
    const adapter = new FakeSystemProxyAdapter(original)
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100,
      createLeaseId: () => 'monitored-lease'
    })
    const events: SystemProxyLeaseEvent[] = []
    lease.onEvent((event) => events.push(event))
    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20812 } })
    lease.startMonitoring()

    const competing = nativeSnapshot({
      proxyEnable: false,
      proxyServer: 'http://external-manager.example:7897',
      pacUrl: null,
      autoDetect: true,
      bypassRules: 'external-manager.local'
    })
    adapter.current = clone(competing)
    await vi.advanceTimersByTimeAsync(100)

    expect(lease.getState()).toMatchObject({
      status: 'error',
      leaseId: 'monitored-lease',
      recoveryPending: true,
      lastError: {
        code: 'apply_failed',
        message: expect.stringContaining('another proxy application')
      }
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'unexpected-drift',
      state: { status: 'error', leaseId: 'monitored-lease', recoveryPending: true }
    })
    expect(JSON.stringify(events[0])).not.toContain('do-not-emit')
    expect(adapter.current).toEqual(competing)

    await expect(lease.release()).resolves.toMatchObject({ status: 'preserved-user-settings' })
    expect(adapter.current).toEqual(competing)
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it('keeps a stable active lease monitored without overlapping native reads', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100
    })
    const listener = vi.fn()
    lease.onEvent(listener)
    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20814 } })

    await vi.advanceTimersByTimeAsync(300)

    // Acquisition is also used for an uncommitted candidate. It must not arm
    // post-ready supervision until the route owner explicitly publishes it.
    expect(adapter.verificationCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    lease.startMonitoring()
    await vi.advanceTimersByTimeAsync(300)

    expect(adapter.verificationCalls).toBe(4)
    expect(adapter.maxConcurrentVerifications).toBe(1)
    expect(listener).not.toHaveBeenCalled()
    expect(lease.getState()).toMatchObject({ status: 'active', recoveryPending: true })
    await lease.release()
  })

  it('cancels active monitoring before close and emits nothing afterwards', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100
    })
    const listener = vi.fn()
    lease.onEvent(listener)
    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20815 } })
    lease.startMonitoring()
    await lease.close()

    await vi.advanceTimersByTimeAsync(500)

    expect(adapter.verificationCalls).toBe(1)
    expect(listener).not.toHaveBeenCalled()
    expect(lease.getState()).toMatchObject({ status: 'idle', recoveryPending: false })
  })

  it('ignores an old monitor callback after release was requested and a new lease is acquired', async () => {
    vi.useFakeTimers()
    const { store } = await createRecoveryStore()
    const adapter = new FakeSystemProxyAdapter(nativeSnapshot({
      proxyEnable: false,
      proxyServer: null,
      pacUrl: null,
      autoDetect: false,
      bypassRules: ''
    }))
    const lease = new SystemProxyLease({
      adapter,
      recoveryStore: store,
      activeLeaseMonitorIntervalMs: 100
    })
    const listener = vi.fn()
    lease.onEvent(listener)
    const firstRequest = { mixed: { host: '127.0.0.1', port: 20816 } }
    await lease.acquire(firstRequest)
    lease.startMonitoring()

    const gate = deferred<void>()
    adapter.verificationGate = gate.promise
    const explicitVerification = lease.acquire(firstRequest)
    await vi.waitFor(() => expect(adapter.verificationCalls).toBe(2))
    await vi.advanceTimersByTimeAsync(100)
    const release = lease.release()
    adapter.verificationGate = undefined
    gate.resolve()
    await explicitVerification
    await release

    await lease.acquire({ mixed: { host: '127.0.0.1', port: 20817 } })

    expect(adapter.verificationCalls).toBe(3)
    expect(listener).not.toHaveBeenCalled()
    expect(lease.getState()).toMatchObject({
      status: 'active',
      target: { mixed: { host: '127.0.0.1', port: 20817 } }
    })
    await lease.release()
  })
})

class FakeSystemProxyAdapter implements SystemProxyPlatformAdapter {
  public current: SystemProxySnapshot
  public restoreFailures = 0
  public nextRestoreResult?: SystemProxyCompareResult
  public ignoreApply = false
  public afterApply?: () => void
  public verificationCalls = 0
  public concurrentVerifications = 0
  public maxConcurrentVerifications = 0
  public verificationGate?: Promise<void>
  public readonly applyCalls: SystemProxySnapshot[] = []

  public constructor(initial: SystemProxySnapshot) {
    this.current = clone(initial)
  }

  public async captureSnapshot(): Promise<SystemProxySnapshot> {
    return clone(this.current)
  }

  public createMixedProxySnapshot(
    original: SystemProxySnapshot,
    target: NormalizedSystemProxyLeaseTarget
  ): SystemProxySnapshot {
    return nativeSnapshot({
      ...clone(original.settings),
      proxyEnable: true,
      proxyServer: target.proxyUrl,
      pacUrl: null,
      autoDetect: false,
      bypassRules: [...target.bypassRules]
    })
  }

  public async applySnapshot(snapshot: SystemProxySnapshot): Promise<void> {
    this.applyCalls.push(clone(snapshot))
    if (!this.ignoreApply) this.current = clone(snapshot)
    this.afterApply?.()
  }

  public async isSnapshotApplied(snapshot: SystemProxySnapshot): Promise<boolean> {
    this.verificationCalls += 1
    this.concurrentVerifications += 1
    this.maxConcurrentVerifications = Math.max(
      this.maxConcurrentVerifications,
      this.concurrentVerifications
    )
    try {
      await this.verificationGate
      return JSON.stringify(this.current) === JSON.stringify(snapshot)
    } finally {
      this.concurrentVerifications -= 1
    }
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    if (this.restoreFailures > 0) {
      this.restoreFailures -= 1
      throw new Error('simulated native restore failure')
    }
    if (this.nextRestoreResult) {
      const result = this.nextRestoreResult
      this.nextRestoreResult = undefined
      this.current = clone(replacement)
      return result
    }
    if (JSON.stringify(this.current) === JSON.stringify(replacement)) return 'applied'
    if (JSON.stringify(this.current) !== JSON.stringify(expected)) return 'mismatch'
    this.current = clone(replacement)
    return 'applied'
  }
}

function nativeSnapshot(
  settings: SystemProxySnapshot['settings']
): SystemProxySnapshot {
  return { platform: 'test-native', settings: clone(settings) }
}

async function createRecoveryStore(): Promise<{
  store: FileSystemProxyLeaseRecoveryStore
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'stone-system-proxy-lease-'))
  temporaryDirectories.push(directory)
  return {
    directory,
    store: new FileSystemProxyLeaseRecoveryStore(join(directory, 'proxy', 'lease-recovery.json'))
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
