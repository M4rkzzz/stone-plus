import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BackupRecordSummary,
  WebDavBackupConfiguration,
  WebDavBackupConfigurationInput,
  WebDavBackupEntry,
  WebDavBackupImportResult,
  WebDavBackupUploadResult,
} from '../../shared/types'
import type { DatabaseBackupInfo } from './types'
import { normalizeWebDavUrl, WebDavBackupClient } from './webdav-backup-client'
import {
  isSecureCredentialVaultAvailable,
  requireSecureCredentialVault,
  type CredentialVaultLike,
} from './credential-vault'

const CONFIG_METADATA_KEY = 'webdav_backup_configuration_v1'
const LEGACY_CLEANUP_ERROR_MESSAGE =
  'Legacy WebDAV credentials could not be removed safely; save or clear the WebDAV configuration before creating database backups'

interface PersistedWebDavConfiguration {
  version: 1
  baseUrl: string
  username: string
  encryptedPassword?: string
}

export interface WebDavMetadataStore {
  readAppMetadata(key: string): string | undefined
  writeAppMetadata(key: string, value: string): Promise<void>
  removeAppMetadata(key: string): Promise<void>
}

export type WebDavSafeStorage = CredentialVaultLike

export interface WebDavPortableBackupStore {
  exportPortableBackup(destinationPath: string, password: string): Promise<{ backup: DatabaseBackupInfo }>
  importPortableBackup(sourcePath: string, password: string): Promise<DatabaseBackupInfo>
}

export interface WebDavBackupServiceOptions {
  metadata: WebDavMetadataStore
  safeStorage: WebDavSafeStorage
  backups: WebDavPortableBackupStore
  backupDirectory: string
  temporaryDirectory: string
  fetchImplementation?: typeof fetch
  now?: () => number
  randomId?: () => string
}

/** Coordinates encrypted portable backups with optional WebDAV storage. */
export class WebDavBackupService {
  private readonly now: () => number
  private readonly randomId: () => string
  private configurationWrites: Promise<unknown> = Promise.resolve()
  private pendingLegacyMigrationRaw: string | undefined
  private pendingLegacyMigration: Promise<void> | undefined
  private legacyMigrationFailure: Error | undefined

  constructor(private readonly options: WebDavBackupServiceOptions) {
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
  }

  getConfiguration(): WebDavBackupConfiguration {
    const configuration = this.readPersisted()
    return publicConfiguration(configuration)
  }

  /** Durable, retryable barrier shared by every raw SQLite backup path. */
  async prepareForRawBackup(): Promise<void> {
    // Reads keep surfacing the last failure, while an explicit backup/start
    // request is the retry boundary. Re-read the durable value and enqueue the
    // cleanup again rather than permanently wedging automatic backups.
    if (this.legacyMigrationFailure) {
      this.legacyMigrationFailure = undefined
      this.pendingLegacyMigrationRaw = undefined
      this.pendingLegacyMigration = undefined
    }
    this.readPersisted()
    const migration = this.pendingLegacyMigration
    if (migration) {
      try {
        await migration
      } catch {
        if (this.pendingLegacyMigration === migration) {
          this.pendingLegacyMigration = undefined
          this.pendingLegacyMigrationRaw = undefined
        }
        this.legacyMigrationFailure = new Error(LEGACY_CLEANUP_ERROR_MESSAGE)
        throw new Error(LEGACY_CLEANUP_ERROR_MESSAGE)
      }
    }
    await this.configurationWrites
    if (this.legacyMigrationFailure) throw this.legacyMigrationFailure
  }

  async prepareForStartup(): Promise<void> {
    await this.prepareForRawBackup()
  }

  async saveConfiguration(input: WebDavBackupConfigurationInput): Promise<WebDavBackupConfiguration> {
    return await this.enqueueConfigurationWrite(() => this.saveConfigurationNow(input))
  }

  private async saveConfigurationNow(input: WebDavBackupConfigurationInput): Promise<WebDavBackupConfiguration> {
    // A user-provided replacement must remain available after a background
    // legacy cleanup failed; this write supersedes the unsafe old value.
    this.legacyMigrationFailure = undefined
    const previous = this.readPersisted(false)
    const baseUrl = normalizeWebDavUrl(input.baseUrl).toString()
    const username = input.username?.trim() ?? ''
    const suppliedPassword = input.password ?? ''
    const passwordAction = input.passwordAction
      ?? (input.clearPassword ? 'clear' : suppliedPassword ? 'replace' : 'keep')
    const identityUnchanged = previous?.baseUrl === baseUrl && previous.username === username
    if (passwordAction === 'keep' && previous?.encryptedPassword && !identityUnchanged) {
      throw new Error('Enter the WebDAV password again after changing the server or username')
    }
    let encryptedPassword = passwordAction === 'keep' && identityUnchanged && username
      ? previous?.encryptedPassword
      : undefined
    if (passwordAction === 'replace') {
      if (!suppliedPassword) throw new Error('A WebDAV password is required')
      if (!username) throw new Error('A WebDAV username is required when a password is provided')
      encryptedPassword = this.encryptPassword(suppliedPassword)
    }
    if (username && !encryptedPassword) throw new Error('A WebDAV password is required')
    const persisted: PersistedWebDavConfiguration = {
      version: 1,
      baseUrl,
      username,
      ...(encryptedPassword ? { encryptedPassword } : {}),
    }
    await this.options.metadata.writeAppMetadata(CONFIG_METADATA_KEY, JSON.stringify(persisted))
    return publicConfiguration(persisted)
  }

