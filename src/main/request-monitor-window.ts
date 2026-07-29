import { BrowserWindow, Menu, nativeImage, nativeTheme } from 'electron'
import { windowChromePalette } from './window-chrome'

export interface RequestMonitorWindowOptions {
  preloadPath: string
  rendererTarget: string
  iconPath: string
  windowsAppUserModelId?: string
  showMainWindow: () => void
}

export class RequestMonitorWindowController {
  private monitorWindow?: BrowserWindow

  constructor(private readonly options: RequestMonitorWindowOptions) {}

  open(): void {
    const existing = this.monitorWindow
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }

    const chrome = windowChromePalette(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    const monitor = new BrowserWindow({
      width: 220,
      height: 190,
      minWidth: 180,
      minHeight: 90,
      show: false,
      alwaysOnTop: true,
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
    monitor.webContents.on('context-menu', () => {
      if (monitor.isDestroyed()) return
      Menu.buildFromTemplate([
        { label: '显示主程序', click: this.options.showMainWindow },
        { type: 'separator' },
        { label: '关闭浮窗', click: () => {
          if (!monitor.isDestroyed()) monitor.close()
        } },
      ]).popup({ window: monitor })
    })
    monitor.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl !== target) event.preventDefault()
    })
    monitor.once('ready-to-show', () => {
      if (!monitor.isDestroyed()) monitor.show()
    })
    monitor.on('closed', () => {
      if (this.monitorWindow === monitor) this.monitorWindow = undefined
    })
    void monitor.loadURL(target)
  }

  dispose(): void {
    const monitor = this.monitorWindow
    this.monitorWindow = undefined
    if (monitor && !monitor.isDestroyed()) monitor.destroy()
  }
}

export function requestMonitorTarget(rendererTarget: string): string {
  const target = new URL(rendererTarget)
  target.searchParams.set('surface', 'request-monitor')
  target.hash = ''
  return target.toString()
}
