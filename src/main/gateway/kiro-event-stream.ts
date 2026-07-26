import type {
  CanonicalProtocolState,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalStreamParser
} from './streaming'

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024
const MIN_FRAME_BYTES = 16
const DEFAULT_MAX_CUMULATIVE_TEXT_CHARACTERS = 16 * 1024 * 1024
const DEFAULT_MAX_TOOL_COUNT = 128
const DEFAULT_MAX_TOTAL_TOOL_INPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_ACTIVE_TOOL_COUNT = 64
const DEFAULT_MAX_PENDING_TOOL_COUNT = 64
const DEFAULT_MAX_COMPLETED_TOOL_COUNT = 128
const MAX_SCHEMA_VALIDATION_DEPTH = 64
const KIRO_JSON_EVENT_TYPES = new Set([
  'assistantResponseEvent',
  'reasoningContentEvent',
  'toolUseEvent',
  'metadataEvent',
  'meteringEvent',
  'invalidStateEvent',
  'messageMetadataEvent'
])
const KIRO_IGNORED_EVENT_TYPES = new Set([
  'contextUsageEvent',
  'followupPromptEvent',
  'citationEvent',
  'codeEvent',
  'codeReferenceEvent',
  'supplementaryWebLinksEvent',
  'intentsEvent',
  'interactionComponentsEvent',
  'dryRunSucceedEvent',
  'initial-response'
])

type JsonObject = Record<string, unknown>

export interface KiroDeclaredTool {
  name: string
  /** The original or losslessly equivalent JSON Schema sent for this tool. */
  inputSchema: JsonObject
}

export interface KiroEventStreamOptions {
  /** Tool names declared on the downstream Anthropic request. Undeclared tools fail closed. */
  declaredToolNames?: Iterable<string>
  /** Tool declarations with schemas. Calls are validated before canonical events are emitted. */
  declaredTools?: Iterable<KiroDeclaredTool>
  /** Maximum size of one complete AWS Event Stream frame. */
  maxFrameBytes?: number
  /** Maximum retained cumulative assistant/reasoning snapshot. */
  maxCumulativeTextCharacters?: number
  /** Maximum distinct tool calls in one upstream response. */
  maxToolCount?: number
  /** Maximum aggregate UTF-8 bytes across all tool input fragments. */
  maxTotalToolInputBytes?: number
  /** Maximum simultaneously incomplete tool calls. */
  maxActiveToolCount?: number
  /** Maximum completed out-of-order calls waiting for an earlier call. */
  maxPendingToolCount?: number
  /** Maximum completed tool IDs retained to detect reuse. */
  maxCompletedToolCount?: number
}

export interface KiroEventStreamDiagnostics {
  recognizedEventCount: number
  assistantResponseEventCount: number
  reasoningEventCount: number
  toolUseEventCount: number
  completedToolUseCount: number
  usageEventCount: number
  structuralRecoveryCount: number
  conversationId?: string
  utteranceId?: string
  invalidStateReason?: string
}

export interface KiroCollectedToolCall {
  index: number
  id: string
  name: string
  input: JsonObject
}

export interface KiroCollectedResponse {
  text: string
  tools: KiroCollectedToolCall[]
  usage?: Extract<CanonicalStreamEvent, { type: 'usage' }>
  stopReason?: CanonicalStopReason
  structuralRecoveryCount: number
  recognizedEventCount: number
  error?: Extract<CanonicalStreamEvent, { type: 'error' }>
}

interface ParsedFrame {
  headers: Map<string, HeaderValue>
  payload: Uint8Array
}

type HeaderValue = boolean | number | bigint | string | Uint8Array

interface ToolState {
  index: number
  id: string
  name?: string
  inputParts: string[]
  inputCharacters: number
  inputMode?: 'fragments' | 'object'
}

interface CompletedToolState {
  index: number
  id: string
  name: string
  arguments: string
}

interface CollectedToolState {
  index: number
  id?: string
  name?: string
  arguments: string
  complete: boolean
}

class KiroStreamFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly errorType = 'invalid_upstream_response'
  ) {
    super(message)
    this.name = 'KiroStreamFailure'
  }
}

/**
 * Incremental Kiro/AWS Event Stream parser. It deliberately emits tool calls
 * only after their JSON and declared name have been validated. This prevents
 * an invalid or undeclared call from becoming actionable downstream output.
 */
export class KiroEventStreamParser implements CanonicalStreamParser {
  private readonly bytes = new ByteQueue()
  private readonly declaredToolNames: ReadonlySet<string>
  private readonly declaredToolSchemas: ReadonlyMap<string, JsonObject>
  private readonly maxFrameBytes: number
  private readonly maxCumulativeTextCharacters: number
  private readonly maxToolCount: number
  private readonly maxTotalToolInputBytes: number
  private readonly maxActiveToolCount: number
  private readonly maxPendingToolCount: number
  private readonly maxCompletedToolCount: number
  private readonly events: CanonicalStreamEvent[] = []
  private readonly tools = new Map<string, ToolState>()
  private readonly completedTools = new Map<number, CompletedToolState>()
  private readonly completedToolIds = new Set<string>()
  private readonly thinkingTagFilter = new ThinkingTagFilter()
  private diagnostics: KiroEventStreamDiagnostics = emptyDiagnostics()
  private lastAssistantContent = ''
  private lastReasoningContent = ''
  private nextToolIndex = 0
  private nextToolIndexToEmit = 0
  private totalToolInputBytes = 0
  private sawFrame = false
  private sawCompletedTool = false
  private failed = false
  private finished = false

