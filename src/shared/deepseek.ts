import { resolveRouteSource } from './route-sources'
import type { AppSnapshot, ModelCapabilityDefinition, ProviderDefinition, Route } from './types'

export const DEEPSEEK_RESPONSES_DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_RESPONSES_PRO_MODEL = 'deepseek-v4-pro'

/** Current DeepSeek V4 Flash wire limits documented for Codex integrations. */
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_048_576
export const DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS = 384_000
export const DEEPSEEK_V4_FLASH_EFFECTIVE_CONTEXT_PERCENT = 95

export type DeepSeekReasoningEffort = 'none' | 'low' | 'high' | 'max'

/** DeepSeek's highest native Responses reasoning tier. */
export const DEEPSEEK_DEFAULT_REASONING_EFFORT: DeepSeekReasoningEffort = 'max'

export function normalizeDeepSeekReasoningEffort(
  value: unknown,
  fallback: DeepSeekReasoningEffort = DEEPSEEK_DEFAULT_REASONING_EFFORT,
): DeepSeekReasoningEffort {
  return value === 'none' || value === 'low' || value === 'high' || value === 'max'
    ? value
    : fallback
}

/**
 * Models currently documented for the official DeepSeek Responses/Codex API.
 * Compatible relays are intentionally not restricted to this catalog.
 */
export const DEEPSEEK_RESPONSES_OFFICIAL_MODELS = Object.freeze([
  DEEPSEEK_RESPONSES_DEFAULT_MODEL,
  DEEPSEEK_RESPONSES_PRO_MODEL,
] as const)

const officialModelSet = new Set<string>(DEEPSEEK_RESPONSES_OFFICIAL_MODELS)

export function isOfficialDeepSeekResponsesModel(model: string): boolean {
  return officialModelSet.has(model.trim())
}

export function filterOfficialDeepSeekResponsesModels(models: readonly string[]): string[] {
  return models.filter(isOfficialDeepSeekResponsesModel)
}

/**
 * Adds model-specific limits without assigning DeepSeek's 1M window to GPT
 * aliases that may share the same Stone+ route.
 */
export function applyDeepSeekModelLimits(
  catalog: readonly ModelCapabilityDefinition[],
): ModelCapabilityDefinition[] {
  return catalog.map((model) => isOfficialDeepSeekResponsesModel(model.id)
    ? {
        ...model,
        contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
        maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
      }
    : model)
}

function isOfficialDeepSeekResponsesProvider(provider: ProviderDefinition): boolean {
  if (
    provider.kind !== 'deepseek'
    || provider.sourceType !== 'official-api'
    || provider.protocol !== 'openai-responses'
  ) return false
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase()
    return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/**
 * Returns DeepSeek's global Codex window only when every enabled source is the
 * official Responses endpoint. Compatible relays can expose the same model
 * names while having different context limits and tool dialects, so they must
 * not inherit the vendor catalog implicitly.
 */
export function deepSeekOnlyRouteContextWindow(
  snapshot: Pick<AppSnapshot, 'accounts' | 'pools' | 'providers'>,
  route: Pick<Route, 'poolId' | 'modelSourceMap'>,
): number | undefined {
  const sourceIds = new Set([route.poolId, ...Object.values(route.modelSourceMap ?? {})])
  const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]))
  let found = false
  for (const sourceId of sourceIds) {
    const source = resolveRouteSource(sourceId, snapshot)
    if (!source || source.accounts.length === 0) return undefined
    for (const account of source.accounts) {
      const provider = providers.get(account.providerId)
      if (!provider || !isOfficialDeepSeekResponsesProvider(provider)) return undefined
      found = true
    }
  }
  return found ? DEEPSEEK_V4_FLASH_CONTEXT_WINDOW : undefined
}
