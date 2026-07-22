import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

type JsonObject = Record<string, unknown>

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
const MAX_QUEUED_TURNS = 32
const MAX_QUEUED_PAYLOAD_BYTES = 128 * 1024 * 1024
const MAX_BUFFERED_SEND_BYTES = 8 * 1024 * 1024
const RESUME_BUFFERED_SEND_BYTES = 2 * 1024 * 1024

export interface ResponsesWebSocketAuthentication {
  ok: boolean
  statusCode?: number
  message?: string
}

export interface ResponsesWebSocketDispatchInput {
  body: JsonObject
  headers: IncomingHttpHeaders
  signal: AbortSignal
}

export interface ResponsesWebSocketAdapterOptions {
  server: Server
  enabled: () => boolean
  authenticate: (request: IncomingMessage) => ResponsesWebSocketAuthentication
  dispatch: (input: ResponsesWebSocketDispatchInput) => Promise<Response>
  maxPayloadBytes?: number
}

/**
 * Downstream Responses WebSocket transport. Each response.create is dispatched
 * through the ordinary HTTP Responses pipeline supplied by GatewayServer, so
 * routing, scheduling, credentials, retries, telemetry and stall detection stay
 * single-sourced.
 */
export class ResponsesWebSocketAdapter {
  private readonly wss: WebSocketServer
  private readonly server: Server
  private readonly options: ResponsesWebSocketAdapterOptions
  private readonly upgradeListener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  private closed = false

  constructor(options: ResponsesWebSocketAdapterOptions) {
    this.options = options
    this.server = options.server
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: Math.max(1, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
      perMessageDeflate: false,
    })
    this.upgradeListener = (request, socket, head) => this.handleUpgrade(request, socket, head)
    this.server.on('upgrade', this.upgradeListener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.server.off('upgrade', this.upgradeListener)
    for (const client of this.wss.clients) client.terminate()
    this.wss.close()
  }

  closeClients(code = 1012, reason = 'Responses WebSocket mode disabled'): void {
    for (const client of this.wss.clients) client.close(code, reason)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed) return rejectUpgrade(socket, 503, 'Gateway is stopping')
    if (requestPathname(request.url) !== '/v1/responses') return rejectUpgrade(socket, 404, 'Route not found')
    if (!this.options.enabled()) return rejectUpgrade(socket, 404, 'Responses WebSocket mode is disabled')
    const auth = this.options.authenticate(request)
    if (!auth.ok) return rejectUpgrade(socket, auth.statusCode ?? 401, auth.message ?? 'Invalid local gateway token')
    this.wss.handleUpgrade(request, socket, head, (webSocket) => {
      this.wss.emit('connection', webSocket, request)
      this.attachConnection(webSocket, request)
    })
  }

  private attachConnection(webSocket: WebSocket, request: IncomingMessage): void {
    const queued: Array<{ body: JsonObject; byteLength: number }> = []
    let queuedPayloadBytes = 0
    const dispatchHeaders: IncomingHttpHeaders = {
      ...request.headers,
      'x-stone-session-id': firstHeader(request.headers['x-stone-session-id']) ?? `ws_${randomUUID()}`,
    }
    let inFlight: AbortController | undefined
    let closed = false

    const dispatchNext = (): void => {
      if (closed || inFlight || queued.length === 0) return
      const queuedTurn = queued.shift()!
      queuedPayloadBytes = Math.max(0, queuedPayloadBytes - queuedTurn.byteLength)
      const body = queuedTurn.body
      const controller = new AbortController()
      inFlight = controller
      void this.options.dispatch({ body, headers: dispatchHeaders, signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            await sendJson(webSocket, await responseErrorEvent(response), controller.signal)
            return
          }
          await forwardResponsesSse(response, async (event) => {
            if (!await sendJson(webSocket, event, controller.signal)) {
              throw new DOMException('WebSocket disconnected', 'AbortError')
            }
          }, controller.signal)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || closed) return
          void sendJson(webSocket, errorEvent(502, 'websocket_dispatch_error', safeErrorMessage(error)))
        })
        .finally(() => {
          if (inFlight === controller) inFlight = undefined
          dispatchNext()
        })
    }

    webSocket.on('message', (raw, isBinary) => {
      if (isBinary) {
        void sendJson(webSocket, errorEvent(400, 'invalid_message', 'Binary messages are not supported.'))
        return
      }
      const parsed = parseClientEvent(raw)
      if (!parsed.ok) {
        void sendJson(webSocket, errorEvent(400, 'invalid_message', parsed.message))
        return
      }
      if (parsed.kind === 'cancel') {
        if (inFlight && !inFlight.signal.aborted) inFlight.abort(new DOMException('Client cancelled response', 'AbortError'))
        queued.length = 0
        queuedPayloadBytes = 0
        void sendJson(webSocket, { type: 'response.cancelled' })
        return
      }
      const byteLength = rawDataByteLength(raw)
      if (queued.length >= MAX_QUEUED_TURNS) {
        void sendJson(webSocket, errorEvent(429, 'websocket_queue_full', 'Too many response.create events are queued.'))
        return
      }
      if (queuedPayloadBytes + byteLength > MAX_QUEUED_PAYLOAD_BYTES) {
        void sendJson(webSocket, errorEvent(429, 'websocket_queue_full', 'The queued response.create payload budget is full.'))
        return
      }
      queued.push({ body: parsed.body, byteLength })
      queuedPayloadBytes += byteLength
      dispatchNext()
    })
    webSocket.once('close', () => {
      closed = true
      queued.length = 0
      queuedPayloadBytes = 0
      if (inFlight && !inFlight.signal.aborted) inFlight.abort(new DOMException('WebSocket disconnected', 'AbortError'))
    })
    webSocket.once('error', () => {
      if (inFlight && !inFlight.signal.aborted) inFlight.abort(new DOMException('WebSocket failed', 'AbortError'))
    })
  }
}

