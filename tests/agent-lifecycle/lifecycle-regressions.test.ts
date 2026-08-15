import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_INSTALL_GUIDE_URLS,
  AgentInstallationService,
} from '../../src/main/agent-installation/agent-installation-service'
import {
  AgentLifecycleService,
  type AgentAdapterSnapshot,
  type AgentInstallationPort,
  type AgentLifecycleAdapterPort,
} from '../../src/main/agent-lifecycle/service'
import { agentActionBlockReason } from '../../src/renderer/src/agent-lifecycle-control'
import {
  AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentLifecycleState,
  type AgentTarget,
} from '../../src/shared/agent-lifecycle'

const targets: AgentTarget[] = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'claude-code-desktop',
  'claude-code-vsc',
  'gemini-cli',
  'grok-build',
  'deepseek-harness',
]

describe('Agent lifecycle regressions', () => {
  it('explains the Codex Desktop conflict before a Codex CLI start is dispatched', () => {
    const desktop = state('codex-desktop', { running: true, managedInstanceCount: 1 })
    const cli = state('codex-cli')

    const reason = agentActionBlockReason(cli, [desktop, cli], (_zh, en) => en)

    expect(reason).toContain('Codex Desktop is running')
    expect(reason).toContain('cannot be started at the same time')
    expect(agentActionBlockReason(cli, [{ ...desktop, running: false }, cli], (_zh, en) => en)).toBeUndefined()
  })

  it('rejects a Codex CLI start in the backend while Codex Desktop is running', async () => {
    const cliStart = vi.fn(async () => undefined)
    const adapters = adaptersWith({
      'codex-desktop': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
      },
      'codex-cli': { start: cliStart },
    })
    const service = createService(adapters)

    const result = await service.start('codex-cli')

    expect(result.status).toBe('failed')
    expect(result.results[0].error).toMatchObject({
      code: 'operation-conflict',
      message: expect.stringMatching(/Codex Desktop.+running/i),
    })
    expect(cliStart).not.toHaveBeenCalled()
  })

  it('routes a running Codex Desktop restart through its deep repair transaction', async () => {
    const close = vi.fn(async () => ({ wasRunning: true }))
    const start = vi.fn(async () => undefined)
    const restore = vi.fn(async () => ({ changed: true }))
    const adapters = adaptersWith({
      'codex-desktop': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
        close,
        start,
        restore,
      },
    })
    const service = createService(adapters)

    const result = await service.restart('codex-desktop')

    expect(result.action).toBe('restart')
    expect(result.status).toBe('succeeded')
    expect(restore).toHaveBeenCalledWith({
      preserveRunningState: true,
      ensureRunning: true,
      repairSessions: true,
      repairWorkspaceIndex: false,
    })
    expect(close).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('does not report a close as successful while the managed process is still running', async () => {
    const adapters = adaptersWith({
      'claude-code': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
        close: vi.fn(async () => ({ wasRunning: true })),
      },
    })
    const service = createService(adapters)

    const result = await service.close('claude-code')

    expect(result.status).toBe('failed')
    expect(result.results[0]).toMatchObject({
      runningAfter: true,
      error: { code: 'process-close-failed', phase: 'close' },
    })
  })

  it('enforces the stopped postcondition when restore is asked not to relaunch', async () => {
    const adapters = adaptersWith({
      'gemini-cli': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
        restore: vi.fn(async () => ({ wasRunning: true, changed: true })),
      },
    })
    const service = createService(adapters)

    const result = await service.restore('gemini-cli', { preserveRunningState: false })

    expect(result.status).toBe('failed')
    expect(result.results[0]).toMatchObject({
      runningAfter: true,
      error: { code: 'process-close-failed', phase: 'close' },
    })
  })

  it('completes aggregate repair and preserves every Agent outcome when one Agent fails', async () => {
    const adapters = adaptersWith({
      'codex-desktop': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
      },
      'claude-code': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
      },
      'gemini-cli': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
        restore: vi.fn(async () => { throw new Error('Gemini validation failed') }),
      },
      'grok-build': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 })),
      },
    })
    const service = createService(adapters)

    const result = await service.repairAllAffected()

    expect(result.status).toBe('partial')
    expect(result.results.map(({ target }) => target)).toEqual(targets)
    expect(result.results.find(({ target }) => target === 'gemini-cli')).toMatchObject({
      status: 'failed',
      error: { message: 'Gemini validation failed' },
    })
    expect(result.results.filter(({ status }) => status === 'succeeded').length).toBeGreaterThan(0)
    expect(adapters['codex-desktop'].restore).toHaveBeenCalledOnce()
    expect(adapters['codex-cli'].restore).not.toHaveBeenCalled()
  })

  it('coalesces repeated aggregate repair clicks without deadlocking the shared Codex home', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const restore = vi.fn(async () => { await gate })
    const adapters = adaptersWith({
      'codex-desktop': { restore },
      'codex-cli': { restore },
      'claude-code': { restore },
      'gemini-cli': { restore },
    })
    const service = createService(adapters)

    const first = service.smartRepair()
    const second = service.repairAllAffected()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(3))
    release()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.operationId).toBe(secondResult.operationId)
    expect(firstResult.results).toHaveLength(8)
    expect(restore).toHaveBeenCalledTimes(3)
  })

  it('opens the fixed Gemini guide without probing Node.js or npm', async () => {
    const execute = vi.fn(async () => { throw new Error('process execution is forbidden') })
    const openExternal = vi.fn(async () => undefined)
    const installer = new AgentInstallationService({
      processPort: { execute },
      platform: 'win32',
      openExternal,
    })

    await expect(installer.install('gemini-cli')).resolves.toMatchObject({
      status: 'opened-download-page',
    })
    expect(openExternal).toHaveBeenCalledWith(AGENT_INSTALL_GUIDE_URLS['gemini-cli'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns a freshly inspected snapshot after a successful installation', async () => {
    let installed = false
    const adapters = adaptersWith({
      'gemini-cli': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), installed })),
      },
    })
    const installer: AgentInstallationPort = {
      install: vi.fn(async (target, channel = 'recommended') => {
        installed = true
        return {
          operationId: 'installer-1',
          target,
          channel,
          status: 'installed' as const,
          version: '1.2.3',
        }
      }),
    }
    const service = createService(adapters, installer)

    const result = await service.install('gemini-cli')

    expect(result.status).toBe('succeeded')
    expect(result.snapshot.agents['gemini-cli'].installed).toBe(true)
    expect(installer.install).toHaveBeenCalledWith('gemini-cli', 'recommended')
  })
})

