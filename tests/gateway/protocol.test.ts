import { describe, expect, it } from 'vitest'
import { analyzeProtocolConversion, convertRequest, convertResponse, getRequestModel } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000

describe('gateway protocol conversion', () => {
  it('preserves Responses image input when converting to Anthropic', () => {
    const body = {
      model: 'gpt',
      input: [{
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'data:image/png;base64,YQ==' }
        ]
      }]
    }
    expect(analyzeProtocolConversion('openai-responses', 'anthropic-messages', body)).toEqual({
      supported: true,
      issues: []
    })
    expect(convertRequest('openai-responses', 'anthropic-messages', body, 'claude').body).toMatchObject({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }
      ] }]
    })
  })

  it('rejects built-in tools instead of silently deleting them during conversion', () => {
    expect(analyzeProtocolConversion('openai-responses', 'anthropic-messages', {
      model: 'gpt', input: 'hello', tools: [{ type: 'web_search_preview' }], tool_choice: 'auto'
    })).toMatchObject({
      supported: false,
      issues: [{ path: 'tools[0]', capability: 'builtin-tool' }]
    })
  })

  it('rejects structured output options that the target protocol cannot preserve', () => {
    expect(analyzeProtocolConversion('openai-chat', 'anthropic-messages', {
      model: 'gpt', messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } }
    })).toMatchObject({
      supported: false,
      issues: [{ path: 'response_format', capability: 'request-option' }]
    })
    expect(analyzeProtocolConversion('openai-responses', 'gemini', {
      model: 'gpt', input: 'hello', text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } }
    })).toMatchObject({
      supported: false,
      issues: [{ path: 'text.format', capability: 'request-option' }]
    })
  })

  it('allows strict tools only when the target conversion preserves strictness', () => {
    const body = {
      model: 'gpt', messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'answer', strict: true, parameters: { type: 'object' } } }]
    }
    expect(analyzeProtocolConversion('openai-chat', 'openai-responses', body)).toEqual({
      supported: true,
      issues: []
    })
    expect(analyzeProtocolConversion('openai-chat', 'gemini', body)).toMatchObject({
      supported: false,
      issues: [{ path: 'tools[0].function.strict', capability: 'request-option' }]
    })
  })

  it('converts Anthropic messages and tools to OpenAI chat', () => {
    const converted = convertRequest('anthropic-messages', 'openai-chat', {
      model: 'source-model',
      system: 'Be concise.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      max_tokens: 128,
      tools: [{ name: 'lookup', description: 'Find a value', input_schema: { type: 'object' } }]
    }, 'target-model')

    expect(converted.body).toMatchObject({
      model: 'target-model',
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' }
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Find a value' } }]
    })
  })

  it('converts an OpenAI chat response to Anthropic usage and tool blocks', () => {
    const converted = convertResponse('openai-chat', 'anthropic-messages', {
      id: 'chat-1',
      model: 'target-model',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Checking',
          tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":1}' } }]
        }
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5 }
    }, 'fallback-model')

    expect(converted).toMatchObject({
      id: 'chat-1',
      type: 'message',
      model: 'target-model',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } }
      ],
      usage: { input_tokens: 12, output_tokens: 5 }
    })
  })

  it('reads and decodes a Gemini model from the request path', () => {
    expect(getRequestModel('gemini', {}, '/v1beta/models/gemini-2.5%20pro:generateContent'))
      .toBe('gemini-2.5 pro')
  })

  it('converts OpenAI chat requests to Gemini contents and generation config', () => {
    const converted = convertRequest('openai-chat', 'gemini', {
      model: 'source-model',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 64,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    }, 'gemini-target')

    expect(converted).toMatchObject({
      protocol: 'gemini',
      model: 'gemini-target',
      body: {
        systemInstruction: { parts: [{ text: 'Be precise.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] }]
      }
    })
  })

  it('composes non-chat response conversions through the chat representation', () => {
    const converted = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'message-1',
      model: 'claude-model',
      content: [{ type: 'text', text: 'Hello from Claude' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 }
    }, 'fallback-model', () => timestamp)

    expect(converted).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'claude-model',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello from Claude' }] }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
    })
  })

  it('preserves modern Chat completion limits when converting to Responses and Anthropic', () => {
    const chat = {
      model: 'source-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_completion_tokens: 37
    }

    expect(convertRequest('openai-chat', 'openai-responses', chat, 'target-model').body)
      .toMatchObject({ max_output_tokens: 37 })
    expect(convertRequest('openai-chat', 'anthropic-messages', chat, 'target-model').body)
      .toMatchObject({ max_tokens: 37 })
  })

  it.each([
    ['max_output_tokens', 'length', 'max_tokens', 'MAX_TOKENS'],
    ['content_filter', 'content_filter', 'refusal', 'SAFETY']
  ] as const)('maps Responses %s termination across legacy response protocols', (
    reason,
    chatReason,
    anthropicReason,
    geminiReason
  ) => {
    const response = {
      id: 'resp-1',
      model: 'source-model',
      status: 'incomplete',
      incomplete_details: { reason },
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'partial' }]
      }]
    }

    expect(convertResponse('openai-responses', 'openai-chat', response, 'fallback-model'))
      .toMatchObject({ choices: [{ finish_reason: chatReason }] })
    expect(convertResponse('openai-responses', 'anthropic-messages', response, 'fallback-model'))
      .toMatchObject({ stop_reason: anthropicReason })
    expect(convertResponse('openai-responses', 'gemini', response, 'fallback-model'))
      .toMatchObject({ candidates: [{ finishReason: geminiReason }] })
  })

  it.each([
    ['length', 'incomplete', 'max_output_tokens'],
    ['content_filter', 'incomplete', 'content_filter']
  ] as const)('preserves Chat %s termination when converting to Responses', (
    finishReason,
    status,
    incompleteReason
  ) => {
    const converted = convertResponse('openai-chat', 'openai-responses', {
      id: 'chat-1',
      model: 'source-model',
      choices: [{
        message: { role: 'assistant', content: 'partial' },
        finish_reason: finishReason
      }]
    }, 'fallback-model')

    expect(converted).toMatchObject({
      status,
      incomplete_details: { reason: incompleteReason }
    })
  })

  it.each([
    ['max_tokens', 'incomplete', 'max_output_tokens'],
    ['refusal', 'incomplete', 'content_filter']
  ] as const)('preserves Anthropic %s termination when converting to Responses', (
    stopReason,
    status,
    incompleteReason
  ) => {
    const converted = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'msg-1',
      model: 'source-model',
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: stopReason
    }, 'fallback-model')

    expect(converted).toMatchObject({
      status,
      incomplete_details: { reason: incompleteReason }
    })
  })

  it.each([
    ['MAX_TOKENS', 'incomplete', 'max_output_tokens'],
    ['SAFETY', 'incomplete', 'content_filter']
  ] as const)('preserves Gemini %s termination when converting to Responses', (
    finishReason,
    status,
    incompleteReason
  ) => {
    const converted = convertResponse('gemini', 'openai-responses', {
      modelVersion: 'source-model',
      candidates: [{
        content: { role: 'model', parts: [{ text: 'partial' }] },
        finishReason
      }]
    }, 'fallback-model')

    expect(converted).toMatchObject({
      status,
      incomplete_details: { reason: incompleteReason }
    })
  })

  it('maps content filtering consistently between Chat, Anthropic, and Gemini', () => {
    const chat = convertResponse('openai-chat', 'anthropic-messages', {
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }]
    }, 'fallback-model')
    const anthropic = convertResponse('anthropic-messages', 'openai-chat', {
      content: [{ type: 'text', text: '' }], stop_reason: 'refusal'
    }, 'fallback-model')
    const gemini = convertResponse('gemini', 'openai-chat', {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }]
    }, 'fallback-model')

    expect(chat).toMatchObject({ stop_reason: 'refusal' })
    expect(anthropic).toMatchObject({ choices: [{ finish_reason: 'content_filter' }] })
    expect(gemini).toMatchObject({ choices: [{ finish_reason: 'content_filter' }] })
  })

  it('uses the injected clock for generated response identifiers and timestamps', () => {
    const now = () => timestamp
    const converted = convertResponse('openai-chat', 'openai-responses', {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    }, 'fallback-model', now)

    expect(converted).toMatchObject({
      id: `resp_${timestamp}`,
      created_at: Math.floor(timestamp / 1000)
    })

    const anthropic = convertResponse('openai-chat', 'anthropic-messages', {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    }, 'fallback-model', now)
    expect(anthropic).toMatchObject({ id: `msg_${timestamp}` })
  })
})
