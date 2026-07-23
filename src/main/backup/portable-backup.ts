import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { COPYFILE_EXCL } from 'node:constants'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
const HEADER_BYTES = 512
const MAGIC = 'STONEPB1'
const MIN_PASSWORD_LENGTH = 8
const REPLACE_JOURNAL_PREFIX = 'stone-portable-replace-'
const replacementFlights = new Map<string, Promise<void>>()

interface PortableReplaceJournal {
  version: 1
  id: string
  destinationPath: string
  temporaryPath: string
  rollbackPath: string
  originalSize: number
  originalMtimeMs: number
  createdAt: number
}

export interface PortableReplacementRecoveryResult {
  recovered: number
  failures: Array<{ journalPath: string; error: string }>
}

interface PortableBackupHeaderBase {
  format: 'stone-portable-backup'
  version: 1 | 2
  cipher: 'aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
  createdAt: number
}

interface PortableBackupHeader extends PortableBackupHeaderBase {
  tag: string
}

export interface PortableBackupInfo {
  format: 'stone-portable-backup'
  version: 1 | 2
  createdAt: number
  sizeBytes: number
}

export async function encryptPortableBackup(
  sourcePath: string,
  destinationPath: string,
  password: string,
  now: () => number = Date.now,
  version: 1 | 2 = 2,
  replacementRecoveryDirectory?: string,
): Promise<PortableBackupInfo> {
  assertPassword(password)
  await requireRegularNonEmptyFile(sourcePath)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const headerBase: PortableBackupHeaderBase = {
    format: 'stone-portable-backup',
    version,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    createdAt: now()
  }
  const aad = Buffer.from(JSON.stringify(headerBase), 'utf8')
  const key = await deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    await handle.write(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0)
    await handle.close()
    await pipeline(
      createReadStream(sourcePath),
      cipher,
      createWriteStream(temporaryPath, { flags: 'r+', start: HEADER_BYTES })
    )
    const header: PortableBackupHeader = { ...headerBase, tag: cipher.getAuthTag().toString('base64url') }
    const headerBytes = encodeHeader(header)
    const output = await open(temporaryPath, 'r+')
    try {
      await output.write(headerBytes, 0, headerBytes.length, 0)
      await output.sync()
    } finally {
      await output.close()
    }
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
    await atomicReplace(temporaryPath, destinationPath, replacementRecoveryDirectory)
    const file = await stat(destinationPath)
    return { format: header.format, version: header.version, createdAt: header.createdAt, sizeBytes: Number(file.size) }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    key.fill(0)
  }
}

export async function decryptPortableBackup(
  sourcePath: string,
  destinationPath: string,
  password: string
): Promise<PortableBackupInfo> {
  assertPassword(password)
  const file = await requireRegularNonEmptyFile(sourcePath)
  if (file.size <= HEADER_BYTES) throw new Error('Portable backup payload is empty')
  const header = await readHeader(sourcePath)
  const headerBase: PortableBackupHeaderBase = {
    format: header.format,
    version: header.version,
    cipher: header.cipher,
    kdf: header.kdf,
    salt: header.salt,
    iv: header.iv,
    createdAt: header.createdAt
  }
  const salt = decodeFixed(header.salt, 16, 'salt')
  const iv = decodeFixed(header.iv, 12, 'iv')
  const tag = decodeFixed(header.tag, 16, 'authentication tag')
  const key = await deriveKey(password, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(JSON.stringify(headerBase), 'utf8'))
  decipher.setAuthTag(tag)
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await pipeline(
      createReadStream(sourcePath, { start: HEADER_BYTES }),
      decipher,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    )
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, destinationPath)
    return { format: header.format, version: header.version, createdAt: header.createdAt, sizeBytes: Number(file.size) }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (isAuthenticationError(error)) throw new Error('Portable backup password is incorrect or the file is damaged')
    throw error
  } finally {
    key.fill(0)
  }
}

export async function inspectPortableBackup(path: string): Promise<PortableBackupInfo> {
  const file = await requireRegularNonEmptyFile(path)
  const header = await readHeader(path)
  return { format: header.format, version: header.version, createdAt: header.createdAt, sizeBytes: Number(file.size) }
}

async function readHeader(path: string): Promise<PortableBackupHeader> {
  const handle = await open(path, 'r')
  const bytes = Buffer.alloc(HEADER_BYTES)
  try {
    const result = await handle.read(bytes, 0, HEADER_BYTES, 0)
    if (result.bytesRead !== HEADER_BYTES) throw new Error('Portable backup header is truncated')
  } finally {
    await handle.close()
  }
  const newline = bytes.indexOf(0x0a)
  if (newline < 0 || bytes.subarray(0, newline).toString('ascii') !== MAGIC) {
    throw new Error('File is not a Stone+ portable backup')
  }
  const terminator = bytes.indexOf(0, newline + 1)
  const jsonEnd = terminator < 0 ? HEADER_BYTES : terminator
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.subarray(newline + 1, jsonEnd).toString('utf8'))
  } catch {
    throw new Error('Portable backup header is invalid')
  }
  if (!isPortableHeader(parsed)) throw new Error('Unsupported portable backup format')
  return parsed
}

