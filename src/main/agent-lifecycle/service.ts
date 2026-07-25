import { randomUUID } from 'node:crypto'
import {
  AGENT_CAPABILITIES,
  AGENT_TARGETS,
  type AgentLifecycleAction,
  type AgentLifecycleBusyAction,
  type AgentLifecycleChangedEvent,
  type AgentLifecycleError,
  type AgentLifecycleOperationResult,
  type AgentLifecyclePhase,
  type AgentLifecycleSnapshot,
  type AgentLifecycleState,
  type AgentInstallChannel,
  type AgentRestoreOptions,
  type AgentStartOptions,
  type AgentTarget,
  type AgentTargetLifecycleResult,
} from '@shared/agent-lifecycle'
import type { AgentInstallErrorCode, AgentInstallResult } from '../agent-installation'

export interface AgentAdapterSnapshot {
  installed: boolean
  version?: string
  configured: boolean
  running: boolean
  managedInstanceCount: number
  processControl: AgentLifecycleState['processControl']
  pendingNewSession?: boolean
}

export interface AgentAdapterCloseResult {
  wasRunning?: boolean
  pendingNewSession?: boolean
}

export interface AgentAdapterRestoreResult extends AgentAdapterCloseResult {
  changed?: boolean
}

export interface AgentLifecycleAdapterPort {
  readonly target: AgentTarget
  inspect(): Promise<AgentAdapterSnapshot>
  close(): Promise<AgentAdapterCloseResult | void>
  restore(options?: AgentRestoreOptions): Promise<AgentAdapterRestoreResult | void>
  start(options?: AgentStartOptions): Promise<void>
}

export interface AgentRouteState {
  enabled: boolean
  compatibility: AgentLifecycleState['compatibility']
  sourceId?: string
  sourceName?: string
}

export interface AgentLifecycleServiceOptions {
  adapters: Readonly<Record<AgentTarget, AgentLifecycleAdapterPort>>
  installer: AgentInstallationPort
  resolveRoute(target: AgentTarget): AgentRouteState
  now?: () => number
  id?: () => string
  operationTimeoutMs?: number
}

export interface AgentInstallationPort {
  install(target: AgentTarget, channel?: AgentInstallChannel): Promise<AgentInstallResult>
}

interface AggregateExecution {
  target: AgentTarget
  aliases: Array<{ target: AgentTarget; snapshot?: AgentAdapterSnapshot }>
}

interface TargetOperationCompletion {
  before: AgentAdapterSnapshot
  result?: AgentAdapterCloseResult | AgentAdapterRestoreResult | void
  phases: AgentLifecyclePhase[]
  changed: boolean
  expectedRunningAfter?: boolean
}

/**
 * Coordinates product-specific adapters without weakening their safety rules.
 * Operations sharing a state group are serialized; unrelated Agent homes can
 * progress independently during aggregate maintenance.
 */
export class AgentLifecycleService {
  private readonly adapters: Readonly<Record<AgentTarget, AgentLifecycleAdapterPort>>
  private readonly installer: AgentInstallationPort
  private readonly resolveRoute: (target: AgentTarget) => AgentRouteState
  private readonly now: () => number
  private readonly id: () => string
  private readonly operationTimeoutMs: number
  private readonly groupTails = new Map<string, Promise<void>>()
  /** A soft-timed-out physical operation keeps its state group reserved until it really settles. */
  private readonly groupReservations = new Map<string, symbol>()
  private readonly busy = new Map<AgentTarget, AgentLifecycleBusyAction>()
  private readonly errors = new Map<AgentTarget, AgentLifecycleError>()
  private readonly listeners = new Set<(event: AgentLifecycleChangedEvent) => void>()
  private revision = 0
  private closing = false
  private inFlight = new Set<Promise<unknown>>()
  private aggregateRepairInFlight: Promise<AgentLifecycleOperationResult> | undefined

  constructor(options: AgentLifecycleServiceOptions) {
    this.adapters = options.adapters
    this.installer = options.installer
    this.resolveRoute = options.resolveRoute
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? randomUUID
    this.operationTimeoutMs = options.operationTimeoutMs ?? 90_000
  }

