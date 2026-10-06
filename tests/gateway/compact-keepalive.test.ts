import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompactSseKeepalive } from '../../src/main/gateway/compact-keepalive'

afterEach(() => vi.useRealTimers())

function setup(acceptWrites = true) {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, headersSent: false,
    headers: new Map<string, unknown>(),
    getHeader(name: string) { return this.headers.get(name) },
    setHeader(name: string, value: unknown) { this.headers.set(name, value) },
    write: vi.fn((_value: string) => { response.headersSent = true; return acceptWrites }),
    destroy: vi.fn(() => { response.destroyed = true }),
  })
  const failed = vi.fn()
  const keepalive = new CompactSseKeepalive(response as unknown as ServerResponse, 10, failed)
  return { response, keepalive, failed }
}

describe('compact transport heartbeat', () => {
  it('delays the first beat, never sends semantic data and stops cleanly', () => {
    vi.useFakeTimers()
    const { response, keepalive } = setup()
    keepalive.start(() => response.setHeader('x-codex-turn-state', 'bound'))
    vi.advanceTimersByTime(9)
    expect(response.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(21)
    expect(response.write.mock.calls.every(([value]) => value === ': keepalive\n\n')).toBe(true)
    expect(keepalive.committed).toBe(true)
    expect(keepalive.locksSource).toBe(true)
    keepalive.stop()
    vi.advanceTimersByTime(100)
    expect(response.write).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not queue more beats under backpressure and destroys a stuck downstream', () => {
    vi.useFakeTimers()
    const { response, keepalive, failed } = setup(false)
    keepalive.start(() => {})
    vi.advanceTimersByTime(10_010)
    expect(response.write).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(response.listenerCount('drain')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes pending drain timers when stopped', () => {
    vi.useFakeTimers()
    const { response, keepalive, failed } = setup(false)
    keepalive.start(() => {})
    vi.advanceTimersByTime(10)
    keepalive.stop()
    vi.advanceTimersByTime(20_000)
    expect(failed).not.toHaveBeenCalled()
    expect(response.listenerCount('drain')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resumes only after drain and stops when the response has ended', () => {
    vi.useFakeTimers()
    const { response, keepalive } = setup(false)
    keepalive.start(() => {})
    vi.advanceTimersByTime(100)
    expect(response.write).toHaveBeenCalledTimes(1)
    response.emit('drain')
    vi.advanceTimersByTime(10)
    expect(response.write).toHaveBeenCalledTimes(2)
    response.writableEnded = true
    vi.advanceTimersByTime(10)
    expect(vi.getTimerCount()).toBe(0)
  })
})
