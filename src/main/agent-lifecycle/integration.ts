import { execFile } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import type { AgentRestoreOptions, AgentStartOptions, AgentTarget } from '@shared/agent-lifecycle'
import { agentRouteClient } from '@shared/agent-lifecycle'
import {
  clientNativeProtocols,
  type ManagedClientInstance,
  type PoolProtocol,
  type RouteClient,
} from '@shared/types'
import { enumerateRouteSourceModels, listRouteSources, resolveRouteSource } from '@shared/route-sources'
import {
  CodexSessionRepairService,
  type ChatGptDesktopController,
  type CodexRepairAndRestartOptions,
  type CodexRepairAndRestartService,
} from '../codex'
import { findBlockingWindowsCodexPids } from '../codex/windows-codex-processes'
import type { ClientConfigService } from '../client-config'
import type { ClientConnectionTarget } from '../client-config'
import { sanitizeManagedClientLaunchArgs, type ClientInstanceManager } from '../client-instances'
import type { AppStore } from '../store/app-store'
import type { AgentInstallationService } from '../agent-installation'
import {
  ClaudeCodeLifecycleAdapter,
  GeminiCliLifecycleAdapter,
  GrokBuildLifecycleAdapter,
  type ConnectionOnlyCliLifecycleAdapter,
  type CliInstallationPort,
  type CliRuntimePort,
} from './cli-connection-adapter'
import { ClientConfigConnectionPort } from './client-config-connection-port'
import { resolveClaudeDesktopInferenceModels } from './claude-desktop-models'
import type { ClaudeDesktopOperationCoordinatorPort } from './claude-desktop-operation-coordinator'
import { ClaudeSurfaceLifecycleAdapter } from './claude-surface-adapter'
import { ClaudeVscodeConfig } from './claude-vscode-config'
import {
  CodexLifecycleAdapter,
  type CodexCliPort,
  type CodexDesktopProbe,
} from './codex-adapter'
import { discoverAgentExecutable } from './platform-discovery'
import {
  AgentLifecycleService,
  type AgentAdapterSnapshot,
  type AgentLifecycleAdapterPort,
  type AgentRouteState,
} from './service'

export interface CreateAgentLifecycleServiceOptions {
  store: AppStore
  clientConfig: ClientConfigService
  instances: ClientInstanceManager
  codexRepair: CodexRepairAndRestartService
  codexDesktop: ChatGptDesktopController
  installer: AgentInstallationService
  openExternal(url: string): Promise<unknown>
  claudeDesktopCoordinator: ClaudeDesktopOperationCoordinatorPort
}

