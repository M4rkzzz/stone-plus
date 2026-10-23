import type { PublicAccount } from '@shared/types'

/** Keep high-churn account rows within a predictable reconciliation budget. */
export const ACCOUNT_RENDER_PAGE_SIZE = 100

export interface AccountPage<T> {
  items: T[]
  page: number
  pageCount: number
  start: number
  end: number
  total: number
}

export function paginateAccounts<T>(items: readonly T[], requestedPage: number): AccountPage<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / ACCOUNT_RENDER_PAGE_SIZE))
  const normalizedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0
  const page = Math.max(0, Math.min(pageCount - 1, normalizedPage))
  const offset = page * ACCOUNT_RENDER_PAGE_SIZE
  const pageItems = items.slice(offset, offset + ACCOUNT_RENDER_PAGE_SIZE)

  return {
    items: pageItems,
    page,
    pageCount,
    start: total === 0 ? 0 : offset + 1,
    end: offset + pageItems.length,
    total,
  }
}

export function accountDisplayNames(accounts: readonly Pick<PublicAccount, 'id' | 'name'>[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const account of accounts) counts.set(account.name, (counts.get(account.name) ?? 0) + 1)

  const occurrences = new Map<string, number>()
  return new Map(accounts.map((account) => {
    if ((counts.get(account.name) ?? 0) <= 1) return [account.id, account.name]
    const occurrence = (occurrences.get(account.name) ?? 0) + 1
    occurrences.set(account.name, occurrence)
    return [account.id, `${account.name}(${occurrence})`]
  }))
}

export function selectMatchingAccountIds<T extends { id: string }>(
  accounts: readonly T[],
  predicate: (account: T) => boolean,
): string[] {
  return accounts.filter(predicate).map((account) => account.id)
}

export function accountSelectionSummary(
  accounts: readonly Pick<PublicAccount, 'id' | 'name'>[],
  visibleIds: ReadonlySet<string>,
  limit = 8,
) {
  return {
    names: accounts.slice(0, limit).map((account) => account.name),
    remainingCount: Math.max(0, accounts.length - limit),
    hiddenCount: accounts.filter((account) => !visibleIds.has(account.id)).length,
  }
}

export function nextTabIndex(currentIndex: number, count: number, key: string): number | undefined {
  if (count <= 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + count) % count
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % count
  return undefined
}
