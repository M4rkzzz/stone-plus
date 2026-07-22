import type {
  ModelCapabilityDefinition,
  Protocol,
  ProviderDefinition,
  ResponsesCompactMode,
  UpstreamCapabilityProfile,
  UpstreamCapabilityRequirement,
} from './types'

const capabilityKeys: readonly UpstreamCapabilityRequirement[] = [
  'streaming',
  'nonStreaming',
  'toolCalls',
  'modelDiscovery',
  'imageInput',
  'imageGeneration',
  'webSearch',
  'compact',
  'websocket',
  'promptCaching',
  'reasoning',
  'store',
  'previousResponseId',
  'parallelToolCalls',
]

export function inferUpstreamCapabilities(input: {
  protocol: Protocol
  sourceType?: ProviderDefinition['sourceType']
  responsesCompactMode?: ResponsesCompactMode
  modelDiscovery?: boolean
  streaming?: boolean
  toolCalls?: boolean
  origin?: UpstreamCapabilityProfile['origin']
  checkedAt?: number
}): UpstreamCapabilityProfile {
  const responses = input.protocol === 'openai-responses'
  const officialResponses = responses && input.sourceType === 'official-api'
  const compact = responses
    ? officialResponses || input.responsesCompactMode === 'native' || input.responsesCompactMode === 'passthrough'
    : false
  return {
    version: 1,
    origin: input.origin ?? 'inferred',
    ...(input.checkedAt === undefined ? {} : { checkedAt: input.checkedAt }),
    streaming: input.streaming ?? true,
    nonStreaming: true,
    toolCalls: input.toolCalls ?? true,
    modelDiscovery: input.modelDiscovery,
    compact,
    // These are protocol-level guarantees only for the official Responses API.
    // Compatible relays remain "unknown" until they explicitly declare them.
    ...(officialResponses ? {
      webSearch: true,
      reasoning: true,
      store: true,
      previousResponseId: true,
      parallelToolCalls: true,
      websocket: true,
    } : {}),
  }
}

export function effectiveProviderCapabilities(provider: ProviderDefinition): UpstreamCapabilityProfile {
  const fallback = inferUpstreamCapabilities(provider)
  return normalizeCapabilityProfile(provider.capabilityProfile, fallback)
}

export function normalizeCapabilityProfile(
  value: UpstreamCapabilityProfile | undefined,
  fallback: UpstreamCapabilityProfile,
): UpstreamCapabilityProfile {
  if (!value || value.version !== 1) return fallback
  const result: UpstreamCapabilityProfile = {
    version: 1,
    origin: value.origin === 'declared' || value.origin === 'probed' ? value.origin : fallback.origin,
  }
  if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt > 0) {
    result.checkedAt = Math.floor(value.checkedAt)
  }
  for (const key of capabilityKeys) {
    if (typeof value[key] === 'boolean') Object.assign(result, { [key]: value[key] })
  }
  return { ...fallback, ...result }
}

export function buildModelCatalog(
  models: readonly string[],
  profile: UpstreamCapabilityProfile,
  discoveredAt?: number,
): ModelCapabilityDefinition[] {
  const capabilities: Partial<Record<UpstreamCapabilityRequirement, boolean>> = {}
  for (const key of capabilityKeys) {
    const value = profile[key]
    if (typeof value === 'boolean') capabilities[key] = value
  }
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].map((id) => ({
    id,
    ...(Object.keys(capabilities).length ? { capabilities: { ...capabilities } } : {}),
    ...(discoveredAt === undefined ? {} : { discoveredAt }),
  }))
}

export function normalizeModelCatalog(
  value: readonly ModelCapabilityDefinition[] | undefined,
  models: readonly string[],
  fallbackProfile: UpstreamCapabilityProfile,
): ModelCapabilityDefinition[] {
  const byId = new Map<string, ModelCapabilityDefinition>()
  for (const item of value ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id || id.length > 256 || byId.has(id)) continue
    const capabilities: Partial<Record<UpstreamCapabilityRequirement, boolean>> = {}
    for (const key of capabilityKeys) {
      const flag = item.capabilities?.[key]
      if (typeof flag === 'boolean') capabilities[key] = flag
    }
    byId.set(id, {
      id,
      ...(typeof item.displayName === 'string' && item.displayName.trim()
        ? { displayName: item.displayName.trim().slice(0, 128) }
        : {}),
      ...(positiveInteger(item.contextWindow) ? { contextWindow: positiveInteger(item.contextWindow) } : {}),
      ...(positiveInteger(item.maxOutputTokens) ? { maxOutputTokens: positiveInteger(item.maxOutputTokens) } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      ...(positiveInteger(item.discoveredAt) ? { discoveredAt: positiveInteger(item.discoveredAt) } : {}),
    })
  }
  const inferred = buildModelCatalog(models, fallbackProfile)
  for (const item of inferred) if (!byId.has(item.id)) byId.set(item.id, item)
  return [...byId.values()]
}

export function providerModelCapabilities(
  provider: ProviderDefinition,
  model: string | undefined,
): Partial<Record<UpstreamCapabilityRequirement, boolean>> {
  const profile = effectiveProviderCapabilities(provider)
  const selected = model ? provider.modelCatalog?.find((item) => item.id === model) : undefined
  return { ...profile, ...(selected?.capabilities ?? {}) }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
