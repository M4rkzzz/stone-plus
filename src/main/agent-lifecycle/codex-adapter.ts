import type { ChatGptDesktopRestartState } from '../../shared/types'
import {
  AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentRestoreOptions,
  type AgentStartOptions,
} from '../../shared/agent-lifecycle'
import type {
  ChatGptDesktopController,
  CodexRepairAndRestartOptions,
} from '../codex/repair-and-restart-service'

export type CodexAgentTarget = 'codex-desktop' | 'codex-cli'

export interface CodexInstallationState {
  installed: boolean
  version?: string
  executablePath?: string
}

export interface CodexDesktopProbeSnapshot extends CodexInstallationState {
  running: boolean
  configured: boolean
}

export interface CodexDesktopProbe {
  inspect(): Promise<CodexDesktopProbeSnapshot>
}

export interface CodexManagedCliInstance {
  id: string
  running: boolean
  configDirectory?: string
  profileId?: string
}

export interface CodexCliRuntimeSnapshot {
  installation: CodexInstallationState
  configured: boolean
  managedInstances: CodexManagedCliInstance[]
  /** Best-effort only. Stone+ never terminates these sessions. */
  externalSessionDetected: boolean
}

export interface CodexCliPort {
  inspect(): Promise<CodexCliRuntimeSnapshot>
  closeManaged(instanceId: string): Promise<void>
  restartManaged(instanceId: string): Promise<void>
  startNew(options?: AgentStartOptions): Promise<void>
  restoreConnection(configDirectories?: readonly string[]): Promise<void>
  validateConnection(configDirectories?: readonly string[]): Promise<void>
  prepareStart(options?: AgentStartOptions): Promise<void>
}

/**
 * Narrow structural view of the existing close/repair/relaunch service. Keeping
 * this port small makes the adapter testable without reimplementing Codex
 * session or workspace-index repair.
 */
export interface CodexDeepRepairPort {
  run(options?: CodexRepairAndRestartOptions, configDirectories?: readonly string[]): Promise<unknown>
}

export interface CodexLifecycleAdapterOptions {
  target: CodexAgentTarget
  desktop: ChatGptDesktopController
  desktopProbe: CodexDesktopProbe
  deepRepair: CodexDeepRepairPort
  cli?: CodexCliPort
  /** Repairs and validates the default desktop CODEX_HOME transactionally. */
  prepareConnection?: () => Promise<void>
}

export interface CodexLifecycleSnapshot {
  target: CodexAgentTarget
  capabilities: AgentCapabilities
  installation: CodexInstallationState
  configured: boolean
  running: boolean
  managedInstanceCount: number
  externalSessionDetected: boolean
  processControl: 'full' | 'managed-only'
  sharedStateGroup: 'codex-home'
}

export interface CodexCloseResult {
  target: CodexAgentTarget
  wasRunning: boolean
  closedManagedInstanceIds: string[]
  externalSessionsUnaffected: boolean
}

export interface CodexRestoreResult extends CodexCloseResult {
  restartedManagedInstanceIds: string[]
  connectionRestored: boolean
  sessionsRepaired: boolean
  workspaceIndexRepaired: boolean
  pendingNewSession: boolean
}

export class CodexLifecycleOperationError extends Error {
  constructor(
    public readonly target: CodexAgentTarget,
    public readonly phase: 'inspect' | 'close' | 'restore-connection' | 'repair-sessions' | 'repair-workspace-index' | 'validate' | 'start',
    message: string,
    public readonly recoveryErrors: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CodexLifecycleOperationError'
  }
}

/**
 * Codex-specific lifecycle adapter. Desktop and CLI adapters intentionally
 * advertise the same state group because both can mutate CODEX_HOME. A caller
 * must serialize adapters by `sharedStateGroup`.
 */
export class CodexLifecycleAdapter {
  readonly target: CodexAgentTarget
  readonly capabilities: AgentCapabilities
  readonly sharedStateGroup = 'codex-home' as const

