import { describe, expect, it } from 'vitest'
import {
  applyDeepSeekModelLimits,
  deepSeekOnlyRouteContextWindow,
  DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
} from '../../src/shared/deepseek'
import { codexConnectionRouteMetadata } from '../../src/shared/codex-model-repair'
import type { Account, AppSnapshot, Pool, ProviderDefinition } from '../../src/shared/types'

const timestamp = 1_700_000_000_000

function provider(id: string, kind: ProviderDefinition['kind']): ProviderDefinition {
  return {
    id,
    name: id,
    kind,
    sourceType: 'official-api',
    baseUrl: kind === 'deepseek' ? 'https://api.deepseek.com' : `https://${id}.example.test`,
    protocol: 'openai-responses',
    models: ['deepseek-v4-flash'],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function account(id: string, providerId: string): Account {
  return {
    id,
    providerId,
    credentialId: `${id}-credential`,
    credentialType: 'api-key',
    name: id,
    maskedCredential: '***',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe('DeepSeek-only route context', () => {
  it('applies the documented V4 limits to both official Codex models', () => {
    expect(applyDeepSeekModelLimits([
      { id: 'deepseek-v4-flash', displayName: 'Flash' },
      { id: 'deepseek-v4-pro', displayName: 'Pro' },
      { id: 'relay-model', displayName: 'Relay' },
    ])).toEqual([
      expect.objectContaining({ id: 'deepseek-v4-flash', contextWindow: 1_048_576 }),
      expect.objectContaining({ id: 'deepseek-v4-pro', contextWindow: 1_048_576 }),
      { id: 'relay-model', displayName: 'Relay' },
    ])
  })

  it('recognizes both direct provider sources and persisted pools while rejecting mixed routes', () => {
    const deepSeek = provider('deepseek-direct', 'deepseek')
    const openAi = provider('openai-direct', 'openai')
    const deepSeekAccount = account('deepseek-account', deepSeek.id)
    const openAiAccount = account('openai-account', openAi.id)
    const pool: Pool = {
      id: 'deepseek-pool',
      name: 'DeepSeek pool',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [{ accountId: deepSeekAccount.id, enabled: true }],
      modelPolicy: 'all',
      modelAllowlist: [],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const snapshot = {
      accounts: [deepSeekAccount, openAiAccount],
      pools: [pool],
      providers: [deepSeek, openAi],
    } as Pick<AppSnapshot, 'accounts' | 'pools' | 'providers'>

    expect(deepSeekOnlyRouteContextWindow(snapshot, { poolId: deepSeek.id }))
      .toBe(DEEPSEEK_V4_FLASH_CONTEXT_WINDOW)
    expect(deepSeekOnlyRouteContextWindow(snapshot, { poolId: pool.id }))
      .toBe(DEEPSEEK_V4_FLASH_CONTEXT_WINDOW)
    expect(deepSeekOnlyRouteContextWindow(snapshot, {
      poolId: deepSeek.id,
      modelSourceMap: { 'gpt-5.6-sol': openAi.id },
    })).toBeUndefined()
  })

  it('does not assign the official 1M catalog to compatible or lookalike relays', () => {
    const relay = {
      ...provider('deepseek-relay', 'deepseek-compatible'),
      sourceType: 'relay' as const,
      baseUrl: 'http://10.0.0.8:3000',
    }
    const lookalike = {
      ...provider('deepseek-lookalike', 'deepseek'),
      baseUrl: 'https://deepseek.com.evil.example',
    }
    const relayAccount = account('relay-account', relay.id)
    const lookalikeAccount = account('lookalike-account', lookalike.id)

    expect(deepSeekOnlyRouteContextWindow({
      accounts: [relayAccount],
      pools: [],
      providers: [relay],
    }, { poolId: relay.id })).toBeUndefined()
    expect(deepSeekOnlyRouteContextWindow({
      accounts: [lookalikeAccount],
      pools: [],
      providers: [lookalike],
    }, { poolId: lookalike.id })).toBeUndefined()
  })

  it('uses one complete Codex connection policy for page and lifecycle validation', () => {
    const deepSeek = provider('deepseek-direct', 'deepseek')
    const deepSeekAccount = account('deepseek-account', deepSeek.id)
    const snapshot = {
      accounts: [deepSeekAccount],
      pools: [],
      providers: [deepSeek],
    } as Pick<AppSnapshot, 'accounts' | 'pools' | 'providers'>

    expect(codexConnectionRouteMetadata(snapshot, {
      poolId: deepSeek.id,
      modelMap: { 'gpt-5.6-terra': 'deepseek-v4-flash' },
      modelSourceMap: {},
    })).toEqual({
      modelContextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
      codexModelRepair: {
        modelMap: { 'gpt-5.6-terra': 'deepseek-v4-flash' },
        fallbackModel: 'gpt-5.6-terra',
      },
    })
  })
})
