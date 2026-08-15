import type { AccountCodexQuotaSnapshot, CodexQuotaBucket, CodexQuotaWindow, Protocol } from '../../shared/types'
import { parseRetryAfter } from './failure'

const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000
/** A quota flag without a fresh observation must never keep an account blocked forever. */
export const CODEX_QUOTA_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export interface NormalizedQuotaWindow {
  limit?: number
  remaining?: number
  resetAt?: number
}

export interface NormalizedRateLimits {
  requests?: NormalizedQuotaWindow
  tokens?: NormalizedQuotaWindow
  inputTokens?: NormalizedQuotaWindow
  outputTokens?: NormalizedQuotaWindow
}

export interface NormalizedTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  reasoningTokens?: number
}

export interface NormalizedQuotaSignals {
  rateLimits?: NormalizedRateLimits
  codexQuota?: AccountCodexQuotaSnapshot
  retryAfterMs?: number
  retryAt?: number
  usage?: NormalizedTokenUsage
}

export interface QuotaSignalInput {
  protocol: Protocol
  headers?: HeadersInit
  payload?: unknown
  now?: number
}

/**
 * Extracts detached numeric signals only. No Header, Response, payload, or unknown body fields
 * are retained in the returned value.
 */
export function extractQuotaSignals(input: QuotaSignalInput): NormalizedQuotaSignals {
  const now = input.now ?? Date.now()
  const fromHeaders = extractRateLimitSignals(input.headers, input.protocol, now)
  const usage = extractProtocolUsage(input.protocol, input.payload)
  return mergeQuotaSignals(fromHeaders, usage ? { usage } : {})
}

export function extractRateLimitSignals(
  source: HeadersInit | undefined,
  protocol: Protocol,
  now = Date.now()
): NormalizedQuotaSignals {
  if (!source) return {}
  // Fetch responses already expose a Headers instance. Reusing it avoids
  // copying every upstream header on the per-request quota/health path.
  const headers = source instanceof Headers ? source : new Headers(source)
  const anthropic = protocol === 'anthropic-messages'

  const requests = quotaWindow(headers, now, {
    limit: prioritizedNames(anthropic, 'requests', 'limit'),
    remaining: prioritizedNames(anthropic, 'requests', 'remaining'),
    reset: prioritizedNames(anthropic, 'requests', 'reset')
  })
  const tokens = quotaWindow(headers, now, {
    limit: prioritizedNames(anthropic, 'tokens', 'limit'),
    remaining: prioritizedNames(anthropic, 'tokens', 'remaining'),
    reset: prioritizedNames(anthropic, 'tokens', 'reset')
  })
  const inputTokens = quotaWindow(headers, now, {
    limit: anthropicTokenNames(anthropic, 'input-tokens', 'limit'),
    remaining: anthropicTokenNames(anthropic, 'input-tokens', 'remaining'),
    reset: anthropicTokenNames(anthropic, 'input-tokens', 'reset')
  })
  const outputTokens = quotaWindow(headers, now, {
    limit: anthropicTokenNames(anthropic, 'output-tokens', 'limit'),
    remaining: anthropicTokenNames(anthropic, 'output-tokens', 'remaining'),
    reset: anthropicTokenNames(anthropic, 'output-tokens', 'reset')
  })
  const codexQuota = extractCodexQuotaFromHeaders(headers, now)

  const rateLimits = compactRateLimits({ requests, tokens, inputTokens, outputTokens })
  const retryAfterMs = parseRetryAfter(headers, now)
  return {
    ...(rateLimits ? { rateLimits } : {}),
    ...(codexQuota ? { codexQuota } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAt: now + retryAfterMs })
  }
}

export function extractProtocolUsage(protocol: Protocol, payload: unknown): NormalizedTokenUsage | undefined {
  const root = objectValue(payload)
  if (!root) return undefined

  switch (protocol) {
    case 'openai-chat':
    case 'openai-responses':
      return extractOpenAIUsage(root)
    case 'anthropic-messages':
      return extractAnthropicUsage(root)
    case 'gemini':
      return extractGeminiUsage(root)
    case 'kiro-claude':
      // Kiro usage is decoded from AWS event-stream frames by its dedicated parser.
      return undefined
  }
}

/**
 * Deep-merges detached signals from left to right. A later defined leaf wins while omitted
 * leaves preserve earlier observations.
 */
