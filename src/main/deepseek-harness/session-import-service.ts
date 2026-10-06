import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdCompress, zstdCompressSync } from 'node:zlib'
import type {
  CodexHarnessSessionImportItemResult,
  CodexHarnessSessionImportResult,
  CodexHarnessSessionImportSelection,
  CodexManagedSession,
} from '@shared/types'
import type { CodexSessionManager } from '../codex'
import { atomicWriteFile, readTextIfPresent } from '../client-config/filesystem'
import { DeepSeekHarnessRpcClient } from './rpc-client'

const MAX_SELECTIONS = 50
const IMPORT_RECEIPT_NAME = '.stone-codex-import.json'
const SESSION_FORMAT_VERSION = 0
const CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

interface VisibleMessage {
  role: 'user' | 'assistant'
  text: string
}

interface TextSemanticItem {
  kind: 'user' | 'assistant-text' | 'assistant-reasoning'
  text: string
  time: number
}

interface ToolCallSemanticItem {
  kind: 'tool-call'
  callId: string
  name: string
  arguments: string
  time: number
}

interface ToolResultSemanticItem {
  kind: 'tool-result'
  callId: string
  output: string
  isError: boolean
  time: number
}

interface ModelSemanticItem {
  kind: 'model'
  model: string
  time: number
}

type SemanticItem = TextSemanticItem | ToolCallSemanticItem | ToolResultSemanticItem | ModelSemanticItem

interface HarnessEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append'
  ignorable?: true
}

interface ImportReceipt {
  version: 1
  sourceSessionId: string
  sourceRevision: string
  harnessSessionId: string
  importedAt: number
}

export interface DeepSeekHarnessSessionImportServiceOptions {
  sessionManager: CodexSessionManager
  isHarnessRunning?: () => Promise<boolean>
  harnessHome: string
  fetchImplementation?: typeof fetch
  harnessOrigin?: string
  verificationTimeoutMs?: number
}

export class DeepSeekHarnessSessionImportService {
  private readonly sessionManager: CodexSessionManager
  private readonly isHarnessRunning: () => Promise<boolean>
  private readonly harnessHome: string
  private readonly rpcClient: DeepSeekHarnessRpcClient
  private readonly verificationTimeoutMs: number
  private importQueue: Promise<void> = Promise.resolve()

  public constructor(options: DeepSeekHarnessSessionImportServiceOptions) {
    this.sessionManager = options.sessionManager
    this.isHarnessRunning = options.isHarnessRunning ?? (async () => false)
    if (!options.harnessHome.trim()) throw new Error('DeepSeek Harness home is required for session import.')
    this.harnessHome = resolve(options.harnessHome)
    this.rpcClient = new DeepSeekHarnessRpcClient({
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      ...(options.harnessOrigin ? { origin: options.harnessOrigin } : {}),
    })
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 10_000
    if (!Number.isSafeInteger(this.verificationTimeoutMs) || this.verificationTimeoutMs < 1) {
      throw new Error('DeepSeek Harness import verification timeout is invalid.')
    }
  }

  public import(
    selections: readonly CodexHarnessSessionImportSelection[],
  ): Promise<CodexHarnessSessionImportResult> {
    const normalized = validateSelections(selections)
    const task = this.importQueue.then(() => this.performImport(normalized))
    this.importQueue = task.then(() => undefined, () => undefined)
    return task
  }

  private async performImport(
    normalized: readonly CodexHarnessSessionImportSelection[],
  ): Promise<CodexHarnessSessionImportResult> {
    const harnessMayBeRunning = await this.isHarnessRunning()
    const harnessReady = await this.rpcClient.isReady(harnessMayBeRunning ? 2_000 : 350)
    if (harnessMayBeRunning && !harnessReady) {
      throw new Error('DeepSeek Harness is running but not ready. Wait for it to finish starting, or close it before migrating sessions.')
    }
    if (!harnessReady && await this.isHarnessRunning()) {
      throw new Error('DeepSeek Harness started while the migration was being prepared. Wait for it to finish starting, then retry.')
    }
    const items: CodexHarnessSessionImportItemResult[] = []
    for (const selection of normalized) {
      let resolved: Awaited<ReturnType<CodexSessionManager['resolveForImport']>>
      try {
        resolved = await this.sessionManager.resolveForImport(selection.id, selection.expectedRevision)
      } catch (error) {
        items.push({ sourceSessionId: selection.id, status: 'failed', error: errorMessage(error) })
        continue
      }
      const { session, path: rolloutPath } = resolved
      try {
        items.push(await this.importOne(session, selection.expectedRevision, rolloutPath, harnessReady))
      } catch (error) {
        items.push({
          sourceSessionId: selection.id,
          title: session.title,
          status: 'failed',
          error: errorMessage(error),
        })
      }
    }
    return {
      items,
      imported: items.filter((item) => item.status === 'imported').length,
      alreadyImported: items.filter((item) => item.status === 'already-imported').length,
      failed: items.filter((item) => item.status === 'failed').length,
    }
  }

