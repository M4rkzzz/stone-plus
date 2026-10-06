import { ipcMain } from 'electron'
import type { PersistentTaskRunner } from '../tasks'
import { assertTrustedSender } from './trusted-sender'

export function registerPersistentTaskApi(runner: PersistentTaskRunner): void {
  ipcMain.handle('stone:list-persistent-tasks', (event) => { assertTrustedSender(event); return runner.list() })
  ipcMain.handle('stone:pause-persistent-task', (event, id: string) => { assertTrustedSender(event); return runner.pause(id) })
  ipcMain.handle('stone:resume-persistent-task', (event, id: string) => { assertTrustedSender(event); return runner.resume(id) })
  ipcMain.handle('stone:wait-for-persistent-task', (event, id: string) => { assertTrustedSender(event); return runner.waitForCompletion(id) })
  ipcMain.handle('stone:cancel-persistent-task', (event, id: string) => { assertTrustedSender(event); return runner.cancel(id) })
  ipcMain.handle('stone:clear-persistent-tasks', (event) => { assertTrustedSender(event); return runner.clearTerminalTasks() })
}
