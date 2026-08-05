import { describe, expect, it, vi } from 'vitest'
import type { AgentLifecycleChangedEvent, AgentTarget } from '../../src/shared/agent-lifecycle'
import {
  AgentLifecycleService,
  type AgentAdapterSnapshot,
  type AgentInstallationPort,
  type AgentLifecycleAdapterPort,
} from '../../src/main/agent-lifecycle/service'

const targets: AgentTarget[] = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'claude-code-desktop',
  'claude-code-vsc',
  'gemini-cli',
  'grok-build',
]
const runningTargets = ['codex-desktop', 'codex-cli', 'claude-code', 'gemini-cli', 'grok-build'] as const
const launchOnlyTargets = ['claude-code-desktop', 'claude-code-vsc'] as const

describe('AgentLifecycleService', () => {
  it('isolates an inspection failure to the affected Agent', async () => {
    const adapters = adaptersWith()
    adapters['claude-code'].inspect = vi.fn(async () => { throw new Error('broken config') })
    const service = createService(adapters)

    const snapshot = await service.getSnapshot()

    expect(snapshot.agents['claude-code'].attention).toBe('failed')
    expect(snapshot.agents['claude-code'].error?.message).toContain('broken config')
    expect(snapshot.agents['codex-desktop'].attention).toBe('normal')
  })

  it('clears a transient inspection error after the next successful inspection', async () => {
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValue(healthySnapshot())
    const service = createService(adaptersWith({ 'claude-code': { inspect } }), {
      snapshotCacheTtlMs: 0,
    })

    expect((await service.getSnapshot()).agents['claude-code'].attention).toBe('failed')
    const recovered = await service.getSnapshot()

    expect(recovered.agents['claude-code'].attention).toBe('normal')
    expect(recovered.agents['claude-code'].error).toBeUndefined()
  })

  it('coalesces and briefly caches renderer snapshot probes', async () => {
    let now = 10_000
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inspect = vi.fn(async () => { await gate; return healthySnapshot() })
    const service = createService(adaptersWith({ 'claude-code': { inspect } }), {
      now: () => now,
      snapshotCacheTtlMs: 4_000,
    })

    const first = service.getSnapshot()
    const second = service.getSnapshot()
    release()
    await Promise.all([first, second])
    await service.getSnapshot()
    expect(inspect).toHaveBeenCalledTimes(1)

    now += 4_001
    await service.getSnapshot()
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('does not publish an older polling flight after a lifecycle transition begins', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inspect = vi.fn()
      .mockImplementationOnce(async () => { await gate; return healthySnapshot() })
      .mockImplementation(async () => healthySnapshot())
    const restore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({ 'claude-code': { inspect, restore } }))
    const events: AgentLifecycleChangedEvent[] = []
    service.onChange((event) => events.push(event))

    const polling = service.getSnapshot()
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    const operation = service.restore('claude-code')
    release()
    await Promise.all([polling, operation])

    expect(events.some((event) => event.snapshot.busy
      && event.snapshot.agents['claude-code'].busyAction === 'restore')).toBe(true)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('serializes Codex desktop and CLI operations through their shared state group', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const desktopRestore = vi.fn(async () => { await gate })
    const cliRestore = vi.fn(async () => undefined)
    const adapters = adaptersWith({
      'codex-desktop': { restore: desktopRestore },
      'codex-cli': { restore: cliRestore },
    })
    const service = createService(adapters)

    const first = service.restore('codex-desktop')
    await vi.waitFor(() => expect(desktopRestore).toHaveBeenCalledOnce())
    const second = service.restore('codex-cli')
    await Promise.resolve()
    expect(cliRestore).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(cliRestore).toHaveBeenCalledOnce()
  })

  it('allows unrelated Agent homes to restore concurrently', async () => {
    let active = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const restore = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
    })
    const service = createService(adaptersWith({
      'claude-code': { restore },
      'gemini-cli': { restore },
    }))

    const operations = [service.restore('claude-code'), service.restore('gemini-cli')]
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(peak).toBe(2)
    release()
    await Promise.all(operations)
  })

  it('serializes all Claude surfaces through one config lock without treating them as aliases', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cliRestore = vi.fn(async () => { await gate; return { changed: true } })
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const vscRestore = vi.fn(async () => ({ changed: true }))
    const stoppedSurface = vi.fn(async () => ({
      ...healthySnapshot(),
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable' as const,
    }))
    const service = createService(adaptersWith({
      'claude-code': { restore: cliRestore },
      'claude-code-desktop': { inspect: stoppedSurface, restore: desktopRestore },
      'claude-code-vsc': { inspect: stoppedSurface, restore: vscRestore },
    }))

    const cli = service.restore('claude-code')
    await vi.waitFor(() => expect(cliRestore).toHaveBeenCalledOnce())
    const desktop = service.restore('claude-code-desktop')
    const vsc = service.restore('claude-code-vsc')
    await Promise.resolve()
    expect(desktopRestore).not.toHaveBeenCalled()
    expect(vscRestore).not.toHaveBeenCalled()

    release()
    await Promise.all([cli, desktop, vsc])
    expect(desktopRestore).toHaveBeenCalledOnce()
    expect(vscRestore).toHaveBeenCalledOnce()
  })

  it('returns partial aggregate results without hiding the failing Agent', async () => {
    const adapters = adaptersWith({
      'codex-cli': { inspect: vi.fn(async () => stoppedSnapshot()) },
      'gemini-cli': { restore: vi.fn(async () => { throw new Error('cannot validate') }) },
    })
    const service = createService(adapters)

    const result = await service.repairAllAffected()

    expect(result.status).toBe('partial')
    expect(result.results).toHaveLength(7)
    expect(result.results.find((entry) => entry.target === 'gemini-cli')?.error?.message).toContain('cannot validate')
    expect(result.results.filter((entry) => entry.status === 'succeeded')).toHaveLength(5)
    expect(result.results.find((entry) => entry.target === 'codex-cli')?.status).toBe('skipped')
  })

  it('repairs a shared Codex home once during aggregate repair', async () => {
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({
      'codex-desktop': { restore: desktopRestore },
      'codex-cli': { inspect: vi.fn(async () => stoppedSnapshot()), restore: cliRestore },
    }))

    const result = await service.smartRepair()

    expect(desktopRestore).toHaveBeenCalledOnce()
    expect(desktopRestore).toHaveBeenCalledWith({
      preserveRunningState: true,
      ensureRunning: true,
      repairSessions: true,
      repairWorkspaceIndex: true,
    })
    expect(cliRestore).not.toHaveBeenCalled()
    expect(result.results.find((entry) => entry.target === 'codex-desktop')?.status).toBe('succeeded')
    expect(result.results.find((entry) => entry.target === 'codex-cli')?.status).toBe('skipped')
  })

  it('uses the running Codex member as aggregate representative and never starts its stopped sibling', async () => {
    let desktopRunning = false
    const cliRunning = true
    const desktopStart = vi.fn(async () => { desktopRunning = true })
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({
      'codex-desktop': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: desktopRunning, managedInstanceCount: Number(desktopRunning) })),
        start: desktopStart,
        restore: desktopRestore,
      },
      'codex-cli': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: cliRunning, managedInstanceCount: Number(cliRunning) })),
        restore: cliRestore,
      },
    }))

    const result = await service.repairAllAffected()

    expect(cliRestore).toHaveBeenCalledOnce()
    expect(desktopRestore).not.toHaveBeenCalled()
    expect(desktopStart).not.toHaveBeenCalled()
    expect(result.results.find((entry) => entry.target === 'codex-cli')?.status).toBe('succeeded')
    expect(result.results.find((entry) => entry.target === 'codex-desktop')?.status).toBe('skipped')
  })

  it('fails closed when both shared Codex surfaces already report running', async () => {
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({
      'codex-desktop': { restore: desktopRestore },
      'codex-cli': { restore: cliRestore },
    }))

    const result = await service.repairAllAffected()

    expect(desktopRestore).not.toHaveBeenCalled()
    expect(cliRestore).not.toHaveBeenCalled()
    expect(result.results.filter((entry) => entry.target.startsWith('codex-'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'codex-desktop', status: 'failed', error: expect.objectContaining({ code: 'operation-conflict' }) }),
      expect.objectContaining({ target: 'codex-cli', status: 'failed', error: expect.objectContaining({ code: 'operation-conflict' }) }),
    ]))
  })

  it('uses the installed Codex member as the shared-home repair representative', async () => {
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const adapters = adaptersWith({
      'codex-desktop': {
        inspect: vi.fn(async () => ({ ...stoppedSnapshot(), installed: false })),
        restore: desktopRestore,
      },
      'codex-cli': { restore: cliRestore },
    })
    const service = createService(adapters)

    await service.repairAllAffected()

    expect(desktopRestore).not.toHaveBeenCalled()
    expect(cliRestore).toHaveBeenCalledOnce()
  })

  it('does not collapse Claude CLI, Desktop, and VSC during aggregate restore', async () => {
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    const vscRestore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({
      'claude-code': { restore: cliRestore },
      'claude-code-desktop': { restore: desktopRestore },
      'claude-code-vsc': { restore: vscRestore },
    }))

    const result = await service.repairAllAffected()

    expect(cliRestore).toHaveBeenCalledOnce()
    expect(desktopRestore).toHaveBeenCalledOnce()
    expect(vscRestore).toHaveBeenCalledOnce()
    for (const target of ['claude-code', 'claude-code-desktop', 'claude-code-vsc'] as const) {
      expect(result.results.find((entry) => entry.target === target)?.status).toBe('succeeded')
    }
  })

  it.each(launchOnlyTargets)('repairs launch-only %s during aggregate repair without opening its host', async (target) => {
    const restore = vi.fn(async () => ({ changed: true }))
    const start = vi.fn(async () => undefined)
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable' as const,
    }))
    const service = createService(adaptersWith({ [target]: { inspect, restore, start } }))

    const result = await service.repairAllAffected()

    expect(restore).toHaveBeenCalledWith({
      preserveRunningState: true,
      ensureRunning: false,
      repairSessions: true,
      repairWorkspaceIndex: true,
    })
    expect(start).not.toHaveBeenCalled()
    expect(result.results.find((entry) => entry.target === target)).toMatchObject({
      status: 'succeeded',
      runningAfter: false,
    })
  })

  it('coalesces concurrent smart repair and repair-all requests', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const desktopRestore = vi.fn(async () => { await gate; return { changed: true } })
    const service = createService(adaptersWith({
      'codex-desktop': { restore: desktopRestore },
      'codex-cli': { inspect: vi.fn(async () => stoppedSnapshot()) },
    }))

    const smartRepair = service.smartRepair()
    await vi.waitFor(() => expect(desktopRestore).toHaveBeenCalledOnce())
    const repairAll = service.repairAllAffected()
    await Promise.resolve()
    expect(repairAll).toBe(smartRepair)
    expect(desktopRestore).toHaveBeenCalledOnce()

    release()
    const [smartResult, allResult] = await Promise.all([smartRepair, repairAll])
    expect(allResult.operationId).toBe(smartResult.operationId)
    expect(desktopRestore).toHaveBeenCalledOnce()
  })

  it('enables deep repair for a targeted smart repair', async () => {
    const restore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({ 'codex-cli': { restore } }))

    await service.smartRepair('codex-cli')

    expect(restore).toHaveBeenCalledWith({
      preserveRunningState: true,
      repairSessions: true,
      repairWorkspaceIndex: true,
    })
  })

  it('emits one completed operation for an aggregate repair', async () => {
    const service = createService(adaptersWith())
    const completed = vi.fn()
    service.onChange((event) => { if (event.operation) completed(event.operation) })

    await service.smartRepair()

    expect(completed).toHaveBeenCalledOnce()
    expect(completed.mock.calls[0][0].results).toHaveLength(7)
  })

  it('soft-times out a stuck target without releasing its shared-state lock', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const desktopRestore = vi.fn(async () => ({ changed: true }))
    desktopRestore.mockImplementationOnce(async () => {
      await gate
      return { changed: true }
    })
    const cliRestore = vi.fn(async () => ({ changed: true }))
    const adapters = adaptersWith({
      'codex-desktop': { restore: desktopRestore },
      'codex-cli': { inspect: vi.fn(async () => stoppedSnapshot()), restore: cliRestore },
    })
    const service = createService(adapters, { operationTimeoutMs: 10 })

    const result = await service.repairAllAffected()

    expect(result.status).toBe('partial')
    expect(result.snapshot.busy).toBe(true)
    expect(result.results.find((entry) => entry.target === 'codex-desktop')).toMatchObject({
      status: 'failed',
      error: {
        code: 'operation-conflict',
        retryable: false,
      },
    })
    expect(result.results.find((entry) => entry.target === 'codex-desktop')?.error?.message).toContain('timed out')
    expect(result.results.find((entry) => entry.target === 'claude-code')?.status).toBe('succeeded')
    expect(result.results.find((entry) => entry.target === 'gemini-cli')?.status).toBe('succeeded')

    const blockedRetry = await service.smartRepair('codex-desktop')
    expect(blockedRetry.status).toBe('failed')
    expect(blockedRetry.results[0].error).toMatchObject({ code: 'operation-conflict', retryable: false })
    expect(blockedRetry.results[0].error?.message).toContain('still running')
    const blockedAlias = await service.smartRepair('codex-cli')
    expect(blockedAlias.status).toBe('failed')
    expect(cliRestore).not.toHaveBeenCalled()

    const unrelated = await service.restore('claude-code')
    expect(unrelated.status).toBe('succeeded')

    release()
    await vi.waitFor(async () => {
      expect((await service.getSnapshot()).busy).toBe(false)
    })

    const retry = await service.smartRepair('codex-desktop')
    expect(retry.status).toBe('succeeded')
    expect(retry.snapshot.busy).toBe(false)
    expect(desktopRestore).toHaveBeenCalledTimes(2)
  })

  it('keeps a timed-out rejection handled and exposes the eventual physical failure', async () => {
    let reject!: (cause: Error) => void
    const gate = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise })
    const restore = vi.fn(async () => ({ changed: true }))
    restore.mockImplementationOnce(() => gate)
    const service = createService(adaptersWith({ 'claude-code': { restore } }), { operationTimeoutMs: 10 })

    const timedOut = await service.smartRepair('claude-code')
    expect(timedOut.status).toBe('failed')
    expect(timedOut.snapshot.busy).toBe(true)

    reject(new Error('late physical failure'))
    await vi.waitFor(async () => {
      const snapshot = await service.getSnapshot()
      expect(snapshot.busy).toBe(false)
      expect(snapshot.agents['claude-code'].error?.message).toContain('late physical failure')
    })

    const retry = await service.smartRepair('claude-code')
    expect(retry.status).toBe('succeeded')
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('keeps a late start postcondition failure after the visible timeout settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const start = vi.fn(() => gate)
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running: false,
      managedInstanceCount: 0,
    }))
    const service = createService(adaptersWith({ 'claude-code': { inspect, start } }), { operationTimeoutMs: 10 })

    const timedOut = await service.start('claude-code')
    expect(timedOut.results[0].error?.code).toBe('operation-conflict')

    release()
    await vi.waitFor(async () => {
      const snapshot = await service.getSnapshot()
      expect(snapshot.busy).toBe(false)
      expect(snapshot.agents['claude-code'].error).toMatchObject({
        code: 'process-start-failed',
        phase: 'start',
      })
    })
  })

  it('does not start an unavailable Agent', async () => {
    const start = vi.fn(async () => undefined)
    const adapters = adaptersWith({
      'claude-code': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), installed: false })),
        start,
      },
    })
    const service = createService(adapters)

    const result = await service.start('claude-code')

    expect(result.status).toBe('failed')
    expect(result.results[0].error?.code).toBe('not-installed')
    expect(start).not.toHaveBeenCalled()
  })

  it('lets an installed but drifted Agent repair its connection during start', async () => {
    let repaired = false
    const start = vi.fn(async () => { repaired = true })
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      configured: repaired,
      running: repaired,
      managedInstanceCount: Number(repaired),
    }))
    const service = createService(adaptersWith({ 'claude-code': { inspect, start } }))

    const result = await service.start('claude-code')

    expect(result.status).toBe('succeeded')
    expect(start).toHaveBeenCalledOnce()
    expect(result.snapshot.agents['claude-code']).toMatchObject({ configured: true, running: true })
  })

  it('tags adapter start failures as process-start-failed for the top-right control', async () => {
    const adapters = adaptersWith({
      'claude-code': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: false, managedInstanceCount: 0 })),
        start: vi.fn(async () => { throw new Error('spawn EINVAL') }),
      },
    })
    const service = createService(adapters)

    const result = await service.start('claude-code')

    expect(result.status).toBe('failed')
    expect(result.results[0].error).toMatchObject({
      code: 'process-start-failed',
      message: 'spawn EINVAL',
      phase: 'start',
    })
    expect(result.snapshot.agents['claude-code'].error?.code).toBe('process-start-failed')
  })

  it.each(runningTargets)('treats start as idempotent for an already-running %s target', async (target) => {
    const start = vi.fn(async () => undefined)
    const service = createService(adaptersWith({ [target]: { start } }))

    const result = await service.start(target)

    expect(result.status).toBe('no-op')
    expect(result.results[0]).toMatchObject({
      status: 'skipped',
      phases: ['inspect'],
      runningAfter: true,
    })
    expect(start).not.toHaveBeenCalled()
  })

  it.each(runningTargets)('starts a previously stopped %s target after repair', async (target) => {
    let running = false
    const start = vi.fn(async () => { running = true })
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running,
      managedInstanceCount: running ? 1 : 0,
    }))
    const service = createService(adaptersWith({ [target]: { inspect, start } }))

    const result = await service.restore(target, { ensureRunning: true })

    expect(result.status).toBe('succeeded')
    expect(result.results[0]).toMatchObject({ runningAfter: true })
    expect(result.results[0].phases).toContain('start')
    expect(start).toHaveBeenCalledOnce()
  })

  it.each(launchOnlyTargets)('opens launch-only %s without requiring a running postcondition', async (target) => {
    const start = vi.fn(async () => undefined)
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      configured: false,
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable' as const,
    }))
    const service = createService(adaptersWith({ [target]: { inspect, start } }))

    const result = await service.start(target)

    expect(result.status).toBe('succeeded')
    expect(result.results[0]).toMatchObject({
      target,
      phases: ['inspect', 'start'],
      changed: true,
      runningAfter: false,
    })
    expect(start).toHaveBeenCalledOnce()
  })

  it.each(launchOnlyTargets)('does not expose close or restart behavior for launch-only %s', async (target) => {
    const close = vi.fn(async () => ({ wasRunning: false }))
    const restore = vi.fn(async () => ({ changed: true }))
    const start = vi.fn(async () => undefined)
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running: false,
      managedInstanceCount: 0,
      processControl: 'unavailable' as const,
    }))
    const service = createService(adaptersWith({ [target]: { inspect, close, restore, start } }))

    const closeResult = await service.close(target)
    const restartResult = await service.restart(target)

    expect(closeResult.status).toBe('no-op')
    expect(close).not.toHaveBeenCalled()
    expect(restartResult.status).toBe('failed')
    expect(restartResult.results[0].error).toMatchObject({
      code: 'process-start-failed',
      phase: 'start',
    })
    expect(restore).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps a previously stopped target stopped when ensureRunning is not requested', async () => {
    const start = vi.fn(async () => undefined)
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running: false,
      managedInstanceCount: 0,
    }))
    const service = createService(adaptersWith({ 'claude-code': { inspect, start } }))

    const result = await service.restore('claude-code')

    expect(result.status).toBe('succeeded')
    expect(result.results[0].runningAfter).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects contradictory restore running-state options before touching the adapter', async () => {
    const restore = vi.fn(async () => ({ changed: true }))
    const service = createService(adaptersWith({ 'claude-code': { restore } }))

    const result = await service.restore('claude-code', {
      ensureRunning: true,
      preserveRunningState: false,
    })

    expect(result.status).toBe('failed')
    expect(result.results[0].error).toMatchObject({ code: 'operation-conflict', retryable: false })
    expect(restore).not.toHaveBeenCalled()
  })

  it('restarts a running Codex Agent through configuration and session repair', async () => {
    const close = vi.fn(async () => ({ wasRunning: true }))
    const start = vi.fn(async () => undefined)
    const restore = vi.fn(async () => ({ changed: true }))
    const inspect = vi.fn(async () => ({ ...healthySnapshot(), running: true, managedInstanceCount: 1 }))
    const service = createService(adaptersWith({
      'codex-desktop': { inspect, close, start, restore },
      'codex-cli': {
        inspect: vi.fn(async () => ({ ...healthySnapshot(), running: false, managedInstanceCount: 0 })),
      },
    }))

    const result = await service.restart('codex-desktop')

    expect(result.status).toBe('succeeded')
    expect(result.results[0]).toMatchObject({
      target: 'codex-desktop',
      phases: [
        'inspect',
        'close',
        'restore-connection',
        'repair-residue',
        'repair-sessions',
        'validate',
        'start',
      ],
      wasRunning: true,
      runningAfter: true,
    })
    expect(restore).toHaveBeenCalledWith({
      preserveRunningState: true,
      ensureRunning: true,
      repairSessions: true,
      repairWorkspaceIndex: false,
    })
    expect(close).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each(['claude-code', 'gemini-cli', 'grok-build'] as const)(
    'repairs only configuration while restarting a running %s target',
    async (target) => {
      const close = vi.fn(async () => ({ wasRunning: true }))
      const start = vi.fn(async () => undefined)
      const restore = vi.fn(async () => ({ changed: true }))
      const service = createService(adaptersWith({ [target]: { close, start, restore } }))

      const result = await service.restart(target)

      expect(result.status).toBe('succeeded')
      expect(result.results[0].phases).toEqual([
        'inspect',
        'close',
        'restore-connection',
        'validate',
        'start',
      ])
      expect(restore).toHaveBeenCalledWith({
        preserveRunningState: true,
        ensureRunning: true,
        repairSessions: false,
        repairWorkspaceIndex: false,
      })
      expect(close).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
    },
  )

  it('starts a stopped target without running a repair transaction', async () => {
    let running = false
    const restore = vi.fn(async () => ({ changed: true }))
    const start = vi.fn(async () => { running = true })
    const inspect = vi.fn(async () => ({
      ...healthySnapshot(),
      running,
      managedInstanceCount: running ? 1 : 0,
    }))
    const service = createService(adaptersWith({ 'grok-build': { inspect, restore, start } }))

    const result = await service.restart('grok-build')

    expect(result.status).toBe('succeeded')
    expect(result.results[0].phases).toEqual(['inspect', 'start'])
    expect(start).toHaveBeenCalledOnce()
    expect(restore).not.toHaveBeenCalled()
  })

  it('reports a repair-stage restart failure without attempting a duplicate start', async () => {
    const start = vi.fn(async () => undefined)
    const restore = vi.fn(async () => { throw new Error('configuration write failed') })
    const service = createService(adaptersWith({ 'grok-build': { restore, start } }))

    const result = await service.restart('grok-build')

    expect(result.status).toBe('failed')
    expect(result.results[0]).toMatchObject({
      runningAfter: true,
      error: {
        code: 'configuration-failed',
        phase: 'restore-connection',
        message: 'configuration write failed',
      },
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('propagates cancellation to the adapter and reports a safe non-sticky cancellation', async () => {
    const controller = new AbortController()
    const progress = vi.fn()
    const restore = vi.fn(async (_options, execution) => {
      execution?.onProgress?.({
        target: 'codex-desktop',
        stage: 'scan',
        completed: 1,
        total: 4,
      })
      await new Promise<void>((_resolve, reject) => execution?.signal?.addEventListener('abort', () => {
        const error = new Error('会话修复已取消。')
        error.name = 'AbortError'
        reject(error)
      }, { once: true }))
      return { changed: true }
    }) as AgentLifecycleAdapterPort['restore']
    const service = createService(adaptersWith({ 'codex-desktop': { restore } }))

    const operation = service.restore('codex-desktop', { repairSessions: true }, {
      signal: controller.signal,
      onProgress: progress,
    })
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({
      target: 'codex-desktop',
      stage: 'scan',
      completed: 1,
      total: 4,
    }))
    controller.abort()
    const result = await operation

    expect(result.status).toBe('failed')
    expect(result.results[0].error).toMatchObject({ code: 'cancelled' })
    expect(result.snapshot.agents['codex-desktop'].error).toBeUndefined()
  })

  it('re-inspects the Agent after installation and returns the refreshed snapshot', async () => {
    let installed = false
    const inspect = vi.fn(async () => ({ ...healthySnapshot(), installed }))
    const installer: AgentInstallationPort = {
      install: vi.fn(async (target, channel = 'recommended') => {
        installed = true
        return { operationId: 'native-install', target, channel, status: 'installed' }
      }),
    }
    const service = createService(adaptersWith({ 'claude-code': { inspect } }), { installer })

    const result = await service.install('claude-code')

    expect(result.status).toBe('succeeded')
    expect(result.results[0]).toMatchObject({
      target: 'claude-code', status: 'succeeded', phases: ['inspect', 'install'], changed: true,
    })
    expect(result.snapshot.agents['claude-code'].installed).toBe(true)
    expect(inspect).toHaveBeenCalledTimes(3)
  })

  it('maps installer prerequisites to a structured non-retryable lifecycle error', async () => {
    const installer: AgentInstallationPort = {
      install: vi.fn(async (target, channel = 'recommended') => ({
        operationId: 'gemini-install', target, channel, status: 'failed',
        error: { code: 'node-not-found', message: 'Gemini CLI requires Node.js 20 or newer.' },
      })),
    }
    const service = createService(adaptersWith(), { installer })

    const result = await service.install('gemini-cli')

    expect(result.status).toBe('failed')
    expect(result.results[0]).toMatchObject({
      status: 'failed',
      phases: ['install'],
      error: {
        code: 'installation-prerequisite-missing',
        message: 'Gemini CLI requires Node.js 20 or newer.',
        retryable: false,
      },
    })
  })
})

function createService(
  adapters: Record<AgentTarget, AgentLifecycleAdapterPort>,
  options: {
    operationTimeoutMs?: number
    snapshotCacheTtlMs?: number
    installer?: AgentInstallationPort
    now?: () => number
  } = {},
) {
  const installer = options.installer ?? {
    install: vi.fn(async (target, channel = 'recommended') => ({
      operationId: 'installer-operation', target, channel, status: 'installed' as const,
    })),
  }
  return new AgentLifecycleService({
    adapters,
    installer,
    resolveRoute: () => ({ enabled: true, compatibility: 'native', sourceId: 'pool-1' }),
    id: (() => { let id = 0; return () => `operation-${++id}` })(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.snapshotCacheTtlMs === undefined ? {} : { snapshotCacheTtlMs: options.snapshotCacheTtlMs }),
  })
}

function adaptersWith(
  overrides: Partial<Record<AgentTarget, Partial<AgentLifecycleAdapterPort>>> = {},
): Record<AgentTarget, AgentLifecycleAdapterPort> {
  return Object.fromEntries(targets.map((target) => {
    const base: AgentLifecycleAdapterPort = {
      target,
      inspect: vi.fn(async () => healthySnapshot()),
      close: vi.fn(async () => ({ wasRunning: true })),
      restore: vi.fn(async () => ({ wasRunning: true, changed: true })),
      start: vi.fn(async () => undefined),
    }
    return [target, { ...base, ...overrides[target], target }]
  })) as Record<AgentTarget, AgentLifecycleAdapterPort>
}

function healthySnapshot(): AgentAdapterSnapshot {
  return {
    installed: true,
    configured: true,
    running: true,
    managedInstanceCount: 1,
    processControl: 'managed-only',
  }
}

function stoppedSnapshot(): AgentAdapterSnapshot {
  return {
    ...healthySnapshot(),
    running: false,
    managedInstanceCount: 0,
  }
}
