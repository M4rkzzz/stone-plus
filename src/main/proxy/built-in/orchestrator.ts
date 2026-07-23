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
import type { SystemProxyLease, SystemProxyLeaseEvent } from './system-proxy-lease'
import type { TunController, TunControllerEvent, TunEndpoint, TunRoutingContext } from './tun-controller'

const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 30_000
const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024
const LATENCY_TEST_CONCURRENCY = 4

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
  | 'retainGeneration'
  | 'restoreGeneration'
  | 'disposeGeneration'
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
  | 'restoreReady'
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
  'getState' | 'acquire' | 'verifyActive' | 'startMonitoring' | 'release' | 'retryRelease' | 'recoverStaleLease' | 'onEvent'
>

export type BuiltInTunController = Pick<
  TunController,
  'getState' | 'start' | 'retryStart' | 'stop' | 'retryStop' | 'onEvent'
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

type HealthyCoreState = SingBoxRuntimeState & {
  status: 'ready'
  pid: number
  mixedPort: number
  mixedEndpoint: string
  controllerPort: number
}

interface ActiveAccessBinding {
  mode: BuiltInProxySettings['accessMode']
  core: HealthyCoreState
  profile: ParsedBuiltInProxyProfile
  verifiedAt: number
  ownershipId?: string
}

