import { describe, expect, it } from 'vitest'
import {
  CHATGPT_WEB_WM_PROTOCOL_REVISION,
  GPT_5_6_SOL_WM_MODEL,
  MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION,
  MINIMUM_CODEX_DESKTOP_WEB_WM_VERSION,
  codexDesktopWebWmUpdateRequired,
  codexWebWmClientUpdateRequired,
  hasVerifiedChatGptWebWm,
  isChatGptWebWmPassthroughModel,
  isChatGptWebWmPoolProtocol,
} from '../../src/shared/wm-routing'

describe('Web WM protocol eligibility', () => {
  it('accepts only a current, verified ChatGPT OAuth capability', () => {
    const verified = {
      credentialType: 'chatgpt-oauth' as const,
      chatgptWebWm: {
        version: 2 as const,
        protocolRevision: CHATGPT_WEB_WM_PROTOCOL_REVISION,
        model: GPT_5_6_SOL_WM_MODEL,
        catalogModel: GPT_5_6_SOL_WM_MODEL,
        turnModel: GPT_5_6_SOL_WM_MODEL,
        workspacePlanType: 'team',
        workspaceStructure: 'workspace' as const,
        verifiedAt: 1,
        latencyMs: 0,
      },
    }

    expect(hasVerifiedChatGptWebWm(verified)).toBe(true)
    expect(hasVerifiedChatGptWebWm({ ...verified, credentialType: 'api-key' })).toBe(false)
    expect(hasVerifiedChatGptWebWm({ ...verified, chatgptWebWm: undefined })).toBe(false)
    expect(hasVerifiedChatGptWebWm({
      ...verified,
      chatgptWebWm: { ...verified.chatgptWebWm, verifiedAt: 0 },
    })).toBe(false)
    expect(hasVerifiedChatGptWebWm({
      ...verified,
      chatgptWebWm: { ...verified.chatgptWebWm, turnModel: 'gpt-5.6-terra-wm' as never },
    })).toBe(false)
  })

  it('recognizes only the dedicated logical pool protocol', () => {
    expect(isChatGptWebWmPoolProtocol('chatgpt-web-wm')).toBe(true)
    expect(isChatGptWebWmPoolProtocol('openai-responses')).toBe(false)
  })

  it('keeps only the Codex Luna auxiliary model off the Work transport', () => {
    expect(isChatGptWebWmPassthroughModel('gpt-5.6-luna')).toBe(true)
    expect(isChatGptWebWmPassthroughModel(' GPT-5.6-LUNA ')).toBe(true)
    expect(isChatGptWebWmPassthroughModel('gpt-5.6-sol')).toBe(false)
    expect(isChatGptWebWmPassthroughModel(GPT_5_6_SOL_WM_MODEL)).toBe(false)
  })

  it('prompts only Codex Desktop packages older than the supported package', () => {
    expect(codexDesktopWebWmUpdateRequired('26.809.9999.0')).toBe(true)
    expect(codexDesktopWebWmUpdateRequired(MINIMUM_CODEX_DESKTOP_WEB_WM_VERSION)).toBe(false)
    expect(codexDesktopWebWmUpdateRequired('26.811.1.0')).toBe(false)
    expect(codexDesktopWebWmUpdateRequired(undefined)).toBe(false)
    expect(codexDesktopWebWmUpdateRequired('not-a-version')).toBe(false)
  })

  it('rejects only recognized old Codex app-server user agents', () => {
    expect(codexWebWmClientUpdateRequired('codex_cli_rs/0.147.0-alpha.99')).toBe(true)
    expect(codexWebWmClientUpdateRequired(
      `codex_cli_rs/${MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION}`,
    )).toBe(false)
    expect(codexWebWmClientUpdateRequired('codex-cli/0.148.0-alpha.10')).toBe(false)
    expect(codexWebWmClientUpdateRequired('stone-test-client/1.0')).toBe(false)
    expect(codexWebWmClientUpdateRequired(undefined)).toBe(false)
  })
})
