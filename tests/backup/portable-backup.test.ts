import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decryptPortableBackup,
  encryptPortableBackup,
  inspectPortableBackup,
  recoverPortableBackupReplacements,
} from '../../src/main/backup'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('portable backups', () => {
  it('round trips an authenticated encrypted backup without plaintext leakage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const source = join(directory, 'source.sqlite3')
    const encrypted = join(directory, 'state.stonebackup')
    const restored = join(directory, 'restored.sqlite3')
    const plaintext = Buffer.from('SQLite format 3\0credential-secret-that-must-not-leak')
    await writeFile(source, plaintext)
    await encryptPortableBackup(source, encrypted, 'correct horse battery staple', () => 123_456)
    const wire = await readFile(encrypted)
    expect(wire.includes(Buffer.from('credential-secret-that-must-not-leak'))).toBe(false)
    await expect(inspectPortableBackup(encrypted)).resolves.toMatchObject({ version: 2, createdAt: 123_456 })
    await decryptPortableBackup(encrypted, restored, 'correct horse battery staple')
    expect(await readFile(restored)).toEqual(plaintext)
  })

  it('continues to read legacy v1 archives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const source = join(directory, 'source.sqlite3')
    const encrypted = join(directory, 'legacy.stonebackup')
    const restored = join(directory, 'restored.sqlite3')
    await writeFile(source, Buffer.from('legacy portable state'))
    await encryptPortableBackup(source, encrypted, 'legacy password', () => 55, 1)
    await expect(inspectPortableBackup(encrypted)).resolves.toMatchObject({ version: 1 })
    await decryptPortableBackup(encrypted, restored, 'legacy password')
    expect(await readFile(restored, 'utf8')).toBe('legacy portable state')
  })

  it('rejects an incorrect password without leaving output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const source = join(directory, 'source.sqlite3')
    const encrypted = join(directory, 'state.stonebackup')
    const restored = join(directory, 'restored.sqlite3')
    await writeFile(source, Buffer.from('SQLite format 3\0secret'))
    await encryptPortableBackup(source, encrypted, 'correct password')
    await expect(decryptPortableBackup(encrypted, restored, 'wrong password')).rejects.toThrow(/incorrect|damaged/i)
    await expect(readFile(restored)).rejects.toThrow()
  })

  it('safely replaces an existing export and removes rollback metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const recoveryDirectory = join(directory, 'replacement-journals')
    const source = join(directory, 'source.sqlite3')
    const encrypted = join(directory, 'state.stonebackup')
    const restored = join(directory, 'restored.sqlite3')
    await writeFile(source, Buffer.from('new portable database contents'))
    await writeFile(encrypted, Buffer.from('previous export that must be replaceable'))

    await encryptPortableBackup(
      source,
      encrypted,
      'replacement password',
      () => 987_654,
      2,
      recoveryDirectory,
    )

    await expect(inspectPortableBackup(encrypted)).resolves.toMatchObject({ createdAt: 987_654 })
    await decryptPortableBackup(encrypted, restored, 'replacement password')
    expect(await readFile(restored, 'utf8')).toBe('new portable database contents')
    expect(await readdir(recoveryDirectory)).toEqual([])
    expect((await readdir(directory)).filter((name) => /\.rollback$|\.tmp$/.test(name))).toEqual([])
  })

  it('serializes replacement recovery across concurrent exports sharing one journal directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const recoveryDirectory = join(directory, 'replacement-journals')
    const sourceA = join(directory, 'source-a.sqlite3')
    const sourceB = join(directory, 'source-b.sqlite3')
    const destinationA = join(directory, 'a.stonebackup')
    const destinationB = join(directory, 'b.stonebackup')
    await writeFile(sourceA, Buffer.alloc(256 * 1024, 0x41))
    await writeFile(sourceB, Buffer.alloc(256 * 1024, 0x42))
    await writeFile(destinationA, Buffer.from('old-a'))
    await writeFile(destinationB, Buffer.from('old-b'))

    await Promise.all([
      encryptPortableBackup(sourceA, destinationA, 'concurrent password', () => 100, 2, recoveryDirectory),
      encryptPortableBackup(sourceB, destinationB, 'concurrent password', () => 200, 2, recoveryDirectory),
    ])

    await expect(inspectPortableBackup(destinationA)).resolves.toMatchObject({ createdAt: 100 })
    await expect(inspectPortableBackup(destinationB)).resolves.toMatchObject({ createdAt: 200 })
    expect(await readdir(recoveryDirectory)).toEqual([])
  })

  it('recovers the original export when an interrupted replacement has no destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-portable-'))
    directories.push(directory)
    const recoveryDirectory = join(directory, 'replacement-journals')
    await mkdir(recoveryDirectory)
    const destinationPath = join(directory, 'state.stonebackup')
    const temporaryPath = join(directory, 'state.pending.tmp')
    const id = '0123456789abcdef01234567'
    const rollbackPath = `${destinationPath}.${id}.rollback`
    const journalPath = join(recoveryDirectory, `stone-portable-replace-${id}.json`)
    const original = Buffer.from('original portable export')
    await writeFile(rollbackPath, original)
    await writeFile(temporaryPath, Buffer.from('partially installed replacement'))
    const rollbackStat = await stat(rollbackPath)
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      id,
      destinationPath,
      temporaryPath,
      rollbackPath,
      originalSize: rollbackStat.size,
      originalMtimeMs: rollbackStat.mtimeMs,
      createdAt: Date.now(),
    }))

    await expect(recoverPortableBackupReplacements(recoveryDirectory)).resolves.toEqual({
      recovered: 1,
      failures: [],
    })
    expect(await readFile(destinationPath)).toEqual(original)
    await expect(readFile(temporaryPath)).rejects.toThrow()
    await expect(readFile(rollbackPath)).rejects.toThrow()
    await expect(readFile(journalPath)).rejects.toThrow()
  })
})