  private readonly desktop: ChatGptDesktopController
  private readonly desktopProbe: CodexDesktopProbe
  private readonly deepRepair: CodexDeepRepairPort
  private readonly cli?: CodexCliPort
  private readonly prepareConnection?: () => Promise<void>
  private closedDesktopState?: ChatGptDesktopRestartState
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: CodexLifecycleAdapterOptions) {
    if (options.target === 'codex-cli' && !options.cli) {
      throw new Error('Codex CLI lifecycle adapter requires a CLI port.')
    }
    this.target = options.target
    this.capabilities = AGENT_CAPABILITIES[options.target]
    this.desktop = options.desktop
    this.desktopProbe = options.desktopProbe
    this.deepRepair = options.deepRepair
    this.cli = options.cli
    this.prepareConnection = options.prepareConnection
  }

  async getSnapshot(): Promise<CodexLifecycleSnapshot> {
    if (this.target === 'codex-desktop') {
      const desktop = await this.desktopProbe.inspect()
      return {
        target: this.target,
        capabilities: this.capabilities,
        installation: desktop,
        configured: desktop.configured,
        running: desktop.running,
        managedInstanceCount: desktop.running ? 1 : 0,
        externalSessionDetected: false,
        processControl: 'full',
        sharedStateGroup: this.sharedStateGroup,
      }
    }

    const cli = await this.cli!.inspect()
    const running = cli.managedInstances.filter((instance) => instance.running)
    return {
      target: this.target,
      capabilities: this.capabilities,
      installation: cli.installation,
      configured: cli.configured,
      running: running.length > 0 || cli.externalSessionDetected,
      managedInstanceCount: running.length,
      externalSessionDetected: cli.externalSessionDetected,
      processControl: 'managed-only',
      sharedStateGroup: this.sharedStateGroup,
    }
  }

  close(): Promise<CodexCloseResult> {
    return this.serialize(() => this.closeUnlocked())
  }

  restore(options: AgentRestoreOptions = {}): Promise<CodexRestoreResult> {
    return this.serialize(() => this.restoreUnlocked(options))
  }

  start(options?: AgentStartOptions): Promise<void> {
    return this.serialize(() => this.startUnlocked(options))
  }

  private async closeUnlocked(): Promise<CodexCloseResult> {
    if (this.target === 'codex-desktop') {
      const state = await this.desktop.shutdownForRepair()
      this.closedDesktopState = state
      return {
        target: this.target,
        wasRunning: state.wasRunning,
        closedManagedInstanceIds: [],
        externalSessionsUnaffected: false,
      }
    }

    const snapshot = await this.cli!.inspect()
    const runningIds = snapshot.managedInstances
      .filter((instance) => instance.running)
      .map((instance) => instance.id)
    const closed: string[] = []
    try {
      for (const id of runningIds) {
        await this.cli!.closeManaged(id)
        closed.push(id)
      }
    } catch (cause) {
      const recoveryErrors = await this.restartManaged(closed)
      throw new CodexLifecycleOperationError(
        this.target,
        'close',
        `Unable to close managed Codex CLI instances: ${messageOf(cause)}`,
        recoveryErrors,
        { cause },
      )
    }
    return {
      target: this.target,
      wasRunning: runningIds.length > 0 || snapshot.externalSessionDetected,
      closedManagedInstanceIds: closed,
      externalSessionsUnaffected: snapshot.externalSessionDetected,
    }
  }

  private async restoreUnlocked(options: AgentRestoreOptions): Promise<CodexRestoreResult> {
    if (this.target === 'codex-desktop') {
      const before = await this.desktopProbe.inspect()
      const repairSessions = options.repairSessions !== false
      const repairWorkspaceIndex = options.repairWorkspaceIndex !== false
      if (repairSessions || repairWorkspaceIndex) {
        try {
          await this.deepRepair.run({ preserveRunningState: options.preserveRunningState !== false })
        } catch (cause) {
          throw new CodexLifecycleOperationError(
            this.target,
            repairSessions ? 'repair-sessions' : 'repair-workspace-index',
            `Unable to repair Codex desktop state: ${messageOf(cause)}`,
            [],
            { cause },
          )
        }
      }
      return {
        target: this.target,
        wasRunning: before.running,
        closedManagedInstanceIds: [],
        externalSessionsUnaffected: false,
        restartedManagedInstanceIds: [],
        connectionRestored: true,
        sessionsRepaired: repairSessions,
        // Ghost-index cleanup requires an explicit reviewed candidate list and
        // remains a separate operation on CodexRepairAndRestartService.
        workspaceIndexRepaired: false,
        pendingNewSession: false,
      }
    }

    const cli = this.cli!
    const before = await cli.inspect()
    const runningIds = before.managedInstances.filter((instance) => instance.running).map((instance) => instance.id)
    // Every managed definition owns its own CODEX_HOME, even while stopped.
    // A repair-all operation must not silently repair only ~/.codex and leave
    // a stopped custom profile stale for its next launch.
    const configDirectories = uniqueConfigDirectories(before.managedInstances)
    const closed: string[] = []
    let connectionRestored = false
    try {
      for (const id of runningIds) {
        await cli.closeManaged(id)
        closed.push(id)
      }
      await cli.restoreConnection(configDirectories)
      connectionRestored = true
      const repairSessions = options.repairSessions === true
      const repairWorkspaceIndex = options.repairWorkspaceIndex === true
      if (repairSessions || repairWorkspaceIndex) {
        try {
          await this.deepRepair.run({ preserveRunningState: true }, configDirectories)
        } catch (cause) {
          throw new CodexLifecycleOperationError(
            this.target,
            repairSessions ? 'repair-sessions' : 'repair-workspace-index',
            `Unable to repair Codex CLI state: ${messageOf(cause)}`,
            [],
            { cause },
          )
        }
      }
      await cli.validateConnection(configDirectories)
      const restartErrors = options.preserveRunningState === false ? [] : await this.restartManaged(runningIds)
      if (restartErrors.length > 0) {
        throw new CodexLifecycleOperationError(
          this.target,
          'start',
          'The Codex CLI connection was restored, but its previous managed instances could not all restart.',
          restartErrors,
        )
      }
      return {
        target: this.target,
        wasRunning: runningIds.length > 0 || before.externalSessionDetected,
        closedManagedInstanceIds: closed,
        externalSessionsUnaffected: before.externalSessionDetected,
        restartedManagedInstanceIds: options.preserveRunningState === false ? [] : [...runningIds],
        connectionRestored,
        sessionsRepaired: repairSessions,
        workspaceIndexRepaired: repairWorkspaceIndex,
        pendingNewSession: before.externalSessionDetected,
      }
    } catch (cause) {
      if (cause instanceof CodexLifecycleOperationError) {
        if (cause.phase === 'start') throw cause
        const recoveryErrors = options.preserveRunningState === false ? [] : await this.restartManaged(closed)
        throw new CodexLifecycleOperationError(
          this.target,
          cause.phase,
          cause.message,
          [...cause.recoveryErrors, ...recoveryErrors],
          { cause },
        )
      }
      const recoveryErrors = options.preserveRunningState === false ? [] : await this.restartManaged(closed)
      const phase = closed.length < runningIds.length ? 'close' : connectionRestored ? 'validate' : 'restore-connection'
      throw new CodexLifecycleOperationError(
        this.target,
        phase,
        `Unable to restore Codex CLI: ${messageOf(cause)}`,
        recoveryErrors,
        { cause },
      )
    }
  }

  private async startUnlocked(options?: AgentStartOptions): Promise<void> {
    if (this.target === 'codex-cli') {
      const snapshot = await this.cli!.inspect()
      if (!snapshot.installation.installed) throw new Error('Codex CLI is not installed.')
      await this.cli!.prepareStart(options)
      await this.cli!.startNew(options)
      return
    }

    const snapshot = await this.desktopProbe.inspect()
    if (!snapshot.installed) throw new Error('Codex desktop is not installed.')
    // Capture/stop first when already running so a repaired config is never
    // reported as active while the old desktop process still owns its stale
    // environment and cached connection state.
    const state = this.closedDesktopState ?? await this.desktop.shutdownForRepair()
    this.closedDesktopState = state
    try {
      await this.prepareConnection?.()
    } catch (cause) {
      const recoveryErrors: string[] = []
      // Transactional connection preparation restores the previous files on
      // validation failure. If this call interrupted an already-running
      // desktop, restore that captured process state instead of stranding the
      // user with a stopped client.
      if (state.wasRunning) {
        try {
          await this.desktop.relaunch(state)
          this.closedDesktopState = undefined
        } catch (relaunchCause) {
          recoveryErrors.push(`desktop relaunch: ${messageOf(relaunchCause)}`)
        }
      }
      throw new CodexLifecycleOperationError(
        this.target,
        'restore-connection',
        `Unable to prepare the Codex desktop connection: ${messageOf(cause)}`,
        recoveryErrors,
        { cause },
      )
    }
    try {
      await this.desktop.relaunch(state)
      this.closedDesktopState = undefined
    } catch (cause) {
      throw new CodexLifecycleOperationError(
        this.target,
        'start',
        `Unable to start Codex desktop: ${messageOf(cause)}`,
        [],
        { cause },
      )
    }
  }

  private async restartManaged(ids: readonly string[]): Promise<string[]> {
    const errors: string[] = []
    for (const id of ids) {
      try {
        await this.cli!.restartManaged(id)
      } catch (cause) {
        errors.push(`${id}: ${messageOf(cause)}`)
      }
    }
    if (ids.length === 0) return errors
    try {
      const after = await this.cli!.inspect()
      const running = new Set(after.managedInstances.filter((instance) => instance.running).map((instance) => instance.id))
      for (const id of ids) {
        if (!running.has(id) && !errors.some((entry) => entry.startsWith(`${id}:`))) {
          errors.push(`${id}: managed instance did not report running after restart`)
        }
      }
    } catch (cause) {
      errors.push(`restart verification: ${messageOf(cause)}`)
    }
    return errors
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function uniqueConfigDirectories(instances: readonly CodexManagedCliInstance[]): string[] {
  return [...new Set(instances.map((instance) => instance.configDirectory).filter((value): value is string => Boolean(value)))]
}
