import { describe, expect, it } from 'vitest'
import {
  estimateOpenAiTokenCosts,
  localNaturalDayStart,
  resolveOpenAiModelPricing,
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
    ...overrides
  }
}

describe('OpenAI standard API pricing', () => {
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

  it.each(['gpt-5.6-sol-pro', 'gpt-5.5-mini', 'gpt-5.4-ultra', 'gpt-5.4-pro-max', 'o4-mini', '', 'custom/gpt-5.6-sol'])(
    'does not guess a price for unknown model %j',
    (model) => expect(resolveOpenAiModelPricing(model)).toBeUndefined()
  )

  it('prices the actual gpt-5.6-sol log model without double-counting cached reads', () => {
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
      inputCostUsd: 3,
      cachedInputCostUsd: 0.2,
      outputCostUsd: 3,
      totalCostUsd: 6.2
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
      inputCostUsd: 4.375,
      cacheWriteCostUsd: 1.875,
      cachedInputCostUsd: 0.1,
      totalCostUsd: 4.475
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
    expect(result.totalCostUsd).toBeCloseTo(5.25, 10)
    expect(result.unknownModels).toEqual(['vendor-private-model'])
  })

  it('selects a price independently for every request in a mixed-model log set', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 1_000_000, outputTokens: 0 }),
      log('gpt-5.5', { inputTokens: 100_000, outputTokens: 10_000 }),
      log('gpt-5.4-mini', { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 })
    ])
    expect(result.totalCostUsd).toBeCloseTo(6.6625, 10)
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

  it('does not apply the 272K rule to 5.6 or 5.4 Mini/Nano', () => {
    const result = estimateOpenAiTokenCosts([
      log('gpt-5.6-sol', { inputTokens: 300_000, outputTokens: 1_000 }),
      log('gpt-5.4-mini', { inputTokens: 300_000, outputTokens: 1_000 }),
      log('gpt-5.4-nano', { inputTokens: 300_000, outputTokens: 1_000 })
    ])
    expect(result.totalCostUsd).toBeCloseTo(
      (300_000 / 1_000_000 * 5 + 1_000 / 1_000_000 * 30)
      + (300_000 / 1_000_000 * 0.75 + 1_000 / 1_000_000 * 4.5)
      + (300_000 / 1_000_000 * 0.2 + 1_000 / 1_000_000 * 1.25),
      12
    )
    expect(result.longContextRequestCount).toBe(0)
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
})
