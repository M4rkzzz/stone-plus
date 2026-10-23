import { describe, expect, it, vi } from 'vitest'
import { runClientConnectionWorkflow } from '../../src/renderer/src/client-connection-workflow'
import type { AgentLifecycleSnapshot } from '../../src/shared/agent-lifecycle'
import type { AppSnapshot, GatewayApi, Route } from '../../src/shared/types'

function harness({ drift = true, running = true, contractChanged = true } = {}) {
  const previous: Route = { id: 'route', client: 'gemini', enabled: true, poolId: 'old', inboundProtocol: 'gemini',
    modelMap: {}, localToken: 'local', createdAt: 1, updatedAt: 1 }
  const desired = { ...previous, poolId: 'new' }
  const state = { routes: [previous], gatewayStatus: { running: true } } as AppSnapshot
  const lifecycle = { agents: { 'gemini-cli': { running, managedInstanceCount: running ? 1 : 0,
    processControl: 'managed-only', capabilities: { canRestart: true } } } } as AgentLifecycleSnapshot
  const events: string[] = []
  let needsRepair = drift
  const api = {
    getSnapshot: vi.fn(async () => state),
    getAgentLifecycleSnapshot: vi.fn(async () => lifecycle),
    previewClientConfig: vi.fn(async () => ({ client: 'gemini', profileId: 'default-gemini', routeChangesConnection: contractChanged,
      files: [{ role: 'gemini-env', changed: needsRepair }] })),
    updateRoute: vi.fn(async (next: Route, expected: Route) => {
      if (state.routes[0] !== expected) throw new Error('concurrent route change')
      events.push(`route:${next.poolId}`)
      state.routes = [{ ...next, updatedAt: next.updatedAt + 1 }]
      return state
    }),
    startGateway: vi.fn(async () => { events.push('gateway') }),
    repairClientConfig: vi.fn(async () => { events.push('direct-write'); needsRepair = false }),
    restoreAgent: vi.fn(async () => {
      events.push('close-write-validate-start')
      needsRepair = false
      return { status: 'succeeded', results: [], snapshot: lifecycle }
    }),
  }
  const options = { api: api as unknown as GatewayApi, previous, desired, profileId: 'default-gemini',
    targets: ['gemini-cli'] as const, confirmActivation: vi.fn(() => true), onLifecycle: vi.fn() }
  return { api, options, state, events }
}

