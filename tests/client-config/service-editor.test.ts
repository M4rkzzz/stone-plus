import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientConfigService, ClientConfigValidationError } from '../../src/main/client-config'
import { protectedValuePlaceholder } from '../../src/main/client-config/editor'
import { parseCodexToml } from '../../src/main/client-config/toml-format'

describe('ClientConfigService editor workflow', () => {
  let homeDir: string
  let service: ClientConfigService
  let randomSequence: number
  const fixedDate = new Date('2026-07-12T08:09:10.111Z')

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'stone-client-config-editor-'))
    randomSequence = 0
    service = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => fixedDate,
      randomId: () => `editor-${randomSequence++}`,
    })
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  it('returns editable Codex config without exposing the protected authentication file', async () => {
    const config = 'model = "gpt-existing"\n'
    const authSecret = 'codex-auth-secret-that-must-not-leak'
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, config)
    await writeFile(service.paths.codex.auth.path, JSON.stringify({ OPENAI_API_KEY: authSecret }) + '\n')

    const snapshot = await service.editor('codex')
    const configFile = snapshot.files.find((file) => file.role === 'codex-config')!
    const authFile = snapshot.files.find((file) => file.role === 'codex-auth')!

    expect(snapshot.fields.find((field) => field.id === 'codex.model')?.value).toBe('gpt-existing')
    expect(configFile).toMatchObject({ editable: true, content: config, protectedValueCount: 0 })
    expect(authFile).toMatchObject({ editable: false, containsCredential: true, protectedValueCount: 1 })
    expect(authFile.content).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain(authSecret)
  })

  it('does not expose provider credentials in the editor snapshot and restores them when saving', async () => {
    const bearerSecret = 'provider-bearer-secret-that-must-not-leak'
    const headerSecret = 'provider-header-secret-that-must-not-leak'
    const config = [
      'model = "gpt-existing"',
      '',
      '[model_providers.private]',
      'name = "Private"',
      `experimental_bearer_token = "${bearerSecret}"`,
      '',
      '[model_providers.private.http_headers]',
      `Authorization = "Bearer ${headerSecret}"`,
      '',
    ].join('\n')
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, config)

    const snapshot = await service.editor('codex')
    const file = snapshot.files.find((candidate) => candidate.role === 'codex-config')!
    const serialized = JSON.stringify(snapshot)
    expect(file.protectedValueCount).toBe(2)
    expect(file.content).toContain(protectedValuePlaceholder)
    expect(serialized).not.toContain(bearerSecret)
    expect(serialized).not.toContain(headerSecret)

    const draft = file.content!.replace('model = "gpt-existing"', 'model = "gpt-updated"')
    await service.applyEditor('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-target-token',
    }, {
      patches: [],
      files: [{ role: file.role, revision: file.revision, content: draft }],
    })

    const saved = await readFile(service.paths.codex.config.path, 'utf8')
    expect(saved).toContain('model = "gpt-updated"')
    expect(saved).toContain(`experimental_bearer_token = "${bearerSecret}"`)
    expect(saved).toContain(`Authorization = "Bearer ${headerSecret}"`)
  })

  it('rejects a stale advanced-editor revision before writing or creating a backup', async () => {
    const original = JSON.stringify({ model: 'original', env: { TOKEN: 'original-token' } }, null, 2) + '\n'
    const externallyChanged = JSON.stringify({ model: 'external-change', env: { TOKEN: 'external-token' } }, null, 2) + '\n'
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, original)
    const snapshot = await service.editor('claude')
    const file = snapshot.files.find((candidate) => candidate.role === 'claude-settings')!
    await writeFile(service.paths.claude.settings.path, externallyChanged)

    await expect(service.applyEditor('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-target-token',
    }, {
      patches: [],
      files: [{ role: file.role, revision: file.revision, content: file.content! }],
    })).rejects.toBeInstanceOf(ClientConfigValidationError)

    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(externallyChanged)
    expect(await service.listBackups('claude')).toEqual([])
  })

  it('binds an editor revision to the exact profile path even when file bytes match', async () => {
    const original = JSON.stringify({ model: 'same-content' }, null, 2) + '\n'
    const alternateDirectory = join(homeDir, 'alternate-claude')
    const alternate = service.withOverrides({ claudeDirectory: alternateDirectory })
    await mkdir(service.paths.claude.directory, { recursive: true })
    await mkdir(alternate.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, original)
    await writeFile(alternate.paths.claude.settings.path, original)
    const defaultFile = (await service.editor('claude')).files
      .find((candidate) => candidate.role === 'claude-settings')!
    const alternateFile = (await alternate.editor('claude')).files
      .find((candidate) => candidate.role === 'claude-settings')!

    expect(defaultFile.revision).not.toBe(alternateFile.revision)
    await expect(alternate.applyEditor('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-target-token',
    }, {
      patches: [],
      files: [{
        role: alternateFile.role,
        revision: defaultFile.revision,
        content: alternateFile.content!,
      }],
    })).rejects.toBeInstanceOf(ClientConfigValidationError)
    expect(await readFile(alternate.paths.claude.settings.path, 'utf8')).toBe(original)
    expect(await alternate.listBackups('claude')).toEqual([])
  })

  it('backs up the source, combines advanced and common Claude edits, and forces Stone connection fields', async () => {
    const original = JSON.stringify({
      model: 'original-model',
      env: {
        ANTHROPIC_BASE_URL: 'https://original.invalid',
        ANTHROPIC_AUTH_TOKEN: 'original-token',
        KEEP: 'preserve-this-environment-value',
      },
      unknown: { keep: true },
    }, null, 2) + '\n'
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, original)
    const snapshot = await service.editor('claude')
    const file = snapshot.files.find((candidate) => candidate.role === 'claude-settings')!
    const advancedDraft = JSON.parse(file.content!)
    advancedDraft.model = 'advanced-editor-model'
    advancedDraft.unknown.keep = false
    advancedDraft.env.ANTHROPIC_BASE_URL = 'https://draft-override.invalid'
    advancedDraft.env.ANTHROPIC_AUTH_TOKEN = 'draft-override-token'
    expect(advancedDraft.env.KEEP).toBe(protectedValuePlaceholder)

    const result = await service.applyEditor('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-target-token',
    }, {
      patches: [{ id: 'claude.model', value: 'common-editor-model' }],
      files: [{
        role: file.role,
        revision: file.revision,
        content: JSON.stringify(advancedDraft, null, 2) + '\n',
      }],
    })

    expect(result.changedFiles).toEqual([service.paths.claude.settings.path])
    expect(result.backups).toHaveLength(1)
    expect(await readFile(result.backups[0].backupPath, 'utf8')).toBe(original)
    const saved = JSON.parse(await readFile(service.paths.claude.settings.path, 'utf8'))
    expect(saved.model).toBe('common-editor-model')
    expect(saved.unknown.keep).toBe(false)
    expect(saved.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'stone-target-token',
      KEEP: 'preserve-this-environment-value',
    })
    expect(JSON.stringify(saved)).not.toContain('draft-override')
  })

  it('forces the complete Stone Codex provider and authentication contract after editor changes', async () => {
    const originalConfig = [
      'model = "gpt-original"',
      'model_provider = "foreign"',
      'cli_auth_credentials_store = "keyring"',
      '',
      '[model_providers.stone]',
      'name = "Altered"',
      'base_url = "https://original.invalid/v1"',
      'wire_api = "chat"',
      'requires_openai_auth = false',
      'custom_timeout = 42',
      '',
    ].join('\n')
    const originalAuth = JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'original-auth-token',
      tokens: { refresh_token: 'unrelated-auth-value' },
    }, null, 2) + '\n'
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, originalConfig)
    await writeFile(service.paths.codex.auth.path, originalAuth)
    const snapshot = await service.editor('codex')
    const file = snapshot.files.find((candidate) => candidate.role === 'codex-config')!
    const draft = file.content!
      .replace('model_provider = "foreign"', 'model_provider = "draft-provider"')
      .replace('base_url = "https://original.invalid/v1"', 'base_url = "https://draft.invalid/v1"')
      .replace('wire_api = "chat"', 'wire_api = "draft-wire"')

    const result = await service.applyEditor('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-codex-token',
    }, {
      patches: [{ id: 'codex.model', value: 'gpt-editor-model' }],
      files: [{ role: file.role, revision: file.revision, content: draft }],
    })

    expect(result.backups).toHaveLength(2)
    const config = parseCodexToml(await readFile(service.paths.codex.config.path, 'utf8'))
    const auth = JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8'))
    expect(config).toMatchObject({
      model: 'gpt-editor-model',
      model_provider: 'stone',
      cli_auth_credentials_store: 'file',
      model_providers: {
        stone: {
          name: 'OpenAI',
          base_url: 'http://127.0.0.1:15721/v1',
          wire_api: 'responses',
          requires_openai_auth: true,
          custom_timeout: 42,
        },
      },
    })
    expect(auth).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'stone-codex-token',
      tokens: { refresh_token: 'unrelated-auth-value' },
    })
    const backups = Object.fromEntries(await Promise.all(result.backups.map(async (backup) => [
      backup.role,
      await readFile(backup.backupPath, 'utf8'),
    ])))
    expect(backups['codex-config']).toBe(originalConfig)
    expect(backups['codex-auth']).toBe(originalAuth)
  })

  it('forces Gemini authentication and endpoint values while retaining protected dotenv values', async () => {
    const originalSettings = JSON.stringify({
      model: { name: 'gemini-original' },
      ui: { theme: 'Default' },
      security: { auth: { selectedType: 'oauth-personal', futureOption: true } },
      unknown: { keep: true },
    }, null, 2) + '\n'
    const originalEnv = [
      'GEMINI_API_KEY=original-token',
      'GEMINI_API_KEY_AUTH_MECHANISM=oauth',
      'GOOGLE_GEMINI_BASE_URL=https://original.invalid',
      'KEEP=preserve-this-value',
      '',
    ].join('\n')
    await mkdir(service.paths.gemini.directory, { recursive: true })
    await writeFile(service.paths.gemini.settings.path, originalSettings)
    await writeFile(service.paths.gemini.env.path, originalEnv)
    const snapshot = await service.editor('gemini')
    const envFile = snapshot.files.find((candidate) => candidate.role === 'gemini-env')!
    const draft = envFile.content!.split('\n').map((line) => {
      if (line.startsWith('GEMINI_API_KEY=')) return 'GEMINI_API_KEY=draft-token'
      if (line.startsWith('GEMINI_API_KEY_AUTH_MECHANISM=')) return 'GEMINI_API_KEY_AUTH_MECHANISM=draft-auth'
      if (line.startsWith('GOOGLE_GEMINI_BASE_URL=')) return 'GOOGLE_GEMINI_BASE_URL=https://draft.invalid'
      return line
    }).join('\n')

    const result = await service.applyEditor('gemini', {
      gatewayBaseUrl: 'https://127.0.0.1:15721',
      token: 'stone-gemini-token',
    }, {
      patches: [{ id: 'gemini.theme', value: 'Stone Dark' }],
      files: [{ role: envFile.role, revision: envFile.revision, content: draft }],
    })

    expect(result.backups).toHaveLength(2)
    const settings = JSON.parse(await readFile(service.paths.gemini.settings.path, 'utf8'))
    const env = await readFile(service.paths.gemini.env.path, 'utf8')
    expect(settings.ui.theme).toBe('Stone Dark')
    expect(settings.security.auth).toEqual({ selectedType: 'gemini-api-key', futureOption: true })
    expect(settings.unknown).toEqual({ keep: true })
    expect(env).toContain('GEMINI_API_KEY="stone-gemini-token"')
    expect(env).toContain('GEMINI_API_KEY_AUTH_MECHANISM="bearer"')
    expect(env).toContain('GOOGLE_GEMINI_BASE_URL="https://127.0.0.1:15721"')
    expect(env).toContain('KEEP=preserve-this-value')
    expect(env).not.toContain('draft-token')
    expect(env).not.toContain('draft-auth')
    expect(env).not.toContain('draft.invalid')
  })

  it('persists an advanced-only edit even when managed connection fields are already current', async () => {
    const original = JSON.stringify({
      security: { auth: { selectedType: 'gemini-api-key' } },
      unknown: { enabled: false },
    }, null, 2) + '\n'
    await mkdir(service.paths.gemini.directory, { recursive: true })
    await writeFile(service.paths.gemini.settings.path, original)
    await writeFile(service.paths.gemini.env.path, [
      'GEMINI_API_KEY="stone-token"',
      'GEMINI_API_KEY_AUTH_MECHANISM="bearer"',
      'GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:15721"',
      '',
    ].join('\n'))
    const snapshot = await service.editor('gemini')
    const file = snapshot.files.find((candidate) => candidate.role === 'gemini-settings')!
    const draft = JSON.parse(file.content!)
    draft.unknown.enabled = true

    const result = await service.applyEditor('gemini', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'stone-token',
    }, {
      patches: [],
      files: [{ role: file.role, revision: file.revision, content: JSON.stringify(draft, null, 2) + '\n' }],
    })

    expect(result.changedFiles).toEqual([service.paths.gemini.settings.path])
    expect(JSON.parse(await readFile(service.paths.gemini.settings.path, 'utf8')).unknown.enabled).toBe(true)
  })
})
