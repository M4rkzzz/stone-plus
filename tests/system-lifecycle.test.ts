import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemLifecycleCoordinator } from '../src/main/system-lifecycle'

afterEach(() => vi.useRealTimers())

describe('SystemLifecycleCoordinator', () => {
  it('rebuilds after resume without touching in-flight requests directly', async () => {
    const rebuild = vi.fn(async () => undefined)
    const coordinator = new SystemLifecycleCoordinator({
      rebuildConnections: rebuild,
      isOnline: () => true,
      recoveryDebounceMs: 0
    })
    coordinator.onSuspend()
    coordinator.onResume()
    await coordinator.waitForIdle()
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('coalesces overlapping recovery operations and waits for the follow-up', async () => {
    const resolvers: Array<() => void> = []
    const rebuild = vi.fn(() => new Promise<void>((done) => { resolvers.push(done) }))
    const coordinator = new SystemLifecycleCoordinator({
      rebuildConnections: rebuild,
      isOnline: () => true,
      recoveryDebounceMs: 0
    })
    coordinator.onResume()
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1))
    coordinator.onResume()
    resolvers.shift()?.()
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2))
    const idle = coordinator.waitForIdle()
    resolvers.shift()?.()
    await idle
  })

  it('cancels a debounced recovery on suspend and resumes it later', async () => {
    vi.useFakeTimers()
    let now = 100
    const rebuild = vi.fn(async () => undefined)
    const coordinator = new SystemLifecycleCoordinator({
      rebuildConnections: rebuild,
      isOnline: () => true,
      now: () => now,
      recoveryDebounceMs: 500
    })
    coordinator.onResume()
    coordinator.onSuspend()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(rebuild).not.toHaveBeenCalled()
    now += 1_000
    coordinator.onResume()
    await coordinator.waitForIdle()
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('close cancels delayed work and waits for active recovery without scheduling a follow-up', async () => {
    vi.useFakeTimers()
    const delayed = vi.fn(async () => undefined)
    const delayedCoordinator = new SystemLifecycleCoordinator({
      rebuildConnections: delayed,
      isOnline: () => true,
      now: () => 0,
      recoveryDebounceMs: 500
    })
    delayedCoordinator.onResume()
    await delayedCoordinator.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(delayed).not.toHaveBeenCalled()

    let release!: () => void
    const active = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const coordinator = new SystemLifecycleCoordinator({ rebuildConnections: active, isOnline: () => true, recoveryDebounceMs: 0 })
    coordinator.onResume()
    await vi.waitFor(() => expect(active).toHaveBeenCalledTimes(1))
    coordinator.onResume()
    let closed = false
    const closing = coordinator.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await closing
    expect(active).toHaveBeenCalledTimes(1)
  })

  it('reports synchronous recovery failures without rejecting idle waiters', async () => {
    const onError = vi.fn()
    const coordinator = new SystemLifecycleCoordinator({
      rebuildConnections: () => { throw new Error('sync failure') },
      isOnline: () => true,
      recoveryDebounceMs: 0,
      onError
    })
    coordinator.onResume()
    await coordinator.waitForIdle()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync failure' }))
  })

  it('waitForIdle includes pending debounce timers', async () => {
    vi.useFakeTimers()
    const rebuild = vi.fn(async () => undefined)
    const coordinator = new SystemLifecycleCoordinator({
      rebuildConnections: rebuild,
      isOnline: () => true,
      now: () => 0,
      recoveryDebounceMs: 250
    })
    coordinator.onResume()
    let settled = false
    const idle = coordinator.waitForIdle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    await idle
    expect(rebuild).toHaveBeenCalledTimes(1)
  })
})
