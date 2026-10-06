import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../src/shared/types'
import {
  BUILT_IN_PROXY_BINDING_NOTICE,
  BUILT_IN_PROXY_TAKEOVER_NOTICE,
  shouldInterlockExternalProxyBindings,
  snapshotInterlocksExternalProxyBindings,
} from '../../src/renderer/src/built-in-proxy-interlocks'

describe('built-in proxy renderer interlocks', () => {
  it('keeps external bindings editable for first-time desired-only setup', () => {
    expect(shouldInterlockExternalProxyBindings({
      desiredEnabled: true,
      status: 'disabled',
      settings: { desiredEnabled: true, hasEverActivated: false },
    })).toBe(false)

    expect(snapshotInterlocksExternalProxyBindings({
      builtInProxySettings: { desiredEnabled: true, hasEverActivated: false },
    } as unknown as AppSnapshot)).toBe(false)
  })

  it('uses persisted activation history while the live runtime state is loading', () => {
    expect(snapshotInterlocksExternalProxyBindings({
      builtInProxySettings: { desiredEnabled: true, hasEverActivated: true },
    } as unknown as AppSnapshot)).toBe(true)
  })

  it.each(['starting', 'ready', 'active', 'stopping'])(
    'locks external proxy controls during %s',
    (status) => {
      expect(shouldInterlockExternalProxyBindings({
        desiredEnabled: status !== 'stopping',
        status,
        settings: { hasEverActivated: status !== 'starting' },
      })).toBe(true)
    },
  )

  it('keeps an activated failure fail-closed without locking a first activation error', () => {
    expect(shouldInterlockExternalProxyBindings({
      desiredEnabled: true,
      status: 'error',
      settings: { hasEverActivated: true },
    })).toBe(true)
    expect(shouldInterlockExternalProxyBindings({
      desiredEnabled: true,
      status: 'error',
      settings: { hasEverActivated: false },
    })).toBe(false)
    expect(shouldInterlockExternalProxyBindings({
      desiredEnabled: false,
      status: 'error',
      settings: { hasEverActivated: true },
    })).toBe(true)
  })

  it('unlocks after shutdown even when activation history is retained', () => {
    expect(shouldInterlockExternalProxyBindings({
      desiredEnabled: false,
      status: 'disabled',
      settings: { desiredEnabled: false, hasEverActivated: true },
    })).toBe(false)
  })

  it('uses the required takeover and preserved-binding copy', () => {
    expect(BUILT_IN_PROXY_TAKEOVER_NOTICE.zh).toBe('内置代理接管中，关闭后恢复')
    expect(BUILT_IN_PROXY_BINDING_NOTICE.zh).toBe('绑定已保留，关闭内置代理后恢复')
  })
})
