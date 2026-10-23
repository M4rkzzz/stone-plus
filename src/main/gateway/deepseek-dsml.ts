import { randomUUID } from 'node:crypto'
import type { ToolBridgeBinding, ToolBridgePlan } from './types'

type JsonObject = Record<string, unknown>

// The model encoding uses one full-width bar, while the hosted Responses
// endpoint currently escapes it as a doubled bar. Relays may normalize either
// representation to ASCII, so accept the four wire-equivalent spellings.
const DSML_TOKENS = ['｜｜DSML｜｜', '||DSML||', '｜DSML｜', '|DSML|'] as const
export const DEEPSEEK_DSML_START_MARKERS = DSML_TOKENS.map((token) => `<${token}tool_calls>`)
const DEEPSEEK_DSML_END_MARKERS = DSML_TOKENS.map((token) => `</${token}tool_calls>`)

export interface ParsedDeepSeekDsmlToolCall {
  binding: ToolBridgeBinding
  callId: string
  arguments: string
}

export interface ParsedDeepSeekDsmlBlock {
  prefix: string
  suffix: string
  calls: ParsedDeepSeekDsmlToolCall[]
}

export class DeepSeekDsmlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'DeepSeekDsmlError'
  }
}

/**
 * Parses DeepSeek V4's documented DSML tool-call block. Tool names are
 * authorized against the current request and non-string values must remain
 * valid JSON. Nothing is inferred from prose surrounding the block.
 */
export function parseDeepSeekDsmlBlock(
  text: string,
  plan: ToolBridgePlan,
): ParsedDeepSeekDsmlBlock | undefined {
  const start = earliestMarker(text, DEEPSEEK_DSML_START_MARKERS)
  if (!start) return undefined
  const endMarker = matchingEndMarker(start.marker)
  const endIndex = text.indexOf(endMarker, start.index + start.marker.length)
  if (endIndex < 0) {
    throw new DeepSeekDsmlError('truncated_dsml', 'DeepSeek returned an incomplete DSML tool-call block.')
  }
  const suffix = text.slice(endIndex + endMarker.length)
  if (containsDsmlStart(suffix)) {
    throw new DeepSeekDsmlError('multiple_dsml_blocks', 'DeepSeek returned more than one DSML tool-call block.')
  }
  if (suffix.trim()) {
    throw new DeepSeekDsmlError('content_after_dsml', 'DeepSeek returned unexpected content after its DSML tool calls.')
  }
  const body = text.slice(start.index + start.marker.length, endIndex)
  const calls = parseInvocations(body, start.marker, plan)
  if (calls.length === 0) {
    throw new DeepSeekDsmlError('empty_dsml_block', 'DeepSeek returned an empty DSML tool-call block.')
  }
  return { prefix: text.slice(0, start.index), suffix, calls }
}

/** Restores DSML embedded in a buffered Responses payload. */
export function restoreDeepSeekResponsesDsml(body: JsonObject, plan: ToolBridgePlan): JsonObject {
  const output = arrayOfObjects(body.output)
  if (output.length === 0) return body
  const restored: JsonObject[] = []
  const calls: ParsedDeepSeekDsmlToolCall[] = []
  let foundBlock = false
  let foundNativeTool = false
  const usedCallIds = new Set(plan.calls.map((call) => call.callId))

  for (const [itemIndex, item] of output.entries()) {
    const itemType = stringValue(item.type)
    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
      if (foundBlock) {
        throw new DeepSeekDsmlError(
          'mixed_tool_formats',
          'DeepSeek mixed native tool output with a DSML tool-call block.',
        )
      }
      foundNativeTool = true
      restored.push(restoreDeepSeekNativeToolCall(item, itemIndex, plan, usedCallIds))
      continue
    }
    if (itemType !== 'message') {
      restored.push(item)
      continue
    }
    const nextItem = structuredClone(item)
    const content: JsonObject[] = []
    for (const part of arrayOfObjects(nextItem.content)) {
      if (stringValue(part.type) !== 'output_text' || typeof part.text !== 'string') {
        content.push(part)
        continue
      }
      const parsed = parseDeepSeekDsmlBlock(part.text, plan)
      if (!parsed) {
        content.push(part)
        continue
      }
      if (foundBlock) {
        throw new DeepSeekDsmlError('multiple_dsml_blocks', 'DeepSeek returned more than one DSML tool-call block.')
      }
      if (foundNativeTool) {
        throw new DeepSeekDsmlError(
          'mixed_tool_formats',
          'DeepSeek mixed native tool output with a DSML tool-call block.',
        )
      }
      foundBlock = true
      calls.push(...parsed.calls)
      if (parsed.prefix) content.push({ ...part, text: parsed.prefix })
    }
    nextItem.content = content
    if (content.length > 0) restored.push(nextItem)
  }

  if (!foundBlock && !foundNativeTool) return body
  for (const call of calls) restored.push(deepSeekCallToResponsesItem(call))
  return { ...body, output: restored }
}

