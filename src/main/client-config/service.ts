import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { allClientFiles, clientDirectory, clientFiles, resolveClientConfigPaths } from './paths'
import { planClientConfig, planClientConfigRepair } from './planners'
import { applyClientConfigFieldPatches, clientConfigEditorFields } from './catalog'
import { createClientConfigEditorFile, restoreClientConfigEditorContent, revisionOf } from './editor'
import { atomicWriteFile, copyExclusive, pathStat, readTextIfPresent } from './filesystem'
import type {
  ApplyClientConfigResult,
  BackupRecord,
  ClientConfigBackupSet,
  ClientConfigApplyOptions,
  ClientConfigEditorChanges,
  ClientConfigEditorSnapshot,
  ClientConfigFilePath,
  ClientConfigPlan,
  ClientConfigPathOverrides,
  ClientConfigServiceOptions,
  CreateBackupSetResult,
  ClientConnectionTarget,
  DetectedClientConfig,
  ExistingClientConfig,
  ResolvedClientConfigPaths,
  RepairClientConfigResult,
  RestoreBackupResult,
  RestoreBackupSetResult,
  SupportedClient,
} from './types'
import { ClientConfigValidationError } from './types'

const backupMarker = '.stone-backup.'
const timestampPattern = /^(\d{8}T\d{9}Z)(?:\.(\d+))?$/
const maximumBackupSequence = 999
// Profile-scoped services are short-lived wrappers around the same filesystem.
// Keep one process-wide queue so concurrent operations cannot interleave roles.
let backupQueue: Promise<void> = Promise.resolve()

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

function dateFromTimestamp(value: string): number | undefined {
  const match = timestampPattern.exec(value)
  if (!match) return undefined
  const timestamp = match[1]
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? undefined : parsed
}

function defaultRandomId() {
  return crypto.randomUUID().slice(0, 12)
}

function backupGroupId(createdAt: number, sequence: number): string {
  return `${createdAt}:${sequence}`
}

function validateBackupRetention(retention: number): void {
  if (!Number.isInteger(retention) || retention < 1 || retention > 100) {
    throw new ClientConfigValidationError('Backup retention must be between 1 and 100 per file')
  }
}

export class ClientConfigService {
  readonly paths: ResolvedClientConfigPaths
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly platform: NodeJS.Platform
  private readonly options: ClientConfigServiceOptions

  constructor(options: ClientConfigServiceOptions) {
    this.options = options
    this.paths = resolveClientConfigPaths(options)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? defaultRandomId
    this.platform = options.platform
  }

  withOverrides(overrides: ClientConfigPathOverrides): ClientConfigService {
    return new ClientConfigService({
      ...this.options,
      overrides: { ...this.options.overrides, ...overrides },
    })
  }

  async detect(client?: SupportedClient): Promise<DetectedClientConfig[]> {
    const clients: SupportedClient[] = client ? [client] : ['claude', 'codex', 'gemini']
    return Promise.all(clients.map(async (candidate) => {
      const directory = clientDirectory(this.paths, candidate)
      const directoryInfo = await pathStat(directory)
      const files = await Promise.all(clientFiles(this.paths, candidate).map(async (file) => {
        const info = await pathStat(file.path)
        return {
          ...file,
          exists: info?.isFile() ?? false,
          size: info?.isFile() ? info.size : undefined,
          modifiedAt: info?.isFile() ? info.mtimeMs : undefined,
        }
      }))
      return {
        client: candidate,
        directory,
        directoryExists: directoryInfo?.isDirectory() ?? false,
        configured: files.some((file) => file.exists),
        files,
      }
    }))
  }

  async plan(client: SupportedClient, target: ClientConnectionTarget) {
    const existing = await this.readExisting(client)
    return planClientConfig(client, this.paths, existing, target)
  }

  async editor(client: SupportedClient): Promise<ClientConfigEditorSnapshot> {
    const existing = await this.readExisting(client)
    return {
      client,
      fields: clientConfigEditorFields(client, existing),
      files: clientFiles(this.paths, client).map((file) => (
        createClientConfigEditorFile(file, existing[file.role])
      )),
    }
  }

