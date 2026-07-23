import {
  CredentialResolutionError,
  RefreshAdapterError
} from './errors'
import type {
  ApiKeyCredentialRecord,
  CredentialLifecycleOptions,
  CredentialRecord,
  CredentialResolveOptions,
  RefreshAdapter,
  RefreshAdapterRegistry,
  RefreshAdapterResult,
  RenewableBearerCredentialRecord,
  ResolvedCredential
} from './types'

const defaultExpirySkewMs = 60_000

interface CachedBearerCredential {
  fingerprint: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

interface RefreshFlight {
  fingerprint: string
  controller: AbortController
  promise: Promise<ResolvedCredential>
  waiters: number
  settled: boolean
}

export class CredentialLifecycleResolver {
  private readonly now: () => number
  private readonly expirySkewMs: number
  private readonly cache = new Map<string, CachedBearerCredential>()
  private readonly refreshFlights = new Map<string, RefreshFlight>()

  constructor(private readonly options: CredentialLifecycleOptions) {
    this.now = options.now ?? Date.now
    this.expirySkewMs = options.expirySkewMs ?? defaultExpirySkewMs
    if (!Number.isFinite(this.expirySkewMs) || this.expirySkewMs < 0) {
      throw new CredentialResolutionError('invalid_credential_record')
    }
  }

  public async resolve(
    record: CredentialRecord,
    options: CredentialResolveOptions = {}
  ): Promise<ResolvedCredential> {
    validateRecord(record)
    throwIfAborted(options.signal)
    if (record.type === 'api-key') return this.resolveApiKey(record, options.signal)
    return this.resolveBearer(record, options.signal)
  }

  public invalidate(credentialId: string): void {
    this.cache.delete(credentialId)
    const flight = this.refreshFlights.get(credentialId)
    if (flight) flight.controller.abort()
  }

  private async resolveApiKey(
    record: ApiKeyCredentialRecord,
    signal?: AbortSignal
  ): Promise<ResolvedCredential> {
    const secret = await this.readSecret(record.secretRef, signal)
    return createResolvedCredential(record.id, 'api-key', secret)
  }

  private async resolveBearer(
    record: RenewableBearerCredentialRecord,
    signal?: AbortSignal
  ): Promise<ResolvedCredential> {
    const fingerprint = bearerFingerprint(record)
    const cached = this.cache.get(record.id)
    if (cached && cached.fingerprint !== fingerprint) {
      this.cache.delete(record.id)
    } else if (cached) {
      if (this.isOutsideRefreshWindow(cached.expiresAt)) {
        return createResolvedCredential(record.id, 'bearer', cached.accessToken, cached.expiresAt)
      }
      return this.resolveThroughRefresh(record, fingerprint, cached, signal)
    }

    if (this.isOutsideRefreshWindow(record.expiresAt)) {
      const accessToken = await this.readSecret(record.accessTokenRef, signal)
      this.cache.set(record.id, { fingerprint, accessToken, expiresAt: record.expiresAt })
      return createResolvedCredential(record.id, 'bearer', accessToken, record.expiresAt)
    }
    return this.resolveThroughRefresh(record, fingerprint, undefined, signal)
  }

  private async resolveThroughRefresh(
    record: RenewableBearerCredentialRecord,
    fingerprint: string,
    cached: CachedBearerCredential | undefined,
    signal?: AbortSignal
  ): Promise<ResolvedCredential> {
    throwIfAborted(signal)
    const existing = this.refreshFlights.get(record.id)
    if (existing) {
      if (existing.fingerprint === fingerprint) return this.waitForFlight(existing, signal)
      try {
        await this.waitForFlight(existing, signal)
      } catch (error) {
        if (signal?.aborted) throw new CredentialResolutionError('cancelled')
        if (error instanceof CredentialResolutionError && error.code === 'cancelled') {
          await existing.promise.catch(() => undefined)
        }
      }
      return this.resolveBearer(record, signal)
    }

    const controller = new AbortController()
    const flight = {} as RefreshFlight
    flight.fingerprint = fingerprint
    flight.controller = controller
    flight.waiters = 0
    flight.settled = false
    flight.promise = this.performRefresh(record, fingerprint, cached, controller.signal)
    this.refreshFlights.set(record.id, flight)
    void flight.promise.then(
      () => this.finishFlight(record.id, flight),
      () => this.finishFlight(record.id, flight)
    )
    return this.waitForFlight(flight, signal)
  }

