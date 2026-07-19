import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import { BrowserImportQueue } from '../src/main/browser-import-queue'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('BrowserImportQueue', () => {
  it('keeps a downloaded JSON in memory and in the persistent save-as cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-browser-import-'))
    temporaryDirectories.push(root)
    const browserSession = new EventEmitter()
    const cacheDirectory = join(root, 'cache')
    const queue = new BrowserImportQueue(join(root, 'staging'), cacheDirectory)
    queue.watch(browserSession as unknown as Session)
    const download = new FakeDownload('accounts.json', 'application/json', 'https://aiprobe.top/download?token=secret')

    browserSession.emit('will-download', {}, download)
    expect(download.savePath).toMatch(/\.json$/)
    await writeFile(download.savePath, JSON.stringify({ access_token: 'test-token' }), 'utf8')
    download.emit('done', {}, 'completed')
    await waitFor(() => queue.getState().readyCount === 1)

    expect(queue.getState()).toMatchObject({
      readyCount: 1,
      items: [expect.objectContaining({ fileName: 'accounts.json', sourceUrl: 'https://aiprobe.top/download', status: 'ready' })]
    })
    expect(queue.getReadyItems(queue.getState().items.map((item) => item.id))[0].content).toContain('test-token')
    const cached = queue.getCacheState().items[0]
    expect(cached).toMatchObject({ fileName: 'accounts.json', sizeBytes: expect.any(Number) })
    const savedPath = join(root, 'saved.json')
    await queue.saveCachedItem(cached.id, savedPath)
    expect(await readFile(savedPath, 'utf8')).toContain('test-token')
    await queue.close()

    const restarted = new BrowserImportQueue(join(root, 'staging-restarted'), cacheDirectory)
    expect(restarted.getState().readyCount).toBe(0)
    expect(restarted.getCacheState().items).toEqual([expect.objectContaining({ fileName: 'accounts.json' })])
    await restarted.close()
  })

  it('marks invalid JSON as failed instead of exposing it for import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-browser-import-'))
    temporaryDirectories.push(root)
    const browserSession = new EventEmitter()
    const queue = new BrowserImportQueue(join(root, 'staging'))
    queue.watch(browserSession as unknown as Session)
    const download = new FakeDownload('broken.json', 'application/octet-stream', 'https://aiprobe.top/broken.json')

    browserSession.emit('will-download', {}, download)
    await writeFile(download.savePath, '{broken', 'utf8')
    download.emit('done', {}, 'completed')
    await waitFor(() => queue.getState().items[0]?.status === 'failed')

    expect(queue.getState().items[0]).toMatchObject({ status: 'failed', error: '下载内容不是有效 JSON。' })
    expect(() => queue.getReadyItems([queue.getState().items[0].id])).toThrow('尚未下载完成')
    expect(queue.getCacheState().items).toHaveLength(0)
    await queue.close()
  })
})

class FakeDownload extends EventEmitter {
  public savePath = ''
  public cancelled = false

  public constructor(
    private readonly fileName: string,
    private readonly mimeType: string,
    private readonly url: string
  ) {
    super()
  }

  public getFilename(): string { return this.fileName }
  public getMimeType(): string { return this.mimeType }
  public getURL(): string { return this.url }
  public getTotalBytes(): number { return 0 }
  public setSavePath(path: string): void { this.savePath = path }
  public cancel(): void { this.cancelled = true }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for queue state')
}