interface PreparedAccessTransition {
  binding: ActiveAccessBinding
  rollback(): Promise<void>
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
  private unsubscribeTun: () => void
  private unsubscribeSystem: () => void
  private lastReadyAt?: number
  private transitionStatus?: BuiltInProxyRuntimeState['status']
  private transitionError?: BuiltInProxyRouteError
  private activeAccess?: ActiveAccessBinding
  private pendingAccess?: ActiveAccessBinding
  private accessEpoch = 0
  private readonly blockedCoreGenerations = new Set<number>()
  private crashRecoveryPending = false
  private crashEpoch = 0
  private closing = false
  private closeFlight?: Promise<void>
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
    this.unsubscribeTun = this.tunController.onEvent((event) => this.onTunEvent(event))
    this.unsubscribeSystem = this.systemProxyLease.onEvent((event) => this.onSystemProxyEvent(event))
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
      accessState: this.accessState(settings, route),
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
      const hadReadyRuntime = Boolean(this.activeAccess && this.routes.isReady())
      try {
        await mutation()
        await this.reconcileExclusive(reason)
      } catch (error) {
        let persistenceRestoreError: unknown
        try {
          await this.restorePersistence(before)
        } catch (restoreError) {
          persistenceRestoreError = restoreError
          this.logger.error('[built-in-proxy] Could not roll back the persisted proxy mutation', restoreError)
        }
        if (persistenceRestoreError !== undefined) {
          const failure = classifyError(persistenceRestoreError, 'configuration-invalid')
          const blocked: BuiltInProxyRouteError = {
            ...failure,
            message: `The proxy change failed and its saved settings could not be restored: ${failure.message}`,
          }
          this.transitionStatus = undefined
          this.transitionError = blocked
          this.routes.failClosed(blocked)
          this.emit()
          throw new BuiltInProxyOperationError(blocked.category, blocked.message, true, persistenceRestoreError)
        }
        // A replacement transaction restores the exact previous access/core
        // and route generation itself. Starting yet another generation here
        // would destroy that rollback and was the source of LAN/TUN crosstalk.
        if (!hadReadyRuntime && before.settings.desiredEnabled && before.profiles.length > 0) {
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
    patch: Partial<Pick<BuiltInProxySettings, 'ruleMode' | 'customRules' | 'accessMode' | 'lanEnabled' | 'autoStart'>>,
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
      await forEachWithConcurrency(nodes, LATENCY_TEST_CONCURRENCY, async (node) => {
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
      })
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
    if (this.closeFlight) return this.closeFlight
    // Close admission synchronously. Operations accepted before this point are
    // drained; later renderer/background work is rejected instead of slipping
    // behind the shutdown barrier.
    this.closing = true
    const flight = (async () => {
      await this.operationTail.catch(() => undefined)
      try {
        // Never tear down the core while the operating system may still point
        // at it. Main aborts process exit when this fails, so the live core is
        // still supervised and the durable lease remains retryable.
        await this.releaseAccessStrict()
        this.activeAccess = undefined
      } catch (error) {
        const failure = classifyError(error, 'system-proxy')
        this.transitionError = failure
        this.routes.disableFailed(failure)
        this.emit()
        throw error
      }
      if (this.routes.isIntercepting()) this.routes.completeDisable()
      await this.routes.drainRetired()
      await this.core.close()
      this.blockedCoreGenerations.clear()
      this.closed = true
      this.routes.setRetryHandler(undefined)
      this.unsubscribeCore()
      this.unsubscribeTun()
      this.unsubscribeSystem()
      this.unsubscribeRoute()
      this.listeners.clear()
    })()
    this.closeFlight = flight
    try {
      await flight
    } finally {
      if (this.closeFlight === flight) this.closeFlight = undefined
      if (!this.closed) this.closing = false
    }
  }

  private async reconcileExclusive(reason: BuiltInProxyReconcileReason): Promise<void> {
    this.assertOpen()
    if (reason === 'auto-start-changed' || !this.store.getBuiltInProxySettings().desiredEnabled) {
      this.emit()
      return
    }
    await this.enableExclusive(false, reason === 'access-mode-changed')
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

  private async enableExclusive(retryCore: boolean, reuseActiveCore = false): Promise<void> {
    const settings = this.store.getBuiltInProxySettings()
    if (!this.resolveActiveProfile()) {
      this.handleMissingProfile(settings)
      return
    }
    const prepared = this.prepareConfiguration(settings)
    const previousAccess = this.activeAccess && this.routes.isReady()
      ? this.activeAccess
      : undefined
    this.transitionStatus = 'starting'
    this.transitionError = undefined
    if (this.routes.isIntercepting()) this.routes.markStarting()
    else this.routes.requestEnable()
    this.emit()

    let generation: ChromiumMixedSessionGeneration | undefined
    let startedCore: SingBoxRuntimeState | undefined
    let accessTransition: PreparedAccessTransition | undefined
    try {
      const currentCore = this.core.getState()
      const canReuseActiveCore = Boolean(
        reuseActiveCore
        && previousAccess
        && currentCore.status === 'ready'
        && currentCore.generation === previousAccess.core.generation
        && currentCore.pid === previousAccess.core.pid,
      )
      const core = canReuseActiveCore
        ? currentCore
        : retryCore && currentCore.desiredEnabled
          ? await this.core.retry()
          : await this.core.start({
            config: prepared.built.config,
            mixedPort: settings.mixedPort,
            allowLan: settings.lanEnabled,
          })
      assertHealthyCore(core)
      if (!previousAccess || core.generation !== previousAccess.core.generation) startedCore = core
      const activationCrashEpoch = this.crashEpoch
      if (prepared.built.requestedNodeMissing && prepared.built.activeNodeId) {
        await this.store.selectBuiltInProxyNode(prepared.profile.id, prepared.built.activeNodeId)
      }
      const nextAccess: ActiveAccessBinding = {
        mode: settings.accessMode,
        core,
        profile: prepared.parsed,
        verifiedAt: this.now(),
      }
      this.pendingAccess = nextAccess
      const activationAccessEpoch = this.accessEpoch
      // During a replacement, build and verify the Stone-only Chromium route
      // while the old OS access resource still points at its live core.
      if (previousAccess) generation = await this.createChromiumGeneration(core.mixedEndpoint!)
      accessTransition = await this.prepareAccessTransition(previousAccess, nextAccess)
      this.pendingAccess = accessTransition.binding
      if (!generation) generation = await this.createChromiumGeneration(core.mixedEndpoint!)
      if (nextAccess.mode === 'system') await this.verifySystemAccess(accessTransition.binding)
      // No await is permitted between these proofs and the atomic route swap.
      // A candidate TUN exit increments accessEpoch synchronously.
      this.assertCurrentCoreGeneration(core, activationCrashEpoch)
      this.assertAccessBindingReady(accessTransition.binding, activationAccessEpoch)
      this.activateRoute(generation, core, prepared)
      generation = undefined
      this.activeAccess = accessTransition.binding
      this.pendingAccess = undefined
      this.armSystemProxyMonitor(accessTransition.binding)
      this.releaseBlockedCoreRetains()
      try {
        await this.store.markBuiltInProxyActivated(core.mixedPort, this.now())
      } catch (persistenceError) {
        // Networking is already atomically committed and verified. Do not tear
        // it down or resurrect the retired route because a metadata write
        // failed; keep the actual endpoint live and surface a safe diagnostic.
        this.logger.error('[built-in-proxy] Could not persist the activated mixed endpoint', persistenceError)
      }
      this.lastReadyAt = this.now()
      this.transitionStatus = undefined
      this.transitionError = undefined
      this.crashRecoveryPending = false
      this.emit()
      await this.runInitialDetection()
    } catch (error) {
      this.pendingAccess = undefined
      await generation?.dispose().catch(() => undefined)
      let rollbackError = error instanceof BuiltInProxyAccessRollbackError
        ? error.rollbackFailure
        : undefined

      if (previousAccess && !this.routes.isReady()) {
        // The committed owner itself crashed during preparation. Its route was
        // synchronously fail-closed, so it must not be resurrected as a
        // successful rollback while crash cleanup is queued.
        rollbackError ??= this.transitionError ?? error
      } else if (accessTransition) {
        try {
          await accessTransition.rollback()
        } catch (caught) {
          rollbackError = caught
        }
      }

      if (previousAccess && rollbackError === undefined) {
        try {
          await this.core.restoreGeneration(previousAccess.core.generation)
          if (startedCore && startedCore.generation !== previousAccess.core.generation) {
            await this.core.disposeGeneration(startedCore.generation, { force: true })
          }
          this.activeAccess = previousAccess
          this.routes.restoreReady()
          this.armSystemProxyMonitor(previousAccess)
          this.transitionStatus = undefined
          this.transitionError = undefined
          this.emit()
          const failure = classifyError(error)
          throw new BuiltInProxyOperationError(failure.category, failure.message, failure.retryable, error)
        } catch (restoreError) {
          if (restoreError instanceof BuiltInProxyOperationError && restoreError.cause === error) throw restoreError
          rollbackError = restoreError
        }
      }

      // First activation has no route to restore. Release anything partially
      // prepared; on a replacement rollback failure, retain both cores because
      // the OS may still reference either endpoint.
      if (!previousAccess && rollbackError === undefined) {
        try {
          await this.releaseAccessStrict()
          this.activeAccess = undefined
        } catch (caught) {
          rollbackError = caught
        }
      }
      if (rollbackError === undefined && startedCore) {
        await this.core.disposeGeneration(startedCore.generation, { force: true }).catch(() => undefined)
      }
      const failure = rollbackError === undefined
        ? classifyError(error)
        : classifyRollbackFailure(error, rollbackError, previousAccess?.mode ?? settings.accessMode)
      if (rollbackError !== undefined) {
        if (previousAccess) this.retainCoreWhileAccessBlocked(previousAccess.core.generation)
        if (startedCore) this.retainCoreWhileAccessBlocked(startedCore.generation)
      }
      const tunDenied = failure.category === 'tun-elevation'
      if (this.routes.getSnapshot().hasActivated || tunDenied || rollbackError !== undefined) this.routes.failClosed(failure)
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
    const activationCrashEpoch = this.crashEpoch
    const nextAccess: ActiveAccessBinding = {
      mode: settings.accessMode,
      core,
      profile: prepared.parsed,
      verifiedAt: this.now(),
    }
    this.pendingAccess = nextAccess
    const activationAccessEpoch = this.accessEpoch
    let generation: ChromiumMixedSessionGeneration | undefined
    let accessTransition: PreparedAccessTransition | undefined
    try {
      accessTransition = await this.prepareAccessTransition(undefined, nextAccess)
      this.pendingAccess = accessTransition.binding
      generation = await this.createChromiumGeneration(core.mixedEndpoint!)
      if (nextAccess.mode === 'system') await this.verifySystemAccess(accessTransition.binding)
      this.assertCurrentCoreGeneration(core, activationCrashEpoch)
      this.assertAccessBindingReady(accessTransition.binding, activationAccessEpoch)
      this.activateRoute(generation, core, prepared)
      generation = undefined
      this.activeAccess = accessTransition.binding
      this.pendingAccess = undefined
      this.armSystemProxyMonitor(accessTransition.binding)
      this.releaseBlockedCoreRetains()
      try {
        await this.store.markBuiltInProxyActivated(core.mixedPort, this.now())
      } catch (persistenceError) {
        this.logger.error('[built-in-proxy] Could not persist the restarted mixed endpoint', persistenceError)
      }
      this.lastReadyAt = this.now()
      this.transitionStatus = undefined
      this.transitionError = undefined
      this.crashRecoveryPending = false
      this.emit()
      await this.runInitialDetection()
    } catch (error) {
      this.pendingAccess = undefined
      await generation?.dispose().catch(() => undefined)
      let releaseError: unknown
      try {
        if (accessTransition) await accessTransition.rollback()
        else await this.releaseAccessStrict()
        this.activeAccess = undefined
      } catch (caught) {
        releaseError = caught
      }
      const failure = releaseError === undefined
        ? classifyError(error)
        : classifyRollbackFailure(error, releaseError, settings.accessMode)
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
    this.core.retainGeneration(core.generation)
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
      dispose: async () => {
        await Promise.allSettled([
          generation.dispose(),
          this.core.disposeGeneration(core.generation),
        ])
      },
    }
    try {
      const committed = this.routes.activate(activation)
      if (
        committed.status !== 'ready'
        || committed.effectiveRoute.mixedPort !== core.mixedPort
        || committed.effectiveRoute.kind !== activation.routeKind
      ) {
        throw new BuiltInProxyOperationError(
          'health-check',
          'The verified built-in proxy route was not committed atomically.',
          true,
        )
      }
    } catch (error) {
      void generation.dispose().catch(() => undefined)
      // Release only the retain acquired above. For an access-only switch this
      // decrements back to the previous route's ownership without stopping it.
      void this.core.disposeGeneration(core.generation).catch(() => undefined)
      throw error
    }
  }

  private async disableExclusive(): Promise<void> {
    this.transitionStatus = 'stopping'
    this.transitionError = undefined
    this.routes.beginDisable()
    this.emit()
    try {
      await this.releaseAccessStrict()
      this.activeAccess = undefined
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
      this.blockedCoreGenerations.clear()
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
      ...(settings.customRules !== undefined ? { customRules: structuredClone(settings.customRules) } : {}),
      dnsServers: this.dnsUpstreams.map((endpoint) => endpoint.host),
    })
    return { profile, parsed, built }
  }

  private async prepareAccessTransition(
    previous: ActiveAccessBinding | undefined,
    next: ActiveAccessBinding,
  ): Promise<PreparedAccessTransition> {
    try {
      await this.switchAccess(previous, next)
    } catch (error) {
      try {
        await this.restoreAccess(previous)
      } catch (rollbackFailure) {
        throw new BuiltInProxyAccessRollbackError(error, rollbackFailure, previous?.mode ?? next.mode)
      }
      throw error
    }
    const binding: ActiveAccessBinding = {
      ...next,
      verifiedAt: this.now(),
      ...(next.mode === 'system'
        ? (this.systemProxyLease.getState().leaseId
            ? { ownershipId: this.systemProxyLease.getState().leaseId }
            : {})
        : (this.tunController.getState().session?.id
            ? { ownershipId: this.tunController.getState().session?.id }
            : {})),
    }
    return {
      binding,
      rollback: async () => {
        try {
          await this.restoreAccess(previous)
        } catch (rollbackFailure) {
          throw new BuiltInProxyAccessRollbackError(
            new Error('The prepared access-mode replacement could not be committed.'),
            rollbackFailure,
            previous?.mode ?? next.mode,
          )
        }
      },
    }
  }

  /**
   * Two-phase access switch. Cross-mode transitions bring the new resource up
   * before releasing the old one. Same-mode retargeting happens only after the
   * replacement core and Chromium session are healthy and is fully reversible.
   */
  private async switchAccess(
    previous: ActiveAccessBinding | undefined,
    next: ActiveAccessBinding,
  ): Promise<void> {
    if (!previous) {
      if (next.mode === 'system') {
        await this.stopTunIfOwned()
        await this.ensureSystemAccess(next)
      } else {
        await this.releaseSystemIfOwned()
        await this.ensureTunAccess(next)
      }
      return
    }

    if (previous.mode === 'system' && next.mode === 'tun') {
      await this.ensureTunAccess(next)
      await this.releaseSystemIfOwned()
      return
    }
    if (previous.mode === 'tun' && next.mode === 'system') {
      await this.ensureSystemAccess(next)
      await this.stopTunIfOwned()
      return
    }
    if (next.mode === 'system') {
      if (sameAccessCore(previous, next)) {
        await this.ensureSystemAccess(next)
        return
      }
      await this.releaseSystemIfOwned()
      await this.ensureSystemAccess(next)
      return
    }
    if (sameAccessCore(previous, next) && this.tunAccessMatches(next)) return
    await this.stopTunIfOwned()
    await this.ensureTunAccess(next)
  }

  private async restoreAccess(previous: ActiveAccessBinding | undefined): Promise<void> {
    if (!previous) {
      await this.releaseAccessStrict()
      return
    }
    if (previous.mode === 'system') {
      // Keep a candidate TUN alive until the previous system proxy has been
      // positively reacquired; this avoids a rollback leak window.
      await this.ensureSystemAccess(previous)
      await this.stopTunIfOwned()
      return
    }
    // Likewise, keep a candidate system lease until the previous elevated TUN
    // is healthy again.
    await this.ensureTunAccess(previous)
    await this.releaseSystemIfOwned()
  }

  private async ensureSystemAccess(binding: ActiveAccessBinding): Promise<void> {
    if (!this.systemAccessMatches(binding)) await this.releaseSystemIfOwned()
    await this.systemProxyLease.acquire({
      mixed: { host: '127.0.0.1', port: binding.core.mixedPort },
    })
    binding.ownershipId = this.systemProxyLease.getState().leaseId
    if (!this.systemAccessMatches(binding)) {
      throw new BuiltInProxyOperationError(
        'system-proxy',
        'Windows did not confirm the Stone+ mixed system-proxy lease.',
        true,
      )
    }
  }

  private async verifySystemAccess(binding: ActiveAccessBinding): Promise<void> {
    const ownershipId = binding.ownershipId
    if (!ownershipId) {
      throw new BuiltInProxyOperationError(
        'system-proxy',
        'Stone+ could not prove ownership of the system-proxy lease.',
        true,
      )
    }
    await this.systemProxyLease.verifyActive({
      mixed: { host: '127.0.0.1', port: binding.core.mixedPort },
    }, ownershipId)
  }

  private async ensureTunAccess(binding: ActiveAccessBinding): Promise<void> {
    if (this.tunAccessMatches(binding)) return
    await this.stopTunIfOwned()
    await this.tunController.start(this.createTunRoutingContext(binding.profile, binding.core))
    binding.ownershipId = this.tunController.getState().session?.id
    if (!this.tunAccessMatches(binding)) {
      throw new BuiltInProxyOperationError(
        'tun-elevation',
        'The temporary TUN session did not confirm the selected mixed endpoint.',
        true,
      )
    }
  }

  private systemAccessMatches(binding: ActiveAccessBinding): boolean {
    const state = this.systemProxyLease.getState()
    return state.status === 'active'
      && state.target?.mixed.host === '127.0.0.1'
      && state.target.mixed.port === binding.core.mixedPort
      && (!binding.ownershipId || state.leaseId === binding.ownershipId)
  }

  private armSystemProxyMonitor(binding: ActiveAccessBinding): void {
    if (
      binding.mode === 'system'
      && this.routes.isReady()
      && this.systemAccessMatches(binding)
    ) {
      this.systemProxyLease.startMonitoring()
    }
  }

  private tunAccessMatches(binding: ActiveAccessBinding): boolean {
    if (binding.mode !== 'tun') return false
    const state = this.tunController.getState()
    if (state.status !== 'ready' || !state.bypass) return false
    return (!binding.ownershipId || state.session?.id === binding.ownershipId)
      && state.bypass.excludedProcessIds.includes(binding.core.pid)
      && state.bypass.excludedEndpoints.some((endpoint) => (
        endpoint.role === 'mixed'
        && endpoint.host === '127.0.0.1'
        && endpoint.port === binding.core.mixedPort
      ))
      && state.bypass.excludedEndpoints.some((endpoint) => (
        endpoint.role === 'controller'
        && endpoint.host === '127.0.0.1'
        && endpoint.port === binding.core.controllerPort
      ))
  }

  private async releaseSystemIfOwned(): Promise<void> {
    if (this.systemProxyLease.getState().status === 'idle') return
    await this.systemProxyLease.release()
    if (this.systemProxyLease.getState().status !== 'idle') {
      throw new BuiltInProxyOperationError(
        'system-proxy',
        'The operating-system proxy lease is still active after release.',
        true,
      )
    }
  }

  private async stopTunIfOwned(): Promise<void> {
    if (this.tunController.getState().status === 'stopped') return
    await this.tunController.stop()
    if (this.tunController.getState().status !== 'stopped') {
      throw new BuiltInProxyOperationError(
        'tun-elevation',
        'The temporary TUN session is still active after stop.',
        true,
      )
    }
  }

  private retainCoreWhileAccessBlocked(generation: number): void {
    if (this.blockedCoreGenerations.has(generation)) return
    try {
      this.core.retainGeneration(generation)
      this.blockedCoreGenerations.add(generation)
    } catch {
      // A generation that already exited cannot be preserved; the blocked
      // route still prevents Stone+ from leaking through another path.
    }
  }

  private releaseBlockedCoreRetains(): void {
    const generations = [...this.blockedCoreGenerations]
    this.blockedCoreGenerations.clear()
    for (const generation of generations) {
      void this.core.disposeGeneration(generation).catch((error: unknown) => {
        this.logger.warn('[built-in-proxy] Could not release a blocked core generation', error)
      })
    }
  }

  private assertAccessBindingReady(binding: ActiveAccessBinding, expectedEpoch: number): void {
    const ready = binding.mode === 'system'
      ? this.systemAccessMatches(binding)
      : this.tunAccessMatches(binding)
    if (this.accessEpoch !== expectedEpoch || !ready) {
      throw new BuiltInProxyOperationError(
        binding.mode === 'system' ? 'system-proxy' : 'tun-elevation',
        binding.mode === 'system'
          ? 'The Stone+ system-proxy lease changed before route activation.'
          : 'The temporary TUN session changed before route activation.',
        true,
      )
    }
  }

  private accessState(
    settings: BuiltInProxySettings,
    route: ReturnType<BuiltInProxyRoutes['getSnapshot']>,
  ): BuiltInProxyRuntimeState['accessState'] {
    const presented = this.pendingAccess ?? this.activeAccess
    const mode = presented?.mode ?? settings.accessMode
    const endpoint = presented?.core.mixedEndpoint
    if (
      this.transitionStatus === 'starting'
      || this.transitionStatus === 'stopping'
      || route.status === 'starting'
      || route.status === 'stopping'
    ) {
      return { mode, status: 'applying', ...(endpoint ? { endpoint } : {}) }
    }
    if (route.status === 'disabled' && !this.routes.isIntercepting()) {
      return { mode, status: 'idle' }
    }
    const active = this.activeAccess
    const routeMatches = Boolean(
      active
      && route.status === 'ready'
      && route.effectiveRoute.mixedPort === active.core.mixedPort
      && (active.mode === 'system'
        ? route.effectiveRoute.kind === 'built-in-mixed' && this.systemAccessMatches(active)
        : route.effectiveRoute.kind === 'built-in-tun' && this.tunAccessMatches(active)),
    )
    if (active && routeMatches) {
      return {
        mode: active.mode,
        status: 'ready',
        endpoint: active.core.mixedEndpoint,
        verifiedAt: active.verifiedAt,
      }
    }
    return {
      mode,
      status: settings.desiredEnabled || this.routes.isIntercepting() ? 'error' : 'idle',
      ...(endpoint ? { endpoint } : {}),
    }
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

  private assertCurrentCoreGeneration(expected: SingBoxRuntimeState, crashEpoch: number): void {
    const current = this.core.getState()
    if (
      this.crashEpoch !== crashEpoch
      || current.status !== 'ready'
      || current.generation !== expected.generation
      || current.pid !== expected.pid
      || current.mixedEndpoint !== expected.mixedEndpoint
      || current.controllerPort !== expected.controllerPort
    ) {
      throw new BuiltInProxyOperationError(
        'core-crashed',
        'The sing-box generation changed while its Chromium route was being prepared.',
        true,
      )
    }
  }

  private onCoreEvent(event: SingBoxRuntimeEvent): void {
    if (this.closed || this.closing) return
    if (event.type === 'crash') {
      if (!this.store.getBuiltInProxySettings().desiredEnabled && !this.routes.isIntercepting()) return
      const activeGeneration = this.activeAccess?.core.generation
      const pendingGeneration = this.pendingAccess?.core.generation
      if (
        activeGeneration !== undefined
        && event.generation !== activeGeneration
        && event.generation !== pendingGeneration
      ) {
        // A retired response-drain generation exited after its replacement was
        // committed. It no longer owns either the route or OS access.
        this.emit()
        return
      }
      this.crashEpoch += 1
      if (
        pendingGeneration === event.generation
        && activeGeneration !== event.generation
        && this.routes.isReady()
      ) {
        // The candidate died before commit. Keep the published route/access
        // untouched; the epoch proof aborts and rolls back this transaction.
        this.emit()
        return
      }
      const failure: BuiltInProxyRouteError = {
        category: 'core-crashed',
        message: event.state.error?.message ?? `sing-box exited unexpectedly (${event.exit}).`,
        retryable: true,
      }
      // This must be synchronous with the child exit notification: queuing the
      // route pointer swap would leave a direct/old-generation leak window.
      if (this.pendingAccess && this.pendingAccess.core.generation !== event.generation) {
        this.retainCoreWhileAccessBlocked(this.pendingAccess.core.generation)
      }
      this.crashRecoveryPending = true
      this.transitionError = failure
      this.routes.failClosed(failure)
      this.emit()
      void this.enqueue(async () => {
        await this.releaseAccessBestEffort()
        this.activeAccess = undefined
      })
      return
    }
    if (event.type === 'state' && event.state.status === 'ready' && this.crashRecoveryPending) {
      void this.enqueue(() => this.activateRestartedCore())
      return
    }
    if (event.type === 'state') this.emit()
  }

  private onTunEvent(event: TunControllerEvent): void {
    if (this.closed || this.closing || event.type !== 'unexpected-exit') return
    if (!this.store.getBuiltInProxySettings().desiredEnabled && !this.routes.isIntercepting()) return
    const pendingMatches = this.pendingAccess
      ? this.tunEventMatches(event, this.pendingAccess)
      : false
    const activeMatches = this.activeAccess
      ? this.tunEventMatches(event, this.activeAccess)
      : false
    this.accessEpoch += 1
    if (pendingMatches && !activeMatches && this.routes.isReady()) {
      // Candidate-only exit: invalidate the no-await activation proof without
      // retiring the healthy route that is still owned by activeAccess.
      this.emit()
      return
    }
    const failure: BuiltInProxyRouteError = {
      category: 'tun-elevation',
      message: 'The temporary elevated TUN sidecar exited unexpectedly.',
      retryable: true,
    }
    if (this.activeAccess) this.retainCoreWhileAccessBlocked(this.activeAccess.core.generation)
    if (this.pendingAccess) this.retainCoreWhileAccessBlocked(this.pendingAccess.core.generation)
    this.transitionError = failure
    this.routes.failClosed(failure)
    this.emit()
    void this.enqueue(async () => {
      await this.releaseAccessBestEffort()
      this.activeAccess = undefined
      this.releaseBlockedCoreRetains()
    }).catch(() => undefined)
  }

  private onSystemProxyEvent(event: SystemProxyLeaseEvent): void {
    if (this.closed || this.closing || event.type !== 'unexpected-drift') return
    if (!this.store.getBuiltInProxySettings().desiredEnabled && !this.routes.isIntercepting()) return
    const failedLeaseId = event.state.leaseId
    const pendingMatches = Boolean(
      this.pendingAccess?.mode === 'system'
      && event.state.target?.mixed.port === this.pendingAccess.core.mixedPort
      && (!this.pendingAccess.ownershipId || failedLeaseId === this.pendingAccess.ownershipId),
    )
    const activeMatches = Boolean(
      this.activeAccess?.mode === 'system'
      && event.state.target?.mixed.port === this.activeAccess.core.mixedPort
      && (!this.activeAccess.ownershipId || failedLeaseId === this.activeAccess.ownershipId),
    )
    if (!pendingMatches && !activeMatches) return
    this.accessEpoch += 1
    if (pendingMatches && !activeMatches && this.routes.isReady()) {
      this.emit()
      return
    }
    if (!activeMatches) return
    const candidateTunId = this.pendingAccess?.mode === 'tun'
      ? (this.pendingAccess.ownershipId ?? this.tunController.getState().session?.id)
      : undefined
    const failure: BuiltInProxyRouteError = {
      category: 'system-proxy',
      message: 'The Windows system proxy was changed by another proxy manager; Stone+ stopped claiming takeover.',
      retryable: true,
    }
    if (this.activeAccess) this.retainCoreWhileAccessBlocked(this.activeAccess.core.generation)
    if (this.pendingAccess) this.retainCoreWhileAccessBlocked(this.pendingAccess.core.generation)
    this.transitionError = failure
    this.routes.failClosed(failure)
    this.emit()
    void this.enqueue(async () => {
      const current = this.systemProxyLease.getState()
      const tun = this.tunController.getState()
      if (candidateTunId && tun.session?.id === candidateTunId) {
        try {
          await this.tunController.stop()
        } catch (error) {
          this.logger.warn('[built-in-proxy] Could not stop the candidate TUN after system-proxy drift', error)
        }
      }
      if (!failedLeaseId || current.leaseId === failedLeaseId) {
        try {
          await this.systemProxyLease.release()
        } catch (error) {
          this.logger.warn('[built-in-proxy] Could not release a drifted system-proxy lease', error)
        }
      }
      if (this.activeAccess?.ownershipId === failedLeaseId) this.activeAccess = undefined
      this.releaseBlockedCoreRetains()
    }).catch(() => undefined)
  }

  private tunEventMatches(event: TunControllerEvent, binding: ActiveAccessBinding): boolean {
    if (binding.mode !== 'tun' || !event.state.bypass) return false
    return (!binding.ownershipId || event.state.session?.id === binding.ownershipId)
      && event.state.bypass.excludedProcessIds.includes(binding.core.pid)
      && event.state.bypass.excludedEndpoints.some((endpoint) => (
        endpoint.role === 'mixed' && endpoint.port === binding.core.mixedPort
      ))
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
      customRules: snapshot.settings.customRules === undefined
        ? undefined
        : structuredClone(snapshot.settings.customRules),
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
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        this.logger.warn('[built-in-proxy] Runtime state observer failed', error)
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) {
      return Promise.reject(new BuiltInProxyOperationError(
        'unknown',
        'The built-in proxy orchestrator is closing.',
        true,
      ))
    }
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private assertOpen(): void {
    if (this.closed) throw new BuiltInProxyOperationError('unknown', 'The built-in proxy orchestrator is closed.', false)
  }
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)))
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      await operation(values[index], index)
    }
  })
  await Promise.all(workers)
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

