import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebDavBackupService,
  WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY,
  type WebDavSafeStorage,
} from '../../src/main/backup'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WebDavBackupService', () => {
  it('persists only encrypted password metadata and never returns the secret', async () => {
    const harness = await createHarness()
    const saved = await harness.service.saveConfiguration({
      baseUrl: 'https://dav.example/stone',
      username: 'alice',
      password: 'super-secret-password',
    })
    expect(saved).toEqual({
      baseUrl: 'https://dav.example/stone/',
      username: 'alice',
      hasPassword: true,
      configured: true,
    })
    const raw = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(raw).not.toContain('super-secret-password')
    expect(raw).toContain(Buffer.from('super-secret-password').toString('base64'))
    expect(JSON.stringify(harness.service.getConfiguration())).not.toContain('password')

    await harness.service.saveConfiguration({ baseUrl: 'https://dav.example/stone/', username: 'alice' })
    expect(harness.service.getConfiguration().hasPassword).toBe(true)
  })

  it('uploads an encrypted portable backup while preserving its local backup', async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = []
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
      if (init?.body && Symbol.asyncIterator in Object(init.body)) {
        for await (const _chunk of init.body as unknown as AsyncIterable<Uint8Array>) { /* consume upload */ }
      }
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    const harness = await createHarness(fetchImplementation)
    await harness.service.saveConfiguration({ baseUrl: 'https://dav.example/stone/', username: 'alice', password: 'secret' })
    const result = await harness.service.uploadLatest('portable-password')
    expect(result.entry.name).toMatch(/\.stonebackup$/)
    expect(result.localBackup.path).toContain('backup.sqlite')
    expect(await readFile(result.localBackup.path, 'utf8')).toBe('local backup remains')
    expect(requests).toEqual([expect.objectContaining({ method: 'PUT', authorization: expect.stringMatching(/^Basic /) })])
    expect(await readdir(harness.temporaryDirectory)).toEqual([])
  })

  it('downloads a remote portable backup into local backup storage', async () => {
    const fetchImplementation = vi.fn(async () => new Response('encrypted portable bytes', {
      status: 200,
      headers: { 'content-length': '24' },
    })) as unknown as typeof fetch
    const harness = await createHarness(fetchImplementation)
    await harness.service.saveConfiguration({ baseUrl: 'https://dav.example/stone/', username: 'alice', password: 'secret' })
    const result = await harness.service.downloadAndImport('remote.stonebackup', 'portable-password')
    expect(result.entry.name).toBe('remote.stonebackup')
    expect(harness.importPortableBackup).toHaveBeenCalledWith(expect.stringMatching(/\.stonebackup$/), 'portable-password')
    expect(result.localBackup.integrity).toBe('valid')
    expect(await readdir(harness.temporaryDirectory)).toEqual([])
  })

  it('keeps the local backup when the optional remote upload fails', async () => {
    const fetchImplementation = vi.fn(async () => new Response('offline', { status: 503 })) as unknown as typeof fetch
    const harness = await createHarness(fetchImplementation)
    await harness.service.saveConfiguration({ baseUrl: 'https://dav.example/stone/', username: 'alice', password: 'secret' })
    await expect(harness.service.uploadLatest('portable-password')).rejects.toThrow(/503/)
    expect(await readFile(join(harness.backupDirectory, 'backup.sqlite'), 'utf8'))
      .toBe('local backup remains')
    expect(await readdir(harness.temporaryDirectory)).toEqual([])
  })

  it('removes the downloaded portable file when local import fails', async () => {
    const fetchImplementation = vi.fn(async () => new Response('encrypted portable bytes', {
      status: 200,
      headers: { 'content-length': '24' },
    })) as unknown as typeof fetch
    const harness = await createHarness(fetchImplementation)
    await harness.service.saveConfiguration({ baseUrl: 'https://dav.example/stone/', username: 'alice', password: 'secret' })
    harness.importPortableBackup.mockRejectedValueOnce(new Error('portable import failed'))

    await expect(harness.service.downloadAndImport('remote.stonebackup', 'portable-password'))
      .rejects.toThrow('portable import failed')
    expect(await readdir(harness.temporaryDirectory)).toEqual([])
  })

  it('rejects plaintext remote URLs before writing metadata', async () => {
    const harness = await createHarness()
    await expect(harness.service.saveConfiguration({ baseUrl: 'http://dav.example/stone' })).rejects.toThrow(/HTTPS/)
    expect(harness.metadata.size).toBe(0)
  })

  it('does not reuse a password after the server or username changes', async () => {
    const harness = await createHarness()
    await harness.service.saveConfiguration({
      baseUrl: 'https://dav.example/stone', username: 'alice', password: 'old-secret',
    })
    await expect(harness.service.saveConfiguration({
      baseUrl: 'https://other.example/stone', username: 'alice',
    })).rejects.toThrow(/password again/)
    await expect(harness.service.saveConfiguration({
      baseUrl: 'https://dav.example/stone', username: 'bob',
    })).rejects.toThrow(/password again/)
  })

  it('sanitizes and migrates legacy URL userinfo into protected fields', async () => {
    const harness = await createHarness()
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://alice:legacy-secret@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toEqual({
      baseUrl: 'https://dav.example/stone/', username: 'alice', hasPassword: true, configured: true,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).not.toContain('legacy-secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('drops conflicting legacy URL credentials and requires a new password', async () => {
    const harness = await createHarness()
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://legacy-user:legacy-secret@dav.example/stone',
      username: 'configured-user',
    }))
    expect(harness.service.getConfiguration()).toEqual({
      baseUrl: 'https://dav.example/stone/',
      username: 'configured-user',
      hasPassword: false,
      requiresPassword: true,
      configured: false,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).not.toContain('legacy-secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('sanitizes legacy userinfo even when credential encryption is unavailable', async () => {
    const harness = await createHarness(undefined, {
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('vault unavailable') },
        decryptString: () => { throw new Error('vault unavailable') },
      },
    })
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://legacy-user:legacy-secret@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toMatchObject({
      baseUrl: 'https://dav.example/stone/',
      username: 'legacy-user',
      hasPassword: false,
      requiresPassword: true,
      configured: false,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).not.toContain('legacy-secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('still removes legacy userinfo when vault encryption throws', async () => {
    const harness = await createHarness(undefined, {
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: () => { throw new Error('vault encryption failed') },
        decryptString: () => { throw new Error('vault decryption failed') },
      },
    })
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://legacy-user:legacy-secret@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toMatchObject({
      baseUrl: 'https://dav.example/stone/',
      username: 'legacy-user',
      hasPassword: false,
      requiresPassword: true,
      configured: false,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).not.toContain('legacy-secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('sanitizes malformed legacy URL encoding without retaining userinfo', async () => {
    const harness = await createHarness()
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://legacy%ZZ:secret%ZZ@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toMatchObject({
      baseUrl: 'https://dav.example/stone/',
      hasPassword: false,
      configured: false,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).not.toContain('secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('removes userinfo even when the remaining legacy URL is no longer allowed', async () => {
    const harness = await createHarness()
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'http://legacy-user:legacy-secret@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toEqual({
      baseUrl: '', username: '', hasPassword: false, configured: false,
    })
    await Promise.resolve()
    const persisted = harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY) ?? ''
    expect(persisted).toContain('http://dav.example/stone')
    expect(persisted).not.toContain('legacy-secret')
    expect(persisted).not.toContain('@dav.example')
  })

  it('deletes an unparseable legacy value that may contain URL credentials', async () => {
    const harness = await createHarness()
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://legacy-user:legacy-secret@',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toEqual({
      baseUrl: '', username: '', hasPassword: false, configured: false,
    })
    await Promise.resolve()
    expect(harness.metadata.has(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY)).toBe(false)
  })

  it('surfaces a failed legacy-userinfo cleanup instead of swallowing it', async () => {
    const harness = await createHarness(undefined, {
      writeAppMetadata: async () => { throw new Error('metadata disk is read-only') },
    })
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://alice:legacy-secret@dav.example/stone',
      username: '',
    }))
    expect(harness.service.getConfiguration()).toMatchObject({ baseUrl: 'https://dav.example/stone/' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(() => harness.service.getConfiguration()).toThrow(/legacy WebDAV credentials.*removed safely/i)
  })

  it('awaits one durable legacy cleanup before startup can continue', async () => {
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeAppMetadata = vi.fn(async (key: string, value: string, metadata: Map<string, string>) => {
      markWriteStarted()
      await writeGate
      metadata.set(key, value)
    })
    const harness = await createHarness(undefined, { writeAppMetadata })
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://alice:legacy-secret@dav.example/stone',
      username: '',
    }))

    let startupReady = false
    const first = harness.service.prepareForStartup().then(() => { startupReady = true })
    const second = harness.service.prepareForStartup()
    await writeStarted
    expect(startupReady).toBe(false)
    expect(harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY)).toContain('legacy-secret')
    releaseWrite()
    await Promise.all([first, second])

    expect(writeAppMetadata).toHaveBeenCalledTimes(1)
    expect(harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY)).not.toContain('legacy-secret')
  })

  it('blocks with a safe error and retries legacy cleanup on the next explicit preparation', async () => {
    let attempts = 0
    const harness = await createHarness(undefined, {
      writeAppMetadata: async (key, value, metadata) => {
        attempts += 1
        if (attempts === 1) throw new Error('disk error echoed legacy-secret')
        metadata.set(key, value)
      },
    })
    harness.metadata.set(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY, JSON.stringify({
      version: 1,
      baseUrl: 'https://alice:legacy-secret@dav.example/stone',
      username: '',
    }))
    const startAutomaticBackups = vi.fn()
    const error = await harness.service.prepareForStartup()
      .then(startAutomaticBackups)
      .catch((cause: unknown) => cause)

    expect(startAutomaticBackups).not.toHaveBeenCalled()
    expect(String(error)).toMatch(/before creating database backups/i)
    expect(String(error)).not.toContain('legacy-secret')
    await expect(harness.service.prepareForRawBackup()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(harness.metadata.get(WEB_DAV_BACKUP_CONFIGURATION_METADATA_KEY)).not.toContain('legacy-secret')
  })
})

