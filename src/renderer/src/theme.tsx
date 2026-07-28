import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { UiTheme, UiThemePreference } from '@shared/types'

export type { UiTheme, UiThemePreference } from '@shared/types'

export const UI_THEME_STORAGE_KEY = 'stone.ui.theme'
export const UI_CUSTOM_THEMES_STORAGE_KEY = 'stone.ui.custom-themes'
export const CUSTOM_THEME_LIMIT = 12

const UI_THEME_COLORS: Record<UiTheme, string> = {
  light: '#f9fbfa',
  dark: '#141517',
}

export const CUSTOM_THEME_COLOR_KEYS = [
  'background',
  'surface',
  'surfaceRaised',
  'surfaceSubtle',
  'surfaceMuted',
  'surfaceHover',
  'surfaceActive',
  'surfaceSunken',
  'surfaceInset',
  'border',
  'controlBorder',
  'text',
  'textSoft',
  'muted',
  'navText',
  'accent',
  'accentHover',
  'accentSoft',
  'accentText',
  'accentTextStrong',
  'available',
  'danger',
  'warning',
] as const

export type CustomThemeColorKey = typeof CUSTOM_THEME_COLOR_KEYS[number]
export type CustomThemeColors = Record<CustomThemeColorKey, string>

export interface CustomUiTheme {
  id: string
  name: string
  base: UiTheme
  colors: CustomThemeColors
}

export type UiThemeSelection = UiThemePreference | `custom:${string}`

const CUSTOM_THEME_PRESETS: Record<UiTheme, CustomThemeColors> = {
  light: {
    background: '#f4f6f5',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    surfaceSubtle: '#f8faf9',
    surfaceMuted: '#eef2f0',
    surfaceHover: '#f6faf8',
    surfaceActive: '#f1f8f5',
    surfaceSunken: '#edf0ef',
    surfaceInset: '#fbfcfb',
    border: '#dfe5e2',
    controlBorder: '#b8c3be',
    text: '#18211e',
    textSoft: '#3d4a45',
    muted: '#59645f',
    navText: '#50605a',
    accent: '#176b52',
    accentHover: '#105b45',
    accentSoft: '#e5f1ed',
    accentText: '#176b52',
    accentTextStrong: '#105b45',
    available: '#176b52',
    danger: '#b44444',
    warning: '#a96616',
  },
  dark: {
    background: '#111214',
    surface: '#18191b',
    surfaceRaised: '#202124',
    surfaceSubtle: '#1d1e20',
    surfaceMuted: '#242527',
    surfaceHover: '#25272a',
    surfaceActive: '#292b2e',
    surfaceSunken: '#131416',
    surfaceInset: '#1b1c1e',
    border: '#0f1012',
    controlBorder: '#6c7076',
    text: '#fafafa',
    textSoft: '#e4e5e6',
    muted: '#c2c4c6',
    navText: '#e1e3e2',
    accent: '#aeb3b1',
    accentHover: '#d2d5d4',
    accentSoft: '#252729',
    accentText: '#ff9000',
    accentTextStrong: '#ffa31a',
    available: '#6cc9a5',
    danger: '#e08585',
    warning: '#d59a52',
  },
}

const THEME_COLOR_VARIABLES: Record<CustomThemeColorKey, readonly string[]> = {
  background: ['--bg'],
  surface: ['--surface'],
  surfaceRaised: ['--surface-raised'],
  surfaceSubtle: ['--surface-subtle'],
  surfaceMuted: ['--surface-muted'],
  surfaceHover: ['--surface-hover'],
  surfaceActive: ['--surface-active'],
  surfaceSunken: ['--surface-sunken'],
  surfaceInset: ['--surface-inset'],
  border: ['--border'],
  controlBorder: ['--control-border'],
  text: ['--text'],
  textSoft: ['--text-soft'],
  muted: ['--muted', '--faint'],
  navText: ['--nav-text'],
  accent: ['--accent', '--green'],
  accentHover: ['--accent-hover', '--accent-strong'],
  accentSoft: ['--accent-soft'],
  accentText: ['--accent-text'],
  accentTextStrong: ['--accent-text-strong'],
  available: ['--account-available-text', '--ok-text', '--success'],
  danger: ['--red', '--danger-text'],
  warning: ['--amber', '--warn-text', '--warning'],
}

