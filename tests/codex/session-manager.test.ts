import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionManager } from '../../src/main/codex'

describe('CodexSessionManager', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

  it('lists, searches, exports, trashes and restores rollouts with token statistics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions', '2026', '07', '22')
    await mkdir(sessionDirectory, { recursive: true })
    const sessionId = '01981234-1234-7123-8123-123456789abc'
    const rollout = join(sessionDirectory, `rollout-2026-07-22T00-00-00-${sessionId}.jsonl`)
    const records = [
      { timestamp: '2026-07-22T00:00:00Z', type: 'session_meta', payload: { id: sessionId, cwd: 'D:\\project\\demo', model_provider: 'stone' } },
      { timestamp: '2026-07-22T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Implement the gateway feature' } },
      { timestamp: '2026-07-22T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 150 } } } }
    ]
    await writeFile(rollout, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: sessionId, thread_name: 'Gateway work' }) + '\n')
    const database = new DatabaseSync(join(home, 'state_5.sqlite'))
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL, archived_at INTEGER)')
    database.prepare('INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, 0)').run(sessionId, rollout)
    database.close()
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })

    let sessions = await manager.list({ search: 'gateway' })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      title: 'Gateway work',
      kind: 'active',
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150
    })
    expect(sessions[0].revision).toMatch(/^[a-f0-9]{64}$/)
    let revision = sessions[0].revision
    const exported = join(home, 'exports', 'session.jsonl')
    await manager.export(sessionId, revision, exported)
    expect(await readFile(exported, 'utf8')).toContain('session_meta')
    await expect(manager.export(sessionId, revision, join(home, 'sessions', 'rollout-export.jsonl')))
      .rejects.toThrow('outside the managed session directories')

    sessions = await manager.trash(sessionId, revision)
    expect(sessions.find((session) => session.id === sessionId)?.kind).toBe('trash')
    revision = sessions.find((session) => session.id === sessionId)!.revision
    await expect(stat(rollout)).rejects.toMatchObject({ code: 'ENOENT' })
    const trashedDatabase = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
    expect(trashedDatabase.prepare('SELECT rollout_path, archived FROM threads WHERE id = ?').get(sessionId))
      .toMatchObject({ archived: 1 })
    trashedDatabase.close()
    sessions = await manager.restore(sessionId, revision)
    expect(sessions.find((session) => session.id === sessionId)?.kind).toBe('active')
    expect((await stat(rollout)).isFile()).toBe(true)
    const restoredDatabase = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
    expect(restoredDatabase.prepare('SELECT rollout_path, archived FROM threads WHERE id = ?').get(sessionId))
      .toEqual({ rollout_path: rollout, archived: 0 })
    restoredDatabase.close()
  })

  it('ignores empty usage objects in favor of a valid cumulative snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-usage-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789abd'
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${JSON.stringify({
      type: 'event_msg',
      payload: { usage: {}, info: { total_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }
    })}\n`)
    const [session] = await new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] }).list()
    expect(session).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  })

  it('binds destructive actions to the exact listed rollout revision', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-revision-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789abf'
    const rollout = join(sessionDirectory, `rollout-${id}.jsonl`)
    await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    const [listed] = await manager.list()
    // Keep the same session id and path while replacing its bytes after the
    // renderer received the row.
    await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/replacement' } })}\n`)

    await expect(manager.trash(id, listed.revision)).rejects.toThrow('changed after it was listed')
    expect((await stat(rollout)).isFile()).toBe(true)
  })

  it('keeps and completes rollback-pending evidence before clearing a trash manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-recovery-'))
    directories.push(home)
    const id = '01981234-1234-7123-8123-123456789abe'
    const relativeRollout = join('sessions', `rollout-${id}.jsonl`)
    const rollout = join(home, relativeRollout)
    const trashRollout = join(home, 'trash_sessions', relativeRollout)
    const manifestPath = `${trashRollout}.stone-trash.json`
    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(join(home, 'trash_sessions', 'sessions'), { recursive: true })
    await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    const databasePath = join(home, 'state_5.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL, archived_at INTEGER)')
    database.prepare('INSERT INTO threads (id, rollout_path, archived, archived_at) VALUES (?, ?, 1, 123)').run(id, trashRollout)
    database.close()
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      stage: 'rollback-pending',
      sessionId: id,
      originalRelativePath: relativeRollout,
      databaseRows: [{ databasePath, rolloutPath: rollout, archived: 0, archivedAt: null }],
    }))

    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    await expect(manager.list()).resolves.toHaveLength(1)

    const recovered = new DatabaseSync(databasePath, { readOnly: true })
    expect(recovered.prepare('SELECT rollout_path, archived, archived_at FROM threads WHERE id = ?').get(id))
      .toEqual({ rollout_path: rollout, archived: 0, archived_at: null })
    recovered.close()
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
