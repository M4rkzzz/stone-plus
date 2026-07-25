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

  it('does not paint a blurred workspace layer upward into native window controls', () => {
    expect(stylesheet).not.toMatch(/html\.is-electron \.workspace::before/u)
    expect(stylesheet).not.toMatch(/top:\s*-\d+px[\s\S]{0,180}filter:\s*blur/u)
  })
})
