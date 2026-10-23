import { randomBytes, randomUUID } from 'node:crypto'
import type {
  ApiSourceToolRoundtripDiagnostics,
} from '@shared/types'
import {
  createCanonicalStreamParser,
  type CanonicalStopReason,
  type CanonicalStreamEvent,
} from '../gateway/streaming'
import type { ProviderAdapter } from '../providers'

const PROBE_TOOL_NAME = 'stone_anthropic_probe'
const MAX_PROBE_STREAM_BYTES = 4 * 1024 * 1024
const MAX_PROBE_TEXT_CHARACTERS = 1024 * 1024
const MAX_PROBE_ARGUMENT_CHARACTERS = 256 * 1024
const SAFE_PROBE_VALUE = /^[A-Za-z0-9._:-]+$/
const TOOL_RESULT_PLACEHOLDER = /\[\s*TOOL\s+RESULTS?\s+INCLUDED\s*\]/i
const CONTINUE_PLACEHOLDER = /^\s*(?:continue|继续)[.!。]?\s*$/iu

export interface AnthropicToolProbeValues {
  sessionId: string
  proof: string
}

export type AnthropicToolProbeFailureKind =
  | 'configuration'
  | 'transport'
  | 'authentication'
  | 'http'
  | 'invalid-response'
  | 'roundtrip'

export class AnthropicToolProbeFailure extends Error {
  constructor(
    readonly kind: AnthropicToolProbeFailureKind,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'AnthropicToolProbeFailure'
  }
}

export interface AnthropicToolProbeOptions {
  baseUrl: string
  credential: string
  model: string
  adapter: ProviderAdapter
  fetchImplementation: typeof fetch
  timeoutMs: number
  now: () => number
  createProbeValues?: () => AnthropicToolProbeValues
}

export interface AnthropicToolProbeResult {
  latencyMs: number
  diagnostics: ApiSourceToolRoundtripDiagnostics
}

interface CollectedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface CollectedAnthropicResponse {
  text: string
  tools: CollectedToolCall[]
  stopReason: CanonicalStopReason | undefined
}

interface MutableToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Runs an actual streaming Anthropic tool round trip. This is intentionally
 * separate from the generic one-turn model probe: an Anthropic-compatible
 * relay may generate text successfully while corrupting tool_result history.
 */
export async function probeAnthropicMessagesToolRoundtrip(
  options: AnthropicToolProbeOptions,
): Promise<AnthropicToolProbeResult> {
  if (options.adapter.kind !== 'anthropic-compatible') {
    throw new AnthropicToolProbeFailure(
      'configuration',
      'Anthropic 两轮工具链检测仅支持 anthropic-compatible 中转。',
    )
  }

  const startedAt = options.now()
  const values = safeProbeValues(options.createProbeValues?.() ?? defaultProbeValues())
  const endpoint = options.adapter.buildEndpoint({
    baseUrl: options.baseUrl,
    protocol: 'anthropic-messages',
    operation: 'generate',
    model: options.model,
    stream: true,
  })
  const signal = AbortSignal.timeout(options.timeoutMs)

  const firstResponse = await postAnthropicRequest({
    endpoint,
    credential: options.credential,
    adapter: options.adapter,
    fetchImplementation: options.fetchImplementation,
    sessionId: values.sessionId,
    body: firstTurnBody(options.model, values.proof),
    signal,
  })
  const first = await collectAnthropicResponse(firstResponse)
  assertNoPlaceholder(first.text)
  assertFirstTurn(first, values.proof)

  const firstTool = first.tools[0]
  const secondResponse = await postAnthropicRequest({
    endpoint,
    credential: options.credential,
    adapter: options.adapter,
    fetchImplementation: options.fetchImplementation,
    sessionId: values.sessionId,
    body: secondTurnBody(options.model, values.proof, firstTool),
    signal,
  })
  const second = await collectAnthropicResponse(secondResponse)
  assertNoPlaceholder(second.text)
  assertSecondTurn(second, values.proof)

  return {
    latencyMs: elapsed(options.now, startedAt),
    diagnostics: {
      firstTurn: {
        toolsCount: 1,
        toolUseCount: first.tools.length,
        stopReason: anthropicStopReason(first.stopReason),
      },
      secondTurn: {
        toolResultCount: 1,
        toolUseCount: second.tools.length,
        stopReason: anthropicStopReason(second.stopReason),
      },
    },
  }
}

