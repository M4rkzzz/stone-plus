import { describe, expect, it } from 'vitest'
import {
  accountSourceLabel,
  isOAuthManagedCredential,
  requestLogSourceLabel,
} from '../../src/renderer/src/account-source-label'

describe('OAuth-managed credential classification', () => {
  it.each([
    'chatgpt-oauth',
    'chatgpt-agent-identity',
    'grok-oauth',
  ] as const)('classifies %s as OAuth-managed', (credentialType) => {
    expect(isOAuthManagedCredential(credentialType)).toBe(true)
  })

  it.each([
    undefined,
    'api-key',
    'kiro-api-key',
  ] as const)('does not classify %s as OAuth-managed', (credentialType) => {
    expect(isOAuthManagedCredential(credentialType)).toBe(false)
  })
})

describe('account source labels', () => {
  it('identifies Agent Identity accounts instead of inheriting the shared OAuth provider name', () => {
    expect(accountSourceLabel('chatgpt-agent-identity', 'ChatGPT OAuth')).toBe('Agent Identity')
  })

  it('keeps the provider name for OAuth and API-key accounts', () => {
    expect(accountSourceLabel('chatgpt-oauth', 'ChatGPT OAuth')).toBe('ChatGPT OAuth')
    expect(accountSourceLabel('api-key', 'OpenAI')).toBe('OpenAI')
  })

  it('uses the unknown-source fallback when credential and provider metadata are absent', () => {
    expect(accountSourceLabel(undefined, undefined)).toBe('—')
    expect(requestLogSourceLabel({})).toBe('—')
  })

  it('corrects legacy request logs through the current account and persists the label for new logs', () => {
    expect(requestLogSourceLabel({ providerName: 'ChatGPT OAuth' }, 'chatgpt-agent-identity')).toBe('Agent Identity')
    expect(requestLogSourceLabel({ providerName: 'ChatGPT OAuth', credentialType: 'chatgpt-agent-identity' })).toBe('Agent Identity')
  })
})
