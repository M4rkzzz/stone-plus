import { createHmac, randomBytes } from 'node:crypto'
import type { ClientConfigEditorFile } from '@shared/types'
import { parseJsonObject, stringifyJsonObject, type JsonObject } from './json-format'
import { parseCodexToml, patchCodexTomlPaths, type TomlValue } from './toml-format'
import type { ClientConfigFilePath } from './types'
import { ClientConfigParseError, ClientConfigValidationError } from './types'

export const protectedValuePlaceholder = '__STONE_PROTECTED_VALUE__'
const dotenvAssignment = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*))(.*)$/
const revisionKey = randomBytes(32)

export function createClientConfigEditorFile(
  file: ClientConfigFilePath,
  source: string | undefined,
): ClientConfigEditorFile {
  const revision = revisionOf(file, source)
  if (file.role === 'codex-auth') {
    return {
      role: file.role,
      path: file.path,
      format: file.format,
      exists: source !== undefined,
      editable: false,
      containsCredential: true,
      ...(source !== undefined ? { content: source } : {}),
      revision,
      protectedValueCount: 0,
    }
  }
  if (file.role === 'claude-mcp') {
    const projected = projectClaudeMcp(source)
    return {
      role: file.role,
      path: file.path,
      format: file.format,
      exists: source !== undefined,
      editable: true,
      containsCredential: true,
      content: projected,
      revision,
      protectedValueCount: 0,
    }
  }
  const initial = source ?? defaultContent(file.format)
  return {
    role: file.role,
    path: file.path,
    format: file.format,
    exists: source !== undefined,
    editable: true,
    containsCredential: file.containsCredential,
    content: initial,
    revision,
    protectedValueCount: 0,
  }
}

export function restoreClientConfigEditorContent(
  file: ClientConfigFilePath,
  draft: string,
  source: string | undefined,
): string {
  if (Buffer.byteLength(draft, 'utf8') > 1024 * 1024) {
    throw new ClientConfigValidationError('A client configuration file is too large')
  }
  if (file.role === 'codex-auth') throw new ClientConfigValidationError('The Codex authentication file is protected')
  const original = source ?? defaultContent(file.format)
  if (file.role === 'claude-mcp') return restoreClaudeMcp(draft, original)
  if (file.format === 'json') return restoreJsonDocument(draft, original, file.role)
  if (file.format === 'dotenv') return restoreDotenv(draft, original)
  return restoreTomlDocument(draft, original, file.role)
}

/**
 * Opaque optimistic-concurrency token for one exact managed file.
 *
 * Binding the token to the client, role, and resolved path prevents a renderer
 * snapshot from one profile (or another file with identical bytes) from being
 * replayed against a different configuration target.
 */
export function revisionOf(file: ClientConfigFilePath, source: string | undefined): string {
  return createHmac('sha256', revisionKey)
    .update(JSON.stringify([file.client, file.role, file.format, file.path]))
    .update(source === undefined ? '\0missing' : `\x01${source}`)
    .digest('hex')
}

function defaultContent(format: ClientConfigFilePath['format']): string {
  return format === 'json' ? '{}\n' : ''
}

