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
    expect(linux.gemini.settings.path).toBe('/home/alice/.gemini/settings.json')
    expect(linux.gemini.env.path).toBe('/home/alice/.gemini/.env')
    expect(mac.gemini.env.path).toBe('/Users/alice/.gemini/.env')
  })

  it('uses Windows separators when the injected platform is win32', () => {
    const paths = resolveClientConfigPaths({ homeDir: 'C:\\Users\\Alice', platform: 'win32' })

    expect(paths.claude.settings.path).toBe('C:\\Users\\Alice\\.claude\\settings.json')
    expect(paths.codex.config.path).toBe('C:\\Users\\Alice\\.codex\\config.toml')
    expect(paths.gemini.env.path).toBe('C:\\Users\\Alice\\.gemini\\.env')
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
