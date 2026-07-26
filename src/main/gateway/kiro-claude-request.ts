import { createHash } from 'node:crypto'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
type JsonObject = { [key: string]: JsonValue }

export type KiroClaudeRequestConversionErrorCode =
  | 'invalid-request'
  | 'invalid-conversation-id'
  | 'invalid-message-order'
  | 'invalid-content'
  | 'invalid-tool-definition'
  | 'invalid-tool-history'
  | 'request-limit-exceeded'
  | 'unsupported-tool-choice'
  | 'unsupported-content'

/** A request-shape failure that must be returned before an upstream slot is acquired. */
export class KiroClaudeRequestConversionError extends Error {
  public readonly statusCode = 422

  constructor(
    public readonly code: KiroClaudeRequestConversionErrorCode,
    public readonly path: string,
    reason: string
  ) {
    super(`Kiro Claude request rejected ${path}: ${reason}`)
    this.name = 'KiroClaudeRequestConversionError'
  }
}

export interface KiroClaudeRequestConversionOptions {
  /** Resolved upstream model. The incoming Anthropic model is intentionally not used. */
  model: string
  /** Stable conversation identity supplied by the gateway from the Claude session header. */
  conversationId: string
}

export interface KiroClaudeRequestDiagnostics {
  toolsCount: number
  toolUseCount: number
  toolResultCount: number
}

export interface KiroClaudeToolSpecification {
  name: string
  description: string
  inputSchema: { json: JsonObject }
}

export interface KiroClaudeToolEntry {
  toolSpecification: KiroClaudeToolSpecification
}

export interface KiroClaudeToolResult {
  toolUseId: string
  status: 'success' | 'error'
  content: Array<{
    json: {
      exit_status: string
      stdout: string
      stderr: string
    }
  }>
}

export interface KiroClaudeImage {
  format: string
  source: { bytes: string }
}

export interface KiroClaudeUserInputMessageContext {
  envState?: {
    operatingSystem?: string
    currentWorkingDirectory?: string
  }
  tools?: KiroClaudeToolEntry[]
  toolResults?: KiroClaudeToolResult[]
}

export interface KiroClaudeHistoryEntry {
  userInputMessage?: {
    content: string
    origin: 'KIRO_CLI'
    userInputMessageContext?: KiroClaudeUserInputMessageContext
  }
  assistantResponseMessage?: {
    messageId: string
    content: string
    toolUses?: Array<{
      toolUseId: string
      name: string
      input: JsonObject
    }>
  }
}

export interface KiroClaudePayload {
  conversationState: {
    conversationId: string
    chatTriggerType: 'MANUAL'
    agentTaskType: 'vibe'
    currentMessage: {
      userInputMessage: {
        content: string
        modelId: string
        origin: 'KIRO_CLI'
        userInputMessageContext?: KiroClaudeUserInputMessageContext
        images?: KiroClaudeImage[]
      }
    }
    history?: KiroClaudeHistoryEntry[]
  }
  additionalModelRequestFields?: {
    output_config: { effort: NormalizedEffort }
  }
}

export interface KiroClaudeRequestConversion {
  body: KiroClaudePayload
  diagnostics: KiroClaudeRequestDiagnostics
}

interface ParsedToolUse {
  id: string
  name: string
  input: JsonObject
  path: string
}

interface ParsedToolResult {
  toolUseId: string
  isError: boolean
  content: string
  path: string
}

interface ParsedMessage {
  role: 'user' | 'assistant'
  text: string
  images: KiroClaudeImage[]
  toolUses: ParsedToolUse[]
  toolResults: ParsedToolResult[]
  path: string
}

type NormalizedEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const KIRO_ORIGIN = 'KIRO_CLI' as const
const KIRO_CHAT_TRIGGER = 'MANUAL' as const
const KIRO_AGENT_TASK = 'vibe' as const
const ASSISTANT_MESSAGE_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_KIRO_DECLARED_TOOLS = 128
const MAX_KIRO_TOOL_SCHEMA_BYTES = 2 * 1024 * 1024
const MAX_KIRO_TOOL_HISTORY_ENTRIES = 4_096
const MAX_KIRO_TOTAL_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024
const MAX_KIRO_SCHEMA_DEPTH = 64
const SUPPORTED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

