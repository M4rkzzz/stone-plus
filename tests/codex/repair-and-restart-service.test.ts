import { describe, expect, it, vi } from 'vitest'
import {
  CodexRepairAndRestartService,
  MacChatGptDesktopController,
  UnsupportedChatGptDesktopController,
  WindowsChatGptDesktopController,
  type ChatGptDesktopController,
  type CodexSessionIndexCleanupService,
  type CodexSessionRepairService,
} from '../../src/main/codex'

describe('UnsupportedChatGptDesktopController', () => {
  it('reports Linux as unsupported without invoking Windows commands', async () => {
    const controller = new UnsupportedChatGptDesktopController('linux')
    await expect(controller.shutdownForRepair()).rejects.toThrow(/not supported on linux/)
    await expect(controller.relaunch({ wasRunning: false, launchTarget: '' })).rejects.toThrow(/not supported on linux/)
  })
})

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
      launch: vi.fn(async (file, args) => {
        launches.push({ file, args })
        running = true
      }),
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
    const discovery = commands.find((item) => item.file === 'powershell.exe'
      && item.args.at(-1)?.includes('Get-StartApps'))?.args.at(-1) ?? ''
    expect(discovery.indexOf("Get-Process -Name 'Codex'")).toBeLessThan(discovery.indexOf('Get-StartApps'))
    expect(launches).toEqual([{
      file: 'explorer.exe',
      args: ['shell:AppsFolder\\OpenAI.Codex_test!App'],
    }])
  })

  it('uses the known package fallback and does not kill when ChatGPT is already closed', async () => {
    const commands: string[] = []
    const launches: Array<{ file: string; args: string[] }> = []
    let running = false
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (file, args) => {
        commands.push(file)
        const command = args.at(-1) ?? ''
        if (file === 'powershell.exe' && command.includes('Get-StartApps')) return { stdout: '', stderr: '' }
        if (file === 'powershell.exe' && command.includes('Get-AppxPackage')) return { stdout: '', stderr: '' }
        return { stdout: running ? '321\r\n' : '', stderr: '' }
      }),
      launch: vi.fn(async (file, args) => {
        launches.push({ file, args })
        running = true
      }),
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state.wasRunning).toBe(false)
    expect(commands).not.toContain('taskkill.exe')
    expect(launches[0]?.args[0]).toBe('shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App')
  })

  it('derives the AppsFolder id from the installed package when Start Apps is unavailable', async () => {
    let running = false
    const launch = vi.fn(async () => { running = true })
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes("PackageFamilyName + '!App'")) {
          return { stdout: 'OpenAI.Codex_preview!App', stderr: '' }
        }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: running ? '321\r\n' : '', stderr: '' }
      }),
      launch,
    })

    await controller.relaunch(await controller.shutdownForRepair())

    expect(launch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_preview!App'])
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
      launch: vi.fn(async (file, args) => {
        launches.push({ file, args })
        running = true
      }),
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
    let running = false
    const launch = vi.fn(async () => undefined)
    const launchCodexMicroDisabled = vi.fn(async () => { running = true })
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled,
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: running ? '321\r\n' : '', stderr: '' }
      }),
      launch,
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(launchCodexMicroDisabled).toHaveBeenCalledWith('C:\\Codex\\ChatGPT.exe')
    expect(launch).not.toHaveBeenCalled()
  })

  it('reads the current Micro preference for every managed desktop start', async () => {
    let disabled = false
    let running = false
    const launch = vi.fn(async () => { running = true })
    const launchCodexMicroDisabled = vi.fn(async () => { running = true })
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      shouldDisableCodexMicro: () => disabled,
      launchCodexMicroDisabled,
      runCommand: vi.fn(async () => ({ stdout: running ? '321\r\n' : '', stderr: '' })),
      launch,
    })
    const state = {
      wasRunning: false,
      launchTarget: 'OpenAI.Codex_test!App',
      executablePath: 'C:\\Codex\\ChatGPT.exe',
    }

    await controller.relaunch(state)
    expect(launch).toHaveBeenCalledOnce()
    expect(launchCodexMicroDisabled).not.toHaveBeenCalled()

    running = false
    disabled = true
    await controller.relaunch(state)
    expect(launchCodexMicroDisabled).toHaveBeenCalledWith('C:\\Codex\\ChatGPT.exe')
    expect(launch).toHaveBeenCalledOnce()
  })

  it('falls back to normal startup if a Codex update breaks the Micro hook', async () => {
    let running = false
    const launch = vi.fn(async () => { running = true })
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled: vi.fn(async () => { throw new Error('private bootstrap changed') }),
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: running ? '321\r\n' : '', stderr: '' }
      }),
      launch,
    })

    await controller.relaunch(await controller.shutdownForRepair())

    expect(launch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_test!App'])
  })

  it('falls back to AppsFolder when the Micro launcher returns but no desktop process becomes ready', async () => {
    let running = false
    const launch = vi.fn(async () => { running = true })
    const launchCodexMicroDisabled = vi.fn(async () => undefined)
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled,
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: running ? '321\r\n' : '', stderr: '' }
      }),
      launch,
    })

    await controller.relaunch(await controller.shutdownForRepair())

    expect(launchCodexMicroDisabled).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_test!App'])
  })

  it('reports a clear failure when neither startup path creates a desktop process', async () => {
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      shouldDisableCodexMicro: () => true,
      launchCodexMicroDisabled: vi.fn(async () => undefined),
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: 'C:\\Codex\\ChatGPT.exe', stderr: '' }
        return { stdout: '', stderr: '' }
      }),
      launch: vi.fn(async () => undefined),
    })

    await expect(controller.relaunch(await controller.shutdownForRepair()))
      .rejects.toThrow('10 秒内未检测到稳定的 Codex / ChatGPT 桌面进程')
  })

  it('does not report success for a desktop process that crashes after the first probe', async () => {
    let probesAfterLaunch = 0
    let launched = false
    const controller = new WindowsChatGptDesktopController({
      platform: 'win32',
      delay: vi.fn(async () => undefined),
      runCommand: vi.fn(async (_file, args) => {
        const command = args.at(-1) ?? ''
        if (command.includes('Get-StartApps')) return { stdout: 'OpenAI.Codex_test!App', stderr: '' }
        if (command.includes('Get-AppxPackage')) return { stdout: '', stderr: '' }
        if (!launched) return { stdout: '', stderr: '' }
        probesAfterLaunch += 1
        return { stdout: probesAfterLaunch === 1 ? '321\r\n' : '', stderr: '' }
      }),
      launch: vi.fn(async () => { launched = true }),
    })

    await expect(controller.relaunch(await controller.shutdownForRepair()))
      .rejects.toThrow('未检测到稳定的 Codex / ChatGPT 桌面进程')
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

describe('MacChatGptDesktopController', () => {
  it('closes the known Codex app and restores the captured application', async () => {
    let running = true
    const launch = vi.fn(async () => undefined)
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file.endsWith('pgrep')) {
        if (args[1] === 'Codex' && running) return { stdout: '42\n', stderr: '' }
        throw new Error('not running')
      }
      if (file.endsWith('pkill')) running = false
      return { stdout: '', stderr: '' }
    })
    const controller = new MacChatGptDesktopController({
      platform: 'darwin',
      runCommand,
      launch,
      delay: async () => undefined,
    })

    const state = await controller.shutdownForRepair()
    await controller.relaunch(state)

    expect(state).toEqual({ wasRunning: true, launchTarget: 'Codex' })
    expect(runCommand).toHaveBeenCalledWith('/usr/bin/pkill', ['-TERM', '-x', 'Codex'])
    expect(launch).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Codex'])
  })
})

