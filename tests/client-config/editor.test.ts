import { describe, expect, it } from 'vitest'
import {
  createClientConfigEditorFile,
  protectedValuePlaceholder,
  restoreClientConfigEditorContent,
  revisionOf,
} from '../../src/main/client-config/editor'
import { resolveClientConfigPaths } from '../../src/main/client-config/paths'

const paths = resolveClientConfigPaths({ homeDir: '/home/tester', platform: 'linux' })

describe('client configuration editor protection', () => {
  it('redacts strings in JSON environment/header containers and secret-named fields', () => {
    const secrets = [
      'env-token-value',
      'nested-env-value',
      'array-env-value',
      'object-env-value',
      'named-secret-value',
      'header-key-value',
      'header-content-type-value',
    ]
    const source = JSON.stringify({
      model: 'visible-model',
      env: {
        ANTHROPIC_AUTH_TOKEN: secrets[0],
        nested: { value: secrets[1], enabled: true },
        list: [secrets[2], { apiKey: secrets[3] }],
      },
      integration: {
        clientSecret: secrets[4],
        endpoint: 'https://visible.example',
      },
      headers: {
        'x-api-key': secrets[5],
        'content-type': secrets[6],
      },
    }, null, 2) + '\n'

    const editor = createClientConfigEditorFile(paths.claude.settings, source)
    const content = editor.content!
    const protectedConfig = JSON.parse(content)

    expect(protectedConfig.model).toBe('visible-model')
    expect(protectedConfig.integration.endpoint).toBe('https://visible.example')
    expect(protectedConfig.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: protectedValuePlaceholder,
      nested: { value: protectedValuePlaceholder, enabled: true },
      list: [protectedValuePlaceholder, { apiKey: protectedValuePlaceholder }],
    })
    expect(protectedConfig.integration.clientSecret).toBe(protectedValuePlaceholder)
    expect(protectedConfig.headers).toEqual({
      'x-api-key': protectedValuePlaceholder,
      'content-type': protectedValuePlaceholder,
    })
    expect(editor.protectedValueCount).toBe(7)
    for (const secret of secrets) expect(content).not.toContain(secret)
  })

  it('redacts every dotenv assignment while preserving comments, syntax, and line endings', () => {
    const source = [
      '# Gemini environment',
      'PLAIN=value-one',
      'export SPACED = "value two"',
      'EMPTY=',
      'DUPLICATE=first-value',
      'DUPLICATE=second-value',
      'not an assignment',
      '',
    ].join('\r\n')

    const editor = createClientConfigEditorFile(paths.gemini.env, source)
    const content = editor.content!
    const placeholder = JSON.stringify(protectedValuePlaceholder)

    expect(content).toBe([
      '# Gemini environment',
      `PLAIN=${placeholder}`,
      `export SPACED = ${placeholder}`,
      `EMPTY=${placeholder}`,
      `DUPLICATE=${placeholder}`,
      `DUPLICATE=${placeholder}`,
      'not an assignment',
      '',
    ].join('\r\n'))
    expect(editor.protectedValueCount).toBe(5)
    for (const value of ['value-one', 'value two', 'first-value', 'second-value']) {
      expect(content).not.toContain(value)
    }
  })

  it('redacts and restores nested TOML credentials while preserving ordinary provider settings', () => {
    const source = [
      'model = "gpt-visible"',
      'cli_auth_credentials_store = "file"',
      '',
      '[model_providers.private]',
      'name = "Visible provider"',
      'base_url = "https://visible.example/v1"',
      'experimental_bearer_token = "private-bearer-token" # secret comment',
      'api_key = "private-api-key"',
      '',
      '[model_providers.private.http_headers]',
      'Authorization = "Bearer private-header-token"',
      'Content-Type = "application/json"',
      '',
    ].join('\n')

    const editor = createClientConfigEditorFile(paths.codex.config, source)
    const content = editor.content!

    expect(content).toContain('model = "gpt-visible"')
    expect(content).toContain('cli_auth_credentials_store = "file"')
    expect(content).toContain('name = "Visible provider"')
    expect(content).toContain('base_url = "https://visible.example/v1"')
    expect(content).toContain(`experimental_bearer_token = "${protectedValuePlaceholder}" # secret comment`)
    expect(content).toContain(`api_key = "${protectedValuePlaceholder}"`)
    expect(content).toContain(`Authorization = "${protectedValuePlaceholder}"`)
    expect(content).toContain(`Content-Type = "${protectedValuePlaceholder}"`)
    expect(editor.protectedValueCount).toBe(4)
    expect(content).not.toContain('private-bearer-token')
    expect(content).not.toContain('private-api-key')
    expect(content).not.toContain('private-header-token')

    const draft = content
      .replace('model = "gpt-visible"', 'model = "gpt-updated"')
      .replace('name = "Visible provider"', 'name = "Updated provider"')
    const restored = restoreClientConfigEditorContent(paths.codex.config, draft, source)

    expect(restored).toContain('model = "gpt-updated"')
    expect(restored).toContain('name = "Updated provider"')
    expect(restored).toContain('experimental_bearer_token = "private-bearer-token" # secret comment')
    expect(restored).toContain('api_key = "private-api-key"')
    expect(restored).toContain('Authorization = "Bearer private-header-token"')
    expect(restored).toContain('Content-Type = "application/json"')
  })

  it('restores protected JSON values and still accepts edits to ordinary fields', () => {
    const source = JSON.stringify({
      model: 'old-model',
      enabled: true,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'original-token',
        KEEP: 'original-environment-value',
      },
      nested: { api_key: 'original-api-key', visible: 'old-visible-value' },
    }, null, 2) + '\n'
    const editor = createClientConfigEditorFile(paths.claude.settings, source)
    const draft = JSON.parse(editor.content!)
    draft.model = 'new-model'
    draft.enabled = false
    draft.nested.visible = 'new-visible-value'

    const restored = restoreClientConfigEditorContent(
      paths.claude.settings,
      JSON.stringify(draft, null, 2) + '\n',
      source,
    )

    expect(JSON.parse(restored)).toEqual({
      model: 'new-model',
      enabled: false,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'original-token',
        KEEP: 'original-environment-value',
      },
      nested: { api_key: 'original-api-key', visible: 'new-visible-value' },
    })
  })

  it('projects only Claude MCP servers from the protected user state file', () => {
    const source = JSON.stringify({
      oauthAccount: { accessToken: 'oauth-secret', accountId: 'private-account' },
      projects: { 'C:/work': { hasTrustDialogAccepted: true } },
      mcpServers: {
        workspace: {
          command: 'old-command',
          env: { MCP_TOKEN: 'mcp-secret' },
        },
      },
    }, null, 2) + '\n'
    const file = paths.claude.mcp!
    const editor = createClientConfigEditorFile(file, source)
    const draft = JSON.parse(editor.content!)

    expect(Object.keys(draft)).toEqual(['mcpServers'])
    expect(draft.mcpServers.workspace.env.MCP_TOKEN).toBe(protectedValuePlaceholder)
    expect(editor.content).not.toContain('oauth-secret')
    expect(editor.content).not.toContain('private-account')
    expect(editor.content).not.toContain('mcp-secret')

    draft.mcpServers.workspace.command = 'new-command'
    const restored = JSON.parse(restoreClientConfigEditorContent(
      file,
      JSON.stringify(draft, null, 2) + '\n',
      source,
    ))
    expect(restored.oauthAccount).toEqual({ accessToken: 'oauth-secret', accountId: 'private-account' })
    expect(restored.projects).toEqual({ 'C:/work': { hasTrustDialogAccepted: true } })
    expect(restored.mcpServers.workspace).toEqual({
      command: 'new-command',
      env: { MCP_TOKEN: 'mcp-secret' },
    })
  })

  it('restores dotenv placeholders by key occurrence and permits explicit ordinary replacements', () => {
    const source = [
      'GEMINI_API_KEY="original-token"',
      'THEME=original-theme',
      'DUPLICATE=first',
      'DUPLICATE=second',
      '',
    ].join('\n')
    const editor = createClientConfigEditorFile(paths.gemini.env, source)
    const draft = editor.content!
      .replace(`THEME=${JSON.stringify(protectedValuePlaceholder)}`, 'THEME=updated-theme')

    const restored = restoreClientConfigEditorContent(paths.gemini.env, draft, source)

    expect(restored).toBe([
      'GEMINI_API_KEY="original-token"',
      'THEME=updated-theme',
      'DUPLICATE=first',
      'DUPLICATE=second',
      '',
    ].join('\n'))
  })
})

describe('client configuration revisions', () => {
  it('is deterministic and distinguishes missing, empty, and changed content', () => {
    const missing = revisionOf(undefined)
    const empty = revisionOf('')
    const source = '{"model":"gpt-5"}\n'

    expect(missing).toMatch(/^[a-f0-9]{64}$/)
    expect(revisionOf(undefined)).toBe(missing)
    expect(empty).not.toBe(missing)
    expect(revisionOf(source)).toBe(revisionOf(source))
    expect(revisionOf(source)).not.toBe(revisionOf(source.replace('gpt-5', 'gpt-5-mini')))
    expect(revisionOf(source)).not.toBe(revisionOf(source.replace('\n', '\r\n')))
    expect(createClientConfigEditorFile(paths.claude.settings, source).revision).toBe(revisionOf(source))
  })
})
