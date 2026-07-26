import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClaudeVscodeConfig,
  resolveClaudeVscodeSettingsPath,
} from '../../src/main/agent-lifecycle/claude-vscode-config'

const roots: string[] = []
const connection = { gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'secret-local-token' }

async function createConfig() {
  const homeDir = await mkdtemp(join(tmpdir(), 'stone-claude-vscode-'))
  roots.push(homeDir)
  const environment = process.platform === 'win32'
    ? { APPDATA: join(homeDir, 'Roaming') }
    : { XDG_CONFIG_HOME: join(homeDir, '.config') }
  const config = new ClaudeVscodeConfig({
    platform: process.platform,
    homeDir,
    environment,
    randomId: () => Math.random().toString(36).slice(2),
  })
  return { config, path: config.settingsPath() }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ClaudeVscodeConfig', () => {
  it('resolves stable and Insiders user settings on Windows, macOS and Linux', () => {
    expect(resolveClaudeVscodeSettingsPath({
      platform: 'win32', homeDir: 'C:\\Users\\stone', environment: { APPDATA: 'C:\\Users\\stone\\AppData\\Roaming' },
    })).toBe(win32.join('C:\\Users\\stone\\AppData\\Roaming', 'Code', 'User', 'settings.json'))
    expect(resolveClaudeVscodeSettingsPath({
      platform: 'win32', homeDir: 'C:\\Users\\stone', environment: { APPDATA: 'C:\\Users\\stone\\AppData\\Roaming' },
      channel: 'insiders',
    })).toBe(win32.join('C:\\Users\\stone\\AppData\\Roaming', 'Code - Insiders', 'User', 'settings.json'))
    expect(resolveClaudeVscodeSettingsPath({
      platform: 'darwin', homeDir: '/Users/stone', environment: {},
    })).toBe(posix.join('/Users/stone', 'Library', 'Application Support', 'Code', 'User', 'settings.json'))
    expect(resolveClaudeVscodeSettingsPath({
      platform: 'linux', homeDir: '/home/stone', environment: { XDG_CONFIG_HOME: '/var/config/stone' },
      channel: 'insiders',
    })).toBe(posix.join('/var/config/stone', 'Code - Insiders', 'User', 'settings.json'))
  })

  it('selects the Insiders settings file from its launch target', async () => {
    const { config } = await createConfig()
    expect(config.settingsPath('vscode-insiders://anthropic.claude-code/open'))
      .toContain('Code - Insiders')
    expect(config.settingsPath('vscode://anthropic.claude-code/open')).toContain('Code')
  })

  it('minimally repairs JSONC while preserving comments, fields and other environment entries', async () => {
    const { config, path } = await createConfig()
    await mkdir(join(path, '..'), { recursive: true })
    const original = `{
  // Keep this user preference and its comment.
  "editor.fontSize": 15,
  "claudeCode.environmentVariables": [
    { "name": "KEEP_ME", "value": "yes", "extra": true },
    // Replace Stone-owned entries without touching the rest.
    { "name": "ANTHROPIC_BASE_URL", "value": "https://old.invalid" },
  ],
  "claudeCode.disableLoginPrompt": false,
  "files.autoSave": "afterDelay",
}
`
    await writeFile(path, original)

    const repair = await config.repair(connection)
    const first = await readFile(path, 'utf8')

    expect(repair.changed).toBe(true)
    expect(await config.inspect(connection)).toBe(true)
    await expect(config.validate(connection)).resolves.toBeUndefined()
    expect(first).toContain('// Keep this user preference and its comment.')
    expect(first).toContain('"editor.fontSize": 15')
    expect(first).toContain('"files.autoSave": "afterDelay"')
    expect(first).toContain('"name": "KEEP_ME"')
    expect(first).toContain('"extra": true')
    expect(first).toContain('"claudeCode.disableLoginPrompt": true')
    expect(first).toContain(connection.gatewayBaseUrl)
    expect(first).toContain(connection.token)

    const repeated = await config.repair(connection)
    expect(repeated.changed).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(first)
  })

  it('creates missing settings and rolls the repair back without exposing credentials', async () => {
    const { config, path } = await createConfig()

    const repair = await config.repair(connection)
    expect(repair.changed).toBe(true)
    expect(JSON.stringify(repair)).not.toContain(connection.token)
    expect(await config.inspect(connection)).toBe(true)

    await repair.rollback()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await repair.rollback()
  })

  it('restores the exact original JSONC snapshot and refuses to overwrite later user edits', async () => {
    const { config, path } = await createConfig()
    await mkdir(join(path, '..'), { recursive: true })
    const original = '{\n  // original\n  "workbench.colorTheme": "Stone"\n}\n'
    await writeFile(path, original)

    const repair = await config.repair(connection)
    await repair.rollback()
    expect(await readFile(path, 'utf8')).toBe(original)

    const secondRepair = await config.repair(connection)
    const userEdit = (await readFile(path, 'utf8')).replace('"Stone"', '"User changed this"')
    await writeFile(path, userEdit)
    await expect(secondRepair.rollback()).rejects.toThrow('changed after repair')
    expect(await readFile(path, 'utf8')).toBe(userEdit)
  })

  it('does not overwrite malformed settings and never includes the token in errors', async () => {
    const { config, path } = await createConfig()
    await mkdir(join(path, '..'), { recursive: true })
    const malformed = '{\n  "editor.fontSize": 15,\n  broken\n}\n'
    await writeFile(path, malformed)

    const error = await config.repair(connection).catch((caught) => caught as Error)
    expect(error.message).toBe('Claude Code VSC user settings are not valid JSONC.')
    expect(String(error)).not.toContain(connection.token)
    expect(await readFile(path, 'utf8')).toBe(malformed)
    expect(await config.inspect(connection)).toBe(false)
  })
})
