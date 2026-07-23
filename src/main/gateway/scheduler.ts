import type {
  Account,
  AccountCircuitState,
  AccountFitnessSnapshot,
  Pool,
  ProviderDefinition,
  QuotaProtectionPolicy,
  RequestLog,
  UpstreamCapabilityRequirement
} from '../../shared/types'
import { codexQuotaIsExhausted } from '../providers/quota'
import { evaluateSourceEligibility } from '../../shared/source-eligibility'
import type { ScheduledAccount, SchedulerSelectionInput } from './types'

interface StickyAssignment {
  accountId: string
  expiresAt: number
}

interface StickyFailureAvoidance {
  accountId: string
  expiresAt: number
}

interface StickyExpiryEntry {
  key: string
  expiresAt: number
}

interface SmoothWeightedState {
  /** Reset accumulated scores whenever membership/order/weights change. */
  configuration: Map<string, number>
  current: Map<string, number>
}

interface AggregatePoolIndex {
  pool: Pool
  members: Pool['members']
  updatedAt: number
  orderedAccountIds: string[]
  orderByAccountId: Map<string, number>
  weightByAccountId: Map<string, number>
  smoothConfiguration: Map<string, number>
}

interface AccountModelIndex {
  updatedAt: number
  modelPolicy: Account['modelPolicy']
  modelsRefreshedAt?: number
  source: string[]
  allowed: Set<string>
}

export interface AccountRuntimeHealth {
  accountId: string
  circuitState: AccountCircuitState
  consecutiveFailures: number
  cooldownUntil?: number
  lastFailureAt?: number
}

export interface AccountSuccessResult extends AccountRuntimeHealth {
  /** False when a newer failure/quota transition superseded this attempt. */
  applied: boolean
  revision: number
}

export interface AccountFailureOptions {
  retryAfterMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  maxConcurrency?: number
  reason?: 'quota' | 'failure'
}

export interface AccountPerformanceSample {
  /** Transport latency until the first upstream response body byte. */
  transportFirstBodyMs?: number
  /** User-visible semantic first-token latency for the successful attempt. */
  semanticFirstTokenMs?: number
  /** @deprecated Compatibility alias for semanticFirstTokenMs. */
  firstTokenMs?: number
  outputTokens?: number
  generationDurationMs?: number
}

interface AccountPerformanceState {
  sampleCount: number
  successCount: number
  failureCount: number
  performanceSampleCount: number
  transportSampleCount: number
  semanticSampleCount: number
  throughputSampleCount: number
  historySuccessWeight: number
  historyFailureWeight: number
  recentSuccessRate: number
  transportFirstBodyMs?: number
  semanticFirstTokenMs?: number
  outputTokensPerSecond?: number
  failurePenalty: number
  updatedAt: number
  dynamicConcurrency?: number
  successStreak: number
}

const AUTO_BALANCED_EXPLORATION_RATE = 0.05
const FAILURE_PENALTY_HALF_LIFE_MS = 5 * 60_000
const PERFORMANCE_STALE_AFTER_MS = 30 * 60_000
const FITNESS_STALE_AFTER_MS = 24 * 60 * 60_000
const PERFORMANCE_HYDRATION_WINDOW_MS = 30 * 24 * 60 * 60_000
const PERFORMANCE_HYDRATION_SAMPLES_PER_ACCOUNT = 400
const FITNESS_HISTORY_HALF_LIFE_MS = 7 * 24 * 60 * 60_000
const FITNESS_NEUTRAL_PRIOR = 72
const FITNESS_CONFIDENCE_SAMPLES = 12
const STICKY_ESCAPE_MINIMUM_SAMPLES = 3
const STICKY_ESCAPE_MINIMUM_DELTA_MS = 1_000
const STICKY_ESCAPE_RATIO = 1.5
// A raw response byte only proves that the network path is alive; it says
// nothing about how long the model will take to emit useful output. Keep old
// transport-only history useful, but make it a conservative fallback when it
// competes with a real semantic-TTFT observation.
const TRANSPORT_FALLBACK_UNCERTAINTY_MS = 1_500
const TRANSPORT_FALLBACK_FLOOR_MS = 3_000
// Prefer spreading simultaneously active conversations across accounts without
// making it a hard constraint. A clearly unhealthy/slow alternative may still
// lose even when it currently owns fewer conversations.
const CONCURRENT_STICKY_SESSION_PENALTY = 120

export class NoEligibleAccountError extends Error {
  constructor(
    readonly accountIds: readonly string[] = [],
    message = 'No eligible account is available for this request'
  ) {
    super(message)
    this.name = 'NoEligibleAccountError'
  }
}

export class ModelNotExposedError extends Error {
  constructor(message = 'The requested model is not exposed by this pool') {
    super(message)
    this.name = 'ModelNotExposedError'
  }
}

export function accountAllowsModel(account: Account, model: string): boolean {
  if (account.modelPolicy === 'selected') return account.modelAllowlist.includes(model)
  if (account.modelsRefreshedAt !== undefined) return account.availableModels.includes(model)
  return true
}

export function poolAllowsModel(pool: Pool, accounts: readonly Account[], model: string): boolean {
  if (pool.modelPolicy === 'selected' && !pool.modelAllowlist.includes(model)) return false
  return accounts.some((account) => accountAllowsModel(account, model))
}

