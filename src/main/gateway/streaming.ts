import type { Protocol } from '../../shared/types'
import type { ToolBridgeBinding, ToolBridgePlan } from './types'

type JsonObject = Record<string, unknown>

const DEFAULT_MAX_BUFFERED_STREAM_CHARACTERS = 16 * 1024 * 1024

export type CanonicalStopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'other'

/**
 * Protocol-neutral streaming events. Tool call string fields are append-only
 * fragments associated by `index`; consumers concatenate them in arrival order.
 */
export type CanonicalStreamEvent =
  | { type: 'start'; id?: string; model?: string; createdAt?: number }
  | { type: 'text-delta'; text: string; index?: number; contentType?: 'text' | 'refusal' }
  | { type: 'reasoning-progress' }
  | {
      type: 'tool-call-delta'
      index: number
      id?: string
      name?: string
      arguments?: string
      toolType?: 'function_call' | 'custom_tool_call'
      outputIndex?: number
    }
  /** Lifecycle signal used to distinguish a consumable tool call from a partial client abort. */
  | { type: 'tool-call-complete'; index: number }
  /** Lifecycle signal emitted when a Responses assistant message output item is complete. */
  | { type: 'message-complete'; index: number }
  | {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      cachedInputTokens?: number
      cacheCreationInputTokens?: number
      cacheCreation5mInputTokens?: number
      cacheCreation1hInputTokens?: number
      reasoningTokens?: number
    }
  | { type: 'stop'; reason: CanonicalStopReason; rawReason?: string }
  | { type: 'error'; message: string; code?: string; errorType?: string }
  | { type: 'done' }

export interface StreamEncodingOptions {
  id?: string
  model?: string
  now?: () => number
  /** Request-scoped provider mapping used to authorize and restore streamed tools. */
  toolBridgePlan?: ToolBridgePlan
}

export interface StreamParsingOptions {
  /**
   * Maximum UTF-16 characters retained for one unfinished SSE frame or JSON
   * value. The limit resets after every complete event/value, so it does not
   * cap the total length of a healthy streamed response.
   */
  maxBufferedCharacters?: number
  /** Keep Gemini thinking parts out of consumers that require only the final
   * answer text (for example local compatibility compaction). Normal protocol
   * conversion retains the historical behavior unless explicitly enabled. */
  suppressGeminiThoughtText?: boolean
  /** Emit a content-free progress signal for provider reasoning/thinking
   * deltas. This lets bounded consumers distinguish real model work from SSE
   * heartbeats without exposing hidden reasoning as answer text. */
  emitReasoningProgress?: boolean
}

export interface CanonicalStreamParser {
  /** Accepts arbitrarily split bytes and returns every complete event available. */
  push(chunk: Uint8Array): CanonicalStreamEvent[]
  /** Flushes UTF-8/framing state and emits a final `done` when needed. */
  finish(): CanonicalStreamEvent[]
  /** Exact upstream Responses protocol state; generic canonical `done` is intentionally excluded. */
  getProtocolState(): CanonicalProtocolState
  /** Count of payloads matching a known event shape for the selected protocol. */
  getRecognizedEventCount(): number
  /** Parsed terminal Responses payload, exposed without framing/parsing the SSE a second time. */
  getResponsesTerminalResponse(): JsonObject | undefined
}

export type ResponsesTerminalEvent = 'response.completed' | 'response.incomplete' | 'response.failed'

export interface CanonicalProtocolState {
  responsesEventCount: number
  /**
   * Responses events that prove application-level work is advancing. Transport
   * keepalives and lifecycle-only created/queued/in_progress frames are
   * intentionally excluded so callers can distinguish a live model stream from
   * a half-open connection that only emits heartbeats.
   */
  responsesProgressEventCount: number
  responsesTerminalEvent?: ResponsesTerminalEvent
  responsesLastEventType?: string
  responsesLastSequenceNumber?: number
}

export interface CanonicalStreamEncoder {
  /** Encodes one canonical event; a protocol event may require multiple frames. */
  encode(event: CanonicalStreamEvent): Uint8Array[]
  finish(): Uint8Array[]
  /** Reports a protocol-encoding failure that was emitted to the downstream stream. */
  getFailure(): Extract<CanonicalStreamEvent, { type: 'error' }> | undefined
}

export interface OpenAiResponsesStreamResult {
  response?: JsonObject
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    cached_input_tokens?: number
    cache_creation_input_tokens?: number
    cache_creation_5m_input_tokens?: number
    cache_creation_1h_input_tokens?: number
    reasoning_tokens?: number
  }
  error?: string
  errorCode?: string
  errorType?: string
}

export interface OpenAiResponsesStreamCollector {
  /** Accepts arbitrarily split Responses SSE bytes without buffering the wire payload. */
  push(chunk: Uint8Array): void
  /** Reports that a complete terminal Responses event has already been parsed. */
  isComplete(): boolean
  /** Exposes protocol progress so a non-streaming caller can ignore transport heartbeats. */
  getProtocolState(): CanonicalProtocolState
  /** Finalizes the stream and returns one ordinary Responses API object. */
  finish(): OpenAiResponsesStreamResult
}

type SseHandler = (eventName: string | undefined, data: string) => void

const ANTHROPIC_RECOGNIZED_EVENTS = new Set([
  'error', 'message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop'
])

class SseFramer {
  private buffer = ''
  private eventName: string | undefined
  private dataLines: string[] = []
  private frameCharacters = 0
  private failed = false

  constructor(
    private readonly onEvent: SseHandler,
    private readonly onError: (message: string) => void,
    private readonly maxBufferedCharacters: number
  ) {}

  push(text: string): void {
    if (this.failed) return
    let offset = 0
    while (offset < text.length && !this.failed) {
      const retained = this.frameCharacters + this.buffer.length
      const take = Math.max(1, this.maxBufferedCharacters - retained + 1)
      const end = Math.min(text.length, offset + take)
      this.buffer += text.slice(offset, end)
      offset = end
      this.drain(false)
    }
  }

  private drain(final: boolean): void {
    while (true) {
      const carriageReturn = this.buffer.indexOf('\r')
      const lineFeed = this.buffer.indexOf('\n')
      const newline = carriageReturn < 0
        ? lineFeed
        : lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed)
      if (newline < 0 || (!final && newline === this.buffer.length - 1 && this.buffer[newline] === '\r')) {
        this.ensureWithinLimit(this.frameCharacters + this.buffer.length)
        return
      }
      const crlf = this.buffer[newline] === '\r' && this.buffer[newline + 1] === '\n'
      const terminatorLength = crlf ? 2 : 1
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + terminatorLength)
      this.frameCharacters += line.length + terminatorLength
      if (!this.ensureWithinLimit(this.frameCharacters)) return
      this.processLine(line)
    }
  }

  finish(): void {
    if (this.failed) return
    this.drain(true)
    if (this.buffer.length > 0) this.processLine(this.buffer)
    this.buffer = ''
    this.dispatch()
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value
    if (field === 'data') this.dataLines.push(value)
  }

  private dispatch(): void {
    if (this.dataLines.length > 0) this.onEvent(this.eventName, this.dataLines.join('\n'))
    this.eventName = undefined
    this.dataLines = []
    this.frameCharacters = 0
  }

  private ensureWithinLimit(characters: number): boolean {
    if (characters <= this.maxBufferedCharacters) return true
    this.failed = true
    this.buffer = ''
    this.eventName = undefined
    this.dataLines = []
    this.frameCharacters = 0
    this.onError(`SSE frame exceeded ${this.maxBufferedCharacters} buffered characters`)
    return false
  }
}

interface CollectedToolCall {
  id?: string
  name?: string
  argumentChunks: string[]
  completed?: boolean
  toolType?: 'function_call' | 'custom_tool_call'
  outputIndex?: number
}

interface CollectedMessage {
  chunks: string[]
  completed?: boolean
  contentType?: 'text' | 'refusal'
}

class ResponsesStreamCollector implements OpenAiResponsesStreamCollector {
  private readonly parser = createCanonicalStreamParser('openai-responses')
  private readonly tools = new Map<number, CollectedToolCall>()
  private readonly now: () => number
  private id?: string
  private model?: string
  private createdAt?: number
  private readonly messages = new Map<number, CollectedMessage>()
  private usage: NonNullable<OpenAiResponsesStreamResult['usage']> = {}
  private stopReason?: CanonicalStopReason
  private terminalResponse?: JsonObject
  private terminalType?: 'response.completed' | 'response.incomplete'
  private error?: string
  private errorCode?: string
  private errorType?: string
  private done = false
  private finished = false
  private result?: OpenAiResponsesStreamResult

  constructor(private readonly options: StreamEncodingOptions) {
    this.now = options.now ?? Date.now
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error('Cannot append to a finalized Responses stream')
    if (this.done) return
    this.consume(this.parser.push(chunk))
  }

  isComplete(): boolean {
    return this.error !== undefined || (this.done && this.stopReason !== undefined)
  }

  getProtocolState(): CanonicalProtocolState {
    return this.parser.getProtocolState()
  }

  finish(): OpenAiResponsesStreamResult {
    if (this.result) return this.result
    this.finished = true
    if (!this.done) this.consume(this.parser.finish())
    this.captureTerminalResponse()
    if (!this.error) this.validateCompletedTools()

    const usage = Object.keys(this.usage).length > 0 ? { ...this.usage } : undefined
    const error = this.error
      ?? (!this.stopReason || !this.done ? 'Upstream Responses stream ended before a terminal response' : undefined)
    if (error) {
      this.result = {
        ...(usage ? { usage } : {}),
        error,
        ...(this.errorCode ? { errorCode: this.errorCode } : {}),
        ...(this.errorType ? { errorType: this.errorType } : {})
      }
      return this.result
    }

    const response = this.buildResponse()
    this.result = { response, ...(usage ? { usage } : {}) }
    return this.result
  }

  private consume(events: CanonicalStreamEvent[]): void {
    for (const event of events) {
      if (this.done) break
      if (event.type === 'start') {
        this.id = event.id ?? this.id
        this.model = event.model ?? this.model
        this.createdAt = event.createdAt ?? this.createdAt
      } else if (event.type === 'text-delta') {
        const index = event.index ?? 0
        const message = this.messages.get(index) ?? { chunks: [] }
        message.chunks.push(event.text)
        message.contentType = event.contentType === 'refusal' || message.contentType === 'refusal'
          ? 'refusal'
          : 'text'
        this.messages.set(index, message)
      } else if (event.type === 'tool-call-delta') {
        const tool = this.tools.get(event.index) ?? { argumentChunks: [] }
        tool.id = event.id ?? tool.id
        tool.name = event.name ?? tool.name
        tool.toolType = event.toolType ?? tool.toolType
        tool.outputIndex = event.outputIndex ?? tool.outputIndex
        if (event.arguments) tool.argumentChunks.push(event.arguments)
        this.tools.set(event.index, tool)
      } else if (event.type === 'tool-call-complete') {
        const tool = this.tools.get(event.index) ?? { argumentChunks: [] }
        tool.completed = true
        this.tools.set(event.index, tool)
      } else if (event.type === 'message-complete') {
        const message = this.messages.get(event.index) ?? { chunks: [] }
        message.completed = true
        this.messages.set(event.index, message)
      } else if (event.type === 'usage') {
        if (event.inputTokens !== undefined) this.usage.input_tokens = event.inputTokens
        if (event.outputTokens !== undefined) this.usage.output_tokens = event.outputTokens
        if (event.totalTokens !== undefined) this.usage.total_tokens = event.totalTokens
        if (event.cachedInputTokens !== undefined) this.usage.cached_input_tokens = event.cachedInputTokens
        if (event.cacheCreationInputTokens !== undefined) this.usage.cache_creation_input_tokens = event.cacheCreationInputTokens
        if (event.cacheCreation5mInputTokens !== undefined) this.usage.cache_creation_5m_input_tokens = event.cacheCreation5mInputTokens
        if (event.cacheCreation1hInputTokens !== undefined) this.usage.cache_creation_1h_input_tokens = event.cacheCreation1hInputTokens
        if (event.reasoningTokens !== undefined) this.usage.reasoning_tokens = event.reasoningTokens
      } else if (event.type === 'stop') {
        this.stopReason = event.reason
      } else if (event.type === 'error') {
        this.error ??= event.message
        this.errorCode ??= event.code
        this.errorType ??= event.errorType
      } else if (event.type === 'done') {
        this.done = true
      }
    }
  }