  private async importOne(
    session: CodexManagedSession,
    expectedRevision: string,
    rolloutPath: string,
    harnessReady: boolean,
  ): Promise<CodexHarnessSessionImportItemResult> {
    const requestedCwd = await resolveImportCwd(session, rolloutPath)
    const workspace = harnessReady
      ? (await this.rpcClient.ensureWorkspace(requestedCwd)).workspace
      : undefined
    const cwd = workspace?.path ?? await canonicalWorkspacePath(requestedCwd)
    const harnessSessionId = harnessSessionIdFor(session.id)
    const paths = harnessSessionPaths(this.harnessHome, cwd, harnessSessionId)
    const receipt = await readImportReceipt(paths.receipt)
    if (await fileExists(paths.log)) {
      if (!harnessReady) {
        if (receipt && receipt.sourceSessionId !== session.id) {
          throw new Error('The target DeepSeek Harness session belongs to another Codex conversation.')
        }
        if (receipt) {
          await registerOfflineHarnessSession(this.harnessHome, cwd, harnessSessionId)
          return {
            sourceSessionId: session.id,
            harnessSessionId,
            title: session.title,
            status: 'already-imported',
          }
        }
        await rm(paths.log, { force: true })
      }
    }
    if (harnessReady && await fileExists(paths.log)) {
      try {
        await this.rpcClient.waitForImportedSession(harnessSessionId, this.verificationTimeoutMs)
      } catch {
        await Promise.all([
          rm(paths.log, { force: true }),
          rm(paths.receipt, { force: true }),
        ])
      }
      if (await fileExists(paths.log)) {
        await this.rpcClient.attachImportedSession(
          workspace!.workspaceId,
          harnessSessionId,
          this.verificationTimeoutMs,
        )
        if (!receipt || receipt.sourceSessionId !== session.id) {
          await writeImportReceipt(paths.receipt, importReceipt(session, expectedRevision, harnessSessionId))
        }
        return {
          sourceSessionId: session.id,
          harnessSessionId,
          title: session.title,
          status: 'already-imported',
        }
      }
    }

    const published = await writeHarnessSession(paths.log, rolloutPath, session, harnessSessionId, cwd)
    if (!harnessReady) {
      try {
        await writeImportReceipt(paths.receipt, importReceipt(session, expectedRevision, harnessSessionId))
        await registerOfflineHarnessSession(this.harnessHome, cwd, harnessSessionId)
      } catch (error) {
        if (published) {
          await Promise.all([
            rm(paths.log, { force: true }).catch(() => undefined),
            rm(paths.receipt, { force: true }).catch(() => undefined),
          ])
        }
        throw error
      }
      return {
        sourceSessionId: session.id,
        harnessSessionId,
        title: session.title,
        status: published ? 'imported' : 'already-imported',
      }
    }
    try {
      await this.rpcClient.waitForImportedSession(harnessSessionId, this.verificationTimeoutMs)
    } catch (error) {
      await Promise.all([
        rm(paths.log, { force: true }).catch(() => undefined),
        rm(paths.receipt, { force: true }).catch(() => undefined),
      ])
      throw error
    }

    await this.rpcClient.attachImportedSession(
      workspace!.workspaceId,
      harnessSessionId,
      this.verificationTimeoutMs,
    )
    await writeImportReceipt(paths.receipt, importReceipt(session, expectedRevision, harnessSessionId))
    return {
      sourceSessionId: session.id,
      harnessSessionId,
      title: session.title,
      status: published ? 'imported' : 'already-imported',
    }
  }
}

