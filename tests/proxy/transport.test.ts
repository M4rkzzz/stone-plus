import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OutboundTransportManager,
  proxyEntryAddress,
  resolveEffectiveProxy
} from '../../src/main/proxy'
import type { ProxyProtocol, PublicProxyDefinition } from '../../src/shared/types'

const managers = new Set<OutboundTransportManager>()
const servers = new Set<HttpServer>()

afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.close()))
  managers.clear()
  await Promise.all([...servers].map(closeServer))
  servers.clear()
})

describe('effective proxy resolution', () => {
  const accountProxy = proxyDefinition({ id: 'proxy-account', name: 'Account proxy' })
  const poolProxy = proxyDefinition({ id: 'proxy-pool', name: 'Pool proxy' })
  const proxies = [accountProxy, poolProxy]

  it('prefers an account override over the pool default', () => {
    expect(resolveEffectiveProxy(
      { proxyId: accountProxy.id },
      { proxyId: poolProxy.id },
      proxies
    )).toBe(accountProxy)
  })

  it('uses the pool default when the account has no override', () => {
    expect(resolveEffectiveProxy({}, { proxyId: poolProxy.id }, proxies)).toBe(poolProxy)
  })

  it('uses a direct connection only when neither scope configures a proxy', () => {
    expect(resolveEffectiveProxy({}, {}, proxies)).toBeUndefined()
    expect(resolveEffectiveProxy({}, undefined, proxies)).toBeUndefined()
  })

  it('fails closed when the selected account or pool proxy is missing', () => {
    expect(() => resolveEffectiveProxy(
      { proxyId: 'deleted-account-proxy' },
      { proxyId: poolProxy.id },
      proxies
    )).toThrow('configured outbound proxy no longer exists')
    expect(() => resolveEffectiveProxy(
      {},
      { proxyId: 'deleted-pool-proxy' },
      proxies
    )).toThrow('configured outbound proxy no longer exists')
  })
})

describe('proxy entry presentation', () => {
  it('brackets IPv6 hosts and does not expose proxy credentials', () => {
    const proxy = proxyDefinition({
      protocol: 'socks5',
      host: '2001:db8::10',
      port: 1080,
      username: 'private-user',
      hasPassword: true
    })

    const entryAddress = proxyEntryAddress(proxy)

    expect(entryAddress).toBe('socks5://[2001:db8::10]:1080')
    expect(entryAddress).not.toContain('private-user')
    expect(entryAddress).not.toContain('@')
  })
})

