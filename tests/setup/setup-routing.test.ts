import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../src/main/store/types'
import { applySetupRoutingDraft } from '../../src/main/setup/setup-routing'

function state(): PersistedState {
  const now = 1
  return {
    version: 1,
    providers: [{ id: 'oauth-provider', name: 'OAuth', sourceType: 'oauth-system', kind: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: ['gpt-test'], createdAt: now, updatedAt: now }],
    accounts: ['one', 'two'].map((id) => ({ id, providerId: 'oauth-provider', name: id, credentialId: `credential-${id}`, maskedCredential: '****', credentialType: 'chatgpt-oauth' as const, status: 'active' as const, priority: 10, weight: 10, maxConcurrency: 4, inFlight: 0, availableModels: ['gpt-test'], modelPolicy: 'all' as const, modelAllowlist: [], createdAt: now, updatedAt: now })),
    accountTags: [], proxies: [], pools: [], routes: [],
    gateway: { host: '127.0.0.1', port: 15721, autoStart: false, logPayloads: false, requestTimeoutSeconds: 120 },
    requestLogs: [], credentials: {}, clientProfiles: [], healthEvents: [],
  }
}

describe('setup routing transaction', () => {
  it('creates a balanced OAuth pool and preserves the route token on retry', () => {
    const draft = state()
    const first = applySetupRoutingDraft(draft, { sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test' }, { now: 10 })
    expect(first.createdPool).toBe(true)
    expect(draft.pools[0].members).toHaveLength(2)
    expect(draft.pools[0].strategy).toBe('balanced')
    const token = draft.routes[0].localToken
    const second = applySetupRoutingDraft(draft, { sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test' }, { now: 20 })
    expect(second).toMatchObject({ poolId: first.poolId, routeId: first.routeId, createdPool: false })
    expect(draft.routes[0].localToken).toBe(token)
  })

  it('preserves high-concurrency mode when the wizard reuses an existing route', () => {
    const draft = state()
    applySetupRoutingDraft(draft, { sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test' }, { now: 10 })
    draft.routes[0].highConcurrencyMode = true

    applySetupRoutingDraft(draft, { sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test' }, { now: 20 })

    expect(draft.routes[0].highConcurrencyMode).toBe(true)
  })

  it('reuses a compatible import target pool', () => {
    const draft = state()
    draft.pools.push({ id: 'import-pool', name: 'Imported', kind: 'standard', protocol: 'openai-responses', strategy: 'priority', members: [{ accountId: 'one', enabled: true }], modelPolicy: 'all', modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 60, maxRetries: 0, createdAt: 1, updatedAt: 1 })
    const result = applySetupRoutingDraft(draft, { sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test' }, { preferredPoolId: 'import-pool' })
    expect(result).toMatchObject({ poolId: 'import-pool', createdPool: false })
  })

  it('maps Codex aliases to the only xAI relay model across the protocol bridge', () => {
    const draft = state()
    draft.providers[0] = {
      ...draft.providers[0],
      sourceType: 'relay',
      kind: 'xai-compatible',
      protocol: 'openai-chat',
      models: ['grok-4.20'],
    }
    draft.accounts.forEach((account) => {
      account.credentialType = 'api-key'
      account.availableModels = ['grok-4.20']
    })

    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'grok-4.20',
    })

    expect(draft.routes[0].modelMap).toEqual({ '*': 'grok-4.20' })
    expect(draft.pools[0].protocol).toBe('grok')
  })

  it('connects Grok Build directly to a native Grok Responses account pool', () => {
    const draft = state()
    draft.providers[0] = {
      ...draft.providers[0],
      sourceType: 'oauth-system',
      kind: 'xai',
      protocol: 'openai-responses',
      models: ['grok-4.5'],
    }
    draft.accounts.forEach((account) => {
      account.credentialType = 'grok-oauth'
      account.availableModels = ['grok-4.5']
    })

    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'grokbuild', model: 'grok-4.5',
    })

    expect(draft.routes[0]).toMatchObject({
      client: 'grokbuild',
      inboundProtocol: 'openai-responses',
      modelMap: {},
    })
    expect(draft.pools[0]).toMatchObject({ protocol: 'grok' })
  })

  it('rejects Chat-compatible Grok relays for Grok Build before creating a route', () => {
    const draft = state()
    draft.providers[0] = {
      ...draft.providers[0],
      sourceType: 'relay',
      kind: 'xai-compatible',
      protocol: 'openai-chat',
      models: ['grok-4.5'],
    }
    draft.accounts.forEach((account) => {
      account.credentialType = 'api-key'
      account.availableModels = ['grok-4.5']
    })

    expect(() => applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'grokbuild', model: 'grok-4.5',
    })).toThrow(/OpenAI Responses/)
    expect(draft.routes).toEqual([])
    expect(draft.pools).toEqual([])
  })

  it('allows DeepSeek Responses only for Codex and DeepSeek Harness routes', () => {
    const codexDraft = state()
    codexDraft.providers[0] = {
      ...codexDraft.providers[0],
      sourceType: 'official-api',
      kind: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai-responses',
      models: ['deepseek-v4-flash'],
    }
    codexDraft.accounts.forEach((account) => {
      account.credentialType = 'api-key'
      account.availableModels = ['deepseek-v4-flash']
    })
    applySetupRoutingDraft(codexDraft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'deepseek-v4-flash',
    })
    expect(codexDraft.routes[0]).toMatchObject({
      client: 'codex',
      inboundProtocol: 'openai-responses',
      modelMap: {},
    })

    const harnessDraft = state()
    harnessDraft.providers[0] = { ...codexDraft.providers[0] }
    harnessDraft.accounts.forEach((account) => {
      account.credentialType = 'api-key'
      account.availableModels = ['deepseek-v4-flash']
    })
    applySetupRoutingDraft(harnessDraft, {
      sessionId: 'session', sourceId: 'one', client: 'deepseek-harness', model: 'deepseek-v4-flash',
    })
    expect(harnessDraft.routes[0]).toMatchObject({
      client: 'deepseek-harness',
      inboundProtocol: 'openai-responses',
      modelMap: {},
    })

    for (const client of ['claude', 'gemini', 'grokbuild'] as const) {
      const rejected = state()
      rejected.providers[0] = { ...codexDraft.providers[0] }
      rejected.accounts.forEach((account) => {
        account.credentialType = 'api-key'
        account.availableModels = ['deepseek-v4-flash']
      })
      expect(() => applySetupRoutingDraft(rejected, {
        sessionId: 'session', sourceId: 'one', client, model: 'deepseek-v4-flash',
      })).toThrow(/DeepSeek/)
      expect(rejected.routes).toEqual([])
      expect(rejected.pools).toEqual([])
    }
  })

  it('maps Codex aliases to the only Claude model across the protocol bridge', () => {
    const draft = state()
    draft.providers[0] = {
      ...draft.providers[0], kind: 'anthropic', protocol: 'anthropic-messages', models: ['claude-opus-4-8'],
    }
    draft.accounts.forEach((account) => { account.availableModels = ['claude-opus-4-8'] })
    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'claude-opus-4-8',
    })
    expect(draft.routes[0].modelMap).toEqual({ '*': 'claude-opus-4-8' })
  })

  it('maps Claude aliases to the only OpenAI model across the protocol bridge', () => {
    const draft = state()
    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'claude', model: 'gpt-test',
    })
    expect(draft.routes[0].modelMap).toEqual({ '*': 'gpt-test' })
  })

  it('does not generate a fallback for same-protocol or ambiguous cross-protocol sources', () => {
    const nativeDraft = state()
    applySetupRoutingDraft(nativeDraft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test',
    })
    expect(nativeDraft.routes[0].modelMap).toEqual({})

    const ambiguousDraft = state()
    ambiguousDraft.providers[0] = {
      ...ambiguousDraft.providers[0],
      kind: 'anthropic',
      protocol: 'anthropic-messages',
      models: ['claude-opus-4-8', 'claude-sonnet-5'],
    }
    ambiguousDraft.accounts.forEach((account) => {
      account.availableModels = ['claude-opus-4-8', 'claude-sonnet-5']
    })
    applySetupRoutingDraft(ambiguousDraft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'claude-opus-4-8',
    })
    expect(ambiguousDraft.routes[0].modelMap).toEqual({})

    const advisoryDraft = state()
    advisoryDraft.providers[0] = {
      ...advisoryDraft.providers[0],
      kind: 'anthropic',
      protocol: 'anthropic-messages',
      models: ['claude-opus-4-8'],
    }
    applySetupRoutingDraft(advisoryDraft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'claude-sonnet-5',
    })
    expect(advisoryDraft.routes[0].modelMap).toEqual({})
  })

  it('preserves explicit mappings and never replaces an explicit wildcard', () => {
    const draft = state()
    draft.providers[0] = {
      ...draft.providers[0], kind: 'anthropic', protocol: 'anthropic-messages', models: ['claude-opus-4-8'],
    }
    draft.accounts.forEach((account) => { account.availableModels = ['claude-opus-4-8'] })
    draft.routes.push({
      id: 'codex-route', client: 'codex', enabled: true, poolId: 'old-pool',
      inboundProtocol: 'openai-responses',
      modelMap: { exact: 'explicit-model', '*': 'explicit-default' },
      localToken: 'stable-token', createdAt: 1, updatedAt: 1,
    })

    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'claude-opus-4-8',
    })

    expect(draft.routes[0].modelMap).toEqual({ exact: 'explicit-model', '*': 'explicit-default' })
  })

  it('mixes eligible OAuth and Agent Identity peers but excludes unsupported members', () => {
    const draft = state()
    draft.accounts[1].credentialType = 'chatgpt-agent-identity'
    draft.accounts.push({
      ...draft.accounts[1], id: 'unsupported', credentialId: 'credential-unsupported',
      availableModels: ['other-model'], modelsRefreshedAt: 2,
    })
    draft.providers[0].capabilityProfile = { version: 1, origin: 'probed', nonStreaming: true }

    applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test',
    })
    expect(draft.pools[0].members.map((member) => member.accountId)).toEqual(['one', 'two'])
  })

  it('rejects an aggregate that cannot serve the tested model and baseline generation capability', () => {
    const draft = state()
    draft.accounts.forEach((account) => { account.modelsRefreshedAt = 2 })
    draft.providers[0].capabilityProfile = { version: 1, origin: 'declared', nonStreaming: false }
    draft.pools.push({
      id: 'aggregate', name: 'Aggregate', kind: 'relay-aggregate', protocol: 'openai-responses',
      strategy: 'priority', members: [{ accountId: 'one', enabled: true }], modelPolicy: 'all',
      modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 0,
      createdAt: 1, updatedAt: 1,
    })

    expect(() => applySetupRoutingDraft(draft, {
      sessionId: 'session', sourceId: 'one', client: 'codex', model: 'gpt-test', aggregatePoolId: 'aggregate',
    })).toThrow('基础生成能力')
  })
})
