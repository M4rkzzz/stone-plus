import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CodexSessionIndexCleanupCandidate,
  CodexSessionIndexCleanupPreview,
  CodexSessionIndexCleanupResult,
} from '@shared/types'
import { atomicWriteFile } from '../client-config/filesystem'
import { acquireCodexSessionMaintenanceLock } from './session-maintenance-lock'
import { findBlockingWindowsCodexPids } from './windows-codex-processes'

const SESSION_INDEX_FILE = 'session_index.jsonl'
const BACKUP_MARKER = 'Stone+ session index cleanup'
const BACKUP_KEEP_COUNT = 5
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const ROLLOUT_SCAN_BYTES = 1024 * 1024
const THREAD_REFERENCE_COLUMNS = [
  ['threads', 'id'],
  ['local_thread_catalog', 'thread_id'],
  ['automation_runs', 'thread_id'],
  ['inbox_items', 'thread_id'],
  ['sessions', 'id'],
  ['messages', 'session_id'],
  ['thread_dynamic_tools', 'thread_id'],
  ['thread_goals', 'thread_id'],
  ['thread_spawn_edges', 'parent_thread_id'],
  ['thread_spawn_edges', 'child_thread_id'],
  ['stage1_outputs', 'thread_id'],
  ['agent_job_items', 'assigned_thread_id'],
] as const

interface SessionIndexCleanupServiceOptions {
  codexHome: string
  now?: () => Date
  randomId?: () => string
  blockingCodexPids?: () => Promise<number[]>
  /** Bounds rollout file IO without changing the conservative classification rules. */
  scanConcurrency?: number
  maxRolloutFiles?: number
  maxReferenceDatabases?: number
}

export interface SessionIndexCleanupScanProgress {
  phase: 'rollouts' | 'databases'
  completed: number
  total: number
}

export interface SessionIndexCleanupScanOptions {
  signal?: AbortSignal
  onProgress?: (progress: SessionIndexCleanupScanProgress) => void
}

interface SessionIndexPlan {
  path: string
  originalBytes: Buffer
  originalText: string
  snapshotSha256: string
  candidates: CodexSessionIndexCleanupCandidate[]
}

export class CodexSessionIndexCleanupService {
  private readonly codexHome: string
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly blockingCodexPids: () => Promise<number[]>
  private readonly scanConcurrency: number
  private readonly maxRolloutFiles: number
  private readonly maxReferenceDatabases: number
  private active = false

  constructor(options: SessionIndexCleanupServiceOptions) {
    this.codexHome = resolve(options.codexHome)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? (() => randomUUID().slice(0, 12))
    this.blockingCodexPids = options.blockingCodexPids ?? findBlockingWindowsCodexPids
    this.scanConcurrency = positiveInteger(options.scanConcurrency, 8, 'scanConcurrency')
    this.maxRolloutFiles = positiveInteger(options.maxRolloutFiles, 100_000, 'maxRolloutFiles')
    this.maxReferenceDatabases = positiveInteger(options.maxReferenceDatabases, 256, 'maxReferenceDatabases')
  }

  async preview(options: SessionIndexCleanupScanOptions = {}): Promise<CodexSessionIndexCleanupPreview> {
    const plan = await this.buildPlan(options)
    return plan
      ? { snapshotSha256: plan.snapshotSha256, candidates: plan.candidates }
      : { snapshotSha256: sha256(Buffer.alloc(0)), candidates: [] }
  }

