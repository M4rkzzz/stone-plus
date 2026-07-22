import type {
  BuiltInProxyErrorCategory,
  BuiltInProxyImportInput,
  BuiltInProxyNodeSummary,
  BuiltInProxyRuntimeState,
  BuiltInProxySettings,
  OutboundNetworkMode,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '@shared/types'
import type {
  BuiltInProxyReconcileReason,
  BuiltInProxyRuntimeFacade,
  BuiltInProxyStoreFacade,
} from '../../ipc/built-in-proxy-api'
import type { AppStore } from '../../store/app-store'
import type {
  BuiltInProxyProfileSecrets,
  BuiltInProxyProfileStoreInput,
} from '../../store/types'
import type {
  BuiltInOutboundTargetDetector,
  BuiltInRouteChangeCoordinator,
} from '../outbound-reload-coordinator'
import {
  buildSingBoxConfig,
  outboundTagForNodeId,
  type BuildSingBoxConfigInput,
  type BuildSingBoxConfigResult,
} from './config-builder'
import type { ChromiumMixedSessionGeneration } from './chromium-route-session'
import {
  parseBuiltInProxyProfile,
  type ParseBuiltInProxyProfileOptions,
} from './profile-parser'
import {
  summarizeBuiltInProxyProfile,
  type ParsedBuiltInProxyProfile,
} from './profile-types'
import type {
  BuiltInProxyRouteActivation,
  BuiltInProxyRouteCoordinator,
  BuiltInProxyRouteError,
} from './route-coordinator'
import type {
  SingBoxRuntimeEvent,
  SingBoxRuntimeState,
  SingBoxService,
} from './sing-box-service'
import type { SystemProxyLease } from './system-proxy-lease'
import type { TunController, TunEndpoint, TunRoutingContext } from './tun-controller'

const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 30_000
const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024

export type BuiltInProxyPersistence = Pick<
  AppStore,
  | 'getBuiltInProxySettings'
  | 'listBuiltInProxyProfiles'
  | 'getBuiltInProxyProfile'
  | 'getBuiltInProxyProfileSecrets'
  | 'saveBuiltInProxyProfile'
  | 'deleteBuiltInProxyProfile'
  | 'selectBuiltInProxyProfile'
  | 'selectBuiltInProxyNode'
  | 'updateBuiltInProxySettings'
  | 'setBuiltInProxyDesiredEnabled'
  | 'markBuiltInProxyActivated'
  | 'setBuiltInProxyNodeLatency'
  | 'getRuntimeGatewaySettings'
>

export type BuiltInProxyCore = Pick<
  SingBoxService,
  | 'getState'
  | 'start'
  | 'retry'
  | 'stop'
  | 'close'
  | 'onEvent'
  | 'refreshConnections'
  | 'testLatency'
  | 'getTraffic'
  | 'getConnections'
  | 'closeConnection'
>

export type BuiltInProxyRoutes = Pick<
  BuiltInProxyRouteCoordinator,
  | 'getSnapshot'
  | 'subscribe'
  | 'setRetryHandler'
  | 'addDirectLoopbackPorts'
  | 'requestEnable'
  | 'markStarting'
  | 'activate'
  | 'reportError'
  | 'failClosed'
  | 'beginDisable'
  | 'disableFailed'
  | 'completeDisable'
  | 'isIntercepting'
  | 'isReady'
  | 'drainRetired'
>

export type BuiltInSystemProxyLease = Pick<
  SystemProxyLease,
  'getState' | 'acquire' | 'release' | 'retryRelease' | 'recoverStaleLease'
>

export type BuiltInTunController = Pick<
  TunController,
  'getState' | 'start' | 'retryStart' | 'stop' | 'retryStop'
>

export interface BuiltInProxyOrchestratorOptions {
  store: BuiltInProxyPersistence
  core: BuiltInProxyCore
  routes: BuiltInProxyRoutes
  systemProxyLease: BuiltInSystemProxyLease
  tunController: BuiltInTunController
  createChromiumGeneration(mixedEndpoint: string): Promise<ChromiumMixedSessionGeneration>
  /** Must be a Stone-routed fetch implementation; raw Node direct fetch is not used implicitly. */
  subscriptionFetch: typeof fetch
  localGateway: TunEndpoint
  dnsUpstreams?: readonly TunEndpoint[]
  additionalTunExcludedCidrs?: readonly string[]
  parseProfile?: (
    input: string | Buffer,
    options?: ParseBuiltInProxyProfileOptions,
  ) => ParsedBuiltInProxyProfile
  buildConfiguration?: (input: BuildSingBoxConfigInput) => BuildSingBoxConfigResult
  reloadExternalSystemProxy?: () => Promise<void>
  detectBuiltInTargets?: BuiltInOutboundTargetDetector
  coordinateBuiltInRouteChange?: BuiltInRouteChangeCoordinator
  scheduleBuiltInRouteChange?: (detector: BuiltInOutboundTargetDetector) => void
  now?: () => number
  subscriptionTimeoutMs?: number
  logger?: Pick<Console, 'warn' | 'error'>
}

interface PersistenceSnapshot {
  settings: BuiltInProxySettings
  profiles: Array<{
    summary: BuiltInProxyRuntimeState['profiles'][number]
    secrets?: BuiltInProxyProfileSecrets
  }>
}

interface PreparedConfiguration {
  profile: BuiltInProxyRuntimeState['profiles'][number]
  parsed: ParsedBuiltInProxyProfile
  built: BuildSingBoxConfigResult
}

/**
 * Main-process owner for the built-in proxy lifecycle. It implements both IPC
 * facades so persistence mutations and route transitions share one serial
 * transaction queue without coupling IPC to AppStore or Electron sessions.
 */
export class BuiltInProxyOrchestrator implements BuiltInProxyStoreFacade, BuiltInProxyRuntimeFacade {
  private readonly store: BuiltInProxyPersistence
  private readonly core: BuiltInProxyCore
  private readonly routes: BuiltInProxyRoutes
  private readonly systemProxyLease: BuiltInSystemProxyLease
  private readonly tunController: BuiltInTunController
  private readonly createChromiumGeneration: BuiltInProxyOrchestratorOptions['createChromiumGeneration']
  private readonly subscriptionFetch: typeof fetch
  private readonly localGateway: TunEndpoint
  private readonly dnsUpstreams: readonly TunEndpoint[]
  private readonly additionalTunExcludedCidrs: readonly string[]
  private readonly parseProfile: NonNullable<BuiltInProxyOrchestratorOptions['parseProfile']>
  private readonly buildConfiguration: NonNullable<BuiltInProxyOrchestratorOptions['buildConfiguration']>
  private readonly reloadExternalSystemProxy?: () => Promise<void>
  private readonly detectBuiltInTargets?: BuiltInOutboundTargetDetector
  private readonly coordinateBuiltInRouteChange?: BuiltInRouteChangeCoordinator
  private readonly scheduleBuiltInRouteChange?: BuiltInProxyOrchestratorOptions['scheduleBuiltInRouteChange']
  private readonly now: () => number
  private readonly subscriptionTimeoutMs: number
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly listeners = new Set<(state: BuiltInProxyRuntimeState) => void>()
  private operationTail: Promise<void> = Promise.resolve()
  private unsubscribeRoute: () => void
  private unsubscribeCore: () => void
  private lastReadyAt?: number
  private transitionStatus?: BuiltInProxyRuntimeState['status']
  private transitionError?: BuiltInProxyRouteError
  private crashRecoveryPending = false
  private closed = false

  public constructor(options: BuiltInProxyOrchestratorOptions) {
    this.store = options.store
    this.core = options.core
    this.routes = options.routes
    this.systemProxyLease = options.systemProxyLease
    this.tunController = options.tunController
    this.createChromiumGeneration = options.createChromiumGeneration
    this.subscriptionFetch = options.subscriptionFetch
    this.localGateway = { ...options.localGateway }
    this.dnsUpstreams = options.dnsUpstreams?.map((endpoint) => ({ ...endpoint })) ?? [
      { host: '1.1.1.1', port: 53, transport: 'udp' },
      { host: '8.8.8.8', port: 53, transport: 'udp' },
    ]
    this.additionalTunExcludedCidrs = [...(options.additionalTunExcludedCidrs ?? [])]
    this.parseProfile = options.parseProfile ?? parseBuiltInProxyProfile
    this.buildConfiguration = options.buildConfiguration ?? buildSingBoxConfig
    this.reloadExternalSystemProxy = options.reloadExternalSystemProxy
    this.detectBuiltInTargets = options.detectBuiltInTargets
    this.coordinateBuiltInRouteChange = options.coordinateBuiltInRouteChange
    this.scheduleBuiltInRouteChange = options.scheduleBuiltInRouteChange
    this.now = options.now ?? Date.now
    this.subscriptionTimeoutMs = Math.max(1_000, options.subscriptionTimeoutMs ?? DEFAULT_SUBSCRIPTION_TIMEOUT_MS)
    this.logger = options.logger ?? console
    this.routes.setRetryHandler(() => this.retry())
    this.unsubscribeRoute = this.routes.subscribe(() => this.emit())
    this.unsubscribeCore = this.core.onEvent((event) => this.onCoreEvent(event))
  }

  public getState(): BuiltInProxyRuntimeState {
    const settings = this.store.getBuiltInProxySettings()
    const route = this.routes.getSnapshot()
    const core = this.core.getState()
    const error = this.transitionError ?? route.error ?? coreError(core)
    return {
      desiredEnabled: settings.desiredEnabled,
      status: this.transitionStatus ?? route.status,
      routeGeneration: route.effectiveRoute.generation,
      settings,
      profiles: this.store.listBuiltInProxyProfiles(),
      effectiveRoute: route.effectiveRoute,
      coreVersion: core.version,
      ...(core.startedAt !== undefined ? { startedAt: core.startedAt } : {}),
      ...(this.lastReadyAt !== undefined ? { lastReadyAt: this.lastReadyAt } : {}),
      ...(error ? { error: publicRouteError(error) } : {}),
    }
  }

  public subscribe(listener: (state: BuiltInProxyRuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Repairs a crash journal before ordinary networking starts, then honors the
   * persisted auto-start preference. main/index should await this method before
   * starting the gateway or issuing background upstream requests.
   */
  public initialize(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      const persisted = this.store.getBuiltInProxySettings()
      try {
        const recovery = await this.systemProxyLease.recoverStaleLease()
        // If an earlier bootstrap repair was transiently unable to restore the
        // journal, Chromium may still hold the stale mixed snapshot. Refresh
        // it before any external-system request can start.
        if (
          recovery.status !== 'none'
          && this.externalNetworkMode() === 'system'
          && this.reloadExternalSystemProxy
        ) {
          await this.reloadExternalSystemProxy()
        }
      } catch (error) {
        const failure = classifyError(error, 'system-proxy')
        this.transitionError = failure
        if (persisted.desiredEnabled && persisted.hasEverActivated) this.routes.failClosed(failure)
        else this.routes.reportError(failure)
        this.emit()
        throw new BuiltInProxyOperationError(failure.category, failure.message, true, error)
      }
      const settings = this.store.getBuiltInProxySettings()
      if (!settings.desiredEnabled) {
        this.emit()
        return
      }
      const profile = this.resolveActiveProfile()
      if (!profile && !settings.hasEverActivated) {
        this.handleMissingProfile(settings)
        return
      }
      if (!settings.autoStart) {
        const failure: BuiltInProxyRouteError = {
          category: 'health-check',
          message: 'Built-in proxy auto-start is disabled while the enabled route is persisted; retry to start it.',
          retryable: true,
        }
        this.transitionError = failure
        this.routes.failClosed(failure)
        this.emit()
        return
      }
      if (profile) await this.enableExclusive(false)
      else this.handleMissingProfile(settings)
    })
  }

  public setEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      await this.store.setBuiltInProxyDesiredEnabled(enabled)
      this.transitionError = undefined
      if (enabled) {
        if (!this.resolveActiveProfile()) {
          this.handleMissingProfile(this.store.getBuiltInProxySettings())
          return
        }
        await this.enableExclusive(false)
      } else {
        await this.disableExclusive()
      }
    })
  }

  public retry(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      this.transitionError = undefined
      if (this.store.getBuiltInProxySettings().desiredEnabled) {
        if (!this.resolveActiveProfile()) {
          this.handleMissingProfile(this.store.getBuiltInProxySettings())
          return
        }
        await this.enableExclusive(true)
      } else {
        await this.disableExclusive()
      }
    })
  }

  public reconcile(reason: BuiltInProxyReconcileReason): Promise<void> {
    return this.enqueue(() => this.reconcileExclusive(reason))
  }

  public coordinateMutation(
    reason: BuiltInProxyReconcileReason,
    mutation: () => Promise<void>,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      const before = this.capturePersistence()
      try {
        await mutation()
        await this.reconcileExclusive(reason)
      } catch (error) {
        await this.restorePersistence(before).catch((restoreError: unknown) => {
          this.logger.error('[built-in-proxy] Could not roll back the persisted proxy mutation', restoreError)
        })
        if (before.settings.desiredEnabled && before.profiles.length > 0) {
          try {
            await this.enableExclusive(false)
          } catch (restoreRuntimeError) {
            this.routes.failClosed(classifyError(restoreRuntimeError))
          }
        }
        this.emit()
        const fallback = reason === 'profile-refreshed'
          ? 'subscription-update'
          : 'configuration-invalid'
        const failure = classifyError(error, fallback)
        throw new BuiltInProxyOperationError(
          failure.category,
          failure.message,
          failure.retryable,
          error,
        )
      }
    })
  }

  public async importProfile(input: BuiltInProxyImportInput): Promise<void> {
    this.assertOpen()
    const fetchedAt = this.now()
    const content = input.source === 'subscription'
      ? await this.fetchSubscription(input.url, input.token)
      : input.content
    const parsed = this.parseProfile(content, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.format ? { formatHint: input.format } : {}),
    })
    await this.store.saveBuiltInProxyProfile(this.toStoreInput(
      parsed,
      input.source,
      input.source === 'subscription'
        ? {
            configuration: parsed,
            subscriptionUrl: input.url,
            ...(input.token ? { subscriptionToken: input.token } : {}),
          }
        : { configuration: parsed },
      undefined,
      input.source === 'subscription' ? fetchedAt : undefined,
    ))
  }

  public async refreshProfile(id: string): Promise<void> {
    this.assertOpen()
    const existing = this.requireProfile(id)
    if (existing.source !== 'subscription') {
      throw new BuiltInProxyOperationError('subscription-update', 'Only subscription profiles can be refreshed.', false)
    }
    const secrets = this.requireProfileSecrets(id)
    if (!secrets.subscriptionUrl) {
      throw new BuiltInProxyOperationError('subscription-update', 'The encrypted subscription URL is unavailable.', false)
    }
    const content = await this.fetchSubscription(secrets.subscriptionUrl, secrets.subscriptionToken)
    const parsed = this.parseProfile(content, {
      profileId: existing.id,
      name: existing.name,
      formatHint: existing.format,
    })
    await this.store.saveBuiltInProxyProfile(this.toStoreInput(
      parsed,
      'subscription',
      {
        configuration: parsed,
        subscriptionUrl: secrets.subscriptionUrl,
        ...(secrets.subscriptionToken ? { subscriptionToken: secrets.subscriptionToken } : {}),
      },
      existing,
      this.now(),
    ))
  }

  public async deleteProfile(id: string): Promise<void> {
    this.assertOpen()
    await this.store.deleteBuiltInProxyProfile(id)
  }

  public async selectProfile(id: string): Promise<void> {
    this.assertOpen()
    await this.store.selectBuiltInProxyProfile(id)
  }

  public async selectNode(profileId: string, nodeId: string): Promise<void> {
    this.assertOpen()
    await this.store.selectBuiltInProxyNode(profileId, nodeId)
  }

  public async updateSettings(
    patch: Partial<Pick<BuiltInProxySettings, 'ruleMode' | 'accessMode' | 'lanEnabled' | 'autoStart'>>,
  ): Promise<void> {
    this.assertOpen()
    await this.store.updateBuiltInProxySettings(patch)
  }

  public testLatency(profileId?: string, nodeIds?: string[]): Promise<BuiltInProxyNodeSummary[]> {
    return this.enqueue(async () => {
      this.assertOpen()
      const profile = profileId ? this.requireProfile(profileId) : this.resolveActiveProfile()
      if (!profile) throw new BuiltInProxyOperationError('configuration-invalid', 'No active proxy profile is available.', false)
      const activeProfileId = this.store.getBuiltInProxySettings().activeProfileId
      if (profile.id !== activeProfileId || this.core.getState().status !== 'ready') {
        throw new BuiltInProxyOperationError(
          'node-handshake',
          'Latency testing requires the selected profile to be active and ready.',
          true,
        )
      }
      const selectedIds = nodeIds?.length ? new Set(nodeIds) : undefined
      const nodes = profile.nodes.filter((node) => !selectedIds || selectedIds.has(node.id))
      for (const node of nodes) {
        await this.store.setBuiltInProxyNodeLatency(profile.id, node.id, { latencyStatus: 'testing' })
      }
      await Promise.all(nodes.map(async (node) => {
        try {
          const result = await this.core.testLatency(outboundTagForNodeId(node.id))
          await this.store.setBuiltInProxyNodeLatency(profile.id, node.id, {
            latencyStatus: 'available',
            latencyMs: result.delayMs,
            lastTestedAt: result.testedAt,
          })
        } catch (error) {
          await this.store.setBuiltInProxyNodeLatency(profile.id, node.id, {
            latencyStatus: isTimeoutError(error) ? 'timeout' : 'error',
            lastTestedAt: this.now(),
          })
        }
      }))
      return this.requireProfile(profile.id).nodes
    })
  }

  public getTraffic(): Promise<ProxyTrafficSnapshot> {
    return this.core.getTraffic()
  }

  public async listConnections(): Promise<ProxyConnectionSummary[]> {
    const connections = await this.core.getConnections()
    const profile = this.resolveActiveProfile()
    if (!profile) return connections
    const tags = new Map(profile.nodes.map((node) => [outboundTagForNodeId(node.id), node.id]))
    return connections.map((connection) => {
      const nodeId = tags.get(connection.outbound)
      return {
        ...connection,
        profileId: profile.id,
        ...(nodeId ? { nodeId } : {}),
      }
    })
  }

  public closeConnection(id: string): Promise<void> {
    return this.core.closeConnection(id)
  }

  /** Release process-owned networking without changing the persisted desired switch. */
  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.routes.setRetryHandler(undefined)
    this.unsubscribeCore()
    this.unsubscribeRoute()
    await this.operationTail.catch(() => undefined)
    await Promise.allSettled([
      this.systemProxyLease.release(),
      this.tunController.stop(),
    ])
    if (this.routes.isIntercepting()) this.routes.completeDisable()
    await this.routes.drainRetired().catch(() => undefined)
    await this.core.close().catch(() => undefined)
    this.listeners.clear()
  }

  private async reconcileExclusive(reason: BuiltInProxyReconcileReason): Promise<void> {
    this.assertOpen()
    if (reason === 'auto-start-changed' || !this.store.getBuiltInProxySettings().desiredEnabled) {
      this.emit()
      return
    }
    await this.enableExclusive(false)
    if (this.detectBuiltInTargets) {
      if (this.scheduleBuiltInRouteChange) {
        this.scheduleBuiltInRouteChange(this.detectBuiltInTargets)
      } else {
        void this.coordinateBuiltInRouteChange?.(this.detectBuiltInTargets).catch((error: unknown) => {
          this.logger.warn('[built-in-proxy] Enabled-source detection failed after a route change', error)
        })
      }
    }
  }

  private async enableExclusive(retryCore: boolean): Promise<void> {
    const settings = this.store.getBuiltInProxySettings()
    if (!this.resolveActiveProfile()) {
      this.handleMissingProfile(settings)
      return
    }
    const prepared = this.prepareConfiguration(settings)
    this.transitionStatus = 'starting'
    this.transitionError = undefined
    if (this.routes.isIntercepting()) this.routes.markStarting()
    else this.routes.requestEnable()
    this.emit()

    let generation: ChromiumMixedSessionGeneration | undefined
    try {
      const core = retryCore && this.core.getState().desiredEnabled
        ? await this.core.retry()
        : await this.core.start({
            config: prepared.built.config,
            mixedPort: settings.mixedPort,
            allowLan: settings.lanEnabled,
          })
      assertHealthyCore(core)
      if (prepared.built.requestedNodeMissing && prepared.built.activeNodeId) {
        await this.store.selectBuiltInProxyNode(prepared.profile.id, prepared.built.activeNodeId)
      }
      await this.prepareAccess(settings, prepared.parsed, core)
      generation = await this.createChromiumGeneration(core.mixedEndpoint!)
      this.activateRoute(generation, core, prepared)
      generation = undefined
      await this.store.markBuiltInProxyActivated(core.mixedPort!, this.now())
      this.lastReadyAt = this.now()
      this.transitionStatus = undefined
      this.transitionError = undefined
      this.crashRecoveryPending = false
      this.emit()
      await this.runInitialDetection()
    } catch (error) {
      await generation?.dispose().catch(() => undefined)
      await this.releaseAccessBestEffort()
      await this.core.stop().catch(() => undefined)
      const failure = classifyError(error)
      const tunDenied = failure.category === 'tun-elevation'
      if (this.routes.getSnapshot().hasActivated || tunDenied) this.routes.failClosed(failure)
      else this.routes.reportError(failure)
      this.transitionStatus = undefined
      this.transitionError = failure
      this.emit()
      throw new BuiltInProxyOperationError(failure.category, failure.message, failure.retryable, error)
    }
  }

  private async activateRestartedCore(): Promise<void> {
    const settings = this.store.getBuiltInProxySettings()
    if (!settings.desiredEnabled) return
    const prepared = this.prepareConfiguration(settings)
    const core = this.core.getState()
    assertHealthyCore(core)
    let generation: ChromiumMixedSessionGeneration | undefined
    try {
      await this.prepareAccess(settings, prepared.parsed, core)
      generation = await this.createChromiumGeneration(core.mixedEndpoint!)
      this.activateRoute(generation, core, prepared)
      generation = undefined
      this.lastReadyAt = this.now()
      this.transitionStatus = undefined
      this.transitionError = undefined
      this.crashRecoveryPending = false
      this.emit()
      await this.runInitialDetection()
    } catch (error) {
      await generation?.dispose().catch(() => undefined)
      await this.releaseAccessBestEffort()
      const failure = classifyError(error)
      this.routes.failClosed(failure)
      this.transitionError = failure
      this.emit()
    }
  }

  private activateRoute(
    generation: ChromiumMixedSessionGeneration,
    core: SingBoxRuntimeState,
    prepared: PreparedConfiguration,
  ): void {
    const activation: BuiltInProxyRouteActivation = {
      fetchImplementation: generation.fetchImplementation,
      mixedEndpoint: generation.mixedEndpoint,
      routeKind: this.store.getBuiltInProxySettings().accessMode === 'tun'
        ? 'built-in-tun'
        : 'built-in-mixed',
      profileId: prepared.profile.id,
      ...(prepared.built.activeNodeId ? { nodeId: prepared.built.activeNodeId } : {}),
      directLoopbackPorts: [core.controllerPort!, this.localGateway.port!],
      refresh: async () => {
        await this.core.refreshConnections()
        await generation.refresh()
      },
      dispose: () => generation.dispose(),
    }
    this.routes.addDirectLoopbackPorts(activation.directLoopbackPorts ?? [])
    this.routes.activate(activation)
  }

  private async disableExclusive(): Promise<void> {
    this.transitionStatus = 'stopping'
    this.transitionError = undefined
    this.routes.beginDisable()
    this.emit()
    try {
      await this.releaseAccessStrict()
      if (this.externalNetworkMode() === 'system') {
        if (!this.reloadExternalSystemProxy) {
          throw new BuiltInProxyOperationError(
            'system-proxy',
            'The external system-proxy reload callback is unavailable.',
            true,
          )
        }
        // OutboundTransportManager owns the tested five-second single-flight
        // boundary, including late-result semantics; do not stack a timeout.
        await this.reloadExternalSystemProxy()
      }
      this.routes.completeDisable()
      await this.routes.drainRetired()
      await this.core.stop()
      this.transitionStatus = undefined
      this.transitionError = undefined
      this.emit()
    } catch (error) {
      const failure = classifyError(error, 'system-proxy')
      this.routes.disableFailed(failure)
      this.transitionStatus = undefined
      this.transitionError = failure
      this.emit()
      throw new BuiltInProxyOperationError(failure.category, failure.message, true, error)
    }
  }

  private prepareConfiguration(settings: BuiltInProxySettings): PreparedConfiguration {
    const profile = this.resolveActiveProfile()
    if (!profile) throw new BuiltInProxyOperationError('configuration-invalid', 'No active proxy profile is available.', false)
    const secrets = this.requireProfileSecrets(profile.id)
    const parsed = validateParsedProfile(secrets.configuration)
    const built = this.buildConfiguration({
      profile: parsed,
      activeNodeId: profile.activeNodeId,
      mode: settings.ruleMode,
      accessMode: settings.accessMode,
      dnsServers: this.dnsUpstreams.map((endpoint) => endpoint.host),
    })
    return { profile, parsed, built }
  }

  private async prepareAccess(
    settings: BuiltInProxySettings,
    profile: ParsedBuiltInProxyProfile,
    core: SingBoxRuntimeState,
  ): Promise<void> {
    if (settings.accessMode === 'system') {
      if (this.tunController.getState().status !== 'stopped') await this.tunController.stop()
      await this.systemProxyLease.acquire({
        mixed: { host: '127.0.0.1', port: core.mixedPort! },
      })
      return
    }
    if (this.systemProxyLease.getState().status !== 'idle') await this.systemProxyLease.release()
    await this.tunController.start(this.createTunRoutingContext(profile, core))
  }

  private createTunRoutingContext(
    profile: ParsedBuiltInProxyProfile,
    core: SingBoxRuntimeState,
  ): TunRoutingContext {
    if (!this.localGateway.port) {
      throw new BuiltInProxyOperationError('configuration-invalid', 'TUN requires the local gateway port.', false)
    }
    return {
      localGateway: { ...this.localGateway },
      mixed: { host: '127.0.0.1', port: core.mixedPort, transport: 'tcp' },
      controller: { host: '127.0.0.1', port: core.controllerPort, transport: 'tcp' },
      singBoxProcessId: core.pid!,
      nodeServers: profile.nodes.map((node) => ({
        host: node.server,
        port: node.serverPort,
        transport: 'any' as const,
      })),
      dnsUpstreams: this.dnsUpstreams.map((endpoint) => ({ ...endpoint })),
      additionalExcludedCidrs: [...this.additionalTunExcludedCidrs],
    }
  }

  private async releaseAccessStrict(): Promise<void> {
    const results = await Promise.allSettled([
      this.systemProxyLease.release(),
      this.tunController.stop(),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  private async releaseAccessBestEffort(): Promise<void> {
    const results = await Promise.allSettled([
      this.systemProxyLease.release(),
      this.tunController.stop(),
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('[built-in-proxy] Could not release an access-mode resource', result.reason)
      }
    }
  }

  private onCoreEvent(event: SingBoxRuntimeEvent): void {
    if (this.closed) return
    if (event.type === 'crash') {
      if (!this.store.getBuiltInProxySettings().desiredEnabled) return
      const failure: BuiltInProxyRouteError = {
        category: 'core-crashed',
        message: event.state.error?.message ?? `sing-box exited unexpectedly (${event.exit}).`,
        retryable: true,
      }
      // This must be synchronous with the child exit notification: queuing the
      // route pointer swap would leave a direct/old-generation leak window.
      this.crashRecoveryPending = true
      this.transitionError = failure
      this.routes.failClosed(failure)
      this.emit()
      void this.enqueue(async () => {
        await this.releaseAccessBestEffort()
      })
      return
    }
    if (event.type === 'state' && event.state.status === 'ready' && this.crashRecoveryPending) {
      void this.enqueue(() => this.activateRestartedCore())
      return
    }
    if (event.type === 'state') this.emit()
  }

  private async runInitialDetection(): Promise<void> {
    if (!this.detectBuiltInTargets || !this.coordinateBuiltInRouteChange) return
    try {
      await this.coordinateBuiltInRouteChange(this.detectBuiltInTargets)
    } catch (error) {
      // Target diagnostics do not invalidate an already healthy fail-closed
      // transport generation; their existing categories are reported by the
      // account/network diagnostics pipeline.
      this.logger.warn('[built-in-proxy] Enabled-source detection failed after activation', error)
    }
  }

  private async fetchSubscription(url: string, token?: string): Promise<string> {
    const headers = new Headers({ Accept: 'application/json, text/yaml, text/plain;q=0.9, */*;q=0.1' })
    if (token) headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    try {
      response = await this.subscriptionFetch(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.subscriptionTimeoutMs),
      })
    } catch (error) {
      throw new BuiltInProxyOperationError('subscription-update', 'Could not download the proxy subscription.', true, error)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new BuiltInProxyOperationError(
        'subscription-update',
        `The proxy subscription returned HTTP ${response.status}.`,
        response.status >= 500,
      )
    }
    try {
      return await readLimitedText(response, MAX_SUBSCRIPTION_BYTES)
    } catch (error) {
      throw new BuiltInProxyOperationError('subscription-update', 'The proxy subscription response is invalid or too large.', false, error)
    }
  }

  private toStoreInput(
    parsed: ParsedBuiltInProxyProfile,
    source: 'subscription' | 'import',
    secrets: BuiltInProxyProfileSecrets,
    existing?: BuiltInProxyRuntimeState['profiles'][number],
    lastRefreshAt?: number,
  ): BuiltInProxyProfileStoreInput {
    const summary = summarizeBuiltInProxyProfile(parsed)
    const previousNodes = new Map(existing?.nodes.map((node) => [node.id, node]) ?? [])
    const nodes: BuiltInProxyNodeSummary[] = summary.nodes.map((node) => {
      const previous = previousNodes.get(node.id)
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        groupIds: [...node.groupIds],
        latencyStatus: previous?.latencyStatus ?? 'untested',
        ...(previous?.latencyMs !== undefined ? { latencyMs: previous.latencyMs } : {}),
        ...(previous?.lastTestedAt !== undefined ? { lastTestedAt: previous.lastTestedAt } : {}),
      }
    })
    const activeNodeId = existing?.activeNodeId && nodes.some((node) => node.id === existing.activeNodeId)
      ? existing.activeNodeId
      : nodes[0]?.id
    return {
      id: existing?.id ?? parsed.id,
      name: parsed.name,
      source,
      format: parsed.format,
      nodes,
      groupCount: summary.groupCount,
      ruleStatus: summary.ruleStatus,
      ...(activeNodeId ? { activeNodeId } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
      ...(lastRefreshAt !== undefined ? { lastRefreshAt } : {}),
      secrets,
    }
  }

  private capturePersistence(): PersistenceSnapshot {
    return {
      settings: structuredClone(this.store.getBuiltInProxySettings()),
      profiles: this.store.listBuiltInProxyProfiles().map((summary) => ({
        summary: structuredClone(summary),
        secrets: structuredClone(this.store.getBuiltInProxyProfileSecrets(summary.id)),
      })),
    }
  }

  private async restorePersistence(snapshot: PersistenceSnapshot): Promise<void> {
    const expectedIds = new Set(snapshot.profiles.map(({ summary }) => summary.id))
    for (const profile of this.store.listBuiltInProxyProfiles()) {
      if (!expectedIds.has(profile.id)) await this.store.deleteBuiltInProxyProfile(profile.id)
    }
    for (const { summary, secrets } of snapshot.profiles) {
      await this.store.saveBuiltInProxyProfile({
        id: summary.id,
        name: summary.name,
        source: summary.source,
        format: summary.format,
        nodes: structuredClone(summary.nodes),
        groupCount: summary.groupCount,
        ruleStatus: summary.ruleStatus,
        ...(summary.activeNodeId ? { activeNodeId: summary.activeNodeId } : {}),
        ...(summary.warning ? { warning: summary.warning } : {}),
        ...(summary.lastRefreshAt !== undefined ? { lastRefreshAt: summary.lastRefreshAt } : {}),
        ...(secrets ? { secrets: structuredClone(secrets) } : {}),
      })
    }
    await this.store.updateBuiltInProxySettings({
      desiredEnabled: snapshot.settings.desiredEnabled,
      ...(snapshot.settings.activeProfileId ? { activeProfileId: snapshot.settings.activeProfileId } : {}),
      accessMode: snapshot.settings.accessMode,
      ruleMode: snapshot.settings.ruleMode,
      mixedPort: snapshot.settings.mixedPort,
      lanEnabled: snapshot.settings.lanEnabled,
      autoStart: snapshot.settings.autoStart,
    })
  }

  private resolveActiveProfile(): BuiltInProxyRuntimeState['profiles'][number] | undefined {
    const settings = this.store.getBuiltInProxySettings()
    const profiles = this.store.listBuiltInProxyProfiles()
    return profiles.find((profile) => profile.id === settings.activeProfileId) ?? profiles[0]
  }

  private handleMissingProfile(settings: BuiltInProxySettings): void {
    this.transitionStatus = undefined
    if (!settings.hasEverActivated) {
      // First-run guidance: remember intent without touching the external route.
      this.transitionError = undefined
      this.emit()
      return
    }
    const failure: BuiltInProxyRouteError = {
      category: 'configuration-invalid',
      message: 'The previously activated built-in proxy has no usable profile.',
      retryable: false,
    }
    this.transitionError = failure
    this.routes.failClosed(failure)
    this.emit()
    throw new BuiltInProxyOperationError(failure.category, failure.message, failure.retryable)
  }

  private requireProfile(id: string): BuiltInProxyRuntimeState['profiles'][number] {
    const profile = this.store.getBuiltInProxyProfile(id)
    if (!profile) throw new BuiltInProxyOperationError('configuration-invalid', 'Built-in proxy profile not found.', false)
    return profile
  }

  private requireProfileSecrets(id: string): BuiltInProxyProfileSecrets {
    const secrets = this.store.getBuiltInProxyProfileSecrets(id)
    if (!secrets) {
      throw new BuiltInProxyOperationError('configuration-invalid', 'The encrypted proxy configuration is unavailable.', false)
    }
    return secrets
  }

  private externalNetworkMode(): OutboundNetworkMode {
    return this.store.getRuntimeGatewaySettings().outboundNetworkMode === 'system' ? 'system' : 'direct'
  }

  private emit(): void {
    if (this.closed || this.listeners.size === 0) return
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private assertOpen(): void {
    if (this.closed) throw new BuiltInProxyOperationError('unknown', 'The built-in proxy orchestrator is closed.', false)
  }
}

export class BuiltInProxyOperationError extends Error {
  public readonly category: BuiltInProxyErrorCategory
  public readonly code: BuiltInProxyErrorCategory
  public readonly retryable: boolean

  public constructor(
    category: BuiltInProxyErrorCategory,
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BuiltInProxyOperationError'
    this.category = category
    this.code = category
    this.retryable = retryable
  }
}

function validateParsedProfile(value: unknown): ParsedBuiltInProxyProfile {
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as Partial<ParsedBuiltInProxyProfile>).nodes)
    || !Array.isArray((value as Partial<ParsedBuiltInProxyProfile>).groups)
    || !Array.isArray((value as Partial<ParsedBuiltInProxyProfile>).rules)
  ) {
    throw new BuiltInProxyOperationError('configuration-invalid', 'The encrypted proxy profile is invalid.', false)
  }
  return structuredClone(value) as ParsedBuiltInProxyProfile
}

