import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stone-codex-version-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
  vi.resetModules()
})

describe('Codex client identity version sync', () => {
  it('accepts only stable semantic versions', async () => {
    const { normalizeStableCodexVersion } = await import('../../src/main/providers/codex-client-version')
    expect(normalizeStableCodexVersion('0.146.0')).toBe('0.146.0')
    expect(normalizeStableCodexVersion(' 0.146.0 ')).toBe('0.146.0')
    expect(normalizeStableCodexVersion('0.147.0-beta.1')).toBeUndefined()
    expect(normalizeStableCodexVersion('rust-v0.146.0')).toBeUndefined()
  })

  it('loads last-known-good state before network refresh', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'codex-client-version.json'), '{"version":"0.145.2"}\n')
    const module = await import('../../src/main/providers/codex-client-version')
    const service = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation: vi.fn(async () => { throw new Error('offline') }),
      logger: { warn: vi.fn() },
    })
    expect(await service.initialize()).toBe('0.145.2')
    expect(module.getChatGptCodexModelsUrl()).toContain('client_version=0.145.2')
    expect(await service.refresh()).toBe('0.145.2')
  })

  it('ignores an oversized local state file without delaying startup', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'codex-client-version.json'), 'x'.repeat(20 * 1024))
    const module = await import('../../src/main/providers/codex-client-version')
    const warn = vi.fn()
    const service = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation: vi.fn(async () => { throw new Error('offline') }),
      logger: { warn },
    })

    expect(await service.initialize()).toBe(module.BUNDLED_CODEX_CLIENT_VERSION)
    expect(warn).toHaveBeenCalledWith('[codex-version] Ignoring an invalid last-known-good version file.')
  })

  it('promotes only the newest stable rust release and persists it atomically', async () => {
    const directory = await temporaryDirectory()
    const module = await import('../../src/main/providers/codex-client-version')
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify([
      { tag_name: 'rust-v0.146.0', draft: false, prerelease: false },
      { tag_name: 'rust-v0.147.0-beta.1', draft: false, prerelease: false },
      { tag_name: 'rust-v0.145.1', draft: false, prerelease: false },
      { tag_name: 'rust-v9.0.0', draft: true, prerelease: false },
    ]), { status: 200 }))
    const service = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation,
      logger: { warn: vi.fn() },
    })
    expect(await service.initialize()).toBe(module.BUNDLED_CODEX_CLIENT_VERSION)
    expect(await service.refresh()).toBe('0.146.0')
    expect(JSON.parse(await readFile(join(directory, 'codex-client-version.json'), 'utf8')))
      .toEqual({ version: '0.146.0' })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('singleflights concurrent refreshes and never downgrades', async () => {
    const directory = await temporaryDirectory()
    const module = await import('../../src/main/providers/codex-client-version')
    let release!: (response: Response) => void
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    const service = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation,
      logger: { warn: vi.fn() },
    })
    const first = service.refresh()
    const second = service.refresh()
    expect(fetchImplementation).toHaveBeenCalledOnce()
    release(new Response(JSON.stringify([{ tag_name: 'rust-v0.146.0' }]), { status: 200 }))
    expect(await Promise.all([first, second])).toEqual(['0.146.0', '0.146.0'])

    const older = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify([
        { tag_name: 'rust-v0.145.0' },
      ]), { status: 200 })),
      logger: { warn: vi.fn() },
    })
    expect(await older.refresh()).toBe('0.146.0')
  })

  it('rejects an oversized releases response and keeps the known version', async () => {
    const directory = await temporaryDirectory()
    const module = await import('../../src/main/providers/codex-client-version')
    const warn = vi.fn()
    const service = new module.CodexClientVersionSyncService({
      userDataPath: directory,
      fetchImplementation: vi.fn(async () => new Response('[' + ' '.repeat(1024 * 1024) + ']')),
      logger: { warn },
    })

    expect(await service.refresh()).toBe(module.BUNDLED_CODEX_CLIENT_VERSION)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Version sync failed'),
      expect.stringContaining('safe size limit'),
    )
  })
})
