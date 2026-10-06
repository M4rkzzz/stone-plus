import { describe, expect, it } from 'vitest'
import {
  accountModelCatalog,
  buildPoolModelCoverage,
  effectiveAccountModels,
  effectivePoolModels,
  isAccountModelWildcard,
  isPoolModelWildcard,
  pruneModelSelection,
  type ModelPolicyAccount,
} from '../../src/renderer/src/model-policy'

function account(overrides: Partial<ModelPolicyAccount> = {}): ModelPolicyAccount {
  return {
    id: 'account-1',
    providerId: 'provider-1',
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    ...overrides,
  }
}

describe('renderer model policy helpers', () => {
  it('uses an account refresh as the authoritative catalog', () => {
    const refreshed = account({
      availableModels: ['gpt-5.5', 'gpt-5.5-mini'],
      modelsRefreshedAt: 123,
    })

    expect(accountModelCatalog(refreshed, ['provider-only'])).toEqual({
      models: ['gpt-5.5', 'gpt-5.5-mini'],
      source: 'account',
    })
    expect(effectiveAccountModels(refreshed, ['provider-only'])).not.toContain('provider-only')
  })

  it('marks provider models as a compatibility fallback before account refresh', () => {
    const legacy = account({ modelPolicy: 'selected', modelAllowlist: ['legacy-selected'] })

    expect(accountModelCatalog(legacy, ['provider-model'])).toEqual({
      models: ['provider-model', 'legacy-selected'],
      source: 'provider-fallback',
    })
    expect(effectiveAccountModels(legacy, ['provider-model'])).toEqual(['legacy-selected'])
  })

  it('supports selected with an empty list as explicitly exposing no models', () => {
    const hidden = account({
      availableModels: ['gpt-5.5'],
      modelsRefreshedAt: 123,
      modelPolicy: 'selected',
      modelAllowlist: [],
    })

    expect(effectiveAccountModels(hidden)).toEqual([])
  })

  it('recognizes an unrefreshed all account as a compatibility wildcard while only enumerating fallback candidates', () => {
    const wildcard = account({ modelPolicy: 'all', availableModels: [], modelsRefreshedAt: undefined })

    expect(isAccountModelWildcard(wildcard)).toBe(true)
    expect(effectiveAccountModels(wildcard, ['provider-model'])).toEqual(['provider-model'])
    expect(isAccountModelWildcard({ ...wildcard, modelsRefreshedAt: 1 })).toBe(false)
    expect(isAccountModelWildcard({ ...wildcard, modelPolicy: 'selected' })).toBe(false)
  })

  it('treats an all pool with an enabled wildcard member as wildcard, but keeps selected pools finite', () => {
    const wildcard = account({ id: 'wildcard', modelPolicy: 'all', modelsRefreshedAt: undefined })
    const refreshed = account({ id: 'refreshed', availableModels: ['gpt-5.5'], modelsRefreshedAt: 1 })

    expect(isPoolModelWildcard({
      modelPolicy: 'all',
      members: [
        { accountId: 'wildcard', enabled: true },
        { accountId: 'refreshed', enabled: true },
      ],
    }, [wildcard, refreshed])).toBe(true)
    expect(isPoolModelWildcard({
      modelPolicy: 'selected',
      members: [{ accountId: 'wildcard', enabled: true }],
    }, [wildcard])).toBe(false)
    expect(isPoolModelWildcard({
      modelPolicy: 'all',
      members: [{ accountId: 'wildcard', enabled: false }],
    }, [wildcard])).toBe(false)
  })

  it('builds the member union and reports N/M support coverage', () => {
    const summary = buildPoolModelCoverage([
      account({ id: 'a', availableModels: ['gpt-5.5'], modelsRefreshedAt: 1 }),
      account({ id: 'b', availableModels: ['gpt-5.5', 'gpt-5.5-mini'], modelsRefreshedAt: 2 }),
    ], () => ['provider-only'])

    expect(summary).toEqual({
      options: [
        { model: 'gpt-5.5', supportCount: 2, totalAccounts: 2 },
        { model: 'gpt-5.5-mini', supportCount: 1, totalAccounts: 2 },
      ],
      totalAccounts: 2,
      fallbackAccountCount: 0,
    })
  })

  it('does not add selected-empty accounts to the pool union', () => {
    const summary = buildPoolModelCoverage([
      account({
        id: 'hidden',
        availableModels: ['gpt-5.5'],
        modelsRefreshedAt: 1,
        modelPolicy: 'selected',
        modelAllowlist: [],
      }),
      account({ id: 'visible', availableModels: ['gpt-5.5-mini'], modelsRefreshedAt: 2 }),
    ])

    expect(summary.options).toEqual([
      { model: 'gpt-5.5-mini', supportCount: 1, totalAccounts: 2 },
    ])
  })

  it('applies pool all/selected policy and prunes models after membership changes', () => {
    const coverage = [
      { model: 'gpt-5.5', supportCount: 2, totalAccounts: 2 },
      { model: 'gpt-5.5-mini', supportCount: 1, totalAccounts: 2 },
    ]

    expect(effectivePoolModels({ modelPolicy: 'all', modelAllowlist: [] }, coverage)).toEqual([
      'gpt-5.5',
      'gpt-5.5-mini',
    ])
    expect(effectivePoolModels({ modelPolicy: 'selected', modelAllowlist: [] }, coverage)).toEqual([])
    expect(pruneModelSelection(['gpt-5.5', 'gpt-5.5-mini'], ['gpt-5.5'])).toEqual(['gpt-5.5'])
  })
})
