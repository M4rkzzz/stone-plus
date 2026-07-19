import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Network,
  Save,
  Timer,
  Archive,
  RotateCcw,
  FileDown,
  BellRing,
  Download,
  ExternalLink,
  RefreshCw,
  Rocket,
  Sparkles,
} from 'lucide-react'
import type {
  AppSnapshot,
  BackupRecordSummary,
  GatewayApi,
  GatewaySettings,
  SystemProxyDetectionResult
} from '@shared/types'
import type { ActionRunner } from '../App'
import { Badge, FieldError, gatewayBaseUrl, PageHeader, Toggle } from '../ui'
import { StoneMark } from '../StoneMark'
import { UpdateProgress, statusLabel, statusTone, type AppUpdateController } from '../UpdateDialog'

function SettingRow({ title, description, control }: { title: string; description: string; control: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{description}</span></div>{control}</div>
}

export function SettingsView({
  snapshot,
  api,
  runAction,
  busyKeys,
  update,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
  update: AppUpdateController
}) {
  const [draft, setDraft] = useState<GatewaySettings>(snapshot.gateway)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [backups, setBackups] = useState<BackupRecordSummary[]>([])
  const [operationNotice, setOperationNotice] = useState('')
  const [connectionNotice, setConnectionNotice] = useState('')
  const [systemProxyStatus, setSystemProxyStatus] = useState<SystemProxyDetectionResult>()
  const [detectingSystemProxy, setDetectingSystemProxy] = useState(false)

  useEffect(() => setDraft(snapshot.gateway), [snapshot.gateway])
  useEffect(() => { void api.listStateBackups().then(setBackups).catch(() => undefined) }, [api])

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.gateway), [draft, snapshot.gateway])
  const addressChanged = draft.host !== snapshot.gateway.host || draft.port !== snapshot.gateway.port
  const currentEndpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)
  const appUpdate = update.state
  const updateBusy = update.action !== null || appUpdate?.status === 'checking' || appUpdate?.status === 'installing'
  const ignoredRelease = Boolean(appUpdate?.release && appUpdate.ignoredVersion === appUpdate.release.version)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!['127.0.0.1', '::1', 'localhost'].includes(draft.host.trim())) nextErrors.host = '本地网关仅允许监听回环地址'
    if (!Number.isInteger(draft.port) || draft.port < 1024 || draft.port > 65535) nextErrors.port = '端口范围为 1024–65535'
    if (draft.requestTimeoutSeconds < 5 || draft.requestTimeoutSeconds > 600) nextErrors.timeout = '超时范围为 5–600 秒'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-settings', () => api.updateGateway({ ...draft, host: draft.host.trim() }))
    if (success) {
      await api.updateDesktopRuntimeSettings({ launchAtLogin: Boolean(draft.launchAtLogin) })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    }
  }

  const createBackup = async () => {
    const result = await api.createStateBackup()
    setBackups(await api.listStateBackups())
    setOperationNotice(result.backup ? `备份已创建：${result.backup.path}` : '备份已创建')
  }

  const restoreBackup = async (backup: BackupRecordSummary) => {
    if (!window.confirm('恢复会替换当前本地数据并需要重启 Stone，是否继续？')) return
    const result = await api.restoreStateBackup(backup.path)
    setOperationNotice(result.restartRequired ? '数据已恢复，请退出并重新启动 Stone。' : '数据已恢复。')
  }

  const exportDiagnostics = async () => {
    const report = await api.exportDiagnostics()
    await navigator.clipboard?.writeText(report)
    setOperationNotice('脱敏诊断报告已复制到剪贴板。')
  }

  const rebuildConnections = async () => {
    setConnectionNotice('正在建立新的低延迟出口连接…')
    try {
      await api.rebuildOutboundConnections()
      setConnectionNotice('出站连接已重建并预热；旧连接会在现有请求结束后释放。')
    } catch (cause) {
      setConnectionNotice(cause instanceof Error ? cause.message : '出站连接重建失败')
    }
  }

  const detectSystemProxy = async () => {
    setDetectingSystemProxy(true)
    setConnectionNotice('正在读取 Windows 系统代理并检测 OpenAI 连接…')
    try {
      const result = await api.detectSystemProxy()
      setSystemProxyStatus(result)
      const reachable = result.targets.filter((target) => target.reachable).length
      setConnectionNotice(`系统代理检测完成：${reachable}/${result.targets.length} 个目标可达。`)
    } catch (cause) {
      setConnectionNotice(cause instanceof Error ? cause.message : '系统代理检测失败')
    } finally {
      setDetectingSystemProxy(false)
    }
  }

  return (
    <form className="page-stack" onSubmit={(event) => void submit(event)}>
      <PageHeader
        title="设置"
        description="本地网关、安全存储与日志策略"
        actions={<button className="button button--primary" type="submit" disabled={!changed || busyKeys.has('save-settings')}>{busyKeys.has('save-settings') ? <LoaderCircle size={16} className="spin" /> : saved ? <CheckCircle2 size={16} /> : <Save size={16} />}{saved ? '已保存' : '保存设置'}</button>}
      />

      {addressChanged && snapshot.gatewayStatus.running && <div className="warning-banner"><AlertTriangle size={17} /><div><strong>保存时将自动重启网关</strong><span>当前请求仍使用 {currentEndpoint}</span></div></div>}

      <section className="settings-section">
        <header><div className="settings-section__icon"><Network size={18} /></div><div><h2>本地网关</h2><p>监听地址与请求生命周期</p></div></header>
        <div className="settings-section__content">
          <div className="form-grid settings-fields">
            <label className="field"><span>监听地址</span><select value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })}><option value="127.0.0.1">127.0.0.1 (IPv4)</option><option value="::1">::1 (IPv6)</option><option value="localhost">localhost</option></select><FieldError>{errors.host}</FieldError></label>
            <label className="field"><span>端口</span><input className="mono" type="number" min={1024} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
            <label className="field"><span>请求超时</span><div className="input-suffix"><input type="number" min={5} max={600} value={draft.requestTimeoutSeconds} onChange={(event) => setDraft({ ...draft, requestTimeoutSeconds: Number(event.target.value) })} /><span>秒</span></div><FieldError>{errors.timeout}</FieldError></label>
            <div className="field"><span>当前端点</span><code className="settings-endpoint">{currentEndpoint}</code></div>
          </div>
          <SettingRow title="应用启动时运行网关" description="Stone 启动后自动监听本地端口" control={<Toggle checked={draft.autoStart} onChange={(value) => setDraft({ ...draft, autoStart: value })} label="应用启动时运行网关" />} />
          <SettingRow title="登录系统时启动 Stone" description="由操作系统管理桌面应用自启动" control={<Toggle checked={Boolean(draft.launchAtLogin)} onChange={(value) => setDraft({ ...draft, launchAtLogin: value })} label="登录系统时启动 Stone" />} />
          <SettingRow title="桌面健康通知" description="账号停用、冷却、额度耗尽或恢复时通知" control={<Toggle checked={draft.desktopNotifications !== false} onChange={(value) => setDraft({ ...draft, desktopNotifications: value })} label="桌面健康通知" />} />
          <SettingRow
            title="适配系统代理"
            description="开启后自动跟随 Windows 系统代理或 PAC，适合 Clash 系统代理模式，无需开启 TUN；账号或号池的显式代理仍优先。"
            control={<Toggle checked={draft.outboundNetworkMode === 'system'} onChange={(value) => setDraft({ ...draft, outboundNetworkMode: value ? 'system' : 'direct' })} label="适配系统代理" />}
          />
          <SettingRow title="检测系统代理" description="读取系统/PAC 对 ChatGPT 与 OpenAI 的实际分流，不显示代理认证信息。" control={<button className="button button--secondary" type="button" disabled={detectingSystemProxy} onClick={() => void detectSystemProxy()}>{detectingSystemProxy ? <LoaderCircle size={16} className="spin" /> : <Network size={16} />}检测系统代理</button>} />
          {systemProxyStatus && <div className="system-proxy-status">{systemProxyStatus.targets.map((target) => <div key={target.target}><span className={target.reachable ? 'status-dot status-dot--online' : 'status-dot status-dot--error'} /><span><strong>{new URL(target.target).hostname}</strong><small>{target.summary}{target.latencyMs !== undefined ? ` · ${target.latencyMs} ms` : ''}{target.error ? ` · ${target.error}` : ''}</small></span></div>)}</div>}
          <SettingRow title="重建低延迟出口" description="切换梯子、网络或节点后，建立并预热一代新的多通道连接" control={<button className="button button--secondary" type="button" onClick={() => void rebuildConnections()}><RefreshCw size={16} />重建并预热</button>} />
          {connectionNotice && <div className="client-config-notice">{connectionNotice}</div>}
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--secure"><Archive size={18} /></div><div><h2>备份与恢复</h2><p>本地 SQLite 在线备份、校验与自动轮换</p></div></header>
        <div className="settings-section__content">
          <SettingRow title="自动备份" description="Stone 启动时创建校验过的本地快照" control={<Toggle checked={draft.automaticBackups !== false} onChange={(value) => setDraft({ ...draft, automaticBackups: value })} label="自动备份" />} />
          <label className="field backup-retention"><span>最多保留备份</span><div className="input-suffix"><input type="number" min={1} max={100} value={draft.backupRetention ?? 10} onChange={(event) => setDraft({ ...draft, backupRetention: Number(event.target.value) })} /><span>份</span></div></label>
          <div className="settings-actions"><button className="button button--secondary" type="button" onClick={() => void createBackup()}><Archive size={16} />立即备份</button><button className="button button--secondary" type="button" onClick={() => void exportDiagnostics()}><FileDown size={16} />复制诊断报告</button><button className="button button--secondary" type="button" onClick={() => void api.clearHealthEvents()}><BellRing size={16} />清除健康事件</button></div>
          {operationNotice && <div className="client-config-notice">{operationNotice}</div>}
          <div className="state-backup-list">{backups.slice(0, 6).map((backup) => <div key={backup.path}><span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{Math.ceil(backup.size / 1024)} KB · {backup.automatic ? '自动' : '手动'} · {backup.integrity === 'valid' ? '校验通过' : '损坏'}</small></span><button className="icon-button" type="button" disabled={backup.integrity !== 'valid'} title="恢复此备份" onClick={() => void restoreBackup(backup)}><RotateCcw size={15} /></button></div>)}{!backups.length && <span className="muted">暂无状态备份</span>}</div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--logs"><Timer size={18} /></div><div><h2>请求日志</h2><p>本地诊断数据的记录范围</p></div></header>
        <div className="settings-section__content">
          <SettingRow title="日志内容" description="记录路由、状态、延迟与 Token 计数，不保存提示词或模型输出" control={<Badge tone="success">仅元数据</Badge>} />
          <div className="log-summary"><span>当前日志</span><strong>{snapshot.requestLogs.length} 条记录</strong><Badge tone="success">仅元数据</Badge></div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--update"><Sparkles size={18} /></div><div><h2>应用更新</h2><p>从 GitHub Releases 检查并安装 Stone+</p></div></header>
        <div className="settings-section__content">
          <div className="update-settings-status">
            <div>
              <span className="update-settings-status__icon">{appUpdate?.status === 'checking' || appUpdate?.status === 'downloading' || appUpdate?.status === 'installing' ? <LoaderCircle size={19} className="spin" /> : appUpdate?.status === 'downloaded' || appUpdate?.status === 'up-to-date' ? <CheckCircle2 size={19} /> : <Sparkles size={19} />}</span>
              <div>
                <strong>{appUpdate?.release ? `Stone+ ${appUpdate.release.version}` : `Stone+ ${appUpdate?.currentVersion ?? __APP_VERSION__}`}</strong>
                <span>{updateSettingsDescription(appUpdate)}</span>
              </div>
            </div>
            <div className="update-settings-status__badges">
              <Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate) : '正在读取'}</Badge>
              {ignoredRelease && <Badge tone="neutral">已忽略</Badge>}
            </div>
          </div>

          {appUpdate?.status === 'downloading' && appUpdate.progress && <UpdateProgress state={appUpdate} />}
          {appUpdate && !appUpdate.automaticUpdateSupported && (
            <div className="update-settings-reason"><AlertTriangle size={16} /><span>{appUpdate.automaticUpdateReason ?? '当前安装形式需要从 GitHub Releases 手动更新。'}</span></div>
          )}
          {(update.error || appUpdate?.error) && <div className="update-error" role="alert"><AlertTriangle size={16} /><span>{update.error ?? appUpdate?.error}</span></div>}

          <div className="settings-actions update-settings-actions">
            <button className="button button--secondary" type="button" disabled={updateBusy || appUpdate?.status === 'downloading'} onClick={() => void update.check()}>
              {update.action === 'check' || appUpdate?.status === 'checking' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}手动检查
            </button>
            {appUpdate?.release && <button className="button button--secondary" type="button" onClick={update.openDialog}>查看版本亮点</button>}
            {appUpdate?.status === 'available' && !ignoredRelease && <button className="text-button" type="button" disabled={updateBusy} onClick={() => void update.ignore()}>忽略此版本</button>}
            {appUpdate?.status === 'available' && appUpdate.automaticUpdateSupported && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.download()}>
                {update.action === 'download' || update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}更新并安装
              </button>
            )}
            {appUpdate?.status === 'downloaded' && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.install()}>
                {update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}立即安装并重启
              </button>
            )}
            {appUpdate && (!appUpdate.automaticUpdateSupported || appUpdate.status === 'unsupported') && (
              <button className="button button--primary" type="button" disabled={update.action === 'open-page'} onClick={() => void update.openPage()}>
                <ExternalLink size={16} />打开 Releases
              </button>
            )}
          </div>
          <div className="update-settings-meta">
            <span>当前版本 v{appUpdate?.currentVersion ?? __APP_VERSION__}</span>
            <span>{appUpdate?.checkedAt ? `上次检查 ${new Date(appUpdate.checkedAt).toLocaleString()}` : '尚未手动检查更新'}</span>
          </div>
        </div>
      </section>

      <section className="about-line"><StoneMark small /><div><strong>Stone+</strong><span>{__APP_VERSION__} · Unofficial community fork</span></div><Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate) : 'GitHub Releases'}</Badge></section>
    </form>
  )
}

function updateSettingsDescription(update: AppUpdateController['state']): string {
  if (!update) return '正在读取当前安装的更新能力。'
  if (update.status === 'unsupported') return '当前安装形式不支持应用内自动更新。'
  if (update.status === 'idle') return '手动检查 GitHub Releases 中的最新版本。'
  if (update.status === 'checking') return '正在获取最新版本与发布说明。'
  if (update.status === 'up-to-date') return '当前安装的 Stone+ 已是最新版本。'
  if (update.status === 'available') return update.ignoredVersion === update.release?.version ? '此版本已忽略，仍可手动查看或下载。' : '新版本已发布，可查看说明后下载。'
  if (update.status === 'downloading') return '安装包正在后台下载。'
  if (update.status === 'downloaded') return '安装包已就绪，重启 Stone+ 即可完成更新。'
  if (update.status === 'installing') return 'Stone+ 正在关闭并安装新版本。'
  return '更新操作失败，当前版本仍可继续使用。'
}
