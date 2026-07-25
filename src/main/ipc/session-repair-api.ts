import { BrowserWindow, ipcMain } from 'electron'
import type {
  ClientConfigProfile,
  CodexOfficialLoginRecoveryResult,
  CodexSessionRepairProgressEvent,
} from '@shared/types'
import type { CodexSessionRepairOperationOptions } from '../codex/session-repair-service'
import type { CodexRepairAndRestartService, CodexSessionIndexCleanupService, CodexSessionRepairService } from '../codex'
import type { ClientConfigService } from '../client-config'
import { assertTrustedSender } from './trusted-sender'

interface CodexOfficialLoginOptions {
  clientConfig: ClientConfigService
  clientProfiles: () => readonly ClientConfigProfile[]
}

export function registerCodexSessionRepairApi(
  service: CodexSessionRepairService,
  repairAndRestart: CodexRepairAndRestartService,
  officialLogin?: CodexOfficialLoginOptions,
  sessionIndexCleanup?: CodexSessionIndexCleanupService,
): void {
  const operations = new Map<string, AbortController>()
  ipcMain.handle('stone:inspect-codex-session-repair', (event) => {
    assertTrustedSender(event)
    return service.inspect()
  })
  ipcMain.handle('stone:analyze-codex-session-repair', (event, targetProvider?: string, operationId?: unknown) => {
    assertTrustedSender(event)
    return runOperation(operationId, (options) => options
      ? service.analyze(targetProvider, options)
      : service.analyze(targetProvider))
  })
  ipcMain.handle('stone:preview-codex-session-repair', (event, targetProvider: string, operationId?: unknown) => {
    assertTrustedSender(event)
    return runOperation(operationId, (options) => options
      ? service.preview(targetProvider, options)
      : service.preview(targetProvider))
  })
  ipcMain.handle('stone:repair-codex-sessions', async (event, targetProvider: string, expectedRevision: string, operationId?: unknown) => {
    assertTrustedSender(event)
    return (await runOperation(operationId, (options) => repairAndRestart.run({ targetProvider, expectedRevision, ...(options ?? {}) }))).repair
  })
  ipcMain.handle('stone:repair-codex-sessions-and-restart-chatgpt', (event, targetProvider?: string, expectedRevision?: string, operationId?: unknown) => {
    assertTrustedSender(event)
    return runOperation(operationId, (options) => repairAndRestart.run(targetProvider
      ? { targetProvider, expectedRevision, ...(options ?? {}) }
      : (options ?? {})))
  })
  ipcMain.handle('stone:cancel-codex-session-repair', (event, operationId: unknown) => {
    assertTrustedSender(event)
    const controller = operations.get(parseOperationId(operationId))
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  })
  ipcMain.handle('stone:preview-codex-session-index-cleanup', (event) => {
    assertTrustedSender(event)
    if (!sessionIndexCleanup) throw new Error('Codex session index cleanup is not available.')
    return sessionIndexCleanup.preview()
  })
  ipcMain.handle('stone:cleanup-codex-session-index-and-restart', (event, snapshotSha256: string, threadIds: string[]) => {
    assertTrustedSender(event)
    if (!sessionIndexCleanup) throw new Error('Codex session index cleanup is not available.')
    return repairAndRestart.cleanupSessionIndex(snapshotSha256, threadIds)
  })
  ipcMain.handle('stone:restore-codex-official-login-and-sessions', async (event, profileId?: string) => {
    assertTrustedSender(event)
    if (!officialLogin) throw new Error('Codex official login recovery is not available.')
    const profile = profileId
      ? officialLogin.clientProfiles().find((candidate) => candidate.id === profileId)
      : undefined
    if (profileId && !profile) throw new Error('Client configuration profile not found.')
    if (profile && profile.client !== 'codex') {
      throw new Error('Client configuration profile does not match Codex.')
    }
    const scoped = profile?.directory
      ? officialLogin.clientConfig.withOverrides({ codexDirectory: profile.directory })
      : officialLogin.clientConfig
    let clientConfig: Awaited<ReturnType<ClientConfigService['restoreCodexOfficialLogin']>> | undefined
    const restarted = await repairAndRestart.run({
      targetProvider: 'openai',
      beforeRepair: async () => {
        clientConfig = await scoped.restoreCodexOfficialLogin({
          backupRetention: profile?.backupRetention ?? 10,
        })
      },
    })
    if (!clientConfig) throw new Error('Codex official login configuration was not restored.')
    return { ...restarted, clientConfig } satisfies CodexOfficialLoginRecoveryResult
  })

  async function runOperation<T>(
    operationId: unknown,
    operation: (options?: CodexSessionRepairOperationOptions) => Promise<T>,
  ): Promise<T> {
    if (operationId === undefined) return operation()
    const id = parseOperationId(operationId)
    if (operations.has(id)) throw new Error('A Codex session repair operation with this identifier is already running.')
    const controller = new AbortController()
    operations.set(id, controller)
    try {
      return await operation({
        signal: controller.signal,
        onProgress: (progress) => broadcastProgress({ operationId: id, ...progress }),
      })
    } finally {
      if (operations.get(id) === controller) operations.delete(id)
    }
  }
}

function parseOperationId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Codex session repair operation identifier.')
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(id)) {
    throw new Error('Invalid Codex session repair operation identifier.')
  }
  return id
}

function broadcastProgress(progress: CodexSessionRepairProgressEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('stone:codex-session-repair-progress', progress)
  }
}
