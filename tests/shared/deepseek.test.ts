import { describe, expect, it } from 'vitest'
import { deepSeekOnlyRouteContextWindow, DEEPSEEK_V4_FLASH_CONTEXT_WINDOW } from '../../src/shared/deepseek'
import { codexConnectionRouteMetadata } from '../../src/shared/codex-model-repair'
import type { Account, AppSnapshot, Pool, ProviderDefinition } from '../../src/shared/types'

const timestamp = 1_700_000_000_000

function provider(id: string, kind: ProviderDefinition['kind']): ProviderDefinition {
  return {
    id,
    name: id,
    kind,
    sourceType: 'official-api',
    baseUrl: `https://${id}.example.test`,
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