const REJECTED_KIRO_SCHEMA_KEYWORDS = new Set([
  '$schema', '$defs', '$ref',
  'propertyNames', 'patternProperties',
  'format',
  'if', 'then', 'else', 'not',
  'dependentRequired', 'dependentSchemas',
  'prefixItems', 'unevaluatedProperties', 'unevaluatedItems',
  'contentMediaType', 'contentEncoding',
  'contains', 'minContains', 'maxContains',
])

const SUPPORTED_KIRO_SCHEMA_KEYWORDS = new Set([
  'type', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'enum', 'const',
  'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'anyOf', 'oneOf', 'allOf',
])

/**
 * Converts one valid Anthropic Messages request into Kiro's native
 * GenerateAssistantResponse payload. This function never performs I/O and
 * rejects all lossy tool-history shapes before the gateway schedules a source.
 */
export function convertAnthropicMessagesToKiroClaude(
  source: Record<string, unknown>,
  options: KiroClaudeRequestConversionOptions
): KiroClaudeRequestConversion {
  const body = expectObject(source, 'body', 'invalid-request')
  const model = requiredTrimmedString(options.model, 'options.model', 'invalid-request')
  const conversationId = requiredTrimmedString(
    options.conversationId,
    'options.conversationId',
    'invalid-conversation-id'
  )

  const system = parseSystem(body.system)
  const toolChoice = parseToolChoice(body.tool_choice)
  const declaredTools = parseTools(body.tools)
  const activeTools = toolChoice === 'none' ? [] : declaredTools
  const messages = parseMessages(body.messages)
  enforceRequestToolLimits(messages)
  validateMessageOrder(messages)
  validateAndOrderToolHistory(messages)

  if (system) {
    const first = messages[0]
    first.text = first.text ? `${system}\n\n${first.text}` : system
  }

  const current = messages[messages.length - 1]
  if (!current.text && current.images.length === 0 && current.toolResults.length === 0) {
    throw conversionError('invalid-content', `${current.path}.content`, 'the current user turn is empty')
  }

  const currentContext: KiroClaudeUserInputMessageContext = {}
  const envState = parseEnvironmentState(system)
  if (envState) currentContext.envState = envState
  if (activeTools.length > 0) currentContext.tools = activeTools
  if (current.toolResults.length > 0) {
    currentContext.toolResults = current.toolResults.map(toKiroToolResult)
  }

  const currentMessage: KiroClaudePayload['conversationState']['currentMessage']['userInputMessage'] = {
    content: current.text,
    modelId: model,
    origin: KIRO_ORIGIN,
  }
  if (Object.keys(currentContext).length > 0) {
    currentMessage.userInputMessageContext = currentContext
  }
  if (current.images.length > 0) currentMessage.images = current.images

  const history = messages.slice(0, -1).map((message, index) => {
    if (message.role === 'user') return userHistoryEntry(message)
    return assistantHistoryEntry(message, conversationId, index)
  })

  const payload: KiroClaudePayload = {
    conversationState: {
      conversationId,
      chatTriggerType: KIRO_CHAT_TRIGGER,
      agentTaskType: KIRO_AGENT_TASK,
      currentMessage: { userInputMessage: currentMessage },
    },
  }
  if (history.length > 0) payload.conversationState.history = history

  const effort = parseEffort(body)
  if (effort) {
    payload.additionalModelRequestFields = { output_config: { effort } }
  }

  return {
    body: payload,
    diagnostics: {
      toolsCount: activeTools.length,
      toolUseCount: messages.reduce((count, message) => count + message.toolUses.length, 0),
      toolResultCount: messages.reduce((count, message) => count + message.toolResults.length, 0),
    },
  }
}

function parseSystem(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    throw conversionError('invalid-content', 'system', 'system must be a string or an array of text blocks')
  }
  const text: string[] = []
  for (const [index, item] of value.entries()) {
    const block = expectObject(item, `system[${index}]`, 'invalid-content')
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw conversionError(
        'unsupported-content',
        `system[${index}]`,
        'only Anthropic system text blocks can be represented by Kiro Claude'
      )
    }
    text.push(block.text)
  }
  return text.join('\n')
}