/** Visible-text compatibility helper retained for diagnostics and focused tests. */
export async function readVisibleCodexTranscript(path: string): Promise<VisibleMessage[]> {
  const messages: VisibleMessage[] = []
  for await (const item of readCodexSemanticItems(path)) {
    if (item.kind === 'user' || item.kind === 'assistant-text') {
      const role = item.kind === 'user' ? 'user' : 'assistant'
      const previous = messages.at(-1)
      if (previous?.role !== role || previous.text !== item.text) messages.push({ role, text: item.text })
    }
  }
  return messages
}

async function writeHarnessSession(
  target: string,
  rolloutPath: string,
  session: CodexManagedSession,
  harnessSessionId: string,
  cwd: string,
): Promise<boolean> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
  const createdAt = normalizedCreatedAt(session.updatedAt)
  const header = `${JSON.stringify({
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: harnessSessionId,
    createdAt,
    cwd,
    delegationDepth: 0,
    agentPreset: 'standard',
  })}\n`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(zstdCompressSync(header, CHECKSUM_OPTIONS))
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    const eventLines = harnessEventLines(rolloutPath, session, harnessSessionId, createdAt)
    await pipeline(
      Readable.from(eventLines),
      createZstdCompress(CHECKSUM_OPTIONS),
      createWriteStream(temporary, { flags: 'a' }),
    )
    const completed = await open(temporary, 'r+')
    try { await completed.sync() } finally { await completed.close() }
    try {
      await link(temporary, target)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function* harnessEventLines(
  rolloutPath: string,
  session: CodexManagedSession,
  harnessSessionId: string,
  createdAt: number,
): AsyncGenerator<string> {
  const builder = new HarnessEventBuilder(
    harnessSessionId,
    session.modelProvider ?? 'codex',
    importedTitle(session.title),
    createdAt,
  )
  for await (const item of readCodexSemanticItems(rolloutPath)) {
    for (const event of builder.accept(item)) yield `${JSON.stringify(event)}\n`
  }
  for (const event of builder.finish()) yield `${JSON.stringify(event)}\n`
  if (builder.messageCount === 0) throw new Error('The selected Codex session has no migratable conversation messages.')
}

class HarnessEventBuilder {
  private seq = 0
  private lastTime: number
  private turn = 0
  private step = 0
  private model: string
  private turnOpen = false
  private stepOpen = false
  private assistantBlocks: Array<Record<string, unknown>> = []
  private readonly pendingCalls = new Map<string, { name: string; arguments: string }>()
  private readonly usedCallIds = new Set<string>()
  private readonly sourceId: string
  private readonly title: string
  messageCount = 0

  constructor(sourceId: string, model: string, title: string, createdAt: number) {
    this.sourceId = sourceId
    this.model = model.trim() || 'codex-import'
    this.title = title
    this.lastTime = createdAt
  }

  accept(item: SemanticItem): HarnessEvent[] {
    switch (item.kind) {
      case 'model':
        this.model = item.model
        return []
      case 'user':
        return this.acceptUser(item)
      case 'assistant-text':
      case 'assistant-reasoning':
        return this.acceptAssistantBlock(item)
      case 'tool-call':
        return this.acceptToolCall(item)
      case 'tool-result':
        return this.acceptToolResult(item)
    }
  }

  finish(): HarnessEvent[] {
    const events: HarnessEvent[] = []
    events.push(...this.flushAssistant(this.lastTime))
    events.push(...this.closeStep(this.lastTime))
    events.push(...this.closeTurn(this.lastTime))
    events.push(this.event('session/title', {
      title: this.title,
      messageSeqs: [],
      source: { kind: 'user' },
    }, this.lastTime))
    return events
  }

  private acceptUser(item: TextSemanticItem): HarnessEvent[] {
    const events = [
      ...this.flushAssistant(item.time),
      ...this.closeStep(item.time),
      ...this.closeTurn(item.time),
      ...this.openTurn(item.time),
    ]
    events.push(this.event('user/message', {
      id: this.messageId('user'),
      role: 'user',
      content: [{ type: 'text', text: item.text }],
      source: { kind: 'user' },
    }, item.time, true))
    this.messageCount += 1
    return events
  }

  private acceptAssistantBlock(item: TextSemanticItem): HarnessEvent[] {
    const events = this.stepOpen ? this.closeStep(item.time) : []
    this.assistantBlocks.push({
      type: item.kind === 'assistant-reasoning' ? 'reasoning' : 'text',
      text: item.text,
    })
    return events
  }

  private acceptToolCall(item: ToolCallSemanticItem): HarnessEvent[] {
    const events = this.stepOpen ? this.closeStep(item.time) : []
    const callId = this.uniqueCallId(item.callId)
    this.pendingCalls.set(callId, { name: item.name, arguments: item.arguments })
    this.assistantBlocks.push({
      type: 'tool-call',
      id: callId,
      name: item.name,
      arguments: item.arguments,
    })
    return events
  }

  private acceptToolResult(item: ToolResultSemanticItem): HarnessEvent[] {
    const events: HarnessEvent[] = []
    let callId = this.resolveCallId(item.callId)
    if (!callId) {
      callId = this.uniqueCallId(item.callId)
      this.pendingCalls.set(callId, { name: 'codex_imported_tool', arguments: '{}' })
      this.assistantBlocks.push({
        type: 'tool-call', id: callId, name: 'codex_imported_tool', arguments: '{}',
      })
    }
    events.push(...this.flushAssistant(item.time))
    const pending = this.pendingCalls.get(callId)
    if (!pending || !this.stepOpen) return events
    events.push(this.toolResultEvent(callId, item.output, item.isError, item.time))
    this.pendingCalls.delete(callId)
    return events
  }

  private flushAssistant(time: number): HarnessEvent[] {
    if (this.assistantBlocks.length === 0) return []
    const events = [...this.openTurn(time), ...this.openStep(time)]
    const blocks = this.assistantBlocks.splice(0)
    events.push(this.event('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: {
        id: this.messageId('assistant'),
        role: 'assistant',
        content: blocks,
        source: { kind: 'model', provider: 'codex-import', model: this.model },
      },
    }, time, true))
    for (const block of blocks) {
      if (block.type !== 'tool-call') continue
      events.push(this.event('tool/call', {
        turn: this.turn,
        step: this.step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      }, time))
    }
    this.messageCount += 1
    if (this.pendingCalls.size === 0) events.push(...this.closeStep(time))
    return events
  }

  private openTurn(time: number): HarnessEvent[] {
    if (this.turnOpen) return []
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    return [this.event('turn/start', { turn: this.turn }, time)]
  }

  private closeTurn(time: number): HarnessEvent[] {
    if (!this.turnOpen) return []
    const events = [...this.closeStep(time)]
    events.push(this.event('turn/end', { turn: this.turn, reason: { kind: 'completed' } }, time))
    this.turnOpen = false
    return events
  }

  private openStep(time: number): HarnessEvent[] {
    if (this.stepOpen) return []
    this.step += 1
    this.stepOpen = true
    return [this.event('step/start', { turn: this.turn, step: this.step }, time)]
  }

  private closeStep(time: number): HarnessEvent[] {
    if (!this.stepOpen) return []
    const events: HarnessEvent[] = []
    for (const callId of this.pendingCalls.keys()) {
      events.push(this.toolResultEvent(
        callId,
        'Stone+ could not find a completed result for this historical Codex tool call.',
        true,
        time,
      ))
    }
    this.pendingCalls.clear()
    events.push(this.event('step/end', { turn: this.turn, step: this.step }, time))
    this.stepOpen = false
    return events
  }

  private toolResultEvent(callId: string, output: string, isError: boolean, time: number): HarnessEvent {
    return this.event('tool/result', {
      turn: this.turn,
      step: this.step,
      message: {
        id: this.messageId('tool-result'),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: output }],
          ...(isError ? { isError: true } : {}),
        }],
        source: { kind: 'tool', callId },
      },
    }, time, true)
  }

  private event(
    type: string,
    data: Record<string, unknown>,
    sourceTime: number,
    surface = false,
  ): HarnessEvent {
    const time = Math.max(this.lastTime, normalizedCreatedAt(sourceTime))
    this.lastTime = time
    return {
      type,
      seq: this.seq++,
      time,
      data,
      ...(surface ? { surfaceOp: 'append' as const } : {}),
    }
  }

  private messageId(kind: string): string {
    return `stone-${createHash('sha256').update(`${this.sourceId}:${kind}:${this.seq}`).digest('hex').slice(0, 32)}`
  }

  private uniqueCallId(raw: string): string {
    const base = raw.trim() || `stone-call-${this.seq}`
    let candidate = base
    let suffix = 1
    while (this.usedCallIds.has(candidate)) candidate = `${base}-${suffix++}`
    this.usedCallIds.add(candidate)
    return candidate
  }

  private resolveCallId(raw: string): string | undefined {
    if (this.pendingCalls.has(raw)) return raw
    return [...this.pendingCalls.keys()].find((candidate) => candidate === raw || candidate.startsWith(`${raw}-`))
  }
}

