import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayApi, ManagedClientInstanceInput } from '../../src/shared/types'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}))

describe('client operation preload contract', () => {
  beforeEach(() => {
    vi.resetModules()
    electron.exposeInMainWorld.mockReset()
    electron.invoke.mockReset()
    electron.on.mockReset()
    electron.removeListener.mockReset()
  })

  it('keeps every managed-instance and Agent lifecycle argument wired to its fixed channel', async () => {
    electron.invoke.mockResolvedValue({})
    await import('../../src/preload/index')
    const stone = exposedStone()
    const instance: ManagedClientInstanceInput = { name: 'Work', client: 'codex', configDirectory: 'D:\\config' }
    const startOptions = { workingDirectory: 'D:\\work', profileId: 'profile-1' }
    const restoreOptions = { preserveRunningState: true, ensureRunning: true, repairSessions: true }

    await stone.listManagedClientInstances()
    await stone.saveManagedClientInstance(instance)
    await stone.deleteManagedClientInstance('instance-1')
    await stone.startManagedClientInstance('instance-1')
    await stone.stopManagedClientInstance('instance-1')
    await stone.getAgentLifecycleSnapshot()
    await stone.installAgent('codex-cli', 'preview')
    await stone.closeAgent('codex-cli')
    await stone.restoreAgent('codex-cli', restoreOptions)
    await stone.restartAgent('codex-cli')
    await stone.startAgent('codex-cli', startOptions)
    await stone.smartRepairAgent('codex-cli')
    await stone.repairAllAffectedAgents()
    await stone.closeAllManagedAgents()
    await stone.restoreClaudeDesktopOfficialMode()

    expect(electron.invoke.mock.calls).toEqual([
      ['stone:list-managed-client-instances'],
      ['stone:save-managed-client-instance', instance],
      ['stone:delete-managed-client-instance', 'instance-1'],
      ['stone:start-managed-client-instance', 'instance-1'],
      ['stone:stop-managed-client-instance', 'instance-1'],
      ['stone:get-agent-lifecycle-snapshot'],
      ['stone:install-agent', 'codex-cli', 'preview'],
      ['stone:close-agent', 'codex-cli'],
      ['stone:restore-agent', 'codex-cli', restoreOptions],
      ['stone:restart-agent', 'codex-cli'],
      ['stone:start-agent', 'codex-cli', startOptions],
      ['stone:smart-repair-agent', 'codex-cli'],
      ['stone:repair-all-affected-agents'],
      ['stone:close-all-managed-agents'],
      ['stone:restore-claude-desktop-official-mode'],
    ])
  })

  it('subscribes and unsubscribes both renderer event streams with the same callback wrapper', async () => {
    await import('../../src/preload/index')
    const stone = exposedStone()
    const instanceListener = vi.fn()
    const lifecycleListener = vi.fn()

    const stopInstances = stone.onManagedClientInstancesChanged(instanceListener)
    const stopLifecycle = stone.onAgentLifecycleChanged(lifecycleListener)
    const instanceHandler = electron.on.mock.calls.find(([channel]) => channel === 'stone:managed-client-instances')?.[1]
    const lifecycleHandler = electron.on.mock.calls.find(([channel]) => channel === 'stone:agent-lifecycle-changed')?.[1]
    instanceHandler({}, [{ id: 'instance-1' }])
    lifecycleHandler({}, { snapshot: { revision: 4 } })
    stopInstances()
    stopLifecycle()

    expect(instanceListener).toHaveBeenCalledWith([{ id: 'instance-1' }])
    expect(lifecycleListener).toHaveBeenCalledWith({ snapshot: { revision: 4 } })
    expect(electron.removeListener).toHaveBeenCalledWith('stone:managed-client-instances', instanceHandler)
    expect(electron.removeListener).toHaveBeenCalledWith('stone:agent-lifecycle-changed', lifecycleHandler)
  })

  it('wires cancellable Codex session scans and progress without changing legacy argument order', async () => {
    electron.invoke.mockResolvedValue({})
    await import('../../src/preload/index')
    const stone = exposedStone()
    const listener = vi.fn()

    await stone.analyzeCodexSessionRepair('stone', 'scan-operation-1234')
    await stone.previewCodexSessionRepair('stone', 'preview-operation-1234')
    await stone.repairCodexSessions('stone', 'a'.repeat(64), 'repair-operation-1234')
    await stone.repairCodexSessionsAndRestartChatGpt('stone', undefined, 'restart-operation-1234')
    await stone.cancelCodexSessionRepair('restart-operation-1234')
    const unsubscribe = stone.onCodexSessionRepairProgress(listener)
    const handler = electron.on.mock.calls.find(([channel]) => channel === 'stone:codex-session-repair-progress')?.[1]
    const progress = { operationId: 'scan-operation-1234', stage: 'scan', completed: 2, total: 8 }
    handler({}, progress)
    unsubscribe()

    expect(electron.invoke.mock.calls).toEqual([
      ['stone:analyze-codex-session-repair', 'stone', 'scan-operation-1234'],
      ['stone:preview-codex-session-repair', 'stone', 'preview-operation-1234'],
      ['stone:repair-codex-sessions', 'stone', 'a'.repeat(64), 'repair-operation-1234'],
      ['stone:repair-codex-sessions-and-restart-chatgpt', 'stone', undefined, 'restart-operation-1234'],
      ['stone:cancel-codex-session-repair', 'restart-operation-1234'],
    ])
    expect(listener).toHaveBeenCalledWith(progress)
    expect(electron.removeListener).toHaveBeenCalledWith('stone:codex-session-repair-progress', handler)
  })
})

function exposedStone(): GatewayApi {
  const stone = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'stone')?.[1]
  if (!stone) throw new Error('Preload did not expose the Stone API.')
  return stone as GatewayApi
}
