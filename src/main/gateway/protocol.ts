import type { Protocol } from '../../shared/types'
import { createHash } from 'node:crypto'
import type {
  ProtocolConversionContext,
  ProtocolRequest,
  ToolBridgeBinding,
  ToolBridgePlan,
  ToolCallBridgeBinding
} from './types'
import {
  deepSeekDeferredToolExecInput,
  DeepSeekDsmlError,
  parseToolSearchArguments,
  resolveDeepSeekToolBinding,
  restoreDeepSeekResponsesDsml,
} from './deepseek-dsml'

type JsonObject = Record<string, unknown>

export class UnsupportedProtocolConversionError extends Error {
  constructor(from: Protocol, to: Protocol, reason?: string) {
    super(reason ?? `Conversion from ${from} to ${to} is not supported`)
    this.name = 'UnsupportedProtocolConversionError'
  }
}

export class ResponsesResponseFailedError extends Error {
  public readonly code?: string
  public readonly requestLevel: boolean

  constructor(body: JsonObject) {
    const error = objectValue(body.error)
    const code = safeProtocolErrorCode(error?.code ?? error?.type)
    super(`Upstream Responses request failed${code ? ` (${code})` : ''}.`)
    this.name = 'ResponsesResponseFailedError'
    this.code = code
    this.requestLevel = safeProtocolErrorCode(error?.type) === 'invalid_request_error'
  }
}

export class InvalidToolArgumentsError extends Error {
  constructor(public readonly path: string) {
    super(`Tool arguments at ${path} must be a JSON object.`)
    this.name = 'InvalidToolArgumentsError'
  }
}

export class InvalidToolChoiceError extends Error {
  constructor(public readonly path: string) {
    super(`Required tool choice at ${path} has no compatible function declaration.`)
    this.name = 'InvalidToolChoiceError'
  }
}

/** Raised when an upstream response is valid for its native protocol but
 * cannot be represented as a successful terminal response by the requested
 * downstream protocol. Callers must surface this as a controlled upstream
 * conversion failure instead of manufacturing an ordinary stop. */
export class InvalidProtocolResponseError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Invalid protocol response at ${path}: ${reason}`)
    this.name = 'InvalidProtocolResponseError'
  }
}

export class InvalidToolBridgeError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Grok tool bridge rejected ${path}: ${reason}`)
    this.name = 'InvalidToolBridgeError'
  }
}

export interface ProtocolConversionIssue {
  path: string
  capability: 'image-input' | 'builtin-tool' | 'content-part' | 'request-option'
  reason: string
}

export interface ProtocolConversionAnalysis {
  supported: boolean
  issues: ProtocolConversionIssue[]
}

function usesResponsesChatToolBridge(context?: ProtocolConversionContext): boolean {
  return context?.dialect === 'xai-grok' || context?.dialect === 'deepseek-chat'
}

/** Runtime authority for lossy cross-protocol request shapes. Native requests
 * remain untouched; cross-protocol requests must either have an explicit
 * mapping below or fail before an account slot is acquired. */
export function analyzeProtocolConversion(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  context?: ProtocolConversionContext
): ProtocolConversionAnalysis {
  if (context?.dialect === 'xai-grok' && from === 'openai-responses') {
    try {
      body = prepareXaiResponsesSource(body, context)
    } catch (error) {
      if (error instanceof InvalidToolBridgeError) {
        return {
          supported: false,
          issues: [{ path: error.path, capability: 'builtin-tool', reason: error.message }],
        }
      }
      throw error
    }
  }
  if (context?.dialect === 'deepseek-chat' && from === 'openai-responses') {
    try {
      body = prepareDeepSeekResponsesSource(body, context)
    } catch (error) {
      if (error instanceof DeepSeekDsmlError) {
        return {
          supported: false,
          issues: [{
            path: 'tools',
            capability: 'builtin-tool',
            reason: `DeepSeek tool bridge rejected tools: ${error.message}`,
          }],
        }
      }
      throw error
    }
  }
  if (context?.dialect === 'xai-grok' && from === 'openai-responses' && to === 'openai-responses') {
    const opaqueIndex = arrayOfObjects(body.input).findIndex((item) => {
      const type = stringValue(item.type)
      return type === 'compaction_trigger'
        || ((type === 'compaction' || type === 'compaction_summary')
          && typeof item.encrypted_content === 'string'
          && Boolean(item.encrypted_content.trim()))
    })
    if (opaqueIndex >= 0) {
      return {
        supported: false,
        issues: [{
          path: `input[${opaqueIndex}]`,
          capability: 'content-part',
          reason: 'Responses compaction state cannot be discarded or expanded safely for Grok',
        }],
      }
    }
    if (body.previous_response_id !== null && body.previous_response_id !== undefined) {
      return {
        supported: false,
        issues: [{
          path: 'previous_response_id',
          capability: 'request-option',
          reason: 'Responses conversation chaining cannot be discarded or expanded safely for Grok',
        }],
      }
    }
  }
  if (from === to) return { supported: true, issues: [] }
  if (from === 'kiro-claude' || to === 'kiro-claude') {
    return {
      supported: false,
      issues: [{
        path: 'body',
        capability: 'content-part',
        reason: 'Kiro Claude conversion is available only through the dedicated Anthropic Messages gateway bridge.',
      }],
    }
  }
  const issues: ProtocolConversionIssue[] = []
  const add = (path: string, capability: ProtocolConversionIssue['capability'], reason: string): void => {
    issues.push({ path, capability, reason })
  }
  for (const [index, tool] of arrayOfObjects(body.tools).entries()) {
    const type = stringValue(tool.type)
    const isFunction = type === 'function' || (from === 'anthropic-messages' && !type && optionalString(tool.name))
    const isGeminiFunctionGroup = from === 'gemini' && Array.isArray(tool.functionDeclarations)
    const isXaiCustom = usesResponsesChatToolBridge(context)
      && from === 'openai-responses'
      && to === 'openai-chat'
      && type === 'custom'
    if (!isFunction && !isGeminiFunctionGroup && !isXaiCustom) {
      add(`tools[${index}]`, 'builtin-tool', `Tool type ${type || 'unknown'} has no lossless ${to} mapping`)
    }
    const strict = from === 'openai-chat'
      ? booleanValue(objectValue(tool.function)?.strict)
      : from === 'openai-responses'
        ? booleanValue(tool.strict)
        : from === 'anthropic-messages'
          ? booleanValue(tool.strict)
          : undefined
    const strictProtocols = new Set<Protocol>(['openai-chat', 'openai-responses', 'anthropic-messages'])
    const targetPreservesStrict = strictProtocols.has(from) && strictProtocols.has(to)
    if (strict === true && !targetPreservesStrict) {
      add(
        from === 'openai-chat' ? `tools[${index}].function.strict` : `tools[${index}].strict`,
        'request-option',
        `Strict function schemas have no lossless ${to} mapping`
      )
    }
  }
  if (from === 'openai-chat' && Object.hasOwn(body, 'response_format')) {
    const responseFormat = objectValue(body.response_format)
    if (stringValue(responseFormat?.type) !== 'text') {
      add('response_format', 'request-option', `Structured response formats have no lossless ${to} mapping`)
    }
  }
  if (from === 'openai-responses') {
    if (body.previous_response_id !== null && body.previous_response_id !== undefined) {
      add(
        'previous_response_id',
        'request-option',
        `Responses conversation history cannot be expanded losslessly for ${to}`
      )
    }
    const text = objectValue(body.text)
    if (text && Object.hasOwn(text, 'format')) {
      const format = objectValue(text.format)
      if (stringValue(format?.type) !== 'text') {
        add('text.format', 'request-option', `Structured response formats have no lossless ${to} mapping`)
      }
    }
    const unsupportedOptions = [
      ['max_tool_calls', body.max_tool_calls],
      ['prompt', body.prompt],
      ['truncation', body.truncation],
      ['background', body.background],
    ] as const
    for (const [path, value] of unsupportedOptions) {
      if (value !== undefined && value !== null && value !== false) {
        add(path, 'request-option', `Responses option ${path} has no lossless ${to} mapping`)
      }
    }
    if (Array.isArray(body.include) && body.include.length > 0) {
      add('include', 'request-option', `Requested Responses include fields have no lossless ${to} mapping`)
    }
    if (body.store === true && to !== 'openai-chat') {
      add('store', 'request-option', `Stored Responses state has no lossless ${to} mapping`)
    }
    if (body.service_tier !== undefined && to !== 'openai-chat') {
      add('service_tier', 'request-option', `Responses service tier has no lossless ${to} mapping`)
    }
    if (objectValue(body.reasoning) && to === 'gemini') {
      add('reasoning', 'request-option', 'Responses reasoning controls have no lossless Gemini mapping')
    }
  }
  if (from === 'anthropic-messages') {
    const thinking = objectValue(body.thinking)
    if (thinking) {
      if (to !== 'openai-responses') {
        add('thinking', 'request-option', `Anthropic thinking controls have no lossless ${to} mapping`)
      } else if (Object.hasOwn(thinking, 'budget_tokens')) {
        add(
          'thinking.budget_tokens',
          'request-option',
          'Anthropic thinking token budgets have no exact OpenAI Responses mapping'
        )
      }
    }
    for (const [index, block] of arrayOfObjects(body.system).entries()) {
      if (Object.hasOwn(block, 'cache_control')) {
        add(
          `system[${index}].cache_control`,
          'request-option',
          `Anthropic prompt cache controls have no lossless ${to} mapping`
        )
      }
    }
    for (const [index, tool] of arrayOfObjects(body.tools).entries()) {
      if (Object.hasOwn(tool, 'cache_control')) {
        add(
          `tools[${index}].cache_control`,
          'request-option',
          `Anthropic tool cache controls have no lossless ${to} mapping`
        )
      }
    }
  }
  const hasDeclaredTools = hasCompatibleFunctionDeclaration(from, body, context)
  const requiredToolChoice = requiredToolChoicePath(from, body)
  const choiceRequiresTool = requiredToolChoice !== undefined
  if (choiceRequiresTool && !hasDeclaredTools) {
    add(requiredToolChoice, 'builtin-tool', `A required tool choice cannot be converted without a compatible tool declaration`)
  }
  if (from === 'openai-responses' && Array.isArray(body.input)) {
    for (const [itemIndex, item] of arrayOfObjects(body.input).entries()) {
      const type = stringValue(item.type)
      if (type === 'message' || (!type && typeof item.role === 'string')) {
        validateContentParts(
          'openai-responses',
          to,
          item.content,
          `input[${itemIndex}].content`,
          new Set(['input_text', 'output_text', 'text', 'input_image']),
          add
        )
      } else if (type === 'function_call_output') {
        validateToolResultContent(
          'openai-responses',
          to,
          item.output,
          `input[${itemIndex}].output`,
          add
        )
      } else if (type === 'function_call' || (type === 'custom_tool_call' && usesResponsesChatToolBridge(context) && to === 'openai-chat')) {
        if (targetRequiresObjectToolArguments(to) && !isJsonObjectArgument(item.arguments)) {
          add(
            `input[${itemIndex}].arguments`,
            'content-part',
            `Function-call arguments must be a JSON object for ${to}`
          )
        }
      } else if (type !== 'custom_tool_call_output' || !usesResponsesChatToolBridge(context) || to !== 'openai-chat') {
        add(`input[${itemIndex}]`, 'content-part', `Input item type ${type || 'unknown'} has no lossless ${to} mapping`)
      }
    }
  } else if (from === 'openai-chat') {
    for (const [messageIndex, message] of arrayOfObjects(body.messages).entries()) {
      const role = stringValue(message.role)
      if (role === 'tool' || role === 'function') {
        validateToolResultContent('openai-chat', to, message.content, `messages[${messageIndex}].content`, add)
      } else {
        validateContentParts(
          'openai-chat',
          to,
          message.content,
          `messages[${messageIndex}].content`,
          new Set(['text', 'image_url']),
          add
        )
      }
      if (targetRequiresObjectToolArguments(to)) {
        for (const [toolIndex, toolCall] of chatMessageToolCalls(message).entries()) {
          const definition = objectValue(toolCall.function)
          if (isJsonObjectArgument(definition?.arguments)) continue
          add(
            `messages[${messageIndex}].tool_calls[${toolIndex}].function.arguments`,
            'content-part',
            `Function-call arguments must be a JSON object for ${to}`
          )
        }
      }
    }
  } else if (from === 'anthropic-messages') {
    for (const [messageIndex, message] of arrayOfObjects(body.messages).entries()) {
      validateContentParts(
        'anthropic-messages',
        to,
        message.content,
        `messages[${messageIndex}].content`,
        new Set(['text', 'image', 'tool_use', 'tool_result']),
        add
      )
      let sawToolUse = false
      for (const [blockIndex, block] of arrayOfObjects(message.content).entries()) {
        const type = stringValue(block.type)
        if (type === 'tool_use') sawToolUse = true
        else if (to === 'openai-chat' && sawToolUse && type === 'text' && stringValue(block.text)) {
          add(
            `messages[${messageIndex}].content[${blockIndex}]`,
            'content-part',
            'Text after an Anthropic tool_use block has no lossless OpenAI Chat mapping'
          )
        }
        if (Object.hasOwn(block, 'cache_control')) {
          add(
            `messages[${messageIndex}].content[${blockIndex}].cache_control`,
            'request-option',
            `Anthropic prompt cache controls have no lossless ${to} mapping`
          )
        }
        if (type === 'tool_result') {
          if (block.is_error === true) {
            add(
              `messages[${messageIndex}].content[${blockIndex}].is_error`,
              'content-part',
              `Anthropic tool-result error state has no lossless ${to} mapping`
            )
          }
          validateToolResultContent(
            'anthropic-messages',
            to,
            block.content,
            `messages[${messageIndex}].content[${blockIndex}].content`,
            add
          )
        } else if (type === 'tool_use' && to === 'gemini' && !isJsonObjectArgument(block.input)) {
          add(
            `messages[${messageIndex}].content[${blockIndex}].input`,
            'content-part',
            `Tool-use input must be a JSON object for ${to}`
          )
        }
      }
    }
  } else if (from === 'gemini') {
    for (const [contentIndex, content] of arrayOfObjects(body.contents).entries()) {
      for (const [partIndex, part] of arrayOfObjects(content.parts).entries()) {
        if (!('text' in part) && !('functionCall' in part) && !('function_call' in part)
          && !('functionResponse' in part) && !('function_response' in part)
          && !('inlineData' in part) && !('inline_data' in part)
          && !('fileData' in part) && !('file_data' in part)) {
          add(`contents[${contentIndex}].parts[${partIndex}]`, 'content-part', `Gemini content part has no lossless ${to} mapping`)
        } else if ((('inlineData' in part) || ('inline_data' in part) || ('fileData' in part) || ('file_data' in part))
          && !geminiImagePartToUrl(part)) {
          add(`contents[${contentIndex}].parts[${partIndex}]`, 'image-input', 'Gemini image content is missing data or a file URI')
        }
        const functionResponseKey = objectValue(part.functionResponse) ? 'functionResponse' : 'function_response'
        const functionResponse = objectValue(part[functionResponseKey])
        if (functionResponse && Array.isArray(functionResponse.parts) && functionResponse.parts.length > 0) {
          add(
            `contents[${contentIndex}].parts[${partIndex}].${functionResponseKey}.parts`,
            'content-part',
            `Multimodal Gemini function responses have no verified lossless ${to} mapping`
          )
        }
        const functionCall = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (functionCall && to === 'anthropic-messages' && !isJsonObjectArgument(functionCall.args)) {
          add(
            `contents[${contentIndex}].parts[${partIndex}].functionCall.args`,
            'content-part',
            `Function-call arguments must be a JSON object for ${to}`
          )
        }
      }
    }
  }
  return { supported: issues.length === 0, issues }
}

type ToolResultProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages'

function validateToolResultContent(
  from: ToolResultProtocol,
  to: Protocol,
  value: unknown,
  path: string,
  add: (path: string, capability: ProtocolConversionIssue['capability'], reason: string) => void
): void {
  if (!Array.isArray(value)) return
  for (const [index, item] of value.entries()) {
    const part = objectValue(item)
    if (!part) {
      add(`${path}[${index}]`, 'content-part', `Tool-result content must be an object for ${to}`)
      continue
    }
    const type = stringValue(part.type)
    const textType = from === 'openai-responses'
      ? type === 'input_text' || type === 'output_text' || type === 'text'
      : type === 'text'
    if (textType) continue

    const image = from === 'openai-responses'
      ? type === 'input_image' ? imageUrlValue(part) : undefined
      : from === 'openai-chat'
        ? type === 'image_url' ? chatImageUrl(part) : undefined
        : type === 'image' ? anthropicImageUrl(part) : undefined
    if (image) {
      const targetSupportsImage = (from === 'anthropic-messages' && to === 'openai-responses')
        || (from === 'openai-chat' && (to === 'openai-responses' || to === 'anthropic-messages'))
        || (from === 'openai-responses' && to === 'anthropic-messages')
      if (!targetSupportsImage) {
        add(
          `${path}[${index}]`,
          'content-part',
          `Tool-result images have no verified lossless ${to} mapping`
        )
      }
      validateImageDetail(from, to, part, `${path}[${index}]`, add)
      continue
    }

    if (type === 'input_image' || type === 'image_url' || type === 'image') {
      add(`${path}[${index}]`, 'image-input', 'Tool-result image is missing a usable URL or base64 source')
    } else {
      add(
        `${path}[${index}]`,
        'content-part',
        `Tool-result content type ${type || 'unknown'} has no lossless ${to} mapping`
      )
    }
  }
}

function validateContentParts(
  from: ToolResultProtocol,
  to: Protocol,
  value: unknown,
  path: string,
  supportedTypes: ReadonlySet<string>,
  add: (path: string, capability: ProtocolConversionIssue['capability'], reason: string) => void
): void {
  if (typeof value === 'string' || value === null || value === undefined) return
  for (const [index, part] of arrayOfObjects(value).entries()) {
    const type = stringValue(part.type)
    if (!supportedTypes.has(type)) {
      add(`${path}[${index}]`, 'content-part', `Content type ${type || 'unknown'} has no lossless mapping`)
      continue
    }
    const imageMissing = (type === 'input_image' && !imageUrlValue(part))
      || (type === 'image_url' && !chatImageUrl(part))
      || (type === 'image' && !anthropicImageUrl(part))
    if (imageMissing) add(`${path}[${index}]`, 'image-input', 'Image content is missing a usable URL or base64 source')
    else if (type === 'input_image' || type === 'image_url' || type === 'image') {
      validateImageDetail(from, to, part, `${path}[${index}]`, add)
    }
  }
}

function validateImageDetail(
  from: ToolResultProtocol,
  to: Protocol,
  part: JsonObject,
  path: string,
  add: (path: string, capability: ProtocolConversionIssue['capability'], reason: string) => void
): void {
  const detailPath = from === 'openai-chat' ? `${path}.image_url.detail` : `${path}.detail`
  const detail = from === 'openai-chat'
    ? objectValue(part.image_url ?? part.imageUrl)?.detail
    : from === 'openai-responses' ? part.detail : undefined
  if (detail === undefined) return
  if (typeof detail !== 'string' || !detail) {
    add(detailPath, 'request-option', `Image detail must be a non-empty string for ${to}`)
    return
  }
  const targetPreservesDetail = (from === 'openai-chat' && to === 'openai-responses')
    || (from === 'openai-responses' && to === 'openai-chat')
  if (!targetPreservesDetail) {
    add(detailPath, 'request-option', `Image detail has no lossless ${to} mapping`)
  }
}

