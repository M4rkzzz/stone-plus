import { ipcMain } from 'electron'
import type { FrpTunnelService } from '../tunnel'
import { assertTrustedSender } from './trusted-sender'

export function registerTunnelApi(service: FrpTunnelService): void {
  ipcMain.handle('stone:get-frp-tunnel-state', (event) => {
    assertTrustedSender(event)
    return service.getState()
  })
  ipcMain.handle('stone:save-frp-tunnel-config', (event, content: string) => {
    assertTrustedSender(event)
    if (typeof content !== 'string') throw new Error('frpc configuration must be text.')
    return service.saveConfig(content)
  })
  ipcMain.handle('stone:start-frp-tunnel', (event) => {
    assertTrustedSender(event)
    return service.start()
  })
  ipcMain.handle('stone:stop-frp-tunnel', (event) => {
    assertTrustedSender(event)
    return service.stop()
  })
  ipcMain.handle('stone:clear-frp-tunnel-logs', (event) => {
    assertTrustedSender(event)
    return service.clearLogs()
  })
}
