import { describe, expect, it } from 'vitest'
import type {
  AppSnapshot,
  ClientConfigStatus,
  Pool,
  ProviderDefinition,
  PublicAccount,
  Route,
  RouteClient,
} from '../../src/shared/types'
import { evaluateHelpReadiness } from '../../src/renderer/src/help-readiness'

const timestamp = 1

function provider(
  id: string,
  sourceType: ProviderDefinition['sourceType'] = 'oauth-system',
  protocol: ProviderDefinition['protocol'] = 'openai-responses',
): ProviderDefinition {
  return {
    id,
    name: id,
    sourceType,
    kind: 'openai',
    baseUrl: 'https://example.test',
    protocol,
    models: ['test-model'],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function account(
  id: string,
  providerId: string,
  status: PublicAccount['status'] = 'active',
  credentialType: PublicAccount['credentialType'] = 'chatgpt-oauth',
): PublicAccount {
  return {
    id,
    providerId,
    name: id,
    maskedCredential: '***',
    credentialType,
    status,
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['test-model'],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function pool(
  id: string,
  members: Pool['members'],
  kind: Pool['kind'] = 'standard',
): Pool {
  return {
    id,
    name: id,
    kind,
    protocol: 'openai-responses',
    strategy: kind === 'relay-aggregate' ? 'weighted-round-robin' : 'balanced',
    members,
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function route(
  sourceId: string,
  client: RouteClient = 'codex',
  enabled = true,
): Route {
  return {
    id: `route-${client}`,
    client,
    enabled,
    poolId: sourceId,
    inboundProtocol: client === 'claude'
      ? 'anthropic-messages'
      : client === 'gemini' ? 'gemini' : 'openai-responses',
    modelMap: {},
    localToken: 'local-token',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function clientConfig(client: RouteClient, configured: boolean): ClientConfigStatus {
  return {
    client,
    directory: `C:/${client}`,
    directoryExists: configured,
    configured,
    files: [],
    backupCount: 0,
  }
}

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    gateway: {
      host: '127.0.0.1',
      port: 3000,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 60,
    },
    gatewayStatus: {
      running: false,
      host: '127.0.0.1',
      port: 3000,
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
    },
    requestLogs: [],
    clientProfiles: [],
    healthEvents: [],
    observability: {} as AppSnapshot['observability'],
    vaultAvailable: true,
    vaultBackend: 'test',
    ...overrides,
  }
}

describe('help readiness', () => {
  it('returns natural English checklist copy when an English translator is supplied', () => {
    const result = evaluateHelpReadiness(snapshot(), [], (_chinese, english) => english)

    expect(result.items[0]).toMatchObject({
      label: 'Usable source added',
      description: 'Add an OAuth account, official API, or relay source first.',
      actionLabel: 'Add source',
    })
    expect(result.items[4]).toMatchObject({
      label: 'Client configured',
      actionLabel: 'Configure client',
    })
  })

  it('starts with the source quick entry when nothing is configured', () => {
    const result = evaluateHelpReadiness(snapshot())

    expect(result.items.map((item) => [item.id, item.complete])).toEqual([
      ['source', false],
      ['route-source', false],
      ['route', false],
      ['gateway', false],
      ['client', false],
    ])
    expect(result).toMatchObject({
      completedCount: 0,
      totalCount: 5,
      percentage: 0,
      ready: false,
      nextAction: { id: 'source', page: 'providers', actionLabel: '添加来源' },
    })
  })

  it('recognises an available OAuth account but still asks for a routable pool', () => {
    const result = evaluateHelpReadiness(snapshot({
      providers: [provider('oauth')],
      accounts: [account('account-1', 'oauth', 'cooldown')],
    }))

    expect(result.completedCount).toBe(1)
    expect(result.percentage).toBe(20)
    expect(result.nextAction).toMatchObject({ id: 'route-source', page: 'pools' })
  })

  it.each(['disabled', 'expired'] as const)(
    'does not report a %s account as an available source',
    (status) => {
      const result = evaluateHelpReadiness(snapshot({
        providers: [provider('oauth')],
        accounts: [account('account-1', 'oauth', status)],
      }))

      expect(result.items[0].complete).toBe(false)
    },
  )

  it('treats an official API provider as a direct route source without requiring a pool', () => {
    const result = evaluateHelpReadiness(snapshot({
      providers: [provider('official', 'official-api')],
      accounts: [account('official-key', 'official', 'active', 'api-key')],
      routes: [route('official')],
      gatewayStatus: {
        running: true,
        host: '127.0.0.1',
        port: 3000,
        activeRequests: 0,
        totalRequests: 0,
        successRequests: 0,
      },
    }), [clientConfig('codex', true)])

    expect(result.items.every((item) => item.complete)).toBe(true)
    expect(result).toMatchObject({
      completedCount: 5,
      totalCount: 5,
      percentage: 100,
      ready: true,
      nextAction: null,
    })
  })

  it('does not report a provider without its API credential account as usable', () => {
    const result = evaluateHelpReadiness(snapshot({
      providers: [provider('official', 'official-api')],
      routes: [route('official')],
      gatewayStatus: {
        running: true,
        host: '127.0.0.1',
        port: 3000,
        activeRequests: 0,
        totalRequests: 0,
        successRequests: 0,
      },
    }), [clientConfig('codex', true)])

    expect(result.items.map((item) => item.complete)).toEqual([false, false, false, true, false])
    expect(result.nextAction).toMatchObject({ id: 'source', page: 'providers' })
  })

  it('recognises a standard pool with an enabled available member', () => {
    const result = evaluateHelpReadiness(snapshot({
      providers: [provider('oauth')],
      accounts: [account('oauth-account', 'oauth')],
      pools: [pool('standard', [{ accountId: 'oauth-account', enabled: true }])],
      routes: [route('standard')],
    }))

    expect(result.items.slice(0, 3).map((item) => item.complete)).toEqual([true, true, true])
  })

  it('recognises an aggregate pool when at least one enabled member is available', () => {
    const providers = [
      provider('oauth'),
      provider('relay-a', 'relay'),
      provider('relay-b', 'relay'),
    ]
    const accounts = [
      account('oauth-account', 'oauth'),
      account('relay-account-a', 'relay-a', 'expired', 'api-key'),
      account('relay-account-b', 'relay-b', 'active', 'api-key'),
    ]
    const aggregate = pool('aggregate', [
      { accountId: 'relay-account-a', enabled: true, order: 0, weight: 1 },
      { accountId: 'relay-account-b', enabled: true, order: 1, weight: 1 },
    ], 'relay-aggregate')

    const result = evaluateHelpReadiness(snapshot({
      providers,
      accounts,
      pools: [aggregate],
      routes: [route('aggregate')],
    }))

    expect(result.items.slice(0, 3).map((item) => item.complete)).toEqual([true, true, true])
    expect(result.nextAction).toMatchObject({ id: 'gateway', page: 'settings' })
  })

  it('rejects disabled routes, dangling sources, empty pools, and source id collisions', () => {
    const collidingProvider = provider('collision', 'official-api')
    const collidingPool = pool('collision', [])
    const result = evaluateHelpReadiness(snapshot({
      providers: [collidingProvider],
      pools: [collidingPool],
      routes: [route('collision'), route('missing', 'claude'), route('collision', 'gemini', false)],
    }))

    expect(result.items.slice(0, 3).map((item) => item.complete)).toEqual([false, false, false])
    expect(result.nextAction?.id).toBe('source')
  })

  it('requires client configuration to match a valid enabled route', () => {
    const base = snapshot({
      providers: [provider('relay', 'relay')],
      accounts: [account('relay-key', 'relay', 'active', 'api-key')],
      routes: [route('relay', 'codex')],
      gatewayStatus: {
        running: true,
        host: '127.0.0.1',
        port: 3000,
        activeRequests: 0,
        totalRequests: 0,
        successRequests: 0,
      },
    })

    const wrongClient = evaluateHelpReadiness(base, [clientConfig('claude', true)])
    expect(wrongClient.items.at(-1)?.complete).toBe(false)
    expect(wrongClient.nextAction).toMatchObject({ id: 'client', page: 'clients' })

    const routedClient = evaluateHelpReadiness(base, [
      clientConfig('claude', true),
      clientConfig('codex', true),
    ])
    expect(routedClient.ready).toBe(true)
  })

  it('does not count a pool whose enabled members are dangling', () => {
    const result = evaluateHelpReadiness(snapshot({
      providers: [provider('oauth')],
      accounts: [account('account-1', 'oauth')],
      pools: [pool('dangling', [{ accountId: 'missing-account', enabled: true }])],
      routes: [route('dangling')],
    }))

    expect(result.items.map((item) => item.complete).slice(0, 3)).toEqual([true, false, false])
  })
})