function hasCompatibleFunctionDeclaration(from: Protocol, body: JsonObject, context?: ProtocolConversionContext): boolean {
  return arrayOfObjects(body.tools).some((tool) => {
    const type = stringValue(tool.type)
    if (type === 'function') return true
    if (type === 'custom' && from === 'openai-responses' && usesResponsesChatToolBridge(context)) return true
    if (from === 'anthropic-messages' && !type) return Boolean(optionalString(tool.name))
    if (from !== 'gemini') return false
    return arrayOfObjects(tool.functionDeclarations ?? tool.function_declarations)
      .some((declaration) => Boolean(optionalString(declaration.name)))
  })
}

function requiredToolChoicePath(from: Protocol, body: JsonObject): string | undefined {
  if (from === 'gemini') {
    const toolConfig = objectValue(body.toolConfig) ?? objectValue(body.tool_config)
    const config = objectValue(toolConfig?.functionCallingConfig)
      ?? objectValue(toolConfig?.function_calling_config)
    return stringValue(config?.mode).trim().toUpperCase() === 'ANY'
      ? (objectValue(toolConfig?.functionCallingConfig)
          ? 'toolConfig.functionCallingConfig.mode'
          : 'tool_config.function_calling_config.mode')
      : undefined
  }
  const choice = body.tool_choice ?? body.toolChoice
  if (choice === 'required' || choice === 'any') return 'tool_choice'
  const choiceObject = objectValue(choice)
  return choiceObject && ['function', 'custom', 'tool', 'any'].includes(stringValue(choiceObject.type))
    ? 'tool_choice'
    : undefined
}

function targetRequiresObjectToolArguments(to: Protocol): boolean {
  return to === 'anthropic-messages' || to === 'gemini'
}

function isJsonObjectArgument(value: unknown): boolean {
  if (value === undefined) return true
  if (objectValue(value)) return true
  if (typeof value !== 'string') return false
  try {
    return objectValue(JSON.parse(value) as unknown) !== undefined
  } catch {
    return false
  }
}

export function getRequestModel(protocol: Protocol, body: JsonObject, pathname?: string): string {
  if (protocol === 'gemini') {
    const modelFromPath = pathname?.match(/\/models\/([^/:?]+)/)?.[1]
    if (modelFromPath) return decodeURIComponent(modelFromPath)
  }
  const model = body.model
  return typeof model === 'string' ? model : ''
}