/** In-memory scheduler state deliberately stays separate from persisted account metadata. */
export class PoolScheduler {
  private readonly active = new Map<string, number>()
  private readonly roundRobinOffsets = new Map<string, number>()
  private readonly smoothWeighted = new Map<string, SmoothWeightedState>()
  private readonly sticky = new Map<string, StickyAssignment>()
  private readonly stickyExpiry: StickyExpiryEntry[] = []
  private readonly stickyKeysByAccount = new Map<string, Set<string>>()
  /** One-shot per-session avoidance after its assigned account actually failed. */
  private readonly stickyFailureAvoidance = new Map<string, StickyFailureAvoidance>()
  private readonly stickyFailureExpiry: StickyExpiryEntry[] = []
  private readonly activeStickySessions = new Map<string, Map<string, number>>()
  private readonly activeStickySessionCounts = new Map<string, number>()
  private aggregatePoolIndexes = new WeakMap<Pool, AggregatePoolIndex>()
  private accountModelIndexes = new WeakMap<Account, AccountModelIndex>()
  private readonly health = new Map<string, AccountRuntimeHealth>()
  /** Monotonic per-account generation guarding concurrent attempt outcomes. */
  private readonly healthRevisions = new Map<string, number>()
  private readonly healthReasons = new Map<string, 'quota' | 'failure'>()
  private readonly performance = new Map<string, AccountPerformanceState>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random()
  ) {}

  hydrate(accounts: readonly Account[], pools?: readonly Pool[]): void {
    // updateConfig/hydrate is the explicit configuration-version boundary.
    // Reset object-content indexes so in-place edits are observed even when a
    // caller forgot to replace the allowlist/member array or bump updatedAt.
    this.accountModelIndexes = new WeakMap()
    this.aggregatePoolIndexes = new WeakMap()
    if (pools) {
      const poolIds = new Set(pools.map((pool) => pool.id))
      for (const poolId of this.roundRobinOffsets.keys()) {
        if (!poolIds.has(poolId)) this.roundRobinOffsets.delete(poolId)
      }
      for (const poolId of this.smoothWeighted.keys()) {
        if (!poolIds.has(poolId)) this.smoothWeighted.delete(poolId)
      }
    }
    const accountIds = new Set(accounts.map((account) => account.id))
    for (const accountId of this.health.keys()) {
      if (!accountIds.has(accountId)) {
        this.health.delete(accountId)
        this.healthRevisions.delete(accountId)
        this.healthReasons.delete(accountId)
      }
    }
    for (const accountId of this.performance.keys()) {
      if (!accountIds.has(accountId)) this.performance.delete(accountId)
    }
    for (const account of accounts) {
      if (this.health.has(account.id)) continue
      const persistedOpen = account.circuitState === 'open'
        || account.circuitState === 'half-open'
        || account.status === 'cooldown'
      if (!persistedOpen) continue
      this.health.set(account.id, {
        accountId: account.id,
        circuitState: account.circuitState === 'half-open' ? 'half-open' : 'open',
        consecutiveFailures: Math.max(account.cooldownReason === 'quota' ? 0 : 1, account.consecutiveFailures ?? 0),
        cooldownUntil: account.cooldownUntil,
        lastFailureAt: account.updatedAt
      })
      this.healthReasons.set(account.id, account.cooldownReason === 'quota' ? 'quota' : 'failure')
    }
  }

  /**
   * Restores only missing runtime performance from recent persisted request
   * logs. Live samples always win, so routine configuration refreshes cannot
   * roll the scheduler back to an older measurement.
   */
  hydratePerformance(logs: readonly RequestLog[]): void {
    const cutoff = this.now() - PERFORMANCE_HYDRATION_WINDOW_MS
    const grouped = new Map<string, RequestLog[]>()
    for (const log of logs) {
      if (
        !log.accountId
        || log.status === 'streaming'
        || log.timestamp < cutoff
      ) continue
      const samples = grouped.get(log.accountId) ?? []
      samples.push(log)
      grouped.set(log.accountId, samples)
    }
    for (const [accountId, logsForAccount] of grouped) {
      if (this.performance.has(accountId)) continue
      const recent = [...logsForAccount]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-PERFORMANCE_HYDRATION_SAMPLES_PER_ACCOUNT)
      for (const log of recent) {
        const transportFirstBodyMs = log.status === 'success'
          ? transportFirstBodyPerformanceMs(log)
          : undefined
        const semanticFirstTokenMs = log.status === 'success'
          ? semanticFirstTokenPerformanceMs(log)
          : undefined
        const previousAttemptsMs = failedAttemptDurationMs(log)
        const generationStartedMs = transportFirstBodyMs ?? semanticFirstTokenMs
        this.observeOutcome(accountId, log.status === 'success', {
          transportFirstBodyMs,
          semanticFirstTokenMs,
          outputTokens: log.outputTokens,
          generationDurationMs: generationStartedMs === undefined
            ? undefined
            : Math.max(0, log.latencyMs - previousAttemptsMs - generationStartedMs)
        }, log.timestamp, false)
      }
    }
  }

  selectAndAcquire(input: SchedulerSelectionInput): ScheduledAccount & { healthRevision: number } {
    const { pool, accounts, model, sessionId } = input
    const now = this.now()
    this.cleanupExpiredSticky(now)
    const excludedAccountIds = input.excludedAccountIds?.length
      ? new Set(input.excludedAccountIds)
      : undefined
    if (pool.strategy !== 'weighted-round-robin') this.smoothWeighted.delete(pool.id)
    if (pool.modelPolicy === 'selected' && !pool.modelAllowlist.includes(model)) {
      throw new ModelNotExposedError()
    }

    // Static model/capability eligibility is shared with route preview. A
    // declared false capability is never scheduled; unknown metadata is a
    // backward-compatible fallback only when no verified member exists.
    const sourceEligibility = evaluateSourceEligibility({
      accounts,
      providers: input.providers ?? [],
      model,
      poolModelPolicy: pool.modelPolicy,
      poolModelAllowlist: pool.modelAllowlist,
      requiredCapabilities: input.requiredCapabilities,
    })
    if (sourceEligibility.modelEligible.length === 0) throw new ModelNotExposedError()

    const adaptiveConcurrency = pool.strategy === 'autobalanced'
    // Capability preference is applied after runtime availability. Otherwise a
    // cooled or saturated verified account can mask a healthy legacy/unknown
    // member and turn a compatible pool into a false 503.
    const runtimeEligible = (account: Account): boolean => (
      !excludedAccountIds?.has(account.id)
      && this.isEligible(account, pool, adaptiveConcurrency, now)
    )
    const verifiedCandidates = sourceEligibility.verified.filter(runtimeEligible)
    const candidates = verifiedCandidates.length > 0
      ? verifiedCandidates
      : sourceEligibility.unknown.filter(runtimeEligible)
    if (candidates.length === 0) {
      throw new NoEligibleAccountError([
        ...sourceEligibility.verified.map((account) => account.id),
        ...sourceEligibility.unknown.map((account) => account.id),
      ])
    }

    const stickyKey = pool.stickySessions && sessionId ? `${pool.id}:${sessionId}` : undefined
    let selected: Account | undefined
    let escapedStickyAccountId: string | undefined
    let failedStickyAccountId: string | undefined
    if (pool.stickySessions && stickyKey) {
      const avoidance = this.stickyFailureAvoidance.get(stickyKey)
      if (avoidance && avoidance.expiresAt > now) {
        // Prefer another account after a proven failure, but do not turn a
        // single-account pool into a hard outage once that account is eligible.
        if (candidates.some((account) => account.id !== avoidance.accountId)) {
          failedStickyAccountId = avoidance.accountId
        }
      } else if (avoidance) {
        this.deleteStickyFailureAvoidance(stickyKey)
      }
      const assignment = this.sticky.get(stickyKey)
      if (assignment && assignment.expiresAt > now) {
        selected = candidates.find((account) => (
          account.id === assignment.accountId && account.id !== failedStickyAccountId
        ))
        if (
          selected
          && pool.strategy === 'autobalanced'
          && (
            this.shouldEscapeSticky(selected, candidates)
            || this.shouldSpreadConcurrentSticky(stickyKey, selected, candidates)
          )
        ) {
          escapedStickyAccountId = selected.id
          selected = undefined
          this.deleteSticky(stickyKey)
        }
      } else if (assignment) {
        this.deleteSticky(stickyKey)
      }
    }

    const preferredCandidates = escapedStickyAccountId || failedStickyAccountId
      ? candidates.filter((account) => (
          account.id !== escapedStickyAccountId && account.id !== failedStickyAccountId
        ))
      : candidates
    selected ??= this.pick(
      pool,
      preferredCandidates.length > 0 ? preferredCandidates : candidates,
      accounts,
      stickyKey
    )
    this.active.set(selected.id, (this.active.get(selected.id) ?? 0) + 1)
    if (stickyKey) this.acquireActiveStickySession(stickyKey, selected.id)

    if (pool.stickySessions && stickyKey) {
      this.deleteStickyFailureAvoidance(stickyKey)
      this.setSticky(stickyKey, {
        accountId: selected.id,
        expiresAt: now + Math.max(1, pool.stickyTtlMinutes) * 60_000
      })
    }

    let released = false
    return {
      account: selected,
      // JavaScript executes selection and this snapshot synchronously. Any
      // later health transition therefore invalidates only attempts selected
      // before it, without relying on millisecond timestamps.
      healthRevision: this.getHealthRevision(selected.id),
      release: () => {
        if (released) return
        released = true
        const remaining = Math.max(0, (this.active.get(selected.id) ?? 0) - 1)
        if (remaining === 0) this.active.delete(selected.id)
        else this.active.set(selected.id, remaining)
        if (stickyKey) this.releaseActiveStickySession(stickyKey, selected.id)
      }
    }
  }

  /**
   * Reports whether a failed source still has a genuinely usable peer for the
   * same model. Capacity is intentionally ignored: an account serving another
   * request is still a routing alternative and must not make a multi-source
   * pool masquerade as a singleton.
   */
  hasUsableAlternative(
    accounts: readonly Account[],
    model: string,
    accountId: string,
    pool?: Pool,
    providers: readonly ProviderDefinition[] = [],
    requiredCapabilities: readonly UpstreamCapabilityRequirement[] = [],
    excludedAccountIds: readonly string[] = []
  ): boolean {
    const excluded = new Set([accountId, ...excludedAccountIds])
    const eligibility = evaluateSourceEligibility({
      accounts: accounts.filter((account) => !excluded.has(account.id)),
      providers,
      model,
      poolModelPolicy: pool?.modelPolicy,
      poolModelAllowlist: pool?.modelAllowlist,
      requiredCapabilities
    })
    const verifiedAvailable = eligibility.verified.some((account) => this.isAvailable(account, pool))
    if (verifiedAvailable) return true
    return eligibility.unknown.some((account) => this.isAvailable(account, pool))
  }

  /**
   * Drops a session assignment only when it still points at the account whose
   * upstream attempt actually failed. The compare-and-delete protects a newer
   * assignment created by another concurrent request for the same session.
   */
  recordStickyFailure(poolId: string, sessionId: string | undefined, accountId: string): boolean {
    if (!sessionId) return false
    const now = this.now()
    this.cleanupExpiredSticky(now)
    const stickyKey = `${poolId}:${sessionId}`
    const assignment = this.sticky.get(stickyKey)
    if (!assignment || assignment.accountId !== accountId) return false
    this.deleteSticky(stickyKey)
    if (assignment.expiresAt > now) {
      this.setStickyFailureAvoidance(stickyKey, {
        accountId,
        expiresAt: assignment.expiresAt
      })
    }
    return true
  }

  setCooldown(accountId: string, until: number): void {
    const existing = this.health.get(accountId)
    this.health.set(accountId, {
      accountId,
      circuitState: 'open',
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      cooldownUntil: Math.max(until, existing?.cooldownUntil ?? 0),
      lastFailureAt: existing?.lastFailureAt
    })
    this.healthReasons.set(accountId, 'quota')
    this.bumpHealthRevision(accountId)
  }

  recordFailure(accountId: string, options: AccountFailureOptions = {}): AccountRuntimeHealth {
    // A proven runtime account failure is not session-local. Drop every
    // assignment that still points at it, while keeping one-shot per-session
    // avoidance so those conversations prefer a healthy peer next time.
    const now = this.now()
    this.cleanupExpiredSticky(now)
    const stickyKeys = this.stickyKeysByAccount.get(accountId)
    for (const stickyKey of stickyKeys ? [...stickyKeys] : []) {
      const assignment = this.sticky.get(stickyKey)
      if (!assignment || assignment.accountId !== accountId) continue
      this.deleteSticky(stickyKey)
      if (assignment.expiresAt > now) {
        this.setStickyFailureAvoidance(stickyKey, {
          accountId,
          expiresAt: assignment.expiresAt
        })
      }
    }
    const existing = this.health.get(accountId)
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1
    const baseDelayMs = positiveDuration(options.baseDelayMs, 30_000)
    const maxDelayMs = positiveDuration(options.maxDelayMs, 15 * 60_000)
    const exponent = Math.min(20, consecutiveFailures - 1)
    const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
    const retryAfterMs = Math.max(0, options.retryAfterMs ?? 0)
    const cooldownUntil = now + Math.max(backoffMs, retryAfterMs)
    const state: AccountRuntimeHealth = {
      accountId,
      circuitState: 'open',
      consecutiveFailures,
      // A generic transport failure must never shorten an already observed
      // quota window.
      cooldownUntil: Math.max(cooldownUntil, existing?.cooldownUntil ?? 0),
      lastFailureAt: now
    }
    this.health.set(accountId, state)
    const existingReason = this.healthReasons.get(accountId)
    this.healthReasons.set(
      accountId,
      existingReason === 'quota' && (existing?.cooldownUntil ?? 0) > now
        ? 'quota'
        : options.reason ?? 'failure'
    )
    this.bumpHealthRevision(accountId)
    const performance = this.performance.get(accountId)
    this.observeOutcome(accountId, false, {}, now, true)
    const updated = this.performance.get(accountId)
    if (updated) {
      updated.dynamicConcurrency = Math.max(1, Math.floor(
        (performance?.dynamicConcurrency ?? Math.max(1, options.maxConcurrency ?? 2)) / 2
      ))
      updated.successStreak = 0
    }
    return { ...state }
  }

  recordSuccess(accountId: string, expectedRevision?: number): AccountSuccessResult {
    const revision = this.getHealthRevision(accountId)
    const existing = this.health.get(accountId)
    const superseded = expectedRevision !== undefined && expectedRevision !== revision
    // A success without an attempt generation may still close an ordinary
    // failure circuit for backwards compatibility, but must never erase a
    // quota observation. Manual resets use resetHealth() explicitly.
    const missingQuotaGeneration = expectedRevision === undefined
      && existing !== undefined
      && this.healthReasons.get(accountId) === 'quota'
    if (superseded || missingQuotaGeneration) {
      return { ...this.getHealth(accountId), applied: false, revision }
    }
    const state: AccountRuntimeHealth = {
      accountId,
      circuitState: 'closed',
      consecutiveFailures: 0
    }
    if (existing) {
      this.health.delete(accountId)
      this.healthReasons.delete(accountId)
      return { ...state, applied: true, revision: this.bumpHealthRevision(accountId) }
    }
    return { ...state, applied: true, revision }
  }

  resetHealth(accountId: string): AccountRuntimeHealth {
    this.health.delete(accountId)
    this.healthReasons.delete(accountId)
    this.bumpHealthRevision(accountId)
    return { accountId, circuitState: 'closed', consecutiveFailures: 0 }
  }

  getHealthRevision(accountId: string): number {
    return this.healthRevisions.get(accountId) ?? 0
  }

  recordPerformance(accountId: string, sample: AccountPerformanceSample): void {
    this.observeOutcome(accountId, true, sample, this.now(), true)
  }

  private observeOutcome(
    accountId: string,
    success: boolean,
    sample: AccountPerformanceSample,
    observedAt: number,
    adaptConcurrency: boolean
  ): void {
    const transportFirstBodyMs = positiveMetric(sample.transportFirstBodyMs)
    const semanticFirstTokenMs = positiveMetric(
      sample.semanticFirstTokenMs ?? sample.firstTokenMs
    )
    const outputTokens = positiveMetric(sample.outputTokens)
    const generationDurationMs = positiveMetric(sample.generationDurationMs)
    const outputTokensPerSecond = outputTokens !== undefined && generationDurationMs !== undefined
      ? outputTokens * 1000 / generationDurationMs
      : undefined
    const existing = this.performance.get(accountId)
    const elapsed = Math.max(0, observedAt - (existing?.updatedAt ?? observedAt))
    const historyDecay = 0.5 ** (elapsed / FITNESS_HISTORY_HALF_LIFE_MS)
    const historySuccessWeight = (existing?.historySuccessWeight ?? 0) * historyDecay + (success ? 1 : 0)
    const historyFailureWeight = (existing?.historyFailureWeight ?? 0) * historyDecay + (success ? 0 : 1)
    const recentAlpha = success ? 0.12 : 0.28
    const recentSuccessRate = updateEwma(existing?.recentSuccessRate, success ? 1 : 0, recentAlpha) ?? (success ? 1 : 0)
    const performanceSampleCount = (existing?.performanceSampleCount ?? 0)
      + (success && (
        transportFirstBodyMs !== undefined
        || semanticFirstTokenMs !== undefined
        || outputTokensPerSecond !== undefined
      ) ? 1 : 0)
    const transportSampleCount = (existing?.transportSampleCount ?? 0)
      + (success && transportFirstBodyMs !== undefined ? 1 : 0)
    const semanticSampleCount = (existing?.semanticSampleCount ?? 0)
      + (success && semanticFirstTokenMs !== undefined ? 1 : 0)
    const throughputSampleCount = (existing?.throughputSampleCount ?? 0)
      + (success && outputTokensPerSecond !== undefined ? 1 : 0)
    const transportAlpha = metricAlpha(transportSampleCount)
    const semanticAlpha = metricAlpha(semanticSampleCount)
    const throughputAlpha = metricAlpha(throughputSampleCount)
    const successStreak = adaptConcurrency && success ? (existing?.successStreak ?? 0) + 1 : 0
    const dynamicConcurrency = existing?.dynamicConcurrency === undefined
      ? undefined
      : existing.dynamicConcurrency + (adaptConcurrency && success && successStreak >= 8 ? 1 : 0)
    this.performance.set(accountId, {
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      successCount: (existing?.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (existing?.failureCount ?? 0) + (success ? 0 : 1),
      performanceSampleCount,
      transportSampleCount,
      semanticSampleCount,
      throughputSampleCount,
      historySuccessWeight,
      historyFailureWeight,
      recentSuccessRate,
      transportFirstBodyMs: updateEwma(
        existing?.transportFirstBodyMs,
        transportFirstBodyMs,
        transportAlpha
      ),
      semanticFirstTokenMs: updateEwma(
        existing?.semanticFirstTokenMs,
        semanticFirstTokenMs,
        semanticAlpha
      ),
      outputTokensPerSecond: updateEwma(
        existing?.outputTokensPerSecond,
        outputTokensPerSecond,
        throughputAlpha
      ),
      failurePenalty: success
        ? decayedFailurePenaltyAt(existing, observedAt) * 0.65
        : decayedFailurePenaltyAt(existing, observedAt) + 6,
      updatedAt: observedAt,
      dynamicConcurrency,
      successStreak: adaptConcurrency && success && successStreak >= 8 ? 0 : successStreak
    })
  }

  getHealth(accountId: string): AccountRuntimeHealth {
    const state = this.health.get(accountId)
    if (!state) return { accountId, circuitState: 'closed', consecutiveFailures: 0 }
    if (state.circuitState === 'open' && (state.cooldownUntil ?? 0) <= this.now()) {
      state.circuitState = 'half-open'
    }
    return { ...state }
  }

  getInFlight(account: Account): number {
    return this.inFlight(account)
  }

  getFitness(accounts: readonly Account[]): Record<string, AccountFitnessSnapshot> {
    const now = this.now()
    const result: Record<string, AccountFitnessSnapshot> = {}
    for (const account of accounts) {
      const state = this.performance.get(account.id)
      if (!state || state.sampleCount <= 0) {
        result[account.id] = { sampleCount: 0, failurePenalty: 0, stale: true }
        continue
      }
      const elapsed = Math.max(0, now - state.updatedAt)
      const historyDecay = 0.5 ** (elapsed / FITNESS_HISTORY_HALF_LIFE_MS)
      const successWeight = state.historySuccessWeight * historyDecay
      const failureWeight = state.historyFailureWeight * historyDecay
      const effectiveSamples = successWeight + failureWeight
      // An 80% Beta prior prevents one lucky request from receiving a top rating.
      const longTermSuccessRate = (successWeight + 8) / (effectiveSamples + 10)
      const recentMemory = 0.5 ** (elapsed / FITNESS_STALE_AFTER_MS)
      const recentSuccessRate = Math.max(0, Math.min(1,
        state.recentSuccessRate * recentMemory + longTermSuccessRate * (1 - recentMemory)
      ))
      const reliability = 100 * (longTermSuccessRate * 0.65 + recentSuccessRate * 0.35)
      const preferredFirstTokenMs = state.semanticFirstTokenMs ?? state.transportFirstBodyMs
      const responsiveness = responseFitness(preferredFirstTokenMs)
      const throughput = throughputFitness(state.outputTokensPerSecond)
      const failurePenalty = state.failurePenalty * 0.5 ** (elapsed / FAILURE_PENALTY_HALF_LIFE_MS)
      const circuitPenalty = account.cooldownReason === 'failure' || account.circuitState === 'open'
        ? 35
        : Math.min(25, Math.max(0, account.consecutiveFailures ?? 0) * 6)
      const stability = Math.max(0, 100 * Math.exp(-failurePenalty / 10) - circuitPenalty)
      const components = {
        reliability: roundedRating(reliability),
        responsiveness: roundedRating(responsiveness),
        throughput: roundedRating(throughput),
        stability: roundedRating(stability)
      }
      const rawScore = reliability * 0.48 + responsiveness * 0.24 + throughput * 0.16 + stability * 0.12
      const confidenceRatio = 1 - Math.exp(-effectiveSamples / FITNESS_CONFIDENCE_SAMPLES)
      const score = roundedRating(rawScore * confidenceRatio + FITNESS_NEUTRAL_PRIOR * (1 - confidenceRatio))
      result[account.id] = {
        score,
        sampleCount: state.sampleCount,
        successCount: state.successCount,
        failureCount: state.failureCount,
        successRate: roundedPercent(longTermSuccessRate),
        recentSuccessRate: roundedPercent(recentSuccessRate),
        confidence: roundedPercent(confidenceRatio),
        firstTokenMs: preferredFirstTokenMs,
        semanticFirstTokenMs: state.semanticFirstTokenMs,
        transportFirstBodyMs: state.transportFirstBodyMs,
        outputTokensPerSecond: state.outputTokensPerSecond,
        failurePenalty,
        components,
        updatedAt: state.updatedAt,
        stale: elapsed >= FITNESS_STALE_AFTER_MS,
        dynamicConcurrency: state.dynamicConcurrency
      }
    }
    return result
  }

  clear(): void {
    this.active.clear()
    this.roundRobinOffsets.clear()
    this.smoothWeighted.clear()
    this.sticky.clear()
    this.stickyExpiry.length = 0
    this.stickyKeysByAccount.clear()
    this.stickyFailureAvoidance.clear()
    this.stickyFailureExpiry.length = 0
    this.activeStickySessions.clear()
    this.activeStickySessionCounts.clear()
    this.aggregatePoolIndexes = new WeakMap()
    this.accountModelIndexes = new WeakMap()
    this.health.clear()
    this.healthRevisions.clear()
    this.healthReasons.clear()
    this.performance.clear()
  }

  private bumpHealthRevision(accountId: string): number {
    const next = this.getHealthRevision(accountId) + 1
    this.healthRevisions.set(accountId, next)
    return next
  }

  private isEligible(account: Account, pool: Pool, adaptiveConcurrency: boolean, now = this.now()): boolean {
    if (!this.isAvailable(account, pool, now)) return false
    return this.inFlight(account) < this.concurrencyLimit(account, adaptiveConcurrency)
  }

  private isAvailable(account: Account, pool?: Pool, now = this.now()): boolean {
    const health = this.health.get(account.id)
    if (health?.circuitState === 'open' && (health.cooldownUntil ?? 0) <= now) {
      health.circuitState = 'half-open'
    }
    const cooldownUntil = Math.max(account.cooldownUntil ?? 0, health?.cooldownUntil ?? 0)
    if (account.status === 'disabled' || account.status === 'expired' || account.status === 'checking') return false
    if (account.status === 'cooldown' && account.cooldownUntil === undefined) return false
    if (quotaExhausted(account, now)) return false
    if (quotaProtectionBlocks(account.codexQuota, account.quotaProtection, now)) return false
    if (quotaProtectionBlocks(account.codexQuota, pool?.quotaProtection, now)) return false
    if (cooldownUntil > now || (health?.circuitState === 'half-open' && this.inFlight(account) > 0)) return false
    return true
  }

  private pick(pool: Pool, candidates: Account[], configuredAccounts: readonly Account[], stickyKey?: string): Account {
    const aggregate = isRelayAggregate(pool)
    const aggregateIndex = aggregate ? this.getAggregatePoolIndex(pool) : undefined
    switch (pool.strategy) {
      case 'priority':
        return selectMinimum(candidates, (account) => aggregateIndex
          ? aggregateIndex.orderByAccountId.get(account.id) ?? Number.MAX_SAFE_INTEGER
          : effectivePriority(account), (a, b) => this.inFlight(a) - this.inFlight(b))
      case 'balanced':
        return selectMinimum(candidates,
          (account) => this.inFlight(account) / this.concurrencyLimit(account, false),
          (a, b) => quotaPressure(a) - quotaPressure(b)
            || a.priority - b.priority
            || a.id.localeCompare(b.id))
      case 'autobalanced':
        return this.pickAutoBalanced(candidates, stickyKey)
      case 'round-robin': {
        const ordered = aggregateIndex
          ? orderAggregateCandidates(aggregateIndex, candidates)
          : candidates
        const offset = this.roundRobinOffsets.get(pool.id) ?? 0
        const selected = ordered[offset % ordered.length]
        this.roundRobinOffsets.set(pool.id, (offset + 1) % ordered.length)
        return selected
      }
      case 'weighted-round-robin':
        return this.pickSmoothWeighted(pool, candidates, configuredAccounts)
      case 'weighted-random': {
        const total = candidates.reduce((sum, account) => sum + effectiveWeight(account), 0)
        if (total <= 0) return candidates[Math.floor(this.random() * candidates.length)]
        let threshold = this.random() * total
        for (const account of candidates) {
          threshold -= effectiveWeight(account)
          if (threshold < 0) return account
        }
        return candidates[candidates.length - 1]
      }
    }
  }

  /**
   * Smooth weighted round robin (the same family of algorithm used by nginx).
   * Over every complete weight window it produces the exact configured ratio,
   * while spreading high-weight members across the window instead of serving
   * them in one burst.
   */
  private pickSmoothWeighted(pool: Pool, candidates: Account[], configuredAccounts: readonly Account[]): Account {
    const aggregate = isRelayAggregate(pool)
    const aggregateIndex = aggregate ? this.getAggregatePoolIndex(pool) : undefined
    const ordered = aggregateIndex ? orderAggregateCandidates(aggregateIndex, candidates) : candidates
    let state = this.smoothWeighted.get(pool.id)
    const aggregateConfiguration = aggregateIndex?.smoothConfiguration
    const configurationChanged = aggregateConfiguration
      ? !state || !orderedMapEqual(state.configuration, aggregateConfiguration)
      : !state || !configurationMatchesAccounts(state.configuration, configuredAccounts)
    if (configurationChanged) {
      const configuration = aggregateConfiguration ?? new Map(
        configuredAccounts.map((account) => [account.id, effectiveWeight(account)])
      )
      state = { configuration, current: new Map() }
      this.smoothWeighted.set(pool.id, state)
    }
    if (!state) throw new NoEligibleAccountError()

    const weightFor = (account: Account): number => aggregateIndex
      ? aggregateIndex.weightByAccountId.get(account.id) ?? 1
      : effectiveWeight(account)
    let hasPositiveWeight = false
    for (const account of ordered) {
      if (weightFor(account) > 0) {
        hasPositiveWeight = true
        break
      }
    }
    let totalWeight = 0
    let selected = ordered[0]
    let selectedCurrent = Number.NEGATIVE_INFINITY
    for (const account of ordered) {
      const weight = hasPositiveWeight ? weightFor(account) : 1
      totalWeight += weight
      const current = (state.current.get(account.id) ?? 0) + weight
      state.current.set(account.id, current)
      // Keeping the first entry on ties makes the result deterministic. Relay
      // aggregates are already sorted by member order; standard pools retain
      // their existing account-array order.
      if (current > selectedCurrent) {
        selected = account
        selectedCurrent = current
      }
    }
    state.current.set(selected.id, selectedCurrent - totalWeight)
    return selected
  }

  private inFlight(account: Account): number {
    return Math.max(0, account.inFlight) + (this.active.get(account.id) ?? 0)
  }

  private pickAutoBalanced(candidates: Account[], stickyKey?: string): Account {
    const unmeasured: Account[] = []
    const measured: Account[] = []
    for (const account of candidates) {
      ;(this.hasPerformanceSample(account.id) ? measured : unmeasured).push(account)
    }
    if (unmeasured.length > 0 && measured.length > 0 && this.random() < AUTO_BALANCED_EXPLORATION_RATE) {
      return unmeasured[Math.min(unmeasured.length - 1, Math.floor(this.random() * unmeasured.length))]
    }
    const now = this.now()
    const prior = conservativePerformancePrior(measured.map((account) =>
      performanceCost(this.performance.get(account.id), now)))
    let minimumCost = Number.POSITIVE_INFINITY
    const best: Account[] = []
    for (const account of candidates) {
      const cost = this.autoBalancedCost(account, prior, stickyKey, now)
      if (cost < minimumCost - 0.001) {
        minimumCost = cost
        best.length = 0
        best.push(account)
      } else if (Math.abs(cost - minimumCost) < 0.001) {
        best.push(account)
      }
    }
    if (best.length > 1) {
      return best[Math.min(best.length - 1, Math.floor(this.random() * best.length))]
    }
    return best[0]
  }

  private shouldEscapeSticky(selected: Account, candidates: Account[]): boolean {
    const selectedPerformance = this.performance.get(selected.id)
    const selectedMetric = stickyResponseMetric(selectedPerformance)
    if (
      !selectedPerformance
      || !selectedMetric
      || selectedMetric.sampleCount < STICKY_ESCAPE_MINIMUM_SAMPLES
      || this.now() - selectedPerformance.updatedAt >= PERFORMANCE_STALE_AFTER_MS
    ) return false
    const now = this.now()
    let fastestMs = Number.POSITIVE_INFINITY
    for (const account of candidates) {
      if (account.id === selected.id) continue
      const performance = this.performance.get(account.id)
      const metric = stickyResponseMetric(performance)
      if (
        !performance
        || !metric
        || metric.kind !== selectedMetric.kind
        || metric.sampleCount < STICKY_ESCAPE_MINIMUM_SAMPLES
        || now - performance.updatedAt >= PERFORMANCE_STALE_AFTER_MS
      ) continue
      if (metric.valueMs < fastestMs) fastestMs = metric.valueMs
    }
    if (!Number.isFinite(fastestMs)) return false
    return selectedMetric.valueMs >= Math.max(
      fastestMs + STICKY_ESCAPE_MINIMUM_DELTA_MS,
      fastestMs * STICKY_ESCAPE_RATIO
    )
  }

  private shouldSpreadConcurrentSticky(
    stickyKey: string,
    selected: Account,
    candidates: Account[]
  ): boolean {
    const selectedSessionLoad = this.activeStickySessionCount(selected.id, stickyKey)
    if (selectedSessionLoad <= 0) return false
    let hasLowerLoadAlternative = false
    for (const account of candidates) {
      if (
        account.id !== selected.id
        && this.activeStickySessionCount(account.id, stickyKey) < selectedSessionLoad
      ) {
        hasLowerLoadAlternative = true
        break
      }
    }
    if (!hasLowerLoadAlternative) return false
    const measured = candidates.filter((account) => this.hasPerformanceSample(account.id))
    const now = this.now()
    const prior = conservativePerformancePrior(measured.map((account) =>
      performanceCost(this.performance.get(account.id), now)))
    const selectedCost = this.autoBalancedCost(selected, prior, stickyKey, now)
    for (const account of candidates) {
      if (
        account.id !== selected.id
        && this.activeStickySessionCount(account.id, stickyKey) < selectedSessionLoad
        && this.autoBalancedCost(account, prior, stickyKey, now) < selectedCost
      ) return true
    }
    return false
  }

  private autoBalancedCost(
    account: Account,
    unmeasuredPrior: number,
    stickyKey?: string,
    now = this.now()
  ): number {
    const utilization = this.inFlight(account) / this.concurrencyLimit(account, true)
    const performance = this.performance.get(account.id)
    const performanceEstimate = estimatedPerformanceCost(performance, unmeasuredPrior, now)
    return utilization * 1_000
      + this.activeStickySessionCount(account.id, stickyKey) * CONCURRENT_STICKY_SESSION_PENALTY
      + quotaPressure(account) * 200
      + performanceEstimate * 10
      + account.priority
  }

  private activeStickySessionCount(accountId: string, excludingStickyKey?: string): number {
    const count = this.activeStickySessionCounts.get(accountId) ?? 0
    if (!excludingStickyKey) return count
    return count - ((this.activeStickySessions.get(excludingStickyKey)?.get(accountId) ?? 0) > 0 ? 1 : 0)
  }

  private acquireActiveStickySession(stickyKey: string, accountId: string): void {
    const accounts = this.activeStickySessions.get(stickyKey) ?? new Map<string, number>()
    if ((accounts.get(accountId) ?? 0) === 0) {
      this.activeStickySessionCounts.set(accountId, (this.activeStickySessionCounts.get(accountId) ?? 0) + 1)
    }
    accounts.set(accountId, (accounts.get(accountId) ?? 0) + 1)
    this.activeStickySessions.set(stickyKey, accounts)
  }

  private releaseActiveStickySession(stickyKey: string, accountId: string): void {
    const accounts = this.activeStickySessions.get(stickyKey)
    if (!accounts) return
    const remaining = Math.max(0, (accounts.get(accountId) ?? 0) - 1)
    if (remaining > 0) accounts.set(accountId, remaining)
    else {
      accounts.delete(accountId)
      const sessionCount = Math.max(0, (this.activeStickySessionCounts.get(accountId) ?? 0) - 1)
      if (sessionCount > 0) this.activeStickySessionCounts.set(accountId, sessionCount)
      else this.activeStickySessionCounts.delete(accountId)
    }
    if (accounts.size === 0) this.activeStickySessions.delete(stickyKey)
  }

  private setSticky(stickyKey: string, assignment: StickyAssignment): void {
    this.deleteSticky(stickyKey)
    this.sticky.set(stickyKey, assignment)
    const keys = this.stickyKeysByAccount.get(assignment.accountId) ?? new Set<string>()
    keys.add(stickyKey)
    this.stickyKeysByAccount.set(assignment.accountId, keys)
    pushExpiry(this.stickyExpiry, { key: stickyKey, expiresAt: assignment.expiresAt })
    compactExpiryHeap(this.stickyExpiry, this.sticky)
  }

  private deleteSticky(stickyKey: string): StickyAssignment | undefined {
    const assignment = this.sticky.get(stickyKey)
    if (!assignment) return undefined
    this.sticky.delete(stickyKey)
    const keys = this.stickyKeysByAccount.get(assignment.accountId)
    keys?.delete(stickyKey)
    if (keys?.size === 0) this.stickyKeysByAccount.delete(assignment.accountId)
    return assignment
  }

  private setStickyFailureAvoidance(stickyKey: string, avoidance: StickyFailureAvoidance): void {
    this.stickyFailureAvoidance.set(stickyKey, avoidance)
    pushExpiry(this.stickyFailureExpiry, { key: stickyKey, expiresAt: avoidance.expiresAt })
    compactExpiryHeap(this.stickyFailureExpiry, this.stickyFailureAvoidance)
  }

  private deleteStickyFailureAvoidance(stickyKey: string): void {
    this.stickyFailureAvoidance.delete(stickyKey)
  }

  /**
   * Expiration heaps make cleanup global instead of relying on the same
   * session being selected again. Entries are lazy: replacing/deleting a
   * sticky assignment leaves its old heap node behind, which is discarded
   * after comparing it with the current map value.
   */
  private cleanupExpiredSticky(now: number): void {
    while ((this.stickyExpiry[0]?.expiresAt ?? Number.POSITIVE_INFINITY) <= now) {
      const expired = popExpiry(this.stickyExpiry)
      if (!expired) break
      const current = this.sticky.get(expired.key)
      if (current?.expiresAt === expired.expiresAt) this.deleteSticky(expired.key)
    }
    while ((this.stickyFailureExpiry[0]?.expiresAt ?? Number.POSITIVE_INFINITY) <= now) {
      const expired = popExpiry(this.stickyFailureExpiry)
      if (!expired) break
      const current = this.stickyFailureAvoidance.get(expired.key)
      if (current?.expiresAt === expired.expiresAt) this.deleteStickyFailureAvoidance(expired.key)
    }
  }

  private getAggregatePoolIndex(pool: Pool): AggregatePoolIndex {
    const cached = this.aggregatePoolIndexes.get(pool)
    if (
      cached
      && cached.pool === pool
      && cached.members === pool.members
      && cached.updatedAt === pool.updatedAt
    ) return cached

    const orderedMembers = pool.members
      .map((member, position) => ({
        member,
        position,
        order: finiteNumber(member.order, position)
      }))
      .sort((a, b) => a.order - b.order
        || a.position - b.position
        || a.member.accountId.localeCompare(b.member.accountId))
    const orderedAccountIds = orderedMembers.map(({ member }) => member.accountId)
    const orderByAccountId = new Map(orderedAccountIds.map((accountId, rank) => [accountId, rank]))
    const weightByAccountId = new Map(pool.members.map((member) => [
      member.accountId,
      positiveFiniteNumber(member.weight, 1)
    ]))
    const smoothConfiguration = new Map(orderedMembers
      .filter(({ member }) => member.enabled)
      .map(({ member }) => [member.accountId, positiveFiniteNumber(member.weight, 1)]))
    const index: AggregatePoolIndex = {
      pool,
      members: pool.members,
      updatedAt: pool.updatedAt,
      orderedAccountIds,
      orderByAccountId,
      weightByAccountId,
      smoothConfiguration
    }
    this.aggregatePoolIndexes.set(pool, index)
    return index
  }

  private accountAllowsModel(account: Account, model: string): boolean {
    if (account.modelPolicy !== 'selected' && account.modelsRefreshedAt === undefined) return true
    const source = account.modelPolicy === 'selected' ? account.modelAllowlist : account.availableModels
    let index = this.accountModelIndexes.get(account)
    if (
      !index
      || index.updatedAt !== account.updatedAt
      || index.modelPolicy !== account.modelPolicy
      || index.modelsRefreshedAt !== account.modelsRefreshedAt
      || index.source !== source
    ) {
      index = {
        updatedAt: account.updatedAt,
        modelPolicy: account.modelPolicy,
        modelsRefreshedAt: account.modelsRefreshedAt,
        source,
        allowed: new Set(source)
      }
      this.accountModelIndexes.set(account, index)
    }
    return index.allowed.has(model)
  }

  private hasPerformanceSample(accountId: string): boolean {
    return (this.performance.get(accountId)?.performanceSampleCount ?? 0) > 0
  }

  private decayedFailurePenalty(state: AccountPerformanceState | undefined): number {
    if (!state?.failurePenalty) return 0
    const elapsed = Math.max(0, this.now() - state.updatedAt)
    return state.failurePenalty * 0.5 ** (elapsed / FAILURE_PENALTY_HALF_LIFE_MS)
  }

  private concurrencyLimit(account: Account, adaptive: boolean): number {
    if (!adaptive) return Math.max(1, account.maxConcurrency)
    return Math.max(1, Math.min(
      Math.max(1, account.maxConcurrency),
      this.performance.get(account.id)?.dynamicConcurrency ?? Math.max(1, account.maxConcurrency)
    ))
  }
}

