import { describe, expect, it, vi } from 'vitest'
import {
  anthropicAdapter,
  anthropicCompatibleAdapter,
  customAdapter,
  getProviderAdapter,
  googleAdapter,
  openAIAdapter,
  openAICompatibleAdapter
} from '../../src/main/providers'

describe('provider adapter endpoints', () => {
  it('normalizes unversioned and already-versioned OpenAI base URLs', () => {
    expect(openAIAdapter.buildEndpoint({
      baseUrl: 'https://api.openai.com',
      protocol: 'openai-responses',
      operation: 'generate'
    })).toBe('https://api.openai.com/v1/responses')

    expect(openAIAdapter.buildEndpoint({
      baseUrl: 'https://api.openai.com/v1/',
      protocol: 'openai-responses',
      operation: 'generate'
    })).toBe('https://api.openai.com/v1/responses')

    expect(openAICompatibleAdapter.buildEndpoint({
      baseUrl: 'https://gateway.example.test/api/v1?tenant=stone',
      protocol: 'openai-chat',
      operation: 'generate'
    })).toBe('https://gateway.example.test/api/v1/chat/completions?tenant=stone')

    expect(openAIAdapter.buildEndpoint({
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      operation: 'search'
    })).toBe('https://api.openai.com/v1/alpha/search')
  })

  it('builds Anthropic-compatible endpoints without duplicating v1', () => {
    expect(anthropicCompatibleAdapter.buildEndpoint({
      baseUrl: 'https://anthropic.example.test/proxy/v1',
      protocol: 'anthropic-messages',
      operation: 'generate'
    })).toBe('https://anthropic.example.test/proxy/v1/messages')
    expect(anthropicAdapter.buildEndpoint({
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic-messages',
      operation: 'models'
    })).toBe('https://api.anthropic.com/v1/models')
  })

  it('requests Gemini streaming responses as SSE', () => {
    expect(googleAdapter.buildEndpoint({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      protocol: 'gemini',
      operation: 'generate',
      model: 'publishers/google/gemini-test',
      stream: true
    })).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/publishers%2Fgoogle%2Fgemini-test:streamGenerateContent?alt=sse'
    )

    const headers = new Headers()
    googleAdapter.applyRequestHeaders(headers, {
      protocol: 'gemini',
      credential: 'google-secret',
      stream: true,
      sourceHeaders: { accept: 'application/json' }
    })
    expect(headers.get('accept')).toBe('text/event-stream')
  })

  it('keeps a protocol-dependent custom fallback', () => {
    expect(getProviderAdapter('custom')).toBe(customAdapter)
    expect(customAdapter.buildEndpoint({
      baseUrl: 'https://custom.example.test',
      protocol: 'gemini',
      operation: 'generate',
      model: 'gemini-test'
    })).toBe('https://custom.example.test/v1beta/models/gemini-test:generateContent')
    expect(customAdapter.buildEndpoint({
      baseUrl: 'https://custom.example.test/v1',
      protocol: 'openai-chat',
      operation: 'generate'
    })).toBe('https://custom.example.test/v1/chat/completions')
  })

  it('rejects credentials embedded in provider URLs', () => {
    expect(() => openAIAdapter.buildEndpoint({
      baseUrl: 'https://user:secret@example.test/v1',
      protocol: 'openai-chat',
      operation: 'models'
    })).toThrow(/must not contain credentials/)
    expect(() => googleAdapter.buildEndpoint({
      baseUrl: 'https://example.test/v1beta?key=secret',
      protocol: 'gemini',
      operation: 'models'
    })).toThrow(/must not contain credentials/)
  })
})

