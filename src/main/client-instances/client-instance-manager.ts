import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import type { ManagedClientInstance, ManagedClientInstanceInput, ManagedClientLaunchMode, RouteClient } from '@shared/types'
import { isClaudeClientModelName, withoutClaudeRelayModelEnvironment } from '../client-config/claude-environment'

const METADATA_KEY = 'managed_client_instances_v1'
const SHUTDOWN_PERSIST_TIMEOUT_MS = 250
const SHUTDOWN_START_DRAIN_TIMEOUT_MS = 1_000

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
  terminateTree?(child: ClientInstanceProcess, signal?: NodeJS.Signals): Promise<void>
  isAlive?(child: ClientInstanceProcess): Promise<boolean>
  waitForReady?(child: ClientInstanceProcess): Promise<void>
}

export interface ClientInstanceLaunchBinding {
  env?: NodeJS.ProcessEnv
}

/**
 * Immutable, fully-resolved launch input. Main-process integrations can use
 * `validateLaunchPlan` to assert runtime prerequisites (notably that the local
 * gateway is actually listening) before any lifecycle state is changed or a
 * child process is spawned.
 */
export interface ClientInstanceLaunchPlan {
  readonly instanceId: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly launchMode: ManagedClientLaunchMode
}

export interface ClientInstanceManagerOptions {
  store: ClientInstanceMetadataStore
  processAdapter?: ClientInstanceProcessAdapter
  resolveBinding?: (instance: ManagedClientInstance) => ClientInstanceLaunchBinding
  validateLaunchPlan?: (plan: ClientInstanceLaunchPlan) => void | Promise<void>
  baseEnvironment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  hasControllingTerminal?: () => boolean
  now?: () => number
  stopTimeoutMs?: number
  inspectProcess?: (pid: number) => Promise<ClientInstanceProcessIdentity | undefined>
  terminatePidTree?: (pid: number) => Promise<void>
  /** Production launches must be journalled before being reported as running. */
  requireProcessJournal?: boolean
  processIdentityAttempts?: number
}

export interface ClientInstanceProcessIdentity {
  executablePath: string
  commandLine: string
  startedAt: number
}

interface ClientInstanceProcessJournal extends ClientInstanceProcessIdentity {
  instanceId: string
  pid: number
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

interface ShutdownSignal {
  requested: boolean
  promise: Promise<void>
  request(): void
}

export class ClientInstanceManager {
  private definitions: ManagedClientInstance[] = []
  private readonly running = new Map<string, RunningInstance>()
  private readonly recovered = new Map<string, ClientInstanceProcessJournal>()
  private readonly processJournals = new Map<string, ClientInstanceProcessJournal>()
  private readonly listeners = new Set<(instances: ManagedClientInstance[]) => void>()
  private readonly startFlights = new Map<string, Promise<ManagedClientInstance[]>>()
  private readonly stopFlights = new Map<string, Promise<ManagedClientInstance[]>>()
  private readonly processAdapter: ClientInstanceProcessAdapter
  private readonly now: () => number
  private readonly stopTimeoutMs: number
  private readonly platform: NodeJS.Platform
  private readonly inspectProcess: NonNullable<ClientInstanceManagerOptions['inspectProcess']>
  private readonly terminatePidTree: NonNullable<ClientInstanceManagerOptions['terminatePidTree']>
  private readonly requireProcessJournal: boolean
  private readonly processIdentityAttempts: number
  private readonly shutdown = createShutdownSignal()
  private nextGeneration = 0
  private persistenceTail: Promise<void> = Promise.resolve()

  public constructor(private readonly options: ClientInstanceManagerOptions) {
    this.processAdapter = options.processAdapter ?? new NodeClientInstanceProcessAdapter()
    this.now = options.now ?? (() => Date.now())
    this.stopTimeoutMs = Math.max(100, Math.min(30_000, options.stopTimeoutMs ?? 5_000))
    this.platform = options.platform ?? process.platform
    this.inspectProcess = options.inspectProcess ?? ((pid) => inspectClientProcess(pid, this.platform))
    this.terminatePidTree = options.terminatePidTree ?? ((pid) => terminateClientPidTree(pid, this.platform))
    // An injected process adapter is commonly a deterministic unit-test fake.
    // Native production launches, plus callers that explicitly supply process
    // inspection, must establish a durable identity before success is exposed.
    this.requireProcessJournal = options.requireProcessJournal ?? !options.processAdapter
    this.processIdentityAttempts = Math.max(1, Math.min(10, options.processIdentityAttempts ?? 4))
  }