export function convertRequest(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  targetModel: string,
  context?: ProtocolConversionContext
): ProtocolRequest {
  if (context?.dialect === 'xai-grok' && from === 'openai-responses') {
    body = prepareXaiResponsesSource(body, context)
  }
  if ((context?.dialect === 'deepseek-dsml' || context?.dialect === 'deepseek-chat')
    && from === 'openai-responses') {
    body = prepareDeepSeekResponsesSource(body, context)
  }
  prepareXaiBridgeContext(from, to, body, context)
  if (from === to) {
    // The Grok CLI endpoint advertises a Responses-shaped URL, but its Rust
    // ModelInput enum is intentionally narrower than Codex's Responses wire
    // format.  Do the same loss-minimizing bridge used for Chat relays even
    // when both sides claim Responses, otherwise Codex-only items such as
    // compaction records and hosted tools reach Grok unchanged and produce a
    // generic 422 deserialization error.
    const identityBody = context?.dialect === 'xai-grok' && to === 'openai-responses'
      ? normalizeXaiResponsesRequest(body, targetModel, context)
      : withModel(body, to, targetModel)
    return {
      protocol: to,
      body: to === 'openai-chat' ? applyXaiChatRequestOptions(identityBody, context) : identityBody,
      model: targetModel,
      ...(context ? { conversionContext: context } : {})
    }
  }
  if (from === 'anthropic-messages') {
    const errorPath = anthropicToolResultErrorPath(body)
    if (errorPath) {
      throw new UnsupportedProtocolConversionError(
        from,
        to,
        `Anthropic tool-result error state at ${errorPath} has no lossless ${to} mapping`
      )
    }
  }
  const nativeXaiResponses = context?.dialect === 'xai-grok'
    && from === 'openai-responses'
    && to === 'openai-responses'
  const requiredChoice = nativeXaiResponses ? undefined : requiredToolChoicePath(from, body)
  if (requiredChoice && !hasCompatibleFunctionDeclaration(from, body, context)) {
    throw new InvalidToolChoiceError(requiredChoice)
  }

  if (to === 'openai-chat') {
    if (from === 'anthropic-messages') {
      return { protocol: to, body: anthropicRequestToChat(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
    }
    if (from === 'openai-responses') {
      return { protocol: to, body: responsesRequestToChat(body, targetModel, context), model: targetModel, ...(context ? { conversionContext: context } : {}) }
    }
    if (from === 'gemini') {
      return { protocol: to, body: geminiRequestToChat(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
    }
  }
  if (from === 'openai-chat' && to === 'anthropic-messages') {
    return { protocol: to, body: chatRequestToAnthropic(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'openai-chat' && to === 'openai-responses') {
    return { protocol: to, body: chatRequestToResponses(body, targetModel, context), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'openai-chat' && to === 'gemini') {
    return { protocol: to, body: chatRequestToGemini(body), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'openai-responses' && to === 'anthropic-messages') {
    return { protocol: to, body: responsesRequestToAnthropic(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'anthropic-messages' && to === 'openai-responses') {
    return { protocol: to, body: anthropicRequestToResponses(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'openai-responses' && to === 'gemini') {
    return { protocol: to, body: responsesRequestToGemini(body), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'gemini' && to === 'openai-responses') {
    return { protocol: to, body: geminiRequestToResponses(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'anthropic-messages' && to === 'gemini') {
    return { protocol: to, body: anthropicRequestToGemini(body), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from === 'gemini' && to === 'anthropic-messages') {
    return { protocol: to, body: geminiRequestToAnthropic(body, targetModel), model: targetModel, ...(context ? { conversionContext: context } : {}) }
  }
  if (from !== 'openai-chat' && to !== 'openai-chat') {
    const intermediate = convertRequest(from, 'openai-chat', body, targetModel, context)
    return convertRequest('openai-chat', to, intermediate.body, targetModel, context)
  }
  throw new UnsupportedProtocolConversionError(from, to)
}

export function convertResponse(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  fallbackModel: string,
  now = Date.now,
  context?: ProtocolConversionContext
): JsonObject {
  if (from === 'openai-responses' && stringValue(body.status).trim().toLowerCase() === 'failed') {
    throw new ResponsesResponseFailedError(body)
  }
  if (from === to) {
    if (from === 'openai-responses' && context?.toolBridgePlan) {
      if (context.dialect === 'xai-grok') return restoreXaiResponsesToolCalls(body, context)
      if (context.dialect === 'deepseek-dsml') {
        return restoreDeepSeekResponsesDsml(body, context.toolBridgePlan)
      }
    }
    return body
  }
  if (from === 'openai-responses') {
    const status = stringValue(body.status).trim().toLowerCase()
    if (status === 'cancelled' || status === 'queued' || status === 'in_progress') {
      throw new InvalidProtocolResponseError(
        'status',
        `Responses status ${status} is not a successful terminal result and cannot be mapped to ${to}`
      )
    }
  }
  if (from === 'anthropic-messages'
    && stringValue(body.stop_reason).trim().toLowerCase() === 'pause_turn') {
    throw new InvalidProtocolResponseError(
      'stop_reason',
      `Anthropic pause_turn requires native continuation and cannot be mapped to ${to}`
    )
  }
  if (to === 'openai-chat') {
    if (from === 'anthropic-messages') return anthropicResponseToChat(body, fallbackModel, now)
    if (from === 'openai-responses') return responsesResponseToChat(body, fallbackModel, now)
    if (from === 'gemini') return geminiResponseToChat(body, fallbackModel, now)
  }
  if (from === 'openai-chat' && to === 'anthropic-messages') {
    return chatResponseToAnthropic(body, fallbackModel, now)
  }
  if (from === 'openai-chat' && to === 'openai-responses') {
    return chatResponseToResponses(body, fallbackModel, now, context)
  }
  if (from === 'openai-chat' && to === 'gemini') {
    return chatResponseToGemini(body, fallbackModel)
  }
  if (from === 'openai-responses' && to === 'anthropic-messages') {
    return responsesResponseToAnthropic(body, fallbackModel, now)
  }
  if (from === 'anthropic-messages' && to === 'openai-responses') {
    return anthropicResponseToResponses(body, fallbackModel, now)
  }
  if (from === 'openai-responses' && to === 'gemini') {
    return responsesResponseToGemini(body, fallbackModel, now)
  }
  if (from === 'gemini' && to === 'openai-responses') {
    return geminiResponseToResponses(body, fallbackModel, now)
  }
  if (from === 'anthropic-messages' && to === 'gemini') {
    return anthropicResponseToGemini(body, fallbackModel)
  }
  if (from === 'gemini' && to === 'anthropic-messages') {
    return geminiResponseToAnthropic(body, fallbackModel, now)
  }
  if (from !== 'openai-chat' && to !== 'openai-chat') {
    const intermediate = convertResponse(from, 'openai-chat', body, fallbackModel, now, context)
    return convertResponse('openai-chat', to, intermediate, fallbackModel, now, context)
  }
  throw new UnsupportedProtocolConversionError(from, to)
}

function withModel(body: JsonObject, protocol: Protocol, model: string): JsonObject {
  // Identity routes are the common case. Reuse the parsed request object when
  // no wire-visible model rewrite is needed; downstream stream/tier helpers
  // already copy before changing fields.
  if (protocol === 'gemini' || body.model === model) return body
  return { ...body, model }
}

function prepareXaiBridgeContext(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  context?: ProtocolConversionContext
): void {
  if (context?.dialect !== 'xai-grok') return
  if (from === 'openai-responses' && to === 'openai-chat') {
    context.toolBridgePlan ??= buildXaiToolBridgePlan(body)
  }
}

/**
 * DeepSeek V4 can expose its native DSML tool syntax inside Responses text
 * items. Record the exact current declarations so the response bridge can
 * authorize and restore those calls without changing the request wire.
 */
function prepareDeepSeekResponsesSource(
  body: JsonObject,
  context: ProtocolConversionContext,
): JsonObject {
  const prepared = structuredClone(body)
  promoteXaiAdditionalTools(prepared)
  promoteDeepSeekToolSearchResults(prepared)
  const namespaces = flattenXaiNamespaceTools(prepared)
  const plan: ToolBridgePlan = {
    dialect: context.dialect ?? 'deepseek-dsml',
    tools: [],
    calls: [],
    // Codex can execute multiple independently identified tool calls even
    // when its model hint asked for one-at-a-time generation. DeepSeek V4
    // frequently batches safe reads, so accept and advertise that native
    // capability instead of turning a valid batch into a retrying 502.
    parallelToolCalls: true,
  }
  const seenNames = new Set<string>()
  let rewroteTools = false
  let toolSearchWireName: string | undefined
  const sourceTools = arrayOfObjects(prepared.tools)
  const occupiedNames = new Set(sourceTools.flatMap((tool) => {
    const type = stringValue(tool.type)
    const name = optionalString(tool.name)
    return name && (type === 'function' || type === 'custom') ? [name] : []
  }))
  const tools = sourceTools.map((tool, index) => {
    const type = stringValue(tool.type)
    if (type === 'web_search_preview') {
      rewroteTools = true
      return { ...tool, type: 'web_search' }
    }
    if (type === 'tool_search') {
      if (toolSearchWireName) {
        throw new DeepSeekDsmlError('duplicate_tool_search', 'DeepSeek received more than one tool_search declaration.')
      }
      toolSearchWireName = deepSeekToolSearchWireName(occupiedNames)
      seenNames.add(toolSearchWireName)
      plan.tools.push({
        sourceType: 'tool_search',
        sourceName: 'tool_search',
        wireName: toolSearchWireName,
        declared: true,
      })
      rewroteTools = true
      return {
        type: 'function',
        name: toolSearchWireName,
        description: optionalString(tool.description)
          ?? 'Search the Codex client tool registry. Call this before claiming a requested capability is unavailable.',
        parameters: objectValue(tool.parameters) ?? {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Tool name or capability to search for.' },
            limit: { type: 'number', description: 'Maximum number of matching tools.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      }
    }
    if (type !== 'function' && type !== 'custom') {
      if (type === 'web_search' || type === 'web_search_2025_08_26') return tool
      throw new DeepSeekDsmlError(
        'unsupported_tool_type',
        `DeepSeek Responses cannot execute tool type ${type || '<empty>'}.`,
      )
    }
    const name = optionalString(tool.name)
    if (!name) throw new DeepSeekDsmlError('missing_tool_name', `DeepSeek tool declaration ${index} has no name.`)
    if (seenNames.has(name)) {
      throw new DeepSeekDsmlError('duplicate_tool_name', `DeepSeek tool declaration ${name} is duplicated or ambiguous.`)
    }
    seenNames.add(name)
    const namespace = namespaces.get(name)
    plan.tools.push({
      sourceType: type,
      sourceName: namespace?.name ?? name,
      ...(namespace ? { sourceNamespace: namespace.namespace } : {}),
      wireName: name,
      declared: true,
    })
    if (type !== 'custom') return tool
    rewroteTools = true
    const description = optionalString(tool.description)
    return {
      type: 'function',
      name,
      description: description
        ? `${description}\n\nDeepSeek compatibility: pass the complete custom-tool input in the input string.`
        : `Invoke the ${name} custom tool. Pass its complete input in the input string.`,
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Complete raw input for the custom tool.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    }
  })
  if (toolSearchWireName) rewriteDeepSeekToolSearchHistory(prepared, toolSearchWireName)
  if (tools.length > 0) prepared.parallel_tool_calls = true
  const exec = plan.tools.find((binding) => binding.sourceType === 'custom'
    && (binding.sourceName === 'exec' || binding.sourceName === 'functions.exec'))
  if (exec) plan.deferredExecSourceName = exec.sourceName
  plan.requiresResponseBridge = plan.tools.length > 0
  context.toolBridgePlan = plan
  return rewroteTools || prepared !== body ? { ...prepared, tools } : prepared
}

function promoteDeepSeekToolSearchResults(body: JsonObject): void {
  const input = arrayOfObjects(body.input)
  const promoted = arrayOfObjects(body.tools)
  const seen = new Set(promoted.map(xaiToolDedupKey))
  const namespaceIndices = new Map<string, number>()
  for (const [index, tool] of promoted.entries()) {
    if (stringValue(tool.type) === 'namespace' && optionalString(tool.name)) {
      namespaceIndices.set(stringValue(tool.name), index)
    }
  }
  let changed = false
  for (const item of input) {
    if (stringValue(item.type) !== 'tool_search_output') continue
    for (const tool of arrayOfObjects(item.tools)) {
      const namespace = stringValue(tool.type) === 'namespace' ? optionalString(tool.name) : undefined
      const existingIndex = namespace ? namespaceIndices.get(namespace) : undefined
      if (existingIndex !== undefined) {
        const existing = promoted[existingIndex]
        const children = arrayOfObjects(existing.tools ?? existing.children)
        const childKeys = new Set(children.map(xaiToolDedupKey))
        const merged = [...children]
        for (const child of arrayOfObjects(tool.tools ?? tool.children)) {
          const childKey = xaiToolDedupKey(child)
          if (childKeys.has(childKey)) continue
          childKeys.add(childKey)
          merged.push(child)
          changed = true
        }
        if (merged.length !== children.length) promoted[existingIndex] = { ...existing, tools: merged }
        continue
      }
      const key = xaiToolDedupKey(tool)
      if (seen.has(key)) continue
      seen.add(key)
      promoted.push(tool)
      if (namespace) namespaceIndices.set(namespace, promoted.length - 1)
      changed = true
    }
  }
  if (changed) body.tools = promoted
}

function deepSeekToolSearchWireName(occupied: ReadonlySet<string>): string {
  if (!occupied.has('search_tools')) return 'search_tools'
  if (!occupied.has('stone_tool_search')) return 'stone_tool_search'
  const digest = createHash('sha256').update('deepseek:tool_search', 'utf8').digest('hex').slice(0, 16)
  return `sp_tool_search_${digest}`
}

function rewriteDeepSeekToolSearchHistory(body: JsonObject, wireName: string): void {
  if (!Array.isArray(body.input)) return
  body.input = body.input.map((value) => {
    const item = objectValue(value)
    if (!item) return value
    const type = stringValue(item.type)
    if (type === 'tool_search_call') {
      const directArguments = objectValue(item.arguments)
      const argumentsObject = directArguments ?? {
        ...(typeof item.query === 'string' ? { query: item.query } : {}),
        ...(typeof item.limit === 'number' ? { limit: item.limit } : {}),
      }
      return {
        ...item,
        type: 'function_call',
        name: wireName,
        arguments: JSON.stringify(argumentsObject),
      }
    }
    if (type === 'tool_search_output') {
      const output = Object.hasOwn(item, 'output')
        ? item.output
        : { tools: arrayOfObjects(item.tools) }
      return {
        ...item,
        type: 'function_call_output',
        output: typeof output === 'string' ? output : JSON.stringify(output),
      }
    }
    return value
  })
}

const XAI_NATIVE_RESPONSES_TOOL_TYPES = new Set([
  'function',
  'web_search',
  'x_search',
  'image_generation',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
])

interface XaiNamespaceBinding {
  namespace: string
  name: string
  wireName: string
}

/** Prepare Codex's Responses extensions before either native or Chat routing. */
function prepareXaiResponsesSource(
  body: JsonObject,
  context: ProtocolConversionContext,
): JsonObject {
  const prepared = structuredClone(body)
  promoteXaiAdditionalTools(prepared)
  const namespaces = flattenXaiNamespaceTools(prepared)
  context.toolBridgePlan = buildXaiToolBridgePlan(prepared, namespaces)
  return prepared
}

function promoteXaiAdditionalTools(body: JsonObject): void {
  if (!Array.isArray(body.input)) return
  const input = arrayOfObjects(body.input)
  if (!input.some((item) => stringValue(item.type) === 'additional_tools')) return
  const tools = arrayOfObjects(body.tools)
  const seen = new Set(tools.map(xaiToolDedupKey))
  const promoted = [...tools]
  const filteredInput: JsonObject[] = []
  for (const item of input) {
    if (stringValue(item.type) !== 'additional_tools') {
      filteredInput.push(item)
      continue
    }
    for (const tool of arrayOfObjects(item.tools)) {
      const key = xaiToolDedupKey(tool)
      if (seen.has(key)) continue
      seen.add(key)
      promoted.push(tool)
    }
  }
  body.input = filteredInput
  if (promoted.length > 0) body.tools = promoted
}

function xaiToolDedupKey(tool: JsonObject): string {
  const type = stringValue(tool.type)
  const name = optionalString(tool.name)
  if (type && name) return `${type}\0${name}`
  if (type === 'mcp' && optionalString(tool.server_label)) return `mcp\0${stringValue(tool.server_label)}`
  return jsonString(tool)
}

function flattenXaiNamespaceTools(body: JsonObject): Map<string, XaiNamespaceBinding> {
  const sourceTools = arrayOfObjects(body.tools)
  const namespaces = new Map<string, XaiNamespaceBinding>()
  if (!sourceTools.some((tool) => stringValue(tool.type) === 'namespace')) return namespaces

  const occupied = new Set(sourceTools.flatMap((tool) => {
    const type = stringValue(tool.type)
    const name = optionalString(tool.name)
    return name && (type === 'function' || type === 'custom') ? [name] : []
  }))
  const flattened: JsonObject[] = []
  for (const [toolIndex, tool] of sourceTools.entries()) {
    if (stringValue(tool.type) !== 'namespace') {
      flattened.push(tool)
      continue
    }
    const namespace = optionalString(tool.name)
    if (!namespace) continue
    const children = arrayOfObjects(tool.tools ?? tool.children)
    for (const [childIndex, child] of children.entries()) {
      if (stringValue(child.type) !== 'function') continue
      const name = optionalString(child.name)
      if (!name) continue
      const wireName = xaiNamespaceWireName(namespace, name)
      const existing = namespaces.get(wireName)
      if (occupied.has(wireName) || (existing && (existing.namespace !== namespace || existing.name !== name))) {
        throw new InvalidToolBridgeError(
          `tools[${toolIndex}].tools[${childIndex}].name`,
          `namespace tool ${namespace}/${name} collides with ${wireName}`,
        )
      }
      if (existing) continue
      namespaces.set(wireName, { namespace, name, wireName })
      flattened.push({ ...child, type: 'function', name: wireName })
    }
  }
  body.tools = flattened
  rewriteXaiNamespaceCalls(body.input, namespaces)
  const choice = objectValue(body.tool_choice)
  if (stringValue(choice?.type) === 'namespace') {
    body.tool_choice = 'auto'
  } else if (choice) {
    rewriteXaiNamespaceCall(choice, namespaces)
  }
  return namespaces
}

function xaiNamespaceWireName(namespace: string, name: string): string {
  const joined = `${namespace}__${name}`
  if (safeXaiWireName(joined)) return joined
  const slug = joined.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'tool'
  const digest = createHash('sha256').update(`namespace:${namespace}\0${name}`, 'utf8').digest('hex').slice(0, 16)
  return `sp_ns_${slug}_${digest}`.slice(0, 64)
}

function rewriteXaiNamespaceCalls(value: unknown, namespaces: ReadonlyMap<string, XaiNamespaceBinding>): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteXaiNamespaceCalls(item, namespaces)
    return
  }
  const object = objectValue(value)
  if (!object) return
  if (stringValue(object.type) === 'function_call') rewriteXaiNamespaceCall(object, namespaces)
  for (const child of Object.values(object)) rewriteXaiNamespaceCalls(child, namespaces)
}

function rewriteXaiNamespaceCall(
  item: JsonObject,
  namespaces: ReadonlyMap<string, XaiNamespaceBinding>,
): void {
  const namespace = optionalString(item.namespace)
  const name = optionalString(item.name)
  if (!namespace || !name) return
  const match = [...namespaces.values()].find((binding) => binding.namespace === namespace && binding.name === name)
  if (!match) return
  item.name = match.wireName
  delete item.namespace
}

function normalizeXaiResponsesRequest(
  body: JsonObject,
  targetModel: string,
  context: ProtocolConversionContext
): JsonObject {
  const safeBody = structuredClone(body)
  const opaqueIndex = arrayOfObjects(safeBody.input).findIndex((item) => {
    const type = stringValue(item.type)
    return type === 'compaction_trigger'
      || ((type === 'compaction' || type === 'compaction_summary')
        && typeof item.encrypted_content === 'string'
        && Boolean(item.encrypted_content.trim()))
  })
  if (opaqueIndex >= 0) {
    throw new InvalidToolBridgeError(
      `input[${opaqueIndex}]`,
      'Responses compaction state cannot be discarded or expanded safely',
    )
  }
  if (safeBody.previous_response_id !== null && safeBody.previous_response_id !== undefined) {
    throw new InvalidToolBridgeError(
      'previous_response_id',
      'Responses conversation chaining cannot be discarded or expanded safely',
    )
  }
  const plan = context.toolBridgePlan ?? buildXaiToolBridgePlan(safeBody)
  context.toolBridgePlan = plan

  const hasUnsupportedInput = Array.isArray(safeBody.input)
    && arrayOfObjects(safeBody.input).some((item) => !isSupportedXaiResponsesInputItem(item))
  const hasUnsupportedTool = Array.isArray(safeBody.tools)
    && arrayOfObjects(safeBody.tools).some((tool) => {
      const type = stringValue(tool.type)
      return type !== 'custom' && !XAI_NATIVE_RESPONSES_TOOL_TYPES.has(type)
    })
  const hasUnsupportedState = [
    'previous_response_id',
    'include',
    'prompt_cache_key',
    'prompt_cache_retention',
    'safety_identifier',
    'truncation',
    'text',
    'service_tier',
    'stream_options',
  ].some((field) => safeBody[field] !== undefined)
  const hasPrivateNestedState = containsXaiField(safeBody, 'external_web_access')
  const hasGrok45Sampling = xaiModelSuffix(targetModel) === 'grok-4.5'
    && ['presence_penalty', 'presencePenalty', 'frequency_penalty', 'frequencyPenalty', 'stop']
      .some((field) => safeBody[field] !== undefined)
  if (!plan.requiresResponseBridge
    && !hasUnsupportedInput
    && !hasUnsupportedTool
    && !hasUnsupportedState
    && !hasPrivateNestedState
    && !hasGrok45Sampling) {
    return withModel(safeBody, 'openai-responses', targetModel)
  }

  for (const field of [
    'previous_response_id',
    'include',
    'prompt_cache_key',
    'prompt_cache_retention',
    'safety_identifier',
    'truncation',
    'text',
    'service_tier',
    'stream_options',
  ]) delete safeBody[field]
  removeXaiFieldRecursive(safeBody, 'external_web_access')
  if (xaiModelSuffix(targetModel) === 'grok-4.5') {
    for (const field of ['presence_penalty', 'presencePenalty', 'frequency_penalty', 'frequencyPenalty', 'stop']) {
      delete safeBody[field]
    }
  }

  if (Array.isArray(safeBody.input)) safeBody.input = normalizeXaiNativeInput(safeBody.input, context)
  const tools = normalizeXaiNativeTools(safeBody.tools, context)
  if (tools.length > 0) {
    safeBody.tools = tools
    const toolChoice = normalizeXaiNativeToolChoice(safeBody.tool_choice, tools, context)
    if (toolChoice === undefined) delete safeBody.tool_choice
    else safeBody.tool_choice = toolChoice
  } else {
    delete safeBody.tools
    delete safeBody.tool_choice
    delete safeBody.parallel_tool_calls
  }
  delete safeBody.reasoning
  applyXaiReasoning(body, safeBody)
  return withModel(safeBody, 'openai-responses', targetModel)
}

function removeXaiFieldRecursive(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    for (const item of value) removeXaiFieldRecursive(item, field)
    return
  }
  const object = objectValue(value)
  if (!object) return
  delete object[field]
  for (const child of Object.values(object)) removeXaiFieldRecursive(child, field)
}

function containsXaiField(value: unknown, field: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsXaiField(item, field))
  const object = objectValue(value)
  if (!object) return false
  return Object.hasOwn(object, field) || Object.values(object).some((child) => containsXaiField(child, field))
}

function xaiModelSuffix(model: string): string {
  return model.trim().split('/').at(-1)?.trim().toLowerCase() ?? ''
}

function normalizeXaiNativeInput(value: unknown, context: ProtocolConversionContext): JsonObject[] {
  return arrayOfObjects(value).flatMap((item, index) => {
    const type = stringValue(item.type)
    if (type === 'message' || (!type && typeof item.role === 'string')) return [item]
    if (type === 'function_call') {
      const binding = findXaiToolInPlan(context.toolBridgePlan!, 'function', stringValue(item.name))
      if (!binding) throw new InvalidToolBridgeError(`input[${index}].name`, `unknown function ${stringValue(item.name) || '<empty>'}`)
      const normalized: JsonObject = { ...item, name: binding.wireName }
      delete normalized.namespace
      return [normalized]
    }
    if (type === 'custom_tool_call') {
      const binding = findXaiToolInPlan(context.toolBridgePlan!, 'custom', stringValue(item.name))
      if (!binding) throw new InvalidToolBridgeError(`input[${index}].name`, `unknown custom tool ${stringValue(item.name) || '<empty>'}`)
      return [{
        ...item,
        type: 'function_call',
        name: binding.wireName,
        arguments: jsonString({ input: item.input }),
        input: undefined,
      }]
    }
    if (type === 'function_call_output') return [item]
    if (type === 'custom_tool_call_output') return [{ ...item, type: 'function_call_output' }]
    return []
  }).map(omitUndefined)
}

function normalizeXaiNativeTools(value: unknown, context: ProtocolConversionContext): JsonObject[] {
  const plan = context.toolBridgePlan
  if (!plan) throw new InvalidToolBridgeError('tools', 'conversion plan is missing')
  return arrayOfObjects(value).flatMap((tool) => {
    const type = stringValue(tool.type)
    if (type === 'function') {
      const binding = findXaiToolInPlan(plan, 'function', stringValue(tool.name))
      return binding ? [{ ...tool, name: binding.wireName }] : []
    }
    if (type === 'custom') {
      const binding = findXaiToolInPlan(plan, 'custom', stringValue(tool.name))
      if (!binding) return []
      return [{
        type: 'function',
        name: binding.wireName,
        description: [
          optionalString(tool.description),
          'The argument must be a JSON object with one string property named input.',
        ].filter(Boolean).join(' '),
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      }]
    }
    return XAI_NATIVE_RESPONSES_TOOL_TYPES.has(type) ? [tool] : []
  })
}

function normalizeXaiNativeToolChoice(
  value: unknown,
  tools: readonly JsonObject[],
  context: ProtocolConversionContext,
): unknown {
  if (typeof value === 'string') return ['auto', 'none', 'required'].includes(value) ? value : undefined
  const choice = objectValue(value)
  const type = stringValue(choice?.type)
  const choiceName = optionalString(choice?.name) ?? optionalString(objectValue(choice?.function)?.name)
  if ((type === 'function' || type === 'custom') && choiceName) {
    const binding = findXaiToolInPlan(context.toolBridgePlan!, type, choiceName)
    if (!binding || binding.declared === false || !tools.some((tool) => stringValue(tool.type) === 'function' && stringValue(tool.name) === binding.wireName)) return undefined
    return { type: 'function', name: binding.wireName }
  }
  if (type === 'function' || type === 'custom') return undefined
  if (XAI_NATIVE_RESPONSES_TOOL_TYPES.has(type) && tools.some((tool) => stringValue(tool.type) === type)) return choice
  return undefined
}

function restoreXaiResponsesToolCalls(
  body: JsonObject,
  context: ProtocolConversionContext
): JsonObject {
  if (!Array.isArray(body.output)) return body
  const sourceOutput = arrayOfObjects(body.output)
  for (const [index, item] of sourceOutput.entries()) {
    if (stringValue(item.type) === 'custom_tool_call') {
      throw new InvalidToolBridgeError(`output[${index}].type`, 'upstream returned an unbridged custom tool call')
    }
  }
  validateXaiResponseCallIds(sourceOutput.filter((item) => stringValue(item.type) === 'function_call'), context, 'output')
  const output = sourceOutput.map((item, index) => {
    if (stringValue(item.type) !== 'function_call') return item
    const wireName = stringValue(item.name)
    const binding = findXaiToolByWire(context, wireName)
    if (!binding) {
      throw new InvalidToolBridgeError(`output[${index}].name`, `unknown tool alias ${wireName || '<empty>'}`)
    }
    const callId = stringValue(item.call_id, stringValue(item.id))
    if (!callId) throw new InvalidToolBridgeError(`output[${index}].call_id`, 'tool call id is required')
    rememberXaiChatCall(context, callId, binding)
    if (binding.sourceType === 'custom') {
      const { arguments: _arguments, namespace: _untrustedNamespace, ...rest } = item
      return {
        ...rest,
        type: 'custom_tool_call',
        call_id: callId,
        name: binding.sourceName,
        input: parseXaiCustomWrapper(item.arguments, `output[${index}].arguments`)
      }
    }
    const { namespace: _untrustedNamespace, ...rest } = item
    return {
      ...rest,
      call_id: callId,
      name: binding.sourceName,
      ...(binding.sourceNamespace ? { namespace: binding.sourceNamespace } : {}),
    }
  })
  return { ...body, output }
}

function validateXaiResponseCallIds(
  calls: readonly JsonObject[],
  context: ProtocolConversionContext | undefined,
  path: string
): void {
  const plan = context?.toolBridgePlan
  if (!plan) return
  if (plan.parallelToolCalls === false && calls.length > 1) {
    throw new InvalidToolBridgeError(path, 'upstream returned parallel tool calls when disabled')
  }
  const used = new Set(plan.calls.map((call) => call.callId))
  for (const [index, call] of calls.entries()) {
    const callId = stringValue(call.call_id, stringValue(call.id))
    if (!callId) throw new InvalidToolBridgeError(`${path}[${index}].call_id`, 'tool call id is required')
    if (used.has(callId)) {
      throw new InvalidToolBridgeError(`${path}[${index}].call_id`, `duplicate tool call id ${callId}`)
    }
    used.add(callId)
  }
}

function isSupportedXaiResponsesInputItem(item: JsonObject): boolean {
  const type = stringValue(item.type)
  return type === 'message'
    || type === 'function_call'
    || type === 'function_call_output'
    || type === 'custom_tool_call'
    || type === 'custom_tool_call_output'
    || (!type && typeof item.role === 'string')
}

function buildXaiToolBridgePlan(
  body: JsonObject,
  namespaces: ReadonlyMap<string, XaiNamespaceBinding> = new Map(),
): ToolBridgePlan {
  const plan: ToolBridgePlan = { dialect: 'xai-grok', tools: [], calls: [] }
  if (typeof body.parallel_tool_calls === 'boolean') {
    plan.parallelToolCalls = body.parallel_tool_calls
  }
  const declaredFunctions: JsonObject[] = []
  const declaredCustoms: JsonObject[] = []
  for (const [index, tool] of arrayOfObjects(body.tools).entries()) {
    const type = stringValue(tool.type)
    if (type === 'function') declaredFunctions.push(tool)
    else if (type === 'custom') declaredCustoms.push(tool)
    // Hosted/private tools are handled by the native whitelist after the
    // function/custom bridge plan is built. Unsupported entries are dropped
    // without turning an otherwise usable Codex request into a 422.
    else if (!type && Object.keys(tool).length === 0) {
      throw new InvalidToolBridgeError(`tools[${index}]`, 'empty tool declaration')
    }
  }
  const functionNames = new Set<string>()
  const customNames = new Set<string>()
  const usedWireNames = new Set<string>()
  for (const tool of declaredFunctions) {
    const name = optionalString(tool.name)
    if (!name) throw new InvalidToolBridgeError('tools[].name', 'function name is required')
    if (functionNames.has(name)) throw new InvalidToolBridgeError('tools[].name', `duplicate function ${name}`)
    functionNames.add(name)
    if (safeXaiWireName(name)) usedWireNames.add(name)
  }
  for (const tool of declaredFunctions) {
    const name = stringValue(tool.name)
    const namespace = namespaces.get(name)
    const wireName = namespace?.wireName ?? (safeXaiWireName(name) ? name : makeXaiAlias('fn', name, usedWireNames))
    usedWireNames.add(wireName)
    plan.tools.push({
      sourceType: 'function',
      sourceName: namespace?.name ?? name,
      ...(namespace ? { sourceNamespace: namespace.namespace } : {}),
      wireName,
      declared: true,
    })
  }
  for (const tool of declaredCustoms) {
    const name = optionalString(tool.name)
    if (!name) throw new InvalidToolBridgeError('tools[].name', 'custom tool name is required')
    if (customNames.has(name)) throw new InvalidToolBridgeError('tools[].name', `duplicate custom tool ${name}`)
    customNames.add(name)
    const wireName = makeXaiAlias('custom', name, usedWireNames)
    usedWireNames.add(wireName)
    plan.tools.push({ sourceType: 'custom', sourceName: name, wireName, declared: true })
  }
  const seenHistoryCalls = new Set<string>()
  for (const [index, item] of arrayOfObjects(body.input).entries()) {
    const type = stringValue(item.type)
    if (type !== 'function_call' && type !== 'custom_tool_call' && type !== 'custom_tool_call_output' && type !== 'function_call_output') continue
    const callId = optionalString(item.call_id) ?? optionalString(item.id)
    if (!callId) throw new InvalidToolBridgeError(`input[${index}].call_id`, 'tool call id is required')
    const sourceType = type.startsWith('custom_') ? 'custom' : 'function'
    const isCall = type === 'function_call' || type === 'custom_tool_call'
    if (!isCall) {
      const existing = plan.calls.find((call) => call.callId === callId)
      if (!existing) throw new InvalidToolBridgeError(`input[${index}].call_id`, `orphan tool output ${callId}`)
      if (existing.sourceType !== sourceType) {
        throw new InvalidToolBridgeError(`input[${index}].type`, `tool output kind does not match call ${callId}`)
      }
      continue
    }
    if (seenHistoryCalls.has(callId)) {
      throw new InvalidToolBridgeError(`input[${index}].call_id`, `duplicate tool call id ${callId}`)
    }
    seenHistoryCalls.add(callId)
    const sourceName = optionalString(item.name)
    if (!sourceName) throw new InvalidToolBridgeError(`input[${index}].name`, 'tool name is required')
    const sourceNamespace = type === 'function_call' ? optionalString(item.namespace) : undefined
    if (type === 'custom_tool_call' && typeof item.input !== 'string') {
      throw new InvalidToolBridgeError(`input[${index}].input`, 'custom tool input must be a string')
    }
    if (type === 'function_call' && typeof item.arguments !== 'string') {
      throw new InvalidToolBridgeError(`input[${index}].arguments`, 'function arguments must be a string')
    }
    let binding = sourceNamespace
      ? plan.tools.find((candidate) => candidate.sourceType === sourceType
        && candidate.sourceName === sourceName
        && candidate.sourceNamespace === sourceNamespace)
      : findXaiToolInPlan(plan, sourceType, sourceName)
    if (sourceName && !binding) {
      const namespaceWireName = sourceNamespace ? xaiNamespaceWireName(sourceNamespace, sourceName) : undefined
      if (namespaceWireName && usedWireNames.has(namespaceWireName)) {
        throw new InvalidToolBridgeError(`input[${index}].name`, `namespace history collides with ${namespaceWireName}`)
      }
      const wireName = namespaceWireName
        ?? (sourceType === 'function' && safeXaiWireName(sourceName) && !usedWireNames.has(sourceName)
          ? sourceName
          : makeXaiAlias(sourceType === 'custom' ? 'custom' : 'fn', sourceName, usedWireNames))
      binding = {
        sourceType,
        sourceName,
        ...(sourceNamespace ? { sourceNamespace } : {}),
        wireName,
        declared: false,
      }
      plan.tools.push(binding)
      usedWireNames.add(wireName)
    }
    if (sourceNamespace && binding) {
      item.name = binding.wireName
      delete item.namespace
    }
    rememberXaiCallBinding(plan, {
      callId,
      sourceType,
      sourceName: binding?.sourceName ?? sourceName,
      sourceNamespace: binding?.sourceNamespace,
      wireName: binding?.wireName,
    })
  }
  // Once a current request declares a callable tool, every response must pass
  // through the request-scoped authorizer. This keeps safe-name functions and
  // aliased/custom/namespace functions on identical fail-closed semantics.
  plan.requiresResponseBridge = plan.tools.length > 0
  return plan
}

function safeXaiWireName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

function makeXaiAlias(kind: 'fn' | 'custom', sourceName: string, used: ReadonlySet<string>): string {
  const slug = sourceName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'tool'
  const digest = createHash('sha256').update(`${kind}:${sourceName}`, 'utf8').digest('hex')
  for (let length = 12; length <= digest.length; length += 4) {
    const alias = `sp_${kind}_${slug}_${digest.slice(0, length)}`.slice(0, 64)
    if (!used.has(alias)) return alias
  }
  throw new InvalidToolBridgeError('tools[].name', `could not create a collision-free alias for ${sourceName}`)
}

function findXaiTool(context: ProtocolConversionContext | undefined, sourceType: ToolBridgeBinding['sourceType'], sourceName: string): ToolBridgeBinding | undefined {
  return context?.toolBridgePlan?.tools.find((binding) => binding.sourceType === sourceType
    && (binding.sourceName === sourceName || (binding.sourceNamespace !== undefined && binding.wireName === sourceName)))
}

function findXaiToolByWire(context: ProtocolConversionContext | undefined, wireName: string): ToolBridgeBinding | undefined {
  return context?.toolBridgePlan?.tools.find((binding) => binding.wireName === wireName && binding.declared !== false)
}

function resolveResponsesChatToolBinding(
  context: ProtocolConversionContext | undefined,
  wireName: string,
): ToolBridgeBinding | undefined {
  const declared = findXaiToolByWire(context, wireName)
  if (declared || context?.dialect !== 'deepseek-chat' || !context.toolBridgePlan) return declared
  return resolveDeepSeekToolBinding(context.toolBridgePlan, wireName)
}

function findXaiToolInPlan(plan: ToolBridgePlan, sourceType: ToolBridgeBinding['sourceType'], sourceName: string): ToolBridgeBinding | undefined {
  return plan.tools.find((binding) => binding.sourceType === sourceType
    && (binding.sourceName === sourceName || (binding.sourceNamespace !== undefined && binding.wireName === sourceName)))
}

function findXaiCall(context: ProtocolConversionContext | undefined, callId: string): ToolCallBridgeBinding | undefined {
  return context?.toolBridgePlan?.calls.find((binding) => binding.callId === callId)
}

function rememberXaiCallBinding(plan: ToolBridgePlan, binding: ToolCallBridgeBinding): void {
  const existing = plan.calls.find((call) => call.callId === binding.callId)
  if (existing) {
    if (existing.sourceType !== binding.sourceType
      || (existing.wireName && binding.wireName && existing.wireName !== binding.wireName)
      || (existing.sourceNamespace && binding.sourceNamespace && existing.sourceNamespace !== binding.sourceNamespace)) {
      throw new InvalidToolBridgeError('input[].call_id', `call id ${binding.callId} changes tool kind`)
    }
    if (!existing.sourceName && binding.sourceName) existing.sourceName = binding.sourceName
    if (!existing.sourceNamespace && binding.sourceNamespace) existing.sourceNamespace = binding.sourceNamespace
    if (!existing.wireName && binding.wireName) existing.wireName = binding.wireName
    return
  }
  plan.calls.push(binding)
}

function rememberXaiCall(context: ProtocolConversionContext | undefined, item: JsonObject, sourceType: ToolBridgeBinding['sourceType']): void {
  const plan = context?.toolBridgePlan
  if (!plan) return
  const callId = optionalString(item.call_id) ?? optionalString(item.id)
  if (!callId) return
  const sourceName = optionalString(item.name)
  const binding = sourceName
    ? findXaiTool(context, sourceType, sourceName)
      ?? (sourceType === 'function' ? findXaiToolByWire(context, sourceName) : undefined)
    : undefined
  rememberXaiCallBinding(plan, {
    callId,
    sourceType: binding?.sourceType ?? sourceType,
    sourceName: binding?.sourceName ?? sourceName,
    sourceNamespace: binding?.sourceNamespace,
    wireName: binding?.wireName,
  })
}

function rememberXaiOutput(context: ProtocolConversionContext | undefined, item: JsonObject, sourceType?: ToolBridgeBinding['sourceType']): void {
  const plan = context?.toolBridgePlan
  if (!plan) return
  const callId = optionalString(item.call_id) ?? optionalString(item.id)
  if (!callId) return
  const existing = findXaiCall(context, callId)
  if (existing || !sourceType) return
  rememberXaiCallBinding(plan, { callId, sourceType })
}

function rememberXaiChatCall(context: ProtocolConversionContext | undefined, callId: string, binding: ToolBridgeBinding): void {
  if (context?.toolBridgePlan) rememberXaiCallBinding(context.toolBridgePlan, {
    callId,
    sourceType: binding.sourceType,
    sourceName: binding.sourceName,
    sourceNamespace: binding.sourceNamespace,
    wireName: binding.wireName,
  })
}

function parseXaiCustomWrapper(value: unknown, path: string): string {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { throw new InvalidToolBridgeError(path, 'custom arguments are not valid JSON') }
  }
  const object = objectValue(parsed)
  if (!object || typeof object.input !== 'string' || Object.keys(object).some((key) => key !== 'input')) {
    throw new InvalidToolBridgeError(path, 'custom arguments must be exactly { input: string }')
  }
  return object.input
}

function parseToolArgumentsObject(value: unknown, path: string): JsonObject {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new InvalidToolBridgeError(path, 'tool arguments are not valid JSON')
    }
  }
  const object = objectValue(parsed)
  if (!object) throw new InvalidToolBridgeError(path, 'tool arguments must be a JSON object')
  return object
}

function applyXaiReasoning(body: JsonObject, output: JsonObject): void {
  const effort = stringValue(objectValue(body.reasoning)?.effort).trim().toLowerCase()
  const mapped = effort === 'minimal' || effort === 'low' ? 'low'
    : effort === 'medium' ? 'medium'
      : effort === 'high' || effort === 'xhigh' || effort === 'max' ? 'high'
        : undefined
  if (mapped) output.reasoning_effort = mapped
}

function applyXaiChatRequestOptions(body: JsonObject, context?: ProtocolConversionContext): JsonObject {
  if (context?.dialect !== 'xai-grok' || body.stream !== true) return body
  const current = objectValue(body.stream_options)
  return { ...body, stream_options: { ...current, include_usage: true } }
}

function anthropicRequestToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const system = textValue(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const message of arrayOfObjects(body.messages)) {
    if (stringValue(message.role, 'user') === 'assistant') {
      messages.push(anthropicAssistantMessageToChat(message))
    } else {
      messages.push(...anthropicUserMessageToChat(message))
    }
  }
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_tokens),
    stream: booleanValue(body.stream)
  }
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const stopSequences = stringArray(body.stop_sequences)
  if (stopSequences !== undefined) output.stop = stopSequences
  const tools = anthropicToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = anthropicToolChoiceToChat(body.tool_choice)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  const anthropicToolChoice = objectValue(body.tool_choice)
  if (typeof anthropicToolChoice?.disable_parallel_tool_use === 'boolean') {
    output.parallel_tool_calls = !anthropicToolChoice.disable_parallel_tool_use
  }
  return omitUndefined(output)
}

function chatRequestToAnthropic(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const systemParts: string[] = []
  let pendingToolResults: JsonObject[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'system' || role === 'developer') {
      const content = chatContentToText(message.content)
      if (content) systemParts.push(content)
      continue
    }
    if (role === 'tool' || role === 'function') {
      pendingToolResults.push(chatToolMessageToAnthropicResult(message))
      continue
    }
    if (role === 'assistant') {
      flushToolResults()
      messages.push({ role: 'assistant', content: chatMessageToAnthropicContent(message) })
      continue
    }

    const content = chatMessageToAnthropicContent(message)
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: [...pendingToolResults, ...content] })
      pendingToolResults = []
    } else {
      messages.push({ role: 'user', content })
    }
  }
  flushToolResults()
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_tokens) ?? numberValue(body.max_completion_tokens) ?? 1024,
    stream: booleanValue(body.stream)
  }
  if (systemParts.length > 0) output.system = systemParts.join('\n\n')
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const stopSequences = chatStopToAnthropic(body.stop)
  if (stopSequences !== undefined) output.stop_sequences = stopSequences
  const tools = chatToolsToAnthropic(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = chatToolChoiceToAnthropic(body.tool_choice, body.parallel_tool_calls)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function responsesRequestToChat(body: JsonObject, model: string, context?: ProtocolConversionContext): JsonObject {
  const messages: JsonObject[] = []
  const instructions = textValue(body.instructions)
  if (instructions) messages.push({ role: 'system', content: instructions })
  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else {
    let functionCallMessage: JsonObject | undefined
    for (const item of arrayOfObjects(input)) {
      const type = stringValue(item.type)
      if (type === 'message' || (!type && typeof item.role === 'string')) {
        const message: JsonObject = {
          role: stringValue(item.role, 'user'),
          content: responsesContentToChatContent(item.content)
        }
        messages.push(message)
        functionCallMessage = stringValue(message.role) === 'assistant' ? message : undefined
        continue
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        if (!functionCallMessage) {
          functionCallMessage = { role: 'assistant', content: null, tool_calls: [] }
          messages.push(functionCallMessage)
        }
        const toolCalls = arrayValue(functionCallMessage.tool_calls)
        functionCallMessage.tool_calls = [...toolCalls, responsesFunctionCallToChat(item, context)]
        rememberXaiCall(context, item, type === 'custom_tool_call' ? 'custom' : 'function')
        continue
      }
      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: stringValue(item.call_id, stringValue(item.id)),
          content: responsesFunctionOutputToChat(item.output)
        })
        rememberXaiOutput(context, item, type === 'custom_tool_call_output' ? 'custom' : undefined)
        functionCallMessage = undefined
        continue
      }
      functionCallMessage = undefined
    }
  }
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_output_tokens),
    stream: booleanValue(body.stream)
  }
  copyOptional(body, output, [
    'temperature', 'top_p', 'metadata', 'parallel_tool_calls',
    'store', 'service_tier', 'safety_identifier', 'user',
  ])
  const reasoningEffort = normalizeReasoningEffort(objectValue(body.reasoning)?.effort)
  if (reasoningEffort) output.reasoning_effort = reasoningEffort
  const tools = usesResponsesChatToolBridge(context)
    ? xaiResponsesToolsToChat(body.tools, context!)
    : responsesToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  if (tools.length > 0) {
    const toolChoice = usesResponsesChatToolBridge(context)
      ? xaiResponsesToolChoiceToChat(body.tool_choice, context!)
      : responsesToolChoiceToChat(body.tool_choice)
    if (toolChoice !== undefined) output.tool_choice = toolChoice
  } else if (usesResponsesChatToolBridge(context)) {
    delete output.parallel_tool_calls
  }
  if (context?.dialect === 'xai-grok') {
    applyXaiReasoning(body, output)
    return applyXaiChatRequestOptions(omitUndefined(output), context)
  }
  return omitUndefined(output)
}

