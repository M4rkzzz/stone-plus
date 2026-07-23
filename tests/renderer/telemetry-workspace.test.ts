import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyConnectionSummary, ProxyTrafficSnapshot } from '../../src/shared/types'
import { I18nProvider } from '../../src/renderer/src/i18n'
import {
  TelemetryWorkspace,
  filterProxyConnections,
  formatTelemetryBytes,
  proxyConnectionFilterOptions,
  type TelemetryConnectionFilters,
} from '../../src/renderer/src/telemetry-workspace'

const connections: ProxyConnectionSummary[] = [
  connection({
    id: 'older-tcp',
    destination: 'api.openai.com:443',
    source: '127.0.0.1:51001',
    network: 'tcp',
    protocol: 'tls',
    outbound: 'proxy-us',
    startedAt: 1_000,
  }),
  connection({
    id: 'newer-udp',
    destination: 'dns.google:53',
    source: '127.0.0.1:51002',
    network: 'udp',
    protocol: 'dns',
    outbound: 'direct',
    startedAt: 2_000,
  }),
  connection({
    id: 'newest-tcp',
    destination: 'api.openai.com:443',
    source: '127.0.0.1:51003',
    network: 'tcp',
    protocol: 'http',
    outbound: 'proxy-us',
    startedAt: 3_000,
  }),
]

describe('telemetry workspace model', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('combines search, target, network, and outbound filters without mutating input', () => {
    const originalOrder = connections.map((item) => item.id)
    const filters: TelemetryConnectionFilters = {
      query: 'OPENAI',
      target: 'api.openai.com:443',
      network: 'tcp',
      outbound: 'proxy-us',
    }

    expect(filterProxyConnections(connections, filters).map((item) => item.id)).toEqual([
      'newest-tcp',
      'older-tcp',
    ])
    expect(connections.map((item) => item.id)).toEqual(originalOrder)
    expect(filterProxyConnections(connections, { ...filters, query: 'dns' })).toEqual([])
  })

  it('derives stable unique target and rule options', () => {
    expect(proxyConnectionFilterOptions(connections)).toEqual({
      targets: ['api.openai.com:443', 'dns.google:53'],
      outbounds: ['direct', 'proxy-us'],
    })
  })

  it('formats byte counters defensively and with useful precision', () => {
    expect(formatTelemetryBytes(-1)).toBe('0 B')
    expect(formatTelemetryBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(formatTelemetryBytes(999)).toBe('999 B')
    expect(formatTelemetryBytes(1_536)).toBe('1.50 KB')
    expect(formatTelemetryBytes(15 * 1024 * 1024)).toBe('15.0 MB')
  })

  it('never presents stale traffic or destinations as current while fail-closed', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(TelemetryWorkspace, {
        state: 'fail-closed',
        traffic: trafficSnapshot(),
        connections,
        onRefresh: () => undefined,
        onCloseConnection: () => undefined,
      }),
    ))

    expect(markup).toContain('连接已安全阻断')
    expect(markup).toContain('显示 0 / 0 个连接')
    expect(markup).not.toContain('api.openai.com')
    expect(markup).not.toContain('1.00 MB/s')
  })

  it('keeps presenting a retained published generation while the parent marks it ready', () => {
    const readyMarkup = renderWorkspace('ready')
    expect(readyMarkup).toContain('api.openai.com:443')
    expect(readyMarkup).toContain('1.00 MB/s')
    expect(refreshButton(readyMarkup)).not.toContain('disabled=""')

    const waitingMarkup = renderWorkspace('waiting')
    expect(waitingMarkup).not.toContain('api.openai.com:443')
    expect(waitingMarkup).not.toContain('1.00 MB/s')
    expect(refreshButton(waitingMarkup)).toContain('disabled=""')
  })

  it('keeps the changing snapshot timestamp outside the polite live region', () => {
    const markup = renderWorkspace('ready')
    const liveRegionStart = markup.indexOf('<span class="telemetry-workspace__result-count"')
    expect(liveRegionStart).toBeGreaterThanOrEqual(0)
    const liveRegionEnd = markup.indexOf('</span>', liveRegionStart)
    const liveRegion = markup.slice(liveRegionStart, liveRegionEnd + '</span>'.length)

    expect(liveRegion).toContain('aria-live="polite"')
    expect(liveRegion).toContain('aria-atomic="true"')
    expect(liveRegion).toContain('显示 3 / 3 个连接')
    expect(liveRegion).not.toContain('快照')
    expect(markup.indexOf('<time', liveRegionEnd)).toBeGreaterThan(liveRegionEnd)
  })

  it('renders a destination-bound close action and locks only the connection being closed', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(TelemetryWorkspace, {
        state: 'ready',
        traffic: trafficSnapshot(),
        connections,
        closingConnectionIds: new Set(['older-tcp']),
        onRefresh: () => undefined,
        onCloseConnection: () => undefined,
      }),
    ))

    const closingRow = rowContaining(markup, '127.0.0.1:51001')
    const otherRow = rowContaining(markup, '127.0.0.1:51003')
    expect(closingRow).toContain('title="断开 api.openai.com:443"')
    expect(closingRow).toContain('disabled=""')
    expect(closingRow).toContain('aria-busy="true"')
    expect(otherRow).toContain('title="断开 api.openai.com:443"')
    expect(otherRow).not.toContain('disabled=""')
    expect(otherRow).not.toContain('aria-busy="true"')
    expect(closingRow).toContain('telemetry-workspace__cell--endpoint')
    expect(closingRow).toContain('telemetry-workspace__cell--action')
  })

  it('interlocks every close action while a conflicting workspace action is pending', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(TelemetryWorkspace, {
        state: 'ready',
        traffic: trafficSnapshot(),
        connections,
        actionsDisabled: true,
        onRefresh: () => undefined,
        onCloseConnection: () => undefined,
      }),
    ))

    for (const item of connections) {
      expect(rowContaining(markup, item.source)).toContain('disabled=""')
    }
  })
})