  async applyEditor(
    client: SupportedClient,
    target: ClientConnectionTarget,
    changes: ClientConfigEditorChanges,
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    if (changes.files.length > 5) throw new ClientConfigValidationError('Too many client configuration files were submitted')
    const files = clientFiles(this.paths, client)
    const fileByRole = new Map(files.map((file) => [file.role, file]))
    const existing = await this.readExisting(client)
    const edited: ExistingClientConfig = { ...existing }
    const submitted = new Set<ClientConfigFilePath['role']>()
    for (const draft of changes.files) {
      if (submitted.has(draft.role)) throw new ClientConfigValidationError('A client configuration file was submitted more than once')
      submitted.add(draft.role)
      const file = fileByRole.get(draft.role)
      if (!file) throw new ClientConfigValidationError('A client configuration file does not belong to the selected client')
      const source = existing[file.role]
      if (draft.revision !== revisionOf(source)) {
        throw new ClientConfigValidationError('Client configuration changed outside StonePlus. Reload it before saving.')
      }
      edited[file.role] = restoreClientConfigEditorContent(file, draft.content, source)
    }
    const patched = applyClientConfigFieldPatches(client, edited, changes.patches)
    const connectionPlan = planClientConfig(client, this.paths, patched, target)
    const plannedRoles = new Set(connectionPlan.files.map((file) => file.role))
    const plan: ClientConfigPlan = {
      client,
      files: [
        ...connectionPlan.files.map((file) => ({
          ...file,
          changed: file.content !== existing[file.role],
          existed: existing[file.role] !== undefined,
        })),
        ...files.filter((file) => !plannedRoles.has(file.role) && patched[file.role] !== existing[file.role]).map((file) => ({
          ...file,
          content: patched[file.role] ?? '',
          changed: true,
          existed: existing[file.role] !== undefined,
          managedFields: ['complete document'],
        })),
      ],
    }
    return this.applyPlan(client, plan, options)
  }

  async apply(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    const plan = await this.plan(client, target)
    return this.applyPlan(client, plan, options)
  }

  /**
   * Repair only StonePlus's connection fields. Syntactically valid user settings
   * are preserved; an unusable managed document is backed up transactionally
   * and rebuilt from the minimal planner output.
   */
  async repair(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
  ): Promise<RepairClientConfigResult> {
    const existing = await this.readExisting(client)
    const plan = planClientConfigRepair(client, this.paths, existing, target)
    const applied = await this.applyPlan(client, plan, options)
    return {
      ...applied,
      rebuiltRoles: plan.rebuiltRoles,
    }
  }

  private async applyPlan(
    client: SupportedClient,
    plan: ClientConfigPlan,
    options: ClientConfigApplyOptions,
  ): Promise<ApplyClientConfigResult> {
    const changes = plan.files.filter((file) => file.changed)
    // Capture one timestamp and collision sequence for the complete operation.
    // This keeps config/auth and settings/env backups in an unambiguous set.
    const backups = await this.backupFiles(changes, this.now())

    const written: ClientConfigFilePath[] = []
    try {
      for (const change of changes) {
        await atomicWriteFile(change.path, change.content, this.randomId, change.containsCredential)
        written.push(change)
      }
    } catch (error) {
      await this.rollback(written, backups)
      throw error
    }

    let removedBackups: string[] = []
    let retentionWarning: string | undefined
    if (options.backupRetention !== undefined) {
      try {
        removedBackups = await this.pruneBackups(client, options.backupRetention)
      } catch {
        retentionWarning = 'Client configuration was applied, but old backups could not be pruned.'
      }
    }

    return {
      client,
      changedFiles: changes.map((file) => file.path),
      backups,
      removedBackups,
      ...(retentionWarning ? { retentionWarning } : {}),
    }
  }

