import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayServer, type GatewayConfig } from '../../src/main/gateway'
import { applyGatewaySettingsTransaction } from '../../src/main/ipc/gateway-settings-transaction'
import type { RequestLog } from '../../src/shared/types'

const servers: Server[] = []
const gateways: GatewayServer[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  return address.port
}

function configuration(port: number, upstream: number): GatewayConfig {
  return {
    settings: { host: '127.0.0.1', port, autoStart: false, logPayloads: false, requestTimeoutSeconds: 5 },
    providers: ['a', 'b'].map((id) => ({
      id, name: `Relay ${id}`, kind: 'openai-compatible', sourceType: 'relay', protocol: 'openai-responses',
      baseUrl: `http://127.0.0.1:${upstream}/${id}/v1`, models: ['test-model'], responsesCompactMode: 'auto', createdAt: 1, updatedAt: 1,
    })),
    accounts: ['a', 'b'].map((id) => ({
      id, providerId: id, name: id, credentialId: id, credentialType: 'api-key', maskedCredential: '***',
      status: 'active', priority: 1, weight: 1, maxConcurrency: 20, inFlight: 0,
      availableModels: [], modelPolicy: 'all', modelAllowlist: [], createdAt: 1, updatedAt: 1,
    })),
    // Provider-backed sources are materialized as pools at the gateway handoff.
    pools: ['a', 'b'].map((id) => ({ id, name: `Relay ${id}`, kind: 'standard', protocol: 'openai-responses',
      strategy: 'priority', members: [{ accountId: id, enabled: true }], modelPolicy: 'all', modelAllowlist: [],
      stickySessions: false, stickyTtlMinutes: 30, maxRetries: 0, createdAt: 1, updatedAt: 1 })),
    routes: [{ id: 'codex', client: 'codex', enabled: true, poolId: 'a', inboundProtocol: 'openai-responses',
      modelMap: {}, localToken: 'local-codex-only', createdAt: 1, updatedAt: 1 },
    { id: 'claude', client: 'claude', enabled: true, poolId: 'a', inboundProtocol: 'anthropic-messages',
      modelMap: { '*': 'test-model' }, localToken: 'local-claude-only', createdAt: 1, updatedAt: 1 }],
  }
}

