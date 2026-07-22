import { ipcMain } from 'electron'
import type { ClientConfigProfile, CodexOfficialLoginRecoveryResult } from '@shared/types'
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
  ipcMain.handle('stone:inspect-codex-session-repair', (event) => {
    assertTrustedSender(event)
    return service.inspect()
  })
  ipcMain.handle('stone:preview-codex-session-repair', (event, targetProvider: string) => {
    assertTrustedSender(event)
    return service.preview(targetProvider)
  })
  ipcMain.handle('stone:repair-codex-sessions', async (event, targetProvider: string, expectedRevision: string) => {
    assertTrustedSender(event)
    return (await repairAndRestart.run({ targetProvider, expectedRevision })).repair
  })
  ipcMain.handle('stone:repair-codex-sessions-and-restart-chatgpt', (event, targetProvider?: string, expectedRevision?: string) => {
    assertTrustedSender(event)
    return repairAndRestart.run(targetProvider ? { targetProvider, expectedRevision } : {})
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
}
