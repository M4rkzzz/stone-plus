import {
  DEEPSEEK_DSML_START_MARKERS,
  DeepSeekDsmlError,
  deepSeekDsmlEndMarker,
  parseDeepSeekDsmlBlock,
} from './deepseek-dsml'
import {
  createCanonicalStreamParser,
  type CanonicalProtocolState,
  type CanonicalStreamEvent,
  type CanonicalStreamParser,
} from './streaming'
import type { ToolBridgePlan } from './types'

/**
 * Restores DeepSeek V4 DSML text into canonical tool events while preserving
 * ordinary Responses streaming. Only the short possible marker prefix is
 * delayed; normal answer text continues streaming immediately.
 */
export function createDeepSeekDsmlStreamParser(plan: ToolBridgePlan): CanonicalStreamParser {
  return new DeepSeekDsmlStreamParser(plan)
}

class DeepSeekDsmlStreamParser implements CanonicalStreamParser {
  private readonly inner = createCanonicalStreamParser('openai-responses')
  private pendingText = ''
  private pendingTextIndex: number | undefined
  private pendingContentType: 'text' | 'refusal' | undefined
  private block = ''
  private activeStartMarker: string | undefined
  private sawDsml = false
  private sawNativeTool = false
  private failed = false
  private delayedMessageComplete: CanonicalStreamEvent[] = []
  private nextToolIndex = 0

  constructor(private readonly plan: ToolBridgePlan) {}

  push(chunk: Uint8Array): CanonicalStreamEvent[] {
    return this.transform(this.inner.push(chunk))
  }

  finish(): CanonicalStreamEvent[] {
    const events = this.transform(this.inner.finish())
    if (!this.failed && this.activeStartMarker) {
      events.unshift(...this.fail(new DeepSeekDsmlError(
        'truncated_dsml',
        'DeepSeek ended the response inside a DSML tool-call block.',
      )))
    } else if (!this.failed && this.pendingText) {
      events.unshift(this.pendingTextEvent(this.pendingText))
      this.pendingText = ''
    }
    return events
  }

  getProtocolState(): CanonicalProtocolState {
    return this.inner.getProtocolState()
  }

  getRecognizedEventCount(): number {
    return this.inner.getRecognizedEventCount()
  }

  getResponsesTerminalResponse(): Record<string, unknown> | undefined {
    return this.inner.getResponsesTerminalResponse()
  }

  private transform(events: CanonicalStreamEvent[]): CanonicalStreamEvent[] {
    const output: CanonicalStreamEvent[] = []
    for (const event of events) {
      if (this.failed) {
        if (event.type === 'usage' || event.type === 'done' || event.type === 'error') output.push(event)
        else if (event.type === 'stop') output.push({ type: 'stop', reason: 'error', rawReason: 'invalid_dsml' })
        continue
      }
      if (event.type === 'text-delta' && event.contentType !== 'refusal') {
        output.push(...this.consumeText(event))
        continue
      }
      if (event.type === 'tool-call-delta') {
        if (this.sawDsml || this.activeStartMarker) {
          output.push(...this.fail(new DeepSeekDsmlError(
            'mixed_tool_formats',
            'DeepSeek mixed native tool events with a DSML tool-call block.',
          )))
          continue
        }
        this.sawNativeTool = true
        this.nextToolIndex = Math.max(this.nextToolIndex, event.index + 1)
        output.push(event)
        continue
      }
      if (event.type === 'message-complete') {
        this.delayedMessageComplete.push(event)
        continue
      }
      if (event.type === 'stop') {
        output.push(...this.finishTextAtStop())
        if (this.failed) {
          output.push({ type: 'stop', reason: 'error', rawReason: 'invalid_dsml' })
          continue
        }
        output.push(...this.delayedMessageComplete)
        this.delayedMessageComplete = []
        output.push(this.sawDsml
          ? { type: 'stop', reason: 'tool_calls', rawReason: 'dsml_tool_calls' }
          : event)
        continue
      }
      output.push(event)
    }
    return output
  }

