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

function ruleBodies(css: string, selector: string): string {
  const bodies: string[] = []
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  for (const match of withoutComments.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/gu)) {
    const selectors = match.groups?.selectors.split(',').map((candidate) => candidate.trim()) ?? []
    if (selectors.includes(selector)) bodies.push(match.groups?.body ?? '')
  }
  return bodies.join('\n')
}

describe('dark theme CSS contract', () => {
  const globalCss = stylesheet('src/renderer/src/styles.css')
  const clientsCss = stylesheet('src/renderer/src/clients-view.css')
  const legacyProxyCss = stylesheet('src/renderer/src/built-in-proxy.css')
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
    expect(darkPalette).toContain('--on-accent: #151617')
    expect(darkPalette).toContain('--bg: #111214')
    expect(darkPalette).toContain('--surface: #18191b')
    expect(darkPalette).toContain('--nav-text: #b4b7b6')
    expect(darkPalette).not.toContain('#5fbf9c')
    expect(focusRule).toContain('box-shadow: 0 0 0 3px var(--focus-ring)')
  })

  it('separates visible neutral controls and data lines from flat structural borders', () => {
    const darkPalette = ruleBody(globalCss, "html[data-theme='dark']")

    expect(darkPalette).toContain('--border: #0f1012')
    expect(darkPalette).toContain('--control-border: #6c7076')
    expect(darkPalette).toContain('--chart-grid: #4b4f54')
    expect(darkPalette).toContain('--chart-muted: #767b80')
    expect(darkPalette).toContain('--progress-track: #3a3d41')
    expect(darkPalette).toContain('--topology-line: #686d72')

    expect(ruleBodies(globalCss, '.field input')).toContain('border: 1px solid var(--control-border)')
    expect(ruleBodies(globalCss, '.search-input')).toContain('border: 1px solid var(--control-border)')
    expect(ruleBody(clientsCss, '.client-settings-search')).toContain('border: 1px solid var(--control-border)')
    expect(ruleBodies(clientsCss, '.client-setting-row__input > select')).toContain('border: 1px solid var(--control-border)')
    expect(ruleBody(globalCss, '.token-rate-chart__grid')).toContain('stroke: var(--chart-grid)')
    expect(ruleBody(globalCss, '.quota-summary__track')).toContain('background: var(--progress-track)')
    expect(ruleBody(globalCss, '.traffic-chart__column:nth-child(3n) span')).toContain('background: var(--chart-muted)')
    expect(ruleBody(legacyProxyCss, '.built-in-proxy-route__path > i')).toContain('background: var(--topology-line)')
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
    expect(ruleBody(globalCss, '.source-type-tabs button span')).toContain('background: transparent')
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
