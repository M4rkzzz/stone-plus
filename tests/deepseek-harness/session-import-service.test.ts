import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexManagedSession } from '../../src/shared/types'
import type { CodexSessionManager } from '../../src/main/codex'
import {
  DeepSeekHarnessSessionImportService,
  readVisibleCodexTranscript,
} from '../../src/main/deepseek-harness/session-import-service'

describe('DeepSeekHarnessSessionImportService', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('reads only visible user and assistant text from a Codex rollout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const rollout = join(directory, 'rollout.jsonl')
    await writeFile(rollout, [
      { type: 'session_meta', payload: { id: 'source-session', cwd: 'D:\\work' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'HIDDEN_DEVELOPER_INSTRUCTION' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Visible user question' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Visible user question' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{"secret":"HIDDEN_TOOL_ARGUMENT"}' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible assistant answer' }] } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'HIDDEN_TOOL_RESULT' } },
    ].map((record) => JSON.stringify(record)).join('\n'))

    const transcript = await readVisibleCodexTranscript(rollout)

    expect(transcript).toEqual([
      { role: 'user', text: 'Visible user question' },
      { role: 'assistant', text: 'Visible assistant answer' },
    ])
    expect(JSON.stringify(transcript)).not.toContain('HIDDEN_')
  })

  it('converts only selected sessions into native Harness events without a model request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const harnessHome = join(directory, 'harness-home')
    const rollout = join(directory, 'selected.jsonl')
    await writeFile(rollout, [
      { type: 'session_meta', payload: { id: 'selected-session', cwd: 'D:\\from-rollout' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Selected question' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Selected reasoning' }] } },
      { type: 'response_item', payload: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'exec', arguments: '{"cmd":"echo selected"}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc-1', call_id: 'call-2', name: 'exec', input: 'Get-Content selected.txt' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: [{ type: 'input_text', text: 'custom output' }, { type: 'image', data: 'BASE64_SHOULD_NOT_MIGRATE' }] } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'selected output' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Selected answer' } },
    ].map((record) => JSON.stringify(record)).join('\n'))
    let revision = 'a'.repeat(64)
    const selected = { ...managedSession('selected-session', revision, 'Selected session'), cwd: undefined }
    const sessionManager = {
      resolveForImport: vi.fn(async (id: string, expectedRevision: string) => {
        expect(id).toBe(selected.id)
        expect(expectedRevision).toBe(revision)
        return { session: { ...selected, revision }, path: rollout }
      }),
    } as unknown as CodexSessionManager
    const harness = harnessFetch({
      sessionIds: [selected.id],
      canonicalWorkspacePath: 'D:\\canonical\\project',
    })
    const service = new DeepSeekHarnessSessionImportService({
      sessionManager,
      harnessHome,
      fetchImplementation: harness.fetchImplementation,
    })

    const first = await service.import([{ id: selected.id, expectedRevision: revision }])
    revision = 'e'.repeat(64)
    const second = await service.import([{ id: selected.id, expectedRevision: revision }])

    expect(first).toMatchObject({ imported: 1, alreadyImported: 0, failed: 0 })
    expect(second).toMatchObject({ imported: 0, alreadyImported: 1, failed: 0 })
    expect(first.items[0]).toMatchObject({ sourceSessionId: selected.id, status: 'imported' })
    expect(sessionManager.resolveForImport).toHaveBeenCalledTimes(2)
    expect(harness.methods).not.toContain('session.prompt')
    expect(harness.methods.filter((method) => method === 'workspace.create')).toHaveLength(2)
    expect(harness.methods.filter((method) => method === 'session.create')).toHaveLength(2)
    expect(harness.workspaceCount()).toBe(1)

    const sessionFiles = (await readdir(harnessHome, { recursive: true }))
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('session.jsonl.zstd'))
    expect(sessionFiles).toHaveLength(1)
    const sessionFile = sessionFiles[0]
    expect(sessionFile).toBeTruthy()
    const decoded = decodeZstdFrames(await readFile(join(harnessHome, sessionFile!))).toString('utf8')
    const records = decoded.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records[0]).toMatchObject({
      type: 'session', version: 0, cwd: 'D:\\canonical\\project', agentPreset: 'standard',
    })
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
      'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end',
    ]))
    expect(decoded).toContain('Selected question')
    expect(decoded).toContain('Selected reasoning')
    expect(decoded).toContain('Selected answer')
    expect(decoded).toContain('selected output')
    expect(decoded).toContain('custom output')
    expect(decoded).toContain('"callId":"call-1"')
    expect(decoded).toContain('"callId":"call-2"')
    expect(decoded).toContain('\\"input\\":\\"Get-Content selected.txt\\"')
    expect(decoded).not.toContain('BASE64_SHOULD_NOT_MIGRATE')
    expect(decoded).not.toContain('Unselected session')
    expectNativeHarnessEvents(records.slice(1))
  })

  it('isolates stale or missing selections without migrating another session', async () => {
    const revision = 'c'.repeat(64)
    const selected = managedSession('selected-session', revision, 'Selected session')
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const sessionManager = {
      resolveForImport: vi.fn(async (id: string) => {
        if (id === selected.id) throw new Error('The Codex session changed after it was listed. Refresh and try again.')
        throw new Error('Codex session not found.')
      }),
    } as unknown as CodexSessionManager
    const harness = harnessFetch()
    const service = new DeepSeekHarnessSessionImportService({
      sessionManager,
      harnessHome: join(directory, 'harness-home'),
      fetchImplementation: harness.fetchImplementation,
    })

    const result = await service.import([
      { id: selected.id, expectedRevision: revision },
      { id: 'missing-session', expectedRevision: 'd'.repeat(64) },
    ])

    expect(result).toMatchObject({ imported: 0, alreadyImported: 0, failed: 2 })
    expect(result.items.map((item) => item.sourceSessionId)).toEqual(['selected-session', 'missing-session'])
    expect(harness.methods).toEqual(['session.list'])
  })

  it('imports into native DSH storage while the client is closed without launching it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const harnessHome = join(directory, 'harness-home')
    const workspace = join(directory, 'project')
    const rollout = join(directory, 'offline-session.jsonl')
    await mkdir(workspace)
    await writeFile(rollout, [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Offline migration question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Offline migration answer' } },
    ].map((record) => JSON.stringify(record)).join('\n'))
    const selected = {
      ...managedSession('offline-session', 'f'.repeat(64), 'Offline session'),
      cwd: workspace,
    }
    const sessionManager = {
      resolveForImport: vi.fn(async () => ({ session: selected, path: rollout })),
    } as unknown as CodexSessionManager
    const isHarnessRunning = vi.fn(async () => false)
    const fetchImplementation = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3080')
    }) as unknown as typeof fetch
    const service = new DeepSeekHarnessSessionImportService({
      sessionManager,
      isHarnessRunning,
      harnessHome,
      fetchImplementation,
    })

    const result = await service.import([{ id: selected.id, expectedRevision: selected.revision }])

    expect(result).toMatchObject({ imported: 1, alreadyImported: 0, failed: 0 })
    expect(isHarnessRunning).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    const registry = JSON.parse(await readFile(join(harnessHome, 'storages', 'workspace.json'), 'utf8')) as {
      global: { workspaceIds: string[]; archivedSessionIds: string[] }
      tables: { workspaces: Record<string, { path: string; sessionIds: string[] }> }
    }
    expect(registry.global.archivedSessionIds).not.toContain(importedHarnessSessionId(selected.id))
    expect(registry.global.workspaceIds).toHaveLength(1)
    expect(registry.tables.workspaces[registry.global.workspaceIds[0]!]!).toMatchObject({
      path: await realpath(workspace),
      sessionIds: [importedHarnessSessionId(selected.id)],
    })
    const sessionFile = (await readdir(harnessHome, { recursive: true }))
      .map((entry) => String(entry))
      .find((entry) => entry.endsWith('session.jsonl.zstd'))
    expect(sessionFile).toBeTruthy()
    const decoded = decodeZstdFrames(await readFile(join(harnessHome, sessionFile!))).toString('utf8')
    expect(decoded).toContain('Offline migration question')
    expect(decoded).toContain('Offline migration answer')
    expect(decoded).toContain('"type":"session/title"')
    expect(decoded).toContain('"title":"Codex · Offline session"')
  })

  it('rejects and removes an import that DSH still reports with empty history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const harnessHome = join(directory, 'harness-home')
    const rollout = join(directory, 'empty-history.jsonl')
    await writeFile(rollout, JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: 'Must remain visible' },
    }))
    const selected = managedSession('empty-history-session', '9'.repeat(64), 'Empty history')
    const sessionManager = {
      resolveForImport: vi.fn(async () => ({ session: selected, path: rollout })),
    } as unknown as CodexSessionManager
    const harness = harnessFetch({ sessionIds: [selected.id], emptyHistory: true })
    const service = new DeepSeekHarnessSessionImportService({
      sessionManager,
      harnessHome,
      fetchImplementation: harness.fetchImplementation,
      verificationTimeoutMs: 20,
    })

    const result = await service.import([{ id: selected.id, expectedRevision: selected.revision }])

    expect(result).toMatchObject({ imported: 0, alreadyImported: 0, failed: 1 })
    expect(result.items[0]?.error).toContain('did not expose the migrated conversation')
    const files = await readdir(harnessHome, { recursive: true })
    expect(files.some((entry) => String(entry).endsWith('session.jsonl.zstd'))).toBe(false)
    expect(files.some((entry) => String(entry).endsWith('.stone-codex-import.json'))).toBe(false)
  })

  it('does not report success until the imported session is attached to its workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-harness-import-'))
    temporaryDirectories.push(directory)
    const harnessHome = join(directory, 'harness-home')
    const rollout = join(directory, 'detached-session.jsonl')
    await writeFile(rollout, JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: 'Attach me to the project' },
    }))
    const selected = managedSession('detached-session', '8'.repeat(64), 'Detached session')
    const sessionManager = {
      resolveForImport: vi.fn(async () => ({ session: selected, path: rollout })),
    } as unknown as CodexSessionManager
    const harness = harnessFetch({ sessionIds: [selected.id], skipWorkspaceAttachment: true })
    const service = new DeepSeekHarnessSessionImportService({
      sessionManager,
      harnessHome,
      fetchImplementation: harness.fetchImplementation,
      verificationTimeoutMs: 20,
    })

    const result = await service.import([{ id: selected.id, expectedRevision: selected.revision }])

    expect(result).toMatchObject({ imported: 0, alreadyImported: 0, failed: 1 })
    expect(result.items[0]?.error).toContain('did not attach the migrated conversation to its project')
    const files = await readdir(harnessHome, { recursive: true })
    expect(files.some((entry) => String(entry).endsWith('.stone-codex-import.json'))).toBe(false)
  })
})