/** Pure policy evaluator exported for diagnostics and deterministic tests. */
export function quotaProtectionBlocks(
  quota: Account['codexQuota'],
  policy: QuotaProtectionPolicy | undefined,
  now = Date.now()
): boolean {
  if (!policy) return false
  const protectsFiveHour = finiteReserve(policy.fiveHourRemainingPercent) !== undefined
  const protectsSevenDay = finiteReserve(policy.sevenDayRemainingPercent) !== undefined
  if (!protectsFiveHour && !protectsSevenDay) return false

  const staleAfterMinutes = positiveFinite(policy.staleAfterMinutes)
  const unavailable = !quota || (
    staleAfterMinutes !== undefined
    && now - quota.observedAt > staleAfterMinutes * 60_000
  )
  if (unavailable) return policy.unavailableBehavior === 'block'

  const fiveHourReserve = finiteReserve(policy.fiveHourRemainingPercent)
  if (fiveHourReserve !== undefined) {
    const used = finiteUsedPercent(quota.fiveHour?.usedPercent)
    if (used === undefined) {
      if (policy.unavailableBehavior === 'block') return true
    } else if (100 - used <= fiveHourReserve) {
      return true
    }
  }
  const sevenDayReserve = finiteReserve(policy.sevenDayRemainingPercent)
  if (sevenDayReserve !== undefined) {
    const used = finiteUsedPercent(quota.sevenDay?.usedPercent)
    if (used === undefined) {
      if (policy.unavailableBehavior === 'block') return true
    } else if (100 - used <= sevenDayReserve) {
      return true
    }
  }
  return false
}

