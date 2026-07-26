import { describe, expect, it, vi } from 'vitest'
import {
  analyzeProtocolConversion,
  createCanonicalStreamEncoder,
  createCanonicalStreamParser,
} from '../../src/main/gateway'
import {
  extractProtocolUsage,
  kiroClaudeAdapter,
  probeProviderModel,
} from '../../src/main/providers'
import {
  effectiveProviderCapabilities,
  inferUpstreamCapabilities,
  normalizeCapabilityProfile,
} from '../../src/shared/source-capabilities'
import {
  supportsFastServiceTier,
  supportsPoolFastServiceTier,
  type ProviderDefinition,
} from '../../src/shared/types'

const kiroProvider: ProviderDefinition = {
  id: 'kiro-provider',
  name: 'Kiro relay',
  sourceType: 'relay',
  kind: 'kiro-compatible',
  baseUrl: 'https://kiro.example/generateAssistantResponse',
  protocol: 'kiro-claude',
  models: ['claude-sonnet-4-5'],
  createdAt: 1,
  updatedAt: 1,
}

describe('Kiro Claude protocol boundaries', () => {
  it('uses conservative inferred capabilities until the dedicated probe supplies evidence', () => {
    expect(effectiveProviderCapabilities(kiroProvider)).toMatchObject({
      origin: 'inferred',
      streaming: true,
      nonStreaming: true,
      modelDiscovery: false,
      toolCalls: false,
      compact: false,
    })

    const probed = normalizeCapabilityProfile({
      version: 1,
      origin: 'probed',
      checkedAt: 10,
      toolCalls: true,
    }, inferUpstreamCapabilities({ protocol: 'kiro-claude', kind: 'kiro-compatible', sourceType: 'relay' }))
    expect(probed).toMatchObject({
      origin: 'probed',
      streaming: true,
      nonStreaming: true,
      modelDiscovery: false,
      toolCalls: true,
      compact: false,
    })
    expect(supportsFastServiceTier('kiro-claude')).toBe(false)
    expect(supportsPoolFastServiceTier('kiro-claude')).toBe(false)
  })

  it('does not let generic conversion analysis admit Kiro into compatibility or compact fallback', () => {
    expect(analyzeProtocolConversion('kiro-claude', 'kiro-claude', {})).toEqual({
      supported: true,
      issues: [],
    })
    expect(analyzeProtocolConversion('openai-responses', 'kiro-claude', {
      model: 'gpt-test',
      input: 'summarize',
    })).toMatchObject({ supported: false, issues: [{ path: 'body', capability: 'content-part' }] })
    expect(analyzeProtocolConversion('kiro-claude', 'anthropic-messages', {}))
      .toMatchObject({ supported: false, issues: [{ path: 'body', capability: 'content-part' }] })
  })

  it('rejects Kiro in generic model and streaming helpers instead of treating it as Gemini', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    await expect(probeProviderModel({
      adapter: kiroClaudeAdapter,
      baseUrl: kiroProvider.baseUrl,
      protocol: 'kiro-claude',
      credential: 'credential-private',
      model: 'claude-sonnet-4-5',
      fetchImplementation,
    })).rejects.toThrow(/dedicated two-round API source probe/)
    expect(fetchImplementation).not.toHaveBeenCalled()

    expect(() => createCanonicalStreamParser('kiro-claude')).toThrow(/dedicated Amazon event-stream bridge/)
    expect(() => createCanonicalStreamEncoder('kiro-claude')).toThrow(/dedicated Amazon event-stream bridge/)
  })

  it('leaves Kiro usage extraction to the dedicated event-stream parser', () => {
    expect(extractProtocolUsage('kiro-claude', {
      usage: { input_tokens: 10, output_tokens: 5 },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    })).toBeUndefined()
  })
})
