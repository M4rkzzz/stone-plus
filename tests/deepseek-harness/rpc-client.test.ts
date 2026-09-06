import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessRpcClient } from '../../src/main/deepseek-harness/rpc-client'

describe('DeepSeekHarnessRpcClient', () => {
  it('synchronizes Stone route models without pre-binding existing blank sessions', async () => {
    const requests: Array<{ method: string; payload: Record<string, unknown> }> = []
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/deepseek-harness/v1/models')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer stone-secret')
        return Response.json({ data: [
          { id: 'gpt-5.6-sol', object: 'model', context_window: 272_000, max_output_tokens: 128_000 },
          { id: 'deepseek-v4-flash', object: 'model', context_window: 1_048_576, max_output_tokens: 384_000 },
          { id: 'gpt-5.6-sol', object: 'model' },
        ] })
      }
      const request = JSON.parse(String(init?.body)) as {
        rpcId: string
        method: string
        payload: Record<string, unknown>
      }
      requests.push({ method: request.method, payload: request.payload })
      if (request.method === 'llm.providers') {
        return Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              providers: [{
                provider: 'deepseek-official',
                settingsNs: 'llm-pi-ai',
                active: true,
              }],
            },
          },
        })
      }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { revision: 1 } },
      })
    }) as typeof fetch
    const client = new DeepSeekHarnessRpcClient({ fetchImplementation })

    await expect(client.configureStoneRoute({
      gatewayBaseUrl: 'http://127.0.0.1:15720',
      token: 'stone-secret',
      preferredModel: 'deepseek-v4-flash',
    })).resolves.toEqual(['gpt-5.6-sol', 'deepseek-v4-flash'])

    expect(requests[0]).toEqual({
      method: 'settings.update',
      payload: {
        ns: 'llm-pi-ai',
        patch: {
          providers: {
            'deepseek-official': {
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              displayName: 'Stone+',
              api: 'openai-responses',
              baseURL: 'http://127.0.0.1:15720/deepseek-harness/v1',
              reasoning: 'high',
              defaultContextWindow: 272_000,
              models: [
                {
                  id: 'gpt-5.6-sol',
                  name: 'gpt-5.6-sol',
                  contextWindow: 272_000,
                  maxTokens: 128_000,
                  input: ['text'],
                  reasoningEfforts: {
                    off: 'none',
                    minimal: 'minimal',
                    low: 'low',
                    medium: 'medium',
                    high: 'high',
                    xhigh: 'xhigh',
                    max: 'max',
                  },
                },
                {
                  id: 'deepseek-v4-flash',
                  name: 'deepseek-v4-flash',
                  contextWindow: 1_048_576,
                  maxTokens: 384_000,
                  input: ['text'],
                  reasoningEfforts: { off: 'none', high: 'high', max: 'max' },
                },
              ],
            },
          },
        },
      },
    })
    expect(requests[1]).toEqual({ method: 'llm.providers', payload: {} })
    expect(requests[2]).toEqual({
      method: 'settings.update',
      payload: {
        ns: 'web-search-deepseek',
        patch: {
          baseURL: 'http://127.0.0.1:15720/deepseek-harness/anthropic/v1',
          model: 'deepseek-v4-flash',
        },
      },
    })
    expect(requests).toHaveLength(3)
    expect(requests.some((request) => request.payload.ns === 'agent-default-model')).toBe(false)
    expect(requests.some((request) => request.method === 'session.selectModel')).toBe(false)
  })

  it('requires both visible list state and non-empty imported history', async () => {
    const fetchImplementation = rpcFetch((method) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'imported', blank: false, updatedAt: 1 }] }
      }
      if (method === 'session.history') {
        return { events: [
          { event: { type: 'turn/start' } },
          { event: { type: 'assistant/message' } },
        ] }
      }
      return {}
    })
    const client = new DeepSeekHarnessRpcClient({ fetchImplementation })

    await expect(client.waitForImportedSession('imported', 100)).resolves.toBeUndefined()
  })

  it('does not replace the DSH catalog with an empty Stone model list', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ data: [] })) as typeof fetch
    const client = new DeepSeekHarnessRpcClient({ fetchImplementation })

    await expect(client.configureStoneRoute({
      gatewayBaseUrl: 'http://127.0.0.1:15720',
      token: 'stone-secret',
    })).rejects.toThrow('exposes no models')
  })

})

function rpcFetch(valueFor: (method: string) => unknown): typeof fetch {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: valueFor(request.method) },
    })
  }) as typeof fetch
}
