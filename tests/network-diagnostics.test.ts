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

  it('classifies HTTP 407 as a proxy authentication transport failure', async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 407 }))
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'system', name: '系统代理' }
    })

    expect(report.summary).toBe('error')
    expect(report.results.filter((result) => result.kind === 'http')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'error',
          httpStatus: 407,
          errorCode: 'PROXY_AUTH_REQUIRED',
          message: expect.stringContaining('代理认证失败')
        })
      ])
    )
    expect(report.diagnoses).toContain('代理要求身份认证（HTTP 407）：请检查代理配置中的用户名和密码。')
  })

  it('extracts actionable transport codes through a bounded nested cause chain', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('request failed'), {
          cause: Object.assign(new Error('socket failed'), { code: 'ECONNRESET' })
        })
      })
    })
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'system', name: '系统代理' }
    })

    expect(report.results.filter((result) => result.kind === 'http')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'error',
          errorCode: 'ECONNRESET',
          message: expect.stringContaining('连接被重置')
        })
      ])
    )
    expect(report.diagnoses).toContain('连接被中途重置：检查代理节点稳定性、防火墙、杀毒软件和 TLS 分流规则。')
  })

  it.each([
    ['core_missing', '核心缺失'],
    ['config_invalid', '配置无效'],
    ['node_handshake', '节点握手失败'],
    ['mixed_port', 'mixed 端口不可用'],
    ['tun_elevation', 'TUN 启动未获得临时提权'],
    ['subscription_update', '订阅更新失败']
  ] as const)('classifies built-in proxy failures as %s', async (category, guidance) => {
    const fetchImplementation = vi.fn(async () => {
      throw Object.assign(new Error('Built-in route failed'), {
        code: 'BUILT_IN_PROXY_FAIL_CLOSED',
        category
      })
    })
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'system', name: '内置代理' }
    })

    expect(report.results.filter((result) => result.kind === 'http')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'error',
          errorCode: category,
          message: expect.stringContaining(category)
        })
      ])
    )
    expect(report.diagnoses).toEqual(expect.arrayContaining([
      expect.stringContaining(guidance)
    ]))
  })

  it('normalizes a denied TUN elevation alias through a nested cause', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('elevation denied'), { code: 'tun_elevation_denied' })
      })
    })
    const report = await runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'system', name: '内置代理' }
    })

    expect(report.results.filter((result) => result.kind === 'http')).toEqual(
      expect.arrayContaining([expect.objectContaining({ errorCode: 'tun_elevation' })])
    )
  })

  it('does not wait for a response body cancellation that never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const fetchImplementation = vi.fn(async () => ({
      status: 200,
      body: { cancel }
    }) as unknown as Response)

    const diagnostic = runNetworkDiagnostics({
      fetchImplementation,
      route: { kind: 'system', name: '系统代理' }
    })
    const outcome = await Promise.race([
      diagnostic,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])

    expect(outcome).not.toBe('timed-out')
    expect(cancel).toHaveBeenCalledTimes(4)
  })
})
