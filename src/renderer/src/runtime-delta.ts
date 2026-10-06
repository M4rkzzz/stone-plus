import type { AppRuntimeDelta, AppSnapshot } from '@shared/types'

export function shouldAcceptSnapshotRevision(current: number, next: number | undefined): boolean {
  return next === undefined || current < 0 || next >= current
}

interface RuntimeSnapshotReloadOptions {
  fetchSnapshot(): Promise<AppSnapshot>
  acceptSnapshot(snapshot: AppSnapshot): void
  acceptedRevision(): number
  onError(error: unknown): void
}

/**
 * Collapses focus refreshes and revision-gap recovery into one authoritative
 * snapshot read. Requests arriving while a read is in flight only raise the
 * minimum revision the shared flight must reach; they never start another
 * structured-clone of the full renderer snapshot in parallel.
 */
export class RuntimeSnapshotReloadCoordinator {
  private flight?: Promise<void>
  private minimumRevision = -1
  private disposed = false

  constructor(private readonly options: RuntimeSnapshotReloadOptions) {}

  request(minimumRevision = -1): Promise<void> {
    this.minimumRevision = Math.max(this.minimumRevision, minimumRevision)
    if (this.flight) return this.flight

    const operation = this.reloadUntilCurrent()
    const tracked = operation.finally(() => {
      if (this.flight === tracked) this.flight = undefined
    })
    this.flight = tracked
    return tracked
  }

  /**
   * React StrictMode intentionally tears down and re-runs effects in
   * development. Re-enable the coordinator when the owning effect mounts
   * again; an already pending fetch can then satisfy the new subscription.
   */
  activate(): void {
    this.disposed = false
  }

  dispose(): void {
    this.disposed = true
  }

  private async reloadUntilCurrent(): Promise<void> {
    try {
      while (!this.disposed) {
        const snapshot = await this.options.fetchSnapshot()
        if (this.disposed) return
        this.options.acceptSnapshot(snapshot)
        if (snapshot.runtimeRevision === undefined
          || this.options.acceptedRevision() >= this.minimumRevision) return
      }
    } catch (error) {
      if (!this.disposed) this.options.onError(error)
    }
  }
}

export function applyRuntimeDelta(snapshot: AppSnapshot, delta: AppRuntimeDelta): AppSnapshot {
  let requestLogs = snapshot.requestLogs
  if (delta.requestLogs?.length) {
    const updates = new Map(delta.requestLogs.map((log) => [log.id, log]))
    const existingIds = new Set(snapshot.requestLogs.map((log) => log.id))
    const additions = [...new Map(
      delta.requestLogs
        .filter((log) => !existingIds.has(log.id))
        .map((log) => [log.id, log] as const)
    ).values()].reverse()
    requestLogs = [
      ...additions,
      ...snapshot.requestLogs.map((log) => updates.get(log.id) ?? log)
    ].slice(0, 500)
  }

  let accounts = snapshot.accounts
  if (delta.accounts?.length) {
    const updates = new Map(delta.accounts.map((account) => [account.id, account]))
    accounts = snapshot.accounts.map((account) => updates.get(account.id) ?? account)
  }

  let healthEvents = snapshot.healthEvents
  if (delta.healthEvents?.length) {
    const updates = new Map(delta.healthEvents.map((event) => [event.id, event]))
    const existingIds = new Set(snapshot.healthEvents.map((event) => event.id))
    const additions = delta.healthEvents
      .filter((event) => !existingIds.has(event.id))
      .reverse()
    healthEvents = [
      ...additions,
      ...snapshot.healthEvents.map((event) => updates.get(event.id) ?? event)
    ].slice(0, 2_000)
  }

  return {
    ...snapshot,
    runtimeRevision: delta.revision,
    ...(delta.gatewayStatus ? { gatewayStatus: delta.gatewayStatus } : {}),
    requestLogs,
    accounts,
    healthEvents,
    ...(delta.observability ? { observability: delta.observability } : {})
  }
}