class BuiltInProxyAccessRollbackError extends BuiltInProxyOperationError {
  public readonly rollbackFailure: unknown

  public constructor(
    primaryFailure: unknown,
    rollbackFailure: unknown,
    previousMode: BuiltInProxySettings['accessMode'],
  ) {
    const failure = classifyRollbackFailure(primaryFailure, rollbackFailure, previousMode)
    super(failure.category, failure.message, true, primaryFailure)
    this.name = 'BuiltInProxyAccessRollbackError'
    this.rollbackFailure = rollbackFailure
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
  if (isRouteError(error)) {
    return {
      category: mapErrorCategory(error.category, fallback),
      message: error.message,
      retryable: error.retryable,
      ...(error.cause === undefined ? { cause: error } : { cause: error.cause }),
    }
  }
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

function classifyRollbackFailure(
  primaryFailure: unknown,
  rollbackFailure: unknown,
  previousMode: BuiltInProxySettings['accessMode'],
): BuiltInProxyRouteError {
  const primary = classifyError(primaryFailure)
  const rollback = classifyError(
    rollbackFailure,
    previousMode === 'system' ? 'system-proxy' : 'tun-elevation',
  )
  return {
    category: rollback.category,
    message: `The proxy change failed (${primary.message}) and the previous ${previousMode === 'system' ? 'system-proxy lease' : 'TUN session'} could not be restored (${rollback.message}).`,
    retryable: true,
    cause: rollbackFailure,
  }
}

function sameAccessCore(left: ActiveAccessBinding, right: ActiveAccessBinding): boolean {
  return left.core.generation === right.core.generation
    && left.core.pid === right.core.pid
    && left.core.mixedPort === right.core.mixedPort
    && left.core.controllerPort === right.core.controllerPort
}

function mapErrorCategory(code: string, fallback: BuiltInProxyErrorCategory): BuiltInProxyErrorCategory {
  const normalized = code.toLowerCase().replaceAll('_', '-')
  if (normalized === 'core-missing') return 'core-missing'
  if (['core-untrusted', 'core-integrity', 'core-version'].includes(normalized)) return 'core-integrity'
  if (['config-invalid', 'check-failed', 'invalid-profile', 'no-active-node', 'invalid-input', 'invalid-config', 'unsupported-format', 'no-supported-nodes'].includes(normalized)) return 'configuration-invalid'
  if (['node-handshake', 'controller-request', 'not-ready'].includes(normalized)) return 'node-handshake'
  if (['mixed-port', 'controller-port'].includes(normalized)) return 'mixed-port'
  if (['tun-invalid-bypass', 'tun-config-invalid'].includes(normalized)) return 'configuration-invalid'
  if (normalized === 'tun-runtime-invalid') return 'core-integrity'
  if (normalized.startsWith('tun-')) return 'tun-elevation'
  if (normalized.startsWith('subscription-')) return 'subscription-update'
  if (['snapshot-failed', 'journal-failed', 'apply-failed', 'restore-failed', 'system-proxy'].includes(normalized)) return 'system-proxy'
  if (['health-check', 'start-failed'].includes(normalized)) return 'health-check'
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