  public initialize(): ManagedClientInstance[] {
    const raw = this.options.store.readAppMetadata(METADATA_KEY)
    this.definitions = parseDefinitions(raw)
      .map((instance) => ({ ...instance, status: 'stopped', pid: undefined }))
    this.processJournals.clear()
    for (const journal of parseProcessJournals(raw)) {
      if (this.definitions.some((definition) => definition.id === journal.instanceId)) {
        this.processJournals.set(journal.instanceId, journal)
      }
    }
    return this.list()
  }

  public async recoverOrphanedProcesses(): Promise<ManagedClientInstance[]> {
    for (const [id, journal] of [...this.processJournals]) {
      let live: ClientInstanceProcessIdentity | undefined
      try {
        live = await this.inspectProcess(journal.pid)
      } catch (error) {
        this.recovered.set(id, journal)
        const instance = this.definitions.find((candidate) => candidate.id === id)
        if (instance) this.replace({
          ...instance,
          status: 'failed',
          pid: journal.pid,
          processAlive: true,
          lastError: `Could not verify the previous client process: ${errorMessage(error)}`,
          updatedAt: this.now(),
        })
        continue
      }
      if (!live || !sameProcessIdentity(live, journal, this.platform)) {
        this.processJournals.delete(id)
        continue
      }
      this.recovered.set(id, journal)
      const instance = this.definitions.find((candidate) => candidate.id === id)
      if (instance) this.replace({ ...instance, status: 'running', pid: journal.pid, processAlive: true, updatedAt: this.now() })
    }
    await this.persist()
    return this.list()
  }

