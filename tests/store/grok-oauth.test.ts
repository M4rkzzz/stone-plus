import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, ''),
  },
}))

import { AppStore } from '../../src/main/store/app-store'
import { GROK_OAUTH_BASE_URL, GROK_OAUTH_CLIENT_ID } from '../../src/main/auth'
import { SQLITE_DATABASE_FILENAME } from '../../src/main/store/sqlite-state-store'

function jwt(claims: Record<string, unknown>): string {
  return ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.')
}

function grokExport(subject = 'grok-subject', email = 'grok@example.test'): string {
  const expiration = Date.now() + 3_600_000
  return JSON.stringify({ type: 'sub2api-data', version: 1, accounts: [{
    type: 'oauth', platform: 'grok', name: email, concurrency: 1, priority: 1,
    credentials: {
      access_token: jwt({ iss: 'https://auth.x.ai', sub: subject, client_id: GROK_OAUTH_CLIENT_ID, exp: Math.floor(expiration / 1000) }),
      refresh_token: `refresh-${subject}`, email, client_id: GROK_OAUTH_CLIENT_ID,
      expires_at: new Date(expiration).toISOString(), base_url: GROK_OAUTH_BASE_URL,
    },
  }] })
}

describe('AppStore Grok OAuth import', () => {
  let directory: string
  const stores: AppStore[] = []
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'stone-grok-oauth-')) })
  afterEach(async () => { await Promise.all(stores.map((store) => store.close())); await rm(directory, { recursive: true, force: true }) })

  it('encrypts, deduplicates and restores a Grok CLI Responses account', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const first = await store.importGrokAccounts({ content: grokExport() })
    expect(first.createdAccountIds).toHaveLength(1)
    const second = await store.importGrokAccounts({ content: grokExport() })
    expect(second.updatedAccountIds).toEqual(first.createdAccountIds)
    expect(store.getSnapshot().providers).toContainEqual(expect.objectContaining({
      sourceType: 'oauth-system', kind: 'xai', protocol: 'openai-responses', baseUrl: GROK_OAUTH_BASE_URL,
    }))
    expect(store.getSnapshot().accounts).toContainEqual(expect.objectContaining({
      credentialType: 'grok-oauth',
      maxConcurrency: 1,
      modelPolicy: 'selected',
      modelAllowlist: ['grok-4.5'],
      availableModels: ['grok-4.5'],
    }))
    await store.close(); stores.splice(stores.indexOf(store), 1)
    const restarted = new AppStore(directory); stores.push(restarted); await restarted.initialize()
    expect(restarted.getSnapshot().accounts).toHaveLength(1)
    expect(restarted.getSnapshot().accounts[0].tagId).toBe('tag-grok')
    expect(restarted.getSnapshot().providers.find((provider) => provider.kind === 'xai' && provider.sourceType === 'oauth-system'))
      .toMatchObject({ sourceType: 'oauth-system', protocol: 'openai-responses', baseUrl: GROK_OAUTH_BASE_URL })
  })

  it('preserves a renewable refresh token across an access-only reimport', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const first = await store.importGrokAccounts({ content: grokExport() })
    const account = store.getRuntimeAccount(first.importedAccountIds[0])!
    const accessOnly = JSON.parse(grokExport()) as { accounts: Array<{ credentials: Record<string, unknown> }> }
    delete accessOnly.accounts[0].credentials.refresh_token

    await store.importGrokAccounts({ content: JSON.stringify(accessOnly) })

    expect(store.getRuntimeAccount(account.id)?.renewable).toBe(true)
    expect(store.getCredential(account.credentialId)).toContain(`refresh-${'grok-subject'}`)
  })

  it('preserves the last known Grok quota when the same credential is imported again', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const imported = await store.importGrokAccounts({ content: grokExport() })
    const accountId = imported.importedAccountIds[0]
    await store.setAccountCheckResult(accountId, {
      quotaRemaining: 57.5,
      quotaUnit: 'percent',
      grokQuota: {
        usedPercent: 42.5,
        remainingPercent: 57.5,
        period: { type: 'weekly', end: '2026-08-01T00:00:00Z' },
        resetAt: Date.parse('2026-08-01T00:00:00Z'),
        paidClassification: 'paid',
        observedAt: Date.now(),
        source: 'grok-build-billing',
      },
    })

    await store.importGrokAccounts({ content: grokExport() })

    expect(store.getSnapshot().accounts.find((account) => account.id === accountId)).toMatchObject({
      quotaRemaining: 57.5,
      quotaUnit: 'percent',
      grokQuota: expect.objectContaining({
        remainingPercent: 57.5,
        paidClassification: 'paid',
        source: 'grok-build-billing',
      }),
    })
    await store.close(); stores.splice(stores.indexOf(store), 1)
    const restarted = new AppStore(directory); stores.push(restarted); await restarted.initialize()
    expect(restarted.getSnapshot().accounts.find((account) => account.id === accountId)).toMatchObject({
      quotaRemaining: 57.5,
      quotaUnit: 'percent',
      grokQuota: { remainingPercent: 57.5, paidClassification: 'paid' },
    })
  })

  it('does not revive a manually disabled account when OAuth tokens rotate', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const imported = await store.importGrokAccounts({ content: grokExport() })
    const accountId = imported.importedAccountIds[0]
    const account = store.getRuntimeAccount(accountId)!
    await store.setAccountCheckResult(accountId, { status: 'disabled' })
    const serialized = store.getCredential(account.credentialId)!

    await store.updateGrokOAuthCredential(accountId, serialized, serialized)

    expect(store.getSnapshot().accounts.find((candidate) => candidate.id === accountId)?.status).toBe('disabled')
  })

  it('ignores Codex quota protection policies on Grok OAuth accounts', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const imported = await store.importGrokAccounts({ content: grokExport() })
    const account = store.getSnapshot().accounts.find((candidate) => candidate.id === imported.importedAccountIds[0])!

    await store.saveAccount({
      id: account.id,
      providerId: account.providerId,
      name: account.name,
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelPolicy: account.modelPolicy,
      modelAllowlist: account.modelAllowlist,
      quotaProtection: { unavailableBehavior: 'block' },
    })

    expect(store.getSnapshot().accounts.find((candidate) => candidate.id === account.id)?.quotaProtection).toBeUndefined()
  })

  it('re-homes persisted Grok OAuth accounts away from a noncanonical provider', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    await store.importGrokAccounts({ content: grokExport() })
    await store.close(); stores.splice(stores.indexOf(store), 1)

    const database = new DatabaseSync(join(directory, SQLITE_DATABASE_FILENAME))
    const row = database.prepare('SELECT payload FROM providers WHERE id = ?').get('provider-grok-oauth') as { payload: string }
    const provider = JSON.parse(row.payload) as Record<string, unknown>
    Object.assign(provider, {
      sourceType: 'relay',
      kind: 'xai-compatible',
      baseUrl: 'https://credential-capture.example.test/v1',
    })
    database.prepare('UPDATE providers SET payload = ? WHERE id = ?')
      .run(JSON.stringify(provider), 'provider-grok-oauth')
    database.close()

    const restarted = new AppStore(directory); stores.push(restarted); await restarted.initialize()
    const snapshot = restarted.getSnapshot()
    const account = snapshot.accounts.find((candidate) => candidate.credentialType === 'grok-oauth')!
    const canonical = snapshot.providers.find((candidate) => candidate.id === account.providerId)!
    expect(canonical).toMatchObject({
      sourceType: 'oauth-system', kind: 'xai', protocol: 'openai-responses', baseUrl: GROK_OAUTH_BASE_URL,
    })
  })

  it('adds imports only to an explicit Grok pool and never duplicates membership', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const first = await store.importGrokAccounts({ content: grokExport() })
    const saved = await store.savePool({
      name: 'Grok accounts', protocol: 'grok', strategy: 'priority',
      accountIds: first.importedAccountIds, stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1,
    })
    const pool = saved.pools.find((candidate) => candidate.name === 'Grok accounts')!

    const second = await store.importGrokAccounts({
      content: grokExport('second-subject', 'second@example.test'),
      poolId: pool.id,
    })
    expect(second.createdAccountIds).toHaveLength(1)
    expect(store.getSnapshot().pools.find((candidate) => candidate.id === pool.id)?.members).toHaveLength(2)

    const repeated = await store.importGrokAccounts({
      content: grokExport('second-subject', 'second@example.test'),
      poolId: pool.id,
    })
    expect(repeated.updatedAccountIds).toEqual(second.createdAccountIds)
    expect(store.getSnapshot().pools.find((candidate) => candidate.id === pool.id)?.members).toHaveLength(2)
  })

  it('rejects an OpenAI pool assignment without leaving partial Grok state', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const openai = await store.saveAccount({
      providerId: 'provider-openai', name: 'OpenAI', credential: 'sk-test',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const poolSnapshot = await store.savePool({
      name: 'OpenAI pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [openai.accounts[0].id], stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1,
    })
    const pool = poolSnapshot.pools.find((candidate) => candidate.name === 'OpenAI pool')!
    const before = store.getSnapshot()

    await expect(store.importGrokAccounts({ content: grokExport(), poolId: pool.id }))
      .rejects.toThrow(/standard Grok pool/)
    const after = store.getSnapshot()
    expect(after.accounts).toEqual(before.accounts)
    expect(after.providers).toEqual(before.providers)
    expect(after.pools).toEqual(before.pools)
  })

  it('migrates only an unambiguous legacy Grok pool and persists the logical protocol', async () => {
    const store = new AppStore(directory); stores.push(store); await store.initialize()
    const imported = await store.importGrokAccounts({ content: grokExport() })
    const first = await store.savePool({
      name: 'Legacy Grok', protocol: 'grok', strategy: 'priority',
      accountIds: imported.importedAccountIds, stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1,
    })
    const second = await store.savePool({
      name: 'Damaged Grok', protocol: 'grok', strategy: 'priority',
      accountIds: imported.importedAccountIds, stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1,
    })
    const legacyPool = first.pools.find((candidate) => candidate.name === 'Legacy Grok')!
    const damagedPool = second.pools.find((candidate) => candidate.name === 'Damaged Grok')!
    await store.close(); stores.splice(stores.indexOf(store), 1)

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const database = new DatabaseSync(databasePath)
    for (const [poolId, protocol] of [[legacyPool.id, 'openai-responses'], [damagedPool.id, 'openai-chat']] as const) {
      const row = database.prepare('SELECT payload FROM pools WHERE id = ?').get(poolId) as { payload: string }
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      payload.protocol = protocol
      database.prepare('UPDATE pools SET payload = ? WHERE id = ?').run(JSON.stringify(payload), poolId)
    }
    database.close()

    const restarted = new AppStore(directory); stores.push(restarted); await restarted.initialize()
    expect(restarted.getSnapshot().pools.find((candidate) => candidate.id === legacyPool.id)).toMatchObject({
      protocol: 'grok', members: legacyPool.members, updatedAt: legacyPool.updatedAt,
    })
    expect(restarted.getSnapshot().pools.find((candidate) => candidate.id === damagedPool.id)?.protocol)
      .toBe('openai-chat')

    await restarted.close(); stores.splice(stores.indexOf(restarted), 1)
    const persisted = new DatabaseSync(databasePath, { readOnly: true })
    const migratedPayload = JSON.parse((persisted.prepare('SELECT payload FROM pools WHERE id = ?')
      .get(legacyPool.id) as { payload: string }).payload) as Record<string, unknown>
    persisted.close()
    expect(migratedPayload.protocol).toBe('grok')
  })
})
