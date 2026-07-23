import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayServer } from '../../src/main/gateway'
import { forwardResponsesSse, parseClientEvent } from '../../src/main/gateway/responses-websocket'
import type { Account, GatewaySettings, Pool, ProviderDefinition, RequestLog, Route } from '../../src/shared/types'
import type { GatewayConfig } from '../../src/main/gateway'

const running: GatewayServer[] = []
const timestamp = 1_700_000_000_000

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.stop({ force: true })))
})

describe('Responses WebSocket message adapter', () => {
  it('validates response.create and strips transport-only fields', () => {
    expect(parseClientEvent(Buffer.from('{"type":"response.create","model":" gpt-test ","input":"hello"}')))
      .toEqual({ ok: true, kind: 'create', body: { model: 'gpt-test', input: 'hello', stream: true } })
    expect(parseClientEvent(Buffer.from('{"type":"response.create","model":"gpt-test","stream":true}')))
      .toMatchObject({ ok: false })
    expect(parseClientEvent(Buffer.from('{"type":"unknown"}'))).toMatchObject({ ok: false })
  })

  it('forwards one JSON WebSocket message per SSE server event', async () => {
    const events: Record<string, unknown>[] = []
    const response = new Response('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
    await forwardResponsesSse(response, (event) => events.push(event))
    expect(events).toEqual([{ type: 'response.created' }, { type: 'response.completed' }])
  })

  it('accepts a UTF-8 BOM before the first SSE data field', async () => {
    const events: Record<string, unknown>[] = []
    const response = new Response('\uFEFFdata: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n')

    await forwardResponsesSse(response, (event) => events.push(event))

    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.completed'])
  })

  it('recognizes a CRLF frame boundary split across upstream chunks', async () => {
    const events: Record<string, unknown>[] = []
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\r\n\r'))
        controller.enqueue(new TextEncoder().encode('\ndata: {"type":"response.completed"}\r\n\r\n'))
        controller.close()
      }
    }))

    await forwardResponsesSse(response, (event) => events.push(event))

    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.completed'])
  })

  it('cancels the SSE reader when a malformed event aborts forwarding', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {broken}\n\n'))
      },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'text/event-stream' } })
    await expect(forwardResponsesSse(response, () => undefined)).rejects.toThrow(/invalid JSON/)
    await waitFor(() => cancelled)
  })

  it('aborts a pending upstream read instead of waiting for EOF', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start() { /* keep the first read pending */ },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'text/event-stream' } })
    const controller = new AbortController()
    const forwarding = forwardResponsesSse(response, () => undefined, controller.signal)
    await Promise.resolve()

    controller.abort(new DOMException('test abort', 'AbortError'))

    await expect(forwarding).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => cancelled)
  })

  it('limits the current SSE frame by raw bytes and cancels an unterminated oversized stream', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // The character count is below the limit, but its UTF-8 wire size is
        // above it. Keep the stream open to model a stuck upstream frame.
        controller.enqueue(new TextEncoder().encode(`data: "${'界'.repeat(40)}"`))
      },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'text/event-stream' } })

    await expect(forwardResponsesSse(response, () => undefined, undefined, 96))
      .rejects.toThrow(/SSE frame larger than 96 bytes/)
    await waitFor(() => cancelled)
  })

  it('does not apply the frame limit to the complete multi-event response', async () => {
    const events: Record<string, unknown>[] = []
    const wire = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.completed"}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    expect(Buffer.byteLength(wire)).toBeGreaterThan(48)

    await forwardResponsesSse(new Response(wire), (event) => events.push(event), undefined, 48)

    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.completed'])
  })
})

