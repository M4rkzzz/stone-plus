import { describe, expect, it, vi } from 'vitest'
import {
  CodexRepairAndRestartService,
  WindowsChatGptDesktopController,
  type ChatGptDesktopController,
  type CodexSessionRepairService,
} from '../../src/main/codex'

describe('WindowsChatGptDesktopController', () => {
  it('captures the Start app id, closes every ChatGPT process and relaunches the packaged app', async () => {
    const commands: Array<{ file: string; args: string[] }> = []
    const launches: Array<{ file: string; args: string[] }> = []
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        commands.push({ file, args })
        if (file === 'powershell.exe') return { stdout: 'OpenAI.Codex_test!App\r\n', stderr: '' }
        if (file === 'tasklist.exe') return { stdout: '"ChatGPT.exe","123","Console","1","100 K"\r\n', stderr: '' }
        return { stdout: 'SUCCESS', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => { launches.push({ file, args }) }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state).toEqual({ wasRunning: true, launchTarget: 'OpenAI.Codex_test!App' })
    expect(commands.some((item) => item.file === 'taskkill.exe'
      && item.args.join(' ') === '/F /T /IM ChatGPT.exe')).toBe(true)
    expect(launches).toEqual([{
      file: 'explorer.exe',
      args: ['shell:AppsFolder\\OpenAI.Codex_test!App'],
    }])
  })

  it('uses the known package fallback and does not kill when ChatGPT is already closed', async () => {
    const commands: string[] = []
    const launches: Array<{ file: string; args: string[] }> = []
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file) => {
        commands.push(file)
        if (file === 'powershell.exe') throw new Error('not available')
        return { stdout: 'INFO: No tasks are running', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => { launches.push({ file, args }) }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state.wasRunning).toBe(false)
    expect(commands).not.toContain('taskkill.exe')
    expect(launches[0]?.args[0]).toBe('shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App')
  })
})

describe('CodexRepairAndRestartService', () => {
  it('repairs the current provider after shutdown and then relaunches ChatGPT', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run()

    expect(repair.preview).toHaveBeenCalledWith('stone')
    expect(repair.repair).toHaveBeenCalledWith('stone', 'a'.repeat(64))
    expect(desktop.shutdown).toHaveBeenCalledOnce()
    expect(desktop.relaunch).toHaveBeenCalledWith({ wasRunning: true, launchTarget: 'OpenAI.Codex_test!App' })
    expect(result.chatGptRestarted).toBe(true)
    expect(result.repair.targetProvider).toBe('stone')
  })

  it('relaunches ChatGPT even when session repair fails', async () => {
    const repair = repairService()
    repair.repair.mockRejectedValueOnce(new Error('repair failed'))
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run()).rejects.toThrow('repair failed')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('waits for the active repair and restart operation to settle', async () => {
    const repair = repairService()
    let finishRepair: (() => void) | undefined
    repair.repair.mockImplementationOnce(() => new Promise((resolve) => {
      finishRepair = () => resolve({
        targetProvider: 'stone',
        repairedRolloutFiles: 1,
        sqliteProviderRowsUpdated: 1,
        sqliteUserEventRowsUpdated: 0,
        sqliteCwdRowsUpdated: 0,
        skippedFiles: [],
        encryptedSessionFiles: 0,
        encryptedSourceProviders: [],
      })
    }))
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    const operation = service.run()
    let idle = false
    const waiting = service.waitForIdle().then(() => { idle = true })

    await vi.waitFor(() => expect(repair.repair).toHaveBeenCalledOnce())
    expect(idle).toBe(false)
    finishRepair?.()
    await waiting

    expect(idle).toBe(true)
    await expect(operation).resolves.toMatchObject({ chatGptRestarted: true })
  })

  it('closes after the active operation and rejects work started during shutdown', async () => {
    const repair = repairService()
    let finishRepair: (() => void) | undefined
    repair.repair.mockImplementationOnce(() => new Promise((resolve) => {
      finishRepair = () => resolve({
        targetProvider: 'stone',
        repairedRolloutFiles: 1,
        sqliteProviderRowsUpdated: 1,
        sqliteUserEventRowsUpdated: 0,
        sqliteCwdRowsUpdated: 0,
        skippedFiles: [],
        encryptedSessionFiles: 0,
        encryptedSourceProviders: [],
      })
    }))
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    const operation = service.run()

    let closed = false
    const closing = service.close().then(() => { closed = true })
    await vi.waitFor(() => expect(repair.repair).toHaveBeenCalledOnce())
    await expect(service.run()).rejects.toThrow('正在退出')
    expect(closed).toBe(false)

    finishRepair?.()
    await closing
    await expect(operation).resolves.toMatchObject({ chatGptRestarted: true })
    expect(closed).toBe(true)
    await expect(service.run()).rejects.toThrow('正在退出')
  })
})

function repairService() {
  const inspect = vi.fn(async () => ({
    codexHome: 'C:\\Users\\demo\\.codex',
    currentProvider: 'stone',
    targets: [{ id: 'stone', sources: ['config'] as const, isCurrentProvider: true }],
    sessionFiles: 1,
    archivedSessionFiles: 0,
    indexedThreads: 1,
    sqliteDatabases: [],
    skippedFiles: [],
  }))
  const preview = vi.fn(async (targetProvider: string) => ({
    ...(await inspect()),
    targetProvider,
    revision: 'a'.repeat(64),
    rolloutFilesToUpdate: 1,
    sqliteProviderRowsToUpdate: 1,
    sqliteUserEventRowsToUpdate: 0,
    sqliteCwdRowsToUpdate: 0,
    encryptedSessionFiles: 0,
    encryptedSourceProviders: [],
  }))
  const repair = vi.fn(async (targetProvider: string) => ({
    targetProvider,
    repairedRolloutFiles: 1,
    sqliteProviderRowsUpdated: 1,
    sqliteUserEventRowsUpdated: 0,
    sqliteCwdRowsUpdated: 0,
    skippedFiles: [],
    encryptedSessionFiles: 0,
    encryptedSourceProviders: [],
  }))
  return {
    inspect,
    preview,
    repair,
    value: { inspect, preview, repair } as unknown as CodexSessionRepairService,
  }
}

function desktopController() {
  const state = { wasRunning: true, launchTarget: 'OpenAI.Codex_test!App' }
  const shutdown = vi.fn(async () => state)
  const relaunch = vi.fn(async () => undefined)
  return {
    shutdown,
    relaunch,
    value: {
      shutdownForRepair: shutdown,
      relaunch,
    } satisfies ChatGptDesktopController,
  }
}
