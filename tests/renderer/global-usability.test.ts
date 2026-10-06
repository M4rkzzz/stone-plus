import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('global usability affordances', () => {
  it('keeps fast feature discovery, current-page semantics, and long-page recovery reachable', () => {
    const source = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')

    expect(source).toContain('aria-keyshortcuts="Control+K Meta+K"')
    expect(source).toContain("aria-current={page === item.id ? 'page' : undefined}")
    expect(source).toContain('<QuickNavigation')
    expect(source).toContain('pageContentRef.current?.scrollTo({ top: 0, left: 0 })')
    expect(source).toContain('className="page-back-to-top"')
    expect(source).toContain('SIDEBAR_COLLAPSED_STORAGE_KEY')
  })
})

