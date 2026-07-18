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
