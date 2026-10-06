import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestMonitorWindowController, requestMonitorTarget } from '../../src/main/request-monitor-window'
import type { RequestMonitorWindowState, RequestMonitorWindowStateStore } from '../../src/main/request-monitor-window-state'

const electron = vi.hoisted(() => {
  const menus: Array<{ template: Array<Record<string, unknown>>; popup: ReturnType<typeof vi.fn> }> = []
  const displays = [{ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }]
  const cursor = { x: 100, y: 100 }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    options: Record<string, unknown>
    destroyed = false
    minimized = false
    shown = false
    focused = false
    alwaysOnTop = false
    opacity = 1
    bounds = { x: 0, y: 0, width: 220, height: 190 }
    loadedUrl = ''
    listeners = new Map<string, (...args: unknown[]) => void>()
    webContents = {
      navigationListener: undefined as ((event: { preventDefault(): void }, url: string) => void) | undefined,
      contextMenuListener: undefined as ((event: { preventDefault(): void }) => void) | undefined,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: ((event: { preventDefault(): void }, url: string) => void) | (() => void)) => {
        if (event === 'will-navigate') this.webContents.navigationListener = listener
        if (event === 'context-menu') this.webContents.contextMenuListener = listener as (event: { preventDefault(): void }) => void
      }),
    }
    setMenuBarVisibility = vi.fn()
    setIcon = vi.fn()
    setAppDetails = vi.fn()
    isAlwaysOnTop() { return this.alwaysOnTop }
    setAlwaysOnTop(value: boolean) { this.alwaysOnTop = value }
    getOpacity() { return this.opacity }
    setOpacity(value: number) { this.opacity = value }

    constructor(options: Record<string, unknown>) {
      this.options = options
      this.alwaysOnTop = options.alwaysOnTop === true
      this.opacity = typeof options.opacity === 'number' ? options.opacity : 1
      this.bounds = {
        x: typeof options.x === 'number' ? options.x : 0,
        y: typeof options.y === 'number' ? options.y : 0,
        width: typeof options.width === 'number' ? options.width : 220,
        height: typeof options.height === 'number' ? options.height : 190,
      }
      FakeBrowserWindow.instances.push(this)
    }

    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false }
    show() { this.shown = true }
    focus() { this.focused = true }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds } }
    // Models the Windows frameless-window drift seen when setPosition() is
    // called repeatedly at scaled DPI. Production drag code must use fixed
    // complete bounds instead.
    setPosition(x: number, y: number) {
      this.bounds = { x, y, width: this.bounds.width + 1, height: this.bounds.height + 1 }
    }
    destroy() { this.destroyed = true; this.listeners.get('closed')?.() }
    close() { this.listeners.get('close')?.(); this.destroy() }
    once(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener) }
    on(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener) }
    async loadURL(url: string) { this.loadedUrl = url }
  }

  return { FakeBrowserWindow, menus, displays, cursor }
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
  screen: {
    getAllDisplays: vi.fn(() => electron.displays),
    getCursorScreenPoint: vi.fn(() => ({ ...electron.cursor })),
  },
}))

