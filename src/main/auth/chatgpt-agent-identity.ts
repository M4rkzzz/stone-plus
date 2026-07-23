import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { createRequire } from 'node:module'
import type * as SodiumApi from 'libsodium-wrappers-sumo'

// The wrappers package's CommonJS entry correctly resolves its libsodium-sumo
// dependency; some published ESM builds reference a non-existent sibling WASM
// file. Use Node's package resolver explicitly in the Electron main process.
const sodium = createRequire(import.meta.url)('libsodium-wrappers-sumo') as typeof SodiumApi

/**
 * Durable Agent Identity material. This value is serialized into Stone's OS
 * protected credential vault; it must never be copied into an AppSnapshot.
 */
export interface ChatGptAgentIdentityBundle {
  version: 1
  agentRuntimeId: string
  /** Base64 encoded PKCS#8 v1 Ed25519 private key. */
  agentPrivateKey: string
  taskId?: string
  accountId: string
  userId: string
  email?: string
  planType?: string
  fedramp: boolean
  /** Original official Agent Identity JWT; retained only in the encrypted vault. */
  sourceJwt?: string
}

export interface ParsedChatGptAgentIdentities {
  identities: ChatGptAgentIdentityBundle[]
  warnings: string[]
}

export interface AgentIdentityAccess {
  bundle: ChatGptAgentIdentityBundle
  serialized: string
  /** Complete value for the Authorization header. */
  authorization: string
}

export interface AgentIdentityResolveOptions {
  signal?: AbortSignal
  timeoutMs?: number
  now?: () => Date
  authApiBaseUrl?: string
  /** Re-register even when a persisted task exists (invalid/expired task recovery). */
  forceTaskRegistration?: boolean
  expectedTaskId?: string
}

const DEFAULT_AUTH_API_BASE_URL = 'https://auth.openai.com/api/accounts'
const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000
const MAX_REGISTRATION_ATTEMPTS = 3
const registrationFlights = new Map<string, Promise<ChatGptAgentIdentityBundle>>()
const JWKS_URL = 'https://chatgpt.com/backend-api/wham/agent-identities/jwks'
const DEFAULT_JWKS_TTL_MS = 5 * 60_000
const MIN_JWKS_TTL_MS = 30_000
const MAX_JWKS_TTL_MS = 60 * 60_000
const JWKS_STALE_IF_ERROR_MS = 24 * 60 * 60_000
const MAX_JWKS_KEYS = 32

interface JwksCacheEntry {
  keys: Map<string, KeyObject>
  missingKids: Map<string, number>
  expiresAt: number
  staleUntil: number
  etag?: string
  lastModified?: string
  flight?: Promise<void>
}

const jwksCaches = new WeakMap<typeof fetch, Map<string, JwksCacheEntry>>()

export function parseChatGptAgentIdentityImport(content: string): ParsedChatGptAgentIdentities {
  const trimmed = content.trim()
  if (!trimmed) return { identities: [], warnings: [] }
  const values = importValues(trimmed)
  const identities: ChatGptAgentIdentityBundle[] = []
  for (const value of values) {
    const identity = parseAgentIdentityCandidate(value)
    if (!identity) continue
    const existingIndex = identities.findIndex((candidate) =>
      candidate.accountId === identity.accountId && candidate.userId === identity.userId)
    if (existingIndex >= 0) identities[existingIndex] = identity
    else identities.push(identity)
  }
  return {
    identities,
    warnings: identities.length
      ? [`已读取 ${identities.length} 个 Codex Agent Identity 账号。`]
      : []
  }
}

export function serializeChatGptAgentIdentity(bundle: ChatGptAgentIdentityBundle): string {
  return JSON.stringify(bundle)
}

