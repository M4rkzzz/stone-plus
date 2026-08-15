import type {
  ApplyClientConfigResult,
  ClientConfigApplyOptions,
  ClientConnectionTarget,
  RepairClientConfigResult,
  SupportedClient,
} from '../client-config/types'
import { AGENT_CAPABILITIES } from '../../shared/agent-lifecycle'
import type { AgentCapabilities, AgentLifecyclePhase, AgentStartOptions } from '../../shared/agent-lifecycle'

export type ConnectionOnlyAgentTarget = 'claude-code' | 'gemini-cli' | 'grok-build' | 'deepseek-harness'

export interface CliInstallationState {
  installed: boolean
  executablePath?: string
  version?: string
}

export interface ManagedCliInstanceState {
  id: string
  running: boolean
  configDirectory?: string
  profileId?: string
  lastStartedAt?: number
}

export interface CliRuntimeSnapshot {
  managedInstances: ManagedCliInstanceState[]
  /** Best-effort signal only. External processes are never terminated. */
  externalSessionDetected: boolean
}

export interface CliRuntimePort {
  snapshot(client: SupportedClient): Promise<CliRuntimeSnapshot>
  closeManaged(instanceId: string): Promise<void>
  startManaged(instanceId: string): Promise<void>
  startNew(client: SupportedClient, options?: CliStartOptions): Promise<void>
}

export interface CliInstallationPort {
  inspect(target: ConnectionOnlyAgentTarget): Promise<CliInstallationState>
}

/**
 * Configuration writes stay behind this port so the lifecycle layer never
 * parses, rewrites, or receives credential-bearing document contents.
 * Implementations must use coherent backups and atomic replacement.
 */
export interface CliConnectionConfigPort {
  inspect(client: SupportedClient, configDirectory?: string): Promise<{ configured: boolean }>
  repair(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options?: ScopedClientConfigApplyOptions,
  ): Promise<RepairClientConfigResult>
  validate(client: SupportedClient, target: ClientConnectionTarget, configDirectory?: string): Promise<void>
  rollback(client: SupportedClient, repair: RepairClientConfigResult): Promise<ApplyClientConfigResult | void>
}

export interface ScopedClientConfigApplyOptions extends ClientConfigApplyOptions {
  configDirectory?: string
}

export type CliStartOptions = AgentStartOptions

export interface ConnectionOnlyAgentSnapshot {
  target: ConnectionOnlyAgentTarget
  client: 'claude' | 'gemini' | 'grokbuild' | 'deepseek-harness'
  capabilities: AgentCapabilities
  installation: CliInstallationState
  configured: boolean
  running: boolean
  managedInstanceCount: number
  externalSessionDetected: boolean
  processControl: 'managed-only'
}

export interface CliCloseResult {
  target: ConnectionOnlyAgentTarget
  closedManagedInstanceIds: string[]
  externalSessionsUnaffected: boolean
}

export interface CliRestoreResult extends CliCloseResult {
  repair: RepairClientConfigResult
  restartedManagedInstanceIds: string[]
  pendingNewSession: boolean
}

export class CliLifecycleOperationError extends Error {
  constructor(
    public readonly target: ConnectionOnlyAgentTarget,
    public readonly phase: Extract<AgentLifecyclePhase, 'close' | 'restore-connection' | 'validate' | 'rollback' | 'start'>,
    message: string,
    public readonly recoveryErrors: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CliLifecycleOperationError'
  }
}

export interface ConnectionOnlyCliAdapterOptions {
  target: ConnectionOnlyAgentTarget
  installation: CliInstallationPort
  runtime: CliRuntimePort
  config: CliConnectionConfigPort
}

/**
 * Lifecycle adapter for CLI agents whose recoverable Stone+ state is limited
 * to connection configuration. It deliberately never claims session repair
 * and never terminates processes that Stone+ did not launch and register.
 */
export class ConnectionOnlyCliLifecycleAdapter {
  readonly target: ConnectionOnlyAgentTarget
  readonly client: 'claude' | 'gemini' | 'grokbuild' | 'deepseek-harness'
  readonly capabilities: AgentCapabilities

