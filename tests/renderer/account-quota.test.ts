import { describe, expect, it } from 'vitest'
import type { PublicAccount } from '../../src/shared/types'
import {
  accountIsCooling,
  accountQuotaIsExhausted,
  accountRecoveryAt,
  accountRemainingPercent,
  formatAccountQuotaUsd,
  summarizeAccountQuota,
  thawCountdown,
} from '../../src/renderer/src/account-quota'

const baseAccount = {
  id: 'account-1',
  providerId: 'openai',
  name: 'Account',
  maskedCredential: '***',
  status: 'active',
} as PublicAccount

describe('account quota summary', () => {
  it('formats account quota details in USD instead of credits', () => {
    expect(formatAccountQuotaUsd(12.345, 'en-US')).toBe('$12.35')
    expect(formatAccountQuotaUsd(0.125, 'zh-CN')).toBe('$0.125')
    expect(formatAccountQuotaUsd(undefined, 'zh-CN')).toBe('—')
  })

  it('uses the tightest Codex window as effective remaining quota', () => {
    expect(accountRemainingPercent({
      ...baseAccount,
      codexQuota: {
        fiveHour: { usedPercent: 20 },
        sevenDay: { usedPercent: 65 },
        observedAt: Date.now(),
        source: 'usage-endpoint',
      },
    })).toBe(35)
  })

  it('averages known usable accounts and excludes disabled accounts', () => {
    expect(summarizeAccountQuota([
      { ...baseAccount, quotaRemaining: 80, quotaUnit: 'percent' },
      { ...baseAccount, id: 'account-2', quotaRemaining: 40, quotaUnit: 'percent' },
      { ...baseAccount, id: 'account-3', status: 'disabled', quotaRemaining: 0, quotaUnit: 'percent' },
      { ...baseAccount, id: 'account-4' },
    ])).toEqual({ percent: 60, accountCount: 2 })
  })

  it('includes known Grok OAuth billing percentages and keeps unknown Grok accounts out of the average', () => {
    expect(summarizeAccountQuota([
      { ...baseAccount, credentialType: 'grok-oauth', quotaRemaining: 57.5, quotaUnit: 'percent' },
      { ...baseAccount, id: 'grok-unknown', credentialType: 'grok-oauth' },
      { ...baseAccount, id: 'grok-empty', credentialType: 'grok-oauth', quotaRemaining: 0, quotaUnit: 'percent' },
    ])).toEqual({ percent: 28.75, accountCount: 2 })
  })

  it('derives percentages from standard quota windows and clamps bad upstream values', () => {
    expect(accountRemainingPercent({
      ...baseAccount,
      quota: {
        requests: { limit: 100, remaining: 75 },
        tokens: { limit: 1_000, remaining: 250 },
        observedAt: Date.now(),
      },
    })).toBe(25)
    expect(accountRemainingPercent({ ...baseAccount, quotaRemaining: 140, quotaUnit: 'percent' })).toBe(100)
  })
})

