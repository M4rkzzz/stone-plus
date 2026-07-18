import type { Protocol } from '../../shared/types'

type JsonObject = Record<string, unknown>

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
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; arguments?: string }
  /** Lifecycle signal used to distinguish a consumable tool call from a partial client abort. */
  | { type: 'tool-call-complete'; index: number }
  /** Lifecycle signal emitted when a Responses assistant message output item is complete. */
  | { type: 'message-complete'; index: number }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'stop'; reason: CanonicalStopReason; rawReason?: string }
  | { type: 'error'; message: string; code?: string; errorType?: string }
  | { type: 'done' }

export interface StreamEncodingOptions {
  id?: string
  model?: string
  now?: () => number
}

export interface CanonicalStreamParser {
  /** Accepts arbitrarily split bytes and returns every complete event available. */
  push(chunk: Uint8Array): CanonicalStreamEvent[]
  /** Flushes UTF-8/framing state and emits a final `done` when needed. */
  finish(): CanonicalStreamEvent[]
}

export interface CanonicalStreamEncoder {
  /** Encodes one canonical event; a protocol event may require multiple frames. */
  encode(event: CanonicalStreamEvent): Uint8Array[]
  finish(): Uint8Array[]
}

export interface OpenAiResponsesStreamResult {
  response?: JsonObject
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  error?: string
}

export interface OpenAiResponsesStreamCollector {
  /** Accepts arbitrarily split Responses SSE bytes without buffering the wire payload. */
  push(chunk: Uint8Array): void
  /** Finalizes the stream and returns one ordinary Responses API object. */
  finish(): OpenAiResponsesStreamResult
}

type SseHandler = (eventName: string | undefined, data: string) => void

class SseFramer {
  private buffer = ''
  private eventName: string | undefined
  private dataLines: string[] = []

  constructor(private readonly onEvent: SseHandler) {}

  push(text: string): void {
    this.buffer += text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.processLine(line)
    }
  }

  finish(): void {
    if (this.buffer.length > 0) this.processLine(this.buffer.replace(/\r$/, ''))
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
  }
}

interface CollectedToolCall {
  id?: string
  name?: string
  arguments: string
}

class ResponsesStreamCollector implements OpenAiResponsesStreamCollector {
  private readonly parser = createCanonicalStreamParser('openai-responses')
  private readonly decoder = new TextDecoder()
  private readonly terminalFramer = new SseFramer((eventName, data) => this.captureTerminalResponse(eventName, data))
  private readonly tools = new Map<number, CollectedToolCall>()
  private readonly now: () => number
  private id?: string
  private model?: string
  private createdAt?: number
  private text = ''
  private usage: NonNullable<OpenAiResponsesStreamResult['usage']> = {}
  private stopReason?: CanonicalStopReason
  private terminalResponse?: JsonObject
  private terminalType?: 'response.completed' | 'response.incomplete'
  private error?: string
  private done = false
  private finished = false
  private result?: OpenAiResponsesStreamResult

  constructor(private readonly options: StreamEncodingOptions) {
    this.now = options.now ?? Date.now
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error('Cannot append to a finalized Responses stream')
    this.terminalFramer.push(this.decoder.decode(chunk, { stream: true }))
    this.consume(this.parser.push(chunk))
  }

  finish(): OpenAiResponsesStreamResult {
    if (this.result) return this.result
    this.finished = true
    this.terminalFramer.push(this.decoder.decode())
    this.terminalFramer.finish()
    this.consume(this.parser.finish())

    const usage = Object.keys(this.usage).length > 0 ? { ...this.usage } : undefined
    const error = this.error
      ?? (!this.stopReason || !this.done ? 'Upstream Responses stream ended before a terminal response' : undefined)
    if (error) {
      this.result = { ...(usage ? { usage } : {}), error }
      return this.result
    }

    const response = this.buildResponse()
    this.result = { response, ...(usage ? { usage } : {}) }
    return this.result
  }

  private consume(events: CanonicalStreamEvent[]): void {
    for (const event of events) {
      if (event.type === 'start') {
        this.id = event.id ?? this.id
        this.model = event.model ?? this.model
        this.createdAt = event.createdAt ?? this.createdAt
      } else if (event.type === 'text-delta') {
        this.text += event.text
      } else if (event.type === 'tool-call-delta') {
        const tool = this.tools.get(event.index) ?? { arguments: '' }
        tool.id = event.id ?? tool.id
        tool.name = event.name ?? tool.name
        if (event.arguments) tool.arguments += event.arguments
        this.tools.set(event.index, tool)
      } else if (event.type === 'usage') {
        if (event.inputTokens !== undefined) this.usage.input_tokens = event.inputTokens
        if (event.outputTokens !== undefined) this.usage.output_tokens = event.outputTokens
        if (event.totalTokens !== undefined) this.usage.total_tokens = event.totalTokens
      } else if (event.type === 'stop') {
        this.stopReason = event.reason
      } else if (event.type === 'error') {
        this.error ??= event.message
      } else if (event.type === 'done') {
        this.done = true
      }
    }
  }