function restoreDeepSeekNativeToolCall(
  item: JsonObject,
  itemIndex: number,
  plan: ToolBridgePlan,
  usedCallIds: Set<string>,
): JsonObject {
  const itemType = stringValue(item.type)
  const callId = stringValue(item.call_id) || stringValue(item.id)
  if (!callId) {
    throw new DeepSeekDsmlError('missing_tool_call_id', `DeepSeek native tool output ${itemIndex} has no call id.`)
  }
  if (usedCallIds.has(callId)) {
    throw new DeepSeekDsmlError('duplicate_tool_call_id', `DeepSeek repeated tool call id ${callId}.`)
  }
  usedCallIds.add(callId)

  const namedBinding = itemType === 'tool_search_call'
    ? singleDeclaredToolSearchBinding(plan)
    : resolveDeepSeekToolBinding(plan, stringValue(item.name))
  if (!namedBinding) {
    const name = stringValue(item.name) || itemType
    throw new DeepSeekDsmlError('undeclared_tool', `DeepSeek attempted to call undeclared tool ${name}.`)
  }
  if (itemType === 'custom_tool_call' && namedBinding.sourceType !== 'custom') {
    throw new DeepSeekDsmlError(
      'tool_kind_mismatch',
      `DeepSeek returned custom tool output for non-custom tool ${namedBinding.sourceName}.`,
    )
  }

  const argumentsValue = Object.hasOwn(item, 'arguments') ? item.arguments : {}
  let argumentsText = typeof argumentsValue === 'string'
    ? argumentsValue || '{}'
    : JSON.stringify(argumentsValue) ?? '{}'
  if (namedBinding.sourceType === 'custom') {
    let input: string
    if (namedBinding.deferredToolName) {
      input = deepSeekDeferredToolExecInput(
        namedBinding.deferredToolName,
        parseNativeToolArguments(argumentsValue, itemIndex),
      )
    } else if (itemType === 'custom_tool_call') {
      if (typeof item.input !== 'string') {
        throw new DeepSeekDsmlError(
          'invalid_custom_tool_arguments',
          `DeepSeek custom tool output ${itemIndex} must contain a string input.`,
        )
      }
      input = item.input
    } else {
      const wrapper = parseNativeToolArguments(argumentsValue, itemIndex)
      if (typeof wrapper.input !== 'string' || Object.keys(wrapper).some((key) => key !== 'input')) {
        throw new DeepSeekDsmlError(
          'invalid_custom_tool_arguments',
          `DeepSeek custom tool ${namedBinding.sourceName} must provide exactly one string input parameter.`,
        )
      }
      input = wrapper.input
    }
    argumentsText = JSON.stringify({ input })
  }

  const restored = deepSeekCallToResponsesItem({
    binding: namedBinding,
    callId,
    arguments: argumentsText,
  })
  return {
    ...restored,
    id: stringValue(item.id) || restored.id,
    status: stringValue(item.status) || 'completed',
  }
}

function singleDeclaredToolSearchBinding(plan: ToolBridgePlan): ToolBridgeBinding | undefined {
  const bindings = plan.tools.filter((binding) => binding.declared !== false && binding.sourceType === 'tool_search')
  return bindings.length === 1 ? bindings[0] : undefined
}

function parseNativeToolArguments(value: unknown, itemIndex: number): JsonObject {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new DeepSeekDsmlError(
        'invalid_tool_arguments',
        `DeepSeek native tool output ${itemIndex} contains invalid JSON arguments.`,
      )
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepSeekDsmlError(
      'invalid_tool_arguments',
      `DeepSeek native tool output ${itemIndex} arguments must be an object.`,
    )
  }
  return parsed as JsonObject
}

export function containsDsmlStart(text: string): boolean {
  return DEEPSEEK_DSML_START_MARKERS.some((marker) => text.includes(marker))
}

export function deepSeekDsmlEndMarker(startMarker: string): string {
  return matchingEndMarker(startMarker)
}