function parseToolChoice(value: unknown): 'auto' | 'none' {
  if (value === undefined || value === null) return 'auto'
  const choice = expectObject(value, 'tool_choice', 'unsupported-tool-choice')
  const type = requiredTrimmedString(choice.type, 'tool_choice.type', 'unsupported-tool-choice')
  if (type === 'any' || type === 'tool') {
    throw conversionError(
      'unsupported-tool-choice',
      'tool_choice',
      'Kiro Claude cannot guarantee a required or named tool choice'
    )
  }
  if (type !== 'auto' && type !== 'none') {
    throw conversionError('unsupported-tool-choice', 'tool_choice.type', `unsupported choice type ${type}`)
  }
  if (choice.disable_parallel_tool_use === true && type !== 'none') {
    throw conversionError(
      'unsupported-tool-choice',
      'tool_choice.disable_parallel_tool_use',
      'Kiro Claude cannot guarantee serial tool execution'
    )
  }
  return type
}

function parseTools(value: unknown): KiroClaudeToolEntry[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw conversionError('invalid-tool-definition', 'tools', 'tools must be an array')
  }
  if (value.length > MAX_KIRO_DECLARED_TOOLS) {
    throw conversionError(
      'request-limit-exceeded',
      'tools',
      `at most ${MAX_KIRO_DECLARED_TOOLS} tools may be declared`
    )
  }
  const names = new Set<string>()
  const parsed: KiroClaudeToolEntry[] = []
  let schemaBytes = 0
  for (const [index, item] of value.entries()) {
    const path = `tools[${index}]`
    const tool = expectObject(item, path, 'invalid-tool-definition')
    const type = optionalTrimmedString(tool.type)
    if (type && type !== 'custom') {
      throw conversionError(
        'invalid-tool-definition',
        `${path}.type`,
        `tool type ${type} has no native Kiro tool specification`
      )
    }
    const name = requiredTrimmedString(tool.name, `${path}.name`, 'invalid-tool-definition')
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw conversionError(
        'invalid-tool-definition',
        `${path}.name`,
        'tool names must contain 1-64 ASCII letters, digits, underscores, or hyphens'
      )
    }
    if (names.has(name)) {
      throw conversionError('invalid-tool-definition', `${path}.name`, `duplicate tool name ${name}`)
    }
    names.add(name)
    const schema = expectObject(tool.input_schema, `${path}.input_schema`, 'invalid-tool-definition')
    const sanitizedSchema = sanitizeKiroSchema(schema, `${path}.input_schema`)
    if (sanitizedSchema.type !== 'object') {
      throw conversionError(
        'invalid-tool-definition',
        `${path}.input_schema.type`,
        'tool input schema must have type object'
      )
    }
    schemaBytes += Buffer.byteLength(JSON.stringify(sanitizedSchema), 'utf8')
    if (schemaBytes > MAX_KIRO_TOOL_SCHEMA_BYTES) {
      throw conversionError(
        'request-limit-exceeded',
        `${path}.input_schema`,
        `combined tool schemas exceeded ${MAX_KIRO_TOOL_SCHEMA_BYTES} UTF-8 bytes`
      )
    }
    parsed.push({
      toolSpecification: {
        name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: { json: sanitizedSchema },
      },
    })
  }
  return parsed
}

function parseMessages(value: unknown): ParsedMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw conversionError('invalid-request', 'messages', 'at least one message is required')
  }
  return value.map((item, index) => parseMessage(item, index))
}

