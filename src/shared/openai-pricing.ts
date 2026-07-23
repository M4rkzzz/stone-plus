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

const longContextPricing = {
  longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5
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
  }
}

function normalizedModel(model: string): string {
  return model.trim().toLowerCase().replace(/^openai[/:]/, '')
}

function isModelOrSnapshot(model: string, base: string): boolean {
  if (model === base) return true
  if (!model.startsWith(`${base}-`)) return false
  const suffix = model.slice(base.length + 1)
  return /^(?:latest|preview|snapshot(?:-\d{4}-\d{2}-\d{2})?|\d{8}|\d{4}-\d{2}-\d{2}(?:-(?:preview|snapshot))?)$/.test(suffix)
}

/** Resolves only known OpenAI model names and snapshots. Unknown variants remain deliberately unpriced. */
export function resolveOpenAiModelPricing(model: string): OpenAiModelPricing | undefined {
  const normalized = normalizedModel(model)
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
  return undefined
}

function tokens(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 0
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

  const pricing = resolveOpenAiModelPricing(log.model)
  if (!pricing) {
    result.unpricedTokens += total
    result.unpricedRequestCount += 1
    accumulator.unknownModels.add(log.model.trim() || '未知模型')
    return
  }

  const cachedRead = Math.min(input, tokens(log.cachedInputTokens))
  const cacheWrite = Math.min(Math.max(0, input - cachedRead), tokens(log.cacheWriteInputTokens))
  const standardInput = Math.max(0, input - cachedRead - cacheWrite)
  const isLongContext = pricing.longContextThresholdTokens !== undefined
    && input > pricing.longContextThresholdTokens
  const inputMultiplier = isLongContext ? pricing.longContextInputMultiplier ?? 1 : 1
  const outputMultiplier = isLongContext ? pricing.longContextOutputMultiplier ?? 1 : 1
  const standardInputCost = standardInput / MILLION * pricing.inputUsdPerMillion * inputMultiplier
  const cacheWriteCost = cacheWrite / MILLION * pricing.cacheWriteUsdPerMillion * inputMultiplier
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
