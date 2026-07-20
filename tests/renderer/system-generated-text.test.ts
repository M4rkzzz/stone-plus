import { describe, expect, it } from 'vitest'
import {
  accountDisplayName,
  conversationDisplayName,
  setupPoolDisplayName,
} from '../../src/renderer/src/system-generated-text'

const english = (_chinese: string, value: string) => value
const chinese = (value: string) => value

describe('system-generated renderer text', () => {
  it('localizes setup-created pool names while preserving source names', () => {
    expect(setupPoolDisplayName('向导·OAuth 智能均衡', english)).toBe('Setup · OAuth Smart Balance')
    expect(setupPoolDisplayName('向导·My Relay', english)).toBe('Setup · My Relay')
    expect(setupPoolDisplayName('用户号池', english)).toBe('用户号池')
    expect(setupPoolDisplayName('向导·My Relay', chinese)).toBe('向导·My Relay')
  })

  it('only localizes the recognizable automatic conversation and account placeholders', () => {
    expect(conversationDisplayName('对话 019f7b29…761b', english)).toBe('Conversation 019f7b29…761b')
    expect(conversationDisplayName('对话 产品讨论', english)).toBe('对话 产品讨论')
    expect(accountDisplayName('等待选择', english)).toBe('Pending selection')
    expect(accountDisplayName('等待选择', chinese)).toBe('等待选择')
  })
})