  constructor(options: KiroEventStreamOptions = {}) {
    const declaredToolNames = new Set(options.declaredToolNames ?? [])
    const declaredToolSchemas = new Map<string, JsonObject>()
    for (const entry of options.declaredTools ?? []) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) {
        throw new TypeError('declaredTools entries must have a non-empty name')
      }
      if (!isJsonObject(entry.inputSchema)) {
        throw new TypeError(`declaredTools schema for ${JSON.stringify(entry.name)} must be an object`)
      }
      if (declaredToolSchemas.has(entry.name)) {
        throw new TypeError(`declaredTools contains duplicate name ${JSON.stringify(entry.name)}`)
      }
      declaredToolNames.add(entry.name)
      declaredToolSchemas.set(entry.name, entry.inputSchema)
    }
    this.declaredToolNames = declaredToolNames
    this.declaredToolSchemas = declaredToolSchemas
    this.maxFrameBytes = normalizeLimit(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      MIN_FRAME_BYTES,
      'maxFrameBytes'
    )
    this.maxCumulativeTextCharacters = normalizeLimit(
      options.maxCumulativeTextCharacters,
      DEFAULT_MAX_CUMULATIVE_TEXT_CHARACTERS,
      1,
      'maxCumulativeTextCharacters'
    )
    this.maxToolCount = normalizeLimit(options.maxToolCount, DEFAULT_MAX_TOOL_COUNT, 1, 'maxToolCount')
    this.maxTotalToolInputBytes = normalizeLimit(
      options.maxTotalToolInputBytes,
      DEFAULT_MAX_TOTAL_TOOL_INPUT_BYTES,
      1,
      'maxTotalToolInputBytes'
    )
    this.maxActiveToolCount = normalizeLimit(
      options.maxActiveToolCount,
      DEFAULT_MAX_ACTIVE_TOOL_COUNT,
      1,
      'maxActiveToolCount'
    )
    this.maxPendingToolCount = normalizeLimit(
      options.maxPendingToolCount,
      DEFAULT_MAX_PENDING_TOOL_COUNT,
      1,
      'maxPendingToolCount'
    )
    this.maxCompletedToolCount = normalizeLimit(
      options.maxCompletedToolCount,
      DEFAULT_MAX_COMPLETED_TOOL_COUNT,
      1,
      'maxCompletedToolCount'
    )
  }

  push(chunk: Uint8Array): CanonicalStreamEvent[] {
    if (this.finished || this.failed || chunk.byteLength === 0) return []
    this.bytes.push(chunk)
    this.drainFrames()
    return this.drainEvents()
  }

  finish(): CanonicalStreamEvent[] {
    if (this.finished) return []
    if (this.failed) {
      this.finished = true
      return this.drainEvents()
    }

    this.drainFrames()
    if (this.failed) {
      this.finished = true
      return this.drainEvents()
    }

    if (this.bytes.length > 0) {
      const message = this.bytes.length < 12
        ? `Kiro Event Stream ended with a truncated prelude (${this.bytes.length}/12 bytes)`
        : `Kiro Event Stream ended with a truncated frame (${this.bytes.length} buffered bytes)`
      this.emitFailure(new KiroStreamFailure('kiro_event_stream_truncated', message))
      this.finished = true
      return this.drainEvents()
    }

    if (!this.sawFrame) {
      this.emitFailure(new KiroStreamFailure(
        'kiro_event_stream_empty',
        'Kiro Event Stream ended without any frames'
      ))
      this.finished = true
      return this.drainEvents()
    }

    if (this.diagnostics.recognizedEventCount === 0) {
      this.emitFailure(new KiroStreamFailure(
        'kiro_event_stream_unrecognized',
        'Kiro Event Stream ended without a recognized event'
      ))
      this.finished = true
      return this.drainEvents()
    }

    try {
      this.recoverOrRejectUnfinishedTools()
      this.emitReadyTools()
      const filteredTail = this.thinkingTagFilter.finish()
      if (filteredTail.reasoningAdvanced) this.events.push({ type: 'reasoning-progress' })
      if (filteredTail.text) this.events.push({ type: 'text-delta', text: filteredTail.text })
      this.events.push({
        type: 'stop',
        reason: this.sawCompletedTool ? 'tool_calls' : 'stop',
        rawReason: this.sawCompletedTool ? 'tool_use' : 'end_turn'
      })
      this.events.push({ type: 'done' })
    } catch (error) {
      this.emitFailure(asKiroFailure(error))
    }
    this.finished = true
    return this.drainEvents()
  }

  getProtocolState(): CanonicalProtocolState {
    return {
      responsesEventCount: 0,
      responsesProgressEventCount: 0
    }
  }

  getRecognizedEventCount(): number {
    return this.diagnostics.recognizedEventCount
  }

  getResponsesTerminalResponse(): JsonObject | undefined {
    return undefined
  }

  getDiagnostics(): KiroEventStreamDiagnostics {
    return { ...this.diagnostics }
  }

  private drainFrames(): void {
    while (!this.failed && !this.finished && this.bytes.length >= 12) {
      try {
        const prelude = this.bytes.peek(12)
        validatePreludeCrc(prelude)
        const totalLength = readUint32(prelude, 0)
        const headersLength = readUint32(prelude, 4)
        validateFrameLengths(totalLength, headersLength, this.maxFrameBytes)
        if (this.bytes.length < totalLength) return
        const frame = parseFrame(this.bytes.read(totalLength), headersLength)
        this.sawFrame = true
        this.handleFrame(frame)
      } catch (error) {
        this.emitFailure(asKiroFailure(error))
      }
    }
  }

  private handleFrame(frame: ParsedFrame): void {
    const messageType = requiredStringHeader(frame.headers, ':message-type')
    const contentType = requiredStringHeader(frame.headers, ':content-type')
    if (!isJsonContentType(contentType)) {
      throw new KiroStreamFailure(
        'kiro_event_stream_content_type',
        `Kiro Event Stream frame has unsupported content type ${JSON.stringify(contentType)}`
      )
    }

    if (messageType === 'exception') {
      const exceptionType = requiredStringHeader(frame.headers, ':exception-type')
      const payload = parseJsonObject(frame.payload, exceptionType)
      const message = optionalString(payload.message) ?? `Kiro upstream exception: ${exceptionType}`
      throw new KiroStreamFailure(exceptionType, message, 'kiro_exception')
    }
    if (messageType !== 'event') {
      throw new KiroStreamFailure(
        'kiro_event_stream_message_type',
        `Unsupported Kiro Event Stream message type ${JSON.stringify(messageType)}`
      )
    }

    const eventType = requiredStringHeader(frame.headers, ':event-type')
    if (KIRO_IGNORED_EVENT_TYPES.has(eventType)) {
      this.recognize()
      return
    }
    if (!KIRO_JSON_EVENT_TYPES.has(eventType)) return
    const payload = parseJsonObject(frame.payload, eventType)
    this.handleEvent(eventType, payload)
  }

  private handleEvent(eventType: string, payload: JsonObject): void {
    switch (eventType) {
      case 'assistantResponseEvent':
        this.recognize('assistantResponseEventCount')
        this.handleAssistantResponse(payload)
        return
      case 'reasoningContentEvent':
        this.recognize('reasoningEventCount')
        this.handleReasoning(payload)
        return
      case 'toolUseEvent':
        this.recognize('toolUseEventCount')
        this.handleToolUse(payload)
        return
      case 'metadataEvent':
      case 'meteringEvent':
        this.recognize('usageEventCount')
        this.handleUsage(eventType, payload)
        return
      case 'invalidStateEvent':
        this.recognize()
        this.handleInvalidState(payload)
        return
      case 'messageMetadataEvent':
        this.recognize()
        this.handleMessageMetadata(payload)
        return
      default:
        return
    }
  }

  private handleAssistantResponse(payload: JsonObject): void {
    const content = requiredStringAllowEmpty(payload.content, 'assistantResponseEvent.content')
    const delta = cumulativeDelta(content, this.lastAssistantContent, 'assistant response')
    this.lastAssistantContent = content
    if (content.length > this.maxCumulativeTextCharacters) {
      throw new KiroStreamFailure(
        'kiro_cumulative_text_too_large',
        `Kiro cumulative assistant response exceeded ${this.maxCumulativeTextCharacters} characters`
      )
    }
    if (!delta) return
    const filtered = this.thinkingTagFilter.push(delta)
    if (filtered.reasoningAdvanced) this.events.push({ type: 'reasoning-progress' })
    if (filtered.text) this.events.push({ type: 'text-delta', text: filtered.text })
  }

  private handleReasoning(payload: JsonObject): void {
    const text = optionalString(payload.text) ?? ''
    const redactedContent = optionalString(payload.redactedContent) ?? ''
    if (!text && !redactedContent) return
    if (text) {
      const delta = cumulativeDelta(text, this.lastReasoningContent, 'reasoning response')
      this.lastReasoningContent = text
      if (text.length > this.maxCumulativeTextCharacters) {
        throw new KiroStreamFailure(
          'kiro_cumulative_reasoning_too_large',
          `Kiro cumulative reasoning response exceeded ${this.maxCumulativeTextCharacters} characters`
        )
      }
      if (!delta && !redactedContent) return
    }
    this.events.push({ type: 'reasoning-progress' })
  }

  private handleToolUse(payload: JsonObject): void {
    const id = requiredString(payload.toolUseId, 'toolUseEvent.toolUseId')
    if (this.completedToolIds.has(id)) {
      throw new KiroStreamFailure(
        'kiro_tool_id_reused',
        `Kiro toolUseId ${JSON.stringify(id)} was reused after completion`
      )
    }
    let state = this.tools.get(id)
    if (!state) {
      if (this.nextToolIndex >= this.maxToolCount) {
        throw new KiroStreamFailure(
          'kiro_tool_count_limit',
          `Kiro response exceeded ${this.maxToolCount} distinct tool calls`
        )
      }
      if (this.tools.size >= this.maxActiveToolCount) {
        throw new KiroStreamFailure(
          'kiro_tool_active_limit',
          `Kiro response exceeded ${this.maxActiveToolCount} simultaneously active tool calls`
        )
      }
      state = {
        index: this.nextToolIndex++,
        id,
        inputParts: [],
        inputCharacters: 0
      }
      this.tools.set(id, state)
    }

    if (payload.name !== undefined) {
      const name = requiredString(payload.name, 'toolUseEvent.name')
      if (state.name !== undefined && state.name !== name) {
        throw new KiroStreamFailure(
          'kiro_tool_name_changed',
          `Kiro tool ${JSON.stringify(id)} changed name from ${JSON.stringify(state.name)} to ${JSON.stringify(name)}`
        )
      }
      state.name = name
    }

    if (payload.input !== undefined) this.appendToolInput(state, payload.input)

    if (payload.stop !== undefined) {
      if (typeof payload.stop !== 'boolean') {
        throw new KiroStreamFailure('kiro_tool_stop_invalid', 'toolUseEvent.stop must be a boolean')
      }
      if (payload.stop) this.completeTool(state, false)
    }
  }

  private appendToolInput(state: ToolState, input: unknown): void {
    let part: string
    if (typeof input === 'string') {
      if (state.inputMode === 'object') {
        throw new KiroStreamFailure(
          'kiro_tool_input_mixed_encoding',
          `Kiro tool ${JSON.stringify(state.id)} mixed object and string input encodings`
        )
      }
      state.inputMode = 'fragments'
      part = input
    } else if (isJsonObject(input)) {
      if (state.inputMode !== undefined) {
        throw new KiroStreamFailure(
          'kiro_tool_input_repeated_object',
          `Kiro tool ${JSON.stringify(state.id)} supplied more than one complete input object`
        )
      }
      state.inputMode = 'object'
      part = JSON.stringify(input)
    } else {
      throw new KiroStreamFailure(
        'kiro_tool_input_invalid',
        `Kiro tool ${JSON.stringify(state.id)} input must be a JSON object or JSON string fragment`
      )
    }
    const partBytes = Buffer.byteLength(part, 'utf8')
    state.inputCharacters += part.length
    this.totalToolInputBytes += partBytes
    if (this.totalToolInputBytes > this.maxTotalToolInputBytes) {
      throw new KiroStreamFailure(
        'kiro_tool_input_total_too_large',
        `Kiro aggregate tool input exceeded ${this.maxTotalToolInputBytes} UTF-8 bytes`
      )
    }
    if (state.inputCharacters > this.maxFrameBytes) {
      throw new KiroStreamFailure(
        'kiro_tool_input_too_large',
        `Kiro tool ${JSON.stringify(state.id)} input exceeded ${this.maxFrameBytes} characters`
      )
    }
    state.inputParts.push(part)
  }

  private completeTool(state: ToolState, recovered: boolean): void {
    const completed = this.prepareCompletedTool(state, recovered)
    this.commitCompletedTool(state, completed, recovered)
  }

  private prepareCompletedTool(state: ToolState, recovered: boolean): CompletedToolState {
    if (!state.name) {
      throw new KiroStreamFailure(
        'kiro_tool_name_missing',
        `Kiro tool ${JSON.stringify(state.id)} completed without a name`
      )
    }
    if (!this.declaredToolNames.has(state.name)) {
      throw new KiroStreamFailure(
        'kiro_tool_undeclared',
        `Kiro tool ${JSON.stringify(state.name)} was not declared by the downstream request`
      )
    }
    const rawInput = state.inputParts.join('').trim() || '{}'
    const parsedInput = parseToolInput(rawInput, state.id)
    const schema = this.declaredToolSchemas.get(state.name)
    if (schema) {
      const issue = validateSchemaValue(parsedInput, schema, '$', 0)
      if (issue) {
        throw new KiroStreamFailure(
          'kiro_tool_input_schema',
          `Kiro tool ${JSON.stringify(state.name)} input failed schema validation at ${issue.path}: ${issue.reason}`
        )
      }
    }
    if (recovered && Object.keys(parsedInput).length > 0) {
      throw new KiroStreamFailure(
        'kiro_tool_stop_missing',
        `Kiro tool ${JSON.stringify(state.id)} ended without a stop frame and has non-empty input`
      )
    }
    return {
      index: state.index,
      id: state.id,
      name: state.name,
      arguments: JSON.stringify(parsedInput)
    }
  }

  private commitCompletedTool(
    state: ToolState,
    completed: CompletedToolState,
    recovered: boolean
  ): void {
    if (this.completedToolIds.size >= this.maxCompletedToolCount) {
      throw new KiroStreamFailure(
        'kiro_tool_completed_limit',
        `Kiro response exceeded ${this.maxCompletedToolCount} retained completed tool IDs`
      )
    }
    if (state.index !== this.nextToolIndexToEmit
      && this.completedTools.size >= this.maxPendingToolCount) {
      throw new KiroStreamFailure(
        'kiro_tool_pending_limit',
        `Kiro response exceeded ${this.maxPendingToolCount} completed tools waiting for ordered emission`
      )
    }
    this.tools.delete(state.id)
    this.completedToolIds.add(state.id)
    this.completedTools.set(state.index, completed)
    this.sawCompletedTool = true
    this.diagnostics.completedToolUseCount += 1
    if (recovered) this.diagnostics.structuralRecoveryCount += 1
    this.emitReadyTools()
  }

  private emitReadyTools(): void {
    while (true) {
      const tool = this.completedTools.get(this.nextToolIndexToEmit)
      if (!tool) return
      this.completedTools.delete(tool.index)
      this.events.push({
        type: 'tool-call-delta',
        index: tool.index,
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments
      })
      this.events.push({ type: 'tool-call-complete', index: tool.index })
      this.nextToolIndexToEmit += 1
    }
  }

  private recoverOrRejectUnfinishedTools(): void {
    const pending = [...this.tools.values()].sort((left, right) => left.index - right.index)
    const prepared = pending.map((state) => ({
      state,
      completed: this.prepareCompletedTool(state, true)
    }))
    for (const { state, completed } of prepared) this.commitCompletedTool(state, completed, true)
  }

  private handleUsage(eventType: 'metadataEvent' | 'meteringEvent', payload: JsonObject): void {
    let event: Extract<CanonicalStreamEvent, { type: 'usage' }>
    if (eventType === 'metadataEvent') {
      const tokenUsage = requiredObject(payload.tokenUsage, 'metadataEvent.tokenUsage')
      const uncached = optionalTokenCount(tokenUsage.uncachedInputTokens, 'uncachedInputTokens')
      const cacheRead = optionalTokenCount(tokenUsage.cacheReadInputTokens, 'cacheReadInputTokens')
      const cacheWrite = optionalTokenCount(tokenUsage.cacheWriteInputTokens, 'cacheWriteInputTokens')
      const output = optionalTokenCount(tokenUsage.outputTokens, 'outputTokens')
      const input = sumDefined(uncached, cacheRead, cacheWrite)
      event = compactUsage({
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        totalTokens: optionalTokenCount(tokenUsage.totalTokens, 'totalTokens') ?? sumDefined(input, output),
        cachedInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        reasoningTokens: optionalTokenCount(tokenUsage.reasoningTokens, 'reasoningTokens')
      })
    } else {
      const input = optionalTokenCount(payload.inputTokens, 'inputTokens')
      const output = optionalTokenCount(payload.outputTokens, 'outputTokens')
      event = compactUsage({
        type: 'usage',
        inputTokens: input,
        outputTokens: output,
        totalTokens: sumDefined(input, output)
      })
    }
    if (Object.keys(event).length > 1) this.events.push(event)
  }

  private handleInvalidState(payload: JsonObject): never {
    const reason = optionalString(payload.reason) ?? 'invalid_state'
    const message = optionalString(payload.message) ?? `Kiro invalid state: ${reason}`
    this.diagnostics.invalidStateReason = reason
    throw new KiroStreamFailure(reason, message, 'kiro_invalid_state')
  }

  private handleMessageMetadata(payload: JsonObject): void {
    const conversationId = optionalString(payload.conversationId)
    const utteranceId = optionalString(payload.utteranceId)
    if (conversationId) this.diagnostics.conversationId = conversationId
    if (utteranceId) this.diagnostics.utteranceId = utteranceId
  }

  private recognize(
    field?: 'assistantResponseEventCount' | 'reasoningEventCount' | 'toolUseEventCount' | 'usageEventCount'
  ): void {
    this.diagnostics.recognizedEventCount += 1
    if (field) this.diagnostics[field] += 1
  }

  private emitFailure(failure: KiroStreamFailure): void {
    if (this.failed) return
    this.failed = true
    this.bytes.clear()
    this.events.push({
      type: 'error',
      message: failure.message,
      code: failure.code,
      errorType: failure.errorType
    })
    this.events.push({ type: 'stop', reason: 'error', rawReason: failure.code })
    this.events.push({ type: 'done' })
  }

  private drainEvents(): CanonicalStreamEvent[] {
    return this.events.splice(0)
  }
}

