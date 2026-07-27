import type { PublicAccount, RequestLog } from '@shared/types'

type CredentialType = PublicAccount['credentialType']

/**
 * OAuth-managed accounts own their provider binding and credential lifecycle;
 * UI flows that edit provider credentials directly must exclude all three kinds
 * together — never narrow this set at a call site.
 */
export function isOAuthManagedCredential(credentialType: CredentialType): boolean {
  return credentialType === 'chatgpt-oauth'
    || credentialType === 'chatgpt-agent-identity'
    || credentialType === 'grok-oauth'
}

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
