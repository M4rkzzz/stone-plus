import { describe, expect, it } from 'vitest'
import {
  analyzeProtocolConversion,
  convertRequest,
  convertResponse,
} from '../../src/main/gateway/protocol'

describe('DeepSeek Chat Responses bridge', () => {
  it('exposes Codex custom, namespace, and tool-search declarations without losing their response types', () => {
    const body = {
      model: 'gpt-5.6-terra',
      input: 'Use the available tools.',
      parallel_tool_calls: false,
      tools: [
        { type: 'custom', name: 'exec', description: 'Codex runtime' },
        {
          type: 'namespace',
          name: 'codex_app',
          tools: [{
            type: 'function',
            name: 'send_message_to_thread',
            parameters: {
              type: 'object',
              properties: { threadId: { type: 'string' } },
              required: ['threadId'],
            },
          }],
        },
        {
          type: 'tool_search',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    }
    expect(analyzeProtocolConversion(
      'openai-responses',
      'openai-chat',
      body,
      { dialect: 'deepseek-chat' },
    ).supported).toBe(true)

    const context = { dialect: 'deepseek-chat' as const }
    const request = convertRequest(
      'openai-responses',
      'openai-chat',
      body,
      'deepseek-v4-pro',
      context,
    )
    const tools = request.body.tools as Array<{ function: { name: string } }>
    expect(tools.map((tool) => tool.function.name)).toEqual([
      'exec',
      'codex_app__send_message_to_thread',
      'search_tools',
    ])
    expect(request.body.parallel_tool_calls).toBe(true)
    expect(context.toolBridgePlan?.dialect).toBe('deepseek-chat')
    expect(context.toolBridgePlan?.deferredExecSourceName).toBe('exec')

    const response = convertResponse('openai-chat', 'openai-responses', {
      id: 'chat_deepseek',
      model: 'deepseek-v4-pro',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_search', type: 'function',
              function: { name: 'search_tools', arguments: '{"query":"send_message"}' },
            },
            {
              id: 'call_send', type: 'function',
              function: { name: 'codex_app__send_message_to_thread', arguments: '{"threadId":"parent"}' },
            },
            {
              id: 'call_deferred', type: 'function',
              function: { name: 'codex_app__create_thread', arguments: '{"prompt":"audit"}' },
            },
          ],
        },
      }],
    }, 'deepseek-v4-pro', () => 1_700_000_000_000, context)

    expect(response.output).toEqual([
      expect.objectContaining({
        type: 'tool_search_call', call_id: 'call_search',
        arguments: { query: 'send_message' },
      }),
      expect.objectContaining({
        type: 'function_call', call_id: 'call_send',
        namespace: 'codex_app', name: 'send_message_to_thread',
      }),
      expect.objectContaining({
        type: 'custom_tool_call', call_id: 'call_deferred', name: 'exec',
        input: expect.stringContaining('codex_app__create_thread'),
      }),
    ])
  })

  it('rejects unsupported hosted tools before routing to a Chat relay', () => {
    const analysis = analyzeProtocolConversion('openai-responses', 'openai-chat', {
      model: 'gpt-5.6-terra',
      input: 'Run code.',
      tools: [{ type: 'code_interpreter' }],
    }, { dialect: 'deepseek-chat' })
    expect(analysis).toMatchObject({
      supported: false,
      issues: [{ path: 'tools', capability: 'builtin-tool' }],
    })
  })
})
