import { describe, expect, it } from 'vitest'
import { analyzeProtocolConversion, convertRequest, convertResponse } from '../../src/main/gateway'
import { InvalidToolBridgeError } from '../../src/main/gateway/protocol'

const grok = { dialect: 'xai-grok' as const }

describe('xAI Grok protocol bridge', () => {
  it('admits only the explicit custom bridge while conversation chaining and hosted tools stay closed', () => {
    expect(analyzeProtocolConversion('openai-responses', 'openai-chat', {
      model: 'codex', input: 'hello', tools: [{ type: 'custom', name: 'run' }]
    }, { ...grok })).toEqual({ supported: true, issues: [] })
    expect(analyzeProtocolConversion('openai-responses', 'openai-chat', {
      model: 'codex', input: 'hello', previous_response_id: 'resp_1', tools: [{ type: 'custom', name: 'run' }]
    }, { ...grok })).toMatchObject({ supported: false, issues: [{ path: 'previous_response_id' }] })
    expect(analyzeProtocolConversion('openai-responses', 'openai-chat', {
      model: 'codex', input: 'hello', tools: [{ type: 'mcp', server_url: 'https://mcp.example.test' }]
    }, { ...grok })).toMatchObject({ supported: false, issues: [{ path: 'tools[0]', capability: 'builtin-tool' }] })
  })

  it.each([
    ['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']
  ])('maps Responses reasoning effort %s to Grok %s', (effort, expected) => {
    const converted = convertRequest('openai-responses', 'openai-chat', {
      model: 'codex', reasoning: { effort }, input: [{ type: 'message', role: 'developer', content: 'policy' }]
    }, 'grok', { ...grok })
    expect(converted.body.reasoning_effort).toBe(expected)
    expect(converted.body.messages).toEqual([{ role: 'developer', content: 'policy' }])
  })

  it('rejects opaque compact history instead of silently dropping it for native Grok Responses', () => {
    const source = {
      model: 'codex',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      input: [
        { type: 'reasoning', encrypted_content: 'private-history' },
        { type: 'compaction', encrypted_content: 'compact-history' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      tools: [
        { type: 'web_search_preview' },
        { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'apply_patch' },
      ],
    }
    expect(analyzeProtocolConversion(
      'openai-responses', 'openai-responses', source, { ...grok }
    )).toMatchObject({ supported: false, issues: [{ path: 'input[1]' }] })
    expect(() => convertRequest(
      'openai-responses', 'openai-responses', source, 'grok-4.5', { ...grok }
    )).toThrow(InvalidToolBridgeError)
  })

  it('normalizes non-opaque Codex-only Responses items before a native Grok Responses request', () => {
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      input: [
        { type: 'reasoning', encrypted_content: 'private-history' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      tools: [
        { type: 'web_search_preview' },
        { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'apply_patch' },
      ],
    }, 'grok-4.5', { ...grok })

    expect(converted.body).toMatchObject({
      model: 'grok-4.5',
      stream: true,
      store: false,
      reasoning_effort: 'high',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    })
    const tools = converted.body.tools as Array<Record<string, unknown>>
    expect(tools.map((tool) => tool.type)).toEqual(['function', 'function'])
    expect(tools[1]).toMatchObject({
      parameters: {
        type: 'object',
        required: ['input'],
        additionalProperties: false,
      },
    })
    expect(tools[1].name).not.toBe('apply_patch')
    expect(JSON.stringify(converted.body)).not.toContain('private-history')
    expect(converted.body).not.toHaveProperty('include')
    expect(converted.body).not.toHaveProperty('reasoning')
  })

  it('promotes additional tools, flattens namespaces, and restores buffered calls', () => {
    const context = { ...grok }
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex',
      input: [
        { type: 'additional_tools', tools: [
          { type: 'function', name: 'lookup', parameters: { type: 'object' } },
          { type: 'namespace', name: 'files', tools: [{
            type: 'function', name: 'read', description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          }] },
        ] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', namespace: 'files', name: 'read' },
    }, 'grok-4.5', context)

    const tools = converted.body.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ type: 'function', name: 'lookup' })
    expect(tools[1]).toMatchObject({ type: 'function', name: 'files__read', description: 'Read a file' })
    expect(converted.body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
    ])
    expect(converted.body.tool_choice).toEqual({ type: 'function', name: 'files__read' })

    const restored = convertResponse('openai-responses', 'openai-responses', {
      id: 'response', status: 'completed', output: [{
        type: 'function_call', call_id: 'call_1', name: 'files__read', arguments: '{"path":"README.md"}',
      }],
    }, 'grok-4.5', Date.now, context)
    expect(restored.output).toEqual([expect.objectContaining({
      type: 'function_call', call_id: 'call_1', namespace: 'files', name: 'read',
    })])
  })

  it('cleans xAI-private fields and normalizes nested function tool choices', () => {
    const context = { ...grok }
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: 'hello',
      safety_identifier: 'private', prompt_cache_retention: '24h',
      external_web_access: true,
      metadata: { external_web_access: true, keep: 'value' },
      presencePenalty: 1, frequency_penalty: 1, stop: ['done'],
      tools: [{ type: 'custom', name: 'exec', external_web_access: true }],
      tool_choice: { type: 'custom', function: { name: 'exec' } },
    }, 'vendor/grok-4.5', context)

    const serialized = JSON.stringify(converted.body)
    expect(serialized).not.toContain('external_web_access')
    expect(converted.body).not.toHaveProperty('safety_identifier')
    expect(converted.body).not.toHaveProperty('prompt_cache_retention')
    expect(converted.body).not.toHaveProperty('presencePenalty')
    expect(converted.body).not.toHaveProperty('frequency_penalty')
    expect(converted.body).not.toHaveProperty('stop')
    const wireName = String((converted.body.tools as Array<Record<string, unknown>>)[0].name)
    expect(converted.body.tool_choice).toEqual({ type: 'function', name: wireName })
  })

  it('never trusts an upstream namespace that was not declared by the route request', () => {
    const context = { ...grok }
    const request = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: 'hello', tools: [{ type: 'function', name: 'unsafe.tool' }],
    }, 'grok-4.5', context)
    const wireName = String((request.body.tools as Array<Record<string, unknown>>)[0].name)
    const restored = convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [{
        type: 'function_call', call_id: 'call_1', name: wireName,
        namespace: 'attacker', arguments: '{}',
      }],
    }, 'grok-4.5', Date.now, context)
    expect(restored.output).toEqual([expect.objectContaining({ name: 'unsafe.tool' })])
    expect((restored.output as Array<Record<string, unknown>>)[0]).not.toHaveProperty('namespace')
  })

  it('drops tool controls when every declared tool is filtered out', () => {
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex',
      input: 'hello',
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }, 'grok-4.5', { ...grok })

    expect(converted.body).not.toHaveProperty('tools')
    expect(converted.body).not.toHaveProperty('tool_choice')
    expect(converted.body).not.toHaveProperty('parallel_tool_calls')
  })

  it('drops a dangling required tool choice when its declaration is filtered out', () => {
    const required = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: 'search', tools: [{ type: 'web_search_preview' }], tool_choice: 'required',
    }, 'grok-4.5', { ...grok })
    const selected = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: 'search', tools: [{ type: 'web_search_preview' }],
      tool_choice: { type: 'web_search_preview' },
    }, 'grok-4.5', { ...grok })
    expect(required.body).not.toHaveProperty('tool_choice')
    expect(selected.body).not.toHaveProperty('tool_choice')
  })

  it('replays an undeclared historical custom call without exposing it as a current tool', () => {
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex',
      input: [
        { type: 'custom_tool_call', call_id: 'call_exec', name: 'exec', input: 'echo hello' },
        { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'hello' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    }, 'grok-4.5', { ...grok })

    const wireName = ((converted.body.input as Array<Record<string, unknown>>)[0]).name
    expect(wireName).not.toBe('exec')
    expect(converted.body.input).toEqual([
      { type: 'function_call', call_id: 'call_exec', name: wireName, arguments: '{"input":"echo hello"}' },
      { type: 'function_call_output', call_id: 'call_exec', output: 'hello' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])
    expect(converted.body).not.toHaveProperty('tools')
    expect(converted.body).not.toHaveProperty('tool_choice')
  })

  it('replays undeclared namespace history without authorizing a new call', () => {
    const context = { ...grok }
    const converted = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: [
        { type: 'function_call', call_id: 'old', namespace: 'repo', name: 'read', arguments: '{"path":"README.md"}' },
        { type: 'function_call_output', call_id: 'old', output: 'contents' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    }, 'grok-4.5', context)
    const wireCall = (converted.body.input as Array<Record<string, unknown>>)[0]
    expect(wireCall).toMatchObject({ type: 'function_call', call_id: 'old' })
    expect(wireCall.name).not.toBe('read')
    expect(wireCall).not.toHaveProperty('namespace')
    expect(() => convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [{
        type: 'function_call', call_id: 'new', name: wireCall.name, arguments: '{}',
      }],
    }, 'grok-4.5', Date.now, context)).toThrow(/unknown tool alias/)
  })

  it('does not authorize a safe-name function that appears only in history', () => {
    const context = { ...grok }
    convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: [
        { type: 'function_call', call_id: 'old', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'old', output: 'done' },
      ],
    }, 'grok-4.5', context)
    expect(() => convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [{
        type: 'function_call', call_id: 'new', name: 'lookup', arguments: '{}',
      }],
    }, 'grok-4.5', Date.now, context)).toThrow(/unknown tool alias/)
  })

  it('wraps Responses custom tools as safe Chat functions and restores the call', () => {
    const requestContext = { ...grok }
    const chat = convertRequest('openai-responses', 'openai-chat', {
      model: 'codex',
      stream: true,
      reasoning: { effort: 'minimal' },
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
      tool_choice: { type: 'custom', name: 'apply_patch' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }]
    }, 'grok-4', requestContext)

    expect(chat.body).toMatchObject({
      reasoning_effort: 'low',
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: {
        description: 'Apply a patch The argument must be a JSON object with one string property named input.',
        parameters: { required: ['input'], additionalProperties: false }
      } }],
      tool_choice: { type: 'function' }
    })
    const wireName = (chat.body.tools as Array<{ function: { name: string } }>)[0].function.name
    expect(wireName).not.toBe('apply_patch')

    const response = convertResponse('openai-chat', 'openai-responses', {
      id: 'chatcmpl_1', model: 'grok-4',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: {
          name: wireName, arguments: JSON.stringify({ input: '*** Begin Patch' })
        } }]
      } }]
    }, 'grok-4', () => 1_700_000_000_000, requestContext)
    expect(response.output).toMatchObject([{ type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch' }])
  })

  it('wires native Grok Responses tools as functions and restores a buffered custom call', () => {
    const context = { ...grok }
    const request = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex',
      input: 'inspect the repository',
      tools: [{ type: 'custom', name: 'exec', description: 'Run a command' }],
      tool_choice: { type: 'custom', name: 'exec' },
    }, 'grok-4.5', context)
    const wireTool = (request.body.tools as Array<Record<string, unknown>>)[0]
    expect(wireTool).toMatchObject({ type: 'function' })
    expect(wireTool.name).not.toBe('exec')
    expect(request.body.tool_choice).toEqual({ type: 'function', name: wireTool.name })

    const response = convertResponse('openai-responses', 'openai-responses', {
      id: 'resp_1',
      status: 'completed',
      output: [{
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: wireTool.name,
        arguments: JSON.stringify({ input: 'rg --files' }), status: 'completed',
      }],
    }, 'grok-4.5', Date.now, context)
    expect(response.output).toEqual([{
      id: 'fc_1', type: 'custom_tool_call', call_id: 'call_1', name: 'exec',
      input: 'rg --files', status: 'completed',
    }])
  })

  it('fails closed for unbridged, parallel, and duplicate buffered calls', () => {
    const context = { ...grok }
    const request = convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: 'run it', parallel_tool_calls: false,
      tools: [{ type: 'custom', name: 'exec' }],
    }, 'grok-4.5', context)
    const wireName = String((request.body.tools as Array<Record<string, unknown>>)[0].name)
    expect(() => convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [{ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'whoami' }],
    }, 'grok-4.5', Date.now, context)).toThrow('unbridged custom tool call')
    expect(() => convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [
        { type: 'function_call', call_id: 'c1', name: wireName, arguments: '{"input":"one"}' },
        { type: 'function_call', call_id: 'c2', name: wireName, arguments: '{"input":"two"}' },
      ],
    }, 'grok-4.5', Date.now, context)).toThrow('parallel tool calls when disabled')
    expect(() => convertResponse('openai-responses', 'openai-responses', {
      status: 'completed', output: [
        { type: 'function_call', call_id: 'same', name: wireName, arguments: '{"input":"one"}' },
        { type: 'function_call', call_id: 'same', name: wireName, arguments: '{"input":"two"}' },
      ],
    }, 'grok-4.5', Date.now, { ...context, toolBridgePlan: { ...context.toolBridgePlan!, parallelToolCalls: true } }))
      .toThrow('duplicate tool call id')
  })

  it('rejects malformed or ambiguous custom call history', () => {
    expect(() => convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: [{ type: 'custom_tool_call', name: 'exec', input: 'echo hi' }],
    }, 'grok-4.5', { ...grok })).toThrow('tool call id is required')
    expect(() => convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: [{ type: 'custom_tool_call_output', call_id: 'orphan', output: 'hi' }],
    }, 'grok-4.5', { ...grok })).toThrow('orphan tool output')
    expect(() => convertRequest('openai-responses', 'openai-responses', {
      model: 'codex', input: [
        { type: 'custom_tool_call', call_id: 'same', name: 'exec', input: 'one' },
        { type: 'custom_tool_call', call_id: 'same', name: 'exec', input: 'two' },
      ],
    }, 'grok-4.5', { ...grok })).toThrow('duplicate tool call id')
  })

  it('round-trips custom call history and output items', () => {
    const context = { ...grok }
    const chat = convertRequest('openai-responses', 'openai-chat', {
      model: 'codex', tools: [{ type: 'custom', name: 'run', description: 'Run text' }], input: [
        { type: 'custom_tool_call', call_id: 'call_1', name: 'run', input: 'echo hi' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' }
      ]
    }, 'grok', context)
    expect(chat.body.messages).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function' }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
    ])
    const responses = convertRequest('openai-chat', 'openai-responses', chat.body, 'codex', context)
    expect(responses.body.input).toMatchObject([
      { type: 'custom_tool_call', call_id: 'call_1', name: 'run', input: 'echo hi' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' }
    ])
  })

  it('keeps function names intact while custom aliases stay distinct and bounded', () => {
    const context = { ...grok }
    const chat = convertRequest('openai-responses', 'openai-chat', {
      model: 'codex', input: 'hello', tools: [
        { type: 'function', name: 'same_name', parameters: { type: 'object' } },
        { type: 'custom', name: 'same_name' },
        { type: 'custom', name: '很长工具名'.repeat(30) }
      ]
    }, 'grok', context)
    const names = (chat.body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    expect(names[0]).toBe('same_name')
    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true)
  })

  it('rejects unknown aliases and malformed custom wrappers', () => {
    const context = { ...grok }
    convertRequest('openai-responses', 'openai-chat', {
      model: 'codex', tools: [{ type: 'custom', name: 'run' }], input: 'hello'
    }, 'grok', context)
    expect(() => convertResponse('openai-chat', 'openai-responses', {
      id: 'c', choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'unknown', arguments: '{}' } }]
      } }]
    }, 'grok', Date.now, context)).toThrow(InvalidToolBridgeError)
    expect(() => convertResponse('openai-chat', 'openai-responses', {
      id: 'c', choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: context.toolBridgePlan!.tools[0].wireName, arguments: '{"input":1}' } }]
      } }]
    }, 'grok', Date.now, context)).toThrow(InvalidToolBridgeError)
  })

  it('preserves detail usage without inventing unknown token counts', () => {
    const output = convertResponse('openai-chat', 'openai-responses', {
      id: 'c', model: 'grok', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6,
        prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } }
    }, 'grok', () => 1_700_000_000_000, { ...grok })
    expect(output.usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } })
    const unknown = convertResponse('openai-chat', 'openai-responses', {
      id: 'c', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
    }, 'grok', Date.now, { ...grok })
    expect(unknown).not.toHaveProperty('usage')
  })
})
