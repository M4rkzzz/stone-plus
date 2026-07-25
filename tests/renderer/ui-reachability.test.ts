import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clientRouteSelectionDisabled } from '../../src/renderer/src/client-config-workbench'
import { stateBackupsForDisplay } from '../../src/renderer/src/views/SettingsView'
import { frpExampleConfig } from '../../src/renderer/src/views/TunnelView'
import { managedInstanceStatusLabel } from '../../src/renderer/src/managed-client-instances'

describe('renderer reachability regressions', () => {
  it('allows upstream selection before the first client route exists', () => {
    expect(clientRouteSelectionDisabled(false, 1)).toBe(false)
    expect(clientRouteSelectionDisabled(false, 0)).toBe(true)
    expect(clientRouteSelectionDisabled(true, 1)).toBe(true)
  })

  it('targets the configured gateway port in a fresh FRP configuration', () => {
    expect(frpExampleConfig(24680)).toContain('localPort = 24680')
    expect(frpExampleConfig(24680)).not.toContain('localPort = 15721')
  })

  it('keeps every retained state backup reachable after expansion', () => {
    const backups = Array.from({ length: 10 }, (_, index) => `backup-${index}`)
    expect(stateBackupsForDisplay(backups, false)).toEqual(backups.slice(0, 6))
    expect(stateBackupsForDisplay(backups, true)).toEqual(backups)
  })

  it('presents managed process states as localized user-facing status', () => {
    const en = <T>(_chinese: T, english: T): T => english
    expect(managedInstanceStatusLabel('starting', en)).toBe('Starting')
    expect(managedInstanceStatusLabel('failed', en)).toBe('Failed')
  })

  it('does not disguise a managed-client list failure as an empty list', () => {
    const source = readFileSync(new URL('../../src/renderer/src/managed-client-instances.tsx', import.meta.url), 'utf8')
    expect(source).toContain('.catch((cause) => setLoadError(managedInstanceError(cause, t)))')
    expect(source).toContain('(error || loadError)')
  })

  it('keeps browser navigation and reload controls visible at narrow widths', () => {
    const css = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const narrowBrowserRules = css.slice(css.indexOf('@media (max-width: 780px)'), css.indexOf('@media (max-width: 560px)'))
    expect(narrowBrowserRules).not.toMatch(/builtin-browser__toolbar > button:nth-of-type/)
    expect(narrowBrowserRules).toContain('repeat(4, 27px) minmax(100px, 1fr) 27px auto')
    expect(narrowBrowserRules).not.toContain('.builtin-browser__toolbar .browser-zoom')
  })

  it('keeps queued JSON controls inline with favorites and lets the webview fill resized space', () => {
    const view = readFileSync(new URL('../../src/renderer/src/views/BrowserView.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const shortcuts = view.indexOf('className="builtin-browser__shortcuts"')
    const queueControls = view.indexOf('className={`browser-import-inline')
    const tabs = view.indexOf('className="builtin-browser__tabs"')

    expect(shortcuts).toBeGreaterThan(-1)
    expect(queueControls).toBeGreaterThan(shortcuts)
    expect(queueControls).toBeLessThan(tabs)
    expect(view).not.toContain('browser-import-banner')
    expect(css).toContain('.page-stack.builtin-browser-page { width: 100%; height: 100%; min-height: 0;')
    expect(css).toContain('.builtin-browser__viewport { position: relative; display: flex; min-height: 0;')
    expect(css).toContain('.builtin-browser__tab-pane { display: none; width: 100%; height: auto; min-height: 0; flex: 1 1 auto; }')
    expect(css).toContain('.builtin-browser__webview { display: flex; width: 100%; height: auto; min-height: 0; flex: 1 1 auto; }')
  })

  it('covers every primary page before running visual modal cases', () => {
    const script = readFileSync(new URL('../../scripts/visual-check.mjs', import.meta.url), 'utf8')
    expect(script).toContain("'内网穿透'")
    expect(script).toContain("'内置浏览器'")
    expect(script).toContain("getByRole('tab', { name: /Grok/ })")
  })
})
