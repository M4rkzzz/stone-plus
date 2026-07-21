import type { TextMutation } from './json-format'
import { ClientConfigParseError, type ClientConfigFileRole } from './types'

const assignmentPattern = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/

/**
 * Validate the dotenv grammar that StonePlus can safely preserve and patch.
 * Blank lines, comments, exported assignments and multiline quoted values are
 * accepted. A non-assignment line is treated as damage instead of being copied
 * into a freshly repaired client configuration.
 */
export function validateDotenv(
  content: string | undefined,
  role: ClientConfigFileRole = 'gemini-env',
): void {
  if (content === undefined || content === '') return
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  let openQuote: '"' | "'" | undefined

  for (const line of lines) {
    if (openQuote) {
      if (closesQuotedValue(line, openQuote)) openQuote = undefined
      continue
    }

    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = assignmentPattern.exec(line)
    if (!match) throw new ClientConfigParseError(role, 'invalid dotenv assignment')

    const value = match[5].trimStart()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && !closesQuotedValue(value.slice(1), quote)) {
      openQuote = quote
    }
  }

  if (openQuote) throw new ClientConfigParseError(role, 'unterminated quoted dotenv value')
}

function closesQuotedValue(value: string, quote: '"' | "'"): boolean {
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (character === quote && !escaped) return true
    escaped = false
  }
  return false
}

function quoteDotenv(value: string): string {
  return JSON.stringify(value)
}

export function mutateDotenv(content: string | undefined, values: Readonly<Record<string, string>>): TextMutation {
  const source = content ?? ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = content === undefined || /\r?\n$/.test(source)
  const lines = source === '' ? [] : source.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const found = new Set<string>()
  const nextLines = lines.map((line) => {
    const match = assignmentPattern.exec(line)
    if (!match) return line
    const [, indentation, exported = '', key, separator] = match
    if (!(key in values)) return line
    found.add(key)
    return `${indentation}${exported}${key}${separator}${quoteDotenv(values[key])}`
  })

  for (const [key, value] of Object.entries(values)) {
    if (!found.has(key)) nextLines.push(`${key}=${quoteDotenv(value)}`)
  }

  let next = nextLines.join(eol)
  if (trailingNewline && next !== '') next += eol
  return { content: next, changed: next !== content }
}
