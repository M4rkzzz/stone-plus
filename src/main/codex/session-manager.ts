import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodexManagedSession, CodexSessionKind, CodexSessionQuery } from '@shared/types'
import { acquireCodexSessionMaintenanceLock } from './session-maintenance-lock'
import { findBlockingWindowsCodexPids } from './windows-codex-processes'

const ROLLOUT_PATTERN = /^rollout-.*\.jsonl$/i
const TRASH_DIRECTORY = 'trash_sessions'

interface SessionManagerOptions {
  codexHome: string
  now?: () => number
  blockingCodexPids?: () => Promise<number[]>
}

interface ParsedRollout {
  contentSha256: string
  id?: string
  cwd?: string
  modelProvider?: string
  title?: string
  createdAt?: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

interface CachedSession {
  mtimeMs: number
  size: number
  kind: CodexSessionKind
  session: CodexManagedSession
}

interface TrashManifest {
  version: 1
  stage: 'prepared' | 'complete' | 'restoring' | 'rollback-pending'
  sessionId: string
  originalRelativePath: string
  databaseRows: Array<{
    databasePath: string
    rolloutPath: string
    archived?: number | null
    archivedAt?: number | null
  }>
}

export class CodexSessionManager {
  private readonly codexHome: string
  private readonly now: () => number
  private readonly blockingCodexPids: () => Promise<number[]>
  private readonly catalog = new Map<string, CachedSession>()
  private catalogRefresh?: Promise<void>
  private trashRecoveryChecked = false
  private titleIndexCache?: { mtimeMs: number; size: number; values: Map<string, string> }

  public constructor(options: SessionManagerOptions) {
    this.codexHome = resolve(options.codexHome)
    this.now = options.now ?? (() => Date.now())
    this.blockingCodexPids = options.blockingCodexPids ?? findBlockingWindowsCodexPids
  }

