import { BrowserWindow, Menu, nativeImage, nativeTheme, screen, type WebContents } from 'electron'
import {
  constrainRequestMonitorBounds,
  defaultRequestMonitorWindowState,
  type RequestMonitorWindowState,
  type RequestMonitorWindowStateStore,
} from './request-monitor-window-state'
import { windowChromePalette } from './window-chrome'

const requestMonitorOpacityOptions = [1, 0.9, 0.8, 0.7, 0.6] as const

export interface RequestMonitorWindowOptions {
  preloadPath: string
  rendererTarget: string
  iconPath: string
  windowsAppUserModelId?: string
  showMainWindow: () => void
  stateStore?: RequestMonitorWindowStateStore
}

export class RequestMonitorWindowController {
  private monitorWindow?: BrowserWindow
  private readonly state: RequestMonitorWindowState
  private persistTimer?: ReturnType<typeof setTimeout>
  private dragTimer?: ReturnType<typeof setInterval>
  private dragWindow?: BrowserWindow
  private shuttingDown = false

  constructor(private readonly options: RequestMonitorWindowOptions) {
    this.state = options.stateStore?.load() ?? defaultRequestMonitorWindowState()
  }

  restore(): void {
    if (this.state.isOpen) this.open()
  }

  open(): void {
    const existing = this.monitorWindow
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      this.persistWindowState(existing, true)
      return
    }

    const chrome = windowChromePalette(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    const restoredBounds = this.state.x === undefined || this.state.y === undefined
      ? { width: this.state.width, height: this.state.height }
      : constrainRequestMonitorBounds(this.state, screen.getAllDisplays().map((display) => display.workArea))
    const monitor = new BrowserWindow({
      ...restoredBounds,
      minWidth: 180,
      minHeight: 90,
      show: false,
      alwaysOnTop: this.state.alwaysOnTop,
      opacity: this.state.opacity,
      frame: false,
      skipTaskbar: true,
      backgroundColor: chrome.background,
      icon: this.options.iconPath,
      title: 'Stone+ Request Monitor',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
      },
    })
    this.monitorWindow = monitor

    if (process.platform === 'win32') {
      const icon = nativeImage.createFromPath(this.options.iconPath)
      if (!icon.isEmpty()) monitor.setIcon(icon)
      if (this.options.windowsAppUserModelId) {
        monitor.setAppDetails({
          appId: this.options.windowsAppUserModelId,
          appIconPath: this.options.iconPath,
          appIconIndex: 0,
        })
      }
    }

