const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export const MAX_ROUTE_MODEL_NAME_LENGTH = 256

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

export function isSafeRouteModelMapKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_ROUTE_MODEL_NAME_LENGTH
    && !hasControlCharacter(value)
    && !PROTOTYPE_POLLUTION_KEYS.has(value)
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
  if (!normalized
    || normalized.length > MAX_ROUTE_MODEL_NAME_LENGTH
    || hasControlCharacter(normalized)) return undefined
  return normalized
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
