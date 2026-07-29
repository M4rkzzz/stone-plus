import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('low-resource mode integration', () => {
  it('is opt-in, persisted, visible in settings, and never changes gateway settings', () => {
    const provider = readFileSync(new URL('../../src/renderer/src/low-resource-mode.tsx', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../../src/renderer/src/main.tsx', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../../src/renderer/src/views/SettingsView.tsx', import.meta.url), 'utf8')

    expect(provider).toContain("stone.low-resource-mode.v1")
    expect(provider).toContain("document.documentElement.classList.toggle('low-resource-mode'")
    expect(main).toContain('<LowResourceModeProvider>')
    expect(settings).toContain("title={t('低资源模式', 'Low-resource mode')}")
    expect(settings).not.toContain("updateDraft({ lowResource")
  })

  it('slows only selected renderer telemetry while visibility scheduling prevents overlap', () => {
    const scheduler = readFileSync(new URL('../../src/renderer/src/visibility-interval.ts', import.meta.url), 'utf8')
    const proxy = readFileSync(new URL('../../src/renderer/src/views/BuiltInProxyView.tsx', import.meta.url), 'utf8')
    const providers = readFileSync(new URL('../../src/renderer/src/views/ProvidersView.tsx', import.meta.url), 'utf8')
    const requests = readFileSync(new URL('../../src/renderer/src/views/RequestsView.tsx', import.meta.url), 'utf8')
    const agents = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')

    expect(scheduler).toContain('intervalMs * Math.max(1, lowResourceMultiplier)')
    expect(scheduler).toContain('disposed || running || !environment.isVisible()')
    expect(proxy).toMatch(/useVisibilityAwareInterval[\s\S]*?,\s*3,\s*\)/)
    expect(providers).toMatch(/useVisibilityAwareInterval[\s\S]*?,\s*2,\s*\)/)
    expect(requests).toMatch(/useVisibilityAwareInterval[\s\S]*?,\s*2,\s*\)/)
    expect(agents).toMatch(/useVisibilityAwareInterval[\s\S]*?,\s*2,\s*\)/)
  })
})
