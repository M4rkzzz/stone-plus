import { parseRetryAfter } from './failure'
import type { ProviderFailure } from './types'

export const GROK_BUILD_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const GROK_BUILD_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription'
export const GROK_BUILD_CLIENT_VERSION = '0.2.111'
export const GROK_BUILD_CLIENT_IDENTIFIER = 'grok-shell'
export const GROK_BUILD_TOKEN_AUTH = 'xai-grok-cli'
export const GROK_BUILD_USER_AGENT = `grok-shell/${GROK_BUILD_CLIENT_VERSION} (linux; x86_64)`

const GROK_BUILD_BILLING_TIMEOUT_MS = 30_000
const MAX_GROK_BUILD_BILLING_BYTES = 2 * 1024 * 1024
const GROK_BUILD_USER_TIMEOUT_MS = 10_000
const MAX_GROK_BUILD_USER_BYTES = 1024 * 1024

export type GrokBuildClientMode = 'headless' | 'interactive'
export type GrokBuildPaidClassification = 'paid' | 'free' | 'unknown'

export interface GrokBuildHeaderInput {
  accessToken: string
  mode?: GrokBuildClientMode
  subjectId?: string
  email?: string
  accept?: string
  acceptEncoding?: string
}

export interface GrokBuildQuotaPeriod {
  type?: string
  start?: string
  end?: string
}

export interface GrokBuildQuotaPlan {
  code?: string
  name?: string
}

export interface GrokBuildMonthlyQuota {
  limit?: number
  used?: number
  remaining?: number
}

export interface GrokBuildOnDemandQuota {
  enabled?: boolean
  cap?: number
  used?: number
  remaining?: number
}

export interface GrokBuildQuotaSnapshot {
  /** Omitted when the response contains no trustworthy percentage basis. */
  usedPercent?: number
  /** Omitted rather than fabricated for an all-zero or otherwise unknown response. */
  remainingPercent?: number
  /** The preferred direct quota basis: on-demand first, then monthly. */
  limit?: number
  used?: number
  remaining?: number
  monthly?: GrokBuildMonthlyQuota
  onDemand?: GrokBuildOnDemandQuota
  prepaidBalance?: number
  unifiedBilling?: boolean
  topUpMethod?: string
  period?: GrokBuildQuotaPeriod
  resetAt?: number
  plan?: GrokBuildQuotaPlan
  paidClassification: GrokBuildPaidClassification
  observedAt: number
  source: 'grok-build-billing'
}

export interface GrokBuildQuotaSuccess {
  ok: true
  status: 'available'
  statusCode: number
  latencyMs: number
  quota: GrokBuildQuotaSnapshot
}

export interface GrokBuildQuotaUnavailable {
  ok: false
  status: 'unavailable'
  statusCode?: number
  latencyMs: number
  failure: ProviderFailure
}

export type GrokBuildQuotaResult = GrokBuildQuotaSuccess | GrokBuildQuotaUnavailable

export interface GrokBuildQuotaQueryOptions {
  fetchImplementation?: typeof fetch
  signal?: AbortSignal
  now?: () => number
  timeoutMs?: number
  subjectId?: string
  email?: string
}

/**
 * Applies the stable Grok Build client identity without retaining the token.
 * Callers may override transport content negotiation for streaming inference.
 */
export function applyGrokBuildHeaders(headers: Headers, input: GrokBuildHeaderInput): void {
  const accessToken = input.accessToken.trim()
  if (!accessToken) throw new Error('Grok Build access token is required.')

  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('X-XAI-Token-Auth', GROK_BUILD_TOKEN_AUTH)
  headers.set('x-grok-client-version', GROK_BUILD_CLIENT_VERSION)
  headers.set('x-grok-client-identifier', GROK_BUILD_CLIENT_IDENTIFIER)
  headers.set('x-grok-client-mode', input.mode ?? 'headless')
  headers.set('accept', input.accept ?? 'application/json')
  headers.set('accept-encoding', input.acceptEncoding ?? 'gzip')
  headers.set('user-agent', GROK_BUILD_USER_AGENT)

  const subjectId = input.subjectId?.trim()
  const email = input.email?.trim()
  if (subjectId) headers.set('x-userid', subjectId)
  if (email) headers.set('x-email', email)
}

