import { describe, expect, it } from 'vitest'
import type { Account, Pool, RequestLog } from '../../src/shared/types'
import { ModelNotExposedError, NoEligibleAccountError, PoolScheduler } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    providerId: 'provider',
    name: id,
    credentialId: `credential-${id}`,
    maskedCredential: '***',
    status: 'active',
    priority: 0,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    modelPolicy: 'all',
    availableModels: [],
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  }
}

function pool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: 'pool',
    name: 'Pool',
    protocol: 'openai-chat',
    strategy: 'balanced',
    members: [],
    stickySessions: false,
    stickyTtlMinutes: 30,
    maxRetries: 1,
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  }
}

function requestLog(accountId: string, overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    id: `${accountId}-${overrides.timestamp ?? timestamp}`,
    accountId,
    timestamp,
    client: 'codex',
    protocol: 'openai-responses',
    providerName: 'OpenAI',
    accountName: accountId,
    model: 'model',
    status: 'success',
    latencyMs: 5_000,
    upstreamFirstByteMs: 1_000,
    firstTokenMs: 4_000,
    accountFirstTokenMs: 4_000,
    outputTokens: 200,
    ...overrides
  }
}

describe('PoolScheduler', () => {
  it('scores the best measured smart-balanced account at 100 relative to its peers', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const fast = account('fast')
    const slow = account('slow')
    const unmeasured = account('unmeasured')
    scheduler.recordPerformance(fast.id, { firstTokenMs: 500, outputTokens: 200, generationDurationMs: 2_000 })
    scheduler.recordPerformance(slow.id, { firstTokenMs: 2_500, outputTokens: 50, generationDurationMs: 4_000 })

    const fitness = scheduler.getFitness([fast, slow, unmeasured])

    expect(fitness.fast.score).toBe(100)
    expect(fitness.slow.score).toBeLessThan(100)
    expect(fitness.unmeasured).toMatchObject({ sampleCount: 0, stale: true })
    expect(fitness.unmeasured.score).toBeUndefined()
    expect(fitness.fast.firstTokenMs).toBe(500)
    expect(fitness.fast.outputTokensPerSecond).toBe(100)
  })

  it('acquires one concurrency slot and releases it exactly once', () => {
    const scheduler = new PoolScheduler()
    const onlyAccount = account('a')
    const scheduled = scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' })

    expect(scheduler.getInFlight(onlyAccount)).toBe(1)
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' }))
      .toThrow(NoEligibleAccountError)

    scheduled.release()
    scheduled.release()
    expect(scheduler.getInFlight(onlyAccount)).toBe(0)
    expect(scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' }).account.id).toBe('a')
  })

  it('skips accounts in cooldown and restores them after expiry', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const first = account('a', { priority: 1 })
    const second = account('b', { priority: 10 })
    const priorityPool = pool({ strategy: 'priority' })

    scheduler.setCooldown('a', now + 1_000)
    const duringCooldown = scheduler.selectAndAcquire({ pool: priorityPool, accounts: [first, second], model: 'model' })
    expect(duringCooldown.account.id).toBe('b')
    duringCooldown.release()

    now += 1_001
    const afterCooldown = scheduler.selectAndAcquire({ pool: priorityPool, accounts: [first, second], model: 'model' })
    expect(afterCooldown.account.id).toBe('a')
  })

  it('treats a smaller priority number as higher priority', () => {
    const scheduler = new PoolScheduler()
    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'priority' }),
      accounts: [account('later', { priority: 20 }), account('earlier', { priority: 1 })],
      model: 'model'
    })

    expect(selected.account.id).toBe('earlier')
  })

  it('keeps balanced scheduling independent from runtime speed samples', () => {
    const scheduler = new PoolScheduler()
    const slow = account('a-slow', { maxConcurrency: 4 })
    const fast = account('z-fast', { maxConcurrency: 4 })
    scheduler.recordPerformance(slow.id, {
      firstTokenMs: 4_000,
      outputTokens: 40,
      generationDurationMs: 4_000
    })
    scheduler.recordPerformance(fast.id, {
      firstTokenMs: 1_000,
      outputTokens: 160,
      generationDurationMs: 4_000
    })

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'balanced' }),
      accounts: [slow, fast],
      model: 'model'
    })

    expect(selected.account.id).toBe(slow.id)
  })

  it('uses EWMA first-token and output speed for equally loaded autobalanced accounts', () => {
    const scheduler = new PoolScheduler()
    const slow = account('a-slow', { maxConcurrency: 4 })
    const fast = account('z-fast', { maxConcurrency: 4 })
    for (let index = 0; index < 4; index += 1) {
      scheduler.recordPerformance(slow.id, {
        firstTokenMs: 4_000,
        outputTokens: 40,
        generationDurationMs: 4_000
      })
      scheduler.recordPerformance(fast.id, {
        firstTokenMs: 1_000,
        outputTokens: 160,
        generationDurationMs: 4_000
      })
    }

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [slow, fast],
      model: 'model'
    })

    expect(selected.account.id).toBe(fast.id)
  })

  it('uses a conservative prior for unmeasured autobalanced accounts by default', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const measured = account('measured', { maxConcurrency: 4 })
    const unmeasured = account('unmeasured', { maxConcurrency: 4 })
    scheduler.recordPerformance(measured.id, {
      firstTokenMs: 800,
      outputTokens: 200,
      generationDurationMs: 4_000
    })

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [measured, unmeasured],
      model: 'model'
    })

    expect(selected.account.id).toBe(measured.id)
  })

  it('hydrates autobalanced performance from persisted raw first-byte timing', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const rawFastVisibleSlow = account('raw-fast', { maxConcurrency: 4 })
    const rawSlowVisibleFast = account('raw-slow', { maxConcurrency: 4 })
    scheduler.hydratePerformance([
      ...Array.from({ length: 4 }, (_, index) => requestLog(rawFastVisibleSlow.id, {
        id: `raw-fast-${index}`,
        timestamp: timestamp - 4_000 + index,
        upstreamFirstByteMs: 800,
        firstTokenMs: 4_500,
        accountFirstTokenMs: 4_500
      })),
      ...Array.from({ length: 4 }, (_, index) => requestLog(rawSlowVisibleFast.id, {
        id: `raw-slow-${index}`,
        timestamp: timestamp - 4_000 + index,
        upstreamFirstByteMs: 2_500,
        firstTokenMs: 900,
        accountFirstTokenMs: 900
      }))
    ])

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [rawSlowVisibleFast, rawFastVisibleSlow],
      model: 'model'
    })

    expect(selected.account.id).toBe(rawFastVisibleSlow.id)
  })

  it('deducts failed-attempt time when hydrating the winning account performance', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const fastAfterFailover = account('fast-after-failover', { maxConcurrency: 4 })
    const genuinelySlower = account('genuinely-slower', { maxConcurrency: 4 })
    scheduler.hydratePerformance([
      ...Array.from({ length: 4 }, (_, index) => requestLog(fastAfterFailover.id, {
        id: `failover-winner-${index}`,
        timestamp: timestamp - 4_000 + index,
        latencyMs: 10_000,
        upstreamFirstByteMs: 6_100,
        firstTokenMs: 6_500,
        accountFirstTokenMs: 1_500
      })),
      ...Array.from({ length: 4 }, (_, index) => requestLog(genuinelySlower.id, {
        id: `slower-${index}`,
        timestamp: timestamp - 4_000 + index,
        latencyMs: 10_000,
        upstreamFirstByteMs: 2_000,
        firstTokenMs: 2_400,
        accountFirstTokenMs: 2_400
      }))
    ])

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [genuinelySlower, fastAfterFailover],
      model: 'model'
    })

    expect(selected.account.id).toBe(fastAfterFailover.id)
  })

  it('ignores stale persisted performance during autobalanced hydration', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.99)
    const first = account('a')
    const second = account('z')
    scheduler.hydratePerformance([
      requestLog(first.id, { timestamp: timestamp - 31 * 60_000, upstreamFirstByteMs: 100 })
    ])

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [first, second], model: 'model'
    })

    expect(selected.account.id).toBe(second.id)
  })

  it('randomizes equal-cost autobalanced cold starts instead of sorting by account id', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.99)
    const alphabeticallyFirst = account('a')
    const alphabeticallyLast = account('z')

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [alphabeticallyFirst, alphabeticallyLast],
      model: 'model'
    })

    expect(selected.account.id).toBe(alphabeticallyLast.id)
  })

  it('randomizes equal-cost measured autobalanced accounts instead of sorting by account id', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.99)
    const alphabeticallyFirst = account('a')
    const alphabeticallyLast = account('z')
    for (const candidate of [alphabeticallyFirst, alphabeticallyLast]) {
      scheduler.recordPerformance(candidate.id, {
        firstTokenMs: 1_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
    }

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [alphabeticallyFirst, alphabeticallyLast],
      model: 'model'
    })

    expect(selected.account.id).toBe(alphabeticallyLast.id)
  })

  it('reserves a small exploration budget for unmeasured autobalanced accounts', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.01)
    const measured = account('measured', { maxConcurrency: 4 })
    const unmeasured = account('unmeasured', { maxConcurrency: 4 })
    scheduler.recordPerformance(measured.id, {
      firstTokenMs: 800,
      outputTokens: 200,
      generationDurationMs: 4_000
    })

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [measured, unmeasured],
      model: 'model'
    })

    expect(selected.account.id).toBe(unmeasured.id)
  })

  it('penalizes recently failing autobalanced accounts and decays that penalty', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now, () => 0)
    const recovered = account('a-recovered', { maxConcurrency: 4 })
    const stable = account('z-stable', { maxConcurrency: 4 })
    for (const candidate of [recovered, stable]) {
      scheduler.recordPerformance(candidate.id, {
        firstTokenMs: 1_000,
        outputTokens: 100,
        generationDurationMs: 4_000
      })
    }
    scheduler.recordFailure(recovered.id, { baseDelayMs: 1_000, maxDelayMs: 1_000 })
    now += 1_001

    const immediately = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [recovered, stable], model: 'model'
    })
    expect(immediately.account.id).toBe(stable.id)
    immediately.release()

    now += 2 * 60 * 60_000
    const afterDecay = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [recovered, stable], model: 'model'
    })
    expect(afterDecay.account.id).toBe(recovered.id)
  })

  it('uses AIMD-style adaptive concurrency after a failure and gradual recovery', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now, () => 0.5)
    const selectedAccount = account('adaptive', { maxConcurrency: 4 })
    scheduler.recordFailure(selectedAccount.id, {
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
      maxConcurrency: selectedAccount.maxConcurrency
    })
    now += 1_001

    const first = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })).toThrow(NoEligibleAccountError)
    first.release()
    scheduler.recordSuccess(selectedAccount.id)

    const balancedSelections = Array.from({ length: 4 }, () => scheduler.selectAndAcquire({
      pool: pool({ strategy: 'balanced' }), accounts: [selectedAccount], model: 'model'
    }))
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ strategy: 'balanced' }), accounts: [selectedAccount], model: 'model'
    })).toThrow(NoEligibleAccountError)
    for (const selection of balancedSelections) selection.release()

    const reducedFirst = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    const reducedSecond = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })).toThrow(NoEligibleAccountError)
    reducedFirst.release()
    reducedSecond.release()

    for (let index = 0; index < 8; index += 1) {
      scheduler.recordPerformance(selectedAccount.id, {
        firstTokenMs: 1_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
    }
    const recoveredFirst = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    const recoveredSecond = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    const recoveredThird = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }), accounts: [selectedAccount], model: 'model'
    })).toThrow(NoEligibleAccountError)
    recoveredFirst.release()
    recoveredSecond.release()
    recoveredThird.release()
  })

  it('keeps a sticky session on its assigned eligible account', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const accounts = [account('a'), account('b')]
    const stickyPool = pool({ strategy: 'round-robin', stickySessions: true })

    const first = scheduler.selectAndAcquire({ pool: stickyPool, accounts, model: 'model', sessionId: 'session' })
    expect(first.account.id).toBe('a')
    first.release()

    const second = scheduler.selectAndAcquire({ pool: stickyPool, accounts, model: 'model', sessionId: 'session' })
    expect(second.account.id).toBe('a')
  })

  it('escapes an obviously slow sticky assignment only for autobalanced pools', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const slow = account('a-slow', { maxConcurrency: 4 })
    const fast = account('z-fast', { maxConcurrency: 4 })
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true })

    const initial = scheduler.selectAndAcquire({
      pool: stickyPool, accounts: [slow, fast], model: 'model', sessionId: 'session'
    })
    expect(initial.account.id).toBe(slow.id)
    initial.release()
    for (let index = 0; index < 3; index += 1) {
      scheduler.recordPerformance(slow.id, { firstTokenMs: 4_000, outputTokens: 100, generationDurationMs: 2_000 })
      scheduler.recordPerformance(fast.id, { firstTokenMs: 1_000, outputTokens: 100, generationDurationMs: 2_000 })
    }

    const escaped = scheduler.selectAndAcquire({
      pool: stickyPool, accounts: [slow, fast], model: 'model', sessionId: 'session'
    })
    expect(escaped.account.id).toBe(fast.id)
  })

  it('does not immediately reselect the account that triggered sticky escape', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const slowFirstByte = account('slow-first-byte', { maxConcurrency: 4 })
    const fastFirstByte = account('fast-first-byte', { maxConcurrency: 4 })
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true })

    const initial = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [slowFirstByte, fastFirstByte],
      model: 'model',
      sessionId: 'session'
    })
    expect(initial.account.id).toBe(slowFirstByte.id)
    initial.release()

    for (let index = 0; index < 3; index += 1) {
      // The slow-TTFT account has enough throughput to win the ordinary
      // aggregate score. Sticky escape must still move this turn away from it.
      scheduler.recordPerformance(slowFirstByte.id, {
        firstTokenMs: 4_000,
        outputTokens: 2_000,
        generationDurationMs: 2_000
      })
      scheduler.recordPerformance(fastFirstByte.id, {
        firstTokenMs: 1_000,
        outputTokens: 2,
        generationDurationMs: 2_000
      })
    }

    const escaped = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [slowFirstByte, fastFirstByte],
      model: 'model',
      sessionId: 'session'
    })

    expect(escaped.account.id).toBe(fastFirstByte.id)
  })

  it('does not escape a sticky assignment using stale performance samples', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now, () => 0)
    const previouslySlow = account('previously-slow', { maxConcurrency: 4 })
    const previouslyFast = account('previously-fast', { maxConcurrency: 4 })
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true, stickyTtlMinutes: 60 })

    const initial = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [previouslySlow, previouslyFast],
      model: 'model',
      sessionId: 'session'
    })
    expect(initial.account.id).toBe(previouslySlow.id)
    initial.release()
    for (let index = 0; index < 3; index += 1) {
      scheduler.recordPerformance(previouslySlow.id, {
        firstTokenMs: 4_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
      scheduler.recordPerformance(previouslyFast.id, {
        firstTokenMs: 1_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
    }
    now += 31 * 60_000

    const stillSticky = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [previouslySlow, previouslyFast],
      model: 'model',
      sessionId: 'session'
    })

    expect(stillSticky.account.id).toBe(previouslySlow.id)
  })

  it('does not apply slow-account sticky escape to balanced pools', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const slow = account('a-slow', { maxConcurrency: 4 })
    const fast = account('z-fast', { maxConcurrency: 4 })
    const stickyPool = pool({ strategy: 'balanced', stickySessions: true })

    const initial = scheduler.selectAndAcquire({
      pool: stickyPool, accounts: [slow, fast], model: 'model', sessionId: 'session'
    })
    initial.release()
    for (let index = 0; index < 3; index += 1) {
      scheduler.recordPerformance(slow.id, { firstTokenMs: 4_000, outputTokens: 100, generationDurationMs: 2_000 })
      scheduler.recordPerformance(fast.id, { firstTokenMs: 1_000, outputTokens: 100, generationDurationMs: 2_000 })
    }

    const stillSticky = scheduler.selectAndAcquire({
      pool: stickyPool, accounts: [slow, fast], model: 'model', sessionId: 'session'
    })
    expect(stillSticky.account.id).toBe(slow.id)
  })

  it('routes each model only to accounts that expose it', () => {
    const scheduler = new PoolScheduler()
    const base = account('base', {
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5']
    })
    const extended = account('extended', {
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini']
    })

    const scheduled = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'priority' }),
      accounts: [base, extended],
      model: 'gpt-5.5-mini'
    })

    expect(scheduled.account.id).toBe('extended')
  })

  it('uses a refreshed all-account catalog and preserves wildcard behavior before refresh', () => {
    const scheduler = new PoolScheduler()
    const refreshed = account('refreshed', {
      modelPolicy: 'all',
      availableModels: ['gpt-5.5'],
      modelsRefreshedAt: timestamp
    })
    const legacy = account('legacy', { modelPolicy: 'all', availableModels: [] })

    expect(() => scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [refreshed],
      model: 'gpt-5.5-mini'
    })).toThrow(ModelNotExposedError)
    expect(scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [legacy],
      model: 'gpt-5.5-mini'
    }).account.id).toBe('legacy')
  })

  it('enforces the pool selection in addition to account policies', () => {
    const scheduler = new PoolScheduler()
    const models = account('models', {
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5', 'gpt-5.5-mini']
    })

    expect(scheduler.selectAndAcquire({
      pool: pool({ modelPolicy: 'selected', modelAllowlist: ['gpt-5.5'] }),
      accounts: [models],
      model: 'gpt-5.5'
    }).account.id).toBe('models')
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ modelPolicy: 'selected', modelAllowlist: ['gpt-5.5'] }),
      accounts: [models],
      model: 'gpt-5.5-mini'
    })).toThrow(ModelNotExposedError)
    expect(() => scheduler.selectAndAcquire({
      pool: pool({ modelPolicy: 'selected', modelAllowlist: [] }),
      accounts: [models],
      model: 'gpt-5.5'
    })).toThrow(ModelNotExposedError)
  })

  it('distinguishes an exposed model with no healthy account from a closed model', () => {
    const scheduler = new PoolScheduler()
    const disabled = account('disabled', {
      status: 'disabled',
      modelPolicy: 'selected',
      modelAllowlist: ['gpt-5.5']
    })

    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [disabled], model: 'gpt-5.5' }))
      .toThrow(NoEligibleAccountError)
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [disabled], model: 'other' }))
      .toThrow(ModelNotExposedError)
  })

  it('uses exponential backoff and honors a longer Retry-After delay', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)

    const firstFailure = scheduler.recordFailure('a', { baseDelayMs: 1_000, maxDelayMs: 60_000 })
    expect(firstFailure).toMatchObject({
      circuitState: 'open',
      consecutiveFailures: 1,
      cooldownUntil: now + 1_000
    })

    now += 1_001
    const secondFailure = scheduler.recordFailure('a', {
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      retryAfterMs: 10_000
    })
    expect(secondFailure).toMatchObject({
      consecutiveFailures: 2,
      cooldownUntil: now + 10_000
    })
  })

  it('allows one half-open probe and closes the circuit after success', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const onlyAccount = account('a', { maxConcurrency: 4 })

    scheduler.recordFailure('a', { baseDelayMs: 1_000 })
    now += 1_001
    expect(scheduler.getHealth('a').circuitState).toBe('half-open')

    const probe = scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' })
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' }))
      .toThrow(NoEligibleAccountError)
    probe.release()

    expect(scheduler.recordSuccess('a')).toMatchObject({ circuitState: 'closed', consecutiveFailures: 0 })
    const normal = scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' })
    expect(normal.account.id).toBe('a')
  })

  it('hydrates persisted failures and allows only one half-open probe after restart', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const cooling = account('a', {
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 2,
      cooldownUntil: now + 1_000,
      maxConcurrency: 4
    })
    scheduler.hydrate([cooling])

    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [cooling], model: 'model' }))
      .toThrow(NoEligibleAccountError)
    now += 1_001
    const probe = scheduler.selectAndAcquire({ pool: pool(), accounts: [cooling], model: 'model' })
    expect(probe.account.id).toBe('a')
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [cooling], model: 'model' }))
      .toThrow(NoEligibleAccountError)
    probe.release()
    expect(scheduler.recordFailure('a', { baseDelayMs: 1_000 })).toMatchObject({
      consecutiveFailures: 3,
      cooldownUntil: now + 4_000
    })
  })

  it('skips exhausted quota and lowers the priority of a nearly depleted account', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const exhausted = account('exhausted', {
      priority: 1,
      quota: { requests: { limit: 100, remaining: 0, resetAt: timestamp + 60_000 }, observedAt: timestamp }
    })
    const pressured = account('pressured', {
      priority: 1,
      quota: { requests: { limit: 100, remaining: 1, resetAt: timestamp + 60_000 }, observedAt: timestamp }
    })
    const healthy = account('healthy', {
      priority: 2,
      quota: { requests: { limit: 100, remaining: 90, resetAt: timestamp + 60_000 }, observedAt: timestamp }
    })

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'priority' }),
      accounts: [exhausted, pressured, healthy],
      model: 'model'
    })
    expect(selected.account.id).toBe('healthy')
  })

  it('returns an exhausted account after its quota window resets', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const exhausted = account('a', {
      quota: { requests: { limit: 10, remaining: 0, resetAt: timestamp + 1_000 }, observedAt: timestamp }
    })

    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [exhausted], model: 'model' }))
      .toThrow(NoEligibleAccountError)
    now += 1_001
    expect(scheduler.selectAndAcquire({ pool: pool(), accounts: [exhausted], model: 'model' }).account.id).toBe('a')
  })
})
