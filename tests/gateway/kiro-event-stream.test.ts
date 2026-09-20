import { describe, expect, it } from 'vitest'
import {
  collectKiroEventStreamBody,
  createKiroEventStreamCollector,
  createKiroEventStreamParser,
  isKiroEventStreamContentType
} from '../../src/main/gateway/kiro-event-stream'
import type { CanonicalStreamEvent } from '../../src/main/gateway/streaming'

describe('Kiro AWS Event Stream parser', () => {
  it('validates frames across byte-sized chunks and converts cumulative text, reasoning, and usage', () => {
    const stream = concat(
      eventFrame('assistantResponseEvent', { content: 'Hel' }),
      eventFrame('reasoningContentEvent', { text: 'Think' }),
      eventFrame('assistantResponseEvent', { content: 'Hello' }),
      eventFrame('reasoningContentEvent', { text: 'Thinking' }),
      eventFrame('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 10,
          cacheReadInputTokens: 2,
          cacheWriteInputTokens: 3,
          outputTokens: 4,
          totalTokens: 19,
          reasoningTokens: 1
        }
      })
    )
    const parser = createKiroEventStreamParser()
    const events: CanonicalStreamEvent[] = []
    for (const byte of stream) events.push(...parser.push(Uint8Array.of(byte)))
    events.push(...parser.finish())

    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' }
    ])
    expect(events.filter((event) => event.type === 'reasoning-progress')).toHaveLength(2)
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 15,
      outputTokens: 4,
      totalTokens: 19,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 3,
      reasoningTokens: 1
    })
    expect(events.slice(-2)).toEqual([
      { type: 'stop', reason: 'stop', rawReason: 'end_turn' },
      { type: 'done' }
    ])
    expect(parser.getRecognizedEventCount()).toBe(5)
  })

  it('filters embedded thinking tags instead of exposing reasoning as answer text', () => {
    const parser = createKiroEventStreamParser()
    const events = [
      ...parser.push(eventFrame('assistantResponseEvent', { content: '<thinking>secret' })),
      ...parser.push(eventFrame('assistantResponseEvent', { content: '<thinking>secret</thinking>Hello' })),
      ...parser.finish()
    ]

    expect(events.filter((event) => event.type === 'reasoning-progress')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Hello' }
    ])
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('preserves first-seen order for interleaved tool IDs', () => {
    const parser = createKiroEventStreamParser({ declaredToolNames: ['first', 'second'] })
    const events = [
      ...parser.push(concat(
        eventFrame('toolUseEvent', { toolUseId: 'tool-a', name: 'first' }),
        eventFrame('toolUseEvent', { toolUseId: 'tool-b', name: 'second' }),
        eventFrame('toolUseEvent', { toolUseId: 'tool-b', input: '{"value":2}', stop: true }),
        eventFrame('toolUseEvent', { toolUseId: 'tool-a', input: '{"value":1}', stop: true })
      )),
      ...parser.finish()
    ]

    expect(events.filter((event) => event.type === 'tool-call-delta')).toEqual([
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'tool-a',
        name: 'first',
        arguments: '{"value":1}'
      },
      {
        type: 'tool-call-delta',
        index: 1,
        id: 'tool-b',
        name: 'second',
        arguments: '{"value":2}'
      }
    ])
    expect(events.filter((event) => event.type === 'tool-call-complete')).toEqual([
      { type: 'tool-call-complete', index: 0 },
      { type: 'tool-call-complete', index: 1 }
    ])
    expect(events.slice(-2)).toEqual([
      { type: 'stop', reason: 'tool_calls', rawReason: 'tool_use' },
      { type: 'done' }
    ])
  })

  it('accepts JSON fragments but rejects undeclared tools and name changes', () => {
    const valid = createKiroEventStreamParser({ declaredToolNames: ['exec'] })
    const validEvents = [
      ...valid.push(concat(
        eventFrame('toolUseEvent', { toolUseId: 'tool-1', name: 'exec', input: '{"cmd":' }),
        eventFrame('toolUseEvent', { toolUseId: 'tool-1', input: '"pwd"}', stop: true })
      )),
      ...valid.finish()
    ]
    expect(validEvents).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      arguments: '{"cmd":"pwd"}'
    }))

    const undeclared = createKiroEventStreamParser({ declaredToolNames: ['read'] })
    const undeclaredEvents = undeclared.push(eventFrame('toolUseEvent', {
      toolUseId: 'tool-2', name: 'write', input: {}, stop: true
    }))
    expect(errorCode(undeclaredEvents)).toBe('kiro_tool_undeclared')

    const renamed = createKiroEventStreamParser({ declaredToolNames: ['read', 'write'] })
    renamed.push(eventFrame('toolUseEvent', { toolUseId: 'tool-3', name: 'read' }))
    const renamedEvents = renamed.push(eventFrame('toolUseEvent', { toolUseId: 'tool-3', name: 'write' }))
    expect(errorCode(renamedEvents)).toBe('kiro_tool_name_changed')
  })

  it('validates completed tool inputs against the original declared schema before forwarding', () => {
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'run' },
        mode: { type: 'string', enum: ['safe', 'fast'] },
        target: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 5 },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['action', 'mode', 'target', 'count', 'tags'],
      additionalProperties: false,
    }
    const valid = createKiroEventStreamParser({
      declaredTools: [{ name: 'exec', inputSchema: schema }],
    })
    const validEvents = valid.push(eventFrame('toolUseEvent', {
      toolUseId: 'valid',
      name: 'exec',
      input: { action: 'run', mode: 'safe', target: 'repo', count: 2, tags: ['a', 'b'] },
      stop: true,
    }))
    expect(validEvents).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      id: 'valid',
    }))

    const invalidInputs = [
      { mode: 'safe', target: 'repo', count: 2, tags: ['a'] },
      { action: 'stop', mode: 'safe', target: 'repo', count: 2, tags: ['a'] },
      { action: 'run', mode: 'other', target: 'repo', count: 2, tags: ['a'] },
      { action: 'run', mode: 'safe', target: 'R', count: 2, tags: ['a'] },
      { action: 'run', mode: 'safe', target: 'repo', count: 4, tags: ['a'] },
      { action: 'run', mode: 'safe', target: 'repo', count: 2, tags: [] },
      { action: 'run', mode: 'safe', target: 'repo', count: 2, tags: ['a', 'a'] },
      { action: 'run', mode: 'safe', target: 'repo', count: 2, tags: ['a'], extra: true },
    ]
    for (const [index, input] of invalidInputs.entries()) {
      const parser = createKiroEventStreamParser({
        declaredTools: [{ name: 'exec', inputSchema: schema }],
      })
      const events = parser.push(eventFrame('toolUseEvent', {
        toolUseId: `invalid-${index}`, name: 'exec', input, stop: true,
      }))
      expect(errorCode(events), JSON.stringify(input)).toBe('kiro_tool_input_schema')
      expect(events.some((event) => event.type === 'tool-call-delta')).toBe(false)
    }
  })

  it('fails closed on global, aggregate-input, active, pending, and completed tool limits', () => {
    const declaredTools = ['one', 'two', 'three'].map((name) => ({
      name,
      inputSchema: { type: 'object' },
    }))

    const total = createKiroEventStreamParser({ declaredTools, maxToolCount: 2 })
    total.push(concat(
      eventFrame('toolUseEvent', { toolUseId: 'one', name: 'one' }),
      eventFrame('toolUseEvent', { toolUseId: 'two', name: 'two' }),
    ))
    expect(errorCode(total.push(eventFrame('toolUseEvent', {
      toolUseId: 'three', name: 'three',
    })))).toBe('kiro_tool_count_limit')

    const bytes = createKiroEventStreamParser({ declaredTools, maxTotalToolInputBytes: 5 })
    bytes.push(eventFrame('toolUseEvent', {
      toolUseId: 'one', name: 'one', input: '四',
    }))
    expect(errorCode(bytes.push(eventFrame('toolUseEvent', {
      toolUseId: 'two', name: 'two', input: '四',
    })))).toBe('kiro_tool_input_total_too_large')

    const active = createKiroEventStreamParser({ declaredTools, maxActiveToolCount: 1 })
    active.push(eventFrame('toolUseEvent', { toolUseId: 'one', name: 'one' }))
    expect(errorCode(active.push(eventFrame('toolUseEvent', {
      toolUseId: 'two', name: 'two',
    })))).toBe('kiro_tool_active_limit')

    const pending = createKiroEventStreamParser({ declaredTools, maxPendingToolCount: 1 })
    pending.push(eventFrame('toolUseEvent', { toolUseId: 'one', name: 'one' }))
    pending.push(eventFrame('toolUseEvent', {
      toolUseId: 'two', name: 'two', input: {}, stop: true,
    }))
    expect(errorCode(pending.push(eventFrame('toolUseEvent', {
      toolUseId: 'three', name: 'three', input: {}, stop: true,
    })))).toBe('kiro_tool_pending_limit')

    const completed = createKiroEventStreamParser({
      declaredTools,
      maxCompletedToolCount: 1,
    })
    completed.push(eventFrame('toolUseEvent', {
      toolUseId: 'one', name: 'one', input: {}, stop: true,
    }))
    const completedEvents = completed.push(eventFrame('toolUseEvent', {
      toolUseId: 'two', name: 'two', input: {}, stop: true,
    }))
    expect(errorCode(completedEvents)).toBe('kiro_tool_completed_limit')
    expect(completedEvents.some((event) => (
      event.type === 'tool-call-delta' && event.id === 'two'
    ))).toBe(false)
  })

  it('rejects malformed tool JSON and reused completed IDs', () => {
    const malformed = createKiroEventStreamParser({ declaredToolNames: ['exec'] })
    const malformedEvents = malformed.push(eventFrame('toolUseEvent', {
      toolUseId: 'same', name: 'exec', input: '{', stop: true
    }))
    expect(errorCode(malformedEvents)).toBe('kiro_tool_input_json')

    const reused = createKiroEventStreamParser({ declaredToolNames: ['exec'] })
    reused.push(eventFrame('toolUseEvent', {
      toolUseId: 'same', name: 'exec', input: {}, stop: true
    }))
    const reusedEvents = reused.push(eventFrame('toolUseEvent', {
      toolUseId: 'same', name: 'exec', input: {}, stop: true
    }))
    expect(errorCode(reusedEvents)).toBe('kiro_tool_id_reused')
  })

  it('recovers only a complete empty-argument tool at EOF', () => {
    const recovered = createKiroEventStreamParser({ declaredToolNames: ['ExitPlanMode'] })
    recovered.push(eventFrame('toolUseEvent', {
      toolUseId: 'exit-1', name: 'ExitPlanMode', input: '{}'
    }))
    const recoveredEvents = recovered.finish()
    expect(recoveredEvents).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      id: 'exit-1',
      arguments: '{}'
    }))
    expect(recovered.getDiagnostics().structuralRecoveryCount).toBe(1)

    const rejected = createKiroEventStreamParser({ declaredToolNames: ['exec'] })
    rejected.push(eventFrame('toolUseEvent', {
      toolUseId: 'exec-1', name: 'exec', input: { cmd: 'pwd' }
    }))
    expect(errorCode(rejected.finish())).toBe('kiro_tool_stop_missing')
    expect(rejected.getDiagnostics().structuralRecoveryCount).toBe(0)
  })

  it('maps invalidState and exception frames to terminal canonical errors', () => {
    const invalid = createKiroEventStreamParser()
    const invalidEvents = invalid.push(eventFrame('invalidStateEvent', {
      reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
      message: 'too long'
    }))
    expect(invalidEvents).toEqual([
      {
        type: 'error',
        message: 'too long',
        code: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
        errorType: 'kiro_invalid_state'
      },
      { type: 'stop', reason: 'error', rawReason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' },
      { type: 'done' }
    ])
    expect(invalid.getDiagnostics().invalidStateReason).toBe('CONTENT_LENGTH_EXCEEDS_THRESHOLD')

    const exception = createKiroEventStreamParser()
    const exceptionEvents = exception.push(exceptionFrame('ThrottlingException', { message: 'slow down' }))
    expect(errorCode(exceptionEvents)).toBe('ThrottlingException')
    expect(exceptionEvents[0]).toEqual(expect.objectContaining({ errorType: 'kiro_exception' }))
  })

  it('rejects invalid CRCs, oversized frames, malformed headers, and truncation', () => {
    const preludeCrc = eventFrame('assistantResponseEvent', { content: 'ok' })
    preludeCrc[8] ^= 0xff
    const preludeParser = createKiroEventStreamParser()
    expect(errorCode(preludeParser.push(preludeCrc))).toBe('kiro_event_stream_prelude_crc')

    const messageCrc = eventFrame('assistantResponseEvent', { content: 'ok' })
    messageCrc[messageCrc.length - 5] ^= 0xff
    const messageParser = createKiroEventStreamParser()
    expect(errorCode(messageParser.push(messageCrc))).toBe('kiro_event_stream_message_crc')

    const oversizedParser = createKiroEventStreamParser({ maxFrameBytes: 64 })
    expect(errorCode(oversizedParser.push(preludeOnly(65, 0)))).toBe('kiro_event_stream_frame_too_large')

    const malformedHeaderParser = createKiroEventStreamParser()
    expect(errorCode(malformedHeaderParser.push(assembleFrame(
      Uint8Array.of(1, 0x78, 99),
      jsonBytes({})
    )))).toBe('kiro_event_stream_header_type')

    const truncatedParser = createKiroEventStreamParser()
    truncatedParser.push(eventFrame('assistantResponseEvent', { content: 'ok' }).subarray(0, 7))
    expect(errorCode(truncatedParser.finish())).toBe('kiro_event_stream_truncated')
  })

  it('collects a non-streaming result without retaining raw frames or tool fragments', () => {
    const collector = createKiroEventStreamCollector({ declaredToolNames: ['lookup'] })
    collector.push(concat(
      eventFrame('assistantResponseEvent', { content: 'Checking' }),
      eventFrame('toolUseEvent', {
        toolUseId: 'lookup-1', name: 'lookup', input: { query: 'safe' }, stop: true
      }),
      eventFrame('meteringEvent', { inputTokens: 5, outputTokens: 2 })
    ))
    expect(collector.isComplete()).toBe(false)
    const result = collector.finish()

    expect(result).toEqual({
      text: 'Checking',
      tools: [{ index: 0, id: 'lookup-1', name: 'lookup', input: { query: 'safe' } }],
      usage: { type: 'usage', inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      stopReason: 'tool_calls',
      structuralRecoveryCount: 0,
      recognizedEventCount: 3,
      error: undefined
    })
    expect(collector.isComplete()).toBe(true)
  })

  it('recognizes only the AWS Event Stream response media type', () => {
    expect(isKiroEventStreamContentType('application/vnd.amazon.eventstream')).toBe(true)
    expect(isKiroEventStreamContentType('Application/VND.Amazon.EventStream; charset=utf-8')).toBe(true)
    expect(isKiroEventStreamContentType('application/json')).toBe(false)
    expect(isKiroEventStreamContentType(undefined)).toBe(false)
  })

  it('accepts an empty initial-response payload without weakening meaningful event validation', () => {
    const parser = createKiroEventStreamParser()
    const initialFrame = assembleFrame(concat(
      stringHeader(':message-type', 'event'),
      stringHeader(':event-type', 'initial-response'),
      stringHeader(':content-type', 'application/json')
    ), new Uint8Array())
    expect(parser.push(initialFrame)).toEqual([])
    expect(parser.finish()).toEqual([
      { type: 'stop', reason: 'stop', rawReason: 'end_turn' },
      { type: 'done' }
    ])
    expect(parser.getRecognizedEventCount()).toBe(1)
  })

  it('fails closed when every Event Stream frame is unknown', () => {
    const parser = createKiroEventStreamParser()
    expect(parser.push(eventFrame('futureUnknownEvent', { value: true }))).toEqual([])
    expect(errorCode(parser.finish())).toBe('kiro_event_stream_unrecognized')
  })

  it('collects a web response body without requiring callers to duplicate reader plumbing', async () => {
    const frame = eventFrame('assistantResponseEvent', { content: 'ready' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.subarray(0, 9))
        controller.enqueue(frame.subarray(9))
        controller.close()
      }
    })
    await expect(collectKiroEventStreamBody(body)).resolves.toEqual(expect.objectContaining({
      text: 'ready',
      stopReason: 'stop',
      error: undefined
    }))
  })
})