  onChange(listener: (event: AgentLifecycleChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getSnapshot(): Promise<AgentLifecycleSnapshot> {
    const entries = await Promise.all(AGENT_TARGETS.map(async (target) => {
      try {
        const [adapter, route] = await Promise.all([
          this.adapters[target].inspect(),
          Promise.resolve(this.resolveRoute(target)),
        ])
        return [target, this.toState(target, adapter, route)] as const
      } catch (cause) {
        const route = safeRoute(() => this.resolveRoute(target))
        const error = lifecycleError(cause, 'inspect')
        this.errors.set(target, error)
        return [target, this.toState(target, {
          installed: false,
          configured: false,
          running: false,
          managedInstanceCount: 0,
          processControl: target === 'codex-desktop' ? 'full' : 'managed-only',
        }, route, error)] as const
      }
    }))
    const agents = Object.fromEntries(entries) as Record<AgentTarget, AgentLifecycleState>
    return {
      revision: this.revision,
      capturedAt: this.now(),
      agents,
      busy: this.busy.size > 0,
    }
  }

  close(target: AgentTarget): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('close', target, 'close', async (adapter) => {
      const before = await adapter.inspect()
      if (!before.running) {
        return { before, phases: ['inspect'], changed: false, expectedRunningAfter: false }
      }
      const result = await adapter.close()
      return { before, result, phases: ['inspect', 'close'], changed: before.running, expectedRunningAfter: false }
    })
  }

  install(target: AgentTarget, channel: AgentInstallChannel = 'recommended'): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('install', target, 'install', async (adapter) => {
      const before = await adapter.inspect()
      const installed = await this.installer.install(target, channel)
      if (installed.status === 'failed') throw installFailure(installed)
      return { before, phases: ['inspect', 'install'], changed: true }
    })
  }

