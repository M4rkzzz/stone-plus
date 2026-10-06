import { describe, expect, it, vi } from 'vitest'
import type { ApiSourceProbeInput } from '../../src/shared/types'
import { probeApiSource } from '../../src/main/sources/api-source-service'

const endpoint = 'https://relay.example/internal/GenerateAssistantResponse'
const credential = 'kiro-secret-do-not-return'
const model = 'claude-sonnet-4.6'
const conversationId = '11111111-2222-4333-8444-555555555555'
const proof = 'stone-fixed-in-memory-proof'
const probeTool = 'stone_kiro_probe'

function sourceInput(overrides: Partial<ApiSourceProbeInput> = {}): ApiSourceProbeInput {
  return {
    name: 'Kiro relay',
    sourceType: 'relay',
    kind: 'kiro-compatible',
    baseUrl: endpoint,
    protocol: 'kiro-claude',
    credential,
    model,
    ...overrides,
  }
}

function dependencies(fetchImplementation: typeof fetch) {
  return {
    fetchImplementation,
    createKiroProbeValues: () => ({ conversationId, proof }),
  }
}

describe('Kiro Claude API source tool round-trip probe', () => {
  it('posts two native requests to the exact endpoint and records only safe diagnostics', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(String(request)).toBe(endpoint)
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${credential}`)
      expect(headers.get('content-type')).toBe('application/x-amz-json-1.0')
      expect(headers.get('x-amz-target'))
        .toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(body)
      if (requestBodies.length === 1) {
        return eventStreamResponse(toolUseFrame('remote-call-id', { proof }))
      }
      return eventStreamResponse(eventFrame('assistantResponseEvent', {
        content: `Verification complete: ${proof}`,
      }))
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      ok: true,
      models: [model],
      testedModel: model,
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'success' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' },
        { id: 'tool-roundtrip', status: 'success' },
      ],
      capabilityProfile: {
        origin: 'probed',
        toolCalls: true,
        modelDiscovery: false,
        streaming: true,
      },
      toolRoundtrip: {
        firstTurn: { toolsCount: 1, toolUseCount: 1, stopReason: 'tool_use' },
        secondTurn: { toolResultCount: 1, toolUseCount: 0, stopReason: 'end_turn' },
      },
    })
    expect(result.modelCatalog).toEqual([
      expect.objectContaining({
        id: model,
        capabilities: expect.objectContaining({ toolCalls: true }),
      }),
    ])
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(proof)
    expect(JSON.stringify(result)).not.toContain('remote-call-id')

    const firstState = conversationState(requestBodies[0])
    const secondState = conversationState(requestBodies[1])
    expect(firstState.conversationId).toBe(conversationId)
    expect(secondState.conversationId).toBe(conversationId)
    expect(currentContext(firstState).tools).toHaveLength(1)
    expect(secondState.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assistantResponseMessage: expect.objectContaining({
          toolUses: [expect.objectContaining({ toolUseId: 'remote-call-id', name: probeTool })],
        }),
      }),
    ]))
    expect(currentMessage(secondState).content).toBe('')
    expect(currentContext(secondState).toolResults).toEqual([
      expect.objectContaining({
        toolUseId: 'remote-call-id',
        content: [{ json: expect.objectContaining({ stdout: proof }) }],
      }),
    ])
  })

  it('does not call generic health or model endpoints', async () => {
    const methods: string[] = []
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return methods.length === 1
        ? eventStreamResponse(toolUseFrame('call-1', { proof }))
        : eventStreamResponse(eventFrame('assistantResponseEvent', { content: proof }))
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result.ok).toBe(true)
    expect(methods).toEqual(['POST', 'POST'])
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the first turn returns text instead of one tool call', async () => {
    const fetchImplementation = vi.fn(async () => eventStreamResponse(
      eventFrame('assistantResponseEvent', { content: 'I will not call it.' })
    )) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result).toMatchObject({
      ok: false,
      capabilityProfile: { origin: 'inferred', toolCalls: false },
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'success' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' },
        { id: 'tool-roundtrip', status: 'error' },
      ],
    })
    expect(result.toolRoundtrip).toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('rejects an incorrect proof in the first structured tool call', async () => {
    const fetchImplementation = vi.fn(async () => eventStreamResponse(
      toolUseFrame('call-wrong-proof', { proof: 'different' })
    )) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result.ok).toBe(false)
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('different')
    expect(JSON.stringify(result)).not.toContain('call-wrong-proof')
  })

  it('rejects a probe tool call that violates the declared input schema', async () => {
    const fetchImplementation = vi.fn(async () => eventStreamResponse(
      toolUseFrame('call-extra-field', { proof, injected: true })
    )) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result.ok).toBe(false)
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('injected')
    expect(JSON.stringify(result)).not.toContain('call-extra-field')
  })

  it('rejects a repeated tool call on the second turn', async () => {
    let turn = 0
    const fetchImplementation = vi.fn(async () => {
      turn += 1
      return eventStreamResponse(toolUseFrame(turn === 1 ? 'first-id' : 'repeated-id', { proof }))
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result.ok).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(result.toolRoundtrip).toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('rejects a second-turn end_turn that does not contain the proof', async () => {
    let turn = 0
    const fetchImplementation = vi.fn(async () => {
      turn += 1
      return turn === 1
        ? eventStreamResponse(toolUseFrame('first-id', { proof }))
        : eventStreamResponse(eventFrame('assistantResponseEvent', { content: 'Done, but omitted.' }))
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result.ok).toBe(false)
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('rejects a 200 JSON response before parsing or retrying', async () => {
    const fetchImplementation = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result).toMatchObject({
      ok: false,
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'success' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' },
        { id: 'tool-roundtrip', status: 'error' },
      ],
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('classifies credential rejection without reading or exposing the response body', async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      `credential ${credential} and proof ${proof}`,
      { status: 401, headers: { 'content-type': 'text/plain' } },
    )) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result).toMatchObject({
      ok: false,
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'error' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' },
        { id: 'tool-roundtrip', status: 'skipped' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(proof)
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('returns pending tool capability on transport failure without leaking the thrown message', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError(`network failed for ${credential} ${proof}`)
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(), dependencies(fetchImplementation))

    expect(result).toMatchObject({
      ok: false,
      stages: [
        { id: 'network', status: 'error' },
        { id: 'authentication', status: 'skipped' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' },
        { id: 'tool-roundtrip', status: 'skipped' },
      ],
      capabilityProfile: { origin: 'inferred', toolCalls: false },
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(proof)
  })

  it('requires a manually selected model without making any network request', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch

    const result = await probeApiSource(sourceInput({ model: '   ' }), dependencies(fetchImplementation))

    expect(result.ok).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'error' })
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('keeps untested capability false when no credential is available', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch

    const result = await probeApiSource(sourceInput({ credential: '' }), {
      fetchImplementation,
      createKiroProbeValues: () => ({ conversationId, proof }),
    })

    expect(result.ok).toBe(false)
    expect(result.capabilityProfile.toolCalls).toBe(false)
    expect(result.stages.at(-1)).toMatchObject({ id: 'tool-roundtrip', status: 'skipped' })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })
})

function conversationState(body: Record<string, unknown>): Record<string, unknown> {
  return body.conversationState as Record<string, unknown>
}

function currentMessage(state: Record<string, unknown>): Record<string, unknown> {
  const current = state.currentMessage as Record<string, unknown>
  return current.userInputMessage as Record<string, unknown>
}

function currentContext(state: Record<string, unknown>): Record<string, unknown> {
  return currentMessage(state).userInputMessageContext as Record<string, unknown>
}

function eventStreamResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

function toolUseFrame(id: string, input: Record<string, unknown>): Uint8Array {
  return eventFrame('toolUseEvent', { toolUseId: id, name: probeTool, input, stop: true })
}

function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return awsEventStreamFrame([
    [':message-type', 'event'],
    [':event-type', eventType],
    [':content-type', 'application/json'],
  ], new TextEncoder().encode(JSON.stringify(payload)))
}

function awsEventStreamFrame(headers: Array<[string, string]>, payload: Uint8Array): Uint8Array {
  const headerBytes = concatBytes(...headers.map(([name, value]) => stringHeader(name, value)))
  const totalLength = 16 + headerBytes.length + payload.length
  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength, false)
  view.setUint32(4, headerBytes.length, false)
  view.setUint32(8, crc32(frame.subarray(0, 8)), false)
  frame.set(headerBytes, 12)
  frame.set(payload, 12 + headerBytes.length)
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false)
  return frame
}

function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const valueBytes = new TextEncoder().encode(value)
  const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  output[0] = nameBytes.length
  output.set(nameBytes, 1)
  output[1 + nameBytes.length] = 7
  new DataView(output.buffer).setUint16(2 + nameBytes.length, valueBytes.length, false)
  output.set(valueBytes, 4 + nameBytes.length)
  return output
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}