  private async performRefresh(
    record: RenewableBearerCredentialRecord,
    fingerprint: string,
    cached: CachedBearerCredential | undefined,
    signal: AbortSignal
  ): Promise<ResolvedCredential> {
    const adapter = getRefreshAdapter(this.options.refreshAdapters, record.refreshAdapterId)
    if (!adapter) throw new CredentialResolutionError('refresh_adapter_unavailable')

    const refreshToken = cached?.refreshToken
      ?? await this.readSecret(record.refreshTokenRef, signal)
    let result: RefreshAdapterResult
    try {
      result = await adapter.refresh({
        credentialId: record.id,
        refreshToken,
        scopes: record.scopes,
        signal
      })
      throwIfAborted(signal)
    } catch (error) {
      const classified = classifyRefreshFailure(error, signal)
      if (classified.code === 'invalid_grant' || classified.code === 'revoked') {
        this.cache.delete(record.id)
      }
      throw classified
    }

    const accessToken = validSecret(result.accessToken)
    const expiresAt = refreshExpiry(result, this.now())
    if (!accessToken || expiresAt === undefined) {
      throw new CredentialResolutionError('invalid_refresh_response')
    }

    let nextRefreshToken = refreshToken
    if (result.refreshToken !== undefined) {
      const rotatedRefreshToken = validSecret(result.refreshToken)
      if (!rotatedRefreshToken) throw new CredentialResolutionError('invalid_refresh_response')
      if (rotatedRefreshToken !== refreshToken) {
        try {
          await this.options.onRefreshTokenRotation?.({
            credentialId: record.id,
            previousRefreshTokenRef: record.refreshTokenRef,
            refreshToken: rotatedRefreshToken
          }, signal)
          throwIfAborted(signal)
        } catch (error) {
          if (isAbortFailure(error, signal)) throw new CredentialResolutionError('cancelled')
          this.cache.delete(record.id)
          throw new CredentialResolutionError('rotation_persistence_failed')
        }
        nextRefreshToken = rotatedRefreshToken
      }
    }

    this.cache.set(record.id, {
      fingerprint,
      accessToken,
      refreshToken: nextRefreshToken,
      expiresAt
    })
    return createResolvedCredential(record.id, 'bearer', accessToken, expiresAt)
  }

  private async readSecret(secretRef: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    let secret: string | undefined
    try {
      secret = await this.options.secretReader.readSecret(secretRef, signal)
      throwIfAborted(signal)
    } catch (error) {
      if (error instanceof CredentialResolutionError) throw error
      if (isAbortFailure(error, signal)) throw new CredentialResolutionError('cancelled')
      throw new CredentialResolutionError('secret_unavailable')
    }
    const valid = validSecret(secret)
    if (!valid) throw new CredentialResolutionError('secret_unavailable')
    return valid
  }

