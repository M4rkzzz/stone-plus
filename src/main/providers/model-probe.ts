import type { AccountModelTestResult, Protocol } from '@shared/types'
import type { ChatGptCredentialBundle } from '../auth'
import {
  applyChatGptCodexHeaders,
  CHATGPT_CODEX_RESPONSES_URL,
  classifyChatGptCodexFailure,
  withChatGptCodexBody
} from './chatgpt-codex'
import type { ProviderAdapter, ProviderFailure } from './types'

const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_PREVIEW_CHARACTERS = 160
const MODEL_PROBE_PROMPT = 'Reply exactly with OK.'

export interface ProviderModelProbeInput {
  adapter: ProviderAdapter
  baseUrl: string
  protocol: Protocol
  credential: string
  model: string
  fetchImplementation?: typeof fetch
  signal?: AbortSignal
  now?: () => number
}

export interface ChatGptModelProbeInput {
  bundle: ChatGptCredentialBundle
  model: string
  fetchImplementation?: typeof fetch
  signal?: AbortSignal
  now?: () => number
}

/**
 * Sends a deliberately tiny generation request directly to one provider account.
 * Only protocol-defined final answer text is exposed; raw payloads, headers and
 * reasoning content never leave this module.
 */
export async function probeProviderModel(input: ProviderModelProbeInput): Promise<AccountModelTestResult> {
  const model = normalizeModel(input.model)
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const headers = new Headers()
  input.adapter.applyRequestHeaders(headers, {
    protocol: input.protocol,
    credential: input.credential,
    stream: false,
    hasBody: true
  })

  let response: Response
  try {
    response = await (input.fetchImplementation ?? fetch)(input.adapter.buildEndpoint({
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      operation: 'generate',
      model,
      stream: false
    }), {
      method: 'POST',
      headers,
      body: JSON.stringify(probeBody(input.protocol, model)),
      signal: input.signal
    })
  } catch (error) {
    throw new AccountModelProbeError(input.adapter.classifyFailure({ error, now: now() }))
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new AccountModelProbeError(input.adapter.classifyFailure({
      statusCode: response.status,
      headers: response.headers,
      now: now()
    }))
  }

  let payload: unknown
  try {
    payload = await readJsonResponse(response)
  } catch (error) {
    if (error instanceof AccountModelProbeError) throw error
    throw new AccountModelProbeError(input.adapter.classifyFailure({ error, now: now() }))
  }
  const responsePreview = sanitizePreview(
    extractAnswerText(input.protocol, payload),
    [input.credential]
  )
  if (!responsePreview) throw invalidReplyError(response.status)

  return {
    ok: true,
    model,
    latencyMs: elapsed(now, startedAt),
    statusCode: response.status,
    responsePreview
  }
}

/** ChatGPT OAuth accounts must use the Codex Responses endpoint with stream=true. */
export async function probeChatGptCodexModel(input: ChatGptModelProbeInput): Promise<AccountModelTestResult> {
  const model = normalizeModel(input.model)
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const headers = new Headers()
  applyChatGptCodexHeaders(headers, input.bundle)

  let response: Response
  try {
    response = await (input.fetchImplementation ?? fetch)(CHATGPT_CODEX_RESPONSES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(withChatGptCodexBody({
        model,
        instructions: 'Return only the requested short answer. Do not include reasoning.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: MODEL_PROBE_PROMPT }] }]
      })),
      signal: input.signal
    })
  } catch (error) {
    throw new AccountModelProbeError(networkFailure(error, 'ChatGPT Codex model test could not be reached.'))
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new AccountModelProbeError(classifyChatGptCodexFailure(
      response.status,
      response.headers,
      now()
    ))
  }

  let answer: string
  try {
    answer = await readCodexAnswer(response)
  } catch (error) {
    if (error instanceof AccountModelProbeError) throw error
    throw new AccountModelProbeError(networkFailure(error, 'ChatGPT Codex model test stream could not be read.'))
  }
  const responsePreview = sanitizePreview(answer, [
    input.bundle.accessToken,
    input.bundle.refreshToken,
    input.bundle.idToken,
    input.bundle.accountId
  ])
  if (!responsePreview) throw invalidReplyError(response.status, 'ChatGPT Codex model test returned no usable reply.')

  return {
    ok: true,
    model,
    latencyMs: elapsed(now, startedAt),
    statusCode: response.status,
    responsePreview
  }
}

export class AccountModelProbeError extends Error {
  readonly statusCode?: number

  constructor(readonly failure: ProviderFailure) {
    super(failure.message)
    this.name = 'AccountModelProbeError'
    this.statusCode = failure.statusCode
  }
}

function probeBody(protocol: Protocol, model: string): Record<string, unknown> {
  if (protocol === 'openai-responses') {
    return {
      model,
      instructions: 'Return only the requested short answer. Do not include reasoning.',
      input: MODEL_PROBE_PROMPT,
      max_output_tokens: 64,
      stream: false
    }
  }
  if (protocol === 'openai-chat') {
    return {
      model,
      messages: [{ role: 'user', content: MODEL_PROBE_PROMPT }],
      max_tokens: 16,
      stream: false
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: MODEL_PROBE_PROMPT }],
      stream: false
    }
  }
  return {
    contents: [{ role: 'user', parts: [{ text: MODEL_PROBE_PROMPT }] }],
    generationConfig: { maxOutputTokens: 64, temperature: 0 }
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await readLimitedResponseText(response)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalidReplyError(response.status, 'Provider model test returned invalid JSON.')
  }
}

