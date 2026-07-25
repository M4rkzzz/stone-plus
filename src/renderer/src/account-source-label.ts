import type { PublicAccount, RequestLog } from '@shared/types'

type CredentialType = PublicAccount['credentialType']

export function accountSourceLabel(
  credentialType: CredentialType,
  providerName: string | undefined,
): string {
  return credentialType === 'chatgpt-agent-identity' ? 'Agent Identity' : providerName ?? '—'
}

export function requestLogSourceLabel(
  log: Pick<RequestLog, 'credentialType' | 'providerName'>,
  currentCredentialType?: CredentialType,
): string {
  return accountSourceLabel(log.credentialType ?? currentCredentialType, log.providerName)
}
