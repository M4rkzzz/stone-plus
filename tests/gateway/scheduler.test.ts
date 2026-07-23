import { describe, expect, it } from 'vitest'
import type { Account, Pool, ProviderDefinition, RequestLog } from '../../src/shared/types'
import { ModelNotExposedError, NoEligibleAccountError, PoolScheduler, quotaProtectionBlocks } from '../../src/main/gateway/scheduler'

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
    kind: 'standard',
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

function provider(id: string, webSearch?: boolean): ProviderDefinition {
  return {
    id,
    name: id,
    sourceType: 'relay',
    kind: 'openai-compatible',
    baseUrl: `https://${id}.example/v1`,
    protocol: 'openai-responses',
    models: ['model'],
    capabilityProfile: {
      version: 1,
      origin: 'declared',
      streaming: true,
      ...(webSearch === undefined ? {} : { webSearch }),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
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

function countByValue(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

describe('PoolScheduler', () => {
  it('never schedules a member that explicitly lacks a required capability', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const unsupported = account('unsupported', { providerId: 'unsupported-provider' })
    const supported = account('supported', { providerId: 'supported-provider' })
    const selected = scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [unsupported, supported],
      providers: [provider('unsupported-provider', false), provider('supported-provider', true)],
      requiredCapabilities: ['webSearch'],
      model: 'model',
    })
    expect(selected.account.id).toBe('supported')
  })
  it('falls back to an unknown-capability member when every verified member is runtime-unavailable', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const coolingVerified = account('verified', {
      providerId: 'verified-provider',
      status: 'cooldown',
      cooldownUntil: timestamp + 60_000,
    })
    const availableUnknown = account('unknown', { providerId: 'unknown-provider' })

    const selected = scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [coolingVerified, availableUnknown],
      providers: [provider('verified-provider', true), provider('unknown-provider')],
      requiredCapabilities: ['webSearch'],
      model: 'model',
    })

    expect(selected.account.id).toBe('unknown')
  })
  it('does not treat an explicitly incompatible member as a usable failover peer', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const selected = account('selected', { providerId: 'supported-provider' })
    const incompatible = account('incompatible', { providerId: 'unsupported-provider' })

    expect(scheduler.hasUsableAlternative(
      [selected, incompatible],
      'model',
      selected.id,
      pool(),
      [provider('supported-provider', true), provider('unsupported-provider', false)],
      ['webSearch'],
    )).toBe(false)
  })
  it('keeps quota reserves without changing legacy or unknown-quota behaviour by default', () => {
    expect(quotaProtectionBlocks(undefined, undefined, timestamp)).toBe(false)
    expect(quotaProtectionBlocks(undefined, {
      fiveHourRemainingPercent: 10,
      unavailableBehavior: 'allow'
    }, timestamp)).toBe(false)
    expect(quotaProtectionBlocks(undefined, {
      fiveHourRemainingPercent: 10,
      unavailableBehavior: 'block'
    }, timestamp)).toBe(true)
    expect(quotaProtectionBlocks({
      observedAt: timestamp,
      source: 'usage-endpoint',
      fiveHour: { usedPercent: 91 },
      sevenDay: { usedPercent: 70 }
    }, { fiveHourRemainingPercent: 10 }, timestamp)).toBe(true)
  })

  it('combines account and pool quota protection and rejects stale snapshots conservatively', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const guardedPool = pool({
      quotaProtection: { sevenDayRemainingPercent: 20, unavailableBehavior: 'block', staleAfterMinutes: 5 }
    })
    const stale = account('stale', {
      codexQuota: {
        observedAt: timestamp - 6 * 60_000,
        source: 'usage-endpoint',
        fiveHour: { usedPercent: 5 },
        sevenDay: { usedPercent: 5 }
      }
    })
    expect(() => scheduler.selectAndAcquire({ pool: guardedPool, accounts: [stale], model: 'model' }))
      .toThrow(NoEligibleAccountError)

    const accountGuarded = account('account-guarded', {
      quotaProtection: { fiveHourRemainingPercent: 25 },
      codexQuota: {
        observedAt: timestamp,
        source: 'usage-endpoint',
        fiveHour: { usedPercent: 80 },
        sevenDay: { usedPercent: 1 }
      }
    })
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [accountGuarded], model: 'model' }))
      .toThrow(NoEligibleAccountError)
  })
  it('globally reclaims expired sticky assignments and failure avoidances', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now, () => 0)
    const stickyPool = pool({ stickySessions: true, stickyTtlMinutes: 1 })
    const first = account('first')
    const second = account('second')

    const one = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [first, second],
      model: 'model',
      sessionId: 'one'
    })
    one.release()
    const two = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [first, second],
      model: 'model',
      sessionId: 'two'
    })
    two.release()
    scheduler.recordStickyFailure(stickyPool.id, 'one', one.account.id)

    const state = scheduler as unknown as {
      sticky: Map<string, unknown>
      stickyFailureAvoidance: Map<string, unknown>
      stickyKeysByAccount: Map<string, Set<string>>
    }
    expect(state.sticky.size).toBe(1)
    expect(state.stickyFailureAvoidance.size).toBe(1)

    now += 60_001
    const trigger = scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [first],
      model: 'model'
    })
    trigger.release()

    expect(state.sticky.size).toBe(0)
    expect(state.stickyFailureAvoidance.size).toBe(0)
    expect(state.stickyKeysByAccount.size).toBe(0)
  })

  it('counts a concurrent sticky session once regardless of its request count', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const stickyPool = pool({ stickySessions: true })
    const selectedAccount = account('selected', { maxConcurrency: 4 })
    const first = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [selectedAccount],
      model: 'model',
      sessionId: 'same-session'
    })
    const second = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [selectedAccount],
      model: 'model',
      sessionId: 'same-session'
    })
    const state = scheduler as unknown as { activeStickySessionCounts: Map<string, number> }
    expect(state.activeStickySessionCounts.get(selectedAccount.id)).toBe(1)
    first.release()
    expect(state.activeStickySessionCounts.get(selectedAccount.id)).toBe(1)
    second.release()
    expect(state.activeStickySessionCounts.has(selectedAccount.id)).toBe(false)
  })

  it('uses an absolute confidence-weighted rating instead of forcing the current best account to 100', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const fast = account('fast')
    const slow = account('slow')
    const unmeasured = account('unmeasured')
    scheduler.recordPerformance(fast.id, { firstTokenMs: 500, outputTokens: 200, generationDurationMs: 2_000 })
    scheduler.recordPerformance(slow.id, { firstTokenMs: 2_500, outputTokens: 50, generationDurationMs: 4_000 })

    const fitness = scheduler.getFitness([fast, slow, unmeasured])

    expect(fitness.fast.score).toBeGreaterThan(fitness.slow.score!)
    expect(fitness.fast.score).toBeLessThan(100)
    expect(fitness.fast).toMatchObject({
      successCount: 1,
      failureCount: 0,
      successRate: expect.any(Number),
      recentSuccessRate: 100,
      confidence: expect.any(Number),
      components: {
        reliability: expect.any(Number),
        responsiveness: expect.any(Number),
        throughput: expect.any(Number),
        stability: 100
      }
    })
    expect(fitness.unmeasured).toMatchObject({ sampleCount: 0, stale: true })
    expect(fitness.unmeasured.score).toBeUndefined()
    expect(fitness.fast.firstTokenMs).toBe(500)
    expect(fitness.fast.semanticFirstTokenMs).toBe(500)
    expect(fitness.fast.transportFirstBodyMs).toBeUndefined()
    expect(fitness.fast.outputTokensPerSecond).toBe(100)
  })

  it('combines persisted successes and failures with a failure-sensitive moving evaluation', () => {
    const now = timestamp + 10 * 24 * 60 * 60_000
    const reliable = account('reliable')
    const unstable = account('unstable')
    const logs: RequestLog[] = []
    for (let index = 0; index < 30; index += 1) {
      const observedAt = now - (30 - index) * 6 * 60 * 60_000
      logs.push(requestLog(reliable.id, { timestamp: observedAt, upstreamFirstByteMs: 700, latencyMs: 3_000 }))
      logs.push(requestLog(unstable.id, {
        timestamp: observedAt,
        upstreamFirstByteMs: 700,
        latencyMs: 3_000,
        ...(index >= 20 && index % 2 === 0
          ? { status: 'error', statusCode: 429, error: 'rate limited', upstreamFirstByteMs: undefined }
          : {})
      }))
    }
    const scheduler = new PoolScheduler(() => now)
    scheduler.hydratePerformance(logs)

    const fitness = scheduler.getFitness([reliable, unstable])

    expect(fitness.reliable.score).toBeLessThan(100)
    expect(fitness.reliable.score).toBeGreaterThan(fitness.unstable.score!)
    expect(fitness.unstable.failureCount).toBe(5)
    expect(fitness.unstable.recentSuccessRate).toBeLessThan(fitness.unstable.successRate!)
    expect(fitness.unstable.components!.reliability).toBeLessThan(fitness.reliable.components!.reliability)
  })

  it('keeps historical evidence while recent successes gradually recover a failed account', () => {
    let now = timestamp
    const target = account('target')
    const scheduler = new PoolScheduler(() => now)
    for (let index = 0; index < 20; index += 1) {
      scheduler.recordPerformance(target.id, { firstTokenMs: 800, outputTokens: 100, generationDurationMs: 2_000 })
      now += 1_000
    }
    const beforeFailure = scheduler.getFitness([target]).target
    scheduler.recordFailure(target.id)
    const afterFailure = scheduler.getFitness([target]).target
    for (let index = 0; index < 4; index += 1) {
      now += 1_000
      scheduler.recordPerformance(target.id, { firstTokenMs: 800, outputTokens: 100, generationDurationMs: 2_000 })
    }
    const recovered = scheduler.getFitness([target]).target

    expect(afterFailure.score).toBeLessThan(beforeFailure.score!)
    expect(recovered.score).toBeGreaterThan(afterFailure.score!)
    expect(recovered.failureCount).toBe(1)
    expect(recovered.successCount).toBe(24)
    expect(recovered.score).toBeLessThanOrEqual(beforeFailure.score!)
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

  it('admits 200 synchronous autobalanced selections across available account capacity without oversubscription', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const accounts = Array.from({ length: 50 }, (_, index) => account(`account-${index}`, {
      maxConcurrency: 4
    }))
    const highConcurrencyPool = pool({
      strategy: 'autobalanced',
      stickySessions: true
    })
    const selections = Array.from({ length: 200 }, (_, index) => scheduler.selectAndAcquire({
      pool: highConcurrencyPool,
      accounts,
      model: 'model',
      sessionId: `session-${index}`
    }))

    // Admission is deliberately synchronous: the scheduler must not hide a
    // local wait queue in front of the upstream transport.
    expect(selections.every((selection) => typeof (selection as { then?: unknown }).then === 'undefined')).toBe(true)
    const selectedCounts = countByValue(selections.map(({ account: selected }) => selected.id))
    expect(Object.keys(selectedCounts)).toHaveLength(accounts.length)
    for (const candidate of accounts) {
      expect(selectedCounts[candidate.id]).toBe(candidate.maxConcurrency)
      expect(scheduler.getInFlight(candidate)).toBe(candidate.maxConcurrency)
    }
    expect(() => scheduler.selectAndAcquire({
      pool: highConcurrencyPool,
      accounts,
      model: 'model',
      sessionId: 'over-capacity'
    })).toThrow(NoEligibleAccountError)

    for (const selection of selections) selection.release()
    for (const candidate of accounts) expect(scheduler.getInFlight(candidate)).toBe(0)
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

  it('uses aggregate member order as deterministic failover priority', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const aggregate = pool({
      kind: 'relay-aggregate',
      strategy: 'priority',
      members: [
        { accountId: 'preferred', enabled: true, order: 0 },
        { accountId: 'fallback', enabled: true, order: 1 }
      ]
    })
    const preferred = account('preferred', { priority: 100 })
    const fallback = account('fallback', { priority: 0 })

    const first = scheduler.selectAndAcquire({
      pool: aggregate,
      // Deliberately reverse input order: aggregate order is authoritative.
      accounts: [fallback, preferred],
      model: 'model'
    })
    expect(first.account.id).toBe('preferred')
    first.release()

    scheduler.setCooldown(preferred.id, timestamp + 60_000)
    const failedOver = scheduler.selectAndAcquire({
      pool: aggregate,
      accounts: [fallback, preferred],
      model: 'model'
    })
    expect(failedOver.account.id).toBe('fallback')
  })

  it('smoothly distributes aggregate traffic by member weight', () => {
    const scheduler = new PoolScheduler()
    const aggregate = pool({
      kind: 'relay-aggregate',
      strategy: 'weighted-round-robin',
      members: [
        { accountId: 'a', enabled: true, order: 0, weight: 5 },
        { accountId: 'b', enabled: true, order: 1, weight: 1 },
        { accountId: 'c', enabled: true, order: 2, weight: 1 }
      ]
    })
    const accounts = [account('c', { weight: 100 }), account('b'), account('a')]
    const selected: string[] = []

    for (let index = 0; index < 7; index += 1) {
      const scheduled = scheduler.selectAndAcquire({ pool: aggregate, accounts, model: 'model' })
      selected.push(scheduled.account.id)
      scheduled.release()
    }

    expect(selected).toEqual(['a', 'a', 'b', 'a', 'c', 'a', 'a'])
    expect(countByValue(selected)).toEqual({ a: 5, b: 1, c: 1 })
  })

  it('uses account weights for smooth weighted standard pools', () => {
    const scheduler = new PoolScheduler()
    const weighted = pool({ strategy: 'weighted-round-robin' })
    const accounts = [account('light', { weight: 1 }), account('heavy', { weight: 3 })]
    const selected: string[] = []

    for (let index = 0; index < 4; index += 1) {
      const scheduled = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })
      selected.push(scheduled.account.id)
      scheduled.release()
    }

    expect(selected).toEqual(['heavy', 'light', 'heavy', 'heavy'])
  })

  it('keeps weighted aggregate assignments sticky without advancing the shared sequence', () => {
    const scheduler = new PoolScheduler()
    const aggregate = pool({
      kind: 'relay-aggregate',
      strategy: 'weighted-round-robin',
      stickySessions: true,
      members: [
        { accountId: 'a', enabled: true, order: 0, weight: 1 },
        { accountId: 'b', enabled: true, order: 1, weight: 3 }
      ]
    })
    const accounts = [account('a'), account('b')]

    const first = scheduler.selectAndAcquire({
      pool: aggregate, accounts, model: 'model', sessionId: 'sticky'
    })
    expect(first.account.id).toBe('b')
    first.release()
    const sticky = scheduler.selectAndAcquire({
      pool: aggregate, accounts, model: 'model', sessionId: 'sticky'
    })
    expect(sticky.account.id).toBe('b')
    sticky.release()

    const nextSequenceEntry = scheduler.selectAndAcquire({ pool: aggregate, accounts, model: 'model' })
    expect(nextSequenceEntry.account.id).toBe('a')
  })

  it('preserves smooth weighted progress while a member is temporarily ineligible', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const weighted = pool({ strategy: 'weighted-round-robin' })
    const accounts = [account('a', { weight: 1 }), account('b', { weight: 3 })]

    const first = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })
    expect(first.account.id).toBe('b')
    first.release()
    scheduler.setCooldown('b', now + 1_000)
    const duringCooldown = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })
    expect(duringCooldown.account.id).toBe('a')
    duringCooldown.release()
    now += 1_001

    const afterCooldown = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })
    expect(afterCooldown.account.id).toBe('a')
  })

  it('clears smooth weighted state and restarts its deterministic sequence', () => {
    const scheduler = new PoolScheduler()
    const weighted = pool({ strategy: 'weighted-round-robin' })
    const accounts = [account('a', { weight: 1 }), account('b', { weight: 3 })]

    const first = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })
    expect(first.account.id).toBe('b')
    first.release()
    scheduler.clear()
    const afterClear = scheduler.selectAndAcquire({ pool: weighted, accounts, model: 'model' })

    expect(afterClear.account.id).toBe('b')
  })

  it('drops scheduling cursors for pools removed at a configuration handoff', () => {
    const scheduler = new PoolScheduler()
    const roundRobin = pool({ strategy: 'round-robin' })
    const accounts = [account('a'), account('b')]

    const first = scheduler.selectAndAcquire({ pool: roundRobin, accounts, model: 'model' })
    expect(first.account.id).toBe('a')
    first.release()

    scheduler.hydrate(accounts, [])
    scheduler.hydrate(accounts, [roundRobin])
    const afterRecreate = scheduler.selectAndAcquire({ pool: roundRobin, accounts, model: 'model' })

    expect(afterRecreate.account.id).toBe('a')
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

  it('prioritizes persisted semantic TTFT over an earlier transport first body', () => {
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

    expect(selected.account.id).toBe(rawSlowVisibleFast.id)
    const fitness = scheduler.getFitness([rawFastVisibleSlow, rawSlowVisibleFast])
    expect(fitness[rawFastVisibleSlow.id]).toMatchObject({
      semanticFirstTokenMs: 4_500,
      transportFirstBodyMs: 800,
      firstTokenMs: 4_500
    })
    expect(fitness[rawSlowVisibleFast.id]).toMatchObject({
      semanticFirstTokenMs: 900,
      transportFirstBodyMs: 2_500,
      firstTokenMs: 900
    })
  })

  it('keeps transport-only legacy logs useful when semantic timing is unavailable', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const legacyFast = account('legacy-fast', { maxConcurrency: 4 })
    const legacySlow = account('legacy-slow', { maxConcurrency: 4 })
    scheduler.hydratePerformance([
      ...Array.from({ length: 4 }, (_, index) => requestLog(legacyFast.id, {
        id: `legacy-fast-${index}`,
        timestamp: timestamp - 4_000 + index,
        upstreamFirstByteMs: 800,
        firstTokenMs: 800,
        accountFirstTokenMs: undefined
      })),
      ...Array.from({ length: 4 }, (_, index) => requestLog(legacySlow.id, {
        id: `legacy-slow-${index}`,
        timestamp: timestamp - 4_000 + index,
        upstreamFirstByteMs: 2_500,
        firstTokenMs: 2_500,
        accountFirstTokenMs: undefined
      }))
    ])

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [legacySlow, legacyFast],
      model: 'model'
    })

    expect(selected.account.id).toBe(legacyFast.id)
    expect(scheduler.getFitness([legacyFast])[legacyFast.id]).toMatchObject({
      semanticFirstTokenMs: undefined,
      transportFirstBodyMs: 800,
      firstTokenMs: 800
    })
  })

  it('selects the account with faster semantic output when transport timing disagrees', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0.5)
    const quickSocketSlowModel = account('quick-socket-slow-model', { maxConcurrency: 4 })
    const slowSocketQuickModel = account('slow-socket-quick-model', { maxConcurrency: 4 })
    for (let index = 0; index < 4; index += 1) {
      scheduler.recordPerformance(quickSocketSlowModel.id, {
        transportFirstBodyMs: 100,
        semanticFirstTokenMs: 5_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
      scheduler.recordPerformance(slowSocketQuickModel.id, {
        transportFirstBodyMs: 2_000,
        semanticFirstTokenMs: 800,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
    }

    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'autobalanced' }),
      accounts: [quickSocketSlowModel, slowSocketQuickModel],
      model: 'model'
    })

    expect(selected.account.id).toBe(slowSocketQuickModel.id)
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
    expect(scheduler.getFitness([fastAfterFailover])[fastAfterFailover.id]).toMatchObject({
      // The preceding failed attempt took 5 seconds. Neither winning-account
      // metric may inherit that time.
      transportFirstBodyMs: 1_100,
      semanticFirstTokenMs: 1_500,
      firstTokenMs: 1_500
    })
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

  it('moves only the failed sticky session to another account', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const accounts = [account('a'), account('b')]
    const stickyPool = pool({ strategy: 'priority', stickySessions: true })

    const failedSession = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'failed-session'
    })
    expect(failedSession.account.id).toBe('a')
    failedSession.release()
    const unrelatedSession = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'unrelated-session'
    })
    expect(unrelatedSession.account.id).toBe('a')
    unrelatedSession.release()

    expect(scheduler.recordStickyFailure(stickyPool.id, 'failed-session', 'a')).toBe(true)
    const reassigned = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'failed-session'
    })
    expect(reassigned.account.id).toBe('b')
    reassigned.release()

    const unrelatedAgain = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'unrelated-session'
    })
    expect(unrelatedAgain.account.id).toBe('a')
    unrelatedAgain.release()

    const staysReassigned = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'failed-session'
    })
    expect(staysReassigned.account.id).toBe('b')
    staysReassigned.release()
  })

  it('does not let a stale failure evict a newer sticky assignment', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const accounts = [account('a'), account('b')]
    const stickyPool = pool({ strategy: 'priority', stickySessions: true })
    const first = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'session'
    })
    first.release()
    expect(scheduler.recordStickyFailure(stickyPool.id, 'session', 'a')).toBe(true)
    const second = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'session'
    })
    expect(second.account.id).toBe('b')
    second.release()

    expect(scheduler.recordStickyFailure(stickyPool.id, 'session', 'a')).toBe(false)
    const stillSecond = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'session'
    })
    expect(stillSecond.account.id).toBe('b')
    stillSecond.release()
  })

  it('clears every existing session pinned to a proven failed account', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const accounts = [account('a'), account('b')]
    const stickyPool = pool({ strategy: 'priority', stickySessions: true })
    for (const sessionId of ['one', 'two']) {
      const selected = scheduler.selectAndAcquire({ pool: stickyPool, accounts, model: 'model', sessionId })
      expect(selected.account.id).toBe('a')
      selected.release()
    }

    scheduler.recordFailure('a')
    now += 31_000
    // The runtime cooldown has elapsed, so choosing b proves the old sticky
    // assignments were invalidated rather than merely masked by eligibility.
    for (const sessionId of ['one', 'two']) {
      const selected = scheduler.selectAndAcquire({ pool: stickyPool, accounts, model: 'model', sessionId })
      expect(selected.account.id).toBe('b')
      selected.release()
    }
  })

  it('excludes every account already failed by the same retry chain', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const accounts = [account('a'), account('b'), account('c')]
    const selected = scheduler.selectAndAcquire({
      pool: pool({ strategy: 'priority' }),
      accounts,
      model: 'model',
      excludedAccountIds: ['a', 'b']
    })
    expect(selected.account.id).toBe('c')
    selected.release()
  })

  it('softly spreads concurrently active sticky conversations across accounts', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const accounts = [
      account('a', { maxConcurrency: 4 }),
      account('b', { maxConcurrency: 4 })
    ]
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true })

    // With no overlap, both conversations initially prefer the same best/tied
    // account and establish independent sticky assignments there.
    const firstAssignment = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'conversation-1'
    })
    expect(firstAssignment.account.id).toBe('a')
    firstAssignment.release()
    const secondAssignment = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'conversation-2'
    })
    expect(secondAssignment.account.id).toBe('a')
    secondAssignment.release()

    const firstActive = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'conversation-1'
    })
    const secondActive = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'conversation-2'
    })

    expect(firstActive.account.id).toBe('a')
    expect(secondActive.account.id).toBe('b')
    firstActive.release()
    secondActive.release()

    const reassigned = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'conversation-2'
    })
    expect(reassigned.account.id).toBe('b')
    reassigned.release()
  })

  it('does not spread concurrent requests belonging to the same sticky conversation', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const accounts = [
      account('a', { maxConcurrency: 4 }),
      account('b', { maxConcurrency: 4 })
    ]
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true })

    const first = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'same-conversation'
    })
    const parallelTurn = scheduler.selectAndAcquire({
      pool: stickyPool, accounts, model: 'model', sessionId: 'same-conversation'
    })

    expect(first.account.id).toBe('a')
    expect(parallelTurn.account.id).toBe('a')
    first.release()
    parallelTurn.release()
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

  it('uses semantic TTFT rather than transport timing for sticky escape', () => {
    const scheduler = new PoolScheduler(() => timestamp, () => 0)
    const quickSocketSlowModel = account('a-quick-socket-slow-model', { maxConcurrency: 4 })
    const slowSocketQuickModel = account('z-slow-socket-quick-model', { maxConcurrency: 4 })
    const stickyPool = pool({ strategy: 'autobalanced', stickySessions: true })

    const initial = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [quickSocketSlowModel, slowSocketQuickModel],
      model: 'model',
      sessionId: 'semantic-sticky-session'
    })
    expect(initial.account.id).toBe(quickSocketSlowModel.id)
    initial.release()

    for (let index = 0; index < 3; index += 1) {
      scheduler.recordPerformance(quickSocketSlowModel.id, {
        transportFirstBodyMs: 100,
        semanticFirstTokenMs: 5_000,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
      scheduler.recordPerformance(slowSocketQuickModel.id, {
        transportFirstBodyMs: 2_000,
        semanticFirstTokenMs: 800,
        outputTokens: 100,
        generationDurationMs: 2_000
      })
    }

    const escaped = scheduler.selectAndAcquire({
      pool: stickyPool,
      accounts: [quickSocketSlowModel, slowSocketQuickModel],
      model: 'model',
      sessionId: 'semantic-sticky-session'
    })

    expect(escaped.account.id).toBe(slowSocketQuickModel.id)
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

  it('does not let an older successful attempt clear a newer quota cooldown', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const onlyAccount = account('a', { maxConcurrency: 4 })
    const selected = scheduler.selectAndAcquire({
      pool: pool(),
      accounts: [onlyAccount],
      model: 'model'
    })

    scheduler.setCooldown('a', timestamp + 60_000)
    const staleSuccess = scheduler.recordSuccess('a', selected.healthRevision)

    expect(staleSuccess).toMatchObject({
      applied: false,
      circuitState: 'open',
      cooldownUntil: timestamp + 60_000
    })
    expect(() => scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' }))
      .toThrow(NoEligibleAccountError)
    selected.release()
  })

  it('requires an attempt revision to clear quota health after its cooldown expires', () => {
    let now = timestamp
    const scheduler = new PoolScheduler(() => now)
    const onlyAccount = account('a', { maxConcurrency: 4 })

    scheduler.setCooldown('a', now + 1_000)
    expect(scheduler.recordSuccess('a')).toMatchObject({
      applied: false,
      circuitState: 'open'
    })

    now += 1_001
    const probe = scheduler.selectAndAcquire({ pool: pool(), accounts: [onlyAccount], model: 'model' })
    expect(scheduler.recordSuccess('a', probe.healthRevision)).toMatchObject({
      applied: true,
      circuitState: 'closed',
      consecutiveFailures: 0
    })
    probe.release()
  })

  it('never shortens a quota cooldown when a later generic failure is recorded', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    scheduler.setCooldown('a', timestamp + 60_000)

    expect(scheduler.recordFailure('a', {
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
      reason: 'failure'
    })).toMatchObject({
      cooldownUntil: timestamp + 60_000
    })
    expect(scheduler.recordSuccess('a')).toMatchObject({
      applied: false,
      cooldownUntil: timestamp + 60_000
    })
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

  it('counts only healthy model-compatible peers as usable alternatives without treating capacity as health', () => {
    const scheduler = new PoolScheduler(() => timestamp)
    const selected = account('selected')
    const busy = account('busy', { inFlight: 1, maxConcurrency: 1 })
    const disabled = account('disabled', { status: 'disabled' })
    const exhausted = account('exhausted', {
      quota: { requests: { limit: 100, remaining: 0, resetAt: timestamp + 60_000 }, observedAt: timestamp }
    })
    const codexExhausted = account('codex-exhausted', {
      codexQuota: {
        observedAt: timestamp,
        source: 'response-headers',
        fiveHour: { usedPercent: 100, resetAt: timestamp + 60_000 }
      }
    })
    const incompatible = account('incompatible', {
      modelPolicy: 'selected',
      modelAllowlist: ['different-model']
    })

    expect(scheduler.hasUsableAlternative([selected, busy], 'model', selected.id)).toBe(true)
    expect(scheduler.hasUsableAlternative(
      [selected, disabled, exhausted, codexExhausted, incompatible],
      'model',
      selected.id
    )).toBe(false)

    scheduler.recordFailure(busy.id)
    expect(scheduler.hasUsableAlternative([selected, busy], 'model', selected.id)).toBe(false)
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
