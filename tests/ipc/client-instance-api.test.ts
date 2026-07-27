import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerClientInstanceApi } from '../../src/main/ipc/client-instance-api'
import type { ClientInstanceManager } from '../../src/main/client-instances'
import type { AppStore } from '../../src/main/store/app-store'

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
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: electron.send } },
      { isDestroyed: () => true, webContents: { send: electron.send } },
    ]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
    removeHandler: electron.removeHandler,
  },
}))

describe('managed client instance IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    electron.send.mockReset()
    electron.removeHandler.mockClear()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('dispatches every managed-client operation with normalized identifiers', async () => {
    const { manager, store } = createHarness()
    registerClientInstanceApi(manager, store)
    const input = {
      id: ' instance-1 ',
      name: 'Codex worktree',
      client: 'codex',
      configDirectory: 'D:\\config',
      workingDirectory: 'D:\\work',
      executablePath: 'C:\\bin\\codex.exe',
      launchArgs: ['--resume'],
      launchMode: 'terminal',
      routeId: ' route-1 ',
      profileId: ' profile-1 ',
    }

    await invoke('stone:list-managed-client-instances')
    await invoke('stone:save-managed-client-instance', input)
    await invoke('stone:start-managed-client-instance', ' instance-1 ')
    await invoke('stone:stop-managed-client-instance', ' instance-1 ')
    await invoke('stone:delete-managed-client-instance', ' instance-1 ')

    expect(manager.list).toHaveBeenCalledOnce()
    expect(manager.save).toHaveBeenCalledWith({
      ...input,
      id: 'instance-1',
      routeId: 'route-1',
      profileId: 'profile-1',
    })
    expect(manager.start).toHaveBeenCalledWith('instance-1')
    expect(manager.stop).toHaveBeenCalledWith('instance-1')
    expect(manager.delete).toHaveBeenCalledWith('instance-1')
  })

  it('rejects malformed or widened payloads before reaching the manager', async () => {
    const { manager, store } = createHarness()
    registerClientInstanceApi(manager, store)

    await expect(invoke('stone:save-managed-client-instance', undefined)).rejects.toThrow('Invalid managed client instance input')
    await expect(invoke('stone:save-managed-client-instance', {
      name: 'Injected', client: 'codex', configDirectory: 'D:\\config', command: 'powershell',
    })).rejects.toThrow('Invalid managed client instance input')
    await expect(invoke('stone:save-managed-client-instance', {
      name: 'Bad args', client: 'codex', configDirectory: 'D:\\config', launchArgs: ['ok', 3],
    })).rejects.toThrow('Invalid managed client launch arguments')
    await expect(invoke('stone:start-managed-client-instance', '   ')).rejects.toThrow('Invalid managed client instance identifier')
    await expect(invoke('stone:delete-managed-client-instance', { id: 'instance-1' })).rejects.toThrow('Invalid managed client instance identifier')

    expect(manager.save).not.toHaveBeenCalled()
    expect(manager.start).not.toHaveBeenCalled()
    expect(manager.delete).not.toHaveBeenCalled()
  })

  it('validates route and profile ownership at the IPC boundary', async () => {
    const { manager, store } = createHarness()
    registerClientInstanceApi(manager, store)
    const base = { name: 'Instance', client: 'codex', configDirectory: 'D:\\config' }

    await expect(invoke('stone:save-managed-client-instance', { ...base, routeId: 'missing' })).rejects.toThrow('Bound client route not found')
    await expect(invoke('stone:save-managed-client-instance', { ...base, routeId: 'claude-route' })).rejects.toThrow('Bound route does not match')
    await expect(invoke('stone:save-managed-client-instance', { ...base, profileId: 'claude-profile' })).rejects.toThrow('Bound profile does not match')

    expect(manager.save).not.toHaveBeenCalled()
  })

  it('pushes changes and disposal unsubscribes, removes handlers, and drains accepted work', async () => {
    let listener: ((instances: unknown[]) => void) | undefined
    const unsubscribe = vi.fn()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const { manager, store } = createHarness()
    manager.onChange = vi.fn((next) => {
      listener = next as (instances: unknown[]) => void
      return unsubscribe
    })
    manager.start = vi.fn(() => pending.then(() => []))
    const dispose = registerClientInstanceApi(manager, store)

    listener?.([{ id: 'instance-1' }])
    const operation = invoke('stone:start-managed-client-instance', 'instance-1')
    await vi.waitFor(() => expect(manager.start).toHaveBeenCalledOnce())
    let disposed = false
    const disposing = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(electron.send).toHaveBeenCalledWith('stone:managed-client-instances', [{ id: 'instance-1' }])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)

    finish()
    await Promise.all([operation, disposing, dispose()])
    listener?.([{ id: 'late' }])
    expect(disposed).toBe(true)
    expect(electron.send).toHaveBeenCalledTimes(1)
  })
})

function createHarness(): { manager: ClientInstanceManager; store: AppStore } {
  const manager = {
    onChange: vi.fn(() => vi.fn()),
    list: vi.fn(() => []),
    save: vi.fn(async () => []),
    delete: vi.fn(async () => []),
    start: vi.fn(async () => []),
    stop: vi.fn(async () => []),
  } as unknown as ClientInstanceManager
  const store = {
    getSnapshot: vi.fn(() => ({
      routes: [
        { id: 'route-1', client: 'codex' },
        { id: 'claude-route', client: 'claude' },
      ],
      clientProfiles: [
        { id: 'profile-1', client: 'codex' },
        { id: 'claude-profile', client: 'claude' },
      ],
    })),
  } as unknown as AppStore
  return { manager, store }
}

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(trustedEvent(), ...args)
}