  /** The caller must close Codex first; this method independently verifies that boundary twice. */
  async apply(
    expectedSnapshotSha256: string,
    confirmedThreadIds: string[],
    options: SessionIndexCleanupScanOptions = {},
  ): Promise<CodexSessionIndexCleanupResult> {
    if (!/^[a-f0-9]{64}$/.test(expectedSnapshotSha256)) {
      throw new Error('幽灵索引清理预览无效，请重新扫描。')
    }
    if (!Array.isArray(confirmedThreadIds) || confirmedThreadIds.some((id) => typeof id !== 'string')) {
      throw new Error('幽灵索引确认列表无效，请重新扫描。')
    }
    throwIfAborted(options.signal)
    if (this.active) throw new Error('已有会话维护正在运行。')
    this.active = true
    let releaseLock: (() => Promise<void>) | undefined
    try {
      await this.assertDesktopStopped()
      releaseLock = await acquireCodexSessionMaintenanceLock(this.codexHome, 'session-index-cleanup', this.now(), this.randomId())
      const plan = await this.buildPlan(options)
      if (!plan) throw new Error(`${SESSION_INDEX_FILE} 不存在，无法清理。`)
      if (plan.snapshotSha256 !== expectedSnapshotSha256) {
        throw new Error(`${SESSION_INDEX_FILE} 已在预览后发生变化；为避免覆盖 Codex 新内容，本次清理已中止，请重新扫描。`)
      }
      const candidateIds = new Set(plan.candidates.map((candidate) => candidate.id))
      const selectedIds = new Set(confirmedThreadIds.map((id) => id.trim()).filter(Boolean))
      if ([...selectedIds].some((id) => !candidateIds.has(id))) {
        throw new Error('确认列表已过期或包含非候选任务；本次清理未执行，请重新扫描。')
      }
      const filtered = filterSessionIndex(plan.originalText, selectedIds)
      if (!filtered.removedEntries) return { prunedEntries: 0 }
      throwIfAborted(options.signal)

      const backupPath = await this.createBackup(plan, filtered.removedEntries, [...selectedIds])
      let currentBytes: Buffer
      try {
        currentBytes = await readFile(plan.path)
      } catch (error) {
        throw new Error(`无法在写入前复核 ${SESSION_INDEX_FILE}；备份保留在：${backupPath}；${messageOf(error)}`)
      }
      if (!currentBytes.equals(plan.originalBytes)) {
        throw new Error(`${SESSION_INDEX_FILE} 在备份后再次发生变化；未覆盖 Codex 新内容，备份保留在：${backupPath}。请重新扫描。`)
      }
      try {
        await this.assertDesktopStopped()
      } catch (error) {
        throw new Error(`${messageOf(error)}；备份保留在：${backupPath}`)
      }
      try {
        currentBytes = await readFile(plan.path)
      } catch (error) {
        throw new Error(`无法在最终写入前复核 ${SESSION_INDEX_FILE}；备份保留在：${backupPath}；${messageOf(error)}`)
      }
      if (!currentBytes.equals(plan.originalBytes)) {
        throw new Error(`${SESSION_INDEX_FILE} 在最终写入前发生变化；未覆盖 Codex 新内容，备份保留在：${backupPath}。请重新扫描。`)
      }
      try {
        await atomicWriteFile(plan.path, Buffer.from(filtered.nextText, 'utf8'), this.randomId)
      } catch (error) {
        throw new Error(`原子写入 ${SESSION_INDEX_FILE} 失败；原文件未被主动覆盖，备份保留在：${backupPath}；${messageOf(error)}`)
      }
      let retentionWarning: string | undefined
      try {
        await pruneCleanupBackups(backupPath)
      } catch (error) {
        retentionWarning = `索引已清理，但旧备份清理失败：${messageOf(error)}`
      }
      return {
        prunedEntries: filtered.removedEntries,
        backupPath,
        ...(retentionWarning ? { retentionWarning } : {}),
      }
    } finally {
      await releaseLock?.().catch(() => undefined)
      this.active = false
    }
  }

  private async assertDesktopStopped(): Promise<void> {
    const pids = [...new Set(await this.blockingCodexPids())].filter((pid) => Number.isInteger(pid) && pid > 0)
    if (pids.length) {
      throw new Error(`Codex App / ChatGPT 仍在运行（进程：${pids.join(', ')}），为保护任务索引，本次清理已中止。`)
    }
  }

  private async buildPlan(options: SessionIndexCleanupScanOptions): Promise<SessionIndexPlan | undefined> {
    throwIfAborted(options.signal)
    const liveThreadIds = await this.collectLiveThreadIds(options)
    const path = join(this.codexHome, SESSION_INDEX_FILE)
    let originalBytes: Buffer
    try {
      originalBytes = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(`无法读取 ${SESSION_INDEX_FILE}：${messageOf(error)}`)
    }
    throwIfAborted(options.signal)
    const originalText = decodeUtf8(originalBytes, SESSION_INDEX_FILE)
    const candidatesById = new Map<string, CodexSessionIndexCleanupCandidate>()
    forEachLine(originalText, (line) => {
      const candidate = knownSessionIndexCandidate(line)
      if (candidate && !liveThreadIds.has(candidate.id) && !candidatesById.has(candidate.id)) {
        candidatesById.set(candidate.id, candidate)
      }
    })
    return {
      path,
      originalBytes,
      originalText,
      snapshotSha256: sha256(originalBytes),
      candidates: [...candidatesById.values()],
    }
  }

