import { describe, expect, it } from 'vitest'
import {
  normalizeLanguagePreference,
  resolveUiLanguage,
  systemLanguageFromLocale,
  translate,
} from '../../src/renderer/src/i18n'

describe('renderer language selection', () => {
  it('uses Chinese only for Chinese system locales', () => {
    expect(systemLanguageFromLocale('zh-CN')).toBe('zh-CN')
    expect(systemLanguageFromLocale('zh_TW')).toBe('zh-CN')
    expect(systemLanguageFromLocale('en-US')).toBe('en')
    expect(systemLanguageFromLocale('ja-JP')).toBe('en')
    expect(systemLanguageFromLocale(undefined)).toBe('en')
  })

  it('lets an explicit user preference override the system language', () => {
    expect(resolveUiLanguage('system', 'zh-CN')).toBe('zh-CN')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('en', 'zh-CN')).toBe('en')
    expect(resolveUiLanguage('zh-CN', 'en-US')).toBe('zh-CN')
  })

  it('normalizes persisted values and translates colocated copy', () => {
    expect(normalizeLanguagePreference('broken')).toBe('system')
    expect(normalizeLanguagePreference('en')).toBe('en')
    expect(translate('en', '设置', 'Settings')).toBe('Settings')
    expect(translate('zh-CN', '设置', 'Settings')).toBe('设置')
  })
})
