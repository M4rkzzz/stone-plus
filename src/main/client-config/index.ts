export { ClientConfigService } from './service'
export { resolveClientConfigPaths, clientFiles, allClientFiles } from './paths'
export { planClientConfig, planClientConfigRepair, planClaudeConfig, planCodexConfig, planGeminiConfig } from './planners'
export { parseJsonObject } from './json-format'
export { mutateDotenv } from './dotenv-format'
export { locateCodexTomlPath, planCodexToml, repairCodexToml } from './toml-format'
export type {
  ApplyClientConfigResult,
  BackupRecord,
  ClientConfigBackupSet,
  ClientConfigApplyOptions,
  ClientConfigFilePath,
  ClientConfigFileRole,
  ClientConfigPathOptions,
  ClientConfigPathOverrides,
  ClientConfigPlan,
  ClientConfigRepairPlan,
  ClientConfigServiceOptions,
  ClientConnectionTarget,
  CreateBackupSetResult,
  DetectedClientConfig,
  ExistingClientConfig,
  PlannedFileMutation,
  ResolvedClientConfigPaths,
  RestoreBackupResult,
  RestoreBackupSetResult,
  RepairClientConfigResult,
  SupportedClient,
} from './types'
export { ClientConfigParseError, ClientConfigValidationError } from './types'
