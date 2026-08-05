import { providerSourceFamily } from '../../shared/source-family'
import { effectiveProviderCapabilities } from '../../shared/source-capabilities'
import type {
  Account,
  ProviderDefinition,
  UpstreamCapabilityRequirement,
} from '../../shared/types'
import { buildVersionedEndpoint } from '../providers/url'

type JsonObject = Record<string, unknown>

export type GrokMediaEndpoint =
  | 'images-generations'
  | 'images-edits'
  | 'videos-generations'
  | 'videos-edits'
  | 'videos-extensions'
  | 'video-status'
  | 'video-content'

export interface GrokMediaRoute {
  endpoint: GrokMediaEndpoint
  method: 'GET' | 'POST'
  requestId?: string
  requiresBody: boolean
  capability?: UpstreamCapabilityRequirement
}

export interface PreparedGrokMediaRequest {
  model: string
  body?: Buffer
  contentType?: string
}

export interface GrokMediaEligibility {
  eligible: boolean
  reason?: 'not-grok' | 'capability-unverified' | 'oauth-free' | 'oauth-unverified'
}

const GROK_OAUTH_MEDIA_BASE_URL = 'https://api.x.ai/v1'

export function classifyGrokMediaRoute(method: string | undefined, pathname: string): GrokMediaRoute | undefined {
  if (method === 'POST') {
    if (pathname === '/v1/images/generations') {
      return {
        endpoint: 'images-generations', method: 'POST', requiresBody: true, capability: 'imageGeneration',
      }
    }
    if (pathname === '/v1/images/edits') {
      return { endpoint: 'images-edits', method: 'POST', requiresBody: true, capability: 'imageEdit' }
    }
    if (pathname === '/v1/videos/generations') {
      return {
        endpoint: 'videos-generations', method: 'POST', requiresBody: true, capability: 'videoGeneration',
      }
    }
    if (pathname === '/v1/videos/edits') {
      return { endpoint: 'videos-edits', method: 'POST', requiresBody: true, capability: 'videoEdit' }
    }
    if (pathname === '/v1/videos/extensions') {
      return { endpoint: 'videos-extensions', method: 'POST', requiresBody: true, capability: 'videoEdit' }
    }
    return undefined
  }
  if (method !== 'GET') return undefined
  const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(pathname)
  if (content) {
    const requestId = safeRequestId(content[1])
    if (!requestId) return undefined
    return {
      endpoint: 'video-content',
      method: 'GET',
      requestId,
      requiresBody: false,
    }
  }
  const status = /^\/v1\/videos\/([^/]+)$/.exec(pathname)
  if (status) {
    const requestId = safeRequestId(status[1])
    if (!requestId) return undefined
    return {
      endpoint: 'video-status',
      method: 'GET',
      requestId,
      requiresBody: false,
    }
  }
  return undefined
}

export async function prepareGrokMediaRequest(
  route: GrokMediaRoute,
  contentType: string | undefined,
  rawBody: Buffer | undefined,
): Promise<PreparedGrokMediaRequest> {
  if (!route.requiresBody) return { model: '' }
  if (!rawBody?.byteLength) throw new Error('A media request body is required.')
  const normalizedContentType = contentType?.trim() || 'application/json'
  if (normalizedContentType.toLowerCase().startsWith('multipart/form-data')) {
    return prepareMultipartRequest(route, normalizedContentType, rawBody)
  }
  if (!normalizedContentType.toLowerCase().startsWith('application/json')) {
    throw new Error('Grok media requests must use application/json or multipart/form-data.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    throw new Error('The Grok media request body is not valid JSON.')
  }
  if (!isObject(parsed)) throw new Error('The Grok media request body must be one JSON object.')
  const model = normalizeMediaModel(
    route.endpoint,
    typeof parsed.model === 'string' ? parsed.model : '',
  )
  if (!model) throw new Error('A media model is required.')
  const outbound: JsonObject = { ...parsed, model }
  if (route.endpoint === 'images-generations' || route.endpoint === 'images-edits') {
    // xAI accepts quality through the model id. The OpenAI `size` field is a
    // local billing hint and is rejected by the native Imagine endpoint.
    delete outbound.size
  }
  return {
    model,
    body: Buffer.from(JSON.stringify(outbound), 'utf8'),
    contentType: 'application/json',
  }
}

export async function rewritePreparedGrokMediaModel(
  prepared: PreparedGrokMediaRequest,
  targetModel: string,
): Promise<PreparedGrokMediaRequest> {
  const normalized = targetModel.trim()
  if (!normalized || normalized === prepared.model || !prepared.body) return prepared
  if (prepared.contentType?.toLowerCase().startsWith('multipart/form-data')) {
    let form: FormData
    try {
      form = await new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-type': prepared.contentType },
        body: new Uint8Array(prepared.body),
      }).formData()
    } catch {
      throw new Error('Unable to rewrite the Grok media multipart model.')
    }
    form.set('model', normalized)
    const encoded = new Response(form)
    const contentType = encoded.headers.get('content-type')
    if (!contentType) throw new Error('Unable to encode the Grok media multipart model.')
    return {
      model: normalized,
      body: Buffer.from(await encoded.arrayBuffer()),
      contentType,
    }
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(prepared.body)) } catch { value = undefined }
  if (!isObject(value)) throw new Error('Unable to rewrite the Grok media JSON model.')
  return {
    model: normalized,
    body: Buffer.from(JSON.stringify({ ...value, model: normalized }), 'utf8'),
    contentType: 'application/json',
  }
}