function errorCode(events: CanonicalStreamEvent[]): string | undefined {
  return events.find((event) => event.type === 'error')?.code
}

function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return assembleFrame(concat(
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', eventType),
    stringHeader(':content-type', 'application/json')
  ), jsonBytes(payload))
}

function exceptionFrame(exceptionType: string, payload: unknown): Uint8Array {
  return assembleFrame(concat(
    stringHeader(':message-type', 'exception'),
    stringHeader(':exception-type', exceptionType),
    stringHeader(':content-type', 'application/json')
  ), jsonBytes(payload))
}

function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const valueBytes = new TextEncoder().encode(value)
  return concat(
    Uint8Array.of(nameBytes.length),
    nameBytes,
    Uint8Array.of(7, valueBytes.length >>> 8, valueBytes.length & 0xff),
    valueBytes
  )
}

function assembleFrame(headers: Uint8Array, payload: Uint8Array): Uint8Array {
  const totalLength = 12 + headers.byteLength + payload.byteLength + 4
  const prelude = new Uint8Array(12)
  writeUint32(prelude, 0, totalLength)
  writeUint32(prelude, 4, headers.byteLength)
  writeUint32(prelude, 8, crc32(prelude.subarray(0, 8)))
  const withoutMessageCrc = concat(prelude, headers, payload)
  const messageCrc = new Uint8Array(4)
  writeUint32(messageCrc, 0, crc32(withoutMessageCrc))
  return concat(withoutMessageCrc, messageCrc)
}

function preludeOnly(totalLength: number, headersLength: number): Uint8Array {
  const prelude = new Uint8Array(12)
  writeUint32(prelude, 0, totalLength)
  writeUint32(prelude, 4, headersLength)
  writeUint32(prelude, 8, crc32(prelude.subarray(0, 8)))
  return prelude
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
