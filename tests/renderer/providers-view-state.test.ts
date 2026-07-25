import { describe, expect, it } from 'vitest'
import { accountDisplayNames, accountSelectionSummary, nextTabIndex, selectMatchingAccountIds } from '../../src/renderer/src/providers-view-state'

describe('providers view state helpers', () => {
  it('selects only accounts in the already filtered visible set', () => {
    const visible = [{ id: 'visible-ready' }, { id: 'visible-cooling' }]

    expect(selectMatchingAccountIds(visible, (account) => account.id.endsWith('ready'))).toEqual(['visible-ready'])
    expect(selectMatchingAccountIds(visible, () => true)).toEqual(['visible-ready', 'visible-cooling'])
  })

  it('keeps full account names and disambiguates only exact duplicates', () => {
    const names = accountDisplayNames([
      { id: 'one', name: 'developer-team-alpha@example.com' },
      { id: 'two', name: 'developer-team-beta@example.com' },
      { id: 'three', name: 'developer-team-alpha@example.com' },
    ])

    expect(names.get('one')).toBe('developer-team-alpha@example.com(1)')
    expect(names.get('two')).toBe('developer-team-beta@example.com')
    expect(names.get('three')).toBe('developer-team-alpha@example.com(2)')
  })

  it('describes named and hidden accounts before a bulk action', () => {
    const summary = accountSelectionSummary([
      { id: 'visible', name: 'visible@example.com' },
      { id: 'hidden', name: 'hidden@example.com' },
      { id: 'extra', name: 'extra@example.com' },
    ], new Set(['visible', 'extra']), 2)

    expect(summary).toEqual({
      names: ['visible@example.com', 'hidden@example.com'],
      remainingCount: 1,
      hiddenCount: 1,
    })
  })

  it('supports wrapped arrow navigation and Home/End in tab lists', () => {
    expect(nextTabIndex(0, 3, 'ArrowLeft')).toBe(2)
    expect(nextTabIndex(2, 3, 'ArrowRight')).toBe(0)
    expect(nextTabIndex(1, 3, 'Home')).toBe(0)
    expect(nextTabIndex(1, 3, 'End')).toBe(2)
    expect(nextTabIndex(1, 3, 'Enter')).toBeUndefined()
  })
})
