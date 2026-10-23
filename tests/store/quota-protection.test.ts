import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, '')
  }
}))

import { AppStore } from '../../src/main/store/app-store'

describe('quota protection persistence', () => {
  const stores: AppStore[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('persists normalized account and pool reserve policies across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-quota-policy-'))
    directories.push(directory)
    const first = new AppStore(directory)
    stores.push(first)
    await first.initialize()
    let snapshot = await first.saveAccount({
      providerId: 'provider-openai',
      name: 'Protected',
      credential: 'sk-test',
      priority: 1,
      weight: 1,
      maxConcurrency: 2,
      modelAllowlist: [],
      quotaProtection: {
        fiveHourRemainingPercent: 150,
        sevenDayRemainingPercent: 20,
        unavailableBehavior: 'block',
        staleAfterMinutes: 15
      }
    })
    const accountId = snapshot.accounts[0].id
    snapshot = await first.savePool({
      name: 'Protected pool',
      protocol: 'openai-responses',
      strategy: 'balanced',
      accountIds: [accountId],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 1,
      quotaProtection: { fiveHourRemainingPercent: 10, unavailableBehavior: 'allow' }
    })
    expect(snapshot.accounts[0].quotaProtection).toEqual({
      fiveHourRemainingPercent: 100,
      sevenDayRemainingPercent: 20,
      unavailableBehavior: 'block',
      staleAfterMinutes: 15
    })
    expect(snapshot.pools[0].quotaProtection).toEqual({
      fiveHourRemainingPercent: 10,
      unavailableBehavior: 'allow'
    })
    await first.close()
    stores.splice(stores.indexOf(first), 1)

    const restarted = new AppStore(directory)
    stores.push(restarted)
    await restarted.initialize()
    expect(restarted.getSnapshot().accounts[0].quotaProtection?.sevenDayRemainingPercent).toBe(20)
    expect(restarted.getSnapshot().pools[0].quotaProtection?.fiveHourRemainingPercent).toBe(10)
  })
})