  public list(): ManagedClientInstance[] {
    return this.definitions.map((definition) => {
      const active = this.running.get(definition.id)
      const recovered = this.recovered.get(definition.id)
      return structuredClone(active
        ? {
            ...definition,
            status: definition.status === 'stopping' || definition.status === 'failed' ? definition.status : 'running',
            pid: active.child.pid,
            processAlive: true
          }
        : recovered
          ? { ...definition, status: definition.status === 'failed' ? 'failed' : 'running', pid: recovered.pid, processAlive: true }
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
    if (existing && (this.running.has(existing.id) || this.recovered.has(existing.id))) {
      throw new Error('Stop the client instance before editing it.')
    }
    const timestamp = this.now()
    const client = supportedClient(input.client)
    const resolvedLaunchMode = launchMode(input.launchMode ?? existing?.launchMode ?? defaultLaunchMode(this.platform))
    // Preserve an old explicit terminal definition so startup migrations and
    // unrelated edits remain possible, but never allow a new unsupported mode
    // to be selected. start() performs the same check unconditionally.
    if (!existing || resolvedLaunchMode !== existing.launchMode) this.assertLaunchModeSupported(resolvedLaunchMode)
    const definition: ManagedClientInstance = {
      id: existing?.id ?? randomUUID(),
      name: requiredName(input.name),
      client,
      configDirectory: requiredAbsolutePath(input.configDirectory, 'Configuration directory'),
      workingDirectory: optionalAbsolutePath(input.workingDirectory, 'Working directory'),
      executablePath: optionalAbsolutePath(input.executablePath, 'Executable path'),
      launchArgs: sanitizeManagedClientLaunchArgs(client, normalizeArgs(input.launchArgs)),
      // A packaged POSIX desktop process normally has no controlling TTY. Do
      // not make the default instance unlaunchable there until an external
      // terminal adapter is available; Windows keeps the visible-console
      // default, while explicit user choices are always preserved.
      launchMode: resolvedLaunchMode,
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
    if (this.running.has(id) || this.recovered.has(id)) throw new Error('Stop the client instance before deleting it.')
    if (!this.definitions.some((candidate) => candidate.id === id)) throw new Error('Managed client instance not found.')
    // Only the Stone+ definition is removed. External config/work directories
    // are intentionally never touched.
    this.definitions = this.definitions.filter((candidate) => candidate.id !== id)
    await this.persist()
    return this.list()
  }

  public start(id: string): Promise<ManagedClientInstance[]> {
    if (this.shutdown.requested) return Promise.reject(new ClientInstanceStartCancelledError())
    const existing = this.startFlights.get(id)
    if (existing) return existing
    const flight = this.startInternal(id).finally(() => {
      if (this.startFlights.get(id) === flight) this.startFlights.delete(id)
    })
    this.startFlights.set(id, flight)
    return flight
  }

  private async startInternal(id: string): Promise<ManagedClientInstance[]> {
    this.assertStartAllowed()
    const stopping = this.stopFlights.get(id)
    if (stopping) await this.awaitStartStep(stopping)
    if (this.running.has(id) || this.recovered.has(id)) return this.list()
    const instance = this.required(id)
    if (!instance.executablePath) throw new Error('Choose an executable before starting this instance.')
    this.assertLaunchModeSupported(instance.launchMode)
    const launchExecutable = await this.awaitStartStep(resolveClientExecutable(instance.executablePath, this.platform))
    await this.awaitStartStep(assertFile(launchExecutable, 'Client executable'))
    if (instance.workingDirectory) {
      await this.awaitStartStep(assertDirectory(instance.workingDirectory, 'Working directory'))
    }
    await this.awaitStartStep(mkdir(instance.configDirectory, { recursive: true }).then(() => undefined))
    await this.awaitStartStep(assertDirectory(instance.configDirectory, 'Configuration directory'))
    const binding = this.options.resolveBinding?.(structuredClone(instance))
    const plan: ClientInstanceLaunchPlan = Object.freeze({
      instanceId: instance.id,
      executable: launchExecutable,
      // Apply the sanitizer again at the final launch boundary so legacy
      // metadata and direct IPC starts cannot revive stale relay model flags.
      args: Object.freeze(sanitizeManagedClientLaunchArgs(instance.client, instance.launchArgs)),
      ...(instance.workingDirectory ? { cwd: instance.workingDirectory } : {}),
      env: Object.freeze({
        ...clientBaseEnvironment(instance.client, this.options.baseEnvironment ?? process.env),
        ...configDirectoryEnvironment(instance.client, instance.configDirectory),
        ...(binding?.env ?? {}),
      }),
      launchMode: instance.launchMode,
    })
    if (this.options.validateLaunchPlan) {
      await this.awaitStartStep(Promise.resolve(this.options.validateLaunchPlan(plan)))
    }
    this.assertStartAllowed()
    const timestamp = this.now()
    this.replace({ ...instance, status: 'starting', lastError: undefined, updatedAt: timestamp })
    let launched: RunningInstance | undefined
    try {
      await this.awaitStartStep(this.persist())
      this.assertStartAllowed()
      const child = this.processAdapter.spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env as NodeJS.ProcessEnv,
        launchMode: plan.launchMode
      })
      const generation = ++this.nextGeneration
      launched = this.trackRunning(id, generation, child, timestamp)
      if (this.processAdapter.waitForReady) {
        await this.awaitStartStep(this.processAdapter.waitForReady(child))
      }
      const identity = child.pid
        ? await this.inspectLaunchedProcess(child.pid, this.requireProcessJournal)
        : undefined
      if (this.requireProcessJournal && (!child.pid || !identity)) {
        throw new Error('The client process started, but Stone+ could not verify its identity for safe recovery.')
      }
      // A defensive adapter may synchronously report a launch failure while
      // the listeners are installed. Never resurrect that completed
      // generation as running.
      if (!this.isCurrent(id, generation)) {
        await launched.finalized
        return this.list()
      }
      if (child.pid && identity) this.processJournals.set(id, { instanceId: id, pid: child.pid, ...identity })
      this.replace({ ...this.required(id), status: 'running', pid: child.pid, lastStartedAt: timestamp, updatedAt: timestamp })
      await this.awaitStartStep(this.persist())
      return this.list()
    } catch (error) {
      if (launched && this.isCurrent(id, launched.generation)) {
        const stopped = await this.terminateRunning(launched)
        if (stopped && this.isCurrent(id, launched.generation)) {
          this.running.delete(id)
          this.processJournals.delete(id)
        }
      }
      const stillRunning = launched && this.isCurrent(id, launched.generation)
      if (error instanceof ClientInstanceStartCancelledError && !stillRunning) {
        this.replace({
          ...this.required(id),
          status: 'stopped',
          pid: undefined,
          processAlive: false,
          lastError: undefined,
          stopError: undefined,
          lastStoppedAt: this.now(),
          updatedAt: this.now(),
        })
        await this.persistForLifecycle().catch(() => undefined)
        throw error
      }
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
      await this.persistForLifecycle().catch(() => undefined)
      throw error
    }
  }

  private async inspectLaunchedProcess(
    pid: number,
    required: boolean,
  ): Promise<ClientInstanceProcessIdentity | undefined> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.processIdentityAttempts; attempt += 1) {
      try {
        const identity = await this.inspectProcess(pid)
        if (identity) return identity
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < this.processIdentityAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
    }
    if (required && lastError) {
      throw new Error(`The client process started, but Stone+ could not inspect it for safe recovery: ${errorMessage(lastError)}`)
    }
    return undefined
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
    if (starting && !this.shutdown.requested) await starting.catch(() => undefined)
    const instance = this.required(id)
    const active = this.running.get(id)
    const recovered = this.recovered.get(id)
    if (recovered) {
      this.replace({ ...instance, status: 'stopping', updatedAt: this.now() })
      await this.persistBeforeTermination()
      try {
        const live = await this.inspectProcess(recovered.pid)
        if (live && sameProcessIdentity(live, recovered, this.platform)) {
          await this.terminatePidTree(recovered.pid)
          const remaining = await this.inspectProcess(recovered.pid)
          if (remaining && sameProcessIdentity(remaining, recovered, this.platform)) {
            throw new Error('Recovered client process tree remained alive after forced termination.')
          }
        }
      } catch (error) {
        const message = errorMessage(error)
        this.replace({
          ...this.required(id), status: 'failed', pid: recovered.pid, processAlive: true,
          stopError: message, lastError: message, updatedAt: this.now(),
        })
        await this.persistForLifecycle()
        throw error
      }
      this.recovered.delete(id)
      this.processJournals.delete(id)
      this.replace({ ...this.required(id), status: 'stopped', pid: undefined, processAlive: false, stopError: undefined, lastStoppedAt: this.now(), updatedAt: this.now() })
      await this.persistForLifecycle()
      return this.list()
    }
    if (!active) {
      if (instance.status !== 'stopped') {
        this.replace({ ...instance, status: 'stopped', pid: undefined, updatedAt: this.now() })
        await this.persistForLifecycle()
      }
      return this.list()
    }
    this.replace({ ...instance, status: 'stopping', updatedAt: this.now() })
    await this.persistBeforeTermination()
    // Windows terminal launches and npm/PowerShell shims are supervised by a
    // wrapper process. Killing that wrapper first makes it disappear from the
    // process table while its real Agent child keeps running, so taskkill can
    // no longer find the root of the tree. Terminate the verified live tree
    // while the supervisor PID still exists and only then finalize state.
    if (this.platform === 'win32' && this.processAdapter.terminateTree) {
      if (!this.isCurrent(id, active.generation)) {
        await active.finalized
        return this.list()
      }
      try {
        await this.processAdapter.terminateTree(active.child)
      } catch (error) {
        // taskkill can race a natural exit. Only surface a failure while the
        // original tracked child still exists.
        const alive = this.isCurrent(id, active.generation)
          && await this.confirmAlive(active.child).catch(() => true)
        if (alive) {
          const message = errorMessage(error)
          this.replace({
            ...this.required(id), status: 'failed', pid: active.child.pid, processAlive: true,
            stopError: message, lastError: message, updatedAt: this.now(),
          })
          await this.persistForLifecycle()
          throw error
        }
      }
      const emittedExit = await waitForExit(active.exit, Math.min(250, this.stopTimeoutMs))
      if (emittedExit) {
        await active.finalized
      } else if (this.isCurrent(id, active.generation)) {
        const stillAlive = this.processAdapter.isAlive
          ? await this.processAdapter.isAlive(active.child).catch(() => true)
          : false
        if (stillAlive) {
          const error = new Error('Client process tree remained alive after forced termination.')
          this.replace({
            ...this.required(id), status: 'failed', pid: active.child.pid, processAlive: true,
            stopError: error.message, lastError: error.message, updatedAt: this.now(),
          })
          await this.persistForLifecycle()
          throw error
        }
        // Successful process adapters guarantee the tree is gone. Some test
        // and platform adapters cannot emit a ChildProcess exit event, so
        // synthesize the same idempotent finalization in that case.
        await this.handleExit(id, active.generation, { code: 0, signal: null })
      }
      return this.list()
    }
    let graceful = false
    try {
      if (this.processAdapter.terminateTree) await this.processAdapter.terminateTree(active.child, 'SIGTERM')
      else active.child.kill('SIGTERM')
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
        await this.persistForLifecycle()
        throw error
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
        await this.persistForLifecycle()
        throw error
      }
    }
    return this.list()
  }

