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
  Languages,
} from 'lucide-react'
import type {
  AppSnapshot,
  BackupRecordSummary,
  GatewayApi,
  GatewaySettings,
  SystemProxyDetectionResult
} from '@shared/types'
import type { ActionRunner } from '../App'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { Badge, FieldError, gatewayBaseUrl, InfoTip, PageHeader, Toggle } from '../ui'
import { StoneMark } from '../StoneMark'
import { UpdateProgress, statusLabel, statusTone, type AppUpdateController } from '../UpdateDialog'
import { translate, useI18n, type UiLanguage } from '../i18n'

function SettingRow({ title, description, control }: { title: string; description?: string; control: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}{description && <InfoTip text={description} />}</strong></div>{control}</div>
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
  const { t, language, locale, preference, setPreference } = useI18n()
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
  useEffect(() => {
    setErrors({})
    setOperationNotice('')
    setConnectionNotice('')
  }, [language])

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.gateway), [draft, snapshot.gateway])
  const addressChanged = draft.host !== snapshot.gateway.host || draft.port !== snapshot.gateway.port
  const currentEndpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)
  const appUpdate = update.state
  const updateBusy = update.action !== null || appUpdate?.status === 'checking' || appUpdate?.status === 'installing'
  const ignoredRelease = Boolean(appUpdate?.release && appUpdate.ignoredVersion === appUpdate.release.version)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!['127.0.0.1', '::1', 'localhost'].includes(draft.host.trim())) nextErrors.host = t('本地网关仅允许监听回环地址', 'The local gateway can only listen on a loopback address')
    if (!Number.isInteger(draft.port) || draft.port < 1024 || draft.port > 65535) nextErrors.port = t('端口范围为 1024–65535', 'Port must be between 1024 and 65535')
    if (draft.requestTimeoutSeconds < 5 || draft.requestTimeoutSeconds > 600) nextErrors.timeout = t('超时范围为 5–600 秒', 'Timeout must be between 5 and 600 seconds')
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
    setOperationNotice(result.backup ? t(`备份已创建：${result.backup.path}`, `Backup created: ${result.backup.path}`) : t('备份已创建', 'Backup created'))
  }

  const restoreBackup = async (backup: BackupRecordSummary) => {
    if (!window.confirm(t('恢复会替换当前本地数据并需要重启 Stone，是否继续？', 'Restoring will replace the current local data and requires restarting Stone. Continue?'))) return
    const result = await api.restoreStateBackup(backup.path)
    setOperationNotice(result.restartRequired ? t('数据已恢复，请退出并重新启动 Stone。', 'Data restored. Quit and restart Stone.') : t('数据已恢复。', 'Data restored.'))
  }

  const exportDiagnostics = async () => {
    const report = await api.exportDiagnostics()
    await navigator.clipboard?.writeText(report)
    setOperationNotice(t('脱敏诊断报告已复制到剪贴板。', 'The redacted diagnostics report was copied to the clipboard.'))
  }

  const rebuildConnections = async () => {
    setConnectionNotice(t('正在建立新的低延迟出口连接…', 'Establishing new low-latency outbound connections…'))
    try {
      await api.rebuildOutboundConnections()
      setConnectionNotice(t('出站连接已重建并预热；旧连接会在现有请求结束后释放。', 'Outbound connections were rebuilt and warmed up; old connections will be released after their current requests finish.'))
    } catch (cause) {
      setConnectionNotice(localizeBackendError(cause, language, t('出站连接重建失败', 'Failed to rebuild outbound connections')))
    }
  }

  const detectSystemProxy = async () => {
    setDetectingSystemProxy(true)
    setConnectionNotice(t('正在读取 Windows 系统代理并检测 OpenAI 连接…', 'Reading the Windows system proxy and testing OpenAI connectivity…'))
    try {
      const result = await api.detectSystemProxy()
      setSystemProxyStatus(result)
      const reachable = result.targets.filter((target) => target.reachable).length
      setConnectionNotice(t(`系统代理检测完成：${reachable}/${result.targets.length} 个目标可达。`, `System proxy test complete: ${reachable}/${result.targets.length} target(s) reachable.`))
    } catch (cause) {
      setConnectionNotice(localizeBackendError(cause, language, t('系统代理检测失败', 'System proxy test failed')))
    } finally {
      setDetectingSystemProxy(false)
    }
  }

  return (
    <form className="page-stack" onSubmit={(event) => void submit(event)}>
      <PageHeader
        title={t('设置', 'Settings')}
        actions={<button className="button button--primary" type="submit" disabled={!changed || busyKeys.has('save-settings')}>{busyKeys.has('save-settings') ? <LoaderCircle size={16} className="spin" /> : saved ? <CheckCircle2 size={16} /> : <Save size={16} />}{saved ? t('已保存', 'Saved') : t('保存设置', 'Save Settings')}</button>}
      />

      {addressChanged && snapshot.gatewayStatus.running && <div className="warning-banner"><AlertTriangle size={17} /><div><strong>{t('保存时将自动重启网关', 'The gateway will restart automatically when saved')}</strong><span>{t(`当前请求仍使用 ${currentEndpoint}`, `Current requests still use ${currentEndpoint}`)}</span></div></div>}

      <section className="settings-section">
        <header><div className="settings-section__icon"><Languages size={18} /></div><div><h2>语言 / Language</h2></div></header>
        <div className="settings-section__content">
          <label className="field">
            <span>界面语言 / Display language</span>
            <select aria-label="界面语言 / Display language" value={preference} onChange={(event) => setPreference(event.target.value as 'system' | 'zh-CN' | 'en')}>
              <option value="system">跟随系统 / Follow system</option>
              <option value="zh-CN">中文 / Chinese</option>
              <option value="en">英文 / English</option>
            </select>
            <small>更改后立即生效并自动保存 / Changes apply instantly and are saved automatically.</small>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon"><Network size={18} /></div><div><h2>{t('本地网关', 'Local Gateway')}</h2></div></header>
        <div className="settings-section__content">
          <div className="form-grid settings-fields">
            <label className="field"><span>{t('监听地址', 'Listen Address')}</span><select value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })}><option value="127.0.0.1">127.0.0.1 (IPv4)</option><option value="::1">::1 (IPv6)</option><option value="localhost">localhost</option></select><FieldError>{errors.host}</FieldError></label>
            <label className="field"><span>{t('端口', 'Port')}</span><input className="mono" type="number" min={1024} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
            <label className="field"><span className="field-label-with-help">{t('连接 / 流空闲超时', 'Connection / Stream Idle Timeout')}<InfoTip text={t('仅限制连接或流无数据的空闲时间，持续输出时不会中断。', 'Only limits idle time without data; active streams are not interrupted.')} /></span><div className="input-suffix"><input type="number" min={5} max={600} value={draft.requestTimeoutSeconds} onChange={(event) => setDraft({ ...draft, requestTimeoutSeconds: Number(event.target.value) })} /><span>{t('秒', 'sec')}</span></div><FieldError>{errors.timeout}</FieldError></label>
            <div className="field"><span>{t('当前端点', 'Current Endpoint')}</span><code className="settings-endpoint">{currentEndpoint}</code></div>
          </div>
          <SettingRow title={t('应用启动时运行网关', 'Run gateway when the app starts')} control={<Toggle checked={draft.autoStart} onChange={(value) => setDraft({ ...draft, autoStart: value })} label={t('应用启动时运行网关', 'Run gateway when the app starts')} />} />
          <SettingRow title={t('登录系统时启动 Stone', 'Launch Stone at login')} control={<Toggle checked={Boolean(draft.launchAtLogin)} onChange={(value) => setDraft({ ...draft, launchAtLogin: value })} label={t('登录系统时启动 Stone', 'Launch Stone at login')} />} />
          <SettingRow title={t('桌面健康通知', 'Desktop health notifications')} description={t('账号停用、冷却、额度耗尽或恢复时通知', 'Notify when accounts are disabled, cooling down, out of quota, or recovered')} control={<Toggle checked={draft.desktopNotifications !== false} onChange={(value) => setDraft({ ...draft, desktopNotifications: value })} label={t('桌面健康通知', 'Desktop health notifications')} />} />
          <SettingRow
            title={t('适配系统代理', 'Use system proxy')}
            description={t('开启后自动跟随 Windows 系统代理或 PAC，适合 Clash 系统代理模式，无需开启 TUN；账号或号池的显式代理仍优先。', 'Automatically follow the Windows system proxy or PAC. Explicit account or pool proxies still take priority.')}
            control={<Toggle checked={draft.outboundNetworkMode === 'system'} onChange={(value) => setDraft({ ...draft, outboundNetworkMode: value ? 'system' : 'direct' })} label={t('适配系统代理', 'Use system proxy')} />}
          />
          <SettingRow title={t('检测系统代理', 'Test system proxy')} description={t('读取系统/PAC 对 ChatGPT 与 OpenAI 的实际分流，不显示代理认证信息。', 'Test how the system proxy/PAC routes ChatGPT and OpenAI without displaying proxy credentials.')} control={<button className="button button--secondary" type="button" disabled={detectingSystemProxy} onClick={() => void detectSystemProxy()}>{detectingSystemProxy ? <LoaderCircle size={16} className="spin" /> : <Network size={16} />}{t('检测系统代理', 'Test System Proxy')}</button>} />
          {systemProxyStatus && <div className="system-proxy-status">{systemProxyStatus.targets.map((target) => {
            const summary = localizeBackendMessage(target.summary, language, t('已读取系统代理路由', 'System proxy route detected.'))
            const error = target.error ? localizeBackendMessage(target.error, language, t('目标连接失败', 'Target connection failed.')) : ''
            return <div key={target.target}><span className={target.reachable ? 'status-dot status-dot--online' : 'status-dot status-dot--error'} /><span><strong>{new URL(target.target).hostname}</strong><small>{summary}{target.latencyMs !== undefined ? ` · ${target.latencyMs} ms` : ''}{error ? ` · ${error}` : ''}</small></span></div>
          })}</div>}
          <SettingRow title={t('重建低延迟出口', 'Rebuild low-latency connections')} description={t('切换梯子、网络或节点后，建立并预热一代新的多通道连接', 'Establish and warm up fresh connections after changing networks or proxy nodes')} control={<button className="button button--secondary" type="button" onClick={() => void rebuildConnections()}><RefreshCw size={16} />{t('重建并预热', 'Rebuild & Warm Up')}</button>} />
          {connectionNotice && <div className="client-config-notice">{connectionNotice}</div>}
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--secure"><Archive size={18} /></div><div><h2>{t('备份与恢复', 'Backup & Restore')}</h2></div></header>
        <div className="settings-section__content">
          <SettingRow title={t('自动备份', 'Automatic backups')} description={t('Stone 启动时创建校验过的本地快照', 'Create a verified local snapshot when Stone starts')} control={<Toggle checked={draft.automaticBackups !== false} onChange={(value) => setDraft({ ...draft, automaticBackups: value })} label={t('自动备份', 'Automatic backups')} />} />
          <label className="field backup-retention"><span>{t('最多保留备份', 'Maximum backups')}</span><div className="input-suffix"><input type="number" min={1} max={100} value={draft.backupRetention ?? 10} onChange={(event) => setDraft({ ...draft, backupRetention: Number(event.target.value) })} /><span>{t('份', 'files')}</span></div></label>
          <div className="settings-actions"><button className="button button--secondary" type="button" onClick={() => void createBackup()}><Archive size={16} />{t('立即备份', 'Back Up Now')}</button><button className="button button--secondary" type="button" onClick={() => void exportDiagnostics()}><FileDown size={16} />{t('复制诊断报告', 'Copy Diagnostics Report')}</button><button className="button button--secondary" type="button" onClick={() => void api.clearHealthEvents()}><BellRing size={16} />{t('清除健康事件', 'Clear Health Events')}</button></div>
          {operationNotice && <div className="client-config-notice">{operationNotice}</div>}
          <div className="state-backup-list">{backups.slice(0, 6).map((backup) => <div key={backup.path}><span><strong>{new Date(backup.createdAt).toLocaleString(locale)}</strong><small>{Math.ceil(backup.size / 1024)} KB · {backup.automatic ? t('自动', 'Automatic') : t('手动', 'Manual')} · {backup.integrity === 'valid' ? t('校验通过', 'Verified') : t('损坏', 'Corrupted')}</small></span><button className="icon-button" type="button" disabled={backup.integrity !== 'valid'} title={t('恢复此备份', 'Restore this backup')} onClick={() => void restoreBackup(backup)}><RotateCcw size={15} /></button></div>)}{!backups.length && <span className="muted">{t('暂无状态备份', 'No state backups')}</span>}</div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--logs"><Timer size={18} /></div><div><h2>{t('请求日志', 'Request Logs')}</h2></div></header>
        <div className="settings-section__content">
          <SettingRow title={t('日志内容', 'Log contents')} description={t('记录路由、状态、延迟与 Token 计数，不保存提示词或模型输出', 'Records routing, status, latency, and Token counts without saving prompts or model output')} control={<Badge tone="success">{t('仅元数据', 'Metadata only')}</Badge>} />
          <div className="log-summary"><span>{t('当前日志', 'Current logs')}</span><strong>{t(`${snapshot.requestLogs.length} 条记录`, `${snapshot.requestLogs.length} record(s)`)}</strong><Badge tone="success">{t('仅元数据', 'Metadata only')}</Badge></div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--update"><Sparkles size={18} /></div><div><h2>{t('应用更新', 'App Updates')}</h2></div></header>
        <div className="settings-section__content">
          <div className="update-settings-status">
            <div>
              <span className="update-settings-status__icon">{appUpdate?.status === 'checking' || appUpdate?.status === 'downloading' || appUpdate?.status === 'installing' ? <LoaderCircle size={19} className="spin" /> : appUpdate?.status === 'downloaded' || appUpdate?.status === 'up-to-date' ? <CheckCircle2 size={19} /> : <Sparkles size={19} />}</span>
              <div>
                <strong>{appUpdate?.release ? `Stone+ ${appUpdate.release.version}` : `Stone+ ${appUpdate?.currentVersion ?? __APP_VERSION__}`}</strong>
                <span>{updateSettingsDescription(appUpdate, language)}</span>
              </div>
            </div>
            <div className="update-settings-status__badges">
              <Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate, language) : t('正在读取', 'Loading')}</Badge>
              {ignoredRelease && <Badge tone="neutral">{t('已忽略', 'Ignored')}</Badge>}
            </div>
          </div>

          {appUpdate?.status === 'downloading' && appUpdate.progress && <UpdateProgress state={appUpdate} />}
          {appUpdate && !appUpdate.automaticUpdateSupported && (
            <div className="update-settings-reason"><AlertTriangle size={16} /><span>{appUpdate.automaticUpdateReason ? localizeBackendMessage(appUpdate.automaticUpdateReason, language, t('当前安装形式需要从 GitHub Releases 手动更新。', 'This installation must be updated manually from GitHub Releases.')) : t('当前安装形式需要从 GitHub Releases 手动更新。', 'This installation must be updated manually from GitHub Releases.')}</span></div>
          )}
          {(update.error || appUpdate?.error) && <div className="update-error" role="alert"><AlertTriangle size={16} /><span>{localizeBackendMessage(update.error ?? appUpdate?.error, language, t('更新操作失败', 'The update operation failed.'))}</span></div>}

          <div className="settings-actions update-settings-actions">
            <button className="button button--secondary" type="button" disabled={updateBusy || appUpdate?.status === 'downloading'} onClick={() => void update.check()}>
              {update.action === 'check' || appUpdate?.status === 'checking' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('手动检查', 'Check Manually')}
            </button>
            {appUpdate?.release && <button className="button button--secondary" type="button" onClick={update.openDialog}>{t('查看版本亮点', 'View Highlights')}</button>}
            {appUpdate?.status === 'available' && !ignoredRelease && <button className="text-button" type="button" disabled={updateBusy} onClick={() => void update.ignore()}>{t('忽略此版本', 'Ignore This Version')}</button>}
            {appUpdate?.status === 'available' && appUpdate.automaticUpdateSupported && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.download()}>
                {update.action === 'download' || update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{t('更新并安装', 'Update & Install')}
              </button>
            )}
            {appUpdate?.status === 'downloaded' && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.install()}>
                {update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}{t('立即安装并重启', 'Install & Restart Now')}
              </button>
            )}
            {appUpdate && (!appUpdate.automaticUpdateSupported || appUpdate.status === 'unsupported') && (
              <button className="button button--primary" type="button" disabled={update.action === 'open-page'} onClick={() => void update.openPage()}>
                <ExternalLink size={16} />{t('打开 Releases', 'Open Releases')}
              </button>
            )}
          </div>
          <div className="update-settings-meta">
            <span>{t(`当前版本 v${appUpdate?.currentVersion ?? __APP_VERSION__}`, `Current version v${appUpdate?.currentVersion ?? __APP_VERSION__}`)}</span>
            <span>{appUpdate?.checkedAt ? t(`上次检查 ${new Date(appUpdate.checkedAt).toLocaleString(locale)}`, `Last checked ${new Date(appUpdate.checkedAt).toLocaleString(locale)}`) : t('尚未手动检查更新', 'No manual update check yet')}</span>
          </div>
        </div>
      </section>

      <section className="about-line"><StoneMark small /><div><strong>Stone+</strong><span>{__APP_VERSION__} · Unofficial community fork</span></div><Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate, language) : 'GitHub Releases'}</Badge></section>
    </form>
  )
}

