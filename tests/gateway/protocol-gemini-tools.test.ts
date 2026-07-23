import { describe, expect, it } from 'vitest'
import { convertRequest, convertResponse } from '../../src/main/gateway'

const lookupSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city']
}

describe('Gemini tool protocol conversion', () => {
  it('keeps direct Responses/Gemini conversion shape compatible with the Chat bridge', () => {
    const responsesSource = {
      instructions: 'System',
      max_output_tokens: 55,
      temperature: 0.2,
      top_p: 0.7,
      tool_choice: { type: 'function', name: 'get_weather' },
      tools: [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: lookupSchema }],
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"temperature":21}' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }
      ]
    }
    const directGemini = convertRequest('openai-responses', 'gemini', responsesSource, 'target')
    const responsesChat = convertRequest('openai-responses', 'openai-chat', responsesSource, 'target')
    const bridgedGemini = convertRequest('openai-chat', 'gemini', responsesChat.body, 'target')
    expect(directGemini).toEqual(bridgedGemini)

    const geminiSource = {
      systemInstruction: { parts: [{ text: 'System' }] },
      generationConfig: { maxOutputTokens: 66, temperature: 0.5, topP: 0.6 },
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Weather', parameters: lookupSchema }] }],
      contents: [
        { role: 'model', parts: [
          { text: 'Checking' },
          { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }
        ] },
        { role: 'user', parts: [
          { functionResponse: { name: 'get_weather', response: { temperature: 21 } } },
          { text: 'Continue' }
        ] }
      ]
    }
    const directResponses = convertRequest('gemini', 'openai-responses', geminiSource, 'target')
    const geminiChat = convertRequest('gemini', 'openai-chat', geminiSource, 'target')
    const bridgedResponses = convertRequest('openai-chat', 'openai-responses', geminiChat.body, 'target')
    expect(directResponses).toEqual(bridgedResponses)
  })

  it('keeps direct Anthropic/Gemini request and response conversion shape compatible with the Chat bridge', () => {
    const anthropicSource = {
      system: [{ type: 'text', text: 'System' }],
      max_tokens: 88,
      temperature: 0.2,
      top_p: 0.7,
      stop_sequences: ['DONE'],
      tool_choice: { type: 'tool', name: 'get_weather' },
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: lookupSchema }],
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'Paris' } }
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: '{"temperature":21}' },
          { type: 'text', text: 'Continue' }
        ] }
      ]
    }
    const directGemini = convertRequest('anthropic-messages', 'gemini', anthropicSource, 'target')
    const anthropicChat = convertRequest('anthropic-messages', 'openai-chat', anthropicSource, 'target')
    const bridgedGemini = convertRequest('openai-chat', 'gemini', anthropicChat.body, 'target')
    expect(directGemini).toEqual(bridgedGemini)

    const geminiSource = {
      systemInstruction: { parts: [{ text: 'System' }] },
      generationConfig: { maxOutputTokens: 88, temperature: 0.2, topP: 0.7, stopSequences: ['DONE'] },
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Weather', parameters: lookupSchema }] }],
      contents: [
        { role: 'model', parts: [
          { text: 'Checking' },
          { functionCall: { id: 'tool_1', name: 'get_weather', args: { city: 'Paris' } } }
        ] },
        { role: 'user', parts: [
          { functionResponse: { id: 'tool_1', name: 'get_weather', response: { temperature: 21 } } },
          { text: 'Continue' }
        ] }
      ]
    }
    const directAnthropic = convertRequest('gemini', 'anthropic-messages', geminiSource, 'target')
    const geminiChat = convertRequest('gemini', 'openai-chat', geminiSource, 'target')
    const bridgedAnthropic = convertRequest('openai-chat', 'anthropic-messages', geminiChat.body, 'target')
    expect(directAnthropic).toEqual(bridgedAnthropic)

    const anthropicResponse = {
      id: 'msg_1',
      model: 'source',
      content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'Paris' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 2 }
    }
    const directResponseGemini = convertResponse('anthropic-messages', 'gemini', anthropicResponse, 'target')
    const responseChat = convertResponse('anthropic-messages', 'openai-chat', anthropicResponse, 'target', () => 1_700_000_000_000)
    const bridgedResponseGemini = convertResponse('openai-chat', 'gemini', responseChat, 'target')
    expect(directResponseGemini).toEqual(bridgedResponseGemini)

    const geminiResponse = {
      candidates: [{ content: { role: 'model', parts: [
        { text: 'Done' },
        { functionCall: { id: 'tool_1', name: 'get_weather', args: { city: 'Paris' } } }
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
    }
    const clock = () => 1_700_000_000_000
    const directResponseAnthropic = convertResponse('gemini', 'anthropic-messages', geminiResponse, 'target', clock)
    const geminiResponseChat = convertResponse('gemini', 'openai-chat', geminiResponse, 'target', clock)
    const bridgedResponseAnthropic = convertResponse('openai-chat', 'anthropic-messages', geminiResponseChat, 'target', clock)
    expect(directResponseAnthropic).toEqual(bridgedResponseAnthropic)
  })

  it('round-trips a multi-round Responses conversation through Gemini', () => {
    const source = {
      model: 'source-model',
      instructions: 'Use the weather tool.',
      max_output_tokens: 256,
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Get current weather',
        parameters: lookupSchema
      }],
      tool_choice: { type: 'function', name: 'get_weather' },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compare Paris and Tokyo.' }] },
        { type: 'function_call', call_id: 'call_paris', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_paris', output: '{"temperature":21}' },
        { type: 'function_call', call_id: 'call_tokyo', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        { type: 'function_call_output', call_id: 'call_tokyo', output: '{"temperature":26}' }
      ]
    }

    const gemini = convertRequest('openai-responses', 'gemini', source, 'gemini-target')
    expect(gemini.body).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Compare Paris and Tokyo.' }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_paris', name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_paris', name: 'get_weather', response: { temperature: 21 } } }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_tokyo', name: 'get_weather', args: { city: 'Tokyo' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_tokyo', name: 'get_weather', response: { temperature: 26 } } }] }
      ],
      systemInstruction: { parts: [{ text: 'Use the weather tool.' }] },
      generationConfig: { maxOutputTokens: 256 },
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Get current weather', parameters: lookupSchema }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } }
    })

    const roundTrip = convertRequest('gemini', 'openai-responses', gemini.body, 'final-model')
    expect(roundTrip.body).toEqual({ ...source, model: 'final-model' })
  })

  it('round-trips Anthropic tool results and stop sequences through Gemini', () => {
    const source = {
      model: 'source-model',
      system: 'Use the weather tool.',
      max_tokens: 128,
      stop_sequences: ['DONE', 'END'],
      tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: lookupSchema }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_paris', name: 'get_weather', input: { city: 'Paris' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_paris', content: '{"temperature":21}' }] }
      ]
    }

    const gemini = convertRequest('anthropic-messages', 'gemini', source, 'gemini-target')
    expect(gemini.body).toMatchObject({
      generationConfig: { maxOutputTokens: 128, stopSequences: ['DONE', 'END'] },
      contents: [
        { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
        {
          role: 'model',
          parts: [
            { text: 'Checking.' },
            { functionCall: { id: 'toolu_paris', name: 'get_weather', args: { city: 'Paris' } } }
          ]
        },
        {
          role: 'user',
          parts: [{ functionResponse: { id: 'toolu_paris', name: 'get_weather', response: { temperature: 21 } } }]
        }
      ]
    })

    const roundTrip = convertRequest('gemini', 'anthropic-messages', gemini.body, 'final-model')
    expect(roundTrip.body).toEqual({ ...source, model: 'final-model' })
  })

  it('correlates Gemini calls and results when Gemini omits call IDs', () => {
    const converted = convertRequest('gemini', 'openai-responses', {
      contents: [
        { role: 'user', parts: [{ text: 'Compare both cities.' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }
          ]
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_weather', response: { temperature: 21 } } },
            { functionResponse: { name: 'get_weather', response: { temperature: 26 } } }
          ]
        }
      ]
    }, 'target-model')

    expect(converted.body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compare both cities.' }] },
      { type: 'function_call', call_id: 'call_gemini_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call', call_id: 'call_gemini_2', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      { type: 'function_call_output', call_id: 'call_gemini_1', output: '{"temperature":21}' },
      { type: 'function_call_output', call_id: 'call_gemini_2', output: '{"temperature":26}' }
    ])
  })

  it('maps Anthropic stop_sequences to and from Chat stop', () => {
    const chat = convertRequest('anthropic-messages', 'openai-chat', {
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 32,
      stop_sequences: ['DONE', 'END']
    }, 'chat-model')
    expect(chat.body.stop).toEqual(['DONE', 'END'])
    expect(chat.body).not.toHaveProperty('stop_sequences')

    const anthropic = convertRequest('openai-chat', 'anthropic-messages', {
      messages: [{ role: 'user', content: 'Hello' }],
      stop: 'DONE'
    }, 'claude-model')
    expect(anthropic.body.stop_sequences).toEqual(['DONE'])
    expect(anthropic.body).not.toHaveProperty('stop')
  })

  it('marks a Gemini function-call response as a tool call for Anthropic', () => {
    const converted = convertResponse('gemini', 'anthropic-messages', {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { id: 'gemini_call_1', name: 'get_weather', args: { city: 'Paris' } } }]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
    }, 'gemini-model', () => 1_700_000_000_000)

    expect(converted).toMatchObject({
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'gemini_call_1', name: 'get_weather', input: { city: 'Paris' } }]
    })
  })
})
