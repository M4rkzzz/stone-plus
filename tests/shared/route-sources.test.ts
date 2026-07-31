import { describe, expect, it } from 'vitest'
import type { Account, Pool, ProviderDefinition } from '../../src/shared/types'
import {
  appendRuntimeRouteSourcePools,
  analyzeRouteSourceCompatibility,
  enabledPoolAccounts,
  enumerateRouteSourceModels,
  hasRouteSourceIdCollision,
  isKiroClaudeRouteSource,
  isBindableRouteAccount,
  isCurrentlySchedulableRouteAccount,
  isNativeGrokRouteSource,
  isRouteSourcePoolTopologyValid,
  listRouteSources,
  listRouteSourcesForClient,
  resolveRouteSource,
  summarizePoolCapacity,
} from '../../src/shared/route-sources'

const NOW = 1_800_000_000_000

describe('route sources', () => {
  it('lists standard pools, aggregate relays, official APIs and relays by their real source ids', () => {
    const official = provider('official', 'official-api', 'openai-responses')
    const poolProvider = provider('pool-provider', 'official-api', 'openai-responses')
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

    expect(listRouteSources({ pools, providers: [official, poolProvider, relay, oauth], accounts }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'standard', kind: 'standard' }),
        expect.objectContaining({ id: 'aggregate', kind: 'relay-aggregate' }),
        expect.objectContaining({ id: 'official', kind: 'official-api' }),
        expect.objectContaining({ id: 'relay', kind: 'relay' }),
      ]))
    expect(listRouteSources({ pools, providers: [official, poolProvider, relay, oauth], accounts })
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

  it('enumerates the effective selected models for one-click route reconciliation', () => {
    const source = provider('kiro', 'official-api', 'anthropic-messages')
    source.models = ['claude-opus-4-8', 'claude-opus-5']
    const sourceAccount = account('kiro-account', source.id)
    sourceAccount.modelPolicy = 'selected'
    sourceAccount.modelAllowlist = ['claude-opus-4-8']
    const collections = { pools: [] as Pool[], providers: [source], accounts: [sourceAccount] }

    expect(enumerateRouteSourceModels(resolveRouteSource(source.id, collections), collections))
      .toEqual(['claude-opus-4-8'])

    sourceAccount.status = 'disabled'
    expect(enumerateRouteSourceModels(resolveRouteSource(source.id, collections), collections)).toEqual([])
  })

  it('exposes an official xAI source as logical Grok while retaining its Chat wire protocol', () => {
    const source = provider('xai-official', 'official-api', 'openai-chat')
    source.kind = 'xai'
    const sourceAccount = account('xai-account', source.id)
    const resolved = resolveRouteSource(source.id, {
      pools: [], providers: [source], accounts: [sourceAccount],
    })
    expect(resolved).toMatchObject({
      summary: { protocol: 'grok' },
      pool: { protocol: 'grok' },
      provider: { protocol: 'openai-chat' },
    })
    expect(isNativeGrokRouteSource(resolved, { providers: [source] })).toBe(false)

    source.protocol = 'openai-responses'
    expect(isNativeGrokRouteSource(resolved, { providers: [source] })).toBe(true)
  })

  it('requires at least one enabled Grok Responses member for a native Grok route source', () => {
    const native = provider('native-grok', 'relay', 'openai-responses')
    native.kind = 'xai-compatible'
    const chat = provider('chat-grok', 'relay', 'openai-chat')
    chat.kind = 'xai-compatible'
    const nativeAccount = account('native-account', native.id)
    const chatAccount = account('chat-account', chat.id)
    const sourcePool = pool('grok-pool', 'standard', 'grok', [nativeAccount.id, chatAccount.id])
    sourcePool.members[1].enabled = false
    const collections = {
      pools: [sourcePool],
      providers: [native, chat],
      accounts: [nativeAccount, chatAccount],
    }

    expect(isNativeGrokRouteSource(resolveRouteSource(sourcePool.id, collections), collections)).toBe(true)

    sourcePool.members[1].enabled = true
    expect(isNativeGrokRouteSource(resolveRouteSource(sourcePool.id, collections), collections)).toBe(false)

    sourcePool.members.forEach((member) => { member.enabled = false })
    expect(isNativeGrokRouteSource(resolveRouteSource(sourcePool.id, collections), collections)).toBe(false)
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
    expect(hasRouteSourceIdCollision(relay.id, { pools: [], providers: [relay] })).toBe(false)
    expect(hasRouteSourceIdCollision(sourcePool.id, { pools: [sourcePool], providers: [] })).toBe(false)
    expect(hasRouteSourceIdCollision(relay.id, colliding)).toBe(true)
    expect(resolveRouteSource(relay.id, colliding)).toBeUndefined()
    expect(() => appendRuntimeRouteSourcePools([relay.id], colliding)).toThrow(/conflicts/)
  })

  it('separates durable binding from current runtime schedulability', () => {
    const relay = provider('relay', 'relay', 'openai-chat')
    const checking = { ...account('checking', relay.id), status: 'checking' as const }
    const cooling = {
      ...account('cooling', relay.id),
      status: 'cooldown' as const,
      cooldownUntil: NOW + 60_000,
    }
    const saturated = { ...account('saturated', relay.id), inFlight: 1, maxConcurrency: 1 }
    const collections = { pools: [] as Pool[], providers: [relay], accounts: [checking] }

    expect(isBindableRouteAccount(checking)).toBe(true)
    expect(isCurrentlySchedulableRouteAccount(checking, NOW)).toBe(false)
    expect(isBindableRouteAccount(cooling)).toBe(true)
    expect(isCurrentlySchedulableRouteAccount(cooling, NOW)).toBe(false)
    expect(isCurrentlySchedulableRouteAccount({ ...cooling, cooldownUntil: NOW }, NOW)).toBe(true)
    expect(isCurrentlySchedulableRouteAccount(saturated, NOW)).toBe(false)

    // Legacy/default menu behavior remains bindable for UI and IPC callers.
    expect(listRouteSources(collections).map((source) => source.id)).toEqual([relay.id])
    expect(listRouteSources(collections, { availability: 'schedulable', now: NOW })).toEqual([])
  })

  it('summarizes only enabled, unique and bindable pool-member capacity', () => {
    const relay = provider('relay', 'relay', 'openai-chat')
    const active = { ...account('active', relay.id), inFlight: 1, maxConcurrency: 3 }
    const disabledStatus = {
      ...account('disabled-status', relay.id),
      status: 'disabled' as const,
      inFlight: 0,
      maxConcurrency: 10,
    }
    const disabledMember = { ...account('disabled-member', relay.id), maxConcurrency: 20 }
    const targetPool = pool('capacity', 'standard', 'openai-chat', [active.id, disabledStatus.id, disabledMember.id])
    targetPool.members[2].enabled = false
    targetPool.members.push({ accountId: active.id, enabled: true })

    expect(enabledPoolAccounts(targetPool, [active, disabledStatus, disabledMember]).map((item) => item.id))
      .toEqual([active.id, disabledStatus.id])
    expect(summarizePoolCapacity(targetPool, [active, disabledStatus, disabledMember], NOW)).toMatchObject({
      enabledAccounts: [active, disabledStatus],
      bindableAccounts: [active],
      schedulableAccounts: [active],
      inFlight: 1,
      capacity: 3,
    })
  })

  it('rejects a legacy standard relay pool whose declared wire protocols differ', () => {
    const responses = provider('responses-relay', 'relay', 'openai-responses')
    const chat = provider('chat-relay', 'relay', 'openai-chat')
    const responsesAccount = account('responses-account', responses.id)
    const chatAccount = account('chat-account', chat.id)
    const legacyPool = pool(
      'legacy-cross-wire',
      'standard',
      'openai-responses',
      [responsesAccount.id, chatAccount.id],
    )
    // Disabled members are still part of the persisted topology and must not
    // become a latent protocol bypass when re-enabled later.
    legacyPool.members[1].enabled = false
    const collections = {
      pools: [legacyPool],
      providers: [responses, chat],
      accounts: [responsesAccount, chatAccount],
    }
    const source = resolveRouteSource(legacyPool.id, collections)

    expect(source?.accounts.map((candidate) => candidate.id)).toEqual([responsesAccount.id])
    expect(isRouteSourcePoolTopologyValid(legacyPool, collections)).toBe(false)
    expect(analyzeRouteSourceCompatibility('codex', source, collections)).toMatchObject({
      eligible: false,
      mode: 'unsupported',
    })
    expect(listRouteSourcesForClient('codex', collections).map((candidate) => candidate.id))
      .not.toContain(legacyPool.id)

    chat.protocol = 'openai-responses'
    expect(isRouteSourcePoolTopologyValid(legacyPool, collections)).toBe(true)
    const aggregate = pool(
      'same-wire-aggregate',
      'relay-aggregate',
      'openai-responses',
      [responsesAccount.id, chatAccount.id],
    )
    expect(isRouteSourcePoolTopologyValid(aggregate, collections)).toBe(true)

    expect(isRouteSourcePoolTopologyValid(legacyPool, {
      ...collections,
      accounts: [responsesAccount, { ...responsesAccount, providerId: chat.id }, chatAccount],
    })).toBe(false)
    expect(isRouteSourcePoolTopologyValid(legacyPool, {
      ...collections,
      providers: [responses, { ...responses, protocol: 'openai-chat' }, chat],
    })).toBe(false)
  })

  it('exposes verified Kiro Claude relays only to Claude and explains the bridge', () => {
    const kiro = provider('kiro', 'relay', 'kiro-claude')
    kiro.kind = 'kiro-compatible'
    kiro.toolRoundtripVerified = true
    kiro.capabilityProfile = {
      version: 1,
      origin: 'probed',
      checkedAt: NOW,
      toolCalls: true,
    }
    const kiroAccount = account('kiro-account', kiro.id)
    const collections = { pools: [] as Pool[], providers: [kiro], accounts: [kiroAccount] }
    const source = resolveRouteSource(kiro.id, collections)

    expect(source?.pool.stickySessions).toBe(true)
    expect(isKiroClaudeRouteSource(source, collections)).toBe(true)
    expect(analyzeRouteSourceCompatibility('claude', source, collections)).toMatchObject({
      eligible: true,
      mode: 'kiro-claude',
      inboundProtocol: 'anthropic-messages',
      sourceProtocol: 'kiro-claude',
    })
    expect(analyzeRouteSourceCompatibility('codex', source, collections)).toMatchObject({
      eligible: false,
      mode: 'unsupported',
    })
    expect(listRouteSourcesForClient('claude', collections).map((candidate) => candidate.id)).toEqual([kiro.id])
    expect(listRouteSourcesForClient('codex', collections)).toEqual([])

    kiro.toolRoundtripVerified = false
    expect(isKiroClaudeRouteSource(resolveRouteSource(kiro.id, collections), collections)).toBe(false)
    expect(listRouteSourcesForClient('claude', collections)).toEqual([])
    kiro.toolRoundtripVerified = true
    kiro.capabilityProfile = { version: 1, origin: 'inferred', toolCalls: true }
    expect(resolveRouteSource(kiro.id, collections)).toBeDefined()
    expect(isKiroClaudeRouteSource(resolveRouteSource(kiro.id, collections), collections)).toBe(false)
    expect(listRouteSourcesForClient('claude', collections)).toEqual([])
  })

  it('requires every Kiro aggregate member to be verified and sticky', () => {
    const first = provider('kiro-a', 'relay', 'kiro-claude')
    const second = provider('kiro-b', 'relay', 'kiro-claude')
    for (const candidate of [first, second]) {
      candidate.kind = 'kiro-compatible'
      candidate.toolRoundtripVerified = true
      candidate.capabilityProfile = {
        version: 1,
        origin: 'probed',
        checkedAt: NOW,
        toolCalls: true,
      }
    }
    const firstAccount = account('kiro-a-account', first.id)
    const secondAccount = account('kiro-b-account', second.id)
    const aggregate = pool('kiro-aggregate', 'relay-aggregate', 'kiro-claude', [firstAccount.id, secondAccount.id])
    aggregate.stickySessions = true
    const collections = {
      pools: [aggregate],
      providers: [first, second],
      accounts: [firstAccount, secondAccount],
    }

    expect(isKiroClaudeRouteSource(resolveRouteSource(aggregate.id, collections), collections)).toBe(true)
    second.capabilityProfile = { version: 1, origin: 'probed', checkedAt: NOW, toolCalls: false }
    expect(isKiroClaudeRouteSource(resolveRouteSource(aggregate.id, collections), collections)).toBe(false)
    second.capabilityProfile.toolCalls = true
    aggregate.stickySessions = false
    expect(isKiroClaudeRouteSource(resolveRouteSource(aggregate.id, collections), collections)).toBe(false)
  })

  it('exposes DeepSeek Responses only to Codex clients', () => {
    const deepseek = provider('deepseek', 'official-api', 'openai-responses')
    deepseek.kind = 'deepseek'
    const deepseekAccount = account('deepseek-account', deepseek.id)
    const collections = { pools: [] as Pool[], providers: [deepseek], accounts: [deepseekAccount] }
    const source = resolveRouteSource(deepseek.id, collections)

    expect(analyzeRouteSourceCompatibility('codex', source, collections)).toMatchObject({
      eligible: true,
      mode: 'native',
      sourceProtocol: 'openai-responses',
    })
    for (const client of ['claude', 'gemini', 'grokbuild'] as const) {
      expect(analyzeRouteSourceCompatibility(client, source, collections)).toMatchObject({
        eligible: false,
        mode: 'unsupported',
      })
      expect(listRouteSourcesForClient(client, collections)).toEqual([])
    }
    expect(listRouteSourcesForClient('codex', collections).map((candidate) => candidate.id))
      .toEqual([deepseek.id])
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
