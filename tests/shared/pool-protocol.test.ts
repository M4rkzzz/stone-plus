import { describe, expect, it } from 'vitest'
import { accountMatchesPoolProtocol, accountPoolProtocol } from '../../src/shared/pool-protocol'
import type { Account, ProviderDefinition } from '../../src/shared/types'

const account = (credentialType: Account['credentialType']): Pick<Account, 'credentialType'> => ({ credentialType })

const provider = (
  kind: ProviderDefinition['kind'],
  protocol: ProviderDefinition['protocol'],
  sourceType: ProviderDefinition['sourceType'],
): Pick<ProviderDefinition, 'kind' | 'protocol' | 'sourceType'> => ({ kind, protocol, sourceType })

describe('logical pool protocol', () => {
  it('keeps ordinary accounts on their real wire protocol', () => {
    const openai = provider('openai', 'openai-responses', 'official-api')
    expect(accountPoolProtocol(account('api-key'), openai)).toBe('openai-responses')
    expect(accountMatchesPoolProtocol('openai-responses', account('api-key'), openai)).toBe(true)
    expect(accountMatchesPoolProtocol('grok', account('api-key'), openai)).toBe(false)
  })

  it('maps both Grok OAuth Responses and official xAI Chat sources to Grok pools', () => {
    const oauth = provider('xai', 'openai-responses', 'oauth-system')
    const official = provider('xai', 'openai-chat', 'official-api')
    expect(accountPoolProtocol(account('grok-oauth'), oauth)).toBe('grok')
    expect(accountPoolProtocol(account('api-key'), official)).toBe('grok')
    expect(accountMatchesPoolProtocol('grok', account('grok-oauth'), oauth)).toBe(true)
    expect(accountMatchesPoolProtocol('grok', account('api-key'), official)).toBe(true)
    expect(accountMatchesPoolProtocol('openai-responses', account('grok-oauth'), oauth)).toBe(false)
    expect(accountMatchesPoolProtocol('openai-chat', account('api-key'), official)).toBe(false)
  })

  it('rejects corrupted family assignments and relay members', () => {
    const openai = provider('openai', 'openai-responses', 'official-api')
    const relay = provider('xai-compatible', 'openai-responses', 'relay')
    const xaiOauth = provider('xai', 'openai-responses', 'oauth-system')
    const xaiOfficial = provider('xai', 'openai-chat', 'official-api')
    expect(accountPoolProtocol(account('grok-oauth'), openai)).toBe('grok')
    expect(accountMatchesPoolProtocol('grok', account('grok-oauth'), openai)).toBe(false)
    expect(accountMatchesPoolProtocol('grok', account('api-key'), relay)).toBe(false)
    expect(accountMatchesPoolProtocol('grok', account('chatgpt-oauth'), xaiOauth)).toBe(false)
    expect(accountMatchesPoolProtocol('grok', account('grok-oauth'), xaiOfficial)).toBe(false)
  })
})