describe('real loopback client business workflow', () => {
  it('keeps the old stream alive while new requests switch source and other clients remain isolated', async () => {
    const received: string[] = []
    let finishOldStream: (() => void) | undefined
    const terminal = (id: string) => `data: ${JSON.stringify({ type: 'response.completed', response: {
      id, object: 'response', model: 'test-model', status: 'completed', output: [],
    } })}\n\n`
    const upstream = createServer(async (request, response) => {
      for await (const chunk of request) void chunk
      received.push(request.url!)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (received.length === 1) {
        response.write('data: {"type":"response.created","response":{"id":"old","status":"in_progress","output":[]}}\n\n')
        finishOldStream = () => response.end(terminal('old'))
      } else response.end(terminal('new'))
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const config = configuration(port, upstreamPort)
    const logs = new Map<string, RequestLog>()
    const gateway = new GatewayServer({ config, credentialResolver: (account) => `upstream-${account.id}`,
      onLog: (log) => { logs.set(log.id, log) } })
    gateways.push(gateway)
    await gateway.start()
    const send = (token = 'local-codex-only') => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', input: 'Hello', stream: true }), signal: AbortSignal.timeout(5_000),
    })
    const old = await send()
    expect(old.status).toBe(200)
    const oldBody = old.text()
    config.routes = config.routes.map((route) => route.client === 'codex' ? { ...route, poolId: 'b' } : route)
    gateway.updateConfig(config)
    const next = await send()
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('response.completed')
    expect(gateway.getStatus().activeRequests).toBeGreaterThanOrEqual(1)
    // The other client's native entry still targets A while Codex targets B.
    const other = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer local-claude-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 32, messages: [{ role: 'user', content: 'Hello' }], stream: true }),
      signal: AbortSignal.timeout(5_000),
    })
    expect(other.status).toBe(200)
    await other.text()
    finishOldStream!()
    expect(await oldBody).toContain('response.completed')
    expect(received).toEqual(['/a/v1/responses', '/b/v1/responses', '/a/v1/responses'])
    await vi.waitFor(() => {
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(Object.values(gateway.getAccountInFlight()).every((count) => count === 0)).toBe(true)
      expect([...logs.values()].filter((log) => log.statusCode === 200 && log.status === 'success')).toHaveLength(3)
    })
  }, 10_000)

  it.each(['occupied-port', 'post-start-failure'] as const)('serves another real request on the old endpoint after %s', async (failure) => {
    const upstream = createServer(async (request, response) => {
      for await (const chunk of request) void chunk
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'recovered', object: 'response', status: 'completed', model: 'test-model', output: [] }))
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const occupied = createServer()
    const occupiedPort = await listen(occupied)
    if (failure === 'post-start-failure') await new Promise<void>((resolve) => occupied.close(() => resolve()))
    else servers.push(occupied)
    const config = configuration(port, upstreamPort)
    const previous = { ...config.settings }
    const gateway = new GatewayServer({ config, credentialResolver: () => 'controlled-key' })
    gateways.push(gateway)
    await gateway.start()
    await expect(applyGatewaySettingsTransaction({
      previous, wasRunning: true,
      apply: async () => {
        config.settings = { ...previous, port: occupiedPort }
        await gateway.stop()
        gateway.updateConfig(config)
        await gateway.start()
        throw new Error('Controlled post-start failure')
      },
      restoreSettings: async () => { config.settings = previous },
      restoreOutbound: () => undefined, restoreBackups: async () => undefined,
      refreshConfig: () => gateway.updateConfig(config), status: () => gateway.getStatus(),
      stop: () => gateway.stop(), start: () => gateway.start(), publishStatus: () => undefined,
    })).rejects.toThrow(failure === 'occupied-port' ? /EADDRINUSE|address already in use/i : /Controlled post-start failure/)
    expect(gateway.getStatus()).toMatchObject({ running: true, port })
    const resumed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer local-codex-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', input: 'Still connected', stream: false }), signal: AbortSignal.timeout(5_000),
    })
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toMatchObject({ id: 'recovered', status: 'completed' })
  }, 10_000)

  it.each(['http-error', 'client-cancel'] as const)('recovers the only selected relay after %s without leaking slots', async (failure) => {
    let calls = 0
    let abandonedStreamClosed = false
    const upstream = createServer(async (request, response) => {
      for await (const chunk of request) void chunk
      calls += 1
      if (calls === 1 && failure === 'http-error') {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Controlled upstream outage' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (calls === 1) {
        response.once('close', () => { abandonedStreamClosed = true })
        response.write('data: {"type":"response.created","response":{"id":"resp_cancel","object":"response","status":"in_progress","output":[]}}\n\n')
        return
      }
      response.end('data: {"type":"response.completed","response":{"id":"resp_recovered","object":"response","model":"test-model","status":"completed","output":[]}}\n\n')
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const config = configuration(port, upstreamPort)
    const logs = new Map<string, RequestLog>()
    const gateway = new GatewayServer({ config, credentialResolver: (account) => `upstream-${account.id}`,
      onLog: (entry) => { logs.set(entry.id, entry) } })
    gateways.push(gateway)
    await gateway.start()
    const send = (signal: AbortSignal) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer local-codex-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', input: [{ role: 'user', content: 'Hello' }], stream: true }), signal,
    })
    const controller = new AbortController()
    const first = await send(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
    if (failure === 'client-cancel') {
      expect(first.status).toBe(200)
      const reader = first.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      controller.abort()
      await reader.cancel().catch(() => undefined)
      await vi.waitFor(() => expect(abandonedStreamClosed).toBe(true))
    } else {
      expect(first.status).toBe(502)
      await first.text()
    }
    await vi.waitFor(() => {
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(gateway.getAccountInFlight(['a']).a ?? 0).toBe(0)
      expect([...logs.values()][0]?.statusCode).toBe(failure === 'client-cancel' ? 499 : 502)
    })
    const next = await send(AbortSignal.timeout(5_000))
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('response.completed')
    expect(calls).toBe(2)
    await vi.waitFor(() => {
      // Expected cancellation can intentionally be a yellow success in the UI;
      // the next request must independently finish with an actual HTTP 200.
      expect([...logs.values()].filter((log) => log.status === 'success' && log.statusCode === 200)).toHaveLength(1)
      expect(gateway.getStatus().activeRequests).toBe(0)
      expect(gateway.getAccountInFlight(['a']).a ?? 0).toBe(0)
    })
  }, 10_000)

  it('continues through tool output, relay switch, native compact and follow-up without disturbing another client', async () => {
    const received: Array<{ path: string; body: Record<string, unknown>; token?: string }> = []
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      received.push({ path: request.url!, body, token: request.headers.authorization })
      if (request.url!.endsWith('/responses/compact')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: 'opaque-from-b' }] }))
        return
      }
      const first = received.length === 1
      const output = first
        ? [{ type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{}' }]
        : [{ type: 'message', id: 'msg_reply', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'business-ok', annotations: [] }] }]
      const payload = { id: `resp_${received.length}`, object: 'response', model: 'test-model', status: 'completed', output,
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`)
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const config = configuration(port, upstreamPort)
    const logs = new Map<string, RequestLog>()
    const gateway = new GatewayServer({ config, credentialResolver: (account) => `upstream-${account.id}`, onLog: (entry) => { logs.set(entry.id, entry) } })
    gateways.push(gateway)
    await gateway.start()
    const send = (path: string, body: Record<string, unknown>, token = 'local-codex-only') => fetch(`http://127.0.0.1:${port}/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'session-id': 'business-flow-session' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    })
    const user = { role: 'user', content: 'Look up the result' }
    const initial = await send('responses', { model: 'test-model', input: [user], stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] })
    const initialBody = await initial.text()
    expect(initial.status, initialBody).toBe(200)
    expect(initialBody).toContain('call_lookup')
    const tool = { type: 'function_call', call_id: 'call_lookup', name: 'lookup', arguments: '{}' }
    const toolOutput = { type: 'function_call_output', call_id: 'call_lookup', output: 'found' }
    const answer = await send('responses', { model: 'test-model', input: [user, tool, toolOutput], stream: true })
    expect(answer.status).toBe(200)
    expect(await answer.text()).toContain('response.completed')
    expect(received[1].body.input).toEqual([user, tool, toolOutput])

    // Switch only Codex; the other client's route and credential stay on A.
    config.routes[0] = { ...config.routes[0], poolId: 'b', updatedAt: 2 }
    gateway.updateConfig(config)
    const compact = await send('responses/compact', { model: 'test-model', input: [user, tool, toolOutput] })
    expect(compact.status).toBe(200)
    const compactBody = await compact.json() as { output: Array<Record<string, unknown>> }
    expect(compactBody.output).toEqual([{ type: 'compaction', encrypted_content: 'opaque-from-b' }])
    const continuation = [...compactBody.output, { role: 'user', content: 'Continue' }]
    const followUp = await send('responses', { model: 'test-model', input: continuation, stream: true })
    expect(followUp.status).toBe(200)
    expect(await followUp.text()).toContain('response.completed')
    expect(received[3].body.input).toEqual(continuation)
    const claude = await send('messages', { model: 'claude-test', max_tokens: 32, messages: [{ role: 'user', content: 'Still here?' }] }, 'local-claude-only')
    expect(claude.status).toBe(200)
    expect(await claude.json()).toMatchObject({ content: [{ type: 'text', text: 'business-ok' }] })
    expect(received.map((entry) => entry.path)).toEqual([
      '/a/v1/responses', '/a/v1/responses', '/b/v1/responses/compact', '/b/v1/responses', '/a/v1/responses',
    ])
    expect(received.map((entry) => entry.token)).toEqual(['Bearer upstream-a', 'Bearer upstream-a', 'Bearer upstream-b', 'Bearer upstream-b', 'Bearer upstream-a'])
    await vi.waitFor(() => {
      expect(logs.size).toBe(5)
      expect([...logs.values()].every((log) => log.status === 'success')).toBe(true)
    })
    await vi.waitFor(() => expect(gateway.getStatus().activeRequests).toBe(0))
    expect(Object.values(gateway.getAccountInFlight()).every((count) => count === 0)).toBe(true)
  }, 15_000)
})
