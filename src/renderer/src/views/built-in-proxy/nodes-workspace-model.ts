import type { BuiltInProxyNodeSummary, BuiltInProxyProfileSummary } from '@shared/types'

export const ALL_NODE_GROUPS = 'all'
export const UNGROUPED_NODES = '__ungrouped__'

export interface NodesWorkspaceModel {
  activeProfile?: BuiltInProxyProfileSummary
  activeNode?: BuiltInProxyNodeSummary
  groups: string[]
  hasUngroupedNodes: boolean
  groupFilter: string
  visibleNodes: BuiltInProxyNodeSummary[]
}

/**
 * Derives presentation state without introducing another selection source.
 * The active profile/node remain backed by the main-process store, while the
 * controlled group filter remains backed by the caller's existing preference.
 */
export function deriveNodesWorkspaceModel(
  profiles: readonly BuiltInProxyProfileSummary[],
  activeProfileId: string | undefined,
  requestedGroupFilter: string,
): NodesWorkspaceModel {
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
  if (!activeProfile) {
    return {
      groups: [],
      hasUngroupedNodes: false,
      groupFilter: ALL_NODE_GROUPS,
      visibleNodes: [],
    }
  }

  const groups = Array.from(new Set(activeProfile.nodes.flatMap((node) => node.groupIds)))
    .sort((left, right) => left.localeCompare(right))
  const hasUngroupedNodes = activeProfile.nodes.some((node) => node.groupIds.length === 0)
  const groupFilter = requestedGroupFilter === UNGROUPED_NODES
    ? hasUngroupedNodes ? UNGROUPED_NODES : ALL_NODE_GROUPS
    : requestedGroupFilter !== ALL_NODE_GROUPS && groups.includes(requestedGroupFilter)
      ? requestedGroupFilter
      : ALL_NODE_GROUPS
  const visibleNodes = groupFilter === ALL_NODE_GROUPS
    ? activeProfile.nodes
    : groupFilter === UNGROUPED_NODES
      ? activeProfile.nodes.filter((node) => node.groupIds.length === 0)
      : activeProfile.nodes.filter((node) => node.groupIds.includes(groupFilter))
  const activeNode = activeProfile.nodes.find((node) => node.id === activeProfile.activeNodeId)

  return {
    activeProfile,
    ...(activeNode ? { activeNode } : {}),
    groups,
    hasUngroupedNodes,
    groupFilter,
    visibleNodes,
  }
}
