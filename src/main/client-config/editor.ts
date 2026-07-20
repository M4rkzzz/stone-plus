import { createHmac, randomBytes } from 'node:crypto'
import type { ClientConfigEditorFile } from '@shared/types'
import { parseJsonObject, stringifyJsonObject, type JsonObject } from './json-format'
import { parseCodexToml, patchCodexTomlPaths, type TomlValue } from './toml-format'
import type { ClientConfigFilePath } from './types'
import { ClientConfigValidationError } from './types'

export const protectedValuePlaceholder = '__STONE_PROTECTED_VALUE__'
const dotenvAssignment = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*))(.*)$/
const sensitiveKey = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i
const sensitiveContainer = /^(?:env|headers?|http[_-]?headers?|env[_-]?http[_-]?headers?|request[_-]?headers?)$/i
const knownNonSecretKeys = new Set([
  'cli_auth_credentials_store',
  'mcp_oauth_credentials_store',
  'env_key',
])
const revisionKey = randomBytes(32)

export function isSensitiveConfigPath(path: readonly string[]): boolean {
  return path.some((part) => (
    sensitiveContainer.test(part)
    || (!knownNonSecretKeys.has(part) && sensitiveKey.test(part))
  ))
}

export function createClientConfigEditorFile(
  file: ClientConfigFilePath,
  source: string | undefined,
): ClientConfigEditorFile {
  const revision = revisionOf(source)
  if (file.role === 'codex-auth') {
    return {
      role: file.role,
      path: file.path,
      format: file.format,
      exists: source !== undefined,
      editable: false,
      containsCredential: true,
      revision,
      protectedValueCount: source === undefined ? 0 : 1,
    }
  }
  if (file.role === 'claude-mcp') {
    const projected = projectClaudeMcp(source)
    const protectedDocument = protectJsonDocument(projected, file.role)
    return {
      role: file.role,
      path: file.path,
      format: file.format,
      exists: source !== undefined,
      editable: true,
      containsCredential: true,
      content: protectedDocument.content,
      revision,
      protectedValueCount: protectedDocument.count,
    }
  }
  const initial = source ?? defaultContent(file.format)
  const protectedDocument = file.format === 'json'
    ? protectJsonDocument(initial, file.role)
    : file.format === 'dotenv'
      ? protectDotenv(initial)
      : protectTomlDocument(initial)
  return {
    role: file.role,
    path: file.path,
    format: file.format,
    exists: source !== undefined,
    editable: true,
    containsCredential: file.containsCredential,
    content: protectedDocument.content,
    revision,
    protectedValueCount: protectedDocument.count,
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
  return restoreTomlDocument(draft, original)
}

export function revisionOf(source: string | undefined): string {
  return createHmac('sha256', revisionKey).update(source === undefined ? '\0missing' : `\x01${source}`).digest('hex')
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

function collectSensitiveTomlPaths(
  value: unknown,
  path: string[] = [],
  result: string[][] = [],
): string[][] {
  if (isTomlValue(value)) {
    if (path.length && isSensitiveConfigPath(path)) result.push(path)
    return result
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) collectSensitiveTomlPaths(child, [...path, key], result)
  return result
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

function protectTomlDocument(content: string): { content: string; count: number } {
  const root = parseCodexToml(content)
  const protectedPaths = collectSensitiveTomlPaths(root)
  if (!protectedPaths.length) return { content, count: 0 }
  return {
    content: patchCodexTomlPaths(content, protectedPaths.map((path) => ({
      path,
      value: protectedValuePlaceholder,
    }))).content,
    count: protectedPaths.length,
  }
}

function restoreTomlDocument(draft: string, original: string): string {
  const draftRoot = parseCodexToml(draft)
  const originalRoot = parseCodexToml(original)
  const placeholderPaths = collectTomlPlaceholderPaths(draftRoot)
  if (!placeholderPaths.length) return draft
  return patchCodexTomlPaths(draft, placeholderPaths.map((path) => {
    const value = tomlValueAt(originalRoot, path)
    if (!isTomlValue(value)) {
      throw new ClientConfigValidationError('A protected value in codex-config no longer exists')
    }
    return { path, value }
  })).content
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

function protectJsonDocument(content: string, role: ClientConfigFilePath['role']): { content: string; count: number } {
  const root = parseJsonObject(content, role)
  const protectedDocument = protectJsonValue(root, false)
  if (protectedDocument.count === 0) return { content, count: 0 }
  return {
    content: stringifyJsonObject(protectedDocument.value as JsonObject, content),
    count: protectedDocument.count,
  }
}

function protectJsonValue(value: unknown, protectChildren: boolean): { value: unknown; count: number } {
  if (typeof value === 'string') {
    return protectChildren ? { value: protectedValuePlaceholder, count: 1 } : { value, count: 0 }
  }
  if (Array.isArray(value)) {
    let count = 0
    const next = value.map((item) => {
      const protectedItem = protectJsonValue(item, protectChildren)
      count += protectedItem.count
      return protectedItem.value
    })
    return { value: next, count }
  }
  if (!value || typeof value !== 'object') return { value, count: 0 }
  let count = 0
  const next: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    const protectedChild = protectJsonValue(
      child,
      protectChildren || sensitiveContainer.test(key) || sensitiveKey.test(key),
    )
    count += protectedChild.count
    next[key] = protectedChild.value
  }
  return { value: next, count }
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

function protectDotenv(content: string): { content: string; count: number } {
  let count = 0
  const next = content.split(/(\r?\n)/).map((part) => {
    if (part === '\n' || part === '\r\n') return part
    const match = dotenvAssignment.exec(part)
    if (!match) return part
    count += 1
    return `${match[1]}${JSON.stringify(protectedValuePlaceholder)}`
  }).join('')
  return { content: next, count }
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
