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
    const port = { open: vi.fn() } satisfies RequestMonitorWindowPort
    registerRequestMonitorApi(port)

    await expect(invoke(trustedEvent())).resolves.toBeUndefined()
    expect(port.open).toHaveBeenCalledOnce()
  })

  it('rejects untrusted senders and renderer arguments', async () => {
    const port = { open: vi.fn() } satisfies RequestMonitorWindowPort
    registerRequestMonitorApi(port)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke({ senderFrame: mainFrame, sender: { mainFrame } })).rejects.toThrow('untrusted origin')
    await expect(invoke(trustedEvent(), { url: 'https://evil.example' })).rejects.toThrow('does not accept renderer arguments')
    expect(port.open).not.toHaveBeenCalled()
  })

  it('removes the handler during shutdown', async () => {
    const dispose = registerRequestMonitorApi({ open: vi.fn() })
    dispose()
    expect(electron.handlers.size).toBe(0)
    expect(electron.removeHandler).toHaveBeenCalledWith('stone:open-request-monitor')
  })
})

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get('stone:open-request-monitor')
  if (!handler) throw new Error('Missing request monitor IPC handler.')
  return await handler(event, ...args)
}