  private async readExisting(client: SupportedClient): Promise<ExistingClientConfig> {
    const existing: ExistingClientConfig = {}
    await Promise.all(clientFiles(this.paths, client).map(async (file) => {
      const content = await readTextIfPresent(file.path)
      if (content !== undefined) existing[file.role] = content
    }))
    return existing
  }

  async pruneBackups(client: SupportedClient, retention: number): Promise<string[]> {
    validateBackupRetention(retention)
    const backups = await this.listBackups(client)
    const retainedByRole = new Map<ClientConfigFilePath['role'], number>()
    const removed: string[] = []
    for (const backup of backups) {
      const retained = retainedByRole.get(backup.role) ?? 0
      if (retained < retention) {
        retainedByRole.set(backup.role, retained + 1)
        continue
      }
      await rm(backup.backupPath)
      removed.push(backup.backupPath)
    }
    return removed
  }

  async listBackups(client?: SupportedClient): Promise<BackupRecord[]> {
    const eligibleFiles = client ? clientFiles(this.paths, client) : allClientFiles(this.paths)
    const records = (await Promise.all(eligibleFiles.map((file) => this.backupsForFile(file)))).flat()
    return records.sort((left, right) =>
      right.createdAt - left.createdAt
      || backupSequence(right.backupPath) - backupSequence(left.backupPath)
      || right.backupPath.localeCompare(left.backupPath))
  }

  /**
   * Back up every currently existing managed file for a client as one set.
   * Partial sets are removed when any copy fails.
   */
  async createBackupSet(
    client: SupportedClient,
    retention?: number,
  ): Promise<CreateBackupSetResult> {
    if (retention !== undefined) validateBackupRetention(retention)
    const backups = await this.backupFiles(clientFiles(this.paths, client), this.now())
    if (backups.length === 0) {
      throw new Error(`No existing ${client} configuration files are available to back up.`)
    }

    let removedBackups: string[] = []
    let retentionWarning: string | undefined
    if (retention !== undefined) {
      try {
        removedBackups = await this.pruneBackups(client, retention)
      } catch {
        retentionWarning = 'The backup set was created, but old backups could not be pruned.'
      }
    }

    const set = backupSetFromRecords(client, backups)
    return {
      ...set,
      removedBackups,
      ...(retentionWarning ? { retentionWarning } : {}),
    }
  }

  /** Restore the newest exact backup group for a client. */
  async restoreLatestBackupSet(client: SupportedClient): Promise<RestoreBackupSetResult> {
    const backups = await this.listBackups(client)
    const latest = backups[0]
    if (!latest) throw new Error(`No backups are available for ${client}.`)
    return this.restoreBackupSet(client, latest.groupId)
  }

