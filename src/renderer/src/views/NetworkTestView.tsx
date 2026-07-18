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
import { Badge, durationLabel, PageHeader } from '../ui'

const statusLabels: Record<NetworkDiagnosticStatus, string> = {
  success: '正常',
  warning: '需关注',
  error: '失败',
  skipped: '由代理处理'
}

const statusTones: Record<NetworkDiagnosticStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  skipped: 'neutral'
}

export function NetworkTestView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
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
      setError(cause instanceof Error ? cause.message : '网络诊断运行失败')
    } finally {
      setRunning(false)
    }
  }

  const metrics = useMemo(() => reportMetrics(report), [report])
  const localChecks = useMemo(() => buildLocalChecks(snapshot, proxyId), [proxyId, snapshot])
  return <div className="page-stack network-test-page">
    <PageHeader
      title="诊断"
      description="一键检查本地配置、账号状态以及 ChatGPT、Codex、OpenAI 与 OAuth 网络"
      actions={<button className="button button--primary" type="button" disabled={running} onClick={() => void run()}>
        {running ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
        {running ? '正在诊断…' : report ? '重新诊断' : '一键诊断'}
      </button>}
    />

    <section className="panel network-test-controls">
      <div className="network-test-route">
        <span className="network-test-route__icon"><Route size={19} /></span>
        <div><strong>测试网络出口</strong><span>使用 Stone 实际出站链路，不会发送账号凭据</span></div>
        <select aria-label="测试网络出口" value={proxyId} disabled={running} onChange={(event) => setProxyId(event.target.value)}>
          <option value="">直连（系统网络）</option>
          {snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}
        </select>
      </div>
      <div className="network-test-scope"><ShieldCheck size={16} /><span>仅访问内置白名单端点；Codex 与 OpenAI API 测试不携带 Token，收到 401 代表接口可达。</span></div>
    </section>

    <section className="panel panel--flush network-test-local">
      <header className="panel__header"><div><h2>本地运行与配置</h2><p>无需联网即可检查的关键运行条件</p></div><ShieldCheck size={18} /></header>
      <div className="network-test-local__grid">{localChecks.map((check) => <article key={check.id}>
        <span className={`network-test-local__icon network-test-local__icon--${check.status}`}><SummaryIcon status={check.status} /></span>
        <div><strong>{check.label}</strong><p>{check.message}</p></div>
        <Badge tone={statusTones[check.status]}>{statusLabels[check.status]}</Badge>
      </article>)}</div>
    </section>

    {error && <div className="network-test-alert network-test-alert--error"><CircleX size={18} /><div><strong>诊断未完成</strong><span>{error}</span></div></div>}
    {running && <section className="panel network-test-running"><LoaderCircle size={24} className="spin" /><div><strong>正在并行检测 GPT 网络</strong><span>通常需要 2–10 秒，超时项目最多等待 10 秒。</span></div></section>}

    {report && !running && <>
      <section className={`network-test-alert network-test-alert--${report.summary}`}>
        <SummaryIcon status={report.summary} />
        <div><strong>{summaryTitle(report.summary)}</strong><span>{report.route.name} · {new Date(report.finishedAt).toLocaleString()}</span></div>
      </section>

      <section className="network-test-metrics" aria-label="网络诊断汇总">
        <article><CheckCircle2 size={18} /><span>可达项目</span><strong>{metrics.reachable} / {metrics.tested}</strong></article>
        <article><Gauge size={18} /><span>最慢请求</span><strong>{metrics.slowest === undefined ? '—' : durationLabel(metrics.slowest)}</strong></article>
        <article><Clock3 size={18} /><span>总耗时</span><strong>{durationLabel(report.finishedAt - report.startedAt)}</strong></article>
      </section>

      <section className="panel panel--flush network-test-results">
        <header className="panel__header"><div><h2>检测项目</h2><p>DNS、TLS 与固定 GPT HTTP 端点</p></div><Network size={18} /></header>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>项目</th><th>目标</th><th>状态</th><th>耗时</th><th>结果</th></tr></thead>
          <tbody>{report.results.map((result) => <ResultRow result={result} key={result.id} />)}</tbody>
        </table></div>
      </section>

      <section className="panel network-test-diagnoses">
        <header className="panel__header"><div><h2>可能原因与建议</h2><p>根据本次各域名的差异化结果自动归类</p></div><AlertTriangle size={18} /></header>
        <ol>{report.diagnoses.map((diagnosis, index) => <li key={`${index}-${diagnosis}`}><span>{index + 1}</span><p>{diagnosis}</p></li>)}</ol>
      </section>
    </>}

    {!report && !running && <section className="panel network-test-empty">
      <Network size={28} /><strong>尚未运行网络诊断</strong><span>选择直连或一个已配置代理，然后点击“一键诊断”。</span>
    </section>}
  </div>
}

function ResultRow({ result }: { result: NetworkDiagnosticTargetResult }) {
  return <tr>
    <td><strong>{result.label}</strong><span className="row-note">{kindLabel(result.kind)}</span></td>
    <td><code>{result.target}</code>{result.addresses?.length ? <span className="row-note" title={result.addresses.join(', ')}>{result.addresses.join(' · ')}</span> : null}</td>
    <td><Badge tone={statusTones[result.status]}>{statusLabels[result.status]}</Badge></td>
    <td>{result.status === 'skipped' ? '—' : durationLabel(result.latencyMs)}</td>
    <td><span className={result.status === 'error' ? 'network-test-result--error' : ''}>{result.message}</span></td>
  </tr>
}

