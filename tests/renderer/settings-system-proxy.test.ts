import { describe, expect, it } from 'vitest'
import {
  systemProxyErrorMessage,
  systemProxyTargetPresentation,
} from '../../src/renderer/src/views/SettingsView'

describe('Settings system proxy presentation', () => {
  it('distinguishes multiple ChatGPT targets by their business purpose and path', () => {
    const responses = systemProxyTargetPresentation(
      'https://chatgpt.com/backend-api/codex/responses',
      'zh-CN',
    )
    const models = systemProxyTargetPresentation(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.144.3',
      'zh-CN',
    )
    const quota = systemProxyTargetPresentation(
      'https://chatgpt.com/backend-api/wham/usage',
      'zh-CN',
    )

    expect([responses.label, models.label, quota.label]).toEqual([
      'Codex 对话接口',
      'Codex 模型接口',
      'Codex 额度接口',
    ])
    expect(new Set([responses.endpoint, models.endpoint, quota.endpoint]).size).toBe(3)
    expect(models.endpoint).toBe('chatgpt.com/backend-api/codex/models')
  })

  it('turns proxy authentication and common transport codes into friendly bilingual guidance', () => {
    expect(systemProxyErrorMessage('PROXY_AUTH_REQUIRED', 'zh-CN')).toBe(
      '系统代理需要认证，请在代理软件或 Windows 代理设置中更新用户名和密码。',
    )
    expect(systemProxyErrorMessage('PROXY_AUTH_REQUIRED', 'en')).toBe(
      'The system proxy requires authentication. Update its username and password in the proxy app or Windows proxy settings.',
    )

    for (const code of [
      'connection timed out (UND_ERR_CONNECT_TIMEOUT)',
      'DNS resolution failed (ENOTFOUND)',
      'connection was refused (ECONNREFUSED)',
      'connection was reset (ECONNRESET)',
      'connection failed (ERR_TUNNEL_CONNECTION_FAILED)',
    ]) {
      const chinese = systemProxyErrorMessage(code, 'zh-CN')
      expect(chinese).not.toContain('UND_ERR_')
      expect(chinese).not.toContain('ENOTFOUND')
      expect(chinese).not.toContain('ECONN')
      expect(chinese).not.toContain('ERR_TUNNEL')
      expect(chinese).toMatch(/[㐀-鿿]/u)
    }
    expect(systemProxyErrorMessage('System proxy resolution failed; using DIRECT.', 'zh-CN'))
      .toContain('未能读取代理路由详情')
  })

  it('does not throw when a backend supplies an invalid target URL', () => {
    expect(systemProxyTargetPresentation('not-a-url', 'en')).toEqual({
      label: 'Upstream target',
      endpoint: 'not-a-url',
    })
  })
})