  /**
   * Restore every file from one exact group. A numeric selector is accepted for
   * legacy callers only when that millisecond maps to exactly one group.
   */
  async restoreBackupSet(
    client: SupportedClient,
    groupIdOrCreatedAt: string | number,
  ): Promise<RestoreBackupSetResult> {
    const backups = await this.listBackups(client)
    if (backups.length === 0) throw new Error(`No backups are available for ${client}.`)

    let selectedGroupId: string
    if (typeof groupIdOrCreatedAt === 'number') {
      const groupIds = [...new Set(backups
        .filter((backup) => backup.createdAt === groupIdOrCreatedAt)
        .map((backup) => backup.groupId))]
      if (groupIds.length === 0) {
        throw new Error(`No ${client} backup set exists at ${groupIdOrCreatedAt}.`)
      }
      if (groupIds.length > 1) {
        throw new Error(`Multiple ${client} backup sets exist at ${groupIdOrCreatedAt}; use the exact group id.`)
      }
      selectedGroupId = groupIds[0]
    } else {
      selectedGroupId = groupIdOrCreatedAt
    }

    const sourceBackups = backups.filter((backup) => backup.groupId === selectedGroupId)
    if (sourceBackups.length === 0) {
      throw new Error(`Backup set ${selectedGroupId} is not managed for ${client}.`)
    }

    const eligibleFiles = clientFiles(this.paths, client)
    const sourceByRole = new Map<ClientConfigFilePath['role'], BackupRecord>()
    for (const backup of sourceBackups) {
      if (sourceByRole.has(backup.role)) {
        throw new Error(`Backup set ${selectedGroupId} contains duplicate ${backup.role} files.`)
      }
      sourceByRole.set(backup.role, backup)
    }
    const restoreFiles = eligibleFiles.filter((file) => sourceByRole.has(file.role))
    if (restoreFiles.length !== sourceBackups.length) {
      throw new Error(`Backup set ${selectedGroupId} contains an unsupported client configuration file.`)
    }

    // Read every source before touching current configuration. A missing or
    // unreadable source therefore cannot leave a half-restored client.
    const sourceContents = new Map<ClientConfigFilePath['role'], Buffer>()
    await Promise.all(restoreFiles.map(async (file) => {
      const source = sourceByRole.get(file.role)!
      sourceContents.set(file.role, await readFile(source.backupPath))
    }))

    // The safety snapshot includes all current files, not only files present in
    // the source set. This gives rollback one coherent pre-restore state.
    const safetyBackups = await this.backupFiles(eligibleFiles, this.now())
    const safetyBackupSet = safetyBackups.length > 0
      ? backupSetFromRecords(client, safetyBackups)
      : undefined

    const written: ClientConfigFilePath[] = []
    try {
      for (const file of restoreFiles) {
        await atomicWriteFile(file.path, sourceContents.get(file.role)!, this.randomId, file.containsCredential)
        written.push(file)
      }
    } catch (error) {
      await this.rollback(written, safetyBackups)
      throw error
    }

    const first = sourceBackups[0]
    return {
      client,
      groupId: selectedGroupId,
      createdAt: first.createdAt,
      restoredFiles: restoreFiles.map((file) => file.path),
      sourceBackups,
      ...(safetyBackupSet ? { safetyBackupSet } : {}),
    }
  }

  async restore(backupPath: string, client?: SupportedClient): Promise<RestoreBackupResult> {
    const normalized = this.normalizedPath(backupPath)
    const record = (await this.listBackups(client)).find((candidate) =>
      this.normalizedPath(candidate.backupPath) === normalized)
    if (!record) throw new Error('Backup is not managed by this client configuration service')

    const eligibleFiles = client ? clientFiles(this.paths, client) : allClientFiles(this.paths)
    const file = eligibleFiles.find((candidate) =>
      candidate.client === record.client && candidate.role === record.role)
    if (!file) throw new Error('Backup target is no longer configured')
    const safetyBackup = await this.backupFile(file)
    const content = await readFile(record.backupPath)
    await atomicWriteFile(record.targetPath, content, this.randomId, file.containsCredential)
    return {
      client: record.client,
      role: record.role,
      restoredFile: record.targetPath,
      sourceBackup: record.backupPath,
      safetyBackup,
    }
  }

