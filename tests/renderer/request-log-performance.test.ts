import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, GatewayApi, RequestLog } from '../../src/shared/types'
import { I18nProvider } from '../../src/renderer/src/i18n'
import {
  REQUEST_LOG_RENDER_PAGE_SIZE,
  paginateRequestLogs,
} from '../../src/renderer/src/request-log-page'
import {
  displayedRequestFirstTokenMs,
  filterRequestLogs,
  formatTokenBillions,
  summarizeRequestLogs,
} from '../../src/renderer/src/request-log-view-model'
import { GPT_5_6_SOL_WM_MODEL } from '../../src/shared/wm-routing'
import { RequestsView } from '../../src/renderer/src/views/RequestsView'

describe('request log renderer pressure bounds', () => {
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

  it('keeps every page at or below 100 rows while retaining access to 1,000 records', () => {
    const logs = Array.from({ length: 1_000 }, (_, index) => `request-${index}`)
    const pages = Array.from({ length: 10 }, (_, page) => paginateRequestLogs(logs, page))

    expect(REQUEST_LOG_RENDER_PAGE_SIZE).toBe(100)
    expect(Math.max(...pages.map((page) => page.items.length))).toBe(100)
    expect(pages.flatMap((page) => page.items)).toEqual(logs)
    expect(paginateRequestLogs(logs, Number.POSITIVE_INFINITY).page).toBe(0)
    expect(paginateRequestLogs(logs, 999).page).toBe(9)
  })

  it('renders at most 100 live table rows from the 500-record renderer snapshot', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(RequestsView, {
        snapshot: snapshotWithLogs(500),
        api: {} as GatewayApi,
        runAction: async () => true,
        busyKeys: new Set<string>(),
      }),
    ))
    const body = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? ''

    expect(body.match(/<tr(?:\s|>)/g)).toHaveLength(100)
    expect(markup).toContain('Showing 1–100 of 500 matching records')
    expect(markup).toContain('1 / 5')
  })

  it('keeps the unfiltered array identity and filters the complete retained set before pagination', () => {
    const logs = snapshotWithLogs(500).requestLogs
    const accountTypes = new Map<string, RequestLog['credentialType']>()
    const t = (chinese: string, english: string): string => english || chinese

    expect(filterRequestLogs(logs, '', 'all', 'all', accountTypes, t)).toBe(logs)
    const matches = filterRequestLogs(logs, 'account 432', 'success', 'codex', accountTypes, t)
    expect(matches.map((log) => log.id)).toEqual(['request-432'])
    expect(paginateRequestLogs(matches, 0).items).toEqual(matches)
  })

  it('searches and displays the mapped upstream model while retaining the client-requested alias', () => {
    const snapshot = snapshotWithLogs(1)
    const routedLog: RequestLog = {
      ...snapshot.requestLogs[0],
      model: 'codex-client-alias',
      upstreamModel: 'claude-opus-4-8',
    }
    snapshot.requestLogs = [routedLog]
    const accountTypes = new Map<string, RequestLog['credentialType']>()
    const t = (chinese: string, english: string): string => english || chinese

    expect(filterRequestLogs(snapshot.requestLogs, 'claude-opus-4-8', 'all', 'all', accountTypes, t))
      .toEqual([routedLog])
    expect(filterRequestLogs(snapshot.requestLogs, 'codex-client-alias', 'all', 'all', accountTypes, t))
      .toEqual([routedLog])

    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(RequestsView, {
        snapshot,
        api: {} as GatewayApi,
        runAction: async () => true,
        busyKeys: new Set<string>(),
      }),
    ))

    expect(markup).toContain('<strong class="mono">claude-opus-4-8</strong>')
    expect(markup).toContain('← codex-client-alias')
    expect(markup).toContain('title="Client-requested model"')
  })

  it('summarizes the retained logs in one pass without counting compaction first-token timing', () => {
    const logs: RequestLog[] = [
      requestLog({ status: 'success', latencyMs: 100, upstreamModel: GPT_5_6_SOL_WM_MODEL, upstreamFirstByteMs: 4, firstTokenMs: 9000, inputTokens: 2, outputTokens: 3 }),
      requestLog({ id: 'error', status: 'error', latencyMs: 300, firstTokenMs: 60, inputTokens: 5 }),
      requestLog({ id: 'live', status: 'streaming', latencyMs: 20, outputTokens: 7 }),
      requestLog({ id: 'compact', requestKind: 'compaction', status: 'success', latencyMs: 500, firstTokenMs: 9_999 }),
    ]

    expect(summarizeRequestLogs(logs)).toEqual({
      successCount: 2,
      errorCount: 1,
      averageLatency: 300,
      averageFirstByte: 4530,
      totalTokens: 17,
      hasStreaming: true,
    })
  })

  it('keeps the main chain on transport first-byte timing while WM uses meaningful output timing', () => {
    expect(displayedRequestFirstTokenMs(requestLog({
      upstreamFirstByteMs: 4,
      firstTokenMs: 9_000,
    }))).toBe(4)
    expect(displayedRequestFirstTokenMs(requestLog({
      upstreamModel: GPT_5_6_SOL_WM_MODEL,
      upstreamFirstByteMs: 4,
      firstTokenMs: 9_000,
    }))).toBe(9_000)
  })

  it('formats lifetime token totals in compact billions', () => {
    expect(formatTokenBillions(0)).toBe('0b')
    expect(formatTokenBillions(7_346_800)).toBe('0.007b')
    expect(formatTokenBillions(1_250_000_000)).toBe('1.25b')
    expect(formatTokenBillions(12_340_000_000)).toBe('12.3b')
    expect(formatTokenBillions(123_000_000_000)).toBe('123b')
  })
})

function requestLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    id: 'success',
    timestamp: 1,
    client: 'codex',
    protocol: 'openai-responses',
    providerName: 'OpenAI',
    accountName: 'Account',
    model: 'gpt-5.6',
    status: 'success',
    latencyMs: 100,
    ...overrides,
  }
}

function snapshotWithLogs(count: number): AppSnapshot {
  return {
    runtimeRevision: 1,
    providers: [],
    accounts: [],
    accountTags: [],
    proxies: [],
    pools: [],
    routes: [],
    gateway: {
      host: '127.0.0.1',
      port: 15_720,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 120,
      launchAtLogin: false,
      desktopNotifications: false,
      automaticBackups: false,
      backupRetention: 10,
      outboundNetworkMode: 'direct',
    },
    gatewayStatus: {
      running: true,
      host: '127.0.0.1',
      port: 15_720,
      activeRequests: 0,
      totalRequests: count,
      successRequests: count,
    },
    requestLogs: Array.from({ length: count }, (_, index): RequestLog => ({
      id: `request-${index}`,
      timestamp: count - index,
      client: 'codex',
      protocol: 'openai-responses',
      providerName: 'OpenAI',
      accountName: `Account ${index}`,
      model: 'gpt-5.6',
      status: 'success',
      statusCode: 200,
      latencyMs: index + 1,
    })),
    clientProfiles: [],
    healthEvents: [],
    observability: {
      last24Hours: emptyObservability(),
      last7Days: emptyObservability(),
      hourly: [],
      tokenRates: { points: [] },
      tokenCosts: {
        today: emptyTokenCost(),
        allTime: emptyTokenCost(),
      },
    },
    vaultAvailable: true,
    vaultBackend: 'test',
  }
}

function emptyObservability(): AppSnapshot['observability']['last24Hours'] {
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

function emptyTokenCost(): AppSnapshot['observability']['tokenCosts']['today'] {
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
