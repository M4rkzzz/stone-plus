import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, RequestLog } from '../../src/shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, '')
  }
}))

import { AppStore, summarizeAppObservability } from '../../src/main/store/app-store'
import {
  LEGACY_JSON_FILENAME,
  SQLITE_DATABASE_FILENAME,
  SQLITE_SCHEMA_VERSION,
  SqliteStateStore
} from '../../src/main/store/sqlite-state-store'
import type { PersistedState } from '../../src/main/store/types'

function chatGptAccessToken(exp: number, accountId: string, userId: string): string {
  return ['header', Buffer.from(JSON.stringify({
    exp,
    sub: userId,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_account_user_id: userId,
      chatgpt_user_id: userId,
      user_id: userId
    }
  })).toString('base64url'), 'signature'].join('.')
}

function credentialCache(store: AppStore): Map<string, string> {
  return (store as unknown as { decryptedCredentialCache: Map<string, string> }).decryptedCredentialCache
}

describe('AppStore', () => {
  let directory: string
  const stores: AppStore[] = []
  const stateStores: Array<SqliteStateStore<PersistedState>> = []

  const createStore = (targetDirectory = directory): AppStore => {
    const store = new AppStore(targetDirectory)
    stores.push(store)
    return store
  }

  const createStateStore = (initialData: PersistedState): SqliteStateStore<PersistedState> => {
    const store = new SqliteStateStore({
      databasePath: join(directory, SQLITE_DATABASE_FILENAME),
      legacyJsonPath: join(directory, LEGACY_JSON_FILENAME),
      initialData,
      normalize: (state) => ({ ...state, requestLogs: state.requestLogs.slice(0, 500) })
    })
    stateStores.push(store)
    return store
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stone-store-'))
  })

  afterEach(async () => {
    await Promise.all([...stores.splice(0), ...stateStores.splice(0)].map((store) => store.close()))
    await rm(directory, { recursive: true, force: true })
  })

  it('encrypts credentials and never includes them in renderer snapshots', async () => {
    const store = createStore()
    await store.initialize()
    const snapshot = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Primary',
      credential: 'sk-secret-value',
      priority: 1,
      weight: 1,
      maxConcurrency: 2,
      modelAllowlist: []
    })

    const account = snapshot.accounts[0]
    expect(account.maskedCredential).toBe('****alue')
    expect(account).not.toHaveProperty('credentialId')
    expect(store.getCredential(store.getRuntimeAccount(account.id)!.credentialId)).toBe('sk-secret-value')
    expect('credentials' in snapshot).toBe(false)

    await store.close()
    const persisted = await readFile(join(directory, SQLITE_DATABASE_FILENAME))
    expect(persisted.includes(Buffer.from('sk-secret-value', 'utf8'))).toBe(false)

    const restarted = createStore()
    await restarted.initialize()
    const restartedAccount = restarted.getSnapshot().accounts[0]
    expect(restartedAccount.maskedCredential).toBe('****alue')
    expect(restartedAccount).not.toHaveProperty('credentialId')
    expect(restarted.getCredential(restarted.getRuntimeAccount(restartedAccount.id)!.credentialId)).toBe('sk-secret-value')
  })

  it('evicts replaced and deleted account/proxy plaintext from the credential cache', async () => {
    const store = createStore()
    await store.initialize()
    const accountSnapshot = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Cached account',
      credential: 'first-account-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
    })
    const account = accountSnapshot.accounts.find((candidate) => candidate.name === 'Cached account')!
    const accountCredentialId = store.getRuntimeAccount(account.id)!.credentialId
    const firstAccountCiphertext = store.getStateRepository().read().credentials[accountCredentialId]
    expect(store.getCredential(accountCredentialId)).toBe('first-account-secret')
    expect(credentialCache(store).has(firstAccountCiphertext)).toBe(true)

    await store.saveAccount({
      id: account.id,
      providerId: 'provider-openai',
      name: account.name,
      credential: 'second-account-secret',
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelAllowlist: [],
    })
    expect(credentialCache(store).has(firstAccountCiphertext)).toBe(false)
    const secondAccountCiphertext = store.getStateRepository().read().credentials[accountCredentialId]
    expect(store.getCredential(accountCredentialId)).toBe('second-account-secret')
    await store.deleteAccount(account.id)
    expect(credentialCache(store).has(secondAccountCiphertext)).toBe(false)

    const proxySnapshot = await store.saveProxy({
      name: 'Cached proxy', protocol: 'http', host: '127.0.0.1', port: 18080,
      username: 'proxy-user', password: 'first-proxy-secret',
    })
    const proxy = proxySnapshot.proxies.find((candidate) => candidate.name === 'Cached proxy')!
    const proxyCredentialId = store.getStateRepository().read().proxies
      .find((candidate) => candidate.id === proxy.id)!.credentialId!
    const firstProxyCiphertext = store.getStateRepository().read().credentials[proxyCredentialId]
    expect(store.getProxyPassword(proxy.id)).toBe('first-proxy-secret')

    await store.saveProxy({
      id: proxy.id,
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: 'second-proxy-secret',
    })
    expect(credentialCache(store).has(firstProxyCiphertext)).toBe(false)
    const secondProxyCiphertext = store.getStateRepository().read().credentials[proxyCredentialId]
    expect(store.getProxyPassword(proxy.id)).toBe('second-proxy-secret')
    await store.deleteProxy(proxy.id)
    expect(credentialCache(store).has(secondProxyCiphertext)).toBe(false)
  })

  it('clears every decrypted credential when explicitly invalidated or closed', async () => {
    const store = createStore()
    await store.initialize()
    const snapshot = await store.saveAccount({
      providerId: 'provider-openai', name: 'Clear cache', credential: 'cached-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const credentialId = store.getRuntimeAccount(snapshot.accounts[0].id)!.credentialId
    expect(store.getCredential(credentialId)).toBe('cached-secret')
    expect(credentialCache(store).size).toBeGreaterThan(0)

    store.invalidateCredentialCache()
    expect(credentialCache(store).size).toBe(0)
    expect(store.getCredential(credentialId)).toBe('cached-secret')
    await store.close()
    expect(credentialCache(store).size).toBe(0)
  })

  it('persists and clears an ignored update version outside snapshots and full persisted state', async () => {
    const store = createStore()
    await store.initialize()
    await store.setIgnoredUpdateVersion('v1.2.3')

    expect(store.getIgnoredUpdateVersion()).toBe('1.2.3')
    expect(store.getSnapshot()).not.toHaveProperty('ignoredUpdateVersion')
    expect(store.getStateRepository().read()).not.toHaveProperty('ignoredUpdateVersion')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('1.2.3')
    expect(JSON.stringify(store.getStateRepository().read())).not.toContain('1.2.3')

    await store.close()
    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const persisted = new DatabaseSync(databasePath, { readOnly: true })
    expect(persisted.prepare('SELECT value FROM app_metadata WHERE key = ?').get('ignored_update_version'))
      .toEqual({ value: '1.2.3' })
    persisted.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getIgnoredUpdateVersion()).toBe('1.2.3')
    await restarted.setIgnoredUpdateVersion('')
    expect(restarted.getIgnoredUpdateVersion()).toBeUndefined()
    await restarted.close()

    const cleared = new DatabaseSync(databasePath, { readOnly: true })
    expect(cleared.prepare('SELECT value FROM app_metadata WHERE key = ?').get('ignored_update_version'))
      .toBeUndefined()
    cleared.close()

    const afterClear = createStore()
    await afterClear.initialize()
    expect(afterClear.getIgnoredUpdateVersion()).toBeUndefined()
  })

  it('rejects an invalid ignored update version without changing the stored value', async () => {
    const store = createStore()
    await store.initialize()
    await store.setIgnoredUpdateVersion('2.0.0')

    await expect(store.setIgnoredUpdateVersion('not-a-semver')).rejects.toThrow(/valid semantic version/)
    expect(store.getIgnoredUpdateVersion()).toBe('2.0.0')
  })

  it('persists reusable proxies with encrypted passwords and supports update, clear, and delete', async () => {
    const password = 'proxy-password-private'
    const store = createStore()
    await store.initialize()
    const created = await store.saveProxy({
      name: 'Local SOCKS',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'proxy-user',
      password
    })
    const proxy = created.proxies[0]

    expect(proxy).toMatchObject({
      name: 'Local SOCKS',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'proxy-user',
      hasPassword: true,
      status: 'unchecked'
    })
    expect(proxy).not.toHaveProperty('credentialId')
    expect(proxy).not.toHaveProperty('password')
    expect(JSON.stringify(proxy)).not.toContain(password)
    expect(store.getProxyPassword(proxy.id)).toBe(password)

    await store.close()
    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const persisted = await readFile(databasePath)
    expect(persisted.includes(Buffer.from(password, 'utf8'))).toBe(false)
    const database = new DatabaseSync(databasePath, { readOnly: true })
    const storedProxy = JSON.parse((database.prepare('SELECT payload FROM proxies WHERE id = ?').get(proxy.id) as {
      payload: string
    }).payload) as { credentialId?: string }
    expect(storedProxy.credentialId).toBeTruthy()
    expect(database.prepare('SELECT encrypted_value FROM credentials WHERE id = ?').get(storedProxy.credentialId) as {
      encrypted_value: string
    }).toEqual({ encrypted_value: Buffer.from(`vault:${password}`, 'utf8').toString('base64') })
    database.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getProxyPassword(proxy.id)).toBe(password)
    const renamed = await restarted.saveProxy({
      id: proxy.id,
      name: 'Renamed SOCKS',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'proxy-user'
    })
    expect(renamed.proxies[0]).toMatchObject({ name: 'Renamed SOCKS', hasPassword: true })
    expect(restarted.getProxyPassword(proxy.id)).toBe(password)

    const cleared = await restarted.saveProxy({
      id: proxy.id,
      name: 'Renamed SOCKS',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'proxy-user',
      clearPassword: true
    })
    expect(cleared.proxies[0]).toMatchObject({ hasPassword: false, status: 'unchecked' })
    expect(restarted.getProxyPassword(proxy.id)).toBeUndefined()
    expect((await restarted.deleteProxy(proxy.id)).proxies).toHaveLength(0)
  })

  it('protects proxies referenced by accounts and pools', async () => {
    const store = createStore()
    await store.initialize()
    const withProxy = await store.saveProxy({
      name: 'Shared proxy',
      protocol: 'http',
      host: 'localhost',
      port: 8080
    })
    const proxyId = withProxy.proxies[0].id
    const withAccount = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Proxied account',
      credential: 'sk-proxied',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
      proxyId
    })
    const account = withAccount.accounts[0]
    const withPool = await store.savePool({
      name: 'Proxied pool',
      protocol: 'openai-responses',
      strategy: 'priority',
      accountIds: [account.id],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
      forceFastMode: true,
      hedgedRequests: true,
      hedgeDelayMs: 1750,
      firstBodyTimeoutMs: 6500,
      proxyId
    })
    const pool = withPool.pools[0]
    expect(pool.forceFastMode).toBe(true)
    expect(pool).toMatchObject({ hedgedRequests: true, hedgeDelayMs: 1750, firstBodyTimeoutMs: 6500 })

    await expect(store.deleteProxy(proxyId)).rejects.toThrow(/accounts/)
    await store.saveAccount({
      id: account.id,
      providerId: account.providerId,
      name: account.name,
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelAllowlist: account.modelAllowlist,
      proxyId: ''
    })
    await expect(store.deleteProxy(proxyId)).rejects.toThrow(/pools/)
    const updatedPool = await store.savePool({
      id: pool.id,
      name: pool.name,
      protocol: pool.protocol,
      strategy: pool.strategy,
      accountIds: pool.members.map((member) => member.accountId),
      stickySessions: pool.stickySessions,
      stickyTtlMinutes: pool.stickyTtlMinutes,
      maxRetries: pool.maxRetries,
      proxyId: ''
    })
    expect(updatedPool.pools[0].forceFastMode).toBe(true)
    expect(updatedPool.pools[0]).toMatchObject({ hedgedRequests: true, hedgeDelayMs: 1750, firstBodyTimeoutMs: 6500 })
    expect((await store.deleteProxy(proxyId)).proxies).toHaveLength(0)
  })

  it('rejects insecure remote providers and non-loopback gateway hosts', async () => {
    const store = createStore()
    await store.initialize()

    await expect(store.saveProvider({
      name: 'Remote HTTP',
      kind: 'openai-compatible',
      baseUrl: 'http://example.com/v1',
      protocol: 'openai-chat',
      models: []
    })).rejects.toThrow(/HTTPS/)

    await expect(store.updateGateway({
      host: '0.0.0.0',
      port: 15721,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 120
    })).rejects.toThrow(/loopback/)
  })

  it('persists validated relay Responses compact capabilities and rejects invalid save-provider input', async () => {
    const store = createStore()
    await store.initialize()
    const input = {
      name: 'Compact-aware relay',
      sourceType: 'relay' as const,
      kind: 'openai-compatible' as const,
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-responses' as const,
      models: [],
      responsesCompactMode: 'passthrough'
    } as Parameters<AppStore['saveProvider']>[0]
    const saved = await store.saveProvider(input)
    const providerId = saved.providers.find((provider) => provider.name === input.name)!.id
    expect(store.getRuntimeProvider(providerId)).toMatchObject({ responsesCompactMode: 'passthrough' })

    // An older renderer omits the new optional field when editing unrelated
    // provider settings. Preserve the existing explicit capability.
    await store.saveProvider({ ...input, id: providerId, name: 'Renamed relay', responsesCompactMode: undefined })
    expect(store.getRuntimeProvider(providerId)).toMatchObject({ responsesCompactMode: 'passthrough' })

    await expect(store.saveProvider({
      ...input,
      name: 'Invalid mode relay',
      responsesCompactMode: 'future-mode'
    } as Parameters<AppStore['saveProvider']>[0])).rejects.toThrow(/must be legacy, passthrough, or native/)
    await expect(store.saveProvider({
      ...input,
      name: 'Invalid official override',
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      responsesCompactMode: 'native'
    } as Parameters<AppStore['saveProvider']>[0])).rejects.toThrow(/only for OpenAI Responses relay/)

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getRuntimeProvider(providerId)).toMatchObject({ responsesCompactMode: 'passthrough' })
  })

  it('strips unknown or inapplicable compact capabilities while importing legacy provider JSON', async () => {
    const legacy = legacyJsonState() as ReturnType<typeof legacyJsonState> & {
      providers: Array<Record<string, unknown>>
    }
    Object.assign(legacy.providers[0], {
      sourceType: 'relay',
      protocol: 'openai-responses',
      responsesCompactMode: 'future-mode'
    })
    await writeFile(join(directory, LEGACY_JSON_FILENAME), `${JSON.stringify(legacy)}\n`, 'utf8')

    const store = createStore()
    await store.initialize()
    expect(store.getRuntimeProvider('legacy-provider')).not.toHaveProperty('responsesCompactMode')
  })

  it('defaults legacy outbound networking to direct and persists system proxy mode', async () => {
    const store = createStore()
    await store.initialize()
    expect(store.getSnapshot().gateway.outboundNetworkMode).toBe('direct')

    await store.updateGateway({
      ...store.getSnapshot().gateway,
      outboundNetworkMode: 'system'
    })
    expect(store.getSnapshot().gateway.outboundNetworkMode).toBe('system')
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().gateway.outboundNetworkMode).toBe('system')
  })

  it('only accepts accounts whose provider protocol matches the pool', async () => {
    const store = createStore()
    await store.initialize()
    const snapshot = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'OpenAI key',
      credential: 'sk-test',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })

    await expect(store.savePool({
      name: 'Wrong protocol',
      protocol: 'anthropic-messages',
      strategy: 'priority',
      accountIds: [snapshot.accounts[0].id],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1
    })).rejects.toThrow(/pool protocol/)
  })

  it('preserves disabled pool members when editing a standard pool', async () => {
    const store = createStore()
    await store.initialize()
    const firstSnapshot = await store.saveAccount({
      providerId: 'provider-openai', name: 'Enabled member', credential: 'sk-enabled',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const firstAccountId = firstSnapshot.accounts.find((account) => account.name === 'Enabled member')!.id
    const secondSnapshot = await store.saveAccount({
      providerId: 'provider-openai', name: 'Disabled member', credential: 'sk-disabled',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const secondAccountId = secondSnapshot.accounts.find((account) => account.name === 'Disabled member')!.id
    const saved = await store.savePool({
      name: 'Editable pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [firstAccountId, secondAccountId], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })
    const pool = saved.pools.find((candidate) => candidate.name === 'Editable pool')!
    await store.getStateRepository().update((state) => {
      const member = state.pools.find((candidate) => candidate.id === pool.id)!.members
        .find((candidate) => candidate.accountId === secondAccountId)!
      member.enabled = false
      member.weight = 7
      member.order = 2
    })

    const updated = await store.savePool({
      id: pool.id, name: 'Renamed pool', protocol: pool.protocol, strategy: pool.strategy,
      accountIds: [firstAccountId], stickySessions: pool.stickySessions,
      stickyTtlMinutes: pool.stickyTtlMinutes, maxRetries: pool.maxRetries
    })

    expect(updated.pools.find((candidate) => candidate.id === pool.id)?.members).toContainEqual({
      accountId: secondAccountId,
      enabled: false,
      weight: 7,
      order: 2
    })
  })

  it('rejects relay sources as standard pool members', async () => {
    const store = createStore()
    await store.initialize()
    const relay = await store.saveApiSource({
      name: 'Relay only', sourceType: 'relay', kind: 'openai-compatible',
      baseUrl: 'https://relay-only.example/v1', protocol: 'openai-chat', models: ['relay-model'],
      credential: 'relay-secret', priority: 1, weight: 1, maxConcurrency: 1
    })

    await expect(store.savePool({
      name: 'Invalid standard pool', protocol: 'openai-chat', strategy: 'priority',
      accountIds: [relay.source.accountId], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })).rejects.toThrow(/only be members of aggregate relays/)
  })

  it('persists autobalanced as an opt-in pool strategy', async () => {
    const store = createStore()
    await store.initialize()
    const withAccount = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Auto balanced key',
      credential: 'sk-auto-balanced',
      priority: 1,
      weight: 1,
      maxConcurrency: 2,
      modelAllowlist: []
    })

    const saved = await store.savePool({
      name: 'Adaptive pool',
      protocol: 'openai-responses',
      strategy: 'autobalanced',
      accountIds: [withAccount.accounts[0].id],
      stickySessions: true,
      stickyTtlMinutes: 30,
      maxRetries: 1
    })
    expect(saved.pools[0].strategy).toBe('autobalanced')
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().pools[0].strategy).toBe('autobalanced')
  })

  it('requires a new credential when moving an account to another provider', async () => {
    const store = createStore()
    await store.initialize()
    const snapshot = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Movable key',
      credential: 'openai-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })

    await expect(store.saveAccount({
      id: snapshot.accounts[0].id,
      providerId: 'provider-anthropic',
      name: 'Movable key',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })).rejects.toThrow(/new credential/)
    expect(store.getCredential(store.getRuntimeAccount(snapshot.accounts[0].id)!.credentialId)).toBe('openai-secret')
  })

  it('preserves health on metadata edits and resets it when the credential changes', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Cooling key',
      credential: 'old-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })
    const account = created.accounts[0]
    await store.setAccountCheckResult(account.id, {
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 3,
      cooldownUntil: Date.now() + 60_000,
      lastError: 'rate limited'
    })

    const edited = await store.saveAccount({
      id: account.id,
      providerId: account.providerId,
      name: 'Renamed key',
      priority: 2,
      weight: 3,
      maxConcurrency: 2,
      modelAllowlist: []
    })
    expect(edited.accounts[0]).toMatchObject({
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 3,
      lastError: 'rate limited'
    })

    const rekeyed = await store.saveAccount({
      id: account.id,
      providerId: account.providerId,
      name: 'Renamed key',
      credential: 'new-secret',
      priority: 2,
      weight: 3,
      maxConcurrency: 2,
      modelAllowlist: []
    })
    expect(rekeyed.accounts[0]).toMatchObject({
      status: 'active',
      circuitState: 'closed',
      consecutiveFailures: 0,
      cooldownUntil: undefined,
      lastError: undefined
    })
  })

  it('commits an account probe result only while its owner guard is current', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Guarded probe',
      credential: 'sk-guarded-probe',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
    })
    const accountId = created.accounts[0].id

    const stale = await store.setAccountCheckResultIf(
      accountId,
      { status: 'disabled', lastError: 'stale result' },
      () => false,
    )
    expect(stale.applied).toBe(false)
    expect(store.getRuntimeAccount(accountId)).not.toMatchObject({ lastError: 'stale result' })

    const current = await store.setAccountCheckResultIf(
      accountId,
      { status: 'active', lastError: undefined },
      () => true,
    )
    expect(current.applied).toBe(true)
    expect(store.getRuntimeAccount(accountId)).toMatchObject({ status: 'active' })
  })

  it('allows disabled client routes to remain unassigned during setup', async () => {
    const store = createStore()
    await store.initialize()
    const route = store.getSnapshot().routes.find((candidate) => candidate.client === 'claude')!

    const snapshot = await store.updateRoute({ ...route, poolId: '', enabled: false })
    expect(snapshot.routes.find((candidate) => candidate.id === route.id)).toMatchObject({
      enabled: false,
      poolId: ''
    })
  })

  it('defaults legacy routes to standard mode and persists high-concurrency mode', async () => {
    await writeFile(join(directory, LEGACY_JSON_FILENAME), `${JSON.stringify(legacyJsonState())}\n`, 'utf8')
    const store = createStore()
    await store.initialize()
    const route = store.getSnapshot().routes.find((candidate) => candidate.client === 'codex')!
    expect(route.highConcurrencyMode).toBe(false)

    const updated = await store.updateRoute({ ...route, highConcurrencyMode: true })
    expect(updated.routes.find((candidate) => candidate.id === route.id)?.highConcurrencyMode).toBe(true)

    const legacyCallerRoute = { ...updated.routes.find((candidate) => candidate.id === route.id)! }
    delete legacyCallerRoute.highConcurrencyMode
    const legacyUpdated = await store.updateRoute(legacyCallerRoute)
    expect(legacyUpdated.routes.find((candidate) => candidate.id === route.id)?.highConcurrencyMode).toBe(true)

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().routes.find((candidate) => candidate.id === route.id)?.highConcurrencyMode).toBe(true)
  })

  it('keeps every coding client route on its native inbound protocol', async () => {
    const store = createStore()
    await store.initialize()
    const route = store.getSnapshot().routes.find((candidate) => candidate.client === 'claude')!

    await expect(store.updateRoute({ ...route, inboundProtocol: 'openai-chat' }))
      .rejects.toThrow(/native inbound protocol/)
  })

  it('atomically switches only the selected client route source', async () => {
    const store = createStore()
    await store.initialize()
    const route = store.getSnapshot().routes.find((candidate) => candidate.client === 'codex')!
    const seeded = await store.updateRoute({
      ...route,
      enabled: false,
      modelMap: { codex: 'upstream-model' },
      localToken: 'stable-local-token'
    })
    const before = seeded.routes.find((candidate) => candidate.client === 'codex')!
    const switchedAt = before.updatedAt + 1_000
    vi.spyOn(Date, 'now').mockReturnValue(switchedAt)

    const switched = await store.setRouteSource('codex', '  relay-source  ')
    const after = switched.routes.find((candidate) => candidate.client === 'codex')!

    expect(after).toEqual({
      ...before,
      poolId: 'relay-source',
      updatedAt: switchedAt
    })
    expect(switched.routes.filter((candidate) => candidate.client !== 'codex'))
      .toEqual(seeded.routes.filter((candidate) => candidate.client !== 'codex'))
  })

  it('rejects an empty route source or a client without a route', async () => {
    const state = { ...legacyJsonState(), routes: [] }
    await writeFile(join(directory, LEGACY_JSON_FILENAME), `${JSON.stringify(state)}\n`, 'utf8')
    const store = createStore()
    await store.initialize()

    await expect(store.setRouteSource('codex', '   ')).rejects.toThrow(/route source/i)
    await expect(store.setRouteSource('codex', 'relay-source')).rejects.toThrow(/route does not exist/i)
  })

  it('persists custom client profiles and protects the default profiles', async () => {
    const store = createStore()
    await store.initialize()
    const saved = await store.saveClientProfile({
      name: 'Work Codex',
      client: 'codex',
      directory: join(directory, 'work-codex'),
      backupRetention: 7
    })
    const profile = saved.clientProfiles.find((candidate) => candidate.name === 'Work Codex')!
    expect(profile).toMatchObject({ client: 'codex', backupRetention: 7, isDefault: false })

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().clientProfiles).toContainEqual(expect.objectContaining({ id: profile.id }))
    await restarted.deleteClientProfile(profile.id)
    expect(restarted.getSnapshot().clientProfiles.some((candidate) => candidate.id === profile.id)).toBe(false)
    await expect(restarted.deleteClientProfile('default-codex')).rejects.toThrow(/Default/)
    await expect(restarted.saveClientProfile({
      id: 'default-codex',
      name: 'Mutated default',
      client: 'codex',
      backupRetention: 1
    })).rejects.toThrow(/Default/)
    await expect(restarted.saveClientProfile({
      name: 'Relative path',
      client: 'codex',
      directory: 'relative/codex',
      backupRetention: 5
    })).rejects.toThrow(/absolute/)
  })

  it('imports and exports value-free client profile bundles', async () => {
    const store = createStore()
    await store.initialize()
    const saved = await store.saveClientProfile({
      name: 'Portable Codex',
      client: 'codex',
      directory: join(directory, 'portable-codex'),
      backupRetention: 6
    })
    const profile = saved.clientProfiles.find((candidate) => candidate.name === 'Portable Codex')!
    const bundle = store.exportClientProfile(profile.id)
    expect(bundle).toEqual({
      format: 'stone-client-profile',
      version: 1,
      profile: expect.objectContaining({ name: 'Portable Codex', client: 'codex', backupRetention: 6 })
    })
    expect(JSON.stringify(bundle)).not.toContain('token')

    const imported = await store.importClientProfile({
      ...bundle,
      profile: { ...bundle.profile, name: 'Imported Codex' }
    })
    expect(imported.clientProfiles).toContainEqual(expect.objectContaining({ name: 'Imported Codex', client: 'codex' }))
    await expect(store.importClientProfile({ format: 'unknown' })).rejects.toThrow(/Unsupported/)
  })

  it('saves an API source and its single account atomically', async () => {
    const store = createStore()
    await store.initialize()
    const before = store.getSnapshot()
    const saved = await store.saveApiSource({
      name: 'DeepSeek',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-chat',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      credential: 'deepseek-secret',
      priority: 10,
      weight: 10,
      maxConcurrency: 4
    })
    const snapshot = saved.snapshot
    const provider = snapshot.providers.find((candidate) => candidate.name === 'DeepSeek')!
    const account = snapshot.accounts.find((candidate) => candidate.providerId === provider.id)!
    expect(account).toMatchObject({ name: 'DeepSeek', maskedCredential: '****cret', credentialType: 'api-key' })
    expect(store.getCredential(store.getRuntimeAccount(account.id)!.credentialId)).toBe('deepseek-secret')
    await expect(store.saveApiSource({
      name: 'Bad', sourceType: 'official-api', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
      protocol: 'gemini', models: [], credential: 'secret', priority: 1, weight: 1, maxConcurrency: 1
    })).rejects.toThrow(/does not support/)
    expect(store.getSnapshot().providers).toHaveLength(before.providers.length + 1)
  })

  it('persists probed capabilities only while the source connection and probe revision still match', async () => {
    const store = createStore()
    await store.initialize()
    const input = {
      name: 'Fingerprint relay',
      sourceType: 'relay' as const,
      kind: 'openai-compatible' as const,
      baseUrl: 'https://relay-a.example/v1',
      protocol: 'openai-chat' as const,
      models: ['model-a'],
      credential: 'relay-a-secret',
      priority: 10,
      weight: 10,
      maxConcurrency: 4,
    }
    const saved = await store.saveApiSource(input)
    const probeInput = { ...input, id: saved.source.sourceId, model: 'model-a' }
    const fingerprint = store.getApiSourceProbeConnectionFingerprint(probeInput)
    const probeResult = {
      capabilityProfile: { version: 1 as const, origin: 'probed' as const, streaming: true },
      modelCatalog: [],
      models: ['model-a'],
    }

    await expect(store.saveApiSourceCapabilityProbe(saved.source.sourceId, probeResult, fingerprint))
      .resolves.toBeDefined()

    await expect(store.saveApiSourceCapabilityProbe(saved.source.sourceId, {
      ...probeResult,
      models: ['stale-model'],
    }, fingerprint)).resolves.toBeUndefined()
    expect(store.getRuntimeProvider(saved.source.sourceId)).toMatchObject({
      models: ['model-a'],
      capabilityProfile: expect.objectContaining({ origin: 'probed' }),
    })

    await store.saveApiSource({
      ...input,
      id: saved.source.sourceId,
      baseUrl: 'https://relay-b.example/v1',
      credential: 'relay-b-secret',
      models: ['model-b'],
    })
    await expect(store.saveApiSourceCapabilityProbe(saved.source.sourceId, probeResult, fingerprint))
      .resolves.toBeUndefined()
    const provider = store.getRuntimeProvider(saved.source.sourceId)!
    expect(provider.baseUrl).toBe('https://relay-b.example/v1')
    expect(provider.models).toEqual(['model-b'])
    expect(provider.capabilityProfile?.origin).not.toBe('probed')
  })

  it('accepts initial probe evidence only when the main process explicitly authorizes it', async () => {
    const store = createStore()
    await store.initialize()
    const capabilityProfile = {
      version: 1 as const,
      origin: 'probed' as const,
      checkedAt: Date.now(),
      streaming: true,
      webSearch: true,
    }
    const modelCatalog = [{ id: 'secure-model', capabilities: { streaming: true, webSearch: true } }]
    const untrusted = await store.saveApiSource({
      name: 'Unbound probe evidence',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://unbound.example/v1',
      protocol: 'openai-chat',
      models: ['secure-model'],
      credential: 'unbound-secret',
      priority: 10,
      weight: 10,
      maxConcurrency: 4,
      capabilityProfile,
      modelCatalog,
      probeEvidenceToken: 'renderer-controlled-token',
    })
    expect(store.getRuntimeProvider(untrusted.source.sourceId)?.capabilityProfile).toMatchObject({ origin: 'inferred' })
    expect(store.getRuntimeProvider(untrusted.source.sourceId)?.modelCatalog)
      .not.toContainEqual(expect.objectContaining({ capabilities: expect.objectContaining({ webSearch: true }) }))

    const trusted = await store.saveApiSource({
      name: 'Bound probe evidence',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://bound.example/v1',
      protocol: 'openai-chat',
      models: ['secure-model'],
      credential: 'bound-secret',
      priority: 10,
      weight: 10,
      maxConcurrency: 4,
      capabilityProfile,
      modelCatalog,
      probeEvidenceToken: 'still-not-forwarded-to-storage',
    }, { acceptInitialProbeEvidence: true })
    expect(store.getRuntimeProvider(trusted.source.sourceId)?.capabilityProfile).toMatchObject({
      origin: 'probed',
      webSearch: true,
    })
  })

  it('routes directly through an API source using a runtime-only virtual pool', async () => {
    const store = createStore()
    await store.initialize()
    const saved = await store.saveApiSource({
      name: 'Direct relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-chat',
      models: ['relay-model'],
      credential: 'relay-secret',
      priority: 3,
      weight: 4,
      maxConcurrency: 5
    })
    const route = saved.snapshot.routes.find((candidate) => candidate.client === 'codex')!
    const routed = await store.updateRoute({ ...route, enabled: true, poolId: saved.source.sourceId })

    expect(routed.routes.find((candidate) => candidate.id === route.id)).toMatchObject({
      enabled: true,
      poolId: saved.source.sourceId
    })
    expect(routed.pools.some((pool) => pool.id === saved.source.sourceId)).toBe(false)
    expect(store.getRuntimeConfiguration().pools.find((pool) => pool.id === saved.source.sourceId)).toMatchObject({
      name: 'Direct relay',
      kind: 'standard',
      protocol: 'openai-chat',
      strategy: 'priority',
      members: [{ accountId: saved.source.accountId, enabled: true, order: 0, weight: 1 }],
      maxRetries: 0
    })

    const deleted = await store.deleteApiSource(saved.source.sourceId)
    expect(deleted.routes.find((candidate) => candidate.id === route.id)).toMatchObject({
      enabled: false,
      poolId: '',
      localToken: route.localToken
    })
  })

  it('persists FAST for pools and standalone relays and exposes it through the runtime virtual pool', async () => {
    const store = createStore()
    await store.initialize()
    const saved = await store.saveApiSource({
      name: 'FAST relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://fast-relay.example/v1',
      protocol: 'openai-chat',
      models: ['relay-model'],
      credential: 'relay-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 2
    })
    await store.setRouteSourceFastMode({ sourceId: saved.source.sourceId, enabled: true })
    const official = await store.saveApiSource({
      name: 'FAST official API',
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-4.1'],
      credential: 'official-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 2
    })
    const pooled = await store.savePool({
      name: 'FAST pool',
      protocol: 'openai-chat',
      strategy: 'priority',
      accountIds: [official.source.accountId],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0
    })
    const poolId = pooled.pools.find((pool) => pool.name === 'FAST pool')!.id
    await store.setRouteSourceFastMode({ sourceId: poolId, enabled: true })
    const route = store.getSnapshot().routes.find((candidate) => candidate.client === 'codex')!
    await store.updateRoute({ ...route, enabled: true, poolId: saved.source.sourceId })

    expect(store.getSnapshot().providers.find((provider) => provider.id === saved.source.sourceId)?.forceFastMode).toBe(true)
    expect(store.getRuntimeConfiguration().pools.find((pool) => pool.id === saved.source.sourceId)?.forceFastMode).toBe(true)
    expect(store.getSnapshot().pools.find((pool) => pool.id === poolId)?.forceFastMode).toBe(true)
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().providers.find((provider) => provider.id === saved.source.sourceId)?.forceFastMode).toBe(true)
    expect(restarted.getRuntimeConfiguration().pools.find((pool) => pool.id === saved.source.sourceId)?.forceFastMode).toBe(true)
    expect(restarted.getSnapshot().pools.find((pool) => pool.id === poolId)?.forceFastMode).toBe(true)

    await expect(restarted.setRouteSourceFastMode({ sourceId: 'provider-anthropic', enabled: true }))
      .rejects.toThrow(/only for relay sources/)
    await expect(restarted.setRouteSourceFastMode({ sourceId: 'missing', enabled: true }))
      .rejects.toThrow(/not found/)
  })

  it('imports ChatGPT OAuth sessions as encrypted Codex accounts', async () => {
    const store = createStore()
    await store.initialize()
    const expiresAt = Date.now() + 3_600_000
    const content = JSON.stringify({
      access_token: 'oauth-access-private',
      refresh_token: '',
      account_id: 'acct-team-import',
      email: 'team@example.com',
      expired: new Date(expiresAt).toISOString()
    })
    const imported = await store.importChatGptAccounts({ providerId: 'provider-openai', content })
    const account = imported.snapshot.accounts.find((candidate) => candidate.id === imported.importedAccountIds[0])!
    expect(account).toMatchObject({
      credentialType: 'chatgpt-oauth',
      name: 'team@example.com', renewable: false, maskedCredential: 'chatgpt-****port'
    })
    expect(account).not.toHaveProperty('chatgptAccountId')
    expect(account).not.toHaveProperty('credentialId')
    expect(JSON.stringify(imported.snapshot)).not.toContain('oauth-access-private')
    expect(JSON.stringify(imported.snapshot)).not.toContain('acct-team-import')
    expect(store.getChatGptCredential(store.getRuntimeAccount(account.id)!.credentialId)).toMatchObject({ accessToken: 'oauth-access-private', accountId: 'acct-team-import' })
    expect(imported.warnings).toHaveLength(1)
  })

  it('manages a single account tag assignment and does not recreate deleted defaults', async () => {
    const store = createStore()
    await store.initialize()
    expect(store.getSnapshot().accountTags.map((tag) => tag.name)).toEqual(['K12', 'Plus'])

    const renamed = await store.saveAccountTag({ id: 'tag-k12', name: 'K12 Team' })
    expect(renamed.accountTags.find((tag) => tag.id === 'tag-k12')?.name).toBe('K12 Team')
    const withCustom = await store.saveAccountTag({ name: 'Custom' })
    const customId = withCustom.accountTags.find((tag) => tag.name === 'Custom')!.id
    const imported = await store.importChatGptAccounts({
      content: JSON.stringify({
        access_token: 'tag-access-private',
        account_id: 'acct-tag-private',
        expired: new Date(Date.now() + 3_600_000).toISOString()
      }),
      tagId: customId,
      poolId: null
    })
    const accountId = imported.importedAccountIds[0]
    expect(imported.snapshot.accounts.find((account) => account.id === accountId)?.tagId).toBe(customId)
    expect((await store.setAccountTags({ accountIds: [accountId], tagId: 'tag-plus' })).accounts
      .find((account) => account.id === accountId)?.tagId).toBe('tag-plus')
    expect((await store.deleteAccountTag('tag-plus')).accounts.find((account) => account.id === accountId)?.tagId)
      .toBeUndefined()
    await store.deleteAccountTag('tag-k12')
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accountTags.map((tag) => tag.name)).toEqual(['Custom'])
  })

  it('does not persist a Tag deleted while an OAuth setup step is being resumed', async () => {
    const store = createStore()
    await store.initialize()
    const started = await store.saveSetupWizardProgress({
      step: 'source-config',
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      tagId: 'tag-plus'
    })
    expect(started.tagId).toBe('tag-plus')

    await store.deleteAccountTag('tag-plus')
    const resumed = await store.saveSetupWizardProgress({
      sessionId: started.sessionId,
      step: 'network',
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      sourceId: 'oauth-account-id',
      tagId: 'tag-plus'
    })
    expect(resumed.tagId).toBeUndefined()
    expect(resumed.sourceMethod).toBe('oauth')
    expect(resumed.sourceId).toBe('oauth-account-id')
  })

  it('starts a fresh wizard session after the current run is discarded', async () => {
    const store = createStore()
    await store.initialize()
    const discarded = await store.saveSetupWizardProgress({
      step: 'network',
      sourceType: 'oauth-system',
      sourceMethod: 'oauth',
      sourceId: 'oauth-account-id',
      tagId: 'tag-plus',
      poolId: 'pool-codex',
      proxyId: 'proxy-oauth',
      model: 'gpt-test',
    })

    await store.discardSetupWizard()
    expect(store.getSetupWizardState()).toBeNull()

    const restarted = await store.saveSetupWizardProgress({ step: 'scan' })
    expect(restarted).toMatchObject({ step: 'scan', completed: false, dismissed: false })
    expect(restarted.sessionId).not.toBe(discarded.sessionId)
    expect(restarted.sourceType).toBeUndefined()
    expect(restarted.sourceMethod).toBeUndefined()
    expect(restarted.sourceId).toBeUndefined()
    expect(restarted.tagId).toBeUndefined()
    expect(restarted.poolId).toBeUndefined()
    expect(restarted.proxyId).toBeUndefined()
    expect(restarted.model).toBeUndefined()
  })

  it('restores an existing route and removes wizard-created resources when setup is discarded', async () => {
    const store = createStore()
    await store.initialize()
    const oldAccountSnapshot = await store.saveAccount({
      providerId: 'provider-openai', name: 'Old route account', credential: 'sk-old-route',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const oldAccount = oldAccountSnapshot.accounts.find((account) => account.name === 'Old route account')!
    const oldPoolSnapshot = await store.savePool({
      name: 'Existing pool', protocol: 'openai-responses', strategy: 'priority', accountIds: [oldAccount.id],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 0,
    })
    const oldPool = oldPoolSnapshot.pools.find((pool) => pool.name === 'Existing pool')!
    const originalRoute = oldPoolSnapshot.routes.find((route) => route.client === 'codex')!
    const routed = await store.updateRoute({
      ...originalRoute, enabled: true, highConcurrencyMode: true, poolId: oldPool.id,
      modelMap: { original: 'original-upstream' }, localToken: 'stable-route-token',
    })
    const before = routed.routes.find((route) => route.client === 'codex')!

    const newAccountSnapshot = await store.saveAccount({
      providerId: 'provider-openai', name: 'Wizard route account', credential: 'sk-wizard-route',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const newAccount = newAccountSnapshot.accounts.find((account) => account.name === 'Wizard route account')!
    const wizard = await store.saveSetupWizardProgress({ step: 'routing' })
    const applied = await store.applySetupRouting({
      sessionId: wizard.sessionId, sourceId: newAccount.id, client: 'codex', model: 'wizard-model',
    })
    expect(applied.routeId).toBe(before.id)
    expect(applied.poolId).not.toBe(oldPool.id)

    await store.discardSetupWizard()
    const after = store.getSnapshot()
    expect(after.routes.find((route) => route.id === before.id)).toMatchObject({
      enabled: before.enabled,
      poolId: before.poolId,
      inboundProtocol: before.inboundProtocol,
      highConcurrencyMode: true,
      modelMap: before.modelMap,
      localToken: 'stable-route-token',
    })
    expect(after.pools.some((pool) => pool.id === applied.poolId)).toBe(false)
  })

  it('overwrites or clears the selected tag on every OAuth reimport', async () => {
    const store = createStore()
    await store.initialize()
    const content = JSON.stringify({
      access_token: 'tag-overwrite-access',
      refresh_token: 'tag-overwrite-refresh',
      account_id: 'acct-tag-overwrite',
      expired: new Date(Date.now() + 3_600_000).toISOString()
    })
    const first = await store.importChatGptAccounts({ content, tagId: 'tag-k12', poolId: null })
    const accountId = first.importedAccountIds[0]
    expect(first.snapshot.accounts.find((account) => account.id === accountId)?.tagId).toBe('tag-k12')
    const cleared = await store.importChatGptAccounts({ content, tagId: null, poolId: null })
    expect(cleared.snapshot.accounts.find((account) => account.id === accountId)?.tagId).toBeUndefined()
  })

  it('adds only explicitly detected OAuth accounts to a compatible standard pool idempotently', async () => {
    const store = createStore()
    await store.initialize()
    const first = await store.importChatGptAccounts({
      content: JSON.stringify({ access_token: 'pool-first', account_id: 'acct-pool-first', expired: new Date(Date.now() + 3_600_000).toISOString() }),
      tagId: null,
      poolId: null
    })
    const poolSnapshot = await store.savePool({
      name: 'Imported OAuth pool',
      protocol: 'openai-responses',
      strategy: 'balanced',
      accountIds: first.importedAccountIds,
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1
    })
    const poolId = poolSnapshot.pools.find((pool) => pool.name === 'Imported OAuth pool')!.id
    const second = await store.importChatGptAccounts({
      content: JSON.stringify({ access_token: 'pool-second', account_id: 'acct-pool-second', expired: new Date(Date.now() + 3_600_000).toISOString() }),
      tagId: null,
      poolId
    })
    const firstAppend = await store.addDetectedChatGptAccountsToPool(poolId, second.importedAccountIds)
    expect(firstAppend).toEqual({ added: 1, alreadyPresent: 0 })
    expect(await store.addDetectedChatGptAccountsToPool(poolId, second.importedAccountIds))
      .toEqual({ added: 0, alreadyPresent: 1 })
    expect(store.getSnapshot().pools.find((pool) => pool.id === poolId)?.members.map((member) => member.accountId))
      .toEqual([...first.importedAccountIds, ...second.importedAccountIds])
  })

  it('exports selected ChatGPT accounts as CPA and Sub2API JSON without exposing secrets in snapshots', async () => {
    const store = createStore()
    await store.initialize()
    const expiresAt = Date.now() + 3_600_000
    const imported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: 'export-access-private',
        refresh_token: 'export-refresh-private',
        id_token: 'export-id-private',
        account_id: 'acct-export-private',
        user_id: 'user-export-private',
        email: 'export@example.com',
        expired: new Date(expiresAt).toISOString()
      })
    })
    const accountId = imported.importedAccountIds[0]

    const cpa = store.exportChatGptAccounts([accountId], 'cpa')
    expect(JSON.parse(cpa.content)).toMatchObject({
      type: 'codex',
      access_token: 'export-access-private',
      refresh_token: 'export-refresh-private',
      account_id: 'acct-export-private',
      user_id: 'user-export-private',
      email: 'export@example.com'
    })
    const sub2api = store.exportChatGptAccounts([accountId], 'sub2api')
    expect(JSON.parse(sub2api.content)).toMatchObject({
      type: 'sub2api-data',
      version: 1,
      accounts: [{
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: 'export-access-private',
          refresh_token: 'export-refresh-private',
          account_id: 'acct-export-private'
        }
      }]
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('export-access-private')
    expect(cpa.exportedAccounts).toBe(1)
    expect(sub2api.exportedAccounts).toBe(1)
  })

  it('keeps access-token-only cards in one workspace separate across batch and repeated imports', async () => {
    const store = createStore()
    await store.initialize()
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const sharedAccountId = 'acct-shared-workspace'
    const entries = [
      {
        access_token: chatGptAccessToken(expiresAtSeconds, sharedAccountId, 'principal-private-a'),
        account_id: sharedAccountId,
        email: 'member-a@example.com'
      },
      {
        access_token: chatGptAccessToken(expiresAtSeconds, sharedAccountId, 'principal-private-b'),
        account_id: sharedAccountId,
        email: 'member-b@example.com'
      }
    ]
    const content = JSON.stringify(entries)

    const first = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify(entries[0])
    })
    expect(first.createdAccountIds).toHaveLength(1)
    expect(first.updatedAccountIds).toEqual([])
    expect(first.importedAccountIds).toEqual(first.createdAccountIds)
    expect(first.snapshot.accounts).toHaveLength(1)

    const second = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify(entries[1])
    })
    expect(second.createdAccountIds).toHaveLength(1)
    expect(second.updatedAccountIds).toEqual([])
    expect(second.snapshot.accounts).toHaveLength(2)
    expect(second.snapshot.accounts.map((account) => account.name)).toEqual([
      'member-a@example.com',
      'member-b@example.com'
    ])
    expect(JSON.stringify(second.snapshot)).not.toContain('principal-private')

    const repeated = await store.importChatGptAccounts({ providerId: 'provider-openai', content })
    const importedIds = [...first.createdAccountIds, ...second.createdAccountIds]
    expect(repeated.createdAccountIds).toEqual([])
    expect(new Set(repeated.updatedAccountIds)).toEqual(new Set(importedIds))
    expect(repeated.snapshot.accounts).toHaveLength(2)

    await store.saveProvider({
      name: 'Second OpenAI Responses',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: []
    })
    const providerIndependent = await store.importChatGptAccounts({ content: JSON.stringify(entries[0]), tagId: null, poolId: null })
    expect(providerIndependent.createdAccountIds).toEqual([])
    expect(providerIndependent.updatedAccountIds).toEqual([first.createdAccountIds[0]])
    expect(providerIndependent.snapshot.accounts).toHaveLength(2)

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts).toHaveLength(2)
  })

  it('preserves a v0.8.0 account and pool binding when another workspace member is imported after restart', async () => {
    const store = createStore()
    await store.initialize()
    const sharedAccountId = 'acct-legacy-shared-workspace'
    const firstExpiresAt = Date.now() + 3_600_000
    const firstAccessToken = chatGptAccessToken(
      Math.floor(firstExpiresAt / 1000),
      sharedAccountId,
      'legacy-member-a'
    )
    const first = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: firstAccessToken,
        refresh_token: 'legacy-refresh-a',
        account_id: sharedAccountId,
        email: 'legacy-member-a@example.com',
        expired: new Date(firstExpiresAt).toISOString()
      })
    })
    const firstAccountId = first.createdAccountIds[0]
    await store.savePool({
      name: 'Legacy workspace pool',
      protocol: 'openai-responses',
      strategy: 'priority',
      accountIds: [firstAccountId],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1
    })

    const credentialId = store.getRuntimeAccount(firstAccountId)!.credentialId
    const legacyBundle = JSON.stringify({
      accessToken: firstAccessToken,
      refreshToken: 'legacy-refresh-a',
      accountId: sharedAccountId,
      email: 'legacy-member-a@example.com',
      expiresAt: firstExpiresAt
    })
    await store.getStateRepository().update((state) => {
      state.credentials[credentialId] = Buffer.from(`vault:${legacyBundle}`, 'utf8').toString('base64')
    })
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    const secondExpiresAt = Date.now() + 7_200_000
    const second = await restarted.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: chatGptAccessToken(
          Math.floor(secondExpiresAt / 1000),
          sharedAccountId,
          'legacy-member-b'
        ),
        refresh_token: 'legacy-refresh-b',
        account_id: sharedAccountId,
        email: 'legacy-member-b@example.com',
        expired: new Date(secondExpiresAt).toISOString()
      })
    })

    expect(second.createdAccountIds).toHaveLength(1)
    expect(second.updatedAccountIds).toEqual([])
    expect(second.snapshot.accounts).toHaveLength(2)
    expect(second.snapshot.accounts.some((account) => account.id === firstAccountId)).toBe(true)
    expect(second.snapshot.pools.find((pool) => pool.name === 'Legacy workspace pool')?.members)
      .toEqual([{ accountId: firstAccountId, enabled: true }])
    expect(restarted.getChatGptCredential(credentialId)).toMatchObject({
      accessToken: firstAccessToken,
      refreshToken: 'legacy-refresh-a',
      accountId: sharedAccountId,
      userId: 'legacy-member-a'
    })
  })

  it('allows OAuth accounts to bind a proxy and preserves the binding when reimported', async () => {
    const store = createStore()
    await store.initialize()
    const withProxy = await store.saveProxy({
      name: 'OAuth proxy',
      protocol: 'https',
      host: '127.0.0.1',
      port: 8443,
      username: 'oauth-proxy-user',
      password: 'oauth-proxy-password-private'
    })
    const proxyId = withProxy.proxies[0].id
    const accountId = 'acct-oauth-proxy-binding'
    const firstAccessToken = chatGptAccessToken(
      Math.floor(Date.now() / 1000) + 3600,
      accountId,
      'proxy-bound-principal'
    )
    const first = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: firstAccessToken,
        refresh_token: 'oauth-refresh-before-reimport',
        account_id: accountId,
        email: 'before@example.com',
        expired: new Date(Date.now() + 3_600_000).toISOString()
      })
    })
    const imported = first.snapshot.accounts.find((account) => account.id === first.importedAccountIds[0])!
    const bound = await store.saveAccount({
      id: imported.id,
      providerId: imported.providerId,
      name: 'Bound OAuth account',
      priority: 7,
      weight: 8,
      maxConcurrency: 3,
      modelAllowlist: ['gpt-5'],
      proxyId
    })
    expect(bound.accounts.find((account) => account.id === imported.id)).toMatchObject({
      proxyId,
      priority: 7,
      weight: 8,
      maxConcurrency: 3
    })

    const secondAccessToken = chatGptAccessToken(
      Math.floor(Date.now() / 1000) + 7200,
      accountId,
      'proxy-bound-principal'
    )
    const secondRefreshToken = 'oauth-refresh-after-reimport'
    const reimported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: secondAccessToken,
        refresh_token: secondRefreshToken,
        account_id: accountId,
        email: 'after@example.com',
        proxy_id: proxyId,
        expired: new Date(Date.now() + 7_200_000).toISOString()
      })
    })
    const account = reimported.snapshot.accounts.find((candidate) => candidate.id === imported.id)!
    expect(reimported.importedAccountIds).toEqual([imported.id])
    expect(reimported.createdAccountIds).toEqual([])
    expect(reimported.updatedAccountIds).toEqual([imported.id])
    expect(account).toMatchObject({ proxyId, priority: 7, weight: 8, maxConcurrency: 3 })
    expect(store.getChatGptCredential(store.getRuntimeAccount(account.id)!.credentialId)).toMatchObject({
      accessToken: secondAccessToken,
      refreshToken: secondRefreshToken,
      accountId
    })

    const accessOnlyReimport = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: secondAccessToken,
        account_id: accountId,
        email: 'access-only@example.com',
        proxy_id: proxyId,
        expired: new Date(Date.now() + 7_200_000).toISOString()
      })
    })
    expect(accessOnlyReimport.updatedAccountIds).toEqual([imported.id])
    expect(accessOnlyReimport.warnings).toEqual([])
    expect(store.getChatGptCredential(store.getRuntimeAccount(account.id)!.credentialId)).toMatchObject({
      accessToken: secondAccessToken,
      refreshToken: secondRefreshToken,
      accountId
    })
    const serialized = JSON.stringify(reimported.snapshot)
    expect(serialized).not.toContain(secondAccessToken)
    expect(serialized).not.toContain(secondRefreshToken)
    expect(serialized).not.toContain(accountId)
    expect(reimported.snapshot.proxies[0]).not.toHaveProperty('credentialId')
    expect(reimported.snapshot.proxies[0]).not.toHaveProperty('password')
  })

  it('applies preserve, batch override, and direct proxy choices to mixed account imports', async () => {
    const store = createStore()
    await store.initialize()
    const firstProxySnapshot = await store.saveProxy({
      name: 'Imported file proxy', protocol: 'socks5', host: '127.0.0.1', port: 7890
    })
    const fileProxyId = firstProxySnapshot.proxies.find((proxy) => proxy.name === 'Imported file proxy')!.id
    const secondProxySnapshot = await store.saveProxy({
      name: 'Batch override proxy', protocol: 'https', host: 'proxy.example.test', port: 8443
    })
    const overrideProxyId = secondProxySnapshot.proxies.find((proxy) => proxy.name === 'Batch override proxy')!.id
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const content = JSON.stringify([
      {
        access_token: chatGptAccessToken(expiresAtSeconds, 'acct-import-proxy-a', 'import-proxy-user-a'),
        refresh_token: 'refresh-import-proxy-a',
        account_id: 'acct-import-proxy-a',
        email: 'proxy-a@example.com',
        proxy_id: fileProxyId
      },
      {
        access_token: chatGptAccessToken(expiresAtSeconds, 'acct-import-proxy-b', 'import-proxy-user-b'),
        refresh_token: 'refresh-import-proxy-b',
        account_id: 'acct-import-proxy-b',
        email: 'proxy-b@example.com',
        proxyId: 'deleted-file-proxy'
      }
    ])

    const preserved = await store.importChatGptAccounts({
      providerId: 'provider-openai', content, proxyMode: 'preserve'
    })
    const preservedAccounts = preserved.importedAccountIds.map((id) =>
      preserved.snapshot.accounts.find((account) => account.id === id)!)
    expect(preservedAccounts.map((account) => account.proxyId)).toEqual([fileProxyId, undefined])
    expect(preserved.warnings.join(' ')).toContain('不存在的文件代理')

    const overridden = await store.importChatGptAccounts({
      providerId: 'provider-openai', content, proxyMode: 'proxy', proxyId: overrideProxyId
    })
    expect(overridden.importedAccountIds.map((id) =>
      overridden.snapshot.accounts.find((account) => account.id === id)?.proxyId
    )).toEqual([overrideProxyId, overrideProxyId])

    const direct = await store.importChatGptAccounts({
      providerId: 'provider-openai', content, proxyMode: 'direct', proxyId: overrideProxyId
    })
    expect(direct.importedAccountIds.map((id) =>
      direct.snapshot.accounts.find((account) => account.id === id)?.proxyId
    )).toEqual([undefined, undefined])
  })

  it('rejects an explicitly selected proxy that disappeared without changing accounts', async () => {
    const store = createStore()
    await store.initialize()
    const withProxy = await store.saveProxy({
      name: 'Temporary import proxy', protocol: 'http', host: '127.0.0.1', port: 8080
    })
    const proxyId = withProxy.proxies.find((proxy) => proxy.name === 'Temporary import proxy')!.id
    await store.deleteProxy(proxyId)
    const before = store.getSnapshot().accounts

    await expect(store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: 'not-saved-private-token',
        account_id: 'acct-not-saved',
        expired: new Date(Date.now() + 3_600_000).toISOString()
      }),
      proxyMode: 'proxy',
      proxyId
    })).rejects.toThrow('代理已被删除')

    expect(store.getSnapshot().accounts).toEqual(before)
    expect(JSON.stringify(store.getSnapshot())).not.toContain('not-saved-private-token')
  })

  it('stores Codex quota history in five-minute buckets and clears it with the account', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Quota account',
      credential: 'sk-quota',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })
    const accountId = created.accounts[0].id
    const bucketStart = 1_800_000_000_000
    await store.setAccountCheckResult(accountId, {
      codexQuota: {
        fiveHour: { usedPercent: 10, resetAt: bucketStart + 18_000_000 },
        sevenDay: { usedPercent: 20, resetAt: bucketStart + 604_800_000 },
        observedAt: bucketStart + 30_000,
        source: 'response-headers'
      }
    })
    await store.setAccountCheckResult(accountId, {
      codexQuota: {
        fiveHour: { usedPercent: 35, resetAt: bucketStart + 18_000_000 },
        sevenDay: { usedPercent: 45, resetAt: bucketStart + 604_800_000 },
        observedAt: bucketStart + 240_000,
        source: 'usage-endpoint'
      }
    })
    await store.setAccountCheckResult(accountId, {
      codexQuota: {
        fiveHour: { usedPercent: 50, resetAt: bucketStart + 18_300_000 },
        sevenDay: { usedPercent: 60, resetAt: bucketStart + 605_100_000 },
        observedAt: bucketStart + 330_000,
        source: 'response-headers'
      }
    })

    expect(store.getAccountCodexQuotaHistory(accountId, bucketStart, bucketStart + 600_000)).toEqual([
      {
        accountId,
        observedAt: bucketStart + 240_000,
        fiveHourUsedPercent: 35,
        fiveHourResetAt: bucketStart + 18_000_000,
        sevenDayUsedPercent: 45,
        sevenDayResetAt: bucketStart + 604_800_000,
        source: 'usage-endpoint'
      },
      {
        accountId,
        observedAt: bucketStart + 330_000,
        fiveHourUsedPercent: 50,
        fiveHourResetAt: bucketStart + 18_300_000,
        sevenDayUsedPercent: 60,
        sevenDayResetAt: bucketStart + 605_100_000,
        source: 'response-headers'
      }
    ])

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getAccountCodexQuotaHistory(accountId, bucketStart, bucketStart + 600_000)).toHaveLength(2)
    await restarted.deleteAccount(accountId)
    expect(restarted.getAccountCodexQuotaHistory(accountId, bucketStart, bucketStart + 600_000)).toEqual([])
    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME), { readOnly: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM account_codex_quota_samples WHERE account_id = ?').get(accountId))
      .toEqual({ count: 0 })
    database.close()
  })

  it('redacts credentials and authentication material before messages are persisted', async () => {
    const store = createStore()
    await store.initialize()
    const accessToken = 'oauth-access-renderer-private'
    const accountId = 'acct-renderer-private'
    const proxyPassword = 'proxy-error-password-private'
    const genericBearer = 'unregistered-bearer-private'
    await store.saveProxy({
      name: 'Error proxy', protocol: 'socks5', host: '127.0.0.1', port: 1080,
      username: 'proxy-user', password: proxyPassword
    })
    const imported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: accessToken,
        account_id: accountId,
        expired: new Date(Date.now() + 3_600_000).toISOString()
      })
    })
    const account = imported.snapshot.accounts.find((candidate) => candidate.id === imported.importedAccountIds[0])!
    const routeToken = imported.snapshot.routes[0].localToken
    await store.setAccountCheckResult(account.id, {
      lastError: `Rejected ${accessToken} for ${accountId}; Bearer ${genericBearer}`
    })
    await store.appendLog({
      ...requestLog(401, 'secret-log'),
      accountId: account.id,
      error: `Proxy http://proxy-user:${proxyPassword}@127.0.0.1 failed`
    })
    await store.appendHealthEvent({
      id: 'secret-health', timestamp: Date.now(), accountId: account.id, accountName: account.name,
      providerName: 'OpenAI', kind: 'account-disabled', severity: 'error',
      message: `Health ${accessToken} ${accountId}; password=${proxyPassword}; credential=${routeToken}`
    })

    const safeSnapshot = store.getSnapshot()
    const serialized = JSON.stringify({
      accountError: safeSnapshot.accounts.find((candidate) => candidate.id === account.id)?.lastError,
      logError: safeSnapshot.requestLogs.find((log) => log.id === 'secret-log')?.error,
      healthMessage: safeSnapshot.healthEvents.find((event) => event.id === 'secret-health')?.message
    })
    for (const secret of [accessToken, accountId, proxyPassword, genericBearer, routeToken]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain('[REDACTED]')

    await store.close()
    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME), { readOnly: true })
    const accountRow = database.prepare('SELECT payload FROM accounts WHERE id = ?').get(account.id) as { payload: string }
    const logRow = database.prepare('SELECT payload FROM request_logs WHERE id = ?').get('secret-log') as { payload: string }
    const healthRow = database.prepare('SELECT payload FROM health_events WHERE id = ?').get('secret-health') as { payload: string }
    const persisted = JSON.stringify({
      accountError: (JSON.parse(accountRow.payload) as { lastError?: string }).lastError,
      logError: (JSON.parse(logRow.payload) as { error?: string }).error,
      healthMessage: (JSON.parse(healthRow.payload) as { message?: string }).message
    })
    database.close()
    for (const secret of [accessToken, accountId, proxyPassword, genericBearer, routeToken]) {
      expect(persisted).not.toContain(secret)
    }
    expect(persisted).toContain('[REDACTED]')
  })

  it('persists health events and exposes hourly observability buckets', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendHealthEvent({
      id: 'health-one', timestamp: Date.now(), accountId: 'account-one', accountName: 'Primary',
      providerName: 'Provider', kind: 'account-cooldown', severity: 'warning', message: 'Cooling down'
    })
    await store.appendLog({ ...requestLog(1, 'hourly-log'), timestamp: Date.now(), inputTokens: 4 })
    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().healthEvents).toContainEqual(expect.objectContaining({ id: 'health-one' }))
    expect(restarted.getSnapshot().observability.hourly).toHaveLength(24)
    expect(restarted.getSnapshot().observability.hourly.at(-1)).toMatchObject({ requestCount: 1, inputTokens: 4 })
  })

  it('round-trips request phase timings while keeping legacy logs compatible', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog(requestLog(1, 'legacy-phase-log'))
    await store.appendLog({
      ...requestLog(2, 'segmented-phase-log'),
      bodyReadMs: 12,
      schedulerSelectMs: 3,
      credentialResolveMs: 27,
      outboundFetchStartMs: 58,
      upstreamHeadersMs: 1_240
    })
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    const segmented = restarted.getSnapshot().requestLogs.find((log) => log.id === 'segmented-phase-log')
    expect(segmented).toMatchObject({
      bodyReadMs: 12,
      schedulerSelectMs: 3,
      credentialResolveMs: 27,
      outboundFetchStartMs: 58,
      upstreamHeadersMs: 1_240
    })
    const legacy = restarted.getSnapshot().requestLogs.find((log) => log.id === 'legacy-phase-log')
    expect(legacy).toBeDefined()
    expect(legacy).not.toHaveProperty('bodyReadMs')
    expect(legacy).not.toHaveProperty('schedulerSelectMs')
    expect(legacy).not.toHaveProperty('credentialResolveMs')
    expect(legacy).not.toHaveProperty('outboundFetchStartMs')
  })

  it('aggregates successful request generation speed for every overview time range', async () => {
    const timestamp = Date.now() - 90_000
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(1, 'rate-ten'),
      timestamp,
      latencyMs: 5_000,
      upstreamFirstByteMs: 1_000,
      firstTokenMs: 4_500,
      outputTokens: 40
    })
    await store.appendLog({
      ...requestLog(2, 'rate-twenty'),
      timestamp,
      latencyMs: 6_000,
      firstTokenMs: 1_000,
      outputTokens: 100
    })
    await store.appendLog({
      ...requestLog(3, 'rate-error'),
      timestamp,
      status: 'error',
      latencyMs: 2_000,
      firstTokenMs: 500,
      outputTokens: 1_000
    })

    const tokenRates = store.getSnapshot().observability.tokenRates
    for (const series of Object.values(tokenRates)) {
      const populated = series.filter((point) => point.requestCount > 0)
      expect(populated).toHaveLength(1)
      expect(populated[0]).toMatchObject({ requestCount: 2, outputTokens: 140, tokensPerSecond: 15 })
    }
    expect(tokenRates.last30Minutes).toHaveLength(30)
    expect(tokenRates.last4Hours).toHaveLength(48)
    expect(tokenRates.last24Hours).toHaveLength(48)
    expect(tokenRates.last7Days).toHaveLength(56)
  })

  it('recomputes observability at most once per second while logs are arriving', async () => {
    let now = 1_800_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const store = createStore()
      await store.initialize()
      expect(store.getSnapshot().observability.last24Hours.requestCount).toBe(0)

      await store.appendLog({ ...requestLog(1, 'cached-observability'), timestamp: now })
      expect(store.getSnapshot().observability.last24Hours.requestCount).toBe(0)

      now += 1_001
      expect(store.getSnapshot().observability.last24Hours.requestCount).toBe(1)
      const internals = store as unknown as { observabilityCache?: object }
      const stableCache = internals.observabilityCache
      await store.appendLog({
        ...requestLog(2, 'live-does-not-invalidate-observability'),
        timestamp: now,
        status: 'streaming'
      })
      now += 5_000
      store.getSnapshot()
      expect(internals.observabilityCache).toBe(stableCache)

      now += 55_001
      store.getSnapshot()
      expect(internals.observabilityCache).not.toBe(stableCache)
      await store.close()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not allow an existing client profile to change clients', async () => {
    const store = createStore()
    await store.initialize()
    const originalDirectory = join(directory, 'work-codex')
    const saved = await store.saveClientProfile({
      name: 'Work Codex',
      client: 'codex',
      directory: originalDirectory,
      backupRetention: 7
    })
    const original = saved.clientProfiles.find((candidate) => candidate.name === 'Work Codex')!

    await expect(store.saveClientProfile({
      id: original.id,
      name: 'Moved to Claude',
      client: 'claude',
      directory: join(directory, 'work-claude'),
      backupRetention: 3
    })).rejects.toThrow(/cannot change its client/)

    expect(store.getSnapshot().clientProfiles.find((candidate) => candidate.id === original.id)).toMatchObject({
      name: 'Work Codex',
      client: 'codex',
      directory: originalDirectory,
      backupRetention: 7,
      updatedAt: original.updatedAt
    })

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().clientProfiles.find((candidate) => candidate.id === original.id)).toMatchObject({
      name: 'Work Codex',
      client: 'codex',
      directory: originalDirectory,
      backupRetention: 7,
      updatedAt: original.updatedAt
    })
  })

  it('cascades account removal from pools while still blocking other referenced deletes', async () => {
    const store = createStore()
    await store.initialize()
    const withAccount = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Referenced key',
      credential: 'sk-test',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })
    const accountId = withAccount.accounts[0].id
    await expect(store.deleteProvider('provider-openai')).rejects.toThrow(/accounts/)

    const withPool = await store.savePool({
      name: 'Referenced pool',
      protocol: 'openai-responses',
      strategy: 'priority',
      accountIds: [accountId],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1
    })
    const withSecondAccount = await store.saveAccount({
      providerId: 'provider-openai', name: 'Unreferenced key', credential: 'sk-second',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const secondAccountId = withSecondAccount.accounts.find((account) => account.name === 'Unreferenced key')!.id
    const afterAccountDelete = await store.deleteAccounts([accountId, secondAccountId])
    expect(afterAccountDelete.accounts.map((account) => account.id)).not.toContain(accountId)
    expect(afterAccountDelete.accounts.map((account) => account.id)).not.toContain(secondAccountId)
    expect(afterAccountDelete.pools.find((pool) => pool.id === withPool.pools[0].id)?.members).toEqual([])

    const route = withPool.routes.find((candidate) => candidate.client === 'codex')!
    await store.updateRoute({ ...route, poolId: withPool.pools[0].id, enabled: false })
    await expect(store.deletePool(withPool.pools[0].id)).rejects.toThrow(/routes/)
  })

  it('imports legacy JSON once, retains a backup, and does not import a later source again', async () => {
    const legacy = legacyJsonState()
    const legacyPath = join(directory, LEGACY_JSON_FILENAME)
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    const store = createStore()
    await store.initialize()
    expect(store.getSnapshot()).toMatchObject({
      providers: [{ id: 'legacy-provider', name: 'Legacy Provider' }],
      accounts: [{ id: 'legacy-account', maskedCredential: '****cret' }],
      requestLogs: [{ id: 'legacy-log' }],
      gateway: { outboundNetworkMode: 'direct' },
      clientProfiles: [
        { id: 'default-claude' },
        { id: 'default-codex' },
        { id: 'default-gemini' }
      ]
    })
    expect(store.getCredential('legacy-credential')).toBe('legacy-secret')
    await store.close()

    const files = await readdir(directory)
    const backupName = files.find((name) => name.startsWith(`${LEGACY_JSON_FILENAME}.migrated`) && name.endsWith('.bak'))
    expect(backupName).toBeDefined()
    expect(JSON.parse(await readFile(join(directory, backupName!), 'utf8'))).toEqual(legacy)

    const markerDatabase = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    const marker = markerDatabase.prepare("SELECT value FROM app_metadata WHERE key = 'legacy_json_import'").get() as
      | { value: string }
      | undefined
    markerDatabase.close()
    expect(JSON.parse(marker?.value ?? '{}')).toMatchObject({ source: legacyPath })

    await writeFile(legacyPath, `${JSON.stringify({ ...legacy, providers: [] })}\n`, 'utf8')
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().providers).toHaveLength(1)
    expect(restarted.getSnapshot().providers[0].id).toBe('legacy-provider')
  })

  it('serializes concurrent updates and retains only the newest 500 logs after restart', async () => {
    const store = createStore()
    await store.initialize()

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.saveProvider({
      name: `Compatible ${index}`,
      kind: 'openai-compatible',
      baseUrl: `https://provider-${index}.example.test/v1`,
      protocol: 'openai-chat',
      models: []
    })))
    await store.close()

    const stateStore = createStateStore(legacyState())
    await stateStore.initialize()
    await stateStore.update((state) => {
      state.requestLogs = Array.from({ length: 510 }, (_, index) => requestLog(509 - index))
    })
    await stateStore.close()

    const restarted = createStore()
    await restarted.initialize()
    const snapshot = restarted.getSnapshot()
    expect(snapshot.providers.filter((provider) => provider.name.startsWith('Compatible '))).toHaveLength(12)
    expect(snapshot.requestLogs).toHaveLength(500)
    expect(snapshot.requestLogs[0].id).toBe('log-509')
    expect(snapshot.requestLogs.at(-1)?.id).toBe('log-10')
  })

  it('persists account model catalogs and validates a selected pool against the member union', async () => {
    const store = createStore()
    await store.initialize()
    const first = await store.saveAccount({
      providerId: 'provider-openai', name: 'GPT primary', credential: 'primary-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const firstId = first.accounts.find((account) => account.name === 'GPT primary')!.id
    await store.setAccountModels(firstId, ['gpt-5.5'])

    const second = await store.saveAccount({
      providerId: 'provider-openai', name: 'GPT expanded', credential: 'expanded-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const secondId = second.accounts.find((account) => account.name === 'GPT expanded')!.id
    await store.setAccountModels(secondId, ['gpt-5.5', 'gpt-5.5-mini'])

    const saved = await store.savePool({
      name: 'GPT union', protocol: 'openai-responses', strategy: 'balanced',
      accountIds: [firstId, secondId], modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini'],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })
    expect(saved.pools.find((pool) => pool.name === 'GPT union')).toMatchObject({
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini']
    })
    await expect(store.savePool({
      name: 'Invalid union', protocol: 'openai-responses', strategy: 'balanced',
      accountIds: [firstId, secondId], modelPolicy: 'selected', modelAllowlist: ['gpt-unavailable'],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })).rejects.toThrow(/not available from its accounts/)

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts.find((account) => account.id === secondId)).toMatchObject({
      availableModels: ['gpt-5.5', 'gpt-5.5-mini'],
      modelPolicy: 'all'
    })
    expect(restarted.getSnapshot().pools.find((pool) => pool.name === 'GPT union')?.modelAllowlist)
      .toEqual(['gpt-5.5', 'gpt-5.5-mini'])
  })

  it('prunes selected account and pool models transactionally after an authoritative refresh', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai', name: 'Changing catalog', credential: 'catalog-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const accountId = created.accounts.find((account) => account.name === 'Changing catalog')!.id
    await store.setAccountModels(accountId, ['gpt-5.5', 'gpt-5.5-mini'])
    await store.saveAccount({
      id: accountId, providerId: 'provider-openai', name: 'Changing catalog',
      priority: 1, weight: 1, maxConcurrency: 1, modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini']
    })
    await store.savePool({
      name: 'Changing pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [accountId], modelPolicy: 'selected', modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini'],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })

    const refreshed = await store.setAccountModels(accountId, ['gpt-5.5', 'gpt-5.5-nano'])
    expect(refreshed.accounts.find((account) => account.id === accountId)).toMatchObject({
      availableModels: ['gpt-5.5', 'gpt-5.5-nano'],
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5']
    })
    expect(refreshed.pools.find((pool) => pool.name === 'Changing pool')).toMatchObject({
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5']
    })
  })

  it('rejects stale account model discovery after account or provider configuration changes', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai', name: 'Revision account', credential: 'revision-secret-one',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const account = created.accounts.find((candidate) => candidate.name === 'Revision account')!
    const beforeCredentialChange = store.getAccountModelDiscoveryFingerprint(account.id)

    await store.saveAccount({
      id: account.id, providerId: account.providerId, name: account.name,
      credential: 'revision-secret-two', priority: 1, weight: 1, maxConcurrency: 1,
      modelPolicy: 'all', modelAllowlist: []
    })
    await expect(store.setAccountModels(account.id, ['stale-credential-model'], beforeCredentialChange))
      .rejects.toThrow(/configuration changed while models were refreshing/)
    expect(store.getSnapshot().accounts.find((candidate) => candidate.id === account.id)).toMatchObject({
      availableModels: [], modelsRefreshedAt: undefined
    })

    const beforeProviderChange = store.getAccountModelDiscoveryFingerprint(account.id)
    const provider = store.getSnapshot().providers.find((candidate) => candidate.id === account.providerId)!
    await store.saveProvider({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: 'https://api.openai.com/v2',
      protocol: provider.protocol,
      models: provider.models
    })
    await expect(store.setAccountModels(account.id, ['stale-provider-model'], beforeProviderChange))
      .rejects.toThrow(/configuration changed while models were refreshing/)
  })

  it('keeps the discovery fingerprint stable across internal OAuth token rotation', async () => {
    const store = createStore()
    await store.initialize()
    const accountId = 'acct-oauth-model-revision'
    const imported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: 'oauth-model-access-one',
        refresh_token: 'oauth-model-refresh-one',
        account_id: accountId,
        expired: new Date(Date.now() + 3_600_000).toISOString()
      })
    })
    const id = imported.importedAccountIds[0]
    const fingerprint = store.getAccountModelDiscoveryFingerprint(id)
    await store.appendLog(requestLog(1, 'credential-rotation-log'))
    // A full-state persistence would DELETE and recreate request_logs. Keep a guard
    // on that table to prove OAuth rotation only touches the credential + account rows.
    const guardDatabase = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    guardDatabase.exec(`
      CREATE TRIGGER reject_request_log_delete
      BEFORE DELETE ON request_logs
      BEGIN
        SELECT RAISE(ABORT, 'credential rotation rewrote request history');
      END;
    `)
    guardDatabase.close()

    await store.updateChatGptCredential(id, JSON.stringify({
      accessToken: 'oauth-model-access-two',
      refreshToken: 'oauth-model-refresh-two',
      accountId,
      expiresAt: Date.now() + 7_200_000
    }))
    const cleanupGuardDatabase = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    cleanupGuardDatabase.exec('DROP TRIGGER reject_request_log_delete')
    cleanupGuardDatabase.close()

    expect(store.getAccountModelDiscoveryFingerprint(id)).toBe(fingerprint)
    await expect(store.setAccountModels(id, ['gpt-oauth-current'], fingerprint)).resolves.toMatchObject({
      accounts: [expect.objectContaining({ id, availableModels: ['gpt-oauth-current'] })]
    })
  })

  it('atomically rejects a stale concurrent OAuth rotation', async () => {
    const store = createStore()
    await store.initialize()
    const imported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: 'oauth-race-original', refresh_token: 'oauth-race-refresh',
        account_id: 'acct-oauth-race', expired: new Date(Date.now() + 60_000).toISOString()
      })
    })
    const id = imported.importedAccountIds[0]
    const first = store.updateChatGptCredential(id, JSON.stringify({
      accessToken: 'oauth-race-winner', refreshToken: 'oauth-race-rotated',
      accountId: 'acct-oauth-race', expiresAt: Date.now() + 3_600_000
    }))
    const stale = store.updateChatGptCredential(id, JSON.stringify({
      accessToken: 'oauth-race-stale', refreshToken: 'oauth-race-stale-refresh',
      accountId: 'acct-oauth-race', expiresAt: Date.now() + 3_600_000
    }))

    await first
    await expect(stale).rejects.toThrow('credential changed while it was being rotated')
    expect(store.getChatGptCredential(store.getRuntimeAccount(id)!.credentialId)).toMatchObject({
      accessToken: 'oauth-race-winner', refreshToken: 'oauth-race-rotated'
    })
  })

  it('does not let a background refresh overwrite a credential edited after refresh started', async () => {
    const store = createStore()
    await store.initialize()
    const imported = await store.importChatGptAccounts({
      providerId: 'provider-openai',
      content: JSON.stringify({
        access_token: 'oauth-background-old', refresh_token: 'oauth-background-old-refresh',
        account_id: 'acct-background-cas', expired: new Date(Date.now() + 60_000).toISOString()
      })
    })
    const id = imported.importedAccountIds[0]
    const account = store.getRuntimeAccount(id)!
    const sourceSerialized = store.getCredential(account.credentialId)!
    const editedSerialized = JSON.stringify({
      accessToken: 'oauth-user-edited', refreshToken: 'oauth-user-edited-refresh',
      accountId: 'acct-background-cas', expiresAt: Date.now() + 7_200_000
    })
    await store.updateChatGptCredential(id, editedSerialized)

    await expect(store.updateChatGptCredential(id, JSON.stringify({
      accessToken: 'oauth-stale-background-result', refreshToken: 'oauth-stale-background-refresh',
      accountId: 'acct-background-cas', expiresAt: Date.now() + 3_600_000
    }), sourceSerialized)).rejects.toThrow('credential changed while it was being rotated')
    expect(store.getChatGptCredential(account.credentialId)).toMatchObject({
      accessToken: 'oauth-user-edited', refreshToken: 'oauth-user-edited-refresh'
    })
  })

  it('does not prune selected pool models from non-authoritative provider fallback changes', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai', name: 'Rotating key', credential: 'rotating-secret-one',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const account = created.accounts.find((candidate) => candidate.name === 'Rotating key')!
    await store.setAccountModels(account.id, ['account-only-model'])
    await store.savePool({
      name: 'Fallback-safe pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [account.id], modelPolicy: 'selected', modelAllowlist: ['account-only-model'],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })

    await store.saveAccount({
      id: account.id, providerId: account.providerId, name: account.name,
      credential: 'rotating-secret-two', priority: 1, weight: 1, maxConcurrency: 1,
      modelPolicy: 'all', modelAllowlist: []
    })
    const provider = store.getSnapshot().providers.find((candidate) => candidate.id === account.providerId)!
    await store.saveProvider({
      id: provider.id, name: provider.name, kind: provider.kind,
      baseUrl: provider.baseUrl, protocol: provider.protocol, models: ['fallback-replacement']
    })
    await store.setProviderModels(provider.id, ['another-fallback'])
    expect(store.getSnapshot().pools.find((pool) => pool.name === 'Fallback-safe pool')).toMatchObject({
      modelPolicy: 'selected', modelAllowlist: ['account-only-model']
    })

    const refreshed = await store.setAccountModels(account.id, ['authoritative-replacement'])
    expect(refreshed.pools.find((pool) => pool.name === 'Fallback-safe pool')).toMatchObject({
      modelPolicy: 'selected', modelAllowlist: []
    })
  })

  it('normalizes legacy model fields without broadening a non-empty account allowlist', async () => {
    const store = createStore()
    await store.initialize()
    const selected = await store.saveAccount({
      providerId: 'provider-openai', name: 'Legacy selected', credential: 'legacy-selected-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: ['legacy-model']
    })
    const selectedId = selected.accounts.find((account) => account.name === 'Legacy selected')!.id
    const all = await store.saveAccount({
      providerId: 'provider-openai', name: 'Legacy all', credential: 'legacy-all-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const allId = all.accounts.find((account) => account.name === 'Legacy all')!.id
    const pooled = await store.savePool({
      name: 'Legacy pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [selectedId, allId], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })
    const poolId = pooled.pools.find((pool) => pool.name === 'Legacy pool')!.id
    await store.close()

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const database = new DatabaseSync(databasePath)
    for (const accountId of [selectedId, allId]) {
      const row = database.prepare('SELECT payload FROM accounts WHERE id = ?').get(accountId) as { payload: string }
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      delete payload.availableModels
      delete payload.modelsRefreshedAt
      delete payload.modelPolicy
      database.prepare('UPDATE accounts SET payload = ? WHERE id = ?').run(JSON.stringify(payload), accountId)
    }
    const poolRow = database.prepare('SELECT payload FROM pools WHERE id = ?').get(poolId) as { payload: string }
    const poolPayload = JSON.parse(poolRow.payload) as Record<string, unknown>
    delete poolPayload.modelPolicy
    delete poolPayload.modelAllowlist
    database.prepare('UPDATE pools SET payload = ? WHERE id = ?').run(JSON.stringify(poolPayload), poolId)
    database.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts.find((account) => account.id === selectedId)).toMatchObject({
      availableModels: [], modelPolicy: 'selected', modelAllowlist: ['legacy-model']
    })
    expect(restarted.getSnapshot().accounts.find((account) => account.id === allId)).toMatchObject({
      availableModels: [], modelPolicy: 'all', modelAllowlist: []
    })
    expect(restarted.getSnapshot().pools.find((pool) => pool.id === poolId)).toMatchObject({
      modelPolicy: 'all', modelAllowlist: []
    })
    await restarted.close()

    const persisted = new DatabaseSync(databasePath, { readOnly: true })
    const persistedAccount = JSON.parse((persisted.prepare('SELECT payload FROM accounts WHERE id = ?')
      .get(selectedId) as { payload: string }).payload) as Record<string, unknown>
    const persistedPool = JSON.parse((persisted.prepare('SELECT payload FROM pools WHERE id = ?')
      .get(poolId) as { payload: string }).payload) as Record<string, unknown>
    persisted.close()
    expect(persistedAccount).toMatchObject({ availableModels: [], modelPolicy: 'selected' })
    expect(persistedPool).toMatchObject({ modelPolicy: 'all', modelAllowlist: [] })
  })

  it('appends request logs incrementally and preserves observability across restarts', async () => {
    const now = Date.now()
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(0, 'outside-window'),
      timestamp: now - 8 * 24 * 60 * 60 * 1000
    })
    await store.appendLog({
      ...requestLog(1, 'recent-success'),
      timestamp: now - 60_000,
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 4,
      reasoningTokens: 2,
      failoverCount: 1
    })
    await store.appendLog({
      ...requestLog(2, 'recent-error'),
      timestamp: now - 120_000,
      status: 'error',
      statusCode: 429,
      inputTokens: 3,
      outputTokens: 1
    })
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    const snapshot = restarted.getSnapshot()
    expect(snapshot.requestLogs.map((log) => log.id)).toEqual(['recent-error', 'recent-success', 'outside-window'])
    expect(snapshot.observability.last24Hours).toMatchObject({
      requestCount: 2,
      successCount: 1,
      errorCount: 1,
      inputTokens: 15,
      outputTokens: 6,
      cachedInputTokens: 4,
      reasoningTokens: 2,
      failoverCount: 1,
      errorsByStatus: { 429: 1 }
    })
    expect(snapshot.observability.last7Days.requestCount).toBe(2)
  })

  it('derives a bounded moving-fitness history from existing persisted request logs', async () => {
    const now = Date.now()
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(0, 'fitness-success'), accountId: 'account-a', timestamp: now - 60_000
    })
    await store.appendLog({
      ...requestLog(1, 'fitness-failure'), accountId: 'account-a', timestamp: now - 120_000,
      status: 'error', statusCode: 429
    })
    await store.appendLog({
      ...requestLog(2, 'fitness-old'), accountId: 'account-a', timestamp: now - 31 * 24 * 60 * 60_000
    })
    await store.appendLog({
      ...requestLog(3, 'fitness-unattributed'), timestamp: now - 30_000
    })
    await store.close()

    const restarted = createStore()
    await restarted.initialize()

    expect(restarted.getAccountFitnessHistory(now).map((log) => log.id)).toEqual([
      'fitness-failure',
      'fitness-success'
    ])
  })

  it('calculates token cost totals from the full persisted log set, not the renderer slice', async () => {
    const now = Date.now()
    const store = createStore()
    await store.initialize()
    await Promise.all(Array.from({ length: 501 }, (_, index) => store.appendLog({
      ...requestLog(index, `priced-log-${index}`),
      timestamp: now,
      model: 'gpt-5.6-sol',
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100
    })))

    const snapshot = store.getSnapshot()
    expect(snapshot.requestLogs).toHaveLength(500)
    expect(snapshot.observability.tokenCosts.today).toMatchObject({
      totalTokens: 551_100,
      standardInputTokens: 300_600,
      cachedInputTokens: 200_400,
      outputTokens: 50_100,
      pricedRequestCount: 501,
      unpricedTokens: 0
    })
    expect(snapshot.observability.tokenCosts.allTime.totalCostUsd).toBeCloseTo(3.1062, 10)
  })

  it('keeps all-time token costs across log clearing, continues accumulating, and survives restart', async () => {
    let now = new Date(2026, 6, 23, 12, 0, 0).getTime()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const store = createStore()
      await store.initialize()
      await store.appendLog({
        ...requestLog(1, 'lifetime-before-clear'),
        timestamp: now,
        model: 'gpt-5.6-sol',
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 100
      })

      now += 1_001
      const beforeClear = store.getSnapshot().observability.tokenCosts
      expect(beforeClear.today.totalTokens).toBe(1_100)
      expect(beforeClear.allTime).toMatchObject({
        totalTokens: 1_100,
        inputTokens: 1_000,
        outputTokens: 100,
        standardInputTokens: 600,
        cachedInputTokens: 400,
        pricedRequestCount: 1
      })

      await store.clearLogs()
      now += 1_001
      const afterClear = store.getSnapshot().observability.tokenCosts
      expect(afterClear.allTime).toEqual(beforeClear.allTime)
      // "Today" deliberately remains a view of the currently retained logs;
      // clearing request history only preserves the separate lifetime ledger.
      expect(afterClear.today.totalTokens).toBe(0)

      await store.appendLog({
        ...requestLog(2, 'lifetime-after-clear'),
        timestamp: now,
        model: 'gpt-5.6-sol',
        inputTokens: 200,
        cachedInputTokens: 50,
        outputTokens: 20
      })
      now += 1_001
      const afterAppend = store.getSnapshot().observability.tokenCosts
      expect(afterAppend.today).toMatchObject({
        totalTokens: 220,
        inputTokens: 200,
        outputTokens: 20,
        standardInputTokens: 150,
        cachedInputTokens: 50,
        pricedRequestCount: 1
      })
      expect(afterAppend.allTime).toMatchObject({
        totalTokens: 1_320,
        inputTokens: 1_200,
        outputTokens: 120,
        standardInputTokens: 750,
        cachedInputTokens: 450,
        pricedRequestCount: 2
      })
      expect(afterAppend.allTime.totalCostUsd).toBeGreaterThan(beforeClear.allTime.totalCostUsd)

      await store.close()
      const restarted = createStore()
      await restarted.initialize()
      const afterRestart = restarted.getSnapshot().observability.tokenCosts
      expect(afterRestart.allTime).toEqual(afterAppend.allTime)
      expect(afterRestart.today).toEqual(afterAppend.today)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('seeds the lifetime ledger from retained logs when upgrading a database without ledger metadata', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(1, 'pre-ledger-token-log'),
      model: 'gpt-5.6-sol',
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100
    })
    await store.close()

    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    database.prepare("DELETE FROM app_metadata WHERE key = 'lifetime_token_costs_v1'").run()
    database.close()

    const upgraded = createStore()
    await upgraded.initialize()
    expect(upgraded.getSnapshot().observability.tokenCosts.allTime).toMatchObject({
      totalTokens: 1_100,
      inputTokens: 1_000,
      outputTokens: 100,
      standardInputTokens: 600,
      cachedInputTokens: 400,
      pricedRequestCount: 1
    })
  })

  it('does not silently replace a corrupted lifetime ledger with only the retained log fragment', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(1, 'corrupt-ledger-token-log'),
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      outputTokens: 10
    })
    await store.close()

    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    database.prepare(`
      UPDATE app_metadata SET value = '{}' WHERE key = 'lifetime_token_costs_v1'
    `).run()
    database.close()

    const corrupted = createStore()
    await expect(corrupted.initialize()).rejects.toThrow(/lifetime token ledger metadata is invalid/i)
  })

  it('replaces a same-id streaming checkpoint with its terminal token contribution', async () => {
    const now = Date.now()
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(1, 'lifetime-lifecycle'),
      timestamp: now,
      status: 'streaming',
      statusCode: undefined,
      model: 'gpt-5.6-sol',
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 2
    })
    await expect(store.checkpointLiveRequestLogs()).resolves.toBe(1)
    await store.appendLog({
      ...requestLog(2, 'lifetime-lifecycle'),
      timestamp: now,
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20
    })

    const costs = store.getSnapshot().observability.tokenCosts
    expect(costs.today).toMatchObject({
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      standardInputTokens: 60,
      cachedInputTokens: 40,
      pricedRequestCount: 1
    })
    expect(costs.allTime).toMatchObject({
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      standardInputTokens: 60,
      cachedInputTokens: 40,
      pricedRequestCount: 1
    })
  })

  it('counts the terminal delta of an active request after history is cleared without resurrecting its row', async () => {
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const store = createStore()
      await store.initialize()
      await store.appendLog({
        ...requestLog(1, 'cleared-lifetime-lifecycle'),
        timestamp: now,
        status: 'streaming',
        statusCode: undefined,
        model: 'gpt-5.6-sol',
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2
      })
      // Start clearing while a checkpoint is still queued. The clear operation
      // must capture that just-committed baseline before deleting the row.
      const checkpoint = store.checkpointLiveRequestLogs()
      const clearing = store.clearLogs()
      await expect(checkpoint).resolves.toBe(1)
      await clearing
      now += 1_001
      expect(store.getSnapshot().observability.tokenCosts.allTime.totalTokens).toBe(12)
      const terminal = {
        ...requestLog(2, 'cleared-lifetime-lifecycle'),
        timestamp: now,
        model: 'gpt-5.6-sol',
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20
      }
      await expect(store.appendLog(terminal)).resolves.toBeUndefined()
      expect(store.getSnapshot().requestLogs).toEqual([])
      expect(store.getSnapshot().observability.tokenCosts).toMatchObject({
        today: { totalTokens: 0 },
        allTime: {
          totalTokens: 120,
          inputTokens: 100,
          outputTokens: 20,
          standardInputTokens: 60,
          cachedInputTokens: 40,
          pricedRequestCount: 1
        }
      })

      // A duplicated terminal callback is harmless even though the visible row
      // no longer exists to provide normal upsert idempotency.
      await expect(store.appendLog(terminal)).resolves.toBeUndefined()
      now += 1_001
      expect(store.getSnapshot().observability.tokenCosts.allTime.totalTokens).toBe(120)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('upserts a pending request lifecycle in place and persists only its terminal row', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog(requestLog(1, 'ordinal-anchor'))
    await Promise.all([
      store.appendLog({
        ...requestLog(2, 'lifecycle-row'),
        status: 'streaming',
        accountId: undefined,
        accountName: '等待选择',
        providerName: '等待选择'
      }),
      store.appendLog({
        ...requestLog(3, 'lifecycle-row'),
        status: 'error',
        statusCode: 503,
        failureStage: 'scheduler',
        error: 'No eligible account'
      })
    ])

    expect(store.getSnapshot().requestLogs.map((log) => log.id)).toEqual(['lifecycle-row', 'ordinal-anchor'])
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      status: 'error', statusCode: 503, failureStage: 'scheduler'
    })
    await store.close()

    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME), { readOnly: true })
    const rows = database.prepare('SELECT id, ordinal, payload FROM request_logs ORDER BY ordinal').all() as Array<{
      id: string
      ordinal: number
      payload: string
    }>
    database.close()
    expect(rows.map((row) => row.id)).toEqual(['lifecycle-row', 'ordinal-anchor'])
    expect(rows.filter((row) => row.id === 'lifecycle-row')).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toMatchObject({ status: 'error', failureStage: 'scheduler' })
  })

  it('keeps rapid live progress memory-only with a 20k history until an explicit checkpoint', async () => {
    const legacy = legacyState()
    legacy.requestLogs = Array.from({ length: 20_000 }, (_, index) => requestLog(index))
    await writeFile(join(directory, LEGACY_JSON_FILENAME), JSON.stringify(legacy), 'utf8')
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    const persist = vi.spyOn(repository, 'appendRequestLog')

    await Promise.all(Array.from({ length: 250 }, (_, index) => store.appendLog({
      ...requestLog(20_001 + index, 'live-on-large-history'),
      status: 'streaming',
      latencyMs: index,
      progressStage: 'streaming'
    })))

    expect(persist).not.toHaveBeenCalled()
    expect(repository.select((state) => state.requestLogs.length)).toBe(20_000)
    expect(store.getSnapshot().requestLogs).toHaveLength(500)
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      id: 'live-on-large-history', status: 'streaming', latencyMs: 249
    })

    await expect(store.checkpointLiveRequestLogs()).resolves.toBe(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(repository.select((state) => state.requestLogs[0])).toMatchObject({
      id: 'live-on-large-history', status: 'streaming', latencyMs: 249
    })
    await store.appendLog({
      ...requestLog(20_250, 'live-on-large-history'),
      status: 'streaming',
      latencyMs: 250,
      progressStage: 'streaming'
    })
    await expect(store.checkpointLiveRequestLogs()).resolves.toBe(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(repository.select((state) => state.requestLogs[0])).toMatchObject({
      id: 'live-on-large-history', status: 'streaming', latencyMs: 250
    })

    await store.appendLog({
      ...requestLog(20_300, 'live-on-large-history'),
      status: 'success',
      statusCode: 200,
      latencyMs: 300
    })
    expect(store.hasLiveRequestLogs()).toBe(false)
    expect(repository.select((state) => state.requestLogs[0])).toMatchObject({
      id: 'live-on-large-history', status: 'success', latencyMs: 300
    })
  })

  it('does not mark a newer progress version checkpointed by an older in-flight write', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    const original = repository.appendRequestLog.bind(repository)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(repository, 'appendRequestLog').mockImplementationOnce(async (log, maxRows) => {
      await gate
      return original(log, maxRows)
    })
    await store.appendLog({ ...requestLog(1, 'versioned-checkpoint'), status: 'streaming', latencyMs: 1 })
    const firstCheckpoint = store.checkpointLiveRequestLogs()
    await store.appendLog({ ...requestLog(2, 'versioned-checkpoint'), status: 'streaming', latencyMs: 2 })
    release()
    await expect(firstCheckpoint).resolves.toBe(1)

    expect(store.hasUncheckpointedLiveRequestLogs()).toBe(true)
    await expect(store.checkpointLiveRequestLogs()).resolves.toBe(1)
    expect(repository.select((state) => state.requestLogs[0])).toMatchObject({
      id: 'versioned-checkpoint', status: 'streaming', latencyMs: 2
    })
  })

  it('keeps the last live row until a failed terminal write is retried durably', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    vi.spyOn(repository, 'appendRequestLog').mockRejectedValueOnce(new Error('temporary disk failure'))
    await store.appendLog({ ...requestLog(1, 'terminal-retry'), status: 'streaming', latencyMs: 10 })
    await expect(store.appendLog({
      ...requestLog(2, 'terminal-retry'), status: 'success', statusCode: 200, latencyMs: 20
    })).rejects.toThrow('temporary disk failure')
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      id: 'terminal-retry', status: 'streaming', latencyMs: 10
    })

    // The durable terminal retry owns the lifecycle guard, so delayed progress
    // cannot overwrite the last known live row while SQLite is unavailable.
    await store.appendLog({ ...requestLog(3, 'terminal-retry'), status: 'streaming', latencyMs: 30 })
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({ status: 'streaming', latencyMs: 10 })
    await store.appendLog({
      ...requestLog(4, 'terminal-retry'), status: 'success', statusCode: 200, latencyMs: 20
    })
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      id: 'terminal-retry', status: 'success', latencyMs: 20
    })
    await store.appendLog({
      ...requestLog(5, 'terminal-retry'), status: 'streaming', latencyMs: 40
    })
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      id: 'terminal-retry', status: 'success', latencyMs: 20
    })
  })

  it('does not resurrect cleared logs from delayed progress, terminal, or title callbacks', async () => {
    const store = createStore()
    await store.initialize()
    const persisted = {
      ...requestLog(1, 'cleared-persisted'),
      conversationId: 'conversation-cleared',
      conversationName: '对话 cleared',
      status: 'success' as const
    }
    await store.appendLog(persisted)
    await store.appendLog({
      ...requestLog(2, 'cleared-live'),
      status: 'streaming',
      progressStage: 'streaming'
    })

    await store.clearLogs(['cleared-pending'])

    await expect(store.appendLog({
      ...persisted,
      conversationName: 'Resolved title'
    })).resolves.toBeUndefined()
    await expect(store.appendLog({
      ...requestLog(3, 'cleared-live'),
      status: 'success'
    })).resolves.toBeUndefined()
    await expect(store.appendLog({
      ...requestLog(4, 'cleared-pending'),
      status: 'success'
    })).resolves.toBeUndefined()
    expect(store.getSnapshot().requestLogs).toEqual([])
  })

  it('restores the active request generation when clearing durable history fails', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    await store.appendLog({
      ...requestLog(1, 'failed-clear-live'),
      status: 'streaming',
      model: 'gpt-5.6-sol',
      inputTokens: 10,
      outputTokens: 2
    })
    let rejectClear!: (error: Error) => void
    vi.spyOn(repository, 'clearRequestLogs').mockImplementationOnce(() => new Promise((_, reject) => {
      rejectClear = reject
    }))

    const clearing = store.clearLogs()
    const terminal = store.appendLog({
      ...requestLog(2, 'failed-clear-live'),
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      outputTokens: 20
    })
    rejectClear(new Error('temporary clear failure'))

    await expect(clearing).rejects.toThrow('temporary clear failure')
    await expect(terminal).resolves.toMatchObject({ id: 'failed-clear-live', status: 'success' })
    expect(store.getSnapshot().requestLogs[0]).toMatchObject({
      id: 'failed-clear-live', status: 'success'
    })
    expect(repository.readLifetimeTokenCosts().totalTokens).toBe(120)
  })

  it('keeps requests that start while the previous generation is being cleared', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    await store.appendLog({
      ...requestLog(1, 'old-generation-live'),
      status: 'streaming'
    })

    const originalClear = repository.clearRequestLogs.bind(repository)
    let releaseClear!: () => void
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve })
    vi.spyOn(repository, 'clearRequestLogs').mockImplementationOnce(async (trackedIds) => {
      await clearGate
      return originalClear(trackedIds)
    })

    const clearing = store.clearLogs()
    await store.appendLog({
      ...requestLog(2, 'new-generation-live'),
      status: 'streaming'
    })
    releaseClear()
    await clearing

    expect(store.getSnapshot().requestLogs).toEqual([
      expect.objectContaining({ id: 'new-generation-live', status: 'streaming' })
    ])
    await expect(store.appendLog({
      ...requestLog(3, 'old-generation-live'),
      status: 'success'
    })).resolves.toBeUndefined()
    expect(store.getSnapshot().requestLogs.map((log) => log.id)).toEqual(['new-generation-live'])
  })

  it('does not checkpoint or resurrect a cleared live generation when shutdown races the clear', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    await store.appendLog({
      ...requestLog(1, 'clear-shutdown-live'),
      status: 'streaming',
      model: 'gpt-5.6-sol',
      inputTokens: 10,
      outputTokens: 2
    })
    await expect(store.checkpointLiveRequestLogs()).resolves.toBe(1)
    expect(repository.readLifetimeTokenCosts().totalTokens).toBe(12)

    const originalClear = repository.clearRequestLogs.bind(repository)
    let releaseClear!: () => void
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve })
    vi.spyOn(repository, 'clearRequestLogs').mockImplementationOnce(async (trackedIds) => {
      await clearGate
      return originalClear(trackedIds)
    })

    const clearing = store.clearLogs()
    const closing = store.close()
    releaseClear()
    await clearing
    await closing

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().requestLogs).toEqual([])
    expect(restarted.getStateRepository().readLifetimeTokenCosts().totalTokens).toBe(12)
  })

  it('checkpoints a failed terminal lifecycle during close so restart can terminate it explicitly', async () => {
    const store = createStore()
    await store.initialize()
    const repository = store.getStateRepository()
    vi.spyOn(repository, 'appendRequestLog').mockRejectedValueOnce(new Error('temporary shutdown write failure'))
    await store.appendLog({ ...requestLog(1, 'shutdown-terminal-fallback'), status: 'streaming' })
    await expect(store.appendLog({
      ...requestLog(2, 'shutdown-terminal-fallback'), status: 'success', latencyMs: 20
    })).rejects.toThrow('temporary shutdown write failure')

    await store.close()
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().requestLogs).toContainEqual(expect.objectContaining({
      id: 'shutdown-terminal-fallback',
      status: 'error',
      statusCode: 499,
      error: 'Gateway stopped before the request completed'
    }))
  })

  it('terminates a stale streaming lifecycle when the app restarts', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog({ ...requestLog(1, 'stale-lifecycle'), status: 'streaming' })
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().requestLogs).toContainEqual(expect.objectContaining({
      id: 'stale-lifecycle',
      status: 'error',
      statusCode: 499,
      failureStage: 'client',
      error: 'Gateway stopped before the request completed'
    }))
  })

  it('reconciles an orphaned streaming lifecycle after the gateway becomes idle', async () => {
    const store = createStore()
    await store.initialize()
    await store.appendLog({
      ...requestLog(1, 'orphaned-lifecycle'),
      status: 'streaming',
      startedAt: 1_000,
      progressStage: 'streaming'
    })

    await expect(store.finalizeOrphanedStreamingLogs(4_000)).resolves.toEqual([
      expect.objectContaining({ id: 'orphaned-lifecycle', status: 'error', statusCode: 499 })
    ])
    await expect(store.finalizeOrphanedStreamingLogs(5_000)).resolves.toEqual([])
    expect(store.getSnapshot().requestLogs).toContainEqual(expect.objectContaining({
      id: 'orphaned-lifecycle',
      timestamp: 4_000,
      status: 'error',
      statusCode: 499,
      latencyMs: 3_000,
      progressStage: undefined,
      failureStage: 'client',
      error: 'Gateway request ended without a final log'
    }))
  })

  it('coalesces concurrent request-log writes without changing newest-first order', async () => {
    const store = createStore()
    await store.initialize()
    await Promise.all([
      store.appendLog(requestLog(1, 'batch-first')),
      store.appendLog(requestLog(2, 'batch-second')),
      store.appendLog(requestLog(3, 'batch-third'))
    ])
    await store.close()

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().requestLogs.map((log) => log.id)).toEqual([
      'batch-third',
      'batch-second',
      'batch-first'
    ])
    await restarted.close()
  })

  it('deduplicates same-id durable writes in one burst and resolves every waiter at the final state', async () => {
    const store = createStateStore(legacyState())
    await store.initialize()
    await Promise.all(Array.from({ length: 100 }, (_, index) => store.appendRequestLog({
      ...requestLog(index, 'one-durable-row'),
      status: index === 99 ? 'success' : 'streaming',
      latencyMs: index
    }, 500)))

    expect(store.read().requestLogs.filter((log) => log.id === 'one-durable-row')).toHaveLength(1)
    expect(store.read().requestLogs.find((log) => log.id === 'one-durable-row')).toMatchObject({
      status: 'success', latencyMs: 99
    })
    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME), { readOnly: true })
    const rows = database.prepare('SELECT payload FROM request_logs WHERE id = ?').all('one-durable-row') as Array<{
      payload: string
    }>
    database.close()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toMatchObject({ status: 'success', latencyMs: 99 })
  })

  it('keeps the retained request-log array and index incremental across upserts and retention', async () => {
    const initial = legacyState()
    initial.requestLogs = [
      { ...requestLog(3, 'old-third'), error: 'stale error' },
      requestLog(2, 'old-second'),
      requestLog(1, 'old-first')
    ]
    const store = createStateStore(initial)
    await store.initialize()
    const internals = store as unknown as {
      data: PersistedState
      requestLogsById: Map<string, RequestLog>
    }
    const retainedArray = internals.data.requestLogs
    const existingRow = retainedArray.find((log) => log.id === 'old-third')
    expect(existingRow).toBeDefined()

    await store.appendRequestLog({
      ...requestLog(30, 'old-third'),
      status: 'success'
    }, 3)
    expect(internals.data.requestLogs).toBe(retainedArray)
    expect(internals.data.requestLogs.find((log) => log.id === 'old-third')).toBe(existingRow)
    expect(existingRow).not.toHaveProperty('error')
    expect(internals.requestLogsById.get('old-third')).toBe(existingRow)

    await store.appendRequestLog(requestLog(31, 'newest'), 3)
    expect(internals.data.requestLogs).toBe(retainedArray)
    expect(internals.data.requestLogs.map((log) => log.id)).toEqual(['newest', 'old-third', 'old-second'])
    expect(internals.requestLogsById.has('old-first')).toBe(false)
    expect(internals.requestLogsById.size).toBe(3)
  })

  it('does not subtract lifetime tokens when bounded history evicts an old row', async () => {
    const initial = legacyState()
    initial.requestLogs = []
    const store = createStateStore(initial)
    await store.initialize()
    for (const [index, inputTokens] of [100, 200, 300].entries()) {
      await store.appendRequestLog({
        ...requestLog(index, `retained-token-${index}`),
        model: 'gpt-5.6-sol',
        inputTokens,
        outputTokens: 10
      }, 2)
    }

    expect(store.read().requestLogs.map((log) => log.id)).toEqual([
      'retained-token-2',
      'retained-token-1'
    ])
    expect(store.readLifetimeTokenCosts()).toMatchObject({
      totalTokens: 630,
      inputTokens: 600,
      outputTokens: 30,
      pricedRequestCount: 3
    })
  })

  it('keeps the lifetime ledger consistent when low-level request-log mutations are used', async () => {
    const initial = legacyState()
    initial.requestLogs = []
    const store = createStateStore(initial)
    await store.initialize()
    await store.mutate((state) => {
      state.requestLogs = [{
        ...requestLog(1, 'mutated-token-log'),
        model: 'gpt-5.6-sol',
        inputTokens: 100,
        outputTokens: 10
      }]
    }, ['requestLogs'])
    expect(store.readLifetimeTokenCosts().totalTokens).toBe(110)

    await store.mutate((state) => {
      state.requestLogs = [{
        ...requestLog(2, 'mutated-token-log'),
        model: 'gpt-5.6-sol',
        inputTokens: 200,
        outputTokens: 20
      }]
    }, ['requestLogs'])
    expect(store.readLifetimeTokenCosts().totalTokens).toBe(220)

    await store.mutate((state) => { state.requestLogs = [] }, ['requestLogs'])
    expect(store.readLifetimeTokenCosts().totalTokens).toBe(220)
  })

  it('keeps account id lookups current across runtime patches and section mutations', async () => {
    const store = createStateStore(legacyState())
    await store.initialize()
    expect(store.selectAccount<Account>('legacy-account')).toMatchObject({ id: 'legacy-account' })

    await store.updateAccounts<Account>(['legacy-account'], (account) => {
      account.latencyMs = 321
    })
    expect(store.selectAccount<Account>('legacy-account')).toMatchObject({
      id: 'legacy-account', latencyMs: 321
    })

    await store.mutate((state) => {
      state.accounts = []
    }, ['accounts'])
    expect(store.selectAccount<Account>('legacy-account')).toBeUndefined()
  })

  it('derives all observability series with one request-log traversal', () => {
    const logs = [requestLog(1, 'single-pass')]
    let iteratorCalls = 0
    const iterable = new Proxy(logs, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* (): Generator<RequestLog> {
            iteratorCalls += 1
            yield* target
          }
        }
        return Reflect.get(target, property, receiver)
      }
    })
    summarizeAppObservability(iterable, Date.now())
    expect(iteratorCalls).toBe(1)
  })

  it('rolls back a failed snapshot transaction and accepts the next queued update', async () => {
    const initial = legacyState()
    const store = createStateStore(initial)
    await store.initialize()

    await expect(store.update((state) => {
      state.providers.push(structuredClone(state.providers[0]))
    })).rejects.toThrow(/UNIQUE constraint failed/)
    expect(store.read().providers).toHaveLength(1)

    await store.update((state) => {
      state.gateway.port = 17777
    })
    await store.close()

    const restarted = createStateStore(legacyState())
    await restarted.initialize()
    expect(restarted.read().providers).toHaveLength(1)
    expect(restarted.read().gateway.port).toBe(17777)
  })

  it('migrates an older SQLite schema without losing state', async () => {
    const store = createStore()
    await store.initialize()
    await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Persisted before migration',
      credential: 'migration-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })
    await store.close()

    downgradeDatabaseToVersionOne(join(directory, SQLITE_DATABASE_FILENAME))
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts).toHaveLength(1)
    const restartedAccount = restarted.getSnapshot().accounts[0]
    expect(restarted.getCredential(restarted.getRuntimeAccount(restartedAccount.id)!.credentialId)).toBe('migration-secret')
    await restarted.close()

    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    expect(readSchemaVersion(database)).toBe(SQLITE_SCHEMA_VERSION)
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'accounts_ordinal_unique'").get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM client_profiles').get()).toEqual({ count: 3 })
    database.close()
  })

  it('migrates schema four through the current schema with proxy, quota, tags, and persistent tasks', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Schema four account',
      credential: 'schema-four-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: []
    })
    await store.close()

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    downgradeDatabaseToVersionFour(databasePath)
    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts).toContainEqual(expect.objectContaining({ id: created.accounts[0].id }))
    expect(restarted.getCredential(restarted.getRuntimeAccount(created.accounts[0].id)!.credentialId)).toBe('schema-four-secret')
    expect(restarted.getSnapshot().proxies).toEqual([])
    await restarted.close()

    const database = new DatabaseSync(databasePath)
    expect(readSchemaVersion(database)).toBe(SQLITE_SCHEMA_VERSION)
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5').get())
      .toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'proxies'").get())
      .toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'account_codex_quota_samples'").get())
      .toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'account_codex_quota_samples_observed'").get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6').get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7').get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 8').get())
      .toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'persistent_tasks'").get())
      .toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'account_tags'").get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM account_tags').get()).toEqual({ count: 2 })
    database.close()
  })

  it('rolls back a failed schema migration and leaves its source data intact', async () => {
    const store = createStore()
    await store.initialize()
    await store.close()

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    downgradeDatabaseToVersionOne(databasePath)
    const database = new DatabaseSync(databasePath)
    database.exec('UPDATE providers SET ordinal = 0')
    database.close()

    const failingStore = createStore()
    await expect(failingStore.initialize()).rejects.toThrow(/migration 2 failed/)

    const inspected = new DatabaseSync(databasePath)
    expect(readSchemaVersion(inspected)).toBe(1)
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2').get())
      .toEqual({ count: 0 })
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM providers WHERE ordinal = 0').get())
      .toEqual({ count: 3 })
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'providers_ordinal_unique'").get())
      .toEqual({ count: 0 })
    inspected.close()
  })
})