function isTomlValue(value: unknown): value is TomlValue {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function collectTomlPlaceholderPaths(
  value: unknown,
  path: string[] = [],
  result: string[][] = [],
): string[][] {
  if (value === protectedValuePlaceholder) {
    result.push(path)
    return result
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) collectTomlPlaceholderPaths(child, [...path, key], result)
  return result
}

function tomlValueAt(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function restoreTomlDocument(
  draft: string,
  original: string,
  role: ClientConfigFilePath['role'],
): string {
  const draftRoot = parseTomlForRole(draft, role)
  const originalRoot = parseTomlForRole(original, role)
  const placeholderPaths = collectTomlPlaceholderPaths(draftRoot)
  if (!placeholderPaths.length) return draft
  try {
    return patchCodexTomlPaths(draft, placeholderPaths.map((path) => {
      const value = tomlValueAt(originalRoot, path)
      if (!isTomlValue(value)) {
        throw new ClientConfigValidationError(`A protected value in ${role} no longer exists`)
      }
      return { path, value }
    })).content
  } catch (error) {
    if (error instanceof ClientConfigValidationError) throw error
    throw tomlRoleError(error, role)
  }
}

function parseTomlForRole(
  content: string,
  role: ClientConfigFilePath['role'],
): Record<string, unknown> {
  try {
    return parseCodexToml(content)
  } catch (error) {
    throw tomlRoleError(error, role)
  }
}

function tomlRoleError(error: unknown, role: ClientConfigFilePath['role']): ClientConfigParseError {
  if (error instanceof ClientConfigParseError && error.role === role) return error
  const detail = error instanceof Error
    ? error.message.replace(/^Cannot parse [^:]+:\s*/, '')
    : 'invalid TOML'
  return new ClientConfigParseError(role, detail)
}

function projectClaudeMcp(source: string | undefined): string {
  const original = source ?? '{}\n'
  const root = parseJsonObject(original, 'claude-mcp')
  const projected: JsonObject = {}
  if (root.mcpServers !== undefined) projected.mcpServers = root.mcpServers
  return stringifyJsonObject(projected)
}

function restoreClaudeMcp(draft: string, original: string): string {
  const draftRoot = parseJsonObject(draft, 'claude-mcp')
  if (Object.keys(draftRoot).some((key) => key !== 'mcpServers')) {
    throw new ClientConfigValidationError('Only Claude MCP servers can be edited from the protected user state file')
  }
  const projectedOriginal = projectClaudeMcp(original)
  const restoredProjection = parseJsonObject(
    restoreJsonDocument(draft, projectedOriginal, 'claude-mcp'),
    'claude-mcp',
  )
  const root = parseJsonObject(original, 'claude-mcp')
  if (restoredProjection.mcpServers === undefined) delete root.mcpServers
  else root.mcpServers = restoredProjection.mcpServers
  return stringifyJsonObject(root, original)
}

function restoreJsonDocument(
  draft: string,
  original: string,
  role: ClientConfigFilePath['role'],
): string {
  const draftRoot = parseJsonObject(draft, role)
  const originalRoot = parseJsonObject(original, role)
  const restored = restoreJsonValue(draftRoot, originalRoot, role)
  return stringifyJsonObject(restored as JsonObject, draft)
}

function restoreJsonValue(draft: unknown, original: unknown, role: ClientConfigFilePath['role']): unknown {
  if (draft === protectedValuePlaceholder) {
    if (original === undefined) throw new ClientConfigValidationError(`A protected value in ${role} no longer exists`)
    return structuredClone(original)
  }
  if (Array.isArray(draft)) {
    const source = Array.isArray(original) ? original : []
    return draft.map((item, index) => restoreJsonValue(item, source[index], role))
  }
  if (!draft || typeof draft !== 'object') return draft
  const source = original && typeof original === 'object' && !Array.isArray(original)
    ? original as JsonObject
    : {}
  return Object.fromEntries(Object.entries(draft).map(([key, value]) => [
    key,
    restoreJsonValue(value, source[key], role),
  ]))
}

function restoreDotenv(draft: string, original: string): string {
  const originals = new Map<string, string[]>()
  for (const line of original.split(/\r?\n/)) {
    const match = dotenvAssignment.exec(line)
    if (!match) continue
    const values = originals.get(match[2]) ?? []
    values.push(match[3])
    originals.set(match[2], values)
  }
  const occurrence = new Map<string, number>()
  return draft.split(/(\r?\n)/).map((part) => {
    if (part === '\n' || part === '\r\n') return part
    const match = dotenvAssignment.exec(part)
    if (!match || !isProtectedDotenvValue(match[3])) return part
    const index = occurrence.get(match[2]) ?? 0
    occurrence.set(match[2], index + 1)
    const originalValue = originals.get(match[2])?.[index]
    if (originalValue === undefined) throw new ClientConfigValidationError('A protected environment value no longer exists')
    return `${match[1]}${originalValue}`
  }).join('')
}

function isProtectedDotenvValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === protectedValuePlaceholder || trimmed === JSON.stringify(protectedValuePlaceholder)
}
