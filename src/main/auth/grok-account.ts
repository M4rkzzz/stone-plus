import { createHash } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import { runOAuthRefreshRequest } from './oauth-refresh-gate'

export const GROK_OAUTH_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
export const GROK_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

export interface GrokOAuthCredentialBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType: 'Bearer'
  email?: string
  subjectId: string
  teamId?: string
  clientId: string
  scope?: string
  expiresAt: number
  baseUrl: typeof GROK_OAUTH_BASE_URL
}

export interface ParsedGrokOAuthAccounts {
  accounts: Array<{ bundle: GrokOAuthCredentialBundle; name?: string; concurrency?: number; priority?: number }>
  warnings: string[]
}

export class GrokOAuthCredentialError extends Error {
  constructor(
    message: string,
    readonly code: 'revoked',
  ) {
    super(message)
    this.name = 'GrokOAuthCredentialError'
  }
}

export function parseGrokOAuthImport(content: string, now = Date.now()): ParsedGrokOAuthAccounts {
  if (Buffer.byteLength(content, 'utf8') > 10 * 1024 * 1024) throw new Error('Grok OAuth import is too large.')
  let root: unknown
  try { root = JSON.parse(content) } catch { throw new Error('Grok OAuth import must be valid Sub2API JSON.') }
  const object = record(root)
  const values = Array.isArray(root) ? root : Array.isArray(object?.accounts) ? object.accounts : [root]
  const accounts: ParsedGrokOAuthAccounts['accounts'] = []
  let skipped = 0
  for (const value of values) {
    const account = record(value)
    if (!account || lower(account.platform) !== 'grok' || lower(account.type) !== 'oauth') {
      skipped += 1
      continue
    }
    const credentials = record(account.credentials)
    if (!credentials) throw new Error('Grok OAuth account is missing credentials.')
    const accessToken = text(credentials.access_token)
    if (!accessToken || accessToken.length > 16_384) throw new Error('Grok OAuth account is missing a valid access_token.')
    const claims = jwtClaims(accessToken)
    if (text(claims?.iss) !== 'https://auth.x.ai') throw new Error('Grok OAuth access_token issuer is invalid.')
    const subjectId = text(claims?.sub)
    if (!subjectId) throw new Error('Grok OAuth access_token is missing its subject.')
    const expiresAt = timestamp(credentials.expires_at) ?? secondsTimestamp(claims?.exp)
    if (!expiresAt) throw new Error('Grok OAuth account expiration could not be determined.')
    const refreshToken = text(credentials.refresh_token)
    if (refreshToken && refreshToken.length > 16_384) throw new Error('Grok OAuth refresh_token is too large.')
    if (expiresAt <= now - 30_000 && !refreshToken) throw new Error('Grok OAuth access_token has expired and has no refresh_token.')
    const clientId = text(credentials.client_id) ?? text(claims?.client_id) ?? GROK_OAUTH_CLIENT_ID
    if (clientId !== GROK_OAUTH_CLIENT_ID) throw new Error('Grok OAuth client_id is not supported.')
    const importedBaseUrl = text(credentials.base_url)
    if (importedBaseUrl && canonicalBaseUrl(importedBaseUrl) !== GROK_OAUTH_BASE_URL) {
      throw new Error('Grok OAuth base_url is not the trusted Grok CLI endpoint.')
    }
    const idToken = text(credentials.id_token)
    if (idToken && idToken.length > 32_768) throw new Error('Grok OAuth id_token is too large.')
    const idClaims = idToken ? jwtClaims(idToken) : undefined
    const bundle: GrokOAuthCredentialBundle = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(idToken ? { idToken } : {}),
      tokenType: 'Bearer',
      ...(text(credentials.email) ?? text(idClaims?.email) ? { email: text(credentials.email) ?? text(idClaims?.email) } : {}),
      subjectId,
      ...(text(claims?.team_id) ? { teamId: text(claims?.team_id) } : {}),
      clientId,
      ...(text(credentials.scope) ? { scope: text(credentials.scope) } : {}),
      expiresAt,
      baseUrl: GROK_OAUTH_BASE_URL,
    }
    const existing = accounts.findIndex((candidate) => matchesGrokOAuthCredential(bundle, candidate.bundle))
    const parsed = {
      bundle,
      ...(text(account.name) ? { name: text(account.name) } : {}),
      ...(positiveInteger(account.concurrency) ? { concurrency: positiveInteger(account.concurrency) } : {}),
      ...(positiveInteger(account.priority) ? { priority: positiveInteger(account.priority) } : {}),
    }
    if (existing >= 0) accounts[existing] = parsed
    else accounts.push(parsed)
  }
  if (!accounts.length) throw new Error('No Grok OAuth accounts were found in the Sub2API import.')
  return {
    accounts,
    warnings: skipped ? [`已忽略 ${skipped} 个非 Grok OAuth 的 Sub2API 账号。`] : [],
  }
}

