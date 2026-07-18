import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCodexSessionRepairApi } from '../../src/main/ipc/session-repair-api'
import type { CodexSessionRepairService } from '../../src/main/codex'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
  },
}))

describe('Codex session repair IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('exposes fixed inspect, preview, and repair operations to the trusted main frame', async () => {
    const service = {
      inspect: vi.fn(async () => ({ currentProvider: 'stone' })),
      preview: vi.fn(async () => ({ targetProvider: 'stone', revision: 'a'.repeat(64) })),
      repair: vi.fn(async () => ({ targetProvider: 'stone', repairedRolloutFiles: 2 })),
    } as unknown as CodexSessionRepairService
    registerCodexSessionRepairApi(service)
    const event = trustedEvent()

    await invoke('stone:inspect-codex-session-repair', event)
    await invoke('stone:preview-codex-session-repair', event, 'stone')
    await invoke('stone:repair-codex-sessions', event, 'stone', 'a'.repeat(64))

    expect(service.inspect).toHaveBeenCalledOnce()
    expect(service.preview).toHaveBeenCalledWith('stone')
    expect(service.repair).toHaveBeenCalledWith('stone', 'a'.repeat(64))
  })

  it('rejects calls from an untrusted renderer', async () => {
    const service = { inspect: vi.fn() } as unknown as CodexSessionRepairService
    registerCodexSessionRepairApi(service)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke('stone:inspect-codex-session-repair', { senderFrame: mainFrame, sender: { mainFrame } }))
      .rejects.toThrow('untrusted origin')
    expect(service.inspect).not.toHaveBeenCalled()
  })
})

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}
