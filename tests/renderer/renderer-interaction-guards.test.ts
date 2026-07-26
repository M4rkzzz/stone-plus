import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (relative: string): string => readFileSync(new URL(`../../src/renderer/src/${relative}`, import.meta.url), 'utf8')

describe('renderer asynchronous and keyboard interaction guards', () => {
  it('binds request replay and route preview completions to their current editor identity', () => {
    expect(source('views/RequestsView.tsx')).toContain('new BoundAsyncOperation()')
    expect(source('views/RequestsView.tsx')).toContain('replayOperation.current.run')
    expect(source('views/RoutesView.tsx')).toContain('previewOperation.current.run')
    expect(source('views/RoutesView.tsx')).toContain('previewError')
  })

  it('removes a closed mobile drawer from interaction and restores modal drawer focus', () => {
    const app = source('App.tsx')
    expect(app).toContain('inert={mobileSidebarHidden || undefined}')
    expect(app).toContain('aria-hidden={mobileSidebarHidden || undefined}')
    expect(app).toContain('trapMobileSidebarTabKey')
    expect(app).toContain("event.key === 'Escape'")
  })

  it('implements menuitem semantics and full keyboard navigation for overflow actions', () => {
    const ui = source('ui.tsx')
    expect(ui).toContain("role: 'menuitem'")
    expect(ui).toContain("event.key === 'ArrowDown'")
    expect(ui).toContain("event.key === 'Home'")
    expect(ui).toContain("event.key === 'Tab'")
  })

  it('gives the image lightbox an isolated focus boundary and restores its opener', () => {
    const help = source('views/HelpView.tsx')
    expect(help).toContain('HelpLightbox')
    expect(help).toContain('isolateLightboxBackground')
    expect(help).toContain('restoreLightboxFocus')
  })
})
