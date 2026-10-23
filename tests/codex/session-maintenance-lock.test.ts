import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireCodexSessionMaintenanceLock } from '../../src/main/codex/session-maintenance-lock'

describe('Codex session maintenance lock', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

  it('atomically quarantines a stale lock so concurrent contenders cannot delete a fresh owner', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'stone-session-lock-'))
    directories.push(codexHome)
    const lockPath = join(codexHome, 'tmp', 'provider-sync.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'stone-owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'stale-owner',
      operation: 'repair',
      createdAt: new Date(0).toISOString(),
    }))

    const contenders = await Promise.allSettled([
      acquireCodexSessionMaintenanceLock(codexHome, 'repair-a', new Date(), 'owner-a'),
      acquireCodexSessionMaintenanceLock(codexHome, 'repair-b', new Date(), 'owner-b'),
    ])
    const winners = contenders.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled')
    const losers = contenders.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(String(losers[0].reason)).toContain('正在维护 Codex 会话')
    await winners[0].value()
  })
})
