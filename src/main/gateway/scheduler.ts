import type { Account, AccountCircuitState, AccountFitnessSnapshot, Pool, RequestLog } from '../../shared/types'
import type { ScheduledAccount, SchedulerSelectionInput } from './types'

interface StickyAssignment {
  accountId: string
  expiresAt: number
}

interface SmoothWeightedState {
  /** Reset the accumulated scores whenever membership/order/weights change. */
  signature: string
  current: Map<string, number>
}

export interface AccountRuntimeHealth {
  accountId: string
  circuitState: AccountCircuitState
  consecutiveFailures: number
  cooldownUntil?: number
  lastFailureAt?: number
}

export interface AccountFailureOptions {
  retryAfterMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  maxConcurrency?: number
}

export interface AccountPerformanceSample {
  firstTokenMs?: number
  outputTokens?: number
  generationDurationMs?: number
}

interface AccountPerformanceState {
  sampleCount: number
  successCount: number
  failureCount: number
  performanceSampleCount: number
  historySuccessWeight: number
  historyFailureWeight: number
  recentSuccessRate: number
  firstTokenMs?: number
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
// Prefer spreading simultaneously active conversations across accounts without
// making it a hard constraint. A clearly unhealthy/slow alternative may still
// lose even when it currently owns fewer conversations.
const CONCURRENT_STICKY_SESSION_PENALTY = 120

export class NoEligibleAccountError extends Error {
  constructor(message = 'No eligible account is available for this request') {
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

export function poolAllowsModel(pool: Pool, accounts: Account[], model: string): boolean {
  if (pool.modelPolicy === 'selected' && !pool.modelAllowlist.includes(model)) return false
  return accounts.some((account) => accountAllowsModel(account, model))
}

/** In-memory scheduler state deliberately stays separate from persisted account metadata. */
export class PoolScheduler {
  private readonly active = new Map<string, number>()
  private readonly roundRobinOffsets = new Map<string, number>()
  private readonly smoothWeighted = new Map<string, SmoothWeightedState>()
  private readonly sticky = new Map<string, StickyAssignment>()
  private readonly activeStickySessions = new Map<string, Map<string, number>>()
  private readonly health = new Map<string, AccountRuntimeHealth>()
  private readonly performance = new Map<string, AccountPerformanceState>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random()
  ) {}

  hydrate(accounts: Account[]): void {
    const accountIds = new Set(accounts.map((account) => account.id))
    for (const accountId of this.health.keys()) {
      if (!accountIds.has(accountId)) this.health.delete(accountId)
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
        const firstTokenMs = log.status === 'success' ? rawFirstBytePerformanceMs(log) : undefined
        this.observeOutcome(accountId, log.status === 'success', {
          firstTokenMs,
          outputTokens: log.outputTokens,
          generationDurationMs: firstTokenMs === undefined
            ? undefined
            : Math.max(0, log.latencyMs - (log.upstreamFirstByteMs ?? firstTokenMs))
        }, log.timestamp, false)
      }
    }
  }

  selectAndAcquire(input: SchedulerSelectionInput): ScheduledAccount {
    const { pool, accounts, model, sessionId } = input
    if (pool.strategy !== 'weighted-round-robin') this.smoothWeighted.delete(pool.id)
    if (!poolAllowsModel(pool, accounts, model)) throw new ModelNotExposedError()

    const candidates = accounts
      .filter((account) => accountAllowsModel(account, model))
      .filter((account) => this.isEligible(account, pool.strategy === 'autobalanced'))
    if (candidates.length === 0) {
      throw new NoEligibleAccountError()
    }

    const stickyKey = pool.stickySessions && sessionId ? `${pool.id}:${sessionId}` : undefined
    let selected: Account | undefined
    let escapedStickyAccountId: string | undefined
    if (pool.stickySessions && stickyKey) {
      const assignment = this.sticky.get(stickyKey)
      if (assignment && assignment.expiresAt > this.now()) {
        selected = candidates.find((account) => account.id === assignment.accountId)
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
          this.sticky.delete(stickyKey)
        }
      } else if (assignment) {
        this.sticky.delete(stickyKey)
      }
    }

    selected ??= this.pick(
      pool,
      escapedStickyAccountId
        ? candidates.filter((account) => account.id !== escapedStickyAccountId)
        : candidates,
      accounts,
      stickyKey
    )
    this.active.set(selected.id, (this.active.get(selected.id) ?? 0) + 1)
    if (stickyKey) this.acquireActiveStickySession(stickyKey, selected.id)

