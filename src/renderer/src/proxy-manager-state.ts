import type { ProxyInput, ProxyProtocol } from '@shared/types'

export function nextProxyProtocolDraft(
  draft: ProxyInput,
  protocol: ProxyProtocol,
  existingHasPassword: boolean,
  clearPasswordExplicitlySelected: boolean,
): ProxyInput {
  if (protocol === 'socks4') {
    return {
      ...draft,
      protocol,
      password: '',
      clearPassword: existingHasPassword || draft.clearPassword,
    }
  }
  const returningFromSocks4 = draft.protocol === 'socks4'
  return {
    ...draft,
    protocol,
    clearPassword: returningFromSocks4 && existingHasPassword && !clearPasswordExplicitlySelected
      ? false
      : draft.clearPassword,
  }
}
