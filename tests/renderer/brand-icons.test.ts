import { describe, expect, it } from 'vitest'
import { clientBrandMeta, providerBrandIcon, providerBrandIconClass } from '../../src/renderer/src/brand-icons'

describe('provider brand icons', () => {
  it('uses the official Grok mark for xAI-compatible relays', () => {
    expect(providerBrandIcon('xai-compatible')).toMatch(/grok\.svg$/)
  })

  it('uses the DeepSeek brand mark for official and compatible sources', () => {
    expect(providerBrandIcon('deepseek')).toMatch(/deepseek\.svg$/)
    expect(providerBrandIcon('deepseek-compatible')).toMatch(/deepseek\.svg$/)
  })

  it('keeps unknown custom providers on the text fallback', () => {
    expect(providerBrandIcon('custom')).toBeUndefined()
  })

  it('marks OpenAI provider and Codex client icons for dark-theme contrast', () => {
    expect(providerBrandIconClass('openai')).toBe('brand-icon--openai')
    expect(providerBrandIconClass('openai-compatible')).toBe('brand-icon--openai')
    expect(providerBrandIconClass('xai-compatible')).toBeUndefined()
    expect(clientBrandMeta.codex.iconClassName).toBe('brand-icon--openai')
  })
})
