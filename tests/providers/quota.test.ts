import { describe, expect, it } from 'vitest'
import {
  codexQuotaCooldownUntil,
  codexQuotaIsExhausted,
  extractCodexQuotaFromHeaders,
  extractCodexQuotaFromUsagePayload,
  extractProtocolUsage,
  extractQuotaSignals,
  extractRateLimitSignals,
  mergeQuotaSignals,
  parseQuotaResetAt,
  type NormalizedQuotaSignals
} from '../../src/main/providers'

const now = Date.parse('2026-07-12T00:00:00.000Z')

describe('Codex quota cooldown', () => {
  it('waits for every exhausted window and uses the latest actual reset', () => {
    const quota = {
      observedAt: now,
      source: 'usage-endpoint' as const,
      allowed: false,
      limitReached: true,
      fiveHour: { usedPercent: 100, resetAt: now + 30 * 60_000 },
      sevenDay: { usedPercent: 100, resetAt: now + 2 * 60 * 60_000 }
    }
    expect(codexQuotaIsExhausted(quota, now)).toBe(true)
    expect(codexQuotaCooldownUntil(quota, now)).toBe(now + 2 * 60 * 60_000)
  })

  it('probes at the nearest known reset when only the top-level flag is exhausted', () => {
    const quota = {
      observedAt: now,
      source: 'usage-endpoint' as const,
      limitReached: true,
      fiveHour: { usedPercent: 93, resetAt: now + 20 * 60_000 },
      sevenDay: { usedPercent: 75, resetAt: now + 3 * 60 * 60_000 }
    }
    expect(codexQuotaCooldownUntil(quota, now)).toBe(now + 20 * 60_000)
  })
})

describe('quota response header extraction', () => {
  it('normalizes numeric counters, composite durations, and retry delays', () => {
    expect(extractRateLimitSignals({
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': '123',
      'x-ratelimit-reset-requests': '1m30.5s',
      'x-ratelimit-limit-tokens': '100000',
      'x-ratelimit-remaining-tokens': '42000',
      'x-ratelimit-reset-tokens': '500ms',
      'retry-after': '2.5'
    }, 'openai-responses', now)).toEqual({
      rateLimits: {
        requests: { limit: 500, remaining: 123, resetAt: now + 90_500 },
        tokens: { limit: 100_000, remaining: 42_000, resetAt: now + 500 }
      },
      retryAfterMs: 2_500,
      retryAt: now + 2_500
    })
  })

  it('supports structured standard counters and numeric reset seconds', () => {
    expect(extractRateLimitSignals({
      'ratelimit-limit': '100;w=60',
      'ratelimit-remaining': '75',
      'ratelimit-reset': '12'
    }, 'openai-chat', now)).toEqual({
      rateLimits: {
        requests: { limit: 100, remaining: 75, resetAt: now + 12_000 }
      }
    })
  })

  it('parses protocol-specific reset dates and gives them precedence', () => {
    expect(extractRateLimitSignals({
      'ratelimit-remaining': '99',
      'x-ratelimit-remaining-requests': '88',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '7',
      'anthropic-ratelimit-requests-reset': '2026-07-12T00:05:00Z',
      'anthropic-ratelimit-tokens-remaining': '9000',
      'anthropic-ratelimit-input-tokens-remaining': '6000',
      'anthropic-ratelimit-output-tokens-remaining': '3000'
    }, 'anthropic-messages', now)).toEqual({
      rateLimits: {
        requests: { limit: 50, remaining: 7, resetAt: now + 300_000 },
        tokens: { remaining: 9_000 },
        inputTokens: { remaining: 6_000 },
        outputTokens: { remaining: 3_000 }
      }
    })
  })

  it('supports epoch timestamps without mistaking them for durations', () => {
    const epochSeconds = Math.floor((now + 60_000) / 1000)
    expect(parseQuotaResetAt(String(epochSeconds), now)).toBe(now + 60_000)
    expect(parseQuotaResetAt(String(now + 120_000), now)).toBe(now + 120_000)
  })

  it('ignores malformed, negative, unsafe, and ambiguous values', () => {
    expect(extractQuotaSignals({
      protocol: 'openai-chat',
      now,
      headers: {
        'x-ratelimit-limit-requests': '-1',
        'x-ratelimit-remaining-requests': 'NaN',
        'x-ratelimit-reset-requests': '1 fortnight',
        'x-ratelimit-remaining-tokens': '9007199254740992',
        'retry-after': 'eventually',
        authorization: 'Bearer must-not-be-retained'
      },
      payload: {
        usage: {
          prompt_tokens: '12',
          completion_tokens: -1,
          total_tokens: 1.5
        },
        privateBody: 'must-not-be-retained'
      }
    })).toEqual({})
  })
})