  async clearConfiguration(): Promise<WebDavBackupConfiguration> {
    return await this.enqueueConfigurationWrite(async () => {
      this.legacyMigrationFailure = undefined
      await this.options.metadata.removeAppMetadata(CONFIG_METADATA_KEY)
      return emptyConfiguration()
    })
  }

  async test(signal?: AbortSignal): Promise<void> {
    await this.client().test(signal)
  }

  async list(signal?: AbortSignal): Promise<WebDavBackupEntry[]> {
    return this.client().list(signal)
  }

  async uploadLatest(password: string, signal?: AbortSignal): Promise<WebDavBackupUploadResult> {
    await this.ensureTemporaryDirectory()
    const name = `StonePlus-state-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${safeId(this.randomId())}.stonebackup`
    const temporaryPath = join(this.options.temporaryDirectory, `.${name}.uploading`)
    try {
      const exported = await this.options.backups.exportPortableBackup(temporaryPath, password)
      await this.client().upload(temporaryPath, name, signal)
      const file = await stat(temporaryPath)
      return {
        entry: { name, size: Number(file.size), modifiedAt: this.now() },
        localBackup: toBackupSummary(exported.backup, this.options.backupDirectory),
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async downloadAndImport(name: string, password: string, signal?: AbortSignal): Promise<WebDavBackupImportResult> {
    await this.ensureTemporaryDirectory()
    const temporaryPath = join(this.options.temporaryDirectory, `.${safeId(this.randomId())}.stonebackup`)
    try {
      await this.client().download(name, temporaryPath, signal)
      const file = await stat(temporaryPath)
      const backup = await this.options.backups.importPortableBackup(temporaryPath, password)
      return {
        entry: { name, size: Number(file.size) },
        localBackup: toBackupSummary(backup, this.options.backupDirectory),
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private client(): WebDavBackupClient {
    const configuration = this.readPersisted()
    if (!configuration) throw new Error('Configure WebDAV backup storage first')
    const password = configuration.encryptedPassword
      ? this.decryptPassword(configuration.encryptedPassword)
      : undefined
    return new WebDavBackupClient({
      baseUrl: configuration.baseUrl,
      username: configuration.username || undefined,
      password,
      fetchImplementation: this.options.fetchImplementation,
    })
  }

  private readPersisted(scheduleMigration = true): PersistedWebDavConfiguration | undefined {
    if (this.legacyMigrationFailure) {
      throw this.legacyMigrationFailure
    }
    const raw = this.options.metadata.readAppMetadata(CONFIG_METADATA_KEY)
    if (!raw) return undefined
    try {
      const value: unknown = JSON.parse(raw)
      if (!isPersistedConfiguration(value)) return undefined
      // Migrate legacy URLs which embedded Basic credentials before URL
      // validation rejected them. The public value is sanitized immediately;
      // asynchronous cleanup failures are surfaced on every later read.
      let legacyUrl: URL
      try {
        legacyUrl = new URL(value.baseUrl)
      } catch {
        if (scheduleMigration && value.baseUrl.includes('@')) this.scheduleLegacyRemoval(raw)
        return undefined
      }
      const hadUserInfo = Boolean(legacyUrl.username || legacyUrl.password)
      const embeddedUsername = decodeLegacyUrlCredential(legacyUrl.username)
      const embeddedPassword = decodeLegacyUrlCredential(legacyUrl.password)
      legacyUrl.username = ''
      legacyUrl.password = ''
      const username = value.username || embeddedUsername.value
      let encryptedPassword = value.encryptedPassword
      const embeddedIdentityMatches = !value.username
        || !embeddedUsername.value
        || value.username === embeddedUsername.value
      if (!encryptedPassword && embeddedPassword.valid && embeddedPassword.value && username && embeddedIdentityMatches
        && isSecureCredentialVaultAvailable(this.options.safeStorage)) {
        try {
          encryptedPassword = this.encryptPassword(embeddedPassword.value)
        } catch {
          // Sanitizing the URL has priority over retaining unusable embedded
          // plaintext. The public state will require the password again.
          encryptedPassword = undefined
        }
      }
      let baseUrl: string
      try {
        baseUrl = normalizeWebDavUrl(legacyUrl.toString()).toString()
      } catch {
        if (hadUserInfo && scheduleMigration) {
          this.scheduleLegacyMigration(raw, JSON.stringify({
            version: 1,
            baseUrl: legacyUrl.toString(),
            username,
            ...(encryptedPassword ? { encryptedPassword } : {}),
          }))
        }
        return undefined
      }
      const migrated = { version: 1 as const, baseUrl, username, ...(encryptedPassword ? { encryptedPassword } : {}) }
      if (hadUserInfo || baseUrl !== value.baseUrl || username !== value.username
        || encryptedPassword !== value.encryptedPassword) {
        const serialized = JSON.stringify(migrated)
        if (scheduleMigration) this.scheduleLegacyMigration(raw, serialized)
      }
      return migrated
    } catch {
      return undefined
    }
  }

  private scheduleLegacyMigration(raw: string, sanitized: string): void {
    this.scheduleLegacyCleanup(raw, async () => {
      if (this.options.metadata.readAppMetadata(CONFIG_METADATA_KEY) === raw) {
        await this.options.metadata.writeAppMetadata(CONFIG_METADATA_KEY, sanitized)
      }
    })
  }

  private scheduleLegacyRemoval(raw: string): void {
    this.scheduleLegacyCleanup(raw, async () => {
      if (this.options.metadata.readAppMetadata(CONFIG_METADATA_KEY) === raw) {
        await this.options.metadata.removeAppMetadata(CONFIG_METADATA_KEY)
      }
    })
  }

  private scheduleLegacyCleanup(raw: string, operation: () => Promise<void>): void {
    if (this.pendingLegacyMigrationRaw === raw) return
    this.pendingLegacyMigrationRaw = raw
    const migration = this.enqueueConfigurationWrite(operation)
    this.pendingLegacyMigration = migration
    void migration.then(
      () => undefined,
      () => {
        this.legacyMigrationFailure = new Error(
          LEGACY_CLEANUP_ERROR_MESSAGE,
        )
        console.error('Stone+ could not persist sanitized legacy WebDAV credentials')
      },
    ).finally(() => {
      if (this.pendingLegacyMigration === migration) {
        this.pendingLegacyMigrationRaw = undefined
        this.pendingLegacyMigration = undefined
      }
    })
  }

  private encryptPassword(password: string): string {
    requireSecureCredentialVault(this.options.safeStorage,
      'System credential encryption is unavailable; the WebDAV password was not saved')
    return this.options.safeStorage.encryptString(password).toString('base64')
  }

  private decryptPassword(encrypted: string): string {
    requireSecureCredentialVault(this.options.safeStorage,
      'System credential encryption is unavailable; enter the WebDAV password again')
    try {
      return this.options.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      throw new Error('The saved WebDAV password cannot be decrypted; enter it again')
    }
  }

  private ensureTemporaryDirectory(): Promise<void> {
    return mkdir(this.options.temporaryDirectory, { recursive: true }).then(() => undefined)
  }

  private enqueueConfigurationWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.configurationWrites.then(operation, operation)
    this.configurationWrites = pending.then(() => undefined, () => undefined)
    return pending
  }
}

function decodeLegacyUrlCredential(value: string): { value: string; valid: boolean } {
  try {
    return { value: decodeURIComponent(value), valid: true }
  } catch {
    // Preserve a malformed username only as a visible identity hint. A
    // malformed password is never encrypted or retained in sanitized metadata.
    return { value, valid: false }
  }
}

function publicConfiguration(value: PersistedWebDavConfiguration | undefined): WebDavBackupConfiguration {
  if (!value) return emptyConfiguration()
  return {
    baseUrl: value.baseUrl,
    username: value.username,
    hasPassword: Boolean(value.encryptedPassword),
    ...(Boolean(value.username) && !value.encryptedPassword ? { requiresPassword: true } : {}),
    configured: Boolean(value.baseUrl) && (!value.username || Boolean(value.encryptedPassword)),
  }
}

function emptyConfiguration(): WebDavBackupConfiguration {
  return { baseUrl: '', username: '', hasPassword: false, configured: false }
}

function isPersistedConfiguration(value: unknown): value is PersistedWebDavConfiguration {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedWebDavConfiguration>
  return candidate.version === 1
    && typeof candidate.baseUrl === 'string'
    && typeof candidate.username === 'string'
    && (candidate.encryptedPassword === undefined || typeof candidate.encryptedPassword === 'string')
}

function toBackupSummary(backup: DatabaseBackupInfo, directory: string): BackupRecordSummary {
  return {
    path: join(directory, backup.id),
    createdAt: backup.createdAt,
    size: backup.sizeBytes,
    automatic: backup.kind === 'automatic',
    integrity: backup.valid ? 'valid' : 'invalid',
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || randomUUID().replaceAll('-', '')
}

export const WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY = CONFIG_METADATA_KEY
