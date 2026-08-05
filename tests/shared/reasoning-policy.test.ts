import { describe, expect, it } from 'vitest'
import {
  applyReasoningEffortPolicy,
  normalizeReasoningEffortMap,
} from '../../src/shared/reasoning-policy'

describe('pool reasoning effort policy', () => {
  it('applies exact mapping before the cap', () => {
    expect(applyReasoningEffortPolicy('medium', 'high', { medium: 'max' })).toBe('high')
    expect(applyReasoningEffortPolicy('xhigh', 'medium', { xhigh: 'low' })).toBe('low')
  })

  it('never raises a lower requested effort through a cap', () => {
    expect(applyReasoningEffortPolicy('low', 'high')).toBe('low')
    expect(applyReasoningEffortPolicy('max', 'high')).toBe('high')
    expect(applyReasoningEffortPolicy(undefined, 'high')).toBeUndefined()
  })

  it('drops malformed mapping values instead of persisting them', () => {
    expect(normalizeReasoningEffortMap({
      low: 'medium',
      medium: 'turbo',
      invalid: 'max',
    })).toEqual({ low: 'medium' })
  })
})
