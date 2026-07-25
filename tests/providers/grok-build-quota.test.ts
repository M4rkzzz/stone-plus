import { describe, expect, it, vi } from 'vitest'
import {
  applyGrokBuildHeaders,
  GROK_BUILD_BILLING_URL,
  GROK_BUILD_CLIENT_IDENTIFIER,
  GROK_BUILD_CLIENT_VERSION,
  GROK_BUILD_TOKEN_AUTH,
  GROK_BUILD_USER_URL,
  GROK_BUILD_USER_AGENT,
  parseGrokBuildBillingPayload,
  queryGrokBuildQuota
} from '../../src/main/providers/grok-build-quota'

describe('Grok Build quota', () => {
  it('applies the reusable official Build identity without retaining credentials', () => {
    const headers = new Headers({ 'x-unrelated': 'keep' })
    applyGrokBuildHeaders(headers, {
      accessToken: 'access-private',
      mode: 'interactive',
      subjectId: 'subject-1',
      email: 'grok@example.test',
      accept: 'text/event-stream',
      acceptEncoding: 'identity'
    })

    expect(Object.fromEntries(headers.entries())).toEqual({
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      authorization: 'Bearer access-private',
      'user-agent': GROK_BUILD_USER_AGENT,
      'x-email': 'grok@example.test',
      'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
      'x-grok-client-mode': 'interactive',
      'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
      'x-unrelated': 'keep',
      'x-userid': 'subject-1',
      'x-xai-token-auth': GROK_BUILD_TOKEN_AUTH
    })
  })

  it('queries the fixed Billing endpoint with a bounded signal and normalizes monthly quota', async () => {
    const observed: { input?: string; init?: RequestInit } = {}
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observed.input = String(input)
      observed.init = init
      return new Response(JSON.stringify({
        subscription: { code: 'super', name: 'Super Plan' },
        config: {
          monthlyLimit: { val: '100' },
          includedUsed: '25',
          billingPeriodStart: '2026-07-01T00:00:00Z',
          billingPeriodEnd: '2026-08-01T00:00:00Z'
        }
      }), { status: 200 })
    })
    const times = [1_000, 1_025]

    const result = await queryGrokBuildQuota('access-private', {
      fetchImplementation: fetchMock as typeof fetch,
      subjectId: 'subject-1',
      email: 'grok@example.test',
      now: () => times.shift() ?? 1_025
    })

    expect(observed.input).toBe(GROK_BUILD_BILLING_URL)
    expect(observed.init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(observed.init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(observed.init?.headers)
    expect(Object.fromEntries(headers.entries())).toMatchObject({
      accept: 'application/json',
      'accept-encoding': 'gzip',
      authorization: 'Bearer access-private',
      'user-agent': 'grok-shell/0.2.111 (linux; x86_64)',
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-mode': 'headless',
      'x-grok-client-version': '0.2.111',
      'x-email': 'grok@example.test',
      'x-userid': 'subject-1',
      'x-xai-token-auth': 'xai-grok-cli'
    })
    expect(result).toEqual({
      ok: true,
      status: 'available',
      statusCode: 200,
      latencyMs: 25,
      quota: {
        usedPercent: 25,
        remainingPercent: 75,
        limit: 100,
        used: 25,
        remaining: 75,
        monthly: { limit: 100, used: 25, remaining: 75 },
        period: {
          start: '2026-07-01T00:00:00Z',
          end: '2026-08-01T00:00:00Z'
        },
        resetAt: Date.parse('2026-08-01T00:00:00Z'),
        plan: { code: 'super', name: 'Super Plan' },
        paidClassification: 'paid',
        observedAt: 1_025,
        source: 'grok-build-billing'
      }
    })
    expect(JSON.stringify(result)).not.toContain('access-private')
  })

  it('accepts root, snake_case, strings, and { val } values while preferring on-demand quota', () => {
    const quota = parseGrokBuildBillingPayload({
      plan_name: 'Free',
      monthly_limit: '100',
      total_used: { val: 20 },
      on_demand_cap: { val: '50' },
      on_demand_used: '12.5',
      prepaid_balance: { val: 5 },
      on_demand_enabled: true,
      is_unified_billing_user: false,
      top_up_method: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
      current_period: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-08T00:00:00Z',
        end: '2026-07-15T00:00:00Z'
      }
    }, 42)

    expect(quota).toMatchObject({
      usedPercent: 25,
      remainingPercent: 75,
      limit: 50,
      used: 12.5,
      remaining: 37.5,
      monthly: { limit: 100, used: 20, remaining: 80 },
      onDemand: { enabled: true, cap: 50, used: 12.5, remaining: 37.5 },
      prepaidBalance: 5,
      unifiedBilling: false,
      topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
      period: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-08T00:00:00Z',
        end: '2026-07-15T00:00:00Z'
      },
      resetAt: Date.parse('2026-07-15T00:00:00Z'),
      plan: { name: 'Free' },
      paidClassification: 'paid',
      observedAt: 42
    })
  })

  it('uses explicit weekly usage percent without treating the percentage itself as a paid signal', () => {
    const quota = parseGrokBuildBillingPayload({
      subscriptionTier: 'SuperGrok Heavy',
      config: {
        creditUsagePercent: 42.5,
        monthlyLimit: { val: 0 },
        used: { val: 0 },
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-07-29T00:00:00Z'
        }
      }
    }, 99)

    expect(quota).toMatchObject({
      usedPercent: 42.5,
      remainingPercent: 57.5,
      monthly: { limit: 0, used: 0, remaining: 0 },
      plan: { name: 'SuperGrok Heavy' },
      paidClassification: 'paid',
      observedAt: 99
    })

    const freeUsage = parseGrokBuildBillingPayload({
      plan: 'free',
      credit_usage_percent: '10'
    }, 100)
    expect(freeUsage).toMatchObject({
      usedPercent: 10,
      remainingPercent: 90,
      paidClassification: 'free'
    })
  })

  it('does not manufacture 100% remaining quota from an all-zero unknown response', () => {
    const quota = parseGrokBuildBillingPayload({
      config: {
        monthlyLimit: { val: 0 },
        used: { val: 0 },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 0 },
        creditUsagePercent: 0
      }
    }, 123)

    expect(quota).toMatchObject({
      monthly: { limit: 0, used: 0, remaining: 0 },
      onDemand: { cap: 0, used: 0, remaining: 0 },
      prepaidBalance: 0,
      paidClassification: 'unknown',
      observedAt: 123
    })
    expect(quota).not.toHaveProperty('usedPercent')
    expect(quota).not.toHaveProperty('remainingPercent')
    expect(quota).not.toHaveProperty('limit')
    expect(parseGrokBuildBillingPayload({ config: {} }, 123)).toBeUndefined()
  })

  it('falls back from an ambiguous explicit zero percent to real amount ratios', () => {
    const amountBacked = parseGrokBuildBillingPayload({
      creditUsagePercent: 0,
      onDemandCap: { val: 50 },
      onDemandUsed: { val: 12.5 }
    }, 123)
    expect(amountBacked).toMatchObject({ usedPercent: 25, remainingPercent: 75 })

    const paidPeriodZero = parseGrokBuildBillingPayload({
      subscriptionTier: 'SuperGrok Heavy',
      config: {
        creditUsagePercent: 0,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-01T00:00:00Z' }
      }
    }, 124)
    expect(paidPeriodZero).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      paidClassification: 'paid'
    })
  })

  it('best-effort fills a missing Billing plan from /user subscription tier', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input))
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer access-private')
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
      if (String(input) === GROK_BUILD_BILLING_URL) {
        return new Response(JSON.stringify({
          config: { monthlyLimit: { val: 100 }, used: { val: 20 } }
        }), { status: 200 })
      }
      expect(String(input)).toBe(GROK_BUILD_USER_URL)
      return new Response(JSON.stringify({ user: { subscription_tier: 'SuperGrok Heavy' } }), { status: 200 })
    })

    const result = await queryGrokBuildQuota('access-private', {
      fetchImplementation: fetchMock as typeof fetch,
      now: () => 1_000
    })

    expect(calls).toEqual([GROK_BUILD_BILLING_URL, GROK_BUILD_USER_URL])
    expect(result).toMatchObject({
      ok: true,
      quota: {
        plan: { name: 'SuperGrok Heavy' },
        paidClassification: 'paid',
        remainingPercent: 80
      }
    })
  })

  it('keeps valid Billing when /user fails and falls back to the access JWT tier', async () => {
    const claims = Buffer.from(JSON.stringify({ tier: 5 })).toString('base64url')
    const accessToken = `header.${claims}.signature`
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({
          config: { monthly_limit: '100', included_used: '40' }
        }), { status: 200 })
      }
      throw new Error(`user endpoint failed with Bearer ${accessToken}`)
    })

    const result = await queryGrokBuildQuota(accessToken, {
      fetchImplementation: fetchMock as typeof fetch,
      now: () => 1_000
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      ok: true,
      quota: {
        remainingPercent: 60,
        plan: { name: 'supergrok_heavy' },
        paidClassification: 'paid'
      }
    })
    expect(JSON.stringify(result)).not.toContain(accessToken)
  })

  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [429, 'rate_limit'],
    [503, 'upstream']
  ] as const)('returns a non-mutating structured failure for HTTP %i', async (statusCode, category) => {
    const accessToken = 'access-private'
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: `Bearer ${accessToken}` }),
      { status: statusCode, headers: statusCode === 429 ? { 'retry-after': '2' } : undefined }
    ))

    const result = await queryGrokBuildQuota(accessToken, {
      fetchImplementation: fetchMock as typeof fetch,
      now: () => 1_000
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'unavailable',
      statusCode,
      failure: { category, accountAction: 'none' }
    })
    expect(JSON.stringify(result)).not.toContain(accessToken)
  })

  it('rejects invalid, empty, and oversized bodies without exposing response content', async () => {
    const accessToken = 'access-private'
    const cases = [
      {
        response: new Response(`{"credential":"${accessToken}"`, { status: 200 }),
        message: 'Grok Build billing returned invalid JSON.'
      },
      {
        response: new Response(JSON.stringify({ config: { credential: accessToken } }), { status: 200 }),
        message: 'Grok Build billing returned no recognizable quota data.'
      },
      {
        response: new Response('small', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
        message: 'Grok Build billing response is too large.'
      }
    ]

    for (const testCase of cases) {
      const result = await queryGrokBuildQuota(accessToken, {
        fetchImplementation: vi.fn(async () => testCase.response) as typeof fetch,
        now: () => 1_000
      })
      expect(result).toMatchObject({
        ok: false,
        failure: {
          category: 'invalid_response',
          message: testCase.message,
          accountAction: 'none'
        }
      })
      expect(JSON.stringify(result)).not.toContain(accessToken)
    }
  })

  it('returns generic network and cancellation failures without echoing thrown secrets', async () => {
    const accessToken = 'access-private'
    const network = await queryGrokBuildQuota(accessToken, {
      fetchImplementation: vi.fn(async () => {
        throw new Error(`could not reach Bearer ${accessToken}`)
      }) as typeof fetch,
      now: () => 1_000
    })
    expect(network).toMatchObject({
      ok: false,
      failure: { category: 'network', accountAction: 'none', retryable: true }
    })
    expect(JSON.stringify(network)).not.toContain(accessToken)

    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const cancelled = await queryGrokBuildQuota(accessToken, {
      signal: controller.signal,
      fetchImplementation: vi.fn(async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(init?.signal).not.toBe(controller.signal)
        throw init?.signal instanceof AbortSignal ? init.signal.reason : new Error('cancelled')
      }) as typeof fetch,
      now: () => 1_000
    })
    expect(cancelled).toMatchObject({
      ok: false,
      failure: { category: 'cancelled', accountAction: 'none', retryable: false }
    })
  })
})
