import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { ClientConnectionTarget } from '../client-config'
import { atomicWriteFile, readTextIfPresent } from '../client-config/filesystem'

export type ClaudeVscodeChannel = 'stable' | 'insiders'

export interface ClaudeVscodeConfigOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  environment?: NodeJS.ProcessEnv
  randomId?: () => string
}

export interface ClaudeVscodeSettingsPathOptions extends ClaudeVscodeConfigOptions {
  channel?: ClaudeVscodeChannel
}

export interface ClaudeVscodeConfigurationRepair {
  readonly changed: boolean
  rollback(): Promise<void>
}

interface JsoncProperty {
  key: string
  keyStart: number
  valueStart: number
  valueEnd: number
}

interface JsoncRootObject {
  closeIndex: number
  properties: JsoncProperty[]
}

interface ManagedSettings {
  environmentVariables: unknown[]
  disableLoginPrompt: boolean
}

const environmentSetting = 'claudeCode.environmentVariables'
const disableLoginPromptSetting = 'claudeCode.disableLoginPrompt'
const managedEnvironmentNames = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'])

/**
 * Resolves the user-level settings file for the selected VS Code channel.
 * Workspace settings are deliberately excluded because writing a gateway
 * token into a repository would expose a credential and affect other users.
 */
export function resolveClaudeVscodeSettingsPath(options: ClaudeVscodeSettingsPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  const channelDirectory = options.channel === 'insiders' ? 'Code - Insiders' : 'Code'

  if (platform === 'win32') {
    const roaming = absoluteEnvironmentPath(environment.APPDATA, 'win32')
      ?? win32.join(homeDir, 'AppData', 'Roaming')
    return win32.join(roaming, channelDirectory, 'User', 'settings.json')
  }
  if (platform === 'darwin') {
    return posix.join(homeDir, 'Library', 'Application Support', channelDirectory, 'User', 'settings.json')
  }
  const configHome = absoluteEnvironmentPath(environment.XDG_CONFIG_HOME, platform)
    ?? posix.join(homeDir, '.config')
  return posix.join(configHome, channelDirectory, 'User', 'settings.json')
}

/**
 * Owns only the two VS Code settings required by the Claude Code extension to
 * use Stone+. It keeps unrelated JSONC fields and top-level comments intact,
 * writes atomically, and exposes rollback as an opaque closure so credentials
 * never appear in a result object.
 */
export class ClaudeVscodeConfig {
  private readonly platform: NodeJS.Platform
  private readonly homeDir: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly randomId: () => string
  private pendingOperation: Promise<unknown> = Promise.resolve()

  constructor(options: ClaudeVscodeConfigOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.homeDir = options.homeDir ?? homedir()
    this.environment = options.environment ?? process.env
    this.randomId = options.randomId ?? randomUUID
  }

  async inspect(target: ClientConnectionTarget, launchTarget?: string): Promise<boolean> {
    const normalizedTarget = validateConnectionTarget(target)
    const path = this.settingsPath(launchTarget)
    const source = await readTextIfPresent(path)
    if (source === undefined) return false
    try {
      return managedSettingsMatch(source, normalizedTarget)
    } catch {
      return false
    }
  }

  async repair(
    target: ClientConnectionTarget,
    launchTarget?: string,
  ): Promise<ClaudeVscodeConfigurationRepair> {
    const normalizedTarget = validateConnectionTarget(target)
    return this.runExclusive(async () => {
      const path = this.settingsPath(launchTarget)
      const previous = await readTextIfPresent(path)
      const source = previous ?? '{}\n'
      let repaired: string
      try {
        repaired = renderManagedSettings(source, normalizedTarget)
      } catch (cause) {
        throw safeConfigurationError('Claude Code VSC user settings are not valid JSONC.', cause)
      }

      if (repaired === source && previous !== undefined) return noChangeRepair()

      try {
        await atomicWriteFile(path, repaired, this.randomId, true)
      } catch (cause) {
        throw safeConfigurationError('Claude Code VSC user settings could not be updated.', cause)
      }

      let rollbackPending = true
      return {
        changed: true,
        rollback: async () => {
          if (!rollbackPending) return
          await this.runExclusive(async () => {
            if (!rollbackPending) return
            const current = await readTextIfPresent(path)
            if (current !== repaired) {
              throw new Error('Claude Code VSC user settings changed after repair; rollback was not applied.')
            }
            try {
              if (previous === undefined) await rm(path, { force: true })
              else await atomicWriteFile(path, previous, this.randomId, true)
            } catch (cause) {
              throw safeConfigurationError('Claude Code VSC user settings rollback failed.', cause)
            }
            rollbackPending = false
          })
        },
      }
    })
  }

