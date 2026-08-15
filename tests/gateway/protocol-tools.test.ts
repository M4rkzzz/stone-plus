import { describe, expect, it } from 'vitest'
import { convertRequest, convertResponse } from '../../src/main/gateway'

const weatherSchema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
  },
  required: ['city'],
  additionalProperties: false
}

describe('non-streaming tool protocol conversion', () => {
  it('removes speculative DSH sandbox escalation without changing ordinary clients', () => {
    const source = {
      model: 'gpt-source',
      messages: [{ role: 'user', content: 'Create the marker.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'pwsh',
          description: 'Run PowerShell.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              sandbox_permissions: { type: 'string' },
              justification: { type: 'string' },
            },
            required: ['command', 'sandbox_permissions', 'justification'],
            additionalProperties: false,
          },
        },
      }],
    }

    const ordinary = convertRequest('openai-chat', 'openai-responses', source, 'gpt-target')
    expect(ordinary.body.tools).toMatchObject([{
      parameters: { properties: { sandbox_permissions: {}, justification: {} } },
    }])

    const converted = convertRequest('openai-chat', 'openai-responses', source, 'gpt-target', {
      sanitizeDeepSeekHarnessToolArguments: true,
    })
    const tool = (converted.body.tools as Array<Record<string, unknown>>)[0]
    const parameters = tool.parameters as Record<string, unknown>
    expect(parameters).toMatchObject({
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    })
    expect(parameters.properties).not.toHaveProperty('sandbox_permissions')
    expect(parameters.properties).not.toHaveProperty('justification')
    expect(tool.description).toContain('invoke this tool without sandbox_permissions')

    const response = {
      id: 'resp_dsh_tool',
      status: 'completed',
      output: [{
        type: 'function_call',
        call_id: 'call_pwsh',
        name: 'pwsh',
        arguments: JSON.stringify({
          command: "Set-Content -Path marker.txt -Value ok",
          sandbox_permissions: 'workspace-write',
          justification: 'Need to write the marker.',
        }),
      }],
    }
    const ordinaryResponse = convertResponse('openai-responses', 'openai-chat', response, 'gpt-target')
    expect(ordinaryResponse).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: {
        arguments: expect.stringContaining('sandbox_permissions'),
      } }] } }],
    })
    const dshResponse = convertResponse('openai-responses', 'openai-chat', response, 'gpt-target', Date.now, {
      sanitizeDeepSeekHarnessToolArguments: true,
    })
    expect(dshResponse).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: {
        arguments: JSON.stringify({ command: "Set-Content -Path marker.txt -Value ok" }),
      } }] } }],
    })
  })

  it('sanitizes same-protocol Chat tool responses for DSH only', () => {
    const source = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"marker.txt","sandbox_permissions":"workspace-write","justification":"write"}',
            },
          }],
        },
      }],
    }
    expect(convertResponse('openai-chat', 'openai-chat', source, 'gpt').choices)
      .toBe(source.choices)
    expect(convertResponse('openai-chat', 'openai-chat', source, 'gpt', Date.now, {
      sanitizeDeepSeekHarnessToolArguments: true,
    })).toMatchObject({ choices: [{ message: { tool_calls: [{ function: {
      arguments: '{"path":"marker.txt"}',
    } }] } }] })
  })

  it('normalizes every tool schema root to an object without dropping unions or constraints', () => {
    const union = {
      type: null,
      oneOf: [
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      ],
      additionalProperties: false,
    }
    const converted = convertRequest('openai-responses', 'anthropic-messages', {
      model: 'gpt-source',
      input: 'inspect',
      tools: [
        { type: 'function', name: 'union_tool', parameters: union },
        { type: 'function', name: 'missing_schema', parameters: null },
      ],
    }, 'claude-target')

    expect(converted.body.tools).toEqual([
      {
        name: 'union_tool',
        input_schema: { ...union, type: 'object' },
      },
      {
        name: 'missing_schema',
        input_schema: { type: 'object', properties: {} },
      },
    ])
  })

  it('keeps direct Responses/Anthropic conversion compatible while preserving Anthropic block order', () => {
    const responsesSource = {
      instructions: [{ type: 'input_text', text: 'System' }],
      max_output_tokens: 77,
      temperature: 0.4,
      top_p: 0.8,
      stream: false,
      parallel_tool_calls: true,
      tool_choice: 'required',
      tools: [{ type: 'function', name: 'lookup', parameters: weatherSchema }],
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"city":"Paris"}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"city":"Tokyo"}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: '21' }] },
        { type: 'function_call_output', call_id: 'call_2', output: '26' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }
      ]
    }
    const directAnthropic = convertRequest(
      'openai-responses', 'anthropic-messages', responsesSource, 'target'
    )
    const responsesChat = convertRequest('openai-responses', 'openai-chat', responsesSource, 'target')
    const bridgedAnthropic = convertRequest('openai-chat', 'anthropic-messages', responsesChat.body, 'target')
    expect(directAnthropic).toEqual(bridgedAnthropic)

    const anthropicSource = {
      system: [{ type: 'text', text: 'System' }],
      max_tokens: 91,
      temperature: 0.3,
      stream: false,
      tool_choice: { type: 'any', disable_parallel_tool_use: false },
      tools: [{ name: 'lookup', input_schema: weatherSchema }],
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'Before.' },
          { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { city: 'Paris' } },
          { type: 'text', text: 'After.' }
        ] },
        { role: 'user', content: [
          { type: 'text', text: 'prefix' },
          { type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: '21' }] },
          { type: 'text', text: 'suffix' }
        ] }
      ]
    }
    const directResponses = convertRequest(
      'anthropic-messages', 'openai-responses', anthropicSource, 'target'
    )
    expect(directResponses.body.input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before.' }] },
      { type: 'function_call', call_id: 'tool_1', name: 'lookup', arguments: '{"city":"Paris"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'After.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prefix' }] },
      { type: 'function_call_output', call_id: 'tool_1', output: [{ type: 'input_text', text: '21' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'suffix' }] },
    ])
  })

  it('preserves interleaved Anthropic response blocks in Responses output order', () => {
    const converted = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'msg_ordered',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        { type: 'text', text: 'Before.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { city: 'Paris' } },
        { type: 'text', text: 'After.' },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 3 },
    }, 'claude', () => 1_700_000_000_000)

    expect((converted.output as Array<Record<string, unknown>>).map((item) => item.type))
      .toEqual(['message', 'function_call', 'message'])
    expect(converted.output).toMatchObject([
      { content: [{ text: 'Before.' }] },
      { call_id: 'call_1', name: 'lookup' },
      { content: [{ text: 'After.' }] },
    ])
  })

  it('preserves every Responses message and its order around tool calls when converting responses', () => {
    const source = {
      id: 'resp_ordered',
      model: 'gpt-source',
      status: 'completed',
      output: [
        {
          id: 'msg_before', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Before.' }],
        },
        {
          id: 'fc_ordered', type: 'function_call', status: 'completed',
          call_id: 'call_ordered', name: 'lookup', arguments: '{"city":"Paris"}',
        },
        {
          id: 'msg_after', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'After.' }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 3 },
    }

    expect(convertResponse(
      'openai-responses', 'anthropic-messages', source, 'claude-target'
    ).content).toEqual([
      { type: 'text', text: 'Before.' },
      { type: 'tool_use', id: 'call_ordered', name: 'lookup', input: { city: 'Paris' } },
      { type: 'text', text: 'After.' },
    ])

    expect(convertResponse('openai-responses', 'openai-chat', source, 'chat-target'))
      .toMatchObject({ choices: [{ message: { content: 'Before.After.' } }] })

    expect(convertResponse('openai-responses', 'gemini', source, 'gemini-target'))
      .toMatchObject({ candidates: [{ content: { parts: [
        { text: 'Before.' },
        { functionCall: { id: 'call_ordered', name: 'lookup', args: { city: 'Paris' } } },
        { text: 'After.' },
      ] } }] })
  })

  it('converts a multi-round Responses request to Anthropic without losing tool semantics', () => {
    const converted = convertRequest('openai-responses', 'anthropic-messages', {
      model: 'gpt-source',
      instructions: 'Use tools for live data.',
      max_output_tokens: 512,
      parallel_tool_calls: false,
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Get current weather',
        parameters: weatherSchema
      }],
      tool_choice: { type: 'function', name: 'get_weather' },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
        { type: 'function_call', call_id: 'call_weather_1', name: 'get_weather', arguments: '{"city":"Paris","unit":"celsius"}' },
        { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temperature":21}' },
        { type: 'function_call', call_id: 'call_weather_2', name: 'get_weather', arguments: '{"city":"Tokyo","unit":"celsius"}' },
        { type: 'function_call_output', call_id: 'call_weather_2', output: '{"temperature":26}' }
      ]
    }, 'claude-target')

    expect(converted).toEqual({
      protocol: 'anthropic-messages',
      model: 'claude-target',
      body: {
        model: 'claude-target',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_weather_1', name: 'get_weather', input: { city: 'Paris', unit: 'celsius' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_weather_1', content: '{"temperature":21}' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_weather_2', name: 'get_weather', input: { city: 'Tokyo', unit: 'celsius' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_weather_2', content: '{"temperature":26}' }] }
        ],
        max_tokens: 512,
        system: 'Use tools for live data.',
        tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: weatherSchema }],
        tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true }
      }
    })
  })

  it('converts a multi-round Anthropic request to Responses without losing tool semantics', () => {
    const converted = convertRequest('anthropic-messages', 'openai-responses', {
      model: 'claude-source',
      system: [{ type: 'text', text: 'Use tools for live data.' }],
      max_tokens: 384,
      tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: weatherSchema }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Compare Paris and Tokyo.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_paris', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_paris', content: '{"temperature":21}' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Now Tokyo.' },
            { type: 'tool_use', id: 'toolu_tokyo', name: 'get_weather', input: { city: 'Tokyo' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_tokyo', content: [{ type: 'text', text: '{"temperature":26}' }] }] }
      ]
    }, 'gpt-target')

    expect(converted.body).toEqual({
      model: 'gpt-target',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compare Paris and Tokyo.' }] },
        { type: 'function_call', call_id: 'toolu_paris', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'toolu_paris', output: '{"temperature":21}' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Now Tokyo.' }] },
        { type: 'function_call', call_id: 'toolu_tokyo', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        { type: 'function_call_output', call_id: 'toolu_tokyo', output: [{ type: 'input_text', text: '{"temperature":26}' }] }
      ],
      max_output_tokens: 384,
      instructions: 'Use tools for live data.',
      parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'get_weather', description: 'Get current weather', parameters: weatherSchema }],
      tool_choice: 'required'
    })
  })

  it('round-trips a Responses tool conversation through Anthropic', () => {
    const source = {
      model: 'source',
      instructions: 'Call the selected tool.',
      max_output_tokens: 128,
      parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'get_weather', description: 'Get weather', parameters: weatherSchema }],
      tool_choice: { type: 'function', name: 'get_weather' },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Paris' }] },
        { type: 'function_call', call_id: 'call_roundtrip', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_roundtrip', output: '{"temperature":21}' }
      ]
    }

    const anthropic = convertRequest('openai-responses', 'anthropic-messages', source, 'bridge-model')
    const roundTrip = convertRequest('anthropic-messages', 'openai-responses', anthropic.body, 'final-model')

    expect(roundTrip.body).toEqual({
      ...source,
      model: 'final-model'
    })
  })

  it('round-trips an Anthropic tool conversation through Responses', () => {
    const source = {
      model: 'source',
      system: 'Call the selected tool.',
      max_tokens: 128,
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: weatherSchema }],
      tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Paris' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_roundtrip', name: 'get_weather', input: { city: 'Paris' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_roundtrip', content: '{"temperature":21}' }] }
      ]
    }

    const responses = convertRequest('anthropic-messages', 'openai-responses', source, 'bridge-model')
    const roundTrip = convertRequest('openai-responses', 'anthropic-messages', responses.body, 'final-model')

    expect(roundTrip.body).toEqual({
      ...source,
      model: 'final-model'
    })
  })

  it('preserves tool calls when converting completed responses in either direction', () => {
    const anthropic = convertResponse('openai-responses', 'anthropic-messages', {
      id: 'resp_1',
      model: 'gpt-source',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_response_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}'
      }],
      usage: { input_tokens: 10, output_tokens: 4 }
    }, 'fallback', () => 1_700_000_000_000)

    expect(anthropic).toMatchObject({
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_response_1', name: 'get_weather', input: { city: 'Paris' } }]
    })

    const responses = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'msg_1',
      model: 'claude-source',
      content: [{ type: 'tool_use', id: 'toolu_response_1', name: 'get_weather', input: { city: 'Tokyo' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 3 }
    }, 'fallback', () => 1_700_000_000_000)

    expect(responses).toMatchObject({
      object: 'response',
      model: 'claude-source',
      output: [{
        type: 'function_call',
        id: 'toolu_response_1',
        call_id: 'toolu_response_1',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}'
      }]
    })
  })
})
