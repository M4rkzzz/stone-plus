import { describe, expect, it } from 'vitest'
import { analyzeProtocolConversion, convertRequest, convertResponse } from '../../src/main/gateway'

describe('Codex Responses and Claude Messages mapping', () => {
  it.each([
    ['claude-sonnet-4-6', 'xhigh', 'high'],
    ['claude-opus-4-7', 'xhigh', 'xhigh'],
    ['claude-sonnet-5', 'max', 'max'],
  ])('maps reasoning to adaptive thinking for %s', (model, effort, expected) => {
    const converted = convertRequest('openai-responses', 'anthropic-messages', {
      model: 'codex-model', input: 'solve it', max_output_tokens: 16_000,
      reasoning: { effort }, temperature: 0.2,
    }, model).body
    expect(converted).toMatchObject({
      model,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: expected },
    })
    expect(converted).not.toHaveProperty('temperature')
  })

  it('uses a bounded manual thinking budget for Claude 4.5', () => {
    const converted = convertRequest('openai-responses', 'anthropic-messages', {
      input: 'solve it', max_output_tokens: 5_000, reasoning: { effort: 'high' },
    }, 'claude-sonnet-4-5-20250929').body
    expect(converted).toMatchObject({
      max_tokens: 5_000,
      thinking: { type: 'enabled', budget_tokens: 4_999, display: 'omitted' },
    })
  })

  it('treats date-suffixed Claude 4 and version-first Claude 3.7 IDs as legacy models', () => {
    for (const model of ['claude-opus-4-20250514', 'claude-3-7-sonnet-20250219']) {
      const converted = convertRequest('openai-responses', 'anthropic-messages', {
        input: 'solve it', max_output_tokens: 4_096, reasoning: { effort: 'medium' },
      }, model).body
      expect(converted).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4_095 } })
      expect(converted).not.toHaveProperty('output_config')
    }
  })

  it('does not create an invalid legacy thinking budget when max_tokens is too small', () => {
    const converted = convertRequest('openai-responses', 'anthropic-messages', {
      input: 'solve it', max_output_tokens: 1_024, reasoning: { effort: 'low' },
    }, 'claude-haiku-4-5').body
    expect(converted).not.toHaveProperty('thinking')
  })

  it('maps Claude adaptive effort back to Responses reasoning', () => {
    const converted = convertRequest('anthropic-messages', 'openai-responses', {
      model: 'claude-opus-4-8', max_tokens: 8_000,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'solve it' }],
    }, 'gpt-target').body
    expect(converted.reasoning).toEqual({ effort: 'xhigh' })
  })

  it('preserves strict client tools in both directions', () => {
    const responses = {
      input: 'use it',
      tools: [{ type: 'function', name: 'lookup', strict: true, parameters: { type: 'object' } }],
    }
    expect(analyzeProtocolConversion('openai-responses', 'anthropic-messages', responses))
      .toEqual({ supported: true, issues: [] })
    const anthropic = convertRequest('openai-responses', 'anthropic-messages', responses, 'claude-opus-4-8').body
    expect(anthropic).toMatchObject({ tools: [{ name: 'lookup', strict: true }] })
    const roundTrip = convertRequest('anthropic-messages', 'openai-responses', anthropic, 'gpt-target').body
    expect(roundTrip).toMatchObject({ tools: [{ type: 'function', name: 'lookup', strict: true }] })
  })

  it('maps Claude cache and thinking usage into Responses token details', () => {
    const converted = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'msg_usage', model: 'claude-opus-4-8', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'must not leak', signature: 'encrypted' }, { type: 'text', text: 'answer' }],
      usage: {
        input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20,
        output_tokens: 12, output_tokens_details: { thinking_tokens: 7 },
      },
    }, 'fallback')
    expect(converted).toMatchObject({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
      usage: {
        input_tokens: 60, output_tokens: 12, total_tokens: 72,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    })
    expect(JSON.stringify(converted)).not.toContain('must not leak')
    expect(JSON.stringify(converted)).not.toContain('encrypted')
  })
})
