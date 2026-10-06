import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/i18n', () => ({
  useI18n: () => ({ t: <T>(chinese: T) => chinese }),
}))

import { AccountStatusBadge } from '../../src/renderer/src/ui'

const stylesheet = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')

describe('account status badge appearance', () => {
  it.each([
    ['active', undefined, 'badge--success'],
    ['cooldown', undefined, 'badge--warning'],
    ['checking', undefined, 'badge--warning'],
    ['disabled', undefined, 'badge--danger'],
    ['expired', undefined, 'badge--danger'],
    ['active', 'half-open', 'badge--warning'],
    ['active', 'open', 'badge--danger'],
  ] as const)('keeps %s/%s semantic text without a button fill', (status, circuitState, tone) => {
    const markup = renderToStaticMarkup(createElement(AccountStatusBadge, { status, circuitState }))

    expect(markup).toContain('account-status-badge')
    expect(markup).toContain(tone)
  })

  it('removes only the account-status button treatment', () => {
    const rule = stylesheet.match(/\.badge\.account-status-badge\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? ''

    expect(rule).toContain('background: transparent')
    expect(rule).toContain('padding: 0')
    expect(rule).toContain('min-height: auto')
    expect(rule).toContain('border-radius: 0')
  })
})
