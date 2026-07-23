import { describe, expect, it } from 'vitest'
import type { BuiltInProxyProfileSummary } from '../../src/shared/types'
import {
  ALL_NODE_GROUPS,
  UNGROUPED_NODES,
  deriveNodesWorkspaceModel,
} from '../../src/renderer/src/views/built-in-proxy/nodes-workspace-model'

describe('nodes workspace controlled selection model', () => {
  it('uses the persisted active profile and node without creating a second selection', () => {
    const profiles = [profile('primary', 'node-a'), profile('backup', 'node-b')]
    const model = deriveNodesWorkspaceModel(profiles, 'backup', 'group-fast')

    expect(model.activeProfile?.id).toBe('backup')
    expect(model.activeNode?.id).toBe('node-b')
    expect(model.groupFilter).toBe('group-fast')
    expect(model.visibleNodes.map((node) => node.id)).toEqual(['node-b'])
  })

  it('falls back visibly when a remembered profile or group disappears', () => {
    const profiles = [profile('primary', 'node-a')]
    const model = deriveNodesWorkspaceModel(profiles, 'removed-profile', 'removed-group')

    expect(model.activeProfile?.id).toBe('primary')
    expect(model.activeNode?.id).toBe('node-a')
    expect(model.groupFilter).toBe(ALL_NODE_GROUPS)
    expect(model.visibleNodes).toHaveLength(2)
  })

  it('keeps the ungrouped view only while ungrouped nodes exist', () => {
    const withUngrouped = deriveNodesWorkspaceModel([profile('primary', 'node-a')], 'primary', UNGROUPED_NODES)
    expect(withUngrouped.groupFilter).toBe(UNGROUPED_NODES)
    expect(withUngrouped.visibleNodes.map((node) => node.id)).toEqual(['node-loose'])

    const withoutUngroupedProfile = profile('primary', 'node-a')
    withoutUngroupedProfile.nodes = withoutUngroupedProfile.nodes.filter((node) => node.groupIds.length > 0)
    const withoutUngrouped = deriveNodesWorkspaceModel([withoutUngroupedProfile], 'primary', UNGROUPED_NODES)
    expect(withoutUngrouped.groupFilter).toBe(ALL_NODE_GROUPS)
  })

  it('returns a safe empty model before the first profile is imported', () => {
    expect(deriveNodesWorkspaceModel([], undefined, 'group-fast')).toEqual({
      groups: [],
      hasUngroupedNodes: false,
      groupFilter: ALL_NODE_GROUPS,
      visibleNodes: [],
    })
  })
})

function profile(id: string, activeNodeId: string): BuiltInProxyProfileSummary {
  return {
    id,
    name: `${id} profile`,
    source: 'subscription',
    format: 'uri-list',
    nodes: [{
      id: id === 'backup' ? 'node-b' : 'node-a',
      name: 'Fast node',
      type: 'vless',
      groupIds: ['group-fast'],
      latencyStatus: 'untested',
    }, {
      id: 'node-loose',
      name: 'Loose node',
      type: 'shadowsocks',
      groupIds: [],
      latencyStatus: 'untested',
    }],
    nodeCount: 2,
    groupCount: 1,
    ruleStatus: 'preserved',
    activeNodeId,
    createdAt: 1,
    updatedAt: 2,
  }
}
