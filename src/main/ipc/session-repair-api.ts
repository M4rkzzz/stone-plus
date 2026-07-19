import { ipcMain } from 'electron'
import type { CodexRepairAndRestartService, CodexSessionRepairService } from '../codex'
import { assertTrustedSender } from './trusted-sender'

export function registerCodexSessionRepairApi(
  service: CodexSessionRepairService,
  repairAndRestart: CodexRepairAndRestartService,
): void {
  ipcMain.handle('stone:inspect-codex-session-repair', (event) => {
    assertTrustedSender(event)
    return service.inspect()
  })
  ipcMain.handle('stone:preview-codex-session-repair', (event, targetProvider: string) => {
    assertTrustedSender(event)
    return service.preview(targetProvider)
  })
  ipcMain.handle('stone:repair-codex-sessions', (event, targetProvider: string, expectedRevision: string) => {
    assertTrustedSender(event)
    return service.repair(targetProvider, expectedRevision)
  })
  ipcMain.handle('stone:repair-codex-sessions-and-restart-chatgpt', (event) => {
    assertTrustedSender(event)
    return repairAndRestart.run()
  })
}