function parseMessage(value: unknown, index: number): ParsedMessage {
  const path = `messages[${index}]`
  const raw = expectObject(value, path, 'invalid-content')
  if (raw.role !== 'user' && raw.role !== 'assistant') {
    throw conversionError('invalid-content', `${path}.role`, 'role must be user or assistant')
  }
  const role = raw.role
  const parsed: ParsedMessage = {
    role,
    text: '',
    images: [],
    toolUses: [],
    toolResults: [],
    path,
  }
  if (typeof raw.content === 'string') {
    parsed.text = raw.content
    return parsed
  }
  if (!Array.isArray(raw.content)) {
    throw conversionError('invalid-content', `${path}.content`, 'content must be a string or block array')
  }

  const text: string[] = []
  for (const [blockIndex, item] of raw.content.entries()) {
    const blockPath = `${path}.content[${blockIndex}]`
    const block = expectObject(item, blockPath, 'invalid-content')
    const type = requiredTrimmedString(block.type, `${blockPath}.type`, 'invalid-content')
    if (type === 'text') {
      if (typeof block.text !== 'string') {
        throw conversionError('invalid-content', `${blockPath}.text`, 'text must be a string')
      }
      text.push(block.text)
      continue
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      if (role !== 'assistant') {
        throw conversionError('invalid-content', blockPath, `${type} is only valid in assistant content`)
      }
      continue
    }
    if (type === 'image') {
      if (role !== 'user') {
        throw conversionError('invalid-content', blockPath, 'image blocks are only valid in user content')
      }
      parsed.images.push(parseImage(block, blockPath))
      continue
    }
    if (type === 'tool_use') {
      if (role !== 'assistant') {
        throw conversionError('invalid-tool-history', blockPath, 'tool_use must be in an assistant message')
      }
      parsed.toolUses.push(parseToolUse(block, blockPath))
      continue
    }
    if (type === 'tool_result') {
      if (role !== 'user') {
        throw conversionError('invalid-tool-history', blockPath, 'tool_result must be in a user message')
      }
      parsed.toolResults.push(parseToolResult(block, blockPath))
      continue
    }
    throw conversionError(
      'unsupported-content',
      blockPath,
      `content block type ${type} cannot be represented by Kiro Claude`
    )
  }
  parsed.text = text.join('')
  return parsed
}

function parseImage(block: JsonObject, path: string): KiroClaudeImage {
  const source = expectObject(block.source, `${path}.source`, 'unsupported-content')
  if (source.type !== 'base64') {
    throw conversionError(
      'unsupported-content',
      `${path}.source.type`,
      'Kiro Claude only supports inline base64 images'
    )
  }
  const mediaType = requiredTrimmedString(source.media_type, `${path}.source.media_type`, 'invalid-content')
  const format = SUPPORTED_IMAGE_TYPES.get(mediaType.toLowerCase())
  if (!format) {
    throw conversionError('unsupported-content', `${path}.source.media_type`, `unsupported image type ${mediaType}`)
  }
  const data = requiredTrimmedString(source.data, `${path}.source.data`, 'invalid-content').replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw conversionError('invalid-content', `${path}.source.data`, 'image data is not valid base64 text')
  }
  return { format, source: { bytes: data } }
}

function parseToolUse(block: JsonObject, path: string): ParsedToolUse {
  const id = requiredTrimmedString(block.id, `${path}.id`, 'invalid-tool-history')
  const name = requiredTrimmedString(block.name, `${path}.name`, 'invalid-tool-history')
  const input = expectObject(block.input, `${path}.input`, 'invalid-tool-history')
  return { id, name, input: cloneJsonObject(input, `${path}.input`), path }
}

function parseToolResult(block: JsonObject, path: string): ParsedToolResult {
  const toolUseId = requiredTrimmedString(
    block.tool_use_id,
    `${path}.tool_use_id`,
    'invalid-tool-history'
  )
  let content = ''
  if (block.content === undefined || block.content === null) {
    content = ''
  } else if (typeof block.content === 'string') {
    content = block.content
  } else if (Array.isArray(block.content)) {
    const text: string[] = []
    for (const [index, item] of block.content.entries()) {
      const itemPath = `${path}.content[${index}]`
      const part = expectObject(item, itemPath, 'unsupported-content')
      if (part.type !== 'text' || typeof part.text !== 'string') {
        throw conversionError(
          'unsupported-content',
          itemPath,
          'tool_result content must contain only text blocks for lossless Kiro conversion'
        )
      }
      text.push(part.text)
    }
    content = text.join('')
  } else {
    throw conversionError(
      'unsupported-content',
      `${path}.content`,
      'tool_result content must be a string or text block array'
    )
  }
  if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
    throw conversionError('invalid-content', `${path}.is_error`, 'is_error must be a boolean')
  }
  return { toolUseId, isError: block.is_error === true, content, path }
}

