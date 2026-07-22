import { isDeepStrictEqual } from 'node:util'
import type { Protocol } from '../../shared/types'
import { createCanonicalStreamParser } from './streaming'

type JsonObject = Record<string, unknown>

const SENSITIVE_KEY = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|private[-_]?key|agent[-_]?assertion)$/i
const CONTENT_KEY = /^(?:input|messages|prompt|instructions|content|text)$/i

export interface RequestReplayCapture {
  id: string
  path: string
  routeId: string
  body: JsonObject
  headers?: Record<string, string | undefined>
  createdAt?: number
}

export interface SanitizedRequestReplay {
  id: string
  path: string
  body: JsonObject
  headers: Record<string, string>
  createdAt: number
  expiresAt: number
  contentRedacted: boolean
}

export interface RequestReplayResult {
  ok: boolean
  status: number
  latencyMs: number
  responsePreview: string
}

export class RequestReplayStore {
  private readonly entries = new Map<string, StoredReplay>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxPayloadBytes: number

  public constructor(options: {
    now?: () => number
    ttlMs?: number
    maxEntries?: number
    maxPayloadBytes?: number
  } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.max(10_000, options.ttlMs ?? 30 * 60_000)
    this.maxEntries = Math.max(1, options.maxEntries ?? 50)
    this.maxPayloadBytes = Math.max(1_024, options.maxPayloadBytes ?? 1024 * 1024)
  }

  public capture(input: RequestReplayCapture): boolean {
    this.prune()
    if (!input.id.trim() || !input.path.startsWith('/')) return false
    const serialized = JSON.stringify(input.body)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) return false
    const createdAt = input.createdAt ?? this.now()
    this.entries.delete(input.id)
    this.entries.set(input.id, {
      id: input.id,
      path: input.path,
      routeId: input.routeId,
      body: JSON.parse(serialized) as JsonObject,
      headers: sanitizeHeaders(input.headers ?? {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs
    })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
    return true
  }

  public get(id: string, options: { includeContent?: boolean } = {}): SanitizedRequestReplay | undefined {
    this.prune()
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const includeContent = options.includeContent === true
    const body = redactValue(entry.body, includeContent, '') as JsonObject
    return {
      id: entry.id,
      path: entry.path,
      body,
      headers: { ...entry.headers },
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      contentRedacted: !includeContent && !isDeepStrictEqual(body, entry.body)
    }
  }

  public async replay(input: {
    id: string
    baseUrl: string
    localToken: string
    fetchImplementation?: typeof fetch
    signal?: AbortSignal
  }): Promise<RequestReplayResult> {
    this.prune()
    const entry = this.entries.get(input.id)
    if (!entry) throw new Error('Replay payload is unavailable or has expired')
    const url = new URL(entry.path, ensureTrailingSlash(input.baseUrl))
    if (!isLoopback(url.hostname)) throw new Error('Request replay is restricted to the local Stone+ gateway')
    const startedAt = this.now()
    const response = await (input.fetchImplementation ?? fetch)(url, {
      method: 'POST',
      headers: {
        ...entry.headers,
        authorization: `Bearer ${input.localToken}`,
        'content-type': 'application/json',
        'x-stone-replay-of': entry.id
      },
      body: JSON.stringify(entry.body),
      signal: input.signal
    })
    const consumed = await consumeReplayResponse(
      response,
      replayProtocol(entry.path),
      16 * 1024,
      input.signal,
      replayExpectsStreaming(entry.path, entry.body),
      replayIsCompactPath(entry.path)
    )
    return {
      ok: response.ok && consumed.completed,
      status: response.status,
      latencyMs: Math.max(0, this.now() - startedAt),
      responsePreview: stripUnsafeControls(consumed.preview)
    }
  }

  /** Internal routing metadata; never exposed by the renderer-facing template. */
  public routeId(id: string): string | undefined {
    this.prune()
    return this.entries.get(id)?.routeId
  }

  public delete(id: string): void {
    this.entries.delete(id)
  }

  public clear(): void {
    this.entries.clear()
  }

  private prune(): void {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id)
    }
  }
}