function chatRequestToResponses(
  body: JsonObject,
  model: string,
  context?: ProtocolConversionContext,
  keepXaiWireTools = false
): JsonObject {
  const input: JsonObject[] = []
  const instructions: string[] = []
  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'system' || role === 'developer') {
      const text = chatContentToText(message.content)
      if (text) instructions.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const callId = stringValue(message.tool_call_id, stringValue(message.name))
      const binding = findXaiCall(context, callId)
      if (context?.dialect === 'xai-grok' && !binding) {
        throw new InvalidToolBridgeError(`messages[].tool_call_id`, `unknown tool call ${callId || '<empty>'}`)
      }
      input.push({
        type: keepXaiWireTools ? 'function_call_output'
          : binding?.sourceType === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
        call_id: callId,
        output: chatToolOutputToResponses(message.content)
      })
      continue
    }
    const content = chatContentToResponses(message.content, role === 'assistant')
    if (role === 'assistant') {
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content })
      for (const toolCall of chatMessageToolCalls(message)) {
        input.push(keepXaiWireTools
          ? chatFunctionCallToXaiResponsesWire(toolCall, context)
          : chatFunctionCallToResponses(toolCall, context))
      }
      continue
    }
    input.push({ type: 'message', role, content })
  }
  const output: JsonObject = {
    model,
    input,
    max_output_tokens: numberValue(body.max_tokens) ?? numberValue(body.max_completion_tokens),
    stream: booleanValue(body.stream)
  }
  if (instructions.length > 0) output.instructions = instructions.join('\n\n')
  copyOptional(body, output, ['temperature', 'top_p', 'metadata', 'parallel_tool_calls'])
  const tools = keepXaiWireTools
    ? chatToolsToResponses(body.tools)
    : context?.dialect === 'xai-grok'
    ? xaiChatToolsToResponses(body.tools, context)
    : chatToolsToResponses(body.tools)
  if (tools.length > 0) output.tools = tools
  if (tools.length > 0) {
    const toolChoice = keepXaiWireTools
      ? chatToolChoiceToResponses(body.tool_choice)
      : context?.dialect === 'xai-grok'
      ? xaiChatToolChoiceToResponses(body.tool_choice, context)
      : chatToolChoiceToResponses(body.tool_choice)
    if (toolChoice !== undefined) output.tool_choice = toolChoice
  } else if (context?.dialect === 'xai-grok') {
    delete output.parallel_tool_calls
  }
  return omitUndefined(output)
}

/** Direct Responses -> Anthropic request conversion without allocating a full
 * OpenAI Chat request as an intermediate representation. */
function responsesRequestToAnthropic(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const systemParts: string[] = []
  const instructions = textValue(body.instructions)
  if (instructions) systemParts.push(instructions)
  let pendingToolResults: JsonObject[] = []
  let assistantContent: JsonObject[] | undefined

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }
  const pushTextMessage = (role: string, value: unknown): void => {
    const content = responsesContentToAnthropicContent(value)
    if (role === 'system' || role === 'developer') {
      const text = responsesContentToChat(value)
      if (text) systemParts.push(text)
      assistantContent = undefined
      return
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })
    if (role === 'assistant') {
      flushToolResults()
      messages.push({ role: 'assistant', content })
      assistantContent = content
      return
    }
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: [...pendingToolResults, ...content] })
      pendingToolResults = []
    } else {
      messages.push({ role: 'user', content })
    }
    assistantContent = undefined
  }

  if (typeof body.input === 'string') {
    pushTextMessage('user', body.input)
  } else {
    for (const item of arrayOfObjects(body.input)) {
      const type = stringValue(item.type)
      if (type === 'message' || (!type && typeof item.role === 'string')) {
        pushTextMessage(stringValue(item.role, 'user'), item.content)
        continue
      }
      if (type === 'function_call') {
        flushToolResults()
        if (!assistantContent) {
          assistantContent = []
          messages.push({ role: 'assistant', content: assistantContent })
        }
        assistantContent.push({
          type: 'tool_use',
          id: stringValue(item.call_id, stringValue(item.id)),
          name: stringValue(item.name),
          input: parseJsonObject(item.arguments, 'Responses function_call.arguments')
        })
        continue
      }
      if (type === 'function_call_output') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: stringValue(item.call_id, stringValue(item.id)),
          content: responsesFunctionOutputToAnthropic(item.output)
        })
        assistantContent = undefined
        continue
      }
      assistantContent = undefined
    }
  }
  flushToolResults()

  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_output_tokens) ?? 1024,
    stream: booleanValue(body.stream)
  }
  if (systemParts.length > 0) output.system = systemParts.join('\n\n')
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const tools = responsesToolsToAnthropic(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = responsesToolChoiceToAnthropic(body.tool_choice, body.parallel_tool_calls)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  applyResponsesReasoningToAnthropic(body, output, model)
  return omitUndefined(output)
}

/** Direct Anthropic -> Responses conversion. Tool argument objects are encoded
 * exactly once, when the target wire format actually requires a JSON string. */
function anthropicRequestToResponses(body: JsonObject, model: string): JsonObject {
  const input: JsonObject[] = []
  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : arrayOfObjects(message.content)
    if (role === 'assistant') {
      let textContent: JsonObject[] = []
      const flushText = (): void => {
        if (textContent.length === 0) return
        input.push({ type: 'message', role: 'assistant', content: textContent })
        textContent = []
      }
      for (const block of blocks) {
        const type = stringValue(block.type)
        if (type === 'text') {
          const text = stringValue(block.text)
          if (text) textContent.push({ type: 'output_text', text })
        } else if (type === 'tool_use') {
          flushText()
          input.push({
            type: 'function_call',
            call_id: stringValue(block.id),
            name: stringValue(block.name),
            arguments: jsonString(block.input ?? {})
          })
        }
      }
      flushText()
      continue
    }

    let messageContent: JsonObject[] = []
    let emitted = false
    const flushMessage = (): void => {
      if (messageContent.length === 0) return
      input.push({ type: 'message', role: 'user', content: messageContent })
      messageContent = []
      emitted = true
    }
    for (const block of blocks) {
      if (stringValue(block.type) === 'tool_result') {
        flushMessage()
        input.push({
          type: 'function_call_output',
          call_id: stringValue(block.tool_use_id),
          output: anthropicToolResultToResponses(block.content)
        })
        emitted = true
      } else if (stringValue(block.type) === 'text') {
        const text = stringValue(block.text)
        if (text) messageContent.push({ type: 'input_text', text })
      } else if (stringValue(block.type) === 'image') {
        const image = anthropicImageUrl(block)
        if (image) messageContent.push({ type: 'input_image', image_url: image })
      }
    }
    flushMessage()
    if (!emitted) input.push({ type: 'message', role: 'user', content: [] })
  }

  const output: JsonObject = {
    model,
    input,
    max_output_tokens: numberValue(body.max_tokens),
    stream: booleanValue(body.stream)
  }
  const instructions = textValue(body.system)
  if (instructions) output.instructions = instructions
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const anthropicChoice = objectValue(body.tool_choice)
  if (typeof anthropicChoice?.disable_parallel_tool_use === 'boolean') {
    output.parallel_tool_calls = !anthropicChoice.disable_parallel_tool_use
  }
  const tools = anthropicToolsToResponses(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = anthropicToolChoiceToResponses(body.tool_choice)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  applyAnthropicReasoningToResponses(body, output)
  return omitUndefined(output)
}

function applyResponsesReasoningToAnthropic(body: JsonObject, output: JsonObject, model: string): void {
  const effort = normalizeReasoningEffort(objectValue(body.reasoning)?.effort)
  if (!effort) return
  const family = claudeThinkingFamily(model)
  if (family === 'adaptive') {
    output.thinking = { type: 'adaptive', display: 'omitted' }
    output.output_config = { effort: claudeAdaptiveEffort(effort, model) }
    delete output.temperature
    return
  }
  if (family !== 'legacy') return
  const maxTokens = numberValue(output.max_tokens)
  if (maxTokens === undefined || maxTokens <= 1_024) return
  const requestedBudget = effort === 'low' ? 1_024
    : effort === 'medium' ? 4_096
      : effort === 'high' ? 8_192
        : effort === 'xhigh' ? 16_384 : 32_768
  output.thinking = {
    type: 'enabled',
    budget_tokens: Math.min(requestedBudget, maxTokens - 1),
    display: 'omitted'
  }
  delete output.temperature
}

