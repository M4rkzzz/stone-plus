import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_INSTALL_GUIDE_URLS,
  AgentInstallationService,
  CODEX_DESKTOP_DOWNLOAD_URL,
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

  it.each(Object.entries(AGENT_INSTALL_GUIDE_URLS))(
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

  it('never builds shell, PowerShell, curl, npm, or floating-tag installation commands', async () => {
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
    expect(opened.sort()).toEqual(Object.values(AGENT_INSTALL_GUIDE_URLS).sort())
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