interface StoredReplay {
  id: string
  path: string
  routeId: string
  body: JsonObject
  headers: Record<string, string>
  createdAt: number
  expiresAt: number
}

function redactValue(value: unknown, includeContent: boolean, key: string): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (!includeContent && CONTENT_KEY.test(key)) return redactContentShape(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, includeContent, key))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, includeContent, childKey)
    ]))
  }
  return value
}

function redactContentShape(value: unknown): unknown {
  if (typeof value === 'string') return '[CONTENT REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactContentShape(item))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (/^(?:type|role|name|id)$/i.test(key)) return [key, child]
      return [key, redactContentShape(child)]
    }))
  }
  return value
}

function sanitizeHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const allowed = new Set([
    'accept',
    'openai-beta',
    'x-codex-beta-features',
    'x-openai-internal-codex-responses-lite',
    'x-stainless-helper-method'
  ])
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .filter(([key, value]) => allowed.has(key) && typeof value === 'string' && value.length <= 512) as Array<[string, string]>)
}

type JsonToken =
  | { kind: 'string'; value: string }
  | { kind: 'number' }
  | { kind: 'literal'; value: 'true' | 'false' | 'null' }
  | { kind: 'punctuation'; value: '{' | '}' | '[' | ']' | ':' | ',' }

type JsonContainer = {
  kind: 'object'
  state: 'key' | 'colon' | 'value' | 'comma'
  allowEnd: boolean
  key?: string
} | {
  kind: 'array'
  state: 'value' | 'comma'
  allowEnd: boolean
}

type RootJsonField = { type: 'string'; value: string } | { type: 'object' | 'array' | 'number' | 'boolean' | 'null' }

/**
 * Incremental JSON/protocol validator used only by request replay. It retains
 * nesting state and a handful of root field markers, never the response body.
 */
class StreamingProtocolJsonValidator {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly stack: JsonContainer[] = []
  private readonly rootFields = new Map<string, RootJsonField>()
  private invalid = false
  private rootStarted = false
  private rootComplete = false
  private mode: 'normal' | 'string' | 'number' | 'literal' = 'normal'
  private stringValue = ''
  private escaped = false
  private unicodeRemaining = 0
  private unicodeValue = 0
  private numberState: 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponent-sign' | 'exponent-digits' = 'integer'
  private literal = ''
  private literalIndex = 0

  constructor(
    private readonly protocol: Protocol | undefined,
    private readonly compactResponse: boolean
  ) {}

  push(chunk: Uint8Array): void {
    if (this.invalid) return
    try {
      this.consumeText(this.decoder.decode(chunk, { stream: true }))
    } catch {
      this.invalid = true
    }
  }

  finish(): void {
    if (this.invalid) return
    try {
      this.consumeText(this.decoder.decode())
      if (this.mode === 'number') this.finishNumber()
      else if (this.mode !== 'normal') this.invalid = true
      if (!this.rootComplete || this.stack.length !== 0) this.invalid = true
    } catch {
      this.invalid = true
    }
  }

  isValid(): boolean {
    if (this.invalid || !this.rootComplete) return false
    if (!this.protocol) return true
    if (this.protocol === 'openai-responses') {
      if (this.compactResponse) return this.rootFields.get('output')?.type === 'array'
      const status = this.rootFields.get('status')
      return status?.type === 'string' && (status.value === 'completed' || status.value === 'incomplete')
    }
    if (this.protocol === 'openai-chat') return this.rootFields.get('choices')?.type === 'array'
    if (this.protocol === 'anthropic-messages') return this.rootFields.get('content')?.type === 'array'
    return this.rootFields.get('candidates')?.type === 'array'
      || this.rootFields.get('promptFeedback')?.type === 'object'
      || this.rootFields.get('prompt_feedback')?.type === 'object'
  }

