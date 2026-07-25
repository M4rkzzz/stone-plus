import { describe, expect, it } from 'vitest'
import {
  newRelayConnectionDefaults,
  protocolAfterProviderKindChange,
  protocolOptionLabel,
  protocolsByProviderKind,
  providerKindLabelsZh,
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
})