function rowContaining(markup: string, value: string): string {
  const valueIndex = markup.indexOf(value)
  expect(valueIndex).toBeGreaterThanOrEqual(0)
  const rowStart = markup.lastIndexOf('<tr', valueIndex)
  const rowEnd = markup.indexOf('</tr>', valueIndex)
  expect(rowStart).toBeGreaterThanOrEqual(0)
  expect(rowEnd).toBeGreaterThan(valueIndex)
  return markup.slice(rowStart, rowEnd + '</tr>'.length)
}

function renderWorkspace(state: 'ready' | 'waiting' | 'fail-closed'): string {
  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TelemetryWorkspace, {
      state,
      traffic: trafficSnapshot(),
      connections,
      onRefresh: () => undefined,
      onCloseConnection: () => undefined,
    }),
  ))
}

function refreshButton(markup: string): string {
  const marker = 'telemetry-workspace__refresh'
  const markerIndex = markup.indexOf(marker)
  expect(markerIndex).toBeGreaterThanOrEqual(0)
  const start = markup.lastIndexOf('<button', markerIndex)
  const end = markup.indexOf('</button>', markerIndex)
  return markup.slice(start, end + '</button>'.length)
}

function connection(overrides: Partial<ProxyConnectionSummary> & Pick<ProxyConnectionSummary, 'id'>): ProxyConnectionSummary {
  return {
    id: overrides.id,
    network: overrides.network ?? 'tcp',
    source: overrides.source ?? '127.0.0.1:50000',
    destination: overrides.destination ?? 'example.com:443',
    outbound: overrides.outbound ?? 'proxy',
    uploadBytes: overrides.uploadBytes ?? 1_024,
    downloadBytes: overrides.downloadBytes ?? 2_048,
    startedAt: overrides.startedAt ?? 1_000,
    ...(overrides.protocol ? { protocol: overrides.protocol } : {}),
    ...(overrides.profileId ? { profileId: overrides.profileId } : {}),
    ...(overrides.nodeId ? { nodeId: overrides.nodeId } : {}),
  }
}

function trafficSnapshot(): ProxyTrafficSnapshot {
  return {
    capturedAt: 4_000,
    uploadBytes: 2 * 1024 * 1024,
    downloadBytes: 4 * 1024 * 1024,
    uploadRateBytesPerSecond: 512 * 1024,
    downloadRateBytesPerSecond: 1024 * 1024,
    activeConnections: 3,
    totalConnections: 8,
  }
}
