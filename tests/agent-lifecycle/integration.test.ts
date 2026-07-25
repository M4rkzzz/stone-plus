import { describe, expect, it, vi } from 'vitest'
import {
  ensureSingleModelRouteDefault,
  ManagedCliRuntimePort,
  sanitizeManagedClientLaunchArgs,
} from '../../src/main/agent-lifecycle/integration'
import type { ClientInstanceManager } from '../../src/main/client-instances'
import type { ClientConfigService } from '../../src/main/client-config'
import type { AppStore } from '../../src/main/store/app-store'
import type { ManagedClientInstance, RouteClient } from '../../src/shared/types'

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
