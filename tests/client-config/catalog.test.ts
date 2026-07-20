import { describe, expect, it } from 'vitest'
import {
  applyClientConfigFieldPatches,
  clientConfigEditorFields,
} from '../../src/main/client-config/catalog'
import { parseCodexToml } from '../../src/main/client-config/toml-format'
import { ClientConfigParseError, ClientConfigValidationError } from '../../src/main/client-config/types'

function valuesFor(client: 'claude' | 'codex' | 'gemini', existing: Record<string, string>) {
  return Object.fromEntries(clientConfigEditorFields(client, existing).map((field) => [field.id, field.value]))
}

describe('client configuration field catalog', () => {
  it('extracts and patches Claude fields while preserving unknown JSON and removing null fields', () => {
    const existing = {
      'claude-settings': JSON.stringify({
        model: 'claude-existing',
        effortLevel: 'medium',
        permissions: {
          defaultMode: 'plan',
          allow: ['Read'],
          ask: ['Bash'],
          deny: ['Write'],
          futureOption: { keep: true },
        },
        unknownTopLevel: { keep: 'yes' },
      }, null, 2) + '\n',
    }

    expect(valuesFor('claude', existing)).toMatchObject({
      'claude.model': 'claude-existing',
      'claude.effort': 'medium',
      'claude.permissionMode': 'plan',
      'claude.permissionsAllow': ['Read'],
      'claude.permissionsAsk': ['Bash'],
      'claude.permissionsDeny': ['Write'],
    })

    const patched = applyClientConfigFieldPatches('claude', existing, [
      { id: 'claude.model', value: 'claude-updated' },
      { id: 'claude.permissionsAllow', value: [' Read ', '', 'Bash'] },
      { id: 'claude.permissionsAsk', value: null },
    ])
    const result = JSON.parse(patched['claude-settings']!)

    expect(result.model).toBe('claude-updated')
    expect(result.permissions.allow).toEqual(['Read', 'Bash'])
    expect(result.permissions).not.toHaveProperty('ask')
    expect(result.permissions.futureOption).toEqual({ keep: true })
    expect(result.unknownTopLevel).toEqual({ keep: 'yes' })
  })

  it('extracts and patches Codex fields while preserving unknown TOML and removing null fields', () => {
    const existing = {
      'codex-config': [
        'model = "gpt-existing"',
        'model_reasoning_effort = "high"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'web_search = "live"',
        'personality = "friendly"',
        'future_option = "keep" # unknown top-level field',
        '',
        '[features]',
        'parallel = true # unknown section',
        '',
      ].join('\n'),
    }

    expect(valuesFor('codex', existing)).toMatchObject({
      'codex.model': 'gpt-existing',
      'codex.reasoningEffort': 'high',
      'codex.approvalPolicy': 'on-request',
      'codex.sandboxMode': 'workspace-write',
      'codex.webSearch': 'live',
      'codex.personality': 'friendly',
      'codex.discovered.future_option': 'keep',
      'codex.discovered.features/parallel': true,
    })

    const patched = applyClientConfigFieldPatches('codex', existing, [
      { id: 'codex.model', value: 'gpt-updated' },
      { id: 'codex.approvalPolicy', value: 'never' },
      { id: 'codex.reasoningEffort', value: null },
    ])
    const content = patched['codex-config']!
    const result = parseCodexToml(content)

    expect(result.model).toBe('gpt-updated')
    expect(result.approval_policy).toBe('never')
    expect(result).not.toHaveProperty('model_reasoning_effort')
    expect(result.future_option).toBe('keep')
    expect(result.features).toEqual({ parallel: true })
    expect(content).toContain('future_option = "keep" # unknown top-level field')
    expect(content).toContain('parallel = true # unknown section')
  })

  it('extracts and patches Gemini fields while preserving unknown JSON and removing null fields', () => {
    const existing = {
      'gemini-settings': JSON.stringify({
        model: { name: 'gemini-existing', futureOption: 'keep-model-option' },
        general: { defaultApprovalMode: 'plan', futureOption: true },
        tools: { allowed: ['read_file'], exclude: ['shell'], futureOption: ['keep'] },
        ui: { theme: 'Dracula', density: 'compact' },
        useWriteTodos: true,
        unknownTopLevel: { keep: 42 },
      }, null, 2) + '\n',
    }

    expect(valuesFor('gemini', existing)).toMatchObject({
      'gemini.model': 'gemini-existing',
      'gemini.approvalMode': 'plan',
      'gemini.allowedTools': ['read_file'],
      'gemini.excludedTools': ['shell'],
      'gemini.theme': 'Dracula',
    })

    const patched = applyClientConfigFieldPatches('gemini', existing, [
      { id: 'gemini.model', value: 'gemini-updated' },
      { id: 'gemini.allowedTools', value: [' read_file ', 'write_file'] },
      { id: 'gemini.excludedTools', value: null },
      { id: 'gemini.usageStatistics', value: false },
    ])
    const result = JSON.parse(patched['gemini-settings']!)

    expect(result.model).toEqual({ name: 'gemini-updated', futureOption: 'keep-model-option' })
    expect(result.tools.allowed).toEqual(['read_file', 'write_file'])
    expect(result.tools).not.toHaveProperty('exclude')
    expect(result.tools.futureOption).toEqual(['keep'])
    expect(result.useWriteTodos).toBe(true)
    expect(result.privacy.usageStatisticsEnabled).toBe(false)
    expect(result.unknownTopLevel).toEqual({ keep: 42 })
  })

  it('rejects unknown, duplicate, malformed, and structurally unsafe field patches', () => {
    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.unknown', value: 'value' },
    ])).toThrow(ClientConfigValidationError)

    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.model', value: 'first' },
      { id: 'claude.model', value: 'second' },
    ])).toThrow('more than once')

    expect(() => applyClientConfigFieldPatches('codex', {}, [
      { id: 'codex.sandboxMode', value: 'unconfined' },
    ])).toThrow('option is invalid')

    expect(() => applyClientConfigFieldPatches('gemini', {}, [
      { id: 'gemini.usageStatistics', value: 'yes' },
    ])).toThrow('must be true or false')

    expect(() => applyClientConfigFieldPatches('claude', {}, [
      { id: 'claude.permissionsAllow', value: ['Read', 42] as never },
    ])).toThrow('list is invalid')

    expect(() => applyClientConfigFieldPatches('gemini', {
      'gemini-settings': '{"model":"owned-by-newer-client"}\n',
    }, [
      { id: 'gemini.model', value: 'gemini-updated' },
    ])).toThrow(ClientConfigParseError)
  })

  it('returns explanatory metadata and patches nested TOML and numeric fields without reformatting neighbors', () => {
    const existing = {
      'codex-config': [
        'model = "gpt-existing" # keep model comment',
        '',
        '[features]',
        'multi_agent = false # keep feature comment',
        'future_flag = true',
        '',
        '[windows]',
        'sandbox = "unelevated"',
        '',
      ].join('\n'),
    }
    const editorFields = clientConfigEditorFields('codex', existing)
    const model = editorFields.find((field) => field.id === 'codex.model')!
    const discovered = editorFields.find((field) => field.id === 'codex.discovered.features/future_flag')!

    expect(model).toMatchObject({
      role: 'codex-config',
      path: ['model'],
      section: '模型',
      source: 'catalog',
    })
    expect(model.description).toContain('新会话')
    expect(discovered).toMatchObject({
      role: 'codex-config',
      path: ['features', 'future_flag'],
      value: true,
      control: 'toggle',
      readOnly: true,
      source: 'discovered',
    })

    const patched = applyClientConfigFieldPatches('codex', existing, [
      { id: 'codex.feature.multi_agent', value: true },
      { id: 'codex.windowsSandbox', value: 'elevated' },
      { id: 'codex.agentsMaxThreads', value: 8 },
    ])['codex-config']!
    expect(parseCodexToml(patched)).toMatchObject({
      features: { multi_agent: true, future_flag: true },
      windows: { sandbox: 'elevated' },
      agents: { max_threads: 8 },
    })
    expect(patched).toContain('model = "gpt-existing" # keep model comment')
    expect(patched).toContain('multi_agent = true # keep feature comment')
  })

  it('masks sensitive discovered TOML values and rejects read-only or out-of-range patches', () => {
    const editorFields = clientConfigEditorFields('codex', {
      'codex-config': [
        '[model_providers.private]',
        'name = "Private"',
        'experimental_bearer_token = "do-not-expose"',
        '',
      ].join('\n'),
    })
    const token = editorFields.find((field) => field.path.join('.') === 'model_providers.private.experimental_bearer_token')!
    expect(token).toMatchObject({ value: null, sensitive: true, readOnly: true })
    expect(JSON.stringify(editorFields)).not.toContain('do-not-expose')

    expect(() => applyClientConfigFieldPatches('codex', {}, [
      { id: 'codex.modelProvider', value: 'other' },
    ])).toThrow('read-only')
    expect(() => applyClientConfigFieldPatches('gemini', {}, [
      { id: 'gemini.maxAttempts', value: 11 },
    ])).toThrow('above its maximum')
  })
})