  private normalizedPath(path: string): string {
    const normalized = resolve(path)
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  private async backupFile(file: ClientConfigFilePath): Promise<BackupRecord | undefined> {
    return (await this.backupFiles([file], this.now()))[0]
  }

  /**
   * Transactionally create one exact backup group. Every record receives the
   * same timestamp and collision suffix. If a collision races us, the files we
   * created for that candidate group are removed before retrying.
   */
  private async backupFiles(
    requestedFiles: ClientConfigFilePath[],
    operationDate: Date,
  ): Promise<BackupRecord[]> {
    const preceding = backupQueue
    let release!: () => void
    backupQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue
    })
    await preceding
    try {
      return await this.backupFilesUnlocked(requestedFiles, operationDate)
    } finally {
      release()
    }
  }

  private async backupFilesUnlocked(
    requestedFiles: ClientConfigFilePath[],
    operationDate: Date,
  ): Promise<BackupRecord[]> {
    const existingFiles = (await Promise.all(requestedFiles.map(async (file) => ({
      file,
      info: await pathStat(file.path),
    })))).filter((candidate) => candidate.info?.isFile())
    if (existingFiles.length === 0) return []

    const client = existingFiles[0].file.client
    if (existingFiles.some((candidate) => candidate.file.client !== client)) {
      throw new Error('A backup set cannot contain configuration files from multiple clients.')
    }

    const stamp = timestampForFile(operationDate)
    const createdAt = operationDate.getTime()
    const managedFiles = clientFiles(this.paths, client)
    for (let sequence = 0; sequence <= maximumBackupSequence; sequence += 1) {
      // Do not accidentally merge a single-file safety backup into another
      // role's group created during the same millisecond.
      const occupied = (await Promise.all(managedFiles.map((file) =>
        pathStat(backupPathFor(file, stamp, sequence))))).some(Boolean)
      if (occupied) continue

      const createdPaths: string[] = []
      const records: BackupRecord[] = []
      let collided = false
      try {
        for (const { file, info } of existingFiles) {
          const backupPath = backupPathFor(file, stamp, sequence)
          try {
            await copyExclusive(file.path, backupPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              collided = true
              break
            }
            throw error
          }
          createdPaths.push(backupPath)
          const backupInfo = await pathStat(backupPath)
          records.push({
            client: file.client,
            role: file.role,
            targetPath: file.path,
            backupPath,
            groupId: backupGroupId(createdAt, sequence),
            createdAt,
            size: backupInfo?.size ?? info!.size,
          })
        }
      } catch (error) {
        await Promise.all(createdPaths.map((path) => rm(path, { force: true }).catch(() => undefined)))
        throw error
      }

      if (collided) {
        await Promise.all(createdPaths.map((path) => rm(path, { force: true }).catch(() => undefined)))
        continue
      }
      return records
    }
    throw new Error(`Unable to create a unique backup set for ${client}.`)
  }

  private async backupsForFile(file: ClientConfigFilePath): Promise<BackupRecord[]> {
    let entries
    try {
      entries = await readdir(dirname(file.path), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const prefix = `${basename(file.path)}${backupMarker}`
    const records: BackupRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      const createdAt = dateFromTimestamp(entry.name.slice(prefix.length))
      if (createdAt === undefined) continue
      const backupPath = resolve(dirname(file.path), entry.name)
      const info = await pathStat(backupPath)
      if (!info) continue
      records.push({
        client: file.client,
        role: file.role,
        targetPath: file.path,
        backupPath,
        groupId: backupGroupId(createdAt, backupSequence(backupPath)),
        createdAt,
        size: info.size,
      })
    }
    return records
  }

  private async rollback(written: ClientConfigFilePath[], backups: BackupRecord[]): Promise<void> {
    for (const file of [...written].reverse()) {
      const backup = backups.find((candidate) => candidate.role === file.role)
      if (backup) {
        const content = await readFile(backup.backupPath)
        await atomicWriteFile(file.path, content, this.randomId, file.containsCredential).catch(() => undefined)
      } else {
        await rm(file.path, { force: true }).catch(() => undefined)
      }
    }
  }
}

function backupSequence(path: string): number {
  const match = /\.stone-backup\.\d{8}T\d{9}Z(?:\.(\d+))?$/.exec(path)
  return match?.[1] ? Number(match[1]) : 0
}

function backupPathFor(file: ClientConfigFilePath, stamp: string, sequence: number): string {
  return `${file.path}${backupMarker}${stamp}${sequence === 0 ? '' : `.${sequence}`}`
}

function backupSetFromRecords(
  client: SupportedClient,
  backups: BackupRecord[],
): ClientConfigBackupSet {
  const first = backups[0]
  if (!first || backups.some((backup) => (
    backup.client !== client
    || backup.groupId !== first.groupId
    || backup.createdAt !== first.createdAt
  ))) {
    throw new Error('Backup records do not form one coherent client backup set.')
  }
  return {
    client,
    groupId: first.groupId,
    createdAt: first.createdAt,
    backups,
  }
}
