import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCodexSessionRepairApi } from '../../src/main/ipc/session-repair-api'
import type { CodexRepairAndRestartService, CodexSessionIndexCleanupService, CodexSessionRepairService } from '../../src/main/codex'
import type { ClientConfigService } from '../../src/main/client-config'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: electron.send } },
      { isDestroyed: () => true, webContents: { send: electron.send } },
    ]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
  },
}))

describe('Codex session repair IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.fromWebContents.mockReturnValue({})
    electron.send.mockReset()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('exposes fixed inspect, analyze, preview, and repair operations to the trusted main frame', async () => {
    const service = {
      inspect: vi.fn(async () => ({ currentProvider: 'stone' })),
      analyze: vi.fn(async () => ({ targetProvider: 'stone', revision: 'a'.repeat(64) })),
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
    await invoke('stone:analyze-codex-session-repair', event, 'stone')
    await invoke('stone:preview-codex-session-repair', event, 'stone')
    await invoke('stone:repair-codex-sessions', event, 'stone', 'a'.repeat(64))
    await invoke('stone:repair-codex-sessions-and-restart-chatgpt', event)

    expect(service.inspect).toHaveBeenCalledOnce()
    expect(service.analyze).toHaveBeenCalledWith('stone')
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

  it('publishes progress for a renderer-owned scan and cancellation aborts the real operation', async () => {
    const operationId = 'repair-operation-1234'
    const analyze = vi.fn((_targetProvider?: string, options: { signal?: AbortSignal; onProgress?: (event: unknown) => void } = {}) => {
      options.onProgress?.({ stage: 'scan', completed: 3, total: 10 })
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('Codex session repair was cancelled.')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const service = { analyze } as unknown as CodexSessionRepairService
    const repairAndRestart = { run: vi.fn() } as unknown as CodexRepairAndRestartService
    registerCodexSessionRepairApi(service, repairAndRestart)

    const operation = invoke('stone:analyze-codex-session-repair', trustedEvent(), 'stone', operationId)
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    await expect(invoke('stone:cancel-codex-session-repair', trustedEvent(), operationId)).resolves.toBe(true)
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await expect(invoke('stone:cancel-codex-session-repair', trustedEvent(), operationId)).resolves.toBe(false)

    expect(electron.send).toHaveBeenCalledWith('stone:codex-session-repair-progress', {
      operationId,
      stage: 'scan',
      completed: 3,
      total: 10,
    })
  })

  it('threads progress and cancellation options through close-repair-restart coordination', async () => {
    const run = vi.fn(async (options: { signal?: AbortSignal; onProgress?: (event: unknown) => void }) => {
      options.onProgress?.({ stage: 'apply', completed: 1, total: 1 })
      return { repair: { targetProvider: 'stone' }, chatGptWasRunning: true, chatGptRestarted: true }
    })
    registerCodexSessionRepairApi(
      {} as CodexSessionRepairService,
      { run } as unknown as CodexRepairAndRestartService,
    )

    await invoke(
      'stone:repair-codex-sessions-and-restart-chatgpt',
      trustedEvent(),
      'stone',
      undefined,
      'restart-operation-1234',
    )

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      targetProvider: 'stone',
      expectedRevision: undefined,
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }))
    expect(electron.send).toHaveBeenCalledWith('stone:codex-session-repair-progress', {
      operationId: 'restart-operation-1234',
      stage: 'apply',
      completed: 1,
      total: 1,
    })
  })

  it('rejects invalid and duplicate operation identifiers at the trusted boundary', async () => {
    let finish!: () => void
    const pending = new Promise<unknown>((resolve) => { finish = () => resolve({}) })
    const analyze = vi.fn(() => pending)
    registerCodexSessionRepairApi(
      { analyze } as unknown as CodexSessionRepairService,
      { run: vi.fn() } as unknown as CodexRepairAndRestartService,
    )

    await expect(invoke('stone:analyze-codex-session-repair', trustedEvent(), 'stone', '../bad')).rejects.toThrow('Invalid Codex session repair operation identifier')
    const first = invoke('stone:analyze-codex-session-repair', trustedEvent(), 'stone', 'duplicate-operation')
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    await expect(invoke('stone:analyze-codex-session-repair', trustedEvent(), 'stone', 'duplicate-operation')).rejects.toThrow('already running')
    finish()
    await first
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