const CUSTOM_DERIVED_VARIABLES = [
  '--border-strong', '--border-subtle', '--border-active', '--border-accent', '--control-border-hover',
  '--focus-ring', '--accent-rgb', '--accent-glow-rgb', '--shadow-rgb', '--overlay-rgb', '--on-accent',
  '--ok-soft', '--ok-border', '--danger-soft', '--danger-border', '--danger-text-strong',
  '--red-soft', '--on-danger', '--warn-soft', '--warn-border', '--amber-soft',
  '--scroll-thumb', '--scroll-thumb-hover', '--scroll-thumb-active',
] as const

interface ThemeContextValue {
  theme: UiTheme
  systemTheme: UiTheme
  preference: UiThemeSelection
  customThemes: readonly CustomUiTheme[]
  activeCustomTheme?: CustomUiTheme
  setPreference: (preference: UiThemeSelection) => void
  createCustomTheme: () => string | undefined
  updateCustomTheme: (id: string, update: Partial<Pick<CustomUiTheme, 'name' | 'base' | 'colors'>>) => void
  deleteCustomTheme: (id: string) => void
  resetCustomTheme: (id: string, base?: UiTheme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu
const CUSTOM_THEME_ID_PATTERN = /^[a-z0-9-]{1,64}$/u

function isUiTheme(value: unknown): value is UiTheme {
  return value === 'light' || value === 'dark'
}

function isCustomSelection(value: UiThemeSelection): value is `custom:${string}` {
  return value.startsWith('custom:')
}

function customSelection(id: string): `custom:${string}` {
  return `custom:${id}`
}

function clonePreset(theme: UiTheme): CustomThemeColors {
  return { ...CUSTOM_THEME_PRESETS[theme] }
}

export function customThemePreset(theme: UiTheme): CustomThemeColors {
  return clonePreset(theme)
}

export function normalizeThemePreference(value: unknown): UiThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function normalizeThemeSelection(value: unknown, themes: readonly CustomUiTheme[]): UiThemeSelection {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  if (typeof value !== 'string' || !value.startsWith('custom:')) return 'system'
  const id = value.slice('custom:'.length)
  return themes.some((theme) => theme.id === id) ? customSelection(id) : 'system'
}

export function removeCustomTheme(
  themes: readonly CustomUiTheme[],
  selection: UiThemeSelection,
  id: string,
): { themes: CustomUiTheme[]; selection: UiThemeSelection } {
  const deleting = themes.find((profile) => profile.id === id)
  if (!deleting) return { themes: [...themes], selection }
  return {
    themes: themes.filter((profile) => profile.id !== id),
    selection: selection === customSelection(id) ? deleting.base : selection,
  }
}

export function resolveUiTheme(preference: UiThemePreference, systemPrefersDark: boolean): UiTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export function parseCustomThemes(value: string | null): CustomUiTheme[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    const ids = new Set<string>()
    const themes: CustomUiTheme[] = []
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') continue
      const record = candidate as Record<string, unknown>
      if (typeof record.id !== 'string' || !CUSTOM_THEME_ID_PATTERN.test(record.id) || ids.has(record.id)) continue
      if (typeof record.name !== 'string' || !isUiTheme(record.base) || !record.colors || typeof record.colors !== 'object') continue
      const sourceColors = record.colors as Record<string, unknown>
      const preset = clonePreset(record.base)
      const colors = { ...preset }
      for (const key of CUSTOM_THEME_COLOR_KEYS) {
        const color = sourceColors[key]
        if (typeof color === 'string' && HEX_COLOR_PATTERN.test(color)) colors[key] = color.toLowerCase()
      }
      ids.add(record.id)
      themes.push({
        id: record.id,
        name: record.name.trim().slice(0, 40) || '自定义主题',
        base: record.base,
        colors,
      })
      if (themes.length >= CUSTOM_THEME_LIMIT) break
    }
    return themes
  } catch {
    return []
  }
}

function darkMediaQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  return window.matchMedia('(prefers-color-scheme: dark)')
}

function currentSystemPrefersDark(): boolean {
  return darkMediaQuery()?.matches ?? false
}

function readCustomThemes(): CustomUiTheme[] {
  if (typeof window === 'undefined') return []
  try {
    return parseCustomThemes(window.localStorage.getItem(UI_CUSTOM_THEMES_STORAGE_KEY))
  } catch {
    return []
  }
}