  private captureTerminalResponse(): void {
    const state = this.parser.getProtocolState()
    if (state.responsesTerminalEvent !== 'response.completed' && state.responsesTerminalEvent !== 'response.incomplete') return
    const response = this.parser.getResponsesTerminalResponse()
    if (!response) return
    this.terminalType = state.responsesTerminalEvent
    this.terminalResponse = response
  }

  private buildResponse(): JsonObject {
    const id = this.id ?? this.options.id ?? `resp_${this.now()}`
    const aggregateUsage = omitUndefined({
      input_tokens: this.usage.input_tokens,
      output_tokens: this.usage.output_tokens,
      total_tokens: this.usage.total_tokens,
      input_tokens_details: this.usage.cached_input_tokens === undefined
        ? undefined : { cached_tokens: this.usage.cached_input_tokens },
      output_tokens_details: this.usage.reasoning_tokens === undefined
        ? undefined : { reasoning_tokens: this.usage.reasoning_tokens }
    })
    const terminal = this.terminalResponse
    const terminalOutput = Array.isArray(terminal?.output) ? terminal.output : undefined
    const status = this.terminalType === 'response.incomplete'
      || (!this.terminalType && (this.stopReason === 'length' || this.stopReason === 'content_filter'))
      ? 'incomplete'
      : 'completed'
    const incompleteReason = this.stopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens'
    const hasCollectedContent = [...this.messages.values()].some((message) => message.chunks.length > 0)
    if (
      terminal
      && terminalOutput
      && terminalOutput.length > 0
      && (!hasCollectedContent || responsesOutputContainsText(terminalOutput))
    ) {
      const terminalUsage = { ...(objectValue(terminal.usage) ?? {}) }
      delete terminalUsage.cached_input_tokens
      delete terminalUsage.reasoning_tokens
      const terminalBase: JsonObject = {
        id,
        object: 'response',
        created_at: Math.floor((this.createdAt ?? this.now()) / 1000),
        status,
        model: this.model ?? this.options.model ?? ''
      }
      if (status === 'incomplete') terminalBase.incomplete_details = { reason: incompleteReason }
      return {
        ...terminalBase,
        ...terminal,
        usage: { ...aggregateUsage, ...terminalUsage }
      }
    }

    // Most Responses terminal payloads already contain the complete output.
    // Only materialize a second aggregate output when the terminal omitted it.
    const aggregateEntries: Array<{ outputIndex: number; item: JsonObject }> = []
    for (const [index, message] of [...this.messages.entries()].sort(([left], [right]) => left - right)) {
      if (message.chunks.length === 0) continue
      const text = message.chunks.join('')
      aggregateEntries.push({ outputIndex: index, item: {
        id: index === 0 ? `msg_${safeIdentifier(id)}` : `msg_${safeIdentifier(id)}_${index}`,
        type: 'message',
        status: message.completed ? 'completed' : status,
        role: 'assistant',
        content: message.contentType === 'refusal'
          ? [{ type: 'refusal', refusal: text }]
          : [{ type: 'output_text', text, annotations: [] }]
      } })
    }
    for (const [index, tool] of [...this.tools.entries()].sort(([left], [right]) => left - right)) {
      const callId = tool.id ?? `call_${safeIdentifier(id)}_${index}`
      const custom = tool.toolType === 'custom_tool_call'
      aggregateEntries.push({ outputIndex: tool.outputIndex ?? index, item: {
        id: `fc_${safeIdentifier(id)}_${index}`,
        type: custom ? 'custom_tool_call' : 'function_call',
        status: tool.completed ? 'completed' : status,
        call_id: callId,
        name: tool.name ?? '',
        ...(custom
          ? { input: tool.argumentChunks.join('') }
          : { arguments: tool.argumentChunks.join('') })
      } })
    }
    aggregateEntries.sort((left, right) => left.outputIndex - right.outputIndex)
    const aggregateOutput = aggregateEntries.map((entry) => entry.item)

    const aggregate: JsonObject = {
      id,
      object: 'response',
      created_at: Math.floor((this.createdAt ?? this.now()) / 1000),
      status,
      model: this.model ?? this.options.model ?? '',
      output: aggregateOutput,
      usage: aggregateUsage
    }
    if (status === 'incomplete') aggregate.incomplete_details = { reason: incompleteReason }

    if (!terminal) return aggregate
    const output = terminalOutput && (terminalOutput.length > 0 || aggregateOutput.length === 0)
      ? hasCollectedContent && !responsesOutputContainsText(terminalOutput)
        ? [
            ...terminalOutput,
            ...aggregateOutput.filter((item) => item.type === 'message')
          ]
        : terminalOutput
      : aggregateOutput
    const terminalUsage = { ...(objectValue(terminal.usage) ?? {}) }
    delete terminalUsage.cached_input_tokens
    delete terminalUsage.reasoning_tokens
    return {
      ...aggregate,
      ...terminal,
      output,
      usage: { ...aggregateUsage, ...terminalUsage }
    }
  }

  private validateCompletedTools(): void {
    const status = stringValue(this.terminalResponse?.status).trim().toLowerCase()
    const completed = this.terminalType === 'response.completed'
      || (!this.terminalType && status !== 'incomplete'
        && this.stopReason !== 'length' && this.stopReason !== 'content_filter')
    if (!completed) return
    for (const [index, tool] of this.tools) {
      const callId = tool.id ?? `tool index ${index}`
      const argumentsValue = tool.argumentChunks.join('')
      const validArguments = tool.toolType === 'custom_tool_call'
        || parseJsonObject(argumentsValue) !== undefined
      if (tool.completed && validArguments) continue
      this.error = tool.completed
        ? `Completed Responses tool call ${callId} has invalid or truncated JSON arguments`
        : `Completed Responses stream left tool call ${callId} unfinished`
      this.errorCode = 'incomplete_tool_call'
      this.errorType = 'invalid_stream_event'
      return
    }
  }
}

class JsonFramer {
  private buffer = ''
  private mode: 'pending' | 'single' | 'array' | 'complete' = 'pending'
  private arrayState: 'value-or-end' | 'value' | 'comma-or-end' = 'value-or-end'
  private failed = false

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly onError: (message: string) => void,
    private readonly maxBufferedCharacters: number
  ) {}

  push(text: string): void {
    if (this.failed) return
    let offset = 0
    while (offset < text.length && !this.failed) {
      const take = Math.max(1, this.maxBufferedCharacters - this.buffer.length + 1)
      const end = Math.min(text.length, offset + take)
      this.buffer += text.slice(offset, end)
      offset = end
      this.drain(false)
    }
  }

  finish(): void {
    this.drain(true)
  }

  private drain(final: boolean): void {
    while (!this.failed) {
      this.buffer = this.buffer.trimStart()
      if (this.mode === 'complete') {
        if (this.buffer.length > 0) this.fail('Unexpected JSON value after the completed stream root')
        return
      }
      if (this.mode === 'pending') {
        if (!this.buffer) return
        if (this.buffer.startsWith('[')) {
          this.mode = 'array'
          this.arrayState = 'value-or-end'
          this.buffer = this.buffer.slice(1)
        } else {
          this.mode = 'single'
        }
      }

      this.buffer = this.buffer.trimStart()
      if (this.mode === 'array') {
        if (this.arrayState === 'comma-or-end') {
          if (this.buffer.startsWith(',')) {
            this.buffer = this.buffer.slice(1)
            this.arrayState = 'value'
            continue
          }
          if (this.buffer.startsWith(']')) {
            this.buffer = this.buffer.slice(1)
            this.mode = 'complete'
            continue
          }
          if (!this.buffer) return
          this.fail('Expected a comma or closing bracket between JSON array values')
          return
        }
        if (this.arrayState === 'value-or-end' && this.buffer.startsWith(']')) {
          this.buffer = this.buffer.slice(1)
          this.mode = 'complete'
          continue
        }
        if (this.buffer.startsWith(',')) {
          this.fail('Unexpected leading comma in JSON array')
          return
        }
        if (this.arrayState === 'value' && this.buffer.startsWith(']')) {
          this.fail('Unexpected trailing comma in JSON array')
          return
        }
      }
      if (!this.buffer) {
        if (final) this.fail('Incomplete JSON value at end of stream')
        return
      }

      const boundary = findJsonValueBoundary(this.buffer)
      if (boundary < 0) {
        if (this.buffer.length > this.maxBufferedCharacters) {
          this.fail(`JSON value exceeded ${this.maxBufferedCharacters} buffered characters`)
          return
        }
        if (final) {
          this.fail('Incomplete JSON value at end of stream')
        }
        return
      }
      if (boundary > this.maxBufferedCharacters) {
        this.fail(`JSON value exceeded ${this.maxBufferedCharacters} buffered characters`)
        return
      }
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary)
      try {
        this.onValue(JSON.parse(raw) as unknown)
      } catch (error) {
        this.fail(error instanceof Error ? error.message : 'Invalid JSON stream value')
        return
      }
      if (this.mode === 'array') this.arrayState = 'comma-or-end'
      else this.mode = 'complete'
    }
  }

  private fail(message: string): void {
    if (this.failed) return
    this.failed = true
    this.buffer = ''
    this.onError(message)
  }
}

