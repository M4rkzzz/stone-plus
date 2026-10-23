import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, ''),
  },
}))

import { AppStore } from '../../src/main/store/app-store'

describe('Grok Build source write invariants', () => {
  let directory: string
  const stores: AppStore[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stone-grok-build-source-invariants-'))
  })

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await rm(directory, { recursive: true, force: true })
  })

  const createStore = async (): Promise<AppStore> => {
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    return store
  }

  it('rejects changing a bound standalone Grok relay into an OpenAI relay atomically', async () => {
    const store = await createStore()
    const saved = await saveRelay(store, 'Grok relay', 'xai-compatible')
    await store.setRouteSource('grokbuild', saved.source.sourceId)

    await expect(store.saveApiSource({
      id: saved.source.sourceId,
      name: 'Changed relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://openai-relay.example/v1',
      protocol: 'openai-responses',
      credential: 'replacement-key',
      models: ['gpt-5'],
      defaultModel: 'gpt-5',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
    })).rejects.toThrow(/Grok Build/i)

    expect(store.getSnapshot().providers.find((provider) => provider.id === saved.source.sourceId))
      .toMatchObject({ name: 'Grok relay', kind: 'xai-compatible' })
    expect(grokRoute(store).poolId).toBe(saved.source.sourceId)
  })

  it('rejects replacing a bound Grok account pool with OpenAI members', async () => {
    const store = await createStore()
    const grok = await store.saveApiSource({
      name: 'Official Grok',
      sourceType: 'official-api',
      kind: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai-responses',
      credential: 'xai-key',
      models: ['grok-4.5'],
      defaultModel: 'grok-4.5',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
    })
    const original = await store.savePool({
      name: 'Grok accounts',
      protocol: 'grok',
      strategy: 'priority',
      accountIds: [grok.source.accountId],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0,
    })
    const pool = original.pools.find((candidate) => candidate.name === 'Grok accounts')!
    const withOpenAi = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'OpenAI account',
      credential: 'openai-key',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: ['gpt-5'],
    })
    const openAiAccount = withOpenAi.accounts.find((account) => account.name === 'OpenAI account')!
    await store.setRouteSource('grokbuild', pool.id)

    await expect(store.savePool({
      id: pool.id,
      name: 'OpenAI accounts',
      protocol: 'openai-responses',
      strategy: 'priority',
      accountIds: [openAiAccount.id],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0,
    })).rejects.toThrow(/Grok Build/i)

    expect(store.getSnapshot().pools.find((candidate) => candidate.id === pool.id)).toMatchObject({
      name: 'Grok accounts',
      protocol: 'grok',
      members: [{ accountId: grok.source.accountId, enabled: true }],
    })
  })

  it('rejects replacing a bound Grok aggregate with an OpenAI aggregate', async () => {
    const store = await createStore()
    const grokOne = await saveRelay(store, 'Grok one', 'xai-compatible')
    const grokTwo = await saveRelay(store, 'Grok two', 'xai-compatible')
    const openAiOne = await saveRelay(store, 'OpenAI one', 'openai-compatible')
    const openAiTwo = await saveRelay(store, 'OpenAI two', 'openai-compatible')
    const snapshot = await store.saveAggregateRelay({
      name: 'Grok aggregate',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [
        { accountId: grokOne.source.accountId, order: 0, weight: 1 },
        { accountId: grokTwo.source.accountId, order: 1, weight: 1 },
      ],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
    })
    const pool = snapshot.pools.find((candidate) => candidate.name === 'Grok aggregate')!
    await store.setRouteSource('grokbuild', pool.id)

    await expect(store.saveAggregateRelay({
      id: pool.id,
      name: 'OpenAI aggregate',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [
        { accountId: openAiOne.source.accountId, order: 0, weight: 1 },
        { accountId: openAiTwo.source.accountId, order: 1, weight: 1 },
      ],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
    })).rejects.toThrow(/Grok Build/i)

    expect(store.getSnapshot().pools.find((candidate) => candidate.id === pool.id)).toMatchObject({
      name: 'Grok aggregate',
      members: [
        { accountId: grokOne.source.accountId },
        { accountId: grokTwo.source.accountId },
      ],
    })
  })

  it('protects legacy provider and account writers for a bound standalone source', async () => {
    const store = await createStore()
    const providerSnapshot = await store.saveProvider({
      name: 'Legacy Grok relay',
      sourceType: 'relay',
      kind: 'xai-compatible',
      baseUrl: 'https://legacy-grok.example/v1',
      protocol: 'openai-responses',
      models: ['grok-4.5'],
    })
    const provider = providerSnapshot.providers.find((candidate) => candidate.name === 'Legacy Grok relay')!
    await store.saveAccount({
      providerId: provider.id,
      name: 'Only account',
      credential: 'grok-key',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: ['grok-4.5'],
    })
    await store.setRouteSource('grokbuild', provider.id)

    await expect(store.saveProvider({
      id: provider.id,
      name: 'Changed provider',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://openai.example/v1',
      protocol: 'openai-responses',
      models: ['gpt-5'],
    })).rejects.toThrow(/Grok Build/i)
    await expect(store.saveAccount({
      providerId: provider.id,
      name: 'Second account',
      credential: 'second-key',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: ['grok-4.5'],
    })).rejects.toThrow(/Grok Build/i)

    expect(store.getSnapshot().providers.find((candidate) => candidate.id === provider.id))
      .toMatchObject({ name: 'Legacy Grok relay', kind: 'xai-compatible' })
    expect(store.getSnapshot().accounts.filter((account) => account.providerId === provider.id)).toHaveLength(1)
    expect(grokRoute(store).poolId).toBe(provider.id)
  })
})

function saveRelay(store: AppStore, name: string, kind: 'xai-compatible' | 'openai-compatible') {
  return store.saveApiSource({
    name,
    sourceType: 'relay',
    kind,
    baseUrl: `https://${name.toLowerCase().replaceAll(' ', '-')}.example/v1`,
    protocol: 'openai-responses',
    credential: `${name}-key`,
    models: [kind === 'xai-compatible' ? 'grok-4.5' : 'gpt-5'],
    defaultModel: kind === 'xai-compatible' ? 'grok-4.5' : 'gpt-5',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
  })
}

function grokRoute(store: AppStore) {
  return store.getSnapshot().routes.find((route) => route.client === 'grokbuild')!
}
