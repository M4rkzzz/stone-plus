import type { AgentRestoreOptions, AgentStartOptions } from '@shared/agent-lifecycle'
import type { ClientConnectionTarget } from '../client-config'
import type { RepairClientConfigResult } from '../client-config'
import type {
  ClaudeDesktopConfigurationRepair,
  ClaudeDesktopInferenceModel,
} from './claude-desktop-config'
import type { ClaudeDesktopOperationCoordinatorPort } from './claude-desktop-operation-coordinator'
import type { AgentExecutableDiscovery } from './platform-discovery'

export type { ClaudeDesktopConfigurationPort } from './claude-desktop-operation-coordinator'

export type ClaudeLaunchSurfaceTarget = 'claude-code-desktop' | 'claude-code-vsc'

export interface ClaudeSurfaceInstallationPort {
  inspect(target: ClaudeLaunchSurfaceTarget): Promise<AgentExecutableDiscovery>
}

export interface ClaudeSharedConfigurationPort {
  repair(client: 'claude', target: ClientConnectionTarget): Promise<RepairClientConfigResult>
  validate(client: 'claude', target: ClientConnectionTarget): Promise<void>
  rollback(client: 'claude', repair: RepairClientConfigResult): Promise<unknown>
}

export interface ClaudeVscodeConfigurationRepair {
  readonly changed: boolean
  rollback(): Promise<void>
}

export interface ClaudeVscodeConfigurationPort {
  inspect(target: ClientConnectionTarget, launchTarget?: string): Promise<boolean>
  repair(target: ClientConnectionTarget, launchTarget?: string): Promise<ClaudeVscodeConfigurationRepair>
  validate(target: ClientConnectionTarget, launchTarget?: string): Promise<void>
}

export interface ClaudeSurfaceAdapterOptions {
  target: ClaudeLaunchSurfaceTarget
  installation: ClaudeSurfaceInstallationPort
  openExternal(url: string): Promise<unknown>
  connection(): ClientConnectionTarget
  prepareRoute?(): Promise<void>
  sharedConfig: ClaudeSharedConfigurationPort
  desktopCoordinator?: ClaudeDesktopOperationCoordinatorPort
  desktopModels?(): readonly ClaudeDesktopInferenceModel[]
  vscodeConfig?: ClaudeVscodeConfigurationPort
}

/**
 * Claude Desktop's Code tab and Claude Code for VS Code are host-owned
 * surfaces. Stone+ may open them, but must never adopt or terminate their host
 * processes: doing so would also close unrelated Claude chats or editor work.
 */
export class ClaudeSurfaceLifecycleAdapter {
  readonly target: ClaudeLaunchSurfaceTarget

  constructor(private readonly options: ClaudeSurfaceAdapterOptions) {
    this.target = options.target
  }

  async getSnapshot() {
    const installation = await this.options.installation.inspect(this.target)
    let configured = false
    if (installation.installed && this.target === 'claude-code-desktop' && this.options.desktopCoordinator) {
      try {
        const connection = this.options.connection()
        const models = this.requireDesktopModels()
        configured = await this.options.desktopCoordinator.inspect(connection, models)
        if (configured) await this.options.desktopCoordinator.validate(connection, models)
      } catch {
        configured = false
      }
    } else if (installation.installed && this.target === 'claude-code-vsc' && this.options.vscodeConfig) {
      try {
        const connection = this.options.connection()
        await this.options.sharedConfig.validate('claude', connection)
        configured = await this.options.vscodeConfig.inspect(connection, installation.launchTarget)
        if (configured) await this.options.vscodeConfig.validate(connection, installation.launchTarget)
      } catch {
        configured = false
      }
    }
    return {
      installation: {
        installed: installation.installed,
        ...(installation.executablePath ? { executablePath: installation.executablePath } : {}),
      },
      configured,
      // There is no supported API that identifies one Desktop Code tab or
      // one VS Code panel as running. Reporting the host process would expose
      // unsafe Close/Restart actions, so these surfaces are intentionally
      // launch-only.
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable' as const,
    }
  }

  async close() {
    return { wasRunning: false, pendingNewSession: false }
  }

