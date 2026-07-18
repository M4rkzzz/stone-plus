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

const clientNames: Record<RouteClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

type RequestColumnId = 'time' | 'client' | 'conversation' | 'model' | 'account' | 'status' | 'firstToken' | 'latency' | 'tokens'

interface RequestColumnDefinition {
  id: RequestColumnId
  label: string
  defaultWidth: number
  minimumWidth: number
}

const REQUEST_COLUMN_STORAGE_KEY = 'stone:request-column-widths:v1'
const REQUEST_COLUMNS: RequestColumnDefinition[] = [
  { id: 'time', label: '时间', defaultWidth: 94, minimumWidth: 80 },
  { id: 'client', label: '客户端', defaultWidth: 100, minimumWidth: 84 },
  { id: 'conversation', label: '所属对话', defaultWidth: 240, minimumWidth: 140 },
  { id: 'model', label: '模型', defaultWidth: 135, minimumWidth: 92 },
  { id: 'account', label: '上游账号', defaultWidth: 145, minimumWidth: 105 },
  { id: 'status', label: '状态', defaultWidth: 94, minimumWidth: 78 },
  { id: 'firstToken', label: '首字', defaultWidth: 82, minimumWidth: 68 },
  { id: 'latency', label: '总耗时', defaultWidth: 88, minimumWidth: 72 },
  { id: 'tokens', label: 'Token', defaultWidth: 84, minimumWidth: 68 },
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
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | RequestLog['status']>('all')
  const [client, setClient] = useState<'all' | RouteClient>('all')
  const [selected, setSelected] = useState<RequestLog | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showConversationNames, setShowConversationNames] = useState(false)
  const [columnWidths, setColumnWidths] = useState<RequestColumnWidths>(loadRequestColumnWidths)
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
      return [log.id, log.model, log.providerName, log.accountName, log.conversationId, log.conversationName, log.error]
        .some((value) => value?.toLowerCase().includes(normalized))
    })
  }, [client, query, snapshot.requestLogs, status])

  const successCount = snapshot.requestLogs.filter((log) => log.status === 'success').length
  const errorCount = snapshot.requestLogs.filter((log) => log.status === 'error').length
  const averageLatency = snapshot.requestLogs.length
    ? Math.round(snapshot.requestLogs.reduce((total, log) => total + log.latencyMs, 0) / snapshot.requestLogs.length)
    : 0
  const firstTokenLogs = snapshot.requestLogs.filter((log) => log.firstTokenMs !== undefined)
  const averageFirstToken = firstTokenLogs.length
    ? Math.round(firstTokenLogs.reduce((total, log) => total + (log.firstTokenMs ?? 0), 0) / firstTokenLogs.length)
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
        title="请求日志"
        description="查看本机请求的路由结果与性能"
        actions={
          <>
            <button className="button button--secondary" type="button" disabled={!filtered.length} onClick={exportLogs}><Download size={16} />导出</button>
            <button className="button button--secondary button--danger-text" type="button" disabled={!snapshot.requestLogs.length} onClick={() => setConfirmClear(true)}><Eraser size={16} />清空</button>
          </>
        }
      />

      <section className="request-stats" aria-label="日志统计">
        <div><Activity size={16} /><span>记录</span><strong>{snapshot.requestLogs.length}</strong></div>
        <div><CheckCircle2 size={16} /><span>成功</span><strong>{successCount}</strong></div>
        <div><TriangleAlert size={16} /><span>失败</span><strong>{errorCount}</strong></div>
        <div><span>平均首字</span><strong>{averageFirstToken ? durationLabel(averageFirstToken) : '—'}</strong></div>
        <div><span>平均延迟</span><strong>{averageLatency ? durationLabel(averageLatency) : '—'}</strong></div>
        <div><span>Token</span><strong>{formatCompactNumber(totalTokens)}</strong></div>
      </section>

      <section className="panel panel--flush request-log-panel">
        <div className="table-toolbar">
          <label className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话、模型、供应商或请求 ID" /></label>
          <div className="filter-group"><Filter size={15} /><select value={client} aria-label="筛选客户端" onChange={(event) => setClient(event.target.value as 'all' | RouteClient)}><option value="all">全部客户端</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option></select><select value={status} aria-label="筛选状态" onChange={(event) => setStatus(event.target.value as 'all' | RequestLog['status'])}><option value="all">全部状态</option><option value="success">成功</option><option value="error">失败</option><option value="streaming">传输中</option></select></div>
        </div>

        {filtered.length ? (
          <>
            <div className="table-wrap">
              <table className="data-table request-table" style={{ width: requestTableWidth, minWidth: '100%' }}>
                <colgroup>{REQUEST_COLUMNS.map((column) => <col key={column.id} style={{ width: columnWidths[column.id] }} />)}</colgroup>
                <thead><tr>{REQUEST_COLUMNS.map((column) => (
                  <th className="request-column-header" key={column.id}>
                    {column.id === 'conversation'
                      ? <span className="request-column-title"><span>{column.label}</span><button aria-label={showConversationNames ? '隐藏全部对话标题' : '显示全部对话标题'} className="request-conversation-visibility" type="button" title={showConversationNames ? '隐藏全部对话标题' : '显示全部对话标题'} onClick={(event) => { event.stopPropagation(); setShowConversationNames((visible) => !visible) }}>{showConversationNames ? <Eye size={14} /> : <EyeOff size={14} />}</button></span>
                      : <span>{column.label}</span>}
                    <span
                      aria-label={`调整${column.label}列宽`}
                      aria-orientation="vertical"
                      aria-valuemax={640}
                      aria-valuemin={column.minimumWidth}
                      aria-valuenow={columnWidths[column.id]}
                      className="request-column-resizer"
                      data-column-resizer={column.id}
                      role="separator"
                      tabIndex={0}
                      title="拖动调整列宽；双击或按 Home 恢复默认"
                      onDoubleClick={(event) => { event.stopPropagation(); setColumnWidths((current) => ({ ...current, [column.id]: column.defaultWidth })) }}
                      onKeyDown={(event) => resizeColumnByKeyboard(event, column)}
                      onMouseDown={(event) => beginColumnResize(event, column)}
                    />
                  </th>
                ))}</tr></thead>
                <tbody>
                  {filtered.map((log) => (
                    <tr key={log.id} tabIndex={0} onClick={() => setSelected(log)} onKeyDown={(event) => event.key === 'Enter' && setSelected(log)}>
                      <td><div className="table-primary"><strong>{formatDateTime(log.timestamp).split(' ')[1]}</strong><span>{formatDateTime(log.timestamp).split(' ')[0]}</span></div></td>
                      <td><div className="cell-with-icon"><span className={`client-dot client-dot--${log.client}`} />{clientNames[log.client]}</div></td>
                      <td><div className={`table-primary request-conversation${showConversationNames ? '' : ' request-conversation--hidden'}`}>{showConversationNames && <strong title={log.conversationName}>{log.conversationName ?? '—'}</strong>}<span className="mono" title={log.conversationId}>{compactConversationId(log.conversationId)}</span></div></td>
                      <td><span className="mono table-model">{log.model}</span></td>
                      <td><div className="table-primary"><strong>{log.providerName}</strong><span>{log.accountName}</span></div></td>
                      <td><RequestStatusBadge status={log.status} />{log.statusCode && <span className="status-code">{log.statusCode}</span>}</td>
                      <td>{log.firstTokenMs !== undefined ? durationLabel(log.firstTokenMs) : '—'}</td>
                      <td>{durationLabel(log.latencyMs)}</td>
                      <td>{log.inputTokens !== undefined ? formatCompactNumber((log.inputTokens ?? 0) + (log.outputTokens ?? 0)) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="table-footer"><span>显示 {filtered.length} / {snapshot.requestLogs.length} 条记录</span><span>仅保存在本机</span></footer>
          </>
        ) : (
          <EmptyState icon={<Activity size={24} />} title={snapshot.requestLogs.length ? '没有匹配的请求' : '暂无请求日志'} description={snapshot.requestLogs.length ? '调整搜索词或筛选条件' : '网关收到请求后会在此显示记录'} action={snapshot.requestLogs.length ? <button className="button button--secondary" type="button" onClick={() => { setQuery(''); setClient('all'); setStatus('all') }}>重置筛选</button> : undefined} />
        )}
      </section>

      <Modal open={Boolean(selected)} title="请求详情" description={selected ? formatDateTime(selected.timestamp) : undefined} onClose={() => setSelected(null)} width="medium">
        {selected && (
          <div className="request-detail">
            <div className="request-detail__status"><RequestStatusBadge status={selected.status} /><span>{selected.statusCode ?? '—'}</span><strong>{durationLabel(selected.latencyMs)}</strong></div>
            <div className="request-detail__grid">
              <DetailItem label="请求 ID" mono>{selected.id}</DetailItem>
              <DetailItem label="客户端">{clientNames[selected.client]}</DetailItem>
              <DetailItem label="对话名称">{showConversationNames ? selected.conversationName ?? '—' : '已隐藏'}</DetailItem>
              <DetailItem label="对话 ID" mono>{selected.conversationId ?? '—'}</DetailItem>
              <DetailItem label="入站协议">{protocolLabels[selected.protocol]}</DetailItem>
              <DetailItem label="模型" mono>{selected.model}</DetailItem>
              <DetailItem label="供应商">{selected.providerName}</DetailItem>
              <DetailItem label="账号">{selected.accountName}</DetailItem>
              <DetailItem label="首字时间">{selected.firstTokenMs !== undefined ? durationLabel(selected.firstTokenMs) : '—'}</DetailItem>
              <DetailItem label="总耗时">{durationLabel(selected.latencyMs)}</DetailItem>
              <DetailItem label="输入 Token">{selected.inputTokens?.toLocaleString('zh-CN') ?? '—'}</DetailItem>
              <DetailItem label="输出 Token">{selected.outputTokens?.toLocaleString('zh-CN') ?? '—'}</DetailItem>
            </div>
            {selected.error && <div className="request-error"><TriangleAlert size={17} /><div><strong>上游错误</strong><p>{selected.error}</p></div></div>}
            <div className="privacy-note"><Badge tone="neutral">Payload 未记录</Badge><span>仅记录会话标识和客户端提供的名称，不包含请求与响应正文</span></div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={confirmClear} title="清空请求日志" message="确定清空全部本地请求记录吗？导出后也无法从 Stone 中恢复。" confirmLabel="清空日志" busy={busyKeys.has('clear-logs')} onCancel={() => setConfirmClear(false)} onConfirm={() => void clear()} />
    </div>
  )
}
