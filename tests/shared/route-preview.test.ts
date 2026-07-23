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
})