  public async stopAll(): Promise<{
    stopped: string[]
    stillRunning: Array<{ id: string; pid?: number; error?: string }>
  }> {
    const ids = new Set([...this.running.keys(), ...this.recovered.keys(), ...this.startFlights.keys()])
    const pendingStarts = [...this.startFlights.values()]
    this.shutdown.request()
    for (const id of this.running.keys()) ids.add(id)
    const stopping = [...new Set([...this.running.keys(), ...this.recovered.keys()])].map((id) => this.stop(id).catch(() => undefined))
    await Promise.all([
      ...stopping.map((flight) => settleWithin(flight, this.stopTimeoutMs + 2_000)),
      settleWithin(Promise.allSettled(pendingStarts), SHUTDOWN_START_DRAIN_TIMEOUT_MS),
    ])
    const stillRunning = [...ids].flatMap((id) => {
      const active = this.running.get(id)
      const recovered = this.recovered.get(id)
      const instance = this.definitions.find((candidate) => candidate.id === id)
      return active || recovered ? [{ id, pid: active?.child.pid ?? recovered?.pid, error: instance?.stopError ?? instance?.lastError }] : []
    })
    const runningIds = new Set(stillRunning.map((item) => item.id))
    return { stopped: [...ids].filter((id) => !runningIds.has(id)), stillRunning }
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
    await this.persistForLifecycle().catch(() => undefined)
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
    this.processJournals.delete(id)
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
    await this.persistForLifecycle()
  }

