import { BrowserWindow, ipcMain } from 'electron'
import type { AppUpdateState, ProjectPage } from '@shared/types'
import type { UpdateService } from '../update'
import { assertTrustedSender } from './trusted-sender'

export function registerUpdateApi(service: UpdateService): void {
  const publish = (state: AppUpdateState): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:update-state', state)
    }
  }

  service.subscribe(publish)

  ipcMain.handle('stone:get-update-state', (event) => {
    assertTrustedSender(event)
    return service.getState()
  })
  ipcMain.handle('stone:check-for-updates', (event) => {
    assertTrustedSender(event)
    return service.checkForUpdates()
  })
  ipcMain.handle('stone:ignore-update', (event, version: string) => {
    assertTrustedSender(event)
    return service.ignoreUpdate(version)
  })
  ipcMain.handle('stone:download-update', (event) => {
    assertTrustedSender(event)
    return service.downloadUpdate()
  })
  ipcMain.handle('stone:install-update', async (event) => {
    assertTrustedSender(event)
    await service.installUpdate()
  })
  ipcMain.handle('stone:open-update-page', async (event) => {
    assertTrustedSender(event)
    await service.openUpdatePage()
  })
  ipcMain.handle('stone:open-project-page', async (event, page: ProjectPage) => {
    assertTrustedSender(event)
    await service.openProjectPage(page)
  })
}
