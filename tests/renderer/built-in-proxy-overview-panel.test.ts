import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../src/renderer/src/i18n'
import {
  OverviewPanel,
  type ProxyOverviewPanelProps,
} from '../../src/renderer/src/views/built-in-proxy/OverviewPanel'

describe('built-in proxy overview panel', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'en', setItem: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      stone: undefined,
    })
    vi.stubGlobal('navigator', { language: 'en-US' })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders only the supplied takeover, route, preservation, and protection evidence', () => {
    const props: ProxyOverviewPanelProps = {
      takeover: {
        status: 'ready',
        detail: 'Verified after native Windows readback.',
        evidence: [
          { id: 'access', label: 'Access proof', value: 'lease-verified', tone: 'success' },
          { id: 'generation', label: 'Route generation', value: '42' },
        ],
      },
      route: {
        status: 'active',
        stone: { label: 'Stone+', detail: 'new requests' },
        mixed: { label: 'mixed', detail: '127.0.0.1:3198' },
        node: { label: 'Tokyo node', detail: 'selected-node-id' },
      },
      selection: {
        profileName: 'Production profile',
        nodeName: 'Tokyo node',
        ruleMode: 'rule',
        accessMode: 'system',
      },
      externalBindings: { accountCount: 3, poolCount: 2, paused: true },
      externalOutbound: { mode: 'system', preserved: true },
      protection: {
        loopbackBypasses: ['mixed · 127.0.0.1:3198', 'controller · 127.0.0.1:9090'],
        failClosedEnabled: true,
        failClosedActive: false,
      },
      onRetry: vi.fn(),
      onRebuild: vi.fn(),
      onNavigate: vi.fn(),
    }

    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(OverviewPanel, props)),
    )

    expect(markup).toContain('Verified after native Windows readback.')
    expect(markup).toContain('lease-verified')
    expect(markup).toContain('127.0.0.1:3198')
    expect(markup).toContain('Tokyo node')
    expect(markup).toContain('Production profile')
    expect(markup).toContain('Retained, paused')
    expect(markup).toContain('Original retained')
    expect(markup).toContain('controller · 127.0.0.1:9090')
    expect(markup).toContain('Retry takeover')
    expect(markup).toContain('Rebuild low-latency route')
    expect(markup).not.toContain('unprovided-node.example')
  })

  it('does not claim an active route or fail-closed guarantee when props say otherwise', () => {
    const props: ProxyOverviewPanelProps = {
      takeover: { status: 'blocked', evidence: [] },
      route: {
        status: 'blocked',
        stone: { label: 'Stone+' },
        mixed: { label: 'mixed' },
        node: { label: 'Selected node' },
      },
      selection: { ruleMode: 'direct', accessMode: 'tun' },
      externalBindings: { accountCount: 0, poolCount: 0, paused: false },
      externalOutbound: { mode: 'direct', preserved: false },
      protection: {
        loopbackBypasses: [],
        failClosedEnabled: false,
        failClosedActive: false,
      },
    }

    const markup = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(OverviewPanel, props)),
    )

    expect(markup).toContain('Blocked')
    expect(markup).toContain('Route blocked')
    expect(markup).toContain('No blocking guarantee is provided')
    expect(markup).not.toContain('Route active')
    expect(markup).not.toContain('Original retained')
  })
})
