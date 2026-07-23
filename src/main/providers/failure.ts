import type { ProviderFailure, ProviderFailureInput } from './types'

const DEFAULT_RETRY_AFTER_MS = 30_000

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  const now = input.now ?? Date.now()
  const statusCode = input.statusCode
  if (statusCode !== undefined) return classifyHttpFailure(statusCode, input.headers, now)
  return classifyThrownFailure(input.error)
}

export function parseRetryAfter(headers: HeadersInit | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined
  const value = new Headers(headers).get('retry-after')?.trim()
  if (!value) return undefined

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : undefined
  }

  const retryAt = Date.parse(value)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined
}

export function invalidResponseFailure(): ProviderFailure {
  return {
    category: 'invalid_response',
    message: 'Provider returned an invalid model response.',
    retryable: false,
    accountAction: 'none'
  }
}

function classifyHttpFailure(statusCode: number, headers: HeadersInit | undefined, now: number): ProviderFailure {
  if (statusCode === 401) {
    return failure('authentication', 'Provider rejected the account credential.', true, 'disable', statusCode)
  }
  if (statusCode === 403) {
    return failure('permission', 'Provider denied access for this account.', true, 'disable', statusCode)
  }
  if (statusCode === 402) {
    return failure('quota', 'Provider account quota is depleted or requires payment.', true, 'disable', statusCode)
  }
  if (statusCode === 408) {
    return failure('timeout', 'Provider request timed out.', true, 'cooldown', statusCode)
  }
  if (statusCode === 409 || statusCode === 425) {
    return failure('conflict', 'Provider could not process the request yet.', true, 'cooldown', statusCode)
  }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers, now) ?? DEFAULT_RETRY_AFTER_MS
    return {
      ...failure('rate_limit', 'Provider rate limit reached.', true, 'cooldown', statusCode),
      retryAfterMs,
      retryAt: now + retryAfterMs
    }
  }
  if (statusCode >= 500 && statusCode <= 599) {
    const retryAfterMs = parseRetryAfter(headers, now)
    return {
      ...failure('upstream', 'Provider service is temporarily unavailable.', true, 'cooldown', statusCode),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAt: now + retryAfterMs })
    }
  }
  if (statusCode === 404) {
    return failure('not_found', 'Provider endpoint or model was not found.', false, 'none', statusCode)
  }
  if (statusCode >= 400 && statusCode <= 499) {
    return failure('invalid_request', 'Provider rejected the request.', false, 'none', statusCode)
  }
  return failure('unknown', 'Provider request failed.', false, 'none', statusCode)
}

function classifyThrownFailure(error: unknown): ProviderFailure {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') {
    return failure('timeout', 'Provider request timed out.', true, 'cooldown')
  }
  if (name === 'AbortError') {
    return failure('cancelled', 'Provider request was cancelled.', false, 'none')
  }
  if (error instanceof TypeError || error instanceof Error) {
    return failure('network', 'Provider could not be reached.', true, 'cooldown')
  }
  return failure('unknown', 'Provider request failed.', false, 'none')
}

function failure(
  category: ProviderFailure['category'],
  message: string,
  retryable: boolean,
  accountAction: ProviderFailure['accountAction'],
  statusCode?: number
): ProviderFailure {
  return {
    category,
    message,
    retryable,
    accountAction,
    ...(statusCode === undefined ? {} : { statusCode })
  }
}
