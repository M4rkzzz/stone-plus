import type { AppSnapshot, PublicAccount, QuotaWindow } from '@shared/types'

export interface AccountQuotaSummary {
  percent: number
  accountCount: number
}

/**
 * Returns the usable percentage for an account. When an upstream exposes
 * multiple rate windows, the tightest window is the account's effective quota.
 */
export function accountRemainingPercent(account: PublicAccount): number | undefined {
  const codexWindows = [account.codexQuota?.fiveHour, account.codexQuota?.sevenDay]
    .filter((window) => window !== undefined)
    .map((window) => 100 - window.usedPercent)
  if (codexWindows.length) return clampPercent(Math.min(...codexWindows))

  if (account.quotaUnit === 'percent' && account.quotaRemaining !== undefined) {
    return clampPercent(account.quotaRemaining)
  }

  const standardWindows = account.quota
    ? [account.quota.requests, account.quota.tokens, account.quota.inputTokens, account.quota.outputTokens]
      .map(windowRemainingPercent)
      .filter((percent) => percent !== undefined)
    : []
  if (standardWindows.length) return Math.min(...standardWindows)

  return undefined
}

export function summarizeAccountQuota(accounts: AppSnapshot['accounts']): AccountQuotaSummary | undefined {
  const percentages = accounts
    .filter((account) => account.status !== 'disabled' && account.status !== 'expired')
    .map(accountRemainingPercent)
    .filter((percent) => percent !== undefined)

  if (!percentages.length) return undefined
  return {
    percent: percentages.reduce((total, percent) => total + percent, 0) / percentages.length,
    accountCount: percentages.length,
  }
}

function windowRemainingPercent(window: QuotaWindow | undefined): number | undefined {
  if (!window || window.limit === undefined || window.remaining === undefined || window.limit <= 0) return undefined
  return clampPercent((window.remaining / window.limit) * 100)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}