function assertHealthyCore(state: SingBoxRuntimeState): asserts state is SingBoxRuntimeState & {
  status: 'ready'
  pid: number
  mixedPort: number
  mixedEndpoint: string
  controllerPort: number
} {
  if (
    state.status !== 'ready'
    || !state.pid
    || !state.mixedPort
    || !state.mixedEndpoint
    || !state.controllerPort
  ) {
    throw new BuiltInProxyOperationError('health-check', 'The built-in proxy core did not become healthy.', true)
  }
}

function coreError(state: SingBoxRuntimeState): BuiltInProxyRouteError | undefined {
  return state.error ? classifyError(Object.assign(new Error(state.error.message), { code: state.error.code })) : undefined
}

function classifyError(error: unknown, fallback: BuiltInProxyErrorCategory = 'unknown'): BuiltInProxyRouteError {
  if (isRouteError(error)) return error
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
  const code = typeof record?.category === 'string'
    ? record.category
    : typeof record?.code === 'string'
      ? record.code
      : ''
  const category = mapErrorCategory(code, fallback)
  const message = error instanceof Error ? error.message : 'Built-in proxy operation failed.'
  const retryable = typeof record?.retryable === 'boolean'
    ? record.retryable
    : category !== 'configuration-invalid'
  return { category, message, retryable, cause: error }
}

