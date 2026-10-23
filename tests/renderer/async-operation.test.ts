import { describe, expect, it, vi } from 'vitest'
import {
  BoundAsyncOperation,
  ExclusiveAsyncOperation,
  redactSensitiveText,
  SerializedAsyncOperation,
  SingleFlightAsyncOperation,
  StartOrderedAsyncValue,
} from '../../src/renderer/src/async-operation'
import { providerProbeDraftBinding } from '../../src/renderer/src/provider-probe-binding'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('renderer async operation interleavings', () => {
  it('keeps a pushed managed-instance event when an older refresh completes later', async () => {
    const refresh = deferred<string[]>()
    const applied: string[][] = []
    const updates = new StartOrderedAsyncValue<string[]>((value) => applied.push(value))

    const pendingRefresh = updates.run(() => refresh.promise)
    updates.push(['event-new'])
    refresh.resolve(['refresh-old'])

    await pendingRefresh
    expect(applied).toEqual([['event-new']])
  })

  it('publishes a later managed-instance event when the refresh completes first', async () => {
    const refresh = deferred<string[]>()
    const applied: string[][] = []
    const updates = new StartOrderedAsyncValue<string[]>((value) => applied.push(value))

    const pendingRefresh = updates.run(() => refresh.promise)
    refresh.resolve(['refresh-first'])
    await pendingRefresh
    updates.push(['event-later'])

    expect(applied).toEqual([['refresh-first'], ['event-later']])
  })

  it('rejects a same-tick route toggle while save is in flight', async () => {
    const save = deferred<'saved'>()
    const operations = new ExclusiveAsyncOperation()
    const pendingSave = operations.run(() => save.promise)
    const toggle = await operations.run(async () => 'toggled' as const)

    expect(toggle).toEqual({ started: false })
    expect(operations.busy).toBe(true)
    save.resolve('saved')
    await expect(pendingSave).resolves.toEqual({ started: true, value: 'saved' })
    expect(operations.busy).toBe(false)
  })

  it('rejects a same-tick route save while toggle is in flight', async () => {
    const toggle = deferred<'toggled'>()
    const operations = new ExclusiveAsyncOperation()
    const pendingToggle = operations.run(() => toggle.promise)
    const save = await operations.run(async () => 'saved' as const)

    expect(save).toEqual({ started: false })
    toggle.resolve('toggled')
    await expect(pendingToggle).resolves.toEqual({ started: true, value: 'toggled' })
  })

  it('applies only the newest provider probe when the newest request completes first', async () => {
    const older = deferred<string>()
    const newer = deferred<string>()
    const operation = new BoundAsyncOperation()
    const currentBinding = 'provider-b'

    const olderResult = operation.run('provider-a', () => currentBinding, () => older.promise)
    const newerResult = operation.run('provider-b', () => currentBinding, () => newer.promise)
    newer.resolve('new result')
    older.resolve('old result')

    await expect(newerResult).resolves.toMatchObject({ status: 'applied', value: 'new result' })
    await expect(olderResult).resolves.toMatchObject({ status: 'stale' })
  })

  it('applies only the newest provider probe when the oldest request completes first', async () => {
    const older = deferred<string>()
    const newer = deferred<string>()
    const operation = new BoundAsyncOperation()
    const currentBinding = 'provider-b'

    const olderResult = operation.run('provider-a', () => currentBinding, () => older.promise)
    const newerResult = operation.run('provider-b', () => currentBinding, () => newer.promise)
    older.resolve('old result')
    await expect(olderResult).resolves.toMatchObject({ status: 'stale' })
    newer.resolve('new result')

    await expect(newerResult).resolves.toMatchObject({ status: 'applied', value: 'new result' })
  })

  it('drops a probe result after its provider modal is cancelled and reopened', async () => {
    const probe = deferred<string>()
    const operation = new BoundAsyncOperation()
    const draft = {
      id: 'provider-a',
      sourceType: 'relay' as const,
      kind: 'openai-compatible' as const,
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-responses' as const,
      responsesCompactMode: 'auto' as const,
      credential: 'test-secret',
      proxyId: '',
      defaultModel: 'gpt-test',
    }
    const oldBinding = providerProbeDraftBinding(draft, 1)
    let currentBinding = oldBinding
    const result = operation.run(oldBinding, () => currentBinding, () => probe.promise)

    currentBinding = providerProbeDraftBinding({ ...draft, id: 'provider-b' }, 2)
    operation.invalidate()
    probe.resolve('provider-a result')

    await expect(result).resolves.toMatchObject({ status: 'stale' })
  })

  it('drops telemetry and latency failures after the built-in runtime changes', async () => {
    const telemetry = deferred<string>()
    const operation = new BoundAsyncOperation()
    let revision = 8
    const result = operation.run('runtime:8', () => `runtime:${revision}`, () => telemetry.promise)

    revision = 9
    operation.invalidate()
    telemetry.reject(new Error('old mixed endpoint failed'))

    await expect(result).resolves.toMatchObject({ status: 'stale' })
  })

  it('persists setup-wizard progress strictly in click order', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const calls: string[] = []
    const operations = new SerializedAsyncOperation()
    const firstResult = operations.enqueue(async () => {
      calls.push('first:start')
      const value = await first.promise
      calls.push('first:end')
      return value
    })
    const secondResult = operations.enqueue(async () => {
      calls.push('second:start')
      const value = await second.promise
      calls.push('second:end')
      return value
    })

    await Promise.resolve()
    expect(calls).toEqual(['first:start'])
    first.resolve('first saved')
    await firstResult
    await Promise.resolve()
    expect(calls).toEqual(['first:start', 'first:end', 'second:start'])
    second.resolve('second saved')

    await expect(secondResult).resolves.toBe('second saved')
    expect(calls).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('continues the setup-wizard queue after a failed persistence call', async () => {
    const operations = new SerializedAsyncOperation()
    const failed = operations.enqueue(async () => { throw new Error('first failed') })
    const next = vi.fn(async () => 'second saved')
    const recovered = operations.enqueue(next)

    await expect(failed).rejects.toThrow('first failed')
    await expect(recovered).resolves.toBe('second saved')
    expect(next).toHaveBeenCalledOnce()
  })

  it('shares a slow telemetry request between automatic and manual refreshes', async () => {
    const request = deferred<string>()
    const operation = vi.fn(() => request.promise)
    const flight = new SingleFlightAsyncOperation()

    const automatic = flight.run(operation)
    const manual = flight.run(operation)
    await Promise.resolve()

    expect(operation).toHaveBeenCalledOnce()
    expect(flight.busy).toBe(true)
    request.resolve('telemetry')
    await expect(Promise.all([automatic, manual])).resolves.toEqual(['telemetry', 'telemetry'])
    expect(flight.busy).toBe(false)
  })

  it('reopens telemetry single-flight after a shared failure', async () => {
    const failedRequest = deferred<string>()
    const operation = vi.fn(() => failedRequest.promise)
    const flight = new SingleFlightAsyncOperation()
    const automatic = flight.run(operation)
    const manual = flight.run(operation)
    await Promise.resolve()

    failedRequest.reject(new Error('controller timeout'))
    await expect(automatic).rejects.toThrow('controller timeout')
    await expect(manual).rejects.toThrow('controller timeout')
    expect(flight.busy).toBe(false)

    await expect(flight.run(async () => 'recovered')).resolves.toBe('recovered')
    expect(flight.busy).toBe(false)
  })

  it('redacts every entered secret from localized backup errors', () => {
    const rendered = redactSensitiveText(
      'WebDAV rejected p@ss-word; portable password p@ss-word and token abc123 leaked',
      ['p@ss-word', 'abc123'],
    )

    expect(rendered).toBe('WebDAV rejected ••••; portable password •••• and token •••• leaked')
    expect(rendered).not.toContain('p@ss-word')
    expect(rendered).not.toContain('abc123')
  })
})