    if (pool.stickySessions && stickyKey) {
      this.sticky.set(stickyKey, {
        accountId: selected.id,
        expiresAt: this.now() + Math.max(1, pool.stickyTtlMinutes) * 60_000
      })
    }

    let released = false
    return {
      account: selected,
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

  setCooldown(accountId: string, until: number): void {
    const existing = this.health.get(accountId)
    this.health.set(accountId, {
      accountId,
      circuitState: 'open',
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      cooldownUntil: Math.max(until, existing?.cooldownUntil ?? 0),
      lastFailureAt: existing?.lastFailureAt
    })
  }

  recordFailure(accountId: string, options: AccountFailureOptions = {}): AccountRuntimeHealth {
    const existing = this.health.get(accountId)
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1
    const baseDelayMs = positiveDuration(options.baseDelayMs, 30_000)
    const maxDelayMs = positiveDuration(options.maxDelayMs, 15 * 60_000)
    const exponent = Math.min(20, consecutiveFailures - 1)
    const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
    const retryAfterMs = Math.max(0, options.retryAfterMs ?? 0)
    const state: AccountRuntimeHealth = {
      accountId,
      circuitState: 'open',
      consecutiveFailures,
      cooldownUntil: this.now() + Math.max(backoffMs, retryAfterMs),
      lastFailureAt: this.now()
    }
    this.health.set(accountId, state)
    const performance = this.performance.get(accountId)
    this.observeOutcome(accountId, false, {}, this.now(), true)
    const updated = this.performance.get(accountId)
    if (updated) {
      updated.dynamicConcurrency = Math.max(1, Math.floor(
        (performance?.dynamicConcurrency ?? Math.max(1, options.maxConcurrency ?? 2)) / 2
      ))
      updated.successStreak = 0
    }
    return { ...state }
  }

  recordSuccess(accountId: string): AccountRuntimeHealth {
    const state: AccountRuntimeHealth = {
      accountId,
      circuitState: 'closed',
      consecutiveFailures: 0
    }
    this.health.delete(accountId)
    return state
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
    const firstTokenMs = positiveMetric(sample.firstTokenMs)
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
      + (success && (firstTokenMs !== undefined || outputTokensPerSecond !== undefined) ? 1 : 0)
    const alpha = performanceSampleCount < 5 ? 0.45 : 0.18
    const successStreak = adaptConcurrency && success ? (existing?.successStreak ?? 0) + 1 : 0
    const dynamicConcurrency = existing?.dynamicConcurrency === undefined
      ? undefined
      : existing.dynamicConcurrency + (adaptConcurrency && success && successStreak >= 8 ? 1 : 0)
    this.performance.set(accountId, {
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      successCount: (existing?.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (existing?.failureCount ?? 0) + (success ? 0 : 1),
      performanceSampleCount,
      historySuccessWeight,
      historyFailureWeight,
      recentSuccessRate,
      firstTokenMs: updateEwma(existing?.firstTokenMs, firstTokenMs, alpha),
      outputTokensPerSecond: updateEwma(
        existing?.outputTokensPerSecond,
        outputTokensPerSecond,
        alpha
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
      const responsiveness = responseFitness(state.firstTokenMs)
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
        firstTokenMs: state.firstTokenMs,
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
    this.activeStickySessions.clear()
    this.health.clear()
    this.performance.clear()
  }

  private isEligible(account: Account, adaptiveConcurrency: boolean): boolean {
    const now = this.now()
    const health = this.health.get(account.id)
    if (health?.circuitState === 'open' && (health.cooldownUntil ?? 0) <= now) {
      health.circuitState = 'half-open'
    }
    const cooldownUntil = Math.max(account.cooldownUntil ?? 0, health?.cooldownUntil ?? 0)
    if (account.status === 'disabled' || account.status === 'expired' || account.status === 'checking') return false
    if (account.status === 'cooldown' && account.cooldownUntil === undefined) return false
    if (quotaExhausted(account, now)) return false
    if (cooldownUntil > now || (health?.circuitState === 'half-open' && this.inFlight(account) > 0)) return false
    return this.inFlight(account) < this.concurrencyLimit(account, adaptiveConcurrency)
  }

  private pick(pool: Pool, candidates: Account[], configuredAccounts: Account[], stickyKey?: string): Account {
    const aggregate = isRelayAggregate(pool)
    switch (pool.strategy) {
      case 'priority':
        if (aggregate) return orderedAggregateCandidates(pool, candidates)[0]
        return [...candidates].sort((a, b) =>
          effectivePriority(a) - effectivePriority(b)
          || this.inFlight(a) - this.inFlight(b))[0]
      case 'balanced':
        return [...candidates].sort((a, b) => {
          const utilizationA = this.inFlight(a) / this.concurrencyLimit(a, false)
          const utilizationB = this.inFlight(b) / this.concurrencyLimit(b, false)
          return utilizationA - utilizationB
            || quotaPressure(a) - quotaPressure(b)
            || a.priority - b.priority
            || a.id.localeCompare(b.id)
        })[0]
      case 'autobalanced':
        return this.pickAutoBalanced(candidates, stickyKey)
      case 'round-robin': {
        const ordered = aggregate ? orderedAggregateCandidates(pool, candidates) : candidates
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
  private pickSmoothWeighted(pool: Pool, candidates: Account[], configuredAccounts: Account[]): Account {
    const aggregate = isRelayAggregate(pool)
    const ordered = aggregate ? orderedAggregateCandidates(pool, candidates) : candidates
    const weighted = ordered.map((account) => ({
      account,
      weight: aggregate ? aggregateMemberWeight(pool, account.id) : effectiveWeight(account)
    }))
    const usable = weighted.some(({ weight }) => weight > 0)
      ? weighted
      : weighted.map(({ account }) => ({ account, weight: 1 }))
    const signature = smoothWeightedSignature(pool, configuredAccounts)
    let state = this.smoothWeighted.get(pool.id)
    if (!state || state.signature !== signature) {
      state = { signature, current: new Map() }
      this.smoothWeighted.set(pool.id, state)
    }

    const totalWeight = usable.reduce((sum, { weight }) => sum + weight, 0)
    let selected = usable[0]
    let selectedCurrent = Number.NEGATIVE_INFINITY
    for (const entry of usable) {
      const current = (state.current.get(entry.account.id) ?? 0) + entry.weight
      state.current.set(entry.account.id, current)
      // Keeping the first entry on ties makes the result deterministic. Relay
      // aggregates are already sorted by member order; standard pools retain
      // their existing account-array order.
      if (current > selectedCurrent) {
        selected = entry
        selectedCurrent = current
      }
    }
    state.current.set(selected.account.id, selectedCurrent - totalWeight)
    return selected.account
  }

  private inFlight(account: Account): number {
    return Math.max(0, account.inFlight) + (this.active.get(account.id) ?? 0)
  }

  private pickAutoBalanced(candidates: Account[], stickyKey?: string): Account {
    const unmeasured = candidates.filter((account) => !this.hasPerformanceSample(account.id))
    const measured = candidates.filter((account) => this.hasPerformanceSample(account.id))
    if (unmeasured.length > 0 && measured.length > 0 && this.random() < AUTO_BALANCED_EXPLORATION_RATE) {
      return unmeasured[Math.min(unmeasured.length - 1, Math.floor(this.random() * unmeasured.length))]
    }
    const prior = conservativePerformancePrior(measured.map((account) =>
      performanceCost(this.performance.get(account.id), this.now())))
    const scored = candidates.map((account) => ({
      account,
      cost: this.autoBalancedCost(account, prior, stickyKey)
    }))
    const minimumCost = Math.min(...scored.map(({ cost }) => cost))
    const best = scored.filter(({ cost }) => Math.abs(cost - minimumCost) < 0.001)
    if (best.length > 1) {
      return best[Math.min(best.length - 1, Math.floor(this.random() * best.length))].account
    }
    return best[0].account
  }

  private shouldEscapeSticky(selected: Account, candidates: Account[]): boolean {
    const selectedPerformance = this.performance.get(selected.id)
    if (
      !selectedPerformance?.firstTokenMs
      || selectedPerformance.sampleCount < STICKY_ESCAPE_MINIMUM_SAMPLES
      || this.now() - selectedPerformance.updatedAt >= PERFORMANCE_STALE_AFTER_MS
    ) return false
    const alternatives = candidates
      .filter((account) => account.id !== selected.id)
      .map((account) => ({ account, performance: this.performance.get(account.id) }))
      .filter((candidate): candidate is {
        account: Account
        performance: AccountPerformanceState & { firstTokenMs: number }
      } => Boolean(
        candidate.performance?.firstTokenMs
        && candidate.performance.sampleCount >= STICKY_ESCAPE_MINIMUM_SAMPLES
        && this.now() - candidate.performance.updatedAt < PERFORMANCE_STALE_AFTER_MS
      ))
      .sort((a, b) => a.performance.firstTokenMs - b.performance.firstTokenMs)
    const fastest = alternatives[0]
    if (!fastest) return false
    return selectedPerformance.firstTokenMs >= Math.max(
      fastest.performance.firstTokenMs + STICKY_ESCAPE_MINIMUM_DELTA_MS,
      fastest.performance.firstTokenMs * STICKY_ESCAPE_RATIO
    )
  }

  private shouldSpreadConcurrentSticky(
    stickyKey: string,
    selected: Account,
    candidates: Account[]
  ): boolean {
    const selectedSessionLoad = this.activeStickySessionCount(selected.id, stickyKey)
    if (selectedSessionLoad <= 0) return false
    const lowerLoadAlternatives = candidates.filter((account) =>
      account.id !== selected.id
      && this.activeStickySessionCount(account.id, stickyKey) < selectedSessionLoad
    )
    if (lowerLoadAlternatives.length === 0) return false
    const measured = candidates.filter((account) => this.hasPerformanceSample(account.id))
    const prior = conservativePerformancePrior(measured.map((account) =>
      performanceCost(this.performance.get(account.id), this.now())))
    const selectedCost = this.autoBalancedCost(selected, prior, stickyKey)
    return lowerLoadAlternatives.some((account) =>
      this.autoBalancedCost(account, prior, stickyKey) < selectedCost
    )
  }

  private autoBalancedCost(account: Account, unmeasuredPrior: number, stickyKey?: string): number {
    const utilization = this.inFlight(account) / this.concurrencyLimit(account, true)
    const performance = this.performance.get(account.id)
    const performanceEstimate = estimatedPerformanceCost(performance, unmeasuredPrior, this.now())
    return utilization * 1_000
      + this.activeStickySessionCount(account.id, stickyKey) * CONCURRENT_STICKY_SESSION_PENALTY
      + quotaPressure(account) * 200
      + performanceEstimate * 10
      + account.priority
  }

  private activeStickySessionCount(accountId: string, excludingStickyKey?: string): number {
    let count = 0
    for (const [stickyKey, accounts] of this.activeStickySessions) {
      if (stickyKey !== excludingStickyKey && (accounts.get(accountId) ?? 0) > 0) count += 1
    }
    return count
  }

  private acquireActiveStickySession(stickyKey: string, accountId: string): void {
    const accounts = this.activeStickySessions.get(stickyKey) ?? new Map<string, number>()
    accounts.set(accountId, (accounts.get(accountId) ?? 0) + 1)
    this.activeStickySessions.set(stickyKey, accounts)
  }

  private releaseActiveStickySession(stickyKey: string, accountId: string): void {
    const accounts = this.activeStickySessions.get(stickyKey)
    if (!accounts) return
    const remaining = Math.max(0, (accounts.get(accountId) ?? 0) - 1)
    if (remaining > 0) accounts.set(accountId, remaining)
    else accounts.delete(accountId)
    if (accounts.size === 0) this.activeStickySessions.delete(stickyKey)
  }

  private hasPerformanceSample(accountId: string): boolean {
    return (this.performance.get(accountId)?.sampleCount ?? 0) > 0
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
  const firstTokenSeconds = state.firstTokenMs === undefined ? 3 : state.firstTokenMs / 1000
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

function rawFirstBytePerformanceMs(log: RequestLog): number | undefined {
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
  return quotaWindows(account).some((window) =>
    window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

function quotaPressure(account: Account): number {
  const ratios = quotaWindows(account)
    .filter((window) => window?.limit !== undefined && window.limit > 0 && window.remaining !== undefined)
    .map((window) => Math.max(0, Math.min(1, 1 - window!.remaining! / window!.limit!)))
  return ratios.length ? Math.max(...ratios) : 0
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

function orderedAggregateCandidates(pool: Pool, candidates: Account[]): Account[] {
  const members = pool.members
  const memberPosition = new Map(members.map((member, index) => [member.accountId, index]))
  const memberOrder = new Map(members.map((member, index) => [
    member.accountId,
    finiteNumber(member.order, index)
  ]))
  return [...candidates].sort((a, b) =>
    (memberOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (memberOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || (memberPosition.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (memberPosition.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id)
  )
}

function aggregateMemberWeight(pool: Pool, accountId: string): number {
  const member = pool.members.find((candidate) => candidate.accountId === accountId)
  return positiveFiniteNumber(member?.weight, 1)
}

function smoothWeightedSignature(pool: Pool, configuredAccounts: readonly Account[]): string {
  if (isRelayAggregate(pool)) {
    return pool.members
      .filter((member) => member.enabled)
      .map((member, index) => [
        member.accountId,
        finiteNumber(member.order, index),
        positiveFiniteNumber(member.weight, 1)
      ].join(':'))
      .join('|')
  }
  return configuredAccounts
    .map((account) => `${account.id}:${effectiveWeight(account)}`)
    .join('|')
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
