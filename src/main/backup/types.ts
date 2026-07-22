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
}
