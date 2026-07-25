import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Database,
  FileText,
  History,
  ListX,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react'
import type {
  CodexSessionIndexCleanupPreview,
  CodexSessionIndexCleanupResult,
  CodexSessionRepairOverview,
  CodexSessionRepairPreview,
  CodexSessionRepairProgressEvent,
  CodexSessionRepairResult,
  CodexSessionRepairTargetSource,
  GatewayApi,
} from '@shared/types'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { useI18n } from '../i18n'
import { CodexSessionManagerPanel } from '../codex-session-manager'
import {
  cacheSessionRepairPreview,
  cachedOrAnalyzeSessionRepairPreview,
  isSessionRepairCancellation,
  sessionRepairProgressPercent,
  repairSessionFromPreview,
  summarizeSessionRepairChanges,
} from '../session-repair-ui'
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
  const [indexPreview, setIndexPreview] = useState<CodexSessionIndexCleanupPreview | null>(null)
  const [indexResult, setIndexResult] = useState<CodexSessionIndexCleanupResult | null>(null)
  const [selectedIndexIds, setSelectedIndexIds] = useState<string[]>([])
  const [targetProvider, setTargetProvider] = useState('')
  const [busy, setBusy] = useState<'load' | 'preview' | 'repair' | 'index-preview' | 'index-cleanup' | null>('load')
  const [error, setError] = useState('')
  const [refreshWarning, setRefreshWarning] = useState('')
  const [indexError, setIndexError] = useState('')
  const [indexRefreshWarning, setIndexRefreshWarning] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [indexConfirmOpen, setIndexConfirmOpen] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [progress, setProgress] = useState<CodexSessionRepairProgressEvent | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const operationRef = useRef<string | null>(null)
  const previewCache = useRef(new Map<string, CodexSessionRepairPreview>())

  const beginSessionOperation = useCallback((kind: 'load' | 'preview' | 'repair'): string | undefined => {
    if (operationRef.current) return undefined
    const id = crypto.randomUUID()
    operationRef.current = id
    setOperationId(id)
    setProgress({ operationId: id, stage: 'discover', completed: 0 })
    setCancelBusy(false)
    setBusy(kind)
    return id
  }, [])

  const finishSessionOperation = useCallback((id: string) => {
    if (operationRef.current !== id) return
    operationRef.current = null
    setOperationId(null)
    setProgress(null)
    setCancelBusy(false)
    setBusy(null)
  }, [])

  useEffect(() => {
    const unsubscribe = api.onCodexSessionRepairProgress((event) => {
      if (event.operationId === operationRef.current) setProgress(event)
    })
    return () => {
      unsubscribe()
      const active = operationRef.current
      operationRef.current = null
      if (active) void api.cancelCodexSessionRepair(active).catch(() => undefined)
    }
  }, [api])

  const load = useCallback(async () => {
    const id = beginSessionOperation('load')
    if (!id) return
    setError('')
    setRefreshWarning('')
    setIndexRefreshWarning('')
    setResult(null)
    previewCache.current.clear()
    try {
      const next = await api.analyzeCodexSessionRepair(targetProvider || undefined, id)
      const provider = next.targetProvider
      setOverview(next)
      setTargetProvider(provider)
      setPreview(cacheSessionRepairPreview(previewCache.current, next))
      try {
        setIndexPreview(await api.previewCodexSessionIndexCleanup())
        setSelectedIndexIds([])
        setIndexError('')
      } catch (cause) {
        setIndexPreview(null)
        setIndexError(localizeBackendError(cause, language, t('无法扫描幽灵任务索引', 'Unable to scan the ghost task index')))
      }
    } catch (cause) {
      if (!isSessionRepairCancellation(cause)) {
        setError(localizeBackendError(cause, language, t('无法扫描 Codex 会话', 'Unable to scan Codex sessions')))
      }
    } finally {
      finishSessionOperation(id)
    }
  }, [api, beginSessionOperation, finishSessionOperation, language, t, targetProvider])

  useEffect(() => {
    void load()
    // The target is selected by the initial scan; subsequent changes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const runPreview = async (provider = targetProvider) => {
    if (!provider) return
    const cached = previewCache.current.get(provider)
    if (cached) {
      setError('')
      setRefreshWarning('')
      setResult(null)
      setOverview(cached)
      setPreview(cached)
      return
    }
    const id = beginSessionOperation('preview')
    if (!id) return
    setError('')
    setRefreshWarning('')
    setResult(null)
    try {
      const next = await cachedOrAnalyzeSessionRepairPreview(
        previewCache.current,
        provider,
        id,
        (target, operation) => api.analyzeCodexSessionRepair(target, operation),
      )
      setOverview(next)
      setPreview(next)
    } catch (cause) {
      if (!isSessionRepairCancellation(cause)) {
        setError(localizeBackendError(cause, language, t('无法预览会话修复', 'Unable to preview session repair')))
      }
    } finally {
      finishSessionOperation(id)
    }
  }

  const repair = async () => {
    if (!preview) return
    const id = beginSessionOperation('repair')
    if (!id) return
    setConfirmOpen(false)
    setError('')
    setRefreshWarning('')
    try {
      const next = (await repairSessionFromPreview(api, preview, id)).repair
      setResult(next)
      previewCache.current.clear()
      setPreview(null)
      setRefreshWarning(t('修复已完成；结果已显示。需要最新计数时再重新扫描。', 'Repair completed and the result is shown. Scan again only when you need updated counts.'))
    } catch (cause) {
      if (isSessionRepairCancellation(cause)) {
        previewCache.current.clear()
        setPreview(null)
        setRefreshWarning(t('操作已安全取消；Codex 关闭期间状态可能发生变化，请重新扫描后再继续。', 'The operation was safely cancelled. State may have changed while Codex was closed; scan again before continuing.'))
      } else {
        setError(localizeBackendError(cause, language, t('会话修复失败', 'Session repair failed')))
      }
    } finally {
      finishSessionOperation(id)
    }
  }

  const cancelSessionOperation = async () => {
    const active = operationRef.current
    if (!active || cancelBusy) return
    setCancelBusy(true)
    try {
      const accepted = await api.cancelCodexSessionRepair(active)
      if (!accepted && operationRef.current === active) setCancelBusy(false)
    } catch (cause) {
      if (operationRef.current === active) {
        setCancelBusy(false)
        setError(localizeBackendError(cause, language, t('无法取消当前操作', 'Unable to cancel the current operation')))
      }
    }
  }

  const refreshIndexPreview = async () => {
    setBusy('index-preview')
    setIndexError('')
    setIndexRefreshWarning('')
    setIndexResult(null)
    try {
      setIndexPreview(await api.previewCodexSessionIndexCleanup())
      setSelectedIndexIds([])
    } catch (cause) {
      setIndexPreview(null)
      setIndexError(localizeBackendError(cause, language, t('无法扫描幽灵任务索引', 'Unable to scan the ghost task index')))
    } finally {
      setBusy(null)
    }
  }

  const cleanupIndex = async () => {
    if (!indexPreview || !selectedIndexIds.length) return
    setIndexConfirmOpen(false)
    setBusy('index-cleanup')
    setIndexError('')
    setIndexRefreshWarning('')
    try {
      const next = await api.cleanupCodexSessionIndexAndRestart(indexPreview.snapshotSha256, selectedIndexIds)
      setIndexResult(next.cleanup)
    } catch (cause) {
      setIndexError(localizeBackendError(cause, language, t('幽灵任务索引清理失败', 'Ghost task index cleanup failed')))
      setBusy(null)
      return
    }
    try {
      setIndexPreview(await api.previewCodexSessionIndexCleanup())
      setSelectedIndexIds([])
    } catch {
      setIndexPreview(null)
      setIndexRefreshWarning(t('清理已完成；Codex 重新开启时索引暂未刷新，请稍后重新检查。', 'Cleanup completed, but the index was not refreshed while Codex reopened. Check again shortly.'))
    } finally {
      setBusy(null)
    }
  }

  const changeSummary = summarizeSessionRepairChanges(overview, preview)
  const totalRollouts = changeSummary.scannedSessionFiles
  const totalChanges = changeSummary.totalChanges
  const running = busy !== null
  const progressPercent = progress ? sessionRepairProgressPercent(progress) : undefined
  const progressStages: Array<{ id: CodexSessionRepairProgressEvent['stage']; label: string }> = [
    { id: 'discover', label: t('发现文件', 'Discover') },
    { id: 'scan', label: t('扫描', 'Scan') },
    { id: 'verify', label: t('复核', 'Verify') },
    { id: 'backup', label: t('备份', 'Backup') },
    { id: 'apply', label: t('应用', 'Apply') },
  ]
  const activeProgressStage = progress
    ? progressStages.findIndex((stage) => stage.id === progress.stage)
    : -1

  useEffect(() => {
    if (!changeSummary.requiresRepair) setConfirmOpen(false)
  }, [changeSummary.requiresRepair])

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
      {operationId && progress && (
        <section className="session-repair-progress" aria-live="polite" aria-busy="true">
          <div className="session-repair-progress__heading">
            <div>
              <LoaderCircle size={17} className="spin" />
              <span><strong>{progressStages[activeProgressStage]?.label ?? t('准备中', 'Preparing')}</strong><small>{progress.total === undefined
                ? t(`已处理 ${progress.completed}`, `${progress.completed} processed`)
                : t(`已处理 ${progress.completed} / ${progress.total}`, `${progress.completed} of ${progress.total} processed`)}</small></span>
            </div>
            <button className="button button--secondary" type="button" disabled={cancelBusy} onClick={() => void cancelSessionOperation()}>
              {cancelBusy ? <LoaderCircle size={15} className="spin" /> : <XCircle size={15} />}{cancelBusy ? t('正在取消…', 'Cancelling…') : t('安全取消', 'Cancel safely')}
            </button>
          </div>
          <div className="session-repair-progress__track" role="progressbar" aria-label={t('会话修复进度', 'Session repair progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <span className={progressPercent === undefined ? 'is-indeterminate' : ''} style={progressPercent === undefined ? undefined : { width: `${progressPercent}%` }} />
          </div>
          <ol className="session-repair-progress__stages">
            {progressStages.map((stage, index) => <li key={stage.id} className={index < activeProgressStage ? 'is-complete' : index === activeProgressStage ? 'is-active' : ''}><span />{stage.label}</li>)}
          </ol>
        </section>
      )}
      {result && (
        <div className="client-config-notice session-repair-notice">
          <CheckCircle2 size={17} />
          <span>
            {t('已同步到', 'Synchronized to')} <strong>{result.targetProvider}</strong>{t(`：修复 ${result.repairedRolloutFiles} 个会话文件、${result.sqliteProviderRowsUpdated + result.sqliteUserEventRowsUpdated + result.sqliteCwdRowsUpdated} 行索引及 ${result.globalStateFieldsUpdated} 个工作区状态字段。`, `: repaired ${result.repairedRolloutFiles} session files, ${result.sqliteProviderRowsUpdated + result.sqliteUserEventRowsUpdated + result.sqliteCwdRowsUpdated} index rows, and ${result.globalStateFieldsUpdated} workspace-state fields.`)}
            {result.backupPath && <small className="mono">{t('备份', 'Backup')}: {result.backupPath}</small>}
            {result.retentionWarning && <small>{localizeBackendMessage(result.retentionWarning, language, t('旧备份清理失败', 'Old backups could not be cleaned up.'))}</small>}
            {refreshWarning && <small>{refreshWarning}</small>}
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
          <span className="metric-card__label">{t('待同步改动', 'Changes to synchronize')}</span>
          <strong>{totalChanges}</strong>
          <span>{preview
            ? changeSummary.unrecognizedSessionFiles
              ? t(`已扫描 ${totalRollouts} 个会话，${changeSummary.unrecognizedSessionFiles} 个元数据仍无法识别`, `${totalRollouts} sessions scanned; ${changeSummary.unrecognizedSessionFiles} still have unrecognized metadata`)
              : changeSummary.sessionFilesToUpdate
              ? t(`已扫描 ${totalRollouts} 个会话，${changeSummary.sessionFilesToUpdate} 个需同步`, `${totalRollouts} sessions scanned; ${changeSummary.sessionFilesToUpdate} need synchronization`)
              : totalChanges
                ? t(`已扫描 ${totalRollouts} 个会话；会话均已同步，仅索引需修复`, `${totalRollouts} sessions scanned and synchronized; only indexes need repair`)
                : t(`已扫描 ${totalRollouts} 个会话，均已同步到 ${preview.targetProvider}`, `${totalRollouts} sessions scanned; all are synchronized to ${preview.targetProvider}`)
            : t('等待预览', 'Waiting for preview')}</span>
          <div className="metric-card__icon metric-card__icon--amber"><History size={18} /></div>
        </article>
      </section>

      <CodexSessionManagerPanel api={api} />

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
                const provider = event.target.value
                const cached = previewCache.current.get(provider) ?? null
                setTargetProvider(provider)
                setPreview(cached)
                if (cached) setOverview(cached)
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
            <button className="button button--primary" type="button" disabled={running || !changeSummary.requiresRepair} onClick={() => {
              if (changeSummary.requiresRepair) setConfirmOpen(true)
            }}>
              {busy === 'repair' ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}{changeSummary.requiresRepair ? t('立即同步待修复项', 'Synchronize repair items now') : changeSummary.unrecognizedSessionFiles ? t('存在未识别会话', 'Unrecognized sessions') : t('无需修复', 'No repair needed')}
            </button>
          </div>
        </div>

        {busy === 'load' && !preview ? (
          <div className="session-repair-loading"><LoaderCircle size={20} className="spin" /><span>{t('正在扫描 rollout 与 SQLite 索引…', 'Scanning rollouts and the SQLite index…')}</span></div>
        ) : preview ? (
          <div className="session-repair-preview">
            <div><span>{t('会话文件待同步', 'Session files pending')}</span><strong>{preview.rolloutFilesToUpdate}</strong><small>{t(`${totalRollouts} 个已扫描 · ${changeSummary.parsedSessionFiles} 个已识别 · ${changeSummary.synchronizedSessionFiles} 个已同步`, `${totalRollouts} scanned · ${changeSummary.parsedSessionFiles} recognized · ${changeSummary.synchronizedSessionFiles} synchronized`)}</small></div>
            <div><span>SQLite provider</span><strong>{preview.sqliteProviderRowsToUpdate}</strong><small>{t('行线程归属', 'thread-owner rows')}</small></div>
            <div><span>{t('用户事件索引', 'User-event index')}</span><strong>{preview.sqliteUserEventRowsToUpdate}</strong><small>{t('行可见性标记', 'visibility rows')}</small></div>
            <div><span>{t('工作区索引', 'Workspace index')}</span><strong>{preview.sqliteCwdRowsToUpdate}</strong><small>{t('行 cwd 路径', 'cwd path rows')}</small></div>
            <div><span>{t('全局工作区状态', 'Global workspace state')}</span><strong>{preview.globalStateFieldsToUpdate}</strong><small>{t('个路径字段', 'path fields')}</small></div>
          </div>
        ) : (
          <div className="session-repair-loading"><RefreshCw size={19} /><span>{t('目标已切换，点击“预览修复”重新计算安全快照。', 'The target changed. Select “Preview repair” to calculate a new safety snapshot.')}</span></div>
        )}
      </section>

      {indexError && <div className="error-banner" role="alert"><div><AlertTriangle size={16} /><span>{indexError}</span></div></div>}
      {indexResult && (
        <div className="client-config-notice session-repair-notice">
          <CheckCircle2 size={17} />
          <span>
            {t(`已清理 ${indexResult.prunedEntries} 条幽灵任务索引，并重新开启 Codex。`, `Removed ${indexResult.prunedEntries} ghost task index entries and reopened Codex.`)}
            {indexResult.backupPath && <small className="mono">{t('备份', 'Backup')}: {indexResult.backupPath}</small>}
            {indexResult.retentionWarning && <small>{localizeBackendMessage(indexResult.retentionWarning, language, t('旧备份清理失败', 'Old backups could not be cleaned up.'))}</small>}
            {indexRefreshWarning && <small>{indexRefreshWarning}</small>}
          </span>
        </div>
      )}

      <section className="panel session-repair-panel session-index-cleanup-panel">
        <header className="session-repair-panel__header">
          <div><ListX size={20} /><div><h2>{t('幽灵任务索引', 'Ghost task index')}</h2><p>{t('仅列出只存在于 session_index.jsonl、且 rollout 与所有已知本地数据库均无引用的记录；默认不选择。', 'Only records found solely in session_index.jsonl, with no rollout or known local database reference, are listed. Nothing is selected by default.')}</p></div></div>
          <Badge tone={indexPreview?.candidates.length ? 'warning' : 'success'}>{indexPreview ? indexPreview.candidates.length ? t(`${indexPreview.candidates.length} 个候选`, `${indexPreview.candidates.length} candidates`) : t('无候选', 'No candidates') : t('未扫描', 'Not scanned')}</Badge>
        </header>

        <div className="session-index-cleanup-toolbar">
          <span>{t(`已选择 ${selectedIndexIds.length} 个`, `${selectedIndexIds.length} selected`)}</span>
          <div className="session-repair-actions">
            {indexPreview?.candidates.length ? (
              <button className="button button--secondary" type="button" disabled={running} onClick={() => setSelectedIndexIds(selectedIndexIds.length === indexPreview.candidates.length ? [] : indexPreview.candidates.map((candidate) => candidate.id))}>
                {selectedIndexIds.length === indexPreview.candidates.length ? t('取消全选', 'Clear selection') : t('全选候选', 'Select all')}
              </button>
            ) : null}
            <button className="button button--secondary" type="button" disabled={running} onClick={() => void refreshIndexPreview()}>
              {busy === 'index-preview' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('重新检查', 'Check again')}
            </button>
            <button className="button button--danger" type="button" disabled={running || !indexPreview || !selectedIndexIds.length} onClick={() => setIndexConfirmOpen(true)}>
              {busy === 'index-cleanup' ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{t('清理所选', 'Remove selected')}
            </button>
          </div>
        </div>

        {indexPreview?.candidates.length ? (
          <div className="session-index-candidates">
            {indexPreview.candidates.map((candidate) => {
              const selected = selectedIndexIds.includes(candidate.id)
              return (
                <label className={selected ? 'selected' : ''} key={candidate.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={running}
                    onChange={(event) => setSelectedIndexIds((current) => event.target.checked
                      ? [...current, candidate.id]
                      : current.filter((id) => id !== candidate.id))}
                  />
                  <span><strong>{candidate.threadName || t('未命名任务', 'Untitled task')}</strong><small className="mono">{candidate.id}</small></span>
                  <time>{candidate.updatedAt}</time>
                </label>
              )
            })}
          </div>
        ) : (
          <div className="session-repair-loading"><ShieldCheck size={19} /><span>{indexPreview ? t('没有发现可确认清理的幽灵任务索引。', 'No ghost task index entries require review.') : t('尚未完成索引扫描。', 'The index has not been scanned yet.')}</span></div>
        )}
      </section>

      {preview?.encryptedSessionFiles ? (
        <div className="warning-banner warning-banner--danger"><div><AlertTriangle size={17} /><div><strong>{t('检测到 encrypted_content', 'encrypted_content detected')}</strong><span>{t(`${preview.encryptedSessionFiles} 个会话来自 ${preview.encryptedSourceProviders.join('、')}。修复可恢复列表可见性，但续聊或压缩旧上下文时仍可能要求原账号/provider。`, `${preview.encryptedSessionFiles} sessions came from ${preview.encryptedSourceProviders.join(', ')}. Repair can restore list visibility, but continuing or compacting older context may still require the original account/provider.`)}</span></div></div></div>
      ) : null}
      {preview?.rolloutFilesWithoutSessionMeta ? (
        <div className="warning-banner warning-banner--danger"><div><AlertTriangle size={17} /><div><strong>{t('存在无法识别的会话元数据', 'Unrecognized session metadata detected')}</strong><span>{t(`${preview.rolloutFilesWithoutSessionMeta} 个会话文件没有可识别的 session_meta，Stone+ 不会把它们误报为已同步，也不会盲目改写。`, `${preview.rolloutFilesWithoutSessionMeta} session files have no recognizable session_meta. Stone+ will neither report them as synchronized nor rewrite them blindly.`)}</span></div></div></div>
      ) : null}
      {preview?.globalStateConflictingFields.length ? (
        <div className="warning-banner"><div><AlertTriangle size={17} /><div><strong>{t('工作区状态存在冲突', 'Workspace-state conflicts detected')}</strong><span>{t(`为避免覆盖不同值，以下字段不会自动规范化：${preview.globalStateConflictingFields.join('、')}`, `To avoid overwriting different values, these fields will not be normalized automatically: ${preview.globalStateConflictingFields.join(', ')}`)}</span></div></div></div>
      ) : null}
      {overview?.skippedFiles.length ? (
        <div className="warning-banner"><div><AlertTriangle size={17} /><div><strong>{t('有文件被占用', 'Some files are in use')}</strong><span>{t(`${overview.skippedFiles.length} 个 rollout 未进入本次预览；关闭对应 Codex 会话后重新扫描。`, `${overview.skippedFiles.length} rollouts were excluded from this preview. Close the corresponding Codex sessions and scan again.`)}</span></div></div></div>
      ) : null}

      <section className="panel session-repair-details">
        <header><Archive size={18} /><div><strong>{t('数据与备份范围', 'Data and backup scope')}</strong><span className="mono">{overview?.codexHome ?? '~/.codex'}</span></div></header>
        <ul>
          <li>{t('只改写 JSONL 中', 'Only')} <code>session_meta.payload.model_provider</code> {t('，不会修改对话正文。', 'in JSONL is rewritten; conversation content is never modified.')}</li>
          <li>{t('SQLite 更新使用事务与原值校验，不覆盖预览后新产生的线程变化。', 'SQLite updates use transactions and original-value checks, so thread changes created after the preview are not overwritten.')}</li>
          <li>{t('全局状态只规范化已有工作区路径字段；冲突字段与所有无关设置保持不变。', 'Global state only normalizes existing workspace-path fields; conflicting fields and all unrelated settings remain unchanged.')}</li>
          <li>{t('幽灵索引必须逐项选择，完整原文件会单独备份；未知格式记录永不删除。', 'Ghost index entries must be selected explicitly, the complete original file is backed up separately, and unknown record formats are never deleted.')}</li>
          <li>{t('备份保存在', 'Backups are stored in')} <code>~/.codex/backups_state/stone-session-repair</code>{t('，自动保留最近 5 次。', '; the five most recent backups are retained automatically.')}</li>
        </ul>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title={t('修复 Codex 历史会话', 'Repair Codex session history')}
        message={t(`当前预览已扫描 ${totalRollouts} 个会话并识别 ${preview?.rolloutFilesWithSessionMeta ?? 0} 个，预计同步 ${totalChanges} 项。继续后将关闭 Codex，基于关闭后的最新快照生成一次修复计划，创建备份，安全应用到 ${preview?.targetProvider ?? targetProvider} 后重新开启。是否继续？`, `The current preview scanned ${totalRollouts} sessions, recognized ${preview?.rolloutFilesWithSessionMeta ?? 0}, and estimates ${totalChanges} changes. Continuing closes Codex, builds one repair plan from the latest post-shutdown snapshot, creates a backup, safely applies it to ${preview?.targetProvider ?? targetProvider}, and then reopens Codex. Continue?`)}
        confirmLabel={t('关闭、备份并修复', 'Close, back up, and repair')}
        busy={busy === 'repair'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void repair()}
      />
      <ConfirmDialog
        open={indexConfirmOpen}
        title={t('清理所选幽灵任务索引', 'Remove selected ghost task index entries')}
        message={t(`将关闭 Codex，重新验证并删除所选 ${selectedIndexIds.length} 个候选索引，然后重新开启 Codex。候选也可能是尚未同步到本地的云端任务；Stone+ 会先备份完整 session_index.jsonl。是否继续？`, `Codex will close, revalidate and remove the ${selectedIndexIds.length} selected index candidates, then reopen. Candidates may still be cloud tasks not yet synchronized locally. Stone+ backs up the complete session_index.jsonl first. Continue?`)}
        confirmLabel={t('关闭、备份并清理', 'Close, back up, and remove')}
        busy={busy === 'index-cleanup'}
        onCancel={() => setIndexConfirmOpen(false)}
        onConfirm={() => void cleanupIndex()}
      />
    </div>
  )
}