describe('provider adapter authentication', () => {
  it('applies OpenAI bearer headers and only forwards approved metadata', () => {
    const headers = new Headers()
    openAIAdapter.applyRequestHeaders(headers, {
      protocol: 'openai-responses',
      credential: 'openai-secret',
      sourceHeaders: {
        authorization: 'Bearer local-gateway-token',
        'openai-organization': 'org_stone',
        'openai-project': 'proj_stone',
        'user-agent': 'Stone/Test'
      }
    })
    expect(Object.fromEntries(headers)).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer openai-secret',
      'content-type': 'application/json',
      'openai-organization': 'org_stone',
      'openai-project': 'proj_stone',
      'user-agent': 'Stone/Test'
    })
    expect(headers.get('authorization')).not.toContain('local-gateway-token')
  })

  it('applies Anthropic version and API key headers', () => {
    const headers = new Headers()
    anthropicAdapter.applyRequestHeaders(headers, {
      protocol: 'anthropic-messages',
      credential: 'anthropic-secret',
      sourceHeaders: {
        'anthropic-version': '2025-01-01',
        'anthropic-beta': 'tools-test'
      }
    })
    expect(headers.get('x-api-key')).toBe('anthropic-secret')
    expect(headers.get('anthropic-version')).toBe('2025-01-01')
    expect(headers.get('anthropic-beta')).toBe('tools-test')
    expect(headers.has('authorization')).toBe(false)
  })

  it('applies Google API keys as headers rather than query parameters', () => {
    const headers = new Headers()
    googleAdapter.applyRequestHeaders(headers, {
      protocol: 'gemini',
      credential: 'google-secret'
    })
    expect(headers.get('x-goog-api-key')).toBe('google-secret')
    expect(googleAdapter.buildEndpoint({
      baseUrl: 'https://generativelanguage.googleapis.com',
      protocol: 'gemini',
      operation: 'models'
    })).toBe('https://generativelanguage.googleapis.com/v1beta/models')
  })

  it('publishes a protocol capability matrix', () => {
    expect(openAIAdapter.capabilities.protocols['openai-responses']).toMatchObject({
      streaming: true,
      toolCalls: true,
      modelInPath: false
    })
    expect(googleAdapter.capabilities.protocols.gemini?.modelInPath).toBe(true)
    expect(anthropicAdapter.capabilities.authentication).toBe('x-api-key')
  })
})