  private consumeText(text: string): void {
    let index = 0
    while (index < text.length && !this.invalid) {
      const character = text[index]
      if (this.mode === 'string') {
        this.consumeStringCharacter(character)
        index += 1
        continue
      }
      if (this.mode === 'literal') {
        this.consumeLiteralCharacter(character)
        index += 1
        continue
      }
      if (this.mode === 'number') {
        if (this.consumeNumberCharacter(character)) index += 1
        continue
      }
      if (/\s/.test(character)) {
        index += 1
        continue
      }
      if (character === '"') {
        this.mode = 'string'
        this.stringValue = ''
        this.escaped = false
        this.unicodeRemaining = 0
        index += 1
        continue
      }
      if (character === '-' || /[0-9]/.test(character)) {
        this.startNumber(character)
        index += 1
        continue
      }
      if (character === 't' || character === 'f' || character === 'n') {
        this.literal = character === 't' ? 'true' : character === 'f' ? 'false' : 'null'
        this.literalIndex = 1
        this.mode = 'literal'
        index += 1
        continue
      }
      if ('{}[]:,'.includes(character)) {
        this.consumeToken({ kind: 'punctuation', value: character as Extract<JsonToken, { kind: 'punctuation' }>['value'] })
        index += 1
        continue
      }
      this.invalid = true
    }
  }

  private consumeStringCharacter(character: string): void {
    if (this.unicodeRemaining > 0) {
      if (!/[0-9a-f]/i.test(character)) {
        this.invalid = true
        return
      }
      this.unicodeValue = this.unicodeValue * 16 + Number.parseInt(character, 16)
      this.unicodeRemaining -= 1
      if (this.unicodeRemaining === 0) this.appendString(String.fromCharCode(this.unicodeValue))
      return
    }
    if (this.escaped) {
      this.escaped = false
      if (character === 'u') {
        this.unicodeRemaining = 4
        this.unicodeValue = 0
        return
      }
      const escape = ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[character]
      if (escape === undefined) this.invalid = true
      else this.appendString(escape)
      return
    }
    if (character === '\\') {
      this.escaped = true
      return
    }
    if (character === '"') {
      const value = this.stringValue
      this.mode = 'normal'
      this.consumeToken({ kind: 'string', value })
      return
    }
    if (character.charCodeAt(0) < 0x20) {
      this.invalid = true
      return
    }
    this.appendString(character)
  }

  private appendString(value: string): void {
    // Root protocol keys/status values are tiny. Capping retained token text
    // keeps even a pathological multi-megabyte JSON string O(1) in memory.
    if (this.stringValue.length < 512) this.stringValue += value.slice(0, 512 - this.stringValue.length)
  }

  private consumeLiteralCharacter(character: string): void {
    if (character !== this.literal[this.literalIndex]) {
      this.invalid = true
      return
    }
    this.literalIndex += 1
    if (this.literalIndex !== this.literal.length) return
    const literal = this.literal as 'true' | 'false' | 'null'
    this.mode = 'normal'
    this.consumeToken({ kind: 'literal', value: literal })
  }

  private startNumber(character: string): void {
    this.mode = 'number'
    this.numberState = character === '-' ? 'minus' : character === '0' ? 'zero' : 'integer'
  }

  /** Returns true when the current character belongs to the number token. */
  private consumeNumberCharacter(character: string): boolean {
    const digit = /[0-9]/.test(character)
    switch (this.numberState) {
      case 'minus':
        if (!digit) return this.failNumber()
        this.numberState = character === '0' ? 'zero' : 'integer'
        return true
      case 'zero':
        if (character === '.') { this.numberState = 'dot'; return true }
        if (character === 'e' || character === 'E') { this.numberState = 'exponent'; return true }
        if (digit) return this.failNumber()
        return this.finishNumberAndReprocess()
      case 'integer':
        if (digit) return true
        if (character === '.') { this.numberState = 'dot'; return true }
        if (character === 'e' || character === 'E') { this.numberState = 'exponent'; return true }
        return this.finishNumberAndReprocess()
      case 'dot':
        if (!digit) return this.failNumber()
        this.numberState = 'fraction'
        return true
      case 'fraction':
        if (digit) return true
        if (character === 'e' || character === 'E') { this.numberState = 'exponent'; return true }
        return this.finishNumberAndReprocess()
      case 'exponent':
        if (character === '+' || character === '-') { this.numberState = 'exponent-sign'; return true }
        if (!digit) return this.failNumber()
        this.numberState = 'exponent-digits'
        return true
      case 'exponent-sign':
        if (!digit) return this.failNumber()
        this.numberState = 'exponent-digits'
        return true
      case 'exponent-digits':
        if (digit) return true
        return this.finishNumberAndReprocess()
    }
  }

