import { describe, expect, it } from 'vitest'
import {
  ClientConfigParseError,
  ClientConfigValidationError,
  planClaudeConfig,
  planCodexConfig,
  planCodexOfficialAccountConfig,
  planClientConfigRepair,
  planCodexOfficialLoginConfig,
  planCodexOfficialLoginToml,
  planCodexToml,
  planGeminiConfig,
  planGrokBuildConfig,
  planClientConfig,
  resolveClientConfigPaths,
} from '../../src/main/client-config'

const paths = resolveClientConfigPaths({ homeDir: '/home/alice', platform: 'linux' })
const target = { gatewayBaseUrl: 'http://127.0.0.1:15721/', token: 'stone_local_secret' }

describe('Claude Code planning', () => {
  it('updates env in settings.json without removing unknown fields', () => {
    const source = '{\r\n\t"model": "sonnet",\r\n\t"permissions": {\r\n\t\t"allow": ["Read"]\r\n\t},\r\n\t"env": {\r\n\t\t"KEEP_ME": "yes",\r\n\t\t"ANTHROPIC_BASE_URL": "https://old.example",\r\n\t\t"ANTHROPIC_MODEL": "gpt-5.5",\r\n\t\t"ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.5",\r\n\t\t"ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.5",\r\n\t\t"ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.5",\r\n\t\t"ANTHROPIC_SMALL_FAST_MODEL": "gpt-5.5",\r\n\t\t"ANTHROPIC_REASONING_MODEL": "gpt-5.5"\r\n\t}\r\n}\r\n'
    const plan = planClaudeConfig(paths.claude, { 'claude-settings': source }, target)
    const output = plan.files[0].content
    const parsed = JSON.parse(output)

    expect(parsed.permissions.allow).toEqual(['Read'])
    expect(parsed.model).toBe('sonnet')
    expect(parsed.env.KEEP_ME).toBe('yes')
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:15721')
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(target.token)
    expect(parsed.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(JSON.stringify(parsed)).not.toContain('gpt-5.5')
    expect(plan.files[0].managedFields).toEqual([
      'env.ANTHROPIC_BASE_URL',
      'env.ANTHROPIC_AUTH_TOKEN',
      'env.CLAUDE_CODE_ATTRIBUTION_HEADER',
      'model (only non-Claude relay values)',
      'env.ANTHROPIC_MODEL',
      'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
      'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
      'env.ANTHROPIC_SMALL_FAST_MODEL',
      'env.ANTHROPIC_REASONING_MODEL',
    ])
    expect(output).toContain('\r\n\t"permissions"')
    expect(output.endsWith('\r\n')).toBe(true)

    const repeated = planClaudeConfig(paths.claude, { 'claude-settings': output }, target)
    expect(repeated.files[0].changed).toBe(false)
  })

  it('preserves an explicit nonessential-traffic preference without enabling it by default', () => {
    const preserved = JSON.parse(planClaudeConfig(paths.claude, {
      'claude-settings': JSON.stringify({
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      }),
    }, target).files[0].content)
    const defaulted = JSON.parse(planClaudeConfig(paths.claude, {
      'claude-settings': JSON.stringify({ env: {} }),
    }, target).files[0].content)

    expect(preserved.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(defaulted.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
  })

  it('removes an upstream relay model from Claude model selection while preserving native aliases', () => {
    const legacy = planClaudeConfig(paths.claude, {
      'claude-settings': JSON.stringify({ model: 'gpt-5.5', env: {} }),
    }, target)
    const native = planClaudeConfig(paths.claude, {
      'claude-settings': JSON.stringify({ model: 'claude-opus-4-8', env: {} }),
    }, target)

    expect(JSON.parse(legacy.files[0].content).model).toBeUndefined()
    expect(JSON.parse(native.files[0].content).model).toBe('claude-opus-4-8')
  })

  it('rejects a non-object env instead of overwriting it', () => {
    expect(() => planClaudeConfig(paths.claude, { 'claude-settings': '{"env":"shell-owned"}' }, target))
      .toThrow(ClientConfigParseError)
  })
})

describe('Codex planning', () => {
  it('repairs third-party model residue to the current Stone+ route alias without changing native models', () => {
    const policy = {
      modelMap: {
        'gpt-5.6-terra': 'deepseek-v4-flash',
        'gpt-5.6-sol': 'deepseek-v4-pro',
      },
      fallbackModel: 'gpt-5.6-sol',
    }
    const repaired = planClientConfigRepair('codex', paths, {
      'codex-config': [
        'model_provider = "third_party"',
        'model = "deepseek-v4-flash" # replace upstream residue',
        'review_model = "deepseek-unknown"',
        'approval_policy = "never"',
        '',
      ].join('\n'),
    }, { ...target, codexModelRepair: policy })
    const config = repaired.files.find((file) => file.role === 'codex-config')!.content

    expect(config).toContain('model = "gpt-5.6-terra" # replace upstream residue')
    expect(config).toContain('review_model = "gpt-5.6-sol"')
    expect(config).toContain('approval_policy = "never"')
  })

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

  it('updates config.toml and repairs auth.json to one Stone API-key identity', () => {
    const plan = planCodexConfig(paths.codex, {
      'codex-config': 'model = "gpt-5"\n',
      'codex-auth': JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'existing' },
        last_refresh: '2026-08-04T06:00:00.000Z',
        agent_identity: { id: 'stale-agent' },
        personal_access_token: 'stale-pat',
        bedrock_api_key: 'stale-bedrock-key',
        OPENAI_API_KEY: 'old',
        custom: { keep: true },
      }) + '\n',
    }, target)
    const config = plan.files.find((file) => file.role === 'codex-config')!
    const auth = plan.files.find((file) => file.role === 'codex-auth')!

    expect(config.content).toContain('base_url = "http://127.0.0.1:15721/v1"')
    expect(JSON.parse(auth.content)).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
      custom: { keep: true },
    })
    expect(auth.managedFields).toEqual([
      'auth_mode',
      'OPENAI_API_KEY',
      'tokens',
      'last_refresh',
      'agent_identity',
      'personal_access_token',
      'bedrock_api_key',
    ])
  })

  it('sets and safely clears the Stone-managed DeepSeek context window', () => {
    const deepSeek = planCodexConfig(paths.codex, {
      'codex-config': 'model = "deepseek-v4-flash"\n',
    }, { ...target, modelContextWindow: 1_048_576 })
    const configured = deepSeek.files.find((file) => file.role === 'codex-config')!.content
    expect(configured).toContain('model_context_window = 1048576')
    expect(configured).toContain(`model_catalog_json = "${paths.codex.modelCatalog.path}"`)
    const catalog = JSON.parse(deepSeek.files.find((file) => file.role === 'codex-model-catalog')!.content)
    expect(catalog.models.map((model: { slug: string }) => model.slug))
      .toEqual(expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']))
    expect(catalog.models[0]).toMatchObject({
      apply_patch_tool_type: 'freeform',
      shell_type: 'shell_command',
      supports_parallel_tool_calls: true,
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      input_modalities: ['text'],
    })
    expect(catalog.models[0].base_instructions).toContain('freeform tools')
    expect(catalog.models[0].base_instructions).toContain('apply_patch tool accepts patch text directly')

    const switched = planCodexConfig(paths.codex, { 'codex-config': configured }, target)
    const switchedConfig = switched.files.find((file) => file.role === 'codex-config')!.content
    expect(switchedConfig).not.toContain('model_context_window')
    expect(switchedConfig).not.toContain('model_catalog_json')

    const userOverride = planCodexConfig(paths.codex, {
      'codex-config': 'model_context_window = 500000\n',
    }, target)
    expect(userOverride.files.find((file) => file.role === 'codex-config')!.content)
      .toContain('model_context_window = 500000')
  })

  it('restores official login while preserving cached ChatGPT tokens and unrelated settings', () => {
    const source = [
      'model = "gpt-5.6"',
      'model_provider = "stone"',
      'cli_auth_credentials_store = "file"',
      '',
      '[features]',
      'multi_agent = true',
      'remote_compaction_v2 = false',
      '',
      '[model_providers.stone]',
      'base_url = "http://127.0.0.1:15721/v1"',
      'wire_api = "responses"',
      'custom_timeout = 42',
      '',
      '[model_providers.stone.http_headers]',
      'x_keep = "remove-with-stone"',
      '',
      '[model_providers.custom]',
      'base_url = "https://keep.example/v1"',
      '',
    ].join('\r\n')
    const authSource = JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
      tokens: { access_token: 'official-access', refresh_token: 'official-refresh' },
      unknown: { keep: true },
    }, null, 2) + '\n'

    const plan = planCodexOfficialLoginConfig(paths.codex, {
      'codex-config': source,
      'codex-auth': authSource,
    })
    const config = plan.files.find((file) => file.role === 'codex-config')!
    const auth = plan.files.find((file) => file.role === 'codex-auth')!

    expect(config.content).toContain('model_provider = "openai"')
    expect(config.content).toContain('model = "gpt-5.6"')
    expect(config.content).toContain('multi_agent = true')
    expect(config.content).toContain('[model_providers.custom]')
    expect(config.content).toContain('https://keep.example/v1')
    expect(config.content).not.toContain('cli_auth_credentials_store')
    expect(config.content).not.toContain('remote_compaction_v2')
    expect(config.content).not.toContain('model_providers.stone')
    expect(config.content).not.toContain('remove-with-stone')
    expect(config.content.replace(/\r\n/g, '')).not.toContain('\n')
    expect(config.content.endsWith('\r\n')).toBe(true)
    expect(JSON.parse(auth.content)).toEqual({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'official-access', refresh_token: 'official-refresh' },
      unknown: { keep: true },
    })

    const second = planCodexOfficialLoginConfig(paths.codex, {
      'codex-config': config.content,
      'codex-auth': auth.content,
    })
    expect(second.files.every((file) => !file.changed)).toBe(true)
  })

  it('removes inline Stone overrides and does not create an empty auth file', () => {
    const source = 'features = { multi_agent = true, remote_compaction_v2 = false }\nmodel_providers = { stone = { base_url = "http://localhost/v1" }, custom = { base_url = "https://keep.example" } }\n'
    const result = planCodexOfficialLoginToml(source)
    const plan = planCodexOfficialLoginConfig(paths.codex, { 'codex-config': source })

    expect(result.content).toContain('model_provider = "openai"')
    expect(result.content).toContain('features = { multi_agent = true }')
    expect(result.content).toContain('model_providers = { custom = { base_url = "https://keep.example" } }')
    expect(result.content).not.toContain('stone =')
    expect(plan.files.map((file) => file.role)).toEqual(['codex-config'])
  })

  it('selects one exact OAuth account for official Codex with file-backed auth', () => {
    const lastRefreshAt = Date.parse('2026-08-04T06:00:00.000Z')
    const plan = planCodexOfficialAccountConfig(paths.codex, {
      'codex-config': [
        'model = "relay-only-model"',
        'review_model = "gpt-5.6"',
        'model_provider = "stone"',
        'model_context_window = 1048576',
        'model_catalog_json = "C:/Users/Alice/.codex/stone-deepseek-model-catalog.json"',
        '[model_providers.stone]',
        'base_url = "http://127.0.0.1:15721/v1"',
        '',
      ].join('\n'),
      'codex-auth': JSON.stringify({
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'stone-token',
        tokens: { access_token: 'old-account' },
        agent_identity: { id: 'stale-agent' },
        personal_access_token: 'stale-pat',
        bedrock_api_key: 'stale-bedrock-key',
        unrelated: { keep: true },
      }, null, 2) + '\n',
    }, {
      accessToken: 'selected-access',
      refreshToken: 'selected-refresh',
      idToken: 'selected-id',
      accountId: 'account-selected',
      lastRefreshAt,
      availableModels: ['gpt-5.6', 'gpt-5.5-codex'],
    })

    const config = plan.files.find((file) => file.role === 'codex-config')!
    const auth = plan.files.find((file) => file.role === 'codex-auth')!
    expect(config.content).toContain('model_provider = "openai"')
    expect(config.content).toContain('cli_auth_credentials_store = "file"')
    expect(config.content).not.toMatch(/^model =/m)
    expect(config.content).toContain('review_model = "gpt-5.6"')
    expect(config.content).not.toContain('model_context_window')
    expect(config.content).not.toContain('model_catalog_json')
    expect(config.content).not.toContain('model_providers.stone')
    expect(JSON.parse(auth.content)).toEqual({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'selected-id',
        access_token: 'selected-access',
        refresh_token: 'selected-refresh',
        account_id: 'account-selected',
      },
      unrelated: { keep: true },
      last_refresh: '2026-08-04T06:00:00.000Z',
    })
    expect(auth.content).not.toContain('stone-token')

    const repeated = planCodexOfficialAccountConfig(paths.codex, {
      'codex-config': config.content,
      'codex-auth': auth.content,
    }, {
      accessToken: 'selected-access',
      refreshToken: 'selected-refresh',
      idToken: 'selected-id',
      accountId: 'account-selected',
      lastRefreshAt,
      availableModels: ['gpt-5.6', 'gpt-5.5-codex'],
    })
    expect(repeated.files.every((file) => !file.changed)).toBe(true)
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

describe('Grok Build planning', () => {
  it('reports the fail-closed API-key auth pin as a managed connection field', () => {
    const plan = planGrokBuildConfig(paths.grokbuild, {}, target)

    expect(plan.files[0].managedFields).toEqual([
      'auth.preferred_method',
      'models.default (when no custom profile exists)',
      'model.<selected>.base_url',
      'model.<selected>.api_key',
      'model.<selected>.api_backend',
    ])
    expect(plan.files[0].content).toContain('auth.preferred_method = "api_key"')
  })
})

describe('DeepSeek Harness planning', () => {
  it('moves the launch-only endpoint out of dotenv while preserving unrelated values', () => {
    const existing = {
      'deepseek-harness-env': 'KEEP_ME="yes"\nDEEPSEEK_BASE_URL="https://old.example"\nDEEPSEEK_API_KEY="old"\n',
    }
    const plan = planClientConfig('deepseek-harness', paths, existing, target)
    const env = plan.files[0]

    expect(env.role).toBe('deepseek-harness-env')
    expect(env.content).toContain('KEEP_ME="yes"')
    expect(env.content).toContain('DEEPSEEK_API_KEY="stone_local_secret"')
    expect(env.content).not.toContain('DEEPSEEK_BASE_URL')
    expect(env.content).not.toContain('https://old.example')

    const repair = planClientConfigRepair('deepseek-harness', paths, existing, target)
    expect(repair.files[0].content).toBe(env.content)
    expect(repair.rebuiltRoles).toEqual([])
  })
})

describe('target validation', () => {
  it('normalizes surrounding token whitespace for every supported client', () => {
    const whitespaceTarget = {
      gatewayBaseUrl: 'http://127.0.0.1:15721/',
      token: '  stone_local_secret  ',
    }

    const claude = planClaudeConfig(paths.claude, {}, whitespaceTarget)
    const codex = planCodexConfig(paths.codex, {}, whitespaceTarget)
    const gemini = planGeminiConfig(paths.gemini, {}, whitespaceTarget)
    const grok = planGrokBuildConfig(paths.grokbuild, {}, whitespaceTarget)

    expect(JSON.parse(claude.files[0].content).env.ANTHROPIC_AUTH_TOKEN).toBe('stone_local_secret')
    expect(JSON.parse(codex.files.find((file) => file.role === 'codex-auth')!.content).OPENAI_API_KEY)
      .toBe('stone_local_secret')
    expect(gemini.files.find((file) => file.role === 'gemini-env')!.content)
      .toContain('GEMINI_API_KEY="stone_local_secret"')
    expect(grok.files[0].content).toContain('api_key = "stone_local_secret"')
    for (const plan of [claude, codex, gemini, grok]) {
      expect(plan.files.some((file) => file.content.includes(whitespaceTarget.token))).toBe(false)
    }
  })

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
