export interface SystemLifecycleCoordinatorOptions {
  rebuildConnections: () => Promise<void>
  isOnline: () => boolean
  now?: () => number
  setIntervalImplementation?: typeof setInterval
  clearIntervalImplementation?: typeof clearInterval
  setTimeoutImplementation?: typeof setTimeout
  clearTimeoutImplementation?: typeof clearTimeout
  pollIntervalMs?: number
  recoveryDebounceMs?: number
  onError?: (error: Error) => void
}

/**
 * Coordinates sleep and network transitions without aborting active streams.
 * Connection rebuilding publishes fresh transport generations; callers that
 * already hold an older generation are allowed to finish at full speed.
 */
export class SystemLifecycleCoordinator {
  private readonly rebuildConnections: () => Promise<void>
  private readonly isOnline: () => boolean
  private readonly now: () => number
  private readonly setIntervalImplementation: typeof setInterval
  private readonly clearIntervalImplementation: typeof clearInterval
  private readonly setTimeoutImplementation: typeof setTimeout
  private readonly clearTimeoutImplementation: typeof clearTimeout
  private readonly pollIntervalMs: number
  private readonly recoveryDebounceMs: number
  private readonly onError: (error: Error) => void
  private timer?: ReturnType<typeof setInterval>
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private suspended = false
  private closed = false
  private online: boolean
  private lastRecoveryAt = 0
  private recovery?: Promise<void>
  private pendingRecovery = false
  private readonly idleWaiters = new Set<() => void>()

  public constructor(options: SystemLifecycleCoordinatorOptions) {
    this.rebuildConnections = options.rebuildConnections
    this.isOnline = options.isOnline
    this.now = options.now ?? Date.now
    this.setIntervalImplementation = options.setIntervalImplementation ?? setInterval
    this.clearIntervalImplementation = options.clearIntervalImplementation ?? clearInterval
    this.setTimeoutImplementation = options.setTimeoutImplementation ?? setTimeout
    this.clearTimeoutImplementation = options.clearTimeoutImplementation ?? clearTimeout
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000)
    this.recoveryDebounceMs = Math.max(0, options.recoveryDebounceMs ?? 1_500)
    this.onError = options.onError ?? ((error) => console.warn('Stone+ network recovery failed', error))
    this.online = this.safeOnline()
  }

  public start(): void {
    if (this.closed || this.timer) return
    this.timer = this.setIntervalImplementation(() => this.poll(), this.pollIntervalMs)
    this.timer.unref?.()
  }

  public onSuspend(): void {
    if (this.closed) return
    this.suspended = true
    if (this.recoveryTimer) {
      this.clearTimeoutImplementation(this.recoveryTimer)
      this.recoveryTimer = undefined
      this.pendingRecovery = true
    }
    this.notifyIdleIfSettled()
  }

  public onResume(): void {
    if (this.closed) return
    this.suspended = false
    this.online = this.safeOnline()
    if (this.online) {
      this.pendingRecovery = false
      this.scheduleRecovery()
    }
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      if (this.timer) this.clearIntervalImplementation(this.timer)
      this.timer = undefined
      if (this.recoveryTimer) this.clearTimeoutImplementation(this.recoveryTimer)
      this.recoveryTimer = undefined
      this.pendingRecovery = false
    }
    const active = this.recovery
    if (active) await active
    this.notifyIdleIfSettled()
  }

  public waitForIdle(): Promise<void> {
    if (this.isSettled()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private poll(): void {
    if (this.closed || this.suspended) return
    const nextOnline = this.safeOnline()
    const becameOnline = !this.online && nextOnline
    this.online = nextOnline
    if (becameOnline) this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.closed) return
    if (this.suspended) {
      this.pendingRecovery = true
      return
    }
    if (this.recovery) {
      this.pendingRecovery = true
      return
    }
    if (this.recoveryTimer) return
    const delay = Math.max(0, this.recoveryDebounceMs - (this.now() - this.lastRecoveryAt))
    if (delay > 0) {
      this.recoveryTimer = this.setTimeoutImplementation(() => {
        this.recoveryTimer = undefined
        this.runRecovery()
      }, delay)
      this.recoveryTimer.unref?.()
      return
    }
    this.runRecovery()
  }

  private runRecovery(): void {
    if (this.closed || this.suspended) {
      this.pendingRecovery = !this.closed
      this.notifyIdleIfSettled()
      return
    }
    if (this.recovery) {
      this.pendingRecovery = true
      return
    }
    this.lastRecoveryAt = this.now()
    const operation = Promise.resolve()
      .then(() => this.rebuildConnections())
      .catch((error: unknown) => this.onError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        if (this.recovery === operation) this.recovery = undefined
        if (!this.closed && !this.suspended && this.pendingRecovery) {
          this.pendingRecovery = false
          this.scheduleRecovery()
        }
        this.notifyIdleIfSettled()
      })
    this.recovery = operation
  }

  private isSettled(): boolean {
    return !this.recovery && !this.recoveryTimer && (!this.pendingRecovery || this.closed || this.suspended)
  }

  private notifyIdleIfSettled(): void {
    if (!this.isSettled()) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private safeOnline(): boolean {
    try {
      return this.isOnline()
    } catch {
      return true
    }
  }
}
