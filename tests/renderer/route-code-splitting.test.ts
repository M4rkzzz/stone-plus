import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('renderer route loading', () => {
  it('keeps the first overview eager and loads heavyweight workspaces on demand', () => {
    const source = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')

    expect(source).toContain("import { OverviewView } from './views/OverviewView'")
    expect(source).toContain("const loadProvidersView = () => import('./views/ProvidersView')")
    expect(source).toContain("const loadHelpView = () => import('./views/HelpView')")
    expect(source).toContain('<Suspense fallback={<PageLoadingScreen />}>')
    expect(source).toContain('onPointerEnter={() => preloadAppPage(item.id)}')
    expect(source).not.toContain("import { ProvidersView } from './views/ProvidersView'")
    expect(source).not.toContain("import { BrowserView } from './views/BrowserView'")
  })
})
