import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RECOVERY_RECORD_VERSION = 1
const MAX_RECOVERY_RECORD_BYTES = 2 * 1024 * 1024

export type ProxySnapshotJson =
  | null
  | boolean
  | number
  | string
  | ProxySnapshotJson[]
  | { [key: string]: ProxySnapshotJson }

export interface SystemProxySnapshot {
  /** Identifies the adapter that can interpret the platform-native settings. */
  platform: string
  /**
   * A complete, JSON-safe platform snapshot. Implementations must retain the
   * manual proxy value, the full PAC URL, auto-detection flags, bypass rules,
   * and any other native values needed for a lossless restore.
   */
  settings: { [key: string]: ProxySnapshotJson }
}

export interface SystemProxyLeaseRecoveryRecord {
  version: typeof RECOVERY_RECORD_VERSION
  leaseId: string
  createdAt: number
  mixedProxyUrl: string
  original: SystemProxySnapshot
  applied: SystemProxySnapshot
}

export interface SystemProxyLeaseRecoveryStore {
  load(): Promise<SystemProxyLeaseRecoveryRecord | undefined>
  save(record: SystemProxyLeaseRecoveryRecord): Promise<void>
  clear(): Promise<void>
}

export type LeaseRecoveryErrorCode =
  | 'record_invalid'
  | 'record_too_large'
  | 'record_already_exists'

export class LeaseRecoveryError extends Error {
  public readonly code: LeaseRecoveryErrorCode

  public constructor(code: LeaseRecoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LeaseRecoveryError'
    this.code = code
  }
}

export interface FileLeaseRecoveryStoreOptions {
  randomId?: () => string
}

/**
 * Stores the system-proxy lease journal outside the database so it is
 * available before normal application startup. The record is written before
 * the operating-system proxy is changed and removed only after a successful
 * compare-and-restore (or after detecting a user's newer settings).
 */
export class FileSystemProxyLeaseRecoveryStore implements SystemProxyLeaseRecoveryStore {
  private readonly randomId: () => string

  public constructor(
    public readonly path: string,
    options: FileLeaseRecoveryStoreOptions = {}
  ) {
    if (!path.trim()) throw new Error('A system-proxy recovery record path is required.')
    this.randomId = options.randomId ?? randomUUID
  }

  public async load(): Promise<SystemProxyLeaseRecoveryRecord | undefined> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.path)
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
    if (bytes.byteLength > MAX_RECOVERY_RECORD_BYTES) {
      throw new LeaseRecoveryError(
        'record_too_large',
        'The system-proxy recovery record is unexpectedly large.'
      )
    }
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      throw new LeaseRecoveryError(
        'record_invalid',
        'The system-proxy recovery record is not valid JSON.',
        { cause: error }
      )
    }
    return parseSystemProxyLeaseRecoveryRecord(value)
  }

  public async save(record: SystemProxyLeaseRecoveryRecord): Promise<void> {
    const validated = parseSystemProxyLeaseRecoveryRecord(record)
    if (await pathExists(this.path)) {
      throw new LeaseRecoveryError(
        'record_already_exists',
        'A system-proxy recovery record already exists and must be recovered first.'
      )
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${this.randomId()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      // rename is atomic on the supported local filesystems. A single main
      // process serializes lease operations, so an existing target is always a
      // stale journal rather than a legitimate concurrent writer.
      await rename(temporaryPath, this.path)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  public async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

export function parseSystemProxyLeaseRecoveryRecord(
  value: unknown
): SystemProxyLeaseRecoveryRecord {
  const record = objectValue(value)
  if (
    !record
    || record.version !== RECOVERY_RECORD_VERSION
    || !nonEmptyString(record.leaseId)
    || !Number.isFinite(record.createdAt)
    || (record.createdAt as number) < 0
    || !nonEmptyString(record.mixedProxyUrl)
  ) {
    throw invalidRecoveryRecord()
  }
  const original = parseSystemProxySnapshot(record.original)
  const applied = parseSystemProxySnapshot(record.applied)
  return {
    version: RECOVERY_RECORD_VERSION,
    leaseId: record.leaseId,
    createdAt: record.createdAt as number,
    mixedProxyUrl: record.mixedProxyUrl,
    original,
    applied
  }
}

export function parseSystemProxySnapshot(value: unknown): SystemProxySnapshot {
  const snapshot = objectValue(value)
  if (!snapshot || !nonEmptyString(snapshot.platform)) throw invalidRecoveryRecord()
  const settings = objectValue(snapshot.settings)
  if (!settings || !isJsonValue(settings)) throw invalidRecoveryRecord()
  return {
    platform: snapshot.platform,
    settings: settings as { [key: string]: ProxySnapshotJson }
  }
}

function isJsonValue(value: unknown, depth = 0): value is ProxySnapshotJson {
  if (depth > 64) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  const object = objectValue(value)
  return object !== undefined && Object.values(object).every((item) => isJsonValue(item, depth + 1))
}

function invalidRecoveryRecord(): LeaseRecoveryError {
  return new LeaseRecoveryError(
    'record_invalid',
    'The system-proxy recovery record has an invalid or unsupported shape.'
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
