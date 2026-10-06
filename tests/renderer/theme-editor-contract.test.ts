import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('theme editor contract', () => {
  const editor = source('src/renderer/src/theme-editor.tsx')
  const settings = source('src/renderer/src/views/SettingsView.tsx')
  const theme = source('src/renderer/src/theme.tsx')

  it('keeps built-in themes and exposes local custom theme management', () => {
    expect(editor).toContain("id: 'light'")
    expect(editor).toContain("id: 'dark'")
    expect(editor).toContain('createCustomTheme')
    expect(editor).toContain('deleteCustomTheme')
    expect(editor).toContain('CUSTOM_THEME_COLOR_KEYS.map')
    expect(editor).toContain('QUICK_ACCENTS.map')
    expect(editor).toContain('theme-quick-editor')
    expect(editor).toContain('aria-pressed={selected}')
    expect(editor).toContain('aria-label={`${label} HEX`}')
    expect(settings).toContain('<ThemeEditor />')
  })

  it('stores only validated custom profiles and applies semantic CSS variables', () => {
    expect(theme).toContain("export const UI_CUSTOM_THEMES_STORAGE_KEY = 'stone.ui.custom-themes'")
    expect(theme).toContain('HEX_COLOR_PATTERN')
    expect(theme).toContain("surfaceActive: ['--surface-active']")
    expect(theme).toContain("style.setProperty('--focus-ring'")
    expect(theme).toContain('persistCustomThemes(next)')
    expect(theme).toContain('readableCustomThemeColors(profile)')
    expect(theme).toContain("const systemTheme = resolveUiTheme('system', systemPrefersDark)")
  })
})
