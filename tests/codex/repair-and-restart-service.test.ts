import { describe, expect, it, vi } from 'vitest'
import {
  CodexRepairAndRestartService,
  WindowsChatGptDesktopController,
  type ChatGptDesktopController,
  type CodexSessionIndexCleanupService,
  type CodexSessionRepairService,
} from '../../src/main/codex'

describe('WindowsChatGptDesktopController', () => {
  it('captures the Start app id, closes every ChatGPT process and relaunches the packaged app', async () => {
    const commands: Array<{ file: string; args: string[] }> = []
    const launches: Array<{ file: string; args: string[] }> = []
    let running = true
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        commands.push({ file, args })
        const command = args.at(-1) ?? ''
        if (file === 'powershell.exe' && command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App\r\n', stderr: '' }
        if (file === 'powershell.exe' && command.includes('Get-AppxPackage')) return { stdout: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe', stderr: '' }
        if (file === 'powershell.exe') return { stdout: running ? '123\r\n456\r\n' : '', stderr: '' }
        if (file === 'taskkill.exe') running = false
        return { stdout: 'SUCCESS', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => { launches.push({ file, args }) }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state).toEqual({
      wasRunning: true,
      launchTarget: 'OpenAI.Codex_test!App',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe',
    })
    expect(commands.some((item) => item.file === 'taskkill.exe'
      && item.args.join(' ') === '/F /T /PID 123 /PID 456')).toBe(true)
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
        return { stdout: '', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => { launches.push({ file, args }) }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state.wasRunning).toBe(false)
    expect(commands).not.toContain('taskkill.exe')
    expect(launches[0]?.args[0]).toBe('shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App')
  })

  it('captures, closes, and relaunches a portable desktop Codex executable by PID', async () => {
    const launches: Array<{ file: string; args: string[] }> = []
    let running = true
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        const command = args.at(-1) ?? ''
        if (file === 'powershell.exe' && command.includes('Get-StartApps')) {
          return { stdout: 'D:\\Portable\\Codex\\Codex.exe', stderr: '' }
        }
        if (file === 'powershell.exe' && command.includes('Get-AppxPackage')) {
          return { stdout: 'D:\\Portable\\Codex\\Codex.exe', stderr: '' }
        }
        if (file === 'powershell.exe') return { stdout: running ? '789\r\n' : '', stderr: '' }
        if (file === 'taskkill.exe') running = false
        return { stdout: 'SUCCESS', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => { launches.push({ file, args }) }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state).toEqual({
      wasRunning: true,
      launchTarget: 'D:\\Portable\\Codex\\Codex.exe',
      executablePath: 'D:\\Portable\\Codex\\Codex.exe',
    })
    expect(launches).toEqual([{ file: 'D:\\Portable\\Codex\\Codex.exe', args: [] }])
  })

  it('uses the Micro-disabled startup path when the setting is enabled', async () => {
    const launch = vi.fn(async () => undefined)
    const launchCodexMicroDisabled = vi.fn(async () => undefined)
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled,
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: '', stderr: '' }
      }),
      launch,
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(launchCodexMicroDisabled).toHaveBeenCalledWith('C:\\Codex\\ChatGPT.exe')
    expect(launch).not.toHaveBeenCalled()
  })

  it('falls back to normal startup if a Codex update breaks the Micro hook', async () => {
    const launch = vi.fn(async () => undefined)
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled: vi.fn(async () => { throw new Error('private bootstrap changed') }),
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: '', stderr: '' }
      }),
      launch,
    })

    await controller.relaunch(await controller.shutdownForRepair())

    expect(launch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_test!App'])
  })

  it('falls back to tasklist when PowerShell process enumeration fails', async () => {
    const commands: string[] = []
    let running = true
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        commands.push(file)
        const command = args.at(-1) ?? ''
        if (file === 'powershell.exe' && command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (file === 'powershell.exe' && command.includes('Get-AppxPackage')) return { stdout: '', stderr: '' }
        if (file === 'powershell.exe') throw new Error('Get-Process returned exit 1')
        if (file === 'tasklist.exe') return {
          stdout: running ? '"ChatGPT.exe","321","Console","1","10,000 K"\r\n' : 'INFO: No tasks are running',
          stderr: '',
        }
        if (file === 'taskkill.exe') running = false
        return { stdout: '', stderr: '' }
      }),
    })

    const state = await controller.shutdownForRepair()

    expect(state.wasRunning).toBe(true)
    expect(commands).toContain('tasklist.exe')
    expect(commands).toContain('taskkill.exe')
  })

  it('treats the post-kill process list as authoritative when a PID disappears mid-command', async () => {
    let running = true
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        const command = args.at(-1) ?? ''
        if (file === 'powershell.exe' && command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (file === 'powershell.exe' && command.includes('Get-AppxPackage')) return { stdout: '', stderr: '' }
        if (file === 'powershell.exe') return { stdout: running ? '123\r\n456\r\n' : '', stderr: '' }
        if (file === 'taskkill.exe') {
          running = false
          throw new Error('ERROR: The process 456 not found. (exit 128)')
        }
        return { stdout: '', stderr: '' }
      }),
    })

    await expect(controller.shutdownForRepair()).resolves.toMatchObject({ wasRunning: true })
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

  it('closes Codex before preparation, repairs an explicit provider, and reopens it last', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const beforeRepair = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run({ targetProvider: 'openai', beforeRepair })

    expect(repair.preview).toHaveBeenCalledWith('openai')
    expect(repair.repair).toHaveBeenCalledWith('openai', 'a'.repeat(64))
    expect(result.repair.targetProvider).toBe('openai')
    expect(desktop.shutdown.mock.invocationCallOrder[0]).toBeLessThan(beforeRepair.mock.invocationCallOrder[0])
    expect(beforeRepair.mock.invocationCallOrder[0]).toBeLessThan(repair.preview.mock.invocationCallOrder[0])
    expect(repair.repair.mock.invocationCallOrder[0]).toBeLessThan(desktop.relaunch.mock.invocationCallOrder[0])
  })

  it('validates the reviewed revision before shutdown and repairs the stable post-shutdown revision', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    const reviewed = 'c'.repeat(64)
    const afterShutdown = 'd'.repeat(64)
    repair.preview
      .mockResolvedValueOnce({ targetProvider: 'openai', revision: reviewed } as Awaited<ReturnType<typeof repair.preview>>)
      .mockResolvedValueOnce({ targetProvider: 'openai', revision: afterShutdown } as Awaited<ReturnType<typeof repair.preview>>)

    await service.run({ targetProvider: 'openai', expectedRevision: reviewed })

    expect(desktop.shutdown).toHaveBeenCalledOnce()
    expect(repair.preview).toHaveBeenCalledTimes(2)
    expect(repair.repair).toHaveBeenCalledWith('openai', afterShutdown)
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('rejects a stale reviewed revision before closing Codex', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    repair.preview.mockResolvedValueOnce({
      targetProvider: 'openai',
      revision: 'e'.repeat(64),
    } as Awaited<ReturnType<typeof repair.preview>>)

    await expect(service.run({
      targetProvider: 'openai',
      expectedRevision: 'f'.repeat(64),
    })).rejects.toThrow('预览后发生变化')

    expect(desktop.shutdown).not.toHaveBeenCalled()
    expect(repair.repair).not.toHaveBeenCalled()
  })

  it('reopens Codex when preparation fails after shutdown', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run({
      targetProvider: 'openai',
      beforeRepair: async () => { throw new Error('configuration failed') },
    })).rejects.toThrow('configuration failed')

    expect(repair.preview).not.toHaveBeenCalled()
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('relaunches ChatGPT even when session repair fails', async () => {
    const repair = repairService()
    repair.repair.mockRejectedValueOnce(new Error('repair failed'))
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run()).rejects.toThrow('repair failed')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('returns repair success when a transient first relaunch failure is recovered', async () => {
    const repair = repairService()
    const desktop = desktopController()
    desktop.relaunch.mockRejectedValueOnce(new Error('first launch failed'))
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run()).resolves.toMatchObject({
      repair: { targetProvider: 'stone' },
      chatGptRestarted: true,
    })
    expect(desktop.relaunch).toHaveBeenCalledTimes(2)
  })

  it('closes, applies an explicitly selected index cleanup, and reopens Codex', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const apply = vi.fn(async () => ({ prunedEntries: 2, backupPath: 'D:\\backup' }))
    const preview = vi.fn(async () => ({
      snapshotSha256: 'b'.repeat(64),
      candidates: [
        { id: 'one', threadName: 'One', updatedAt: '2026-07-20T00:00:00Z' },
        { id: 'two', threadName: 'Two', updatedAt: '2026-07-20T00:00:00Z' },
      ],
    }))
    const cleanup = { apply, preview } as unknown as CodexSessionIndexCleanupService
    const service = new CodexRepairAndRestartService(repair.value, desktop.value, cleanup)

    const result = await service.cleanupSessionIndex('b'.repeat(64), ['one', 'two'])

    expect(apply).toHaveBeenCalledWith('b'.repeat(64), ['one', 'two'])
    expect(preview).toHaveBeenCalledTimes(2)
    expect(desktop.shutdown.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0])
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(desktop.relaunch.mock.invocationCallOrder[0])
    expect(result).toMatchObject({ cleanup: { prunedEntries: 2 }, chatGptRestarted: true })
    expect(repair.preview).not.toHaveBeenCalled()
  })

  it('reopens Codex when index cleanup rejects a stale preview', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const cleanup = {
      preview: vi.fn(async () => ({
        snapshotSha256: 'b'.repeat(64),
        candidates: [{ id: 'one', threadName: 'One', updatedAt: '2026-07-20T00:00:00Z' }],
      })),
      apply: vi.fn(async () => { throw new Error('stale preview') }),
    } as unknown as CodexSessionIndexCleanupService
    const service = new CodexRepairAndRestartService(repair.value, desktop.value, cleanup)

    await expect(service.cleanupSessionIndex('b'.repeat(64), ['one'])).rejects.toThrow('stale preview')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('returns cleanup success when a transient relaunch failure is recovered', async () => {
    const repair = repairService()
    const desktop = desktopController()
    desktop.relaunch.mockRejectedValueOnce(new Error('first launch failed'))
    const cleanup = {
      preview: vi.fn(async () => ({
        snapshotSha256: 'b'.repeat(64),
        candidates: [{ id: 'one', threadName: 'One', updatedAt: '2026-07-20T00:00:00Z' }],
      })),
      apply: vi.fn(async () => ({ prunedEntries: 1, backupPath: 'D:\\backup' })),
    } as unknown as CodexSessionIndexCleanupService
    const service = new CodexRepairAndRestartService(repair.value, desktop.value, cleanup)

    await expect(service.cleanupSessionIndex('b'.repeat(64), ['one']))
      .resolves.toMatchObject({ cleanup: { prunedEntries: 1 }, chatGptRestarted: true })
    expect(desktop.relaunch).toHaveBeenCalledTimes(2)
  })

  it('rejects a stale index preview before closing Codex', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const cleanup = {
      preview: vi.fn(async () => ({ snapshotSha256: 'c'.repeat(64), candidates: [] })),
      apply: vi.fn(),
    } as unknown as CodexSessionIndexCleanupService
    const service = new CodexRepairAndRestartService(repair.value, desktop.value, cleanup)

    await expect(service.cleanupSessionIndex('b'.repeat(64), ['one'])).rejects.toThrow('预览后发生变化')

    expect(desktop.shutdown).not.toHaveBeenCalled()
    expect(cleanup.apply).not.toHaveBeenCalled()
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
        globalStateFieldsUpdated: 0,
        globalStateConflictingFields: [],
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
        globalStateFieldsUpdated: 0,
        globalStateConflictingFields: [],
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
    globalStateFieldsToUpdate: 0,
    globalStateConflictingFields: [],
    encryptedSessionFiles: 0,
    encryptedSourceProviders: [],
  }))
  const repair = vi.fn(async (targetProvider: string) => ({
    targetProvider,
    repairedRolloutFiles: 1,
    sqliteProviderRowsUpdated: 1,
    sqliteUserEventRowsUpdated: 0,
    sqliteCwdRowsUpdated: 0,
    globalStateFieldsUpdated: 0,
    globalStateConflictingFields: [],
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
