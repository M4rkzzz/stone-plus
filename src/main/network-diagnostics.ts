import { lookup } from 'node:dns/promises'
import { connect as connectTls } from 'node:tls'
import type {
  NetworkDiagnosticReport,
  NetworkDiagnosticStatus,
  NetworkDiagnosticTargetResult
} from '../shared/types'

const TEST_TIMEOUT_MS = 10_000
const CHATGPT_HOST = 'chatgpt.com'

export type BuiltInProxyDiagnosticCategory =
  | 'core_missing'
  | 'core_integrity'
  | 'config_invalid'
  | 'node_handshake'
  | 'mixed_port'
  | 'tun_elevation'
  | 'subscription_update'
  | 'system_proxy'
  | 'health_check'
  | 'core_crashed'
  | 'unknown'

const BUILT_IN_PROXY_DIAGNOSES: Readonly<Record<BuiltInProxyDiagnosticCategory, string>> = Object.freeze({
  core_missing: '内置代理核心缺失或校验失败：请重新安装完整版本，并确认安全软件未隔离 sing-box 运行文件。',
  core_integrity: '内置代理核心完整性校验失败：请重新安装完整版本，并检查安全软件隔离记录。',
  config_invalid: '内置代理配置无效：请检查当前配置和活动节点，或重新导入订阅。',
  node_handshake: '内置代理节点握手失败：请测试节点延迟、检查节点凭据、系统时间和 TLS/SNI 设置。',
  mixed_port: '内置代理 mixed 端口不可用：请释放已保存端口或在代理页选择新的本地端口。',
  tun_elevation: 'TUN 启动未获得临时提权：请重试并允许本次管理员权限请求。',
  subscription_update: '内置代理订阅更新失败：请检查订阅地址、令牌、网络可达性和返回格式。',
  system_proxy: '内置代理无法接管或恢复系统代理：请检查系统代理设置和第三方代理软件。',
  health_check: '内置代理健康检查未通过：请测试当前节点并检查 mixed 端口。',
  core_crashed: '内置代理核心已退出：请重试启动并查看内置代理日志。',
  unknown: '内置代理发生未知错误：请重试，并在问题持续时导出诊断信息。'
})

export const NETWORK_DIAGNOSTIC_HTTP_TARGETS = Object.freeze([
  { id: 'chatgpt-web', label: 'ChatGPT 网站', url: 'https://chatgpt.com/' },
  { id: 'codex-models', label: 'Codex 模型接口', url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.144.3' },
  { id: 'codex-usage', label: 'Codex 额度接口', url: 'https://chatgpt.com/backend-api/wham/usage' },
  { id: 'openai-auth', label: 'OpenAI OAuth', url: 'https://auth.openai.com/.well-known/openid-configuration' }
])

type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>

export interface NetworkDiagnosticOptions {
  fetchImplementation: FetchImplementation
  route: NetworkDiagnosticReport['route']
  now?: () => number
  lookupImplementation?: typeof lookup
  tlsProbe?: (hostname: string, timeoutMs: number) => Promise<string>
}

export async function runNetworkDiagnostics(options: NetworkDiagnosticOptions): Promise<NetworkDiagnosticReport> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const direct = options.route.kind === 'direct'
  const infrastructure = direct
    ? await Promise.all([
        probeDns(options.lookupImplementation ?? lookup, now),
        probeTls(options.tlsProbe ?? defaultTlsProbe, now)
      ])
    : [
        skippedResult('dns-chatgpt', 'DNS 解析', CHATGPT_HOST, '代理模式下由代理节点处理域名解析。'),
        skippedResult('tls-chatgpt', 'TLS 握手', `${CHATGPT_HOST}:443`, '代理模式下由代理链路建立目标连接。')
      ]
  const httpResults = await Promise.all(NETWORK_DIAGNOSTIC_HTTP_TARGETS.map((target) =>
    probeHttp(options.fetchImplementation, target, now)))
  const results = [...infrastructure, ...httpResults]
  return {
    startedAt,
    finishedAt: now(),
    route: options.route,
    summary: summarize(results),
    results,
    diagnoses: diagnose(results, options.route)
  }
}