function applyAnthropicReasoningToResponses(body: JsonObject, output: JsonObject): void {
  const thinking = objectValue(body.thinking)
  const thinkingType = stringValue(thinking?.type).trim().toLowerCase()
  const configuredEffort = normalizeReasoningEffort(objectValue(body.output_config)?.effort)
  if (configuredEffort) {
    output.reasoning = { effort: configuredEffort }
    return
  }
  if (thinkingType === 'adaptive' || thinkingType === 'enabled') output.reasoning = { effort: 'high' }
}

type NormalizedReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

function normalizeReasoningEffort(value: unknown): NormalizedReasoningEffort | undefined {
  const effort = stringValue(value).trim().toLowerCase()
  if (effort === 'minimal' || effort === 'low') return 'low'
  if (effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') return effort
  return undefined
}

function claudeThinkingFamily(model: string): 'adaptive' | 'legacy' | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized.includes('claude')) return undefined
  if (/mythos(?:[-_. ]preview)?/.test(normalized)) return 'adaptive'
  const familyFirst = normalized.match(/(?:opus|sonnet|haiku|fable|mythos)[-_. ]+(\d+)(?:[-_. ]+(\d+))?/)
  const versionFirst = normalized.match(/claude[-_. ]+(\d+)(?:[-_. ]+(\d+))?[-_. ]+(?:opus|sonnet|haiku|fable|mythos)/)
  const version = versionFirst ?? familyFirst
  if (!version) return undefined
  const major = Number(version[1])
  const parsedMinor = Number(version[2] ?? 0)
  // Older Anthropic IDs put a release date immediately after the major
  // version (for example claude-opus-4-20250514); it is not model 4.20M.
  const minor = parsedMinor >= 1_000 ? 0 : parsedMinor
  if (major >= 5) return 'adaptive'
  if (major === 4 && minor >= 6 && /(?:opus|sonnet)/.test(normalized)) return 'adaptive'
  return 'legacy'
}

function claudeAdaptiveEffort(effort: NormalizedReasoningEffort, model: string): NormalizedReasoningEffort {
  if (effort !== 'xhigh') return effort
  const normalized = model.trim().toLowerCase()
  const supportsXhigh = /(?:opus[-_. ]+4[-_. ]+(?:7|8)|claude[-_. ]+4[-_. ]+(?:7|8)[-_. ]+opus|sonnet[-_. ]+5|claude[-_. ]+5[-_. ]+sonnet|fable[-_. ]+5|mythos)/.test(normalized)
  return supportsXhigh ? 'xhigh' : 'high'
}

/** Direct Responses -> Gemini conversion. */
function responsesRequestToGemini(body: JsonObject): JsonObject {
  const contents: JsonObject[] = []
  const systemParts: string[] = []
  const instructions = textValue(body.instructions)
  if (instructions) systemParts.push(instructions)
  const callNames = new Map<string, string>()
  let pendingToolResponses: JsonObject[] = []
  let assistantParts: JsonObject[] | undefined

  const flushToolResponses = (): void => {
    if (pendingToolResponses.length === 0) return
    contents.push({ role: 'user', parts: pendingToolResponses })
    pendingToolResponses = []
  }
  const pushMessage = (role: string, value: unknown): void => {
    const text = responsesContentToChat(value)
    if (role === 'system' || role === 'developer') {
      if (text) systemParts.push(text)
      assistantParts = undefined
      return
    }
    const parts = responsesContentToGeminiParts(value)
    if (parts.length === 0) parts.push({ text: '' })
    if (role === 'assistant') {
      flushToolResponses()
      contents.push({ role: 'model', parts })
      assistantParts = parts
      return
    }
    if (pendingToolResponses.length > 0) {
      contents.push({ role: 'user', parts: [...pendingToolResponses, ...parts] })
      pendingToolResponses = []
    } else {
      contents.push({ role: 'user', parts })
    }
    assistantParts = undefined
  }

  if (typeof body.input === 'string') {
    pushMessage('user', body.input)
  } else {
    for (const item of arrayOfObjects(body.input)) {
      const type = stringValue(item.type)
      if (type === 'message' || (!type && typeof item.role === 'string')) {
        pushMessage(stringValue(item.role, 'user'), item.content)
        continue
      }
      if (type === 'function_call') {
        flushToolResponses()
        if (!assistantParts) {
          assistantParts = []
          contents.push({ role: 'model', parts: assistantParts })
        }
        const id = stringValue(item.call_id, stringValue(item.id))
        const name = stringValue(item.name)
        if (id) callNames.set(id, name)
        assistantParts.push({
          functionCall: omitUndefined({
            id: optionalString(id),
            name,
            args: parseJsonObject(item.arguments, 'Responses function_call.arguments')
          })
        })
        continue
      }
      if (type === 'function_call_output') {
        const id = stringValue(item.call_id, stringValue(item.id))
        pendingToolResponses.push({
          functionResponse: omitUndefined({
            id: optionalString(id),
            name: callNames.get(id) ?? '',
            response: responsesFunctionOutputToGemini(item.output)
          })
        })
        assistantParts = undefined
        continue
      }
      assistantParts = undefined
    }
  }
  flushToolResponses()

  const generationConfig = omitUndefined({
    maxOutputTokens: numberValue(body.max_output_tokens),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p)
  })
  const output: JsonObject = { contents }
  if (systemParts.length > 0) output.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
  if (Object.keys(generationConfig).length > 0) output.generationConfig = generationConfig
  const declarations = responsesToolsToGeminiDeclarations(body.tools)
  if (declarations.length > 0) output.tools = [{ functionDeclarations: declarations }]
  const toolConfig = responsesToolChoiceToGemini(body.tool_choice)
  if (toolConfig) output.toolConfig = toolConfig
  return output
}

/** Direct Gemini -> Responses conversion. */
function geminiRequestToResponses(body: JsonObject, model: string): JsonObject {
  const input: JsonObject[] = []
  const pendingCallIds = new Map<string, string[]>()
  let generatedCallId = 0
  for (const content of arrayOfObjects(body.contents)) {
    const parts = arrayOfObjects(content.parts)
    if (stringValue(content.role) === 'model') {
      const text = geminiPartsToText(parts)
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const part of parts) {
        const call = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (!call) continue
        const name = stringValue(call.name)
        const id = optionalString(call.id) ?? `call_gemini_${++generatedCallId}`
        const ids = pendingCallIds.get(name) ?? []
        ids.push(id)
        pendingCallIds.set(name, ids)
        input.push({
          type: 'function_call',
          call_id: id,
          name,
          arguments: jsonString(call.args ?? {})
        })
      }
      continue
    }

    const text = geminiPartsToText(parts)
    const messageContent: JsonObject[] = []
    if (text) messageContent.push({ type: 'input_text', text })
    for (const part of parts) {
      const image = geminiImagePartToUrl(part)
      if (image) messageContent.push({ type: 'input_image', image_url: image })
    }
    let hasFunctionResponse = false
    for (const part of parts) {
      const response = objectValue(part.functionResponse) ?? objectValue(part.function_response)
      if (!response) continue
      hasFunctionResponse = true
      const name = stringValue(response.name)
      const queuedIds = pendingCallIds.get(name) ?? []
      const explicitId = optionalString(response.id)
      let id: string
      if (explicitId) {
        id = explicitId
        const queuedIndex = queuedIds.indexOf(explicitId)
        if (queuedIndex >= 0) queuedIds.splice(queuedIndex, 1)
      } else {
        id = queuedIds.shift() ?? `call_gemini_${++generatedCallId}`
      }
      pendingCallIds.set(name, queuedIds)
      input.push({
        type: 'function_call_output',
        call_id: id,
        output: geminiFunctionResponseToResponses(response.response)
      })
    }
    if (messageContent.length > 0 || !hasFunctionResponse) {
      input.push({ type: 'message', role: 'user', content: messageContent })
    }
  }

  const generationConfig = objectValue(body.generationConfig) ?? objectValue(body.generation_config) ?? {}
  const output: JsonObject = {
    model,
    input,
    max_output_tokens: numberValue(generationConfig.maxOutputTokens),
    stream: booleanValue(body.stream)
  }
  const systemInstruction = objectValue(body.systemInstruction) ?? objectValue(body.system_instruction)
  const instructions = systemInstruction ? geminiPartsToText(systemInstruction.parts) : ''
  if (instructions) output.instructions = instructions
  copyGeminiGenerationOptionsToResponses(generationConfig, output)
  const tools = geminiToolsToResponses(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = geminiToolChoiceToResponses(body.toolConfig ?? body.tool_config)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function anthropicRequestToGemini(body: JsonObject): JsonObject {
  const contents: JsonObject[] = []
  const callNames = new Map<string, string>()
  let pendingToolResponses: JsonObject[] = []

  const flushToolResponses = (): void => {
    if (pendingToolResponses.length === 0) return
    contents.push({ role: 'user', parts: pendingToolResponses })
    pendingToolResponses = []
  }
  const pushUserText = (text: string): void => {
    pushUserParts([{ text }])
  }
  const pushUserParts = (parts: JsonObject[]): void => {
    if (pendingToolResponses.length > 0) {
      contents.push({ role: 'user', parts: [...pendingToolResponses, ...parts] })
      pendingToolResponses = []
    } else {
      contents.push({ role: 'user', parts })
    }
  }

  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'assistant') {
      flushToolResponses()
      const parts: JsonObject[] = []
      if (typeof message.content === 'string') {
        if (message.content) parts.push({ text: message.content })
      } else {
        const blocks = arrayOfObjects(message.content)
        for (const block of blocks) {
          const type = stringValue(block.type)
          if (type === 'text') {
            const text = stringValue(block.text)
            if (text) parts.push({ text })
          } else if (type === 'tool_use') {
            const id = stringValue(block.id)
            const name = stringValue(block.name)
            if (id) callNames.set(id, name)
            parts.push({
              functionCall: omitUndefined({
                id: optionalString(id),
                name,
                args: parseJsonObject(block.input, 'Anthropic tool_use.input')
              })
            })
          }
        }
      }
      if (parts.length === 0) parts.push({ text: '' })
      contents.push({ role: 'model', parts })
      continue
    }

    if (typeof message.content === 'string') {
      pushUserText(message.content)
      continue
    }
    const blocks = arrayOfObjects(message.content)
    let messageParts: JsonObject[] = []
    let emitted = false
    const flushParts = (): void => {
      if (messageParts.length === 0) return
      pushUserParts(messageParts)
      messageParts = []
      emitted = true
    }
    for (const block of blocks) {
      if (stringValue(block.type) === 'tool_result') {
        flushParts()
        const id = stringValue(block.tool_use_id)
        pendingToolResponses.push({
          functionResponse: omitUndefined({
            id: optionalString(id),
            name: callNames.get(id) ?? '',
            response: anthropicToolResultToGemini(block.content)
          })
        })
        emitted = true
      } else if (stringValue(block.type) === 'text') {
        const text = stringValue(block.text)
        if (text) messageParts.push({ text })
      } else if (stringValue(block.type) === 'image') {
        const url = anthropicImageUrl(block)
        const image = url ? imageUrlToGemini(url) : undefined
        if (image) messageParts.push(image)
      }
    }
    flushParts()
    if (!emitted) pushUserText('')
  }
  flushToolResponses()

  const generationConfig = omitUndefined({
    maxOutputTokens: numberValue(body.max_tokens),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    stopSequences: stringArray(body.stop_sequences)
  })
  const output: JsonObject = { contents }
  const system = textValue(body.system)
  if (system) output.systemInstruction = { parts: [{ text: system }] }
  if (Object.keys(generationConfig).length > 0) output.generationConfig = generationConfig
  const declarations = anthropicToolsToGeminiDeclarations(body.tools)
  if (declarations.length > 0) output.tools = [{ functionDeclarations: declarations }]
  const toolConfig = anthropicToolChoiceToGemini(body.tool_choice)
  if (toolConfig) output.toolConfig = toolConfig
  return output
}

function geminiRequestToAnthropic(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const pendingCallIds = new Map<string, string[]>()
  let generatedCallId = 0
  let pendingToolResults: JsonObject[] = []
  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const content of arrayOfObjects(body.contents)) {
    const parts = arrayOfObjects(content.parts)
    if (stringValue(content.role) === 'model') {
      flushToolResults()
      const blocks: JsonObject[] = []
      const text = geminiPartsToText(parts)
      if (text) blocks.push({ type: 'text', text })
      for (const part of parts) {
        const call = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (!call) continue
        const name = stringValue(call.name)
        const id = optionalString(call.id) ?? `call_gemini_${++generatedCallId}`
        const ids = pendingCallIds.get(name) ?? []
        ids.push(id)
        pendingCallIds.set(name, ids)
        blocks.push({
          type: 'tool_use',
          id,
          name,
          input: parseJsonObject(call.args, 'Gemini functionCall.args')
        })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      messages.push({ role: 'assistant', content: blocks })
      continue
    }

    const text = geminiPartsToText(parts)
    const userBlocks: JsonObject[] = []
    if (text) userBlocks.push({ type: 'text', text })
    for (const part of parts) {
      const imageUrl = geminiImagePartToUrl(part)
      const image = imageUrl ? imageUrlToAnthropic(imageUrl) : undefined
      if (image) userBlocks.push(image)
    }
    let hasFunctionResponse = false
    for (const part of parts) {
      const response = objectValue(part.functionResponse) ?? objectValue(part.function_response)
      if (!response) continue
      hasFunctionResponse = true
      const name = stringValue(response.name)
      const queuedIds = pendingCallIds.get(name) ?? []
      const explicitId = optionalString(response.id)
      let id: string
      if (explicitId) {
        id = explicitId
        const queuedIndex = queuedIds.indexOf(explicitId)
        if (queuedIndex >= 0) queuedIds.splice(queuedIndex, 1)
      } else {
        id = queuedIds.shift() ?? `call_gemini_${++generatedCallId}`
      }
      pendingCallIds.set(name, queuedIds)
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: geminiFunctionResponseToAnthropic(response.response)
      })
    }
    if (userBlocks.length > 0 || !hasFunctionResponse) {
      if (userBlocks.length === 0) userBlocks.push({ type: 'text', text: '' })
      messages.push({ role: 'user', content: pendingToolResults.length > 0
        ? [...pendingToolResults, ...userBlocks]
        : userBlocks })
      pendingToolResults = []
    }
  }
  flushToolResults()

  const generationConfig = objectValue(body.generationConfig) ?? objectValue(body.generation_config) ?? {}
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(generationConfig.maxOutputTokens) ?? 1024,
    stream: booleanValue(body.stream)
  }
  const systemInstruction = objectValue(body.systemInstruction) ?? objectValue(body.system_instruction)
  const system = systemInstruction ? geminiPartsToText(systemInstruction.parts) : ''
  if (system) output.system = system
  const temperature = numberValue(generationConfig.temperature)
  const topP = numberValue(generationConfig.topP)
  const stopSequences = stringArray(generationConfig.stopSequences)
  if (temperature !== undefined) output.temperature = temperature
  if (topP !== undefined) output.top_p = topP
  if (stopSequences !== undefined) output.stop_sequences = stopSequences
  const tools = geminiToolsToAnthropic(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = geminiToolChoiceToAnthropic(body.toolConfig ?? body.tool_config)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function geminiRequestToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const pendingCallIds = new Map<string, string[]>()
  let generatedCallId = 0
  const systemInstruction = objectValue(body.systemInstruction) ?? objectValue(body.system_instruction)
  if (systemInstruction) {
    const text = geminiPartsToText(systemInstruction.parts)
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const content of arrayOfObjects(body.contents)) {
    const parts = arrayOfObjects(content.parts)
    if (stringValue(content.role) === 'model') {
      const text = geminiPartsToText(parts)
      const toolCalls: JsonObject[] = []
      for (const part of parts) {
        const call = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (!call) continue
        const name = stringValue(call.name)
        const id = optionalString(call.id) ?? `call_gemini_${++generatedCallId}`
        const ids = pendingCallIds.get(name) ?? []
        ids.push(id)
        pendingCallIds.set(name, ids)
        toolCalls.push({
          id,
          type: 'function',
          function: { name, arguments: jsonString(call.args ?? {}) }
        })
      }
      const message: JsonObject = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      messages.push(message)
      continue
    }

    const text = geminiPartsToText(parts)
    const userContent: JsonObject[] = []
    if (text) userContent.push({ type: 'text', text })
    for (const part of parts) {
      const image = geminiImagePartToUrl(part)
      if (image) userContent.push({ type: 'image_url', image_url: { url: image } })
    }
    for (const part of parts) {
      const response = objectValue(part.functionResponse) ?? objectValue(part.function_response)
      if (!response) continue
      const name = stringValue(response.name)
      const queuedIds = pendingCallIds.get(name) ?? []
      const explicitId = optionalString(response.id)
      let id: string
      if (explicitId) {
        id = explicitId
        const queuedIndex = queuedIds.indexOf(explicitId)
        if (queuedIndex >= 0) queuedIds.splice(queuedIndex, 1)
      } else {
        id = queuedIds.shift() ?? `call_gemini_${++generatedCallId}`
      }
      pendingCallIds.set(name, queuedIds)
      messages.push({
        role: 'tool',
        tool_call_id: id,
        name,
        content: geminiFunctionResponseToChat(response.response)
      })
    }
    if (userContent.length > 0 || !parts.some((part) => objectValue(part.functionResponse) ?? objectValue(part.function_response))) {
      messages.push({ role: 'user', content: userContent.length > 0 ? userContent : '' })
    }
  }
  const generationConfig = objectValue(body.generationConfig) ?? objectValue(body.generation_config) ?? {}
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(generationConfig.maxOutputTokens),
    temperature: numberValue(generationConfig.temperature),
    top_p: numberValue(generationConfig.topP),
    stop: stringArray(generationConfig.stopSequences),
    stream: booleanValue(body.stream)
  }
  const tools = geminiToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = geminiToolChoiceToChat(body.toolConfig ?? body.tool_config)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function chatRequestToGemini(body: JsonObject): JsonObject {
  const contents: JsonObject[] = []
  const systemParts: string[] = []
  const callNames = new Map<string, string>()
  let pendingToolResponses: JsonObject[] = []

  const flushToolResponses = (): void => {
    if (pendingToolResponses.length === 0) return
    contents.push({ role: 'user', parts: pendingToolResponses })
    pendingToolResponses = []
  }

  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'system' || role === 'developer') {
      const text = chatContentToText(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const id = stringValue(message.tool_call_id)
      const name = stringValue(message.name, callNames.get(id) ?? '')
      pendingToolResponses.push({
        functionResponse: omitUndefined({
          id: optionalString(id),
          name,
          response: chatToolContentToGeminiResponse(message.content)
        })
      })
      continue
    }

    const parts = chatMessageToGeminiParts(message)
    if (role === 'assistant') {
      flushToolResponses()
      for (const toolCall of chatMessageToolCalls(message)) {
        const definition = objectValue(toolCall.function) ?? {}
        const id = stringValue(toolCall.id)
        if (id) callNames.set(id, stringValue(definition.name))
      }
      contents.push({ role: 'model', parts })
      continue
    }

    if (pendingToolResponses.length > 0) {
      contents.push({ role: 'user', parts: [...pendingToolResponses, ...parts] })
      pendingToolResponses = []
    } else {
      contents.push({ role: 'user', parts })
    }
  }
  flushToolResponses()

  const generationConfig = omitUndefined({
    maxOutputTokens: numberValue(body.max_tokens) ?? numberValue(body.max_completion_tokens),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    stopSequences: stringArray(body.stop)
  })
  const output: JsonObject = { contents }
  if (systemParts.length > 0) output.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
  if (Object.keys(generationConfig).length > 0) output.generationConfig = generationConfig

  const functionDeclarations: JsonObject[] = []
  for (const tool of arrayOfObjects(body.tools)) {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) continue
    functionDeclarations.push({
      name: stringValue(definition.name),
      description: stringValue(definition.description),
      parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} }
    })
  }
  if (functionDeclarations.length > 0) output.tools = [{ functionDeclarations }]
  const toolConfig = chatToolChoiceToGemini(body.tool_choice)
  if (toolConfig !== undefined) output.toolConfig = toolConfig
  return output
}

function anthropicResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const timestamp = now()
  const content = arrayOfObjects(body.content)
  const text = content.filter((block) => stringValue(block.type) === 'text').map((block) => stringValue(block.text)).join('')
  const toolCalls = content.filter((block) => stringValue(block.type) === 'tool_use').map((block) => ({
    id: stringValue(block.id),
    type: 'function',
    function: { name: stringValue(block.name), arguments: JSON.stringify(block.input ?? {}) }
  }))
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usage)
  return {
    id: stringValue(body.id, `chatcmpl_${timestamp}`),
    object: 'chat.completion',
    created: Math.floor(timestamp / 1000),
    model: stringValue(body.model, fallbackModel),
    choices: [{
      index: 0,
      message,
      finish_reason: anthropicStopReasonToChat(stringValue(body.stop_reason), toolCalls.length > 0)
    }],
    usage: {
      prompt_tokens: numberValue(usage?.input_tokens) ?? 0,
      completion_tokens: numberValue(usage?.output_tokens) ?? 0,
      total_tokens: (numberValue(usage?.input_tokens) ?? 0) + (numberValue(usage?.output_tokens) ?? 0)
    }
  }
}

function chatResponseToAnthropic(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const content = chatMessageToAnthropicContent(message)
  const hasToolCalls = arrayOfObjects(message.tool_calls).length > 0
  const usage = objectValue(body.usage)
  return {
    id: stringValue(body.id, `msg_${now()}`),
    type: 'message',
    role: 'assistant',
    model: stringValue(body.model, fallbackModel),
    content,
    stop_reason: chatFinishReasonToAnthropic(stringValue(choice.finish_reason), hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: numberValue(usage?.prompt_tokens) ?? 0,
      output_tokens: numberValue(usage?.completion_tokens) ?? 0
    }
  }
}

function responsesResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const timestamp = now()
  const output = arrayOfObjects(body.output)
  const messageItems = output.filter((item) => stringValue(item.type) === 'message')
  const text = messageItems.map((item) => responsesContentToText(item.content, false)).join('')
  const refusal = messageItems.map((item) => responsesRefusalToText(item.content)).join('')
  const toolCalls = output.filter((item) => stringValue(item.type) === 'function_call').map((item) => ({
    id: stringValue(item.call_id, stringValue(item.id)),
    type: 'function',
    function: { name: stringValue(item.name), arguments: stringValue(item.arguments, '{}') }
  }))
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (refusal) message.refusal = refusal
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usage)
  const inputTokens = numberValue(usage?.input_tokens) ?? 0
  const outputTokens = numberValue(usage?.output_tokens) ?? 0
  const finishReason = responsesCompletionReason(body, toolCalls.length > 0)
  return {
    id: stringValue(body.id, `chatcmpl_${timestamp}`),
    object: 'chat.completion',
    created: Math.floor(timestamp / 1000),
    model: stringValue(body.model, fallbackModel),
    choices: [{ index: 0, message, finish_reason: completionReasonToChat(finishReason) }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function chatResponseToResponses(
  body: JsonObject,
  fallbackModel: string,
  now: () => number,
  context?: ProtocolConversionContext
): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const timestamp = now()
  const responseId = stringValue(body.id, timestamp.toString())
  const toolCalls = arrayOfObjects(message.tool_calls)
  validateXaiResponseCallIds(toolCalls, context, 'choices[0].message.tool_calls')
  const completion = responsesStatusFields(chatCompletionReason(
    stringValue(choice.finish_reason),
    toolCalls.length > 0
  ))
  const content: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) content.push({ type: 'output_text', text, annotations: [] })
  const output: JsonObject[] = []
  if (content.length > 0) {
    output.push({ id: `msg_${responseId}`, type: 'message', role: 'assistant', status: completion.status, content })
  }
  for (const toolCall of toolCalls) {
    const functionValue = objectValue(toolCall.function) ?? {}
    const wireName = stringValue(functionValue.name)
    const binding = resolveResponsesChatToolBinding(context, wireName)
    if (usesResponsesChatToolBridge(context) && !binding) {
      throw new InvalidToolBridgeError('choices[0].message.tool_calls[].function.name', `unknown tool alias ${wireName || '<empty>'}`)
    }
    const callId = stringValue(toolCall.id)
    if (!callId) throw new InvalidToolBridgeError('choices[0].message.tool_calls[].id', 'tool call id is required')
    if (binding?.sourceType === 'tool_search') {
      output.push({
        type: 'tool_search_call',
        id: `tsc_${callId}`,
        call_id: callId,
        execution: 'client',
        arguments: parseToolSearchArguments(stringValue(functionValue.arguments, '{}')),
        status: completion.status,
      })
      rememberXaiChatCall(context, callId, binding)
    } else if (binding?.sourceType === 'custom') {
      output.push({
        type: 'custom_tool_call',
        id: callId,
        call_id: callId,
        name: binding.sourceName,
        input: binding.deferredToolName
          ? deepSeekDeferredToolExecInput(
              binding.deferredToolName,
              parseToolArgumentsObject(
                functionValue.arguments,
                'choices[0].message.tool_calls[].function.arguments',
              ),
            )
          : parseXaiCustomWrapper(functionValue.arguments, 'choices[0].message.tool_calls[].function.arguments'),
        status: completion.status
      })
      rememberXaiChatCall(context, callId, binding)
    } else {
      output.push({
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: binding?.sourceName ?? wireName,
        ...(binding?.sourceNamespace ? { namespace: binding.sourceNamespace } : {}),
        arguments: stringValue(functionValue.arguments, '{}'),
        status: completion.status
      })
      if (binding) rememberXaiChatCall(context, callId, binding)
    }
  }
  if (output.length === 0) {
    output.push({ id: `msg_${responseId}`, type: 'message', role: 'assistant', status: completion.status, content })
  }
  const usage = objectValue(body.usage)
  const inputTokens = numberValue(usage?.prompt_tokens)
  const outputTokens = numberValue(usage?.completion_tokens)
  const usageDetails: JsonObject = {}
  const cachedTokens = numberValue(objectValue(usage?.prompt_tokens_details)?.cached_tokens)
  const reasoningTokens = numberValue(objectValue(usage?.completion_tokens_details)?.reasoning_tokens)
  if (cachedTokens !== undefined) usageDetails.input_tokens_details = { cached_tokens: cachedTokens }
  if (reasoningTokens !== undefined) usageDetails.output_tokens_details = { reasoning_tokens: reasoningTokens }
  const responseUsage = omitUndefined({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberValue(usage?.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
    ...usageDetails
  })
  return {
    id: `resp_${responseId}`,
    object: 'response',
    created_at: Math.floor(timestamp / 1000),
    ...completion,
    model: stringValue(body.model, fallbackModel),
    output,
    ...(Object.keys(responseUsage).length > 0 ? { usage: responseUsage } : {})
  }
}

function responsesResponseToAnthropic(
  body: JsonObject,
  fallbackModel: string,
  now: () => number
): JsonObject {
  const output = arrayOfObjects(body.output)
  const content: JsonObject[] = []
  for (const item of output) {
    const itemType = stringValue(item.type)
    if (itemType === 'message') {
      for (const part of arrayOfObjects(item.content)) {
        const partType = stringValue(part.type)
        if (partType === 'output_text' || partType === 'text') {
          const text = optionalString(part.text)
          if (text) content.push({ type: 'text', text })
        } else if (partType === 'refusal') {
          const refusal = optionalString(part.refusal)
          if (refusal) content.push({ type: 'text', text: refusal })
        }
      }
      continue
    }
    if (itemType === 'function_call') {
      content.push({
        type: 'tool_use',
        id: stringValue(item.call_id, stringValue(item.id)),
        name: stringValue(item.name),
        input: parseJsonObject(item.arguments, 'Responses function_call.arguments')
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const usage = objectValue(body.usage)
  const completionReason = responsesCompletionReason(
    body,
    content.some((block) => stringValue(block.type) === 'tool_use')
  )
  return {
    id: stringValue(body.id, `chatcmpl_${now()}`),
    type: 'message',
    role: 'assistant',
    model: stringValue(body.model, fallbackModel),
    content,
    stop_reason: completionReasonToAnthropic(completionReason),
    stop_sequence: null,
    usage: {
      input_tokens: numberValue(usage?.input_tokens) ?? 0,
      output_tokens: numberValue(usage?.output_tokens) ?? 0
    }
  }
}

function anthropicResponseToResponses(
  body: JsonObject,
  fallbackModel: string,
  now: () => number
): JsonObject {
  const timestamp = now()
  const intermediateId = stringValue(body.id, `chatcmpl_${timestamp}`)
  const completion = responsesStatusFields(anthropicCompletionReason(stringValue(body.stop_reason)))
  const contentBlocks = arrayOfObjects(body.content)
  const output: JsonObject[] = []
  let textParts: string[] = []
  let messageIndex = 0
  const flushText = (): void => {
    const text = textParts.join('')
    textParts = []
    if (!text) return
    const id = messageIndex === 0 ? `msg_${intermediateId}` : `msg_${intermediateId}_${messageIndex}`
    messageIndex += 1
    output.push({
      id,
      type: 'message',
      role: 'assistant',
      status: completion.status,
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  for (const block of contentBlocks) {
    if (stringValue(block.type) === 'text') {
      textParts.push(stringValue(block.text))
      continue
    }
    if (stringValue(block.type) !== 'tool_use') continue
    flushText()
    const id = stringValue(block.id)
    output.push({
      type: 'function_call',
      id,
      call_id: id,
      name: stringValue(block.name),
      arguments: jsonString(block.input ?? {}),
      status: completion.status
    })
  }
  flushText()
  if (output.length === 0) {
    output.push({
      id: `msg_${intermediateId}`,
      type: 'message',
      role: 'assistant',
      status: completion.status,
      content: []
    })
  }
  const usage = objectValue(body.usage)
  const uncachedInputTokens = numberValue(usage?.input_tokens) ?? 0
  const cachedInputTokens = numberValue(usage?.cache_read_input_tokens) ?? 0
  const cacheCreationInputTokens = numberValue(usage?.cache_creation_input_tokens) ?? 0
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens
  const outputTokens = numberValue(usage?.output_tokens) ?? 0
  const reasoningTokens = numberValue(objectValue(usage?.output_tokens_details)?.thinking_tokens)
  return {
    id: `resp_${intermediateId}`,
    object: 'response',
    created_at: Math.floor(timestamp / 1000),
    ...completion,
    model: stringValue(body.model, fallbackModel),
    output,
    usage: omitUndefined({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: cachedInputTokens > 0 ? { cached_tokens: cachedInputTokens } : undefined,
      output_tokens_details: reasoningTokens === undefined ? undefined : { reasoning_tokens: reasoningTokens }
    })
  }
}

function responsesResponseToGemini(
  body: JsonObject,
  fallbackModel: string,
  _now: () => number
): JsonObject {
  const output = arrayOfObjects(body.output)
  const parts: JsonObject[] = []
  for (const item of output) {
    const itemType = stringValue(item.type)
    if (itemType === 'message') {
      const text = responsesContentToText(item.content, false)
      const refusal = responsesRefusalToText(item.content)
      if (text || refusal) parts.push({ text: `${text}${refusal}` })
      continue
    }
    if (itemType === 'function_call') {
      parts.push({
        functionCall: omitUndefined({
          id: optionalString(stringValue(item.call_id, stringValue(item.id))),
          name: stringValue(item.name),
          args: parseJsonObject(item.arguments, 'Responses function_call.arguments')
        })
      })
    }
  }
  const usage = objectValue(body.usage)
  const promptTokens = numberValue(usage?.input_tokens) ?? 0
  const candidateTokens = numberValue(usage?.output_tokens) ?? 0
  const completionReason = responsesCompletionReason(
    body,
    parts.some((part) => objectValue(part.functionCall) !== undefined)
  )
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: completionReasonToGemini(completionReason) }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      totalTokenCount: promptTokens + candidateTokens
    },
    modelVersion: stringValue(body.model, fallbackModel)
  }
}

function geminiResponseToResponses(
  body: JsonObject,
  fallbackModel: string,
  now: () => number
): JsonObject {
  const candidate = objectValue(arrayValue(body.candidates)[0]) ?? {}
  const candidateContent = objectValue(candidate.content) ?? {}
  const parts = arrayOfObjects(candidateContent.parts)
  const calls: JsonObject[] = []
  let generatedCallId = 0
  for (const part of parts) {
    const call = objectValue(part.functionCall)
    if (!call) continue
    const id = stringValue(call.id, `call_${now()}_${++generatedCallId}`)
    calls.push({
      type: 'function_call',
      id,
      call_id: id,
      name: stringValue(call.name),
      arguments: jsonString(call.args ?? {}),
      status: 'completed'
    })
  }
  const completion = responsesStatusFields(geminiResponseCompletionReason(body, candidate, calls.length > 0))
  for (const call of calls) call.status = completion.status
  // geminiResponseToChat historically generated missing call IDs before the
  // enclosing response ID. Preserve that deterministic clock ordering.
  const responseId = `chatcmpl_${now()}`
  const output: JsonObject[] = []
  const text = geminiPartsToText(parts)
  if (text) {
    output.push({
      id: `msg_${responseId}`,
      type: 'message',
      role: 'assistant',
      status: completion.status,
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  output.push(...calls)
  if (output.length === 0) {
    output.push({
      id: `msg_${responseId}`,
      type: 'message',
      role: 'assistant',
      status: completion.status,
      content: []
    })
  }
  const usage = objectValue(body.usageMetadata) ?? objectValue(body.usage_metadata)
  const inputTokens = numberValue(usage?.promptTokenCount) ?? 0
  const outputTokens = numberValue(usage?.candidatesTokenCount) ?? 0
  return {
    id: `resp_${responseId}`,
    object: 'response',
    created_at: Math.floor(now() / 1000),
    ...completion,
    model: fallbackModel,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function anthropicResponseToGemini(body: JsonObject, fallbackModel: string): JsonObject {
  const content = arrayOfObjects(body.content)
  const parts: JsonObject[] = []
  const text: string[] = []
  for (const block of content) {
    if (stringValue(block.type) === 'text') text.push(stringValue(block.text))
  }
  const joinedText = text.join('')
  if (joinedText) parts.push({ text: joinedText })
  for (const block of content) {
    if (stringValue(block.type) !== 'tool_use') continue
    parts.push({
      functionCall: omitUndefined({
        id: optionalString(stringValue(block.id)),
        name: stringValue(block.name),
        args: parseJsonObject(block.input, 'Anthropic tool_use.input')
      })
    })
  }
  const usage = objectValue(body.usage)
  const inputTokens = numberValue(usage?.input_tokens) ?? 0
  const outputTokens = numberValue(usage?.output_tokens) ?? 0
  const completionReason = anthropicCompletionReason(stringValue(body.stop_reason))
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: completionReasonToGemini(completionReason)
    }],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens
    },
    modelVersion: stringValue(body.model, fallbackModel)
  }
}

function geminiResponseToAnthropic(
  body: JsonObject,
  fallbackModel: string,
  now: () => number
): JsonObject {
  const candidate = objectValue(arrayValue(body.candidates)[0]) ?? {}
  const content = objectValue(candidate.content) ?? {}
  const parts = arrayOfObjects(content.parts)
  const calls: JsonObject[] = []
  let generatedCallId = 0
  for (const part of parts) {
    const call = objectValue(part.functionCall)
    if (!call) continue
    const id = stringValue(call.id, `call_${now()}_${++generatedCallId}`)
    calls.push({
      type: 'tool_use',
      id,
      name: stringValue(call.name),
      input: parseJsonObject(call.args, 'Gemini functionCall.args')
    })
  }
  const responseId = `chatcmpl_${now()}`
  const text = geminiPartsToText(parts)
  const outputContent: JsonObject[] = []
  if (text) outputContent.push({ type: 'text', text })
  outputContent.push(...calls)
  if (outputContent.length === 0) outputContent.push({ type: 'text', text: '' })
  const usage = objectValue(body.usageMetadata) ?? objectValue(body.usage_metadata)
  const inputTokens = numberValue(usage?.promptTokenCount) ?? 0
  const outputTokens = numberValue(usage?.candidatesTokenCount) ?? 0
  const completionReason = geminiResponseCompletionReason(body, candidate, calls.length > 0)
  return {
    id: responseId,
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content: outputContent,
    stop_reason: completionReasonToAnthropic(completionReason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }
}

function geminiResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const candidate = objectValue(arrayValue(body.candidates)[0]) ?? {}
  const content = objectValue(candidate.content) ?? {}
  const text = geminiPartsToText(content.parts)
  let generatedCallId = 0
  const toolCalls: JsonObject[] = []
  for (const part of arrayOfObjects(content.parts)) {
    const call = objectValue(part.functionCall)
    if (call) toolCalls.push({
      id: stringValue(call.id, `call_${now()}_${++generatedCallId}`),
      type: 'function',
      function: { name: stringValue(call.name), arguments: jsonString(call.args ?? {}) }
    })
  }
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usageMetadata) ?? objectValue(body.usage_metadata)
  const inputTokens = numberValue(usage?.promptTokenCount) ?? 0
  const outputTokens = numberValue(usage?.candidatesTokenCount) ?? 0
  return {
    id: `chatcmpl_${now()}`,
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: fallbackModel,
    choices: [{
      index: 0,
      message,
      finish_reason: completionReasonToChat(geminiResponseCompletionReason(body, candidate, toolCalls.length > 0))
    }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function chatResponseToGemini(body: JsonObject, fallbackModel: string): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const parts: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) parts.push({ text })
  for (const toolCall of arrayOfObjects(message.tool_calls)) {
    const functionValue = objectValue(toolCall.function) ?? {}
    const args = parseJsonObject(functionValue.arguments, 'Chat tool_call.function.arguments')
    parts.push({
      functionCall: omitUndefined({
        id: optionalString(toolCall.id),
        name: stringValue(functionValue.name),
        args
      })
    })
  }
  const usage = objectValue(body.usage)
  const promptTokens = numberValue(usage?.prompt_tokens) ?? 0
  const candidateTokens = numberValue(usage?.completion_tokens) ?? 0
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: chatFinishReasonToGemini(stringValue(choice.finish_reason)) }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candidateTokens, totalTokenCount: promptTokens + candidateTokens },
    modelVersion: stringValue(body.model, fallbackModel)
  }
}

function anthropicAssistantMessageToChat(message: JsonObject): JsonObject {
  if (typeof message.content === 'string') return { role: 'assistant', content: message.content }

  const blocks = arrayOfObjects(message.content)
  const text = blocks
    .filter((block) => stringValue(block.type) === 'text')
    .map((block) => stringValue(block.text))
    .join('')
  const toolCalls = blocks
    .filter((block) => stringValue(block.type) === 'tool_use')
    .map((block) => ({
      id: stringValue(block.id),
      type: 'function',
      function: {
        name: stringValue(block.name),
        arguments: jsonString(block.input ?? {})
      }
    }))
  const converted: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) converted.tool_calls = toolCalls
  return converted
}

function anthropicToolResultErrorPath(body: JsonObject): string | undefined {
  for (const [messageIndex, message] of arrayOfObjects(body.messages).entries()) {
    for (const [blockIndex, block] of arrayOfObjects(message.content).entries()) {
      if (stringValue(block.type) === 'tool_result' && block.is_error === true) {
        return `messages[${messageIndex}].content[${blockIndex}].is_error`
      }
    }
  }
  return undefined
}

function anthropicUserMessageToChat(message: JsonObject): JsonObject[] {
  if (typeof message.content === 'string') return [{ role: 'user', content: message.content }]

  const converted: JsonObject[] = []
  let content: JsonObject[] = []
  const flushContent = (): void => {
    if (content.length === 0) return
    const textOnly = content.every((part) => stringValue(part.type) === 'text')
    converted.push({
      role: 'user',
      content: textOnly ? content.map((part) => stringValue(part.text)).join('') : content
    })
    content = []
  }

  for (const block of arrayOfObjects(message.content)) {
    if (stringValue(block.type) === 'tool_result') {
      flushContent()
      const toolMessage: JsonObject = {
        role: 'tool',
        tool_call_id: stringValue(block.tool_use_id),
        content: anthropicToolResultToChat(block.content)
      }
      converted.push(toolMessage)
    } else if (stringValue(block.type) === 'text') {
      const text = stringValue(block.text)
      if (text) content.push({ type: 'text', text })
    } else if (stringValue(block.type) === 'image') {
      const url = anthropicImageUrl(block)
      if (url) content.push({ type: 'image_url', image_url: { url } })
    }
  }
  flushContent()
  return converted.length > 0 ? converted : [{ role: 'user', content: '' }]
}

function anthropicToolResultToChat(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const content: JsonObject[] = []
    for (const block of arrayOfObjects(value)) {
      if (stringValue(block.type) === 'text') content.push({ type: 'text', text: stringValue(block.text) })
    }
    if (content.length > 0) return content
  }
  return jsonString(value ?? '')
}

function chatToolMessageToAnthropicResult(message: JsonObject): JsonObject {
  return omitUndefined({
    type: 'tool_result',
    tool_use_id: stringValue(message.tool_call_id, stringValue(message.name)),
    content: chatToolContentToAnthropic(message.content),
    is_error: booleanValue(message.is_error)
  })
}

function chatToolContentToAnthropic(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const blocks: JsonObject[] = []
    for (const part of arrayOfObjects(value)) {
      if (stringValue(part.type) === 'image_url') {
        const url = chatImageUrl(part)
        const image = url ? imageUrlToAnthropic(url) : undefined
        if (image) blocks.push(image)
      } else {
        const text = stringValue(part.text)
        if (text) blocks.push({ type: 'text', text })
      }
    }
    if (blocks.length > 0) return blocks
  }
  return jsonString(value ?? '')
}

