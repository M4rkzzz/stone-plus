import { ipcMain } from 'electron'
import { assertTrustedSender } from './trusted-sender'

const openRequestMonitorChannel = 'stone:open-request-monitor'

export interface RequestMonitorWindowPort {
  open(): void | Promise<void>
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

  return () => ipcMain.removeHandler(openRequestMonitorChannel)
}
