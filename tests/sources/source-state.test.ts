import { describe, expect, it, vi } from 'vitest'
import type {
  AggregateRelayInput,
  ApiSourceInput,
  GatewaySettings,
  Pool,
  Protocol,
  ResponsesCompactMode
} from '../../src/shared/types'
import type { PersistedState } from '../../src/main/store/types'
import {
  deleteApiSourceDraft,
  saveAggregateRelayDraft,
  saveApiSourceDraft,
  setRouteSourceFastModeDraft,
  SourcePoolCompatibilityError
} from '../../src/main/sources/source-state'

const NOW = 1_800_000_000_000

describe('API source state changes', () => {
  it('creates one locked official provider, one API-key account and one encrypted credential', () => {
    const state = emptyState()
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)

    const saved = saveApiSourceDraft(state, sourceInput({
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://not-openai.example/v9',
      protocol: 'openai-responses',
      credential: 'sk-new-source-1234',
      models: ['gpt-secondary', 'gpt-secondary'],
      defaultModel: 'gpt-primary'
    }), encrypt, NOW)

    expect(saved).toMatchObject({ created: true, credentialChanged: true, connectionChanged: true })
    expect(state.providers).toEqual([expect.objectContaining({
      id: saved.providerId,
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: ['gpt-primary', 'gpt-secondary'],
      createdAt: NOW,
      updatedAt: NOW
    })])
    expect(state.accounts).toEqual([expect.objectContaining({
      id: saved.accountId,
      providerId: saved.providerId,
      credentialId: saved.credentialId,
      credentialType: 'api-key',
      maskedCredential: '****1234',
      status: 'active',
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-primary'],
      availableModels: [],
      circuitState: 'closed'
    })])
    expect(state.credentials).toEqual({ [saved.credentialId]: 'encrypted:sk-new-source-1234' })
    expect(encrypt).toHaveBeenCalledExactlyOnceWith('sk-new-source-1234')
  })

  it('retains a successful capability probe supplied with a newly tested source', () => {
    const state = emptyState()
    saveApiSourceDraft(state, relayInput({
      credential: 'relay-key',
      models: ['gpt-tested'],
      capabilityProfile: {
        version: 1, origin: 'probed', checkedAt: NOW - 1,
        nonStreaming: true, streaming: false, toolCalls: false,
      },
      modelCatalog: [{ id: 'gpt-tested', capabilities: { nonStreaming: true, toolCalls: false } }],
    }), (value) => `encrypted:${value}`, NOW)

    expect(state.providers[0].capabilityProfile).toMatchObject({
      origin: 'probed', checkedAt: NOW - 1, nonStreaming: true, streaming: false, toolCalls: false,
    })
    expect(state.providers[0].modelCatalog).toContainEqual(expect.objectContaining({
      id: 'gpt-tested', capabilities: expect.objectContaining({ nonStreaming: true, toolCalls: false }),
    }))
  })

  it('accepts xAI-compatible relays on both OpenAI protocols and rejects official or foreign protocols', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, relayInput({
      name: 'Grok relay',
      kind: 'xai-compatible',
      protocol: 'openai-responses',
      credential: 'xai-key',
      models: ['grok-4']
    }), encrypt, NOW)

    expect(state.providers[0]).toMatchObject({
      id: created.providerId,
      sourceType: 'relay',
      kind: 'xai-compatible',
      protocol: 'openai-responses',
      models: ['grok-4']
    })
    expect(state.providers[0].capabilityProfile).toMatchObject({
      streaming: true,
      nonStreaming: true,
      toolCalls: true
    })

    saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      name: 'Grok relay',
      kind: 'xai-compatible',
      protocol: 'openai-chat',
      credential: ''
    }), encrypt, NOW + 1)
    expect(state.providers[0]).toMatchObject({ kind: 'xai-compatible', protocol: 'openai-chat' })

    expect(() => saveApiSourceDraft(emptyState(), sourceInput({
      sourceType: 'official-api',
      kind: 'xai-compatible',
      protocol: 'openai-chat'
    }), encrypt, NOW)).toThrow(/Official API sources support/)
    expect(() => saveApiSourceDraft(emptyState(), relayInput({
      kind: 'xai-compatible',
      protocol: 'anthropic-messages'
    }), encrypt, NOW)).toThrow(/does not support/)
  })

  it('creates locked official and custom relay DeepSeek Responses sources', () => {
    const encrypt = (value: string) => `encrypted:${value}`
    const officialState = emptyState()
    saveApiSourceDraft(officialState, sourceInput({
      name: 'DeepSeek API',
      sourceType: 'official-api',
      kind: 'deepseek',
      baseUrl: 'https://not-deepseek.example/v9',
      protocol: 'openai-responses',
      credential: 'deepseek-key',
      models: ['deepseek-v4-flash'],
      defaultModel: 'deepseek-v4-flash',
    }), encrypt, NOW)
    expect(officialState.providers[0]).toMatchObject({
      sourceType: 'official-api',
      kind: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai-responses',
      forceFastMode: false,
      capabilityProfile: expect.objectContaining({ compact: false, reasoning: true, parallelToolCalls: true }),
    })

    const relayState = emptyState()
    const relay = saveApiSourceDraft(relayState, relayInput({
      name: 'DeepSeek relay',
      kind: 'deepseek-compatible',
      baseUrl: '10.20.30.40:8080/api',
      protocol: 'openai-responses',
      credential: 'relay-key',
      models: ['deepseek-v4-flash'],
      defaultModel: 'deepseek-v4-flash',
      responsesCompactMode: 'native',
    }), encrypt, NOW)
    expect(relayState.providers[0]).toMatchObject({
      id: relay.providerId,
      sourceType: 'relay',
      kind: 'deepseek-compatible',
      baseUrl: 'http://10.20.30.40:8080/api',
      protocol: 'openai-responses',
      forceFastMode: false,
    })
    expect(relayState.providers[0]).not.toHaveProperty('responsesCompactMode')
    expect(() => setRouteSourceFastModeDraft(relayState, { sourceId: relay.sourceId, enabled: true }, NOW + 1))
      .toThrow(/DeepSeek Responses/)
    expect(() => saveApiSourceDraft(emptyState(), relayInput({
      kind: 'deepseek-compatible',
      protocol: 'openai-chat',
    }), encrypt, NOW)).toThrow(/does not support/)
  })

  it('rejects unsupported models only for the official DeepSeek Responses source', () => {
    const encrypt = (value: string) => `encrypted:${value}`
    expect(() => saveApiSourceDraft(emptyState(), sourceInput({
      name: 'DeepSeek API',
      sourceType: 'official-api',
      kind: 'deepseek',
      protocol: 'openai-responses',
      credential: 'deepseek-key',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-pro',
    }), encrypt, NOW)).toThrow(/currently supports only deepseek-v4-flash/)

    const relayState = emptyState()
    saveApiSourceDraft(relayState, relayInput({
      name: 'Future-compatible DeepSeek relay',
      kind: 'deepseek-compatible',
      protocol: 'openai-responses',
      credential: 'relay-key',
      models: ['deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-pro',
    }), encrypt, NOW)
    expect(relayState.providers[0].models).toEqual(['deepseek-v4-pro'])
  })

  it('creates relay accounts with an open model policy while persisting the selected default first', () => {
    const state = emptyState()
    const saved = saveApiSourceDraft(state, relayInput({
      credential: 'relay-key',
      models: ['model-b', 'model-a', 'model-c'],
      defaultModel: 'model-a',
    }), (value) => `encrypted:${value}`, NOW)

    expect(state.providers.find((provider) => provider.id === saved.providerId)?.models)
      .toEqual(['model-a', 'model-b', 'model-c'])
    expect(state.accounts.find((account) => account.id === saved.accountId)).toMatchObject({
      modelPolicy: 'all',
      modelAllowlist: [],
    })
  })

  it('preserves an existing relay model policy when only its name changes', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, relayInput({
      credential: 'relay-key',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    }), encrypt, NOW)
    Object.assign(state.accounts[0], {
      modelPolicy: 'selected',
      modelAllowlist: ['model-b'],
    })

    const saved = saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      name: 'Renamed relay',
      credential: '',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    }), encrypt, NOW + 1)

    expect(saved.connectionChanged).toBe(false)
    expect(state.accounts[0]).toMatchObject({
      name: 'Renamed relay',
      modelPolicy: 'selected',
      modelAllowlist: ['model-b'],
    })
  })

  it('preserves an explicit relay allowlist across connection edits', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, relayInput({
      credential: 'relay-key',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    }), encrypt, NOW)
    Object.assign(state.accounts[0], {
      modelPolicy: 'selected',
      modelAllowlist: ['model-b'],
    })

    const saved = saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: 'replacement-key',
      baseUrl: 'https://replacement.example/v1',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    }), encrypt, NOW + 1)

    expect(saved.connectionChanged).toBe(true)
    expect(state.accounts[0]).toMatchObject({
      modelPolicy: 'selected',
      modelAllowlist: ['model-b'],
    })
  })

  it('persists Kiro Claude only as an exact-endpoint relay with manual models and unverified tools', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const saved = saveApiSourceDraft(state, kiroRelayInput({
      credential: 'kiro-relay-key',
      baseUrl: 'https://kiro.example.test/custom/generateAssistantResponse/',
    }), encrypt, NOW)

    expect(state.providers[0]).toMatchObject({
      id: saved.providerId,
      sourceType: 'relay',
      kind: 'kiro-compatible',
      protocol: 'kiro-claude',
      baseUrl: 'https://kiro.example.test/custom/generateAssistantResponse/',
      models: ['claude-sonnet-4.5'],
      forceFastMode: false,
      capabilityProfile: {
        origin: 'inferred',
        modelDiscovery: false,
        toolCalls: false,
      },
    })
    expect(state.providers[0]).not.toHaveProperty('responsesCompactMode')
    expect(() => setRouteSourceFastModeDraft(
      state,
      { sourceId: saved.sourceId, enabled: true },
      NOW + 1,
    )).toThrow(/FAST is supported only/)

    expect(() => saveApiSourceDraft(emptyState(), kiroRelayInput({
      credential: 'kiro-key',
      sourceType: 'official-api',
    }), encrypt, NOW)).toThrow(/Official API sources support/)
    expect(() => saveApiSourceDraft(emptyState(), kiroRelayInput({
      credential: 'kiro-key',
      kind: 'custom',
    }), encrypt, NOW)).toThrow(/does not support/)
    expect(() => saveApiSourceDraft(emptyState(), kiroRelayInput({
      credential: 'kiro-key',
      models: [],
      defaultModel: undefined,
    }), encrypt, NOW)).toThrow(/manually configured model/)
    expect(() => saveApiSourceDraft(
      emptyState(),
      withResponsesCompactMode(kiroRelayInput({ credential: 'kiro-key' }), 'native'),
      encrypt,
      NOW,
    )).toThrow(/only for OpenAI Responses relay/)
  })

  it('clears Kiro tool evidence and disables direct and aggregate bindings after model edits', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const first = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro one',
      credential: 'kiro-one',
    }), encrypt, NOW)
    const second = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro two',
      credential: 'kiro-two',
      baseUrl: 'https://kiro-two.example.test/generateAssistantResponse',
    }), encrypt, NOW + 1)
    const aggregate = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: first.accountId, order: 0, weight: 10 },
        { accountId: second.accountId, order: 1, weight: 10 },
      ]),
      protocol: 'kiro-claude',
    }, NOW + 2)
    state.routes.push({
      id: 'kiro-direct', client: 'claude', enabled: true, poolId: first.sourceId,
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'direct-token',
      createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'kiro-aggregate', client: 'claude', enabled: true, poolId: aggregate.poolId,
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'aggregate-token',
      createdAt: NOW, updatedAt: NOW,
    })

    const changed = saveApiSourceDraft(state, kiroRelayInput({
      id: first.sourceId,
      name: 'Kiro one',
      credential: '',
      models: ['claude-opus-4.5'],
      defaultModel: 'claude-opus-4.5',
    }), encrypt, NOW + 3)

    expect(changed.connectionChanged).toBe(true)
    expect(state.providers.find((provider) => provider.id === first.sourceId)?.capabilityProfile)
      .toMatchObject({ origin: 'inferred', toolCalls: false, modelDiscovery: false })
    expect(state.providers.find((provider) => provider.id === first.sourceId)?.capabilityProfile?.checkedAt)
      .toBeUndefined()
    expect(state.pools.find((pool) => pool.id === aggregate.poolId)?.members).toEqual([
      expect.objectContaining({ accountId: first.accountId, enabled: false }),
      expect.objectContaining({ accountId: second.accountId, enabled: true }),
    ])
    expect(state.routes).toEqual([
      expect.objectContaining({ id: 'kiro-direct', enabled: false, poolId: first.sourceId, updatedAt: NOW + 3 }),
      expect.objectContaining({ id: 'kiro-aggregate', enabled: false, poolId: aggregate.poolId, updatedAt: NOW + 3 }),
    ])
  })

  it('invalidates Kiro tool evidence when only the selected default changes within the same catalog', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, verifiedKiroRelayInput({
      credential: 'kiro-key',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
      modelCatalog: [
        { id: 'model-a', capabilities: { toolCalls: true } },
        { id: 'model-b', capabilities: { toolCalls: true } },
      ],
    }), encrypt, NOW)
    state.routes.push({
      id: 'kiro-route', client: 'claude', enabled: true, poolId: created.sourceId,
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'route-token',
      createdAt: NOW, updatedAt: NOW,
    })

    const changed = saveApiSourceDraft(state, kiroRelayInput({
      id: created.sourceId,
      credential: '',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-b',
    }), encrypt, NOW + 1)

    expect(changed.connectionChanged).toBe(true)
    expect(state.providers[0]).toMatchObject({
      models: ['model-b', 'model-a'],
      toolRoundtripVerified: false,
      capabilityProfile: { origin: 'inferred', toolCalls: false },
    })
    expect(state.providers[0].capabilityProfile?.checkedAt).toBeUndefined()
    expect(state.routes[0]).toMatchObject({ enabled: false, updatedAt: NOW + 1 })
  })

  it('invalidates Anthropic relay tool evidence when its selected test model changes', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, verifiedAnthropicRelayInput({
      credential: 'anthropic-key',
    }), encrypt, NOW)

    const changed = saveApiSourceDraft(state, verifiedAnthropicRelayInput({
      id: created.sourceId,
      credential: '',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-b',
    }), encrypt, NOW + 1)

    expect(changed.connectionChanged).toBe(true)
    expect(state.providers[0]).toMatchObject({
      models: ['model-b', 'model-a'],
      toolRoundtripVerified: false,
      capabilityProfile: { origin: 'inferred', toolCalls: false },
    })
    expect(state.providers[0].capabilityProfile?.checkedAt).toBeUndefined()
  })

  it('locks official xAI credentials to the native Responses endpoint', () => {
    const state = emptyState()
    const saved = saveApiSourceDraft(state, sourceInput({
      name: 'Grok account',
      kind: 'xai',
      baseUrl: 'https://untrusted.example/v1',
      protocol: 'openai-responses',
      credential: 'xai-official-key',
      models: ['grok-4'],
    }), (value) => `encrypted:${value}`, NOW)

    expect(state.providers[0]).toMatchObject({
      id: saved.providerId,
      sourceType: 'official-api',
      kind: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai-responses',
    })
    expect(state.accounts[0]).toMatchObject({
      id: saved.accountId,
      credentialType: 'api-key',
      maskedCredential: '****-key',
    })
    expect(() => saveApiSourceDraft(emptyState(), sourceInput({
      name: 'Legacy Grok Chat account',
      kind: 'xai',
      protocol: 'openai-chat',
      credential: 'xai-chat-key',
    }), (value) => `encrypted:${value}`, NOW)).toThrow(/does not support the openai-chat protocol/)
  })

  it('requires a key on create and leaves the state unchanged on failure', () => {
    const state = emptyState()
    const before = structuredClone(state)
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)

    expect(() => saveApiSourceDraft(state, sourceInput({ credential: '  ' }), encrypt, NOW))
      .toThrow('An API Key is required')
    expect(state).toEqual(before)
    expect(encrypt).not.toHaveBeenCalled()
  })

  it('retains the key and health/model state when an edit leaves the key blank', () => {
    const state = emptyState()
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)
    const created = saveApiSourceDraft(state, sourceInput({
      credential: 'first-private-key',
      defaultModel: 'gpt-test'
    }), encrypt, NOW)
    Object.assign(state.accounts[0], {
      status: 'cooldown',
      availableModels: ['gpt-test', 'gpt-next'],
      modelsRefreshedAt: NOW + 5,
      cooldownUntil: NOW + 60_000,
      cooldownReason: 'failure',
      circuitState: 'open',
      consecutiveFailures: 3,
      latencyMs: 450,
      lastError: 'temporary failure'
    })

    const saved = saveApiSourceDraft(state, sourceInput({
      id: created.sourceId,
      name: 'Renamed source',
      credential: '',
      defaultModel: 'gpt-test',
      priority: 7,
      weight: 8,
      maxConcurrency: 9
    }), encrypt, NOW + 100)

    expect(saved).toMatchObject({ created: false, credentialChanged: false, connectionChanged: false })
    expect(encrypt).toHaveBeenCalledTimes(1)
    expect(state.credentials[created.credentialId]).toBe('encrypted:first-private-key')
    expect(state.accounts[0]).toMatchObject({
      id: created.accountId,
      name: 'Renamed source',
      status: 'cooldown',
      availableModels: ['gpt-test', 'gpt-next'],
      modelsRefreshedAt: NOW + 5,
      cooldownUntil: NOW + 60_000,
      circuitState: 'open',
      consecutiveFailures: 3,
      latencyMs: 450,
      lastError: 'temporary failure',
      priority: 7,
      weight: 8,
      maxConcurrency: 9
    })
  })

  it('preserves standalone relay FAST across edits and both OpenAI protocols, then clears it for unsupported protocols', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, relayInput({ credential: 'relay-key' }), encrypt, NOW)
    setRouteSourceFastModeDraft(state, { sourceId: created.sourceId, enabled: true }, NOW + 1)

    saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: '',
      protocol: 'openai-chat'
    }), encrypt, NOW + 2)
    expect(state.providers[0].forceFastMode).toBe(true)

    saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: 'anthropic-key',
      kind: 'anthropic-compatible',
      protocol: 'anthropic-messages'
    }), encrypt, NOW + 3)
    expect(state.providers[0].forceFastMode).toBe(false)
  })

  it('persists only explicit OpenAI Responses relay compact capabilities and preserves them across legacy edits', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const created = saveApiSourceDraft(state, withResponsesCompactMode(
      relayInput({ credential: 'relay-key' }),
      'passthrough'
    ), encrypt, NOW)

    expect(state.providers[0]).toMatchObject({ responsesCompactMode: 'passthrough' })

    const unchanged = saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: '',
      name: 'Edited by an older renderer'
    }), encrypt, NOW + 1)
    expect(unchanged.connectionChanged).toBe(false)
    expect(state.providers[0]).toMatchObject({ responsesCompactMode: 'passthrough' })

    state.providers[0].capabilityProfile = {
      version: 1, origin: 'probed', checkedAt: NOW, streaming: true, compact: true,
    }
    state.providers[0].modelCatalog = [{ id: 'gpt-5.1', capabilities: { compact: true } }]

    Object.assign(state.accounts[0], {
      status: 'cooldown',
      inFlight: 2,
      availableModels: ['gpt-5.1'],
      modelsRefreshedAt: NOW - 500,
      quotaRemaining: 42,
      quotaUnit: 'percent',
      cooldownUntil: NOW + 60_000,
      cooldownReason: 'failure',
      circuitState: 'open',
      consecutiveFailures: 3,
      latencyMs: 875,
      lastUsedAt: NOW - 100,
      lastError: 'temporary upstream failure'
    })
    const changed = saveApiSourceDraft(state, withResponsesCompactMode(relayInput({
      id: created.sourceId,
      credential: ''
    }), 'native'), encrypt, NOW + 2)
    expect(changed.connectionChanged).toBe(false)
    expect(state.providers[0]).toMatchObject({ responsesCompactMode: 'native' })
    expect(state.providers[0].capabilityProfile).toMatchObject({ origin: 'inferred' })
    expect(state.providers[0].capabilityProfile?.checkedAt).toBeUndefined()
    expect(state.providers[0].modelCatalog).not.toContainEqual(expect.objectContaining({
      capabilities: expect.objectContaining({ compact: true }),
    }))
    expect(state.accounts[0]).toMatchObject({
      status: 'cooldown',
      inFlight: 2,
      availableModels: ['gpt-5.1'],
      modelsRefreshedAt: NOW - 500,
      quotaRemaining: 42,
      quotaUnit: 'percent',
      cooldownUntil: NOW + 60_000,
      cooldownReason: 'failure',
      circuitState: 'open',
      consecutiveFailures: 3,
      latencyMs: 875,
      lastUsedAt: NOW - 100,
      lastError: 'temporary upstream failure'
    })

    saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: '',
      protocol: 'openai-chat'
    }), encrypt, NOW + 3)
    expect(state.providers[0]).not.toHaveProperty('responsesCompactMode')
  })

  it('rejects compact modes outside the explicit relay Responses capability boundary', () => {
    const encrypt = (value: string) => `encrypted:${value}`

    expect(() => saveApiSourceDraft(
      emptyState(),
      withResponsesCompactMode(relayInput({ credential: 'relay-key', protocol: 'openai-chat' }), 'native'),
      encrypt,
      NOW
    )).toThrow(/only for OpenAI Responses relay/)

    expect(() => saveApiSourceDraft(
      emptyState(),
      withResponsesCompactMode(sourceInput({ credential: 'official-key' }), 'legacy'),
      encrypt,
      NOW
    )).toThrow(/only for OpenAI Responses relay/)

    expect(() => saveApiSourceDraft(
      emptyState(),
      withResponsesCompactMode(relayInput({ credential: 'relay-key' }), 'future-mode'),
      encrypt,
      NOW
    )).toThrow(/must be auto, legacy, passthrough, or native/)
  })

  it('clears stale health and discovered models when URL, proxy, protocol, kind, or key changes', () => {
    const state = emptyState()
    state.proxies.push({
      id: 'proxy-1', name: 'Proxy', protocol: 'http', host: '127.0.0.1', port: 8080,
      hasPassword: false, status: 'available', createdAt: NOW, updatedAt: NOW
    })
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)
    const created = saveApiSourceDraft(state, relayInput({
      credential: 'old-key-1234',
      baseUrl: 'https://relay-one.example/v1',
      models: ['old-model']
    }), encrypt, NOW)
    Object.assign(state.accounts[0], {
      status: 'cooldown',
      availableModels: ['old-model'],
      modelsRefreshedAt: NOW + 5,
      quotaRemaining: 10,
      quotaUnit: 'requests',
      quota: { observedAt: NOW, requests: { remaining: 10 } },
      cooldownUntil: NOW + 60_000,
      cooldownReason: 'quota',
      circuitState: 'open',
      consecutiveFailures: 4,
      latencyMs: 900,
      lastUsedAt: NOW + 10,
      lastError: 'old failure'
    })
    state.providers[0].capabilityProfile = {
      version: 1, origin: 'probed', checkedAt: NOW, streaming: true, webSearch: true,
    }
    state.providers[0].modelCatalog = [{ id: 'old-model', capabilities: { webSearch: true } }]

    const saved = saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: 'replacement-key-9876',
      baseUrl: 'https://relay-two.example/v1/',
      models: ['new-model'],
      defaultModel: 'new-model',
      proxyId: 'proxy-1',
      // A stale renderer draft must not attach the old probe to the new endpoint.
      capabilityProfile: state.providers[0].capabilityProfile,
      modelCatalog: state.providers[0].modelCatalog,
    }), encrypt, NOW + 100)

    expect(saved).toMatchObject({ credentialChanged: true, connectionChanged: true })
    expect(state.providers[0]).toMatchObject({ baseUrl: 'https://relay-two.example/v1', models: ['new-model'] })
    expect(state.providers[0].capabilityProfile).toMatchObject({ origin: 'inferred' })
    expect(state.providers[0].capabilityProfile?.checkedAt).toBeUndefined()
    expect(state.providers[0].modelCatalog).toEqual([
      expect.objectContaining({ id: 'new-model' }),
    ])
    expect(state.credentials[created.credentialId]).toBe('encrypted:replacement-key-9876')
    expect(state.accounts[0]).toMatchObject({
      status: 'active',
      maskedCredential: '****9876',
      availableModels: [],
      modelPolicy: 'all',
      modelAllowlist: [],
      proxyId: 'proxy-1',
      circuitState: 'closed',
      consecutiveFailures: 0,
      inFlight: 0
    })
    expect(state.accounts[0].modelsRefreshedAt).toBeUndefined()
    expect(state.accounts[0].cooldownUntil).toBeUndefined()
    expect(state.accounts[0].quota).toBeUndefined()
    expect(state.accounts[0].latencyMs).toBeUndefined()
    expect(state.accounts[0].lastUsedAt).toBeUndefined()
    expect(state.accounts[0].lastError).toBeUndefined()
  })

  it('requires incompatible pool membership to be removed before a protocol edit', () => {
    const state = emptyState()
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)
    const created = saveApiSourceDraft(state, relayInput({ credential: 'private-key' }), encrypt, NOW)
    state.pools.push(standardPool('standard-pool', 'openai-responses', [created.accountId]))
    const before = structuredClone(state)

    const error = captureError(() => saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      credential: '',
      protocol: 'openai-chat'
    }), encrypt, NOW + 100))

    expect(error).toBeInstanceOf(SourcePoolCompatibilityError)
    expect((error as SourcePoolCompatibilityError).poolIds).toEqual(['standard-pool'])
    expect(state).toEqual(before)
    expect(encrypt).toHaveBeenCalledTimes(1)
  })

  it('requires incompatible pool membership to be removed before crossing the relay trust boundary', () => {
    const state = emptyState()
    const encrypt = vi.fn((value: string) => `encrypted:${value}`)
    const created = saveApiSourceDraft(state, sourceInput({
      sourceType: 'official-api', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses', credential: 'official-key',
    }), encrypt, NOW)
    state.pools.push(standardPool('standard-pool', 'openai-responses', [created.accountId]))
    const before = structuredClone(state)

    const error = captureError(() => saveApiSourceDraft(state, relayInput({
      id: created.sourceId,
      protocol: 'openai-responses',
      credential: 'relay-key',
    }), encrypt, NOW + 100))

    expect(error).toBeInstanceOf(SourcePoolCompatibilityError)
    expect((error as SourcePoolCompatibilityError).poolIds).toEqual(['standard-pool'])
    expect(state).toEqual(before)
  })

  it('locks official vendors to their canonical endpoint and protocol matrix', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const anthropic = saveApiSourceDraft(state, sourceInput({
      sourceType: 'official-api',
      kind: 'anthropic',
      baseUrl: 'http://127.0.0.1:9999',
      protocol: 'anthropic-messages',
      credential: 'anthropic-key'
    }), encrypt, NOW)
    expect(state.providers.find((provider) => provider.id === anthropic.sourceId)?.baseUrl)
      .toBe('https://api.anthropic.com')

    expect(() => saveApiSourceDraft(state, sourceInput({
      sourceType: 'official-api',
      kind: 'anthropic',
      protocol: 'openai-chat',
      credential: 'bad-key'
    }), encrypt, NOW + 1)).toThrow('does not support')
    expect(() => saveApiSourceDraft(state, sourceInput({
      sourceType: 'relay',
      kind: 'openai',
      credential: 'bad-key'
    }), encrypt, NOW + 1)).toThrow('compatible or custom')
  })

  it('accepts plaintext remote relays and normalizes bare IP endpoints', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const remote = saveApiSourceDraft(state, relayInput({
      name: 'Remote HTTP relay',
      baseUrl: 'http://relay.example.test:8080/v1',
    }), encrypt, NOW)
    const bareIp = saveApiSourceDraft(state, relayInput({
      name: 'Bare IP relay',
      baseUrl: '10.20.30.40:9000/v1',
    }), encrypt, NOW + 1)

    expect(state.providers.find((provider) => provider.id === remote.providerId)?.baseUrl)
      .toBe('http://relay.example.test:8080/v1')
    expect(state.providers.find((provider) => provider.id === bareIp.providerId)?.baseUrl)
      .toBe('http://10.20.30.40:9000/v1')
  })

  it('cascades deletion through credentials and members, removing invalid aggregates safely', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const first = saveApiSourceDraft(state, relayInput({ name: 'First', credential: 'first-key' }), encrypt, NOW)
    const second = saveApiSourceDraft(state, relayInput({ name: 'Second', credential: 'second-key' }), encrypt, NOW + 1)
    state.pools.push(standardPool('standard-pool', 'openai-responses', [first.accountId, second.accountId]))
    const aggregate = saveAggregateRelayDraft(state, aggregateInput([
      { accountId: first.accountId, order: 0, weight: 10 },
      { accountId: second.accountId, order: 1, weight: 20 }
    ]), NOW + 2)
    state.routes.push({
      id: 'route-1', client: 'codex', enabled: true, poolId: aggregate.poolId,
      inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'preserved-token',
      createdAt: NOW, updatedAt: NOW
    }, {
      id: 'route-direct', client: 'codex', enabled: true, poolId: first.sourceId,
      inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'direct-token',
      createdAt: NOW, updatedAt: NOW
    })

    const deleted = deleteApiSourceDraft(state, first.sourceId, NOW + 3)

    expect(deleted).toEqual({
      sourceId: first.sourceId,
      accountIds: [first.accountId],
      deletedAggregatePoolIds: [aggregate.poolId]
    })
    expect(state.providers.some((provider) => provider.id === first.sourceId)).toBe(false)
    expect(state.accounts.some((account) => account.id === first.accountId)).toBe(false)
    expect(state.credentials).not.toHaveProperty(first.credentialId)
    expect(state.credentials).toHaveProperty(second.credentialId)
    expect(state.pools.find((pool) => pool.id === 'standard-pool')?.members)
      .toEqual([{ accountId: second.accountId, enabled: true }])
    expect(state.pools.some((pool) => pool.id === aggregate.poolId)).toBe(false)
    expect(state.routes[0]).toMatchObject({
      enabled: false,
      poolId: '',
      localToken: 'preserved-token',
      updatedAt: NOW + 3
    })
    expect(state.routes[1]).toMatchObject({
      enabled: false,
      poolId: '',
      localToken: 'direct-token',
      updatedAt: NOW + 3
    })
  })
})