export function grokMediaEligibility(
  account: Account,
  provider: ProviderDefinition,
  capability: UpstreamCapabilityRequirement | undefined,
  options: { lookup?: boolean } = {},
): GrokMediaEligibility {
  if (providerSourceFamily(provider.kind) !== 'grok') return { eligible: false, reason: 'not-grok' }
  if (!options.lookup && capability && effectiveProviderCapabilities(provider)[capability] !== true) {
    return { eligible: false, reason: 'capability-unverified' }
  }
  if (options.lookup || account.credentialType !== 'grok-oauth') return { eligible: true }
  if (account.grokQuota?.paidClassification === 'paid') return { eligible: true }
  if (account.grokQuota?.paidClassification === 'free') return { eligible: false, reason: 'oauth-free' }
  return { eligible: false, reason: 'oauth-unverified' }
}

export function buildGrokMediaUpstreamUrl(
  provider: ProviderDefinition,
  credentialKind: 'api-key' | 'grok-oauth',
  route: GrokMediaRoute,
): string {
  if (route.endpoint === 'video-content') {
    throw new Error('Video content is fetched from the validated signed URL returned by xAI.')
  }
  const baseUrl = credentialKind === 'grok-oauth' ? GROK_OAUTH_MEDIA_BASE_URL : provider.baseUrl
  const path = route.endpoint === 'images-generations'
    ? 'images/generations'
    : route.endpoint === 'images-edits'
      ? 'images/edits'
      : route.endpoint === 'videos-generations'
        ? 'videos/generations'
        : route.endpoint === 'videos-edits'
          ? 'videos/edits'
          : route.endpoint === 'videos-extensions'
            ? 'videos/extensions'
            : `videos/${encodeURIComponent(requiredRequestId(route))}`
  return buildVersionedEndpoint(baseUrl, 'v1', path)
}

export function extractGrokVideoRequestId(payload: JsonObject): string | undefined {
  const nestedVideo = isObject(payload.video) ? payload.video : undefined
  for (const candidate of [payload.request_id, payload.requestId, payload.id, nestedVideo?.id]) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim()
    if (normalized && normalized.length <= 512 && !containsControlCharacter(normalized)) return normalized
  }
  return undefined
}

export function rewriteGrokVideoContentUrl(payload: JsonObject, requestId: string, localUrl: string): JsonObject {
  const video = isObject(payload.video) ? payload.video : undefined
  if (!video || typeof video.url !== 'string') return payload
  return { ...payload, video: { ...video, url: localUrl, id: video.id ?? requestId } }
}

export function validGrokSignedVideoUrl(value: string | null): string | undefined {
  if (!value) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  if (url.hostname.toLowerCase() !== 'vidgen.x.ai') return undefined
  if (url.port && url.port !== '443') return undefined
  return url.toString()
}

function safeRequestId(raw: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return undefined }
  const normalized = decoded.trim()
  if (!normalized || normalized.length > 512
    || normalized.includes('/') || normalized.includes('\\')
    || containsControlCharacter(normalized)) return undefined
  return normalized
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function requiredRequestId(route: GrokMediaRoute): string {
  if (!route.requestId) throw new Error('A video request id is required.')
  return route.requestId
}

async function prepareMultipartRequest(
  route: GrokMediaRoute,
  contentType: string,
  rawBody: Buffer,
): Promise<PreparedGrokMediaRequest> {
  let form: FormData
  try {
    form = await new Request('http://127.0.0.1/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(rawBody),
    }).formData()
  } catch {
    throw new Error('The Grok media multipart body is malformed.')
  }
  const rawModel = form.get('model')
  const model = normalizeMediaModel(route.endpoint, typeof rawModel === 'string' ? rawModel : '')
  if (!model) throw new Error('A media model is required.')
  form.set('model', model)
  if (route.endpoint === 'images-generations' || route.endpoint === 'images-edits') form.delete('size')
  const encoded = new Response(form)
  const encodedContentType = encoded.headers.get('content-type')
  if (!encodedContentType) throw new Error('Unable to encode the Grok media multipart body.')
  return {
    model,
    body: Buffer.from(await encoded.arrayBuffer()),
    contentType: encodedContentType,
  }
}

function normalizeMediaModel(endpoint: GrokMediaEndpoint, model: string): string {
  const normalized = model.trim()
  if ((endpoint === 'images-generations' || endpoint === 'images-edits') && normalized === 'grok-imagine') {
    return 'grok-imagine-image-quality'
  }
  // Do not rewrite video model ids. `grok-imagine-video` remains xAI's
  // general text/image/video model, while 1.5 is a distinct image-to-video
  // model. Treating the former as a legacy alias breaks text-to-video.
  return normalized
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