function responsesFunctionCallToChat(item: JsonObject, context?: ProtocolConversionContext): JsonObject {
  const sourceType = stringValue(item.type) === 'custom_tool_call' ? 'custom' : 'function'
  const sourceName = stringValue(item.name)
  const binding = sourceType === 'custom'
    ? findXaiTool(context, 'custom', sourceName)
    : findXaiTool(context, 'function', sourceName) ?? findXaiToolByWire(context, sourceName)
  if (usesResponsesChatToolBridge(context) && sourceType === 'custom' && !binding) {
    throw new InvalidToolBridgeError('input[].name', `custom tool ${sourceName || '<empty>'} was not declared`)
  }
  const name = binding?.wireName ?? sourceName
  if (!name || name.length > 64) throw new InvalidToolBridgeError('input[].name', 'tool name is empty or too long')
  if (sourceType === 'custom') {
    const input = typeof item.input === 'string' ? item.input : stringValue(item.input)
    return {
      id: stringValue(item.call_id, stringValue(item.id)),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify({ input })
      }
    }
  }
  return {
    id: stringValue(item.call_id, stringValue(item.id)),
    type: 'function',
    function: {
      name,
      arguments: typeof item.arguments === 'string' ? item.arguments : jsonString(item.arguments ?? {})
    }
  }
}

function responsesFunctionOutputToChat(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const content: JsonObject[] = []
    for (const item of arrayOfObjects(value)) {
      const text = stringValue(item.text)
      if (text) content.push({ type: 'text', text })
    }
    if (content.length > 0) return content
  }
  return jsonString(value ?? '')
}

function responsesFunctionOutputToAnthropic(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const content: JsonObject[] = []
    for (const item of arrayOfObjects(value)) {
      if (stringValue(item.type) === 'input_image') {
        const url = imageUrlValue(item)
        const image = url ? imageUrlToAnthropic(url) : undefined
        if (image) content.push(image)
      } else {
        const text = stringValue(item.text)
        if (text) content.push({ type: 'text', text })
      }
    }
    if (content.length > 0) return content
  }
  return jsonString(value ?? '')
}

function anthropicToolResultToResponses(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const output: JsonObject[] = []
    for (const part of arrayOfObjects(value)) {
      if (stringValue(part.type) === 'image') {
        const url = anthropicImageUrl(part)
        if (url) output.push({ type: 'input_image', image_url: url })
      } else {
        const text = stringValue(part.text)
        if (text) output.push({ type: 'input_text', text })
      }
    }
    if (output.length > 0) return output
  }
  return jsonString(value ?? '')
}

function responsesFunctionOutputToGemini(value: unknown): JsonObject {
  let candidate: unknown = value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of arrayOfObjects(value)) parts.push(stringValue(item.text))
    candidate = parts.join('')
  } else if (typeof value !== 'string') {
    candidate = jsonString(value ?? '')
  }
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return { result: candidate }
    }
  }
  return objectValue(candidate) ?? { result: candidate ?? '' }
}

function geminiFunctionResponseToResponses(value: unknown): string {
  return typeof value === 'string' ? value : jsonString(value ?? {})
}

function anthropicToolResultToGemini(value: unknown): JsonObject {
  let candidate: unknown = value
  if (Array.isArray(value)) {
    const text: string[] = []
    for (const block of arrayOfObjects(value)) {
      if (stringValue(block.type) === 'text') text.push(stringValue(block.text))
    }
    candidate = text.join('')
  } else if (typeof value !== 'string') {
    candidate = jsonString(value ?? '')
  }
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return { result: candidate }
    }
  }
  return objectValue(candidate) ?? { result: candidate ?? '' }
}

function geminiFunctionResponseToAnthropic(value: unknown): string {
  return typeof value === 'string' ? value : jsonString(value ?? {})
}

function chatMessageToolCalls(message: JsonObject): JsonObject[] {
  return arrayOfObjects(message.tool_calls)
}

function chatFunctionCallToResponses(toolCall: JsonObject, context?: ProtocolConversionContext): JsonObject {
  const definition = objectValue(toolCall.function) ?? {}
  const wireName = stringValue(definition.name)
  const callId = stringValue(toolCall.id)
  const historicalCall = callId ? findXaiCall(context, callId) : undefined
  const historicalBinding = historicalCall?.wireName === wireName
    ? context?.toolBridgePlan?.tools.find((candidate) => candidate.declared === false
      && candidate.wireName === wireName
      && candidate.sourceType === historicalCall.sourceType
      && candidate.sourceName === historicalCall.sourceName)
    : undefined
  const binding = resolveResponsesChatToolBinding(context, wireName) ?? historicalBinding
  if (usesResponsesChatToolBridge(context) && !binding) {
    throw new InvalidToolBridgeError('messages[].tool_calls[].function.name', `unknown tool alias ${wireName || '<empty>'}`)
  }
  if (binding?.sourceType === 'tool_search') {
    if (!callId) throw new InvalidToolBridgeError('messages[].tool_calls[].id', 'tool call id is required')
    rememberXaiChatCall(context, callId, binding)
    return {
      type: 'tool_search_call',
      call_id: callId,
      execution: 'client',
      arguments: parseToolSearchArguments(stringValue(definition.arguments, '{}')),
    }
  }
  if (binding?.sourceType === 'custom') {
    if (!callId) throw new InvalidToolBridgeError('messages[].tool_calls[].id', 'tool call id is required')
    const input = binding.deferredToolName
      ? deepSeekDeferredToolExecInput(
          binding.deferredToolName,
          parseToolArgumentsObject(definition.arguments, 'messages[].tool_calls[].function.arguments'),
        )
      : parseXaiCustomWrapper(definition.arguments, 'messages[].tool_calls[].function.arguments')
    rememberXaiChatCall(context, callId, binding)
    return {
      type: 'custom_tool_call',
      call_id: callId,
      name: binding.sourceName,
      input
    }
  }
  return {
    type: 'function_call',
    call_id: callId,
    name: binding?.sourceName ?? wireName,
    ...(binding?.sourceNamespace ? { namespace: binding.sourceNamespace } : {}),
    arguments: typeof definition.arguments === 'string'
      ? definition.arguments
      : jsonString(definition.arguments ?? {})
  }
}

function chatFunctionCallToXaiResponsesWire(
  toolCall: JsonObject,
  context?: ProtocolConversionContext
): JsonObject {
  const definition = objectValue(toolCall.function) ?? {}
  const wireName = stringValue(definition.name)
  const callId = stringValue(toolCall.id)
  const historicalCall = callId ? findXaiCall(context, callId) : undefined
  const declaredBinding = findXaiToolByWire(context, wireName)
  const historicalBinding = historicalCall?.wireName === wireName
    ? context?.toolBridgePlan?.tools.find((candidate) => candidate.declared === false
      && candidate.wireName === wireName
      && candidate.sourceType === historicalCall.sourceType
      && candidate.sourceName === historicalCall.sourceName)
    : undefined
  const binding = declaredBinding ?? historicalBinding
  if (!binding) {
    throw new InvalidToolBridgeError('messages[].tool_calls[].function.name', `unknown tool alias ${wireName || '<empty>'}`)
  }
  if (!callId) throw new InvalidToolBridgeError('messages[].tool_calls[].id', 'tool call id is required')
  rememberXaiChatCall(context, callId, binding)
  return {
    type: 'function_call',
    call_id: callId,
    name: binding.wireName,
    arguments: typeof definition.arguments === 'string'
      ? definition.arguments
      : jsonString(definition.arguments ?? {})
  }
}

function chatToolOutputToResponses(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const output: JsonObject[] = []
    for (const part of arrayOfObjects(value)) {
      if (stringValue(part.type) === 'image_url') {
        const url = chatImageUrl(part)
        if (url) {
          output.push(omitUndefined({
            type: 'input_image',
            image_url: url,
            detail: chatImageDetail(part)
          }))
        }
      } else {
        const text = stringValue(part.text)
        if (text) output.push({ type: 'input_text', text })
      }
    }
    if (output.length > 0) return output
  }
  return jsonString(value ?? '')
}

function anthropicToolsToChat(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    const name = optionalString(tool.name)
    if (!name) continue
    tools.push({
      type: 'function',
      function: omitUndefined({
        name,
        description: optionalString(tool.description),
        parameters: objectValue(tool.input_schema) ?? { type: 'object', properties: {} },
        strict: booleanValue(tool.strict)
      })
    })
  }
  return tools
}

function responsesToolsToChat(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    if (stringValue(tool.type) !== 'function') continue
    const name = optionalString(tool.name)
    if (!name) continue
    tools.push({
      type: 'function',
      function: omitUndefined({
        name,
        description: optionalString(tool.description),
        parameters: objectValue(tool.parameters) ?? { type: 'object', properties: {} },
        strict: booleanValue(tool.strict)
      })
    })
  }
  return tools
}

function xaiResponsesToolsToChat(value: unknown, context: ProtocolConversionContext): JsonObject[] {
  const plan = context.toolBridgePlan
  if (!plan) throw new InvalidToolBridgeError('tools', 'conversion plan is missing')
  const tools: JsonObject[] = []
  for (const binding of plan.tools.filter((candidate) => candidate.declared !== false)) {
    if (binding.sourceType === 'function' || binding.sourceType === 'tool_search') {
      const sourceName = binding.sourceNamespace ? binding.wireName : binding.sourceName
      const source = arrayOfObjects(value).find((tool) => stringValue(tool.type) === 'function'
        && (stringValue(tool.name) === binding.wireName || stringValue(tool.name) === sourceName))
      const definition = source ?? {}
      tools.push({ type: 'function', function: omitUndefined({
        name: binding.wireName,
        description: optionalString(definition.description),
        parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} },
        strict: booleanValue(definition.strict)
      }) })
      continue
    }
    const source = arrayOfObjects(value).find((tool) => (
      (stringValue(tool.type) === 'custom' && stringValue(tool.name) === binding.sourceName)
      || (stringValue(tool.type) === 'function' && stringValue(tool.name) === binding.wireName)
    ))
    tools.push({ type: 'function', function: omitUndefined({
      name: binding.wireName,
      description: [optionalString(source?.description), 'The argument must be a JSON object with one string property named input.'].filter(Boolean).join(' '),
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false
      }
    }) })
  }
  return tools
}

function responsesToolsToAnthropic(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    if (stringValue(tool.type) !== 'function') continue
    const name = optionalString(tool.name)
    if (!name) continue
    tools.push(omitUndefined({
      name,
      description: optionalString(tool.description),
      input_schema: objectValue(tool.parameters) ?? { type: 'object', properties: {} },
      strict: booleanValue(tool.strict)
    }))
  }
  return tools
}

function anthropicToolsToResponses(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    const name = optionalString(tool.name)
    if (!name) continue
    tools.push(omitUndefined({
      type: 'function',
      name,
      description: optionalString(tool.description),
      parameters: objectValue(tool.input_schema) ?? { type: 'object', properties: {} },
      strict: booleanValue(tool.strict)
    }))
  }
  return tools
}

function responsesToolsToGeminiDeclarations(value: unknown): JsonObject[] {
  const declarations: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    if (stringValue(tool.type) !== 'function') continue
    const name = optionalString(tool.name)
    if (!name) continue
    declarations.push({
      name,
      description: stringValue(tool.description),
      parameters: objectValue(tool.parameters) ?? { type: 'object', properties: {} }
    })
  }
  return declarations
}

function geminiToolsToResponses(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    for (const declaration of arrayOfObjects(tool.functionDeclarations)) {
      const name = optionalString(declaration.name)
      if (!name) continue
      tools.push(omitUndefined({
        type: 'function',
        name,
        description: optionalString(declaration.description),
        parameters: objectValue(declaration.parameters) ?? { type: 'object', properties: {} }
      }))
    }
  }
  return tools
}

function anthropicToolsToGeminiDeclarations(value: unknown): JsonObject[] {
  const declarations: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    const name = optionalString(tool.name)
    if (!name) continue
    declarations.push({
      name,
      description: stringValue(tool.description),
      parameters: objectValue(tool.input_schema) ?? { type: 'object', properties: {} }
    })
  }
  return declarations
}

function geminiToolsToAnthropic(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    for (const declaration of arrayOfObjects(tool.functionDeclarations)) {
      const name = optionalString(declaration.name)
      if (!name) continue
      tools.push(omitUndefined({
        name,
        description: optionalString(declaration.description),
        input_schema: objectValue(declaration.parameters) ?? { type: 'object', properties: {} }
      }))
    }
  }
  return tools
}

function chatToolsToAnthropic(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) continue
    const name = optionalString(definition.name)
    if (!name) continue
    tools.push(omitUndefined({
      name,
      description: optionalString(definition.description),
      input_schema: objectValue(definition.parameters) ?? { type: 'object', properties: {} },
      strict: booleanValue(definition.strict)
    }))
  }
  return tools
}

function chatToolsToResponses(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) continue
    const name = optionalString(definition.name)
    if (!name) continue
    tools.push(omitUndefined({
      type: 'function',
      name,
      description: optionalString(definition.description),
      parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} },
      strict: booleanValue(definition.strict)
    }))
  }
  return tools
}

function xaiChatToolsToResponses(value: unknown, context: ProtocolConversionContext): JsonObject[] {
  const plan = context.toolBridgePlan
  if (!plan) throw new InvalidToolBridgeError('tools', 'conversion plan is missing')
  const sourceTools = arrayOfObjects(value)
  return plan.tools.filter((binding) => binding.declared !== false).map((binding) => {
    const wire = sourceTools.find((tool) => {
      const definition = objectValue(tool.function)
      return stringValue(tool.type) === 'function' && stringValue(definition?.name) === binding.wireName
    })
    const definition = objectValue(wire?.function) ?? {}
    if (binding.sourceType === 'custom') {
      return { type: 'custom', name: binding.sourceName, description: optionalString(definition.description) }
    }
    return omitUndefined({
      type: 'function',
      name: binding.sourceName,
      description: optionalString(definition.description),
      parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} },
      strict: booleanValue(definition.strict)
    })
  })
}

function anthropicToolChoiceToChat(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'any') return 'required'
    if (value === 'auto' || value === 'none') return value
    return undefined
  }
  const choice = objectValue(value)
  if (!choice) return undefined
  const type = stringValue(choice.type)
  if (type === 'any') return 'required'
  if (type === 'auto' || type === 'none') return type
  if (type === 'tool' && optionalString(choice.name)) {
    return { type: 'function', function: { name: stringValue(choice.name) } }
  }
  return undefined
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  }
  const choice = objectValue(value)
  if (stringValue(choice?.type) === 'function' && optionalString(choice?.name)) {
    return { type: 'function', function: { name: stringValue(choice?.name) } }
  }
  return undefined
}

function xaiResponsesToolChoiceToChat(value: unknown, context: ProtocolConversionContext): unknown {
  if (typeof value === 'string') return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  const choice = objectValue(value)
  const type = stringValue(choice?.type)
  if ((type === 'function' || type === 'custom') && optionalString(choice?.name)) {
    const binding = findXaiTool(context, type === 'custom' ? 'custom' : 'function', stringValue(choice?.name))
    if (!binding || binding.declared === false) throw new InvalidToolBridgeError('tool_choice.name', `unknown tool ${stringValue(choice?.name)}`)
    return { type: 'function', function: { name: binding.wireName } }
  }
  return undefined
}

function responsesToolChoiceToAnthropic(value: unknown, parallelToolCalls: unknown): unknown {
  let choice: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none') choice = { type: value }
    if (value === 'required') choice = { type: 'any' }
  } else {
    const responseChoice = objectValue(value)
    if (stringValue(responseChoice?.type) === 'function' && optionalString(responseChoice?.name)) {
      choice = { type: 'tool', name: stringValue(responseChoice?.name) }
    }
  }
  if (typeof parallelToolCalls === 'boolean') {
    choice ??= { type: 'auto' }
    choice.disable_parallel_tool_use = !parallelToolCalls
  }
  return choice
}