  async validate(target: ClientConnectionTarget, launchTarget?: string): Promise<void> {
    if (!await this.inspect(target, launchTarget)) {
      throw new Error('Claude Code VSC user settings are not configured for Stone+.')
    }
  }

  settingsPath(launchTarget?: string): string {
    return resolveClaudeVscodeSettingsPath({
      platform: this.platform,
      homeDir: this.homeDir,
      environment: this.environment,
      channel: channelFromLaunchTarget(launchTarget),
    })
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation)
    this.pendingOperation = result.then(() => undefined, () => undefined)
    return result
  }
}

function noChangeRepair(): ClaudeVscodeConfigurationRepair {
  return { changed: false, rollback: async () => undefined }
}

function channelFromLaunchTarget(launchTarget?: string): ClaudeVscodeChannel {
  const normalized = launchTarget?.trim().toLowerCase() ?? ''
  return normalized.startsWith('vscode-insiders:')
    || normalized.includes('code - insiders')
    || /(?:^|[\\/])code-insiders(?:\.exe)?$/.test(normalized)
    ? 'insiders'
    : 'stable'
}

function absoluteEnvironmentPath(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.isAbsolute(candidate) ? candidate : undefined
}

function validateConnectionTarget(target: ClientConnectionTarget): ClientConnectionTarget {
  const gatewayBaseUrl = target.gatewayBaseUrl.trim()
  if (!gatewayBaseUrl || !target.token) throw new Error('A Stone+ gateway URL and access token are required.')
  let parsed: URL
  try {
    parsed = new URL(gatewayBaseUrl)
  } catch {
    throw new Error('The Stone+ gateway URL is invalid.')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The Stone+ gateway URL is invalid.')
  }
  return { gatewayBaseUrl, token: target.token }
}

function managedSettingsMatch(source: string, target: ClientConnectionTarget): boolean {
  const settings = readManagedSettings(source)
  if (!settings.disableLoginPrompt) return false
  const managed = settings.environmentVariables.filter(isManagedEnvironmentVariable)
  if (managed.length !== 2) return false
  return managed.some((entry) => entry.name === 'ANTHROPIC_BASE_URL' && entry.value === target.gatewayBaseUrl)
    && managed.some((entry) => entry.name === 'ANTHROPIC_AUTH_TOKEN' && entry.value === target.token)
}

function renderManagedSettings(source: string, target: ClientConnectionTarget): string {
  const settings = readManagedSettings(source)
  const environmentVariables = settings.environmentVariables
    .filter((entry) => !isManagedEnvironmentVariable(entry))
  environmentVariables.push(
    { name: 'ANTHROPIC_BASE_URL', value: target.gatewayBaseUrl },
    { name: 'ANTHROPIC_AUTH_TOKEN', value: target.token },
  )

  let rendered = setTopLevelProperty(source, environmentSetting, environmentVariables)
  rendered = setTopLevelProperty(rendered, disableLoginPromptSetting, true)
  return rendered
}

function readManagedSettings(source: string): ManagedSettings {
  const root = scanRootObject(source)
  const environmentProperty = uniqueProperty(root, environmentSetting)
  const disableProperty = uniqueProperty(root, disableLoginPromptSetting)
  let environmentVariables: unknown[] = []
  if (environmentProperty) {
    const parsed = parseJsoncValue(source.slice(environmentProperty.valueStart, environmentProperty.valueEnd))
    if (!Array.isArray(parsed)) throw new Error(`${environmentSetting} must be an array.`)
    environmentVariables = parsed
  }
  const disableLoginPrompt = disableProperty
    ? parseJsoncValue(source.slice(disableProperty.valueStart, disableProperty.valueEnd)) === true
    : false
  return { environmentVariables, disableLoginPrompt }
}

