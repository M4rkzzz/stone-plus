import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_INSTALL_GUIDE_URLS,
  AgentInstallerProcessError,
  AgentInstallationService,
  CODEX_DESKTOP_DOWNLOAD_URL,
  DEEPSEEK_HARNESS_PACKAGE_NAME,
  DEEPSEEK_HARNESS_PACKAGE_SPEC,
  DEEPSEEK_HARNESS_VERSION,
  type AgentInstallerProcessPort,
  type AgentInstallerProcessResult,
} from '../../src/main/agent-installation'

interface ProcessCall {
  executable: string
  args: readonly string[]
  timeoutMs: number
}

const CLAUDE_INSTALL_URLS = {
  cli: 'https://code.claude.com/docs/en/getting-started',
  desktop: 'https://claude.com/download',
  vsc: 'https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code',
} as const

function processPort(
  execute: (call: ProcessCall) => Promise<AgentInstallerProcessResult>,
): AgentInstallerProcessPort & { calls: ProcessCall[] } {
  const calls: ProcessCall[] = []
  return {
    calls,
    async execute(executable, args, options) {
      const call = { executable, args, timeoutMs: options.timeoutMs }
      calls.push(call)
      return execute(call)
    },
  }
}

describe('AgentInstallationService', () => {
  it('opens only the fixed official desktop download page', async () => {
    const openExternal = vi.fn(async () => undefined)
    const processes = processPort(async () => ({ stdout: '', stderr: '' }))
    const service = new AgentInstallationService({
      openExternal,
      processPort: processes,
      createOperationId: () => 'desktop-install',
    })

    await expect(service.install('codex-desktop')).resolves.toEqual({
      operationId: 'desktop-install', target: 'codex-desktop', channel: 'recommended',
      status: 'opened-download-page',
    })
    expect(openExternal).toHaveBeenCalledWith(CODEX_DESKTOP_DOWNLOAD_URL)
    expect(processes.calls).toEqual([])
  })

  it.each(Object.entries(AGENT_INSTALL_GUIDE_URLS).filter(([target]) => target !== 'deepseek-harness'))(
    'opens the fixed official %s guide without executing a process',
    async (target, expectedUrl) => {
      const openExternal = vi.fn(async () => undefined)
      const processes = processPort(async () => {
        throw new Error('online installer processes must never run')
      })
      const service = new AgentInstallationService({ openExternal, processPort: processes })

      await expect(service.install(target as keyof typeof AGENT_INSTALL_GUIDE_URLS)).resolves.toMatchObject({
        target,
        status: 'opened-download-page',
      })
      expect(openExternal).toHaveBeenCalledWith(expectedUrl)
      expect(processes.calls).toEqual([])
    },
  )

  it('keeps the Claude CLI target and official guide URL backward compatible', async () => {
    const openExternal = vi.fn(async () => undefined)
    const service = new AgentInstallationService({ openExternal })

    expect(AGENT_INSTALL_GUIDE_URLS['claude-code']).toBe(CLAUDE_INSTALL_URLS.cli)
    await expect(service.install('claude-code')).resolves.toMatchObject({
      target: 'claude-code',
      status: 'opened-download-page',
    })
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(CLAUDE_INSTALL_URLS.cli)

    const failingService = new AgentInstallationService({
      openExternal: async () => { throw new Error('browser unavailable') },
    })
    await expect(failingService.install('claude-code')).resolves.toMatchObject({
      target: 'claude-code',
      status: 'failed',
      error: {
        code: 'open-download-page-failed',
        message: 'The official Claude Code CLI installation guide could not be opened.',
      },
    })
  })

  it.each([
    ['claude-code-desktop', CLAUDE_INSTALL_URLS.desktop],
    ['claude-code-vsc', CLAUDE_INSTALL_URLS.vsc],
  ] as const)('opens the fixed official %s page', async (target, expectedUrl) => {
    const openExternal = vi.fn(async () => undefined)
    const processes = processPort(async () => {
      throw new Error('installation must remain browser-only')
    })
    const service = new AgentInstallationService({ openExternal, processPort: processes })

    expect(AGENT_INSTALL_GUIDE_URLS[target]).toBe(expectedUrl)
    await expect(service.install(target)).resolves.toMatchObject({
      target,
      channel: 'recommended',
      status: 'opened-download-page',
    })
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(expectedUrl)
    expect(processes.calls).toEqual([])
  })

  it.each(['claude-code-desktop', 'claude-code-vsc'] as const)(
    'rejects the unsupported preview channel for %s without opening a page',
    async (target) => {
      const openExternal = vi.fn(async () => undefined)
      const processes = processPort(async () => ({ stdout: '', stderr: '' }))
      const service = new AgentInstallationService({ openExternal, processPort: processes })

      await expect(service.install(target, 'preview')).resolves.toMatchObject({
        target,
        channel: 'preview',
        status: 'failed',
        error: { code: 'unsupported-channel' },
      })
      expect(openExternal).not.toHaveBeenCalled()
      expect(processes.calls).toEqual([])
    },
  )

  it.each([
    'claude-code-preview',
    'https://evil.example/install',
    'claude-code-vsc?redirect=https://evil.example',
    '__proto__',
  ])('rejects unknown or attacker-controlled target %s', async (target) => {
    const openExternal = vi.fn(async () => undefined)
    const processes = processPort(async () => ({ stdout: '', stderr: '' }))
    const service = new AgentInstallationService({ openExternal, processPort: processes })

    await expect(service.install(target as never)).resolves.toMatchObject({
      target,
      status: 'failed',
      error: { code: 'unsupported-target' },
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(processes.calls).toEqual([])
  })

  it('keeps all non-DSH installations browser-only', async () => {
    const opened: string[] = []
    const processes = processPort(async () => ({ stdout: '', stderr: '' }))
    const service = new AgentInstallationService({
      openExternal: async (url) => { opened.push(url) },
      processPort: processes,
    })

    await Promise.all([
      service.install('codex-cli'),
      service.install('claude-code'),
      service.install('claude-code-desktop'),
      service.install('claude-code-vsc'),
      service.install('gemini-cli'),
      service.install('grok-build'),
    ])

    expect(processes.calls).toEqual([])
    expect(opened.sort()).toEqual(Object.entries(AGENT_INSTALL_GUIDE_URLS)
      .filter(([target]) => target !== 'deepseek-harness')
      .map(([, url]) => url)
      .sort())
  })

  it('installs and verifies only the pinned official DeepSeek Harness package without a shell', async () => {
    const nodeExecutable = 'C:\\Tools\\nodejs\\node.exe'
    const npmCli = 'C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const prefix = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
    const entrypoint = `${prefix}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`
    const processes = processPort(async ({ executable, args }) => {
      if (executable === 'node.exe' && args[0] === '--version') return { stdout: 'v22.20.0\n', stderr: '' }
      if (executable === 'node.exe' && args[0] === '-p') return { stdout: `${nodeExecutable}\n`, stderr: '' }
      if (executable === nodeExecutable && args[0] === npmCli && args[1] === '--version') {
        return { stdout: '10.9.3\n', stderr: '' }
      }
      if (executable === nodeExecutable && args.includes('install')) return { stdout: 'added packages\n', stderr: '' }
      if (executable === nodeExecutable && args[0] === entrypoint && args[1] === '--version') {
        return { stdout: `${DEEPSEEK_HARNESS_VERSION}\n`, stderr: '' }
      }
      throw new Error(`Unexpected process call: ${executable} ${args.join(' ')}`)
    })
    const stages: string[] = []
    const service = new AgentInstallationService({
      platform: 'win32',
      processPort: processes,
      environment: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      homeDir: 'C:\\Users\\tester',
      createOperationId: () => 'dsh-install',
    })

    await expect(service.install('deepseek-harness', 'recommended', ({ stage }) => stages.push(stage))).resolves.toEqual({
      operationId: 'dsh-install',
      target: 'deepseek-harness',
      channel: 'recommended',
      status: 'installed',
      packageName: DEEPSEEK_HARNESS_PACKAGE_NAME,
      version: DEEPSEEK_HARNESS_VERSION,
    })
    expect(stages).toEqual(['checking-node', 'checking-npm', 'installing', 'verifying', 'completed'])
    const install = processes.calls.find(({ args }) => args.includes('install'))
    expect(install).toEqual({
      executable: nodeExecutable,
      args: [
        npmCli,
        'install',
        '--global',
        '--prefix',
        prefix,
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        DEEPSEEK_HARNESS_PACKAGE_SPEC,
      ],
      timeoutMs: 5 * 60_000,
    })
    expect(processes.calls.flatMap(({ executable, args }) => [executable, ...args]).join(' ')).not.toMatch(
      /(?:powershell|pwsh|cmd\.exe|curl|\blatest\b|https?:\/\/)/i,
    )
  })

  it('fails closed when DeepSeek Harness sees an incompatible Node.js release', async () => {
    const processes = processPort(async ({ args }) => {
      if (args[0] === '--version') return { stdout: 'v23.9.0\n', stderr: '' }
      return { stdout: 'C:\\Tools\\nodejs\\node.exe\n', stderr: '' }
    })
    const service = new AgentInstallationService({ platform: 'win32', processPort: processes })

    await expect(service.install('deepseek-harness')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'node-not-found', detail: 'Detected Node.js 23.9.0.' },
    })
    expect(processes.calls).toHaveLength(2)
  })

  it('reports a missing npm runtime without attempting installation', async () => {
    const nodeExecutable = 'C:\\PortableNode\\node.exe'
    const processes = processPort(async ({ executable, args }) => {
      if (executable === 'node.exe' && args[0] === '--version') return { stdout: 'v22.20.0\n', stderr: '' }
      if (executable === 'node.exe' && args[0] === '-p') return { stdout: `${nodeExecutable}\n`, stderr: '' }
      if (executable === 'where.exe') throw new Error('npm.cmd was not found')
      throw new AgentInstallerProcessError('npm CLI was not found', false)
    })
    const service = new AgentInstallationService({ platform: 'win32', processPort: processes })

    await expect(service.install('deepseek-harness')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'npm-not-found' },
    })
    expect(processes.calls.some(({ args }) => args.includes('install'))).toBe(false)
  })

  it('classifies a timed-out pinned DeepSeek Harness install', async () => {
    const nodeExecutable = 'C:\\Tools\\nodejs\\node.exe'
    const npmCli = 'C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const processes = processPort(async ({ executable, args }) => {
      if (executable === 'node.exe' && args[0] === '--version') return { stdout: 'v24.1.0\n', stderr: '' }
      if (executable === 'node.exe' && args[0] === '-p') return { stdout: `${nodeExecutable}\n`, stderr: '' }
      if (args[0] === npmCli && args[1] === '--version') return { stdout: '10.9.3\n', stderr: '' }
      throw new AgentInstallerProcessError('timed out', true, '', 'registry timeout')
    })
    const service = new AgentInstallationService({ platform: 'win32', processPort: processes, installTimeoutMs: 1234 })

    await expect(service.install('deepseek-harness')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'install-timeout', detail: 'registry timeout' },
    })
    expect(processes.calls.find(({ args }) => args.includes('install'))?.timeoutMs).toBe(1234)
  })

  it('rejects a DeepSeek Harness installation that reports a different version', async () => {
    const nodeExecutable = 'C:\\Tools\\nodejs\\node.exe'
    const npmCli = 'C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const processes = processPort(async ({ executable, args }) => {
      if (executable === 'node.exe' && args[0] === '--version') return { stdout: 'v22.20.0\n', stderr: '' }
      if (executable === 'node.exe' && args[0] === '-p') return { stdout: `${nodeExecutable}\n`, stderr: '' }
      if (args[0] === npmCli && args[1] === '--version') return { stdout: '10.9.3\n', stderr: '' }
      if (args.includes('install')) return { stdout: '', stderr: '' }
      return { stdout: '0.1.0-rc.5\n', stderr: '' }
    })
    const service = new AgentInstallationService({
      platform: 'win32',
      processPort: processes,
      environment: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      homeDir: 'C:\\Users\\tester',
    })

    await expect(service.install('deepseek-harness')).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'verification-failed',
        detail: `Expected ${DEEPSEEK_HARNESS_VERSION}, but the installed CLI reported 0.1.0-rc.5.`,
      },
    })
  })

  it('keeps unsupported preview channels fail closed without opening a page', async () => {
    const openExternal = vi.fn(async () => undefined)
    const service = new AgentInstallationService({ openExternal })

    await expect(service.install('codex-cli', 'preview')).resolves.toMatchObject({
      status: 'failed', error: { code: 'unsupported-channel' },
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a fixed-page opening failure without falling back to command execution', async () => {
    const processes = processPort(async () => ({ stdout: '', stderr: '' }))
    const service = new AgentInstallationService({
      openExternal: async () => { throw new Error('browser unavailable') },
      processPort: processes,
      now: () => 42,
    })
    const stages: string[] = []

    const result = await service.install('claude-code', 'recommended', (progress) => {
      expect(progress.timestamp).toBe(42)
      stages.push(progress.stage)
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'open-download-page-failed', detail: 'browser unavailable' },
    })
    expect(stages).toEqual(['opening-download-page', 'failed'])
    expect(processes.calls).toEqual([])
  })
})
