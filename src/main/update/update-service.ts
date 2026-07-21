import type { AppUpdateProgress, AppUpdateRelease, AppUpdateState } from '@shared/types'
import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateDownloadedEvent } from 'electron-updater'
import { clean, eq, gt, gte, valid } from 'semver'

const RELEASE_API_URL = 'https://api.github.com/repos/M4rkzzz/stone-plus/releases/latest'
const RELEASE_PAGE_URL = 'https://github.com/M4rkzzz/stone-plus/releases/latest'
const RELEASE_PATH_PREFIX = '/M4rkzzz/stone-plus/releases/'
const RELEASE_TAG_PATH_PATTERN = /^\/M4rkzzz\/stone-plus\/releases\/tag\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/?$/
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024
const MAX_RELEASE_NOTES_LENGTH = 32_000
const DEFAULT_CHECK_DELAY_MS = 12_000
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>

export interface UpdatePreferenceStore {
  getIgnoredUpdateVersion(): string | undefined
  setIgnoredUpdateVersion(version?: string): Promise<void>
}

export interface UpdateServiceOptions {
  currentVersion: string
  isPackaged: boolean
  platform: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  updater: AppUpdater
  preferences: UpdatePreferenceStore
  fetchImplementation: FetchImplementation
  openExternal: (url: string) => Promise<void>
  prepareToInstall: () => Promise<void>
  now?: () => number
  automaticCheckDelayMs?: number
  automaticCheckIntervalMs?: number
}

export interface AutomaticUpdateSupport {
  supported: boolean
  reason?: string
}

export class UpdateService {
  private state: AppUpdateState
  private readonly listeners = new Set<(state: AppUpdateState) => void>()
  private checkPromise: Promise<AppUpdateState> | undefined
  private downloadPromise: Promise<AppUpdateState> | undefined
  private automaticCheckTimer: ReturnType<typeof setTimeout> | undefined
  private initialized = false
  private closed = false

  public constructor(private readonly options: UpdateServiceOptions) {
    const support = determineAutomaticUpdateSupport(
      options.isPackaged,
      options.platform,
      options.environment ?? process.env
    )
    const currentVersion = valid(options.currentVersion)
    if (!currentVersion) throw new Error('Stone+ has an invalid application version.')

    this.state = {
      revision: 0,
      currentVersion,
      status: options.isPackaged ? 'idle' : 'unsupported',
      automaticUpdateSupported: support.supported,
      ...(support.reason ? { automaticUpdateReason: support.reason } : {})
    }

    options.updater.autoDownload = false
    options.updater.autoInstallOnAppQuit = false
    options.updater.autoRunAppAfterInstall = true
    options.updater.allowPrerelease = false
    options.updater.allowDowngrade = false
    options.updater.disableWebInstaller = true
    options.updater.on('download-progress', this.handleDownloadProgress)
    options.updater.on('update-downloaded', this.handleUpdateDownloaded)
    options.updater.on('error', this.handleUpdaterError)
  }

  public async initialize(): Promise<AppUpdateState> {
    if (this.initialized) return this.getState()
    this.initialized = true
    const candidate = this.options.preferences.getIgnoredUpdateVersion()
    const ignoredVersion = candidate ? valid(candidate) ?? undefined : undefined
    if (candidate && !ignoredVersion) {
      await this.options.preferences.setIgnoredUpdateVersion(undefined)
    } else if (ignoredVersion && gte(this.state.currentVersion, ignoredVersion)) {
      await this.options.preferences.setIgnoredUpdateVersion(undefined)
    } else if (ignoredVersion) {
      this.updateState({ ignoredVersion })
    }
    return this.getState()
  }

  public getState(): AppUpdateState {
    return structuredClone(this.state)
  }

  public subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public startAutomaticChecks(): void {
    if (!this.options.isPackaged || this.closed || this.automaticCheckTimer) return
    const delay = this.options.automaticCheckDelayMs ?? DEFAULT_CHECK_DELAY_MS
    const interval = this.options.automaticCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    const run = (): void => {
      if (this.closed) return
      void this.checkForUpdates().finally(() => {
        if (this.closed) return
        this.automaticCheckTimer = setTimeout(run, interval)
        this.automaticCheckTimer.unref?.()
      })
    }
    this.automaticCheckTimer = setTimeout(run, delay)
    this.automaticCheckTimer.unref?.()
  }

