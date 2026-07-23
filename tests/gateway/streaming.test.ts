import { describe, expect, it } from 'vitest'
import type { Protocol } from '../../src/shared/types'
import {
  createCanonicalStreamEncoder,
  createCanonicalStreamParser,
  createOpenAiResponsesStreamCollector,
  createProtocolStreamTransform,
  type CanonicalStreamEvent
} from '../../src/main/gateway'

const encoder = new TextEncoder()

const anthropicRecording = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"id":"msg_recorded","model":"claude-recorded","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好，"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我来查询。"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_weather","name":"get_weather","input":{}}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"京\\"}"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n'
].join('')

const responsesRecording = [
  'event: response.created\n',
  'data: {"type":"response.created","response":{"id":"resp_recorded","model":"gpt-recorded","created_at":1700000000,"status":"in_progress","output":[]}}\n\n',
  'event: response.output_item.added\n',
  'data: {"type":"response.output_item.added","response_id":"resp_recorded","output_index":0,"item":{"id":"fc_recorded","type":"function_call","call_id":"call_weather","name":"get_weather","arguments":""}}\n\n',
  'event: response.function_call_arguments.delta\n',
  'data: {"type":"response.function_call_arguments.delta","response_id":"resp_recorded","item_id":"fc_recorded","output_index":0,"delta":"{\\"city\\":"}\n\n',
  'event: response.function_call_arguments.delta\n',
  'data: {"type":"response.function_call_arguments.delta","response_id":"resp_recorded","item_id":"fc_recorded","output_index":0,"delta":"\\"深圳\\"}"}\n\n',
  'event: response.completed\n',
  'data: {"type":"response.completed","response":{"id":"resp_recorded","model":"gpt-recorded","status":"completed","output":[{"id":"fc_recorded","type":"function_call","call_id":"call_weather","name":"get_weather","arguments":"{\\"city\\":\\"深圳\\"}"}],"usage":{"input_tokens":8,"output_tokens":5,"total_tokens":13}}}\n\n'
].join('')

const geminiJsonRecording = JSON.stringify([
  {
    candidates: [{ content: { role: 'model', parts: [{ text: '天气查询：' }] } }],
    modelVersion: 'gemini-recorded'
  },
  {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ functionCall: { id: 'gemini_call', name: 'get_weather', args: { city: '上海' } } }]
      },
      finishReason: 'STOP'
    }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
    modelVersion: 'gemini-recorded'
  }
])

