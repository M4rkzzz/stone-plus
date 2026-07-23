import type { RouteClient, SetupRouteVerificationResult } from '@shared/types'

const TEST_PROMPT = 'Reply exactly with OK.'
const MAX_PREVIEW_LENGTH = 240

export interface SetupVerificationRequest {
  url: string
  init: RequestInit
}

export function buildSetupVerificationRequest(
  baseUrl: string,
  client: RouteClient,
  model: string,
  token: string,
): SetupVerificationRequest {
  const root = baseUrl.replace(/\/+$/, '')
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  })

  if (client === 'claude') {
    headers.set('x-api-key', token)
    headers.set('anthropic-version', '2023-06-01')
    return {
      url: `${root}/v1/messages`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 16,
          stream: false,
          messages: [{ role: 'user', content: TEST_PROMPT }],
        }),
      },
    }
  }

  if (client === 'gemini') {
    return {
      url: `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
      },
    }
  }

  return {
    url: `${root}/v1/responses`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: TEST_PROMPT,
        max_output_tokens: 16,
        stream: false,
      }),
    },
  }
}

export async function verifySetupRouteRequest(input: {
  baseUrl: string
  client: RouteClient
  model: string
  token: string
  fetchImplementation?: typeof fetch
  timeoutMs?: number
}): Promise<SetupRouteVerificationResult> {
  const startedAt = Date.now()
  const request = buildSetupVerificationRequest(input.baseUrl, input.client, input.model, input.token)
  const timeout = AbortSignal.timeout(Math.max(1_000, input.timeoutMs ?? 60_000))
  try {
    const response = await (input.fetchImplementation ?? fetch)(request.url, {
      ...request.init,
      signal: timeout,
    })
    const text = await response.text()
    const preview = safePreview(text, [input.token])
    const latencyMs = Math.max(0, Date.now() - startedAt)
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        error: setupFailureMessage(response.status, preview),
      }
    }
    return {
      ok: true,
      latencyMs,
      status: response.status,
      responsePreview: preview || 'OK',
    }
  } catch (cause) {
    const timeoutError = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    return {
      ok: false,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error: timeoutError
        ? '端到端请求超时，请检查号池、代理和上游状态。'
        : cause instanceof Error ? cause.message : '无法连接本地网关。',
    }
  }
}

function setupFailureMessage(status: number, preview: string): string {
  const detail = preview ? ` ${preview}` : ''
  if (status === 401 || status === 403) return `本地鉴权失败，请重新应用客户端 Token。${detail}`.trim()
  if (status === 404) return `本地路由或协议端点不匹配，请检查客户端与路由。${detail}`.trim()
  if (status === 429) return `上游额度或频率受限，请更换来源或稍后重试。${detail}`.trim()
  if (status === 503) return `路由当前没有可调度成员，请检查号池、账号状态和代理。${detail}`.trim()
  if (status >= 500) return `上游或本地网关返回 ${status}，请检查中转站状态后重试。${detail}`.trim()
  return preview || `本地网关返回 HTTP ${status}`
}

function safePreview(text: string, secrets: readonly string[]): string {
  if (!text.trim()) return ''
  let value = text
  try {
    const parsed = JSON.parse(text) as unknown
    value = extractResponseText(parsed) || text
  } catch {
    // Plain-text upstream errors are still useful after length limiting.
  }
  for (const secret of secrets) {
    if (secret) value = value.replaceAll(secret, '[redacted]')
  }
  return value
    .replace(/Bearer\s+[-A-Za-z0-9._~+/=]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW_LENGTH)
}

function extractResponseText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  if (typeof object.error === 'string') return object.error
  if (object.error && typeof object.error === 'object') {
    const message = (object.error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof object.output_text === 'string') return object.output_text
  const content = Array.isArray(object.content) ? object.content : []
  for (const item of content) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
      return String((item as Record<string, unknown>).text)
    }
  }
  const candidates = Array.isArray(object.candidates) ? object.candidates : []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const candidateContent = (candidate as Record<string, unknown>).content
    if (!candidateContent || typeof candidateContent !== 'object') continue
    const parts = Array.isArray((candidateContent as Record<string, unknown>).parts)
      ? (candidateContent as Record<string, unknown>).parts as unknown[]
      : []
    for (const part of parts) {
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
        return String((part as Record<string, unknown>).text)
      }
    }
  }
  const output = Array.isArray(object.output) ? object.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const nested = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : []
    for (const part of nested) {
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
        return String((part as Record<string, unknown>).text)
      }
    }
  }
  return ''
}
