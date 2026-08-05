import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gt, valid } from 'semver'
import { readBoundedResponseText } from '../auth/bounded-response'

export const BUNDLED_CODEX_CLIENT_VERSION = '0.144.3'
const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=30'
const RELEASE_TAG = /^rust-v(\d+\.\d+\.\d+)$/
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1_000
const SYNC_TIMEOUT_MS = 8_000
const MAX_STATE_BYTES = 16 * 1024
const MAX_RELEASES_RESPONSE_BYTES = 1024 * 1024

let effectiveCodexClientVersion = BUNDLED_CODEX_CLIENT_VERSION

export function getCodexClientVersion(): string {
  return effectiveCodexClientVersion
}

export function getChatGptCodexModelsUrl(): string {
  return `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(getCodexClientVersion())}`
}

export function normalizeStableCodexVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return valid(normalized) === normalized && !normalized.includes('-') ? normalized : undefined
}

function promoteCodexClientVersion(candidate: string): boolean {
  const normalized = normalizeStableCodexVersion(candidate)
  if (!normalized || !gt(normalized, effectiveCodexClientVersion)) return false
  effectiveCodexClientVersion = normalized
  return true
}

interface PersistedCodexClientVersion {
  version?: unknown
}

interface GitHubRelease {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
}

export interface CodexClientVersionSyncServiceOptions {
  userDataPath: string
  fetchImplementation?: (input: string, init?: RequestInit) => Promise<Response>
  intervalMs?: number
  timeoutMs?: number
  logger?: Pick<Console, 'warn'>
}

/**
 * Keeps first-party Codex identity headers current without making application
 * startup depend on GitHub. Only a newer stable rust-v* release is accepted;
 * network or parse failures leave the bundled/last-known-good version intact.
 */
export class CodexClientVersionSyncService {
  private readonly statePath: string
  private readonly fetchImplementation: (input: string, init?: RequestInit) => Promise<Response>
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly logger: Pick<Console, 'warn'>
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshFlight: Promise<string> | undefined
  private closed = false

  constructor(options: CodexClientVersionSyncServiceOptions) {
    this.statePath = join(options.userDataPath, 'codex-client-version.json')
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.intervalMs = Math.max(60_000, options.intervalMs ?? SYNC_INTERVAL_MS)
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? SYNC_TIMEOUT_MS)
    this.logger = options.logger ?? console
  }

  public async initialize(): Promise<string> {
    try {
      const metadata = await stat(this.statePath)
      if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) {
        throw new Error('last-known-good version state exceeds its safe size limit')
      }
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedCodexClientVersion
      const persisted = normalizeStableCodexVersion(parsed.version)
      if (persisted) promoteCodexClientVersion(persisted)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn('[codex-version] Ignoring an invalid last-known-good version file.')
      }
    }
    return getCodexClientVersion()
  }

  public start(): void {
    if (this.closed || this.timer) return
    void this.refresh().catch(() => undefined)
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.intervalMs)
    this.timer.unref?.()
  }

  public refresh(): Promise<string> {
    if (this.closed) return Promise.resolve(getCodexClientVersion())
    if (this.refreshFlight) return this.refreshFlight
    const flight = this.fetchLatestStableVersion()
      .then(async (candidate) => {
        if (!candidate || !promoteCodexClientVersion(candidate)) return getCodexClientVersion()
        await this.persist(candidate)
        return getCodexClientVersion()
      })
      .catch((error: unknown) => {
        this.logger.warn(`[codex-version] Version sync failed; keeping ${getCodexClientVersion()}.`, safeErrorMessage(error))
        return getCodexClientVersion()
      })
      .finally(() => {
        if (this.refreshFlight === flight) this.refreshFlight = undefined
      })
    this.refreshFlight = flight
    return flight
  }

  public close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async fetchLatestStableVersion(): Promise<string | undefined> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    const response = await this.fetchImplementation(RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `StonePlus/${getCodexClientVersion()}`,
        'x-github-api-version': '2022-11-28',
      },
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`GitHub releases returned HTTP ${response.status}.`)
    }
    const payload = JSON.parse(await readBoundedResponseText(
      response,
      MAX_RELEASES_RESPONSE_BYTES,
      'GitHub releases response exceeded the safe size limit.',
      signal,
    )) as unknown
    if (!Array.isArray(payload)) throw new Error('GitHub releases returned an invalid response.')
    let newest: string | undefined
    for (const value of payload) {
      if (!value || typeof value !== 'object') continue
      const release = value as GitHubRelease
      if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') continue
      const candidate = release.tag_name.match(RELEASE_TAG)?.[1]
      if (!candidate || !normalizeStableCodexVersion(candidate)) continue
      if (!newest || gt(candidate, newest)) newest = candidate
    }
    return newest
  }

  private async persist(version: string): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify({ version })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.statePath)
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.'
}
