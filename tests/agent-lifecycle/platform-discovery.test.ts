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
      stdout: 'OpenAI.Codex_2p2nqsd0c76g0!App\r\nC:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe\r\n26.803.5235.0\r\n',
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
      version: '26.803.5235.0',
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

  it('discovers Claude Code Desktop from the fixed Windows package identity', async () => {
    const findCommand = vi.fn()
    const runCommand = vi.fn(async () => ({
      stdout: 'Claude_pzs8sxrjxfjjc\r\nC:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc\r\n',
      stderr: '',
    }))
    const result = await discoverAgentExecutable('claude-code-desktop', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', environment: {},
      fileExists: async () => false, findCommand, runCommand,
    })

    expect(result).toMatchObject({
      target: 'claude-code-desktop',
      installed: true,
      launchTarget: 'claude://code/new',
      source: 'windows-app',
      processControl: 'unavailable',
    })
    expect(result.executablePath).toBeUndefined()
    expect(result.inspectedPaths).toEqual([
      'C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc',
    ])
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand.mock.calls[0][0]).toBe('powershell.exe')
    expect(runCommand.mock.calls[0][1].at(-1)).toContain("Get-AppxPackage -Name 'Claude'")
    expect(findCommand).not.toHaveBeenCalled()
  })

  it('does not fall through to a CLI when Claude Code Desktop is absent on Windows', async () => {
    const findCommand = vi.fn(async () => ['C:\\Tools\\grok.exe'])
    const fileExists = vi.fn(async () => true)
    const result = await discoverAgentExecutable('claude-code-desktop', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', environment: {},
      fileExists, findCommand,
      runCommand: async () => ({ stdout: '', stderr: '' }),
    })

    expect(result).toEqual({
      target: 'claude-code-desktop', platform: 'win32', supported: true, installed: false,
      source: 'unavailable', processControl: 'unavailable', inspectedPaths: [],
    })
    expect(findCommand).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalled()
  })

  it('discovers the Claude Desktop app bundle on macOS through its exact app path', async () => {
    const runCommand = vi.fn()
    const result = await discoverAgentExecutable('claude-code-desktop', {
      platform: 'darwin', homeDir: '/Users/alice', environment: {}, runCommand,
      fileExists: async (path) => path === '/Applications/Claude.app/Contents/MacOS/Claude',
    })

    expect(result).toMatchObject({
      target: 'claude-code-desktop',
      installed: true,
      executablePath: '/Applications/Claude.app/Contents/MacOS/Claude',
      launchTarget: 'claude://code/new',
      source: 'macos-app',
      processControl: 'unavailable',
    })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('uses only the official claude-desktop executable name on Linux', async () => {
    const checked: string[] = []
    const findCommand = vi.fn(async () => ['/home/alice/.local/bin/claude'])
    const result = await discoverAgentExecutable('claude-code-desktop', {
      platform: 'linux', homeDir: '/home/alice', environment: {}, findCommand,
      fileExists: async (path) => { checked.push(path); return path === '/usr/bin/claude-desktop' },
    })

    expect(result).toMatchObject({
      target: 'claude-code-desktop', installed: true,
      executablePath: '/usr/bin/claude-desktop',
      launchTarget: 'claude://code/new',
      source: 'well-known-path', processControl: 'unavailable',
    })
    expect(checked).toEqual(['/usr/bin/claude-desktop'])
    expect(findCommand).not.toHaveBeenCalled()
  })

  it('discovers the exact official Claude Code extension in stable VS Code', async () => {
    const findCommand = vi.fn()
    const fileExists = vi.fn()
    const readDirectoryNames = vi.fn(async (path: string) => path.endsWith('\\.vscode\\extensions')
      ? ['anthropic.claude-code-2.1.216-win32-x64', 'anthropic.claude-code-evil', 'other.extension-1.0.0']
      : [])
    const result = await discoverAgentExecutable('claude-code-vsc', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', environment: {},
      findCommand, fileExists, readDirectoryNames,
    })

    expect(result).toMatchObject({
      target: 'claude-code-vsc', installed: true,
      launchTarget: 'vscode://anthropic.claude-code/open',
      source: 'well-known-path', processControl: 'unavailable',
    })
    expect(result.executablePath).toBeUndefined()
    expect(result.inspectedPaths).toContain(
      'C:\\Users\\Alice\\.vscode\\extensions\\anthropic.claude-code-2.1.216-win32-x64',
    )
    expect(findCommand).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalled()
  })

  it('falls back to the official extension in VS Code Insiders', async () => {
    const readDirectoryNames = vi.fn(async (path: string) => {
      if (path.endsWith('/.vscode/extensions')) throw new Error('missing stable extensions')
      return ['anthropic.claude-code-2.1.216-linux-x64']
    })
    const result = await discoverAgentExecutable('claude-code-vsc', {
      platform: 'linux', homeDir: '/home/alice', environment: {}, readDirectoryNames,
    })

    expect(result).toMatchObject({
      installed: true,
      launchTarget: 'vscode-insiders://anthropic.claude-code/open',
      processControl: 'unavailable',
    })
    expect(readDirectoryNames).toHaveBeenNthCalledWith(1, '/home/alice/.vscode/extensions')
    expect(readDirectoryNames).toHaveBeenNthCalledWith(2, '/home/alice/.vscode-insiders/extensions')
  })

  it('rejects lookalike VS Code extensions without probing a Grok executable', async () => {
    const findCommand = vi.fn(async () => ['C:\\Tools\\grok.exe'])
    const fileExists = vi.fn(async () => true)
    const result = await discoverAgentExecutable('claude-code-vsc', {
      platform: 'win32', homeDir: 'C:\\Users\\Alice', environment: {},
      findCommand, fileExists,
      readDirectoryNames: async () => [
        'anthropic.claude-code-evil',
        'anthropic.claude-code-2.1',
        'someone.claude-code-2.1.216-win32-x64',
      ],
    })

    expect(result).toMatchObject({
      target: 'claude-code-vsc', installed: false,
      source: 'unavailable', processControl: 'unavailable',
    })
    expect(findCommand).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalled()
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