function finiteReserve(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value!)) : undefined
}

function finiteUsedPercent(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value!)) : undefined
}

function positiveFinite(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? value : undefined
}

function estimatedPerformanceCost(
  state: AccountPerformanceState | undefined,
  unmeasuredPrior: number,
  now: number
): number {
  if (!state) return unmeasuredPrior
  const measuredCost = performanceCost(state, now)
  const staleRegression = Math.max(0, Math.min(1, (now - state.updatedAt) / PERFORMANCE_STALE_AFTER_MS))
  return measuredCost * (1 - staleRegression) + unmeasuredPrior * staleRegression
}

function performanceCost(state: AccountPerformanceState | undefined, now: number): number {
  if (!state) return 4
  const firstTokenSeconds = schedulerFirstTokenCostMs(state) / 1000
  const outputPenalty = state.outputTokensPerSecond === undefined
    ? 1.5
    : 50 / Math.max(1, state.outputTokensPerSecond)
  const elapsed = Math.max(0, now - state.updatedAt)
  const failurePenalty = state.failurePenalty * 0.5 ** (elapsed / FAILURE_PENALTY_HALF_LIFE_MS)
  return Math.min(20, firstTokenSeconds) * 0.6
    + Math.min(20, outputPenalty) * 1.4
    + failurePenalty
}