  private consumeText(event: Extract<CanonicalStreamEvent, { type: 'text-delta' }>): CanonicalStreamEvent[] {
    if (this.pendingText && (event.index !== this.pendingTextIndex || event.contentType !== this.pendingContentType)) {
      const flushed = this.pendingTextEvent(this.pendingText)
      this.pendingText = ''
      return [flushed, ...this.consumeText(event)]
    }
    this.pendingTextIndex = event.index
    this.pendingContentType = event.contentType

    if (this.sawDsml) {
      if (!event.text.trim()) return []
      return this.fail(new DeepSeekDsmlError(
        'content_after_dsml',
        'DeepSeek returned unexpected content after its DSML tool calls.',
      ))
    }
    if (this.activeStartMarker) return this.consumeBlockText(event.text)

    this.pendingText += event.text
    const marker = earliestMarker(this.pendingText)
    if (marker) {
      const prefix = this.pendingText.slice(0, marker.index)
      const remainder = this.pendingText.slice(marker.index)
      this.pendingText = ''
      this.activeStartMarker = marker.marker
      const output = prefix ? [this.pendingTextEvent(prefix)] : []
      output.push(...this.consumeBlockText(remainder))
      return output
    }

    const retained = longestPossibleMarkerPrefix(this.pendingText)
    const safeLength = this.pendingText.length - retained
    if (safeLength <= 0) return []
    const safe = this.pendingText.slice(0, safeLength)
    this.pendingText = this.pendingText.slice(safeLength)
    return [this.pendingTextEvent(safe)]
  }

  private consumeBlockText(text: string): CanonicalStreamEvent[] {
    this.block += text
    const endMarker = deepSeekDsmlEndMarker(this.activeStartMarker!)
    const endIndex = this.block.indexOf(endMarker)
    if (endIndex < 0) return []
    const blockEnd = endIndex + endMarker.length
    const completeBlock = this.block.slice(0, blockEnd)
    const trailing = this.block.slice(blockEnd)
    this.block = ''
    this.activeStartMarker = undefined
    if (this.sawNativeTool) {
      return this.fail(new DeepSeekDsmlError(
        'mixed_tool_formats',
        'DeepSeek mixed native tool events with a DSML tool-call block.',
      ))
    }
    try {
      const parsed = parseDeepSeekDsmlBlock(completeBlock, this.plan)
      if (!parsed) throw new DeepSeekDsmlError('invalid_dsml', 'DeepSeek returned an invalid DSML tool-call block.')
      this.sawDsml = true
      const output: CanonicalStreamEvent[] = []
      for (const call of parsed.calls) {
        const index = this.nextToolIndex++
        output.push({
          type: 'tool-call-delta',
          index,
          id: call.callId,
          name: call.binding.wireName,
          arguments: call.arguments,
        })
        output.push({ type: 'tool-call-complete', index })
      }
      if (trailing.trim()) {
        return [...output, ...this.fail(new DeepSeekDsmlError(
          'content_after_dsml',
          'DeepSeek returned unexpected content after its DSML tool calls.',
        ))]
      }
      return output
    } catch (error) {
      return this.fail(error instanceof DeepSeekDsmlError
        ? error
        : new DeepSeekDsmlError('invalid_dsml', 'DeepSeek returned an invalid DSML tool-call block.'))
    }
  }

  private finishTextAtStop(): CanonicalStreamEvent[] {
    if (this.activeStartMarker) {
      return this.fail(new DeepSeekDsmlError(
        'truncated_dsml',
        'DeepSeek ended the response inside a DSML tool-call block.',
      ))
    }
    if (!this.pendingText) return []
    const text = this.pendingText
    this.pendingText = ''
    if (this.sawDsml && text.trim()) {
      return this.fail(new DeepSeekDsmlError(
        'content_after_dsml',
        'DeepSeek returned unexpected content after its DSML tool calls.',
      ))
    }
    return this.sawDsml ? [] : [this.pendingTextEvent(text)]
  }

  private pendingTextEvent(text: string): CanonicalStreamEvent {
    return {
      type: 'text-delta',
      text,
      ...(this.pendingTextIndex === undefined ? {} : { index: this.pendingTextIndex }),
      ...(this.pendingContentType === undefined ? {} : { contentType: this.pendingContentType }),
    }
  }

  private fail(error: DeepSeekDsmlError): CanonicalStreamEvent[] {
    this.failed = true
    this.pendingText = ''
    this.block = ''
    this.delayedMessageComplete = []
    return [{
      type: 'error',
      message: error.message,
      code: error.code,
      errorType: 'invalid_deepseek_dsml',
    }]
  }
}

function earliestMarker(text: string): { index: number; marker: string } | undefined {
  let match: { index: number; marker: string } | undefined
  for (const marker of DEEPSEEK_DSML_START_MARKERS) {
    const index = text.indexOf(marker)
    if (index >= 0 && (!match || index < match.index)) match = { index, marker }
  }
  return match
}

function longestPossibleMarkerPrefix(text: string): number {
  const limit = Math.min(text.length, Math.max(...DEEPSEEK_DSML_START_MARKERS.map((marker) => marker.length - 1)))
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length)
    if (DEEPSEEK_DSML_START_MARKERS.some((marker) => marker.startsWith(suffix))) return length
  }
  return 0
}
