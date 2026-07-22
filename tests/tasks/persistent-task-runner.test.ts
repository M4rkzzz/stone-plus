import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^vault:/, '')
  }
}))

import { AppStore } from '../../src/main/store/app-store'

describe('PersistentTaskRunner', () => {
  const stores: AppStore[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('persists progress and result through the shared SQLite repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const runner = store.getPersistentTaskRunner()
    runner.register<{ values: number[] }, number>('test.sum', async ({ payload, checkpoint }) => {
      let sum = 0
      for (let index = 0; index < payload.values.length; index += 1) {
        sum += payload.values[index]
        await checkpoint({ completed: index + 1, total: payload.values.length, message: `item ${index + 1}` })
      }
      return sum
    })
    const created = await runner.create({ kind: 'test.sum', payload: { values: [2, 3, 5] }, total: 3 })
    await runner.resume(created.id)
    const completed = await runner.waitForCompletion(created.id)
    expect(completed).toMatchObject({
      status: 'completed',
      result: 10,
      attempt: 1,
      progress: { completed: 3, total: 3, percent: 100 }
    })
    expect(store.getStateRepository().getPersistentTask(created.id)).toMatchObject({ status: 'completed', result: 10 })
  })

  it('recovers interrupted resumable tasks and pauses unknown task kinds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-recovery-'))
    directories.push(directory)
    const seed = new AppStore(directory)
    stores.push(seed)
    await seed.initialize()
    const repository = seed.getStateRepository()
    const runner = seed.getPersistentTaskRunner()
    const recoverable = await runner.create({ id: 'recoverable', kind: 'test.recover', payload: { value: 7 } })
    const unknown = await runner.create({ id: 'unknown', kind: 'test.unknown', payload: {}, resumable: true })
    await repository.upsertPersistentTask({ ...recoverable, status: 'running', attempt: 1, updatedAt: 10 })
    await repository.upsertPersistentTask({ ...unknown, status: 'running', attempt: 1, updatedAt: 10 })
    await seed.close()
    stores.splice(stores.indexOf(seed), 1)

    const restarted = new AppStore(directory)
    stores.push(restarted)
    restarted.getPersistentTaskRunner().register<{ value: number }, number>('test.recover', async ({ payload }) => payload.value * 2)
    await restarted.initialize()
    await vi.waitFor(() => {
      expect(restarted.getPersistentTaskRunner().get('recoverable')).toMatchObject({ status: 'completed', result: 14, attempt: 2 })
    })
    expect(restarted.getPersistentTaskRunner().get('unknown')).toMatchObject({ status: 'paused', resumable: true })
    restarted.getPersistentTaskRunner().register('test.unknown', async () => 'late-handler-recovered')
    await vi.waitFor(() => {
      expect(restarted.getPersistentTaskRunner().get('unknown')).toMatchObject({
        status: 'completed',
        result: 'late-handler-recovered',
        attempt: 2
      })
    })
  })

  it('supports cooperative pause/resume and cancellation without losing durable state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-control-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const runner = store.getPersistentTaskRunner()

    let notifyCheckpoint!: () => void
    const checkpointed = new Promise<void>((resolve) => { notifyCheckpoint = resolve })
    let releaseBoundary!: () => void
    const boundary = new Promise<void>((resolve) => { releaseBoundary = resolve })
    runner.register('test.pause', async ({ checkpoint, waitIfPaused }) => {
      await checkpoint({ completed: 1, total: 2 })
      notifyCheckpoint()
      await boundary
      await waitIfPaused()
      return 'done'
    })
    const pausedTask = await runner.create({ kind: 'test.pause', payload: {}, total: 2 })
    await runner.resume(pausedTask.id)
    const execution = runner.waitForCompletion(pausedTask.id)
    await checkpointed
    await runner.pause(pausedTask.id)
    releaseBoundary()
    await vi.waitFor(() => expect(runner.get(pausedTask.id)?.status).toBe('paused'))
    await expect(runner.resume(pausedTask.id)).resolves.toMatchObject({ status: 'running' })
    await expect(execution).resolves.toMatchObject({ status: 'completed' })

    runner.register('test.cancel', async ({ signal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const cancellable = await runner.create({ kind: 'test.cancel', payload: {} })
    await runner.resume(cancellable.id)
    const cancelledExecution = runner.waitForCompletion(cancellable.id)
    await vi.waitFor(() => expect(runner.get(cancellable.id)?.status).toBe('running'))
    expect(await runner.cancel(cancellable.id)).toMatchObject({ status: 'cancelled' })
    await expect(cancelledExecution).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('deduplicates concurrent resumes and redacts secrets from durable errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-single-flight-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const runner = store.getPersistentTaskRunner()
    let calls = 0
    let release!: () => void
    const boundary = new Promise<void>((resolve) => { release = resolve })
    runner.register('test.single', async () => {
      calls += 1
      await boundary
      throw new Error('Authorization: Bearer super-secret-token api_key=sk-private')
    })
    const created = await runner.create({ kind: 'test.single', payload: {} })
    const starts = await Promise.all([runner.resume(created.id), runner.resume(created.id), runner.resume(created.id)])
    expect(starts.every((task) => task.status === 'running')).toBe(true)
    expect(calls).toBe(1)
    const completion = runner.waitForCompletion(created.id)
    release()
    await expect(completion).resolves.toMatchObject({
      status: 'failed',
      error: expect.not.stringContaining('super-secret-token')
    })
    expect(runner.get(created.id)?.error).not.toContain('sk-private')
  })

  it('clears terminal task history without deleting paused work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-retention-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const runner = store.getPersistentTaskRunner()
    runner.register('test.done', async () => 'done')
    const completed = await runner.create({ id: 'done', kind: 'test.done', payload: {} })
    await runner.resume(completed.id)
    await runner.waitForCompletion(completed.id)
    await runner.create({ id: 'paused', kind: 'test.done', payload: {} })
    expect(await runner.clearTerminalTasks()).toEqual([expect.objectContaining({ id: 'paused', status: 'paused' })])
    expect(runner.get('done')).toBeUndefined()
  })

  it('does not let a late checkpoint overwrite cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-tasks-checkpoint-race-'))
    directories.push(directory)
    const store = new AppStore(directory)
    stores.push(store)
    await store.initialize()
    const runner = store.getPersistentTaskRunner()
    let release!: () => void
    const boundary = new Promise<void>((resolve) => { release = resolve })
    runner.register('test.checkpoint-race', async ({ checkpoint }) => {
      await boundary
      await checkpoint({ completed: 1, total: 1 })
      return 'late'
    })
    const created = await runner.create({ kind: 'test.checkpoint-race', payload: {} })
    await runner.resume(created.id)
    const completion = runner.waitForCompletion(created.id)
    await runner.cancel(created.id)
    release()
    await expect(completion).resolves.toMatchObject({ status: 'cancelled' })
    expect(runner.get(created.id)).toMatchObject({ status: 'cancelled', progress: { completed: 0 } })
  })
})
