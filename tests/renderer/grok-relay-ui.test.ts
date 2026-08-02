import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_COMPATIBLE_KIND,
  DEEPSEEK_KIND,
  KIRO_COMPATIBLE_KIND,
  newRelayConnectionDefaults,
  protocolAfterProviderKindChange,
  protocolOptionLabel,
  protocolsByProviderKind,
  providerKindLabelsZh,
  relayProtocolSelectLocked,
  XAI_COMPATIBLE_KIND,
} from '../../src/renderer/src/grok-relay-ui'
import { protocolLabels } from '../../src/renderer/src/ui'

describe('Grok/xAI relay renderer defaults', () => {
  it('uses the xAI-compatible Responses preset without an OpenAI URL', () => {
    expect(newRelayConnectionDefaults()).toMatchObject({
      kind: XAI_COMPATIBLE_KIND,
      baseUrl: 'https://',
      protocol: 'openai-responses',
      responsesCompactMode: 'auto',
    })
    expect(newRelayConnectionDefaults().baseUrl).not.toContain('api.openai.com')
    expect(providerKindLabelsZh[XAI_COMPATIBLE_KIND]).toContain('Grok')
  })

  it('offers Responses first and labels Chat as advanced compatibility', () => {
    expect(protocolsByProviderKind[XAI_COMPATIBLE_KIND]).toEqual(['openai-responses', 'openai-chat'])
    const translate = (zh: string, en: string) => `${zh} / ${en}`
    expect(protocolOptionLabel(XAI_COMPATIBLE_KIND, 'openai-responses', protocolLabels, translate)).toContain('推荐')
    expect(protocolOptionLabel(XAI_COMPATIBLE_KIND, 'openai-chat', protocolLabels, translate)).toContain('高级')
  })

  it('defaults an explicit xAI selection to Responses while preserving other compatible choices', () => {
    expect(protocolAfterProviderKindChange(XAI_COMPATIBLE_KIND, 'openai-chat')).toBe('openai-responses')
    expect(protocolAfterProviderKindChange('openai-compatible', 'openai-chat')).toBe('openai-chat')
    expect(protocolAfterProviderKindChange('anthropic-compatible', 'openai-chat')).toBe('anthropic-messages')
  })

  it('locks the Kiro Claude relay kind to the dedicated native protocol', () => {
    expect(providerKindLabelsZh[KIRO_COMPATIBLE_KIND]).toBe('Kiro Claude 中转')
    expect(protocolsByProviderKind[KIRO_COMPATIBLE_KIND]).toEqual(['kiro-claude'])
    expect(protocolAfterProviderKindChange(KIRO_COMPATIBLE_KIND, 'anthropic-messages')).toBe('kiro-claude')
    expect(protocolOptionLabel(KIRO_COMPATIBLE_KIND, 'kiro-claude', protocolLabels, (zh) => zh)).toBe('Kiro Claude')
    expect(relayProtocolSelectLocked(KIRO_COMPATIBLE_KIND)).toBe(true)
    expect(relayProtocolSelectLocked(XAI_COMPATIBLE_KIND)).toBe(false)
  })

  it('keeps official DeepSeek native while exposing Chat compatibility for relays', () => {
    expect(providerKindLabelsZh[DEEPSEEK_KIND]).toBe('DeepSeek')
    expect(providerKindLabelsZh[DEEPSEEK_COMPATIBLE_KIND]).toBe('DeepSeek 兼容中转')
    expect(protocolsByProviderKind[DEEPSEEK_KIND]).toEqual(['openai-responses'])
    expect(protocolAfterProviderKindChange(DEEPSEEK_COMPATIBLE_KIND, 'openai-chat')).toBe('openai-responses')
    expect(protocolOptionLabel(DEEPSEEK_COMPATIBLE_KIND, 'openai-responses', protocolLabels, (zh) => zh))
      .toContain('Flash')
    expect(protocolOptionLabel(DEEPSEEK_COMPATIBLE_KIND, 'openai-chat', protocolLabels, (zh) => zh))
      .toContain('Pro')
    expect(relayProtocolSelectLocked(DEEPSEEK_COMPATIBLE_KIND)).toBe(false)
    expect(protocolsByProviderKind[DEEPSEEK_COMPATIBLE_KIND]).toEqual(['openai-responses', 'openai-chat'])
  })
})
