import { describe, expect, it } from 'vitest'
import { GPT_5_6_SOL_WM_MODEL, supportsPoolWmRouting } from '../../src/shared/wm-routing'

describe('WM pool routing eligibility', () => {
  it('uses the exact hidden model id only for native ChatGPT Responses accounts', () => {
    expect(GPT_5_6_SOL_WM_MODEL).toBe('gpt-5.6-sol-wm')
    expect(supportsPoolWmRouting('openai-responses', [
      { credentialType: 'chatgpt-oauth' },
      { credentialType: 'chatgpt-agent-identity' },
    ])).toBe(true)
    expect(supportsPoolWmRouting('openai-chat', [{ credentialType: 'chatgpt-oauth' }])).toBe(false)
    expect(supportsPoolWmRouting('openai-responses', [{ credentialType: 'api-key' }])).toBe(false)
    expect(supportsPoolWmRouting('openai-responses', [])).toBe(false)
  })
})
