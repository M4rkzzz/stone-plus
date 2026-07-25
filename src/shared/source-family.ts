import type { ProviderKind } from './types'

export type ProviderSourceFamily = 'openai' | 'grok' | 'anthropic' | 'google' | 'custom'

/** Stable routing family used to prevent semantically different sources sharing one pool. */
export function providerSourceFamily(kind: ProviderKind): ProviderSourceFamily {
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
      return 'openai'
    case 'xai':
    case 'xai-compatible':
      return 'grok'
    case 'anthropic':
    case 'anthropic-compatible':
      return 'anthropic'
    case 'google':
      return 'google'
    case 'custom':
      return 'custom'
  }
}