function findJsonValueBoundary(value: string): number {
  const first = value[0]
  if (first !== '{' && first !== '[') {
    const delimiter = value.search(/[\s,]/)
    return delimiter < 0 ? -1 : delimiter
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

class ProtocolParser implements CanonicalStreamParser {
  private readonly decoder = new TextDecoder()
  private readonly events: CanonicalStreamEvent[] = []
  private readonly sse: SseFramer
  private readonly json: JsonFramer
  private framing: 'sse' | 'json' | undefined
  private framingBuffer = ''
  private started = false
  private stopped = false
  private done = false
  private errored = false
  private finishing = false
  private sawToolCall = false
  private sawRefusal = false
  private nextToolIndex = 0
  private readonly anthropicToolIndices = new Map<number, number>()
  private readonly responsesToolIndices = new Map<number, number>()
  private readonly responsesToolMetadataSeen = new Set<number>()
  private readonly responsesArguments = new Map<number, string>()
  private readonly responsesToolCompleted = new Set<number>()
  private readonly responsesToolIdentityIndices = new Map<string, number>()
  private nextSyntheticResponsesOutputIndex = -1
  private readonly geminiToolIndices = new Map<string, number>()
  private lastUsage = ''
  private usageInputTokens: number | undefined
  private usageOutputTokens: number | undefined
  private usageTotalTokens: number | undefined
  private usageCachedInputTokens: number | undefined
  private usageCacheCreationInputTokens: number | undefined
  private usageCacheCreation5mInputTokens: number | undefined
  private usageCacheCreation1hInputTokens: number | undefined
  private usageReasoningTokens: number | undefined
  private responsesEventCount = 0
  private responsesProgressEventCount = 0
  private responsesTerminalEvent: ResponsesTerminalEvent | undefined
  private responsesLastEventType: string | undefined
  private responsesLastSequenceNumber: number | undefined
  private responsesTerminalResponse: JsonObject | undefined
  private readonly responsesTextDeltaKeys = new Set<string>()
  private readonly responsesTextDoneKeys = new Set<string>()
  private recognizedEventCount = 0
  private responsesLastProgressUsage = ''
  private readonly suppressGeminiThoughtText: boolean
  private readonly emitReasoningProgress: boolean

  constructor(private readonly protocol: Protocol, options: StreamParsingOptions = {}) {
    this.suppressGeminiThoughtText = options.suppressGeminiThoughtText === true
    this.emitReasoningProgress = options.emitReasoningProgress === true
    const maxBufferedCharacters = normalizeBufferedCharacterLimit(options.maxBufferedCharacters)
    this.sse = new SseFramer(
      (eventName, data) => this.handleSse(eventName, data),
      (message) => this.emitFramingError(message),
      maxBufferedCharacters
    )
    this.json = new JsonFramer(
      (value) => this.handlePayload(undefined, value),
      (message) => this.emitFramingError(message),
      maxBufferedCharacters
    )
    if (protocol !== 'gemini') this.framing = 'sse'
  }

  push(chunk: Uint8Array): CanonicalStreamEvent[] {
    this.consumeText(this.decoder.decode(chunk, { stream: true }))
    return this.drainEvents()
  }

  finish(): CanonicalStreamEvent[] {
    this.consumeText(this.decoder.decode())
    if (!this.framing && this.framingBuffer.trim()) this.selectGeminiFraming()
    this.finishing = true
    if (this.framing === 'sse') this.sse.finish()
    if (this.framing === 'json') this.json.finish()
    this.finishing = false
    if (!this.done) {
      if (!this.stopped && !this.errored) {
        this.emitError(
          'Stream ended before a stop or done event',
          undefined,
          'incomplete_stream'
        )
        this.emitStop('error', 'incomplete_stream')
      }
      this.emitDone()
    }
    return this.drainEvents()
  }

  getProtocolState(): CanonicalProtocolState {
    return {
      responsesEventCount: this.responsesEventCount,
      responsesProgressEventCount: this.responsesProgressEventCount,
      responsesTerminalEvent: this.responsesTerminalEvent,
      responsesLastEventType: this.responsesLastEventType,
      responsesLastSequenceNumber: this.responsesLastSequenceNumber
    }
  }

  getRecognizedEventCount(): number {
    return this.recognizedEventCount
  }

  getResponsesTerminalResponse(): JsonObject | undefined {
    return this.responsesTerminalResponse
  }

  private consumeText(text: string): void {
    if (!text) return
    if (!this.framing) {
      this.framingBuffer += text
      this.selectGeminiFraming()
      return
    }
    this.pushFramed(text)
  }

  private selectGeminiFraming(): void {
    const first = this.framingBuffer.trimStart()[0]
    if (!first) return
    this.framing = first === '{' || first === '[' ? 'json' : 'sse'
    const buffered = this.framingBuffer
    this.framingBuffer = ''
    this.pushFramed(buffered)
  }

  private pushFramed(text: string): void {
    if (this.framing === 'json') this.json.push(text)
    else this.sse.push(text)
  }

  private handleSse(eventName: string | undefined, data: string): void {
    // A Responses terminal event is definitive. Ignore any transport trailer or
    // accidentally concatenated events without paying for more JSON parsing.
    if (this.protocol === 'openai-responses' && this.done) return
    if (data.trim() === '[DONE]') {
      if (this.protocol === 'openai-responses') {
        this.responsesLastEventType = '[DONE]'
        return
      }
      // Chat's [DONE] marker closes the transport; it does not prove that the
      // selected choice reached a semantic finish_reason. Treat a bare marker
      // as a truncated stream so protocol conversion cannot synthesize a
      // successful response.completed from partial Grok/OpenAI output.
      if (this.protocol === 'openai-chat' && !this.stopped && !this.errored) {
        this.emitIncompleteStream('Stream ended before a semantic finish reason')
      }
      this.emitDone()
      return
    }
    try {
      this.handlePayload(eventName, JSON.parse(data) as unknown)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid SSE JSON payload'
      if (this.finishing) this.emitIncompleteStream(message)
      else this.emitError(message, undefined, 'invalid_json')
    }
  }

  private handlePayload(eventName: string | undefined, value: unknown): void {
    const payload = objectValue(value)
    if (!payload) {
      this.emitError('Stream payload must be a JSON object', 'invalid_payload')
      return
    }
    if (recognizedProtocolPayload(this.protocol, eventName, payload)) this.recognizedEventCount += 1
    switch (this.protocol) {
      case 'openai-chat':
        this.handleOpenAiChat(eventName, payload)
        break
      case 'openai-responses':
        this.handleOpenAiResponses(eventName, payload)
        break
      case 'anthropic-messages':
        this.handleAnthropic(eventName, payload)
        break
      case 'gemini':
        this.handleGemini(payload)
        break
      case 'kiro-claude':
        throw new Error('Kiro Claude streams require the dedicated Amazon event-stream bridge.')
    }
  }

  private handleOpenAiChat(eventName: string | undefined, payload: JsonObject): void {
    if (payload.error) {
      if (typeof payload.error === 'string') {
        this.emitError(
          stringValue(payload.message, payload.error),
          optionalString(payload.code),
          optionalString(payload.type)
        )
      } else {
        this.emitErrorObject(payload.error)
      }
      return
    }
    if (eventName === 'error') {
      this.emitErrorObject(payload)
      return
    }
    const choices = arrayOfObjects(payload.choices)
    const selectedChoices = choices.filter((choice) => (numberValue(choice.index) ?? 0) === 0)
    // Responses exposes one assistant output, so merging alternate Chat
    // choices would corrupt both text and tool-call index namespaces. Grok's
    // REST API can return n>1; deterministically consume only choice index 0.
    if (choices.length === 0 || selectedChoices.length > 0) {
      this.emitStart(payload.id, payload.model, payload.created)
    }
    for (const choice of selectedChoices) {
      if (this.stopped) break
      const delta = objectValue(choice.delta) ?? {}
      const text = stringValue(delta.content)
      if (text) this.events.push({ type: 'text-delta', text })
      const reasoning = stringValue(delta.reasoning_content ?? delta.reasoning)
      const reasoningDetailsAdvance = Array.isArray(delta.reasoning_details)
        && delta.reasoning_details.some((value) => {
          if (typeof value === 'string') return Boolean(value.trim())
          const detail = objectValue(value)
          return Boolean(detail && Object.keys(detail).length > 0)
        })
      if ((reasoning || reasoningDetailsAdvance) && this.emitReasoningProgress) {
        this.events.push({ type: 'reasoning-progress' })
      }
      for (const toolCall of arrayOfObjects(delta.tool_calls)) {
        const definition = objectValue(toolCall.function) ?? {}
        const event: CanonicalStreamEvent = {
          type: 'tool-call-delta',
          index: numberValue(toolCall.index) ?? 0,
          id: optionalString(toolCall.id),
          name: optionalString(definition.name),
          arguments: optionalString(definition.arguments)
        }
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent(event))
      }
      const legacyCall = objectValue(delta.function_call)
      if (legacyCall) {
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index: 0,
          name: optionalString(legacyCall.name),
          arguments: optionalString(legacyCall.arguments)
        }))
      }
      const finishReason = optionalString(choice.finish_reason)
      if (finishReason) this.emitStop(chatStopReason(finishReason), finishReason)
    }
    this.emitUsage(objectValue(payload.usage), 'prompt_tokens', 'completion_tokens', 'total_tokens')
  }

  private handleOpenAiResponses(eventName: string | undefined, payload: JsonObject): void {
    const payloadType = optionalString(payload.type)
    const type = payloadType ?? eventName ?? ''
    if (eventName && payloadType
      && (eventName === 'response.completed'
        || eventName === 'response.incomplete'
        || eventName === 'response.failed')
      && eventName !== payloadType) {
      this.emitResponsesProtocolError(
        `Responses SSE event ${eventName} disagrees with payload type ${payloadType}`,
        'mismatched_event_type'
      )
      return
    }
    const recognized = type ? recognizedResponsesPayload(type, payload) : false
    const terminalType: ResponsesTerminalEvent | undefined = type === 'response.completed'
      || type === 'response.incomplete'
      || type === 'response.failed'
      ? type
      : undefined
    if (type) {
      this.responsesEventCount += 1
      this.responsesLastEventType = type
      if (recognized && Object.hasOwn(payload, 'sequence_number')) {
        const sequenceNumber = responsesSequenceNumber(payload.sequence_number)
        if (sequenceNumber === undefined) {
          this.emitResponsesProtocolError(
            'Responses sequence_number must be a non-negative safe integer when present',
            'invalid_sequence_number'
          )
          return
        }
        if (this.responsesLastSequenceNumber !== undefined
          && sequenceNumber <= this.responsesLastSequenceNumber) {
          // Replayed or out-of-order frames are ignored atomically, including
          // their terminal state. Unsequenced compatibility events remain
          // accepted and are deduplicated by item/content identity below.
          return
        }
        this.responsesLastSequenceNumber = sequenceNumber
      }
      if (recognized && this.responsesPayloadAdvancesProgress(type, payload)) {
        this.responsesProgressEventCount += 1
      }
    }
    if (terminalType) {
      const terminalResponse = objectValue(payload.response)
      if (!terminalResponse) {
        this.emitResponsesProtocolError(
          `Responses terminal event ${type} is missing its required response payload`,
          'invalid_terminal_event'
        )
        return
      }
      const expectedStatus = terminalType === 'response.completed'
        ? 'completed'
        : terminalType === 'response.incomplete' ? 'incomplete' : 'failed'
      const actualStatus = stringValue(terminalResponse.status).trim().toLowerCase()
      if (actualStatus !== expectedStatus) {
        this.emitResponsesProtocolError(
          `Responses terminal event ${type} requires response.status=${expectedStatus}; received ${actualStatus || '<missing>'}`,
          'invalid_terminal_status'
        )
        return
      }
      if (this.errored) {
        this.emitStop('error', 'prior_stream_error')
        this.emitDone()
        return
      }
      this.responsesTerminalEvent = terminalType
      this.responsesTerminalResponse = terminalResponse
    }
    if (type === 'error' || type === 'response.error') {
      this.emitErrorObject(payload.error ?? payload)
      this.emitStop('error', type)
      this.emitDone()
      return
    }
    const response = objectValue(payload.response)
    if (type === 'response.created' || type === 'response.in_progress') {
      this.emitStart(response?.id, response?.model, response?.created_at)
      return
    }
    this.emitStart(payload.response_id, response?.model, response?.created_at)
    if (type === 'response.output_text.delta') {
      const text = stringValue(payload.delta)
      if (text) {
        const key = responsesTextKey(payload, 'text')
        if (this.responsesTextDoneKeys.has(key)) return
        this.responsesTextDeltaKeys.add(key)
        this.events.push({
          type: 'text-delta',
          text,
          index: responsesOutputIndex(payload),
          contentType: 'text'
        })
      }
      return
    }
    if (type === 'response.output_text.done') {
      // Some Responses-compatible relays emit only the final text event. When
      // deltas were already received, the done payload is the full duplicate
      // and must not be appended again.
      const text = optionalString(payload.text)
      const key = responsesTextKey(payload, 'text')
      if (!this.responsesTextDoneKeys.has(key)
        && text && !this.responsesTextDeltaKeys.has(key)) {
        this.events.push({
          type: 'text-delta',
          text,
          index: responsesOutputIndex(payload),
          contentType: 'text'
        })
      }
      this.responsesTextDoneKeys.add(key)
      return
    }
    if (type === 'response.refusal.delta') {
      const refusal = stringValue(payload.delta)
      if (refusal) {
        const key = responsesTextKey(payload, 'refusal')
        if (this.responsesTextDoneKeys.has(key)) return
        this.sawRefusal = true
        this.responsesTextDeltaKeys.add(key)
        this.events.push({
          type: 'text-delta',
          text: refusal,
          index: responsesOutputIndex(payload),
          contentType: 'refusal'
        })
      }
      return
    }
    if (type === 'response.refusal.done') {
      const refusal = optionalString(payload.refusal)
      const key = responsesTextKey(payload, 'refusal')
      if (!this.responsesTextDoneKeys.has(key)
        && refusal && !this.responsesTextDeltaKeys.has(key)) {
        this.events.push({
          type: 'text-delta',
          text: refusal,
          index: responsesOutputIndex(payload),
          contentType: 'refusal'
        })
      }
      if (refusal) this.sawRefusal = true
      this.responsesTextDoneKeys.add(key)
      return
    }
    if (type === 'response.output_item.added') {
      const item = objectValue(payload.item) ?? {}
      const itemType = stringValue(item.type)
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const outputIndex = this.responsesToolOutputIndex(payload, item)
        const index = this.responseToolIndex(outputIndex)
        const args = itemType === 'custom_tool_call'
          ? optionalString(item.input)
          : optionalString(item.arguments)
        const includeMetadata = !this.responsesToolMetadataSeen.has(outputIndex)
        const argumentSuffix = this.reconcileResponsesToolArguments(outputIndex, args)
        if (this.done) return
        this.responsesToolMetadataSeen.add(outputIndex)
        this.sawToolCall = true
        if (includeMetadata || argumentSuffix) {
          this.events.push(omitUndefinedEvent({
            type: 'tool-call-delta',
            index,
            id: includeMetadata ? optionalString(item.call_id) ?? optionalString(item.id) : undefined,
            name: includeMetadata ? optionalString(item.name) : undefined,
            arguments: argumentSuffix,
            toolType: itemType === 'custom_tool_call' ? itemType : undefined,
            outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined
          }))
        }
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const outputIndex = this.responsesToolOutputIndex(payload)
      const index = this.responseToolIndex(outputIndex)
      const args = optionalString(payload.delta)
      this.sawToolCall = true
      this.events.push(omitUndefinedEvent({
        type: 'tool-call-delta',
        index,
        arguments: this.appendResponsesToolArguments(outputIndex, args),
        outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined
      }))
      return
    }
    if (type === 'response.custom_tool_call_input.delta') {
      const outputIndex = this.responsesToolOutputIndex(payload)
      const index = this.responseToolIndex(outputIndex)
      const input = optionalString(payload.delta)
      this.sawToolCall = true
      this.events.push(omitUndefinedEvent({
        type: 'tool-call-delta',
        index,
        arguments: this.appendResponsesToolArguments(outputIndex, input),
        toolType: 'custom_tool_call',
        outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined
      }))
      return
    }
    if (type === 'response.function_call_arguments.done') {
      const outputIndex = this.responsesToolOutputIndex(payload)
      const index = this.responseToolIndex(outputIndex)
      const args = this.reconcileResponsesToolArguments(outputIndex, optionalString(payload.arguments))
      if (this.done) return
      if (args) this.events.push({
        type: 'tool-call-delta', index, arguments: args,
        outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined,
      })
      if (!this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.custom_tool_call_input.done') {
      const outputIndex = this.responsesToolOutputIndex(payload)
      const index = this.responseToolIndex(outputIndex)
      const input = this.reconcileResponsesToolArguments(outputIndex, optionalString(payload.input))
      if (this.done) return
      if (input) this.events.push({
        type: 'tool-call-delta', index, arguments: input, toolType: 'custom_tool_call',
        outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined,
      })
      if (!this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.output_item.done') {
      const item = objectValue(payload.item) ?? {}
      const outputIndex = stringValue(item.type) === 'message'
        ? numberValue(payload.output_index) ?? 0
        : this.responsesToolOutputIndex(payload, item)
      if (stringValue(item.type) === 'message') {
        const status = optionalString(item.status)
        if (!status || status === 'completed') {
          this.events.push({ type: 'message-complete', index: outputIndex })
        }
        return
      }
      const itemType = stringValue(item.type)
      if (itemType !== 'function_call' && itemType !== 'custom_tool_call') return
      const index = this.responseToolIndex(outputIndex)
      const includeMetadata = !this.responsesToolMetadataSeen.has(outputIndex)
      const args = itemType === 'custom_tool_call'
        ? optionalString(item.input)
        : optionalString(item.arguments)
      const argumentSuffix = this.reconcileResponsesToolArguments(outputIndex, args)
      if (this.done) return
      const includeArguments = Boolean(argumentSuffix)
      if (includeMetadata || includeArguments) {
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index,
          id: includeMetadata ? optionalString(item.call_id) ?? optionalString(item.id) : undefined,
          name: includeMetadata ? optionalString(item.name) : undefined,
          arguments: argumentSuffix,
          toolType: itemType === 'custom_tool_call' ? itemType : undefined,
          outputIndex: outputIndex >= 0 && outputIndex !== index ? outputIndex : undefined
        }))
      }
      this.responsesToolMetadataSeen.add(outputIndex)
      const status = optionalString(item.status)
      if ((!status || status === 'completed') && !this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      for (const [outputIndex, item] of arrayOfObjects(response?.output).entries()) {
        const itemType = stringValue(item.type)
        if (itemType === 'message') {
          for (const [contentIndex, part] of arrayOfObjects(item.content).entries()) {
            const partType = stringValue(part.type)
            const contentType = partType === 'refusal' ? 'refusal' : 'text'
            const value = contentType === 'refusal'
              ? optionalString(part.refusal)
              : optionalString(part.text)
            if (!value) continue
            const key = `${contentType}:${outputIndex}:${contentIndex}`
            if (!this.responsesTextDeltaKeys.has(key) && !this.responsesTextDoneKeys.has(key)) {
              this.events.push({ type: 'text-delta', text: value, index: outputIndex, contentType })
            }
            if (contentType === 'refusal') this.sawRefusal = true
            this.responsesTextDoneKeys.add(key)
          }
          const status = optionalString(item.status)
          if (!status || status === 'completed') {
            this.events.push({ type: 'message-complete', index: outputIndex })
          }
          continue
        }
        if (itemType !== 'function_call' && itemType !== 'custom_tool_call') continue
        const resolvedOutputIndex = this.responsesToolOutputIndex({ output_index: outputIndex }, item)
        const index = this.responseToolIndex(resolvedOutputIndex)
        const includeMetadata = !this.responsesToolMetadataSeen.has(resolvedOutputIndex)
        const snapshot = itemType === 'custom_tool_call'
          ? optionalString(item.input)
          : optionalString(item.arguments)
        const argumentSuffix = this.reconcileResponsesToolArguments(resolvedOutputIndex, snapshot)
        if (this.done) return
        if (includeMetadata || argumentSuffix) {
          this.sawToolCall = true
          this.events.push(omitUndefinedEvent({
            type: 'tool-call-delta',
            index,
            id: includeMetadata ? optionalString(item.call_id) ?? optionalString(item.id) : undefined,
            name: includeMetadata ? optionalString(item.name) : undefined,
            arguments: argumentSuffix,
            toolType: itemType === 'custom_tool_call' ? itemType : undefined,
            outputIndex: resolvedOutputIndex >= 0 && resolvedOutputIndex !== index
              ? resolvedOutputIndex : undefined
          }))
        }
        this.responsesToolMetadataSeen.add(resolvedOutputIndex)
        const status = optionalString(item.status)
        if ((!status || status === 'completed') && !this.responsesToolCompleted.has(resolvedOutputIndex)) {
          this.responsesToolCompleted.add(resolvedOutputIndex)
          this.events.push({ type: 'tool-call-complete', index })
        }
      }
      this.emitUsage(objectValue(response?.usage), 'input_tokens', 'output_tokens', 'total_tokens')
      const incomplete = objectValue(response?.incomplete_details)
      const rawReason = stringValue(incomplete?.reason)
      const normalizedReason = rawReason.trim().toLowerCase()
      const reason = type === 'response.incomplete'
        ? normalizedReason === 'content_filter' || normalizedReason.includes('content_filter')
          ? 'content_filter'
          : normalizedReason.includes('max') ? 'length' : 'other'
        : this.sawRefusal ? 'content_filter' : (this.sawToolCall ? 'tool_calls' : 'stop')
      this.emitStop(reason, rawReason || (this.sawRefusal ? 'refusal' : undefined))
      this.emitDone()
      return
    }
    if (type.startsWith('response.usage')) {
      const usage = objectValue(payload.usage) ?? objectValue(response?.usage)
      this.emitUsage(usage, 'input_tokens', 'output_tokens', 'total_tokens')
      return
    }
    if (type === 'response.failed') {
      this.emitErrorObject(response?.error ?? payload.error ?? payload)
      this.emitStop('error', 'failed')
      this.emitDone()
    }
  }

  private responsesPayloadAdvancesProgress(type: string, payload: JsonObject): boolean {
    if (!responsesEventAdvancesProgress(type)) return false
    if (type.startsWith('response.usage')) {
      const signature = responsesUsageProgressSignature(payload)
      if (!signature || signature === this.responsesLastProgressUsage) return false
      this.responsesLastProgressUsage = signature
    }
    return true
  }

  private emitResponsesProtocolError(message: string, code: string): void {
    this.emitError(message, code, 'invalid_stream_event')
    this.emitStop('error', code)
    this.emitDone()
  }

  private handleAnthropic(eventName: string | undefined, payload: JsonObject): void {
    const type = stringValue(payload.type, eventName ?? '')
    if (type === 'error') {
      this.emitErrorObject(payload.error ?? payload)
      return
    }
    if (type === 'message_start') {
      const message = objectValue(payload.message) ?? {}
      this.emitStart(message.id, message.model)
      this.emitAnthropicUsage(objectValue(message.usage))
      return
    }
    if (type === 'content_block_start') {
      const block = objectValue(payload.content_block) ?? {}
      const blockIndex = numberValue(payload.index) ?? 0
      if (stringValue(block.type) === 'text') {
        const text = stringValue(block.text)
        if (text) this.events.push({ type: 'text-delta', text })
      }
      if (stringValue(block.type) === 'tool_use') {
        const index = this.anthropicToolIndex(blockIndex)
        const input = objectValue(block.input)
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index,
          id: optionalString(block.id),
          name: optionalString(block.name),
          arguments: input && Object.keys(input).length > 0 ? jsonString(input) : undefined
        }))
      }
      return
    }
    if (type === 'content_block_delta') {
      const delta = objectValue(payload.delta) ?? {}
      if (stringValue(delta.type) === 'text_delta') {
        const text = stringValue(delta.text)
        if (text) this.events.push({ type: 'text-delta', text })
      }
      if (stringValue(delta.type) === 'thinking_delta'
        && stringValue(delta.thinking)
        && this.emitReasoningProgress) {
        this.events.push({ type: 'reasoning-progress' })
      }
      if (stringValue(delta.type) === 'input_json_delta') {
        const index = this.anthropicToolIndex(numberValue(payload.index) ?? 0)
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index,
          arguments: optionalString(delta.partial_json)
        }))
      }
      return
    }
    if (type === 'message_delta') {
      const delta = objectValue(payload.delta) ?? {}
      this.emitAnthropicUsage(objectValue(payload.usage))
      const rawReason = optionalString(delta.stop_reason)
      if (rawReason === 'pause_turn') {
        this.emitError(
          'Anthropic pause_turn requires native continuation and cannot be converted safely',
          'unsupported_pause_turn',
          'invalid_stream_event'
        )
        this.emitStop('error', 'unsupported_pause_turn')
      } else if (rawReason) {
        this.emitStop(anthropicStopReason(rawReason), rawReason)
      }
      return
    }
    if (type === 'message_stop') {
      if (!this.stopped) {
        this.emitError(
          'Anthropic message_stop arrived before a stop_reason',
          'incomplete_stream',
          'incomplete_stream'
        )
        this.emitStop('error', 'incomplete_stream')
      }
      this.emitDone()
    }
  }

  private handleGemini(payload: JsonObject): void {
    if (payload.error) {
      this.emitErrorObject(payload.error)
      return
    }
    this.emitStart(payload.responseId ?? payload.response_id, payload.modelVersion ?? payload.model_version)
    let finishReason: string | undefined
    for (const [candidateIndex, candidate] of arrayOfObjects(payload.candidates).entries()) {
      const content = objectValue(candidate.content) ?? {}
      for (const [partIndex, part] of arrayOfObjects(content.parts).entries()) {
        const text = stringValue(part.text)
        if (text) {
          if (this.suppressGeminiThoughtText && part.thought === true) {
            if (this.emitReasoningProgress) this.events.push({ type: 'reasoning-progress' })
          } else {
            this.events.push({ type: 'text-delta', text })
          }
        }
        const call = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (call) {
          const key = optionalString(call.id) ?? `${candidateIndex}:${partIndex}`
          let toolIndex = this.geminiToolIndices.get(key)
          if (toolIndex === undefined) {
            toolIndex = this.nextToolIndex++
            this.geminiToolIndices.set(key, toolIndex)
          }
          this.sawToolCall = true
          this.events.push(omitUndefinedEvent({
            type: 'tool-call-delta',
            index: toolIndex,
            id: optionalString(call.id),
            name: optionalString(call.name),
            arguments: call.args === undefined ? undefined : jsonString(call.args)
          }))
        }
      }
      const rawReason = optionalString(candidate.finishReason ?? candidate.finish_reason)
      if (rawReason) finishReason = rawReason
    }
    this.emitUsage(
      objectValue(payload.usageMetadata) ?? objectValue(payload.usage_metadata),
      'promptTokenCount',
      'candidatesTokenCount',
      'totalTokenCount'
    )
    if (finishReason) {
      const reason = finishReason === 'STOP' && this.sawToolCall
        ? 'tool_calls'
        : geminiStopReason(finishReason)
      this.emitStop(reason, finishReason)
      this.emitDone()
    }
  }

  private responseToolIndex(outputIndex: number): number {
    const existing = this.responsesToolIndices.get(outputIndex)
    if (existing !== undefined) return existing
    const index = this.nextToolIndex++
    this.responsesToolIndices.set(outputIndex, index)
    return index
  }

  private responsesToolOutputIndex(payload: JsonObject, item?: JsonObject): number {
    const identities = [
      optionalString(payload.item_id),
      optionalString(payload.call_id),
      optionalString(item?.id),
      optionalString(item?.call_id)
    ].filter((value): value is string => Boolean(value))
    const explicit = nonNegativeSafeInteger(payload.output_index)
    if (explicit !== undefined) {
      const priorIndices = new Set(identities
        .map((identity) => this.responsesToolIdentityIndices.get(identity))
        .filter((value): value is number => value !== undefined))
      if (priorIndices.size > 1) {
        this.emitResponsesProtocolError(
          'Responses tool identities resolve to conflicting output indices',
          'conflicting_tool_identity'
        )
        return explicit
      }
      const prior = priorIndices.values().next().value as number | undefined
      if (prior !== undefined && prior !== explicit) {
        if (prior >= 0) {
          // Explicit output indices are authoritative. Some compatible relays
          // reuse a call_id for distinct output items; keep those calls
          // separate instead of letting the ambiguous identity collapse them.
          for (const identity of identities) {
            if (!this.responsesToolIdentityIndices.has(identity)) {
              this.responsesToolIdentityIndices.set(identity, explicit)
            }
          }
          return explicit
        }
        this.rebindResponsesToolOutputIndex(prior, explicit)
        if (this.done) return explicit
      }
      for (const identity of identities) this.responsesToolIdentityIndices.set(identity, explicit)
      return explicit
    }
    for (const identity of identities) {
      const existing = this.responsesToolIdentityIndices.get(identity)
      if (existing !== undefined) return existing
    }
    const outputIndex = this.nextSyntheticResponsesOutputIndex--
    for (const identity of identities) this.responsesToolIdentityIndices.set(identity, outputIndex)
    return outputIndex
  }

  private rebindResponsesToolOutputIndex(synthetic: number, explicit: number): void {
    const syntheticToolIndex = this.responsesToolIndices.get(synthetic)
    const explicitToolIndex = this.responsesToolIndices.get(explicit)
    if (syntheticToolIndex !== undefined && explicitToolIndex !== undefined
      && syntheticToolIndex !== explicitToolIndex) {
      this.emitResponsesProtocolError(
        `Responses output_index ${explicit} is already bound to a different tool call`,
        'conflicting_tool_identity'
      )
      return
    }
    if (syntheticToolIndex !== undefined) {
      this.responsesToolIndices.set(explicit, syntheticToolIndex)
      this.responsesToolIndices.delete(synthetic)
    }

    const syntheticArguments = this.responsesArguments.get(synthetic)
    const explicitArguments = this.responsesArguments.get(explicit)
    if (syntheticArguments !== undefined && explicitArguments !== undefined
      && syntheticArguments !== explicitArguments
      && !syntheticArguments.startsWith(explicitArguments)
      && !explicitArguments.startsWith(syntheticArguments)) {
      this.emitResponsesProtocolError(
        'Responses tool arguments conflict while assigning a late output_index',
        'inconsistent_tool_arguments'
      )
      return
    }
    const mergedArguments = syntheticArguments === undefined
      ? explicitArguments
      : explicitArguments === undefined
        ? syntheticArguments
        : syntheticArguments.length >= explicitArguments.length ? syntheticArguments : explicitArguments
    if (mergedArguments !== undefined) this.responsesArguments.set(explicit, mergedArguments)
    this.responsesArguments.delete(synthetic)

    if (this.responsesToolMetadataSeen.has(synthetic)) {
      this.responsesToolMetadataSeen.add(explicit)
      this.responsesToolMetadataSeen.delete(synthetic)
    }
    if (this.responsesToolCompleted.has(synthetic)) {
      this.responsesToolCompleted.add(explicit)
      this.responsesToolCompleted.delete(synthetic)
    }
    for (const [identity, outputIndex] of this.responsesToolIdentityIndices) {
      if (outputIndex === synthetic) this.responsesToolIdentityIndices.set(identity, explicit)
    }
  }

  private appendResponsesToolArguments(outputIndex: number, delta?: string): string | undefined {
    if (!delta) return undefined
    this.responsesArguments.set(outputIndex, (this.responsesArguments.get(outputIndex) ?? '') + delta)
    return delta
  }

  private reconcileResponsesToolArguments(outputIndex: number, snapshot?: string): string | undefined {
    if (!snapshot) return undefined
    const current = this.responsesArguments.get(outputIndex) ?? ''
    if (snapshot === current) return undefined
    if (snapshot.startsWith(current)) {
      const suffix = snapshot.slice(current.length)
      this.responsesArguments.set(outputIndex, snapshot)
      return suffix || undefined
    }
    this.emitResponsesProtocolError(
      'Responses tool argument snapshots do not match streamed deltas',
      'inconsistent_tool_arguments'
    )
    return undefined
  }

  private anthropicToolIndex(blockIndex: number): number {
    const existing = this.anthropicToolIndices.get(blockIndex)
    if (existing !== undefined) return existing
    const index = this.nextToolIndex++
    this.anthropicToolIndices.set(blockIndex, index)
    return index
  }

  private emitStart(idValue?: unknown, modelValue?: unknown, createdValue?: unknown): void {
    if (this.started) return
    const id = optionalString(idValue)
    const model = optionalString(modelValue)
    const created = numberValue(createdValue)
    if (!id && !model && created === undefined) return
    this.started = true
    this.events.push(omitUndefinedEvent({
      type: 'start',
      id,
      model,
      createdAt: created === undefined ? undefined : normalizeTimestamp(created)
    }))
  }

  private emitUsage(
    usage: JsonObject | undefined,
    inputKey: string,
    outputKey: string,
    totalKey?: string
  ): void {
    if (!usage) return
    const parsedInputTokens = numberValue(usage[inputKey])
    const parsedOutputTokens = numberValue(usage[outputKey])
    const parsedTotalTokens = numberValue(totalKey ? usage[totalKey] : undefined)
    const inputDetails = objectValue(usage.input_tokens_details) ?? objectValue(usage.prompt_tokens_details)
    const outputDetails = objectValue(usage.output_tokens_details) ?? objectValue(usage.completion_tokens_details)
    const parsedCachedInputTokens = numberValue(inputDetails?.cached_tokens)
    const cacheCreation = objectValue(usage.cache_creation)
    const parsedCacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens)
    const parsedCacheCreation5mInputTokens = numberValue(cacheCreation?.ephemeral_5m_input_tokens)
    const parsedCacheCreation1hInputTokens = numberValue(cacheCreation?.ephemeral_1h_input_tokens)
    const parsedReasoningTokens = numberValue(outputDetails?.reasoning_tokens)
    if (parsedInputTokens === undefined && parsedOutputTokens === undefined && parsedTotalTokens === undefined
      && parsedCachedInputTokens === undefined && parsedCacheCreationInputTokens === undefined
      && parsedCacheCreation5mInputTokens === undefined && parsedCacheCreation1hInputTokens === undefined
      && parsedReasoningTokens === undefined) return
    this.usageInputTokens = parsedInputTokens ?? this.usageInputTokens
    this.usageOutputTokens = parsedOutputTokens ?? this.usageOutputTokens
    this.usageTotalTokens = parsedTotalTokens
      ?? sumDefined(this.usageInputTokens, this.usageOutputTokens)
      ?? this.usageTotalTokens
    this.usageCachedInputTokens = parsedCachedInputTokens ?? this.usageCachedInputTokens
    this.usageCacheCreationInputTokens = parsedCacheCreationInputTokens ?? this.usageCacheCreationInputTokens
    this.usageCacheCreation5mInputTokens = parsedCacheCreation5mInputTokens ?? this.usageCacheCreation5mInputTokens
    this.usageCacheCreation1hInputTokens = parsedCacheCreation1hInputTokens ?? this.usageCacheCreation1hInputTokens
    this.usageReasoningTokens = parsedReasoningTokens ?? this.usageReasoningTokens
    const signature = `${this.usageInputTokens ?? ''}:${this.usageOutputTokens ?? ''}:${this.usageTotalTokens ?? ''}:${this.usageCachedInputTokens ?? ''}:${this.usageCacheCreationInputTokens ?? ''}:${this.usageCacheCreation5mInputTokens ?? ''}:${this.usageCacheCreation1hInputTokens ?? ''}:${this.usageReasoningTokens ?? ''}`
    if (signature === this.lastUsage) return
    this.lastUsage = signature
    this.events.push(omitUndefinedEvent({
      type: 'usage',
      inputTokens: this.usageInputTokens,
      outputTokens: this.usageOutputTokens,
      totalTokens: this.usageTotalTokens,
      cachedInputTokens: this.usageCachedInputTokens,
      cacheCreationInputTokens: this.usageCacheCreationInputTokens,
      cacheCreation5mInputTokens: this.usageCacheCreation5mInputTokens,
      cacheCreation1hInputTokens: this.usageCacheCreation1hInputTokens,
      reasoningTokens: this.usageReasoningTokens
    }))
  }

  private emitAnthropicUsage(usage: JsonObject | undefined): void {
    if (!usage) return
    const uncached = numberValue(usage.input_tokens)
    const cacheRead = numberValue(usage.cache_read_input_tokens)
    const cacheCreationDetails = objectValue(usage.cache_creation)
    const cacheCreation5m = numberValue(cacheCreationDetails?.ephemeral_5m_input_tokens)
    const cacheCreation1h = numberValue(cacheCreationDetails?.ephemeral_1h_input_tokens)
    const reportedCacheCreation = numberValue(usage.cache_creation_input_tokens)
    const cacheCreation = reportedCacheCreation ?? sumOptional(cacheCreation5m, cacheCreation1h)
    const inputParts = [uncached, cacheRead, cacheCreation].filter((value): value is number => value !== undefined)
    const inputTokens = inputParts.length > 0 ? inputParts.reduce((sum, value) => sum + value, 0) : undefined
    const thinkingTokens = numberValue(objectValue(usage.output_tokens_details)?.thinking_tokens)
    this.emitUsage(omitUndefined({
      input_tokens: inputTokens,
      output_tokens: numberValue(usage.output_tokens),
      input_tokens_details: cacheRead === undefined ? undefined : { cached_tokens: cacheRead },
      cache_creation_input_tokens: cacheCreation,
      cache_creation: cacheCreation5m === undefined && cacheCreation1h === undefined ? undefined : {
        ephemeral_5m_input_tokens: cacheCreation5m,
        ephemeral_1h_input_tokens: cacheCreation1h
      },
      output_tokens_details: thinkingTokens === undefined ? undefined : { reasoning_tokens: thinkingTokens }
    }), 'input_tokens', 'output_tokens')
  }

  private emitStop(reason: CanonicalStopReason, rawReason?: string): void {
    if (this.stopped) return
    this.stopped = true
    this.events.push(omitUndefinedEvent({ type: 'stop', reason, rawReason }))
  }

  private emitErrorObject(value: unknown): void {
    const error = objectValue(value)
    if (!error) {
      this.emitError(typeof value === 'string' ? value : 'Unknown streaming error')
      return
    }
    this.emitError(
      stringValue(error.message, 'Unknown streaming error'),
      optionalString(error.code),
      optionalString(error.type) ?? optionalString(error.status)
    )
  }

  private emitError(message: string, code?: string, errorType?: string): void {
    this.errored = true
    this.events.push(omitUndefinedEvent({ type: 'error', message, code, errorType }))
  }

  private emitFramingError(message: string): void {
    if (message.startsWith('Incomplete JSON value')) this.emitIncompleteStream(message)
    else if (message.includes('exceeded') && message.includes('buffered characters')) {
      this.emitError(message, 'frame_too_large', 'frame_too_large')
      this.emitStop('error', 'frame_too_large')
      this.emitDone()
    }
    else this.emitError(message, undefined, 'invalid_json')
  }

  private emitIncompleteStream(message: string): void {
    this.emitError(message, undefined, 'incomplete_stream')
    this.emitStop('error', 'incomplete_stream')
  }

  private emitDone(): void {
    if (this.done) return
    this.done = true
    this.events.push({ type: 'done' })
  }

  private drainEvents(): CanonicalStreamEvent[] {
    return this.events.splice(0)
  }
}

