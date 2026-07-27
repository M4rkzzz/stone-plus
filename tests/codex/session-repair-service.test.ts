import { DatabaseSync } from 'node:sqlite'
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionRepairService } from '../../src/main/codex'

const temporaryDirectories: string[] = []
type SessionRepairOptions = ConstructorParameters<typeof CodexSessionRepairService>[0]

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createFixture(options: Partial<SessionRepairOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stone-session-repair-'))
  temporaryDirectories.push(root)
  const codexHome = join(root, '.codex')
  const activeDirectory = join(codexHome, 'sessions', '2026', '07', '18')
  const archiveDirectory = join(codexHome, 'archived_sessions')
  const sqliteDirectory = join(codexHome, 'sqlite')
  await Promise.all([
    mkdir(activeDirectory, { recursive: true }),
    mkdir(archiveDirectory, { recursive: true }),
    mkdir(sqliteDirectory, { recursive: true }),
  ])
  await writeFile(join(codexHome, 'config.toml'), [
    'model_provider = "stone"',
    '',
    '[model_providers.stone]',
    'name = "Stone+"',
    '',
  ].join('\n'))
  await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'projectless-thread-ids': ['thread-projectless'],
  }))

  const activeRollout = join(activeDirectory, 'rollout-2026-07-18T12-00-00-thread-one.jsonl')
  const activeLines = [
    {
      timestamp: '2026-07-18T12:00:00Z',
      type: 'session_meta',
      payload: {
        id: 'thread-one',
        cwd: '\\\\?\\D:\\project\\stone+',
        model_provider: 'openai',
        reasoning_effort: 'ultra',
        unknown_nested: { keep: { value: 7, labels: ['purple', 'unchanged'] } },
      },
    },
    { timestamp: '2026-07-18T12:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'keep this text' } },
    { timestamp: '2026-07-18T12:00:02Z', type: 'response_item', payload: { encrypted_content: 'opaque' } },
  ].map((item) => JSON.stringify(item)).join('\r\n') + '\r\n'
  await writeFile(activeRollout, activeLines)
  const originalMtime = new Date('2026-07-18T12:00:00Z')
  await (await import('node:fs/promises')).utimes(activeRollout, originalMtime, originalMtime)

  const archivedRollout = join(archiveDirectory, 'rollout-2026-07-17T12-00-00-thread-two.jsonl')
  await writeFile(archivedRollout, JSON.stringify({
    timestamp: '2026-07-17T12:00:00Z',
    type: 'session_meta',
    payload: { id: 'thread-two', cwd: 'D:\\project\\other', model_provider: 'stone' },
  }) + '\n')

  const databasePath = join(codexHome, 'state_5.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model_provider TEXT,
      has_user_event INTEGER,
      cwd TEXT,
      title TEXT,
      reasoning_effort TEXT,
      unknown_json TEXT
    );
  `)
  const insert = database.prepare('INSERT INTO threads (id, model_provider, has_user_event, cwd, title, reasoning_effort, unknown_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
  insert.run('thread-one', 'openai', 0, null, 'One', 'ultra', '{"keep":{"value":7}}')
  insert.run('thread-two', 'stone', 1, 'D:\\project\\other', 'Two', 'high', '{"two":true}')
  insert.run('orphan-thread', 'openai', 1, 'D:\\project\\orphan', 'Orphan', 'medium', '{"orphan":true}')
  database.close()

  const unrelated = new DatabaseSync(join(sqliteDirectory, 'codex-dev.db'))
  unrelated.exec('CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY)')
  unrelated.close()

  const service = new CodexSessionRepairService({
    codexHome,
    now: () => new Date('2026-07-18T13:00:00Z'),
    randomId: () => 'fixedbackup',
    ...options,
  })
  return { service, codexHome, activeRollout, activeLines, databasePath, originalMtime }
}

function observeRolloutReads() {
  const bytes = new Map<string, number>()
  const opened = new Map<string, number>()
  const closed = new Map<string, number>()
  const openRollout: NonNullable<SessionRepairOptions['openRollout']> = async (path) => {
    const handle = await open(path, 'r')
    opened.set(path, (opened.get(path) ?? 0) + 1)
    return {
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position)
        bytes.set(path, (bytes.get(path) ?? 0) + result.bytesRead)
        return result
      },
      close: async () => {
        closed.set(path, (closed.get(path) ?? 0) + 1)
        await handle.close()
      },
    }
  }
  return { openRollout, bytes, opened, closed }
}

describe('CodexSessionRepairService', () => {
  it('discovers configured, rollout, and SQLite providers and previews bounded changes', async () => {
    const { service, databasePath } = await createFixture()

    const overview = await service.inspect()
    const preview = await service.preview('stone')

    expect(overview).toMatchObject({
      currentProvider: 'stone',
      sessionFiles: 1,
      archivedSessionFiles: 1,
      indexedThreads: 3,
      sqliteDatabases: [databasePath],
      skippedFiles: [],
    })
    expect(overview.targets).toEqual([
      { id: 'stone', sources: ['config', 'rollout', 'sqlite'], isCurrentProvider: true },
      { id: 'openai', sources: ['config', 'rollout', 'sqlite'], isCurrentProvider: false },
    ])
    expect(preview).toMatchObject({
      targetProvider: 'stone',
      rolloutFilesToUpdate: 1,
      sqliteProviderRowsToUpdate: 2,
      sqliteUserEventRowsToUpdate: 1,
      sqliteCwdRowsToUpdate: 1,
      encryptedSessionFiles: 1,
      encryptedSourceProviders: ['openai'],
    })
    expect(preview.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('combines overview and preview in one rollout analysis pass', async () => {
    const observed = observeRolloutReads()
    const { service } = await createFixture({ openRollout: observed.openRollout })

    const analysis = await service.analyze()

    expect(analysis).toMatchObject({
      currentProvider: 'stone',
      targetProvider: 'stone',
      sessionFiles: 1,
      archivedSessionFiles: 1,
      rolloutFilesToUpdate: 1,
    })
    expect([...observed.opened.values()].reduce((sum, count) => sum + count, 0)).toBe(2)
    expect([...observed.closed.values()].reduce((sum, count) => sum + count, 0)).toBe(2)
  })

  it('builds and applies one post-shutdown plan without a preview rescan', async () => {
    const observed = observeRolloutReads()
    const { service } = await createFixture({ openRollout: observed.openRollout })

    const result = await service.analyzeAndRepair()

    expect(result).toMatchObject({ targetProvider: 'stone', repairedRolloutFiles: 1 })
    expect([...observed.opened.values()].reduce((sum, count) => sum + count, 0)).toBe(2)
    expect([...observed.closed.values()].reduce((sum, count) => sum + count, 0)).toBe(2)
  })

  it('recognizes first-line metadata without reading an oversized suffix and closes the handle', async () => {
    const observed = observeRolloutReads()
    const { service, codexHome } = await createFixture({ openRollout: observed.openRollout })
    const directory = join(codexHome, 'sessions', '2026', '07', '19')
    await mkdir(directory, { recursive: true })
    const rolloutPath = join(directory, 'rollout-2026-07-19T11-00-00-bounded-suffix.jsonl')
    const firstLine = Buffer.from(JSON.stringify({
      timestamp: '2026-07-19T11:00:00Z',
      type: 'session_meta',
      payload: { id: 'bounded-suffix', cwd: 'D:\\project\\bounded', model_provider: 'openai' },
    }) + '\n')
    const handle = await open(rolloutPath, 'w')
    try {
      await handle.write(firstLine, 0, firstLine.length, 0)
      // A sparse, unterminated suffix makes an accidental full-line/full-file
      // scan both expensive and easy to detect without bloating the test tree.
      await handle.truncate(firstLine.length + 64 * 1024 * 1024)
    } finally {
      await handle.close()
    }

    const preview = await service.preview('stone')

    expect(preview).toMatchObject({
      sessionFiles: 2,
      rolloutFilesWithSessionMeta: 3,
      rolloutFilesWithoutSessionMeta: 0,
      rolloutFilesToUpdate: 2,
    })
    expect(observed.bytes.get(rolloutPath)).toBeGreaterThanOrEqual(1024 * 1024)
    expect(observed.bytes.get(rolloutPath)).toBeLessThan(2 * 1024 * 1024)
    expect(observed.opened.get(rolloutPath)).toBe(1)
    expect(observed.closed.get(rolloutPath)).toBe(1)
  })

  it('hard-limits an unterminated metadata search instead of buffering the whole line', async () => {
    const observed = observeRolloutReads()
    const { service, codexHome } = await createFixture({ openRollout: observed.openRollout })
    const rolloutPath = join(codexHome, 'archived_sessions', 'rollout-no-meta-huge-line.jsonl')
    const handle = await open(rolloutPath, 'w')
    try {
      await handle.write(Buffer.from('{"type":"diagnostic","payload":"unterminated'))
      await handle.truncate(64 * 1024 * 1024)
    } finally {
      await handle.close()
    }

    const preview = await service.preview('stone')

    expect(preview.rolloutFilesWithoutSessionMeta).toBe(1)
    expect(observed.bytes.get(rolloutPath)).toBe(16 * 1024 * 1024)
    expect(observed.opened.get(rolloutPath)).toBe(1)
    expect(observed.closed.get(rolloutPath)).toBe(1)
  })

  it('closes the rollout handle when a bounded read fails', async () => {
    let failedPath = ''
    let closedFailedHandle = false
    const { service, codexHome } = await createFixture({
      openRollout: async (path) => {
        const handle = await open(path, 'r')
        return {
          read: async (buffer, offset, length, position) => {
            if (path === failedPath) throw new Error('simulated bounded read failure')
            return handle.read(buffer, offset, length, position)
          },
          close: async () => {
            if (path === failedPath) closedFailedHandle = true
            await handle.close()
          },
        }
      },
    })
    failedPath = join(codexHome, 'sessions', '2026', '07', '18', 'rollout-2026-07-18T11-00-00-read-error.jsonl')
    await writeFile(failedPath, JSON.stringify({ type: 'session_meta', payload: { id: 'read-error' } }) + '\n')

    await expect(service.preview('stone')).rejects.toThrow('simulated bounded read failure')
    expect(closedFailedHandle).toBe(true)
  })

  it('backs up and repairs rollout metadata and SQLite visibility indexes without changing conversation content or mtime', async () => {
    const { service, activeRollout, activeLines, databasePath, originalMtime } = await createFixture()
    const preview = await service.preview('stone')

    const result = await service.repair('stone', preview.revision)

    expect(result).toMatchObject({
      targetProvider: 'stone',
      repairedRolloutFiles: 1,
      sqliteProviderRowsUpdated: 2,
      sqliteUserEventRowsUpdated: 1,
      sqliteCwdRowsUpdated: 1,
      encryptedSessionFiles: 1,
    })
    expect(result.backupPath).toBeTruthy()
    const repairedText = await readFile(activeRollout, 'utf8')
    const repairedLines = repairedText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(repairedLines[0].payload).toEqual({
      id: 'thread-one',
      cwd: '\\\\?\\D:\\project\\stone+',
      model_provider: 'stone',
      reasoning_effort: 'ultra',
      unknown_nested: { keep: { value: 7, labels: ['purple', 'unchanged'] } },
    })
    expect(repairedText).toContain('keep this text')
    expect((await stat(activeRollout)).mtimeMs).toBeCloseTo(originalMtime.getTime(), -2)
    expect(await readFile(join(result.backupPath!, 'rollouts', 'sessions', '2026', '07', '18', 'rollout-2026-07-18T12-00-00-thread-one.jsonl'), 'utf8')).toBe(activeLines)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      managedBy: 'Stone+ session repair',
      targetProvider: 'stone',
    })

    const database = new DatabaseSync(databasePath, { readOnly: true })
    const threadOne = database.prepare('SELECT model_provider, has_user_event, cwd, title, reasoning_effort, unknown_json FROM threads WHERE id = ?').get('thread-one') as Record<string, unknown>
    const orphan = database.prepare('SELECT model_provider FROM threads WHERE id = ?').get('orphan-thread') as Record<string, unknown>
    database.close()
    expect(threadOne).toEqual({
      model_provider: 'stone',
      has_user_event: 1,
      cwd: 'D:/project/stone+',
      title: 'One',
      reasoning_effort: 'ultra',
      unknown_json: '{"keep":{"value":7}}',
    })
    expect(orphan.model_provider).toBe('stone')

    const after = await service.preview('stone')
    expect(after.rolloutFilesToUpdate).toBe(0)
    expect(after.sqliteProviderRowsToUpdate).toBe(0)
    expect(after.sqliteUserEventRowsToUpdate).toBe(0)
    expect(after.sqliteCwdRowsToUpdate).toBe(0)
  })

  it('recognizes and repairs a session_meta line larger than the old 1 MiB scan prefix', async () => {
    const { service, codexHome } = await createFixture()
    const directory = join(codexHome, 'sessions', '2026', '07', '19')
    await mkdir(directory, { recursive: true })
    const rolloutPath = join(directory, 'rollout-2026-07-19T12-00-00-large-meta.jsonl')
    const oversizedInstructions = 'x'.repeat(1024 * 1024 + 4096)
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'system' } }),
      JSON.stringify({
        timestamp: '2026-07-19T12:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'large-meta',
          cwd: 'D:\\project\\large',
          // Older official Codex rollouts may omit this optional field entirely.
          base_instructions: oversizedInstructions,
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'keep' } }),
    ].join('\n') + '\n')

    const preview = await service.preview('stone')
    expect(preview).toMatchObject({
      sessionFiles: 2,
      rolloutFilesWithSessionMeta: 3,
      rolloutFilesWithoutSessionMeta: 0,
      rolloutFilesAlreadyTargetProvider: 1,
      rolloutFilesToUpdate: 2,
    })

    await service.repair('stone', preview.revision)
    const repairedLines = (await readFile(rolloutPath, 'utf8')).trim().split(/\r?\n/)
    const repairedMeta = JSON.parse(repairedLines[1]) as { payload: Record<string, unknown> }
    expect(repairedMeta.payload.model_provider).toBe('stone')
    expect(repairedMeta.payload.base_instructions).toBe(oversizedInstructions)
  })

  it('reports discovered rollout files whose session metadata is genuinely absent', async () => {
    const { service, codexHome } = await createFixture()
    const path = join(codexHome, 'archived_sessions', 'rollout-no-session-meta.jsonl')
    await writeFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'legacy' } }) + '\n')

    const preview = await service.preview('stone')
    expect(preview).toMatchObject({
      rolloutFilesWithSessionMeta: 2,
      rolloutFilesWithoutSessionMeta: 1,
      rolloutFilesAlreadyTargetProvider: 1,
      rolloutFilesToUpdate: 1,
    })
  })

  it('rolls back committed rollout bytes when restoring the original mtime fails', async () => {
    const { codexHome, activeRollout, activeLines } = await createFixture()
    let preserveCalls = 0
    const service = new CodexSessionRepairService({
      codexHome,
      now: () => new Date('2026-07-18T13:00:00Z'),
      randomId: () => 'mtime-rollback',
      preserveRolloutMtime: async (path, atime, mtime) => {
        preserveCalls += 1
        if (preserveCalls === 1) throw new Error('simulated utimes failure')
        await utimes(path, atime, mtime)
      }
    })
    const preview = await service.preview('stone')

    await expect(service.repair('stone', preview.revision)).rejects.toThrow('已自动回滚')
    expect(await readFile(activeRollout, 'utf8')).toBe(activeLines)
    expect(preserveCalls).toBe(2)
  })

  it('rejects a stale preview before writing any repair changes', async () => {
    const { service, activeRollout, databasePath } = await createFixture()
    const preview = await service.preview('stone')
    await appendFile(activeRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_input', text: 'new' } }) + '\n')

    await expect(service.repair('stone', preview.revision)).rejects.toThrow('预览后发生变化')

    const firstLine = JSON.parse((await readFile(activeRollout, 'utf8')).split(/\r?\n/)[0]) as Record<string, unknown>
    expect((firstLine.payload as Record<string, unknown>).model_provider).toBe('openai')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('SELECT model_provider FROM threads WHERE id = ?').get('thread-one') as Record<string, unknown>).model_provider).toBe('openai')
    database.close()
  })

  it('rejects unsafe provider identifiers', async () => {
    const { service } = await createFixture()
    await expect(service.preview('../bad')).rejects.toThrow('Provider ID')
  })

  it('does not interleave with another Stone+ or Codex++ provider sync lock', async () => {
    const { service, codexHome, activeRollout } = await createFixture()
    const preview = await service.preview('stone')
    await mkdir(join(codexHome, 'tmp', 'provider-sync.lock'), { recursive: true })

    await expect(service.repair('stone', preview.revision)).rejects.toThrow('另一个 Stone+ / Codex++')
    const firstLine = JSON.parse((await readFile(activeRollout, 'utf8')).split(/\r?\n/)[0]) as Record<string, unknown>
    expect((firstLine.payload as Record<string, unknown>).model_provider).toBe('openai')
  })

  it('reclaims a stale Codex++ owner.json lock whose process no longer exists', async () => {
    const { service, codexHome } = await createFixture()
    const preview = await service.preview('stone')
    const lockPath = join(codexHome, 'tmp', 'provider-sync.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      startedAt: 1_784_444_363,
    }))

    await expect(service.repair('stone', preview.revision)).resolves.toMatchObject({ targetProvider: 'stone' })
  })

  it('preserves a Codex++ owner.json lock while its owner process is alive', async () => {
    const { service, codexHome } = await createFixture()
    const preview = await service.preview('stone')
    const lockPath = join(codexHome, 'tmp', 'provider-sync.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      startedAt: Math.floor(Date.now() / 1_000),
    }))

    await expect(service.repair('stone', preview.revision)).rejects.toThrow('另一个 Stone+ / Codex++')
    await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toContain(`"pid":${process.pid}`)
  })

  it('normalizes bounded global workspace fields, preserves unrelated state, and backs up the original bytes', async () => {
    const { service, codexHome } = await createFixture()
    const statePath = join(codexHome, '.codex-global-state.json')
    const original = JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'electron-saved-workspace-roots': ['\\\\?\\D:\\work\\app', 'd:/work/app/'],
      'project-order': '\\\\?\\UNC\\server\\share',
      'active-workspace-roots': '\\\\?\\D:\\work\\app',
      'electron-workspace-root-labels': { '\\\\?\\D:\\work\\app': 'App' },
      'open-in-target-preferences': { target: 'vscode', perPath: { '\\\\?\\UNC\\server\\share': 'cursor' } },
      untouched: { nested: true },
    }, null, 2) + '\r\n'
    await writeFile(statePath, original)

    const preview = await service.preview('stone')
    expect(preview.globalStateFieldsToUpdate).toBe(5)
    expect(preview.globalStateConflictingFields).toEqual([])

    const result = await service.repair('stone', preview.revision)
    expect(result.globalStateFieldsUpdated).toBe(5)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    expect(state).toMatchObject({
      'electron-saved-workspace-roots': ['D:/work/app'],
      'project-order': ['\\\\server\\share'],
      'active-workspace-roots': 'D:/work/app',
      'electron-workspace-root-labels': { 'D:/work/app': 'App' },
      'open-in-target-preferences': { target: 'vscode', perPath: { '\\\\server\\share': 'cursor' } },
      untouched: { nested: true },
    })
    expect(await readFile(join(result.backupPath!, '.codex-global-state.json'), 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      changedGlobalStateFields: [
        'active-workspace-roots',
        'electron-saved-workspace-roots',
        'electron-workspace-root-labels',
        'open-in-target-preferences',
        'project-order',
      ],
    })
    expect((await service.preview('stone')).globalStateFieldsToUpdate).toBe(0)
  })

  it('fails closed on conflicting path-keyed values and never overwrites them', async () => {
    const { service, codexHome } = await createFixture()
    const statePath = join(codexHome, '.codex-global-state.json')
    const labels = { 'D:\\work\\app': 'First', '\\\\?\\D:\\work\\app': 'Second' }
    await writeFile(statePath, JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'electron-workspace-root-labels': labels,
    }))

    const preview = await service.preview('stone')
    expect(preview.globalStateConflictingFields).toEqual(['electron-workspace-root-labels'])
    const result = await service.repair('stone', preview.revision)
    expect(result.globalStateConflictingFields).toEqual(['electron-workspace-root-labels'])
    expect((JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>)['electron-workspace-root-labels']).toEqual(labels)
  })

  it('rejects global state changed after preview before writing rollout or SQLite changes', async () => {
    const { service, codexHome, activeRollout, databasePath } = await createFixture()
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'active-workspace-roots': '\\\\?\\D:\\before-preview',
    }))
    const preview = await service.preview('stone')
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'active-workspace-roots': '\\\\?\\D:\\after-preview',
    }))

    await expect(service.repair('stone', preview.revision)).rejects.toThrow('预览后发生变化')
    const firstLine = JSON.parse((await readFile(activeRollout, 'utf8')).split(/\r?\n/)[0]) as Record<string, unknown>
    expect((firstLine.payload as Record<string, unknown>).model_provider).toBe('openai')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare('SELECT model_provider FROM threads WHERE id = ?').get('thread-one') as Record<string, unknown>).model_provider).toBe('openai')
    database.close()
  })

  it('does not make provider repair stale when only unrelated global state changes', async () => {
    const { service, codexHome } = await createFixture()
    const preview = await service.preview('stone')
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'electron-main-window-bounds': { x: 20, y: 30, width: 1200, height: 800 },
    }))

    await expect(service.repair('stone', preview.revision)).resolves.toMatchObject({ repairedRolloutFiles: 1 })
    expect((JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>)['electron-main-window-bounds'])
      .toEqual({ x: 20, y: 30, width: 1200, height: 800 })
  })

  it('backs up and applies a global-state-only repair without touching the session index', async () => {
    const { service, codexHome } = await createFixture()
    const initial = await service.preview('stone')
    await service.repair('stone', initial.revision)
    const globalOnlyService = new CodexSessionRepairService({
      codexHome,
      now: () => new Date('2026-07-18T13:00:01Z'),
      randomId: () => 'secondbackup',
    })
    const indexPath = join(codexHome, 'session_index.jsonl')
    const indexText = JSON.stringify({ id: 'ghost', thread_name: 'keep', updated_at: '2026-07-20T00:00:00Z' }) + '\n'
    await writeFile(indexPath, indexText)
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'projectless-thread-ids': ['thread-projectless'],
      'active-workspace-roots': '\\\\?\\D:\\only-global',
    }))

    const preview = await globalOnlyService.preview('stone')
    expect(preview).toMatchObject({
      rolloutFilesToUpdate: 0,
      sqliteProviderRowsToUpdate: 0,
      sqliteUserEventRowsToUpdate: 0,
      sqliteCwdRowsToUpdate: 0,
      globalStateFieldsToUpdate: 1,
    })
    const result = await globalOnlyService.repair('stone', preview.revision)

    expect(result.backupPath).toBeTruthy()
    expect(result.globalStateFieldsUpdated).toBe(1)
    expect(await readFile(indexPath, 'utf8')).toBe(indexText)
    expect((JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>)['active-workspace-roots']).toBe('D:/only-global')
  })

  it('scans rollout files with bounded concurrency and reports monotonic progress', async () => {
    let active = 0
    let peak = 0
    const progress: number[] = []
    const openRollout: NonNullable<SessionRepairOptions['openRollout']> = async (path) => {
      const handle = await open(path, 'r')
      active += 1
      peak = Math.max(peak, active)
      return {
        read: async (buffer, offset, length, position) => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return handle.read(buffer, offset, length, position)
        },
        close: async () => {
          active -= 1
          await handle.close()
        },
      }
    }
    const { service, codexHome } = await createFixture({ openRollout, scanConcurrency: 2 })
    await writeFile(join(codexHome, 'archived_sessions', 'rollout-extra.jsonl'), JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-extra', model_provider: 'openai' },
    }) + '\n')

    await service.preview('stone', {
      onProgress: (event) => {
        if (event.stage === 'scan') progress.push(event.completed)
      },
    })

    expect(peak).toBe(2)
    expect(active).toBe(0)
    expect(progress).toEqual([1, 2, 3])
  })

  it('cancels scanning without leaking rollout handles or writing session data', async () => {
    const controller = new AbortController()
    let opened = 0
    let closed = 0
    const openRollout: NonNullable<SessionRepairOptions['openRollout']> = async (path) => {
      const handle = await open(path, 'r')
      opened += 1
      return {
        read: async (buffer, offset, length, position) => {
          controller.abort(new Error('会话修复已取消。'))
          return handle.read(buffer, offset, length, position)
        },
        close: async () => {
          closed += 1
          await handle.close()
        },
      }
    }
    const { service, activeRollout, activeLines } = await createFixture({ openRollout, scanConcurrency: 2 })

    await expect(service.preview('stone', { signal: controller.signal })).rejects.toThrow('已取消')
    expect(closed).toBe(opened)
    expect(await readFile(activeRollout, 'utf8')).toBe(activeLines)
  })

  it('fails closed when rollout discovery exceeds the configured safety limit', async () => {
    const { service, codexHome, activeRollout, activeLines } = await createFixture({ maxRolloutFiles: 1 })

    await expect(service.preview('stone')).rejects.toThrow('安全扫描上限')
    expect(await readFile(activeRollout, 'utf8')).toBe(activeLines)
    await expect(stat(join(codexHome, 'backups_state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