function legacyState(): PersistedState {
  const timestamp = 1_700_000_000_000
  return {
    version: 1,
    providers: [{
      id: 'legacy-provider',
      name: 'Legacy Provider',
      kind: 'openai-compatible',
      baseUrl: 'https://legacy.example.test/v1',
      protocol: 'openai-chat',
      models: ['legacy-model'],
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    accounts: [{
      id: 'legacy-account',
      providerId: 'legacy-provider',
      name: 'Legacy Account',
      credentialId: 'legacy-credential',
      maskedCredential: '****cret',
      status: 'active',
      priority: 1,
      weight: 1,
      maxConcurrency: 2,
      inFlight: 0,
      modelAllowlist: [],
      circuitState: 'closed',
      consecutiveFailures: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    proxies: [],
    pools: [{
      id: 'legacy-pool',
      name: 'Legacy Pool',
      protocol: 'openai-chat',
      strategy: 'priority',
      members: [{ accountId: 'legacy-account', enabled: true }],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    routes: [{
      id: 'legacy-route',
      client: 'codex',
      enabled: true,
      poolId: 'legacy-pool',
      inboundProtocol: 'openai-responses',
      modelMap: { alias: 'legacy-model' },
      localToken: 'legacy-local-token',
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    gateway: {
      host: '127.0.0.1',
      port: 15721,
      autoStart: true,
      logPayloads: false,
      requestTimeoutSeconds: 90
      ,launchAtLogin: false
      ,desktopNotifications: true
      ,automaticBackups: true
      ,backupRetention: 10
    },
    requestLogs: [requestLog(0, 'legacy-log')],
    credentials: {
      'legacy-credential': Buffer.from('vault:legacy-secret', 'utf8').toString('base64')
    },
    clientProfiles: [],
    healthEvents: []
  }
}

function legacyJsonState(): Omit<PersistedState, 'clientProfiles'> {
  const state = legacyState()
  const { clientProfiles: _clientProfiles, ...legacy } = state
  return legacy
}

function requestLog(index: number, id = `log-${index}`): RequestLog {
  return {
    id,
    timestamp: 1_700_000_000_000 + index,
    client: 'codex',
    protocol: 'openai-responses',
    providerName: 'Provider',
    accountName: 'Account',
    model: 'model',
    status: 'success',
    statusCode: 200,
    latencyMs: index
  }
}

function downgradeDatabaseToVersionOne(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    DROP INDEX providers_ordinal_unique;
    DROP INDEX accounts_ordinal_unique;
    DROP INDEX pools_ordinal_unique;
    DROP INDEX routes_ordinal_unique;
    DROP INDEX request_logs_ordinal_unique;
    DROP TABLE IF EXISTS client_profiles;
    DROP TABLE IF EXISTS health_events;
    DROP TABLE IF EXISTS proxies;
    DROP TABLE IF EXISTS account_codex_quota_samples;
    DROP TABLE IF EXISTS account_tags;
    DELETE FROM schema_migrations WHERE version >= 2;
    PRAGMA user_version = 1;
  `)
  database.close()
}

function downgradeDatabaseToVersionFour(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    DROP TABLE proxies;
    DROP TABLE account_codex_quota_samples;
    DROP TABLE account_tags;
    DELETE FROM schema_migrations WHERE version >= 5;
    PRAGMA user_version = 4;
  `)
  database.close()
}

function readSchemaVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}
