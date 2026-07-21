import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Clock3,
  Gauge,
  LoaderCircle,
  Network,
  RefreshCw,
  Route,
  ShieldCheck
} from 'lucide-react'
import type {
  AppSnapshot,
  GatewayApi,
  NetworkDiagnosticReport,
  NetworkDiagnosticStatus,
  NetworkDiagnosticTargetResult
} from '@shared/types'
import { listRouteSources } from '@shared/route-sources'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { useI18n, type UiLanguage } from '../i18n'
import { Badge, durationLabel, PageHeader } from '../ui'

const statusTones: Record<NetworkDiagnosticStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  skipped: 'neutral'
}

export function NetworkTestView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const { t, language, locale } = useI18n()
  const [proxyId, setProxyId] = useState('')
  const [report, setReport] = useState<NetworkDiagnosticReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    setRunning(true)
    setError('')
    try {
      setReport(await api.runNetworkDiagnostics(proxyId ? { proxyId } : {}))
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('网络诊断运行失败', 'Network diagnostics failed')))
    } finally {
      setRunning(false)
    }
  }

  const metrics = useMemo(() => reportMetrics(report), [report])
  const localChecks = useMemo(() => buildLocalChecks(snapshot, proxyId, language, t), [language, proxyId, snapshot, t])
  return <div className="page-stack network-test-page">
    <PageHeader
      title={t('诊断', 'Diagnostics')}
      actions={<button className="button button--primary" type="button" disabled={running} onClick={() => void run()}>
        {running ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
        {running ? t('正在诊断…', 'Running diagnostics…') : report ? t('重新诊断', 'Run again') : t('一键诊断', 'Run diagnostics')}
      </button>}
    />

    <section className="panel network-test-controls">
      <div className="network-test-route">
        <span className="network-test-route__icon"><Route size={19} /></span>
        <div><strong>{t('测试网络出口', 'Network route to test')}</strong><span>{t('使用 Stone+ 实际出站链路，不会发送账号凭据', 'Uses Stone+’s actual outbound route without sending account credentials')}</span></div>
        <select aria-label={t('测试网络出口', 'Network route to test')} value={proxyId} disabled={running} onChange={(event) => setProxyId(event.target.value)}>
          <option value="">{t('直连（系统网络）', 'Direct (system network)')}</option>
          {snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}
        </select>
      </div>
      <div className="network-test-scope"><ShieldCheck size={16} /><span>{t('仅访问内置白名单端点；Codex 测试不携带 Token，收到 401 代表接口可达。', 'Only built-in allowlisted endpoints are contacted. Codex probes send no token; HTTP 401 confirms that the endpoint is reachable.')}</span></div>
    </section>

    <section className="panel panel--flush network-test-local">
      <header className="panel__header"><div><h2>{t('本地运行与配置', 'Local runtime and configuration')}</h2></div><ShieldCheck size={18} /></header>
      <div className="network-test-local__grid">{localChecks.map((check) => <article key={check.id}>
        <span className={`network-test-local__icon network-test-local__icon--${check.status}`}><SummaryIcon status={check.status} /></span>
        <div><strong>{check.label}</strong><p>{check.message}</p></div>
        <Badge tone={statusTones[check.status]}>{statusLabel(check.status, t)}</Badge>
      </article>)}</div>
    </section>

    {error && <div className="network-test-alert network-test-alert--error"><CircleX size={18} /><div><strong>{t('诊断未完成', 'Diagnostics did not complete')}</strong><span>{error}</span></div></div>}
    {running && <section className="panel network-test-running"><LoaderCircle size={24} className="spin" /><div><strong>{t('正在并行检测 GPT 网络', 'Testing GPT connectivity in parallel')}</strong><span>{t('通常需要 2–10 秒，超时项目最多等待 10 秒。', 'This normally takes 2–10 seconds. A timed-out check waits at most 10 seconds.')}</span></div></section>}

    {report && !running && <>
      <section className={`network-test-alert network-test-alert--${report.summary}`}>
        <SummaryIcon status={report.summary} />
        <div><strong>{summaryTitle(report.summary, t)}</strong><span>{diagnosticRouteName(report, language)} · {new Date(report.finishedAt).toLocaleString(locale)}</span></div>
      </section>

      <section className="network-test-metrics" aria-label={t('网络诊断汇总', 'Network diagnostic summary')}>
        <article><CheckCircle2 size={18} /><span>{t('可达项目', 'Reachable')}</span><strong>{metrics.reachable} / {metrics.tested}</strong></article>
        <article><Gauge size={18} /><span>{t('最慢请求', 'Slowest check')}</span><strong>{metrics.slowest === undefined ? '—' : durationLabel(metrics.slowest)}</strong></article>
        <article><Clock3 size={18} /><span>{t('总耗时', 'Total time')}</span><strong>{durationLabel(report.finishedAt - report.startedAt)}</strong></article>
      </section>

      <section className="panel panel--flush network-test-results">
        <header className="panel__header"><div><h2>{t('检测项目', 'Checks')}</h2></div><Network size={18} /></header>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('项目', 'Check')}</th><th>{t('目标', 'Target')}</th><th>{t('状态', 'Status')}</th><th>{t('耗时', 'Time')}</th><th>{t('结果', 'Result')}</th></tr></thead>
          <tbody>{report.results.map((result) => <ResultRow result={result} language={language} t={t} key={result.id} />)}</tbody>
        </table></div>
      </section>

      <section className="panel network-test-diagnoses">
        <header className="panel__header"><div><h2>{t('可能原因与建议', 'Possible causes and recommendations')}</h2></div><AlertTriangle size={18} /></header>
        <ol>{localizedDiagnoses(report, language).map((diagnosis, index) => <li key={`${index}-${diagnosis}`}><span>{index + 1}</span><p>{diagnosis}</p></li>)}</ol>
      </section>
    </>}

    {!report && !running && <section className="panel network-test-empty">
      <Network size={28} /><strong>{t('尚未运行网络诊断', 'Diagnostics have not been run')}</strong><span>{t('选择直连或一个已配置代理，然后点击“一键诊断”。', 'Choose direct access or a configured proxy, then run diagnostics.')}</span>
    </section>}
  </div>
}

