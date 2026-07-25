import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientInstanceManager, type ClientInstanceMetadataStore } from '../../src/main/client-instances'
import {
  ClaudeCodeLifecycleAdapter,
  GeminiCliLifecycleAdapter,
  GrokBuildLifecycleAdapter,
  type CliConnectionConfigPort,
  type CliRuntimePort,
} from '../../src/main/agent-lifecycle/cli-connection-adapter'
import {
  CodexLifecycleAdapter,
  type CodexCliPort,
} from '../../src/main/agent-lifecycle/codex-adapter'
import type { ChatGptDesktopController } from '../../src/main/codex'
import type {
  ClientConnectionTarget,
  RepairClientConfigResult,
  SupportedClient,
} from '../../src/main/client-config/types'
import type { RouteClient } from '../../src/shared/types'

const roots: string[] = []
const managers: ClientInstanceManager[] = []

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed client OS lifecycle', () => {
  it('starts, observes, closes, repairs, and restarts isolated fake processes for all four clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stone-managed-client-os-'))
    roots.push(root)
    const logPath = join(root, 'fake-client.jsonl')
    const fakeClient = join(root, 'fake-client.cjs')
    await writeFile(fakeClient, fakeClientSource(), 'utf8')

    const manager = new ClientInstanceManager({ store: new MemoryMetadata() })
    managers.push(manager)
    manager.initialize()

    const clients = ['claude', 'codex', 'gemini', 'grokbuild'] as const
    const instanceIds = new Map<RouteClient, string>()
    for (const client of clients) {
      const profile = join(root, 'profiles', client)
      const saved = await manager.save({
        name: `Fake ${client}`,
        client,
        configDirectory: profile,
        executablePath: process.execPath,
        launchArgs: [fakeClient, client, logPath],
        launchMode: 'background',
      })
      instanceIds.set(client, saved.find((item) => item.client === client)!.id)
    }

    await Promise.all([...instanceIds.values()].map((id) => manager.start(id)))
    const firstGeneration = runningPids(manager, instanceIds)
    expect([...firstGeneration.values()].every(pidIsAlive)).toBe(true)
    await waitForStarts(logPath, clients, 1)

    await Promise.all([...instanceIds.values()].map((id) => manager.stop(id)))
    expect([...firstGeneration.values()].every((pid) => !pidIsAlive(pid))).toBe(true)
    expect(manager.list().every((instance) => instance.status === 'stopped' && !instance.processAlive)).toBe(true)

    await Promise.all([...instanceIds.values()].map((id) => manager.start(id)))
    const beforeRepair = runningPids(manager, instanceIds)
    expect([...beforeRepair.values()].every((pid, index) => pid !== [...firstGeneration.values()][index])).toBe(true)

    const config = new FakeConnectionPort(root)
    const runtime = runtimePort(manager)
    const adapters = {
      claude: new ClaudeCodeLifecycleAdapter({ installation: installed(), runtime, config }),
      codex: codexAdapter(manager, config),
      gemini: new GeminiCliLifecycleAdapter({ installation: installed(), runtime, config }),
      grokbuild: new GrokBuildLifecycleAdapter({ installation: installed(), runtime, config }),
    }

    const connection = { gatewayBaseUrl: 'http://127.0.0.1:15721', token: 'fake-local-token' }
    const restoreResults = await Promise.all([
      adapters.claude.restore(connection),
      adapters.codex.restore({ repairSessions: false, repairWorkspaceIndex: false }),
      adapters.gemini.restore(connection),
      adapters.grokbuild.restore(connection),
    ])
    const afterRepair = runningPids(manager, instanceIds)

    for (const client of clients) {
      expect(pidIsAlive(afterRepair.get(client)!)).toBe(true)
      expect(afterRepair.get(client)).not.toBe(beforeRepair.get(client))
      expect(pidIsAlive(beforeRepair.get(client)!)).toBe(false)
    }
    expect(restoreResults.every((result) => result.restartedManagedInstanceIds.length === 1)).toBe(true)
    await waitForStarts(logPath, clients, 3)

    const records = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as FakeClientRecord)
    for (const client of clients) {
      const starts = records.filter((record) => record.client === client && record.event === 'start')
      expect(starts).toHaveLength(3)
      expect(new Set(starts.map((record) => record.pid)).size).toBe(3)
      expect(starts.every((record) => record.configDirectory === join(root, 'profiles', client))).toBe(true)
      expect(await readFile(join(root, 'repairs', `${client}.txt`), 'utf8')).toBe('fake-local-token')
    }

    await Promise.all([...instanceIds.values()].map((id) => manager.stop(id)))
    expect([...afterRepair.values()].every((pid) => !pidIsAlive(pid))).toBe(true)
  }, 30_000)
})