  private waitForFlight(flight: RefreshFlight, signal?: AbortSignal): Promise<ResolvedCredential> {
    throwIfAborted(signal)
    flight.waiters += 1
    return new Promise<ResolvedCredential>((resolve, reject) => {
      let completed = false
      const release = (): void => {
        if (completed) return
        completed = true
        signal?.removeEventListener('abort', onAbort)
        flight.waiters -= 1
      }
      const onAbort = (): void => {
        if (completed) return
        release()
        if (flight.waiters === 0 && !flight.settled) flight.controller.abort()
        reject(new CredentialResolutionError('cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      void flight.promise.then(
        (resolved) => {
          if (completed) return
          release()
          resolve(resolved)
        },
        (error: unknown) => {
          if (completed) return
          release()
          if (signal?.aborted || flight.controller.signal.aborted) {
            reject(new CredentialResolutionError('cancelled'))
          } else {
            reject(error)
          }
        }
      )
    })
  }

  private finishFlight(credentialId: string, flight: RefreshFlight): void {
    flight.settled = true
    if (this.refreshFlights.get(credentialId) === flight) this.refreshFlights.delete(credentialId)
  }

  private isOutsideRefreshWindow(expiresAt: number): boolean {
    return expiresAt - this.now() > this.expirySkewMs
  }
}

function createResolvedCredential(
  credentialId: string,
  type: 'api-key' | 'bearer',
  secret: string,
  expiresAt?: number
): ResolvedCredential {
  const metadata = (): { credentialId: string; type: 'api-key' | 'bearer'; expiresAt?: number } => ({
    credentialId,
    type,
    ...(expiresAt === undefined ? {} : { expiresAt })
  })
  return Object.freeze({
    ...metadata(),
    getSecret: () => secret,
    toJSON: metadata
  })
}

function getRefreshAdapter(
  registry: RefreshAdapterRegistry | undefined,
  adapterId: string
): RefreshAdapter | undefined {
  if (!registry) return undefined
  if (typeof (registry as ReadonlyMap<string, RefreshAdapter>).get === 'function') {
    return (registry as ReadonlyMap<string, RefreshAdapter>).get(adapterId)
  }
  if (!Object.prototype.hasOwnProperty.call(registry, adapterId)) return undefined
  return (registry as Readonly<Record<string, RefreshAdapter>>)[adapterId]
}

function classifyRefreshFailure(error: unknown, signal: AbortSignal): CredentialResolutionError {
  if (error instanceof CredentialResolutionError) return error
  if (isAbortFailure(error, signal)) return new CredentialResolutionError('cancelled')

  const details = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const adapterError = error instanceof RefreshAdapterError ? error : undefined
  const rawCode = adapterError?.code
    ?? stringValue(details?.code)
    ?? stringValue(details?.error)
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const code = rawCode?.toLowerCase() ?? ''
  if (code === 'invalid_grant' || message.includes('invalid_grant')) {
    return new CredentialResolutionError('invalid_grant')
  }
  if (
    code === 'revoked'
    || code === 'token_revoked'
    || message.includes('revoked')
    || message.includes('revocation')
  ) {
    return new CredentialResolutionError('revoked')
  }

  const statusCode = adapterError?.statusCode
    ?? numberValue(details?.statusCode)
    ?? numberValue(details?.status)
  if (statusCode === 401 || statusCode === 403) {
    return new CredentialResolutionError('revoked')
  }
  const retryable = adapterError?.retryable
    ?? (
      statusCode === 429
      || (statusCode !== undefined && statusCode >= 500)
      || statusCode === undefined
    )
  return new CredentialResolutionError('refresh_failed', { retryable })
}

function refreshExpiry(result: RefreshAdapterResult, now: number): number | undefined {
  const expiresInSeconds = numberValue(result.expiresInSeconds)
  const expiresAt = numberValue(result.expiresAt)
    ?? (expiresInSeconds === undefined
      ? undefined
      : now + expiresInSeconds * 1000)
  return expiresAt !== undefined && expiresAt > now ? expiresAt : undefined
}

function validateRecord(record: CredentialRecord): void {
  if (!validIdentifier(record.id)) throw new CredentialResolutionError('invalid_credential_record')
  if (record.type === 'api-key') {
    if (!validIdentifier(record.secretRef)) throw new CredentialResolutionError('invalid_credential_record')
    return
  }
  if (
    !validIdentifier(record.accessTokenRef)
    || !validIdentifier(record.refreshTokenRef)
    || !validIdentifier(record.refreshAdapterId)
    || !Number.isFinite(record.expiresAt)
    || record.expiresAt <= 0
    || (record.scopes !== undefined && !record.scopes.every(validIdentifier))
  ) {
    throw new CredentialResolutionError('invalid_credential_record')
  }
}

function bearerFingerprint(record: RenewableBearerCredentialRecord): string {
  return [
    record.accessTokenRef,
    record.refreshTokenRef,
    record.refreshAdapterId,
    record.expiresAt,
    ...(record.scopes ?? [])
  ].join('\u0000')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CredentialResolutionError('cancelled')
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ABORT_ERR'
}

function validSecret(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
