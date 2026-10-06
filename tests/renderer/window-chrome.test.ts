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

  it('keeps the workspace flush with the native controls without a seam or blur', () => {
    const workspaceRule = stylesheet.match(/html\.is-electron \.workspace\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? ''

    expect(workspaceRule).toContain('box-shadow: none')
    expect(stylesheet).not.toContain('html.is-electron .workspace::before')
    expect(stylesheet).not.toContain('--workspace-shadow')
    expect(stylesheet).not.toContain('--chrome-divider')
    expect(stylesheet).not.toMatch(/top:\s*-\d+px[\s\S]{0,180}filter:\s*blur/u)
  })
})
