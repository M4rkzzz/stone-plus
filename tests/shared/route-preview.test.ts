import { describe, expect, it } from 'vitest'
import { previewRoute } from '../../src/shared/route-preview'
import type { AppSnapshot, Route } from '../../src/shared/types'

const route: Route = {
  id: 'route',
  client: 'codex',
  enabled: true,
  poolId: 'provider',
  inboundProtocol: 'openai-responses',
  modelMap: { alias: 'gpt-test' },
  localToken: 'stone_test',
  createdAt: 1,
  updatedAt: 1,
}

const snapshot = {
  providers: [{
    id: 'provider', name: 'Relay', sourceType: 'relay', kind: 'openai-compatible',
    baseUrl: 'https://relay.example/v1', protocol: 'openai-responses', models: ['gpt-test'],
    capabilityProfile: { version: 1, origin: 'probed', streaming: true, imageInput: false },
    createdAt: 1, updatedAt: 1,
  }],
  accounts: [{
    id: 'account', providerId: 'provider', name: 'Key', maskedCredential: '***', credentialType: 'api-key',
    status: 'active', priority: 1, weight: 1, maxConcurrency: 4, inFlight: 0,
    availableModels: ['gpt-test'], modelPolicy: 'all', modelAllowlist: [], createdAt: 1, updatedAt: 1,
  }],
  pools: [],
} as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