export function createAgentLifecycleService(options: CreateAgentLifecycleServiceOptions): AgentLifecycleService {
  const connection = (client: RouteClient) => resolveConnection(options.store, client)
  const configPort = new ClientConfigConnectionPort(options.clientConfig)
  const installation = new DiscoveryInstallationPort()
  const desktopProbe = new DefaultCodexDesktopProbe()
  const cliRuntime = new ManagedCliRuntimePort(options.instances, options.clientConfig, options.store)
  const surfaceInstallation = {
    inspect: (target: 'claude-code-desktop' | 'claude-code-vsc') => discoverAgentExecutable(target),
  }

  // `paths` is present on the production ClientConfigService. Keeping this
  // fallback also preserves narrow structural test doubles and integrations
  // that only expose the transactional methods.
  const configuredDefaultCodexHome = options.clientConfig.paths?.codex?.directory
  const defaultCodexHome = configuredDefaultCodexHome
    ? resolvePath(configuredDefaultCodexHome)
    : undefined
  const prepareDefaultCodexConnection = () => repairAndValidateConnection(
    configPort,
    'codex',
    connection('codex'),
  )
  const codexDeepRepair = {
    run: async (
      repairOptions: CodexRepairAndRestartOptions = {},
      configDirectories: readonly string[] = [],
    ) => {
      const homes = configDirectories.length > 0
        ? uniqueFilesystemPaths(configDirectories)
        : defaultCodexHome ? [defaultCodexHome] : []
      if (homes.length === 0) {
        return options.codexRepair.run({
          ...repairOptions,
          beforeRepair: async () => {
            await prepareDefaultCodexConnection()
            await repairOptions.beforeRepair?.()
          },
        })
      }
      const results: unknown[] = []
      for (const codexHome of homes) {
        if (defaultCodexHome && sameFilesystemPath(codexHome, defaultCodexHome)) {
          results.push(await options.codexRepair.run({
            ...repairOptions,
            beforeRepair: async () => {
              await prepareDefaultCodexConnection()
              await repairOptions.beforeRepair?.()
            },
          }))
          continue
        }
        // Managed CLI instances can own an isolated CODEX_HOME. They have
        // already been stopped by CodexLifecycleAdapter, so repair that exact
        // home directly instead of silently rewriting ~/.codex.
        await repairOptions.beforeRepair?.()
        const operationOptions = repairOptions.signal || repairOptions.onProgress
          ? { signal: repairOptions.signal, onProgress: repairOptions.onProgress }
          : undefined
        const scopedRepair = new CodexSessionRepairService({ codexHome })
        results.push(operationOptions
          ? await scopedRepair.analyzeAndRepair(
              repairOptions.targetProvider,
              repairOptions.expectedRevision,
              operationOptions,
            )
          : await scopedRepair.analyzeAndRepair(
              repairOptions.targetProvider,
              repairOptions.expectedRevision,
            ))
      }
      return results.length === 1 ? results[0] : results
    },
  }
  const codexCli = new ManagedCodexCliPort(
    options.instances,
    options.clientConfig,
    options.store,
    installation,
    configPort,
  )
  const codexDesktopAdapter = new CodexLifecycleAdapter({
    target: 'codex-desktop',
    desktop: options.codexDesktop,
    desktopProbe,
    deepRepair: codexDeepRepair,
    prepareConnection: prepareDefaultCodexConnection,
  })
  const codexCliAdapter = new CodexLifecycleAdapter({
    target: 'codex-cli',
    desktop: options.codexDesktop,
    desktopProbe,
    deepRepair: codexDeepRepair,
    cli: codexCli,
  })
  const claudeAdapter = new ClaudeCodeLifecycleAdapter({
    installation,
    runtime: cliRuntime,
    config: configPort,
  })
  const claudeDesktopAdapter = new ClaudeSurfaceLifecycleAdapter({
    target: 'claude-code-desktop',
    installation: surfaceInstallation,
    openExternal: options.openExternal,
    connection: () => connection('claude'),
    prepareRoute: () => ensureSingleModelRouteDefault(options.store, 'claude'),
    sharedConfig: configPort,
    desktopCoordinator: options.claudeDesktopCoordinator,
    desktopModels: () => resolveClaudeDesktopInferenceModels(options.store),
  })
  const claudeVscAdapter = new ClaudeSurfaceLifecycleAdapter({
    target: 'claude-code-vsc',
    installation: surfaceInstallation,
    openExternal: options.openExternal,
    connection: () => connection('claude'),
    prepareRoute: () => ensureSingleModelRouteDefault(options.store, 'claude'),
    sharedConfig: configPort,
    vscodeConfig: new ClaudeVscodeConfig(),
  })
  const geminiAdapter = new GeminiCliLifecycleAdapter({
    installation,
    runtime: cliRuntime,
    config: configPort,
  })
  const grokBuildAdapter = new GrokBuildLifecycleAdapter({
    installation,
    runtime: cliRuntime,
    config: configPort,
  })

  const adapters: Record<AgentTarget, AgentLifecycleAdapterPort> = {
    'codex-desktop': {
      target: 'codex-desktop',
      inspect: async () => {
        const [state, configured] = await Promise.all([
          codexDesktopAdapter.getSnapshot(),
          isConnectionConfigured(configPort, 'codex', () => connection('codex')),
        ])
        return adapterSnapshot(state, configured)
      },
      close: () => codexDesktopAdapter.close(),
      restore: (restoreOptions) => codexDesktopAdapter.restore(restoreOptions),
      start: (startOptions) => codexDesktopAdapter.start(startOptions),
    },
    'codex-cli': {
      target: 'codex-cli',
      inspect: async () => adapterSnapshot(await codexCliAdapter.getSnapshot()),
      close: () => codexCliAdapter.close(),
      restore: (restoreOptions) => codexCliAdapter.restore(restoreOptions),
      start: (startOptions) => codexCliAdapter.start(startOptions),
    },
    'claude-code': connectionOnlyPort(
      claudeAdapter,
      () => connection('claude'),
      () => ensureSingleModelRouteDefault(options.store, 'claude'),
    ),
    'claude-code-desktop': launchSurfacePort(claudeDesktopAdapter),
    'claude-code-vsc': launchSurfacePort(claudeVscAdapter),
    'gemini-cli': connectionOnlyPort(geminiAdapter, () => connection('gemini')),
    'grok-build': connectionOnlyPort(grokBuildAdapter, () => connection('grokbuild')),
  }

  return new AgentLifecycleService({
    adapters,
    installer: options.installer,
    resolveRoute: (target) => resolveRouteState(options.store, target),
  })
}