async function createHarness(fetchImplementation?: typeof fetch, overrides: {
  safeStorage?: WebDavSafeStorage
  writeAppMetadata?: (key: string, value: string, metadata: Map<string, string>) => Promise<void>
} = {}) {
  const directory = join(tmpdir(), `stone-webdav-${crypto.randomUUID()}`)
  directories.push(directory)
  const backupDirectory = join(directory, 'backups')
  const temporaryDirectory = join(directory, 'transfer')
  await mkdir(backupDirectory, { recursive: true })
  const metadata = new Map<string, string>()
  const exportPortableBackup = vi.fn(async (destinationPath: string) => {
    await writeFile(destinationPath, 'encrypted portable bytes')
    const localPath = join(backupDirectory, 'backup.sqlite')
    await writeFile(localPath, 'local backup remains')
    return { backup: { id: 'backup.sqlite', kind: 'manual' as const, createdAt: 100, sizeBytes: 20, valid: true } }
  })
  const importPortableBackup = vi.fn(async () => {
    const localPath = join(backupDirectory, 'imported.sqlite')
    await writeFile(localPath, 'imported')
    return { id: 'imported.sqlite', kind: 'manual' as const, createdAt: 200, sizeBytes: 8, valid: true }
  })
  const service = new WebDavBackupService({
    metadata: {
      readAppMetadata: (key) => metadata.get(key),
      writeAppMetadata: async (key, value) => {
        const write = overrides.writeAppMetadata
        if (write) await write(key, value, metadata)
        else metadata.set(key, value)
      },
      removeAppMetadata: async (key) => { metadata.delete(key) },
    },
    safeStorage: overrides.safeStorage ?? {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    },
    backups: { exportPortableBackup, importPortableBackup },
    backupDirectory,
    temporaryDirectory,
    fetchImplementation,
    now: () => Date.parse('2026-07-22T10:00:00.000Z'),
    randomId: () => 'test-id',
  })
  return { service, metadata, exportPortableBackup, importPortableBackup, backupDirectory, temporaryDirectory }
}