describe('canonical streaming protocol conversion', () => {
  it('captures cached input and reasoning token details from Responses usage', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":12}}}}\n\n'
    ))
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 80,
      reasoningTokens: 12
    })
  })

  it('rebuilds Responses usage with nested token details only', () => {
    const collector = createOpenAiResponsesStreamCollector()
    collector.push(encoder.encode(
      'data: {"type":"response.completed","response":{"id":"resp_usage","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":12}}}}\n\n'
    ))
    expect(collector.isComplete()).toBe(true)
    const usage = collector.finish().response?.usage as Record<string, unknown>
    expect(usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 12 }
    })
    expect(usage).not.toHaveProperty('cached_input_tokens')
    expect(usage).not.toHaveProperty('reasoning_tokens')
  })

  it('collects a chunked Responses stream into one ordinary response', () => {
    const collector = createOpenAiResponsesStreamCollector({ model: 'gpt-fallback', now: () => 1_700_000_000_000 })
    const recording = [
      'data: {"type":"response.created","response":{"id":"resp_collected","model":"gpt-collected","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_collected","object":"response","model":"gpt-collected","status":"completed","output":[],"usage":{"input_tokens":6,"output_tokens":2,"total_tokens":8}}}\n\n'
    ].join('')
    for (const chunk of byteChunks(recording, 3)) collector.push(chunk)
    const result = collector.finish()
    expect(result.error).toBeUndefined()
    expect(result.response).toMatchObject({
      id: 'resp_collected', object: 'response', model: 'gpt-collected', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 }
    })
  })

  it('collects relay Responses text when only output_text.done carries the summary', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-done-only' })
    collector.push(encoder.encode([
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Done-only relay summary"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-done-only","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      output: [{ content: [{ type: 'output_text', text: 'Done-only relay summary' }] }]
    })
  })

  it('preserves streamed text when a relay terminal contains only reasoning output', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-reasoning-terminal' })
    collector.push(encoder.encode([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Streamed summary"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":1,"content_index":0,"text":"Streamed summary"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-reasoning-terminal","status":"completed","output":[{"type":"reasoning","summary":[]}]}}',
      '',
      ''
    ].join('\n')))

    const response = collector.finish().response!
    expect(JSON.stringify(response)).toContain('Streamed summary')
    expect(JSON.stringify(response).match(/Streamed summary/g)).toHaveLength(1)
    expect(response.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning' })]))
  })

  it('collects standalone usage events and ignores replayed sequenced text deltas', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-sequence-dedup' })
    collector.push(encoder.encode([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","sequence_number":4,"output_index":0,"content_index":0,"delta":"Once"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","sequence_number":4,"output_index":0,"content_index":0,"delta":"Once"}',
      '',
      'event: response.usage.updated',
      'data: {"type":"response.usage.updated","sequence_number":5,"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","sequence_number":6,"response":{"id":"resp-sequence-dedup","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      output: [{ content: [{ text: 'Once' }] }],
      usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 }
    })
  })

  it('stops parsing events after a Responses terminal and reuses its complete output', () => {
    const collector = createOpenAiResponsesStreamCollector()
    collector.push(encoder.encode([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"terminal"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
      // A malformed trailer must not be decoded/parsed after the definitive
      // terminal event, nor overwrite output assembled by that terminal.
      'event: response.output_text.delta',
      'data: {not-json',
      '',
      ''
    ].join('\n')))

    expect(collector.isComplete()).toBe(true)
    expect(collector.finish()).toMatchObject({
      response: {
        id: 'resp_terminal',
        status: 'completed',
        output: [{ content: [{ text: 'terminal' }] }]
      }
    })
  })

  it('marks completed Responses function-call arguments before response.completed', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_health","name":"check_health","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"scope\\":\\"p0\\"}"}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"scope\\":\\"p0\\"}"}',
      '',
      ''
    ].join('\n')))

    expect(events).toContainEqual({ type: 'tool-call-complete', index: 0 })
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }))
  })

  it('normalizes completed Responses custom-tool input before response.completed', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","call_id":"call_exec","name":"exec","input":""}}',
      '',
      'event: response.custom_tool_call_input.delta',
      'data: {"type":"response.custom_tool_call_input.delta","output_index":0,"delta":"Get-ChildItem"}',
      '',
      'event: response.custom_tool_call_input.done',
      'data: {"type":"response.custom_tool_call_input.done","output_index":0,"input":"Get-ChildItem"}',
      '',
      ''
    ].join('\n')))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      index: 0,
      name: 'exec'
    }))
    expect(events).toContainEqual({ type: 'tool-call-complete', index: 0 })
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }))
  })

  it('marks a completed Responses assistant message before response.completed', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_health","type":"message","role":"assistant","status":"in_progress","content":[]}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Done"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_health","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done"}]}}',
      '',
      ''
    ].join('\n')))

    expect(events).toContainEqual({ type: 'message-complete', index: 1 })
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }))
  })

  it('rejects a Responses stream without a terminal response', () => {
    const collector = createOpenAiResponsesStreamCollector()
    collector.push(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))
    expect(collector.isComplete()).toBe(false)
    expect(collector.finish()).toMatchObject({ error: expect.stringContaining('before a stop or done event') })
  })
  it.each([
    ['an empty stream', ''],
    [
      'a stream truncated after content',
      'data: {"id":"chat_truncated","model":"gpt-recorded","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
    ]
  ])('marks %s as incomplete instead of synthesizing success', (_label, recording) => {
    const events = parseChunks('openai-chat', byteChunks(recording, 3))
    expect(events.slice(-3)).toEqual([
      {
        type: 'error',
        message: 'Stream ended before a stop or done event',
        errorType: 'incomplete_stream'
      },
      { type: 'stop', reason: 'error', rawReason: 'incomplete_stream' },
      { type: 'done' }
    ])
  })

  it('allows clean EOF to supply done after a valid stop', () => {
    const recording = 'data: {"id":"chat_stopped","model":"gpt-recorded","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    const events = parseChunks('openai-chat', byteChunks(recording, 2))
    expect(events.at(-2)).toEqual({ type: 'stop', reason: 'stop', rawReason: 'stop' })
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }))
  })

  it('classifies a payload cut mid-JSON as an incomplete stream', () => {
    const events = parseChunks('openai-chat', byteChunks('data: {"id":"cut', 1))
    expect(events.at(-3)).toMatchObject({ type: 'error', errorType: 'incomplete_stream' })
    expect(events.at(-2)).toEqual({ type: 'stop', reason: 'error', rawReason: 'incomplete_stream' })
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('gives an id-less Gemini function call a stable valid Chat tool-call ID', async () => {
    const recording = JSON.stringify({
      responseId: 'gemini_stream',
      modelVersion: 'gemini-recorded',
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: '北京' } } }]
        },
        finishReason: 'STOP'
      }]
    })

    const output = await transcode('gemini', 'openai-chat', recording)
    const wire = new TextDecoder().decode(output)
    const chunks = wire
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const toolChunk = chunks.find((chunk) => {
      const choices = chunk.choices as Array<{ delta?: { tool_calls?: unknown[] } }> | undefined
      return Boolean(choices?.[0]?.delta?.tool_calls)
    }) as { choices: Array<{ delta: { tool_calls: Array<Record<string, unknown>> } }> }
    const toolCall = toolChunk.choices[0].delta.tool_calls[0]

    expect(toolCall).toMatchObject({
      index: 0,
      id: 'call_gemini_stream_0',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"北京"}' }
    })
    expect(summarize(parseChunks('openai-chat', byteChunks(output, 1))).tools[0].id)
      .toBe('call_gemini_stream_0')
  })

  it('emits a synthesized Chat tool ID only on the first delta for that index', () => {
    const streamEncoder = createCanonicalStreamEncoder('openai-chat', {
      id: 'stable.stream',
      model: 'gpt-recorded',
      now: () => 1_700_000_000_000
    })
    const output = [
      ...streamEncoder.encode({ type: 'tool-call-delta', index: 2, name: 'lookup', arguments: '{"id":' }),
      ...streamEncoder.encode({ type: 'tool-call-delta', index: 2, arguments: '7}' }),
      ...streamEncoder.encode({ type: 'stop', reason: 'tool_calls' }),
      ...streamEncoder.encode({ type: 'done' })
    ]
    const wire = new TextDecoder().decode(joinBytes(output))
    const calls = wire
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as {
        choices?: Array<{ delta?: { tool_calls?: Array<Record<string, unknown>> } }>
      })
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ index: 2, id: 'call_stable_stream_2', type: 'function' })
    expect(calls[1]).toMatchObject({ index: 2, function: { arguments: '7}' } })
    expect(calls[1]).not.toHaveProperty('id')
    expect(calls[1]).not.toHaveProperty('type')
  })

  it('parses OpenAI Chat SSE across arbitrary chunks, UTF-8 boundaries, usage and [DONE]', () => {
    const recording = [
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"北"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"京\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"id":"chat_recorded","object":"chat.completion.chunk","created":1700000000,"model":"gpt-recorded","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}\n\n',
      'data: [DONE]\n\n'
    ].join('')

    const events = parseChunks('openai-chat', byteChunks(recording, 1))

    expect(events).toEqual([
      { type: 'start', id: 'chat_recorded', model: 'gpt-recorded', createdAt: 1_700_000_000_000 },
      { type: 'text-delta', text: '你' },
      { type: 'text-delta', text: '好' },
      { type: 'tool-call-delta', index: 0, id: 'call_weather', name: 'get_weather', arguments: '{"city":"北' },
      { type: 'tool-call-delta', index: 0, arguments: '京"}' },
      { type: 'stop', reason: 'tool_calls', rawReason: 'tool_calls' },
      { type: 'usage', inputTokens: 10, outputTokens: 6, totalTokens: 16 },
      { type: 'done' }
    ])
  })

  it('tracks exact Responses terminal metadata across CRLF fragments and event-name fallback', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const wire = [
      'event: response.output_item.done\r\n',
      'data: {"sequence_number":41,"output_index":0,"item":{"type":"message","status":"completed"}}\r\n\r\n',
      'event: response.completed\r\n',
      'data: {"sequence_number":42,"response":{"status":"completed","output":[]}}\r\n\r\n'
    ].join('')
    const events = byteChunks(wire, 3).flatMap((chunk) => parser.push(chunk))

    expect(events).toContainEqual({ type: 'message-complete', index: 0 })
    expect(parser.getProtocolState()).toEqual({
      responsesEventCount: 2,
      responsesProgressEventCount: 2,
      responsesTerminalEvent: 'response.completed',
      responsesLastEventType: 'response.completed',
      responsesLastSequenceNumber: 42
    })
  })

  it.each([
    ['response.completed', 'response.completed'],
    ['response.incomplete', 'response.incomplete'],
    ['response.failed', 'response.failed']
  ] as const)('recognizes %s as an exact Responses terminal event', (eventType, expected) => {
    const parser = createCanonicalStreamParser('openai-responses')
    const response = eventType === 'response.failed'
      ? { status: 'failed', error: { message: 'failed' }, output: [] }
      : { output: [] }
    parser.push(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify({
      type: eventType,
      sequence_number: 7,
      response
    })}\n\n`))
    expect(parser.getProtocolState().responsesTerminalEvent).toBe(expected)
  })

  it('does not treat output_item.done or the non-standard [DONE] sentinel as Responses completion', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode([
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","sequence_number":9,"output_index":0,"item":{"type":"message","status":"completed"}}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n')))

    expect(events).not.toContainEqual({ type: 'done' })
    expect(parser.getProtocolState()).toEqual({
      responsesEventCount: 1,
      responsesProgressEventCount: 1,
      responsesTerminalEvent: undefined,
      responsesLastEventType: '[DONE]',
      responsesLastSequenceNumber: 9
    })
  })

  it('tracks Responses protocol progress without counting lifecycle frames or heartbeats', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const wire = [
      'event: response.queued\ndata: {"type":"response.queued","sequence_number":1}\n\n',
      'event: response.created\ndata: {"type":"response.created","sequence_number":2,"response":{"id":"resp_progress","status":"queued"}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":3,"response":{"id":"resp_progress","status":"in_progress"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: heartbeat\ndata: {"type":"heartbeat"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"delta":"checking"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":5,"delta":"answer"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":6,"output_index":0,"delta":"{}"}\n\n',
      'event: response.usage.updated\ndata: {"type":"response.usage.updated","sequence_number":7,"usage":{"output_tokens":1}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":8,"response":{"status":"completed","output":[]}}\n\n'
    ].join('')

    for (const chunk of byteChunks(wire, 5)) parser.push(chunk)

    expect(parser.getProtocolState()).toEqual({
      responsesEventCount: 10,
      responsesProgressEventCount: 5,
      responsesTerminalEvent: 'response.completed',
      responsesLastEventType: 'response.completed',
      responsesLastSequenceNumber: 8
    })
  })

  it('counts only valid, changed and strictly sequenced Responses progress', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const wire = [
      'event: response.queued\ndata: {"type":"response.queued","sequence_number":1}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":50,"delta":""}\n\n',
      'event: response.usage.updated\ndata: {"type":"response.usage.updated","sequence_number":2,"usage":{"output_tokens":1}}\n\n',
      'event: response.usage.updated\ndata: {"type":"response.usage.updated","sequence_number":3,"usage":{"output_tokens":1}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"delta":"x"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"delta":"replay"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":5,"response":{"status":"completed","output":[]}}\n\n'
    ].join('')

    parser.push(encoder.encode(wire))

    expect(parser.getProtocolState()).toMatchObject({
      responsesProgressEventCount: 3,
      responsesLastSequenceNumber: 5,
      responsesTerminalEvent: 'response.completed'
    })
  })

  it('transcodes a recorded Anthropic stream to OpenAI Chat', async () => {
    const output = await transcode('anthropic-messages', 'openai-chat', anthropicRecording)
    const summary = summarize(parseChunks('openai-chat', byteChunks(output, 7)))

    expect(summary).toEqual({
      text: '你好，我来查询。',
      tools: [{ index: 0, id: 'toolu_weather', name: 'get_weather', arguments: '{"city":"北京"}' }],
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
      stop: 'tool_calls',
      done: true,
      errors: []
    })
    expect(new TextDecoder().decode(output)).toContain('data: [DONE]')
  })

  it('encodes a recorded Anthropic stream as valid Responses events', async () => {
    const output = await transcode('anthropic-messages', 'openai-responses', anthropicRecording)
    const wire = new TextDecoder().decode(output)
    const summary = summarize(parseChunks('openai-responses', byteChunks(output, 4)))

    expect(wire).toContain('event: response.output_item.added')
    expect(wire).toContain('event: response.function_call_arguments.delta')
    expect(wire).toContain('event: response.completed')
    expect(summary).toEqual({
      text: '你好，我来查询。',
      tools: [{ index: 0, id: 'toolu_weather', name: 'get_weather', arguments: '{"city":"北京"}' }],
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
      stop: 'tool_calls',
      done: true,
      errors: []
    })
  })

  it('retains Chat usage that arrives after finish_reason when encoding Responses', async () => {
    const recording = [
      'data: {"id":"chat_usage","model":"gpt-recorded","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_usage","model":"gpt-recorded","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chat_usage","model":"gpt-recorded","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23}}\n\n',
      'data: [DONE]\n\n'
    ].join('')

    const output = await transcode('openai-chat', 'openai-responses', recording)
    const summary = summarize(parseChunks('openai-responses', byteChunks(output, 2)))
    expect(summary.usage).toEqual({ inputTokens: 20, outputTokens: 3, totalTokens: 23 })
    expect(summary.stop).toBe('stop')
  })

  it('transcodes a recorded Responses stream to Gemini and keeps tool arguments', async () => {
    const output = await transcode('openai-responses', 'gemini', responsesRecording)
    const summary = summarize(parseChunks('gemini', byteChunks(output, 3)))

    expect(summary).toEqual({
      text: '',
      tools: [{ index: 0, id: 'call_weather', name: 'get_weather', arguments: '{"city":"深圳"}' }],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      stop: 'tool_calls',
      done: true,
      errors: []
    })
  })

  it('parses chunked Gemini JSON and transcodes it to Anthropic SSE', async () => {
    const parsed = summarize(parseChunks('gemini', byteChunks(geminiJsonRecording, 1)))
    expect(parsed.text).toBe('天气查询：')
    expect(parsed.tools).toEqual([
      { index: 0, id: 'gemini_call', name: 'get_weather', arguments: '{"city":"上海"}' }
    ])
    expect(parsed.usage).toEqual({ inputTokens: 7, outputTokens: 4, totalTokens: 11 })

    const output = await transcode('gemini', 'anthropic-messages', geminiJsonRecording)
    const summary = summarize(parseChunks('anthropic-messages', byteChunks(output, 5)))
    expect(summary).toEqual({
      text: '天气查询：',
      tools: [{ index: 0, id: 'gemini_call', name: 'get_weather', arguments: '{"city":"上海"}' }],
      usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      stop: 'tool_calls',
      done: true,
      errors: []
    })
  })

  it.each([
    ['openai-chat', 'data: {"error":{"message":"chat failed","type":"server_error","code":"E_CHAT"}}\n\n'],
    ['openai-responses', 'event: error\ndata: {"type":"error","message":"responses failed","code":"E_RESP"}\n\n'],
    ['anthropic-messages', 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"anthropic failed"}}\n\n'],
    ['gemini', '{"error":{"code":"E_GEMINI","message":"gemini failed","status":"UNAVAILABLE"}}']
  ] as const)('normalizes %s streaming errors', (protocol, recording) => {
    const events = parseChunks(protocol, byteChunks(recording, 2))
    expect(events.find((event) => event.type === 'error')).toMatchObject({ type: 'error' })
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('does not append a normal Anthropic completion after a streaming error', async () => {
    const output = await transcode(
      'openai-chat',
      'anthropic-messages',
      'data: {"error":{"message":"upstream failed","type":"server_error"}}\n\n'
    )
    const wire = new TextDecoder().decode(output)
    expect(wire).toContain('event: error')
    expect(wire).not.toContain('event: message_delta')
    expect(wire).not.toContain('event: message_stop')
  })

  it('preserves Responses content-filter termination in the canonical stream', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode(
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n'
    ))

    expect(events).toContainEqual({ type: 'stop', reason: 'content_filter', rawReason: 'content_filter' })
    expect(events).toContainEqual({ type: 'done' })
  })

  it('collects incomplete Responses output with matching item status', () => {
    const collector = createOpenAiResponsesStreamCollector({
      id: 'resp-collected-incomplete',
      model: 'model-test',
      now: () => 1_700_000_000_000
    })
    collector.push(encoder.encode([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [{ type: 'message', status: 'incomplete' }]
    })
  })

  it('keeps a completed function call completed when the overall Responses result is incomplete', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-tools', model: 'model-test' })
    collector.push(encoder.encode([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","sequence_number":2,"output_index":0,"arguments":"{}"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","sequence_number":3,"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      status: 'incomplete',
      output: [{ type: 'function_call', status: 'completed', call_id: 'call_1' }]
    })

    const streamEncoder = createCanonicalStreamEncoder('openai-responses', {
      id: 'resp-tools', model: 'model-test'
    })
    const frames = [
      ...streamEncoder.encode({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'lookup', arguments: '{}' }),
      ...streamEncoder.encode({ type: 'tool-call-complete', index: 0 }),
      ...streamEncoder.encode({ type: 'stop', reason: 'length' }),
      ...streamEncoder.encode({ type: 'done' })
    ]
    const wire = new TextDecoder().decode(Buffer.concat(frames.map((frame) => Buffer.from(frame))))
    const terminalMatch = /event: response\.incomplete\ndata: ([^\n]+)/.exec(wire)
    const terminal = JSON.parse(terminalMatch?.[1] ?? '{}') as {
      response?: { output?: Array<{ type?: string; status?: string }> }
    }
    expect(terminal.response?.output).toContainEqual(expect.objectContaining({
      type: 'function_call', status: 'completed'
    }))
  })

  it('encodes Responses content filtering as response.incomplete', () => {
    const streamEncoder = createCanonicalStreamEncoder('openai-responses', {
      id: 'resp-test',
      model: 'model-test',
      now: () => 1_700_000_000_000
    })
    const wire = [
      ...streamEncoder.encode({ type: 'start', id: 'resp-test', model: 'model-test' }),
      ...streamEncoder.encode({ type: 'text-delta', text: 'partial' }),
      ...streamEncoder.encode({ type: 'stop', reason: 'content_filter' }),
      ...streamEncoder.encode({ type: 'done' })
    ]
    const text = new TextDecoder().decode(Buffer.concat(wire.map((chunk) => Buffer.from(chunk))))

    expect(text).toContain('event: response.incomplete')
    expect(text).toContain('"reason":"content_filter"')
    expect(text).not.toContain('event: response.completed')
    const terminalMatch = /event: response\.incomplete\ndata: ([^\n]+)/.exec(text)
    const terminal = JSON.parse(terminalMatch?.[1] ?? '{}') as {
      response?: { status?: string; output?: Array<{ status?: string }> }
    }
    expect(terminal.response?.status).toBe('incomplete')
    expect(terminal.response?.output?.[0]?.status).toBe('incomplete')
  })

  it('does not emit a normal Chat stop frame after a streaming error', () => {
    const streamEncoder = createCanonicalStreamEncoder('openai-chat', {
      id: 'chat-test',
      model: 'model-test',
      now: () => 1_700_000_000_000
    })
    const wire = [
      ...streamEncoder.encode({ type: 'error', message: 'upstream failed', errorType: 'upstream_stream_error' }),
      ...streamEncoder.encode({ type: 'stop', reason: 'error' }),
      ...streamEncoder.encode({ type: 'done' })
    ]
    const text = new TextDecoder().decode(Buffer.concat(wire.map((chunk) => Buffer.from(chunk))))

    expect(text).toContain('"error"')
    expect(text).not.toContain('"finish_reason":"stop"')
  })

  it('does not publish an ignored out-of-order Responses terminal as protocol completion', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    parser.push(encoder.encode(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":10,"output_index":0,"content_index":0,"delta":"partial"}\n\n'
    ))

    const terminalEvents = parser.push(encoder.encode(
      'event: response.failed\ndata: {"type":"response.failed","sequence_number":9,"response":{"status":"failed","error":{"message":"late failure","type":"server_error"}}}\n\n'
    ))

    expect(terminalEvents).toEqual([])
    expect(parser.getProtocolState()).toMatchObject({
      responsesTerminalEvent: undefined,
      responsesLastSequenceNumber: 10
    })
  })

  it.each([
    ['null', 'null'],
    ['a numeric string', '"11"'],
    ['a negative integer', '-1'],
    ['a fractional number', '11.5']
  ])('fails closed when a recognized Responses event has %s sequence_number', (_label, sequence) => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode(
      `event: response.completed\ndata: {"type":"response.completed","sequence_number":${sequence},"response":{"status":"completed","output":[]}}\n\n`
    ))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'invalid_sequence_number'
    }))
    expect(events).toContainEqual({
      type: 'stop', reason: 'error', rawReason: 'invalid_sequence_number'
    })
    expect(events).toContainEqual({ type: 'done' })
    expect(parser.getProtocolState().responsesTerminalEvent).toBeUndefined()
  })

  it('keeps an explicitly incomplete Responses function call incomplete', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-incomplete-tool' })
    collector.push(encoder.encode([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_partial","name":"lookup","arguments":"{\\"q\\":"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","status":"incomplete","call_id":"call_partial","name":"lookup","arguments":"{\\"q\\":"}}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      status: 'incomplete',
      output: [{
        type: 'function_call',
        status: 'incomplete',
        call_id: 'call_partial',
        arguments: '{"q":'
      }]
    })
  })

  it('tracks Responses message completion per output index', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-multi-message' })
    collector.push(encoder.encode([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"complete"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","status":"completed"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"partial"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      status: 'incomplete',
      output: [
        { type: 'message', status: 'completed', content: [{ text: 'complete' }] },
        { type: 'message', status: 'incomplete', content: [{ text: 'partial' }] }
      ]
    })
  })

  it('does not mark merged encoded Responses text complete while any source message is partial', () => {
    const streamEncoder = createCanonicalStreamEncoder('openai-responses', {
      id: 'resp-encoded-multi-message',
      model: 'model-test'
    })
    const frames = [
      ...streamEncoder.encode({ type: 'text-delta', text: 'complete', index: 0 }),
      ...streamEncoder.encode({ type: 'message-complete', index: 0 }),
      ...streamEncoder.encode({ type: 'text-delta', text: 'partial', index: 1 }),
      ...streamEncoder.encode({ type: 'stop', reason: 'length' }),
      ...streamEncoder.encode({ type: 'done' })
    ]
    const wire = new TextDecoder().decode(joinBytes(frames))
    const terminalMatch = /event: response\.incomplete\ndata: ([^\n]+)/.exec(wire)
    const terminal = JSON.parse(terminalMatch?.[1] ?? '{}') as {
      response?: { output?: Array<{ type?: string; status?: string }> }
    }

    expect(terminal.response?.output).toContainEqual(expect.objectContaining({
      type: 'message', status: 'incomplete'
    }))
  })

  it('deduplicates replayed unsequenced output_text.done events', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-done-replay' })
    collector.push(encoder.encode([
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Once"}',
      '',
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Once"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(collector.finish().response).toMatchObject({
      output: [{ content: [{ text: 'Once' }] }]
    })
  })

  it('counts a compatibility output item without output_index when it is parsed', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_compat","name":"lookup","arguments":"{}"}}\n\n'
    ))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta', id: 'call_compat', name: 'lookup'
    }))
    expect(parser.getRecognizedEventCount()).toBe(1)
    expect(parser.getProtocolState().responsesProgressEventCount).toBe(1)
  })

  it('bounds one unterminated SSE frame without limiting the total response', () => {
    const oversized = createCanonicalStreamParser('openai-chat', { maxBufferedCharacters: 96 })
    const oversizedEvents = oversized.push(encoder.encode(`data: ${'x'.repeat(100)}`))
    expect(oversizedEvents).toContainEqual(expect.objectContaining({
      type: 'error', errorType: 'frame_too_large'
    }))

    const longResponse = createCanonicalStreamParser('openai-chat', { maxBufferedCharacters: 256 })
    const event = 'data: {"choices":[{"delta":{"content":"abcdefghij"},"finish_reason":null}]}\n\n'
    const chunks = Array.from({ length: 20 }, () => event)
    chunks.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    const events = longResponse.push(encoder.encode(chunks.join('')))
    expect(events.filter((value) => value.type === 'text-delta')).toHaveLength(20)
    expect(events).not.toContainEqual(expect.objectContaining({ errorType: 'frame_too_large' }))
  })

  it('bounds one incomplete Gemini JSON value while accepting many small values', () => {
    const oversized = createCanonicalStreamParser('gemini', { maxBufferedCharacters: 96 })
    const oversizedEvents = oversized.push(encoder.encode(
      `{"candidates":[{"content":{"parts":[{"text":"${'x'.repeat(100)}`
    ))
    expect(oversizedEvents).toContainEqual(expect.objectContaining({
      type: 'error', errorType: 'frame_too_large'
    }))

    const longResponse = createCanonicalStreamParser('gemini', { maxBufferedCharacters: 160 })
    const value = '{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}'
    const events = longResponse.push(encoder.encode(`[ ${Array.from({ length: 20 }, () => value).join(' , \n')} ]`))
    expect(events.filter((event) => event.type === 'text-delta')).toHaveLength(20)
    expect(events).not.toContainEqual(expect.objectContaining({ errorType: 'frame_too_large' }))
  })

  it.each([
    '[{"candidates":[]} {"candidates":[]}]',
    '[{"candidates":[]},]',
    '[,{"candidates":[]}]',
    '[{"candidates":[]}][{"candidates":[]}]'
  ])('rejects malformed Gemini JSON array grammar: %s', (recording) => {
    const events = parseChunks('gemini', byteChunks(recording, 2))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      errorType: 'invalid_json'
    }))
  })

  it('surfaces a terminal Responses failure instead of collecting a response', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-failed' })
    collector.push(encoder.encode([
      'event: response.failed',
      'data: {"type":"response.failed","sequence_number":1,"response":{"status":"failed","error":{"message":"model failed","type":"server_error","code":"model_failed"}}}',
      '',
      ''
    ].join('\n')))

    const result = collector.finish()
    expect(result).toMatchObject({
      error: 'model failed',
      errorCode: 'model_failed',
      errorType: 'server_error'
    })
    expect(result).not.toHaveProperty('response')
  })

  it('preserves Responses refusal text once and terminates as content filtering', () => {
    const parser = createCanonicalStreamParser('openai-responses')
    const events = parser.push(encoder.encode([
      'event: response.refusal.delta',
      'data: {"type":"response.refusal.delta","output_index":0,"content_index":0,"delta":"Cannot comply"}',
      '',
      'event: response.refusal.done',
      'data: {"type":"response.refusal.done","output_index":0,"content_index":0,"refusal":"Cannot comply"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')))

    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Cannot comply', index: 0, contentType: 'refusal' }
    ])
    expect(events).toContainEqual({ type: 'stop', reason: 'content_filter', rawReason: 'refusal' })
    expect(events).toContainEqual({ type: 'done' })
  })

  it('collects a completed Responses refusal with a consistent completed status', () => {
    const collector = createOpenAiResponsesStreamCollector({ id: 'resp-refusal' })
    collector.push(encoder.encode([
      'event: response.refusal.delta',
      'data: {"type":"response.refusal.delta","output_index":0,"content_index":0,"delta":"Cannot comply"}',
      '',
      'event: response.refusal.done',
      'data: {"type":"response.refusal.done","output_index":0,"content_index":0,"refusal":"Cannot comply"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-refusal","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')))

    const response = collector.finish().response
    expect(response).toMatchObject({
      status: 'completed',
      output: [{
        type: 'message',
        status: 'completed',
        content: [{ type: 'refusal', refusal: 'Cannot comply' }]
      }]
    })
    expect(response).not.toHaveProperty('incomplete_details')
  })

  it('emits a Gemini stream error instead of replacing invalid tool arguments with an empty object', async () => {
    const recording = [
      'data: {"id":"chat-invalid-tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"lookup","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-invalid-tool","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')

    const output = await transcode('openai-chat', 'gemini', recording)
    const wire = new TextDecoder().decode(output)
    expect(wire).toContain('invalid_tool_arguments')
    expect(wire).not.toContain('"functionCall"')
    expect(wire).not.toContain('"finishReason":"STOP"')
  })
})

