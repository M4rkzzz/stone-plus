import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    )).toThrow('configured proxy no longer exists')
    expect(() => resolveEffectiveProxy(
      {},
      { proxyId: 'deleted-pool-proxy' },
      proxies
    )).toThrow('configured proxy no longer exists')
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
  it('uses the Chromium system fetch for the complete request URL', async () => {
    const systemProxyFetch = vi.fn(async () => new Response('chromium system route')) as unknown as typeof fetch
    const resolver = vi.fn(async () => 'PROXY 127.0.0.1:7890')
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
      resolveSystemProxy: resolver,
    }))

    const response = await manager.fetchFor(undefined)('https://chatgpt.com/backend-api/codex/models?client_version=1')

    expect(await response.text()).toBe('chromium system route')
    expect(systemProxyFetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models?client_version=1',
      undefined,
    )
    expect(resolver).not.toHaveBeenCalled()
  })

  it('reloads the operating-system proxy configuration as a single flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reloadSystemProxy = vi.fn(async () => gate)
    const manager = trackManager(new OutboundTransportManager({ reloadSystemProxy }))

    const first = manager.reloadSystemProxyConfiguration()
    const second = manager.reloadSystemProxyConfiguration()
    expect(first).toBe(second)
    expect(reloadSystemProxy).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
  })

  it('bounds a stuck operating-system proxy reload and still invalidates cached decisions', async () => {
    const reloadSystemProxy = vi.fn(() => new Promise<void>(() => undefined))
    const manager = trackManager(new OutboundTransportManager({
      reloadSystemProxy,
      systemProxyReloadTimeoutMs: 20,
    }))
    const invalidate = vi.spyOn(manager, 'invalidateSystemProxyCache')

    await expect(manager.reloadSystemProxyConfiguration()).rejects.toMatchObject({
      code: 'SYSTEM_PROXY_RELOAD_TIMEOUT',
    })

    expect(invalidate).toHaveBeenCalled()
    await expect(manager.reloadSystemProxyConfiguration()).rejects.toMatchObject({
      code: 'SYSTEM_PROXY_RELOAD_TIMEOUT',
    })
    expect(reloadSystemProxy).toHaveBeenCalledTimes(2)
  })

  it('preserves the complete target URL when warming and rebuilding native system routes', async () => {
    const target = 'https://relay.example/openai/v1/responses?tenant=stone'
    const systemProxyFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
    }))

    await manager.warmFor(undefined, undefined, target)
    await manager.rebuild(undefined, undefined, [target])

    expect(systemProxyFetch).toHaveBeenNthCalledWith(
      1,
      target,
      expect.objectContaining({ method: 'HEAD' }),
    )
    expect(systemProxyFetch).toHaveBeenNthCalledWith(
      2,
      target,
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it('reports a native system rebuild when any requested target fails to warm', async () => {
    const goodTarget = 'https://relay.example/good/v1'
    const badTarget = 'https://relay.example/bad/v1'
    const systemProxyFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('/bad/')) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
    }))

    await expect(manager.rebuild(undefined, undefined, [goodTarget, badTarget]))
      .rejects.toThrow('ECONNRESET')
    expect(systemProxyFetch).toHaveBeenCalledTimes(2)
  })

  it('uses Chromium for detection and marks proxy authentication as unavailable', async () => {
    const target = 'https://auth.openai.com/.well-known/openid-configuration?probe=1'
    const resolver = vi.fn(async () => 'PROXY corporate.example:8080')
    const systemProxyFetch = vi.fn(async () => new Response('', { status: 407 })) as unknown as typeof fetch
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
      resolveSystemProxy: resolver,
    }))

    const detection = await manager.detectSystemProxy([target])

    expect(resolver).toHaveBeenCalledWith(target)
    expect(systemProxyFetch).toHaveBeenCalledWith(target, expect.objectContaining({ method: 'GET' }))
    expect(detection.targets[0]).toMatchObject({
      target,
      reachable: false,
      summary: 'HTTP corporate.example:8080',
      error: 'PROXY_AUTH_REQUIRED',
    })
  })

  it('bounds a stuck system proxy resolver independently from the target request', async () => {
    const target = 'https://auth.openai.com/.well-known/openid-configuration'
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      resolveSystemProxy: () => new Promise<string>(() => undefined),
      systemProxyResolveTimeoutMs: 20,
    }))

    const detection = await manager.detectSystemProxy([target])

    expect(detection.targets[0]).toMatchObject({
      target,
      summary: 'DIRECT',
      reachable: true,
      error: 'System proxy resolution timed out; using DIRECT.',
    })
  })

  it('marks a native system-proxy HTTP 502 as unreachable', async () => {
    const target = 'https://chatgpt.com/backend-api/codex/models'
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch: vi.fn(async () => new Response(null, { status: 502 })) as unknown as typeof fetch,
      resolveSystemProxy: async () => 'PROXY corporate.example:8080',
    }))

    await expect(manager.detectSystemProxy([target])).resolves.toMatchObject({
      targets: [expect.objectContaining({
        target,
        reachable: false,
        error: 'HTTP_502',
      })],
    })
  })

  it('reports the built-in route that actually owns diagnostic requests', async () => {
    const manager = trackManager(new OutboundTransportManager({ outboundNetworkMode: 'direct' }))
    manager.builtInRoutes.activate({
      fetchImplementation: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      mixedEndpoint: 'http://127.0.0.1:17890',
    })

    expect(manager.describeEffectiveDiagnosticRoute(proxyDefinition({
      id: 'selected-but-shadowed',
      name: 'Selected proxy',
    }))).toEqual({ kind: 'system', name: '内置代理' })
  })

  it('does not wait for a native response body cancellation during detection or warmup', async () => {
    const systemProxyFetch = vi.fn(async () => new Response(new ReadableStream({
      cancel: () => new Promise<void>(() => undefined),
    }), { status: 401 })) as unknown as typeof fetch
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
      resolveSystemProxy: async () => 'DIRECT',
    }))

    const detection = manager.detectSystemProxy(['https://chatgpt.com/backend-api/codex/models'])
    await expect(Promise.race([
      detection.then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 75)),
    ])).resolves.toBe('completed')

    const warming = manager.warmFor(
      undefined,
      undefined,
      'https://chatgpt.com/backend-api/codex/responses',
    )
    await expect(Promise.race([
      warming.then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 75)),
    ])).resolves.toBe('completed')
  })

  it('preserves an actionable code from a nested native transport error', async () => {
    const socketError = Object.assign(new Error('socket failed'), { code: 'ECONNRESET' })
    const systemProxyFetch = vi.fn(async () => {
      throw Object.assign(new TypeError('net::ERR_FAILED'), { cause: socketError })
    }) as unknown as typeof fetch
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyFetch,
      resolveSystemProxy: async () => 'DIRECT',
    }))

    await expect(manager.fetchFor(undefined)('https://chatgpt.com/backend-api/codex/responses'))
      .rejects.toThrow('ECONNRESET')
    await expect(manager.detectSystemProxy(['https://chatgpt.com/backend-api/codex/models']))
      .resolves.toMatchObject({
        targets: [expect.objectContaining({
          reachable: false,
          error: expect.stringContaining('ECONNRESET'),
        })],
      })
  })

  it('caches an exact PAC URL decision and invalidates every URL for its origin', async () => {
    let resolutions = 0
    let now = 1_000
    let proxyConnects = 0
    const origin = await listen(createHttpServer((_request, response) => response.end('through system proxy')))
    const proxy = fixedTunnelProxy(origin.port, () => { proxyConnects += 1 })
    const proxyAddress = await listen(proxy)
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyCacheTtlMs: 1_000,
      now: () => now,
      resolveSystemProxy: async () => {
        resolutions += 1
        return `PROXY 127.0.0.1:${proxyAddress.port}; DIRECT`
      }
    }))
    const fetchImplementation = manager.fetchFor(undefined)

    expect(await (await fetchImplementation('http://system-cache.test/one')).text()).toBe('through system proxy')
    expect(await (await fetchImplementation('http://system-cache.test/one')).text()).toBe('through system proxy')
    expect(resolutions).toBe(1)

    now += 1_001
    expect(await (await fetchImplementation('http://system-cache.test/one')).text()).toBe('through system proxy')
    expect(resolutions).toBe(2)

    manager.invalidateSystemProxyCache('http://system-cache.test')
    expect(await (await fetchImplementation('http://system-cache.test/three')).text()).toBe('through system proxy')
    expect(resolutions).toBe(3)
    expect(proxyConnects).toBeGreaterThan(0)
  })

  it('serves an expired system proxy route while a slow resolver refreshes it', async () => {
    let resolutions = 0
    let now = 1_000
    let refreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshObserved = new Promise<void>((resolve) => { refreshStarted = resolve })
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const origin = await listen(createHttpServer((_request, response) => response.end('stale route stayed hot')))
    const proxyAddress = await listen(fixedTunnelProxy(origin.port))
    const proxyDirective = `PROXY 127.0.0.1:${proxyAddress.port}; DIRECT`
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      systemProxyCacheTtlMs: 1_000,
      now: () => now,
      resolveSystemProxy: async () => {
        resolutions += 1
        if (resolutions === 2) {
          refreshStarted()
          await refreshGate
        }
        return proxyDirective
      }
    }))
    const fetchImplementation = manager.fetchFor(undefined)

    expect(await (await fetchImplementation('http://system-swr.test/resource')).text()).toBe('stale route stayed hot')
    now += 1_001
    const hotRequest = fetchImplementation('http://system-swr.test/resource').then((response) => response.text())
    await refreshObserved
    expect(await Promise.race([
      hotRequest,
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 75))
    ])).toBe('stale route stayed hot')
    expect(resolutions).toBe(2)

    releaseRefresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await (await fetchImplementation('http://system-swr.test/resource')).text()).toBe('stale route stayed hot')
    expect(resolutions).toBe(2)

    manager.invalidateSystemProxyCache('http://system-swr.test')
    expect(await (await fetchImplementation('http://system-swr.test/invalidated')).text()).toBe('stale route stayed hot')
    expect(resolutions).toBe(3)
  })

  it('advances through an ordered PAC proxy chain with a replayable POST body', async () => {
    let receivedBody = ''
    let workingProxyConnects = 0
    const origin = await listen(createHttpServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { receivedBody += String(chunk) })
      request.on('end', () => response.end('posted'))
    }))
    const unavailableProxy = createHttpServer()
    const unavailableAddress = await listen(unavailableProxy)
    await closeServer(unavailableProxy)
    const workingProxyAddress = await listen(fixedTunnelProxy(origin.port, () => { workingProxyConnects += 1 }))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      resolveSystemProxy: async () => (
        `PROXY 127.0.0.1:${unavailableAddress.port}; PROXY 127.0.0.1:${workingProxyAddress.port}; DIRECT`
      )
    }))

    const response = await manager.fetchFor(undefined)('http://pac-fallback.test/request', {
      method: 'POST',
      body: JSON.stringify({ safe: true })
    })

    expect(await response.text()).toBe('posted')
    expect(receivedBody).toBe('{"safe":true}')
    expect(workingProxyConnects).toBeGreaterThan(0)
  })

  it('does not duplicate a one-shot stream body across PAC fallbacks', async () => {
    let backupProxyConnects = 0
    const origin = await listen(createHttpServer((_request, response) => response.end('must not arrive')))
    const unavailableProxy = createHttpServer()
    const unavailableAddress = await listen(unavailableProxy)
    await closeServer(unavailableProxy)
    const backupProxyAddress = await listen(fixedTunnelProxy(origin.port, () => { backupProxyConnects += 1 }))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      resolveSystemProxy: async () => (
        `PROXY 127.0.0.1:${unavailableAddress.port}; PROXY 127.0.0.1:${backupProxyAddress.port}`
      )
    }))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one shot'))
        controller.close()
      }
    })

    await expect(manager.fetchFor(undefined)('http://pac-stream.test/request', {
      method: 'POST',
      body,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })).rejects.toThrow('System proxy request failed')
    expect(backupProxyConnects).toBe(0)
  })

  it('keeps an explicit account proxy ahead of the global system proxy', async () => {
    let systemResolutions = 0
    let explicitConnects = 0
    const origin = await listen(createHttpServer((_request, response) => response.end('explicit proxy')))
    const systemProxyAddress = await listen(fixedTunnelProxy(origin.port))
    const explicitProxyAddress = await listen(fixedTunnelProxy(origin.port, () => { explicitConnects += 1 }))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      resolveSystemProxy: async () => {
        systemResolutions += 1
        return `PROXY 127.0.0.1:${systemProxyAddress.port}`
      }
    }))
    const explicitFetch = manager.fetchFor(proxyDefinition({
      id: 'explicit-account-proxy',
      host: '127.0.0.1',
      port: explicitProxyAddress.port
    }))

    expect(await (await explicitFetch('http://explicit-priority.test/request')).text()).toBe('explicit proxy')
    expect(explicitConnects).toBeGreaterThan(0)
    expect(systemResolutions).toBe(0)
  })

  it('falls back to DIRECT when system proxy resolution fails and warns only once', async () => {
    const warnings: string[] = []
    const origin = await listen(createHttpServer((_request, response) => response.end('direct fallback')))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      resolveSystemProxy: async () => { throw new Error('PAC unavailable') },
      onSystemProxyWarning: (message) => warnings.push(message)
    }))
    const target = `http://127.0.0.1:${origin.port}`

    const first = await manager.detectSystemProxy([target])
    const second = await manager.detectSystemProxy([target])

    expect(first.targets[0]).toMatchObject({ summary: 'DIRECT', reachable: true })
    expect(second.targets[0]).toMatchObject({ summary: 'DIRECT', reachable: true })
    expect(warnings).toEqual(['System proxy resolution failed; using DIRECT.'])
  })

  it('bypasses system proxy resolution for loopback destinations', async () => {
    let resolutions = 0
    const origin = await listen(createHttpServer((_request, response) => response.end('local')))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'system',
      resolveSystemProxy: async () => {
        resolutions += 1
        return 'PROXY 127.0.0.1:7890'
      }
    }))

    const response = await manager.fetchFor(undefined)(`http://127.0.0.1:${origin.port}/local`)

    expect(await response.text()).toBe('local')
    expect(resolutions).toBe(0)
  })

  it('switches new requests to system proxy without interrupting an existing direct stream', async () => {
    let releaseHeld!: () => void
    const directOrigin = await listen(createHttpServer((request, response) => {
      if (request.url === '/held') {
        response.writeHead(200, { 'content-length': '8' })
        response.write('held')
        releaseHeld = () => response.end('done')
      } else response.end('direct')
    }))
    const proxiedOrigin = await listen(createHttpServer((_request, response) => response.end('system')))
    const proxyAddress = await listen(fixedTunnelProxy(proxiedOrigin.port))
    const manager = trackManager(new OutboundTransportManager({
      outboundNetworkMode: 'direct',
      resolveSystemProxy: async () => `PROXY 127.0.0.1:${proxyAddress.port}`
    }))
    const implicitFetch = manager.fetchFor(undefined)
    const held = await implicitFetch(`http://127.0.0.1:${directOrigin.port}/held`)

    manager.configureOutboundNetwork('system', 15721)
    const next = await implicitFetch('http://mode-switch.test/next')
    expect(await next.text()).toBe('system')
    releaseHeld()
    expect(await held.text()).toBe('helddone')
  })

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

  it('does not wait behind a slow warmup before starting a real request', async () => {
    let headStarted!: () => void
    let releaseHead!: () => void
    const headObserved = new Promise<void>((resolve) => { headStarted = resolve })
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        headStarted()
        releaseHead = () => {
          response.writeHead(204)
          response.end()
        }
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('real request did not wait')
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const originUrl = `http://127.0.0.1:${address.port}`

    const warming = manager.warmFor(undefined, undefined, originUrl)
    await headObserved
    const result = await Promise.race([
      manager.fetchFor(undefined)(`${originUrl}/real`).then(async (response) => response.text()),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 75))
    ])

    expect(result).toBe('real request did not wait')
    releaseHead()
    await warming
  })

  it('admits 200 concurrent HTTP/1.1 streams without queueing after the eighth request', async () => {
    const concurrency = 200
    const heldResponses: ServerResponse[] = []
    let allStarted!: () => void
    const allRequestsStarted = new Promise<void>((resolve) => { allStarted = resolve })
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('ready')
      heldResponses.push(response)
      if (heldResponses.length === concurrency) allStarted()
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const originUrl = `http://127.0.0.1:${address.port}`
    const fetchImplementation = manager.fetchFor(undefined)

    let responses: Response[] = []
    try {
      // Every response remains open until all 200 fetches have received their
      // headers. A smaller local pool therefore cannot pass by recycling a few
      // sockets after earlier streams complete.
      responses = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
        fetchImplementation(`${originUrl}/stream-${index}`, {
          signal: AbortSignal.timeout(12_000)
        })
      ))
      await allRequestsStarted
      expect(heldResponses).toHaveLength(concurrency)
    } finally {
      for (const response of heldResponses) response.end('done')
    }

    expect(await Promise.all(responses.map((response) => response.text())))
      .toEqual(Array.from({ length: concurrency }, () => 'readydone'))
  }, 20_000)

  it('keeps the 200-connection budget lazy for a single request', async () => {
    let connections = 0
    const origin = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' })
      response.end('ok')
    })
    origin.on('connection', () => { connections += 1 })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager())
    const originUrl = `http://127.0.0.1:${address.port}`

    const response = await manager.fetchFor(undefined)(`${originUrl}/single`)

    expect(await response.text()).toBe('ok')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connections).toBe(1)
  })

  it('does not retain application-level occupancy when reader cancellation never settles', async () => {
    let heldResponse!: ServerResponse
    const origin = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(204)
        response.end()
        return
      }
      if (request.url === '/held') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('held')
        heldResponse = response
        return
      }
      response.end('next')
    })
    const address = await listen(origin)
    const manager = trackManager(new OutboundTransportManager({ connectionCountForOrigin: () => 1 }))
    const originUrl = `http://127.0.0.1:${address.port}`
    const originalGetReader = ReadableStream.prototype.getReader
    ReadableStream.prototype.getReader = function (...args: Parameters<typeof originalGetReader>) {
      const reader = originalGetReader.apply(this, args)
      return new Proxy(reader, {
        get(target, property, receiver) {
          if (property === 'cancel') return () => new Promise<never>(() => undefined)
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    } as typeof ReadableStream.prototype.getReader

    try {
      await manager.warmFor(undefined, undefined, originUrl)
      const held = await manager.fetchFor(undefined)(`${originUrl}/held`)
      const cancellation = held.body?.cancel()
      expect(await Promise.race([
        cancellation?.then(() => 'cancelled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 75))
      ])).toBe('cancelled')
      const next = await manager.fetchFor(undefined)(`${originUrl}/next`, {
        signal: AbortSignal.timeout(1_000)
      })
      expect(await next.text()).toBe('next')
    } finally {
      ReadableStream.prototype.getReader = originalGetReader
      heldResponse.end()
    }
  })

  it('uses multiple pooled connections for concurrent streams', async () => {
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
    const manager = trackManager(new OutboundTransportManager({ connectionCountForOrigin: () => 2 }))
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
    const manager = trackManager(new OutboundTransportManager({ connectionCountForOrigin: () => 2 }))
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
    const manager = trackManager(new OutboundTransportManager({ connectionCountForOrigin: () => 2 }))
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

  it('forces a dispatcher closed after a short shutdown grace instead of waiting forever', async () => {
    let heldResponse!: ServerResponse
    const origin = createHttpServer((_request, response) => {
      heldResponse = response
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('held-open')
    })
    const address = await listen(origin)
    const manager = new OutboundTransportManager()
    const response = await manager.fetchFor(undefined)(`http://127.0.0.1:${address.port}/held`)
    const startedAt = Date.now()

    await manager.close()

    expect(Date.now() - startedAt).toBeLessThan(2_500)
    heldResponse.end()
    await response.body?.cancel()
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

function fixedTunnelProxy(targetPort: number, onConnect?: () => void): HttpServer {
  const proxy = createHttpServer((_request, response) => {
    response.writeHead(502)
    response.end()
  })
  proxy.on('connect', (_request, clientSocket, head) => {
    onConnect?.()
    const upstream = connectTcp(targetPort, '127.0.0.1')
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.byteLength > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.once('error', () => clientSocket.destroy())
    clientSocket.once('error', () => upstream.destroy())
  })
  return proxy
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