  private async collectLiveThreadIds(options: SessionIndexCleanupScanOptions): Promise<Set<string>> {
    const ids = new Set<string>()
    const rolloutFiles = await this.findRolloutFiles(options.signal)
    options.onProgress?.({ phase: 'rollouts', completed: 0, total: rolloutFiles.length })
    await mapConcurrent(rolloutFiles, this.scanConcurrency, async (path) => {
      throwIfAborted(options.signal)
      const filenameId = rolloutThreadIdFromFilename(path)
      if (filenameId) ids.add(filenameId)
      let prefix: { text: string; truncated: boolean }
      try {
        prefix = await readRolloutPrefix(path)
      } catch (error) {
        if (filenameId && isLockedError(error)) return
        throw new Error(`无法扫描会话来源 ${path}：${messageOf(error)}`)
      }
      let contentIdFound = false
      forEachLine(prefix.text, (line) => {
        if (!line.includes('"session_meta"')) return
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record.type !== 'session_meta' || !isRecord(record.payload)) return
          const id = typeof record.payload.id === 'string' ? record.payload.id.trim() : ''
          if (id) {
            ids.add(id)
            contentIdFound = true
          }
        } catch {
          // A valid UUID suffix above still protects corrupt or future-format rollouts.
        }
      })
      if (!filenameId && prefix.truncated && !contentIdFound) {
        throw new Error(`非标准会话文件的 session_meta 未出现在前 ${ROLLOUT_SCAN_BYTES} 字节内，无法安全判断索引来源：${path}`)
      }
    }, (completed) => options.onProgress?.({ phase: 'rollouts', completed, total: rolloutFiles.length }), options.signal)

    const databases = await this.findThreadReferenceDatabases(options.signal)
    options.onProgress?.({ phase: 'databases', completed: 0, total: databases.length })
    let completedDatabases = 0
    for (const path of databases) {
      throwIfAborted(options.signal)
      let database: DatabaseSync
      try {
        database = new DatabaseSync(path, { readOnly: true })
      } catch (error) {
        throw new Error(`无法验证线程引用数据库 ${path}：${messageOf(error)}`)
      }
      try {
        const columnsByTable = new Map<string, Set<string>>()
        for (const [table, column] of THREAD_REFERENCE_COLUMNS) {
          let columns = columnsByTable.get(table)
          if (!columns) {
            columns = tableColumns(database, table)
            columnsByTable.set(table, columns)
          }
          if (!columns.has(column)) continue
          const rows = database.prepare(`SELECT DISTINCT ${column} AS thread_id FROM ${table} WHERE COALESCE(${column}, '') <> ''`).all() as Array<Record<string, unknown>>
          for (const row of rows) if (typeof row.thread_id === 'string' && row.thread_id.trim()) ids.add(row.thread_id.trim())
        }
      } finally {
        database.close()
      }
      completedDatabases += 1
      options.onProgress?.({ phase: 'databases', completed: completedDatabases, total: databases.length })
    }
    return ids
  }

  private async findRolloutFiles(signal?: AbortSignal): Promise<string[]> {
    const files: string[] = []
    for (const directory of ['sessions', 'archived_sessions']) {
      await collectFiles(
        join(this.codexHome, directory), files,
        (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
        this.maxRolloutFiles, signal,
      )
    }
    return files.sort()
  }

  private async findThreadReferenceDatabases(signal?: AbortSignal): Promise<string[]> {
    const candidates = new Set<string>()
    for (const directory of [this.codexHome, join(this.codexHome, 'sqlite')]) {
      throwIfAborted(signal)
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && SQLITE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            candidates.add(join(directory, entry.name))
            if (candidates.size > this.maxReferenceDatabases) {
              throw new Error(`线程引用数据库数量超过安全扫描上限（${this.maxReferenceDatabases}）；未执行清理。`)
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return [...candidates].sort()
  }

  private async createBackup(plan: SessionIndexPlan, removedEntries: number, selectedThreadIds: string[]): Promise<string> {
    const root = join(this.codexHome, 'backups_state', 'stone-session-index-cleanup')
    const backupPath = join(root, `${timestampName(this.now())}-${this.randomId()}`)
    await mkdir(root, { recursive: true })
    await mkdir(backupPath, { recursive: false })
    await writeFile(join(backupPath, SESSION_INDEX_FILE), plan.originalBytes, { mode: 0o600 })
    await writeFile(join(backupPath, 'metadata.json'), JSON.stringify({
      version: 1,
      managedBy: BACKUP_MARKER,
      createdAt: this.now().toISOString(),
      codexHome: this.codexHome,
      snapshotSha256: plan.snapshotSha256,
      prunedSessionIndexEntries: removedEntries,
      selectedThreadIds,
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
    return backupPath
  }
}

function knownSessionIndexCandidate(line: string): CodexSessionIndexCleanupCandidate | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 'thread_name' || keys[2] !== 'updated_at') return undefined
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const threadName = typeof value.thread_name === 'string' ? value.thread_name : undefined
  const updatedAt = typeof value.updated_at === 'string' ? value.updated_at.trim() : ''
  if (!id || threadName === undefined || !updatedAt) return undefined
  return { id, threadName, updatedAt }
}

function filterSessionIndex(text: string, selectedIds: Set<string>): { nextText: string; removedEntries: number } {
  let nextText = ''
  let removedEntries = 0
  forEachLine(text, (line, ending) => {
    const candidate = knownSessionIndexCandidate(line)
    if (candidate && selectedIds.has(candidate.id)) removedEntries += 1
    else nextText += line + ending
  })
  return { nextText, removedEntries }
}

function forEachLine(text: string, visit: (line: string, ending: string) => void): void {
  let offset = 0
  while (offset < text.length) {
    const newlineAt = text.indexOf('\n', offset)
    const end = newlineAt >= 0 ? newlineAt + 1 : text.length
    const segment = text.slice(offset, end)
    const ending = segment.endsWith('\r\n') ? '\r\n' : segment.endsWith('\n') ? '\n' : ''
    visit(ending ? segment.slice(0, -ending.length) : segment, ending)
    offset = end
  }
}

function rolloutThreadIdFromFilename(path: string): string | undefined {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match?.[1]
}

async function readRolloutPrefix(path: string): Promise<{ text: string; truncated: boolean }> {
  const info = await stat(path)
  const length = Math.min(info.size, ROLLOUT_SCAN_BYTES)
  const handle = await open(path, 'r')
  try {
    const prefix = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(prefix, 0, length, 0)
    return {
      text: prefix.subarray(0, bytesRead).toString('utf8'),
      truncated: info.size > bytesRead,
    }
  } finally {
    await handle.close()
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
}

async function collectFiles(
  root: string,
  files: string[],
  accepts: (name: string) => boolean,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    throwIfAborted(signal)
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectFiles(path, files, accepts, maxFiles, signal)
    else if (entry.isFile() && accepts(entry.name)) {
      files.push(path)
      if (files.length > maxFiles) {
        throw new Error(`会话文件数量超过安全扫描上限（${maxFiles}）；未执行清理。`)
      }
    }
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
  onCompleted: (completed: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let nextIndex = 0
  let completed = 0
  let hasFailure = false
  let failure: unknown
  const worker = async (): Promise<void> => {
    try {
      while (!hasFailure) {
        throwIfAborted(signal)
        const index = nextIndex
        nextIndex += 1
        if (index >= values.length) return
        await visit(values[index])
        completed += 1
        onCompleted(completed)
      }
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  if (hasFailure) throw failure
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new Error('会话索引扫描已取消。')
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${name} 必须是正整数。`)
  return resolved
}

async function pruneCleanupBackups(preservePath: string): Promise<void> {
  const root = dirname(preservePath)
  const managed: Array<{ path: string; createdAt: number }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    try {
      const metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8')) as Record<string, unknown>
      if (metadata.managedBy !== BACKUP_MARKER) continue
      managed.push({ path, createdAt: Date.parse(String(metadata.createdAt)) || 0 })
    } catch { /* Foreign and incomplete backup directories are preserved. */ }
  }
  managed.sort((left, right) => (
    left.path === preservePath ? -1
      : right.path === preservePath ? 1
        : right.createdAt - left.createdAt || right.path.localeCompare(left.path)
  ))
  for (const item of managed.slice(BACKUP_KEEP_COUNT)) await rm(item.path, { recursive: true, force: true })
}

function decodeUtf8(value: Uint8Array, name: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch {
    throw new Error(`${name} 不是有效的 UTF-8 文件。`)
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestampName(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