function enforceRequestToolLimits(messages: ParsedMessage[]): void {
  let toolEntryCount = 0
  let totalArgumentBytes = 0
  for (const message of messages) {
    toolEntryCount += message.toolUses.length + message.toolResults.length
    if (toolEntryCount > MAX_KIRO_TOOL_HISTORY_ENTRIES) {
      throw conversionError(
        'request-limit-exceeded',
        message.path,
        `tool history exceeded ${MAX_KIRO_TOOL_HISTORY_ENTRIES} retained entries`
      )
    }
    for (const toolUse of message.toolUses) {
      totalArgumentBytes += Buffer.byteLength(JSON.stringify(toolUse.input), 'utf8')
      if (totalArgumentBytes > MAX_KIRO_TOTAL_TOOL_ARGUMENT_BYTES) {
        throw conversionError(
          'request-limit-exceeded',
          `${toolUse.path}.input`,
          `combined tool arguments exceeded ${MAX_KIRO_TOTAL_TOOL_ARGUMENT_BYTES} UTF-8 bytes`
        )
      }
    }
  }
}

function validateMessageOrder(messages: ParsedMessage[]): void {
  for (const [index, message] of messages.entries()) {
    const expected = index % 2 === 0 ? 'user' : 'assistant'
    if (message.role !== expected) {
      throw conversionError(
        'invalid-message-order',
        `${message.path}.role`,
        `expected ${expected}; Kiro Claude requires alternating user and assistant turns`
      )
    }
  }
  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    throw conversionError(
      'invalid-message-order',
      `${last.path}.role`,
      'the current turn must be an explicit user message'
    )
  }
}

function validateAndOrderToolHistory(messages: ParsedMessage[]): void {
  const seenUses = new Set<string>()
  const seenResults = new Set<string>()
  let pending: ParsedToolUse[] = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolUse of message.toolUses) {
        if (seenUses.has(toolUse.id)) {
          throw conversionError(
            'invalid-tool-history',
            `${toolUse.path}.id`,
            `duplicate tool_use ID ${toolUse.id}`
          )
        }
        seenUses.add(toolUse.id)
      }
      pending = message.toolUses
      continue
    }

    if (message.toolResults.length === 0) {
      if (pending.length > 0) {
        throw conversionError(
          'invalid-tool-history',
          `${message.path}.content`,
          `missing tool_result blocks for ${pending.map((toolUse) => toolUse.id).join(', ')}`
        )
      }
      continue
    }
    if (pending.length === 0) {
      throw conversionError(
        'invalid-tool-history',
        `${message.toolResults[0].path}.tool_use_id`,
        'tool_result has no immediately preceding assistant tool_use batch'
      )
    }

    const resultsById = new Map<string, ParsedToolResult>()
    for (const result of message.toolResults) {
      if (seenResults.has(result.toolUseId) || resultsById.has(result.toolUseId)) {
        throw conversionError(
          'invalid-tool-history',
          `${result.path}.tool_use_id`,
          `duplicate tool_result ID ${result.toolUseId}`
        )
      }
      resultsById.set(result.toolUseId, result)
    }
    const pendingIds = new Set(pending.map((toolUse) => toolUse.id))
    const unexpected = message.toolResults.find((result) => !pendingIds.has(result.toolUseId))
    if (unexpected) {
      throw conversionError(
        'invalid-tool-history',
        `${unexpected.path}.tool_use_id`,
        `tool_result ${unexpected.toolUseId} does not belong to the preceding parallel batch`
      )
    }
    const missing = pending.filter((toolUse) => !resultsById.has(toolUse.id))
    if (missing.length > 0) {
      throw conversionError(
        'invalid-tool-history',
        `${message.path}.content`,
        `missing tool_result blocks for ${missing.map((toolUse) => toolUse.id).join(', ')}`
      )
    }

    message.toolResults = pending.map((toolUse) => resultsById.get(toolUse.id) as ParsedToolResult)
    for (const result of message.toolResults) seenResults.add(result.toolUseId)
    pending = []
  }
}

function userHistoryEntry(message: ParsedMessage): KiroClaudeHistoryEntry {
  if (message.images.length > 0) {
    throw conversionError(
      'unsupported-content',
      `${message.path}.content`,
      'Kiro Claude cannot represent images in historical user turns'
    )
  }
  const input: NonNullable<KiroClaudeHistoryEntry['userInputMessage']> = {
    content: message.text,
    origin: KIRO_ORIGIN,
  }
  if (message.toolResults.length > 0) {
    input.userInputMessageContext = { toolResults: message.toolResults.map(toKiroToolResult) }
  }
  return { userInputMessage: input }
}

