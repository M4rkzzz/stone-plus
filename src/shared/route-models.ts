const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export const MAX_ROUTE_MODEL_NAME_LENGTH = 256

export type RouteModelMappingValidation = {
  valid: true
  source: string
  target: string
} | {
  valid: false
  reason: 'invalid-source' | 'invalid-target'
}

/**
 * Resolves a client-facing model name without consulting inherited properties.
 * Exact aliases win over the optional wildcard; invalid mappings are ignored.
 */
export function resolveRouteModel(
  modelMap: Readonly<Record<string, unknown>> | null | undefined,
  requested: string,
): string {
  const exact = readOwnMapping(modelMap, requested)
  if (exact !== undefined) return exact
  return readOwnMapping(modelMap, '*') ?? requested
}

/** Creates a persistence-safe map whose keys cannot mutate an object prototype. */
export function normalizeRouteModelMap(modelMap: unknown): Record<string, string> {
  const normalized = Object.create(null) as Record<string, string>
  if (!modelMap || typeof modelMap !== 'object' || Array.isArray(modelMap)) return normalized

  for (const [rawSource, rawTarget] of Object.entries(modelMap)) {
    const source = rawSource.trim()
    const target = normalizeTarget(rawTarget)
    if (!isSafeRouteModelMapKey(source) || target === undefined) continue
    Object.defineProperty(normalized, source, {
      value: target,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return normalized
}

/** Creates a persistence-safe exact model-to-source map. A wildcard is not
 * accepted because Route.poolId is the explicit and observable default. */
export function normalizeRouteModelSourceMap(modelSourceMap: unknown): Record<string, string> {
  const normalized = Object.create(null) as Record<string, string>
  if (!modelSourceMap || typeof modelSourceMap !== 'object' || Array.isArray(modelSourceMap)) return normalized

  for (const [rawModel, rawSourceId] of Object.entries(modelSourceMap)) {
    const model = rawModel.trim()
    const sourceId = normalizeRouteSourceId(rawSourceId)
    if (model === '*' || !isSafeRouteModelMapKey(model) || sourceId === undefined) continue
    Object.defineProperty(normalized, model, {
      value: sourceId,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return normalized
}

/** Resolves an exact per-model source override without inherited-property or
 * wildcard ambiguity, then falls back to the route's ordinary source. */
export function resolveRouteSourceId(
  defaultSourceId: string,
  modelSourceMap: Readonly<Record<string, unknown>> | null | undefined,
  requestedModel: string,
): string {
  if (!isSafeRouteModelMapKey(requestedModel) || requestedModel === '*') return defaultSourceId
  if (!modelSourceMap || typeof modelSourceMap !== 'object' || !Object.hasOwn(modelSourceMap, requestedModel)) {
    return defaultSourceId
  }
  return normalizeRouteSourceId(modelSourceMap[requestedModel]) ?? defaultSourceId
}

export function routeReferencedSourceIds(
  route: { poolId: string; modelSourceMap?: Readonly<Record<string, unknown>> },
): string[] {
  const ids = new Set<string>()
  const defaultSourceId = normalizeRouteSourceId(route.poolId)
  if (defaultSourceId) ids.add(defaultSourceId)
  for (const sourceId of Object.values(normalizeRouteModelSourceMap(route.modelSourceMap))) ids.add(sourceId)
  return [...ids]
}

export function routeReferencesSource(
  route: { poolId: string; modelSourceMap?: Readonly<Record<string, unknown>> },
  sourceId: string,
): boolean {
  const normalized = normalizeRouteSourceId(sourceId)
  return normalized !== undefined && routeReferencedSourceIds(route).includes(normalized)
}

export function isSafeRouteModelMapKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_ROUTE_MODEL_NAME_LENGTH
    && !hasControlCharacter(value)
    && !PROTOTYPE_POLLUTION_KEYS.has(value)
}

/** Shared renderer/main-process target validation after whitespace trimming. */
export function isSafeRouteModelMapTarget(value: string): boolean {
  const normalized = value.trim()
  return normalized.length > 0
    && normalized.length <= MAX_ROUTE_MODEL_NAME_LENGTH
    && !hasControlCharacter(normalized)
}

/** Validates and normalizes one editor row without silently dropping it. */
export function validateRouteModelMapping(sourceValue: unknown, targetValue: unknown): RouteModelMappingValidation {
  if (typeof sourceValue !== 'string') return { valid: false, reason: 'invalid-source' }
  const source = sourceValue.trim()
  if (!isSafeRouteModelMapKey(source)) return { valid: false, reason: 'invalid-source' }
  if (typeof targetValue !== 'string' || !isSafeRouteModelMapTarget(targetValue)) {
    return { valid: false, reason: 'invalid-target' }
  }
  return { valid: true, source, target: targetValue.trim() }
}

function readOwnMapping(
  modelMap: Readonly<Record<string, unknown>> | null | undefined,
  source: string,
): string | undefined {
  if (!modelMap || typeof modelMap !== 'object' || !isSafeRouteModelMapKey(source)) return undefined
  if (!Object.hasOwn(modelMap, source)) return undefined
  return normalizeTarget(modelMap[source])
}

function normalizeTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!isSafeRouteModelMapTarget(normalized)) return undefined
  return normalized
}

function normalizeRouteSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ROUTE_MODEL_NAME_LENGTH || hasControlCharacter(normalized)) return undefined
  return normalized
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
