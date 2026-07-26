import { describe, expect, it } from 'vitest'
import {
  convertAnthropicMessagesToKiroClaude,
  KiroClaudeRequestConversionError,
} from '../../src/main/gateway/kiro-claude-request'

const options = { model: 'claude-sonnet-4.6', conversationId: 'session-kiro-1' }

function convert(body: Record<string, unknown>) {
  return convertAnthropicMessagesToKiroClaude(body, options)
}

function toolUse(id: string, name = 'lookup', input: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name, input }
}

function toolResult(id: string, content: unknown = '') {
  return { type: 'tool_result', tool_use_id: id, content }
}

function tool(name = 'lookup') {
  return {
    name,
    description: `Run ${name}`,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  }
}

function expectConversionError(
  action: () => unknown,
  code: KiroClaudeRequestConversionError['code'],
  path?: string
) {
  try {
    action()
    throw new Error('expected conversion to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(KiroClaudeRequestConversionError)
    const conversionError = error as KiroClaudeRequestConversionError
    expect(conversionError.code).toBe(code)
    expect(conversionError.statusCode).toBe(422)
    if (path) expect(conversionError.path).toBe(path)
  }
}

describe('Anthropic Messages to native Kiro Claude request conversion', () => {
  it('maps system, text, model, environment, tools, and native reasoning effort', () => {
    const schema = tool().input_schema
    const result = convert({
      model: 'client-model-must-not-leak',
      system: [
        { type: 'text', text: 'You are a coding agent.' },
        { type: 'text', text: '<env>\nWorking directory: D:\\work\\repo\nPlatform: win32\n</env>' },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the project.' }] }],
      tools: [{ ...tool(), input_schema: schema }],
      output_config: { effort: 'xhigh' },
      stream: true,
      max_tokens: 16_000,
    })

    expect(result.body).toMatchObject({
      conversationState: {
        conversationId: options.conversationId,
        chatTriggerType: 'MANUAL',
        agentTaskType: 'vibe',
        currentMessage: {
          userInputMessage: {
            content: 'You are a coding agent.\n<env>\nWorking directory: D:\\work\\repo\nPlatform: win32\n</env>\n\nInspect the project.',
            modelId: options.model,
            origin: 'KIRO_CLI',
            userInputMessageContext: {
              envState: {
                operatingSystem: 'windows',
                currentWorkingDirectory: 'D:\\work\\repo',
              },
              tools: [{
                toolSpecification: {
                  name: 'lookup',
                  description: 'Run lookup',
                  inputSchema: {
                    json: {
                      type: 'object',
                      properties: { query: { type: 'string' } },
                      required: ['query'],
                      additionalProperties: false,
                    },
                  },
                },
              }],
            },
          },
        },
      },
      additionalModelRequestFields: { output_config: { effort: 'xhigh' } },
    })
    expect(result.body.conversationState.currentMessage.userInputMessage.content)
      .not.toContain('client-model-must-not-leak')
    expect(result.diagnostics).toEqual({ toolsCount: 1, toolUseCount: 0, toolResultCount: 0 })
    expect(schema).toHaveProperty('additionalProperties', false)
  })

  it('maps current inline images without turning them into text', () => {
    const result = convert({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this: ' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGVs\nbG8=' },
        },
        { type: 'text', text: 'briefly.' },
      ] }],
    })
    expect(result.body.conversationState.currentMessage.userInputMessage).toMatchObject({
      content: 'Describe this: briefly.',
      images: [{ format: 'png', source: { bytes: 'aGVsbG8=' } }],
    })
  })

  it('keeps a tool-result-only current turn empty and structured', () => {
    const result = convert({
      tools: [tool()],
      messages: [
        { role: 'user', content: 'Find it.' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Checking.' },
          toolUse('toolu_exact', 'lookup', { query: 'needle' }),
        ] },
        { role: 'user', content: [toolResult('toolu_exact', 'found')] },
      ],
    })

    const state = result.body.conversationState
    expect(state.currentMessage.userInputMessage.content).toBe('')
    expect(state.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([{
      toolUseId: 'toolu_exact',
      status: 'success',
      content: [{ json: { exit_status: '0', stdout: 'found', stderr: '' } }],
    }])
    expect(state.history?.[1].assistantResponseMessage?.toolUses).toEqual([{
      toolUseId: 'toolu_exact',
      name: 'lookup',
      input: { query: 'needle' },
    }])
    expect(result.diagnostics).toEqual({ toolsCount: 1, toolUseCount: 1, toolResultCount: 1 })
  })

  it('restores reversed parallel results to assistant tool-use order', () => {
    const result = convert({
      tools: [tool('first'), tool('second')],
      messages: [
        { role: 'user', content: 'Run both.' },
        { role: 'assistant', content: [
          toolUse('call_a', 'first', { query: 'A' }),
          toolUse('call_b', 'second', { query: 'B' }),
        ] },
        { role: 'user', content: [
          toolResult('call_b', [{ type: 'text', text: 'B' }]),
          toolResult('call_a', [{ type: 'text', text: 'A' }]),
          { type: 'text', text: 'Use both results.' },
        ] },
      ],
    })

    const current = result.body.conversationState.currentMessage.userInputMessage
    expect(current.content).toBe('Use both results.')
    expect(current.userInputMessageContext?.toolResults?.map((item) => item.toolUseId))
      .toEqual(['call_a', 'call_b'])
    expect(current.userInputMessageContext?.toolResults?.map((item) => item.content[0].json.stdout))
      .toEqual(['A', 'B'])
    expect(result.body.conversationState.history?.[1].assistantResponseMessage?.toolUses?.map((item) => item.toolUseId))
      .toEqual(['call_a', 'call_b'])
  })

  it('preserves every completed tool batch in multi-round history', () => {
    const request = {
      tools: [tool('one'), tool('two')],
      messages: [
        { role: 'user', content: 'First round.' },
        { role: 'assistant', content: [toolUse('one_1', 'one', { query: 'one' })] },
        { role: 'user', content: [toolResult('one_1', 'one result')] },
        { role: 'assistant', content: [
          { type: 'text', text: 'Second round.' },
          toolUse('two_1', 'two', { query: 'two' }),
        ] },
        { role: 'user', content: [toolResult('two_1', 'two result')] },
        { role: 'assistant', content: 'Both are complete.' },
        { role: 'user', content: 'Summarize.' },
      ],
    }
    const first = convert(request)
    const second = convert(request)
    const history = first.body.conversationState.history ?? []

    expect(history.map((entry) => (
      entry.assistantResponseMessage ? 'assistant' : 'user'
    ))).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0].toolUseId)
      .toBe('one_1')
    expect(history[3].assistantResponseMessage?.toolUses?.[0].toolUseId).toBe('two_1')
    expect(history[4].userInputMessage?.userInputMessageContext?.toolResults?.[0].toolUseId)
      .toBe('two_1')
    expect(history[1].assistantResponseMessage?.messageId)
      .toBe(second.body.conversationState.history?.[1].assistantResponseMessage?.messageId)
  })

  it('preserves explicit user text verbatim without manufacturing hidden turns', () => {
    const explicitContinuation = ['Con', 'tinue'].join('')
    const result = convert({ messages: [{ role: 'user', content: explicitContinuation }] })
    expect(result.body.conversationState.currentMessage.userInputMessage.content)
      .toBe(explicitContinuation)

    const ordinary = convert({ messages: [{ role: 'user', content: 'Proceed with the requested change.' }] })
    const serialized = JSON.stringify(ordinary.body)
    expect(serialized).not.toContain(explicitContinuation)
    expect(serialized).not.toContain('[TOOL RESULTS INCLUDED]')
  })

  it('preserves empty and failed tool outputs without placeholder text', () => {
    const result = convert({
      messages: [
        { role: 'user', content: 'Run it.' },
        { role: 'assistant', content: [toolUse('failed_call')] },
        { role: 'user', content: [{ ...toolResult('failed_call', ''), is_error: true }] },
      ],
    })
    expect(result.body.conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.toolResults).toEqual([{
      toolUseId: 'failed_call',
      status: 'error',
      content: [{ json: { exit_status: '1', stdout: '', stderr: '' } }],
    }])
  })

  it('maps adaptive thinking to high effort unless output_config is explicit', () => {
    const adaptive = convert({
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'Think.' }],
    })
    expect(adaptive.body.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' } })

    const explicit = convert({
      thinking: { type: 'enabled', budget_tokens: 32_000 },
      output_config: { effort: 'minimal' },
      messages: [{ role: 'user', content: 'Think.' }],
    })
    expect(explicit.body.additionalModelRequestFields).toEqual({ output_config: { effort: 'low' } })
  })

  it('preserves supported schema constraints without widening the tool contract', () => {
    const result = convert({
      tools: [{
        name: 'constrained',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'run' },
            target: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 8 },
            count: { type: 'integer', minimum: 1, maximum: 4, multipleOf: 1 },
            tags: {
              type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
              items: { type: 'string' },
            },
          },
          required: ['action', 'target'],
          additionalProperties: false,
        },
      }],
      messages: [{ role: 'user', content: 'run' }],
    })
    expect(result.body.conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.tools?.[0].toolSpecification.inputSchema.json).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run'] },
        target: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 8 },
        count: { type: 'integer', minimum: 1, maximum: 4, multipleOf: 1 },
        tags: {
          type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
          items: { type: 'string' },
        },
      },
      required: ['action', 'target'],
      additionalProperties: false,
    })
  })

  it('supports tool_choice none by omitting current tool declarations', () => {
    const result = convert({
      tool_choice: { type: 'none' },
      tools: [tool()],
      messages: [{ role: 'user', content: 'Do not call tools.' }],
    })
    expect(result.body.conversationState.currentMessage.userInputMessage.userInputMessageContext)
      .toBeUndefined()
    expect(result.diagnostics.toolsCount).toBe(0)
  })
})

