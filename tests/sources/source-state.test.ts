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
      credential: '',
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
    )).toThrow(/must be legacy, passthrough, or native/)
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
      modelPolicy: 'selected',
      modelAllowlist: ['new-model'],
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