function conservativePerformancePrior(costs: number[]): number {
  if (costs.length === 0) return 4
  const ordered = [...costs].sort((a, b) => a - b)
  const p75 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.75) - 1)]
  return Math.max(4, p75 * 1.15)
}

function transportFirstBodyPerformanceMs(log: RequestLog): number | undefined {
  if (log.upstreamFirstByteMs !== undefined) {
    // firstTokenMs is request-relative while accountFirstTokenMs is relative to
    // the successful attempt. Their difference removes time spent in failed
    // attempts before attributing the raw first byte to the winning account.
    const previousAttemptsMs = log.firstTokenMs !== undefined && log.accountFirstTokenMs !== undefined
      ? Math.max(0, log.firstTokenMs - log.accountFirstTokenMs)
      : 0
    return positiveMetric(Math.max(0, log.upstreamFirstByteMs - previousAttemptsMs))
  }
  // Before phase timing was introduced firstTokenMs meant the raw upstream
  // chunk. New semantic-TTFT logs can be distinguished by accountFirstTokenMs.
  return log.accountFirstTokenMs === undefined ? positiveMetric(log.firstTokenMs) : undefined
}

function semanticFirstTokenPerformanceMs(log: RequestLog): number | undefined {
  return positiveMetric(log.accountFirstTokenMs)
}

