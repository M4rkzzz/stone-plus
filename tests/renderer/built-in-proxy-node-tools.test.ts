import { describe, expect, it } from 'vitest'
import type { BuiltInProxyNodeSummary } from '../../src/shared/types'
import {
  classifyBuiltInProxyNodeLatency,
  filterBuiltInProxyNodes,
  selectBuiltInProxyNodes,
  sortBuiltInProxyNodes,
} from '../../src/renderer/src/built-in-proxy-node-tools'

describe('built-in proxy node tools', () => {
  it('classifies every latency state with inclusive fast and medium boundaries', () => {
    expect(classifyBuiltInProxyNodeLatency(node('unknown', 'Unknown'))).toBe('unknown')
    expect(classifyBuiltInProxyNodeLatency(node('testing', 'Testing', { latencyStatus: 'testing' }))).toBe('testing')
    expect(classifyBuiltInProxyNodeLatency(node('fast-edge', 'Fast edge', { latencyStatus: 'available', latencyMs: 200 }))).toBe('fast')
    expect(classifyBuiltInProxyNodeLatency(node('medium-start', 'Medium start', { latencyStatus: 'available', latencyMs: 201 }))).toBe('medium')
    expect(classifyBuiltInProxyNodeLatency(node('medium-edge', 'Medium edge', { latencyStatus: 'available', latencyMs: 500 }))).toBe('medium')
    expect(classifyBuiltInProxyNodeLatency(node('slow', 'Slow', { latencyStatus: 'available', latencyMs: 501 }))).toBe('slow')
    expect(classifyBuiltInProxyNodeLatency(node('timeout', 'Timeout', { latencyStatus: 'timeout' }))).toBe('failure')
    expect(classifyBuiltInProxyNodeLatency(node('error', 'Error', { latencyStatus: 'error' }))).toBe('failure')
  })

  it('does not mislabel malformed available durations', () => {
    expect(classifyBuiltInProxyNodeLatency(node('missing', 'Missing', { latencyStatus: 'available' }))).toBe('unknown')
    expect(classifyBuiltInProxyNodeLatency(node('negative', 'Negative', { latencyStatus: 'available', latencyMs: -1 }))).toBe('unknown')
    expect(classifyBuiltInProxyNodeLatency(node('nan', 'NaN', { latencyStatus: 'available', latencyMs: Number.NaN }))).toBe('unknown')
    expect(classifyBuiltInProxyNodeLatency(node('infinite', 'Infinite', { latencyStatus: 'available', latencyMs: Number.POSITIVE_INFINITY }))).toBe('unknown')
  })

  it('searches node names, types, and groups with normalized multi-word matching', () => {
    const nodes = [
      node('stable-us', 'US Node ２', { type: 'HYSTERIA2', groupIds: ['Premium'] }),
      node('stable-de', 'Germany', { type: 'vless', groupIds: ['Work'] }),
      node('stable-fallback', 'Fallback', { type: 'socks', groupIds: [] }),
    ]

    expect(filterBuiltInProxyNodes(nodes, '  us PREMIUM ')).toEqual([nodes[0]])
    expect(filterBuiltInProxyNodes(nodes, 'node 2 hysteria2')).toEqual([nodes[0]])
    expect(filterBuiltInProxyNodes(nodes, 'WORK')).toEqual([nodes[1]])
    expect(filterBuiltInProxyNodes(nodes, 'stable-us')).toEqual([])
    expect(filterBuiltInProxyNodes(nodes, 'not present')).toEqual([])
  })

  it('returns a copy for an empty search without replacing node objects or stable ids', () => {
    const nodes = [node('stable-a', 'A'), node('stable-b', 'B')]
    const filtered = filterBuiltInProxyNodes(nodes, '   ')

    expect(filtered).not.toBe(nodes)
    expect(filtered.map((candidate) => candidate.id)).toEqual(['stable-a', 'stable-b'])
    expect(filtered[0]).toBe(nodes[0])
    expect(filtered[1]).toBe(nodes[1])
  })

  it('puts the current node first while preserving the existing group-filtered order', () => {
    const nodes = [node('stable-b', 'B'), node('stable-a', 'A'), node('stable-c', 'C')]
    const originalIds = nodes.map((candidate) => candidate.id)

    const sorted = sortBuiltInProxyNodes(nodes, 'current', 'stable-a', 'en')

    expect(sorted.map((candidate) => candidate.id)).toEqual(['stable-a', 'stable-b', 'stable-c'])
    expect(nodes.map((candidate) => candidate.id)).toEqual(originalIds)
    expect(sorted[0]).toBe(nodes[1])
  })

  it('sorts valid latency first, then testing, unknown, and failure states', () => {
    const nodes = [
      node('slow', 'Slow', { latencyStatus: 'available', latencyMs: 800 }),
      node('failure', 'Failure', { latencyStatus: 'timeout' }),
      node('fast', 'Fast', { latencyStatus: 'available', latencyMs: 40 }),
      node('testing', 'Testing', { latencyStatus: 'testing' }),
      node('unknown', 'Unknown'),
      node('medium', 'Medium', { latencyStatus: 'available', latencyMs: 300 }),
      node('invalid', 'Invalid', { latencyStatus: 'available', latencyMs: Number.NaN }),
    ]

    expect(sortBuiltInProxyNodes(nodes, 'latency', undefined, 'en').map((candidate) => candidate.id)).toEqual([
      'fast',
      'medium',
      'slow',
      'testing',
      'invalid',
      'unknown',
      'failure',
    ])
  })

  it('uses natural name ordering and stable source order for exact ties', () => {
    const tiedFirst = node('tie-first', 'Same', { type: 'socks' })
    const tiedSecond = node('tie-second', 'same', { type: 'SOCKS' })
    const nodes = [
      node('node-10', 'Node 10'),
      tiedFirst,
      node('node-2', 'node 2'),
      node('alpha', 'Alpha'),
      tiedSecond,
    ]

    expect(sortBuiltInProxyNodes(nodes, 'name', undefined, 'en').map((candidate) => candidate.id)).toEqual([
      'alpha',
      'node-2',
      'node-10',
      'tie-first',
      'tie-second',
    ])
  })

  it('filters and sorts only the nodes supplied by the existing group selector', () => {
    const groupFilteredNodes = [
      node('group-a-2', 'Group A 2', { groupIds: ['group-a'] }),
      node('group-a-1', 'Group A 1', { groupIds: ['group-a'] }),
    ]
    const selected = selectBuiltInProxyNodes(groupFilteredNodes, {
      query: 'group a',
      sortMode: 'name',
      activeNodeId: 'group-a-2',
      locale: 'not_a_valid_locale!',
    })

    expect(selected.map((candidate) => candidate.id)).toEqual(['group-a-1', 'group-a-2'])
    expect(selected.every((candidate) => candidate.groupIds.includes('group-a'))).toBe(true)
  })
})

function node(
  id: string,
  name: string,
  overrides: Partial<BuiltInProxyNodeSummary> = {},
): BuiltInProxyNodeSummary {
  return {
    id,
    name,
    type: 'socks',
    groupIds: [],
    latencyStatus: 'untested',
    ...overrides,
  }
}
