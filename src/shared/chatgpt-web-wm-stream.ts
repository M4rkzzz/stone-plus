export const CHATGPT_WEB_WM_STREAM_CHANNEL = 'stone:internal-web-wm-stream'
export const CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT = '--stone-web-wm-bridge-token='
export const CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS = 64 * 1024

const CHATGPT_WEB_WM_REQUEST_ID_PATTERN = /^[a-z0-9-]{8,80}$/i
const CHATGPT_WEB_WM_TOOL_NAME_PATTERN = /^[a-z0-9_.:-]{1,256}$/i

export interface ChatGptWebWmTextDeltaEvent {
  type: 'text_delta'
  messageId: string
  delta: string
}

export interface ChatGptWebWmReasoningObservedEvent {
  type: 'reasoning_observed'
  messageId: string
}

export interface ChatGptWebWmToolCallStartEvent {
  type: 'tool_call_start'
  messageId: string
  name: string
}

export interface ChatGptWebWmToolCallDeltaEvent {
  type: 'tool_call_delta'
  messageId: string
  delta: string
}

export interface ChatGptWebWmToolCallDoneEvent {
  type: 'tool_call_done'
  messageId: string
}

export type ChatGptWebWmStreamEvent =
  | ChatGptWebWmTextDeltaEvent
  | ChatGptWebWmReasoningObservedEvent
  | ChatGptWebWmToolCallStartEvent
  | ChatGptWebWmToolCallDeltaEvent
  | ChatGptWebWmToolCallDoneEvent

export function isChatGptWebWmRequestId(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_WEB_WM_REQUEST_ID_PATTERN.test(value)
}

export function isChatGptWebWmTextDeltaEvent(value: unknown): value is ChatGptWebWmTextDeltaEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<ChatGptWebWmTextDeltaEvent>
  return event.type === 'text_delta'
    && isMessageId(event.messageId)
    && typeof event.delta === 'string'
    && event.delta.length > 0
    && event.delta.length <= CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS
}

export function isChatGptWebWmReasoningObservedEvent(
  value: unknown,
): value is ChatGptWebWmReasoningObservedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<ChatGptWebWmReasoningObservedEvent>
  return event.type === 'reasoning_observed' && isMessageId(event.messageId)
}

export function isChatGptWebWmToolCallStartEvent(
  value: unknown,
): value is ChatGptWebWmToolCallStartEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<ChatGptWebWmToolCallStartEvent>
  return event.type === 'tool_call_start'
    && isMessageId(event.messageId)
    && typeof event.name === 'string'
    && CHATGPT_WEB_WM_TOOL_NAME_PATTERN.test(event.name)
}

export function isChatGptWebWmToolCallDeltaEvent(
  value: unknown,
): value is ChatGptWebWmToolCallDeltaEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<ChatGptWebWmToolCallDeltaEvent>
  return event.type === 'tool_call_delta'
    && isMessageId(event.messageId)
    && typeof event.delta === 'string'
    && event.delta.length > 0
    && event.delta.length <= CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS
}

export function isChatGptWebWmToolCallDoneEvent(
  value: unknown,
): value is ChatGptWebWmToolCallDoneEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<ChatGptWebWmToolCallDoneEvent>
  return event.type === 'tool_call_done' && isMessageId(event.messageId)
}

export function isChatGptWebWmStreamEvent(value: unknown): value is ChatGptWebWmStreamEvent {
  return isChatGptWebWmTextDeltaEvent(value)
    || isChatGptWebWmReasoningObservedEvent(value)
    || isChatGptWebWmToolCallStartEvent(value)
    || isChatGptWebWmToolCallDeltaEvent(value)
    || isChatGptWebWmToolCallDoneEvent(value)
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
}
