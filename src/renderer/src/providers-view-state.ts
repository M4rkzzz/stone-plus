import type { PublicAccount } from '@shared/types'

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
