import type {
  CredentialResolutionErrorCode,
  RefreshAdapterFailureCode
} from './types'

const resolutionMessages: Record<CredentialResolutionErrorCode, string> = {
  cancelled: 'Credential resolution was cancelled.',
  secret_unavailable: 'A required credential secret is unavailable.',
  refresh_adapter_unavailable: 'No refresh adapter is configured for this credential.',
  invalid_grant: 'Credential refresh was rejected because the authorization grant is no longer valid.',
  revoked: 'Credential refresh was rejected because the authorization was revoked.',
  refresh_failed: 'Credential refresh failed.',
  invalid_refresh_response: 'The refresh adapter returned an invalid credential response.',
  rotation_persistence_failed: 'The rotated refresh credential could not be persisted.',
  invalid_credential_record: 'The credential record is invalid.'
}

export class CredentialResolutionError extends Error {
  public readonly retryable: boolean

  constructor(
    public readonly code: CredentialResolutionErrorCode,
    options: { retryable?: boolean } = {}
  ) {
    super(resolutionMessages[code])
    this.name = 'CredentialResolutionError'
    this.retryable = options.retryable ?? false
  }

  public toJSON(): { name: string; code: CredentialResolutionErrorCode; message: string; retryable: boolean } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable
    }
  }
}

export class RefreshAdapterError extends Error {
  constructor(
    public readonly code: RefreshAdapterFailureCode,
    public readonly statusCode?: number,
    public readonly retryable?: boolean
  ) {
    super('The refresh adapter reported a credential refresh failure.')
    this.name = 'RefreshAdapterError'
  }
}