  public async checkForUpdates(): Promise<AppUpdateState> {
    if (!this.options.isPackaged) return this.getState()
    if (this.state.status === 'downloading' || this.state.status === 'downloaded' || this.state.status === 'installing') {
      return this.getState()
    }
    if (this.checkPromise) return this.checkPromise

    const operation = async (): Promise<AppUpdateState> => {
      this.updateState({ status: 'checking', error: undefined, progress: undefined })
      try {
        const release = await fetchLatestRelease(this.options.fetchImplementation, this.state.currentVersion)
        const checkedAt = this.now()
        if (!release) {
          this.updateState({
            status: 'up-to-date',
            checkedAt,
            release: undefined,
            progress: undefined,
            error: undefined
          })
          return this.getState()
        }

        this.updateState({
          status: 'available',
          checkedAt,
          release,
          progress: undefined,
          error: undefined
        })
        return this.getState()
      } catch (error) {
        this.updateState({
          status: 'error',
          checkedAt: this.now(),
          progress: undefined,
          error: updateCheckErrorMessage(error)
        })
        return this.getState()
      }
    }

    this.checkPromise = operation().finally(() => {
      this.checkPromise = undefined
    })
    return this.checkPromise
  }

  public async ignoreUpdate(version: string): Promise<AppUpdateState> {
    const normalized = valid(version)
    if (!normalized || !this.state.release || !eq(normalized, this.state.release.version)) {
      throw new Error('Stone+ rejected an invalid update version.')
    }
    if (!gt(normalized, this.state.currentVersion)) {
      throw new Error('Stone+ cannot ignore a version that is already installed.')
    }

    await this.options.preferences.setIgnoredUpdateVersion(normalized)
    this.updateState({ ignoredVersion: normalized })
    return this.getState()
  }

  public async downloadUpdate(): Promise<AppUpdateState> {
    if (this.downloadPromise) return this.downloadPromise
    if (!this.state.automaticUpdateSupported) {
      throw new Error(this.state.automaticUpdateReason ?? 'Online installation is not supported by this package.')
    }
    if (!this.state.release || !gt(this.state.release.version, this.state.currentVersion)) {
      throw new Error('No downloadable update is available.')
    }

    const expectedVersion = this.state.release.version
    const operation = async (): Promise<AppUpdateState> => {
      if (this.state.ignoredVersion === expectedVersion) {
        await this.options.preferences.setIgnoredUpdateVersion(undefined)
      }
      this.updateState({
        status: 'downloading',
        ignoredVersion: this.state.ignoredVersion === expectedVersion ? undefined : this.state.ignoredVersion,
        error: undefined,
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
      })

      try {
        const result = await this.options.updater.checkForUpdates()
        assertMatchingUpdate(result, expectedVersion)
        await this.options.updater.downloadUpdate()
        if (this.state.status === 'downloading') {
          this.updateState({
            status: 'downloaded',
            progress: this.state.progress
              ? { ...this.state.progress, percent: 100, transferred: this.state.progress.total || this.state.progress.transferred }
              : undefined
          })
        }
        return this.getState()
      } catch (error) {
        this.updateState({
          status: 'error',
          progress: undefined,
          error: updateDownloadErrorMessage(error)
        })
        return this.getState()
      }
    }

    this.downloadPromise = operation().finally(() => {
      this.downloadPromise = undefined
    })
    return this.downloadPromise
  }

  public async installUpdate(): Promise<void> {
    if (!this.state.automaticUpdateSupported || this.state.status !== 'downloaded') {
      throw new Error('The update has not been downloaded and cannot be installed.')
    }
    this.updateState({ status: 'installing', error: undefined })
    try {
      await this.options.prepareToInstall()
      this.options.updater.quitAndInstall(true, true)
    } catch (error) {
      this.updateState({ status: 'error', error: updateDownloadErrorMessage(error) })
      throw error
    }
  }

  public async openUpdatePage(): Promise<void> {
    const url = this.state.release?.url ?? RELEASE_PAGE_URL
    assertTrustedReleaseUrl(url)
    await this.options.openExternal(url)
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    if (this.automaticCheckTimer) clearTimeout(this.automaticCheckTimer)
    this.automaticCheckTimer = undefined
    this.options.updater.removeListener('download-progress', this.handleDownloadProgress)
    this.options.updater.removeListener('update-downloaded', this.handleUpdateDownloaded)
    this.listeners.clear()
  }

