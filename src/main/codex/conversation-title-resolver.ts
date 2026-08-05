import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { codexStateDatabasePaths } from './state-database-paths'

interface ThreadTitleRow {
  title?: unknown
}

interface CachedTitle {
  expiresAt: number
  title?: string
}

const TITLE_CACHE_TTL_MS = 5_000
const MISSING_TITLE_CACHE_TTL_MS = 1_000
const MAX_CACHED_TITLES = 1_000

export class CodexConversationTitleResolver {
  private readonly codexHome: string
  private databases: Array<{ database: DatabaseSync; statement: StatementSync }> = []
  private readonly cache = new Map<string, CachedTitle>()

  public constructor(codexHome: string) {
    this.codexHome = resolve(codexHome)
  }

  public resolve(threadId: string): string | undefined {
    const normalizedId = threadId.trim()
    if (!normalizedId || normalizedId.length > 200) return undefined
    const now = Date.now()
    const cached = this.cache.get(normalizedId)
    if (cached && cached.expiresAt > now) return cached.title
    try {
      this.ensureOpen()
      let title: string | undefined
      for (const { statement } of this.databases) {
        const row = statement.get(normalizedId) as ThreadTitleRow | undefined
        title = normalizeTitle(row?.title)
        if (title) break
      }
      this.remember(normalizedId, title, now)
      // A miss may mean Codex just created or relocated its state database.
      // Re-resolve config/env on the next short missing-title cache expiry.
      if (!title) this.closeDatabases()
      return title
    } catch {
      this.closeDatabases()
      return undefined
    }
  }

  public close(): void {
    this.closeDatabases()
  }

  private remember(threadId: string, title: string | undefined, now: number): void {
    this.cache.delete(threadId)
    this.cache.set(threadId, {
      title,
      expiresAt: now + (title ? TITLE_CACHE_TTL_MS : MISSING_TITLE_CACHE_TTL_MS)
    })
    if (this.cache.size > MAX_CACHED_TITLES) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
  }

  private ensureOpen(): void {
    if (this.databases.length > 0) return
    let configText = ''
    try {
      configText = readFileSync(join(this.codexHome, 'config.toml'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const path of codexStateDatabasePaths(this.codexHome, configText)) {
      let database: DatabaseSync | undefined
      try {
        database = new DatabaseSync(path, { readOnly: true })
        const statement = database.prepare('SELECT title FROM threads WHERE id = ? LIMIT 1')
        this.databases.push({ database, statement })
      } catch (error) {
        database?.close()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
    }
  }

  private closeDatabases(): void {
    for (const { database } of this.databases) database.close()
    this.databases = []
  }
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 180)
  return normalized || undefined
}
