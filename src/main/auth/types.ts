export interface ApiKeyCredentialRecord {
  id: string
  type: 'api-key'
  secretRef: string
}

export interface RenewableBearerCredentialRecord {
  id: string
  type: 'renewable-bearer'
  accessTokenRef: string
  refreshTokenRef: string
  refreshAdapterId: string
  expiresAt: number
  scopes?: string[]
}

export type CredentialRecord = ApiKeyCredentialRecord | RenewableBearerCredentialRecord

export interface SecretReader {
  readSecret(secretRef: string, signal?: AbortSignal): Promise<string | undefined>
}

export interface RefreshAdapterInput {
  credentialId: string
  refreshToken: string
  scopes?: readonly string[]
  signal: AbortSignal
}

export interface RefreshAdapterResult {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  expiresInSeconds?: number
}

/** Implementations own documented provider-specific transport and token endpoints. */
export interface RefreshAdapter {
  refresh(input: RefreshAdapterInput): Promise<RefreshAdapterResult>
}

export type RefreshAdapterRegistry =
  | ReadonlyMap<string, RefreshAdapter>
  | Readonly<Record<string, RefreshAdapter>>

export interface RefreshTokenRotation {
  credentialId: string
  previousRefreshTokenRef: string
  refreshToken: string
}

export type RefreshTokenRotationHandler = (
  rotation: RefreshTokenRotation,
  signal: AbortSignal
) => Promise<void> | void

export interface ResolvedCredential {
  credentialId: string
  type: 'api-key' | 'bearer'
  expiresAt?: number
  /** Returns the secret only to the trusted request-building call site. */
  getSecret(): string
  toJSON(): {
    credentialId: string
    type: 'api-key' | 'bearer'
    expiresAt?: number
  }
}

export interface CredentialResolveOptions {
  signal?: AbortSignal
}

export interface CredentialLifecycleOptions {
  secretReader: SecretReader
  refreshAdapters?: RefreshAdapterRegistry
  onRefreshTokenRotation?: RefreshTokenRotationHandler
  expirySkewMs?: number
  now?: () => number
}

export type CredentialResolutionErrorCode =
  | 'cancelled'
  | 'secret_unavailable'
  | 'refresh_adapter_unavailable'
  | 'invalid_grant'
  | 'revoked'
  | 'refresh_failed'
  | 'invalid_refresh_response'
  | 'rotation_persistence_failed'
  | 'invalid_credential_record'

export type RefreshAdapterFailureCode =
  | 'invalid_grant'
  | 'revoked'
  | 'temporarily_unavailable'
  | 'other'
