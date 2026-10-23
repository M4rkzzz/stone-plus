import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSourceInput } from '../../src/shared/types'
import { createMockApi } from '../../src/renderer/src/mockApi'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  storage.set('stone.ui.language', 'en')
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    setTimeout: (callback: () => void) => {
      callback()
      return 0
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

function relayInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return {
    name: 'Test relay',
    sourceType: 'relay',
    kind: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    protocol: 'openai-responses',
    credential: 'short-secret-value',
    models: [],
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    ...overrides,
  }
}

describe('browser mock API source safety', () => {
  it('validates before committing and never exposes credential prefixes', async () => {
    const api = createMockApi()
    const before = await api.getSnapshot()
    await expect(api.saveApiSource(relayInput({ credential: undefined }))).rejects.toThrow(/API key is required/i)
    expect((await api.getSnapshot()).providers).toHaveLength(before.providers.length)

    const saved = await api.saveApiSource(relayInput())
    const account = saved.accounts.find((candidate) => candidate.name === 'Test relay')
    expect(account?.maskedCredential).toBe('****alue')
    expect(account?.maskedCredential).not.toContain('short-secret')
  })

  it('keeps Kiro pending and rejects renderer-invented probe evidence', async () => {
    const api = createMockApi()
    const kiro = relayInput({
      kind: 'kiro-compatible',
      protocol: 'kiro-claude',
      baseUrl: 'https://kiro.example/generateAssistantResponse',
      models: ['claude-sonnet'],
      defaultModel: 'claude-sonnet',
    })
    const probe = await api.probeApiSource({
      name: kiro.name,
      sourceType: kiro.sourceType,
      kind: kiro.kind,
      baseUrl: kiro.baseUrl,
      protocol: kiro.protocol,
      credential: kiro.credential,
      model: kiro.defaultModel,
    })
    expect(probe.ok).toBe(false)
    expect(probe.probeEvidenceToken).toBeUndefined()
    expect(probe.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })

    await expect(api.saveApiSource({ ...kiro, probeEvidenceToken: 'renderer-invented' })).rejects.toThrow(/evidence is invalid/i)
    const saved = await api.saveApiSource(kiro)
    const provider = saved.providers.find((candidate) => candidate.name === kiro.name)
    expect(provider?.models).toEqual(['claude-sonnet'])
    expect(provider?.toolRoundtripVerified).toBe(false)
  })

  it('selects mock discovery defaults from the protocol', async () => {
    const api = createMockApi()
    const result = await api.probeApiSource({
      name: 'Custom Anthropic',
      sourceType: 'relay',
      kind: 'custom',
      baseUrl: 'https://relay.example/v1',
      protocol: 'anthropic-messages',
      credential: 'secret',
    })
    expect(result.models[0]).toMatch(/^claude-/)
    expect(result.ok).toBe(true)
  })

  it('also fails closed for Anthropic-compatible tool roundtrips', async () => {
    const api = createMockApi()
    const result = await api.probeApiSource({
      name: 'Anthropic relay',
      sourceType: 'relay',
      kind: 'anthropic-compatible',
      baseUrl: 'https://relay.example/v1',
      protocol: 'anthropic-messages',
      credential: 'secret',
      model: 'claude-sonnet',
    })
    expect(result.ok).toBe(false)
    expect(result.probeEvidenceToken).toBeUndefined()
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })
  })
})