async function probeDns(
  lookupImplementation: typeof lookup,
  now: () => number
): Promise<NetworkDiagnosticTargetResult> {
  const startedAt = now()
  try {
    const records = await withTimeout(
      lookupImplementation(CHATGPT_HOST, { all: true, verbatim: true }),
      TEST_TIMEOUT_MS,
      'DNS_TIMEOUT'
    )
    const addresses = [...new Set(records.map((record) => record.address))].slice(0, 6)
    if (addresses.length === 0) throw diagnosticError('DNS_EMPTY', 'DNS 未返回地址')
    return {
      id: 'dns-chatgpt', label: 'DNS 解析', target: CHATGPT_HOST, kind: 'dns', status: 'success',
      latencyMs: elapsed(startedAt, now()), addresses,
      message: `已解析 ${addresses.length} 个地址`
    }
  } catch (error) {
    return failedResult('dns-chatgpt', 'DNS 解析', CHATGPT_HOST, 'dns', startedAt, now(), error)
  }
}

async function probeTls(
  tlsProbe: (hostname: string, timeoutMs: number) => Promise<string>,
  now: () => number
): Promise<NetworkDiagnosticTargetResult> {
  const startedAt = now()
  try {
    const protocol = await tlsProbe(CHATGPT_HOST, TEST_TIMEOUT_MS)
    return {
      id: 'tls-chatgpt', label: 'TLS 握手', target: `${CHATGPT_HOST}:443`, kind: 'tls', status: 'success',
      latencyMs: elapsed(startedAt, now()), message: `握手成功${protocol ? ` · ${protocol}` : ''}`
    }
  } catch (error) {
    return failedResult('tls-chatgpt', 'TLS 握手', `${CHATGPT_HOST}:443`, 'tls', startedAt, now(), error)
  }
}

async function probeHttp(
  fetchImplementation: FetchImplementation,
  target: (typeof NETWORK_DIAGNOSTIC_HTTP_TARGETS)[number],
  now: () => number
): Promise<NetworkDiagnosticTargetResult> {
  const startedAt = now()
  try {
    // AbortSignal is cooperative; custom Chromium/proxy adapters may fail to
    // observe it while their own control plane is stalled. Keep a hard outer
    // race so one bad adapter cannot hang the entire diagnostics report.
    const response = await withTimeout(
      fetchImplementation(target.url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/html;q=0.8, */*;q=0.5',
          'User-Agent': 'StonePlus-NetworkDiagnostics/1.0'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
      }),
      TEST_TIMEOUT_MS,
      'HTTP_TIMEOUT'
    )
    cancelResponseBody(response)
    const status = httpDiagnosticStatus(response.status)
    return {
      id: target.id,
      label: target.label,
      target: displayTarget(target.url),
      kind: 'http',
      status,
      latencyMs: elapsed(startedAt, now()),
      httpStatus: response.status,
      errorCode: response.status === 407 ? 'PROXY_AUTH_REQUIRED' : undefined,
      message: httpStatusMessage(response.status, status)
    }
  } catch (error) {
    return failedResult(target.id, target.label, displayTarget(target.url), 'http', startedAt, now(), error)
  }
}

/**
 * Releasing a diagnostic response must never extend the diagnostic itself.
 * Some proxy/network stacks only settle `cancel()` after the peer closes the
 * connection, so intentionally observe the rejection without awaiting it.
 */
function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // A synchronously throwing, already-locked body is still safe to abandon.
  }
}

function defaultTlsProbe(hostname: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(diagnosticError('TLS_TIMEOUT', 'TLS handshake timed out'))
    }, timeoutMs)
    timer.unref?.()
    const cleanup = (): void => clearTimeout(timer)
    socket.once('secureConnect', () => {
      cleanup()
      const protocol = socket.getProtocol() ?? ''
      socket.end()
      resolve(protocol)
    })
    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(diagnosticError(code, 'Operation timed out')), timeoutMs)
      timer.unref?.()
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function failedResult(
  id: string,
  label: string,
  target: string,
  kind: NetworkDiagnosticTargetResult['kind'],
  startedAt: number,
  finishedAt: number,
  error: unknown
): NetworkDiagnosticTargetResult {
  const code = errorCode(error)
  return {
    id, label, target, kind, status: 'error', latencyMs: elapsed(startedAt, finishedAt),
    errorCode: code,
    message: failureMessage(code)
  }
}

function skippedResult(id: string, label: string, target: string, message: string): NetworkDiagnosticTargetResult {
  return { id, label, target, kind: id.startsWith('dns-') ? 'dns' : 'tls', status: 'skipped', latencyMs: 0, message }
}

