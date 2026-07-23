import { BrowserWindow, ipcMain } from 'electron'
import type { ManagedClientInstanceInput } from '@shared/types'
import type { ClientInstanceManager } from '../client-instances'
import type { AppStore } from '../store/app-store'
import { assertTrustedSender } from './trusted-sender'

export function registerClientInstanceApi(manager: ClientInstanceManager, store: AppStore): void {
  manager.onChange((instances) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:managed-client-instances', instances)
    }
  })
  ipcMain.handle('stone:list-managed-client-instances', (event) => {
    assertTrustedSender(event)
    return manager.list()
  })
  ipcMain.handle('stone:save-managed-client-instance', (event, input: ManagedClientInstanceInput) => {
    assertTrustedSender(event)
    validateBindings(input, store)
    return manager.save(input)
  })
  ipcMain.handle('stone:delete-managed-client-instance', (event, id: string) => {
    assertTrustedSender(event)
    return manager.delete(id)
  })
  ipcMain.handle('stone:start-managed-client-instance', (event, id: string) => {
    assertTrustedSender(event)
    return manager.start(id)
  })
  ipcMain.handle('stone:stop-managed-client-instance', (event, id: string) => {
    assertTrustedSender(event)
    return manager.stop(id)
  })
}

function validateBindings(input: ManagedClientInstanceInput, store: AppStore): void {
  const snapshot = store.getSnapshot()
  if (input.routeId) {
    const route = snapshot.routes.find((candidate) => candidate.id === input.routeId)
    if (!route) throw new Error('Bound client route not found.')
    if (route.client !== input.client) throw new Error('Bound route does not match the client instance type.')
  }
  if (input.profileId) {
    const profile = snapshot.clientProfiles.find((candidate) => candidate.id === input.profileId)
    if (!profile) throw new Error('Bound client profile not found.')
    if (profile.client !== input.client) throw new Error('Bound profile does not match the client instance type.')
  }
}
