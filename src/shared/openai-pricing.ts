import type {
  AccountCodexQuotaSnapshot,
  CodexQuotaCycleCosts,
  CodexQuotaWindow,
  OpenAiModelPricing,
  OpenAiPricedModelFamily,
  OpenAiTokenCostBreakdown,
  OpenAiTokenCostOverview,
  RequestLog
} from './types'

const MILLION = 1_000_000
const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const PROVIDER_LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
const SONNET_5_STANDARD_PRICE_START = Date.UTC(2026, 8, 1)

const longContextPricing = {
  longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5
}

const grokLongContextPricing = {
  longContextThresholdTokens: PROVIDER_LONG_CONTEXT_THRESHOLD_TOKENS,
  longContextThresholdInclusive: true,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 2
}

const legacyClaudeLongContextPricing = {
  longContextThresholdTokens: PROVIDER_LONG_CONTEXT_THRESHOLD_TOKENS,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 4
}

const PRICING: Record<OpenAiPricedModelFamily, OpenAiModelPricing> = {
  'gpt-5.6-sol': {
    family: 'gpt-5.6-sol',
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 6.25,
    outputUsdPerMillion: 30
  },
  'gpt-5.6-terra': {
    family: 'gpt-5.6-terra',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteUsdPerMillion: 3.125,
    outputUsdPerMillion: 15
  },
  'gpt-5.6-luna': {
    family: 'gpt-5.6-luna',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 1.25,
    outputUsdPerMillion: 6
  },
  'gpt-5.5': {
    family: 'gpt-5.5',
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    ...longContextPricing
  },
  'gpt-5.5-pro': {
    family: 'gpt-5.5-pro',
    inputUsdPerMillion: 30,
    cachedInputUsdPerMillion: 30,
    cacheWriteUsdPerMillion: 30,
    outputUsdPerMillion: 180,
    ...longContextPricing
  },
  'gpt-5.4': {
    family: 'gpt-5.4',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteUsdPerMillion: 2.5,
    outputUsdPerMillion: 15,
    ...longContextPricing
  },
  'gpt-5.4-pro': {
    family: 'gpt-5.4-pro',
    inputUsdPerMillion: 30,
    cachedInputUsdPerMillion: 30,
    cacheWriteUsdPerMillion: 30,
    outputUsdPerMillion: 180,
    ...longContextPricing
  },
  'gpt-5.4-mini': {
    family: 'gpt-5.4-mini',
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    cacheWriteUsdPerMillion: 0.75,
    outputUsdPerMillion: 4.5
  },
  'gpt-5.4-nano': {
    family: 'gpt-5.4-nano',
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    cacheWriteUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.25
  },
  'grok-4.5': {
    family: 'grok-4.5',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 2,
    outputUsdPerMillion: 6,
    ...grokLongContextPricing
  },
  'claude-fable-5': claudePricing('claude-fable-5', 10, 50),
  'claude-mythos-5': claudePricing('claude-mythos-5', 10, 50),
  'claude-opus-5': claudePricing('claude-opus-5', 5, 25),
  'claude-opus-4-8': claudePricing('claude-opus-4-8', 5, 25),
  'claude-opus-4-7': claudePricing('claude-opus-4-7', 5, 25),
  'claude-opus-4-6': claudePricing('claude-opus-4-6', 5, 25),
  'claude-opus-4-5': claudePricing('claude-opus-4-5', 5, 25),
  'claude-opus-4-1': {
    ...claudePricing('claude-opus-4-1', 15, 75),
    ...legacyClaudeLongContextPricing
  },
  'claude-opus-4': {
    ...claudePricing('claude-opus-4', 15, 75),
    ...legacyClaudeLongContextPricing
  },
  // The active Sonnet 5 launch price is selected by request timestamp below.
  'claude-sonnet-5': claudePricing('claude-sonnet-5', 3, 15),
  'claude-sonnet-4-6': claudePricing('claude-sonnet-4-6', 3, 15),
  'claude-sonnet-4-5': claudePricing('claude-sonnet-4-5', 3, 15),
  'claude-sonnet-4': claudePricing('claude-sonnet-4', 3, 15),
  'claude-3-7-sonnet': {
    ...claudePricing('claude-3-7-sonnet', 3, 15),
    ...legacyClaudeLongContextPricing
  },
  'claude-3-5-sonnet': {
    ...claudePricing('claude-3-5-sonnet', 3, 15),
    ...legacyClaudeLongContextPricing
  },
  'claude-haiku-4-5': claudePricing('claude-haiku-4-5', 1, 5),
  'claude-3-5-haiku': {
    ...claudePricing('claude-3-5-haiku', 0.8, 4),
    ...legacyClaudeLongContextPricing
  },
  'claude-3-opus': claudePricing('claude-3-opus', 15, 75),
  // Claude 3 Sonnet predates prompt caching. Defensive cache fields therefore
  // use the ordinary input rate rather than inventing a discount.
  'claude-3-sonnet': {
    family: 'claude-3-sonnet',
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 3,
    cacheWriteUsdPerMillion: 3,
    cacheWrite1hUsdPerMillion: 3,
    outputUsdPerMillion: 15
  },
  'claude-3-haiku': {
    family: 'claude-3-haiku',
    inputUsdPerMillion: 0.25,
    cachedInputUsdPerMillion: 0.03,
    cacheWriteUsdPerMillion: 0.3,
    cacheWrite1hUsdPerMillion: 0.5,
    outputUsdPerMillion: 1.25
  }
}