describe('CodexRepairAndRestartService', () => {
  it('repairs the current provider after shutdown and then relaunches ChatGPT', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run()

    expect(repair.analyzeAndRepair).toHaveBeenCalledWith(undefined)
    expect(repair.analyze).not.toHaveBeenCalled()
    expect(desktop.shutdown).toHaveBeenCalledOnce()
    expect(desktop.relaunch).toHaveBeenCalledWith({ wasRunning: true, launchTarget: 'OpenAI.Codex_test!App' })
    expect(result.chatGptRestarted).toBe(true)
    expect(result.repair.targetProvider).toBe('stone')
  })

  it('preserves an already-closed desktop state for lifecycle maintenance', async () => {
    const repair = repairService()
    const desktop = desktopController()
    desktop.shutdown.mockResolvedValue({ wasRunning: false, launchTarget: 'OpenAI.Codex_test!App' })
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run({ preserveRunningState: true })

    expect(repair.repair).toHaveBeenCalledOnce()
    expect(desktop.relaunch).not.toHaveBeenCalled()
    expect(result.chatGptWasRunning).toBe(false)
    expect(result.chatGptRestarted).toBe(false)
  })

  it('closes Codex before preparation, repairs an explicit provider, and reopens it last', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const beforeRepair = vi.fn(async () => undefined)
    const beforeRelaunch = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run({ targetProvider: 'openai', beforeRepair, beforeRelaunch })

    expect(repair.analyzeAndRepair).toHaveBeenCalledWith('openai')
    expect(result.repair.targetProvider).toBe('openai')
    expect(desktop.shutdown.mock.invocationCallOrder[0]).toBeLessThan(beforeRepair.mock.invocationCallOrder[0])
    expect(beforeRepair.mock.invocationCallOrder[0]).toBeLessThan(repair.analyzeAndRepair.mock.invocationCallOrder[0])
    expect(repair.analyzeAndRepair.mock.invocationCallOrder[0]).toBeLessThan(beforeRelaunch.mock.invocationCallOrder[0])
    expect(beforeRelaunch.mock.invocationCallOrder[0]).toBeLessThan(desktop.relaunch.mock.invocationCallOrder[0])
  })

  it('skips the history scan when the caller proves sessions are already on the target provider', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const beforeRepair = vi.fn(async () => undefined)
    const beforeRelaunch = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    const result = await service.run({
      targetProvider: 'openai',
      skipSessionRepair: true,
      beforeRepair,
      beforeRelaunch,
    })

    expect(repair.analyze).not.toHaveBeenCalled()
    expect(repair.analyzeAndRepair).not.toHaveBeenCalled()
    expect(result.repair).toMatchObject({
      targetProvider: 'openai',
      repairedRolloutFiles: 0,
      sqliteProviderRowsUpdated: 0,
    })
    expect(desktop.shutdown.mock.invocationCallOrder[0]).toBeLessThan(beforeRepair.mock.invocationCallOrder[0])
    expect(beforeRepair.mock.invocationCallOrder[0]).toBeLessThan(beforeRelaunch.mock.invocationCallOrder[0])
    expect(beforeRelaunch.mock.invocationCallOrder[0]).toBeLessThan(desktop.relaunch.mock.invocationCallOrder[0])
  })

  it('passes the startup-index scope to the provider repair transaction', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await service.run({
      targetProvider: 'openai',
      sessionRepairScope: 'startup-index',
    })

    expect(repair.analyzeAndRepair).toHaveBeenCalledWith('openai', undefined, expect.objectContaining({
      scope: 'startup-index',
    }))
  })

  it('rejects a scan skip without an explicit target before closing Codex', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run({ skipSessionRepair: true })).rejects.toThrow('explicit target provider')

    expect(desktop.shutdown).not.toHaveBeenCalled()
    expect(repair.analyzeAndRepair).not.toHaveBeenCalled()
  })

  it('validates the reviewed revision before shutdown and repairs the stable post-shutdown revision', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    const reviewed = 'c'.repeat(64)
    repair.analyze.mockResolvedValueOnce({
      targetProvider: 'openai',
      revision: reviewed,
    } as Awaited<ReturnType<typeof repair.analyze>>)

    await service.run({ targetProvider: 'openai', expectedRevision: reviewed })

    expect(desktop.shutdown).toHaveBeenCalledOnce()
    expect(repair.analyze).toHaveBeenCalledOnce()
    expect(repair.analyze).toHaveBeenCalledWith('openai')
    expect(repair.analyzeAndRepair).toHaveBeenCalledWith('openai')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
  })

  it('rejects a stale reviewed revision before closing Codex', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)
    repair.analyze.mockResolvedValueOnce({
      targetProvider: 'openai',
      revision: 'e'.repeat(64),
    } as Awaited<ReturnType<typeof repair.analyze>>)

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

    expect(repair.analyze).not.toHaveBeenCalled()
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

  it('rolls back completed preparation before reopening when session synchronization fails', async () => {
    const repair = repairService()
    repair.repair.mockRejectedValueOnce(new Error('session sync failed'))
    const desktop = desktopController()
    const beforeRepair = vi.fn(async () => undefined)
    const rollbackBeforeRepair = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run({ beforeRepair, rollbackBeforeRepair })).rejects.toThrow('session sync failed')

    expect(beforeRepair).toHaveBeenCalledOnce()
    expect(rollbackBeforeRepair).toHaveBeenCalledOnce()
    expect(rollbackBeforeRepair.mock.invocationCallOrder[0]).toBeLessThan(desktop.relaunch.mock.invocationCallOrder[0])
  })

  it('keeps a completed provider sync when only the verified relaunch fails', async () => {
    const repair = repairService()
    const desktop = desktopController()
    desktop.relaunch.mockRejectedValueOnce(new Error('launch failed'))
    const rollbackBeforeRepair = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run({
      beforeRepair: async () => undefined,
      rollbackBeforeRepair,
    })).rejects.toThrow('会话修复已完成，但桌面端未能重新启动')

    expect(rollbackBeforeRepair).not.toHaveBeenCalled()
  })

  it('reopens the last usable configuration but still reports a pre-relaunch reconciliation failure', async () => {
    const repair = repairService()
    const desktop = desktopController()
    const rollbackBeforeRepair = vi.fn(async () => undefined)
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run({
      beforeRepair: async () => undefined,
      rollbackBeforeRepair,
      beforeRelaunch: async () => { throw new Error('final token synchronization failed') },
    })).rejects.toThrow('final token synchronization failed')

    expect(desktop.relaunch).toHaveBeenCalledOnce()
    expect(rollbackBeforeRepair).not.toHaveBeenCalled()
  })

  it('does not duplicate a desktop launch after repair when the verified relaunch already failed', async () => {
    const repair = repairService()
    const desktop = desktopController()
    desktop.relaunch.mockRejectedValueOnce(new Error('first launch failed'))
    const service = new CodexRepairAndRestartService(repair.value, desktop.value)

    await expect(service.run()).rejects.toThrow('会话修复已完成，但桌面端未能重新启动')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
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
    expect(repair.analyze).not.toHaveBeenCalled()
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

  it('does not duplicate a desktop launch after index cleanup when relaunch already failed', async () => {
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
      .rejects.toThrow('索引清理已完成，备份位于：D:\\backup；ChatGPT 重新启动失败')
    expect(desktop.relaunch).toHaveBeenCalledOnce()
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
        sqliteModelRowsUpdated: 0,
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
        sqliteModelRowsUpdated: 0,
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
  const analyze = vi.fn(async (targetProvider = 'stone') => ({
    ...(await inspect()),
    targetProvider,
    revision: 'a'.repeat(64),
    rolloutFilesToUpdate: 1,
    rolloutFilesWithSessionMeta: 1,
    rolloutFilesWithoutSessionMeta: 0,
    rolloutFilesAlreadyTargetProvider: 0,
    sqliteProviderRowsToUpdate: 1,
    sqliteModelRowsToUpdate: 0,
    sqliteUserEventRowsToUpdate: 0,
    sqliteCwdRowsToUpdate: 0,
    globalStateFieldsToUpdate: 0,
    globalStateConflictingFields: [],
    encryptedSessionFiles: 0,
    encryptedSourceProviders: [],
  }))
  const preview = vi.fn(async (targetProvider: string) => analyze(targetProvider))
  const analyzeAndRepair = vi.fn(async (targetProvider = 'stone') => ({
    targetProvider,
    repairedRolloutFiles: 1,
    sqliteProviderRowsUpdated: 1,
    sqliteModelRowsUpdated: 0,
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
    analyze,
    preview,
    repair: analyzeAndRepair,
    analyzeAndRepair,
    value: {
      inspect,
      analyze,
      preview,
      repair: analyzeAndRepair,
      analyzeAndRepair,
    } as unknown as CodexSessionRepairService,
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
