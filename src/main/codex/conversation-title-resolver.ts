import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { join } from 'node:path'

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
  private readonly databasePath: string
  private database?: DatabaseSync
  private statement?: StatementSync
  private readonly cache = new Map<string, CachedTitle>()

  public constructor(homeDirectory: string) {
    this.databasePath = join(homeDirectory, '.codex', 'state_5.sqlite')
  }

  public resolve(threadId: string): string | undefined {
    const normalizedId = threadId.trim()
    if (!normalizedId || normalizedId.length > 200) return undefined
    const now = Date.now()
    const cached = this.cache.get(normalizedId)
    if (cached && cached.expiresAt > now) return cached.title
    try {
      this.ensureOpen()
      const row = this.statement?.get(normalizedId) as ThreadTitleRow | undefined
      const title = normalizeTitle(row?.title)
      this.remember(normalizedId, title, now)
      return title
    } catch {
      this.close()
      return undefined
    }
  }

  public close(): void {
    this.statement = undefined
    this.database?.close()
    this.database = undefined
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
    if (this.database && this.statement) return
    const database = new DatabaseSync(this.databasePath, { readOnly: true })
    try {
      this.statement = database.prepare('SELECT title FROM threads WHERE id = ? LIMIT 1')
      this.database = database
    } catch (error) {
      database.close()
      throw error
    }
  }
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 180)
  return normalized || undefined
}
