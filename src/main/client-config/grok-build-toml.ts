import type { TextMutation } from './json-format'
import { parseCodexToml, patchCodexTomlPaths } from './toml-format'
import { ClientConfigParseError, ClientConfigValidationError } from './types'

const MANAGED_PROFILE = 'stoneplus'
const DEFAULT_MODEL = 'grok-4.5'
const DEFAULT_CONTEXT_WINDOW = 500_000

type TomlObject = Record<string, unknown>

function objectValue(value: unknown): TomlObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TomlObject
    : undefined
}

function parseGrokBuildToml(content: string): TomlObject {
  try {
    return parseCodexToml(content)
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Cannot parse codex-config:\s*/, '') : 'invalid TOML'
    throw new ClientConfigParseError('grok-config', detail)
  }
}

function selectedProfile(root: TomlObject): { name: string; table: TomlObject } | undefined {
  const models = objectValue(root.models)
  const modelTables = objectValue(root.model)
  if (!models && !modelTables) return undefined
  if (!models || !modelTables) {
    throw new ClientConfigValidationError('Grok Build configuration has an incomplete models section')
  }
  const name = typeof models.default === 'string' ? models.default.trim() : ''
  if (!name) throw new ClientConfigValidationError('Grok Build configuration has no selected model profile')
  const table = objectValue(modelTables[name])
  if (!table) throw new ClientConfigValidationError(`Grok Build model profile ${name} does not exist`)
  return { name, table }
}

function validateExistingProfile(profile: { name: string; table: TomlObject }): void {
  for (const key of ['model', 'name'] as const) {
    if (typeof profile.table[key] !== 'string' || !profile.table[key].trim()) {
      throw new ClientConfigValidationError(`Grok Build model profile ${profile.name} has no ${key}`)
    }
  }
  const contextWindow = profile.table.context_window
  if (!Number.isInteger(contextWindow) || Number(contextWindow) <= 0) {
    throw new ClientConfigValidationError(`Grok Build model profile ${profile.name} has an invalid context_window`)
  }
}

/**
 * Point Grok Build's selected Responses profile at Stone+ without touching its
 * model identity, MCP servers, UI preferences, marketplace settings, or any
 * other profile. Official-login configs have no model table, so an explicit
 * Stone+ profile is added reversibly instead of reading or copying xAI OAuth
 * credentials.
 */
export function planGrokBuildToml(
  content: string | undefined,
  proxyBaseUrl: string,
  localToken: string,
): TextMutation {
  if (!localToken.trim()) throw new ClientConfigValidationError('A non-empty Grok Build local token is required')
  const source = content ?? ''
  const root = parseGrokBuildToml(source)
  const existing = selectedProfile(root)
  if (existing) validateExistingProfile(existing)
  const profile = existing?.name ?? MANAGED_PROFILE
  const patches = [
    // Grok Build 0.2.111 and later deliberately prefer a cached OIDC session
    // for the process-wide eager auth method when both auth.json and a custom
    // model API key exist.  Without this fail-closed pin, that session JWT can
    // replace the per-model Stone+ token on the wire, and the local gateway
    // rejects it before a request log is created.  The upstream Grok contract
    // defines [auth].preferred_method = "api_key" specifically to prevent that
    // cross-method fallthrough while leaving auth.json untouched.
    { path: ['auth', 'preferred_method'], value: 'api_key' },
    ...(!existing ? [
      { path: ['models', 'default'], value: profile },
      { path: ['model', profile, 'model'], value: DEFAULT_MODEL },
      { path: ['model', profile, 'name'], value: 'Stone+' },
      { path: ['model', profile, 'context_window'], value: DEFAULT_CONTEXT_WINDOW },
    ] : []),
    { path: ['model', profile, 'base_url'], value: proxyBaseUrl.replace(/\/+$/, '') },
    { path: ['model', profile, 'api_key'], value: localToken.trim() },
    // Responses is Grok Build's native custom-model backend. Stone+ keeps this
    // route bound to Responses-native Grok sources instead of translating it
    // through Chat or another provider protocol.
    { path: ['model', profile, 'api_backend'], value: 'responses' },
  ]
  try {
    return patchCodexTomlPaths(source, patches)
  } catch (error) {
    if (error instanceof ClientConfigValidationError) throw error
    const detail = error instanceof Error ? error.message.replace(/^Cannot parse codex-config:\s*/, '') : 'invalid TOML'
    throw new ClientConfigParseError('grok-config', detail)
  }
}
