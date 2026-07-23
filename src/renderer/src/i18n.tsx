import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UiLanguage } from '@shared/types'

export type { UiLanguage } from '@shared/types'
export type UiLanguagePreference = 'system' | UiLanguage

export const UI_LANGUAGE_STORAGE_KEY = 'stone.ui.language'

type Translator = <T>(chinese: T, english: T) => T

interface I18nContextValue {
  language: UiLanguage
  preference: UiLanguagePreference
  setPreference: (preference: UiLanguagePreference) => void
  t: Translator
  locale: 'zh-CN' | 'en-US'
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

export function systemLanguageFromLocale(locale: string | undefined): UiLanguage {
  return typeof locale === 'string' && /^zh(?:[-_]|$)/i.test(locale.trim()) ? 'zh-CN' : 'en'
}

export function normalizeLanguagePreference(value: unknown): UiLanguagePreference {
  return value === 'zh-CN' || value === 'en' || value === 'system' ? value : 'system'
}

export function resolveUiLanguage(
  preference: UiLanguagePreference,
  systemLocale: string | undefined,
): UiLanguage {
  return preference === 'system' ? systemLanguageFromLocale(systemLocale) : preference
}

export function translate<T>(language: UiLanguage, chinese: T, english: T): T {
  return language === 'zh-CN' ? chinese : english
}

function currentSystemLocale(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language
}

function readPreference(): UiLanguagePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    return normalizeLanguagePreference(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<UiLanguagePreference>(readPreference)
  const [systemLocale, setSystemLocale] = useState<string | undefined>(currentSystemLocale)
  const language = resolveUiLanguage(preference, systemLocale)

  useEffect(() => {
    const handleLanguageChange = () => setSystemLocale(currentSystemLocale())
    window.addEventListener('languagechange', handleLanguageChange)
    return () => window.removeEventListener('languagechange', handleLanguageChange)
  }, [])

  useEffect(() => {
    document.documentElement.lang = language
    void window.stone?.setUiLanguage(language).catch(() => undefined)
  }, [language])

  const setPreference = useCallback((next: UiLanguagePreference) => {
    const normalized = normalizeLanguagePreference(next)
    setStoredPreference(normalized)
    try {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalized)
    } catch {
      // A disabled localStorage must not prevent an in-memory language switch.
    }
  }, [])

  const t = useCallback<Translator>((chinese, english) => (
    language === 'zh-CN' ? chinese : english
  ), [language])
  const value = useMemo<I18nContextValue>(() => ({
    language,
    preference,
    setPreference,
    t,
    locale: language === 'zh-CN' ? 'zh-CN' : 'en-US',
  }), [language, preference, setPreference, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