export function serializeGrokOAuthCredential(bundle: GrokOAuthCredentialBundle): string {
  return JSON.stringify(bundle)
}

export function deserializeGrokOAuthCredential(value: string): GrokOAuthCredentialBundle | undefined {
  try {
    const parsed = record(JSON.parse(value))
    const accessToken = text(parsed?.accessToken)
    const subjectId = text(parsed?.subjectId)
    const clientId = text(parsed?.clientId)
    const expiresAt = typeof parsed?.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : undefined
    if (!accessToken || !subjectId || clientId !== GROK_OAUTH_CLIENT_ID || !expiresAt || parsed?.baseUrl !== GROK_OAUTH_BASE_URL) return undefined
    return {
      accessToken,
      ...(text(parsed?.refreshToken) ? { refreshToken: text(parsed?.refreshToken) } : {}),
      ...(text(parsed?.idToken) ? { idToken: text(parsed?.idToken) } : {}),
      tokenType: 'Bearer',
      ...(text(parsed?.email) ? { email: text(parsed?.email) } : {}),
      subjectId,
      ...(text(parsed?.teamId) ? { teamId: text(parsed?.teamId) } : {}),
      clientId,
      ...(text(parsed?.scope) ? { scope: text(parsed?.scope) } : {}),
      expiresAt,
      baseUrl: GROK_OAUTH_BASE_URL,
    }
  } catch { return undefined }
}

export function matchesGrokOAuthCredential(a: GrokOAuthCredentialBundle, b: GrokOAuthCredentialBundle): boolean {
  return a.subjectId === b.subjectId && (a.teamId ?? '') === (b.teamId ?? '')
}

export interface GrokOAuthCredentialAccess { bundle: GrokOAuthCredentialBundle; serialized: string }

export interface GrokOAuthCredentialRefreshOptions {
  /** Stable local account key used to share refreshes for one credential. */
  refreshKey?: string
  /** Stop this caller waiting without cancelling the shared OAuth refresh. */
  signal?: AbortSignal
  /** Hard deadline for the OAuth endpoint. */
  timeoutMs?: number
  /** Refresh even when the access token has not entered the normal refresh window. */
  forceRefresh?: boolean
}

const DEFAULT_REFRESH_TIMEOUT_MS = 10_000
const RECENT_REFRESH_TTL_MS = 15 * 60_000
const MAX_RECENT_REFRESHES = 256
const refreshFlights = new Map<string, Promise<GrokOAuthCredentialAccess>>()
const recentlyRefreshedCredentials = new Map<string, {
  sourceAccessToken: string
  access: GrokOAuthCredentialAccess
  expiresAt: number
}>()