function parseInvocations(
  body: string,
  startMarker: string,
  plan: ToolBridgePlan,
): ParsedDeepSeekDsmlToolCall[] {
  const token = startMarker.slice(1, -'tool_calls>'.length)
  const invokeOpen = `<${token}invoke`
  const invokeClose = `</${token}invoke>`
  const parameterOpen = `<${token}parameter`
  const parameterClose = `</${token}parameter>`
  const calls: ParsedDeepSeekDsmlToolCall[] = []
  let cursor = 0

  while (cursor < body.length) {
    cursor = skipWhitespace(body, cursor)
    if (cursor >= body.length) break
    if (!body.startsWith(invokeOpen, cursor)) {
      throw new DeepSeekDsmlError('invalid_dsml', 'DeepSeek returned malformed content inside a DSML tool-call block.')
    }
    const openEnd = body.indexOf('>', cursor + invokeOpen.length)
    if (openEnd < 0) throw new DeepSeekDsmlError('truncated_dsml', 'DeepSeek returned a truncated DSML invocation.')
    const attributes = body.slice(cursor + invokeOpen.length, openEnd)
    const nameMatch = attributes.match(/^\s+name="([^"]+)"\s*$/)
    if (!nameMatch) throw new DeepSeekDsmlError('invalid_tool_name', 'DeepSeek returned an invalid DSML tool name.')
    const name = nameMatch[1]
    const binding = resolveDeepSeekToolBinding(plan, name)
    if (!binding) {
      throw new DeepSeekDsmlError('undeclared_tool', `DeepSeek attempted to call undeclared tool ${name}.`)
    }
    cursor = openEnd + 1
    const args: JsonObject = {}
    while (true) {
      cursor = skipWhitespace(body, cursor)
      if (body.startsWith(invokeClose, cursor)) {
        cursor += invokeClose.length
        break
      }
      if (!body.startsWith(parameterOpen, cursor)) {
        throw new DeepSeekDsmlError('invalid_parameter', `DeepSeek returned malformed parameters for tool ${name}.`)
      }
      const parameterOpenEnd = body.indexOf('>', cursor + parameterOpen.length)
      if (parameterOpenEnd < 0) {
        throw new DeepSeekDsmlError('truncated_dsml', `DeepSeek returned a truncated parameter for tool ${name}.`)
      }
      const attributesText = body.slice(cursor + parameterOpen.length, parameterOpenEnd)
      const parameterMatch = attributesText.match(/^\s+name="([^"]+)"\s+string="(true|false)"\s*$/)
      if (!parameterMatch) {
        throw new DeepSeekDsmlError('invalid_parameter', `DeepSeek returned an invalid parameter header for tool ${name}.`)
      }
      const parameterName = parameterMatch[1]
      if (Object.hasOwn(args, parameterName)) {
        throw new DeepSeekDsmlError('duplicate_parameter', `DeepSeek repeated parameter ${parameterName} for tool ${name}.`)
      }
      const closeIndex = body.indexOf(parameterClose, parameterOpenEnd + 1)
      if (closeIndex < 0) {
        throw new DeepSeekDsmlError('truncated_dsml', `DeepSeek returned a truncated parameter for tool ${name}.`)
      }
      const rawValue = body.slice(parameterOpenEnd + 1, closeIndex)
      args[parameterName] = parameterMatch[2] === 'true'
        ? rawValue
        : parseJsonParameter(rawValue, name, parameterName)
      cursor = closeIndex + parameterClose.length
    }

    const argumentObject = binding.sourceType === 'custom'
      ? normalizeCustomArguments(args, name, binding)
      : args
    calls.push({
      binding,
      callId: `call_dsml_${randomUUID().replace(/-/g, '')}`,
      arguments: JSON.stringify(argumentObject),
    })
  }
  return calls
}

function normalizeCustomArguments(
  args: JsonObject,
  name: string,
  binding: ToolBridgeBinding,
): JsonObject {
  if (binding.deferredToolName) {
    return { input: deepSeekDeferredToolExecInput(binding.deferredToolName, args) }
  }
  if (typeof args.input !== 'string' || Object.keys(args).some((key) => key !== 'input')) {
    throw new DeepSeekDsmlError(
      'invalid_custom_tool_arguments',
      `DeepSeek custom tool ${name} must provide exactly one string input parameter.`,
    )
  }
  return args
}