function encodeHeader(header: PortableBackupHeader): Buffer {
  const serialized = Buffer.from(`${MAGIC}\n${JSON.stringify(header)}`, 'utf8')
  if (serialized.length >= HEADER_BYTES) throw new Error('Portable backup header is too large')
  const output = Buffer.alloc(HEADER_BYTES)
  serialized.copy(output)
  return output
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey)
    )
  })
}

async function requireRegularNonEmptyFile(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  const file = await stat(path)
  if (!file.isFile() || file.size <= 0) throw new Error('Backup source must be a non-empty regular file')
  return file
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Portable backup password must contain at least ${MIN_PASSWORD_LENGTH} characters`)
  }
}

function decodeFixed(value: string, length: number, label: string): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== length) throw new Error(`Portable backup ${label} is invalid`)
  return decoded
}

function isPortableHeader(value: unknown): value is PortableBackupHeader {
  if (typeof value !== 'object' || value === null) return false
  const header = value as Partial<PortableBackupHeader>
  return header.format === 'stone-portable-backup'
    && (header.version === 1 || header.version === 2)
    && header.cipher === 'aes-256-gcm'
    && header.kdf === 'scrypt'
    && typeof header.salt === 'string'
    && typeof header.iv === 'string'
    && typeof header.tag === 'string'
    && typeof header.createdAt === 'number'
    && Number.isSafeInteger(header.createdAt)
}

async function atomicReplace(
  temporaryPath: string,
  destinationPath: string,
  replacementRecoveryDirectory?: string,
): Promise<void> {
  const destination = resolve(destinationPath)
  const recoveryDirectory = resolve(replacementRecoveryDirectory ?? dirname(destination))
  // Recovery scans operate on every journal in the shared directory. Keep the
  // scan and replacement journal lifecycle under one directory-wide lock so a
  // concurrent export cannot mistake another in-flight replacement for a
  // crashed operation and clean up its temporary files.
  await withReplacementLock(`recovery:${recoveryDirectory}`, () => withReplacementLock(`destination:${destination}`, async () => {
    const priorRecovery = await recoverPortableBackupReplacementsUnlocked(recoveryDirectory)
    for (const failure of priorRecovery.failures) {
      try {
        const unresolved = parseReplacementJournal(await readFile(failure.journalPath, 'utf8'), failure.journalPath)
        if (unresolved.destinationPath === destination) {
          throw new Error(`A previous portable backup replacement still requires recovery: ${failure.error}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('A previous portable backup replacement')) throw error
      }
    }

    const original = await regularFileStat(destination)
    if (!original) {
      await rename(temporaryPath, destination)
      await syncDirectory(dirname(destination))
      return
    }

    const id = randomBytes(12).toString('hex')
    const rollbackPath = `${destination}.${id}.rollback`
    const journalPath = join(recoveryDirectory, `${REPLACE_JOURNAL_PREFIX}${id}.json`)
    const journal: PortableReplaceJournal = {
      version: 1,
      id,
      destinationPath: destination,
      temporaryPath: resolve(temporaryPath),
      rollbackPath,
      originalSize: Number(original.size),
      originalMtimeMs: Number(original.mtimeMs),
      createdAt: Date.now(),
    }
    await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
    try {
      await copyFile(destination, rollbackPath, COPYFILE_EXCL)
      await syncFile(rollbackPath)
      await writeReplacementJournal(journalPath, journal)
    } catch (error) {
      try { await rm(rollbackPath, { force: true }) } catch (cleanupError) {
        throw new Error(
          `Unable to prepare portable replacement (${messageOf(error)}); `
          + `rollback cleanup also failed at ${rollbackPath}: ${messageOf(cleanupError)}`,
        )
      }
      throw error
    }

    let installed = false
    try {
      try {
        await rename(temporaryPath, destination)
      } catch (error) {
        if (!isWindowsReplacementError(error)) throw error
        const current = await regularFileStat(destination)
        if (!current || current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
          throw new Error('Portable backup destination changed while it was being replaced')
        }
        await rm(destination)
        await rename(temporaryPath, destination)
      }
      await syncDirectory(dirname(destination))
      await inspectPortableBackup(destination)
      installed = true
      await cleanupReplacement(journalPath, journal)
    } catch (error) {
      if (installed) {
        throw new Error(
          `Portable backup was written, but replacement cleanup failed; recovery journal: ${journalPath}. ${messageOf(error)}`,
        )
      }
      try {
        await recoverReplacement(journalPath, journal)
      } catch (recoveryError) {
        throw new Error(
          `Portable backup replacement failed (${messageOf(error)}); rollback also failed. `
          + `Original backup retained at ${rollbackPath}; recovery journal: ${journalPath}. ${messageOf(recoveryError)}`,
        )
      }
      throw error
    }
  }))
}

export async function recoverPortableBackupReplacements(
  recoveryDirectory: string,
): Promise<PortableReplacementRecoveryResult> {
  const directory = resolve(recoveryDirectory)
  return withReplacementLock(`recovery:${directory}`, () => recoverPortableBackupReplacementsUnlocked(directory))
}

