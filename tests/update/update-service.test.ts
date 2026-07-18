import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateDownloadedEvent } from 'electron-updater'
import {
  determineAutomaticUpdateSupport,
  fetchLatestRelease,
  UpdateService,
  type UpdatePreferenceStore
} from '../../src/main/update'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowPrerelease = true
  allowDowngrade = true
  disableWebInstaller = false
  updateVersion = '0.8.1'
  isUpdateAvailable = true
  downloadCalls = 0
  quitCalls = 0
  onDownload: (() => void) | undefined
  onQuit: (() => void) | undefined

  async checkForUpdates(): Promise<UpdateCheckResult> {
    const updateInfo = {
      version: this.updateVersion,
      files: [{ url: 'Stone.exe', sha512: 'test' }],
      path: 'Stone.exe',
      sha512: 'test',
      releaseDate: '2026-07-13T00:00:00Z'
    }
    return {
      isUpdateAvailable: this.isUpdateAvailable,
      updateInfo,
      versionInfo: updateInfo
    } as UpdateCheckResult
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1
    this.onDownload?.()
    return ['update.bin']
  }

  quitAndInstall(): void {
    this.quitCalls += 1
    this.onQuit?.()
  }
}

class MemoryPreferences implements UpdatePreferenceStore {
  ignoredVersion: string | undefined

  getIgnoredUpdateVersion(): string | undefined {
    return this.ignoredVersion
  }

  async setIgnoredUpdateVersion(version?: string): Promise<void> {
    this.ignoredVersion = version
  }
}

interface HarnessOptions {
  releaseVersion?: string
  fetchImplementation?: (input: string, init?: RequestInit) => Promise<Response>
  preferences?: MemoryPreferences
  prepareToInstall?: () => Promise<void>
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  isPackaged?: boolean
  automaticCheckDelayMs?: number
  automaticCheckIntervalMs?: number
}

const services: UpdateService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function createHarness(options: HarnessOptions = {}) {
  const releaseVersion = options.releaseVersion ?? '0.8.1'
  const preferences = options.preferences ?? new MemoryPreferences()
  const updater = new FakeUpdater()
  updater.updateVersion = releaseVersion
  const fetchImplementation = options.fetchImplementation
    ?? vi.fn(async () => responseFor(releasePayload(releaseVersion)))
  const prepareToInstall = options.prepareToInstall ?? vi.fn(async () => undefined)
  const openExternal = vi.fn(async () => undefined)
  const service = new UpdateService({
    currentVersion: '0.8.0',
    isPackaged: options.isPackaged ?? true,
    platform: options.platform ?? 'win32',
    environment: options.environment ?? {},
    updater: updater as unknown as AppUpdater,
    preferences,
    fetchImplementation,
    openExternal,
    prepareToInstall,
    now: () => 1_234,
    automaticCheckDelayMs: options.automaticCheckDelayMs,
    automaticCheckIntervalMs: options.automaticCheckIntervalMs
  })
  services.push(service)
  return { service, updater, preferences, fetchImplementation, prepareToInstall, openExternal }
}

function releasePayload(version = '0.8.1', overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    name: `Stone+ v${version}`,
    body: '## Changes\n\n- Safer updates',
    html_url: `https://github.com/M4rkzzz/stone-plus/releases/tag/v${version}`,
    published_at: '2026-07-13T00:00:00Z',
    draft: false,
    prerelease: false,
    ...overrides
  }
}

