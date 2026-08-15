import { mutateDotenv, removeDotenvKeys, validateDotenv } from './dotenv-format'
import { normalizeCodexModelRepairPolicy } from '@shared/codex-model-repair'
import { CLAUDE_RELAY_MODEL_ENV_KEYS, isClaudeClientModelName } from './claude-environment'
import { planGrokBuildToml } from './grok-build-toml'
import { mutateJsonObject, objectField, type JsonObject, type TextMutation } from './json-format'
import { parseCodexToml, patchCodexTomlTopLevel, planCodexOfficialLoginToml, planCodexToml, repairCodexToml } from './toml-format'
import type {
  ClientConfigFilePath,
  ClientConfigPlan,
  ClientConfigRepairPlan,
  ClientConnectionTarget,
  CodexOfficialAccountCredential,
  ExistingClientConfig,
  PlannedFileMutation,
  ResolvedClientConfigPaths,
  SupportedClient,
} from './types'
import { ClientConfigParseError, ClientConfigValidationError } from './types'
import {
  deepSeekCodexCatalogModels,
  renderDeepSeekCodexModelCatalog,
} from './codex-model-catalog'
import { DEEPSEEK_V4_FLASH_CONTEXT_WINDOW } from '@shared/deepseek'

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
  const modelContextWindow = typeof target.modelContextWindow === 'number'
    && Number.isInteger(target.modelContextWindow)
    && target.modelContextWindow > 0
    ? target.modelContextWindow
    : undefined
  return {
    gatewayBaseUrl: baseUrl,
    token: target.token.trim(),
    ...(modelContextWindow ? { modelContextWindow } : {}),
    ...(target.codexModelRepair
      ? { codexModelRepair: normalizeCodexModelRepairPolicy(target.codexModelRepair) }
      : {}),
  }
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
    if (typeof root.model === 'string' && root.model.trim() && !isClaudeClientModelName(root.model)) {
      delete root.model
    }
    const environment = objectField(root, 'env', 'claude-settings')
    // Provider-specific model overrides from a previous relay are not valid
    // Claude client selections once Stone+ owns the connection. Keep the
    // user's top-level Claude model preference, but move upstream selection to
    // Route.modelMap so an OpenAI/Grok identifier is never shown to or
    // validated by Claude Code itself.
    for (const key of CLAUDE_RELAY_MODEL_ENV_KEYS) delete environment[key]
    environment.ANTHROPIC_BASE_URL = desired.gatewayBaseUrl
    environment.ANTHROPIC_AUTH_TOKEN = desired.token
    // Claude Code documents this as the gateway-friendly mode: omit the
    // changing attribution prefix so Stone+ upstream prompt caches stay stable.
    environment.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
  })
  return {
    client: 'claude',
    files: [mutation(paths.settings, source, settings, [
      'env.ANTHROPIC_BASE_URL',
      'env.ANTHROPIC_AUTH_TOKEN',
      'env.CLAUDE_CODE_ATTRIBUTION_HEADER',
      'model (only non-Claude relay values)',
      ...CLAUDE_RELAY_MODEL_ENV_KEYS.map((key) => `env.${key}`),
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
  const catalogSource = existing['codex-model-catalog']
  const deepSeekCatalog = desired.modelContextWindow === DEEPSEEK_V4_FLASH_CONTEXT_WINDOW
  const parsedConfig = parseCodexToml(configSource ?? '')
  const catalogContent = deepSeekCatalog
    ? renderDeepSeekCodexModelCatalog(deepSeekCodexCatalogModels(
        [parsedConfig.model, parsedConfig.review_model],
        desired.codexModelRepair,
      ))
    : undefined
  const config = planCodexToml(
    configSource,
    `${desired.gatewayBaseUrl}/v1`,
    desired.modelContextWindow,
    deepSeekCatalog ? paths.modelCatalog.path : undefined,
  )
  const auth = mutateJsonObject(authSource, 'codex-auth', (root) => {
    // Codex Desktop can inspect the cached ChatGPT token bundle even when
    // auth_mode is switched back to API-key mode. Leaving both credential
    // families in auth.json makes the selected identity startup-order
    // dependent and can keep a previous official/third-party login alive.
    // Stone+ owns these authentication fields while connected, so converge to
    // one unambiguous API-key state. The transaction layer backs up the exact
    // original auth.json before this mutation, and unrelated extension fields
    // remain untouched.
    delete root.tokens
    delete root.last_refresh
    delete root.agent_identity
    delete root.personal_access_token
    delete root.bedrock_api_key
    root.auth_mode = 'apikey'
    root.OPENAI_API_KEY = desired.token
  })
  return {
    client: 'codex',
    files: [
      mutation(paths.config, configSource, config, [
        'model_provider',
        'cli_auth_credentials_store',
        'model_context_window (DeepSeek-only route)',
        'features.remote_compaction_v2',
        'model_providers.stone',
      ]),
      mutation(paths.auth, authSource, auth, [
        'auth_mode',
        'OPENAI_API_KEY',
        'tokens',
        'last_refresh',
        'agent_identity',
        'personal_access_token',
        'bedrock_api_key',
      ]),
      ...(catalogContent === undefined ? [] : [mutation(
        paths.modelCatalog,
        catalogSource,
        { content: catalogContent, changed: catalogContent !== catalogSource },
        [
          'DeepSeek Codex model capabilities',
          'freeform apply_patch and shell tool declarations',
          'reasoning levels and context window',
        ],
      )]),
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
    'model_context_window (Stone-managed DeepSeek value only)',
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

/**
 * Switch the default Codex installation to one exact Stone+ ChatGPT OAuth
 * account. File-backed auth is pinned deliberately: otherwise an OS keyring
 * entry can silently win over the selected auth.json account.
 */
export function planCodexOfficialAccountConfig(
  paths: ResolvedClientConfigPaths['codex'],
  existing: ExistingClientConfig,
  credential: CodexOfficialAccountCredential,
): ClientConfigPlan {
  const accessToken = credential.accessToken.trim()
  const refreshToken = credential.refreshToken.trim()
  const idToken = credential.idToken.trim()
  const accountId = credential.accountId.trim()
  if (!accessToken || !refreshToken || !idToken || !accountId) {
    throw new ClientConfigValidationError('A complete renewable ChatGPT OAuth credential is required')
  }
  if (!Number.isFinite(credential.lastRefreshAt) || credential.lastRefreshAt <= 0) {
    throw new ClientConfigValidationError('The ChatGPT OAuth refresh timestamp is invalid')
  }
  const availableModels = credential.availableModels === undefined
    ? undefined
    : [...new Set(credential.availableModels.map((model) => model.trim()).filter(Boolean))]
  if (credential.availableModels !== undefined && !availableModels?.length) {
    throw new ClientConfigValidationError('The official Codex model catalog is empty')
  }

  const configSource = existing['codex-config']
  const authSource = existing['codex-auth']
  const officialConfig = planCodexOfficialLoginToml(configSource)
  const officialRoot = parseCodexToml(officialConfig.content)
  const configPatches: Record<string, string | null> = {
    cli_auth_credentials_store: 'file',
  }
  if (availableModels) {
    const allowed = new Set(availableModels)
    for (const key of ['model', 'review_model'] as const) {
      const selected = typeof officialRoot[key] === 'string' ? officialRoot[key].trim() : ''
      if (selected && !allowed.has(selected)) configPatches[key] = null
    }
  }
  const pinnedConfig = patchCodexTomlTopLevel(officialConfig.content, configPatches)
  const config = {
    content: pinnedConfig.content,
    changed: pinnedConfig.content !== configSource,
  }
  const auth = mutateJsonObject(authSource, 'codex-auth', (root) => {
    delete root.OPENAI_API_KEY
    delete root.agent_identity
    delete root.personal_access_token
    delete root.bedrock_api_key
    root.auth_mode = 'chatgpt'
    root.last_refresh = new Date(credential.lastRefreshAt).toISOString()
    root.tokens = {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
    }
  })

  return {
    client: 'codex',
    files: [
      mutation(paths.config, configSource, config, [
        'model_provider',
        'cli_auth_credentials_store',
        'model/review_model (only when absent from the selected account catalog)',
        'model_context_window (Stone-managed DeepSeek value only)',
        'features.remote_compaction_v2',
        'model_providers.stone',
      ]),
      mutation(paths.auth, authSource, auth, [
        'auth_mode',
        'last_refresh',
        'tokens',
        'OPENAI_API_KEY',
        'agent_identity',
        'personal_access_token',
        'bedrock_api_key',
      ]),
    ],
  }
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

export function planGrokBuildConfig(
  paths: ResolvedClientConfigPaths['grokbuild'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const source = existing['grok-config']
  const config = planGrokBuildToml(
    source,
    `${desired.gatewayBaseUrl}/grokbuild/v1`,
    desired.token,
  )
  return {
    client: 'grokbuild',
    files: [mutation(paths.config, source, config, [
      'auth.preferred_method',
      'models.default (when no custom profile exists)',
      'model.<selected>.base_url',
      'model.<selected>.api_key',
      'model.<selected>.api_backend',
    ])],
  }
}

export function planDeepSeekHarnessConfig(
  paths: ResolvedClientConfigPaths['deepseekHarness'],
  existing: ExistingClientConfig,
  target: ClientConnectionTarget,
): ClientConfigPlan {
  const desired = normalizedTarget(target)
  const source = existing['deepseek-harness-env']
  // DSH treats network bootstrap variables as inherited-process-only input and
  // refuses to start when DEEPSEEK_BASE_URL is present in ~/.dsh/.env. Stone+
  // injects the endpoint at the managed process boundary instead; retain only
  // the API credential here and remove the legacy value written by older builds.
  const withoutLegacyBaseUrl = removeDotenvKeys(source, new Set(['DEEPSEEK_BASE_URL'])).content
  const env = mutateDotenv(withoutLegacyBaseUrl, {
    DEEPSEEK_API_KEY: desired.token,
  })
  return {
    client: 'deepseek-harness',
    files: [mutation(paths.env, source, env, [
      'DEEPSEEK_API_KEY',
      'legacy DEEPSEEK_BASE_URL removal',
    ])],
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
  if (client === 'gemini') return planGeminiConfig(paths.gemini, existing, target)
  if (client === 'grokbuild') return planGrokBuildConfig(paths.grokbuild, existing, target)
  return planDeepSeekHarnessConfig(paths.deepseekHarness, existing, target)
}

const repairableRoles: Readonly<Record<SupportedClient, ReadonlySet<ClientConfigFilePath['role']>>> = {
  claude: new Set(['claude-settings']),
  codex: new Set(['codex-config', 'codex-auth', 'codex-model-catalog']),
  gemini: new Set(['gemini-settings', 'gemini-env']),
  grokbuild: new Set(['grok-config']),
  'deepseek-harness': new Set(['deepseek-harness-env']),
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
        desired.codexModelRepair,
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

  if (client === 'grokbuild' && repairInput['grok-config'] !== undefined) {
    try {
      const desired = normalizedTarget(target)
      repairInput['grok-config'] = planGrokBuildToml(
        repairInput['grok-config'],
        `${desired.gatewayBaseUrl}/grokbuild/v1`,
        desired.token,
      ).content
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['grok-config']
      rebuiltRoles.push('grok-config')
    }
  }

  if (client === 'deepseek-harness' && repairInput['deepseek-harness-env'] !== undefined) {
    try {
      validateDotenv(repairInput['deepseek-harness-env'], 'deepseek-harness-env')
    } catch (error) {
      if (!(error instanceof ClientConfigParseError)) throw error
      delete repairInput['deepseek-harness-env']
      rebuiltRoles.push('deepseek-harness-env')
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
