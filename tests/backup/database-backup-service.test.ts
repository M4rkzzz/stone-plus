import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, '')
  }
}))

import { DatabaseBackupService, encryptPortableBackup } from '../../src/main/backup'
import { AppStore } from '../../src/main/store/app-store'
import { SQLITE_DATABASE_FILENAME, SQLITE_SCHEMA_VERSION } from '../../src/main/store/sqlite-state-store'
import type { PersistedState } from '../../src/main/store/types'

describe('DatabaseBackupService', () => {
  let directory: string
  let store: AppStore
  let service: DatabaseBackupService<PersistedState>
  let randomCounter: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stone-backup-'))
    store = new AppStore(directory)
    await store.initialize()
    randomCounter = 0
    service = createService()
    await service.initialize()
  })

  afterEach(async () => {
    await service.close()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('creates a SQLite-consistent backup with inspectable metadata', async () => {
    const proxyPassword = 'backup-proxy-password-private'
    const withProxy = await store.saveProxy({
      name: 'Backup proxy',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'backup-proxy-user',
      password: proxyPassword
    })
    const snapshot = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Backup account',
      credential: 'backup-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
      proxyId: withProxy.proxies[0].id
    })
    await store.setAccountCheckResult(snapshot.accounts[0].id, {
      codexQuota: {
        fiveHour: { usedPercent: 25 },
        sevenDay: { usedPercent: 40 },
        observedAt: 1_800_000_000_000,
        source: 'response-headers'
      }
    })

    const backup = await service.createBackup()
    const verification = await service.verifyBackup(backup.id)
    const listed = await service.listBackups()

    expect(backup).toMatchObject({ kind: 'manual', valid: true, schemaVersion: SQLITE_SCHEMA_VERSION })
    expect(backup.sizeBytes).toBeGreaterThan(0)
    expect(verification.integrityCheck).toEqual(['ok'])
    expect(listed).toEqual([backup])

    const database = new DatabaseSync(join(service.directory, backup.id), { readOnly: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM proxies').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM account_codex_quota_samples').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM built_in_proxy_settings').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM proxy_profiles').get()).toEqual({ count: 0 })
    database.close()
    expect((await readFile(join(service.directory, backup.id))).includes(Buffer.from('backup-secret'))).toBe(false)
    expect((await readFile(join(service.directory, backup.id))).includes(Buffer.from(proxyPassword))).toBe(false)
    expect(snapshot.accounts).toHaveLength(1)
  })

  it('rewraps portable credentials for a different destination vault', async () => {
    const created = await store.saveAccount({
      providerId: 'provider-openai',
      name: 'Portable account',
      credential: 'portable-api-secret',
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      modelAllowlist: [],
    })
    expect(created.accounts.some((account) => account.name === 'Portable account')).toBe(true)
    const credentialId = store.getStateRepository().read().accounts
      .find((account) => account.name === 'Portable account')!.credentialId
    const sourceVault = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`vault:${value}`),
      decryptString: (value: Buffer) => {
        const text = value.toString('utf8')
        if (!text.startsWith('vault:')) throw new Error('wrong source vault')
        return text.slice('vault:'.length)
      },
    }
    await service.close()
    service = createService({ portableSecretVault: sourceVault })
    await service.initialize()
    const portablePath = join(directory, 'cross-vault.stonebackup')
    await service.exportPortableBackup(portablePath, 'portable backup password')

    const destinationVault = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`destination:${value}`),
      decryptString: (value: Buffer) => {
        const text = value.toString('utf8')
        if (!text.startsWith('destination:')) throw new Error('wrong destination vault')
        return text.slice('destination:'.length)
      },
    }
    await service.close()
    service = createService({ portableSecretVault: destinationVault })
    await service.initialize()
    const imported = await service.importPortableBackup(portablePath, 'portable backup password')
    const database = new DatabaseSync(join(service.directory, imported.id), { readOnly: true })
    const row = database.prepare('SELECT encrypted_value FROM credentials WHERE id = ?').get(credentialId) as {
      encrypted_value: string
    }
    database.close()
    expect(Buffer.from(row.encrypted_value, 'base64').toString('utf8')).toBe('destination:portable-api-secret')
    expect((await readFile(portablePath)).includes(Buffer.from('portable-api-secret'))).toBe(false)
  })

  it('rejects a legacy v1 archive outside its original OS vault', async () => {
    await store.saveAccount({
      providerId: 'provider-openai', name: 'Legacy account', credential: 'legacy-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const local = await service.createBackup()
    const legacyPath = join(directory, 'legacy-v1.stonebackup')
    await encryptPortableBackup(
      join(service.directory, local.id), legacyPath, 'legacy archive password', Date.now, 1,
    )
    await service.close()
    service = createService({
      portableSecretVault: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`other:${value}`),
        decryptString: () => { throw new Error('foreign vault') },
      },
    })
    await service.initialize()
    await expect(service.importPortableBackup(legacyPath, 'legacy archive password'))
      .rejects.toThrow(/portable-v1-vault-mismatch/)
  })

  it('restores a selected backup and retains a verified pre-restore snapshot', async () => {
    await store.updateGateway(gatewaySettings(16001))
    const original = await service.createBackup()
    await store.updateGateway(gatewaySettings(16002))

    const result = await service.restoreBackup(original.id)
    expect(result.state.gateway.port).toBe(16001)
    expect(store.getSnapshot().gateway.port).toBe(16001)
    expect(result.safetyBackup).toMatchObject({ kind: 'pre-restore', valid: true })
    expect((await service.verifyBackup(result.safetyBackup.id)).integrityCheck).toEqual(['ok'])

    const recovered = await service.restoreBackup(result.safetyBackup.id)
    expect(recovered.state.gateway.port).toBe(16002)
    expect(store.getSnapshot().gateway.port).toBe(16002)
  })

  it('restores account catalogs and pool model exposure policies', async () => {
    const created = await store.saveAccount({
      providerId: 'provider-openai', name: 'Model backup account', credential: 'model-backup-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: []
    })
    const accountId = created.accounts.find((account) => account.name === 'Model backup account')!.id
    await store.setAccountModels(accountId, ['gpt-5.5', 'gpt-5.5-mini'])
    await store.saveAccount({
      id: accountId, providerId: 'provider-openai', name: 'Model backup account',
      priority: 1, weight: 1, maxConcurrency: 1,
      modelPolicy: 'selected', modelAllowlist: ['gpt-5.5-mini']
    })
    await store.savePool({
      name: 'Model backup pool', protocol: 'openai-responses', strategy: 'priority',
      accountIds: [accountId], modelPolicy: 'selected', modelAllowlist: ['gpt-5.5-mini'],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 1
    })
    const original = await service.createBackup()

    await store.setAccountModels(accountId, ['gpt-5.5'])
    expect(store.getSnapshot().pools.find((pool) => pool.name === 'Model backup pool')?.modelAllowlist).toEqual([])

    const result = await service.restoreBackup(original.id)
    expect(result.state.accounts.find((account) => account.id === accountId)).toMatchObject({
      availableModels: ['gpt-5.5', 'gpt-5.5-mini'],
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5-mini']
    })
    expect(result.state.pools.find((pool) => pool.name === 'Model backup pool')).toMatchObject({
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5-mini']
    })
  })

  it('rejects corrupt files and identifiers outside the managed directory', async () => {
    const backup = await service.createBackup()
    await writeFile(join(service.directory, backup.id), Buffer.from('not a sqlite database'))

    await expect(service.verifyBackup(backup.id)).resolves.toMatchObject({ valid: false })
    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/invalid database backup/)
    await expect(service.verifyBackup(`..${join('/', SQLITE_DATABASE_FILENAME)}`)).rejects.toThrow(/identifier/)
    await expect(service.deleteBackup('stone-backup-invalid.sqlite3')).rejects.toThrow(/identifier/)
    expect(store.getSnapshot().gateway.port).toBe(15721)
  })

  it('requires the built-in proxy tables for schema v9 while accepting a genuine v8 backup', async () => {
    const current = await service.createBackup()
    const currentPath = join(service.directory, current.id)
    let database = new DatabaseSync(currentPath)
    database.exec('DROP TABLE proxy_profiles')
    database.close()
    await expect(service.verifyBackup(current.id)).resolves.toMatchObject({
      valid: false,
      schemaVersion: 9,
      issue: expect.stringContaining('proxy_profiles'),
    })

    const legacy = await service.createBackup()
    const legacyPath = join(service.directory, legacy.id)
    database = new DatabaseSync(legacyPath)
    database.exec(`
      DROP TABLE built_in_proxy_settings;
      DROP TABLE proxy_profiles;
      DELETE FROM schema_migrations WHERE version = 9;
      PRAGMA user_version = 8;
    `)
    database.close()
    await expect(service.verifyBackup(legacy.id)).resolves.toMatchObject({ valid: true, schemaVersion: 8 })
  })

  it('rolls back the live database if a verified old backup cannot migrate', async () => {
    const backup = await service.createBackup()
    const backupPath = join(service.directory, backup.id)
    const database = new DatabaseSync(backupPath)
    database.exec(`
      DROP INDEX providers_ordinal_unique;
      DROP INDEX accounts_ordinal_unique;
      DROP INDEX pools_ordinal_unique;
      DROP INDEX routes_ordinal_unique;
      DROP INDEX request_logs_ordinal_unique;
      DROP TABLE client_profiles;
      DROP TABLE health_events;
      DELETE FROM schema_migrations WHERE version >= 2;
      PRAGMA user_version = 1;
      UPDATE providers SET ordinal = 0;
    `)
    database.close()
    expect(await service.verifyBackup(backup.id)).toMatchObject({ valid: true, schemaVersion: 1 })

    await store.updateGateway(gatewaySettings(16666))
    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/previous database was recovered/)
    expect(store.getSnapshot().gateway.port).toBe(16666)

    await store.updateGateway(gatewaySettings(16667))
    expect(store.getSnapshot().gateway.port).toBe(16667)
    const restarted = new AppStore(directory)
    await store.close()
    store = restarted
    await store.initialize()
    expect(store.getSnapshot().gateway.port).toBe(16667)
  })

  it('runs automatic backups only when due and rotates them by retention', async () => {
    let now = 1_800_000_000_000
    await service.close()
    service = createService({
      now: () => now,
      automaticIntervalMs: 1_000,
      automaticRetention: 2
    })
    await service.initialize()

    const first = await service.runAutomaticBackupIfDue()
    expect(first?.createdAt).toBe(now)
    await expect(service.runAutomaticBackupIfDue()).resolves.toBeUndefined()

    now += 1_000
    const second = await service.runAutomaticBackupIfDue()
    now += 1_000
    const third = await service.runAutomaticBackupIfDue()
    const automatic = (await service.listBackups()).filter((backup) => backup.kind === 'automatic')

    expect(automatic.map((backup) => backup.id)).toEqual([third?.id, second?.id])
    expect(automatic.some((backup) => backup.id === first?.id)).toBe(false)
    expect((await readdir(service.directory)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('keeps an invalid automatic backup visible during retention cleanup', async () => {
    let now = 1_800_000_000_000
    await service.close()
    service = createService({ now: () => now, automaticIntervalMs: 1_000, automaticRetention: 1 })
    await service.initialize()

    const damaged = await service.runAutomaticBackupIfDue()
    await writeFile(join(service.directory, damaged!.id), Buffer.from('damaged backup'))
    now += 1_000
    const replacement = await service.runAutomaticBackupIfDue()
    const automatic = (await service.listBackups()).filter((backup) => backup.kind === 'automatic')

    expect(automatic).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: damaged!.id, valid: false }),
      expect.objectContaining({ id: replacement!.id, valid: true })
    ]))
  })

  function createService(overrides: Partial<ConstructorParameters<typeof DatabaseBackupService<PersistedState>>[0]> = {}) {
    return new DatabaseBackupService<PersistedState>({
      userDataPath: directory,
      store: store.getStateRepository(),
      now: () => 1_800_000_000_000,
      randomId: () => (++randomCounter).toString(16).padStart(8, '0'),
      ...overrides
    })
  }
})

function gatewaySettings(port: number) {
  return {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 120
  } as const
}
