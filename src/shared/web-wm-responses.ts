/** A lightweight, explicitly approximate count for the Responses input_tokens endpoint. */
export function estimateResponsesInputTokens(body: Record<string, unknown>): number {
  // Count semantic input only.  Model/transport metadata (especially the
  // client installation envelope) is not model context and must not inflate
  // the value Codex uses as a compaction hint.
  const countable: Record<string, unknown> = {}
  for (const key of [
    'instructions',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'text',
    'include',
    'max_output_tokens',
    'max_tool_calls',
    'truncation',
  ]) {
    if (Object.hasOwn(body, key)) countable[key] = body[key]
  }
  return Math.max(1, estimateWebWmTokens(countable))
}

export function estimateWebWmTokens(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (!serialized) return 0
  let utf8Bytes = 0
  let nonAsciiCodeUnits = 0
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    if (code <= 0x7f) {
      utf8Bytes += 1
      continue
    }
    nonAsciiCodeUnits += 1
    if (code <= 0x7ff) {
      utf8Bytes += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < serialized.length
      && serialized.charCodeAt(index + 1) >= 0xdc00
      && serialized.charCodeAt(index + 1) <= 0xdfff) {
      utf8Bytes += 4
      nonAsciiCodeUnits += 1
      index += 1
      continue
    }
    utf8Bytes += 3
  }
  return Math.ceil(utf8Bytes / 3 + nonAsciiCodeUnits / 2)
}
