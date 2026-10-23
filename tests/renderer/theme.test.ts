import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UI_CUSTOM_THEMES_STORAGE_KEY,
  UI_THEME_STORAGE_KEY,
  applyStoredThemeEarly,
  colorContrastRatio,
  customThemeContrastWarnings,
  customThemePreset,
  normalizeThemePreference,
  normalizeThemeSelection,
  parseCustomThemes,
  readableCustomThemeColors,
  removeCustomTheme,
  resolveUiTheme,
} from '../../src/renderer/src/theme'

function installThemeEnvironment({
  storedPreference,
  storedCustomThemes = null,
  systemPrefersDark = false,
  storageError,
}: {
  storedPreference: string | null
  storedCustomThemes?: string | null
  systemPrefersDark?: boolean
  storageError?: Error
}) {
  const dataset: Record<string, string> = {}
  const customProperties = new Map<string, string>()
  const getItem = vi.fn((key: string) => {
    if (storageError) throw storageError
    if (key === UI_THEME_STORAGE_KEY) return storedPreference
    if (key === UI_CUSTOM_THEMES_STORAGE_KEY) return storedCustomThemes
    return null
  })
  const matchMedia = vi.fn((query: string) => {
    expect(query).toBe('(prefers-color-scheme: dark)')
    return { matches: systemPrefersDark }
  })

  vi.stubGlobal('window', {
    localStorage: { getItem },
    matchMedia,
  })
  vi.stubGlobal('document', {
    documentElement: {
      dataset,
      style: {
        setProperty: vi.fn((key: string, value: string) => customProperties.set(key, value)),
        removeProperty: vi.fn((key: string) => customProperties.delete(key)),
      },
    },
  })

  return { customProperties, dataset, getItem, matchMedia }
}

