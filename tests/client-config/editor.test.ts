import { describe, expect, it } from 'vitest'
import {
  createClientConfigEditorFile,
  protectedValuePlaceholder,
  restoreClientConfigEditorContent,
  revisionOf,
} from '../../src/main/client-config/editor'
import { resolveClientConfigPaths } from '../../src/main/client-config/paths'

const paths = resolveClientConfigPaths({ homeDir: '/home/tester', platform: 'linux' })

describe('client configuration editor display', () => {
  it('shows JSON, dotenv, TOML, and Codex authentication values in plaintext', () => {
    const json = '{"env":{"ANTHROPIC_AUTH_TOKEN":"claude-secret"}}\n'
    const dotenv = 'GEMINI_API_KEY="gemini-secret"\r\n'
    const toml = 'api_key = "grok-secret"\n'
    const auth = '{"OPENAI_API_KEY":"codex-secret"}\n'

    expect(createClientConfigEditorFile(paths.claude.settings, json)).toMatchObject({ content: json, protectedValueCount: 0 })
    expect(createClientConfigEditorFile(paths.gemini.env, dotenv)).toMatchObject({ content: dotenv, protectedValueCount: 0 })
    expect(createClientConfigEditorFile(paths.grokbuild.config, toml)).toMatchObject({ content: toml, protectedValueCount: 0 })
    expect(createClientConfigEditorFile(paths.codex.auth, auth)).toMatchObject({
      content: auth,
      editable: false,
      protectedValueCount: 0,
    })
  })

  it('persists explicit plaintext changes without replacing them from the original', () => {
    const jsonSource = '{"env":{"TOKEN":"old-json-secret"}}\n'
    const tomlSource = 'api_key = "old-toml-secret"\n'
    const dotenvSource = 'API_KEY="old-dotenv-secret"\n'

    expect(restoreClientConfigEditorContent(
      paths.claude.settings,
      jsonSource.replace('old-json-secret', 'new-json-secret'),
      jsonSource,
    )).toContain('new-json-secret')
    expect(restoreClientConfigEditorContent(
      paths.grokbuild.config,
      tomlSource.replace('old-toml-secret', 'new-toml-secret'),
      tomlSource,
    )).toContain('new-toml-secret')
    expect(restoreClientConfigEditorContent(
      paths.gemini.env,
      dotenvSource.replace('old-dotenv-secret', 'new-dotenv-secret'),
      dotenvSource,
    )).toContain('new-dotenv-secret')
  })

  it('projects only Claude MCP servers while displaying their values in plaintext', () => {
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
    expect(draft.mcpServers.workspace.env.MCP_TOKEN).toBe('mcp-secret')
    expect(editor.protectedValueCount).toBe(0)
    expect(editor.content).not.toContain('oauth-secret')
    expect(editor.content).not.toContain('private-account')
    expect(editor.content).toContain('mcp-secret')

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

  it('still restores legacy dotenv placeholders by key occurrence', () => {
    const source = [
      'GEMINI_API_KEY="original-token"',
      'THEME=original-theme',
      'DUPLICATE=first',
      'DUPLICATE=second',
      '',
    ].join('\n')
    const draft = [
      `GEMINI_API_KEY=${JSON.stringify(protectedValuePlaceholder)}`,
      'THEME=updated-theme',
      `DUPLICATE=${JSON.stringify(protectedValuePlaceholder)}`,
      `DUPLICATE=${JSON.stringify(protectedValuePlaceholder)}`,
      '',
    ].join('\n')

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
    const file = paths.claude.settings
    const missing = revisionOf(file, undefined)
    const empty = revisionOf(file, '')
    const source = '{"model":"gpt-5"}\n'

    expect(missing).toMatch(/^[a-f0-9]{64}$/)
    expect(revisionOf(file, undefined)).toBe(missing)
    expect(empty).not.toBe(missing)
    expect(revisionOf(file, source)).toBe(revisionOf(file, source))
    expect(revisionOf(file, source)).not.toBe(revisionOf(file, source.replace('gpt-5', 'gpt-5-mini')))
    expect(revisionOf(file, source)).not.toBe(revisionOf(file, source.replace('\n', '\r\n')))
    expect(revisionOf(paths.claude.mcp!, source)).not.toBe(revisionOf(file, source))
    expect(createClientConfigEditorFile(file, source).revision).toBe(revisionOf(file, source))
  })
})
