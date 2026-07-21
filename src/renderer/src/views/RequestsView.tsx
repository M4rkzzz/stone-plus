import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Filter,
  Search,
  TriangleAlert,
} from 'lucide-react'
import type { AppSnapshot, GatewayApi, RequestLog, RouteClient } from '@shared/types'
import type { ActionRunner } from '../App'
import {
  Badge,
  ConfirmDialog,
  durationLabel,
  EmptyState,
  formatCompactNumber,
  formatDateTime,
  Modal,
  PageHeader,
  protocolLabels,
  RequestStatusBadge,
} from '../ui'
import { useI18n } from '../i18n'
import { accountDisplayName, conversationDisplayName } from '../system-generated-text'

const clientNames: Record<RouteClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

const failureStageLabels: Record<NonNullable<RequestLog['failureStage']>, readonly [string, string]> = {
  body: ['读取请求体', 'Read request body'],
  scheduler: ['选择账号', 'Select account'],
  credential: ['解析凭据', 'Resolve credentials'],
  connect: ['连接上游', 'Connect upstream'],
  'first-byte': ['等待首包', 'Wait for first byte'],
  stream: ['流式传输', 'Stream response'],
  client: ['客户端连接', 'Client connection'],
}

type RequestColumnId = 'time' | 'client' | 'conversation' | 'model' | 'account' | 'status' | 'firstToken' | 'latency' | 'tokens'

interface RequestColumnDefinition {
  id: RequestColumnId
  label: readonly [string, string]
  defaultWidth: number
  minimumWidth: number
}

const REQUEST_COLUMN_STORAGE_KEY = 'stone:request-column-widths:v1'
const displayedFirstTokenMs = (log: RequestLog): number | undefined => log.requestKind === 'compaction'
  ? undefined
  : log.upstreamFirstByteMs ?? log.firstTokenMs
const requestStartedAt = (log: RequestLog): number => log.startedAt ?? log.timestamp
const liveElapsedMs = (log: RequestLog, now: number): number => log.status === 'streaming'
  ? Math.max(log.latencyMs, now - requestStartedAt(log))
  : log.latencyMs
const liveStageLabels: Record<NonNullable<RequestLog['progressStage']>, readonly [string, string]> = {
  'receiving-body': ['接收请求', 'Receiving request'],
  scheduling: ['选择上游', 'Selecting upstream'],
  'resolving-credential': ['准备凭据', 'Preparing credentials'],
  connecting: ['连接上游', 'Connecting upstream'],
  'waiting-first-byte': ['等待首字', 'Waiting for first token'],
  streaming: ['正在传输', 'Streaming'],
  retrying: ['切换重试', 'Retrying'],
}
const outboundHeadersWaitMs = (log: RequestLog): number | undefined =>
  log.outboundFetchStartMs === undefined || log.upstreamHeadersMs === undefined
    ? undefined
    : Math.max(0, log.upstreamHeadersMs - log.outboundFetchStartMs)
const REQUEST_COLUMNS: RequestColumnDefinition[] = [
  { id: 'time', label: ['时间', 'Time'], defaultWidth: 94, minimumWidth: 80 },
  { id: 'client', label: ['客户端', 'Client'], defaultWidth: 100, minimumWidth: 84 },
  { id: 'conversation', label: ['所属对话', 'Conversation'], defaultWidth: 240, minimumWidth: 140 },
  { id: 'model', label: ['模型', 'Model'], defaultWidth: 135, minimumWidth: 92 },
  { id: 'account', label: ['上游源', 'Upstream'], defaultWidth: 145, minimumWidth: 105 },
  { id: 'status', label: ['状态', 'Status'], defaultWidth: 94, minimumWidth: 78 },
  { id: 'firstToken', label: ['首字', 'First Token'], defaultWidth: 82, minimumWidth: 68 },
  { id: 'latency', label: ['总耗时', 'Total Time'], defaultWidth: 88, minimumWidth: 72 },
  { id: 'tokens', label: ['Token', 'Tokens'], defaultWidth: 84, minimumWidth: 68 },
]