export function mergeQuotaSignals(...signals: ReadonlyArray<NormalizedQuotaSignals | undefined>): NormalizedQuotaSignals {
  let rateLimits: NormalizedRateLimits | undefined
  let codexQuota: AccountCodexQuotaSnapshot | undefined
  let usage: NormalizedTokenUsage | undefined
  let retryAfterMs: number | undefined
  let retryAt: number | undefined

  for (const signal of signals) {
    if (!signal) continue
    if (signal.rateLimits) rateLimits = mergeRateLimits(rateLimits, signal.rateLimits)
    if (signal.codexQuota) codexQuota = mergeCodexQuotaSnapshots(codexQuota, signal.codexQuota)
    if (signal.usage) usage = compactUsage({ ...usage, ...compactUsage(signal.usage) })
    if (signal.retryAfterMs !== undefined) retryAfterMs = signal.retryAfterMs
    if (signal.retryAt !== undefined) retryAt = signal.retryAt
  }

  return {
    ...(rateLimits ? { rateLimits } : {}),
    ...(codexQuota ? { codexQuota } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(usage ? { usage } : {})
  }
}

export function extractCodexQuotaFromHeaders(
  source: HeadersInit | Headers,
  now = Date.now()
): AccountCodexQuotaSnapshot | undefined {
  const headers = source instanceof Headers ? source : new Headers(source)
  const primary = codexHeaderWindow(headers, 'primary', now)
  const secondary = codexHeaderWindow(headers, 'secondary', now)
  return normalizeCodexWindows(primary, secondary, {
    observedAt: now,
    source: 'response-headers'
  })
}

export function extractCodexQuotaFromUsagePayload(
  payload: unknown,
  now = Date.now()
): AccountCodexQuotaSnapshot | undefined {
  const root = objectValue(payload)
  if (!root) return undefined
  // WHAM has appeared as both a flat object and `{ data: { usage: ... } }`.
  // Merge envelopes in order instead of selecting one shape so a provider can
  // add metadata at the outer level without hiding nested rate limits.
  const data = objectValue(root.data)
  const nestedUsage = objectValue(root.usage)
  const dataUsage = objectValue(data?.usage)
  const envelope = mergeObjects(root, data, nestedUsage, dataUsage)
  const rateLimit = objectValue(envelope?.rate_limit ?? envelope?.rateLimit)
  const resetCredits = codexResetCredits(
    envelope?.rate_limit_reset_credits ?? envelope?.rateLimitResetCredits,
    now,
  )
  const planType = sanitizePlanType(
    envelope?.plan_type ?? envelope?.planType ?? envelope?.subscription_plan ?? envelope?.subscriptionPlan,
  )
  const additionalBuckets = parseAdditionalCodexBuckets(envelope?.additional_rate_limits ?? envelope?.additionalRateLimits, now)
  if (!rateLimit && !resetCredits && !planType && additionalBuckets.length === 0) return undefined
  const hasWhamDetails = Boolean(resetCredits || planType || additionalBuckets.length)
  const primary = codexPayloadWindow(rateLimit?.primary_window ?? rateLimit?.primaryWindow, now)
  const secondary = codexPayloadWindow(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow, now)
  const allowed = booleanValue(rateLimit?.allowed)
  const limitReached = booleanValue(rateLimit?.limit_reached ?? rateLimit?.limitReached)
  return normalizeCodexWindows(primary, secondary, {
    observedAt: now,
    source: 'usage-endpoint',
    ...(allowed === undefined ? {} : { allowed }),
    ...(limitReached === undefined ? {} : { limitReached }),
    ...(planType ? { planType } : {}),
    ...(additionalBuckets.length ? { additionalBuckets } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    ...(hasWhamDetails ? { detailsObservedAt: now } : {}),
  })
}

function parseAdditionalCodexBuckets(value: unknown, now: number): CodexQuotaBucket[] {
  if (!Array.isArray(value)) return []
  const buckets: CodexQuotaBucket[] = []
  const seen = new Map<string, number>()
  for (const item of value) {
    const entry = objectValue(item)
    if (!entry) continue
    const rateLimit = objectValue(entry.rate_limit ?? entry.rateLimit)
    if (!rateLimit) continue
    const primary = codexPayloadWindow(rateLimit.primary_window ?? rateLimit.primaryWindow, now)
    const secondary = codexPayloadWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow, now)
    const allowed = booleanValue(rateLimit.allowed)
    const limitReached = booleanValue(rateLimit.limit_reached ?? rateLimit.limitReached)
    const idBase = safeQuotaBucketId(entry.metered_feature ?? entry.meteredFeature ?? entry.limit_name ?? entry.limitName)
    if (!idBase && !primary && !secondary && allowed === undefined && limitReached === undefined) continue
    const next = (seen.get(idBase || 'bucket') ?? 0) + 1
    seen.set(idBase || 'bucket', next)
    const id = idBase ? (next > 1 ? `${idBase}#${next}` : idBase) : `bucket-${next}`
    const projected = normalizeCodexWindows(primary, secondary, {
      observedAt: now,
      source: 'usage-endpoint',
      ...(allowed === undefined ? {} : { allowed }),
      ...(limitReached === undefined ? {} : { limitReached }),
    })
    if (!projected && allowed === undefined && limitReached === undefined) continue
    const label = safeQuotaBucketLabel(entry.limit_name ?? entry.limitName)
    buckets.push({
      id,
      ...(label ? { label } : {}),
      ...(projected?.fiveHour ? { fiveHour: projected.fiveHour } : {}),
      ...(projected?.sevenDay ? { sevenDay: projected.sevenDay } : {}),
      ...(projected?.monthly ? { monthly: projected.monthly } : {}),
      ...(allowed === undefined ? {} : { allowed }),
      ...(limitReached === undefined ? {} : { limitReached }),
    })
  }
  return buckets
}

function safeQuotaBucketId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 80)
    : ''
}

function safeQuotaBucketLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const valueTrimmed = [...value.trim()]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
    .slice(0, 80)
  return valueTrimmed || undefined
}

function sanitizePlanType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 64)
  return normalized || undefined
}

function codexResetCredits(
  value: unknown,
  now: number,
): AccountCodexQuotaSnapshot['resetCredits'] | undefined {
  const envelope = objectValue(value)
  const nestedValue = envelope?.rate_limit_reset_credits ?? envelope?.rateLimitResetCredits
  const nested = objectValue(nestedValue)
  const source = nested ?? envelope
  const rawCredits = Array.isArray(value)
    ? value
    : Array.isArray(nestedValue)
      ? nestedValue
      : [source?.credits, source?.items, source?.data].find(Array.isArray)
  const countValue = source?.available_count ?? source?.availableCount
  const numericCount = nonNegativeFinite(countValue)
  const count = numericCount !== undefined && Number.isInteger(numericCount) ? numericCount : undefined
  const expiresAt: number[] = []
  let availableFromList = 0
  for (const item of rawCredits ?? []) {
    const credit = objectValue(item)
    if (!credit) continue
    const resetType = resetCreditText(credit.reset_type ?? credit.resetType)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
    const status = resetCreditText(credit.status).toLowerCase()
    if (resetType && resetType !== 'codexratelimits') continue
    if (status && status !== 'available') continue
    const expiry = resetCreditTimestamp(credit.expires_at ?? credit.expiresAt)
    if (Number.isFinite(expiry) && expiry <= now) continue
    availableFromList += 1
    if (Number.isFinite(expiry)) expiresAt.push(expiry)
  }
  // The list may be a paginated/detail sample, while available_count is the
  // authoritative total. Only derive the count from list entries when the
  // summary is absent.
  const availableCount = count ?? (rawCredits ? availableFromList : undefined)
  if (availableCount === undefined) return undefined
  return {
    availableCount,
    ...(expiresAt.length ? { expiresAt: [...new Set(expiresAt)].sort((left, right) => left - right) } : {}),
  }
}

function resetCreditText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resetCreditTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.floor(value * 1_000) : Math.floor(value)
  }
  const parsed = Date.parse(resetCreditText(value))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * Interprets a Codex usage snapshot for recovery timing after an account has
 * already received a real quota rejection. Do not use this telemetry alone as
 * an admission gate: the Responses endpoint can still accept work at 100%.
 */
export function codexQuotaIsExhausted(
  quota: AccountCodexQuotaSnapshot | undefined,
  now = Date.now()
): boolean {
  if (!quota) return false
  const windows = codexQuotaWindows(quota)
  const fresh = now - quota.observedAt <= CODEX_QUOTA_STALE_AFTER_MS
  const hasActiveWindow = windows.some((window) => isActiveCodexWindow(window, quota.observedAt, now))
  const hasExpiredBoundary = windows.some((window) => window.resetAt !== undefined && window.resetAt <= now)
  // WHAM's top-level flag is a snapshot, not a permanent account state. Once
  // its observation is stale or the first known reset boundary has crossed,
  // release it and let the next real request establish the current state.
  if ((quota.allowed === false || quota.limitReached === true)
    && fresh && (windows.length === 0 || (hasActiveWindow && !hasExpiredBoundary))) return true
  return windows.some((window) => window.usedPercent >= 100 && isActiveCodexWindow(window, quota.observedAt, now))
}