async function* readCodexSemanticItems(path: string): AsyncGenerator<SemanticItem> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  const recentMessages = new Map<string, number>()
  let recordIndex = 0
  for await (const line of lines) {
    recordIndex += 1
    let record: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) continue
      record = parsed
    } catch { continue }
    const payload = isRecord(record.payload) ? record.payload : undefined
    if (!payload) continue
    const time = recordTime(record)
    if (record.type === 'turn_context') {
      const model = stringValue(payload.model)?.trim()
      if (model) yield { kind: 'model', model, time }
      continue
    }
    const payloadType = stringValue(payload.type)
    if (record.type === 'event_msg' && (payloadType === 'user_message' || payloadType === 'user_input'
      || payloadType === 'agent_message' || payloadType === 'assistant_message')) {
      const role = payloadType === 'user_message' || payloadType === 'user_input' ? 'user' : 'assistant-text'
      const text = normalizedText(stringValue(payload.message) ?? stringValue(payload.text))
      if (text && !isRecentDuplicate(recentMessages, `${role}:${text}`, recordIndex)) yield { kind: role, text, time }
      continue
    }
    if (record.type !== 'response_item' || !payloadType) continue
    if (payloadType === 'message') {
      const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant-text' : undefined
      if (!role) continue
      const text = messageContentText(payload.content)
      if (text && !isRecentDuplicate(recentMessages, `${role}:${text}`, recordIndex)) yield { kind: role, text, time }
      continue
    }
    if (payloadType === 'reasoning') {
      const text = reasoningSummaryText(payload.summary)
      if (text) yield { kind: 'assistant-reasoning', text, time }
      continue
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      yield {
        kind: 'tool-call',
        callId: stringValue(payload.call_id) ?? stringValue(payload.id) ?? '',
        name: stringValue(payload.name)?.trim() || 'codex_imported_tool',
        arguments: payloadType === 'custom_tool_call'
          ? customToolArguments(payload.input)
          : functionToolArguments(payload.arguments),
        time,
      }
      continue
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      yield {
        kind: 'tool-result',
        callId: stringValue(payload.call_id) ?? stringValue(payload.id) ?? '',
        output: toolOutputText(payload.output),
        isError: payload.status === 'failed' || payload.is_error === true,
        time,
      }
    }
  }
}

