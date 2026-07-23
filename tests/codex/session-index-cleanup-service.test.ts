import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSessionIndexCleanupService } from '../../src/main/codex'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function indexLine(id: string, threadName: string, updatedAt = '2026-07-20T10:00:00Z'): string {
  return JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt })
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'stone-session-index-cleanup-'))
  temporaryDirectories.push(root)
  const codexHome = join(root, '.codex')
  const sessions = join(codexHome, 'sessions', '2026', '07', '20')
  const archived = join(codexHome, 'archived_sessions')
  const sqlite = join(codexHome, 'sqlite')
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(archived, { recursive: true }), mkdir(sqlite, { recursive: true })])

  const rolloutId = '01980a00-0000-7000-8000-000000000001'
  const filenameOnlyId = '01980a00-0000-7000-8000-000000000002'
  const threadId = '01980a00-0000-7000-8000-000000000003'
  const catalogId = '01980a00-0000-7000-8000-000000000004'
  const relationIds = [
    '01980a00-0000-7000-8000-000000000005',
    '01980a00-0000-7000-8000-000000000006',
    '01980a00-0000-7000-8000-000000000007',
    '01980a00-0000-7000-8000-000000000008',
    '01980a00-0000-7000-8000-000000000009',
    '01980a00-0000-7000-8000-00000000000a',
    '01980a00-0000-7000-8000-00000000000b',
    '01980a00-0000-7000-8000-00000000000c',
    '01980a00-0000-7000-8000-00000000000d',
    '01980a00-0000-7000-8000-00000000000e',
  ]
  const staleOne = '01980a00-0000-7000-8000-0000000000a1'
  const staleTwo = '01980a00-0000-7000-8000-0000000000a2'

  await writeFile(join(sessions, `rollout-2026-07-20T10-00-00-${rolloutId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    payload: { id: rolloutId, model_provider: 'stone' },
  }) + '\n')
  await writeFile(join(archived, `rollout-2026-07-19T10-00-00-${filenameOnlyId}.jsonl`), '{not-json}\n')

  const state = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY);')
  state.prepare('INSERT INTO threads (id) VALUES (?)').run(threadId)
  state.close()

  const relations = new DatabaseSync(join(sqlite, 'codex-dev.db'))
  relations.exec(`
    CREATE TABLE local_thread_catalog (thread_id TEXT);
    CREATE TABLE automation_runs (thread_id TEXT);
    CREATE TABLE inbox_items (thread_id TEXT);
    CREATE TABLE sessions (id TEXT);
    CREATE TABLE messages (session_id TEXT);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    CREATE TABLE agent_job_items (assigned_thread_id TEXT);
  `)
  relations.prepare('INSERT INTO local_thread_catalog VALUES (?)').run(catalogId)
  relations.prepare('INSERT INTO automation_runs VALUES (?)').run(relationIds[0])
  relations.prepare('INSERT INTO inbox_items VALUES (?)').run(relationIds[1])
  relations.prepare('INSERT INTO sessions VALUES (?)').run(relationIds[2])
  relations.prepare('INSERT INTO messages VALUES (?)').run(relationIds[3])
  relations.prepare('INSERT INTO thread_dynamic_tools VALUES (?)').run(relationIds[4])
  relations.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run(relationIds[6], relationIds[7])
  relations.prepare('INSERT INTO agent_job_items VALUES (?)').run(relationIds[9])
  relations.close()

  const goals = new DatabaseSync(join(codexHome, 'goals_1.sqlite'))
  goals.exec('CREATE TABLE thread_goals (thread_id TEXT);')
  goals.prepare('INSERT INTO thread_goals VALUES (?)').run(relationIds[5])
  goals.close()
  const memories = new DatabaseSync(join(codexHome, 'memories_1.sqlite'))
  memories.exec('CREATE TABLE stage1_outputs (thread_id TEXT);')
  memories.prepare('INSERT INTO stage1_outputs VALUES (?)').run(relationIds[8])
  memories.close()

  const unknownExtra = JSON.stringify({ id: 'future-id', thread_name: 'Future', updated_at: '2026-07-20T10:00:00Z', cloud: true })
  const malformed = '{broken-json}'
  const originalIndex = [
    indexLine(rolloutId, 'rollout'),
    indexLine(filenameOnlyId, 'filename'),
    indexLine(threadId, 'threads'),
    indexLine(catalogId, 'catalog'),
    ...relationIds.map((id) => indexLine(id, 'relation')),
    indexLine(staleOne, 'stale one'),
    indexLine(staleTwo, 'stale two'),
    unknownExtra,
    malformed,
  ].join('\r\n')
  const indexPath = join(codexHome, 'session_index.jsonl')
  await writeFile(indexPath, originalIndex)

  const blockingCodexPids = vi.fn(async () => [] as number[])
  const service = new CodexSessionIndexCleanupService({
    codexHome,
    now: () => new Date('2026-07-20T12:00:00Z'),
    randomId: () => 'fixed',
    blockingCodexPids,
  })
  return { service, codexHome, indexPath, originalIndex, staleOne, staleTwo, unknownExtra, malformed, blockingCodexPids }
}

describe('CodexSessionIndexCleanupService', () => {
  it('only previews IDs absent from every rollout and known SQLite reference source without writing', async () => {
    const { service, codexHome, staleOne, staleTwo } = await createFixture()

    const preview = await service.preview()

    expect(preview.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.candidates).toEqual([
      { id: staleOne, threadName: 'stale one', updatedAt: '2026-07-20T10:00:00Z' },
      { id: staleTwo, threadName: 'stale two', updatedAt: '2026-07-20T10:00:00Z' },
    ])
    await expect(readdir(join(codexHome, 'backups_state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only explicitly selected strict records and preserves bytes for unknown records', async () => {
    const { service, indexPath, originalIndex, staleOne, staleTwo, unknownExtra, malformed, blockingCodexPids } = await createFixture()
    const preview = await service.preview()

    const result = await service.apply(preview.snapshotSha256, [staleOne])

    expect(result).toMatchObject({ prunedEntries: 1 })
    expect(result.backupPath).toBeTruthy()
    const next = await readFile(indexPath, 'utf8')
    expect(next).not.toContain(staleOne)
    expect(next).toContain(staleTwo)
    expect(next).toContain(unknownExtra)
    expect(next).toContain(malformed)
    expect(await readFile(join(result.backupPath!, 'session_index.jsonl'), 'utf8')).toBe(originalIndex)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      managedBy: 'Stone+ session index cleanup',
      prunedSessionIndexEntries: 1,
      selectedThreadIds: [staleOne],
    })
    expect(blockingCodexPids).toHaveBeenCalledTimes(2)
  })

  it('rejects a stale snapshot and a candidate that became live without creating a backup', async () => {
    const { service, codexHome, indexPath, staleOne } = await createFixture()
    const preview = await service.preview()
    await writeFile(indexPath, (await readFile(indexPath, 'utf8')) + '\n')
    await expect(service.apply(preview.snapshotSha256, [staleOne])).rejects.toThrow('预览后发生变化')
    await expect(readdir(join(codexHome, 'backups_state'))).rejects.toMatchObject({ code: 'ENOENT' })

    const refreshed = await service.preview()
    const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    database.prepare('INSERT INTO threads (id) VALUES (?)').run(staleOne)
    database.close()
    await expect(service.apply(refreshed.snapshotSha256, [staleOne])).rejects.toThrow('非候选任务')
  })

  it('rechecks desktop processes after backup and leaves the original untouched if one reappears', async () => {
    const fixture = await createFixture()
    const preview = await fixture.service.preview()
    fixture.blockingCodexPids.mockResolvedValueOnce([]).mockResolvedValueOnce([4321])

    await expect(fixture.service.apply(preview.snapshotSha256, [fixture.staleOne]))
      .rejects.toThrow('备份保留在')

    expect(await readFile(fixture.indexPath, 'utf8')).toBe(fixture.originalIndex)
    const backups = await readdir(join(fixture.codexHome, 'backups_state', 'stone-session-index-cleanup'))
    expect(backups).toHaveLength(1)
  })

  it('keeps the original and reports the backup when atomic replacement fails', async () => {
    const fixture = await createFixture()
    const preview = await fixture.service.preview()
    await mkdir(join(fixture.codexHome, `.session_index.jsonl.${process.pid}.fixed.tmp`))

    await expect(fixture.service.apply(preview.snapshotSha256, [fixture.staleOne]))
      .rejects.toThrow('原文件未被主动覆盖')

    expect(await readFile(fixture.indexPath, 'utf8')).toBe(fixture.originalIndex)
    const backups = await readdir(join(fixture.codexHome, 'backups_state', 'stone-session-index-cleanup'))
    expect(backups).toHaveLength(1)
  })
})
