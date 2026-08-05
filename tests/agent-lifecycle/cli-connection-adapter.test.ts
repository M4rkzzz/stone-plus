import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeCodeLifecycleAdapter,
  CliLifecycleOperationError,
  GeminiCliLifecycleAdapter,
  GrokBuildLifecycleAdapter,
  type CliConnectionConfigPort,
  type CliRuntimePort,
} from '../../src/main/agent-lifecycle/cli-connection-adapter'
import type { RepairClientConfigResult } from '../../src/main/client-config/types'

const connection = { gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'local-token' }

function repairResult(client: 'claude' | 'gemini' | 'grokbuild'): RepairClientConfigResult {
  return {
    client,
    changedFiles: [`/${client}/settings`],
    backups: [],
    removedBackups: [],
    rebuiltRoles: [],
  }
}

function harness(target: 'claude-code' | 'gemini-cli' | 'grok-build' = 'claude-code') {
  const events: string[] = []
  const client = target === 'claude-code' ? 'claude' : target === 'gemini-cli' ? 'gemini' : 'grokbuild'
  const runtime: CliRuntimePort = {
    snapshot: vi.fn(async () => ({
      managedInstances: [{ id: 'one', running: true }, { id: 'idle', running: false }],
      externalSessionDetected: true,
    })),
    closeManaged: vi.fn(async (id) => { events.push(`close:${id}`) }),
    startManaged: vi.fn(async (id) => { events.push(`restart:${id}`) }),
    startNew: vi.fn(async () => { events.push('start-new') }),
  }
  const config: CliConnectionConfigPort = {
    inspect: vi.fn(async () => ({ configured: true })),
    repair: vi.fn(async () => {
      events.push('repair')
      return repairResult(client)
    }),
    validate: vi.fn(async () => { events.push('validate') }),
    rollback: vi.fn(async () => { events.push('rollback') }),
  }
  const options = {
    installation: { inspect: vi.fn(async () => ({ installed: true, version: '1.2.3' })) },
    runtime,
    config,
  }
  const adapter = target === 'claude-code'
    ? new ClaudeCodeLifecycleAdapter(options)
    : target === 'gemini-cli'
      ? new GeminiCliLifecycleAdapter(options)
      : new GrokBuildLifecycleAdapter(options)
  return { adapter, client, config, events, runtime }
}

