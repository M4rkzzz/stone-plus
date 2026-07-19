import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizationUrl,
  ChatGptOAuthFlowManager,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_ISSUER,
  CHATGPT_OAUTH_SCOPE,
} from '../../src/main/auth/chatgpt-oauth-flow'

const managers: ChatGptOAuthFlowManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

describe('ChatGPT OAuth PKCE flow', () => {
  it('builds the Codex authorization request with the exact public PKCE parameters', () => {
    const url = new URL(buildAuthorizationUrl({
      issuer: 'https://auth.openai.com',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirectUri: 'http://localhost:1455/auth/callback',
      codeChallenge: 'pkce-challenge',
      state: 'opaque-state',
    }))

    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: CHATGPT_OAUTH_SCOPE,
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'opaque-state',
      originator: 'codex_cli_rs',
    })
  })

  it('keeps verifier and tokens in the manager while exchanging a manual callback', async () => {
    const now = 1_800_000_000_000
    const manager = new ChatGptOAuthFlowManager({
      issuer: 'https://auth.openai.com',
      ports: [0],
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, size),
    })
    managers.push(manager)
    const started = await manager.start()
    const authorization = new URL(started.authorizationUrl)
    const state = authorization.searchParams.get('state') ?? ''
    const verifier = Buffer.alloc(64, 64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    expect(state).toBe(Buffer.alloc(32, 32).toString('base64url'))
    expect(authorization.searchParams.get('code_challenge')).toBe(challenge)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const accessToken = jwt({ exp: Math.floor(now / 1000) + 3600 })
    const idToken = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-oauth-team' },
      'https://api.openai.com/profile': { email: 'oauth@example.com' },
    })
    const exchange = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${CHATGPT_OAUTH_ISSUER}/oauth/token`)
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
      expect(new Headers(init?.headers).get('user-agent')).toBeNull()
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('authorization-code')
      expect(body.get('redirect_uri')).toBe(started.redirectUri)
      expect(body.get('client_id')).toBe(CHATGPT_OAUTH_CLIENT_ID)
      expect(body.get('code_verifier')).toBe(verifier)
      expect(body.has('client_secret')).toBe(false)
      return new Response(JSON.stringify({
        access_token: accessToken,
        refresh_token: 'refresh-token-private',
        id_token: idToken,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    manager.submitCallback(started.sessionId, `${started.redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`)
    const bundle = await manager.wait(started.sessionId, exchange)

    expect(bundle).toMatchObject({
      accessToken,
      refreshToken: 'refresh-token-private',
      idToken,
      accountId: 'acct-oauth-team',
      email: 'oauth@example.com',
      expiresAt: now + 3_600_000,
    })
    expect(JSON.stringify(started)).not.toContain(accessToken)
    expect(JSON.stringify(started)).not.toContain('refresh-token-private')
    expect(exchange).toHaveBeenCalledOnce()
  })

  it('rejects callbacks from the wrong origin even when their state matches', async () => {
    const manager = new ChatGptOAuthFlowManager({ ports: [0] })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''

    expect(() => manager.submitCallback(
      started.sessionId,
      `https://attacker.invalid/auth/callback?code=stolen&state=${encodeURIComponent(state)}`,
    )).toThrow(/OAuth 回调地址/)
  })

  it('rejects a mismatched state before contacting the token endpoint', async () => {
    const now = 1_800_000_000_000
    const manager = new ChatGptOAuthFlowManager({ ports: [0], now: () => now })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''

    expect(() => manager.submitCallback(
      started.sessionId,
      `${started.redirectUri}?code=code&state=wrong-state`,
    )).toThrow('state 校验失败')

    const exchange = successfulExchange(now)
    manager.submitCallback(
      started.sessionId,
      `${started.redirectUri}?code=valid-after-mismatch&state=${encodeURIComponent(state)}`,
    )
    await expect(manager.wait(started.sessionId, exchange)).resolves.toMatchObject({
      accountId: 'acct-loopback',
    })
  })

  it('accepts the relative loopback callback and returns no-store HTML without echoing secrets', async () => {
    const now = 1_800_000_000_000
    const manager = new ChatGptOAuthFlowManager({ ports: [0], now: () => now })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
    const code = 'loopback-authorization-code-secret'
    const exchange = successfulExchange(now)
    const waiting = manager.wait(started.sessionId, exchange)

    const response = await fetch(
      `${started.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const nonce = html.match(/<script nonce="([^"]+)">/)?.[1]
    expect(nonce).toBeTruthy()
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`)
    expect(response.headers.get('content-security-policy')).toContain(`style-src 'nonce-${nonce}'`)
    expect(html).toContain("history.replaceState(null,'','/success')")
    expect(html).toContain('OAuth 授权已接收')
    expect(html).not.toContain(code)
    expect(html).not.toContain(state)
    await expect(waiting).resolves.toMatchObject({ accountId: 'acct-loopback' })
  })

  it('cancels through the loopback endpoint and rejects an attached waiter', async () => {
    const manager = new ChatGptOAuthFlowManager({ ports: [0] })
    managers.push(manager)
    const started = await manager.start()
    const exchange = vi.fn(async () => new Response('{}')) as typeof fetch
    const waiting = manager.wait(started.sessionId, exchange)
    void waiting.catch(() => undefined)

    const response = await fetch(new URL('/cancel', started.redirectUri))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('OAuth 授权已取消')
    await expect(waiting).rejects.toThrow('OAuth 授权已取消。')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('expires a session before accepting its callback', async () => {
    let now = 1_800_000_000_000
    const manager = new ChatGptOAuthFlowManager({
      ports: [0],
      now: () => now,
      sessionTtlMs: 60_000,
    })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
    now = started.expiresAt

    expect(() => manager.submitCallback(
      started.sessionId,
      `${started.redirectUri}?code=expired-code-secret&state=${encodeURIComponent(state)}`,
    )).toThrow('OAuth 授权会话已过期，请重新开始。')
  })

  it('redacts callback error details from loopback HTML and waiter errors', async () => {
    const manager = new ChatGptOAuthFlowManager({ ports: [0] })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
    const description = 'refresh-token-inside-error-description'
    const callbackCode = 'callback-code-that-must-not-leak'
    const exchange = vi.fn(async () => new Response('{}')) as typeof fetch
    const waiting = manager.wait(started.sessionId, exchange)
    void waiting.catch(() => undefined)

    const response = await fetch(
      `${started.redirectUri}?error=access_denied&error_description=${encodeURIComponent(description)}`
      + `&code=${encodeURIComponent(callbackCode)}&state=${encodeURIComponent(state)}`,
    )
    const html = await response.text()

    expect(response.status).toBe(400)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain("history.replaceState(null,'','/error')")
    expect(html).toContain('OpenAI OAuth 授权已取消或被拒绝。')
    expect(html).not.toContain(description)
    expect(html).not.toContain(callbackCode)
    expect(html).not.toContain(state)
    await expect(waiting).rejects.toThrow('OpenAI OAuth 授权已取消或被拒绝。')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('maps malformed and oversized successful token responses to one fixed redacted error', async () => {
    const now = 1_800_000_000_000
    const secret = 'token-response-body-secret'
    const responseFactories = [
      () => new Response(`{"access_token":"${secret}",`, { status: 200 }),
      () => new Response(JSON.stringify({ access_token: `${secret}-${'x'.repeat(300 * 1024)}` }), { status: 200 }),
    ]

    for (const [index, responseFactory] of responseFactories.entries()) {
      const manager = new ChatGptOAuthFlowManager({ ports: [0], now: () => now })
      managers.push(manager)
      const started = await manager.start()
      const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
      manager.submitCallback(
        started.sessionId,
        `${started.redirectUri}?code=redacted-response-${index}&state=${encodeURIComponent(state)}`,
      )

      let exchangeError: unknown
      try {
        await manager.wait(started.sessionId, vi.fn(async () => responseFactory()) as typeof fetch)
      } catch (error) {
        exchangeError = error
      }
      expect(exchangeError).toBeInstanceOf(Error)
      expect((exchangeError as Error).message).toBe('OpenAI OAuth Token 响应格式无效。')
      expect((exchangeError as Error).message).not.toContain(secret)
    }
  })

  it('maps token endpoint failures and timeouts to messages that omit upstream secrets', async () => {
    const now = 1_800_000_000_000
    const manager = new ChatGptOAuthFlowManager({ ports: [0], now: () => now })
    managers.push(manager)
    const started = await manager.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
    const upstreamSecret = 'upstream-refresh-token-secret'
    const exchange = vi.fn(async () => new Response(JSON.stringify({
      error: 'server_error',
      error_description: upstreamSecret,
    }), { status: 500 })) as typeof fetch

    manager.submitCallback(
      started.sessionId,
      `${started.redirectUri}?code=exchange-code-secret&state=${encodeURIComponent(state)}`,
    )
    let exchangeError: unknown
    try {
      await manager.wait(started.sessionId, exchange)
    } catch (error) {
      exchangeError = error
    }
    expect(exchangeError).toBeInstanceOf(Error)
    expect((exchangeError as Error).message).toBe('OpenAI OAuth 服务暂时不可用。')
    expect((exchangeError as Error).message).not.toContain(upstreamSecret)

    const timeoutManager = new ChatGptOAuthFlowManager({ ports: [0], now: () => now, tokenTimeoutMs: 1_000 })
    managers.push(timeoutManager)
    const timeoutStarted = await timeoutManager.start()
    const timeoutState = new URL(timeoutStarted.authorizationUrl).searchParams.get('state') ?? ''
    const timeoutCode = 'timeout-code-secret'
    const timeoutExchange = vi.fn(async () => {
      throw new DOMException(`request timed out while sending ${timeoutCode}`, 'TimeoutError')
    }) as typeof fetch
    timeoutManager.submitCallback(
      timeoutStarted.sessionId,
      `${timeoutStarted.redirectUri}?code=${timeoutCode}&state=${encodeURIComponent(timeoutState)}`,
    )

    let timeoutError: unknown
    try {
      await timeoutManager.wait(timeoutStarted.sessionId, timeoutExchange)
    } catch (error) {
      timeoutError = error
    }
    expect(timeoutError).toBeInstanceOf(Error)
    expect((timeoutError as Error).message).toBe('OAuth Token 交换超时。')
    expect((timeoutError as Error).message).not.toContain(timeoutCode)
  })
})

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function successfulExchange(now: number): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({
    access_token: jwt({ exp: Math.floor(now / 1000) + 3600 }),
    refresh_token: 'refresh-loopback',
    id_token: jwt({
      email: 'loopback@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-loopback' },
    }),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
}