export type ParsedResponsesWebSocketEvent =
  | { ok: true; kind: 'create'; body: JsonObject }
  | { ok: true; kind: 'cancel' }
  | { ok: false; message: string }

export function parseClientEvent(raw: RawData): ParsedResponsesWebSocketEvent {
  let value: unknown
  try {
    value = JSON.parse(rawDataText(raw))
  } catch {
    return { ok: false, message: 'Messages must contain one valid JSON object.' }
  }
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return { ok: false, message: 'A message type is required.' }
  }
  if (value.type === 'response.cancel') return { ok: true, kind: 'cancel' }
  if (value.type !== 'response.create') {
    return { ok: false, message: `Unsupported message type: ${value.type}.` }
  }
  if (Object.hasOwn(value, 'stream') || Object.hasOwn(value, 'background')) {
    return { ok: false, message: 'stream and background are not used in Responses WebSocket mode.' }
  }
  if (typeof value.model !== 'string' || !value.model.trim()) {
    return { ok: false, message: 'response.create requires a model.' }
  }
  const { type: _type, ...body } = value
  return { ok: true, kind: 'create', body: { ...body, model: value.model.trim(), stream: true } }
}

/** Convert an ordinary Responses SSE body into one JSON message per server event. */
export async function forwardResponsesSse(
  response: Response,
  onEvent: (event: JsonObject) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error('The Responses stream has no body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let reachedEof = false
  let failure: unknown
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) {
        reachedEof = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const consumed = consumeSseFrames(buffer)
      buffer = consumed.remainder
      for (const event of consumed.events) await onEvent(event)
    }
    buffer += decoder.decode()
    const consumed = consumeSseFrames(`${buffer}\n\n`)
    for (const event of consumed.events) await onEvent(event)
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (!reachedEof) cancelAndReleaseReader(reader, failure ?? signal?.reason)
    else reader.releaseLock()
  }
}

function consumeSseFrames(buffer: string): { remainder: string; events: JsonObject[] } {
  const events: JsonObject[] = []
  let cursor = 0
  while (true) {
    const match = /\r?\n\r?\n/g.exec(buffer.slice(cursor))
    if (!match) return { remainder: buffer.slice(cursor), events }
    const boundary = cursor + match.index
    const frame = buffer.slice(cursor, boundary)
    cursor = boundary + match[0].length
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    try {
      const event: unknown = JSON.parse(data)
      if (isJsonObject(event)) events.push(event)
    } catch {
      throw new Error('The Responses stream contained invalid JSON.')
    }
  }
}

async function responseErrorEvent(response: Response): Promise<JsonObject> {
  let payload: unknown
  try { payload = await response.json() } catch { payload = undefined }
  const candidate = isJsonObject(payload) && isJsonObject(payload.error) ? payload.error : undefined
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : typeof candidate?.type === 'string' ? candidate.type : 'upstream_error'
  const message = typeof candidate?.message === 'string' ? candidate.message : `Request failed with HTTP ${response.status}.`
  return errorEvent(response.status, code, message, candidate?.param)
}

function errorEvent(status: number, code: string, message: string, param?: unknown): JsonObject {
  return {
    type: 'error',
    status,
    error: {
      type: 'invalid_request_error',
      code,
      message,
      ...(typeof param === 'string' ? { param } : {}),
    },
  }
}

async function sendJson(webSocket: WebSocket, payload: JsonObject, signal?: AbortSignal): Promise<boolean> {
  if (webSocket.readyState !== WebSocket.OPEN || signal?.aborted) return false
  const encoded = JSON.stringify(payload)
  if (webSocket.bufferedAmount > MAX_BUFFERED_SEND_BYTES
    || webSocket.bufferedAmount + Buffer.byteLength(encoded, 'utf8') > MAX_BUFFERED_SEND_BYTES) {
    const writable = await waitForWebSocketCapacity(webSocket, signal)
    if (!writable) return false
  }
  webSocket.send(encoded)
  return true
}

async function waitForWebSocketCapacity(webSocket: WebSocket, signal?: AbortSignal): Promise<boolean> {
  while (webSocket.readyState === WebSocket.OPEN && !signal?.aborted) {
    if (webSocket.bufferedAmount <= RESUME_BUFFERED_SEND_BYTES) return true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4)
      timer.unref?.()
    })
  }
  return false
}

function cancelAndReleaseReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  const cancellation = reader.cancel(reason).catch(() => undefined)
  const release = (): void => {
    try { reader.releaseLock() } catch { /* cancellation may still own the lock */ }
  }
  queueMicrotask(release)
  void cancellation.finally(release)
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ error: { message, type: statusCode === 401 ? 'authentication_error' : 'not_found_error' } })
  const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 503 ? 'Service Unavailable' : 'Not Found'
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

function requestPathname(value: string | undefined): string {
  try { return new URL(value ?? '/', 'http://127.0.0.1').pathname } catch { return '/' }
}

function rawDataText(value: RawData): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return Buffer.concat(value).toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
}

function rawDataByteLength(value: RawData): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Array.isArray(value)) return value.reduce((total, chunk) => total + chunk.byteLength, 0)
  return value.byteLength
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 320)
  return 'The Responses WebSocket request failed.'
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() ? first.trim() : undefined
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