  restore(target: AgentTarget, options?: AgentRestoreOptions): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('restore', target, 'restore', async (adapter) => {
      const before = await adapter.inspect()
      assertRestoreOptions(options)
      const result = await adapter.restore({ preserveRunningState: true, ...options })
      const phases: AgentLifecyclePhase[] = ['inspect', 'close', 'restore-connection']
      if (AGENT_CAPABILITIES[target].canRepairSessions && options?.repairSessions !== false) phases.push('repair-sessions')
      phases.push('validate')
      const shouldRun = options?.ensureRunning === true || (before.running && options?.preserveRunningState !== false)
      if (shouldRun) {
        if (!before.running) await adapter.start()
        phases.push('start')
      }
      return {
        before,
        result,
        phases,
        changed: result?.changed ?? true,
        expectedRunningAfter: shouldRun,
      }
    })
  }

  /**
   * A running Agent restart is a repair transaction, not a bare process
   * bounce. Product adapters own the atomic close -> repair -> validate ->
   * relaunch sequence so they can preserve the exact managed instance,
   * profile, working directory and launch mode. A stopped target remains a
   * plain start operation; there is no previous running instance to restore.
   */
  restart(target: AgentTarget): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('restart', target, 'restart', async (adapter) => {
      const before = await adapter.inspect()
      await this.assertStartable(target, before, true)
      if (!before.running) {
        await adapter.start()
        return { before, phases: ['inspect', 'start'], changed: true, expectedRunningAfter: true }
      }
      const capabilities = AGENT_CAPABILITIES[target]
      const restoreOptions: AgentRestoreOptions = {
        preserveRunningState: true,
        ensureRunning: true,
        repairSessions: capabilities.canRepairSessions,
        // A restart repairs configuration and, where supported, sessions.
        // Workspace-index cleanup is a separate reviewed maintenance flow and
        // must never be claimed as part of this button operation.
        repairWorkspaceIndex: false,
      }
      let result: AgentAdapterRestoreResult | void
      try {
        // restore() already relaunches the exact instances that it closed.
        // Calling start() again here would lose launch metadata or create a
        // duplicate process, particularly for Codex Desktop.
        result = await adapter.restore(restoreOptions)
      } catch (cause) {
        throw withDefaultLifecyclePhase(cause, 'restore-connection')
      }
      return {
        before,
        result,
        phases: repairRestartPhases(target),
        changed: result?.changed ?? true,
        expectedRunningAfter: true,
      }
    })
  }

  start(target: AgentTarget, options?: AgentStartOptions): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('start', target, 'start', async (adapter) => {
      const before = await adapter.inspect()
      await this.assertStartable(target, before, !before.running)
      if (before.running) {
        return { before, phases: ['inspect'], changed: false, expectedRunningAfter: true }
      }
      await adapter.start(options)
      return { before, phases: ['inspect', 'start'], changed: !before.running, expectedRunningAfter: true }
    })
  }

  smartRepair(target?: AgentTarget): Promise<AgentLifecycleOperationResult> {
    return target
      ? this.restore(target, { repairSessions: true, repairWorkspaceIndex: true })
      : this.runRepairAggregate('smart-repair')
  }

  repairAllAffected(): Promise<AgentLifecycleOperationResult> {
    return this.runRepairAggregate('repair-all-affected')
  }

  async closeAllManaged(): Promise<AgentLifecycleOperationResult> {
    return this.runAggregate('close-all-managed', Promise.resolve([...AGENT_TARGETS]), 'close')
  }

  async dispose(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.inFlight])
  }

  private async affectedTargets(): Promise<AgentTarget[]> {
    const snapshot = await this.getSnapshot()
    return AGENT_TARGETS.filter((target) => {
      const state = snapshot.agents[target]
      return state.enabled && (state.configured || state.running)
    })
  }

  private async assertStartable(
    target: AgentTarget,
    snapshot: AgentAdapterSnapshot,
    checkCodexConflict: boolean,
  ): Promise<void> {
    const route = this.resolveRoute(target)
    if (!snapshot.installed) throw taggedError('not-installed', 'Agent is not installed.')
    if (!route.enabled || !snapshot.configured) throw taggedError('not-enabled', 'Agent is not configured for Stone+.')
    if (route.compatibility === 'unsupported') {
      throw taggedError('unsupported-source', 'The selected source is not compatible with this Agent.')
    }
    const conflictingCodexTarget = target === 'codex-cli'
      ? 'codex-desktop'
      : target === 'codex-desktop'
        ? 'codex-cli'
        : undefined
    if (!checkCodexConflict || !conflictingCodexTarget) return
    const conflict = await this.adapters[conflictingCodexTarget].inspect()
    if (!conflict.running) return
    const runningName = conflictingCodexTarget === 'codex-desktop' ? 'Codex Desktop (ChatGPT Desktop)' : 'Codex CLI'
    const requestedName = target === 'codex-desktop' ? 'Codex Desktop (ChatGPT Desktop)' : 'Codex CLI'
    throw taggedError(
      'operation-conflict',
      `${runningName} is already running and using Stone+'s shared Codex state. Close it before starting ${requestedName}.`,
    )
  }

  private runRepairAggregate(action: 'smart-repair' | 'repair-all-affected'): Promise<AgentLifecycleOperationResult> {
    if (this.aggregateRepairInFlight) return this.aggregateRepairInFlight
    if (this.closing) return Promise.reject(taggedError('operation-conflict', 'Stone+ is closing.'))
    const operation = this.runAggregate(action, this.affectedTargets())
    const tracked = operation.finally(() => {
      if (this.aggregateRepairInFlight === tracked) this.aggregateRepairInFlight = undefined
      this.inFlight.delete(tracked)
    })
    this.aggregateRepairInFlight = tracked
    this.inFlight.add(tracked)
    return tracked
  }

  private async runAggregate(
    action: AgentLifecycleAction,
    targetsPromise: Promise<AgentTarget[]>,
    mode: 'restore' | 'close' = 'restore',
  ): Promise<AgentLifecycleOperationResult> {
    const startedAt = this.now()
    const operationId = this.id()
    const targets = await targetsPromise
    if (targets.length === 0) return this.finish(operationId, action, startedAt, [])
    const executions = mode === 'restore'
      ? await this.collapseSharedRestoreTargets(targets)
      : targets.map((target): AggregateExecution => ({ target, aliases: [] }))
    const settledGroups = await Promise.all(executions.map(async ({ target, aliases }) => {
      const result = await this.runTarget(target, mode, mode === 'restore' ? 'smart-repair' : 'close', {
        preserveRunningState: true,
        ensureRunning: true,
        repairSessions: true,
        repairWorkspaceIndex: true,
      })
      return [result, ...aliases.map(({ target: alias, snapshot }): AgentTargetLifecycleResult => ({
        target: alias,
        status: result.status === 'failed' ? 'failed' : 'skipped',
        phases: result.phases,
        wasRunning: snapshot?.running ?? false,
        runningAfter: snapshot?.running ?? false,
        changed: false,
        pendingNewSession: snapshot?.pendingNewSession ?? false,
        ...(result.error ? { error: result.error } : {}),
      }))]
    }))
    const settled = settledGroups.flat().sort((left, right) => AGENT_TARGETS.indexOf(left.target) - AGENT_TARGETS.indexOf(right.target))
    return this.finish(operationId, action, startedAt, settled)
  }

  private async collapseSharedRestoreTargets(targets: AgentTarget[]): Promise<AggregateExecution[]> {
    const grouped = new Map<string, AgentTarget[]>()
    for (const target of targets) {
      const group = AGENT_CAPABILITIES[target].sharedStateGroup ?? target
      grouped.set(group, [...(grouped.get(group) ?? []), target])
    }
    return Promise.all([...grouped.values()].map(async (members) => {
      if (members.length === 1) return { target: members[0], aliases: [] }
      const snapshots = await Promise.all(members.map(async (target) => ({
        target,
        snapshot: await this.adapters[target].inspect().catch(() => undefined),
      })))
      const selected = snapshots.find(({ snapshot }) => snapshot?.installed)?.target ?? members[0]
      return {
        target: selected,
        aliases: snapshots
          .filter(({ target }) => target !== selected)
          .map(({ target, snapshot }) => ({ target, ...(snapshot ? { snapshot } : {}) })),
      }
    }))
  }

  private runSingle(
    action: AgentLifecycleAction,
    target: AgentTarget,
    busyAction: AgentLifecycleBusyAction,
    operation: (adapter: AgentLifecycleAdapterPort) => Promise<TargetOperationCompletion>,
  ): Promise<AgentLifecycleOperationResult> {
    if (this.closing) return Promise.reject(taggedError('operation-conflict', 'Stone+ is closing.'))
    const startedAt = this.now()
    const operationId = this.id()
    const execute = this.runTargetOperation(target, busyAction, operation)
      .then((result) => this.finish(operationId, action, startedAt, [result]))
    this.inFlight.add(execute)
    return execute.finally(() => this.inFlight.delete(execute))
  }

  private runTarget(
    target: AgentTarget,
    mode: 'restore' | 'close',
    busyAction: AgentLifecycleBusyAction,
    options?: AgentRestoreOptions,
  ): Promise<AgentTargetLifecycleResult> {
    return this.runTargetOperation(target, busyAction, async (adapter) => {
      const before = await adapter.inspect()
      if (mode === 'close') {
        if (!before.running) {
          return { before, phases: ['inspect'], changed: false, expectedRunningAfter: false }
        }
        const result = await adapter.close()
        return { before, result, phases: ['inspect', 'close'], changed: before.running, expectedRunningAfter: false }
      }
      assertRestoreOptions(options)
      const result = await adapter.restore(options)
      const phases: AgentLifecyclePhase[] = ['inspect', 'close', 'restore-connection']
      if (AGENT_CAPABILITIES[target].canRepairSessions && options?.repairSessions !== false) phases.push('repair-sessions')
      phases.push('validate')
      const shouldRun = options?.ensureRunning === true || (before.running && options?.preserveRunningState !== false)
      if (shouldRun) {
        if (!before.running) await adapter.start()
        phases.push('start')
      }
      return {
        before,
        result,
        phases,
        changed: result?.changed ?? true,
        expectedRunningAfter: shouldRun,
      }
    })
  }

  private runTargetOperation(
    target: AgentTarget,
    busyAction: AgentLifecycleBusyAction,
    operation: (adapter: AgentLifecycleAdapterPort) => Promise<TargetOperationCompletion>,
  ): Promise<AgentTargetLifecycleResult> {
    if (this.closing) return Promise.reject(taggedError('operation-conflict', 'Stone+ is closing.'))
    const group = AGENT_CAPABILITIES[target].sharedStateGroup ?? target
    if (this.groupReservations.has(group)) {
      return Promise.resolve(activeGroupConflictResult(target, group))
    }
    let reservation: symbol | undefined
    let settleVisible!: (result: AgentTargetLifecycleResult) => void
    let visibleSettled = false
    const visible = new Promise<AgentTargetLifecycleResult>((resolve) => {
      settleVisible = (result) => {
        if (visibleSettled) return
        visibleSettled = true
        resolve(result)
      }
    })
    const locked = this.withGroupLock(target, async () => {
      this.busy.set(target, busyAction)
      this.revision += 1
      await this.broadcastSnapshot()
      let visibleResult: AgentTargetLifecycleResult | undefined
      let timedOut = false
      try {
        // The installer port owns a longer hard timeout and process-tree
        // cleanup. Racing it here would release the shared-state lock while an
        // npm/native installer could still be mutating files.
        const pending = operation(this.adapters[target])
        let completed: Awaited<typeof pending>
        try {
          completed = await (busyAction === 'install'
            ? pending
            : withTimeout(pending, this.operationTimeoutMs, target))
        } catch (cause) {
          if (!isOperationTimeout(cause)) throw cause
          timedOut = true
          reservation = Symbol(group)
          this.groupReservations.set(group, reservation)
          const error = lifecycleError(cause, phaseForBusyAction(busyAction))
          this.errors.set(target, error)
          settleVisible(failedTargetResult(target, error))
          // A soft timeout is only a UI boundary. The adapter may still own
          // files or processes, so retain busy state and the shared-state lock
          // until its physical operation has actually settled.
          try {
            const lateCompletion = await pending
            const lateSnapshot = await this.adapters[target].inspect()
            assertRunningPostcondition(target, lateCompletion, lateSnapshot)
            this.errors.delete(target)
          } catch (pendingCause) {
            this.errors.set(target, lifecycleError(pendingCause, phaseForBusyAction(busyAction)))
          }
          return
        }
        this.errors.delete(target)
        const after = await this.adapters[target].inspect()
        assertRunningPostcondition(target, completed, after)
        visibleResult = {
          target,
          status: completed.changed ? 'succeeded' : 'skipped',
          phases: completed.phases,
          wasRunning: completed.result?.wasRunning ?? completed.before.running,
          runningAfter: after.running,
          changed: completed.changed,
          pendingNewSession: completed.result?.pendingNewSession ?? after.pendingNewSession ?? false,
        }
      } catch (cause) {
        const error = lifecycleError(cause, phaseForBusyAction(busyAction))
        this.errors.set(target, error)
        const after = await this.adapters[target].inspect().catch(() => undefined)
        visibleResult = failedTargetResult(target, error, after)
      } finally {
        const releasedBusy = this.busy.delete(target)
        if (reservation && this.groupReservations.get(group) === reservation) this.groupReservations.delete(group)
        if (releasedBusy) this.revision += 1
        if (!timedOut && visibleResult) settleVisible(visibleResult)
        await this.broadcastSnapshot()
      }
    })
    this.inFlight.add(locked)
    void locked.then(
      () => { this.inFlight.delete(locked) },
      (cause) => {
        this.inFlight.delete(locked)
        if (reservation && this.groupReservations.get(group) === reservation) this.groupReservations.delete(group)
        if (this.busy.delete(target)) this.revision += 1
        const error = lifecycleError(cause, phaseForBusyAction(busyAction))
        this.errors.set(target, error)
        settleVisible(failedTargetResult(target, error))
        void this.broadcastSnapshot().catch(() => undefined)
      },
    )
    return visible
  }

  private async finish(
    operationId: string,
    action: AgentLifecycleAction,
    startedAt: number,
    results: AgentTargetLifecycleResult[],
  ): Promise<AgentLifecycleOperationResult> {
    const successes = results.filter((result) => result.status === 'succeeded').length
    const failures = results.filter((result) => result.status === 'failed').length
    const status = results.length === 0 || results.every((result) => result.status === 'skipped')
      ? 'no-op'
      : failures === 0
        ? 'succeeded'
        : successes > 0
          ? 'partial'
          : 'failed'
    const operation: AgentLifecycleOperationResult = {
      operationId,
      action,
      status,
      startedAt,
      completedAt: this.now(),
      results,
      snapshot: await this.getSnapshot(),
    }
    const event = { snapshot: operation.snapshot, operation }
    for (const listener of this.listeners) listener(event)
    return operation
  }

  private async broadcastSnapshot(): Promise<void> {
    if (this.listeners.size === 0) return
    const event = { snapshot: await this.getSnapshot() }
    for (const listener of this.listeners) listener(event)
  }

  private withGroupLock<T>(target: AgentTarget, operation: () => Promise<T>): Promise<T> {
    const group = AGENT_CAPABILITIES[target].sharedStateGroup ?? target
    const preceding = this.groupTails.get(group) ?? Promise.resolve()
    const result = preceding.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.groupTails.set(group, tail)
    return result.finally(() => {
      if (this.groupTails.get(group) === tail) this.groupTails.delete(group)
    })
  }

  private toState(
    target: AgentTarget,
    adapter: AgentAdapterSnapshot,
    route: AgentRouteState,
    inspectionError?: AgentLifecycleError,
  ): AgentLifecycleState {
    const error = inspectionError ?? this.errors.get(target)
    const busyAction = this.busy.get(target)
    return {
      target,
      capabilities: AGENT_CAPABILITIES[target],
      installed: adapter.installed,
      ...(adapter.version ? { version: adapter.version } : {}),
      enabled: route.enabled,
      configured: adapter.configured,
      ...(route.sourceId ? { sourceId: route.sourceId } : {}),
      ...(route.sourceName ? { sourceName: route.sourceName } : {}),
      compatibility: route.compatibility,
      running: adapter.running,
      managedInstanceCount: adapter.managedInstanceCount,
      processControl: adapter.processControl,
      attention: error ? 'failed' : adapter.pendingNewSession ? 'new-session' : busyAction === 'restore' ? 'repair' : 'normal',
      pendingNewSession: adapter.pendingNewSession ?? false,
      needsRestart: false,
      ...(busyAction ? { busyAction } : {}),
      ...(error ? { error } : {}),
    }
  }
}

