import { describe, expect, it } from 'vitest'
import {
  normalizeCodexModelRepairPolicy,
  repairedCodexClientModel,
} from '../../src/shared/codex-model-repair'

describe('Codex model repair policy', () => {
  it('uses an authoritative account catalog without turning it into a global whitelist', () => {
    const policy = normalizeCodexModelRepairPolicy({
      modelMap: {},
      fallbackModel: 'gpt-5.6',
      allowedModels: [' gpt-5.6 ', 'gpt-5.5-codex', 'gpt-5.6'],
    })!

    expect(policy.allowedModels).toEqual(['gpt-5.6', 'gpt-5.5-codex'])
    expect(repairedCodexClientModel('gpt-5.5-codex', policy)).toBe('gpt-5.5-codex')
    expect(repairedCodexClientModel('relay-only-model', policy)).toBe('gpt-5.6')
    expect(repairedCodexClientModel('relay-only-model', {
      modelMap: {},
      fallbackModel: 'gpt-5.6',
    })).toBe('relay-only-model')
  })
})
