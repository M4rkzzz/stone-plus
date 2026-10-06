import type { Account, AccountCodexQuotaSnapshot } from '@shared/types'
import { createHash, randomUUID } from 'node:crypto'
import type { ProviderFailure } from './types'
import { parseRetryAfter } from './failure'
import { extractCodexQuotaFromUsagePayload } from './quota'
import { deserializeChatGptCredential, serializeChatGptCredential, type ChatGptCredentialBundle } from '../auth'
import { runOAuthRefreshRequest } from '../auth/oauth-refresh-gate'
import {
  BUNDLED_CODEX_CLIENT_VERSION,
  getChatGptCodexModelsUrl,
  getCodexClientVersion,
} from './codex-client-version'

export {
  BUNDLED_CODEX_CLIENT_VERSION,
  CodexClientVersionSyncService,
  getChatGptCodexModelsUrl,
  getCodexClientVersion,
} from './codex-client-version'

export const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CHATGPT_CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
/** @deprecated Use getCodexClientVersion() for runtime requests. */
export const CODEX_CLIENT_VERSION = BUNDLED_CODEX_CLIENT_VERSION
/** @deprecated Use getChatGptCodexModelsUrl() for runtime requests. */
export const CHATGPT_CODEX_MODELS_URL = getChatGptCodexModelsUrl()
export const CHATGPT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CHATGPT_CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
export const CHATGPT_CODEX_RESET_CREDITS_CONSUME_URL = `${CHATGPT_CODEX_RESET_CREDITS_URL}/consume`
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

export interface ChatGptCodexResetCreditResult {
  windowsReset?: number
  redeemedAt?: number
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
  /** Refresh even while the access token remains usable (for example, to renew an expired ID token). */
  forceRefresh?: boolean
}

export type ChatGptCredentialRefreshErrorCode =
  | 'reauthorization-required'
  | 'timeout'
  | 'unavailable'
  | 'invalid-response'

/**
 * A bounded, secret-free refresh failure that callers can turn into account
 * state without parsing transport-specific error strings.
 */
export class ChatGptCredentialRefreshError extends Error {
  constructor(
    readonly code: ChatGptCredentialRefreshErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChatGptCredentialRefreshError'
  }
}

/** A secret-free HTTP failure from a ChatGPT Codex metadata endpoint. */
export class ChatGptCodexEndpointError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ChatGptCodexEndpointError'
  }
}