/**
 * Returns the earliest safe time at which an exhausted account can be tried again.
 * When several windows are exhausted, all of them must reset, so the latest reset wins.
 * If the upstream only supplies a top-level exhausted flag, probe at the nearest known reset.
 */
export function codexQuotaCooldownUntil(
  quota: AccountCodexQuotaSnapshot | undefined,
  now = Date.now()
): number | undefined {
  if (!codexQuotaIsExhausted(quota, now) || !quota) return undefined
  const windows = codexQuotaWindows(quota)
  const activeExhaustedWindows = windows
    .filter((window) => window.usedPercent >= 100 && isActiveCodexWindow(window, quota.observedAt, now))
  if (activeExhaustedWindows.some((window) => window.resetAt === undefined)) return undefined
  const exhaustedResets = activeExhaustedWindows
    .map((window) => window.resetAt!)
  if (exhaustedResets.length > 0) return Math.max(...exhaustedResets)
  // Once the first known boundary in a top-level-only exhaustion snapshot has
  // passed, that snapshot is stale. Recheck soon instead of promoting the
  // cooldown to an unrelated, non-exhausted longer window.
  if (windows.some((window) => window.resetAt !== undefined && window.resetAt <= now)) return undefined
  const futureResets = windows
    .filter((window) => window.resetAt !== undefined && window.resetAt > now)
    .map((window) => window.resetAt!)
  return futureResets.length > 0 ? Math.min(...futureResets) : undefined
}

function codexQuotaWindows(quota: AccountCodexQuotaSnapshot): CodexQuotaWindow[] {
  // Additional feature buckets are model-scoped. A depleted Spark/model
  // bucket must not cool the entire account or unrelated model routes.
  return [quota.fiveHour, quota.sevenDay, quota.monthly]
    .filter((window): window is CodexQuotaWindow => Boolean(window))
}

function isActiveCodexWindow(window: CodexQuotaWindow, observedAt: number, now: number): boolean {
  if (window.resetAt !== undefined) return window.resetAt > now
  return now - observedAt <= CODEX_QUOTA_STALE_AFTER_MS
}

export function parseQuotaResetAt(value: string | undefined, now = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined

  const numeric = parsePlainNumber(normalized)
  if (numeric !== undefined) {
    if (numeric >= 1_000_000_000_000) return safeTimestamp(numeric, now)
    if (numeric >= 1_000_000_000) return safeTimestamp(numeric * 1000, now)
    const durationMs = numeric * 1000
    return durationMs <= MAX_DURATION_MS ? now + Math.ceil(durationMs) : undefined
  }

  const durationMs = parseDurationMs(normalized)
  if (durationMs !== undefined) return now + durationMs

  if (!isRecognizedDate(normalized)) return undefined
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined
}

interface RawCodexWindow {
  usedPercent?: number
  windowSeconds?: number
  resetAt?: number
}

function codexHeaderWindow(headers: Headers, slot: 'primary' | 'secondary', now: number): RawCodexWindow | undefined {
  const prefix = `x-codex-${slot}-`
  const usedPercent = parseNonNegativeNumber(headers.get(`${prefix}used-percent`))
  const windowMinutes = parseNonNegativeNumber(headers.get(`${prefix}window-minutes`))
  const resetAfterSeconds = parseNonNegativeNumber(headers.get(`${prefix}reset-after-seconds`))
  if (usedPercent === undefined && windowMinutes === undefined && resetAfterSeconds === undefined) return undefined
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(windowMinutes === undefined || !Number.isSafeInteger(Math.ceil(windowMinutes * 60))
      ? {}
      : { windowSeconds: windowMinutes * 60 }),
    ...(resetAfterSeconds === undefined ? {} : { resetAt: safeFutureTime(now, resetAfterSeconds) })
  }
}

function codexPayloadWindow(value: unknown, now: number): RawCodexWindow | undefined {
  const window = objectValue(value)
  if (!window) return undefined
  const usedPercent = nonNegativeFinite(window.used_percent ?? window.usedPercent)
  const windowSeconds = nonNegativeFinite(window.limit_window_seconds ?? window.limitWindowSeconds)
  const resetAt = absoluteResetAt(window.reset_at ?? window.resetAt, now)
    ?? futureResetAt(window.reset_after_seconds ?? window.resetAfterSeconds, now)
  if (usedPercent === undefined && windowSeconds === undefined && resetAt === undefined) return undefined
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(resetAt === undefined ? {} : { resetAt })
  }
}