function httpDiagnosticStatus(status: number): NetworkDiagnosticStatus {
  if (status === 407) return 'error'
  if (status >= 200 && status < 400) return 'success'
  if (status === 401) return 'success'
  if (status >= 400 && status < 600) return 'warning'
  return 'error'
}

function httpStatusMessage(status: number, diagnosticStatus: NetworkDiagnosticStatus): string {
  if (status === 401) return '接口可达 · 未携带账号凭据，HTTP 401 属预期响应'
  if (status === 403) return '接口可达 · HTTP 403，可能受出口地区、WAF 或访问策略限制'
  if (status === 407) return '代理认证失败 · HTTP 407，请检查代理用户名和密码'
  if (status === 429) return '接口可达 · HTTP 429，当前出口 IP 受到频率限制'
  if (status >= 500) return `接口可达，但上游服务返回 HTTP ${status}`
  return diagnosticStatus === 'success' ? `连接成功 · HTTP ${status}` : `返回 HTTP ${status}`
}

function diagnose(
  results: NetworkDiagnosticTargetResult[],
  route: NetworkDiagnosticReport['route']
): string[] {
  const diagnoses: string[] = []
  const byId = new Map(results.map((result) => [result.id, result]))
  const http = results.filter((result) => result.kind === 'http')
  const codes = results.map((result) => result.errorCode ?? '')
  if (byId.get('dns-chatgpt')?.status === 'error') {
    diagnoses.push('本机无法解析 chatgpt.com：优先检查 DNS、TUN 模式、hosts 文件和安全软件的域名过滤。')
  }
  if (byId.get('tls-chatgpt')?.status === 'error') {
    diagnoses.push('TLS 握手失败：检查系统时间、HTTPS 证书拦截、防火墙和代理软件的 TLS/SNI 支持。')
  }
  if (codes.some((code) => /TIMEOUT/i.test(code))) {
    diagnoses.push('存在连接超时：常见原因是节点不可用、链路拥塞、目标被阻断或代理规则没有命中。')
  }
  if (codes.some((code) => /ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code))) {
    diagnoses.push('连接被中途重置：检查代理节点稳定性、防火墙、杀毒软件和 TLS 分流规则。')
  }
  if (codes.includes('PROXY_AUTH_REQUIRED')) {
    diagnoses.push('代理要求身份认证（HTTP 407）：请检查代理配置中的用户名和密码。')
  }
  for (const category of Object.keys(BUILT_IN_PROXY_DIAGNOSES) as BuiltInProxyDiagnosticCategory[]) {
    if (codes.includes(category)) diagnoses.push(BUILT_IN_PROXY_DIAGNOSES[category])
  }
  if (byId.get('openai-auth')?.status === 'error' && http.some((result) => result.id !== 'openai-auth' && result.status !== 'error')) {
    diagnoses.push('业务接口可达但 OAuth 域名不可达：ChatGPT Access Token 到期后将无法自动续期，请检查 auth.openai.com 分流。')
  }
  if (http.some((result) => result.httpStatus === 403)) {
    diagnoses.push('HTTP 403 表示网络已到达目标，但出口地区、代理 IP 信誉、WAF 或账号访问策略可能受限。')
  }
  if (http.some((result) => result.httpStatus === 429)) {
    diagnoses.push('HTTP 429 表示目标可达，但当前出口 IP 被限频；更换节点或等待限制窗口恢复。')
  }
  if (http.some((result) => (result.httpStatus ?? 0) >= 500)) {
    diagnoses.push('上游端点返回 HTTP 5xx：当前链路尚不可用，请检查代理节点、上游服务状态或稍后重试。')
  }
  const allHttpUnusable = http.length > 0 && http.every((result) => (
    result.status === 'error' || (result.httpStatus ?? 0) >= 500
  ))
  if (allHttpUnusable) {
    diagnoses.push(route.kind === 'proxy'
      ? `所选代理“${route.name}”无法访问全部 GPT 端点：检查代理地址、认证、节点状态和出站规则。`
      : '全部 GPT HTTP 端点均不可达：检查系统代理/TUN、DNS、防火墙及当前网络是否允许访问 OpenAI。')
  }
  if (diagnoses.length === 0) {
    diagnoses.push(summarize(results) === 'success'
      ? '基础网络链路正常。若账号请求仍失败，优先检查凭据有效期、账号权限、额度和模型访问资格。'
      : '网络检查未全部通过：请根据异常端点状态重试或调整出站设置。')
  }
  return [...new Set(diagnoses)].slice(0, 8)
}

