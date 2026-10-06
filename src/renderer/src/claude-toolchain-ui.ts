import type { ProviderDefinition } from '@shared/types'

export const CLAUDE_TOOLCHAIN_UNVERIFIED_COPY = Object.freeze({
  zh: '尚未通过 Claude 工具链验证，聊天可能可用但工具调用未确认',
  en: 'The Claude tool chain has not been verified. Chat may work, but tool calling is not confirmed.',
})

type ProviderDescriptor = Pick<
  ProviderDefinition,
  'sourceType' | 'kind' | 'protocol' | 'toolRoundtripVerified'
>

type RouteSourceDescriptor = {
  readonly accounts: readonly { readonly providerId: string }[]
}

export function isAnthropicCompatibleRelay(provider: ProviderDescriptor | undefined): boolean {
  return provider?.sourceType === 'relay'
    && provider.kind === 'anthropic-compatible'
    && provider.protocol === 'anthropic-messages'
}

/**
 * Legacy `origin=probed` profiles prove only a minimal generation round trip.
 * Only the main-process-owned two-turn marker is sufficient tool-chain proof.
 */
export function anthropicRelayNeedsClaudeToolchainWarning(
  provider: ProviderDescriptor | undefined,
): boolean {
  return isAnthropicCompatibleRelay(provider) && provider?.toolRoundtripVerified !== true
}

export function routeSourceNeedsClaudeToolchainWarning(
  source: RouteSourceDescriptor | undefined,
  providers: readonly ProviderDefinition[],
): boolean {
  if (!source) return false
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  return source.accounts.some((account) => (
    anthropicRelayNeedsClaudeToolchainWarning(providersById.get(account.providerId))
  ))
}
