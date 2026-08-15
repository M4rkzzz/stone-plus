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
  type AgentLifecycleProgressEvent,
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
  restore(options?: AgentRestoreOptions, execution?: AgentLifecycleExecutionOptions): Promise<AgentAdapterRestoreResult | void>
  start(options?: AgentStartOptions): Promise<void>
}

/** Runtime-only control plane for one renderer-owned lifecycle operation. */
export interface AgentLifecycleExecutionOptions {
  signal?: AbortSignal
  onProgress?: (progress: Omit<AgentLifecycleProgressEvent, 'operationId'>) => void
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
  /** Longer soft boundary for Codex operations that include full session repair. */
  codexRepairTimeoutMs?: number
  /** Bounds expensive renderer polling while lifecycle operations still force fresh snapshots. */
  snapshotCacheTtlMs?: number
}

export interface AgentInstallationPort {
  install(target: AgentTarget, channel?: AgentInstallChannel): Promise<AgentInstallResult>
}

interface AggregateExecution {
  target: AgentTarget
  snapshot?: AgentAdapterSnapshot
  aliases: Array<{ target: AgentTarget; snapshot?: AgentAdapterSnapshot }>
  conflict?: AgentLifecycleError
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
  private readonly codexRepairTimeoutMs: number
  private readonly snapshotCacheTtlMs: number
  private readonly groupTails = new Map<string, Promise<void>>()
  /** A soft-timed-out physical operation keeps its state group reserved until it really settles. */
  private readonly groupReservations = new Map<string, symbol>()
  private readonly busy = new Map<AgentTarget, AgentLifecycleBusyAction>()
  private readonly errors = new Map<AgentTarget, AgentLifecycleError>()
  private readonly inspectionErrors = new Map<AgentTarget, AgentLifecycleError>()
  private readonly listeners = new Set<(event: AgentLifecycleChangedEvent) => void>()
  private revision = 0
  private closing = false
  private inFlight = new Set<Promise<unknown>>()
  private aggregateRepairInFlight: Promise<AgentLifecycleOperationResult> | undefined
  private snapshotCache: { expiresAt: number; snapshot: AgentLifecycleSnapshot } | undefined
  private snapshotFlight: Promise<AgentLifecycleSnapshot> | undefined
  private snapshotFlightRevision: number | undefined

  constructor(options: AgentLifecycleServiceOptions) {
    this.adapters = options.adapters
    this.installer = options.installer
    this.resolveRoute = options.resolveRoute
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? randomUUID
    this.operationTimeoutMs = options.operationTimeoutMs ?? 90_000
    this.codexRepairTimeoutMs = options.codexRepairTimeoutMs
      ?? options.operationTimeoutMs
      ?? 10 * 60_000
    this.snapshotCacheTtlMs = Math.max(0, Math.min(30_000, options.snapshotCacheTtlMs ?? 4_000))
  }