type Translator = (chinese: string, english: string) => string

function ResultRow({ result, language, t }: { result: NetworkDiagnosticTargetResult; language: UiLanguage; t: Translator }) {
  return <tr>
    <td><strong>{diagnosticLabel(result.id, result.label, language)}</strong><span className="row-note">{kindLabel(result.kind, t)}</span></td>
    <td><code>{result.target}</code>{result.addresses?.length ? <span className="row-note" title={result.addresses.join(', ')}>{result.addresses.join(' · ')}</span> : null}</td>
    <td><Badge tone={statusTones[result.status]}>{statusLabel(result.status, t)}</Badge></td>
    <td>{result.status === 'skipped' ? '—' : durationLabel(result.latencyMs)}</td>
    <td><span className={result.status === 'error' ? 'network-test-result--error' : ''}>{diagnosticMessage(result, language)}</span></td>
  </tr>
}

function SummaryIcon({ status }: { status: NetworkDiagnosticStatus }) {
  if (status === 'success') return <CheckCircle2 size={20} />
  if (status === 'error') return <CircleX size={20} />
  return <AlertTriangle size={20} />
}

function statusLabel(status: NetworkDiagnosticStatus, t: Translator): string {
  if (status === 'success') return t('正常', 'Healthy')
  if (status === 'warning') return t('需关注', 'Attention')
  if (status === 'error') return t('失败', 'Failed')
  return t('由代理处理', 'Handled by proxy')
}

function summaryTitle(status: NetworkDiagnosticStatus, t: Translator): string {
  if (status === 'success') return t('GPT 网络链路正常', 'GPT connectivity is healthy')
  if (status === 'error') return t('GPT 网络整体不可达', 'GPT services are unreachable')
  return t('部分网络项目需要关注', 'Some connectivity checks need attention')
}

function kindLabel(kind: NetworkDiagnosticTargetResult['kind'], t: Translator): string {
  if (kind === 'dns') return t('域名解析', 'DNS resolution')
  if (kind === 'tls') return t('证书与加密握手', 'Certificate and TLS handshake')
  return t('HTTP 接口', 'HTTP endpoint')
}

function reportMetrics(report: NetworkDiagnosticReport | null): { reachable: number; tested: number; slowest?: number } {
  if (!report) return { reachable: 0, tested: 0 }
  const tested = report.results.filter((result) => result.status !== 'skipped')
  const reachable = tested.filter((result) => result.status === 'success' || result.status === 'warning').length
  const latencies = tested.map((result) => result.latencyMs).filter((value) => value > 0)
  return { reachable, tested: tested.length, slowest: latencies.length ? Math.max(...latencies) : undefined }
}

function diagnosticRouteName(report: NetworkDiagnosticReport, language: UiLanguage): string {
  if (report.route.kind === 'direct') return language === 'zh-CN' ? '直连' : 'Direct'
  if (report.route.kind === 'system') return language === 'zh-CN' ? '跟随系统代理' : 'System proxy'
  return report.route.name
}

interface LocalDiagnosticCheck {
  id: string
  label: string
  status: NetworkDiagnosticStatus
  message: string
}

