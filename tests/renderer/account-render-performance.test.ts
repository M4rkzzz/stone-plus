import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, GatewayApi, PublicAccount } from '../../src/shared/types'
import { I18nProvider } from '../../src/renderer/src/i18n'
import { ProvidersView } from '../../src/renderer/src/views/ProvidersView'

describe('account renderer pressure bounds', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders at most 100 account rows while bulk state retains all accounts', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ProvidersView, {
        snapshot: snapshotWithAccounts(500),
        api: {} as GatewayApi,
        runAction: async () => true,
        busyKeys: new Set<string>(),
      }),
    ))
    const body = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? ''

    expect(body.match(/<tr(?:\s|>)/g)).toHaveLength(100)
    expect(body.match(/title="Open ChatGPT web with this account"/g)).toHaveLength(100)
    expect(markup).toContain('Showing 1–100 of 500 filtered accounts')
    expect(markup).toContain('Select-all, checks, and bulk actions still apply to the complete filtered result')
  })
})

function snapshotWithAccounts(count: number): AppSnapshot {
  const now = Date.now()
  const accounts: PublicAccount[] = Array.from({ length: count }, (_, index) => ({
    id: `account-${index}`,
    providerId: 'provider-chatgpt-oauth',
    name: `account-${index}@example.com`,
    maskedCredential: 'chatgpt-••••',
    credentialType: 'chatgpt-oauth',
    renewable: true,
    status: 'active',
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    inFlight: 0,
    availableModels: ['gpt-5.6'],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: now,
    updatedAt: now,
  }))
  return {
    runtimeRevision: 1,
    providers: [{
      id: 'provider-chatgpt-oauth',
      name: 'ChatGPT OAuth',
      sourceType: 'oauth-system',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: ['gpt-5.6'],
      createdAt: now,
      updatedAt: now,
    }],
    accounts,
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    gateway: {
      host: '127.0.0.1',
      port: 15_720,
      autoStart: true,
      logPayloads: false,
      requestTimeoutSeconds: 120,
      outboundNetworkMode: 'direct',
    },
    gatewayStatus: {
      running: true,
      host: '127.0.0.1',
      port: 15_720,
      activeRequests: 0,
      totalRequests: 0,
      successRequests: 0,
    },
    requestLogs: [],
    clientProfiles: [],
    healthEvents: [],
    observability: {
      last24Hours: emptySummary(),
      last7Days: emptySummary(),
      hourly: [],
      tokenRates: { points: [] },
      tokenCosts: { today: emptyCost(), allTime: emptyCost() },
    },
    vaultAvailable: true,
    vaultBackend: 'test',
  }
}

function emptySummary(): AppSnapshot['observability']['last24Hours'] {
  return {
    windowStart: 0,
    windowEnd: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    successRate: 0,
    averageLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    failoverCount: 0,
    errorsByStatus: {},
  }
}

function emptyCost(): AppSnapshot['observability']['tokenCosts']['today'] {
  return {
    totalTokens: 0,
    totalCostUsd: 0,
    pricedRequestCount: 0,
    unpricedTokens: 0,
    standardInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }
}
