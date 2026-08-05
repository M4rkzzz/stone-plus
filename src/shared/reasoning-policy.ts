import type { ReasoningEffort, ReasoningEffortMap } from './types'

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[]

const reasoningEffortSet = new Set<string>(REASONING_EFFORTS)

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return reasoningEffortSet.has(normalized) ? normalized as ReasoningEffort : undefined
}

export function normalizeReasoningEffortMap(value: unknown): ReasoningEffortMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: ReasoningEffortMap = {}
  for (const effort of REASONING_EFFORTS) {
    const mapped = normalizeReasoningEffort((value as Record<string, unknown>)[effort])
    if (mapped && mapped !== effort) result[effort] = mapped
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function applyReasoningEffortPolicy(
  requested: unknown,
  cap?: ReasoningEffort,
  mapping?: ReasoningEffortMap,
): ReasoningEffort | undefined {
  const normalized = normalizeReasoningEffort(requested)
  if (!normalized) return undefined
  const mapped = normalizeReasoningEffort(mapping?.[normalized]) ?? normalized
  if (!cap) return mapped
  const capIndex = REASONING_EFFORTS.indexOf(cap)
  const mappedIndex = REASONING_EFFORTS.indexOf(mapped)
  return capIndex >= 0 && mappedIndex > capIndex ? cap : mapped
}
