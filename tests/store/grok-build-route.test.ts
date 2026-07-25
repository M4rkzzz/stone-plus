import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { LEGACY_JSON_FILENAME } from '../../src/main/store/sqlite-state-store'
import type { PersistedState } from '../../src/main/store/types'

const timestamp = 1_700_000_000_000

describe('Grok Build persisted route boundaries', () => {
  let directory: string
  const stores: AppStore[] = []

  const createStore = (): AppStore => {
    const store = new AppStore(directory)
    stores.push(store)
    return store
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stone-grok-build-route-'))
  })

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await rm(directory, { recursive: true, force: true })
  })

  it('creates one disabled Grok Build route and one default client profile for a fresh store', async () => {
    const store = createStore()
    await store.initialize()
    const snapshot = store.getSnapshot()

    expect(snapshot.routes.filter((route) => route.client === 'grokbuild')).toEqual([
      expect.objectContaining({
        id: 'route-grokbuild',
        enabled: false,
        poolId: '',
        inboundProtocol: 'openai-responses',
      }),
    ])
    expect(snapshot.routes.find((route) => route.client === 'grokbuild')?.localToken)
      .toMatch(/^[0-9a-f]{32}$/)
    expect(snapshot.clientProfiles.filter((profile) => profile.client === 'grokbuild')).toEqual([
      expect.objectContaining({
        id: 'default-grokbuild',
        isDefault: true,
        backupRetention: 10,
      }),
    ])
  })

  it('backfills old state once without changing the existing Codex route or its token', async () => {
    const legacy = legacyStateWithoutGrokBuild()
    await writeFile(join(directory, LEGACY_JSON_FILENAME), `${JSON.stringify(legacy, null, 2)}\n`)
    const store = createStore()
    await store.initialize()
    const migrated = store.getSnapshot()

    expect(migrated.routes.find((route) => route.client === 'codex')).toMatchObject({
      id: 'legacy-codex-route',
      enabled: true,
      poolId: 'legacy-pool',
      localToken: 'legacy-codex-token',
      modelMap: { alias: 'legacy-upstream-model' },
    })
    expect(migrated.routes.filter((route) => route.client === 'grokbuild')).toHaveLength(1)
    expect(migrated.routes.find((route) => route.client === 'grokbuild')).toMatchObject({
      id: 'route-grokbuild',
      enabled: false,
      poolId: '',
      inboundProtocol: 'openai-responses',
    })
    expect(migrated.clientProfiles.filter((profile) => profile.id === 'default-grokbuild')).toHaveLength(1)
    const grokToken = migrated.routes.find((route) => route.client === 'grokbuild')!.localToken

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    const second = restarted.getSnapshot()
    expect(second.routes.filter((route) => route.client === 'grokbuild')).toHaveLength(1)
    expect(second.routes.find((route) => route.client === 'grokbuild')?.localToken).toBe(grokToken)
    expect(second.clientProfiles.filter((profile) => profile.id === 'default-grokbuild')).toHaveLength(1)
    expect(second.routes.find((route) => route.client === 'codex')?.localToken).toBe('legacy-codex-token')
  })

  it('rejects enabling a Grok Build route against an OpenAI pool', async () => {
    const store = createStore()
    await store.initialize()
    const source = await createOpenAiPool(store)
    const grokRoute = source.routes.find((route) => route.client === 'grokbuild')!
    const openAiPool = source.pools.find((pool) => pool.name === 'OpenAI-only pool')!

    await expect(store.updateRoute({
      ...grokRoute,
      enabled: true,
      poolId: openAiPool.id,
      modelMap: { '*': 'gpt-5' },
    })).rejects.toThrow(/Grok/i)

    expect(store.getSnapshot().routes.find((route) => route.client === 'grokbuild')).toMatchObject({
      enabled: false,
      poolId: '',
    })
  })

  it('rejects the narrow source-switch mutation for a non-Grok source as well', async () => {
    const store = createStore()
    await store.initialize()
    const source = await createOpenAiPool(store)
    const openAiPool = source.pools.find((pool) => pool.name === 'OpenAI-only pool')!

    await expect(store.setRouteSource('grokbuild', openAiPool.id)).rejects.toThrow(/Grok/i)
    expect(store.getSnapshot().routes.find((route) => route.client === 'grokbuild')?.poolId).toBe('')
  })

  it('accepts standalone and aggregate xAI-compatible relay sources', async () => {
    const store = createStore()
    await store.initialize()
    const first = await saveGrokRelay(store, 'First Grok relay', 'https://first-grok.example/v1')
    const second = await saveGrokRelay(store, 'Second Grok relay', 'https://second-grok.example/v1')

    await store.setRouteSource('grokbuild', first.source.sourceId)
    expect(store.getSnapshot().routes.find((route) => route.client === 'grokbuild')?.poolId)
      .toBe(first.source.sourceId)

    const aggregate = await store.saveAggregateRelay({
      name: 'Grok aggregate',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [
        { accountId: first.source.accountId, order: 0, weight: 1 },
        { accountId: second.source.accountId, order: 1, weight: 1 },
      ],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
    })
    const aggregatePool = aggregate.pools.find((pool) => pool.name === 'Grok aggregate')!

    await store.setRouteSource('grokbuild', aggregatePool.id)
    expect(store.getSnapshot().routes.find((route) => route.client === 'grokbuild')?.poolId)
      .toBe(aggregatePool.id)
  })
})

async function createOpenAiPool(store: AppStore) {
  const withAccount = await store.saveAccount({
    providerId: 'provider-openai',
    name: 'OpenAI-only account',
    credential: 'openai-private-key',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    modelAllowlist: ['gpt-5'],
  })
  const account = withAccount.accounts.find((candidate) => candidate.name === 'OpenAI-only account')!
  return store.savePool({
    name: 'OpenAI-only pool',
    protocol: 'openai-responses',
    strategy: 'priority',
    accountIds: [account.id],
    modelPolicy: 'all',
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
  })
}

function saveGrokRelay(store: AppStore, name: string, baseUrl: string) {
  return store.saveApiSource({
    name,
    sourceType: 'relay',
    kind: 'xai-compatible',
    baseUrl,
    protocol: 'openai-responses',
    credential: `${name}-private-key`,
    models: ['grok-4.5'],
    defaultModel: 'grok-4.5',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
  })
}

function legacyStateWithoutGrokBuild(): PersistedState {
  return {
    version: 1,
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [{
      id: 'legacy-codex-route',
      client: 'codex',
      enabled: true,
      poolId: 'legacy-pool',
      inboundProtocol: 'openai-responses',
      modelMap: { alias: 'legacy-upstream-model' },
      localToken: 'legacy-codex-token',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    gateway: {
      host: '127.0.0.1',
      port: 15721,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 30,
    },
    requestLogs: [],
    credentials: {},
    clientProfiles: [{
      id: 'default-codex',
      name: 'Legacy Codex profile',
      client: 'codex',
      backupRetention: 7,
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    healthEvents: [],
  }
}