export function classifyChatGptCredentialRefreshFailure(error: unknown): ProviderFailure {
  if (error instanceof ChatGptCredentialRefreshError) {
    if (error.code === 'reauthorization-required') {
      return {
        category: 'authentication',
        message: error.message,
        retryable: true,
        accountAction: 'disable',
        statusCode: 401,
      }
    }
    if (error.code === 'timeout') {
      return {
        category: 'timeout',
        message: error.message,
        retryable: true,
        accountAction: 'cooldown',
        statusCode: 504,
      }
    }
    return {
      category: error.code === 'invalid-response' ? 'invalid_response' : 'network',
      message: error.message,
      retryable: true,
      accountAction: 'cooldown',
      statusCode: 503,
    }
  }
  return {
    category: 'upstream',
    message: 'ChatGPT credential recovery failed.',
    retryable: true,
    accountAction: 'cooldown',
    statusCode: 503,
  }
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

  if (options.forceRefresh) {
    if (!current.refreshToken) {
      throw new ChatGptCredentialRefreshError(
        'reauthorization-required',
        'ChatGPT account has no refresh token; reauthorization is required.',
      )
    }
    return await waitForSharedRefresh(getOrStartCredentialRefresh(
      current,
      sourceKey,
      encryptedValue,
      persistRotated,
      fetchImplementation,
      options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
    ), options.signal)
  }

  const remainingMs = current.expiresAt - now
  const backgroundWindowMs = Math.max(0, options.backgroundRefreshWindowMs ?? DEFAULT_BACKGROUND_REFRESH_WINDOW_MS)
  const blockingWindowMs = Math.max(0, Math.min(
    backgroundWindowMs,
    options.blockingRefreshWindowMs ?? DEFAULT_BLOCKING_REFRESH_WINDOW_MS
  ))
  if (remainingMs > backgroundWindowMs) return { bundle: current, serialized: encryptedValue }
  if (!current.refreshToken) {
    if (remainingMs > 0) return { bundle: current, serialized: encryptedValue }
    throw new ChatGptCredentialRefreshError(
      'reauthorization-required',
      'ChatGPT account access token expired and has no refresh token; reauthorization is required.',
    )
  }

  const refresh = getOrStartCredentialRefresh(
    current,
    sourceKey,
    encryptedValue,
    persistRotated,
    fetchImplementation,
    options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
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
  const refreshToken = current.refreshToken
  if (!refreshToken) {
    throw new ChatGptCredentialRefreshError(
      'reauthorization-required',
      'ChatGPT account has no refresh token; reauthorization is required.',
    )
  }
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal
  let response: Response
  try {
    response = await runOAuthRefreshRequest('openai', signal, () => fetchImplementation('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': `codex-cli/${getCodexClientVersion()}` },
      signal,
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
        scope: 'openid profile email'
      })
    }))
  } catch (error) {
    if (isAbortOrTimeout(error)) {
      throw new ChatGptCredentialRefreshError('timeout', 'ChatGPT token refresh timed out.')
    }
    throw new ChatGptCredentialRefreshError('unavailable', 'ChatGPT token refresh endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw response.status === 400 || response.status === 401
      ? new ChatGptCredentialRefreshError(
          'reauthorization-required',
          'ChatGPT refresh token was rejected; reauthorization is required.',
        )
      : new ChatGptCredentialRefreshError('unavailable', 'ChatGPT token refresh failed.')
  }
  const responseText = await readLimitedResponseText(
    response,
    256 * 1024,
    'ChatGPT token refresh response is too large.',
    signal,
  )
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>
  } catch {
    throw new ChatGptCredentialRefreshError('invalid-response', 'ChatGPT token refresh returned invalid JSON.')
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ChatGptCredentialRefreshError('invalid-response', 'ChatGPT token refresh returned an invalid response.')
  }
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
  timeoutMs: number,
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
  sourceHeaders?: ChatGptSourceHeaders,
  installationSeed?: string,
): void {
  const privacySeed = installationSeed?.trim() || bundle.accountId
  copyRedactedCodexSourceHeaders(headers, sourceHeaders, privacySeed)
  applyChatGptCodexIdentityHeaders(headers, bundle, sourceHeaders)
  convergeChatGptCodexInstallationId(headers, privacySeed)
  headers.set('accept', 'text/event-stream')
  headers.set('content-type', 'application/json')
  headers.set('openai-beta', 'responses=experimental')
}

export function applyChatGptCodexSearchHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders,
  installationSeed?: string,
): void {
  const privacySeed = installationSeed?.trim() || bundle.accountId
  copyRedactedCodexSourceHeaders(headers, sourceHeaders, privacySeed)
  applyChatGptCodexIdentityHeaders(headers, bundle, sourceHeaders)
  convergeChatGptCodexInstallationId(headers, privacySeed)
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
  accept: 'stream' | 'json' = 'stream',
  installationSeed?: string,
): void {
  const privacySeed = installationSeed?.trim() || accountId
  copyRedactedCodexSourceHeaders(headers, sourceHeaders, privacySeed)
  const clientVersion = resolveCodexClientVersion(sourceHeaders)
  headers.set('authorization', authorization)
  headers.set('chatgpt-account-id', accountId)
  if (fedramp) headers.set('x-openai-fedramp', 'true')
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', `codex_cli_rs/${clientVersion} (Windows 11; x86_64)`)
  headers.set('version', clientVersion)
  convergeChatGptCodexInstallationId(headers, privacySeed)
  headers.set('accept', accept === 'stream' ? 'text/event-stream' : 'application/json')
  headers.set('content-type', 'application/json')
  if (accept === 'stream') headers.set('openai-beta', 'responses=experimental')
}