describe('provider discovery and health probes', () => {
  it('discovers OpenAI models without exposing credentials in the result', async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer discovery-secret')
      return new Response(JSON.stringify({
        data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = await openAIAdapter.discoverModels({
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      credential: 'discovery-secret',
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({ ok: true, models: ['gpt-5', 'gpt-5-mini'], statusCode: 200 })
    expect(JSON.stringify(result)).not.toContain('discovery-secret')
  })

  it('discovers only generative Gemini models and strips the models prefix', async () => {
    const result = await googleAdapter.discoverModels({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      protocol: 'gemini',
      credential: 'google-secret',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ]
      }), { status: 200 })) as typeof fetch
    })
    expect(result).toMatchObject({ ok: true, models: ['gemini-pro'] })
  })

  it('follows Gemini pageToken pagination with one timeout signal', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      signals.push(init?.signal)
      if (fetchImplementation.mock.calls.length === 1) {
        expect(url.searchParams.has('pageToken')).toBe(false)
        return new Response(JSON.stringify({
          models: [
            { name: 'models/gemini-first', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
          ],
          nextPageToken: 'page 2/+'
        }), { status: 200 })
      }
      if (fetchImplementation.mock.calls.length === 2) {
        expect(url.searchParams.get('pageToken')).toBe('page 2/+')
        return new Response(JSON.stringify({
          models: [
            { name: 'models/gemini-second', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-first', supportedGenerationMethods: ['generateContent'] }
          ],
          nextPageToken: 'page-3'
        }), { status: 200 })
      }
      expect(url.searchParams.get('pageToken')).toBe('page-3')
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-third', supportedGenerationMethods: ['generateContent'] }]
      }), { status: 200 })
    })

    const result = await googleAdapter.discoverModels({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      protocol: 'gemini',
      credential: 'google-secret',
      timeoutMs: 5_000,
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({
      ok: true,
      models: ['gemini-first', 'gemini-second', 'gemini-third']
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBe(signals[0])
    expect(signals[2]).toBe(signals[0])
  })

  it('follows Anthropic after_id pagination with one caller-and-timeout signal', async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      signals.push(init?.signal)
      if (fetchImplementation.mock.calls.length === 1) {
        expect(url.searchParams.has('after_id')).toBe(false)
        return new Response(JSON.stringify({
          data: [{ id: 'claude-first' }],
          has_more: true,
          last_id: 'model_1/+'
        }), { status: 200 })
      }
      expect(url.searchParams.get('after_id')).toBe('model_1/+')
      return new Response(JSON.stringify({
        data: [{ id: 'claude-second' }],
        has_more: false,
        last_id: 'model_2'
      }), { status: 200 })
    })

    const result = await anthropicAdapter.discoverModels({
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic-messages',
      credential: 'anthropic-secret',
      signal: controller.signal,
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({ ok: true, models: ['claude-first', 'claude-second'] })
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]).not.toBe(controller.signal)
    expect(signals[1]).toBe(signals[0])

    controller.abort(new DOMException('caller cancelled', 'AbortError'))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toMatchObject({ name: 'AbortError', message: 'caller cancelled' })
  })

  it('fails the whole discovery when a later page fails', async () => {
    const fetchImplementation = vi.fn(async () => fetchImplementation.mock.calls.length === 1
      ? new Response(JSON.stringify({
          models: [{ name: 'models/gemini-partial', supportedGenerationMethods: ['generateContent'] }],
          nextPageToken: 'next'
        }), { status: 200 })
      : new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }))

    const result = await googleAdapter.discoverModels({
      baseUrl: 'https://generativelanguage.googleapis.com',
      protocol: 'gemini',
      credential: 'google-secret',
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({
      ok: false,
      models: [],
      statusCode: 503,
      failure: { category: 'upstream' }
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('rejects repeated pagination cursors instead of looping', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: `models/gemini-${fetchImplementation.mock.calls.length}`, supportedGenerationMethods: ['generateContent'] }],
      nextPageToken: 'repeated'
    }), { status: 200 }))

    const result = await googleAdapter.discoverModels({
      baseUrl: 'https://generativelanguage.googleapis.com',
      protocol: 'gemini',
      credential: 'google-secret',
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({ ok: false, models: [], failure: { category: 'invalid_response' } })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('fails rather than returning a partial catalog beyond twenty pages', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: `models/gemini-${fetchImplementation.mock.calls.length}`, supportedGenerationMethods: ['generateContent'] }],
      nextPageToken: `cursor-${fetchImplementation.mock.calls.length}`
    }), { status: 200 }))

    const result = await googleAdapter.discoverModels({
      baseUrl: 'https://generativelanguage.googleapis.com',
      protocol: 'gemini',
      credential: 'google-secret',
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({ ok: false, models: [], failure: { category: 'invalid_response' } })
    expect(fetchImplementation).toHaveBeenCalledTimes(20)
  })

  it('requires Anthropic to provide last_id while has_more is true', async () => {
    const result = await anthropicAdapter.discoverModels({
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic-messages',
      credential: 'anthropic-secret',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        data: [{ id: 'claude-partial' }],
        has_more: true
      }), { status: 200 })) as typeof fetch
    })

    expect(result).toMatchObject({ ok: false, models: [], failure: { category: 'invalid_response' } })
  })

  it('does not guess OpenAI pagination and filters only high-confidence non-generation families', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5' },
        { id: 'o3' },
        { id: 'vendor/claude-sonnet-4-5' },
        { id: 'vendor/gemini-2.5-pro' },
        { id: 'gpt-4o-audio-preview' },
        { id: 'vendor/custom-embedding-chat' },
        { id: 'gpt-image-1' },
        { id: 'gpt-4o-mini-transcribe' },
        { id: 'gpt-4o-mini-tts' },
        { id: 'sora-2' },
        { id: 'babbage-002' },
        { id: 'text-davinci-003' },
        { id: 'text-embedding-3-small' },
        { id: 'openai/text-embedding-3-large' },
        { id: 'omni-moderation-latest' },
        { id: 'whisper-1' },
        { id: 'tts-1' },
        { id: 'dall-e-3' },
        { id: 'rerank-v3' }
      ],
      has_more: true,
      last_id: 'must-not-be-followed',
      nextPageToken: 'must-not-be-followed'
    }), { status: 200 }))

    const result = await openAICompatibleAdapter.discoverModels({
      baseUrl: 'https://gateway.example.test/v1',
      protocol: 'openai-chat',
      credential: 'compatible-secret',
      fetchImplementation: fetchImplementation as typeof fetch
    })

    expect(result).toMatchObject({
      ok: true,
      models: [
        'gpt-5',
        'o3',
        'vendor/claude-sonnet-4-5',
        'vendor/gemini-2.5-pro',
        'gpt-4o-audio-preview',
        'vendor/custom-embedding-chat'
      ]
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('does not return an upstream error body that echoes a credential', async () => {
    const result = await openAIAdapter.probeHealth({
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      credential: 'never-return-this-secret',
      fetchImplementation: vi.fn(async () => new Response(
        'credential never-return-this-secret was rejected',
        { status: 401 }
      )) as typeof fetch
    })
    expect(result).toMatchObject({
      ok: false,
      statusCode: 401,
      failure: { category: 'authentication', accountAction: 'disable', retryable: true }
    })
    expect(JSON.stringify(result)).not.toContain('never-return-this-secret')
  })
})