function isManagedEnvironmentVariable(value: unknown): value is { name: string; value: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.name === 'string' && managedEnvironmentNames.has(candidate.name)
}

function uniqueProperty(root: JsoncRootObject, key: string): JsoncProperty | undefined {
  const matches = root.properties.filter((property) => property.key === key)
  if (matches.length > 1) throw new Error(`Duplicate ${key} settings are not safe to edit.`)
  return matches[0]
}

function setTopLevelProperty(source: string, key: string, value: unknown): string {
  const root = scanRootObject(source)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const existing = uniqueProperty(root, key)
  if (existing) {
    const propertyIndent = indentationAt(source, existing.keyStart)
    const replacement = formatJsonValue(value, propertyIndent, newline)
    if (source.slice(existing.valueStart, existing.valueEnd) === replacement) return source
    return source.slice(0, existing.valueStart) + replacement + source.slice(existing.valueEnd)
  }

  const propertyIndent = inferPropertyIndent(source, root)
  const property = `${propertyIndent}${JSON.stringify(key)}: ${formatJsonValue(value, propertyIndent, newline)}`
  const closeLineStart = lineStart(source, root.closeIndex)
  const closeLinePrefix = source.slice(closeLineStart, root.closeIndex)
  const insertionIndex = /^\s*$/.test(closeLinePrefix) ? closeLineStart : root.closeIndex
  const leadingNewline = insertionIndex > 0 && !endsWithLineBreak(source.slice(0, insertionIndex)) ? newline : ''
  const trailingNewline = newline
  const insertion = `${leadingNewline}${property}${trailingNewline}`

  const lastProperty = root.properties.at(-1)
  let commaInsertion = ''
  let commaIndex = -1
  if (lastProperty && !hasCommaAfterValue(source, lastProperty.valueEnd, root.closeIndex)) {
    commaIndex = lastProperty.valueEnd
    commaInsertion = ','
  }

  const edits = [
    { index: insertionIndex, text: insertion },
    ...(commaIndex >= 0 ? [{ index: commaIndex, text: commaInsertion }] : []),
  ].sort((left, right) => right.index - left.index)
  return edits.reduce((content, edit) => content.slice(0, edit.index) + edit.text + content.slice(edit.index), source)
}

function hasCommaAfterValue(source: string, valueEnd: number, closeIndex: number): boolean {
  const next = skipTrivia(source, valueEnd)
  return next < closeIndex && source[next] === ','
}

function formatJsonValue(value: unknown, propertyIndent: string, newline: string): string {
  const serialized = JSON.stringify(value, null, 2)
  if (serialized === undefined) throw new Error('The managed VS Code setting cannot be serialized.')
  return serialized.split('\n').map((line, index) => index === 0 ? line : propertyIndent + line).join(newline)
}

function inferPropertyIndent(source: string, root: JsoncRootObject): string {
  const first = root.properties[0]
  if (!first) return '  '
  const indent = indentationAt(source, first.keyStart)
  return indent || '  '
}

function indentationAt(source: string, index: number): string {
  const start = lineStart(source, index)
  const prefix = source.slice(start, index)
  return /^\s*$/.test(prefix) ? prefix : '  '
}

function lineStart(source: string, index: number): number {
  const previousNewline = source.lastIndexOf('\n', Math.max(0, index - 1))
  return previousNewline < 0 ? 0 : previousNewline + 1
}

function endsWithLineBreak(value: string): boolean {
  return value.endsWith('\n') || value.endsWith('\r')
}

