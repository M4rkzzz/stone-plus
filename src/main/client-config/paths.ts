import { posix, win32 } from 'node:path'
import type {
  ClientConfigFilePath,
  ClientConfigPathOptions,
  ResolvedClientConfigPaths,
  SupportedClient,
} from './types'
import { ClientConfigValidationError } from './types'

function pathApiFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

function file(
  client: SupportedClient,
  role: ClientConfigFilePath['role'],
  format: ClientConfigFilePath['format'],
  path: string,
  containsCredential: boolean,
): ClientConfigFilePath {
  return { client, role, format, path, containsCredential }
}

export function resolveClientConfigPaths(options: ClientConfigPathOptions): ResolvedClientConfigPaths {
  const pathApi = pathApiFor(options.platform)
  if (!pathApi.isAbsolute(options.homeDir)) {
    throw new ClientConfigValidationError('Client configuration home directory must be absolute')
  }
  for (const directory of Object.values(options.overrides ?? {})) {
    if (!pathApi.isAbsolute(directory)) {
      throw new ClientConfigValidationError('Custom client configuration directories must be absolute')
    }
  }
  const home = pathApi.normalize(options.homeDir)
  const claudeDirectory = pathApi.normalize(options.overrides?.claudeDirectory ?? pathApi.join(home, '.claude'))
  const codexDirectory = pathApi.normalize(options.overrides?.codexDirectory ?? pathApi.join(home, '.codex'))
  const geminiDirectory = pathApi.normalize(options.overrides?.geminiDirectory ?? pathApi.join(home, '.gemini'))

  return {
    claude: {
      directory: claudeDirectory,
      settings: file('claude', 'claude-settings', 'json', pathApi.join(claudeDirectory, 'settings.json'), true),
      ...(!options.overrides?.claudeDirectory
        ? { mcp: file('claude', 'claude-mcp', 'json', pathApi.join(home, '.claude.json'), true) }
        : {}),
    },
    codex: {
      directory: codexDirectory,
      // Custom providers may embed bearer tokens or API keys directly in config.toml.
      config: file('codex', 'codex-config', 'toml', pathApi.join(codexDirectory, 'config.toml'), true),
      auth: file('codex', 'codex-auth', 'json', pathApi.join(codexDirectory, 'auth.json'), true),
    },
    gemini: {
      directory: geminiDirectory,
      settings: file('gemini', 'gemini-settings', 'json', pathApi.join(geminiDirectory, 'settings.json'), false),
      env: file('gemini', 'gemini-env', 'dotenv', pathApi.join(geminiDirectory, '.env'), true),
    },
  }
}

export function clientFiles(paths: ResolvedClientConfigPaths, client: SupportedClient): ClientConfigFilePath[] {
  if (client === 'claude') return [paths.claude.settings, ...(paths.claude.mcp ? [paths.claude.mcp] : [])]
  if (client === 'codex') return [paths.codex.config, paths.codex.auth]
  return [paths.gemini.settings, paths.gemini.env]
}

export function allClientFiles(paths: ResolvedClientConfigPaths): ClientConfigFilePath[] {
  return [...clientFiles(paths, 'claude'), ...clientFiles(paths, 'codex'), ...clientFiles(paths, 'gemini')]
}

export function clientDirectory(paths: ResolvedClientConfigPaths, client: SupportedClient): string {
  return paths[client].directory
}
