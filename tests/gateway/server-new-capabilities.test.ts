import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, GatewaySettings, Pool, ProviderDefinition, RequestLog, Route } from '../../src/shared/types'
import { GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig, GatewayRuntimeStateUpdate } from '../../src/main/gateway'
import {
  CHATGPT_WEB_WM_PROTOCOL_REVISION,
  GPT_5_6_SOL_WM_MODEL,
} from '../../src/shared/wm-routing'

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
  routeClient?: Route['client']
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
    client: input.routeClient ?? 'codex',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: input.routeProtocol ?? (input.routeClient === 'deepseek-harness' ? 'openai-chat' : 'openai-responses'),
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
  it('routes every model in a verified Web WM pool through the protocol transport', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['client-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const selectedAccount = account({
      credentialType: 'chatgpt-oauth',
      availableModels: ['client-model'],
      modelsRefreshedAt: timestamp,
      modelPolicy: 'selected',
      modelAllowlist: ['client-model'],
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const gatewayConfig = config({
      port,
      provider,
      account: selectedAccount,
      poolProtocol: 'chatgpt-web-wm',
      maxRetries: 0,
    })
    gatewayConfig.pools[0].modelPolicy = 'selected'
    gatewayConfig.pools[0].modelAllowlist = ['client-model']
    const logs: RequestLog[] = []
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_wm","model":"gpt-5.6-sol","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const webTransport = vi.fn(async () => new Response(completed, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const upstreamFetch = vi.fn(async () => {
      throw new Error('Web WM generation must not use the ordinary Codex transport')
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
      onLog: (log) => logs.push(log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'dsh-overflow-session',
      },
      body: JSON.stringify({
        model: 'client-model',
        input: [
          { type: 'additional_tools', role: 'developer', tools: [] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        reasoning: { effort: 'high', context: 'all_turns' },
        text: { verbosity: 'low' },
        stream: true,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('response.completed')
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(webTransport).toHaveBeenCalledOnce()
    expect(webTransport.mock.calls[0][0]).toMatchObject({
      operation: 'responses',
      credential: { accessToken: 'oauth-token', accountId: 'chatgpt-account' },
      body: {
        model: GPT_5_6_SOL_WM_MODEL,
        input: [
          { type: 'additional_tools', role: 'developer', tools: [] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        reasoning: { effort: 'high', context: 'all_turns' },
        text: { verbosity: 'low' },
      },
    })
    expect(logs.findLast((log) => log.status === 'success')).toMatchObject({
      model: 'client-model',
      upstreamModel: GPT_5_6_SOL_WM_MODEL,
    })
  })

  it('preserves safe Web WM request errors instead of replacing them with an OAuth generic error', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider', name: 'ChatGPT OAuth', kind: 'openai', sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses',
      models: ['client-model'], createdAt: timestamp, updatedAt: timestamp,
    }
    const selectedAccount = account({
      credentialType: 'chatgpt-oauth',
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const logs: RequestLog[] = []
    const webTransport = vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'web_wm_state_not_found',
        message: 'The Web WM continuation state is unavailable.',
        param: 'input',
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config({
        port, provider, account: selectedAccount, poolProtocol: 'chatgpt-web-wm', maxRetries: 5,
      }),
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      chatGptWebWmTransport: webTransport,
      onLog: (log) => logs.push(log),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'continue', stream: true }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'web_wm_state_not_found',
        message: 'The Web WM continuation state is unavailable.',
        param: 'input',
      },
    })
    expect(logs.findLast((log) => log.status === 'error')?.error)
      .toBe('The Web WM continuation state is unavailable.')
    expect(webTransport).toHaveBeenCalledOnce()
  })

  it('refreshes a Web WM OAuth token rejected inside an HTTP 200 Responses stream', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider', name: 'ChatGPT OAuth', kind: 'openai', sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses',
      models: ['client-model'], createdAt: timestamp, updatedAt: timestamp,
    }
    const selectedAccount = account({
      credentialType: 'chatgpt-oauth',
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const gatewayConfig = config({
      port, provider, account: selectedAccount, poolProtocol: 'chatgpt-web-wm', maxRetries: 0,
    })
    const rejected = [
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_rejected","object":"response","status":"failed","error":{"code":"authentication_error","message":"Access token rejected"},"output":[]}}',
      '',
      '',
    ].join('\n')
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_recovered","object":"response","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const usedTokens: string[] = []
    const recoverRejectedAccess = vi.fn(async () => ({
      secret: 'fresh-oauth-token',
      kind: 'chatgpt-oauth' as const,
      accountId: 'chatgpt-account',
    }))
    const webTransport = vi.fn(async (input: { credential: { accessToken: string } }) => {
      usedTokens.push(input.credential.accessToken)
      return new Response(input.credential.accessToken === 'stale-oauth-token' ? rejected : completed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'stale-oauth-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
        recoverRejectedAccess,
      }),
      chatGptWebWmTransport: webTransport,
      requestTransientRetryDelayMs: 0,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'hello', stream: true }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('resp_recovered')
    expect(usedTokens).toEqual(['stale-oauth-token', 'fresh-oauth-token'])
    expect(recoverRejectedAccess).toHaveBeenCalledOnce()
  })

  it('retries an HTTP 200 Web WM response.failed 429 twice before succeeding', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider', name: 'ChatGPT OAuth', kind: 'openai', sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses',
      models: ['client-model'], createdAt: timestamp, updatedAt: timestamp,
    }
    const selectedAccount = account({
      credentialType: 'chatgpt-oauth',
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const gatewayConfig = config({
      port, provider, account: selectedAccount, poolProtocol: 'chatgpt-web-wm', maxRetries: 0,
    })
    const overloaded = [
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_busy","object":"response","status":"failed","error":{"code":"rate_limit_error","message":"Temporarily overloaded"},"output":[]}}',
      '',
      '',
    ].join('\n')
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_third","object":"response","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    let attempts = 0
    const webTransport = vi.fn(async () => {
      attempts += 1
      return new Response(attempts < 3 ? overloaded : completed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account',
      }),
      chatGptWebWmTransport: webTransport,
      requestTransientRetryDelayMs: 0,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'hello', stream: true }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('resp_third')
    expect(webTransport).toHaveBeenCalledTimes(3)
  })

  it('isolates the ChatGPT WM unsupported response to one account and fails over', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['client-model'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const deniedAccount = account({
      id: 'wm-denied',
      name: 'WM denied',
      credentialId: 'credential-wm-denied',
      credentialType: 'chatgpt-oauth',
      priority: 1,
      availableModels: ['client-model'],
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const workingAccount = account({
      id: 'wm-working',
      name: 'WM working',
      credentialId: 'credential-wm-working',
      credentialType: 'chatgpt-oauth',
      priority: 10,
      availableModels: ['client-model'],
      chatgptWebWm: {
        version: 2,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace',
        verifiedAt: timestamp,
        latencyMs: 100,
      },
    })
    const gatewayConfig = config({
      port,
      provider,
      account: deniedAccount,
      poolProtocol: 'chatgpt-web-wm',
      maxRetries: 1,
    })
    gatewayConfig.accounts.push(workingAccount)
    gatewayConfig.pools[0].members.push({ accountId: workingAccount.id, enabled: true })
    const selectedAccounts: string[] = []
    const states: GatewayRuntimeStateUpdate[] = []
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_wm_peer","model":"gpt-5.6-sol","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const webTransport = vi.fn(async (input: { account: Account }) => {
      if (input.account.id === 'wm-denied') {
        return new Response(JSON.stringify({
          detail: `The '${GPT_5_6_SOL_WM_MODEL}' model is not supported when using Codex with a ChatGPT account.`,
        }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(completed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const upstreamFetch = vi.fn(async () => {
      throw new Error('Web WM generation must not use the ordinary Codex transport')
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccounts.push(selected.id)
        return {
          secret: `token-${selected.id}`,
          kind: 'chatgpt-oauth',
          accountId: `chatgpt-${selected.id}`,
        }
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      chatGptWebWmTransport: webTransport,
      onAccountState: (state) => states.push(state),
    })
    runningServers.push(gateway)
    await gateway.start()

    const request = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', input: 'hello', stream: true }),
    })
    const firstResponse = await request()
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200)
    await firstResponse.text()
    const secondResponse = await request()
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200)
    await secondResponse.text()

    expect(selectedAccounts).toEqual(['wm-denied', 'wm-working', 'wm-working'])
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(webTransport.mock.calls.map(([input]) => input.body.model))
      .toEqual([
        GPT_5_6_SOL_WM_MODEL,
        GPT_5_6_SOL_WM_MODEL,
        GPT_5_6_SOL_WM_MODEL,
      ])
    expect(states).toContainEqual(expect.objectContaining({
      accountId: 'wm-denied',
      status: 'active',
      modelCooldowns: expect.objectContaining({
        [GPT_5_6_SOL_WM_MODEL]: expect.objectContaining({ reason: 'not-found', statusCode: 400 }),
      }),
    }))
    expect(states).not.toContainEqual(expect.objectContaining({ accountId: 'wm-denied', status: 'disabled' }))
    expect(states).not.toContainEqual(expect.objectContaining({ accountId: 'wm-denied', status: 'cooldown' }))
  })

  it('preserves ChatGPT Responses item-limit errors as context overflow for DSH compaction', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'ChatGPT OAuth',
      kind: 'openai',
      sourceType: 'oauth-system',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      protocol: 'openai-responses',
      models: ['gpt-5.6-sol'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({
          credentialType: 'chatgpt-oauth',
          availableModels: ['gpt-5.6-sol'],
        }),
        poolProtocol: 'openai-responses',
        routeProtocol: 'openai-responses',
        routeClient: 'deepseek-harness',
        maxRetries: 0,
      }),
      credentialResolver: () => ({ secret: 'oauth-access-token', kind: 'chatgpt-oauth', accountId: 'chatgpt-account' }),
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        error: {
          message: "Invalid 'input': array too long. Expected an array with maximum length 16384, but got 38250",
          type: 'invalid_request_error',
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/deepseek-harness/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'dsh-overflow-session',
      },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], stream: true }),
    })

    expect(response.status, await response.clone().text()).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'context_length_exceeded',
        code: 'context_length_exceeded',
      },
    })
  }, 15_000)

  it('isolates the DeepSeek Harness Chat Completions endpoint and model catalog by route token', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'OpenAI-compatible relay',
      kind: 'openai-compatible',
      sourceType: 'relay',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-chat',
      models: ['gpt-5.6-sol', 'gpt-5.5'],
      modelCatalog: [
        { id: 'gpt-5.6-sol', contextWindow: 64_000, maxOutputTokens: 8_192 },
        { id: 'gpt-5.5', contextWindow: 32_000, maxOutputTokens: 4_096 },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-harness',
      model: 'gpt-5.6-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Harness ready' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key', availableModels: ['gpt-5.6-sol', 'gpt-5.5'] }),
        poolProtocol: 'openai-chat',
        routeProtocol: 'openai-responses',
        routeClient: 'deepseek-harness',
      }),
      credentialResolver: () => ({ secret: 'relay-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/deepseek-harness/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'dsh-gpt-session',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'xhigh',
      }),
    })
    const catalog = await fetch(`http://127.0.0.1:${port}/deepseek-harness/v1/models`, {
      headers: { authorization: 'Bearer local-secret' },
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'Harness ready' } }] })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://relay.example.test/v1/chat/completions')
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body))).toMatchObject({
      reasoning_effort: 'xhigh',
    })
    expect(catalog.status, await catalog.clone().text()).toBe(200)
    expect(await catalog.json()).toMatchObject({
      data: [{ id: 'gpt-5.6-sol', context_window: 64_000, max_output_tokens: 8_192 }],
    })
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: 'Bearer local-secret' },
    })).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] }),
    })).status).toBe(401)
  })

  it('admits bounded DeepSeek Harness Chat and Responses histories above the standard 10 MiB limit', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'OpenAI-compatible relay',
      kind: 'openai-compatible',
      sourceType: 'relay',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-chat',
      models: ['gpt-5.6-sol'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-large-harness',
      model: 'gpt-5.6-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Harness ready' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key', availableModels: ['gpt-5.6-sol'] }),
        poolProtocol: 'openai-chat',
        routeProtocol: 'openai-responses',
        routeClient: 'deepseek-harness',
      }),
      credentialResolver: () => ({ secret: 'relay-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const largeText = 'x'.repeat(10 * 1024 * 1024 + 1)
    const chatResponse = await fetch(`http://127.0.0.1:${port}/deepseek-harness/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'dsh-large-session',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: largeText }],
      }),
    })
    const responsesResponse = await fetch(`http://127.0.0.1:${port}/deepseek-harness/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'dsh-large-responses-session',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: largeText,
        stream: false,
      }),
    })

    expect(chatResponse.status, await chatResponse.clone().text()).toBe(200)
    expect(responsesResponse.status, await responsesResponse.clone().text()).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  }, 20_000)

  it('persists DSH model families and keeps Codex imports on GPT-5.6', async () => {
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'Multi-family test relay',
      kind: 'custom',
      sourceType: 'relay',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-chat',
      models: ['gpt-5.6-terra', 'gpt-5.5', 'deepseek-v4-flash'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const harnessAccount = account({
      credentialType: 'api-key',
      availableModels: ['gpt-5.6-terra', 'gpt-5.5', 'deepseek-v4-flash'],
    })
    let persisted: Array<{ sessionId: string; family: 'gpt' | 'deepseek'; boundAt: number }> = []
    const createHarnessGateway = async (port: number, upstreamFetch: typeof fetch): Promise<GatewayServer> => {
      const gateway = new GatewayServer({
        config: config({
          port,
          provider,
          account: harnessAccount,
          poolProtocol: 'openai-chat',
          routeProtocol: 'openai-responses',
          routeClient: 'deepseek-harness',
        }),
        credentialResolver: () => ({ secret: 'relay-key', kind: 'api-key' }),
        fetchImplementation: upstreamFetch,
        loadDeepSeekHarnessModelBindings: () => persisted,
        saveDeepSeekHarnessModelBindings: async (bindings) => {
          persisted = bindings.map((binding) => ({ ...binding }))
        },
      })
      runningServers.push(gateway)
      await gateway.start()
      return gateway
    }
    const send = (
      port: number,
      sessionId: string,
      model: string,
      sessionHeader = 'x-deepseek-harness-session-id',
    ) => fetch(
      `http://127.0.0.1:${port}/deepseek-harness/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json',
          [sessionHeader]: sessionId,
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
      },
    )
    const sendResponses = (port: number, sessionId: string, model: string) => fetch(
      `http://127.0.0.1:${port}/deepseek-harness/v1/responses`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json',
          session_id: sessionId,
        },
        body: JSON.stringify({ model, input: 'hello', stream: false }),
      },
    )

    const firstPort = await freePort()
    const firstUpstream = vi.fn(async () => Response.json({
      id: 'first',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    })) as unknown as typeof fetch
    const firstGateway = await createHarnessGateway(firstPort, firstUpstream)
    const unboundDirectory = await fetch(
      `http://127.0.0.1:${firstPort}/deepseek-harness/stone/session-models?session_id=gpt-session`,
      { headers: { authorization: 'Bearer local-secret' } },
    )
    expect(unboundDirectory.status, await unboundDirectory.clone().text()).toBe(200)
    expect(await unboundDirectory.json()).toEqual({
      family: null,
      allowedModels: ['gpt-5.6-terra', 'deepseek-v4-flash'],
    })
    const selectedDirectory = await fetch(
      `http://127.0.0.1:${firstPort}/deepseek-harness/stone/session-models`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'gpt-session', model: 'gpt-5.6-terra' }),
      },
    )
    expect(selectedDirectory.status, await selectedDirectory.clone().text()).toBe(200)
    expect(await selectedDirectory.json()).toEqual({
      family: null,
      allowedModels: ['gpt-5.6-terra', 'deepseek-v4-flash'],
    })
    expect(persisted).toEqual([])
    expect((await send(firstPort, 'gpt-session', 'gpt-5.6-terra')).status).toBe(200)
    expect(persisted).toMatchObject([{ sessionId: 'gpt-session', family: 'gpt' }])
    await firstGateway.stop({ force: true })

    const secondPort = await freePort()
    const secondUpstream = vi.fn(async () => Response.json({
      id: 'second',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    })) as unknown as typeof fetch
    await createHarnessGateway(secondPort, secondUpstream)
    const restoredSwitch = await send(secondPort, 'gpt-session', 'deepseek-v4-flash')
    expect(restoredSwitch.status).toBe(409)
    expect(await restoredSwitch.text()).toContain('permanently bound to GPT-5.6')
    const importedSwitch = await send(
      secondPort,
      'stone-codex-v2-0123456789abcdef0123456789abcdef',
      'deepseek-v4-flash',
      'session_id',
    )
    expect(importedSwitch.status).toBe(409)
    expect(secondUpstream).not.toHaveBeenCalled()
    const importedResume = await sendResponses(
      secondPort,
      'stone-codex-v2-0123456789abcdef0123456789abcdef',
      'gpt-5.6-terra',
    )
    expect(importedResume.status, await importedResume.clone().text()).toBe(200)

    expect((await send(secondPort, 'deepseek-session', 'deepseek-v4-flash')).status).toBe(200)
    expect((await send(secondPort, 'deepseek-session', 'gpt-5.6-terra')).status).toBe(409)
    expect(secondUpstream).toHaveBeenCalledTimes(2)

    const restoredDirectory = await fetch(
      `http://127.0.0.1:${secondPort}/deepseek-harness/stone/session-models?session_id=gpt-session`,
      { headers: { authorization: 'Bearer local-secret' } },
    )
    expect(await restoredDirectory.json()).toEqual({
      family: 'gpt',
      allowedModels: ['gpt-5.6-terra'],
    })
    const importedDirectory = await fetch(
      `http://127.0.0.1:${secondPort}/deepseek-harness/stone/session-models?session_id=stone-codex-v2-0123456789abcdef0123456789abcdef`,
      { headers: { authorization: 'Bearer local-secret' } },
    )
    expect(await importedDirectory.json()).toEqual({
      family: 'gpt',
      allowedModels: ['gpt-5.6-terra'],
    })
    const rejectedSelection = await fetch(
      `http://127.0.0.1:${secondPort}/deepseek-harness/stone/session-models`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'gpt-session', model: 'deepseek-v4-flash' }),
      },
    )
    expect(rejectedSelection.status).toBe(409)
    expect(await rejectedSelection.text()).toContain('permanently bound to GPT-5.6')

    const catalog = await fetch(`http://127.0.0.1:${secondPort}/deepseek-harness/v1/models`, {
      headers: { authorization: 'Bearer local-secret' },
    })
    const payload = await catalog.json() as { data: Array<{ id: string }> }
    expect(payload.data.map((entry) => entry.id)).toEqual(['gpt-5.6-terra', 'deepseek-v4-flash'])
  })

  it('bridges the DSH native search provider through the routed Responses source', async () => {
    const port = await freePort()
    const provider: ProviderDefinition = {
      id: 'provider',
      name: 'OpenAI Responses relay',
      kind: 'openai-compatible',
      sourceType: 'relay',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-responses',
      models: ['gpt-search'],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const upstreamFetch = vi.fn(async () => Response.json({
      id: 'search-result',
      action: 'search',
      data: [{ title: 'Stone result', url: 'https://example.test/stone' }],
    }))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'api-key', availableModels: ['gpt-search'] }),
        poolProtocol: 'openai-responses',
        routeProtocol: 'openai-responses',
        routeClient: 'deepseek-harness',
      }),
      credentialResolver: () => ({ secret: 'relay-key', kind: 'api-key' }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/deepseek-harness/anthropic/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-search',
        max_tokens: 4_096,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: Stone+ docs' }],
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      type: 'message',
      model: 'gpt-search',
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'Stone+ docs' } },
        {
          type: 'web_search_tool_result',
          content: [{
            type: 'web_search_result',
            title: 'Stone result',
            url: 'https://example.test/stone',
          }],
        },
      ],
      stop_reason: 'end_turn',
    })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://relay.example.test/v1/alpha/search')
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body))).toMatchObject({
      model: 'gpt-search',
      action: 'search',
      query: 'Stone+ docs',
      commands: { search_query: [{ q: 'Stone+ docs' }] },
    })
  })

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
      requestTransientRetryDelayMs: 0,
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

  it('does not hide a streamed overload terminal on the ordinary ChatGPT Responses path', async () => {
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
      requestTransientRetryDelayMs: 0,
      onAccountState: (state) => states.push(state),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'hello', stream: true }),
    })

    const body = await response.text()
    // Only Web WM keeps lifecycle/terminal frames private. The ordinary
    // ChatGPT OAuth path commits the upstream terminal immediately so the
    // main chain retains its original streaming behavior.
    expect(response.status).toBe(200)
    expect(body).toContain('server_is_overloaded')
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'cooldown' }))
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'disabled' }))
  })

  it('does not retry a streamed overload after the ordinary ChatGPT path commits it', async () => {
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
    const failed = [
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_busy","status":"failed","error":{"code":"server_is_overloaded","message":"capacity is temporarily constrained"}}}',
      '',
      '',
    ].join('\n')
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_recovered","model":"source-model","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const upstreamFetch = vi.fn(async () => new Response(
      upstreamFetch.mock.calls.length < 3 ? failed : completed,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'chatgpt-oauth' }),
        maxRetries: 0,
      }),
      credentialResolver: () => ({
        secret: 'oauth-access-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
      requestTransientRetryDelayMs: 0,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'hello', stream: true }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(body).toContain('server_is_overloaded')
    expect(body).not.toContain('response.completed')
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
  })

  it('does not hide a truncated stream after the ordinary ChatGPT path commits its first event', async () => {
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
    const truncated = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_truncated","model":"source-model","status":"in_progress","output":[]}}',
      '',
      '',
    ].join('\n')
    const completed = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_recovered","model":"source-model","status":"completed","output":[]}}',
      '',
      '',
    ].join('\n')
    const upstreamFetch = vi.fn(async () => new Response(
      upstreamFetch.mock.calls.length < 3 ? truncated : completed,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const gateway = new GatewayServer({
      config: config({
        port,
        provider,
        account: account({ credentialType: 'chatgpt-oauth' }),
        maxRetries: 0,
      }),
      credentialResolver: () => ({
        secret: 'oauth-access-token',
        kind: 'chatgpt-oauth',
        accountId: 'chatgpt-account',
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'hello', stream: true }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(body).toContain('response.created')
    expect(body).toContain('Upstream stream ended before a terminal event')
    expect(body).not.toContain('response.completed')
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
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
