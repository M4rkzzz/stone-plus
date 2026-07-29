import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    await writeFile(exported, 'replace me')
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
      payload: {
        info: { total_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        total_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 }
      }
    })}\n`)
    const [session] = await new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] }).list()
    expect(session).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  })

  it('uses one complete cumulative snapshot instead of mixing maxima from different snapshots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-cumulative-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac0'
    const records = [
      { payload: { info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5, total_tokens: 105 } } } },
      { payload: { info: { total_token_usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 40, total_tokens: 120 } } } },
      { payload: { usage: { input_tokens: 500, output_tokens: 500, total_tokens: 1_000 } } }
    ]
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const [session] = await new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] }).list()
    expect(session).toMatchObject({
      inputTokens: 80,
      cachedInputTokens: 10,
      outputTokens: 40,
      totalTokens: 120
    })
  })

  it('aggregates incremental usage only when no cumulative snapshot exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-incremental-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac1'
    const records = [
      { payload: { usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 2, total_tokens: 7 } } },
      { usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 3, reasoning_tokens: 2, total_tokens: 7 } }
    ]
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const [session] = await new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] }).list()
    expect(session).toMatchObject({
      inputTokens: 9,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 14
    })
  })

  it('merges partial cumulative and incremental token usage field by field', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-partial-usage-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac4'
    const records = [
      { payload: { info: { total_token_usage: { input_tokens: 100, total_tokens: 120 } } } },
      { payload: { info: { total_token_usage: { cached_input_tokens: 30 } } } },
      { payload: { usage: { output_tokens: 7, reasoning_tokens: 4 } } },
      { usage: { output_tokens: 5, reasoning_output_tokens: 3 } },
    ]
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const [session] = await new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] }).list()
    expect(session).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 12,
      reasoningTokens: 7,
      totalTokens: 120,
    })
  })

  it('rejects export destinations redirected into managed sessions through a directory link', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-link-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac2'
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    const alias = join(home, 'export-alias')
    await symlink(sessionDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    const [session] = await manager.list()

    await expect(manager.export(id, session.revision, join(alias, 'nested', 'export.jsonl')))
      .rejects.toThrow('outside the managed session directories')
  })

  it('removes only its own new file when the fixed export parent is rebound before opening', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-link-swap-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    const externalDirectory = join(home, 'external')
    const movedDirectory = join(home, 'external-original')
    await mkdir(sessionDirectory, { recursive: true })
    await mkdir(externalDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac5'
    const rollout = join(sessionDirectory, `rollout-${id}.jsonl`)
    await writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    const [session] = await manager.list()
    const opener = manager as unknown as {
      openExportDestination(path: string): Promise<{ handle: unknown; created: boolean }>
    }
    const originalOpen = opener.openExportDestination.bind(manager)
    vi.spyOn(opener, 'openExportDestination').mockImplementationOnce(async (path) => {
      await rename(externalDirectory, movedDirectory)
      await symlink(sessionDirectory, externalDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      return originalOpen(path)
    })

    await expect(manager.export(id, session.revision, join(externalDirectory, 'export.jsonl')))
      .rejects.toThrow(/destination changed|outside the managed session directories/i)
    await expect(stat(join(sessionDirectory, 'export.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(rollout, 'utf8')).resolves.toContain(id)
  })

  it('never deletes a managed rollout when the fixed parent is rebound after writing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-post-write-swap-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    const externalDirectory = join(home, 'external')
    const movedDirectory = join(home, 'external-original')
    await mkdir(sessionDirectory, { recursive: true })
    await mkdir(externalDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac6'
    const filename = `rollout-${id}.jsonl`
    const rollout = join(sessionDirectory, filename)
    const contents = `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`
    await writeFile(rollout, contents)
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    const [session] = await manager.list()
    const guarded = manager as unknown as {
      assertOpenExportDestination(...args: unknown[]): Promise<void>
    }
    const originalGuard = guarded.assertOpenExportDestination.bind(manager)
    let checks = 0
    vi.spyOn(guarded, 'assertOpenExportDestination').mockImplementation(async (...args) => {
      checks += 1
      if (checks === 2) {
        await rename(externalDirectory, movedDirectory)
        await symlink(sessionDirectory, externalDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      }
      await originalGuard(...args)
    })

    await expect(manager.export(id, session.revision, join(externalDirectory, filename)))
      .rejects.toThrow(/destination changed|outside the managed session directories|operation not permitted/i)
    await expect(readFile(rollout, 'utf8')).resolves.toBe(contents)
  })

  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('checks managed export destinations case-insensitively on Windows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-session-manager-case-'))
    directories.push(home)
    const sessionDirectory = join(home, 'sessions')
    await mkdir(sessionDirectory, { recursive: true })
    const id = '01981234-1234-7123-8123-123456789ac3'
    await writeFile(join(sessionDirectory, `rollout-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    const manager = new CodexSessionManager({ codexHome: home, blockingCodexPids: async () => [] })
    const [session] = await manager.list()
    const mixedCaseDestination = join(home, 'SeSsIoNs', 'export.jsonl')

    await expect(manager.export(id, session.revision, mixedCaseDestination))
      .rejects.toThrow('outside the managed session directories')
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