const SONNET_5_INTRO_PRICING = claudePricing('claude-sonnet-5', 2, 10)

function claudePricing(
  family: OpenAiPricedModelFamily,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number
): OpenAiModelPricing {
  return {
    family,
    inputUsdPerMillion,
    cachedInputUsdPerMillion: inputUsdPerMillion * 0.1,
    cacheWriteUsdPerMillion: inputUsdPerMillion * 1.25,
    cacheWrite1hUsdPerMillion: inputUsdPerMillion * 2,
    outputUsdPerMillion
  }
}

type ModelNamespace = 'openai' | 'anthropic' | 'xai' | 'x-ai'

function normalizedModel(model: string): { model: string; namespace?: ModelNamespace } {
  const normalized = model.trim().toLowerCase()
  const match = /^(openai|anthropic|xai|x-ai)[/:](.+)$/.exec(normalized)
  return match
    ? { namespace: match[1] as ModelNamespace, model: match[2] }
    : { model: normalized }
}

function isModelOrSnapshot(model: string, base: string): boolean {
  if (model === base) return true
  if (!model.startsWith(`${base}-`)) return false
  const suffix = model.slice(base.length + 1)
  return /^(?:latest|preview|snapshot(?:-\d{4}-\d{2}-\d{2})?|\d{8}|\d{4}-\d{2}-\d{2}(?:-(?:preview|snapshot))?)$/.test(suffix)
}

const CLAUDE_MODEL_IDS: Partial<Record<OpenAiPricedModelFamily, readonly string[]>> = {
  'claude-fable-5': ['claude-fable-5'],
  'claude-mythos-5': ['claude-mythos-5'],
  'claude-opus-5': ['claude-opus-5'],
  'claude-opus-4-8': ['claude-opus-4-8'],
  'claude-opus-4-7': ['claude-opus-4-7'],
  'claude-opus-4-6': ['claude-opus-4-6'],
  'claude-opus-4-5': ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
  'claude-opus-4-1': ['claude-opus-4-1', 'claude-opus-4-1-20250805'],
  'claude-opus-4': ['claude-opus-4', 'claude-opus-4-0', 'claude-opus-4-20250514'],
  'claude-sonnet-5': ['claude-sonnet-5'],
  'claude-sonnet-4-6': ['claude-sonnet-4-6'],
  'claude-sonnet-4-5': ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
  'claude-sonnet-4': ['claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4-20250514'],
  'claude-3-7-sonnet': ['claude-3-7-sonnet', 'claude-3-7-sonnet-latest', 'claude-3-7-sonnet-20250219'],
  'claude-3-5-sonnet': [
    'claude-3-5-sonnet',
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620'
  ],
  'claude-haiku-4-5': ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  'claude-3-5-haiku': ['claude-3-5-haiku', 'claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022'],
  'claude-3-opus': ['claude-3-opus', 'claude-3-opus-20240229'],
  'claude-3-sonnet': ['claude-3-sonnet', 'claude-3-sonnet-20240229'],
  'claude-3-haiku': ['claude-3-haiku', 'claude-3-haiku-20240307']
}

function isClaudeModelId(model: string, family: OpenAiPricedModelFamily): boolean {
  return CLAUDE_MODEL_IDS[family]?.includes(model) === true
}

