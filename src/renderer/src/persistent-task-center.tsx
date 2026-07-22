import { useCallback, useEffect, useState } from 'react'
import { Ban, LoaderCircle, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import type { GatewayApi, PersistentTask } from '@shared/types'
import { useI18n } from './i18n'

const statusCopy: Record<PersistentTask['status'], readonly [string, string]> = {
  paused: ['已暂停', 'Paused'],
  running: ['运行中', 'Running'],
  completed: ['已完成', 'Completed'],
  failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled']
}

export function PersistentTaskCenter({ api }: { api: GatewayApi }) {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<PersistentTask[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setTasks(await api.listPersistentTasks())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 2_000)
    return () => clearInterval(timer)
  }, [load])
  const action = async (id: string, operation: () => Promise<PersistentTask>) => {
    setBusy(id)
    setError(null)
    try {
      await operation()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const clearTerminal = async () => {
    setBusy('clear')
    setError(null)
    try {
      setTasks(await api.clearPersistentTasks())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const labelKind = (kind: string) => kind === 'account.bulk-check'
    ? t('批量检测账号', 'Bulk account check')
    : kind
  const labelStatus = (status: PersistentTask['status']) => t(...statusCopy[status])
  const hasTerminal = tasks.some((task) => ['completed', 'cancelled', 'failed'].includes(task.status))

  return <details className="persistent-task-center panel">
    <summary>
      <span>{t('后台任务', 'Background tasks')} <small>{tasks.length}</small></span>
      <button className="icon-button" type="button" title={t('刷新', 'Refresh')} onClick={(event) => { event.preventDefault(); void load() }}><RefreshCw size={15} /></button>
    </summary>
    <div>
      {(error || hasTerminal) && <div className="persistent-task-toolbar">
        {error ? <span className="error-text" role="alert">{error}</span> : <span />}
        {hasTerminal && <button className="secondary-button compact" type="button" disabled={busy === 'clear'} onClick={() => void clearTerminal()}>
          {busy === 'clear' ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {t('清除已结束', 'Clear finished')}
        </button>}
      </div>}
      {tasks.length === 0 ? <span className="muted">{t('暂无后台任务', 'No background tasks')}</span> : tasks.map((task) => <article key={task.id}>
        <span><strong>{labelKind(task.kind)}</strong><small>{task.progress.message ?? labelStatus(task.status)}</small></span>
        <progress max={100} value={task.progress.percent} /><b>{task.progress.percent}%</b>
        {busy === task.id ? <LoaderCircle className="spin" size={15} /> : task.status === 'running'
          ? <button className="icon-button" type="button" title={t('暂停', 'Pause')} onClick={() => void action(task.id, () => api.pausePersistentTask(task.id))}><Pause size={15} /></button>
          : task.status === 'paused' || task.status === 'failed'
            ? <button className="icon-button" type="button" title={t('继续', 'Resume')} onClick={() => void action(task.id, () => api.resumePersistentTask(task.id))}><Play size={15} /></button>
            : <span />}
        {!['completed', 'cancelled'].includes(task.status) && <button className="icon-button" type="button" title={t('取消', 'Cancel')} onClick={() => void action(task.id, () => api.cancelPersistentTask(task.id))}><Ban size={15} /></button>}
      </article>)}
    </div>
  </details>
}