export class KiroEventStreamCollector {
  private readonly parser: KiroEventStreamParser
  private readonly tools = new Map<number, CollectedToolState>()
  private text = ''
  private usage: Extract<CanonicalStreamEvent, { type: 'usage' }> | undefined
  private stopReason: CanonicalStopReason | undefined
  private error: Extract<CanonicalStreamEvent, { type: 'error' }> | undefined
  private complete = false
  private result: KiroCollectedResponse | undefined

  constructor(options: KiroEventStreamOptions = {}) {
    this.parser = new KiroEventStreamParser(options)
  }

  push(chunk: Uint8Array): void {
    if (this.result) throw new Error('Kiro Event Stream collector is already finished')
    this.consume(this.parser.push(chunk))
  }

  isComplete(): boolean {
    return this.complete
  }

  getDiagnostics(): KiroEventStreamDiagnostics {
    return this.parser.getDiagnostics()
  }

  finish(): KiroCollectedResponse {
    if (this.result) return this.result
    this.consume(this.parser.finish())
    const diagnostics = this.parser.getDiagnostics()
    const tools: KiroCollectedToolCall[] = []
    if (!this.error) {
      for (const state of [...this.tools.values()].sort((left, right) => left.index - right.index)) {
        if (!state.complete || !state.id || !state.name) {
          this.error = {
            type: 'error',
            message: `Kiro tool call at index ${state.index} was incomplete`,
            code: 'kiro_tool_incomplete',
            errorType: 'invalid_upstream_response'
          }
          break
        }
        const input = parseToolInput(state.arguments, state.id)
        tools.push({ index: state.index, id: state.id, name: state.name, input })
      }
    }
    this.result = {
      text: this.text,
      tools: this.error ? [] : tools,
      usage: this.usage,
      stopReason: this.error ? 'error' : this.stopReason,
      structuralRecoveryCount: diagnostics.structuralRecoveryCount,
      recognizedEventCount: diagnostics.recognizedEventCount,
      error: this.error
    }
    return this.result
  }

