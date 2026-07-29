import { describe, expect, it, vi } from 'vitest'
import {
  GROK_OAUTH_BASE_URL,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_TOKEN_URL,
  parseGrokOAuthImport,
  refreshGrokOAuthCredential,
  resolveGrokOAuthCredential,
  serializeGrokOAuthCredential,
} from '../../src/main/auth'

function jwt(claims: Record<string, unknown>): string {
  return ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.')
}

function exportJson(overrides: Record<string, unknown> = {}): string {
  const expiresAt = Date.now() + 3_600_000
  return JSON.stringify({
    type: 'sub2api-data', version: 1,
    accounts: [{
      type: 'oauth', platform: 'grok', name: 'grok@example.test', concurrency: 1, priority: 1,
      credentials: {
        access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', team_id: 'team-1', client_id: GROK_OAUTH_CLIENT_ID, exp: Math.floor(expiresAt / 1000) }),
        refresh_token: 'refresh-fake', id_token: jwt({ email: 'grok@example.test' }), token_type: 'Bearer',
        client_id: GROK_OAUTH_CLIENT_ID, scope: 'openid offline_access grok-cli:access api:access',
        expires_at: new Date(expiresAt).toISOString(), base_url: GROK_OAUTH_BASE_URL,
        ...overrides,
      },
    }],
  })
}

