import { describe, expect, it } from 'vitest'
import type {
  ClientConfigEditorField,
  ClientConfigEditorFile,
  ClientConfigEditorState,
  ClientConfigFileRole,
  RouteClient,
} from '../../src/shared/types'
import {
  buildClientConfigWorkbenchPreview,
  clientConfigFieldGuides,
  createInitialClientConfigDrafts,
  getClientConfigFieldGuide,
  isClientConfigWorkbenchDirty,
  localizeClientConfigEditorField,
  resetClientConfigDrafts,
} from '../../src/renderer/src/client-config-workbench'
import { clientConfigEditorFields } from '../../src/main/client-config/catalog'

function field(
  id: string,
  value: ClientConfigEditorField['value'],
  overrides: Partial<ClientConfigEditorField> = {},
): ClientConfigEditorField {
  const metadata = clientConfigFieldGuides[id]
  return {
    id,
    role: metadata?.role ?? 'codex-config',
    path: [...(metadata?.path ?? [id])],
    section: '测试',
    label: id,
    description: metadata?.description ?? `${id} 的说明`,
    control: 'text',
    value,
    ...overrides,
  }
}

function file(
  role: ClientConfigFileRole,
  content: string | undefined,
  overrides: Partial<ClientConfigEditorFile> = {},
): ClientConfigEditorFile {
  return {
    role,
    path: `C:/config/${role}`,
    format: role === 'codex-config' ? 'toml' : role === 'gemini-env' ? 'dotenv' : 'json',
    exists: content !== undefined,
    editable: content !== undefined,
    containsCredential: false,
    content,
    revision: `revision-${role}`,
    protectedValueCount: 0,
    ...overrides,
  }
}

function editor(
  client: RouteClient,
  fields: ClientConfigEditorField[],
  files: ClientConfigEditorFile[],
): ClientConfigEditorState {
  return { client, profileId: `default-${client}`, fields, files }
}

describe('client configuration workbench drafts', () => {
  it('creates independent field and file drafts from an editor snapshot', () => {
    const sourceFields = [field('claude.permissionsAllow', ['Bash(git:*)'])]
    const source = editor('claude', sourceFields, [file('claude-settings', '{"model":"claude"}\n')])
    const drafts = createInitialClientConfigDrafts(source)

    expect(drafts).toEqual({
      fieldDrafts: { 'claude.permissionsAllow': ['Bash(git:*)'] },
      fileDrafts: { 'claude-settings': '{"model":"claude"}\n' },
    })
    ;(drafts.fieldDrafts['claude.permissionsAllow'] as string[]).push('Read(*)')
    expect(sourceFields[0].value).toEqual(['Bash(git:*)'])
  })

  it('does not treat omitted drafts as edits and detects explicit empty file drafts', () => {
    const source = editor('codex', [field('codex.model', 'gpt-current')], [file('codex-config', 'model = "gpt-current"\n')])

    expect(isClientConfigWorkbenchDirty(source, {}, {})).toBe(false)
    expect(isClientConfigWorkbenchDirty(source, { 'codex.model': 'gpt-current' }, {})).toBe(false)
    expect(isClientConfigWorkbenchDirty(source, {}, { 'codex-config': '' })).toBe(true)
  })

  it('ignores discovered read-only field drafts and preserves them during recommended reset', () => {
    const discovered = field('codex.discovered.custom', 30, {
      control: 'number',
      path: ['custom_timeout'],
      readOnly: true,
      source: 'discovered',
    })
    const source = editor('codex', [discovered], [file('codex-config', 'custom_timeout = 30\n')])

    expect(isClientConfigWorkbenchDirty(source, { [discovered.id]: 60 }, {})).toBe(false)
    expect(resetClientConfigDrafts(source).fieldDrafts[discovered.id]).toBe(30)
    expect(buildClientConfigWorkbenchPreview(source, { [discovered.id]: 60 }, {}).documents[0].content)
      .toBe('custom_timeout = 30\n')
  })

  it('resets files to their loaded content and fields to conservative recommended values', () => {
    const source = editor('codex', [
      field('codex.model', 'gpt-current'),
      field('codex.approvalPolicy', 'never'),
      field('codex.sandboxMode', 'danger-full-access'),
    ], [file('codex-config', 'model = "gpt-current"\n')])

    expect(resetClientConfigDrafts(source)).toEqual({
      fieldDrafts: {
        'codex.model': null,
        'codex.approvalPolicy': 'on-request',
        'codex.sandboxMode': 'workspace-write',
      },
      fileDrafts: { 'codex-config': 'model = "gpt-current"\n' },
    })
    expect(resetClientConfigDrafts(source, 'current').fieldDrafts).toEqual({
      'codex.model': 'gpt-current',
      'codex.approvalPolicy': 'never',
      'codex.sandboxMode': 'danger-full-access',
    })
  })
})

