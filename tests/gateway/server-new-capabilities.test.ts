import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, GatewaySettings, Pool, ProviderDefinition, Route } from '../../src/shared/types'
import { GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig } from '../../src/main/gateway'

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

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account',
    providerId: 'provider',
    name: 'Account',
    credentialId: 'credential',
    maskedCredential: '***',
    credentialType: 'api-key',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

function config(input: {
  port: number
  provider: ProviderDefinition
  account: Account
  poolProtocol?: Pool['protocol']
  routeProtocol?: Route['inboundProtocol']
  maxRetries?: number
}): GatewayConfig {
  const pool: Pool = {
    id: 'pool',
    name: 'Pool',
    kind: 'standard',
    protocol: input.poolProtocol ?? input.provider.protocol,
    strategy: 'priority',
    members: [{ accountId: input.account.id, enabled: true }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: input.maxRetries ?? 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const route: Route = {
    id: 'route',
    client: 'codex',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: input.routeProtocol ?? 'openai-responses',
    modelMap: {},
    localToken: 'local-secret',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const settings: GatewaySettings = {
    host: '127.0.0.1',
    port: input.port,
    autoStart: false,
    logPayloads: false,
    requestTimeoutSeconds: 5,
  }
  return {
    providers: [input.provider],
    accounts: [input.account],
    pools: [pool],
    routes: [route],
    settings,
  }
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('GatewayServer new capability boundaries', () => {
  it('retries a transient ChatGPT overload on the same account without opening its circuit', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['source-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const states: Array<{ accountId: string; status: string }> = []
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_recovered","model":"source-model","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const upstreamFetch = vi.fn(async () => {
      if (upstreamFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          error: { code: 'server_is_overloaded', message: 'capacity is temporarily constrained' },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      }
      return new Response(completed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'chatgpt-oauth' }),
        maxRetries: 1,
      }),
      credentialResolver: () => ({
        secret: 'oauth-access-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'hello', stream: true }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('response.completed')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'cooldown' }))
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'disabled' }))
  })

  it('does not cool down a ChatGPT account for a streamed overload terminal', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['source-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const states: Array<{ accountId: string; status: string }> = []
    const failed = [
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_busy","status":"failed","error":{"code":"server_is_overloaded","message":"capacity is temporarily constrained"}}}',
      '',
      '',
    ].join('\n')
    const upstreamFetch = vi.fn(async () => new Response(failed, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'chatgpt-oauth' }),
        maxRetries: 1,
      }),
      credentialResolver: () => ({
        secret: 'oauth-access-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'hello', stream: true }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('server_is_overloaded')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'cooldown' }))
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'disabled' }))
  })

  it('applies pool reasoning remapping and its cap to the actual upstream request', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'OpenAI',
      kind: 'openai',
      sourceType: 'official-api',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: ['source-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const gatewayConfig = config({ port, provider, account: account(), maxRetries: 0 })
    gatewayConfig.pools[0].reasoningEffortMap = { medium: 'max' }
    gatewayConfig.pools[0].reasoningEffortCap = 'high'
    const receivedBodies: Array<Record<string, unknown>> = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedBodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({
        id: 'resp_reasoning', model: 'source-model', status: 'completed', output: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'openai-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model', input: 'reason carefully', stream: false,
        reasoning: { effort: 'medium' },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(receivedBodies).toEqual([
      expect.objectContaining({ reasoning: expect.objectContaining({ effort: 'high' }) }),
    ])
  })

  it('derives stable pool affinity from bounded conversation history when clients omit session ids', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'OpenAI',
      kind: 'openai',
      sourceType: 'official-api',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: ['source-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const first = account({ id: 'account-one', credentialId: 'credential-one', name: 'One' })
    const second = account({ id: 'account-two', credentialId: 'credential-two', name: 'Two' })
    const gatewayConfig = config({ port, provider, account: first, maxRetries: 0 })
    gatewayConfig.accounts.push(second)
    gatewayConfig.pools[0].members.push({ accountId: second.id, enabled: true })
    gatewayConfig.pools[0].strategy = 'round-robin'
    gatewayConfig.pools[0].stickySessions = true
    const authorizations: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(JSON.stringify({
        id: `resp_${authorizations.length}`, model: 'source-model', status: 'completed', output: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => ({ secret: `key-${selected.id}`, kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const request = (input: unknown[]) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input, stream: false }),
    })
    const stablePrefix = [
      { role: 'user', content: [{ type: 'input_text', text: 'remember this conversation' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'remembered' }] },
    ]
    const firstResponse = await request(stablePrefix)
    const secondResponse = await request([
      ...stablePrefix,
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])

    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200)
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200)
    expect(authorizations).toEqual(['Bearer key-account-one', 'Bearer key-account-one'])
  })

  it('dispatches an xAI image request through the selected account and normalizes its model', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'xAI',
      kind: 'xai',
      sourceType: 'official-api',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai-responses',
      // Media model ids are intentionally absent from the language catalog.
      models: ['grok-4'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ data: [{ url: 'https://images.example.test/result.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key', availableModels: ['grok-4'] }),
        poolProtocol: 'grok',
      }),
      credentialResolver: () => ({ secret: 'xai-private-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-imagine', prompt: 'a stone arch', size: '1024x1024' }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ data: [{ url: 'https://images.example.test/result.png' }] })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [upstreamUrl, upstreamInit] = upstreamFetch.mock.calls[0]
    expect(String(upstreamUrl)).toBe('https://api.x.ai/v1/images/generations')
    expect(new Headers(upstreamInit?.headers).get('authorization')).toBe('Bearer xai-private-key')
    expect(upstreamInit?.redirect).toBe('error')
    expect(JSON.parse(new TextDecoder().decode(upstreamInit?.body as Uint8Array))).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'a stone arch',
    })
  })

  it('preserves the original Grok media failure when there is no failover peer', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'xAI',
      kind: 'xai',
      sourceType: 'official-api',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai-responses',
      models: ['grok-4'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const states: Array<{ accountId: string; status: string }> = []
    const upstreamFetch = vi.fn(async () => new Response('busy', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    }))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key' }),
        poolProtocol: 'grok',
        maxRetries: 2,
      }),
      credentialResolver: () => ({ secret: 'xai-private-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-imagine', prompt: 'a stone arch' }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ type: 'provider_upstream' }),
    })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'cooldown' }))
  })

  it('keeps video polling on its original account and proxies only a validated signed asset URL', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'xAI',
      kind: 'xai',
      sourceType: 'official-api',
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'openai-responses',
      models: ['grok-4'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const calls: Array<{ url: string; authorization: string | null }> = []
    let savedBindings: import('../../src/main/gateway').PersistedGrokVideoBinding[] = []
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      if (url.endsWith('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'video-request-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/videos/video-request-1')) {
        return new Response(JSON.stringify({
          status: 'done',
          model: 'grok-imagine-video-1.5',
          video: { url: 'https://vidgen.x.ai/assets/video.mp4?sig=temporary', duration: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://vidgen.x.ai/assets/video.mp4?sig=temporary') {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        })
      }
      throw new Error(`Unexpected test URL: ${url}`)
    })
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key' }),
        poolProtocol: 'grok',
      }),
      credentialResolver: () => ({ secret: 'xai-private-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
      saveGrokVideoBindings: async (bindings) => { savedBindings = bindings.map((binding) => ({ ...binding })) },
    })
    runningServers.push(gateway)
    await gateway.start()

    const createResponse = await fetch(`http://127.0.0.1:${port}/v1/videos/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-imagine-video-1.5', prompt: 'a stone arch at sunrise' }),
    })
    expect(createResponse.status, await createResponse.clone().text()).toBe(200)
    expect(await createResponse.json()).toEqual({ request_id: 'video-request-1' })
    expect(savedBindings).toEqual([expect.objectContaining({
      requestId: 'video-request-1',
      accountId: 'account',
      routeId: 'route',
    })])

    await gateway.stop({ force: true })
    const restoredGateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key' }),
        poolProtocol: 'grok',
      }),
      credentialResolver: () => ({ secret: 'xai-private-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
      loadGrokVideoBindings: () => savedBindings,
      saveGrokVideoBindings: async (bindings) => { savedBindings = bindings.map((binding) => ({ ...binding })) },
    })
    runningServers.push(restoredGateway)
    await restoredGateway.start()

    const statusResponse = await fetch(`http://127.0.0.1:${port}/v1/videos/video-request-1`, {
      headers: { authorization: 'Bearer local-secret' },
    })
    expect(statusResponse.status, await statusResponse.clone().text()).toBe(200)
    const statusPayload = await statusResponse.json() as { video: { url: string } }
    expect(statusPayload.video.url).toBe(
      `http://127.0.0.1:${port}/v1/videos/video-request-1/content`,
    )

    const contentResponse = await fetch(statusPayload.video.url, {
      headers: { authorization: 'Bearer local-secret', range: 'bytes=0-3' },
    })
    expect(contentResponse.status).toBe(200)
    expect([...new Uint8Array(await contentResponse.arrayBuffer())]).toEqual([1, 2, 3, 4])
    expect(calls).toEqual([
      { url: 'https://api.x.ai/v1/videos/generations', authorization: 'Bearer xai-private-key' },
      { url: 'https://api.x.ai/v1/videos/video-request-1', authorization: 'Bearer xai-private-key' },
      { url: 'https://vidgen.x.ai/assets/video.mp4?sig=temporary', authorization: null },
    ])
  })

  it('fails ChatGPT OAuth Live closed when native device attestation is unavailable', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['source-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'chatgpt-oauth' }),
      }),
      credentialResolver: () => 'unused',
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/live`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-realtime' }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ type: 'live_attestation_unavailable' }),
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
