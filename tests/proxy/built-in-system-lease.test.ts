import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSystemProxyLeaseRecoveryStore,
  type SystemProxySnapshot
} from '../../src/main/proxy/built-in/lease-recovery'
import {
  SystemProxyLease,
  SystemProxyLeaseError,
  type NormalizedSystemProxyLeaseTarget,
  type SystemProxyCompareResult,
  type SystemProxyPlatformAdapter
} from '../../src/main/proxy/built-in/system-proxy-lease'

const temporaryDirectories: string[] = []

afterEach(async () => {
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
})

class FakeSystemProxyAdapter implements SystemProxyPlatformAdapter {
  public current: SystemProxySnapshot
  public restoreFailures = 0
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
    this.current = clone(snapshot)
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    if (this.restoreFailures > 0) {
      this.restoreFailures -= 1
      throw new Error('simulated native restore failure')
    }
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