function scanRootObject(source: string): JsoncRootObject {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0
  index = skipTrivia(source, index)
  if (source[index] !== '{') throw new Error('The settings document must be a JSON object.')
  index += 1
  const properties: JsoncProperty[] = []

  while (index < source.length) {
    index = skipTrivia(source, index)
    if (source[index] === '}') {
      const closeIndex = index
      index = skipTrivia(source, index + 1)
      if (index !== source.length) throw new Error('Unexpected content after the settings object.')
      return { closeIndex, properties }
    }
    if (source[index] !== '"') throw new Error('JSONC property names must be quoted strings.')
    const keyStart = index
    const keyEnd = scanString(source, index)
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as unknown
    if (typeof key !== 'string') throw new Error('Invalid JSONC property name.')
    index = skipTrivia(source, keyEnd)
    if (source[index] !== ':') throw new Error('Expected a colon after the JSONC property name.')
    index = skipTrivia(source, index + 1)
    const valueStart = index
    const valueEnd = scanValue(source, valueStart)
    properties.push({ key, keyStart, valueStart, valueEnd })
    index = skipTrivia(source, valueEnd)
    if (source[index] === ',') {
      index += 1
      continue
    }
    if (source[index] !== '}') throw new Error('Expected a comma or closing brace in the settings object.')
  }
  throw new Error('The settings object is not closed.')
}

function scanValue(source: string, index: number): number {
  const first = source[index]
  if (first === '"') return scanString(source, index)
  if (first === '{' || first === '[') return scanContainer(source, index)
  if (first === undefined || first === ',' || first === '}') throw new Error('Missing JSONC property value.')

  let cursor = index
  while (cursor < source.length) {
    const character = source[cursor]
    if (/\s/.test(character) || character === ',' || character === '}') break
    if (character === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) break
    cursor += 1
  }
  if (cursor === index) throw new Error('Missing JSONC property value.')
  parseJsoncValue(source.slice(index, cursor))
  return cursor
}

function scanContainer(source: string, index: number): number {
  const stack = [source[index]]
  let cursor = index + 1
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '"') {
      cursor = scanString(source, cursor)
      continue
    }
    if (character === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor + 2)
      continue
    }
    if (character === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor + 2)
      continue
    }
    if (character === '{' || character === '[') stack.push(character)
    if (character === '}' || character === ']') {
      const opening = stack.pop()
      if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) {
        throw new Error('Mismatched JSONC container delimiter.')
      }
      if (stack.length === 0) return cursor + 1
    }
    cursor += 1
  }
  throw new Error('The JSONC value is not closed.')
}

function scanString(source: string, index: number): number {
  let cursor = index + 1
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '\\') {
      cursor += 2
      continue
    }
    if (character === '"') return cursor + 1
    if (character === '\n' || character === '\r') throw new Error('Unterminated JSONC string.')
    cursor += 1
  }
  throw new Error('Unterminated JSONC string.')
}

function skipTrivia(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor + 2)
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor + 2)
      continue
    }
    break
  }
  return cursor
}

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf('\n', index)
  return newline < 0 ? source.length : newline + 1
}

function skipBlockComment(source: string, index: number): number {
  const end = source.indexOf('*/', index)
  if (end < 0) throw new Error('Unterminated JSONC block comment.')
  return end + 2
}

function parseJsoncValue(source: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsonComments(source))) as unknown
}

function stripJsonComments(source: string): string {
  let result = ''
  let cursor = 0
  while (cursor < source.length) {
    if (source[cursor] === '"') {
      const end = scanString(source, cursor)
      result += source.slice(cursor, end)
      cursor = end
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const end = skipLineComment(source, cursor + 2)
      const comment = source.slice(cursor, end)
      result += comment.replace(/[^\r\n]/g, ' ')
      cursor = end
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const end = skipBlockComment(source, cursor + 2)
      const comment = source.slice(cursor, end)
      result += comment.replace(/[^\r\n]/g, ' ')
      cursor = end
      continue
    }
    result += source[cursor]
    cursor += 1
  }
  return result
}

function removeTrailingCommas(source: string): string {
  let result = ''
  let cursor = 0
  while (cursor < source.length) {
    if (source[cursor] === '"') {
      const end = scanString(source, cursor)
      result += source.slice(cursor, end)
      cursor = end
      continue
    }
    if (source[cursor] === ',') {
      let next = cursor + 1
      while (next < source.length && /\s/.test(source[next])) next += 1
      if (source[next] === '}' || source[next] === ']') {
        cursor += 1
        continue
      }
    }
    result += source[cursor]
    cursor += 1
  }
  return result
}

function safeConfigurationError(message: string, cause: unknown): Error {
  // JSON parser errors can include a source excerpt. Never attach the cause:
  // settings may already contain credentials and callers can safely report
  // only the operation-level message.
  void cause
  return new Error(message)
}
