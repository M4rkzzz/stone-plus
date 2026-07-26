import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function stylesheet(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u'))?.groups?.body ?? ''
}

describe('dark theme CSS contract', () => {
  const globalCss = stylesheet('src/renderer/src/styles.css')
  const helpCss = stylesheet('src/renderer/src/help-view.css')
  const telemetryCss = stylesheet('src/renderer/src/telemetry-workspace.css')
  const settingsCss = stylesheet('src/renderer/src/views/built-in-proxy/SettingsPanel.css')
  const nodesCss = stylesheet('src/renderer/src/views/built-in-proxy/nodes-workspace.css')
  const policyCss = stylesheet('src/renderer/src/views/built-in-proxy/network-policy-panel.css')

  it('defines theme-aware focus and control highlight tokens for both palettes', () => {
    const lightPalette = ruleBody(globalCss, ':root')
    const darkPalette = ruleBody(globalCss, "html[data-theme='dark']")
    const focusRule = ruleBody(globalCss, 'summary:focus-visible')

    expect(lightPalette).toContain('--focus-ring:')
    expect(lightPalette).toContain('--control-highlight:')
    expect(lightPalette).toContain('--scroll-thumb:')
    expect(darkPalette).toContain('--focus-ring:')
    expect(darkPalette).toContain('--control-highlight:')
    expect(darkPalette).toContain('--scroll-thumb-hover:')
    expect(lightPalette).toContain('--on-accent: #ffffff')
    expect(darkPalette).toContain('--on-accent: #121614')
    expect(focusRule).toContain('box-shadow: 0 0 0 3px var(--focus-ring)')
  })

  it('keeps built-in proxy workspaces on semantic surfaces', () => {
    expect(nodesCss).not.toMatch(/background:\s*(?:#fff(?:fff)?|#f[0-9a-f]{5}|rgb\(255 255 255)/iu)
    expect(settingsCss).not.toMatch(/background:\s*#f[0-9a-f]{5}/iu)
    expect(policyCss).not.toMatch(/background:\s*#fff(?:fff)?/iu)

    expect(ruleBody(nodesCss, '.nodes-workspace__profile-card.is-active')).toContain('background: var(--surface-active)')
    expect(ruleBody(nodesCss, '.nodes-workspace__selection')).toContain('var(--surface-active)')
    expect(ruleBody(settingsCss, '.built-in-proxy-settings-workspace__mode.is-selected')).toContain('background: var(--surface-active)')
    expect(ruleBody(policyCss, '.built-in-policy__grid article > span')).toContain('background: var(--surface)')
  })

  it('does not reintroduce translucent white cards in help, telemetry, or shared UI', () => {
    expect(ruleBody(helpCss, '.help-checklist > button')).toContain('background: var(--surface-raised)')
    expect(ruleBody(helpCss, '.help-assistant__actions')).toContain('background: var(--surface-raised)')
    expect(ruleBody(helpCss, '.help-scan-demo > div:not(.help-scan-demo__beam)')).toContain('background: var(--surface-raised)')
    expect(ruleBody(telemetryCss, '.telemetry-workspace__table-mask')).toContain('var(--surface-subtle)')
    expect(ruleBody(globalCss, '.source-type-tabs button span')).toContain('background: var(--surface-raised)')
    expect(ruleBody(globalCss, '.oauth-result-stats')).toContain('background: var(--surface-raised)')
    expect(ruleBody(globalCss, '.token-rate-chart__empty')).toContain('background: var(--surface-raised)')
    expect(ruleBody(globalCss, '.browser-tab:hover')).toContain('background: var(--surface-raised)')
  })

  it('keeps fixed-dark code surfaces independent from the light and dark palettes', () => {
    expect(ruleBody(globalCss, '.tunnel-config')).toContain('background: var(--code-surface)')
    expect(ruleBody(globalCss, '.tunnel-config')).toContain('color: var(--code-text)')
    expect(ruleBody(globalCss, '.tunnel-logs')).toContain('color: var(--code-muted)')
    expect(ruleBody(globalCss, '.client-config pre')).toContain('background: var(--code-surface-raised)')
    expect(ruleBody(globalCss, '.update-notes__body pre')).toContain('color: var(--code-text)')
  })

  it('uses contrast foregrounds and semantic state fills', () => {
    expect(ruleBody(globalCss, '.button--primary')).toContain('color: var(--on-accent)')
    expect(ruleBody(globalCss, '.button--danger')).toContain('color: var(--on-danger)')
    expect(ruleBody(nodesCss, '.nodes-workspace__use')).toContain('color: var(--on-accent)')
    expect(ruleBody(nodesCss, '.nodes-workspace__table tr.is-active td')).toContain('background: var(--surface-active)')
  })
})