function normalizeCodexWindows(
  primary: RawCodexWindow | undefined,
  secondary: RawCodexWindow | undefined,
  metadata: Omit<AccountCodexQuotaSnapshot, 'fiveHour' | 'sevenDay' | 'monthly'>
): AccountCodexQuotaSnapshot | undefined {
  if (primary?.usedPercent === undefined && secondary?.usedPercent === undefined
    && metadata.resetCredits === undefined
    && metadata.allowed === undefined
    && metadata.limitReached === undefined
    && metadata.planType === undefined
    && !(metadata.additionalBuckets && metadata.additionalBuckets.length > 0)) return undefined

  let fiveHourRaw: RawCodexWindow | undefined
  let sevenDayRaw: RawCodexWindow | undefined
  let monthlyRaw: RawCodexWindow | undefined
  const primaryDuration = primary?.windowSeconds
  const secondaryDuration = secondary?.windowSeconds
  const all = [primary, secondary].filter((window): window is RawCodexWindow => Boolean(window))
  const monthlyCandidate = all.find((window) => isMonthlyQuotaDuration(window.windowSeconds))
  if (monthlyCandidate) {
    monthlyRaw = monthlyCandidate
    const rest = all.filter((window) => window !== monthlyCandidate)
    const ordered = [...rest].sort((left, right) => (left.windowSeconds ?? Number.MAX_SAFE_INTEGER)
      - (right.windowSeconds ?? Number.MAX_SAFE_INTEGER))
    if (ordered[0]?.windowSeconds !== undefined && ordered[0].windowSeconds <= 6 * 60 * 60) {
      fiveHourRaw = ordered.shift()
    }
    sevenDayRaw = ordered[0]
  } else if (primaryDuration !== undefined && secondaryDuration !== undefined) {
    if (primaryDuration < secondaryDuration) {
      fiveHourRaw = primary
      sevenDayRaw = secondary
    } else {
      fiveHourRaw = secondary
      sevenDayRaw = primary
    }
  } else if (primaryDuration !== undefined) {
    if (primaryDuration <= 6 * 60 * 60) {
      fiveHourRaw = primary
      sevenDayRaw = secondary
    } else {
      fiveHourRaw = secondary
      sevenDayRaw = primary
    }
  } else if (secondaryDuration !== undefined) {
    if (secondaryDuration <= 6 * 60 * 60) {
      fiveHourRaw = secondary
      sevenDayRaw = primary
    } else {
      fiveHourRaw = primary
      sevenDayRaw = secondary
    }
  } else {
    fiveHourRaw = secondary
    sevenDayRaw = primary
  }

  const fiveHour = publicCodexWindow(fiveHourRaw)
  const sevenDay = publicCodexWindow(sevenDayRaw)
  const monthly = publicCodexWindow(monthlyRaw)
  return {
    ...metadata,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(monthly ? { monthly } : {})
  }
}

function isMonthlyQuotaDuration(seconds: number | undefined): boolean {
  return seconds !== undefined && seconds >= 27 * 24 * 60 * 60 && seconds <= 32 * 24 * 60 * 60
}

function publicCodexWindow(window: RawCodexWindow | undefined): CodexQuotaWindow | undefined {
  if (window?.usedPercent === undefined) return undefined
  return {
    usedPercent: window.usedPercent,
    ...(window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }),
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt })
  }
}