export function deepSeekDeferredToolExecInput(name: string, args: JsonObject): string {
  validateDeferredToolName(name)
  const serializedName = JSON.stringify(name)
  const serializedArgs = JSON.stringify(args)
  return [
    `const requestedName = ${serializedName};`,
    "const normalizedName = requestedName.replaceAll('.', '__');",
    "const availableTools = typeof ALL_TOOLS === 'undefined'",
    '  ? Object.keys(tools).map((name) => ({ name }))',
    '  : ALL_TOOLS;',
    'const exact = availableTools.find((entry) => entry.name === requestedName)',
    '  ?? availableTools.find((entry) => entry.name === normalizedName);',
    "const suffixMatches = exact ? [] : availableTools.filter((entry) => entry.name.endsWith('__' + requestedName));",
    "if (!exact && suffixMatches.length !== 1) throw new Error('Deferred tool is unavailable or ambiguous: ' + requestedName);",
    'const resolvedName = exact?.name ?? suffixMatches[0].name;',
    'const deferredTool = tools[resolvedName];',
    "if (typeof deferredTool !== 'function') throw new Error('Deferred tool is unavailable: ' + resolvedName);",
    `const result = await deferredTool(${serializedArgs});`,
    "text(typeof result === 'string' ? result : JSON.stringify(result));",
  ].join('\n')
}

function deepSeekCallToResponsesItem(call: ParsedDeepSeekDsmlToolCall): JsonObject {
  if (call.binding.sourceType === 'tool_search') {
    return {
      id: `tsc_${call.callId}`,
      type: 'tool_search_call',
      status: 'completed',
      execution: 'client',
      call_id: call.callId,
      arguments: parseToolSearchArguments(call.arguments),
    }
  }
  if (call.binding.sourceType === 'custom') {
    const parsed = JSON.parse(call.arguments) as JsonObject
    return {
      id: `ctc_${call.callId}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: call.callId,
      name: call.binding.sourceName,
      input: parsed.input,
    }
  }
  return {
    id: `fc_${call.callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: call.callId,
    name: call.binding.sourceName,
    ...(call.binding.sourceNamespace ? { namespace: call.binding.sourceNamespace } : {}),
    arguments: call.arguments,
  }
}

export function parseToolSearchArguments(value: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new DeepSeekDsmlError('invalid_tool_search_arguments', 'DeepSeek tool search arguments must be valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepSeekDsmlError('invalid_tool_search_arguments', 'DeepSeek tool search arguments must be an object.')
  }
  const args = parsed as JsonObject
  if (typeof args.query !== 'string' || !args.query.trim()) {
    throw new DeepSeekDsmlError('invalid_tool_search_arguments', 'DeepSeek tool search requires a non-empty query.')
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new DeepSeekDsmlError('invalid_tool_search_arguments', 'DeepSeek tool search limit must be a positive number.')
  }
  if (Object.keys(args).some((key) => key !== 'query' && key !== 'limit')) {
    throw new DeepSeekDsmlError('invalid_tool_search_arguments', 'DeepSeek tool search accepts only query and limit.')
  }
  return {
    query: args.query.trim(),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  }
}

export function resolveDeepSeekToolBinding(
  plan: ToolBridgePlan,
  name: string,
): ToolBridgeBinding | undefined {
  const declared = plan.tools.find((binding) => binding.declared !== false && binding.wireName === name)
  if (declared) return declared
  if ((plan.dialect !== 'deepseek-dsml' && plan.dialect !== 'deepseek-chat')
    || !plan.deferredExecSourceName) return undefined
  validateDeferredToolName(name)
  return {
    sourceType: 'custom',
    sourceName: plan.deferredExecSourceName,
    wireName: name,
    deferredToolName: name,
    declared: true,
  }
}

function validateDeferredToolName(name: string): void {
  const containsControlCharacter = Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
  if (!name || name.length > 256 || containsControlCharacter) {
    throw new DeepSeekDsmlError('invalid_tool_name', 'DeepSeek returned an invalid deferred tool name.')
  }
}

function parseJsonParameter(raw: string, tool: string, parameter: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new DeepSeekDsmlError(
      'invalid_parameter_json',
      `DeepSeek returned invalid JSON for ${tool}.${parameter}.`,
    )
  }
}

function matchingEndMarker(startMarker: string): string {
  const index = DEEPSEEK_DSML_START_MARKERS.indexOf(startMarker)
  return DEEPSEEK_DSML_END_MARKERS[index]
}

function earliestMarker(
  text: string,
  markers: readonly string[],
): { index: number; marker: string } | undefined {
  let best: { index: number; marker: string } | undefined
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index >= 0 && (!best || index < best.index)) best = { index, marker }
  }
  return best
}

function skipWhitespace(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index])) index += 1
  return index
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