describe('Kiro Claude request fail-closed validation', () => {
  it('rejects missing messages, assistant-last turns, and empty user turns', () => {
    expectConversionError(() => convert({}), 'invalid-request', 'messages')
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
    }), 'invalid-message-order', 'messages[1].role')
    expectConversionError(() => convert({ messages: [{ role: 'user', content: [] }] }),
      'invalid-content', 'messages[0].content')
  })

  it('rejects non-alternating roles', () => {
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
    }), 'invalid-message-order', 'messages[1].role')
  })

  it('rejects orphan, missing, duplicate, and cross-batch tool results', () => {
    expectConversionError(() => convert({
      messages: [{ role: 'user', content: [toolResult('orphan', 'x')] }],
    }), 'invalid-tool-history', 'messages[0].content[0].tool_use_id')

    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('a'), toolUse('b')] },
        { role: 'user', content: [toolResult('a', 'A')] },
      ],
    }), 'invalid-tool-history', 'messages[2].content')

    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('same'), toolUse('same')] },
        { role: 'user', content: [toolResult('same')] },
      ],
    }), 'invalid-tool-history', 'messages[1].content[1].id')

    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('one')] },
        { role: 'user', content: [toolResult('one'), toolResult('one')] },
      ],
    }), 'invalid-tool-history', 'messages[2].content[1].tool_use_id')

    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('current')] },
        { role: 'user', content: [toolResult('old')] },
      ],
    }), 'invalid-tool-history', 'messages[2].content[0].tool_use_id')
  })

  it('rejects malformed tool IDs and non-object tool input', () => {
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'lookup', input: {} }] },
        { role: 'user', content: 'done' },
      ],
    }), 'invalid-tool-history', 'messages[1].content[0].id')
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'lookup', input: 'bad' }] },
        { role: 'user', content: [toolResult('a')] },
      ],
    }), 'invalid-tool-history', 'messages[1].content[0].input')
  })

  it.each([
    [{ type: 'any' }, 'tool_choice'],
    [{ type: 'tool', name: 'lookup' }, 'tool_choice'],
    [{ type: 'auto', disable_parallel_tool_use: true }, 'tool_choice.disable_parallel_tool_use'],
  ])('rejects unsupported forced tool choice %#', (toolChoice, path) => {
    expectConversionError(() => convert({
      tool_choice: toolChoice,
      tools: [tool()],
      messages: [{ role: 'user', content: 'Use it.' }],
    }), 'unsupported-tool-choice', path)
  })

  it('rejects unsupported tool-result content instead of textualizing it', () => {
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('image_result')] },
        { role: 'user', content: [toolResult('image_result', [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
        }])] },
      ],
    }), 'unsupported-content', 'messages[2].content[0].content[0]')
  })

  it('rejects URL images and historical images that native Kiro cannot represent', () => {
    expectConversionError(() => convert({ messages: [{ role: 'user', content: [{
      type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' },
    }] }] }), 'unsupported-content', 'messages[0].content[0].source.type')

    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'old image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ] },
        { role: 'assistant', content: 'seen' },
        { role: 'user', content: 'continue normally' },
      ],
    }), 'unsupported-content', 'messages[0].content')
  })

  it('rejects unsupported content blocks and builtin tool declarations', () => {
    expectConversionError(() => convert({ messages: [{ role: 'user', content: [{
      type: 'document', source: { type: 'text', data: 'x' },
    }] }] }), 'unsupported-content', 'messages[0].content[0]')

    expectConversionError(() => convert({
      tools: [{ type: 'web_search_20250305', name: 'web_search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'search' }],
    }), 'invalid-tool-definition', 'tools[0].type')
  })

  it('rejects schema unions that cannot be represented without changing semantics', () => {
    expectConversionError(() => convert({
      tools: [{
        name: 'union_tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      }],
      messages: [{ role: 'user', content: 'run' }],
    }), 'invalid-tool-definition', 'tools[0].input_schema.properties.value.oneOf')
  })

  it('rejects schema keywords that Kiro cannot represent without changing semantics', () => {
    expectConversionError(() => convert({
      tools: [{
        name: 'referenced_tool',
        input_schema: {
          type: 'object',
          properties: { query: { $ref: '#/$defs/query' } },
          $defs: { query: { type: 'string' } },
        },
      }],
      messages: [{ role: 'user', content: 'run' }],
    }), 'invalid-tool-definition', 'tools[0].input_schema.properties.query.$ref')

    expectConversionError(() => convert({
      tools: [{
        name: 'formatted_tool',
        input_schema: {
          type: 'object',
          properties: { target: { type: 'string', format: 'uri' } },
        },
      }],
      messages: [{ role: 'user', content: 'run' }],
    }), 'invalid-tool-definition', 'tools[0].input_schema.properties.target.format')
  })

  it('enforces a global declared-tool limit before constructing the Kiro payload', () => {
    expectConversionError(() => convert({
      tools: Array.from({ length: 129 }, (_, index) => ({
        name: `tool_${index}`,
        input_schema: { type: 'object' },
      })),
      messages: [{ role: 'user', content: 'run' }],
    }), 'request-limit-exceeded', 'tools')
  })

  it('caps aggregate historical tool arguments by UTF-8 byte size', () => {
    expectConversionError(() => convert({
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [toolUse('large', 'lookup', {
          query: 'x'.repeat(4 * 1024 * 1024),
        })] },
        { role: 'user', content: [toolResult('large')] },
      ],
    }), 'request-limit-exceeded', 'messages[1].content[0].input')
  })

  it('rejects a missing caller-supplied conversation identity', () => {
    expectConversionError(() => convertAnthropicMessagesToKiroClaude(
      { messages: [{ role: 'user', content: 'hello' }] },
      { model: options.model, conversationId: ' ' }
    ), 'invalid-conversation-id', 'options.conversationId')
  })
})
