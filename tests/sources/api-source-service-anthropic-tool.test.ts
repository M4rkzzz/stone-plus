import { describe, expect, it, vi } from 'vitest'
import type { ApiSourceProbeInput } from '../../src/shared/types'
import { probeApiSource } from '../../src/main/sources/api-source-service'

const credential = 'anthropic-relay-secret-do-not-return'
const proof = 'stone-fixed-anthropic-proof'
const sessionId = '11111111-2222-4333-8444-555555555555'
const model = 'claude-opus-5'

function relayInput(overrides: Partial<ApiSourceProbeInput> = {}): ApiSourceProbeInput {
  return {
    name: 'Anthropic relay',
    sourceType: 'relay',
    kind: 'anthropic-compatible',
    baseUrl: 'https://relay.example',
    protocol: 'anthropic-messages',
    credential,
    model,
    ...overrides,
  }
}

describe('Anthropic-compatible relay tool round-trip probe', () => {
  it('runs a real stream:true two-turn tool round trip with one stable tool id', async () => {
    const streamingBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return modelsResponse()
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (body.stream !== true) return jsonResponse({ content: [{ type: 'text', text: 'OK' }] })

      expect(String(request)).toBe('https://relay.example/v1/messages')
      const headers = new Headers(init.headers)
      expect(headers.get('x-api-key')).toBe(credential)
      expect(headers.get('accept')).toBe('text/event-stream')
      expect(headers.get('x-claude-code-session-id')).toBe(sessionId)
      streamingBodies.push(body)
      return streamingBodies.length === 1
        ? firstTurnStream('toolu_probe')
        : secondTurnStream(`Verification complete: ${proof}`)
    }) as typeof fetch

    const result = await probeApiSource(relayInput(), {
      fetchImplementation,
      createAnthropicToolProbeValues: () => ({ sessionId, proof }),
    })

    expect(fetchImplementation).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({
      ok: true,
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'success' },
        { id: 'models', status: 'success' },
        { id: 'generation', status: 'success' },
        { id: 'tool-roundtrip', status: 'success' },
      ],
      capabilityProfile: { origin: 'probed', toolCalls: true },
      toolRoundtrip: {
        firstTurn: { toolsCount: 1, toolUseCount: 1, stopReason: 'tool_use' },
        secondTurn: { toolResultCount: 1, toolUseCount: 0, stopReason: 'end_turn' },
      },
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(proof)
    expect(JSON.stringify(result)).not.toContain('toolu_probe')

    const firstMessages = streamingBodies[0].messages as Array<Record<string, unknown>>
    const secondMessages = streamingBodies[1].messages as Array<Record<string, unknown>>
    expect((streamingBodies[0].tools as unknown[])).toHaveLength(1)
    expect(firstMessages).toHaveLength(1)
    expect(secondMessages).toHaveLength(3)
    const assistantContent = secondMessages[1].content as Array<Record<string, unknown>>
    const resultContent = secondMessages[2].content as Array<Record<string, unknown>>
    expect(assistantContent[0]).toMatchObject({
      type: 'tool_use', id: 'toolu_probe', name: 'stone_anthropic_probe',
    })
    expect(resultContent[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_probe' })
  })

  it('fails closed when the relay replaces the final tool result with a placeholder', async () => {
    let streamTurn = 0
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return modelsResponse()
      const body = JSON.parse(String(init.body)) as { stream?: boolean }
      if (!body.stream) return jsonResponse({ content: [{ type: 'text', text: 'OK' }] })
      streamTurn += 1
      return streamTurn === 1
        ? firstTurnStream('toolu_placeholder')
        : secondTurnStream('[TOOL RESULTS INCLUDED]')
    }) as typeof fetch

    const result = await probeApiSource(relayInput(), {
      fetchImplementation,
      createAnthropicToolProbeValues: () => ({ sessionId, proof }),
    })

    expect(result.ok).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(result.toolRoundtrip).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(proof)
  })

  it('keeps official Anthropic on the existing one-turn probe', async () => {
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      return init?.method === 'POST'
        ? jsonResponse({ content: [{ type: 'text', text: 'OK' }] })
        : modelsResponse()
    }) as typeof fetch

    const result = await probeApiSource({
      ...relayInput(),
      sourceType: 'official-api',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    }, { fetchImplementation })

    expect(result.ok).toBe(true)
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'network', 'authentication', 'models', 'generation',
    ])
    expect(result.toolRoundtrip).toBeUndefined()
  })
})

function firstTurnStream(toolUseId: string): Response {
  return sseResponse([
    event('message_start', {
      type: 'message_start',
      message: { id: 'msg_first', model, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: 'stone_anthropic_probe', input: {} },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ proof }) },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''))
}

function secondTurnStream(text: string): Response {
  return sseResponse([
    event('message_start', {
      type: 'message_start',
      message: { id: 'msg_second', model, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    event('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''))
}

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(wire: string): Response {
  return new Response(wire, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function modelsResponse(): Response {
  return jsonResponse({ data: [{ id: model }] })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
