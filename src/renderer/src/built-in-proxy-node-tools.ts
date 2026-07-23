import type { BuiltInProxyNodeSummary } from '@shared/types'

export type BuiltInProxyNodeSortMode = 'current' | 'latency' | 'name'

export type BuiltInProxyLatencyGrade =
  | 'unknown'
  | 'testing'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'failure'

export interface SelectBuiltInProxyNodesOptions {
  query?: string
  sortMode: BuiltInProxyNodeSortMode
  activeNodeId?: string
  locale?: string
}

export const BUILT_IN_PROXY_FAST_LATENCY_MAX_MS = 200
export const BUILT_IN_PROXY_MEDIUM_LATENCY_MAX_MS = 500

/**
 * Produces the small set of UI states used by latency badges and legends.
 * An `available` result without a finite, non-negative duration is treated as
 * unknown rather than being shown as an implausibly fast or slow result.
 */
export function classifyBuiltInProxyNodeLatency(
  node: Pick<BuiltInProxyNodeSummary, 'latencyStatus' | 'latencyMs'>,
): BuiltInProxyLatencyGrade {
  if (node.latencyStatus === 'testing') return 'testing'
  if (node.latencyStatus === 'timeout' || node.latencyStatus === 'error') return 'failure'
  if (node.latencyStatus !== 'available' || !isValidLatency(node.latencyMs)) return 'unknown'
  if (node.latencyMs <= BUILT_IN_PROXY_FAST_LATENCY_MAX_MS) return 'fast'
  if (node.latencyMs <= BUILT_IN_PROXY_MEDIUM_LATENCY_MAX_MS) return 'medium'
  return 'slow'
}

/**
 * Searches only renderer-safe display fields. Call this after the existing
 * group filter so a text query never changes the selected group or its saved
 * preference. Multiple words may match across the name, type, and group list.
 */
export function filterBuiltInProxyNodes<T extends BuiltInProxyNodeSummary>(
  nodes: readonly T[],
  query: string | undefined,
): T[] {
  const terms = normalizeSearchText(query ?? '').split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return [...nodes]
  return nodes.filter((node) => {
    const searchable = normalizeSearchText([node.name, node.type, ...node.groupIds].join(' '))
    return terms.every((term) => searchable.includes(term))
  })
}

/** Returns a sorted copy and never mutates the profile-owned node array. */
export function sortBuiltInProxyNodes<T extends BuiltInProxyNodeSummary>(
  nodes: readonly T[],
  sortMode: BuiltInProxyNodeSortMode,
  activeNodeId?: string,
  locale?: string,
): T[] {
  const collator = createNodeCollator(locale)
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const compared = sortMode === 'current'
        ? compareCurrent(left.node, right.node, activeNodeId)
        : sortMode === 'latency'
          ? compareLatency(left.node, right.node, collator)
          : compareName(left.node, right.node, collator)
      return compared || left.index - right.index
    })
    .map(({ node }) => node)
}

/** Convenience pipeline for a node table that already received group-filtered nodes. */
export function selectBuiltInProxyNodes<T extends BuiltInProxyNodeSummary>(
  nodes: readonly T[],
  options: SelectBuiltInProxyNodesOptions,
): T[] {
  return sortBuiltInProxyNodes(
    filterBuiltInProxyNodes(nodes, options.query),
    options.sortMode,
    options.activeNodeId,
    options.locale,
  )
}

function compareCurrent(
  left: BuiltInProxyNodeSummary,
  right: BuiltInProxyNodeSummary,
  activeNodeId: string | undefined,
): number {
  const leftActive = left.id === activeNodeId
  const rightActive = right.id === activeNodeId
  return leftActive === rightActive ? 0 : leftActive ? -1 : 1
}

function compareLatency(
  left: BuiltInProxyNodeSummary,
  right: BuiltInProxyNodeSummary,
  collator: Intl.Collator,
): number {
  const leftKey = latencySortKey(left)
  const rightKey = latencySortKey(right)
  return leftKey.rank - rightKey.rank
    || leftKey.duration - rightKey.duration
    || compareName(left, right, collator)
}

function compareName(
  left: BuiltInProxyNodeSummary,
  right: BuiltInProxyNodeSummary,
  collator: Intl.Collator,
): number {
  return collator.compare(left.name, right.name)
    || collator.compare(left.type, right.type)
}

function latencySortKey(node: BuiltInProxyNodeSummary): { rank: number; duration: number } {
  if (node.latencyStatus === 'available' && isValidLatency(node.latencyMs)) {
    return { rank: 0, duration: node.latencyMs }
  }
  if (node.latencyStatus === 'testing') return { rank: 1, duration: 0 }
  if (node.latencyStatus === 'untested' || node.latencyStatus === 'available') {
    return { rank: 2, duration: 0 }
  }
  return { rank: 3, duration: 0 }
}

function isValidLatency(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

function createNodeCollator(locale: string | undefined): Intl.Collator {
  const options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }
  try {
    return new Intl.Collator(locale, options)
  } catch {
    return new Intl.Collator(undefined, options)
  }
}