export async function queryGrokBuildQuota(
  accessToken: string,
  options: GrokBuildQuotaQueryOptions = {}
): Promise<GrokBuildQuotaResult> {
  const clock = options.now ?? Date.now
  const startedAt = clock()
  const latency = (): number => Math.max(0, clock() - startedAt)
  const token = accessToken.trim()
  if (!token) {
    return unavailable(
      failure('authentication', 'Grok Build billing requires an access token.', false),
      latency()
    )
  }

  const timeoutSignal = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? GROK_BUILD_BILLING_TIMEOUT_MS))
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const headers = new Headers()
  applyGrokBuildHeaders(headers, {
    accessToken: token,
    mode: 'headless',
    subjectId: options.subjectId,
    email: options.email
  })

  let response: Response
  try {
    response = await (options.fetchImplementation ?? fetch)(GROK_BUILD_BILLING_URL, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal
    })
  } catch (error) {
    return unavailable(classifyTransportFailure(error, options.signal, timeoutSignal), latency())
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return unavailable(
      classifyBillingHttpFailure(response.status, response.headers, clock()),
      latency(),
      response.status
    )
  }

  let text: string
  try {
    text = await readLimitedResponseText(response, MAX_GROK_BUILD_BILLING_BYTES)
  } catch (error) {
    if (error instanceof GrokBuildResponseTooLargeError) {
      return unavailable(invalidResponseFailure('Grok Build billing response is too large.'), latency(), response.status)
    }
    return unavailable(classifyTransportFailure(error, options.signal, timeoutSignal), latency(), response.status)
  }

  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    return unavailable(invalidResponseFailure('Grok Build billing returned invalid JSON.'), latency(), response.status)
  }

  const initialQuota = parseGrokBuildBillingPayload(payload, clock())
  if (!initialQuota) {
    return unavailable(
      invalidResponseFailure('Grok Build billing returned no recognizable quota data.'),
      latency(),
      response.status
    )
  }
  let fallbackPlanName: string | undefined
  if (!initialQuota.plan?.code && !initialQuota.plan?.name) {
    fallbackPlanName = await queryGrokBuildSubscriptionTier(token, options).catch(() => undefined)
      ?? subscriptionTierFromJwt(token)
  }
  const observedAt = clock()
  const quota = parseGrokBuildBillingPayload(payload, observedAt, fallbackPlanName) ?? initialQuota
  return {
    ok: true,
    status: 'available',
    statusCode: response.status,
    latencyMs: Math.max(0, observedAt - startedAt),
    quota
  }
}