describe('Codex quota extraction', () => {
  it('maps primary and secondary response headers by their declared window durations', () => {
    expect(extractCodexQuotaFromHeaders({
      'x-codex-primary-used-percent': '21.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '90.25',
      'x-codex-secondary-used-percent': '64',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '3600'
    }, now)).toEqual({
      fiveHour: {
        usedPercent: 21.5,
        windowSeconds: 5 * 60 * 60,
        resetAt: now + 90_250
      },
      sevenDay: {
        usedPercent: 64,
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: now + 3_600_000
      },
      observedAt: now,
      source: 'response-headers'
    })
  })

  it('recognizes five-hour and seven-day windows when primary and secondary are reversed', () => {
    expect(extractCodexQuotaFromHeaders({
      'x-codex-primary-used-percent': '71',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '700',
      'x-codex-secondary-used-percent': '18',
      'x-codex-secondary-window-minutes': '300',
      'x-codex-secondary-reset-after-seconds': '50'
    }, now)).toEqual({
      fiveHour: {
        usedPercent: 18,
        windowSeconds: 5 * 60 * 60,
        resetAt: now + 50_000
      },
      sevenDay: {
        usedPercent: 71,
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: now + 700_000
      },
      observedAt: now,
      source: 'response-headers'
    })
  })

  it('uses the six-hour threshold to classify a single declared window', () => {
    expect(extractCodexQuotaFromHeaders({
      'x-codex-primary-used-percent': '9',
      'x-codex-primary-window-minutes': '360'
    }, now)).toEqual({
      fiveHour: { usedPercent: 9, windowSeconds: 6 * 60 * 60 },
      observedAt: now,
      source: 'response-headers'
    })

    expect(extractCodexQuotaFromHeaders({
      'x-codex-secondary-used-percent': '44',
      'x-codex-secondary-window-minutes': '361'
    }, now)).toEqual({
      sevenDay: { usedPercent: 44, windowSeconds: 361 * 60 },
      observedAt: now,
      source: 'response-headers'
    })
  })

  it('keeps the legacy slot mapping when window-duration headers are absent', () => {
    expect(extractCodexQuotaFromHeaders({
      'x-codex-primary-used-percent': '82',
      'x-codex-primary-reset-after-seconds': '800',
      'x-codex-secondary-used-percent': '13',
      'x-codex-secondary-reset-after-seconds': '30'
    }, now)).toEqual({
      fiveHour: { usedPercent: 13, resetAt: now + 30_000 },
      sevenDay: { usedPercent: 82, resetAt: now + 800_000 },
      observedAt: now,
      source: 'response-headers'
    })
  })

  it('ignores malformed, negative, non-finite, and unsafe Codex values', () => {
    expect(extractCodexQuotaFromHeaders({
      'x-codex-primary-used-percent': '-1',
      'x-codex-primary-window-minutes': 'NaN',
      'x-codex-primary-reset-after-seconds': 'Infinity',
      'x-codex-secondary-used-percent': '9007199254740992',
      'x-codex-secondary-window-minutes': '-300',
      'x-codex-secondary-reset-after-seconds': 'not-a-duration',
      authorization: 'Bearer must-not-be-retained'
    }, now)).toBeUndefined()

    expect(extractCodexQuotaFromUsagePayload({
      rate_limit: {
        primary_window: {
          used_percent: Number.NaN,
          limit_window_seconds: -1,
          reset_at: Number.POSITIVE_INFINITY,
          reset_after_seconds: Number.MAX_SAFE_INTEGER + 1
        },
        secondary_window: {
          used_percent: '12',
          limit_window_seconds: '18000',
          reset_at: 'must-not-be-retained'
        }
      },
      access_token: 'must-not-be-retained'
    }, now)).toBeUndefined()
  })

  it('extracts WHAM windows and gives reset_at precedence over reset_after_seconds', () => {
    const absoluteResetSeconds = Math.floor((now + 120_000) / 1000)
    const absoluteResetMilliseconds = now + 7_200_000
    expect(extractCodexQuotaFromUsagePayload({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 24,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: absoluteResetSeconds,
          reset_after_seconds: 999
        },
        secondary_window: {
          used_percent: 55.5,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: absoluteResetMilliseconds,
          reset_after_seconds: 1
        }
      }
    }, now)).toEqual({
      fiveHour: {
        usedPercent: 24,
        windowSeconds: 5 * 60 * 60,
        resetAt: now + 120_000
      },
      sevenDay: {
        usedPercent: 55.5,
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: absoluteResetMilliseconds
      },
      allowed: true,
      limitReached: false,
      observedAt: now,
      source: 'usage-endpoint'
    })
  })

  it('accepts a partial WHAM response, falls back from null reset_at, and ignores null windows', () => {
    expect(extractCodexQuotaFromUsagePayload({
      rate_limit: {
        allowed: true,
        limit_reached: null,
        primary_window: {
          used_percent: 33,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: null,
          reset_after_seconds: 45
        },
        secondary_window: null
      }
    }, now)).toEqual({
      fiveHour: {
        usedPercent: 33,
        windowSeconds: 5 * 60 * 60,
        resetAt: now + 45_000
      },
      allowed: true,
      observedAt: now,
      source: 'usage-endpoint'
    })

    expect(extractCodexQuotaFromUsagePayload(null, now)).toBeUndefined()
    expect(extractCodexQuotaFromUsagePayload({ rate_limit: null }, now)).toBeUndefined()
    expect(extractCodexQuotaFromUsagePayload({
      rate_limit: { allowed: false, limit_reached: true, primary_window: null, secondary_window: null }
    }, now)).toBeUndefined()
  })
})