function harnessSessionPaths(
  harnessHome: string,
  cwd: string,
  harnessSessionId: string,
): { log: string; receipt: string } {
  const project = projectKey(cwd)
  const directory = join(harnessHome, 'sessions', project, encodeSegment(harnessSessionId))
  return {
    log: join(directory, 'session.jsonl.zstd'),
    receipt: join(directory, IMPORT_RECEIPT_NAME),
  }
}

async function resolveImportCwd(session: CodexManagedSession, rolloutPath: string): Promise<string> {
  const listed = normalizedCwd(session.cwd)
  if (listed) return listed
  const recorded = await readRolloutCwd(rolloutPath)
  return recorded ?? homedir()
}

async function canonicalWorkspacePath(path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error('The imported Codex project path is not a directory.')
  }
  return canonical
}

interface HarnessWorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

async function registerOfflineHarnessSession(
  harnessHome: string,
  cwd: string,
  sessionId: string,
): Promise<void> {
  const registryPath = join(harnessHome, 'storages', 'workspace.json')
  const existing = await readTextIfPresent(registryPath)
  const document = existing === undefined
    ? emptyWorkspaceRegistry()
    : parseWorkspaceRegistry(existing)
  const global = document.global as Record<string, unknown>
  const tables = document.tables as Record<string, unknown>
  const workspaces = { ...(tables.workspaces as Record<string, HarnessWorkspaceRecord>) }
  const workspaceIds = [...(global.workspaceIds as string[])]
  const archivedSessionIds = (global.archivedSessionIds as string[])
    .filter((candidate) => candidate !== sessionId)

  let workspaceId = workspaceIds.find((id) => sameWorkspacePath(workspaces[id]?.path, cwd))
  if (!workspaceId) {
    workspaceId = randomUUID()
    const now = new Date().toISOString()
    workspaces[workspaceId] = {
      path: cwd,
      title: basename(cwd),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
  }
  for (const [id, record] of Object.entries(workspaces)) {
    const sessionIds = record.sessionIds.filter((candidate) => candidate !== sessionId)
    workspaces[id] = id === workspaceId
      ? { ...record, sessionIds: [sessionId, ...sessionIds], updatedAt: new Date().toISOString() }
      : { ...record, sessionIds }
  }
  const orderedIds = [
    workspaceId,
    ...workspaceIds.filter((id) => id !== workspaceId),
    ...Object.keys(workspaces).filter((id) => id !== workspaceId && !workspaceIds.includes(id)),
  ]
  const output = {
    ...document,
    global: {
      ...global,
      initialized: true,
      workspaceIds: orderedIds,
      archivedSessionIds,
    },
    tables: { ...tables, workspaces },
  }
  await atomicWriteFile(registryPath, `${JSON.stringify(output, null, 2)}\n`, randomUUID)
}

function emptyWorkspaceRegistry(): Record<string, unknown> {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  }
}