function anthropicToolChoiceToResponses(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'any') return 'required'
    return value === 'auto' || value === 'none' ? value : undefined
  }
  const choice = objectValue(value)
  const type = stringValue(choice?.type)
  if (type === 'any') return 'required'
  if (type === 'auto' || type === 'none') return type
  if (type === 'tool' && optionalString(choice?.name)) {
    return { type: 'function', name: stringValue(choice?.name) }
  }
  return undefined
}

function responsesToolChoiceToGemini(value: unknown): JsonObject | undefined {
  let functionCallingConfig: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'none') functionCallingConfig = { mode: 'NONE' }
    if (value === 'auto') functionCallingConfig = { mode: 'AUTO' }
    if (value === 'required') functionCallingConfig = { mode: 'ANY' }
  } else {
    const choice = objectValue(value)
    if (stringValue(choice?.type) === 'function' && optionalString(choice?.name)) {
      functionCallingConfig = {
        mode: 'ANY',
        allowedFunctionNames: [stringValue(choice?.name)]
      }
    }
  }
  return functionCallingConfig ? { functionCallingConfig } : undefined
}

function geminiToolChoiceToResponses(value: unknown): unknown {
  const toolConfig = objectValue(value)
  const config = objectValue(toolConfig?.functionCallingConfig)
    ?? objectValue(toolConfig?.function_calling_config)
  if (!config) return undefined
  const mode = stringValue(config.mode).toUpperCase()
  if (mode === 'NONE') return 'none'
  if (mode === 'AUTO' || mode === 'VALIDATED') return 'auto'
  if (mode === 'ANY') {
    const names = stringArray(config.allowedFunctionNames ?? config.allowed_function_names)
    if (names?.length === 1) return { type: 'function', name: names[0] }
    return 'required'
  }
  return undefined
}

function anthropicToolChoiceToGemini(value: unknown): JsonObject | undefined {
  let functionCallingConfig: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'none') functionCallingConfig = { mode: 'NONE' }
    if (value === 'auto') functionCallingConfig = { mode: 'AUTO' }
    if (value === 'any') functionCallingConfig = { mode: 'ANY' }
  } else {
    const choice = objectValue(value)
    const type = stringValue(choice?.type)
    if (type === 'none') functionCallingConfig = { mode: 'NONE' }
    if (type === 'auto') functionCallingConfig = { mode: 'AUTO' }
    if (type === 'any') functionCallingConfig = { mode: 'ANY' }
    if (type === 'tool' && optionalString(choice?.name)) {
      functionCallingConfig = {
        mode: 'ANY',
        allowedFunctionNames: [stringValue(choice?.name)]
      }
    }
  }
  return functionCallingConfig ? { functionCallingConfig } : undefined
}

function geminiToolChoiceToAnthropic(value: unknown): unknown {
  const toolConfig = objectValue(value)
  const config = objectValue(toolConfig?.functionCallingConfig)
    ?? objectValue(toolConfig?.function_calling_config)
  if (!config) return undefined
  const mode = stringValue(config.mode).toUpperCase()
  if (mode === 'NONE') return { type: 'none' }
  if (mode === 'AUTO' || mode === 'VALIDATED') return { type: 'auto' }
  if (mode === 'ANY') {
    const names = stringArray(config.allowedFunctionNames ?? config.allowed_function_names)
    if (names?.length === 1) return { type: 'tool', name: names[0] }
    return { type: 'any' }
  }
  return undefined
}

function chatToolChoiceToAnthropic(value: unknown, parallelToolCalls: unknown): unknown {
  let choice: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none') choice = { type: value }
    if (value === 'required') choice = { type: 'any' }
  } else {
    const chatChoice = objectValue(value)
    const definition = objectValue(chatChoice?.function)
    if (stringValue(chatChoice?.type) === 'function' && optionalString(definition?.name)) {
      choice = { type: 'tool', name: stringValue(definition?.name) }
    }
  }
  if (typeof parallelToolCalls === 'boolean') {
    choice ??= { type: 'auto' }
    choice.disable_parallel_tool_use = !parallelToolCalls
  }
  return choice
}

function chatToolChoiceToResponses(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  }
  const choice = objectValue(value)
  const definition = objectValue(choice?.function)
  if (stringValue(choice?.type) === 'function' && optionalString(definition?.name)) {
    return { type: 'function', name: stringValue(definition?.name) }
  }
  return undefined
}

function xaiChatToolChoiceToResponses(value: unknown, context: ProtocolConversionContext): unknown {
  if (typeof value === 'string') return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  const choice = objectValue(value)
  const definition = objectValue(choice?.function)
  if (stringValue(choice?.type) !== 'function' || !optionalString(definition?.name)) return undefined
  const binding = findXaiToolByWire(context, stringValue(definition?.name))
  if (!binding) throw new InvalidToolBridgeError('tool_choice.function.name', `unknown tool alias ${stringValue(definition?.name)}`)
  return { type: binding.sourceType, name: binding.sourceName }
}

function chatMessageToAnthropicContent(message: JsonObject): JsonObject[] {
  const blocks: JsonObject[] = []
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content })
  } else {
    for (const part of arrayOfObjects(message.content)) {
      if (stringValue(part.type) === 'image_url') {
        const url = chatImageUrl(part)
        const image = url ? imageUrlToAnthropic(url) : undefined
        if (image) blocks.push(image)
      } else {
        const text = stringValue(part.text)
        if (text) blocks.push({ type: 'text', text })
      }
    }
  }
  for (const toolCall of chatMessageToolCalls(message)) {
    const functionValue = objectValue(toolCall.function) ?? {}
    const input = parseJsonObject(functionValue.arguments, 'Chat tool_call.function.arguments')
    blocks.push({ type: 'tool_use', id: stringValue(toolCall.id), name: stringValue(functionValue.name), input })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

function chatMessageToGeminiParts(message: JsonObject): JsonObject[] {
  const parts: JsonObject[] = []
  if (typeof message.content === 'string') {
    if (message.content) parts.push({ text: message.content })
  } else {
    for (const part of arrayOfObjects(message.content)) {
      if (stringValue(part.type) === 'image_url') {
        const url = chatImageUrl(part)
        const image = url ? imageUrlToGemini(url) : undefined
        if (image) parts.push(image)
      } else {
        const text = stringValue(part.text)
        if (text) parts.push({ text })
      }
    }
  }
  for (const toolCall of arrayOfObjects(message.tool_calls)) {
    const definition = objectValue(toolCall.function) ?? {}
    const args = parseJsonObject(definition.arguments, 'Chat tool_call.function.arguments')
    parts.push({
      functionCall: omitUndefined({
        id: optionalString(toolCall.id),
        name: stringValue(definition.name),
        args
      })
    })
  }
  return parts.length > 0 ? parts : [{ text: '' }]
}

function responsesContentToChat(value: unknown, includeRefusal = true): string {
  if (typeof value === 'string') return value
  const text: string[] = []
  for (const item of arrayValue(value)) {
    const object = objectValue(item)
    if (object) {
      text.push(
        stringValue(object.text)
        || stringValue(object.value)
        || (includeRefusal ? stringValue(object.refusal) : '')
      )
    }
  }
  return text.join('')
}

function responsesContentToChatContent(value: unknown): unknown {
  if (typeof value === 'string') return value
  const parts: JsonObject[] = []
  for (const item of arrayOfObjects(value)) {
    const type = stringValue(item.type)
    if (type === 'input_image') {
      const url = imageUrlValue(item)
      if (url) {
        parts.push({
          type: 'image_url',
          image_url: omitUndefined({ url, detail: optionalString(item.detail) })
        })
      }
    } else {
      const text = stringValue(item.text) || stringValue(item.value) || stringValue(item.refusal)
      if (text) parts.push({ type: 'text', text })
    }
  }
  return parts.length > 0 ? parts : ''
}

function responsesContentToAnthropicContent(value: unknown): JsonObject[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const blocks: JsonObject[] = []
  for (const item of arrayOfObjects(value)) {
    if (stringValue(item.type) === 'input_image') {
      const image = imageUrlValue(item)
      const block = image ? imageUrlToAnthropic(image) : undefined
      if (block) blocks.push(block)
    } else {
      const text = stringValue(item.text) || stringValue(item.value) || stringValue(item.refusal)
      if (text) blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

function responsesContentToGeminiParts(value: unknown): JsonObject[] {
  if (typeof value === 'string') return [{ text: value }]
  const parts: JsonObject[] = []
  for (const item of arrayOfObjects(value)) {
    if (stringValue(item.type) === 'input_image') {
      const image = imageUrlValue(item)
      const part = image ? imageUrlToGemini(image) : undefined
      if (part) parts.push(part)
    } else {
      const text = stringValue(item.text) || stringValue(item.value)
      if (text) parts.push({ text })
    }
  }
  return parts
}

function responsesContentToText(value: unknown, includeRefusal = true): string {
  return responsesContentToChat(value, includeRefusal)
}

function responsesRefusalToText(value: unknown): string {
  return arrayOfObjects(value).map((item) => stringValue(item.refusal)).join('')
}

function chatContentToResponses(value: unknown, output = false): JsonObject[] {
  if (typeof value === 'string') return value ? [{ type: output ? 'output_text' : 'input_text', text: value }] : []
  const content: JsonObject[] = []
  for (const part of arrayOfObjects(value)) {
    if (!output && stringValue(part.type) === 'image_url') {
      const url = chatImageUrl(part)
      if (url) {
        content.push(omitUndefined({
          type: 'input_image',
          image_url: url,
          detail: chatImageDetail(part)
        }))
      }
      continue
    }
    const text = stringValue(part.text)
    if (text) content.push({ type: output ? 'output_text' : 'input_text', text })
  }
  return content
}

function geminiPartsToText(value: unknown): string {
  const text: string[] = []
  for (const item of arrayValue(value)) {
    const part = objectValue(item)
    if (part) text.push(stringValue(part.text))
  }
  return text.join('')
}

function geminiImagePartToUrl(part: JsonObject): string | undefined {
  const inline = objectValue(part.inlineData) ?? objectValue(part.inline_data)
  if (inline) {
    const data = optionalString(inline.data)
    if (!data) return undefined
    return `data:${optionalString(inline.mimeType ?? inline.mime_type) ?? 'image/png'};base64,${data}`
  }
  const file = objectValue(part.fileData) ?? objectValue(part.file_data)
  return optionalString(file?.fileUri ?? file?.file_uri)
}

function imageUrlValue(item: JsonObject): string | undefined {
  return optionalString(item.image_url ?? item.imageUrl ?? item.url)
}

function chatImageUrl(part: JsonObject): string | undefined {
  const image = part.image_url ?? part.imageUrl
  return typeof image === 'string' ? optionalString(image) : optionalString(objectValue(image)?.url)
}

function chatImageDetail(part: JsonObject): string | undefined {
  const image = part.image_url ?? part.imageUrl
  return optionalString(objectValue(image)?.detail)
}

function imageUrlToAnthropic(url: string): JsonObject | undefined {
  const data = parseImageDataUrl(url)
  if (data) return { type: 'image', source: { type: 'base64', media_type: data.mimeType, data: data.data } }
  return { type: 'image', source: { type: 'url', url } }
}

function imageUrlToGemini(url: string): JsonObject | undefined {
  const data = parseImageDataUrl(url)
  if (data) return { inlineData: { mimeType: data.mimeType, data: data.data } }
  return { fileData: { fileUri: url } }
}

function anthropicImageUrl(block: JsonObject): string | undefined {
  const source = objectValue(block.source)
  if (!source) return undefined
  if (stringValue(source.type) === 'base64') {
    const data = optionalString(source.data)
    if (!data) return undefined
    return `data:${optionalString(source.media_type) ?? 'image/png'};base64,${data}`
  }
  return optionalString(source.url)
}

function parseImageDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(url)
  return match ? { mimeType: match[1], data: match[2].replace(/[\r\n]/g, '') } : undefined
}

function geminiFunctionResponseToChat(value: unknown): string {
  return typeof value === 'string' ? value : jsonString(value ?? {})
}

function chatToolContentToGeminiResponse(value: unknown): JsonObject {
  let candidate: unknown = value
  if (Array.isArray(value)) candidate = chatContentToText(value)
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return { result: candidate }
    }
  }
  return objectValue(candidate) ?? { result: candidate ?? '' }
}

function geminiToolsToChat(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    for (const declaration of arrayOfObjects(tool.functionDeclarations)) {
      tools.push({ type: 'function', function: {
        name: stringValue(declaration.name),
        description: stringValue(declaration.description),
        parameters: objectValue(declaration.parameters) ?? { type: 'object', properties: {} }
      } })
    }
  }
  return tools
}

function geminiToolChoiceToChat(value: unknown): unknown {
  const toolConfig = objectValue(value)
  const config = objectValue(toolConfig?.functionCallingConfig)
    ?? objectValue(toolConfig?.function_calling_config)
  if (!config) return undefined
  const mode = stringValue(config.mode).toUpperCase()
  if (mode === 'NONE') return 'none'
  if (mode === 'AUTO' || mode === 'VALIDATED') return 'auto'
  if (mode === 'ANY') {
    const names = stringArray(config.allowedFunctionNames ?? config.allowed_function_names)
    if (names?.length === 1) return { type: 'function', function: { name: names[0] } }
    return 'required'
  }
  return undefined
}

function chatToolChoiceToGemini(value: unknown): JsonObject | undefined {
  let functionCallingConfig: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'none') functionCallingConfig = { mode: 'NONE' }
    if (value === 'auto') functionCallingConfig = { mode: 'AUTO' }
    if (value === 'required') functionCallingConfig = { mode: 'ANY' }
  } else {
    const choice = objectValue(value)
    const definition = objectValue(choice?.function)
    if (stringValue(choice?.type) === 'function' && optionalString(definition?.name)) {
      functionCallingConfig = {
        mode: 'ANY',
        allowedFunctionNames: [stringValue(definition?.name)]
      }
    }
  }
  return functionCallingConfig ? { functionCallingConfig } : undefined
}

type CompletionReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

type ResponsesStatusFields =
  | { status: 'completed' }
  | {
      status: 'incomplete'
      incomplete_details: { reason: 'max_output_tokens' | 'content_filter' }
    }

function chatCompletionReason(reason: string, hasToolCalls = false): CompletionReason {
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  if (reason === 'tool_calls' || reason === 'function_call' || hasToolCalls) return 'tool_calls'
  return 'stop'
}

function anthropicCompletionReason(reason: string, hasToolCalls = false): CompletionReason {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'refusal') return 'content_filter'
  if (reason === 'tool_use' || hasToolCalls) return 'tool_calls'
  return 'stop'
}

function geminiCompletionReason(reason: string, hasToolCalls = false): CompletionReason {
  const normalized = reason.trim().toUpperCase()
  if (normalized === 'MAX_TOKENS') return 'length'
  if (geminiContentFilterReason(normalized)) return 'content_filter'
  if (hasToolCalls) return 'tool_calls'
  return 'stop'
}

function geminiResponseCompletionReason(
  body: JsonObject,
  candidate: JsonObject,
  hasToolCalls = false
): CompletionReason {
  const finishReason = optionalString(candidate.finishReason ?? candidate.finish_reason)
  if (finishReason) return geminiCompletionReason(finishReason, hasToolCalls)
  const promptFeedback = objectValue(body.promptFeedback) ?? objectValue(body.prompt_feedback)
  const blockReason = stringValue(promptFeedback?.blockReason ?? promptFeedback?.block_reason).trim().toUpperCase()
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') return 'content_filter'
  return hasToolCalls ? 'tool_calls' : 'stop'
}

function responsesCompletionReason(body: JsonObject, hasToolCalls = false): CompletionReason {
  const incomplete = objectValue(body.incomplete_details)
  if (stringValue(body.status) === 'incomplete' || incomplete) {
    const reason = stringValue(incomplete?.reason).trim().toLowerCase()
    return reason === 'content_filter' || reason.includes('content_filter')
      ? 'content_filter'
      : 'length'
  }
  if (responsesHasRefusal(body)) return 'content_filter'
  return hasToolCalls ? 'tool_calls' : 'stop'
}

function responsesHasRefusal(body: JsonObject): boolean {
  return arrayOfObjects(body.output).some((item) => {
    if (stringValue(item.type) === 'refusal' && optionalString(item.refusal)) return true
    return arrayOfObjects(item.content).some((part) => (
      stringValue(part.type) === 'refusal' && Boolean(optionalString(part.refusal))
    ))
  })
}

function responsesStatusFields(reason: CompletionReason): ResponsesStatusFields {
  if (reason === 'length') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  }
  if (reason === 'content_filter') {
    return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
  }
  return { status: 'completed' }
}

function completionReasonToChat(reason: CompletionReason): string {
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

function completionReasonToAnthropic(reason: CompletionReason): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function completionReasonToGemini(reason: CompletionReason): string {
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'content_filter') return 'SAFETY'
  return 'STOP'
}

function geminiContentFilterReason(reason: string): boolean {
  return reason === 'SAFETY'
    || reason === 'RECITATION'
    || reason === 'BLOCKLIST'
    || reason === 'PROHIBITED_CONTENT'
    || reason === 'SPII'
    || reason === 'IMAGE_SAFETY'
}

function anthropicStopReasonToChat(reason: string, hasToolCalls = false): string {
  return completionReasonToChat(anthropicCompletionReason(reason, hasToolCalls))
}

function chatFinishReasonToAnthropic(reason: string, hasToolCalls = false): string {
  return completionReasonToAnthropic(chatCompletionReason(reason, hasToolCalls))
}

function chatFinishReasonToGemini(reason: string, hasToolCalls = false): string {
  return completionReasonToGemini(chatCompletionReason(reason, hasToolCalls))
}

function chatStopToAnthropic(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  return stringArray(value)
}

function copyGeminiGenerationOptionsToResponses(source: JsonObject, target: JsonObject): void {
  const temperature = numberValue(source.temperature)
  const topP = numberValue(source.topP)
  if (temperature !== undefined) target.temperature = temperature
  if (topP !== undefined) target.top_p = topP
}

function copyOptional(source: JsonObject, target: JsonObject, keys: string[]): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key]
  }
}

function omitUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function arrayOfObjects(value: unknown): JsonObject[] {
  const objects: JsonObject[] = []
  for (const item of arrayValue(value)) {
    const object = objectValue(item)
    if (object) objects.push(object)
  }
  return objects
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeProtocolErrorCode(value: unknown): string | undefined {
  const code = optionalString(value)?.trim()
  return code && /^[a-z][a-z0-9_]{0,95}$/i.test(code) ? code : undefined
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function parseJsonObject(value: unknown, path = 'tool.arguments'): JsonObject {
  if (value === undefined) return {}
  if (objectValue(value)) return value as JsonObject
  if (typeof value !== 'string') throw new InvalidToolArgumentsError(path)
  try {
    const parsed = objectValue(JSON.parse(value) as unknown)
    if (!parsed) throw new InvalidToolArgumentsError(path)
    return parsed
  } catch {
    throw new InvalidToolArgumentsError(path)
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text: string[] = []
    for (const item of value) {
      const part = objectValue(item)
      if (part) text.push(stringValue(part.text))
    }
    return text.join('')
  }
  return ''
}

function chatContentToText(value: unknown): string {
  if (typeof value === 'string') return value
  const text: string[] = []
  for (const item of arrayValue(value)) {
    const part = objectValue(item)
    if (part) text.push(stringValue(part.text))
  }
  return text.join('')
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined
  return value as string[]
}
