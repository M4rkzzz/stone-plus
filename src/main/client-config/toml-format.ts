import { parse, stringify, TomlError } from 'smol-toml'
import type { TextMutation } from './json-format'
import { ClientConfigParseError } from './types'

export type TomlValue = string | boolean | number | string[]

interface TomlAssignment {
  key: string
  value: TomlValue
}

interface TomlStatement {
  start: number
  end: number
  kind: 'assignment' | 'header' | 'other'
  path?: string[]
}

interface ScannerState {
  bracketDepth: number
  multilineQuote?: 'basic' | 'literal'
}

const probeValue = '__stone_toml_probe_6f2b11c2__'

function tomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

export function parseCodexToml(content: string): Record<string, unknown> {
  try {
    return parse(content) as Record<string, unknown>
  } catch (error) {
    const detail = error instanceof TomlError
      ? `syntax error at line ${error.line}, column ${error.column}`
      : 'invalid TOML'
    throw new ClientConfigParseError('codex-config', detail)
  }
}

/** Locate an exact TOML assignment, including quoted tables and dotted keys. */
export function locateCodexTomlPath(
  content: string,
  path: readonly string[],
): { startLine: number; endLine: number } | undefined {
  if (!path.length) return undefined
  try {
    parseCodexToml(content)
  } catch {
    return undefined
  }
  const lines = content.split(/\r?\n/)
  const statement = locatedAssignments(lines).find((candidate) => samePath(candidate.absolutePath, [...path]))
  return statement ? { startLine: statement.start + 1, endLine: statement.end + 1 } : undefined
}

function findProbePath(value: unknown, path: string[] = []): string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  for (const [key, child] of Object.entries(value)) {
    if (child === probeValue) return [...path, key]
    const nested = findProbePath(child, [...path, key])
    if (nested) return nested
  }
  return undefined
}

function assignmentEqualsIndex(line: string): number {
  let quote: 'basic' | 'literal' | undefined
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote === 'basic' && escaped) {
      escaped = false
      continue
    }
    if (quote === 'basic' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' && quote !== 'literal') quote = quote === 'basic' ? undefined : 'basic'
    else if (character === "'" && quote !== 'basic') quote = quote === 'literal' ? undefined : 'literal'
    else if (character === '=' && quote === undefined) return index
  }
  return -1
}

function assignmentPath(line: string): string[] | undefined {
  const equalsIndex = assignmentEqualsIndex(line)
  if (equalsIndex < 0) return undefined

  const key = line.slice(0, equalsIndex).trim()
  if (!key) return undefined
  try {
    return findProbePath(parse(`${key} = ${JSON.stringify(probeValue)}`))
  } catch {
    return undefined
  }
}

function headerPath(line: string): string[] | undefined {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return undefined
  try {
    const path = findProbePath(parse(`${line}\n${JSON.stringify(probeValue)} = ${JSON.stringify(probeValue)}`))
    return path?.slice(0, -1)
  } catch {
    return undefined
  }
}

function scanLine(line: string, state: ScannerState): void {
  let quote: 'basic' | 'literal' | undefined
  let escaped = false

  for (let index = 0; index < line.length;) {
    if (state.multilineQuote === 'basic') {
      if (line.startsWith('"""', index)) {
        let backslashes = 0
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1
        if (backslashes % 2 === 0) {
          state.multilineQuote = undefined
          index += 3
          continue
        }
      }
      index += 1
      continue
    }
    if (state.multilineQuote === 'literal') {
      if (line.startsWith("'''", index)) {
        state.multilineQuote = undefined
        index += 3
        continue
      }
      index += 1
      continue
    }

    const character = line[index]
    if (quote === 'basic' && escaped) {
      escaped = false
      index += 1
      continue
    }
    if (quote === 'basic' && character === '\\') {
      escaped = true
      index += 1
      continue
    }
    if (quote === undefined && line.startsWith('"""', index)) {
      state.multilineQuote = 'basic'
      index += 3
      continue
    }
    if (quote === undefined && line.startsWith("'''", index)) {
      state.multilineQuote = 'literal'
      index += 3
      continue
    }
    if (character === '"' && quote !== 'literal') {
      quote = quote === 'basic' ? undefined : 'basic'
      index += 1
      continue
    }
    if (character === "'" && quote !== 'basic') {
      quote = quote === 'literal' ? undefined : 'literal'
      index += 1
      continue
    }
    if (quote === undefined && character === '#') break
    if (quote === undefined && (character === '[' || character === '{')) state.bracketDepth += 1
    else if (quote === undefined && (character === ']' || character === '}')) state.bracketDepth -= 1
    index += 1
  }
}