export function mergeCodexQuotaSnapshots(
  earlier: AccountCodexQuotaSnapshot | undefined,
  later: AccountCodexQuotaSnapshot
): AccountCodexQuotaSnapshot {
  if (later.source === 'usage-endpoint') {
    return {
      ...later,
      ...(later.fiveHour ? { fiveHour: { ...later.fiveHour } } : {}),
      ...(later.sevenDay ? { sevenDay: { ...later.sevenDay } } : {}),
      ...(later.monthly ? { monthly: { ...later.monthly } } : {}),
      ...(later.additionalBuckets ? {
        additionalBuckets: later.additionalBuckets.map((bucket) => ({
          ...bucket,
          ...(bucket.fiveHour ? { fiveHour: { ...bucket.fiveHour } } : {}),
          ...(bucket.sevenDay ? { sevenDay: { ...bucket.sevenDay } } : {}),
          ...(bucket.monthly ? { monthly: { ...bucket.monthly } } : {}),
        }))
      } : {})
    }
  }
  const previousIsFresh = earlier !== undefined
    && later.observedAt - earlier.observedAt <= CODEX_QUOTA_STALE_AFTER_MS
  const mergedFiveHour = mergeCodexWindow(earlier?.fiveHour, later.fiveHour, later.observedAt, previousIsFresh)
  const mergedSevenDay = mergeCodexWindow(earlier?.sevenDay, later.sevenDay, later.observedAt, previousIsFresh)
  const mergedMonthly = mergeCodexWindow(earlier?.monthly, later.monthly, later.observedAt, previousIsFresh)
  const earlierDetailsObservedAt = earlier?.detailsObservedAt
    ?? (earlier?.source === 'usage-endpoint' && hasCodexQuotaDetails(earlier) ? earlier.observedAt : undefined)
  const laterDetailsObservedAt = later.detailsObservedAt
  const preserveEarlierDetails = earlierDetailsObservedAt !== undefined
    && later.observedAt - earlierDetailsObservedAt <= CODEX_QUOTA_STALE_AFTER_MS
  const additionalBuckets = mergeAdditionalCodexBuckets(
    earlier?.additionalBuckets,
    later.additionalBuckets,
    later.observedAt,
    preserveEarlierDetails,
  )
  const resetCredits = later.resetCredits ?? (preserveEarlierDetails ? earlier?.resetCredits : undefined)
  const planType = later.planType ?? (preserveEarlierDetails ? earlier?.planType : undefined)
  const detailsObservedAt = laterDetailsObservedAt
    ?? (later.resetCredits || later.planType || later.additionalBuckets ? later.observedAt : undefined)
    ?? (preserveEarlierDetails ? earlierDetailsObservedAt : undefined)
  return {
    observedAt: later.observedAt,
    source: later.source,
    // A newer successful response-header observation supersedes stale WHAM
    // top-level flags even when the response does not repeat those fields.
    ...(later.allowed === undefined ? {} : { allowed: later.allowed }),
    ...(later.limitReached === undefined ? {} : { limitReached: later.limitReached }),
    ...(resetCredits ? { resetCredits: { ...resetCredits, expiresAt: resetCredits.expiresAt?.slice() } } : {}),
    ...(planType ? { planType } : {}),
    ...(detailsObservedAt === undefined ? {} : { detailsObservedAt }),
    ...(mergedFiveHour ? { fiveHour: mergedFiveHour } : {}),
    ...(mergedSevenDay ? { sevenDay: mergedSevenDay } : {}),
    ...(mergedMonthly ? { monthly: mergedMonthly } : {}),
    ...(additionalBuckets.length ? { additionalBuckets } : {})
  }
}

function hasCodexQuotaDetails(quota: AccountCodexQuotaSnapshot): boolean {
  return Boolean(quota.resetCredits || quota.planType || quota.additionalBuckets?.length)
}

function mergeCodexWindow(
  earlier: CodexQuotaWindow | undefined,
  later: CodexQuotaWindow | undefined,
  observedAt: number,
  preserveEarlier: boolean,
): CodexQuotaWindow | undefined {
  if (!later) {
    if (!preserveEarlier) return undefined
    if (earlier?.resetAt !== undefined && earlier.resetAt <= observedAt) return undefined
    return earlier
  }
  if (earlier?.resetAt !== undefined && earlier.resetAt <= observedAt) return { ...later }
  return {
    ...earlier,
    ...later
  }
}

function mergeAdditionalCodexBuckets(
  earlier: CodexQuotaBucket[] | undefined,
  later: CodexQuotaBucket[] | undefined,
  observedAt: number,
  preserveEarlier: boolean,
): CodexQuotaBucket[] {
  if (later) return later.map((bucket) => ({ ...bucket }))
  if (!preserveEarlier) return []
  return (earlier ?? []).flatMap((bucket) => {
    const windows = [bucket.fiveHour, bucket.sevenDay, bucket.monthly]
    if (windows.some((window) => window?.resetAt !== undefined && window.resetAt <= observedAt)) return []
    return [{ ...bucket }]
  })
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  return value === null ? undefined : parseQuotaNumber(value)
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function futureResetAt(value: unknown, now: number): number | undefined {
  const seconds = nonNegativeFinite(value)
  return seconds === undefined ? undefined : safeFutureTime(now, seconds)
}

function absoluteResetAt(value: unknown, now: number): number | undefined {
  const numeric = nonNegativeFinite(value)
  if (numeric === undefined || numeric < 1_000_000_000) return undefined
  const timestamp = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000
  return Number.isSafeInteger(Math.ceil(timestamp)) ? Math.max(now, Math.ceil(timestamp)) : undefined
}

function safeFutureTime(now: number, seconds: number): number | undefined {
  const timestamp = now + seconds * 1000
  return Number.isSafeInteger(Math.ceil(timestamp)) ? Math.ceil(timestamp) : undefined
}

function quotaWindow(
  headers: Headers,
  now: number,
  names: { limit: string[]; remaining: string[]; reset: string[] }
): NormalizedQuotaWindow | undefined {
  const limit = firstParsedHeader(headers, names.limit, parseQuotaNumber)
  const remaining = firstParsedHeader(headers, names.remaining, parseQuotaNumber)
  const resetAt = firstParsedHeader(headers, names.reset, (value) => parseQuotaResetAt(value, now))
  if (limit === undefined && remaining === undefined && resetAt === undefined) return undefined
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAt === undefined ? {} : { resetAt })
  }
}