export function parseGrokBuildBillingPayload(
  payload: unknown,
  observedAt = Date.now(),
  fallbackPlanName?: string
): GrokBuildQuotaSnapshot | undefined {
  const outer = asRecord(payload)
  if (!outer) return undefined
  const config = asRecord(outer.config) ?? outer

  const monthlyLimit = numberFrom(config, outer, ['monthlyLimit', 'monthly_limit'])
  const monthlyUsed = numberFrom(config, outer, ['used', 'totalUsed', 'total_used', 'includedUsed', 'included_used'])
  const onDemandCap = numberFrom(config, outer, ['onDemandCap', 'on_demand_cap', 'maxAmountPerMonth', 'max_amount_per_month'])
  const onDemandUsed = numberFrom(config, outer, ['onDemandUsed', 'on_demand_used'])
  const prepaidBalance = numberFrom(config, outer, ['prepaidBalance', 'prepaid_balance'])
  const explicitPercent = numberFrom(config, outer, ['creditUsagePercent', 'credit_usage_percent'])
  const onDemandEnabled = booleanFrom(config, outer, ['onDemandEnabled', 'on_demand_enabled'])
  const unifiedBilling = booleanFrom(config, outer, ['isUnifiedBillingUser', 'is_unified_billing_user'])
  const topUpMethod = stringFrom(config, outer, ['topUpMethod', 'top_up_method'])
  const parsedPlan = mergePlan(planFrom(config), planFrom(outer))
  const plan = parsedPlan ?? (textValue(fallbackPlanName) ? { name: textValue(fallbackPlanName) } : undefined)
  const period = periodFrom(config) ?? periodFrom(outer) ?? billingPeriodFrom(config, outer)

  const hasEvidence = [monthlyLimit, monthlyUsed, onDemandCap, onDemandUsed, prepaidBalance, explicitPercent]
    .some((value) => value !== undefined)
    || onDemandEnabled !== undefined
    || unifiedBilling !== undefined
    || topUpMethod !== undefined
    || plan !== undefined
    || period !== undefined
  if (!hasEvidence) return undefined

  const paidClassification = classifyPaidPlan(plan, {
    monthlyLimit,
    onDemandCap,
    onDemandUsed,
    prepaidBalance
  })
  let usedPercent: number | undefined
  if (explicitPercent !== undefined && explicitPercent > 0) {
    usedPercent = clampPercent(explicitPercent)
  } else if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    usedPercent = clampPercent(onDemandUsed / onDemandCap * 100)
  } else if (monthlyLimit !== undefined && monthlyLimit > 0 && monthlyUsed !== undefined) {
    usedPercent = clampPercent(monthlyUsed / monthlyLimit * 100)
  } else if (explicitPercent === 0 && paidClassification === 'paid' && period !== undefined) {
    // Zero is ambiguous in the all-zero Free/unknown payload. It becomes a
    // trustworthy 0% only when a paid plan is tied to an explicit period.
    usedPercent = 0
  }
  const remainingPercent = usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent)

  const monthly = amountQuota(monthlyLimit, monthlyUsed, 'limit')
  const onDemandAmount = amountQuota(onDemandCap, onDemandUsed, 'cap')
  const preferred = preferredQuotaBasis(onDemandAmount, monthly)
  const resetAt = parseResetAt(period?.end)

  return {
    ...(usedPercent === undefined ? {} : { usedPercent, remainingPercent }),
    ...(preferred?.limit === undefined ? {} : { limit: preferred.limit }),
    ...(preferred?.used === undefined ? {} : { used: preferred.used }),
    ...(preferred?.remaining === undefined ? {} : { remaining: preferred.remaining }),
    ...(monthly === undefined ? {} : { monthly }),
    ...(onDemandAmount === undefined && onDemandEnabled === undefined
      ? {}
      : { onDemand: { ...(onDemandAmount ?? {}), ...(onDemandEnabled === undefined ? {} : { enabled: onDemandEnabled }) } }),
    ...(prepaidBalance === undefined ? {} : { prepaidBalance }),
    ...(unifiedBilling === undefined ? {} : { unifiedBilling }),
    ...(topUpMethod === undefined ? {} : { topUpMethod }),
    ...(period === undefined ? {} : { period }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(plan === undefined ? {} : { plan }),
    paidClassification,
    observedAt,
    source: 'grok-build-billing'
  }
}

function amountQuota(
  limit: number | undefined,
  used: number | undefined,
  limitKey: 'limit' | 'cap'
): GrokBuildMonthlyQuota | GrokBuildOnDemandQuota | undefined {
  if (limit === undefined && used === undefined) return undefined
  const remaining = limit === undefined || used === undefined ? undefined : Math.max(0, limit - used)
  return {
    ...(limit === undefined ? {} : { [limitKey]: limit }),
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining })
  }
}

function preferredQuotaBasis(
  onDemand: GrokBuildOnDemandQuota | undefined,
  monthly: GrokBuildMonthlyQuota | undefined
): { limit?: number; used?: number; remaining?: number } | undefined {
  if (onDemand?.cap !== undefined && onDemand.cap > 0) {
    return { limit: onDemand.cap, used: onDemand.used, remaining: onDemand.remaining }
  }
  if (monthly?.limit !== undefined && monthly.limit > 0) return monthly
  return undefined
}