  private isCurrent(id: string, generation: number): boolean {
    return this.running.get(id)?.generation === generation
  }

  private async terminateRunning(active: RunningInstance): Promise<boolean> {
    if (this.platform === 'win32' && this.processAdapter.terminateTree) {
      try {
        await this.processAdapter.terminateTree(active.child)
      } catch {
        return !await this.confirmAlive(active.child).catch(() => true)
      }
      if (await waitForExit(active.exit, Math.min(250, this.stopTimeoutMs))) {
        await active.finalized
        return true
      }
      return this.processAdapter.isAlive
        ? !await this.processAdapter.isAlive(active.child).catch(() => true)
        : true
    }
    try {
      if (this.processAdapter.terminateTree) await this.processAdapter.terminateTree(active.child, 'SIGTERM')
      else active.child.kill('SIGTERM')
    } catch { /* Continue to the forced tree termination. */ }
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
    const durable = this.definitions.map(({ pid: _pid, ...definition }) => {
      const processJournal = this.processJournals.get(definition.id)
      return {
        ...definition,
        status: this.running.has(definition.id) || this.recovered.has(definition.id)
          ? definition.status
          : definition.status === 'failed' ? 'failed' : 'stopped',
        ...(processJournal ? { processJournal } : {}),
      }
    })
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

  private async persistForLifecycle(): Promise<void> {
    const persistence = this.persist()
    if (!this.shutdown.requested) {
      await persistence
      return
    }
    await settleWithin(persistence, SHUTDOWN_PERSIST_TIMEOUT_MS)
  }

  private async persistBeforeTermination(): Promise<void> {
    const persistence = this.persist()
    if (this.shutdown.requested) {
      void persistence.catch(() => undefined)
      return
    }
    await Promise.race([
      persistence,
      this.shutdown.promise,
    ])
  }

  private assertLaunchModeSupported(mode: ManagedClientLaunchMode): void {
    if (mode !== 'terminal' || this.platform === 'win32') return
    const hasControllingTerminal = this.options.hasControllingTerminal?.()
      ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (!hasControllingTerminal) {
      throw new Error('Visible terminal launch is unavailable because Stone+ has no controlling terminal on this platform. Choose background mode instead.')
    }
  }

  private assertStartAllowed(): void {
    if (this.shutdown.requested) throw new ClientInstanceStartCancelledError()
  }

  private async awaitStartStep<T>(operation: Promise<T>): Promise<T> {
    this.assertStartAllowed()
    return Promise.race([
      operation,
      this.shutdown.promise.then(() => { throw new ClientInstanceStartCancelledError() }),
    ])
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
    // npm and similar installers expose Windows CLIs as .cmd/.bat shims.
    // CreateProcess cannot launch those directly (spawn EINVAL), so wrap them
    // through cmd.exe while keeping the managed executable path unchanged.
    const invocation = resolveClientInstanceSpawnInvocation(process.platform, executable, args, options.launchMode)
    return spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      ...processOptions,
    })
  }