async function readCodexAnswer(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw invalidReplyError(response.status, 'ChatGPT Codex model test returned an empty stream.')

  const decoder = new TextDecoder()
  let buffer = ''
  let size = 0
  let deltaText = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw invalidReplyError(response.status, 'ChatGPT Codex model test response was too large.')
      }
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (!event) continue
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          deltaText += event.delta
        }
        if (event.type === 'response.output_text.done' && typeof event.text === 'string' && event.text.trim()) {
          await reader.cancel()
          return event.text
        }
        if (event.type === 'response.completed') {
          const answer = extractOpenAiResponsesText(objectValue(event.response)) || deltaText
          await reader.cancel()
          return answer
        }
        if (event.type === 'response.failed' || event.type === 'error') {
          throw invalidReplyError(response.status, 'ChatGPT Codex model test did not complete successfully.')
        }
      }
    }
    buffer += decoder.decode()
    const finalEvent = parseSseFrame(buffer)
    if (finalEvent?.type === 'response.completed') {
      return extractOpenAiResponsesText(objectValue(finalEvent.response)) || deltaText
    }
    return deltaText
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return undefined
  try {
    return objectValue(JSON.parse(data) as unknown)
  } catch {
    return undefined
  }
}

async function readLimitedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw invalidReplyError(response.status, 'Provider model test returned an empty response.')
  const decoder = new TextDecoder()
  let output = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw invalidReplyError(response.status, 'Provider model test response was too large.')
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function extractAnswerText(protocol: Protocol, payload: unknown): string {
  const object = objectValue(payload)
  if (!object) return ''
  if (protocol === 'openai-responses') return extractOpenAiResponsesText(object)
  if (protocol === 'openai-chat') {
    const choice = arrayValue(object.choices).map(objectValue).find(Boolean)
    const message = objectValue(choice?.message)
    return contentText(message?.content)
  }
  if (protocol === 'anthropic-messages') {
    return arrayValue(object.content)
      .map(objectValue)
      .filter((part) => part?.type === 'text')
      .map((part) => stringValue(part?.text))
      .filter((text): text is string => Boolean(text))
      .join('')
  }
  const candidate = arrayValue(object.candidates).map(objectValue).find(Boolean)
  const content = objectValue(candidate?.content)
  return arrayValue(content?.parts)
    .map(objectValue)
    .filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map((part) => stringValue(part?.text))
    .filter((text): text is string => Boolean(text))
    .join('')
}

function extractOpenAiResponsesText(response: Record<string, unknown> | undefined): string {
  if (!response) return ''
  return arrayValue(response.output)
    .map(objectValue)
    .filter((item) => item?.type === 'message')
    .flatMap((item) => arrayValue(item?.content).map(objectValue))
    .filter((part) => part?.type === 'output_text')
    .map((part) => stringValue(part?.text))
    .filter((text): text is string => Boolean(text))
    .join('')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return arrayValue(content)
    .map(objectValue)
    .filter((part) => part?.type === 'text' || part?.type === 'output_text')
    .map((part) => stringValue(part?.text))
    .filter((text): text is string => Boolean(text))
    .join('')
}

function sanitizePreview(value: string, sensitiveValues: Array<string | undefined>): string {
  let output = value
  for (const sensitive of sensitiveValues) {
    if (sensitive) output = output.replaceAll(sensitive, '[redacted]')
  }
  output = output
    .replace(/Bearer\s+[-A-Za-z0-9._~+/]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
  output = replaceControlCharacters(output)
  output = output
    .replace(/\s+/g, ' ')
    .trim()
  if (output.length <= MAX_PREVIEW_CHARACTERS) return output
  return `${output.slice(0, MAX_PREVIEW_CHARACTERS - 3).trimEnd()}...`
}

function normalizeModel(value: string): string {
  if (typeof value !== 'string') throw new Error('A model is required for the account test.')
  const model = value.trim()
  if (!model) throw new Error('A model is required for the account test.')
  if (model.length > 256 || hasControlCharacters(model)) {
    throw new Error('The model name is invalid.')
  }
  return model
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function replaceControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}

function invalidReplyError(statusCode: number, message = 'Provider model test returned no usable reply.'): AccountModelProbeError {
  return new AccountModelProbeError({
    category: 'invalid_response',
    message,
    retryable: false,
    accountAction: 'none',
    statusCode
  })
}

function networkFailure(error: unknown, message: string): ProviderFailure {
  const aborted = error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
  return {
    category: aborted ? 'timeout' : 'network',
    message: aborted ? 'ChatGPT Codex model test timed out.' : message,
    retryable: true,
    accountAction: 'cooldown'
  }
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
