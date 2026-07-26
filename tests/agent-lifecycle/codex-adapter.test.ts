import { describe, expect, it, vi } from 'vitest'
import type { ChatGptDesktopController } from '../../src/main/codex'
import {
  CodexLifecycleAdapter,
  CodexLifecycleOperationError,
  type CodexCliPort,
  type CodexDesktopProbe,
} from '../../src/main/agent-lifecycle/codex-adapter'

describe('CodexLifecycleAdapter', () => {
  it('binds desktop and CLI to the same state group while preserving their control boundary', async () => {
    const desktop = makeDesktop()
    const desktopProbe = makeDesktopProbe({ installed: true, running: true, version: '1.2.3' })
    const cli = makeCli({ externalSessionDetected: true })
    const deepRepair = { run: vi.fn(async () => undefined) }
    const desktopAdapter = new CodexLifecycleAdapter({
      target: 'codex-desktop', desktop, desktopProbe, deepRepair,
    })
    const cliAdapter = new CodexLifecycleAdapter({
      target: 'codex-cli', desktop, desktopProbe, deepRepair, cli,
    })

    await expect(desktopAdapter.getSnapshot()).resolves.toMatchObject({
      target: 'codex-desktop',
      sharedStateGroup: 'codex-home',
      running: true,
      processControl: 'full',
    })
    await expect(cliAdapter.getSnapshot()).resolves.toMatchObject({
      target: 'codex-cli',
      sharedStateGroup: 'codex-home',
      running: true,
      managedInstanceCount: 2,
      externalSessionDetected: true,
      processControl: 'managed-only',
    })
  })

  it('composes desktop restore through the existing deep repair transaction', async () => {
    const deepRepair = { run: vi.fn(async () => undefined) }
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-desktop',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair,
    })

    const result = await adapter.restore()

    expect(deepRepair.run).toHaveBeenCalledWith({ preserveRunningState: true })
    expect(result).toMatchObject({
      wasRunning: false,
      sessionsRepaired: true,
      // Index cleanup is deliberately not claimed without reviewed candidates.
      workspaceIndexRepaired: false,
    })
  })

  it('reuses the exact captured desktop launch state after an explicit close', async () => {
    const state = {
      wasRunning: true,
      launchTarget: 'OpenAI.Codex_test!App',
      executablePath: 'C:\\Codex\\Codex.exe',
    }
    const desktop: ChatGptDesktopController = {
      shutdownForRepair: vi.fn(async () => state),
      relaunch: vi.fn(async () => undefined),
    }
    let running = true
    const probe: CodexDesktopProbe = {
      inspect: vi.fn(async () => ({ installed: true, configured: true, running })),
    }
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-desktop', desktop, desktopProbe: probe, deepRepair: { run: vi.fn() },
    })

    await adapter.close()
    running = false
    await adapter.start()

    expect(desktop.shutdownForRepair).toHaveBeenCalledTimes(1)
    expect(desktop.relaunch).toHaveBeenCalledWith(state)
  })

  it('repairs the desktop connection before relaunch and restores a previously running client on failure', async () => {
    const state = { wasRunning: true, launchTarget: 'Codex.exe' }
    const desktop: ChatGptDesktopController = {
      shutdownForRepair: vi.fn(async () => state),
      relaunch: vi.fn(async () => undefined),
    }
    const prepareConnection = vi.fn()
      .mockRejectedValueOnce(new Error('config drift remained'))
      .mockResolvedValueOnce(undefined)
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-desktop',
      desktop,
      desktopProbe: makeDesktopProbe({ installed: true, running: true }),
      deepRepair: { run: vi.fn() },
      prepareConnection,
    })

    await expect(adapter.start()).rejects.toMatchObject({ phase: 'restore-connection' })
    expect(desktop.shutdownForRepair).toHaveBeenCalledOnce()
    expect(desktop.relaunch).toHaveBeenCalledWith(state)

    await adapter.start()
    expect(desktop.shutdownForRepair).toHaveBeenCalledTimes(2)
    expect(desktop.relaunch).toHaveBeenCalledTimes(2)
  })

  it('repairs and validates the selected CLI profile before launching it', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    vi.mocked(cli.inspect).mockResolvedValue({
      installation: { installed: true },
      configured: false,
      managedInstances: [],
      externalSessionDetected: false,
    })
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn() },
      cli,
    })

    await adapter.start({ profileId: 'profile-a' })

    expect(cli.prepareStart).toHaveBeenCalledWith({ profileId: 'profile-a' })
    expect(cli.startNew).toHaveBeenCalledWith({ profileId: 'profile-a' })
  })

  it('restores CLI connection, restarts only managed instances, and leaves external sessions pending', async () => {
    const cli = makeCli({ externalSessionDetected: true })
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => undefined) },
      cli,
    })

    const result = await adapter.restore({ repairSessions: false, repairWorkspaceIndex: false })

    expect(cli.closeManaged).toHaveBeenCalledTimes(2)
    expect(cli.restoreConnection).toHaveBeenCalledOnce()
    expect(cli.validateConnection).toHaveBeenCalledOnce()
    expect(cli.restartManaged).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      closedManagedInstanceIds: ['one', 'two'],
      restartedManagedInstanceIds: ['one', 'two'],
      externalSessionsUnaffected: true,
      pendingNewSession: true,
    })
  })

  it('reports partial restart recovery without terminating an external CLI session', async () => {
    const cli = makeCli({ externalSessionDetected: true })
    vi.mocked(cli.restartManaged).mockRejectedValueOnce(new Error('terminal unavailable'))
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => undefined) },
      cli,
    })

    const error = await adapter.restore({ repairSessions: false }).catch((cause) => cause)

    expect(error).toBeInstanceOf(CodexLifecycleOperationError)
    expect(error).toMatchObject({ phase: 'start', recoveryErrors: ['one: terminal unavailable'] })
    expect(cli.closeManaged).toHaveBeenCalledTimes(2)
  })

  it('classifies a managed close failure before connection repair begins', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    vi.mocked(cli.closeManaged).mockRejectedValueOnce(new Error('process remained alive'))
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => undefined) },
      cli,
    })

    await expect(adapter.restore({ repairSessions: false, repairWorkspaceIndex: false })).rejects.toMatchObject({
      phase: 'close',
      message: expect.stringContaining('process remained alive'),
    })
    expect(cli.restoreConnection).not.toHaveBeenCalled()
  })

  it('preserves the deep-repair phase instead of misclassifying it as validation', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => { throw new Error('session rewrite failed') }) },
      cli,
    })

    await expect(adapter.restore({ repairSessions: true, repairWorkspaceIndex: false })).rejects.toMatchObject({
      phase: 'repair-sessions',
      message: expect.stringContaining('session rewrite failed'),
    })
    expect(cli.validateConnection).not.toHaveBeenCalled()
  })

  it('rejects a resolved managed restart that never becomes running', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    const before = {
      installation: { installed: true, version: '2.0.0', executablePath: 'codex' },
      configured: true,
      managedInstances: [
        { id: 'one', running: true },
        { id: 'two', running: true },
        { id: 'old', running: false },
      ],
      externalSessionDetected: false,
    }
    vi.mocked(cli.inspect)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({
        ...before,
        managedInstances: [
          { id: 'one', running: true },
          { id: 'two', running: false },
          { id: 'old', running: false },
        ],
      })
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => undefined) },
      cli,
    })

    await expect(adapter.restore({ repairSessions: false, repairWorkspaceIndex: false })).rejects.toMatchObject({
      phase: 'start',
      recoveryErrors: ['two: managed instance did not report running after restart'],
    })
  })

  it('passes every running Codex profile directory through repair and preserves instance IDs', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    vi.mocked(cli.inspect).mockResolvedValue({
      installation: { installed: true },
      configured: true,
      managedInstances: [
        { id: 'codex-a', running: true, configDirectory: '/profiles/codex-a', profileId: 'a' },
        { id: 'codex-b', running: true, configDirectory: '/profiles/codex-b', profileId: 'b' },
      ],
      externalSessionDetected: false,
    })
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair: { run: vi.fn(async () => undefined) },
      cli,
    })

    const result = await adapter.restore({ repairSessions: false, repairWorkspaceIndex: false })

    expect(cli.restoreConnection).toHaveBeenCalledWith(['/profiles/codex-a', '/profiles/codex-b'])
    expect(cli.validateConnection).toHaveBeenCalledWith(['/profiles/codex-a', '/profiles/codex-b'])
    expect(cli.restartManaged).toHaveBeenCalledWith('codex-a')
    expect(cli.restartManaged).toHaveBeenCalledWith('codex-b')
    expect(result.restartedManagedInstanceIds).toEqual(['codex-a', 'codex-b'])
  })

  it('passes every running custom CODEX_HOME to deep session repair', async () => {
    const cli = makeCli({ externalSessionDetected: false })
    vi.mocked(cli.inspect).mockResolvedValue({
      installation: { installed: true },
      configured: true,
      managedInstances: [
        { id: 'codex-a', running: true, configDirectory: '/profiles/codex-a' },
        { id: 'codex-b', running: false, configDirectory: '/profiles/codex-b' },
      ],
      externalSessionDetected: false,
    })
    const deepRepair = { run: vi.fn(async () => undefined) }
    const adapter = new CodexLifecycleAdapter({
      target: 'codex-cli',
      desktop: makeDesktop(),
      desktopProbe: makeDesktopProbe({ installed: true, running: false }),
      deepRepair,
      cli,
    })

    await adapter.restore({ repairSessions: true, repairWorkspaceIndex: false })

    expect(deepRepair.run).toHaveBeenCalledWith(
      { preserveRunningState: true },
      ['/profiles/codex-a', '/profiles/codex-b'],
    )
  })
})

function makeDesktop(): ChatGptDesktopController {
  return {
    shutdownForRepair: vi.fn(async () => ({ wasRunning: false, launchTarget: 'Codex.exe' })),
    relaunch: vi.fn(async () => undefined),
  }
}

function makeDesktopProbe(
  value: { installed: boolean; running: boolean; version?: string },
): CodexDesktopProbe {
  return { inspect: vi.fn(async () => ({ configured: true, ...value })) }
}

function makeCli(options: { externalSessionDetected: boolean }): CodexCliPort {
  return {
    inspect: vi.fn(async () => ({
      installation: { installed: true, version: '2.0.0', executablePath: 'codex' },
      configured: true,
      managedInstances: [
        { id: 'one', running: true },
        { id: 'two', running: true },
        { id: 'old', running: false },
      ],
      externalSessionDetected: options.externalSessionDetected,
    })),
    closeManaged: vi.fn(async () => undefined),
    restartManaged: vi.fn(async () => undefined),
    startNew: vi.fn(async () => undefined),
    restoreConnection: vi.fn(async () => undefined),
    validateConnection: vi.fn(async () => undefined),
    prepareStart: vi.fn(async () => undefined),
  }
}