describe('outbound proxy transport', () => {
  it('warms a direct upstream origin before the first application request', async () => {
    let connections = 0
    let headRequests = 0
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        headRequests += 1
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' })
      response.end('ok')
    })
    origin.on('connection', () => { connections += 1 })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const originUrl = `http://127.0.0.1:${address.port}`

    await manager.warmFor(undefined, undefined, originUrl)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const response = await manager.fetchFor(undefined)(`${originUrl}/after-warm`)

    expect(await response.text()).toBe('ok')
    expect(response.url).toBe(`${originUrl}/after-warm`)
    expect(headRequests).toBe(1)
    expect(connections).toBeGreaterThan(0)
  })

  it('does not let a failed speculative warmup block or fail a real request', async () => {
    let headStarted: (() => void) | undefined
    const headObserved = new Promise<void>((resolve) => { headStarted = resolve })
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        headStarted?.()
        request.socket.destroy()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('real request succeeded')
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const originUrl = `http://127.0.0.1:${address.port}`

    const warming = manager.warmFor(undefined, undefined, originUrl)
    const warmingFailure = warming.then(
      () => undefined,
      (error: unknown) => error
    )
    await headObserved
    const response = await manager.fetchFor(undefined)(`${originUrl}/real`)

    expect(await response.text()).toBe('real request succeeded')
    expect(await warmingFailure).toBeInstanceOf(Error)
  })

  it('warms only the primary lane and creates a backup lazily for a concurrent stream', async () => {
    let headRequests = 0
    const requestPorts = new Map<string, number>()
    const heldResponses: ServerResponse[] = []
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        headRequests += 1
        response.writeHead(204)
        response.end()
        return
      }
      requestPorts.set(request.url ?? '', request.socket.remotePort ?? -1)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('ready')
      if (request.url === '/quick') response.end()
      else heldResponses.push(response)
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager({ laneCountForOrigin: () => 2 }))
    const originUrl = `http://127.0.0.1:${address.port}`

    await Promise.all([
      manager.warmFor(undefined, undefined, originUrl),
      manager.warmFor(undefined, undefined, originUrl)
    ])
    const held = await manager.fetchFor(undefined)(`${originUrl}/held`)
    const quick = await manager.fetchFor(undefined)(`${originUrl}/quick`)
    expect(await quick.text()).toBe('ready')
    const next = await manager.fetchFor(undefined)(`${originUrl}/next`)

    expect(headRequests).toBe(1)
    expect(requestPorts.get('/held')).not.toBe(requestPorts.get('/quick'))
    // The free lane may open another HTTP/1.1 socket before Undici has put the
    // just-consumed socket back into its idle queue, but it must not pick the
    // lane whose response body is still held open.
    expect(requestPorts.get('/next')).not.toBe(requestPorts.get('/held'))

    await held.body?.cancel()
    await next.body?.cancel()
    for (const response of heldResponses) response.end()
  })

  it('continues serving sequential requests after a lazy backup has been used', async () => {
    let headRequests = 0
    const requestPorts = new Map<string, number>()
    let releaseHeld!: () => void
    const origin = createHttpServer((request, response) => {
      const port = request.socket.remotePort ?? -1
      if (request.method === 'HEAD') {
        headRequests += 1
        response.writeHead(204)
        response.end()
        return
      }
      requestPorts.set(request.url ?? '', port)
      if (request.url === '/held') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '8' })
        response.write('held')
        releaseHeld = () => response.end('done')
      } else {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' })
        response.end('ok')
      }
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager({ laneCountForOrigin: () => 2 }))
    const originUrl = `http://127.0.0.1:${address.port}`

    await manager.warmFor(undefined, undefined, originUrl)
    const held = await manager.fetchFor(undefined)(`${originUrl}/held`)
    const concurrent = await manager.fetchFor(undefined)(`${originUrl}/concurrent`)
    expect(await concurrent.text()).toBe('ok')
    expect(requestPorts.get('/concurrent')).not.toBe(requestPorts.get('/held'))

    releaseHeld()
    expect(await held.text()).toBe('helddone')
    // Give Undici a turn to return the completed H1 response to its dispatcher.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const sequential = await manager.fetchFor(undefined)(`${originUrl}/sequential`)

    expect(await sequential.text()).toBe('ok')
    expect(headRequests).toBe(1)
  })

  it('warms a replacement generation before atomically rotating traffic', async () => {
    let headRequests = 0
    const requestPorts = new Map<string, number>()
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') headRequests += 1
      else requestPorts.set(request.url ?? '', request.socket.remotePort ?? -1)
      response.writeHead(request.method === 'HEAD' ? 204 : 200)
      response.end(request.method === 'HEAD' ? undefined : 'ok')
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager({ laneCountForOrigin: () => 2 }))
    const originUrl = `http://127.0.0.1:${address.port}`
    const capturedFetch = manager.fetchFor(undefined)

    await manager.warmFor(undefined, undefined, originUrl)
    await (await capturedFetch(`${originUrl}/before`)).text()
    await Promise.all([manager.rotate(), manager.rebuild()])
    expect(manager.fetchFor(undefined)).toBe(capturedFetch)
    // A gateway request can capture its transport before credential resolution.
    // The captured handle must follow an atomic same-configuration rotation
    // rather than dispatching through a generation that is already retiring.
    await (await capturedFetch(`${originUrl}/after`)).text()

    expect(headRequests).toBe(2)
    expect(requestPorts.get('/after')).not.toBe(requestPorts.get('/before'))
  })

  it('does not let an older proxy rotation overwrite a newer proxy generation', async () => {
    let releaseHead!: () => void
    let observeHead!: () => void
    const headObserved = new Promise<void>((resolve) => { observeHead = resolve })
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        observeHead()
        releaseHead = () => {
          response.writeHead(204)
          response.end()
        }
        return
      }
      response.end('ok')
    })
    const originAddress = await listen(origin)
    const proxy = createHttpServer((_request, response) => {
      response.writeHead(502)
      response.end()
    })
    proxy.on('connect', (request, clientSocket, head) => forwardTunnel(request.url, clientSocket, head))
    const proxyAddress = await listen(proxy)
    const manager = trackManager(new OutboundTransportManager())
    const firstProxy = proxyDefinition({ id: 'rotating-proxy', host: '127.0.0.1', port: proxyAddress.port, updatedAt: 1 })
    const secondProxy = { ...firstProxy, updatedAt: 2 }
    const oldConfigurationFetch = manager.fetchFor(firstProxy)

    const rotation = manager.rotate(firstProxy, undefined, [`http://127.0.0.1:${originAddress.port}`])
    await headObserved
    const newerFetch = manager.fetchFor(secondProxy)
    releaseHead()
    await rotation

    expect(manager.fetchFor(secondProxy)).toBe(newerFetch)
    expect(newerFetch).not.toBe(oldConfigurationFetch)
  })

  it('does not resurrect a generation when closed during rotation', async () => {
    let releaseHead!: () => void
    let observeHead!: () => void
    const headObserved = new Promise<void>((resolve) => { observeHead = resolve })
    const origin = createHttpServer((request, response) => {
      observeHead()
      releaseHead = () => {
        response.writeHead(204)
        response.end()
      }
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const rotation = manager.rotate(undefined, undefined, [`http://127.0.0.1:${address.port}`])
    await headObserved
    const closing = manager.close()
    releaseHead()
    await Promise.all([rotation, closing])

    expect(() => manager.fetchFor(undefined)).toThrow('manager is closed')
  })

  it('forwards a real HTTP request through the configured HTTP proxy', async () => {
    let originHits = 0
    let proxyConnects = 0
    const origin = await listen(createHttpServer((_request, response) => {
      originHits += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('served through proxy')
    }))
    const proxy = createHttpServer((_request, response) => {
      response.writeHead(502)
      response.end()
    })
    proxy.on('connect', (request, clientSocket, head) => {
      proxyConnects += 1
      forwardTunnel(request.url, clientSocket, head)
    })
    const proxyAddress = await listen(proxy)
    const manager = trackManager(new OutboundTransportManager())
    const fetchThroughProxy = manager.fetchFor(proxyDefinition({
      host: '127.0.0.1',
      port: proxyAddress.port
    }))

    const response = await fetchThroughProxy(`http://127.0.0.1:${origin.port}/through-proxy`, {
      signal: AbortSignal.timeout(3_000)
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served through proxy')
    expect(proxyConnects).toBe(1)
    expect(originHits).toBe(1)
  })

  it('does not fall back to a direct request when the configured proxy fails', async () => {
    let originHits = 0
    let proxyConnects = 0
    const origin = await listen(createHttpServer((_request, response) => {
      originHits += 1
      response.end('direct access must not happen')
    }))
    const failingProxy = createHttpServer()
    failingProxy.on('connect', (_request, clientSocket) => {
      proxyConnects += 1
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    const proxyAddress = await listen(failingProxy)
    const manager = trackManager(new OutboundTransportManager())
    const fetchThroughProxy = manager.fetchFor(proxyDefinition({
      id: 'failing-proxy',
      host: '127.0.0.1',
      port: proxyAddress.port
    }))

    await expect(fetchThroughProxy(`http://127.0.0.1:${origin.port}/must-not-be-direct`, {
      signal: AbortSignal.timeout(3_000)
    })).rejects.toThrow()
    expect(proxyConnects).toBeGreaterThan(0)
    expect(originHits).toBe(0)
  })

  it.each<ProxyProtocol>(['socks4', 'socks5'])('constructs a %s dispatcher', async (protocol) => {
    const manager = trackManager(new OutboundTransportManager())

    expect(manager.fetchFor(proxyDefinition({
      id: `${protocol}-proxy`,
      protocol,
      host: '127.0.0.1',
      port: 1080
    }))).toBeTypeOf('function')
  })

  it('does not reuse cached authentication when vault access or the password changes', () => {
    const manager = trackManager(new OutboundTransportManager())
    const proxy = proxyDefinition({ id: 'authenticated', hasPassword: true })
    const first = manager.fetchFor(proxy, 'first password')

    expect(() => manager.fetchFor(proxy)).toThrow('authentication is unavailable')
    expect(manager.fetchFor(proxy, 'second password')).not.toBe(first)
  })
})

function proxyDefinition(overrides: Partial<PublicProxyDefinition> = {}): PublicProxyDefinition {
  return {
    id: 'proxy-1',
    name: 'Local proxy',
    protocol: 'http',
    host: '127.0.0.1',
    port: 3128,
    hasPassword: false,
    status: 'unchecked',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

async function listen(server: HttpServer): Promise<{ host: string; port: number }> {
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  return { host: address.address, port: address.port }
}

function forwardTunnel(target: string | undefined, clientSocket: Socket, head: Buffer): void {
  if (!target) {
    clientSocket.destroy()
    return
  }
  const targetUrl = new URL(`http://${target}`)
  const upstream = connectTcp(Number(targetUrl.port || 80), targetUrl.hostname)
  upstream.once('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.byteLength > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.once('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    clientSocket.destroy()
  })
  clientSocket.once('error', () => upstream.destroy())
}

function trackManager(manager: OutboundTransportManager): OutboundTransportManager {
  managers.add(manager)
  return manager
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
