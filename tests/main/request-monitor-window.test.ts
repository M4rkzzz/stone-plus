import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestMonitorWindowController, requestMonitorTarget } from '../../src/main/request-monitor-window'

const electron = vi.hoisted(() => {
  const menus: Array<{ template: Array<Record<string, unknown>>; popup: ReturnType<typeof vi.fn> }> = []
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    options: Record<string, unknown>
    destroyed = false
    minimized = false
    shown = false
    focused = false
    loadedUrl = ''
    listeners = new Map<string, (...args: unknown[]) => void>()
    webContents = {
      navigationListener: undefined as ((event: { preventDefault(): void }, url: string) => void) | undefined,
      contextMenuListener: undefined as (() => void) | undefined,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: ((event: { preventDefault(): void }, url: string) => void) | (() => void)) => {
        if (event === 'will-navigate') this.webContents.navigationListener = listener
        if (event === 'context-menu') this.webContents.contextMenuListener = listener as () => void
      }),
    }
    setMenuBarVisibility = vi.fn()
    setIcon = vi.fn()
    setAppDetails = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false }
    show() { this.shown = true }
    focus() { this.focused = true }
    destroy() { this.destroyed = true; this.listeners.get('closed')?.() }
    close() { this.destroy() }
    once(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener) }
    on(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener) }
    async loadURL(url: string) { this.loadedUrl = url }
  }

  return { FakeBrowserWindow, menus }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  Menu: {
    buildFromTemplate: vi.fn((template: Array<Record<string, unknown>>) => {
      const menu = { template, popup: vi.fn() }
      electron.menus.push(menu)
      return menu
    }),
  },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  nativeTheme: { shouldUseDarkColors: false },
}))

describe('request monitor window', () => {
  beforeEach(() => {
    electron.FakeBrowserWindow.instances.length = 0
    electron.menus.length = 0
  })

  it('opens one compact always-on-top trusted renderer surface and reuses it', () => {
    const controller = new RequestMonitorWindowController({
      preloadPath: 'D:\\app\\preload.cjs',
      rendererTarget: 'file:///D:/app/index.html',
      iconPath: 'D:\\app\\icon.ico',
      windowsAppUserModelId: 'stone.test',
      showMainWindow: vi.fn(),
    })

    controller.open()
    controller.open()

    expect(electron.FakeBrowserWindow.instances).toHaveLength(1)
    const window = electron.FakeBrowserWindow.instances[0]
    expect(window.options).toMatchObject({
      width: 220,
      height: 190,
      minWidth: 180,
      minHeight: 90,
      alwaysOnTop: true,
      frame: false,
      skipTaskbar: true,
      show: false,
      webPreferences: expect.objectContaining({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false }),
    })
    expect(window.loadedUrl).toBe('file:///D:/app/index.html?surface=request-monitor')
    expect(window.focused).toBe(true)
    expect(window.options).not.toHaveProperty('titleBarOverlay')
  })

  it('blocks navigation away from the monitor and can dispose the owned window', () => {
    const controller = new RequestMonitorWindowController({
      preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(),
    })
    controller.open()
    const window = electron.FakeBrowserWindow.instances[0]
    const preventDefault = vi.fn()

    window.webContents.navigationListener?.({ preventDefault }, 'https://evil.example/')
    expect(preventDefault).toHaveBeenCalledOnce()
    controller.dispose()
    expect(window.destroyed).toBe(true)
  })

  it('opens a right-click menu that can reveal the main window or close only the monitor', () => {
    const showMainWindow = vi.fn()
    const controller = new RequestMonitorWindowController({
      preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow,
    })
    controller.open()
    const window = electron.FakeBrowserWindow.instances[0]

    window.webContents.contextMenuListener?.()
    expect(electron.menus).toHaveLength(1)
    const menu = electron.menus[0]
    expect(menu.popup).toHaveBeenCalledWith({ window })
    expect(menu.template.map((item) => item.label ?? item.type)).toEqual(['显示主程序', 'separator', '关闭浮窗'])

    const reveal = menu.template[0]?.click as (() => void) | undefined
    reveal?.()
    expect(showMainWindow).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)

    const close = menu.template[2]?.click as (() => void) | undefined
    close?.()
    expect(window.destroyed).toBe(true)
  })

  it('normalizes the dedicated surface query and removes inherited hashes', () => {
    expect(requestMonitorTarget('http://127.0.0.1:5173/?demo=1#requests'))
      .toBe('http://127.0.0.1:5173/?demo=1&surface=request-monitor')
  })
})
