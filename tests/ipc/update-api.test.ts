import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../src/shared/types'
import { registerUpdateApi } from '../../src/main/ipc/update-api'
import type { UpdateService } from '../../src/main/update'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: electron.send } }])
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler))
  }
}))

const availableState: AppUpdateState = {
  revision: 3,
  currentVersion: '0.8.0',
  status: 'available',
  automaticUpdateSupported: true,
  release: {
    version: '0.8.1',
    tagName: 'v0.8.1',
    title: 'Stone v0.8.1',
    notes: 'Changes',
    publishedAt: '2026-07-13T00:00:00Z',
    url: 'https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.1'
  }
}

describe('update IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.send.mockReset()
    electron.fromWebContents.mockReturnValue({})
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('exposes only fixed update operations and publishes state events', async () => {
    let subscriber: ((state: AppUpdateState) => void) | undefined
    const service = {
      subscribe: vi.fn((listener: (state: AppUpdateState) => void) => {
        subscriber = listener
        return () => undefined
      }),
      getState: vi.fn(() => availableState),
      checkForUpdates: vi.fn(async () => availableState),
      ignoreUpdate: vi.fn(async () => ({ ...availableState, ignoredVersion: '0.8.1' })),
      downloadUpdate: vi.fn(async () => ({ ...availableState, status: 'downloading' })),
      installUpdate: vi.fn(async () => undefined),
      openUpdatePage: vi.fn(async () => undefined),
      openProjectPage: vi.fn(async () => undefined)
    } as unknown as UpdateService
    registerUpdateApi(service)
    const event = trustedEvent()

    expect(await invoke('stone:get-update-state', event)).toEqual(availableState)
    expect(await invoke('stone:check-for-updates', event)).toEqual(availableState)
    await invoke('stone:ignore-update', event, '0.8.1')
    await invoke('stone:download-update', event)
    await invoke('stone:install-update', event)
    await invoke('stone:open-update-page', event)
    await invoke('stone:open-project-page', event, 'license')

    expect(service.ignoreUpdate).toHaveBeenCalledWith('0.8.1')
    expect(service.installUpdate).toHaveBeenCalledOnce()
    expect(service.openProjectPage).toHaveBeenCalledWith('license')
    subscriber?.(availableState)
    expect(electron.send).toHaveBeenCalledWith('stone:update-state', availableState)
  })

  it('rejects update commands from a subframe or untrusted origin', async () => {
    const service = {
      subscribe: vi.fn(() => () => undefined),
      getState: vi.fn(() => availableState)
    } as unknown as UpdateService
    registerUpdateApi(service)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke('stone:get-update-state', { senderFrame: mainFrame, sender: { mainFrame } }))
      .rejects.toThrow('untrusted origin')
    const trustedMainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    await expect(invoke('stone:get-update-state', {
      senderFrame: { url: trustedMainFrame.url },
      sender: { mainFrame: trustedMainFrame }
    })).rejects.toThrow('untrusted frame')
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
