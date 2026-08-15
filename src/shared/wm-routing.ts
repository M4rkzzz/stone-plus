import type { Account, PoolProtocol, PublicAccount } from './types'

export const GPT_5_6_SOL_WM_MODEL = 'gpt-5.6-sol-wm'

type WmRoutingAccount = Pick<Account | PublicAccount, 'credentialType'>

export function isWmRoutingAccount(account: WmRoutingAccount): boolean {
  return account.credentialType === 'chatgpt-oauth'
    || account.credentialType === 'chatgpt-agent-identity'
}

/** The hidden WM route is available only on ChatGPT's native Responses transport. */
export function supportsPoolWmRouting(
  protocol: PoolProtocol,
  accounts: readonly WmRoutingAccount[],
): boolean {
  return protocol === 'openai-responses'
    && accounts.length > 0
    && accounts.every(isWmRoutingAccount)
}
