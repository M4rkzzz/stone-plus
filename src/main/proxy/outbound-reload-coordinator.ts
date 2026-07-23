import type {
  Account,
  PublicProxyDefinition,
  SystemProxyDetectionResult
} from '@shared/types'
import { resolveRouteSource } from '@shared/route-sources'
import {
  CHATGPT_CODEX_RESPONSES_URL,
  codexQuotaIsExhausted
} from '../providers'
import type { AppStore } from '../store/app-store'
import { resolveEffectiveProxy, type OutboundTransportManager } from './transport'

export const EXTERNAL_SYSTEM_PROXY_DETECTION_TARGETS = Object.freeze([
  CHATGPT_CODEX_RESPONSES_URL,
  'https://chatgpt.com/backend-api/codex/models?client_version=0.144.3',
  'https://chatgpt.com/backend-api/wham/usage',
  'https://api.openai.com/v1/models',
  'https://auth.openai.com/.well-known/openid-configuration'
])

export interface EnabledOutboundTarget {
  proxy: PublicProxyDefinition | undefined
  password: string | undefined
  targetUrl: string
  accountIds: Set<string>
}

type OutboundTargetStore = Pick<
  AppStore,
  'getRuntimeConfiguration' | 'getSnapshot' | 'getProxyPassword'
>

/**
 * Resolve only sources referenced by enabled routes. Persisted pools are used
 * deliberately: runtime-only virtual pools must not make a discarded or
 * disabled source appear enabled merely because it still exists in memory.
 */
export function collectEnabledOutboundTargets(
  store: OutboundTargetStore
): Map<string, EnabledOutboundTarget> {
  const configuration = store.getRuntimeConfiguration()
  const sourceCollections = {
    pools: store.getSnapshot().pools,
    providers: configuration.providers,
    accounts: configuration.accounts
  }
  const targets = new Map<string, EnabledOutboundTarget>()
  for (const route of configuration.routes) {
    if (!route.enabled) continue
    const source = resolveRouteSource(route.poolId, sourceCollections)
    if (!source) continue
    for (const account of source.accounts) {
      if (account.status === 'disabled' || account.status === 'expired') continue
      const provider = configuration.providers.find((candidate) => candidate.id === account.providerId)
      if (!provider) continue
      const proxy = resolveEffectiveProxy(account, source.pool, configuration.proxies)
      // Preserve the complete upstream path and query. PAC decisions may be
      // path-sensitive, so reducing this to an origin changes routing.
      const targetUrl = new URL(
        account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity'
          ? CHATGPT_CODEX_RESPONSES_URL
          : provider.baseUrl
      ).toString()
      const key = `${proxy?.id ?? 'direct'}\0${targetUrl}`
      const existing = targets.get(key)
      if (existing) {
        existing.accountIds.add(account.id)
      } else {
        targets.set(key, {
          proxy,
          password: proxy ? store.getProxyPassword(proxy.id) : undefined,
          targetUrl,
          accountIds: new Set([account.id])
        })
      }
    }
  }
  return targets
}

export type OutboundReloadMode = 'external-system' | 'built-in'

export type BuiltInOutboundTargetDetector<TDetection = unknown> = (
  targets: readonly string[]
) => Promise<TDetection>

export type BuiltInRouteChangeCoordinator = (
  detector: BuiltInOutboundTargetDetector
) => Promise<void>

export interface OutboundReloadCoordinationResult<TDetection = unknown> {
  targetUrls: string[]
  recheckedAccountIds: string[]
  detection?: TDetection
}

export interface OutboundReloadCoordinationOptions<TDetection = unknown> {
  mode: OutboundReloadMode
  /** External mode normally reloads Chromium/WinINET; built-in mode never does. */
  reloadSystemProxy?: boolean
  /** External detection can retain the historical fixed diagnostics targets. */
  includeExternalBaselineTargets?: boolean
  detectTargets?: (targets: readonly string[]) => Promise<TDetection>
  recheckFailureCooledAccounts?: boolean
}

export interface OutboundReloadCoordinatorOptions {
  transport: Pick<
    OutboundTransportManager,
    'reloadSystemProxyConfiguration' | 'detectSystemProxy'
  >
  collectTargets: () => ReadonlyMap<string, EnabledOutboundTarget>
  getRuntimeAccounts?: () => readonly Account[]
  getRuntimeAccount?: (accountId: string) => Account | undefined
  probeAccount?: (accountId: string) => Promise<unknown>
  isQuotaExhausted?: (account: Account) => boolean
  onRecheckCycleStarted?: () => void
  onRecheckCycleSettled?: () => void
  debounceMs?: number
  recheckConcurrency?: number
  logger?: Pick<Console, 'warn' | 'error'>
}

