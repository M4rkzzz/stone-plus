import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')

describe('Electron window chrome CSS contract', () => {
  it('keeps the renderer drag region opaque and aligned with the native title-bar overlay', () => {
    const titlebarRule = stylesheet.match(/\.window-titlebar\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? ''

    expect(titlebarRule).toContain('background: var(--app-chrome)')
    expect(titlebarRule).toContain('-webkit-app-region: drag')
    expect(titlebarRule).toContain('width: env(titlebar-area-width, 100%)')
    expect(titlebarRule).toContain('height: env(titlebar-area-height, 38px)')
  })

  it('keeps the workspace seam below the native controls without an upward blur', () => {
    const seamRule = stylesheet.match(/html\.is-electron \.workspace::before\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? ''

    expect(seamRule).toContain('top: 0')
    expect(seamRule).toContain('height: 1px')
    expect(seamRule).toContain('background: var(--chrome-divider)')
    expect(seamRule).not.toContain('filter: blur')
    expect(stylesheet).not.toMatch(/top:\s*-\d+px[\s\S]{0,180}filter:\s*blur/u)
  })
})
