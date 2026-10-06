import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppSnapshot, GatewayApi } from '../../src/shared/types'

describe('HelpView English rendering', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the default help and quick-start content without Chinese copy', async () => {
    vi.stubGlobal('window', {
      stone: undefined,
      stonePlatform: 'win32',
      localStorage: { getItem: () => 'en', setItem: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    vi.stubGlobal('navigator', { language: 'en-US' })

    const [{ I18nProvider }, { HelpView }] = await Promise.all([
      import('../../src/renderer/src/i18n'),
      import('../../src/renderer/src/views/HelpView'),
    ])
    const snapshot = {
      providers: [], accounts: [], accountTags: [], proxies: [], pools: [], routes: [], clientProfiles: [],
      gatewayStatus: { running: false, host: '127.0.0.1', port: 15721, activeRequests: 0, totalRequests: 0, successRequests: 0 },
    } as unknown as AppSnapshot
    const api = { getClientConfigs: async () => [] } as unknown as GatewayApi

    const markup = renderToStaticMarkup(createElement(I18nProvider, null, createElement(HelpView, { snapshot, api, navigate: () => undefined })))

    expect(markup).toContain('Help center')
    expect(markup).toContain('Understand one request')
    expect(markup).not.toMatch(/[\u3400-\u9fff]/)
  })
})

