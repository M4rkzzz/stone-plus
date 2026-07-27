import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerClaudeDesktopApi,
  type ClaudeDesktopOfficialModeRestorePort,
} from '../../src/main/ipc/claude-desktop-api'

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

describe('Claude Desktop IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    electron.removeHandler.mockClear()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('restores official mode through a fixed, argument-free channel and strips main-only fields', async () => {
    const rollback = vi.fn(async () => undefined)
    const port = {
      restoreOfficial: vi.fn(async () => ({ changed: true, rollback })),
    } satisfies ClaudeDesktopOfficialModeRestorePort
    registerClaudeDesktopApi(port)

    const result = await invoke(trustedEvent())

    expect(result).toEqual({ changed: true })
    expect(port.restoreOfficial).toHaveBeenCalledOnce()
    expect(result).not.toHaveProperty('rollback')
  })

  it('rejects untrusted senders and all renderer-controlled arguments before restoring', async () => {
    const port = createPort()
    registerClaudeDesktopApi(port)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke({ senderFrame: mainFrame, sender: { mainFrame } }))
      .rejects.toThrow('untrusted origin')
    await expect(invoke(trustedEvent(), { token: 'renderer-secret', path: 'C:\\unsafe' }))
      .rejects.toThrow('does not accept renderer arguments')
    await expect(invoke(trustedEvent(), undefined))
      .rejects.toThrow('does not accept renderer arguments')

    expect(port.restoreOfficial).not.toHaveBeenCalled()
  })

  it('rejects malformed service results rather than exposing them to the renderer', async () => {
    const port = {
      restoreOfficial: vi.fn(async () => ({ changed: 'yes' })),
    } as unknown as ClaudeDesktopOfficialModeRestorePort
    registerClaudeDesktopApi(port)

    await expect(invoke(trustedEvent())).rejects.toThrow('returned an invalid result')
  })

  it('removes the fixed handler and drains an accepted restore during disposal', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const port = {
      restoreOfficial: vi.fn(async () => {
        await pending
        return { changed: false }
      }),
    } satisfies ClaudeDesktopOfficialModeRestorePort
    const dispose = registerClaudeDesktopApi(port)
    const operation = invoke(trustedEvent())
    await vi.waitFor(() => expect(port.restoreOfficial).toHaveBeenCalledOnce())

    let disposed = false
    const disposing = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(electron.handlers.size).toBe(0)

    finish()
    await Promise.all([operation, disposing, dispose()])
    expect(disposed).toBe(true)
    expect(electron.removeHandler).toHaveBeenCalledOnce()
  })
})

function createPort(): ClaudeDesktopOfficialModeRestorePort {
  return { restoreOfficial: vi.fn(async () => ({ changed: false })) }
}

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get('stone:restore-claude-desktop-official-mode')
  if (!handler) throw new Error('Missing Claude Desktop IPC handler.')
  return await handler(event, ...args)
}
