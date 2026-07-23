export interface AsyncOperationToken {
  sequence: number
  binding: string
}

export type GuardedAsyncOperationResult<T> =
  | { status: 'applied'; token: AsyncOperationToken; value: T }
  | { status: 'stale'; token: AsyncOperationToken }
  | { status: 'failed'; token: AsyncOperationToken; error: unknown }

/**
 * Orders an asynchronous renderer task against both newer tasks and mutable
 * form/runtime state. A result is publishable only while both still match.
 */
export class BoundAsyncOperation {
  private sequence = 0

  public invalidate(): void {
    this.sequence += 1
  }

  public isLatest(token: AsyncOperationToken): boolean {
    return token.sequence === this.sequence
  }

  public async run<T>(
    binding: string,
    currentBinding: () => string,
    operation: () => Promise<T>,
  ): Promise<GuardedAsyncOperationResult<T>> {
    const token = { sequence: ++this.sequence, binding }
    try {
      const value = await operation()
      if (!this.isLatest(token) || currentBinding() !== binding) return { status: 'stale', token }
      return { status: 'applied', token, value }
    } catch (error) {
      if (!this.isLatest(token) || currentBinding() !== binding) return { status: 'stale', token }
      return { status: 'failed', token, error }
    }
  }
}

export type ExclusiveAsyncOperationResult<T> =
  | { started: false }
  | { started: true; value: T }

/** Prevents same-tick UI actions from bypassing React's pending-state render. */
export class ExclusiveAsyncOperation {
  private active: symbol | undefined

  public get busy(): boolean {
    return this.active !== undefined
  }

  public async run<T>(operation: () => Promise<T>): Promise<ExclusiveAsyncOperationResult<T>> {
    if (this.active) return { started: false }
    const token = Symbol('renderer-operation')
    this.active = token
    try {
      return { started: true, value: await operation() }
    } finally {
      if (this.active === token) this.active = undefined
    }
  }
}

/** Executes persistence calls in invocation order, including after failures. */
export class SerializedAsyncOperation {
  private tail: Promise<void> = Promise.resolve()

  public enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Shares one in-flight request with every caller and reopens after settlement. */
export class SingleFlightAsyncOperation {
  private flight: Promise<unknown> | undefined

  public get busy(): boolean {
    return this.flight !== undefined
  }

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.flight) return this.flight as Promise<T>
    const flight = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.flight === flight) this.flight = undefined
      })
    this.flight = flight
    return flight
  }
}

/**
 * Gives reads/mutations their order when they start, while pushed events get
 * their order when observed. An event observed during a request therefore
 * always wins over that request's eventual response.
 */
export class StartOrderedAsyncValue<T> {
  private nextSequence = 0
  private appliedSequence = 0

  public constructor(private readonly apply: (value: T) => void) {}

  public push(value: T): boolean {
    return this.publish(value, ++this.nextSequence)
  }

  public async run(operation: () => Promise<T>): Promise<T> {
    const sequence = ++this.nextSequence
    const value = await operation()
    this.publish(value, sequence)
    return value
  }

  private publish(value: T, sequence: number): boolean {
    if (sequence < this.appliedSequence) return false
    this.appliedSequence = sequence
    this.apply(value)
    return true
  }
}

export function redactSensitiveText(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join('••••'), message)
}
