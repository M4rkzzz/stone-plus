import type { AgentLifecycleSnapshot, AgentTarget } from '@shared/agent-lifecycle'
import type { ClientConfigRepairResult, GatewayApi, Route } from '@shared/types'
import { oneClickAgentRuntimeAction, oneClickRouteNeedsUpdate } from './client-config-workbench'

type ConnectionApi = Pick<GatewayApi, 'getSnapshot' | 'updateRoute' | 'startGateway' | 'previewClientConfig'
  | 'repairClientConfig' | 'rollbackClientConfigRepair' | 'getAgentLifecycleSnapshot' | 'restoreAgent'>

export interface ClientConnectionWorkflowOptions {
  api: ConnectionApi
  previous: Route
  desired: Route
  profileId: string
  targets: readonly AgentTarget[]
  sourceOnly?: boolean
  confirmActivation(targets: readonly AgentTarget[], manual: boolean): boolean | Promise<boolean>
  onLifecycle(snapshot: AgentLifecycleSnapshot): void
}

/** One-click and source selection share ordering and failure handling. The
 * route rollback is compare-and-swap: a later user edit always wins. Running
 * clients own their close/config/validate/start transaction; never pre-write
 * their configuration and then ask that transaction to back up the new file. */
export async function runClientConnectionWorkflow(options: ClientConnectionWorkflowOptions) {
  const { api, previous, desired, profileId } = options
  const client = desired.client
  let needsConfiguration = true
  try {
    const preview = await api.previewClientConfig(client, profileId, desired, options.sourceOnly ? undefined : 'repair')
    needsConfiguration = options.sourceOnly
      ? preview.routeChangesConnection !== false
      : preview.files.some((file) => file.changed)
  } catch (error) {
    // A broken document can be rebuilt by explicit one-click repair. A source
    // switch must not silently turn into a destructive configuration repair.
    if (options.sourceOnly) throw error
  }
  const lifecycle = await api.getAgentLifecycleSnapshot()
  options.onLifecycle(lifecycle)
  const scopedProfile = profileId !== `default-${client}`
  const running = options.targets.filter((target) => lifecycle.agents[target].running)
  const controllable = needsConfiguration && !scopedProfile ? running.filter((target) => (
    lifecycle.agents[target].capabilities.canRestart
    && oneClickAgentRuntimeAction(lifecycle.agents[target]) === 'restart'
  )) : []
  const manual = needsConfiguration && running.some((target) => (
    !controllable.includes(target) || lifecycle.agents[target].pendingNewSession
  ))
  if (needsConfiguration && running.length && !await options.confirmActivation(controllable, manual)) {
    return { cancelled: true, updated: false, restarted: [] as AgentTarget[], pendingNewSession: false }
  }
  let written: Route | undefined
  let directRepair: ClientConfigRepairResult | undefined
  const restarted: AgentTarget[] = []
  const assertCurrentRoute = async (expected: Route) => {
    const current = (await api.getSnapshot()).routes.find((route) => route.id === expected.id)
    if (!current || current.updatedAt !== expected.updatedAt || oneClickRouteNeedsUpdate(current, expected)) {
      throw new Error('The client route changed during activation. Newer settings were preserved.')
    }
  }
  try {
    if (oneClickRouteNeedsUpdate(previous, desired)) {
      const saved = await api.updateRoute(desired, previous)
      written = saved.routes.find((route) => route.id === desired.id)
      if (!written) throw new Error('The saved client route is missing.')
    }
    if (needsConfiguration || !options.sourceOnly) {
      if (!(await api.getSnapshot()).gatewayStatus.running) await api.startGateway()
    }
    if (needsConfiguration) {
      for (const target of controllable) {
        await assertCurrentRoute(written ?? previous)
        // A prior shared-home repair may already have changed runtime state.
        // Restore preserves it; restart() could launch an already stopped CLI.
        const operation = await api.restoreAgent(target, { preserveRunningState: true, ensureRunning: false,
          repairSessions: !options.sourceOnly, repairWorkspaceIndex: false })
        options.onLifecycle(operation.snapshot)
        const failure = operation.results.find((item) => item.target === target)?.error
        if (!['succeeded', 'no-op'].includes(operation.status) || failure) {
          throw new Error(failure?.message ?? `Client activation did not complete: ${target} (${operation.status})`)
        }
        restarted.push(target)
      }
      if (controllable.length === 0) {
        await assertCurrentRoute(written ?? previous)
        directRepair = await api.repairClientConfig(client, profileId)
      }
      await assertCurrentRoute(written ?? previous)
      const verification = await api.previewClientConfig(client, profileId, undefined, options.sourceOnly ? undefined : 'repair')
      if (verification.files.some((file) => file.changed)) {
        throw new Error('Client connection verification failed; inspect the configuration before retrying.')
      }
    }
    return { cancelled: false, updated: Boolean(written) || needsConfiguration, restarted, pendingNewSession: manual }
  } catch (error) {
    const failures: string[] = []
    let restoredRoute = written ? undefined : previous
    if (written) {
      try {
        const restored = await api.updateRoute(previous, written)
        restoredRoute = restored.routes.find((route) => route.id === previous.id)
      }
      catch (rollbackError) { failures.push(`route rollback: ${messageOf(rollbackError)}`) }
    }
    if (directRepair?.changedFiles.length) {
      try {
        if (!restoredRoute) throw new Error('Route rollback did not complete; newer configuration was preserved.')
        await assertCurrentRoute(restoredRoute)
        const groups = [...new Set(directRepair.backups.map((backup) => backup.groupId))]
        if (groups.length !== 1 || !directRepair.postWriteRevisions) throw new Error('Missing safe configuration rollback metadata.')
        await api.rollbackClientConfigRepair(client, profileId, groups[0], directRepair.postWriteRevisions)
      } catch (rollbackError) { failures.push(`configuration rollback: ${messageOf(rollbackError)}`) }
    }
    // Source-only compensation never reverses session history. Re-apply the
    // old connection contract to clients already activated by this operation.
    if (options.sourceOnly && restoredRoute && restarted.length) {
      for (const target of [...restarted].reverse()) {
        try {
          await assertCurrentRoute(restoredRoute)
          const recovery = await api.restoreAgent(target, { preserveRunningState: true, ensureRunning: false,
            repairSessions: false, repairWorkspaceIndex: false })
          options.onLifecycle(recovery.snapshot)
          if (!['succeeded', 'no-op'].includes(recovery.status)) throw new Error(`recovery ${recovery.status}`)
          restarted.splice(restarted.indexOf(target), 1)
        } catch (recoveryError) { failures.push(`${target} recovery: ${messageOf(recoveryError)}`) }
      }
    }
    // Never hide an earlier successful client activation behind a generic
    // failure or blindly overwrite its files from a renderer-side snapshot.
    if (restarted.length) failures.push(`already activated: ${restarted.join(', ')}; connection repair may be required`)
    if (failures.length) throw new Error(`${messageOf(error)}; ${failures.join('; ')}`, { cause: error })
    throw error
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