  public async list(query: CodexSessionQuery = {}): Promise<CodexManagedSession[]> {
    await this.refreshCatalog()
    const sessions = [...this.catalog.values()].map((entry) => entry.session)
    const search = query.search?.trim().toLocaleLowerCase()
    return sessions
      .filter((session) => !query.kind || query.kind === 'all' || session.kind === query.kind)
      .filter((session) => !search || [session.id, session.title, session.cwd, session.modelProvider]
        .some((value) => value?.toLocaleLowerCase().includes(search)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, boundedLimit(query.limit))
  }

  public async pathFor(id: string, expectedRevision: string): Promise<string> {
    const session = await this.requiredSession(id, expectedRevision)
    await this.assertSessionRevision(session, expectedRevision)
    return this.absoluteFromRelative(session.relativePath)
  }

  public async export(id: string, expectedRevision: string, destinationPath: string): Promise<void> {
    const session = await this.requiredSession(id, expectedRevision)
    const source = this.absoluteFromRelative(session.relativePath)
    await this.assertSessionRevision(session, expectedRevision)
    const destination = resolve(destinationPath)
    if (source === destination) throw new Error('Choose a different export destination.')
    if (this.isManagedPath(destination)) throw new Error('Export Codex sessions outside the managed session directories.')
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await copyFile(source, temporary)
        const after = await stat(source)
        const [sourceHash, copiedHash] = await Promise.all([sha256File(source), sha256File(temporary)])
        const currentRevision = sessionRevision(session.id, session.relativePath, session.kind, Number(after.size), sourceHash)
        if (currentRevision === expectedRevision && copiedHash === sourceHash) {
          await rename(temporary, destination)
          return
        }
        await rm(temporary, { force: true })
      }
      throw new Error('The Codex session changed while it was being exported. Try again.')
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  public async trash(id: string, expectedRevision: string): Promise<CodexManagedSession[]> {
    return this.move(id, expectedRevision, true)
  }

  public async restore(id: string, expectedRevision: string): Promise<CodexManagedSession[]> {
    return this.move(id, expectedRevision, false)
  }

  private async move(id: string, expectedRevision: string, toTrash: boolean): Promise<CodexManagedSession[]> {
    const blockers = await this.blockingCodexPids()
    if (blockers.length) throw new Error('Close Codex before moving or restoring a session.')
    const session = await this.requiredSession(id, expectedRevision)
    if (toTrash && session.kind === 'trash') return this.list({ limit: 10_000 })
    if (!toTrash && session.kind !== 'trash') return this.list({ limit: 10_000 })
    const source = this.absoluteFromRelative(session.relativePath)
    const relativeDestination = toTrash
      ? join(TRASH_DIRECTORY, session.relativePath)
      : session.relativePath.slice(`${TRASH_DIRECTORY}${sep}`.length)
    const destination = this.absoluteFromRelative(relativeDestination)
    const trashPath = toTrash ? destination : source
    const manifestPath = `${trashPath}.stone-trash.json`
    let manifest: TrashManifest
    let release: (() => Promise<void>) | undefined
    try {
      release = await acquireCodexSessionMaintenanceLock(
        this.codexHome,
        toTrash ? 'session-trash' : 'session-restore',
        new Date(this.now()),
        randomUUID()
      )
      if ((await this.blockingCodexPids()).length) throw new Error('Close Codex before moving or restoring a session.')
      // The lookup happened before acquiring the cross-process maintenance
      // lock. Revalidate the renderer-reviewed file after the lock boundary so
      // an older catalog generation can never move a replacement rollout.
      await this.assertSessionRevision(session, expectedRevision)
      manifest = toTrash
        ? await this.createTrashManifest(id, session.relativePath)
        : await this.readTrashManifest(manifestPath, id)
      if (await fileExists(destination)) throw new Error('The destination session file already exists.')
      await mkdir(dirname(destination), { recursive: true })
      if (toTrash) {
        await writeTrashManifest(manifestPath, manifest)
      } else {
        manifest = { ...manifest, stage: 'restoring' }
        await writeTrashManifest(manifestPath, manifest)
      }
      try {
        await rename(source, destination)
      } catch (error) {
        if (toTrash) await rm(manifestPath, { force: true }).catch(() => undefined)
        else await writeTrashManifest(manifestPath, { ...manifest, stage: 'complete' }).catch(() => undefined)
        throw error
      }
      try {
        await this.updateThreadRows(id, toTrash ? destination : source, toTrash, manifest)
        if (toTrash) {
          manifest = { ...manifest, stage: 'complete' }
          await writeTrashManifest(manifestPath, manifest)
        }
        else await rm(manifestPath, { force: true }).catch(() => undefined)
      } catch (error) {
        const rollbackFailures: string[] = []
        try { await rename(destination, source) } catch (rollbackError) { rollbackFailures.push(errorMessage(rollbackError)) }
        if (toTrash) {
          try { await this.restoreThreadRows(id, manifest, destination) } catch (rollbackError) { rollbackFailures.push(errorMessage(rollbackError)) }
          if (rollbackFailures.length) {
            manifest = { ...manifest, stage: 'rollback-pending' }
            await writeTrashManifest(manifestPath, manifest).catch(() => undefined)
          } else {
            await rm(manifestPath, { force: true }).catch(() => undefined)
          }
        } else {
          try { await this.updateThreadRows(id, source, true, manifest) } catch (rollbackError) { rollbackFailures.push(errorMessage(rollbackError)) }
          if (rollbackFailures.length) await writeTrashManifest(manifestPath, { ...manifest, stage: 'restoring' }).catch(() => undefined)
          else await writeTrashManifest(manifestPath, { ...manifest, stage: 'complete' }).catch(() => undefined)
        }
        const suffix = rollbackFailures.length
          ? ` Session rollback is pending: ${rollbackFailures.join('; ')}`
          : ''
        throw new Error(`${errorMessage(error)}${suffix}`)
      }
    } finally {
      await release?.()
    }
    await this.refreshCatalog()
    return this.list({ limit: 10_000 })
  }

  private async refreshCatalog(): Promise<void> {
    if (this.catalogRefresh) return this.catalogRefresh
    const flight = this.runCatalogRefresh().finally(() => {
      if (this.catalogRefresh === flight) this.catalogRefresh = undefined
    })
    this.catalogRefresh = flight
    return flight
  }

  private async runCatalogRefresh(): Promise<void> {
    if (!this.trashRecoveryChecked) {
      if ((await this.blockingCodexPids()).length === 0) {
        await this.recoverTrashManifests()
        this.trashRecoveryChecked = true
      }
    }
    const titleIndex = await this.readTitleIndex()
    const paths = await this.findRollouts()
    const present = new Set(paths.map((entry) => entry.path))
    for (const path of this.catalog.keys()) if (!present.has(path)) this.catalog.delete(path)
    const queue = [...paths]
    const workers = Array.from({ length: Math.min(8, Math.max(1, queue.length)) }, async () => {
      while (queue.length) {
        const entry = queue.shift()
        if (!entry) return
        try {
          const info = await stat(entry.path)
          const cached = this.catalog.get(entry.path)
          if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.kind === entry.kind) {
            const indexedTitle = titleIndex.get(cached.session.id)
            if (indexedTitle && indexedTitle !== cached.session.title) {
              this.catalog.set(entry.path, { ...cached, session: { ...cached.session, title: indexedTitle } })
            }
            continue
          }
          const session = await this.describe(entry.path, entry.kind, titleIndex, info)
          this.catalog.set(entry.path, { mtimeMs: info.mtimeMs, size: info.size, kind: entry.kind, session })
        } catch {
          this.catalog.delete(entry.path)
        }
      }
    })
    await Promise.all(workers)
  }

