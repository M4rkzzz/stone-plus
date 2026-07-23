import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltInProxyRuntimeState } from '../../src/shared/types'
import { I18nProvider } from '../../src/renderer/src/i18n'
import {
  SettingsWorkspace,
  type SettingsWorkspacePendingState,
} from '../../src/renderer/src/views/built-in-proxy/SettingsPanel'

describe('built-in proxy settings workspace', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'en', setItem: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    vi.stubGlobal('navigator', { language: 'en-US' })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('claims an applied access mode only for the matching published generation', () => {
    const ready = renderSettings(runtime())
    expect(ready).toContain('System proxy applied')
    expect(ready).toContain('Current runtime port')
    expect(ready).toContain('Verified local loopback address')

    const staleGeneration = renderSettings(runtime({ routeGeneration: 8 }))
    expect(staleGeneration).toContain('Access not verified')
    expect(staleGeneration).not.toContain('System proxy applied')
    expect(staleGeneration).not.toContain('Current runtime port')
    expect(staleGeneration).not.toContain('Verified local loopback address')
  })

  it('shows the persisted planned port while a replacement generation is not ready', () => {
    const replacing = runtime({
      status: 'starting',
      routeGeneration: 8,
      settings: { ...runtime().settings, mixedPort: 4198 },
      accessState: {
        mode: 'system',
        status: 'applying',
        endpoint: 'http://127.0.0.1:3198',
      },
    })

    const markup = renderSettings(replacing)
    expect(markup).toContain('aria-label="Planned endpoints"')
    expect(markup).toContain('Planned value; Stone+ remembers the first automatic selection')
    expect(markup).toContain('127.0.0.1:4198')
    expect(markup).not.toContain('127.0.0.1:3198')
  })

  it.each([
    ['access mode', { accessMode: 'tun' }],
    ['LAN enabled', { lanEnabled: true }],
    ['LAN disabled', { lanEnabled: false }],
    ['auto-start enabled', { autoStart: true }],
    ['auto-start disabled', { autoStart: false }],
  ] satisfies Array<[string, SettingsWorkspacePendingState]>)('locks every access control while %s is pending', (_label, pending) => {
    const markup = renderSettings(runtime(), pending)

    expect(markup).toMatch(/<fieldset[^>]*disabled=""/)
    expect(markup.match(/type="checkbox"[^>]*disabled=""/g)).toHaveLength(2)
    expect(markup).toMatch(/<input(?=[^>]*type="radio")(?=[^>]*checked="")(?=[^>]*value="system")[^>]*>/)
    expect(markup).not.toMatch(/<input(?=[^>]*type="radio")(?=[^>]*checked="")(?=[^>]*value="tun")[^>]*>/)
  })

  it('keeps LAN exposure independent from TUN selection and documents the security boundary', () => {
    const current = runtime({
      settings: { ...runtime().settings, accessMode: 'tun', lanEnabled: true },
      effectiveRoute: {
        generation: 7,
        kind: 'built-in-tun',
        mixedPort: 3198,
      },
      accessState: {
        mode: 'tun',
        status: 'ready',
        endpoint: 'http://127.0.0.1:3198',
        verifiedAt: 2,
      },
    })

    const markup = renderSettings(current)
    expect(markup).toMatch(/<input(?=[^>]*type="radio")(?=[^>]*checked="")(?=[^>]*value="tun")[^>]*>/)
    expect(markup).toContain('aria-label="Current endpoints"')
    expect(markup).toContain('0.0.0.0:3198')
    expect(markup).toContain('The controller always listens on loopback')
    expect(markup).toContain('random secret that is never sent to this page')
    expect(markup).toContain('temporary elevation for the current start')
  })

  it('uses native keyboard controls, concise names, and a single live status', () => {
    const ready = renderSettings(runtime())
    expect(ready).toMatch(/<input(?=[^>]*type="radio")(?=[^>]*aria-labelledby=)(?=[^>]*aria-describedby=)[^>]*>/)
    expect(ready.match(/<input(?=[^>]*type="checkbox")(?=[^>]*role="switch")(?=[^>]*aria-labelledby=)(?=[^>]*aria-describedby=)[^>]*>/g)).toHaveLength(2)
    expect(ready).toMatch(/<dl[^>]*aria-label="Current endpoints"/)
    expect(ready.match(/<dt>/g)).toHaveLength(3)
    expect(ready).toMatch(/<aside[^>]*aria-labelledby=/)

    const switching = renderSettings(runtime(), { accessMode: 'tun' })
    expect(switching).toContain('Switching access mode')
    expect(switching.match(/role="status"/g)).toHaveLength(1)
    expect(switching).not.toContain('System proxy applied')
  })

  it('retains the 320px readability and overflow contract', () => {
    const css = readFileSync(new URL(
      '../../src/renderer/src/views/built-in-proxy/SettingsPanel.css',
      import.meta.url,
    ), 'utf8')
    const narrow = css.slice(css.indexOf('@media (max-width: 420px)'))

    expect(narrow).toContain('padding: 10px')
    expect(narrow).toContain('grid-template-columns: 32px minmax(0, 1fr) 15px')
    expect(narrow).toContain('min-height: 58px')
    expect(narrow).toContain('overflow-wrap: anywhere')
    expect(narrow).toContain('white-space: normal')
  })

  it('keeps the LAN confirmation open after a rejected change and closes it only after success', async () => {
    const setConfirmLan = vi.fn()
    const MockConfirmDialog = () => null
    vi.resetModules()
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react')
      return {
        ...actual,
        useEffect: () => undefined,
        useId: () => 'settings-test-id',
        useRef: <T>(value: T) => ({ current: value }),
        useState: () => [true, setConfirmLan] as const,
      }
    })
    vi.doMock('../../src/renderer/src/i18n', () => ({
      useI18n: () => ({ t: <T>(_chinese: T, english: T) => english }),
    }))
    vi.doMock('../../src/renderer/src/ui', () => ({ ConfirmDialog: MockConfirmDialog }))

    const { SettingsWorkspace: IsolatedSettingsWorkspace } = await import(
      '../../src/renderer/src/views/built-in-proxy/SettingsPanel'
    )
    const confirm = async (result: boolean | Promise<boolean>) => {
      setConfirmLan.mockClear()
      const tree = IsolatedSettingsWorkspace({
        runtime: runtime(),
        onAccessModeChange: () => undefined,
        onLanEnabledChange: () => result,
        onAutoStartChange: () => undefined,
      })
      const dialog = findElementByType(tree, MockConfirmDialog)
      expect(dialog?.props.open).toBe(true)
      dialog?.props.onConfirm?.()
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }

    await confirm(false)
    expect(setConfirmLan).not.toHaveBeenCalled()

    await confirm(Promise.resolve(false))
    expect(setConfirmLan).not.toHaveBeenCalled()

    await confirm(true)
    expect(setConfirmLan).toHaveBeenCalledWith(false)

    vi.doUnmock('react')
    vi.doUnmock('../../src/renderer/src/i18n')
    vi.doUnmock('../../src/renderer/src/ui')
    vi.resetModules()
  })
})

