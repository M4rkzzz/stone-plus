import { safeStorage, type DownloadItem, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type {
  BrowserCachedJsonItem,
  BrowserImportQueueState,
  BrowserJsonCacheState,
  BrowserPendingJsonItem
} from '@shared/types'

const MAX_ITEM_BYTES = 4 * 1024 * 1024
const MAX_QUEUE_BYTES = 32 * 1024 * 1024
const MAX_QUEUE_ITEMS = 100
const MAX_CACHE_BYTES = 256 * 1024 * 1024
const MAX_CACHE_ITEMS = 500
const MAX_ENCRYPTED_ITEM_BYTES = MAX_ITEM_BYTES + 64 * 1024
const ENCRYPTED_CACHE_SUFFIX = '.safe'

interface PrivateQueueItem extends BrowserPendingJsonItem {
  content?: string
}

interface PrivateCacheItem extends BrowserCachedJsonItem {
  path: string
}

export const BROWSER_SESSION_PARTITION = 'persist:stone-browser'

export class BrowserImportQueue {
  private readonly items = new Map<string, PrivateQueueItem>()
  private readonly cachedItems = new Map<string, PrivateCacheItem>()
  private readonly listeners = new Set<(state: BrowserImportQueueState) => void>()
  private revision = 0
  private watchedSession?: Session
  private readonly downloadHandler = (_event: Electron.Event, item: DownloadItem): void => {
    if (!isJsonDownload(item)) return
    try {
      this.stageDownload(item)
    } catch {
      item.cancel()
    }
  }

  private readonly cacheDirectory: string

  public constructor(
    private readonly stagingDirectory: string,
    cacheDirectory = join(dirname(stagingDirectory), 'stone-browser-json-cache')
  ) {
    this.cacheDirectory = cacheDirectory
    rmSync(stagingDirectory, { recursive: true, force: true })
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 })
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    hardenDirectory(stagingDirectory)
    hardenDirectory(cacheDirectory)
    this.loadCache()
  }

  public watch(session: Session): void {
    if (this.watchedSession === session) return
    this.unwatch()
    this.watchedSession = session
    session.on('will-download', this.downloadHandler)
  }

  public getState(): BrowserImportQueueState {
    const items = [...this.items.values()]
      .map(({ content: _content, ...item }) => item)
      .sort((left, right) => left.receivedAt - right.receivedAt)
    return {
      items,
      readyCount: items.filter((item) => item.status === 'ready').length,
      totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
      revision: this.revision
    }
  }

  public getReadyItems(ids: string[]): Array<{ id: string; fileName: string; content: string }> {
    const uniqueIds = [...new Set(ids)]
    if (!uniqueIds.length) throw new Error('请至少选择一个已挂起的 JSON 文件。')
    if (uniqueIds.length > MAX_QUEUE_ITEMS) throw new Error('一次最多导入 100 个 JSON 文件。')
    return uniqueIds.map((id) => {
      const item = this.items.get(id)
      if (!item || item.status !== 'ready' || typeof item.content !== 'string') {
        throw new Error('所选 JSON 已不存在或尚未下载完成，请刷新后重试。')
      }
      return { id, fileName: item.fileName, content: item.content }
    })
  }

  public getCacheState(): BrowserJsonCacheState {
    const items = [...this.cachedItems.values()]
      .map(({ path: _path, ...item }) => item)
      .sort((left, right) => right.receivedAt - left.receivedAt)
    return {
      items,
      totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0)
    }
  }

  public getCachedItem(id: string): BrowserCachedJsonItem | undefined {
    const item = this.cachedItems.get(id)
    if (!item) return undefined
    const { path: _path, ...publicItem } = item
    return publicItem
  }

  public async saveCachedItem(id: string, destinationPath: string): Promise<void> {
    const item = this.cachedItems.get(id)
    if (!item) throw new Error('缓存中的 JSON 已不存在。')
    if (resolve(item.path) === resolve(destinationPath)) return
    const plaintext = this.decryptCacheFile(item.path)
    await writeFile(destinationPath, plaintext, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  }

  public async removeCachedItem(id: string): Promise<BrowserJsonCacheState> {
    const item = this.cachedItems.get(id)
    if (!item) return this.getCacheState()
    await rm(item.path, { force: true })
    this.cachedItems.delete(id)
    return this.getCacheState()
  }

  public async clearCache(): Promise<BrowserJsonCacheState> {
    await Promise.all([...this.cachedItems.values()].map((item) => rm(item.path, { force: true })))
    this.cachedItems.clear()
    return this.getCacheState()
  }

  public remove(id: string): BrowserImportQueueState {
    if (this.items.delete(id)) this.emit()
    return this.getState()
  }

  public removeMany(ids: string[]): BrowserImportQueueState {
    let changed = false
    for (const id of new Set(ids)) changed = this.items.delete(id) || changed
    if (changed) this.emit()
    return this.getState()
  }

  /** Removes both the in-memory import and its encrypted persistent cache. */
  public async removeImported(ids: string[]): Promise<BrowserImportQueueState> {
    const uniqueIds = [...new Set(ids)]
    let removalError: unknown
    for (const id of uniqueIds) {
      const cached = this.cachedItems.get(id)
      if (!cached) continue
      try {
        await rm(cached.path, { force: true })
        this.cachedItems.delete(id)
      } catch (error) {
        removalError ??= error
      }
    }
    if (removalError) throw removalError
    return this.removeMany(uniqueIds)
  }

  public clear(): BrowserImportQueueState {
    if (this.items.size) {
      this.items.clear()
      this.emit()
    }
    return this.getState()
  }

  public subscribe(listener: (state: BrowserImportQueueState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async close(): Promise<void> {
    this.unwatch()
    this.items.clear()
    this.cachedItems.clear()
    this.listeners.clear()
    await rm(this.stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }

  private unwatch(): void {
    this.watchedSession?.removeListener('will-download', this.downloadHandler)
    this.watchedSession = undefined
  }

  private stageDownload(download: DownloadItem): void {
    const id = randomUUID()
    const fileName = safeFileName(download.getFilename())
    const sourceUrl = safeSourceUrl(download.getURL())
    const announcedBytes = Math.max(0, download.getTotalBytes())
    const item: PrivateQueueItem = {
      id,
      fileName,
      sourceUrl,
      receivedAt: Date.now(),
      sizeBytes: announcedBytes,
      status: 'downloading'
    }

    if (this.items.size >= MAX_QUEUE_ITEMS || this.currentBytes() + announcedBytes > MAX_QUEUE_BYTES) {
      download.cancel()
      item.status = 'failed'
      item.error = this.items.size >= MAX_QUEUE_ITEMS ? '挂起队列已达到 100 个文件上限。' : '挂起队列总大小不能超过 32 MB。'
      this.items.set(id, item)
      this.emit()
      return
    }
    if (announcedBytes > MAX_ITEM_BYTES) {
      download.cancel()
      item.status = 'failed'
      item.error = '单个 JSON 文件不能超过 4 MB。'
      this.items.set(id, item)
      this.emit()
      return
    }

    mkdirSync(this.stagingDirectory, { recursive: true, mode: 0o700 })
    hardenDirectory(this.stagingDirectory)
    const stagingPath = join(this.stagingDirectory, `${id}.json`)
    download.setSavePath(stagingPath)
    this.items.set(id, item)
    this.emit()

    download.once('done', (_event, state) => {
      void this.finishDownload(id, stagingPath, state)
    })
  }

  private async finishDownload(id: string, stagingPath: string, state: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) {
      await rm(stagingPath, { force: true }).catch(() => undefined)
      return
    }
    try {
      if (state !== 'completed') throw new Error(state === 'cancelled' ? '下载已取消。' : '下载未完成。')
      const info = await stat(stagingPath)
      if (!info.isFile()) throw new Error('下载结果不是普通文件。')
      if (info.size > MAX_ITEM_BYTES) throw new Error('单个 JSON 文件不能超过 4 MB。')
      if (this.currentBytes(id) + info.size > MAX_QUEUE_BYTES) throw new Error('挂起队列总大小不能超过 32 MB。')
      const content = await readFile(stagingPath, 'utf8')
      JSON.parse(content)
      item.content = content
      item.sizeBytes = info.size
      item.status = 'ready'
      delete item.error
      try {
        await this.cacheDownload(item)
      } catch (error) {
        item.error = `JSON 已挂起，但写入下载缓存失败：${queueErrorMessage(error)}`
      }
    } catch (error) {
      item.status = 'failed'
      item.sizeBytes = 0
      delete item.content
      item.error = queueErrorMessage(error)
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined)
      this.emit()
    }
  }

  private currentBytes(excludeId?: string): number {
    let total = 0
    for (const item of this.items.values()) {
      if (item.id !== excludeId) total += item.sizeBytes
    }
    return total
  }

  private async cacheDownload(item: PrivateQueueItem): Promise<void> {
    if (typeof item.content !== 'string') throw new Error('下载缓存内容不可用。')
    requireCacheEncryption()
    mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 })
    hardenDirectory(this.cacheDirectory)
    const fileName = jsonFileName(item.fileName)
    const cachePath = join(this.cacheDirectory, `${item.receivedAt}--${item.id}--${fileName}${ENCRYPTED_CACHE_SUFFIX}`)
    const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
    const encrypted = safeStorage.encryptString(item.content)
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, cachePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
    this.cachedItems.set(item.id, {
      id: item.id,
      fileName,
      receivedAt: item.receivedAt,
      sizeBytes: item.sizeBytes,
      path: cachePath
    })
    this.pruneCache()
  }

  private loadCache(): void {
    for (const fileName of readdirSync(this.cacheDirectory)) {
      const encrypted = fileName.endsWith(ENCRYPTED_CACHE_SUFFIX)
      const logicalName = encrypted ? fileName.slice(0, -ENCRYPTED_CACHE_SUFFIX.length) : fileName
      const parsed = parseCachedFileName(logicalName)
      if (!parsed) continue
      let path = join(this.cacheDirectory, fileName)
      try {
        const info = statSync(path)
        if (!info.isFile() || info.size > (encrypted ? MAX_ENCRYPTED_ITEM_BYTES : MAX_ITEM_BYTES)) {
          rmSync(path, { force: true })
          continue
        }
        if (!encrypted) path = this.migrateLegacyCacheFile(path)
        const plaintext = this.decryptCacheFile(path)
        JSON.parse(plaintext)
        const sizeBytes = Buffer.byteLength(plaintext, 'utf8')
        if (sizeBytes > MAX_ITEM_BYTES) throw new Error('缓存 JSON 超过大小上限。')
        this.cachedItems.set(parsed.id, { ...parsed, sizeBytes, path })
      } catch {
        // Never retain unreadable or legacy plaintext credential files.
        rmSync(path, { force: true })
      }
    }
    this.pruneCache()
  }

  private migrateLegacyCacheFile(path: string): string {
    requireCacheEncryption()
    const plaintext = readFileSync(path, 'utf8')
    JSON.parse(plaintext)
    const encryptedPath = `${path}${ENCRYPTED_CACHE_SUFFIX}`
    const temporaryPath = `${encryptedPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, safeStorage.encryptString(plaintext), { mode: 0o600, flag: 'wx' })
      renameSync(temporaryPath, encryptedPath)
      rmSync(path, { force: true })
      return encryptedPath
    } catch (error) {
      rmSync(temporaryPath, { force: true })
      throw error
    }
  }

  private decryptCacheFile(path: string): string {
    requireCacheEncryption()
    return safeStorage.decryptString(readFileSync(path))
  }

  private pruneCache(): void {
    const ordered = [...this.cachedItems.values()].sort((left, right) => right.receivedAt - left.receivedAt)
    let keptItems = 0
    let keptBytes = 0
    for (const item of ordered) {
      if (keptItems < MAX_CACHE_ITEMS && keptBytes + item.sizeBytes <= MAX_CACHE_BYTES) {
        keptItems += 1
        keptBytes += item.sizeBytes
        continue
      }
      rmSync(item.path, { force: true })
      this.cachedItems.delete(item.id)
    }
  }

  private emit(): void {
    this.revision += 1
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

function isJsonDownload(download: DownloadItem): boolean {
  return extname(download.getFilename()).toLowerCase() === '.json' || /(?:^|\/)json(?:;|$)/i.test(download.getMimeType())
}

function safeFileName(value: string): string {
  const withoutControls = Array.from(value.normalize('NFKC'))
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
  const normalized = withoutControls.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 120)
  return normalized || 'download.json'
}

function jsonFileName(value: string): string {
  const safe = safeFileName(value)
  return extname(safe).toLowerCase() === '.json' ? safe : `${safe}.json`
}

function parseCachedFileName(value: string): Omit<PrivateCacheItem, 'path' | 'sizeBytes'> | undefined {
  const match = /^(\d{10,})--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--(.+)$/i.exec(value)
  if (!match) return undefined
  const receivedAt = Number(match[1])
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return undefined
  return { id: match[2], receivedAt, fileName: jsonFileName(match[3]) }
}

function safeSourceUrl(value: string): string {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 500)
  } catch {
    return ''
  }
}

function queueErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/JSON|Unexpected token|Unexpected end/i.test(message)) return '下载内容不是有效 JSON。'
  return message.slice(0, 240)
}

function requireCacheEncryption(): void {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux'
        || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
  } catch {
    available = false
  }
  if (!available) throw new Error('系统凭据保险库不可用，下载 JSON 不会持久化到磁盘。')
}

function hardenDirectory(path: string): void {
  if (process.platform === 'win32') return
  try { chmodSync(path, 0o700) } catch { /* best-effort; file encryption remains mandatory */ }
}
