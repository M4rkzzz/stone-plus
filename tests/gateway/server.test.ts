import { createServer as createNodeServer } from 'node:net'
import { request as createHttpRequest, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
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

function beginPausedPost(
  port: number,
  body: Record<string, unknown> = {}
): {
  finish: () => void
  result: Promise<{ statusCode?: number; body: string }>
} {
  const wireBody = JSON.stringify({
    model: 'source-model',
    messages: [{ role: 'user', content: 'Hello' }],
    ...body
  })
  const splitAt = Math.max(1, Math.floor(wireBody.length / 2))
  let request!: ReturnType<typeof createHttpRequest>
  const result = new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
    request = createHttpRequest({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(wireBody)
      }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    request.on('error', reject)
    request.write(wireBody.slice(0, splitAt))
  })
  return {
    finish: () => request.end(wireBody.slice(splitAt)),
    result
  }
}

function upsertLog(logs: RequestLog[], log: RequestLog): void {
  const index = logs.findIndex((candidate) => candidate.id === log.id)
  if (index >= 0) logs[index] = log
  else logs.unshift(log)
}

async function postSession(
  port: number,
  sessionId: string,
  body: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
      'x-stone-session-id': sessionId
    },
    body: JSON.stringify({ model: 'source-model', messages: [{ role: 'user', content: 'Hello' }], ...body })
  })
}

function scheduledSseResponse(frames: Array<{ atMs: number; data: string; close?: boolean }>): Response {
  const encoder = new TextEncoder()
  const timers: Array<ReturnType<typeof setTimeout>> = []
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (frame: { data: string; close?: boolean }) => {
        controller.enqueue(encoder.encode(frame.data))
        if (frame.close) controller.close()
      }
      for (const frame of frames) {
        if (frame.atMs <= 0) emit(frame)
        else timers.push(setTimeout(() => emit(frame), frame.atMs))
      }
    },
    cancel() {
      timers.forEach((timer) => clearTimeout(timer))
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function sseResponseChunks(chunks: readonly Uint8Array[], headers: Record<string, string> = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers }
  })
}

async function runCompactV2Wire(chunks: readonly Uint8Array[]): Promise<{ status: number; wire: string }> {
  const port = await freePort()
  const gatewayConfig = config(port)
  gatewayConfig.providers[0] = {
    ...gatewayConfig.providers[0],
    sourceType: 'oauth-system',
    kind: 'openai',
    protocol: 'openai-responses'
  }
  gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
  gatewayConfig.pools[0].protocol = 'openai-responses'
  gatewayConfig.accounts[0] = {
    ...gatewayConfig.accounts[0],
    credentialType: 'chatgpt-oauth',
    chatgptAccountId: 'acct-first'
  }
  gatewayConfig.accounts[1].status = 'disabled'
  gatewayConfig.pools[0].maxRetries = 0
  const gateway = new GatewayServer({
    config: gatewayConfig,
    credentialResolver: () => ({
      secret: 'oauth-first-private',
      kind: 'chatgpt-oauth' as const,
      accountId: 'acct-first'
    }),
    fetchImplementation: vi.fn(async () => sseResponseChunks(chunks)) as typeof fetch
  })
  await gateway.start()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })
    return { status: response.status, wire: await response.text() }
  } finally {
    await gateway.stop({ force: true })
  }
}

async function getModels(port: number, path = '/v1/models', token = 'local-secret'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  })
}

async function runConcurrencyModeRequest(highConcurrencyMode: boolean): Promise<{
  gateway: GatewayServer
  rawLogs: RequestLog[]
  runtimeAccountUpdates: string[][]
  status: number
  titleResolver: ReturnType<typeof vi.fn>
  upstreamFetch: ReturnType<typeof vi.fn>
  wire: string
}> {
  const port = await freePort()
  const gatewayConfig = config(port, { logPayloads: true })
  gatewayConfig.routes[0].highConcurrencyMode = highConcurrencyMode
  gatewayConfig.accounts[1].status = 'disabled'
  gatewayConfig.pools[0].maxRetries = 0
  gatewayConfig.pools[0].hedgedRequests = true
  gatewayConfig.pools[0].hedgeDelayMs = 250
  const titleResolver = vi.fn(() => 'Resolved concurrency title')
  const rawLogs: RequestLog[] = []
  const runtimeAccountUpdates: string[][] = []
  const firstFrame = [
    'data: {"id":"chat-concurrency-mode","model":"source-model","choices":[{"index":0,"delta":{"content":"Mode output"},"finish_reason":null}]}',
    '', ''
  ].join('\n')
  const terminalFrame = [
    'data: {"id":"chat-concurrency-mode","model":"source-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
    '',
    'data: [DONE]',
    '', ''
  ].join('\n')
  const upstreamFetch = vi.fn(async () => {
    // Normal routes should launch the 250 ms hedge. High-concurrency routes
    // deliberately wait for this primary lane instead of duplicating work.
    if (upstreamFetch.mock.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 325))
    }
    return scheduledSseResponse([
      { atMs: 0, data: firstFrame },
      { atMs: 30, data: terminalFrame, close: true }
    ])
  })
  const gateway = new GatewayServer({
    config: gatewayConfig,
    credentialResolver: () => 'credential',
    fetchImplementation: upstreamFetch as typeof fetch,
    conversationTitleResolver: titleResolver,
    onLog: (log) => rawLogs.push(log)
  })
  gateway.onRuntimeState((update) => {
    if (update.accountIds?.length) runtimeAccountUpdates.push([...update.accountIds])
  })
  runningServers.push(gateway)
  await gateway.start()

  const response = await post(port, 'local-secret', {
    stream: true,
    metadata: { session_id: 'concurrency-session' }
  })
  const status = response.status
  const wire = await response.text()
  await vi.waitFor(() => expect(rawLogs.some((log) => log.status === 'success')).toBe(true))
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { gateway, rawLogs, runtimeAccountUpdates, status, titleResolver, upstreamFetch, wire }
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
})