class MemoryMetadata implements ClientInstanceMetadataStore {
  private readonly values = new Map<string, string>()
  readAppMetadata(key: string): string | undefined { return this.values.get(key) }
  async writeAppMetadata(key: string, value: string): Promise<void> { this.values.set(key, value) }
}

class FakeConnectionPort implements CliConnectionConfigPort {
  constructor(private readonly root: string) {}
  async inspect() { return { configured: true } }
  async repair(client: SupportedClient, connection: ClientConnectionTarget): Promise<RepairClientConfigResult> {
    await mkdir(join(this.root, 'repairs'), { recursive: true })
    const path = join(this.root, 'repairs', `${client}.txt`)
    await writeFile(path, connection.token, 'utf8')
    return { client, changedFiles: [path], backups: [], removedBackups: [], rebuiltRoles: [] }
  }
  async validate(client: SupportedClient, _target: ClientConnectionTarget): Promise<void> {
    await readFile(join(this.root, 'repairs', `${client}.txt`), 'utf8')
  }
  async rollback(_client: SupportedClient, _repair: RepairClientConfigResult): Promise<void> {}
}

function runtimePort(manager: ClientInstanceManager): CliRuntimePort {
  return {
    snapshot: async (client) => ({
      managedInstances: manager.list().filter((item) => item.client === client).map((item) => ({
        id: item.id,
        running: item.status === 'running' && item.processAlive === true,
      })),
      externalSessionDetected: false,
    }),
    closeManaged: async (id) => { await manager.stop(id) },
    startManaged: async (id) => { await manager.start(id) },
    startNew: async () => undefined,
  }
}

function codexAdapter(manager: ClientInstanceManager, config: FakeConnectionPort) {
  const cli: CodexCliPort = {
    inspect: async () => ({
      installation: { installed: true, executablePath: process.execPath },
      configured: true,
      managedInstances: manager.list().filter((item) => item.client === 'codex').map((item) => ({
        id: item.id,
        running: item.status === 'running' && item.processAlive === true,
      })),
      externalSessionDetected: false,
    }),
    closeManaged: async (id) => { await manager.stop(id) },
    restartManaged: async (id) => { await manager.start(id) },
    startNew: async () => undefined,
    restoreConnection: async () => { await config.repair('codex', { token: 'fake-local-token' }) },
    validateConnection: async () => { await config.validate('codex') },
  }
  const desktop: ChatGptDesktopController = {
    shutdownForRepair: vi.fn(async () => ({ wasRunning: false })),
    relaunch: vi.fn(async () => undefined),
  }
  return new CodexLifecycleAdapter({
    target: 'codex-cli',
    desktop,
    desktopProbe: { inspect: async () => ({ installed: false, configured: false, running: false }) },
    deepRepair: { run: vi.fn(async () => undefined) },
    cli,
  })
}

function installed() { return { inspect: async () => ({ installed: true, executablePath: process.execPath }) } }

function runningPids(manager: ClientInstanceManager, ids: ReadonlyMap<RouteClient, string>): Map<RouteClient, number> {
  return new Map([...ids].map(([client, id]) => {
    const instance = manager.list().find((item) => item.id === id)
    expect(instance).toMatchObject({ status: 'running', processAlive: true })
    expect(instance?.pid).toEqual(expect.any(Number))
    return [client, instance!.pid!]
  }))
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForStarts(logPath: string, clients: readonly RouteClient[], generations: number): Promise<void> {
  await vi.waitFor(async () => {
    const contents = await readFile(logPath, 'utf8').catch(() => '')
    const records = contents.trim() ? contents.trim().split(/\r?\n/).map((line) => JSON.parse(line) as FakeClientRecord) : []
    for (const client of clients) {
      expect(records.filter((record) => record.client === client && record.event === 'start')).toHaveLength(generations)
    }
  }, { timeout: 10_000, interval: 50 })
}

interface FakeClientRecord {
  event: 'start'
  client: RouteClient
  pid: number
  configDirectory?: string
}

function fakeClientSource(): string {
  return String.raw`const { appendFileSync } = require('node:fs')
const [client, logPath] = process.argv.slice(2)
const keys = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', gemini: 'GEMINI_CLI_HOME', grokbuild: 'GROK_HOME' }
appendFileSync(logPath, JSON.stringify({ event: 'start', client, pid: process.pid, configDirectory: process.env[keys[client]] }) + '\n')
setInterval(() => {}, 1000)
`
}