async function recoverPortableBackupReplacementsUnlocked(
  recoveryDirectory: string,
): Promise<PortableReplacementRecoveryResult> {
  const result: PortableReplacementRecoveryResult = { recovered: 0, failures: [] }
  let entries
  try {
    entries = await readdir(recoveryDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    return { ...result, failures: [{ journalPath: recoveryDirectory, error: messageOf(error) }] }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(REPLACE_JOURNAL_PREFIX) || !entry.name.endsWith('.json')) continue
    const journalPath = join(recoveryDirectory, entry.name)
    try {
      const journal = parseReplacementJournal(await readFile(journalPath, 'utf8'), journalPath)
      await recoverReplacement(journalPath, journal)
      result.recovered += 1
    } catch (error) {
      result.failures.push({ journalPath, error: messageOf(error) })
    }
  }
  return result
}

async function recoverReplacement(journalPath: string, journal: PortableReplaceJournal): Promise<void> {
  validateReplacementPaths(journal, journalPath)
  const destination = await regularFileStat(journal.destinationPath)
  const temporary = await regularFileStat(journal.temporaryPath)
  const rollback = await regularFileStat(journal.rollbackPath)

  // The temporary file still existing means installation never completed. The
  // original destination is therefore authoritative when it remains present.
  if (destination && temporary) {
    await cleanupReplacement(journalPath, journal)
    return
  }
  if (destination && !temporary && await isPortableBackup(journal.destinationPath)) {
    await cleanupReplacement(journalPath, journal)
    return
  }
  if (!rollback || rollback.size !== journal.originalSize) {
    throw new Error(`Portable backup rollback is missing or damaged: ${journal.rollbackPath}`)
  }
  if (destination) await rm(journal.destinationPath)
  await rename(journal.rollbackPath, journal.destinationPath)
  await syncDirectory(dirname(journal.destinationPath))
  await rm(journal.temporaryPath, { force: true })
  await rm(journalPath, { force: true })
}

async function cleanupReplacement(journalPath: string, journal: PortableReplaceJournal): Promise<void> {
  await rm(journal.temporaryPath, { force: true })
  await rm(journal.rollbackPath, { force: true })
  await rm(journalPath, { force: true })
}

async function writeReplacementJournal(path: string, journal: PortableReplaceJournal): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
    await syncFile(temporary)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function parseReplacementJournal(value: string, journalPath: string): PortableReplaceJournal {
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch { throw new Error('Portable replacement journal is invalid JSON') }
  if (!parsed || typeof parsed !== 'object') throw new Error('Portable replacement journal is invalid')
  const candidate = parsed as Partial<PortableReplaceJournal>
  if (candidate.version !== 1 || typeof candidate.id !== 'string'
    || typeof candidate.destinationPath !== 'string' || typeof candidate.temporaryPath !== 'string'
    || typeof candidate.rollbackPath !== 'string' || typeof candidate.originalSize !== 'number'
    || typeof candidate.originalMtimeMs !== 'number' || typeof candidate.createdAt !== 'number') {
    throw new Error('Portable replacement journal is invalid')
  }
  const journal = candidate as PortableReplaceJournal
  validateReplacementPaths(journal, journalPath)
  return journal
}

function validateReplacementPaths(journal: PortableReplaceJournal, journalPath: string): void {
  if (!/^[0-9a-f]{24}$/.test(journal.id)
    || basename(journalPath) !== `${REPLACE_JOURNAL_PREFIX}${journal.id}.json`
    || !isAbsolute(journal.destinationPath) || !isAbsolute(journal.temporaryPath) || !isAbsolute(journal.rollbackPath)
    || dirname(journal.temporaryPath) !== dirname(journal.destinationPath)
    || dirname(journal.rollbackPath) !== dirname(journal.destinationPath)
    || journal.rollbackPath !== `${journal.destinationPath}.${journal.id}.rollback`
    || !Number.isSafeInteger(journal.originalSize) || journal.originalSize < 0
    || !Number.isFinite(journal.originalMtimeMs)) {
    throw new Error('Portable replacement journal paths are invalid')
  }
}

async function regularFileStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Portable backup path is not a regular file: ${path}`)
    return entry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function isPortableBackup(path: string): Promise<boolean> {
  try { await inspectPortableBackup(path); return true } catch { return false }
}

async function syncFile(path: string): Promise<void> {
  // FlushFileBuffers on Windows requires a handle opened for writing; a
  // read-only FileHandle.sync() fails with EPERM even for a writable file.
  const handle = await open(path, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Windows does not consistently allow directory handles to be fsynced.
  }
}

async function withReplacementLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = replacementFlights.get(key) ?? Promise.resolve()
  const pending = previous.then(operation, operation)
  const settled = pending.then(() => undefined, () => undefined)
  replacementFlights.set(key, settled)
  try { return await pending } finally {
    if (replacementFlights.get(key) === settled) replacementFlights.delete(key)
  }
}

function isWindowsReplacementError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /authenticate data|bad decrypt|unable to authenticate/i.test(message)
}

export const PORTABLE_BACKUP_EXTENSION = '.stonebackup'
