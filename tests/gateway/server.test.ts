import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, GatewaySettings, Pool, ProviderDefinition, RequestLog, Route } from '../../src/shared/types'
import { createCanonicalStreamParser, GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000
const runningServers: GatewayServer[] = []

function account(id: string, priority: number): Account {
  return {
    id,
    providerId: 'provider',
    name: id,
    credentialId: id,
    maskedCredential: '***',
    status: 'active',
    priority,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
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
    // Fetch blocks a fixed list of legacy service ports; all of them are below 11,000.
    if (address.port >= 11_000) return address.port
  }
}

function config(port: number, overrides: Partial<GatewaySettings> = {}): GatewayConfig {
  const provider: ProviderDefinition = {
    id: 'provider',
    name: 'Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    protocol: 'openai-chat',
    models: ['source-model'],
    createdAt: timestamp,
    updatedAt: timestamp
  }
  const accounts = [account('first', 1), account('second', 10)]
  const pool: Pool = {
    id: 'pool',
    name: 'Pool',
    protocol: 'openai-chat',
    strategy: 'priority',
    members: accounts.map((item) => ({ accountId: item.id, enabled: true })),
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  const route: Route = {
    id: 'route',
    client: 'codex',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: 'openai-chat',
    modelMap: {},
    localToken: 'local-secret',
    createdAt: timestamp,
    updatedAt: timestamp
  }
  return {
    providers: [provider],
    accounts,
    pools: [pool],
    routes: [route],
    settings: {
      host: '127.0.0.1',
      port,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 5,
      ...overrides
    }
  }
}

async function post(port: number, token = 'local-secret', body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'source-model', messages: [{ role: 'user', content: 'Hello' }], ...body })
  })
}