function assistantHistoryEntry(
  message: ParsedMessage,
  conversationId: string,
  historyIndex: number
): KiroClaudeHistoryEntry {
  if (!message.text && message.toolUses.length === 0) {
    throw conversionError(
      'unsupported-content',
      `${message.path}.content`,
      'assistant content contains no text or tool_use blocks that Kiro Claude can represent'
    )
  }
  const toolUses = message.toolUses.map((toolUse) => ({
    toolUseId: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  }))
  const assistant: NonNullable<KiroClaudeHistoryEntry['assistantResponseMessage']> = {
    messageId: deterministicUuid(
      ASSISTANT_MESSAGE_NAMESPACE,
      stableJsonStringify({
        conversationId,
        historyIndex,
        content: message.text,
        toolUses,
      })
    ),
    content: message.text,
  }
  if (toolUses.length > 0) assistant.toolUses = toolUses
  return { assistantResponseMessage: assistant }
}

function toKiroToolResult(result: ParsedToolResult): KiroClaudeToolResult {
  return {
    toolUseId: result.toolUseId,
    status: result.isError ? 'error' : 'success',
    content: [{
      json: {
        exit_status: result.isError ? '1' : '0',
        stdout: result.content,
        stderr: '',
      },
    }],
  }
}

function parseEffort(body: JsonObject): NormalizedEffort | undefined {
  const outputConfig = optionalObject(body.output_config)
  if (outputConfig?.effort !== undefined) {
    const raw = requiredTrimmedString(outputConfig.effort, 'output_config.effort', 'invalid-request')
      .toLowerCase()
    if (raw === 'minimal') return 'low'
    if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') {
      return raw
    }
    throw conversionError('invalid-request', 'output_config.effort', `unsupported reasoning effort ${raw}`)
  }
  const thinking = optionalObject(body.thinking)
  const thinkingType = optionalTrimmedString(thinking?.type)?.toLowerCase()
  if (thinkingType === 'adaptive' || thinkingType === 'enabled') return 'high'
  if (thinkingType && thinkingType !== 'disabled') {
    throw conversionError('invalid-request', 'thinking.type', `unsupported thinking type ${thinkingType}`)
  }
  return undefined
}

function parseEnvironmentState(system: string): KiroClaudeUserInputMessageContext['envState'] | undefined {
  const env = /<env>([\s\S]*?)<\/env>/i.exec(system)?.[1]
  if (!env) return undefined
  const workingDirectory = /^Working directory:\s*(.+?)\s*$/im.exec(env)?.[1]?.trim()
  const rawPlatform = /^Platform:\s*(.+?)\s*$/im.exec(env)?.[1]?.trim()
  const operatingSystem = rawPlatform === 'darwin'
    ? 'macos'
    : rawPlatform === 'win32' || rawPlatform === 'windows'
      ? 'windows'
      : rawPlatform
  if (!workingDirectory && !operatingSystem) return undefined
  return {
    ...(operatingSystem ? { operatingSystem } : {}),
    ...(workingDirectory ? { currentWorkingDirectory: workingDirectory } : {}),
  }
}

