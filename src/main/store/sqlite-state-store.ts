import { COPYFILE_EXCL } from 'node:constants'
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { estimateOpenAiTokenCosts } from '@shared/openai-pricing'
import type {
  CodexQuotaHistoryPoint,
  OpenAiTokenCostBreakdown,
  PersistentTask,
  RequestLog
} from '@shared/types'

const CURRENT_SCHEMA_VERSION = 9
const STATE_INITIALIZED_KEY = 'state_initialized'
const LEGACY_IMPORT_KEY = 'legacy_json_import'
const LIFETIME_TOKEN_COSTS_KEY = 'lifetime_token_costs_v1'

const TOKEN_COST_NUMBER_KEYS = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'standardInputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'pricedTokens',
  'unpricedTokens',
  'inputCostUsd',
  'cachedInputCostUsd',
  'cacheWriteCostUsd',
  'outputCostUsd',
  'totalCostUsd',
  'pricedRequestCount',
  'unpricedRequestCount',
  'longContextRequestCount'
] as const satisfies readonly Exclude<keyof OpenAiTokenCostBreakdown, 'unknownModels'>[]

interface LifetimeTokenCostState {
  version: 1
  breakdown: OpenAiTokenCostBreakdown
  /** Counts are retained separately so an in-place request update can remove
   * the final occurrence of an unknown model without losing set semantics. */
  unknownModelCounts: Record<string, number>
  initializedAt: number
  updatedAt: number
}

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
  },
  {
    version: 7,
    up(database): void {
      // Retention prunes every account by time. The original composite index
      // starts with account_id and cannot accelerate a global observed_at
      // predicate, turning routine cleanup into a table scan.
      database.exec(`
        CREATE INDEX IF NOT EXISTS account_codex_quota_samples_observed_at
          ON account_codex_quota_samples (observed_at);
      `)
    }
  },
  {
    version: 8,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS persistent_tasks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS persistent_tasks_status_updated
          ON persistent_tasks (status, updated_at DESC);
      `)
    }
  },
  {
    version: 9,
    up(database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS built_in_proxy_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS proxy_profiles (
          id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );
      `)
    }
  }
]

interface SqliteStateStoreOptions<T> {
  databasePath: string
  legacyJsonPath: string
  initialData: T
  normalize?: (value: T, sections?: readonly SqliteStateSection[]) => T
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
  builtInProxySettings?: unknown
  proxyProfiles?: Identified[]
  pools: Identified[]
  routes: Identified[]
  gateway: unknown
  requestLogs: Identified[]
  credentials: Record<string, string>
  clientProfiles: Identified[]
  healthEvents: Identified[]
}

export type SqliteStateSection = Exclude<keyof SqlitePersistedShape, 'version'>

/**
 * Serialized state repository backed by transactional SQLite tables.
 *
 * General mutators operate on an isolated clone. Section-scoped mutators clone
 * only their declared writable sections and treat the remainder as read-only.
 * The result becomes visible only after its transaction commits.
 */
export class SqliteStateStore<T extends SqlitePersistedShape> {
  private data: T
  /** Stable object references provide O(1) lifecycle upserts without scanning
   * or rebuilding the retained request-log array on every telemetry batch. */
  private readonly requestLogsById = new Map<string, Identified>()
  /** Runtime account health is read and patched for every completed request.
   * Keep both the row and its array position indexed by id. */
  private readonly accountsById = new Map<string, { account: Identified; index: number }>()
  /** Monotonic token/cost ledger. Unlike request_logs, this value is not
   * affected by UI history clearing or bounded history retention. */
  private lifetimeTokenCosts: LifetimeTokenCostState | undefined
  private database: DatabaseSync | undefined
  /**
   * Routine observability writes use their own WAL connection with NORMAL
   * durability. Credentials/configuration remain on the FULL-sync connection,
   * while request completion and quota sampling no longer force a disk flush on
   * every transaction.
   */
  private telemetryDatabase: DatabaseSync | undefined
  private writeChain = Promise.resolve()
  private readonly pendingRequestLogs = new Map<string, {
    log: Identified
    maximumRows: number
    completions: Array<{
      resolve: () => void
      reject: (error: unknown) => void
    }>
  }>()
  private requestLogFlushScheduled = false

  public constructor(private readonly options: SqliteStateStoreOptions<T>) {
    this.data = this.normalize(options.initialData)
    this.rebuildRequestLogLookup()
    this.rebuildAccountLookup()
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

      const lifetimeTokenCostMetadata = readMetadata(database, LIFETIME_TOKEN_COSTS_KEY)
      if (lifetimeTokenCostMetadata === undefined) {
        this.lifetimeTokenCosts = createLifetimeTokenCostState(this.data.requestLogs, Date.now())
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(this.lifetimeTokenCosts))
      } else {
        this.lifetimeTokenCosts = parseLifetimeTokenCostState(lifetimeTokenCostMetadata)
        if (!this.lifetimeTokenCosts) {
          throw new Error('Lifetime token ledger metadata is invalid; refusing to discard cumulative history')
        }
      }

