import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeSurfaceLifecycleAdapter,
  type ClaudeDesktopConfigurationPort,
  type ClaudeLaunchSurfaceTarget,
  type ClaudeSharedConfigurationPort,
  type ClaudeSurfaceInstallationPort,
  type ClaudeVscodeConfigurationPort,
} from '../../src/main/agent-lifecycle/claude-surface-adapter'
import type { ClaudeDesktopInferenceModel } from '../../src/main/agent-lifecycle/claude-desktop-config'
import { ClaudeDesktopOperationCoordinator } from '../../src/main/agent-lifecycle/claude-desktop-operation-coordinator'
import type {
  ClientConnectionTarget,
  RepairClientConfigResult,
} from '../../src/main/client-config'
import type { AgentExecutableDiscovery } from '../../src/main/agent-lifecycle/platform-discovery'

const connection: ClientConnectionTarget = {
  gatewayBaseUrl: 'http://127.0.0.1:15720',
  token: 'stone-claude-surface-secret',
}
const desktopModels = [
  { name: 'claude-sonnet-5', anthropicFamilyTier: 'sonnet', isFamilyDefault: true },
] as const satisfies readonly ClaudeDesktopInferenceModel[]

describe('Claude launch-only surface lifecycle adapter', () => {
  it('repairs and validates Desktop configuration in order without touching CLI or VSC configuration', async () => {
    const { adapter, desktopConfig, events, sharedConfig, vscodeConfig } = harness('claude-code-desktop')

    await expect(adapter.restore()).resolves.toEqual({
      wasRunning: false,
      changed: true,
      pendingNewSession: true,
    })

    expect(events).toEqual([
      'installation:inspect',
      'route:prepare',
      'connection',
      'desktop:models',
      'desktop:repair',
      'desktop:validate',
    ])
    expect(desktopConfig.repair).toHaveBeenCalledWith(connection, desktopModels)
    expect(desktopConfig.validate).toHaveBeenCalledWith(connection, desktopModels)
    expect(sharedConfig.repair).not.toHaveBeenCalled()
    expect(sharedConfig.validate).not.toHaveBeenCalled()
    expect(sharedConfig.rollback).not.toHaveBeenCalled()
    expect(vscodeConfig.inspect).not.toHaveBeenCalled()
    expect(vscodeConfig.repair).not.toHaveBeenCalled()
    expect(vscodeConfig.validate).not.toHaveBeenCalled()
  })

  it('restores Desktop configuration before opening the fixed Code URI', async () => {
    const { adapter, events, openExternal } = harness('claude-code-desktop')

    await adapter.start()

    expect(events).toEqual([
      'installation:inspect',
      'route:prepare',
      'connection',
      'desktop:models',
      'desktop:repair',
      'desktop:validate',
      'open:claude://code/new',
    ])
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('claude://code/new')
  })

  it('rolls Desktop configuration back and never exposes the token when validation fails', async () => {
    const { adapter, desktopConfig, desktopRollback, events, openExternal } = harness('claude-code-desktop')
    vi.mocked(desktopConfig.validate).mockImplementationOnce(async () => {
      events.push('desktop:validate')
      throw new Error(`Desktop validation rejected ${connection.token}`)
    })

    const failure = await adapter.start().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(Error)
    expect(events.slice(-2)).toEqual(['desktop:validate', 'desktop:rollback'])
    expect(desktopRollback).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
    expect(String(failure)).not.toContain(connection.token)
  })

  it('repairs and validates shared and VS Code configuration before opening the fixed VSC URI', async () => {
    const { adapter, events, openExternal, sharedConfig, vscodeConfig } = harness('claude-code-vsc')

    await adapter.start()

    expect(events).toEqual([
      'installation:inspect',
      'installation:inspect',
      'route:prepare',
      'connection',
      'shared:repair',
      'vscode:repair',
      'shared:validate',
      'vscode:validate',
      'open:vscode://anthropic.claude-code/open',
    ])
    expect(sharedConfig.repair).toHaveBeenCalledWith('claude', connection)
    expect(vscodeConfig.repair).toHaveBeenCalledWith(
      connection,
      'vscode://anthropic.claude-code/open',
    )
    expect(sharedConfig.validate).toHaveBeenCalledWith('claude', connection)
    expect(vscodeConfig.validate).toHaveBeenCalledWith(
      connection,
      'vscode://anthropic.claude-code/open',
    )
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('vscode://anthropic.claude-code/open')
  })

  it('rolls VS Code back before shared Claude configuration and never exposes the token on failure', async () => {
    const { adapter, events, openExternal, sharedConfig, surfaceRollback, vscodeConfig } = harness('claude-code-vsc')
    vi.mocked(vscodeConfig.validate).mockImplementationOnce(async () => {
      events.push('vscode:validate')
      throw new Error(`VS Code validation rejected ${connection.token}`)
    })

    const failure = await adapter.start().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(Error)
    expect(events.slice(-3)).toEqual([
      'vscode:validate',
      'vscode:rollback',
      'shared:rollback',
    ])
    expect(surfaceRollback).toHaveBeenCalledOnce()
    expect(sharedConfig.rollback).toHaveBeenCalledOnce()
    expect(surfaceRollback.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(sharedConfig.rollback).mock.invocationCallOrder[0])
    expect(openExternal).not.toHaveBeenCalled()
    expect(String(failure)).not.toContain(connection.token)
  })

  it('always reports both host-owned surfaces as stopped and unavailable for process control', async () => {
    const desktop = harness('claude-code-desktop')
    const vsc = harness('claude-code-vsc')

    const [desktopSnapshot, vscSnapshot] = await Promise.all([
      desktop.adapter.getSnapshot(),
      vsc.adapter.getSnapshot(),
    ])

    expect(desktopSnapshot).toMatchObject({
      configured: true,
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable',
    })
    expect(vscSnapshot).toMatchObject({
      configured: true,
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable',
    })
    await expect(desktop.adapter.close()).resolves.toEqual({
      wasRunning: false,
      pendingNewSession: false,
    })
    expect(desktop.desktopConfig.inspect).toHaveBeenCalledWith(connection, desktopModels)
    expect(desktop.desktopConfig.validate).toHaveBeenCalledWith(connection, desktopModels)
  })

  it('marks Desktop configured only when its managed profile inspects and validates successfully', async () => {
    const healthy = harness('claude-code-desktop')
    const notConfigured = harness('claude-code-desktop')
    const invalid = harness('claude-code-desktop')
    vi.mocked(notConfigured.desktopConfig.inspect).mockResolvedValueOnce(false)
    vi.mocked(invalid.desktopConfig.validate).mockRejectedValueOnce(new Error('Desktop invalid'))

    await expect(healthy.adapter.getSnapshot()).resolves.toMatchObject({ configured: true })
    await expect(notConfigured.adapter.getSnapshot()).resolves.toMatchObject({ configured: false })
    await expect(invalid.adapter.getSnapshot()).resolves.toMatchObject({ configured: false })

    expect(notConfigured.desktopConfig.validate).not.toHaveBeenCalled()
    expect(invalid.desktopConfig.validate).toHaveBeenCalledWith(connection, desktopModels)
  })

  it('marks VSC configured only after both shared and VS Code validation succeed', async () => {
    const healthy = harness('claude-code-vsc')
    const invalidShared = harness('claude-code-vsc')
    const invalidVscode = harness('claude-code-vsc')
    vi.mocked(invalidShared.sharedConfig.validate).mockRejectedValueOnce(new Error('shared invalid'))
    vi.mocked(invalidVscode.vscodeConfig.validate).mockRejectedValueOnce(new Error('VS Code invalid'))

    await expect(healthy.adapter.getSnapshot()).resolves.toMatchObject({ configured: true })
    await expect(invalidShared.adapter.getSnapshot()).resolves.toMatchObject({ configured: false })
    await expect(invalidVscode.adapter.getSnapshot()).resolves.toMatchObject({ configured: false })

    expect(healthy.sharedConfig.validate).toHaveBeenCalledWith('claude', connection)
    expect(healthy.vscodeConfig.validate).toHaveBeenCalledWith(
      connection,
      'vscode://anthropic.claude-code/open',
    )
    expect(invalidShared.vscodeConfig.validate).not.toHaveBeenCalled()
    expect(invalidVscode.vscodeConfig.validate).toHaveBeenCalledOnce()
  })
})