/** Resolves known first-party model names and snapshots. Unknown variants remain deliberately unpriced. */
export function resolveModelPricing(model: string, effectiveAt = Date.now()): OpenAiModelPricing | undefined {
  const parsed = normalizedModel(model)
  const normalized = parsed.model
  if (!parsed.namespace || parsed.namespace === 'openai') {
    if (isModelOrSnapshot(normalized, 'gpt-5.6-sol')) return PRICING['gpt-5.6-sol']
    if (isModelOrSnapshot(normalized, 'gpt-5.6-terra')) return PRICING['gpt-5.6-terra']
    if (isModelOrSnapshot(normalized, 'gpt-5.6-luna')) return PRICING['gpt-5.6-luna']
    // gpt-5.6 is the canonical alias of the Sol tier.
    if (isModelOrSnapshot(normalized, 'gpt-5.6')) return PRICING['gpt-5.6-sol']
    if (isModelOrSnapshot(normalized, 'gpt-5.5-pro')) return PRICING['gpt-5.5-pro']
    if (isModelOrSnapshot(normalized, 'gpt-5.5')) return PRICING['gpt-5.5']
    if (isModelOrSnapshot(normalized, 'gpt-5.4-pro')) return PRICING['gpt-5.4-pro']
    if (isModelOrSnapshot(normalized, 'gpt-5.4-mini')) return PRICING['gpt-5.4-mini']
    if (isModelOrSnapshot(normalized, 'gpt-5.4-nano')) return PRICING['gpt-5.4-nano']
    if (isModelOrSnapshot(normalized, 'gpt-5.4')) return PRICING['gpt-5.4']
  }
  if ((!parsed.namespace || parsed.namespace === 'xai' || parsed.namespace === 'x-ai')
    && (normalized === 'grok-4.5'
      || normalized === 'grok-4.5-latest'
      || normalized === 'grok-build-latest')) {
    return PRICING['grok-4.5']
  }
  if (parsed.namespace && parsed.namespace !== 'anthropic') return undefined
  if (isClaudeModelId(normalized, 'claude-fable-5')) return PRICING['claude-fable-5']
  if (isClaudeModelId(normalized, 'claude-mythos-5')) return PRICING['claude-mythos-5']
  if (isClaudeModelId(normalized, 'claude-opus-5')) return PRICING['claude-opus-5']
  if (isClaudeModelId(normalized, 'claude-opus-4-8')) return PRICING['claude-opus-4-8']
  if (isClaudeModelId(normalized, 'claude-opus-4-7')) return PRICING['claude-opus-4-7']
  if (isClaudeModelId(normalized, 'claude-opus-4-6')) return PRICING['claude-opus-4-6']
  if (isClaudeModelId(normalized, 'claude-opus-4-5')) return PRICING['claude-opus-4-5']
  if (isClaudeModelId(normalized, 'claude-opus-4-1')) return PRICING['claude-opus-4-1']
  if (isClaudeModelId(normalized, 'claude-opus-4')) return PRICING['claude-opus-4']
  if (isClaudeModelId(normalized, 'claude-sonnet-5')) {
    return effectiveAt < SONNET_5_STANDARD_PRICE_START
      ? SONNET_5_INTRO_PRICING
      : PRICING['claude-sonnet-5']
  }
  if (isClaudeModelId(normalized, 'claude-sonnet-4-6')) return PRICING['claude-sonnet-4-6']
  if (isClaudeModelId(normalized, 'claude-sonnet-4-5')) return PRICING['claude-sonnet-4-5']
  if (isClaudeModelId(normalized, 'claude-sonnet-4')) return PRICING['claude-sonnet-4']
  if (isClaudeModelId(normalized, 'claude-3-7-sonnet')) return PRICING['claude-3-7-sonnet']
  if (isClaudeModelId(normalized, 'claude-3-5-sonnet')) return PRICING['claude-3-5-sonnet']
  if (isClaudeModelId(normalized, 'claude-haiku-4-5')) return PRICING['claude-haiku-4-5']
  if (isClaudeModelId(normalized, 'claude-3-5-haiku')) return PRICING['claude-3-5-haiku']
  if (isClaudeModelId(normalized, 'claude-3-opus')) return PRICING['claude-3-opus']
  if (isClaudeModelId(normalized, 'claude-3-sonnet')) return PRICING['claude-3-sonnet']
  if (isClaudeModelId(normalized, 'claude-3-haiku')) return PRICING['claude-3-haiku']
  return undefined
}

