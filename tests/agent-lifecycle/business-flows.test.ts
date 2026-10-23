import { describe, expect, it, vi } from 'vitest'
import { AGENT_TARGETS, type AgentTarget } from '../../src/shared/agent-lifecycle'
import type { AppSnapshot } from '../../src/shared/types'
import { resolveAgentRouteState } from '../../src/main/agent-lifecycle/route-state'
import { AgentLifecycleService, type AgentLifecycleAdapterPort } from '../../src/main/agent-lifecycle/service'

function selectedRoute(): Pick<AppSnapshot, 'routes' | 'providers' | 'accounts' | 'pools'> {
  return {
    routes: [{ id: 'claude-route', client: 'claude', enabled: true, inboundProtocol: 'anthropic-messages',
      poolId: 'relay', modelMap: {}, localToken: 'test-only', createdAt: 1, updatedAt: 1 }],
    pools: [],
    providers: [{ id: 'relay', name: 'Selected relay', kind: 'openai-compatible', sourceType: 'relay',
      protocol: 'openai-responses', baseUrl: 'https://example.invalid/v1', models: ['model'], createdAt: 1, updatedAt: 1 }],
    accounts: [{ id: 'account', name: 'Account', providerId: 'relay', credentialType: 'api-key', maskedCredential: '***',
      status: 'active', priority: 1, weight: 1, inFlight: 0, maxConcurrency: 20,
      availableModels: [], modelPolicy: 'all', modelAllowlist: [], createdAt: 1, updatedAt: 1 }],
  }
}

describe('selected source -> Agent business flow', () => {
  it('labels a valid translated route as compatible, rather than native or unsupported', () => {
    expect(resolveAgentRouteState(selectedRoute(), 'claude-code')).toMatchObject({
      enabled: true, compatibility: 'compatible', sourceName: 'Selected relay',
    })
  })

  it('distinguishes native routes, disabled routes, and missing sources', () => {
    const snapshot = selectedRoute()
    snapshot.providers[0].protocol = 'anthropic-messages'
    expect(resolveAgentRouteState(snapshot, 'claude-code').compatibility).toBe('native')
    snapshot.routes[0].enabled = false
    expect(resolveAgentRouteState(snapshot, 'claude-code')).toMatchObject({ enabled: false, compatibility: 'unsupported' })
    snapshot.routes[0].enabled = true
    snapshot.providers = []
    expect(resolveAgentRouteState(snapshot, 'claude-code')).toMatchObject({ compatibility: 'unsupported', reason: 'Route source not found.' })
  })

  it('does not mistake temporary cooldown or full concurrency for a protocol mismatch', () => {
    const snapshot = selectedRoute()
    snapshot.accounts[0].status = 'cooldown'
    snapshot.accounts[0].cooldownUntil = Date.now() + 60_000
    snapshot.accounts[0].inFlight = 20
    expect(resolveAgentRouteState(snapshot, 'claude-code')).toMatchObject({ compatibility: 'compatible', sourceName: 'Selected relay' })
  })

  it('re-evaluates a changed source and refuses repair before touching a running client', async () => {
    const snapshot = selectedRoute()
    let running = true
    const restore = vi.fn(async () => { running = false })
    const start = vi.fn(async () => { running = true })
    const adapters = Object.fromEntries(AGENT_TARGETS.map((target) => [target, {
      target, inspect: async () => ({ installed: true, configured: true, running: target === 'claude-code' && running,
        managedInstanceCount: target === 'claude-code' && running ? 1 : 0, processControl: 'managed-only' as const }),
      restore, start, close: vi.fn(),
    }])) as Record<AgentTarget, AgentLifecycleAdapterPort>
    const service = new AgentLifecycleService({
      adapters, installer: { install: vi.fn() }, snapshotCacheTtlMs: 0,
      resolveRoute: (target) => resolveAgentRouteState(snapshot, target),
    })
    expect((await service.getSnapshot()).agents['claude-code'].compatibility).toBe('compatible')
    // A source edit can change its family without changing the route's inbound protocol.
    snapshot.providers[0].kind = 'deepseek-compatible'
    expect((await service.getSnapshot()).agents['claude-code'].compatibility).toBe('unsupported')
    for (const result of [await service.restore('claude-code'), await service.restart('claude-code'), await service.repairAllAffected()]) {
      expect(result.results.find((entry) => entry.target === 'claude-code')).toMatchObject({
        status: 'failed', error: { code: 'unsupported-source', phase: 'inspect' },
      })
    }
    expect(restore).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(running).toBe(true)
  })
})

function gatewayGatedService(target: AgentTarget, running: boolean, ensureGatewayReady: () => Promise<void>) {
  const events: string[] = []
  const start = vi.fn(async () => { events.push('start'); running = true })
  const restore = vi.fn(async () => { events.push('restore') })
  const close = vi.fn(async () => { events.push('close'); running = false })
  const adapters = Object.fromEntries(AGENT_TARGETS.map((entry) => [entry, {
    target: entry, inspect: async () => ({ installed: true, configured: true, running: entry === target && running,
      managedInstanceCount: entry === target && running ? 1 : 0, processControl: 'managed-only' as const }),
    start, restore, close,
  }])) as Record<AgentTarget, AgentLifecycleAdapterPort>
  const service = new AgentLifecycleService({ adapters, installer: { install: vi.fn() },
    resolveRoute: (entry) => ({ enabled: entry === target, compatibility: 'native' }),
    ensureGatewayReady: async () => { events.push('gateway'); await ensureGatewayReady() },
  })
  return { service, start, restore, close, events }
}

describe('gateway -> desktop/CLI launch business flow', () => {
  it.each(['codex-desktop', 'claude-code-desktop', 'gemini-cli'] as const)('prepares the gateway before opening %s', async (target) => {
    const { service, events } = gatewayGatedService(target, false, async () => undefined)
    const result = await service.start(target)
    expect(result.status).toBe('succeeded')
    expect(events).toEqual(['gateway', 'start'])
  })

  it.each(['start', 'restart', 'restore', 'repairAllAffected'] as const)('does not close or rewrite a client if the gateway fails during %s', async (action) => {
    const { service, start, restore, close } = gatewayGatedService('codex-desktop', true, async () => { throw new Error('EADDRINUSE: gateway port occupied') })
    const result = action === 'repairAllAffected' ? await service.repairAllAffected() : await service[action]('codex-desktop')
    expect(result.results[0]).toMatchObject({ status: 'failed', error: { code: 'validation-failed', phase: 'validate', message: 'EADDRINUSE: gateway port occupied' } })
    expect(start).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(result.snapshot.agents['codex-desktop'].running).toBe(true)
  })

  it('repairs a stopped client without starting the gateway or the client', async () => {
    const { service, events } = gatewayGatedService('gemini-cli', false, async () => { throw new Error('must not probe the gateway') })
    const result = await service.repairAllAffected()
    expect(result.status).toBe('succeeded')
    expect(events).toEqual(['restore'])
  })

  it('honors cancellation received while preparing the gateway before restoring a running client', async () => {
    const controller = new AbortController()
    const { service, restore } = gatewayGatedService('codex-desktop', true, async () => controller.abort())
    const result = await service.restore('codex-desktop', undefined, { signal: controller.signal })
    expect(result.results[0].error?.code).toBe('cancelled')
    expect(restore).not.toHaveBeenCalled()
    expect(result.snapshot.agents['codex-desktop'].running).toBe(true)
  })
})
