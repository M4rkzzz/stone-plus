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

const CONFIG_METADATA_KEY = 'webdav_backup_configuration_v1'

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

export interface WebDavSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

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

  constructor(private readonly options: WebDavBackupServiceOptions) {
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
  }

  getConfiguration(): WebDavBackupConfiguration {
    const configuration = this.readPersisted()
    return publicConfiguration(configuration)
  }

  async saveConfiguration(input: WebDavBackupConfigurationInput): Promise<WebDavBackupConfiguration> {
    return await this.enqueueConfigurationWrite(() => this.saveConfigurationNow(input))
  }

  private async saveConfigurationNow(input: WebDavBackupConfigurationInput): Promise<WebDavBackupConfiguration> {
    const previous = this.readPersisted()
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

  private readPersisted(): PersistedWebDavConfiguration | undefined {
    const raw = this.options.metadata.readAppMetadata(CONFIG_METADATA_KEY)
    if (!raw) return undefined
    try {
      const value: unknown = JSON.parse(raw)
      if (!isPersistedConfiguration(value)) return undefined
      // Migrate legacy URLs which embedded Basic credentials before URL
      // validation rejected them. The public value is sanitized immediately;
      // persistence is best-effort and never exposes the embedded password.
      let legacyUrl: URL
      try { legacyUrl = new URL(value.baseUrl) } catch { return undefined }
      const embeddedUsername = decodeURIComponent(legacyUrl.username)
      const embeddedPassword = decodeURIComponent(legacyUrl.password)
      legacyUrl.username = ''
      legacyUrl.password = ''
      const baseUrl = normalizeWebDavUrl(legacyUrl.toString()).toString()
      const username = value.username || embeddedUsername
      let encryptedPassword = value.encryptedPassword
      const embeddedIdentityMatches = !value.username || !embeddedUsername || value.username === embeddedUsername
      if (!encryptedPassword && embeddedPassword && username && embeddedIdentityMatches
        && this.options.safeStorage.isEncryptionAvailable()) {
        encryptedPassword = this.encryptPassword(embeddedPassword)
      }
      const migrated = { version: 1 as const, baseUrl, username, ...(encryptedPassword ? { encryptedPassword } : {}) }
      if (baseUrl !== value.baseUrl || username !== value.username || encryptedPassword !== value.encryptedPassword) {
        const serialized = JSON.stringify(migrated)
        void this.enqueueConfigurationWrite(async () => {
          if (this.options.metadata.readAppMetadata(CONFIG_METADATA_KEY) === raw) {
            await this.options.metadata.writeAppMetadata(CONFIG_METADATA_KEY, serialized)
          }
        }).catch(() => undefined)
      }
      return migrated
    } catch {
      return undefined
    }
  }

  private encryptPassword(password: string): string {
    if (!this.options.safeStorage.isEncryptionAvailable()) {
      throw new Error('System credential encryption is unavailable; the WebDAV password was not saved')
    }
    return this.options.safeStorage.encryptString(password).toString('base64')
  }

  private decryptPassword(encrypted: string): string {
    if (!this.options.safeStorage.isEncryptionAvailable()) {
      throw new Error('System credential encryption is unavailable; enter the WebDAV password again')
    }
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
