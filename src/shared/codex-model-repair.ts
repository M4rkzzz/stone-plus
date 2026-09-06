import { normalizeRouteModelMap } from './route-models'
import { deepSeekOnlyRouteContextWindow } from './deepseek'
import { enumerateRouteSourceModels, resolveRouteSource } from './route-sources'
import type { AppSnapshot, Route } from './types'

export interface CodexModelRepairPolicy {
  /** Codex-facing requested model to upstream model. */
  modelMap: Record<string, string>
  /** Safe Codex-facing model used when no exact reverse mapping exists. */
  fallbackModel: string
  /** Optional authoritative catalog; persisted models outside it are replaced by the fallback. */
  allowedModels?: string[]
}

export interface CodexConnectionRouteMetadata {
  modelContextWindow?: number
  codexModelRepair: CodexModelRepairPolicy
}

const FOREIGN_MODEL_PREFIX = /^(?:deepseek|claude|grok|gemini|qwen|kimi|moonshot|glm|minimax)(?:[-_.:/]|$)/i
const CODEX_FACING_MODEL = /^(?:gpt-|o[134](?:-|$)|codex-)/i

/**
 * Build the Codex-specific connection metadata once for every configuration
 * surface. The client page and lifecycle coordinator must use the same model
 * catalog policy or a valid DeepSeek setup can be reported as both ready and
 * unconfigured at the same time.
 */
export function codexConnectionRouteMetadata(
  snapshot: Pick<AppSnapshot, 'accounts' | 'pools' | 'providers'>,
  route: Pick<Route, 'poolId' | 'modelMap' | 'modelSourceMap'>,
): CodexConnectionRouteMetadata {
  const exactModels = Object.keys(route.modelMap).filter((model) => model !== '*')
  const source = resolveRouteSource(route.poolId, snapshot)
  const nativeSourceModel = enumerateRouteSourceModels(source, snapshot)
    .find((model) => CODEX_FACING_MODEL.test(model.trim()))
  const modelContextWindow = deepSeekOnlyRouteContextWindow(snapshot, route)
  return {
    ...(modelContextWindow ? { modelContextWindow } : {}),
    codexModelRepair: {
      modelMap: { ...route.modelMap },
      fallbackModel: exactModels.find((model) => CODEX_FACING_MODEL.test(model.trim()))
        ?? nativeSourceModel
        ?? 'gpt-5.6-sol',
    },
  }
}

export function normalizeCodexModelRepairPolicy(
  value: CodexModelRepairPolicy | undefined,
): CodexModelRepairPolicy | undefined {
  if (!value) return undefined
  const fallbackModel = value.fallbackModel.trim()
  if (!fallbackModel) return undefined
  return {
    modelMap: normalizeRouteModelMap(value.modelMap),
    fallbackModel,
    ...(value.allowedModels
      ? { allowedModels: [...new Set(value.allowedModels.map((model) => model.trim()).filter(Boolean))] }
      : {}),
  }
}

/** Convert an upstream model persisted by another switcher back to Stone+'s Codex-facing alias. */
export function repairedCodexClientModel(
  value: unknown,
  policy: CodexModelRepairPolicy | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  if (!model || !policy) return model || undefined

  for (const [clientModel, upstreamModel] of Object.entries(policy.modelMap)) {
    if (clientModel !== '*' && upstreamModel === model) return clientModel
  }
  if (policy.allowedModels?.length && !policy.allowedModels.includes(model)) return policy.fallbackModel
  return FOREIGN_MODEL_PREFIX.test(model) ? policy.fallbackModel : model
}
