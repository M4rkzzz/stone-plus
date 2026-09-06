import { providerSourceFamily } from './source-family'
import { hasVerifiedChatGptWebWm } from './wm-routing'
import type {
  Account,
  PoolProtocol,
  ProviderDefinition,
  PublicAccount,
} from './types'

type PoolProtocolAccount = Pick<Account | PublicAccount, 'credentialType' | 'chatgptWebWm'>
type PoolProtocolProvider = Pick<ProviderDefinition, 'kind' | 'protocol' | 'sourceType'>

/** Accounts that may run the real Work probe; plan labels are intentionally not admission criteria. */
export function isChatGptWebWmAccountCandidate(
  account: PoolProtocolAccount,
  provider: PoolProtocolProvider | undefined,
): boolean {
  return provider?.kind === 'openai'
    && provider.protocol === 'openai-responses'
    && provider.sourceType === 'oauth-system'
    && account.credentialType === 'chatgpt-oauth'
}

/** Resolve the logical protocol under which an account may be pooled. */
export function accountPoolProtocol(
  account: PoolProtocolAccount,
  provider: PoolProtocolProvider,
): PoolProtocol {
  if (account.credentialType === 'grok-oauth'
    || (account.credentialType === 'api-key' && providerSourceFamily(provider.kind) === 'grok')) {
    return 'grok'
  }
  return provider.protocol
}

export function accountMatchesPoolProtocol(
  protocol: PoolProtocol,
  account: PoolProtocolAccount,
  provider: PoolProtocolProvider | undefined,
): boolean {
  if (!provider || provider.sourceType === 'relay') return false
  if (protocol === 'chatgpt-web-wm') {
    return isChatGptWebWmAccountCandidate(account, provider)
      && hasVerifiedChatGptWebWm(account)
  }
  if (protocol === 'grok') {
    if (providerSourceFamily(provider.kind) !== 'grok') return false
    if (account.credentialType === 'grok-oauth') {
      return provider.kind === 'xai' && provider.sourceType === 'oauth-system'
    }
    if (account.credentialType !== 'api-key') return false
  }
  return accountPoolProtocol(account, provider) === protocol
}

export function isGrokPoolProtocol(protocol: PoolProtocol): protocol is 'grok' {
  return protocol === 'grok'
}
