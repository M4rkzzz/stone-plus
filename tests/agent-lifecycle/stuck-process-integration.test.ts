import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClientInstanceManager,
  type ClientInstanceMetadataStore,
  type ClientInstanceProcess,
} from '../../src/main/client-instances/client-instance-manager'
import {
  ClaudeCodeLifecycleAdapter,
  type CliConnectionConfigPort,
  type CliRuntimePort,
} from '../../src/main/agent-lifecycle/cli-connection-adapter'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('stuck managed CLI lifecycle', () => {
  it('fails before repairing configuration when the managed process cannot be stopped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-stuck-cli-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'claude.exe')
    await writeFile(executable, '')

    const child = new EventEmitter() as ClientInstanceProcess & EventEmitter
    child.pid = 9191
    child.kill = () => true
    const manager = new ClientInstanceManager({
      store: new MemoryMetadataStore(),
      processAdapter: { spawn: () => child },
      stopTimeoutMs: 100,
    })
    manager.initialize()
    const [instance] = await manager.save({
      name: 'Stuck Claude',
      client: 'claude',
      configDirectory: directory,
      executablePath: executable,
      launchMode: 'background',
    })
    await manager.start(instance.id)

    const runtime: CliRuntimePort = {
      snapshot: async () => ({
        managedInstances: manager.list().map((item) => ({ id: item.id, running: item.processAlive === true })),
        externalSessionDetected: false,
      }),
      closeManaged: async (id) => { await manager.stop(id) },
      startManaged: async (id) => { await manager.start(id) },
      startNew: async () => undefined,
    }
    const config: CliConnectionConfigPort = {
      inspect: vi.fn(async () => ({ configured: true })),
      repair: vi.fn(),
      validate: vi.fn(),
      rollback: vi.fn(),
    }
    const adapter = new ClaudeCodeLifecycleAdapter({
      installation: { inspect: async () => ({ installed: true }) },
      runtime,
      config,
    })

    await expect(adapter.restore({ gatewayBaseUrl: 'http://127.0.0.1:15720', token: 'local-token' }))
      .rejects.toMatchObject({ phase: 'close' })
    expect(manager.list()[0]).toMatchObject({ status: 'failed', processAlive: true })
    expect(config.repair).not.toHaveBeenCalled()
    expect(config.validate).not.toHaveBeenCalled()
  }, 15_000)
})

class MemoryMetadataStore implements ClientInstanceMetadataStore {
  private readonly values = new Map<string, string>()

  readAppMetadata(key: string): string | undefined { return this.values.get(key) }
  async writeAppMetadata(key: string, value: string): Promise<void> { this.values.set(key, value) }
}
