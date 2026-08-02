import { describe, expect, it } from 'vitest'
import {
  DeepSeekDsmlError,
  parseDeepSeekDsmlBlock,
  restoreDeepSeekResponsesDsml,
} from '../../src/main/gateway/deepseek-dsml'
import { createDeepSeekDsmlStreamParser } from '../../src/main/gateway/deepseek-dsml-stream'
import { convertRequest } from '../../src/main/gateway/protocol'
import type { CanonicalStreamEvent } from '../../src/main/gateway/streaming'
import type { ToolBridgePlan } from '../../src/main/gateway/types'

const encoder = new TextEncoder()

describe('DeepSeek DSML Responses bridge', () => {
  it('normalizes the supported web search alias and rejects silently ignored hosted tools', () => {
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'gpt-5.6-terra', input: 'search', tools: [{ type: 'web_search_preview' }],
    }, 'deepseek-v4-flash', { dialect: 'deepseek-dsml' })
    expect(converted.body).toMatchObject({ tools: [{ type: 'web_search' }] })

    expect(() => convertRequest('openai-responses', 'openai-responses', {
      model: 'gpt-5.6-terra', input: 'run', tools: [{ type: 'code_interpreter' }],
    }, 'deepseek-v4-flash', { dialect: 'deepseek-dsml' })).toThrow(DeepSeekDsmlError)
  })

  it('bridges Codex tool_search and merges newly discovered namespace tools', () => {
    const context = { dialect: 'deepseek-dsml' as const }
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'gpt-5.6-terra',
      input: [{
        type: 'tool_search_call', call_id: 'search_1', execution: 'client',
        arguments: { query: 'send_message_to_thread', limit: 10 },
      }, {
        type: 'tool_search_output', call_id: 'search_1', execution: 'client',
        tools: [{
          type: 'namespace', name: 'codex_app', tools: [{
            type: 'function', name: 'send_message_to_thread',
            description: 'Send a message to a task',
            parameters: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
          }],
        }],
      }],
      tools: [{
        type: 'namespace', name: 'codex_app', tools: [{
          type: 'function', name: 'read_thread_terminal', parameters: { type: 'object', properties: {} },
        }],
      }, {
        type: 'tool_search', execution: 'client',
        parameters: {
          type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'], additionalProperties: false,
        },
      }],
      stream: true,
      parallel_tool_calls: false,
    }, 'deepseek-v4-flash', context)

    const body = converted.body as {
      tools: Array<Record<string, unknown>>
      input: Array<Record<string, unknown>>
      parallel_tool_calls: boolean
    }
    expect(body.parallel_tool_calls).toBe(true)
    expect(context.toolBridgePlan?.parallelToolCalls).toBe(true)
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'search_tools' }),
      expect.objectContaining({ type: 'function', name: 'codex_app__read_thread_terminal' }),
      expect.objectContaining({ type: 'function', name: 'codex_app__send_message_to_thread' }),
    ]))
    expect(body.input[0]).toMatchObject({
      type: 'function_call', call_id: 'search_1', name: 'search_tools',
      arguments: JSON.stringify({ query: 'send_message_to_thread', limit: 10 }),
    })
    expect(body.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'search_1' })
    expect(context.toolBridgePlan?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'tool_search', wireName: 'search_tools' }),
      expect.objectContaining({
        sourceType: 'function', sourceNamespace: 'codex_app',
        sourceName: 'send_message_to_thread', wireName: 'codex_app__send_message_to_thread',
      }),
    ]))
  })

  it('restores buffered DeepSeek tool search as a native client tool_search_call', () => {
    const plan = bridgePlan([
      { sourceType: 'tool_search', sourceName: 'tool_search', wireName: 'search_tools', declared: true },
    ])
    const restored = restoreDeepSeekResponsesDsml({
      id: 'resp_search', object: 'response', status: 'completed',
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{
          type: 'output_text',
          text: [
            '<|DSML|tool_calls>',
            '<|DSML|invoke name="search_tools">',
            '<|DSML|parameter name="query" string="true">send_message_to_thread</|DSML|parameter>',
            '<|DSML|parameter name="limit" string="false">10</|DSML|parameter>',
            '</|DSML|invoke>',
            '</|DSML|tool_calls>',
          ].join(''),
        }],
      }],
    }, plan)
    expect(restored.output).toEqual([
      expect.objectContaining({
        type: 'tool_search_call', execution: 'client', status: 'completed',
        arguments: { query: 'send_message_to_thread', limit: 10 },
      }),
    ])
  })

  it('restores byte-split parallel DSML calls without leaking markup as answer text', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'exec_command', wireName: 'exec_command', declared: true },
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
    ])
    const completion = [
      'I will inspect the workspace.\n\n',
      '<｜｜DSML｜｜tool_calls>\n',
      '<｜｜DSML｜｜invoke name="exec_command">\n',
      '<｜｜DSML｜｜parameter name="cmd" string="true">Get-Location</｜｜DSML｜｜parameter>\n',
      '<｜｜DSML｜｜parameter name="timeout" string="false">3000</｜｜DSML｜｜parameter>\n',
      '</｜｜DSML｜｜invoke>\n',
      '<｜｜DSML｜｜invoke name="read_file">\n',
      '<｜｜DSML｜｜parameter name="path" string="true">README.md</｜｜DSML｜｜parameter>\n',
      '</｜｜DSML｜｜invoke>\n',
      '</｜｜DSML｜｜tool_calls>',
    ].join('')
    const wire = responsesWire(completion)
    const parser = createDeepSeekDsmlStreamParser(plan)
    const events: CanonicalStreamEvent[] = []
    for (const byte of encoder.encode(wire)) events.push(...parser.push(Uint8Array.of(byte)))
    events.push(...parser.finish())

    expect(events.filter((event) => event.type === 'text-delta').map((event) => (
      event.type === 'text-delta' ? event.text : ''
    )).join('')).toBe('I will inspect the workspace.\n\n')
    const calls = events.filter((event) => event.type === 'tool-call-delta')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'exec_command' })
    expect(calls[1]).toMatchObject({ name: 'read_file' })
    expect(JSON.parse(calls[0].type === 'tool-call-delta' ? calls[0].arguments! : '')).toEqual({
      cmd: 'Get-Location',
      timeout: 3000,
    })
    expect(events.filter((event) => event.type === 'tool-call-complete')).toHaveLength(2)
    expect(events).toContainEqual({ type: 'stop', reason: 'tool_calls', rawReason: 'dsml_tool_calls' })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(parser.getProtocolState().responsesTerminalEvent).toBe('response.completed')
  })

  it('fails closed when DSML names a tool not declared by the current Codex request', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
    ])
    expect(() => parseDeepSeekDsmlBlock([
      '<｜DSML｜tool_calls>\n',
      '<｜DSML｜invoke name="exec_command">\n',
      '</｜DSML｜invoke>\n',
      '</｜DSML｜tool_calls>',
    ].join(''), plan)).toThrowError(DeepSeekDsmlError)
  })

  it('accepts a DeepSeek parallel DSML batch even when the Codex model hint disabled it', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
      { sourceType: 'function', sourceName: 'search_text', wireName: 'search_text', declared: true },
    ])
    plan.parallelToolCalls = false
    const parsed = parseDeepSeekDsmlBlock([
      '<|DSML|tool_calls>',
      '<|DSML|invoke name="read_file">',
      '<|DSML|parameter name="path" string="true">README.md</|DSML|parameter>',
      '</|DSML|invoke>',
      '<|DSML|invoke name="search_text">',
      '<|DSML|parameter name="query" string="true">Challenger</|DSML|parameter>',
      '</|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join(''), plan)
    expect(parsed?.calls).toHaveLength(2)
    expect(parsed?.calls.map((call) => call.binding.sourceName)).toEqual(['read_file', 'search_text'])
  })

  it('restores a buffered custom tool call as a native Responses custom_tool_call', () => {
    const plan = bridgePlan([
      { sourceType: 'custom', sourceName: 'apply_patch', wireName: 'apply_patch', declared: true },
    ])
    const body = {
      id: 'resp_dsml',
      object: 'response',
      status: 'completed',
      output: [{
        id: 'msg_dsml',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: [
            '<|DSML|tool_calls>\n',
            '<|DSML|invoke name="apply_patch">\n',
            '<|DSML|parameter name="input" string="true">*** Begin Patch</|DSML|parameter>\n',
            '</|DSML|invoke>\n',
            '</|DSML|tool_calls>',
          ].join(''),
        }],
      }],
    }

    const restored = restoreDeepSeekResponsesDsml(body, plan)
    expect(restored.output).toEqual([
      expect.objectContaining({
        type: 'custom_tool_call',
        status: 'completed',
        name: 'apply_patch',
        input: '*** Begin Patch',
        call_id: expect.stringMatching(/^call_dsml_/),
      }),
    ])
  })

  it('bridges any deferred Codex tool through the declared exec runtime', () => {
    const plan = bridgePlan([
      { sourceType: 'custom', sourceName: 'exec', wireName: 'exec', declared: true },
    ])
    plan.deferredExecSourceName = 'exec'
    const parsed = parseDeepSeekDsmlBlock([
      '<|DSML|tool_calls>',
      '<|DSML|invoke name="codex_app__send_message_to_thread">',
      '<|DSML|parameter name="threadId" string="true">parent</|DSML|parameter>',
      '<|DSML|parameter name="prompt" string="true">done</|DSML|parameter>',
      '</|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join('\n'), plan)!

    expect(parsed.calls[0].binding.sourceName).toBe('exec')
    const args = JSON.parse(parsed.calls[0].arguments) as { input: string }
    expect(args.input).toContain('availableTools.find')
    expect(args.input).toContain('tools[resolvedName]')
    expect(args.input).toContain('codex_app__send_message_to_thread')
    expect(args.input).toContain('"threadId":"parent"')
  })

  it('accepts namespaced tools outside the former thread-tool allowlist', () => {
    const plan = bridgePlan([
      { sourceType: 'custom', sourceName: 'exec', wireName: 'exec', declared: true },
    ])
    plan.deferredExecSourceName = 'exec'
    const parsed = parseDeepSeekDsmlBlock([
      '<|DSML|tool_calls>',
      '<|DSML|invoke name="codex_app__create_thread">',
      '</|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join('\n'), plan)!
    expect(parsed.calls[0].binding).toMatchObject({
      sourceName: 'exec',
      deferredToolName: 'codex_app__create_thread',
    })
  })

  it('still rejects an undeclared tool when the request has no exec runtime', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
    ])
    expect(() => parseDeepSeekDsmlBlock([
      '<|DSML|tool_calls>',
      '<|DSML|invoke name="codex_app__create_thread">',
      '</|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join('\n'), plan)).toThrowError(DeepSeekDsmlError)
  })

  it('authorizes and restores native buffered Responses calls instead of bypassing the bridge', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
      { sourceType: 'custom', sourceName: 'exec', wireName: 'exec', declared: true },
    ])
    const restored = restoreDeepSeekResponsesDsml({
      id: 'resp_native', status: 'completed', output: [
        {
          id: 'fc_read', type: 'function_call', status: 'completed', call_id: 'call_read',
          name: 'read_file', arguments: '{"path":"README.md"}',
        },
        {
          id: 'fc_exec', type: 'function_call', status: 'completed', call_id: 'call_exec',
          name: 'exec', arguments: '{"input":"rg --files"}',
        },
      ],
    }, plan)
    expect(restored.output).toEqual([
      expect.objectContaining({
        type: 'function_call', call_id: 'call_read', name: 'read_file',
        arguments: '{"path":"README.md"}',
      }),
      expect.objectContaining({
        type: 'custom_tool_call', call_id: 'call_exec', name: 'exec', input: 'rg --files',
      }),
    ])

    expect(() => restoreDeepSeekResponsesDsml({
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_write', name: 'write_file', arguments: '{}' }],
    }, plan)).toThrow(/undeclared tool write_file/)
  })

  it('rejects mixed native and DSML tools in buffered and streaming responses regardless of order', () => {
    const plan = bridgePlan([
      { sourceType: 'function', sourceName: 'read_file', wireName: 'read_file', declared: true },
    ])
    const dsml = [
      '<|DSML|tool_calls>',
      '<|DSML|invoke name="read_file">',
      '<|DSML|parameter name="path" string="true">README.md</|DSML|parameter>',
      '</|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join('')
    expect(() => restoreDeepSeekResponsesDsml({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: dsml }] },
        { type: 'function_call', call_id: 'call_native', name: 'read_file', arguments: '{}' },
      ],
    }, plan)).toThrow(/mixed native tool output/)

    const parser = createDeepSeekDsmlStreamParser(plan)
    const wire = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: dsml,
      })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added', output_index: 1,
        item: { type: 'function_call', call_id: 'call_native', name: 'read_file', arguments: '{}' },
      })}\n\n`,
    ].join('')
    const events = [...parser.push(encoder.encode(wire)), ...parser.finish()]
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'mixed_tool_formats',
    }))
  })
})

function bridgePlan(tools: ToolBridgePlan['tools']): ToolBridgePlan {
  return {
    dialect: 'deepseek-dsml',
    tools,
    calls: [],
    requiresResponseBridge: true,
    parallelToolCalls: true,
  }
}

function responsesWire(text: string): string {
  const payloads = [
    { type: 'response.created', response: { id: 'resp_dsml', model: 'deepseek-v4-flash' } },
    {
      type: 'response.output_text.delta', response_id: 'resp_dsml', output_index: 0,
      content_index: 0, delta: text,
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_dsml', object: 'response', status: 'completed', model: 'deepseek-v4-flash',
        output: [{
          id: 'msg_dsml', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text }],
        }],
      },
    },
  ]
  return payloads.map((payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`).join('')
}
