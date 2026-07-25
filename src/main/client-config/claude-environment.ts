/** Model selectors commonly left behind by provider-specific Claude relay
 * setup scripts. Stone+ keeps upstream selection in Route.modelMap instead. */
export const CLAUDE_RELAY_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_REASONING_MODEL',
] as const

export function withoutClaudeRelayModelEnvironment<T extends Record<string, string | undefined>>(environment: T): T {
  const sanitized = { ...environment }
  for (const key of CLAUDE_RELAY_MODEL_ENV_KEYS) delete sanitized[key]
  return sanitized
}

export function isClaudeClientModelName(value: string): boolean {
  const model = value.trim().toLowerCase()
  return ['default', 'sonnet', 'opus', 'haiku', 'inherit'].includes(model) || model.startsWith('claude-')
}
