import { describe, expect, it } from 'vitest'
import {
  CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS,
  isChatGptWebWmReasoningObservedEvent,
  isChatGptWebWmRequestId,
  isChatGptWebWmStreamEvent,
  isChatGptWebWmTextDeltaEvent,
  isChatGptWebWmToolCallDeltaEvent,
  isChatGptWebWmToolCallDoneEvent,
  isChatGptWebWmToolCallStartEvent,
} from '../../src/shared/chatgpt-web-wm-stream'

describe('ChatGPT Web WM stream boundary', () => {
  it('bounds each immediate cumulative-snapshot suffix', () => {
    expect(CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS).toBe(64 * 1024)
  })

  it('accepts only bounded text deltas with scoped request and message ids', () => {
    expect(isChatGptWebWmRequestId('019f8a53-37e3-7c42-a322-0acf6f8f1735')).toBe(true)
    expect(isChatGptWebWmRequestId('../other-request')).toBe(false)
    expect(isChatGptWebWmTextDeltaEvent({
      type: 'text_delta', messageId: 'message-a', delta: 'text',
    })).toBe(true)
    expect(isChatGptWebWmTextDeltaEvent({
      type: 'done', messageId: 'message-a', delta: 'text',
    })).toBe(false)
    expect(isChatGptWebWmTextDeltaEvent({
      type: 'text_delta', messageId: 'message-a', delta: 'x'.repeat(CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS + 1),
    })).toBe(false)
    expect(isChatGptWebWmReasoningObservedEvent({
      type: 'reasoning_observed', messageId: 'reasoning-a',
    })).toBe(true)
    expect(isChatGptWebWmStreamEvent({
      type: 'reasoning_observed', messageId: '',
    })).toBe(false)
  })

  it('accepts only bounded tool lifecycle events', () => {
    expect(isChatGptWebWmToolCallStartEvent({
      type: 'tool_call_start', messageId: 'tool-message', name: 'stone__lookup',
    })).toBe(true)
    expect(isChatGptWebWmToolCallStartEvent({
      type: 'tool_call_start', messageId: 'tool-message', name: 'bad tool name',
    })).toBe(false)
    expect(isChatGptWebWmToolCallDeltaEvent({
      type: 'tool_call_delta', messageId: 'tool-message', delta: '{"key":"stone"}',
    })).toBe(true)
    expect(isChatGptWebWmToolCallDeltaEvent({
      type: 'tool_call_delta',
      messageId: 'tool-message',
      delta: 'x'.repeat(CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS + 1),
    })).toBe(false)
    expect(isChatGptWebWmToolCallDoneEvent({
      type: 'tool_call_done', messageId: 'tool-message',
    })).toBe(true)
    expect(isChatGptWebWmStreamEvent({
      type: 'tool_call_done', messageId: '',
    })).toBe(false)
  })
})