function assertRunningPostcondition(
  target: AgentTarget,
  completed: TargetOperationCompletion,
  after: AgentAdapterSnapshot,
): void {
  if (completed.expectedRunningAfter === undefined || after.running === completed.expectedRunningAfter) return
  const expected = completed.expectedRunningAfter ? 'running' : 'stopped'
  throw taggedError(
    completed.expectedRunningAfter ? 'process-start-failed' : 'process-close-failed',
    `${target} lifecycle postcondition failed: the managed process is ${after.running ? 'running' : 'stopped'}, expected ${expected}.`,
    completed.expectedRunningAfter ? 'start' : 'close',
  )
}

function assertRestoreOptions(options?: AgentRestoreOptions): void {
  if (options?.ensureRunning === true && options.preserveRunningState === false) {
    throw taggedError(
      'operation-conflict',
      'ensureRunning cannot be combined with preserveRunningState=false.',
      undefined,
      false,
    )
  }
}

function safeRoute(resolve: () => AgentRouteState): AgentRouteState {
  try { return resolve() } catch { return { enabled: false, compatibility: 'unsupported' } }
}

function activeGroupConflictResult(target: AgentTarget, group: string): AgentTargetLifecycleResult {
  const error: AgentLifecycleError = {
    code: 'operation-conflict',
    message: `A previous ${group} lifecycle operation is still running. This retry was not started.`,
    retryable: false,
  }
  return failedTargetResult(target, error)
}

