import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, LoaderCircle, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { CodexManagedSession, CodexSessionKind, GatewayApi } from '@shared/types'
import { useI18n } from './i18n'

export function CodexSessionManagerPanel({ api }: { api: GatewayApi }) {
  const { locale, t } = useI18n()
  const [sessions, setSessions] = useState<CodexManagedSession[]>([])
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<CodexSessionKind | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current
    setBusy('load'); setError(null)
    try {
      const next = await api.listCodexSessions({ search, kind, limit: 1_000 })
      if (sequence === requestSequence.current) setSessions(next)
    } catch (cause) {
      if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (sequence === requestSequence.current) setBusy(null) }
  }, [api, kind, search])
  useEffect(() => { const timer = setTimeout(() => void load(), 180); return () => clearTimeout(timer) }, [load])

  const mutate = async (key: string, operation: () => Promise<CodexManagedSession[]>) => {
    setBusy(key); setError(null)
    try { await operation(); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy((current) => current === key ? null : current) }
  }
  const nativeAction = async (operation: () => Promise<unknown>) => {
    setError(null)
    try { await operation() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <section className="panel codex-session-manager">
    <header><div><strong>{t('Codex 会话管理', 'Codex session manager')}</strong><small>{t('搜索、统计、导出与可恢复删除', 'Search, statistics, export, and recoverable deletion')}</small></div><button className="icon-button" type="button" onClick={() => void load()}>{busy === 'load' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></header>
    <div className="codex-session-manager__toolbar"><label><Search size={15} /><input value={search} placeholder={t('搜索标题、项目、ID', 'Search title, project, or ID')} onChange={(event) => setSearch(event.target.value)} /></label><select value={kind} onChange={(event) => setKind(event.target.value as CodexSessionKind | 'all')}><option value="all">{t('全部', 'All')}</option><option value="active">{t('活跃', 'Active')}</option><option value="archived">{t('归档', 'Archived')}</option><option value="trash">{t('回收站', 'Trash')}</option></select></div>
    {error && <div className="client-preview-error">{error}</div>}
    <div className="codex-session-manager__list">{sessions.length === 0 ? <span className="muted">{t('没有匹配的会话', 'No matching sessions')}</span> : sessions.map((session) => <article key={`${session.kind}:${session.relativePath}`}>
      <span><strong>{session.title}</strong><small>{session.cwd ?? session.id}</small></span>
      <span><strong>{session.totalTokens.toLocaleString(locale)}</strong><small>Token</small></span>
      <span><strong>{new Date(session.updatedAt).toLocaleString(locale)}</strong><small>{session.kind}</small></span>
      <button className="icon-button" type="button" title={t('打开位置', 'Open location')} onClick={() => void nativeAction(() => api.openCodexSessionLocation(session.id, session.revision))}><FolderOpen size={15} /></button>
      <button className="icon-button" type="button" title={t('导出', 'Export')} onClick={() => void nativeAction(() => api.exportCodexSession(session.id, session.revision))}><Download size={15} /></button>
      {session.kind === 'trash'
        ? <button className="icon-button" type="button" title={t('恢复', 'Restore')} disabled={Boolean(busy)} onClick={() => void mutate(`restore-${session.id}`, () => api.restoreCodexSession(session.id, session.revision))}>{busy === `restore-${session.id}` ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button>
        : <button className="icon-button" type="button" title={t('移到回收站', 'Move to trash')} disabled={Boolean(busy)} onClick={() => void mutate(`trash-${session.id}`, () => api.trashCodexSession(session.id, session.revision))}>{busy === `trash-${session.id}` ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button>}
    </article>)}</div>
  </section>
}
