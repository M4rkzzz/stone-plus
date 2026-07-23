import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { allClientFiles, clientDirectory, clientFiles, resolveClientConfigPaths } from './paths'
import { planClientConfig, planClientConfigRepair, planCodexOfficialLoginConfig } from './planners'
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
  ClientConfigFileRole,
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
const missingBackupMarker = '.missing'
const backupManifestMarker = '.stone-backup-set.'
const backupManifestSuffix = '.manifest.json'
const timestampPattern = /^(\d{8}T\d{9}Z)(?:\.(\d+))?$/
const maximumBackupSequence = 999

interface BackupSetManifestMember {
  role: ClientConfigFileRole
  existed: boolean
  backupName: string
}

interface BackupSetManifestV1 {
  version: 1
  client: SupportedClient
  groupId: string
  createdAt: number
  members: BackupSetManifestMember[]
}
// Profile-scoped services are short-lived wrappers around the same filesystem.
// Keep one process-wide mutation queue so read/plan/backup/write/rollback cannot
// interleave across wrappers that address the same client files.
let configMutationQueue: Promise<void> = Promise.resolve()

async function runConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const preceding = configMutationQueue
  let release!: () => void
  configMutationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue })
  await preceding
  try { return await operation() } finally { release() }
}

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
    throw new ClientConfigValidationError('Backup retention must be between 1 and 100 backup groups')
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
    return runConfigMutation(() => this.applyEditorUnlocked(client, target, changes, options))
  }

  private async applyEditorUnlocked(
    client: SupportedClient,
    target: ClientConnectionTarget,
    changes: ClientConfigEditorChanges,
    options: ClientConfigApplyOptions,
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
      if (draft.revision !== revisionOf(file, source)) {
        throw new ClientConfigValidationError('Client configuration changed outside Stone+. Reload it before saving.')
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
    return this.applyPlan(client, plan, options, existing)
  }

  async apply(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    return runConfigMutation(async () => {
      const existing = await this.readExisting(client)
      const plan = planClientConfig(client, this.paths, existing, target)
      return this.applyPlan(client, plan, options, existing)
    })
  }

  /**
   * Repair only Stone+'s connection fields. Syntactically valid user settings
   * are preserved; an unusable managed document is backed up transactionally
   * and rebuilt from the minimal planner output.
   */
  async repair(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
  ): Promise<RepairClientConfigResult> {
    return runConfigMutation(async () => {
      const existing = await this.readExisting(client)
      const plan = planClientConfigRepair(client, this.paths, existing, target)
      const applied = await this.applyPlan(client, plan, options, existing)
      return {
        ...applied,
        rebuiltRoles: plan.rebuiltRoles,
      }
    })
  }

  /**
   * Transactionally remove Stone+'s Codex connection/authentication overrides.
   * Existing official ChatGPT credentials and unrelated settings are retained.
   */
  async restoreCodexOfficialLogin(
    options: ClientConfigApplyOptions = {},
  ): Promise<ApplyClientConfigResult> {
    return runConfigMutation(async () => {
      const existing = await this.readExisting('codex')
      const plan = planCodexOfficialLoginConfig(this.paths.codex, existing)
      return this.applyPlan('codex', plan, options, existing)
    })
  }

  private async applyPlan(
    client: SupportedClient,
    plan: ClientConfigPlan,
    options: ClientConfigApplyOptions,
    expected: ExistingClientConfig,
  ): Promise<ApplyClientConfigResult> {
    const changes = plan.files.filter((file) => file.changed)
    await this.assertExpectedFiles(changes, expected)
    // Capture one timestamp and collision sequence for the complete operation.
    // This keeps config/auth and settings/env backups in an unambiguous set.
    // Capture explicit missing-file tombstones, including a first-run apply
    // where every managed file is new. An exact restore can then recover the
    // pre-apply state instead of leaving newly-created credentials behind.
    const backups = await this.backupFiles(changes, this.now(), true)

    const written: ClientConfigFilePath[] = []
    try {
      for (const change of changes) {
        await this.assertMatchesBackup(change, backups.find((backup) => backup.role === change.role))
        await atomicWriteFile(change.path, change.content, this.randomId, change.containsCredential)
        written.push(change)
      }
    } catch (error) {
      const rollbackFailures = await this.rollback(written, backups, plan)
      if (rollbackFailures.length) {
        throw new Error(`${messageOf(error)}; rollback was incomplete for: ${rollbackFailures.join(', ')}`)
      }
      throw error
    }

    let removedBackups: string[] = []
    let retentionWarning: string | undefined
    if (options.backupRetention !== undefined) {
      try {
        removedBackups = await this.pruneBackupsUnlocked(client, options.backupRetention)
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
    return runConfigMutation(() => this.pruneBackupsUnlocked(client, retention))
  }

  private async pruneBackupsUnlocked(client: SupportedClient, retention: number): Promise<string[]> {
    validateBackupRetention(retention)
    const backups = await this.listBackups(client)
    const groups = new Map<string, BackupRecord[]>()
    for (const backup of backups) {
      const group = groups.get(backup.groupId)
      if (group) group.push(backup)
      else groups.set(backup.groupId, [backup])
    }

    const removed: string[] = []
    for (const [groupId, group] of [...groups].slice(retention)) {
      // Invalidate a manifested set before unlinking any member. If the process
      // stops halfway through pruning, a remaining tombstone cannot masquerade
      // as a complete destructive snapshot.
      const manifestPath = backupManifestPathForGroup(this.paths, client, groupId)
      if (manifestPath) await rm(manifestPath, { force: true })

      // Remove value snapshots before tombstones. Any interrupted group that
      // still has a deletion marker is therefore incomplete and restore rejects
      // it; a value-only legacy remainder is non-destructive.
      const deletionOrder = [...group].sort((left, right) => Number(right.existed) - Number(left.existed))
      for (const backup of deletionOrder) {
        await rm(backup.backupPath)
        removed.push(backup.backupPath)
      }
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
   * Back up the complete managed-file state for a client as one set. Missing
   * roles become tombstones once at least one client file exists. Partial sets
   * and their manifest are removed when any capture fails.
   */
  async createBackupSet(
    client: SupportedClient,
    retention?: number,
  ): Promise<CreateBackupSetResult> {
    return runConfigMutation(() => this.createBackupSetUnlocked(client, retention))
  }

  private async createBackupSetUnlocked(
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
        removedBackups = await this.pruneBackupsUnlocked(client, retention)
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
    return runConfigMutation(() => this.restoreLatestBackupSetUnlocked(client))
  }

  private async restoreLatestBackupSetUnlocked(client: SupportedClient): Promise<RestoreBackupSetResult> {
    const backups = await this.listBackups(client)
    const latest = backups[0]
    if (!latest) throw new Error(`No backups are available for ${client}.`)
    return this.restoreBackupSetUnlocked(client, latest.groupId)
  }

  /**
   * Restore every file from one exact group. A numeric selector is accepted for
   * legacy callers only when that millisecond maps to exactly one group.
   */
  async restoreBackupSet(
    client: SupportedClient,
    groupIdOrCreatedAt: string | number,
  ): Promise<RestoreBackupSetResult> {
    return runConfigMutation(() => this.restoreBackupSetUnlocked(client, groupIdOrCreatedAt))
  }

  private async restoreBackupSetUnlocked(
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
    await this.assertRestorableBackupGroup(client, selectedGroupId, sourceBackups, eligibleFiles)

    // Read every source before touching current configuration. A missing or
    // unreadable source therefore cannot leave a half-restored client.
    const sourceContents = new Map<ClientConfigFilePath['role'], Buffer>()
    await Promise.all(restoreFiles.map(async (file) => {
      const source = sourceByRole.get(file.role)!
      if (source.existed) sourceContents.set(file.role, await readFile(source.backupPath))
    }))

    // The safety snapshot includes all current files, not only files present in
    // the source set. This gives rollback one coherent pre-restore state.
    const safetyBackups = await this.backupFiles(eligibleFiles, this.now(), true)
    const safetyBackupSet = safetyBackups.length > 0
      ? backupSetFromRecords(client, safetyBackups)
      : undefined

    const written: ClientConfigFilePath[] = []
    try {
      for (const file of restoreFiles) {
        const source = sourceByRole.get(file.role)!
        await this.assertMatchesBackup(file, safetyBackups.find((backup) => backup.role === file.role))
        if (source.existed) {
          await atomicWriteFile(file.path, sourceContents.get(file.role)!, this.randomId, file.containsCredential)
        } else {
          await rm(file.path, { force: true })
        }
        written.push(file)
      }
    } catch (error) {
      const expectedPlan: ClientConfigPlan = {
        client,
        files: restoreFiles.map((file) => ({
          ...file,
          content: sourceContents.get(file.role)?.toString('utf8') ?? '',
          changed: true,
          existed: Boolean(safetyBackups.find((backup) => backup.role === file.role)),
          managedFields: ['complete document'],
        })),
      }
      const rollbackFailures = await this.rollback(
        written,
        safetyBackups,
        expectedPlan,
        new Map(restoreFiles.map((file) => [file.role, sourceContents.get(file.role)])),
      )
      if (rollbackFailures.length) {
        throw new Error(`${messageOf(error)}; rollback was incomplete for: ${rollbackFailures.join(', ')}`)
      }
      throw error
    }

    const first = sourceBackups[0]
    return {
      client,
      groupId: selectedGroupId,
      createdAt: first.createdAt,
      restoredFiles: restoreFiles
        .filter((file) => sourceByRole.get(file.role)!.existed)
        .map((file) => file.path),
      deletedFiles: restoreFiles
        .filter((file) => (
          !sourceByRole.get(file.role)!.existed
          && safetyBackups.find((backup) => backup.role === file.role)?.existed
        ))
        .map((file) => file.path),
      sourceBackups,
      ...(safetyBackupSet ? { safetyBackupSet } : {}),
    }
  }

  async restore(backupPath: string, client?: SupportedClient): Promise<RestoreBackupResult> {
    return runConfigMutation(() => this.restoreUnlocked(backupPath, client))
  }

  private async restoreUnlocked(backupPath: string, client?: SupportedClient): Promise<RestoreBackupResult> {
    const normalized = this.normalizedPath(backupPath)
    const managedBackups = await this.listBackups(client)
    const record = managedBackups.find((candidate) =>
      this.normalizedPath(candidate.backupPath) === normalized)
    if (!record) throw new Error('Backup is not managed by this client configuration service')

    const eligibleFiles = client ? clientFiles(this.paths, client) : allClientFiles(this.paths)
    const file = eligibleFiles.find((candidate) =>
      candidate.client === record.client && candidate.role === record.role)
    if (!file) throw new Error('Backup target is no longer configured')
    const clientEligibleFiles = clientFiles(this.paths, record.client)
    const sourceBackups = managedBackups.filter((candidate) => candidate.client === record.client && candidate.groupId === record.groupId)
    const sourceRoles = new Set<ClientConfigFileRole>()
    for (const source of sourceBackups) {
      if (sourceRoles.has(source.role)) throw new Error(`Backup set ${record.groupId} contains duplicate ${source.role} files.`)
      sourceRoles.add(source.role)
    }
    if (sourceBackups.some((source) => !clientEligibleFiles.some((candidate) => candidate.role === source.role))) {
      throw new Error(`Backup set ${record.groupId} contains an unsupported client configuration file.`)
    }
    await this.assertRestorableBackupGroup(record.client, record.groupId, sourceBackups, clientEligibleFiles)
    const safetyBackup = await this.backupFile(file)
    const content = record.existed ? await readFile(record.backupPath) : undefined
    await this.assertMatchesBackup(file, safetyBackup)
    if (content) await atomicWriteFile(record.targetPath, content, this.randomId, file.containsCredential)
    else await rm(record.targetPath, { force: true })
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
    return (await this.backupFiles([file], this.now(), true))[0]
  }

  /**
   * Transactionally create one exact backup group. Every record receives the
   * same timestamp and collision suffix. If a collision races us, the files we
   * created for that candidate group are removed before retrying.
   */
  private async backupFiles(
    requestedFiles: ClientConfigFilePath[],
    operationDate: Date,
    includeAllMissing = false,
  ): Promise<BackupRecord[]> {
    return this.backupFilesUnlocked(requestedFiles, operationDate, includeAllMissing)
  }

  private async backupFilesUnlocked(
    requestedFiles: ClientConfigFilePath[],
    operationDate: Date,
    includeAllMissing: boolean,
  ): Promise<BackupRecord[]> {
    const capturedFiles = await Promise.all(requestedFiles.map(async (file) => ({
      file,
      info: await pathStat(file.path),
    })))
    const existingFiles = capturedFiles.filter((candidate) => candidate.info?.isFile())
    if (!includeAllMissing && existingFiles.length === 0) return []
    const filesToCapture = capturedFiles
    if (filesToCapture.length === 0) return []

    const client = filesToCapture[0].file.client
    if (filesToCapture.some((candidate) => candidate.file.client !== client)) {
      throw new Error('A backup set cannot contain configuration files from multiple clients.')
    }

    const stamp = timestampForFile(operationDate)
    const createdAt = operationDate.getTime()
    const managedFiles = clientFiles(this.paths, client)
    for (let sequence = 0; sequence <= maximumBackupSequence; sequence += 1) {
      // Do not accidentally merge a single-file safety backup into another
      // role's group created during the same millisecond.
      const occupied = (await Promise.all(managedFiles.flatMap((file) => [
        pathStat(backupPathFor(file, stamp, sequence)),
        pathStat(missingBackupPathFor(file, stamp, sequence)),
      ]))).some(Boolean) || Boolean(await pathStat(backupManifestPathFor(this.paths, client, stamp, sequence)))
      if (occupied) continue

      const createdPaths: string[] = []
      const records: BackupRecord[] = []
      let collided = false
      try {
        for (const { file, info } of filesToCapture) {
          const existed = Boolean(info?.isFile())
          const backupPath = existed
            ? backupPathFor(file, stamp, sequence)
            : missingBackupPathFor(file, stamp, sequence)
          try {
            if (existed) await copyExclusive(file.path, backupPath)
            else await createExclusiveTombstone(backupPath)
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
            existed,
            groupId: backupGroupId(createdAt, sequence),
            createdAt,
            size: backupInfo?.size ?? info?.size ?? 0,
          })
        }
        if (!collided) {
          const manifestPath = backupManifestPathFor(this.paths, client, stamp, sequence)
          try {
            await createExclusiveManifest(manifestPath, {
              version: 1,
              client,
              groupId: backupGroupId(createdAt, sequence),
              createdAt,
              members: records.map((record) => ({
                role: record.role,
                existed: record.existed,
                backupName: basename(record.backupPath),
              })),
            })
            createdPaths.push(manifestPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') collided = true
            else throw error
          }
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
      const isTombstone = entry.name.endsWith(missingBackupMarker)
      const timestampEnd = isTombstone ? -missingBackupMarker.length : undefined
      const createdAt = dateFromTimestamp(entry.name.slice(prefix.length, timestampEnd))
      if (createdAt === undefined) continue
      const backupPath = resolve(dirname(file.path), entry.name)
      const info = await pathStat(backupPath)
      if (!info) continue
      records.push({
        client: file.client,
        role: file.role,
        targetPath: file.path,
        backupPath,
        existed: !isTombstone,
        groupId: backupGroupId(createdAt, backupSequence(backupPath)),
        createdAt,
        size: info.size,
      })
    }
    return records
  }

  private async assertExpectedFiles(files: ClientConfigFilePath[], expected: ExistingClientConfig): Promise<void> {
    for (const file of files) {
      const current = await readTextIfPresent(file.path)
      if (current !== expected[file.role]) {
        throw new ClientConfigValidationError('Client configuration changed outside Stone+. Reload it before saving.')
      }
    }
  }

  private async assertRestorableBackupGroup(
    client: SupportedClient,
    groupId: string,
    sourceBackups: BackupRecord[],
    eligibleFiles: ClientConfigFilePath[],
  ): Promise<void> {
    const manifestPath = backupManifestPathForGroup(this.paths, client, groupId)
    const manifest = manifestPath ? await readBackupManifest(manifestPath, groupId) : undefined
    if (manifest) {
      const membersByRole = new Map<ClientConfigFileRole, BackupSetManifestMember>()
      for (const member of manifest.members) {
        if (membersByRole.has(member.role)) {
          throw new Error(`Backup set ${groupId} has an invalid manifest and cannot be restored.`)
        }
        membersByRole.set(member.role, member)
      }
      const supportedRoles = new Set(eligibleFiles.map((file) => file.role))
      const exactMembers = manifest.client === client
        && manifest.groupId === groupId
        && manifest.createdAt === sourceBackups[0]?.createdAt
        && manifest.members.length === sourceBackups.length
        && manifest.members.every((member) => supportedRoles.has(member.role))
        && sourceBackups.every((backup) => {
          const member = membersByRole.get(backup.role)
          return member?.existed === backup.existed && member.backupName === basename(backup.backupPath)
        })
      if (!exactMembers) {
        throw new Error(`Backup set ${groupId} is incomplete or does not match its manifest; no files were changed.`)
      }
      return
    }

    // Backups produced before manifests existed contain only value snapshots
    // and remain restorable as partial, non-destructive legacy groups. A
    // transitional tombstone group is safe only when all supported roles are
    // still present; otherwise it may be the residue of interrupted pruning.
    if (sourceBackups.some((backup) => !backup.existed)) {
      const sourceRoles = new Set(sourceBackups.map((backup) => backup.role))
      const complete = sourceBackups.length === eligibleFiles.length
        && eligibleFiles.every((file) => sourceRoles.has(file.role))
      if (!complete) {
        throw new Error(`Backup set ${groupId} is an incomplete deletion snapshot; no files were changed.`)
      }
    }
  }

  private async assertMatchesBackup(file: ClientConfigFilePath, backup: BackupRecord | undefined): Promise<void> {
    const current = await readFile(file.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!backup) {
      if (current !== undefined) throw new ClientConfigValidationError('Client configuration changed while Stone+ was preparing the update.')
      return
    }
    if (!backup.existed) {
      if (current !== undefined) {
        throw new ClientConfigValidationError('Client configuration changed while Stone+ was preparing the update.')
      }
      return
    }
    const expected = await readFile(backup.backupPath)
    if (!current?.equals(expected)) {
      throw new ClientConfigValidationError('Client configuration changed while Stone+ was preparing the update.')
    }
  }

  private async rollback(
    written: ClientConfigFilePath[],
    backups: BackupRecord[],
    plan: ClientConfigPlan,
    expectedContents?: Map<ClientConfigFilePath['role'], Buffer | undefined>,
  ): Promise<string[]> {
    const failures: string[] = []
    for (const file of [...written].reverse()) {
      const planned = plan.files.find((candidate) => candidate.role === file.role)
      const backup = backups.find((candidate) => candidate.role === file.role)
      try {
        const current = await readFile(file.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        const expected = expectedContents?.has(file.role)
          ? expectedContents.get(file.role)
          : planned ? Buffer.from(planned.content, 'utf8') : undefined
        if (!planned || (expected ? !current?.equals(expected) : current !== undefined)) {
          failures.push(file.path)
          continue
        }
        if (backup?.existed) {
          const content = await readFile(backup.backupPath)
          await atomicWriteFile(file.path, content, this.randomId, file.containsCredential)
        } else await rm(file.path, { force: true })
      } catch { failures.push(file.path) }
    }
    return failures
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function backupSequence(path: string): number {
  const match = /\.stone-backup\.\d{8}T\d{9}Z(?:\.(\d+))?(?:\.missing)?$/.exec(path)
  return match?.[1] ? Number(match[1]) : 0
}

function backupPathFor(file: ClientConfigFilePath, stamp: string, sequence: number): string {
  return `${file.path}${backupMarker}${stamp}${sequence === 0 ? '' : `.${sequence}`}`
}

function missingBackupPathFor(file: ClientConfigFilePath, stamp: string, sequence: number): string {
  return `${backupPathFor(file, stamp, sequence)}${missingBackupMarker}`
}

function backupManifestPathFor(
  paths: ResolvedClientConfigPaths,
  client: SupportedClient,
  stamp: string,
  sequence: number,
): string {
  const suffix = sequence === 0 ? '' : `.${sequence}`
  return resolve(clientDirectory(paths, client), `${backupManifestMarker}${stamp}${suffix}${backupManifestSuffix}`)
}

function backupManifestPathForGroup(
  paths: ResolvedClientConfigPaths,
  client: SupportedClient,
  groupId: string,
): string | undefined {
  const match = /^(\d+):(\d+)$/.exec(groupId)
  if (!match) return undefined
  const createdAt = Number(match[1])
  const sequence = Number(match[2])
  if (!Number.isSafeInteger(createdAt) || !Number.isInteger(sequence) || sequence < 0) return undefined
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return undefined
  return backupManifestPathFor(paths, client, timestampForFile(date), sequence)
}

async function createExclusiveTombstone(path: string): Promise<void> {
  await createExclusiveFile(path, Buffer.alloc(0))
}

async function createExclusiveManifest(path: string, manifest: BackupSetManifestV1): Promise<void> {
  await createExclusiveFile(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
}

async function createExclusiveFile(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600)
  let closed = false
  try {
    if (content.length > 0) await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    closed = true
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readBackupManifest(path: string, groupId: string): Promise<BackupSetManifestV1 | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  try {
    const manifest = JSON.parse(content) as Partial<BackupSetManifestV1>
    if (
      manifest.version !== 1
      || typeof manifest.client !== 'string'
      || typeof manifest.groupId !== 'string'
      || typeof manifest.createdAt !== 'number'
      || !Array.isArray(manifest.members)
      || manifest.members.some((member) => (
        !member
        || typeof member.role !== 'string'
        || typeof member.existed !== 'boolean'
        || typeof member.backupName !== 'string'
      ))
    ) {
      throw new Error('invalid manifest shape')
    }
    return manifest as BackupSetManifestV1
  } catch {
    throw new Error(`Backup set ${groupId} has an invalid manifest and cannot be restored.`)
  }
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
