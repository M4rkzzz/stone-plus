import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientConfigService, resolveClientConfigPaths } from '../../src/main/client-config'
import { planGrokBuildToml } from '../../src/main/client-config/grok-build-toml'
import { parseCodexToml } from '../../src/main/client-config/toml-format'

const localBaseUrl = 'http://127.0.0.1:15721/grokbuild/v1'
const localToken = 'stone_grokbuild_local_secret'

describe('Grok Build client configuration', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )))
  })

  it('patches only the selected profile connection and preserves the rest of config.toml', () => {
    const source = [
      '# Grok Build user configuration',
      '[auth]',
      'preferred_method = "oidc" # Stone+ must prevent cached OAuth from shadowing its route token',
      'custom_auth_option = "keep"',
      '',
      '[models]',
      'default = "work" # keep selected profile',
      '',
      '[model.work]',
      'model = "relay/grok-4.5"',
      'name = "Work relay"',
      'base_url = "https://old.example/v1" # managed endpoint',
      'env_key = "GROK_BUILD_TOKEN"',
      'api_backend = "chat_completions"',
      'context_window = 321000',
      'custom_option = "keep"',
      '',
      '[model.other]',
      'model = "other-model"',
      'name = "Other profile"',
      'base_url = "https://other.example/v1"',
      'api_key = "other-secret"',
      'api_backend = "responses"',
      'context_window = 64000',
      '',
      '[mcp_servers.repo]',
      'command = "repo-tool"',
      'args = ["--stdio"]',
      '# no trailing newline',
    ].join('\r\n')

    const result = planGrokBuildToml(source, `${localBaseUrl}/`, `  ${localToken}  `)
    const parsed = parseCodexToml(result.content)
    const selected = (parsed.model as Record<string, Record<string, unknown>>).work
    const other = (parsed.model as Record<string, Record<string, unknown>>).other

    expect(selected).toMatchObject({
      model: 'relay/grok-4.5',
      name: 'Work relay',
      base_url: localBaseUrl,
      api_key: localToken,
      env_key: 'GROK_BUILD_TOKEN',
      api_backend: 'responses',
      context_window: 321000,
      custom_option: 'keep',
    })
    expect(parsed.auth).toEqual({
      preferred_method: 'api_key',
      custom_auth_option: 'keep',
    })
    expect(other).toMatchObject({
      model: 'other-model',
      base_url: 'https://other.example/v1',
      api_key: 'other-secret',
    })
    expect(parsed.mcp_servers).toEqual({ repo: { command: 'repo-tool', args: ['--stdio'] } })
    expect(result.content).toContain('base_url = "http://127.0.0.1:15721/grokbuild/v1" # managed endpoint')
    expect(result.content).toContain('preferred_method = "api_key" # Stone+ must prevent cached OAuth from shadowing its route token')
    expect(result.content).toContain('default = "work" # keep selected profile')
    expect(result.content).toContain('# no trailing newline')
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n')
    expect(result.content.endsWith('\r\n')).toBe(false)
    expect(planGrokBuildToml(result.content, localBaseUrl, localToken)).toMatchObject({ changed: false })
  })

  it('adds a reversible Stone+ profile to an official-login config without removing MCP or unknown settings', () => {
    const source = [
      '# Official xAI login owns its OAuth state outside this document.',
      'theme = "dark"',
      '',
      '[mcp_servers.echo]',
      'command = "echo"',
      'unknown = true',
      '',
    ].join('\n')

    const result = planGrokBuildToml(source, localBaseUrl, localToken)
    const parsed = parseCodexToml(result.content)

    expect(parsed).toMatchObject({
      theme: 'dark',
      auth: { preferred_method: 'api_key' },
      models: { default: 'stoneplus' },
      model: {
        stoneplus: {
          model: 'grok-4.5',
          name: 'Stone+',
          base_url: localBaseUrl,
          api_key: localToken,
          api_backend: 'responses',
          context_window: 500000,
        },
      },
      mcp_servers: { echo: { command: 'echo', unknown: true } },
    })
    expect(result.content).toContain('# Official xAI login owns its OAuth state outside this document.')
    expect(planGrokBuildToml(result.content, localBaseUrl, localToken).changed).toBe(false)
  })

  it('pins API-key auth without deleting the cached official login document', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'stone-grok-build-auth-pin-'))
    temporaryDirectories.push(homeDir)
    const paths = resolveClientConfigPaths({ homeDir, platform: process.platform })
    const service = new ClientConfigService({ homeDir, platform: process.platform })
    const officialAuth = '{"access_token":"cached-official-session","refresh_token":"keep-me"}\n'
    await mkdir(paths.grokbuild.directory, { recursive: true })
    await writeFile(paths.grokbuild.config.path, '[models]\ndefault = "stoneplus"\n\n[model.stoneplus]\nmodel = "grok-4.5"\nname = "Stone+"\nbase_url = "https://api.x.ai/v1"\napi_key = "old"\napi_backend = "responses"\ncontext_window = 500000\n')
    const authPath = join(paths.grokbuild.directory, 'auth.json')
    await writeFile(authPath, officialAuth)

    await service.apply('grokbuild', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: localToken,
    })

    const parsed = parseCodexToml(await readFile(paths.grokbuild.config.path, 'utf8'))
    expect(parsed.auth).toEqual({ preferred_method: 'api_key' })
    expect(await readFile(authPath, 'utf8')).toBe(officialAuth)
  })

  it('resolves the standard path and restores an official config exactly from the transactional backup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'stone-grok-build-config-'))
    temporaryDirectories.push(homeDir)
    const paths = resolveClientConfigPaths({ homeDir, platform: process.platform })
    const service = new ClientConfigService({ homeDir, platform: process.platform })
    const original = '# official config\n[auth]\npreferred_method = "oidc"\n\n[mcp_servers.echo]\ncommand = "echo"\n'
    await mkdir(paths.grokbuild.directory, { recursive: true })
    await writeFile(paths.grokbuild.config.path, original)

    expect(paths.grokbuild.config.path).toBe(join(homeDir, '.grok', 'config.toml'))
    const applied = await service.apply('grokbuild', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: localToken,
    })

    expect(applied.changedFiles).toEqual([paths.grokbuild.config.path])
    expect(applied.backups).toHaveLength(1)
    expect(JSON.stringify(applied)).not.toContain(localToken)
    const appliedContent = await readFile(paths.grokbuild.config.path, 'utf8')
    expect(appliedContent).toContain(localBaseUrl)
    expect(appliedContent).toContain('preferred_method = "api_key"')

    const restored = await service.restoreBackupSet('grokbuild', applied.backups[0].groupId)
    expect(restored.restoredFiles).toEqual([paths.grokbuild.config.path])
    expect(await readFile(paths.grokbuild.config.path, 'utf8')).toBe(original)
  })
})