function failedTargetResult(
  target: AgentTarget,
  error: AgentLifecycleError,
  after?: AgentAdapterSnapshot,
): AgentTargetLifecycleResult {
  return {
    target,
    status: 'failed',
    phases: error.phase ? [error.phase] : [],
    wasRunning: after?.running ?? false,
    runningAfter: after?.running ?? false,
    changed: false,
    pendingNewSession: after?.pendingNewSession ?? false,
    error,
  }
}

function taggedError(
  code: AgentLifecycleError['code'],
  message: string,
  phase?: AgentLifecyclePhase,
  retryable = true,
): Error {
  return Object.assign(new Error(message), { lifecycleCode: code, phase, retryable })
}

function withDefaultLifecyclePhase(cause: unknown, phase: AgentLifecyclePhase): unknown {
  const structured = cause as { lifecycleCode?: unknown; phase?: unknown } | undefined
  if (structured?.lifecycleCode !== undefined || structured?.phase !== undefined) return cause
  return taggedError(mapPhaseCode(phase), cause instanceof Error ? cause.message : String(cause), phase)
}

function repairRestartPhases(target: AgentTarget): AgentLifecyclePhase[] {
  const capabilities = AGENT_CAPABILITIES[target]
  return [
    'inspect',
    'close',
    'restore-connection',
    ...(capabilities.canRepairSessions ? ['repair-sessions' as const] : []),
    'validate',
    'start',
  ]
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, target: AgentTarget): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return Promise.reject(operationTimeoutError(target, milliseconds))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(operationTimeoutError(target, milliseconds)), milliseconds)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function operationTimeoutError(target: AgentTarget, milliseconds: number): Error {
  const seconds = Math.max(0, milliseconds) / 1_000
  return Object.assign(
    taggedError(
      'operation-conflict',
      `${target} lifecycle operation timed out after ${seconds} seconds and is still running in the background.`,
      undefined,
      false,
    ),
    { lifecycleTimeout: true },
  )
}