type RequestColumnWidths = Record<RequestColumnId, number>

function defaultRequestColumnWidths(): RequestColumnWidths {
  return Object.fromEntries(REQUEST_COLUMNS.map((column) => [column.id, column.defaultWidth])) as RequestColumnWidths
}

function loadRequestColumnWidths(): RequestColumnWidths {
  const defaults = defaultRequestColumnWidths()
  try {
    const stored = JSON.parse(window.localStorage.getItem(REQUEST_COLUMN_STORAGE_KEY) ?? '{}') as Record<string, unknown>
    for (const column of REQUEST_COLUMNS) {
      const width = stored[column.id]
      if (typeof width === 'number' && Number.isFinite(width)) {
        defaults[column.id] = Math.max(column.minimumWidth, Math.min(640, Math.round(width)))
      }
    }
  } catch {
    // Invalid renderer storage falls back to the compact defaults.
  }
  return defaults
}

function DetailItem({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return <div className="request-detail__item"><span>{label}</span><strong className={mono ? 'mono' : undefined}>{children}</strong></div>
}

function compactConversationId(value: string | undefined): string {
  if (!value) return '—'
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function formatTransferBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function RequestsView({
  snapshot,
  api,
  runAction,
  busyKeys,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
}) {
  const { t, language, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | RequestLog['status']>('all')
  const [client, setClient] = useState<'all' | RouteClient>('all')
  const [selected, setSelected] = useState<RequestLog | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showConversationNames, setShowConversationNames] = useState(false)
  const [columnWidths, setColumnWidths] = useState<RequestColumnWidths>(loadRequestColumnWidths)
  const [liveNow, setLiveNow] = useState(Date.now())
  const resizingColumn = useRef<{ id: RequestColumnId; startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(REQUEST_COLUMN_STORAGE_KEY, JSON.stringify(columnWidths))
    } catch {
      // The table remains usable when renderer storage is unavailable.
    }
  }, [columnWidths])

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const resize = resizingColumn.current
      if (!resize) return
      const definition = REQUEST_COLUMNS.find((column) => column.id === resize.id)
      if (!definition) return
      const width = Math.max(definition.minimumWidth, Math.min(640, Math.round(resize.startWidth + event.clientX - resize.startX)))
      setColumnWidths((current) => current[resize.id] === width ? current : { ...current, [resize.id]: width })
    }
    const stop = () => {
      resizingColumn.current = null
      document.body.classList.remove('request-column-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('request-column-resizing')
    }
  }, [])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return snapshot.requestLogs.filter((log) => {
      if (status !== 'all' && log.status !== status) return false
      if (client !== 'all' && log.client !== client) return false
      if (!normalized) return true
      return [log.id, log.model, log.providerName, accountDisplayName(log.accountName, t), log.conversationId, conversationDisplayName(log.conversationName, t), log.error]
        .some((value) => value?.toLowerCase().includes(normalized))
    })
  }, [client, query, snapshot.requestLogs, status, t])

  useEffect(() => {
    if (!snapshot.requestLogs.some((log) => log.status === 'streaming')) return
    setLiveNow(Date.now())
    const timer = window.setInterval(() => setLiveNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [snapshot.requestLogs])

  useEffect(() => {
    if (!selected) return
    const latest = snapshot.requestLogs.find((log) => log.id === selected.id)
    if (latest && latest !== selected) setSelected(latest)
  }, [selected, snapshot.requestLogs])

  const successCount = snapshot.requestLogs.filter((log) => log.status === 'success').length
  const errorCount = snapshot.requestLogs.filter((log) => log.status === 'error').length
  const completedLogs = snapshot.requestLogs.filter((log) => log.status !== 'streaming')
  const averageLatency = completedLogs.length
    ? Math.round(completedLogs.reduce((total, log) => total + log.latencyMs, 0) / completedLogs.length)
    : 0
  const firstTokenLogs = snapshot.requestLogs.filter((log) => displayedFirstTokenMs(log) !== undefined)
  const averageFirstToken = firstTokenLogs.length
    ? Math.round(firstTokenLogs.reduce((total, log) => total + (displayedFirstTokenMs(log) ?? 0), 0) / firstTokenLogs.length)
    : 0
  const totalTokens = snapshot.requestLogs.reduce((total, log) => total + (log.inputTokens ?? 0) + (log.outputTokens ?? 0), 0)
  const requestTableWidth = REQUEST_COLUMNS.reduce((total, column) => total + columnWidths[column.id], 0)

  const beginColumnResize = (event: React.MouseEvent, column: RequestColumnDefinition) => {
    event.preventDefault()
    event.stopPropagation()
    resizingColumn.current = { id: column.id, startX: event.clientX, startWidth: columnWidths[column.id] }
    document.body.classList.add('request-column-resizing')
  }

  const resizeColumnByKeyboard = (event: React.KeyboardEvent, column: RequestColumnDefinition) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    setColumnWidths((current) => ({
      ...current,
      [column.id]: event.key === 'Home'
        ? column.defaultWidth
        : Math.max(column.minimumWidth, Math.min(640, current[column.id] + (event.key === 'ArrowLeft' ? -8 : 8)))
    }))
  }

  const clear = async () => {
    const success = await runAction('clear-logs', () => api.clearLogs())
    if (success) setConfirmClear(false)
  }

  const exportLogs = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `stone-requests-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('请求日志', 'Request Logs')}
        actions={
          <>
            <button className="button button--secondary" type="button" disabled={!filtered.length} onClick={exportLogs}><Download size={16} />{t('导出', 'Export')}</button>
            <button className="button button--secondary button--danger-text" type="button" disabled={!snapshot.requestLogs.length} onClick={() => setConfirmClear(true)}><Eraser size={16} />{t('清空', 'Clear')}</button>
          </>
        }
      />

      <section className="request-stats" aria-label={t('日志统计', 'Log statistics')}>
        <div><Activity size={16} /><span>{t('记录', 'Records')}</span><strong>{snapshot.requestLogs.length}</strong></div>
        <div><CheckCircle2 size={16} /><span>{t('成功', 'Success')}</span><strong>{successCount}</strong></div>
        <div><TriangleAlert size={16} /><span>{t('失败', 'Failed')}</span><strong>{errorCount}</strong></div>
        <div><span>{t('平均首字', 'Average First Token')}</span><strong>{averageFirstToken ? durationLabel(averageFirstToken) : '—'}</strong></div>
        <div><span>{t('平均延迟', 'Average Latency')}</span><strong>{averageLatency ? durationLabel(averageLatency) : '—'}</strong></div>
        <div><span>Token</span><strong>{formatCompactNumber(totalTokens, locale)}</strong></div>
      </section>

      <section className="panel panel--flush request-log-panel">
        <div className="table-toolbar">
          <label className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索对话、模型、供应商或请求 ID', 'Search conversations, models, providers, or request IDs')} /></label>
          <div className="filter-group"><Filter size={15} /><select value={client} aria-label={t('筛选客户端', 'Filter clients')} onChange={(event) => setClient(event.target.value as 'all' | RouteClient)}><option value="all">{t('全部客户端', 'All Clients')}</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option></select><select value={status} aria-label={t('筛选状态', 'Filter status')} onChange={(event) => setStatus(event.target.value as 'all' | RequestLog['status'])}><option value="all">{t('全部状态', 'All Statuses')}</option><option value="success">{t('成功', 'Success')}</option><option value="error">{t('失败', 'Failed')}</option><option value="streaming">{t('传输中', 'Streaming')}</option></select></div>
        </div>

        {filtered.length ? (
          <>
            <div className="table-wrap">
              <table className="data-table request-table" style={{ width: requestTableWidth, minWidth: '100%' }}>
                <colgroup>{REQUEST_COLUMNS.map((column) => <col key={column.id} style={{ width: columnWidths[column.id] }} />)}</colgroup>
                <thead><tr>{REQUEST_COLUMNS.map((column) => (
                  <th className="request-column-header" key={column.id}>
                    {column.id === 'conversation'
                      ? <span className="request-column-title"><span>{t(column.label[0], column.label[1])}</span><button aria-label={showConversationNames ? t('隐藏全部对话标题', 'Hide all conversation titles') : t('显示全部对话标题', 'Show all conversation titles')} className="request-conversation-visibility" type="button" title={showConversationNames ? t('隐藏全部对话标题', 'Hide all conversation titles') : t('显示全部对话标题', 'Show all conversation titles')} onClick={(event) => { event.stopPropagation(); setShowConversationNames((visible) => !visible) }}>{showConversationNames ? <Eye size={14} /> : <EyeOff size={14} />}</button></span>
                      : <span>{t(column.label[0], column.label[1])}</span>}
                    <span
                      aria-label={t(`调整${column.label[0]}列宽`, `Resize ${column.label[1]} column`)}
                      aria-orientation="vertical"
                      aria-valuemax={640}
                      aria-valuemin={column.minimumWidth}
                      aria-valuenow={columnWidths[column.id]}
                      className="request-column-resizer"
                      data-column-resizer={column.id}
                      role="separator"
                      tabIndex={0}
                      title={t('拖动调整列宽；双击或按 Home 恢复默认', 'Drag to resize; double-click or press Home to restore the default')}
                      onDoubleClick={(event) => { event.stopPropagation(); setColumnWidths((current) => ({ ...current, [column.id]: column.defaultWidth })) }}
                      onKeyDown={(event) => resizeColumnByKeyboard(event, column)}
                      onMouseDown={(event) => beginColumnResize(event, column)}
                    />
                  </th>
                ))}</tr></thead>
                <tbody>
                  {filtered.map((log) => (
                    <tr className={log.status === 'streaming' ? 'request-row--live' : ''} key={log.id} tabIndex={0} onClick={() => setSelected(log)} onKeyDown={(event) => event.key === 'Enter' && setSelected(log)}>
                      <td><div className="table-primary"><strong>{formatDateTime(requestStartedAt(log), locale).split(' ')[1]}</strong><span>{formatDateTime(requestStartedAt(log), locale).split(' ')[0]}</span></div></td>
                      <td><div className="cell-with-icon"><span className={`client-dot client-dot--${log.client}`} />{clientNames[log.client]}</div></td>
                      <td><div className={`table-primary request-conversation${showConversationNames ? '' : ' request-conversation--hidden'}`}>{showConversationNames && <strong title={conversationDisplayName(log.conversationName, t)}>{conversationDisplayName(log.conversationName, t) ?? '—'}</strong>}<span className="mono" title={log.conversationId}>{compactConversationId(log.conversationId)}</span></div></td>
                      <td><span className="mono table-model">{log.model}</span></td>
                      <td><div className="table-primary"><strong>{log.providerName}</strong><span>{accountDisplayName(log.accountName, t)}</span></div></td>
                      <td>{log.status === 'streaming'
                        ? <span className="request-live-status"><i aria-hidden="true" /><span>{t(liveStageLabels[log.progressStage ?? 'receiving-body'][0], liveStageLabels[log.progressStage ?? 'receiving-body'][1])}</span></span>
                        : <><RequestStatusBadge status={log.status} statusCode={log.statusCode} requestKind={log.requestKind} />{log.statusCode && <span className="status-code">{log.statusCode}</span>}</>}</td>
                      <td>{displayedFirstTokenMs(log) !== undefined ? durationLabel(displayedFirstTokenMs(log)!) : '—'}</td>
                      <td className={log.status === 'streaming' ? 'request-live-duration' : ''}>{durationLabel(liveElapsedMs(log, liveNow))}</td>
                      <td>{log.inputTokens !== undefined
                        ? formatCompactNumber((log.inputTokens ?? 0) + (log.outputTokens ?? 0), locale)
                        : log.status === 'streaming' && (log.streamedBytes ?? 0) > 0
                          ? <span className="request-live-bytes" title={t('当前已接收的流数据量，最终 Token 以服务端用量为准', 'Live stream data received; final tokens use the upstream usage report')}>{formatTransferBytes(log.streamedBytes ?? 0)}</span>
                          : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="table-footer"><span>{t(`显示 ${filtered.length} / ${snapshot.requestLogs.length} 条记录`, `Showing ${filtered.length} / ${snapshot.requestLogs.length} records`)}</span><span>{t('仅保存在本机', 'Stored locally only')}</span></footer>
          </>
        ) : (
          <EmptyState icon={<Activity size={24} />} title={snapshot.requestLogs.length ? t('没有匹配的请求', 'No matching requests') : t('暂无请求日志', 'No request logs')} description={snapshot.requestLogs.length ? t('调整搜索词或筛选条件', 'Adjust the search term or filters') : t('网关收到请求后会在此显示记录', 'Requests will appear here after the gateway receives them')} action={snapshot.requestLogs.length ? <button className="button button--secondary" type="button" onClick={() => { setQuery(''); setClient('all'); setStatus('all') }}>{t('重置筛选', 'Reset Filters')}</button> : undefined} />
        )}
      </section>

      <Modal open={Boolean(selected)} title={t('请求详情', 'Request Details')} description={selected ? formatDateTime(requestStartedAt(selected), locale) : undefined} onClose={() => setSelected(null)} width="medium">
        {selected && (
          <div className="request-detail">
            <div className="request-detail__status"><RequestStatusBadge status={selected.status} statusCode={selected.statusCode} requestKind={selected.requestKind} /><span>{selected.statusCode ?? '—'}</span><strong>{durationLabel(liveElapsedMs(selected, liveNow))}</strong></div>
            <div className="request-detail__grid">
              <DetailItem label={t('请求 ID', 'Request ID')} mono>{selected.id}</DetailItem>
              <DetailItem label={t('客户端', 'Client')}>{clientNames[selected.client]}</DetailItem>
              <DetailItem label={t('对话名称', 'Conversation Name')}>{showConversationNames ? conversationDisplayName(selected.conversationName, t) ?? '—' : t('已隐藏', 'Hidden')}</DetailItem>
              <DetailItem label={t('对话 ID', 'Conversation ID')} mono>{selected.conversationId ?? '—'}</DetailItem>
              <DetailItem label={t('入站协议', 'Inbound Protocol')}>{protocolLabels[selected.protocol]}</DetailItem>
              <DetailItem label={t('模型', 'Model')} mono>{selected.model}</DetailItem>
              <DetailItem label={t('供应商', 'Provider')}>{selected.providerName}</DetailItem>
              <DetailItem label={t('账号', 'Account')}>{accountDisplayName(selected.accountName, t)}</DetailItem>
              {selected.status === 'streaming' && <DetailItem label={t('实时阶段', 'Live Stage')}>{t(liveStageLabels[selected.progressStage ?? 'receiving-body'][0], liveStageLabels[selected.progressStage ?? 'receiving-body'][1])}</DetailItem>}
              {selected.failureStage && <DetailItem label={t('失败阶段', 'Failure Stage')}>{t(failureStageLabels[selected.failureStage][0], failureStageLabels[selected.failureStage][1])}</DetailItem>}
              <DetailItem label={t('首字时间', 'First Token Time')}>{displayedFirstTokenMs(selected) !== undefined ? durationLabel(displayedFirstTokenMs(selected)!) : '—'}</DetailItem>
              <DetailItem label={t('可见首字时间', 'Visible First Token Time')}>{selected.firstTokenMs !== undefined ? durationLabel(selected.firstTokenMs) : '—'}</DetailItem>
              <DetailItem label={t('请求体读取', 'Request Body Read')}>{selected.bodyReadMs !== undefined ? durationLabel(selected.bodyReadMs) : '—'}</DetailItem>
              <DetailItem label={t('账号调度', 'Account Scheduling')}>{selected.schedulerSelectMs !== undefined ? durationLabel(selected.schedulerSelectMs) : '—'}</DetailItem>
              <DetailItem label={t('凭据解析', 'Credential Resolution')}>{selected.credentialResolveMs !== undefined ? durationLabel(selected.credentialResolveMs) : '—'}</DetailItem>
              <DetailItem label={t('发起上游', 'Upstream Request Start')}>{selected.outboundFetchStartMs !== undefined ? durationLabel(selected.outboundFetchStartMs) : '—'}</DetailItem>
              <DetailItem label={t('上游等待响应头', 'Upstream Headers Wait')}>{outboundHeadersWaitMs(selected) !== undefined ? durationLabel(outboundHeadersWaitMs(selected)!) : '—'}</DetailItem>
              <DetailItem label={t('上游响应头', 'Upstream Headers')}>{selected.upstreamHeadersMs !== undefined ? durationLabel(selected.upstreamHeadersMs) : '—'}</DetailItem>
              <DetailItem label={t('客户端首写', 'First Client Write')}>{selected.clientFirstWriteMs !== undefined ? durationLabel(selected.clientFirstWriteMs) : '—'}</DetailItem>
              <DetailItem label={t('账号可见首字', 'Account-visible First Token')}>{selected.accountFirstTokenMs !== undefined ? durationLabel(selected.accountFirstTokenMs) : '—'}</DetailItem>
              <DetailItem label={t('总耗时', 'Total Time')}>{durationLabel(liveElapsedMs(selected, liveNow))}</DetailItem>
              <DetailItem label={t('输入 Token', 'Input Tokens')}>{selected.inputTokens?.toLocaleString(locale) ?? '—'}</DetailItem>
              <DetailItem label={t('缓存输入 Token', 'Cached Input Tokens')}>{selected.cachedInputTokens?.toLocaleString(locale) ?? '—'}</DetailItem>
              <DetailItem label={t('推理 Token', 'Reasoning Tokens')}>{selected.reasoningTokens?.toLocaleString(locale) ?? '—'}</DetailItem>
              <DetailItem label={t('输出 Token', 'Output Tokens')}>{selected.outputTokens?.toLocaleString(locale) ?? '—'}</DetailItem>
              {selected.status === 'streaming' && <DetailItem label={t('已接收流数据', 'Stream Data Received')}>{formatTransferBytes(selected.streamedBytes ?? 0)}</DetailItem>}
            </div>
            {selected.error && <div className="request-error"><TriangleAlert size={17} /><div><strong>{t('请求失败', 'Request Failed')}</strong><p>{language === 'en' && /[\u3400-\u9fff]/u.test(selected.error) ? 'The upstream request failed.' : selected.error}</p></div></div>}
            <div className="privacy-note"><Badge tone="neutral">{t('Payload 未记录', 'Payload not recorded')}</Badge><span>{t('仅记录会话标识和客户端提供的名称，不包含请求与响应正文', 'Only conversation identifiers and client-provided names are recorded; request and response bodies are excluded')}</span></div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={confirmClear} title={t('清空请求日志', 'Clear Request Logs')} message={t('确定清空全部本地请求记录吗？导出后也无法从 Stone+ 中恢复。', 'Clear all local request records? They cannot be restored from Stone+, even after export.')} confirmLabel={t('清空日志', 'Clear Logs')} busy={busyKeys.has('clear-logs')} onCancel={() => setConfirmClear(false)} onConfirm={() => void clear()} />
    </div>
  )
}
