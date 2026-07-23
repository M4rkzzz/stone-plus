import { randomUUID } from 'node:crypto'
import type {
  PersistentTask,
  PersistentTaskCreateInput,
  PersistentTaskProgress
} from '@shared/types'

export interface PersistentTaskStore {
  listPersistentTasks<TPayload = unknown, TResult = unknown>(limit?: number): PersistentTask<TPayload, TResult>[]
  getPersistentTask<TPayload = unknown, TResult = unknown>(id: string): PersistentTask<TPayload, TResult> | undefined
  upsertPersistentTask(task: PersistentTask): Promise<void>
  deletePersistentTask(id: string): Promise<void>
  prunePersistentTasks(cutoff: number, maximumTerminalRows: number): Promise<number>
  clearTerminalPersistentTasks(): Promise<number>
}

export interface PersistentTaskContext<TPayload> {
  readonly taskId: string
  readonly payload: TPayload
  /** Progress snapshot captured at the beginning of this attempt. */
  readonly progress: PersistentTaskProgress
  readonly signal: AbortSignal
  checkpoint(progress: Partial<PersistentTaskProgress>): Promise<void>
  /** Long loops call this at safe boundaries to support cooperative pause. */
  waitIfPaused(): Promise<void>
}

export type PersistentTaskHandler<TPayload = unknown, TResult = unknown> = (
  context: PersistentTaskContext<TPayload>
) => Promise<TResult>

interface ActiveTask {
  controller: AbortController
  pauseWaiters: Set<() => void>
  promise: Promise<PersistentTask>
}

const RECOVERY_PENDING_ERROR = 'Task was interrupted and is waiting for its handler to resume.'
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000
const DEFAULT_TERMINAL_ROWS = 1_000

/** Durable cooperative background-task runner with one execution per task id. */
export class PersistentTaskRunner {
  private readonly handlers = new Map<string, PersistentTaskHandler>()
  private readonly active = new Map<string, ActiveTask>()
  private readonly transitions = new Map<string, Promise<unknown>>()
  private recoveryComplete = false