  private consume(events: CanonicalStreamEvent[]): void {
    for (const event of events) {
      if (event.type === 'text-delta') this.text += event.text
      else if (event.type === 'tool-call-delta') {
        const state = this.tools.get(event.index) ?? {
          index: event.index,
          arguments: '',
          complete: false
        }
        if (event.id !== undefined) state.id = event.id
        if (event.name !== undefined) state.name = event.name
        if (event.arguments !== undefined) state.arguments += event.arguments
        this.tools.set(event.index, state)
      } else if (event.type === 'tool-call-complete') {
        const state = this.tools.get(event.index)
        if (state) state.complete = true
      } else if (event.type === 'usage') this.usage = mergeUsage(this.usage, event)
      else if (event.type === 'stop') this.stopReason = event.reason
      else if (event.type === 'error') this.error ??= event
      else if (event.type === 'done') this.complete = true
    }
  }
}

export function createKiroEventStreamParser(
  options: KiroEventStreamOptions = {}
): KiroEventStreamParser {
  return new KiroEventStreamParser(options)
}

export function createKiroEventStreamCollector(
  options: KiroEventStreamOptions = {}
): KiroEventStreamCollector {
  return new KiroEventStreamCollector(options)
}

export async function collectKiroEventStreamBody(
  body: ReadableStream<Uint8Array>,
  options: KiroEventStreamOptions = {}
): Promise<KiroCollectedResponse> {
  const collector = createKiroEventStreamCollector(options)
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      collector.push(value)
      if (collector.isComplete()) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return collector.finish()
}

