import { describe, expect, it } from 'vitest'
import { accountSourceLabel, requestLogSourceLabel } from '../../src/renderer/src/account-source-label'

describe('account source labels', () => {
  it('identifies Agent Identity accounts instead of inheriting the shared OAuth provider name', () => {
    expect(accountSourceLabel('chatgpt-agent-identity', 'ChatGPT OAuth')).toBe('Agent Identity')
  })

  it('keeps the provider name for OAuth and API-key accounts', () => {
    expect(accountSourceLabel('chatgpt-oauth', 'ChatGPT OAuth')).toBe('ChatGPT OAuth')
    expect(accountSourceLabel('api-key', 'OpenAI')).toBe('OpenAI')
  })

  it('corrects legacy request logs through the current account and persists the label for new logs', () => {
    expect(requestLogSourceLabel({ providerName: 'ChatGPT OAuth' }, 'chatgpt-agent-identity')).toBe('Agent Identity')
    expect(requestLogSourceLabel({ providerName: 'ChatGPT OAuth', credentialType: 'chatgpt-agent-identity' })).toBe('Agent Identity')
  })
})