function statementKind(line: string): Pick<TomlStatement, 'kind' | 'path'> {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('[')) return { kind: 'header', path: headerPath(line) }
  const path = assignmentPath(line)
  return path ? { kind: 'assignment', path } : { kind: 'other' }
}

function analyzeStatements(lines: string[]): TomlStatement[] {
  const statements: TomlStatement[] = []
  const state: ScannerState = { bracketDepth: 0 }
  let statementStart: number | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const startsAtTopLevel = state.multilineQuote === undefined && state.bracketDepth === 0
    if (statementStart === undefined && startsAtTopLevel && !/^\s*(?:#.*)?$/.test(lines[index])) {
      statementStart = index
    }
    scanLine(lines[index], state)
    if (statementStart !== undefined && state.multilineQuote === undefined && state.bracketDepth === 0) {
      statements.push({ start: statementStart, end: index, ...statementKind(lines[statementStart]) })
      statementStart = undefined
    }
  }
  return statements
}

function samePath(left: string[] | undefined, right: string[]): boolean {
  return left?.length === right.length && left.every((part, index) => part === right[index])
}

interface LocatedAssignment extends TomlStatement {
  absolutePath: string[]
}

function locatedAssignments(lines: string[]): LocatedAssignment[] {
  let tablePath: string[] = []
  const result: LocatedAssignment[] = []
  for (const statement of analyzeStatements(lines)) {
    if (statement.kind === 'header' && statement.path) {
      tablePath = statement.path
      continue
    }
    if (statement.kind === 'assignment' && statement.path) {
      result.push({ ...statement, absolutePath: [...tablePath, ...statement.path] })
    }
  }
  return result
}

function tomlKeyPart(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function setTopLevelPath(lines: string[], path: string[], value: TomlValue): void {
  const statements = analyzeStatements(lines)
  const firstHeader = statements.find((statement) => statement.kind === 'header')?.start ?? lines.length
  const separator = firstHeader < lines.length && firstHeader > 0 && lines[firstHeader - 1] !== '' ? [''] : []
  lines.splice(firstHeader, 0, `${path.map(tomlKeyPart).join('.')} = ${tomlValue(value)}`, ...separator)
}

function inlineTableValueBounds(statement: string): { open: number; close: number } | undefined {
  const equalsIndex = assignmentEqualsIndex(statement)
  if (equalsIndex < 0) return undefined
  const open = statement.indexOf('{', equalsIndex + 1)
  if (open < 0 || statement.slice(equalsIndex + 1, open).trim()) return undefined
  let quote: 'basic' | 'literal' | undefined
  let escaped = false
  let depth = 0
  for (let index = open; index < statement.length; index += 1) {
    const character = statement[index]
    if (quote === 'basic' && escaped) {
      escaped = false
      continue
    }
    if (quote === 'basic' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' && quote !== 'literal') {
      quote = quote === 'basic' ? undefined : 'basic'
      continue
    }
    if (character === "'" && quote !== 'basic') {
      quote = quote === 'literal' ? undefined : 'literal'
      continue
    }
    if (quote !== undefined) continue
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return { open, close: index }
  }
  return undefined
}

function inlineTableChildRange(inner: string, key: string): { start: number; end: number } | undefined {
  let quote: 'basic' | 'literal' | undefined
  let escaped = false
  let depth = 0
  let start = 0
  const consider = (end: number) => samePath(assignmentPath(inner.slice(start, end)), [key])
    ? { start, end }
    : undefined
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (quote === 'basic' && escaped) {
      escaped = false
      continue
    }
    if (quote === 'basic' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' && quote !== 'literal') {
      quote = quote === 'basic' ? undefined : 'basic'
      continue
    }
    if (character === "'" && quote !== 'basic') {
      quote = quote === 'literal' ? undefined : 'literal'
      continue
    }
    if (quote !== undefined) continue
    if (character === '[' || character === '{') depth += 1
    else if (character === ']' || character === '}') depth -= 1
    else if (character === ',' && depth === 0) {
      const range = consider(index)
      if (range) return range
      start = index + 1
    }
  }
  return consider(inner.length)
}

