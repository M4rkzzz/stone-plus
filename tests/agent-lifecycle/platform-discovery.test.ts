import { describe, expect, it, vi } from 'vitest'
import {
  cliWellKnownPaths,
  discoverAgentExecutable,
  orderWindowsLaunchCandidates,
} from '../../src/main/agent-lifecycle/platform-discovery'

describe('agent platform discovery', () => {
  it('prefers an injected PATH result and marks every CLI as managed-only', async () => {
    const fileExists = vi.fn(async (path: string) => path === 'C:\\Tools\\codex.cmd')
    const result = await discoverAgentExecutable('codex-cli', {
      platform: 'win32', homeDir: 'C:\\Users\\A', environment: {}, fileExists,
      findCommand: async () => ['C:\\Tools\\codex.cmd'],
    })

    expect(result).toMatchObject({
      installed: true,
      executablePath: 'C:\\Tools\\codex.cmd',
      source: 'command-path',
      processControl: 'managed-only',
    })
  })

  it('orders every launchable Windows shim and rejects extensionless PATH entries', async () => {
    expect(orderWindowsLaunchCandidates([
      'C:\\nvm\\nodejs\\claude',
      'C:\\nvm\\nodejs\\claude.ps1',
      'C:\\nvm\\nodejs\\claude.cmd',
      'C:\\Tools\\claude.exe',
    ], 'win32')).toEqual([
      'C:\\nvm\\nodejs\\claude.cmd',
      'C:\\nvm\\nodejs\\claude.ps1',
      'C:\\Tools\\claude.exe',
    ])

    const fileExists = vi.fn(async (path: string) => (
      path === 'C:\\nvm\\nodejs\\claude' || path === 'C:\\nvm\\nodejs\\claude.cmd'
    ))
    const result = await discoverAgentExecutable('claude-code', {
      platform: 'win32', homeDir: 'C:\\Users\\A', environment: {}, fileExists,
      findCommand: async () => ['C:\\nvm\\nodejs\\claude', 'C:\\nvm\\nodejs\\claude.cmd'],
    })

    expect(result).toMatchObject({
      installed: true,
      executablePath: 'C:\\nvm\\nodejs\\claude.cmd',
      source: 'command-path',
    })
  })

  it('preserves PATH precedence instead of preferring an inaccessible packaged exe', async () => {
    const npmShim = 'C:\\nvm\\nodejs\\codex.cmd'
    const packagedBinary = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex.exe'
    const result = await discoverAgentExecutable('codex-cli', {
      platform: 'win32', homeDir: 'C:\\Users\\A', environment: {},
      findCommand: async () => [
        'C:\\nvm\\nodejs\\codex',
        npmShim,
        'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\resources\\codex',
        packagedBinary,
      ],
      fileExists: async (path) => path === npmShim || path === packagedBinary,
    })

    expect(result).toMatchObject({
      installed: true,
      executablePath: npmShim,
      source: 'command-path',
    })
    expect(result.inspectedPaths).not.toContain(packagedBinary)
  })

  it('does not claim a CLI is installed from an unlaunchable npm POSIX shim', async () => {
    const result = await discoverAgentExecutable('claude-code', {
      platform: 'win32', homeDir: 'C:\\Users\\A', workingDirectory: 'C:\\work', environment: {},
      fileExists: async (path) => path === 'C:\\nvm\\nodejs\\claude',
      findCommand: async () => ['C:\\nvm\\nodejs\\claude'],
    })

    expect(result).toMatchObject({ installed: false, source: 'unavailable' })
  })

  it('falls back to npm and user-local locations when PATH lookup fails', async () => {
    const wanted = 'C:\\Users\\A\\AppData\\Roaming\\npm\\claude.cmd'
    const result = await discoverAgentExecutable('claude-code', {
      platform: 'win32', homeDir: 'C:\\Users\\A',
      environment: { APPDATA: 'C:\\Users\\A\\AppData\\Roaming' },
      findCommand: async () => { throw new Error('where unavailable') },
      fileExists: async (path) => path === wanted,
    })

    expect(result).toMatchObject({ installed: true, executablePath: wanted, source: 'well-known-path' })
  })

  it('discovers project-local npm shims, configured package-manager bins, and WindowsApps aliases', () => {
    const paths = cliWellKnownPaths('gemini-cli', {
      platform: 'win32',
      homeDir: 'C:\\Users\\Alice',
      workingDirectory: 'D:\\project',
      environment: {
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
        NPM_CONFIG_PREFIX: 'D:\\npm-prefix',
        PNPM_HOME: 'D:\\pnpm',
        VOLTA_HOME: 'C:\\Users\\Alice\\.volta',
        NVM_SYMLINK: 'C:\\Program Files\\nodejs',
      },
    })

    expect(paths).toEqual(expect.arrayContaining([
      'D:\\project\\node_modules\\.bin\\gemini.cmd',
      'D:\\project\\node_modules\\.bin\\gemini.ps1',
      'D:\\npm-prefix\\gemini.cmd',
      'D:\\pnpm\\gemini.cmd',
      'C:\\Users\\Alice\\.volta\\bin\\gemini.cmd',
      'C:\\Program Files\\nodejs\\gemini.cmd',
      'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps\\gemini.exe',
    ]))
  })

  it('marks a WindowsApps execution alias as an installed direct executable', async () => {
    const alias = 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe'
    const result = await discoverAgentExecutable('codex-cli', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', workingDirectory: 'D:\\project',
      environment: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
      findCommand: async () => [],
      fileExists: async (path) => path === alias,
    })

    expect(result).toMatchObject({
      installed: true,
      executablePath: alias,
      source: 'well-known-path',
      processControl: 'managed-only',
    })
  })

  it('finds Homebrew Gemini on macOS after checking user paths', async () => {
    const checked: string[] = []
    const result = await discoverAgentExecutable('gemini-cli', {
      platform: 'darwin', homeDir: '/Users/alice', environment: {},
      findCommand: async () => [],
      fileExists: async (path) => { checked.push(path); return path === '/opt/homebrew/bin/gemini' },
    })

    expect(result).toMatchObject({
      installed: true, executablePath: '/opt/homebrew/bin/gemini', processControl: 'managed-only',
    })
    expect(checked).toContain('/Users/alice/.local/bin/gemini')
  })

  it('finds the official Grok Build user installation', async () => {
    const wanted = 'C:\\Users\\A\\.grok\\bin\\grok.exe'
    const result = await discoverAgentExecutable('grok-build', {
      platform: 'win32', homeDir: 'C:\\Users\\A', environment: {},
      findCommand: async () => [],
      fileExists: async (path) => path === wanted,
    })

    expect(result).toMatchObject({
      target: 'grok-build', installed: true, executablePath: wanted,
      source: 'well-known-path', processControl: 'managed-only',
    })
  })

  it('discovers the macOS Codex desktop bundle without invoking a command', async () => {
    const runCommand = vi.fn()
    const result = await discoverAgentExecutable('codex-desktop', {
      platform: 'darwin', homeDir: '/Users/alice', environment: {}, runCommand,
      fileExists: async (path) => path === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    })

    expect(result).toMatchObject({
      installed: true,
      executablePath: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      source: 'macos-app',
      processControl: 'full',
    })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('uses an installed Windows app identity when no ordinary executable is found', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: 'OpenAI.Codex_2p2nqsd0c76g0!App\r\nC:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe\r\n',
      stderr: '',
    }))
    const result = await discoverAgentExecutable('codex-desktop', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', environment: {},
      fileExists: async () => false, runCommand,
    })

    expect(result).toMatchObject({
      installed: true,
      launchTarget: 'OpenAI.Codex_2p2nqsd0c76g0!App',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe',
      source: 'windows-app',
      processControl: 'full',
    })
    expect(runCommand).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-Command']))
  })

  it('does not claim Linux desktop support or run discovery commands', async () => {
    const findCommand = vi.fn()
    const runCommand = vi.fn()
    const result = await discoverAgentExecutable('codex-desktop', {
      platform: 'linux', homeDir: '/home/alice', environment: {}, findCommand, runCommand,
    })

    expect(result).toEqual({
      target: 'codex-desktop', platform: 'linux', supported: false, installed: false,
      source: 'unavailable', processControl: 'unavailable', inspectedPaths: [],
    })
    expect(findCommand).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('reports a missing CLI as supported without granting control of external processes', async () => {
    const result = await discoverAgentExecutable('codex-cli', {
      platform: 'linux', homeDir: '/home/alice', environment: {},
      findCommand: async () => ['/broken/codex'], fileExists: async () => false,
    })

    expect(result).toMatchObject({
      supported: true, installed: false, source: 'unavailable', processControl: 'managed-only',
    })
    expect(result.inspectedPaths).toContain('/broken/codex')
  })

  it('builds deterministic, de-duplicated well-known Windows candidates', () => {
    const paths = cliWellKnownPaths('codex-cli', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice',
      environment: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    })

    expect(paths).toContain('C:\\Users\\Alice\\.local\\bin\\codex.exe')
    expect(paths).toContain('C:\\Users\\Alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')
    expect(paths).toContain('C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe')
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length)
  })
})
