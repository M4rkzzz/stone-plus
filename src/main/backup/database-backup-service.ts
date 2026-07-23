import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLITE_SCHEMA_VERSION } from '../store/sqlite-state-store'
import type {
  DatabaseBackupInfo,
  DatabaseBackupKind,
  DatabaseBackupServiceOptions,
  DatabaseBackupVerification,
  DatabaseRestoreResult
} from './types'
import {
  decryptPortableBackup,
  encryptPortableBackup,
  recoverPortableBackupReplacements,
  type PortableBackupInfo,
} from './portable-backup'
import { preparePortableExportDatabase, preparePortableImportedDatabase } from './portable-secrets'

const BACKUP_DIRECTORY_NAME = 'backups'
const PORTABLE_REPLACE_JOURNAL_DIRECTORY_NAME = 'portable-replace-journals'
const DEFAULT_AUTOMATIC_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_AUTOMATIC_RETENTION = 7
const DEFAULT_PRE_RESTORE_RETENTION = 3
const BACKUP_PATTERN = /^stone-backup-(\d{13,16})-(manual|automatic|pre-restore)-([0-9a-f-]{8,})\.sqlite3$/
const REQUIRED_SCHEMA_ONE_TABLES = [
  'accounts',
  'app_metadata',
  'credentials',
  'gateway_settings',
  'pools',
  'providers',
  'request_logs',
  'routes',
  'schema_migrations'
] as const

export class DatabaseBackupService<T> {
  private readonly backupDirectory: string
  private readonly portableReplacementJournalDirectory: string
  private readonly store: DatabaseBackupServiceOptions<T>['store']
  private readonly automaticIntervalMs: number
  private automaticRetention: number
  private readonly preRestoreRetention: number
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly onAutomaticBackupError: (error: Error) => void
  private readonly portableSecretVault: DatabaseBackupServiceOptions<T>['portableSecretVault']
  private automaticTimer: NodeJS.Timeout | undefined
  private automaticRun: Promise<DatabaseBackupInfo | undefined> | undefined

  public constructor(options: DatabaseBackupServiceOptions<T>) {
    this.backupDirectory = join(options.userDataPath, BACKUP_DIRECTORY_NAME)
    this.portableReplacementJournalDirectory = join(
      this.backupDirectory,
      PORTABLE_REPLACE_JOURNAL_DIRECTORY_NAME,
    )
    this.store = options.store
    this.automaticIntervalMs = positiveInteger(
      options.automaticIntervalMs ?? DEFAULT_AUTOMATIC_INTERVAL_MS,
      'Automatic backup interval'
    )
    this.automaticRetention = positiveInteger(
      options.automaticRetention ?? DEFAULT_AUTOMATIC_RETENTION,
      'Automatic backup retention'
    )
    this.preRestoreRetention = positiveInteger(
      options.preRestoreRetention ?? DEFAULT_PRE_RESTORE_RETENTION,
      'Pre-restore backup retention'
    )
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.onAutomaticBackupError = options.onAutomaticBackupError ?? ((error) => {
      console.error('Stone+ automatic database backup failed', error)
    })
    this.portableSecretVault = options.portableSecretVault
  }

  public get directory(): string {
    return this.backupDirectory
  }

  public async initialize(): Promise<void> {
    await this.ensureDirectory()
    const recovery = await recoverPortableBackupReplacements(this.portableReplacementJournalDirectory)
    for (const failure of recovery.failures) {
      this.onAutomaticBackupError(new Error(
        `Portable backup replacement recovery failed (${failure.journalPath}): ${failure.error}`,
      ))
    }
    await this.removeTemporaryFiles()
    await this.pruneKind('automatic', this.automaticRetention)
    await this.pruneKind('pre-restore', this.preRestoreRetention)
  }

