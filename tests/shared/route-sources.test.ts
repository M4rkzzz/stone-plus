import { describe, expect, it } from 'vitest'
import type { Account, Pool, ProviderDefinition } from '../../src/shared/types'
import {
  appendRuntimeRouteSourcePools,
  hasRouteSourceIdCollision,
  listRouteSources,
  resolveRouteSource,
} from '../../src/shared/route-sources'

const NOW = 1_800_000_000_000

describe('route sources', () => {
  it('lists standard pools, aggregate relays, official APIs and relays by their real source ids', () => {
    const official = provider('official', 'official-api', 'openai-responses')
    const relay = provider('relay', 'relay', 'openai-chat')
    const oauth = provider('oauth', 'oauth-system', 'openai-responses')
    const accounts = [
      account('official-account', official.id),
      account('relay-account', relay.id),
      account('oauth-account', oauth.id, 'chatgpt-oauth'),
      account('pool-account', 'pool-provider'),
    ]
    const pools = [
      pool('standard', 'standard', 'openai-responses', ['pool-account']),
      pool('aggregate', 'relay-aggregate', 'openai-chat', ['relay-account']),
    ]

    expect(listRouteSources({ pools, providers: [official, relay, oauth], accounts }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'standard', kind: 'standard' }),
        expect.objectContaining({ id: 'aggregate', kind: 'relay-aggregate' }),
        expect.objectContaining({ id: 'official', kind: 'official-api' }),
        expect.objectContaining({ id: 'relay', kind: 'relay' }),
      ]))
    expect(listRouteSources({ pools, providers: [official, relay, oauth], accounts })
      .some((source) => source.id === oauth.id)).toBe(false)
  })

  it('resolves a one-key provider into a non-persisted single-member runtime pool', () => {
    const source = provider('relay', 'relay', 'openai-chat')
    source.forceFastMode = true
    const sourceAccount = account('relay-account', source.id)
    const collections = { pools: [] as Pool[], providers: [source], accounts: [sourceAccount] }

    const resolved = resolveRouteSource(source.id, collections)
    expect(resolved).toMatchObject({
      summary: { id: source.id, kind: 'relay', protocol: 'openai-chat', accountCount: 1 },
      pool: {
        id: source.id,
        kind: 'standard',
        protocol: 'openai-chat',
        strategy: 'priority',
        members: [{ accountId: sourceAccount.id, enabled: true, order: 0, weight: 1 }],
        maxRetries: 0,
        forceFastMode: true,
      },
    })
    expect(collections.pools).toEqual([])
    expect(appendRuntimeRouteSourcePools([source.id], collections)).toEqual([resolved?.pool])
  })

  it('rejects OAuth, missing/multiple keys, unavailable menu entries, and id collisions', () => {
    const relay = provider('same-id', 'relay', 'openai-chat')
    const sourcePool = pool('same-id', 'standard', 'openai-chat', ['first'])
    const first = account('first', relay.id)
    const second = account('second', relay.id)
    expect(resolveRouteSource(relay.id, { pools: [], providers: [relay], accounts: [first, second] })).toBeUndefined()

    const oauth = provider('oauth', 'oauth-system', 'openai-responses')
    expect(resolveRouteSource(oauth.id, {
      pools: [], providers: [oauth], accounts: [account('oauth-account', oauth.id, 'chatgpt-oauth')],
    })).toBeUndefined()

    const disabled = { ...first, status: 'disabled' as const }
    expect(listRouteSources({ pools: [], providers: [relay], accounts: [disabled] })).toEqual([])
    expect(resolveRouteSource(relay.id, { pools: [], providers: [relay], accounts: [disabled] })).toBeDefined()

    const colliding = { pools: [sourcePool], providers: [relay], accounts: [first] }
    expect(hasRouteSourceIdCollision(relay.id, colliding)).toBe(true)
    expect(resolveRouteSource(relay.id, colliding)).toBeUndefined()
    expect(() => appendRuntimeRouteSourcePools([relay.id], colliding)).toThrow(/conflicts/)
  })
})

function provider(
  id: string,
  sourceType: ProviderDefinition['sourceType'],
  protocol: ProviderDefinition['protocol'],
): ProviderDefinition {
  return {
    id,
    name: id,
    sourceType,
    kind: sourceType === 'relay' ? 'openai-compatible' : 'openai',
    baseUrl: `https://${id}.example/v1`,
    protocol,
    models: ['test-model'],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function account(
  id: string,
  providerId: string,
  credentialType: Account['credentialType'] = 'api-key',
): Account {
  return {
    id,
    providerId,
    name: id,
    credentialId: `${id}-credential`,
    maskedCredential: '****test',
    credentialType,
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    circuitState: 'closed',
    consecutiveFailures: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function pool(id: string, kind: Pool['kind'], protocol: Pool['protocol'], accountIds: string[]): Pool {
  return {
    id,
    name: id,
    kind,
    protocol,
    strategy: kind === 'relay-aggregate' ? 'priority' : 'balanced',
    members: accountIds.map((accountId) => ({ accountId, enabled: true })),
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }
}