export interface OutboundReloadAccountRecheckOptions {
  getRuntimeAccounts: () => readonly Account[]
  getRuntimeAccount: (accountId: string) => Account | undefined
  probeAccount: (accountId: string) => Promise<unknown>
  isQuotaExhausted: (account: Account) => boolean
  onRecheckCycleStarted?: () => void
  onRecheckCycleSettled?: () => void
}

export function createOutboundReloadCoordinator(
  store: OutboundTargetStore & Pick<AppStore, 'getRuntimeAccounts' | 'getRuntimeAccount'>,
  transport: OutboundReloadCoordinatorOptions['transport'],
  options: Pick<OutboundReloadCoordinatorOptions, 'debounceMs' | 'recheckConcurrency' | 'logger'> = {}
): OutboundReloadCoordinator {
  return new OutboundReloadCoordinator({
    transport,
    collectTargets: () => collectEnabledOutboundTargets(store),
    getRuntimeAccounts: () => store.getRuntimeAccounts(),
    getRuntimeAccount: (accountId) => store.getRuntimeAccount(accountId),
    isQuotaExhausted: isAccountQuotaExhausted,
    ...options
  })
}

export function isAccountQuotaExhausted(account: Account, now = Date.now()): boolean {
  if (codexQuotaIsExhausted(account.codexQuota, now)) return true
  if (!account.quota) return false
  return [
    account.quota.requests,
    account.quota.tokens,
    account.quota.inputTokens,
    account.quota.outputTokens
  ].some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

/**
 * Serializes route-change side effects while keeping the operating-system
 * proxy reload's own five-second bound and single-flight implementation in the
 * transport manager. Built-in coordination intentionally never reloads the
 * user's external PAC/system configuration.
 */
export class OutboundReloadCoordinator {
  private readonly transport: OutboundReloadCoordinatorOptions['transport']
  private readonly collectTargets: OutboundReloadCoordinatorOptions['collectTargets']
  private getRuntimeAccounts?: OutboundReloadAccountRecheckOptions['getRuntimeAccounts']
  private getRuntimeAccount?: OutboundReloadAccountRecheckOptions['getRuntimeAccount']
  private probeAccount?: OutboundReloadAccountRecheckOptions['probeAccount']
  private isQuotaExhausted?: OutboundReloadAccountRecheckOptions['isQuotaExhausted']
  private onRecheckCycleStarted: () => void
  private onRecheckCycleSettled: () => void
  private readonly debounceMs: number
  private readonly recheckConcurrency: number
  private readonly logger: OutboundReloadCoordinatorOptions['logger']
  private recheckTail: Promise<void> = Promise.resolve()
  private scheduledBuiltInTimer?: ReturnType<typeof setTimeout>
  private scheduledBuiltInDetector?: (targets: readonly string[]) => Promise<unknown>
  private readonly scheduledBuiltInFlights = new Set<Promise<void>>()
  private closed = false

  constructor(options: OutboundReloadCoordinatorOptions) {
    this.transport = options.transport
    this.collectTargets = options.collectTargets
    this.getRuntimeAccounts = options.getRuntimeAccounts
    this.getRuntimeAccount = options.getRuntimeAccount
    this.probeAccount = options.probeAccount
    this.isQuotaExhausted = options.isQuotaExhausted
    this.onRecheckCycleStarted = options.onRecheckCycleStarted ?? (() => undefined)
    this.onRecheckCycleSettled = options.onRecheckCycleSettled ?? (() => undefined)
    this.debounceMs = Math.max(0, options.debounceMs ?? 250)
    this.recheckConcurrency = Math.max(1, Math.floor(options.recheckConcurrency ?? 3))
    this.logger = options.logger ?? console
  }

  /** Attach the gateway-owned durable account probe to a coordinator created in main/index. */
  public configureAccountRecheck(options: OutboundReloadAccountRecheckOptions): this {
    this.assertOpen()
    this.getRuntimeAccounts = options.getRuntimeAccounts
    this.getRuntimeAccount = options.getRuntimeAccount
    this.probeAccount = options.probeAccount
    this.isQuotaExhausted = options.isQuotaExhausted
    this.onRecheckCycleStarted = options.onRecheckCycleStarted ?? (() => undefined)
    this.onRecheckCycleSettled = options.onRecheckCycleSettled ?? (() => undefined)
    return this
  }

  /** Adapter shape consumed by the built-in orchestrator dependency. */
  public builtInRouteChangeCoordinator(): BuiltInRouteChangeCoordinator {
    return async (detector) => {
      await this.coordinateBuiltInRouteChange(detector)
    }
  }

  /** Exact compatibility facade used by the existing detect-system-proxy IPC. */
  public async detectExternalSystemProxy(): Promise<SystemProxyDetectionResult> {
    const result = await this.coordinate<SystemProxyDetectionResult>({
      mode: 'external-system',
      reloadSystemProxy: true,
      includeExternalBaselineTargets: true,
      detectTargets: (targets) => this.transport.detectSystemProxy(targets),
      recheckFailureCooledAccounts: false
    })
    // detectTargets is present above, so this is an invariant rather than a
    // renderer-visible change to the historical return value.
    if (!result.detection) throw new Error('System proxy detection did not return a result.')
    return result.detection
  }

  /** Existing external route switch: reload first, then asynchronously recheck. */
  public async reloadExternalSystemRoute(): Promise<void> {
    await this.reloadSystemProxySafely(
      '[system-proxy] Could not force-reload the operating-system proxy configuration'
    )
    this.triggerFailureCooldownRecheck('external-system')
  }

  /** Built-in disable commit barrier: the old mixed generation remains live
   * unless Chromium has definitely accepted the restored external route. */
  public async reloadExternalSystemRouteStrict(): Promise<void> {
    await this.reloadSystemProxyStrict()
    this.triggerFailureCooldownRecheck('external-system')
  }

  /**
   * Runs built-in source detection immediately. All enabled targets are
   * included, including accounts whose explicit proxy binding is currently
   * paused by built-in takeover.
   */
  public coordinateBuiltInRouteChange<TDetection>(
    detectTargets: (targets: readonly string[]) => Promise<TDetection>
  ): Promise<OutboundReloadCoordinationResult<TDetection>> {
    return this.coordinate({
      mode: 'built-in',
      reloadSystemProxy: false,
      detectTargets,
      recheckFailureCooledAccounts: true
    })
  }

  /** Debounced entry point for node, profile, and rule-mode changes. */
  public scheduleBuiltInRouteChange(
    detectTargets: (targets: readonly string[]) => Promise<unknown>
  ): void {
    if (this.closed) return
    this.scheduledBuiltInDetector = detectTargets
    if (this.scheduledBuiltInTimer) clearTimeout(this.scheduledBuiltInTimer)
    this.scheduledBuiltInTimer = setTimeout(() => {
      this.scheduledBuiltInTimer = undefined
      const detector = this.scheduledBuiltInDetector
      this.scheduledBuiltInDetector = undefined
      if (!detector || this.closed) return
      const flight = this.coordinateBuiltInRouteChange(detector).then(() => undefined)
      this.scheduledBuiltInFlights.add(flight)
      void flight.catch((error: unknown) => {
        this.logger?.error('[built-in-proxy] Could not refresh enabled sources after the route changed', error)
      }).finally(() => {
        this.scheduledBuiltInFlights.delete(flight)
      })
    }, this.debounceMs)
    this.scheduledBuiltInTimer.unref?.()
  }

  public async coordinate<TDetection = unknown>(
    options: OutboundReloadCoordinationOptions<TDetection>
  ): Promise<OutboundReloadCoordinationResult<TDetection>> {
    this.assertOpen()
    if (options.mode === 'built-in' && options.reloadSystemProxy) {
      throw new Error('Built-in route coordination must not reload the external system proxy.')
    }
    if (options.reloadSystemProxy) {
      await this.reloadSystemProxySafely(
        options.detectTargets
          ? '[system-proxy] Could not force-reload the operating-system proxy configuration before detection'
          : '[system-proxy] Could not force-reload the operating-system proxy configuration'
      )
    }

    const targets = [...this.collectTargets().values()]
    const selectedTargets = options.mode === 'built-in'
      ? targets
      : targets.filter((target) => target.proxy === undefined)
    const targetUrls = [...new Set([
      ...(options.includeExternalBaselineTargets ? EXTERNAL_SYSTEM_PROXY_DETECTION_TARGETS : []),
      ...selectedTargets.map((target) => target.targetUrl)
    ])]

    let detection: TDetection | undefined
    let detectionError: unknown
    if (options.detectTargets) {
      try {
        detection = await options.detectTargets(targetUrls)
      } catch (error) {
        detectionError = error
      }
    }

    const recheckedAccountIds = options.recheckFailureCooledAccounts
      ? await this.enqueueFailureCooldownRecheck(selectedTargets, options.mode)
      : []
    if (detectionError !== undefined) throw detectionError
    return {
      targetUrls,
      recheckedAccountIds,
      ...(detection !== undefined ? { detection } : {})
    }
  }

  public async settle(): Promise<void> {
    while (true) {
      const recheckTail = this.recheckTail
      const flights = [...this.scheduledBuiltInFlights]
      await Promise.allSettled([recheckTail, ...flights])
      if (recheckTail === this.recheckTail && this.scheduledBuiltInFlights.size === 0) return
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.scheduledBuiltInTimer) clearTimeout(this.scheduledBuiltInTimer)
    this.scheduledBuiltInTimer = undefined
    this.scheduledBuiltInDetector = undefined
    await this.settle()
  }

  private triggerFailureCooldownRecheck(mode: OutboundReloadMode): void {
    if (this.closed) return
    const targets = [...this.collectTargets().values()]
      .filter((target) => mode === 'built-in' || target.proxy === undefined)
    void this.enqueueFailureCooldownRecheck(targets, mode).catch((error: unknown) => {
      this.logger?.error('Stone+ could not refresh failure-cooled accounts after the network route changed', error)
    })
  }

  private enqueueFailureCooldownRecheck(
    targets: readonly EnabledOutboundTarget[],
    mode: OutboundReloadMode,
  ): Promise<string[]> {
    const getRuntimeAccounts = this.getRuntimeAccounts
    const getRuntimeAccount = this.getRuntimeAccount
    const probeAccount = this.probeAccount
    const isQuotaExhausted = this.isQuotaExhausted
    if (!getRuntimeAccounts || !getRuntimeAccount || !probeAccount || !isQuotaExhausted) {
      return Promise.reject(new Error('Outbound account recheck is not configured.'))
    }
    const enabledAccountIds = new Set<string>()
    for (const target of targets) {
      for (const accountId of target.accountIds) enabledAccountIds.add(accountId)
    }
    const accountIds = getRuntimeAccounts()
      .filter((account) => enabledAccountIds.has(account.id))
      .filter((account) => account.status === 'cooldown' && account.cooldownReason === 'failure')
      .filter((account) => !isQuotaExhausted(account))
      .map((account) => account.id)

    const run = this.recheckTail.then(
      () => this.runFailureCooldownRecheck(accountIds, mode, { getRuntimeAccount, probeAccount, isQuotaExhausted }),
      () => this.runFailureCooldownRecheck(accountIds, mode, { getRuntimeAccount, probeAccount, isQuotaExhausted })
    )
    this.recheckTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async runFailureCooldownRecheck(
    accountIds: readonly string[],
    mode: OutboundReloadMode,
    recheck: Pick<
      OutboundReloadAccountRecheckOptions,
      'getRuntimeAccount' | 'probeAccount' | 'isQuotaExhausted'
    >
  ): Promise<string[]> {
    this.onRecheckCycleStarted()
    try {
      const rechecked: string[] = []
      await mapConcurrent([...accountIds], this.recheckConcurrency, async (accountId) => {
        if (this.closed) return
        if (!this.currentlyEnabledAccountIds(mode).has(accountId)) return
        const account = recheck.getRuntimeAccount(accountId)
        if (!account || account.status !== 'cooldown' || account.cooldownReason !== 'failure') return
        if (recheck.isQuotaExhausted(account)) return
        rechecked.push(accountId)
        await recheck.probeAccount(accountId)
      })
      return rechecked
    } finally {
      this.onRecheckCycleSettled()
    }
  }

  private currentlyEnabledAccountIds(mode: OutboundReloadMode): Set<string> {
    const accountIds = new Set<string>()
    for (const target of this.collectTargets().values()) {
      if (mode === 'external-system' && target.proxy !== undefined) continue
      for (const accountId of target.accountIds) accountIds.add(accountId)
    }
    return accountIds
  }

  private async reloadSystemProxySafely(warning: string): Promise<void> {
    try {
      // The transport owns the 5s bound and single-flight. Do not add a second
      // timeout here: late PAC results must retain the transport's semantics.
      await this.transport.reloadSystemProxyConfiguration()
    } catch (error) {
      // Preserve the last usable Chromium proxy snapshot and let target-level
      // detection report reachability exactly as before.
      this.logger?.warn(warning, error)
    }
  }

  private async reloadSystemProxyStrict(): Promise<void> {
    // OutboundTransportManager owns the bounded single-flight and late-result
    // semantics. Do not layer another timeout here.
    await this.transport.reloadSystemProxyConfiguration()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Outbound reload coordinator is closed.')
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  let firstFailure: { reason: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        await operation(values[index])
      } catch (reason) {
        firstFailure ??= { reason }
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker()
  ))
  if (firstFailure) throw firstFailure.reason
}
