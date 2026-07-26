import { createServer as createNodeServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Account,
  GatewaySettings,
  Pool,
  ProviderDefinition,
  Route,
} from '../../src/shared/types'
import { createCanonicalStreamParser, GatewayServer } from '../../src/main/gateway'
import type { GatewayConfig } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000
const runningServers: GatewayServer[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop({ force: true })))
  vi.restoreAllMocks()
})

describe('native Kiro Claude gateway transport', () => {
  it('converts an Anthropic non-streaming request and AWS EventStream response without leaking the wire dialect', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://kiro.example.test/generate-assistant-response')
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer credential-first')
      expect(headers.get('content-type')).toBe('application/x-amz-json-1.0')
      expect(headers.get('accept')).toBe('*/*')
      expect(headers.get('x-amz-target'))
        .toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse')

      const payload = JSON.parse(String(init?.body)) as KiroRequestBody
      expect(payload.conversationState.currentMessage.userInputMessage).toMatchObject({
        content: 'Hello from Claude',
        modelId: 'claude-sonnet-4.6',
        origin: 'KIRO_CLI',
      })
      expect(payload).not.toHaveProperty('stream')

      return kiroResponse(
        eventFrame('assistantResponseEvent', { content: 'Hello from Kiro' }),
        eventFrame('meteringEvent', { inputTokens: 5, outputTokens: 3 })
      )
    })
    const gateway = await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, { stream: false })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Kiro' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    })
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(gateway.getStatus().activeRequests).toBe(0)
  })

  it('converts a Kiro AWS EventStream response into an Anthropic Messages SSE stream', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn(async () => kiroResponse(
      eventFrame('assistantResponseEvent', { content: 'Streaming from Kiro' }),
      eventFrame('meteringEvent', { inputTokens: 7, outputTokens: 4 })
    ))
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, { stream: true })
    const wire = await response.text()
    const parser = createCanonicalStreamParser('anthropic-messages')
    const events = [
      ...parser.push(new TextEncoder().encode(wire)),
      ...parser.finish(),
    ]

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(events).toContainEqual({ type: 'text-delta', text: 'Streaming from Kiro' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage',
      inputTokens: 7,
      outputTokens: 4,
    }))
    expect(events).toContainEqual({ type: 'stop', reason: 'stop', rawReason: 'end_turn' })
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('uses x-claude-code-session-id as the native Kiro conversation identity', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as KiroRequestBody
      expect(payload.conversationState.conversationId).toBe('claude-code-session-42')
      return kiroResponse(eventFrame('assistantResponseEvent', { content: 'ok' }))
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, {}, {
      'x-claude-code-session-id': 'claude-code-session-42',
    })

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('fails over to a second Kiro account only when an exception arrives before output', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const usedCredentials: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const credential = new Headers(init?.headers).get('authorization') ?? ''
      usedCredentials.push(credential)
      if (credential === 'Bearer credential-first') {
        return kiroResponse(exceptionFrame('ThrottlingException', { message: 'slow down' }))
      }
      return kiroResponse(eventFrame('assistantResponseEvent', { content: 'second account' }))
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: 'second account' }],
    })
    expect(usedCredentials).toEqual([
      'Bearer credential-first',
      'Bearer credential-second',
    ])
  })

  it.each([
    {
      name: 'a later frame is truncated',
      firstResponse: () => {
        const truncatedFrame = eventFrame('meteringEvent', { inputTokens: 3, outputTokens: 2 })
          .subarray(0, 7)
        return kiroResponse(
          eventFrame('assistantResponseEvent', { content: 'buffered partial output' }),
          truncatedFrame
        )
      },
    },
    {
      name: 'the transport fails after an assistant frame',
      firstResponse: () => kiroResponseThenError(
        eventFrame('assistantResponseEvent', { content: 'buffered partial output' })
      ),
    },
  ])('fails over a buffered Kiro response when $name before downstream commit', async ({ firstResponse }) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const usedCredentials: string[] = []
    const states: Array<{ accountId: string; status: string }> = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const credential = new Headers(init?.headers).get('authorization') ?? ''
      usedCredentials.push(credential)
      if (credential === 'Bearer credential-first') {
        return firstResponse()
      }
      return kiroResponse(eventFrame('assistantResponseEvent', { content: 'healthy buffered output' }))
    })
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver: (selected) => `credential-${selected.id}`,
      fetchImplementation: upstreamFetch as typeof fetch,
      onAccountState: (state) => states.push({ accountId: state.accountId, status: state.status }),
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postMessages(port, { stream: false })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: 'healthy buffered output' }],
    })
    expect(usedCredentials).toEqual([
      'Bearer credential-first',
      'Bearer credential-second',
    ])
    expect(states).toContainEqual({ accountId: 'first', status: 'cooldown' })
  })

  it('does not switch accounts after streaming Kiro output is committed downstream', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn(async () => kiroResponse(
      eventFrame('assistantResponseEvent', { content: 'partial model output' }),
      exceptionFrame('ThrottlingException', { message: 'late failure' })
    ))
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, { stream: true })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('partial model output')
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'a healthy empty end_turn',
      frames: [initialResponseFrame()],
      expectedText: '',
    },
    {
      name: 'literal Continue output',
      frames: [eventFrame('assistantResponseEvent', { content: 'Continue' })],
      expectedText: 'Continue',
    },
  ])('does not retry $name', async ({ frames, expectedText }) => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const upstreamFetch = vi.fn(async () => kiroResponse(...frames))
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port)
    const payload = await response.json() as {
      content?: Array<{ type?: string; text?: string }>
      stop_reason?: string
    }

    expect(response.status).toBe(200)
    expect(payload.stop_reason).toBe('end_turn')
    expect(payload.content?.find((item) => item.type === 'text')?.text ?? '').toBe(expectedText)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('forces relay-aggregate Kiro pools sticky even when stickySessions is persisted false', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0] = {
      ...gatewayConfig.pools[0],
      kind: 'relay-aggregate',
      strategy: 'round-robin',
      stickySessions: false,
      maxRetries: 0,
    }
    const usedCredentials: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const credential = new Headers(init?.headers).get('authorization') ?? ''
      usedCredentials.push(credential)
      return kiroResponse(eventFrame('assistantResponseEvent', { content: credential }))
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const headers = { 'x-claude-code-session-id': 'sticky-claude-session' }
    const first = await postMessages(port, {}, headers)
    const second = await postMessages(port, {}, headers)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(usedCredentials).toEqual([
      'Bearer credential-first',
      'Bearer credential-first',
    ])
  })

  it('rejects a relay-aggregate Kiro request without a stable session before credential resolution or fetch', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    const credentialResolver = vi.fn(() => 'must-not-be-read')
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postMessages(port, {}, {}, { includeDefaultSession: false })

    expect([400, 422]).toContain(response.status)
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ message: expect.stringMatching(/session|conversation/i) }),
    })
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects a Kiro source whose native tool probe evidence was downgraded before credential resolution or fetch', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.providers[0] = {
      ...gatewayConfig.providers[0],
      toolRoundtripVerified: false,
    }
    const credentialResolver = vi.fn(() => 'must-not-be-read')
    const upstreamFetch = vi.fn()
    const gateway = new GatewayServer({
      config: gatewayConfig,
      credentialResolver,
      fetchImplementation: upstreamFetch as typeof fetch,
    })
    runningServers.push(gateway)
    await gateway.start()

    const response = await postMessages(port)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        message: 'Kiro Claude requires a relay that passed the native two-round tool probe.',
      },
    })
    expect(credentialResolver).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('retries a pre-output invalidStateEvent once on the same account with only a fresh conversation id', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].maxRetries = 0
    gatewayConfig.accounts[1].status = 'disabled'
    const requestPayloads: KiroRequestBody[] = []
    const usedCredentials: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestPayloads.push(JSON.parse(String(init?.body)) as KiroRequestBody)
      usedCredentials.push(new Headers(init?.headers).get('authorization') ?? '')
      if (requestPayloads.length === 1) {
        return kiroResponse(eventFrame('invalidStateEvent', {
          reason: 'INVALID_STATE',
          message: 'Conversation state is invalid.',
        }))
      }
      return kiroResponse(eventFrame('assistantResponseEvent', { content: 'recovered internally' }))
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, statefulAnthropicBody(), {
      'x-claude-code-session-id': 'stale-kiro-conversation',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: 'recovered internally' }],
    })
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(usedCredentials).toEqual([
      'Bearer credential-first',
      'Bearer credential-first',
    ])
    expect(requestPayloads[0].conversationState.conversationId).toBe('stale-kiro-conversation')
    expect(requestPayloads[1].conversationState.conversationId)
      .not.toBe(requestPayloads[0].conversationState.conversationId)
    expect(withoutConversationId(requestPayloads[1])).toEqual(withoutConversationId(requestPayloads[0]))
  })

  it('never turns a second invalidStateEvent into a third attempt or ordinary account failover', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].maxRetries = 3
    const usedCredentials: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      usedCredentials.push(new Headers(init?.headers).get('authorization') ?? '')
      return kiroResponse(eventFrame('invalidStateEvent', {
        reason: 'INVALID_STATE',
        message: 'Conversation state is still invalid.',
      }))
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, statefulAnthropicBody(), {
      'x-claude-code-session-id': 'twice-invalid-session',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(usedCredentials).toEqual([
      'Bearer credential-first',
      'Bearer credential-first',
    ])
  })

  it('streams a late invalidState error and closes without retrying after output', async () => {
    const port = await freePort()
    const gatewayConfig = config(port)
    gatewayConfig.pools[0].maxRetries = 3
    const usedCredentials: string[] = []
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      usedCredentials.push(new Headers(init?.headers).get('authorization') ?? '')
      return kiroResponse(
        eventFrame('assistantResponseEvent', { content: 'visible before failure' }),
        eventFrame('invalidStateEvent', {
          reason: 'INVALID_STATE',
          message: 'Late conversation state failure.',
        })
      )
    })
    await startGateway(gatewayConfig, upstreamFetch)

    const response = await postMessages(port, { stream: true }, {
      'x-claude-code-session-id': 'late-invalid-session',
    })
    const wire = await response.text()

    expect(response.status).toBe(200)
    expect(wire).toContain('visible before failure')
    expect(wire).toContain('event: error')
    expect(wire).toContain('Late conversation state failure.')
    expect(wire).not.toContain('event: message_stop')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(usedCredentials).toEqual(['Bearer credential-first'])
  })
})

