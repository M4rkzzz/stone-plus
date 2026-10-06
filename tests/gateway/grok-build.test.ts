import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig } from '../../src/main/gateway'
import type {
  Account,
  GatewaySettings,
  Pool,
  ProviderDefinition,
  RequestLog,
  Route,
} from '../../src/shared/types'

const timestamp = 1_700_000_000_000
const runningServers: GatewayServer[] = []

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

function provider(
  id: string,
  kind: ProviderDefinition['kind'],
  baseUrl: string,
  model: string,
): ProviderDefinition {
  return {
    id,
    name: id,
    sourceType: 'relay',
    kind,
    baseUrl,
    protocol: 'openai-responses',
    models: [model],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function account(id: string, providerId: string, model: string): Account {
  return {
    id,
    providerId,
    name: id,
    credentialId: `${id}-credential`,
    maskedCredential: '***',
    credentialType: 'api-key',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [model],
    modelPolicy: 'selected',
    modelAllowlist: [model],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function pool(id: string, accountId: string, protocol: Pool['protocol']): Pool {
  return {
    id,
    name: id,
    kind: 'standard',
    protocol,
    strategy: 'priority',
    members: [{ accountId, enabled: true }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function route(
  id: string,
  client: Route['client'],
  poolId: string,
  localToken: string,
  modelMap: Record<string, string>,
): Route {
  return {
    id,
    client,
    enabled: true,
    poolId,
    inboundProtocol: 'openai-responses',
    modelMap,
    localToken,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function config(port: number): GatewayConfig {
  const codexProvider = provider(
    'codex-provider',
    'openai-compatible',
    'https://codex-upstream.example.test/v1',
    'gpt-upstream',
  )
  const grokProvider = provider(
    'grok-provider',
    'xai-compatible',
    'https://grok-upstream.example.test/v1',
    'grok-upstream',
  )
  const codexAccount = account('codex-account', codexProvider.id, 'gpt-upstream')
  const grokAccount = account('grok-account', grokProvider.id, 'grok-upstream')
  const codexPool = pool('codex-pool', codexAccount.id, 'openai-responses')
  const grokPool = pool('grok-pool', grokAccount.id, 'grok')
  const settings: GatewaySettings = {
    host: '127.0.0.1',
    port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 5,
  }
  return {
    providers: [codexProvider, grokProvider],
    accounts: [codexAccount, grokAccount],
    pools: [codexPool, grokPool],
    routes: [
      route('route-codex', 'codex', codexPool.id, 'codex-local-token', { 'codex-client': 'gpt-upstream' }),
      route('route-grokbuild', 'grokbuild', grokPool.id, 'grokbuild-local-token', {
        'grok-4.5': 'grok-upstream',
        '*': 'grok-upstream',
      }),
    ],
    settings,
  }
}

function completedResponse(model: string): Response {
  return new Response(JSON.stringify({
    id: `resp-${model}`,
    object: 'response',
    status: 'completed',
    model,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function postResponses(
  port: number,
  path: '/v1/responses' | '/grokbuild/v1/responses',
  token: string,
  model: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: 'Hello', stream: false }),
  })
}

function upsertLog(logs: RequestLog[], log: RequestLog): void {
  const index = logs.findIndex((candidate) => candidate.id === log.id)
  if (index >= 0) logs[index] = log
  else logs.push(log)
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('Grok Build reverse proxy', () => {
  it('uses stable Grok conversation headers for affinity and ignores request ids', async () => {
    const port = await freePort()
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: vi.fn(async () => completedResponse('grok-upstream')) as typeof fetch,
      onLog: (log) => upsertLog(logs, log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/grokbuild/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer grokbuild-local-token',
        'content-type': 'application/json',
        'x-grok-conv-id': 'conversation-stable',
        'x-grok-session-id': 'session-fallback',
        'x-grok-req-id': 'request-ephemeral',
      },
      body: JSON.stringify({ model: 'grok-4.5', input: 'Hello', stream: false }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    await response.text()
    expect(logs.find((log) => log.status === 'success')).toMatchObject({
      client: 'grokbuild',
      conversationId: 'conversation-stable',
    })
  })

  it('isolates the Grok Build and Codex namespaces by both path and local token', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      return completedResponse(body.model)
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const grok = await postResponses(
      port,
      '/grokbuild/v1/responses',
      'grokbuild-local-token',
      'grok-4.5',
    )
    expect(grok.status).toBe(200)
    await grok.text()
    expect(String(upstreamFetch.mock.calls[0][0])).toBe('https://grok-upstream.example.test/v1/responses')
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'grok-upstream' })

    const codex = await postResponses(port, '/v1/responses', 'codex-local-token', 'codex-client')
    expect(codex.status).toBe(200)
    await codex.text()
    expect(String(upstreamFetch.mock.calls[1][0])).toBe('https://codex-upstream.example.test/v1/responses')
    expect(JSON.parse(String(upstreamFetch.mock.calls[1][1]?.body))).toMatchObject({ model: 'gpt-upstream' })

    const callsBeforeCrossAuth = upstreamFetch.mock.calls.length
    const rejectedGrokToken = 'codex-local-token'
    expect((await postResponses(port, '/grokbuild/v1/responses', rejectedGrokToken, 'grok-4.5')).status).toBe(401)
    expect((await postResponses(port, '/v1/responses', 'grokbuild-local-token', 'codex-client')).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: 'Bearer grokbuild-local-token' },
    })).status).toBe(401)
    const grokModels = await fetch(`http://127.0.0.1:${port}/grokbuild/v1/models`, {
      headers: { authorization: 'Bearer grokbuild-local-token' },
    })
    expect(grokModels.status).toBe(200)
    expect(await grokModels.json()).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: 'grok-4.5' })]),
    })
    expect(upstreamFetch).toHaveBeenCalledTimes(callsBeforeCrossAuth)
    expect(logs.find((log) => log.status === 'success' && log.client === 'grokbuild')).toMatchObject({
      client: 'grokbuild',
      model: 'grok-4.5',
    })
    expect(logs.find((log) => log.status === 'success' && log.client === 'codex')).toBeDefined()
    const authenticationFailures = logs.filter((log) => log.status === 'error' && log.statusCode === 401)
    expect(authenticationFailures).toHaveLength(1)
    expect(authenticationFailures[0]).toMatchObject({
      client: 'grokbuild',
      protocol: 'openai-responses',
      model: '',
      status: 'error',
      statusCode: 401,
      failureStage: 'authentication',
      providerName: '等待选择',
      accountName: '等待选择',
      error: 'Invalid local gateway token',
    })
    const serializedFailure = JSON.stringify(authenticationFailures[0])
    expect(serializedFailure).not.toContain(rejectedGrokToken)
    expect(serializedFailure).not.toContain('Bearer')
    expect(serializedFailure).not.toContain('Hello')
  })

  it('routes Grok Build compact through its own source and applies the route model mapping', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[1].responsesCompactMode = 'native'
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'grokbuild-compact-state' }],
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'grok-request' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/grokbuild/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer grokbuild-local-token',
        'content-type': 'application/json',
        'x-codex-turn-state': 'must-not-leak-as-codex-state',
      },
      body: JSON.stringify({
        model: 'grok-4.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Keep this context.' }] }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      output: [{ type: 'compaction', encrypted_content: 'grokbuild-compact-state' }],
    })
    expect(String(upstreamFetch.mock.calls[0][0])).toBe('https://grok-upstream.example.test/v1/responses/compact')
    const request = upstreamFetch.mock.calls[0][1]!
    expect(JSON.parse(String(request.body))).toMatchObject({ model: 'grok-upstream' })
    expect(new Headers(request.headers).get('x-codex-turn-state')).toBeNull()
  })

  it('passes native Grok Build Responses fields through without the Codex-to-Grok normalizer', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const requestBody = {
      model: 'grok-4.5',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the project.' }],
      }],
      instructions: 'Use the native Grok Build wire format.',
      tools: [{ type: 'custom', name: 'exec', description: 'Run a shell command.' }],
      tool_choice: { type: 'custom', name: 'exec' },
      parallel_tool_calls: true,
      previous_response_id: 'resp-native-continuation',
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'grok-build-native-cache',
      service_tier: 'priority',
      stream_options: { include_usage: true },
      text: { format: { type: 'text' } },
      metadata: { native: 'preserve-me' },
      presence_penalty: 0.25,
      stream: false,
    }
    const upstreamFetch = vi.fn(async () => completedResponse('grok-upstream'))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/grokbuild/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer grokbuild-local-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    expect(response.status).toBe(200)
    await response.text()
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    const upstreamBody = JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body)) as Record<string, unknown>
    const nativeRequestFields = Object.fromEntries(
      Object.entries(requestBody).filter(([key]) => key !== 'model' && key !== 'stream')
    )
    const nativeUpstreamFields = Object.fromEntries(
      Object.entries(upstreamBody).filter(([key]) => key !== 'model' && key !== 'stream')
    )
    expect(nativeUpstreamFields).toEqual(nativeRequestFields)
    expect(upstreamBody.model).toBe('grok-upstream')
    expect(upstreamBody.stream).toBe(false)
  })

  it('fails closed before fetch when a Grok Build route targets a Grok Chat relay', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[1].protocol = 'openai-chat'
    const upstreamFetch = vi.fn(async () => completedResponse('must-not-run'))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/grokbuild/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer grokbuild-local-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4.5',
        input: 'Inspect the project.',
        tools: [{ type: 'custom', name: 'exec', description: 'Run a shell command.' }],
        tool_choice: { type: 'custom', name: 'exec' },
        stream: false,
      }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_route_source' },
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('fails closed before fetch when a persisted Grok Build route targets a non-Grok source', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes = gatewayConfig.routes.map((candidate) => candidate.client === 'grokbuild'
      ? {
          ...candidate,
          poolId: 'codex-pool',
          // Keep the model valid for the forbidden pool so this test proves
          // source-family enforcement rather than failing incidentally during
          // model exposure checks.
          modelMap: { 'grok-4.5': 'gpt-upstream', '*': 'gpt-upstream' },
        }
      : candidate)
    const upstreamFetch = vi.fn(async () => completedResponse('must-not-run'))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'upstream-secret',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postResponses(
      port,
      '/grokbuild/v1/responses',
      'grokbuild-local-token',
      'grok-4.5',
    )

    expect(response.status).toBe(503)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