  private async describe(
    path: string,
    kind: CodexSessionKind,
    titleIndex: ReadonlyMap<string, string>,
    knownInfo?: Awaited<ReturnType<typeof stat>>
  ): Promise<CodexManagedSession> {
    const info = knownInfo ?? await stat(path)
    const parsed = await parseRollout(path)
    const id = parsed.id ?? rolloutIdFromFilename(path) ?? basename(path)
    const title = titleIndex.get(id) ?? parsed.title ?? id
    return {
      id,
      revision: sessionRevision(id, relative(this.codexHome, path), kind, Number(info.size), parsed.contentSha256),
      title,
      kind,
      relativePath: relative(this.codexHome, path),
      cwd: parsed.cwd,
      modelProvider: parsed.modelProvider,
      createdAt: parsed.createdAt,
      updatedAt: Number(info.mtimeMs),
      sizeBytes: Number(info.size),
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cachedInputTokens: parsed.cachedInputTokens,
      reasoningTokens: parsed.reasoningTokens,
      totalTokens: parsed.totalTokens || parsed.inputTokens + parsed.outputTokens
    }
  }

  private async requiredSession(id: string, expectedRevision: string): Promise<CodexManagedSession> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Codex session id is invalid.')
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new Error('Codex session revision is invalid. Refresh the session list.')
    }
    await this.refreshCatalog()
    const matches = [...this.catalog.values()].map((entry) => entry.session).filter((session) => session.id === id)
    if (matches.length === 0) throw new Error('Codex session not found.')
    if (matches.length > 1) throw new Error('Multiple Codex session files use the same id.')
    if (matches[0].revision !== expectedRevision) {
      throw new Error('The Codex session changed after it was listed. Refresh and try again.')
    }
    return matches[0]
  }

  private async assertSessionRevision(session: CodexManagedSession, expectedRevision: string): Promise<void> {
    const path = this.absoluteFromRelative(session.relativePath)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error('The Codex session changed after it was listed. Refresh and try again.')
    }
    const hash = await sha256File(path)
    if (sessionRevision(session.id, session.relativePath, session.kind, Number(info.size), hash) !== expectedRevision) {
      throw new Error('The Codex session changed after it was listed. Refresh and try again.')
    }
  }

  private async findRollouts(): Promise<Array<{ path: string; kind: CodexSessionKind }>> {
    const output: Array<{ path: string; kind: CodexSessionKind }> = []
    await collectRollouts(join(this.codexHome, 'sessions'), 'active', output)
    await collectRollouts(join(this.codexHome, 'archived_sessions'), 'archived', output)
    await collectRollouts(join(this.codexHome, TRASH_DIRECTORY), 'trash', output)
    return output
  }

  private async readTitleIndex(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const path = join(this.codexHome, 'session_index.jsonl')
    if (!await fileExists(path)) return result
    const info = await stat(path)
    if (this.titleIndexCache
      && this.titleIndexCache.mtimeMs === Number(info.mtimeMs)
      && this.titleIndexCache.size === Number(info.size)) return new Map(this.titleIndexCache.values)
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        const id = text(record.id) ?? text(record.thread_id)
        const title = text(record.thread_name) ?? text(record.title)
        if (id && title) result.set(id, title)
      } catch { /* Skip corrupt index lines without hiding valid rollouts. */ }
    }
    this.titleIndexCache = { mtimeMs: Number(info.mtimeMs), size: Number(info.size), values: new Map(result) }
    return result
  }

  private absoluteFromRelative(relativePath: string): string {
    const path = resolve(this.codexHome, relativePath)
    if (path !== this.codexHome && !path.startsWith(`${this.codexHome}${sep}`)) {
      throw new Error('Session path escapes the Codex home directory.')
    }
    return path
  }

  private isManagedPath(path: string): boolean {
    return ['sessions', 'archived_sessions', TRASH_DIRECTORY].some((directory) => {
      const root = resolve(this.codexHome, directory)
      return path === root || path.startsWith(`${root}${sep}`)
    })
  }

  private async createTrashManifest(id: string, originalRelativePath: string): Promise<TrashManifest> {
    const databaseRows: TrashManifest['databaseRows'] = []
    for (const databasePath of await this.sessionDatabases()) {
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const columns = tableColumns(database, 'threads')
        if (!columns.has('id') || !columns.has('rollout_path')) continue
        const row = database.prepare(`SELECT rollout_path,
          ${columns.has('archived') ? 'archived' : 'NULL'} AS archived,
          ${columns.has('archived_at') ? 'archived_at' : 'NULL'} AS archived_at
          FROM threads WHERE id = ?`).get(id) as Record<string, unknown> | undefined
        if (!row || typeof row.rollout_path !== 'string') continue
        databaseRows.push({
          databasePath,
          rolloutPath: row.rollout_path,
          archived: typeof row.archived === 'number' || typeof row.archived === 'bigint' ? Number(row.archived) : null,
          archivedAt: typeof row.archived_at === 'number' || typeof row.archived_at === 'bigint' ? Number(row.archived_at) : null
        })
      } finally {
        database.close()
      }
    }
    return { version: 1, stage: 'prepared', sessionId: id, originalRelativePath, databaseRows }
  }

  private async readTrashManifest(path: string, id: string): Promise<TrashManifest> {
    let value: unknown
    try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('The session trash manifest is missing or invalid.') }
    return this.validateTrashManifest(value, path, id)
  }

  private validateTrashManifest(value: unknown, manifestPath: string, expectedId?: string): TrashManifest {
    if (!value || typeof value !== 'object') throw new Error('The session trash manifest is invalid.')
    const manifest = value as TrashManifest
    if (manifest.version !== 1
      || typeof manifest.sessionId !== 'string' || !manifest.sessionId.trim()
      || (expectedId !== undefined && manifest.sessionId !== expectedId)
      || !['prepared', 'complete', 'restoring', 'rollback-pending'].includes(manifest.stage)
      || typeof manifest.originalRelativePath !== 'string'
      || !Array.isArray(manifest.databaseRows)) {
      throw new Error('The session trash manifest does not match this session.')
    }
    const originalPath = this.absoluteFromRelative(manifest.originalRelativePath)
    const sourceRoots = ['sessions', 'archived_sessions'].map((directory) => resolve(this.codexHome, directory))
    if (!sourceRoots.some((root) => originalPath.startsWith(`${root}${sep}`))
      || !ROLLOUT_PATTERN.test(basename(originalPath))) {
      throw new Error('The session trash manifest contains an unmanaged rollout path.')
    }
    const expectedManifestPath = `${resolve(this.codexHome, TRASH_DIRECTORY, manifest.originalRelativePath)}.stone-trash.json`
    if (resolve(manifestPath) !== expectedManifestPath) {
      throw new Error('The session trash manifest is not bound to this rollout.')
    }
    for (const row of manifest.databaseRows) {
      if (!row || typeof row !== 'object'
        || typeof row.databasePath !== 'string' || !this.isManagedDatabasePath(row.databasePath)
        || typeof row.rolloutPath !== 'string'
        || (row.archived !== undefined && row.archived !== null && !Number.isFinite(row.archived))
        || (row.archivedAt !== undefined && row.archivedAt !== null && !Number.isFinite(row.archivedAt))) {
        throw new Error('The session trash manifest contains an unmanaged database row.')
      }
    }
    return manifest
  }

  private isManagedDatabasePath(path: string): boolean {
    const candidate = resolve(path)
    if (candidate === resolve(this.codexHome, 'state_5.sqlite')) return true
    const sqliteRoot = resolve(this.codexHome, 'sqlite')
    return candidate.startsWith(`${sqliteRoot}${sep}`) && /\.(?:db|sqlite|sqlite3)$/i.test(candidate)
  }

  private async updateThreadRows(
    id: string,
    rolloutPath: string,
    toTrash: boolean,
    manifest: TrashManifest
  ): Promise<void> {
    const applied: TrashManifest['databaseRows'] = []
    try {
      for (const row of manifest.databaseRows) {
        const current = readThreadRow(row.databasePath, id)
        if (!current) throw new Error('The Codex thread database changed during session maintenance.')
        const target = toTrash
          ? { rolloutPath, archived: 1, archivedAt: Math.floor(this.now() / 1_000) }
          : { rolloutPath: row.rolloutPath, archived: row.archived ?? 0, archivedAt: row.archivedAt ?? null }
        if (threadRowAtTarget(current, target, toTrash)) continue
        const expectedPath = toTrash ? row.rolloutPath : rolloutPath
        if (current.rolloutPath !== expectedPath) {
          throw new Error('The Codex thread database changed during session maintenance.')
        }
        writeThreadRow(row.databasePath, id, target)
        applied.push({ databasePath: row.databasePath, ...current })
      }
    } catch (error) {
      for (const row of applied.reverse()) {
        try { writeThreadRow(row.databasePath, id, row) } catch { /* Preserve the original failure. */ }
      }
      throw error
    }
  }

  private restoreThreadRows(id: string, manifest: TrashManifest, trashRolloutPath: string): Promise<void> {
    return this.updateThreadRows(id, trashRolloutPath, false, manifest).then(() => undefined)
  }

  private async sessionDatabases(): Promise<string[]> {
    const candidates = [join(this.codexHome, 'state_5.sqlite')]
    for (const entry of await readdir(join(this.codexHome, 'sqlite'), { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /\.(?:db|sqlite|sqlite3)$/i.test(entry.name)) candidates.push(join(this.codexHome, 'sqlite', entry.name))
    }
    const output: string[] = []
    for (const path of candidates) {
      if (!await fileExists(path)) continue
      try {
        const database = new DatabaseSync(path, { readOnly: true })
        const columns = tableColumns(database, 'threads')
        database.close()
        if (columns.has('id') && columns.has('rollout_path')) output.push(path)
      } catch { /* Ignore unrelated SQLite files. */ }
    }
    return output
  }

  private async recoverTrashManifests(): Promise<void> {
    const paths: string[] = []
    await collectFiles(join(this.codexHome, TRASH_DIRECTORY), paths, (name) => name.endsWith('.stone-trash.json'))
    if (!paths.length) return
    const release = await acquireCodexSessionMaintenanceLock(
      this.codexHome, 'session-trash-recovery', new Date(this.now()), randomUUID()
    )
    try {
      for (const manifestPath of paths) {
        let manifest: TrashManifest
        try {
          manifest = this.validateTrashManifest(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath)
        } catch { continue }
        const trashPath = manifestPath.slice(0, -'.stone-trash.json'.length)
        const originalPath = this.absoluteFromRelative(manifest.originalRelativePath)
        const trashExists = await fileExists(trashPath)
        const originalExists = await fileExists(originalPath)
        if (manifest.stage === 'rollback-pending') {
          if (trashExists === originalExists) continue
          if (trashExists) {
            await mkdir(dirname(originalPath), { recursive: true })
            await rename(trashPath, originalPath)
          }
          await this.restoreThreadRows(manifest.sessionId, manifest, trashPath)
          if (await this.threadRowsMatch(manifest.sessionId, manifest, false, trashPath)) {
            await rm(manifestPath, { force: true })
          }
        } else if (manifest.stage === 'prepared') {
          if (trashExists && !originalExists) {
            await this.updateThreadRows(manifest.sessionId, trashPath, true, manifest)
            await writeTrashManifest(manifestPath, { ...manifest, stage: 'complete' })
          } else if (originalExists && !trashExists) {
            await this.restoreThreadRows(manifest.sessionId, manifest, trashPath)
            if (await this.threadRowsMatch(manifest.sessionId, manifest, false, trashPath)) {
              await rm(manifestPath, { force: true })
            }
          }
        } else if (manifest.stage === 'restoring') {
          if (originalExists && !trashExists) {
            await this.updateThreadRows(manifest.sessionId, originalPath, false, manifest)
            if (await this.threadRowsMatch(manifest.sessionId, manifest, false, trashPath)) {
              await rm(manifestPath, { force: true })
            }
          } else if (trashExists && !originalExists) {
            await this.updateThreadRows(manifest.sessionId, trashPath, true, manifest)
            await writeTrashManifest(manifestPath, { ...manifest, stage: 'complete' })
          }
        }
      }
    } finally {
      await release()
    }
  }

  private async threadRowsMatch(
    id: string,
    manifest: TrashManifest,
    toTrash: boolean,
    trashRolloutPath: string
  ): Promise<boolean> {
    for (const row of manifest.databaseRows) {
      const current = readThreadRow(row.databasePath, id)
      if (!current) return false
      const expected = toTrash
        ? { rolloutPath: trashRolloutPath, archived: 1, archivedAt: current.archivedAt }
        : { rolloutPath: row.rolloutPath, archived: row.archived ?? 0, archivedAt: row.archivedAt ?? null }
      if (!threadRowAtTarget(current, expected, toTrash)) return false
    }
    return true
  }
}

