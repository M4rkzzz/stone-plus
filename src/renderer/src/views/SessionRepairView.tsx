import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Database,
  FileText,
  History,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import type {
  CodexSessionRepairOverview,
  CodexSessionRepairPreview,
  CodexSessionRepairResult,
  CodexSessionRepairTargetSource,
  GatewayApi,
} from '@shared/types'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { useI18n } from '../i18n'
import { Badge, ConfirmDialog, PageHeader } from '../ui'

export function SessionRepairView({ api }: { api: GatewayApi }) {
  const { t, language } = useI18n()
  const sourceLabels: Record<CodexSessionRepairTargetSource, string> = {
    config: t('配置', 'Config'),
    rollout: t('会话', 'Sessions'),
    sqlite: t('索引', 'Index'),
  }
  const [overview, setOverview] = useState<CodexSessionRepairOverview | null>(null)
  const [preview, setPreview] = useState<CodexSessionRepairPreview | null>(null)
  const [result, setResult] = useState<CodexSessionRepairResult | null>(null)
  const [targetProvider, setTargetProvider] = useState('')
  const [busy, setBusy] = useState<'load' | 'preview' | 'repair' | null>('load')
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    setBusy('load')
    setError('')
    try {
      const next = await api.inspectCodexSessionRepair()
      setOverview(next)
      const provider = next.targets.some((target) => target.id === targetProvider)
        ? targetProvider
        : next.currentProvider || next.targets[0]?.id || 'openai'
      setTargetProvider(provider)
      setPreview(await api.previewCodexSessionRepair(provider))
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('无法扫描 Codex 会话', 'Unable to scan Codex sessions')))
    } finally {
      setBusy(null)
    }
  }, [api, language, t, targetProvider])

  useEffect(() => {
    void load()
    // The target is selected by the initial scan; subsequent changes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const runPreview = async (provider = targetProvider) => {
    if (!provider) return
    setBusy('preview')
    setError('')
    setResult(null)
    try {
      setPreview(await api.previewCodexSessionRepair(provider))
    } catch (cause) {
      setPreview(null)
      setError(localizeBackendError(cause, language, t('无法预览会话修复', 'Unable to preview session repair')))
    } finally {
      setBusy(null)
    }
  }

  const repair = async () => {
    if (!preview) return
    setConfirmOpen(false)
    setBusy('repair')
    setError('')
    try {
      const next = await api.repairCodexSessions(preview.targetProvider, preview.revision)
      setResult(next)
      const refreshed = await api.inspectCodexSessionRepair()
      setOverview(refreshed)
      setPreview(await api.previewCodexSessionRepair(preview.targetProvider))
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('会话修复失败', 'Session repair failed')))
    } finally {
      setBusy(null)
    }
  }

  const totalRollouts = (overview?.sessionFiles ?? 0) + (overview?.archivedSessionFiles ?? 0)
  const totalChanges = useMemo(() => preview
    ? preview.rolloutFilesToUpdate
      + preview.sqliteProviderRowsToUpdate
      + preview.sqliteUserEventRowsToUpdate
      + preview.sqliteCwdRowsToUpdate
    : 0, [preview])
  const running = busy !== null

  return (
    <div className="page-stack">
      <PageHeader
        title={t('会话修复', 'Session Repair')}
        actions={
          <button className="button button--secondary" type="button" disabled={running} onClick={() => void load()}>
            <RefreshCw size={16} className={busy === 'load' ? 'spin' : undefined} />{t('重新扫描', 'Scan again')}
          </button>
        }
      />

      {error && <div className="error-banner" role="alert"><div><AlertTriangle size={16} /><span>{error}</span></div></div>}
      {result && (
        <div className="client-config-notice session-repair-notice">
          <CheckCircle2 size={17} />
          <span>
            {t('已同步到', 'Synchronized to')} <strong>{result.targetProvider}</strong>{t(`：修复 ${result.repairedRolloutFiles} 个会话文件，更新 ${result.sqliteProviderRowsUpdated + result.sqliteUserEventRowsUpdated + result.sqliteCwdRowsUpdated} 行索引。`, `: repaired ${result.repairedRolloutFiles} session files and updated ${result.sqliteProviderRowsUpdated + result.sqliteUserEventRowsUpdated + result.sqliteCwdRowsUpdated} index rows.`)}
            {result.backupPath && <small className="mono">{t('备份', 'Backup')}: {result.backupPath}</small>}
            {result.retentionWarning && <small>{localizeBackendMessage(result.retentionWarning, language, t('旧备份清理失败', 'Old backups could not be cleaned up.'))}</small>}
          </span>
        </div>
      )}

      <section className="metrics-grid session-repair-metrics">
        <article className="metric-card">
          <span className="metric-card__label">{t('当前 provider', 'Current provider')}</span>
          <strong className="metric-card__uptime mono">{overview?.currentProvider ?? '—'}</strong>
          <span>{t('来自', 'From')} ~/.codex/config.toml</span>
          <div className="metric-card__icon metric-card__icon--green"><Wrench size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">{t('本地会话文件', 'Local session files')}</span>
          <strong>{totalRollouts}</strong>
          <span>{t(`${overview?.sessionFiles ?? 0} 个活跃 · ${overview?.archivedSessionFiles ?? 0} 个归档`, `${overview?.sessionFiles ?? 0} active · ${overview?.archivedSessionFiles ?? 0} archived`)}</span>
          <div className="metric-card__icon metric-card__icon--blue"><FileText size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">{t('SQLite 线程索引', 'SQLite thread index')}</span>
          <strong>{overview?.indexedThreads ?? 0}</strong>
          <span>{t(`${overview?.sqliteDatabases.length ?? 0} 个包含 threads 的数据库`, `${overview?.sqliteDatabases.length ?? 0} databases containing threads`)}</span>
          <div className="metric-card__icon metric-card__icon--violet"><Database size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">{t('预览改动', 'Proposed changes')}</span>
          <strong>{totalChanges}</strong>
          <span>{preview ? preview.rolloutFilesToUpdate ? t('存在需要同步的历史会话', 'Historical sessions need synchronization') : totalChanges ? t('仅需修复索引', 'Only the index needs repair') : t('当前目标已同步', 'The selected target is already synchronized') : t('等待预览', 'Waiting for preview')}</span>
          <div className="metric-card__icon metric-card__icon--amber"><History size={18} /></div>
        </article>
      </section>

      <section className="panel session-repair-panel">
        <header className="session-repair-panel__header">
          <div><ShieldCheck size={20} /><div><h2>{t('Provider metadata 同步', 'Provider metadata synchronization')}</h2><p>{t('同步 rollout 的 session_meta 与 SQLite threads 索引；写入前创建完整可恢复备份，并保留原会话时间。', 'Synchronizes rollout session_meta and the SQLite threads index. A complete restorable backup is created before writing, and original session timestamps are preserved.')}</p></div></div>
          <Badge tone={totalChanges ? 'warning' : 'success'}>{preview ? totalChanges ? t('待修复', 'Repair needed') : t('已同步', 'Synchronized') : t('未预览', 'Not previewed')}</Badge>
        </header>

        <div className="session-repair-controls">
          <label className="field">
            <span>{t('同步目标', 'Synchronization target')}</span>
            <select
              value={targetProvider}
              disabled={running || !overview?.targets.length}
              onChange={(event) => {
                setTargetProvider(event.target.value)
                setPreview(null)
                setResult(null)
              }}
            >
              {overview?.targets.map((target) => (
                <option value={target.id} key={target.id}>
                  {target.id} ({target.sources.map((source) => sourceLabels[source]).join(' / ')}{target.isCurrentProvider ? t(' / 当前', ' / current') : ''})
                </option>
              ))}
            </select>
          </label>
          <div className="session-repair-actions">
            <button className="button button--secondary" type="button" disabled={running || !targetProvider} onClick={() => void runPreview()}>
              {busy === 'preview' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('预览修复', 'Preview repair')}
            </button>
            <button className="button button--primary" type="button" disabled={running || !preview || totalChanges === 0} onClick={() => setConfirmOpen(true)}>
              {busy === 'repair' ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}{t('立即修复历史会话', 'Repair historical sessions now')}
            </button>
          </div>
        </div>

        {busy === 'load' && !preview ? (
          <div className="session-repair-loading"><LoaderCircle size={20} className="spin" /><span>{t('正在扫描 rollout 与 SQLite 索引…', 'Scanning rollouts and the SQLite index…')}</span></div>
        ) : preview ? (
          <div className="session-repair-preview">
            <div><span>rollout provider</span><strong>{preview.rolloutFilesToUpdate}</strong><small>{t('个会话文件', 'session files')}</small></div>
            <div><span>SQLite provider</span><strong>{preview.sqliteProviderRowsToUpdate}</strong><small>{t('行线程归属', 'thread-owner rows')}</small></div>
            <div><span>{t('用户事件索引', 'User-event index')}</span><strong>{preview.sqliteUserEventRowsToUpdate}</strong><small>{t('行可见性标记', 'visibility rows')}</small></div>
            <div><span>{t('工作区索引', 'Workspace index')}</span><strong>{preview.sqliteCwdRowsToUpdate}</strong><small>{t('行 cwd 路径', 'cwd path rows')}</small></div>
          </div>
        ) : (
          <div className="session-repair-loading"><RefreshCw size={19} /><span>{t('目标已切换，点击“预览修复”重新计算安全快照。', 'The target changed. Select “Preview repair” to calculate a new safety snapshot.')}</span></div>
        )}
      </section>

      {preview?.encryptedSessionFiles ? (
        <div className="warning-banner warning-banner--danger"><div><AlertTriangle size={17} /><div><strong>{t('检测到 encrypted_content', 'encrypted_content detected')}</strong><span>{t(`${preview.encryptedSessionFiles} 个会话来自 ${preview.encryptedSourceProviders.join('、')}。修复可恢复列表可见性，但续聊或压缩旧上下文时仍可能要求原账号/provider。`, `${preview.encryptedSessionFiles} sessions came from ${preview.encryptedSourceProviders.join(', ')}. Repair can restore list visibility, but continuing or compacting older context may still require the original account/provider.`)}</span></div></div></div>
      ) : null}
      {overview?.skippedFiles.length ? (
        <div className="warning-banner"><div><AlertTriangle size={17} /><div><strong>{t('有文件被占用', 'Some files are in use')}</strong><span>{t(`${overview.skippedFiles.length} 个 rollout 未进入本次预览；关闭对应 Codex 会话后重新扫描。`, `${overview.skippedFiles.length} rollouts were excluded from this preview. Close the corresponding Codex sessions and scan again.`)}</span></div></div></div>
      ) : null}

      <section className="panel session-repair-details">
        <header><Archive size={18} /><div><strong>{t('数据与备份范围', 'Data and backup scope')}</strong><span className="mono">{overview?.codexHome ?? '~/.codex'}</span></div></header>
        <ul>
          <li>{t('只改写 JSONL 中', 'Only')} <code>session_meta.payload.model_provider</code> {t('，不会修改对话正文。', 'in JSONL is rewritten; conversation content is never modified.')}</li>
          <li>{t('SQLite 更新使用事务与原值校验，不覆盖预览后新产生的线程变化。', 'SQLite updates use transactions and original-value checks, so thread changes created after the preview are not overwritten.')}</li>
          <li>{t('备份保存在', 'Backups are stored in')} <code>~/.codex/backups_state/stone-session-repair</code>{t('，自动保留最近 5 次。', '; the five most recent backups are retained automatically.')}</li>
        </ul>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title={t('修复 Codex 历史会话', 'Repair Codex session history')}
        message={t(`将 ${preview?.rolloutFilesToUpdate ?? 0} 个会话文件及 ${preview ? preview.sqliteProviderRowsToUpdate + preview.sqliteUserEventRowsToUpdate + preview.sqliteCwdRowsToUpdate : 0} 行索引同步到 ${preview?.targetProvider ?? targetProvider}。StonePlus 会先创建备份，是否继续？`, `Synchronize ${preview?.rolloutFilesToUpdate ?? 0} session files and ${preview ? preview.sqliteProviderRowsToUpdate + preview.sqliteUserEventRowsToUpdate + preview.sqliteCwdRowsToUpdate : 0} index rows to ${preview?.targetProvider ?? targetProvider}. StonePlus creates a backup first. Continue?`)}
        confirmLabel={t('创建备份并修复', 'Create backup and repair')}
        busy={busy === 'repair'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void repair()}
      />
    </div>
  )
}