function isOperationTimeout(cause: unknown): boolean {
  return (cause as { lifecycleTimeout?: boolean } | undefined)?.lifecycleTimeout === true
}

function lifecycleError(cause: unknown, phase?: AgentLifecyclePhase): AgentLifecycleError {
  const value = cause as {
    lifecycleCode?: AgentLifecycleError['code']
    phase?: AgentLifecyclePhase
    retryable?: boolean
  } | undefined
  return {
    code: value?.lifecycleCode ?? mapPhaseCode(value?.phase ?? phase),
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: value?.retryable ?? true,
    ...(value?.phase ?? phase ? { phase: value?.phase ?? phase } : {}),
  }
}

function installFailure(result: AgentInstallResult): Error {
  const error = result.error
  return taggedError(
    mapInstallErrorCode(error?.code),
    error?.message ?? 'Agent installation failed.',
    'install',
    isRetryableInstallError(error?.code),
  )
}

function mapInstallErrorCode(code?: AgentInstallErrorCode): AgentLifecycleError['code'] {
  if (code === 'unsupported-target') return 'unsupported-platform'
  if (code === 'unsupported-channel') return 'unsupported-channel'
  if (code === 'node-not-found' || code === 'npm-not-found') return 'installation-prerequisite-missing'
  if (code === 'install-timeout') return 'installation-timeout'
  if (code === 'open-download-page-failed') return 'download-page-failed'
  return 'installation-failed'
}

function isRetryableInstallError(code?: AgentInstallErrorCode): boolean {
  return code !== 'unsupported-target'
    && code !== 'unsupported-channel'
    && code !== 'node-not-found'
    && code !== 'npm-not-found'
}

function phaseForBusyAction(action: AgentLifecycleBusyAction): AgentLifecyclePhase | undefined {
  if (action === 'close') return 'close'
  if (action === 'install') return 'install'
  if (action === 'start' || action === 'restart') return 'start'
  if (action === 'restore' || action === 'smart-repair') return 'restore-connection'
  return undefined
}

function mapPhaseCode(phase?: AgentLifecyclePhase): AgentLifecycleError['code'] {
  if (phase === 'close') return 'process-close-failed'
  if (phase === 'restore-connection') return 'configuration-failed'
  if (phase === 'repair-sessions') return 'session-repair-failed'
  if (phase === 'repair-workspace-index') return 'workspace-index-repair-failed'
  if (phase === 'validate') return 'validation-failed'
  if (phase === 'start') return 'process-start-failed'
  if (phase === 'rollback') return 'rollback-failed'
  if (phase === 'install') return 'installation-failed'
  return 'unknown'
}
