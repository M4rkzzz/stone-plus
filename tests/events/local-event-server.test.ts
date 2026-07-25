import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  LOCAL_EVENT_SERVER_FILE,
  LocalEventServer,
  startLocalEventServerForBootstrap,
} from '../../src/main/events'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('LocalEventServer', () => {
  it('does not serialize an event when no open integration client exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const server = new LocalEventServer({ userDataPath: directory, portStart: 31_730, portEnd: 31_739, token: 'n'.repeat(48) })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    await server.start()
    let reads = 0
    const payload = Object.defineProperty({}, 'expensive', {
      enumerable: true,
      get() {
        reads += 1
        return 'unused'
      }
    })

    server.publish('request.progress', payload)

    expect(reads).toBe(0)
  })

  it('publishes authenticated loopback events and persists connection info', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const server = new LocalEventServer({ userDataPath: directory, portStart: 31_741, portEnd: 31_749, token: 't'.repeat(48) })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    const info = await server.start()
    expect(server.getPublicStatus()).toMatchObject({
      running: true,
      address: `ws://127.0.0.1:${info.port}/events`,
      authentication: 'bearer-token',
      connectedClients: 0
    })
    expect(server.getPublicStatus()).not.toHaveProperty('token')
    const persisted = JSON.parse(await readFile(join(directory, LOCAL_EVENT_SERVER_FILE), 'utf8')) as typeof info
    expect(persisted).toMatchObject({ host: '127.0.0.1', port: info.port, token: 't'.repeat(48), version: 1 })

    const socket = new WebSocket(`ws://${info.host}:${info.port}/events`, { headers: { authorization: `Bearer ${info.token}` } })
    await onceOpen(socket)
    const event = onceMessage(socket)
    server.publish('request.completed', { id: 'req-1' })
    await expect(event).resolves.toMatchObject({ type: 'request.completed', payload: { id: 'req-1' }, version: 1 })
    socket.close()
  })

  it('rejects unauthenticated upgrades', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const server = new LocalEventServer({ userDataPath: directory, portStart: 31_750, portEnd: 31_759, token: 'u'.repeat(48) })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    const info = await server.start()
    const socket = new WebSocket(`ws://${info.host}:${info.port}/events`)
    socket.on('error', () => undefined)
    const status = await new Promise<number>((resolve) => socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)))
    expect(status).toBe(401)
  })

  it('coalesces concurrent starts into one persisted listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const server = new LocalEventServer({ userDataPath: directory, portStart: 31_760, portEnd: 31_769, token: 'c'.repeat(48) })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    const persistence = vi.spyOn(
      server as unknown as { persistInfo(info: unknown): Promise<void> },
      'persistInfo',
    )

    const [first, second] = await Promise.all([server.start(), server.start()])

    expect(second).toEqual(first)
    expect(persistence).toHaveBeenCalledTimes(1)
  })

  it('fully rolls back listener state and stale discovery data when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const discoveryFile = join(directory, LOCAL_EVENT_SERVER_FILE)
    await writeFile(discoveryFile, '{"stale":true}\n', 'utf8')
    const server = new LocalEventServer({ userDataPath: directory, portStart: 31_770, portEnd: 31_779, token: 'r'.repeat(48) })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    const persistence = vi.spyOn(
      server as unknown as { persistInfo(info: unknown): Promise<void> },
      'persistInfo',
    ).mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(server.start()).rejects.toThrow('disk unavailable')

    expect(server.getInfo()).toBeUndefined()
    expect(server.getPublicStatus()).toMatchObject({ running: false, connectedClients: 0 })
    await expect(readFile(discoveryFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    persistence.mockRestore()
    const recovered = await server.start()
    expect(server.getPublicStatus()).toMatchObject({ running: true, startedAt: recovered.startedAt })
  })

  it('cancels a listener stuck persisting discovery data without resuming bootstrap after close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-events-'))
    const server = new LocalEventServer({
      userDataPath: directory,
      portStart: 31_780,
      portEnd: 31_789,
      token: 'p'.repeat(48),
    })
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve })
    const persistence = vi.spyOn(
      server as unknown as { persistInfo(info: unknown): Promise<void> },
      'persistInfo',
    ).mockImplementation(() => persistenceGate)
    const startOutcome = server.start().then(
      (info) => ({ status: 'started' as const, info }),
      (error: unknown) => ({ status: 'cancelled' as const, error }),
    )
    let stopping = false
    let continuedBootstrap = false
    const bootstrapOutcome = (async () => {
      const result = await startLocalEventServerForBootstrap(server, () => stopping)
      if (result.status === 'stopping' || stopping) return result
      continuedBootstrap = true
      return result
    })()
    await vi.waitFor(() => expect(persistence).toHaveBeenCalledOnce())

    stopping = true
    const closing = server.close()
    const closedBeforePersistence = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ])
    releasePersistence()
    const [outcome, bootstrap] = await Promise.all([startOutcome, bootstrapOutcome])
    await closing

    expect(closedBeforePersistence).toBe(true)
    expect(outcome).toMatchObject({ status: 'cancelled' })
    expect(bootstrap).toEqual({ status: 'stopping' })
    expect(continuedBootstrap).toBe(false)
    expect(server.getPublicStatus()).toMatchObject({ running: false, connectedClients: 0 })
    await expect(readFile(join(directory, LOCAL_EVENT_SERVER_FILE), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps an ordinary optional event startup failure non-fatal to bootstrap', async () => {
    const error = new Error('event stream unavailable')

    await expect(startLocalEventServerForBootstrap({
      start: async () => { throw error },
    }, () => false)).resolves.toEqual({ status: 'unavailable', error })
  })
})

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function onceMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}
