import type { AppRuntimeDelta, AppSnapshot } from '@shared/types'

export function shouldAcceptSnapshotRevision(current: number, next: number | undefined): boolean {
  return next === undefined || current < 0 || next >= current
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