describe('aggregate relay state changes', () => {
  it('requires verified Kiro Claude members and forces sticky sessions', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const unverified = saveApiSourceDraft(state, kiroRelayInput({
      name: 'Unverified Kiro', credential: 'unverified-key',
    }), encrypt, NOW)
    const verified = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Verified Kiro', credential: 'verified-key',
      baseUrl: 'https://verified.example.test/generateAssistantResponse',
    }), encrypt, NOW + 1)

    expect(() => saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: unverified.accountId, order: 0, weight: 10 },
        { accountId: verified.accountId, order: 1, weight: 10 },
      ]),
      protocol: 'kiro-claude',
      stickySessions: false,
    }, NOW + 2)).toThrow(/two-turn tool probe/)
    expect(state.pools).toHaveLength(0)

    const second = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Second verified Kiro', credential: 'second-key',
      baseUrl: 'https://second.example.test/generateAssistantResponse',
    }), encrypt, NOW + 2)
    const saved = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: verified.accountId, order: 0, weight: 10 },
        { accountId: second.accountId, order: 1, weight: 10 },
      ]),
      protocol: 'kiro-claude',
      stickySessions: false,
    }, NOW + 3)

    expect(state.pools.find((pool) => pool.id === saved.poolId)).toMatchObject({
      protocol: 'kiro-claude',
      stickySessions: true,
      forceFastMode: false,
    })
  })

  it('keeps the binding id but disables routes when a Kiro aggregate changes protocol', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const firstKiro = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro one', credential: 'kiro-one',
    }), encrypt, NOW)
    const secondKiro = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro two', credential: 'kiro-two',
      baseUrl: 'https://kiro-two.example.test/generateAssistantResponse',
    }), encrypt, NOW + 1)
    const firstOpenAi = saveApiSourceDraft(state, relayInput({
      name: 'OpenAI one', credential: 'openai-one',
    }), encrypt, NOW + 2)
    const secondOpenAi = saveApiSourceDraft(state, relayInput({
      name: 'OpenAI two', credential: 'openai-two',
    }), encrypt, NOW + 3)
    const aggregate = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: firstKiro.accountId, order: 0, weight: 10 },
        { accountId: secondKiro.accountId, order: 1, weight: 10 },
      ]),
      protocol: 'kiro-claude',
    }, NOW + 4)
    state.routes.push({
      id: 'kiro-route', client: 'claude', enabled: true, poolId: aggregate.poolId,
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'preserved-token',
      createdAt: NOW, updatedAt: NOW,
    })

    const edited = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: firstOpenAi.accountId, order: 0, weight: 10 },
        { accountId: secondOpenAi.accountId, order: 1, weight: 10 },
      ]),
      id: aggregate.poolId,
      protocol: 'openai-responses',
    }, NOW + 5)

    expect(edited).toEqual({ poolId: aggregate.poolId, created: false })
    expect(state.pools.find((pool) => pool.id === aggregate.poolId)).toMatchObject({
      id: aggregate.poolId,
      protocol: 'openai-responses',
    })
    expect(state.routes[0]).toMatchObject({
      id: 'kiro-route',
      enabled: false,
      poolId: aggregate.poolId,
      localToken: 'preserved-token',
      updatedAt: NOW + 5,
    })
  })

  it('disables a bound Kiro aggregate only when member identity changes', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const first = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro one', credential: 'kiro-one',
    }), encrypt, NOW)
    const second = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro two', credential: 'kiro-two',
      baseUrl: 'https://kiro-two.example.test/generateAssistantResponse',
    }), encrypt, NOW + 1)
    const third = saveApiSourceDraft(state, verifiedKiroRelayInput({
      name: 'Kiro three', credential: 'kiro-three',
      baseUrl: 'https://kiro-three.example.test/generateAssistantResponse',
    }), encrypt, NOW + 2)
    const aggregate = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: first.accountId, order: 0, weight: 10 },
        { accountId: second.accountId, order: 1, weight: 10 },
      ]),
      protocol: 'kiro-claude',
    }, NOW + 3)
    state.routes.push({
      id: 'kiro-route', client: 'claude', enabled: true, poolId: aggregate.poolId,
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'route-token',
      createdAt: NOW, updatedAt: NOW,
    })

    saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: second.accountId, order: 0, weight: 50 },
        { accountId: first.accountId, order: 1, weight: 5 },
      ]),
      id: aggregate.poolId,
      protocol: 'kiro-claude',
    }, NOW + 4)
    expect(state.routes[0]).toMatchObject({ enabled: true, updatedAt: NOW })

    saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: first.accountId, order: 0, weight: 10 },
        { accountId: third.accountId, order: 1, weight: 10 },
      ]),
      id: aggregate.poolId,
      protocol: 'kiro-claude',
    }, NOW + 5)
    expect(state.routes[0]).toMatchObject({
      enabled: false,
      poolId: aggregate.poolId,
      updatedAt: NOW + 5,
    })
  })

  it.each(['priority', 'round-robin', 'weighted-round-robin'] as const)(
    'persists ordered, independently weighted members for %s',
    (strategy) => {
      const state = emptyState()
      const encrypt = (value: string) => `encrypted:${value}`
      const first = saveApiSourceDraft(state, relayInput({ name: 'First', credential: 'first-key' }), encrypt, NOW)
      const second = saveApiSourceDraft(state, relayInput({ name: 'Second', credential: 'second-key' }), encrypt, NOW + 1)
      const third = saveApiSourceDraft(state, relayInput({ name: 'Third', credential: 'third-key' }), encrypt, NOW + 2)

      const saved = saveAggregateRelayDraft(state, {
        ...aggregateInput([
          { accountId: first.accountId, order: 20, weight: 30 },
          { accountId: second.accountId, order: 0, weight: 10 },
          { accountId: third.accountId, order: 10, weight: 20 }
        ]),
        strategy
      }, NOW + 3)

      expect(saved.created).toBe(true)
      expect(state.pools).toEqual([expect.objectContaining({
        id: saved.poolId,
        kind: 'relay-aggregate',
        strategy,
        protocol: 'openai-responses',
        modelPolicy: 'all',
        modelAllowlist: [],
        members: [
          { accountId: second.accountId, enabled: true, order: 0, weight: 10 },
          { accountId: third.accountId, enabled: true, order: 1, weight: 20 },
          { accountId: first.accountId, enabled: true, order: 2, weight: 30 }
        ]
      })])
    }
  )

  it('edits in place and preserves the aggregate identity and creation time', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const first = saveApiSourceDraft(state, relayInput({ name: 'First', credential: 'first-key' }), encrypt, NOW)
    const second = saveApiSourceDraft(state, relayInput({ name: 'Second', credential: 'second-key' }), encrypt, NOW + 1)
    const created = saveAggregateRelayDraft(state, aggregateInput([
      { accountId: first.accountId, order: 0, weight: 10 },
      { accountId: second.accountId, order: 1, weight: 20 }
    ]), NOW + 2)
    setRouteSourceFastModeDraft(state, { sourceId: created.poolId, enabled: true }, NOW + 3)

    const edited = saveAggregateRelayDraft(state, {
      ...aggregateInput([
        { accountId: second.accountId, order: 0, weight: 50 },
        { accountId: first.accountId, order: 1, weight: 5 }
      ]),
      id: created.poolId,
      name: 'Edited aggregate',
      strategy: 'weighted-round-robin'
    }, NOW + 100)

    expect(edited).toEqual({ poolId: created.poolId, created: false })
    expect(state.pools).toHaveLength(1)
    expect(state.pools[0]).toMatchObject({
      id: created.poolId,
      name: 'Edited aggregate',
      createdAt: NOW + 2,
      updatedAt: NOW + 100,
      strategy: 'weighted-round-robin',
      forceFastMode: true,
      members: [
        { accountId: second.accountId, order: 0, weight: 50 },
        { accountId: first.accountId, order: 1, weight: 5 }
      ]
    })
  })

  it('rejects fewer than two, duplicate, OAuth, and mixed-protocol members atomically', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const responses = saveApiSourceDraft(state, relayInput({ name: 'Responses', credential: 'responses-key' }), encrypt, NOW)
    const chat = saveApiSourceDraft(state, relayInput({
      name: 'Chat', credential: 'chat-key', protocol: 'openai-chat'
    }), encrypt, NOW + 1)
    const oauthProviderId = 'oauth-provider'
    state.providers.push({
      id: oauthProviderId, name: 'OAuth', sourceType: 'oauth-system', kind: 'openai',
      baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: [],
      createdAt: NOW, updatedAt: NOW
    })
    state.accounts.push({
      id: 'oauth-account', providerId: oauthProviderId, name: 'OAuth', credentialId: 'oauth-credential',
      maskedCredential: 'oauth-****', credentialType: 'chatgpt-oauth', status: 'active', priority: 1,
      weight: 1, maxConcurrency: 1, inFlight: 0, availableModels: [], modelPolicy: 'all',
      modelAllowlist: [], circuitState: 'closed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW
    })
    state.credentials['oauth-credential'] = 'encrypted-oauth'
    const before = structuredClone(state)

    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: responses.accountId, order: 0, weight: 10 }
    ]), NOW + 2)).toThrow('at least two')
    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: responses.accountId, order: 0, weight: 10 },
      { accountId: responses.accountId, order: 1, weight: 10 }
    ]), NOW + 2)).toThrow('unique')
    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: responses.accountId, order: 0, weight: 10 },
      { accountId: 'oauth-account', order: 1, weight: 10 }
    ]), NOW + 2)).toThrow('OAuth')
    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: responses.accountId, order: 0, weight: 10 },
      { accountId: chat.accountId, order: 1, weight: 10 }
    ]), NOW + 2)).toThrow('aggregate protocol')
    expect(state).toEqual(before)
  })

  it('rejects mixed OpenAI and Grok aggregate members atomically', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const openai = saveApiSourceDraft(state, relayInput({
      name: 'OpenAI relay', credential: 'openai-key', kind: 'openai-compatible'
    }), encrypt, NOW)
    const grok = saveApiSourceDraft(state, relayInput({
      name: 'Grok relay', credential: 'grok-key', kind: 'xai-compatible'
    }), encrypt, NOW + 1)
    const before = structuredClone(state)

    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: openai.accountId, order: 0, weight: 10 },
      { accountId: grok.accountId, order: 1, weight: 10 },
    ]), NOW + 2)).toThrow(/same source family/)
    expect(state).toEqual(before)
  })

  it('rejects official API members from aggregate relays atomically', () => {
    const state = emptyState()
    const encrypt = (value: string) => `encrypted:${value}`
    const first = saveApiSourceDraft(state, sourceInput({ name: 'Official one', credential: 'key-one' }), encrypt, NOW)
    const second = saveApiSourceDraft(state, sourceInput({ name: 'Official two', credential: 'key-two' }), encrypt, NOW + 1)
    const before = structuredClone(state)

    expect(() => saveAggregateRelayDraft(state, aggregateInput([
      { accountId: first.accountId, order: 0, weight: 10 },
      { accountId: second.accountId, order: 1, weight: 10 },
    ]), NOW + 2)).toThrow(/relay API-key sources/)
    expect(state).toEqual(before)
  })
})

