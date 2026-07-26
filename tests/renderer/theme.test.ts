import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UI_THEME_STORAGE_KEY,
  applyStoredThemeEarly,
  normalizeThemePreference,
  resolveUiTheme,
} from '../../src/renderer/src/theme'

function installThemeEnvironment({
  storedPreference,
  systemPrefersDark = false,
  storageError,
}: {
  storedPreference: string | null
  systemPrefersDark?: boolean
  storageError?: Error
}) {
  const dataset: Record<string, string> = {}
  const getItem = vi.fn((key: string) => {
    expect(key).toBe(UI_THEME_STORAGE_KEY)
    if (storageError) throw storageError
    return storedPreference
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
    documentElement: { dataset },
  })

  return { dataset, getItem, matchMedia }
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
    expect(environment.getItem).toHaveBeenCalledOnce()
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
    expect(environment.getItem).toHaveBeenCalledOnce()
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
    expect(setAttribute).toHaveBeenCalledWith('content', '#161c1a')
  })

  it('does nothing when document is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'dark' },
      matchMedia: () => ({ matches: true }),
    })

    expect(applyStoredThemeEarly()).toBeUndefined()
  })
})
