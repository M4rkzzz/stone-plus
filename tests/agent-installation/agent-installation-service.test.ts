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
