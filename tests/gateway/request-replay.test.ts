import { describe, expect, it, vi } from 'vitest'
import { RequestReplayStore } from '../../src/main/gateway/request-replay'

describe('RequestReplayStore', () => {
  it('keeps raw payload memory-only while exporting a redacted diagnostic shape', () => {
    const store = new RequestReplayStore({ now: () => 100, ttlMs: 10_000 })
    expect(store.capture({
      id: 'request-1',
      path: '/v1/responses',
      routeId: 'route-codex',
      body: {
        model: 'gpt-5.6-sol',
        input: [{ role: 'user', content: 'private prompt' }],
        access_token: 'secret'
      },
      headers: { authorization: 'Bearer leaked', 'openai-beta': 'responses=experimental' }
    })).toBe(true)
    expect(store.get('request-1')).toMatchObject({
      body: {
        model: 'gpt-5.6-sol',
        input: [{ role: 'user', content: '[CONTENT REDACTED]' }],
        access_token: '[REDACTED]'
      },
      headers: { 'openai-beta': 'responses=experimental' },
      contentRedacted: true
    })
  })

  it('replays only through a loopback Stone+ endpoint', async () => {
    const store = new RequestReplayStore({ now: () => 100, ttlMs: 10_000 })
    store.capture({ id: 'request-2', path: '/v1/responses', routeId: 'route-codex', body: { model: 'gpt-5', input: 'hello' } })
    const payload = '{"id":"resp_1","status":"completed","output":[]}'
    const fetchImplementation = vi.fn(async () => new Response(payload, { status: 200 })) as unknown as typeof fetch
    await expect(store.replay({
      id: 'request-2',
      baseUrl: 'http://127.0.0.1:15721',
      localToken: 'local-secret',
      fetchImplementation
    })).resolves.toMatchObject({ ok: true, status: 200, responsePreview: payload })
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:15721/v1/responses'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer local-secret' }) })
    )
    await expect(store.replay({
      id: 'request-2', baseUrl: 'https://example.com', localToken: 'x', fetchImplementation
    })).rejects.toThrow(/local Stone/)
  })

  it('consumes a streaming replay through its terminal event while bounding only the preview', async () => {
    const store = new RequestReplayStore({ now: () => 100, ttlMs: 10_000 })
    store.capture({
      id: 'request-stream', path: '/v1/responses', routeId: 'route-codex',
      body: { model: 'gpt-5', input: 'hello', stream: true }
    })
    let cancelled = false
    const largeDelta = 'x'.repeat(20 * 1024)
    const wire = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: largeDelta })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`
    ].join('')
    const fetchImplementation = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire))
        controller.close()
      },
      cancel() { cancelled = true }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch

    const result = await store.replay({
      id: 'request-stream', baseUrl: 'http://127.0.0.1:15721',
      localToken: 'local-secret', fetchImplementation
    })
    expect(result.ok).toBe(true)
    expect(Buffer.byteLength(result.responsePreview)).toBeLessThanOrEqual(16 * 1024)
    expect(cancelled).toBe(false)
  })

  it.each([
    ['/v1/responses', { model: 'gpt-5', input: 'hello' }, { id: 'resp', status: 'completed', output: [] }],
    ['/v1/chat/completions', { model: 'gpt-5', messages: [] }, { id: 'chat', choices: [] }],
    ['/v1/messages', { model: 'claude', messages: [], max_tokens: 8 }, { id: 'msg', content: [], stop_reason: 'end_turn' }],
    ['/v1beta/models/gemini:generateContent', { contents: [] }, { candidates: [] }],
  ])('validates a non-streaming %s response without retaining it beyond the preview', async (path, body, payload) => {
    const store = new RequestReplayStore({ now: () => 100, ttlMs: 10_000 })
    store.capture({ id: 'request-json', path, routeId: 'route', body })
    const padding = 'x'.repeat(20 * 1024)
    const wire = JSON.stringify({ ...payload, diagnosticPadding: padding })
    const result = await store.replay({
      id: 'request-json', baseUrl: 'http://127.0.0.1:15721', localToken: 'token',
      fetchImplementation: vi.fn(async () => new Response(wire, {
        status: 200, headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
    })
    expect(result.ok).toBe(true)
    expect(Buffer.byteLength(result.responsePreview)).toBe(16 * 1024)
  })

  it.each([
    ['an empty body', null],
    ['HTML', '<html>upstream error</html>'],
    ['truncated JSON', '{"status":"completed"'],
    ['a wrong protocol shape', '{"ok":true}'],
  ])('does not report a 2xx %s as a successful non-streaming replay', async (_label, responseBody) => {
    const store = new RequestReplayStore({ now: () => 100, ttlMs: 10_000 })
    store.capture({ id: 'request-invalid', path: '/v1/responses', routeId: 'route', body: { model: 'gpt-5', input: 'hello' } })
    const result = await store.replay({
      id: 'request-invalid', baseUrl: 'http://127.0.0.1:15721', localToken: 'token',
      fetchImplementation: vi.fn(async () => new Response(responseBody, { status: 200 })) as unknown as typeof fetch
    })
    expect(result.ok).toBe(false)
  })
})