describe('protocol usage extraction', () => {
  it('normalizes OpenAI Chat and Responses usage details', () => {
    expect(extractProtocolUsage('openai-chat', {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 12 }
      }
    })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 40,
      reasoningTokens: 12
    })

    expect(extractProtocolUsage('openai-responses', {
      response: {
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens_details: { reasoning_tokens: 20 }
        }
      }
    })).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
      cachedInputTokens: 80,
      reasoningTokens: 20
    })
  })

  it('normalizes Anthropic cache usage without guessing it into input totals', () => {
    expect(extractProtocolUsage('anthropic-messages', {
      message: { usage: { input_tokens: 25, cache_read_input_tokens: 100 } },
      usage: { output_tokens: 10, cache_creation_input_tokens: 40 }
    })).toEqual({
      inputTokens: 25,
      outputTokens: 10,
      totalTokens: 35,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 40
    })
  })

  it('normalizes Gemini usage metadata', () => {
    expect(extractProtocolUsage('gemini', {
      usageMetadata: {
        promptTokenCount: 300,
        candidatesTokenCount: 70,
        totalTokenCount: 390,
        cachedContentTokenCount: 100,
        thoughtsTokenCount: 20
      }
    })).toEqual({
      inputTokens: 300,
      outputTokens: 70,
      totalTokens: 390,
      cachedInputTokens: 100,
      reasoningTokens: 20
    })
  })

  it('returns detached normalized data without retaining unknown response fields', () => {
    const payload = {
      usage: { input_tokens: 4, output_tokens: 2 },
      credential: 'provider-secret',
      output: [{ large: 'body-content' }]
    }
    const signals = extractQuotaSignals({ protocol: 'openai-responses', payload, now })
    payload.usage.input_tokens = 999

    expect(signals).toEqual({ usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } })
    expect(JSON.stringify(signals)).not.toContain('provider-secret')
    expect(JSON.stringify(signals)).not.toContain('body-content')
  })
})

describe('quota signal merge precedence', () => {
  it('lets later defined leaves win while preserving omitted observations', () => {
    const earlier: NormalizedQuotaSignals = {
      rateLimits: {
        requests: { limit: 100, remaining: 90, resetAt: now + 60_000 },
        tokens: { limit: 10_000, remaining: 8_000 }
      },
      retryAfterMs: 10_000,
      retryAt: now + 10_000,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
    }
    const later: NormalizedQuotaSignals = {
      rateLimits: {
        requests: { remaining: 40, resetAt: undefined },
        tokens: { remaining: 3_000 }
      },
      retryAfterMs: 2_000,
      retryAt: now + 2_000,
      usage: { inputTokens: undefined, outputTokens: 8 }
    }

    expect(mergeQuotaSignals(earlier, later)).toEqual({
      rateLimits: {
        requests: { limit: 100, remaining: 40, resetAt: now + 60_000 },
        tokens: { limit: 10_000, remaining: 3_000 }
      },
      retryAfterMs: 2_000,
      retryAt: now + 2_000,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 25 }
    })
  })

  it('merges a partial usage-endpoint Codex snapshot over response-header observations', () => {
    const earlier: NormalizedQuotaSignals = {
      codexQuota: {
        fiveHour: { usedPercent: 10, windowSeconds: 18_000, resetAt: now + 60_000 },
        sevenDay: { usedPercent: 30, windowSeconds: 604_800, resetAt: now + 600_000 },
        allowed: true,
        limitReached: false,
        observedAt: now,
        source: 'response-headers'
      }
    }
    const later: NormalizedQuotaSignals = {
      codexQuota: {
        fiveHour: { usedPercent: 12 },
        limitReached: true,
        observedAt: now + 1_000,
        source: 'usage-endpoint'
      }
    }

    expect(mergeQuotaSignals(earlier, later)).toEqual({
      codexQuota: {
        fiveHour: { usedPercent: 12, windowSeconds: 18_000, resetAt: now + 60_000 },
        sevenDay: { usedPercent: 30, windowSeconds: 604_800, resetAt: now + 600_000 },
        allowed: true,
        limitReached: true,
        observedAt: now + 1_000,
        source: 'usage-endpoint'
      }
    })
  })
})