/** Redacts the gateway-derived affinity id before it is sent upstream. */
export function redactChatGptCodexSessionId(value: string, seed: string): string {
  return stableCodexPseudonym('session', value.trim(), seed.trim() || 'default')
}

function convergeChatGptCodexInstallationId(headers: Headers, seed: string | undefined): void {
  const normalizedSeed = seed?.trim()
  if (!normalizedSeed) return
  const hex = createHash('sha256').update(`stone+:codex-device:v1\0${normalizedSeed}`).digest('hex')
  const installationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  headers.set('x-codex-installation-id', installationId)
  const metadataValue = headers.get('x-codex-turn-metadata')
  if (!metadataValue) return
  try {
    const metadata = JSON.parse(metadataValue) as unknown
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      headers.set('x-codex-turn-metadata', JSON.stringify({
        ...(metadata as Record<string, unknown>),
        installation_id: installationId,
      }))
    }
  } catch {
    // Preserve opaque client metadata; the canonical dedicated header is enough.
  }
}

function applyChatGptCodexIdentityHeaders(
  headers: Headers,
  bundle: ChatGptCredentialBundle,
  sourceHeaders?: ChatGptSourceHeaders,
): void {
  const clientVersion = resolveCodexClientVersion(sourceHeaders)
  headers.set('authorization', `Bearer ${bundle.accessToken}`)
  headers.set('chatgpt-account-id', bundle.accountId)
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', `codex_cli_rs/${clientVersion} (Windows 11; x86_64)`)
  headers.set('version', clientVersion)
}

/**
 * Copy only protocol-relevant Codex headers from the local client. Client
 * identifiers are converted to stable, account-scoped pseudonyms and the
 * turn metadata is reduced to non-location fields before it leaves Stone+.
 * Authentication and the request body are deliberately handled elsewhere.
 */
function copyRedactedCodexSourceHeaders(
  target: Headers,
  sourceHeaders: ChatGptSourceHeaders | undefined,
  seed: string,
): void {
  for (const name of CODEX_PASSTHROUGH_HEADERS) {
    const value = readSourceHeader(sourceHeaders, name)
    if (!value) continue
    const redacted = redactCodexSourceHeader(name, value, seed)
    if (redacted !== undefined) target.set(name, redacted)
  }
}

function redactCodexSourceHeader(name: string, value: string, seed: string): string | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  if (name === 'accept-language' || name === 'x-codex-installation-id') return undefined
  if (name === 'x-codex-turn-metadata') return redactCodexTurnMetadata(normalized, seed)
  const namespace = codexHeaderIdentityNamespace(name)
  if (namespace) return stableCodexPseudonym(namespace, normalized, seed)
  // Capability and state headers are protocol inputs, not identity fields.
  // Keep their semantics while rejecting control characters and oversized
  // values that could otherwise carry local diagnostics or paths.
  return stripCodexControlCharacters(normalized).slice(0, 4096) || undefined
}

function codexHeaderIdentityNamespace(name: string): string | undefined {
  if (name === 'conversation_id') return 'conversation'
  if (name === 'session_id' || name === 'session-id') return 'session'
  if (name === 'thread-id') return 'thread'
  if (name === 'x-codex-parent-thread-id') return 'parent-thread'
  if (name === 'x-codex-window-id') return 'window'
  if (name === 'x-client-request-id') return 'request'
  return undefined
}

function stableCodexPseudonym(namespace: string, value: string, seed: string): string {
  const digest = createHash('sha256')
    .update(`stone+:codex-header:v1\0${seed}\0${namespace}\0${value}`)
    .digest('hex')
  return formatDeterministicUuid(digest)
}