  async terminateTree(child: ClientInstanceProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (!child.pid) {
      child.kill(signal)
      return
    }
    if (process.platform !== 'win32') {
      await terminatePosixPidTree(child.pid, signal)
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

  async waitForReady(child: ClientInstanceProcess): Promise<void> {
    await waitForClientProcessReady(child as ChildProcess)
  }
}

export async function waitForClientProcessReady(nativeChild: ChildProcess, stabilityMs = 350): Promise<void> {
  if (nativeChild.exitCode !== null) throw new Error(`Client process exited during startup with code ${String(nativeChild.exitCode)}.`)
  await new Promise<void>((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => {
        ready = true
        cleanup()
        resolve()
      }, stabilityMs)
      const onSpawn = (): void => { /* The stability timer remains authoritative. */ }
      const onError = (error: Error): void => { if (!ready) { cleanup(); reject(error) } }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!ready) {
          cleanup()
          reject(new Error(`Client process exited during startup (${code === null ? signal ?? 'unknown status' : `code ${code}`}).`))
        }
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        nativeChild.off('spawn', onSpawn)
        nativeChild.off('error', onError)
        nativeChild.off('exit', onExit)
      }
      nativeChild.once('spawn', onSpawn)
      nativeChild.once('error', onError)
      nativeChild.once('exit', onExit)
  })
}

export interface ClientInstanceNodeSpawnOptions {
  windowsHide: boolean
  detached: boolean
  stdio: 'inherit' | 'ignore'
}

export interface ClientInstanceSpawnInvocation {
  command: string
  args: string[]
}

/**
 * Resolve the direct Node spawn contract without silently turning an
 * interactive POSIX launch into a detached background process.
 *
 * Windows terminal launches use a hidden `cmd start /wait` supervisor which
 * allocates the interactive console. POSIX needs a real controlling terminal
 * inherited from Stone+'s process. A
 * packaged desktop launch therefore fails clearly and lets the user choose the
 * explicit background mode instead of starting an unusable hidden CLI.
 *
 * The Windows supervisor keeps stdio ignored because a packaged Electron main
 * process has no console to inherit; only the supervised CLI receives the new
 * visible console.
 */
export function clientInstanceNodeSpawnOptions(
  platform: NodeJS.Platform,
  launchMode: ManagedClientLaunchMode,
  hasControllingTerminal: boolean,
): ClientInstanceNodeSpawnOptions {
  if (launchMode === 'background') {
    // A dedicated POSIX process group lets Stone+ terminate the CLI and every
    // child tool it spawned without depending on the wrapper process staying
    // alive. Windows uses taskkill /T instead.
    return { windowsHide: true, detached: platform !== 'win32', stdio: 'ignore' }
  }
  if (platform !== 'win32' && !hasControllingTerminal) {
    throw new Error('Visible terminal launch requires Stone+ to run from a controlling terminal on this platform. Choose background mode otherwise.')
  }
  return {
    windowsHide: platform === 'win32',
    detached: false,
    stdio: platform === 'win32' ? 'ignore' : 'inherit',
  }
}

/**
 * Map a configured executable onto an argv that Node's CreateProcess-based
 * spawn can actually launch. Windows batch shims must go through cmd.exe.
 */