export function isKiroEventStreamContentType(value: string | null | undefined): boolean {
  if (!value) return false
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/vnd.amazon.eventstream'
}

class ByteQueue {
  private readonly chunks: Uint8Array[] = []
  private headOffset = 0
  private byteLength = 0

  get length(): number {
    return this.byteLength
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk.slice())
    this.byteLength += chunk.byteLength
  }

  peek(length: number): Uint8Array {
    if (length < 0 || length > this.byteLength) throw new RangeError('ByteQueue peek is out of bounds')
    const output = new Uint8Array(length)
    let written = 0
    let chunkIndex = 0
    let offset = this.headOffset
    while (written < length) {
      const chunk = this.chunks[chunkIndex++]
      const take = Math.min(chunk.byteLength - offset, length - written)
      output.set(chunk.subarray(offset, offset + take), written)
      written += take
      offset = 0
    }
    return output
  }

  read(length: number): Uint8Array {
    const output = this.peek(length)
    this.discard(length)
    return output
  }

  clear(): void {
    this.chunks.splice(0)
    this.headOffset = 0
    this.byteLength = 0
  }

  private discard(length: number): void {
    let remaining = length
    while (remaining > 0) {
      const head = this.chunks[0]
      const available = head.byteLength - this.headOffset
      if (remaining < available) {
        this.headOffset += remaining
        remaining = 0
      } else {
        remaining -= available
        this.chunks.shift()
        this.headOffset = 0
      }
    }
    this.byteLength -= length
  }
}