async function startGateway(
  gatewayConfig: GatewayConfig,
  upstreamFetch: ReturnType<typeof vi.fn>
): Promise<GatewayServer> {
  const gateway = new GatewayServer({
    config: gatewayConfig,
    credentialResolver: (selected) => `credential-${selected.id}`,
    fetchImplementation: upstreamFetch as typeof fetch,
  })
  runningServers.push(gateway)
  await gateway.start()
  return gateway
}

function config(port: number, settings: Partial<GatewaySettings> = {}): GatewayConfig {
  const provider: ProviderDefinition = {
    id: 'kiro-provider',
    name: 'Kiro Claude',
    sourceType: 'relay',
    kind: 'kiro-compatible',
    baseUrl: 'https://kiro.example.test/generate-assistant-response',
    protocol: 'kiro-claude',
    models: ['claude-sonnet-4.6'],
    toolRoundtripVerified: true,
    capabilityProfile: {
      version: 1,
      origin: 'probed',
      checkedAt: timestamp,
      streaming: true,
      nonStreaming: true,
      toolCalls: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const accounts = [account('first', 1), account('second', 10)]
  const pool: Pool = {
    id: 'kiro-pool',
    name: 'Kiro aggregate',
    kind: 'relay-aggregate',
    protocol: 'kiro-claude',
    strategy: 'priority',
    members: accounts.map((item) => ({ accountId: item.id, enabled: true })),
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const route: Route = {
    id: 'claude-route',
    client: 'claude',
    enabled: true,
    poolId: pool.id,
    inboundProtocol: 'anthropic-messages',
    modelMap: { 'claude-desktop-model': 'claude-sonnet-4.6' },
    localToken: 'local-secret',
    createdAt: timestamp,
    updatedAt: timestamp,
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
      ...settings,
    },
  }
}

function account(id: string, priority: number): Account {
  return {
    id,
    providerId: 'kiro-provider',
    name: id,
    credentialId: `credential-${id}`,
    maskedCredential: '***',
    credentialType: 'api-key',
    status: 'active',
    priority,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['claude-sonnet-4.6'],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

async function postMessages(
  port: number,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  options: { includeDefaultSession?: boolean } = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'local-secret',
      'content-type': 'application/json',
      ...(options.includeDefaultSession === false
        ? {}
        : { 'x-claude-code-session-id': 'kiro-gateway-test-session' }),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: 'claude-desktop-model',
      max_tokens: 1_024,
      messages: [{ role: 'user', content: 'Hello from Claude' }],
      ...body,
    }),
  })
}