export function resolveClientInstanceSpawnInvocation(
  platform: NodeJS.Platform,
  executable: string,
  args: readonly string[],
  launchMode: ManagedClientLaunchMode = 'background',
): ClientInstanceSpawnInvocation {
  if (platform === 'win32' && launchMode === 'terminal') {
    const commandProcessor = windowsCommandProcessor()
    const target = isWindowsBatchScript(executable)
      ? [commandProcessor, '/d', '/s', '/c', executable, ...args]
      : executable.toLowerCase().endsWith('.ps1')
        ? [windowsPowerShellExecutable(), '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args]
        : [executable, ...args]
    return {
      command: commandProcessor,
      // `start /wait` is deliberate: it gives the CLI a real console/TTY while
      // retaining a wrapper PID whose process tree Stone+ can terminate.
      args: ['/d', '/s', '/c', 'start', 'Stone+ Client', '/wait', ...target],
    }
  }
  if (platform === 'win32' && executable.toLowerCase().endsWith('.ps1')) {
    return {
      command: windowsPowerShellExecutable(),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args],
    }
  }
  if (platform === 'win32' && isWindowsBatchScript(executable)) {
    return {
      command: windowsCommandProcessor(),
      // /d disables AutoRun, /s keeps /c parsing simple for a path + args list.
      args: ['/d', '/s', '/c', executable, ...args],
    }
  }
  return { command: executable, args: [...args] }
}

function isWindowsBatchScript(executable: string): boolean {
  const lower = executable.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

function windowsCommandProcessor(): string {
  const comspec = process.env.ComSpec?.trim()
  return comspec && comspec.length > 0 ? comspec : 'cmd.exe'
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot?.trim()
  return systemRoot ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

async function resolveClientExecutable(executable: string, platform: NodeJS.Platform): Promise<string> {
  if (platform !== 'win32' || extname(executable)) return executable
  // where.exe can return extensionless npm shims and WindowsApps aliases ahead
  // of their launchable siblings. Prefer the native/batch sibling deterministically.
  for (const suffix of ['.exe', '.cmd', '.bat', '.ps1']) {
    const candidate = `${executable}${suffix}`
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate
  }
  return executable
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

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createShutdownSignal(): ShutdownSignal {
  let resolveShutdown!: () => void
  const signal: ShutdownSignal = {
    requested: false,
    promise: new Promise<void>((resolve) => { resolveShutdown = resolve }),
    request: () => {
      if (signal.requested) return
      signal.requested = true
      resolveShutdown()
    },
  }
  return signal
}

class ClientInstanceStartCancelledError extends Error {
  constructor() { super('Client instance start was cancelled because Stone+ is shutting down.') }
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
    case 'grokbuild': return { GROK_HOME: directory }
  }
}

function clientBaseEnvironment(client: RouteClient, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (client === 'claude') return withoutClaudeRelayModelEnvironment(environment)
  if (client === 'grokbuild') return withoutGrokOverrideEnvironment(environment)
  return { ...environment }
}

function withoutGrokOverrideEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  for (const key of Object.keys(sanitized)) {
    const normalized = key.toUpperCase()
    if (normalized === 'XAI_API_KEY' || normalized === 'GROK_DEFAULT_MODEL') delete sanitized[key]
  }
  return sanitized
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
  if (value !== 'claude' && value !== 'codex' && value !== 'gemini' && value !== 'grokbuild') {
    throw new Error('Unsupported client instance type.')
  }
  return value
}

function launchMode(value: ManagedClientLaunchMode): ManagedClientLaunchMode {
  if (value !== 'terminal' && value !== 'background') throw new Error('Unsupported client launch mode.')
  return value
}

function defaultLaunchMode(platform: NodeJS.Platform): ManagedClientLaunchMode {
  return platform === 'win32' ? 'terminal' : 'background'
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

/** Old relay launchers sometimes persisted their upstream GPT/Grok model in
 * Claude's native --model flag. This guard lives at the process boundary so
 * every caller (lifecycle service, managed-instances UI and direct IPC) gets
 * identical cleanup while valid Claude aliases remain untouched. */
export function sanitizeManagedClientLaunchArgs(client: RouteClient, args: readonly string[]): string[] {
  if (client !== 'claude') return [...args]
  const sanitized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--model' && index + 1 < args.length && !isClaudeClientModelName(args[index + 1])) {
      index += 1
      continue
    }
    if (argument.startsWith('--model=') && !isClaudeClientModelName(argument.slice('--model='.length))) continue
    sanitized.push(argument)
  }
  return sanitized
}