  public async createBackup(kind: DatabaseBackupKind = 'manual'): Promise<DatabaseBackupInfo> {
    await this.ensureDirectory()
    const createdAt = this.now()
    const id = createBackupId(createdAt, kind, this.randomId())
    const targetPath = this.pathForId(id)
    const temporaryPath = join(this.backupDirectory, `.${id}.${this.randomId()}.tmp`)

    try {
      await this.store.backupTo(temporaryPath)
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
      const verification = await this.verifyPath(temporaryPath, id)
      if (!verification.valid) {
        throw new Error(`Backup verification failed: ${verification.issue ?? 'unknown integrity error'}`)
      }
      await rename(temporaryPath, targetPath)
      const info = { ...verification, id, kind, createdAt }
      if (kind === 'automatic') await this.pruneKind('automatic', this.automaticRetention, id)
      if (kind === 'pre-restore') await this.pruneKind('pre-restore', this.preRestoreRetention, id)
      return withoutIntegrityRows(info)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw new Error(`Unable to create ${kind} database backup: ${messageOf(error)}`)
    }
  }

  public async listBackups(): Promise<DatabaseBackupInfo[]> {
    await this.ensureDirectory()
    const entries = await readdir(this.backupDirectory, { withFileTypes: true })
    const backups = await Promise.all(entries
      .filter((entry) => entry.isFile() && parseBackupId(entry.name))
      .map(async (entry) => withoutIntegrityRows(await this.verifyPath(this.pathForId(entry.name), entry.name))))
    return backups.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  public async exportPortableBackup(destinationPath: string, password: string): Promise<{
    backup: DatabaseBackupInfo
    portable: PortableBackupInfo
  }> {
    const backup = await this.createBackup('manual')
    const stagingPath = join(this.backupDirectory, `.${backup.id}.${this.randomId()}.portable-export`)
    try {
      await preparePortableExportDatabase(
        this.pathForId(backup.id), stagingPath, password, this.portableSecretVault,
      )
      const portable = await encryptPortableBackup(
        stagingPath,
        destinationPath,
        password,
        this.now,
        2,
        this.portableReplacementJournalDirectory,
      )
      return { backup, portable }
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined)
    }
  }

  public async importPortableBackup(sourcePath: string, password: string): Promise<DatabaseBackupInfo> {
    await this.ensureDirectory()
    const createdAt = this.now()
    const id = createBackupId(createdAt, 'manual', this.randomId())
    const targetPath = this.pathForId(id)
    const temporaryPath = join(this.backupDirectory, `.${id}.${this.randomId()}.portable-import`)
    try {
      const portable = await decryptPortableBackup(sourcePath, temporaryPath, password)
      await preparePortableImportedDatabase(temporaryPath, password, portable.version, this.portableSecretVault)
      const verification = await this.verifyPath(temporaryPath, id)
      if (!verification.valid) {
        throw new Error(`Portable backup verification failed: ${verification.issue ?? 'unknown integrity error'}`)
      }
      await rename(temporaryPath, targetPath)
      return withoutIntegrityRows({ ...verification, id, kind: 'manual', createdAt })
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw new Error(`Unable to import portable backup: ${messageOf(error)}`)
    }
  }

  public async verifyBackup(id: string): Promise<DatabaseBackupVerification> {
    const path = await this.requireRegularBackup(id)
    return this.verifyPath(path, id)
  }

  public async deleteBackup(id: string): Promise<void> {
    const path = await this.requireRegularBackup(id)
    await rm(path)
  }