/** Backward-compatible name retained for existing call sites. */
export function resolveOpenAiModelPricing(model: string, effectiveAt = Date.now()): OpenAiModelPricing | undefined {
  return resolveModelPricing(model, effectiveAt)
}

function tokens(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 0
}

function isClaudePricingFamily(family: OpenAiPricedModelFamily): boolean {
  return family.startsWith('claude-')
}

function emptyBreakdown(): OpenAiTokenCostBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    standardInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    inputCostUsd: 0,
    cachedInputCostUsd: 0,
    cacheWriteCostUsd: 0,
    outputCostUsd: 0,
    totalCostUsd: 0,
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    longContextRequestCount: 0,
    unknownModels: []
  }
}

/** Mutable accumulator used by callers that already scan request logs for
 * other metrics. It avoids a second full traversal solely for token pricing. */
export interface OpenAiTokenCostAccumulator {
  breakdown: OpenAiTokenCostBreakdown
  unknownModels: Set<string>
}

export function createOpenAiTokenCostAccumulator(): OpenAiTokenCostAccumulator {
  return {
    breakdown: emptyBreakdown(),
    unknownModels: new Set<string>()
  }
}

export function accumulateOpenAiTokenCost(
  accumulator: OpenAiTokenCostAccumulator,
  log: Readonly<RequestLog>
): void {
  const result = accumulator.breakdown
  const input = tokens(log.inputTokens)
  const output = tokens(log.outputTokens)
  const total = input + output
  if (!total) return

  result.totalTokens += total
  result.inputTokens += input
  result.outputTokens += output

  const billingModel = log.upstreamModel?.trim() || log.model
  const pricing = resolveModelPricing(billingModel, log.timestamp)
  if (!pricing) {
    result.unpricedTokens += total
    result.unpricedRequestCount += 1
    accumulator.unknownModels.add(billingModel.trim() || '未知模型')
    return
  }

  // Before accounting v2, Anthropic input_tokens was not normalized to include
  // cache reads and cache creation consistently. A cached legacy row therefore
  // cannot be priced without guessing its denominator. Cache-free legacy rows
  // remain safe, and all newly written rows carry tokenAccountingVersion = 2.
  if (isClaudePricingFamily(pricing.family)
    && log.tokenAccountingVersion !== 2
    && (tokens(log.cachedInputTokens) > 0 || tokens(log.cacheWriteInputTokens) > 0)) {
    result.unpricedTokens += total
    result.unpricedRequestCount += 1
    accumulator.unknownModels.add(billingModel.trim() || '未知模型')
    return
  }

  const cachedRead = Math.min(input, tokens(log.cachedInputTokens))
  const cacheWrite = Math.min(Math.max(0, input - cachedRead), tokens(log.cacheWriteInputTokens))
  const cacheWrite1h = Math.min(cacheWrite, tokens(log.cacheWriteInputTokens1h))
  const cacheWrite5m = Math.min(
    Math.max(0, cacheWrite - cacheWrite1h),
    tokens(log.cacheWriteInputTokens5m)
  )
  const unspecifiedCacheWrite = Math.max(0, cacheWrite - cacheWrite1h - cacheWrite5m)
  const standardInput = Math.max(0, input - cachedRead - cacheWrite)
  const isLongContext = pricing.longContextThresholdTokens !== undefined
    && (pricing.longContextThresholdInclusive
      ? input >= pricing.longContextThresholdTokens
      : input > pricing.longContextThresholdTokens)
  const inputMultiplier = isLongContext ? pricing.longContextInputMultiplier ?? 1 : 1
  const outputMultiplier = isLongContext ? pricing.longContextOutputMultiplier ?? 1 : 1
  const standardInputCost = standardInput / MILLION * pricing.inputUsdPerMillion * inputMultiplier
  const cacheWriteCost = (
    (cacheWrite5m + unspecifiedCacheWrite) / MILLION * pricing.cacheWriteUsdPerMillion
    + cacheWrite1h / MILLION * (pricing.cacheWrite1hUsdPerMillion ?? pricing.cacheWriteUsdPerMillion)
  ) * inputMultiplier
  const cachedInputCost = cachedRead / MILLION * pricing.cachedInputUsdPerMillion * inputMultiplier
  const outputCost = output / MILLION * pricing.outputUsdPerMillion * outputMultiplier

  result.standardInputTokens += standardInput
  result.cachedInputTokens += cachedRead
  result.cacheWriteInputTokens += cacheWrite
  result.pricedTokens += total
  result.inputCostUsd += standardInputCost + cacheWriteCost
  result.cacheWriteCostUsd += cacheWriteCost
  result.cachedInputCostUsd += cachedInputCost
  result.outputCostUsd += outputCost
  result.totalCostUsd += standardInputCost + cacheWriteCost + cachedInputCost + outputCost
  result.pricedRequestCount += 1
  if (isLongContext) result.longContextRequestCount += 1
}

