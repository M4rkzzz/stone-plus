import { describe, expect, it, vi } from 'vitest'
import type { ApiSourceProbeInput, Protocol, ProviderKind } from '../../src/shared/types'
import { probeApiSource } from '../../src/main/sources/api-source-service'

interface ProbeCase {
  name: string
  kind: ProviderKind
  protocol: Protocol
  baseUrl: string
  generationEndpoint: string
  modelsPayload: unknown
  generationPayload: unknown
  credentialHeader: string
  credentialHeaderValue: string
}

const credential = 'sk-source-private-123456789'

const probeCases: ProbeCase[] = [
  {
    name: 'OpenAI Responses',
    kind: 'openai',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    generationEndpoint: 'https://api.openai.com/v1/responses',
    modelsPayload: { data: [{ id: 'test-model' }] },
    generationPayload: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] },
    credentialHeader: 'authorization',
    credentialHeaderValue: `Bearer ${credential}`
  },
  {
    name: 'OpenAI Chat relay',
    kind: 'openai-compatible',
    protocol: 'openai-chat',
    baseUrl: 'https://relay.example/v1',
    generationEndpoint: 'https://relay.example/v1/chat/completions',
    modelsPayload: { data: [{ id: 'test-model' }] },
    generationPayload: { choices: [{ message: { content: 'OK' } }] },
    credentialHeader: 'authorization',
    credentialHeaderValue: `Bearer ${credential}`
  },
  {
    name: 'Anthropic Messages',
    kind: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    generationEndpoint: 'https://api.anthropic.com/v1/messages',
    modelsPayload: { data: [{ id: 'test-model' }] },
    generationPayload: { content: [{ type: 'text', text: 'OK' }] },
    credentialHeader: 'x-api-key',
    credentialHeaderValue: credential
  },
  {
    name: 'Gemini',
    kind: 'google',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    generationEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
    modelsPayload: {
      models: [{ name: 'models/test-model', supportedGenerationMethods: ['generateContent'] }]
    },
    generationPayload: { candidates: [{ content: { parts: [{ text: 'OK' }] } }] },
    credentialHeader: 'x-goog-api-key',
    credentialHeaderValue: credential
  }
]

describe('API source probe service', () => {
  it.each(probeCases)('probes network, authentication, models and real generation for $name', async (fixture) => {
    const fetchImplementation = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(String(request)).toBe(fixture.generationEndpoint)
        return jsonResponse(fixture.generationPayload)
      }
      return jsonResponse(fixture.modelsPayload)
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(fixture), { fetchImplementation })

    expect(result).toMatchObject({
      ok: true,
      models: ['test-model'],
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'success' },
        { id: 'models', status: 'success' },
        { id: 'generation', status: 'success' }
      ],
      warnings: []
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    for (const [, init] of vi.mocked(fetchImplementation).mock.calls) {
      expect(new Headers(init?.headers).get(fixture.credentialHeader)).toBe(fixture.credentialHeaderValue)
    }
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it('uses an injected stored credential when an edited source leaves the key blank', async () => {
    const storedCredential = 'stored-source-secret'
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${storedCredential}`)
      if (init?.method === 'POST') {
        return jsonResponse({ choices: [{ message: { content: 'OK' } }] })
      }
      return jsonResponse({ data: [{ id: 'test-model' }] })
    }) as typeof fetch

    const result = await probeApiSource({
      ...sourceInput(probeCases[1]),
      id: 'existing-source',
      credential: '   '
    }, { storedCredential, fetchImplementation })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(storedCredential)
  })

  it('does not make a request when neither a new nor stored credential is available', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch
    const result = await probeApiSource({
      ...sourceInput(probeCases[0]),
      credential: ''
    }, { fetchImplementation })

    expect(result.ok).toBe(false)
    expect(result.stages).toEqual([
      expect.objectContaining({ id: 'network', status: 'skipped' }),
      expect.objectContaining({ id: 'authentication', status: 'error' }),
      expect.objectContaining({ id: 'models', status: 'skipped' }),
      expect.objectContaining({ id: 'generation', status: 'skipped' })
    ])
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('returns a safe authentication failure without reading or exposing an echoed key', async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      `credential ${credential} was rejected`,
      { status: 401 }
    )) as typeof fetch

    const result = await probeApiSource(sourceInput(probeCases[0]), { fetchImplementation })

    expect(result).toMatchObject({
      ok: false,
      stages: [
        { id: 'network', status: 'success' },
        { id: 'authentication', status: 'error' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' }
      ]
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it('allows a manually selected model to verify a relay without a models endpoint', async () => {
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ choices: [{ message: { content: 'OK' } }] })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    const result = await probeApiSource({
      ...sourceInput(probeCases[1]),
      model: 'manually-configured-model'
    }, { fetchImplementation })

    expect(result.ok).toBe(true)
    expect(result.models).toEqual([])
    expect(result.stages).toEqual([
      expect.objectContaining({ id: 'network', status: 'success' }),
      expect.objectContaining({ id: 'authentication', status: 'success' }),
      expect.objectContaining({ id: 'models', status: 'warning' }),
      expect.objectContaining({ id: 'generation', status: 'success' })
    ])
    expect(result.warnings).toHaveLength(1)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('classifies transport failures and never surfaces a thrown message containing the key', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError(`connect failed for ${credential}`)
    }) as typeof fetch

    const result = await probeApiSource(sourceInput(probeCases[0]), { fetchImplementation })

    expect(result).toMatchObject({
      ok: false,
      stages: [
        { id: 'network', status: 'error' },
        { id: 'authentication', status: 'skipped' },
        { id: 'models', status: 'skipped' },
        { id: 'generation', status: 'skipped' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it('drops malicious model identifiers that echo credentials', async () => {
    const fetchImplementation = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ choices: [{ message: { content: 'OK' } }] })
      }
      return jsonResponse({ data: [{ id: credential }, { id: 'safe-model' }] })
    }) as typeof fetch

    const result = await probeApiSource({
      ...sourceInput(probeCases[1]),
      model: 'safe-model'
    }, { fetchImplementation })

    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['safe-model'])
    expect(JSON.stringify(result)).not.toContain(credential)
  })
})

function sourceInput(fixture: ProbeCase): ApiSourceProbeInput {
  return {
    name: fixture.name,
    sourceType: fixture.kind === 'openai-compatible' ? 'relay' : 'official-api',
    kind: fixture.kind,
    baseUrl: fixture.baseUrl,
    protocol: fixture.protocol,
    credential
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