function recognizedProtocolPayload(protocol: Protocol, eventName: string | undefined, payload: JsonObject): boolean {
  if (protocol === 'openai-responses') {
    const type = stringValue(payload.type, eventName ?? '')
    return recognizedResponsesPayload(type, payload)
  }
  if (protocol === 'openai-chat') {
    const choices = arrayOfObjects(payload.choices)
    return eventName === 'error'
      || Boolean(payload.error)
      || choices.some((choice) => (numberValue(choice.index) ?? 0) === 0)
      || objectValue(payload.usage) !== undefined
  }
  if (protocol === 'anthropic-messages') {
    const type = stringValue(payload.type, eventName ?? '')
    return ANTHROPIC_RECOGNIZED_EVENTS.has(type)
  }
  if (protocol === 'gemini') {
    return Boolean(payload.error) || Array.isArray(payload.candidates)
      || objectValue(payload.usageMetadata ?? payload.usage_metadata) !== undefined
      || objectValue(payload.promptFeedback ?? payload.prompt_feedback) !== undefined
  }
  throw new Error('Kiro Claude streams require the dedicated Amazon event-stream bridge.')
}

function recognizedResponsesPayload(type: string, payload: JsonObject): boolean {
  if (type === 'response.queued') return true
  if (type === 'response.created' || type === 'response.in_progress') {
    return objectValue(payload.response) !== undefined
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = objectValue(payload.response)
    return response !== undefined && (response.status === undefined || stringValue(response.status) !== '')
  }
  if (type === 'response.failed') {
    const response = objectValue(payload.response)
    return response !== undefined && (objectValue(response.error) !== undefined || response.status === 'failed')
  }
  if (type === 'response.error' || type === 'error') {
    return objectValue(payload.error) !== undefined || optionalString(payload.message) !== undefined
  }
  if (!responsesEventAdvancesProgress(type)) return false
  if (type.startsWith('response.usage')) return responsesUsageProgressSignature(payload) !== undefined

  if (type.endsWith('.delta')) return optionalString(payload.delta) !== undefined

  if (type === 'response.output_text.done') {
    return optionalString(payload.text) !== undefined
  }
  if (type === 'response.refusal.done') {
    return optionalString(payload.refusal) !== undefined
  }
  if (type.startsWith('response.output_item.')) {
    return objectValue(payload.item) !== undefined
  }
  if (type.startsWith('response.content_part.')) {
    return objectValue(payload.part) !== undefined
  }
  if (type === 'response.function_call_arguments.done') {
    return typeof payload.arguments === 'string'
  }
  if (type === 'response.custom_tool_call_input.done') {
    return typeof payload.input === 'string'
  }

  // Tool/reasoning lifecycle events have multiple provider-specific payload
  // shapes. Require a stable item identity or output index rather than trusting
  // the event-name prefix alone.
  return nonNegativeSafeInteger(payload.output_index) !== undefined
    || optionalString(payload.item_id) !== undefined
    || optionalString(payload.call_id) !== undefined
    || objectValue(payload.item) !== undefined
    || objectValue(payload.part) !== undefined
}

