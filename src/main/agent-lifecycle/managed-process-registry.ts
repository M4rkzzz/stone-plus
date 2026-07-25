import { resolve } from 'node:path'

export type ManagedAgentTarget = 'codex-desktop' | 'codex-cli' | 'claude-code' | 'gemini-cli' | 'grok-build'

export interface ManagedAgentProcess {
  id: string
  target: ManagedAgentTarget
  pid: number
  startedAtMs: number
  executablePath: string
  cwd: string
  configDir: string
  registeredAtMs: number
}

export interface ObservedProcessIdentity {
  pid: number
  startedAtMs: number
  executablePath: string
}

export interface ManagedProcessAdapter {
  inspect(pid: number): Promise<ObservedProcessIdentity | undefined>
  closeGracefully(process: ManagedAgentProcess, expected: ObservedProcessIdentity): Promise<void>
  closeForced(process: ManagedAgentProcess, expected: ObservedProcessIdentity): Promise<void>
}

export interface ManagedProcessRegistryOptions {
  adapter: ManagedProcessAdapter
  gracefulTimeoutMs?: number
  forcedTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (durationMs: number) => Promise<void>
  platform?: NodeJS.Platform
}

export type ManagedProcessCloseResult =
  | { status: 'graceful' | 'forced' | 'already-exited' | 'identity-mismatch'; process: ManagedAgentProcess }
  | { status: 'failed'; process: ManagedAgentProcess; error: string }

const DEFAULT_GRACEFUL_TIMEOUT_MS = 3_000
const DEFAULT_FORCED_TIMEOUT_MS = 2_000
const DEFAULT_POLL_INTERVAL_MS = 50

/**
 * Tracks only processes launched by Stone+. The registry intentionally does not
 * discover or adopt arbitrary processes with a matching executable name.
 */
export class ManagedProcessRegistry {
  private readonly entries = new Map<string, ManagedAgentProcess>()
  private readonly closing = new Map<string, Promise<ManagedProcessCloseResult>>()
  private readonly adapter: ManagedProcessAdapter
  private readonly gracefulTimeoutMs: number
  private readonly forcedTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number
  private readonly sleep: (durationMs: number) => Promise<void>
  private readonly platform: NodeJS.Platform

  constructor(options: ManagedProcessRegistryOptions) {
    this.adapter = options.adapter
    this.gracefulTimeoutMs = nonNegativeDuration(options.gracefulTimeoutMs, DEFAULT_GRACEFUL_TIMEOUT_MS)
    this.forcedTimeoutMs = nonNegativeDuration(options.forcedTimeoutMs, DEFAULT_FORCED_TIMEOUT_MS)
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((durationMs) => new Promise((done) => setTimeout(done, durationMs)))
    this.platform = options.platform ?? process.platform
  }

  register(input: Omit<ManagedAgentProcess, 'id' | 'registeredAtMs'>): ManagedAgentProcess {
    validateRegistration(input)
    const processRecord: ManagedAgentProcess = Object.freeze({
      ...input,
      executablePath: resolve(input.executablePath),
      cwd: resolve(input.cwd),
      configDir: resolve(input.configDir),
      id: managedProcessId(input.target, input.pid, input.startedAtMs),
      registeredAtMs: this.now()
    })
    this.entries.set(processRecord.id, processRecord)
    return processRecord
  }

  unregister(id: string): boolean {
    return this.entries.delete(id)
  }

  get(id: string): ManagedAgentProcess | undefined {
    return this.entries.get(id)
  }

  list(target?: ManagedAgentTarget): ManagedAgentProcess[] {
    return [...this.entries.values()].filter((entry) => target === undefined || entry.target === target)
  }

  close(id: string): Promise<ManagedProcessCloseResult> {
    const active = this.closing.get(id)
    if (active) return active

    const operation = this.closeRegistered(id).finally(() => {
      if (this.closing.get(id) === operation) this.closing.delete(id)
    })
    this.closing.set(id, operation)
    return operation
  }

