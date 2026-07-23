import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BuiltInProxyProfileSummary, BuiltInProxyRuntimeState } from '../../src/shared/types'
import { I18nProvider } from '../../src/renderer/src/i18n'
import {
  ImportPanel,
  ModePanel,
  resolveBuiltInProxyImportSourceKey,
} from '../../src/renderer/src/views/BuiltInProxyView'

const t = (_chinese: string, english: string) => english

describe('built-in proxy import and rule accessibility', () => {
  it('uses linked roving tabs and exposes deterministic keyboard navigation', () => {
    const markup = renderImport('subscription')
    const selected = markup.match(/<button id="([^"]+)"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+)"[^>]*tabindex="0"/)
    const inactive = markup.match(/<button id="([^"]+)"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="([^"]+)"[^>]*tabindex="-1"/)

    expect(selected).not.toBeNull()
    expect(inactive).not.toBeNull()
    expect(markup).toContain(`id="${selected?.[2]}"`)
    expect(markup).toContain(`role="tabpanel" aria-labelledby="${selected?.[1]}"`)
    expect(markup).toContain('aria-orientation="horizontal"')
    expect(resolveBuiltInProxyImportSourceKey('subscription', 'ArrowRight')).toBe('import')
    expect(resolveBuiltInProxyImportSourceKey('subscription', 'ArrowLeft')).toBe('import')
    expect(resolveBuiltInProxyImportSourceKey('import', 'Home')).toBe('subscription')
    expect(resolveBuiltInProxyImportSourceKey('subscription', 'End')).toBe('import')
    expect(resolveBuiltInProxyImportSourceKey('subscription', 'Enter')).toBeUndefined()
  })

  it('programmatically labels pasted configuration and exposes a visible file-input focus target', () => {
    const markup = renderImport('import')
    const textarea = markup.match(/<label for="([^"]+)">Configuration content<\/label><textarea id="([^"]+)"/)
    const css = readFileSync('src/renderer/src/built-in-proxy.css', 'utf8')

    expect(textarea?.[1]).toBe(textarea?.[2])
    expect(markup).toMatch(/<input type="file"[^>]*><span class="built-in-proxy-file__trigger">/)
    expect(css).toContain('.built-in-proxy-file input:focus-visible + .built-in-proxy-file__trigger')
  })

  it('marks custom rule toggles as pressed and labels each free-form match editor', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ModePanel, {
        runtime: runtime(),
        profile: profile(),
        disabled: false,
        pending: false,
        onMode: vi.fn(),
        onCustomRules: vi.fn(async () => true),
        t,
      }),
    ))

    expect(markup).toMatch(/aria-pressed="false"[^>]*><strong>Use profile rules<\/strong>/)
    expect(markup).toMatch(/aria-pressed="true"[^>]*><strong>Custom rules<\/strong>/)
    expect(markup).toContain('aria-label="Rule 1 match values"')
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Proxy<\/button>/)
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Direct<\/button>/)
  })
})

function renderImport(source: 'subscription' | 'import'): string {
  return renderToStaticMarkup(createElement(ImportPanel, {
    source,
    name: '',
    format: '',
    subscriptionUrl: '',
    subscriptionToken: '',
    content: '',
    busy: false,
    disabled: false,
    onSource: vi.fn(),
    onName: vi.fn(),
    onFormat: vi.fn(),
    onSubscriptionUrl: vi.fn(),
    onSubscriptionToken: vi.fn(),
    onContent: vi.fn(),
    onFile: vi.fn(),
    onSubmit: vi.fn(),
    t,
  }))
}

function runtime(): BuiltInProxyRuntimeState {
  return {
    desiredEnabled: true,
    status: 'ready',
    routeGeneration: 1,
    settings: {
      desiredEnabled: true,
      activeProfileId: 'profile-one',
      accessMode: 'system',
      ruleMode: 'rule',
      customRules: {
        rules: [{ id: 'rule-one', condition: 'domain', values: ['api.example.com'], action: 'proxy' }],
        finalAction: 'direct',
      },
      mixedPort: 20800,
      lanEnabled: false,
      autoStart: true,
      hasEverActivated: true,
      updatedAt: 1,
    },
    profiles: [profile()],
    effectiveRoute: { generation: 1, kind: 'built-in-mixed', mixedPort: 20800 },
    accessState: { mode: 'system', status: 'ready', endpoint: 'http://127.0.0.1:20800' },
  }
}

function profile(): BuiltInProxyProfileSummary {
  return {
    id: 'profile-one',
    name: 'Profile one',
    source: 'import',
    format: 'sing-box-json',
    nodes: [],
    nodeCount: 0,
    groupCount: 0,
    ruleStatus: 'preserved',
    activeNodeId: undefined,
    createdAt: 1,
    updatedAt: 1,
  }
}