function setInlineTableChild(lines: string[], parent: string, key: string, value: TomlValue): boolean {
  const assignment = locatedAssignments(lines)
    .find((statement) => samePath(statement.absolutePath, [parent]))
  if (!assignment) return false
  const statement = lines.slice(assignment.start, assignment.end + 1).join('\n')
  const bounds = inlineTableValueBounds(statement)
  if (!bounds) return false
  const inner = statement.slice(bounds.open + 1, bounds.close)
  const child = inlineTableChildRange(inner, key)
  let nextInner: string
  if (child) {
    const segment = inner.slice(child.start, child.end)
    nextInner = inner.slice(0, child.start) + replaceValue(segment, value) + inner.slice(child.end)
  } else {
    const trailingWhitespace = inner.match(/\s*$/)?.[0] ?? ''
    const body = inner.slice(0, inner.length - trailingWhitespace.length)
    const separator = body.trim() && !body.trimEnd().endsWith(',') ? ', ' : body.trim() ? ' ' : ''
    nextInner = `${body}${separator}${tomlKeyPart(key)} = ${tomlValue(value)}${trailingWhitespace}`
  }
  const nextStatement = statement.slice(0, bounds.open + 1)
    + nextInner
    + statement.slice(bounds.close)
  lines.splice(assignment.start, assignment.end - assignment.start + 1, ...nextStatement.split('\n'))
  return true
}

function setPath(lines: string[], path: string[], value: TomlValue): void {
  const existing = locatedAssignments(lines).find((statement) => samePath(statement.absolutePath, path))
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start + 1, replaceValue(lines[existing.start], value))
    return
  }
  if (path.length === 1) {
    setTopLevel(lines, { key: path[0], value })
    return
  }
  if (path.length === 2 && setInlineTableChild(lines, path[0], path[1], value)) return
  const parent = path.slice(0, -1)
  if (sectionBounds(lines, parent)) {
    setSection(lines, parent, [{ key: path.at(-1)!, value }])
    return
  }
  // A dotted root assignment remains valid alongside later child tables and avoids
  // redefining a table that another dotted assignment has already created.
  setTopLevelPath(lines, path, value)
}

function removePath(lines: string[], path: string[]): void {
  const existing = locatedAssignments(lines).find((statement) => samePath(statement.absolutePath, path))
  if (existing) lines.splice(existing.start, existing.end - existing.start + 1)
}