function responsesOutputIndex(payload: JsonObject): number {
  return nonNegativeSafeInteger(payload.output_index) ?? 0
}

function responsesTextKey(payload: JsonObject, contentType: 'text' | 'refusal'): string {
  return `${contentType}:${responsesOutputIndex(payload)}:${nonNegativeSafeInteger(payload.content_index) ?? 0}`
}

function responsesOutputContainsText(output: readonly unknown[]): boolean {
  return output.some((value) => {
    const item = objectValue(value)
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return false
    return item.content.some((partValue) => {
      const part = objectValue(partValue)
      return (part?.type === 'output_text' || part?.type === 'text')
        && optionalString(part.text) !== undefined
        || part?.type === 'refusal' && optionalString(part.refusal) !== undefined
    })
  })
}

function responsesSequenceNumber(value: unknown): number | undefined {
  return nonNegativeSafeInteger(value)
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function responsesUsageProgressSignature(payload: JsonObject): string | undefined {
  const usage = objectValue(payload.usage) ?? objectValue(payload.response)?.usage
  const usageObject = objectValue(usage)
  if (!usageObject) return undefined
  const inputDetails = objectValue(usageObject.input_tokens_details)
  const outputDetails = objectValue(usageObject.output_tokens_details)
  const values = [
    nonNegativeFiniteNumber(usageObject.input_tokens),
    nonNegativeFiniteNumber(usageObject.output_tokens),
    nonNegativeFiniteNumber(usageObject.total_tokens),
    nonNegativeFiniteNumber(inputDetails?.cached_tokens),
    nonNegativeFiniteNumber(outputDetails?.reasoning_tokens)
  ]
  if (values.every((value) => value === undefined)) return undefined
  return values.map((value) => value ?? '').join(':')
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeBufferedCharacterLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_BUFFERED_STREAM_CHARACTERS
}

interface EncodedToolState {
  index: number
  id: string
  name: string
  arguments: string
  started: boolean
  outputIndex?: number
  itemId?: string
  contentIndex?: number
  emittedArguments: number
  emitted: boolean
  completed: boolean
  toolType?: 'function_call' | 'custom_tool_call'
  bridgeBinding?: ToolBridgeBinding
  customInput?: string
}

class ProtocolEncoder implements CanonicalStreamEncoder {
  private readonly textEncoder = new TextEncoder()
  private readonly frames: string[] = []
  private readonly now: () => number
  private id: string
  private model: string
  private createdAt: number
  private started = false
  private stopped = false
  private done = false
  private failed = false
  private encodingFailure?: Extract<CanonicalStreamEvent, { type: 'error' }>
  private pendingStop: Extract<CanonicalStreamEvent, { type: 'stop' }> | undefined
  private usage: Extract<CanonicalStreamEvent, { type: 'usage' }> = { type: 'usage' }
  private readonly tools = new Map<number, EncodedToolState>()

  private anthropicNextContentIndex = 0
  private anthropicTextIndex: number | undefined
  private anthropicTextStarted = false
  private anthropicTextClosed = false

  private responsesNextOutputIndex = 0
  private responsesTextOutputIndex: number | undefined
  private responsesText = ''
  private responsesTextStarted = false
  private readonly responsesTextSourceIndices = new Set<number>()
  private readonly responsesCompletedMessageIndices = new Set<number>()
  private chatUsageEmitted = false
  private readonly chatToolIds = new Map<number, string>()
  private readonly toolBridgePlan?: ToolBridgePlan

  constructor(private readonly protocol: Protocol, options: StreamEncodingOptions) {
    this.now = options.now ?? Date.now
    this.createdAt = this.now()
    this.id = options.id ?? `stream_${this.createdAt}`
    this.model = options.model ?? ''
    this.toolBridgePlan = options.toolBridgePlan
  }

  encode(event: CanonicalStreamEvent): Uint8Array[] {
    if (this.done) return []
    if (event.type === 'start') {
      if (event.id) this.id = event.id
      if (event.model) this.model = event.model
      if (event.createdAt !== undefined) this.createdAt = event.createdAt
    }
    switch (this.protocol) {
      case 'openai-chat':
        this.encodeOpenAiChat(event)
        break
      case 'openai-responses':
        this.encodeOpenAiResponses(event)
        break
      case 'anthropic-messages':
        this.encodeAnthropic(event)
        break
      case 'gemini':
        this.encodeGemini(event)
        break
      case 'kiro-claude':
        throw new Error('Kiro Claude streams require the dedicated Amazon event-stream bridge.')
    }
    return this.drainFrames()
  }

  finish(): Uint8Array[] {
    if (!this.done) return this.encode({ type: 'done' })
    return this.drainFrames()
  }

  getFailure(): Extract<CanonicalStreamEvent, { type: 'error' }> | undefined {
    return this.encodingFailure
  }

  private encodeOpenAiChat(event: CanonicalStreamEvent): void {
    if (event.type === 'start') {
      this.ensureOpenAiChatStart()
      return
    }
    if (event.type === 'text-delta') {
      this.ensureOpenAiChatStart()
      this.frames.push(sseFrame({
        ...this.openAiChatEnvelope(),
        choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }]
      }))
      return
    }
    if (event.type === 'tool-call-delta') {
      this.ensureOpenAiChatStart()
      const firstDelta = !this.chatToolIds.has(event.index)
      const id = this.chatToolIds.get(event.index)
        ?? event.id
        ?? `call_${safeIdentifier(this.id)}_${event.index}`
      if (firstDelta) this.chatToolIds.set(event.index, id)
      const definition = omitUndefined({
        name: event.name,
        arguments: event.arguments
      })
      const toolCall = omitUndefined({
        index: event.index,
        id: firstDelta ? id : undefined,
        type: firstDelta ? 'function' : undefined,
        function: Object.keys(definition).length > 0 ? definition : undefined
      })
      this.frames.push(sseFrame({
        ...this.openAiChatEnvelope(),
        choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }]
      }))
      return
    }
    if (event.type === 'usage') {
      this.mergeUsage(event)
      return
    }
    if (event.type === 'stop') {
      if (this.failed || this.stopped) return
      this.ensureOpenAiChatStart()
      this.stopped = true
      this.frames.push(sseFrame({
        ...this.openAiChatEnvelope(),
        choices: [{ index: 0, delta: {}, finish_reason: canonicalToChatStop(event.reason) }]
      }))
      return
    }
    if (event.type === 'error') {
      this.failed = true
      this.frames.push(sseFrame({ error: canonicalError(event) }))
      return
    }
    if (event.type === 'done' && !this.done) {
      if (this.failed) {
        this.done = true
        return
      }
      if (!this.chatUsageEmitted && hasUsage(this.usage)) {
        this.ensureOpenAiChatStart()
        this.chatUsageEmitted = true
        this.frames.push(sseFrame({
          ...this.openAiChatEnvelope(),
          choices: [],
          usage: openAiUsage(this.usage)
        }))
      }
      this.done = true
      this.frames.push(sseFrame('[DONE]'))
    }
  }

  private encodeOpenAiResponses(event: CanonicalStreamEvent): void {
    if (event.type === 'start') {
      this.ensureResponsesStart()
      return
    }
    if (event.type === 'text-delta') {
      this.ensureResponsesStart()
      this.ensureResponsesTextStarted()
      this.responsesText += event.text
      if (event.index !== undefined) this.responsesTextSourceIndices.add(event.index)
      this.frames.push(responsesSse('response.output_text.delta', {
        response_id: this.id,
        item_id: `${this.id}_message`,
        output_index: this.responsesTextOutputIndex,
        content_index: 0,
        delta: event.text
      }))
      return
    }
    if (event.type === 'tool-call-delta') {
      this.ensureResponsesStart()
      const tool = this.updateTool(event)
      this.reserveResponsesToolOutputIndex(tool)
      // A provider bridge cannot authorize the call until the complete wire
      // alias is known. Custom wrappers additionally require complete JSON so
      // their raw input can be restored without exposing the wrapper to Codex.
      if (this.toolBridgePlan) return
      const wasStarted = tool.started
      this.ensureResponsesToolStarted(tool)
      if (tool.started && event.arguments !== undefined) {
        const delta = wasStarted ? event.arguments : tool.arguments.slice(tool.emittedArguments)
        if (delta) {
          const custom = tool.toolType === 'custom_tool_call'
          this.frames.push(responsesSse(
            custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', {
            response_id: this.id,
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta
          }))
          tool.emittedArguments = tool.arguments.length
        }
      }
      return
    }
    if (event.type === 'tool-call-complete') {
      const tool = this.tools.get(event.index)
      if (tool) tool.completed = true
      return
    }
    if (event.type === 'message-complete') {
      this.responsesCompletedMessageIndices.add(event.index)
      return
    }
    if (event.type === 'usage') {
      this.mergeUsage(event)
      return
    }
    if (event.type === 'stop') {
      this.pendingStop ??= event
      return
    }
    if (event.type === 'error') {
      this.failed = true
      const error = canonicalError(event)
      const { type: errorType, ...details } = error
      this.frames.push(responsesSse('error', omitUndefined({
        ...details,
        error_type: errorType
      })))
      return
    }
    if (event.type === 'done' && !this.done) {
      if (this.failed) {
        this.done = true
        return
      }
      if (!this.stopped) {
        this.ensureResponsesStart()
        if (!this.prepareResponsesToolBridge()) {
          this.done = true
          return
        }
        this.closeResponsesOutput(this.pendingStop ?? { type: 'stop', reason: 'stop' })
        this.stopped = true
      }
      this.done = true
    }
  }

  private encodeAnthropic(event: CanonicalStreamEvent): void {
    if (event.type === 'start') {
      return
    }
    if (event.type === 'text-delta') {
      this.ensureAnthropicStart()
      if (!this.anthropicTextStarted || this.anthropicTextClosed) {
        this.anthropicTextStarted = true
        this.anthropicTextClosed = false
        this.anthropicTextIndex = this.anthropicNextContentIndex++
        this.frames.push(anthropicSse('content_block_start', {
          type: 'content_block_start',
          index: this.anthropicTextIndex,
          content_block: { type: 'text', text: '' }
        }))
      }
      this.frames.push(anthropicSse('content_block_delta', {
        type: 'content_block_delta',
        index: this.anthropicTextIndex,
        delta: { type: 'text_delta', text: event.text }
      }))
      return
    }
    if (event.type === 'tool-call-delta') {
      this.ensureAnthropicStart()
      const tool = this.updateTool(event)
      const wasStarted = tool.started
      this.ensureAnthropicToolStarted(tool)
      if (tool.started && event.arguments !== undefined) {
        const delta = wasStarted ? event.arguments : tool.arguments.slice(tool.emittedArguments)
        if (delta) {
          this.frames.push(anthropicSse('content_block_delta', {
            type: 'content_block_delta',
            index: tool.contentIndex,
            delta: { type: 'input_json_delta', partial_json: delta }
          }))
          tool.emittedArguments = tool.arguments.length
        }
      }
      return
    }
    if (event.type === 'usage') {
      this.mergeUsage(event)
      if (this.stopped) this.frames.push(this.anthropicUsageFrame())
      return
    }
    if (event.type === 'stop') {
      this.pendingStop ??= event
      return
    }
    if (event.type === 'error') {
      this.failed = true
      this.frames.push(anthropicSse('error', { type: 'error', error: canonicalError(event) }))
      return
    }
    if (event.type === 'done' && !this.done) {
      if (this.failed) {
        this.done = true
        return
      }
      if (!this.stopped) this.finalizeAnthropic(this.pendingStop ?? { type: 'stop', reason: 'stop' })
      this.done = true
      this.frames.push(anthropicSse('message_stop', { type: 'message_stop' }))
    }
  }

  private encodeGemini(event: CanonicalStreamEvent): void {
    if (event.type === 'start') {
      this.started = true
      return
    }
    if (event.type === 'text-delta') {
      this.frames.push(sseFrame({
        candidates: [{ content: { role: 'model', parts: [{ text: event.text }] } }],
        modelVersion: this.model || undefined
      }))
      return
    }
    if (event.type === 'tool-call-delta') {
      this.updateTool(event)
      return
    }
    if (event.type === 'tool-call-complete') {
      const tool = this.tools.get(event.index)
      if (tool) this.emitGeminiTool(tool)
      return
    }
    if (event.type === 'usage') {
      this.mergeUsage(event)
      if (this.stopped) this.frames.push(sseFrame({ usageMetadata: geminiUsage(this.usage) }))
      return
    }
    if (event.type === 'stop') {
      this.pendingStop ??= event
      return
    }
    if (event.type === 'error') {
      this.failed = true
      this.frames.push(sseFrame({ error: canonicalError(event) }))
      return
    }
    if (event.type === 'done' && !this.done) {
      if (this.failed) {
        this.done = true
        return
      }
      if (!this.stopped) this.finalizeGemini(this.pendingStop ?? { type: 'stop', reason: 'stop' })
      this.done = true
    }
  }

  private updateTool(event: Extract<CanonicalStreamEvent, { type: 'tool-call-delta' }>): EncodedToolState {
    let tool = this.tools.get(event.index)
    if (!tool) {
      tool = {
        index: event.index,
        id: '',
        name: '',
        arguments: '',
        started: false,
        emittedArguments: 0,
        emitted: false,
        completed: false
      }
      this.tools.set(event.index, tool)
    }
    if (event.id !== undefined) tool.id = mergeStreamedIdentity(tool.id, event.id)
    if (event.name !== undefined) tool.name = mergeStreamedIdentity(tool.name, event.name)
    if (event.arguments !== undefined) tool.arguments += event.arguments
    if (event.toolType !== undefined) tool.toolType = event.toolType
    return tool
  }

  private prepareResponsesToolBridge(): boolean {
    const plan = this.toolBridgePlan
    if (!plan || this.protocol !== 'openai-responses') return true
    const tools = [...this.tools.values()]
    if (plan.parallelToolCalls === false && tools.length > 1) {
      return this.failResponsesToolBridge(
        'Upstream returned parallel tool calls when parallel tool calls were disabled',
        'invalid_tool_bridge'
      )
    }
    const aliases = new Map<string, ToolBridgeBinding>()
    for (const binding of plan.tools) {
      if (binding.declared === false) continue
      if (aliases.has(binding.wireName)) {
        return this.failResponsesToolBridge(
          'The current request contains an ambiguous tool alias',
          'duplicate_tool_alias'
        )
      }
      aliases.set(binding.wireName, binding)
    }
    const usedCallIds = new Set(plan.calls.map((call) => call.callId))
    for (const tool of tools) {
      const binding = aliases.get(tool.name)
      if (!binding) {
        return this.failResponsesToolBridge(
          'Upstream returned a tool that was not declared by the current request',
          'unknown_tool_alias'
        )
      }
      if (!tool.id) {
        return this.failResponsesToolBridge(
          'Upstream returned a tool call without an id',
          'missing_tool_call_id'
        )
      }
      const callId = tool.id
      if (usedCallIds.has(callId)) {
        return this.failResponsesToolBridge(
          'Upstream returned a duplicate tool call id',
          'duplicate_tool_call_id'
        )
      }
      usedCallIds.add(callId)
      tool.bridgeBinding = binding
      if (binding.sourceType !== 'custom') continue
      const parsed = parseJsonObject(tool.arguments)
      if (!parsed || typeof parsed.input !== 'string' || Object.keys(parsed).some((key) => key !== 'input')) {
        return this.failResponsesToolBridge(
          'Upstream custom tool arguments must be exactly { input: string }',
          'invalid_custom_tool_arguments'
        )
      }
      tool.customInput = parsed.input
    }
    return true
  }

  private failResponsesToolBridge(message: string, code: string): false {
    this.failed = true
    this.encodingFailure ??= {
      type: 'error',
      message,
      errorType: 'invalid_tool_bridge',
      code
    }
    this.frames.push(responsesSse('error', {
      message,
      error_type: 'invalid_tool_bridge',
      code
    }))
    return false
  }

  private mergeUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): void {
    const inputTokens = event.inputTokens ?? this.usage.inputTokens
    const outputTokens = event.outputTokens ?? this.usage.outputTokens
    this.usage = {
      type: 'usage',
      inputTokens,
      outputTokens,
      totalTokens: event.totalTokens ?? sumDefined(inputTokens, outputTokens) ?? this.usage.totalTokens,
      cachedInputTokens: event.cachedInputTokens ?? this.usage.cachedInputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens ?? this.usage.cacheCreationInputTokens,
      cacheCreation5mInputTokens: event.cacheCreation5mInputTokens ?? this.usage.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: event.cacheCreation1hInputTokens ?? this.usage.cacheCreation1hInputTokens,
      reasoningTokens: event.reasoningTokens ?? this.usage.reasoningTokens
    }
  }

  private ensureOpenAiChatStart(): void {
    if (this.started) return
    this.started = true
    this.frames.push(sseFrame({
      ...this.openAiChatEnvelope(),
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    }))
  }

  private openAiChatEnvelope(): JsonObject {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(this.createdAt / 1000),
      model: this.model
    }
  }

  private ensureResponsesStart(): void {
    if (this.started) return
    this.started = true
    this.frames.push(responsesSse('response.created', {
      response: this.responsesEnvelope('in_progress', [])
    }))
  }

  private ensureResponsesTextStarted(): void {
    if (this.responsesTextStarted) return
    this.responsesTextStarted = true
    this.responsesTextOutputIndex = this.responsesNextOutputIndex++
    this.frames.push(responsesSse('response.output_item.added', {
      response_id: this.id,
      output_index: this.responsesTextOutputIndex,
      item: {
        id: `${this.id}_message`,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    }))
    this.frames.push(responsesSse('response.content_part.added', {
      response_id: this.id,
      item_id: `${this.id}_message`,
      output_index: this.responsesTextOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    }))
  }

  private ensureResponsesToolStarted(tool: EncodedToolState, force = false): void {
    if (tool.started || (!force && !tool.name)) return
    tool.started = true
    this.reserveResponsesToolOutputIndex(tool)
    tool.itemId = `${this.id}_fc_${tool.index}`
    const custom = tool.bridgeBinding?.sourceType === 'custom' || tool.toolType === 'custom_tool_call'
    this.frames.push(responsesSse('response.output_item.added', {
      response_id: this.id,
      output_index: tool.outputIndex,
      item: custom ? {
        id: tool.itemId,
        type: 'custom_tool_call',
        status: 'in_progress',
        call_id: tool.id || tool.itemId,
        name: tool.bridgeBinding?.sourceName ?? tool.name,
        input: ''
      } : {
        id: tool.itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: tool.id || tool.itemId,
        name: tool.bridgeBinding?.sourceName ?? tool.name,
        ...(tool.bridgeBinding?.sourceNamespace ? { namespace: tool.bridgeBinding.sourceNamespace } : {}),
        arguments: ''
      }
    }))
  }

  private reserveResponsesToolOutputIndex(tool: EncodedToolState): void {
    if (tool.outputIndex === undefined) tool.outputIndex = this.responsesNextOutputIndex++
  }

  private closeResponsesOutput(stop: Extract<CanonicalStreamEvent, { type: 'stop' }>): void {
    const incompleteReason = stop.reason === 'length'
      ? 'max_output_tokens'
      : stop.reason === 'content_filter' ? 'content_filter' : undefined
    const itemStatus = incompleteReason ? 'incomplete' : 'completed'
    // The terminal snapshot must use the same output_index namespace already
    // advertised by response.output_item.* events. Appending text first would
    // corrupt tool-first streams by making output[0] disagree with the earlier
    // tool event at output_index=0.
    const output: JsonObject[] = []
    if (this.responsesTextStarted) {
      const allSourceMessagesCompleted = this.responsesTextSourceIndices.size > 0
        && [...this.responsesTextSourceIndices].every((index) => this.responsesCompletedMessageIndices.has(index))
      const item = {
        id: `${this.id}_message`,
        type: 'message',
        status: allSourceMessagesCompleted ? 'completed' : itemStatus,
        role: 'assistant',
        content: [{ type: 'output_text', text: this.responsesText, annotations: [] }]
      }
      this.frames.push(responsesSse('response.output_text.done', {
        response_id: this.id,
        item_id: item.id,
        output_index: this.responsesTextOutputIndex,
        content_index: 0,
        text: this.responsesText
      }))
      this.frames.push(responsesSse('response.output_item.done', {
        response_id: this.id,
        output_index: this.responsesTextOutputIndex,
        item
      }))
      output[this.responsesTextOutputIndex ?? 0] = item
    }
    for (const tool of this.tools.values()) {
      this.ensureResponsesToolStarted(tool, true)
      const custom = tool.bridgeBinding?.sourceType === 'custom' || tool.toolType === 'custom_tool_call'
      const streamedValue = custom ? (tool.customInput ?? tool.arguments) : tool.arguments
      const deltaEvent = custom
        ? 'response.custom_tool_call_input.delta'
        : 'response.function_call_arguments.delta'
      const doneEvent = custom
        ? 'response.custom_tool_call_input.done'
        : 'response.function_call_arguments.done'
      if (streamedValue.length > tool.emittedArguments) {
        this.frames.push(responsesSse(deltaEvent, {
          response_id: this.id,
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta: streamedValue.slice(tool.emittedArguments)
        }))
        tool.emittedArguments = streamedValue.length
      }
      const item = custom ? {
        id: tool.itemId,
        type: 'custom_tool_call',
        status: tool.completed ? 'completed' : itemStatus,
        call_id: tool.id || tool.itemId,
        name: tool.bridgeBinding?.sourceName ?? tool.name,
        input: streamedValue
      } : {
        id: tool.itemId,
        type: 'function_call',
        status: tool.completed ? 'completed' : itemStatus,
        call_id: tool.id || tool.itemId,
        name: tool.bridgeBinding?.sourceName ?? tool.name,
        ...(tool.bridgeBinding?.sourceNamespace ? { namespace: tool.bridgeBinding.sourceNamespace } : {}),
        arguments: tool.arguments
      }
      this.frames.push(responsesSse(doneEvent, {
        response_id: this.id,
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        ...(custom ? { input: streamedValue } : { arguments: tool.arguments })
      }))
      this.frames.push(responsesSse('response.output_item.done', {
        response_id: this.id,
        output_index: tool.outputIndex,
        item
      }))
      output[tool.outputIndex ?? output.length] = item
    }
    const response = this.responsesEnvelope(incompleteReason ? 'incomplete' : 'completed', output)
    if (incompleteReason) response.incomplete_details = { reason: incompleteReason }
    this.frames.push(responsesSse(
      incompleteReason ? 'response.incomplete' : 'response.completed',
      { response }
    ))
  }

  private responsesEnvelope(status: string, output: JsonObject[]): JsonObject {
    return {
      id: this.id,
      object: 'response',
      created_at: Math.floor(this.createdAt / 1000),
      status,
      model: this.model,
      output,
      usage: responsesUsage(this.usage)
    }
  }

  private ensureAnthropicStart(): void {
    if (this.started) return
    this.started = true
    this.frames.push(anthropicSse('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.inputTokens ?? 0, output_tokens: 0 }
      }
    }))
  }

  private ensureAnthropicToolStarted(tool: EncodedToolState, force = false): void {
    if (tool.started || (!force && (!tool.id || !tool.name))) return
    if (this.anthropicTextStarted && !this.anthropicTextClosed) {
      this.anthropicTextClosed = true
      this.frames.push(anthropicSse('content_block_stop', {
        type: 'content_block_stop',
        index: this.anthropicTextIndex
      }))
    }
    tool.started = true
    tool.contentIndex = this.anthropicNextContentIndex++
    this.frames.push(anthropicSse('content_block_start', {
      type: 'content_block_start',
      index: tool.contentIndex,
      content_block: {
        type: 'tool_use',
        id: tool.id || `${this.id}_tool_${tool.index}`,
        name: tool.name,
        input: {}
      }
    }))
  }

  private closeAnthropicBlocks(): void {
    if (this.anthropicTextStarted && !this.anthropicTextClosed) {
      this.anthropicTextClosed = true
      this.frames.push(anthropicSse('content_block_stop', {
        type: 'content_block_stop',
        index: this.anthropicTextIndex
      }))
    }
    for (const tool of this.tools.values()) {
      this.ensureAnthropicToolStarted(tool, true)
      if (tool.arguments.length > tool.emittedArguments) {
        this.frames.push(anthropicSse('content_block_delta', {
          type: 'content_block_delta',
          index: tool.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: tool.arguments.slice(tool.emittedArguments)
          }
        }))
        tool.emittedArguments = tool.arguments.length
      }
      this.frames.push(anthropicSse('content_block_stop', {
        type: 'content_block_stop',
        index: tool.contentIndex
      }))
    }
  }

  private finalizeAnthropic(stop: Extract<CanonicalStreamEvent, { type: 'stop' }>): void {
    this.ensureAnthropicStart()
    this.closeAnthropicBlocks()
    this.stopped = true
    this.frames.push(anthropicSse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: canonicalToAnthropicStop(stop.reason), stop_sequence: null },
      usage: anthropicUsage(this.usage)
    }))
  }

  private anthropicUsageFrame(): string {
    return anthropicSse('message_delta', {
      type: 'message_delta',
      delta: {},
      usage: anthropicUsage(this.usage)
    })
  }

  private emitGeminiTool(tool: EncodedToolState): boolean {
    if (tool.emitted) return true
    const args = parseJsonObject(tool.arguments)
    if (!args) {
      const message = `Tool call ${tool.name || tool.id || tool.index} arguments are not a valid JSON object`
      this.failed = true
      this.encodingFailure ??= {
        type: 'error',
        message,
        errorType: 'invalid_tool_arguments',
        code: 'invalid_tool_arguments'
      }
      this.frames.push(sseFrame({
        error: {
          message,
          type: 'invalid_tool_arguments',
          code: 'invalid_tool_arguments'
        }
      }))
      return false
    }
    tool.emitted = true
    this.frames.push(sseFrame({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: omitUndefined({
              id: optionalString(tool.id),
              name: tool.name,
              args
            })
          }]
        }
      }],
      modelVersion: this.model || undefined
    }))
    return true
  }

  private finalizeGemini(stop: Extract<CanonicalStreamEvent, { type: 'stop' }>): void {
    for (const tool of this.tools.values()) {
      if (!this.emitGeminiTool(tool)) return
    }
    this.stopped = true
    this.frames.push(sseFrame({
      candidates: [{
        content: { role: 'model', parts: [] },
        finishReason: canonicalToGeminiStop(stop.reason)
      }],
      modelVersion: this.model || undefined,
      usageMetadata: geminiUsage(this.usage)
    }))
  }

  private drainFrames(): Uint8Array[] {
    return this.frames.splice(0).map((frame) => this.textEncoder.encode(frame))
  }
}