export async function resolveGrokOAuthCredential(
  serialized: string,
  persistRotated: (serialized: string, expectedSource?: string) => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
  now = Date.now(),
  options: GrokOAuthCredentialRefreshOptions = {},
): Promise<GrokOAuthCredentialAccess> {
  const current = deserializeGrokOAuthCredential(serialized)
  if (!current) throw new Error('Grok OAuth credential is invalid.')
  const refreshKey = options.refreshKey ?? `${current.subjectId}:${current.teamId ?? ''}`
  const sourceKey = credentialSourceKey(refreshKey, serialized)
  const cached = recentlyRefreshedCredentials.get(sourceKey)
  if (cached && cached.expiresAt <= now) recentlyRefreshedCredentials.delete(sourceKey)
  if (
    cached
    && cached.expiresAt > now
    && cached.sourceAccessToken === current.accessToken
    && cached.access.bundle.expiresAt > now
  ) return cached.access

  if (!options.forceRefresh && current.expiresAt - now > 120_000) return { bundle: current, serialized }
  if (!current.refreshToken) {
    if (!options.forceRefresh && current.expiresAt > now) return { bundle: current, serialized }
    if (options.forceRefresh) throw new Error('Grok OAuth account has no refresh token.')
    throw new Error('Grok OAuth access token expired and has no refresh token.')
  }
  let flight = refreshFlights.get(sourceKey)
  if (!flight) {
    flight = (async () => {
      // A caller signal only controls that caller's wait. The shared refresh owns its
      // timeout so one cancelled request cannot invalidate every concurrent request.
      const bundle = await refreshGrokOAuthCredential(current, fetchImplementation, {
        timeoutMs: options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
      })
      const rotated = serializeGrokOAuthCredential(bundle)
      await persistRotated(rotated, serialized)
      const access = { bundle, serialized: rotated }
      rememberRefreshedCredential(sourceKey, current.accessToken, access)
      return access
    })()
    refreshFlights.set(sourceKey, flight)
    void flight.finally(() => {
      if (refreshFlights.get(sourceKey) === flight) refreshFlights.delete(sourceKey)
    }).catch(() => undefined)
  }
  return await waitForRefresh(flight, options.signal)
}

export async function refreshGrokOAuthCredential(
  current: GrokOAuthCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GrokOAuthCredentialBundle> {
  const refreshToken = current.refreshToken
  if (!refreshToken) throw new Error('Grok OAuth account has no refresh token.')
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal
  let response: Response
  try {
    response = await runOAuthRefreshRequest('xai', signal, () => fetchImplementation(GROK_OAUTH_TOKEN_URL, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'stoneplus-grok-oauth/1.0' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: refreshToken }),
    }))
  } catch {
    if (signal.aborted) throw new Error('Grok OAuth token refresh timed out.')
    throw new Error('Grok OAuth token endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 400 || response.status === 401) {
      throw new GrokOAuthCredentialError('Grok OAuth refresh token was rejected.', 'revoked')
    }
    throw new Error('Grok OAuth token refresh failed.')
  }
  const responseText = await readBoundedResponseText(
    response,
    64 * 1024,
    'Grok OAuth token refresh response is too large.',
    signal,
  )
  let payload: Record<string, unknown> | undefined
  try { payload = record(JSON.parse(responseText)) } catch { throw new Error('Grok OAuth token refresh returned invalid JSON.') }
  const accessToken = text(payload?.access_token)
  const expiresIn = typeof payload?.expires_in === 'number' ? payload.expires_in : 0
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Grok OAuth token refresh returned an invalid response.')
  const claims = jwtClaims(accessToken)
  if (text(claims?.iss) !== 'https://auth.x.ai' || text(claims?.sub) !== current.subjectId) throw new Error('Grok OAuth token refresh returned a credential for another account.')
  return {
    ...current, accessToken, expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: text(payload?.refresh_token) ?? current.refreshToken,
    idToken: text(payload?.id_token) ?? current.idToken,
  }
}

function credentialSourceKey(refreshKey: string, serialized: string): string {
  const fingerprint = createHash('sha256').update(serialized).digest('hex')
  return `${refreshKey}:${fingerprint}`
}

function rememberRefreshedCredential(
  key: string,
  sourceAccessToken: string,
  access: GrokOAuthCredentialAccess,
): void {
  recentlyRefreshedCredentials.delete(key)
  recentlyRefreshedCredentials.set(key, {
    sourceAccessToken,
    access,
    expiresAt: Date.now() + RECENT_REFRESH_TTL_MS,
  })
  while (recentlyRefreshedCredentials.size > MAX_RECENT_REFRESHES) {
    const oldest = recentlyRefreshedCredentials.keys().next().value as string | undefined
    if (!oldest) break
    recentlyRefreshedCredentials.delete(oldest)
  }
}

function waitForRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function canonicalBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { return undefined }
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const segment = token.split('.')[1]
    return segment ? record(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))) : undefined
  } catch { return undefined }
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function lower(value: unknown): string | undefined { return text(value)?.toLowerCase() }
function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'string'
    ? Date.parse(value)
    : typeof value === 'number'
      ? value
      : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // Sub2API exporters use both JavaScript milliseconds and Unix seconds.
  return parsed < 100_000_000_000 ? parsed * 1000 : parsed
}
function secondsTimestamp(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined }
function positiveInteger(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined }
