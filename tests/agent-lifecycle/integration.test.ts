import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createAgentLifecycleService,
  ensureSingleModelRouteDefault,
  ManagedCliRuntimePort,
  sanitizeManagedClientLaunchArgs,
} from '../../src/main/agent-lifecycle/integration'
import {
  ClaudeSurfaceLifecycleAdapter,
  type ClaudeDesktopConfigurationPort,
} from '../../src/main/agent-lifecycle/claude-surface-adapter'
import type { ClaudeDesktopInferenceModel } from '../../src/main/agent-lifecycle/claude-desktop-config'
import { ClaudeDesktopOperationCoordinator } from '../../src/main/agent-lifecycle/claude-desktop-operation-coordinator'
import type { AgentExecutableDiscovery } from '../../src/main/agent-lifecycle/platform-discovery'
import type { ClientInstanceManager } from '../../src/main/client-instances'
import type { ClientConfigService } from '../../src/main/client-config'
import type { AppStore } from '../../src/main/store/app-store'
import {
  AGENT_TARGETS,
  agentCapabilities,
  agentRouteClient,
  type AgentTarget,
} from '../../src/shared/agent-lifecycle'
import type { ManagedClientInstance, RouteClient } from '../../src/shared/types'

vi.mock('../../src/main/agent-lifecycle/platform-discovery', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent-lifecycle/platform-discovery')>()
  return {
    ...original,
    discoverAgentExecutable: vi.fn(async (target: AgentTarget) => ({
      target,
      platform: 'win32' as const,
      supported: true,
      installed: true,
      launchTarget: target === 'claude-code-desktop' ? 'claude://code/new' : undefined,
      source: target === 'claude-code-desktop' ? 'windows-app' as const : 'well-known-path' as const,
      processControl: target === 'codex-desktop' ? 'full' as const : 'unavailable' as const,
      inspectedPaths: [],
    })),
  }
})

describe('ManagedCliRuntimePort', () => {
  it.each([
    ['codex', 'codex-cli'],
    ['claude', 'claude-code'],
    ['gemini', 'gemini-cli'],
    ['grokbuild', 'grok-build'],
  ] as const)('refreshes a stale %s executable before starting while preserving profile and cwd', async (client, target) => {
    const existing = instance(client, 'C:\\removed\\old.exe')
    const save = vi.fn(async () => [existing])
    const start = vi.fn(async () => [existing])
    const instances = { list: () => [existing], save, start } as unknown as ClientInstanceManager
    const discover = vi.fn(async () => ({
      target,
      platform: 'win32' as const,
      supported: true,
      installed: true,
      executablePath: `C:\\current\\${target}.exe`,
      source: 'command-path' as const,
      processControl: 'managed-only' as const,
      inspectedPaths: [],
    }))
    const runtime = new ManagedCliRuntimePort(
      instances,
      {} as ClientConfigService,
      {} as AppStore,
      discover,
    )

    await runtime.startNew(client, { profileId: 'profile-1', workingDirectory: 'C:\\requested' })

    expect(discover).toHaveBeenCalledWith(target)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      id: existing.id,
      executablePath: `C:\\current\\${target}.exe`,
      profileId: 'profile-1',
      configDirectory: existing.configDirectory,
      workingDirectory: existing.workingDirectory,
      launchArgs: ['--resume'],
    }))
    expect(start).toHaveBeenCalledWith(existing.id)
  })

  it('migrates an old stopped definition with no executable path before starting', async () => {
    const existing = instance('claude', undefined)
    const save = vi.fn(async () => [existing])
    const start = vi.fn(async () => [existing])
    const runtime = new ManagedCliRuntimePort(
      { list: () => [existing], save, start } as unknown as ClientInstanceManager,
      {} as ClientConfigService,
      {} as AppStore,
      vi.fn(async () => ({
        target: 'claude-code' as const,
        platform: 'win32' as const,
        supported: true,
        installed: true,
        executablePath: 'C:\\current\\claude.exe',
        source: 'command-path' as const,
        processControl: 'managed-only' as const,
        inspectedPaths: [],
      })),
    )

    await runtime.startNew('claude', { profileId: 'profile-1' })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ executablePath: 'C:\\current\\claude.exe' }))
    expect(start).toHaveBeenCalledWith(existing.id)
  })

  it('keeps legacy Claude managed instances owned by the CLI target after launch-only surfaces are added', async () => {
    const existing = instance('claude', 'C:\\removed\\old.exe')
    const save = vi.fn(async () => [existing])
    const start = vi.fn(async () => [existing])
    const discover = vi.fn(async (target: AgentTarget) => ({
      target,
      platform: 'win32' as const,
      supported: true,
      installed: true,
      executablePath: 'C:\\current\\claude.exe',
      source: 'command-path' as const,
      processControl: 'managed-only' as const,
      inspectedPaths: [],
    }))
    const runtime = new ManagedCliRuntimePort(
      { list: () => [existing], save, start } as unknown as ClientInstanceManager,
      {} as ClientConfigService,
      {} as AppStore,
      discover,
    )

    await runtime.startNew('claude', { profileId: 'profile-1' })

    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover).toHaveBeenCalledWith('claude-code')
    expect(discover).not.toHaveBeenCalledWith('claude-code-desktop')
    expect(discover).not.toHaveBeenCalledWith('claude-code-vsc')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: existing.id }))
    expect(start).toHaveBeenCalledWith(existing.id)
  })
})

describe('Claude launch surface integration boundaries', () => {
  it('keeps CLI, Desktop, and VSC as distinct targets sharing the Claude route', () => {
    expect(AGENT_TARGETS).toEqual(expect.arrayContaining([
      'claude-code',
      'claude-code-desktop',
      'claude-code-vsc',
    ]))
    expect(agentRouteClient('claude-code')).toBe('claude')
    expect(agentRouteClient('claude-code-desktop')).toBe('claude')
    expect(agentRouteClient('claude-code-vsc')).toBe('claude')
    expect(agentCapabilities('claude-code').canCloseKnownProcess).toBe(true)
    expect(agentCapabilities('claude-code-desktop').canCloseKnownProcess).toBe(false)
    expect(agentCapabilities('claude-code-vsc').canCloseKnownProcess).toBe(false)
  })

  it('opens Claude Code Desktop through the fixed protocol without forwarding renderer start options', async () => {
    const events: string[] = []
    const openExternal = vi.fn(async (url: string) => {
      events.push(`open:${url}`)
    })
    const prepareRoute = vi.fn(async () => {
      events.push('route:prepare')
    })
    const sharedConfig = sharedClaudeConfiguration()
    const desktopConfig = desktopClaudeConfiguration(events)
    const desktopCoordinator = desktopClaudeCoordinator(desktopConfig)
    const desktopModels = [{ name: 'claude-sonnet-5' }] as const satisfies readonly ClaudeDesktopInferenceModel[]
    const adapter = new ClaudeSurfaceLifecycleAdapter({
      target: 'claude-code-desktop',
      installation: {
        inspect: vi.fn(async () => {
          events.push('installation:inspect')
          return installedSurface('claude-code-desktop')
        }),
      },
      openExternal,
      connection: () => {
        events.push('connection')
        return claudeConnection()
      },
      prepareRoute,
      sharedConfig,
      desktopCoordinator,
      desktopModels: () => {
        events.push('desktop:models')
        return desktopModels
      },
    })

    await adapter.start({
      workingDirectory: 'javascript:renderer-controlled?folder=C:\\sensitive',
      profileId: 'renderer-controlled-profile',
    })

    expect(events).toEqual([
      'installation:inspect',
      'route:prepare',
      'connection',
      'desktop:models',
      'desktop:repair',
      'desktop:validate',
      'open:claude://code/new',
    ])
    expect(prepareRoute).toHaveBeenCalledOnce()
    expect(desktopConfig.repair).toHaveBeenCalledWith(claudeConnection(), desktopModels)
    expect(desktopConfig.validate).toHaveBeenCalledWith(claudeConnection(), desktopModels)
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('claude://code/new')
    expect(sharedConfig.repair).not.toHaveBeenCalled()
    expect(sharedConfig.validate).not.toHaveBeenCalled()
    expect(sharedConfig.rollback).not.toHaveBeenCalled()
  })

  it('uses the injected Desktop configuration owner instead of constructing a private lifecycle copy', async () => {
    const events: string[] = []
    const desktopConfig = desktopClaudeConfiguration(events)
    const claudeDesktopCoordinator = desktopClaudeCoordinator(desktopConfig)
    const openExternal = vi.fn(async (url: string) => {
      events.push(`open:${url}`)
    })
    const service = createAgentLifecycleService({
      store: desktopLifecycleStore(),
      clientConfig: {} as ClientConfigService,
      instances: { list: () => [] } as unknown as ClientInstanceManager,
      codexRepair: {} as never,
      codexDesktop: {} as never,
      installer: {} as never,
      openExternal,
      claudeDesktopCoordinator,
    })
    const desktopAdapter = (service as unknown as {
      adapters: Record<AgentTarget, { start(): Promise<void> }>
    }).adapters['claude-code-desktop']

    await desktopAdapter.start()

    expect(desktopConfig.repair).toHaveBeenCalledOnce()
    expect(desktopConfig.validate).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('claude://code/new')
  })

  it('constructs one bootstrap Desktop configuration owner and injects that same variable', () => {
    const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')

    expect(source.match(/new ClaudeDesktopConfig\(/g)).toHaveLength(1)
    expect(source.match(/new ClaudeDesktopOperationCoordinator\(/g)).toHaveLength(1)
    expect(source).toContain('let claudeDesktopConfig: ClaudeDesktopConfig')
    expect(source).toContain('let claudeDesktopCoordinator: ClaudeDesktopOperationCoordinator')
    expect(source).toContain('claudeDesktopConfig = new ClaudeDesktopConfig()')
    expect(source).toContain('claudeDesktopCoordinator = new ClaudeDesktopOperationCoordinator(claudeDesktopConfig)')
    expect(source).toMatch(/createAgentLifecycleService\(\{[\s\S]*?claudeDesktopCoordinator,[\s\S]*?\}\)/)
    expect(source).toContain('registerClaudeDesktopApi(claudeDesktopCoordinator)')
  })

  it('repairs VSC configuration and opens only the fixed official extension URI', async () => {
    const openExternal = vi.fn(async () => undefined)
    const prepareRoute = vi.fn(async () => undefined)
    const sharedConfig = sharedClaudeConfiguration()
    const vscodeConfig = {
      inspect: vi.fn(async () => true),
      repair: vi.fn(async () => ({ changed: false, rollback: vi.fn(async () => undefined) })),
      validate: vi.fn(async () => undefined),
    }
    const adapter = new ClaudeSurfaceLifecycleAdapter({
      target: 'claude-code-vsc',
      installation: {
        inspect: vi.fn(async () => installedSurface('claude-code-vsc')),
      },
      openExternal,
      connection: claudeConnection,
      prepareRoute,
      sharedConfig,
      vscodeConfig,
    })

    await adapter.start({
      workingDirectory: 'vscode://attacker.invalid/open',
      profileId: '?prompt=renderer-controlled',
    })

    expect(prepareRoute).toHaveBeenCalledOnce()
    expect(sharedConfig.repair).toHaveBeenCalledWith('claude', claudeConnection())
    expect(vscodeConfig.repair).toHaveBeenCalledWith(claudeConnection(), undefined)
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('vscode://anthropic.claude-code/open')
  })
})

describe('managed Claude launch residue', () => {
  it('removes an old upstream model argument while preserving Claude aliases and unrelated flags', () => {
    expect(sanitizeManagedClientLaunchArgs('claude', ['--model', 'gpt-5.5', '--resume']))
      .toEqual(['--resume'])
    expect(sanitizeManagedClientLaunchArgs('claude', ['--model=grok-4.5', '--verbose']))
      .toEqual(['--verbose'])
    expect(sanitizeManagedClientLaunchArgs('claude', ['--model', 'sonnet', '--resume']))
      .toEqual(['--model', 'sonnet', '--resume'])
    expect(sanitizeManagedClientLaunchArgs('codex', ['--model', 'gpt-5.5']))
      .toEqual(['--model', 'gpt-5.5'])
  })
})

describe('single-model client route preparation', () => {
  it('keeps the upstream model in the Claude route instead of the Claude client config', async () => {
    const route = {
      id: 'route-claude', client: 'claude', enabled: true, poolId: 'kiro-provider',
      inboundProtocol: 'anthropic-messages', modelMap: {}, localToken: 'stone_claude_token',
      createdAt: 1, updatedAt: 1,
    } as const
    const snapshot = {
      routes: [route],
      pools: [],
      providers: [{
        id: 'kiro-provider', name: 'Kiro', sourceType: 'official-api', kind: 'anthropic-compatible',
        protocol: 'anthropic-messages', baseUrl: 'https://example.invalid', models: ['claude-opus-4-8', 'claude-opus-5'],
        createdAt: 1, updatedAt: 1,
      }],
      accounts: [{
        id: 'kiro-account', providerId: 'kiro-provider', credentialType: 'api-key', status: 'active',
        modelPolicy: 'selected', modelAllowlist: ['claude-opus-4-8'], availableModels: [], updatedAt: 1,
      }],
    }
    const updateRoute = vi.fn(async () => snapshot)
    const store = { getSnapshot: () => snapshot, updateRoute } as unknown as AppStore

    await ensureSingleModelRouteDefault(store, 'claude')

    expect(updateRoute).toHaveBeenCalledWith({
      ...route,
      modelMap: { '*': 'claude-opus-4-8' },
    })
  })
})

function instance(client: RouteClient, executablePath: string | undefined): ManagedClientInstance {
  return {
    id: `${client}-instance`,
    name: `${client} profile`,
    client,
    configDirectory: 'C:\\profiles\\one',
    workingDirectory: 'C:\\workspace\\one',
    executablePath,
    launchArgs: ['--resume'],
    launchMode: 'terminal',
    routeId: 'route-1',
    profileId: 'profile-1',
    status: 'stopped',
    processAlive: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function claudeConnection() {
  return { gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'stone_claude_test' }
}

function installedSurface(
  target: 'claude-code-desktop' | 'claude-code-vsc',
): AgentExecutableDiscovery {
  return {
    target,
    platform: 'win32',
    supported: true,
    installed: true,
    source: target === 'claude-code-desktop' ? 'windows-app' : 'well-known-path',
    processControl: 'unavailable',
    inspectedPaths: [],
  }
}

function sharedClaudeConfiguration() {
  return {
    inspect: vi.fn(async () => ({ configured: true })),
    repair: vi.fn(async () => ({
      client: 'claude' as const,
      changedFiles: [],
      backups: [],
      removedBackups: [],
      rebuiltRoles: [],
    })),
    validate: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  }
}

function desktopClaudeConfiguration(events: string[]): ClaudeDesktopConfigurationPort {
  return {
    inspect: vi.fn(async () => true),
    repair: vi.fn(async () => {
      events.push('desktop:repair')
      return { changed: true, rollback: vi.fn(async () => undefined) }
    }),
    validate: vi.fn(async () => {
      events.push('desktop:validate')
    }),
  }
}

function desktopClaudeCoordinator(config: ClaudeDesktopConfigurationPort) {
  return new ClaudeDesktopOperationCoordinator({
    ...config,
    restoreOfficial: vi.fn(async () => ({ changed: false, rollback: vi.fn(async () => undefined) })),
  })
}

function desktopLifecycleStore(): AppStore {
  const route = {
    id: 'route-claude',
    client: 'claude',
    enabled: true,
    poolId: 'provider-claude',
    inboundProtocol: 'anthropic-messages',
    modelMap: { '*': 'claude-sonnet-5' },
    localToken: 'stone-claude-token',
    createdAt: 1,
    updatedAt: 1,
  }
  const provider = {
    id: 'provider-claude',
    name: 'Claude source',
    sourceType: 'official-api',
    kind: 'anthropic-compatible',
    protocol: 'anthropic-messages',
    baseUrl: 'https://example.invalid',
    models: ['claude-sonnet-5'],
    createdAt: 1,
    updatedAt: 1,
  }
  const account = {
    id: 'account-claude',
    providerId: provider.id,
    credentialType: 'api-key',
    status: 'active',
    modelPolicy: 'all',
    modelAllowlist: [],
    availableModels: [],
    updatedAt: 1,
  }
  return {
    getSnapshot: () => ({
      gateway: { host: '127.0.0.1', port: 15720 },
      routes: [route],
      pools: [],
      providers: [provider],
      accounts: [account],
    }),
    updateRoute: vi.fn(async () => undefined),
  } as unknown as AppStore
}
