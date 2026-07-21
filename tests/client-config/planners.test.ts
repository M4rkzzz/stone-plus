import { describe, expect, it } from 'vitest'
import {
  ClientConfigParseError,
  ClientConfigValidationError,
  planClaudeConfig,
  planCodexConfig,
  planCodexToml,
  planGeminiConfig,
  resolveClientConfigPaths,
} from '../../src/main/client-config'

const paths = resolveClientConfigPaths({ homeDir: '/home/alice', platform: 'linux' })
const target = { gatewayBaseUrl: 'http://127.0.0.1:15721/', token: 'stone_local_secret' }

describe('Claude Code planning', () => {
  it('updates env in settings.json without removing unknown fields', () => {
    const source = '{\r\n\t"permissions": {\r\n\t\t"allow": ["Read"]\r\n\t},\r\n\t"env": {\r\n\t\t"KEEP_ME": "yes",\r\n\t\t"ANTHROPIC_BASE_URL": "https://old.example"\r\n\t}\r\n}\r\n'
    const plan = planClaudeConfig(paths.claude, { 'claude-settings': source }, target)
    const output = plan.files[0].content
    const parsed = JSON.parse(output)

    expect(parsed.permissions.allow).toEqual(['Read'])
    expect(parsed.env.KEEP_ME).toBe('yes')
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:15721')
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(target.token)
    expect(plan.files[0].managedFields).toEqual([
      'env.ANTHROPIC_BASE_URL',
      'env.ANTHROPIC_AUTH_TOKEN',
    ])
    expect(output).toContain('\r\n\t"permissions"')
    expect(output.endsWith('\r\n')).toBe(true)
  })

  it('rejects a non-object env instead of overwriting it', () => {
    expect(() => planClaudeConfig(paths.claude, { 'claude-settings': '{"env":"shell-owned"}' }, target))
      .toThrow(ClientConfigParseError)
  })
})

describe('Codex planning', () => {
  it('patches config.toml structurally and preserves unrelated sections and comments', () => {
    const source = [
      'model = "gpt-5"',
      'approval_policy = "on-request"',
      '',
      '[features]',
      'web_search = true',
      '',
      '[model_providers.stone]',
      'name = "Old Stone" # provider label',
      'base_url = "http://old.invalid/v1"',
      'custom_timeout = 42 # unknown provider option',
      '',
    ].join('\n')

    const result = planCodexToml(source, 'http://127.0.0.1:15721/v1')

    expect(result.content).toContain('model_provider = "stone"')
    expect(result.content).toContain('model = "gpt-5"')
    expect(result.content).toContain('[features]\nweb_search = true')
    expect(result.content).toContain('remote_compaction_v2 = false')
    expect(result.content).toContain('name = "OpenAI" # provider label')
    expect(result.content).toContain('base_url = "http://127.0.0.1:15721/v1"')
    expect(result.content).toContain('custom_timeout = 42 # unknown provider option')
    expect(result.content).toContain('cli_auth_credentials_store = "file"')
    expect(result.content).toContain('wire_api = "responses"')
    expect(result.content).toContain('requires_openai_auth = true')
    expect(result.content).not.toContain('env_key =')
    expect(planCodexToml(result.content, 'http://127.0.0.1:15721/v1').changed).toBe(false)
  })

  it('disables only Remote Compaction V2 while retaining unrelated Codex features', () => {
    const source = [
      '[features]',
      'remote_compaction_v2 = true # Stone routes compact through Legacy',
      'multi_agent = true',
      '',
    ].join('\n')

    const result = planCodexToml(source, 'http://127.0.0.1:15721/v1')

    expect(result.content).toContain('remote_compaction_v2 = false # Stone routes compact through Legacy')
    expect(result.content).toContain('multi_agent = true')
    expect(result.content).toContain('name = "OpenAI"')
  })

  it('patches an inline features table without creating a conflicting dotted key', () => {
    const source = 'model = "gpt-5"\r\nfeatures = { multi_agent = true, remote_compaction_v2 = true } # keep inline\r\n# no trailing newline'

    const result = planCodexToml(source, 'http://127.0.0.1:15721/v1')

    expect(result.content).toContain('features = { multi_agent = true, remote_compaction_v2 = false } # keep inline')
    expect(result.content).not.toContain('features.remote_compaction_v2')
    expect(result.content).toContain('# keep inline\r\n# no trailing newline')
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n')
    expect(result.content.endsWith('\r\n')).toBe(false)
    expect(planCodexToml(result.content, 'http://127.0.0.1:15721/v1')).toMatchObject({ changed: false })
  })

  it('adds the compact feature to quoted inline and quoted table forms while preserving their values', () => {
    const inline = planCodexToml(
      '"features" = { multi_agent = true, web_search = false }\n',
      'http://127.0.0.1:15721/v1',
    )
    const table = planCodexToml(
      '["features"]\n"multi_agent" = true\n',
      'http://127.0.0.1:15721/v1',
    )

    expect(inline.content).toContain('"features" = { multi_agent = true, web_search = false, remote_compaction_v2 = false }')
    expect(table.content).toContain('["features"]\n"multi_agent" = true\nremote_compaction_v2 = false')
    expect(planCodexToml(inline.content, 'http://127.0.0.1:15721/v1').changed).toBe(false)
    expect(planCodexToml(table.content, 'http://127.0.0.1:15721/v1').changed).toBe(false)
  })

  it('validates the entire TOML document before applying a format-preserving patch', () => {
    const secret = 'do-not-include-in-errors'
    const invalid = [
      'model = "gpt-5"',
      '',
      '[unrelated]',
      `experimental_bearer_token = "${secret}`,
    ].join('\n')

    let caught: unknown
    try {
      planCodexToml(invalid, 'http://127.0.0.1:15721/v1')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClientConfigParseError)
    expect(String(caught)).not.toContain(secret)
  })

  it('does not patch TOML-looking text inside multiline values and migrates the old Stone provider auth fields', () => {
    const source = [
      'notes = """',
      '[model_providers.stone]',
      'base_url = "do-not-touch"',
      '"""',
      '',
      '["model_providers"."stone"]',
      'name = "Old Stone"',
      '"base_url" = "http://old.invalid/v1" # endpoint',
      '"custom=key" = "keep"',
      'env_key = "OPENAI_API_KEY"',
      'requires_openai_auth = false',
      '',
    ].join('\n')

    const result = planCodexToml(source, 'http://127.0.0.1:15721/v1')

    expect(result.content).toContain('notes = """\n[model_providers.stone]\nbase_url = "do-not-touch"\n"""')
    expect(result.content).toContain('["model_providers"."stone"]')
    expect(result.content).toContain('"base_url" = "http://127.0.0.1:15721/v1" # endpoint')
    expect(result.content).toContain('"custom=key" = "keep"')
    expect(result.content).toContain('requires_openai_auth = true')
    expect(result.content).not.toContain('env_key =')
  })

  it('updates config.toml and auth.json while retaining unrelated auth data', () => {
    const plan = planCodexConfig(paths.codex, {
      'codex-config': 'model = "gpt-5"\n',
      'codex-auth': '{"tokens":{"access_token":"existing"},"OPENAI_API_KEY":"old"}\n',
    }, target)
    const config = plan.files.find((file) => file.role === 'codex-config')!
    const auth = plan.files.find((file) => file.role === 'codex-auth')!

    expect(config.content).toContain('base_url = "http://127.0.0.1:15721/v1"')
    expect(JSON.parse(auth.content)).toEqual({
      tokens: { access_token: 'existing' },
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
    })
  })
})