function failedAttemptDurationMs(log: RequestLog): number {
  return log.firstTokenMs !== undefined && log.accountFirstTokenMs !== undefined
    ? Math.max(0, log.firstTokenMs - log.accountFirstTokenMs)
    : 0
}

function schedulerFirstTokenCostMs(state: AccountPerformanceState): number {
  if (state.semanticFirstTokenMs !== undefined) return state.semanticFirstTokenMs
  if (state.transportFirstBodyMs !== undefined) {
    return Math.max(
      TRANSPORT_FALLBACK_FLOOR_MS,
      state.transportFirstBodyMs + TRANSPORT_FALLBACK_UNCERTAINTY_MS
    )
  }
  return 3_000
}

type StickyResponseMetric = {
  kind: 'semantic' | 'transport'
  valueMs: number
  sampleCount: number
}

function stickyResponseMetric(
  state: AccountPerformanceState | undefined
): StickyResponseMetric | undefined {
  if (!state) return undefined
  if (state.semanticFirstTokenMs !== undefined) {
    return {
      kind: 'semantic',
      valueMs: state.semanticFirstTokenMs,
      sampleCount: state.semanticSampleCount
    }
  }
  if (state.transportFirstBodyMs !== undefined) {
    return {
      kind: 'transport',
      valueMs: state.transportFirstBodyMs,
      sampleCount: state.transportSampleCount
    }
  }
  return undefined
}

