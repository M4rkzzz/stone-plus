import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import {
  ChatGptWebWmProtocolRuntime,
  buildChatGptWebWmLocalTools,
  buildChatGptWebWmResponsesPrompt,
  buildChatGptWebWmSearchExecutionScript,
  buildChatGptWebWmSearchPrompt,
} from '../../src/main/chatgpt-web-wm'
import { CHATGPT_WEB_WM_STREAM_CHANNEL } from '../../src/shared/chatgpt-web-wm-stream'

interface ResponsesRuntimeHarness {
  responses: ChatGptWebWmProtocolRuntime['responses']
  initialize: () => Promise<void>
  ensureProtocolReady: () => Promise<void>
  executeTurn: (
    turn: Record<string, unknown>,
    accessToken: string,
    signal: AbortSignal,
    requestId: string,
  ) => Promise<Record<string, unknown>>
  receiveStreamEvent: (channel: string, args: unknown[]) => void
  responseBindings: Map<string, unknown>
  reasoningStateBindings: Map<string, unknown>
  toolCallBindings: Map<string, unknown>
  conversationCleanupTimers: Map<string, ReturnType<typeof setTimeout>>
  bridgeToken: string
  disposed: boolean
}

function responsesRuntime(
  executeTurn: ResponsesRuntimeHarness['executeTurn'],
): ResponsesRuntimeHarness {
  const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as ResponsesRuntimeHarness
  runtime.initialize = async () => undefined
  runtime.ensureProtocolReady = async () => undefined
  runtime.executeTurn = async (...args) => ({
    observedModel: 'gpt-5.6-sol-wm',
    ...await executeTurn(...args),
  })
  runtime.responseBindings = new Map()
  runtime.reasoningStateBindings = new Map()
  runtime.toolCallBindings = new Map()
  runtime.conversationCleanupTimers = new Map()
  runtime.bridgeToken = 'test-bridge-token'
  runtime.disposed = false
  return runtime
}