function statefulAnthropicBody(): Record<string, unknown> {
  return {
    system: 'Keep the request state byte-for-byte stable.',
    tools: [{
      name: 'lookup',
      description: 'Look up a value.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }],
    messages: [
      { role: 'user', content: 'Remember the first turn.' },
      { role: 'assistant', content: 'Remembered.' },
      { role: 'user', content: 'Now answer without losing the tools or history.' },
    ],
  }
}

function withoutConversationId(payload: KiroRequestBody): unknown {
  return {
    ...payload,
    conversationState: {
      ...payload.conversationState,
      conversationId: '<ignored>',
    },
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

function kiroResponse(...frames: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

function kiroResponseThenError(frame: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame)
    },
    pull(controller) {
      controller.error(new Error('simulated Kiro transport failure'))
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return assembleFrame(concat(
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', eventType),
    stringHeader(':content-type', 'application/json')
  ), jsonBytes(payload))
}

function initialResponseFrame(): Uint8Array {
  return assembleFrame(concat(
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', 'initial-response'),
    stringHeader(':content-type', 'application/json')
  ), new Uint8Array())
}

function exceptionFrame(exceptionType: string, payload: unknown): Uint8Array {
  return assembleFrame(concat(
    stringHeader(':message-type', 'exception'),
    stringHeader(':exception-type', exceptionType),
    stringHeader(':content-type', 'application/json')
  ), jsonBytes(payload))
}

function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const valueBytes = new TextEncoder().encode(value)
  return concat(
    Uint8Array.of(nameBytes.length),
    nameBytes,
    Uint8Array.of(7, valueBytes.length >>> 8, valueBytes.length & 0xff),
    valueBytes
  )
}

function assembleFrame(headers: Uint8Array, payload: Uint8Array): Uint8Array {
  const totalLength = 12 + headers.byteLength + payload.byteLength + 4
  const prelude = new Uint8Array(12)
  writeUint32(prelude, 0, totalLength)
  writeUint32(prelude, 4, headers.byteLength)
  writeUint32(prelude, 8, crc32(prelude.subarray(0, 8)))
  const withoutMessageCrc = concat(prelude, headers, payload)
  const messageCrc = new Uint8Array(4)
  writeUint32(messageCrc, 0, crc32(withoutMessageCrc))
  return concat(withoutMessageCrc, messageCrc)
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

interface KiroRequestBody {
  conversationState: {
    conversationId: string
    currentMessage: {
      userInputMessage: {
        content: string
        modelId: string
        origin: string
      }
    }
  }
}