function managedSession(id: string, revision: string, title: string): CodexManagedSession {
  return {
    id,
    revision,
    title,
    kind: 'active',
    relativePath: `sessions/${id}.jsonl`,
    cwd: 'D:\\project\\demo',
    modelProvider: 'stone',
    updatedAt: 1,
    sizeBytes: 100,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
  }
}

function harnessFetch(options: {
  sessionIds?: string[]
  emptyHistory?: boolean
  canonicalWorkspacePath?: string
  skipWorkspaceAttachment?: boolean
} = {}): {
  fetchImplementation: typeof fetch
  methods: string[]
  workspaceCount: () => number
} {
  const methods: string[] = []
  const workspaces: Array<{
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
    createdAt: string
    updatedAt: string
  }> = []
  const workspaceAliases = new Map<string, typeof workspaces[number]>()
  const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      rpcId: string
      method: string
      payload: Record<string, unknown>
    }
    methods.push(request.method)
    let value: unknown = {}
    if (request.method === 'workspace.create') {
      const path = String(request.payload.path)
      let workspace = workspaceAliases.get(path) ?? workspaces.find((entry) => entry.path === path)
      const created = workspace === undefined
      if (!workspace) {
        workspace = {
          workspaceId: `workspace-${workspaces.length + 1}`,
          path: options.canonicalWorkspacePath ?? path,
          title: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
          sessionIds: [],
          createdAt: '2026-08-14T00:00:00.000Z',
          updatedAt: '2026-08-14T00:00:00.000Z',
        }
        workspaces.push(workspace)
      }
      workspaceAliases.set(path, workspace)
      value = { workspace: { ...workspace, sessionIds: [...workspace.sessionIds] }, created }
    }
    if (request.method === 'session.list') {
      value = {
        items: (options.sessionIds ?? []).map((sessionId) => ({
          sessionId: importedHarnessSessionId(sessionId),
          updatedAt: 1,
          running: false,
          blank: false,
          cwd: 'D:\\project\\demo',
          agentPreset: 'standard',
        })),
      }
    }
    if (request.method === 'session.create') {
      const workspace = workspaces.find((entry) => entry.workspaceId === request.payload.workspaceId)
      const sessionId = String(request.payload.sessionId)
      if (!options.skipWorkspaceAttachment && workspace && !workspace.sessionIds.includes(sessionId)) {
        workspace.sessionIds.unshift(sessionId)
      }
      value = { sessionId }
    }
    if (request.method === 'workspace.list') {
      value = {
        items: workspaces.map((workspace) => ({
          ...workspace,
          sessionIds: [...workspace.sessionIds],
        })),
        archivedSessionIds: [],
      }
    }
    if (request.method === 'session.history') {
      value = {
        events: options.emptyHistory ? [] : [
          { event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 1, time: 1, data: {} } },
        ],
        hasMore: false,
      }
    }
    if (request.method === 'session.rename') value = { title: request.payload.title, seq: 1 }
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImplementation, methods, workspaceCount: () => workspaces.length }
}

