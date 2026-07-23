import { describe, expect, it } from 'vitest'
import type { PublicAccount } from '../../src/shared/types'
import { accountRemainingPercent, summarizeAccountQuota } from '../../src/renderer/src/account-quota'

const baseAccount = {
  id: 'account-1',
  providerId: 'openai',
  name: 'Account',
  maskedCredential: '***',
  status: 'active',
} as PublicAccount

describe('account quota summary', () => {
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