function readSelection(themes: readonly CustomUiTheme[]): UiThemeSelection {
  if (typeof window === 'undefined') return 'system'
  try {
    return normalizeThemeSelection(window.localStorage.getItem(UI_THEME_STORAGE_KEY), themes)
  } catch {
    return 'system'
  }
}

function persistSelection(selection: UiThemeSelection): void {
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, selection)
  } catch {
    // A disabled localStorage must not prevent an in-memory theme switch.
  }
}

function persistCustomThemes(themes: readonly CustomUiTheme[]): void {
  try {
    window.localStorage.setItem(UI_CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes))
  } catch {
    // Custom themes remain usable for the current session when storage is unavailable.
  }
}

function hexRgb(value: string): string {
  const normalized = value.slice(1)
  return `${Number.parseInt(normalized.slice(0, 2), 16)} ${Number.parseInt(normalized.slice(2, 4), 16)} ${Number.parseInt(normalized.slice(4, 6), 16)}`
}

function readableForeground(background: string): string {
  const rgb = background.slice(1).match(/.{2}/gu)?.map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0]
  const luminance = (0.2126 * (rgb[0] ?? 0)) + (0.7152 * (rgb[1] ?? 0)) + (0.0722 * (rgb[2] ?? 0))
  return luminance >= 148 ? '#151617' : '#ffffff'
}