  private readonly installation: CliInstallationPort
  private readonly runtime: CliRuntimePort
  private readonly config: CliConnectionConfigPort
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: ConnectionOnlyCliAdapterOptions) {
    this.target = options.target
    this.client = options.target === 'claude-code'
      ? 'claude'
      : options.target === 'gemini-cli'
        ? 'gemini'
        : options.target === 'grok-build'
          ? 'grokbuild'
          : 'deepseek-harness'
    this.capabilities = AGENT_CAPABILITIES[options.target]
    this.installation = options.installation
    this.runtime = options.runtime
    this.config = options.config
  }

  async getSnapshot(): Promise<ConnectionOnlyAgentSnapshot> {
    const [installation, runtime, config] = await Promise.all([
      this.installation.inspect(this.target),
      this.runtime.snapshot(this.client),
      this.config.inspect(this.client),
    ])
    const runningInstances = runtime.managedInstances.filter((instance) => instance.running)
    return {
      target: this.target,
      client: this.client,
      capabilities: this.capabilities,
      installation,
      configured: config.configured,
      running: runningInstances.length > 0 || runtime.externalSessionDetected,
      managedInstanceCount: runningInstances.length,
      externalSessionDetected: runtime.externalSessionDetected,
      processControl: 'managed-only',
    }
  }

  async isConfiguredFor(connection: ClientConnectionTarget): Promise<boolean> {
    try {
      await this.config.validate(this.client, connection)
      return true
    } catch {
      return false
    }
  }

  close(): Promise<CliCloseResult> {
    return this.serialize(() => this.closeUnlocked())
  }

  restore(
    connection: ClientConnectionTarget,
    options: ClientConfigApplyOptions = {},
    preserveRunningState = true,
  ): Promise<CliRestoreResult> {
    return this.serialize(() => this.restoreUnlocked(connection, options, preserveRunningState))
  }

  start(options?: CliStartOptions, connection?: ClientConnectionTarget): Promise<void> {
    return this.serialize(async () => {
      const [installation, config, runtime] = await Promise.all([
        this.installation.inspect(this.target),
        this.config.inspect(this.client),
        this.runtime.snapshot(this.client),
      ])
      if (!installation.installed) throw new Error(`${displayName(this.target)} is not installed.`)
      if (connection) {
        const selected = runtime.managedInstances
          .filter((instance) => !options?.profileId || instance.profileId === options.profileId)
          .sort((left, right) => (right.lastStartedAt ?? 0) - (left.lastStartedAt ?? 0))
          .at(0)
        const configDirectory = selected?.configDirectory
        const repairs: RepairClientConfigResult[] = []
        let phase: 'restore-connection' | 'validate' = 'restore-connection'
        try {
          repairs.push(await this.config.repair(
            this.client,
            connection,
            configDirectory ? { configDirectory } : {},
          ))
          phase = 'validate'
          await this.config.validate(this.client, connection, configDirectory)
        } catch (error) {
          const rollbackErrors = await this.rollbackRepairs(repairs)
          throw new CliLifecycleOperationError(
            this.target,
            rollbackErrors.length > 0 ? 'rollback' : phase,
            `Unable to prepare the ${displayName(this.target)} connection before start: ${messageOf(error)}`,
            rollbackErrors,
            { cause: error },
          )
        }
      } else if (!config.configured) {
        throw new Error(`${displayName(this.target)} is not configured for Stone+.`)
      }
      await this.runtime.startNew(this.client, options)
    })
  }

  private async closeUnlocked(): Promise<CliCloseResult> {
    const runtime = await this.runtime.snapshot(this.client)
    const runningIds = runtime.managedInstances
      .filter((instance) => instance.running)
      .map((instance) => instance.id)
    const closed: string[] = []
    for (const id of runningIds) {
      try {
        await this.runtime.closeManaged(id)
        closed.push(id)
      } catch (error) {
        throw new CliLifecycleOperationError(
          this.target,
          'close',
          `Unable to close the managed ${displayName(this.target)} instance ${id}: ${messageOf(error)}`,
          [],
          { cause: error },
        )
      }
    }
    return {
      target: this.target,
      closedManagedInstanceIds: closed,
      externalSessionsUnaffected: runtime.externalSessionDetected,
    }
  }

  private async restoreUnlocked(
    connection: ClientConnectionTarget,
    options: ClientConfigApplyOptions,
    preserveRunningState: boolean,
  ): Promise<CliRestoreResult> {
    const before = await this.runtime.snapshot(this.client)
    const runningIds = before.managedInstances
      .filter((instance) => instance.running)
      .map((instance) => instance.id)
    const closed: string[] = []

    try {
      for (const id of runningIds) {
        await this.runtime.closeManaged(id)
        closed.push(id)
      }
    } catch (error) {
      const recoveryErrors = await this.restartManaged(closed)
      throw new CliLifecycleOperationError(
        this.target,
        'close',
        `Unable to close managed ${displayName(this.target)} instances: ${messageOf(error)}`,
        recoveryErrors,
        { cause: error },
      )
    }

    const configDirectories = uniqueConfigDirectories(before.managedInstances.filter((instance) => instance.running))
    const scopes = configDirectories.length > 0 ? configDirectories : [undefined]
    const repairs: RepairClientConfigResult[] = []
    let repairPhase: 'restore-connection' | 'validate' = 'restore-connection'
    try {
      for (const configDirectory of scopes) {
        repairs.push(await this.config.repair(
          this.client,
          connection,
          configDirectory ? { ...options, configDirectory } : options,
        ))
      }
      repairPhase = 'validate'
      for (const configDirectory of scopes) {
        if (configDirectory) await this.config.validate(this.client, connection, configDirectory)
        else await this.config.validate(this.client, connection)
      }
    } catch (error) {
      const rollbackErrors = await this.rollbackRepairs(repairs)
      const recoveryErrors = await this.restartManaged(closed)
      throw new CliLifecycleOperationError(
        this.target,
        rollbackErrors.length > 0 ? 'rollback' : repairPhase,
        `Unable to restore the ${displayName(this.target)} connection: ${messageOf(error)}`,
        [...rollbackErrors, ...recoveryErrors],
        { cause: error },
      )
    }

    const restartErrors = preserveRunningState ? await this.restartManaged(closed) : []
    if (restartErrors.length > 0) {
      throw new CliLifecycleOperationError(
        this.target,
        'start',
        `The ${displayName(this.target)} connection was restored, but its previous managed instances could not all restart.`,
        restartErrors,
      )
    }

    return {
      target: this.target,
      repair: mergeRepairResults(this.client, repairs),
      closedManagedInstanceIds: closed,
      restartedManagedInstanceIds: preserveRunningState ? [...closed] : [],
      externalSessionsUnaffected: before.externalSessionDetected,
      pendingNewSession: before.externalSessionDetected,
    }
  }

  private async rollbackRepairs(repairs: readonly RepairClientConfigResult[]): Promise<string[]> {
    const errors: string[] = []
    for (const repair of [...repairs].reverse()) {
      try {
        await this.config.rollback(this.client, repair)
      } catch (error) {
        errors.push(`configuration rollback: ${messageOf(error)}`)
      }
    }
    return errors
  }

  private async restartManaged(ids: readonly string[]): Promise<string[]> {
    const errors: string[] = []
    for (const id of ids) {
      try {
        await this.runtime.startManaged(id)
      } catch (error) {
        errors.push(`${id}: ${messageOf(error)}`)
      }
    }
    if (ids.length === 0) return errors
    try {
      const after = await this.runtime.snapshot(this.client)
      const running = new Set(after.managedInstances.filter((instance) => instance.running).map((instance) => instance.id))
      for (const id of ids) {
        if (!running.has(id) && !errors.some((entry) => entry.startsWith(`${id}:`))) {
          errors.push(`${id}: managed instance did not report running after restart`)
        }
      }
    } catch (error) {
      errors.push(`restart verification: ${messageOf(error)}`)
    }
    return errors
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.operationTail
    let release!: () => void
    this.operationTail = new Promise<void>((resolve) => { release = resolve })
    await preceding
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export class ClaudeCodeLifecycleAdapter extends ConnectionOnlyCliLifecycleAdapter {
  constructor(options: Omit<ConnectionOnlyCliAdapterOptions, 'target'>) {
    super({ ...options, target: 'claude-code' })
  }
}

export class GeminiCliLifecycleAdapter extends ConnectionOnlyCliLifecycleAdapter {
  constructor(options: Omit<ConnectionOnlyCliAdapterOptions, 'target'>) {
    super({ ...options, target: 'gemini-cli' })
  }
}

export class GrokBuildLifecycleAdapter extends ConnectionOnlyCliLifecycleAdapter {
  constructor(options: Omit<ConnectionOnlyCliAdapterOptions, 'target'>) {
    super({ ...options, target: 'grok-build' })
  }
}

export class DeepSeekHarnessLifecycleAdapter extends ConnectionOnlyCliLifecycleAdapter {
  constructor(options: Omit<ConnectionOnlyCliAdapterOptions, 'target'>) {
    super({ ...options, target: 'deepseek-harness' })
  }
}

function uniqueConfigDirectories(instances: readonly ManagedCliInstanceState[]): string[] {
  return [...new Set(instances.map((instance) => instance.configDirectory).filter((value): value is string => Boolean(value)))]
}

function mergeRepairResults(
  client: SupportedClient,
  repairs: readonly RepairClientConfigResult[],
): RepairClientConfigResult {
  return {
    client,
    changedFiles: repairs.flatMap((repair) => repair.changedFiles),
    backups: repairs.flatMap((repair) => repair.backups),
    removedBackups: repairs.flatMap((repair) => repair.removedBackups),
    rebuiltRoles: [...new Set(repairs.flatMap((repair) => repair.rebuiltRoles))],
    ...(repairs.find((repair) => repair.retentionWarning)?.retentionWarning
      ? { retentionWarning: repairs.find((repair) => repair.retentionWarning)!.retentionWarning }
      : {}),
  }
}

function displayName(target: ConnectionOnlyAgentTarget): string {
  if (target === 'claude-code') return 'Claude Code CLI'
  if (target === 'gemini-cli') return 'Gemini CLI'
  return target === 'grok-build' ? 'Grok Build' : 'DeepSeek Harness'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