function mapErrorCategory(code: string, fallback: BuiltInProxyErrorCategory): BuiltInProxyErrorCategory {
  const normalized = code.toLowerCase().replaceAll('_', '-')
  if (normalized === 'core-missing') return 'core-missing'
  if (['core-untrusted', 'core-integrity'].includes(normalized)) return 'core-integrity'
  if (['config-invalid', 'invalid-profile', 'no-active-node', 'invalid-input', 'invalid-config', 'unsupported-format', 'no-supported-nodes'].includes(normalized)) return 'configuration-invalid'
  if (['node-handshake', 'controller-request', 'not-ready'].includes(normalized)) return 'node-handshake'
  if (['mixed-port', 'controller-port'].includes(normalized)) return 'mixed-port'
  if (normalized.startsWith('tun-')) return 'tun-elevation'
  if (normalized.startsWith('subscription-')) return 'subscription-update'
  if (['snapshot-failed', 'journal-failed', 'apply-failed', 'restore-failed', 'system-proxy'].includes(normalized)) return 'system-proxy'
  if (['health-check', 'check-failed', 'start-failed'].includes(normalized)) return 'health-check'
  if (normalized === 'unexpected-exit' || normalized === 'core-crashed') return 'core-crashed'
  return fallback
}

function isRouteError(value: unknown): value is BuiltInProxyRouteError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BuiltInProxyRouteError>
  return typeof candidate.category === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
}

function publicRouteError(error: BuiltInProxyRouteError): NonNullable<BuiltInProxyRuntimeState['error']> {
  return { category: error.category, message: error.message, retryable: error.retryable }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
  return String(record?.code ?? '').toLowerCase().includes('timeout')
    || (error instanceof Error && /timed?\s*out|timeout/i.test(error.message))
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error('Response is too large.')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error('Response is too large.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
