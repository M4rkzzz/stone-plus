import { describe, expect, it } from 'vitest'
import { operationLabelForKey, operationShouldNotify } from '../../src/renderer/src/operation-center'

describe('operation feedback metadata', () => {
  it('turns identifier-bearing action keys into safe human-readable labels', () => {
    expect(operationLabelForKey('check-account-secret-id', 'zh-CN')).toBe('检测账号')
    expect(operationLabelForKey('save-route-private-id', 'en')).toBe('Save route')
    expect(operationLabelForKey('agent-restart', 'zh-CN')).toBe('重启 Agent')
    expect(operationLabelForKey('unknown-sensitive-id', 'en')).toBe('Run operation')
  })

  it('only raises success toasts for important global operations while always surfacing errors', () => {
    expect(operationShouldNotify('save-account', 'success')).toBe(false)
    expect(operationShouldNotify('gateway-power', 'success')).toBe(true)
    expect(operationShouldNotify('save-account', 'error')).toBe(true)
  })
})