function summarize(results: NetworkDiagnosticTargetResult[]): NetworkDiagnosticStatus {
  const http = results.filter((result) => result.kind === 'http')
  if (http.length > 0 && http.every((result) => result.status === 'error')) return 'error'
  if (results.some((result) => result.status === 'error' || result.status === 'warning')) return 'warning'
  return 'success'
}

function displayTarget(value: string): string {
  const url = new URL(value)
  return `${url.hostname}${url.pathname}`
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt)
}

function diagnosticError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function errorCode(error: unknown): string {
  const builtInCategory = nestedBuiltInProxyCategory(error, 3)
  if (builtInCategory) return builtInCategory
  const code = nestedErrorCode(error, 3)
  if (code) return code.slice(0, 80)
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  const name = 'name' in error && typeof error.name === 'string' ? error.name : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  if (/abort|timeout/i.test(`${name ?? ''} ${message}`)) return 'TIMEOUT'
  return (name || 'UNKNOWN').slice(0, 80)
}

/** Normalizes runtime/service aliases into the stable renderer-facing classes. */
export function builtInProxyDiagnosticCategory(value: unknown): BuiltInProxyDiagnosticCategory | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'core_missing') return 'core_missing'
  if (normalized === 'core_integrity') return 'core_integrity'
  if (normalized === 'config_invalid' || normalized === 'configuration_invalid') return 'config_invalid'
  if (normalized === 'node_handshake' || normalized === 'node_handshake_failed') return 'node_handshake'
  if (normalized === 'mixed_port' || normalized === 'mixed_port_unavailable') return 'mixed_port'
  if (normalized === 'tun_elevation' || normalized === 'tun_elevation_denied') return 'tun_elevation'
  if (normalized === 'subscription_update' || normalized === 'subscription_update_failed') return 'subscription_update'
  if (normalized === 'system_proxy') return 'system_proxy'
  if (normalized === 'health_check') return 'health_check'
  if (normalized === 'core_crashed') return 'core_crashed'
  if (normalized === 'unknown') return 'unknown'
  return undefined
}

function nestedBuiltInProxyCategory(error: unknown, maxDepth: number): BuiltInProxyDiagnosticCategory | undefined {
  let current = error
  const visited = new Set<object>()
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) return undefined
    visited.add(current)
    const category = 'category' in current
      ? builtInProxyDiagnosticCategory(current.category)
      : undefined
    if (category) return category
    const code = 'code' in current
      ? builtInProxyDiagnosticCategory(current.code)
      : undefined
    if (code) return code
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

function nestedErrorCode(error: unknown, maxDepth: number): string | undefined {
  let current = error
  const visited = new Set<object>()
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) return undefined
    visited.add(current)
    if ('code' in current && typeof current.code === 'string' && current.code.trim()) {
      return current.code
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

function failureMessage(code: string): string {
  const builtInCategory = builtInProxyDiagnosticCategory(code)
  if (builtInCategory === 'core_missing') return '内置代理核心缺失 · core_missing'
  if (builtInCategory === 'core_integrity') return '内置代理核心校验失败 · core_integrity'
  if (builtInCategory === 'config_invalid') return '内置代理配置无效 · config_invalid'
  if (builtInCategory === 'node_handshake') return '内置代理节点握手失败 · node_handshake'
  if (builtInCategory === 'mixed_port') return '内置代理 mixed 端口不可用 · mixed_port'
  if (builtInCategory === 'tun_elevation') return '内置代理 TUN 提权失败 · tun_elevation'
  if (builtInCategory === 'subscription_update') return '内置代理订阅更新失败 · subscription_update'
  if (builtInCategory === 'system_proxy') return '系统代理接管失败 · system_proxy'
  if (builtInCategory === 'health_check') return '内置代理健康检查失败 · health_check'
  if (builtInCategory === 'core_crashed') return '内置代理核心已退出 · core_crashed'
  if (builtInCategory === 'unknown') return '内置代理未知错误 · unknown'
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return `域名解析失败 · ${code}`
  if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code)) return `TLS/证书校验失败 · ${code}`
  if (/TIMEOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)) return `连接超时 · ${code}`
  if (/ECONNREFUSED/i.test(code)) return `连接被拒绝 · ${code}`
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code)) return `连接被重置 · ${code}`
  return `连接失败 · ${code}`
}
