import type { ProviderKind } from './types'

export type ProviderSourceFamily = 'openai' | 'deepseek' | 'grok' | 'anthropic' | 'google' | 'kiro' | 'custom'

/** Stable routing family used to prevent semantically different sources sharing one pool. */
export function providerSourceFamily(kind: ProviderKind): ProviderSourceFamily {
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
      return 'openai'
    case 'deepseek':
    case 'deepseek-compatible':
      return 'deepseek'
    case 'xai':
    case 'xai-compatible':
      return 'grok'
    case 'anthropic':
    case 'anthropic-compatible':
      return 'anthropic'
    case 'kiro-compatible':
      return 'kiro'
    case 'google':
      return 'google'
    case 'custom':
      return 'custom'
  }
}