describe('Grok OAuth account import', () => {
  it('parses the Sub2API Grok OAuth shape without accepting other account platforms', () => {
    const parsed = parseGrokOAuthImport(exportJson())
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]).toMatchObject({
      name: 'grok@example.test', concurrency: 1, priority: 1,
      bundle: { subjectId: 'subject-1', teamId: 'team-1', email: 'grok@example.test', baseUrl: GROK_OAUTH_BASE_URL },
    })
  })

  it('rejects an imported base URL that could exfiltrate the bearer token', () => {
    expect(() => parseGrokOAuthImport(exportJson({ base_url: 'https://attacker.example/v1' })))
      .toThrow('trusted Grok CLI endpoint')
  })

  it('accepts Sub2API expires_at values expressed as Unix seconds', () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3_600
    const parsed = parseGrokOAuthImport(exportJson({
      expires_at: expiresAtSeconds,
      refresh_token: undefined,
    }))

    expect(parsed.accounts[0].bundle.expiresAt).toBe(expiresAtSeconds * 1000)
  })

  it('refreshes only through the fixed xAI token endpoint and preserves rotated tokens', async () => {
    const current = parseGrokOAuthImport(exportJson()).accounts[0].bundle
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(GROK_OAUTH_TOKEN_URL)
      expect(init?.redirect).toBe('error')
      expect(String(init?.body)).toContain(`client_id=${encodeURIComponent(GROK_OAUTH_CLIENT_ID)}`)
      return new Response(JSON.stringify({
        access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-rotated', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const refreshed = await refreshGrokOAuthCredential(current, fetchImplementation as typeof fetch)
    expect(refreshed.refreshToken).toBe('refresh-rotated')
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('classifies a rejected refresh token as a revoked credential', async () => {
    const current = parseGrokOAuthImport(exportJson()).accounts[0].bundle
    await expect(refreshGrokOAuthCredential(
      current,
      vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch,
    )).rejects.toMatchObject({ name: 'GrokOAuthCredentialError', code: 'revoked' })
  })

  it('does not cancel a shared refresh when one waiter is aborted', async () => {
    const current = {
      ...parseGrokOAuthImport(exportJson()).accounts[0].bundle,
      expiresAt: Date.now() + 1_000,
    }
    const serialized = serializeGrokOAuthCredential(current)
    let completeFetch!: (response: Response) => void
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false)
      return new Promise<Response>((resolve) => { completeFetch = resolve })
    })
    const persistRotated = vi.fn(async () => undefined)
    const controller = new AbortController()
    const cancelled = resolveGrokOAuthCredential(
      serialized,
      persistRotated,
      fetchImplementation as typeof fetch,
      Date.now(),
      { refreshKey: 'cancelled-waiter', signal: controller.signal },
    )
    const surviving = resolveGrokOAuthCredential(
      serialized,
      persistRotated,
      fetchImplementation as typeof fetch,
      Date.now(),
      { refreshKey: 'cancelled-waiter' },
    )

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    completeFetch(new Response(JSON.stringify({
      access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'refresh-after-cancel', expires_in: 3600,
    }), { status: 200 }))

    await expect(surviving).resolves.toMatchObject({ bundle: { refreshToken: 'refresh-after-cancel' } })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(persistRotated).toHaveBeenCalledOnce()
  })

  it('reuses a recent result for a late request carrying the pre-rotation credential', async () => {
    const current = {
      ...parseGrokOAuthImport(exportJson()).accounts[0].bundle,
      expiresAt: Date.now() + 1_000,
    }
    const serialized = serializeGrokOAuthCredential(current)
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'refresh-rotated-once', expires_in: 3600,
    }), { status: 200 }))
    const persistRotated = vi.fn(async () => undefined)
    const options = { refreshKey: 'late-stale-credential' }

    const first = await resolveGrokOAuthCredential(
      serialized, persistRotated, fetchImplementation as typeof fetch, Date.now(), options,
    )
    const late = await resolveGrokOAuthCredential(
      serialized, persistRotated, fetchImplementation as typeof fetch, Date.now(), options,
    )

    expect(late).toEqual(first)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(persistRotated).toHaveBeenCalledOnce()
  })

  it('force-refreshes a healthy token while preserving singleflight', async () => {
    const current = parseGrokOAuthImport(exportJson()).accounts[0].bundle
    const serialized = serializeGrokOAuthCredential(current)
    let completeFetch!: (response: Response) => void
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => { completeFetch = resolve }))
    const persistRotated = vi.fn(async () => undefined)
    const options = { refreshKey: 'forced-refresh', forceRefresh: true }
    const first = resolveGrokOAuthCredential(
      serialized, persistRotated, fetchImplementation as typeof fetch, Date.now(), options,
    )
    const second = resolveGrokOAuthCredential(
      serialized, persistRotated, fetchImplementation as typeof fetch, Date.now(), options,
    )

    completeFetch(new Response(JSON.stringify({
      access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'refresh-forced', expires_in: 3600,
    }), { status: 200 }))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(persistRotated).toHaveBeenCalledOnce()
  })

  it('does not join a refresh flight created from a different source credential', async () => {
    const firstBundle = {
      ...parseGrokOAuthImport(exportJson()).accounts[0].bundle,
      accessToken: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', nonce: 'first' }),
      refreshToken: 'refresh-first',
      expiresAt: Date.now() - 1,
    }
    const secondBundle = {
      ...firstBundle,
      accessToken: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', nonce: 'second' }),
      refreshToken: 'refresh-second',
    }
    const pending: Array<(response: Response) => void> = []
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)))
    const persistRotated = vi.fn(async () => undefined)
    const options = { refreshKey: 'same-local-account' }

    const first = resolveGrokOAuthCredential(
      serializeGrokOAuthCredential(firstBundle), persistRotated,
      fetchImplementation as typeof fetch, Date.now(), options,
    )
    const second = resolveGrokOAuthCredential(
      serializeGrokOAuthCredential(secondBundle), persistRotated,
      fetchImplementation as typeof fetch, Date.now(), options,
    )

    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2))
    pending[0](new Response(JSON.stringify({
      access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', nonce: 'first-result' }),
      expires_in: 3600,
    }), { status: 200 }))
    pending[1](new Response(JSON.stringify({
      access_token: jwt({ iss: 'https://auth.x.ai', sub: 'subject-1', nonce: 'second-result' }),
      expires_in: 3600,
    }), { status: 200 }))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.bundle.accessToken).not.toBe(secondResult.bundle.accessToken)
    expect(persistRotated).toHaveBeenCalledTimes(2)
  })

  it('cancels an oversized chunked token response before buffering the full body', async () => {
    const current = parseGrokOAuthImport(exportJson()).accounts[0].bundle
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024))
      },
      cancel() { cancelled = true },
    })

    await expect(refreshGrokOAuthCredential(
      current,
      vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch,
    )).rejects.toThrow(/too large/i)
    expect(cancelled).toBe(true)
  })
})