  public constructor(
    private readonly store: PersistentTaskStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  public register<TPayload, TResult>(kind: string, handler: PersistentTaskHandler<TPayload, TResult>): () => void {
    const normalized = requiredKind(kind)
    if (this.handlers.has(normalized)) throw new Error(`A persistent task handler is already registered for ${normalized}.`)
    this.handlers.set(normalized, handler as PersistentTaskHandler)
    if (this.recoveryComplete) {
      for (const task of this.store.listPersistentTasks(2_000)) {
        if (task.kind === normalized && task.status === 'paused' && task.error === RECOVERY_PENDING_ERROR) {
          void this.resume(task.id).catch(() => undefined)
        }
      }
    }
    return () => {
      if (this.handlers.get(normalized) === handler) this.handlers.delete(normalized)
    }
  }

  public list(limit?: number): PersistentTask[] {
    return this.store.listPersistentTasks(limit)
  }

  public get(id: string): PersistentTask | undefined {
    return this.store.getPersistentTask(id)
  }

  public async create<TPayload>(input: PersistentTaskCreateInput<TPayload>): Promise<PersistentTask<TPayload>> {
    const id = input.id?.trim() || randomUUID()
    return this.transition(id, async () => {
      if (this.store.getPersistentTask(id)) throw new Error('A persistent task with this id already exists.')
      const timestamp = this.now()
      const total = finiteCount(input.total, 1)
      const task: PersistentTask<TPayload> = {
        id,
        kind: requiredKind(input.kind),
        status: 'paused',
        payload: structuredClone(input.payload),
        progress: { completed: 0, total, percent: 0 },
        resumable: input.resumable !== false,
        attempt: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      await this.store.upsertPersistentTask(task)
      return structuredClone(task)
    })
  }

  public async enqueue<TPayload, TResult>(input: PersistentTaskCreateInput<TPayload>): Promise<PersistentTask<TPayload, TResult>> {
    const task = await this.create(input)
    await this.resume(task.id)
    return this.waitForCompletion(task.id) as Promise<PersistentTask<TPayload, TResult>>
  }

  public async pause(id: string): Promise<PersistentTask> {
    return this.transition(id, async () => {
      const task = requiredTask(this.store, id)
      if (isTerminal(task.status) || task.status === 'paused') return task
      const paused = { ...task, status: 'paused' as const, updatedAt: this.now() }
      await this.store.upsertPersistentTask(paused)
      return paused
    })
  }

  /** Starts/resumes execution and returns as soon as the running state is durable. */
  public async resume(id: string): Promise<PersistentTask> {
    let wake: Set<() => void> | undefined
    const running = await this.transition(id, async () => {
      const task = requiredTask(this.store, id)
      if (task.status === 'completed' || task.status === 'cancelled') return task

      const existing = this.active.get(id)
      if (existing) {
        if (task.status !== 'paused') return task
        const resumed = { ...task, status: 'running' as const, error: undefined, updatedAt: this.now() }
        await this.store.upsertPersistentTask(resumed)
        wake = existing.pauseWaiters
        return resumed
      }

      const handler = this.handlers.get(task.kind)
      if (!handler) throw new Error(`No persistent task handler is registered for ${task.kind}.`)
      const timestamp = this.now()
      const next: PersistentTask = {
        ...task,
        status: 'running',
        error: undefined,
        result: undefined,
        attempt: task.attempt + 1,
        startedAt: timestamp,
        finishedAt: undefined,
        updatedAt: timestamp
      }
      await this.store.upsertPersistentTask(next)
      const active = this.execute(next, handler)
      this.active.set(id, active)
      return next
    })
    if (wake) {
      for (const release of wake) release()
      wake.clear()
    }
    return running
  }

  public async waitForCompletion(id: string): Promise<PersistentTask> {
    const task = requiredTask(this.store, id)
    if (isTerminal(task.status)) return task
    const active = this.active.get(id)
    if (!active) throw new Error('Persistent task is not currently executing.')
    return active.promise
  }

  public async cancel(id: string): Promise<PersistentTask> {
    let active: ActiveTask | undefined
    const cancelled = await this.transition(id, async () => {
      const task = requiredTask(this.store, id)
      if (isTerminal(task.status)) return task
      const timestamp = this.now()
      const next = { ...task, status: 'cancelled' as const, updatedAt: timestamp, finishedAt: timestamp }
      await this.store.upsertPersistentTask(next)
      active = this.active.get(id)
      return next
    })
    active?.controller.abort(new Error('Persistent task cancelled.'))
    for (const wake of active?.pauseWaiters ?? []) wake()
    active?.pauseWaiters.clear()
    return cancelled
  }

  public async recover(): Promise<PersistentTask[]> {
    const recovered: PersistentTask[] = []
    for (const task of this.store.listPersistentTasks(2_000)) {
      if (task.status !== 'running') continue
      if (task.resumable && this.handlers.has(task.kind)) {
        await this.store.upsertPersistentTask({ ...task, status: 'paused', error: RECOVERY_PENDING_ERROR, updatedAt: this.now() })
        recovered.push(await this.resume(task.id))
      } else {
        const timestamp = this.now()
        const status = task.resumable ? 'paused' as const : 'failed' as const
        const updated: PersistentTask = {
          ...task,
          status,
          error: task.resumable ? RECOVERY_PENDING_ERROR : 'Task was interrupted by application restart.',
          updatedAt: timestamp,
          ...(status === 'failed' ? { finishedAt: timestamp } : {})
        }
        await this.store.upsertPersistentTask(updated)
        recovered.push(updated)
      }
    }
    this.recoveryComplete = true
    return recovered
  }

  /** Stops in-memory execution while leaving durable rows recoverable. */
  public async interruptAllForShutdown(): Promise<void> {
    const active = [...this.active.values()]
    for (const task of active) {
      task.controller.abort(new PersistentTaskInterruptedError())
      for (const wake of task.pauseWaiters) wake()
      task.pauseWaiters.clear()
    }
    await Promise.allSettled(active.map((task) => task.promise))
  }

  public pruneTerminalTasks(
    retentionMs = DEFAULT_TERMINAL_RETENTION_MS,
    maximumRows = DEFAULT_TERMINAL_ROWS
  ): Promise<number> {
    return this.store.prunePersistentTasks(this.now() - Math.max(0, retentionMs), Math.max(0, Math.floor(maximumRows)))
  }

  public async clearTerminalTasks(): Promise<PersistentTask[]> {
    await this.store.clearTerminalPersistentTasks()
    return this.list()
  }

  private execute(task: PersistentTask, handler: PersistentTaskHandler): ActiveTask {
    const controller = new AbortController()
    const pauseWaiters = new Set<() => void>()
    const active = { controller, pauseWaiters } as ActiveTask
    const context: PersistentTaskContext<unknown> = {
      taskId: task.id,
      payload: structuredClone(task.payload),
      progress: structuredClone(task.progress),
      signal: controller.signal,
      checkpoint: async (patch) => {
        await this.transition(task.id, async () => {
          if (controller.signal.aborted) throw controller.signal.reason
          const current = requiredTask(this.store, task.id)
          if (isTerminal(current.status)) throw new Error(`Task ${task.id} is already ${current.status}.`)
          const total = finiteCount(patch.total, current.progress.total)
          const completed = Math.max(0, Math.min(total, finiteCount(patch.completed, current.progress.completed)))
          const percent = Number.isFinite(patch.percent)
            ? Math.max(0, Math.min(100, Number(patch.percent)))
            : Math.round(completed / Math.max(1, total) * 100)
          await this.store.upsertPersistentTask({
            ...current,
            progress: {
              completed,
              total,
              percent,
              message: patch.message ?? current.progress.message,
              details: patch.details ?? current.progress.details
            },
            updatedAt: this.now()
          })
        })
      },
      waitIfPaused: async () => {
        while (requiredTask(this.store, task.id).status === 'paused') {
          if (controller.signal.aborted) throw controller.signal.reason
          await new Promise<void>((resolve) => {
            const wake = (): void => {
              pauseWaiters.delete(wake)
              resolve()
            }
            pauseWaiters.add(wake)
          })
        }
        if (controller.signal.aborted) throw controller.signal.reason
      }
    }
    active.promise = (async (): Promise<PersistentTask> => {
      try {
        const result = await handler(context)
        return await this.transition(task.id, async () => {
          const current = requiredTask(this.store, task.id)
          if (isTerminal(current.status)) return current
          const timestamp = this.now()
          const completed: PersistentTask = {
            ...current,
            status: 'completed',
            progress: { ...current.progress, completed: current.progress.total, percent: 100 },
            result: structuredClone(result),
            error: undefined,
            updatedAt: timestamp,
            finishedAt: timestamp
          }
          await this.store.upsertPersistentTask(completed)
          return completed
        })
      } catch (error) {
        return await this.transition(task.id, async () => {
          const current = requiredTask(this.store, task.id)
          if (isTerminal(current.status)) return current
          if (error instanceof PersistentTaskInterruptedError) return current
          const timestamp = this.now()
          const failed: PersistentTask = {
            ...current,
            status: 'failed',
            error: sanitizeTaskError(error),
            updatedAt: timestamp,
            finishedAt: timestamp
          }
          await this.store.upsertPersistentTask(failed)
          return failed
        })
      } finally {
        if (this.active.get(task.id) === active) this.active.delete(task.id)
        for (const wake of pauseWaiters) wake()
        pauseWaiters.clear()
      }
    })()
    return active
  }

  private async transition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(id) ?? Promise.resolve()
    const pending = previous.then(operation, operation)
    this.transitions.set(id, pending)
    try {
      return await pending
    } finally {
      if (this.transitions.get(id) === pending) this.transitions.delete(id)
    }
  }
}

class PersistentTaskInterruptedError extends Error {
  constructor() {
    super('Persistent task interrupted for application shutdown.')
    this.name = 'PersistentTaskInterruptedError'
  }
}

function requiredTask(store: PersistentTaskStore, id: string): PersistentTask {
  const task = store.getPersistentTask(id)
  if (!task) throw new Error('Persistent task not found.')
  return task
}

function requiredKind(kind: string): string {
  const normalized = kind.trim()
  if (!normalized || normalized.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error('Persistent task kind is invalid.')
  }
  return normalized
}

function finiteCount(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : Math.max(0, Math.floor(fallback))
}

function isTerminal(status: PersistentTask['status']): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function sanitizeTaskError(error: unknown): string {
  const redacted = (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
  return Array.from(redacted, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
    .trim()
    .slice(0, 1_000)
}