function launchSurfacePort(adapter: ClaudeSurfaceLifecycleAdapter): AgentLifecycleAdapterPort {
  return {
    target: adapter.target,
    inspect: async () => adapterSnapshot(await adapter.getSnapshot()),
    close: () => adapter.close(),
    restore: (restoreOptions) => adapter.restore(restoreOptions),
    start: (startOptions) => adapter.start(startOptions),
  }
}

function connectionOnlyPort(
  adapter: ConnectionOnlyCliLifecycleAdapter,
  connection: () => ClientConnectionTarget,
  prepareRoute?: () => Promise<void>,
): AgentLifecycleAdapterPort {
  const preparedConnection = async () => {
    await prepareRoute?.()
    return connection()
  }
  return {
    target: adapter.target,
    inspect: async () => {
      const state = await adapter.getSnapshot()
      let configured = false
      try { configured = await adapter.isConfiguredFor(connection()) } catch { /* Missing/disabled route. */ }
      return adapterSnapshot(state, configured)
    },
    close: async () => {
      const before = await adapter.getSnapshot()
      const result = await adapter.close()
      return { wasRunning: before.running, pendingNewSession: result.externalSessionsUnaffected }
    },
    restore: async (restoreOptions?: AgentRestoreOptions) => adapter.restore(
      await preparedConnection(),
      {},
      restoreOptions?.preserveRunningState !== false,
    ),
    start: async (options?: AgentStartOptions) => adapter.start(options, await preparedConnection()),
  }
}

function adapterSnapshot(
  state: {
    installation: { installed: boolean; version?: string }
    configured: boolean
    running: boolean
    managedInstanceCount: number
    processControl: AgentAdapterSnapshot['processControl']
    externalSessionDetected?: boolean
  },
  configured = state.configured,
): AgentAdapterSnapshot {
  return {
    installed: state.installation.installed,
    ...(state.installation.version ? { version: state.installation.version } : {}),
    configured,
    running: state.running,
    managedInstanceCount: state.managedInstanceCount,
    processControl: state.processControl,
    pendingNewSession: state.externalSessionDetected === true,
  }
}

async function isConnectionConfigured(
  config: ClientConfigConnectionPort,
  client: RouteClient,
  connection: () => ClientConnectionTarget,
  configDirectory?: string,
): Promise<boolean> {
  try {
    await config.validate(client, connection(), configDirectory)
    return true
  } catch {
    return false
  }
}

async function repairAndValidateConnection(
  config: ClientConfigConnectionPort,
  client: RouteClient,
  target: ClientConnectionTarget,
  configDirectory?: string,
): Promise<void> {
  const repair = await config.repair(client, target, configDirectory ? { configDirectory } : {})
  try {
    await config.validate(client, target, configDirectory)
  } catch (cause) {
    try {
      await config.rollback(client, repair)
    } catch (rollbackCause) {
      throw new Error(`Connection validation failed and rollback also failed: ${messageOf(cause)}; rollback: ${messageOf(rollbackCause)}`)
    }
    throw cause
  }
}

class DiscoveryInstallationPort implements CliInstallationPort {
  async inspect(target: 'claude-code' | 'gemini-cli') {
    const result = await discoverAgentExecutable(target)
    return {
      installed: result.installed,
      ...(result.executablePath ? { executablePath: result.executablePath } : {}),
    }
  }

