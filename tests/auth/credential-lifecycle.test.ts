import { describe, expect, it, vi } from 'vitest'
import {
  CredentialLifecycleResolver,
  CredentialResolutionError,
  RefreshAdapterError,
  type RefreshAdapter,
  type RenewableBearerCredentialRecord,
  type SecretReader
} from '../../src/main/auth'

const now = 1_700_000_000_000

function bearerRecord(overrides: Partial<RenewableBearerCredentialRecord> = {}): RenewableBearerCredentialRecord {
  return {
    id: 'credential-1',
    type: 'renewable-bearer',
    accessTokenRef: 'access-ref',
    refreshTokenRef: 'refresh-ref',
    refreshAdapterId: 'oauth-adapter',
    expiresAt: now + 30_000,
    scopes: ['models.read'],
    ...overrides
  }
}

function secretReader(secrets: Record<string, string>): SecretReader {
  return {
    readSecret: vi.fn(async (reference: string) => secrets[reference])
  }
}

describe('credential lifecycle resolver', () => {
  it('resolves API keys without exposing them in metadata or JSON', async () => {
    const apiKey = 'sk-super-private-api-key'
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'api-ref': apiKey }),
      now: () => now
    })

    const resolved = await resolver.resolve({
      id: 'api-credential',
      type: 'api-key',
      secretRef: 'api-ref'
    })

    expect(resolved.getSecret()).toBe(apiKey)
    expect(resolved.toJSON()).toEqual({ credentialId: 'api-credential', type: 'api-key' })
    expect(JSON.stringify(resolved)).not.toContain(apiKey)
    expect(Object.keys(resolved)).not.toContain(apiKey)
  })

  it('rejects whitespace-only decrypted secrets', async () => {
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'api-ref': '   ' }),
      now: () => now
    })
    await expect(resolver.resolve({
      id: 'api-credential',
      type: 'api-key',
      secretRef: 'api-ref'
    })).rejects.toMatchObject({ code: 'secret_unavailable' })
  })

  it('uses a bearer token outside the proactive expiry skew without refreshing', async () => {
    const reader = secretReader({ 'access-ref': 'access-current' })
    const refresh = vi.fn()
    const resolver = new CredentialLifecycleResolver({
      secretReader: reader,
      refreshAdapters: { 'oauth-adapter': { refresh } },
      expirySkewMs: 60_000,
      now: () => now
    })

    const resolved = await resolver.resolve(bearerRecord({ expiresAt: now + 61_000 }))

    expect(resolved.getSecret()).toBe('access-current')
    expect(resolved.expiresAt).toBe(now + 61_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(reader.readSecret).toHaveBeenCalledWith('access-ref', undefined)
  })

  it('proactively refreshes inside the skew and refreshes an already expired token', async () => {
    const refresh = vi.fn(async () => ({ accessToken: 'access-refreshed', expiresInSeconds: 3600 }))
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'access-ref': 'access-old', 'refresh-ref': 'refresh-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      expirySkewMs: 60_000,
      now: () => now
    })

    const withinSkew = await resolver.resolve(bearerRecord({ id: 'within-skew', expiresAt: now + 60_000 }))
    const expired = await resolver.resolve(bearerRecord({ id: 'expired', expiresAt: now - 1 }))

    expect(withinSkew.getSecret()).toBe('access-refreshed')
    expect(expired.getSecret()).toBe('access-refreshed')
    expect(withinSkew.expiresAt).toBe(now + 3_600_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent refreshes to one adapter call per credential', async () => {
    const gate = deferred<{ accessToken: string; expiresInSeconds: number }>()
    const refresh = vi.fn(() => gate.promise)
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      now: () => now
    })
    const record = bearerRecord({ expiresAt: now - 1 })

    const resolutions = Array.from({ length: 20 }, () => resolver.resolve(record))
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    gate.resolve({ accessToken: 'access-shared', expiresInSeconds: 600 })
    const resolved = await Promise.all(resolutions)

    expect(new Set(resolved.map((credential) => credential.getSecret()))).toEqual(new Set(['access-shared']))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('persists refresh-token rotation and uses the rotated token on the next refresh', async () => {
    let clock = now
    const refresh = vi.fn<RefreshAdapter['refresh']>()
      .mockResolvedValueOnce({
        accessToken: 'access-first',
        refreshToken: 'refresh-rotated',
        expiresInSeconds: 120
      })
      .mockResolvedValueOnce({ accessToken: 'access-second', expiresInSeconds: 120 })
    const onRotation = vi.fn(async () => undefined)
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-original' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      onRefreshTokenRotation: onRotation,
      expirySkewMs: 60_000,
      now: () => clock
    })
    const record = bearerRecord({ expiresAt: now - 1 })

    const first = await resolver.resolve(record)
    clock = first.expiresAt! - 59_000
    const second = await resolver.resolve(record)

    expect(second.getSecret()).toBe('access-second')
    expect(onRotation).toHaveBeenCalledWith({
      credentialId: 'credential-1',
      previousRefreshTokenRef: 'refresh-ref',
      refreshToken: 'refresh-rotated'
    }, expect.any(AbortSignal))
    expect(refresh.mock.calls[1][0].refreshToken).toBe('refresh-rotated')
  })

  it('lets one concurrent waiter cancel without aborting the shared refresh', async () => {
    const gate = deferred<{ accessToken: string; expiresInSeconds: number }>()
    const refresh = vi.fn(({ signal }: { signal: AbortSignal }) => abortable(gate.promise, signal))
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      now: () => now
    })
    const controller = new AbortController()

    const cancelled = resolver.resolve(bearerRecord({ expiresAt: now - 1 }), { signal: controller.signal })
    const surviving = resolver.resolve(bearerRecord({ expiresAt: now - 1 }))
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    controller.abort()
    gate.resolve({ accessToken: 'access-survives', expiresInSeconds: 600 })

    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    await expect(surviving.then((credential) => credential.getSecret())).resolves.toBe('access-survives')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('aborts the adapter when every concurrent waiter cancels', async () => {
    const refresh = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      now: () => now
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = resolver.resolve(bearerRecord({ expiresAt: now - 1 }), { signal: firstController.signal })
    const second = resolver.resolve(bearerRecord({ expiresAt: now - 1 }), { signal: secondController.signal })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    firstController.abort()
    secondController.abort()

    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    expect(refresh.mock.calls[0][0].signal.aborted).toBe(true)
  })

  it('supports invalidating and cancelling an in-flight credential refresh', async () => {
    const refresh = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      now: () => now
    })

    const resolution = resolver.resolve(bearerRecord({ expiresAt: now - 1 }))
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    resolver.invalidate('credential-1')

    await expect(resolution).rejects.toMatchObject({ code: 'cancelled' })
    expect(refresh.mock.calls[0][0].signal.aborted).toBe(true)
  })

  it.each([
    [new RefreshAdapterError('invalid_grant'), 'invalid_grant'],
    [new RefreshAdapterError('revoked'), 'revoked'],
    [Object.assign(new Error('unauthorized'), { statusCode: 401 }), 'revoked']
  ])('classifies terminal refresh failures without exposing upstream details', async (failure, code) => {
    const secret = 'refresh-do-not-leak'
    const refresh = vi.fn(async () => {
      throw failure
    })
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': secret }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      now: () => now
    })

    const error = await resolver.resolve(bearerRecord({ expiresAt: now - 1 })).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CredentialResolutionError)
    expect(error).toMatchObject({ code, retryable: false })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain('unauthorized')
  })

  it('redacts arbitrary adapter failures and marks transient failures retryable', async () => {
    const accessToken = 'access-do-not-leak'
    const refreshToken = 'refresh-do-not-leak'
    const adapterMessage = `provider echoed ${accessToken} and ${refreshToken}`
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': refreshToken }),
      refreshAdapters: {
        'oauth-adapter': {
          refresh: async () => {
            throw Object.assign(new Error(adapterMessage), { statusCode: 503, responseBody: adapterMessage })
          }
        }
      },
      now: () => now
    })

    const error = await resolver.resolve(bearerRecord({ expiresAt: now - 1 })).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'refresh_failed', retryable: true })
    expect(JSON.stringify(error)).not.toContain(accessToken)
    expect(JSON.stringify(error)).not.toContain(refreshToken)
    expect(String(error)).not.toContain(adapterMessage)
  })

  it('does not cache tokens if refresh-token rotation persistence fails', async () => {
    const refresh = vi.fn(async () => ({
      accessToken: 'access-do-not-cache',
      refreshToken: 'refresh-new-private',
      expiresInSeconds: 600
    }))
    const resolver = new CredentialLifecycleResolver({
      secretReader: secretReader({ 'refresh-ref': 'refresh-old-private' }),
      refreshAdapters: { 'oauth-adapter': { refresh } },
      onRefreshTokenRotation: async () => {
        throw new Error('disk failure with refresh-new-private')
      },
      now: () => now
    })

    const first = resolver.resolve(bearerRecord({ expiresAt: now - 1 }))
    await expect(first).rejects.toMatchObject({ code: 'rotation_persistence_failed' })
    await expect(resolver.resolve(bearerRecord({ expiresAt: now - 1 })))
      .rejects.toMatchObject({ code: 'rotation_persistence_failed' })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      reject
    )
  })
}
