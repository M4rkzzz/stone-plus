import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { parse } from 'smol-toml'
import type {
  CodexSessionRepairOverview,
  CodexSessionRepairPreview,
  CodexSessionRepairResult,
  CodexSessionRepairTarget,
  CodexSessionRepairTargetSource,
} from '@shared/types'
import { atomicWriteFile } from '../client-config/filesystem'
import { acquireCodexSessionMaintenanceLock } from './session-maintenance-lock'

const DEFAULT_PROVIDER = 'openai'
const BACKUP_KEEP_COUNT = 5
const BACKUP_MARKER = 'Stone+ session repair'
const PROVIDER_PATTERN = /^[A-Za-z0-9_.-]+$/
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const ROLLOUT_SCAN_BYTES = 1024 * 1024
const GLOBAL_STATE_FILE = '.codex-global-state.json'

interface SessionRepairServiceOptions {
  codexHome: string
  now?: () => Date
  randomId?: () => string
  preserveRolloutMtime?: (path: string, atime: Date, mtime: Date) => Promise<void>
}

interface RolloutPlan {
  path: string
  relativePath: string
  archived: boolean
  originalHash: string
  nextHash?: string
  originalAtimeMs: number
  originalMtimeMs: number
  providers: string[]
  threadId?: string
  cwd?: string
  hasUserEvent: boolean
  encryptedContent: boolean
  sessionMetaCount: number
  rewriteNeeded: boolean
}

interface DatabaseThreadChange {
  id: string
  originalProvider: string | null
  nextProvider?: string
  originalHasUserEvent?: number | null
  nextHasUserEvent?: number
  originalCwd?: string | null
  nextCwd?: string
}

interface DatabasePlan {
  path: string
  relativePath: string
  threadCount: number
  providerIds: string[]
  columns: Set<string>
  changes: DatabaseThreadChange[]
}

interface GlobalStatePlan {
  path: string
  originalBytes: Buffer
  originalHash: string
  nextText: string
  nextHash: string
  changedFields: string[]
  conflictingFields: string[]
}

interface RepairPlan {
  targetProvider: string
  currentProvider: string
  targets: CodexSessionRepairTarget[]
  rollouts: RolloutPlan[]
  databases: DatabasePlan[]
  globalState?: GlobalStatePlan
  skippedFiles: string[]
  revision: string
}

export class CodexSessionRepairService {
  private readonly codexHome: string
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly preserveRolloutMtime: (path: string, atime: Date, mtime: Date) => Promise<void>
  private active = false

  public constructor(options: SessionRepairServiceOptions) {
    this.codexHome = resolve(options.codexHome)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? (() => randomUUID().slice(0, 12))
    this.preserveRolloutMtime = options.preserveRolloutMtime ?? utimes
  }

  public async inspect(): Promise<CodexSessionRepairOverview> {
    const currentProvider = await this.readCurrentProvider()
    const plan = await this.buildPlan(currentProvider)
    return overviewFor(plan, this.codexHome)
  }

  public async preview(targetProvider: string): Promise<CodexSessionRepairPreview> {
    const plan = await this.buildPlan(assertProvider(targetProvider))
    return previewFor(plan, this.codexHome)
  }