function formatDeterministicUuid(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function redactCodexTurnMetadata(value: string, seed: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // Do not forward an opaque value that may contain a path or repository URL.
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const sanitized = sanitizeCodexMetadataObject(parsed as Record<string, unknown>, seed, 0)
  if (!sanitized) return undefined
  const encoded = JSON.stringify(sanitized)
  return Buffer.byteLength(encoded, 'utf8') <= 32 * 1024 ? encoded : undefined
}

function sanitizeCodexMetadataObject(
  source: Record<string, unknown>,
  seed: string,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > 5) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.trim().toLowerCase().replace(/[-\s]+/g, '_')
    if (isCodexLocationMetadataKey(normalizedKey)) continue
    const namespace = codexMetadataIdentityNamespace(normalizedKey)
    if (namespace) {
      if (typeof value === 'string' && value.trim()) result[key] = stableCodexPseudonym(namespace, value.trim(), seed)
      continue
    }
    if (typeof value === 'string') {
      const cleaned = stripCodexControlCharacters(value).trim()
      if (cleaned && !looksLikeLocalPathOrRepositoryUrl(cleaned)) result[key] = cleaned.slice(0, 4096)
      continue
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return typeof item === 'string' ? item.slice(0, 512) : item
        return sanitizeCodexMetadataObject(item as Record<string, unknown>, seed, depth + 1)
      }).filter((item) => item !== undefined)
      if (items.length) result[key] = items
      continue
    }
    if (value && typeof value === 'object') {
      const nested = sanitizeCodexMetadataObject(value as Record<string, unknown>, seed, depth + 1)
      if (nested && Object.keys(nested).length) result[key] = nested
      continue
    }
    if (typeof value === 'boolean' || typeof value === 'number') result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

function codexMetadataIdentityNamespace(key: string): string | undefined {
  if (key === 'installation_id' || key === 'installationid') return 'installation'
  if (key === 'session_id' || key === 'sessionid') return 'session'
  if (key === 'thread_id' || key === 'threadid') return 'thread'
  if (key === 'turn_id' || key === 'turnid') return 'turn'
  if (key === 'window_id' || key === 'windowid') return 'window'
  if (key === 'workspace_id' || key === 'workspaceid' || key === 'project_id' || key === 'projectid') return 'workspace'
  if (key === 'parent_thread_id' || key === 'parent_threadid') return 'parent-thread'
  if (key === 'parent_turn_id' || key === 'parent_turnid') return 'parent-turn'
  if (key === 'root_turn_id' || key === 'root_turnid') return 'root-turn'
  if (key === 'forked_from_thread_id' || key === 'forked_from_threadid') return 'fork-thread'
  return undefined
}

function isCodexLocationMetadataKey(key: string): boolean {
  return key === 'workspaces'
    || key === 'workspace'
    || key === 'cwd'
    || key === 'path'
    || key === 'git'
    || key === 'dirty'
    || key === 'tools'
    || key === 'mcp'
    || key === 'plugins'
    || key === 'skills'
    || /(?:^|_)(?:workspace_root|workspace_path|worktree|git_remote|remote_url|repo|repository|repository_url|repo_url|commit|commit_hash|commit_sha|branch)(?:_|$)/u.test(key)
}

function looksLikeLocalPathOrRepositoryUrl(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\|\/Users\/|\/home\/|file:|https?:\/\/|git@)/iu.test(value)
}

function stripCodexControlCharacters(value: string): string {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue
    result += character
  }
  return result
}

