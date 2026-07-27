import {
  enumerateRouteSourceModels,
  isAvailableRouteAccount,
  resolveRouteSource,
} from '@shared/route-sources'
import type { AppStore } from '../store/app-store'
import type {
  ClaudeDesktopAnthropicFamilyTier,
  ClaudeDesktopInferenceModel,
} from './claude-desktop-config'

const WILDCARD_MODEL_ALIASES = [
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-fable-5',
] as const

const FAMILY_TIERS: readonly ClaudeDesktopAnthropicFamilyTier[] = [
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'mythos',
]

/**
 * Build the model catalog Claude Desktop may safely display for Stone+'s
 * enabled native Claude route. Upstream-only names are deliberately never
 * projected into the Desktop profile: an OpenAI or Grok model must remain
 * behind an explicit Claude-facing route alias.
 */
export function resolveClaudeDesktopInferenceModels(store: AppStore): ClaudeDesktopInferenceModel[] {
  const snapshot = store.getSnapshot()
  const route = snapshot.routes.find((candidate) => (
    candidate.client === 'claude'
    && candidate.enabled
    && candidate.inboundProtocol === 'anthropic-messages'
  ))
  if (!route) {
    throw new Error(
      'Claude Desktop requires an enabled Claude route using the Anthropic Messages protocol.',
    )
  }

  const source = resolveRouteSource(route.poolId, snapshot)
  if (!source) {
    throw new Error(
      'Claude Desktop cannot use the enabled Claude route because its source is missing or invalid. Choose a valid route source.',
    )
  }
  if (!source.accounts.some(isAvailableRouteAccount)) {
    throw new Error(
      'Claude Desktop cannot use the enabled Claude route because it has no available account. Recover or replace the route source first.',
    )
  }

  const sourceModels = enumerateRouteSourceModels(source, snapshot)
  const explicitClientModels = Object.keys(route.modelMap)
    .filter((name) => name !== '*')
    .map((name) => name.trim())
    .filter(isSafeClaudeModelName)
  const wildcardTarget = route.modelMap['*']?.trim()

  const names = wildcardTarget
    ? uniqueModelNames([...WILDCARD_MODEL_ALIASES, ...explicitClientModels])
    : explicitClientModels.length > 0
      ? uniqueModelNames(explicitClientModels)
      : uniqueModelNames(sourceModels.map((name) => name.trim()).filter(isSafeClaudeModelName))

  if (names.length === 0) {
    throw new Error(
      'Claude Desktop cannot expose a safe Claude model name. Add a claude-/anthropic model mapping or a wildcard upstream model to the enabled Claude route.',
    )
  }

  return describeModels(names)
}

function isSafeClaudeModelName(name: string): boolean {
  if (!name || /\s/.test(name)) return false
  return /^(?:claude-[a-z0-9][a-z0-9._:/-]*|anthropic[./:-]claude[./:-][a-z0-9][a-z0-9._:/-]*)$/i.test(name)
}

function uniqueModelNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names) {
    const normalized = name.trim()
    const identity = normalized.toLocaleLowerCase('en-US')
    if (!normalized || seen.has(identity)) continue
    seen.add(identity)
    result.push(normalized)
  }
  return result
}

function describeModels(names: readonly string[]): ClaudeDesktopInferenceModel[] {
  const defaultTiers = new Set<ClaudeDesktopAnthropicFamilyTier>()
  return names.map((name) => {
    const tier = inferFamilyTier(name)
    const isFamilyDefault = tier !== undefined && !defaultTiers.has(tier)
    if (tier && isFamilyDefault) defaultTiers.add(tier)
    return {
      name,
      labelOverride: name,
      ...(tier ? { anthropicFamilyTier: tier } : {}),
      ...(isFamilyDefault ? { isFamilyDefault: true } : {}),
    }
  })
}

function inferFamilyTier(name: string): ClaudeDesktopAnthropicFamilyTier | undefined {
  const lowerName = name.toLocaleLowerCase('en-US')
  return FAMILY_TIERS.find((tier) => new RegExp(`(?:^|[./:_-])${tier}(?:$|[./:_-])`).test(lowerName))
}
