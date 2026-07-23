import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClientInstanceManager,
  clientInstanceNodeSpawnOptions,
  type ClientInstanceProcess,
} from '../../src/main/client-instances'

const expectedDefaultLaunchMode = process.platform === 'win32' ? 'terminal' : 'background'

class MemoryMetadata {
  readonly values = new Map<string, string>()
  writes = 0
  failWrite?: number
  readAppMetadata(key: string): string | undefined { return this.values.get(key) }
  async writeAppMetadata(key: string, value: string): Promise<void> {
    this.writes += 1
    if (this.writes === this.failWrite) throw new Error('metadata unavailable')
    this.values.set(key, value)
  }
}

class HeldMetadata extends MemoryMetadata {
  holdWrite?: number
  private releaseHeldWrite?: () => void
  private heldWriteStarted?: () => void
  readonly heldStarted = new Promise<void>((resolve) => { this.heldWriteStarted = resolve })
  async writeAppMetadata(key: string, value: string): Promise<void> {
    this.writes += 1
    if (this.writes === this.holdWrite) {
      this.heldWriteStarted?.()
      await new Promise<void>((resolve) => { this.releaseHeldWrite = resolve })
    }
    this.values.set(key, value)
  }
  release(): void { this.releaseHeldWrite?.() }
}

class FakeProcess extends EventEmitter implements ClientInstanceProcess {
  pid = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

describe('ClientInstanceManager', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

  it('persists isolated instance definitions and manages an injected process without deleting directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'instance-config')
    const workingDirectory = join(root, 'project')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    await mkdir(workingDirectory)
    const metadata = new MemoryMetadata()
    const child = new FakeProcess()
    const spawn = vi.fn(() => child)
    const manager = new ClientInstanceManager({
      store: metadata,
      processAdapter: { spawn },
      baseEnvironment: {},
      resolveBinding: () => ({ env: { OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1' } }),
      now: () => 100
    })
    manager.initialize()
    let instances = await manager.save({
      name: 'Project Codex',
      client: 'codex',
      configDirectory,
      workingDirectory,
      executablePath: executable,
      launchArgs: ['--search'],
      routeId: 'route-codex',
      profileId: 'profile-codex'
    })
    const id = instances[0].id
    instances = await manager.start(id)
    expect(instances[0]).toMatchObject({
      status: 'running',
      pid: 4242,
      launchMode: expectedDefaultLaunchMode,
      processAlive: true
    })
    expect(spawn).toHaveBeenCalledWith(executable, ['--search'], expect.objectContaining({
      cwd: workingDirectory,
      env: expect.objectContaining({ CODEX_HOME: configDirectory, OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1' }),
      launchMode: expectedDefaultLaunchMode
    }))
    await manager.stop(id)
    await vi.waitFor(() => expect(manager.list()[0].status).toBe('stopped'))
    await manager.delete(id)
    expect(await stat(configDirectory)).toMatchObject({})

    const restarted = new ClientInstanceManager({ store: metadata })
    expect(restarted.initialize()).toEqual([])
  })

  it('forces a bounded stop when a child never emits exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-stuck-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const child = new EventEmitter() as unknown as ClientInstanceProcess & EventEmitter
    child.pid = 9191
    child.kill = (signal) => { signals.push(signal); return true }
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn: () => child },
      stopTimeoutMs: 100
    })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Stuck', client: 'codex', configDirectory, executablePath: executable })
    await manager.start(instance.id)
    const stopped = await manager.stop(instance.id)

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stopped[0]).toMatchObject({
      status: 'failed',
      pid: 9191,
      processAlive: true,
      stopError: 'Client process did not exit after forced termination.'
    })
  })