describe('theme helpers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    [undefined, 'system'],
    [null, 'system'],
    ['', 'system'],
    ['invalid', 'system'],
    [true, 'system'],
  ] as const)('normalizes %j to %s', (input, expected) => {
    expect(normalizeThemePreference(input)).toBe(expected)
  })

  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('resolves %s with system dark=%s to %s', (preference, systemPrefersDark, expected) => {
    expect(resolveUiTheme(preference, systemPrefersDark)).toBe(expected)
  })

  it.each([
    ['dark', false, 'dark'],
    ['light', true, 'light'],
  ] as const)('applies explicit %s preference independently from the system theme', (storedPreference, systemPrefersDark, expected) => {
    const environment = installThemeEnvironment({ storedPreference, systemPrefersDark })

    applyStoredThemeEarly()

    expect(environment.dataset.theme).toBe(expected)
    expect(environment.getItem).toHaveBeenCalledTimes(2)
    expect(environment.getItem).toHaveBeenCalledWith(UI_CUSTOM_THEMES_STORAGE_KEY)
    expect(environment.getItem).toHaveBeenCalledWith(UI_THEME_STORAGE_KEY)
    expect(environment.matchMedia).toHaveBeenCalledOnce()
  })

  it.each([
    [false, 'light'],
    [true, 'dark'],
  ] as const)('uses the system theme when the stored preference is system (dark=%s)', (systemPrefersDark, expected) => {
    const environment = installThemeEnvironment({ storedPreference: 'system', systemPrefersDark })

    applyStoredThemeEarly()

    expect(environment.dataset.theme).toBe(expected)
  })

  it('falls back to the system theme when localStorage access fails', () => {
    const environment = installThemeEnvironment({
      storedPreference: null,
      systemPrefersDark: true,
      storageError: new Error('storage disabled'),
    })

    expect(() => applyStoredThemeEarly()).not.toThrow()
    expect(environment.dataset.theme).toBe('dark')
    expect(environment.getItem).toHaveBeenCalledTimes(2)
  })

  it('falls back to light when matchMedia is unavailable', () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'system' },
    })
    vi.stubGlobal('document', {
      documentElement: { dataset },
    })

    applyStoredThemeEarly()

    expect(dataset.theme).toBe('light')
  })

  it('normalizes custom selections only when their profile still exists', () => {
    const profile = { id: 'night-orange', name: 'Night orange', base: 'dark' as const, colors: customThemePreset('dark') }
    expect(normalizeThemeSelection('custom:night-orange', [profile])).toBe('custom:night-orange')
    expect(normalizeThemeSelection('custom:deleted', [profile])).toBe('system')
  })

  it('parses custom themes defensively and fills missing colors from the base preset', () => {
    const themes = parseCustomThemes(JSON.stringify([{
      id: 'my-theme',
      name: '  My theme  ',
      base: 'dark',
      colors: { accentText: '#abcdef', background: 'not-a-color' },
    }]))

    expect(themes).toHaveLength(1)
    expect(themes[0]?.name).toBe('My theme')
    expect(themes[0]?.colors.accentText).toBe('#abcdef')
    expect(themes[0]?.colors.background).toBe(customThemePreset('dark').background)
  })

  it('preserves every built-in surface layer when creating an untouched custom theme', () => {
    const dark = customThemePreset('dark')
    expect(dark.surface).toBe('#18191b')
    expect(dark.surfaceRaised).toBe('#202124')
    expect(dark.surfaceSubtle).toBe('#1d1e20')
    expect(dark.surfaceActive).toBe('#292b2e')
    expect(dark.surfaceSunken).toBe('#131416')
  })

  it('falls back to readable base colors without discarding the stored custom values', () => {
    const colors = customThemePreset('dark')
    colors.text = colors.surface
    colors.accentText = colors.surface
    const profile = { id: 'unsafe', name: 'Unsafe', base: 'dark' as const, colors }

    expect(colorContrastRatio(colors.text, colors.surface)).toBe(1)
    expect(customThemeContrastWarnings(colors).map((warning) => warning.key)).toContain('text')
    expect(customThemeContrastWarnings(colors).map((warning) => warning.key)).toContain('accentText')
    const readable = readableCustomThemeColors(profile)
    expect(colorContrastRatio(readable.text, colors.surface)).toBeGreaterThanOrEqual(4.5)
    expect(colorContrastRatio(readable.accentText, colors.surface)).toBeGreaterThanOrEqual(3)
    expect(profile.colors.text).toBe(colors.surface)
  })

  it('falls back to the deleted theme base only when the active custom theme is removed', () => {
    const profile = { id: 'night-orange', name: 'Night orange', base: 'dark' as const, colors: customThemePreset('dark') }
    expect(removeCustomTheme([profile], 'custom:night-orange', profile.id)).toEqual({ themes: [], selection: 'dark' })
    expect(removeCustomTheme([profile], 'light', profile.id)).toEqual({ themes: [], selection: 'light' })
  })

  it('applies a stored custom theme before React mounts', () => {
    const profile = { id: 'night-orange', name: 'Night orange', base: 'dark' as const, colors: customThemePreset('dark') }
    const environment = installThemeEnvironment({
      storedPreference: 'custom:night-orange',
      storedCustomThemes: JSON.stringify([profile]),
    })

    expect(applyStoredThemeEarly()).toBe('dark')
    expect(environment.dataset.theme).toBe('dark')
    expect(environment.dataset.themeProfile).toBe('night-orange')
    expect(environment.customProperties.get('--accent-text')).toBe('#ff9000')
    expect(environment.customProperties.get('--account-available-text')).toBe('#6cc9a5')
  })

  it('updates browser chrome metadata together with the document theme', () => {
    const dataset: Record<string, string> = {}
    const setAttribute = vi.fn()
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'dark' },
      matchMedia: () => ({ matches: false }),
    })
    vi.stubGlobal('document', {
      documentElement: { dataset },
      querySelector: vi.fn(() => ({ setAttribute })),
    })

    expect(applyStoredThemeEarly()).toBe('dark')
    expect(dataset.theme).toBe('dark')
    expect(setAttribute).toHaveBeenCalledWith('content', '#141517')
  })

  it('does nothing when document is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'dark' },
      matchMedia: () => ({ matches: true }),
    })

    expect(applyStoredThemeEarly()).toBeUndefined()
  })
})