describe('Gemini CLI planning', () => {
  it('updates settings.json and .env while preserving unknown JSON and dotenv lines', () => {
    const plan = planGeminiConfig(paths.gemini, {
      'gemini-settings': JSON.stringify({ theme: 'Dracula', security: { auth: { useExternal: true } }, custom: { keep: 1 } }, null, 2) + '\n',
      'gemini-env': '# Gemini settings\r\nOTHER_VALUE=keep\r\nexport GEMINI_API_KEY = "old"\r\n',
    }, target)
    const settings = plan.files.find((file) => file.role === 'gemini-settings')!
    const env = plan.files.find((file) => file.role === 'gemini-env')!
    const parsed = JSON.parse(settings.content)

    expect(parsed.theme).toBe('Dracula')
    expect(parsed.custom.keep).toBe(1)
    expect(parsed.security.auth.useExternal).toBe(true)
    expect(parsed.security.auth.selectedType).toBe('gemini-api-key')
    expect(env.content).toContain('# Gemini settings\r\nOTHER_VALUE=keep\r\n')
    expect(env.content).toContain(`export GEMINI_API_KEY = "${target.token}"`)
    expect(env.content).toContain('GEMINI_API_KEY_AUTH_MECHANISM="bearer"')
    expect(env.content).toContain('GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:15721"')
    expect(env.content.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('target validation', () => {
  it('rejects unsafe base URL shapes without including the token in the error', () => {
    let caught: unknown
    try {
      planClaudeConfig(paths.claude, {}, { gatewayBaseUrl: 'file:///tmp/socket', token: 'do-not-disclose' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClientConfigValidationError)
    expect(String(caught)).not.toContain('do-not-disclose')
  })

  it('requires an origin URL and a non-whitespace token', () => {
    expect(() => planCodexConfig(paths.codex, {}, {
      gatewayBaseUrl: 'http://127.0.0.1:15721/v1',
      token: 'token',
    })).toThrow(ClientConfigValidationError)
    expect(() => planGeminiConfig(paths.gemini, {}, {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: '   ',
    })).toThrow(ClientConfigValidationError)
  })
})