function responseFor(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('UpdateService', () => {
  it('discovers a newer stable GitHub release with bounded public fields', async () => {
    const { service } = createHarness()
    await service.initialize()

    const state = await service.checkForUpdates()

    expect(state.status).toBe('available')
    expect(state.currentVersion).toBe('0.8.0')
    expect(state.release).toEqual({
      version: '0.8.1',
      tagName: 'v0.8.1',
      title: 'Stone+ v0.8.1',
      notes: '## Changes\n\n- Safer updates',
      publishedAt: '2026-07-13T00:00:00Z',
      url: 'https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.1'
    })
    expect(state.checkedAt).toBe(1_234)
  })

  it('reports up to date for the current or an older release', async () => {
    const { service } = createHarness({ releaseVersion: '0.8.0' })
    await service.initialize()

    const state = await service.checkForUpdates()

    expect(state.status).toBe('up-to-date')
    expect(state.release).toBeUndefined()
  })

  it('checks automatically after startup and repeats at the configured interval', async () => {
    vi.useFakeTimers()
    const fetchImplementation = vi.fn(async () => responseFor(releasePayload()))
    const { service } = createHarness({
      fetchImplementation,
      automaticCheckDelayMs: 100,
      automaticCheckIntervalMs: 200
    })
    await service.initialize()

    service.startAutomaticChecks()
    await vi.advanceTimersByTimeAsync(99)
    expect(fetchImplementation).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('does not expose malformed release details as an update', async () => {
    const { service } = createHarness({
      fetchImplementation: async () => responseFor(releasePayload('0.8.1', { tag_name: 'v0.8.1-beta.1' }))
    })
    await service.initialize()

    const state = await service.checkForUpdates()

    expect(state.status).toBe('error')
    expect(state.error).toBe('无法连接 GitHub 检查更新，请确认网络后重试。')
    expect(state.release).toBeUndefined()
  })

  it('persists an ignored version but allows a later release to surface', async () => {
    let releaseVersion = '0.8.1'
    const preferences = new MemoryPreferences()
    const { service } = createHarness({
      preferences,
      fetchImplementation: async () => responseFor(releasePayload(releaseVersion))
    })
    await service.initialize()

    await service.checkForUpdates()
    const ignored = await service.ignoreUpdate('0.8.1')
    expect(ignored.ignoredVersion).toBe('0.8.1')
    expect(preferences.ignoredVersion).toBe('0.8.1')

    releaseVersion = '0.8.2'
    const later = await service.checkForUpdates()
    expect(later.release?.version).toBe('0.8.2')
    expect(later.ignoredVersion).toBe('0.8.1')
  })

  it('clears an ignored version after the app catches up', async () => {
    const preferences = new MemoryPreferences()
    preferences.ignoredVersion = '0.8.0'
    const { service } = createHarness({ preferences })

    await service.initialize()

    expect(service.getState().ignoredVersion).toBeUndefined()
    expect(preferences.ignoredVersion).toBeUndefined()
  })

  it('refuses a download when updater metadata does not match GitHub', async () => {
    const { service, updater } = createHarness()
    await service.initialize()
    await service.checkForUpdates()
    updater.updateVersion = '0.8.2'

    const state = await service.downloadUpdate()

    expect(state.status).toBe('error')
    expect(state.error).toContain('版本不一致')
    expect(updater.downloadCalls).toBe(0)
  })

  it('publishes bounded download progress and reaches downloaded', async () => {
    const { service, updater } = createHarness()
    await service.initialize()
    await service.checkForUpdates()
    updater.onDownload = () => {
      updater.emit('download-progress', {
        percent: 47.25,
        transferred: 475,
        total: 1000,
        bytesPerSecond: 200,
        delta: 100
      } satisfies ProgressInfo)
      updater.emit('update-downloaded', {
        version: '0.8.1',
        files: [],
        path: '',
        sha512: '',
        downloadedFile: 'update.bin'
      } satisfies UpdateDownloadedEvent)
    }

    const revisions: number[] = []
    service.subscribe((state) => revisions.push(state.revision))
    const state = await service.downloadUpdate()

    expect(state).toMatchObject({
      status: 'downloaded',
      progress: { percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 200 }
    })
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
  })

  it('shuts down services before handing installation to electron-updater', async () => {
    const order: string[] = []
    const { service, updater } = createHarness({
      prepareToInstall: async () => { order.push('shutdown') }
    })
    updater.onQuit = () => { order.push('installer') }
    await service.initialize()
    await service.checkForUpdates()
    await service.downloadUpdate()

    await service.installUpdate()

    expect(order).toEqual(['shutdown', 'installer'])
    expect(service.getState().status).toBe('installing')
  })

  it('absorbs a late updater error after closing', () => {
    const { service, updater } = createHarness()

    service.close()

    expect(() => updater.emit('error', new Error('late updater failure'))).not.toThrow()
  })

  it('opens only the fixed GitHub release URL supplied by the checked release', async () => {
    const { service, openExternal } = createHarness()
    await service.initialize()
    await service.checkForUpdates()

    await service.openUpdatePage()

    expect(openExternal).toHaveBeenCalledWith('https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.1')
  })
})

describe('GitHub release parsing', () => {
  it('rejects prerelease tags and untrusted release URLs', async () => {
    await expect(fetchLatestRelease(
      async () => responseFor(releasePayload('0.8.1-beta.1')),
      '0.8.0'
    )).rejects.toThrow('stable semantic version')
    await expect(fetchLatestRelease(
      async () => responseFor(releasePayload('0.8.1', { html_url: 'https://example.com/update.exe' })),
      '0.8.0'
    )).rejects.toThrow('untrusted update URL')
  })

  it('falls back to the trusted latest-release redirect when the REST API is rate limited', async () => {
    const fetchImplementation = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('api.github.com')) return responseFor({ message: 'API rate limit exceeded' }, 403)
      expect(init?.redirect).toBe('manual')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.5' }
      })
    })

    await expect(fetchLatestRelease(fetchImplementation, '0.8.4')).resolves.toEqual({
      version: '0.8.5',
      tagName: 'v0.8.5',
      title: 'Stone+ v0.8.5',
      notes: '完整更新说明请打开 GitHub Release 查看。',
      publishedAt: '',
      url: 'https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.5'
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('treats the redirect fallback as up to date and rejects untrusted redirect targets', async () => {
    const rateLimitedThen = (location: string) => vi.fn(async (input: string) => {
      if (input.includes('api.github.com')) return responseFor({ message: 'rate limited' }, 429)
      return new Response(null, { status: 302, headers: { location } })
    })

    await expect(fetchLatestRelease(
      rateLimitedThen('https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.5'),
      '0.8.5'
    )).resolves.toBeUndefined()
    await expect(fetchLatestRelease(
      rateLimitedThen('https://example.com/M4rkzzz/stone-plus/releases/tag/v9.9.9'),
      '0.8.5'
    )).rejects.toThrow('untrusted update URL')
  })
})

describe('automatic update support', () => {
  it('allows installed Windows and Linux AppImage but not portable, deb, macOS, or development', () => {
    expect(determineAutomaticUpdateSupport(true, 'win32', {}).supported).toBe(true)
    expect(determineAutomaticUpdateSupport(true, 'win32', { PORTABLE_EXECUTABLE_FILE: 'Stone.exe' }).supported).toBe(false)
    expect(determineAutomaticUpdateSupport(true, 'linux', { APPIMAGE: '/tmp/Stone.AppImage' }).supported).toBe(true)
    expect(determineAutomaticUpdateSupport(true, 'linux', {}).supported).toBe(false)
    expect(determineAutomaticUpdateSupport(true, 'darwin', {}).supported).toBe(false)
    expect(determineAutomaticUpdateSupport(false, 'win32', {}).supported).toBe(false)
  })
})