function linearChannel(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export function colorContrastRatio(foreground: string, background: string): number {
  if (!HEX_COLOR_PATTERN.test(foreground) || !HEX_COLOR_PATTERN.test(background)) return 1
  const channels = (color: string) => color.slice(1).match(/.{2}/gu)?.map((part) => linearChannel(Number.parseInt(part, 16))) ?? [0, 0, 0]
  const luminance = (color: string) => {
    const [red = 0, green = 0, blue = 0] = channels(color)
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
  }
  const brighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (brighter + 0.05) / (darker + 0.05)
}

export interface ThemeContrastWarning {
  key: 'text' | 'textSoft' | 'muted' | 'navText' | 'accentText' | 'available' | 'controlBorder'
  ratio: number
  minimum: number
}

export function customThemeContrastWarnings(colors: CustomThemeColors): ThemeContrastWarning[] {
  const checks: Array<[ThemeContrastWarning['key'], string, string, number]> = [
    ['text', colors.text, colors.surface, 4.5],
    ['text', colors.text, colors.background, 4.5],
    ['textSoft', colors.textSoft, colors.surface, 3],
    ['textSoft', colors.textSoft, colors.background, 3],
    ['muted', colors.muted, colors.surface, 3],
    ['muted', colors.muted, colors.background, 3],
    ['navText', colors.navText, colors.background, 3],
    ['accentText', colors.accentText, colors.surface, 3],
    ['accentText', colors.accentText, colors.accentSoft, 3],
    ['available', colors.available, colors.surface, 3],
    ['controlBorder', colors.controlBorder, colors.surface, 1.5],
  ]
  const warnings = checks.flatMap(([key, foreground, background, minimum]) => {
    const ratio = colorContrastRatio(foreground, background)
    return ratio < minimum ? [{ key, ratio, minimum }] : []
  })
  return [...new Map(warnings.map((warning) => [warning.key, warning])).values()]
}

export function readableCustomThemeColors(profile: CustomUiTheme): CustomThemeColors {
  const preset = CUSTOM_THEME_PRESETS[profile.base]
  const colors = { ...profile.colors }
  const backgrounds: Record<ThemeContrastWarning['key'], readonly string[]> = {
    text: [colors.surface, colors.background],
    textSoft: [colors.surface, colors.background],
    muted: [colors.surface, colors.background],
    navText: [colors.background],
    accentText: [colors.surface, colors.accentSoft],
    available: [colors.surface],
    controlBorder: [colors.surface],
  }
  for (const warning of customThemeContrastWarnings(colors)) {
    const candidates = [preset[warning.key], '#ffffff', '#151617']
    colors[warning.key] = candidates.reduce((best, candidate) => {
      const candidateRatio = Math.min(...backgrounds[warning.key].map((background) => colorContrastRatio(candidate, background)))
      const bestRatio = Math.min(...backgrounds[warning.key].map((background) => colorContrastRatio(best, background)))
      return candidateRatio > bestRatio ? candidate : best
    }, candidates[0] ?? '#ffffff')
  }
  return colors
}

function clearCustomThemeVariables(): void {
  if (typeof document === 'undefined' || !document.documentElement.style) return
  for (const variables of Object.values(THEME_COLOR_VARIABLES)) {
    for (const variable of variables) document.documentElement.style.removeProperty(variable)
  }
  for (const variable of CUSTOM_DERIVED_VARIABLES) document.documentElement.style.removeProperty(variable)
}

function applyCustomThemeVariables(profile: CustomUiTheme): void {
  if (typeof document === 'undefined' || !document.documentElement.style) return
  const { base } = profile
  const colors = readableCustomThemeColors(profile)
  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    for (const variable of THEME_COLOR_VARIABLES[key]) document.documentElement.style.setProperty(variable, colors[key])
  }

  const style = document.documentElement.style
  const mix = (first: string, firstWeight: number, second: string) => `color-mix(in srgb, ${first} ${firstWeight}%, ${second})`
  style.setProperty('--border-strong', mix(colors.border, 68, colors.text))
  style.setProperty('--border-subtle', mix(colors.border, 72, colors.surface))
  style.setProperty('--border-active', mix(colors.border, 60, colors.accent))
  style.setProperty('--border-accent', mix(colors.border, 55, colors.accent))
  style.setProperty('--control-border-hover', mix(colors.controlBorder, 70, colors.text))

  const accentRgb = hexRgb(colors.accentText)
  style.setProperty('--accent-rgb', accentRgb)
  style.setProperty('--accent-glow-rgb', accentRgb)
  style.setProperty('--shadow-rgb', base === 'dark' ? '0 0 0' : '20 33 28')
  style.setProperty('--overlay-rgb', base === 'dark' ? '0 0 0' : '15 24 21')
  style.setProperty('--focus-ring', `rgb(${accentRgb} / 38%)`)
  style.setProperty('--on-accent', readableForeground(colors.accent))

  style.setProperty('--ok-soft', mix(colors.surface, 88, colors.available))
  style.setProperty('--ok-border', mix(colors.border, 62, colors.available))
  style.setProperty('--danger-soft', mix(colors.surface, 88, colors.danger))
  style.setProperty('--red-soft', mix(colors.surface, 88, colors.danger))
  style.setProperty('--danger-border', mix(colors.border, 62, colors.danger))
  style.setProperty('--danger-text-strong', mix(colors.danger, 78, colors.text))
  style.setProperty('--on-danger', readableForeground(colors.danger))
  style.setProperty('--warn-soft', mix(colors.surface, 88, colors.warning))
  style.setProperty('--warn-border', mix(colors.border, 62, colors.warning))
  style.setProperty('--amber-soft', mix(colors.surface, 88, colors.warning))

  if (base === 'dark') {
    style.setProperty('--scroll-thumb', 'rgb(235 237 236 / 16%)')
    style.setProperty('--scroll-thumb-hover', 'rgb(235 237 236 / 30%)')
    style.setProperty('--scroll-thumb-active', 'rgb(255 255 255 / 42%)')
  } else {
    style.setProperty('--scroll-thumb', 'rgb(70 91 83 / 30%)')
    style.setProperty('--scroll-thumb-hover', 'rgb(70 91 83 / 52%)')
    style.setProperty('--scroll-thumb-active', 'rgb(70 91 83 / 68%)')
  }
}

function applyDocumentTheme(theme: UiTheme, customTheme?: CustomUiTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  if (customTheme) {
    document.documentElement.dataset.themeProfile = customTheme.id
    applyCustomThemeVariables(customTheme)
  } else {
    delete document.documentElement.dataset.themeProfile
    clearCustomThemeVariables()
  }
  if (typeof document.querySelector === 'function') {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', UI_THEME_COLORS[theme])
  }
}

function selectedCustomTheme(selection: UiThemeSelection, themes: readonly CustomUiTheme[]): CustomUiTheme | undefined {
  if (!isCustomSelection(selection)) return undefined
  const id = selection.slice('custom:'.length)
  return themes.find((theme) => theme.id === id)
}

export function applyStoredThemeEarly(): UiTheme | undefined {
  if (typeof document === 'undefined') return undefined
  const customThemes = readCustomThemes()
  const selection = readSelection(customThemes)
  const customTheme = selectedCustomTheme(selection, customThemes)
  const theme = customTheme?.base ?? resolveUiTheme(normalizeThemePreference(selection), currentSystemPrefersDark())
  applyDocumentTheme(theme, customTheme)
  return theme
}