function replaceValue(line: string, value: TomlValue): string {
  const equalsIndex = assignmentEqualsIndex(line)
  if (equalsIndex < 0) return line
  const prefix = line.slice(0, equalsIndex + 1)
  const remainder = line.slice(equalsIndex + 1)
  const leadingWhitespace = remainder.match(/^\s*/)?.[0] ?? ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  let commentIndex = -1
  for (let index = leadingWhitespace.length; index < remainder.length; index += 1) {
    const character = remainder[index]
    if (quote === 'double' && escaped) {
      escaped = false
      continue
    }
    if (quote === 'double' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' && quote !== 'single') quote = quote === 'double' ? undefined : 'double'
    else if (character === "'" && quote !== 'double') quote = quote === 'single' ? undefined : 'single'
    else if (character === '#' && quote === undefined) {
      commentIndex = index
      break
    }
  }
  const valueEnd = commentIndex >= 0 ? commentIndex : remainder.length
  const trailingWhitespace = remainder.slice(leadingWhitespace.length, valueEnd).match(/\s*$/)?.[0] ?? ''
  const comment = commentIndex >= 0 ? remainder.slice(commentIndex) : ''
  return `${prefix}${leadingWhitespace}${tomlValue(value)}${trailingWhitespace}${comment}`
}

function setTopLevel(lines: string[], assignment: TomlAssignment): void {
  const statements = analyzeStatements(lines)
  const firstHeader = statements.find((statement) => statement.kind === 'header')?.start ?? lines.length
  const existing = statements.find((statement) => (
    statement.kind === 'assignment'
    && statement.start < firstHeader
    && samePath(statement.path, [assignment.key])
  ))
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start + 1, replaceValue(lines[existing.start], assignment.value))
    return
  }

  const separator = firstHeader < lines.length && firstHeader > 0 && lines[firstHeader - 1] !== '' ? [''] : []
  lines.splice(firstHeader, 0, `${assignment.key} = ${tomlValue(assignment.value)}`, ...separator)
}

function sectionBounds(lines: string[], name: string[]): { start: number, end: number } | undefined {
  const statements = analyzeStatements(lines)
  const headerIndex = statements.findIndex((statement) => statement.kind === 'header' && samePath(statement.path, name))
  if (headerIndex < 0) return undefined
  const header = statements[headerIndex]
  const nextHeader = statements.slice(headerIndex + 1).find((statement) => statement.kind === 'header')
  return { start: header.end + 1, end: nextHeader?.start ?? lines.length }
}

function setSection(
  lines: string[],
  name: string[],
  assignments: TomlAssignment[],
  removedKeys: ReadonlySet<string> = new Set(),
): void {
  const initialBounds = sectionBounds(lines, name)
  if (!initialBounds) {
    if (lines.length && lines.at(-1) !== '') lines.push('')
    lines.push(`[${name.join('.')}]`, ...assignments.map(({ key, value }) => `${key} = ${tomlValue(value)}`))
    return
  }

  const desired = new Map(assignments.map((assignment) => [assignment.key, assignment]))
  const found = new Set<string>()
  const statements = analyzeStatements(lines)
    .filter((statement) => (
      statement.start >= initialBounds.start
      && statement.end < initialBounds.end
      && statement.kind === 'assignment'
    ))
    .sort((left, right) => right.start - left.start)

  for (const statement of statements) {
    if (statement.path?.length !== 1) continue
    const key = statement.path[0]
    if (removedKeys.has(key)) {
      lines.splice(statement.start, statement.end - statement.start + 1)
      continue
    }
    const assignment = desired.get(key)
    if (!assignment) continue
    lines.splice(
      statement.start,
      statement.end - statement.start + 1,
      replaceValue(lines[statement.start], assignment.value),
    )
    found.add(key)
  }

  const missing = assignments.filter((assignment) => !found.has(assignment.key))
  if (!missing.length) return
  const bounds = sectionBounds(lines, name)
  if (!bounds) throw new ClientConfigParseError('codex-config', `section ${name.join('.')} disappeared while patching`)
  lines.splice(bounds.end, 0, ...missing.map(({ key, value }) => `${key} = ${tomlValue(value)}`))
}

