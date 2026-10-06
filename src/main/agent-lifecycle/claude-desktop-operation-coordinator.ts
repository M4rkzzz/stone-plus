import type { ClientConnectionTarget } from '../client-config'
import type {
  ClaudeDesktopConfigurationRepair,
  ClaudeDesktopInferenceModel,
} from './claude-desktop-config'

export interface ClaudeDesktopConfigurationPort {
  inspect(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<boolean>
  repair(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<ClaudeDesktopConfigurationRepair>
  validate(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<void>
}

export interface ClaudeDesktopOfficialModeConfigurationPort {
  restoreOfficial(): Promise<ClaudeDesktopConfigurationRepair>
}

export interface ClaudeDesktopOperationCoordinatorPort extends ClaudeDesktopConfigurationPort {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  restoreOfficial(): Promise<ClaudeDesktopConfigurationRepair>
}

/**
 * Owns the process-wide Claude Desktop mutation boundary.
 *
 * ClaudeDesktopConfig still serializes individual filesystem operations. This
 * outer queue deliberately covers the complete lifecycle transaction so a
 * renderer-triggered official-mode restore cannot interleave between route
 * preparation, profile repair, validation, and opening Claude Desktop.
 */
export class ClaudeDesktopOperationCoordinator implements ClaudeDesktopOperationCoordinatorPort {
  private pendingOperation: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: ClaudeDesktopConfigurationPort & ClaudeDesktopOfficialModeConfigurationPort,
  ) {}

  inspect(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<boolean> {
    return this.config.inspect(target, models)
  }

  repair(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<ClaudeDesktopConfigurationRepair> {
    return this.config.repair(target, models)
  }

  validate(
    target: ClientConnectionTarget,
    models: readonly ClaudeDesktopInferenceModel[],
  ): Promise<void> {
    return this.config.validate(target, models)
  }

  restoreOfficial(): Promise<ClaudeDesktopConfigurationRepair> {
    return this.runExclusive(() => this.config.restoreOfficial())
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation)
    this.pendingOperation = result.then(() => undefined, () => undefined)
    return result
  }
}