function periodFrom(values: JsonRecord): GrokBuildQuotaPeriod | undefined {
  const period = asRecord(firstValue(values, ['currentPeriod', 'current_period']))
  if (!period) return undefined
  const type = textValue(firstValue(period, ['type']))
  const start = textValue(firstValue(period, ['start']))
  const end = textValue(firstValue(period, ['end']))
  return type || start || end ? { ...(type ? { type } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined
}

function billingPeriodFrom(config: JsonRecord, outer: JsonRecord): GrokBuildQuotaPeriod | undefined {
  const start = stringFrom(config, outer, ['billingPeriodStart', 'billing_period_start'])
  const end = stringFrom(config, outer, ['billingPeriodEnd', 'billing_period_end'])
  return start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined
}

function planFrom(values: JsonRecord): GrokBuildQuotaPlan | undefined {
  let code = textValue(firstValue(values, ['planCode', 'plan_code', 'tier']))
  let name = textValue(firstValue(values, [
    'planName', 'plan_name', 'subscriptionName', 'subscription_name', 'subscriptionTier', 'subscription_tier'
  ]))
  for (const key of ['plan', 'subscription', 'membership']) {
    const candidate = values[key]
    if (typeof candidate === 'string') {
      name ??= textValue(candidate)
      continue
    }
    const nested = asRecord(candidate)
    if (!nested) continue
    code ??= textValue(firstValue(nested, ['code', 'id', 'tier', 'slug']))
    name ??= textValue(firstValue(nested, ['name', 'displayName', 'display_name', 'label']))
  }
  return code || name ? { ...(code ? { code } : {}), ...(name ? { name } : {}) } : undefined
}

function mergePlan(primary: GrokBuildQuotaPlan | undefined, fallback: GrokBuildQuotaPlan | undefined): GrokBuildQuotaPlan | undefined {
  const code = primary?.code ?? fallback?.code
  const name = primary?.name ?? fallback?.name
  return code || name ? { ...(code ? { code } : {}), ...(name ? { name } : {}) } : undefined
}

function classifyPaidPlan(
  plan: GrokBuildQuotaPlan | undefined,
  amounts: { monthlyLimit?: number; onDemandCap?: number; onDemandUsed?: number; prepaidBalance?: number }
): GrokBuildPaidClassification {
  const values = [plan?.code, plan?.name].filter((value): value is string => Boolean(value))
  if (values.some((value) => PAID_PLANS.has(normalizePlan(value)))
    || [amounts.monthlyLimit, amounts.onDemandCap, amounts.onDemandUsed, amounts.prepaidBalance]
      .some((value) => value !== undefined && value > 0)) {
    return 'paid'
  }
  if (values.some((value) => FREE_PLANS.has(normalizePlan(value)))) return 'free'
  return 'unknown'
}

const PAID_PLANS = new Set([
  'super', 'supergrok', 'supergrokpro', 'supergrokheavy', 'supergroklite',
  'grokpro', 'xpremium', 'xpremiumplus', 'apikey'
])
const FREE_PLANS = new Set(['free', 'grokfree', 'freetier', 'basic', 'grokbasic', 'xbasic'])

function normalizePlan(value: string): string {
  return value.trim().toLowerCase().replace(/\+/g, 'plus').replace(/[\s_-]/g, '')
}

function numberFrom(primary: JsonRecord, fallback: JsonRecord, keys: string[]): number | undefined {
  return numberValue(firstValue(primary, keys)) ?? numberValue(firstValue(fallback, keys))
}

function booleanFrom(primary: JsonRecord, fallback: JsonRecord, keys: string[]): boolean | undefined {
  return booleanValue(firstValue(primary, keys)) ?? booleanValue(firstValue(fallback, keys))
}

function stringFrom(primary: JsonRecord, fallback: JsonRecord, keys: string[]): string | undefined {
  return textValue(firstValue(primary, keys)) ?? textValue(firstValue(fallback, keys))
}

function firstValue(values: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(values, key)) return values[key]
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  const nested = asRecord(value)
  return nested ? numberValue(nested.val) : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function parseResetAt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

async function queryGrokBuildSubscriptionTier(
  accessToken: string,
  options: GrokBuildQuotaQueryOptions
): Promise<string | undefined> {
  const timeoutSignal = AbortSignal.timeout(GROK_BUILD_USER_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const headers = new Headers()
  applyGrokBuildHeaders(headers, {
    accessToken,
    mode: 'headless',
    subjectId: options.subjectId,
    email: options.email
  })
  const response = await (options.fetchImplementation ?? fetch)(GROK_BUILD_USER_URL, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const text = await readLimitedResponseText(response, MAX_GROK_BUILD_USER_BYTES)
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  return subscriptionTierFromPayload(payload)
}

function subscriptionTierFromPayload(payload: unknown): string | undefined {
  const root = asRecord(payload)
  if (!root) return undefined
  const direct = textValue(firstValue(root, ['subscriptionTier', 'subscription_tier']))
  if (direct) return direct
  const user = asRecord(root.user)
  return user ? textValue(firstValue(user, ['subscriptionTier', 'subscription_tier'])) : undefined
}

function subscriptionTierFromJwt(accessToken: string): string | undefined {
  const segment = accessToken.split('.')[1]
  if (!segment) return undefined
  try {
    const claims = asRecord(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown)
    const tier = claims?.tier
    if (typeof tier === 'string') {
      const normalized = tier.trim()
      if (!normalized) return undefined
      const numeric = Number(normalized)
      return Number.isInteger(numeric) ? subscriptionTierFromNumber(numeric) : normalized
    }
    return typeof tier === 'number' && Number.isInteger(tier)
      ? subscriptionTierFromNumber(tier)
      : undefined
  } catch {
    return undefined
  }
}

function subscriptionTierFromNumber(tier: number): string | undefined {
  return [
    'free',
    'supergrok',
    'x_basic',
    'x_premium',
    'x_premium_plus',
    'supergrok_heavy',
    'supergrok_lite'
  ][tier]
}

async function readLimitedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new GrokBuildResponseTooLargeError()
  }

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
        await reader.cancel().catch(() => undefined)
        throw new GrokBuildResponseTooLargeError()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

class GrokBuildResponseTooLargeError extends Error {
  constructor() {
    super('Grok Build billing response exceeded the allowed size.')
    this.name = 'GrokBuildResponseTooLargeError'
  }
}

function classifyBillingHttpFailure(statusCode: number, headers: HeadersInit | undefined, now: number): ProviderFailure {
  if (statusCode === 401) return failure('authentication', 'Grok Build billing rejected the access token.', true, statusCode)
  if (statusCode === 403) return failure('permission', 'Grok Build billing is not available for this account.', false, statusCode)
  if (statusCode === 408) return failure('timeout', 'Grok Build billing request timed out.', true, statusCode)
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers, now)
    return {
      ...failure('rate_limit', 'Grok Build billing is temporarily rate limited.', true, statusCode),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAt: now + retryAfterMs })
    }
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return failure('upstream', 'Grok Build billing is temporarily unavailable.', true, statusCode)
  }
  if (statusCode === 404) return failure('not_found', 'Grok Build billing endpoint was not found.', false, statusCode)
  return failure('invalid_request', 'Grok Build billing rejected the request.', false, statusCode)
}

function classifyTransportFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): ProviderFailure {
  if (callerSignal?.aborted) return failure('cancelled', 'Grok Build billing request was cancelled.', false)
  if (timeoutSignal.aborted || errorName(error) === 'TimeoutError') {
    return failure('timeout', 'Grok Build billing request timed out.', true)
  }
  if (errorName(error) === 'AbortError') return failure('cancelled', 'Grok Build billing request was cancelled.', false)
  return failure('network', 'Grok Build billing endpoint could not be reached.', true)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function invalidResponseFailure(message: string): ProviderFailure {
  return failure('invalid_response', message, false)
}

function failure(
  category: ProviderFailure['category'],
  message: string,
  retryable: boolean,
  statusCode?: number
): ProviderFailure {
  return {
    category,
    message,
    retryable,
    accountAction: 'none',
    ...(statusCode === undefined ? {} : { statusCode })
  }
}

function unavailable(
  providerFailure: ProviderFailure,
  latencyMs: number,
  statusCode?: number
): GrokBuildQuotaUnavailable {
  return {
    ok: false,
    status: 'unavailable',
    latencyMs,
    failure: providerFailure,
    ...(statusCode === undefined ? {} : { statusCode })
  }
}