  inspectAny(target: Exclude<AgentTarget, 'codex-desktop'>) {
    return discoverAgentExecutable(target)
  }
}

export class ManagedCliRuntimePort implements CliRuntimePort {
  constructor(
    private readonly instances: ClientInstanceManager,
    private readonly clientConfig: ClientConfigService,
    private readonly store: AppStore,
    private readonly discover: typeof discoverAgentExecutable = discoverAgentExecutable,
  ) {}

  async snapshot(client: RouteClient) {
    return {
      managedInstances: this.instances.list()
        .filter((instance) => instance.client === client)
        .map((instance) => ({
          id: instance.id,
          running: isRunning(instance),
          configDirectory: instance.configDirectory,
          ...(instance.profileId ? { profileId: instance.profileId } : {}),
          ...(instance.lastStartedAt ? { lastStartedAt: instance.lastStartedAt } : {}),
        })),
      // External processes are deliberately neither enumerated nor controlled.
      externalSessionDetected: false,
    }
  }

  async closeManaged(instanceId: string): Promise<void> {
    await this.instances.stop(instanceId)
  }

  async startManaged(instanceId: string): Promise<void> {
    await this.instances.start(instanceId)
  }

  async startNew(client: RouteClient, options?: AgentStartOptions): Promise<void> {
    const existing = selectInstance(this.instances.list(), client, options?.profileId)
    if (existing) {
      if (!isRunning(existing)) {
        const target = agentTargetForClient(client)
        const executable = await this.discover(target)
        if (!executable.installed || !executable.executablePath) throw new Error(`${target} executable was not found.`)
        await this.instances.save({
          ...existing,
          executablePath: executable.executablePath,
          launchArgs: sanitizeManagedClientLaunchArgs(client, existing.launchArgs),
        })
      }
      await this.instances.start(existing.id)
      return
    }
    const target = agentTargetForClient(client)
    const executable = await this.discover(target)
    if (!executable.installed || !executable.executablePath) throw new Error(`${target} executable was not found.`)
    const snapshot = this.store.getSnapshot()
    const profile = options?.profileId
      ? snapshot.clientProfiles.find((candidate) => candidate.id === options.profileId && candidate.client === client)
      : snapshot.clientProfiles.find((candidate) => candidate.client === client && candidate.isDefault)
    if (options?.profileId && !profile) throw new Error('Client configuration profile not found.')
    const route = enabledNativeRoute(this.store, client)
    const before = new Set(this.instances.list().map((instance) => instance.id))
    const created = await this.instances.save({
      name: `${displayName(target)} · Stone+`,
      client,
      configDirectory: profile?.directory ?? this.clientConfig.paths[client].directory,
      ...(options?.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      executablePath: executable.executablePath,
      launchArgs: [],
      launchMode: process.platform === 'win32' ? 'terminal' : 'background',
      routeId: route.id,
      ...(profile ? { profileId: profile.id } : {}),
    })
    const instance = created.find((candidate) => !before.has(candidate.id))
    if (!instance) throw new Error('Managed Agent instance was not created.')
    await this.instances.start(instance.id)
  }
}

function agentTargetForClient(client: RouteClient): Exclude<AgentTarget, 'codex-desktop'> {
  if (client === 'claude') return 'claude-code'
  if (client === 'gemini') return 'gemini-cli'
  if (client === 'grokbuild') return 'grok-build'
  return 'codex-cli'
}

export { sanitizeManagedClientLaunchArgs } from '../client-instances'

class ManagedCodexCliPort implements CodexCliPort {
  private repairResults: Array<{
    configDirectory?: string
    repair: Awaited<ReturnType<ClientConfigConnectionPort['repair']>>
  }> = []
  private readonly runtime: ManagedCliRuntimePort

  constructor(
    private readonly instances: ClientInstanceManager,
    private readonly clientConfig: ClientConfigService,
    private readonly store: AppStore,
    private readonly installation: DiscoveryInstallationPort,
    private readonly config: ClientConfigConnectionPort,
  ) {
    this.runtime = new ManagedCliRuntimePort(instances, clientConfig, store)
  }

