import { COPYFILE_EXCL } from 'node:constants'
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { CodexQuotaHistoryPoint } from '@shared/types'

const CURRENT_SCHEMA_VERSION = 6
const STATE_INITIALIZED_KEY = 'state_initialized'
const LEGACY_IMPORT_KEY = 'legacy_json_import'

interface Migration {
  version: number
  up(database: DatabaseSync): void
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pools (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS routes (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS gateway_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS request_logs (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS credentials (
          id TEXT PRIMARY KEY,
          encrypted_value TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 2,
    up(database): void {
      database.exec(`
        CREATE UNIQUE INDEX providers_ordinal_unique ON providers (ordinal);
        CREATE UNIQUE INDEX accounts_ordinal_unique ON accounts (ordinal);
        CREATE UNIQUE INDEX pools_ordinal_unique ON pools (ordinal);
        CREATE UNIQUE INDEX routes_ordinal_unique ON routes (ordinal);
        CREATE UNIQUE INDEX request_logs_ordinal_unique ON request_logs (ordinal);
      `)
    }
  },
  {
    version: 3,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS client_profiles (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 4,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS health_events (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 5,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS proxies (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_codex_quota_samples (
          account_id TEXT NOT NULL,
          bucket_start INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,
          five_hour_used_percent REAL,
          five_hour_reset_at INTEGER,
          seven_day_used_percent REAL,
          seven_day_reset_at INTEGER,
          source TEXT NOT NULL,
          PRIMARY KEY (account_id, bucket_start)
        );

        CREATE INDEX IF NOT EXISTS account_codex_quota_samples_observed
          ON account_codex_quota_samples (account_id, observed_at);
      `)
    }
  },
  {
    version: 6,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS account_tags (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );
      `)
      const timestamp = Date.now()
      const insert = database.prepare('INSERT OR IGNORE INTO account_tags (id, ordinal, payload) VALUES (?, ?, ?)')
      ;[
        { id: 'tag-k12', name: 'K12' },
        { id: 'tag-plus', name: 'Plus' }
      ].forEach((tag, ordinal) => insert.run(tag.id, ordinal, JSON.stringify({
        ...tag,
        createdAt: timestamp,
        updatedAt: timestamp
      })))
    }
  }
]

interface SqliteStateStoreOptions<T> {
  databasePath: string
  legacyJsonPath: string
  initialData: T
  normalize?: (value: T) => T
}

interface Identified {
  id: string
}

interface SqlitePersistedShape {
  version: number
  providers: Identified[]
  accounts: Identified[]
  accountTags: Identified[]
  proxies: Identified[]
  pools: Identified[]
  routes: Identified[]
  gateway: unknown
  requestLogs: Identified[]
  credentials: Record<string, string>
  clientProfiles: Identified[]
  healthEvents: Identified[]
}

/**
 * Serialized state repository backed by transactional SQLite tables.
 *
 * Mutators operate on an isolated clone. The resulting snapshot is committed in
 * one transaction, then becomes visible to readers only after COMMIT succeeds.
 */
export class SqliteStateStore<T extends SqlitePersistedShape> {
  private data: T
  private database: DatabaseSync | undefined
  private writeChain = Promise.resolve()
  private readonly pendingRequestLogs: Array<{
    log: Identified
    maximumRows: number
    resolve: () => void
    reject: (error: unknown) => void
  }> = []
  private requestLogFlushScheduled = false

  public constructor(private readonly options: SqliteStateStoreOptions<T>) {
    this.data = this.normalize(options.initialData)
  }

  public async initialize(): Promise<T> {
    if (this.database) return this.read()

    await mkdir(dirname(this.options.databasePath), { recursive: true, mode: 0o700 })
    await secureDatabaseFile(this.options.databasePath)
    const database = new DatabaseSync(this.options.databasePath)
    this.database = database

    try {
      configureDatabase(database)
      runMigrations(database)

      if (readMetadata(database, STATE_INITIALIZED_KEY) === '1') {
        this.data = this.readDatabaseState(database)
      } else {
        const legacy = await readLegacyState<T>(this.options.legacyJsonPath)
        const initial = this.normalize(legacy ?? this.options.initialData)
        this.persist(initial, legacy === undefined ? undefined : {
          importedAt: Date.now(),
          source: this.options.legacyJsonPath
        })
        this.data = initial
        if (legacy !== undefined) await retainLegacyBackup(this.options.legacyJsonPath)
      }

      if (process.platform !== 'win32') {
        await chmod(this.options.databasePath, 0o600)
      }
      return this.read()
    } catch (error) {
      database.close()
      this.database = undefined
      throw new Error(`Unable to initialize SQLite state: ${messageOf(error)}`)
    }
  }

  public read(): T {
    return structuredClone(this.data)
  }

  public select<TResult>(selector: (state: Readonly<T>) => TResult): TResult {
    return structuredClone(selector(this.data))
  }

  public readAppMetadata(key: string): string | undefined {
    return readMetadata(this.requireDatabase(), key)
  }

  public async writeAppMetadata(key: string, value: string): Promise<void> {
    await this.mutateAppMetadata((database) => writeMetadata(database, key, value))
  }

  public async removeAppMetadata(key: string): Promise<void> {
    await this.mutateAppMetadata((database) => {
      database.prepare('DELETE FROM app_metadata WHERE key = ?').run(key)
    })
  }

  public async update(mutator: (draft: T) => void | Promise<void>): Promise<T> {
    const operation = async (): Promise<T> => {
      this.requireDatabase()
      const next = this.read()
      await mutator(next)
      const normalized = this.normalize(next)
      this.persist(normalized)
      this.data = normalized
      return this.read()
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  public appendRequestLog(log: Identified, maximumRows: number): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingRequestLogs.push({ log: structuredClone(log), maximumRows, resolve, reject })
    })
    this.scheduleRequestLogFlush()
    return completion
  }

  private scheduleRequestLogFlush(): void {
    if (this.requestLogFlushScheduled) return
    this.requestLogFlushScheduled = true
    const operation = async (): Promise<void> => {
      // Let completions from the same event-loop burst join one transaction.
      await Promise.resolve()
      const batch = this.pendingRequestLogs.splice(0)
      if (batch.length === 0) return
      try {
        const database = this.requireDatabase()
        const retainedRows = Math.min(...batch.map((entry) => entry.maximumRows))
        database.exec('BEGIN IMMEDIATE')
        const insert = database.prepare(`
          INSERT INTO request_logs (id, ordinal, payload)
          VALUES (?, COALESCE((SELECT MIN(ordinal) - 1 FROM request_logs), 0), ?)
        `)
        for (const { log: entry } of batch) insert.run(entry.id, JSON.stringify(entry))
        database.prepare(`
          DELETE FROM request_logs
          WHERE id IN (
            SELECT id FROM request_logs ORDER BY ordinal LIMIT -1 OFFSET ?
          )
        `).run(retainedRows)
        database.exec('COMMIT')
        const newestFirst = batch.map((entry) => structuredClone(entry.log)).reverse()
        const requestLogs = [...newestFirst, ...this.data.requestLogs].slice(0, retainedRows)
        this.data = { ...this.data, requestLogs }
        for (const entry of batch) entry.resolve()
      } catch (error) {
        if (this.database) rollback(this.database)
        for (const entry of batch) entry.reject(error)
        throw error
      }
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    void pending.finally(() => {
      this.requestLogFlushScheduled = false
      if (this.pendingRequestLogs.length > 0) this.scheduleRequestLogFlush()
    }).catch(() => {
      // Individual callers receive the write failure through their completion.
    })
  }

  public async updateAccount<TAccount extends Identified>(
    id: string,
    mutator: (account: TAccount) => void
  ): Promise<TAccount> {
    const operation = async (): Promise<TAccount> => {
      const database = this.requireDatabase()
      const index = this.data.accounts.findIndex((account) => account.id === id)
      if (index < 0) throw new Error('Account not found.')
      const account = structuredClone(this.data.accounts[index]) as TAccount
      mutator(account)
      if (account.id !== id) throw new Error('An account update cannot change its id.')
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = database.prepare('UPDATE accounts SET payload = ? WHERE id = ?')
          .run(JSON.stringify(account), id)
        if (result.changes !== 1) throw new Error('Account not found.')
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      const accounts = [...this.data.accounts]
      accounts[index] = structuredClone(account)
      this.data = { ...this.data, accounts }
      return structuredClone(account)
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  /**
   * Atomically rotates one encrypted credential and the small account row that
   * describes it. Unlike update(), this does not clone and rewrite the rest of
   * the application state (including request history) on the latency path.
   */
  public async updateAccountCredential<TAccount extends Identified & { credentialId: string }>(
    accountId: string,
    credentialId: string,
    encryptedValue: string,
    mutator: (account: TAccount) => void,
    expectedEncryptedValue?: string
  ): Promise<TAccount> {
    const operation = async (): Promise<TAccount> => {
      const database = this.requireDatabase()
      const index = this.data.accounts.findIndex((account) => account.id === accountId)
      if (index < 0) throw new Error('Account not found.')
      const account = structuredClone(this.data.accounts[index]) as TAccount
      if (account.credentialId !== credentialId) throw new Error('Account credential changed while it was being rotated.')
      if (expectedEncryptedValue !== undefined && this.data.credentials[credentialId] !== expectedEncryptedValue) {
        throw new Error('Account credential changed while it was being rotated.')
      }
      mutator(account)
      if (account.id !== accountId || account.credentialId !== credentialId) {
        throw new Error('A credential rotation cannot change account identity.')
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        const accountResult = database.prepare('UPDATE accounts SET payload = ? WHERE id = ?')
          .run(JSON.stringify(account), accountId)
        if (accountResult.changes !== 1) throw new Error('Account not found.')
        if (expectedEncryptedValue === undefined) {
          database.prepare(`
            INSERT INTO credentials (id, encrypted_value) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET encrypted_value = excluded.encrypted_value
          `).run(credentialId, encryptedValue)
        } else {
          const credentialResult = database.prepare(`
            UPDATE credentials SET encrypted_value = ? WHERE id = ? AND encrypted_value = ?
          `).run(encryptedValue, credentialId, expectedEncryptedValue)
          if (credentialResult.changes !== 1) throw new Error('Account credential changed while it was being rotated.')
        }
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      const accounts = [...this.data.accounts]
      accounts[index] = structuredClone(account)
      this.data = {
        ...this.data,
        accounts,
        credentials: { ...this.data.credentials, [credentialId]: encryptedValue }
      }
      return structuredClone(account)
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    return pending
  }

  public async appendCodexQuotaSample(
    sample: CodexQuotaHistoryPoint,
    bucketSizeMs = 5 * 60 * 1000,
    retentionMs = 14 * 24 * 60 * 60 * 1000
  ): Promise<void> {
    if (!sample.accountId || !Number.isFinite(sample.observedAt)) return
    const bucketStart = Math.floor(sample.observedAt / bucketSizeMs) * bucketSizeMs
    const cutoff = sample.observedAt - retentionMs
    const operation = async (): Promise<void> => {
      const database = this.requireDatabase()
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(`
          INSERT INTO account_codex_quota_samples (
            account_id, bucket_start, observed_at,
            five_hour_used_percent, five_hour_reset_at,
            seven_day_used_percent, seven_day_reset_at, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, bucket_start) DO UPDATE SET
            observed_at = excluded.observed_at,
            five_hour_used_percent = excluded.five_hour_used_percent,
            five_hour_reset_at = excluded.five_hour_reset_at,
            seven_day_used_percent = excluded.seven_day_used_percent,
            seven_day_reset_at = excluded.seven_day_reset_at,
            source = excluded.source
        `).run(
          sample.accountId,
          bucketStart,
          sample.observedAt,
          sample.fiveHourUsedPercent ?? null,
          sample.fiveHourResetAt ?? null,
          sample.sevenDayUsedPercent ?? null,
          sample.sevenDayResetAt ?? null,
          sample.source
        )
        database.prepare('DELETE FROM account_codex_quota_samples WHERE observed_at < ?').run(cutoff)
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public readCodexQuotaHistory(accountId: string, from: number, to: number): CodexQuotaHistoryPoint[] {
    if (!accountId || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return []
    const rows = this.requireDatabase().prepare(`
      SELECT account_id, observed_at, five_hour_used_percent, five_hour_reset_at,
             seven_day_used_percent, seven_day_reset_at, source
      FROM account_codex_quota_samples
      WHERE account_id = ? AND observed_at >= ? AND observed_at <= ?
      ORDER BY observed_at ASC
      LIMIT 5000
    `).all(accountId, from, to) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      accountId: String(row.account_id),
      observedAt: Number(row.observed_at),
      ...(typeof row.five_hour_used_percent === 'number' ? { fiveHourUsedPercent: row.five_hour_used_percent } : {}),
      ...(typeof row.five_hour_reset_at === 'number' ? { fiveHourResetAt: row.five_hour_reset_at } : {}),
      ...(typeof row.seven_day_used_percent === 'number' ? { sevenDayUsedPercent: row.seven_day_used_percent } : {}),
      ...(typeof row.seven_day_reset_at === 'number' ? { sevenDayResetAt: row.seven_day_reset_at } : {}),
      source: row.source === 'usage-endpoint' ? 'usage-endpoint' : 'response-headers'
    }))
  }

  public async pruneCodexQuotaHistory(cutoff: number): Promise<void> {
    if (!Number.isFinite(cutoff)) return
    const operation = async (): Promise<void> => {
      this.requireDatabase().prepare('DELETE FROM account_codex_quota_samples WHERE observed_at < ?').run(cutoff)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async deleteCodexQuotaHistory(accountId: string): Promise<void> {
    const operation = async (): Promise<void> => {
      this.requireDatabase().prepare('DELETE FROM account_codex_quota_samples WHERE account_id = ?').run(accountId)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async backupTo(destinationPath: string): Promise<number> {
    const operation = async (): Promise<number> => backup(this.requireDatabase(), destinationPath)
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  public async restoreFrom(stagedDatabasePath: string, rollbackDatabasePath: string): Promise<T> {
    const operation = async (): Promise<T> => {
      const database = this.requireDatabase()
      const rollbackTemporaryPath = join(
        dirname(rollbackDatabasePath),
        `.${basename(rollbackDatabasePath)}.${randomUUID()}.tmp`
      )
      let databaseClosed = false

      try {
        await backup(database, rollbackTemporaryPath)
        if (process.platform !== 'win32') await chmod(rollbackTemporaryPath, 0o600)
        assertDatabaseIntegrity(rollbackTemporaryPath)
        await rename(rollbackTemporaryPath, rollbackDatabasePath)
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        database.close()
        this.database = undefined
        databaseClosed = true
        await replaceDatabaseFile(stagedDatabasePath, this.options.databasePath)
        return await this.initialize()
      } catch (restoreError) {
        await rm(rollbackTemporaryPath, { force: true }).catch(() => undefined)
        if (!databaseClosed) {
          throw new Error(`Unable to prepare SQLite restore: ${messageOf(restoreError)}`)
        }
        this.database = undefined
        const rollbackStage = join(
          dirname(this.options.databasePath),
          `.${SQLITE_DATABASE_FILENAME}.${randomUUID()}.rollback`
        )
        try {
          await copyFile(rollbackDatabasePath, rollbackStage)
          await replaceDatabaseFile(rollbackStage, this.options.databasePath)
          await this.initialize()
        } catch (rollbackError) {
          throw new Error(
            `Unable to restore SQLite state (${messageOf(restoreError)}); rollback also failed (${messageOf(rollbackError)})`
          )
        } finally {
          await rm(rollbackStage, { force: true }).catch(() => undefined)
        }
        throw new Error(`Unable to restore SQLite state; the previous database was recovered: ${messageOf(restoreError)}`)
      }
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  public async close(): Promise<void> {
    do {
      await this.writeChain
      // Allow a completed batch to schedule any arrivals that joined while it
      // was committing before deciding the repository is fully drained.
      await Promise.resolve()
    } while (this.requestLogFlushScheduled || this.pendingRequestLogs.length > 0)
    this.database?.close()
    this.database = undefined
  }

  private normalize(value: T): T {
    const normalized = this.options.normalize?.(structuredClone(value)) ?? structuredClone(value)
    return structuredClone(normalized)
  }

  private async mutateAppMetadata(mutator: (database: DatabaseSync) => void): Promise<void> {
    const operation = async (): Promise<void> => {
      const database = this.requireDatabase()
      database.exec('BEGIN IMMEDIATE')
      try {
        mutator(database)
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error('SQLite state has not been initialized')
    return this.database
  }

  private persist(state: T, legacyImport?: { importedAt: number; source: string }): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      replaceJsonRows(database, 'providers', state.providers)
      replaceJsonRows(database, 'accounts', state.accounts)
      replaceJsonRows(database, 'account_tags', state.accountTags ?? [])
      replaceJsonRows(database, 'proxies', state.proxies)
      replaceJsonRows(database, 'pools', state.pools)
      replaceJsonRows(database, 'routes', state.routes)
      replaceGateway(database, state.gateway)
      replaceJsonRows(database, 'request_logs', state.requestLogs)
      replaceCredentials(database, state.credentials)
      replaceJsonRows(database, 'client_profiles', state.clientProfiles)
      replaceJsonRows(database, 'health_events', state.healthEvents)
      writeMetadata(database, STATE_INITIALIZED_KEY, '1')
      if (legacyImport) writeMetadata(database, LEGACY_IMPORT_KEY, JSON.stringify(legacyImport))
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      throw error
    }
  }

  private readDatabaseState(database: DatabaseSync): T {
    const gatewayRow = database.prepare('SELECT payload FROM gateway_settings WHERE singleton = 1').get() as
      | { payload: string }
      | undefined
    if (!gatewayRow) throw new Error('SQLite state is marked initialized but has no gateway settings')

    const stored = {
      version: this.options.initialData.version,
      providers: readJsonRows(database, 'providers'),
      accounts: readJsonRows(database, 'accounts'),
      accountTags: tableExists(database, 'account_tags')
        ? readJsonRows(database, 'account_tags')
        : [],
      proxies: readJsonRows(database, 'proxies'),
      pools: readJsonRows(database, 'pools'),
      routes: readJsonRows(database, 'routes'),
      gateway: parseJson(gatewayRow.payload, 'gateway settings'),
      requestLogs: readJsonRows(database, 'request_logs'),
      credentials: Object.fromEntries(
        (database.prepare('SELECT id, encrypted_value FROM credentials ORDER BY id').all() as Array<{
          id: string
          encrypted_value: string
        }>).map((row) => [row.id, row.encrypted_value])
      ),
      clientProfiles: tableExists(database, 'client_profiles')
        ? readJsonRows(database, 'client_profiles')
        : [],
      healthEvents: tableExists(database, 'health_events')
        ? readJsonRows(database, 'health_events')
        : []
    } as T
    const normalized = this.normalize(stored)
    if (JSON.stringify(normalized) !== JSON.stringify(stored)) this.persist(normalized)
    return normalized
  }
}

export const SQLITE_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION
export const SQLITE_DATABASE_FILENAME = 'stone-state.sqlite3'
export const LEGACY_JSON_FILENAME = 'stone-state.json'

function configureDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA trusted_schema = OFF')
}

function runMigrations(database: DatabaseSync): void {
  const current = readUserVersion(database)
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`SQLite schema ${current} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`)
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      migration.up(database)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      throw new Error(`SQLite migration ${migration.version} failed: ${messageOf(error)}`)
    }
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

function replaceJsonRows(database: DatabaseSync, table: JsonTable, rows: Identified[]): void {
  database.exec(`DELETE FROM ${table}`)
  const statement = database.prepare(`INSERT INTO ${table} (id, ordinal, payload) VALUES (?, ?, ?)`)
  rows.forEach((row, ordinal) => statement.run(row.id, ordinal, JSON.stringify(row)))
}

function replaceGateway(database: DatabaseSync, gateway: unknown): void {
  database.prepare(`
    INSERT INTO gateway_settings (singleton, payload) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload
  `).run(JSON.stringify(gateway))
}

function replaceCredentials(database: DatabaseSync, credentials: Record<string, string>): void {
  database.exec('DELETE FROM credentials')
  const statement = database.prepare('INSERT INTO credentials (id, encrypted_value) VALUES (?, ?)')
  for (const [id, encryptedValue] of Object.entries(credentials)) statement.run(id, encryptedValue)
}

function readJsonRows(database: DatabaseSync, table: JsonTable): Identified[] {
  return (database.prepare(`SELECT payload FROM ${table} ORDER BY ordinal`).all() as Array<{ payload: string }>)
    .map((row, index) => parseJson(row.payload, `${table} row ${index}`) as Identified)
}

function readMetadata(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function writeMetadata(database: DatabaseSync, key: string, value: string): void {
  database.prepare(`
    INSERT INTO app_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

async function readLegacyState<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`Unable to read legacy JSON state: ${messageOf(error)}`)
  }
}

async function retainLegacyBackup(sourcePath: string): Promise<void> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const destination = `${sourcePath}.migrated${suffix === 0 ? '' : `.${suffix}`}.bak`
    try {
      await copyFile(sourcePath, destination, COPYFILE_EXCL)
      if (process.platform !== 'win32') await chmod(destination, 0o600)
      await rm(sourcePath, { force: true })
      return
    } catch (error) {
      if (isAlreadyExists(error)) continue
      // The database marker prevents another import even when the source cannot
      // be renamed (for example, a read-only legacy file).
      return
    }
  }
}

async function secureDatabaseFile(path: string): Promise<void> {
  const handle = await open(path, 'a', 0o600)
  await handle.close()
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

async function replaceDatabaseFile(sourcePath: string, databasePath: string): Promise<void> {
  await Promise.all([
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true })
  ])
  const previousPath = join(dirname(databasePath), `.${SQLITE_DATABASE_FILENAME}.${randomUUID()}.previous`)
  let previousExists = false
  try {
    await rename(databasePath, previousPath)
    previousExists = true
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  try {
    await rename(sourcePath, databasePath)
  } catch (error) {
    if (previousExists) await rename(previousPath, databasePath).catch(() => undefined)
    throw error
  }
  if (previousExists) await rm(previousPath, { force: true })
  if (process.platform !== 'win32') await chmod(databasePath, 0o600)
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${messageOf(error)}`)
  }
}

function assertDatabaseIntegrity(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    const issues = rows
      .map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? 'unknown integrity error'))
      .filter((result) => result.toLowerCase() !== 'ok')
    if (issues.length > 0) throw new Error(issues[0])
  } finally {
    database.close()
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the original transaction or migration error.
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { found: number }
    | undefined
  return row?.found === 1
}

type JsonTable = 'providers' | 'accounts' | 'account_tags' | 'proxies' | 'pools' | 'routes' | 'request_logs' | 'client_profiles' | 'health_events'
