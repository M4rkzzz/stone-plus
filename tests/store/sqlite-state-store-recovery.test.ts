import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, ''),
  },
}))

import { AppStore } from '../../src/main/store/app-store'
import { SQLITE_DATABASE_FILENAME } from '../../src/main/store/sqlite-state-store'

const SCRUB_MARKER_KEY = 'physical_secret_scrub_v1'
const JOURNAL_SUFFIX = '.replace-journal-v1.json'
const REPLACEMENT_ID = '01234567-89ab-4cde-8fab-0123456789ab'

describe('SQLite physical cleanup and replacement recovery', () => {
  let directory: string
  const openStores: AppStore[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stone-sqlite-recovery-'))
  })

  afterEach(async () => {
    await Promise.allSettled(openStores.splice(0).map((store) => store.close()))
    await rm(directory, { recursive: true, force: true })
  })

  it('physically scrubs legacy deleted content once after logical startup sanitation', async () => {
    const store = track(new AppStore(directory))
    await store.initialize()
    await closeTracked(store)

    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const legacySecret = 'legacy-deleted-secret-raw-page-marker'
    const legacyValue = `${legacySecret}-${'z'.repeat(8_192)}`
    const database = new DatabaseSync(databasePath)
    database.exec('PRAGMA secure_delete = OFF')
    database.prepare('DELETE FROM app_metadata WHERE key = ?').run(SCRUB_MARKER_KEY)
    database.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
      .run('legacy_deleted_secret_test', legacyValue)
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    database.prepare('DELETE FROM app_metadata WHERE key = ?').run('legacy_deleted_secret_test')
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    database.close()
    expect((await readFile(databasePath)).includes(Buffer.from(legacySecret))).toBe(true)

    const restarted = track(new AppStore(directory))
    await restarted.initialize()
    await closeTracked(restarted)

    expect((await readFile(databasePath)).includes(Buffer.from(legacySecret))).toBe(false)
    const inspected = new DatabaseSync(databasePath, { readOnly: true })
    expect(inspected.prepare('SELECT value FROM app_metadata WHERE key = ?').get(SCRUB_MARKER_KEY))
      .toEqual({ value: '1' })
    inspected.close()
  })

  it('rolls back an interrupted replacement when the old database was moved but the candidate was not installed', async () => {
    const snapshots = await createDatabaseSnapshots()
    const paths = replacementPaths(snapshots.databasePath)
    await copyFile(snapshots.oldPath, snapshots.databasePath)
    await copyFile(snapshots.newPath, paths.candidatePath)
    await rename(snapshots.databasePath, paths.previousPath)
    await writeJournal(paths.journalPath, snapshots.newPath, snapshots.oldPath)

    const recovered = track(new AppStore(directory))
    await recovered.initialize()

    expect(recovered.getSnapshot().gateway.port).toBe(16_001)
    await expectMissing(paths.journalPath)
    await expectMissing(paths.candidatePath)
    await expectMissing(paths.previousPath)
  })

  it('accepts an integrity- and digest-verified installed generation and removes only its journal artifacts', async () => {
    const snapshots = await createDatabaseSnapshots()
    const paths = replacementPaths(snapshots.databasePath)
    await copyFile(snapshots.oldPath, paths.previousPath)
    await copyFile(snapshots.newPath, snapshots.databasePath)
    await writeJournal(paths.journalPath, snapshots.newPath, snapshots.oldPath)

    const recovered = track(new AppStore(directory))
    await recovered.initialize()

    expect(recovered.getSnapshot().gateway.port).toBe(16_002)
    await expectMissing(paths.journalPath)
    await expectMissing(paths.previousPath)
  })

  it('fails closed on an invalid journal before a missing live path can be initialized as an empty database', async () => {
    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    await writeFile(`${databasePath}${JOURNAL_SUFFIX}`, '{"version":1,"id":"invalid"}', { mode: 0o600 })
    const store = track(new AppStore(directory))

    await expect(store.initialize()).rejects.toThrow(/replacement journal is invalid/i)
    await expectMissing(databasePath)
  })

  it('does not guess from an unjournaled previous file when the canonical database is missing', async () => {
    const snapshots = await createDatabaseSnapshots()
    const paths = replacementPaths(snapshots.databasePath)
    await rename(snapshots.databasePath, paths.previousPath)
    const store = track(new AppStore(directory))

    await expect(store.initialize()).rejects.toThrow(/unjournaled replacement artifacts.*empty database/i)
    await expectMissing(snapshots.databasePath)
    expect((await readdir(dirname(snapshots.databasePath))).map((entry) => entry.toLowerCase()))
      .toContain(basename(paths.previousPath).toLowerCase())
  })

  async function createDatabaseSnapshots(): Promise<{
    databasePath: string
    oldPath: string
    newPath: string
  }> {
    const databasePath = join(directory, SQLITE_DATABASE_FILENAME)
    const oldPath = join(directory, 'old-generation.sqlite3')
    const newPath = join(directory, 'new-generation.sqlite3')
    const oldStore = track(new AppStore(directory))
    await oldStore.initialize()
    await oldStore.updateGateway(gatewaySettings(16_001))
    await closeTracked(oldStore)
    await copyFile(databasePath, oldPath)

    const newStore = track(new AppStore(directory))
    await newStore.initialize()
    await newStore.updateGateway(gatewaySettings(16_002))
    await closeTracked(newStore)
    await copyFile(databasePath, newPath)
    return { databasePath, oldPath, newPath }
  }

  function track(store: AppStore): AppStore {
    openStores.push(store)
    return store
  }

  async function closeTracked(store: AppStore): Promise<void> {
    await store.close()
    const index = openStores.indexOf(store)
    if (index >= 0) openStores.splice(index, 1)
  }
})

function replacementPaths(databasePath: string): {
  journalPath: string
  candidatePath: string
  previousPath: string
} {
  const directory = dirname(databasePath)
  const fileName = basename(databasePath)
  return {
    journalPath: `${databasePath}${JOURNAL_SUFFIX}`,
    candidatePath: join(directory, `.${fileName}.${REPLACEMENT_ID}.candidate`),
    previousPath: join(directory, `.${fileName}.${REPLACEMENT_ID}.previous`),
  }
}

async function writeJournal(journalPath: string, candidatePath: string, previousPath: string): Promise<void> {
  await writeFile(journalPath, JSON.stringify({
    version: 1,
    id: REPLACEMENT_ID,
    hadPrevious: true,
    candidateSha256: await sha256(candidatePath),
    previousSha256: await sha256(previousPath),
    createdAt: Date.now(),
  }), { mode: 0o600 })
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

function gatewaySettings(port: number) {
  return {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 120,
  } as const
}
