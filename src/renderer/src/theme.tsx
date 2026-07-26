import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UiTheme, UiThemePreference } from '@shared/types'

export type { UiTheme, UiThemePreference } from '@shared/types'

export const UI_THEME_STORAGE_KEY = 'stone.ui.theme'
const UI_THEME_COLORS: Record<UiTheme, string> = {
  light: '#f9fbfa',
  dark: '#161c1a',
}

interface ThemeContextValue {
  theme: UiTheme
  preference: UiThemePreference
  setPreference: (preference: UiThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function normalizeThemePreference(value: unknown): UiThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function resolveUiTheme(preference: UiThemePreference, systemPrefersDark: boolean): UiTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

function darkMediaQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  return window.matchMedia('(prefers-color-scheme: dark)')
}

function currentSystemPrefersDark(): boolean {
  return darkMediaQuery()?.matches ?? false
}

function readPreference(): UiThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    return normalizeThemePreference(window.localStorage.getItem(UI_THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

/**
 * Applies the stored theme synchronously during module evaluation, before React
 * mounts, so a dark-mode user never sees a light first frame.
 */
function applyDocumentTheme(theme: UiTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  if (typeof document.querySelector === 'function') {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', UI_THEME_COLORS[theme])
  }
}

export function applyStoredThemeEarly(): UiTheme | undefined {
  if (typeof document === 'undefined') return undefined
  const theme = resolveUiTheme(readPreference(), currentSystemPrefersDark())
  applyDocumentTheme(theme)
  return theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<UiThemePreference>(readPreference)
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(currentSystemPrefersDark)
  const theme = resolveUiTheme(preference, systemPrefersDark)

  useEffect(() => {
    const query = darkMediaQuery()
    if (!query) return
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    query.addEventListener('change', handleChange)
    setSystemPrefersDark(query.matches)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    applyDocumentTheme(theme)
    void window.stone?.setUiTheme(theme, preference).catch(() => undefined)
  }, [theme, preference])

  const setPreference = useCallback((next: UiThemePreference) => {
    const normalized = normalizeThemePreference(next)
    setStoredPreference(normalized)
    try {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, normalized)
    } catch {
      // A disabled localStorage must not prevent an in-memory theme switch.
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, preference, setPreference }),
    [theme, preference, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