describe('client configuration workbench preview', () => {
  it('overlays changed Codex fields on the complete TOML draft and preserves unknown content', () => {
    const original = [
      '# user comment',
      'model = "gpt-original"',
      'approval_policy = "never"',
      'unknown_top_level = 42',
      '',
      '[model_providers.custom]',
      'base_url = "https://custom.example/v1"',
      '',
    ].join('\n')
    const source = editor('codex', [
      field('codex.model', 'gpt-original'),
      field('codex.approvalPolicy', 'never'),
      field('codex.webSearch', null),
    ], [
      file('codex-config', original),
      file('codex-auth', undefined, { editable: false, containsCredential: true, protectedValueCount: 1 }),
    ])
    const advancedDraft = original.replace('unknown_top_level = 42', 'unknown_top_level = 84')

    const preview = buildClientConfigWorkbenchPreview(source, {
      'codex.model': 'gpt-next',
      'codex.approvalPolicy': 'never',
      'codex.webSearch': 'cached',
    }, { 'codex-config': advancedDraft })
    const config = preview.documents.find((document) => document.role === 'codex-config')!
    const auth = preview.documents.find((document) => document.role === 'codex-auth')!

    expect(config.content).toContain('# user comment')
    expect(config.content).toContain('model = "gpt-next"')
    expect(config.content).toContain('web_search = "cached"')
    expect(config.content).toContain('unknown_top_level = 84')
    expect(config.content).toContain('[model_providers.custom]')
    expect(config.changed).toBe(true)
    expect(config.syntaxError).toBeUndefined()
    expect(auth.content).toBeUndefined()
    expect(auth.changed).toBe(false)
    expect(preview).toMatchObject({ dirty: true, hasErrors: false })
    expect(preview.fieldLocations['codex.model']).toMatchObject({
      role: 'codex-config', key: 'model', lineStart: 2, lineEnd: 2,
    })
    expect(preview.fieldLocations['codex.webSearch']).toMatchObject({
      role: 'codex-config', key: 'web_search', lineStart: 6, lineEnd: 6,
    })
  })

  it('does not overwrite an advanced editor value when the matching common field is unchanged', () => {
    const original = 'model = "gpt-original"\n'
    const source = editor('codex', [field('codex.model', 'gpt-original')], [file('codex-config', original)])
    const advanced = 'model = "advanced-choice"\n'

    const preview = buildClientConfigWorkbenchPreview(source, { 'codex.model': 'gpt-original' }, { 'codex-config': advanced })

    expect(preview.documents[0].content).toBe(advanced)
  })

  it('supports editable numeric TOML fields supplied by the expanded catalog', () => {
    const timeout = field('codex.customTimeout', 30, {
      control: 'number',
      path: ['custom_timeout'],
      recommendedValue: 60,
    })
    const source = editor('codex', [timeout], [file('codex-config', 'custom_timeout = 30\n')])

    const preview = buildClientConfigWorkbenchPreview(source, { [timeout.id]: 45 }, {})

    expect(preview.documents[0].content).toBe('custom_timeout = 45\n')
    expect(resetClientConfigDrafts(source).fieldDrafts[timeout.id]).toBe(60)
  })

  it('previews nested TOML fields and locates assignments under quoted table names', () => {
    const multiAgent = field('codex.feature.multi_agent', true, {
      control: 'toggle',
      path: ['features', 'multi_agent'],
    })
    const plugin = field('codex.discovered.plugin', true, {
      control: 'toggle',
      path: ['plugins', 'documents@openai-primary-runtime', 'enabled'],
      readOnly: true,
      source: 'discovered',
    })
    const content = [
      '[features]',
      'multi_agent = true',
      '',
      '[plugins."documents@openai-primary-runtime"]',
      'enabled = true',
      '',
    ].join('\n')
    const source = editor('codex', [multiAgent, plugin], [file('codex-config', content)])

    const preview = buildClientConfigWorkbenchPreview(source, {
      [multiAgent.id]: false,
      [plugin.id]: true,
    }, {})

    expect(preview.documents[0].content).toContain('multi_agent = false')
    expect(preview.hasErrors).toBe(false)
    expect(preview.fieldLocations[multiAgent.id]).toMatchObject({ lineStart: 2, lineEnd: 2 })
    expect(preview.fieldLocations[plugin.id]).toMatchObject({ lineStart: 5, lineEnd: 5 })
  })

  it('overlays nested Claude JSON fields, keeps protected values, and maps array line ranges', () => {
    const original = JSON.stringify({
      model: 'claude-old',
      permissions: { allow: ['Read(*)'], defaultMode: 'default' },
      env: { TOKEN: '__STONE_PROTECTED_VALUE__' },
      unknown: true,
    }, null, 2) + '\n'
    const source = editor('claude', [
      field('claude.model', 'claude-old'),
      field('claude.permissionsAllow', ['Read(*)'], { control: 'string-list' }),
      field('claude.permissionMode', 'default', { control: 'select' }),
    ], [file('claude-settings', original, { protectedValueCount: 1 })])

    const preview = buildClientConfigWorkbenchPreview(source, {
      'claude.model': null,
      'claude.permissionsAllow': ['Read(*)', 'Bash(git:*)'],
      'claude.permissionMode': 'plan',
    }, {})
    const document = preview.documents[0]
    const parsed = JSON.parse(document.content!)

    expect(parsed.model).toBeUndefined()
    expect(parsed.permissions).toEqual({ allow: ['Read(*)', 'Bash(git:*)'], defaultMode: 'plan' })
    expect(parsed.env.TOKEN).toBe('__STONE_PROTECTED_VALUE__')
    expect(parsed.unknown).toBe(true)
    expect(preview.fieldLocations['claude.permissionsAllow'].lineEnd)
      .toBeGreaterThan(preview.fieldLocations['claude.permissionsAllow'].lineStart!)
  })

  it('returns the unchanged invalid full-file draft with a syntax error instead of throwing', () => {
    const original = '{"model":"old"}\n'
    const source = editor('gemini', [field('gemini.model', 'old')], [file('gemini-settings', original)])

    const preview = buildClientConfigWorkbenchPreview(source, { 'gemini.model': 'new' }, {
      'gemini-settings': '{ invalid json',
    })

    expect(preview.hasErrors).toBe(true)
    expect(preview.documents[0]).toMatchObject({
      content: '{ invalid json',
      changed: true,
    })
    expect(preview.documents[0].syntaxError).toContain('Cannot parse gemini-settings')
  })

  it('validates advanced-only TOML drafts even when no common field changed', () => {
    const source = editor('codex', [field('codex.model', 'gpt-current')], [
      file('codex-config', 'model = "gpt-current"\n'),
    ])

    const preview = buildClientConfigWorkbenchPreview(source, { 'codex.model': 'gpt-current' }, {
      'codex-config': 'model = [broken\n',
    })

    expect(preview.hasErrors).toBe(true)
    expect(preview.documents[0].syntaxError).toContain('Cannot parse codex-config')
  })

  it('keeps Gemini JSON and protected dotenv as separate live-preview documents', () => {
    const settings = '{"model":{"name":"gemini-old"}}\n'
    const environment = 'GEMINI_API_KEY="__STONE_PROTECTED_VALUE__"\n'
    const source = editor('gemini', [field('gemini.model', 'gemini-old')], [
      file('gemini-settings', settings),
      file('gemini-env', environment, { protectedValueCount: 1 }),
    ])

    const preview = buildClientConfigWorkbenchPreview(source, { 'gemini.model': 'gemini-next' }, {})

    expect(JSON.parse(preview.documents[0].content!).model.name).toBe('gemini-next')
    expect(preview.documents[1].content).toBe(environment)
    expect(preview.documents[1].protectedValueCount).toBe(1)
  })

  it('provides descriptions, paths and defaults for representative client fields', () => {
    const ids = [
      'claude.model', 'claude.effort', 'claude.permissionMode', 'claude.permissionsAllow', 'claude.permissionsAsk', 'claude.permissionsDeny',
      'codex.model', 'codex.reasoningEffort', 'codex.approvalPolicy', 'codex.sandboxMode', 'codex.webSearch', 'codex.personality',
      'gemini.model', 'gemini.approvalMode', 'gemini.allowedTools', 'gemini.excludedTools', 'gemini.theme',
    ]

    for (const id of ids) {
      const fieldGuide = getClientConfigFieldGuide(field(id, null))
      expect(fieldGuide?.role).toBeTruthy()
      expect(fieldGuide?.path.length).toBeGreaterThan(0)
      expect(fieldGuide?.description.length).toBeGreaterThan(10)
      expect(fieldGuide?.defaultLabel.length).toBeGreaterThan(0)
    }
  })
})