  public async repair(targetProvider: string, expectedRevision: string): Promise<CodexSessionRepairResult> {
    const provider = assertProvider(targetProvider)
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new Error('会话修复预览无效，请重新预览。')
    }
    if (this.active) throw new Error('已有会话修复正在运行。')
    this.active = true
    let releaseLock: (() => Promise<void>) | undefined
    try {
      releaseLock = await acquireCodexSessionMaintenanceLock(this.codexHome, 'provider-sync', this.now(), this.randomId())
      const plan = await this.buildPlan(provider)
      if (plan.revision !== expectedRevision) {
        throw new Error('Codex 会话数据已在预览后发生变化；为避免覆盖新内容，本次修复已中止，请重新预览。')
      }
      const changedRollouts = plan.rollouts.filter((item) => item.rewriteNeeded)
      const changedDatabases = plan.databases.filter((item) => item.changes.length > 0)
      const changedGlobalState = plan.globalState?.changedFields.length ? plan.globalState : undefined
      if (!changedRollouts.length && !changedDatabases.length && !changedGlobalState) {
        return resultFor(plan, undefined)
      }

      await this.assertRolloutsUnchanged(changedRollouts)
      if (changedGlobalState) await this.assertGlobalStateUnchanged(changedGlobalState)
      const backupPath = await this.createBackup(plan, changedRollouts, changedDatabases, changedGlobalState)
      const writtenRollouts: RolloutPlan[] = []
      const writtenDatabases: DatabasePlan[] = []
      let writtenGlobalState: GlobalStatePlan | undefined
      try {
        for (const rollout of changedRollouts) {
          const backupBytes = await readFile(join(backupPath, 'rollouts', rollout.relativePath))
          const currentBytes = await readFile(rollout.path)
          if (!currentBytes.equals(backupBytes)) {
            throw new Error(`会话文件在备份后发生变化，未覆盖新内容：${rollout.relativePath}`)
          }
          const rewritten = rewriteRollout(decodeUtf8(currentBytes, rollout.relativePath), plan.targetProvider)
          rollout.nextHash = rewritten.nextHash
          await atomicWriteFile(rollout.path, rewritten.nextText, this.randomId)
          // Register the completed content replacement before restoring metadata.
          // If utimes fails, rollback must still restore the bytes that were
          // already committed by atomicWriteFile.
          writtenRollouts.push(rollout)
          await this.preserveMtime(rollout)
        }
        for (const database of changedDatabases) {
          this.applyDatabasePlan(database)
          writtenDatabases.push(database)
        }
        if (changedGlobalState) {
          await this.assertGlobalStateUnchanged(changedGlobalState)
          await atomicWriteFile(changedGlobalState.path, changedGlobalState.nextText, this.randomId)
          writtenGlobalState = changedGlobalState
        }
      } catch (error) {
        const rollbackFailures = await this.rollback(writtenRollouts, writtenDatabases, writtenGlobalState, backupPath)
        const suffix = rollbackFailures.length
          ? `；部分自动回滚失败，请从备份目录恢复：${backupPath}`
          : `；已自动回滚，备份保留在：${backupPath}`
        throw new Error(`会话修复未完成：${messageOf(error)}${suffix}`)
      }
      let retentionWarning: string | undefined
      try {
        await this.pruneBackups(backupPath)
      } catch (error) {
        retentionWarning = `会话已修复，但旧备份清理失败：${messageOf(error)}`
      }
      return { ...resultFor(plan, backupPath), ...(retentionWarning ? { retentionWarning } : {}) }
    } finally {
      await releaseLock?.().catch(() => undefined)
      this.active = false
    }
  }

  private async buildPlan(targetProvider: string): Promise<RepairPlan> {
    const currentProvider = await this.readCurrentProvider()
    const skippedFiles: string[] = []
    const rolloutPaths = await this.findRolloutFiles()
    const rollouts: RolloutPlan[] = []
    for (const path of rolloutPaths) {
      try {
        rollouts.push(await this.readRollout(path, targetProvider))
      } catch (error) {
        if (isLockedError(error)) {
          skippedFiles.push(path)
          continue
        }
        throw error
      }
    }

    const projectlessThreadIds = await this.readProjectlessThreadIds()
    const userEventThreadIds = new Set(rollouts
      .filter((item) => item.hasUserEvent)
      .flatMap((item) => item.threadId ? [item.threadId] : []))
    const cwdByThreadId = new Map(rollouts.flatMap((item) => (
      item.threadId && item.cwd && !projectlessThreadIds.has(item.threadId)
        ? [[item.threadId, item.cwd] as const]
        : []
    )))
    const databases = (await this.findSessionDatabases()).map((path) => (
      this.readDatabasePlan(path, targetProvider, userEventThreadIds, cwdByThreadId)
    ))
    const globalState = await this.readGlobalStatePlan()
    const targets = await this.buildTargets(currentProvider, rollouts, databases)
    const revision = revisionFor(targetProvider, rollouts, databases, globalState)
    return { targetProvider, currentProvider, targets, rollouts, databases, globalState, skippedFiles, revision }
  }

  private async readCurrentProvider(): Promise<string> {
    try {
      const document = parse(await readFile(join(this.codexHome, 'config.toml'), 'utf8')) as Record<string, unknown>
      const provider = typeof document.model_provider === 'string' ? document.model_provider.trim() : ''
      return PROVIDER_PATTERN.test(provider) ? provider : DEFAULT_PROVIDER
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_PROVIDER
      throw new Error(`无法读取 Codex config.toml：${messageOf(error)}`)
    }
  }

  private async configuredProviderIds(): Promise<string[]> {
    try {
      const document = parse(await readFile(join(this.codexHome, 'config.toml'), 'utf8')) as Record<string, unknown>
      const providers = document.model_providers
      return providers && typeof providers === 'object' && !Array.isArray(providers)
        ? Object.keys(providers).filter((id) => PROVIDER_PATTERN.test(id))
        : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async buildTargets(
    currentProvider: string,
    rollouts: RolloutPlan[],
    databases: DatabasePlan[],
  ): Promise<CodexSessionRepairTarget[]> {
    const sources = new Map<string, Set<CodexSessionRepairTargetSource>>()
    const add = (id: string, source: CodexSessionRepairTargetSource) => {
      if (!PROVIDER_PATTERN.test(id)) return
      const entries = sources.get(id) ?? new Set<CodexSessionRepairTargetSource>()
      entries.add(source)
      sources.set(id, entries)
    }
    add(DEFAULT_PROVIDER, 'config')
    add(currentProvider, 'config')
    for (const id of await this.configuredProviderIds()) add(id, 'config')
    for (const rollout of rollouts) for (const id of rollout.providers) add(id, 'rollout')
    for (const database of databases) for (const id of database.providerIds) add(id, 'sqlite')
    return [...sources.entries()]
      .map(([id, entries]) => ({ id, sources: [...entries].sort(), isCurrentProvider: id === currentProvider }))
      .sort((left, right) => Number(right.isCurrentProvider) - Number(left.isCurrentProvider) || left.id.localeCompare(right.id))
  }

  private async findRolloutFiles(): Promise<string[]> {
    const files: string[] = []
    for (const directory of ['sessions', 'archived_sessions']) {
      await collectFiles(join(this.codexHome, directory), files, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
    }
    return files.sort()
  }

  private async readRollout(path: string, targetProvider: string): Promise<RolloutPlan> {
    const info = await stat(path)
    const handle = await open(path, 'r')
    let prefix: Buffer
    try {
      prefix = Buffer.allocUnsafe(Math.min(info.size, ROLLOUT_SCAN_BYTES))
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
      prefix = prefix.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    const originalText = prefix.toString('utf8')
    let threadId: string | undefined
    let cwd: string | undefined
    let hasUserEvent = false
    let encryptedContent = false
    let sessionMetaCount = 0
    let rewriteNeeded = false
    const providers: string[] = []
    for (const segment of originalText.match(/.*(?:\r\n|\n|$)/g) ?? []) {
      if (!segment) continue
      const lineEnding = segment.endsWith('\r\n') ? '\r\n' : segment.endsWith('\n') ? '\n' : ''
      const line = lineEnding ? segment.slice(0, -lineEnding.length) : segment
      if (line.includes('"user_message"') || line.includes('"user_input"')) hasUserEvent = true
      if (line.includes('"encrypted_content"')) encryptedContent = true
      if (line.includes('"session_meta"')) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)) {
            const payload = record.payload as Record<string, unknown>
            sessionMetaCount += 1
            if (!threadId && typeof payload.id === 'string' && payload.id.trim()) threadId = payload.id.trim()
            if (!cwd && typeof payload.cwd === 'string') cwd = normalizeWorkspacePath(payload.cwd)
            const originalProvider = typeof payload.model_provider === 'string' ? payload.model_provider : ''
            if (originalProvider) providers.push(originalProvider)
            if (originalProvider !== targetProvider) {
              rewriteNeeded = true
            }
          }
        } catch {
          // Non-JSON diagnostic lines are preserved byte-for-byte.
        }
      }
    }
    const relativePath = safeRelative(this.codexHome, path)
    return {
      path,
      relativePath,
      archived: relativePath.startsWith(`archived_sessions${sep}`),
      originalHash: rolloutFingerprint(info.size, info.mtimeMs, prefix),
      originalAtimeMs: info.atimeMs,
      originalMtimeMs: info.mtimeMs,
      providers,
      threadId,
      cwd,
      hasUserEvent,
      encryptedContent,
      sessionMetaCount,
      rewriteNeeded,
    }
  }

  private async findSessionDatabases(): Promise<string[]> {
    const candidates = [join(this.codexHome, 'state_5.sqlite')]
    try {
      for (const entry of await readdir(join(this.codexHome, 'sqlite'), { withFileTypes: true })) {
        if (entry.isFile() && SQLITE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          candidates.push(join(this.codexHome, 'sqlite', entry.name))
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return candidates.filter((path) => databaseHasThreads(path)).sort()
  }

  private readDatabasePlan(
    path: string,
    targetProvider: string,
    userEventThreadIds: Set<string>,
    cwdByThreadId: Map<string, string>,
  ): DatabasePlan {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const columns = tableColumns(database, 'threads')
      if (!columns.has('id') || !columns.has('model_provider')) {
        return { path, relativePath: safeRelative(this.codexHome, path), threadCount: 0, providerIds: [], columns, changes: [] }
      }
      const hasUserColumn = columns.has('has_user_event')
      const hasCwdColumn = columns.has('cwd')
      const rows = database.prepare(`
        SELECT id, model_provider,
          ${hasUserColumn ? 'has_user_event' : 'NULL'} AS has_user_event,
          ${hasCwdColumn ? 'cwd' : 'NULL'} AS cwd
        FROM threads
      `).all() as Array<Record<string, unknown>>
      const providerIds = new Set<string>()
      const changes: DatabaseThreadChange[] = []
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) continue
        const originalProvider = typeof row.model_provider === 'string' ? row.model_provider : null
        if (originalProvider) providerIds.add(originalProvider)
        const originalHasUserEvent = typeof row.has_user_event === 'number' ? row.has_user_event : null
        const originalCwd = typeof row.cwd === 'string' ? row.cwd : null
        const nextCwd = cwdByThreadId.get(row.id)
        const change: DatabaseThreadChange = {
          id: row.id,
          originalProvider,
          ...(originalProvider !== targetProvider ? { nextProvider: targetProvider } : {}),
          ...(hasUserColumn && userEventThreadIds.has(row.id) && originalHasUserEvent !== 1
            ? { originalHasUserEvent, nextHasUserEvent: 1 }
            : {}),
          ...(hasCwdColumn && nextCwd && originalCwd !== nextCwd ? { originalCwd, nextCwd } : {}),
        }
        if (change.nextProvider !== undefined || change.nextHasUserEvent !== undefined || change.nextCwd !== undefined) {
          changes.push(change)
        }
      }
      return {
        path,
        relativePath: safeRelative(this.codexHome, path),
        threadCount: rows.length,
        providerIds: [...providerIds].sort(),
        columns,
        changes,
      }
    } finally {
      database.close()
    }
  }

  private async readProjectlessThreadIds(): Promise<Set<string>> {
    try {
      const value = JSON.parse(await readFile(join(this.codexHome, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>
      const ids = value['projectless-thread-ids']
      return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())) : [])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw new Error(`无法读取 Codex 全局状态：${messageOf(error)}`)
    }
  }

  private async readGlobalStatePlan(): Promise<GlobalStatePlan | undefined> {
    const path = join(this.codexHome, GLOBAL_STATE_FILE)
    let originalBytes: Buffer
    try {
      originalBytes = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(`无法读取 Codex 全局状态：${messageOf(error)}`)
    }
    let value: unknown
    const originalText = decodeUtf8(originalBytes, GLOBAL_STATE_FILE)
    try {
      value = JSON.parse(originalText)
    } catch (error) {
      throw new Error(`无法解析 Codex 全局状态：${messageOf(error)}`)
    }
    if (!isRecord(value)) throw new Error('Codex 全局状态必须是 JSON 对象。')
    const normalized = normalizeGlobalWorkspaceState(value)
    const nextText = stringifyJsonLikeOriginal(normalized.value, originalText)
    return {
      path,
      originalBytes,
      originalHash: sha256(originalBytes),
      nextText,
      nextHash: sha256(nextText),
      changedFields: normalized.changedFields,
      conflictingFields: normalized.conflictingFields,
    }
  }

  private async assertRolloutsUnchanged(rollouts: RolloutPlan[]): Promise<void> {
    for (const rollout of rollouts) {
      if (await fastRolloutFingerprint(rollout.path) !== rollout.originalHash) {
        throw new Error(`会话文件在修复前发生变化，请重新预览：${rollout.relativePath}`)
      }
    }
  }

  private async assertGlobalStateUnchanged(plan: GlobalStatePlan): Promise<void> {
    let current: Buffer
    try {
      current = await readFile(plan.path)
    } catch (error) {
      throw new Error(`Codex 全局状态在修复前发生变化，请重新预览：${messageOf(error)}`)
    }
    if (!current.equals(plan.originalBytes)) {
      throw new Error('Codex 全局状态已在预览后发生变化；为避免覆盖新工作区，本次修复已中止，请重新预览。')
    }
  }

  private async createBackup(
    plan: RepairPlan,
    rollouts: RolloutPlan[],
    databases: DatabasePlan[],
    globalState?: GlobalStatePlan,
  ): Promise<string> {
    const backupRoot = join(this.codexHome, 'backups_state', 'stone-session-repair')
    const backupPath = join(backupRoot, `${timestampName(this.now())}-${this.randomId()}`)
    await mkdir(backupRoot, { recursive: true })
    await mkdir(backupPath, { recursive: false })
    for (const rollout of rollouts) {
      const destination = join(backupPath, 'rollouts', rollout.relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(rollout.path, destination)
    }
    for (const databasePlan of databases) {
      const destination = join(backupPath, 'db', databasePlan.relativePath)
      await mkdir(dirname(destination), { recursive: true })
      const database = new DatabaseSync(databasePlan.path, { readOnly: true })
      try {
        await backup(database, destination)
      } finally {
        database.close()
      }
    }
    for (const name of ['config.toml']) {
      try {
        await copyFile(join(this.codexHome, name), join(backupPath, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (globalState) {
      await writeFile(join(backupPath, GLOBAL_STATE_FILE), globalState.originalBytes, { mode: 0o600 })
    } else {
      try {
        await copyFile(join(this.codexHome, GLOBAL_STATE_FILE), join(backupPath, GLOBAL_STATE_FILE))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await writeFile(join(backupPath, 'metadata.json'), JSON.stringify({
      version: 1,
      managedBy: BACKUP_MARKER,
      createdAt: this.now().toISOString(),
      codexHome: this.codexHome,
      targetProvider: plan.targetProvider,
      revision: plan.revision,
      changedRolloutFiles: rollouts.map((item) => item.relativePath),
      changedDatabases: databases.map((item) => item.relativePath),
      changedGlobalStateFields: globalState?.changedFields ?? [],
      conflictingGlobalStateFields: globalState?.conflictingFields ?? [],
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
    return backupPath
  }

  private applyDatabasePlan(plan: DatabasePlan): void {
    const database = new DatabaseSync(plan.path)
    try {
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      try {
        const provider = database.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider IS ?')
        const userEvent = plan.columns.has('has_user_event')
          ? database.prepare('UPDATE threads SET has_user_event = ? WHERE id = ? AND has_user_event IS ?')
          : undefined
        const cwd = plan.columns.has('cwd')
          ? database.prepare('UPDATE threads SET cwd = ? WHERE id = ? AND cwd IS ?')
          : undefined
        for (const change of plan.changes) {
          if (change.nextProvider !== undefined && Number(provider.run(change.nextProvider, change.id, change.originalProvider).changes) !== 1) {
            throw new Error(`线程 ${change.id} 的 provider 已发生变化`)
          }
          if (change.nextHasUserEvent !== undefined && Number(userEvent?.run(change.nextHasUserEvent, change.id, change.originalHasUserEvent ?? null)?.changes ?? 0) !== 1) {
            throw new Error(`线程 ${change.id} 的用户事件索引已发生变化`)
          }
          if (change.nextCwd !== undefined && Number(cwd?.run(change.nextCwd, change.id, change.originalCwd ?? null)?.changes ?? 0) !== 1) {
            throw new Error(`线程 ${change.id} 的工作区索引已发生变化`)
          }
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    } finally {
      database.close()
    }
  }

  private rollbackDatabasePlan(plan: DatabasePlan): void {
    const database = new DatabaseSync(plan.path)
    try {
      database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
      try {
        const provider = database.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider IS ?')
        const userEvent = plan.columns.has('has_user_event')
          ? database.prepare('UPDATE threads SET has_user_event = ? WHERE id = ? AND has_user_event IS ?')
          : undefined
        const cwd = plan.columns.has('cwd')
          ? database.prepare('UPDATE threads SET cwd = ? WHERE id = ? AND cwd IS ?')
          : undefined
        for (const change of [...plan.changes].reverse()) {
          if (change.nextCwd !== undefined && Number(cwd?.run(change.originalCwd ?? null, change.id, change.nextCwd)?.changes ?? 0) !== 1) {
            throw new Error(`线程 ${change.id} 的工作区索引无法安全回滚`)
          }
          if (change.nextHasUserEvent !== undefined && Number(userEvent?.run(change.originalHasUserEvent ?? null, change.id, change.nextHasUserEvent)?.changes ?? 0) !== 1) {
            throw new Error(`线程 ${change.id} 的用户事件索引无法安全回滚`)
          }
          if (change.nextProvider !== undefined && Number(provider.run(change.originalProvider, change.id, change.nextProvider).changes) !== 1) {
            throw new Error(`线程 ${change.id} 的 provider 无法安全回滚`)
          }
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    } finally {
      database.close()
    }
  }

  private async rollback(
    rollouts: RolloutPlan[],
    databases: DatabasePlan[],
    globalState: GlobalStatePlan | undefined,
    backupPath: string,
  ): Promise<string[]> {
    const failures: string[] = []
    if (globalState) {
      try {
        if (await sha256File(globalState.path) !== globalState.nextHash) {
          failures.push(globalState.path)
        } else {
          await atomicWriteFile(globalState.path, await readFile(join(backupPath, GLOBAL_STATE_FILE)), this.randomId)
        }
      } catch { failures.push(globalState.path) }
    }
    for (const database of [...databases].reverse()) {
      try { this.rollbackDatabasePlan(database) } catch { failures.push(database.path) }
    }
    for (const rollout of [...rollouts].reverse()) {
      try {
        const currentHash = await sha256File(rollout.path)
        if (!rollout.nextHash || currentHash !== rollout.nextHash) {
          failures.push(rollout.path)
          continue
        }
        await copyFile(join(backupPath, 'rollouts', rollout.relativePath), rollout.path)
        await this.preserveMtime(rollout)
      } catch { failures.push(rollout.path) }
    }
    return failures
  }

  private async pruneBackups(preservePath: string): Promise<void> {
    const root = dirname(preservePath)
    const managed: Array<{ path: string; createdAt: number }> = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      try {
        const metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8')) as Record<string, unknown>
        if (metadata.managedBy !== BACKUP_MARKER) continue
        managed.push({ path, createdAt: Date.parse(String(metadata.createdAt)) || 0 })
      } catch { /* Unrecognized directories are never removed. */ }
    }
    managed.sort((left, right) => (
      left.path === preservePath ? -1
        : right.path === preservePath ? 1
          : right.createdAt - left.createdAt || right.path.localeCompare(left.path)
    ))
    for (const item of managed.slice(BACKUP_KEEP_COUNT)) await rm(item.path, { recursive: true, force: true })
  }

  private preserveMtime(rollout: RolloutPlan): Promise<void> {
    return this.preserveRolloutMtime(
      rollout.path,
      new Date(rollout.originalAtimeMs),
      new Date(rollout.originalMtimeMs)
    )
  }
}

function overviewFor(plan: RepairPlan, codexHome: string): CodexSessionRepairOverview {
  return {
    codexHome,
    currentProvider: plan.currentProvider,
    targets: plan.targets,
    sessionFiles: plan.rollouts.filter((item) => !item.archived).length,
    archivedSessionFiles: plan.rollouts.filter((item) => item.archived).length,
    indexedThreads: plan.databases.reduce((sum, item) => sum + item.threadCount, 0),
    sqliteDatabases: plan.databases.map((item) => item.path),
    skippedFiles: plan.skippedFiles,
  }
}

function previewFor(plan: RepairPlan, codexHome: string): CodexSessionRepairPreview {
  const providerRows = plan.databases.reduce((sum, database) => sum + database.changes.filter((item) => item.nextProvider !== undefined).length, 0)
  const userEventRows = plan.databases.reduce((sum, database) => sum + database.changes.filter((item) => item.nextHasUserEvent !== undefined).length, 0)
  const cwdRows = plan.databases.reduce((sum, database) => sum + database.changes.filter((item) => item.nextCwd !== undefined).length, 0)
  const encryptedProviders = new Set(plan.rollouts
    .filter((item) => item.encryptedContent)
    .flatMap((item) => item.providers)
    .filter((provider) => provider !== plan.targetProvider))
  return {
    ...overviewFor(plan, codexHome),
    targetProvider: plan.targetProvider,
    revision: plan.revision,
    rolloutFilesToUpdate: plan.rollouts.filter((item) => item.rewriteNeeded).length,
    sqliteProviderRowsToUpdate: providerRows,
    sqliteUserEventRowsToUpdate: userEventRows,
    sqliteCwdRowsToUpdate: cwdRows,
    globalStateFieldsToUpdate: plan.globalState?.changedFields.length ?? 0,
    globalStateConflictingFields: plan.globalState?.conflictingFields ?? [],
    encryptedSessionFiles: plan.rollouts.filter((item) => item.encryptedContent && item.providers.some((provider) => provider !== plan.targetProvider)).length,
    encryptedSourceProviders: [...encryptedProviders].sort(),
  }
}

function resultFor(plan: RepairPlan, backupPath: string | undefined): CodexSessionRepairResult {
  const preview = previewFor(plan, '')
  return {
    targetProvider: plan.targetProvider,
    repairedRolloutFiles: preview.rolloutFilesToUpdate,
    sqliteProviderRowsUpdated: preview.sqliteProviderRowsToUpdate,
    sqliteUserEventRowsUpdated: preview.sqliteUserEventRowsToUpdate,
    sqliteCwdRowsUpdated: preview.sqliteCwdRowsToUpdate,
    globalStateFieldsUpdated: preview.globalStateFieldsToUpdate,
    globalStateConflictingFields: preview.globalStateConflictingFields,
    skippedFiles: plan.skippedFiles,
    encryptedSessionFiles: preview.encryptedSessionFiles,
    encryptedSourceProviders: preview.encryptedSourceProviders,
    ...(backupPath ? { backupPath } : {}),
  }
}

function revisionFor(
  targetProvider: string,
  rollouts: RolloutPlan[],
  databases: DatabasePlan[],
  globalState: GlobalStatePlan | undefined,
): string {
  return sha256(JSON.stringify({
    targetProvider,
    rollouts: rollouts.map((item) => [item.relativePath, item.originalHash, item.rewriteNeeded]),
    databases: databases.map((database) => [
      database.relativePath,
      database.changes.map((change) => [
        change.id,
        change.originalProvider,
        change.nextProvider,
        change.originalHasUserEvent,
        change.nextHasUserEvent,
        change.originalCwd,
        change.nextCwd,
      ]),
    ]),
    globalState: globalState?.changedFields.length ? [
      globalState.originalHash,
      globalState.nextHash,
      globalState.changedFields,
      globalState.conflictingFields,
    ] : null,
  }))
}

function rewriteRollout(originalText: string, targetProvider: string): { nextText: string; nextHash: string } {
  const output: string[] = []
  let offset = 0
  while (offset < originalText.length) {
    const newlineAt = originalText.indexOf('\n', offset)
    const end = newlineAt >= 0 ? newlineAt + 1 : originalText.length
    const segment = originalText.slice(offset, end)
    const lineEnding = segment.endsWith('\r\n') ? '\r\n' : segment.endsWith('\n') ? '\n' : ''
    const line = lineEnding ? segment.slice(0, -lineEnding.length) : segment
    let nextLine = line
    if (line.includes('"session_meta"')) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)) {
          const payload = record.payload as Record<string, unknown>
          if (payload.model_provider !== targetProvider) {
            payload.model_provider = targetProvider
            nextLine = JSON.stringify(record)
          }
        }
      } catch {
        // Preserve non-JSON diagnostic lines byte-for-byte.
      }
    }
    output.push(nextLine, lineEnding)
    offset = end
  }
  const nextText = output.join('')
  return { nextText, nextHash: sha256(nextText) }
}

async function fastRolloutFingerprint(path: string): Promise<string> {
  const info = await stat(path)
  const handle = await open(path, 'r')
  try {
    const prefix = Buffer.allocUnsafe(Math.min(info.size, ROLLOUT_SCAN_BYTES))
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    return rolloutFingerprint(info.size, info.mtimeMs, prefix.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function rolloutFingerprint(size: number, mtimeMs: number, prefix: Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(`${size}:${mtimeMs}:`)
  hash.update(prefix)
  return hash.digest('hex')
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function databaseHasThreads(path: string): boolean {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads' LIMIT 1").get())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  } finally {
    database?.close()
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
}

async function collectFiles(root: string, files: string[], accepts: (name: string) => boolean): Promise<void> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectFiles(path, files, accepts)
    else if (entry.isFile() && accepts(entry.name)) files.push(path)
  }
}

function normalizeWorkspacePath(value: string): string | undefined {
  const path = value.trim()
  if (!path) return undefined
  if (path.toLowerCase().startsWith('\\\\?\\unc\\')) return `\\\\${path.slice(8).replaceAll('/', '\\')}`
  if (path.startsWith('\\\\?\\')) return path.slice(4).replaceAll('\\', '/')
  return path
}

function normalizeGlobalWorkspaceState(value: Record<string, unknown>): {
  value: Record<string, unknown>
  changedFields: string[]
  conflictingFields: string[]
} {
  const next = { ...value }
  const changedFields: string[] = []
  const conflictingFields: string[] = []
  const replace = (field: string, normalized: unknown) => {
    if (!jsonEqual(value[field], normalized)) {
      next[field] = normalized
      changedFields.push(field)
    }
  }
  for (const field of ['electron-saved-workspace-roots', 'project-order']) {
    if (!Object.hasOwn(value, field)) continue
    const paths = workspacePathArray(value[field])
    if (!paths) {
      conflictingFields.push(field)
      continue
    }
    replace(field, dedupeWorkspacePaths(paths))
  }
  const activeField = 'active-workspace-roots'
  if (Object.hasOwn(value, activeField)) {
    const paths = workspacePathArray(value[activeField])
    if (!paths) {
      conflictingFields.push(activeField)
    } else {
      const normalized = dedupeWorkspacePaths(paths)
      replace(activeField, Array.isArray(value[activeField]) ? normalized : (normalized[0] ?? value[activeField]))
    }
  }
  const labelsField = 'electron-workspace-root-labels'
  if (Object.hasOwn(value, labelsField)) {
    if (!isRecord(value[labelsField])) {
      conflictingFields.push(labelsField)
    } else {
      const normalized = normalizePathKeyedRecord(value[labelsField])
      if (normalized.conflict) conflictingFields.push(labelsField)
      else replace(labelsField, normalized.value)
    }
  }
  const openTargetField = 'open-in-target-preferences'
  if (Object.hasOwn(value, openTargetField) && isRecord(value[openTargetField])) {
    const openTargets = value[openTargetField]
    if (Object.hasOwn(openTargets, 'perPath')) {
      const conflictField = `${openTargetField}.perPath`
      if (!isRecord(openTargets.perPath)) {
        conflictingFields.push(conflictField)
      } else {
        const normalized = normalizePathKeyedRecord(openTargets.perPath)
        if (normalized.conflict) conflictingFields.push(conflictField)
        else replace(openTargetField, { ...openTargets, perPath: normalized.value })
      }
    }
  }
  return {
    value: next,
    changedFields: [...new Set(changedFields)].sort(),
    conflictingFields: [...new Set(conflictingFields)].sort(),
  }
}

function workspacePathArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
}

function dedupeWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = normalizeWorkspacePath(path)
    if (!normalized) continue
    const comparable = normalized.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    if (seen.has(comparable)) continue
    seen.add(comparable)
    result.push(normalized)
  }
  return result
}

function normalizePathKeyedRecord(value: Record<string, unknown>): {
  value: Record<string, unknown>
  conflict: boolean
} {
  const normalized: Record<string, unknown> = {}
  const canonicalByComparable = new Map<string, string>()
  for (const [path, item] of Object.entries(value)) {
    const nextPath = normalizeWorkspacePath(path)
    if (!nextPath) return { value, conflict: true }
    const comparable = nextPath.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    const existingKey = canonicalByComparable.get(comparable)
    if (existingKey) {
      if (!jsonEqual(normalized[existingKey], item)) return { value, conflict: true }
      continue
    }
    canonicalByComparable.set(comparable, nextPath)
    normalized[nextPath] = item
  }
  return { value: normalized, conflict: false }
}

function stringifyJsonLikeOriginal(value: Record<string, unknown>, original: string): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  let text = JSON.stringify(value, null, 2)
  if (newline === '\r\n') text = text.replaceAll('\n', '\r\n')
  return original.endsWith('\n') ? text + newline : text
}

function decodeUtf8(value: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error(`${name} 不是有效的 UTF-8 文件。`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path)
  if (!value || value.startsWith(`..${sep}`) || value === '..' || resolve(root, value) !== resolve(path)) {
    throw new Error(`Codex 文件不在受管目录中：${basename(path)}`)
  }
  return value
}

function assertProvider(value: string): string {
  const provider = typeof value === 'string' ? value.trim() : ''
  if (!PROVIDER_PATTERN.test(provider)) throw new Error('Provider ID 只能包含字母、数字、点、下划线和连字符。')
  return provider
}


function timestampName(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

function sha256(value: string | Uint8Array): string {
  const hash = createHash('sha256')
  if (typeof value === 'string') hash.update(value, 'utf8')
  else hash.update(value)
  return hash.digest('hex')
}

function isLockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