  async closeTarget(target: ManagedAgentTarget): Promise<ManagedProcessCloseResult[]> {
    return Promise.all(this.list(target).map((entry) => this.close(entry.id)))
  }

  async pruneStale(): Promise<ManagedAgentProcess[]> {
    const removed: ManagedAgentProcess[] = []
    await Promise.all(this.list().map(async (entry) => {
      const match = await this.identityMatches(entry)
      if (match === 'match') return
      if (this.entries.delete(entry.id)) removed.push(entry)
    }))
    return removed
  }

  private async closeRegistered(id: string): Promise<ManagedProcessCloseResult> {
    const entry = this.entries.get(id)
    if (!entry) {
      throw new Error(`Managed Agent process is not registered: ${id}`)
    }

    try {
      const initial = await this.observe(entry)
      if (initial.status !== 'match') {
        this.entries.delete(id)
        return { status: initial.status, process: entry }
      }

      // The adapter receives the verified identity as an additional guard. A
      // platform adapter should compare it again immediately before signaling.
      try {
        await this.adapter.closeGracefully(entry, initial.identity)
        if (await this.waitUntilOriginalExited(entry, this.gracefulTimeoutMs)) {
          this.entries.delete(id)
          return { status: 'graceful', process: entry }
        }
      } catch {
        // A rejected graceful signal is not evidence that the process exited.
        // Re-verify below and escalate only while the original identity remains.
      }

      // Re-verify immediately before escalation. This prevents a reused PID
      // from receiving the forced-close signal after the original process exits.
      const beforeForce = await this.observe(entry)
      if (beforeForce.status !== 'match') {
        this.entries.delete(id)
        return { status: beforeForce.status === 'already-exited' ? 'graceful' : 'identity-mismatch', process: entry }
      }

      await this.adapter.closeForced(entry, beforeForce.identity)
      if (await this.waitUntilOriginalExited(entry, this.forcedTimeoutMs)) {
        this.entries.delete(id)
        return { status: 'forced', process: entry }
      }
      return { status: 'failed', process: entry, error: 'Process remained alive after forced close' }
    } catch (error) {
      return { status: 'failed', process: entry, error: errorMessage(error) }
    }
  }

  private async waitUntilOriginalExited(entry: ManagedAgentProcess, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (true) {
      if (await this.identityMatches(entry) !== 'match') return true
      const remaining = deadline - this.now()
      if (remaining <= 0) return false
      await this.sleep(Math.min(this.pollIntervalMs, remaining))
    }
  }

  private async identityMatches(entry: ManagedAgentProcess): Promise<'match' | 'already-exited' | 'identity-mismatch'> {
    return (await this.observe(entry)).status
  }

  private async observe(entry: ManagedAgentProcess): Promise<
    | { status: 'match'; identity: ObservedProcessIdentity }
    | { status: 'already-exited' | 'identity-mismatch' }
  > {
    const observed = await this.adapter.inspect(entry.pid)
    if (!observed) return { status: 'already-exited' }
    if (
      observed.pid !== entry.pid
      || observed.startedAtMs !== entry.startedAtMs
      || normalizePath(observed.executablePath, this.platform) !== normalizePath(entry.executablePath, this.platform)
    ) {
      return { status: 'identity-mismatch' }
    }
    return { status: 'match', identity: observed }
  }
}

function managedProcessId(target: ManagedAgentTarget, pid: number, startedAtMs: number): string {
  return `${target}:${pid}:${startedAtMs}`
}

function normalizePath(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path)
  return platform === 'win32' || platform === 'darwin' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function validateRegistration(input: Omit<ManagedAgentProcess, 'id' | 'registeredAtMs'>): void {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error('Managed process PID must be a positive safe integer')
  if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs <= 0) throw new Error('Managed process start time must be a positive epoch millisecond value')
  if (!input.executablePath.trim()) throw new Error('Managed process executable path is required')
  if (!input.cwd.trim()) throw new Error('Managed process working directory is required')
  if (!input.configDir.trim()) throw new Error('Managed process config directory is required')
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