function parseWorkspaceRegistry(text: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    throw new Error('DeepSeek Harness workspace registry is not valid JSON.')
  }
  if (!isRecord(parsed) || !isRecord(parsed.unit) || parsed.unit.name !== 'workspace'
    || parsed.unit.version !== 2 || !isRecord(parsed.global) || !isRecord(parsed.tables)
    || !isRecord(parsed.tables.workspaces) || !Array.isArray(parsed.global.workspaceIds)
    || !parsed.global.workspaceIds.every((id) => typeof id === 'string')
    || !Array.isArray(parsed.global.archivedSessionIds)
    || !parsed.global.archivedSessionIds.every((id) => typeof id === 'string')
    || parsed.global.pendingMutation !== undefined) {
    throw new Error('DeepSeek Harness workspace registry is incompatible or mid-update.')
  }
  const workspaces = parsed.tables.workspaces
  for (const [id, value] of Object.entries(workspaces)) {
    if (!id || !isRecord(value) || typeof value.path !== 'string' || typeof value.title !== 'string'
      || !Array.isArray(value.sessionIds) || !value.sessionIds.every((sessionId) => typeof sessionId === 'string')
      || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
      throw new Error('DeepSeek Harness workspace registry contains an invalid workspace.')
    }
  }
  return parsed
}

function sameWorkspacePath(left: string | undefined, right: string): boolean {
  if (!left) return false
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

async function readRolloutCwd(path: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let inspected = 0
  try {
    for await (const line of lines) {
      inspected += 1
      try {
        const record = JSON.parse(line) as unknown
        if (isRecord(record) && record.type === 'session_meta' && isRecord(record.payload)) {
          const cwd = normalizedCwd(stringValue(record.payload.cwd))
          if (cwd) return cwd
        }
      } catch { /* Continue past malformed historical records. */ }
      if (inspected >= 64) return undefined
    }
    return undefined
  } finally {
    lines.close()
  }
}

function importReceipt(
  session: CodexManagedSession,
  expectedRevision: string,
  harnessSessionId: string,
): ImportReceipt {
  return {
    version: 1,
    sourceSessionId: session.id,
    sourceRevision: expectedRevision,
    harnessSessionId,
    importedAt: Date.now(),
  }
}

function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function encodeSegment(raw: string): string {
  if (!raw) throw new Error('Cannot encode an empty DeepSeek Harness session id.')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let output = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    output += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return output
}

async function readImportReceipt(path: string): Promise<ImportReceipt | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ImportReceipt>
    return parsed.version === 1
      && typeof parsed.sourceSessionId === 'string'
      && typeof parsed.sourceRevision === 'string'
      && typeof parsed.harnessSessionId === 'string'
      && typeof parsed.importedAt === 'number'
      ? parsed as ImportReceipt
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

async function writeImportReceipt(path: string, receipt: ImportReceipt): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // A prior crash may leave an invalid or stale receipt. The import queue
    // serializes writers, so replacing it here cannot clobber another import.
    await rm(path, { force: true })
    await link(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function messageContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return normalizedText(value.flatMap((item) => {
    if (!isRecord(item)) return []
    const type = stringValue(item.type)
    if (type !== 'input_text' && type !== 'output_text' && type !== 'text') return []
    const text = stringValue(item.text)
    return text ? [text] : []
  }).join('\n'))
}

function reasoningSummaryText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return normalizedText(value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (!isRecord(item)) return []
    const text = stringValue(item.text) ?? stringValue(item.summary_text)
    return text ? [text] : []
  }).join('\n'))
}