describe('request monitor window', () => {
  beforeEach(() => {
    electron.FakeBrowserWindow.instances.length = 0
    electron.menus.length = 0
    electron.displays.splice(0, electron.displays.length, { workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } })
    Object.assign(electron.cursor, { x: 100, y: 100 })
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

  it('allows only the owned monitor renderer to toggle always-on-top', () => {
    const controller = new RequestMonitorWindowController({
      preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(),
    })
    controller.open()
    const window = electron.FakeBrowserWindow.instances[0]

    expect(controller.toggleAlwaysOnTop(window.webContents as never)).toBe(false)
    expect(window.alwaysOnTop).toBe(false)
    expect(controller.toggleAlwaysOnTop(window.webContents as never)).toBe(true)
    expect(window.alwaysOnTop).toBe(true)
    expect(() => controller.toggleAlwaysOnTop({} as never)).toThrow('only available from the monitor window')
  })

  it('manually drags the whole renderer surface without a native drag region', () => {
    vi.useFakeTimers()
    try {
      const controller = new RequestMonitorWindowController({
        preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(),
      })
      controller.open()
      const window = electron.FakeBrowserWindow.instances[0]
      window.setBounds({ x: 40, y: 60, width: 220, height: 190 })

      controller.setDragging(window.webContents as never, true)
      Object.assign(electron.cursor, { x: 145, y: 132 })
      vi.advanceTimersByTime(16)
      expect(window.getBounds()).toEqual({ x: 85, y: 92, width: 220, height: 190 })

      // Holding at the same point keeps both position and size stable instead
      // of applying another native move every animation tick.
      vi.advanceTimersByTime(160)
      expect(window.getBounds()).toEqual({ x: 85, y: 92, width: 220, height: 190 })

      controller.setDragging(window.webContents as never, false)
      Object.assign(electron.cursor, { x: 200, y: 200 })
      vi.advanceTimersByTime(32)
      expect(window.getBounds()).toEqual({ x: 85, y: 92, width: 220, height: 190 })
      expect(() => controller.setDragging({} as never, true)).toThrow('only available from the monitor window')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores and persists open state, bounds, pinning, opacity, and user-close intent', () => {
    vi.useFakeTimers()
    try {
      const stateStore = createStateStore({
        isOpen: true,
        x: 120,
        y: 140,
        width: 360,
        height: 260,
        alwaysOnTop: false,
        opacity: 0.8,
      })
      const controller = new RequestMonitorWindowController({
        preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(), stateStore,
      })

      controller.restore()
      const window = electron.FakeBrowserWindow.instances[0]
      expect(window.options).toMatchObject({ x: 120, y: 140, width: 360, height: 260, alwaysOnTop: false, opacity: 0.8 })
      expect(controller.getAlwaysOnTop(window.webContents as never)).toBe(false)

      window.setBounds({ x: 240, y: 180, width: 420, height: 300 })
      window.listeners.get('move')?.()
      window.listeners.get('resize')?.()
      vi.advanceTimersByTime(250)
      expect(stateStore.current()).toMatchObject({ isOpen: true, x: 240, y: 180, width: 420, height: 300 })

      window.webContents.contextMenuListener?.({ preventDefault: vi.fn() })
      const opacityItems = electron.menus.at(-1)?.template[1]?.submenu as Array<Record<string, unknown>>
      const useSixtyPercent = opacityItems[4]?.click as (() => void) | undefined
      useSixtyPercent?.()
      expect(stateStore.current()).toMatchObject({ opacity: 0.6 })

      expect(controller.toggleAlwaysOnTop(window.webContents as never)).toBe(true)
      expect(stateStore.current()).toMatchObject({ alwaysOnTop: true })

      window.close()
      expect(stateStore.current()).toMatchObject({ isOpen: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an open monitor eligible for restore during application shutdown', () => {
    const stateStore = createStateStore({
      isOpen: false, width: 220, height: 190, alwaysOnTop: true, opacity: 1,
    })
    const controller = new RequestMonitorWindowController({
      preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(), stateStore,
    })

    controller.open()
    controller.dispose()

    expect(stateStore.current().isOpen).toBe(true)
  })

  it('opens a right-click menu that controls opacity, reveals the main window, or closes only the monitor', () => {
    const showMainWindow = vi.fn()
    const controller = new RequestMonitorWindowController({
      preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow,
    })
    controller.open()
    const window = electron.FakeBrowserWindow.instances[0]
    const preventDefault = vi.fn()

    window.webContents.contextMenuListener?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(electron.menus).toHaveLength(1)
    const menu = electron.menus[0]
    expect(menu.popup).toHaveBeenCalledWith({ window })
    expect(menu.template.map((item) => item.label ?? item.type)).toEqual(['显示主程序', '透明度', 'separator', '关闭浮窗'])

    const reveal = menu.template[0]?.click as (() => void) | undefined
    reveal?.()
    expect(showMainWindow).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)

    const opacityItems = menu.template[1]?.submenu as Array<Record<string, unknown>>
    expect(opacityItems.map((item) => item.label)).toEqual(['100%', '90%', '80%', '70%', '60%'])
    expect(opacityItems[0]?.checked).toBe(true)
    const useSeventyPercent = opacityItems[3]?.click as (() => void) | undefined
    useSeventyPercent?.()
    expect(window.opacity).toBe(0.7)

    const close = menu.template[3]?.click as (() => void) | undefined
    close?.()
    expect(window.destroyed).toBe(true)
  })

  it('suppresses the Windows drag-region system menu and opens the Stone+ menu instead', () => {
    vi.useFakeTimers()
    try {
      const controller = new RequestMonitorWindowController({
        preloadPath: 'preload.cjs', rendererTarget: 'http://127.0.0.1:5173/', iconPath: 'icon.ico', showMainWindow: vi.fn(),
      })
      controller.open()
      const window = electron.FakeBrowserWindow.instances[0]
      const preventDefault = vi.fn()

      window.listeners.get('system-context-menu')?.({ preventDefault }, { x: 12, y: 24 })

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(electron.menus).toHaveLength(0)
      vi.runAllTimers()
      expect(electron.menus).toHaveLength(1)
      expect(electron.menus[0].template.map((item) => item.label ?? item.type))
        .toEqual(['显示主程序', '透明度', 'separator', '关闭浮窗'])
      expect(electron.menus[0].popup).toHaveBeenCalledWith({ window })
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes the dedicated surface query and removes inherited hashes', () => {
    expect(requestMonitorTarget('http://127.0.0.1:5173/?demo=1#requests'))
      .toBe('http://127.0.0.1:5173/?demo=1&surface=request-monitor')
  })
})

function createStateStore(initial: RequestMonitorWindowState): RequestMonitorWindowStateStore & { current(): RequestMonitorWindowState } {
  let state = { ...initial }
  return {
    load: vi.fn(() => ({ ...state })),
    save: vi.fn((next: RequestMonitorWindowState) => { state = { ...next } }),
    current: () => ({ ...state }),
  }
}
