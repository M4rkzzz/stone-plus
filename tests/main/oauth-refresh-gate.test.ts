import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOAuthRefreshRequest } from '../../src/main/auth/oauth-refresh-gate'

describe('OAuth refresh provider gate', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spaces waiters released into separate concurrency slots', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
    const startedAt: number[] = []
    const operation = async (): Promise<Response> => {
      startedAt.push(Date.now())
      return new Response('{}', { status: 200 })
    }

    const requests = [
      runOAuthRefreshRequest('openai', undefined, operation),
      runOAuthRefreshRequest('openai', undefined, operation),
      runOAuthRefreshRequest('openai', undefined, operation),
    ]
    await vi.advanceTimersByTimeAsync(0)
    expect(startedAt).toEqual([Date.parse('2026-08-05T12:00:00.000Z')])

    await vi.advanceTimersByTimeAsync(100)
    expect(startedAt).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(startedAt).toHaveLength(3)
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(100)
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(100)
    await Promise.all(requests)
  })

  it('does not run a queued refresh after its caller aborts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:05:00.000Z'))
    const controller = new AbortController()
    let abortedOperationStarted = false

    const first = runOAuthRefreshRequest('xai', undefined, async () => new Response('{}', { status: 200 }))
    const second = runOAuthRefreshRequest('xai', undefined, async () => new Response('{}', { status: 200 }))
    const aborted = runOAuthRefreshRequest('xai', controller.signal, async () => {
      abortedOperationStarted = true
      return new Response('{}', { status: 200 })
    })
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(abortedOperationStarted).toBe(false)
  })

  it('does not carry a completed burst backoff into a later user action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:10:00.000Z'))
    const failedBurst = [0, 1, 2].map(() => runOAuthRefreshRequest(
      'openai',
      undefined,
      async () => new Response('{}', { status: 503 }),
    ))
    await vi.runAllTimersAsync()
    await Promise.all(failedBurst)

    let started = false
    const next = runOAuthRefreshRequest('openai', undefined, async () => {
      started = true
      return new Response('{}', { status: 200 })
    })
    expect(started).toBe(true)
    await next
  })
})