export function planCodexToml(content: string | undefined, baseUrl: string): TextMutation {
  const source = content ?? ''
  parseCodexToml(source)

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = content === undefined || /\r?\n$/.test(source)
  const lines = source === '' ? [] : source.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  setTopLevel(lines, { key: 'model_provider', value: 'stone' })
  setTopLevel(lines, { key: 'cli_auth_credentials_store', value: 'file' })
  // Stone+ implements the portable Legacy compact endpoint for relay pools.
  // V2 requires an opaque native compaction item and cannot be safely
  // synthesized by a transparent gateway.
  setPath(lines, ['features', 'remote_compaction_v2'], false)
  setSection(lines, ['model_providers', 'stone'], [
    { key: 'name', value: 'OpenAI' },
    { key: 'base_url', value: baseUrl },
    { key: 'wire_api', value: 'responses' },
    { key: 'requires_openai_auth', value: true },
  ], new Set(['env_key']))

  let next = lines.join(eol)
  if (trailingNewline) next += eol
  parseCodexToml(next)
  return { content: next, changed: next !== content }
}

/**
 * Repair the Stone provider even when a syntactically valid document used an
 * incompatible TOML shape for one of Stone+'s owned paths. The normal
 * format-preserving patch is always preferred. Re-serialization is a fallback
 * only for that structural conflict and retains all unrelated parsed values.
 * A genuinely malformed TOML document still throws so the service can back it
 * up and rebuild a minimal document.
 */
export function repairCodexToml(content: string | undefined, baseUrl: string): TextMutation {
  try {
    return planCodexToml(content, baseUrl)
  } catch (patchError) {
    const source = content ?? ''
    // This second parse deliberately distinguishes invalid syntax from a valid
    // document whose managed fields merely have an incompatible value shape.
    const root = parseCodexToml(source)
    root.model_provider = 'stone'
    root.cli_auth_credentials_store = 'file'

    const features = tomlObject(root.features) ?? {}
    root.features = features
    features.remote_compaction_v2 = false

    const providers = tomlObject(root.model_providers) ?? {}
    root.model_providers = providers
    const stone = tomlObject(providers.stone) ?? {}
    providers.stone = stone
    stone.name = 'OpenAI'
    stone.base_url = baseUrl
    stone.wire_api = 'responses'
    stone.requires_openai_auth = true
    delete stone.env_key

    try {
      let next = stringify(root)
      if (source.includes('\r\n')) next = next.replace(/\n/g, '\r\n')
      if (content !== undefined && !/\r?\n$/.test(source)) next = next.replace(/\r?\n$/, '')
      parseCodexToml(next)
      return { content: next, changed: next !== content }
    } catch (error) {
      // Preserve the original, redacted parse/patch failure contract rather
      // than leaking arbitrary values through a serializer exception.
      if (patchError instanceof ClientConfigParseError) throw patchError
      throw error
    }
  }
}

function tomlObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function patchCodexTomlTopLevel(
  content: string | undefined,
  patches: Readonly<Record<string, TomlValue | null>>,
): TextMutation {
  return patchCodexTomlPaths(content, Object.entries(patches).map(([key, value]) => ({
    path: [key],
    value,
  })))
}

export function patchCodexTomlPaths(
  content: string | undefined,
  patches: ReadonlyArray<{ path: string[]; value: TomlValue | null }>,
): TextMutation {
  const source = content ?? ''
  parseCodexToml(source)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = content === undefined || /\r?\n$/.test(source)
  const lines = source === '' ? [] : source.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const submitted = new Set<string>()
  for (const patch of patches) {
    if (!patch.path.length) throw new ClientConfigParseError('codex-config', 'an empty setting path cannot be patched')
    const identity = JSON.stringify(patch.path)
    if (submitted.has(identity)) throw new ClientConfigParseError('codex-config', 'a setting path was patched more than once')
    submitted.add(identity)
    if (patch.value === null) removePath(lines, patch.path)
    else setPath(lines, patch.path, patch.value)
  }
  let next = lines.join(eol)
  if (trailingNewline && next !== '') next += eol
  parseCodexToml(next)
  return { content: next, changed: next !== content }
}