export function createCanonicalStreamParser(
  protocol: Protocol,
  options: StreamParsingOptions = {}
): CanonicalStreamParser {
  assertCanonicalStreamingProtocol(protocol)
  return new ProtocolParser(protocol, options)
}

export function createCanonicalStreamEncoder(
  protocol: Protocol,
  options: StreamEncodingOptions = {}
): CanonicalStreamEncoder {
  assertCanonicalStreamingProtocol(protocol)
  return new ProtocolEncoder(protocol, options)
}

function assertCanonicalStreamingProtocol(protocol: Protocol): void {
  if (protocol === 'kiro-claude') {
    throw new Error('Kiro Claude streams require the dedicated Amazon event-stream bridge.')
  }
}

export function createOpenAiResponsesStreamCollector(
  options: StreamEncodingOptions = {}
): OpenAiResponsesStreamCollector {
  return new ResponsesStreamCollector(options)
}

export function createStreamParserTransform(
  protocol: Protocol
): TransformStream<Uint8Array, CanonicalStreamEvent> {
  const parser = createCanonicalStreamParser(protocol)
  return new TransformStream<Uint8Array, CanonicalStreamEvent>({
    transform(chunk, controller) {
      for (const event of parser.push(chunk)) controller.enqueue(event)
    },
    flush(controller) {
      for (const event of parser.finish()) controller.enqueue(event)
    }
  })
}