  it('keeps legacy definitions in background mode while new instances use the platform-safe default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-legacy-'))
    directories.push(root)
    const metadata = new MemoryMetadata()
    metadata.values.set('managed_client_instances_v1', JSON.stringify([{
      id: 'legacy', name: 'Legacy', client: 'codex', configDirectory: root,
      launchArgs: [], status: 'stopped', createdAt: 1, updatedAt: 1
    }]))
    const manager = new ClientInstanceManager({ store: metadata })
    expect(manager.initialize()[0].launchMode).toBe('background')
    const created = await manager.save({ name: 'New', client: 'codex', configDirectory: root })
    expect(created.find((item) => item.name === 'New')?.launchMode).toBe(expectedDefaultLaunchMode)
  })

  it('coalesces concurrent starts and ignores renderer listener failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-concurrent-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const child = new FakeProcess()
    const spawn = vi.fn(() => child)
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn },
    })
    manager.initialize()
    manager.onChange(() => { throw new Error('renderer disappeared') })
    const [instance] = await manager.save({ name: 'Concurrent', client: 'codex', configDirectory, executablePath: executable })

    const [left, right] = await Promise.all([manager.start(instance.id), manager.start(instance.id)])

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(left[0]).toMatchObject({ status: 'running', pid: 4242, processAlive: true })
    expect(right[0]).toMatchObject({ status: 'running', pid: 4242, processAlive: true })
    await manager.stop(instance.id)
  })

  it('terminates a spawned process when its running state cannot be persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-persist-failure-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const metadata = new MemoryMetadata()
    const child = new FakeProcess()
    const manager = new ClientInstanceManager({
      store: metadata,
      processAdapter: { spawn: () => child },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Persist failure', client: 'codex', configDirectory, executablePath: executable })
    // save() is write 1; starting is write 2; persisting the spawned PID is write 3.
    metadata.failWrite = 3

    await expect(manager.start(instance.id)).rejects.toThrow('metadata unavailable')

    expect(child.killed).toBe(true)
    expect(manager.list()[0]).toMatchObject({ status: 'failed', processAlive: false })
  })

  it('does not leave an instance in starting when the pre-spawn state cannot be persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-starting-failure-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const metadata = new MemoryMetadata()
    const spawn = vi.fn(() => new FakeProcess())
    const manager = new ClientInstanceManager({ store: metadata, processAdapter: { spawn } })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Starting failure', client: 'codex', configDirectory, executablePath: executable })
    metadata.failWrite = 2

    await expect(manager.start(instance.id)).rejects.toThrow('metadata unavailable')

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ status: 'failed', processAlive: false })
  })

  it('continues to forced tree termination when the graceful kill throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-kill-throw-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const child = new EventEmitter() as unknown as ClientInstanceProcess & EventEmitter
    child.pid = 5252
    child.kill = () => { throw new Error('signal failed') }
    const terminateTree = vi.fn(async () => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')) })
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn: () => child, terminateTree },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Kill throw', client: 'codex', configDirectory, executablePath: executable })
    await manager.start(instance.id)

    await manager.stop(instance.id)

    expect(terminateTree).toHaveBeenCalledOnce()
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
  })

  it('does not treat a child error as proof that a live process exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-error-alive-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const child = new EventEmitter() as unknown as ClientInstanceProcess & EventEmitter
    child.pid = 6262
    child.kill = () => true
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: {
        spawn: () => child,
        isAlive: async () => true,
        terminateTree: async () => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')) },
      },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Error alive', client: 'codex', configDirectory, executablePath: executable })
    await manager.start(instance.id)
    child.emit('error', new Error('temporary process error'))
    await vi.waitFor(() => expect(manager.list()[0]).toMatchObject({ status: 'failed', processAlive: true }))

    await manager.stop(instance.id)
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
  })

  it('never detaches a POSIX terminal launch into a silent background process', () => {
    expect(clientInstanceNodeSpawnOptions('linux', 'terminal', true)).toEqual({
      windowsHide: false,
      detached: false,
      stdio: 'inherit',
    })
    expect(() => clientInstanceNodeSpawnOptions('darwin', 'terminal', false))
      .toThrow('requires Stone+ to run from a controlling terminal')
    expect(clientInstanceNodeSpawnOptions('linux', 'background', false)).toEqual({
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
    })
    expect(clientInstanceNodeSpawnOptions('win32', 'terminal', false)).toEqual({
      windowsHide: false,
      detached: true,
      stdio: 'inherit',
    })
  })

  it('rejects a new unavailable POSIX terminal mode at save and a legacy one at start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-posix-terminal-'))
    directories.push(root)
    const executable = join(root, 'codex')
    await writeFile(executable, '')
    const metadata = new MemoryMetadata()
    const spawn = vi.fn(() => new FakeProcess())
    const manager = new ClientInstanceManager({
      store: metadata,
      processAdapter: { spawn },
      platform: 'linux',
      hasControllingTerminal: () => false,
    })
    manager.initialize()

    await expect(manager.save({
      name: 'Unsupported terminal', client: 'codex', configDirectory: root,
      executablePath: executable, launchMode: 'terminal',
    })).rejects.toThrow('no controlling terminal')

    metadata.values.set('managed_client_instances_v1', JSON.stringify([{
      id: 'legacy-terminal', name: 'Legacy terminal', client: 'codex', configDirectory: root,
      executablePath: executable, launchArgs: [], launchMode: 'terminal', status: 'stopped',
      createdAt: 1, updatedAt: 1,
    }]))
    manager.initialize()
    await expect(manager.start('legacy-terminal')).rejects.toThrow('no controlling terminal')
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
  })

  it('validates one immutable launch plan before changing state or spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-launch-plan-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const spawn = vi.fn(() => new FakeProcess())
    const validateLaunchPlan = vi.fn(async (plan) => {
      expect(Object.isFrozen(plan)).toBe(true)
      expect(Object.isFrozen(plan.args)).toBe(true)
      expect(Object.isFrozen(plan.env)).toBe(true)
      expect(plan).toMatchObject({
        executable,
        args: ['--search'],
        env: expect.objectContaining({ CODEX_HOME: configDirectory, OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1' }),
        launchMode: 'background',
      })
      throw new Error('Gateway is not listening.')
    })
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn },
      baseEnvironment: {},
      resolveBinding: () => ({ env: { OPENAI_BASE_URL: 'http://127.0.0.1:15721/v1' } }),
      validateLaunchPlan,
    })
    manager.initialize()
    const [instance] = await manager.save({
      name: 'Validated', client: 'codex', configDirectory, executablePath: executable,
      launchArgs: ['--search'], launchMode: 'background',
    })

    await expect(manager.start(instance.id)).rejects.toThrow('Gateway is not listening')

    expect(validateLaunchPlan).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
  })

  it('reports every process that remains alive after stopAll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-stop-all-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    await writeFile(executable, '')
    const child = new EventEmitter() as unknown as ClientInstanceProcess & EventEmitter
    child.pid = 8181
    child.kill = () => true
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn: () => child, isAlive: async () => true },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({
      name: 'Still running', client: 'codex', configDirectory: root,
      executablePath: executable, launchMode: 'background',
    })
    await manager.start(instance.id)

    const summary = await manager.stopAll()

    expect(summary.stopped).toEqual([])
    expect(summary.stillRunning).toEqual([{
      id: instance.id,
      pid: 8181,
      error: 'Client process did not exit after forced termination.',
    }])
  })

  it('cancels a pending start during stopAll and never spawns after shutdown begins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-shutdown-start-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    await writeFile(executable, '')
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve })
    const validateLaunchPlan = vi.fn(() => validationGate)
    const spawn = vi.fn(() => new FakeProcess())
    const manager = new ClientInstanceManager({
      store: new MemoryMetadata(),
      processAdapter: { spawn },
      validateLaunchPlan,
    })
    manager.initialize()
    const [instance] = await manager.save({
      name: 'Pending start', client: 'codex', configDirectory: root,
      executablePath: executable, launchMode: 'background',
    })
    const startOutcome = manager.start(instance.id).then(
      () => ({ status: 'started' as const }),
      (error: unknown) => ({ status: 'cancelled' as const, error }),
    )
    await vi.waitFor(() => expect(validateLaunchPlan).toHaveBeenCalledOnce())

    const stopping = manager.stopAll()
    const startSettledBeforeRelease = await Promise.race([
      startOutcome.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ])
    releaseValidation()
    const [outcome, summary] = await Promise.all([startOutcome, stopping])
    if (manager.list()[0]?.processAlive) await manager.stop(instance.id)

    expect(startSettledBeforeRelease).toBe(true)
    expect(outcome).toMatchObject({ status: 'cancelled' })
    expect(summary).toEqual({ stopped: [instance.id], stillRunning: [] })
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })
    await expect(manager.start(instance.id)).rejects.toThrow(/shutting down/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills a spawned client and bounds shutdown while its running-state persist is stuck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-shutdown-persist-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    await writeFile(executable, '')
    const metadata = new HeldMetadata()
    const child = new FakeProcess()
    child.pid = 7373
    const spawn = vi.fn(() => child)
    const manager = new ClientInstanceManager({
      store: metadata,
      processAdapter: { spawn },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({
      name: 'Persisting start', client: 'codex', configDirectory: root,
      executablePath: executable, launchMode: 'background',
    })
    // save=1, starting=2, running=3. Hold the post-spawn durability write.
    metadata.holdWrite = 3
    const startOutcome = manager.start(instance.id).then(
      () => ({ status: 'started' as const }),
      (error: unknown) => ({ status: 'cancelled' as const, error }),
    )
    await metadata.heldStarted
    expect(spawn).toHaveBeenCalledOnce()
    expect(manager.list()[0]).toMatchObject({ status: 'running', pid: 7373, processAlive: true })

    const stopping = manager.stopAll()
    const bounded = await Promise.race([
      Promise.all([startOutcome, stopping]).then(([start, summary]) => ({ settled: true as const, start, summary })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 1_500)),
    ])

    expect(bounded).toMatchObject({
      settled: true,
      start: { status: 'cancelled' },
      summary: { stopped: [instance.id], stillRunning: [] },
    })
    expect(child.killed).toBe(true)
    expect(manager.list()[0]).toMatchObject({ status: 'stopped', processAlive: false })

    metadata.release()
    await vi.waitFor(() => {
      expect(JSON.parse(metadata.values.get('managed_client_instances_v1')!)[0]).toMatchObject({ status: 'stopped' })
    })
  })

  it('finishes an exiting generation before a concurrent restart can persist the next one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-client-instance-generation-'))
    directories.push(root)
    const executable = join(root, 'codex.exe')
    const configDirectory = join(root, 'config')
    await writeFile(executable, '')
    await mkdir(configDirectory)
    const metadata = new HeldMetadata()
    const first = new FakeProcess()
    first.pid = 7001
    const second = new FakeProcess()
    second.pid = 7002
    const spawn = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const manager = new ClientInstanceManager({
      store: metadata,
      processAdapter: { spawn, isAlive: async () => true },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({ name: 'Generations', client: 'codex', configDirectory, executablePath: executable })
    await manager.start(instance.id)
    // save=1, starting=2, running=3, stopping=4, exit finalization=5.
    metadata.holdWrite = 5

    const stopping = manager.stop(instance.id)
    await metadata.heldStarted
    const restarting = manager.start(instance.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawn).toHaveBeenCalledTimes(1)

    metadata.release()
    await stopping
    const restarted = await restarting
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(restarted[0]).toMatchObject({ status: 'running', pid: 7002, processAlive: true })

    // The old child's remaining error listener must not mutate generation 2.
    first.emit('error', new Error('late generation-one error'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.list()[0]).toMatchObject({ status: 'running', pid: 7002, processAlive: true })
    expect(JSON.parse(metadata.values.get('managed_client_instances_v1')!)[0]).toMatchObject({ status: 'running' })
    await manager.stop(instance.id)
  })
})