  public async restoreBackup(id: string): Promise<DatabaseRestoreResult<T>> {
    this.assertIdleForRestore()
    const resumeAutomaticBackups = this.automaticTimer !== undefined
    this.stopAutomaticBackups()
    const sourcePath = await this.requireRegularBackup(id)
    const sourceVerification = await this.verifyPath(sourcePath, id)
    if (!sourceVerification.valid) {
      throw new Error(`Cannot restore an invalid database backup: ${sourceVerification.issue ?? 'integrity check failed'}`)
    }

    const stagedPath = join(this.backupDirectory, `.${id}.${this.randomId()}.restore`)
    const safetyCreatedAt = this.now()
    const safetyId = createBackupId(safetyCreatedAt, 'pre-restore', this.randomId())
    const safetyPath = this.pathForId(safetyId)
    try {
      await copyFile(sourcePath, stagedPath)
      if (process.platform !== 'win32') await chmod(stagedPath, 0o600)
      const stagedVerification = await this.verifyPath(stagedPath, id)
      if (!stagedVerification.valid) {
        throw new Error(`Staged backup verification failed: ${stagedVerification.issue ?? 'integrity check failed'}`)
      }
      const state = await this.store.restoreFrom(stagedPath, safetyPath)
      const safetyVerification = await this.verifyPath(safetyPath, safetyId)
      if (!safetyVerification.valid) {
        throw new Error(`Pre-restore backup verification failed: ${safetyVerification.issue ?? 'integrity check failed'}`)
      }
      await this.pruneKind('pre-restore', this.preRestoreRetention, safetyId)
      return {
        restoredBackup: withoutIntegrityRows(sourceVerification),
        safetyBackup: withoutIntegrityRows(safetyVerification),
        state
      }
    } catch (error) {
      throw new Error(`Unable to restore database backup: ${messageOf(error)}`)
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined)
      if (resumeAutomaticBackups) this.startAutomaticBackups()
    }
  }

  public async runAutomaticBackupIfDue(): Promise<DatabaseBackupInfo | undefined> {
    if (this.automaticRun) return this.automaticRun
    const operation = this.performAutomaticBackupIfDue()
    this.automaticRun = operation
    try {
      return await operation
    } finally {
      this.automaticRun = undefined
    }
  }

  public startAutomaticBackups(): void {
    if (this.automaticTimer) return
    void this.runAutomaticBackupIfDue().catch((error: unknown) => this.onAutomaticBackupError(toError(error)))
    this.automaticTimer = setInterval(() => {
      void this.runAutomaticBackupIfDue().catch((error: unknown) => this.onAutomaticBackupError(toError(error)))
    }, this.automaticIntervalMs)
    this.automaticTimer.unref()
  }

  public stopAutomaticBackups(): void {
    if (this.automaticTimer) clearInterval(this.automaticTimer)
    this.automaticTimer = undefined
  }

  public async setAutomaticRetention(retention: number): Promise<void> {
    this.automaticRetention = positiveInteger(retention, 'Automatic backup retention')
    await this.pruneKind('automatic', this.automaticRetention)
  }

  public async close(): Promise<void> {
    this.stopAutomaticBackups()
    await this.automaticRun
  }

  private async performAutomaticBackupIfDue(): Promise<DatabaseBackupInfo | undefined> {
    const backups = await this.listBackups()
    const latest = backups.find((backup) => backup.kind === 'automatic' && backup.valid)
    if (latest && this.now() - latest.createdAt < this.automaticIntervalMs) return undefined
    return this.createBackup('automatic')
  }

  private assertIdleForRestore(): void {
    if (this.automaticRun) throw new Error('Wait for the active automatic database backup before restoring.')
  }

  private async pruneKind(kind: DatabaseBackupKind, retention: number, preserveId?: string): Promise<void> {
    const backups = (await this.listBackups()).filter((backup) => backup.kind === kind && backup.valid)
    const ordered = preserveId
      ? [...backups].sort((left, right) => left.id === preserveId ? -1 : right.id === preserveId ? 1 : 0)
      : backups
    await Promise.all(ordered.slice(retention).map((backup) => rm(this.pathForId(backup.id), { force: true })))
  }

  private async verifyPath(path: string, id: string): Promise<DatabaseBackupVerification> {
    const parsed = parseBackupId(id)
    const file = await stat(path)
    const fallback: DatabaseBackupVerification = {
      id,
      kind: parsed?.kind ?? 'manual',
      createdAt: parsed?.createdAt ?? file.mtimeMs,
      sizeBytes: file.size,
      valid: false,
      integrityCheck: []
    }
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(path, { readOnly: true })
      database.exec('PRAGMA trusted_schema = OFF')
      const integrityCheck = (database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
        .map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? 'unknown integrity error'))
      const schemaVersion = readPragmaNumber(database, 'user_version')
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>).map((row) => row.name))
      const requiredTables = [
        ...REQUIRED_SCHEMA_ONE_TABLES,
        ...(schemaVersion >= 3 ? ['client_profiles'] : []),
        ...(schemaVersion >= 4 ? ['health_events'] : []),
        ...(schemaVersion >= 5 ? ['proxies', 'account_codex_quota_samples'] : []),
        ...(schemaVersion >= 8 ? ['persistent_tasks'] : []),
        ...(schemaVersion >= 9 ? ['built_in_proxy_settings', 'proxy_profiles'] : [])
      ]
      const missingTables = requiredTables.filter((table) => !tables.has(table))
      const initialized = tables.has('app_metadata')
        ? database.prepare("SELECT value FROM app_metadata WHERE key = 'state_initialized'").get() as
          | { value?: unknown }
          | undefined
        : undefined
      const issues = [
        ...integrityCheck.filter((result) => result.toLowerCase() !== 'ok'),
        ...(schemaVersion < 1 ? ['Database schema version is missing'] : []),
        ...(schemaVersion > SQLITE_SCHEMA_VERSION
          ? [`Database schema ${schemaVersion} is newer than supported schema ${SQLITE_SCHEMA_VERSION}`]
          : []),
        ...(missingTables.length > 0 ? [`Missing Stone+ tables: ${missingTables.join(', ')}`] : []),
        ...(initialized?.value !== '1' ? ['Stone+ database initialization marker is missing'] : [])
      ]
      return {
        ...fallback,
        schemaVersion,
        valid: issues.length === 0,
        issue: issues[0],
        integrityCheck
      }
    } catch (error) {
      return { ...fallback, issue: messageOf(error) }
    } finally {
      database?.close()
    }
  }

  private async requireRegularBackup(id: string): Promise<string> {
    if (!parseBackupId(id) || basename(id) !== id) throw new Error('Invalid database backup identifier')
    const path = this.pathForId(id)
    try {
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Database backup is not a regular file')
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Database backup not found')
      throw error
    }
  }

  private pathForId(id: string): string {
    return join(this.backupDirectory, id)
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 })
    const entry = await lstat(this.backupDirectory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Database backup directory must be a local directory, not a symbolic link')
    }
    if (process.platform !== 'win32') await chmod(this.backupDirectory, 0o700)
  }

  private async removeTemporaryFiles(): Promise<void> {
    const entries = await readdir(this.backupDirectory, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('.stone-backup-'))
      .map((entry) => rm(join(this.backupDirectory, entry.name), { force: true })))
  }
}

function createBackupId(createdAt: number, kind: DatabaseBackupKind, randomId: string): string {
  const safeRandomId = randomId.toLowerCase().replace(/[^0-9a-f-]/g, '')
  if (safeRandomId.length < 8) throw new Error('Backup random identifier is too short')
  return `stone-backup-${createdAt}-${kind}-${safeRandomId}.sqlite3`
}

function parseBackupId(id: string): { createdAt: number; kind: DatabaseBackupKind } | undefined {
  const match = BACKUP_PATTERN.exec(id)
  if (!match) return undefined
  const createdAt = Number(match[1])
  if (!Number.isSafeInteger(createdAt)) return undefined
  return { createdAt, kind: match[2] as DatabaseBackupKind }
}

function readPragmaNumber(database: DatabaseSync, name: 'user_version'): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row?.[name]
  return typeof value === 'number' ? value : 0
}

function withoutIntegrityRows(verification: DatabaseBackupVerification): DatabaseBackupInfo {
  const { integrityCheck: _integrityCheck, ...info } = verification
  return info
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export const DATABASE_BACKUP_DIRECTORY_NAME = BACKUP_DIRECTORY_NAME
