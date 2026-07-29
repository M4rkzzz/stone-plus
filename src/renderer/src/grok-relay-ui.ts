import type { ApiSourceInput, Protocol, ProviderKind } from '@shared/types'

export const XAI_COMPATIBLE_KIND: ProviderKind = 'xai-compatible'
export const KIRO_COMPATIBLE_KIND: ProviderKind = 'kiro-compatible'

export const providerKindLabelsZh: Readonly<Record<ProviderKind, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'Grok / xAI',
  google: 'Google',
  'openai-compatible': 'OpenAI 兼容',
  'xai-compatible': 'Grok / xAI 兼容中转',
  'anthropic-compatible': 'Anthropic 兼容',
  'kiro-compatible': 'Kiro Claude 中转',
  custom: '自定义',
})

export const providerKindLabelsEn: Readonly<Record<ProviderKind, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'Grok / xAI',
  google: 'Google',
  'openai-compatible': 'OpenAI compatible',
  'xai-compatible': 'Grok / xAI compatible relay',
  'anthropic-compatible': 'Anthropic compatible',
  'kiro-compatible': 'Kiro Claude relay',
  custom: 'Custom',
})

export const protocolsByProviderKind: Readonly<Record<ProviderKind, readonly Protocol[]>> = Object.freeze({
  anthropic: ['anthropic-messages'],
  openai: ['openai-responses', 'openai-chat'],
  xai: ['openai-chat'],
  google: ['gemini'],
  'openai-compatible': ['openai-responses', 'openai-chat'],
  'xai-compatible': ['openai-responses', 'openai-chat'],
  'anthropic-compatible': ['anthropic-messages'],
  'kiro-compatible': ['kiro-claude'],
  custom: ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini'],
})

export function newRelayConnectionDefaults(): Pick<
  ApiSourceInput,
  'kind' | 'baseUrl' | 'protocol' | 'responsesCompactMode'
> {
  return {
    kind: XAI_COMPATIBLE_KIND,
    baseUrl: 'https://',
    protocol: 'openai-responses',
    responsesCompactMode: 'auto',
  }
}

/**
 * Selecting the Grok preset is an explicit action, so it may apply its safe
 * protocol default. Merely reopening an existing xAI-compatible source never
 * calls this helper and therefore preserves a saved Chat configuration.
 */
export function protocolAfterProviderKindChange(
  kind: ProviderKind,
  currentProtocol: Protocol,
): Protocol {
  if (kind === XAI_COMPATIBLE_KIND) return 'openai-responses'
  if (kind === KIRO_COMPATIBLE_KIND) return 'kiro-claude'
  const supported = protocolsByProviderKind[kind]
  return supported.includes(currentProtocol) ? currentProtocol : supported[0]
}

export function relayProtocolSelectLocked(kind: ProviderKind): boolean {
  return kind === KIRO_COMPATIBLE_KIND
}

export function protocolOptionLabel(
  kind: ProviderKind,
  protocol: Protocol,
  labels: Readonly<Record<Protocol, string>>,
  t: (zh: string, en: string) => string,
): string {
  if (kind === KIRO_COMPATIBLE_KIND) return t('Kiro Claude', 'Kiro Claude')
  if (kind !== XAI_COMPATIBLE_KIND) return labels[protocol]
  if (protocol === 'openai-responses') {
    return t('OpenAI Responses（推荐）', 'OpenAI Responses (recommended)')
  }
  if (protocol === 'openai-chat') {
    return t('OpenAI Chat（高级兼容）', 'OpenAI Chat (advanced compatibility)')
  }
  return labels[protocol]
}
