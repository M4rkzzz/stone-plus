import { providerSourceFamily } from './source-family'
import type {
  Account,
  PoolProtocol,
  ProviderDefinition,
  PublicAccount,
} from './types'

type PoolProtocolAccount = Pick<Account | PublicAccount, 'credentialType'>
type PoolProtocolProvider = Pick<ProviderDefinition, 'kind' | 'protocol' | 'sourceType'>

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