function createThemeId(existing: readonly CustomUiTheme[]): string {
  const used = new Set(existing.map((theme) => theme.id))
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().toLowerCase()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  if (!used.has(randomId)) return randomId
  let suffix = 2
  while (used.has(`${randomId}-${suffix}`)) suffix += 1
  return `${randomId}-${suffix}`
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [customThemes, setCustomThemes] = useState<CustomUiTheme[]>(readCustomThemes)
  const customThemesRef = useRef(customThemes)
  customThemesRef.current = customThemes
  const [preference, setStoredPreference] = useState<UiThemeSelection>(() => readSelection(customThemes))
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(currentSystemPrefersDark)
  const activeCustomTheme = useMemo(() => selectedCustomTheme(preference, customThemes), [customThemes, preference])
  const systemTheme = resolveUiTheme('system', systemPrefersDark)
  const theme = activeCustomTheme?.base ?? resolveUiTheme(normalizeThemePreference(preference), systemPrefersDark)

  useEffect(() => {
    const query = darkMediaQuery()
    if (!query) return
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    query.addEventListener('change', handleChange)
    setSystemPrefersDark(query.matches)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    applyDocumentTheme(theme, activeCustomTheme)
    const nativePreference: UiThemePreference = preference === 'system' || preference === 'light' || preference === 'dark'
      ? preference
      : theme
    void window.stone?.setUiTheme(theme, nativePreference).catch(() => undefined)
  }, [activeCustomTheme, preference, theme])

  const setPreference = useCallback((next: UiThemeSelection) => {
    const normalized = normalizeThemeSelection(next, customThemes)
    setStoredPreference(normalized)
    persistSelection(normalized)
  }, [customThemes])

  const commitThemes = useCallback((updater: (current: readonly CustomUiTheme[]) => CustomUiTheme[]) => {
    const next = updater(customThemesRef.current)
    customThemesRef.current = next
    persistCustomThemes(next)
    setCustomThemes(next)
  }, [])

  const createCustomTheme = useCallback((): string | undefined => {
    const current = customThemesRef.current
    if (current.length >= CUSTOM_THEME_LIMIT) return undefined
    const id = createThemeId(current)
    const source = activeCustomTheme?.colors ?? clonePreset(theme)
    const profile: CustomUiTheme = {
      id,
      name: `自定义主题 ${current.length + 1}`,
      base: activeCustomTheme?.base ?? theme,
      colors: { ...source },
    }
    commitThemes((current) => [...current, profile])
    const selection = customSelection(id)
    setStoredPreference(selection)
    persistSelection(selection)
    return id
  }, [activeCustomTheme, commitThemes, theme])

  const updateCustomTheme = useCallback((id: string, update: Partial<Pick<CustomUiTheme, 'name' | 'base' | 'colors'>>) => {
    commitThemes((current) => current.map((profile) => {
      if (profile.id !== id) return profile
      const base = isUiTheme(update.base) ? update.base : profile.base
      const name = typeof update.name === 'string' ? update.name.slice(0, 40) : profile.name
      const colors = update.colors
        ? CUSTOM_THEME_COLOR_KEYS.reduce<CustomThemeColors>((result, key) => {
            const value = update.colors?.[key]
            result[key] = typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : profile.colors[key]
            return result
          }, { ...profile.colors })
        : profile.colors
      return { ...profile, base, name, colors }
    }))
  }, [commitThemes])

  const deleteCustomTheme = useCallback((id: string) => {
    const result = removeCustomTheme(customThemesRef.current, preference, id)
    if (result.themes.length === customThemesRef.current.length) return
    commitThemes(() => result.themes)
    if (result.selection !== preference) {
      setStoredPreference(result.selection)
      persistSelection(result.selection)
    }
  }, [commitThemes, preference])

  const resetCustomTheme = useCallback((id: string, base?: UiTheme) => {
    const profile = customThemesRef.current.find((candidate) => candidate.id === id)
    if (!profile) return
    const nextBase = base ?? profile.base
    updateCustomTheme(id, { base: nextBase, colors: clonePreset(nextBase) })
  }, [updateCustomTheme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      systemTheme,
      preference,
      customThemes,
      activeCustomTheme,
      setPreference,
      createCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
      resetCustomTheme,
    }),
    [activeCustomTheme, createCustomTheme, customThemes, deleteCustomTheme, preference, resetCustomTheme, setPreference, systemTheme, theme, updateCustomTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
