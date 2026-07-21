import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { UiLanguage } from '@shared/types'
import { parseChatGptAccountImport, type ChatGptCredentialBundle } from './chatgpt-account'

export const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com'
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_OAUTH_CALLBACK_PATH = '/auth/callback'
export const CHATGPT_OAUTH_PORTS = [1455, 1457] as const
export const CHATGPT_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

const DEFAULT_SESSION_TTL_MS = 10 * 60_000
const DEFAULT_TOKEN_TIMEOUT_MS = 20_000
const DEFAULT_ORIGINATOR = 'codex_cli_rs'
const MAX_ACTIVE_SESSIONS = 4
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024

export interface ChatGptOAuthSessionStart {
  sessionId: string
  authorizationUrl: string
  redirectUri: string
  expiresAt: number
  loopbackListening: boolean
  status: 'waiting'
}

export interface ChatGptOAuthFlowOptions {
  issuer?: string
  clientId?: string
  originator?: string
  ports?: readonly number[]
  sessionTtlMs?: number
  tokenTimeoutMs?: number
  now?: () => number
  randomBytes?: (size: number) => Buffer
  openExternal?: (url: string) => Promise<unknown>
}

export interface ChatGptOAuthSessionController {
  start(language?: UiLanguage): Promise<ChatGptOAuthSessionStart>
  open(sessionId: string): Promise<void>
  submitCallback(sessionId: string, callbackUrl: string): void
  wait(sessionId: string, fetchImplementation?: typeof fetch): Promise<ChatGptCredentialBundle>
  cancel(sessionId: string): void
  dispose(): void
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
  settled: boolean
}

interface OAuthSession {
  id: string
  state: string
  codeVerifier: string
  authorizationUrl: string
  redirectUri: string
  expiresAt: number
  callback: Deferred<string>
  server?: Server
  timer?: ReturnType<typeof setTimeout>
  exchange?: Promise<ChatGptCredentialBundle>
  cancelled: boolean
  language: UiLanguage
}

/**
 * Short-lived, main-process-only Codex OAuth session manager.
 *
 * PKCE verifiers, callback codes and exchanged tokens never leave this class.
 * Only the authorization URL and opaque session id are exposed to the renderer.
 */
export class ChatGptOAuthFlowManager {
  private readonly issuer: string
  private readonly clientId: string
  private readonly originator: string
  private readonly ports: readonly number[]
  private readonly sessionTtlMs: number
  private readonly tokenTimeoutMs: number
  private readonly now: () => number
  private readonly random: (size: number) => Buffer
  private readonly openExternal?: (url: string) => Promise<unknown>
  private readonly sessions = new Map<string, OAuthSession>()

  constructor(options: ChatGptOAuthFlowOptions = {}) {
    this.issuer = normalizeIssuer(options.issuer ?? CHATGPT_OAUTH_ISSUER)
    this.clientId = requiredValue(options.clientId ?? CHATGPT_OAUTH_CLIENT_ID, 'OAuth client id')
    this.originator = requiredValue(options.originator ?? DEFAULT_ORIGINATOR, 'OAuth originator')
    this.ports = options.ports?.length ? [...options.ports] : [...CHATGPT_OAUTH_PORTS]
    this.sessionTtlMs = boundedDuration(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 60_000, 30 * 60_000)
    this.tokenTimeoutMs = boundedDuration(options.tokenTimeoutMs, DEFAULT_TOKEN_TIMEOUT_MS, 1_000, 60_000)
    this.now = options.now ?? Date.now
    this.random = options.randomBytes ?? randomBytes
    this.openExternal = options.openExternal
  }

  async start(language: UiLanguage = 'zh-CN'): Promise<ChatGptOAuthSessionStart> {
    this.pruneSessions()
    while (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined
      if (!oldest) break
      this.cancel(oldest)
    }

    const sessionId = randomUUID()
    const state = base64Url(this.random(32))
    const codeVerifier = base64Url(this.random(64))
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest())
    const callback = deferred<string>()
    // A user may close the dialog before wait() attaches. Keep rejection handled.
    void callback.promise.catch(() => undefined)