async function getModels(port: number, path = '/v1/models', token = 'local-secret'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  })
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('GatewayServer', () => {
  it('reports live per-account concurrency while an upstream request is running', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    let markUpstreamStarted!: () => void
    let releaseUpstream!: (response: Response) => void
    const upstreamStarted = new Promise<void>((resolve) => { markUpstreamStarted = resolve })
    const upstreamResponse = new Promise<Response>((resolve) => { releaseUpstream = resolve })
    const upstreamFetch = vi.fn(async () => {
      markUpstreamStarted()
      return upstreamResponse
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    const runtimeStates: Array<{ activeRequests: number; first: number }> = []
    gateway.onRuntimeState(() => runtimeStates.push({
      activeRequests: gateway.getStatus().activeRequests,
      first: gateway.getAccountInFlight().first
    }))
    runningServers.push(gateway)
    await gateway.start()

    const pendingResponse = post(port)
    await upstreamStarted
    expect(gateway.getStatus().activeRequests).toBe(1)
    expect(gateway.getAccountInFlight()).toMatchObject({ first: 1, second: 0 })

    releaseUpstream(new Response(JSON.stringify({
      id: 'response-live-concurrency',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const response = await pendingResponse
    expect(response.status).toBe(200)
    await response.text()
    await vi.waitFor(() => {
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(gateway.getAccountInFlight().first).toBe(0)
    })
    expect(runtimeStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ activeRequests: 1, first: 1 }),
      expect.objectContaining({ activeRequests: 0, first: 0 })
    ]))
  })

  it('requires the matching local route token before calling upstream', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async () => new Response('{}'))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'wrong-token')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { type: 'authentication_error' } })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('normalizes a versioned base URL, retries another account, and releases slots', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      }))
      .mockImplementation(async () => new Response(JSON.stringify({
          id: 'completion',
          model: 'source-model',
          choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: (selected) => `key-${selected.id}`,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const firstResponse = await post(port)
    expect(firstResponse.status).toBe(200)
    expect((await firstResponse.json() as { choices: unknown[] }).choices).toHaveLength(1)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions')
    expect(new Headers(upstreamFetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer key-first')
    expect(new Headers(upstreamFetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer key-second')

    const secondResponse = await post(port)
    expect(secondResponse.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(3)
    expect(new Headers(upstreamFetch.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer key-second')
    expect(gateway.getStatus()).toMatchObject({ activeRequests: 0, totalRequests: 2, successRequests: 2 })
  })

  it('routes ChatGPT OAuth accounts through the Codex backend with account headers', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].forceFastMode = true
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      credentialType: 'chatgpt-oauth',
      chatgptAccountId: 'acct-team',
      credentialExpiresAt: timestamp + 3_600_000
    }
    gatewayConfig.accounts[1].status = 'disabled'
    const stream = [
      'data: {"type":"response.created","response":{"id":"resp_oauth","model":"gpt-5.1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_oauth","model":"gpt-5.1","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n'
    ].join('')
    const upstreamFetch = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-private', kind: 'chatgpt-oauth', accountId: 'acct-team' }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', input: 'Hello', stream: true, service_tier: 'default' })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('response.completed')
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    const request = upstreamFetch.mock.calls[0][1]!
    const headers = new Headers(request.headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-private')
    expect(headers.get('chatgpt-account-id')).toBe('acct-team')
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(JSON.parse(String(request.body))).toMatchObject({ store: false, stream: true, service_tier: 'priority' })
  })

  it('keeps Responses Lite and Search operations on one OAuth account and returns Search JSON directly', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].strategy = 'round-robin'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts = gatewayConfig.accounts.map((item) => ({
      ...item,
      credentialType: 'chatgpt-oauth',
      chatgptAccountId: `acct-${item.id}`
    }))
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/responses')) {
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp_lite","object":"response","model":"source-model","status":"completed","output":[]}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      }
      const requestBody = JSON.parse(String(init?.body)) as { action: string; id: string }
      return new Response(JSON.stringify({
        id: requestBody.id,
        action: requestBody.action,
        data: [{ title: `${requestBody.action} result`, url: 'https://example.test/result' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => ({
        secret: `oauth-${selected.id}-private`,
        kind: 'chatgpt-oauth',
        accountId: `acct-${selected.id}`
      }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const commonHeaders = {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
      'session-id': 'session-web-run',
      'thread-id': 'thread-web-run',
      'x-client-request-id': 'request-web-run',
      'x-codex-beta-features': 'responses_lite',
      'x-codex-installation-id': 'install-web-run',
      'x-codex-parent-thread-id': 'parent-web-run',
      'x-codex-window-id': 'window-web-run',
      'x-openai-internal-codex-responses-lite': 'true',
      'x-openai-subagent': 'false',
      version: '0.145.2'
    }
    const liteInput = [{ type: 'additional_tools', role: 'developer', tools: [] }]
    const liteResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        model: 'source-model',
        input: liteInput,
        instructions: 'omit this top-level field',
        tools: [{ type: 'web_search' }],
        stream: true
      })
    })
    expect(liteResponse.status).toBe(200)
    await liteResponse.text()

    for (const action of ['search', 'open', 'find']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({ model: 'source-model', id: 'session-web-run', action, query: `${action} query` })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        id: 'session-web-run',
        action,
        data: [{ title: `${action} result`, url: 'https://example.test/result' }]
      })
    }

    expect(upstreamFetch).toHaveBeenCalledTimes(4)
    expect(upstreamFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/alpha/search',
      'https://chatgpt.com/backend-api/codex/alpha/search',
      'https://chatgpt.com/backend-api/codex/alpha/search'
    ])
    for (const call of upstreamFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer oauth-first-private')
    }
    const liteRequest = upstreamFetch.mock.calls[0][1]!
    const liteHeaders = new Headers(liteRequest.headers)
    expect(Object.fromEntries(liteHeaders)).toMatchObject({
      'session-id': 'session-web-run',
      'thread-id': 'thread-web-run',
      'x-client-request-id': 'request-web-run',
      'x-codex-beta-features': 'responses_lite',
      'x-codex-installation-id': 'install-web-run',
      'x-codex-parent-thread-id': 'parent-web-run',
      'x-codex-window-id': 'window-web-run',
      'x-openai-internal-codex-responses-lite': 'true',
      'x-openai-subagent': 'false',
      version: '0.145.2'
    })
    expect(JSON.parse(String(liteRequest.body))).toEqual({
      model: 'source-model',
      input: liteInput,
      stream: true,
      store: false
    })
    const searchRequest = upstreamFetch.mock.calls[1][1]!
    const searchHeaders = new Headers(searchRequest.headers)
    expect(searchHeaders.get('accept')).toBe('application/json')
    expect(searchHeaders.get('content-type')).toBe('application/json')
    expect(searchHeaders.has('openai-beta')).toBe(false)
    expect(JSON.parse(String(searchRequest.body))).toEqual({
      model: 'source-model',
      id: 'session-web-run',
      action: 'search',
      query: 'search query'
    })
  })

  it('forwards standalone Search to the API-key provider endpoint', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'search-api-key',
      data: [{ title: 'API key search result' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'provider-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', id: 'search-api-key', action: 'search', query: 'Stone' })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'search-api-key', data: [{ title: 'API key search result' }] })
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://api.example.test/v1/alpha/search')
    expect(new Headers(upstreamFetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer provider-key')
  })

  it('uses one pool-scoped transport for OAuth refresh resolution and generation', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].proxyId = 'pool-proxy'
    gatewayConfig.accounts[0] = { ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth' }
    gatewayConfig.accounts[1].status = 'disabled'
    const stream = 'data: {"type":"response.completed","response":{"id":"resp_scoped","object":"response","model":"gpt-5.4","status":"completed","output":[]}}\n\n'
    const scopedFetch = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const directFetch = vi.fn(async () => { throw new Error('direct fetch must not run') })
    const credentialResolver = vi.fn((_account, fetchImplementation) => {
      expect(fetchImplementation).toBe(scopedFetch)
      return { secret: 'oauth-private', kind: 'chatgpt-oauth' as const, accountId: 'acct-team' }
    })
    const outboundFetchResolver = vi.fn((_account, pool) => {
      expect(pool.proxyId).toBe('pool-proxy')
      return scopedFetch as typeof fetch
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: directFetch as typeof fetch,
      outboundFetchResolver
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'Hello', stream: true })
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(outboundFetchResolver).toHaveBeenCalledTimes(1)
    expect(credentialResolver).toHaveBeenCalledTimes(1)
    expect(scopedFetch).toHaveBeenCalledTimes(1)
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('collects forced OAuth SSE for a non-streaming Responses client', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = { ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth' }
    gatewayConfig.accounts[1].status = 'disabled'
    const stream = [
      'data: {"type":"response.created","response":{"id":"resp_oauth_json","model":"gpt-5.4"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Collected"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_oauth_json","object":"response","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
    ].join('')
    const upstreamFetch = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-private', kind: 'chatgpt-oauth', accountId: 'acct-team' }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'Hello', stream: false })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({
      id: 'resp_oauth_json', object: 'response', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Collected' }] }]
    })
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body))).toMatchObject({ stream: true, store: false })
  })

  it('disables a rejected OAuth session and fails over to the next pool account', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts = gatewayConfig.accounts.map((candidate) => ({ ...candidate, credentialType: 'chatgpt-oauth' }))
    const states: Array<{ accountId: string; status: string; lastError?: string }> = []
    const successStream = [
      'data: {"type":"response.created","response":{"id":"resp_failover","model":"gpt-5.4"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Recovered"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_failover","object":"response","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
    ].join('')
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid API key wording must not escape' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(successStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (candidate) => ({ secret: `oauth-${candidate.id}`, kind: 'chatgpt-oauth', accountId: `acct-${candidate.id}` }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'Hello' })
    })
    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'disabled', lastError: 'ChatGPT session access token was rejected.' })
  })

  it('redacts OAuth access and account identifiers across stream chunks', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = { ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth' }
    gatewayConfig.accounts[1].status = 'disabled'
    const accessToken = 'oauth-stream-private'
    const accountId = 'acct-stream-private'
    const wire = [
      'data: {"type":"response.created","response":{"id":"resp_private","model":"gpt-5.4"}}\n\n',
      `data: {"type":"response.output_text.delta","delta":"${accessToken} ${accountId}"}\n\n`,
      'data: {"type":"response.completed","response":{"id":"resp_private","object":"response","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
    ].join('')
    const encoded = new TextEncoder().encode(wire)
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 5) controller.enqueue(encoded.slice(offset, offset + 5))
        controller.close()
      }
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: accessToken, kind: 'chatgpt-oauth', accountId }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'Hello', stream: true })
    })
    const responseText = await response.text()
    expect(response.status).toBe(200)
    expect(responseText).not.toContain(accessToken)
    expect(responseText).not.toContain(accountId)
    expect(responseText.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  it('converts collected OAuth SSE to a non-streaming Anthropic response', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = { ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth' }
    gatewayConfig.accounts[1].status = 'disabled'
    const stream = [
      'data: {"type":"response.created","response":{"id":"resp_to_anthropic","model":"gpt-5.4"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Converted"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_to_anthropic","object":"response","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}}\n\n'
    ].join('')
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-private', kind: 'chatgpt-oauth', accountId: 'acct-team' }),
      fetchImplementation: vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Converted' }],
      usage: { input_tokens: 4, output_tokens: 1 }
    })
  })

  it('reports live rate limits and detailed usage after failover', async () => {
    const port = await freePort()
    const states: Parameters<NonNullable<ConstructorParameters<typeof GatewayServer>[0]['onAccountState']>>[0][] = []
    const logs: Parameters<NonNullable<ConstructorParameters<typeof GatewayServer>[0]['onLog']>>[0][] = []
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'temporary outage' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 3 }
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '42',
          'x-ratelimit-reset-requests': '60s'
        }
      }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    expect(states).toContainEqual(expect.objectContaining({
      accountId: 'second',
      quota: expect.objectContaining({
        observedAt: timestamp,
        requests: { limit: 100, remaining: 42, resetAt: timestamp + 60_000 }
      })
    }))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      status: 'success',
      failoverCount: 1,
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 5,
      reasoningTokens: 3
    })
  })

  it('uses the actual exhausted quota reset when it is later than Retry-After', async () => {
    const port = await freePort()
    const states: Array<{ accountId: string; status: string; cooldownUntil?: number; consecutiveFailures: number }> = []
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'limited' } }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '120',
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '10080',
          'x-codex-primary-reset-after-seconds': '604800',
          'x-codex-secondary-used-percent': '96',
          'x-codex-secondary-window-minutes': '300',
          'x-codex-secondary-reset-after-seconds': '18000'
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    expect(states[0]).toMatchObject({
      accountId: 'first',
      status: 'cooldown',
      cooldownUntil: timestamp + 604_800_000,
      cooldownReason: 'quota',
      consecutiveFailures: 1,
      codexQuota: {
        fiveHour: expect.objectContaining({ usedPercent: 96 }),
        sevenDay: expect.objectContaining({ usedPercent: 100 }),
        source: 'response-headers'
      }
    })
    expect(states.at(-1)).toMatchObject({
      accountId: 'second',
      status: 'active',
      consecutiveFailures: 0
    })
  })

  it('fails over and disables an account when the provider reports exhausted quota', async () => {
    const port = await freePort()
    const states: Array<{ accountId: string; status: string }> = []
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'payment required' } }), {
        status: 402,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'disabled' })
  })

  it('redacts the upstream credential from errors, account state, and request logs', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    const credential = 'sk-upstream-private'
    const states: string[] = []
    const logs: string[] = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: `Provider echoed ${credential}`,
        authorization: `Bearer ${credential}`
      },
      api_key: credential
    }), { status: 429, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => credential,
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(JSON.stringify(state)),
      onLog: (log) => logs.push(JSON.stringify(log))
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    const responseText = await response.text()
    expect(response.status).toBe(429)
    expect(responseText).not.toContain(credential)
    expect(responseText).toContain('[REDACTED]')
    expect(states.join('')).not.toContain(credential)
    expect(logs.join('')).not.toContain(credential)
  })

  it('records one account failure when the retry round has no eligible account', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    const states: Array<{ accountId: string; consecutiveFailures: number }> = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(429)
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', consecutiveFailures: 1 })
  })

  it('passes through a same-protocol streaming response without buffering it as JSON', async () => {
    const port = await freePort()
    const upstreamFetch = vi.fn(async () => new Response('data: {"delta":"one"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
    }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toBe('data: {"delta":"one"}\n\ndata: [DONE]\n\n')
    expect(gateway.getStatus()).toMatchObject({ activeRequests: 0, successRequests: 1 })
  })

  it('forwards the first safe stream chunk without waiting for a later chunk', async () => {
    const port = await freePort()
    const encoder = new TextEncoder()
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve })
    let pullCount = 0
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"first"}\n\n'))
      },
      async pull(controller) {
        pullCount += 1
        if (pullCount > 1) return
        await tailGate
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential-with-a-long-value-that-must-not-delay-unrelated-safe-output',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', stream: true, messages: [{ role: 'user', content: 'Hello' }] })
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await Promise.race([
      reader!.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('first chunk was buffered')), 250))
    ])
    expect(new TextDecoder().decode(first.value)).toContain('"first"')

    releaseTail()
    const remaining = await reader!.read()
    expect(new TextDecoder().decode(remaining.value)).toContain('[DONE]')
    await reader!.read()
  })

  it('fails over before committing response headers when a 200 stream has no body', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].firstBodyTimeoutMs = 1_000
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined)
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(encoder.encode([
        'data: {"id":"chat-failover","model":"source-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n')), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (account) => `key-${account.id}`,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Recovered')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('ignores empty upstream chunks while waiting for the first response body', async () => {
    const port = await freePort()
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(encoder.encode(
          'data: {"id":"chat-empty-first","model":"source-model","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        ))
        controller.close()
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(await response.text()).toContain('Ready')
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('gracefully drains an active stream when the gateway is restarted', async () => {
    const port = await freePort()
    const encoder = new TextEncoder()
    let releaseTail!: () => void
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"chat-drain","model":"source-model","choices":[{"index":0,"delta":{"content":"Beginning"},"finish_reason":null}]}\n\n'
        ))
        releaseTail = () => {
          controller.enqueue(encoder.encode(
            'data: {"id":"chat-drain","model":"source-model","choices":[{"index":0,"delta":{"content":" finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          ))
          controller.close()
        }
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: config(port), credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch, onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('Beginning')
    const stopping = gateway.stop({ drainTimeoutMs: 2_000 })
    releaseTail()
    let body = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += new TextDecoder().decode(chunk.value)
    }
    await stopping

    expect(body).toContain('finished')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
  })

  it('fails over before committing a converted stream when its first body times out', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    gatewayConfig.pools[0].firstBodyTimeoutMs = 1_000
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined)
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response([
        'data: {"id":"chat-converted-failover","model":"source-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => `key-${selected.id}`,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Recovered')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('optionally hedges slow response headers through another hot transport lane', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    const stream = 'data: {"id":"chat-hedged","model":"source-model","choices":[{"index":0,"delta":{"content":"Fast"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800))
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Fast')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('logs only 499 without cooldown or failover when the client disconnects', async () => {
    const port = await freePort()
    const states: Array<{ accountId: string; status: string }> = []
    const logs: RequestLog[] = []
    const selectedAccountIds: string[] = []
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion-after-abort',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const controller = new AbortController()
    const disconnectedRequest = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', messages: [{ role: 'user', content: 'Hello' }] }),
      signal: controller.signal
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    controller.abort()
    await disconnectedRequest
    await vi.waitFor(() => expect(logs).toHaveLength(1))

    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).toHaveLength(0)
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 499,
      error: 'Client closed the request',
      failoverCount: 0,
      accountId: 'first'
    })

    const nextResponse = await post(port)
    expect(nextResponse.status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'first'])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('records success when the client closes after receiving the terminal stream event', async () => {
    const port = await freePort()
    const logs: RequestLog[] = []
    const states: Array<{ accountId: string; status: string }> = []
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"id":"chat-finished","model":"source-model","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
          ''
        ].join('\n')))
        setTimeout(() => {
          try { controller.close() } catch { /* The downstream cancellation already closed it. */ }
        }, 50)
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', stream: true, messages: [{ role: 'user', content: 'Hello' }] })
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('[DONE]')
    await reader!.cancel()

    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'active' })
  })

  it('records success when Codex closes after receiving complete custom-tool input', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const logs: RequestLog[] = []
    const states: Array<{ accountId: string; status: string }> = []
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_tool","model":"source-model","status":"in_progress","output":[]}}',
          '',
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","response_id":"resp_tool","output_index":0,"item":{"id":"ctc_tool","type":"custom_tool_call","call_id":"call_tool","name":"exec","input":""}}',
          '',
          'event: response.custom_tool_call_input.delta',
          'data: {"type":"response.custom_tool_call_input.delta","response_id":"resp_tool","item_id":"ctc_tool","output_index":0,"delta":"Get-ChildItem"}',
          '',
          'event: response.custom_tool_call_input.done',
          'data: {"type":"response.custom_tool_call_input.done","response_id":"resp_tool","item_id":"ctc_tool","output_index":0,"input":"Get-ChildItem"}',
          '',
          ''
        ].join('\n')))
        setTimeout(() => {
          try { controller.close() } catch { /* The downstream cancellation already closed it. */ }
        }, 50)
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Use the tool', stream: true })
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('response.custom_tool_call_input.done')
    await reader!.cancel()

    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'active' })
  })

  it('records success when Codex closes after receiving a completed assistant message item', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const logs: RequestLog[] = []
    const states: Array<{ accountId: string; status: string }> = []
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_message","model":"source-model","status":"in_progress","output":[]}}',
          '',
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","response_id":"resp_message","output_index":0,"item":{"id":"msg_done","type":"message","role":"assistant","status":"in_progress","content":[]}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","response_id":"resp_message","item_id":"msg_done","output_index":0,"content_index":0,"delta":"Completed"}',
          '',
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","response_id":"resp_message","output_index":0,"item":{"id":"msg_done","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Completed"}]}}',
          '',
          ''
        ].join('\n')))
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          try { controller.error(signal.reason) } catch { /* The downstream cancellation already closed it. */ }
        }, { once: true })
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('response.output_item.done')
    await reader!.cancel()

    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'active' })
  })

  it('records request phases without changing legacy cumulative timings', async () => {
    const port = await freePort()
    let clock = timestamp
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: async () => {
        clock += 20
        return 'credential'
      },
      fetchImplementation: vi.fn(async () => {
        clock += 100
        return new Response(JSON.stringify({
          id: 'phase-timing',
          model: 'source-model',
          choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      onLog: (log) => logs.push(log),
      now: () => clock
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      bodyReadMs: 0,
      schedulerSelectMs: 0,
      credentialResolveMs: 20,
      outboundFetchStartMs: 20,
      upstreamHeadersMs: 120
    })
    expect(logs[0].upstreamHeadersMs! - logs[0].outboundFetchStartMs!).toBe(100)
  })

  it('records time to first token and the client-provided conversation identity', async () => {
    const port = await freePort()
    let clock = timestamp
    let step = 0
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"id":"chat-ttft","model":"source-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-ttft","model":"source-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
    ]
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step >= chunks.length) {
          controller.close()
          return
        }
        if (step === 0) {
          clock = timestamp + 40
          controller.enqueue(encoder.encode(chunks[step]))
          step += 1
          return
        }
        step += 1
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            clock = timestamp + 125
            controller.enqueue(encoder.encode(chunks[1]))
            resolve()
          }, 5)
        })
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log),
      conversationTitleResolver: (conversationId) => conversationId === 'thread-stone-feature' ? 'Stone 请求日志功能' : undefined,
      now: () => clock
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'thread-id': 'thread-stone-feature'
      },
      body: JSON.stringify({
        model: 'source-model',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(200)
    await response.text()

    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      status: 'success',
      conversationId: 'thread-stone-feature',
      conversationName: 'Stone 请求日志功能',
      upstreamFirstByteMs: 40,
      firstTokenMs: 125,
      accountFirstTokenMs: 125
    })
  })

  it('releases account capacity before asynchronous conversation title lookup finishes', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    let releaseTitles!: () => void
    const titleGate = new Promise<void>((resolve) => { releaseTitles = resolve })
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chat-capacity',
      model: 'source-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      conversationTitleResolver: async () => {
        await titleGate
        return 'Resolved later'
      }
    })
    runningServers.push(gateway)
    await gateway.start()

    const first = await post(port, 'local-secret', { metadata: { session_id: 'first-title' } })
    const second = await post(port, 'local-secret', { metadata: { session_id: 'second-title' } })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    releaseTitles()
    await Promise.all([first.text(), second.text()])
  })

  it('preserves a same-protocol stream error while marking the account request as failed', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    const states: Array<{ accountId: string; status: string }> = []
    const logs: Array<{ status: string; error?: string }> = []
    const credential = 'sk-stream-private'
    const body = `data: {"error":{"message":"overloaded ${credential}","type":"server_error"}}\n\n`
    const splitAt = body.indexOf(credential) + 7
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, splitAt)))
        controller.enqueue(encoder.encode(body.slice(splitAt)))
        controller.close()
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => credential,
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    const responseText = await response.text()
    expect(responseText).not.toContain(credential)
    expect(responseText).toContain('overloaded [REDACTED]')
    expect(gateway.getStatus().successRequests).toBe(0)
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'cooldown' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'error', error: 'overloaded [REDACTED]' })
  })

  it('marks a cross-protocol stream without a terminal event as failed', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    gatewayConfig.accounts[1].status = 'disabled'
    const states: Array<{ accountId: string; status: string }> = []
    const upstreamFetch = vi.fn(async () => new Response(
      'data: {"id":"chat-cut","model":"source-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const events = createCanonicalStreamParser('anthropic-messages')
    const parsed = [
      ...events.push(new Uint8Array(await response.arrayBuffer())),
      ...events.finish()
    ]
    expect(response.status).toBe(200)
    expect(parsed).toContainEqual(expect.objectContaining({ type: 'error', errorType: 'incomplete_stream' }))
    expect(gateway.getStatus().successRequests).toBe(0)
    expect(states).toHaveLength(1)
  })

  it('can reset hydrated runtime health after a successful manual account check', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 2,
      cooldownUntil: timestamp + 60_000
    }
    gatewayConfig.accounts[1].status = 'disabled'
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(503)
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      status: 'active',
      circuitState: 'closed',
      consecutiveFailures: 0,
      cooldownUntil: undefined
    }
    gateway.resetAccountHealth('first')
    gateway.updateConfig(gatewayConfig)
    expect((await post(port)).status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('checks account allowlists against the mapped upstream model', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].modelMap = { alias: 'upstream-model' }
    gatewayConfig.accounts[0].modelAllowlist = ['upstream-model']
    gatewayConfig.accounts[1].status = 'disabled'
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'upstream-model' })
      return new Response(JSON.stringify({
        id: 'completion',
        model: 'upstream-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { model: 'alias' })
    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('returns the route pool model union in OpenAI format without contacting upstream', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5']
    }
    gatewayConfig.accounts[1] = {
      ...gatewayConfig.accounts[1],
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini']
    }
    gatewayConfig.routes[0].modelMap = { fast: 'gpt-5.5-mini' }
    const credentialResolver = vi.fn(() => 'credential')
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await getModels(port)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        { id: 'gpt-5.5', object: 'model', created: Math.floor(gatewayConfig.pools[0].updatedAt / 1000), owned_by: 'stone' },
        { id: 'gpt-5.5-mini', object: 'model', created: Math.floor(gatewayConfig.pools[0].updatedAt / 1000), owned_by: 'stone' },
        { id: 'fast', object: 'model', created: Math.floor(gatewayConfig.pools[0].updatedAt / 1000), owned_by: 'stone' }
      ]
    })
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('applies an explicit pool selection to model listing and generation', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts.forEach((candidate) => {
      candidate.modelPolicy = 'selected'
      candidate.modelAllowlist = ['source-model', 'closed-model']
    })
    gatewayConfig.pools[0].modelPolicy = 'selected'
    gatewayConfig.pools[0].modelAllowlist = ['source-model']
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const list = await getModels(port)
    expect((await list.json() as { data: Array<{ id: string }> }).data.map((model) => model.id))
      .toEqual(['source-model'])
    const denied = await post(port, 'local-secret', { model: 'closed-model' })
    expect(denied.status).toBe(404)
    expect(await denied.json()).toMatchObject({ error: { type: 'model_not_found' } })
    expect(upstreamFetch).not.toHaveBeenCalled()

    gatewayConfig.pools[0].modelAllowlist = []
    gateway.updateConfig(gatewayConfig)
    const empty = await getModels(port)
    expect(await empty.json()).toMatchObject({ object: 'list', data: [] })
  })

  it('returns a Gemini-compatible local model catalog for the Gemini route token', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      protocol: 'gemini',
      models: ['gemini-2.5-pro']
    }
    gatewayConfig.pools[0] = { ...gatewayConfig.pools[0], protocol: 'gemini' }
    gatewayConfig.routes[0] = { ...gatewayConfig.routes[0], inboundProtocol: 'gemini' }
    const gateway = new GatewayServer({ config: gatewayConfig, credentialResolver: () => 'credential' })
    runningServers.push(gateway)
    await gateway.start()

    const response = await getModels(port, '/v1beta/models')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: [{
        name: 'models/gemini-2.5-pro',
        baseModelId: 'gemini-2.5-pro',
        version: '001',
        displayName: 'gemini-2.5-pro',
        supportedGenerationMethods: ['generateContent']
      }]
    })
    expect((await getModels(port, '/v1/models')).status).toBe(401)
  })

  it('returns Anthropic model metadata for an Anthropic route', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      protocol: 'anthropic-messages',
      models: ['claude-sonnet-4-5']
    }
    gatewayConfig.pools[0] = { ...gatewayConfig.pools[0], protocol: 'anthropic-messages' }
    gatewayConfig.routes[0] = { ...gatewayConfig.routes[0], inboundProtocol: 'anthropic-messages' }
    const gateway = new GatewayServer({ config: gatewayConfig, credentialResolver: () => 'credential' })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { 'x-api-key': 'local-secret' }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [{
        type: 'model',
        id: 'claude-sonnet-4-5',
        display_name: 'claude-sonnet-4-5',
        created_at: new Date(gatewayConfig.pools[0].updatedAt).toISOString()
      }],
      has_more: false,
      first_id: 'claude-sonnet-4-5',
      last_id: 'claude-sonnet-4-5'
    })
  })

  it('requires a valid route token before returning a model catalog', async () => {
    const port = await freePort()
    const gateway = new GatewayServer({ config: config(port), credentialResolver: () => 'credential' })
    runningServers.push(gateway)
    await gateway.start()

    expect((await getModels(port, '/v1/models', 'wrong-token')).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401)
  })

  it('requests Gemini streaming responses as SSE', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      kind: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      protocol: 'gemini',
      models: ['gemini-test']
    }
    gatewayConfig.pools[0].protocol = 'gemini'
    gatewayConfig.routes[0].inboundProtocol = 'gemini'
    const upstreamFetch = vi.fn(async () => new Response('data: {"candidates":[]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1beta/models/gemini-test:streamGenerateContent`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] })
    })
    expect(response.status).toBe(200)
    expect(upstreamFetch.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse'
    )
  })

  it('converts an OpenAI Chat stream to Anthropic SSE through the live gateway', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'source-model', stream: true })
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream')
      return new Response([
        'data: {"id":"chat-1","object":"chat.completion.chunk","model":"source-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
        '',
        'data: {"id":"chat-1","object":"chat.completion.chunk","model":"source-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        ''
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const parser = createCanonicalStreamParser('anthropic-messages')
    const events = [
      ...parser.push(new Uint8Array(await response.arrayBuffer())),
      ...parser.finish()
    ]
    expect(events).toContainEqual({ type: 'text-delta', text: 'Hello' })
    expect(events.some((event) => event.type === 'stop' && event.reason === 'stop')).toBe(true)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('refuses to bind a non-loopback host', async () => {
    const gateway = new GatewayServer({
      config: config(0, { host: '0.0.0.0' }),
      credentialResolver: () => 'credential'
    })
    await expect(gateway.start()).rejects.toThrow('loopback-only')
    expect(gateway.getStatus().running).toBe(false)
  })
})
