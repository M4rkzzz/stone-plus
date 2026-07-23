import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function pathStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function atomicWriteFile(
  targetPath: string,
  content: string | Uint8Array,
  randomId: () => string,
  containsCredential = false,
): Promise<void> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await pathStat(targetPath)
  const temporaryPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomId()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  let closed = false
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    closed = true
    if (process.platform !== 'win32') {
      const targetMode = containsCredential ? 0o600 : (existing?.mode ?? 0o600) & 0o777
      await chmod(temporaryPath, targetMode)
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function copyExclusive(sourcePath: string, destinationPath: string): Promise<void> {
  const content = await readFile(sourcePath)
  const handle = await open(destinationPath, 'wx', 0o600)
  let closed = false
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    closed = true
    if (process.platform !== 'win32') await chmod(destinationPath, 0o600)
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined)
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw error
  }
}