describe('route source FAST state changes', () => {
  it('toggles standard and aggregate pools atomically', () => {
    const state = emptyState()
    state.pools.push(
      standardPool('standard', 'openai-chat', ['account']),
      { ...standardPool('aggregate', 'openai-responses', ['first', 'second']), kind: 'relay-aggregate' }
    )

    expect(setRouteSourceFastModeDraft(state, { sourceId: 'standard', enabled: true }, NOW + 1))
      .toEqual({ sourceId: 'standard', enabled: true, target: 'pool' })
    expect(setRouteSourceFastModeDraft(state, { sourceId: 'aggregate', enabled: true }, NOW + 2))
      .toEqual({ sourceId: 'aggregate', enabled: true, target: 'pool' })
    expect(state.pools.map((pool) => pool.forceFastMode)).toEqual([true, true])

    setRouteSourceFastModeDraft(state, { sourceId: 'standard', enabled: false }, NOW + 3)
    expect(state.pools[0].forceFastMode).toBe(false)
  })

  it('rejects unsupported, official, OAuth, missing, and colliding sources without mutation', () => {
    const state = emptyState()
    state.pools.push(standardPool('anthropic-pool', 'anthropic-messages', ['account']))
    state.providers.push(
      {
        id: 'official', name: 'Official', sourceType: 'official-api', kind: 'openai',
        baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: [],
        createdAt: NOW, updatedAt: NOW
      },
      {
        id: 'oauth', name: 'OAuth', sourceType: 'oauth-system', kind: 'openai',
        baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: [],
        createdAt: NOW, updatedAt: NOW
      },
      {
        id: 'collision', name: 'Relay', sourceType: 'relay', kind: 'openai-compatible',
        baseUrl: 'https://relay.example/v1', protocol: 'openai-responses', models: [],
        createdAt: NOW, updatedAt: NOW
      }
    )
    state.pools.push(standardPool('collision', 'openai-responses', ['account']))
    const before = structuredClone(state)

    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'anthropic-pool', enabled: true }, NOW + 1))
      .toThrow(/only by OpenAI Responses and OpenAI Chat/)
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'official', enabled: true }, NOW + 1))
      .toThrow(/only for relay sources/)
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'oauth', enabled: true }, NOW + 1))
      .toThrow(/OAuth/)
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'missing', enabled: true }, NOW + 1))
      .toThrow(/not found/)
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'collision', enabled: true }, NOW + 1))
      .toThrow(/conflicts/)
    expect(state).toEqual(before)

    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'anthropic-pool', enabled: false }, NOW + 2))
      .not.toThrow()
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'official', enabled: false }, NOW + 3))
      .toThrow(/only for relay sources/)
    expect(() => setRouteSourceFastModeDraft(state, { sourceId: 'oauth', enabled: false }, NOW + 4))
      .toThrow(/OAuth/)
  })
})

function sourceInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return {
    name: 'Official source',
    sourceType: 'official-api',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    credential: 'test-key',
    models: [],
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    ...overrides
  }
}

function relayInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return sourceInput({
    name: 'Relay source',
    sourceType: 'relay',
    kind: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    protocol: 'openai-responses',
    ...overrides
  })
}

function kiroRelayInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return relayInput({
    name: 'Kiro Claude relay',
    kind: 'kiro-compatible',
    baseUrl: 'https://kiro.example.test/generateAssistantResponse/',
    protocol: 'kiro-claude',
    models: ['claude-sonnet-4.5'],
    defaultModel: 'claude-sonnet-4.5',
    ...overrides,
  })
}

function verifiedKiroRelayInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return kiroRelayInput({
    toolRoundtripVerified: true,
    capabilityProfile: {
      version: 1,
      origin: 'probed',
      checkedAt: NOW - 1,
      streaming: true,
      nonStreaming: true,
      toolCalls: true,
      modelDiscovery: false,
    },
    modelCatalog: [{
      id: 'claude-sonnet-4.5',
      capabilities: { streaming: true, nonStreaming: true, toolCalls: true, modelDiscovery: false },
    }],
    ...overrides,
  })
}

function verifiedAnthropicRelayInput(overrides: Partial<ApiSourceInput> = {}): ApiSourceInput {
  return relayInput({
    name: 'Anthropic relay',
    kind: 'anthropic-compatible',
    baseUrl: 'https://anthropic-relay.example.test',
    protocol: 'anthropic-messages',
    models: ['model-a', 'model-b'],
    defaultModel: 'model-a',
    toolRoundtripVerified: true,
    capabilityProfile: {
      version: 1,
      origin: 'probed',
      checkedAt: NOW - 1,
      streaming: true,
      nonStreaming: true,
      toolCalls: true,
    },
    modelCatalog: [
      { id: 'model-a', capabilities: { streaming: true, nonStreaming: true, toolCalls: true } },
      { id: 'model-b', capabilities: { streaming: true, nonStreaming: true, toolCalls: true } },
    ],
    ...overrides,
  })
}

function withResponsesCompactMode(
  input: ApiSourceInput,
  mode: ResponsesCompactMode | 'future-mode'
): ApiSourceInput {
  return { ...input, responsesCompactMode: mode } as ApiSourceInput
}

function aggregateInput(members: AggregateRelayInput['members']): AggregateRelayInput {
  return {
    name: 'Aggregate relay',
    protocol: 'openai-responses',
    strategy: 'priority',
    members,
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2
  }
}

function standardPool(id: string, protocol: Protocol, accountIds: string[]): Pool {
  return {
    id,
    name: id,
    kind: 'standard',
    protocol,
    strategy: 'balanced',
    members: accountIds.map((accountId) => ({ accountId, enabled: true })),
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function emptyState(): PersistedState {
  const gateway: GatewaySettings = {
    host: '127.0.0.1',
    port: 15721,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 120
  }
  return {
    version: 1,
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    gateway,
    requestLogs: [],
    credentials: {},
    clientProfiles: [],
    healthEvents: []
  }
}

function captureError(action: () => unknown): unknown {
  try {
    action()
    return undefined
  } catch (error) {
    return error
  }
}