function harness(target: ClaudeLaunchSurfaceTarget) {
  const events: string[] = []
  const launchTarget = target === 'claude-code-desktop'
    ? 'claude://code/new'
    : 'vscode://anthropic.claude-code/open'
  const installation: ClaudeSurfaceInstallationPort = {
    inspect: vi.fn(async () => {
      events.push('installation:inspect')
      return installedSurface(target, launchTarget)
    }),
  }
  const sharedRepair: RepairClientConfigResult = {
    client: 'claude',
    changedFiles: ['/home/alice/.claude/settings.json'],
    backups: [],
    removedBackups: [],
    rebuiltRoles: [],
  }
  const sharedConfig: ClaudeSharedConfigurationPort = {
    repair: vi.fn(async () => {
      events.push('shared:repair')
      return sharedRepair
    }),
    validate: vi.fn(async () => {
      events.push('shared:validate')
    }),
    rollback: vi.fn(async () => {
      events.push('shared:rollback')
    }),
  }
  const surfaceRollback = vi.fn(async () => {
    events.push('vscode:rollback')
  })
  const desktopRollback = vi.fn(async () => {
    events.push('desktop:rollback')
  })
  const desktopConfig: ClaudeDesktopConfigurationPort = {
    inspect: vi.fn(async () => {
      events.push('desktop:inspect')
      return true
    }),
    repair: vi.fn(async () => {
      events.push('desktop:repair')
      return { changed: true, rollback: desktopRollback }
    }),
    validate: vi.fn(async () => {
      events.push('desktop:validate')
    }),
  }
  const desktopCoordinator = new ClaudeDesktopOperationCoordinator({
    ...desktopConfig,
    restoreOfficial: vi.fn(async () => ({ changed: false, rollback: vi.fn(async () => undefined) })),
  })
  const vscodeConfig: ClaudeVscodeConfigurationPort = {
    inspect: vi.fn(async () => {
      events.push('vscode:inspect')
      return true
    }),
    repair: vi.fn(async () => {
      events.push('vscode:repair')
      return { changed: true, rollback: surfaceRollback }
    }),
    validate: vi.fn(async () => {
      events.push('vscode:validate')
    }),
  }
  const openExternal = vi.fn(async (url: string) => {
    events.push(`open:${url}`)
  })
  const adapter = new ClaudeSurfaceLifecycleAdapter({
    target,
    installation,
    openExternal,
    connection: () => {
      events.push('connection')
      return connection
    },
    prepareRoute: async () => {
      events.push('route:prepare')
    },
    sharedConfig,
    desktopCoordinator,
    desktopModels: () => {
      events.push('desktop:models')
      return desktopModels
    },
    vscodeConfig,
  })
  return {
    adapter,
    desktopConfig,
    desktopRollback,
    events,
    installation,
    openExternal,
    sharedConfig,
    sharedRepair,
    surfaceRollback,
    vscodeConfig,
  }
}

function installedSurface(
  target: ClaudeLaunchSurfaceTarget,
  launchTarget: string,
): AgentExecutableDiscovery {
  return {
    target,
    platform: 'win32',
    supported: true,
    installed: true,
    launchTarget,
    source: target === 'claude-code-desktop' ? 'windows-app' : 'well-known-path',
    processControl: 'unavailable',
    inspectedPaths: [],
  }
}