class ThinkingTagFilter {
  private inside = false
  private pending = ''

  push(delta: string): { text: string; reasoningAdvanced: boolean } {
    const openTag = '<thinking>'
    const closeTag = '</thinking>'
    let input = this.pending + delta
    this.pending = ''
    let text = ''
    let reasoningAdvanced = false

    while (input) {
      const marker = this.inside ? closeTag : openTag
      const markerIndex = input.indexOf(marker)
      if (markerIndex >= 0) {
        const before = input.slice(0, markerIndex)
        if (this.inside) reasoningAdvanced ||= before.length > 0
        else text += before
        this.inside = !this.inside
        input = input.slice(markerIndex + marker.length)
        continue
      }

      const suffixLength = longestMarkerPrefixSuffix(input, marker)
      const ready = input.slice(0, input.length - suffixLength)
      if (this.inside) reasoningAdvanced ||= ready.length > 0
      else text += ready
      this.pending = input.slice(input.length - suffixLength)
      break
    }

    return { text, reasoningAdvanced }
  }

  finish(): { text: string; reasoningAdvanced: boolean } {
    const result = this.inside
      ? { text: '', reasoningAdvanced: this.pending.length > 0 }
      : { text: this.pending, reasoningAdvanced: false }
    this.pending = ''
    return result
  }
}

function parseFrame(frame: Uint8Array, headersLength: number): ParsedFrame {
  validateMessageCrc(frame)
  const headersStart = 12
  const payloadStart = headersStart + headersLength
  return {
    headers: parseHeaders(frame.subarray(headersStart, payloadStart)),
    payload: frame.subarray(payloadStart, frame.byteLength - 4)
  }
}

function validateFrameLengths(totalLength: number, headersLength: number, maxFrameBytes: number): void {
  if (totalLength < MIN_FRAME_BYTES) {
    throw new KiroStreamFailure(
      'kiro_event_stream_frame_length',
      `Kiro Event Stream frame length ${totalLength} is smaller than ${MIN_FRAME_BYTES}`
    )
  }
  if (totalLength > maxFrameBytes) {
    throw new KiroStreamFailure(
      'kiro_event_stream_frame_too_large',
      `Kiro Event Stream frame length ${totalLength} exceeds ${maxFrameBytes}`,
      'frame_too_large'
    )
  }
  if (headersLength > totalLength - MIN_FRAME_BYTES) {
    throw new KiroStreamFailure(
      'kiro_event_stream_headers_length',
      `Kiro Event Stream headers length ${headersLength} exceeds the frame body`
    )
  }
}

function validatePreludeCrc(prelude: Uint8Array): void {
  const expected = readUint32(prelude, 8)
  const actual = crc32Ieee(prelude.subarray(0, 8))
  if (actual !== expected) {
    throw new KiroStreamFailure(
      'kiro_event_stream_prelude_crc',
      `Kiro Event Stream prelude CRC mismatch (expected ${hex(expected)}, received ${hex(actual)})`
    )
  }
}

function validateMessageCrc(frame: Uint8Array): void {
  const expected = readUint32(frame, frame.byteLength - 4)
  const actual = crc32Ieee(frame.subarray(0, frame.byteLength - 4))
  if (actual !== expected) {
    throw new KiroStreamFailure(
      'kiro_event_stream_message_crc',
      `Kiro Event Stream message CRC mismatch (expected ${hex(expected)}, received ${hex(actual)})`
    )
  }
}

function parseHeaders(bytes: Uint8Array): Map<string, HeaderValue> {
  const headers = new Map<string, HeaderValue>()
  let offset = 0
  while (offset < bytes.byteLength) {
    const nameLength = bytes[offset++]
    if (nameLength === 0 || offset + nameLength + 1 > bytes.byteLength) {
      throw new KiroStreamFailure('kiro_event_stream_header_invalid', 'Malformed AWS Event Stream header name')
    }
    const name = decodeUtf8(bytes.subarray(offset, offset + nameLength), 'AWS Event Stream header name')
    offset += nameLength
    if (headers.has(name)) {
      throw new KiroStreamFailure(
        'kiro_event_stream_header_duplicate',
        `Duplicate AWS Event Stream header ${JSON.stringify(name)}`
      )
    }
    const valueType = bytes[offset++]
    const parsed = parseHeaderValue(bytes, offset, valueType)
    offset = parsed.nextOffset
    headers.set(name, parsed.value)
  }
  return headers
}

function parseHeaderValue(
  bytes: Uint8Array,
  offset: number,
  valueType: number
): { value: HeaderValue; nextOffset: number } {
  if (valueType === 0) return { value: true, nextOffset: offset }
  if (valueType === 1) return { value: false, nextOffset: offset }
  const fixedLengths = new Map<number, number>([[2, 1], [3, 2], [4, 4], [5, 8], [8, 8], [9, 16]])
  const fixedLength = fixedLengths.get(valueType)
  if (fixedLength !== undefined) {
    ensureHeaderBytes(bytes, offset, fixedLength)
    const valueBytes = bytes.subarray(offset, offset + fixedLength)
    let value: HeaderValue
    if (valueType === 2) value = valueBytes[0]
    else if (valueType === 3) value = readInt16(valueBytes, 0)
    else if (valueType === 4) value = readInt32(valueBytes, 0)
    else if (valueType === 5 || valueType === 8) value = readBigInt64(valueBytes, 0)
    else value = valueBytes.slice()
    return { value, nextOffset: offset + fixedLength }
  }
  if (valueType === 6 || valueType === 7) {
    ensureHeaderBytes(bytes, offset, 2)
    const length = readUint16(bytes, offset)
    offset += 2
    ensureHeaderBytes(bytes, offset, length)
    const valueBytes = bytes.subarray(offset, offset + length)
    const value = valueType === 7 ? decodeUtf8(valueBytes, 'AWS Event Stream string header') : valueBytes.slice()
    return { value, nextOffset: offset + length }
  }
  throw new KiroStreamFailure(
    'kiro_event_stream_header_type',
    `Unsupported AWS Event Stream header value type ${valueType}`
  )
}

