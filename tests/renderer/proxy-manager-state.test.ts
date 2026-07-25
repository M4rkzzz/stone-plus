import { describe, expect, it } from 'vitest'
import type { ProxyInput } from '../../src/shared/types'
import { nextProxyProtocolDraft } from '../../src/renderer/src/proxy-manager-state'

describe('proxy manager protocol draft state', () => {
  const authenticated: ProxyInput = {
    id: 'proxy',
    name: 'Local proxy',
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    password: '',
    clearPassword: false,
  }

  it('does not accidentally clear a saved password after returning from SOCKS4', () => {
    const socks4 = nextProxyProtocolDraft(authenticated, 'socks4', true, false)
    expect(socks4.clearPassword).toBe(true)

    const restored = nextProxyProtocolDraft(socks4, 'http', true, false)
    expect(restored.clearPassword).toBe(false)
  })

  it('preserves an explicit clear-password choice across protocol changes', () => {
    const explicitlyCleared = { ...authenticated, clearPassword: true }
    const socks4 = nextProxyProtocolDraft(explicitlyCleared, 'socks4', true, true)
    expect(nextProxyProtocolDraft(socks4, 'https', true, true).clearPassword).toBe(true)
  })
})
