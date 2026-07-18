import type { Account, AccountCircuitState, Pool } from '../../shared/types'
import type { ScheduledAccount, SchedulerSelectionInput } from './types'

interface StickyAssignment {
  accountId: string
  expiresAt: number
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
}

export interface AccountPerformanceSample {
  firstTokenMs?: number
  outputTokens?: number
  generationDurationMs?: number
}

interface AccountPerformanceState {
  sampleCount: number
  firstTokenMs?: number
  outputTokensPerSecond?: number
}

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
  private readonly sticky = new Map<string, StickyAssignment>()
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
        consecutiveFailures: Math.max(1, account.consecutiveFailures ?? 0),
        cooldownUntil: account.cooldownUntil,
        lastFailureAt: account.updatedAt
      })
    }
  }

  selectAndAcquire(input: SchedulerSelectionInput): ScheduledAccount {
    const { pool, accounts, model, sessionId } = input
    if (!poolAllowsModel(pool, accounts, model)) throw new ModelNotExposedError()

    const candidates = accounts
      .filter((account) => accountAllowsModel(account, model))
      .filter((account) => this.isEligible(account))
    if (candidates.length === 0) {
      throw new NoEligibleAccountError()
    }

    const stickyKey = sessionId ? `${pool.id}:${sessionId}` : undefined
    let selected: Account | undefined
    if (pool.stickySessions && stickyKey) {
      const assignment = this.sticky.get(stickyKey)
      if (assignment && assignment.expiresAt > this.now()) {
        selected = candidates.find((account) => account.id === assignment.accountId)
      } else if (assignment) {
        this.sticky.delete(stickyKey)
      }
    }

    selected ??= this.pick(pool, candidates)
    this.active.set(selected.id, (this.active.get(selected.id) ?? 0) + 1)

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
      }
    }
  }

  setCooldown(accountId: string, until: number): void {
    const existing = this.health.get(accountId)
    this.health.set(accountId, {
      accountId,
      circuitState: 'open',
      consecutiveFailures: Math.max(1, existing?.consecutiveFailures ?? 0),
      cooldownUntil: Math.max(until, existing?.cooldownUntil ?? 0),
      lastFailureAt: existing?.lastFailureAt ?? this.now()
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
    const firstTokenMs = positiveMetric(sample.firstTokenMs)
    const outputTokens = positiveMetric(sample.outputTokens)
    const generationDurationMs = positiveMetric(sample.generationDurationMs)
    const outputTokensPerSecond = outputTokens !== undefined && generationDurationMs !== undefined
      ? outputTokens * 1000 / generationDurationMs
      : undefined
    if (firstTokenMs === undefined && outputTokensPerSecond === undefined) return
    const existing = this.performance.get(accountId)
    const alpha = (existing?.sampleCount ?? 0) < 4 ? 0.5 : 0.25
    this.performance.set(accountId, {
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      firstTokenMs: updateEwma(existing?.firstTokenMs, firstTokenMs, alpha),
      outputTokensPerSecond: updateEwma(
        existing?.outputTokensPerSecond,
        outputTokensPerSecond,
        alpha
      )
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

  clear(): void {
    this.active.clear()
    this.roundRobinOffsets.clear()
    this.sticky.clear()
    this.health.clear()
    this.performance.clear()
  }

  private isEligible(account: Account): boolean {
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
    return this.inFlight(account) < Math.max(1, account.maxConcurrency)
  }

  private pick(pool: Pool, candidates: Account[]): Account {
    switch (pool.strategy) {
      case 'priority':
        return [...candidates].sort((a, b) =>
          effectivePriority(a) - effectivePriority(b)
          || this.inFlight(a) - this.inFlight(b))[0]
      case 'balanced':
        return [...candidates].sort((a, b) => {
          const utilizationA = this.inFlight(a) / Math.max(1, a.maxConcurrency)
          const utilizationB = this.inFlight(b) / Math.max(1, b.maxConcurrency)
          return utilizationA - utilizationB
            || quotaPressure(a) - quotaPressure(b)
            || a.priority - b.priority
            || a.id.localeCompare(b.id)
        })[0]
      case 'autobalanced':
        return [...candidates].sort((a, b) => {
          return this.autoBalancedCost(a) - this.autoBalancedCost(b)
            || a.id.localeCompare(b.id)
        })[0]
      case 'round-robin': {
        const ordered = candidates
        const offset = this.roundRobinOffsets.get(pool.id) ?? 0
        const selected = ordered[offset % ordered.length]
        this.roundRobinOffsets.set(pool.id, (offset + 1) % ordered.length)
        return selected
      }
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

  private inFlight(account: Account): number {
    return Math.max(0, account.inFlight) + (this.active.get(account.id) ?? 0)
  }

  private autoBalancedCost(account: Account): number {
    const utilization = this.inFlight(account) / Math.max(1, account.maxConcurrency)
    return utilization * 1_000
      + quotaPressure(account) * 200
      + performanceCost(this.performance.get(account.id)) * 10
      + account.priority
  }
}

function performanceCost(state: AccountPerformanceState | undefined): number {
  if (!state) return -2
  const firstTokenSeconds = state.firstTokenMs === undefined ? 3 : state.firstTokenMs / 1000
  const outputPenalty = state.outputTokensPerSecond === undefined
    ? 1.5
    : 50 / Math.max(1, state.outputTokensPerSecond)
  return Math.min(20, firstTokenSeconds) * 0.6 + Math.min(20, outputPenalty) * 1.4
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

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