  private failNumber(): true {
    this.invalid = true
    return true
  }

  private finishNumberAndReprocess(): false {
    this.finishNumber()
    return false
  }

  private finishNumber(): void {
    if (!['zero', 'integer', 'fraction', 'exponent-digits'].includes(this.numberState)) {
      this.invalid = true
      return
    }
    this.mode = 'normal'
    this.consumeToken({ kind: 'number' })
  }

  private consumeToken(token: JsonToken): void {
    if (this.invalid) return
    if (this.stack.length === 0) {
      if (this.rootStarted || token.kind !== 'punctuation' || token.value !== '{') {
        this.invalid = true
        return
      }
      this.rootStarted = true
      this.stack.push({ kind: 'object', state: 'key', allowEnd: true })
      return
    }
    const context = this.stack[this.stack.length - 1]
    if (context.kind === 'object') this.consumeObjectToken(context, token)
    else this.consumeArrayToken(context, token)
  }

  private consumeObjectToken(context: Extract<JsonContainer, { kind: 'object' }>, token: JsonToken): void {
    if (context.state === 'key') {
      if (token.kind === 'punctuation' && token.value === '}' && context.allowEnd) {
        this.closeContainer('object')
      } else if (token.kind === 'string') {
        context.key = token.value
        context.state = 'colon'
        context.allowEnd = false
      } else this.invalid = true
      return
    }
    if (context.state === 'colon') {
      if (token.kind === 'punctuation' && token.value === ':') context.state = 'value'
      else this.invalid = true
      return
    }
    if (context.state === 'value') {
      this.consumeValue(context, token)
      return
    }
    if (token.kind === 'punctuation' && token.value === ',') {
      context.state = 'key'
      context.allowEnd = false
    } else if (token.kind === 'punctuation' && token.value === '}') {
      this.closeContainer('object')
    } else this.invalid = true
  }

  private consumeArrayToken(context: Extract<JsonContainer, { kind: 'array' }>, token: JsonToken): void {
    if (context.state === 'value') {
      if (token.kind === 'punctuation' && token.value === ']' && context.allowEnd) {
        this.closeContainer('array')
      } else {
        this.consumeValue(context, token)
        context.allowEnd = false
      }
      return
    }
    if (token.kind === 'punctuation' && token.value === ',') {
      context.state = 'value'
      context.allowEnd = false
    } else if (token.kind === 'punctuation' && token.value === ']') {
      this.closeContainer('array')
    } else this.invalid = true
  }

  private consumeValue(context: JsonContainer, token: JsonToken): void {
    let field: RootJsonField | undefined
    if (token.kind === 'string') field = { type: 'string', value: token.value }
    else if (token.kind === 'number') field = { type: 'number' }
    else if (token.kind === 'literal') field = { type: token.value === 'null' ? 'null' : 'boolean' }
    else if (token.value === '{') field = { type: 'object' }
    else if (token.value === '[') field = { type: 'array' }
    else {
      this.invalid = true
      return
    }
    if (this.stack.length === 1 && context.kind === 'object' && context.key) {
      this.rootFields.set(context.key, field)
    }
    context.state = 'comma'
    if (token.kind === 'punctuation' && token.value === '{') {
      this.stack.push({ kind: 'object', state: 'key', allowEnd: true })
    } else if (token.kind === 'punctuation' && token.value === '[') {
      this.stack.push({ kind: 'array', state: 'value', allowEnd: true })
    }
  }