export function createStreamEncoderTransform(
  protocol: Protocol,
  options: StreamEncodingOptions = {}
): TransformStream<CanonicalStreamEvent, Uint8Array> {
  const encoder = createCanonicalStreamEncoder(protocol, options)
  return new TransformStream<CanonicalStreamEvent, Uint8Array>({
    transform(event, controller) {
      for (const chunk of encoder.encode(event)) controller.enqueue(chunk)
    },
    flush(controller) {
      for (const chunk of encoder.finish()) controller.enqueue(chunk)
    }
  })
}

export function createProtocolStreamTransform(
  from: Protocol,
  to: Protocol,
  options: StreamEncodingOptions = {}
): TransformStream<Uint8Array, Uint8Array> {
  const parser = createCanonicalStreamParser(from)
  const encoder = createCanonicalStreamEncoder(to, options)
  const forward = (
    events: CanonicalStreamEvent[],
    controller: TransformStreamDefaultController<Uint8Array>
  ): void => {
    for (const event of events) {
      for (const chunk of encoder.encode(event)) controller.enqueue(chunk)
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      forward(parser.push(chunk), controller)
    },
    flush(controller) {
      forward(parser.finish(), controller)
      for (const chunk of encoder.finish()) controller.enqueue(chunk)
    }
  })
}