describe('client configuration workbench localization', () => {
  it('provides complete English presentation metadata for every catalog field', () => {
    const chinese = /[\u3400-\u9fff]/u
    for (const client of ['claude', 'codex', 'gemini'] as const) {
      const fields = clientConfigEditorFields(client, {})
      expect(fields.length).toBeGreaterThan(0)
      for (const sourceField of fields) {
        const field = localizeClientConfigEditorField(sourceField, 'en')
        const copy = [
          field.section,
          field.label,
          field.description,
          field.placeholder,
          ...field.options?.flatMap((item) => [item.label, item.description]) ?? [],
        ].filter((value): value is string => typeof value === 'string')
        expect(copy, sourceField.id).not.toSatisfy((values: string[]) => values.some((value) => chinese.test(value)))
      }
    }
  })

  it('keeps Chinese metadata intact and supplies readable English defaults and option help', () => {
    const source = clientConfigEditorFields('codex', {}).find((candidate) => candidate.id === 'codex.approvalPolicy')!
    const english = localizeClientConfigEditorField(source, 'en')

    expect(localizeClientConfigEditorField(source, 'zh-CN')).toBe(source)
    expect(english).toMatchObject({
      section: 'Permissions & sandbox',
      label: 'Approval policy',
    })
    expect(english.options?.find((item) => item.value === 'on-request')).toMatchObject({
      label: 'Ask when needed',
      description: expect.stringContaining('additional permission'),
    })
    expect(getClientConfigFieldGuide(english, 'en')?.defaultLabel).toBe('Use the client default')
  })

  it('uses an English fallback for discovered and sensitive Codex settings', () => {
    const discovered = field('codex.discovered.private', null, {
      path: ['model_providers', 'private_proxy', 'api_key'],
      section: '模型供应商（扩展）',
      label: 'api_key',
      description: '敏感值已隐藏',
      placeholder: '已安全隐藏',
      sensitive: true,
      readOnly: true,
      source: 'discovered',
    })

    expect(localizeClientConfigEditorField(discovered, 'en')).toMatchObject({
      section: 'Model providers (extended)',
      label: 'Api key',
      placeholder: 'Securely hidden',
      description: expect.not.stringMatching(/[\u3400-\u9fff]/u),
    })
  })

  it('does not leak a Chinese parser message into an English preview', () => {
    const invalidPath = field('gemini.invalidPath', null, {
      role: 'gemini-settings',
      path: [],
    })
    const source = editor('gemini', [invalidPath], [file('gemini-settings', '{}\n')])

    expect(buildClientConfigWorkbenchPreview(source, { [invalidPath.id]: 'changed' }, {}, 'en').documents[0].error)
      .toBe('Invalid configuration format')
  })
})
