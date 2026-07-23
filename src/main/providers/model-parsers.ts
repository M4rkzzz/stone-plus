import type { Protocol } from '../../shared/types'
import type { ModelDiscoveryPagination } from './types'

export function parseDataModels(payload: unknown): string[] {
  const object = objectValue(payload)
  const items = Array.isArray(payload)
    ? payload
    : [...arrayValue(object?.data), ...arrayValue(object?.models)]
  return items.flatMap((item) => {
    if (typeof item === 'string') return [item]
    const model = objectValue(item)
    const id = stringValue(model?.id) ?? stringValue(model?.name)
    return id ? [stripModelPrefix(id)] : []
  })
}

export function parseGoogleModels(payload: unknown): string[] {
  const items = arrayValue(objectValue(payload)?.models)
  return items.flatMap((item) => {
    const model = objectValue(item)
    const name = stringValue(model?.name)
    if (!name) return []
    const methods = arrayValue(model?.supportedGenerationMethods)
      .filter((method): method is string => typeof method === 'string')
    if (methods.length > 0 && !methods.includes('generateContent')) return []
    return [stripModelPrefix(name)]
  })
}

export function parseModelDiscoveryPagination(
  payload: unknown,
  protocol: Protocol
): ModelDiscoveryPagination {
  const object = objectValue(payload)
  if (!object) return { invalid: false }

  if (protocol === 'gemini') {
    if (object.nextPageToken === undefined || object.nextPageToken === null || object.nextPageToken === '') {
      return { invalid: false }
    }
    const value = stringValue(object.nextPageToken)?.trim()
    return value
      ? { invalid: false, nextCursor: { parameter: 'pageToken', value } }
      : { invalid: true }
  }

  if (protocol === 'anthropic-messages' && object.has_more === true) {
    const value = stringValue(object.last_id)?.trim()
    return value
      ? { invalid: false, nextCursor: { parameter: 'after_id', value } }
      : { invalid: true }
  }

  return { invalid: false }
}

export function filterOpenAIGenerativeModels(models: string[]): string[] {
  return models.filter((model) => {
    const normalized = model.trim().toLowerCase()
    if (!normalized) return false
    if (/(?:^|[/:])(?:text-embedding|embedding|embed|text-moderation|omni-moderation|moderation|whisper|tts|dall-e|rerank|reranker|gpt-image|sora|(?:text-)?(?:babbage|davinci))(?:[-_.:]|$)/.test(normalized)) {
      return false
    }
    if (/(?:^|[/:])gpt-[^/:]*-(?:transcribe|tts)(?:[-_.:]|$)/.test(normalized)) return false
    return true
  })
}

function stripModelPrefix(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model
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
