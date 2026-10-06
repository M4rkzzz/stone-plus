import { describe, expect, it } from 'vitest'
import {
  normalizeAggregateRelayMembers,
  toggleAggregateRelayMember,
} from '../../src/renderer/src/aggregate-relay-members'

describe('aggregate relay member picker', () => {
  it('adds a clicked API source with its configured weight', () => {
    const members = toggleAggregateRelayMember([], { id: 'source-account-1', weight: 7 })

    expect(members).toEqual([
      { accountId: 'source-account-1', order: 0, weight: 7 },
    ])
  })

  it('removes an already selected source and compacts member order', () => {
    const members = toggleAggregateRelayMember([
      { accountId: 'source-account-1', order: 3, weight: 4 },
      { accountId: 'source-account-2', order: 9, weight: 8 },
      { accountId: 'source-account-3', order: 15, weight: 12 },
    ], { id: 'source-account-2', weight: 99 })

    expect(members).toEqual([
      { accountId: 'source-account-1', order: 0, weight: 4 },
      { accountId: 'source-account-3', order: 1, weight: 12 },
    ])
  })

  it('normalizes reordered members without mutating their weights', () => {
    expect(normalizeAggregateRelayMembers([
      { accountId: 'source-account-2', order: 8, weight: 20 },
      { accountId: 'source-account-1', order: 2, weight: 5 },
    ])).toEqual([
      { accountId: 'source-account-2', order: 0, weight: 20 },
      { accountId: 'source-account-1', order: 1, weight: 5 },
    ])
  })
})
