import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../src/shared/types'
import { buildLocalChecks } from '../../src/renderer/src/network-test-local-checks'

const t = (chinese: string): string => chinese

function snapshot(overrides: Record<string, unknown> = {}): AppSnapshot {
  return {
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    clientProfiles: [],
    requestLogs: [],
    healthEvents: [],
    gateway: {
      host: '127.0.0.1',
      port: 15721,
      autoStart: true,
      logPayloads: false,
      requestTimeoutSeconds: 120,
      outboundNetworkMode: 'direct',
    },
    gatewayStatus: {
      running: true,
      host: '127.0.0.1',
      port: 15721,
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
    },
    ...overrides,
  } as unknown as AppSnapshot
}

describe('NetworkTestView local checks', () => {
  it('identifies the global system proxy as the default diagnostic route', () => {
    const current = snapshot({
      gateway: {
        ...snapshot().gateway,
        outboundNetworkMode: 'system',
      },
    })

    const proxyCheck = buildLocalChecks(current, '', 'zh-CN', t).find((check) => check.id === 'proxy')

    expect(proxyCheck?.status).toBe('success')
    expect(proxyCheck?.message).toBe('系统代理（全局）')
  })

  it('does not report an unused empty pool as a routing error', () => {
    const current = snapshot({
      providers: [{
        id: 'provider-1', name: 'Official API', sourceType: 'official-api',
        protocol: 'openai-responses', createdAt: 1, updatedAt: 1,
      }],
      accounts: [{
        id: 'account-1', name: 'API key', providerId: 'provider-1',
        credentialType: 'api-key', status: 'active', updatedAt: 1,
      }],
      pools: [{
        id: 'unused-empty-pool', name: 'Unused', kind: 'standard',
        protocol: 'openai-responses', members: [],
      }],
      routes: [{ id: 'route-1', client: 'codex', poolId: 'provider-1', enabled: true }],
    })

    const routingCheck = buildLocalChecks(current, '', 'zh-CN', t).find((check) => check.id === 'routing')

    expect(routingCheck?.status).toBe('success')
    expect(routingCheck?.message).toContain('1 条已启用路由')
  })

  it('still reports an empty pool referenced by an enabled route', () => {
    const current = snapshot({
      pools: [{
        id: 'used-empty-pool', name: 'Used', kind: 'standard',
        protocol: 'openai-responses', members: [],
      }],
      routes: [{ id: 'route-1', client: 'codex', poolId: 'used-empty-pool', enabled: true }],
    })

    const routingCheck = buildLocalChecks(current, '', 'zh-CN', t).find((check) => check.id === 'routing')

    expect(routingCheck?.status).toBe('error')
    expect(routingCheck?.message).toContain('1 个号池没有启用成员')
  })
})