function sanitizeKiroSchema(value: JsonObject, path: string, depth = 0): JsonObject {
  if (depth > MAX_KIRO_SCHEMA_DEPTH) {
    throw conversionError(
      'invalid-tool-definition',
      path,
      `tool schema nesting exceeds ${MAX_KIRO_SCHEMA_DEPTH} levels`
    )
  }
  const result: JsonObject = {}
  const hasConst = Object.prototype.hasOwnProperty.call(value, 'const')
  const constValue = hasConst ? cloneJsonValue(value.const, `${path}.const`) : undefined
  const unionKeywords = ['anyOf', 'oneOf'].filter((key) => value[key] !== undefined)
  if (unionKeywords.length > 1) {
    throw conversionError(
      'invalid-tool-definition',
      path,
      'Kiro Claude cannot safely combine multiple schema unions'
    )
  }
  if (unionKeywords.length === 1) {
    const semanticSiblings = Object.keys(value).filter((key) => (
      key !== unionKeywords[0]
      && key !== 'title'
      && key !== 'description'
      && key !== 'default'
      && key !== 'examples'
      && key !== 'deprecated'
      && key !== 'readOnly'
      && key !== 'writeOnly'
    ))
    if (semanticSiblings.length > 0) {
      throw conversionError(
        'invalid-tool-definition',
        `${path}.${unionKeywords[0]}`,
        'Kiro Claude cannot safely combine a schema union with sibling validation keywords'
      )
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const keywordPath = `${path}.${key}`
    if (REJECTED_KIRO_SCHEMA_KEYWORDS.has(key)) {
      throw conversionError(
        'invalid-tool-definition',
        keywordPath,
        `Kiro Claude cannot represent schema keyword ${key} without changing validation semantics`
      )
    }
    if (!SUPPORTED_KIRO_SCHEMA_KEYWORDS.has(key)) {
      throw conversionError(
        'invalid-tool-definition',
        keywordPath,
        `unsupported schema keyword ${key} cannot be forwarded safely`
      )
    }
    if (key === 'const') continue
    if (key === 'allOf') {
      throw conversionError(
        'invalid-tool-definition',
        keywordPath,
        'Kiro Claude cannot safely flatten allOf tool schemas'
      )
    }
    if (key === 'anyOf' || key === 'oneOf') {
      const collapsed = collapseKiroUnion(item, keywordPath, key, depth + 1)
      for (const [collapsedKey, collapsedValue] of Object.entries(collapsed)) {
        if (result[collapsedKey] !== undefined) {
          throw conversionError(
            'invalid-tool-definition',
            keywordPath,
            `schema union conflicts with sibling keyword ${collapsedKey}`
          )
        }
        result[collapsedKey] = collapsedValue
      }
      continue
    }
    if (key === 'properties') {
      const properties = expectObject(item, keywordPath, 'invalid-tool-definition')
      result.properties = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [
        name,
        sanitizeKiroSchema(
          expectObject(schema, `${keywordPath}.${name}`, 'invalid-tool-definition'),
          `${keywordPath}.${name}`,
          depth + 1
        ),
      ]))
      continue
    }
    if (key === 'additionalProperties' || key === 'items') {
      if (typeof item === 'boolean') {
        result[key] = item
        continue
      }
      result[key] = sanitizeKiroSchema(
        expectObject(item, keywordPath, 'invalid-tool-definition'),
        keywordPath,
        depth + 1
      )
      continue
    }
    if (key === 'required') {
      if (!Array.isArray(item) || item.some((name) => typeof name !== 'string' || !name)) {
        throw conversionError('invalid-tool-definition', keywordPath, 'required must be an array of non-empty strings')
      }
      if (new Set(item).size !== item.length) {
        throw conversionError('invalid-tool-definition', keywordPath, 'required entries must be unique')
      }
      if (item.length > 0) result.required = [...item]
      continue
    }
    if (key === 'type') {
      if (!isJsonSchemaType(item)) {
        throw conversionError(
          'invalid-tool-definition',
          keywordPath,
          'type must be one JSON Schema primitive type string'
        )
      }
      result.type = item
      continue
    }
    if (key === 'enum') {
      if (!Array.isArray(item)) {
        throw conversionError('invalid-tool-definition', keywordPath, 'enum must be an array')
      }
      result.enum = item.map((entry, index) => cloneJsonValue(entry, `${keywordPath}[${index}]`))
      continue
    }
    if (key === 'pattern') {
      if (typeof item !== 'string') {
        throw conversionError('invalid-tool-definition', keywordPath, 'pattern must be a string')
      }
      try {
        new RegExp(item, 'u')
      } catch {
        throw conversionError('invalid-tool-definition', keywordPath, 'pattern must be a valid regular expression')
      }
      result.pattern = item
      continue
    }
    if (key === 'minLength' || key === 'maxLength'
      || key === 'minItems' || key === 'maxItems'
      || key === 'minProperties' || key === 'maxProperties') {
      if (!Number.isSafeInteger(item) || (item as number) < 0) {
        throw conversionError('invalid-tool-definition', keywordPath, `${key} must be a non-negative safe integer`)
      }
      result[key] = item as number
      continue
    }
    if (key === 'minimum' || key === 'maximum'
      || key === 'exclusiveMinimum' || key === 'exclusiveMaximum'
      || key === 'multipleOf') {
      if (typeof item !== 'number' || !Number.isFinite(item) || (key === 'multipleOf' && item <= 0)) {
        throw conversionError(
          'invalid-tool-definition',
          keywordPath,
          `${key} must be ${key === 'multipleOf' ? 'a positive' : 'a finite'} number`
        )
      }
      result[key] = item
      continue
    }
    if (key === 'uniqueItems' || key === 'deprecated' || key === 'readOnly' || key === 'writeOnly') {
      if (typeof item !== 'boolean') {
        throw conversionError('invalid-tool-definition', keywordPath, `${key} must be a boolean`)
      }
      result[key] = item
      continue
    }
    if (key === 'title' || key === 'description') {
      if (typeof item !== 'string') {
        throw conversionError('invalid-tool-definition', keywordPath, `${key} must be a string`)
      }
      result[key] = item
      continue
    }
    result[key] = cloneJsonValue(item, keywordPath)
  }

  if (hasConst) {
    const existingEnum = Array.isArray(result.enum) ? result.enum : undefined
    result.enum = existingEnum === undefined || existingEnum.some((entry) => jsonValuesEqual(entry, constValue as JsonValue))
      ? [constValue as JsonValue]
      : []
  }
  return result
}

