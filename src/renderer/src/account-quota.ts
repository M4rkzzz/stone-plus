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

/**
 * "Is the account unusable right now" — a different question than
 * accountRemainingPercent's "how much is left". Exhaustion honors resetAt
 * expiry and zero-remaining windows without a limit, so neither function can
 * be derived from the other; keep both here so the two answers stay adjacent.
 */
export function accountQuotaIsExhausted(account: PublicAccount, now = Date.now()): boolean {
  if (account.quotaRemaining !== undefined && account.quotaRemaining <= 0) return true
  if (account.codexQuota?.limitReached || account.codexQuota?.allowed === false) return true
  if ([account.codexQuota?.fiveHour, account.codexQuota?.sevenDay].some((window) =>
    window !== undefined && window.usedPercent >= 100 && (window.resetAt === undefined || window.resetAt > now)
  )) return true
  return [account.quota?.requests, account.quota?.tokens, account.quota?.inputTokens, account.quota?.outputTokens]
    .some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

export function accountIsCooling(account: PublicAccount, now = Date.now()): boolean {
  return account.status === 'cooldown' || (account.cooldownUntil !== undefined && account.cooldownUntil > now)
}

export function thawCountdown(until: number, now: number): string {
  const totalMinutes = Math.max(1, Math.ceil((until - now) / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor(totalMinutes % 1_440 / 60)
  if (days > 0) return `${days}d${hours}h`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours > 0) return `${totalHours}h${minutes}m`
  return `${totalMinutes}m`
}

export function accountRecoveryAt(account: PublicAccount, now: number): number | undefined {
  const candidates: number[] = []
  if (account.cooldownUntil !== undefined && account.cooldownUntil > now) candidates.push(account.cooldownUntil)

  const quotaResets = [account.quota?.requests, account.quota?.tokens, account.quota?.inputTokens, account.quota?.outputTokens]
    .filter((window) => window?.remaining === 0 && window.resetAt !== undefined && window.resetAt > now)
    .map((window) => window!.resetAt!)
  if (quotaResets.length) candidates.push(Math.max(...quotaResets))

  if (accountQuotaIsExhausted(account, now) && account.codexQuota) {
    const windows = [account.codexQuota.fiveHour, account.codexQuota.sevenDay].filter(Boolean)
    const exhaustedResets = windows
      .filter((window) => window!.usedPercent >= 100 && window!.resetAt !== undefined && window!.resetAt! > now)
      .map((window) => window!.resetAt!)
    if (exhaustedResets.length) candidates.push(Math.max(...exhaustedResets))
    else {
      const futureResets = windows
        .filter((window) => window!.resetAt !== undefined && window!.resetAt! > now)
        .map((window) => window!.resetAt!)
      if (futureResets.length) candidates.push(Math.min(...futureResets))
    }
  }
  return candidates.length ? Math.max(...candidates) : undefined
}

function windowRemainingPercent(window: QuotaWindow | undefined): number | undefined {
  if (!window || window.limit === undefined || window.remaining === undefined || window.limit <= 0) return undefined
  return clampPercent((window.remaining / window.limit) * 100)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}
