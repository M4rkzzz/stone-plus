import { describe, expect, it, vi } from 'vitest'
import { runNetworkDiagnostics } from '../src/main/network-diagnostics'

describe('network diagnostics', () => {
  it('treats unauthenticated HTTP responses as reachable and reports a healthy direct path', async () => {
    const fetchImplementation = vi.fn(async (input: string) => new Response(null, {
      status: input.includes('openid-configuration') || input === 'https://chatgpt.com/' ? 200 : 401
    }))
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'direct', name: '直连' },
      lookupImplementation: vi.fn(async () => [
        { address: '104.18.32.47', family: 4 },
        { address: '172.64.155.209', family: 4 }
      ]) as never,
      tlsProbe: vi.fn(async () => 'TLSv1.3')
    })

    expect(report.summary).toBe('success')
    expect(report.results).toHaveLength(6)
    expect(report.results.find((result) => result.id === 'dns-chatgpt')).toMatchObject({
      status: 'success', addresses: ['104.18.32.47', '172.64.155.209']
    })
    expect(report.results.find((result) => result.id === 'codex-models')).toMatchObject({
      status: 'success', httpStatus: 401
    })
    expect(report.diagnoses).toEqual([
      '基础网络链路正常。若账号请求仍失败，优先检查凭据有效期、账号权限、额度和模型访问资格。'
    ])
  })

  it('diagnoses timeouts when ChatGPT and Codex routes are unavailable', async () => {
    const fetchImplementation = vi.fn(async (input: string) => {
      if (input.includes('chatgpt.com')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
      return new Response(null, { status: input.includes('openid-configuration') ? 200 : 401 })
    })
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'direct', name: '直连' },
      lookupImplementation: vi.fn(async () => [{ address: '104.18.32.47', family: 4 }]) as never,
      tlsProbe: vi.fn(async () => 'TLSv1.3')
    })

    expect(report.summary).toBe('warning')
    expect(report.diagnoses).toEqual(expect.arrayContaining([
      expect.stringContaining('连接超时')
    ]))
    expect(report.results.some((result) => result.id === 'openai-api')).toBe(false)
  })

  it('skips local DNS/TLS checks for a proxy and identifies a completely unusable proxy route', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    })
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'proxy', name: '测试代理', proxyId: 'proxy-1' }
    })

    expect(report.summary).toBe('error')
    expect(report.results.slice(0, 2).map((result) => result.status)).toEqual(['skipped', 'skipped'])
    expect(report.diagnoses).toContain('所选代理“测试代理”无法访问全部 GPT 端点：检查代理地址、认证、节点状态和出站规则。')
  })

  it('classifies 403 and 429 as reachable warnings instead of transport failures', async () => {
    let index = 0
    const fetchImplementation = vi.fn(async () => new Response(null, { status: index++ % 2 ? 429 : 403 }))
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'proxy', name: '受限节点', proxyId: 'proxy-2' }
    })

    expect(report.summary).toBe('warning')
    expect(report.results.filter((result) => result.kind === 'http').every((result) => result.status === 'warning')).toBe(true)
    expect(report.diagnoses).toEqual(expect.arrayContaining([
      expect.stringContaining('HTTP 403'),
      expect.stringContaining('HTTP 429')
    ]))
  })
})