function parseChunks(protocol: Protocol, chunks: Uint8Array[]): CanonicalStreamEvent[] {
  const parser = createCanonicalStreamParser(protocol)
  const events = chunks.flatMap((chunk) => parser.push(chunk))
  events.push(...parser.finish())
  return events
}

function byteChunks(value: string | Uint8Array, size: number): Uint8Array[] {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size))
  }
  return chunks
}

async function transcode(from: Protocol, to: Protocol, recording: string): Promise<Uint8Array> {
  const chunks = byteChunks(recording, 1)
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  const reader = input.pipeThrough(createProtocolStreamTransform(from, to)).getReader()
  const output: Uint8Array[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    output.push(result.value)
  }
  return joinBytes(output)
}

function joinBytes(output: Uint8Array[]): Uint8Array {
  const size = output.reduce((total, chunk) => total + chunk.length, 0)
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of output) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function summarize(events: CanonicalStreamEvent[]): {
  text: string
  tools: Array<{ index: number; id: string; name: string; arguments: string }>
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  stop: string | undefined
  done: boolean
  errors: string[]
} {
  const tools = new Map<number, { index: number; id: string; name: string; arguments: string }>()
  let text = ''
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}
  let stop: string | undefined
  let done = false
  const errors: string[] = []
  for (const event of events) {
    if (event.type === 'text-delta') text += event.text
    if (event.type === 'tool-call-delta') {
      const tool = tools.get(event.index) ?? { index: event.index, id: '', name: '', arguments: '' }
      if (event.id) tool.id += event.id
      if (event.name) tool.name += event.name
      if (event.arguments) tool.arguments += event.arguments
      tools.set(event.index, tool)
    }
    if (event.type === 'usage') {
      usage = {
        inputTokens: event.inputTokens ?? usage.inputTokens,
        outputTokens: event.outputTokens ?? usage.outputTokens,
        totalTokens: event.totalTokens ?? usage.totalTokens
      }
      if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        usage.totalTokens = usage.inputTokens + usage.outputTokens
      }
    }
    if (event.type === 'stop') stop = event.reason
    if (event.type === 'done') done = true
    if (event.type === 'error') errors.push(event.message)
  }
  return { text, tools: [...tools.values()], usage, stop, done, errors }
}
