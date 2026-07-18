import type { AccountCodexQuotaSnapshot, CodexQuotaWindow, Protocol } from '../../shared/types'
import { parseRetryAfter } from './failure'

const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000

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
  const headers = new Headers(source)
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
    if (signal.codexQuota) codexQuota = mergeCodexQuota(codexQuota, signal.codexQuota)
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
  const rateLimit = objectValue(root?.rate_limit)
  if (!rateLimit) return undefined
  const primary = codexPayloadWindow(rateLimit.primary_window, now)
  const secondary = codexPayloadWindow(rateLimit.secondary_window, now)
  return normalizeCodexWindows(primary, secondary, {
    observedAt: now,
    source: 'usage-endpoint',
    allowed: booleanValue(rateLimit.allowed),
    limitReached: booleanValue(rateLimit.limit_reached)
  })
}

export function codexQuotaIsExhausted(
  quota: AccountCodexQuotaSnapshot | undefined,
  now = Date.now()
): boolean {
  if (!quota) return false
  if (quota.allowed === false || quota.limitReached === true) return true
  return codexQuotaWindows(quota).some((window) =>
    window.usedPercent >= 100 && (window.resetAt === undefined || window.resetAt > now))
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
  const exhaustedResets = windows
    .filter((window) => window.usedPercent >= 100 && window.resetAt !== undefined && window.resetAt > now)
    .map((window) => window.resetAt!)
  if (exhaustedResets.length > 0) return Math.max(...exhaustedResets)
  const futureResets = windows
    .filter((window) => window.resetAt !== undefined && window.resetAt > now)
    .map((window) => window.resetAt!)
  return futureResets.length > 0 ? Math.min(...futureResets) : undefined
}

function codexQuotaWindows(quota: AccountCodexQuotaSnapshot): CodexQuotaWindow[] {
  return [quota.fiveHour, quota.sevenDay].filter((window): window is CodexQuotaWindow => Boolean(window))
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
  const usedPercent = nonNegativeFinite(window.used_percent)
  const windowSeconds = nonNegativeFinite(window.limit_window_seconds)
  const resetAt = absoluteResetAt(window.reset_at, now)
    ?? futureResetAt(window.reset_after_seconds, now)
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
  metadata: Omit<AccountCodexQuotaSnapshot, 'fiveHour' | 'sevenDay'>
): AccountCodexQuotaSnapshot | undefined {
  if (primary?.usedPercent === undefined && secondary?.usedPercent === undefined) return undefined

  let fiveHourRaw: RawCodexWindow | undefined
  let sevenDayRaw: RawCodexWindow | undefined
  const primaryDuration = primary?.windowSeconds
  const secondaryDuration = secondary?.windowSeconds
  if (primaryDuration !== undefined && secondaryDuration !== undefined) {
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
  return {
    ...metadata,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {})
  }
}

function publicCodexWindow(window: RawCodexWindow | undefined): CodexQuotaWindow | undefined {
  if (window?.usedPercent === undefined) return undefined
  return {
    usedPercent: window.usedPercent,
    ...(window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }),
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt })
  }
}

function mergeCodexQuota(
  earlier: AccountCodexQuotaSnapshot | undefined,
  later: AccountCodexQuotaSnapshot
): AccountCodexQuotaSnapshot {
  return {
    observedAt: later.observedAt,
    source: later.source,
    allowed: later.allowed ?? earlier?.allowed,
    limitReached: later.limitReached ?? earlier?.limitReached,
    fiveHour: mergeCodexWindow(earlier?.fiveHour, later.fiveHour),
    sevenDay: mergeCodexWindow(earlier?.sevenDay, later.sevenDay)
  }
}

function mergeCodexWindow(earlier: CodexQuotaWindow | undefined, later: CodexQuotaWindow | undefined): CodexQuotaWindow | undefined {
  if (!later) return earlier
  return {
    ...earlier,
    ...later
  }
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
  const nestedResponse = objectValue(root.response)
  const usage = mergeObjects(objectValue(nestedResponse?.usage), objectValue(root.usage), looksLikeOpenAIUsage(root) ? root : undefined)
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
  const inputTokens = tokenNumber(usage.input_tokens)
  const outputTokens = tokenNumber(usage.output_tokens)
  return compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: tokenNumber(usage.total_tokens) ?? safeTokenSum(inputTokens, outputTokens),
    cachedInputTokens: tokenNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: tokenNumber(usage.cache_creation_input_tokens)
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
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens })
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