    const binding = await this.bindLoopback(sessionId, language)
    const port = binding.port ?? this.ports[0] ?? CHATGPT_OAUTH_PORTS[0]
    const redirectUri = `http://localhost:${port}${CHATGPT_OAUTH_CALLBACK_PATH}`
    const authorizationUrl = buildAuthorizationUrl({
      issuer: this.issuer,
      clientId: this.clientId,
      redirectUri,
      codeChallenge,
      state,
      originator: this.originator,
    })
    const expiresAt = this.now() + this.sessionTtlMs
    const session: OAuthSession = {
      id: sessionId,
      state,
      codeVerifier,
      authorizationUrl,
      redirectUri,
      expiresAt,
      callback,
      server: binding.server,
      cancelled: false,
      language,
    }
    session.timer = setTimeout(() => this.expire(sessionId), this.sessionTtlMs)
    session.timer.unref?.()
    this.sessions.set(sessionId, session)

    return {
      sessionId,
      authorizationUrl,
      redirectUri,
      expiresAt,
      loopbackListening: Boolean(binding.server),
      status: 'waiting',
    }
  }

  async open(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (!this.openExternal) throw new Error('系统浏览器打开能力不可用。')
    try {
      await this.openExternal(session.authorizationUrl)
    } catch {
      throw new Error('无法在系统浏览器中打开 OAuth 授权页面。')
    }
  }

  submitCallback(sessionId: string, callbackUrl: string): void {
    const session = this.requireSession(sessionId)
    this.acceptCallback(session, callbackUrl)
  }

  wait(
    sessionId: string,
    fetchImplementation: typeof fetch = fetch,
  ): Promise<ChatGptCredentialBundle> {
    const session = this.requireSession(sessionId)
    session.exchange ??= this.exchangeAfterCallback(session, fetchImplementation)
    return session.exchange
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(normalizeSessionId(sessionId))
    if (!session) return
    session.cancelled = true
    if (!session.callback.settled) rejectDeferred(session.callback, new Error('OAuth 授权已取消。'))
    this.closeSession(session, true)
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.cancel(sessionId)
  }

  private async bindLoopback(
    sessionId: string,
    language: UiLanguage,
  ): Promise<{ server?: Server; port?: number }> {
    for (const requestedPort of this.ports) {
      const server = createServer((request, response) => {
        this.handleLoopbackRequest(sessionId, language, request.url ?? '/', response)
      })
      const bound = await listen(server, requestedPort)
      if (!bound) continue
      const address = server.address() as AddressInfo | null
      return { server, port: address?.port ?? requestedPort }
    }
    return {}
  }

  private handleLoopbackRequest(
    sessionId: string,
    language: UiLanguage,
    requestUrl: string,
    response: ServerResponse,
  ): void {
    const path = safePath(requestUrl)
    const session = this.sessions.get(sessionId)
    if (!session) {
      sendHtml(
        response,
        409,
        oauthBrowserMessage(language, 'OAuth 授权会话尚未就绪或已经结束。'),
        path === CHATGPT_OAUTH_CALLBACK_PATH ? '/error' : undefined,
      )
      return
    }
    if (path === '/cancel') {
      this.cancel(sessionId)
      sendHtml(response, 200, oauthBrowserMessage(session.language, 'OAuth 授权已取消，可以关闭此页面。'))
      return
    }
    if (path !== CHATGPT_OAUTH_CALLBACK_PATH) {
      sendHtml(response, 404, 'Not Found')
      return
    }
    try {
      this.acceptCallback(session, requestUrl)
      sendHtml(response, 200, oauthBrowserMessage(session.language, 'OAuth 授权已接收，请返回 StonePlus 完成账号检测。'), '/success')
    } catch (error) {
      sendHtml(response, 400, oauthBrowserMessage(session.language, safeErrorMessage(error)), '/error')
    }
  }

  private acceptCallback(session: OAuthSession, callbackUrl: string): void {
    if (session.cancelled) throw new Error('OAuth 授权已取消。')
    if (this.now() >= session.expiresAt) {
      this.expire(session.id)
      throw new Error('OAuth 授权会话已过期，请重新开始。')
    }
    const url = parseCallbackUrl(callbackUrl, session.redirectUri)
    if (url.origin !== new URL(session.redirectUri).origin) throw new Error('OAuth 回调地址来源不正确。')
    if (url.pathname !== CHATGPT_OAUTH_CALLBACK_PATH) throw new Error('回调地址路径不正确。')
    const returnedState = url.searchParams.get('state') ?? ''
    if (!safeEqual(returnedState, session.state)) throw new Error('OAuth 回调 state 校验失败。')
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      const error = new Error(oauthCallbackErrorMessage(oauthError))
      if (!session.callback.settled) rejectDeferred(session.callback, error)
      this.closeServer(session)
      throw error
    }
    const code = url.searchParams.get('code')?.trim()
    if (!code) throw new Error('OAuth 回调缺少授权码。')
    if (!session.callback.settled) resolveDeferred(session.callback, code)
    this.closeServer(session)
  }

  private async exchangeAfterCallback(
    session: OAuthSession,
    fetchImplementation: typeof fetch,
  ): Promise<ChatGptCredentialBundle> {
    try {
      const code = await session.callback.promise
      if (session.cancelled) throw new Error('OAuth 授权已取消。')
      const remaining = session.expiresAt - this.now()
      if (remaining <= 0) throw new Error('OAuth 授权会话已过期，请重新开始。')
      const timeoutMs = Math.max(1, Math.min(this.tokenTimeoutMs, remaining))
      let response: Response
      try {
        response = await fetchImplementation(`${this.issuer}/oauth/token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: session.redirectUri,
            client_id: this.clientId,
            code_verifier: session.codeVerifier,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (isAbortOrTimeout(error)) throw new Error('OAuth Token 交换超时。')
        throw new Error('无法连接 OpenAI OAuth Token 服务。')
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          throw new Error('OAuth 授权码已失效、已使用或被拒绝，请重新授权。')
        }
        if (response.status === 429) throw new Error('OpenAI OAuth 请求过于频繁，请稍后重试。')
        throw new Error(response.status >= 500
          ? 'OpenAI OAuth 服务暂时不可用。'
          : `OpenAI OAuth Token 交换失败（HTTP ${response.status}）。`)
      }
      let payload: Record<string, unknown>
      try {
        const parsed = objectValue(JSON.parse(await readLimitedText(response, MAX_TOKEN_RESPONSE_BYTES)))
        if (!parsed) throw new Error('Token response must be an object.')
        payload = parsed
      } catch {
        throw new Error('OpenAI OAuth Token 响应格式无效。')
      }
      const accessToken = cleanToken(payload.access_token)
      const refreshToken = cleanToken(payload.refresh_token)
      const idToken = cleanToken(payload.id_token)
      if (!accessToken || !refreshToken || !idToken) {
        throw new Error('OpenAI OAuth Token 响应缺少必要凭据。')
      }
      const email = emailFromIdToken(idToken)
      const parsed = parseChatGptAccountImport(JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        ...(email ? { email } : {}),
      }), this.now())
      const bundle = parsed.accounts[0]
      if (!bundle) throw new Error('无法从 OAuth Token 中识别 ChatGPT 账号。')
      return bundle
    } finally {
      this.closeSession(session, true)
    }
  }

  private requireSession(sessionId: string): OAuthSession {
    const id = normalizeSessionId(sessionId)
    const session = this.sessions.get(id)
    if (!session) throw new Error('OAuth 授权会话不存在或已结束。')
    if (this.now() >= session.expiresAt) {
      this.expire(id)
      throw new Error('OAuth 授权会话已过期，请重新开始。')
    }
    return session
  }

  private expire(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!session.callback.settled) rejectDeferred(session.callback, new Error('OAuth 授权会话已过期，请重新开始。'))
    this.closeSession(session, true)
  }

  private closeServer(session: OAuthSession): void {
    const server = session.server
    session.server = undefined
    if (server?.listening) server.close()
  }

  private closeSession(session: OAuthSession, remove: boolean): void {
    this.closeServer(session)
    if (session.timer) clearTimeout(session.timer)
    session.timer = undefined
    session.codeVerifier = ''
    session.state = ''
    if (remove) this.sessions.delete(session.id)
  }

  private pruneSessions(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now || session.cancelled) this.expire(id)
    }
  }
}

export function buildAuthorizationUrl(input: {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  originator?: string
}): string {
  const url = new URL('/oauth/authorize', normalizeIssuer(input.issuer))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', requiredValue(input.clientId, 'OAuth client id'))
  url.searchParams.set('redirect_uri', requiredValue(input.redirectUri, 'OAuth redirect URI'))
  url.searchParams.set('scope', CHATGPT_OAUTH_SCOPE)
  url.searchParams.set('code_challenge', requiredValue(input.codeChallenge, 'OAuth PKCE challenge'))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', requiredValue(input.state, 'OAuth state'))
  url.searchParams.set('originator', input.originator?.trim() || DEFAULT_ORIGINATOR)
  return url.toString()
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const failed = (): void => {
      server.removeListener('listening', listening)
      try { server.close() } catch { /* already closed */ }
      resolve(false)
    }
    const listening = (): void => {
      server.removeListener('error', failed)
      resolve(true)
    }
    server.once('error', failed)
    server.once('listening', listening)
    try {
      server.listen({ port, host: '127.0.0.1', exclusive: true })
    } catch {
      failed()
    }
  })
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: Error) => void
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    resolve: (value) => resolvePromise(value),
    reject: (reason) => rejectPromise(reason),
    settled: false,
  }
  return result
}

function resolveDeferred<T>(target: Deferred<T>, value: T): void {
  if (target.settled) return
  target.settled = true
  target.resolve(value)
}

function rejectDeferred<T>(target: Deferred<T>, error: Error): void {
  if (target.settled) return
  target.settled = true
  target.reject(error)
}

function parseCallbackUrl(value: string, redirectUri: string): URL {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('请粘贴完整 OAuth 回调地址。')
  try {
    return new URL(trimmed, redirectUri)
  } catch {
    throw new Error('OAuth 回调地址格式无效。')
  }
}

function safePath(value: string): string {
  try { return new URL(value, 'http://localhost').pathname } catch { return '' }
}

function sendHtml(
  response: ServerResponse,
  status: number,
  message: string,
  cleanPath?: '/success' | '/error',
): void {
  const nonce = randomBytes(16).toString('base64')
  const cleanHistory = cleanPath
    ? `<script nonce="${nonce}">history.replaceState(null,'','${cleanPath}')</script>`
    : ''
  const body = `<!doctype html><meta charset="utf-8">${cleanHistory}<title>StonePlus OAuth</title><style nonce="${nonce}">body{font:16px system-ui;margin:48px;color:#18352b}main{max-width:620px;margin:auto;padding:28px;border:1px solid #d9e5e0;border-radius:14px}h1{font-size:22px}</style><main><h1>StonePlus Codex OAuth</h1><p>${escapeHtml(message)}</p></main>`
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function oauthCallbackErrorMessage(code: string): string {
  if (code === 'access_denied') return 'OpenAI OAuth 授权已取消或被拒绝。'
  if (code === 'login_required') return 'OpenAI 要求重新登录后再授权。'
  return 'OpenAI OAuth 授权未完成，请重新开始。'
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'OAuth 授权失败。'
}

const oauthBrowserEnglish = new Map<string, string>([
  ['OAuth 授权会话尚未就绪或已经结束。', 'The OAuth session is not ready or has already ended.'],
  ['OAuth 授权已取消，可以关闭此页面。', 'OAuth authorization was cancelled. You can close this page.'],
  ['OAuth 授权已接收，请返回 StonePlus 完成账号检测。', 'OAuth authorization was received. Return to StonePlus to finish the account check.'],
  ['OAuth 授权已取消。', 'OAuth authorization was cancelled.'],
  ['OAuth 授权会话已过期，请重新开始。', 'The OAuth session expired. Start again in StonePlus.'],
  ['OAuth 回调地址来源不正确。', 'The OAuth callback origin is invalid.'],
  ['回调地址路径不正确。', 'The OAuth callback path is invalid.'],
  ['OAuth 回调 state 校验失败。', 'OAuth callback state validation failed.'],
  ['OAuth 回调缺少授权码。', 'The OAuth callback is missing an authorization code.'],
  ['OpenAI OAuth 授权已取消或被拒绝。', 'OpenAI OAuth authorization was cancelled or denied.'],
  ['OpenAI 要求重新登录后再授权。', 'OpenAI requires you to sign in again before authorizing.'],
  ['OpenAI OAuth 授权未完成，请重新开始。', 'OpenAI OAuth authorization did not complete. Start again in StonePlus.'],
  ['OAuth 授权失败。', 'OAuth authorization failed.'],
])

function oauthBrowserMessage(language: UiLanguage, message: string): string {
  if (language === 'zh-CN' || !/[\u3400-\u9fff]/u.test(message)) return message
  return oauthBrowserEnglish.get(message) ?? 'OAuth authorization could not be completed. Return to StonePlus and try again.'
}

function cleanToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function readLimitedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Token response exceeds the maximum size.')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Token response exceeds the maximum size.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function emailFromIdToken(idToken: string): string | undefined {
  const payload = jwtPayload(idToken)
  const directEmail = cleanToken(payload?.email)
  if (directEmail) return directEmail
  const profile = objectValue(payload?.['https://api.openai.com/profile'])
  return cleanToken(profile?.email) || undefined
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    return objectValue(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function normalizeIssuer(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) throw new Error('OAuth issuer 必须使用 HTTPS。')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function requiredValue(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

function normalizeSessionId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('OAuth 授权会话 ID 无效。')
  return id
}

function boundedDuration(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
    || error instanceof Error && /aborted|timeout/i.test(`${error.name} ${error.message}`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}
