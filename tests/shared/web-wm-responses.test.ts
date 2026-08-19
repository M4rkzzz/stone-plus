import { describe, expect, it } from 'vitest'
import { estimateResponsesInputTokens } from '../../src/shared/web-wm-responses'

describe('Responses input token estimate', () => {
  it('ignores transport-only controls and grows with input content', () => {
    const short = estimateResponsesInputTokens({
      model: 'model-a',
      input: 'short',
      stream: false,
      service_tier: 'default',
    })
    const sameInput = estimateResponsesInputTokens({
      model: 'model-b',
      input: 'short',
      stream: true,
      service_tier: 'priority',
    })
    const long = estimateResponsesInputTokens({
      model: 'model-a',
      input: 'short '.repeat(100),
    })

    expect(short).toBe(sameInput)
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })

  it('does not treat client metadata as model context', () => {
    const baseline = estimateResponsesInputTokens({
      input: 'same semantic request',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    })
    const withMetadata = estimateResponsesInputTokens({
      input: 'same semantic request',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      client_metadata: { installation_id: 'x'.repeat(100_000) },
      metadata: { trace: 'y'.repeat(100_000) },
      previous_response_id: 'resp_prior',
    })

    expect(withMetadata).toBe(baseline)
  })
})