function responseEvents(wire: string): Array<Record<string, unknown>> {
  return wire.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

describe('ChatGPT Web WM protocol runtime', () => {
  it('preserves Codex search commands and settings in the Work prompt', () => {
    const prompt = buildChatGptWebWmSearchPrompt({
      commands: { search_query: [{ q: 'OpenAI compaction' }] },
      settings: { max_results: 5 },
    })

    expect(prompt).toContain('built-in web search capability')
    expect(prompt).toContain('"search_query"')
    expect(prompt).toContain('"OpenAI compaction"')
    expect(prompt).toContain('"max_results":5')
  })

  it('generates a syntactically valid isolated-page execution script', () => {
    const script = buildChatGptWebWmSearchExecutionScript({
      requestId: 'request-id',
      prompt: 'Search for the current OpenAI compaction guide.',
      accessToken: 'test-access-token',
      timeoutMs: 120_000,
    })

    expect(() => new Function(`return ${script}`)).not.toThrow()
    expect(script).toContain('/backend-api/f/conversation/prepare')
    expect(script).toContain('/backend-api/f/conversation/resume')
    expect(script).toContain('gpt-5.6-sol-wm')
    expect(script.match(/supports_buffering: true/g)).toHaveLength(2)
    expect(script.match(/conversation_mode: \{ kind: 'primary_assistant' \}/g)).toHaveLength(2)
    expect(script).toContain('conversation.turn_topic.subscribe-attempt')
    expect(script).toContain('subscribe_ws_topic')
    expect(script).toContain('conversation-turn-handoff-control')
    expect(script).toContain('x-oai-stream-handoff-attempt-id')
    expect(script).toContain('ensureWebsocketTransportOpen(descriptor, 2_000)')
    expect(script).toContain("source.includes('pubsub.init')")
    expect(script).toContain('prioritizedWebsocketCandidate')
    expect(script).toContain('queue.splice(index + 1, 0, candidateUrl.href)')
    expect(script).toContain("contentType === 'reasoning_recap'")
    expect(script).toContain("recipient.startsWith('local.')")
    expect(script).toContain("type: 'tool_call_start'")
    expect(script).toContain("type: 'tool_call_delta'")
    expect(script).toContain("type: 'tool_call_done'")
    expect(script).toContain("assistants.find((message) => message.end_turn === true")
    expect(script).toContain('const safeLength = text.length')
    expect(script).not.toContain('streamFinalHistory')
    expect(script).not.toContain('streamDivergenceLimit')
    expect(script).not.toContain("assistants.find((message) => message.recipient === 'all'")
    expect(script).not.toContain('streamPayloadShapes')
    expect(script).toContain('if (snapshot.output && true)')
    expect(script).not.toContain('if (snapshot.output || snapshot.toolCalls.length > 0)')

    const streamingScript = buildChatGptWebWmSearchExecutionScript({
      requestId: 'streaming-request',
      prompt: 'Stream a tool call.',
      accessToken: 'test-access-token',
      timeoutMs: 120_000,
      streamText: true,
    })
    expect(streamingScript).toContain('else inspect(item.data, 0, new Set(), true)')
    expect(streamingScript).toContain(
      "body: { conversation_id: conversationId, offset: 0 },\n            signal: controller.signal,",
    )
    expect(streamingScript).not.toContain('Web WM stream handoff has no resumable transport')
    expect(streamingScript).toContain(
      'const snapshotOnlyFallback = handoff && !websocketUsed && !resumeToken',
    )
    expect(streamingScript).toContain('const snapshotAttempts = snapshotOnlyFallback ? 84 : 24')
    expect(streamingScript).toContain('setTimeout(resolve, attempt < 24 ? 250 : 1_000)')
    expect(streamingScript).toContain('streamAuthoritativeCompletion = true')
    expect(streamingScript).toContain(
      'hasReceivedAuthoritativeStreamCompletion: () => streamAuthoritativeCompletion',
    )
    expect(streamingScript).toContain(
      'if (streamAuthoritativeCompletion && (snapshot.output || snapshot.toolCalls.length > 0)) break',
    )
    expect(streamingScript).toContain(
      'hasOutput && (snapshot.complete || streamAuthoritativeCompletion)',
    )
    expect(streamingScript).toContain('authoritativeCompletion: streamAuthoritativeCompletion')
    expect(streamingScript).not.toContain('let authoritativeCompletion = false')

    const imageScript = buildChatGptWebWmSearchExecutionScript({
      requestId: 'image-request',
      prompt: 'Inspect the attached screenshot.',
      inputImages: [{ imageUrl: 'data:image/png;base64,YQ==', detail: 'high' }],
      accessToken: 'test-access-token',
      timeoutMs: 120_000,
    })
    expect(() => new Function(`return ${imageScript}`)).not.toThrow()
    expect(imageScript).toContain("source.includes('/files/process_upload_stream')")
    expect(imageScript).toContain("source.includes('supports_direct_azure_multipart')")
    expect(imageScript).toContain('materializePendingImages(pendingInputImages, descriptor)')
    expect(imageScript).toContain("content_type: 'image_asset_pointer'")
    expect(imageScript).toContain("content_type: 'multimodal_text'")

    const extendedEffortScript = buildChatGptWebWmSearchExecutionScript({
      requestId: 'extended-effort-request',
      prompt: 'Use extended reasoning effort.',
      accessToken: 'test-access-token',
      timeoutMs: 120_000,
      thinkingEffort: 'extended',
    })
    expect(extendedEffortScript.match(/thinking_effort: "extended"/g)).toHaveLength(2)
  })

  it('does not abort an active production turn at the old two-minute boundary', async () => {
    vi.useFakeTimers()
    try {
      const executeJavaScript = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 121_000))
        return {
          status: 200,
          ok: true,
          output: 'completed',
          observedModel: 'gpt-5.6-sol-wm',
        }
      })
      const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as ResponsesRuntimeHarness
      Object.defineProperty(runtime, 'window', {
        value: {
          isDestroyed: () => false,
          webContents: { executeJavaScript },
        },
      })

      const turn = runtime.executeTurn(
        { prompt: 'Complete a long coding task.', messages: [], bodyExtras: {}, streamText: true },
        'access-token',
        new AbortController().signal,
        'long-turn-request',
      )
      await vi.advanceTimersByTimeAsync(121_000)
      await expect(turn).resolves.toMatchObject({ ok: true, output: 'completed' })

      const script = String(executeJavaScript.mock.calls[0]?.[0])
      expect(script).toContain('const timer = setTimeout(() => controller.abort(), 599000)')
      expect(script).toContain('idleTimeoutMs: 60_000')
    } finally {
      vi.useRealTimers()
    }
  })

  it('verifies eligibility with one real minimal Work turn and a one-time marker', async () => {
    let observedTurn: Record<string, unknown> | undefined
    const turnReady = vi.fn()
    const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as {
      probe: ChatGptWebWmProtocolRuntime['probe']
      initialize: () => Promise<void>
      ensureProtocolReady: () => Promise<void>
      executeTurn: (turn: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    runtime.initialize = async () => undefined
    runtime.ensureProtocolReady = async () => undefined
    runtime.executeTurn = async (turn) => {
      observedTurn = turn
      const marker = String(turn.prompt).match(/STONE_WEB_WM_VERIFY_[A-F0-9]+/)?.[0]
      if (!marker) throw new Error('Verification marker was not generated')
      return {
        status: 200,
        ok: true,
        output: `${marker}.`,
        observedModel: 'gpt-5.6-sol-wm',
      }
    }

    const result = await runtime.probe('access-token', new AbortController().signal, turnReady)

    expect(result).toMatchObject({ statusCode: 200, turnModel: 'gpt-5.6-sol-wm' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(turnReady).toHaveBeenCalledOnce()
    expect(observedTurn).toMatchObject({
      thinkingEffort: 'min',
      hideOnFinal: true,
      messages: [],
      bodyExtras: {},
    })
  })

  it('rejects a marker response when the completed turn is not attributed to 5.6 Sol WM', async () => {
    const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as {
      probe: ChatGptWebWmProtocolRuntime['probe']
      initialize: () => Promise<void>
      ensureProtocolReady: () => Promise<void>
      executeTurn: (turn: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
    runtime.initialize = async () => undefined
    runtime.ensureProtocolReady = async () => undefined
    runtime.executeTurn = async (turn) => ({
      status: 200,
      ok: true,
      output: String(turn.prompt).match(/STONE_WEB_WM_VERIFY_[A-F0-9]+/)?.[0],
      observedModel: 'gpt-5-6',
    })

    await expect(runtime.probe('access-token', new AbortController().signal))
      .rejects.toThrow(/not served by gpt-5\.6-sol-wm/)
  })

  it('preserves Responses roles and exposes function, custom, namespace, and tool-search declarations', () => {
    const body = {
      instructions: 'Keep repository edits scoped.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Inspect the workspace.' }] },
        { type: 'function_call', call_id: 'call_old', name: 'lookup', arguments: '{"key":"a"}' },
        { type: 'function_call_output', call_id: 'call_old', output: 'value-a' },
      ],
      tools: [
        {
          type: 'function', name: 'lookup', description: 'Look up a value.',
          parameters: {
            type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
          },
        },
        { type: 'custom', name: 'apply_patch', description: 'Apply a patch.' },
        {
          type: 'namespace', name: 'codex_app', tools: [{
            type: 'function', name: 'read_thread_terminal', parameters: { type: 'object', properties: {} },
          }],
        },
        { type: 'tool_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      ],
    }

    const prompt = buildChatGptWebWmResponsesPrompt(body)
    const tools = buildChatGptWebWmLocalTools(body)

    expect(prompt).toContain('<instructions>')
    expect(prompt).toContain('[user]\nInspect the workspace.')
    expect(prompt).toContain('[assistant tool call lookup call_old]')
    expect(prompt).toContain('[tool result call_old]\nvalue-a')
    expect(tools.map((tool) => [tool.kind, tool.wireName])).toEqual([
      ['function', 'lookup'],
      ['custom', 'apply_patch'],
      ['function', 'codex_app__read_thread_terminal'],
      ['tool_search', 'search_tools'],
    ])
    expect(tools[0].signature).toMatchObject({
      name: 'lookup',
      type: 'kwargs',
      params: [{ name: 'key', required: true, type: { type: 'string' } }],
    })
    expect(tools[1].signature).toMatchObject({
      params: [{ name: 'input', required: true, type: { type: 'string' } }],
    })
  })

  it('preserves readable Codex agent messages without leaking opaque native state', async () => {
    let observedTurn: Record<string, unknown> | undefined
    const runtime = responsesRuntime(async (turn) => {
      observedTurn = turn
      return { status: 200, ok: true, output: 'Agent handoff received.' }
    })
    const response = await runtime.responses({
      input: [{
        type: 'agent_message',
        author: '/root/reviewer',
        recipient: '/root',
        content: [
          { type: 'input_text', text: 'The regression is in the retry loop.' },
          { type: 'encrypted_content', encrypted_content: 'opaque-native-state' },
        ],
      }],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Agent handoff received.')
    expect(String(observedTurn?.prompt)).toContain('[agent message /root/reviewer -> /root]')
    expect(String(observedTurn?.prompt)).toContain('The regression is in the retry loop.')
    expect(String(observedTurn?.prompt)).not.toContain('opaque-native-state')
  })

  it('resolves real exports across chunks and initializes Sentinel before reading providers', () => {
    const script = buildChatGptWebWmSearchExecutionScript({
      requestId: 'request-id',
      prompt: 'Search the web.',
      accessToken: 'test-access-token',
      timeoutMs: 120_000,
    })

    expect(script).toContain('source.matchAll(/export\\s*\\{([^}]*)\\}/g)')
    expect(script).toContain('const topicFactory = importFor(')
    expect(script).toContain('const payloadParser = importFor(')
    expect(script).toContain('const deltaDecoder = importFor(')
    expect(script).toContain("payload?.type === 'stream-item'")
    expect(script).toContain('decodeEncodedItem(payload.encoded_item)')
    expect(script).toContain("yield { event: 'delta_encoding', data: 'v1' }")
    expect(script).toContain('topic.subscribe({ includeAllHistory: true })')
    expect(script).toContain('armActivityTimer(5_000)')
    expect(script).toContain('armActivityTimer(30_000)')
    expect(script).toContain('try { topic.unsubscribe() } catch {}')
    const initializerCall = script.indexOf('initializeSecurity()')
    const providerRead = script.indexOf('const proofProvider = securityModule')
    expect(initializerCall).toBeGreaterThan(0)
    expect(providerRead).toBeGreaterThan(initializerCall)
  })

  it('emits a text delta before the authoritative Work turn finishes', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const turn = new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await turn
    })
    const response = await runtime.responses(
      {
        model: 'gpt-5.6-sol-wm',
        input: 'Stream this answer.',
        frequency_penalty: 0,
        prompt_cache_key: 'contract-cache-key',
        presence_penalty: 0,
        safety_identifier: 'contract-safety-id',
        service_tier: 'auto',
        stream: true,
        temperature: 1,
        top_logprobs: 0,
        top_p: 0.98,
      },
      'token',
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'reasoning_observed', messageId: 'reasoning-a' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'text_delta', messageId: 'message-a', delta: 'stable prefix ' },
    ])

    let prefixWire = ''
    while (!prefixWire.includes('response.output_text.delta')) {
      const next = await reader!.read()
      expect(next.done).toBe(false)
      prefixWire += new TextDecoder().decode(next.value)
    }
    expect(prefixWire).toContain('stable prefix ')

    resolveTurn({ status: 200, ok: true, output: 'stable prefix and final tail' })
    let finalWire = prefixWire
    for (;;) {
      const next = await reader!.read()
      if (next.done) break
      finalWire += new TextDecoder().decode(next.value)
    }
    const events = responseEvents(finalWire)
    expect(events.filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta).join('')).toBe('stable prefix and final tail')
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_event, index) => index))
    expect((events.find((event) => event.type === 'response.output_item.added')?.item as { id?: string })?.id)
      .toMatch(/^rs_[a-f0-9]+$/)
    const addedItems = events.filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.item as Record<string, unknown>)
    expect(addedItems.map((item) => item.type)).toEqual(['reasoning', 'message'])
    expect(addedItems[0]).toMatchObject({ content: [], summary: [] })
    expect(addedItems[0]).not.toHaveProperty('status')
    expect(addedItems[1]).toMatchObject({ status: 'in_progress', phase: 'final_answer' })
    expect(events.filter((event) => event.type === 'response.output_text.delta'))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        logprobs: [],
        obfuscation: expect.any(String),
      })]))
    for (const event of events.filter((candidate) => candidate.type === 'response.output_text.delta')) {
      expect(Object.keys(event).sort()).toEqual([
        'content_index', 'delta', 'item_id', 'logprobs', 'obfuscation',
        'output_index', 'sequence_number', 'type',
      ])
      expect(String(event.delta).length + String(event.obfuscation).length).toBeGreaterThanOrEqual(16)
      expect((String(event.delta).length + String(event.obfuscation).length) % 16).toBe(0)
    }
    expect(events.every((event) => !Object.hasOwn(event, 'response_id'))).toBe(true)
    const completed = events.at(-1)?.response as {
      output: Array<Record<string, unknown>>
      usage: {
        input_tokens: number
        input_tokens_details: { cached_tokens: number; cache_write_tokens: number }
        output_tokens: number
        output_tokens_details: { reasoning_tokens: number }
        total_tokens: number
      }
    }
    expect(completed.output.map((item) => item.type)).toEqual(['reasoning', 'message'])
    expect(completed.output[0]).toMatchObject({
      id: expect.stringMatching(/^rs_[a-f0-9]+$/),
      content: [],
      summary: [],
    })
    expect(events.at(-1)?.type).toBe('response.completed')
    expect(Object.keys(completed).sort()).toEqual([
      'background',
      'completed_at',
      'created_at',
      'error',
      'frequency_penalty',
      'id',
      'incomplete_details',
      'instructions',
      'max_output_tokens',
      'max_tool_calls',
      'metadata',
      'model',
      'moderation',
      'object',
      'output',
      'parallel_tool_calls',
      'presence_penalty',
      'previous_response_id',
      'prompt_cache_key',
      'prompt_cache_retention',
      'reasoning',
      'safety_identifier',
      'service_tier',
      'status',
      'store',
      'temperature',
      'text',
      'tool_choice',
      'tool_usage',
      'tools',
      'top_logprobs',
      'top_p',
      'truncation',
      'usage',
      'user',
    ])
    expect(events[0]?.response).toMatchObject({
      status: 'in_progress',
      completed_at: null,
      error: null,
      frequency_penalty: 0,
      incomplete_details: null,
      moderation: null,
      presence_penalty: 0,
      prompt_cache_key: 'contract-cache-key',
      prompt_cache_retention: '24h',
      safety_identifier: 'contract-safety-id',
      service_tier: 'default',
      temperature: 1,
      tool_usage: {
        image_gen: {
          input_tokens: 0,
          input_tokens_details: { image_tokens: 0, text_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { image_tokens: 0, text_tokens: 0 },
          total_tokens: 0,
        },
        web_search: { num_requests: 0 },
      },
      top_logprobs: 0,
      top_p: 0.98,
      usage: null,
      tool_choice: 'auto',
      tools: [],
    })
    expect(events.at(-1)?.response).toMatchObject({
      status: 'completed',
      completed_at: expect.any(Number),
      error: null,
      incomplete_details: null,
      reasoning: { context: 'all_turns', effort: 'medium', mode: 'standard', summary: null },
      text: { format: { type: 'text' }, verbosity: 'medium' },
    })
    expect(completed.usage).toMatchObject({
      input_tokens: expect.any(Number),
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: expect.any(Number),
      output_tokens_details: { reasoning_tokens: expect.any(Number) },
      total_tokens: expect.any(Number),
    })
    expect(completed.usage.input_tokens).toBeGreaterThan(0)
    expect(completed.usage.output_tokens).toBeGreaterThan(0)
    expect(completed.usage.output_tokens_details.reasoning_tokens).toBeGreaterThan(0)
    expect(completed.usage.total_tokens)
      .toBe(completed.usage.input_tokens + completed.usage.output_tokens)
  })

  it('streams a Work tool call before the authoritative turn snapshot finishes', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const turn = new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await turn
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Use lookup.',
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      }],
      parallel_tool_calls: false,
      stream: true,
    }, 'token', new AbortController().signal)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_start', messageId: 'work-tool-message', name: 'lookup' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-tool-message', delta: '{"key":"stone"}' },
    ])

    let liveWire = ''
    while (!liveWire.includes('response.function_call_arguments.delta')) {
      const next = await reader!.read()
      expect(next.done).toBe(false)
      liveWire += new TextDecoder().decode(next.value)
    }
    const liveEvents = responseEvents(liveWire)
    const added = liveEvents.find((event) => (
      event.type === 'response.output_item.added'
      && (event.item as { type?: string })?.type === 'function_call'
    ))
    expect(added?.item).toMatchObject({
      status: 'in_progress',
      call_id: expect.stringMatching(/^call_[a-f0-9]+$/),
      name: 'lookup',
      arguments: '',
    })
    expect(liveEvents.some((event) => event.type === 'response.completed')).toBe(false)

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_done', messageId: 'work-tool-message' },
    ])
    resolveTurn({
      status: 200,
      ok: true,
      conversationId: 'conversation-live-tool',
      currentNode: 'work-tool-message',
      output: '',
      toolCalls: [{
        id: 'work-tool-message',
        name: 'lookup',
        arguments: '{"key":"stone"}',
      }],
    })

    let finalWire = liveWire
    for (;;) {
      const next = await reader!.read()
      if (next.done) break
      finalWire += new TextDecoder().decode(next.value)
    }
    const events = responseEvents(finalWire)
    expect(events.filter((event) => (
      event.type === 'response.output_item.added'
      && (event.item as { type?: string })?.type === 'function_call'
    ))).toHaveLength(1)
    expect(events.filter((event) => event.type === 'response.function_call_arguments.delta')
      .map((event) => event.delta).join('')).toBe('{"key":"stone"}')
    const done = events.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'function_call'
    ))
    expect(done?.item).toMatchObject({
      status: 'completed',
      call_id: (added?.item as { call_id?: string })?.call_id,
      arguments: '{"key":"stone"}',
    })
    expect(events.at(-1)?.type).toBe('response.completed')
  })

  it('streams multiple Work tool calls as independent Responses items', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const turn = new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await turn
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Use both tools.',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'write', parameters: { type: 'object', properties: {} } },
      ],
      parallel_tool_calls: true,
      stream: true,
    }, 'token', new AbortController().signal)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let wire = ''
    const readUntil = async (predicate: () => boolean): Promise<void> => {
      while (!predicate()) {
        const next = await reader.read()
        expect(next.done).toBe(false)
        wire += decoder.decode(next.value)
      }
    }
    const addedToolEvents = (): Record<string, unknown>[] => responseEvents(wire).filter((event) => (
      event.type === 'response.output_item.added'
      && (event.item as { type?: string })?.type === 'function_call'
    ))

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_start', messageId: 'work-lookup', name: 'lookup' },
    ])
    await readUntil(() => addedToolEvents().length === 1)
    expect((addedToolEvents()[0].item as { name?: string }).name).toBe('lookup')

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-lookup', delta: '{"key":"stone"}' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_done', messageId: 'work-lookup' },
    ])
    await readUntil(() => responseEvents(wire).some((event) => (
      event.type === 'response.function_call_arguments.done'
      && event.output_index === 0
    )))

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_start', messageId: 'work-write', name: 'write' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-write', delta: '{"value":"plus"}' },
    ])
    await readUntil(() => addedToolEvents().length === 2)
    expect((addedToolEvents()[1].item as { name?: string }).name).toBe('write')
    expect(responseEvents(wire).some((event) => event.type === 'response.completed')).toBe(false)

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_done', messageId: 'work-write' },
    ])
    resolveTurn({
      status: 200,
      ok: true,
      observedModel: 'gpt-5.6-sol-wm',
      conversationId: 'conversation-live-tools',
      currentNode: 'work-write',
      output: '',
      toolCalls: [
        { id: 'work-lookup', name: 'lookup', arguments: '{"key":"stone"}' },
        { id: 'work-write', name: 'write', arguments: '{"value":"plus"}' },
      ],
    })
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      wire += decoder.decode(next.value)
    }

    const events = responseEvents(wire)
    const added = events.filter((event) => (
      event.type === 'response.output_item.added'
      && (event.item as { type?: string })?.type === 'function_call'
    ))
    expect(added.map((event) => ({
      outputIndex: event.output_index,
      name: (event.item as { name?: string }).name,
      callId: (event.item as { call_id?: string }).call_id,
    }))).toEqual([
      { outputIndex: 0, name: 'lookup', callId: expect.stringMatching(/^call_[a-f0-9]+$/) },
      { outputIndex: 1, name: 'write', callId: expect.stringMatching(/^call_[a-f0-9]+$/) },
    ])
    expect((added[0].item as { call_id: string }).call_id)
      .not.toBe((added[1].item as { call_id: string }).call_id)
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { parallel_tool_calls: true },
    })
  })

  it('streams custom tool input before the Work turn completes', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Run a command.',
      tools: [{ type: 'custom', name: 'exec', description: 'Run a command.' }],
      stream: true,
    }, 'token', new AbortController().signal)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let wire = ''

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_start', messageId: 'work-exec', name: 'exec' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-exec', delta: '{"input":"Get-' },
    ])
    while (!responseEvents(wire).some((event) => event.type === 'response.custom_tool_call_input.delta')) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      wire += decoder.decode(next.value)
    }
    expect(responseEvents(wire).filter((event) => event.type === 'response.custom_tool_call_input.delta')
      .map((event) => event.delta).join('')).toBe('Get-')
    expect(responseEvents(wire).some((event) => event.type === 'response.completed')).toBe(false)

    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-exec', delta: 'ChildItem"}' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_done', messageId: 'work-exec' },
    ])
    resolveTurn({
      status: 200,
      ok: true,
      observedModel: 'gpt-5.6-sol-wm',
      conversationId: 'conversation-live-custom-tool',
      currentNode: 'work-exec',
      output: '',
      toolCalls: [{ id: 'work-exec', name: 'exec', arguments: '{"input":"Get-ChildItem"}' }],
    })
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      wire += decoder.decode(next.value)
    }

    const events = responseEvents(wire)
    const deltas = events.filter((event) => event.type === 'response.custom_tool_call_input.delta')
      .map((event) => event.delta).join('')
    expect(deltas).toBe('Get-ChildItem')
    expect(events.find((event) => event.type === 'response.custom_tool_call_input.done'))
      .toMatchObject({ input: deltas })
    expect(events.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'custom_tool_call'
    ))?.item).toMatchObject({ name: 'exec', input: deltas, status: 'completed' })
    expect(events.at(-1)?.type).toBe('response.completed')
  })

  it('fails closed when the final Work tool arguments contradict the streamed call', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    })
    const response = await runtime.responses({
      input: 'Use lookup.',
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
      }],
      stream: true,
    }, 'token', new AbortController().signal)
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_start', messageId: 'work-tool-message', name: 'lookup' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_delta', messageId: 'work-tool-message', delta: '{"key":"wrong"}' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'tool_call_done', messageId: 'work-tool-message' },
    ])
    resolveTurn({
      status: 200,
      ok: true,
      output: '',
      toolCalls: [{
        id: 'work-tool-message',
        name: 'lookup',
        arguments: '{"key":"authoritative"}',
      }],
    })

    const events = responseEvents(await response.text())
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'web_wm_tool_stream_mismatch' } },
    })
    expect(events.some((event) => event.type === 'response.completed')).toBe(false)
  })

  it('omits streaming padding when Codex disables response obfuscation', async () => {
    const runtime = responsesRuntime(async () => ({
      status: 200,
      ok: true,
      output: 'bandwidth-efficient response',
      toolCalls: [{ messageId: 'tool-message', name: 'lookup', arguments: '{"key":"stone"}' }],
    }))
    const response = await runtime.responses({
      input: 'Use the lookup tool.',
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
      }],
      stream_options: { include_obfuscation: false },
      stream: true,
    }, 'token', new AbortController().signal)

    const deltas = responseEvents(await response.text()).filter((event) => (
      event.type === 'response.output_text.delta'
      || event.type === 'response.function_call_arguments.delta'
    ))
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.every((event) => !Object.hasOwn(event, 'obfuscation'))).toBe(true)
  })

  it('uses the final Work snapshot to recover a hidden reasoning item without exposing content', async () => {
    const runtime = responsesRuntime(async () => ({
      status: 200,
      ok: true,
      output: 'visible answer',
      reasoningMessageId: 'reasoning-from-snapshot',
    }))
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Reason privately.',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'max', summary: 'auto' },
      stream: true,
    }, 'token', new AbortController().signal)

    const events = responseEvents(await response.text())
    const reasoningDone = events.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'reasoning'
    ))
    expect(reasoningDone?.item).toMatchObject({
      id: expect.stringMatching(/^rs_[a-f0-9]+$/),
      type: 'reasoning',
      content: [],
      summary: [],
      encrypted_content: expect.stringMatching(/^wmrs_[A-Za-z0-9_-]{100,}$/),
    })
    const terminalReasoning = ((events.at(-1)?.response as {
      output: Array<Record<string, unknown>>
    }).output).find((item) => item.type === 'reasoning')
    expect(terminalReasoning?.encrypted_content).toBe(
      (reasoningDone?.item as Record<string, unknown>).encrypted_content,
    )
    expect(JSON.stringify(events)).not.toContain('private chain')
    expect((events.at(-1)?.response as { reasoning?: unknown }).reasoning)
      .toEqual({ context: 'all_turns', effort: 'max', mode: 'standard', summary: 'detailed' })
  })

  it.each([
    ['none', 'min'],
    ['minimal', 'min'],
    ['low', 'min'],
    ['medium', 'standard'],
    ['high', 'extended'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
    ['ultra', 'ultra'],
  ] as const)('maps Codex %s reasoning to Work %s while preserving the Responses effort', async (
    reasoningEffort,
    thinkingEffort,
  ) => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return { status: 200, ok: true, output: `${reasoningEffort} effort answer` }
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: `Use ${reasoningEffort} effort.`,
      reasoning: { effort: reasoningEffort, summary: 'auto' },
      stream: true,
    }, 'token', new AbortController().signal)
    const events = responseEvents(await response.text())

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ thinkingEffort })
    expect((events.at(-1)?.response as { reasoning?: unknown }).reasoning).toEqual({
      context: 'all_turns', effort: reasoningEffort, mode: 'standard', summary: 'detailed',
    })
  })

  it('uses the measured native medium default and Work standard default when effort is omitted', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return { status: 200, ok: true, output: 'default effort answer' }
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Use the default effort.',
      stream: true,
    }, 'token', new AbortController().signal)
    const events = responseEvents(await response.text())

    expect(turns[0]).toMatchObject({ thinkingEffort: 'standard' })
    expect((events.at(-1)?.response as { reasoning?: unknown }).reasoning).toMatchObject({
      effort: 'medium', summary: null,
    })
  })

  it.each([
    ['low', 'Keep the final answer concise'],
    ['medium', 'Use a balanced level of detail'],
    ['high', 'Provide a detailed final answer'],
  ] as const)('accepts Codex %s verbosity and preserves it in the Responses envelope', async (
    verbosity,
    styleInstruction,
  ) => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return { status: 200, ok: true, output: 'styled answer' }
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Answer with the requested style.',
      text: { verbosity },
      stream: true,
    }, 'token', new AbortController().signal)
    const events = responseEvents(await response.text())

    expect(String(turns[0].prompt)).toContain(styleInstruction)
    expect((events.at(-1)?.response as { text?: unknown }).text).toEqual({
      format: { type: 'text' }, verbosity,
    })
  })

  it('accepts the current Codex Responses Lite request shape', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return { status: 200, ok: true, output: 'lite answer' }
    })
    const response = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      instructions: '',
      input: [
        { type: 'additional_tools', role: 'developer', tools: [] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Answer.' }] },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'high', context: 'all_turns' },
      text: { verbosity: 'low' },
      include: ['reasoning.encrypted_content'],
      client_metadata: {
        'x-codex-installation-id': 'installation-id',
        session_id: 'session-id',
        'x-codex-window-id': 'local:window-id',
      },
      prompt_cache_key: 'cache-key',
      store: false,
      stream: true,
    }, 'token', new AbortController().signal)
    const events = responseEvents(await response.text())
    const terminal = events.at(-1)?.response as {
      reasoning?: unknown
      text?: unknown
    }

    expect(response.status).toBe(200)
    expect(turns[0]).toMatchObject({
      thinkingEffort: 'extended',
      parallelToolCalls: false,
      bodyExtras: { parallel_tool_calls: false },
    })
    expect(String(turns[0].prompt)).toContain('Keep the final answer concise')
    expect(terminal.reasoning).toEqual({
      context: 'all_turns', effort: 'high', mode: 'standard', summary: null,
    })
    expect(terminal.text).toEqual({ format: { type: 'text' }, verbosity: 'low' })
  })

  it('continues the same Work conversation from an opaque reasoning state', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      return turns.length === 1 ? {
        status: 200,
        ok: true,
        output: 'first visible answer',
        reasoningMessageId: 'reasoning-first',
        conversationId: 'conversation-reasoning',
        currentNode: 'node-first',
      } : {
        status: 200,
        ok: true,
        output: 'continued visible answer',
        reasoningMessageId: 'reasoning-second',
        conversationId: 'conversation-reasoning',
        currentNode: 'node-second',
      }
    })
    const first = await runtime.responses({
      input: 'first user turn',
      include: ['reasoning.encrypted_content'],
      stream: true,
    }, 'token', new AbortController().signal)
    const firstEvents = responseEvents(await first.text())
    const firstCompleted = firstEvents.at(-1)?.response as {
      output: Array<Record<string, unknown>>
      usage: { total_tokens: number }
    }
    const encryptedContent = firstCompleted.output.find((item) => item.type === 'reasoning')
      ?.encrypted_content as string

    const second = await runtime.responses({
      input: [
        { type: 'reasoning', summary: [], encrypted_content: encryptedContent },
        {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'first visible answer' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next user turn' }] },
      ],
      include: ['reasoning.encrypted_content'],
      stream: true,
    }, 'token', new AbortController().signal)

    const secondEvents = responseEvents(await second.text())
    expect(JSON.stringify(secondEvents)).toContain('continued visible answer')
    const secondUsage = (secondEvents.at(-1)?.response as {
      usage: { input_tokens: number }
    }).usage
    expect(secondUsage.input_tokens).toBeGreaterThan(firstCompleted.usage.total_tokens)
    expect(turns[1]).toMatchObject({
      conversationId: 'conversation-reasoning',
      parentMessageId: 'node-first',
    })
    expect(String(turns[1].prompt)).toContain('next user turn')
    expect(String(turns[1].prompt)).not.toContain('first visible answer')
    for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
  })

  it('does not resend visible history when previous_response_id already owns the Work turn', async () => {
    const turns: Array<Record<string, unknown>> = []
    const firstVisibleAnswer = 'first visible answer '.repeat(2_000)
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return {
        status: 200,
        ok: true,
        output: turns.length === 1 ? firstVisibleAnswer : 'second visible answer',
        conversationId: 'conversation-history-delta',
        currentNode: turns.length === 1 ? 'node-first' : 'node-second',
      }
    })

    const first = await runtime.responses({
      input: 'first user turn',
      stream: true,
    }, 'token', new AbortController().signal)
    const firstEvents = responseEvents(await first.text())
    const firstCompleted = firstEvents.find(
      (event) => event.type === 'response.completed',
    )?.response as { id: string; usage: { total_tokens: number } }

    const second = await runtime.responses({
      previous_response_id: firstCompleted.id,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first user turn' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: firstVisibleAnswer }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second user turn' }] },
      ],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(second.status).toBe(200)
    const secondEvents = responseEvents(await second.text())
    expect(JSON.stringify(secondEvents)).toContain('second visible answer')
    expect(turns).toHaveLength(2)
    expect(String(turns[1].prompt)).toContain('second user turn')
    expect(String(turns[1].prompt)).not.toContain('first visible answer')
    expect(String(turns[1].prompt)).not.toContain('first user turn')
    const secondUsage = secondEvents.find((event) => event.type === 'response.completed')?.response as {
      usage: { input_tokens: number }
    }
    // The new turn should add only a small delta to the existing context. If
    // the visible history is rendered again, this jumps by roughly the whole
    // 40k-character first answer and recreates the early-compact regression.
    expect(secondUsage.usage.input_tokens).toBeLessThan(firstCompleted.usage.total_tokens + 1_000)
    for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
  })

  it('replays normal Sol reasoning history instead of claiming it as Web WM state', async () => {
    const executeTurn = vi.fn(async () => ({
      status: 200,
      ok: true,
      output: 'continued through Web WM',
    }))
    const runtime = responsesRuntime(executeTurn)
    const response = await runtime.responses({
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Prior visible reasoning summary.' }],
          encrypted_content: 'gAAAAA-native-sol-reasoning',
        },
        {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Prior visible answer.' }],
        },
        {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'Continue from this history.' }],
        },
      ],
      include: ['reasoning.encrypted_content'],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(JSON.stringify(responseEvents(await response.text())))
      .toContain('continued through Web WM')
    expect(executeTurn).toHaveBeenCalledOnce()
    const prompt = String(executeTurn.mock.calls[0]?.[0]?.prompt)
    expect(prompt).toContain('Prior visible reasoning summary.')
    expect(prompt).toContain('Prior visible answer.')
    expect(prompt).toContain('Continue from this history.')
  })

  it('recovers an unavailable account-local reasoning state on a fresh Web WM conversation', async () => {
    const executeTurn = vi.fn(async () => ({
      status: 200,
      ok: true,
      conversationId: 'conversation-recovered',
      currentNode: 'node-recovered',
      output: 'Recovered through Web WM.',
    }))
    const runtime = responsesRuntime(executeTurn)
    const response = await runtime.responses({
      input: [
        { type: 'reasoning', summary: [], encrypted_content: 'wmrs_missing' },
        {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'A completed answer from the lost state.' }],
        },
        { type: 'message', role: 'user', content: 'continue visibly' },
      ],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Recovered through Web WM.')
    expect(executeTurn).toHaveBeenCalledOnce()
    expect(executeTurn.mock.calls[0]?.[0]).toMatchObject({
      prompt: expect.stringContaining('continue visibly'),
    })
    expect(executeTurn.mock.calls[0]?.[0]).not.toHaveProperty('conversationId')
    expect(executeTurn.mock.calls[0]?.[0]).not.toHaveProperty('parentMessageId')
    expect(String(executeTurn.mock.calls[0]?.[0]?.prompt))
      .toContain('A completed answer from the lost state.')
  })

  it('recovers a tool result after its account-local reasoning state is lost', async () => {
    const executeTurn = vi.fn(async () => ({
      status: 200,
      ok: true,
      conversationId: 'conversation-recovered-tool',
      currentNode: 'node-recovered-tool',
      output: 'Recovered tool result through Web WM.',
    }))
    const runtime = responsesRuntime(executeTurn)
    const response = await runtime.responses({
      input: [
        { type: 'reasoning', summary: [], encrypted_content: 'wmrs_missing_after_restart' },
        { type: 'custom_tool_call', call_id: 'call_lost', name: 'exec', input: 'Get-Location' },
        {
          type: 'custom_tool_call_output', call_id: 'call_lost',
          output: [{ type: 'input_text', text: 'D:\\project\\stone+' }],
        },
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run a command.' }],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Recovered tool result through Web WM.')
    expect(executeTurn).toHaveBeenCalledOnce()
    const turn = executeTurn.mock.calls[0]?.[0]
    expect(turn).not.toHaveProperty('conversationId')
    expect(turn).not.toHaveProperty('parentMessageId')
    expect(String(turn?.prompt)).toContain('Get-Location')
    expect(String(turn?.prompt)).toContain('D:\\\\project\\\\stone+')

    const orphaned = await runtime.responses({
      input: [
        { type: 'custom_tool_call_output', call_id: 'call_unknown', output: 'unknown' },
      ],
      tools: [{ type: 'custom', name: 'exec', description: 'Run a command.' }],
      stream: true,
    }, 'token', new AbortController().signal)
    expect(orphaned.status).toBe(400)
    expect(await orphaned.json()).toMatchObject({ error: { code: 'web_wm_state_not_found' } })
    expect(executeTurn).toHaveBeenCalledOnce()
  })

  it('rebuilds a self-contained Codex tool loop after its account runtime is replaced', async () => {
    const firstRuntime = responsesRuntime(async () => ({
      status: 200,
      ok: true,
      conversationId: 'conversation-before-runtime-replacement',
      currentNode: 'node-before-runtime-replacement',
      output: '',
      toolCalls: [{ id: 'work-first', name: 'exec', arguments: 'Get-Location' }],
    }))
    const first = await firstRuntime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Inspect the workspace.',
      tools: [{ type: 'custom', name: 'exec', description: 'Run a command.' }],
      stream: true,
    }, 'token', new AbortController().signal)
    const firstCall = responseEvents(await first.text()).find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'custom_tool_call'
    ))?.item as { call_id?: string; input?: string }
    expect(firstCall.call_id).toMatch(/^call_[a-f0-9]+$/)

    const recoveredTurns: Array<Record<string, unknown>> = []
    const replacementRuntime = responsesRuntime(async (turn) => {
      recoveredTurns.push(turn)
      return recoveredTurns.length === 1
        ? {
            status: 200,
            ok: true,
            conversationId: 'conversation-after-runtime-replacement',
            currentNode: 'node-second-tool',
            output: '',
            toolCalls: [{ id: 'work-second', name: 'exec', arguments: 'Get-Content tool_smoke_test.ps1' }],
          }
        : {
            status: 200,
            ok: true,
            conversationId: 'conversation-after-runtime-replacement',
            currentNode: 'node-final',
            output: 'Recovered debugging workflow completed.',
            toolCalls: [],
          }
    })
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }
    const history: Array<Record<string, unknown>> = [
      {
        type: 'custom_tool_call',
        id: 'ctc_from_codex_session',
        status: 'completed',
        call_id: firstCall.call_id,
        name: 'exec',
        input: firstCall.input,
      },
      {
        type: 'custom_tool_call_output',
        id: 'ctco_from_codex_session',
        call_id: firstCall.call_id,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
          { type: 'input_text', text: 'D:\\project\\stone+\ntool_smoke_test.ps1\n' },
        ],
      },
    ]
    const recovered = await replacementRuntime.responses({
      model: 'gpt-5.6-sol-wm', input: history, tools: [declaration], stream: true,
    }, 'token', new AbortController().signal)
    const secondCall = responseEvents(await recovered.text()).find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'custom_tool_call'
    ))?.item as { call_id?: string; input?: string }
    expect(secondCall.call_id).toMatch(/^call_[a-f0-9]+$/)
    expect(recoveredTurns[0]).not.toHaveProperty('conversationId')
    expect(recoveredTurns[0]).not.toHaveProperty('parentMessageId')
    expect(String(recoveredTurns[0].prompt)).toContain('tool_smoke_test.ps1')
    expect(String(recoveredTurns[0].prompt)).toContain('completed Responses history')

    history.push(
      {
        type: 'custom_tool_call',
        call_id: secondCall.call_id,
        name: 'exec',
        input: secondCall.input,
      },
      {
        type: 'custom_tool_call_output',
        call_id: secondCall.call_id,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
          { type: 'input_text', text: 'Write-Output "line1"\nWrite-Output "line3"\n' },
        ],
      },
    )
    const final = await replacementRuntime.responses({
      model: 'gpt-5.6-sol-wm', input: history, tools: [declaration], stream: true,
    }, 'token', new AbortController().signal)
    expect(final.status).toBe(200)
    expect(await final.text()).toContain('Recovered debugging workflow completed.')
    expect(recoveredTurns[1]).toMatchObject({
      conversationId: 'conversation-after-runtime-replacement',
      parentMessageId: 'node-second-tool',
      messages: [{ author: { role: 'tool', name: 'exec' } }],
    })
    expect(recoveredTurns[1].messages).toHaveLength(1)
    expect(String((recoveredTurns[1].messages as Array<{ content: { text: string } }>)[0].content.text))
      .toContain('Write-Output')

    for (const runtime of [firstRuntime, replacementRuntime]) {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('keeps interleaved Web WM streams isolated by request id', async () => {
    const turns = new Map<string, (value: Record<string, unknown>) => void>()
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => (
      await new Promise<Record<string, unknown>>((resolve) => turns.set(id, resolve))
    ))
    const signal = new AbortController().signal
    const first = await runtime.responses({ input: 'first', stream: true }, 'token', signal)
    const second = await runtime.responses({ input: 'second', stream: true }, 'token', signal)
    const [firstId, secondId] = [...turns.keys()]
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken, firstId, { type: 'text_delta', messageId: 'message-first', delta: 'first ' },
    ])
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken, secondId, { type: 'text_delta', messageId: 'message-second', delta: 'second ' },
    ])
    turns.get(firstId)?.({ status: 200, ok: true, output: 'first complete' })
    turns.get(secondId)?.({ status: 200, ok: true, output: 'second complete' })

    const [firstWire, secondWire] = await Promise.all([first.text(), second.text()])
    expect(firstWire).toContain('first complete')
    expect(firstWire).not.toContain('second complete')
    expect(secondWire).toContain('second complete')
    expect(secondWire).not.toContain('first complete')
  })

  it('fails closed when the final snapshot contradicts a streamed prefix', async () => {
    let requestId = ''
    let resolveTurn!: (value: Record<string, unknown>) => void
    const runtime = responsesRuntime(async (_value, _token, _signal, id) => {
      requestId = id
      return await new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    })
    const response = await runtime.responses({ input: 'mismatch', stream: true }, 'token', new AbortController().signal)
    runtime.receiveStreamEvent(CHATGPT_WEB_WM_STREAM_CHANNEL, [
      runtime.bridgeToken,
      requestId,
      { type: 'text_delta', messageId: 'message-a', delta: 'wrong prefix' },
    ])
    resolveTurn({ status: 200, ok: true, output: 'different final result' })

    const wire = await response.text()
    expect(wire).toContain('event: response.failed')
    expect(wire).toContain('web_wm_stream_mismatch')
    expect(wire).not.toContain('event: response.completed')
  })

  it('preserves provider status semantics inside a Responses failure terminal', async () => {
    const runtime = responsesRuntime(async () => ({
      status: 429,
      ok: false,
      errorCode: 'work_capacity_rejected',
      errorMessage: 'Work is temporarily overloaded.',
    }))
    const response = await runtime.responses(
      { model: 'gpt-5.6-sol-wm', input: 'retry me', stream: true },
      'token',
      new AbortController().signal,
    )

    const events = responseEvents(await response.text())
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: {
        status: 'failed',
        completed_at: null,
        usage: null,
        error: {
          code: 'rate_limit_error',
          message: 'Work is temporarily overloaded.',
        },
      },
    })
    expect(events.some((event) => event.type === 'response.completed')).toBe(false)
  })

  it('emits response.incomplete instead of completing a truncated Work turn', async () => {
    const runtime = responsesRuntime(async () => ({
      status: 200,
      ok: true,
      output: 'partial answer',
      incompleteReason: 'max_output_tokens',
    }))
    const response = await runtime.responses(
      { input: 'produce a bounded answer', stream: true },
      'token',
      new AbortController().signal,
    )

    const events = responseEvents(await response.text())
    expect(events.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        completed_at: null,
        error: null,
        incomplete_details: { reason: 'max_output_tokens' },
        usage: {
          input_tokens: expect.any(Number),
          output_tokens: expect.any(Number),
          total_tokens: expect.any(Number),
        },
      },
    })
    const output = (events.at(-1)?.response as { output: Array<Record<string, unknown>> }).output
    expect(output).toEqual([expect.objectContaining({ type: 'message', status: 'incomplete' })])
    expect(events.some((event) => event.type === 'response.completed')).toBe(false)
  })

  it('rejects unsupported multimodal input and missing account-local continuation state', async () => {
    const executeTurn = vi.fn(async () => ({ status: 200, ok: true, output: 'unexpected' }))
    const runtime = responsesRuntime(executeTurn)
    const signal = new AbortController().signal

    const imageResponse = await runtime.responses({
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
      }],
      stream: true,
    }, 'token', signal)
    expect(imageResponse.status).toBe(400)
    expect(await imageResponse.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'unsupported_web_wm_feature' },
    })

    const continuationResponse = await runtime.responses({
      previous_response_id: 'resp_missing',
      input: 'continue',
      stream: true,
    }, 'token', signal)
    expect(continuationResponse.status).toBe(400)
    expect(await continuationResponse.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'web_wm_state_not_found',
        param: 'previous_response_id',
      },
    })
    expect(executeTurn).not.toHaveBeenCalled()
  })

  it('carries current Codex inline images into the controlled Work upload path', async () => {
    let observedTurn: Record<string, unknown> | undefined
    const runtime = responsesRuntime(async (turn) => {
      observedTurn = turn
      return { status: 200, ok: true, output: 'The screenshot was inspected.' }
    })
    const imageUrl = 'data:image/png;base64,YQ=='
    const response = await runtime.responses({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect this screenshot.' },
          { type: 'input_image', image_url: imageUrl, detail: 'high' },
        ],
      }],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('The screenshot was inspected.')
    expect(observedTurn).toMatchObject({
      inputImages: [{ imageUrl, detail: 'high' }],
    })
    expect(String(observedTurn?.prompt)).toContain('[attached image]')
    expect(String(observedTurn?.prompt)).not.toContain(imageUrl)
  })

  it('keeps tool-result screenshots attached to their owning tool continuation', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (turn) => {
      turns.push(turn)
      return turns.length === 1
        ? {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-image',
            currentNode: 'node-tool-image-call',
            output: '',
            toolCalls: [{ id: 'work-image-call', name: 'exec', arguments: 'view image' }],
          }
        : {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-image',
            currentNode: 'node-tool-image-final',
            output: 'The rendered image is valid.',
            toolCalls: [],
          }
    })
    const declaration = { type: 'custom', name: 'exec', description: 'Run a local tool.' }
    const signal = new AbortController().signal
    const first = await runtime.responses({
      input: 'Render and inspect the result.', tools: [declaration], stream: true,
    }, 'token', signal)
    const call = responseEvents(await first.text()).find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'custom_tool_call'
    ))?.item as { call_id: string; input: string }
    const imageUrl = 'data:image/jpeg;base64,YQ=='

    try {
      const second = await runtime.responses({
        input: [
          { type: 'custom_tool_call', call_id: call.call_id, name: 'exec', input: call.input },
          {
            type: 'custom_tool_call_output',
            call_id: call.call_id,
            output: [
              { type: 'input_text', text: 'Rendered frame metadata.' },
              { type: 'input_image', image_url: imageUrl, detail: 'original' },
            ],
          },
        ],
        tools: [declaration],
        stream: true,
      }, 'token', signal)

      expect(second.status).toBe(200)
      expect(await second.text()).toContain('The rendered image is valid.')
      const message = (turns[1].messages as Array<Record<string, unknown>>)[0]
      expect(message).toMatchObject({
        author: { role: 'tool', name: 'exec' },
        stoneInputImages: [{ imageUrl, detail: 'original' }],
      })
      expect(JSON.stringify(message.content)).toContain('Rendered frame metadata.')
      expect(JSON.stringify(message.content)).not.toContain(imageUrl)
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('rebuilds a missing previous_response_id only when visible response history is present', async () => {
    const executeTurn = vi.fn(async () => ({
      status: 200,
      ok: true,
      conversationId: 'conversation-rebuilt-from-visible-history',
      currentNode: 'node-rebuilt-from-visible-history',
      output: 'Continued from visible history.',
    }))
    const runtime = responsesRuntime(executeTurn)
    const response = await runtime.responses({
      previous_response_id: 'resp_missing_after_runtime_replacement',
      input: [
        {
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'The previous visible answer.' }],
        },
        {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'Continue the debugging workflow.' }],
        },
      ],
      stream: true,
    }, 'token', new AbortController().signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Continued from visible history.')
    expect(executeTurn).toHaveBeenCalledOnce()
    expect(executeTurn.mock.calls[0]?.[0]).not.toHaveProperty('conversationId')
    expect(executeTurn.mock.calls[0]?.[0]).not.toHaveProperty('parentMessageId')
    expect(String(executeTurn.mock.calls[0]?.[0]?.prompt)).toContain('The previous visible answer.')
    expect(String(executeTurn.mock.calls[0]?.[0]?.prompt)).toContain('Continue the debugging workflow.')
  })

  it('rejects Responses options and item types that Work cannot honor', async () => {
    const executeTurn = vi.fn(async () => ({ status: 200, ok: true, output: 'unexpected' }))
    const runtime = responsesRuntime(executeTurn)
    const signal = new AbortController().signal
    const cases: Array<{ body: Record<string, unknown>; param: string }> = [
      { body: { store: true }, param: 'store' },
      { body: { max_output_tokens: 1_000 }, param: 'max_output_tokens' },
      { body: { max_tool_calls: 2 }, param: 'max_tool_calls' },
      { body: { truncation: 'auto' }, param: 'truncation' },
      { body: { temperature: 0.5 }, param: 'temperature' },
      { body: { top_p: 1 }, param: 'top_p' },
      { body: { service_tier: 'priority' }, param: 'service_tier' },
      { body: { reasoning: { effort: 'extreme' } }, param: 'reasoning.effort' },
      { body: { reasoning: { effort: 'high', context: 'current_turn' } }, param: 'reasoning.context' },
      { body: { reasoning: { effort: 'high', summary: 'brief' } }, param: 'reasoning.summary' },
      { body: { include: ['message.output_text.logprobs'] }, param: 'include[0]' },
      { body: { text: { format: { type: 'text' }, verbosity: 'extreme' } }, param: 'text.verbosity' },
      { body: { input: [{ type: 'local_shell_call', command: 'pwd' }] }, param: 'input[0].type' },
    ]

    for (const testCase of cases) {
      const response = await runtime.responses(
        { model: 'gpt-5.6-sol-wm', input: 'test', stream: true, ...testCase.body },
        'token',
        signal,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_web_wm_feature',
          param: testCase.param,
        },
      })
    }
    expect(executeTurn).not.toHaveBeenCalled()
  })

  it('fails closed when Work does not satisfy Responses tool-selection constraints', async () => {
    const lookup = {
      type: 'function', name: 'lookup', description: 'Look up a value.',
      parameters: { type: 'object', properties: { key: { type: 'string' } } },
    }
    const write = {
      type: 'function', name: 'write', description: 'Write a value.',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    }

    const requiredRuntime = responsesRuntime(async () => ({
      status: 200, ok: true, output: 'I did not call the required tool.', toolCalls: [],
    }))
    const required = await requiredRuntime.responses({
      input: 'Use a tool.', tools: [lookup], tool_choice: 'required', stream: true,
    }, 'token', new AbortController().signal)
    expect(responseEvents(await required.text()).at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'tool_choice_not_satisfied' } },
    })

    const namedRuntime = responsesRuntime(async () => ({
      status: 200,
      ok: true,
      output: '',
      toolCalls: [{ id: 'internal-write', name: 'write', arguments: '{"value":"wrong tool"}' }],
    }))
    const named = await namedRuntime.responses({
      input: 'Only look this up.',
      tools: [lookup, write],
      tool_choice: { type: 'function', name: 'lookup' },
      stream: true,
    }, 'token', new AbortController().signal)
    expect(responseEvents(await named.text()).at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'tool_choice_not_satisfied' } },
    })

  })

  it('preserves independent Work tool calls when Work ignores the parallel hint', async () => {
    const lookup = {
      type: 'function', name: 'lookup', description: 'Look up a value.',
      parameters: { type: 'object', properties: { key: { type: 'string' } } },
    }
    const write = {
      type: 'function', name: 'write', description: 'Write a value.',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    }
    const executeTurn = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        conversationId: 'conversation-parallel-hint',
        currentNode: 'node-parallel-tools',
        output: '',
        toolCalls: [
          { id: 'internal-lookup', name: 'lookup', arguments: '{"key":"stone"}' },
          { id: 'internal-write', name: 'write', arguments: '{"value":"plus"}' },
        ],
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        conversationId: 'conversation-parallel-hint',
        currentNode: 'node-after-parallel-tools',
        output: 'Both independent calls completed.',
        toolCalls: [],
      })
    const runtime = responsesRuntime(executeTurn)
    const signal = new AbortController().signal

    const first = await runtime.responses({
      input: 'Read and update independently.',
      tools: [lookup, write],
      parallel_tool_calls: false,
      stream: true,
    }, 'token', signal)
    const firstEvents = responseEvents(await first.text())
    const calls = firstEvents.filter((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'function_call'
    )).map((event) => event.item as { call_id: string; name: string })
    expect(calls).toHaveLength(2)
    expect(firstEvents.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { parallel_tool_calls: false, error: null },
    })

    const continuation = await runtime.responses({
      input: calls.map((call) => ({
        type: 'function_call_output',
        call_id: call.call_id,
        output: `${call.name} completed`,
      })),
      tools: [lookup, write],
      parallel_tool_calls: false,
      stream: true,
    }, 'token', signal)
    const continuationEvents = responseEvents(await continuation.text())
    expect(continuationEvents.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { status: 'completed' },
    })
    expect(JSON.stringify(continuationEvents)).toContain('Both independent calls completed.')
    expect(executeTurn).toHaveBeenCalledTimes(2)
    expect(executeTurn.mock.calls[0]?.[0]).toMatchObject({ parallelToolCalls: false })
    expect(executeTurn.mock.calls[1]?.[0]).toMatchObject({
      conversationId: 'conversation-parallel-hint',
      parentMessageId: 'node-parallel-tools',
      messages: [
        expect.objectContaining({ author: expect.objectContaining({ role: 'tool' }) }),
        expect.objectContaining({ author: expect.objectContaining({ role: 'tool' }) }),
      ],
    })
  })

  it('rejects required or specifically selected tools that were not declared', async () => {
    const executeTurn = vi.fn(async () => ({ status: 200, ok: true, output: 'unexpected' }))
    const runtime = responsesRuntime(executeTurn)
    const signal = new AbortController().signal

    const required = await runtime.responses({
      input: 'Use a tool.', tool_choice: 'required', stream: true,
    }, 'token', signal)
    expect(required.status).toBe(400)
    expect(await required.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request_error', param: 'tool_choice' },
    })

    const selected = await runtime.responses({
      input: 'Use lookup.',
      tools: [{ type: 'function', name: 'other', parameters: { type: 'object', properties: {} } }],
      tool_choice: { type: 'function', name: 'lookup' },
      stream: true,
    }, 'token', signal)
    expect(selected.status).toBe(400)
    expect(await selected.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request_error', param: 'tool_choice' },
    })
    expect(executeTurn).not.toHaveBeenCalled()
  })

  it('propagates downstream stream cancellation to the active Work turn', async () => {
    let turnSignal: AbortSignal | undefined
    let resolveTurn!: (value: Record<string, unknown>) => void
    const runtime = responsesRuntime(async (_value, _token, signal) => {
      turnSignal = signal
      return await new Promise<Record<string, unknown>>((resolve) => { resolveTurn = resolve })
    })
    const response = await runtime.responses({ input: 'cancel', stream: true }, 'token', new AbortController().signal)
    const reader = response.body?.getReader()
    await reader?.cancel('client closed')
    expect(turnSignal?.aborted).toBe(true)
    resolveTurn({ status: 200, ok: true, output: 'ignored after cancellation' })
  })

  it('runs requests concurrently inside one account runtime', async () => {
    let active = 0
    let maximumActive = 0
    let entered = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
    let resolveBothEntered!: () => void
    const bothEntered = new Promise<void>((resolve) => { resolveBothEntered = resolve })
    const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as {
      search: ChatGptWebWmProtocolRuntime['search']
      initialize: () => Promise<void>
      ensureProtocolReady: () => Promise<void>
      executeTurn: () => Promise<{
        status: number
        ok: boolean
        output: string
        observedModel: string
      }>
    }
    runtime.initialize = async () => undefined
    runtime.ensureProtocolReady = async () => undefined
    runtime.executeTurn = async () => {
      entered += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (entered === 2) resolveBothEntered()
      await barrier
      active -= 1
      return {
        status: 200,
        ok: true,
        output: 'parallel result',
        observedModel: 'gpt-5.6-sol-wm',
      }
    }
    const controller = new AbortController()
    const first = runtime.search({ commands: {} }, 'token', controller.signal)
    const second = runtime.search({ commands: {} }, 'token', controller.signal)
    let enteredTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        bothEntered,
        new Promise<never>((_resolve, reject) => {
          enteredTimer = setTimeout(() => reject(new Error('Runtime serialized concurrent searches')), 1_000)
        }),
      ])
      expect(maximumActive).toBe(2)
    } finally {
      if (enteredTimer) clearTimeout(enteredTimer)
      releaseBarrier()
    }
    const responses = await Promise.all([first, second])
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { encrypted_output: null, output: 'parallel result', results: null },
      { encrypted_output: null, output: 'parallel result', results: null },
    ])
  })

  it('bridges one native Work function call and its result back into the same conversation', async () => {
    const turns: Array<Record<string, unknown>> = []
    let turn = 0
    const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as unknown as {
      responses: ChatGptWebWmProtocolRuntime['responses']
      initialize: () => Promise<void>
      ensureProtocolReady: () => Promise<void>
      executeTurn: (value: Record<string, unknown>) => Promise<Record<string, unknown>>
      responseBindings: Map<string, unknown>
      reasoningStateBindings: Map<string, unknown>
      toolCallBindings: Map<string, unknown>
      conversationCleanupTimers: Map<string, ReturnType<typeof setTimeout>>
      disposed: boolean
    }
    runtime.initialize = async () => undefined
    runtime.ensureProtocolReady = async () => undefined
    runtime.responseBindings = new Map()
    runtime.reasoningStateBindings = new Map()
    runtime.toolCallBindings = new Map()
    runtime.conversationCleanupTimers = new Map()
    runtime.disposed = false
    runtime.executeTurn = async (value) => {
      turns.push(value)
      turn += 1
      return turn === 1
        ? {
            status: 200,
            ok: true,
            observedModel: 'gpt-5.6-sol-wm',
            conversationId: 'conversation-native',
            currentNode: 'turn-native',
            output: '',
            toolCalls: [{ id: 'call-native', name: 'lookup', arguments: '{"key":"stone"}' }],
          }
        : turn === 2 ? {
            status: 200,
            ok: true,
            observedModel: 'gpt-5.6-sol-wm',
            conversationId: 'conversation-native',
            currentNode: 'message-final',
            output: 'tool loop complete',
            toolCalls: [],
          }
          : {
              status: 200,
              ok: true,
              observedModel: 'gpt-5.6-sol-wm',
              conversationId: 'conversation-native',
              currentNode: 'message-follow-up',
              output: 'continued response',
              toolCalls: [],
            }
    }
    const controller = new AbortController()
    const declaration = {
      type: 'function', name: 'lookup', description: 'Look up a value.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    }

    const first = await runtime.responses({
      model: 'gpt-5.6-sol-wm', input: 'Use lookup.', tools: [declaration], stream: true,
    }, 'token', controller.signal)
    const firstWire = await first.text()
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    expect(firstWire).toContain('event: response.function_call_arguments.done')
    expect(firstWire).toContain('"name":"lookup"')
    expect(firstWire).toContain('event: response.completed')
    const firstEvents = responseEvents(firstWire)
    expect(firstEvents.find((event) => event.type === 'response.function_call_arguments.done'))
      .toMatchObject({ arguments: '{"key":"stone"}' })
    const argumentsDelta = firstEvents.find((event) => (
      event.type === 'response.function_call_arguments.delta'
    ))
    expect(Object.keys(argumentsDelta ?? {}).sort()).toEqual([
      'delta', 'item_id', 'obfuscation', 'output_index', 'sequence_number', 'type',
    ])
    expect(Object.keys(firstEvents.find((event) => (
      event.type === 'response.function_call_arguments.done'
    )) ?? {}).sort()).toEqual([
      'arguments', 'item_id', 'name', 'output_index', 'sequence_number', 'type',
    ])
    const functionItem = firstEvents.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'function_call'
    ))?.item as { call_id?: string }
    expect(functionItem.call_id).toMatch(/^call_[a-f0-9]+$/)
    const publicCallId = functionItem.call_id!

    const second = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: [
        { type: 'function_call', call_id: publicCallId, name: 'lookup', arguments: '{"key":"stone"}' },
        { type: 'function_call_output', call_id: publicCallId, output: '{"value":"plus"}' },
      ],
      tools: [declaration],
      stream: true,
    }, 'token', controller.signal)
    const secondWire = await second.text()
    expect(secondWire).toContain('tool loop complete')
    expect(turns[1]).toMatchObject({
      prompt: '',
      conversationId: 'conversation-native',
      parentMessageId: 'turn-native',
      messages: [{
        author: { role: 'tool', name: 'lookup' },
        content: { content_type: 'code', language: 'python3' },
      }],
    })
    expect(JSON.parse(String((turns[1].messages as Array<{ content: { text: string } }>)[0].content.text)))
      .toEqual({ call_id: publicCallId, result: { value: 'plus' }, tool: 'lookup' })

    const replay = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: [
        { type: 'function_call', call_id: publicCallId, name: 'lookup', arguments: '{"key":"stone"}' },
        { type: 'function_call_output', call_id: publicCallId, output: '{"value":"plus"}' },
      ],
      tools: [declaration],
      stream: true,
    }, 'token', controller.signal)
    expect(await replay.text()).toBe(secondWire)
    expect(turns).toHaveLength(2)

    const changedContinuation = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: [
        { type: 'function_call', call_id: publicCallId, name: 'lookup', arguments: '{"key":"stone"}' },
        { type: 'function_call_output', call_id: publicCallId, output: '{"value":"plus"}' },
        { type: 'message', role: 'user', content: 'Start a different turn.' },
      ],
      tools: [declaration],
      stream: true,
    }, 'token', controller.signal)
    expect(changedContinuation.status).toBe(400)
    expect(await changedContinuation.json()).toMatchObject({
      error: { code: 'web_wm_state_not_found' },
    })
    expect(turns).toHaveLength(2)

    const secondEvents = secondWire.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const secondTerminal = secondEvents.find((event) => event.type === 'response.completed') as {
      response: { id: string }
    }
    const third = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      previous_response_id: secondTerminal.response.id,
      input: 'Continue from the prior final answer.',
      stream: true,
    }, 'token', controller.signal)
    expect(await third.text()).toContain('continued response')
    expect(turns[2]).toMatchObject({
      conversationId: 'conversation-native',
      parentMessageId: 'message-final',
      hideOnFinal: false,
    })
    for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
  })

  it('single-flights overlapping submissions of the same tool result', async () => {
    const turns: Array<Record<string, unknown>> = []
    let resolveContinuation!: (value: Record<string, unknown>) => void
    let continuationStarted!: () => void
    const started = new Promise<void>((resolve) => { continuationStarted = resolve })
    const continuation = new Promise<Record<string, unknown>>((resolve) => {
      resolveContinuation = resolve
    })
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-overlapping-result',
          currentNode: 'node-overlapping-call',
          output: '',
          toolCalls: [{ id: 'work-overlapping-call', name: 'exec', arguments: 'Get-Location' }],
        }
      }
      continuationStarted()
      return continuation
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run a command.', tools: [declaration], stream: true,
      }, 'token', signal)
      const firstCall = responseEvents(await first.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id: string; input: string }
      const resultInput: Array<Record<string, unknown>> = [
        {
          type: 'custom_tool_call', call_id: firstCall.call_id,
          name: 'exec', input: firstCall.input,
        },
        {
          type: 'custom_tool_call_output', call_id: firstCall.call_id,
          output: [{ type: 'input_text', text: 'D:\\project\\stone+' }],
        },
      ]

      const owner = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(resultInput),
        tools: [declaration], stream: true,
      }, 'token', signal)
      await started
      let duplicateSettled = false
      const duplicatePromise = runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(resultInput),
        tools: [declaration], stream: true,
      }, 'token', signal).finally(() => { duplicateSettled = true })
      const conflictingInput = structuredClone(resultInput)
      conflictingInput[1].output = [{ type: 'input_text', text: 'tampered result' }]
      let conflictSettled = false
      const conflictPromise = runtime.responses({
        model: 'gpt-5.6-sol-wm', input: conflictingInput,
        tools: [declaration], stream: true,
      }, 'token', signal).finally(() => { conflictSettled = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(duplicateSettled).toBe(false)
      expect(conflictSettled).toBe(false)
      expect(turns).toHaveLength(2)

      resolveContinuation({
        status: 200,
        ok: true,
        conversationId: 'conversation-overlapping-result',
        currentNode: 'node-overlapping-final',
        output: 'Overlapping result completed once.',
        toolCalls: [],
      })
      const ownerWire = await owner.text()
      const duplicate = await duplicatePromise
      expect(await duplicate.text()).toBe(ownerWire)
      const conflict = await conflictPromise
      expect(conflict.status).toBe(400)
      expect(await conflict.json()).toMatchObject({
        error: { code: 'web_wm_state_not_found' },
      })
      expect(turns).toHaveLength(2)
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('coalesces identical tool outputs in one request and rejects conflicting duplicates', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-duplicate-output',
          currentNode: 'node-duplicate-output-call',
          output: '',
          toolCalls: [{ id: 'work-duplicate-output-call', name: 'exec', arguments: 'Get-Location' }],
        }
      }
      return {
        status: 200,
        ok: true,
        conversationId: 'conversation-duplicate-output',
        currentNode: 'node-duplicate-output-final',
        output: 'Duplicate output was submitted once.',
        toolCalls: [],
      }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run a command.', tools: [declaration], stream: true,
      }, 'token', signal)
      const firstCall = responseEvents(await first.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id: string; input: string }
      const call = {
        type: 'custom_tool_call', call_id: firstCall.call_id,
        name: 'exec', input: firstCall.input,
      }
      const conflicting = await runtime.responses({
        model: 'gpt-5.6-sol-wm', tools: [declaration], stream: true,
        input: [
          call,
          { type: 'custom_tool_call_output', call_id: firstCall.call_id, output: 'first' },
          { type: 'custom_tool_call_output', call_id: firstCall.call_id, output: 'second' },
        ],
      }, 'token', signal)
      expect(conflicting.status).toBe(400)
      expect(await conflicting.json()).toMatchObject({
        error: { code: 'invalid_request_error', param: 'input' },
      })
      expect(turns).toHaveLength(1)

      const identicalOutput = {
        type: 'custom_tool_call_output', call_id: firstCall.call_id, output: 'same result',
      }
      const continued = await runtime.responses({
        model: 'gpt-5.6-sol-wm', tools: [declaration], stream: true,
        input: [call, identicalOutput, structuredClone(identicalOutput)],
      }, 'token', signal)
      expect(await continued.text()).toContain('Duplicate output was submitted once.')
      expect(turns).toHaveLength(2)
      expect(turns[1]).toMatchObject({
        conversationId: 'conversation-duplicate-output',
        parentMessageId: 'node-duplicate-output-call',
      })
      expect(turns[1].messages).toEqual([
        expect.objectContaining({ author: { role: 'tool', name: 'exec', metadata: {} } }),
      ])
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('lets a cancelled duplicate stop waiting without cancelling the owning tool-result turn', async () => {
    const turns: Array<Record<string, unknown>> = []
    let resolveContinuation!: (value: Record<string, unknown>) => void
    let continuationStarted!: () => void
    const started = new Promise<void>((resolve) => { continuationStarted = resolve })
    const continuation = new Promise<Record<string, unknown>>((resolve) => {
      resolveContinuation = resolve
    })
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-cancelled-duplicate',
          currentNode: 'node-cancelled-duplicate-call',
          output: '',
          toolCalls: [{ id: 'work-cancelled-duplicate-call', name: 'exec', arguments: 'Get-Date' }],
        }
      }
      continuationStarted()
      return continuation
    })
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }
    const ownerSignal = new AbortController().signal

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run a command.', tools: [declaration], stream: true,
      }, 'token', ownerSignal)
      const firstCall = responseEvents(await first.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id: string; input: string }
      const resultInput: Array<Record<string, unknown>> = [
        {
          type: 'custom_tool_call', call_id: firstCall.call_id,
          name: 'exec', input: firstCall.input,
        },
        {
          type: 'custom_tool_call_output', call_id: firstCall.call_id,
          output: [{ type: 'input_text', text: 'cancel test result' }],
        },
      ]
      const owner = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(resultInput),
        tools: [declaration], stream: true,
      }, 'token', ownerSignal)
      await started

      const duplicateController = new AbortController()
      const duplicate = runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(resultInput),
        tools: [declaration], stream: true,
      }, 'token', duplicateController.signal)
      const cancellation = new Error('duplicate client disconnected')
      duplicateController.abort(cancellation)
      await expect(duplicate).rejects.toBe(cancellation)
      expect(turns).toHaveLength(2)

      resolveContinuation({
        status: 200,
        ok: true,
        conversationId: 'conversation-cancelled-duplicate',
        currentNode: 'node-cancelled-duplicate-final',
        output: 'Owner completed.',
        toolCalls: [],
      })
      expect(await owner.text()).toContain('Owner completed.')
      expect(turns).toHaveLength(2)
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('continues sequential native Work tool calls while Codex replays earlier tool history', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-sequential-tools',
          currentNode: 'node-first-tool',
          output: '',
          toolCalls: [{ id: 'work-first-tool', name: 'exec', arguments: 'Get-Location' }],
        }
      }
      if (turns.length === 2) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-sequential-tools',
          currentNode: 'node-second-tool',
          output: '',
          toolCalls: [{ id: 'work-second-tool', name: 'exec', arguments: 'Get-ChildItem' }],
        }
      }
      return {
        status: 200,
        ok: true,
        conversationId: 'conversation-sequential-tools',
        currentNode: 'node-final',
        output: 'Both commands completed.',
        toolCalls: [],
      }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a PowerShell command.' }
    const firstCallInput = 'Get-Location'
    const firstOutput = [{ type: 'input_text', text: 'D:\\project\\stone+' }]

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run both checks.', tools: [declaration], stream: true,
      }, 'token', signal)
      const firstCall = responseEvents(await first.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string }
      expect(firstCall.call_id).toMatch(/^call_[a-f0-9]+$/)

      const secondInput = [
        { type: 'custom_tool_call', call_id: firstCall.call_id, name: 'exec', input: firstCallInput },
        { type: 'custom_tool_call_output', call_id: firstCall.call_id, output: firstOutput },
      ]
      const second = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: secondInput, tools: [declaration], stream: true,
      }, 'token', signal)
      const secondWire = await second.text()
      const secondCall = responseEvents(secondWire).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string }
      expect(secondCall.call_id).toMatch(/^call_[a-f0-9]+$/)

      const thirdInput = [
        ...secondInput,
        { type: 'custom_tool_call', call_id: secondCall.call_id, name: 'exec', input: 'Get-ChildItem' },
        {
          type: 'custom_tool_call_output',
          call_id: secondCall.call_id,
          output: [{ type: 'input_text', text: 'tool_smoke_test.ps1' }],
        },
      ]
      const tamperedHistory = structuredClone(thirdInput)
      ;(tamperedHistory[1] as { output: unknown }).output = [{ type: 'input_text', text: 'tampered' }]
      const rejected = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: tamperedHistory, tools: [declaration], stream: true,
      }, 'token', signal)
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ error: { code: 'web_wm_state_not_found' } })

      const third = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: thirdInput, tools: [declaration], stream: true,
      }, 'token', signal)
      const thirdWire = await third.text()
      expect(third.status).toBe(200)
      expect(thirdWire).toContain('Both commands completed.')
      expect(turns).toHaveLength(3)
      expect(turns[2]).toMatchObject({
        conversationId: 'conversation-sequential-tools',
        parentMessageId: 'node-second-tool',
        messages: [{ author: { role: 'tool', name: 'exec' } }],
      })
      expect(turns[2].messages).toHaveLength(1)
      expect(String((turns[2].messages as Array<{ content: { text: string } }>)[0].content.text))
        .toContain('tool_smoke_test.ps1')
      expect(String((turns[2].messages as Array<{ content: { text: string } }>)[0].content.text))
        .not.toContain('D:\\project\\stone+')

      const replay = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: thirdInput, tools: [declaration], stream: true,
      }, 'token', signal)
      expect(await replay.text()).toBe(thirdWire)
      expect(turns).toHaveLength(3)
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('validates accumulated tool history after its exact replay cache expires', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      const index = turns.length
      if (index <= 3) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-long-debug-session',
          currentNode: `node-tool-${index}`,
          output: '',
          toolCalls: [{ id: `work-tool-${index}`, name: 'exec', arguments: `command-${index}` }],
        }
      }
      return {
        status: 200,
        ok: true,
        conversationId: 'conversation-long-debug-session',
        currentNode: 'node-final',
        output: 'Long debugging session completed.',
        toolCalls: [],
      }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    const history: Array<Record<string, unknown>> = []

    const appendToolRound = async (response: Response, output: string): Promise<void> => {
      const call = responseEvents(await response.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string; input?: string }
      expect(call.call_id).toMatch(/^call_[a-f0-9]+$/)
      history.push(
        { type: 'custom_tool_call', call_id: call.call_id, name: 'exec', input: call.input },
        {
          type: 'custom_tool_call_output',
          call_id: call.call_id,
          output: [{ type: 'input_text', text: output }],
        },
      )
    }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run a long debugging workflow.', tools: [declaration], stream: true,
      }, 'token', signal)
      await appendToolRound(first, 'output-1')

      const second = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(history), tools: [declaration], stream: true,
      }, 'token', signal)
      await appendToolRound(second, 'output-2')

      now.mockReturnValue(startedAt + 30 * 60 * 1_000)
      const third = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(history), tools: [declaration], stream: true,
      }, 'token', signal)
      await appendToolRound(third, 'output-3')

      // The first turn's full SSE replay has expired, while the newest tool
      // binding and the hidden Work conversation are still active.
      now.mockReturnValue(startedAt + 70 * 60 * 1_000)
      const tamperedHistory = structuredClone(history)
      tamperedHistory[1].output = [{ type: 'input_text', text: 'tampered-output-1' }]
      const rejected = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: tamperedHistory, tools: [declaration], stream: true,
      }, 'token', signal)
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ error: { code: 'web_wm_state_not_found' } })
      expect(turns).toHaveLength(3)

      const final = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(history), tools: [declaration], stream: true,
      }, 'token', signal)
      const finalWire = await final.text()
      expect(final.status).toBe(200)
      expect(finalWire).toContain('Long debugging session completed.')
      expect(turns).toHaveLength(4)
      expect(turns[3]).toMatchObject({
        conversationId: 'conversation-long-debug-session',
        parentMessageId: 'node-tool-3',
        messages: [{ author: { role: 'tool', name: 'exec' } }],
      })
      expect(turns[3].messages).toHaveLength(1)
      expect(String((turns[3].messages as Array<{ content: { text: string } }>)[0].content.text))
        .toContain('output-3')

      const replay = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(history), tools: [declaration], stream: true,
      }, 'token', signal)
      expect(await replay.text()).toBe(finalWire)
      expect(turns).toHaveLength(4)
    } finally {
      now.mockRestore()
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('keeps consumed tool receipts when a completed SSE is too large to replay', async () => {
    const turns: Array<Record<string, unknown>> = []
    const largeCommentary = 'x'.repeat(530_000)
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-large-sse',
          currentNode: 'node-large-first',
          output: '',
          toolCalls: [{ id: 'work-large-first', name: 'exec', arguments: 'command-1' }],
        }
      }
      if (turns.length === 2) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-large-sse',
          currentNode: 'node-large-second',
          output: largeCommentary,
          toolCalls: [{ id: 'work-large-second', name: 'exec', arguments: 'command-2' }],
        }
      }
      return {
        status: 200,
        ok: true,
        conversationId: 'conversation-large-sse',
        currentNode: 'node-large-final',
        output: 'Large-output workflow completed.',
        toolCalls: [],
      }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: 'Run two commands.', tools: [declaration], stream: true,
      }, 'token', signal)
      const firstCall = responseEvents(await first.text()).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string; input?: string }
      const history: Array<Record<string, unknown>> = [
        { type: 'custom_tool_call', call_id: firstCall.call_id, name: 'exec', input: firstCall.input },
        {
          type: 'custom_tool_call_output', call_id: firstCall.call_id,
          output: [{ type: 'input_text', text: 'output-1' }],
        },
      ]

      const second = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: structuredClone(history), tools: [declaration], stream: true,
      }, 'token', signal)
      const secondWire = await second.text()
      expect(Buffer.byteLength(secondWire, 'utf8')).toBeGreaterThan(512 * 1024)
      const secondCall = responseEvents(secondWire).find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string; input?: string }
      history.push(
        { type: 'custom_tool_call', call_id: secondCall.call_id, name: 'exec', input: secondCall.input },
        {
          type: 'custom_tool_call_output', call_id: secondCall.call_id,
          output: [{ type: 'input_text', text: 'output-2' }],
        },
      )

      const final = await runtime.responses({
        model: 'gpt-5.6-sol-wm', input: history, tools: [declaration], stream: true,
      }, 'token', signal)
      expect(final.status).toBe(200)
      expect(await final.text()).toContain('Large-output workflow completed.')
      expect(turns).toHaveLength(3)
      expect(turns[2]).toMatchObject({
        conversationId: 'conversation-large-sse',
        parentMessageId: 'node-large-second',
        messages: [{ author: { role: 'tool', name: 'exec' } }],
      })
      expect(turns[2].messages).toHaveLength(1)
      expect(String((turns[2].messages as Array<{ content: { text: string } }>)[0].content.text))
        .toContain('output-2')
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('emits an opaque continuation state for a tool-only turn when Codex requests it', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      return turns.length === 1
        ? {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-only-state',
            currentNode: 'node-tool-only-call',
            output: '',
            toolCalls: [{ id: 'work-tool-only-call', name: 'exec', arguments: 'Get-Location' }],
          }
        : {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-only-state',
            currentNode: 'node-tool-only-final',
            output: 'The tool-only continuation completed.',
            toolCalls: [],
          }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a command.' }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm',
        input: 'Run a harmless command.',
        tools: [declaration],
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, 'token', signal)
      const firstEvents = responseEvents(await first.text())
      const completed = firstEvents.find((event) => event.type === 'response.completed') as {
        response: {
          output: Array<Record<string, unknown>>
          usage: { output_tokens_details: { reasoning_tokens: number } }
        }
      }
      expect(completed.response.output.map((item) => item.type)).toEqual([
        'reasoning',
        'custom_tool_call',
      ])
      const reasoningState = completed.response.output[0]
      expect(reasoningState.encrypted_content).toMatch(/^wmrs_[A-Za-z0-9_-]{100,}$/)
      expect(completed.response.usage.output_tokens_details.reasoning_tokens).toBe(0)
      const toolCall = completed.response.output[1] as { call_id: string }

      const second = await runtime.responses({
        model: 'gpt-5.6-sol-wm',
        input: [
          reasoningState,
          completed.response.output[1],
          {
            type: 'custom_tool_call_output',
            call_id: toolCall.call_id,
            output: [{ type: 'input_text', text: 'D:\\project\\stone+' }],
          },
        ],
        tools: [declaration],
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, 'token', signal)

      expect(second.status, await second.clone().text()).toBe(200)
      expect(await second.text()).toContain('The tool-only continuation completed.')
      expect(turns).toHaveLength(2)
      expect(turns[1]).toMatchObject({
        conversationId: 'conversation-tool-only-state',
        parentMessageId: 'node-tool-only-call',
        messages: [{ author: { role: 'tool', name: 'exec' } }],
      })
      expect(turns[1].messages).toHaveLength(1)
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('ignores a consumed custom tool output replayed by Codex legacy history', async () => {
    const turns: Array<Record<string, unknown>> = []
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      if (turns.length === 1) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-legacy-tool',
          currentNode: 'node-legacy-tool-call',
          output: '',
          toolCalls: [{ id: 'work-exec-call', name: 'exec', arguments: 'Get-ChildItem' }],
        }
      }
      if (turns.length === 2) {
        return {
          status: 200,
          ok: true,
          conversationId: 'conversation-legacy-tool',
          currentNode: 'node-legacy-tool-final',
          reasoningMessageId: 'reasoning-legacy-tool-final',
          output: 'The command completed.',
          toolCalls: [],
        }
      }
      return {
        status: 200,
        ok: true,
        conversationId: 'conversation-legacy-tool',
        currentNode: 'node-legacy-follow-up',
        output: 'The follow-up completed.',
        toolCalls: [],
      }
    })
    const signal = new AbortController().signal
    const declaration = { type: 'custom', name: 'exec', description: 'Run a PowerShell command.' }

    try {
      const first = await runtime.responses({
        model: 'gpt-5.6-sol-wm',
        input: 'Run a harmless command.',
        tools: [declaration],
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, 'token', signal)
      const firstEvents = responseEvents(await first.text())
      const toolCall = firstEvents.find((event) => (
        event.type === 'response.output_item.done'
        && (event.item as { type?: string })?.type === 'custom_tool_call'
      ))?.item as { call_id?: string; input?: string }
      expect(toolCall).toMatchObject({ input: 'Get-ChildItem' })
      expect(toolCall.call_id).toMatch(/^call_[a-f0-9]+$/)
      const publicCallId = toolCall.call_id!

      const second = await runtime.responses({
        model: 'gpt-5.6-sol-wm',
        input: [
          { type: 'custom_tool_call', call_id: publicCallId, name: 'exec', input: 'Get-ChildItem' },
          {
            type: 'custom_tool_call_output',
            call_id: publicCallId,
            output: [{ type: 'input_text', text: 'Directory listing' }],
          },
        ],
        tools: [declaration],
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, 'token', signal)
      const secondEvents = responseEvents(await second.text())
      const completed = secondEvents.find((event) => event.type === 'response.completed') as {
        response: { output: Array<Record<string, unknown>> }
      }
      const reasoningState = completed.response.output.find((item) => item.type === 'reasoning')
        ?.encrypted_content as string
      expect(reasoningState).toMatch(/^wmrs_[A-Za-z0-9_-]{100,}$/)

      const third = await runtime.responses({
        model: 'gpt-5.6-sol-wm',
        input: [
          {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'Run a harmless command.' }],
          },
          { type: 'custom_tool_call', call_id: publicCallId, name: 'exec', input: 'Get-ChildItem' },
          {
            type: 'custom_tool_call_output',
            call_id: publicCallId,
            output: [{ type: 'input_text', text: 'Directory listing' }],
          },
          { type: 'reasoning', summary: [], encrypted_content: reasoningState },
          {
            type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
            content: [{ type: 'output_text', text: 'The command completed.' }],
          },
          {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'Now continue without another tool call.' }],
          },
        ],
        tools: [declaration],
        include: ['reasoning.encrypted_content'],
        stream: true,
      }, 'token', signal)

      expect(third.status, await third.clone().text()).toBe(200)
      expect(await third.text()).toContain('The follow-up completed.')
      expect(turns).toHaveLength(3)
      expect(turns[2]).toMatchObject({
        conversationId: 'conversation-legacy-tool',
        parentMessageId: 'node-legacy-tool-final',
      })
      expect(String(turns[2].prompt)).toContain('Now continue without another tool call.')
      expect(String(turns[2].prompt)).not.toContain('Directory listing')
    } finally {
      for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
    }
  })

  it('preserves a required discovered tool choice after a tool-search result', async () => {
    const turns: Array<Record<string, unknown>> = []
    let turn = 0
    const runtime = responsesRuntime(async (value) => {
      turns.push(value)
      turn += 1
      return turn === 1
        ? {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-search',
            currentNode: 'tool-search-node',
            output: '',
            toolCalls: [{
              id: 'work-search-call',
              name: 'search_tools',
              arguments: '{"query":"stone","limit":3}',
            }],
          }
        : {
            status: 200,
            ok: true,
            conversationId: 'conversation-tool-search',
            currentNode: 'discovered-tool-node',
            output: '',
            toolCalls: [{
              id: 'work-discovered-call',
              name: 'stone_found__resolve',
              arguments: '{"value":"stone"}',
            }],
          }
    })
    const controller = new AbortController()
    const searchDeclaration = {
      type: 'tool_search',
      execution: 'client',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    }
    const discoveredNamespace = {
      type: 'namespace',
      name: 'stone_found',
      tools: [{
        type: 'function',
        name: 'resolve',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
    }

    const search = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: 'Find a tool.',
      tools: [searchDeclaration],
      tool_choice: { type: 'tool_search' },
      stream: true,
    }, 'token', controller.signal)
    const searchEvents = responseEvents(await search.text())
    const searchItem = searchEvents.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'tool_search_call'
    ))?.item as { call_id?: string }
    expect(searchItem.call_id).toMatch(/^call_[a-f0-9]+$/)

    const discovered = await runtime.responses({
      model: 'gpt-5.6-sol-wm',
      input: [
        searchItem,
        {
          type: 'tool_search_output',
          call_id: searchItem.call_id,
          execution: 'client',
          status: 'completed',
          tools: [discoveredNamespace],
        },
      ],
      tools: [searchDeclaration],
      tool_choice: { type: 'function', name: 'resolve', namespace: 'stone_found' },
      stream: true,
    }, 'token', controller.signal)
    const discoveredEvents = responseEvents(await discovered.text())
    expect(discoveredEvents.find((event) => (
      event.type === 'response.output_item.done'
      && (event.item as { type?: string })?.type === 'function_call'
    ))?.item).toMatchObject({ name: 'resolve', namespace: 'stone_found' })
    expect(turns[1]).toMatchObject({
      conversationId: 'conversation-tool-search',
      parentMessageId: 'tool-search-node',
      messages: [
        { author: { role: 'tool', name: 'search_tools' } },
        {
          author: { role: 'user' },
          content: {
            content_type: 'text',
            parts: [expect.stringContaining('stone_found.resolve')],
          },
        },
      ],
    })
    for (const timer of runtime.conversationCleanupTimers.values()) clearTimeout(timer)
  })

  it('runs cold protocol discovery as a single flight', async () => {
    let discoveries = 0
    let releaseDiscovery!: () => void
    const discoveryBarrier = new Promise<void>((resolve) => { releaseDiscovery = resolve })
    const runtime = Object.create(ChatGptWebWmProtocolRuntime.prototype) as {
      disposed: boolean
      protocolReadyOperation?: Promise<void>
      ensureProtocolReady: () => Promise<void>
      discoverProtocol: () => Promise<void>
    }
    runtime.disposed = false
    runtime.discoverProtocol = async () => {
      discoveries += 1
      await discoveryBarrier
    }

    const first = runtime.ensureProtocolReady()
    const second = runtime.ensureProtocolReady()
    expect(discoveries).toBe(1)
    releaseDiscovery()
    await Promise.all([first, second])
    expect(discoveries).toBe(1)
  })
})