  onChange(listener: (event: AgentLifecycleChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): Promise<AgentLifecycleSnapshot> {
    return this.loadSnapshot(false)
  }

  private loadSnapshot(forceFresh: boolean): Promise<AgentLifecycleSnapshot> {
    if (!forceFresh && this.snapshotCache && this.now() < this.snapshotCache.expiresAt) {
      return Promise.resolve(this.snapshotCache.snapshot)
    }
    if (this.snapshotFlight) {
      if (!forceFresh || this.snapshotFlightRevision === this.revision) return this.snapshotFlight
      // A lifecycle transition invalidated the state while an older renderer
      // poll was still probing. Wait for that probe to settle, then coalesce a
      // fresh collection at the new revision instead of publishing stale busy
      // or error state.
      return this.snapshotFlight.then(() => this.loadSnapshot(true))
    }
    const flightRevision = this.revision
    const flight = this.collectSnapshot().then((snapshot) => {
      this.snapshotCache = { expiresAt: this.now() + this.snapshotCacheTtlMs, snapshot }
      return snapshot
    }).finally(() => {
      if (this.snapshotFlight === flight) {
        this.snapshotFlight = undefined
        this.snapshotFlightRevision = undefined
      }
    })
    this.snapshotFlight = flight
    this.snapshotFlightRevision = flightRevision
    return flight
  }

  private async collectSnapshot(): Promise<AgentLifecycleSnapshot> {
    const entries = await Promise.all(AGENT_TARGETS.map(async (target) => {
      try {
        const [adapter, route] = await Promise.all([
          this.adapters[target].inspect(),
          Promise.resolve(this.resolveRoute(target)),
        ])
        this.inspectionErrors.delete(target)
        return [target, this.toState(target, adapter, route)] as const
      } catch (cause) {
        const route = safeRoute(() => this.resolveRoute(target))
        const error = lifecycleError(cause, 'inspect')
        this.inspectionErrors.set(target, error)
        return [target, this.toState(target, {
          installed: false,
          configured: false,
          running: false,
          managedInstanceCount: 0,
          processControl: AGENT_CAPABILITIES[target].canCloseKnownProcess
            ? target === 'codex-desktop' ? 'full' : 'managed-only'
            : 'unavailable',
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

  private invalidateSnapshotCache(): void {
    this.snapshotCache = undefined
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
      if (target === 'deepseek-harness' && installed.status === 'installed') {
        const afterInstall = await adapter.inspect()
        await this.assertStartable(target, afterInstall, false)
        try {
          // The DSH adapter transactionally repairs and validates ~/.dsh/.env
          // before launching the managed local workbench.
          await adapter.start()
        } catch (cause) {
          throw withDefaultLifecyclePhase(cause, 'start')
        }
        return {
          before,
          phases: ['inspect', 'install', 'restore-connection', 'validate', 'start'],
          changed: true,
          expectedRunningAfter: true,
        }
      }
      return { before, phases: ['inspect', 'install'], changed: true }
    })
  }

  restore(
    target: AgentTarget,
    options?: AgentRestoreOptions,
    execution: AgentLifecycleExecutionOptions = {},
  ): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('restore', target, 'restore', async (adapter) => {
      throwIfLifecycleCancelled(execution.signal)
      const before = await adapter.inspect()
      assertRestoreOptions(options)
      const restoreOptions = { preserveRunningState: true, ...options }
      const result = hasLifecycleExecution(execution)
        ? await adapter.restore(restoreOptions, execution)
        : await adapter.restore(restoreOptions)
      const phases: AgentLifecyclePhase[] = ['inspect', 'close', 'restore-connection']
      if (target === 'codex-desktop' || target === 'codex-cli') phases.push('repair-residue')
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
  restart(target: AgentTarget, execution: AgentLifecycleExecutionOptions = {}): Promise<AgentLifecycleOperationResult> {
    return this.runSingle('restart', target, 'restart', async (adapter) => {
      throwIfLifecycleCancelled(execution.signal)
      const before = await adapter.inspect()
      if (!AGENT_CAPABILITIES[target].canRestart) {
        throw taggedError('process-start-failed', `${target} cannot be restarted safely; open it instead.`, 'start')
      }
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
        result = hasLifecycleExecution(execution)
          ? await adapter.restore(restoreOptions, execution)
          : await adapter.restore(restoreOptions)
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
      const capabilities = AGENT_CAPABILITIES[target]
      const detectsRunning = capabilities.canDetectRunning
      if (detectsRunning && before.running && before.configured && !capabilities.canOpenWhenRunning) {
        return { before, phases: ['inspect'], changed: false, expectedRunningAfter: true }
      }
      await adapter.start(options)
      return {
        before,
        phases: ['inspect', 'start'],
        changed: true,
        ...(detectsRunning ? { expectedRunningAfter: true } : {}),
      }
    })
  }

  smartRepair(target?: AgentTarget, execution: AgentLifecycleExecutionOptions = {}): Promise<AgentLifecycleOperationResult> {
    return target
      ? this.restore(target, { repairSessions: true, repairWorkspaceIndex: true }, execution)
      : this.runRepairAggregate('smart-repair', execution)
  }

  repairAllAffected(execution: AgentLifecycleExecutionOptions = {}): Promise<AgentLifecycleOperationResult> {
    return this.runRepairAggregate('repair-all-affected', execution)
  }

  async closeAllManaged(): Promise<AgentLifecycleOperationResult> {
    return this.runAggregate('close-all-managed', Promise.resolve([...AGENT_TARGETS]), 'close')
  }

  async dispose(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.inFlight])
  }

  private async affectedTargets(): Promise<AgentTarget[]> {
    const snapshot = await this.loadSnapshot(true)
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
    const capabilities = AGENT_CAPABILITIES[target]
    const route = this.resolveRoute(target)
    if (!snapshot.installed) throw taggedError('not-installed', 'Agent is not installed.')
    if (!(capabilities.canLaunch ?? capabilities.canRestart)) {
      throw taggedError('process-start-failed', 'This Agent cannot be opened by Stone+.', 'start')
    }
    // Launch-only surfaces repair their surface-specific settings as part of
    // opening, or deliberately hand off a documented manual setup flow. They
    // cannot claim a reliable running state before that handoff completes.
    if (!route.enabled) {
      throw taggedError('not-enabled', 'Agent is not configured for Stone+.')
    }
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

  private runRepairAggregate(
    action: 'smart-repair' | 'repair-all-affected',
    execution: AgentLifecycleExecutionOptions,
  ): Promise<AgentLifecycleOperationResult> {
    if (this.aggregateRepairInFlight) return this.aggregateRepairInFlight
    if (this.closing) return Promise.reject(taggedError('operation-conflict', 'Stone+ is closing.'))
    const operation = this.runAggregate(action, this.affectedTargets(), 'restore', execution)
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
    execution: AgentLifecycleExecutionOptions = {},
  ): Promise<AgentLifecycleOperationResult> {
    const startedAt = this.now()
    const operationId = this.id()
    const targets = await targetsPromise
    if (targets.length === 0) return this.finish(operationId, action, startedAt, [])
    const executions = mode === 'restore'
      ? await this.collapseSharedRestoreTargets(targets)
      : targets.map((target): AggregateExecution => ({ target, aliases: [] }))
    const settledGroups = await Promise.all(executions.map(async ({ target, snapshot, aliases, conflict }) => {
      if (conflict) {
        return [
          failedTargetResult(target, conflict, snapshot),
          ...aliases.map(({ target: alias, snapshot: aliasSnapshot }) => (
            failedTargetResult(alias, conflict, aliasSnapshot)
          )),
        ]
      }
      const result = await this.runTarget(target, mode, mode === 'restore' ? 'smart-repair' : 'close', {
        preserveRunningState: true,
        // Launch-only surfaces (Claude Desktop Code and VS Code) cannot
        // report a reliable running state. Aggregate repair must configure
        // them without opening a host application and then failing an
        // impossible running-state postcondition.
        ensureRunning: AGENT_CAPABILITIES[target].canDetectRunning,
        repairSessions: true,
        repairWorkspaceIndex: true,
      }, execution)
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
      // A shared-state lock prevents concurrent writes. Aggregate aliasing is
      // a separate promise: it is safe for Codex Desktop/CLI today, but not for
      // Claude CLI, Desktop and VS Code because each surface has distinct
      // relaunch and configuration work.
      const group = AGENT_CAPABILITIES[target].aggregateRestoreGroup ?? target
      grouped.set(group, [...(grouped.get(group) ?? []), target])
    }
    return Promise.all([...grouped.values()].map(async (members) => {
      if (members.length === 1) return { target: members[0], aliases: [] }
      const snapshots = await Promise.all(members.map(async (target) => ({
        target,
        snapshot: await this.adapters[target].inspect().catch(() => undefined),
      })))
      const running = snapshots.filter(({ snapshot }) => snapshot?.running)
      const selectedEntry = running.length === 1
        ? running[0]
        : snapshots.find(({ snapshot }) => snapshot?.installed) ?? snapshots[0]
      const selected = selectedEntry.target
      const conflict = running.length > 1
        ? lifecycleError(
            taggedError(
              'operation-conflict',
              `Multiple ${AGENT_CAPABILITIES[selected].aggregateRestoreGroup ?? 'shared-state'} clients are running. Close all but one before repair.`,
              undefined,
              false,
            ),
          )
        : undefined
      return {
        target: selected,
        ...(selectedEntry.snapshot ? { snapshot: selectedEntry.snapshot } : {}),
        ...(conflict ? { conflict } : {}),
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
    execution: AgentLifecycleExecutionOptions = {},
  ): Promise<AgentTargetLifecycleResult> {
    return this.runTargetOperation(target, busyAction, async (adapter) => {
      throwIfLifecycleCancelled(execution.signal)
      const before = await adapter.inspect()
      if (mode === 'close') {
        if (!before.running) {
          return { before, phases: ['inspect'], changed: false, expectedRunningAfter: false }
        }
        const result = await adapter.close()
        return { before, result, phases: ['inspect', 'close'], changed: before.running, expectedRunningAfter: false }
      }
      assertRestoreOptions(options)
      const result = hasLifecycleExecution(execution)
        ? await adapter.restore(options, execution)
        : await adapter.restore(options)
      const phases: AgentLifecyclePhase[] = ['inspect', 'close', 'restore-connection']
      if (target === 'codex-desktop' || target === 'codex-cli') phases.push('repair-residue')
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
          const timeoutMs = isCodexSessionRepairOperation(target, busyAction)
            ? this.codexRepairTimeoutMs
            : this.operationTimeoutMs
          completed = await (busyAction === 'install'
            ? pending
            : withTimeout(pending, timeoutMs, target))
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
        if (error.code === 'cancelled') this.errors.delete(target)
        else this.errors.set(target, error)
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
      snapshot: await this.loadSnapshot(true),
    }
    const event = { snapshot: operation.snapshot, operation }
    for (const listener of this.listeners) listener(event)
    return operation
  }

  private async broadcastSnapshot(): Promise<void> {
    this.invalidateSnapshotCache()
    if (this.listeners.size === 0) return
    const event = { snapshot: await this.loadSnapshot(true) }
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
    const error = inspectionError ?? this.errors.get(target) ?? this.inspectionErrors.get(target)
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
    ...(target === 'codex-desktop' || target === 'codex-cli' ? ['repair-residue' as const] : []),
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
  const cancelled = isAbortCause(cause)
  return {
    code: cancelled ? 'cancelled' : value?.lifecycleCode ?? mapPhaseCode(value?.phase ?? phase),
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: value?.retryable ?? true,
    ...(value?.phase ?? phase ? { phase: value?.phase ?? phase } : {}),
  }
}

function throwIfLifecycleCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('操作已安全取消。')
  error.name = 'AbortError'
  throw error
}

function hasLifecycleExecution(execution: AgentLifecycleExecutionOptions): boolean {
  return Boolean(execution.signal || execution.onProgress)
}

function isAbortCause(cause: unknown, depth = 0): boolean {
  if (!cause || depth > 4) return false
  const value = cause as { name?: unknown; code?: unknown; cause?: unknown }
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') return true
  return value.cause !== undefined && isAbortCause(value.cause, depth + 1)
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

function isCodexSessionRepairOperation(target: AgentTarget, action: AgentLifecycleBusyAction): boolean {
  return (target === 'codex-desktop' || target === 'codex-cli')
    && (action === 'restore' || action === 'restart' || action === 'smart-repair')
}

function mapPhaseCode(phase?: AgentLifecyclePhase): AgentLifecycleError['code'] {
  if (phase === 'close') return 'process-close-failed'
  if (phase === 'restore-connection') return 'configuration-failed'
  if (phase === 'repair-residue') return 'residue-repair-failed'
  if (phase === 'repair-sessions') return 'session-repair-failed'
  if (phase === 'repair-workspace-index') return 'workspace-index-repair-failed'
  if (phase === 'validate') return 'validation-failed'
  if (phase === 'start') return 'process-start-failed'
  if (phase === 'rollback') return 'rollback-failed'
  if (phase === 'install') return 'installation-failed'
  return 'unknown'
}