async function parseRollout(path: string): Promise<ParsedRollout> {
  const hash = createHash('sha256')
  const parsed: ParsedRollout = {
    contentSha256: '',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  }
  const input = createReadStream(path)
  input.on('data', (chunk: string | Buffer) => hash.update(chunk))
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    let record: Record<string, unknown>
    try {
      const value = JSON.parse(line) as unknown
      if (!isRecord(value)) continue
      record = value
    } catch { continue }
    if (record.type === 'session_meta' && isRecord(record.payload)) {
      parsed.id ??= text(record.payload.id)
      parsed.cwd ??= text(record.payload.cwd)
      parsed.modelProvider ??= text(record.payload.model_provider)
      parsed.createdAt ??= parseTimestamp(record.timestamp)
    }
    if (!parsed.title && isRecord(record.payload)) {
      const payloadType = text(record.payload.type)
      if (payloadType === 'user_message' || payloadType === 'user_input') {
        parsed.title = truncateTitle(text(record.payload.message) ?? text(record.payload.text))
      }
    }
    const usage = findUsage(record)
    if (usage) {
      parsed.inputTokens = Math.max(parsed.inputTokens, numeric(usage.input_tokens))
      parsed.outputTokens = Math.max(parsed.outputTokens, numeric(usage.output_tokens))
      parsed.cachedInputTokens = Math.max(parsed.cachedInputTokens, numeric(usage.cached_input_tokens))
      parsed.reasoningTokens = Math.max(parsed.reasoningTokens,
        numeric(usage.reasoning_output_tokens) || numeric(usage.reasoning_tokens))
      parsed.totalTokens = Math.max(parsed.totalTokens, numeric(usage.total_tokens))
    }
  }
  parsed.contentSha256 = hash.digest('hex')
  return parsed
}