export function finishOpenAiTokenCostAccumulator(
  accumulator: OpenAiTokenCostAccumulator
): OpenAiTokenCostBreakdown {
  accumulator.breakdown.unknownModels = [...accumulator.unknownModels]
    .sort((left, right) => left.localeCompare(right))
  return accumulator.breakdown
}

/**
 * Estimates standard API cost from observable usage. `inputTokens` already includes
 * cached reads (and cache writes when reported), so both are subtracted before the
 * ordinary input rate is applied to avoid double charging.
 */
export function estimateOpenAiTokenCosts(logs: readonly RequestLog[]): OpenAiTokenCostBreakdown {
  const accumulator = createOpenAiTokenCostAccumulator()
  for (const log of logs) accumulateOpenAiTokenCost(accumulator, log)
  return finishOpenAiTokenCostAccumulator(accumulator)
}

export function localNaturalDayStart(now: number): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

export function summarizeOpenAiTokenCosts(
  logs: readonly RequestLog[],
  now = Date.now()
): OpenAiTokenCostOverview {
  const todayStart = localNaturalDayStart(now)
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const today = createOpenAiTokenCostAccumulator()
  const allTime = createOpenAiTokenCostAccumulator()
  for (const log of logs) {
    accumulateOpenAiTokenCost(allTime, log)
    if (log.timestamp >= todayStart && log.timestamp < tomorrow.getTime()) {
      accumulateOpenAiTokenCost(today, log)
    }
  }
  return {
    generatedAt: now,
    todayStart,
    today: finishOpenAiTokenCostAccumulator(today),
    allTime: finishOpenAiTokenCostAccumulator(allTime)
  }
}

export function summarizeAccountCodexQuotaCycleCosts(
  logs: readonly RequestLog[],
  accountId: string,
  quota: AccountCodexQuotaSnapshot | undefined,
  now = Date.now()
): CodexQuotaCycleCosts {
  const fiveHour = quota?.fiveHour
    ? createOpenAiTokenCostAccumulator()
    : undefined
  const sevenDay = quota?.sevenDay
    ? createOpenAiTokenCostAccumulator()
    : undefined
  const fiveHourBounds = quota?.fiveHour
    ? quotaWindowBounds(quota.fiveHour, 5 * 60 * 60, now)
    : undefined
  const sevenDayBounds = quota?.sevenDay
    ? quotaWindowBounds(quota.sevenDay, 7 * 24 * 60 * 60, now)
    : undefined
  // Account quota cards are opened while request history may contain 20k rows.
  // Keep the account filter and both window checks in a single traversal rather
  // than allocating an account array and rescanning it for each quota cycle.
  for (const log of logs) {
    if (log.accountId !== accountId) continue
    if (fiveHourBounds && log.timestamp >= fiveHourBounds.start && log.timestamp < fiveHourBounds.end) {
      accumulateOpenAiTokenCost(fiveHour!, log)
    }
    if (sevenDayBounds && log.timestamp >= sevenDayBounds.start && log.timestamp < sevenDayBounds.end) {
      accumulateOpenAiTokenCost(sevenDay!, log)
    }
  }
  return {
    ...(fiveHour ? { fiveHourUsd: finishOpenAiTokenCostAccumulator(fiveHour).totalCostUsd } : {}),
    ...(sevenDay ? { sevenDayUsd: finishOpenAiTokenCostAccumulator(sevenDay).totalCostUsd } : {})
  }
}

function quotaWindowBounds(
  window: CodexQuotaWindow,
  fallbackSeconds: number,
  now: number
): { start: number; end: number } {
  const durationMs = Math.max(1, window.windowSeconds ?? fallbackSeconds) * 1_000
  const resetAt = window.resetAt
  const start = resetAt === undefined ? now - durationMs : resetAt - durationMs
  const end = resetAt === undefined ? now : Math.min(now, resetAt)
  return { start, end }
}
