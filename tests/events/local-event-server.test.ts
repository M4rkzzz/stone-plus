import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { LOCAL_EVENT_SERVER_FILE, LocalEventServer } from '../../src/main/events'

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