export function deserializeChatGptAgentIdentity(value: string): ChatGptAgentIdentityBundle | undefined {
  try {
    const parsed = objectValue(JSON.parse(value))
    if (!parsed) return undefined
    const bundle = normalizeAgentIdentity(parsed)
    if (!bundle) return undefined
    privateSigningKey(bundle.agentPrivateKey)
    return bundle
  } catch {
    return undefined
  }
}

export function buildAgentAssertion(
  bundle: ChatGptAgentIdentityBundle,
  now: Date = new Date()
): string {
  if (!bundle.taskId?.trim()) throw new Error('Agent Identity task is not registered.')
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const payload = `${bundle.agentRuntimeId}:${bundle.taskId}:${timestamp}`
  const signature = sign(null, Buffer.from(payload), privateSigningKey(bundle.agentPrivateKey)).toString('base64')
  // JSON object insertion order matches the official envelope, while the
  // signature authenticates the colon-delimited payload rather than the JSON.
  const envelope = JSON.stringify({
    agent_runtime_id: bundle.agentRuntimeId,
    signature,
    task_id: bundle.taskId,
    timestamp
  })
  return `AgentAssertion ${Buffer.from(envelope).toString('base64url')}`
}

export async function resolveChatGptAgentIdentity(
  serialized: string,
  persistRotated: (serialized: string, expectedSourceSerialized?: string) => Promise<void>,
  fetchImplementation: typeof fetch = fetch,
  options: AgentIdentityResolveOptions = {}
): Promise<AgentIdentityAccess> {
  const current = deserializeChatGptAgentIdentity(serialized)
  if (!current) throw new Error('ChatGPT Agent Identity credential is invalid.')
  if (current.sourceJwt) {
    await verifyAgentIdentityJwt(current.sourceJwt, current, fetchImplementation, options.signal)
  }
  const needsTask = !current.taskId?.trim()
    || (options.forceTaskRegistration === true
      && (!options.expectedTaskId || current.taskId === options.expectedTaskId))
  const bundle = needsTask
    ? await getOrRegisterTask(current, serialized, persistRotated, fetchImplementation, options)
    : current
  const rotated = serializeChatGptAgentIdentity(bundle)
  return {
    bundle,
    serialized: rotated,
    authorization: buildAgentAssertion(bundle, options.now?.() ?? new Date())
  }
}

export function isInvalidAgentIdentityTaskResponse(status: number, payload: unknown): boolean {
  if (status !== 401) return false
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const lower = value.toLowerCase()
  const compact = lower.replace(/\s/g, '')
  return [
    '"code":"invalid_task_id"',
    '"code":"task_not_found"',
    '"code":"task_expired"',
    '"error":"invalid_task_id"'
  ].some((marker) => compact.includes(marker)) || [
    'invalid task_id', 'invalid task id', 'task_id is invalid', 'task id is invalid',
    'task not found', 'task expired', 'unknown task_id', 'unknown task id'
  ].some((marker) => lower.includes(marker))
}

export function agentIdentitySensitiveValues(serialized: string): string[] {
  const bundle = deserializeChatGptAgentIdentity(serialized)
  if (!bundle) return []
  return [bundle.agentPrivateKey, bundle.agentRuntimeId, bundle.taskId, bundle.accountId, bundle.userId]
    .filter((value): value is string => Boolean(value))
}

async function getOrRegisterTask(
  current: ChatGptAgentIdentityBundle,
  sourceSerialized: string,
  persistRotated: (serialized: string, expectedSourceSerialized?: string) => Promise<void>,
  fetchImplementation: typeof fetch,
  options: AgentIdentityResolveOptions
): Promise<ChatGptAgentIdentityBundle> {
  const key = createHash('sha256')
    .update(`${current.agentRuntimeId}\0${current.agentPrivateKey}`)
    .digest('base64url')
  const active = registrationFlights.get(key)
  if (active) return await waitWithAbort(active, options.signal)
  const registration = (async () => {
    // The shared registration must not be owned by whichever client happened
    // to arrive first. Callers cancel only their own wait below.
    const taskId = await registerAgentTask(current, fetchImplementation, { ...options, signal: undefined })
    const rotated = { ...current, taskId }
    await persistRotated(serializeChatGptAgentIdentity(rotated), sourceSerialized)
    return rotated
  })()
  registrationFlights.set(key, registration)
  void registration.finally(() => {
    if (registrationFlights.get(key) === registration) registrationFlights.delete(key)
  }).catch(() => undefined)
  return await waitWithAbort(registration, options.signal)
}