function findUsage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const payload = isRecord(record.payload) ? record.payload : undefined
  const info = payload && isRecord(payload.info) ? payload.info : undefined
  const candidates = [
    info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined,
    payload && isRecord(payload.total_token_usage) ? payload.total_token_usage : undefined,
    payload && isRecord(payload.usage) ? payload.usage : undefined,
    isRecord(record.usage) ? record.usage : undefined
  ]
  return candidates.find((candidate) => candidate && [
    candidate.input_tokens,
    candidate.output_tokens,
    candidate.cached_input_tokens,
    candidate.reasoning_output_tokens,
    candidate.reasoning_tokens,
    candidate.total_tokens
  ].some((value) => typeof value === 'number' && Number.isFinite(value)))
}

async function collectRollouts(
  directory: string,
  kind: CodexSessionKind,
  output: Array<{ path: string; kind: CodexSessionKind }>
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectRollouts(path, kind, output)
    else if (entry.isFile() && ROLLOUT_PATTERN.test(entry.name)) {
      const info = await lstat(path).catch(() => undefined)
      if (info?.isFile() && !info.isSymbolicLink()) output.push({ path, kind })
    }
  }
}

async function collectFiles(root: string, output: string[], accepts: (name: string) => boolean): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await collectFiles(path, output, accepts)
    else if (entry.isFile() && accepts(entry.name)) output.push(path)
  }
}

