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
import { Badge, ConfirmDialog, PageHeader } from '../ui'

const sourceLabels: Record<CodexSessionRepairTargetSource, string> = {
  config: '配置',
  rollout: '会话',
  sqlite: '索引',
}

export function SessionRepairView({ api }: { api: GatewayApi }) {
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
      setError(cause instanceof Error ? cause.message : '无法扫描 Codex 会话')
    } finally {
      setBusy(null)
    }
  }, [api, targetProvider])

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
      setError(cause instanceof Error ? cause.message : '无法预览会话修复')
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
      setError(cause instanceof Error ? cause.message : '会话修复失败')
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
        title="会话修复"
        description="切换官方账号、API 或 Stone+ provider 后，让 Codex 历史对话重新归属到当前模式"
        actions={
          <button className="button button--secondary" type="button" disabled={running} onClick={() => void load()}>
            <RefreshCw size={16} className={busy === 'load' ? 'spin' : undefined} />重新扫描
          </button>
        }
      />

      {error && <div className="error-banner" role="alert"><div><AlertTriangle size={16} /><span>{error}</span></div></div>}
      {result && (
        <div className="client-config-notice session-repair-notice">
          <CheckCircle2 size={17} />
          <span>
            已同步到 <strong>{result.targetProvider}</strong>：修复 {result.repairedRolloutFiles} 个会话文件，更新 {result.sqliteProviderRowsUpdated + result.sqliteUserEventRowsUpdated + result.sqliteCwdRowsUpdated} 行索引。
            {result.backupPath && <small className="mono">备份：{result.backupPath}</small>}
            {result.retentionWarning && <small>{result.retentionWarning}</small>}
          </span>
        </div>
      )}

      <section className="metrics-grid session-repair-metrics">
        <article className="metric-card">
          <span className="metric-card__label">当前 provider</span>
          <strong className="metric-card__uptime mono">{overview?.currentProvider ?? '—'}</strong>
          <span>来自 ~/.codex/config.toml</span>
          <div className="metric-card__icon metric-card__icon--green"><Wrench size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">本地会话文件</span>
          <strong>{totalRollouts}</strong>
          <span>{overview?.sessionFiles ?? 0} 个活跃 · {overview?.archivedSessionFiles ?? 0} 个归档</span>
          <div className="metric-card__icon metric-card__icon--blue"><FileText size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">SQLite 线程索引</span>
          <strong>{overview?.indexedThreads ?? 0}</strong>
          <span>{overview?.sqliteDatabases.length ?? 0} 个包含 threads 的数据库</span>
          <div className="metric-card__icon metric-card__icon--violet"><Database size={18} /></div>
        </article>
        <article className="metric-card">
          <span className="metric-card__label">预览改动</span>
          <strong>{totalChanges}</strong>
          <span>{preview ? preview.rolloutFilesToUpdate ? '存在需要同步的历史会话' : totalChanges ? '仅需修复索引' : '当前目标已同步' : '等待预览'}</span>
          <div className="metric-card__icon metric-card__icon--amber"><History size={18} /></div>
        </article>
      </section>

      <section className="panel session-repair-panel">
        <header className="session-repair-panel__header">
          <div><ShieldCheck size={20} /><div><h2>Provider metadata 同步</h2><p>同步 rollout 的 session_meta 与 SQLite threads 索引；写入前创建完整可恢复备份，并保留原会话时间。</p></div></div>
          <Badge tone={totalChanges ? 'warning' : 'success'}>{preview ? totalChanges ? '待修复' : '已同步' : '未预览'}</Badge>
        </header>

        <div className="session-repair-controls">
          <label className="field">
            <span>同步目标</span>
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
                  {target.id}（{target.sources.map((source) => sourceLabels[source]).join(' / ')}{target.isCurrentProvider ? ' / 当前' : ''}）
                </option>
              ))}
            </select>
          </label>
          <div className="session-repair-actions">
            <button className="button button--secondary" type="button" disabled={running || !targetProvider} onClick={() => void runPreview()}>
              {busy === 'preview' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}预览修复
            </button>
            <button className="button button--primary" type="button" disabled={running || !preview || totalChanges === 0} onClick={() => setConfirmOpen(true)}>
              {busy === 'repair' ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}立即修复历史会话
            </button>
          </div>
        </div>

        {busy === 'load' && !preview ? (
          <div className="session-repair-loading"><LoaderCircle size={20} className="spin" /><span>正在扫描 rollout 与 SQLite 索引…</span></div>
        ) : preview ? (
          <div className="session-repair-preview">
            <div><span>rollout provider</span><strong>{preview.rolloutFilesToUpdate}</strong><small>个会话文件</small></div>
            <div><span>SQLite provider</span><strong>{preview.sqliteProviderRowsToUpdate}</strong><small>行线程归属</small></div>
            <div><span>用户事件索引</span><strong>{preview.sqliteUserEventRowsToUpdate}</strong><small>行可见性标记</small></div>
            <div><span>工作区索引</span><strong>{preview.sqliteCwdRowsToUpdate}</strong><small>行 cwd 路径</small></div>
          </div>
        ) : (
          <div className="session-repair-loading"><RefreshCw size={19} /><span>目标已切换，点击“预览修复”重新计算安全快照。</span></div>
        )}
      </section>

      {preview?.encryptedSessionFiles ? (
        <div className="warning-banner warning-banner--danger"><div><AlertTriangle size={17} /><div><strong>检测到 encrypted_content</strong><span>{preview.encryptedSessionFiles} 个会话来自 {preview.encryptedSourceProviders.join('、')}。修复可恢复列表可见性，但续聊或压缩旧上下文时仍可能要求原账号/provider。</span></div></div></div>
      ) : null}
      {overview?.skippedFiles.length ? (
        <div className="warning-banner"><div><AlertTriangle size={17} /><div><strong>有文件被占用</strong><span>{overview.skippedFiles.length} 个 rollout 未进入本次预览；关闭对应 Codex 会话后重新扫描。</span></div></div></div>
      ) : null}

      <section className="panel session-repair-details">
        <header><Archive size={18} /><div><strong>数据与备份范围</strong><span className="mono">{overview?.codexHome ?? '~/.codex'}</span></div></header>
        <ul>
          <li>只改写 JSONL 中 <code>session_meta.payload.model_provider</code>，不会修改对话正文。</li>
          <li>SQLite 更新使用事务与原值校验，不覆盖预览后新产生的线程变化。</li>
          <li>备份保存在 <code>~/.codex/backups_state/stone-session-repair</code>，自动保留最近 5 次。</li>
        </ul>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="修复 Codex 历史会话"
        message={`将 ${preview?.rolloutFilesToUpdate ?? 0} 个会话文件及 ${preview ? preview.sqliteProviderRowsToUpdate + preview.sqliteUserEventRowsToUpdate + preview.sqliteCwdRowsToUpdate : 0} 行索引同步到 ${preview?.targetProvider ?? targetProvider}。Stone+ 会先创建备份，是否继续？`}
        confirmLabel="创建备份并修复"
        busy={busy === 'repair'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void repair()}
      />
    </div>
  )
}