    monitor.setMenuBarVisibility(false)
    const target = requestMonitorTarget(this.options.rendererTarget)
    monitor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const showContextMenu = () => {
      if (monitor.isDestroyed()) return
      Menu.buildFromTemplate([
        { label: '显示主程序', click: this.options.showMainWindow },
        {
          label: '透明度',
          submenu: requestMonitorOpacityOptions.map((opacity) => ({
            label: `${Math.round(opacity * 100)}%`,
            type: 'radio' as const,
            checked: Math.abs(monitor.getOpacity() - opacity) < 0.01,
            click: () => {
              if (!monitor.isDestroyed()) {
                monitor.setOpacity(opacity)
                this.persistWindowState(monitor, true)
              }
            },
          })),
        },
        { type: 'separator' },
        { label: '关闭浮窗', click: () => {
          if (!monitor.isDestroyed()) monitor.close()
        } },
      ]).popup({ window: monitor })
    }
    monitor.webContents.on('context-menu', (event) => {
      event.preventDefault()
      showContextMenu()
    })
    monitor.on('system-context-menu', (event) => {
      event.preventDefault()
      setImmediate(showContextMenu)
    })
    monitor.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl !== target) event.preventDefault()
    })
    monitor.once('ready-to-show', () => {
      if (!monitor.isDestroyed()) monitor.show()
    })
    monitor.on('move', () => this.schedulePersistWindowState(monitor))
    monitor.on('resize', () => this.schedulePersistWindowState(monitor))
    monitor.on('close', () => {
      if (!this.shuttingDown) this.persistWindowState(monitor, false)
    })
    monitor.on('closed', () => {
      this.stopDragging()
      this.clearPersistTimer()
      if (this.monitorWindow === monitor) this.monitorWindow = undefined
    })
    this.persistWindowState(monitor, true)
    void monitor.loadURL(target)
  }

  getAlwaysOnTop(sender: WebContents): boolean {
    return this.ownedWindow(sender).isAlwaysOnTop()
  }

  toggleAlwaysOnTop(sender: WebContents): boolean {
    const monitor = this.ownedWindow(sender)
    const next = !monitor.isAlwaysOnTop()
    monitor.setAlwaysOnTop(next)
    this.persistWindowState(monitor, true)
    return next
  }

  setDragging(sender: WebContents, active: boolean): void {
    const monitor = this.ownedWindow(sender)
    if (!active) {
      this.stopDragging(monitor)
      this.persistWindowState(monitor, true)
      return
    }

    this.stopDragging()
    const startCursor = screen.getCursorScreenPoint()
    const startBounds = monitor.getBounds()
    let lastX = startBounds.x
    let lastY = startBounds.y
    this.dragWindow = monitor
    this.dragTimer = setInterval(() => {
      if (monitor.isDestroyed() || this.dragWindow !== monitor) {
        this.stopDragging()
        return
      }
      const cursor = screen.getCursorScreenPoint()
      const x = startBounds.x + cursor.x - startCursor.x
      const y = startBounds.y + cursor.y - startCursor.y
      if (x === lastX && y === lastY) return
      lastX = x
      lastY = y
      // Repeated setPosition() calls can make a frameless resizable window's
      // outer bounds drift on Windows at non-100% DPI. Move with the original
      // complete bounds so holding the pointer can never accumulate frame
      // metrics into the monitor's width or height.
      monitor.setBounds({ x, y, width: startBounds.width, height: startBounds.height }, false)
    }, 16)
    this.dragTimer.unref?.()
  }

  dispose(): void {
    const monitor = this.monitorWindow
    this.stopDragging()
    this.clearPersistTimer()
    if (monitor && !monitor.isDestroyed()) this.persistWindowState(monitor, true)
    this.shuttingDown = true
    this.monitorWindow = undefined
    if (monitor && !monitor.isDestroyed()) monitor.destroy()
    this.shuttingDown = false
  }

  private ownedWindow(sender: WebContents): BrowserWindow {
    const monitor = this.monitorWindow
    if (!monitor || monitor.isDestroyed() || monitor.webContents !== sender) {
      throw new Error('Request monitor control is only available from the monitor window.')
    }
    return monitor
  }

  private schedulePersistWindowState(monitor: BrowserWindow): void {
    this.clearPersistTimer()
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      if (this.monitorWindow === monitor && !monitor.isDestroyed()) this.persistWindowState(monitor, true)
    }, 250)
    this.persistTimer.unref?.()
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
  }

  private stopDragging(expectedWindow?: BrowserWindow): void {
    if (expectedWindow && this.dragWindow && this.dragWindow !== expectedWindow) return
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = undefined
    this.dragWindow = undefined
  }

  private persistWindowState(monitor: BrowserWindow, isOpen: boolean): void {
    if (monitor.isDestroyed()) return
    const bounds = monitor.getBounds()
    Object.assign(this.state, {
      isOpen,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: monitor.isAlwaysOnTop(),
      opacity: monitor.getOpacity(),
    })
    try {
      this.options.stateStore?.save(this.state)
    } catch (error) {
      console.warn('[request-monitor] Could not persist window state.', error)
    }
  }
}

export function requestMonitorTarget(rendererTarget: string): string {
  const target = new URL(rendererTarget)
  target.searchParams.set('surface', 'request-monitor')
  target.hash = ''
  return target.toString()
}
