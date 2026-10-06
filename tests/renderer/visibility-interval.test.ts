import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startVisibilityAwareInterval,
  type VisibilityIntervalEnvironment,
} from '../../src/renderer/src/visibility-interval'

function environment() {
  let visible = true
  const listeners = new Set<() => void>()
  const value: VisibilityIntervalEnvironment = {
    isVisible: () => visible,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onVisibilityChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    value,
    setVisible(next: boolean) {
      visible = next
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('visibility-aware recurring work', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops waking while hidden and refreshes immediately when visible again', async () => {
    vi.useFakeTimers()
    const target = environment()
    const callback = vi.fn()
    const dispose = startVisibilityAwareInterval(callback, 1_000, {
      environment: target.value,
      runImmediately: true,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(callback).toHaveBeenCalledTimes(2)

    target.setVisible(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(callback).toHaveBeenCalledTimes(2)

    target.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(3)
    dispose()
    expect(target.listenerCount()).toBe(0)
  })

  it('never overlaps a slow asynchronous callback', async () => {
    vi.useFakeTimers()
    const target = environment()
    let release!: () => void
    const callback = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const dispose = startVisibilityAwareInterval(callback, 100, {
      environment: target.value,
      runImmediately: true,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(callback).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(99)
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(2)
    dispose()
  })
})