function rolloutIdFromFilename(path: string): string | undefined {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1]
}

function boundedLimit(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(10_000, Math.floor(value!))) : 1_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function truncateTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 100) : undefined
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined))
}

function sessionRevision(
  id: string,
  relativePath: string,
  kind: CodexSessionKind,
  size: number,
  contentSha256: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([id, relativePath, kind, size, contentSha256]))
    .digest('hex')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const input = createReadStream(path)
  for await (const chunk of input) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function writeTrashManifest(path: string, manifest: TrashManifest): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function threadRowAtTarget(
  current: Pick<TrashManifest['databaseRows'][number], 'rolloutPath' | 'archived' | 'archivedAt'>,
  target: Pick<TrashManifest['databaseRows'][number], 'rolloutPath' | 'archived' | 'archivedAt'>,
  ignoreArchivedAt = false
): boolean {
  if (current.rolloutPath !== target.rolloutPath) return false
  if (current.archived !== null && target.archived !== null && current.archived !== target.archived) return false
  return ignoreArchivedAt || current.archivedAt === null || target.archivedAt === null || current.archivedAt === target.archivedAt
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
      .flatMap((row) => typeof row.name === 'string' ? [row.name] : []))
  } catch {
    return new Set()
  }
}

function readThreadRow(
  databasePath: string,
  id: string
): Pick<TrashManifest['databaseRows'][number], 'rolloutPath' | 'archived' | 'archivedAt'> | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const columns = tableColumns(database, 'threads')
    if (!columns.has('id') || !columns.has('rollout_path')) return undefined
    const row = database.prepare(`SELECT rollout_path,
      ${columns.has('archived') ? 'archived' : 'NULL'} AS archived,
      ${columns.has('archived_at') ? 'archived_at' : 'NULL'} AS archived_at
      FROM threads WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row || typeof row.rollout_path !== 'string') return undefined
    return {
      rolloutPath: row.rollout_path,
      archived: typeof row.archived === 'number' || typeof row.archived === 'bigint' ? Number(row.archived) : null,
      archivedAt: typeof row.archived_at === 'number' || typeof row.archived_at === 'bigint' ? Number(row.archived_at) : null
    }
  } finally {
    database.close()
  }
}

function writeThreadRow(
  databasePath: string,
  id: string,
  value: Pick<TrashManifest['databaseRows'][number], 'rolloutPath' | 'archived' | 'archivedAt'>
): void {
  const database = new DatabaseSync(databasePath)
  try {
    const columns = tableColumns(database, 'threads')
    if (!columns.has('id') || !columns.has('rollout_path')) throw new Error('The Codex thread database schema changed during session maintenance.')
    const assignments = ['rollout_path = ?']
    const values: Array<string | number | null> = [value.rolloutPath]
    if (columns.has('archived')) { assignments.push('archived = ?'); values.push(value.archived ?? 0) }
    if (columns.has('archived_at')) { assignments.push('archived_at = ?'); values.push(value.archivedAt ?? null) }
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`UPDATE threads SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    database.close()
  }
}
