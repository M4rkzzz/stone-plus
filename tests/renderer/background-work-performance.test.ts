import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function rendererSource(path: string): string {
  return readFileSync(new URL(`../../src/renderer/src/${path}`, import.meta.url), 'utf8')
}

describe('renderer background work', () => {
  it('uses the visibility-aware non-overlapping scheduler for recurring UI refreshes', () => {
    for (const path of [
      'agent-lifecycle-control.tsx',
      'views/BuiltInProxyView.tsx',
      'views/ProvidersView.tsx',
      'views/RequestsView.tsx',
      'views/SetupWizardView.tsx',
    ]) {
      expect(rendererSource(path), path).toContain('useVisibilityAwareInterval')
    }
  })

  it('shares one account cooldown clock instead of creating a timer per row', () => {
    const source = rendererSource('views/ProvidersView.tsx')

    expect(source).toContain('<CooldownCountdown account={account} now={cooldownNow} />')
    expect(source).not.toMatch(/function CooldownCountdown[\s\S]*?window\.setInterval/)
  })
})