function readSourceHeader(source: ChatGptSourceHeaders | undefined, name: string): string | undefined {
  if (!source) return undefined
  if (source instanceof Headers) return source.get(name)?.trim() || undefined
  const match = Object.entries(source).find(([key]) => key.toLowerCase() === name)?.[1]
  const value = Array.isArray(match) ? match.join(', ') : match
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function withChatGptCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = sanitizeChatGptCodexInput(body.input)
  const upstream: Record<string, unknown> = {
    ...body,
    ...(input === body.input ? {} : { input }),
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

/**
 * Prepares a Responses history for the stateless ChatGPT Codex endpoint.
 *
 * The OAuth/Agent Identity endpoint forces `store:false`. Reasoning items are
 * therefore ephemeral and replaying them (even with a correctly shaped `rs_`
 * id) asks the upstream to look up state that it has already discarded. Older
 * relays also emitted `item_*` ids for ordinary messages and tool items; those
 * ids fail the Responses type-prefix validator after an account is switched
 * to ChatGPT OAuth. Normalize the legacy ids on the outbound copy only so the
 * local Codex session remains untouched.
 */
export function sanitizeChatGptCodexInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input

  const remappedIds = new Map<string, string>()
  for (const rawItem of input) {
    const item = chatGptCodexInputRecord(rawItem)
    if (!item) continue
    const type = chatGptCodexInputItemType(item)
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || type === 'reasoning') continue
    const normalized = normalizeChatGptCodexItemId(type, id)
    if (normalized && normalized !== id && !remappedIds.has(id)) {
      remappedIds.set(id, normalized)
    }
  }

  let changed = false
  const sanitized: unknown[] = []
  for (const rawItem of input) {
    const item = chatGptCodexInputRecord(rawItem)
    if (!item) {
      sanitized.push(rawItem)
      continue
    }

    const type = chatGptCodexInputItemType(item)
    if (type === 'reasoning') {
      changed = true
      continue
    }

    // References to a prior reasoning/legacy item cannot be resolved after
    // switching accounts because the OAuth endpoint is stateless. Keep valid
    // tool references intact, but drop these stale pointers entirely.
    if (type === 'item_reference') {
      const referenceId = typeof item.id === 'string' ? item.id.trim() : ''
      if (referenceId.startsWith('rs_') || referenceId.startsWith('item_')) {
        changed = true
        continue
      }
    }

    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const normalizedId = id ? remappedIds.get(id) : undefined
    if (normalizedId && normalizedId !== id) {
      sanitized.push({ ...item, id: normalizedId })
      changed = true
      continue
    }

    // Unknown legacy item kinds should not carry the relay's `item_*` id into
    // the strict upstream validator. Known kinds are remapped above; for an
    // unknown kind, omitting the optional id is safer than sending a guaranteed
    // invalid prefix. Tool pairing continues through call_id.
    if (id.startsWith('item_') && !normalizedId) {
      const copy = { ...item }
      delete copy.id
      sanitized.push(copy)
      changed = true
      continue
    }

    sanitized.push(rawItem)
  }

  return changed ? sanitized : input
}

const CHATGPT_CODEX_ITEM_ID_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  message: 'msg_',
  function_call: 'fc_',
  function_call_output: 'fco_',
  custom_tool_call: 'ctc_',
  custom_tool_call_output: 'ctco_',
  compaction: 'cmp_'
})

function chatGptCodexInputRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function chatGptCodexInputItemType(item: Record<string, unknown>): string {
  if (typeof item.type === 'string' && item.type.trim()) return item.type.trim()
  return typeof item.role === 'string' ? 'message' : ''
}

