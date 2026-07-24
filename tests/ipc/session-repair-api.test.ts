import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCodexSessionRepairApi } from '../../src/main/ipc/session-repair-api'
import type { CodexRepairAndRestartService, CodexSessionIndexCleanupService, CodexSessionRepairService } from '../../src/main/codex'
import type { ClientConfigService } from '../../src/main/client-config'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
  },
}))

describe('Codex session repair IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('exposes fixed inspect, preview, and repair operations to the trusted main frame', async () => {
    const service = {
      inspect: vi.fn(async () => ({ currentProvider: 'stone' })),
      preview: vi.fn(async () => ({ targetProvider: 'stone', revision: 'a'.repeat(64) })),
      repair: vi.fn(async () => ({ targetProvider: 'stone', repairedRolloutFiles: 2 })),
    } as unknown as CodexSessionRepairService
    const repairAndRestart = {
      run: vi.fn(async (options: { targetProvider?: string } = {}) => ({
        repair: { targetProvider: options.targetProvider ?? 'stone', repairedRolloutFiles: 2 },
        chatGptWasRunning: true,
        chatGptRestarted: true,
      })),
    } as unknown as CodexRepairAndRestartService
    registerCodexSessionRepairApi(service, repairAndRestart)
    const event = trustedEvent()

    await invoke('stone:inspect-codex-session-repair', event)
    await invoke('stone:preview-codex-session-repair', event, 'stone')
    await invoke('stone:repair-codex-sessions', event, 'stone', 'a'.repeat(64))
    await invoke('stone:repair-codex-sessions-and-restart-chatgpt', event)

    expect(service.inspect).toHaveBeenCalledOnce()
    expect(service.preview).toHaveBeenCalledTimes(1)
    expect(service.preview).toHaveBeenCalledWith('stone')
    expect(service.repair).not.toHaveBeenCalled()
    expect(repairAndRestart.run).toHaveBeenNthCalledWith(1, { targetProvider: 'stone', expectedRevision: 'a'.repeat(64) })
    expect(repairAndRestart.run).toHaveBeenNthCalledWith(2, {})
  })

  it('rejects calls from an untrusted renderer', async () => {
    const service = { inspect: vi.fn() } as unknown as CodexSessionRepairService
    const repairAndRestart = { run: vi.fn() } as unknown as CodexRepairAndRestartService
    registerCodexSessionRepairApi(service, repairAndRestart)
    const mainFrame = { url: 'https://evil.example/index.html' }

    await expect(invoke('stone:inspect-codex-session-repair', { senderFrame: mainFrame, sender: { mainFrame } }))
      .rejects.toThrow('untrusted origin')
    expect(service.inspect).not.toHaveBeenCalled()
  })

  it('restores a profile-scoped official login between shutdown and OpenAI session repair', async () => {
    const service = {} as CodexSessionRepairService
    const clientConfigResult = {
      client: 'codex' as const,
      changedFiles: ['D:\\profiles\\official\\config.toml'],
      backups: [],
      removedBackups: [],
    }
    const restoreCodexOfficialLogin = vi.fn(async () => clientConfigResult)
    const scoped = { restoreCodexOfficialLogin } as unknown as ClientConfigService
    const root = {
      withOverrides: vi.fn(() => scoped),
    } as unknown as ClientConfigService
    const run = vi.fn(async (options: { targetProvider?: string; beforeRepair?: () => Promise<void> }) => {
      await options.beforeRepair?.()
      return {
        repair: {
          targetProvider: options.targetProvider ?? 'stone',
          repairedRolloutFiles: 2,
          sqliteProviderRowsUpdated: 1,
          sqliteUserEventRowsUpdated: 0,
          sqliteCwdRowsUpdated: 0,
          skippedFiles: [],
          encryptedSessionFiles: 0,
          encryptedSourceProviders: [],
        },
        chatGptWasRunning: true,
        chatGptRestarted: true,
      }
    })
    const repairAndRestart = { run } as unknown as CodexRepairAndRestartService
    registerCodexSessionRepairApi(service, repairAndRestart, {
      clientConfig: root,
      clientProfiles: () => [{
        id: 'codex-work',
        name: 'Work',
        client: 'codex',
        directory: 'D:\\profiles\\official',
        backupRetention: 7,
        isDefault: false,
        createdAt: 1,
        updatedAt: 1,
      }],
    })

    const result = await invoke(
      'stone:restore-codex-official-login-and-sessions',
      trustedEvent(),
      'codex-work',
    )

    expect(root.withOverrides).toHaveBeenCalledWith({ codexDirectory: 'D:\\profiles\\official' })
    expect(restoreCodexOfficialLogin).toHaveBeenCalledWith({ backupRetention: 7 })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ targetProvider: 'openai' }))
    expect(result).toMatchObject({ clientConfig: clientConfigResult, repair: { targetProvider: 'openai' } })
  })

  it('rejects a non-Codex profile before closing the app', async () => {
    const run = vi.fn()
    registerCodexSessionRepairApi(
      {} as CodexSessionRepairService,
      { run } as unknown as CodexRepairAndRestartService,
      {
        clientConfig: {} as ClientConfigService,
        clientProfiles: () => [{
          id: 'claude-work',
          name: 'Claude',
          client: 'claude',
          backupRetention: 10,
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    )

    await expect(invoke(
      'stone:restore-codex-official-login-and-sessions',
      trustedEvent(),
      'claude-work',
    )).rejects.toThrow('does not match Codex')
    expect(run).not.toHaveBeenCalled()
  })

  it('previews ghost candidates and routes selected cleanup through close-repair-reopen coordination', async () => {
    const preview = vi.fn(async () => ({
      snapshotSha256: 'b'.repeat(64),
      candidates: [{ id: 'thread-one', threadName: 'One', updatedAt: '2026-07-20T00:00:00Z' }],
    }))
    const cleanupSessionIndex = vi.fn(async () => ({
      cleanup: { prunedEntries: 1, backupPath: 'D:\\backup' },
      chatGptWasRunning: true,
      chatGptRestarted: true,
    }))
    registerCodexSessionRepairApi(
      {} as CodexSessionRepairService,
      { cleanupSessionIndex } as unknown as CodexRepairAndRestartService,
      undefined,
      { preview } as unknown as CodexSessionIndexCleanupService,
    )

    await expect(invoke('stone:preview-codex-session-index-cleanup', trustedEvent()))
      .resolves.toMatchObject({ candidates: [{ id: 'thread-one' }] })
    await expect(invoke(
      'stone:cleanup-codex-session-index-and-restart',
      trustedEvent(),
      'b'.repeat(64),
      ['thread-one'],
    )).resolves.toMatchObject({ cleanup: { prunedEntries: 1 }, chatGptRestarted: true })
    expect(cleanupSessionIndex).toHaveBeenCalledWith('b'.repeat(64), ['thread-one'])
  })
})

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}
