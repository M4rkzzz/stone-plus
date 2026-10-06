import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewaySettings } from '../../src/shared/types'
import {
  LatestAutosaveScheduler,
  SETTINGS_AUTOSAVE_DELAY_MS,
  validateGatewayDraft,
} from '../../src/renderer/src/settings-autosave'

function settings(patch: Partial<GatewaySettings> = {}): GatewaySettings {
  return {
    host: '127.0.0.1',
    port: 15720,
    autoStart: true,
    logPayloads: false,
    requestTimeoutSeconds: 120,
    backupRetention: 10,
    ...patch,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('gateway settings validation', () => {
  it('accepts every loopback host and numeric boundary', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(validateGatewayDraft(settings({
        host,
        port: 1024,
        requestTimeoutSeconds: 5,
        backupRetention: 1,
      }), 'zh-CN')).toEqual({})
      expect(validateGatewayDraft(settings({
        host,
        port: 65535,
        requestTimeoutSeconds: 600,
        backupRetention: 100,
      }), 'en')).toEqual({})
    }
  })

  it('rejects unsafe, non-integer, and out-of-range values in both languages', () => {
    const invalid = settings({
      host: '0.0.0.0',
      port: Number.NaN,
      requestTimeoutSeconds: 5.5,
      backupRetention: 101,
    })

    expect(validateGatewayDraft(invalid, 'zh-CN')).toEqual({
      host: '本地网关仅允许监听回环地址',
      port: '端口范围为 1024–65535',
      timeout: '超时范围为 5–600 秒',
      backupRetention: '备份保留数量范围为 1–100',
    })
    expect(validateGatewayDraft(invalid, 'en')).toEqual({
      host: 'The local gateway can only listen on a loopback address',
      port: 'Port must be between 1024 and 65535',
      timeout: 'Timeout must be between 5 and 600 seconds',
      backupRetention: 'Backup retention must be between 1 and 100',
    })
  })
})

describe('LatestAutosaveScheduler', () => {
  it('debounces edits and persists only the latest value', async () => {
    vi.useFakeTimers()
    const persist = vi.fn(async (value: string) => `${value}-saved`)
    const onSuccess = vi.fn()
    const scheduler = new LatestAutosaveScheduler({ persist, onSuccess })

    scheduler.schedule('first')
    await vi.advanceTimersByTimeAsync(100)
    scheduler.schedule('latest')
    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS - 1)
    expect(persist).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await scheduler.flush()
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith('latest')
    expect(onSuccess).toHaveBeenCalledWith('latest-saved', 'latest')
  })

  it('serializes an in-flight save and never publishes its stale completion', async () => {
    vi.useFakeTimers()
    let finishFirst!: (value: string) => void
    const persist = vi.fn((value: string) => value === 'first'
      ? new Promise<string>((resolve) => { finishFirst = resolve })
      : Promise.resolve(`${value}-saved`))
    const onSuccess = vi.fn()
    const scheduler = new LatestAutosaveScheduler({ persist, onSuccess })

    scheduler.schedule('first', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(persist).toHaveBeenCalledWith('first')

    scheduler.schedule('second', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(persist).toHaveBeenCalledOnce()

    finishFirst('first-saved')
    await scheduler.flush()
    expect(persist.mock.calls.map(([value]) => value)).toEqual(['first', 'second'])
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onSuccess).toHaveBeenCalledWith('second-saved', 'second')
  })

  it('skips superseded queued values and continues after an older rejection', async () => {
    vi.useFakeTimers()
    let rejectFirst!: (error: Error) => void
    const persist = vi.fn((value: string) => value === 'first'
      ? new Promise<string>((_resolve, reject) => { rejectFirst = reject })
      : Promise.resolve(`${value}-saved`))
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const scheduler = new LatestAutosaveScheduler({ persist, onSuccess, onError })

    scheduler.schedule('first', 0)
    await vi.advanceTimersByTimeAsync(0)
    scheduler.schedule('second', 0)
    scheduler.schedule('latest', 0)
    await vi.advanceTimersByTimeAsync(0)

    rejectFirst(new Error('temporary failure'))
    await scheduler.flush()
    expect(persist.mock.calls.map(([value]) => value)).toEqual(['first', 'latest'])
    expect(onError).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledWith('latest-saved', 'latest')
  })

  it('reports a current failure and accepts a later retry', async () => {
    vi.useFakeTimers()
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('retry-saved')
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const scheduler = new LatestAutosaveScheduler<string, string>({ persist, onSuccess, onError })

    scheduler.schedule('failed', 0)
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.flush()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][1]).toBe('failed')

    scheduler.schedule('retry', 0)
    await vi.advanceTimersByTimeAsync(0)
    await scheduler.flush()
    expect(persist.mock.calls.map(([value]) => value)).toEqual(['failed', 'retry'])
    expect(onSuccess).toHaveBeenCalledWith('retry-saved', 'retry')
  })

  it('flushes a pending edit immediately and invalidation prevents persistence', async () => {
    vi.useFakeTimers()
    const persist = vi.fn(async (value: string) => value)
    const scheduler = new LatestAutosaveScheduler({ persist })

    scheduler.schedule('leaving-page')
    await scheduler.flush()
    expect(persist).toHaveBeenCalledWith('leaving-page')

    scheduler.schedule('invalid-now')
    scheduler.invalidate()
    await vi.runAllTimersAsync()
    await scheduler.flush()
    expect(persist).toHaveBeenCalledOnce()
  })
})
