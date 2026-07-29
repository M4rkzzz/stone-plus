import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, GatewayApi, RequestLog, RouteClient } from '@shared/types'
import { getGatewayApi } from './api'
import { requestLogSourceLabel } from './account-source-label'
import { useI18n } from './i18n'
import { applyRuntimeDelta, shouldAcceptSnapshotRevision } from './runtime-delta'
import { formatTokenBillions, summarizeRequestLogs } from './request-log-view-model'
import { durationLabel, formatCompactNumber } from './ui'
import { useVisibilityAwareInterval } from './visibility-interval'
import './request-monitor-window.css'

const visibleRequestLimit = 60

const clientNames: Record<RouteClient, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grokbuild: 'Grok',
}

const requestStartedAt = (log: RequestLog): number => log.startedAt ?? log.timestamp
const requestElapsedMs = (log: RequestLog, now: number): number => log.status === 'streaming'
  ? Math.max(log.latencyMs, now - requestStartedAt(log))
  : log.latencyMs

function useRuntimeSnapshot(api: GatewayApi): { snapshot: AppSnapshot | null; error: string } {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState('')
  const revision = useRef(-1)

  useEffect(() => {
    let disposed = false
    let reloadFlight: Promise<void> | undefined

    const acceptSnapshot = (next: AppSnapshot) => {
      if (disposed || !shouldAcceptSnapshotRevision(revision.current, next.runtimeRevision)) return
      if (next.runtimeRevision !== undefined) revision.current = next.runtimeRevision
      setSnapshot(next)
      setError('')
    }
    const reload = (): Promise<void> => {
      if (reloadFlight) return reloadFlight
      const flight = api.getSnapshot().then(acceptSnapshot).catch(() => {
        if (!disposed) setError('Stone+ 请求状态暂时不可用')
      }).finally(() => {
        if (reloadFlight === flight) reloadFlight = undefined
      })
      reloadFlight = flight
      return flight
    }
    const onFocus = () => { void reload() }

    void reload()
    const unsubscribeSnapshot = api.onSnapshot(acceptSnapshot)
    const unsubscribeRuntime = api.onRuntimeDelta((delta) => {
      if (disposed || delta.revision <= revision.current) return
      if (revision.current < 0 || delta.revision !== revision.current + 1) {
        void reload()
        return
      }
      revision.current = delta.revision
      setSnapshot((current) => current ? applyRuntimeDelta(current, delta) : current)
    })
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      unsubscribeSnapshot()
      unsubscribeRuntime()
      window.removeEventListener('focus', onFocus)
    }
  }, [api])

  return { snapshot, error }
}

export function RequestMonitorWindow() {
  const api = useMemo(() => getGatewayApi(), [])
  const { snapshot, error } = useRuntimeSnapshot(api)
  const { t, locale } = useI18n()
  const [liveNow, setLiveNow] = useState(Date.now())
  const logs = useMemo(() => snapshot?.requestLogs ?? [], [snapshot?.requestLogs])
  const summary = useMemo(() => summarizeRequestLogs(logs), [logs])
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }), [locale])
  const accountCredentialTypes = useMemo(() => new Map(
    (snapshot?.accounts ?? []).map((account) => [account.id, account.credentialType] as const),
  ), [snapshot?.accounts])

  useVisibilityAwareInterval(
    () => setLiveNow(Date.now()),
    1_000,
    summary.hasStreaming,
    true,
    undefined,
    2,
  )

  if (!snapshot) {
    return <main className="request-monitor request-monitor--loading"><span className="request-monitor__pulse" />{error || t('正在连接请求记录…', 'Connecting to request logs…')}</main>
  }

  return (
    <main className="request-monitor">
      <section className="request-monitor__stats" aria-label={t('请求统计', 'Request statistics')}>
        <div><span>{t('活跃', 'Active')}</span><strong>{snapshot.gatewayStatus.activeRequests}</strong></div>
        <div><span>{t('首字', 'First')}</span><strong>{summary.averageFirstToken ? durationLabel(summary.averageFirstToken) : '—'}</strong></div>
        <div><span>{t('耗时', 'Time')}</span><strong>{summary.averageLatency ? durationLabel(summary.averageLatency) : '—'}</strong></div>
        <div title={t('历史累计 Token', 'Lifetime tokens')}><span>Token</span><strong>{formatTokenBillions(snapshot.observability.tokenCosts.allTime.totalTokens)}</strong></div>
      </section>

      <section className="request-monitor__list" aria-label={t('实时请求记录', 'Live request records')}>
        {logs.length > 0 ? logs.slice(0, visibleRequestLimit).map((log) => {
          const tokenCount = (log.inputTokens ?? 0) + (log.outputTokens ?? 0)
          const source = requestLogSourceLabel(log, accountCredentialTypes.get(log.accountId ?? ''))
          return (
            <article className={`request-monitor-row request-monitor-row--${log.status}`} key={log.id} title={log.error}>
              <i aria-label={log.status === 'streaming' ? t('进行中', 'Active') : log.status === 'success' ? t('成功', 'Success') : t('失败', 'Failed')} />
              <time>{timeFormatter.format(requestStartedAt(log))}</time>
              <span>{clientNames[log.client]}</span>
              <strong title={`${(log.upstreamModel ?? log.model) || t('等待模型', 'Waiting for model')} · ${source}`}>{(log.upstreamModel ?? log.model) || t('等待模型', 'Waiting for model')}</strong>
              <em>{durationLabel(requestElapsedMs(log, liveNow))}</em>
              <small>{tokenCount ? formatCompactNumber(tokenCount, locale) : '—'}</small>
            </article>
          )
        }) : <div className="request-monitor__empty"><span className="request-monitor__pulse" /><strong>{t('等待第一个请求', 'Waiting for the first request')}</strong><small>{t('新请求会自动出现在这里', 'New requests appear here automatically')}</small></div>}
      </section>
    </main>
  )
}
