import { ClientConfigParseError, type ClientConfigFileRole } from './types'

export type JsonObject = Record<string, unknown>

export interface TextMutation {
  content: string
  changed: boolean
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formattingOf(content: string | undefined) {
  const eol = content?.includes('\r\n') ? '\r\n' : '\n'
  const indentation = content?.match(/\r?\n([ \t]+)"/)?.[1] ?? '  '
  const trailingNewline = content === undefined || /\r?\n$/.test(content)
  return { eol, indentation, trailingNewline }
}

export function stringifyJsonObject(root: JsonObject, content?: string): string {
  const formatting = formattingOf(content)
  let next = JSON.stringify(root, null, formatting.indentation)
  if (formatting.eol === '\r\n') next = next.replace(/\n/g, '\r\n')
  if (formatting.trailingNewline) next += formatting.eol
  return next
}

export function parseJsonObject(content: string | undefined, role: ClientConfigFileRole): JsonObject {
  if (content === undefined || content.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isObject(parsed)) throw new ClientConfigParseError(role, 'root value must be an object')
    return parsed
  } catch (error) {
    if (error instanceof ClientConfigParseError) throw error
    throw new ClientConfigParseError(role, error instanceof Error ? error.message : 'invalid JSON')
  }
}

export function objectField(parent: JsonObject, key: string, role: ClientConfigFileRole): JsonObject {
  const current = parent[key]
  if (current === undefined) {
    const created: JsonObject = {}
    parent[key] = created
    return created
  }
  if (!isObject(current)) throw new ClientConfigParseError(role, `field ${key} must be an object`)
  return current
}

export function mutateJsonObject(
  content: string | undefined,
  role: ClientConfigFileRole,
  mutate: (root: JsonObject) => void,
): TextMutation {
  const root = parseJsonObject(content, role)
  const before = JSON.stringify(root)
  mutate(root)
  if (before === JSON.stringify(root) && content !== undefined) return { content, changed: false }

  const next = stringifyJsonObject(root, content)
  return { content: next, changed: next !== content }
}