function requiredStringHeader(headers: Map<string, HeaderValue>, name: string): string {
  const value = headers.get(name)
  if (typeof value !== 'string' || !value) {
    throw new KiroStreamFailure(
      'kiro_event_stream_header_required',
      `Kiro Event Stream frame is missing string header ${name}`
    )
  }
  return value
}

function parseJsonObject(payload: Uint8Array, eventType: string): JsonObject {
  const text = decodeUtf8(payload, `${eventType} payload`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new KiroStreamFailure(
      'kiro_event_stream_invalid_json',
      `Kiro ${eventType} payload is not valid JSON`,
      'invalid_json'
    )
  }
  if (!isJsonObject(value)) {
    throw new KiroStreamFailure(
      'kiro_event_stream_invalid_payload',
      `Kiro ${eventType} payload must be a JSON object`
    )
  }
  return value
}

function parseToolInput(value: string, id: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new KiroStreamFailure(
      'kiro_tool_input_json',
      `Kiro tool ${JSON.stringify(id)} completed with invalid JSON input`
    )
  }
  if (!isJsonObject(parsed)) {
    throw new KiroStreamFailure(
      'kiro_tool_input_shape',
      `Kiro tool ${JSON.stringify(id)} input must decode to a JSON object`
    )
  }
  return parsed
}

interface SchemaValidationIssue {
  path: string
  reason: string
}

function validateSchemaValue(
  value: unknown,
  rawSchema: unknown,
  path: string,
  depth: number
): SchemaValidationIssue | undefined {
  if (depth > MAX_SCHEMA_VALIDATION_DEPTH) {
    return { path, reason: `schema validation exceeded ${MAX_SCHEMA_VALIDATION_DEPTH} levels` }
  }
  if (rawSchema === true) return undefined
  if (rawSchema === false) return { path, reason: 'the schema rejects every value' }
  if (!isJsonObject(rawSchema)) return { path, reason: 'declared schema node is not an object' }
  const schema = rawSchema

  if (schema.type !== undefined && !matchesSchemaType(value, schema.type)) {
    return { path, reason: `expected type ${schemaTypeLabel(schema.type)}` }
  }
  if (Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
    return { path, reason: 'value is not in enum' }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const')
    && !jsonValuesEqual(schema.const, value)) {
    return { path, reason: 'value does not equal const' }
  }

  const allOfIssue = validateSchemaBranches(value, schema.allOf, path, depth, 'allOf')
  if (allOfIssue) return allOfIssue
  const anyOfIssue = validateSchemaBranches(value, schema.anyOf, path, depth, 'anyOf')
  if (anyOfIssue) return anyOfIssue
  const oneOfIssue = validateSchemaBranches(value, schema.oneOf, path, depth, 'oneOf')
  if (oneOfIssue) return oneOfIssue
  if (schema.not !== undefined && !validateSchemaValue(value, schema.not, path, depth + 1)) {
    return { path, reason: 'value matches forbidden not schema' }
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (isNonNegativeInteger(schema.minLength) && length < schema.minLength) {
      return { path, reason: `string length is below minLength ${schema.minLength}` }
    }
    if (isNonNegativeInteger(schema.maxLength) && length > schema.maxLength) {
      return { path, reason: `string length exceeds maxLength ${schema.maxLength}` }
    }
    if (typeof schema.pattern === 'string') {
      let pattern: RegExp
      try {
        pattern = new RegExp(schema.pattern, 'u')
      } catch {
        return { path, reason: 'declared schema pattern is invalid' }
      }
      if (!pattern.test(value)) return { path, reason: `string does not match pattern ${schema.pattern}` }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { path, reason: `number is below minimum ${schema.minimum}` }
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { path, reason: `number exceeds maximum ${schema.maximum}` }
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return { path, reason: `number is not above exclusiveMinimum ${schema.exclusiveMinimum}` }
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return { path, reason: `number is not below exclusiveMaximum ${schema.exclusiveMaximum}` }
    }
    if (typeof schema.multipleOf === 'number'
      && schema.multipleOf > 0
      && !isMultipleOf(value, schema.multipleOf)) {
      return { path, reason: `number is not a multiple of ${schema.multipleOf}` }
    }
  }

  if (Array.isArray(value)) {
    if (isNonNegativeInteger(schema.minItems) && value.length < schema.minItems) {
      return { path, reason: `array length is below minItems ${schema.minItems}` }
    }
    if (isNonNegativeInteger(schema.maxItems) && value.length > schema.maxItems) {
      return { path, reason: `array length exceeds maxItems ${schema.maxItems}` }
    }
    if (schema.uniqueItems === true && hasDuplicateJsonValues(value)) {
      return { path, reason: 'array items are not unique' }
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const issue = validateSchemaValue(item, schema.items, `${path}[${index}]`, depth + 1)
        if (issue) return issue
      }
    }
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value)
    if (isNonNegativeInteger(schema.minProperties) && keys.length < schema.minProperties) {
      return { path, reason: `object has fewer than minProperties ${schema.minProperties}` }
    }
    if (isNonNegativeInteger(schema.maxProperties) && keys.length > schema.maxProperties) {
      return { path, reason: `object has more than maxProperties ${schema.maxProperties}` }
    }
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string' && !Object.prototype.hasOwnProperty.call(value, name)) {
          return { path: schemaPropertyPath(path, name), reason: 'required property is missing' }
        }
      }
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {}
    for (const [name, propertyValue] of Object.entries(value)) {
      const propertyPath = schemaPropertyPath(path, name)
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        const issue = validateSchemaValue(propertyValue, properties[name], propertyPath, depth + 1)
        if (issue) return issue
        continue
      }
      if (schema.additionalProperties === false) {
        return { path: propertyPath, reason: 'additional property is not allowed' }
      }
      if (isJsonObject(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
        const issue = validateSchemaValue(propertyValue, schema.additionalProperties, propertyPath, depth + 1)
        if (issue) return issue
      }
    }
  }
  return undefined
}

