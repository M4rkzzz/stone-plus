import { DatabaseSync } from 'node:sqlite'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('repairs an external sqlite_home database and backs it up inside the managed tree', async () => {
    const { service, codexHome } = await createFixture()
    const sqliteHome = join(dirname(codexHome), 'relocated-state')
    await mkdir(sqliteHome)
    const configPath = join(codexHome, 'config.toml')
    const originalConfig = await readFile(configPath, 'utf8')
    await writeFile(
      configPath,
      `sqlite_home = '${sqliteHome.replace(/'/g, "''")}'\n${originalConfig}`,
      'utf8',
    )
    const externalPath = join(sqliteHome, 'state_5.sqlite')
    const external = new DatabaseSync(externalPath)
    external.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT)')
    external.prepare('INSERT INTO threads (id, model_provider) VALUES (?, ?)')
      .run('external-thread', 'openai')
    external.close()

    const preview = await service.preview('stone')
    expect(preview.sqliteDatabases).toContain(externalPath)
    expect(preview.sqliteProviderRowsToUpdate).toBe(3)
    const result = await service.repair('stone', preview.revision)

    const repaired = new DatabaseSync(externalPath, { readOnly: true })
    expect((repaired.prepare('SELECT model_provider FROM threads WHERE id = ?')
      .get('external-thread') as Record<string, unknown>).model_provider).toBe('stone')
    repaired.close()
    const metadata = JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8')) as {
      changedDatabases: string[]
    }
    expect(metadata.changedDatabases).toContainEqual(expect.stringMatching(
      /^external-databases[\\/][a-f0-9]{16}[\\/]state_5\.sqlite$/,
    ))
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

  it('repairs the startup index without reading rollout history or normalizing workspace state', async () => {
    const observed = observeRolloutReads()
    const { service, codexHome, activeRollout, databasePath } = await createFixture({
      openRollout: observed.openRollout,
    })
    const statePath = join(codexHome, '.codex-global-state.json')
    const state = JSON.stringify({
      'active-workspace-roots': '\\\\?\\D:\\project\\stone+',
      untouched: true,
    })
    await writeFile(statePath, state)

    const result = await service.analyzeAndRepair('openai', undefined, {
      scope: 'startup-index',
    })

    expect(result).toMatchObject({
      targetProvider: 'openai',
      repairedRolloutFiles: 0,
      sqliteProviderRowsUpdated: 1,
      globalStateFieldsUpdated: 0,
    })
    expect(observed.opened.size).toBe(0)
    expect(observed.closed.size).toBe(0)
    expect(await readFile(statePath, 'utf8')).toBe(state)
    const firstLine = JSON.parse((await readFile(activeRollout, 'utf8')).split(/\r?\n/)[0]) as { payload: Record<string, unknown> }
    expect(firstLine.payload.model_provider).toBe('openai')
    const archived = JSON.parse((await readFile(join(
      codexHome,
      'archived_sessions',
      'rollout-2026-07-17T12-00-00-thread-two.jsonl',
    ), 'utf8')).trim()) as { payload: Record<string, unknown> }
    expect(archived.payload.model_provider).toBe('stone')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    const providers = database.prepare('SELECT DISTINCT model_provider FROM threads').all() as Array<Record<string, unknown>>
    database.close()
    expect(providers).toEqual([{ model_provider: 'openai' }])
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
    const originalFile = await stat(activeRollout)
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
    const patchJournal = (await readFile(join(result.backupPath!, 'rollout-patches.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { relativePath: string; rewrites: Array<{ originalBase64: string }> })
      .find((entry) => entry.relativePath.endsWith('rollout-2026-07-18T12-00-00-thread-one.jsonl'))!
    const originalFirstLine = activeLines.slice(0, activeLines.indexOf('\r\n') + 2)
    expect(Buffer.from(patchJournal.rewrites[0]!.originalBase64, 'base64').toString('utf8')).toBe(originalFirstLine)
    const repairedFile = await stat(activeRollout)
    if (originalFile.ino !== 0) {
      expect(repairedFile.ino).toBe(originalFile.ino)
    }
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      version: 3,
      managedBy: 'Stone+ session repair',
      status: 'complete',
      targetProvider: 'stone',
      rolloutBackupStrategy: {
        patchJournalFiles: 1,
        hardLinkedFiles: 0,
        copiedFiles: 0,
      },
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

  it('removes only Stone+ abandoned staging directories before publishing a complete backup', async () => {
    const { service, codexHome } = await createFixture()
    const backupRoot = join(codexHome, 'backups_state', 'stone-session-repair')
    const abandoned = join(backupRoot, '.stone-session-repair-abandoned.partial')
    const unrelated = join(backupRoot, 'user-created.partial')
    await mkdir(abandoned, { recursive: true })
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(abandoned, 'orphan'), 'incomplete')
    await writeFile(join(unrelated, 'keep'), 'user data')

    const result = await service.analyzeAndRepair('stone')

    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(unrelated, 'keep'), 'utf8')).toBe('user data')
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      managedBy: 'Stone+ session repair',
    })
  })

  it('repairs persisted upstream models while preserving native models during restart repair', async () => {
    const { service, codexHome, databasePath } = await createFixture()
    const database = new DatabaseSync(databasePath)
    database.exec('ALTER TABLE threads ADD COLUMN model TEXT')
    database.prepare('UPDATE threads SET model = ? WHERE id = ?').run('deepseek-v4-flash', 'thread-one')
    database.prepare('UPDATE threads SET model = ? WHERE id = ?').run('deepseek-unmapped', 'orphan-thread')
    database.prepare('UPDATE threads SET model = ? WHERE id = ?').run('gpt-5.6-luna', 'thread-two')
    database.close()
    const staleModelCache = JSON.stringify({
      fetched_at: '2026-08-01T00:00:00Z',
      models: [{ slug: 'deepseek-v4-flash' }, { slug: 'deepseek-v4-pro' }],
    })
    await writeFile(join(codexHome, 'models_cache.json'), staleModelCache)

    const result = await service.analyzeAndRepair('stone', undefined, {
      modelRepair: {
        modelMap: { 'gpt-5.6-terra': 'deepseek-v4-flash' },
        fallbackModel: 'gpt-5.6-sol',
      },
    })

    const repaired = new DatabaseSync(databasePath, { readOnly: true })
    const rows = repaired.prepare('SELECT id, model FROM threads ORDER BY id').all() as Array<Record<string, unknown>>
    repaired.close()
    expect(rows).toEqual([
      { id: 'orphan-thread', model: 'gpt-5.6-sol' },
      { id: 'thread-one', model: 'gpt-5.6-terra' },
      { id: 'thread-two', model: 'gpt-5.6-luna' },
    ])
    await expect(readFile(join(codexHome, 'models_cache.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(result.backupPath!, 'models_cache.json'), 'utf8')).toBe(staleModelCache)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      invalidatedModelCache: true,
    })
  })

  it('leaves the Codex model catalog untouched during ordinary provider-only session repair', async () => {
    const { service, codexHome } = await createFixture()
    const cachePath = join(codexHome, 'models_cache.json')
    const modelCache = JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] })
    await writeFile(cachePath, modelCache)

    await service.analyzeAndRepair('stone')

    expect(await readFile(cachePath, 'utf8')).toBe(modelCache)
  })

  it('refuses a stale residue preview after the model catalog changes', async () => {
    const { service, codexHome } = await createFixture()
    const cachePath = join(codexHome, 'models_cache.json')
    const modelRepair = { modelMap: {}, fallbackModel: 'gpt-5.6-sol' }
    await writeFile(cachePath, JSON.stringify({ models: [{ slug: 'deepseek-v4-flash' }] }))
    const preview = await service.preview('stone', { modelRepair })
    const refreshed = JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] })
    await writeFile(cachePath, refreshed)

    await expect(service.repair('stone', preview.revision, { modelRepair }))
      .rejects.toThrow('预览后发生变化')
    expect(await readFile(cachePath, 'utf8')).toBe(refreshed)
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

  it('keeps a longer provider repair in-place by compacting an equivalent Windows cwd', async () => {
    const { service, codexHome } = await createFixture()
    const rolloutPath = join(codexHome, 'archived_sessions', 'rollout-provider-growth.jsonl')
    const original = JSON.stringify({
      timestamp: '2026-07-17T12:00:00Z',
      type: 'session_meta',
      payload: { id: 'provider-growth', cwd: 'D:\\project\\growth', model_provider: 'stone' },
    }) + '\n'
    await writeFile(rolloutPath, original)
    const before = await stat(rolloutPath)
    const preview = await service.preview('openai')

    const result = await service.repair('openai', preview.revision)

    const after = await stat(rolloutPath)
    const repaired = JSON.parse((await readFile(rolloutPath, 'utf8')).trim()) as { payload: Record<string, unknown> }
    expect(repaired.payload).toMatchObject({
      model_provider: 'openai',
      cwd: 'D:/project/growth',
    })
    expect(after.size).toBe(before.size)
    if (before.ino !== 0) expect(after.ino).toBe(before.ino)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      rolloutBackupStrategy: { patchJournalFiles: 2 },
    })
  })

  it('uses an atomic full-file fallback only when an equal-length metadata patch is impossible', async () => {
    const { service, codexHome } = await createFixture()
    const rolloutPath = join(codexHome, 'archived_sessions', 'rollout-provider-growth-without-slack.jsonl')
    const original = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'provider-growth-without-slack', model_provider: 's' },
    }) + '\n'
    await writeFile(rolloutPath, original)
    const before = await stat(rolloutPath)
    const preview = await service.preview('openai')

    const result = await service.repair('openai', preview.revision)

    const after = await stat(rolloutPath)
    const repaired = JSON.parse((await readFile(rolloutPath, 'utf8')).trim()) as { payload: Record<string, unknown> }
    expect(repaired.payload.model_provider).toBe('openai')
    expect(after.size).toBeGreaterThan(before.size)
    if (before.ino !== 0) expect(after.ino).not.toBe(before.ino)
    expect(await readFile(join(
      result.backupPath!,
      'rollouts',
      'archived_sessions',
      'rollout-provider-growth-without-slack.jsonl',
    ), 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(result.backupPath!, 'metadata.json'), 'utf8'))).toMatchObject({
      rolloutBackupStrategy: {
        patchJournalFiles: 1,
        hardLinkedFiles: 1,
      },
    })
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
    expect(await readdir(join(codexHome, 'backups_state', 'stone-session-repair'))).toEqual([])
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