describe('static route preview', () => {
  it('resolves model mappings without making an upstream request', () => {
    const result = previewRoute({ route, requestedModel: 'alias' }, snapshot)
    expect(result.status).toBe('ready')
    expect(result.upstreamModel).toBe('gpt-test')
    expect(result.eligibleAccountCount).toBe(1)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'model-mapped' }))
  })

  it('previews the effective per-model source while preserving the default source for unmatched models', () => {
    const routedSnapshot = {
      ...snapshot,
      providers: [
        ...snapshot.providers,
        { ...snapshot.providers[0], id: 'provider-luna', name: 'Luna pool', models: ['gpt-5.6-luna-upstream'] },
      ],
      accounts: [
        ...snapshot.accounts,
        {
          ...snapshot.accounts[0],
          id: 'account-luna',
          providerId: 'provider-luna',
          availableModels: ['gpt-5.6-luna-upstream'],
        },
      ],
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    const routed = {
      ...route,
      modelMap: { 'gpt-5.6-luna': 'gpt-5.6-luna-upstream' },
      modelSourceMap: { 'gpt-5.6-luna': 'provider-luna' },
    }

    const luna = previewRoute({ route: routed, requestedModel: 'gpt-5.6-luna' }, routedSnapshot)
    expect(luna).toMatchObject({
      status: 'ready',
      sourceId: 'provider-luna',
      sourceName: 'Luna pool',
      upstreamModel: 'gpt-5.6-luna-upstream',
      eligibleAccountCount: 1,
    })
    expect(luna.issues).toContainEqual(expect.objectContaining({ code: 'source-overridden' }))

    const unmatched = previewRoute({ route: routed, requestedModel: 'gpt-test' }, routedSnapshot)
    expect(unmatched).toMatchObject({ sourceId: 'provider', sourceName: 'Relay' })
    expect(unmatched.issues).not.toContainEqual(expect.objectContaining({ code: 'source-overridden' }))
  })

  it('uses a wildcard mapping for an otherwise-unmapped model', () => {
    const result = previewRoute({
      route: { ...route, modelMap: { '*': 'grok-4.20' } },
      requestedModel: 'codex-configured-alias',
    }, {
      ...snapshot,
      providers: snapshot.providers.map((provider) => ({ ...provider, models: ['grok-4.20'] })),
      accounts: snapshot.accounts.map((account) => ({ ...account, availableModels: ['grok-4.20'] })),
    })
    expect(result.status).toBe('ready')
    expect(result.upstreamModel).toBe('grok-4.20')
  })

  it('uses the real Grok provider wire protocol instead of treating its logical pool as a conversion', () => {
    const grokSnapshot = {
      providers: [{
        ...snapshot.providers[0],
        id: 'grok-provider',
        name: 'Grok OAuth',
        sourceType: 'oauth-system' as const,
        kind: 'xai' as const,
        protocol: 'openai-responses' as const,
        models: ['grok-4.5'],
      }],
      accounts: [{
        ...snapshot.accounts[0],
        id: 'grok-account',
        providerId: 'grok-provider',
        credentialType: 'grok-oauth' as const,
        availableModels: ['grok-4.5'],
        modelPolicy: 'selected' as const,
        modelAllowlist: ['grok-4.5'],
      }],
      pools: [{
        id: 'grok-pool', name: 'Grok pool', kind: 'standard' as const,
        protocol: 'grok' as const, strategy: 'priority' as const,
        members: [{ accountId: 'grok-account', enabled: true }],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({
      route: { ...route, poolId: 'grok-pool', modelMap: { '*': 'grok-4.5' } },
      requestedModel: 'codex-model',
    }, grokSnapshot)

    expect(result).toMatchObject({
      status: 'ready',
      sourceProtocol: 'openai-responses',
      inboundProtocol: 'openai-responses',
      upstreamModel: 'grok-4.5',
      eligibleAccountCount: 1,
    })
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'protocol-conversion' }))

    const grokBuild = previewRoute({
      route: { ...route, client: 'grokbuild', poolId: 'grok-pool', modelMap: { '*': 'grok-4.5' } },
      requestedModel: 'grok-4.5',
    }, grokSnapshot)
    expect(grokBuild.status).toBe('ready')
  })

  it('blocks a Grok Build route backed by a Chat-compatible Grok relay', () => {
    const chatGrok = {
      providers: [{
        ...snapshot.providers[0],
        id: 'chat-grok-provider',
        kind: 'xai-compatible' as const,
        protocol: 'openai-chat' as const,
      }],
      accounts: [{
        ...snapshot.accounts[0],
        id: 'chat-grok-account',
        providerId: 'chat-grok-provider',
      }],
      pools: [{
        id: 'chat-grok-pool', name: 'Chat Grok pool', kind: 'standard' as const,
        protocol: 'grok' as const, strategy: 'priority' as const,
        members: [{ accountId: 'chat-grok-account', enabled: true }],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({
      route: { ...route, client: 'grokbuild', poolId: 'chat-grok-pool' },
    }, chatGrok)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'source-unavailable',
      message: expect.stringContaining('OpenAI Responses'),
    }))
  })

  it('fails closed when a persisted Grok pool contains even a disabled OpenAI member', () => {
    const mixed = {
      providers: [
        { ...snapshot.providers[0], id: 'grok-provider', kind: 'xai' as const, sourceType: 'official-api' as const },
        { ...snapshot.providers[0], id: 'openai-provider' },
      ],
      accounts: [
        { ...snapshot.accounts[0], id: 'grok-account', providerId: 'grok-provider' },
        { ...snapshot.accounts[0], id: 'openai-account', providerId: 'openai-provider' },
      ],
      pools: [{
        id: 'mixed-grok', name: 'Mixed Grok', kind: 'standard' as const,
        protocol: 'grok' as const, strategy: 'priority' as const,
        members: [
          { accountId: 'grok-account', enabled: true },
          { accountId: 'openai-account', enabled: false },
        ],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({ route: { ...route, poolId: 'mixed-grok' } }, mixed)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source-unavailable' }))
  })

  it('fails closed when a persisted standard pool mixes OpenAI and Grok relays', () => {
    const mixed = {
      providers: [
        { ...snapshot.providers[0], id: 'openai-provider' },
        { ...snapshot.providers[0], id: 'grok-provider', kind: 'xai-compatible' as const },
      ],
      accounts: [
        { ...snapshot.accounts[0], id: 'openai-account', providerId: 'openai-provider' },
        { ...snapshot.accounts[0], id: 'grok-account', providerId: 'grok-provider' },
      ],
      pools: [{
        id: 'mixed-relays', name: 'Mixed relays', kind: 'standard' as const,
        protocol: 'openai-responses' as const, strategy: 'balanced' as const,
        members: [
          { accountId: 'openai-account', enabled: true },
          { accountId: 'grok-account', enabled: true },
        ],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({ route: { ...route, poolId: 'mixed-relays' } }, mixed)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
  })

  it('fails closed when a disabled legacy relay member uses a different wire protocol', () => {
    const crossWire = {
      providers: [
        {
          ...snapshot.providers[0],
          id: 'responses-relay',
          sourceType: 'relay' as const,
          kind: 'openai-compatible' as const,
          protocol: 'openai-responses' as const,
        },
        {
          ...snapshot.providers[0],
          id: 'chat-relay',
          sourceType: 'relay' as const,
          kind: 'openai-compatible' as const,
          protocol: 'openai-chat' as const,
        },
      ],
      accounts: [
        { ...snapshot.accounts[0], id: 'responses-account', providerId: 'responses-relay' },
        { ...snapshot.accounts[0], id: 'chat-account', providerId: 'chat-relay' },
      ],
      pools: [{
        id: 'legacy-cross-wire', name: 'Legacy cross wire', kind: 'standard' as const,
        protocol: 'openai-responses' as const, strategy: 'balanced' as const,
        members: [
          { accountId: 'responses-account', enabled: true },
          { accountId: 'chat-account', enabled: false },
        ],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({ route: { ...route, poolId: 'legacy-cross-wire' } }, crossWire)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source-unavailable' }))
  })

  it('blocks explicitly unsupported required capabilities', () => {
    const result = previewRoute({ route, requestedModel: 'alias', requiredCapabilities: ['imageInput'] }, snapshot)
    expect(result.status).toBe('blocked')
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'capability-unsupported',
      capability: 'imageInput',
    }))
  })

  it('warns rather than blocks legacy unknown capabilities', () => {
    const legacy = {
      ...snapshot,
      providers: snapshot.providers.map((provider) => ({ ...provider, capabilityProfile: undefined })),
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    const result = previewRoute({ route, requiredCapabilities: ['websocket'] }, legacy)
    expect(result.status).toBe('warning')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'capability-unknown' }))
  })

  it('does not warn for unknown siblings when a verified member can serve the capability', () => {
    const mixed = {
      ...snapshot,
      providers: [
        {
          ...snapshot.providers[0],
          capabilityProfile: { ...snapshot.providers[0].capabilityProfile, webSearch: true },
        },
        { ...snapshot.providers[0], id: 'legacy-provider', capabilityProfile: undefined },
      ],
      accounts: [
        snapshot.accounts[0],
        { ...snapshot.accounts[0], id: 'legacy-account', providerId: 'legacy-provider' },
      ],
      pools: [{
        id: 'mixed-pool', name: 'Mixed', kind: 'standard', protocol: 'openai-responses', strategy: 'balanced',
        members: [{ accountId: 'account', enabled: true }, { accountId: 'legacy-account', enabled: true }],
        modelPolicy: 'all', modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 0,
        createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({
      route: { ...route, poolId: 'mixed-pool' },
      requiredCapabilities: ['webSearch'],
    }, mixed)
    expect(result.status).toBe('ready')
    expect(result.eligibleAccountCount).toBe(1)
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'capability-unknown' }))
  })

  it('does not count an orphaned account as an eligible route source member', () => {
    const orphaned = {
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({ ...account, providerId: 'missing-provider' })),
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    const result = previewRoute({ route, requestedModel: 'alias' }, orphaned)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
  })

  it('blocks a persisted pool whose enabled active member has no provider metadata', () => {
    const orphanedPool = {
      providers: snapshot.providers,
      accounts: [{
        ...snapshot.accounts[0],
        id: 'orphan-account',
        providerId: 'missing-provider',
        status: 'active' as const,
      }],
      pools: [{
        id: 'persisted-orphan-pool', name: 'Orphan pool', kind: 'standard' as const,
        protocol: 'openai-responses' as const, strategy: 'priority' as const,
        members: [{ accountId: 'orphan-account', enabled: true }],
        modelPolicy: 'all' as const, modelAllowlist: [], stickySessions: false,
        stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>

    const result = previewRoute({
      route: { ...route, poolId: 'persisted-orphan-pool' },
    }, orphanedPool)

    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source-unavailable' }))
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'source-missing' }))
  })

  it('does not borrow a capability from an account that cannot serve the model', () => {
    const mixed = {
      providers: [
        { ...snapshot.providers[0], id: 'model-provider', capabilityProfile: {
          version: 1 as const, origin: 'declared' as const, streaming: true, imageInput: false,
        } },
        { ...snapshot.providers[0], id: 'other-provider', models: ['other-model'], capabilityProfile: {
          version: 1 as const, origin: 'declared' as const, streaming: true, imageInput: true,
        } },
      ],
      accounts: [
        { ...snapshot.accounts[0], id: 'model-account', providerId: 'model-provider', availableModels: ['alias'], modelsRefreshedAt: 1 },
        { ...snapshot.accounts[0], id: 'other-account', providerId: 'other-provider', availableModels: ['other-model'], modelsRefreshedAt: 1 },
      ],
      pools: [{
        id: 'mixed-pool', name: 'mixed', kind: 'standard', protocol: 'openai-responses', strategy: 'balanced',
        members: [{ accountId: 'model-account', enabled: true }, { accountId: 'other-account', enabled: true }],
        modelPolicy: 'all', modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 0,
        createdAt: 1, updatedAt: 1,
      }],
    } as unknown as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    const result = previewRoute({
      route: { ...route, poolId: 'mixed-pool' }, requestedModel: 'alias', requiredCapabilities: ['imageInput'],
    }, mixed)
    expect(result.status).toBe('blocked')
    expect(result.eligibleAccountCount).toBe(0)
  })

  it('treats a selected empty model allowlist as exposing no models', () => {
    const selected = {
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({
        ...account, modelPolicy: 'selected' as const, modelAllowlist: [],
      })),
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    const result = previewRoute({ route, requestedModel: 'alias' }, selected)
    expect(result.status).toBe('blocked')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'model-unavailable' }))
  })

  it('does not report checking, cooling or saturated accounts as currently eligible', () => {
    const now = Date.now()
    const variants = [
      { status: 'checking' as const },
      { status: 'cooldown' as const, cooldownUntil: now + 60_000 },
      { status: 'active' as const, inFlight: 4, maxConcurrency: 4 },
    ]
    for (const patch of variants) {
      const unavailable = {
        ...snapshot,
        accounts: snapshot.accounts.map((account) => ({ ...account, ...patch })),
      } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
      const result = previewRoute({ route, requestedModel: 'alias' }, unavailable)
      expect(result.status).toBe('blocked')
      expect(result.eligibleAccountCount).toBe(0)
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source-unavailable' }))
    }

    const recovered = {
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({
        ...account,
        status: 'cooldown' as const,
        cooldownUntil: now - 1,
      })),
    } as Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>
    expect(previewRoute({ route, requestedModel: 'alias' }, recovered).eligibleAccountCount).toBe(1)
  })
})
