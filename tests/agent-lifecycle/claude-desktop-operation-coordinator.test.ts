import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeDesktopOperationCoordinator,
  type ClaudeDesktopConfigurationPort,
  type ClaudeDesktopOfficialModeConfigurationPort,
} from '../../src/main/agent-lifecycle/claude-desktop-operation-coordinator'
import { ClaudeSurfaceLifecycleAdapter } from '../../src/main/agent-lifecycle/claude-surface-adapter'

type CoordinatorConfigPort = ClaudeDesktopConfigurationPort
  & ClaudeDesktopOfficialModeConfigurationPort

describe('Claude Desktop operation coordinator', () => {
  it('serializes takeover before a later official restore so the last request wins', async () => {
    const events: string[] = []
    const takeoverGate = deferred<void>()
    let mode: 'official' | 'stone' = 'official'
    const config = createConfig({
      restoreOfficial: vi.fn(async () => {
        events.push('official:start')
        mode = 'official'
        events.push('official:end')
        return noChangeRepair()
      }),
    })
    const coordinator = new ClaudeDesktopOperationCoordinator(config)

    const takeover = coordinator.runExclusive(async () => {
      events.push('takeover:start')
      await takeoverGate.promise
      mode = 'stone'
      events.push('takeover:end')
    })
    await vi.waitFor(() => expect(events).toEqual(['takeover:start']))

    const restore = coordinator.restoreOfficial()
    await Promise.resolve()
    expect(config.restoreOfficial).not.toHaveBeenCalled()

    takeoverGate.resolve()
    await Promise.all([takeover, restore])

    expect(events).toEqual([
      'takeover:start',
      'takeover:end',
      'official:start',
      'official:end',
    ])
    expect(mode).toBe('official')
  })

  it('serializes official restore before a later takeover so the last request wins', async () => {
    const events: string[] = []
    const restoreStarted = deferred<void>()
    const restoreGate = deferred<void>()
    let mode: 'official' | 'stone' = 'stone'
    const config = createConfig({
      restoreOfficial: vi.fn(async () => {
        events.push('official:start')
        restoreStarted.resolve()
        await restoreGate.promise
        mode = 'official'
        events.push('official:end')
        return noChangeRepair()
      }),
    })
    const coordinator = new ClaudeDesktopOperationCoordinator(config)

    const restore = coordinator.restoreOfficial()
    await restoreStarted.promise
    const takeover = coordinator.runExclusive(async () => {
      events.push('takeover:start')
      mode = 'stone'
      events.push('takeover:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['official:start'])

    restoreGate.resolve()
    await Promise.all([restore, takeover])

    expect(events).toEqual([
      'official:start',
      'official:end',
      'takeover:start',
      'takeover:end',
    ])
    expect(mode).toBe('stone')
  })

  it('releases the queue after a failed operation and runs the accepted restore', async () => {
    const events: string[] = []
    const failureGate = deferred<void>()
    const config = createConfig({
      restoreOfficial: vi.fn(async () => {
        events.push('official')
        return noChangeRepair()
      }),
    })
    const coordinator = new ClaudeDesktopOperationCoordinator(config)

    const failure = coordinator.runExclusive(async () => {
      events.push('takeover:start')
      await failureGate.promise
      events.push('takeover:fail')
      throw new Error('takeover failed')
    })
    const observedFailure = failure.catch((cause: unknown) => cause)
    await vi.waitFor(() => expect(events).toEqual(['takeover:start']))

    const restore = coordinator.restoreOfficial()
    await Promise.resolve()
    expect(config.restoreOfficial).not.toHaveBeenCalled()

    failureGate.resolve()
    const [cause] = await Promise.all([observedFailure, restore])

    expect(cause).toEqual(new Error('takeover failed'))
    expect(events).toEqual(['takeover:start', 'takeover:fail', 'official'])
    expect(config.restoreOfficial).toHaveBeenCalledOnce()
  })

  it('keeps opening Claude Desktop inside the takeover lock', async () => {
    const events: string[] = []
    const openStarted = deferred<void>()
    const openGate = deferred<void>()
    const config = createConfig({
      repair: vi.fn(async () => {
        events.push('repair')
        return noChangeRepair()
      }),
      validate: vi.fn(async () => {
        events.push('validate')
      }),
      restoreOfficial: vi.fn(async () => {
        events.push('official')
        return noChangeRepair()
      }),
    })
    const coordinator = new ClaudeDesktopOperationCoordinator(config)
    const adapter = new ClaudeSurfaceLifecycleAdapter({
      target: 'claude-code-desktop',
      installation: {
        inspect: vi.fn(async () => ({
          target: 'claude-code-desktop',
          platform: 'win32',
          supported: true,
          installed: true,
          launchTarget: 'claude://untrusted-discovery-target',
          source: 'windows-app',
          processControl: 'unavailable',
          inspectedPaths: [],
        })),
      },
      openExternal: vi.fn(async (url: string) => {
        events.push(`open:start:${url}`)
        openStarted.resolve()
        await openGate.promise
        events.push('open:end')
      }),
      connection: () => ({
        gatewayBaseUrl: 'http://127.0.0.1:15720',
        token: 'stone-desktop-secret',
      }),
      prepareRoute: vi.fn(async () => {
        events.push('route')
      }),
      sharedConfig: {
        repair: vi.fn(async () => ({
          client: 'claude',
          changedFiles: [],
          backups: [],
          removedBackups: [],
          rebuiltRoles: [],
        })),
        validate: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
      },
      desktopCoordinator: coordinator,
      desktopModels: () => [{
        name: 'claude-sonnet-5',
        anthropicFamilyTier: 'sonnet',
        isFamilyDefault: true,
      }],
    })

    const takeover = adapter.start()
    await openStarted.promise
    const restore = coordinator.restoreOfficial()
    await Promise.resolve()

    expect(config.restoreOfficial).not.toHaveBeenCalled()
    expect(events).toEqual([
      'route',
      'repair',
      'validate',
      'open:start:claude://code/new',
    ])

    openGate.resolve()
    await Promise.all([takeover, restore])

    expect(events).toEqual([
      'route',
      'repair',
      'validate',
      'open:start:claude://code/new',
      'open:end',
      'official',
    ])
  })
})

function createConfig(overrides: Partial<CoordinatorConfigPort> = {}): CoordinatorConfigPort {
  return {
    inspect: vi.fn(async () => true),
    repair: vi.fn(async () => noChangeRepair()),
    validate: vi.fn(async () => undefined),
    restoreOfficial: vi.fn(async () => noChangeRepair()),
    ...overrides,
  }
}

function noChangeRepair() {
  return {
    changed: false,
    rollback: vi.fn(async () => undefined),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