describe('GatewayServer Responses WebSocket', () => {
  it('is disabled by default and rejects invalid handshake credentials', async () => {
    const port = await freePort()
    const gateway = makeGateway(port, {}, vi.fn())
    running.push(gateway)
    await gateway.start()
    await expectUpgradeStatus(`ws://127.0.0.1:${port}/v1/responses`, 'local-secret', 404)

    gateway.updateConfig(config(port, { responsesWebSocketEnabled: true }))
    await expectUpgradeStatus(`ws://127.0.0.1:${port}/v1/responses`, 'wrong-secret', 401)
  })

  it('reuses the HTTP routing pipeline and forwards ordered Responses events', async () => {
    const port = await freePort()
    const logs: RequestLog[] = []
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-test',
        input: 'hello',
        stream: true,
        service_tier: 'priority',
      })
      return responsesSse([
        { type: 'response.created', response: { id: 'resp-test', status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'hello', sequence_number: 1 },
        { type: 'response.completed', response: { id: 'resp-test', status: 'completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ])
    }) as unknown as typeof fetch
    const gateway = makeGateway(port, { responsesWebSocketEnabled: true }, fetchImplementation, logs)
    running.push(gateway)
    await gateway.start()

    const socket = await connect(`ws://127.0.0.1:${port}/v1/responses`, 'local-secret')
    const received = collectMessages(socket)
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'hello' }))
    await waitFor(() => received.some((event) => event.type === 'response.completed'))
    expect(received.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.completed',
    ])
    await waitFor(() => logs.some((log) => log.status === 'success'))
    expect(logs.find((log) => log.status === 'success')).toMatchObject({ model: 'gpt-test', statusCode: 200 })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    socket.close()
  })

  it('aborts the ordinary gateway request when the WebSocket disconnects', async () => {
    const port = await freePort()
    let upstreamSignal: AbortSignal | undefined
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    const gateway = makeGateway(port, { responsesWebSocketEnabled: true }, fetchImplementation)
    running.push(gateway)
    await gateway.start()
    const socket = await connect(`ws://127.0.0.1:${port}/v1/responses`, 'local-secret')
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'hello' }))
    await waitFor(() => Boolean(upstreamSignal))
    socket.terminate()
    await waitFor(() => upstreamSignal?.aborted === true)
    await waitFor(() => gateway.getStatus().activeRequests === 0)
  })

  it('supports explicit cancellation without leaving an active request', async () => {
    const port = await freePort()
    let upstreamSignal: AbortSignal | undefined
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    const gateway = makeGateway(port, { responsesWebSocketEnabled: true }, fetchImplementation)
    running.push(gateway)
    await gateway.start()
    const socket = await connect(`ws://127.0.0.1:${port}/v1/responses`, 'local-secret')
    const messages = collectMessages(socket)
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'hello' }))
    await waitFor(() => Boolean(upstreamSignal))
    socket.send(JSON.stringify({ type: 'response.cancel' }))
    await waitFor(() => messages.some((event) => event.type === 'response.cancelled'))
    await waitFor(() => upstreamSignal?.aborted === true)
    await waitFor(() => gateway.getStatus().activeRequests === 0)
    socket.close()
  })

  it('maps ordinary HTTP failures to WebSocket error events', async () => {
    const port = await freePort()
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      error: { type: 'invalid_request_error', code: 'bad_request', message: 'Rejected by upstream.' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const gateway = makeGateway(port, { responsesWebSocketEnabled: true }, fetchImplementation)
    running.push(gateway)
    await gateway.start()
    const socket = await connect(`ws://127.0.0.1:${port}/v1/responses`, 'local-secret')
    const messages = collectMessages(socket)
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'hello' }))
    await waitFor(() => messages.some((event) => event.type === 'error'))
    expect(messages.find((event) => event.type === 'error')).toMatchObject({
      status: 400,
      error: { code: 'bad_request' },
    })
    socket.close()
  })
})

function makeGateway(
  port: number,
  overrides: Partial<GatewaySettings>,
  fetchImplementation: typeof fetch,
  logs: RequestLog[] = [],
): GatewayServer {
  return new GatewayServer({
    config: config(port, overrides),
    credentialResolver: () => 'upstream-secret',
    fetchImplementation,
    onLog(log) {
      const index = logs.findIndex((candidate) => candidate.id === log.id)
      if (index >= 0) logs[index] = log
      else logs.push(log)
    },
  })
}

function config(port: number, overrides: Partial<GatewaySettings> = {}): GatewayConfig {
  const provider: ProviderDefinition = {
    id: 'provider', name: 'Provider', sourceType: 'relay', kind: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1', protocol: 'openai-responses', models: ['gpt-test'],
    createdAt: timestamp, updatedAt: timestamp,
  }
  const account: Account = {
    id: 'account', providerId: provider.id, name: 'Account', credentialId: 'credential', maskedCredential: '***',
    credentialType: 'api-key', status: 'active', priority: 1, weight: 1, maxConcurrency: 2, inFlight: 0,
    availableModels: ['gpt-test'], modelPolicy: 'all', modelAllowlist: [], createdAt: timestamp, updatedAt: timestamp,
  }
  const pool: Pool = {
    id: 'pool', name: 'Pool', kind: 'standard', protocol: 'openai-responses', strategy: 'priority',
    members: [{ accountId: account.id, enabled: true }], modelPolicy: 'all', modelAllowlist: [],
    stickySessions: true, stickyTtlMinutes: 30, maxRetries: 0, forceFastMode: true,
    createdAt: timestamp, updatedAt: timestamp,
  }
  const route: Route = {
    id: 'route', client: 'codex', enabled: true, poolId: pool.id, inboundProtocol: 'openai-responses',
    modelMap: {}, localToken: 'local-secret', createdAt: timestamp, updatedAt: timestamp,
  }
  return {
    providers: [provider], accounts: [account], pools: [pool], routes: [route],
    settings: {
      host: '127.0.0.1', port, autoStart: false, logPayloads: false, requestTimeoutSeconds: 5,
      responsesWebSocketEnabled: false, ...overrides,
    },
  }
}

function responsesSse(events: Record<string, unknown>[]): Response {
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(wire, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function expectUpgradeStatus(url: string, token: string, status: number): Promise<void> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  const actual = await new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => reject(new Error('WebSocket unexpectedly connected')))
    socket.once('error', () => undefined)
  })
  expect(actual).toBe(status)
  socket.terminate()
}

function collectMessages(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = []
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>))
  return messages
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function freePort(): Promise<number> {
  const server = createNodeServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to allocate port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
