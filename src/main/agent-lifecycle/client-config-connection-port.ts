import { dirname } from 'node:path'
import { ClientConfigService } from '../client-config/service'
import type {
  ApplyClientConfigResult,
  ClientConnectionTarget,
  RepairClientConfigResult,
  SupportedClient,
} from '../client-config/types'
import type { CliConnectionConfigPort, ScopedClientConfigApplyOptions } from './cli-connection-adapter'

/**
 * Credential-opaque bridge from lifecycle orchestration to the existing
 * transactional client configuration service.
 */
export class ClientConfigConnectionPort implements CliConnectionConfigPort {
  private readonly repairServices = new WeakMap<RepairClientConfigResult, ClientConfigService>()

  constructor(private readonly service: ClientConfigService) {}

  async inspect(client: SupportedClient, configDirectory?: string): Promise<{ configured: boolean }> {
    const [detected] = await this.serviceFor(client, configDirectory).detect(client)
    return { configured: detected?.configured === true }
  }

  repair(
    client: SupportedClient,
    target: ClientConnectionTarget,
    options: ScopedClientConfigApplyOptions = {},
  ): Promise<RepairClientConfigResult> {
    const { configDirectory, ...applyOptions } = options
    const service = this.serviceFor(client, configDirectory)
    return service.repair(client, target, applyOptions).then((repair) => {
      this.repairServices.set(repair, service)
      return repair
    })
  }

  async validate(client: SupportedClient, target: ClientConnectionTarget, configDirectory?: string): Promise<void> {
    const plan = await this.serviceFor(client, configDirectory).plan(client, target)
    const drifted = plan.files.filter((file) => file.changed).map((file) => file.role)
    if (drifted.length > 0) {
      throw new Error(`Stone+ connection validation failed for: ${drifted.join(', ')}`)
    }
  }

  async rollback(
    client: SupportedClient,
    repair: RepairClientConfigResult,
  ): Promise<ApplyClientConfigResult | void> {
    if (repair.changedFiles.length === 0) return
    const groups = [...new Set(repair.backups.map((backup) => backup.groupId))]
    if (groups.length !== 1) {
      throw new Error('Connection repair does not contain one coherent rollback backup set.')
    }
    const restored = await (this.repairServices.get(repair) ?? this.service).restoreBackupSet(client, groups[0])
    return {
      client,
      changedFiles: [...restored.restoredFiles, ...restored.deletedFiles],
      backups: restored.safetyBackupSet?.backups ?? [],
      removedBackups: [],
    }
  }

  private serviceFor(client: SupportedClient, configDirectory?: string): ClientConfigService {
    if (!configDirectory) return this.service
    const overrides = client === 'claude'
      ? { claudeDirectory: configDirectory }
      : client === 'codex'
        ? { codexDirectory: configDirectory }
        : client === 'gemini'
          ? { geminiDirectory: configDirectory }
          : client === 'grokbuild'
            ? { grokbuildDirectory: configDirectory }
            : { deepseekHarnessDirectory: configDirectory }
    return new ClientConfigService({
      homeDir: dirname(configDirectory),
      platform: process.platform,
      overrides,
    })
  }
}