function sseFrame(data: unknown): string {
  const encoded = typeof data === 'string' ? data : JSON.stringify(data)
  return `data: ${encoded}\n\n`
}

function responsesSse(type: string, data: JsonObject): string {
  // The SSE event name and payload type are one protocol discriminator.
  // Never let a provider-specific error classification overwrite it.
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`
}

function anthropicSse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function openAiUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    prompt_tokens: event.inputTokens,
    completion_tokens: event.outputTokens,
    total_tokens: event.totalTokens
      ?? sumDefined(event.inputTokens, event.outputTokens),
    prompt_tokens_details: event.cachedInputTokens === undefined ? undefined : { cached_tokens: event.cachedInputTokens },
    completion_tokens_details: event.reasoningTokens === undefined ? undefined : { reasoning_tokens: event.reasoningTokens }
  })
}

function responsesUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    total_tokens: event.totalTokens
      ?? sumDefined(event.inputTokens, event.outputTokens),
    input_tokens_details: event.cachedInputTokens === undefined ? undefined : { cached_tokens: event.cachedInputTokens },
    output_tokens_details: event.reasoningTokens === undefined ? undefined : { reasoning_tokens: event.reasoningTokens }
  })
}

function anthropicUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  const cacheCreation = event.cacheCreationInputTokens
    ?? sumOptional(event.cacheCreation5mInputTokens, event.cacheCreation1hInputTokens)
  const uncachedInput = event.inputTokens === undefined
    ? undefined
    : Math.max(0, event.inputTokens - (event.cachedInputTokens ?? 0) - (cacheCreation ?? 0))
  return omitUndefined({
    input_tokens: uncachedInput,
    output_tokens: event.outputTokens,
    cache_read_input_tokens: event.cachedInputTokens,
    cache_creation_input_tokens: event.cacheCreationInputTokens,
    cache_creation: event.cacheCreation5mInputTokens === undefined
      && event.cacheCreation1hInputTokens === undefined
      ? undefined
      : omitUndefined({
          ephemeral_5m_input_tokens: event.cacheCreation5mInputTokens,
          ephemeral_1h_input_tokens: event.cacheCreation1hInputTokens
        })
  })
}

function geminiUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    promptTokenCount: event.inputTokens,
    candidatesTokenCount: event.outputTokens,
    totalTokenCount: event.totalTokens
      ?? sumDefined(event.inputTokens, event.outputTokens)
  })
}

function sumDefined(first: number | undefined, second: number | undefined): number | undefined {
  return first !== undefined && second !== undefined ? first + second : undefined
}

function sumOptional(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) return undefined
  return (first ?? 0) + (second ?? 0)
}

function hasUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): boolean {
  return event.inputTokens !== undefined
    || event.outputTokens !== undefined
    || event.totalTokens !== undefined
    || event.cachedInputTokens !== undefined
    || event.cacheCreationInputTokens !== undefined
    || event.cacheCreation5mInputTokens !== undefined
    || event.cacheCreation1hInputTokens !== undefined
    || event.reasoningTokens !== undefined
}

function canonicalError(event: Extract<CanonicalStreamEvent, { type: 'error' }>): JsonObject {
  return omitUndefined({ message: event.message, type: event.errorType, code: event.code })
}

function responsesEventAdvancesProgress(type: string): boolean {
  if (type === 'response.completed'
    || type === 'response.incomplete'
    || type === 'response.failed'
    || type === 'response.error'
    || type === 'error') return true

  // Only application events that represent generated output, internal
  // reasoning, tool execution, usage, or a terminal result advance this
  // counter. In particular, response.created/queued/in_progress and transport
  // ping/heartbeat frames must not make a stalled request look healthy.
  return type.startsWith('response.output_')
    || type.startsWith('response.content_part.')
    || type.startsWith('response.reasoning')
    || type.startsWith('response.refusal')
    || type.startsWith('response.audio')
    || type.startsWith('response.usage')
    || type.startsWith('response.function_call')
    || type.startsWith('response.custom_tool_call')
    || type.startsWith('response.file_search_call')
    || type.startsWith('response.web_search_call')
    || type.startsWith('response.code_interpreter_call')
    || type.startsWith('response.image_generation_call')
    || type.startsWith('response.mcp_')
    || type.startsWith('response.tool_')
}

function chatStopReason(reason: string): CanonicalStopReason {
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls'
  if (reason === 'content_filter') return 'content_filter'
  if (reason === 'stop') return 'stop'
  return 'other'
}

function anthropicStopReason(reason: string): CanonicalStopReason {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'refusal') return 'content_filter'
  return 'other'
}

function geminiStopReason(reason: string): CanonicalStopReason {
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') {
    return 'content_filter'
  }
  if (reason === 'STOP') return 'stop'
  return 'other'
}

function canonicalToChatStop(reason: CanonicalStopReason): string {
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

function canonicalToAnthropicStop(reason: CanonicalStopReason): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function canonicalToGeminiStop(reason: CanonicalStopReason): string {
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'content_filter') return 'SAFETY'
  return 'STOP'
}

function parseJsonObject(value: string): JsonObject | undefined {
  if (!value) return undefined
  try {
    return objectValue(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

function normalizeTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value
}

/**
 * Some OpenAI-compatible relays repeat the complete id/name in later chunks,
 * while others send append-only fragments. Accept both without duplicating a
 * repeated snapshot (for example `call_1call_1`).
 */
function mergeStreamedIdentity(current: string, incoming: string): string {
  if (!incoming || incoming === current || current.startsWith(incoming)) return current
  if (!current || incoming.startsWith(current)) return incoming
  return current + incoming
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'stream'
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return arrayValue(value).flatMap((item) => {
    const object = objectValue(item)
    return object ? [object] : []
  })
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function omitUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function omitUndefinedEvent<T extends CanonicalStreamEvent>(event: T): T {
  return Object.fromEntries(
    Object.entries(event).filter(([, item]) => item !== undefined)
  ) as T
}
