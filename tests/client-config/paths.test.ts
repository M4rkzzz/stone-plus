import { describe, expect, it } from 'vitest'
import { resolveClientConfigPaths } from '../../src/main/client-config'

describe('resolveClientConfigPaths', () => {
  it('uses standard user directories on Linux and macOS', () => {
    const linux = resolveClientConfigPaths({ homeDir: '/home/alice', platform: 'linux' })
    const mac = resolveClientConfigPaths({ homeDir: '/Users/alice', platform: 'darwin' })

    expect(linux.claude.settings.path).toBe('/home/alice/.claude/settings.json')
    expect(linux.codex.config.path).toBe('/home/alice/.codex/config.toml')
    expect(linux.codex.config.containsCredential).toBe(true)
    expect(linux.codex.auth.path).toBe('/home/alice/.codex/auth.json')
    expect(linux.codex.modelCatalog.path).toBe('/home/alice/.codex/stone-deepseek-model-catalog.json')
    expect(linux.codex.agents.path).toBe('/home/alice/.codex/AGENTS.md')
    expect(linux.codex.rules.path).toBe('/home/alice/.codex/rules/default.rules')
    expect(linux.gemini.settings.path).toBe('/home/alice/.gemini/settings.json')
    expect(linux.gemini.env.path).toBe('/home/alice/.gemini/.env')
    expect(mac.gemini.env.path).toBe('/Users/alice/.gemini/.env')
    expect(linux.deepseekHarness.env.path).toBe('/home/alice/.dsh/.env')
    expect(mac.deepseekHarness.env.path).toBe('/Users/alice/.dsh/.env')
  })

  it('uses Windows separators when the injected platform is win32', () => {
    const paths = resolveClientConfigPaths({ homeDir: 'C:\\Users\\Alice', platform: 'win32' })

    expect(paths.claude.settings.path).toBe('C:\\Users\\Alice\\.claude\\settings.json')
    expect(paths.codex.config.path).toBe('C:\\Users\\Alice\\.codex\\config.toml')
    expect(paths.codex.modelCatalog.path).toBe('C:\\Users\\Alice\\.codex\\stone-deepseek-model-catalog.json')
    expect(paths.codex.agents.path).toBe('C:\\Users\\Alice\\.codex\\AGENTS.md')
    expect(paths.codex.rules.path).toBe('C:\\Users\\Alice\\.codex\\rules\\default.rules')
    expect(paths.gemini.env.path).toBe('C:\\Users\\Alice\\.gemini\\.env')
    expect(paths.deepseekHarness.env.path).toBe('C:\\Users\\Alice\\.dsh\\.env')
  })

  it('accepts explicit client directory overrides', () => {
    const paths = resolveClientConfigPaths({
      homeDir: '/home/alice',
      platform: 'linux',
      overrides: {
        claudeDirectory: '/configs/claude',
        codexDirectory: '/configs/codex',
        geminiDirectory: '/configs/gemini',
      },
    })

    expect(paths.claude.settings.path).toBe('/configs/claude/settings.json')
    expect(paths.codex.auth.path).toBe('/configs/codex/auth.json')
    expect(paths.gemini.settings.path).toBe('/configs/gemini/settings.json')
  })
})