describe('provider failure classification', () => {
  it('honors Retry-After seconds on 429 responses', () => {
    expect(openAIAdapter.classifyFailure({
      statusCode: 429,
      headers: { 'retry-after': '12.5' },
      now: 1_700_000_000_000
    })).toEqual({
      category: 'rate_limit',
      message: 'Provider rate limit reached.',
      retryable: true,
      accountAction: 'cooldown',
      statusCode: 429,
      retryAfterMs: 12_500,
      retryAt: 1_700_000_012_500
    })
  })

  it('honors HTTP-date Retry-After values', () => {
    const now = Date.parse('2026-07-12T00:00:00.000Z')
    const failure = googleAdapter.classifyFailure({
      statusCode: 429,
      headers: { 'retry-after': 'Sun, 12 Jul 2026 00:00:07 GMT' },
      now
    })
    expect(failure).toMatchObject({ retryAfterMs: 7_000, retryAt: now + 7_000 })
  })

  it('disables accounts after 401 responses', () => {
    expect(anthropicAdapter.classifyFailure({ statusCode: 401 })).toMatchObject({
      category: 'authentication',
      retryable: true,
      accountAction: 'disable',
      statusCode: 401
    })
  })

  it('disables a depleted account while allowing pool failover after 402', () => {
    expect(openAIAdapter.classifyFailure({ statusCode: 402 })).toEqual({
      category: 'quota',
      message: 'Provider account quota is depleted or requires payment.',
      retryable: true,
      accountAction: 'disable',
      statusCode: 402
    })
  })

  it('allows account failover after 403 without retrying a cancelled request', () => {
    expect(anthropicCompatibleAdapter.classifyFailure({ statusCode: 403 })).toMatchObject({
      category: 'permission',
      retryable: true,
      accountAction: 'disable'
    })
    expect(customAdapter.classifyFailure({
      error: new DOMException('cancelled by client', 'AbortError')
    })).toMatchObject({
      category: 'cancelled',
      retryable: false,
      accountAction: 'none'
    })
  })

  it('classifies 5xx responses as retryable upstream failures', () => {
    expect(openAICompatibleAdapter.classifyFailure({
      statusCode: 503,
      headers: { 'retry-after': '3' },
      now: 10_000
    })).toMatchObject({
      category: 'upstream',
      retryable: true,
      accountAction: 'cooldown',
      statusCode: 503,
      retryAfterMs: 3_000,
      retryAt: 13_000
    })
  })
})