function importedHarnessSessionId(sourceId: string): string {
  return `stone-codex-v2-${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}`
}

function decodeZstdFrames(buffer: Buffer): Buffer {
  return Buffer.concat(scanZstdFrames(buffer).map(({ start, end }) => (
    zstdDecompressSync(buffer.subarray(start, end))
  )))
}

function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== 0xFD2FB528) {
      throw new Error(`Invalid Zstandard frame at byte ${offset}.`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('Truncated Zstandard block header.')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const blockType = (blockHeader >>> 1) & 0x03
      const payloadBytes = blockType === 0x01 ? 1 : blockHeader >>> 3
      if (blockType === 0x03 || buffer.length - offset < payloadBytes) {
        throw new Error('Invalid Zstandard block.')
      }
      offset += payloadBytes
      if ((blockHeader & 1) !== 0) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error('Truncated Zstandard checksum.')
    frames.push({ start, end: offset })
  }
  return frames
}

function expectNativeHarnessEvents(records: Array<Record<string, unknown>>): void {
  expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index))
  let openTurn = 0
  let openStep = 0
  const pendingCalls = new Set<string>()
  for (const record of records) {
    const data = record.data as Record<string, unknown>
    if (record.type === 'turn/start') openTurn = Number(data.turn)
    if (record.type === 'step/start') openStep = Number(data.step)
    if (record.type === 'assistant/message') {
      const message = data.message as Record<string, unknown>
      expect(data).toMatchObject({ turn: openTurn, step: openStep })
      expect(message).toMatchObject({ role: 'assistant', source: { kind: 'model' } })
      expect(typeof message.id).toBe('string')
    }
    if (record.type === 'tool/call') pendingCalls.add(String(data.callId))
    if (record.type === 'tool/result') {
      const message = data.message as { source: { callId: string }; content: Array<{ toolCallId: string }> }
      expect(pendingCalls.delete(message.source.callId)).toBe(true)
      expect(message.content[0]?.toolCallId).toBe(message.source.callId)
    }
    if (record.type === 'step/end') openStep = 0
    if (record.type === 'turn/end') openTurn = 0
  }
  expect(openTurn).toBe(0)
  expect(openStep).toBe(0)
  expect(pendingCalls.size).toBe(0)
}
