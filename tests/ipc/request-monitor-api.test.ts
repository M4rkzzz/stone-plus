import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRequestMonitorApi, type RequestMonitorWindowPort } from '../../src/main/ipc/request-monitor-api'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
    removeHandler: electron.removeHandler,
  },
}))

describe('request monitor IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    electron.removeHandler.mockClear()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('opens the fixed monitor surface without renderer-controlled options', async () => {
    const port = requestMonitorPort()
    registerRequestMonitorApi(port)

    await expect(invoke('stone:open-request-monitor', trustedEvent())).resolves.toBeUndefined()
    expect(port.open).toHaveBeenCalledOnce()
  })

  it('delegates pin toggles with the invoking web contents', async () => {
    const port = requestMonitorPort()
    registerRequestMonitorApi(port)
    const event = trustedEvent()

    await expect(invoke('stone:toggle-request-monitor-always-on-top', event)).resolves.toBe(false)
    expect(port.toggleAlwaysOnTop).toHaveBeenCalledWith(event.sender)
  })

  it('reads the current pin state from the owned monitor window', async () => {
    const port = requestMonitorPort()
    registerRequestMonitorApi(port)
    const event = trustedEvent()

    await expect(invoke('stone:get-request-monitor-always-on-top', event)).resolves.toBe(true)
    expect(port.getAlwaysOnTop).toHaveBeenCalledWith(event.sender)
  })

  it('delegates bounded manual drag state only', async () => {
    const port = requestMonitorPort()
    registerRequestMonitorApi(port)
    const event = trustedEvent()

    await expect(invoke('stone:set-request-monitor-dragging', event, true)).resolves.toBeUndefined()
    await expect(invoke('stone:set-request-monitor-dragging', event, false)).resolves.toBeUndefined()
    expect(port.setDragging).toHaveBeenNthCalledWith(1, event.sender, true)
    expect(port.setDragging).toHaveBeenNthCalledWith(2, event.sender, false)
  })

  it('rejects untrusted senders and renderer arguments', async () => {
    const port = requestMonitorPort()
    registerRequestMonitorApi(port)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke('stone:open-request-monitor', { senderFrame: mainFrame, sender: { mainFrame } })).rejects.toThrow('untrusted origin')
    await expect(invoke('stone:open-request-monitor', trustedEvent(), { url: 'https://evil.example' })).rejects.toThrow('does not accept renderer arguments')
    await expect(invoke('stone:get-request-monitor-always-on-top', trustedEvent(), true)).rejects.toThrow('does not accept renderer arguments')
    await expect(invoke('stone:toggle-request-monitor-always-on-top', trustedEvent(), true)).rejects.toThrow('does not accept renderer arguments')
    await expect(invoke('stone:set-request-monitor-dragging', trustedEvent(), 'true')).rejects.toThrow('one boolean argument')
    expect(port.open).not.toHaveBeenCalled()
    expect(port.getAlwaysOnTop).not.toHaveBeenCalled()
    expect(port.toggleAlwaysOnTop).not.toHaveBeenCalled()
    expect(port.setDragging).not.toHaveBeenCalled()
  })

  it('removes the handler during shutdown', async () => {
    const dispose = registerRequestMonitorApi(requestMonitorPort())
    dispose()
    expect(electron.handlers.size).toBe(0)
    expect(electron.removeHandler).toHaveBeenCalledWith('stone:open-request-monitor')
    expect(electron.removeHandler).toHaveBeenCalledWith('stone:get-request-monitor-always-on-top')
    expect(electron.removeHandler).toHaveBeenCalledWith('stone:toggle-request-monitor-always-on-top')
    expect(electron.removeHandler).toHaveBeenCalledWith('stone:set-request-monitor-dragging')
  })
})

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

function requestMonitorPort() {
  return {
    open: vi.fn(),
    getAlwaysOnTop: vi.fn(() => true),
    toggleAlwaysOnTop: vi.fn(() => false),
    setDragging: vi.fn(),
  } satisfies RequestMonitorWindowPort
}

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error('Missing request monitor IPC handler.')
  return await handler(event, ...args)
}