function optionalIdentifier(value: string | undefined): string | undefined {
  const id = value?.trim()
  return id ? id.slice(0, 200) : undefined
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! >= 0 ? Number(value) : undefined
}

function parseProcessJournals(raw: string | undefined): ClientInstanceProcessJournal[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((definition) => {
      const value = definition && typeof definition === 'object'
        ? (definition as { processJournal?: unknown }).processJournal
        : undefined
      if (!value || typeof value !== 'object') return []
      const item = value as Partial<ClientInstanceProcessJournal>
      return typeof item.instanceId === 'string' && Number.isSafeInteger(item.pid) && item.pid! > 0
        && typeof item.executablePath === 'string' && typeof item.commandLine === 'string'
        && typeof item.startedAt === 'number' && Number.isFinite(item.startedAt)
        ? [item as ClientInstanceProcessJournal]
        : []
    })
  } catch { return [] }
}

function sameProcessIdentity(
  live: ClientInstanceProcessIdentity,
  journal: ClientInstanceProcessIdentity,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string): string => platform === 'win32' ? value.trim().toLowerCase() : value.trim()
  return normalize(live.executablePath) === normalize(journal.executablePath)
    && live.commandLine === journal.commandLine
    && live.startedAt === journal.startedAt
}

function inspectClientProcess(pid: number, platform: NodeJS.Platform): Promise<ClientInstanceProcessIdentity | undefined> {
  if (platform === 'win32') {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if($p){[Console]::Out.Write(($p | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress))}`
    return executeProcessInspection('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).then((stdout) => {
      if (!stdout.trim()) return undefined
      const value = JSON.parse(stdout) as { ExecutablePath?: unknown; CommandLine?: unknown; CreationDate?: unknown }
      const startedAt = parseWindowsProcessStartedAt(value.CreationDate)
      return typeof value.ExecutablePath === 'string' && typeof value.CommandLine === 'string' && Number.isFinite(startedAt)
        ? { executablePath: value.ExecutablePath, commandLine: value.CommandLine, startedAt }
        : undefined
    })
  }
  return executeProcessInspection('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm=', '-o', 'args=']).then((stdout) => {
    const match = /^(.{24})\s+(\S+)\s+(.+)$/s.exec(stdout.trim())
    if (!match) return undefined
    const startedAt = Date.parse(match[1])
    return Number.isFinite(startedAt) ? { executablePath: match[2], commandLine: match[3], startedAt } : undefined
  })
}

function parseWindowsProcessStartedAt(value: unknown): number {
  if (typeof value !== 'string') return NaN
  // Windows PowerShell's ConvertTo-Json serializes CIM DateTime values as
  // /Date(1700000000000)/, while newer PowerShell versions may emit ISO text.
  const dotNetDate = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(value)
  if (dotNetDate) return Number(dotNetDate[1])
  return Date.parse(value)
}

function executeProcessInspection(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

async function terminateClientPidTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => error ? reject(error) : resolve())
    })
    return
  }
  await terminatePosixPidTree(pid, 'SIGKILL')
}

async function terminatePosixPidTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  // Background instances are process-group leaders. Group signalling is
  // atomic and still reaches descendants after a short-lived wrapper exits.
  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  // Legacy/recovered terminal launches may not own a process group. Enumerate
  // their descendants and signal leaves first so no orphan survives its root.
  let output = ''
  try { output = await executeProcessInspection('/bin/ps', ['-eo', 'pid=', '-o', 'ppid=']) } catch { /* Fall through to root. */ }
  const children = new Map<number, number[]>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const childPid = Number(match[1])
    const parentPid = Number(match[2])
    children.set(parentPid, [...(children.get(parentPid) ?? []), childPid])
  }
  const descendants: number[] = []
  const visit = (parent: number): void => {
    for (const child of children.get(parent) ?? []) {
      visit(child)
      descendants.push(child)
    }
  }
  visit(pid)
  for (const target of [...descendants, pid]) {
    try { process.kill(target, signal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
