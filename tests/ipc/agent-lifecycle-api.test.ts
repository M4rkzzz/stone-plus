import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLifecycleOperationResult } from '../../src/shared/agent-lifecycle'
import {
  registerAgentLifecycleApi,
  type AgentLifecycleIpcService,
} from '../../src/main/ipc/agent-lifecycle-api'

const expectedTargets = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'claude-code-desktop',
  'claude-code-vsc',
  'gemini-cli',
  'grok-build',
] as const

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  send: vi.fn(),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: electron.send } }]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
    removeHandler: electron.removeHandler,
  },
}))

describe('Agent lifecycle IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    electron.send.mockReset()
    electron.removeHandler.mockClear()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('registers and dispatches the fixed lifecycle operations', async () => {
    const service = createService()
    registerAgentLifecycleApi(service)
    const event = trustedEvent()

    await invoke('stone:get-agent-lifecycle-snapshot', event)
    await invoke('stone:install-agent', event, 'codex-cli', 'preview')
    await invoke('stone:install-agent', event, 'gemini-cli')
    await invoke('stone:close-agent', event, 'codex-desktop')
    await invoke('stone:restore-agent', event, 'claude-code', {
      preserveRunningState: true,
      ensureRunning: true,
      repairSessions: false,
    })
    await invoke('stone:restart-agent', event, 'codex-desktop')
    await invoke('stone:start-agent', event, 'gemini-cli', { workingDirectory: 'D:\\work' })
    await invoke('stone:smart-repair-agent', event, 'codex-cli')
    await invoke('stone:smart-repair-agent', event)
    await invoke('stone:repair-all-affected-agents', event)
    await invoke('stone:close-all-managed-agents', event)

    expect([...electron.handlers.keys()]).toEqual([
      'stone:get-agent-lifecycle-snapshot',
      'stone:install-agent',
      'stone:close-agent',
      'stone:restore-agent',
      'stone:restart-agent',
      'stone:start-agent',
      'stone:smart-repair-agent',
      'stone:repair-all-affected-agents',
      'stone:cancel-agent-lifecycle-operation',
      'stone:close-all-managed-agents',
    ])
    expect(service.getSnapshot).toHaveBeenCalledOnce()
    expect(service.install).toHaveBeenNthCalledWith(1, 'codex-cli', 'preview')
    expect(service.install).toHaveBeenNthCalledWith(2, 'gemini-cli', undefined)
    expect(service.close).toHaveBeenCalledWith('codex-desktop')
    expect(service.restore).toHaveBeenCalledWith('claude-code', {
      preserveRunningState: true,
      ensureRunning: true,
      repairSessions: false,
    })
    expect(service.restart).toHaveBeenCalledWith('codex-desktop')
    expect(service.start).toHaveBeenCalledWith('gemini-cli', { workingDirectory: 'D:\\work' })
    expect(service.smartRepair).toHaveBeenNthCalledWith(1, 'codex-cli')
    expect(service.smartRepair).toHaveBeenNthCalledWith(2, undefined)
    expect(service.repairAllAffected).toHaveBeenCalledOnce()
    expect(service.closeAllManaged).toHaveBeenCalledOnce()
  })

  it('accepts every fixed Agent target while preserving the legacy Claude CLI id', async () => {
    const service = createService()
    registerAgentLifecycleApi(service)

    for (const target of expectedTargets) {
      await invoke('stone:close-agent', trustedEvent(), target)
    }

    expect(service.close).toHaveBeenCalledTimes(expectedTargets.length)
    expect(service.close).toHaveBeenCalledWith('claude-code')
    expect(service.close).toHaveBeenCalledWith('claude-code-desktop')
    expect(service.close).toHaveBeenCalledWith('claude-code-vsc')
  })

  it('rejects unsupported targets and malformed start options before invoking the service', async () => {
    const service = createService()
    registerAgentLifecycleApi(service)
    const event = trustedEvent()

    await expect(invoke('stone:close-agent', event, 'powershell')).rejects.toThrow('Unsupported Agent lifecycle target')
    await expect(invoke('stone:install-agent', event, 'codex-cli', 'https://evil.example/install.ps1')).rejects.toThrow('Unsupported Agent install channel')
    await expect(invoke('stone:install-agent', event, 'codex-cli', { command: 'npm install anything' })).rejects.toThrow('Unsupported Agent install channel')
    await expect(invoke('stone:start-agent', event, 'codex-cli', { command: 'rm -rf' })).rejects.toThrow('Invalid Agent start options')
    await expect(invoke('stone:start-agent', event, 'codex-cli', { workingDirectory: '' })).rejects.toThrow('Invalid Agent working directory')
    await expect(invoke('stone:start-agent', event, 'codex-cli', { profileId: '' })).rejects.toThrow('Invalid Agent profile identifier')
    await expect(invoke('stone:start-agent', event, 'codex-cli', [])).rejects.toThrow('Invalid Agent start options')
    await expect(invoke('stone:restore-agent', event, 'codex-cli', { repairSessions: 'yes' })).rejects.toThrow('Invalid Agent restore options')
    await expect(invoke('stone:restore-agent', event, 'codex-cli', { ensureRunning: 'yes' })).rejects.toThrow('Invalid Agent restore options')

    expect(service.close).not.toHaveBeenCalled()
    expect(service.install).not.toHaveBeenCalled()
    expect(service.start).not.toHaveBeenCalled()
  })

  it('checks sender trust before validating arguments or invoking the service', async () => {
    const service = createService()
    registerAgentLifecycleApi(service)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke('stone:start-agent', {
      senderFrame: mainFrame,
      sender: { mainFrame },
    }, 'not-an-agent', { command: 'anything' })).rejects.toThrow('untrusted origin')

    expect(service.start).not.toHaveBeenCalled()
  })

  it('normalizes start identifiers without changing path semantics', async () => {
    const service = createService()
    registerAgentLifecycleApi(service)

    await invoke('stone:start-agent', trustedEvent(), 'codex-cli', {
      workingDirectory: '  D:\\work tree  ',
      profileId: ' profile-1 ',
    })

    expect(service.start).toHaveBeenCalledWith('codex-cli', {
      workingDirectory: 'D:\\work tree',
      profileId: 'profile-1',
    })
  })

  it('streams real repair progress and safely cancels the matching operation', async () => {
    const service = createService()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    service.restore = vi.fn(async (_target, _options, _execution) => {
      await pending
      return { status: 'cancelled' } as unknown as AgentLifecycleOperationResult
    })
    registerAgentLifecycleApi(service)
    const operationId = 'agent-repair-1234'
    const operation = invoke(
      'stone:restore-agent',
      trustedEvent(),
      'codex-cli',
      { repairSessions: true },
      operationId,
    )
    await vi.waitFor(() => expect(service.restore).toHaveBeenCalledOnce())
    const execution = vi.mocked(service.restore).mock.calls[0][2]
    expect(execution?.signal.aborted).toBe(false)

    execution?.onProgress?.({
      target: 'codex-cli',
      stage: 'scan',
      completed: 4,
      total: 12,
    })
    expect(electron.send).toHaveBeenCalledWith('stone:agent-lifecycle-progress', {
      operationId,
      target: 'codex-cli',
      stage: 'scan',
      completed: 4,
      total: 12,
    })

    await expect(invoke('stone:cancel-agent-lifecycle-operation', trustedEvent(), operationId)).resolves.toBe(true)
    expect(execution?.signal.aborted).toBe(true)
    await expect(invoke('stone:cancel-agent-lifecycle-operation', trustedEvent(), operationId)).resolves.toBe(false)
    release()
    await operation
    await expect(invoke('stone:cancel-agent-lifecycle-operation', trustedEvent(), operationId)).resolves.toBe(false)
  })

  it('rejects malformed or duplicate cancellable operation identifiers', async () => {
    const service = createService()
    let release!: () => void
    service.restart = vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ status: 'done' } as unknown as AgentLifecycleOperationResult)
    }))
    registerAgentLifecycleApi(service)

    await expect(invoke('stone:restart-agent', trustedEvent(), 'codex-cli', '../bad')).rejects.toThrow(
      'Invalid Agent lifecycle operation identifier',
    )
    const first = invoke('stone:restart-agent', trustedEvent(), 'codex-cli', 'restart-operation-1234')
    await vi.waitFor(() => expect(service.restart).toHaveBeenCalledOnce())
    await expect(invoke('stone:restart-agent', trustedEvent(), 'codex-cli', 'restart-operation-1234')).rejects.toThrow(
      'already running',
    )
    release()
    await first
  })

  it('forwards change events and disposal removes handlers while draining accepted work', async () => {
    let listener: ((event: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const service = createService()
    service.onChange = vi.fn((next) => {
      listener = next as (event: unknown) => void
      return unsubscribe
    })
    service.start = vi.fn(() => pending.then(() => ({ status: 'started' }))) as AgentLifecycleIpcService['start']
    const dispose = registerAgentLifecycleApi(service)
    const update = { snapshot: { revision: 2 } }

    listener?.(update)
    const operation = invoke('stone:start-agent', trustedEvent(), 'codex-cli')
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledOnce())
    let disposed = false
    const disposing = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(electron.send).toHaveBeenCalledWith('stone:agent-lifecycle-changed', update)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)

    finish()
    await Promise.all([operation, disposing, dispose()])
    listener?.({ snapshot: { revision: 3 } })
    expect(disposed).toBe(true)
    expect(electron.send).toHaveBeenCalledTimes(1)
  })
})

function createService(): AgentLifecycleIpcService {
  return {
    getSnapshot: vi.fn(async () => []),
    install: vi.fn(async () => ({ status: 'installed' })),
    close: vi.fn(async () => ({ status: 'closed' })),
    restore: vi.fn(async () => ({ status: 'restored' })),
    restart: vi.fn(async () => ({ status: 'restarted' })),
    start: vi.fn(async () => ({ status: 'started' })),
    smartRepair: vi.fn(async () => ({ status: 'repaired' })),
    repairAllAffected: vi.fn(async () => ({ status: 'repaired' })),
    closeAllManaged: vi.fn(async () => ({ status: 'closed' })),
  } as unknown as AgentLifecycleIpcService
}

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}