function collapseKiroUnion(
  value: unknown,
  path: string,
  keyword: 'anyOf' | 'oneOf',
  depth: number
): JsonObject {
  if (!Array.isArray(value) || value.length === 0) {
    throw conversionError('invalid-tool-definition', path, 'schema union must contain at least one branch')
  }
  const branches = value.map((item, index) => (
    sanitizeKiroSchema(
      expectObject(item, `${path}[${index}]`, 'invalid-tool-definition'),
      `${path}[${index}]`,
      depth
    )
  ))
  if (branches.every((branch) => (
    Array.isArray(branch.enum)
      && Object.keys(branch).every((key) => key === 'type' || key === 'enum')
  ))) {
    const types = new Set(branches.map((branch) => branch.type).filter((type) => typeof type === 'string'))
    if (types.size > 1) {
      throw conversionError('invalid-tool-definition', path, 'schema union mixes incompatible value types')
    }
    const values = branches.flatMap((branch) => branch.enum as JsonValue[])
    if (keyword === 'oneOf' && hasDuplicateJsonValues(values)) {
      throw conversionError('invalid-tool-definition', path, 'oneOf enum branches overlap')
    }
    return {
      ...(types.size === 1 ? { type: [...types][0] as JsonValue } : {}),
      enum: deduplicateJsonValues(values),
    }
  }
  throw conversionError(
    'invalid-tool-definition',
    path,
    'Kiro Claude cannot safely represent this schema union'
  )
}

function isJsonSchemaType(value: unknown): value is string {
  return value === 'null' || value === 'boolean' || value === 'object' || value === 'array'
    || value === 'number' || value === 'integer' || value === 'string'
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

function hasDuplicateJsonValues(values: JsonValue[]): boolean {
  const seen = new Set<string>()
  for (const value of values) {
    const key = stableJsonStringify(value)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function deduplicateJsonValues(values: JsonValue[]): JsonValue[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = stableJsonStringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function cloneJsonObject(value: JsonObject, path: string): JsonObject {
  return cloneJsonValue(value, path) as JsonObject
}

function cloneJsonValue(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw conversionError('invalid-content', path, 'JSON numbers must be finite')
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw conversionError('invalid-content', path, 'circular JSON value')
    const next = new Set(ancestors).add(value)
    return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, next))
  }
  const object = optionalObject(value)
  if (object) {
    if (ancestors.has(object)) throw conversionError('invalid-content', path, 'circular JSON value')
    const next = new Set(ancestors).add(object)
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, cloneJsonValue(item, `${path}.${key}`, next)])
    )
  }
  throw conversionError('invalid-content', path, 'value is not JSON serializable')
}

function deterministicUuid(namespace: string, value: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const bytes = createHash('sha1').update(namespaceBytes).update(value, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
  )).join(',')}}`
}

function requiredTrimmedString(
  value: unknown,
  path: string,
  code: KiroClaudeRequestConversionErrorCode
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw conversionError(code, path, 'a non-empty string is required')
  }
  return value.trim()
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function expectObject(
  value: unknown,
  path: string,
  code: KiroClaudeRequestConversionErrorCode
): JsonObject {
  const object = optionalObject(value)
  if (!object) throw conversionError(code, path, 'an object is required')
  return object
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function conversionError(
  code: KiroClaudeRequestConversionErrorCode,
  path: string,
  reason: string
): KiroClaudeRequestConversionError {
  return new KiroClaudeRequestConversionError(code, path, reason)
}