  async restore(_options?: AgentRestoreOptions) {
    if (this.target === 'claude-code-desktop') {
      const coordinator = this.requireDesktopCoordinator()
      return coordinator.runExclusive(async () => {
        await this.assertDesktopInstalled()
        return this.restoreDesktopConnection(coordinator)
      })
    }
    const vscodeConfig = this.options.vscodeConfig
    if (!vscodeConfig) throw new Error('Claude Code VSC configuration support is unavailable.')
    const installation = await this.options.installation.inspect(this.target)
    if (!installation.installed) throw new Error('Claude Code VSC is not installed.')
    await this.options.prepareRoute?.()
    const connection = this.options.connection()
    let sharedRepair: RepairClientConfigResult | undefined
    let surfaceRepair: ClaudeVscodeConfigurationRepair | undefined
    try {
      sharedRepair = await this.options.sharedConfig.repair('claude', connection)
      surfaceRepair = await vscodeConfig.repair(connection, installation.launchTarget)
      await this.options.sharedConfig.validate('claude', connection)
      await vscodeConfig.validate(connection, installation.launchTarget)
      return {
        wasRunning: false,
        changed: sharedRepair.changedFiles.length > 0 || surfaceRepair.changed,
        pendingNewSession: true,
      }
    } catch (cause) {
      const rollbackFailures: string[] = []
      if (surfaceRepair) {
        try { await surfaceRepair.rollback() } catch { rollbackFailures.push('VS Code settings') }
      }
      if (sharedRepair) {
        try { await this.options.sharedConfig.rollback('claude', sharedRepair) } catch { rollbackFailures.push('Claude settings') }
      }
      if (rollbackFailures.length > 0) {
        throw lifecycleConfigurationError(
          `Claude Code VSC setup failed and rollback was incomplete for: ${rollbackFailures.join(', ')}.`,
          false,
        )
      }
      // Configuration errors can contain a rejected settings value. Do not
      // propagate credential-bearing diagnostics across IPC or into renderer
      // notices; detailed filesystem failures remain available at their source.
      void cause
      throw lifecycleConfigurationError('Claude Code VSC setup failed. Existing configuration was restored.')
    }
  }

  async start(_options?: AgentStartOptions): Promise<void> {
    if (this.target === 'claude-code-desktop') {
      const coordinator = this.requireDesktopCoordinator()
      await coordinator.runExclusive(async () => {
        await this.assertDesktopInstalled()
        await this.restoreDesktopConnection(coordinator)
        // Never forward a discovery- or renderer-controlled launch target.
        await this.options.openExternal('claude://code/new')
      })
      return
    }
    const installation = await this.options.installation.inspect(this.target)
    if (!installation.installed) throw new Error(`${this.target} is not installed.`)
    await this.restore()
    await this.options.openExternal(installation.launchTarget ?? 'vscode://anthropic.claude-code/open')
  }

  private async assertDesktopInstalled(): Promise<void> {
    const installation = await this.options.installation.inspect('claude-code-desktop')
    if (!installation.installed) throw new Error('Claude Code Desktop is not installed.')
  }

  private async restoreDesktopConnection(
    coordinator: ClaudeDesktopOperationCoordinatorPort,
  ) {
    let surfaceRepair: ClaudeDesktopConfigurationRepair | undefined
    try {
      await this.options.prepareRoute?.()
      const connection = this.options.connection()
      const models = this.requireDesktopModels()
      surfaceRepair = await coordinator.repair(connection, models)
      await coordinator.validate(connection, models)
      return {
        wasRunning: false,
        changed: surfaceRepair.changed,
        // Desktop reads third-party inference configuration only at process
        // launch. Stone+ never terminates the shared Chat/Cowork/Code host.
        pendingNewSession: true,
      }
    } catch (cause) {
      if (surfaceRepair) {
        try {
          await surfaceRepair.rollback()
        } catch {
          throw lifecycleConfigurationError(
            'Claude Code Desktop setup failed and its configuration could not be restored safely.',
            false,
          )
        }
      }
      // Parser and policy failures may originate beside the local bearer
      // credential. Never propagate their details through lifecycle IPC.
      void cause
      throw lifecycleConfigurationError('Claude Code Desktop setup failed. Existing configuration was preserved.')
    }
  }

  private requireDesktopCoordinator(): ClaudeDesktopOperationCoordinatorPort {
    const coordinator = this.options.desktopCoordinator
    if (!coordinator) {
      throw lifecycleConfigurationError('Claude Code Desktop configuration support is unavailable.')
    }
    return coordinator
  }

  private requireDesktopModels(): readonly ClaudeDesktopInferenceModel[] {
    const models = this.options.desktopModels?.()
    if (!models || models.length === 0) {
      throw new Error('Claude Code Desktop has no compatible model mapping.')
    }
    return models
  }
}

function lifecycleConfigurationError(message: string, retryable = true): Error {
  return Object.assign(new Error(message), {
    lifecycleCode: 'configuration-failed' as const,
    phase: 'restore-connection' as const,
    retryable,
  })
}
