import type { Account, AccountCodexQuotaSnapshot } from '@shared/types'
import { createHash } from 'node:crypto'
import type { ProviderFailure } from './types'
import { parseRetryAfter } from './failure'
import { extractCodexQuotaFromUsagePayload } from './quota'
import { deserializeChatGptCredential, serializeChatGptCredential, type ChatGptCredentialBundle } from '../auth'

export const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CHATGPT_CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
export const CODEX_CLIENT_VERSION = '0.144.3'
export const CHATGPT_CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`
export const CHATGPT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_PASSTHROUGH_HEADERS = Object.freeze([
  'accept-language',
  'conversation_id',
  'session_id',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-installation-id',
  'x-codex-parent-thread-id',
  'x-codex-turn-state',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-openai-internal-codex-responses-lite',
  'x-openai-subagent'
])
const CODEX_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const CODEX_USER_AGENT_VERSION = /\bcodex(?:[_-][a-z0-9]+)*\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i

type ChatGptSourceHeaders = Headers | Readonly<Record<string, string | string[] | undefined>>

export interface ChatGptCredentialAccess {
  bundle: ChatGptCredentialBundle
  serialized: string
}

export interface ChatGptCodexAuthorization {
  authorization: string
  accountId: string
  fedramp?: boolean
}

export interface ChatGptCredentialRefreshOptions {
  /** Stable local account/credential key used to isolate concurrent refreshes. */
  refreshKey?: string
  /** Stop waiting for a blocking refresh without cancelling a refresh shared by other requests. */
  signal?: AbortSignal
  /** Hard deadline for the OAuth endpoint. */
  timeoutMs?: number
  /** Refresh in the background while the current access token is still safely usable. */
  backgroundRefreshWindowMs?: number
  /** Never return an access token this close to expiry while a refresh is needed. */
  blockingRefreshWindowMs?: number
}

const DEFAULT_REFRESH_TIMEOUT_MS = 10_000
const DEFAULT_BACKGROUND_REFRESH_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_BLOCKING_REFRESH_WINDOW_MS = 30_000
const credentialRefreshFlights = new Map<string, Promise<ChatGptCredentialAccess>>()
const recentlyRefreshedCredentials = new Map<string, {
  sourceAccessToken: string
  access: ChatGptCredentialAccess
  expiresAt: number
}>()
const RECENT_REFRESH_TTL_MS = 15 * 60_000
const MAX_RECENT_REFRESHES = 256

export async function resolveChatGptCredential(
  encryptedValue: string,
  persistRotated: (serialized: string, expectedSourceSerialized?: string) => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
  now = Date.now(),
  options: ChatGptCredentialRefreshOptions = {}
): Promise<ChatGptCredentialAccess> {
  const current = deserializeChatGptCredential(encryptedValue)
  if (!current) throw new Error('ChatGPT account credential is invalid.')
  const refreshKey = options.refreshKey ?? current.accountId
  const sourceKey = credentialSourceKey(refreshKey, encryptedValue)
  const cached = recentlyRefreshedCredentials.get(sourceKey)
  if (cached && cached.expiresAt <= now) recentlyRefreshedCredentials.delete(sourceKey)
  if (
    cached
    && cached.expiresAt > now
    && (cached.sourceAccessToken === current.accessToken || cached.access.bundle.accessToken === current.accessToken)
    && cached.access.bundle.expiresAt > current.expiresAt
    && cached.access.bundle.expiresAt > now
  ) return cached.access

  const remainingMs = current.expiresAt - now
  const backgroundWindowMs = Math.max(0, options.backgroundRefreshWindowMs ?? DEFAULT_BACKGROUND_REFRESH_WINDOW_MS)
  const blockingWindowMs = Math.max(0, Math.min(
    backgroundWindowMs,
    options.blockingRefreshWindowMs ?? DEFAULT_BLOCKING_REFRESH_WINDOW_MS
  ))
  if (remainingMs > backgroundWindowMs) return { bundle: current, serialized: encryptedValue }
  if (!current.refreshToken) {
    if (remainingMs > 0) return { bundle: current, serialized: encryptedValue }
    throw new Error('ChatGPT account access token expired and has no refresh token.')
  }

  const refresh = getOrStartCredentialRefresh(
    current,
    sourceKey,
    encryptedValue,
    persistRotated,
    fetchImplementation,
    options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
  )
  if (remainingMs > blockingWindowMs) {
    // The token remains safely usable. Do not put OAuth endpoint latency on the request path.
    void refresh.catch(() => undefined)
    return { bundle: current, serialized: encryptedValue }
  }
  return await waitForSharedRefresh(refresh, options.signal)
}

export async function refreshChatGptCredential(
  current: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  options: Pick<ChatGptCredentialRefreshOptions, 'signal' | 'timeoutMs'> = {}
): Promise<ChatGptCredentialBundle> {
  if (!current.refreshToken) throw new Error('ChatGPT account has no refresh token.')
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal
  let response: Response
  try {
    response = await fetchImplementation('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': `codex-cli/${CODEX_CLIENT_VERSION}` },
      signal,
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: current.refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
        scope: 'openid profile email'
      })
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT token refresh timed out.')
    throw new Error('ChatGPT token refresh endpoint could not be reached.')
  }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'ChatGPT refresh token was rejected.' : 'ChatGPT token refresh failed.')
  const payload = await response.json() as Record<string, unknown>
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('ChatGPT token refresh returned an invalid response.')
  return {
    ...current,
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token.trim() ? payload.refresh_token.trim() : current.refreshToken,
    idToken: typeof payload.id_token === 'string' && payload.id_token.trim() ? payload.id_token.trim() : current.idToken
  }
}

function getOrStartCredentialRefresh(
  current: ChatGptCredentialBundle,
  key: string,
  sourceSerialized: string,
  persistRotated: (serialized: string, expectedSourceSerialized?: string) => Promise<void>,
  fetchImplementation: typeof fetch,
  timeoutMs: number
): Promise<ChatGptCredentialAccess> {
  const active = credentialRefreshFlights.get(key)
  if (active) return active
  const refresh = (async (): Promise<ChatGptCredentialAccess> => {
    const refreshed = await refreshChatGptCredential(current, fetchImplementation, { timeoutMs })
    const serialized = serializeChatGptCredential(refreshed)
    // Persist before publishing the refreshed token. This is especially important when
    // refresh-token rotation invalidates the token used by this request.
    await persistRotated(serialized, sourceSerialized)
    const access = { bundle: refreshed, serialized }
    rememberRefreshedCredential(key, current.accessToken, access)
    return access
  })()
  credentialRefreshFlights.set(key, refresh)
  void refresh.finally(() => {
    if (credentialRefreshFlights.get(key) === refresh) credentialRefreshFlights.delete(key)
  }).catch(() => undefined)
  return refresh
}

function credentialSourceKey(refreshKey: string, serialized: string): string {
  const fingerprint = createHash('sha256').update(serialized).digest('hex')
  return `${refreshKey}:${fingerprint}`
}

function rememberRefreshedCredential(
  key: string,
  sourceAccessToken: string,
  access: ChatGptCredentialAccess
): void {
  recentlyRefreshedCredentials.delete(key)
  recentlyRefreshedCredentials.set(key, {
    sourceAccessToken,
    access,
    expiresAt: Date.now() + RECENT_REFRESH_TTL_MS
  })
  while (recentlyRefreshedCredentials.size > MAX_RECENT_REFRESHES) {
    const oldest = recentlyRefreshedCredentials.keys().next().value as string | undefined
    if (!oldest) break
    recentlyRefreshedCredentials.delete(oldest)
  }
}

async function waitForSharedRefresh(
  refresh: Promise<ChatGptCredentialAccess>,
  signal?: AbortSignal
): Promise<ChatGptCredentialAccess> {
  if (!signal) return await refresh
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<ChatGptCredentialAccess>((resolve, reject) => {
    const aborted = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', aborted, { once: true })
    void refresh.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

export function applyChatGptCodexHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders
): void {
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = readSourceHeader(sourceHeaders, name)
    if (value) headers.set(name, value)
  }
  applyChatGptCodexIdentityHeaders(headers, bundle, sourceHeaders)
  headers.set('accept', 'text/event-stream')
  headers.set('content-type', 'application/json')
  headers.set('openai-beta', 'responses=experimental')
}

export function applyChatGptCodexSearchHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders
): void {
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = readSourceHeader(sourceHeaders, name)
    if (value) headers.set(name, value)
  }
  applyChatGptCodexIdentityHeaders(headers, bundle, sourceHeaders)
  headers.set('accept', 'application/json')
  headers.set('content-type', 'application/json')
}

/** Applies first-party Codex headers for a dynamically signed AgentAssertion. */
export function applyChatGptAgentIdentityHeaders(
  headers: Headers,
  authorization: string,
  accountId: string,
  fedramp = false,
  sourceHeaders?: ChatGptSourceHeaders,
  accept: 'stream' | 'json' = 'stream'
): void {
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = readSourceHeader(sourceHeaders, name)
    if (value) headers.set(name, value)
  }
  const clientVersion = resolveCodexClientVersion(sourceHeaders)
  headers.set('authorization', authorization)
  headers.set('chatgpt-account-id', accountId)
  if (fedramp) headers.set('x-openai-fedramp', 'true')
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', `codex_cli_rs/${clientVersion} (Windows 11; x86_64)`)
  headers.set('version', clientVersion)
  headers.set('accept', accept === 'stream' ? 'text/event-stream' : 'application/json')
  headers.set('content-type', 'application/json')
  if (accept === 'stream') headers.set('openai-beta', 'responses=experimental')
}

function applyChatGptCodexIdentityHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders
): void {
  const clientVersion = resolveCodexClientVersion(sourceHeaders)
  headers.set('authorization', `Bearer ${bundle.accessToken}`)
  headers.set('chatgpt-account-id', bundle.accountId)
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', `codex_cli_rs/${clientVersion} (Windows 11; x86_64)`)
  headers.set('version', clientVersion)
}

function readSourceHeader(source: ChatGptSourceHeaders | undefined, name: string): string | undefined {
  if (!source) return undefined
  if (source instanceof Headers) return source.get(name)?.trim() || undefined
  const match = Object.entries(source).find(([key]) => key.toLowerCase() === name)?.[1]
  const value = Array.isArray(match) ? match.join(', ') : match
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function withChatGptCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  const upstream: Record<string, unknown> = {
    ...body,
    store: false,
    stream: true
  }
  if (isChatGptCodexResponsesLiteBody(body)) {
    delete upstream.instructions
    delete upstream.tools
    return upstream
  }
  return {
    ...upstream,
    instructions: typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions
      : 'You are Codex, a coding assistant.'
  }
}

export function isChatGptCodexResponsesLiteBody(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input)) return false
  return body.input.some((item) =>
    Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).type === 'additional_tools')
  )
}

function resolveCodexClientVersion(sourceHeaders: ChatGptSourceHeaders | undefined): string {
  const explicit = readSourceHeader(sourceHeaders, 'version')
  if (explicit && CODEX_VERSION.test(explicit)) return explicit
  const userAgent = readSourceHeader(sourceHeaders, 'user-agent')
  return userAgent?.match(CODEX_USER_AGENT_VERSION)?.[1] ?? CODEX_CLIENT_VERSION
}

export async function probeChatGptAccount(
  account: Account,
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; latencyMs: number; statusCode?: number; failure?: ProviderFailure }> {
  return probeChatGptAccountAuthorized(account, {
    authorization: `Bearer ${bundle.accessToken}`,
    accountId: bundle.accountId
  }, fetchImplementation, signal)
}

export async function probeChatGptAccountAuthorized(
  account: Account,
  authorization: ChatGptCodexAuthorization,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; latencyMs: number; statusCode?: number; failure?: ProviderFailure }> {
  const started = Date.now()
  const headers = new Headers()
  applyChatGptAgentIdentityHeaders(
    headers,
    authorization.authorization,
    authorization.accountId,
    authorization.fedramp
  )
  try {
    const response = await fetchImplementation(CHATGPT_CODEX_RESPONSES_URL, {
      method: 'POST', headers, signal,
      body: JSON.stringify(withChatGptCodexBody({
        model: account.modelAllowlist[0] ?? 'gpt-5.4',
        instructions: 'You are a coding assistant.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }]
      }))
    })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started, statusCode: response.status }
      : { ok: false, latencyMs: Date.now() - started, statusCode: response.status, failure: classifyChatGptCodexFailure(response.status, response.headers) }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, failure: { category: 'network', message: error instanceof Error ? 'ChatGPT Codex endpoint could not be reached.' : 'ChatGPT Codex request failed.', retryable: true, accountAction: 'cooldown' } }
  }
}

export async function checkChatGptAccountAuthorized(
  account: Account,
  authorization: ChatGptCodexAuthorization,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; latencyMs: number; quota?: AccountCodexQuotaSnapshot; statusCode?: number; failure?: ProviderFailure }> {
  try {
    const result = await queryChatGptCodexQuotaAuthorized(
      authorization,
      fetchImplementation,
      signal
    )
    return { ok: true, latencyMs: result.latencyMs, quota: result.quota }
  } catch {
    // A caller cancellation is authoritative. Falling through to the
    // Responses probe would start another request after a durable task has
    // already been cancelled and could turn cancellation into health data.
    if (signal?.aborted) throw abortReason(signal)
    // The usage endpoint is not available to every valid credential. A real,
    // lightweight Responses probe is authoritative for account usability.
    return probeChatGptAccountAuthorized(account, authorization, fetchImplementation, signal)
  }
}

export async function queryChatGptCodexModels(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string[]> {
  return queryChatGptCodexModelsAuthorized({
    authorization: `Bearer ${bundle.accessToken}`,
    accountId: bundle.accountId
  }, fetchImplementation, signal)
}

export async function queryChatGptCodexModelsAuthorized(
  authorization: ChatGptCodexAuthorization,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string[]> {
  const headers = new Headers({ accept: 'application/json' })
  headers.set('authorization', authorization.authorization)
  headers.set('chatgpt-account-id', authorization.accountId)
  if (authorization.fedramp) headers.set('x-openai-fedramp', 'true')
  let response: Response
  try {
    response = await fetchImplementation(CHATGPT_CODEX_MODELS_URL, {
      method: 'GET',
      headers,
      signal
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex model request timed out.')
    throw new Error('ChatGPT Codex model endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new Error('ChatGPT session access token was rejected.')
    if (response.status === 403) throw new Error('ChatGPT account is not permitted to read Codex models.')
    throw new Error(`ChatGPT Codex model endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    1024 * 1024,
    'ChatGPT Codex model response is too large.'
  )
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('ChatGPT Codex model endpoint returned invalid JSON.')
  }
  const models = parseChatGptCodexModels(payload)
  if (models.length === 0) throw new Error('ChatGPT Codex model endpoint returned an empty model list.')
  return models
}

function parseChatGptCodexModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).models)) {
    return []
  }
  const models: string[] = []
  const seen = new Set<string>()
  for (const candidate of (payload as { models: unknown[] }).models) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (record.visibility === 'hide') continue
    const value = typeof record.slug === 'string'
      ? record.slug.trim()
      : typeof record.id === 'string'
        ? record.id.trim()
        : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    models.push(value)
  }
  return models
}

export async function queryChatGptCodexQuota(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
  now = Date.now()
): Promise<{ quota: AccountCodexQuotaSnapshot; latencyMs: number }> {
  return queryChatGptCodexQuotaAuthorized({
    authorization: `Bearer ${bundle.accessToken}`,
    accountId: bundle.accountId
  }, fetchImplementation, signal, now)
}

export async function queryChatGptCodexQuotaAuthorized(
  authorization: ChatGptCodexAuthorization,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
  now = Date.now()
): Promise<{ quota: AccountCodexQuotaSnapshot; latencyMs: number }> {
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetchImplementation(CHATGPT_CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: authorization.authorization,
        'chatgpt-account-id': authorization.accountId,
        ...(authorization.fedramp ? { 'x-openai-fedramp': 'true' } : {}),
        'openai-beta': 'codex-1',
        'oai-language': 'zh-CN',
        originator: 'Codex Desktop',
        accept: 'application/json',
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
        priority: 'u=4, i'
      },
      signal
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex usage request timed out.')
    throw new Error('ChatGPT Codex usage endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new Error('ChatGPT session access token was rejected.')
    if (response.status === 403) throw new Error('ChatGPT account is not permitted to read Codex usage.')
    throw new Error(`ChatGPT Codex usage endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    512 * 1024,
    'ChatGPT Codex usage response is too large.'
  )
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('ChatGPT Codex usage endpoint returned invalid JSON.')
  }
  const quota = extractCodexQuotaFromUsagePayload(payload, now)
  if (!quota) throw new Error('ChatGPT Codex usage endpoint returned no quota windows.')
  return { quota, latencyMs: Math.max(0, Date.now() - startedAt) }
}

async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
  oversizedMessage: string
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new Error(oversizedMessage)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
}

export function classifyChatGptCodexFailure(statusCode: number, headers?: HeadersInit, now = Date.now()): ProviderFailure {
  if (statusCode === 401) return { category: 'authentication', message: 'ChatGPT session access token was rejected.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 402) return { category: 'quota', message: 'ChatGPT account quota is depleted or requires payment.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 403) return { category: 'permission', message: 'ChatGPT account is not permitted to use the Codex endpoint.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers, now) ?? 30_000
    return { category: 'rate_limit', message: 'ChatGPT account rate limit reached.', retryable: true, accountAction: 'cooldown', statusCode, retryAfterMs, retryAt: now + retryAfterMs }
  }
  return { category: statusCode >= 500 ? 'upstream' : 'invalid_request', message: 'ChatGPT Codex endpoint rejected the request.', retryable: statusCode >= 500, accountAction: statusCode >= 500 ? 'cooldown' : 'none', statusCode }
}
