import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientConfigService, planClientConfigRepair, resolveClientConfigPaths } from '../../src/main/client-config'

describe('client configuration repair planning', () => {
  const paths = resolveClientConfigPaths({ homeDir: '/home/repair', platform: 'linux' })
  const target = { gatewayBaseUrl: 'http://127.0.0.1:15721', token: 'repair-secret' }

  it('preserves valid Codex model, MCP, plugin, project and unknown settings while repairing auth', () => {
    const source = [
      'model = "gpt-5.6-sol"',
      'approval_policy = "on-request"',
      'unknown_top_level = "keep"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-server"',
      '',
      '[plugins.example]',
      'enabled = true',
      '',
      '[projects."/work/project"]',
      'trust_level = "trusted"',
      '',
      '[model_providers.stone]',
      'base_url = "https://stale-relay.example/v1"',
      'custom_option = "keep-provider-option"',
      '',
    ].join('\n')
    const auth = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'stale-token' },
      last_refresh: '2026-08-04T06:00:00.000Z',
      agent_identity: { id: 'stale-agent' },
      personal_access_token: 'stale-pat',
      bedrock_api_key: 'stale-bedrock-key',
      custom: { keep: true },
    }, null, 2) + '\n'

    const plan = planClientConfigRepair('codex', paths, {
      'codex-config': source,
      'codex-auth': auth,
    }, target)
    const config = plan.files.find((file) => file.role === 'codex-config')!.content
    const repairedAuth = JSON.parse(plan.files.find((file) => file.role === 'codex-auth')!.content)

    expect(plan.rebuiltRoles).toEqual([])
    expect(config).toContain('model = "gpt-5.6-sol"')
    expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-server"')
    expect(config).toContain('[plugins.example]\nenabled = true')
    expect(config).toContain('[projects."/work/project"]\ntrust_level = "trusted"')
    expect(config).toContain('unknown_top_level = "keep"')
    expect(config).toContain('custom_option = "keep-provider-option"')
    expect(config).toContain('model_provider = "stone"')
    expect(config).toContain('base_url = "http://127.0.0.1:15721/v1"')
    expect(repairedAuth).toEqual({
      custom: { keep: true },
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
    })
  })

  it('marks each unusable managed document for a minimal rebuild', () => {
    const codex = planClientConfigRepair('codex', paths, {
      'codex-config': 'model = "unterminated\n',
      'codex-auth': '["not", "an", "object"]\n',
    }, target)
    expect(codex.rebuiltRoles).toEqual(['codex-config', 'codex-auth'])
    expect(codex.files.find((file) => file.role === 'codex-config')!.content).toContain('[model_providers.stone]')
    expect(JSON.parse(codex.files.find((file) => file.role === 'codex-auth')!.content)).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
    })

    const gemini = planClientConfigRepair('gemini', paths, {
      'gemini-settings': '{bad json}\n',
      'gemini-env': 'GEMINI_API_KEY="unterminated\n',
    }, target)
    expect(gemini.rebuiltRoles).toEqual(['gemini-settings', 'gemini-env'])
    expect(gemini.files.find((file) => file.role === 'gemini-env')!.content).not.toContain('unterminated')
  })

  it('repairs a valid JSON connection shape without discarding sibling settings', () => {
    const claude = planClientConfigRepair('claude', paths, {
      'claude-settings': JSON.stringify({ permissions: { allow: ['Read'] }, env: 'stale-relay-script' }),
    }, target)
    const settings = JSON.parse(claude.files[0].content)

    expect(claude.rebuiltRoles).toEqual([])
    expect(settings.permissions).toEqual({ allow: ['Read'] })
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: target.token,
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    })
  })

  it('migrates stale relay model overrides to the route layer without discarding Claude preferences', () => {
    const claude = planClientConfigRepair('claude', paths, {
      'claude-settings': JSON.stringify({
        model: 'sonnet',
        permissions: { allow: ['Read'] },
        env: {
          KEEP_ME: 'yes',
          ANTHROPIC_MODEL: 'gpt-5.5',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.5',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.5',
          ANTHROPIC_SMALL_FAST_MODEL: 'gpt-5.5',
          ANTHROPIC_REASONING_MODEL: 'gpt-5.5',
        },
      }),
    }, target)
    const settings = JSON.parse(claude.files[0].content)

    expect(claude.rebuiltRoles).toEqual([])
    expect(settings.permissions).toEqual({ allow: ['Read'] })
    expect(settings.model).toBe('sonnet')
    expect(settings.env).toEqual({
      KEEP_ME: 'yes',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: target.token,
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    })
  })

  it('preserves unrelated TOML when a valid Stone provider field has the wrong shape', () => {
    const plan = planClientConfigRepair('codex', paths, {
      'codex-config': [
        'model = "gpt-5.6-sol"',
        'model_providers = "relay-switch-left-a-scalar-here"',
        '',
        '[mcp_servers.docs]',
        'command = "keep-this-mcp"',
        '',
        '[projects."/work/keep"]',
        'trust_level = "trusted"',
        '',
      ].join('\n'),
    }, target)
    const config = plan.files.find((file) => file.role === 'codex-config')!.content

    expect(plan.rebuiltRoles).toEqual([])
    expect(config).toContain('model = "gpt-5.6-sol"')
    expect(config).toContain('[mcp_servers.docs]\ncommand = "keep-this-mcp"')
    expect(config).toContain('[projects."/work/keep"]\ntrust_level = "trusted"')
    expect(config).toContain('[model_providers.stone]')
    expect(config).not.toContain('relay-switch-left-a-scalar-here')
  })
})