function positiveMetric(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function updateEwma(
  current: number | undefined,
  sample: number | undefined,
  alpha: number
): number | undefined {
  if (sample === undefined) return current
  if (current === undefined) return sample
  return current + alpha * (sample - current)
}

function metricAlpha(sampleCount: number): number {
  return sampleCount < 5 ? 0.45 : 0.18
}

function responseFitness(firstTokenMs: number | undefined): number {
  if (firstTokenMs === undefined) return FITNESS_NEUTRAL_PRIOR
  return 100 / (1 + (Math.max(1, firstTokenMs) / 1_800) ** 1.25)
}

function throughputFitness(tokensPerSecond: number | undefined): number {
  if (tokensPerSecond === undefined) return FITNESS_NEUTRAL_PRIOR
  return 100 * (1 - Math.exp(-Math.max(0, tokensPerSecond) / 45))
}

function decayedFailurePenaltyAt(state: AccountPerformanceState | undefined, observedAt: number): number {
  if (!state?.failurePenalty) return 0
  const elapsed = Math.max(0, observedAt - state.updatedAt)
  return state.failurePenalty * 0.5 ** (elapsed / FAILURE_PENALTY_HALF_LIFE_MS)
}

function roundedRating(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function roundedPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 1_000) / 10))
}

function quotaWindows(account: Account) {
  const quota = account.quota
  return quota ? [quota.requests, quota.tokens, quota.inputTokens, quota.outputTokens].filter(Boolean) : []
}

