import { describe, expect, it } from 'vitest'
import { providerBrandIcon } from '../../src/renderer/src/brand-icons'

describe('provider brand icons', () => {
  it('uses the official Grok mark for xAI-compatible relays', () => {
    expect(providerBrandIcon('xai-compatible')).toMatch(/grok\.svg$/)
  })

  it('keeps unknown custom providers on the text fallback', () => {
    expect(providerBrandIcon('custom')).toBeUndefined()
  })
})
