import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import {
  ManagedProcessRegistry,
  type ManagedAgentProcess,
  type ManagedProcessAdapter,
  type ObservedProcessIdentity
} from '../../src/main/agent-lifecycle/managed-process-registry'

const registration = {
  target: 'codex-cli' as const,
  pid: 4242,
  startedAtMs: 1_700_000_000_000,
  executablePath: 'C:/Tools/codex.exe',
  cwd: 'C:/work/project',
  configDir: 'C:/Users/test/.codex'
}

function harness() {
  let clock = 1_800_000_000_000
  let observed: ObservedProcessIdentity | undefined = {
    pid: registration.pid,
    startedAtMs: registration.startedAtMs,
    executablePath: registration.executablePath
  }
  const adapter: ManagedProcessAdapter = {
    inspect: vi.fn(async () => observed),
    closeGracefully: vi.fn(async () => undefined),
    closeForced: vi.fn(async () => { observed = undefined })
  }
  const registry = new ManagedProcessRegistry({
    adapter,
    platform: 'win32',
    gracefulTimeoutMs: 20,
    forcedTimeoutMs: 20,
    pollIntervalMs: 5,
    now: () => clock,
    sleep: vi.fn(async (durationMs: number) => { clock += durationMs })
  })
  return {
    adapter,
    registry,
    setObserved(value: ObservedProcessIdentity | undefined) { observed = value }
  }
}

describe('ManagedProcessRegistry', () => {
  it('records complete launch identity and returns immutable snapshots', () => {
    const { registry } = harness()
    const entry = registry.register(registration)

    expect(entry).toMatchObject({
      id: `codex-cli:${registration.pid}:${registration.startedAtMs}`,
      ...registration,
      executablePath: resolve(registration.executablePath),
      cwd: resolve(registration.cwd),
      configDir: resolve(registration.configDir)
    })
    expect(Object.isFrozen(entry)).toBe(true)
    expect(registry.list('codex-cli')).toEqual([entry])
    expect(registry.list('gemini-cli')).toEqual([])
  })

  it('refuses to signal a reused PID when the start time differs', async () => {
    const { adapter, registry, setObserved } = harness()
    const entry = registry.register(registration)
    setObserved({ ...registration, startedAtMs: registration.startedAtMs + 1 })

    await expect(registry.close(entry.id)).resolves.toMatchObject({ status: 'identity-mismatch' })
    expect(adapter.closeGracefully).not.toHaveBeenCalled()
    expect(adapter.closeForced).not.toHaveBeenCalled()
    expect(registry.get(entry.id)).toBeUndefined()
  })

  it('compares executable paths case-insensitively on Windows', async () => {
    const { adapter, registry, setObserved } = harness()
    const entry = registry.register(registration)
    setObserved({
      pid: entry.pid,
      startedAtMs: entry.startedAtMs,
      executablePath: 'c:/tools/CODEX.EXE'
    })
    vi.mocked(adapter.closeGracefully).mockImplementation(async () => setObserved(undefined))

    await expect(registry.close(entry.id)).resolves.toMatchObject({ status: 'graceful' })
    expect(adapter.closeGracefully).toHaveBeenCalledOnce()
    expect(adapter.closeForced).not.toHaveBeenCalled()
  })

  it('escalates after the graceful timeout and removes the stopped process', async () => {
    const { adapter, registry } = harness()
    const entry = registry.register(registration)

    await expect(registry.close(entry.id)).resolves.toMatchObject({ status: 'forced' })
    expect(adapter.closeGracefully).toHaveBeenCalledOnce()
    expect(adapter.closeForced).toHaveBeenCalledOnce()
    expect(registry.get(entry.id)).toBeUndefined()
  })

  it('re-verifies and escalates when the graceful hook rejects', async () => {
    const { adapter, registry } = harness()
    vi.mocked(adapter.closeGracefully).mockRejectedValue(new Error('signal rejected'))
    const entry = registry.register(registration)

    await expect(registry.close(entry.id)).resolves.toMatchObject({ status: 'forced' })
    expect(adapter.closeForced).toHaveBeenCalledOnce()
    expect(registry.get(entry.id)).toBeUndefined()
  })

  it('rechecks identity before force-close and never signals a replacement process', async () => {
    const { adapter, registry } = harness()
    const entry = registry.register(registration)
    let inspections = 0
    vi.mocked(adapter.inspect).mockImplementation(async () => {
      inspections += 1
      if (inspections <= 6) return {
        pid: entry.pid,
        startedAtMs: entry.startedAtMs,
        executablePath: entry.executablePath
      }
      return {
        pid: entry.pid,
        startedAtMs: entry.startedAtMs + 10,
        executablePath: entry.executablePath
      }
    })
    await expect(registry.close(entry.id)).resolves.toMatchObject({ status: 'identity-mismatch' })
    expect(adapter.closeGracefully).toHaveBeenCalledOnce()
    expect(adapter.closeForced).not.toHaveBeenCalled()
  })

  it('coalesces concurrent close calls for the same registration', async () => {
    const { adapter, registry, setObserved } = harness()
    const entry = registry.register(registration)
    vi.mocked(adapter.closeGracefully).mockImplementation(async () => setObserved(undefined))

    const first = registry.close(entry.id)
    const second = registry.close(entry.id)
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ status: 'graceful' })
    expect(adapter.closeGracefully).toHaveBeenCalledOnce()
  })

  it('retains a process that remains alive after forced close', async () => {
    const { adapter, registry } = harness()
    vi.mocked(adapter.closeForced).mockResolvedValue(undefined)
    const entry = registry.register(registration)

    await expect(registry.close(entry.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Process remained alive after forced close'
    })
    expect(registry.get(entry.id)).toEqual(entry)
  })

  it('fails closed when process identity inspection errors', async () => {
    const { adapter, registry } = harness()
    vi.mocked(adapter.inspect).mockRejectedValue(new Error('inspection unavailable'))
    const entry = registry.register(registration)

    await expect(registry.close(entry.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'inspection unavailable'
    })
    expect(adapter.closeGracefully).not.toHaveBeenCalled()
    expect(adapter.closeForced).not.toHaveBeenCalled()
    expect(registry.get(entry.id)).toEqual(entry)
  })

  it('prunes exited and identity-mismatched records without sending signals', async () => {
    const { adapter, registry } = harness()
    const first = registry.register(registration)
    const second = registry.register({ ...registration, target: 'gemini-cli', pid: 4343 })
    vi.mocked(adapter.inspect).mockImplementation(async (pid) => {
      if (pid === first.pid) return undefined
      return { pid, startedAtMs: second.startedAtMs + 1, executablePath: second.executablePath }
    })

    const removed = await registry.pruneStale()
    expect(removed.map((entry: ManagedAgentProcess) => entry.id).sort()).toEqual([first.id, second.id].sort())
    expect(registry.list()).toEqual([])
    expect(adapter.closeGracefully).not.toHaveBeenCalled()
    expect(adapter.closeForced).not.toHaveBeenCalled()
  })
})
