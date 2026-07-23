import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Link,
  LoaderCircle,
  Play,
  Save,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { AppSnapshot, FrpTunnelState, GatewayApi } from '@shared/types'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { useI18n } from '../i18n'
import { Badge, PageHeader, relativeTime } from '../ui'

const EXAMPLE_CONFIG = `serverAddr = "your-frps.example.com"
serverPort = 7000

auth.method = "token"
auth.token = "replace-with-frp-control-token"

[[proxies]]
name = "stone-gateway"
type = "tcp"
localIP = "127.0.0.1"
localPort = 15721
remotePort = 15721
`

export function TunnelView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const { t, language, locale } = useI18n()
  const [state, setState] = useState<FrpTunnelState | null>(null)
  const [config, setConfig] = useState('')
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'address' | 'token' | null>(null)
  const route = useMemo(
    () => snapshot.routes.find((candidate) => candidate.client === 'codex' && candidate.enabled)
      ?? snapshot.routes.find((candidate) => candidate.client === 'codex'),
    [snapshot.routes]
  )

  useEffect(() => {
    let active = true
    const load = async (replaceConfig = false) => {
      try {
        const next = await api.getFrpTunnelState()
        if (!active) return
        setState(next)
        if (replaceConfig) setConfig(next.config || EXAMPLE_CONFIG)
      } catch (cause) {
        if (active) setError(localizeBackendError(cause, language, t('无法读取 frpc 状态', 'Unable to read frpc status')))
      }
    }
    void load(true)
    const timer = window.setInterval(() => void load(false), 1_500)
    return () => { active = false; window.clearInterval(timer) }
  }, [api, language, t])

  const run = async (kind: 'save' | 'start' | 'stop', operation: () => Promise<FrpTunnelState>) => {
    setBusy(kind)
    setError('')
    try {
      const next = await operation()
      setState(next)
      if (kind === 'save') setConfig(next.config)
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('操作失败', 'Operation failed')))
    } finally {
      setBusy(null)
    }
  }

  const saveAndStart = async () => {
    setBusy('start')
    setError('')
    try {
      const saved = config === state?.config ? state : await api.saveFrpTunnelConfig(config)
      if (saved) setState(saved)
      setState(await api.startFrpTunnel())
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('frpc 启动失败', 'Failed to start frpc')))
    } finally {
      setBusy(null)
    }
  }

  const copy = async (kind: 'address' | 'token', value: string | undefined) => {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1_500)
  }

  const changed = state !== null && config !== state.config

  return (
    <div className="page-stack">
      <PageHeader
        title={t('内网穿透', 'Remote Access')}
        actions={<Badge tone={state?.running ? 'success' : 'neutral'}>{state?.running ? t('运行中', 'Running') : t('已停止', 'Stopped')}</Badge>}
      />

      {!state?.binaryAvailable && (
        <div className="warning-banner"><div><AlertTriangle size={17} /><div><strong>{t('内置 frpc 不可用', 'Bundled frpc is unavailable')}</strong><span>{t('安装包缺少 frpc.exe，或被杀毒软件隔离。配置仍可编辑，但无法启动。', 'frpc.exe is missing from the installation or was quarantined by antivirus software. You can still edit the configuration, but the tunnel cannot start.')}</span></div></div></div>
      )}
      {error && <div className="error-banner" role="alert"><div><AlertTriangle size={16} /><span>{error}</span></div></div>}
      {state?.lastError && !error && <div className="error-banner" role="alert"><div><AlertTriangle size={16} /><span>{localizeBackendMessage(state.lastError, language, t('frpc 运行异常', 'frpc encountered an error.'))}</span></div></div>}

      <section className="panel tunnel-panel">
        <div className="tunnel-panel__heading">
          <div><TerminalSquare size={19} /><div><strong>frpc.toml</strong></div></div>
          <div className="tunnel-actions">
            <button className="button button--secondary" type="button" disabled={!changed || Boolean(busy) || state?.running} onClick={() => void run('save', () => api.saveFrpTunnelConfig(config))}>{busy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{t('保存', 'Save')}</button>
            {state?.running
              ? <button className="button button--danger" type="button" disabled={Boolean(busy)} onClick={() => void run('stop', () => api.stopFrpTunnel())}>{busy === 'stop' ? <LoaderCircle size={16} className="spin" /> : <Square size={15} />}{t('停止', 'Stop')}</button>
              : <button className="button button--primary" type="button" disabled={Boolean(busy) || !state?.binaryAvailable} onClick={() => void saveAndStart()}>{busy === 'start' ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{t('保存并启动', 'Save and start')}</button>}
          </div>
        </div>
        <textarea className="tunnel-config mono" spellCheck={false} value={config} disabled={state?.running} onChange={(event) => setConfig(event.target.value)} />
      </section>

      <section className="tunnel-access-grid">
        <article className="panel tunnel-access-card">
          <div><Link size={18} /><span>{t('远端 API 地址', 'Remote API address')}</span></div>
          <code>{state?.remoteAddress ?? t('配置 TCP proxy 的 serverAddr 与 remotePort 后自动生成', 'Generated after serverAddr and remotePort are configured for the TCP proxy')}</code>
          <button className="button button--secondary" type="button" disabled={!state?.remoteAddress} onClick={() => void copy('address', state?.remoteAddress)}>{copied === 'address' ? <Check size={16} /> : <Copy size={16} />}{copied === 'address' ? t('已复制', 'Copied') : t('复制远端地址', 'Copy remote address')}</button>
        </article>
        <article className="panel tunnel-access-card">
          <div><KeyRound size={18} /><span>{t('共享访问令牌', 'Shared access token')}</span></div>
          <code>{route ? t(`Codex 路由 · ••••••••••••${route.localToken.slice(-6)}`, `Codex route · ••••••••••••${route.localToken.slice(-6)}`) : t('尚未配置 Codex 路由', 'No Codex route configured')}</code>
          <button className="button button--secondary" type="button" disabled={!route?.localToken} onClick={() => void copy('token', route?.localToken)}>{copied === 'token' ? <Check size={16} /> : <Copy size={16} />}{copied === 'token' ? t('已复制', 'Copied') : t('复制访问令牌', 'Copy access token')}</button>
        </article>
      </section>

      <section className="panel tunnel-log-panel">
        <div className="tunnel-panel__heading">
          <div><TerminalSquare size={19} /><div><strong>{t('运行日志', 'Runtime logs')}</strong>{state?.running && state.startedAt && <span>{t('启动于', 'Started')} {relativeTime(state.startedAt, locale)} · PID {state.pid ?? '—'}</span>}</div></div>
          <button className="icon-button" type="button" title={t('清空日志', 'Clear logs')} onClick={() => void api.clearFrpTunnelLogs().then(setState)}><Trash2 size={16} /></button>
        </div>
        <pre className="tunnel-logs">{state?.logs.length ? state.logs.join('\n') : t('暂无日志', 'No logs yet')}</pre>
      </section>
    </div>
  )
}