describe('ClientConfigService repair transaction', () => {
  let homeDir: string
  let service: ClientConfigService
  let randomSequence: number
  const fixedDate = new Date('2026-07-19T12:34:56.789Z')
  const target = { gatewayBaseUrl: 'http://127.0.0.1:15721', token: 'repair-secret' }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'stone-client-repair-'))
    randomSequence = 0
    service = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => fixedDate,
      randomId: () => `repair-${++randomSequence}`,
    })
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })

  it('backs up the exact damaged Codex document before rebuilding it', async () => {
    const brokenConfig = 'model = "lost-closing-quote\nprivate_value = "do-not-leak"\n'
    const validAuth = '{"tokens":{"refresh_token":"keep"},"OPENAI_API_KEY":"stale"}\n'
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, brokenConfig)
    await writeFile(service.paths.codex.auth.path, validAuth)

    const result = await service.repair('codex', target)

    expect(result.rebuiltRoles).toEqual(['codex-config'])
    expect(result.changedFiles).toEqual([service.paths.codex.config.path, service.paths.codex.auth.path])
    expect(result.backups).toHaveLength(2)
    const configBackup = result.backups.find((backup) => backup.role === 'codex-config')!
    expect(await readFile(configBackup.backupPath, 'utf8')).toBe(brokenConfig)
    const repaired = await readFile(service.paths.codex.config.path, 'utf8')
    expect(repaired).toContain('model_provider = "stone"')
    expect(repaired).toContain('base_url = "http://127.0.0.1:15721/v1"')
    expect(repaired).not.toContain('lost-closing-quote')
    expect(JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: target.token,
    })
    expect(JSON.stringify(result)).not.toContain(target.token)
  })

  it('repairs a profile directory without touching the default directory', async () => {
    const profileDirectory = join(homeDir, 'profiles', 'relay-b')
    const scoped = service.withOverrides({ codexDirectory: profileDirectory })
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'config.toml'), 'broken = "value\n')
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, 'model = "default-must-stay"\n')

    const result = await scoped.repair('codex', target)

    expect(result.rebuiltRoles).toEqual(['codex-config'])
    expect(result.changedFiles.every((path) => path.startsWith(profileDirectory))).toBe(true)
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toBe('model = "default-must-stay"\n')
    expect(await readFile(join(profileDirectory, 'config.toml'), 'utf8')).toContain('[model_providers.stone]')
  })

  it('cleans Claude relay residue once and remains write-free on repeated one-click repair', async () => {
    const original = JSON.stringify({
      model: 'sonnet',
      permissions: { allow: ['Read'] },
      mcpServers: { files: { command: 'mcp-files' } },
      env: {
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'https://old-relay.example',
        ANTHROPIC_AUTH_TOKEN: 'old-secret',
        ANTHROPIC_MODEL: 'gpt-5.5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5',
        ANTHROPIC_REASONING_MODEL: 'gpt-5.5',
      },
    }, null, 2) + '\n'
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, original)

    const first = await service.repair('claude', target)
    const repaired = JSON.parse(await readFile(service.paths.claude.settings.path, 'utf8'))
    const second = await service.repair('claude', target)

    expect(first.changedFiles).toEqual([service.paths.claude.settings.path])
    expect(first.backups).toHaveLength(1)
    expect(await readFile(first.backups[0].backupPath, 'utf8')).toBe(original)
    expect(repaired).toMatchObject({
      model: 'sonnet',
      permissions: { allow: ['Read'] },
      mcpServers: { files: { command: 'mcp-files' } },
      env: {
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: target.gatewayBaseUrl,
        ANTHROPIC_AUTH_TOKEN: target.token,
      },
    })
    expect(JSON.stringify(repaired)).not.toContain('gpt-5.5')
    expect(second).toMatchObject({ changedFiles: [], backups: [] })
    expect(await service.listBackups('claude')).toHaveLength(1)
    expect(JSON.stringify(first)).not.toContain(target.token)
  })

  it('rolls back files already written when a later repair write fails', async () => {
    let writeSequence = 0
    const sabotaged = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => fixedDate,
      randomId: () => {
        writeSequence += 1
        if (writeSequence === 2) {
          rmSync(sabotaged.paths.codex.auth.path, { force: true })
          mkdirSync(sabotaged.paths.codex.auth.path)
        }
        return `sabotage-${writeSequence}`
      },
    })
    const originalConfig = 'model = "broken\n'
    const originalAuth = '{broken json}\n'
    await mkdir(sabotaged.paths.codex.directory, { recursive: true })
    await writeFile(sabotaged.paths.codex.config.path, originalConfig)
    await writeFile(sabotaged.paths.codex.auth.path, originalAuth)

    await expect(sabotaged.repair('codex', target)).rejects.toBeDefined()

    expect(await readFile(sabotaged.paths.codex.config.path, 'utf8')).toBe(originalConfig)
    const backups = await sabotaged.listBackups('codex')
    expect(backups).toHaveLength(2)
    expect(await readFile(backups.find((backup) => backup.role === 'codex-config')!.backupPath, 'utf8'))
      .toBe(originalConfig)
    expect(await readFile(backups.find((backup) => backup.role === 'codex-auth')!.backupPath, 'utf8'))
      .toBe(originalAuth)
  })
})
