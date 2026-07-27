import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const LOCK_NAME = 'provider-sync.lock'

interface LockOwner {
  pid: number
  token: string
  operation: string
  createdAt: string
}

export async function acquireCodexSessionMaintenanceLock(
  codexHome: string,
  operation: string,
  now: Date,
  token: string,
): Promise<() => Promise<void>> {
  const lockPath = join(codexHome, 'tmp', LOCK_NAME)
  const ownerPath = join(lockPath, 'stone-owner.json')
  const compatibleOwnerPath = join(lockPath, 'owner.json')
  await mkdir(dirname(lockPath), { recursive: true })
  const owner: LockOwner = { pid: process.pid, token, operation, createdAt: now.toISOString() }
  const quarantinePath = `${lockPath}.stale-${process.pid}-${token.replace(/[^A-Za-z0-9_-]/g, '')}`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath, { recursive: false })
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<LockOwner>
          if (current.token === token && current.pid === process.pid) {
            await rm(lockPath, { recursive: true, force: true })
          }
        } catch {
          // Never remove a lock whose ownership can no longer be proven.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stale = await staleMaintenanceLockOwner([ownerPath, compatibleOwnerPath])
      if (!stale) {
        throw new Error('另一个 Stone+ / Codex++ 实例正在维护 Codex 会话，请稍后重试。')
      }
      try {
        // Atomically detach the stale directory before deleting it. Removing
        // the observed path directly has a TOCTOU window where another Stone+
        // process can acquire a fresh lock that this process then deletes.
        await rename(lockPath, quarantinePath)
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      await rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  throw new Error('无法获取 Codex 会话维护锁。')
}

async function staleMaintenanceLockOwner(ownerPaths: string[]): Promise<boolean> {
  let foundOwner = false
  for (const ownerPath of ownerPaths) {
    try {
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<LockOwner> & { startedAt?: number }
      if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) continue
      foundOwner = true
      // Both Stone+ (stone-owner.json) and Codex++ (owner.json) publish a PID.
      // A live PID always wins; malformed or ownerless foreign locks remain
      // conservative and are never removed automatically.
      if (processIsAlive(owner.pid)) return false
    } catch {
      // Try the other compatible owner format.
    }
  }
  return foundOwner
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