describe('GatewayServer', () => {
  it('captures replay payloads only when enabled and exposes a content-redacted template', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { logPayloads: true })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        id: 'chatcmpl-replay',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    })
    runningServers.push(gateway)
    let terminal: RequestLog | undefined
    gateway.onLog((log) => { if (log.status !== 'streaming') terminal = log })
    await gateway.start()
    expect((await post(port)).status).toBe(200)
    expect(terminal).toBeDefined()
    expect(gateway.getRequestReplayTemplate(terminal!.id)).toMatchObject({
      path: '/v1/chat/completions',
      body: { model: 'source-model', messages: [{ role: 'user', content: '[CONTENT REDACTED]' }] },
      contentRedacted: true
    })
    gateway.updateConfig({ ...gatewayConfig, settings: { ...gatewayConfig.settings, logPayloads: false } })
    expect(gateway.getRequestReplayTemplate(terminal!.id)).toBeUndefined()
  })

  it('does not let an in-flight upload repopulate replay after an explicit clear', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { logPayloads: true })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const rawLogs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        id: 'chatcmpl-replay-generation',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      onLog: (log) => rawLogs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    const completedId = rawLogs.find((log) => log.status === 'success')?.id
    expect(completedId).toBeDefined()
    expect(gateway.getRequestReplayTemplate(completedId!)).toBeDefined()

    const paused = beginPausedPost(port)
    await vi.waitFor(() => expect(rawLogs.filter((log) => (
      log.status === 'streaming'
        && log.progressStage === 'receiving-body'
        && log.id !== completedId
    ))).toHaveLength(1))
    const inFlightId = rawLogs.find((log) => (
      log.status === 'streaming'
        && log.progressStage === 'receiving-body'
        && log.id !== completedId
    ))!.id

    gateway.clearRequestReplays()
    expect(gateway.getRequestReplayTemplate(completedId!)).toBeUndefined()
    paused.finish()
    expect((await paused.result).statusCode).toBe(200)
    expect(gateway.getRequestReplayTemplate(inFlightId)).toBeUndefined()
  })

  it('honors replay disable when callers mutate and resubmit the same config object', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { logPayloads: true })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const rawLogs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        id: 'chatcmpl-replay-same-config',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      onLog: (log) => rawLogs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(200)
    const completedId = rawLogs.find((log) => log.status === 'success')?.id
    expect(completedId).toBeDefined()
    expect(gateway.getRequestReplayTemplate(completedId!)).toBeDefined()

    const paused = beginPausedPost(port)
    await vi.waitFor(() => expect(rawLogs.filter((log) => (
      log.status === 'streaming'
        && log.progressStage === 'receiving-body'
        && log.id !== completedId
    ))).toHaveLength(1))
    const inFlightId = rawLogs.find((log) => (
      log.status === 'streaming'
        && log.progressStage === 'receiving-body'
        && log.id !== completedId
    ))!.id

    gatewayConfig.settings.logPayloads = false
    gateway.updateConfig(gatewayConfig)
    expect(gateway.getRequestReplayTemplate(completedId!)).toBeUndefined()
    paused.finish()
    expect((await paused.result).statusCode).toBe(200)
    expect(gateway.getRequestReplayTemplate(inFlightId)).toBeUndefined()
  })

  it('pins high-concurrency mode after authentication when the same route object is mutated', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { logPayloads: true })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.routes[0].highConcurrencyMode = false
    const rawLogs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        id: 'chatcmpl-mode-snapshot',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      onLog: (log) => rawLogs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const paused = beginPausedPost(port)
    await vi.waitFor(() => expect(rawLogs.filter((log) => (
      log.status === 'streaming' && log.progressStage === 'receiving-body'
    ))).toHaveLength(1))
    const authenticatedRequestId = rawLogs.find((log) => (
      log.status === 'streaming' && log.progressStage === 'receiving-body'
    ))!.id

    gatewayConfig.routes[0].highConcurrencyMode = true
    gateway.updateConfig(gatewayConfig)
    paused.finish()
    expect((await paused.result).statusCode).toBe(200)
    expect(gateway.getRequestReplayTemplate(authenticatedRequestId)).toBeDefined()

    const nextLogOffset = rawLogs.length
    expect((await post(port)).status).toBe(200)
    const nextRequestId = rawLogs.slice(nextLogOffset).find((log) => (
      log.progressStage === 'receiving-body'
    ))?.id
    expect(nextRequestId).toBeDefined()
    expect(gateway.getRequestReplayTemplate(nextRequestId!)).toBeUndefined()
  })

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

  it('coalesces first-byte progress and never emits streaming after the terminal log', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const encoder = new TextEncoder()
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const rawLogs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstreamController = controller }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => rawLogs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const responsePending = post(port, 'local-secret', { stream: true })
    await vi.waitFor(() => expect(upstreamController).toBeDefined())
    upstreamController?.enqueue(encoder.encode(
      'data: {"id":"chat-progress","model":"source-model","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n\n'
    ))
    const response = await responsePending
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Upstream-first-byte, semantic-first-token and client-first-write all
    // happen on the same frame, but observability publishes one merged update.
    expect(rawLogs.filter((log) => log.status === 'streaming' && log.progressStage === 'streaming')).toHaveLength(1)

    upstreamController?.enqueue(encoder.encode(
      'data: {"id":"chat-progress","model":"source-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ))
    upstreamController?.close()
    await response.text()
    await new Promise<void>((resolve) => setImmediate(resolve))

    const terminalIndex = rawLogs.findIndex((log) => log.status !== 'streaming')
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(rawLogs.slice(terminalIndex + 1).some((log) => log.status === 'streaming')).toBe(false)
  })

  it('keeps terminal data while high-concurrency mode skips replay, title lookup, hedging, and noisy progress', async () => {
    const {
      gateway, rawLogs, runtimeAccountUpdates, status, titleResolver, upstreamFetch, wire
    } = await runConcurrencyModeRequest(true)
    const terminal = rawLogs.find((log) => log.status === 'success')

    expect(status).toBe(200)
    expect(wire).toContain('Mode output')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(titleResolver).not.toHaveBeenCalled()
    expect(terminal).toMatchObject({
      id: rawLogs[0].id,
      status: 'success',
      statusCode: 200,
      accountId: 'first',
      providerName: 'Provider',
      model: 'source-model',
      conversationId: 'concurrency-session',
      conversationName: '对话 concurrency-session',
      inputTokens: 11,
      outputTokens: 4,
      failoverCount: 0
    })
    expect(terminal?.streamedBytes).toBeGreaterThan(0)
    expect(terminal?.streamedChunks).toBe(2)
    expect(terminal?.bodyReadMs).toEqual(expect.any(Number))
    expect(terminal?.schedulerSelectMs).toEqual(expect.any(Number))
    expect(terminal?.credentialResolveMs).toEqual(expect.any(Number))
    expect(terminal?.upstreamHeadersMs).toEqual(expect.any(Number))
    expect(gateway.getRequestReplayTemplate(rawLogs[0].id)).toBeUndefined()
    expect(gateway.getAccountInFlight().first).toBe(0)
    // Acquisition chatter is paused, but the release delta is retained so a
    // renderer can never be left displaying a stale in-flight count.
    expect(runtimeAccountUpdates).toEqual([['first']])

    expect(rawLogs.map((log) => [log.status, log.progressStage])).toEqual([
      ['streaming', 'receiving-body'],
      ['streaming', 'streaming'],
      ['success', undefined]
    ])
  })

  it('retains replay, title lookup, hedging, and detailed progress when high-concurrency mode is off', async () => {
    const { gateway, rawLogs, status, titleResolver, upstreamFetch, wire } = await runConcurrencyModeRequest(false)
    const terminal = rawLogs.find((log) => log.status === 'success')
    const progressStages = rawLogs
      .filter((log) => log.status === 'streaming')
      .map((log) => log.progressStage)

    expect(status).toBe(200)
    expect(wire).toContain('Mode output')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(titleResolver).toHaveBeenCalledOnce()
    expect(titleResolver).toHaveBeenCalledWith('concurrency-session')
    expect(progressStages).toContain('connecting')
    expect(progressStages).toContain('streaming')
    expect(terminal).toMatchObject({
      id: rawLogs[0].id,
      status: 'success',
      statusCode: 200,
      accountId: 'first',
      model: 'source-model',
      conversationId: 'concurrency-session',
      conversationName: 'Resolved concurrency title',
      inputTokens: 11,
      outputTokens: 4
    })
    expect(gateway.getRequestReplayTemplate(rawLogs[0].id)).toMatchObject({
      path: '/v1/chat/completions',
      body: {
        model: 'source-model',
        messages: [{ role: 'user', content: '[CONTENT REDACTED]' }],
        metadata: { session_id: 'concurrency-session' },
        stream: true
      },
      contentRedacted: true
    })
  })

  it('waits for non-streaming backpressure and distinguishes finish from close', async () => {
    const port = await freePort()
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn() as typeof fetch
    })
    class ControlledResponse extends EventEmitter {
      writableFinished = false
      writableEnded = false
      destroyed = false
      headersSent = false
      statusCode = 0
      blockWrite = true
      writableLength = 1_024
      socket = { bytesWritten: 0 }
      setHeader(): void {}
      write(): boolean { return !this.blockWrite }
      end(): void { this.writableEnded = true }
      destroy(): void {
        this.destroyed = true
        this.emit('close')
      }
    }
    const writeJson = (gateway as unknown as {
      writeJson(response: unknown, statusCode: number, payload: Record<string, unknown>): Promise<boolean>
    }).writeJson.bind(gateway)

    const finishedResponse = new ControlledResponse()
    let settled = false
    const finishedWrite = writeJson(finishedResponse, 200, { ok: true }).then((result) => {
      settled = true
      return result
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finishedResponse.emit('drain')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finishedResponse.writableEnded).toBe(true)
    expect(settled).toBe(false)
    finishedResponse.writableFinished = true
    finishedResponse.emit('finish')
    expect(await finishedWrite).toBe(true)

    const closedResponse = new ControlledResponse()
    closedResponse.blockWrite = false
    const closedWrite = writeJson(closedResponse, 200, { ok: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closedResponse.writableEnded).toBe(true)
    closedResponse.destroyed = true
    closedResponse.emit('close')
    expect(await closedWrite).toBe(false)

    vi.useFakeTimers()
    try {
      const progressingResponse = new ControlledResponse()
      let progressingSettled = false
      const progressingWrite = writeJson(progressingResponse, 200, { ok: true }).then((result) => {
        progressingSettled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(9_000)
      progressingResponse.socket.bytesWritten += 1
      progressingResponse.writableLength = 512
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(progressingSettled).toBe(false)
      progressingResponse.writableFinished = true
      progressingResponse.emit('finish')
      expect(await progressingWrite).toBe(true)

      const stalledResponse = new ControlledResponse()
      const stalledWrite = writeJson(stalledResponse, 200, { ok: true })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await stalledWrite).toBe(false)
      expect(stalledResponse.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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

  it('emits live lifecycle updates and completes the same id without logging payloads or credentials', async () => {
    const port = await freePort()
    const events: RequestLog[] = []
    let resolveUpstream!: (response: Response) => void
    const upstreamResponse = new Promise<Response>((resolve) => { resolveUpstream = resolve })
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential-private-marker',
      fetchImplementation: vi.fn(() => upstreamResponse) as typeof fetch,
      onLog: (log) => events.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const pendingResponse = post(port, 'local-secret', { messages: [{ role: 'user', content: 'payload-private-marker' }] })
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1))
    expect(events[0]).toMatchObject({
      status: 'streaming',
      providerName: '等待选择',
      accountName: '等待选择',
      model: ''
    })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({
      status: 'streaming',
      progressStage: 'connecting',
      accountId: 'first',
      model: 'source-model'
    }))
    expect(JSON.stringify(events)).not.toMatch(/payload-private-marker|credential-private-marker|local-secret/)

    resolveUpstream(new Response(JSON.stringify({
      id: 'completed-lifecycle', model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const response = await pendingResponse
    expect(response.status).toBe(200)
    await response.text()
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('success'))
    expect(events.at(-1)).toMatchObject({ id: events[0].id, status: 'success', statusCode: 200, accountId: 'first' })
  })

  it('completes pre-account failures with the same id and a scheduler stage', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts.forEach((candidate) => { candidate.status = 'disabled' })
    const events: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'unused',
      fetchImplementation: vi.fn() as typeof fetch,
      onLog: (log) => events.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(503)
    await response.text()
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('error'))
    expect(events.at(-1)).toMatchObject({
      id: events[0].id,
      statusCode: 503,
      failureStage: 'scheduler',
      accountId: undefined,
      providerName: '等待选择',
      accountName: '等待选择'
    })
  })

  it('records malformed bodies and unreachable upstreams at their actual failure stages', async () => {
    const bodyPort = await freePort()
    const bodyEvents: RequestLog[] = []
    const bodyGateway = new GatewayServer({
      config: config(bodyPort), credentialResolver: () => 'unused', fetchImplementation: vi.fn() as typeof fetch,
      onLog: (log) => bodyEvents.push(log)
    })
    runningServers.push(bodyGateway)
    await bodyGateway.start()
    const malformed = await fetch(`http://127.0.0.1:${bodyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: '{invalid'
    })
    expect(malformed.status).toBe(400)
    await malformed.text()
    await vi.waitFor(() => expect(bodyEvents.at(-1)?.status).toBe('error'))
    expect(bodyEvents.at(-1)).toMatchObject({ id: bodyEvents[0].id, failureStage: 'body', statusCode: 400 })

    const connectPort = await freePort()
    const connectConfig = config(connectPort)
    connectConfig.accounts[1].status = 'disabled'
    connectConfig.pools[0].maxRetries = 0
    const connectEvents: RequestLog[] = []
    const connectGateway = new GatewayServer({
      config: connectConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => { throw new TypeError('connect ECONNREFUSED') }) as typeof fetch,
      onLog: (log) => connectEvents.push(log)
    })
    runningServers.push(connectGateway)
    await connectGateway.start()
    const unreachable = await post(connectPort)
    expect(unreachable.status).toBe(502)
    await unreachable.text()
    await vi.waitFor(() => expect(connectEvents.at(-1)?.status).toBe('error'))
    expect(connectEvents.at(-1)).toMatchObject({
      id: connectEvents[0].id,
      failureStage: 'connect',
      statusCode: 502,
      accountId: 'first'
    })
  })

  it('returns 413 instead of misclassifying an oversized request as a client 499', async () => {
    const port = await freePort()
    const events: RequestLog[] = []
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'unused',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => events.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', messages: [], padding: 'x'.repeat(10 * 1024 * 1024) })
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { message: 'Request body exceeds 10 MiB' } })
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('error'))
    expect(events.at(-1)).toMatchObject({ failureStage: 'body', statusCode: 413 })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns 413 immediately when an unfinished chunked body crosses its limit', async () => {
    const port = await freePort()
    const events: RequestLog[] = []
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'unused',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(events, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const result = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = createHttpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json',
          'transfer-encoding': 'chunked'
        }
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          request.destroy()
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      })
      request.on('error', reject)
      const chunk = Buffer.alloc(1024 * 1024, 0x78)
      for (let index = 0; index < 11; index += 1) request.write(chunk)
      // Deliberately do not end: the gateway must reject at the byte boundary,
      // rather than waiting forever for a malicious or stalled sender.
    })

    expect(result.statusCode).toBe(413)
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: 'Request body exceeds 10 MiB' } })
    expect(events[0]).toMatchObject({ status: 'error', statusCode: 413, failureStage: 'body' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('transparently accepts large Codex response and compact bodies without widening search', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    gatewayConfig.accounts[1].status = 'disabled'
    const capturedBodies: Array<Record<string, unknown>> = []
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (String(input).endsWith('/responses/compact')) {
        return new Response(JSON.stringify({
          output: [{ type: 'compaction', encrypted_content: 'enc_large_compact' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // A hedge would fire at 250 ms. Large bodies deliberately use one upload.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return new Response([
        'data: {"type":"response.completed","response":{"id":"resp_large","object":"response","model":"source-model","status":"completed","output":[]}}',
        '', ''
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const largeText = `large-start:${'x'.repeat(10 * 1024 * 1024)}:large-end`
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ role: 'user', content: [{ type: 'input_text', text: largeText }] }],
        stream: true
      })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('response.completed')
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    const responseText = (((capturedBodies[0].input as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>)[0].text)
    expect(responseText).toBe(largeText)

    const compact = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ role: 'user', content: [{ type: 'input_text', text: largeText }] }]
      })
    })
    expect(compact.status).toBe(200)
    expect(await compact.json()).toMatchObject({
      output: [{ type: 'compaction', encrypted_content: 'enc_large_compact' }]
    })
    const compactText = (((capturedBodies[1].input as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>)[0].text)
    expect(compactText).toBe(largeText)

    const search = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', id: 'search-large', query: largeText })
    })
    expect(search.status).toBe(413)
    expect(await search.json()).toMatchObject({ error: { message: 'Request body exceeds 10 MiB' } })
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  }, 20_000)

  it('rejects a declared body above the Codex hard limit without waiting for its upload', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const events: RequestLog[] = []
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'unused',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(events, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const result = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = createHttpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json',
          'content-length': 64 * 1024 * 1024 + 1
        }
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          request.destroy()
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      })
      request.on('error', reject)
      request.flushHeaders()
    })

    expect(result.statusCode).toBe(413)
    expect(JSON.parse(result.body)).toMatchObject({ error: { message: 'Request body exceeds 64 MiB' } })
    expect(events[0]).toMatchObject({ status: 'error', statusCode: 413, failureStage: 'body' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('gives a slow chunked large body a fresh upstream response deadline', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[1].status = 'disabled'
    let now = timestamp
    const events: RequestLog[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({
          id: 'resp_after_slow_upload',
          object: 'response',
          model: 'source-model',
          status: 'completed',
          output: []
        }), { status: 200, headers: { 'content-type': 'application/json' } })), 25)
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        }, { once: true })
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(events, log),
      now: () => now
    })
    runningServers.push(gateway)
    await gateway.start()

    const wireBody = JSON.stringify({
      model: 'source-model',
      input: `chunked-start:${'y'.repeat(10 * 1024 * 1024)}:chunked-end`,
      stream: false
    })
    const splitAt = Math.floor(wireBody.length / 2)
    let chunkedRequest: ReturnType<typeof createHttpRequest>
    const resultPromise = new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      chunkedRequest = createHttpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json'
        }
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      })
      chunkedRequest.on('error', reject)
    })
    chunkedRequest!.write(wireBody.slice(0, splitAt))
    await vi.waitFor(() => expect(events[0]).toMatchObject({
      status: 'streaming',
      progressStage: 'receiving-body'
    }))
    now += 1_500
    chunkedRequest!.end(wireBody.slice(splitAt))
    const result = await resultPromise

    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ id: 'resp_after_slow_upload' })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(events[0]).toMatchObject({ status: 'success', statusCode: 200, bodyReadMs: 1_500 })
  })

  it('expires a half-written local request body instead of leaving a live log forever', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    const events: RequestLog[] = []
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'unused',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(events, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    let request!: ReturnType<typeof createHttpRequest>
    const result = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      let settled = false
      request = createHttpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer local-secret',
          'content-type': 'application/json',
          'content-length': 256
        }
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          settled = true
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      })
      request.on('error', (error) => {
        if (!settled) reject(error)
      })
      request.write('{"model":"source-model"')
    })
    request.destroy()

    expect(result.statusCode).toBe(408)
    expect(JSON.parse(result.body)).toMatchObject({ error: { type: 'request_body_timeout' } })
    expect(events[0]).toMatchObject({ status: 'error', statusCode: 408, failureStage: 'body' })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(upstreamFetch).not.toHaveBeenCalled()
  }, 5_000)

  it('queues unknown-length large bodies without delaying ordinary Codex requests', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[0].maxConcurrency = 3
    gatewayConfig.accounts[1].status = 'disabled'
    const events: RequestLog[] = []
    let releaseFirst!: () => void
    const firstUpstreamGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const upstreamBody = JSON.parse(String(init?.body)) as { input?: string }
      if (upstreamBody.input?.startsWith('large-one:')) await firstUpstreamGate
      return new Response(JSON.stringify({
        id: `resp_${upstreamBody.input?.slice(0, 12) ?? 'unknown'}`,
        object: 'response',
        model: 'source-model',
        status: 'completed',
        output: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(events, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const sendChunked = (
      input: string,
      onRequest?: (request: ReturnType<typeof createHttpRequest>) => void
    ): Promise<{ statusCode?: number; body: string }> => {
      const wireBody = JSON.stringify({ model: 'source-model', input, stream: false })
      return new Promise((resolve, reject) => {
        const request = createHttpRequest({
          host: '127.0.0.1',
          port,
          path: '/v1/responses',
          method: 'POST',
          headers: {
            authorization: 'Bearer local-secret',
            'content-type': 'application/json',
            'transfer-encoding': 'chunked'
          }
        }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          }))
        })
        request.on('error', reject)
        onRequest?.(request)
        request.write(wireBody)
        request.end()
      })
    }

    const first = sendChunked(`large-one:${'a'.repeat(10 * 1024 * 1024)}`)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1))
    const second = sendChunked(`large-two:${'b'.repeat(10 * 1024 * 1024)}`)
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(2))
    expect(upstreamFetch).toHaveBeenCalledTimes(1)

    let cancelledRequest: ReturnType<typeof createHttpRequest> | undefined
    const cancelled = sendChunked(
      `large-cancel:${'c'.repeat(10 * 1024 * 1024)}`,
      (request) => { cancelledRequest = request }
    ).catch((error: unknown) => error)
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(3))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    cancelledRequest?.destroy(new Error('test client cancellation'))
    await cancelled
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(2))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'error', statusCode: 499, failureStage: 'client' })
    ]))

    const small = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'small-bypass', stream: false })
    })
    expect(small.status).toBe(200)
    await small.text()
    expect(upstreamFetch).toHaveBeenCalledTimes(2)

    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.statusCode).toBe(200)
    expect(secondResult.statusCode).toBe(200)
    expect(JSON.parse(firstResult.body)).toMatchObject({ status: 'completed' })
    expect(JSON.parse(secondResult.body)).toMatchObject({ status: 'completed' })
    expect(upstreamFetch).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => {
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(gateway.getAccountInFlight().first).toBe(0)
    })
  }, 20_000)

  it('releases an unknown-length large-body permit when a valid stream commits', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[0].maxConcurrency = 2
    gatewayConfig.accounts[1].status = 'disabled'
    const encoder = new TextEncoder()
    let firstController: ReadableStreamDefaultController<Uint8Array> | undefined
    const firstDelta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A","sequence_number":1}\n\n'
    const completed = 'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"id":"resp-large","object":"response","status":"completed","model":"source-model","output":[]}}\n\n'
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { firstController = controller }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(`${firstDelta}${completed}`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const sendChunkedStream = (input: string): {
      headers: Promise<number | undefined>
      done: Promise<string>
    } => {
      const wireBody = JSON.stringify({ model: 'source-model', input, stream: true })
      let resolveHeaders!: (statusCode: number | undefined) => void
      const headers = new Promise<number | undefined>((resolve) => { resolveHeaders = resolve })
      const done = new Promise<string>((resolve, reject) => {
        const request = createHttpRequest({
          host: '127.0.0.1',
          port,
          path: '/v1/responses',
          method: 'POST',
          headers: {
            authorization: 'Bearer local-secret',
            'content-type': 'application/json',
            'transfer-encoding': 'chunked'
          }
        }, (response) => {
          resolveHeaders(response.statusCode)
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        request.on('error', reject)
        request.end(wireBody)
      })
      return { headers, done }
    }

    const first = sendChunkedStream(`large-first:${'a'.repeat(10 * 1024 * 1024)}`)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    const second = sendChunkedStream(`large-second:${'b'.repeat(10 * 1024 * 1024)}`)
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(2))
    expect(upstreamFetch).toHaveBeenCalledOnce()

    // A recognized frame commits the first stream but deliberately leaves it
    // running. The second large upload must acquire the parsing budget now,
    // rather than waiting for the first generation's terminal event.
    firstController?.enqueue(encoder.encode(firstDelta))
    await expect(first.headers).resolves.toBe(200)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2))
    await expect(second.headers).resolves.toBe(200)
    await expect(second.done).resolves.toContain('response.completed')

    firstController?.enqueue(encoder.encode(completed))
    firstController?.close()
    await expect(first.done).resolves.toContain('response.completed')
  }, 20_000)

  it('releases large-body permits before every validated buffered response write', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[1].status = 'disabled'
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const upstreamBody = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> }
      if (Array.isArray(upstreamBody.input)
        && upstreamBody.input.some((item) => item.type === 'compaction_trigger')) {
        return new Response([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_release","type":"compaction","encrypted_content":"encrypted-release"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_compact_release","model":"source-model","status":"completed","output":[]}}',
          '',
          ''
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (String(_input).endsWith('/responses/compact')) {
        return new Response(JSON.stringify({
          output: [{ type: 'compaction', encrypted_content: 'legacy-release' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: 'resp_buffered_release',
        object: 'response',
        model: 'source-model',
        status: 'completed',
        output: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)

    type BufferedWriteGateway = {
      largeRequestBodies: {
        acquire(byteLength: number, signal: AbortSignal): Promise<() => void>
      }
      writeJson(
        response: unknown,
        statusCode: number,
        payload: Record<string, unknown>,
        onClientWrite?: () => void
      ): Promise<boolean>
      writeJsonBytes(
        response: unknown,
        statusCode: number,
        body: Uint8Array,
        onClientWrite?: () => void
      ): Promise<boolean>
    }
    const internal = gateway as unknown as BufferedWriteGateway
    const permitReleases: Array<ReturnType<typeof vi.fn>> = []
    vi.spyOn(internal.largeRequestBodies, 'acquire').mockImplementation(async () => {
      const release = vi.fn()
      permitReleases.push(release)
      return release
    })
    const originalWriteJson = internal.writeJson.bind(internal)
    vi.spyOn(internal, 'writeJson').mockImplementation(async (...args) => {
      if (args[1] === 200) expect(permitReleases.at(-1)).toHaveBeenCalledOnce()
      return originalWriteJson(...args)
    })
    const originalWriteJsonBytes = internal.writeJsonBytes.bind(internal)
    vi.spyOn(internal, 'writeJsonBytes').mockImplementation(async (...args) => {
      if (args[1] === 200) expect(permitReleases.at(-1)).toHaveBeenCalledOnce()
      return originalWriteJsonBytes(...args)
    })
    const originalFlushHeaders = ServerResponse.prototype.flushHeaders
    const flushHeaders = vi.spyOn(ServerResponse.prototype, 'flushHeaders').mockImplementation(function(
      this: ServerResponse
    ) {
      expect(permitReleases.at(-1)).toHaveBeenCalledOnce()
      return originalFlushHeaders.call(this)
    })
    await gateway.start()

    const largePadding = 'p'.repeat(10 * 1024 * 1024)
    try {
      const buffered = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'source-model', input: largePadding, stream: false })
      })
      expect(buffered.status).toBe(200)
      await buffered.text()

      const compact = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'source-model',
          input: [{ role: 'user', content: [{ type: 'input_text', text: largePadding }] }]
        })
      })
      expect(compact.status).toBe(200)
      await compact.text()

      const compactV2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'source-model',
          input: [
            { role: 'user', content: [{ type: 'input_text', text: largePadding }] },
            { type: 'compaction_trigger' }
          ],
          stream: true
        })
      })
      expect(compactV2.status).toBe(200)
      await compactV2.text()
    } finally {
      flushHeaders.mockRestore()
    }

    expect(permitReleases).toHaveLength(3)
    expect(permitReleases.every((release) => release.mock.calls.length === 1)).toBe(true)
  }, 30_000)

  it('releases a large-body permit before writing a terminal non-retryable error', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 3
    gatewayConfig.accounts[1].status = 'disabled'
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-key',
      fetchImplementation: vi.fn(async () => new Response(
        JSON.stringify({ error: { message: 'terminal bad request' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
    })
    runningServers.push(gateway)
    type ErrorWriteGateway = {
      largeRequestBodies: {
        acquire(byteLength: number, signal: AbortSignal): Promise<() => void>
      }
      writeJson(
        response: unknown,
        statusCode: number,
        payload: Record<string, unknown>,
        onClientWrite?: () => void
      ): Promise<boolean>
    }
    const internal = gateway as unknown as ErrorWriteGateway
    const releasePermit = vi.fn()
    vi.spyOn(internal.largeRequestBodies, 'acquire').mockResolvedValue(releasePermit)
    const originalWriteJson = internal.writeJson.bind(internal)
    vi.spyOn(internal, 'writeJson').mockImplementation(async (...args) => {
      if (args[1] === 400) expect(releasePermit).toHaveBeenCalledOnce()
      return originalWriteJson(...args)
    })
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'e'.repeat(10 * 1024 * 1024), stream: false })
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { message: 'terminal bad request' } })
    expect(releasePermit).toHaveBeenCalledOnce()
  }, 20_000)

  it('finishes a first-body timeout instead of leaving its pending log streaming', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.pools[0].firstBodyTimeoutMs = 1_000
    const events: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined)
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
      onLog: (log) => events.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(504)
    await response.text()
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('error'))
    expect(events.at(-1)).toMatchObject({
      id: events[0].id,
      statusCode: 504,
      failureStage: 'first-byte'
    })
  }, 5_000)

  it.each(['credential', 'fetch', 'response-body'] as const)(
    'enforces the response-start deadline when a non-cooperative %s promise ignores abort',
    async (stage) => {
      const port = await freePort()
      const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
      gatewayConfig.accounts[1].status = 'disabled'
      gatewayConfig.pools[0].maxRetries = 0
      const events: RequestLog[] = []
      const never = () => new Promise<never>(() => undefined)
      const gateway = new GatewayServer({
        config: gatewayConfig,
        credentialResolver: stage === 'credential' ? never : () => 'credential',
        fetchImplementation: (stage === 'fetch'
          ? vi.fn(never)
          : stage === 'response-body'
            ? vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull: never }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              }))
            : vi.fn(async () => new Response('{}', { status: 200 }))) as typeof fetch,
        onLog: (log) => upsertLog(events, log)
      })
      runningServers.push(gateway)
      await gateway.start()

      const response = await post(port)
      expect(response.status).toBe(504)
      await response.text()
      await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(0))
      expect(events[0]).toMatchObject({ status: 'error', statusCode: 504 })
    },
    // The response deadline itself is one second. Leave enough room for the
    // non-cooperative body case plus forced server/socket cleanup when the
    // full gateway suite is running under load.
    10_000
  )

  it('actively cancels a non-streaming upstream JSON reader when its request signal aborts', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    let cancelled = false
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel() { cancelled = true }
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(504)
    await response.text()
    await vi.waitFor(() => expect(cancelled).toBe(true))
    expect(gateway.getStatus().activeRequests).toBe(0)
  }, 5_000)

  it('leaves first-token timing empty for buffered non-streaming responses', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        id: 'buffered-completion',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(200)
    await response.text()
    expect(logs[0]).toMatchObject({
      status: 'success',
      requestKind: 'generation',
      firstTokenMs: undefined,
      accountFirstTokenMs: undefined
    })
  })

  it('does not reset the response-start deadline across retries', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.pools[0].maxRetries = 5
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const startedAt = Date.now()
    const response = await post(port)
    expect(response.status).toBe(504)
    await response.text()
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  }, 5_000)

  it('forces the OpenAI Chat priority service tier when FAST is enabled', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].forceFastMode = true
    gatewayConfig.accounts[1].status = 'disabled'
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chat-fast',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Fast' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { service_tier: 'default' })
    expect(response.status).toBe(200)
    await response.text()
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body)))
      .toMatchObject({ service_tier: 'priority' })
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

  it.each([502, 504])('evicts a failed sticky assignment after upstream HTTP %s', async (failureStatus) => {
    const port = await freePort()
    let now = timestamp
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
    gatewayConfig.pools[0].maxRetries = 0
    const selectedAccountIds: string[] = []
    const successful = () => new Response(JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => successful())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
        status: failureStatus,
        headers: { 'content-type': 'application/json' }
      }))
      .mockImplementation(async () => successful())
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => now
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await postSession(port, 'failed-thread')).status).toBe(200)
    expect((await postSession(port, 'failed-thread')).status).toBe(failureStatus)
    now += 31_000
    expect((await postSession(port, 'failed-thread')).status).toBe(200)
    expect((await postSession(port, 'new-thread')).status).toBe(200)

    expect(selectedAccountIds).toEqual(['first', 'first', 'second', 'first'])
  })

  it('evicts a sticky assignment after the upstream transport is unreachable', async () => {
    const port = await freePort()
    let now = timestamp
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
    gatewayConfig.pools[0].maxRetries = 0
    const selectedAccountIds: string[] = []
    const successful = () => new Response(JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => successful())
      .mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'))
      .mockImplementation(async () => successful())
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => now
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await postSession(port, 'network-thread')).status).toBe(200)
    expect((await postSession(port, 'network-thread')).status).toBe(502)
    now += 31_000
    expect((await postSession(port, 'network-thread')).status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'first', 'second'])
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

  it('retains Agent Identity as non-sensitive request-log metadata', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      name: 'ChatGPT OAuth',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      credentialType: 'chatgpt-agent-identity',
      chatgptAccountId: 'acct-agent'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    const logs: RequestLog[] = []
    const stream = [
      'data: {"type":"response.created","response":{"id":"resp_agent","model":"gpt-5.1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_agent","model":"gpt-5.1","status":"completed","output":[]}}\n\n'
    ].join('')
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'AgentAssertion test-private',
        kind: 'chatgpt-agent-identity',
        accountId: 'acct-agent'
      }),
      fetchImplementation: vi.fn(async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })) as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.1', input: 'Hello', stream: true })
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('response.completed')
    expect(logs.find((log) => log.status === 'success')).toMatchObject({
      credentialType: 'chatgpt-agent-identity',
      providerName: 'ChatGPT OAuth'
    })
  })

  it('proxies legacy compact requests to the native ChatGPT endpoint without changing the history', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'oauth-system',
      kind: 'openai',
      protocol: 'openai-responses',
      responsesCompactMode: 'legacy'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      credentialType: 'chatgpt-oauth',
      chatgptAccountId: 'acct-compact'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const nativeOutput = [{ type: 'compaction', encrypted_content: 'enc_native_compact' }]
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ output: nativeOutput }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-codex-turn-state': 'turn-state-after-compact'
      }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-compact-private', kind: 'chatgpt-oauth', accountId: 'acct-compact' }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'Keep this history exactly.' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'tool output' }
    ]
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'compact-session',
        'x-codex-turn-state': 'turn-state-before-compact'
      },
      body: JSON.stringify({
        model: 'source-model',
        input,
        instructions: 'Original instructions',
        tools: [{ type: 'function', name: 'test_tool' }],
        parallel_tool_calls: true
      })
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-codex-turn-state')).toBe('turn-state-after-compact')
    expect(await response.json()).toEqual({ output: nativeOutput })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses/compact')
    const request = upstreamFetch.mock.calls[0][1]!
    expect(new Headers(request.headers).get('accept')).toBe('application/json')
    expect(new Headers(request.headers).get('x-codex-turn-state')).toBe('turn-state-before-compact')
    expect(JSON.parse(String(request.body))).toEqual({
      model: 'source-model',
      input,
      instructions: 'Original instructions',
      tools: [{ type: 'function', name: 'test_tool' }],
      parallel_tool_calls: true
    })
    expect(logs[0]).toMatchObject({
      status: 'success',
      statusCode: 200,
      conversationId: 'compact-session',
      requestKind: 'compaction',
      firstTokenMs: undefined,
      accountFirstTokenMs: undefined
    })
  })

  it('forwards compact state headers through a native official API source', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'official-api',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      responsesCompactMode: 'legacy'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'enc_api_compact' }]
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-codex-turn-state': 'api-turn-after' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'official-api-private-key',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'api-compact-session',
        'thread-id': 'api-compact-thread',
        'x-codex-turn-state': 'api-turn-before',
        'x-codex-turn-metadata': 'api-turn-metadata',
        'x-codex-installation-id': 'api-installation'
      },
      body: JSON.stringify({ model: 'source-model', input: [{ role: 'user', content: [] }] })
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-codex-turn-state')).toBe('api-turn-after')
    await response.text()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses/compact')
    const headers = new Headers(upstreamFetch.mock.calls[0][1]?.headers)
    expect(headers.get('session-id')).toBe('api-compact-session')
    expect(headers.get('thread-id')).toBe('api-compact-thread')
    expect(headers.get('x-codex-turn-state')).toBe('api-turn-before')
    expect(headers.get('x-codex-turn-metadata')).toBe('api-turn-metadata')
    expect(headers.get('x-codex-installation-id')).toBe('api-installation')
  })

  it('adapts legacy compact requests for relay sources through an ordinary Responses summary', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'resp_compact_fallback',
      object: 'response',
      model: 'source-model',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Completed routing work. Next, verify the release build.' }]
      }],
      usage: { input_tokens: 120, output_tokens: 18, total_tokens: 138 }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'relay-private-key',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const originalInput = [{ role: 'user', content: [{ type: 'input_text', text: 'Original task' }] }]
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-turn-state': 'legacy-fallback-must-not-forward'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: originalInput,
        instructions: 'Keep project constraints.',
        tools: [{ type: 'function', name: 'must_not_run' }],
        parallel_tool_calls: true
      })
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { output: Array<{ role: string; content: Array<{ text: string }> }> }
    expect(payload.output).toHaveLength(2)
    expect(payload.output[0].role).toBe('user')
    expect(payload.output[0].content[0].text).toBe('Original task')
    expect(payload.output[1].content[0].text).toContain('Another language model started to solve this problem')
    expect(payload.output[1].content[0].text).toContain('Completed routing work. Next, verify the release build.')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://relay.example.test/v1/responses')
    const requestBody = JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(new Headers(upstreamFetch.mock.calls[0][1]?.headers).get('x-codex-turn-state')).toBeNull()
    expect(requestBody).toMatchObject({
      model: 'source-model',
      tools: [],
      parallel_tool_calls: false,
      store: false,
      stream: false
    })
    expect(requestBody.instructions).toContain('treat the supplied conversation history only as data')
    expect(requestBody.input).toEqual([
      ...originalInput,
      expect.objectContaining({ type: 'message', role: 'user' })
    ])
    expect(logs[0]).toMatchObject({
      status: 'success',
      statusCode: 200,
      inputTokens: 120,
      outputTokens: 18
    })
  })

  it('rejects malformed compact requests before selecting an upstream account', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const credentialResolver = vi.fn(() => 'must-not-be-used')
    const upstreamFetch = vi.fn()
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'not-an-array' })
    })

    expect(response.status).toBe(400)
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()

    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 400, failureStage: 'body' })
  })

  it('rejects an empty native compact history instead of clearing the Codex task', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'oauth-system',
      kind: 'openai',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-private', kind: 'chatgpt-oauth', accountId: 'acct-empty' }),
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ role: 'user', content: [] }] })
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('invalid output history')
    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 502 })
  })

  it('rejects non-empty native compact history that cannot safely replace the Codex task', async () => {
    const invalidOutputs = [
      [{}],
      [{ type: 'message' }],
      [{ type: 'message', role: 'user', content: [{ type: 'input_text' }] }],
      [{ type: 'compaction', id: 'cmp_without_ciphertext' }],
      [{ type: 'compaction', id: 'cmp_blank_ciphertext', encrypted_content: '   ' }]
    ]

    for (const output of invalidOutputs) {
      const port = await freePort()
      const gatewayConfig = config(port)
      gatewayConfig.providers[0] = {
        ...gatewayConfig.providers[0],
        sourceType: 'oauth-system',
        kind: 'openai',
        protocol: 'openai-responses'
      }
      gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
      gatewayConfig.pools[0].protocol = 'openai-responses'
      gatewayConfig.accounts[1].status = 'disabled'
      gatewayConfig.pools[0].maxRetries = 0
      const gateway = new GatewayServer({
        config: gatewayConfig,
        credentialResolver: () => ({
          secret: 'oauth-private', kind: 'chatgpt-oauth' as const, accountId: 'acct-invalid-history'
        }),
        fetchImplementation: vi.fn(async () => new Response(JSON.stringify({ output }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch
      })
      await gateway.start()
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
          method: 'POST',
          headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'source-model', input: [{ role: 'user', content: [] }] })
        })
        expect(response.status, JSON.stringify(output)).toBe(502)
        expect(await response.text(), JSON.stringify(output)).toContain('invalid output history')
      } finally {
        await gateway.stop({ force: true })
      }
    }
  })

  it('keeps ordinary Responses on relay while routing V2 compact and opaque follow-up history to native OAuth', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers = [
      {
        ...gatewayConfig.providers[0],
        id: 'relay-provider',
        sourceType: 'relay',
        kind: 'openai-compatible',
        baseUrl: 'https://relay.example.test/v1',
        protocol: 'openai-responses'
      },
      {
        ...gatewayConfig.providers[0],
        id: 'native-provider',
        sourceType: 'oauth-system',
        kind: 'openai',
        protocol: 'openai-responses'
      }
    ]
    gatewayConfig.accounts = [
      { ...gatewayConfig.accounts[0], providerId: 'relay-provider', credentialType: 'api-key' },
      {
        ...gatewayConfig.accounts[1],
        providerId: 'native-provider',
        credentialType: 'chatgpt-oauth',
        chatgptAccountId: 'acct-native'
      }
    ]
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].members = gatewayConfig.accounts.map((item) => ({ accountId: item.id, enabled: true }))
    gatewayConfig.pools[0].maxRetries = 1
    gatewayConfig.pools[0].hedgedRequests = true
    const selectedAccountIds: string[] = []
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const requestBody = JSON.parse(String(init?.body)) as { input?: Array<Record<string, unknown>> }
      if (url.startsWith('https://relay.example.test/')) {
        return new Response([
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"ordinary relay response"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_ordinary","model":"source-model","status":"completed","output":[]}}',
          '',
          ''
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const lastInput = requestBody.input?.at(-1)
      if (lastInput?.type === 'compaction_trigger') {
        return new Response([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_v2","type":"compaction","encrypted_content":"encrypted-v2"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_compact_v2","model":"source-model","status":"completed","output":[],"usage":{"input_tokens":800,"output_tokens":20,"total_tokens":820}}}',
          '',
          ''
        ].join('\n'), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-turn-state': 'turn-state-v2',
            'x-request-id': 'request-v2'
          }
        })
      }
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"continued natively"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_followup","model":"source-model","status":"completed","output":[]}}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-turn-state': 'turn-state-followup',
          'x-codex-safety-buffering-enabled': 'true',
          'x-request-id': 'request-followup'
        }
      })
    })
    const credentialResolver = vi.fn((selected: Account) => {
      selectedAccountIds.push(selected.id)
      return selected.credentialType === 'chatgpt-oauth'
        ? { secret: 'oauth-native-private', kind: 'chatgpt-oauth' as const, accountId: 'acct-native' }
        : 'relay-private'
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const ordinary = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'ordinary-session'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordinary' }] }],
        stream: true
      })
    })
    expect(ordinary.status).toBe(200)
    expect(await ordinary.text()).toContain('ordinary relay response')

    const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'compact-v2-session',
        'x-codex-turn-state': 'turn-state-before-v2'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compact me' }] },
          { type: 'compaction_trigger' }
        ],
        stream: true
      })
    })
    expect(compact.status).toBe(200)
    expect(compact.headers.get('x-codex-turn-state')).toBe('turn-state-v2')
    expect(compact.headers.get('x-request-id')).toBe('request-v2')
    expect(await compact.text()).toContain('"type":"compaction"')

    const followup = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'compact-v2-session',
        'x-codex-turn-state': 'turn-state-v2'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-v2' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
        ],
        stream: true
      })
    })
    expect(followup.status).toBe(200)
    expect(followup.headers.get('x-codex-turn-state')).toBe('turn-state-followup')
    expect(followup.headers.get('x-codex-safety-buffering-enabled')).toBe('true')
    expect(followup.headers.get('x-request-id')).toBe('request-followup')
    expect(await followup.text()).toContain('continued natively')

    expect(selectedAccountIds).toEqual(['first', 'second', 'second'])
    expect(upstreamFetch).toHaveBeenCalledTimes(3)
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://relay.example.test/v1/responses')
    expect(upstreamFetch.mock.calls[1][0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(upstreamFetch.mock.calls[2][0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(new Headers(upstreamFetch.mock.calls[1][1]?.headers).get('x-codex-turn-state')).toBe('turn-state-before-v2')
    expect(new Headers(upstreamFetch.mock.calls[2][1]?.headers).get('x-codex-turn-state')).toBe('turn-state-v2')
  })

  it('rejects relay-only V2 compact before resolving credentials or sending an incompatible request', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts = gatewayConfig.accounts.map((item) => ({ ...item, credentialType: 'api-key' }))
    const credentialResolver = vi.fn(() => 'must-not-resolve')
    const upstreamFetch = vi.fn()
    const logs: RequestLog[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'compaction_trigger' }],
        stream: true
      })
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { type: 'remote_compaction_unsupported' } })
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 422, failureStage: 'scheduler' })

    const embeddedTrigger = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction_trigger' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'must not bypass' }] }
        ],
        stream: true
      })
    })
    expect(embeddedTrigger.status).toBe(422)
    expect(await embeddedTrigger.text()).toContain('disable remote_compaction_v2')
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects only genuinely opaque compact history on legacy relay sources', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      protocol: 'openai-responses',
      responsesCompactMode: 'legacy'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const upstreamFetch = vi.fn(async () => new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_plaintext_compact","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const credentialResolver = vi.fn(() => 'relay-private')
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const opaque = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'compaction', encrypted_content: 'encrypted-history' }],
        stream: true
      })
    })
    expect(opaque.status).toBe(422)
    const opaqueError = await opaque.text()
    expect(opaqueError).toContain('configured to pass through encrypted')
    expect(opaqueError).not.toContain('created it')
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()

    const standaloneOpaque = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'compaction', encrypted_content: 'encrypted-standalone-history' }]
      })
    })
    expect(standaloneOpaque.status).toBe(422)
    expect(await standaloneOpaque.text()).toContain('configured to pass through encrypted')
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()

    const plaintext = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction' },
          { type: 'compaction_summary', encrypted_content: '' },
          { type: 'context_compaction', encrypted_content: '   ' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
        ],
        stream: true
      })
    })
    expect(plaintext.status).toBe(200)
    expect(await plaintext.text()).toContain('resp_plaintext_compact')
    expect(credentialResolver).toHaveBeenCalledOnce()
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('allows opaque continuation but not compact creation on passthrough relay sources', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      protocol: 'openai-responses',
      responsesCompactMode: 'passthrough'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (requestBody.stream === false) {
        return new Response(JSON.stringify({
          id: 'resp_passthrough_fallback',
          status: 'completed',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Fallback summary for passthrough source.' }]
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"continued through relay"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_passthrough","status":"completed","output":[]}}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'relay-turn-after' }
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'relay-private',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const opaqueInput = [
      { type: 'compaction', encrypted_content: 'encrypted-passthrough' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ]
    const followup = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-turn-state': 'relay-turn-before'
      },
      body: JSON.stringify({ model: 'source-model', input: opaqueInput, stream: true })
    })
    expect(followup.status).toBe(200)
    expect(followup.headers.get('x-codex-turn-state')).toBe('relay-turn-after')
    expect(await followup.text()).toContain('continued through relay')
    expect(JSON.parse(String(upstreamFetch.mock.calls[0][1]?.body))).toMatchObject({ input: opaqueInput })
    expect(new Headers(upstreamFetch.mock.calls[0][1]?.headers).get('x-codex-turn-state')).toBe('relay-turn-before')

    const standalone = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-turn-state': 'passthrough-compact-before'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-passthrough-standalone' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compact' }] }
        ]
      })
    })
    expect(standalone.status).toBe(200)
    expect(await standalone.text()).toContain('Fallback summary for passthrough source.')
    expect(upstreamFetch.mock.calls[1][0]).toBe('https://relay.example.test/v1/responses')
    expect(new Headers(upstreamFetch.mock.calls[1][1]?.headers).get('x-codex-turn-state')).toBe('passthrough-compact-before')

    const createCompact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })
    expect(createCompact.status).toBe(422)
    expect(await createCompact.text()).toContain('native OpenAI Responses compact support')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('uses native compact creation and endpoint routing for upgraded relay sources', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://native-relay.example.test/v1',
      protocol: 'openai-responses',
      responsesCompactMode: 'native'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/responses/compact')) {
        return new Response(JSON.stringify({
          output: [{ type: 'compaction', encrypted_content: 'native-endpoint-encrypted' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"id":"cmp_native_relay","type":"compaction","encrypted_content":"native-trigger-encrypted"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_native_relay","status":"completed","output":[]}}',
        '',
        ''
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'relay-private',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const trigger = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })
    expect(trigger.status).toBe(200)
    expect(await trigger.text()).toContain('native-trigger-encrypted')

    const standalone = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-native-standalone' },
          { type: 'message', role: 'user', content: [] }
        ]
      })
    })
    expect(standalone.status).toBe(200)
    expect(await standalone.text()).toContain('native-endpoint-encrypted')
    expect(upstreamFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://native-relay.example.test/v1/responses',
      'https://native-relay.example.test/v1/responses/compact'
    ])
  })

  it('filters legacy accounts out of mixed pools before standalone opaque compact routing', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers = [
      {
        ...gatewayConfig.providers[0],
        id: 'legacy-relay',
        sourceType: 'relay',
        kind: 'openai-compatible',
        baseUrl: 'https://legacy-relay.example.test/v1',
        protocol: 'openai-responses',
        responsesCompactMode: 'legacy'
      },
      {
        ...gatewayConfig.providers[0],
        id: 'native-relay',
        sourceType: 'relay',
        kind: 'openai-compatible',
        baseUrl: 'https://native-relay.example.test/v1',
        protocol: 'openai-responses',
        responsesCompactMode: 'native'
      }
    ]
    gatewayConfig.accounts = [
      { ...gatewayConfig.accounts[0], providerId: 'legacy-relay', credentialType: 'api-key' },
      { ...gatewayConfig.accounts[1], providerId: 'native-relay', credentialType: 'api-key' }
    ]
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].members = gatewayConfig.accounts.map((item) => ({ accountId: item.id, enabled: true }))
    gatewayConfig.pools[0].maxRetries = 1
    const selectedAccountIds: string[] = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'mixed-native-result' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return 'relay-private'
      },
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'compaction', encrypted_content: 'mixed-encrypted-history' }]
      })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('mixed-native-result')
    expect(selectedAccountIds).toEqual(['second'])
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(upstreamFetch.mock.calls[0][0]).toBe('https://native-relay.example.test/v1/responses/compact')
  })

  it('does not leak Responses state headers from an empty-body failover attempt', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      protocol: 'openai-responses',
      responsesCompactMode: 'passthrough'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 1
    gatewayConfig.accounts = gatewayConfig.accounts.map((item) => ({ ...item, credentialType: 'api-key' }))
    const selectedAccountIds: string[] = []
    const upstreamFetch = vi.fn(async () => {
      if (upstreamFetch.mock.calls.length === 1) {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-stale-attempt': 'must-not-leak',
            'x-codex-turn-state': 'stale-turn-state'
          }
        })
      }
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"successful failover"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_header_failover","status":"completed","output":[]}}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-turn-state': 'successful-turn-state'
        }
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return 'relay-private'
      },
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-turn-state': 'client-turn-state'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-header-history' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
        ],
        stream: true
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-codex-turn-state')).toBe('successful-turn-state')
    expect(response.headers.get('x-codex-stale-attempt')).toBeNull()
    expect(await response.text()).toContain('successful failover')
    expect(selectedAccountIds).toEqual(['first', 'second'])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('cancels an oversized precommit noise stream before failover and keeps later requests usable', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'relay',
      kind: 'openai-compatible',
      protocol: 'openai-responses',
      responsesCompactMode: 'passthrough'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 1
    gatewayConfig.accounts = gatewayConfig.accounts.map((item) => ({ ...item, credentialType: 'api-key' }))
    const selectedAccountIds: string[] = []
    const upstreamCancel = vi.fn()
    const noiseChunk = new TextEncoder().encode(`:${'n'.repeat(1024 * 1024)}\n\n`)
    const successfulWire = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"usable after noisy failover"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_after_noise","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')
    const upstreamFetch = vi.fn(async () => {
      if (upstreamFetch.mock.calls.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            // Comments are valid SSE transport noise but not semantic
            // Responses events, so response metadata must remain uncommitted.
            for (let index = 0; index < 11; index += 1) controller.enqueue(noiseChunk)
          },
          cancel() {
            upstreamCancel()
          }
        }), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-stale-noise-source': 'must-not-leak'
          }
        })
      }
      return new Response(successfulWire, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'usable-turn-state' }
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return 'relay-private'
      },
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const sendOpaque = (sessionId: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': sessionId
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [
          { type: 'compaction', encrypted_content: 'encrypted-noise-history' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
        ],
        stream: true
      })
    })

    const failover = await sendOpaque('noise-failover-session')
    expect(failover.status).toBe(200)
    expect(failover.headers.get('x-codex-stale-noise-source')).toBeNull()
    expect(failover.headers.get('x-codex-turn-state')).toBe('usable-turn-state')
    expect(await failover.text()).toContain('usable after noisy failover')
    expect(upstreamCancel).toHaveBeenCalledOnce()
    expect(selectedAccountIds).toEqual(['first', 'second'])

    const later = await sendOpaque('later-noise-session')
    expect(later.status).toBe(200)
    expect(await later.text()).toContain('usable after noisy failover')
    expect(upstreamFetch).toHaveBeenCalledTimes(3)
  })

  it('buffers and validates V2 compact before failing over without exposing the invalid first stream', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'oauth-system',
      kind: 'openai',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 1
    gatewayConfig.accounts = gatewayConfig.accounts.map((item) => ({
      ...item,
      credentialType: 'chatgpt-oauth',
      chatgptAccountId: `acct-${item.id}`
    }))
    const selectedAccountIds: string[] = []
    const logs: RequestLog[] = []
    const credentialResolver = vi.fn((selected: Account) => {
      selectedAccountIds.push(selected.id)
      return {
        secret: `oauth-${selected.id}-private`,
        kind: 'chatgpt-oauth' as const,
        accountId: `acct-${selected.id}`
      }
    })
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (headers.get('chatgpt-account-id') === 'acct-first') {
        return new Response([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"bad_message","type":"message","role":"assistant","content":[]}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_not_compact","status":"completed","output":[]}}',
          '',
          ''
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'bad-turn-state' }
        })
      }
      return new Response([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"good_compact","type":"compaction","encrypted_content":"good-encrypted-content"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_good_compact","status":"completed","output":[],"usage":{"input_tokens":1000,"output_tokens":24,"total_tokens":1024}}}',
        '',
        ''
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'good-turn-state' }
      })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'session-id': 'compact-failover'
      },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'compaction_trigger' }],
        stream: true
      })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-codex-turn-state')).toBe('good-turn-state')
    expect(wire).toContain('good-encrypted-content')
    expect(wire).not.toContain('bad_message')
    expect(selectedAccountIds).toEqual(['first', 'second'])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(logs[0]).toMatchObject({
      status: 'success',
      statusCode: 200,
      accountId: 'second',
      requestKind: 'compaction',
      failoverCount: 1,
      inputTokens: 1000,
      outputTokens: 24,
      firstTokenMs: undefined,
      accountFirstTokenMs: undefined
    })
  })

  it('validates V2 compact independently of TCP chunk boundaries and forwards only the terminal prefix', async () => {
    const encoder = new TextEncoder()
    const compactEvent = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"cmp_chunked","type":"compaction","encrypted_content":"encrypted-分片"}}',
      '',
      ''
    ].join('\r\n')
    const completedEvent = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_chunked","status":"completed","output":[]}}',
      '',
      ''
    ].join('\r\n')
    const trailingError = [
      'event: error',
      'data: {"type":"error","message":"must-not-leak"}',
      '',
      ''
    ].join('\r\n')
    const acceptedPrefix = compactEvent + completedEvent
    const fullWire = encoder.encode(acceptedPrefix + trailingError)

    const singleChunk = await runCompactV2Wire([fullWire])
    const byteChunks = await runCompactV2Wire(Array.from(fullWire, (byte) => Uint8Array.of(byte)))
    const splitAfterTerminal = await runCompactV2Wire([
      encoder.encode(acceptedPrefix),
      encoder.encode(trailingError)
    ])
    const oversizedTrailingSameChunk = await runCompactV2Wire([
      encoder.encode(acceptedPrefix + `: ${'x'.repeat(10 * 1024 * 1024)}\r\n\r\n`)
    ])

    for (const result of [singleChunk, byteChunks, splitAfterTerminal, oversizedTrailingSameChunk]) {
      expect(result.status).toBe(200)
      expect(result.wire).toBe(acceptedPrefix)
      expect(result.wire).not.toContain('must-not-leak')
    }
  })

  it('rejects malformed, incomplete, duplicate, and out-of-order V2 compact events', async () => {
    const encoder = new TextEncoder()
    const itemEvent = (item: Record<string, unknown>) => [
      'event: response.output_item.done',
      `data: ${JSON.stringify({ type: 'response.output_item.done', item })}`,
      '',
      ''
    ].join('\n')
    const completedEvent = (response: Record<string, unknown> = {
      id: 'resp_valid', status: 'completed', output: []
    }) => [
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response })}`,
      '',
      ''
    ].join('\n')
    const validItem = { id: 'cmp_valid', type: 'compaction', encrypted_content: 'encrypted-valid' }
    const invalidWires = [
      itemEvent({ type: 'compaction', encrypted_content: 'encrypted' }) + completedEvent(),
      itemEvent({ id: 'cmp', type: 'compaction', encrypted_content: '' }) + completedEvent(),
      itemEvent({ id: 'cmp', type: 'compaction', encrypted_content: '   ' }) + completedEvent(),
      itemEvent({ id: 'cmp', type: 'compaction_summary', encrypted_content: 'encrypted' }) + completedEvent(),
      itemEvent(validItem) + completedEvent({ id: 'resp', status: 'incomplete', output: [] }),
      itemEvent(validItem) + completedEvent({ id: 'resp', status: 'failed', output: [] }),
      itemEvent(validItem) + completedEvent({ id: '   ', status: 'completed', output: [] }),
      completedEvent(),
      itemEvent(validItem) + itemEvent({ ...validItem, id: 'cmp_second' }) + completedEvent(),
      completedEvent() + itemEvent(validItem),
      'event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n'
    ]

    for (const wire of invalidWires) {
      const result = await runCompactV2Wire([encoder.encode(wire)])
      expect(result.status, wire).toBe(502)
      expect(result.wire, wire).toContain('upstream_compact_error')
    }

    const reversedAcrossChunks = await runCompactV2Wire([
      encoder.encode(completedEvent()),
      encoder.encode(itemEvent(validItem))
    ])
    expect(reversedAcrossChunks.status).toBe(502)
    expect(reversedAcrossChunks.wire).toContain('upstream_compact_error')
  })

  it('cancels a still-open V2 upstream at response.completed and releases capacity for normal traffic', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0], sourceType: 'oauth-system', kind: 'openai', protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth', chatgptAccountId: 'acct-capacity'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const encoder = new TextEncoder()
    let resolveCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    const compactWire = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"cmp_capacity","type":"compaction","encrypted_content":"encrypted-capacity"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_capacity","status":"completed","output":[]}}',
      '',
      ''
    ].join('\n')
    const ordinaryWire = 'data: {"type":"response.completed","response":{"id":"resp_after_compact","status":"completed","output":[]}}\n\n'
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(compactWire)) },
        cancel() { resolveCancelled() }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockImplementationOnce(async () => new Response(ordinaryWire, {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-capacity', kind: 'chatgpt-oauth' as const, accountId: 'acct-capacity'
      }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const compact = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })
    expect(compact.status).toBe(200)
    expect(await compact.text()).toContain('encrypted-capacity')
    await Promise.race([
      cancelled,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('V2 upstream was not cancelled')), 1_000))
    ])
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)

    const ordinary = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'normal after compact' }] }],
        stream: true
      })
    })
    expect(ordinary.status).toBe(200)
    expect(await ordinary.text()).toContain('resp_after_compact')
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('records a buffered V2 client disconnect as 499, releases the slot, and accepts the next request', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0], sourceType: 'oauth-system', kind: 'openai', protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth', chatgptAccountId: 'acct-abort'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const encoder = new TextEncoder()
    const logs: RequestLog[] = []
    let markHeld!: () => void
    const held = new Promise<void>((resolve) => { markHeld = resolve })
    const partialCompact = 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"cmp_abort","type":"compaction","encrypted_content":"encrypted-abort"}}\n\n'
    const ordinaryWire = 'data: {"type":"response.completed","response":{"id":"resp_after_abort","status":"completed","output":[]}}\n\n'
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(partialCompact))
          markHeld()
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockImplementationOnce(async () => new Response(ordinaryWire, {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({ secret: 'oauth-abort', kind: 'chatgpt-oauth' as const, accountId: 'acct-abort' }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const abortController = new AbortController()
    const victim = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true }),
      signal: abortController.signal
    })
    await held
    abortController.abort()
    await expect(victim).rejects.toThrow()
    await vi.waitFor(() => {
      expect(logs.some((log) => log.statusCode === 499 && log.failureStage === 'client')).toBe(true)
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(gateway.getAccountInFlight().first).toBe(0)
    }, { timeout: 2_000 })

    const ordinary = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'normal after abort', stream: true })
    })
    expect(ordinary.status).toBe(200)
    expect(await ordinary.text()).toContain('resp_after_abort')
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  })

  it('does not let Compact V2 lifecycle heartbeats hold a buffered request open', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0], sourceType: 'oauth-system', kind: 'openai', protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth', chatgptAccountId: 'acct-compact-stall'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_compact_stall","status":"in_progress"}}\n\n'
      },
      { atMs: 200, data: ': compact-keep-alive\n\n' },
      { atMs: 400, data: 'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":2,"response":{"id":"resp_compact_stall","status":"in_progress"}}\n\n' },
      { atMs: 600, data: 'event: heartbeat\ndata: {"type":"heartbeat"}\n\n' },
      { atMs: 800, data: ': compact-keep-alive\n\n' }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-compact-stall', kind: 'chatgpt-oauth' as const, accountId: 'acct-compact-stall'
      }),
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })

    expect(response.status).toBe(504)
    expect(await response.text()).toContain('upstream_response_progress_timeout')
    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 504 })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('keeps Compact V2 alive while reasoning and compaction output keep advancing', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0], sourceType: 'oauth-system', kind: 'openai', protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth', chatgptAccountId: 'acct-compact-progress'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_compact_progress","status":"in_progress"}}\n\n'
      },
      {
        atMs: 600,
        data: 'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"delta":"compressing"}\n\n'
      },
      {
        atMs: 1_200,
        data: 'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"cmp_progress","type":"compaction","encrypted_content":"encrypted-progress"}}\n\n'
      },
      {
        atMs: 1_800,
        data: 'event: response.completed\ndata: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_compact_progress","status":"completed","output":[]}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-compact-progress', kind: 'chatgpt-oauth' as const, accountId: 'acct-compact-progress'
      }),
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: [{ type: 'compaction_trigger' }], stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('encrypted-progress')
    expect(wire).toContain('response.completed')
    expect(wire).not.toContain('upstream_response_progress_timeout')
    expect(gateway.getStatus().successRequests).toBe(1)
  }, 10_000)

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
      onLog: (log) => upsertLog(logs, log)
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

  it('records Anthropic cache creation usage as cache-write input tokens', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      kind: 'anthropic',
      protocol: 'anthropic-messages'
    }
    gatewayConfig.pools[0] = {
      ...gatewayConfig.pools[0],
      protocol: 'anthropic-messages'
    }
    gatewayConfig.routes[0] = {
      ...gatewayConfig.routes[0],
      inboundProtocol: 'anthropic-messages'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'message-cache-usage',
      type: 'message',
      role: 'assistant',
      model: 'source-model',
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 7,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'message-cache-usage', type: 'message' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      status: 'success',
      inputTokens: 120,
      outputTokens: 7,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 40
    })
  })

  it('blocks new scheduling at exhausted headers and ignores an older late success', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[0].maxConcurrency = 4
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const states: Array<{
      accountId: string
      status: string
      cooldownUntil?: number
      cooldownReason?: string
    }> = []
    let finishOlder = (): void => undefined
    let finishExhausted = (): void => undefined
    const completion = JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    })
    const controlledResponse = (
      setFinish: (finish: () => void) => void,
      headers: Record<string, string> = {}
    ): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setFinish(() => {
          controller.enqueue(new TextEncoder().encode(completion))
          controller.close()
        })
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers }
    })
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => controlledResponse((finish) => { finishOlder = finish }))
      .mockImplementationOnce(async () => controlledResponse(
        (finish) => { finishExhausted = finish },
        {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-requests': '0'
        }
      ))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const olderRequest = post(port)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1))
    const exhaustedRequest = post(port)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({
      accountId: 'first',
      status: 'cooldown',
      cooldownUntil: timestamp + 30_000,
      cooldownReason: 'quota'
    }))

    // The exhausted response body is still in flight. Header observation alone
    // must already keep a third request away from the account.
    expect((await post(port)).status).toBe(503)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)

    finishExhausted()
    expect((await exhaustedRequest).status).toBe(200)
    finishOlder()
    expect((await olderRequest).status).toBe(200)

    // The older request selected revision 0 and completed after the quota
    // transition. It must neither clear scheduler health nor emit active state.
    expect(states.filter((state) => state.accountId === 'first').every((state) => state.status === 'cooldown')).toBe(true)
    expect((await post(port)).status).toBe(503)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('applies exhausted headers before a non-success body finishes', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[0].maxConcurrency = 4
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const states: Array<{ status: string; cooldownUntil?: number }> = []
    let finishError = (): void => undefined
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        finishError = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: 'limited' } })))
          controller.close()
        }
      }
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining-requests': '0'
      }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const limitedRequest = post(port)
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({
      status: 'cooldown',
      cooldownUntil: timestamp + 30_000
    }))
    expect((await post(port)).status).toBe(503)
    expect(upstreamFetch).toHaveBeenCalledOnce()

    finishError()
    expect((await limitedRequest).status).toBe(429)
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
    expect(states.find((state) => state.accountId === 'first' && state.consecutiveFailures === 1)).toMatchObject({
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

  it('does not spin maxRetries or report fake failovers when no account is initially eligible', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts.forEach((account) => { account.status = 'disabled' })
    gatewayConfig.pools[0].maxRetries = 5
    const logs: RequestLog[] = []
    const credentialResolver = vi.fn(() => 'credential')
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(503)
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 503,
      failureStage: 'scheduler',
      failoverCount: 0
    })
  })

  it.each([
    { name: 'an account pool whose other account exhausted quota', kind: 'standard' as const, direct: false },
    { name: 'a relay aggregate with one member', kind: 'relay-aggregate' as const, direct: false },
    { name: 'a directly selected relay', kind: 'standard' as const, direct: true }
  ])('keeps the last usable source active after transient failures for $name', async ({ kind, direct }) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    if (direct || kind === 'relay-aggregate') gatewayConfig.providers[0].sourceType = 'relay'
    gatewayConfig.pools[0].kind = kind
    if (direct) {
      gatewayConfig.accounts = [gatewayConfig.accounts[0]]
      gatewayConfig.pools[0] = {
        ...gatewayConfig.pools[0],
        id: gatewayConfig.providers[0].id,
        members: [{ accountId: gatewayConfig.accounts[0].id, enabled: true }],
        maxRetries: 0
      }
      gatewayConfig.routes[0].poolId = gatewayConfig.providers[0].id
    } else if (kind === 'relay-aggregate') {
      gatewayConfig.pools[0].members = [{ accountId: gatewayConfig.accounts[0].id, enabled: true }]
    } else {
      gatewayConfig.accounts[1] = {
        ...gatewayConfig.accounts[1],
        quota: {
          requests: { limit: 100, remaining: 0, resetAt: timestamp + 60_000 },
          observedAt: timestamp
        }
      }
    }
    const failureAttempts = gatewayConfig.pools[0].maxRetries + 1
    const upstreamFetch = vi.fn()
    for (let attempt = 0; attempt < failureAttempts; attempt += 1) {
      upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'temporary outage' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
    }
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Recovered' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const states: Array<{ accountId: string; status: string }> = []
    const selectedAccountIds: string[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return 'credential'
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => timestamp,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(503)
    expect(upstreamFetch).toHaveBeenCalledTimes(failureAttempts)
    expect(states).toEqual([])
    expect((await post(port)).status).toBe(200)
    expect(selectedAccountIds).toEqual(Array(failureAttempts + 1).fill('first'))
  })

  it('keeps the surviving source active when another source cooled earlier in the same retry chain', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'first outage' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'second outage' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'completion',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Recovered' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const states: Array<{ accountId: string; status: string }> = []
    const selectedAccountIds: string[] = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return 'credential'
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await post(port)).status).toBe(503)
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'cooldown' })
    expect((await post(port)).status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'second', 'second'])
  })

  it('passes through a same-protocol streaming response without buffering it as JSON', async () => {
    const port = await freePort()
    const wire = 'data: {"choices":[{"index":0,"delta":{"content":"one"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstreamFetch = vi.fn(async () => new Response(wire, {
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
    expect(await response.text()).toBe(wire)
    expect(gateway.getStatus()).toMatchObject({ activeRequests: 0, successRequests: 1 })
  })

  it('preserves original same-protocol non-streaming JSON bytes', async () => {
    const port = await freePort()
    const original = '{\n  "id": "raw-response",\n  "choices": [ { "message": { "content": "Done" } } ]\n}\n'
    const framed = new TextEncoder().encode(`prefix${original}suffix`)
    const slicedPayload = framed.subarray('prefix'.length, framed.byteLength - 'suffix'.length)
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // Exercise a single Uint8Array chunk whose byteOffset is non-zero;
          // the gateway must retain only this view and preserve its exact bytes.
          controller.enqueue(slicedPayload)
          controller.close()
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(original)
  })

  it.each([
    ['empty', null],
    ['non-JSON', '<html>upstream proxy error</html>'],
    ['non-object JSON', '["unexpected"]']
  ] as const)('rejects a successful %s upstream body instead of reporting success', async (_label, upstreamBody) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const states: Array<{ status: string }> = []
    const upstreamFetch = vi.fn(async () => new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log),
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { type: 'upstream_invalid_response' }
    })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'active' }))
    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 502 })
    expect(gateway.getStatus()).toMatchObject({ activeRequests: 0, successRequests: 0 })
  })

  it('rejects a malformed successful search response without reporting account success', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const states: Array<{ status: string }> = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'search-session', model: 'source-model', query: 'Stone+' })
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { type: 'upstream_invalid_response' } })
    expect(states).not.toContainEqual(expect.objectContaining({ status: 'active' }))
    expect(gateway.getStatus()).toMatchObject({ activeRequests: 0, successRequests: 0 })
  })

  it('keeps a structured non-2xx upstream JSON error intact', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'upstream rate limited', code: 'rate_limit' }
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port)
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { message: 'upstream rate limited', code: 'rate_limit' }
    })
  })

  it('does not let OAuth non-stream Responses heartbeats wait for the global request deadline', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 10 })
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0], sourceType: 'oauth-system', kind: 'openai', protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0], credentialType: 'chatgpt-oauth', chatgptAccountId: 'acct-oauth-stall'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_oauth_stall","model":"source-model","status":"in_progress","output":[]}}\n\n'
      },
      { atMs: 200, data: ': oauth-keep-alive\n\n' },
      { atMs: 400, data: 'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":2,"response":{"id":"resp_oauth_stall","status":"in_progress"}}\n\n' },
      { atMs: 600, data: 'event: heartbeat\ndata: {"type":"heartbeat"}\n\n' },
      { atMs: 800, data: ': oauth-keep-alive\n\n' }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-stall-secret', kind: 'chatgpt-oauth' as const, accountId: 'acct-oauth-stall'
      }),
      responsesProgressIdleTimeoutMs: 1_000,
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: false })
    })

    expect(response.status).toBe(504)
    expect(await response.text()).toContain('upstream_response_progress_timeout')
    expect(logs[0]).toMatchObject({ status: 'error', statusCode: 504 })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('does not wait for an OAuth terminal stream cancel hook to settle', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 10 })
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      sourceType: 'oauth-system',
      kind: 'openai',
      protocol: 'openai-responses'
    }
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[0] = {
      ...gatewayConfig.accounts[0],
      credentialType: 'chatgpt-oauth',
      chatgptAccountId: 'acct-first'
    }
    gatewayConfig.accounts[1].status = 'disabled'
    let cancelCalled = false
    const terminal = new TextEncoder().encode([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_nonstream_terminal","model":"source-model","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
      ''
    ].join('\n'))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => ({
        secret: 'oauth-secret',
        kind: 'chatgpt-oauth' as const,
        accountId: 'acct-first'
      }),
      fetchImplementation: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(terminal) },
        cancel() {
          cancelCalled = true
          return new Promise<void>(() => undefined)
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const completed = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: false })
    }).then(async (response) => ({ status: response.status, body: await response.text() }))
    const result = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('cancel hook blocked completion')), 500))
    ])

    expect(result.status).toBe(200)
    expect(result.body).toContain('resp_nonstream_terminal')
    expect(cancelCalled).toBe(true)
    expect(gateway.getAccountInFlight().first).toBe(0)
  })

  it('releases a completed Responses request even when the upstream transport stays open', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    let upstreamCancelled = false
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_terminal_open","model":"source-model","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
          '',
          ''
        ].join('\n')))
      },
      cancel() {
        upstreamCancelled = true
        return new Promise<void>(() => undefined)
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(wire).toContain('response.completed')
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(0))
    expect(gateway.getAccountInFlight().first).toBe(0)
    expect(upstreamCancelled).toBe(true)
  })

  it('preserves a delayed Chat DONE frame after finish_reason', async () => {
    const port = await freePort()
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'data: {"id":"chat-delayed-done","object":"chat.completion.chunk","model":"source-model","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n'
      },
      { atMs: 350, data: 'data: [DONE]\n\n', close: true }
    ]))
    const gateway = new GatewayServer({
      config: config(port),
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('"finish_reason":"stop"')
    expect(wire).toContain('data: [DONE]')
    expect([...logs].reverse().find((log) => log.status !== 'streaming')).toMatchObject({
      status: 'success', statusCode: 200
    })
  })

  it('accepts a delayed response.completed after output_item.done', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_delayed_terminal","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Done","annotations":[]}]}}\n\n'
      },
      {
        atMs: 2_500,
        data: 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_delayed_terminal","model":"source-model","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('response.output_item.done')
    expect(wire).toContain('response.completed')
    expect(wire).not.toContain('event: error')
    expect([...logs].reverse().find((log) => log.status !== 'streaming')).toMatchObject({
      status: 'success',
      statusCode: 200,
      streamEndReason: 'protocol-terminal',
      streamTerminalEvent: 'response.completed',
      streamLastEventType: 'response.completed',
      terminalWaitMs: expect.any(Number)
    })
  }, 10_000)

  it('rolls the Responses terminal window forward on later semantic events', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":10,"output_index":0,"item":{"type":"message","status":"completed"}}\n\n'
      },
      {
        atMs: 1_500,
        data: 'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":11,"output_index":0,"content_index":0,"part":{"type":"output_text","text":"Done"}}\n\n'
      },
      {
        atMs: 3_000,
        data: 'event: response.completed\ndata: {"type":"response.completed","sequence_number":12,"response":{"id":"resp_rolling","status":"completed","output":[]}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(wire).toContain('response.content_part.done')
    expect(wire).toContain('response.completed')
    expect(logs[0]).toMatchObject({
      status: 'success',
      streamTerminalEvent: 'response.completed',
      streamLastSequenceNumber: 12,
      terminalWaitMs: expect.any(Number)
    })
    expect(logs[0].terminalWaitMs).toBeGreaterThanOrEqual(2_500)
  }, 10_000)

  it('terminates a logically completed Responses item with an error when response.completed never follows', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    let upstreamCancelled = false
    const logs: RequestLog[] = []
    const encoder = new TextEncoder()
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_logically_complete","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Done","annotations":[]}]}}',
          '',
          ''
        ].join('\n')))
      },
      cancel() {
        upstreamCancelled = true
        return new Promise<void>(() => undefined)
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(wire).toContain('response.output_item.done')
    expect(wire).toContain('event: error')
    expect(wire).toContain('"type":"error"')
    expect(wire).toContain('upstream_stream_idle_timeout')
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(0))
    expect(gateway.getAccountInFlight().first).toBe(0)
    expect([...logs].reverse().find((log) => log.status !== 'streaming')).toMatchObject({
      status: 'error',
      statusCode: 504,
      streamEndReason: 'stream-idle-timeout',
      streamLastEventType: 'response.output_item.done',
      streamLastSequenceNumber: undefined,
      terminalWaitMs: expect.any(Number)
    })
    expect(upstreamCancelled).toBe(true)
  })

  it('emits a terminal Responses error instead of a bare EOF when the upstream closes early', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_early_eof","model":"source-model","status":"in_progress","output":[]}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","response_id":"resp_early_eof","item_id":"msg_early_eof","output_index":0,"content_index":0,"delta":"partial"}',
      '',
      ''
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('response.output_text.delta')
    expect(wire).toContain('event: error')
    expect(wire).toContain('"type":"error"')
    expect(wire).toContain('Upstream stream ended before a terminal event')
    expect([...logs].reverse().find((log) => log.status !== 'streaming')).toMatchObject({
      status: 'error',
      statusCode: 502,
      error: 'Upstream stream ended before a terminal event',
      streamEndReason: 'upstream-eof',
      streamLastEventType: 'response.output_text.delta'
    })
  })

  it('rejects a non-standard Responses [DONE] sentinel followed by EOF', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response([
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","sequence_number":20,"output_index":0,"item":{"type":"message","status":"completed"}}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(wire).toContain('data: [DONE]')
    expect(wire).toContain('event: error')
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 502,
      streamEndReason: 'upstream-eof',
      streamLastEventType: '[DONE]',
      streamLastSequenceNumber: 20
    })
  })

  it.each([
    { terminal: 'response.incomplete' as const, expectedStatus: 'success' as const, expectedCode: 200 },
    { terminal: 'response.failed' as const, expectedStatus: 'error' as const, expectedCode: 502 }
  ])('classifies an explicit $terminal terminal without waiting for EOF', async ({ terminal, expectedStatus, expectedCode }) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const responsePayload = terminal === 'response.failed'
      ? { id: 'resp_terminal', status: 'failed', output: [], error: { message: 'explicit upstream failure', code: 'server_error' } }
      : { id: 'resp_terminal', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }
    const upstreamFetch = vi.fn(async () => new Response(
      `event: ${terminal}\ndata: ${JSON.stringify({ type: terminal, sequence_number: 50, response: responsePayload })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(wire).toContain(`event: ${terminal}`)
    expect(logs[0]).toMatchObject({
      status: expectedStatus,
      statusCode: expectedCode,
      streamEndReason: terminal === 'response.failed' ? 'explicit-error' : 'protocol-terminal',
      streamTerminalEvent: terminal,
      streamLastSequenceNumber: 50
    })
  })

  it('stops reading immediately after an explicit upstream stream error', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 10 })
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const encoder = new TextEncoder()
    const logs: RequestLog[] = []
    let upstreamCancelled = false
    let errorTimer: ReturnType<typeof setTimeout> | undefined
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_error_open","model":"source-model","status":"in_progress","output":[]}}\n\n'
        ))
        errorTimer = setTimeout(() => controller.enqueue(encoder.encode(
          'event: error\ndata: {"type":"error","error":{"message":"upstream exploded","type":"server_error"}}\n\n'
        )), 25)
      },
      cancel() {
        upstreamCancelled = true
        if (errorTimer) clearTimeout(errorTimer)
        return new Promise<void>(() => undefined)
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const startedAt = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()
    const elapsedMs = performance.now() - startedAt

    expect(response.status).toBe(200)
    expect(wire).toContain('upstream exploded')
    expect(elapsedMs).toBeLessThan(1_000)
    expect(upstreamCancelled).toBe(true)
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 502,
      streamEndReason: 'explicit-error'
    })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('does not let Responses lifecycle heartbeats keep a stalled stream alive', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_stalled","model":"source-model","status":"in_progress","output":[]}}\n\n'
      },
      { atMs: 200, data: ': keep-alive\n\n' },
      { atMs: 400, data: 'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":2,"response":{"id":"resp_stalled","status":"in_progress"}}\n\n' },
      { atMs: 600, data: 'event: heartbeat\ndata: {"type":"heartbeat"}\n\n' },
      { atMs: 800, data: ': keep-alive\n\n' },
      {
        atMs: 1_400,
        data: 'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_stalled","status":"completed","output":[]}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('upstream_response_progress_timeout')
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 504,
      streamEndReason: 'stream-idle-timeout'
    })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('keeps a long Responses stream alive while reasoning and output keep advancing', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp_progressing","model":"source-model","status":"in_progress","output":[]}}\n\n'
      },
      {
        atMs: 600,
        data: 'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"delta":"checking"}\n\n'
      },
      {
        atMs: 1_200,
        data: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"response_id":"resp_progressing","output_index":0,"content_index":0,"delta":"done"}\n\n'
      },
      {
        atMs: 1_800,
        data: 'event: response.completed\ndata: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_progressing","model":"source-model","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('response.reasoning_summary_text.delta')
    expect(wire).toContain('response.completed')
    expect(wire).not.toContain('upstream_response_progress_timeout')
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
  }, 10_000)

  it('emits a terminal Responses error after an upstream idle timeout', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","response_id":"resp_idle","item_id":"msg_idle","output_index":0,"content_index":0,"delta":"partial"}\n\n'
      },
      {
        atMs: 1_300,
        data: 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_idle","status":"completed","output":[]}}\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('event: error')
    expect(wire).toContain('"type":"error"')
    expect(wire).toContain('upstream_stream_idle_timeout')
    expect([...logs].reverse().find((log) => log.status !== 'streaming')).toMatchObject({
      status: 'error',
      statusCode: 504
    })
  }, 10_000)

  it('forwards the first safe stream chunk without waiting for a later chunk', async () => {
    const port = await freePort()
    const encoder = new TextEncoder()
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve })
    let pullCount = 0
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n'
        ))
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

  it.each([
    {
      label: 'same-protocol',
      inboundProtocol: 'openai-chat' as const,
      path: '/v1/chat/completions',
      body: { model: 'source-model', messages: [{ role: 'user', content: 'Reply' }], stream: true }
    },
    {
      label: 'converted',
      inboundProtocol: 'openai-responses' as const,
      path: '/v1/responses',
      body: { model: 'source-model', input: 'Reply', stream: true }
    }
  ])('interrupts a blocked $label stream reader when the client disconnects', async ({ inboundProtocol, path, body }) => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 10 })
    gatewayConfig.routes[0].inboundProtocol = inboundProtocol
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const encoder = new TextEncoder()
    const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({
          done: false,
          value: encoder.encode(
            'data: {"id":"chat-abort","model":"source-model","choices":[{"index":0,"delta":{"content":"started"},"finish_reason":null}]}\n\n'
          )
        })
        .mockImplementation(() => pendingRead),
      cancel: vi.fn(() => new Promise<void>(() => undefined)),
      releaseLock: vi.fn()
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const upstreamResponse = new Response(null, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
    Object.defineProperty(upstreamResponse, 'body', {
      configurable: true,
      value: { getReader: () => reader }
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: vi.fn(async () => upstreamResponse) as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2))
    const abortedAt = performance.now()
    controller.abort()
    await response.text().catch(() => undefined)
    await vi.waitFor(() => expect(logs[0]?.status).toBe('error'))

    expect(performance.now() - abortedAt).toBeLessThan(1_500)
    expect(reader.cancel).toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ statusCode: 499, failureStage: 'client' })
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('keeps a same-protocol stream alive beyond the request deadline while chunks keep arriving', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'data: {"id":"chat-long","model":"source-model","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n\n'
      },
      {
        atMs: 600,
        data: 'data: {"id":"chat-long","model":"source-model","choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}\n\n'
      },
      {
        atMs: 1_200,
        data: 'data: {"id":"chat-long","model":"source-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        close: true
      }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('"A"')
    expect(wire).toContain('"B"')
    expect(wire).toContain('[DONE]')
    expect(gateway.getStatus().successRequests).toBe(1)
  }, 10_000)

  it('marks a same-protocol stream idle gap as an upstream 504', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const states: Array<{ accountId: string; status: string }> = []
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'data: {"id":"chat-idle","model":"source-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
      },
      { atMs: 1_300, data: 'data: [DONE]\n\n', close: true }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => logs.push(log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200) // Headers were already committed by the first chunk.
    expect(await response.text()).toContain('partial')
    expect(gateway.getStatus().successRequests).toBe(0)
    expect(states).toEqual([])
    expect([...logs].reverse().find((log) => log.status === 'error')).toMatchObject({
      statusCode: 504,
      error: 'Upstream stream produced no data for 1000 ms'
    })
  }, 10_000)

  it('keeps a converted stream alive beyond the request deadline while chunks keep arriving', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'data: {"id":"chat-converted-long","model":"source-model","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n\n'
      },
      {
        atMs: 600,
        data: 'data: {"id":"chat-converted-long","model":"source-model","choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}\n\n'
      },
      {
        atMs: 1_200,
        data: 'data: {"id":"chat-converted-long","model":"source-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        close: true
      }
    ]))
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
        model: 'source-model', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('"text":"A"')
    expect(wire).toContain('"text":"B"')
    expect(wire).toContain('message_stop')
    expect(gateway.getStatus().successRequests).toBe(1)
  }, 10_000)

  it('emits an explicit idle-timeout error for a converted stream', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 1 })
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => scheduledSseResponse([
      {
        atMs: 0,
        data: 'data: {"id":"chat-converted-idle","model":"source-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
      },
      { atMs: 1_300, data: 'data: [DONE]\n\n', close: true }
    ]))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => logs.push(log)
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
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('upstream_stream_idle_timeout')
    expect(gateway.getStatus().successRequests).toBe(0)
    expect([...logs].reverse().find((log) => log.status === 'error')).toMatchObject({ statusCode: 504 })
  }, 10_000)

  it('fails over a sticky request after first-body timeout and keeps the successful reassignment', async () => {
    const port = await freePort()
    let now = timestamp
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
    gatewayConfig.pools[0].firstBodyTimeoutMs = 1_000
    const encoder = new TextEncoder()
    const selectedAccountIds: string[] = []
    const recoveredStream = () => new Response(encoder.encode([
      'data: {"id":"chat-failover","model":"source-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n')), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined)
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockImplementation(async () => recoveredStream())
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => now
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postSession(port, 'timeout-thread', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Recovered')
    now += 31_000
    expect((await postSession(port, 'timeout-thread', { stream: true })).status).toBe(200)
    expect((await postSession(port, 'new-thread', { stream: true })).status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'second', 'second', 'first'])
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

  it('evicts a sticky account when a same-protocol upstream stream terminates incomplete', async () => {
    const port = await freePort()
    let now = timestamp
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
    gatewayConfig.pools[0].maxRetries = 0
    const selectedAccountIds: string[] = []
    const success = () => new Response(JSON.stringify({
      id: 'completion',
      model: 'source-model',
      choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const upstreamFetch = vi.fn()
      .mockImplementationOnce(async () => success())
      .mockResolvedValueOnce(new Response(
        'data: {"id":"chat-cut","model":"source-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      ))
      .mockImplementation(async () => success())
    const states: Array<{ accountId: string; status: string }> = []
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      now: () => now,
      onAccountState: (state) => states.push(state)
    })
    runningServers.push(gateway)
    await gateway.start()

    expect((await postSession(port, 'cut-thread')).status).toBe(200)
    const cut = await postSession(port, 'cut-thread', { stream: true })
    expect(cut.status).toBe(200)
    expect(await cut.text()).toContain('partial')
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ accountId: 'first', status: 'cooldown' }))

    now += 31_000
    expect((await postSession(port, 'cut-thread')).status).toBe(200)
    expect((await postSession(port, 'fresh-thread')).status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'first', 'second', 'first'])
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
      fetchImplementation: upstreamFetch as typeof fetch, onLog: (log) => upsertLog(logs, log)
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

  it('fails over before committing a converted stream with no recognized protocol event', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response('data: {}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      }))
      .mockResolvedValueOnce(new Response([
        'data: {"id":"chat-converted-valid","model":"source-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}',
        '', 'data: [DONE]', '', ''
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
  })

  it('fails over before committing a same-protocol stream with no recognized protocol event', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const recoveredWire = [
      'data: {"id":"chat-native-valid","model":"source-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}',
      '', 'data: [DONE]', '', ''
    ].join('\n')
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response('data: {"type":"heartbeat"}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      }))
      .mockResolvedValueOnce(new Response(recoveredWire, {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => `key-${selected.id}`,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(recoveredWire)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a lossy built-in-tool conversion before acquiring an upstream account', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.routes[0].inboundProtocol = 'openai-responses'
    const credentialResolver = vi.fn(() => 'credential')
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source-model', input: 'hello',
        tools: [{ type: 'web_search_preview' }], tool_choice: 'auto'
      })
    })
    expect(response.status).toBe(422)
    expect(await response.text()).toContain('web_search_preview')
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

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

  it('hedges a response whose headers arrive quickly but first body stalls', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    const encoder = new TextEncoder()
    let primaryTimer: ReturnType<typeof setTimeout> | undefined
    const primaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        primaryTimer = setTimeout(() => {
          try {
            controller.enqueue(encoder.encode('data: {"id":"chat-slow-body","model":"source-model","choices":[{"index":0,"delta":{"content":"Slow"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
            controller.close()
          } catch { /* The hedge cancelled the losing body. */ }
        }, 800)
      },
      cancel() {
        if (primaryTimer) clearTimeout(primaryTimer)
      }
    })
    const fastStream = 'data: {"id":"chat-fast-body","model":"source-model","choices":[{"index":0,"delta":{"content":"Fast body"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(primaryStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(fastStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Fast body')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('bounds first-body waits for both successful hedge lanes', async () => {
    const port = await freePort()
    const gatewayConfig = config(port, { requestTimeoutSeconds: 10 })
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    gatewayConfig.pools[0].firstBodyTimeoutMs = 1_000
    gatewayConfig.pools[0].maxRetries = 0
    let cancelled = 0
    const upstreamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const startedAt = performance.now()
    const response = await post(port, 'local-secret', { stream: true })
    const elapsedMs = performance.now() - startedAt

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(elapsedMs).toBeLessThan(3_000)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(cancelled).toBe(2))
    expect(gateway.getStatus().activeRequests).toBe(0)
    expect(gateway.getAccountInFlight().first).toBe(0)
  }, 10_000)

  it('does not let a fast hedge error cancel a primary with successful headers', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    gatewayConfig.pools[0].maxRetries = 0
    const encoder = new TextEncoder()
    let primaryTimer: ReturnType<typeof setTimeout> | undefined
    const primaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        primaryTimer = setTimeout(() => {
          try {
            controller.enqueue(encoder.encode('data: {"id":"chat-valid-primary","model":"source-model","choices":[{"index":0,"delta":{"content":"Primary survived"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
            controller.close()
          } catch { /* A failing implementation may cancel the valid primary. */ }
        }, 1_200)
      },
      cancel() {
        if (primaryTimer) clearTimeout(primaryTimer)
      }
    })
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(primaryStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }))
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Primary survived')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['empty-body', ''],
    ['null-body', null]
  ])('does not let a %s successful stream beat a valid hedge', async (_label, emptyBody) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    gatewayConfig.pools[0].maxRetries = 0
    const validStream = 'data: {"id":"chat-valid-hedge","model":"source-model","choices":[{"index":0,"delta":{"content":"Valid hedge"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response(emptyBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }))
      .mockResolvedValueOnce(new Response(validStream, {
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

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Valid hedge')
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('does not hedge after the primary has produced its first body chunk', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].hedgedRequests = true
    gatewayConfig.pools[0].hedgeDelayMs = 250
    const stream = 'data: {"id":"chat-ready","model":"source-model","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstreamFetch = vi.fn(async () => new Response(stream, {
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

    const response = await post(port, 'local-secret', { stream: true })
    expect(await response.text()).toContain('Ready')
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('evicts only the unproven sticky session when the client disconnects before first output', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
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
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const controller = new AbortController()
    const disconnectedRequest = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-stone-session-id': 'cancelled-thread',
        'x-codex-parent-thread-id': 'parent-thread',
        'x-openai-subagent': 'false'
      },
      body: JSON.stringify({ model: 'source-model', messages: [{ role: 'user', content: 'Hello' }] }),
      signal: controller.signal
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    controller.abort()
    await disconnectedRequest
    await vi.waitFor(() => expect(logs[0]?.status).toBe('error'))

    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(states).toHaveLength(0)
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 499,
      error: 'Client closed the request',
      failureStage: 'client',
      failoverCount: 0,
      accountId: 'first'
    })

    const nextResponse = await postSession(port, 'cancelled-thread')
    expect(nextResponse.status).toBe(200)
    expect(selectedAccountIds).toEqual(['first', 'second'])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['explicit marker', { 'x-openai-subagent': 'thread_spawn' }],
    ['parent thread fallback', { 'x-codex-parent-thread-id': 'parent-thread' }],
    ['turn metadata fallback', {
      'x-codex-turn-metadata': JSON.stringify({
        parent_thread_id: 'parent-thread',
        subagent_kind: 'thread_spawn'
      })
    }]
  ])('records an intentional subagent cancellation as a successful 499 without evicting the sticky session (%s)', async (_label, subagentHeaders) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].stickySessions = true
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
        id: 'completion-after-subagent-cancel',
        model: 'source-model',
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => {
        selectedAccountIds.push(selected.id)
        return `key-${selected.id}`
      },
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push(state),
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const controller = new AbortController()
    const cancelledRequest = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-stone-session-id': 'subagent-thread',
        ...subagentHeaders
      },
      body: JSON.stringify({ model: 'source-model', messages: [{ role: 'user', content: 'Hello' }] }),
      signal: controller.signal
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    controller.abort()
    await cancelledRequest
    await vi.waitFor(() => expect(logs[0]?.status).toBe('success'))

    expect(states).toHaveLength(0)
    expect(gateway.getStatus().successRequests).toBe(1)
    expect(logs[0]).toMatchObject({
      status: 'success',
      statusCode: 499,
      failoverCount: 0,
      accountId: 'first'
    })
    expect(logs[0]?.error).toBeUndefined()
    expect(logs[0]?.failureStage).toBeUndefined()

    const nextResponse = await postSession(port, 'subagent-thread')
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
      onLog: (log) => upsertLog(logs, log)
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

    await vi.waitFor(() => expect(logs[0]?.status).toBe('success'))
    expect(logs[0]).toMatchObject({ status: 'success', statusCode: 200 })
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ accountId: 'first', status: 'active' })
  })

  it('records 499 when Codex closes after receiving complete custom-tool input without a Responses terminal', async () => {
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
      onLog: (log) => upsertLog(logs, log)
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

    await vi.waitFor(() => expect(logs[0]?.status).toBe('error'))
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 499,
      streamEndReason: 'client-closed',
      streamLastEventType: 'response.custom_tool_call_input.done'
    })
    expect(states).toEqual([])
  })

  it('records a streamed subagent cancellation as a successful 499 after a completed assistant item', async () => {
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
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
        'x-codex-parent-thread-id': 'parent-thread'
      },
      body: JSON.stringify({ model: 'source-model', input: 'Reply', stream: true })
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('response.output_item.done')
    await reader!.cancel()

    await vi.waitFor(() => expect(logs[0]?.status).toBe('success'))
    expect(logs[0]).toMatchObject({
      status: 'success',
      statusCode: 499,
      streamEndReason: 'client-closed',
      streamLastEventType: 'response.output_item.done'
    })
    expect(states).toEqual([])
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
      onLog: (log) => upsertLog(logs, log),
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
      onLog: (log) => upsertLog(logs, log),
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
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chat-capacity',
      model: 'source-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log),
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
    await Promise.all([first.text(), second.text()])
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(0))
    expect(gateway.getAccountInFlight().first).toBe(0)
    expect(logs.every((log) => log.status === 'success')).toBe(true)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    releaseTitles()
    await vi.waitFor(() => expect(logs.every((log) => log.conversationName === 'Resolved later')).toBe(true))
  })

  it('preserves a same-protocol stream error while marking the account request as failed', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    const states: Array<{ accountId: string; status: string }> = []
    const logs: RequestLog[] = []
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
      onLog: (log) => upsertLog(logs, log)
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await post(port, 'local-secret', { stream: true })
    expect(response.status).toBe(200)
    const responseText = await response.text()
    expect(responseText).not.toContain(credential)
    expect(responseText).toContain('overloaded [REDACTED]')
    expect(gateway.getStatus().successRequests).toBe(0)
    expect(states).toEqual([])
    await vi.waitFor(() => expect(logs[0]?.status).toBe('error'))
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
    expect(states).toEqual([])
  })

  it('does not synthesize a successful converted stream when an upstream Responses terminal is missing', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0].protocol = 'openai-responses'
    gatewayConfig.pools[0].protocol = 'openai-responses'
    gatewayConfig.routes[0].inboundProtocol = 'anthropic-messages'
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const logs: RequestLog[] = []
    const upstreamFetch = vi.fn(async () => new Response([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","sequence_number":30,"response_id":"resp_converted_cut","output_index":0,"content_index":0,"delta":"partial"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","sequence_number":31,"output_index":0,"item":{"type":"message","status":"completed"}}',
      '',
      ''
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: () => 'credential',
      fetchImplementation: upstreamFetch as typeof fetch,
      onLog: (log) => upsertLog(logs, log)
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
    const wire = await response.text()

    expect(wire).toContain('event: error')
    expect(wire).not.toContain('event: message_stop')
    expect(logs[0]).toMatchObject({
      status: 'error',
      statusCode: 502,
      streamEndReason: 'upstream-eof',
      streamLastEventType: 'response.output_item.done',
      streamLastSequenceNumber: 31
    })
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

  it('rebuilds provider, pool, account, and route indexes on a hot config handoff', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.accounts[1].status = 'disabled'
    gatewayConfig.pools[0].maxRetries = 0
    const selected: string[] = []
    const upstreamUrls: string[] = []
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      upstreamUrls.push(String(input))
      return new Response(JSON.stringify({
        id: 'hot-index',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (account) => {
        selected.push(account.id)
        return 'credential'
      },
      fetchImplementation: upstreamFetch as typeof fetch
    })
    runningServers.push(gateway)
    await gateway.start()

    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      id: 'provider-v2',
      baseUrl: 'https://new.example.test/v2'
    }
    gatewayConfig.accounts[0] = { ...gatewayConfig.accounts[0], status: 'disabled' }
    gatewayConfig.accounts[1] = {
      ...gatewayConfig.accounts[1],
      providerId: 'provider-v2',
      status: 'active'
    }
    gatewayConfig.pools[0] = {
      ...gatewayConfig.pools[0],
      members: [{ accountId: 'second', enabled: true }]
    }
    gatewayConfig.routes[0] = { ...gatewayConfig.routes[0], localToken: 'hot-secret' }
    // Deliberately submit the same object identity after in-place edits.
    gateway.updateConfig(gatewayConfig)

    expect((await post(port)).status).toBe(401)
    const response = await post(port, 'hot-secret')
    expect(response.status).toBe(200)
    await response.text()
    expect(selected).toEqual(['second'])
    expect(upstreamUrls[0]).toContain('new.example.test/v2')
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