  private captureTerminalResponse(eventName: string | undefined, data: string): void {
    if (data.trim() === '[DONE]') return
    let payload: JsonObject | undefined
    try {
      payload = objectValue(JSON.parse(data) as unknown)
    } catch {
      return
    }
    const type = stringValue(payload?.type, eventName ?? '')
    if (type !== 'response.completed' && type !== 'response.incomplete') return
    const response = objectValue(payload?.response)
    if (!response) return
    this.terminalType = type
    this.terminalResponse = response
  }

  private buildResponse(): JsonObject {
    const id = this.id ?? this.options.id ?? `resp_${this.now()}`
    const aggregateOutput: JsonObject[] = []
    if (this.text) {
      aggregateOutput.push({
        id: `msg_${safeIdentifier(id)}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text, annotations: [] }]
      })
    }
    for (const [index, tool] of [...this.tools.entries()].sort(([left], [right]) => left - right)) {
      const callId = tool.id ?? `call_${safeIdentifier(id)}_${index}`
      aggregateOutput.push({
        id: `fc_${safeIdentifier(id)}_${index}`,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: tool.name ?? '',
        arguments: tool.arguments
      })
    }

    const status = this.terminalType === 'response.incomplete' || this.stopReason === 'length'
      ? 'incomplete'
      : 'completed'
    const aggregateUsage = omitUndefined({ ...this.usage })
    const aggregate: JsonObject = {
      id,
      object: 'response',
      created_at: Math.floor((this.createdAt ?? this.now()) / 1000),
      status,
      model: this.model ?? this.options.model ?? '',
      output: aggregateOutput,
      usage: aggregateUsage
    }
    if (status === 'incomplete') aggregate.incomplete_details = { reason: 'max_output_tokens' }

    const terminal = this.terminalResponse
    if (!terminal) return aggregate
    const terminalOutput = Array.isArray(terminal.output) ? terminal.output : undefined
    const output = terminalOutput && (terminalOutput.length > 0 || aggregateOutput.length === 0)
      ? terminalOutput
      : aggregateOutput
    const terminalUsage = objectValue(terminal.usage)
    return {
      ...aggregate,
      ...terminal,
      output,
      usage: { ...aggregateUsage, ...terminalUsage }
    }
  }
}

class JsonFramer {
  private buffer = ''
  private arrayMode: boolean | undefined

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly onError: (message: string) => void
  ) {}

  push(text: string): void {
    this.buffer += text
    this.drain(false)
  }

  finish(): void {
    this.drain(true)
  }

  private drain(final: boolean): void {
    while (true) {
      this.buffer = this.buffer.trimStart()
      if (this.arrayMode === undefined) {
        if (!this.buffer) return
        this.arrayMode = this.buffer.startsWith('[')
        if (this.arrayMode) this.buffer = this.buffer.slice(1)
      }

      this.buffer = this.buffer.trimStart()
      if (this.arrayMode) {
        if (this.buffer.startsWith(',')) {
          this.buffer = this.buffer.slice(1).trimStart()
        }
        if (this.buffer.startsWith(']')) {
          this.buffer = this.buffer.slice(1)
          this.arrayMode = undefined
          continue
        }
      }
      if (!this.buffer) return

      const boundary = findJsonValueBoundary(this.buffer)
      if (boundary < 0) {
        if (final) {
          this.onError('Incomplete JSON value at end of stream')
          this.buffer = ''
        }
        return
      }
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary)
      try {
        this.onValue(JSON.parse(raw) as unknown)
      } catch (error) {
        this.onError(error instanceof Error ? error.message : 'Invalid JSON stream value')
      }
      if (!this.arrayMode) this.arrayMode = undefined
    }
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
  private readonly sse = new SseFramer((eventName, data) => this.handleSse(eventName, data))
  private readonly json = new JsonFramer(
    (value) => this.handlePayload(undefined, value),
    (message) => this.emitFramingError(message)
  )
  private framing: 'sse' | 'json' | undefined
  private framingBuffer = ''
  private started = false
  private stopped = false
  private done = false
  private errored = false
  private finishing = false
  private sawToolCall = false
  private nextToolIndex = 0
  private readonly anthropicToolIndices = new Map<number, number>()
  private readonly responsesToolIndices = new Map<number, number>()
  private readonly responsesToolMetadataSeen = new Set<number>()
  private readonly responsesArgumentsSeen = new Set<number>()
  private readonly responsesToolCompleted = new Set<number>()
  private readonly geminiToolIndices = new Map<string, number>()
  private lastUsage = ''
  private usageInputTokens: number | undefined
  private usageOutputTokens: number | undefined
  private usageTotalTokens: number | undefined

  constructor(private readonly protocol: Protocol) {
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
    if (data.trim() === '[DONE]') {
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
    if (this.protocol === 'openai-chat') this.handleOpenAiChat(payload)
    else if (this.protocol === 'openai-responses') this.handleOpenAiResponses(eventName, payload)
    else if (this.protocol === 'anthropic-messages') this.handleAnthropic(eventName, payload)
    else this.handleGemini(payload)
  }

  private handleOpenAiChat(payload: JsonObject): void {
    if (payload.error) {
      this.emitErrorObject(payload.error)
      return
    }
    this.emitStart(payload.id, payload.model, payload.created)
    for (const choice of arrayOfObjects(payload.choices)) {
      const delta = objectValue(choice.delta) ?? {}
      const text = stringValue(delta.content)
      if (text) this.events.push({ type: 'text-delta', text })
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
    const type = stringValue(payload.type, eventName ?? '')
    if (type === 'error' || type === 'response.error') {
      this.emitErrorObject(payload.error ?? payload)
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
      if (text) this.events.push({ type: 'text-delta', text })
      return
    }
    if (type === 'response.output_item.added') {
      const item = objectValue(payload.item) ?? {}
      const itemType = stringValue(item.type)
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const outputIndex = numberValue(payload.output_index) ?? 0
        const index = this.responseToolIndex(outputIndex)
        const args = itemType === 'custom_tool_call'
          ? optionalString(item.input)
          : optionalString(item.arguments)
        this.responsesToolMetadataSeen.add(outputIndex)
        if (args) this.responsesArgumentsSeen.add(outputIndex)
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index,
          id: optionalString(item.call_id) ?? optionalString(item.id),
          name: optionalString(item.name),
          arguments: args
        }))
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const outputIndex = numberValue(payload.output_index) ?? 0
      const index = this.responseToolIndex(outputIndex)
      const args = optionalString(payload.delta)
      if (args) this.responsesArgumentsSeen.add(outputIndex)
      this.sawToolCall = true
      this.events.push(omitUndefinedEvent({
        type: 'tool-call-delta',
        index,
        arguments: args
      }))
      return
    }
    if (type === 'response.custom_tool_call_input.delta') {
      const outputIndex = numberValue(payload.output_index) ?? 0
      const index = this.responseToolIndex(outputIndex)
      const input = optionalString(payload.delta)
      if (input) this.responsesArgumentsSeen.add(outputIndex)
      this.sawToolCall = true
      this.events.push(omitUndefinedEvent({
        type: 'tool-call-delta',
        index,
        arguments: input
      }))
      return
    }
    if (type === 'response.function_call_arguments.done') {
      const outputIndex = numberValue(payload.output_index) ?? 0
      const index = this.responseToolIndex(outputIndex)
      const args = optionalString(payload.arguments)
      if (args && !this.responsesArgumentsSeen.has(outputIndex)) {
        this.responsesArgumentsSeen.add(outputIndex)
        this.events.push({
          type: 'tool-call-delta',
          index,
          arguments: args
        })
      }
      if (!this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.custom_tool_call_input.done') {
      const outputIndex = numberValue(payload.output_index) ?? 0
      const index = this.responseToolIndex(outputIndex)
      const input = optionalString(payload.input)
      if (input && !this.responsesArgumentsSeen.has(outputIndex)) {
        this.responsesArgumentsSeen.add(outputIndex)
        this.events.push({ type: 'tool-call-delta', index, arguments: input })
      }
      if (!this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.output_item.done') {
      const outputIndex = numberValue(payload.output_index) ?? 0
      const item = objectValue(payload.item) ?? {}
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
      const includeArguments = Boolean(args) && !this.responsesArgumentsSeen.has(outputIndex)
      if (includeMetadata || includeArguments) {
        this.sawToolCall = true
        this.events.push(omitUndefinedEvent({
          type: 'tool-call-delta',
          index,
          id: includeMetadata ? optionalString(item.call_id) ?? optionalString(item.id) : undefined,
          name: includeMetadata ? optionalString(item.name) : undefined,
          arguments: includeArguments ? args : undefined
        }))
      }
      this.responsesToolMetadataSeen.add(outputIndex)
      if (includeArguments) this.responsesArgumentsSeen.add(outputIndex)
      if (!this.responsesToolCompleted.has(outputIndex)) {
        this.responsesToolCompleted.add(outputIndex)
        this.events.push({ type: 'tool-call-complete', index })
      }
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      this.emitUsage(objectValue(response?.usage), 'input_tokens', 'output_tokens', 'total_tokens')
      const incomplete = objectValue(response?.incomplete_details)
      const rawReason = stringValue(incomplete?.reason)
      const reason = type === 'response.incomplete'
        ? (rawReason.includes('max') ? 'length' : 'other')
        : (this.sawToolCall ? 'tool_calls' : 'stop')
      this.emitStop(reason, rawReason || undefined)
      this.emitDone()
      return
    }
    if (type === 'response.failed') {
      this.emitErrorObject(response?.error ?? payload.error ?? payload)
      this.emitStop('error', 'failed')
      this.emitDone()
    }
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
      this.emitUsage(objectValue(message.usage), 'input_tokens', 'output_tokens')
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
      this.emitUsage(objectValue(payload.usage), 'input_tokens', 'output_tokens')
      const rawReason = optionalString(delta.stop_reason)
      if (rawReason) this.emitStop(anthropicStopReason(rawReason), rawReason)
      return
    }
    if (type === 'message_stop') this.emitDone()
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
        if (text) this.events.push({ type: 'text-delta', text })
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
    if (parsedInputTokens === undefined && parsedOutputTokens === undefined && parsedTotalTokens === undefined) return
    this.usageInputTokens = parsedInputTokens ?? this.usageInputTokens
    this.usageOutputTokens = parsedOutputTokens ?? this.usageOutputTokens
    this.usageTotalTokens = parsedTotalTokens
      ?? sumDefined(this.usageInputTokens, this.usageOutputTokens)
      ?? this.usageTotalTokens
    const signature = `${this.usageInputTokens ?? ''}:${this.usageOutputTokens ?? ''}:${this.usageTotalTokens ?? ''}`
    if (signature === this.lastUsage) return
    this.lastUsage = signature
    this.events.push(omitUndefinedEvent({
      type: 'usage',
      inputTokens: this.usageInputTokens,
      outputTokens: this.usageOutputTokens,
      totalTokens: this.usageTotalTokens
    }))
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
  private chatUsageEmitted = false
  private readonly chatToolIds = new Map<number, string>()

  constructor(private readonly protocol: Protocol, options: StreamEncodingOptions) {
    this.now = options.now ?? Date.now
    this.createdAt = this.now()
    this.id = options.id ?? `stream_${this.createdAt}`
    this.model = options.model ?? ''
  }

  encode(event: CanonicalStreamEvent): Uint8Array[] {
    if (this.done) return []
    if (event.type === 'start') {
      if (event.id) this.id = event.id
      if (event.model) this.model = event.model
      if (event.createdAt !== undefined) this.createdAt = event.createdAt
    }
    if (this.protocol === 'openai-chat') this.encodeOpenAiChat(event)
    else if (this.protocol === 'openai-responses') this.encodeOpenAiResponses(event)
    else if (this.protocol === 'anthropic-messages') this.encodeAnthropic(event)
    else this.encodeGemini(event)
    return this.drainFrames()
  }

  finish(): Uint8Array[] {
    if (!this.done) return this.encode({ type: 'done' })
    return this.drainFrames()
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
      if (this.stopped) return
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
      const wasStarted = tool.started
      this.ensureResponsesToolStarted(tool)
      if (tool.started && event.arguments !== undefined) {
        const delta = wasStarted ? event.arguments : tool.arguments.slice(tool.emittedArguments)
        if (delta) {
          this.frames.push(responsesSse('response.function_call_arguments.delta', {
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
      this.frames.push(responsesSse('error', canonicalError(event)))
      return
    }
    if (event.type === 'done' && !this.done) {
      if (this.failed) {
        this.done = true
        return
      }
      if (!this.stopped) {
        this.ensureResponsesStart()
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
      const tool = this.updateTool(event)
      this.emitGeminiToolIfReady(tool)
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
        emitted: false
      }
      this.tools.set(event.index, tool)
    }
    if (event.id !== undefined) tool.id += event.id
    if (event.name !== undefined) tool.name += event.name
    if (event.arguments !== undefined) tool.arguments += event.arguments
    return tool
  }

  private mergeUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): void {
    const inputTokens = event.inputTokens ?? this.usage.inputTokens
    const outputTokens = event.outputTokens ?? this.usage.outputTokens
    this.usage = {
      type: 'usage',
      inputTokens,
      outputTokens,
      totalTokens: event.totalTokens ?? sumDefined(inputTokens, outputTokens) ?? this.usage.totalTokens
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
    tool.outputIndex = this.responsesNextOutputIndex++
    tool.itemId = `${this.id}_fc_${tool.index}`
    this.frames.push(responsesSse('response.output_item.added', {
      response_id: this.id,
      output_index: tool.outputIndex,
      item: {
        id: tool.itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: tool.id || tool.itemId,
        name: tool.name,
        arguments: ''
      }
    }))
  }

  private closeResponsesOutput(stop: Extract<CanonicalStreamEvent, { type: 'stop' }>): void {
    const output: JsonObject[] = []
    if (this.responsesTextStarted) {
      const item = {
        id: `${this.id}_message`,
        type: 'message',
        status: 'completed',
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
      output.push(item)
    }
    for (const tool of this.tools.values()) {
      this.ensureResponsesToolStarted(tool, true)
      if (tool.arguments.length > tool.emittedArguments) {
        this.frames.push(responsesSse('response.function_call_arguments.delta', {
          response_id: this.id,
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta: tool.arguments.slice(tool.emittedArguments)
        }))
        tool.emittedArguments = tool.arguments.length
      }
      const item = {
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: tool.id || tool.itemId,
        name: tool.name,
        arguments: tool.arguments
      }
      this.frames.push(responsesSse('response.function_call_arguments.done', {
        response_id: this.id,
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.arguments
      }))
      this.frames.push(responsesSse('response.output_item.done', {
        response_id: this.id,
        output_index: tool.outputIndex,
        item
      }))
      output.push(item)
    }
    const response = this.responsesEnvelope(stop.reason === 'length' ? 'incomplete' : 'completed', output)
    if (stop.reason === 'length') response.incomplete_details = { reason: 'max_output_tokens' }
    this.frames.push(responsesSse(
      stop.reason === 'length' ? 'response.incomplete' : 'response.completed',
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

  private emitGeminiToolIfReady(tool: EncodedToolState): void {
    if (tool.emitted || !tool.name || !tool.arguments) return
    if (parseJsonObject(tool.arguments)) this.emitGeminiTool(tool, false)
  }

  private emitGeminiTool(tool: EncodedToolState, force: boolean): void {
    if (tool.emitted) return
    const args = parseJsonObject(tool.arguments)
    if (!force && !args) return
    tool.emitted = true
    this.frames.push(sseFrame({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: omitUndefined({
              id: optionalString(tool.id),
              name: tool.name,
              args: args ?? {}
            })
          }]
        }
      }],
      modelVersion: this.model || undefined
    }))
  }

  private finalizeGemini(stop: Extract<CanonicalStreamEvent, { type: 'stop' }>): void {
    for (const tool of this.tools.values()) this.emitGeminiTool(tool, true)
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

export function createCanonicalStreamParser(protocol: Protocol): CanonicalStreamParser {
  return new ProtocolParser(protocol)
}

export function createCanonicalStreamEncoder(
  protocol: Protocol,
  options: StreamEncodingOptions = {}
): CanonicalStreamEncoder {
  return new ProtocolEncoder(protocol, options)
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
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

function anthropicSse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function openAiUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    prompt_tokens: event.inputTokens,
    completion_tokens: event.outputTokens,
    total_tokens: event.totalTokens
      ?? sumDefined(event.inputTokens, event.outputTokens)
  })
}

function responsesUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    total_tokens: event.totalTokens
      ?? sumDefined(event.inputTokens, event.outputTokens)
  })
}

function anthropicUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): JsonObject {
  return omitUndefined({
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens
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

function hasUsage(event: Extract<CanonicalStreamEvent, { type: 'usage' }>): boolean {
  return event.inputTokens !== undefined
    || event.outputTokens !== undefined
    || event.totalTokens !== undefined
}

function canonicalError(event: Extract<CanonicalStreamEvent, { type: 'error' }>): JsonObject {
  return omitUndefined({ message: event.message, type: event.errorType, code: event.code })
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
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'pause_turn') return 'stop'
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
