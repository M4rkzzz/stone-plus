type OAuthRefreshProvider = 'openai' | 'xai'

interface Waiter {
  signal?: AbortSignal
  resolve(): void
  reject(error: unknown): void
  abort?: () => void
}

interface ProviderGateState {
  active: number
  queue: Waiter[]
  nextAdmissionAt: number
  transientFailures: number
  deferUntil: number
}

const MAX_CONCURRENT_REFRESHES = 2
const MIN_ADMISSION_INTERVAL_MS = 100
const MAX_PROVIDER_DEFER_MS = 5_000
const gates = new Map<OAuthRefreshProvider, ProviderGateState>()

/** Bounds refresh traffic across accounts without replacing account-local single-flight. */
export function runOAuthRefreshRequest(
  provider: OAuthRefreshProvider,
  signal: AbortSignal | undefined,
  operation: () => Promise<Response>,
): Promise<Response> {
  const state = providerState(provider)
  signal?.throwIfAborted()
  if (
    state.active < MAX_CONCURRENT_REFRESHES
    && state.queue.length === 0
    && Math.max(state.nextAdmissionAt, state.deferUntil) <= Date.now()
  ) {
    state.active += 1
    return runAcquiredOperation(state, signal, operation)
  }
  return acquire(state, signal).then(async () => {
    try {
      const delayMs = reserveAdmission(state, signal)
      if (delayMs > 0) await abortableDelay(delayMs, signal)
      return await runOperation(state, signal, operation)
    } finally {
      release(state)
    }
  })
}

async function runAcquiredOperation(
  state: ProviderGateState,
  signal: AbortSignal | undefined,
  operation: () => Promise<Response>,
): Promise<Response> {
  try {
    const delayMs = reserveAdmission(state, signal)
    if (delayMs > 0) await abortableDelay(delayMs, signal)
    return await runOperation(state, signal, operation)
  } finally {
    release(state)
  }
}

function runOperation(
  state: ProviderGateState,
  signal: AbortSignal | undefined,
  operation: () => Promise<Response>,
): Promise<Response> {
  signal?.throwIfAborted()
  let result: Promise<Response>
  try {
    result = operation()
  } catch (error) {
    if (!signal?.aborted) recordTransientFailure(state)
    throw error
  }
  return result.then((response) => {
    if (response.status === 429 || response.status >= 500) recordTransientFailure(state)
    else recordHealthyEndpoint(state)
    return response
  }, (error: unknown) => {
    if (!signal?.aborted) recordTransientFailure(state)
    throw error
  })
}

function providerState(provider: OAuthRefreshProvider): ProviderGateState {
  let state = gates.get(provider)
  if (!state) {
    state = { active: 0, queue: [], nextAdmissionAt: 0, transientFailures: 0, deferUntil: 0 }
    gates.set(provider, state)
  }
  return state
}

function acquire(state: ProviderGateState, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (state.active < MAX_CONCURRENT_REFRESHES && state.queue.length === 0) {
    state.active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject }
    state.queue.push(waiter)
    if (signal) {
      waiter.abort = () => {
        const index = state.queue.indexOf(waiter)
        if (index >= 0) state.queue.splice(index, 1)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    }
  })
}

function release(state: ProviderGateState): void {
  state.active = Math.max(0, state.active - 1)
  while (state.active < MAX_CONCURRENT_REFRESHES && state.queue.length > 0) {
    const waiter = state.queue.shift()!
    if (waiter.signal?.aborted) {
      if (waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(abortReason(waiter.signal))
      continue
    }
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
    state.active += 1
    waiter.resolve()
  }
  // Backoff protects one active burst. Once every owner and waiter has left,
  // a later user action is a new batch and must not inherit several seconds of
  // latency from an unrelated refresh attempt.
  if (state.active === 0 && state.queue.length === 0) {
    state.nextAdmissionAt = 0
    state.transientFailures = 0
    state.deferUntil = 0
  }
}

function reserveAdmission(state: ProviderGateState, signal?: AbortSignal): number {
  signal?.throwIfAborted()
  const now = Date.now()
  // Reserve the timestamp before yielding. Multiple waiters can be released
  // together when a slot opens; reserving atomically on the JS event loop keeps
  // them from all waking on the same stale nextAdmissionAt value.
  const admissionAt = Math.max(now, state.nextAdmissionAt, state.deferUntil)
  state.nextAdmissionAt = admissionAt + MIN_ADMISSION_INTERVAL_MS
  return Math.max(0, admissionAt - now)
}

function recordTransientFailure(state: ProviderGateState): void {
  state.transientFailures += 1
  if (state.transientFailures < 3) return
  const delayMs = Math.min(
    MAX_PROVIDER_DEFER_MS,
    250 * (2 ** Math.min(4, state.transientFailures - 3)),
  )
  state.deferUntil = Math.max(state.deferUntil, Date.now() + delayMs)
}

function recordHealthyEndpoint(state: ProviderGateState): void {
  state.transientFailures = 0
  state.deferUntil = 0
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs))
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('OAuth refresh was aborted.', 'AbortError')
}
