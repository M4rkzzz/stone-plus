import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parse } from 'smol-toml'

export const CODEX_STATE_DATABASE_FILENAME = 'state_5.sqlite'

/**
 * Resolve Codex's primary state database plus its documented SQLite override.
 * `sqlite_home` in config.toml wins over CODEX_SQLITE_HOME, matching Codex and
 * keeping every Stone+ maintenance surface on the same physical database.
 */
export function codexStateDatabasePaths(
  codexHome: string,
  configText: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string[] {
  const paths = [resolve(codexHome, CODEX_STATE_DATABASE_FILENAME)]
  const configuredHome = sqliteHomeFromConfig(configText, userHome)
    ?? sqliteHomeFromEnvironment(environment, userHome)
  if (configuredHome) paths.push(resolve(configuredHome, CODEX_STATE_DATABASE_FILENAME))
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sqliteHomeFromConfig(configText: string, userHome: string): string | undefined {
  if (!configText.trim()) return undefined
  try {
    const root = parse(configText) as Record<string, unknown>
    return resolvedUserPath(root.sqlite_home, userHome)
  } catch {
    return undefined
  }
}

function sqliteHomeFromEnvironment(
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string | undefined {
  return resolvedUserPath(environment.CODEX_SQLITE_HOME, userHome)
}

function resolvedUserPath(value: unknown, userHome: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  if (!path || path.length > 32_768 || path.includes('\0')) return undefined
  if (path === '~') return resolve(userHome)
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(userHome, path.slice(2))
  }
  return resolve(path)
}