describe('connection-only CLI lifecycle adapters', () => {
  it.each([
    ['claude-code', 'claude'],
    ['gemini-cli', 'gemini'],
    ['grok-build', 'grokbuild'],
  ] as const)('declares honest capabilities for %s', async (target, client) => {
    const { adapter } = harness(target)
    const snapshot = await adapter.getSnapshot()

    expect(snapshot).toMatchObject({
      target,
      client,
      running: true,
      managedInstanceCount: 1,
      externalSessionDetected: true,
      processControl: 'managed-only',
    })
    expect(snapshot.capabilities).toMatchObject({
      canRestoreConnection: true,
      canRepairSessions: false,
      canRepairWorkspaceIndex: false,
    })
  })

  it('closes, repairs, validates and restores only previously running managed instances', async () => {
    const { adapter, config, events, runtime } = harness()

    const result = await adapter.restore(connection, { backupRetention: 7 })

    expect(events).toEqual(['close:one', 'repair', 'validate', 'restart:one'])
    expect(config.repair).toHaveBeenCalledWith('claude', connection, { backupRetention: 7 })
    expect(runtime.closeManaged).not.toHaveBeenCalledWith('idle')
    expect(result).toMatchObject({
      closedManagedInstanceIds: ['one'],
      restartedManagedInstanceIds: ['one'],
      externalSessionsUnaffected: true,
      pendingNewSession: true,
    })
  })

  it('keeps previously running managed instances stopped when preservation is disabled', async () => {
    const { adapter, events, runtime } = harness()

    const result = await adapter.restore(connection, {}, false)

    expect(events).toEqual(['close:one', 'repair', 'validate'])
    expect(runtime.startManaged).not.toHaveBeenCalled()
    expect(result.restartedManagedInstanceIds).toEqual([])
  })

  it('validates the effective Stone+ connection instead of trusting file presence', async () => {
    const { adapter, config } = harness()
    vi.mocked(config.validate).mockRejectedValueOnce(new Error('stale endpoint'))

    await expect(adapter.isConfiguredFor(connection)).resolves.toBe(false)
    await expect(adapter.isConfiguredFor(connection)).resolves.toBe(true)
  })

  it('rolls configuration back and restores managed instances when validation fails', async () => {
    const { adapter, config, events } = harness('gemini-cli')
    vi.mocked(config.validate).mockImplementationOnce(async () => {
      events.push('validate')
      throw new Error('endpoint mismatch')
    })

    await expect(adapter.restore(connection)).rejects.toMatchObject({
      name: 'CliLifecycleOperationError',
      target: 'gemini-cli',
      phase: 'validate',
    })
    expect(events).toEqual(['close:one', 'repair', 'validate', 'rollback', 'restart:one'])
  })

  it('reports rollback failures without losing the original validation failure', async () => {
    const { adapter, config } = harness()
    vi.mocked(config.validate).mockRejectedValueOnce(new Error('bad config'))
    vi.mocked(config.rollback).mockRejectedValueOnce(new Error('disk read-only'))

    const error = await adapter.restore(connection).catch((caught) => caught)

    expect(error).toBeInstanceOf(CliLifecycleOperationError)
    expect(error).toMatchObject({ phase: 'rollback' })
    expect(error.message).toContain('bad config')
    expect(error.recoveryErrors).toContain('configuration rollback: disk read-only')
  })

  it('classifies connection write failures as restore-connection errors', async () => {
    const { adapter, config } = harness()
    vi.mocked(config.repair).mockRejectedValueOnce(new Error('settings are read-only'))

    await expect(adapter.restore(connection)).rejects.toMatchObject({
      phase: 'restore-connection',
      message: expect.stringContaining('settings are read-only'),
    })
  })

  it('fails repair when a requested managed restart resolves without becoming running', async () => {
    const { adapter, runtime } = harness()
    vi.mocked(runtime.snapshot)
      .mockResolvedValueOnce({
        managedInstances: [{ id: 'one', running: true }],
        externalSessionDetected: false,
      })
      .mockResolvedValueOnce({
        managedInstances: [{ id: 'one', running: false }],
        externalSessionDetected: false,
      })

    await expect(adapter.restore(connection)).rejects.toMatchObject({
      phase: 'start',
      recoveryErrors: ['one: managed instance did not report running after restart'],
    })
  })

  it.each(['claude-code', 'gemini-cli', 'grok-build'] as const)(
    'repairs every running profile directory and restarts the same %s instances',
    async (target) => {
      const { adapter, config, runtime } = harness(target)
      vi.mocked(runtime.snapshot).mockResolvedValue({
        managedInstances: [
          { id: 'profile-a', running: true, configDirectory: '/profiles/a', profileId: 'a' },
          { id: 'profile-b', running: true, configDirectory: '/profiles/b', profileId: 'b' },
        ],
        externalSessionDetected: false,
      })

      const result = await adapter.restore(connection)

      expect(config.repair).toHaveBeenCalledTimes(2)
      expect(config.repair).toHaveBeenNthCalledWith(1, expect.any(String), connection, { configDirectory: '/profiles/a' })
      expect(config.repair).toHaveBeenNthCalledWith(2, expect.any(String), connection, { configDirectory: '/profiles/b' })
      expect(runtime.startManaged).toHaveBeenCalledWith('profile-a')
      expect(runtime.startManaged).toHaveBeenCalledWith('profile-b')
      expect(result.restartedManagedInstanceIds).toEqual(['profile-a', 'profile-b'])
    },
  )

  it('never asks the runtime to terminate an external session', async () => {
    const { adapter, runtime } = harness()
    const result = await adapter.close()

    expect(runtime.closeManaged).toHaveBeenCalledTimes(1)
    expect(result.externalSessionsUnaffected).toBe(true)
  })

  it('requires an installed and configured CLI before starting a new instance', async () => {
    const { adapter, config, runtime } = harness()
    vi.mocked(config.inspect).mockResolvedValueOnce({ configured: false })

    await expect(adapter.start({ workingDirectory: '/workspace' }))
      .rejects.toThrow('not configured for Stone+')
    expect(runtime.startNew).not.toHaveBeenCalled()
  })

  it('repairs and validates a stale connection before starting a managed CLI', async () => {
    const { adapter, config, events } = harness()
    vi.mocked(config.inspect).mockResolvedValueOnce({ configured: false })

    await adapter.start({ workingDirectory: '/workspace' }, connection)

    expect(events).toEqual(['repair', 'validate', 'start-new'])
    expect(config.repair).toHaveBeenCalledWith('claude', connection, {})
    expect(config.validate).toHaveBeenCalledWith('claude', connection, undefined)
  })

  it('serializes overlapping restore operations for one client state group', async () => {
    const { adapter, config, events } = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(config.repair).mockImplementationOnce(async () => {
      events.push('repair:first')
      await gate
      return repairResult('claude')
    })

    const first = adapter.restore(connection)
    const second = adapter.restore(connection)
    await vi.waitFor(() => expect(events).toContain('repair:first'))
    expect(events.filter((event) => event.startsWith('close:'))).toHaveLength(1)
    release()
    await Promise.all([first, second])
    expect(events.filter((event) => event.startsWith('close:'))).toHaveLength(2)
  })
})
