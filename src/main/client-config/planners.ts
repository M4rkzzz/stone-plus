import { mutateDotenv, validateDotenv } from './dotenv-format'
import { mutateJsonObject, objectField, type JsonObject, type TextMutation } from './json-format'
import { planCodexOfficialLoginToml, planCodexToml, repairCodexToml } from './toml-format'
import type {
  ClientConfigFilePath,
  ClientConfigPlan,
  ClientConfigRepairPlan,
  ClientConnectionTarget,
  ExistingClientConfig,
  PlannedFileMutation,
  ResolvedClientConfigPaths,
  SupportedClient,
} from './types'
import { ClientConfigParseError, ClientConfigValidationError } from './types'

function normalizedTarget(target: ClientConnectionTarget): ClientConnectionTarget {
  if (!target.token.trim()) throw new ClientConfigValidationError('A non-empty local access token is required')
  let url: URL
  try {
    url = new URL(target.gatewayBaseUrl)
  } catch {
    throw new ClientConfigValidationError('Gateway base URL is invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new ClientConfigValidationError('Gateway base URL must be an HTTP(S) origin without credentials, query, or fragment')
  }
  const baseUrl = url.toString().replace(/\/$/, '')
  return { gatewayBaseUrl: baseUrl, token: target.token }
}

function mutation(
  file: ClientConfigFilePath,
  existing: string | undefined,
  result: TextMutation,
  managedFields: string[],
): PlannedFileMutation {
  return {
    ...file,
    content: result.content,
    changed: result.changed,
    existed: existing !== undefined,
    managedFields,
  }
}

export function planClaudeConfig(
  paths: ResolvedClientConfigPaths['claude'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const source = existing['claude-settings']
  const settings = mutateJsonObject(source, 'claude-settings', (root) => {
    const environment = objectField(root, 'env', 'claude-settings')
    environment.ANTHROPIC_BASE_URL = desired.gatewayBaseUrl
    environment.ANTHROPIC_AUTH_TOKEN = desired.token
  })
  return {
    client: 'claude',
    files: [mutation(paths.settings, source, settings, [
      'env.ANTHROPIC_BASE_URL',
      'env.ANTHROPIC_AUTH_TOKEN',
    ])],
  }
}

export function planCodexConfig(
  paths: ResolvedClientConfigPaths['codex'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const configSource = existing['codex-config']
  const authSource = existing['codex-auth']
  const config = planCodexToml(configSource, `${desired.gatewayBaseUrl}/v1`)
  const auth = mutateJsonObject(authSource, 'codex-auth', (root) => {
    root.auth_mode = 'apikey'
    root.OPENAI_API_KEY = desired.token
  })
  return {
    client: 'codex',
    files: [
      mutation(paths.config, configSource, config, [
        'model_provider',
        'cli_auth_credentials_store',
        'features.remote_compaction_v2',
        'model_providers.stone',
      ]),
      mutation(paths.auth, authSource, auth, ['auth_mode', 'OPENAI_API_KEY']),
    ],
  }
}

/**
 * Restore Codex's built-in ChatGPT/OpenAI sign-in path while retaining cached
 * ChatGPT tokens and every unrelated user setting.
 */
export function planCodexOfficialLoginConfig(
  paths: ResolvedClientConfigPaths['codex'],
  existing: ExistingClientConfig,
): ClientConfigPlan {
  const configSource = existing['codex-config']
  const authSource = existing['codex-auth']
  const config = planCodexOfficialLoginToml(configSource)
  const files: PlannedFileMutation[] = [mutation(paths.config, configSource, config, [
    'model_provider',
    'cli_auth_credentials_store',
    'features.remote_compaction_v2',
    'model_providers.stone',
  ])]

  // Do not create an empty auth.json. With no cached credentials Codex should
  // open its normal official sign-in flow on relaunch.
  if (authSource !== undefined) {
    const auth = mutateJsonObject(authSource, 'codex-auth', (root) => {
      delete root.OPENAI_API_KEY
      if (root.auth_mode !== 'apikey') return
      const tokens = root.tokens
      if (tokens && typeof tokens === 'object' && !Array.isArray(tokens) && Object.keys(tokens).length > 0) {
        root.auth_mode = 'chatgpt'
      } else {
        delete root.auth_mode
      }
    })
    files.push(mutation(paths.auth, authSource, auth, ['auth_mode', 'OPENAI_API_KEY']))
  }

  return { client: 'codex', files }
}

export function planGeminiConfig(
  paths: ResolvedClientConfigPaths['gemini'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const settingsSource = existing['gemini-settings']
  const envSource = existing['gemini-env']
  const settings = mutateJsonObject(settingsSource, 'gemini-settings', (root) => {
    const security = objectField(root, 'security', 'gemini-settings')
    const auth = objectField(security, 'auth', 'gemini-settings')
    auth.selectedType = 'gemini-api-key'
  })
  const env = mutateDotenv(envSource, {
    GEMINI_API_KEY: desired.token,
    GEMINI_API_KEY_AUTH_MECHANISM: 'bearer',
    GOOGLE_GEMINI_BASE_URL: desired.gatewayBaseUrl,
  })
  return {
    client: 'gemini',
    files: [
      mutation(paths.settings, settingsSource, settings, ['security.auth.selectedType']),
      mutation(paths.env, envSource, env, [
        'GEMINI_API_KEY',
        'GEMINI_API_KEY_AUTH_MECHANISM',
        'GOOGLE_GEMINI_BASE_URL',
      ]),
    ],
  }
}

export function planClientConfig(
  client: SupportedClient,
  paths: ResolvedClientConfigPaths,
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  if (client === 'claude') return planClaudeConfig(paths.claude, existing, target)
  if (client === 'codex') return planCodexConfig(paths.codex, existing, target)
  return planGeminiConfig(paths.gemini, existing, target)
}

const repairableRoles: Readonly<Record<SupportedClient, ReadonlySet<ClientConfigFilePath['role']>>> = {
  claude: new Set(['claude-settings']),
  codex: new Set(['codex-config', 'codex-auth']),
  gemini: new Set(['gemini-settings', 'gemini-env']),
}

function repairObjectField(parent: JsonObject, key: string): JsonObject {
  const current = parent[key]
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    return current as JsonObject
  }
  const replacement: JsonObject = {}
  parent[key] = replacement
  return replacement
}

function prepareJsonConnectionShape(
  source: string | undefined,
  role: ClientConfigFilePath['role'],
  prepare: (root: JsonObject) => void,
): string | undefined {
  if (source === undefined) return undefined
  return mutateJsonObject(source, role, prepare).content
}

/**
 * Plan a conservative connection repair.
 *
 * Valid documents go through the normal structural mutators, preserving every
 * user-owned model, MCP, plugin, project and unknown setting. Only a document
 * that cannot be parsed (or whose required object shape is unusable) is replaced
 * by the planner's minimal valid document.
 */
export function planClientConfigRepair(
  client: SupportedClient,
  paths: ResolvedClientConfigPaths,
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigRepairPlan {
  const repairInput: ExistingClientConfig = { ...existing }
  const rebuiltRoles: ClientConfigFilePath['role'][] = []
  const repairable = repairableRoles[client]

  if (client === 'codex' && repairInput['codex-config'] !== undefined) {
    try {
      const desired = normalizedTarget(target)
      repairInput['codex-config'] = repairCodexToml(
        repairInput['codex-config'],
        `${desired.gatewayBaseUrl}/v1`,
      ).content
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['codex-config']
      rebuiltRoles.push('codex-config')
    }
  }

  // A valid JSON object with a scalar where a connection container belongs is
  // still recoverable without throwing away sibling settings. Normalize only
  // that owned path before the standard planner fills in Stone+ values.
  if (client === 'claude' && repairInput['claude-settings'] !== undefined) {
    try {
      repairInput['claude-settings'] = prepareJsonConnectionShape(
        repairInput['claude-settings'],
        'claude-settings',
        (root) => { repairObjectField(root, 'env') },
      )
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['claude-settings']
      rebuiltRoles.push('claude-settings')
    }
  }

  if (client === 'gemini' && repairInput['gemini-settings'] !== undefined) {
    try {
      repairInput['gemini-settings'] = prepareJsonConnectionShape(
        repairInput['gemini-settings'],
        'gemini-settings',
        (root) => {
          const security = repairObjectField(root, 'security')
          repairObjectField(security, 'auth')
        },
      )
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['gemini-settings']
      rebuiltRoles.push('gemini-settings')
    }
  }

  if (client === 'gemini' && repairInput['gemini-env'] !== undefined) {
    try {
      validateDotenv(repairInput['gemini-env'], 'gemini-env')
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['gemini-env']
      rebuiltRoles.push('gemini-env')
    }
  }

  // More than one managed document may be damaged. Remove one bad source per
  // iteration, then re-plan so every other valid document is still preserved.
  for (let attempt = 0; attempt <= repairable.size; attempt += 1) {
    try {
      const plan = planClientConfig(client, paths, repairInput, target)
      return {
        ...plan,
        files: plan.files.map((file) => ({
          ...file,
          existed: existing[file.role] !== undefined,
          changed: file.content !== existing[file.role],
        })),
        rebuiltRoles,
      }
    } catch (error) {
      if (
        !(error instanceof ClientConfigParseError)
        || !repairable.has(error.role)
        || repairInput[error.role] === undefined
      ) {
        throw error
      }
      delete repairInput[error.role]
      rebuiltRoles.push(error.role)
    }
  }

  throw new ClientConfigValidationError(`Unable to repair ${client} configuration`)
}