function normalizeChatGptCodexItemId(type: string, id: string): string | undefined {
  const prefix = CHATGPT_CODEX_ITEM_ID_PREFIXES[type]
  if (!prefix || id.startsWith(prefix)) return id

  // Preserve the useful suffix produced by the old relay when it is already
  // made of safe id characters. For arbitrary local ids, use a deterministic
  // digest so retries and item references remain stable without echoing the
  // original value into an upstream identifier.
  const legacySuffix = id.startsWith('item_') ? id.slice('item_'.length) : ''
  if (legacySuffix && /^[A-Za-z0-9_-]{1,96}$/.test(legacySuffix)) {
    return `${prefix}${legacySuffix}`
  }
  return `${prefix}${createHash('sha256').update(`${type}\0${id}`).digest('hex').slice(0, 48)}`
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
  return userAgent?.match(CODEX_USER_AGENT_VERSION)?.[1] ?? getCodexClientVersion()
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
    response = await fetchImplementation(getChatGptCodexModelsUrl(), {
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
    if (response.status === 401) throw new ChatGptCodexEndpointError(response.status, 'ChatGPT session access token was rejected.')
    if (response.status === 403) throw new ChatGptCodexEndpointError(response.status, 'ChatGPT account is not permitted to read Codex models.')
    throw new ChatGptCodexEndpointError(response.status, `ChatGPT Codex model endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    1024 * 1024,
    'ChatGPT Codex model response is too large.',
    signal,
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
  const usageHeaders = {
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
  }
  try {
    response = await fetchImplementation(CHATGPT_CODEX_USAGE_URL, {
      method: 'GET',
      headers: usageHeaders,
      signal
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex usage request timed out.')
    throw new Error('ChatGPT Codex usage endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new ChatGptCodexEndpointError(response.status, 'ChatGPT session access token was rejected.')
    if (response.status === 403) throw new ChatGptCodexEndpointError(response.status, 'ChatGPT account is not permitted to read Codex usage.')
    throw new ChatGptCodexEndpointError(response.status, `ChatGPT Codex usage endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(
    response,
    512 * 1024,
    'ChatGPT Codex usage response is too large.',
    signal,
  )
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('ChatGPT Codex usage endpoint returned invalid JSON.')
  }
  let quota = extractCodexQuotaFromUsagePayload(payload, now)
  if (!quota) throw new Error('ChatGPT Codex usage endpoint returned no quota windows.')
  if ((quota.resetCredits?.availableCount ?? 0) > 0 && !quota.resetCredits?.expiresAt?.length) {
    // The usage endpoint often exposes only a count. Expiry metadata is
    // optional and must never make an otherwise valid quota refresh fail.
    try {
      const detailResponse = await fetchImplementation(CHATGPT_CODEX_RESET_CREDITS_URL, {
        method: 'GET',
        headers: usageHeaders,
        signal,
      })
      if (detailResponse.ok) {
        const detailText = await readLimitedResponseText(
          detailResponse,
          256 * 1024,
          'ChatGPT Codex reset-credit response is too large.',
          signal,
        )
        const detailPayload = JSON.parse(detailText) as unknown
        const detailQuota = extractCodexQuotaFromUsagePayload({
          rate_limit_reset_credits: detailPayload,
        }, now)
        if (detailQuota?.resetCredits) {
          quota = { ...quota, resetCredits: detailQuota.resetCredits }
        }
      } else {
        await detailResponse.body?.cancel().catch(() => undefined)
      }
    } catch {
      // Optional metadata only; retain the authoritative available_count.
    }
  }
  return { quota, latencyMs: Math.max(0, Date.now() - startedAt) }
}

export async function consumeChatGptCodexResetCredit(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
  requestId?: string,
): Promise<ChatGptCodexResetCreditResult> {
  return consumeChatGptCodexResetCreditAuthorized({
    authorization: `Bearer ${bundle.accessToken}`,
    accountId: bundle.accountId,
  }, fetchImplementation, signal, requestId)
}

export async function consumeChatGptCodexResetCreditAuthorized(
  authorization: ChatGptCodexAuthorization,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
  requestId: string = randomUUID(),
): Promise<ChatGptCodexResetCreditResult> {
  let response: Response
  try {
    response = await fetchImplementation(CHATGPT_CODEX_RESET_CREDITS_CONSUME_URL, {
      method: 'POST',
      headers: {
        authorization: authorization.authorization,
        'chatgpt-account-id': authorization.accountId,
        ...(authorization.fedramp ? { 'x-openai-fedramp': 'true' } : {}),
        'openai-beta': 'codex-1',
        originator: 'Codex Desktop',
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
      body: JSON.stringify({ redeem_request_id: requestId }),
      signal,
    })
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new Error('ChatGPT Codex quota reset request timed out.')
    throw new Error('ChatGPT Codex quota reset endpoint could not be reached.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) throw new ChatGptCodexEndpointError(401, 'ChatGPT session access token was rejected.')
    if (response.status === 403) throw new ChatGptCodexEndpointError(403, 'ChatGPT account is not permitted to reset Codex quota.')
    if (response.status === 409) throw new ChatGptCodexEndpointError(409, 'No usable Codex quota reset credit is available.')
    throw new ChatGptCodexEndpointError(response.status, `ChatGPT Codex quota reset endpoint returned HTTP ${response.status}.`)
  }
  const text = await readLimitedResponseText(response, 128 * 1024, 'ChatGPT Codex quota reset response is too large.', signal)
  let payload: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      throw new Error('ChatGPT Codex quota reset endpoint returned invalid JSON.')
    }
  }
  const credit = payload.credit && typeof payload.credit === 'object' && !Array.isArray(payload.credit)
    ? payload.credit as Record<string, unknown>
    : undefined
  const windowsReset = typeof payload.windows_reset === 'number' && Number.isSafeInteger(payload.windows_reset)
    ? Math.max(0, payload.windows_reset)
    : undefined
  const redeemedAtText = typeof credit?.redeemed_at === 'string' ? credit.redeemed_at : undefined
  const redeemedAtParsed = redeemedAtText ? Date.parse(redeemedAtText) : Number.NaN
  return {
    ...(windowsReset === undefined ? {} : { windowsReset }),
    ...(Number.isFinite(redeemedAtParsed) ? { redeemedAt: redeemedAtParsed } : {}),
  }
}

async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
  oversizedMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let size = 0
  const onAbort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) throw abortReason(signal)
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw abortReason(signal)
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new Error(oversizedMessage)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
}