describe('account quota availability', () => {
  const now = Date.UTC(2026, 6, 26, 8, 0, 0)

  it('treats confirmed quota cooldowns and active zero-remaining windows as exhausted', () => {
    expect(accountQuotaIsExhausted({ ...baseAccount, quotaRemaining: 0 }, now)).toBe(true)
    expect(accountQuotaIsExhausted({
      ...baseAccount,
      status: 'cooldown',
      cooldownReason: 'quota',
      codexQuota: { limitReached: true, observedAt: now, source: 'usage-endpoint' },
    }, now)).toBe(true)
    // WHAM flags remain useful telemetry, but do not hide an OAuth account
    // until a real Responses request has put it in quota cooldown.
    expect(accountQuotaIsExhausted({
      ...baseAccount,
      codexQuota: { allowed: false, observedAt: now, source: 'usage-endpoint' },
    }, now)).toBe(false)
    expect(accountQuotaIsExhausted({
      ...baseAccount,
      quota: {
        requests: { remaining: 0, resetAt: now + 60_000 },
        observedAt: now,
      },
    }, now)).toBe(true)
  })

  it('ignores expired quota windows at and before the reset boundary', () => {
    for (const resetAt of [now - 1, now]) {
      expect(accountQuotaIsExhausted({
        ...baseAccount,
        codexQuota: {
          fiveHour: { usedPercent: 100, resetAt },
          observedAt: now,
          source: 'usage-endpoint',
        },
      }, now)).toBe(false)
      expect(accountQuotaIsExhausted({
        ...baseAccount,
        quota: {
          tokens: { remaining: 0, resetAt },
          observedAt: now,
        },
      }, now)).toBe(false)
    }
  })

  it('keeps zero-remaining windows without a reset exhausted', () => {
    expect(accountQuotaIsExhausted({
      ...baseAccount,
      quota: {
        outputTokens: { remaining: 0 },
        observedAt: now,
      },
    }, now)).toBe(true)
  })
})

describe('account cooldown and recovery timing', () => {
  const now = Date.UTC(2026, 6, 26, 8, 0, 0)

  it('uses a strict future boundary for cooldownUntil while honoring explicit cooldown status', () => {
    expect(accountIsCooling({ ...baseAccount, cooldownUntil: now + 1 }, now)).toBe(true)
    expect(accountIsCooling({ ...baseAccount, cooldownUntil: now }, now)).toBe(false)
    expect(accountIsCooling({ ...baseAccount, cooldownUntil: now - 1 }, now)).toBe(false)
    expect(accountIsCooling({ ...baseAccount, status: 'cooldown', cooldownUntil: now - 1 }, now)).toBe(true)
  })

  it('formats future countdowns and floors expired or sub-minute values to one minute', () => {
    expect(thawCountdown(now - 1, now)).toBe('1m')
    expect(thawCountdown(now + 1, now)).toBe('1m')
    expect(thawCountdown(now + 61 * 60_000, now)).toBe('1h1m')
    expect(thawCountdown(now + (2 * 1_440 + 3 * 60) * 60_000, now)).toBe('2d3h')
  })

  it('returns the latest future recovery boundary across cooldown and exhausted windows', () => {
    const cooldownUntil = now + 30 * 60_000
    const requestReset = now + 60 * 60_000
    const tokenReset = now + 2 * 60 * 60_000
    expect(accountRecoveryAt({
      ...baseAccount,
      cooldownUntil,
      quota: {
        requests: { remaining: 0, resetAt: requestReset },
        tokens: { remaining: 0, resetAt: tokenReset },
        observedAt: now,
      },
    }, now)).toBe(tokenReset)
  })

  it('ignores expired reset times and returns undefined when no future recovery is known', () => {
    expect(accountRecoveryAt({
      ...baseAccount,
      cooldownUntil: now,
      quota: {
        requests: { remaining: 0, resetAt: now - 1 },
        observedAt: now,
      },
      codexQuota: {
        fiveHour: { usedPercent: 100, resetAt: now },
        observedAt: now,
        source: 'usage-endpoint',
      },
    }, now)).toBeUndefined()
    expect(accountRecoveryAt({ ...baseAccount }, now)).toBeUndefined()
  })

  it('uses a future Codex reset for an exhausted account', () => {
    const fiveHourReset = now + 45 * 60_000
    const sevenDayReset = now + 3 * 60 * 60_000
    expect(accountRecoveryAt({
      ...baseAccount,
      status: 'cooldown',
      cooldownReason: 'quota',
      codexQuota: {
        fiveHour: { usedPercent: 100, resetAt: fiveHourReset },
        sevenDay: { usedPercent: 100, resetAt: sevenDayReset },
        observedAt: now,
        source: 'usage-endpoint',
      },
    }, now)).toBe(sevenDayReset)
  })
})