  async inspect() {
    const [installation, runtime] = await Promise.all([
      this.installation.inspectAny('codex-cli'),
      this.runtime.snapshot('codex'),
    ])
    const runningDirectories = uniqueRuntimeConfigDirectories(
      runtime.managedInstances.filter((instance) => instance.running),
    )
    const configured = await this.validateConfiguredScopes(runningDirectories)
    return {
      installation: {
        installed: installation.installed,
        ...(installation.executablePath ? { executablePath: installation.executablePath } : {}),
      },
      configured,
      managedInstances: runtime.managedInstances,
      externalSessionDetected: runtime.externalSessionDetected,
    }
  }

  closeManaged(instanceId: string): Promise<void> { return this.runtime.closeManaged(instanceId) }
  restartManaged(instanceId: string): Promise<void> { return this.runtime.startManaged(instanceId) }
  startNew(options?: AgentStartOptions): Promise<void> { return this.runtime.startNew('codex', options) }

  async prepareStart(options?: AgentStartOptions): Promise<void> {
    const configDirectory = this.resolveStartConfigDirectory(options)
    const scopes = configDirectory ? [configDirectory] : []
    await this.restoreConnection(scopes)
    await this.validateConnection(scopes)
  }

  async restoreConnection(configDirectories: readonly string[] = []): Promise<void> {
    this.repairResults = []
    const scopes: Array<string | undefined> = configDirectories.length > 0 ? [...new Set(configDirectories)] : [undefined]
    try {
      for (const configDirectory of scopes) {
        const repair = await this.config.repair('codex', resolveConnection(this.store, 'codex'), { configDirectory })
        this.repairResults.push({ configDirectory, repair })
      }
    } catch (cause) {
      await this.rollbackRepairs()
      throw cause
    }
  }

  async validateConnection(configDirectories: readonly string[] = []): Promise<void> {
    try {
      const scopes: Array<string | undefined> = configDirectories.length > 0 ? [...new Set(configDirectories)] : [undefined]
      for (const configDirectory of scopes) {
        await this.config.validate('codex', resolveConnection(this.store, 'codex'), configDirectory)
      }
    } catch (cause) {
      await this.rollbackRepairs()
      throw cause
    } finally {
      this.repairResults = []
    }
  }

  private async rollbackRepairs(): Promise<void> {
    const failures: string[] = []
    for (const { repair } of [...this.repairResults].reverse()) {
      try { await this.config.rollback('codex', repair) } catch (cause) { failures.push(String(cause)) }
    }
    if (failures.length > 0) throw new Error(`Codex profile rollback failed: ${failures.join('; ')}`)
  }

  private resolveStartConfigDirectory(options?: AgentStartOptions): string | undefined {
    const existing = selectInstance(this.instances.list(), 'codex', options?.profileId)
    if (existing) return existing.configDirectory
    const snapshot = this.store.getSnapshot()
    const profile = options?.profileId
      ? snapshot.clientProfiles.find((candidate) => candidate.id === options.profileId && candidate.client === 'codex')
      : snapshot.clientProfiles.find((candidate) => candidate.client === 'codex' && candidate.isDefault)
    if (options?.profileId && !profile) throw new Error('Client configuration profile not found.')
    return profile?.directory ?? this.clientConfig.paths.codex.directory
  }

