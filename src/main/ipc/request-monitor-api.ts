import { ipcMain, type WebContents } from 'electron'
import { assertTrustedSender } from './trusted-sender'

const openRequestMonitorChannel = 'stone:open-request-monitor'
const getRequestMonitorAlwaysOnTopChannel = 'stone:get-request-monitor-always-on-top'
const toggleRequestMonitorAlwaysOnTopChannel = 'stone:toggle-request-monitor-always-on-top'
const setRequestMonitorDraggingChannel = 'stone:set-request-monitor-dragging'

export interface RequestMonitorWindowPort {
  open(): void | Promise<void>
  getAlwaysOnTop(sender: WebContents): boolean | Promise<boolean>
  toggleAlwaysOnTop(sender: WebContents): boolean | Promise<boolean>
  setDragging(sender: WebContents, active: boolean): void | Promise<void>
}

/**
 * Exposes one argument-free command. Renderer input never controls a URL,
 * preload, window option, or navigation target.
 */
export function registerRequestMonitorApi(port: RequestMonitorWindowPort): () => void {
  ipcMain.handle(openRequestMonitorChannel, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (args.length !== 0) throw new Error('Request monitor does not accept renderer arguments.')
    return port.open()
  })

  ipcMain.handle(toggleRequestMonitorAlwaysOnTopChannel, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (args.length !== 0) throw new Error('Request monitor pin control does not accept renderer arguments.')
    return port.toggleAlwaysOnTop(event.sender)
  })

  ipcMain.handle(getRequestMonitorAlwaysOnTopChannel, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (args.length !== 0) throw new Error('Request monitor state does not accept renderer arguments.')
    return port.getAlwaysOnTop(event.sender)
  })

  ipcMain.handle(setRequestMonitorDraggingChannel, (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    if (args.length !== 1 || typeof args[0] !== 'boolean') {
      throw new Error('Request monitor drag control accepts one boolean argument.')
    }
    return port.setDragging(event.sender, args[0])
  })

  return () => {
    ipcMain.removeHandler(openRequestMonitorChannel)
    ipcMain.removeHandler(getRequestMonitorAlwaysOnTopChannel)
    ipcMain.removeHandler(toggleRequestMonitorAlwaysOnTopChannel)
    ipcMain.removeHandler(setRequestMonitorDraggingChannel)
  }
}
