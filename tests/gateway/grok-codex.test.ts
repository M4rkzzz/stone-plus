import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Account,
  GatewaySettings,
  Pool,
  ProviderDefinition,
  RequestLog,
  Route
} from '../../src/shared/types'
import { GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000
const runningServers: GatewayServer[] = []

function account(): Account {
  return {
    id: 'grok-account',
    providerId: 'grok-provider',
    name: 'Grok relay',
    credentialId: 'grok-credential',
    maskedCredential: '***',
    credentialType: 'api-key',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['grok-4.20'],
    modelPolicy: 'selected',
    modelAllowlist: ['grok-4.20'],
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

async function freePort(): Promise<number> {
  for (;;) {
    const server = createNodeServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Failed to allocate a test port')
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (address.port >= 11_000) return address.port
  }
}

function config(port: number, protocol: ProviderDefinition['protocol']): GatewayConfig {
  const provider: ProviderDefinition = {
    id: 'grok-provider',
    name: 'Grok relay',
    sourceType: 'relay',
    kind: 'xai-compatible',
    baseUrl: 'https://grok-relay.example.test/v1',
    protocol,
    models: ['grok-4.20'],
    createdAt: timestamp,
    updatedAt: timestamp
  }
  const member = account()
  const pool: Pool = {
    id: provider.id,
    name: 'Grok pool',
    kind: 'standard',
    protocol: 'grok',
    strategy: 'priority',
    members: [{ accountId: member.id, enabled: true }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  const route: Route = {
    id: 'grok-route',
    client: 'codex',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: 'openai-responses',
    modelMap: { '*': 'grok-4.20' },
    localToken: 'local-secret',
    createdAt: timestamp,
    updatedAt: timestamp
  }
  const settings: GatewaySettings = {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 5
  }
  return { providers: [provider], accounts: [member], pools: [pool], routes: [route], settings }
}

async function postResponses(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex-client-model', ...body })
  })
}

function upsertLog(logs: RequestLog[], log: RequestLog): void {
  const index = logs.findIndex((candidate) => candidate.id === log.id)
  if (index >= 0) logs[index] = log
  else logs.unshift(log)
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('Codex Responses over xAI-compatible relays', () => {
  it('adds Grok CLI identity headers for a Grok OAuth credential', async () => {
    const port = await freePort()
    const oauthConfig = config(port, 'openai-responses')
    oauthConfig.providers[0] = { ...oauthConfig.providers[0], sourceType: 'oauth-system', kind: 'xai', baseUrl: 'https://cli-chat-proxy.grok.com/v1' }
    oauthConfig.accounts[0] = { ...oauthConfig.accounts[0], credentialType: 'grok-oauth' }
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://cli-chat-proxy.grok.com/v1/responses')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer oauth-access-token')
      expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
      expect(headers.get('x-grok-client-version')).toBe('0.2.111')
      expect(headers.get('x-grok-client-identifier')).toBe('grok-shell')
      expect(headers.get('x-grok-client-mode')).toBe('interactive')
      expect(headers.get('user-agent')).toBe('grok-shell/0.2.111 (linux; x86_64)')
      return new Response('event: response.completed\ndata: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_oauth","object":"response","model":"grok-4.20","status":"completed","output":[]}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: oauthConfig,
      credentialResolver: () => ({ secret: 'oauth-access-token', kind: 'grok-oauth' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()
    const response = await postResponses(port, { input: 'Hello', stream: true })
    expect(response.status).toBe(200)
    await response.text()
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('refreshes a rejected Grok OAuth access token once and preserves account identity', async () => {
    const port = await freePort()
    const oauthConfig = config(port, 'openai-responses')
    oauthConfig.providers[0] = {
      ...oauthConfig.providers[0],
      sourceType: 'oauth-system',
      kind: 'xai',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    }
    oauthConfig.accounts[0] = { ...oauthConfig.accounts[0], credentialType: 'grok-oauth' }
    const recoverRejectedAccess = vi.fn(async () => ({
      secret: 'rotated-access-token',
      kind: 'grok-oauth' as const,
      accountId: 'grok-subject',
    }))
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer stale-access-token') {
        return new Response(JSON.stringify({ error: { message: 'expired' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      expect(authorization).toBe('Bearer rotated-access-token')
      return new Response('event: response.completed\ndata: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_recovered","object":"response","model":"grok-4.20","status":"completed","output":[]}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: oauthConfig,
      credentialResolver: () => ({
        secret: 'stale-access-token',
        kind: 'grok-oauth',
        accountId: 'grok-subject',
        recoverRejectedAccess,
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, { input: 'Hello', stream: true })
    expect(response.status).toBe(200)
    await response.text()
    expect(recoverRejectedAccess).toHaveBeenCalledOnce()
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('never sends a Grok OAuth bearer to a noncanonical provider', async () => {
    const port = await freePort()
    const unsafeConfig = config(port, 'openai-responses')
    unsafeConfig.accounts[0] = { ...unsafeConfig.accounts[0], credentialType: 'grok-oauth' }
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: unsafeConfig,
      credentialResolver: () => ({ secret: 'oauth-access-token', kind: 'grok-oauth' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()
    const response = await postResponses(port, { input: 'Hello', stream: true })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { type: 'account_unavailable' } })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('fails closed before scheduling a mixed OpenAI and Grok pool', async () => {
    const port = await freePort()
    const mixedConfig = config(port, 'openai-chat')
    mixedConfig.providers.unshift({
      id: 'generic-provider',
      name: 'Generic relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://generic-relay.example.test/v1',
      protocol: 'openai-chat',
      models: ['grok-4.20'],
      createdAt: timestamp,
      updatedAt: timestamp
    })
    mixedConfig.accounts.unshift({
      ...account(),
      id: 'generic-account',
      providerId: 'generic-provider',
      credentialId: 'generic-credential',
      name: 'Generic relay'
    })
    mixedConfig.pools[0].members.unshift({ accountId: 'generic-account', enabled: true })
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://grok-relay.example.test/v1/chat/completions')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const wireName = (body.tools as Array<{ function: { name: string } }>)[0].function.name
      return new Response(JSON.stringify({
        id: 'chatcmpl_mixed_pool',
        model: 'grok-4.20',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mixed',
              type: 'function',
              function: { name: wireName, arguments: '{"input":"mixed patch"}' }
            }]
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: mixedConfig,
      credentialResolver: () => 'relay-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Apply it.',
      tools: [{ type: 'custom', name: 'apply_patch' }],
      stream: false
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { type: 'account_unavailable' } })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('activates the Grok tool bridge for an xAI-compatible relay aggregate', async () => {
    const port = await freePort()
    const aggregate = config(port, 'openai-chat')
    aggregate.pools[0] = {
      ...aggregate.pools[0],
      kind: 'relay-aggregate',
      protocol: 'openai-chat',
    }
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const wireName = (body.tools as Array<{ function: { name: string } }>)[0].function.name
      expect(wireName).not.toBe('apply_patch')
      return new Response(JSON.stringify({
        id: 'aggregate-tool', model: 'grok-4.20',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call_aggregate', type: 'function',
            function: { name: wireName, arguments: '{"input":"aggregate patch"}' },
          }],
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: aggregate,
      credentialResolver: () => 'relay-key',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Apply it.', tools: [{ type: 'custom', name: 'apply_patch' }], stream: false,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      output: [{ type: 'custom_tool_call', call_id: 'call_aggregate', name: 'apply_patch', input: 'aggregate patch' }],
    })
  })

  it('round-trips a custom tool call and its output through Grok Chat', async () => {
    const port = await freePort()
    const upstreamBodies: Array<Record<string, unknown>> = []
    let wireToolName = ''
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamBodies.push(body)
      expect(body.model).toBe('grok-4.20')
      const tools = body.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>
      expect(tools).toHaveLength(1)
      expect(tools[0].function.parameters).toMatchObject({
        type: 'object',
        required: ['input'],
        additionalProperties: false
      })
      wireToolName ||= tools[0].function.name
      expect(tools[0].function.name).toBe(wireToolName)

      if (upstreamBodies.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_grok_custom',
          model: 'grok-4.20',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_patch',
                type: 'function',
                function: {
                  name: wireToolName,
                  arguments: JSON.stringify({ input: '*** Begin Patch\n+hello\n*** End Patch' })
                }
              }]
            }
          }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [expect.objectContaining({
            id: 'call_patch',
            function: expect.objectContaining({ name: wireToolName })
          })]
        }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_patch', content: 'patch applied' })
      ]))
      return new Response(JSON.stringify({
        id: 'chatcmpl_grok_after_tool',
        model: 'grok-4.20',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
        usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-chat'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const tools = [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }]
    const first = await postResponses(port, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it.' }] }],
      tools,
      tool_choice: { type: 'custom', name: 'apply_patch' },
      stream: false
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { output: Array<Record<string, unknown>> }
    const customCall = firstBody.output.find((item) => item.type === 'custom_tool_call')
    expect(customCall).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'call_patch',
      name: 'apply_patch',
      input: '*** Begin Patch\n+hello\n*** End Patch'
    })

    const second = await postResponses(port, {
      input: [
        customCall,
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'patch applied' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }
      ],
      tools,
      stream: false
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }]
    })
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('maps Codex reasoning to Grok Chat without exposing reasoning content', async () => {
    const port = await freePort()
    const privateReasoning = 'private-grok-reasoning-must-not-leak'
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'grok-4.20',
        reasoning_effort: 'low',
        stream: true,
        stream_options: { include_usage: true }
      })
      return new Response([
        `data: {"id":"grok_reasoning","model":"grok-4.20","choices":[{"index":0,"delta":{"reasoning_content":"${privateReasoning}"},"finish_reason":null}]}\n\n`,
        'data: {"id":"grok_reasoning","model":"grok-4.20","choices":[{"index":0,"delta":{"content":"Visible answer."},"finish_reason":null}]}\n\n',
        'data: {"id":"grok_reasoning","model":"grok-4.20","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"grok_reasoning","model":"grok-4.20","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":8,"total_tokens":48,"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-chat'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Think carefully.',
      reasoning: { effort: 'minimal', summary: 'auto' },
      stream: true
    })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('Visible answer.')
    expect(wire).toContain('"reasoning_tokens":5')
    expect(wire).not.toContain(privateReasoning)
    await vi.waitFor(() => expect(logs[0]?.status).toBe('success'))
    expect(logs[0]).toMatchObject({ inputTokens: 40, outputTokens: 8, reasoningTokens: 5 })
  })

  it('restores a streamed Grok Chat alias as a native Codex custom tool call', async () => {
    const port = await freePort()
    let wireToolName = ''
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const tools = body.tools as Array<{ function: { name: string } }>
      wireToolName = tools[0].function.name
      return new Response([
        `data: {"id":"grok_stream_tool","model":"grok-4.20","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_stream","type":"function","function":{"name":"${wireToolName}","arguments":"{\\"input\\":\\"patch"}}]},"finish_reason":null}]}\n\n`,
        'data: {"id":"grok_stream_tool","model":"grok-4.20","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" applied\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"grok_stream_tool","model":"grok-4.20","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-chat'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Apply it.',
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
      stream: true
    })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('custom_tool_call')
    expect(wire).toContain('apply_patch')
    expect(wire).toContain('patch applied')
    expect(wire).not.toContain(wireToolName)
  })

  it('keeps the native xAI Responses stream and terminal usage valid for Codex', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://grok-relay.example.test/v1/responses')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'grok-4.20',
        reasoning: { effort: 'high', summary: 'auto' },
        stream: true,
        store: false
      })
      return new Response([
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_grok_native","model":"grok-4.20","status":"in_progress"}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":1,"delta":"Working"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"output_index":0,"content_index":0,"delta":"Native answer."}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_grok_native","object":"response","model":"grok-4.20","status":"completed","output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Native answer.","annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":6,"total_tokens":16,"output_tokens_details":{"reasoning_tokens":4}}}}\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-responses'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Reply natively.',
      reasoning: { effort: 'high', summary: 'auto' },
      stream: true,
      store: false
    })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('response.reasoning_summary_text.delta')
    expect(wire).toContain('Native answer.')
    expect(wire).toContain('"reasoning_tokens":4')
    expect(wire).toContain('response.completed')
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('fails closed instead of deleting opaque compact history before native Grok Responses', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const serialized = JSON.stringify(body)
      expect(body.model).toBe('grok-4.20')
      expect(serialized).not.toContain('reasoning-history')
      expect(serialized).not.toContain('compaction-history')
      expect(serialized).not.toContain('web_search_preview')
      expect(body).not.toHaveProperty('include')
      expect(body).toMatchObject({
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }],
        store: false,
        reasoning_effort: 'high',
      })
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_grok_normalized","object":"response","model":"grok-4.20","status":"completed","output":[]}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-responses'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: [
        { type: 'reasoning', encrypted_content: 'reasoning-history' },
        { type: 'compaction', encrypted_content: 'compaction-history' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
      ],
      tools: [{ type: 'web_search_preview' }],
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      store: false,
      stream: true,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { type: 'unsupported_conversion' },
      issues: [expect.objectContaining({ path: 'input[1]' })],
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('replays undeclared Codex tool history without sending empty tool controls', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).not.toHaveProperty('tools')
      expect(body).not.toHaveProperty('tool_choice')
      expect(body).not.toHaveProperty('parallel_tool_calls')
      const wireName = String((body.input as Array<Record<string, unknown>>)[0].name)
      expect(wireName).not.toBe('exec')
      expect(body.input).toEqual([
        { type: 'function_call', call_id: 'call_exec', name: wireName, arguments: '{"input":"echo hello"}' },
        { type: 'function_call_output', call_id: 'call_exec', output: 'hello' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ])
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_grok_history","object":"response","model":"grok-4.20","status":"completed","output":[]}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-responses'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: [
        { type: 'custom_tool_call', call_id: 'call_exec', name: 'exec', input: 'echo hello' },
        { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'hello' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('bridges a native Grok Responses function call back to a Codex custom tool', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const tools = body.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ type: 'function' })
      expect(tools[0].name).not.toBe('apply_patch')
      const wireName = String(tools[0].name)
      const argumentsValue = JSON.stringify({ input: 'native patch' })
      return new Response([
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: { id: 'fc_native', type: 'function_call', call_id: 'call_native', name: wireName, arguments: '' } })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', sequence_number: 1, output_index: 0, delta: argumentsValue })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: { id: 'fc_native', type: 'function_call', call_id: 'call_native', name: wireName, arguments: argumentsValue, status: 'completed' } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 3, response: { id: 'resp_native_tool', object: 'response', model: 'grok-4.20', status: 'completed', output: [{ id: 'fc_native', type: 'function_call', call_id: 'call_native', name: wireName, arguments: argumentsValue, status: 'completed' }] } })}\n\n`,
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: config(port, 'openai-responses'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Apply it natively.',
      tools: [{ type: 'custom', name: 'apply_patch' }],
      stream: true
    })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('custom_tool_call')
    expect(wire).toContain('apply_patch')
    expect(wire).toContain('native patch')
    expect(wire).not.toContain('sp_custom_')
  })

  it('fails closed for an xAI Chat HTTP 200 error envelope', async () => {
    const port = await freePort()
    const credential = 'grok-private-key-must-not-leak'
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: `Rate limited for ${credential}`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded'
      }
    }), { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '30' } }))
    const gateway = new GatewayServer({
      config: config(port, 'openai-chat'),
      credentialResolver: () => credential,
      fetchImplementation: upstreamFetch as typeof fetch,
      requestTransientRetryDelayMs: 0
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, { input: 'Reply.', stream: false })
    const wire = await response.text()
    expect(response.status).toBe(429)
    expect(wire).toContain('rate_limit_exceeded')
    expect(wire).not.toContain(credential)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('rejects an invalid custom-tool bridge as a non-retryable client error', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: config(port, 'openai-chat'),
      credentialResolver: () => 'grok-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(port, {
      input: 'Use the tool.',
      tools: [{ type: 'custom', name: 'duplicate' }, { type: 'custom', name: 'duplicate' }],
      stream: false
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_tool_bridge', param: 'tools[].name' }
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
