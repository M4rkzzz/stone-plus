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