function quotaExhausted(account: Account, now: number): boolean {
  return codexQuotaIsExhausted(account.codexQuota, now)
    || quotaWindows(account).some((window) =>
      window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

function quotaPressure(account: Account): number {
  let pressure = 0
  for (const window of quotaWindows(account)) {
    if (window?.limit === undefined || window.limit <= 0 || window.remaining === undefined) continue
    pressure = Math.max(pressure, Math.max(0, Math.min(1, 1 - window.remaining / window.limit)))
  }
  return pressure
}

function effectivePriority(account: Account): number {
  return account.priority + Math.round(quotaPressure(account) * 1000)
}

function effectiveWeight(account: Account): number {
  return Math.max(0, account.weight) * Math.max(0.05, 1 - quotaPressure(account))
}

function isRelayAggregate(pool: Pool): boolean {
  return pool.kind === 'relay-aggregate'
}

function orderAggregateCandidates(index: AggregatePoolIndex, candidates: Account[]): Account[] {
  const ordered: Account[] = []
  const candidatesById = new Map(candidates.map((account) => [account.id, account]))
  for (const accountId of index.orderedAccountIds) {
    const candidate = candidatesById.get(accountId)
    if (candidate) ordered.push(candidate)
  }
  // Defensive compatibility for a transient configuration snapshot where the
  // scheduler sees an account before the pool-member index. Normal aggregate
  // calls never enter this branch.
  const unknown = candidates
    .filter((account) => !index.orderByAccountId.has(account.id))
    .sort((a, b) => a.id.localeCompare(b.id))
  ordered.push(...unknown)
  return ordered
}

function orderedMapEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false
  const leftEntries = left.entries()
  const rightEntries = right.entries()
  while (true) {
    const a = leftEntries.next()
    const b = rightEntries.next()
    if (a.done || b.done) return a.done === b.done
    if (a.value[0] !== b.value[0] || a.value[1] !== b.value[1]) return false
  }
}

function configurationMatchesAccounts(
  configuration: Map<string, number>,
  accounts: readonly Account[]
): boolean {
  if (configuration.size !== accounts.length) return false
  const entries = configuration.entries()
  for (const account of accounts) {
    const entry = entries.next()
    if (entry.done || entry.value[0] !== account.id || entry.value[1] !== effectiveWeight(account)) return false
  }
  return entries.next().done === true
}

function selectMinimum(
  candidates: Account[],
  score: (account: Account) => number,
  tieBreak: (left: Account, right: Account) => number
): Account {
  let selected = candidates[0]
  let selectedScore = score(selected)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const candidateScore = score(candidate)
    if (
      candidateScore < selectedScore
      || (candidateScore === selectedScore && tieBreak(candidate, selected) < 0)
    ) {
      selected = candidate
      selectedScore = candidateScore
    }
  }
  return selected
}

function pushExpiry(heap: StickyExpiryEntry[], entry: StickyExpiryEntry): void {
  let index = heap.push(entry) - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].expiresAt <= entry.expiresAt) break
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = entry
}

function popExpiry(heap: StickyExpiryEntry[]): StickyExpiryEntry | undefined {
  const first = heap[0]
  const last = heap.pop()
  if (!first || !last || heap.length === 0) return first
  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child = right < heap.length && heap[right].expiresAt < heap[left].expiresAt ? right : left
    if (heap[child].expiresAt >= last.expiresAt) break
    heap[index] = heap[child]
    index = child
  }
  heap[index] = last
  return first
}

function compactExpiryHeap<T extends { expiresAt: number }>(
  heap: StickyExpiryEntry[],
  current: ReadonlyMap<string, T>
): void {
  // Renewals intentionally leave lazy heap entries behind. Periodic linear
  // compaction keeps memory proportional to live sessions while retaining the
  // cheap O(log n) common path.
  if (heap.length <= current.size * 4 + 64) return
  heap.length = 0
  for (const [key, value] of current) pushExpiry(heap, { key, expiresAt: value.expiresAt })
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveFiniteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