export function classifyChatGptCodexFailure(
  statusCode: number,
  headers?: HeadersInit,
  now = Date.now(),
  payload?: unknown,
): ProviderFailure {
  const transientCode = chatGptCodexErrorCode(payload)
  if (transientCode === 'server_is_overloaded' || transientCode === 'slow_down') {
    const retryAfterMs = Math.min(2_000, parseRetryAfter(headers, now) ?? 500)
    return {
      category: 'upstream',
      message: 'ChatGPT Codex is temporarily overloaded.',
      retryable: true,
      accountAction: 'none',
      statusCode: statusCode >= 400 ? statusCode : 503,
      retryAfterMs,
      retryAt: now + retryAfterMs,
      scope: 'request',
    }
  }
  // The Responses endpoint reports its hard per-request item cap as a plain
  // 400 ("array too long ... maximum length 16384"). Keep this in the
  // context-overflow vocabulary understood by DSH's automatic compactor;
  // otherwise the harness treats it as an unrecoverable generic invalid
  // request and never gets a chance to compact the session.
  if (statusCode === 400 && isChatGptCodexContextOverflowPayload(payload)) {
    return {
      category: 'invalid_request',
      message: 'The request history exceeds the upstream context limit and must be compacted before retrying.',
      retryable: false,
      accountAction: 'none',
      statusCode,
      scope: 'request',
    }
  }
  if (statusCode === 401) return { category: 'authentication', message: 'ChatGPT session access token was rejected.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 402) return { category: 'quota', message: 'ChatGPT account quota is depleted or requires payment.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 403) return { category: 'permission', message: 'ChatGPT account is not permitted to use the Codex endpoint.', retryable: true, accountAction: 'disable', statusCode }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers, now) ?? 30_000
    return { category: 'rate_limit', message: 'ChatGPT account rate limit reached.', retryable: true, accountAction: 'cooldown', statusCode, retryAfterMs, retryAt: now + retryAfterMs }
  }
  return { category: statusCode >= 500 ? 'upstream' : 'invalid_request', message: 'ChatGPT Codex endpoint rejected the request.', retryable: statusCode >= 500, accountAction: statusCode >= 500 ? 'cooldown' : 'none', statusCode }
}

function isChatGptCodexContextOverflowPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  let description = ''
  try {
    description = JSON.stringify(payload).toLowerCase()
  } catch {
    return false
  }
  return /\binput\b[^\n]{0,220}array\s+too\s+long[^\n]{0,220}maximum\s+length\s+\d+/.test(description)
}

function chatGptCodexErrorCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const response = root.response && typeof root.response === 'object'
    ? root.response as Record<string, unknown>
    : undefined
  const error = (response?.error && typeof response.error === 'object'
    ? response.error
    : root.error && typeof root.error === 'object'
      ? root.error
      : undefined) as Record<string, unknown> | undefined
  const value = error?.code ?? error?.type
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''
}
