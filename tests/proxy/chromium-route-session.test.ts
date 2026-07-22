import { describe, expect, it, vi } from 'vitest'
import { createChromiumMixedSessionGeneration } from '../../src/main/proxy/built-in/chromium-route-session'

describe('built-in Chromium mixed session generation', () => {
  it('pins a fresh session to the checked loopback mixed endpoint and resets only that session', async () => {
    const setProxy = vi.fn(async () => undefined)
    const forceReloadProxyConfig = vi.fn(async () => undefined)
    const resolveProxy = vi.fn(async () => 'PROXY 127.0.0.1:23456')
    const closeAllConnections = vi.fn(async () => undefined)
    const sessionFetch = vi.fn(async () => new Response('ok'))
    const generation = await createChromiumMixedSessionGeneration({
      mixedEndpoint: 'http://127.0.0.1:23456',
      createSession: () => ({
        setProxy,
        forceReloadProxyConfig,
        resolveProxy,
        closeAllConnections,
        fetch: sessionFetch,
      }) as never,
    })

    expect(setProxy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:23456',
      proxyBypassRules: expect.stringContaining('127.0.0.0/8'),
    }))
    await generation.fetchImplementation('https://example.com')
    expect(sessionFetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      bypassCustomProtocolHandlers: true,
    }))
    await generation.refresh()
    await generation.dispose()
    expect(closeAllConnections).toHaveBeenCalledTimes(2)
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
  })

  it('rejects non-loopback endpoints and DIRECT verification results', async () => {
    await expect(createChromiumMixedSessionGeneration({
      mixedEndpoint: 'http://proxy.example:1080',
      createSession: vi.fn() as never,
    })).rejects.toThrow(/loopback/)

    const closeAllConnections = vi.fn(async () => undefined)
    await expect(createChromiumMixedSessionGeneration({
      mixedEndpoint: 'http://127.0.0.1:1080',
      createSession: () => ({
        setProxy: vi.fn(async () => undefined),
        forceReloadProxyConfig: vi.fn(async () => undefined),
        resolveProxy: vi.fn(async () => 'DIRECT'),
        closeAllConnections,
      }) as never,
    })).rejects.toThrow(/did not resolve/)
    expect(closeAllConnections).toHaveBeenCalledOnce()
  })
})
