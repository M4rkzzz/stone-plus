import { describe, expect, it } from 'vitest'
import { providerSourceFamily } from '../../src/shared/source-family'

describe('provider source family', () => {
  it('keeps official and compatible OpenAI separate from Grok as routing families', () => {
    expect(providerSourceFamily('openai')).toBe('openai')
    expect(providerSourceFamily('openai-compatible')).toBe('openai')
    expect(providerSourceFamily('xai')).toBe('grok')
    expect(providerSourceFamily('xai-compatible')).toBe('grok')
  })

  it('keeps the remaining provider families stable', () => {
    expect(providerSourceFamily('anthropic')).toBe('anthropic')
    expect(providerSourceFamily('anthropic-compatible')).toBe('anthropic')
    expect(providerSourceFamily('google')).toBe('google')
    expect(providerSourceFamily('custom')).toBe('custom')
  })
})