async function registerAgentTask(
  bundle: ChatGptAgentIdentityBundle,
  fetchImplementation: typeof fetch,
  options: AgentIdentityResolveOptions
): Promise<string> {
  const baseUrl = (options.authApiBaseUrl ?? DEFAULT_AUTH_API_BASE_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/v1/agent/${encodeURIComponent(bundle.agentRuntimeId)}/task/register`
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
    const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const signature = sign(
      null,
      Buffer.from(`${bundle.agentRuntimeId}:${timestamp}`),
      privateSigningKey(bundle.agentPrivateKey)
    ).toString('base64')
    const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS))
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      const response = await fetchImplementation(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ timestamp, signature }),
        signal
      })
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        const error = new Error(`Agent Identity task registration failed with status ${response.status}.`)
        if (!retryable || attempt === MAX_REGISTRATION_ATTEMPTS) throw error
        lastError = error
        await retryDelay(response.headers.get('retry-after'), attempt, options.signal)
        continue
      }
      const payload = objectValue(await response.json())
      const taskId = firstString(payload, ['task_id'], ['taskId'])
      if (taskId) return taskId
      const encryptedTaskId = firstString(payload, ['encrypted_task_id'], ['encryptedTaskId'])
      if (encryptedTaskId) return await decryptAgentIdentityTaskId(bundle, encryptedTaskId)
      throw new Error('Agent Identity task registration response omitted task_id.')
    } catch (cause) {
      if (options.signal?.aborted) throw abortReason(options.signal)
      const error = cause instanceof Error ? cause : new Error(String(cause))
      const retryable = error.name === 'TimeoutError'
        || error.name === 'AbortError'
        || /fetch|network|socket|connect|timed out/i.test(error.message)
      if (!retryable || attempt === MAX_REGISTRATION_ATTEMPTS) throw error
      lastError = error
      await retryDelay(undefined, attempt, options.signal)
    }
  }
  throw lastError ?? new Error('Agent Identity task registration failed.')
}

/**
 * Opens the official libsodium sealed-box task identifier. OpenAI encrypts the
 * task to the Curve25519 key deterministically derived from the Agent Identity
 * Ed25519 seed; this is the same conversion used by Cockpit Tools/CLIProxyAPI.
 */
export async function decryptAgentIdentityTaskId(
  bundle: ChatGptAgentIdentityBundle,
  encoded: string
): Promise<string> {
  const ciphertext = decodeEncryptedTaskId(encoded)
  if (ciphertext.byteLength <= 48 || ciphertext.byteLength > 64 * 1024) {
    throw new Error('Encrypted Agent Identity task ID has an invalid length.')
  }
  const signingKey = privateSigningKey(bundle.agentPrivateKey)
  const jwk = signingKey.export({ format: 'jwk' })
  if (jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new Error('Agent Identity private key cannot be converted for task decryption.')
  }
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'))
  if (seed.byteLength !== 32) throw new Error('Agent Identity private key seed is invalid.')
  await sodium.ready
  const signingPair = sodium.crypto_sign_seed_keypair(seed)
  const curvePrivate = sodium.crypto_sign_ed25519_sk_to_curve25519(signingPair.privateKey)
  const curvePublic = sodium.crypto_sign_ed25519_pk_to_curve25519(signingPair.publicKey)
  try {
    const plaintext = sodium.crypto_box_seal_open(ciphertext, curvePublic, curvePrivate)
    let taskId: string
    try {
      taskId = new TextDecoder('utf-8', { fatal: true }).decode(plaintext).trim()
    } catch {
      throw new Error('Decrypted Agent Identity task ID is not valid UTF-8.')
    }
    if (!taskId || taskId.length > 4_096 || hasUnsafeControls(taskId)) {
      throw new Error('Decrypted Agent Identity task ID is invalid.')
    }
    return taskId
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Decrypted Agent Identity')) throw cause
    throw new Error('Unable to decrypt the encrypted Agent Identity task ID.')
  } finally {
    sodium.memzero(seed)
    sodium.memzero(signingPair.privateKey)
    sodium.memzero(curvePrivate)
  }
}

function decodeEncryptedTaskId(encoded: string): Uint8Array {
  const normalized = encoded.trim()
  if (!normalized || normalized.length > 128 * 1024
    || normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('Encrypted Agent Identity task ID is not valid Base64.')
  }
  const decoded = Buffer.from(normalized, 'base64')
  const canonical = decoded.toString('base64')
  if (canonical !== normalized) throw new Error('Encrypted Agent Identity task ID is not valid Base64.')
  return new Uint8Array(decoded)
}

function hasUnsafeControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function parseAgentIdentityCandidate(value: unknown): ChatGptAgentIdentityBundle | undefined {
  const root = objectValue(value)
  if (!root) return undefined
  const credentials = objectValue(root.credentials)
  const jwt = typeof root.agent_identity === 'string' ? root.agent_identity.trim()
    : typeof root.agentIdentity === 'string' ? root.agentIdentity.trim()
      : typeof credentials?.agent_identity === 'string' ? credentials.agent_identity.trim()
        : typeof credentials?.agentIdentity === 'string' ? credentials.agentIdentity.trim()
          : undefined
  if (jwt) {
    const claims = jwtPayload(jwt)
    const normalized = normalizeAgentIdentity(claims)
    if (!normalized) throw new Error('Codex Agent Identity JWT is incomplete or invalid.')
    privateSigningKey(normalized.agentPrivateKey)
    return { ...normalized, sourceJwt: jwt }
  }
  const nested = objectValue(root.agent_identity) ?? objectValue(root.agentIdentity)
    ?? objectValue(credentials?.agent_identity) ?? objectValue(credentials?.agentIdentity)
  const candidate = nested ?? (looksLikeAgentIdentity(credentials) ? credentials : undefined)
    ?? (looksLikeAgentIdentity(root) ? root : undefined)
  if (!candidate) return undefined
  const merged = { ...root, ...credentials, ...candidate }
  const normalized = normalizeAgentIdentity(merged)
  if (!normalized) throw new Error('Codex Agent Identity credentials are incomplete or invalid.')
  privateSigningKey(normalized.agentPrivateKey)
  return normalized
}

function normalizeAgentIdentity(value: Record<string, unknown>): ChatGptAgentIdentityBundle | undefined {
  const agentRuntimeId = firstString(value, ['agentRuntimeId'], ['agent_runtime_id'])
  const agentPrivateKey = firstString(value, ['agentPrivateKey'], ['agent_private_key'])
  const accountId = firstString(value, ['accountId'], ['account_id'], ['chatgptAccountId'], ['chatgpt_account_id'])
  const userId = firstString(value, ['userId'], ['user_id'], ['chatgptUserId'], ['chatgpt_user_id'])
  if (!agentRuntimeId || !agentPrivateKey || !accountId || !userId) return undefined
  return {
    version: 1,
    agentRuntimeId,
    agentPrivateKey: normalizePrivateKey(agentPrivateKey),
    accountId,
    userId,
    fedramp: value.fedramp === true
      || value.chatgptAccountIsFedramp === true
      || value.chatgpt_account_is_fedramp === true,
    ...(firstString(value, ['taskId'], ['task_id']) ? { taskId: firstString(value, ['taskId'], ['task_id']) } : {}),
    ...(firstString(value, ['email']) ? { email: firstString(value, ['email']) } : {}),
    ...(firstString(value, ['planType'], ['plan_type']) ? { planType: firstString(value, ['planType'], ['plan_type']) } : {}),
    ...(firstString(value, ['sourceJwt']) ? { sourceJwt: firstString(value, ['sourceJwt']) } : {})
  }
}

function privateSigningKey(value: string): KeyObject {
  let der: Buffer
  try { der = Buffer.from(normalizePrivateKey(value), 'base64') } catch { throw new Error('Agent Identity private key is not valid base64.') }
  let key: KeyObject
  try { key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) } catch {
    throw new Error('Agent Identity private key is not valid PKCS#8.')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Agent Identity private key is not Ed25519.')
  return key
}

async function verifyAgentIdentityJwt(
  jwt: string,
  expected: ChatGptAgentIdentityBundle,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = jwt.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra !== undefined) {
    throw new Error('Agent Identity JWT has an invalid format.')
  }
  const header = objectValue(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')))
  const claims = jwtPayload(jwt)
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new Error('Agent Identity JWT must use a trusted RS256 key id.')
  }
  if (claims.iss !== 'https://chatgpt.com/codex-backend/agent-identity'
    || claims.aud !== 'codex-app-server') throw new Error('Agent Identity JWT issuer or audience is invalid.')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('Agent Identity JWT has expired.')
  const parsed = normalizeAgentIdentity(claims)
  if (!parsed || parsed.agentRuntimeId !== expected.agentRuntimeId
    || parsed.agentPrivateKey !== expected.agentPrivateKey
    || parsed.accountId !== expected.accountId || parsed.userId !== expected.userId) {
    throw new Error('Agent Identity JWT claims do not match the stored identity.')
  }
  const publicKey = await resolveJwksKey(header.kid, fetchImplementation, signal)
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url')
  )
  if (!valid) throw new Error('Agent Identity JWT signature is invalid.')
}

async function resolveJwksKey(
  kid: string,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<KeyObject> {
  let cache = jwksCaches.get(fetchImplementation)
  if (!cache) {
    cache = new Map()
    jwksCaches.set(fetchImplementation, cache)
  }
  let entry = cache.get(JWKS_URL)
  if (!entry) {
    entry = { keys: new Map(), missingKids: new Map(), expiresAt: 0, staleUntil: 0 }
    cache.set(JWKS_URL, entry)
  }
  const now = Date.now()
  const fresh = entry.keys.get(kid)
  if (fresh && entry.expiresAt > now) return fresh
  if ((entry.missingKids.get(kid) ?? 0) > now) throw new Error('Agent Identity JWT key id is not trusted.')
  try {
    if (!entry.flight) {
      const target = entry
      target.flight = refreshJwks(target, fetchImplementation).finally(() => {
        if (target.flight) target.flight = undefined
      })
    }
    const flight = entry.flight
    if (!flight) throw new Error('Agent Identity JWKS refresh did not start.')
    await waitWithAbort(flight, signal)
  } catch (error) {
    const stale = entry.keys.get(kid)
    if (stale && entry.staleUntil > now) return stale
    throw error
  }
  const key = entry.keys.get(kid)
  if (!key) {
    entry.missingKids.set(kid, Date.now() + MIN_JWKS_TTL_MS)
    throw new Error('Agent Identity JWT key id is not trusted.')
  }
  return key
}

async function refreshJwks(entry: JwksCacheEntry, fetchImplementation: typeof fetch): Promise<void> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (entry.etag) headers['if-none-match'] = entry.etag
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified
  const response = await fetchImplementation(JWKS_URL, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(DEFAULT_REGISTRATION_TIMEOUT_MS),
  })
  const now = Date.now()
  const ttl = jwksTtl(response.headers.get('cache-control'))
  if (response.status === 304 && entry.keys.size) {
    entry.expiresAt = now + ttl
    entry.staleUntil = entry.expiresAt + JWKS_STALE_IF_ERROR_MS
    return
  }
  if (!response.ok) throw new Error(`Agent Identity JWKS endpoint returned HTTP ${response.status}.`)
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Agent Identity JWKS response is too large.')
  const payload = objectValue(JSON.parse(text))
  const candidates = Array.isArray(payload?.keys) ? payload.keys.slice(0, MAX_JWKS_KEYS) : []
  const keys = new Map<string, KeyObject>()
  for (const value of candidates) {
    const jwk = objectValue(value)
    const kid = typeof jwk?.kid === 'string' ? jwk.kid.trim() : ''
    if (!kid || jwk?.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256')
      || (jwk.use !== undefined && jwk.use !== 'sig')
      || (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify'))) continue
    try {
      keys.set(kid, createPublicKey({ key: jwk as import('node:crypto').JsonWebKey, format: 'jwk' }))
    } catch { /* Ignore malformed individual rotation keys. */ }
  }
  if (!keys.size) throw new Error('Agent Identity JWKS contains no valid signing keys.')
  entry.keys = keys
  entry.missingKids.clear()
  entry.etag = response.headers.get('etag') ?? undefined
  entry.lastModified = response.headers.get('last-modified') ?? undefined
  entry.expiresAt = now + ttl
  entry.staleUntil = entry.expiresAt + JWKS_STALE_IF_ERROR_MS
}

function jwksTtl(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)
  const requested = match ? Number(match[1]) * 1000 : DEFAULT_JWKS_TTL_MS
  return Math.min(MAX_JWKS_TTL_MS, Math.max(MIN_JWKS_TTL_MS, Number.isFinite(requested) ? requested : DEFAULT_JWKS_TTL_MS))
}

function jwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('Agent Identity JWT has an invalid format.')
  try {
    const parsed = objectValue(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
    if (!parsed) throw new Error()
    return parsed
  } catch {
    throw new Error('Agent Identity JWT payload is invalid.')
  }
}

function normalizePrivateKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.includes('-----BEGIN')) return trimmed
  return trimmed.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
}

function looksLikeAgentIdentity(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false
  const mode = firstString(value, ['auth_mode'], ['authMode'])?.toLowerCase()
  return mode === 'agentidentity'
    || Boolean(firstString(value, ['agent_runtime_id'], ['agentRuntimeId']))
}

function importValues(content: string): unknown[] {
  try {
    const parsed = JSON.parse(content) as unknown
    if (Array.isArray(parsed)) return parsed
    const root = objectValue(parsed)
    if (Array.isArray(root?.accounts)) return root.accounts
    return [parsed]
  } catch {
    return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line) as unknown } catch { return line }
    })
  }
}

function firstString(object: Record<string, unknown> | undefined, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let value: unknown = object
    for (const key of path) value = objectValue(value)?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

async function retryDelay(retryAfter: string | null | undefined, attempt: number, signal?: AbortSignal): Promise<void> {
  let delayMs = Math.min(5_000, 200 * (2 ** Math.max(0, attempt - 1)))
  if (retryAfter) {
    const seconds = Number(retryAfter)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) delayMs = Math.min(30_000, seconds * 1000)
    else if (Number.isFinite(date)) delayMs = Math.min(30_000, Math.max(0, date - Date.now()))
  }
  // Small jitter prevents many identities from retrying a shared outage in lockstep.
  delayMs += Math.floor(Math.random() * Math.min(250, Math.max(1, delayMs / 4)))
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    function aborted(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(signal ? abortReason(signal) : new DOMException('The operation was aborted.', 'AbortError'))
    }
    const finished = (): void => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const timer = setTimeout(finished, delayMs)
    if (signal?.aborted) return aborted()
    signal?.addEventListener('abort', aborted, { once: true })
    timer.unref?.()
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}