function createService(
  adapters: Record<AgentTarget, AgentLifecycleAdapterPort>,
  installer: AgentInstallationPort = successfulInstaller(),
) {
  return new AgentLifecycleService({
    adapters,
    installer,
    resolveRoute: () => ({ enabled: true, compatibility: 'native', sourceId: 'pool-1' }),
    id: (() => { let id = 0; return () => `operation-${++id}` })(),
  })
}

function successfulInstaller(): AgentInstallationPort {
  return {
    install: vi.fn(async (target, channel = 'recommended') => ({
      operationId: 'installer-default',
      target,
      channel,
      status: 'installed' as const,
    })),
  }
}

function adaptersWith(
  overrides: Partial<Record<AgentTarget, Partial<AgentLifecycleAdapterPort>>> = {},
): Record<AgentTarget, AgentLifecycleAdapterPort> {
  return Object.fromEntries(targets.map((target) => {
    const base: AgentLifecycleAdapterPort = {
      target,
      inspect: vi.fn(async () => healthySnapshot()),
      close: vi.fn(async () => ({ wasRunning: false })),
      restore: vi.fn(async () => ({ wasRunning: false, changed: true })),
      start: vi.fn(async () => undefined),
    }
    return [target, { ...base, ...overrides[target], target }]
  })) as Record<AgentTarget, AgentLifecycleAdapterPort>
}

function healthySnapshot(): AgentAdapterSnapshot {
  return {
    installed: true,
    configured: true,
    running: false,
    managedInstanceCount: 0,
    processControl: 'managed-only',
  }
}

function state(target: AgentTarget, overrides: Partial<AgentLifecycleState> = {}): AgentLifecycleState {
  return {
    target,
    capabilities: capabilities(target),
    installed: true,
    enabled: true,
    configured: true,
    compatibility: 'native',
    running: false,
    managedInstanceCount: 0,
    processControl: AGENT_CAPABILITIES[target].canCloseKnownProcess
      ? target === 'codex-desktop' ? 'full' : 'managed-only'
      : 'unavailable',
    attention: 'normal',
    pendingNewSession: false,
    needsRestart: false,
    ...overrides,
  }
}

function capabilities(target: AgentTarget): AgentCapabilities {
  return AGENT_CAPABILITIES[target]
}
