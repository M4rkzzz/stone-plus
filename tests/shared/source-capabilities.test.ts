import { describe, expect, it } from 'vitest'
import {
  buildModelCatalog,
  effectiveProviderCapabilities,
  normalizeCapabilityProfile,
  normalizeModelCatalog,
} from '../../src/shared/source-capabilities'
import type { ProviderDefinition } from '../../src/shared/types'

const provider: ProviderDefinition = {
  id: 'provider',
  name: 'Relay',
  sourceType: 'relay',
  kind: 'openai-compatible',
  baseUrl: 'https://relay.example/v1',
  protocol: 'openai-responses',
  models: ['gpt-test'],
  responsesCompactMode: 'passthrough',
  createdAt: 1,
  updatedAt: 1,
}

describe('source capability profiles', () => {
  it('infers safe defaults for legacy providers without blocking routing', () => {
    expect(effectiveProviderCapabilities(provider)).toMatchObject({
      version: 1,
      origin: 'inferred',
      streaming: true,
      toolCalls: true,
      compact: true,
    })
  })

  it('normalizes persisted flags and ignores invalid metadata', () => {
    const normalized = normalizeCapabilityProfile({
      version: 1,
      origin: 'probed',
      checkedAt: 100,
      streaming: false,
      websocket: true,
    }, effectiveProviderCapabilities(provider))
    expect(normalized).toMatchObject({ origin: 'probed', checkedAt: 100, streaming: false, websocket: true })
  })

  it('builds and merges a stable model catalog', () => {
    const profile = effectiveProviderCapabilities(provider)
    const generated = buildModelCatalog(['gpt-test', 'gpt-test'], profile, 20)
    expect(generated).toHaveLength(1)
    expect(normalizeModelCatalog([{ id: 'custom', contextWindow: 100_000 }], ['gpt-test'], profile))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'custom', contextWindow: 100_000 }),
        expect.objectContaining({ id: 'gpt-test' }),
      ]))
  })
})
