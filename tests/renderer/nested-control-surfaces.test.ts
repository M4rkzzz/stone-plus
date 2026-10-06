import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function stylesheet(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const bodies: string[] = []
  for (const match of css.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/gu)) {
    const selectors = match.groups?.selectors.split(',').map((candidate) => candidate.trim()) ?? []
    if (selectors.includes(selector)) bodies.push(match.groups?.body ?? '')
  }
  return bodies.join('\n')
}

describe('nested control surface hierarchy', () => {
  const globalCss = stylesheet('src/renderer/src/styles.css')
  const clientsCss = stylesheet('src/renderer/src/clients-view.css')

  it('renders nested account metadata as text instead of cards within cards', () => {
    expect(ruleBody(globalCss, '.nav-count')).toContain('background: transparent')
    expect(ruleBody(globalCss, '.source-type-tabs button span')).toContain('background: transparent')
    expect(ruleBody(globalCss, '.account-tag-chip')).toContain('background: transparent')
    expect(ruleBody(globalCss, '.account-tag-chip')).toContain('border: 0')
    expect(ruleBody(globalCss, '.fitness-score')).toContain('background: transparent')
    expect(ruleBody(globalCss, '.account-quota-filter small')).toContain('background: transparent')
    expect(ruleBody(globalCss, '.provider-card__endpoint')).toContain('background: transparent')
  })

  it('flattens informational client surfaces while retaining actual inputs', () => {
    expect(ruleBody(clientsCss, '.client-easy-source')).toContain('background: transparent')
    expect(ruleBody(clientsCss, '.client-easy-status__item')).toContain('background: transparent')
    expect(ruleBody(clientsCss, '.client-install__status')).toContain('background: transparent')
    expect(ruleBody(clientsCss, '.client-setting-options > span')).toContain('background: transparent')
    expect(ruleBody(clientsCss, '.client-setting-readonly')).toContain('background: transparent')

    expect(ruleBody(clientsCss, '.client-easy-source select')).toContain('background: var(--surface)')
    expect(ruleBody(clientsCss, '.client-setting-row__input > input')).toContain('background: var(--surface)')
  })

  it('keeps actionable selection and warning surfaces visible', () => {
    expect(ruleBody(globalCss, '.segmented-control button.active')).toContain('background: var(--surface)')
    expect(ruleBody(globalCss, '.account-tag-filter button.active')).toContain('background: var(--surface-muted)')
    expect(ruleBody(clientsCss, '.client-easy-status__item.is-warn')).toContain('background: var(--warn-soft)')
    expect(ruleBody(clientsCss, '.client-install__status.is-error')).toContain('background: var(--danger-tint)')
  })
})