function updateSettingsDescription(update: AppUpdateController['state'], language: UiLanguage): string {
  if (!update) return translate(language, '正在读取当前安装的更新能力。', 'Reading update capabilities for this installation.')
  if (update.status === 'unsupported') return translate(language, '当前安装形式不支持应用内自动更新。', 'This installation does not support automatic in-app updates.')
  if (update.status === 'idle') return translate(language, '手动检查 GitHub Releases 中的最新版本。', 'Check GitHub Releases for the latest version manually.')
  if (update.status === 'checking') return translate(language, '正在获取最新版本与发布说明。', 'Fetching the latest version and release notes.')
  if (update.status === 'up-to-date') return translate(language, '当前安装的 Stone+ 已是最新版本。', 'The installed Stone+ version is up to date.')
  if (update.status === 'available') return update.ignoredVersion === update.release?.version ? translate(language, '此版本已忽略，仍可手动查看或下载。', 'This version is ignored, but you can still view or download it manually.') : translate(language, '新版本已发布，可查看说明后下载。', 'A new version is available. Review the notes before downloading.')
  if (update.status === 'downloading') return translate(language, '安装包正在后台下载。', 'The installer is downloading in the background.')
  if (update.status === 'downloaded') return translate(language, '安装包已就绪，重启 Stone+ 即可完成更新。', 'The installer is ready. Restart Stone+ to complete the update.')
  if (update.status === 'installing') return translate(language, 'Stone+ 正在关闭并安装新版本。', 'Stone+ is closing and installing the new version.')
  return translate(language, '更新操作失败，当前版本仍可继续使用。', 'The update failed. You can continue using the current version.')
}