function SummaryIcon({ status }: { status: NetworkDiagnosticStatus }) {
  if (status === 'success') return <CheckCircle2 size={20} />
  if (status === 'error') return <CircleX size={20} />
  return <AlertTriangle size={20} />
}

function summaryTitle(status: NetworkDiagnosticStatus): string {
  if (status === 'success') return 'GPT 网络链路正常'
  if (status === 'error') return 'GPT 网络整体不可达'
  return '部分网络项目需要关注'
}

function kindLabel(kind: NetworkDiagnosticTargetResult['kind']): string {
  if (kind === 'dns') return '域名解析'
  if (kind === 'tls') return '证书与加密握手'
  return 'HTTP 接口'
}

function reportMetrics(report: NetworkDiagnosticReport | null): { reachable: number; tested: number; slowest?: number } {
  if (!report) return { reachable: 0, tested: 0 }
  const tested = report.results.filter((result) => result.status !== 'skipped')
  const reachable = tested.filter((result) => result.status === 'success' || result.status === 'warning').length
  const latencies = tested.map((result) => result.latencyMs).filter((value) => value > 0)
  return { reachable, tested: tested.length, slowest: latencies.length ? Math.max(...latencies) : undefined }
}

interface LocalDiagnosticCheck {
  id: string
  label: string
  status: NetworkDiagnosticStatus
  message: string
}

function buildLocalChecks(snapshot: AppSnapshot, proxyId: string): LocalDiagnosticCheck[] {
  const now = Date.now()
  const activeAccounts = snapshot.accounts.filter((account) => account.status === 'active').length
  const unavailableAccounts = snapshot.accounts.filter((account) => account.status === 'disabled' || account.status === 'expired').length
  const exhaustedAccounts = snapshot.accounts.filter((account) =>
    account.cooldownReason === 'quota' && (account.cooldownUntil === undefined || account.cooldownUntil > now)).length
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled)
  const invalidRoutes = enabledRoutes.filter((route) => !snapshot.pools.some((pool) => pool.id === route.poolId)).length
  const emptyPools = snapshot.pools.filter((pool) => !pool.members.some((member) =>
    member.enabled && snapshot.accounts.some((account) => account.id === member.accountId))).length
  const expiringOAuth = snapshot.accounts.filter((account) => account.credentialType === 'chatgpt-oauth'
    && account.credentialExpiresAt !== undefined && account.credentialExpiresAt <= now + 15 * 60_000
    && account.renewable !== true).length
  const proxy = proxyId ? snapshot.proxies.find((candidate) => candidate.id === proxyId) : undefined
  return [
    {
      id: 'gateway', label: '本地网关',
      status: snapshot.gatewayStatus.running ? 'success' : 'warning',
      message: snapshot.gatewayStatus.running
        ? `运行中 · ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} · ${snapshot.gatewayStatus.activeRequests} 个活跃请求`
        : '当前未启动；网络诊断仍可运行，但客户端暂时无法通过 Stone 请求。'
    },
    {
      id: 'vault', label: '系统凭据保险库',
      status: snapshot.vaultAvailable ? 'success' : 'error',
      message: snapshot.vaultAvailable ? `${snapshot.vaultBackend} 可用` : '凭据保险库不可用，Stone 无法读取已保存的账号和代理密码。'
    },
    {
      id: 'accounts', label: '上游账号',
      status: activeAccounts > 0 ? unavailableAccounts > 0 || exhaustedAccounts > 0 ? 'warning' : 'success' : 'error',
      message: `${activeAccounts} 个可用 · ${unavailableAccounts} 个停用/过期 · ${exhaustedAccounts} 个额度冷却`
    },
    {
      id: 'routing', label: '号池与客户端路由',
      status: invalidRoutes > 0 || emptyPools > 0 ? 'error' : enabledRoutes.length > 0 ? 'success' : 'warning',
      message: invalidRoutes > 0 || emptyPools > 0
        ? `${invalidRoutes} 条路由缺少号池 · ${emptyPools} 个号池没有启用成员`
        : `${snapshot.pools.length} 个号池 · ${enabledRoutes.length} 条已启用路由`
    },
    {
      id: 'oauth', label: 'ChatGPT OAuth 会话',
      status: expiringOAuth > 0 ? 'warning' : 'success',
      message: expiringOAuth > 0
        ? `${expiringOAuth} 个不可续期会话将在 15 分钟内过期，需要重新导入。`
        : '未发现即将到期且无法自动续期的 ChatGPT 会话。'
    },
    {
      id: 'proxy', label: '本次测试出口',
      status: proxyId && !proxy ? 'error' : proxy?.status === 'error' ? 'warning' : 'success',
      message: proxy
        ? `${proxy.name} · ${proxy.protocol.toUpperCase()} · ${proxy.status === 'available' ? `已验证${proxy.exitIp ? ` · ${proxy.exitIp}` : ''}` : proxy.status === 'error' ? proxy.lastError ?? '上次检测失败' : '尚未单独检测'}`
        : proxyId ? '所选代理已不存在。' : '直连（系统网络）'
    }
  ]
}