function functionToolArguments(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value)
      return value
    } catch {
      return JSON.stringify({ input: value })
    }
  }
  if (value === undefined || value === null) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}

function customToolArguments(value: unknown): string {
  try { return JSON.stringify({ input: value ?? '' }) } catch { return '{"input":""}' }
}

function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(toolOutputText).filter(Boolean).join('\n')
  if (!isRecord(value)) return String(value)
  const type = stringValue(value.type)
  if (type === 'image' || type === 'input_image' || type === 'audio') {
    return `[${type} content omitted during Codex session migration]`
  }
  const text = stringValue(value.text)
  if (text !== undefined) return text
  if (Object.hasOwn(value, 'content')) return toolOutputText(value.content)
  try {
    return JSON.stringify(value, (key, entry) => (
      (key === 'data' || key === 'image_url') && typeof entry === 'string'
        ? '[binary content omitted during Codex session migration]'
        : entry
    ))
  } catch {
    return '[unserializable tool output omitted during Codex session migration]'
  }
}

function normalizedText(value: string | undefined): string | undefined {
  const text = value?.replace(/\r\n/g, '\n').trim()
  return text || undefined
}

function recordTime(record: Record<string, unknown>): number {
  if (typeof record.timestamp === 'number') return normalizedCreatedAt(record.timestamp)
  if (typeof record.timestamp === 'string') {
    const parsed = Date.parse(record.timestamp)
    if (Number.isFinite(parsed)) return normalizedCreatedAt(parsed)
  }
  return Date.now()
}

function normalizedCreatedAt(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
}

function normalizedCwd(value: string | undefined): string | undefined {
  const cwd = value?.trim()
  return cwd && isAbsolute(cwd) ? cwd : undefined
}

function isRecentDuplicate(seen: Map<string, number>, fingerprint: string, recordIndex: number): boolean {
  const previous = seen.get(fingerprint)
  seen.set(fingerprint, recordIndex)
  if (seen.size > 64) {
    for (const [key, index] of seen) if (recordIndex - index > 16) seen.delete(key)
  }
  return previous !== undefined && recordIndex - previous <= 8
}

function harnessSessionIdFor(sourceId: string): string {
  return `stone-codex-v2-${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    await handle.close()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function importedTitle(title: string): string {
  const trimmed = title.trim() || 'Codex 会话'
  return `Codex · ${trimmed}`.slice(0, 120)
}

function validateSelections(
  selections: readonly CodexHarnessSessionImportSelection[],
): CodexHarnessSessionImportSelection[] {
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > MAX_SELECTIONS) {
    throw new Error(`Select between 1 and ${MAX_SELECTIONS} Codex sessions.`)
  }
  const seen = new Set<string>()
  return selections.map((selection) => {
    const id = selection?.id?.trim()
    const expectedRevision = selection?.expectedRevision?.trim()
    if (!id || id.length > 200 || !expectedRevision || !/^[a-f0-9]{64}$/i.test(expectedRevision)) {
      throw new Error('A selected Codex session is invalid or stale.')
    }
    if (seen.has(id)) throw new Error('A Codex session was selected more than once.')
    seen.add(id)
    return { id, expectedRevision: expectedRevision.toLowerCase() }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