      if (process.platform !== 'win32') {
        await chmod(this.options.databasePath, 0o600)
      }
      const telemetryDatabase = new DatabaseSync(this.options.databasePath)
      configureTelemetryDatabase(telemetryDatabase)
      this.telemetryDatabase = telemetryDatabase
      this.rebuildRequestLogLookup()
      this.rebuildAccountLookup()
      return this.read()
    } catch (error) {
      this.telemetryDatabase?.close()
      this.telemetryDatabase = undefined
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

  public selectAccount<TAccount extends Identified>(id: string): TAccount | undefined {
    const indexed = this.accountsById.get(id)
    return indexed ? structuredClone(indexed.account) as TAccount : undefined
  }

  public readAppMetadata(key: string): string | undefined {
    return readMetadata(this.requireDatabase(), key)
  }

  /** Returns the durable lifetime total without traversing retained history. */
  public readLifetimeTokenCosts(): OpenAiTokenCostBreakdown {
    return structuredClone(this.requireLifetimeTokenCosts().breakdown)
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
    await this.mutate(mutator)
    return this.read()
  }

  /**
   * Mutation variant for callers that do not need a second full snapshot clone.
   * Supplying sections also limits SQL replacement to the tables the operation
   * can change; this keeps unrelated 20k-row request history off config writes.
   */
  public async mutate(
    mutator: (draft: T) => void | Promise<void>,
    sections?: readonly SqliteStateSection[]
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      this.requireDatabase()
      const next = sections ? this.createMutationDraft(sections) : this.read()
      await mutator(next)
      // `next` is already detached from internal state. Avoid two redundant
      // structured clones around the normalizer on every configuration edit.
      const normalized = this.normalizeDetached(next, sections)
      const touchesRequestLogs = !sections || sections.includes('requestLogs')
      const nextLifetimeTokenCosts = touchesRequestLogs && this.lifetimeTokenCosts
        ? applyLifetimeTokenCostRequestLogState(
            this.lifetimeTokenCosts,
            this.data.requestLogs,
            normalized.requestLogs,
            Date.now()
          )
        : undefined
      if (sections) this.persistSections(normalized, sections, nextLifetimeTokenCosts)
      else this.persist(normalized, undefined, nextLifetimeTokenCosts)
      this.data = normalized
      if (nextLifetimeTokenCosts) this.lifetimeTokenCosts = nextLifetimeTokenCosts
      // Selective configuration mutations share the immutable request-log row
      // objects; rebuilding a 20k-entry index for every provider edit defeats
      // the point of section-scoped persistence. Rebuild only when that table
      // was explicitly writable (or for a legacy full-state mutation).
      if (!sections || sections.includes('requestLogs')) this.rebuildRequestLogLookup()
      if (!sections || sections.includes('accounts')) this.rebuildAccountLookup()
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(
      () => undefined,
      () => undefined
    )
    await pending
  }

  public appendRequestLog(log: Identified, maximumRows: number): Promise<void> {
    const detached = structuredClone(log)
    const completion = new Promise<void>((resolve, reject) => {
      const pending = this.pendingRequestLogs.get(detached.id)
      if (pending) {
        // A request lifecycle can emit several progress updates in one event-loop
        // burst. Only the newest state needs to reach SQLite; every caller still
        // resolves at the same durability boundary.
        pending.log = detached
        pending.maximumRows = Math.min(pending.maximumRows, maximumRows)
        pending.completions.push({ resolve, reject })
      } else {
        this.pendingRequestLogs.set(detached.id, {
          log: detached,
          maximumRows,
          completions: [{ resolve, reject }]
        })
      }
    })
    this.scheduleRequestLogFlush()
    return completion
  }

  private scheduleRequestLogFlush(): void {
    if (this.requestLogFlushScheduled) return
    this.requestLogFlushScheduled = true
    const operation = async (): Promise<void> => {
      // Wait through the current poll phase so concurrent request completions
      // observed in the same event-loop turn share one telemetry transaction.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const batch = [...this.pendingRequestLogs.values()]
      this.pendingRequestLogs.clear()
      if (batch.length === 0) return
      try {
        const database = this.requireTelemetryDatabase()
        const retainedRows = Math.min(...batch.map((entry) => entry.maximumRows))
        const nextLifetimeTokenCosts = applyLifetimeTokenCostReplacements(
          this.requireLifetimeTokenCosts(),
          batch.map(({ log }) => ({
            previous: this.requestLogsById.get(log.id),
            next: log
          })),
          Date.now()
        )
        database.exec('BEGIN IMMEDIATE')
        const insert = database.prepare(`
          INSERT INTO request_logs (id, ordinal, payload)
          VALUES (?, COALESCE((SELECT MIN(ordinal) - 1 FROM request_logs), 0), ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
        `)
        for (const { log: entry } of batch) insert.run(entry.id, JSON.stringify(entry))
        const insertedCount = batch.reduce(
          (count, { log }) => count + (this.requestLogsById.has(log.id) ? 0 : 1),
          0
        )
        if (this.data.requestLogs.length + insertedCount > retainedRows) {
          database.prepare(`
            DELETE FROM request_logs
            WHERE id IN (
              SELECT id FROM request_logs ORDER BY ordinal LIMIT -1 OFFSET ?
            )
          `).run(retainedRows)
        }
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(nextLifetimeTokenCosts))
        database.exec('COMMIT')
        this.lifetimeTokenCosts = nextLifetimeTokenCosts
        const inserted: Identified[] = []
        for (const { log } of batch) {
          const existing = this.requestLogsById.get(log.id)
          if (existing) replaceIdentifiedObject(existing, log)
          else {
            this.requestLogsById.set(log.id, log)
            // SQL assigns a lower ordinal to every subsequent insert, so later
            // batch entries are newer and appear first in memory as well.
            inserted.unshift(log)
          }
        }
        if (inserted.length) this.data.requestLogs.unshift(...inserted)
        const removed = this.data.requestLogs.splice(retainedRows)
        for (const entry of removed) {
          if (this.requestLogsById.get(entry.id) === entry) this.requestLogsById.delete(entry.id)
        }
        for (const entry of batch) {
          for (const completion of entry.completions) completion.resolve()
        }
      } catch (error) {
        if (this.telemetryDatabase) rollback(this.telemetryDatabase)
        for (const entry of batch) {
          for (const completion of entry.completions) completion.reject(error)
        }
        throw error
      }
    }

    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    void pending.finally(() => {
      this.requestLogFlushScheduled = false
      if (this.pendingRequestLogs.size > 0) this.scheduleRequestLogFlush()
    }).catch(() => {
      // Individual callers receive the write failure through their completion.
    })
  }

  /** Appends a bounded health event without rewriting unrelated state tables. */
  public async appendHealthEvent<TEvent extends Identified>(event: TEvent, maximumRows: number): Promise<void> {
    const detached = structuredClone(event)
    const operation = async (): Promise<void> => {
      const database = this.requireTelemetryDatabase()
      const existing = this.data.healthEvents.findIndex((entry) => entry.id === detached.id)
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(`
          INSERT INTO health_events (id, ordinal, payload)
          VALUES (?, COALESCE((SELECT MIN(ordinal) - 1 FROM health_events), 0), ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
        `).run(detached.id, JSON.stringify(detached))
        if (existing < 0 && this.data.healthEvents.length >= maximumRows) {
          database.prepare(`
            DELETE FROM health_events
            WHERE id IN (
              SELECT id FROM health_events ORDER BY ordinal LIMIT -1 OFFSET ?
            )
          `).run(maximumRows)
        }
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      const healthEvents = existing < 0
        ? [detached, ...this.data.healthEvents]
        : this.data.healthEvents.map((entry, index) => index === existing ? detached : entry)
      healthEvents.splice(maximumRows)
      this.data = { ...this.data, healthEvents }
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  /** Clears request history using its table directly rather than a full-state
   * persist. Tracked rows are captured inside the serialized operation, after
   * any already-queued checkpoints have committed and before deletion. */
  public async clearRequestLogs<TLog extends Identified>(
    trackedIds: ReadonlySet<string> = new Set()
  ): Promise<TLog[]> {
    const tracked = new Set(trackedIds)
    const operation = async (): Promise<TLog[]> => {
      const trackedLogs = this.data.requestLogs
        .filter((log) => tracked.has(log.id))
        .map((log) => structuredClone(log) as TLog)
      this.requireDatabase().exec('DELETE FROM request_logs')
      this.data = { ...this.data, requestLogs: [] }
      this.requestLogsById.clear()
      return trackedLogs
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    return pending
  }

  /** Records a request contribution without recreating a cleared history row.
   * `previous` is the last checkpoint already present in the lifetime ledger;
   * supplying it changes only the delta through the final request state. */
  public async replaceLifetimeRequestLogContribution(
    next: RequestLog,
    previous?: RequestLog
  ): Promise<void> {
    const detachedNext = structuredClone(next)
    const detachedPrevious = previous ? structuredClone(previous) : undefined
    const operation = async (): Promise<void> => {
      const database = this.requireTelemetryDatabase()
      const nextLifetimeTokenCosts = applyLifetimeTokenCostReplacements(
        this.requireLifetimeTokenCosts(),
        [{ previous: detachedPrevious, next: detachedNext }],
        Date.now()
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(nextLifetimeTokenCosts))
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      this.lifetimeTokenCosts = nextLifetimeTokenCosts
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  /**
   * Applies sparse metadata updates to persisted request rows. Returning
   * undefined keeps a row untouched, so conversation-title refreshes avoid
   * cloning and rewriting the complete retained history.
   */
  public async updateRequestLogs<TLog extends Identified>(
    transform: (log: Readonly<TLog>) => TLog | undefined
  ): Promise<number> {
    const operation = async (): Promise<number> => {
      const database = this.requireTelemetryDatabase()
      const replacements = new Map<string, TLog>()
      for (const entry of this.data.requestLogs) {
        const replacement = transform(entry as TLog)
        if (!replacement) continue
        if (replacement.id !== entry.id) throw new Error('A request log update cannot change its id.')
        replacements.set(entry.id, structuredClone(replacement))
      }
      if (replacements.size === 0) return 0
      const nextLifetimeTokenCosts = applyLifetimeTokenCostReplacements(
        this.requireLifetimeTokenCosts(),
        [...replacements].map(([id, replacement]) => ({
          previous: this.requestLogsById.get(id),
          next: replacement
        })),
        Date.now()
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        const update = database.prepare('UPDATE request_logs SET payload = ? WHERE id = ?')
        for (const [id, replacement] of replacements) {
          const result = update.run(JSON.stringify(replacement), id)
          if (result.changes !== 1) throw new Error('Request log not found.')
        }
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(nextLifetimeTokenCosts))
        database.exec('COMMIT')
      } catch (error) {
        rollback(database)
        throw error
      }
      this.lifetimeTokenCosts = nextLifetimeTokenCosts
      for (const [id, replacement] of replacements) {
        const existing = this.requestLogsById.get(id)
        if (existing) replaceIdentifiedObject(existing, replacement)
      }
      return replacements.size
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    return pending
  }

  /** Clears health history using its table directly rather than a full-state persist. */
  public async clearHealthEvents(): Promise<void> {
    const operation = async (): Promise<void> => {
      this.requireDatabase().exec('DELETE FROM health_events')
      this.data = { ...this.data, healthEvents: [] }
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async updateAccount<TAccount extends Identified>(
    id: string,
    mutator: (account: TAccount) => void
  ): Promise<TAccount> {
    const [account] = await this.updateAccounts<TAccount>([id], (entry) => mutator(entry))
    return account
  }

  /**
   * Updates a group of account rows in one transaction. Runtime telemetry often
   * arrives for several accounts at once; serializing those observations into
   * individual FULL-sync transactions needlessly stalls the gateway thread.
   */
  public async updateAccounts<TAccount extends Identified>(
    ids: readonly string[],
    mutator: (account: TAccount, id: string) => void,
    quotaSample?: (account: Readonly<TAccount>, id: string) => CodexQuotaHistoryPoint | undefined
  ): Promise<TAccount[]> {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return []
    const operation = async (): Promise<TAccount[]> => {
      const database = this.requireTelemetryDatabase()
      const staged = uniqueIds.map((id) => {
        const indexed = this.accountsById.get(id)
        if (!indexed) throw new Error('Account not found.')
        const index = indexed.index
        const account = structuredClone(indexed.account) as TAccount
        const before = JSON.stringify(account)
        mutator(account, id)
        if (account.id !== id) throw new Error('An account update cannot change its id.')
        const payload = JSON.stringify(account)
        return {
          id,
          index,
          account,
          payload,
          changed: payload !== before,
          quotaSample: quotaSample?.(account, id)
        }
      })
      const changed = staged.filter((entry) => entry.changed)
      const quotaSamples = normalizeCodexQuotaSamples(
        staged.flatMap((entry) => entry.quotaSample ? [entry.quotaSample] : []),
        5 * 60 * 1000
      )
      if (changed.length > 0 || quotaSamples.length > 0) {
        database.exec('BEGIN IMMEDIATE')
        try {
          const update = database.prepare('UPDATE accounts SET payload = ? WHERE id = ?')
          for (const entry of changed) {
            const result = update.run(entry.payload, entry.id)
            if (result.changes !== 1) throw new Error('Account not found.')
          }
          writeCodexQuotaSamples(database, quotaSamples, 14 * 24 * 60 * 60 * 1000)
          database.exec('COMMIT')
        } catch (error) {
          rollback(database)
          throw error
        }
        if (changed.length > 0) {
          const accounts = [...this.data.accounts]
          for (const entry of changed) {
            const replacement = structuredClone(entry.account)
            accounts[entry.index] = replacement
            this.accountsById.set(entry.id, { account: replacement, index: entry.index })
          }
          this.data = { ...this.data, accounts }
        }
      }
      return staged.map((entry) => structuredClone(entry.account))
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
      const indexed = this.accountsById.get(accountId)
      if (!indexed) throw new Error('Account not found.')
      const index = indexed.index
      const account = structuredClone(indexed.account) as TAccount
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
      const replacement = structuredClone(account)
      accounts[index] = replacement
      this.accountsById.set(accountId, { account: replacement, index })
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
    await this.appendCodexQuotaSamples([sample], bucketSizeMs, retentionMs)
  }

  /** Stores a telemetry burst with one commit and one retention pass. */
  public async appendCodexQuotaSamples(
    samples: readonly CodexQuotaHistoryPoint[],
    bucketSizeMs = 5 * 60 * 1000,
    retentionMs = 14 * 24 * 60 * 60 * 1000
  ): Promise<void> {
    const batch = normalizeCodexQuotaSamples(samples, bucketSizeMs)
    if (batch.length === 0) return
    const operation = async (): Promise<void> => {
      const database = this.requireTelemetryDatabase()
      database.exec('BEGIN IMMEDIATE')
      try {
        writeCodexQuotaSamples(database, batch, retentionMs)
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
    const rows = this.requireTelemetryDatabase().prepare(`
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
      this.requireTelemetryDatabase().prepare('DELETE FROM account_codex_quota_samples WHERE observed_at < ?').run(cutoff)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async deleteCodexQuotaHistory(accountId: string): Promise<void> {
    const operation = async (): Promise<void> => {
      this.requireTelemetryDatabase().prepare('DELETE FROM account_codex_quota_samples WHERE account_id = ?').run(accountId)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public listPersistentTasks<TPayload = unknown, TResult = unknown>(limit = 200): PersistentTask<TPayload, TResult>[] {
    const rows = this.requireDatabase().prepare(`
      SELECT payload FROM persistent_tasks ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(2_000, Math.floor(limit)))) as Array<{ payload: string }>
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.payload) as PersistentTask<TPayload, TResult>]
      } catch {
        return []
      }
    })
  }

  public getPersistentTask<TPayload = unknown, TResult = unknown>(id: string): PersistentTask<TPayload, TResult> | undefined {
    const row = this.requireDatabase().prepare('SELECT payload FROM persistent_tasks WHERE id = ?')
      .get(id) as { payload?: string } | undefined
    if (!row?.payload) return undefined
    try {
      return JSON.parse(row.payload) as PersistentTask<TPayload, TResult>
    } catch {
      return undefined
    }
  }

  public async upsertPersistentTask(task: PersistentTask): Promise<void> {
    const detached = structuredClone(task)
    const operation = async (): Promise<void> => {
      this.requireDatabase().prepare(`
        INSERT INTO persistent_tasks (id, kind, status, updated_at, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          updated_at = excluded.updated_at,
          payload = excluded.payload
      `).run(detached.id, detached.kind, detached.status, detached.updatedAt, JSON.stringify(detached))
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async deletePersistentTask(id: string): Promise<void> {
    const operation = async (): Promise<void> => {
      this.requireDatabase().prepare('DELETE FROM persistent_tasks WHERE id = ?').run(id)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    await pending
  }

  public async prunePersistentTasks(cutoff: number, maximumTerminalRows: number): Promise<number> {
    const normalizedCutoff = Number.isFinite(cutoff) ? Math.floor(cutoff) : 0
    const normalizedMaximum = Math.max(0, Math.floor(maximumTerminalRows))
    const operation = async (): Promise<number> => {
      const database = this.requireDatabase()
      database.exec('BEGIN IMMEDIATE')
      try {
        const expired = database.prepare(`
          DELETE FROM persistent_tasks
          WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?
        `).run(normalizedCutoff)
        const excess = database.prepare(`
          DELETE FROM persistent_tasks
          WHERE id IN (
            SELECT id FROM persistent_tasks
            WHERE status IN ('completed', 'cancelled', 'failed')
            ORDER BY updated_at DESC
            LIMIT -1 OFFSET ?
          )
        `).run(normalizedMaximum)
        database.exec('COMMIT')
        return Number(expired.changes) + Number(excess.changes)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    return pending
  }

  public async clearTerminalPersistentTasks(): Promise<number> {
    const operation = async (): Promise<number> => {
      const result = this.requireDatabase().prepare(`
        DELETE FROM persistent_tasks WHERE status IN ('completed', 'cancelled', 'failed')
      `).run()
      return Number(result.changes)
    }
    const pending = this.writeChain.then(operation, operation)
    this.writeChain = pending.then(() => undefined, () => undefined)
    return pending
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
        this.telemetryDatabase?.close()
        this.telemetryDatabase = undefined
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
    } while (this.requestLogFlushScheduled || this.pendingRequestLogs.size > 0)
    this.telemetryDatabase?.close()
    this.telemetryDatabase = undefined
    this.database?.close()
    this.database = undefined
  }

  private normalize(value: T): T {
    const normalized = this.options.normalize?.(structuredClone(value)) ?? structuredClone(value)
    return structuredClone(normalized)
  }

  private normalizeDetached(value: T, sections?: readonly SqliteStateSection[]): T {
    let normalized = this.options.normalize?.(value, sections) ?? value
    if (sections && !sections.includes('requestLogs') && normalized.requestLogs !== this.data.requestLogs) {
      // Normalizers often defensively slice request history. A section-scoped
      // config mutation cannot have changed that table, so retain its stable
      // array/index instead of paying another 20k-row rebuild.
      normalized = { ...normalized, requestLogs: this.data.requestLogs }
    }
    if (sections && !sections.includes('accounts') && normalized.accounts !== this.data.accounts) {
      normalized = { ...normalized, accounts: this.data.accounts }
    }
    return normalized
  }

  private rebuildRequestLogLookup(): void {
    this.requestLogsById.clear()
    for (const entry of this.data.requestLogs) this.requestLogsById.set(entry.id, entry)
  }

  private rebuildAccountLookup(): void {
    this.accountsById.clear()
    this.data.accounts.forEach((account, index) => {
      this.accountsById.set(account.id, { account, index })
    })
  }

  private createMutationDraft(sections: readonly SqliteStateSection[]): T {
    // Configuration mutators declare the tables they may change. Clone only
    // those sections; all other sections are read-only inputs to validation and
    // normalization. This avoids deep-cloning retained request history for an
    // unrelated route/provider edit.
    const draft = { ...this.data } as T
    const draftRecord = draft as unknown as Record<SqliteStateSection, unknown>
    const currentRecord = this.data as unknown as Record<SqliteStateSection, unknown>
    for (const section of new Set(sections)) {
      draftRecord[section] = structuredClone(currentRecord[section])
    }
    return draft
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

  private requireTelemetryDatabase(): DatabaseSync {
    if (!this.telemetryDatabase) throw new Error('SQLite telemetry state has not been initialized')
    return this.telemetryDatabase
  }

  private requireLifetimeTokenCosts(): LifetimeTokenCostState {
    if (!this.lifetimeTokenCosts) throw new Error('SQLite lifetime token ledger has not been initialized')
    return this.lifetimeTokenCosts
  }

  private persist(
    state: T,
    legacyImport?: { importedAt: number; source: string },
    lifetimeTokenCosts?: LifetimeTokenCostState
  ): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      replaceJsonRows(database, 'providers', state.providers)
      replaceJsonRows(database, 'accounts', state.accounts)
      replaceJsonRows(database, 'account_tags', state.accountTags ?? [])
      replaceJsonRows(database, 'proxies', state.proxies)
      replaceBuiltInProxySettings(database, state.builtInProxySettings)
      replaceJsonRows(database, 'proxy_profiles', state.proxyProfiles ?? [])
      replaceJsonRows(database, 'pools', state.pools)
      replaceJsonRows(database, 'routes', state.routes)
      replaceGateway(database, state.gateway)
      replaceJsonRows(database, 'request_logs', state.requestLogs)
      replaceCredentials(database, state.credentials)
      replaceJsonRows(database, 'client_profiles', state.clientProfiles)
      replaceJsonRows(database, 'health_events', state.healthEvents)
      writeMetadata(database, STATE_INITIALIZED_KEY, '1')
      if (legacyImport) writeMetadata(database, LEGACY_IMPORT_KEY, JSON.stringify(legacyImport))
      if (lifetimeTokenCosts) {
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(lifetimeTokenCosts))
      }
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      throw error
    }
  }

  private persistSections(
    state: T,
    requestedSections: readonly SqliteStateSection[],
    lifetimeTokenCosts?: LifetimeTokenCostState
  ): void {
    const sections = new Set(requestedSections)
    if (sections.size === 0) return
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      if (sections.has('providers')) replaceJsonRows(database, 'providers', state.providers)
      if (sections.has('accounts')) replaceJsonRows(database, 'accounts', state.accounts)
      if (sections.has('accountTags')) replaceJsonRows(database, 'account_tags', state.accountTags ?? [])
      if (sections.has('proxies')) replaceJsonRows(database, 'proxies', state.proxies)
      if (sections.has('builtInProxySettings')) {
        replaceBuiltInProxySettings(database, state.builtInProxySettings)
      }
      if (sections.has('proxyProfiles')) replaceJsonRows(database, 'proxy_profiles', state.proxyProfiles ?? [])
      if (sections.has('pools')) replaceJsonRows(database, 'pools', state.pools)
      if (sections.has('routes')) replaceJsonRows(database, 'routes', state.routes)
      if (sections.has('gateway')) replaceGateway(database, state.gateway)
      if (sections.has('requestLogs')) replaceJsonRows(database, 'request_logs', state.requestLogs)
      if (sections.has('credentials')) replaceCredentials(database, state.credentials)
      if (sections.has('clientProfiles')) replaceJsonRows(database, 'client_profiles', state.clientProfiles)
      if (sections.has('healthEvents')) replaceJsonRows(database, 'health_events', state.healthEvents)
      if (lifetimeTokenCosts) {
        writeMetadata(database, LIFETIME_TOKEN_COSTS_KEY, JSON.stringify(lifetimeTokenCosts))
      }
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
    const builtInProxySettingsRow = database.prepare(
      'SELECT payload FROM built_in_proxy_settings WHERE singleton = 1'
    ).get() as { payload: string } | undefined

    const stored = {
      version: this.options.initialData.version,
      providers: readJsonRows(database, 'providers'),
      accounts: readJsonRows(database, 'accounts'),
      accountTags: tableExists(database, 'account_tags')
        ? readJsonRows(database, 'account_tags')
        : [],
      proxies: readJsonRows(database, 'proxies'),
      builtInProxySettings: builtInProxySettingsRow
        ? parseJson(builtInProxySettingsRow.payload, 'built-in proxy settings')
        : undefined,
      proxyProfiles: readJsonRows(database, 'proxy_profiles'),
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

/** Replaces a retained row without changing its object identity. Keeping the
 * reference stable lets the request-log index point directly at the live row,
 * while deleting absent optional fields preserves full replacement semantics. */
function replaceIdentifiedObject(target: Identified, source: Identified): void {
  const targetRecord = target as unknown as Record<string, unknown>
  const sourceRecord = source as unknown as Record<string, unknown>
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) delete targetRecord[key]
  }
  Object.assign(targetRecord, sourceRecord)
}

interface NormalizedCodexQuotaSample {
  sample: CodexQuotaHistoryPoint
  bucketStart: number
}

function normalizeCodexQuotaSamples(
  samples: readonly CodexQuotaHistoryPoint[],
  bucketSizeMs: number
): NormalizedCodexQuotaSample[] {
  const normalized = new Map<string, NormalizedCodexQuotaSample>()
  for (const sample of samples) {
    if (!sample.accountId || !Number.isFinite(sample.observedAt)) continue
    const bucketStart = Math.floor(sample.observedAt / bucketSizeMs) * bucketSizeMs
    const key = `${sample.accountId}\u0000${bucketStart}`
    const existing = normalized.get(key)
    if (!existing || existing.sample.observedAt <= sample.observedAt) {
      normalized.set(key, { sample: structuredClone(sample), bucketStart })
    }
  }
  return [...normalized.values()]
}

function writeCodexQuotaSamples(
  database: DatabaseSync,
  batch: readonly NormalizedCodexQuotaSample[],
  retentionMs: number
): void {
  if (batch.length === 0) return
  const insert = database.prepare(`
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
  `)
  for (const { sample, bucketStart } of batch) {
    insert.run(
      sample.accountId,
      bucketStart,
      sample.observedAt,
      sample.fiveHourUsedPercent ?? null,
      sample.fiveHourResetAt ?? null,
      sample.sevenDayUsedPercent ?? null,
      sample.sevenDayResetAt ?? null,
      sample.source
    )
  }
  const cutoff = Math.max(...batch.map(({ sample }) => sample.observedAt)) - retentionMs
  database.prepare('DELETE FROM account_codex_quota_samples WHERE observed_at < ?').run(cutoff)
}

function configureDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA trusted_schema = OFF')
}

function configureTelemetryDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
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

function replaceBuiltInProxySettings(database: DatabaseSync, settings: unknown | undefined): void {
  if (settings === undefined) {
    database.exec('DELETE FROM built_in_proxy_settings')
    return
  }
  database.prepare(`
    INSERT INTO built_in_proxy_settings (singleton, payload) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload
  `).run(JSON.stringify(settings))
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

function parseLifetimeTokenCostState(serialized: string): LifetimeTokenCostState | undefined {
  if (!serialized) return undefined
  try {
    const candidate = JSON.parse(serialized) as Partial<LifetimeTokenCostState>
    if (
      candidate.version !== 1
      || !candidate.breakdown
      || !candidate.unknownModelCounts
      || typeof candidate.unknownModelCounts !== 'object'
      || Array.isArray(candidate.unknownModelCounts)
    ) return undefined
    const breakdown = candidate.breakdown as Partial<OpenAiTokenCostBreakdown>
    const normalizedBreakdown = {} as OpenAiTokenCostBreakdown
    for (const key of TOKEN_COST_NUMBER_KEYS) {
      const value = breakdown[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
      normalizedBreakdown[key] = value
    }
    const unknownModelCounts: Record<string, number> = Object.create(null)
    for (const [model, count] of Object.entries(candidate.unknownModelCounts)) {
      if (!model || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
      unknownModelCounts[model] = Math.floor(count)
    }
    normalizedBreakdown.unknownModels = Object.keys(unknownModelCounts)
      .sort((left, right) => left.localeCompare(right))
    if (!validLifetimeTokenCostBreakdown(normalizedBreakdown, unknownModelCounts)) return undefined
    const initializedAt = finiteTimestamp(candidate.initializedAt) ?? Date.now()
    const updatedAt = finiteTimestamp(candidate.updatedAt) ?? initializedAt
    return {
      version: 1,
      breakdown: normalizedBreakdown,
      unknownModelCounts,
      initializedAt,
      updatedAt
    }
  } catch {
    return undefined
  }
}

function validLifetimeTokenCostBreakdown(
  breakdown: Readonly<OpenAiTokenCostBreakdown>,
  unknownModelCounts: Readonly<Record<string, number>>
): boolean {
  const unknownRequestCount = Object.values(unknownModelCounts)
    .reduce((total, count) => total + count, 0)
  return closeEnough(breakdown.totalTokens, breakdown.inputTokens + breakdown.outputTokens)
    && closeEnough(breakdown.totalTokens, breakdown.pricedTokens + breakdown.unpricedTokens)
    && closeEnough(
      breakdown.totalCostUsd,
      breakdown.inputCostUsd + breakdown.cachedInputCostUsd + breakdown.outputCostUsd
    )
    && breakdown.cacheWriteCostUsd <= breakdown.inputCostUsd + 1e-9
    && closeEnough(breakdown.unpricedRequestCount, unknownRequestCount)
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left), Math.abs(right)) * 1e-9
}

function createLifetimeTokenCostState(
  logs: readonly Identified[],
  now: number
): LifetimeTokenCostState {
  const tokenLogs = logs.filter(isTokenCostRequestLog)
  const breakdown = estimateOpenAiTokenCosts(tokenLogs)
  const unknownModelCounts: Record<string, number> = Object.create(null)
  for (const log of tokenLogs) {
    const model = unknownModelContribution(log)
    if (model) unknownModelCounts[model] = (unknownModelCounts[model] ?? 0) + 1
  }
  breakdown.unknownModels = Object.keys(unknownModelCounts)
    .sort((left, right) => left.localeCompare(right))
  return {
    version: 1,
    breakdown,
    unknownModelCounts,
    initializedAt: now,
    updatedAt: now
  }
}

function applyLifetimeTokenCostReplacements(
  current: Readonly<LifetimeTokenCostState>,
  replacements: readonly { previous?: Identified; next?: Identified }[],
  now: number
): LifetimeTokenCostState {
  const breakdown = structuredClone(current.breakdown)
  const unknownModelCounts: Record<string, number> = Object.assign(
    Object.create(null),
    current.unknownModelCounts
  )
  for (const replacement of replacements) {
    const previous = replacement.previous && isTokenCostRequestLog(replacement.previous)
      ? estimateOpenAiTokenCosts([replacement.previous])
      : undefined
    const next = replacement.next && isTokenCostRequestLog(replacement.next)
      ? estimateOpenAiTokenCosts([replacement.next])
      : undefined
    for (const key of TOKEN_COST_NUMBER_KEYS) {
      breakdown[key] = nonNegativeFinite(
        breakdown[key] - (previous?.[key] ?? 0) + (next?.[key] ?? 0)
      )
    }
    adjustUnknownModelCount(
      unknownModelCounts,
      previous && previous.unpricedRequestCount > 0 ? previous.unknownModels[0] : undefined,
      -1
    )
    adjustUnknownModelCount(
      unknownModelCounts,
      next && next.unpricedRequestCount > 0 ? next.unknownModels[0] : undefined,
      1
    )
  }
  breakdown.unknownModels = Object.keys(unknownModelCounts)
    .sort((left, right) => left.localeCompare(right))
  return {
    version: 1,
    breakdown,
    unknownModelCounts,
    initializedAt: current.initializedAt,
    updatedAt: now
  }
}

function applyLifetimeTokenCostRequestLogState(
  current: Readonly<LifetimeTokenCostState>,
  previousLogs: readonly Identified[],
  nextLogs: readonly Identified[],
  now: number
): LifetimeTokenCostState {
  const previousById = new Map(previousLogs.map((log) => [log.id, log] as const))
  return applyLifetimeTokenCostReplacements(
    current,
    nextLogs.map((next) => ({ previous: previousById.get(next.id), next })),
    now
  )
}

function isTokenCostRequestLog(value: Identified): value is RequestLog {
  const candidate = value as Partial<RequestLog>
  return typeof candidate.model === 'string'
}

function unknownModelContribution(log: Readonly<RequestLog>): string | undefined {
  const contribution = estimateOpenAiTokenCosts([log])
  return contribution.unpricedRequestCount > 0 ? contribution.unknownModels[0] : undefined
}

function adjustUnknownModelCount(
  counts: Record<string, number>,
  model: string | undefined,
  delta: -1 | 1
): void {
  if (!model) return
  const next = (counts[model] ?? 0) + delta
  if (next > 0) counts[model] = next
  else delete counts[model]
}

function nonNegativeFinite(value: number): number {
  if (!Number.isFinite(value) || value <= 1e-12) return 0
  return value
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
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

type JsonTable =
  | 'providers'
  | 'accounts'
  | 'account_tags'
  | 'proxies'
  | 'proxy_profiles'
  | 'pools'
  | 'routes'
  | 'request_logs'
  | 'client_profiles'
  | 'health_events'