function buildLocalChecks(snapshot: AppSnapshot, proxyId: string, language: UiLanguage, t: Translator): LocalDiagnosticCheck[] {
  const now = Date.now()
  const activeAccounts = snapshot.accounts.filter((account) => account.status === 'active').length
  const unavailableAccounts = snapshot.accounts.filter((account) => account.status === 'disabled' || account.status === 'expired').length
  const exhaustedAccounts = snapshot.accounts.filter((account) =>
    account.cooldownReason === 'quota' && (account.cooldownUntil === undefined || account.cooldownUntil > now)).length
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled)
  const availableSourceIds = new Set(listRouteSources(snapshot).map((source) => source.id))
  const invalidRoutes = enabledRoutes.filter((route) => !availableSourceIds.has(route.poolId)).length
  const emptyPools = snapshot.pools.filter((pool) => !pool.members.some((member) =>
    member.enabled && snapshot.accounts.some((account) => account.id === member.accountId))).length
  const expiringOAuth = snapshot.accounts.filter((account) => account.credentialType === 'chatgpt-oauth'
    && account.credentialExpiresAt !== undefined && account.credentialExpiresAt <= now + 15 * 60_000
    && account.renewable !== true).length
  const proxy = proxyId ? snapshot.proxies.find((candidate) => candidate.id === proxyId) : undefined
  return [
    {
      id: 'gateway', label: t('本地网关', 'Local gateway'),
      status: snapshot.gatewayStatus.running ? 'success' : 'warning',
      message: snapshot.gatewayStatus.running
        ? t(`运行中 · ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} · ${snapshot.gatewayStatus.activeRequests} 个活跃请求`, `Running · ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} · ${snapshot.gatewayStatus.activeRequests} active requests`)
        : t('当前未启动；网络诊断仍可运行，但客户端暂时无法通过 Stone+ 请求。', 'Not running. Diagnostics remain available, but clients cannot currently send requests through Stone+.')
    },
    {
      id: 'accounts', label: t('上游账号', 'Upstream accounts'),
      status: activeAccounts > 0 ? unavailableAccounts > 0 || exhaustedAccounts > 0 ? 'warning' : 'success' : 'error',
      message: t(`${activeAccounts} 个可用 · ${unavailableAccounts} 个停用/过期 · ${exhaustedAccounts} 个额度冷却`, `${activeAccounts} available · ${unavailableAccounts} disabled/expired · ${exhaustedAccounts} quota cooldown`)
    },
    {
      id: 'routing', label: t('源与客户端路由', 'Sources and client routes'),
      status: invalidRoutes > 0 || emptyPools > 0 ? 'error' : enabledRoutes.length > 0 ? 'success' : 'warning',
      message: invalidRoutes > 0 || emptyPools > 0
        ? t(`${invalidRoutes} 条路由缺少可用源 · ${emptyPools} 个号池没有启用成员`, `${invalidRoutes} routes lack a usable source · ${emptyPools} pools have no enabled members`)
        : t(`${snapshot.pools.length} 个号池/聚合中转 · ${enabledRoutes.length} 条已启用路由`, `${snapshot.pools.length} pools/aggregates · ${enabledRoutes.length} enabled routes`)
    },
    {
      id: 'oauth', label: t('ChatGPT OAuth 会话', 'ChatGPT OAuth sessions'),
      status: expiringOAuth > 0 ? 'warning' : 'success',
      message: expiringOAuth > 0
        ? t(`${expiringOAuth} 个不可续期会话将在 15 分钟内过期，需要重新导入。`, `${expiringOAuth} non-renewable sessions expire within 15 minutes and must be imported again.`)
        : t('未发现即将到期且无法自动续期的 ChatGPT 会话。', 'No ChatGPT sessions are both near expiry and unable to renew automatically.')
    },
    {
      id: 'proxy', label: t('本次测试出口', 'Route used for this test'),
      status: proxyId && !proxy ? 'error' : proxy?.status === 'error' ? 'warning' : 'success',
      message: proxy
        ? `${proxy.name} · ${proxy.protocol.toUpperCase()} · ${proxy.status === 'available' ? t(`已验证${proxy.exitIp ? ` · ${proxy.exitIp}` : ''}`, `Verified${proxy.exitIp ? ` · ${proxy.exitIp}` : ''}`) : proxy.status === 'error' ? localizeBackendMessage(proxy.lastError, language, t('上次检测失败', 'Last proxy check failed.')) : t('尚未单独检测', 'Not tested separately')}`
        : proxyId ? t('所选代理已不存在。', 'The selected proxy no longer exists.') : t('直连（系统网络）', 'Direct (system network)')
    }
  ]
}

