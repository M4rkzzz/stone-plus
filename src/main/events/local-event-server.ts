import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalEventServerStatus } from '@shared/types'
import { WebSocket, WebSocketServer } from 'ws'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT_START = 15_741
const DEFAULT_PORT_END = 15_750
const SERVER_FILE = 'event-server.json'

export interface LocalEventEnvelope<T = unknown> {
  version: 1
  id: number
  type: string
  timestamp: number
  payload: T
}

export interface LocalEventServerInfo {
  host: string
  port: number
  token: string
  pid: number
  startedAt: number
  version: 1
}

export interface LocalEventServerOptions {
  userDataPath: string
  host?: string
  portStart?: number
  portEnd?: number
  now?: () => number
  token?: string
}

/**
 * Authenticated, loopback-only event stream for local integrations. The
 * surface is deliberately read-only: renderer or plugin commands continue to
 * use their existing trusted IPC paths instead of growing a second control
 * plane around account credentials.
 */
export class LocalEventServer {
  private readonly userDataPath: string
  private readonly host: string
  private readonly portStart: number
  private readonly portEnd: number
  private readonly now: () => number
  private readonly token: string
  private readonly clients = new Set<WebSocket>()
  private server?: Server
  private webSockets?: WebSocketServer
  private info?: LocalEventServerInfo
  private sequence = 0

  public constructor(options: LocalEventServerOptions) {
    this.userDataPath = options.userDataPath
    this.host = options.host ?? DEFAULT_HOST
    if (!isLoopbackHost(this.host)) throw new Error('Local event server must bind to loopback')
    this.portStart = validPort(options.portStart ?? DEFAULT_PORT_START)
    this.portEnd = validPort(options.portEnd ?? DEFAULT_PORT_END)
    if (this.portEnd < this.portStart) throw new Error('Local event server port range is invalid')
    this.now = options.now ?? Date.now
    this.token = options.token ?? randomBytes(32).toString('base64url')
    if (this.token.length < 32) throw new Error('Local event server token is too short')
  }

  public getInfo(): LocalEventServerInfo | undefined {
    return this.info ? { ...this.info } : undefined
  }

  public getPublicStatus(): LocalEventServerStatus {
    return {
      running: Boolean(this.info),
      ...(this.info ? {
        address: `ws://${formatHost(this.info.host)}:${this.info.port}/events`,
        startedAt: this.info.startedAt
      } : {}),
      discoveryFile: join(this.userDataPath, SERVER_FILE),
      authentication: 'bearer-token',
      connectedClients: [...this.clients].filter((client) => client.readyState === WebSocket.OPEN).length
    }
  }

  public async start(): Promise<LocalEventServerInfo> {
    if (this.info) return { ...this.info }
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    webSockets.on('connection', (socket) => {
      this.clients.add(socket)
      socket.once('close', () => this.clients.delete(socket))
      socket.on('error', () => this.clients.delete(socket))
      socket.on('message', (data, isBinary) => {
        const byteLength = Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength
        if (isBinary || byteLength > 4_096) return socket.close(1008, 'read-only event stream')
        let message: unknown
        try {
          message = JSON.parse(data.toString())
        } catch {
          return socket.close(1007, 'invalid json')
        }
        if (isPingMessage(message)) {
          socket.send(JSON.stringify({ type: 'pong', timestamp: this.now() }))
        } else {
          socket.close(1008, 'read-only event stream')
        }
      })
    })

    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      const server = createServer((request, response) => {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"not_found"}')
      })
      server.on('upgrade', (request, socket, head) => {
        if (!this.authorized(request)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          webSockets.emit('connection', client, request)
        })
      })
      try {
        await listen(server, this.host, port)
        const startedAt = this.now()
        this.server = server
        this.webSockets = webSockets
        this.info = { host: this.host, port, token: this.token, pid: process.pid, startedAt, version: 1 }
        await this.persistInfo(this.info)
        this.publish('server.ready', { host: this.host, port, pid: process.pid })
        return { ...this.info }
      } catch (error) {
        await closeServer(server)
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === this.portEnd) {
          webSockets.close()
          throw error
        }
      }
    }
    webSockets.close()
    throw new Error('No local event server port is available')
  }

  public publish<T>(type: string, payload: T): void {
    if (!this.info || !type.trim()) return
    const recipients = [...this.clients].filter((client) => client.readyState === WebSocket.OPEN)
    // The event server is an optional integration surface. In the common case
    // no plugin is connected, so avoid constructing and serializing envelopes
    // on the gateway request/first-byte hot path.
    if (recipients.length === 0) return
    const envelope: LocalEventEnvelope<T> = {
      version: 1,
      id: ++this.sequence,
      type,
      timestamp: this.now(),
      payload
    }
    const serialized = JSON.stringify(envelope)
    for (const client of recipients) {
      // Avoid an unbounded native socket queue when a plugin stops reading.
      if (client.bufferedAmount > 1024 * 1024) {
        client.close(1013, 'consumer is too slow')
        continue
      }
      client.send(serialized)
    }
  }

  public async close(): Promise<void> {
    const server = this.server
    const webSockets = this.webSockets
    this.server = undefined
    this.webSockets = undefined
    this.info = undefined
    // Shutdown must not wait indefinitely for a plugin that stopped reading or
    // never completes the WebSocket close handshake.
    for (const client of this.clients) client.terminate()
    this.clients.clear()
    await closeWebSockets(webSockets)
    await closeServer(server)
    await rm(join(this.userDataPath, SERVER_FILE), { force: true }).catch(() => undefined)
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    let queryToken: string | undefined
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`)
      if (url.pathname !== '/events') return false
      queryToken = url.searchParams.get('token') ?? undefined
    } catch {
      queryToken = undefined
    }
    return secureEqual(bearer ?? queryToken ?? '', this.token)
  }

  private async persistInfo(info: LocalEventServerInfo): Promise<void> {
    await mkdir(this.userDataPath, { recursive: true, mode: 0o700 })
    const path = join(this.userDataPath, SERVER_FILE)
    const temporaryPath = `${path}.${process.pid}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, path)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function closeServer(server?: Server): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function closeWebSockets(server?: WebSocketServer): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash) && left.length === right.length
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error('Invalid local event server port')
  return value
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost'
}

function formatHost(host: string): string {
  return host === '::1' ? '[::1]' : host
}

function isPingMessage(value: unknown): value is { type: 'ping' } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ping'
}

export const LOCAL_EVENT_SERVER_FILE = SERVER_FILE