  private readonly handleDownloadProgress = (progress: ProgressInfo): void => {
    if (this.state.status !== 'downloading') return
    this.updateState({ progress: sanitizeProgress(progress) })
  }

  private readonly handleUpdateDownloaded = (event: UpdateDownloadedEvent): void => {
    if (!this.state.release || !eq(event.version, this.state.release.version)) return
    this.updateState({
      status: 'downloaded',
      error: undefined,
      progress: this.state.progress
        ? { ...this.state.progress, percent: 100, transferred: this.state.progress.total || this.state.progress.transferred }
        : undefined
    })
  }

  private readonly handleUpdaterError = (error: Error): void => {
    if (this.closed || this.state.status !== 'downloading') return
    this.updateState({ status: 'error', progress: undefined, error: updateDownloadErrorMessage(error) })
  }

  private updateState(patch: Partial<Omit<AppUpdateState, 'revision' | 'currentVersion' | 'automaticUpdateSupported'>>): void {
    this.state = {
      ...this.state,
      ...patch,
      revision: this.state.revision + 1
    }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export function determineAutomaticUpdateSupport(
  isPackaged: boolean,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): AutomaticUpdateSupport {
  if (!isPackaged) return { supported: false, reason: '开发模式不会安装在线更新。' }
  if (platform === 'win32') {
    if (environment.PORTABLE_EXECUTABLE_FILE || environment.PORTABLE_EXECUTABLE_DIR) {
      return { supported: false, reason: 'Portable 版本无法原地更新，请从 GitHub Release 下载新版。' }
    }
    return { supported: true }
  }
  if (platform === 'linux') {
    if (!environment.APPIMAGE) {
      return { supported: false, reason: '当前 Linux 安装形式不支持一键替换，请从 GitHub Release 下载新版。' }
    }
    return { supported: true }
  }
  if (platform === 'darwin') {
    return { supported: false, reason: 'macOS 自动安装将在正式代码签名与 Apple 公证启用后开放。' }
  }
  return { supported: false, reason: '当前平台不支持一键安装，请从 GitHub Release 下载新版。' }
}

export async function fetchLatestRelease(
  fetchImplementation: FetchImplementation,
  currentVersion: string
): Promise<AppUpdateRelease | undefined> {
  let response: Response
  try {
    response = await fetchImplementation(RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `StonePlus/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    // api.github.com and github.com may take different network paths. The public
    // release page is still useful when only the API request is unavailable.
    return fetchLatestReleaseFromPage(fetchImplementation, currentVersion)
  }
  // Anonymous GitHub REST requests share a small per-IP quota. Fall back to the
  // public release page so update checks keep working on shared networks without
  // requiring a GitHub token in the desktop application.
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined)
    return fetchLatestReleaseFromPage(fetchImplementation, currentVersion)
  }
  if (!response.ok) throw new Error(`GitHub release request failed with status ${response.status}.`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_RELEASE_RESPONSE_BYTES) throw new Error('GitHub release response was too large.')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RELEASE_RESPONSE_BYTES) {
    throw new Error('GitHub release response was too large.')
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('GitHub release response was not valid JSON.')
  }
  if (!payload || typeof payload !== 'object') throw new Error('GitHub release response was invalid.')
  const release = payload as Record<string, unknown>
  if (release.draft === true || release.prerelease === true) return undefined

  const tagName = typeof release.tag_name === 'string' ? release.tag_name.trim() : ''
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tagName)) {
    throw new Error('GitHub release tag was not a stable semantic version.')
  }
  const version = clean(tagName)
  if (!version || !valid(version)) throw new Error('GitHub release version was invalid.')
  if (!gt(version, currentVersion)) return undefined

  const url = typeof release.html_url === 'string' ? release.html_url : ''
  assertTrustedReleaseUrl(url)
  const publishedAt = typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at))
    ? release.published_at
    : ''
  const title = typeof release.name === 'string' && release.name.trim()
    ? release.name.trim().slice(0, 200)
    : `Stone+ v${version}`
  const notes = typeof release.body === 'string' && release.body.trim()
    ? release.body.slice(0, MAX_RELEASE_NOTES_LENGTH)
    : '此版本没有提供更新说明。'

  return { version, tagName, title, notes, publishedAt, url }
}

async function fetchLatestReleaseFromPage(
  fetchImplementation: FetchImplementation,
  currentVersion: string
): Promise<AppUpdateRelease | undefined> {
  const response = await fetchImplementation(RELEASE_PAGE_URL, {
    method: 'GET',
    headers: {
      Accept: 'text/html',
      'User-Agent': `StonePlus/${currentVersion}`
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`GitHub release page failed with status ${response.status}.`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_RELEASE_RESPONSE_BYTES) throw new Error('GitHub release page was too large.')
  const html = await response.text()
  if (Buffer.byteLength(html, 'utf8') > MAX_RELEASE_RESPONSE_BYTES) {
    throw new Error('GitHub release page was too large.')
  }

  // Electron net.fetch throws "Redirect was cancelled" for redirect: 'manual'
  // and does not expose the final response URL after redirect: 'follow'. GitHub's
  // trusted release page publishes the canonical target in its og:url metadata.
  const path = releaseUrlFromHtml(html)
  const url = new URL(path, RELEASE_PAGE_URL).toString()
  const tagName = releaseTagFromUrl(url)
  const version = clean(tagName)
  if (!version || !valid(version)) throw new Error('GitHub release version was invalid.')
  if (!gt(version, currentVersion)) return undefined

  return {
    version,
    tagName,
    title: `Stone+ v${version}`,
    notes: '完整更新说明请打开 GitHub Release 查看。',
    publishedAt: '',
    url
  }
}

function releaseUrlFromHtml(html: string): string {
  for (const match of html.matchAll(/<meta\b[^>]{0,2048}>/gi)) {
    const tag = match[0]
    const property = htmlAttribute(tag, 'property')
    if (property !== 'og:url') continue
    const content = htmlAttribute(tag, 'content')
    if (content) return content
  }
  throw new Error('GitHub release page did not provide a canonical release URL.')
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)
  return match?.[2]
}

function assertMatchingUpdate(result: UpdateCheckResult | null, expectedVersion: string): void {
  const actualVersion = result?.updateInfo?.version
  if (!result?.isUpdateAvailable || typeof actualVersion !== 'string' || !eq(actualVersion, expectedVersion)) {
    throw new Error('Update metadata does not match the confirmed GitHub release.')
  }
}

function sanitizeProgress(progress: ProgressInfo): AppUpdateProgress {
  const total = finiteNonNegative(progress.total)
  const transferred = Math.min(finiteNonNegative(progress.transferred), total || Number.MAX_SAFE_INTEGER)
  return {
    percent: Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0)),
    transferred,
    total,
    bytesPerSecond: finiteNonNegative(progress.bytesPerSecond)
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function assertTrustedReleaseUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('GitHub release URL was invalid.')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(RELEASE_PATH_PREFIX)) {
    throw new Error('Stone+ rejected an untrusted update URL.')
  }
}

function releaseTagFromUrl(value: string): string {
  assertTrustedReleaseUrl(value)
  const url = new URL(value)
  const match = RELEASE_TAG_PATH_PATTERN.exec(url.pathname)
  if (!match || url.search || url.hash) throw new Error('GitHub release redirect URL was invalid.')
  return match[1]
}

function updateCheckErrorMessage(error: unknown): string {
  const message = messageOf(error)
  if (/timed? ?out|abort/i.test(message)) return '检查更新超时，请确认网络后重试。'
  if (/status 403|rate limit/i.test(message)) return 'GitHub 暂时限制了更新检查，请稍后重试。'
  if (/status 404/i.test(message)) return 'GitHub 上暂时没有可用的正式版本。'
  return '无法连接 GitHub 检查更新，请确认网络后重试。'
}

function updateDownloadErrorMessage(error: unknown): string {
  const message = messageOf(error)
  if (/metadata does not match/i.test(message)) return '更新文件与已确认版本不一致，已停止安装。'
  if (/latest.*\.ya?ml|status 404|cannot find/i.test(message)) {
    return '该版本缺少在线更新文件，请改为打开 GitHub Release 下载。'
  }
  if (/timed? ?out|abort|network|connect|socket/i.test(message)) {
    return '下载更新失败，请确认网络后重试。'
  }
  return '在线更新失败，请重试或从 GitHub Release 手动下载。'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
