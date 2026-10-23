import type { LucideIcon } from 'lucide-react'

export interface QuickNavigationItem<TId extends string = string> {
  id: TId
  label: readonly [string, string]
  description: readonly [string, string]
  keywords: readonly [string, string]
  icon: LucideIcon
  kind?: 'page' | 'action'
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function searchScore(item: QuickNavigationItem, query: string): number | undefined {
  const tokens = normalizedSearchText(query).split(' ').filter(Boolean)
  if (!tokens.length) return 0
  const labels = item.label.map(normalizedSearchText)
  const descriptions = item.description.map(normalizedSearchText)
  const keywords = item.keywords.map(normalizedSearchText)
  const corpus = [item.id, ...labels, ...descriptions, ...keywords].join(' ')
  if (!tokens.every((token) => corpus.includes(token))) return undefined

  let score = 0
  for (const token of tokens) {
    if (labels.some((label) => label === token)) score += 120
    else if (labels.some((label) => label.startsWith(token))) score += 90
    else if (labels.some((label) => label.includes(token))) score += 70
    else if (keywords.some((value) => value.includes(token))) score += 45
    else score += 20
  }
  return score
}

export function filterQuickNavigationItems<TId extends string>(
  items: readonly QuickNavigationItem<TId>[],
  query: string,
  recentIds: readonly TId[],
  activeId: TId,
): QuickNavigationItem<TId>[] {
  const normalizedQuery = normalizedSearchText(query)
  if (normalizedQuery) {
    return items
      .map((item, index) => ({ item, index, score: searchScore(item, normalizedQuery) }))
      .filter((entry): entry is { item: QuickNavigationItem<TId>; index: number; score: number } => entry.score !== undefined)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ item }) => item)
  }

  const byId = new Map(items.map((item) => [item.id, item]))
  const recent = recentIds
    .filter((id) => id !== activeId)
    .map((id) => byId.get(id))
    .filter((item): item is QuickNavigationItem<TId> => Boolean(item))
  const recentSet = new Set(recent.map((item) => item.id))
  return [...recent, ...items.filter((item) => !recentSet.has(item.id))]
}