const diagnosticEnglishLabels: Record<string, string> = {
  'dns-chatgpt': 'DNS resolution',
  'tls-chatgpt': 'TLS handshake',
  'chatgpt-web': 'ChatGPT website',
  'codex-models': 'Codex models endpoint',
  'codex-usage': 'Codex quota endpoint',
  'openai-auth': 'OpenAI OAuth',
}

function diagnosticLabel(id: string, fallback: string, language: UiLanguage): string {
  return language === 'zh-CN' ? fallback : diagnosticEnglishLabels[id] ?? fallback
}

function diagnosticMessage(result: NetworkDiagnosticTargetResult, language: UiLanguage): string {
  if (language === 'zh-CN') return result.message
  if (result.status === 'skipped') return result.kind === 'dns'
    ? 'DNS resolution is handled by the selected proxy.'
    : 'The target connection is established through the selected proxy.'
  if (result.kind === 'dns' && result.status === 'success') return `Resolved ${result.addresses?.length ?? 0} addresses`
  if (result.kind === 'tls' && result.status === 'success') {
    const protocol = result.message.includes('·') ? ` · ${result.message.split('·').at(-1)?.trim()}` : ''
    return `Handshake succeeded${protocol}`
  }
  if (result.kind === 'http' && result.httpStatus !== undefined) {
    if (result.httpStatus === 401) return 'Endpoint reachable · HTTP 401 is expected without account credentials'
    if (result.httpStatus === 403) return 'Endpoint reachable · HTTP 403 may indicate region, WAF, or access-policy restrictions'
    if (result.httpStatus === 429) return 'Endpoint reachable · the current exit IP is rate-limited (HTTP 429)'
    if (result.httpStatus >= 500) return `Endpoint reachable, but the upstream service returned HTTP ${result.httpStatus}`
    return result.status === 'success' ? `Connected · HTTP ${result.httpStatus}` : `Returned HTTP ${result.httpStatus}`
  }
  const code = result.errorCode ?? 'UNKNOWN'
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return `DNS resolution failed · ${code}`
  if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code)) return `TLS/certificate validation failed · ${code}`
  if (/TIMEOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)) return `Connection timed out · ${code}`
  if (/ECONNREFUSED/i.test(code)) return `Connection refused · ${code}`
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code)) return `Connection reset · ${code}`
  return `Connection failed · ${code}`
}

function localizedDiagnoses(report: NetworkDiagnosticReport, language: UiLanguage): string[] {
  if (language === 'zh-CN') return report.diagnoses
  const results = report.results
  const byId = new Map(results.map((result) => [result.id, result]))
  const http = results.filter((result) => result.kind === 'http')
  const failedHttp = http.filter((result) => result.status === 'error')
  const codes = results.map((result) => result.errorCode ?? '')
  const diagnoses: string[] = []
  if (byId.get('dns-chatgpt')?.status === 'error') diagnoses.push('This computer cannot resolve chatgpt.com. Check DNS, TUN mode, the hosts file, and domain filtering in security software.')
  if (byId.get('tls-chatgpt')?.status === 'error') diagnoses.push('The TLS handshake failed. Check system time, HTTPS interception, firewalls, and proxy TLS/SNI support.')
  if (codes.some((code) => /TIMEOUT/i.test(code))) diagnoses.push('A connection timed out. The node may be unavailable or congested, the target may be blocked, or the proxy rule may not match.')
  if (codes.some((code) => /ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code))) diagnoses.push('A connection was reset midstream. Check proxy stability, firewalls, antivirus software, and TLS routing rules.')
  if (byId.get('openai-auth')?.status === 'error' && http.some((result) => result.id !== 'openai-auth' && result.status !== 'error')) diagnoses.push('Service endpoints are reachable but the OAuth host is not. ChatGPT tokens cannot renew after expiry until auth.openai.com is routed correctly.')
  if (http.some((result) => result.httpStatus === 403)) diagnoses.push('HTTP 403 means the target was reached, but the exit region, proxy IP reputation, WAF, or account access policy may be restricted.')
  if (http.some((result) => result.httpStatus === 429)) diagnoses.push('HTTP 429 means the target is reachable but the exit IP is rate-limited. Change nodes or wait for the limit to reset.')
  if (http.length > 0 && failedHttp.length === http.length) diagnoses.push(report.route.kind === 'proxy'
    ? `The selected proxy “${report.route.name}” cannot reach any GPT endpoint. Check its address, authentication, node status, and outbound rules.`
    : 'No GPT HTTP endpoint is reachable. Check the system proxy/TUN, DNS, firewall, and whether this network permits OpenAI access.')
  if (diagnoses.length === 0) diagnoses.push('Basic connectivity is healthy. If account requests still fail, check credential expiry, account permissions, quota, and model access.')
  return [...new Set(diagnoses)].slice(0, 8)
}
