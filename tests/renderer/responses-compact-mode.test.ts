import { describe, expect, it } from 'vitest'
import {
  effectiveResponsesCompactMode,
  officialOpenAiUsesNativeCompact,
  relayCanConfigureResponsesCompact,
  responsesCompactModeCopy,
  responsesCompactModeForSave,
  responsesCompactModes,
} from '../../src/renderer/src/responses-compact-mode'

describe('Responses compact capability UI boundaries', () => {
  it('keeps old and malformed relay configurations on the compatible legacy default', () => {
    expect(effectiveResponsesCompactMode(undefined)).toBe('legacy')
    expect(effectiveResponsesCompactMode('unsupported')).toBe('legacy')
    expect(responsesCompactModeForSave('relay', 'openai-responses', undefined)).toBe('legacy')
  })

  it('offers all three modes only for OpenAI Responses relays', () => {
    expect(responsesCompactModes).toEqual(['legacy', 'passthrough', 'native'])
    expect(relayCanConfigureResponsesCompact('relay', 'openai-responses')).toBe(true)
    expect(relayCanConfigureResponsesCompact('relay', 'openai-chat')).toBe(false)
    expect(relayCanConfigureResponsesCompact('official-api', 'openai-responses')).toBe(false)
    for (const mode of responsesCompactModes) {
      expect(responsesCompactModeForSave('relay', 'openai-responses', mode)).toBe(mode)
    }
    expect(responsesCompactModeForSave('relay', 'openai-chat', 'native')).toBeUndefined()
    expect(responsesCompactModeForSave('official-api', 'openai-responses', 'legacy')).toBeUndefined()
  })

  it('shows official OpenAI Responses as automatic native capability', () => {
    expect(officialOpenAiUsesNativeCompact('official-api', 'openai', 'openai-responses')).toBe(true)
    expect(officialOpenAiUsesNativeCompact('official-api', 'openai', 'openai-chat')).toBe(false)
    expect(officialOpenAiUsesNativeCompact('relay', 'openai', 'openai-responses')).toBe(false)
  })

  it('explains standalone fallback, in-band trigger, and opaque-history risks in both languages', () => {
    for (const mode of responsesCompactModes) {
      expect(responsesCompactModeCopy[mode].labelZh).toBeTruthy()
      expect(responsesCompactModeCopy[mode].labelEn).toBeTruthy()
      expect(responsesCompactModeCopy[mode].helpZh).toBeTruthy()
      expect(responsesCompactModeCopy[mode].helpEn).toBeTruthy()
    }
    expect(responsesCompactModeCopy.legacy.helpEn).toContain('/responses/compact')
    expect(responsesCompactModeCopy.legacy.helpEn).toContain('compaction_trigger')
    expect(responsesCompactModeCopy.legacy.helpEn).toContain('metadata headers are not sent')
    expect(responsesCompactModeCopy.passthrough.helpEn).toContain('encrypted_content')
    expect(responsesCompactModeCopy.passthrough.helpEn).toContain('metadata headers')
    expect(responsesCompactModeCopy.passthrough.helpEn).toContain('4xx')
    expect(responsesCompactModeCopy.native.helpEn).toContain('metadata headers')
    expect(responsesCompactModeCopy.native.helpEn).toContain('corrupt')
  })
})
