import { describe, expect, it } from 'vitest'
import { resolveClaudeDesktopInferenceModels } from '../../src/main/agent-lifecycle/claude-desktop-models'
import type { AppStore } from '../../src/main/store/app-store'

describe('resolveClaudeDesktopInferenceModels', () => {
  it('publishes fixed Claude aliases plus safe explicit clients for a wildcard route', () => {
    const store = fakeStore({
      modelMap: {
        '*': 'grok-4.5',
        'claude-sonnet-5': 'gpt-5.5',
        'anthropic/claude-mythos-1': 'custom-upstream',
        'gpt-5.5': 'gpt-5.5',
      },
      sourceModels: ['grok-4.5'],
    })

    expect(resolveClaudeDesktopInferenceModels(store)).toEqual([
      model('claude-sonnet-5', 'sonnet'),
      model('claude-opus-4-8', 'opus'),
      model('claude-haiku-4-5', 'haiku'),
      model('claude-fable-5', 'fable'),
      model('anthropic/claude-mythos-1', 'mythos'),
    ])
  })

  it('uses only safe explicit client keys when there is no wildcard', () => {
    const store = fakeStore({
      modelMap: {
        'claude-opus-4-20250514': 'gpt-5.5',
        'anthropic.claude-opus-4-1-v1:0': 'upstream-opus',
        sonnet: 'claude-sonnet-4',
        'grok-4.5': 'grok-4.5',
      },
      sourceModels: ['claude-haiku-4-5'],
    })

    expect(resolveClaudeDesktopInferenceModels(store)).toEqual([
      model('claude-opus-4-20250514', 'opus'),
      {
        name: 'anthropic.claude-opus-4-1-v1:0',
        labelOverride: 'anthropic.claude-opus-4-1-v1:0',
        anthropicFamilyTier: 'opus',
      },
    ])
  })

  it('falls back to safe available source model ids without exposing other families', () => {
    const store = fakeStore({
      modelMap: {},
      sourceModels: [
        'gpt-5.5',
        'grok-4.5',
        'sonnet',
        'claude-haiku-4-5',
        'anthropic/claude-sonnet-4-20250514',
        'claude-haiku-4-5',
      ],
    })

    expect(resolveClaudeDesktopInferenceModels(store)).toEqual([
      model('claude-haiku-4-5', 'haiku'),
      model('anthropic/claude-sonnet-4-20250514', 'sonnet'),
    ])
  })

  it('rejects absent, non-native, and disabled Claude routes', () => {
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({ route: 'missing' })))
      .toThrow(/enabled Claude route using the Anthropic Messages protocol/)
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({ route: 'disabled' })))
      .toThrow(/enabled Claude route using the Anthropic Messages protocol/)
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({ route: 'responses' })))
      .toThrow(/enabled Claude route using the Anthropic Messages protocol/)
  })

  it('rejects a missing route source and an unsafe model-only source with actionable errors', () => {
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({ source: 'missing' })))
      .toThrow(/source is missing or invalid.*Choose a valid route source/)
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({ sourceModels: ['gpt-5.5', 'grok-4.5'] })))
      .toThrow(/Add a claude-\/anthropic model mapping or a wildcard upstream model/)
  })

  it('does not configure Desktop while every account in the route source is unavailable', () => {
    expect(() => resolveClaudeDesktopInferenceModels(fakeStore({
      accountStatus: 'disabled',
      modelMap: { '*': 'claude-sonnet-5' },
    }))).toThrow(/no available account.*Recover or replace the route source/)
  })

  it('marks only the first model in each inferred family as the default', () => {
    const models = resolveClaudeDesktopInferenceModels(fakeStore({
      modelMap: {
        'claude-sonnet-4': 'upstream-a',
        'claude-sonnet-3-7': 'upstream-b',
        'claude-opus-4': 'upstream-c',
        'claude-v2': 'upstream-d',
      },
    }))

    expect(models).toEqual([
      model('claude-sonnet-4', 'sonnet'),
      {
        name: 'claude-sonnet-3-7',
        labelOverride: 'claude-sonnet-3-7',
        anthropicFamilyTier: 'sonnet',
      },
      model('claude-opus-4', 'opus'),
      { name: 'claude-v2', labelOverride: 'claude-v2' },
    ])
  })
})

function model(name: string, anthropicFamilyTier: 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos') {
  return { name, labelOverride: name, anthropicFamilyTier, isFamilyDefault: true }
}

function fakeStore(input: {
  modelMap?: Record<string, string>
  sourceModels?: string[]
  route?: 'native' | 'missing' | 'disabled' | 'responses'
  source?: 'present' | 'missing'
  accountStatus?: 'active' | 'disabled'
} = {}): AppStore {
  const routeMode = input.route ?? 'native'
  const sourceId = input.source === 'missing' ? 'missing-provider' : 'provider-1'
  const route = {
    id: 'route-claude',
    client: 'claude',
    enabled: routeMode !== 'disabled',
    poolId: sourceId,
    inboundProtocol: routeMode === 'responses' ? 'openai-responses' : 'anthropic-messages',
    modelMap: input.modelMap ?? {},
    localToken: 'stone-token',
    createdAt: 1,
    updatedAt: 1,
  }
  const provider = {
    id: 'provider-1',
    name: 'Claude source',
    sourceType: 'official-api',
    kind: 'anthropic-compatible',
    protocol: 'anthropic-messages',
    baseUrl: 'https://example.invalid',
    models: input.sourceModels ?? [],
    createdAt: 1,
    updatedAt: 1,
  }
  const account = {
    id: 'account-1',
    providerId: provider.id,
    credentialType: 'api-key',
    status: input.accountStatus ?? 'active',
    modelPolicy: 'all',
    modelAllowlist: [],
    availableModels: [],
    updatedAt: 1,
  }
  return {
    getSnapshot: () => ({
      routes: routeMode === 'missing' ? [] : [route],
      pools: [],
      providers: input.source === 'missing' ? [] : [provider],
      accounts: input.source === 'missing' ? [] : [account],
    }),
  } as unknown as AppStore
}
