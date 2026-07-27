import { app, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { CodexSessionQuery } from '@shared/types'
import type { CodexSessionManager } from '../codex'
import { assertTrustedSender } from './trusted-sender'

export function registerCodexSessionManagerApi(manager: CodexSessionManager): void {
  ipcMain.handle('stone:list-codex-sessions', (event, query?: CodexSessionQuery) => {
    assertTrustedSender(event)
    return manager.list(query)
  })
  ipcMain.handle('stone:open-codex-session-location', async (event, id: string, expectedRevision: string) => {
    assertTrustedSender(event)
    shell.showItemInFolder(await manager.pathFor(id, expectedRevision))
  })
  ipcMain.handle('stone:export-codex-session', async (event, id: string, expectedRevision: string) => {
    assertTrustedSender(event)
    await manager.pathFor(id, expectedRevision)
    const chinese = app.getLocale().toLowerCase().startsWith('zh')
    const selection = await dialog.showSaveDialog({
      title: chinese ? '导出 Codex 会话' : 'Export Codex session',
      buttonLabel: chinese ? '导出' : 'Export',
      defaultPath: join(app.getPath('documents'), `codex-session-${id}.jsonl`),
      filters: [{ name: 'Codex rollout', extensions: ['jsonl'] }]
    })
    if (selection.canceled || !selection.filePath) return { cancelled: true, sessionId: id }
    await manager.export(id, expectedRevision, selection.filePath)
    return { cancelled: false, sessionId: id, filePath: selection.filePath }
  })
  ipcMain.handle('stone:trash-codex-session', (event, id: string, expectedRevision: string) => {
    assertTrustedSender(event)
    return manager.trash(id, expectedRevision)
  })
  ipcMain.handle('stone:restore-codex-session', (event, id: string, expectedRevision: string) => {
    assertTrustedSender(event)
    return manager.restore(id, expectedRevision)
  })
}