function prioritizedNames(
  anthropic: boolean,
  resource: 'requests' | 'tokens',
  field: 'limit' | 'remaining' | 'reset'
): string[] {
  return [
    ...(anthropic ? [`anthropic-ratelimit-${resource}-${field}`] : []),
    `x-ratelimit-${field}-${resource}`,
    `x-rate-limit-${field}-${resource}`,
    ...(resource === 'requests'
      ? [`x-ratelimit-${field}`, `x-rate-limit-${field}`, `ratelimit-${field}`, `rate-limit-${field}`]
      : [])
  ]
}

function anthropicTokenNames(
  anthropic: boolean,
  resource: 'input-tokens' | 'output-tokens',
  field: 'limit' | 'remaining' | 'reset'
): string[] {
  if (!anthropic) return []
  return [
    `anthropic-ratelimit-${resource}-${field}`,
    `x-ratelimit-${field}-${resource}`,
    `x-rate-limit-${field}-${resource}`
  ]
}

function firstParsedHeader(
  headers: Headers,
  names: string[],
  parser: (value: string) => number | undefined
): number | undefined {
  for (const name of names) {
    const value = headers.get(name)
    if (value === null) continue
    const parsed = parser(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function parseQuotaNumber(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*(?:[;,]).*)?$/)
  if (!match) return undefined
  return parsePlainNumber(match[1])
}

function parsePlainNumber(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : undefined
}

function parseDurationMs(value: string): number | undefined {
  const unitMs: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  }
  const expression = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi
  let cursor = 0
  let total = 0
  let matched = false
  for (;;) {
    const match = expression.exec(value)
    if (!match) break
    if (match.index !== cursor) return undefined
    const amount = parsePlainNumber(match[1])
    if (amount === undefined) return undefined
    total += amount * unitMs[match[2].toLowerCase()]
    if (!Number.isFinite(total) || total > MAX_DURATION_MS) return undefined
    cursor = expression.lastIndex
    matched = true
  }
  return matched && cursor === value.length ? Math.ceil(total) : undefined
}

function isRecognizedDate(value: string): boolean {
  const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
  return isoDate.test(value) || httpDate.test(value)
}

function safeTimestamp(timestamp: number, now: number): number | undefined {
  return Number.isFinite(timestamp) && timestamp <= Number.MAX_SAFE_INTEGER
    ? Math.max(now, Math.ceil(timestamp))
    : undefined
}

function extractOpenAIUsage(root: Record<string, unknown>): NormalizedTokenUsage | undefined {
  const data = objectValue(root.data)
  const nestedResponse = objectValue(root.response)
  const dataResponse = objectValue(data?.response)
  const usage = mergeObjects(
    objectValue(dataResponse?.usage),
    objectValue(data?.usage),
    looksLikeOpenAIUsage(data ?? {}) ? data : undefined,
    objectValue(nestedResponse?.usage),
    objectValue(root.usage),
    looksLikeOpenAIUsage(root) ? root : undefined,
  )
  if (!usage) return undefined
  const inputDetails = mergeObjects(objectValue(usage.prompt_tokens_details), objectValue(usage.input_tokens_details))
  const outputDetails = mergeObjects(objectValue(usage.completion_tokens_details), objectValue(usage.output_tokens_details))
  const inputTokens = tokenNumber(usage.input_tokens) ?? tokenNumber(usage.prompt_tokens)
  const outputTokens = tokenNumber(usage.output_tokens) ?? tokenNumber(usage.completion_tokens)
  return compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: tokenNumber(usage.total_tokens) ?? safeTokenSum(inputTokens, outputTokens),
    cachedInputTokens: tokenNumber(inputDetails?.cached_tokens),
    reasoningTokens: tokenNumber(outputDetails?.reasoning_tokens)
  })
}

