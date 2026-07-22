import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltInProxyProfileStoreInput } from '../../src/main/store/types'

const vaultState = vi.hoisted(() => ({ failEncrypt: false, failDecrypt: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => {
      if (vaultState.failEncrypt) throw new Error('vault encryption failed')
      return Buffer.from(`vault:${value}`, 'utf8')
    },
    decryptString: (value: Buffer) => {
      if (vaultState.failDecrypt) throw new Error('vault decryption failed')
      return value.toString('utf8').replace(/^vault:/, '')
    }
  }
}))

import { AppStore } from '../../src/main/store/app-store'
import {
  SQLITE_DATABASE_FILENAME,
  SQLITE_SCHEMA_VERSION
} from '../../src/main/store/sqlite-state-store'

describe('built-in proxy persistence', () => {
  let directory: string
  const stores: AppStore[] = []

  const createStore = (): AppStore => {
    const store = new AppStore(directory)
    stores.push(store)
    return store
  }

  beforeEach(async () => {
    vaultState.failEncrypt = false
    vaultState.failDecrypt = false
    directory = await mkdtemp(join(tmpdir(), 'stone-built-in-proxy-'))
  })

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await rm(directory, { recursive: true, force: true })
  })

  it('migrates schema v8 to v9 without changing external gateway or proxy bindings', async () => {
    const original = createStore()
    await original.initialize()
    const external = await original.saveProxy({
      name: 'Existing external proxy',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      password: 'existing-external-password'
    })
    await original.saveAccount({
      providerId: 'provider-openai',
      name: 'Bound account',
      credential: 'sk-bound-account',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
      proxyId: external.proxies[0].id
    })
    await original.updateGateway({
      ...original.getSnapshot().gateway,
      outboundNetworkMode: 'system'
    })
    await original.close()

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const v8 = new DatabaseSync(databasePath)
    v8.exec(`
      DROP TABLE built_in_proxy_settings;
      DROP TABLE proxy_profiles;
      DELETE FROM schema_migrations WHERE version = 9;
      PRAGMA user_version = 8;
    `)
    v8.close()

    const migrated = createStore()
    await migrated.initialize()
    const snapshot = migrated.getSnapshot()
    expect(SQLITE_SCHEMA_VERSION).toBe(9)
    expect(snapshot.gateway.outboundNetworkMode).toBe('system')
    expect(snapshot.proxies).toHaveLength(1)
    expect(snapshot.accounts[0].proxyId).toBe(snapshot.proxies[0].id)
    expect(snapshot.builtInProxySettings).toMatchObject({
      desiredEnabled: false,
      accessMode: 'system',
      ruleMode: 'rule',
      mixedPort: 0,
      hasEverActivated: false
    })
    expect(snapshot.builtInProxyProfiles).toEqual([])

    const inspected = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM built_in_proxy_settings').get())
      .toEqual({ count: 1 })
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM proxy_profiles').get())
      .toEqual({ count: 0 })
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9').get())
      .toEqual({ count: 1 })
    inspected.close()
  })

  it('encrypts complete profile material and exposes only summaries in snapshots', async () => {
    const store = createStore()
    await store.initialize()
    await store.updateGateway({
      ...store.getSnapshot().gateway,
      outboundNetworkMode: 'system'
    })

    const subscriptionUrl = 'https://subscriber.example.test/private/list?access=secret-url-token'
    const subscriptionToken = 'subscription-token-private'
    const nodePassword = 'node-password-private'
    const nodeServer = 'secret-node.example.test'
    const saved = await store.saveBuiltInProxyProfile(profileInput({
      source: 'subscription',
      secrets: {
        subscriptionUrl,
        subscriptionToken,
        configuration: {
          nodes: [{ id: 'node-stable-a', server: nodeServer, password: nodePassword }],
          rules: [{ outbound: 'node-stable-a' }]
        }
      }
    }))

    expect(saved).toMatchObject({
      source: 'subscription',
      nodeCount: 2,
      activeNodeId: 'node-stable-a'
    })
    const snapshot = store.getSnapshot()
    expect(snapshot.gateway.outboundNetworkMode).toBe('system')
    expect(snapshot.builtInProxySettings).toMatchObject({
      desiredEnabled: true,
      activeProfileId: saved.id,
      accessMode: 'system',
      ruleMode: 'rule',
      autoStart: true,
      hasEverActivated: false
    })
    expect(snapshot.builtInProxyProfiles).toEqual([saved])
    const publicJson = JSON.stringify(snapshot)
    expect(publicJson).not.toContain(subscriptionUrl)
    expect(publicJson).not.toContain(subscriptionToken)
    expect(publicJson).not.toContain(nodePassword)
    expect(publicJson).not.toContain(nodeServer)
    expect(publicJson).not.toContain('credentialId')
    expect(store.getBuiltInProxyProfileSecrets(saved.id)).toEqual({
      subscriptionUrl,
      subscriptionToken,
      configuration: {
        nodes: [{ id: 'node-stable-a', server: nodeServer, password: nodePassword }],
        rules: [{ outbound: 'node-stable-a' }]
      }
    })

    const internal = store.getStateRepository().read()
    const credentialId = internal.proxyProfiles?.[0].credentialId
    expect(credentialId).toBeTruthy()
    expect(JSON.stringify(internal.proxyProfiles)).not.toContain(subscriptionUrl)
    expect(JSON.stringify(internal.proxyProfiles)).not.toContain(subscriptionToken)
    expect(JSON.stringify(internal.proxyProfiles)).not.toContain(nodePassword)
    expect(internal.credentials[credentialId!]).not.toContain(subscriptionToken)

    await store.updateGateway({
      ...store.getSnapshot().gateway,
      port: 16031,
      outboundNetworkMode: 'system'
    })
    expect(store.getBuiltInProxySettings().activeProfileId).toBe(saved.id)
    expect(store.listBuiltInProxyProfiles()).toEqual([saved])
    expect(store.getSnapshot().gateway.outboundNetworkMode).toBe('system')

    await store.close()
    const bytes = await readFile(join(directory, SQLITE_DATABASE_FILENAME))
    expect(bytes.includes(Buffer.from(subscriptionUrl))).toBe(false)
    expect(bytes.includes(Buffer.from(subscriptionToken))).toBe(false)
    expect(bytes.includes(Buffer.from(nodePassword))).toBe(false)
    expect(bytes.includes(Buffer.from(nodeServer))).toBe(false)

    const restarted = createStore()
    await restarted.initialize()
    expect(restarted.getBuiltInProxyProfileSecrets(saved.id)?.subscriptionToken).toBe(subscriptionToken)
    expect(restarted.getSnapshot().gateway.outboundNetworkMode).toBe('system')
    expect(restarted.getBuiltInProxySettings().desiredEnabled).toBe(true)
  })

  it('keeps node ids stable, falls back when the active node disappears, and cleans credentials on delete', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.saveBuiltInProxyProfile(profileInput())
    await store.selectBuiltInProxyNode(created.id, 'node-stable-b')
    expect(store.getBuiltInProxyProfile(created.id)?.activeNodeId).toBe('node-stable-b')

    const updated = await store.saveBuiltInProxyProfile(profileInput({
      id: created.id,
      nodes: [{
        id: 'node-stable-a',
        name: 'Node A renamed',
        type: 'vless',
        groupIds: ['automatic'],
        latencyStatus: 'untested'
      }],
      activeNodeId: 'node-stable-b',
      secrets: undefined
    }))
    expect(updated.nodes.map((node) => node.id)).toEqual(['node-stable-a'])
    expect(updated.activeNodeId).toBe('node-stable-a')
    expect(store.getBuiltInProxyProfileSecrets(created.id)?.configuration).toEqual({
      nodes: [{ password: 'opaque-node-secret' }]
    })

    const tested = await store.setBuiltInProxyNodeLatency(created.id, 'node-stable-a', {
      latencyStatus: 'available',
      latencyMs: 37,
      lastTestedAt: 1_800_000_000_000
    })
    expect(tested).toMatchObject({ latencyStatus: 'available', latencyMs: 37 })

    const credentialId = store.getStateRepository().read().proxyProfiles?.[0].credentialId
    await store.deleteBuiltInProxyProfile(created.id)
    expect(store.listBuiltInProxyProfiles()).toEqual([])
    expect(store.getBuiltInProxySettings()).toMatchObject({ desiredEnabled: true })
    expect(store.getBuiltInProxySettings()).not.toHaveProperty('activeProfileId')
    expect(store.getStateRepository().read().credentials).not.toHaveProperty(credentialId!)
  })

  it('persists activation history independently and rolls back invalid profile replacements', async () => {
    const store = createStore()
    await store.initialize()
    const profile = await store.saveBuiltInProxyProfile(profileInput())
    const before = store.getStateRepository().read()

    await expect(store.saveBuiltInProxyProfile(profileInput({
      id: profile.id,
      secrets: {
        configuration: { invalid: 1n }
      }
    }))).rejects.toThrow(/not serializable/)
    expect(store.getStateRepository().read().proxyProfiles).toEqual(before.proxyProfiles)
    expect(store.getStateRepository().read().credentials).toEqual(before.credentials)

    vaultState.failEncrypt = true
    await expect(store.saveBuiltInProxyProfile(profileInput({
      id: profile.id,
      secrets: { configuration: { replacement: 'must-not-commit' } }
    }))).rejects.toThrow(/vault encryption failed/)
    vaultState.failEncrypt = false
    expect(store.getStateRepository().read().proxyProfiles).toEqual(before.proxyProfiles)
    expect(store.getStateRepository().read().credentials).toEqual(before.credentials)

    await store.markBuiltInProxyActivated(20800, 1_800_000_000_000)
    await store.setBuiltInProxyDesiredEnabled(false)
    const settings = store.getBuiltInProxySettings()
    expect(settings).toMatchObject({
      desiredEnabled: false,
      mixedPort: 20800,
      hasEverActivated: true,
      lastActivatedAt: 1_800_000_000_000
    })
    expect(store.getSnapshot().gateway.outboundNetworkMode).toBe('direct')

    await store.close()
    vaultState.failDecrypt = true
    const locked = createStore()
    await locked.initialize()
    expect(locked.getBuiltInProxyProfileSecrets(profile.id)).toBeUndefined()
    expect(JSON.stringify(locked.getSnapshot())).not.toContain('opaque-node-secret')
    await locked.close()

    vaultState.failDecrypt = false
    const unlocked = createStore()
    await unlocked.initialize()
    expect(unlocked.getBuiltInProxyProfileSecrets(profile.id)?.configuration).toEqual({
      nodes: [{ password: 'opaque-node-secret' }]
    })
  })
})

function profileInput(
  overrides: Partial<BuiltInProxyProfileStoreInput> = {}
): BuiltInProxyProfileStoreInput {
  return {
    name: 'Primary built-in profile',
    source: 'import',
    format: 'sing-box-json',
    nodes: [
      {
        id: 'node-stable-a',
        name: 'Node A',
        type: 'vless',
        groupIds: ['automatic'],
        latencyStatus: 'untested'
      },
      {
        id: 'node-stable-b',
        name: 'Node B',
        type: 'shadowsocks',
        groupIds: ['automatic'],
        latencyStatus: 'untested'
      }
    ],
    groupCount: 1,
    ruleStatus: 'preserved',
    activeNodeId: 'node-stable-a',
    secrets: {
      configuration: { nodes: [{ password: 'opaque-node-secret' }] }
    },
    ...overrides
  }
}
