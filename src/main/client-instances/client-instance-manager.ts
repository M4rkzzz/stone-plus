import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ManagedClientInstance, ManagedClientInstanceInput, ManagedClientLaunchMode, RouteClient } from '@shared/types'

const METADATA_KEY = 'managed_client_instances_v1'

export interface ClientInstanceMetadataStore {
  readAppMetadata(key: string): string | undefined
  writeAppMetadata(key: string, value: string): Promise<void>
}

export interface ClientInstanceProcess {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface ClientInstanceProcessAdapter {
  spawn(executable: string, args: readonly string[], options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    launchMode: ManagedClientLaunchMode
  }): ClientInstanceProcess
  terminateTree?(child: ClientInstanceProcess): Promise<void>
  isAlive?(child: ClientInstanceProcess): Promise<boolean>
}

export interface ClientInstanceLaunchBinding {
  env?: NodeJS.ProcessEnv
}

export interface ClientInstanceManagerOptions {
  store: ClientInstanceMetadataStore
  processAdapter?: ClientInstanceProcessAdapter
  resolveBinding?: (instance: ManagedClientInstance) => ClientInstanceLaunchBinding
  baseEnvironment?: NodeJS.ProcessEnv
  now?: () => number
  stopTimeoutMs?: number
}

interface RunningInstance {
  child: ClientInstanceProcess
  startedAt: number
  generation: number
  exit: Promise<ProcessExit>
  finalized: Promise<void>
}

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export class ClientInstanceManager {
  private definitions: ManagedClientInstance[] = []
  private readonly running = new Map<string, RunningInstance>()
  private readonly listeners = new Set<(instances: ManagedClientInstance[]) => void>()
  private readonly startFlights = new Map<string, Promise<ManagedClientInstance[]>>()
  private readonly stopFlights = new Map<string, Promise<ManagedClientInstance[]>>()
  private readonly processAdapter: ClientInstanceProcessAdapter
  private readonly now: () => number
  private readonly stopTimeoutMs: number
  private nextGeneration = 0
  private persistenceTail: Promise<void> = Promise.resolve()

  public constructor(private readonly options: ClientInstanceManagerOptions) {
    this.processAdapter = options.processAdapter ?? new NodeClientInstanceProcessAdapter()
    this.now = options.now ?? (() => Date.now())
    this.stopTimeoutMs = Math.max(100, Math.min(30_000, options.stopTimeoutMs ?? 5_000))
  }

  public initialize(): ManagedClientInstance[] {
    this.definitions = parseDefinitions(this.options.store.readAppMetadata(METADATA_KEY))
      .map((instance) => ({ ...instance, status: 'stopped', pid: undefined }))
    return this.list()
  }

  public list(): ManagedClientInstance[] {
    return this.definitions.map((definition) => {
      const active = this.running.get(definition.id)
      return structuredClone(active
        ? {
            ...definition,
            status: definition.status === 'stopping' || definition.status === 'failed' ? definition.status : 'running',
            pid: active.child.pid,
            processAlive: true
          }
        : { ...definition, processAlive: false })
    })
  }

  public onChange(listener: (instances: ManagedClientInstance[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async save(input: ManagedClientInstanceInput): Promise<ManagedClientInstance[]> {
    const existing = input.id ? this.definitions.find((candidate) => candidate.id === input.id) : undefined
    if (input.id && !existing) throw new Error('Managed client instance not found.')
    if (existing && (this.startFlights.has(existing.id) || this.stopFlights.has(existing.id))) {
      throw new Error('Wait for the client instance lifecycle operation to finish before editing it.')
    }
    if (existing && this.running.has(existing.id)) throw new Error('Stop the client instance before editing it.')
    const timestamp = this.now()
    const definition: ManagedClientInstance = {
      id: existing?.id ?? randomUUID(),
      name: requiredName(input.name),
      client: supportedClient(input.client),
      configDirectory: requiredAbsolutePath(input.configDirectory, 'Configuration directory'),
      workingDirectory: optionalAbsolutePath(input.workingDirectory, 'Working directory'),
      executablePath: optionalAbsolutePath(input.executablePath, 'Executable path'),
      launchArgs: normalizeArgs(input.launchArgs),
      // A packaged POSIX desktop process normally has no controlling TTY. Do
      // not make the default instance unlaunchable there until an external
      // terminal adapter is available; Windows keeps the visible-console
      // default, while explicit user choices are always preserved.
      launchMode: launchMode(input.launchMode ?? existing?.launchMode ?? defaultLaunchMode()),
      routeId: optionalIdentifier(input.routeId),
      profileId: optionalIdentifier(input.profileId),
      status: 'stopped',
      lastStartedAt: existing?.lastStartedAt,
      lastStoppedAt: existing?.lastStoppedAt,
      lastError: undefined,
      stopError: undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    if (existing) this.definitions = this.definitions.map((candidate) => candidate.id === existing.id ? definition : candidate)
    else this.definitions.push(definition)
    await this.persist()
    return this.list()
  }

  public async delete(id: string): Promise<ManagedClientInstance[]> {
    if (this.startFlights.has(id) || this.stopFlights.has(id)) {
      throw new Error('Wait for the client instance lifecycle operation to finish before deleting it.')
    }
    if (this.running.has(id)) throw new Error('Stop the client instance before deleting it.')
    if (!this.definitions.some((candidate) => candidate.id === id)) throw new Error('Managed client instance not found.')
    // Only the Stone+ definition is removed. External config/work directories
    // are intentionally never touched.
    this.definitions = this.definitions.filter((candidate) => candidate.id !== id)
    await this.persist()
    return this.list()
  }

  public start(id: string): Promise<ManagedClientInstance[]> {
    const existing = this.startFlights.get(id)
    if (existing) return existing
    const flight = this.startInternal(id).finally(() => {
      if (this.startFlights.get(id) === flight) this.startFlights.delete(id)
    })
    this.startFlights.set(id, flight)
    return flight
  }

  private async startInternal(id: string): Promise<ManagedClientInstance[]> {
    const stopping = this.stopFlights.get(id)
    if (stopping) await stopping
    if (this.running.has(id)) return this.list()
    const instance = this.required(id)
    if (!instance.executablePath) throw new Error('Choose an executable before starting this instance.')
    await assertFile(instance.executablePath, 'Client executable')
    if (instance.workingDirectory) await assertDirectory(instance.workingDirectory, 'Working directory')
    await mkdir(instance.configDirectory, { recursive: true })
    await assertDirectory(instance.configDirectory, 'Configuration directory')
    const timestamp = this.now()
    this.replace({ ...instance, status: 'starting', lastError: undefined, updatedAt: timestamp })
    let launched: RunningInstance | undefined
    try {
      await this.persist()
      const child = this.processAdapter.spawn(instance.executablePath, instance.launchArgs, {
        cwd: instance.workingDirectory,
        env: {
          ...(this.options.baseEnvironment ?? process.env),
          ...configDirectoryEnvironment(instance.client, instance.configDirectory),
          ...(this.options.resolveBinding?.(instance).env ?? {})
        },
        launchMode: instance.launchMode
      })
      const generation = ++this.nextGeneration
      launched = this.trackRunning(id, generation, child, timestamp)
      // A defensive adapter may synchronously report a launch failure while
      // the listeners are installed. Never resurrect that completed
      // generation as running.
      if (!this.isCurrent(id, generation)) {
        await launched.finalized
        return this.list()
      }
      this.replace({ ...this.required(id), status: 'running', pid: child.pid, lastStartedAt: timestamp, updatedAt: timestamp })
      await this.persist()
      return this.list()
    } catch (error) {
      if (launched && this.isCurrent(id, launched.generation)) {
        const stopped = await this.terminateRunning(launched)
        if (stopped && this.isCurrent(id, launched.generation)) this.running.delete(id)
      }
      const stillRunning = launched && this.isCurrent(id, launched.generation)
      this.replace({
        ...this.required(id),
        status: 'failed',
        pid: stillRunning ? launched?.child.pid : undefined,
        processAlive: Boolean(stillRunning),
        lastError: errorMessage(error),
        stopError: stillRunning ? 'Client process could not be stopped after its launch state failed to persist.' : undefined,
        lastStoppedAt: this.now(),
        updatedAt: this.now()
      })
      await this.persist().catch(() => undefined)
      throw error
    }
  }

  public stop(id: string): Promise<ManagedClientInstance[]> {
    const existing = this.stopFlights.get(id)
    if (existing) return existing
    const flight = this.stopInternal(id).finally(() => {
      if (this.stopFlights.get(id) === flight) this.stopFlights.delete(id)
    })
    this.stopFlights.set(id, flight)
    return flight
  }

  private async stopInternal(id: string): Promise<ManagedClientInstance[]> {
    const starting = this.startFlights.get(id)
    if (starting) await starting.catch(() => undefined)
    const instance = this.required(id)
    const active = this.running.get(id)
    if (!active) {
      if (instance.status !== 'stopped') {
        this.replace({ ...instance, status: 'stopped', pid: undefined, updatedAt: this.now() })
        await this.persist()
      }
      return this.list()
    }
    this.replace({ ...instance, status: 'stopping', updatedAt: this.now() })
    await this.persist()
    let graceful = false
    try {
      active.child.kill('SIGTERM')
      graceful = await waitForExit(active.exit, this.stopTimeoutMs)
    } catch {
      // A failed graceful signal does not prove exit; continue to tree termination.
    }
    if (graceful) await active.finalized
    if (!graceful && this.isCurrent(id, active.generation)) {
      try {
        if (this.processAdapter.terminateTree) await this.processAdapter.terminateTree(active.child)
        else active.child.kill('SIGKILL')
      } catch (error) {
        const message = errorMessage(error)
        this.replace({
          ...this.required(id), status: 'failed', pid: active.child.pid, processAlive: true,
          stopError: message, lastError: message, updatedAt: this.now()
        })
        await this.persist()
        return this.list()
      }
      const forcedExit = await waitForExit(active.exit, Math.min(1_000, this.stopTimeoutMs))
      if (forcedExit) await active.finalized
      if (!forcedExit && this.isCurrent(id, active.generation)) {
        const error = new Error('Client process did not exit after forced termination.')
        this.replace({
          ...this.required(id),
          status: 'failed',
          pid: active.child.pid,
          processAlive: true,
          stopError: error.message,
          lastError: error.message,
          updatedAt: this.now()
        })
        await this.persist()
      }
    }
    return this.list()
  }

  public async stopAll(): Promise<{
    stopped: string[]
    stillRunning: Array<{ id: string; pid?: number; error?: string }>
  }> {
    const ids = [...this.running.keys()]
    await Promise.all(ids.map((id) => this.stop(id).catch(() => undefined)))
    const stillRunning = ids.flatMap((id) => {
      const active = this.running.get(id)
      const instance = this.definitions.find((candidate) => candidate.id === id)
      return active ? [{ id, pid: active.child.pid, error: instance?.stopError ?? instance?.lastError }] : []
    })
    const runningIds = new Set(stillRunning.map((item) => item.id))
    return { stopped: ids.filter((id) => !runningIds.has(id)), stillRunning }
  }

  private trackRunning(
    id: string,
    generation: number,
    child: ClientInstanceProcess,
    startedAt: number,
  ): RunningInstance {
    let resolveExit!: (outcome: ProcessExit) => void
    let resolveFinalized!: () => void
    const exit = new Promise<ProcessExit>((resolve) => { resolveExit = resolve })
    const finalized = new Promise<void>((resolve) => { resolveFinalized = resolve })
    const active: RunningInstance = { child, startedAt, generation, exit, finalized }
    this.running.set(id, active)
    this.observeExit(id, generation, child, resolveExit, resolveFinalized)
    return active
  }

  private observeExit(
    id: string,
    generation: number,
    child: ClientInstanceProcess,
    resolveExit: (outcome: ProcessExit) => void,
    resolveFinalized: () => void,
  ): void {
      let settled = false
      const finish = (outcome: ProcessExit): void => {
        if (settled) return
        settled = true
        resolveExit(outcome)
        void this.handleExit(id, generation, outcome)
          .catch(() => undefined)
          .finally(resolveFinalized)
      }
      child.once('exit', (code, signal) => finish({ code, signal }))
      child.once('error', (error) => {
        void this.confirmAlive(child).then((alive) => {
          if (!alive) finish({ code: null, signal: null, error })
          else return this.recordProcessError(id, generation, error)
        }).catch(() => this.recordProcessError(id, generation, error))
      })
  }

  private async recordProcessError(id: string, generation: number, error: Error): Promise<void> {
    if (!this.isCurrent(id, generation)) return
    const instance = this.definitions.find((candidate) => candidate.id === id)
    if (!instance) return
    const message = errorMessage(error)
    this.replace({
      ...instance,
      status: 'failed',
      processAlive: true,
      lastError: message,
      stopError: instance.status === 'stopping' ? message : instance.stopError,
      updatedAt: this.now()
    })
    await this.persist().catch(() => undefined)
  }

  private async confirmAlive(child: ClientInstanceProcess): Promise<boolean> {
    if (this.processAdapter.isAlive) return this.processAdapter.isAlive(child)
    // An adapter without a liveness probe must retain control whenever a PID
    // was assigned; an `error` event by itself is not proof of process exit.
    return child.pid !== undefined
  }

  private async handleExit(id: string, generation: number, outcome: ProcessExit): Promise<void> {
    if (!this.isCurrent(id, generation)) return
    this.running.delete(id)
    const instance = this.definitions.find((candidate) => candidate.id === id)
    if (!instance) return
    const timestamp = this.now()
    const stoppedByStone = instance.status === 'stopping'
    const failed = !stoppedByStone && (Boolean(outcome.error) || outcome.code !== 0)
    const failure = outcome.error
      ? errorMessage(outcome.error)
      : outcome.signal
        ? `Client process exited after signal ${outcome.signal}.`
        : `Client process exited with code ${String(outcome.code)}.`
    this.replace({
      ...instance,
      status: failed ? 'failed' : 'stopped',
      pid: undefined,
      lastError: failed ? failure : undefined,
      stopError: undefined,
      processAlive: false,
      lastStoppedAt: timestamp,
      updatedAt: timestamp
    })
    await this.persist()
  }

  private isCurrent(id: string, generation: number): boolean {
    return this.running.get(id)?.generation === generation
  }

  private async terminateRunning(active: RunningInstance): Promise<boolean> {
    try { active.child.kill('SIGTERM') } catch { /* Continue to the forced tree termination. */ }
    if (await waitForExit(active.exit, Math.min(500, this.stopTimeoutMs))) {
      await active.finalized
      return true
    }
    try {
      if (this.processAdapter.terminateTree) await this.processAdapter.terminateTree(active.child)
      else active.child.kill('SIGKILL')
    } catch { return false }
    const exited = await waitForExit(active.exit, Math.min(1_000, this.stopTimeoutMs))
    if (exited) await active.finalized
    return exited
  }

  private required(id: string): ManagedClientInstance {
    const instance = this.definitions.find((candidate) => candidate.id === id)
    if (!instance) throw new Error('Managed client instance not found.')
    return instance
  }

  private replace(instance: ManagedClientInstance): void {
    this.definitions = this.definitions.map((candidate) => candidate.id === instance.id ? instance : candidate)
  }

  private async persist(): Promise<void> {
    const durable = this.definitions.map(({ pid: _pid, ...definition }) => ({
      ...definition,
      status: this.running.has(definition.id) ? definition.status : definition.status === 'failed' ? 'failed' : 'stopped'
    }))
    const snapshot = this.list()
    const write = this.persistenceTail
      .catch(() => undefined)
      .then(() => this.options.store.writeAppMetadata(METADATA_KEY, JSON.stringify(durable)))
    // Persist calls can originate from process events as well as IPC flights.
    // Serialize their already-captured snapshots so an older generation's
    // slow write cannot overwrite the state of a newer launch.
    this.persistenceTail = write
    await write
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* Renderer notification failures must not corrupt process state. */ }
    }
  }
}

class NodeClientInstanceProcessAdapter implements ClientInstanceProcessAdapter {
  spawn(executable: string, args: readonly string[], options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    launchMode: ManagedClientLaunchMode
  }): ChildProcess {
    const processOptions = clientInstanceNodeSpawnOptions(
      process.platform,
      options.launchMode,
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
    )
    return spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      ...processOptions,
    })
  }

  async terminateTree(child: ClientInstanceProcess): Promise<void> {
    if (process.platform !== 'win32' || !child.pid) {
      child.kill('SIGKILL')
      return
    }
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async isAlive(child: ClientInstanceProcess): Promise<boolean> {
    if (!child.pid) return false
    try {
      process.kill(child.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

export interface ClientInstanceNodeSpawnOptions {
  windowsHide: boolean
  detached: boolean
  stdio: 'inherit' | 'ignore'
}

/**
 * Resolve the direct Node spawn contract without silently turning an
 * interactive POSIX launch into a detached background process.
 *
 * Windows can allocate a separate console for a detached child. POSIX cannot;
 * it needs a real controlling terminal inherited from Stone+'s process. A
 * packaged desktop launch therefore fails clearly and lets the user choose the
 * explicit background mode instead of starting an unusable hidden CLI.
 */
export function clientInstanceNodeSpawnOptions(
  platform: NodeJS.Platform,
  launchMode: ManagedClientLaunchMode,
  hasControllingTerminal: boolean,
): ClientInstanceNodeSpawnOptions {
  if (launchMode === 'background') {
    return { windowsHide: true, detached: false, stdio: 'ignore' }
  }
  if (platform !== 'win32' && !hasControllingTerminal) {
    throw new Error('Visible terminal launch requires Stone+ to run from a controlling terminal on this platform. Choose background mode otherwise.')
  }
  return {
    windowsHide: false,
    detached: platform === 'win32',
    stdio: 'inherit',
  }
}

async function waitForExit(exit: Promise<ProcessExit>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseDefinitions(raw: string | undefined): ManagedClientInstance[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const record = candidate as Partial<ManagedClientInstance>
      try {
        return [{
          id: optionalIdentifier(record.id) ?? randomUUID(),
          name: requiredName(record.name ?? ''),
          client: supportedClient(record.client as RouteClient),
          configDirectory: requiredAbsolutePath(record.configDirectory ?? '', 'Configuration directory'),
          workingDirectory: optionalAbsolutePath(record.workingDirectory, 'Working directory'),
          executablePath: optionalAbsolutePath(record.executablePath, 'Executable path'),
          launchArgs: normalizeArgs(record.launchArgs),
          launchMode: launchMode(record.launchMode ?? 'background'),
          routeId: optionalIdentifier(record.routeId),
          profileId: optionalIdentifier(record.profileId),
          status: 'stopped' as const,
          processAlive: false,
          stopError: typeof record.stopError === 'string' ? record.stopError.slice(0, 1_000) : undefined,
          lastStartedAt: finiteTimestamp(record.lastStartedAt),
          lastStoppedAt: finiteTimestamp(record.lastStoppedAt),
          lastError: typeof record.lastError === 'string' ? record.lastError.slice(0, 1_000) : undefined,
          createdAt: finiteTimestamp(record.createdAt) ?? Date.now(),
          updatedAt: finiteTimestamp(record.updatedAt) ?? Date.now()
        }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function configDirectoryEnvironment(client: RouteClient, directory: string): NodeJS.ProcessEnv {
  switch (client) {
    case 'codex': return { CODEX_HOME: directory }
    case 'claude': return { CLAUDE_CONFIG_DIR: directory }
    case 'gemini': return { GEMINI_CLI_HOME: directory }
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`${label} does not exist or is not a directory.`)
}

async function assertFile(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`${label} does not exist or is not a file.`)
}

function requiredName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 120) throw new Error('Instance name must contain 1-120 characters.')
  return name
}

function supportedClient(value: RouteClient): RouteClient {
  if (value !== 'claude' && value !== 'codex' && value !== 'gemini') throw new Error('Unsupported client instance type.')
  return value
}

function launchMode(value: ManagedClientLaunchMode): ManagedClientLaunchMode {
  if (value !== 'terminal' && value !== 'background') throw new Error('Unsupported client launch mode.')
  return value
}

function defaultLaunchMode(): ManagedClientLaunchMode {
  return process.platform === 'win32' ? 'terminal' : 'background'
}

function requiredAbsolutePath(value: string, label: string): string {
  const path = value.trim()
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path.`)
  return resolve(path)
}

function optionalAbsolutePath(value: string | undefined, label: string): string | undefined {
  const path = value?.trim()
  return path ? requiredAbsolutePath(path, label) : undefined
}

function normalizeArgs(value: readonly string[] | undefined): string[] {
  if (!value) return []
  if (value.length > 100) throw new Error('No more than 100 launch arguments are allowed.')
  return value.map((argument) => {
    if (typeof argument !== 'string' || argument.length > 2_000 || argument.includes('\0')) {
      throw new Error('One of the launch arguments is invalid.')
    }
    return argument
  })
}

function optionalIdentifier(value: string | undefined): string | undefined {
  const id = value?.trim()
  return id ? id.slice(0, 200) : undefined
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! >= 0 ? Number(value) : undefined
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
