import { describe, expect, it } from 'vitest'
import {
  estimateCodexTokenCredits,
  estimateOpenAiTokenCosts,
  localNaturalDayStart,
  resolveCodexTokenCreditPricing,
  resolveOpenAiModelPricing,
  summarizeAccountCodexQuotaCycleCosts,
  summarizeOpenAiTokenCosts
} from '../../src/shared/openai-pricing'
import type { RequestLog } from '../../src/shared/types'

function log(model: string, overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    id: `${model}-${overrides.timestamp ?? 0}`,
    timestamp: 1_700_000_000_000,
    client: 'codex',
    protocol: 'openai-responses',
    providerName: 'OpenAI',
    accountName: 'Account',
    model,
    status: 'success',
    statusCode: 200,
    latencyMs: 1_000,
    tokenAccountingVersion: 2,
    ...overrides
  }
}

describe('Standard API token pricing', () => {
  it.each([
    ['gpt-5.6-sol', 'gpt-5.6-sol', 125, 12.5, 750],
    ['gpt-5.6', 'gpt-5.6-sol', 125, 12.5, 750],
    ['gpt-5.6-terra', 'gpt-5.6-terra', 50, 5, 300],
    ['gpt-5.6-luna', 'gpt-5.6-luna', 5, 0.5, 30],
    ['gpt-5.5', 'gpt-5.5', 125, 12.5, 750],
    ['gpt-5.5-cyber', 'gpt-5.5-cyber', 312.5, 31.25, 1_875],
    ['gpt-5.4', 'gpt-5.4', 62.5, 6.25, 375],
    ['gpt-5.4-mini', 'gpt-5.4-mini', 18.75, 1.875, 113],
    ['gpt-5.3-codex', 'gpt-5.3-codex', 43.75, 4.375, 350],
    ['gpt-5.2', 'gpt-5.2', 43.75, 4.375, 350]
  ] as const)('maps %s to official Codex credit family %s', (model, family, input, cached, output) => {
    expect(resolveCodexTokenCreditPricing(model)).toEqual({
      family,
      inputCreditsPerMillion: input,
      cachedInputCreditsPerMillion: cached,
      outputCreditsPerMillion: output
    })
  })

  it.each(['gpt-5.3-codex-spark', 'gpt-5.5-pro', 'gpt-5.4-pro', 'grok-4.5', 'anthropic/gpt-5.6'])(
    'does not guess Codex credits for unlisted model %j',
    (model) => expect(resolveCodexTokenCreditPricing(model)).toBeUndefined()
  )

  it('uses official Codex token rates and does not charge cache writes', () => {
    const result = estimateCodexTokenCredits([
      log('gpt-5.6-terra', {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteInputTokens: 300_000,
        outputTokens: 100_000
      }),
      log('private-model', { inputTokens: 10_000, outputTokens: 1_000 })
    ])

    expect(result).toMatchObject({
      inputCredits: 25,
      cachedInputCredits: 1,
      outputCredits: 30,
      totalCredits: 56,
      pricedTokens: 1_100_000,
      unpricedTokens: 11_000,
      pricedRequestCount: 1,
      unpricedRequestCount: 1,
      unknownModels: ['private-model']
    })
  })

  it.each([
    ['gpt-5.6-sol', 'gpt-5.6-sol'],
    ['gpt-5.6', 'gpt-5.6-sol'],
    ['gpt-5.6-sol-2026-07-19', 'gpt-5.6-sol'],
    ['openai/gpt-5.6-20260719', 'gpt-5.6-sol'],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
    ['gpt-5.6-terra-snapshot-2026-07-19', 'gpt-5.6-terra'],
    ['gpt-5.6-luna-preview', 'gpt-5.6-luna'],
    ['gpt-5.5', 'gpt-5.5'],
    ['gpt-5.5-2026-07-19', 'gpt-5.5'],
    ['gpt-5.5-pro-snapshot-2026-07-19', 'gpt-5.5-pro'],
    ['gpt-5.4', 'gpt-5.4'],
    ['openai:gpt-5.4-pro-20260719', 'gpt-5.4-pro'],
    ['gpt-5.4-mini-latest', 'gpt-5.4-mini'],
    ['gpt-5.4-nano-2026-07-19-preview', 'gpt-5.4-nano']
  ] as const)('maps %s to the %s price family', (model, family) => {
    expect(resolveOpenAiModelPricing(model)?.family).toBe(family)
  })

  it.each([
    ['gpt-5.6-sol', 5, 0.5, 6.25, 30],
    ['gpt-5.6-terra', 2, 0.2, 2.5, 12],
    ['gpt-5.6-luna', 0.2, 0.02, 0.25, 1.2]
  ] as const)('uses the current official API rates for %s', (model, input, cached, cacheWrite, output) => {
    expect(resolveOpenAiModelPricing(model)).toMatchObject({
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      cacheWriteUsdPerMillion: cacheWrite,
      outputUsdPerMillion: output,
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5
    })
  })

  it.each(['gpt-5.6-sol-pro', 'gpt-5.5-mini', 'gpt-5.4-ultra', 'gpt-5.4-pro-max', 'o4-mini', '', 'custom/gpt-5.6-sol'])(
    'does not guess a price for unknown model %j',
    (model) => expect(resolveOpenAiModelPricing(model)).toBeUndefined()
  )

  it.each([
    ['deepseek-v4-flash', 'deepseek-v4-flash', 0.14, 0.0028, 0.28],
    ['deepseek/deepseek-v4-flash', 'deepseek-v4-flash', 0.14, 0.0028, 0.28],
    ['deepseek-v4-flash[1m]', 'deepseek-v4-flash', 0.14, 0.0028, 0.28],
    ['deepseek-v4-pro', 'deepseek-v4-pro', 0.435, 0.003625, 0.87],
    ['deepseek:deepseek-v4-pro[1m]', 'deepseek-v4-pro', 0.435, 0.003625, 0.87]
  ] as const)('uses the current official DeepSeek API rates for %s', (model, family, input, cached, output) => {
    expect(resolveOpenAiModelPricing(model)).toMatchObject({
      family,
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      cacheWriteUsdPerMillion: input,
      outputUsdPerMillion: output
    })
  })

  it('prices DeepSeek cache hits and removes supported V4 usage from the unpriced bucket', () => {
    const result = estimateOpenAiTokenCosts([
      log('deepseek-v4-flash', {
        inputTokens: 1_000_000,
        cachedInputTokens: 250_000,
        outputTokens: 100_000
      })
    ])

    expect(result).toMatchObject({
      standardInputTokens: 750_000,
      cachedInputTokens: 250_000,
      pricedTokens: 1_100_000,
      unpricedTokens: 0,
      cachedInputCostUsd: 0.0007,
      unknownModels: []
    })
    expect(result.inputCostUsd).toBeCloseTo(0.105, 12)
    expect(result.outputCostUsd).toBeCloseTo(0.028, 12)
    expect(result.totalCostUsd).toBeCloseTo(0.1337, 12)
  })

  it.each(['deepseek-v4-flash-preview', 'deepseek-v4-pro-max', 'openai/deepseek-v4-flash'])(
    'does not guess DeepSeek pricing for unsupported model %j',
    (model) => expect(resolveOpenAiModelPricing(model)).toBeUndefined()
  )

  it.each([
    ['grok-4.5', 'grok-4.5'],
    ['grok-4.5-latest', 'grok-4.5'],
    ['grok-build-latest', 'grok-4.5'],
    ['xai/grok-4.5', 'grok-4.5'],
    ['x-ai:grok-4.5-latest', 'grok-4.5']
  ] as const)('maps the official Grok model id %s to %s pricing', (model, family) => {
    expect(resolveOpenAiModelPricing(model)?.family).toBe(family)
  })

  it('uses Grok 4.5 cached-input pricing below 200K', () => {
    const result = estimateOpenAiTokenCosts([
      log('grok-4.5', {
        inputTokens: 100_000,
        cachedInputTokens: 40_000,
        outputTokens: 10_000
      })
    ])

    expect(result).toMatchObject({
      standardInputTokens: 60_000,
      cachedInputTokens: 40_000,
      inputCostUsd: 0.12,
      cachedInputCostUsd: 0.012,
      outputCostUsd: 0.06,
      totalCostUsd: 0.192,
      longContextRequestCount: 0
    })
  })

  it('applies Grok 4.5 long-context pricing starting at exactly 200K input', () => {
    const below = estimateOpenAiTokenCosts([
      log('grok-4.5', {
        inputTokens: 199_999,
        cachedInputTokens: 50_000,
        outputTokens: 10_000
      })
    ])
    const boundary = estimateOpenAiTokenCosts([
      log('grok-4.5', {
        inputTokens: 200_000,
        cachedInputTokens: 50_000,
        outputTokens: 10_000
      })
    ])

    expect(below.totalCostUsd).toBeCloseTo(0.374998, 12)
    expect(below.longContextRequestCount).toBe(0)
    expect(boundary).toMatchObject({
      inputCostUsd: 0.6,
      cachedInputCostUsd: 0.03,
      outputCostUsd: 0.12,
      totalCostUsd: 0.75,
      longContextRequestCount: 1
    })
  })

  it.each([
    ['claude-fable-5', 'claude-fable-5', 10, 1, 50],
    ['claude-mythos-5', 'claude-mythos-5', 10, 1, 50],
    ['claude-opus-5', 'claude-opus-5', 5, 0.5, 25],
    ['claude-opus-4-8', 'claude-opus-4-8', 5, 0.5, 25],
    ['claude-opus-4-7', 'claude-opus-4-7', 5, 0.5, 25],
    ['claude-opus-4-6', 'claude-opus-4-6', 5, 0.5, 25],
    ['claude-opus-4-5-20251101', 'claude-opus-4-5', 5, 0.5, 25],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1', 15, 1.5, 75],
    ['claude-opus-4-0', 'claude-opus-4', 15, 1.5, 75],
    ['claude-opus-4-20250514', 'claude-opus-4', 15, 1.5, 75],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', 3, 0.3, 15],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 3, 0.3, 15],
    ['claude-sonnet-4-0', 'claude-sonnet-4', 3, 0.3, 15],
    ['anthropic/claude-sonnet-4-20250514', 'claude-sonnet-4', 3, 0.3, 15],
    ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet', 3, 0.3, 15],
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet', 3, 0.3, 15],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 1, 0.1, 5],
    ['claude-3-5-haiku-20241022', 'claude-3-5-haiku', 0.8, 0.08, 4],
    ['claude-3-opus-20240229', 'claude-3-opus', 15, 1.5, 75],
    ['claude-3-sonnet-20240229', 'claude-3-sonnet', 3, 3, 15],
    ['claude-3-haiku-20240307', 'claude-3-haiku', 0.25, 0.03, 1.25]
  ] as const)(
    'maps Anthropic model %s to %s with its standard rates',
    (model, family, inputRate, cachedRate, outputRate) => {
      const pricing = resolveOpenAiModelPricing(model, Date.UTC(2026, 6, 25))
      expect(pricing).toMatchObject({
        family,
        inputUsdPerMillion: inputRate,
        outputUsdPerMillion: outputRate
      })
      expect(pricing?.cachedInputUsdPerMillion).toBeCloseTo(cachedRate, 12)
    }
  )

  it('selects the Sonnet 5 launch price from the request timestamp', () => {
    const launch = resolveOpenAiModelPricing('claude-sonnet-5', Date.UTC(2026, 8, 1) - 1)
    const standard = resolveOpenAiModelPricing('claude-sonnet-5', Date.UTC(2026, 8, 1))

    expect(launch).toMatchObject({
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      cacheWriteUsdPerMillion: 2.5,
      cacheWrite1hUsdPerMillion: 4,
      outputUsdPerMillion: 10
    })
    expect(standard).toMatchObject({
      inputUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
      outputUsdPerMillion: 15
    })
    expect(standard?.cachedInputUsdPerMillion).toBeCloseTo(0.3, 12)

    const logs = estimateOpenAiTokenCosts([
      log('claude-sonnet-5', {
        timestamp: Date.UTC(2026, 8, 1) - 1,
        inputTokens: 100_000,
        outputTokens: 10_000
      }),
      log('claude-sonnet-5', {
        timestamp: Date.UTC(2026, 8, 1),
        inputTokens: 100_000,
        outputTokens: 10_000
      })
    ])
    expect(logs.totalCostUsd).toBeCloseTo(0.75, 12)
  })

  it('prices Anthropic five-minute and one-hour cache writes independently', () => {
    const result = estimateOpenAiTokenCosts([
      log('claude-sonnet-4-6', {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteInputTokens: 300_000,
        cacheWriteInputTokens5m: 200_000,
        cacheWriteInputTokens1h: 100_000,
        outputTokens: 100_000
      })
    ])

    expect(result).toMatchObject({
      totalTokens: 1_100_000,
      standardInputTokens: 500_000,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 300_000,
      inputCostUsd: 2.85,
      cacheWriteCostUsd: 1.35,
      outputCostUsd: 1.5,
      totalCostUsd: 4.41
    })
    expect(result.cachedInputCostUsd).toBeCloseTo(0.06, 12)
  })

  it('uses the route-selected upstream model for billing', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', {
        upstreamModel: 'claude-opus-4-8',
        inputTokens: 100_000,
        outputTokens: 10_000
      })
    ])

    expect(result).toMatchObject({
      pricedRequestCount: 1,
      unpricedRequestCount: 0,
      totalCostUsd: 0.75,
      unknownModels: []
    })
  })

  it.each([
    'anthropic/gpt-5.6-sol',
    'openai/claude-opus-4-8',
    'xai/claude-sonnet-4-6',
    'openai/grok-4.5',
    'anthropic/grok-4.5',
    'x-ai/gpt-5.6',
    'custom/grok-4.5',
    'vendor/claude-opus-4-8',
    'grok-4.5-mini',
    'grok-4.5-20260717',
    'claude-sonnet-4-50',
    'claude-opus-4-8-preview'
  ])('does not cross vendor boundaries or guess pseudo-variant %s', (model) => {
    expect(resolveOpenAiModelPricing(model, Date.UTC(2026, 6, 25))).toBeUndefined()
  })

  it('keeps priced and unpriced token invariants across GPT, Grok and Claude logs', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 100, outputTokens: 10 }),
      log('grok-4.5', { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }),
      log('claude-sonnet-4-6', {
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 20,
        cacheWriteInputTokens5m: 10,
        cacheWriteInputTokens1h: 10,
        outputTokens: 10
      }),
      log('private-unknown-model', { inputTokens: 100, outputTokens: 10 })
    ])

    expect(result).toMatchObject({
      totalTokens: 440,
      pricedTokens: 330,
      unpricedTokens: 110,
      pricedRequestCount: 3,
      unpricedRequestCount: 1,
      unknownModels: ['private-unknown-model']
    })
    expect(result.pricedTokens + result.unpricedTokens).toBe(result.totalTokens)
    expect(result.totalCostUsd).toBeCloseTo(
      result.inputCostUsd + result.cachedInputCostUsd + result.outputCostUsd,
      12
    )
    expect([
      result.inputCostUsd,
      result.cachedInputCostUsd,
      result.cacheWriteCostUsd,
      result.outputCostUsd,
      result.totalCostUsd
    ].every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
  })

  it('prices the actual gpt-5.6-sol log model with cache and long-context rules', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 })
    ])

    expect(result).toMatchObject({
      totalTokens: 1_100_000,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      standardInputTokens: 600_000,
      cachedInputTokens: 400_000,
      pricedTokens: 1_100_000,
      unpricedTokens: 0,
      inputCostUsd: 6,
      cachedInputCostUsd: 0.4,
      outputCostUsd: 4.5,
      totalCostUsd: 10.9,
      longContextRequestCount: 1
    })
  })

  it('charges separately reported cache writes at 1.25x without adding them to total tokens', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6', {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteInputTokens: 300_000,
        outputTokens: 0
      })
    ])

    expect(result).toMatchObject({
      totalTokens: 1_000_000,
      standardInputTokens: 500_000,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 300_000,
      inputCostUsd: 8.75,
      cacheWriteCostUsd: 3.75,
      cachedInputCostUsd: 0.2,
      totalCostUsd: 8.95,
      longContextRequestCount: 1
    })
  })

  it.each([
    ['gpt-5.4', 2.5],
    ['gpt-5.4-pro', 30],
    ['gpt-5.5', 5],
    ['gpt-5.5-pro', 30]
  ] as const)('does not invent a 1.25x cache-write price for %s', (model, inputRate) => {
    const result = estimateOpenAiTokenCosts([
      log(model, {
        inputTokens: 100_000,
        cacheWriteInputTokens: 50_000,
        outputTokens: 0
      })
    ])
    expect(result.cacheWriteCostUsd).toBeCloseTo(50_000 / 1_000_000 * inputRate, 12)
    expect(result.inputCostUsd).toBeCloseTo(100_000 / 1_000_000 * inputRate, 12)
  })

  it('uses the Terra and Luna rates and clearly separates unknown-model usage', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-terra', { inputTokens: 1_000_000, outputTokens: 100_000 }),
      log('gpt-5.6-luna', { inputTokens: 500_000, cachedInputTokens: 500_000, outputTokens: 200_000 }),
      log('vendor-private-model', { inputTokens: 50_000, outputTokens: 5_000 })
    ])

    expect(result.totalTokens).toBe(1_855_000)
    expect(result.pricedTokens).toBe(1_800_000)
    expect(result.unpricedTokens).toBe(55_000)
    expect(result.totalCostUsd).toBeCloseTo(6.18, 10)
    expect(result.unknownModels).toEqual(['vendor-private-model'])
  })

  it('selects a price independently for every request in a mixed-model log set', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 1_000_000, outputTokens: 0 }),
      log('gpt-5.5', { inputTokens: 100_000, outputTokens: 10_000 }),
      log('gpt-5.4-mini', { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 })
    ])
    expect(result.totalCostUsd).toBeCloseTo(11.6625, 10)
    expect(result.pricedRequestCount).toBe(3)
  })

  it.each([
    ['gpt-5.4', 2.5, 15],
    ['gpt-5.4-pro', 30, 180],
    ['gpt-5.5', 5, 30],
    ['gpt-5.5-pro', 30, 180]
  ] as const)('applies long-context multipliers only above 272K for %s', (model, inputRate, outputRate) => {
    const boundary = estimateOpenAiTokenCosts([
      log(model, { inputTokens: 272_000, outputTokens: 1_000 })
    ])
    const above = estimateOpenAiTokenCosts([
      log(model, { inputTokens: 272_001, outputTokens: 1_000 })
    ])
    expect(boundary.totalCostUsd).toBeCloseTo(272_000 / 1_000_000 * inputRate + 1_000 / 1_000_000 * outputRate, 12)
    expect(boundary.longContextRequestCount).toBe(0)
    expect(above.totalCostUsd).toBeCloseTo(272_001 / 1_000_000 * inputRate * 2 + 1_000 / 1_000_000 * outputRate * 1.5, 12)
    expect(above.longContextRequestCount).toBe(1)
  })

  it('prices Pro cached reads as ordinary input instead of applying a cache discount', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.5-pro', {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 100_000
      })
    ])
    expect(result).toMatchObject({
      standardInputTokens: 600_000,
      cachedInputTokens: 400_000,
      inputCostUsd: 36,
      cachedInputCostUsd: 24,
      outputCostUsd: 27,
      totalCostUsd: 87,
      longContextRequestCount: 1
    })
  })

  it('applies the 272K rule to 5.6 but not 5.4 Mini/Nano', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 300_000, outputTokens: 1_000 }),
      log('gpt-5.4-mini', { inputTokens: 300_000, outputTokens: 1_000 }),
      log('gpt-5.4-nano', { inputTokens: 300_000, outputTokens: 1_000 })
    ])
    expect(result.totalCostUsd).toBeCloseTo(
      (300_000 / 1_000_000 * 5 * 2 + 1_000 / 1_000_000 * 30 * 1.5)
      + (300_000 / 1_000_000 * 0.75 + 1_000 / 1_000_000 * 4.5)
      + (300_000 / 1_000_000 * 0.2 + 1_000 / 1_000_000 * 1.25),
      12
    )
    expect(result.longContextRequestCount).toBe(1)
  })

  it('clamps malformed cache details to the reported input total', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', {
        inputTokens: 100,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 300,
        outputTokens: 10
      })
    ])
    expect(result).toMatchObject({
      totalTokens: 110,
      standardInputTokens: 0,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 0
    })
  })

  it('uses the local natural-day boundary for today while keeping all-time totals', () => {
    const now = new Date(2026, 6, 19, 12, 0, 0).getTime()
    const start = new Date(2026, 6, 19, 0, 0, 0).getTime()
    const summary = summarizeOpenAiTokenCosts([
      log('gpt-5.6-sol', { timestamp: start - 1, inputTokens: 10, outputTokens: 1 }),
      log('gpt-5.6-sol', { timestamp: start, inputTokens: 20, outputTokens: 2 }),
      log('gpt-5.6-sol', { timestamp: new Date(2026, 6, 19, 23, 59, 59).getTime(), inputTokens: 30, outputTokens: 3 }),
      log('gpt-5.6-sol', { timestamp: new Date(2026, 6, 20, 0, 0, 0).getTime(), inputTokens: 40, outputTokens: 4 })
    ], now)

    expect(localNaturalDayStart(now)).toBe(start)
    expect(summary.today.totalTokens).toBe(55)
    expect(summary.allTime.totalTokens).toBe(110)
  })

  it('prices only the selected account logs inside each current quota cycle', () => {
    const now = 1_800_000_000_000
    const fiveHourReset = now + 60 * 60 * 1000
    const sevenDayReset = now + 24 * 60 * 60 * 1000
    const costs = summarizeAccountCodexQuotaCycleCosts([
      log('gpt-5.6-sol', { accountId: 'target', timestamp: fiveHourReset - 5 * 60 * 60 * 1000, inputTokens: 1_000_000 }),
      log('gpt-5.6-sol', { accountId: 'target', timestamp: fiveHourReset - 5 * 60 * 60 * 1000 - 1, inputTokens: 1_000_000 }),
      log('gpt-5.6-sol', { accountId: 'other', timestamp: now - 1_000, inputTokens: 1_000_000 }),
      log('gpt-5.6-sol', { accountId: 'target', timestamp: sevenDayReset - 7 * 24 * 60 * 60 * 1000, outputTokens: 1_000_000 }),
    ], 'target', {
      fiveHour: { usedPercent: 20, windowSeconds: 5 * 60 * 60, resetAt: fiveHourReset },
      sevenDay: { usedPercent: 40, windowSeconds: 7 * 24 * 60 * 60, resetAt: sevenDayReset },
      observedAt: now,
      source: 'usage-endpoint',
    }, now)

    expect(costs).toMatchObject({
      fiveHourUsd: 10,
      sevenDayUsd: 50,
      fiveHourUnpricedUsdTokens: 0,
      sevenDayUnpricedUsdTokens: 0,
      fiveHourCredits: 125,
      sevenDayCredits: 1_000,
      fiveHourUnpricedCreditTokens: 0,
      sevenDayUnpricedCreditTokens: 0
    })
  })

  it('tracks USD and Codex-credit pricing completeness independently', () => {
    const now = 1_800_000_000_000
    const resetAt = now + 60 * 60 * 1000
    const costs = summarizeAccountCodexQuotaCycleCosts([
      log('gpt-5.4-nano', {
        accountId: 'target', timestamp: now - 1_000, inputTokens: 100,
      }),
      log('gpt-5.5-cyber', {
        accountId: 'target', timestamp: now - 500, outputTokens: 200,
      }),
    ], 'target', {
      fiveHour: { usedPercent: 20, windowSeconds: 5 * 60 * 60, resetAt },
      observedAt: now,
      source: 'usage-endpoint',
    }, now)

    expect(costs.fiveHourUnpricedUsdTokens).toBe(200)
    expect(costs.fiveHourUnpricedCreditTokens).toBe(100)
  })
})