  private closeContainer(kind: JsonContainer['kind']): void {
    if (this.stack[this.stack.length - 1]?.kind !== kind) {
      this.invalid = true
      return
    }
    this.stack.pop()
    if (this.stack.length === 0) this.rootComplete = true
  }
}

async function consumeReplayResponse(
  response: Response,
  protocol: Protocol | undefined,
  maxPreviewBytes: number,
  signal?: AbortSignal,
  expectedStreaming = false,
  compactResponse = false
): Promise<{ preview: string; completed: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { preview: '', completed: false }
  const previewChunks: Buffer[] = []
  let previewBytes = 0
  const streamResponse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true
  const parser = response.ok && expectedStreaming && streamResponse && protocol
    ? createCanonicalStreamParser(protocol)
    : undefined
  const jsonValidator = response.ok && !expectedStreaming
    ? new StreamingProtocolJsonValidator(protocol, compactResponse)
    : undefined
  let protocolError = false
  let canonicalDone = false
  let reachedEof = false
  let failure: unknown
  const observe = (chunk: Uint8Array): void => {
    if (parser) {
      for (const event of parser.push(chunk)) {
        if (event.type === 'error') protocolError = true
        if (event.type === 'done') canonicalDone = true
      }
    } else if (jsonValidator) {
      jsonValidator.push(chunk)
    }
  }
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const chunk = signal
        ? await waitForReplayRead(reader.read(), signal)
        : await reader.read()
      if (chunk.done) {
        reachedEof = true
        break
      }
      observe(chunk.value)
      if (previewBytes < maxPreviewBytes) {
        const bytes = chunk.value.subarray(0, maxPreviewBytes - previewBytes)
        previewChunks.push(Buffer.from(bytes))
        previewBytes += bytes.byteLength
      }
    }
    if (parser) {
      for (const event of parser.finish()) {
        if (event.type === 'error') protocolError = true
        if (event.type === 'done') canonicalDone = true
      }
    }
    jsonValidator?.finish()
    const state = parser?.getProtocolState()
    const completed = !response.ok
      ? false
      : expectedStreaming
        ? !parser
          ? false
          : protocol === 'openai-responses'
          ? (state?.responsesTerminalEvent === 'response.completed'
            || state?.responsesTerminalEvent === 'response.incomplete') && !protocolError
          : canonicalDone && !protocolError
        : jsonValidator?.isValid() === true
    return { preview: Buffer.concat(previewChunks, previewBytes).toString('utf8'), completed }
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (!reachedEof) cancelAndReleaseReader(reader, failure ?? signal?.reason)
    else reader.releaseLock()
  }
}

function replayExpectsStreaming(path: string, body: JsonObject): boolean {
  const pathname = new URL(path, 'http://127.0.0.1').pathname
  return body.stream === true || /:streamGenerateContent$/.test(pathname)
}

function replayIsCompactPath(value: string): boolean {
  try {
    return new URL(value, 'http://127.0.0.1').pathname === '/v1/responses/compact'
  } catch {
    return false
  }
}

async function waitForReplayRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  let listener: (() => void) | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(abortReason(signal))
        signal.addEventListener('abort', listener, { once: true })
      })
    ])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The replay was aborted.', 'AbortError')
}

function replayProtocol(path: string): Protocol | undefined {
  const pathname = new URL(path, 'http://127.0.0.1').pathname
  if (pathname === '/v1/responses' || pathname === '/v1/responses/compact') return 'openai-responses'
  if (pathname === '/v1/chat/completions') return 'openai-chat'
  if (pathname === '/v1/messages') return 'anthropic-messages'
  if (/^\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(pathname)) return 'gemini'
  return undefined
}

function cancelAndReleaseReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  const cancellation = reader.cancel(reason).catch(() => undefined)
  const release = (): void => {
    try { reader.releaseLock() } catch { /* cancellation may still own the lock */ }
  }
  queueMicrotask(release)
  void cancellation.finally(release)
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function stripUnsafeControls(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32
  }).join('')
}
