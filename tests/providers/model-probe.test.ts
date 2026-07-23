import { describe, expect, it, vi } from 'vitest'
import {
  anthropicAdapter,
  googleAdapter,
  openAIAdapter,
  openAICompatibleAdapter,
  probeChatGptCodexModel,
  probeProviderModel
} from '../../src/main/providers'

describe('provider model probes', () => {
  it.each([
    {
      name: 'OpenAI Responses',
      adapter: openAIAdapter,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
      endpoint: 'https://api.openai.com/v1/responses',
      payload: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
    },
    {
      name: 'OpenAI Chat',
      adapter: openAICompatibleAdapter,
      protocol: 'openai-chat' as const,
      baseUrl: 'https://chat.example/v1',
      endpoint: 'https://chat.example/v1/chat/completions',
      payload: { choices: [{ message: { role: 'assistant', content: 'OK' } }] }
    },
    {
      name: 'Anthropic Messages',
      adapter: anthropicAdapter,
      protocol: 'anthropic-messages' as const,
      baseUrl: 'https://api.anthropic.com',
      endpoint: 'https://api.anthropic.com/v1/messages',
      payload: { content: [{ type: 'text', text: 'OK' }] }
    },
    {
      name: 'Gemini',
      adapter: googleAdapter,
      protocol: 'gemini' as const,
      baseUrl: 'https://generativelanguage.googleapis.com',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
      payload: { candidates: [{ content: { parts: [{ thought: true, text: 'hidden reasoning' }, { text: 'OK' }] } }] }
    }
  ])('sends a minimal non-streaming $name request and extracts only answer text', async ({
    adapter, protocol, baseUrl, endpoint, payload
  }) => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    const result = await probeProviderModel({
      adapter,
      baseUrl,
      protocol,
      credential: 'credential-private',
      model: 'test-model',
      fetchImplementation
    })

    expect(result).toMatchObject({ ok: true, model: 'test-model', statusCode: 200, responsePreview: 'OK' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(result)).not.toContain('credential-private')
    expect(JSON.stringify(result)).not.toContain('hidden reasoning')
    const [url, init] = fetchImplementation.mock.calls[0]
    expect(String(url)).toBe(endpoint)
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (protocol !== 'gemini') expect(body).toMatchObject({ model: 'test-model' })
    expect(body).not.toMatchObject({ stream: true })
    if (protocol === 'openai-responses') expect(body).toMatchObject({ max_output_tokens: 64 })
    if (protocol === 'openai-chat') expect(body).toMatchObject({ max_tokens: 16 })
    if (protocol === 'anthropic-messages') expect(body).toMatchObject({ max_tokens: 16 })
    if (protocol === 'gemini') expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 64 } })
  })

  it('throws the classified safe error without reading an upstream credential echo', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Bearer credential-private was denied' }
    }), { status: 403 }))

    const error = await probeProviderModel({
      adapter: openAIAdapter,
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      credential: 'credential-private',
      model: 'test-model',
      fetchImplementation
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Provider denied access for this account.')
    expect(JSON.stringify(error)).not.toContain('credential-private')
  })

  it('rejects reasoning-only responses instead of exposing chain of thought', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private chain of thought' }] }]
    }), { status: 200 }))

    const error = await probeProviderModel({
      adapter: openAIAdapter,
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      credential: 'credential-private',
      model: 'test-model',
      fetchImplementation
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Provider model test returned no usable reply.')
    expect(JSON.stringify(error)).not.toContain('private chain of thought')
  })

  it('redacts known and key-shaped secrets from the bounded preview', async () => {
    const credential = 'sk-privatecredential123'
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: `OK ${credential} Bearer another.private.token ${'x'.repeat(300)}` } }]
    }), { status: 200 }))

    const result = await probeProviderModel({
      adapter: openAICompatibleAdapter,
      baseUrl: 'https://chat.example/v1',
      protocol: 'openai-chat',
      credential,
      model: 'test-model',
      fetchImplementation
    })

    expect(result.responsePreview).toContain('[redacted]')
    expect(result.responsePreview).not.toContain(credential)
    expect(result.responsePreview).not.toContain('another.private.token')
    expect(result.responsePreview!.length).toBeLessThanOrEqual(160)
  })

  it('collects a completed Codex SSE response and ignores reasoning events', async () => {
    const fetchImplementation = vi.fn(async () => new Response([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"private chain"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"O"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"K"}\n\n',
      'data: {"type":"response.output_text.done","text":"OK"}\n\n',
      'data: {"type":"response.failed","error":{"message":"must not be consumed"}}\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }))

    const result = await probeChatGptCodexModel({
      bundle: {
        accessToken: 'oauth-access-private',
        refreshToken: 'oauth-refresh-private',
        accountId: 'account-private',
        expiresAt: Date.now() + 60_000
      },
      model: 'gpt-test',
      fetchImplementation
    })

    expect(result).toMatchObject({ ok: true, model: 'gpt-test', statusCode: 200, responsePreview: 'OK' })
    expect(JSON.stringify(result)).not.toContain('private chain')
    expect(JSON.stringify(result)).not.toContain('oauth-access-private')
    const [, init] = fetchImplementation.mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access-private')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-test', stream: true, store: false })
    expect(body).not.toHaveProperty('max_output_tokens')
  })
})