  private async validateConfiguredScopes(configDirectories: readonly string[]): Promise<boolean> {
    let target: ClientConnectionTarget
    try { target = resolveConnection(this.store, 'codex') } catch { return false }
    const scopes: Array<string | undefined> = configDirectories.length > 0 ? [...new Set(configDirectories)] : [undefined]
    try {
      for (const configDirectory of scopes) await this.config.validate('codex', target, configDirectory)
      return true
    } catch {
      return false
    }
  }
}

class DefaultCodexDesktopProbe implements CodexDesktopProbe {
  async inspect() {
    const installation = await discoverAgentExecutable('codex-desktop')
    const running = process.platform === 'win32'
      ? (await findBlockingWindowsCodexPids()).length > 0
      : process.platform === 'darwin'
        ? await hasMacCodexProcess()
        : false
    return {
      installed: installation.installed,
      ...(installation.executablePath ? { executablePath: installation.executablePath } : {}),
      configured: installation.installed,
      running,
    }
  }
}

function uniqueRuntimeConfigDirectories(
  instances: ReadonlyArray<{ configDirectory?: string }>,
): string[] {
  return [...new Set(instances
    .map((instance) => instance.configDirectory)
    .filter((value): value is string => Boolean(value)))]
}

function uniqueFilesystemPaths(paths: readonly string[]): string[] {
  const resolved = new Map<string, string>()
  for (const path of paths) {
    const absolute = resolvePath(path)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (!resolved.has(key)) resolved.set(key, absolute)
  }
  return [...resolved.values()]
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolvePath(left).toLowerCase() === resolvePath(right).toLowerCase()
    : resolvePath(left) === resolvePath(right)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function resolveRouteState(store: AppStore, target: AgentTarget): AgentRouteState {
  const client = agentRouteClient(target)
  const snapshot = store.getSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.client === client && candidate.enabled)
  if (!route) return { enabled: false, compatibility: 'unsupported' }
  const source = listRouteSources(snapshot).find((candidate) => candidate.id === route.poolId)
  return {
    enabled: true,
    compatibility: route.inboundProtocol === clientNativeProtocols[client] ? 'native' : 'unsupported',
    sourceId: route.poolId,
    sourceName: source?.name ?? route.poolId,
  }
}

function resolveConnection(store: AppStore, client: RouteClient): ClientConnectionTarget {
  const snapshot = store.getSnapshot()
  const route = enabledNativeRoute(store, client)
  if (!route.localToken) throw new Error(`The ${client} route has no local token.`)
  const host = snapshot.gateway.host.includes(':') ? `[${snapshot.gateway.host}]` : snapshot.gateway.host
  return { gatewayBaseUrl: `http://${host}:${snapshot.gateway.port}`, token: route.localToken }
}

function enabledNativeRoute(store: AppStore, client: RouteClient) {
  const route = store.getSnapshot().routes.find((candidate) => (
    candidate.client === client
    && candidate.enabled
    && candidate.inboundProtocol === clientNativeProtocols[client]
  ))
  if (!route) throw new Error(`No enabled native ${client} route is available.`)
  return route
}

/** Keep client-native model names out of provider configuration. A route-layer
 * wildcard is safe only when a translated source exposes one unambiguous
 * upstream model; explicit exact/default mappings remain authoritative. */
export async function ensureSingleModelRouteDefault(store: AppStore, client: RouteClient): Promise<void> {
  const snapshot = store.getSnapshot()
  const route = snapshot.routes.find((candidate) => (
    candidate.client === client
    && candidate.enabled
    && candidate.inboundProtocol === clientNativeProtocols[client]
  ))
  if (!route || Object.hasOwn(route.modelMap, '*')) return
  const source = resolveRouteSource(route.poolId, snapshot)
  if (!source || !requiresSingleModelFallback(client, source.summary.protocol)) return
  const exposed = enumerateRouteSourceModels(source, snapshot)
  if (exposed.length !== 1) return
  await store.updateRoute({ ...route, modelMap: { ...route.modelMap, '*': exposed[0] } })
}

function requiresSingleModelFallback(client: RouteClient, sourceProtocol: PoolProtocol): boolean {
  return client !== 'grokbuild' && sourceProtocol !== clientNativeProtocols[client]
}

function selectInstance(instances: ManagedClientInstance[], client: RouteClient, profileId?: string) {
  return instances
    .filter((instance) => instance.client === client && (!profileId || instance.profileId === profileId))
    .sort((left, right) => (right.lastStartedAt ?? 0) - (left.lastStartedAt ?? 0))[0]
}

function isRunning(instance: ManagedClientInstance): boolean {
  return instance.processAlive === true || instance.status === 'running' || instance.status === 'starting'
}

function displayName(target: Exclude<AgentTarget, 'codex-desktop'>): string {
  if (target === 'codex-cli') return 'Codex CLI'
  if (target === 'claude-code') return 'Claude Code CLI'
  if (target === 'claude-code-desktop') return 'Claude Code Desktop'
  if (target === 'claude-code-vsc') return 'Claude Code VSC'
  return target === 'gemini-cli' ? 'Gemini CLI' : 'Grok Build'
}

function hasMacCodexProcess(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'Codex|ChatGPT'], { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => {
      resolve(!error && String(stdout).trim().length > 0)
    })
  })
}
