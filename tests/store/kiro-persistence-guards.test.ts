import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-vault',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, ''),
  },
}))

import { AppStore } from '../../src/main/store/app-store'

describe('Kiro Claude persistence guards', () => {
  const stores: AppStore[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('strips stale FAST and Responses Compact flags before runtime use and after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-kiro-persistence-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const saved = await store.saveApiSource({
      name: 'Kiro persistence relay',
      sourceType: 'relay',
      kind: 'kiro-compatible',
      baseUrl: 'https://kiro.example/generateAssistantResponse',
      protocol: 'kiro-claude',
      models: ['claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-4-5',
      credential: 'kiro-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
    })

    await store.getStateRepository().mutate((state) => {
      const provider = state.providers.find((candidate) => candidate.id === saved.source.sourceId)!
      provider.forceFastMode = true
      provider.responsesCompactMode = 'native'
    }, ['providers'])

    expect(store.getRuntimeProvider(saved.source.sourceId)).toMatchObject({
      protocol: 'kiro-claude',
      forceFastMode: false,
    })
    expect(store.getRuntimeProvider(saved.source.sourceId)).not.toHaveProperty('responsesCompactMode')

    await store.close()
    stores.splice(stores.indexOf(store), 1)
    const restarted = new AppStore(directory)
    stores.push(restarted)
    await restarted.initialize()
    expect(restarted.getRuntimeProvider(saved.source.sourceId)).toMatchObject({
      protocol: 'kiro-claude',
      forceFastMode: false,
    })
    expect(restarted.getRuntimeProvider(saved.source.sourceId)).not.toHaveProperty('responsesCompactMode')
  })

  it('downgrades profile-only Kiro evidence and disables its restored route', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-kiro-persistence-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const saved = await store.saveApiSource({
      name: 'Kiro legacy evidence relay',
      sourceType: 'relay',
      kind: 'kiro-compatible',
      baseUrl: 'https://kiro.example/generateAssistantResponse',
      protocol: 'kiro-claude',
      models: ['claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-4-5',
      credential: 'kiro-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
    })

    await store.getStateRepository().mutate((state) => {
      const provider = state.providers.find((candidate) => candidate.id === saved.source.sourceId)!
      provider.toolRoundtripVerified = undefined
      provider.capabilityProfile = {
        version: 1,
        origin: 'probed',
        checkedAt: Date.now(),
        toolCalls: true,
      }
      const route = state.routes.find((candidate) => candidate.client === 'claude')!
      route.poolId = saved.source.sourceId
      route.enabled = true
    }, ['providers', 'routes'])

    expect(store.getRuntimeProvider(saved.source.sourceId)).toMatchObject({
      toolRoundtripVerified: false,
      capabilityProfile: { toolCalls: false },
    })
    expect(store.getSnapshot().routes.find((candidate) => candidate.client === 'claude')).toMatchObject({
      poolId: saved.source.sourceId,
      enabled: false,
    })
  })
})
