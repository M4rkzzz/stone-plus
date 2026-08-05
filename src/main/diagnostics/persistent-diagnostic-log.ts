import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_ARCHIVE_COUNT = 2
const MAX_STRING_LENGTH = 8_000
const MAX_ARRAY_LENGTH = 32
const MAX_OBJECT_KEYS = 64
const MAX_DEPTH = 4

export interface PersistentDiagnosticLogOptions {
  maxBytes?: number
  archiveCount?: number
  now?: () => Date
}

export class PersistentDiagnosticLog {
  readonly path: string
  private readonly maxBytes: number
  private readonly archiveCount: number
  private readonly now: () => Date
  private writing = false

  constructor(directory: string, options: PersistentDiagnosticLogOptions = {}) {
    this.path = join(directory, 'stone-diagnostics.jsonl')
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.archiveCount = Math.max(0, Math.min(5, options.archiveCount ?? DEFAULT_ARCHIVE_COUNT))
    this.now = options.now ?? (() => new Date())
  }

  record(event: string, message: string, details?: Record<string, unknown>): void {
    if (this.writing) return
    this.writing = true
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      this.rotateIfNeeded()
      const entry = {
        timestamp: this.now().toISOString(),
        event: safeLabel(event),
        message: redactDiagnosticString(message),
        pid: process.pid,
        ...(details ? { details: redactDiagnosticValue(details) } : {}),
      }
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Diagnostics must never become a second application failure.
    } finally {
      this.writing = false
    }
  }

  installProcessHandlers(): () => void {
    const onUncaughtException = (error: Error, origin: string): void => {
      this.record('uncaught-exception', error.message, {
        origin,
        name: error.name,
        stack: error.stack,
      })
    }
    process.on('uncaughtExceptionMonitor', onUncaughtException)
    return () => process.removeListener('uncaughtExceptionMonitor', onUncaughtException)
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path) || statSync(this.path).size < this.maxBytes) return
    if (this.archiveCount === 0) {
      unlinkSync(this.path)
      return
    }
    const oldest = `${this.path}.${this.archiveCount}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let index = this.archiveCount - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${index}`
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`)
    }
    renameSync(this.path, `${this.path}.1`)
  }
}

export function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') return redactDiagnosticString(value)
  if (value instanceof Error) {
    return {
      name: safeLabel(value.name),
      message: redactDiagnosticString(value.message),
      stack: redactDiagnosticString(value.stack ?? ''),
    }
  }
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactDiagnosticValue(item, depth + 1))
  }
  if (typeof value !== 'object') return String(value)

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : redactDiagnosticValue(item, depth + 1)
  }
  return output
}

export function redactDiagnosticString(value: string): string {
  return value
    .slice(0, MAX_STRING_LENGTH)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)[^"',\s}\]]+/gi,
      '$1[REDACTED]',
    )
    .replace(/([?&](?:access_token|api_key|key|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|auth_token|access_token|refresh_token|id_token|api[_-]?key|password|secret|cookie)/i.test(key)
}

function safeLabel(value: string): string {
  return redactDiagnosticString(value).replace(/[\r\n]+/g, ' ').slice(0, 160)
}