function extractAnthropicUsage(root: Record<string, unknown>): NormalizedTokenUsage | undefined {
  const message = objectValue(root.message)
  const usage = mergeObjects(objectValue(message?.usage), objectValue(root.usage), looksLikeAnthropicUsage(root) ? root : undefined)
  if (!usage) return undefined
  const uncachedInputTokens = tokenNumber(usage.input_tokens)
  const outputTokens = tokenNumber(usage.output_tokens)
  const cachedInputTokens = tokenNumber(usage.cache_read_input_tokens)
  const cacheCreation = objectValue(usage.cache_creation)
  const cacheCreation5mInputTokens = tokenNumber(cacheCreation?.ephemeral_5m_input_tokens)
  const cacheCreation1hInputTokens = tokenNumber(cacheCreation?.ephemeral_1h_input_tokens)
  const cacheCreationInputTokens = tokenNumber(usage.cache_creation_input_tokens)
    ?? safeTokenParts(cacheCreation5mInputTokens, cacheCreation1hInputTokens)
  const inputTokens = safeTokenParts(
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens
  )
  const outputDetails = objectValue(usage.output_tokens_details)
  return compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: tokenNumber(usage.total_tokens) ?? safeTokenSum(inputTokens, outputTokens),
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    reasoningTokens: tokenNumber(outputDetails?.thinking_tokens)
  })
}

function extractGeminiUsage(root: Record<string, unknown>): NormalizedTokenUsage | undefined {
  const response = objectValue(root.response)
  const usage = mergeObjects(objectValue(response?.usageMetadata), objectValue(root.usageMetadata), looksLikeGeminiUsage(root) ? root : undefined)
  if (!usage) return undefined
  const inputTokens = tokenNumber(usage.promptTokenCount)
  const outputTokens = tokenNumber(usage.candidatesTokenCount)
  return compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: tokenNumber(usage.totalTokenCount) ?? safeTokenSum(inputTokens, outputTokens),
    cachedInputTokens: tokenNumber(usage.cachedContentTokenCount),
    reasoningTokens: tokenNumber(usage.thoughtsTokenCount)
  })
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function safeTokenSum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined
  const total = left + right
  return Number.isSafeInteger(total) ? total : undefined
}

function safeTokenParts(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  if (present.length === 0) return undefined
  const total = present.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

function looksLikeOpenAIUsage(value: Record<string, unknown>): boolean {
  return 'input_tokens' in value || 'prompt_tokens' in value || 'completion_tokens' in value
}

function looksLikeAnthropicUsage(value: Record<string, unknown>): boolean {
  return 'input_tokens' in value || 'output_tokens' in value || 'cache_read_input_tokens' in value
}

function looksLikeGeminiUsage(value: Record<string, unknown>): boolean {
  return 'promptTokenCount' in value || 'candidatesTokenCount' in value || 'totalTokenCount' in value
}

function mergeObjects(...objects: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const object of objects) {
    if (object) Object.assign(result, object)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function mergeRateLimits(
  base: NormalizedRateLimits | undefined,
  override: NormalizedRateLimits
): NormalizedRateLimits | undefined {
  return compactRateLimits({
    requests: mergeWindow(base?.requests, override.requests),
    tokens: mergeWindow(base?.tokens, override.tokens),
    inputTokens: mergeWindow(base?.inputTokens, override.inputTokens),
    outputTokens: mergeWindow(base?.outputTokens, override.outputTokens)
  })
}

function mergeWindow(
  base: NormalizedQuotaWindow | undefined,
  override: NormalizedQuotaWindow | undefined
): NormalizedQuotaWindow | undefined {
  if (!base && !override) return undefined
  return {
    ...base,
    ...(override?.limit === undefined ? {} : { limit: override.limit }),
    ...(override?.remaining === undefined ? {} : { remaining: override.remaining }),
    ...(override?.resetAt === undefined ? {} : { resetAt: override.resetAt })
  }
}

function compactRateLimits(rateLimits: NormalizedRateLimits): NormalizedRateLimits | undefined {
  const result: NormalizedRateLimits = {
    ...(rateLimits.requests && Object.keys(rateLimits.requests).length > 0 ? { requests: { ...rateLimits.requests } } : {}),
    ...(rateLimits.tokens && Object.keys(rateLimits.tokens).length > 0 ? { tokens: { ...rateLimits.tokens } } : {}),
    ...(rateLimits.inputTokens && Object.keys(rateLimits.inputTokens).length > 0 ? { inputTokens: { ...rateLimits.inputTokens } } : {}),
    ...(rateLimits.outputTokens && Object.keys(rateLimits.outputTokens).length > 0 ? { outputTokens: { ...rateLimits.outputTokens } } : {})
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function compactUsage(usage: NormalizedTokenUsage): NormalizedTokenUsage | undefined {
  const result: NormalizedTokenUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
    ...(usage.cacheCreation5mInputTokens === undefined ? {} : { cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens }),
    ...(usage.cacheCreation1hInputTokens === undefined ? {} : { cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens })
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
