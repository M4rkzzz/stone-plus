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

import {
  DatabaseBackupService,
  encryptPortableBackup,
  WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY,
} from '../../src/main/backup'
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
      getSelectedStorageBackend: () => 'gnome_libsecret',
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
      getSelectedStorageBackend: () => 'gnome_libsecret',
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

  it('removes legacy WebDAV URL credentials and rewraps the password during portable transfer', async () => {
    await store.getStateRepository().writeAppMetadata(
      WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://legacy%20user:legacy%20password@dav.example/stone/',
        username: '',
      }),
    )
    const sourceVault = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(`source:${value}`),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^source:/, ''),
    }
    await service.close()
    service = createService({ portableSecretVault: sourceVault })
    await service.initialize()
    const portablePath = join(directory, 'legacy-webdav.stonebackup')
    await service.exportPortableBackup(portablePath, 'portable backup password')

    const destinationVault = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(`destination:${value}`),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^destination:/, ''),
    }
    await service.close()
    service = createService({ portableSecretVault: destinationVault })
    await service.initialize()
    const imported = await service.importPortableBackup(portablePath, 'portable backup password')
    const database = new DatabaseSync(join(service.directory, imported.id), { readOnly: true })
    const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?')
      .get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) as { value: string }
    database.close()
    const migrated = JSON.parse(row.value) as { baseUrl: string; username: string; encryptedPassword: string }
    expect(migrated.baseUrl).toBe('https://dav.example/stone/')
    expect(migrated.username).toBe('legacy user')
    expect(Buffer.from(migrated.encryptedPassword, 'base64').toString('utf8'))
      .toBe('destination:legacy password')
    expect(row.value).not.toContain('legacy%20password')
  })

  it('rewraps an empty WebDAV password without retaining portable ciphertext', async () => {
    await store.getStateRepository().writeAppMetadata(
      WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://dav.example/stone/',
        username: 'empty-password-user',
        encryptedPassword: Buffer.from('source:').toString('base64'),
      }),
    )
    await service.close()
    service = createService({ portableSecretVault: credentialVault('source:') })
    await service.initialize()
    const portablePath = join(directory, 'empty-webdav-password.stonebackup')
    await service.exportPortableBackup(portablePath, 'portable backup password')

    await service.close()
    service = createService({ portableSecretVault: credentialVault('destination:') })
    await service.initialize()
    const imported = await service.importPortableBackup(portablePath, 'portable backup password')
    const database = new DatabaseSync(join(service.directory, imported.id), { readOnly: true })
    const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?')
      .get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) as { value: string }
    database.close()
    const migrated = JSON.parse(row.value) as { encryptedPassword: string }
    expect(migrated.encryptedPassword).not.toContain('stoneportable:')
    expect(Buffer.from(migrated.encryptedPassword, 'base64').toString('utf8')).toBe('destination:')
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
        getSelectedStorageBackend: () => 'gnome_libsecret',
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

  it('rejects a raw restore whose credentials cannot be decrypted by the current vault', async () => {
    await store.saveAccount({
      providerId: 'provider-openai', name: 'Foreign credential', credential: 'local-secret',
      priority: 1, weight: 1, maxConcurrency: 1, modelAllowlist: [],
    })
    const backup = await service.createBackup()
    const database = new DatabaseSync(join(service.directory, backup.id))
    database.prepare('UPDATE credentials SET encrypted_value = ?')
      .run(Buffer.from('foreign:ciphertext').toString('base64'))
    database.close()
    await store.updateGateway(gatewaySettings(16555))

    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/cannot be decrypted.*current.*vault/i)
    expect(store.getSnapshot().gateway.port).toBe(16555)
  })

  it('rejects a raw restore whose saved WebDAV password belongs to another vault', async () => {
    await store.getStateRepository().writeAppMetadata(
      WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://dav.example/stone/',
        username: 'alice',
        encryptedPassword: Buffer.from('foreign:webdav-password').toString('base64'),
      }),
    )
    const backup = await service.createBackup()
    await store.updateGateway(gatewaySettings(16556))

    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/WebDAV password.*current.*vault/i)
    expect(store.getSnapshot().gateway.port).toBe(16556)
  })

  it('reports failures after the restore commit without claiming the restore rolled back', async () => {
    await store.updateGateway(gatewaySettings(16001))
    const backup = await service.createBackup()
    await store.updateGateway(gatewaySettings(16002))
    const repository = store.getStateRepository()
    await service.close()
    service = createService({
      store: {
        backupTo: repository.backupTo.bind(repository),
        restoreFrom: async (stagedPath, rollbackPath) => {
          const state = await repository.restoreFrom(stagedPath, rollbackPath)
          await rm(rollbackPath, { force: true })
          return state
        },
      },
    })
    await service.initialize()

    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/was restored.*post-restore/i)
    expect(store.getSnapshot().gateway.port).toBe(16001)
  })

  it('resumes automatic backups when source verification rejects before staging', async () => {
    const backup = await service.createBackup()
    await writeFile(join(service.directory, backup.id), Buffer.from('damaged backup'))
    await service.startAutomaticBackups()
    await service.runAutomaticBackupIfDue()

    await expect(service.restoreBackup(backup.id)).rejects.toThrow(/invalid database backup/)
    expect((service as unknown as { automaticTimer?: NodeJS.Timeout }).automaticTimer).toBeDefined()
  })

  it('notifies the owner immediately after a restore commits', async () => {
    const backup = await service.createBackup()
    const onRestoreCommitted = vi.fn()
    await service.close()
    service = createService({ onRestoreCommitted })
    await service.initialize()

    await service.restoreBackup(backup.id)
    expect(onRestoreCommitted).toHaveBeenCalledTimes(1)
  })

  it('applies one retryable safety barrier to every raw live-database copy', async () => {
    let blocked = true
    const beforeRawBackup = vi.fn(async () => {
      if (blocked) throw new Error('disk error echoed legacy-secret')
    })
    await service.close()
    service = createService({ beforeRawBackup })
    await service.initialize()

    const error = await service.createBackup().catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/backups are blocked.*WebDAV credentials/i)
    expect(String(error)).not.toContain('legacy-secret')
    expect(service.backupBlockReason).toMatch(/backups are blocked/i)
    expect(await service.listBackups()).toEqual([])

    blocked = false
    const source = await service.createBackup()
    await service.exportPortableBackup(join(directory, 'barrier-export.stonebackup'), 'portable password')
    await service.runAutomaticBackupIfDue()
    await service.restoreBackup(source.id)

    // Failed manual, successful manual, portable's raw manual, automatic,
    // restore safety snapshot, and the restored generation.
    expect(beforeRawBackup).toHaveBeenCalledTimes(6)
    expect(service.backupBlockReason).toBeUndefined()
  })

  it('singleflights concurrent safety failures without exposing the hook error', async () => {
    let rejectBarrier!: (error: Error) => void
    const barrier = new Promise<void>((_resolve, reject) => { rejectBarrier = reject })
    const beforeRawBackup = vi.fn(() => barrier)
    await service.close()
    service = createService({ beforeRawBackup })
    await service.initialize()

    const first = service.createBackup().catch((cause: unknown) => cause)
    const second = service.createBackup().catch((cause: unknown) => cause)
    await vi.waitFor(() => expect(beforeRawBackup).toHaveBeenCalledOnce())
    rejectBarrier(new Error('legacy-secret appeared in the storage failure'))
    const errors = await Promise.all([first, second])

    for (const error of errors) {
      expect(String(error)).toMatch(/backups are blocked.*WebDAV credentials/i)
      expect(String(error)).not.toContain('legacy-secret')
    }
    expect(await service.listBackups()).toEqual([])
  })

  it('keeps automatic backups stopped until failed post-restore preparation is retried', async () => {
    const source = await service.createBackup()
    let preparationAttempts = 0
    const onRestoreCommitted = vi.fn(async () => {
      preparationAttempts += 1
      if (preparationAttempts === 1) throw new Error('transient sanitize failure with legacy-secret')
    })
    await service.close()
    service = createService({ onRestoreCommitted, automaticIntervalMs: 60_000 })
    await service.initialize()
    await service.startAutomaticBackups()
    await service.runAutomaticBackupIfDue()

    const error = await service.restoreBackup(source.id).catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/was restored.*post-restore/i)
    expect(String(error)).not.toContain('legacy-secret')
    expect(service.automaticBackupsRunning).toBe(false)
    expect(service.backupBlockReason).toMatch(/backups are blocked/i)

    await service.startAutomaticBackups()
    expect(onRestoreCommitted).toHaveBeenCalledTimes(2)
    expect(service.automaticBackupsRunning).toBe(true)
    expect(service.backupBlockReason).toBeUndefined()
  })

  it('serializes restore with a concurrent manual copy so the restored generation is prepared first', async () => {
    await store.updateGateway(gatewaySettings(16001))
    const source = await service.createBackup()
    await store.updateGateway(gatewaySettings(16002))
    const repository = store.getStateRepository()
    const events: string[] = []
    await service.close()
    service = createService({
      store: {
        backupTo: async (path) => {
          events.push(`copy:${store.getSnapshot().gateway.port}`)
          return repository.backupTo(path)
        },
        restoreFrom: async (stagedPath, rollbackPath) => {
          events.push('restore')
          return repository.restoreFrom(stagedPath, rollbackPath)
        },
      },
      beforeRawBackup: () => { events.push(`gate:${store.getSnapshot().gateway.port}`) },
      onRestoreCommitted: (state) => { events.push(`sanitize:${state.gateway.port}`) },
    })
    await service.initialize()

    const restoring = service.restoreBackup(source.id)
    const manual = service.createBackup()
    await Promise.all([restoring, manual])

    expect(events).toEqual([
      'gate:16002',
      'restore',
      'sanitize:16001',
      'gate:16001',
      'gate:16001',
      'copy:16001',
    ])
  })

  it('keeps telemetry usable when SQLite restore preparation fails', async () => {
    const backup = await service.createBackup()
    const originalExec = DatabaseSync.prototype.exec
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): void {
      if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)') throw new Error('injected checkpoint failure')
      originalExec.call(this, sql)
    })
    try {
      await expect(service.restoreBackup(backup.id)).rejects.toThrow(/Unable to prepare SQLite restore/)
    } finally {
      execSpy.mockRestore()
    }

    const repository = store.getStateRepository()
    await repository.appendCodexQuotaSample({
      accountId: 'telemetry-after-restore-failure',
      observedAt: 1_800_000_000_000,
      fiveHourUsedPercent: 10,
      source: 'response-headers',
    })
    expect(repository.readCodexQuotaHistory(
      'telemetry-after-restore-failure',
      1_799_999_000_000,
      1_800_001_000_000,
    )).toHaveLength(1)
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
      portableSecretVault: credentialVault('vault:'),
      ...overrides
    })
  }
})

function credentialVault(prefix: string) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`${prefix}${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith(prefix)) throw new Error('foreign vault ciphertext')
      return text.slice(prefix.length)
    },
  }
}

function gatewaySettings(port: number) {
  return {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 120
  } as const
}