interface TestElement {
  type?: unknown
  props: {
    children?: unknown
    open?: boolean
    onConfirm?: () => void
  }
}

function findElementByType(node: unknown, type: unknown): TestElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByType(child, type)
      if (match) return match
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as Partial<TestElement>
  if (element.type === type && element.props) return element as TestElement
  return findElementByType(element.props?.children, type)
}

function runtime(overrides: Partial<BuiltInProxyRuntimeState> = {}): BuiltInProxyRuntimeState {
  const base: BuiltInProxyRuntimeState = {
    desiredEnabled: true,
    status: 'ready',
    routeGeneration: 7,
    settings: {
      desiredEnabled: true,
      accessMode: 'system',
      ruleMode: 'rule',
      mixedPort: 3198,
      lanEnabled: false,
      autoStart: true,
      hasEverActivated: true,
      updatedAt: 1,
    },
    profiles: [],
    effectiveRoute: {
      generation: 7,
      kind: 'built-in-mixed',
      mixedPort: 3198,
    },
    accessState: {
      mode: 'system',
      status: 'ready',
      endpoint: 'http://127.0.0.1:3198',
      verifiedAt: 2,
    },
  }
  return { ...base, ...overrides }
}

function renderSettings(
  state: BuiltInProxyRuntimeState,
  pending: SettingsWorkspacePendingState = {},
): string {
  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(SettingsWorkspace, {
      runtime: state,
      pending,
      onAccessModeChange: vi.fn(),
      onLanEnabledChange: vi.fn(),
      onAutoStartChange: vi.fn(),
    }),
  ))
}