describe('one-click connection and source activation workflow', () => {
  it('lets the lifecycle transaction own the original configuration backup', async () => {
    const { api, options, events } = harness()
    await expect(runClientConnectionWorkflow(options)).resolves.toMatchObject({ cancelled: false, restarted: ['gemini-cli'] })
    expect(events).toEqual(['route:new', 'close-write-validate-start'])
    expect(api.repairClientConfig).not.toHaveBeenCalled()
    expect(api.restoreAgent).toHaveBeenCalledWith('gemini-cli', expect.objectContaining({ ensureRunning: false }))
  })

  it('cancels before touching the route, gateway or files', async () => {
    const { api, options, events } = harness()
    options.confirmActivation.mockReturnValue(false)
    await expect(runClientConnectionWorkflow(options)).resolves.toMatchObject({ cancelled: true })
    expect(events).toEqual([])
    expect(api.restoreAgent).not.toHaveBeenCalled()
    expect(api.repairClientConfig).not.toHaveBeenCalled()
  })

  it('does not repair files after another operation changes the route during gateway preparation', async () => {
    const { api, options, state } = harness()
    state.gatewayStatus.running = false
    api.startGateway.mockImplementationOnce(async () => {
      state.routes = [{ ...state.routes[0], poolId: 'third', updatedAt: 99 }]
    })
    await expect(runClientConnectionWorkflow(options)).rejects.toThrow('route changed during activation')
    expect(api.restoreAgent).not.toHaveBeenCalled()
    expect(api.repairClientConfig).not.toHaveBeenCalled()
    expect(state.routes[0].poolId).toBe('third')
  })

  it('compensates an earlier source activation when a second client fails', async () => {
    const { api, options, state } = harness()
    const snapshot = await api.getAgentLifecycleSnapshot()
    snapshot.agents['codex-cli'] = snapshot.agents['gemini-cli']
    api.restoreAgent.mockResolvedValueOnce({ status: 'succeeded', results: [], snapshot })
      .mockResolvedValueOnce({ status: 'failed', results: [], snapshot })
      .mockResolvedValueOnce({ status: 'succeeded', results: [], snapshot })
    await expect(runClientConnectionWorkflow({ ...options, sourceOnly: true, targets: ['gemini-cli', 'codex-cli'] }))
      .rejects.toThrow('activation did not complete')
    expect(state.routes[0].poolId).toBe('old')
    expect(api.restoreAgent).toHaveBeenCalledTimes(3)
    expect(api.restoreAgent).toHaveBeenLastCalledWith('gemini-cli', expect.objectContaining({ repairSessions: false }))
  })

  it('hot-switches an unchanged client contract without repairing unrelated old drift or restarting', async () => {
    const { api, options, events } = harness({ contractChanged: false })
    await runClientConnectionWorkflow({ ...options, sourceOnly: true })
    expect(events).toEqual(['route:new'])
    expect(options.confirmActivation).not.toHaveBeenCalled()
    expect(api.restoreAgent).not.toHaveBeenCalled()
  })

  it('does not restart for a pure route repair when client files are already correct', async () => {
    const { options, events } = harness({ drift: false })
    await runClientConnectionWorkflow(options)
    expect(events).toEqual(['route:new'])
  })

  it('configures a stopped client without launching it', async () => {
    const { options, events } = harness({ running: false })
    await runClientConnectionWorkflow(options)
    expect(events).toEqual(['route:new', 'direct-write'])
  })

  it('does not restart unrelated default-profile clients for a custom configuration directory', async () => {
    const { options, events } = harness()
    await expect(runClientConnectionWorkflow({ ...options, profileId: 'custom-gemini' }))
      .resolves.toMatchObject({ pendingNewSession: true, restarted: [] })
    expect(events).toEqual(['route:new', 'direct-write'])
  })

  it('still reports external sessions when managed instances of the same client also restart', async () => {
    const { api, options } = harness()
    const lifecycle = await api.getAgentLifecycleSnapshot()
    lifecycle.agents['gemini-cli'] = { ...lifecycle.agents['gemini-cli'], pendingNewSession: true }
    await expect(runClientConnectionWorkflow(options)).resolves.toMatchObject({
      restarted: ['gemini-cli'], pendingNewSession: true,
    })
    expect(options.confirmActivation).toHaveBeenCalledWith(['gemini-cli'], true)
  })

  it.each(['failed', 'partial'] as const)('rolls back the route when activation returns %s', async (status) => {
    const { api, options, state } = harness()
    api.restoreAgent.mockResolvedValueOnce({ status, results: [], snapshot: await api.getAgentLifecycleSnapshot() })
    await expect(runClientConnectionWorkflow(options)).rejects.toThrow('activation did not complete')
    expect(state.routes[0].poolId).toBe('old')
    expect(api.repairClientConfig).not.toHaveBeenCalled()
  })

  it('preserves a later source selection instead of overwriting it during rollback', async () => {
    const { api, options, state } = harness()
    api.restoreAgent.mockImplementationOnce(async () => {
      state.routes = [{ ...state.routes[0], poolId: 'third', updatedAt: 99 }]
      throw new Error('restart failed')
    })
    await expect(runClientConnectionWorkflow(options)).rejects.toThrow(/restart failed.*route rollback.*concurrent route change/)
    expect(state.routes[0].poolId).toBe('third')
  })

  it('restores the old route if gateway startup fails before any configuration write', async () => {
    const { api, options, state, events } = harness()
    state.gatewayStatus.running = false
    api.startGateway.mockRejectedValueOnce(new Error('port occupied'))
    await expect(runClientConnectionWorkflow(options)).rejects.toThrow('port occupied')
    expect(events).toEqual(['route:new', 'route:old'])
    expect(api.repairClientConfig).not.toHaveBeenCalled()
    expect(api.restoreAgent).not.toHaveBeenCalled()
  })

  it('refuses source switching when its read-only impact preview fails', async () => {
    const { api, options, events } = harness()
    api.previewClientConfig.mockRejectedValueOnce(new Error('invalid config'))
    await expect(runClientConnectionWorkflow({ ...options, sourceOnly: true })).rejects.toThrow('invalid config')
    expect(events).toEqual([])
  })
})
