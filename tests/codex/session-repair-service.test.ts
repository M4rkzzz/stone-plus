import { DatabaseSync } from 'node:sqlite'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionRepairService } from '../../src/main/codex'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createFixture() {
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
    { timestamp: '2026-07-18T12:00:00Z', type: 'session_meta', payload: { id: 'thread-one', cwd: '\\\\?\\D:\\project\\stone+', model_provider: 'openai' } },
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
      title TEXT
    );
  `)
  const insert = database.prepare('INSERT INTO threads (id, model_provider, has_user_event, cwd, title) VALUES (?, ?, ?, ?, ?)')
  insert.run('thread-one', 'openai', 0, null, 'One')
  insert.run('thread-two', 'stone', 1, 'D:\\project\\other', 'Two')
  insert.run('orphan-thread', 'openai', 1, 'D:\\project\\orphan', 'Orphan')
  database.close()

  const unrelated = new DatabaseSync(join(sqliteDirectory, 'codex-dev.db'))
  unrelated.exec('CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY)')
  unrelated.close()

  const service = new CodexSessionRepairService({
    codexHome,
    now: () => new Date('2026-07-18T13:00:00Z'),
    randomId: () => 'fixedbackup',
  })
  return { service, codexHome, activeRollout, activeLines, databasePath, originalMtime }
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
    expect((repairedLines[0].payload as Record<string, unknown>).model_provider).toBe('stone')
    expect(repairedText).toContain('keep this text')
    expect((await stat(activeRollout)).mtimeMs).toBeCloseTo(originalMtime.getTime(), -2)
    expect(await readFile(join(result.backupPath!, 'rollouts', 'sessions', '2026', '07', '18', 'rollout-2026-07-18T12-00-00-thread-one.jsonl'), 'utf8')).toBe(activeLines)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      managedBy: 'Stone+ session repair',
      targetProvider: 'stone',
    })

    const database = new DatabaseSync(databasePath, { readOnly: true })
    const threadOne = database.prepare('SELECT model_provider, has_user_event, cwd FROM threads WHERE id = ?').get('thread-one') as Record<string, unknown>
    const orphan = database.prepare('SELECT model_provider FROM threads WHERE id = ?').get('orphan-thread') as Record<string, unknown>
    database.close()
    expect(threadOne).toEqual(expect.objectContaining({ model_provider: 'stone', has_user_event: 1, cwd: 'D:/project/stone+' }))
    expect(orphan.model_provider).toBe('stone')

    const after = await service.preview('stone')
    expect(after.rolloutFilesToUpdate).toBe(0)
    expect(after.sqliteProviderRowsToUpdate).toBe(0)
    expect(after.sqliteUserEventRowsToUpdate).toBe(0)
    expect(after.sqliteCwdRowsToUpdate).toBe(0)
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
})