function validateSchemaBranches(
  value: unknown,
  rawBranches: unknown,
  path: string,
  depth: number,
  keyword: 'allOf' | 'anyOf' | 'oneOf'
): SchemaValidationIssue | undefined {
  if (rawBranches === undefined) return undefined
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    return { path, reason: `declared schema ${keyword} must be a non-empty array` }
  }
  const matches = rawBranches.filter((branch) => (
    validateSchemaValue(value, branch, path, depth + 1) === undefined
  )).length
  if (keyword === 'allOf' && matches !== rawBranches.length) {
    return { path, reason: 'value does not satisfy every allOf branch' }
  }
  if (keyword === 'anyOf' && matches === 0) {
    return { path, reason: 'value does not satisfy any anyOf branch' }
  }
  if (keyword === 'oneOf' && matches !== 1) {
    return { path, reason: 'value does not satisfy exactly one oneOf branch' }
  }
  return undefined
}

function matchesSchemaType(value: unknown, rawType: unknown): boolean {
  const types = Array.isArray(rawType) ? rawType : [rawType]
  return types.some((type) => {
    if (type === 'null') return value === null
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'object') return isJsonObject(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'string') return typeof value === 'string'
    return false
  })
}

function schemaTypeLabel(rawType: unknown): string {
  return Array.isArray(rawType) ? rawType.join('|') : String(rawType)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor
  return Math.abs(quotient - Math.round(quotient))
    <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8
}

function schemaPropertyPath(path: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function hasDuplicateJsonValues(values: unknown[]): boolean {
  const seen = new Set<string>()
  for (const value of values) {
    const key = canonicalJson(value)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as JsonObject).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key])}`
  )).join(',')}}`
}

function cumulativeDelta(next: string, previous: string, label: string): string {
  if (!previous) return next
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  throw new KiroStreamFailure(
    'kiro_cumulative_content_invalid',
    `Kiro ${label} was not an append-only cumulative snapshot`
  )
}

function mergeUsage(
  previous: Extract<CanonicalStreamEvent, { type: 'usage' }> | undefined,
  next: Extract<CanonicalStreamEvent, { type: 'usage' }>
): Extract<CanonicalStreamEvent, { type: 'usage' }> {
  return compactUsage({ ...previous, ...compactUsage(next), type: 'usage' })
}

function compactUsage(
  value: Extract<CanonicalStreamEvent, { type: 'usage' }>
): Extract<CanonicalStreamEvent, { type: 'usage' }> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Extract<CanonicalStreamEvent, { type: 'usage' }>
}

function emptyDiagnostics(): KiroEventStreamDiagnostics {
  return {
    recognizedEventCount: 0,
    assistantResponseEventCount: 0,
    reasoningEventCount: 0,
    toolUseEventCount: 0,
    completedToolUseCount: 0,
    usageEventCount: 0,
    structuralRecoveryCount: 0
  }
}

function normalizeLimit(value: number | undefined, fallback: number, minimum: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`)
  }
  return value
}

function asKiroFailure(error: unknown): KiroStreamFailure {
  if (error instanceof KiroStreamFailure) return error
  return new KiroStreamFailure(
    'kiro_event_stream_internal',
    error instanceof Error ? error.message : 'Unknown Kiro Event Stream parsing failure'
  )
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value) {
    throw new KiroStreamFailure('kiro_event_stream_field_required', `${path} must be a non-empty string`)
  }
  return value
}

function requiredStringAllowEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new KiroStreamFailure('kiro_event_stream_field_required', `${path} must be a string`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function requiredObject(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new KiroStreamFailure('kiro_event_stream_field_required', `${path} must be a JSON object`)
  }
  return value
}

function optionalTokenCount(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new KiroStreamFailure('kiro_usage_invalid', `Kiro usage field ${path} must be a non-negative integer`)
  }
  return value as number
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new KiroStreamFailure('kiro_event_stream_utf8', `${label} is not valid UTF-8`)
  }
}

function ensureHeaderBytes(bytes: Uint8Array, offset: number, length: number): void {
  if (offset + length > bytes.byteLength) {
    throw new KiroStreamFailure('kiro_event_stream_header_truncated', 'Truncated AWS Event Stream header value')
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readInt16(bytes: Uint8Array, offset: number): number {
  const value = readUint16(bytes, offset)
  return value & 0x8000 ? value - 0x10000 : value
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  ) >>> 0
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return readUint32(bytes, offset) | 0
}

function readBigInt64(bytes: Uint8Array, offset: number): bigint {
  const unsigned = (BigInt(readUint32(bytes, offset)) << 32n) | BigInt(readUint32(bytes, offset + 4))
  return unsigned & (1n << 63n) ? unsigned - (1n << 64n) : unsigned
}

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const maxLength = Math.min(value.length, marker.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

function hex(value: number): string {
  return value.toString(16).padStart(8, '0')
}

const CRC32_IEEE_TABLE = createCrc32IeeeTable()

function createCrc32IeeeTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function crc32Ieee(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_IEEE_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