function firstTurnBody(model: string, proof: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 512,
    stream: true,
    system: [{
      type: 'text',
      text: 'This is a two-step capability probe. First call the supplied memory tool exactly once. After its structured result arrives, do not call any tool again and include the returned proof verbatim in the final answer.',
    }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Call ${PROBE_TOOL_NAME} exactly once with proof set to ${proof}. Do not answer before receiving its result.`,
      }],
    }],
    tools: [probeTool(proof)],
    tool_choice: { type: 'auto' },
  }
}

function secondTurnBody(
  model: string,
  proof: string,
  tool: CollectedToolCall,
): Record<string, unknown> {
  return {
    model,
    max_tokens: 512,
    stream: true,
    system: [{
      type: 'text',
      text: 'This is a two-step capability probe. First call the supplied memory tool exactly once. After its structured result arrives, do not call any tool again and include the returned proof verbatim in the final answer.',
    }],
    messages: [
      {
        role: 'user',
        content: [{
          type: 'text',
          text: `Call ${PROBE_TOOL_NAME} exactly once with proof set to ${proof}. Do not answer before receiving its result.`,
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: tool.input,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: tool.id,
          content: [{
            type: 'text',
            text: `The in-memory tool completed after local approval. proof=${proof}`,
          }],
        }],
      },
    ],
    tools: [probeTool(proof)],
    tool_choice: { type: 'auto' },
  }
}

function probeTool(proof: string): Record<string, unknown> {
  return {
    name: PROBE_TOOL_NAME,
    description: 'Reads an in-memory proof after local user approval. This tool has no side effects.',
    input_schema: {
      type: 'object',
      properties: {
        proof: { type: 'string', const: proof },
      },
      required: ['proof'],
      additionalProperties: false,
    },
  }
}

async function postAnthropicRequest(input: {
  endpoint: string
  credential: string
  adapter: ProviderAdapter
  fetchImplementation: typeof fetch
  sessionId: string
  body: unknown
  signal: AbortSignal
}): Promise<Response> {
  const headers = new Headers()
  input.adapter.applyRequestHeaders(headers, {
    protocol: 'anthropic-messages',
    credential: input.credential,
    stream: true,
    hasBody: true,
  })
  headers.set('x-claude-code-session-id', input.sessionId)

  let response: Response
  try {
    response = await input.fetchImplementation(input.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: input.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new AnthropicToolProbeFailure(
      'transport',
      isAbortError(error)
        ? 'Anthropic 两轮工具链检测超时。'
        : '无法连接 Anthropic Messages 中转端点。',
    )
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const authentication = response.status === 401 || response.status === 403
    throw new AnthropicToolProbeFailure(
      authentication ? 'authentication' : 'http',
      authentication
        ? 'Anthropic Messages 中转拒绝了 API Key。'
        : `Anthropic Messages 中转返回 HTTP ${response.status}。`,
      response.status,
    )
  }

  if (!isEventStreamContentType(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => undefined)
    throw new AnthropicToolProbeFailure(
      'invalid-response',
      'Anthropic Messages 中转未返回 SSE 事件流。',
    )
  }
  if (!response.body) {
    throw new AnthropicToolProbeFailure(
      'invalid-response',
      'Anthropic Messages 中转返回了空响应体。',
    )
  }
  return response
}

async function collectAnthropicResponse(response: Response): Promise<CollectedAnthropicResponse> {
  const parser = createCanonicalStreamParser('anthropic-messages', {
    maxBufferedCharacters: MAX_PROBE_STREAM_BYTES,
  })
  const reader = response.body!.getReader()
  const tools = new Map<number, MutableToolCall>()
  let text = ''
  let stopReason: CanonicalStopReason | undefined
  let stopCount = 0
  let bytesRead = 0
  let failure: AnthropicToolProbeFailure | undefined

  const consume = (events: CanonicalStreamEvent[]): void => {
    for (const event of events) {
      if (event.type === 'text-delta') {
        text += event.text
        if (text.length > MAX_PROBE_TEXT_CHARACTERS) {
          throw invalidResponse('Anthropic 工具链响应文本超过安全上限。')
        }
      } else if (event.type === 'tool-call-delta') {
        const tool = tools.get(event.index) ?? { id: '', name: '', arguments: '' }
        tool.id += event.id ?? ''
        tool.name += event.name ?? ''
        tool.arguments += event.arguments ?? ''
        if (tool.arguments.length > MAX_PROBE_ARGUMENT_CHARACTERS) {
          throw invalidResponse('Anthropic 工具参数超过安全上限。')
        }
        tools.set(event.index, tool)
      } else if (event.type === 'stop') {
        stopCount += 1
        stopReason = event.reason
      } else if (event.type === 'error') {
        throw invalidResponse('Anthropic Messages 中转返回了错误事件。')
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > MAX_PROBE_STREAM_BYTES) {
        throw invalidResponse('Anthropic 工具链事件流超过安全上限。')
      }
      consume(parser.push(value))
    }
    consume(parser.finish())
  } catch (error) {
    failure = error instanceof AnthropicToolProbeFailure
      ? error
      : new AnthropicToolProbeFailure(
        isAbortError(error) ? 'transport' : 'invalid-response',
        isAbortError(error)
          ? 'Anthropic 两轮工具链检测超时。'
          : 'Anthropic Messages 中转返回了无效的 SSE 事件流。',
      )
  } finally {
    if (failure) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (failure) throw failure
  if (parser.getRecognizedEventCount() === 0 || stopCount !== 1 || !stopReason) {
    throw invalidResponse('Anthropic Messages 中转未返回完整的终止事件。')
  }

  return {
    text,
    stopReason,
    tools: [...tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, tool]) => finalizedTool(tool)),
  }
}

function finalizedTool(tool: MutableToolCall): CollectedToolCall {
  if (!safeToolField(tool.id) || !safeToolField(tool.name)) {
    throw invalidResponse('Anthropic Messages 中转返回了无效的工具标识。')
  }
  let input: unknown
  try {
    input = JSON.parse(tool.arguments || '{}')
  } catch {
    throw invalidResponse('Anthropic Messages 中转返回了无效的工具参数。')
  }
  if (!isRecord(input)) {
    throw invalidResponse('Anthropic Messages 中转返回了非对象工具参数。')
  }
  return { id: tool.id, name: tool.name, input }
}

function assertFirstTurn(result: CollectedAnthropicResponse, proof: string): void {
  const valid = result.tools.length === 1
    && result.stopReason === 'tool_calls'
    && result.tools[0].name === PROBE_TOOL_NAME
    && result.tools[0].input.proof === proof
  if (!valid) {
    throw new AnthropicToolProbeFailure(
      'roundtrip',
      `第一轮工具诊断未通过（tools=1, tool_use=${result.tools.length}, stop_reason=${anthropicStopReason(result.stopReason)}）。`,
    )
  }
}

function assertSecondTurn(result: CollectedAnthropicResponse, proof: string): void {
  const valid = result.tools.length === 0
    && result.stopReason === 'stop'
    && result.text.includes(proof)
  if (!valid) {
    throw new AnthropicToolProbeFailure(
      'roundtrip',
      `第二轮工具诊断未通过（tool_result=1, tool_use=${result.tools.length}, stop_reason=${anthropicStopReason(result.stopReason)}）。`,
    )
  }
}

function assertNoPlaceholder(text: string): void {
  if (TOOL_RESULT_PLACEHOLDER.test(text) || CONTINUE_PLACEHOLDER.test(text)) {
    throw new AnthropicToolProbeFailure(
      'roundtrip',
      'Anthropic Messages 中转将结构化工具链降级成了工具结果占位文本。',
    )
  }
}

function safeProbeValues(value: AnthropicToolProbeValues): AnthropicToolProbeValues {
  const sessionId = value.sessionId?.trim()
  const proof = value.proof?.trim()
  if (!sessionId || !proof
    || sessionId.length > 256 || proof.length > 256
    || !SAFE_PROBE_VALUE.test(sessionId) || !SAFE_PROBE_VALUE.test(proof)) {
    throw new AnthropicToolProbeFailure(
      'configuration',
      '无法创建安全的 Anthropic 工具链探测值。',
    )
  }
  return { sessionId, proof }
}

function defaultProbeValues(): AnthropicToolProbeValues {
  return {
    sessionId: randomUUID(),
    proof: `stone-${randomBytes(18).toString('hex')}`,
  }
}

function invalidResponse(message: string): AnthropicToolProbeFailure {
  return new AnthropicToolProbeFailure('invalid-response', message)
}

function isEventStreamContentType(value: string | null): boolean {
  return value?.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream'
}

function safeToolField(value: string): boolean {
  if (!value || value.length > 256) return false
  return ![...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function anthropicStopReason(reason: CanonicalStopReason | undefined): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  return reason ?? 'unknown'
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
