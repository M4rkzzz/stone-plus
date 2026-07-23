export type DatabaseBackupKind = 'manual' | 'automatic' | 'pre-restore'

export interface DatabaseBackupInfo {
  id: string
  kind: DatabaseBackupKind
  createdAt: number
  sizeBytes: number
  schemaVersion?: number
  valid: boolean
  issue?: string
}

export interface DatabaseBackupVerification extends DatabaseBackupInfo {
  integrityCheck: string[]
}

export interface DatabaseRestoreResult<T> {
  restoredBackup: DatabaseBackupInfo
  safetyBackup: DatabaseBackupInfo
  state: T
}

export interface DatabaseBackupStore<T> {
  backupTo(destinationPath: string): Promise<number>
  restoreFrom(stagedDatabasePath: string, rollbackDatabasePath: string): Promise<T>
}

export interface DatabaseBackupServiceOptions<T> {
  userDataPath: string
  store: DatabaseBackupStore<T>
  automaticIntervalMs?: number
  automaticRetention?: number
  preRestoreRetention?: number
  now?: () => number
  randomId?: () => string
  onAutomaticBackupError?: (error: Error) => void
  portableSecretVault?: import('./portable-secrets').PortableSecretVault
  /** Durable safety barrier invoked before every copy of the live SQLite file. */
  beforeRawBackup?: () => void | Promise<void>
  /** Runs after restore commit and before any raw backup may resume. */
  onRestoreCommitted?: (state: T) => void | Promise<void>
}
