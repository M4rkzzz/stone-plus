import type {
  ClientConfigEditorField,
  ClientConfigEditorFile,
  ClientConfigFieldPatch,
  ClientConfigFileDraft,
  ClientConfigFileFormat,
  ClientConfigFileRole as SharedClientConfigFileRole,
  RouteClient,
} from '@shared/types'

export type SupportedClient = RouteClient
export type ClientConfigFileRole = SharedClientConfigFileRole
export type ConfigFileFormat = ClientConfigFileFormat

export interface ClientConfigPathOverrides {
  claudeDirectory?: string
  codexDirectory?: string
  geminiDirectory?: string
}

export interface ClientConfigPathOptions {
  homeDir: string
  platform: NodeJS.Platform
  overrides?: ClientConfigPathOverrides
}

export interface ClientConfigFilePath {
  client: SupportedClient
  role: ClientConfigFileRole
  format: ConfigFileFormat
  path: string
  containsCredential: boolean
}

export interface ResolvedClientConfigPaths {
  claude: {
    directory: string
    settings: ClientConfigFilePath
    mcp?: ClientConfigFilePath
  }
  codex: {
    directory: string
    config: ClientConfigFilePath
    auth: ClientConfigFilePath
  }
  gemini: {
    directory: string
    settings: ClientConfigFilePath
    env: ClientConfigFilePath
  }
}

export interface ClientConnectionTarget {
  gatewayBaseUrl: string
  token: string
}

export type ExistingClientConfig = Partial<Record<ClientConfigFileRole, string>>

export interface PlannedFileMutation extends ClientConfigFilePath {
  content: string
  changed: boolean
  existed: boolean
  managedFields: string[]
}

export interface ClientConfigPlan {
  client: SupportedClient
  files: PlannedFileMutation[]
}

export interface DetectedConfigFile extends ClientConfigFilePath {
  exists: boolean
  size?: number
  modifiedAt?: number
}

export interface DetectedClientConfig {
  client: SupportedClient
  directory: string
  directoryExists: boolean
  configured: boolean
  files: DetectedConfigFile[]
}

export interface BackupRecord {
  client: SupportedClient
  role: ClientConfigFileRole
  targetPath: string
  backupPath: string
  /**
   * Whether the managed file existed when this snapshot was captured.
   * New snapshots use an explicit tombstone when it did not; legacy backup
   * files are interpreted as existing for backward compatibility.
   */
  existed: boolean
  /**
   * Stable identifier shared by every file captured by one backup operation.
   *
   * Older backups did not persist a manifest.  Their group id is derived from
   * the exact millisecond timestamp and collision suffix in the file name, so
   * we never merge backups merely because they are "close" in time.
   */
  groupId: string
  createdAt: number
  size: number
}

export interface ClientConfigBackupSet {
  client: SupportedClient
  groupId: string
  createdAt: number
  backups: BackupRecord[]
}

export interface CreateBackupSetResult extends ClientConfigBackupSet {
  removedBackups: string[]
  retentionWarning?: string
}

export interface ApplyClientConfigResult {
  client: SupportedClient
  changedFiles: string[]
  backups: BackupRecord[]
  removedBackups: string[]
  retentionWarning?: string
}

/**
 * Result of repairing the small set of fields Stone+ owns in a client config.
 *
 * `rebuiltRoles` is deliberately role-only: callers can explain which document
 * was syntactically unusable without ever receiving credential-bearing content.
 */
export interface RepairClientConfigResult extends ApplyClientConfigResult {
  rebuiltRoles: ClientConfigFileRole[]
}

export interface ClientConfigRepairPlan extends ClientConfigPlan {
  rebuiltRoles: ClientConfigFileRole[]
}

export interface ClientConfigApplyOptions {
  backupRetention?: number
}

export interface ClientConfigEditorSnapshot {
  client: SupportedClient
  fields: ClientConfigEditorField[]
  files: ClientConfigEditorFile[]
}

export interface ClientConfigEditorChanges {
  patches: ClientConfigFieldPatch[]
  files: ClientConfigFileDraft[]
}

export interface RestoreBackupResult {
  client: SupportedClient
  role: ClientConfigFileRole
  restoredFile: string
  sourceBackup: string
  safetyBackup?: BackupRecord
}

export interface RestoreBackupSetResult {
  client: SupportedClient
  groupId: string
  createdAt: number
  /** Paths populated from value snapshots. */
  restoredFiles: string[]
  /** Previously existing paths removed because the selected snapshot records that they did not exist. */
  deletedFiles: string[]
  sourceBackups: BackupRecord[]
  safetyBackupSet?: ClientConfigBackupSet
}

export interface ClientConfigServiceOptions extends ClientConfigPathOptions {
  now?: () => Date
  randomId?: () => string
}

export class ClientConfigParseError extends Error {
  readonly role: ClientConfigFileRole

  constructor(role: ClientConfigFileRole, detail: string) {
    super(`Cannot parse ${role}: ${detail}`)
    this.name = 'ClientConfigParseError'
    this.role = role
  }
}

export class ClientConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientConfigValidationError'
  }
}
