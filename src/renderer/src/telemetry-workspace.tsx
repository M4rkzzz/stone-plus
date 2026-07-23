import { useMemo, useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircleOff,
  FilterX,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldX,
  SquareX,
  Waypoints,
} from 'lucide-react'
import type { ProxyConnectionSummary, ProxyTrafficSnapshot } from '@shared/types'
import { useI18n } from './i18n'
import './telemetry-workspace.css'

export type TelemetryWorkspaceState = 'ready' | 'waiting' | 'fail-closed'

export interface TelemetryConnectionFilters {
  query: string
  target: string
  network: 'all' | ProxyConnectionSummary['network']
  outbound: string
}

export interface TelemetryWorkspaceProps {
  traffic: ProxyTrafficSnapshot | null
  connections: readonly ProxyConnectionSummary[]
  state: TelemetryWorkspaceState
  refreshing?: boolean
  closingConnectionIds?: ReadonlySet<string>
  actionsDisabled?: boolean
  onRefresh: () => void
  onCloseConnection: (connectionId: string) => void
}

const EMPTY_FILTERS: TelemetryConnectionFilters = {
  query: '',
  target: 'all',
  network: 'all',
  outbound: 'all',
}

export function TelemetryWorkspace({
  traffic,
  connections,
  state,
  refreshing = false,
  closingConnectionIds = new Set<string>(),
  actionsDisabled = false,
  onRefresh,
  onCloseConnection,
}: TelemetryWorkspaceProps) {
  const { t, locale } = useI18n()
  const [filters, setFilters] = useState<TelemetryConnectionFilters>(EMPTY_FILTERS)
  const ready = state === 'ready'
  const currentTraffic = ready ? traffic : null
  const currentConnections = useMemo<readonly ProxyConnectionSummary[]>(
    () => ready ? connections : [],
    [connections, ready],
  )
  const options = useMemo(
    () => proxyConnectionFilterOptions(currentConnections),
    [currentConnections],
  )
  const filteredConnections = useMemo(
    () => filterProxyConnections(currentConnections, filters),
    [currentConnections, filters],
  )
  const hasFilters = !sameTelemetryFilters(filters, EMPTY_FILTERS)
  const disabled = actionsDisabled || !ready

  return <section
    className={`telemetry-workspace telemetry-workspace--${state}`}
    aria-labelledby="telemetry-workspace-title"
  >
    <header className="telemetry-workspace__header">
      <div className="telemetry-workspace__title">
        <span className="telemetry-workspace__title-icon"><Activity size={19} /></span>
        <span>
          <strong id="telemetry-workspace-title">{t('连接与流量工作台', 'Connections & traffic')}</strong>
          <small>{ready
            ? t('实时查看 mixed 出口，并可精确断开单个连接', 'Inspect the mixed exit live and close individual connections')
            : state === 'fail-closed'
              ? t('出口已阻断；旧快照不会作为当前状态展示', 'The exit is blocked; stale snapshots are not shown as current')
              : t('内置代理就绪后开始采集', 'Collection starts after the built-in proxy is ready')}</small>
        </span>
      </div>
      <button
        type="button"
        className="telemetry-workspace__refresh"
        disabled={disabled || refreshing}
        aria-busy={refreshing || undefined}
        onClick={onRefresh}
      >
        {refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        {t('刷新', 'Refresh')}
      </button>
    </header>

    {state !== 'ready' && <TelemetryUnavailable state={state} />}

    <div className="telemetry-workspace__metrics" aria-label={t('实时流量概览', 'Live traffic overview')}>
      <TelemetryMetric
        direction="download"
        icon={<ArrowDown size={18} />}
        label={t('下行速率', 'Download')}
        value={currentTraffic ? `${formatTelemetryBytes(currentTraffic.downloadRateBytesPerSecond)}/s` : '—'}
        detail={currentTraffic ? t(`累计 ${formatTelemetryBytes(currentTraffic.downloadBytes)}`, `${formatTelemetryBytes(currentTraffic.downloadBytes)} total`) : t('等待有效快照', 'Waiting for a valid snapshot')}
      />
      <TelemetryMetric
        direction="upload"
        icon={<ArrowUp size={18} />}
        label={t('上行速率', 'Upload')}
        value={currentTraffic ? `${formatTelemetryBytes(currentTraffic.uploadRateBytesPerSecond)}/s` : '—'}
        detail={currentTraffic ? t(`累计 ${formatTelemetryBytes(currentTraffic.uploadBytes)}`, `${formatTelemetryBytes(currentTraffic.uploadBytes)} total`) : t('等待有效快照', 'Waiting for a valid snapshot')}
      />
      <TelemetryMetric
        icon={<Waypoints size={18} />}
        label={t('活动连接', 'Active connections')}
        value={currentTraffic ? formatTelemetryCount(currentTraffic.activeConnections, locale) : '—'}
        detail={currentTraffic ? t(`累计建立 ${formatTelemetryCount(currentTraffic.totalConnections, locale)}`, `${formatTelemetryCount(currentTraffic.totalConnections, locale)} opened in total`) : t('当前未采集', 'Not collecting')}
      />
    </div>

    <div className="telemetry-workspace__toolbar" aria-label={t('连接筛选', 'Connection filters')}>
      <label className="telemetry-workspace__search">
        <Search size={15} />
        <span className="sr-only">{t('搜索连接', 'Search connections')}</span>
        <input
          type="search"
          value={filters.query}
          disabled={!ready}
          placeholder={t('搜索目标、来源、协议或规则', 'Search target, source, protocol, or rule')}
          onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
        />
      </label>
      <TelemetrySelect
        label={t('目标', 'Target')}
        value={filters.target}
        disabled={!ready}
        onChange={(target) => setFilters((current) => ({ ...current, target }))}
        options={[
          { value: 'all', label: t('全部目标', 'All targets') },
          ...options.targets.map((target) => ({ value: target, label: target })),
        ]}
      />
      <TelemetrySelect
        label={t('网络', 'Network')}
        value={filters.network}
        disabled={!ready}
        onChange={(network) => setFilters((current) => ({
          ...current,
          network: network as TelemetryConnectionFilters['network'],
        }))}
        options={[
          { value: 'all', label: t('全部网络', 'All networks') },
          { value: 'tcp', label: 'TCP' },
          { value: 'udp', label: 'UDP' },
        ]}
      />
      <TelemetrySelect
        label={t('规则 / 出口', 'Rule / outbound')}
        value={filters.outbound}
        disabled={!ready}
        onChange={(outbound) => setFilters((current) => ({ ...current, outbound }))}
        options={[
          { value: 'all', label: t('全部规则', 'All rules') },
          ...options.outbounds.map((outbound) => ({ value: outbound, label: outbound })),
        ]}
      />
      {hasFilters && <button
        type="button"
        className="telemetry-workspace__clear"
        disabled={!ready}
        onClick={() => setFilters(EMPTY_FILTERS)}
      >
        <FilterX size={14} />{t('清除', 'Clear')}
      </button>}
    </div>

    <div className="telemetry-workspace__result-bar">
      <span className="telemetry-workspace__result-count" aria-live="polite" aria-atomic="true">{t(
        `显示 ${filteredConnections.length} / ${currentConnections.length} 个连接`,
        `Showing ${filteredConnections.length} of ${currentConnections.length} connections`,
      )}</span>
      {currentTraffic && <time dateTime={new Date(currentTraffic.capturedAt).toISOString()}>{t(
        `快照 ${formatTelemetryTimestamp(currentTraffic.capturedAt, locale)}`,
        `Snapshot ${formatTelemetryTimestamp(currentTraffic.capturedAt, locale)}`,
      )}</time>}
    </div>

    <div className="telemetry-workspace__table-wrap">
      <table className="telemetry-workspace__table">
        <thead><tr>
          <th>{t('目标与来源', 'Target & source')}</th>
          <th>{t('网络', 'Network')}</th>
          <th>{t('规则 / 出口', 'Rule / outbound')}</th>
          <th>{t('连接流量', 'Traffic')}</th>
          <th>{t('已连接', 'Connected')}</th>
          <th><span className="sr-only">{t('操作', 'Actions')}</span></th>
        </tr></thead>
        <tbody>{filteredConnections.map((connection) => {
          const closing = closingConnectionIds.has(connection.id)
          return <tr key={connection.id}>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--endpoint"><div className="telemetry-workspace__endpoint">
              <strong title={connection.destination}>{connection.destination}</strong>
              <small title={connection.source}>{connection.source}</small>
            </div></td>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--network"><span className={`telemetry-workspace__network telemetry-workspace__network--${connection.network}`}>
              {connection.network.toUpperCase()}{connection.protocol ? ` · ${connection.protocol}` : ''}
            </span></td>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--outbound"><span className="telemetry-workspace__outbound" title={connection.outbound}>{connection.outbound}</span></td>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--traffic"><span className="telemetry-workspace__bytes">
              <span title={t('下载', 'Download')}><ArrowDown size={12} />{formatTelemetryBytes(connection.downloadBytes)}</span>
              <span title={t('上传', 'Upload')}><ArrowUp size={12} />{formatTelemetryBytes(connection.uploadBytes)}</span>
            </span></td>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--age"><span className="telemetry-workspace__age" title={formatTelemetryTimestamp(connection.startedAt, locale)}>{formatConnectionAge(connection.startedAt, Date.now(), t)}</span></td>
            <td className="telemetry-workspace__cell telemetry-workspace__cell--action"><button
              type="button"
              className="telemetry-workspace__close"
              disabled={actionsDisabled || closing || !ready}
              aria-busy={closing || undefined}
              title={t(`断开 ${connection.destination}`, `Close ${connection.destination}`)}
              onClick={() => onCloseConnection(connection.id)}
            >
              {closing ? <LoaderCircle size={15} className="spin" /> : <SquareX size={15} />}
              <span>{t('断开', 'Close')}</span>
            </button></td>
          </tr>
        })}</tbody>
      </table>
      {ready && filteredConnections.length === 0 && <TelemetryEmpty
        filtered={hasFilters}
        onClear={() => setFilters(EMPTY_FILTERS)}
      />}
      {!ready && <div className="telemetry-workspace__table-mask" aria-hidden="true" />}
    </div>
  </section>
}

function TelemetryUnavailable({ state }: { state: Exclude<TelemetryWorkspaceState, 'ready'> }) {
  const { t } = useI18n()
  const blocked = state === 'fail-closed'
  return <div className={`telemetry-workspace__unavailable ${blocked ? 'is-blocked' : ''}`} role="status">
    {blocked ? <ShieldX size={20} /> : <CircleOff size={20} />}
    <span><strong>{blocked ? t('连接已安全阻断', 'Connections are safely blocked') : t('等待代理就绪', 'Waiting for proxy readiness')}</strong>
      <small>{blocked
        ? t('新请求不会回退直连；修复核心或接入方式后再刷新。', 'New requests will not fall back to direct; repair the core or access mode, then refresh.')
        : t('准备完成前不展示计划端口或历史连接，避免误判。', 'Planned ports and historical connections stay hidden until readiness is confirmed.')}</small>
    </span>
  </div>
}

function TelemetryMetric({ icon, label, value, detail, direction }: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
  direction?: 'download' | 'upload'
}) {
  return <div className={`telemetry-workspace__metric ${direction ? `is-${direction}` : ''}`}>
    <span className="telemetry-workspace__metric-icon">{icon}</span>
    <span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span>
  </div>
}

function TelemetrySelect({ label, value, options, disabled, onChange }: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled: boolean
  onChange: (value: string) => void
}) {
  return <label className="telemetry-workspace__select">
    <span>{label}</span>
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>
}

function TelemetryEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const { t } = useI18n()
  return <div className="telemetry-workspace__empty">
    {filtered ? <Search size={22} /> : <Waypoints size={22} />}
    <strong>{filtered ? t('没有匹配的连接', 'No matching connections') : t('当前没有活动连接', 'No active connections')}</strong>
    <small>{filtered
      ? t('调整筛选条件，或清除筛选查看全部连接。', 'Adjust the filters or clear them to show every connection.')
      : t('连接出现后会自动显示在这里。', 'Connections will appear here automatically.')}</small>
    {filtered && <button type="button" onClick={onClear}><FilterX size={14} />{t('清除筛选', 'Clear filters')}</button>}
  </div>
}

export function filterProxyConnections(
  connections: readonly ProxyConnectionSummary[],
  filters: TelemetryConnectionFilters,
): ProxyConnectionSummary[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return connections.filter((connection) => {
    if (filters.target !== 'all' && connection.destination !== filters.target) return false
    if (filters.network !== 'all' && connection.network !== filters.network) return false
    if (filters.outbound !== 'all' && connection.outbound !== filters.outbound) return false
    if (!query) return true
    return [
      connection.destination,
      connection.source,
      connection.outbound,
      connection.network,
      connection.protocol ?? '',
    ].some((value) => value.toLocaleLowerCase().includes(query))
  }).sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id))
}

export function proxyConnectionFilterOptions(connections: readonly ProxyConnectionSummary[]): {
  targets: string[]
  outbounds: string[]
} {
  return {
    targets: uniqueSorted(connections.map((connection) => connection.destination)),
    outbounds: uniqueSorted(connections.map((connection) => connection.outbound)),
  }
}

export function formatTelemetryBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** exponent
  const digits = scaled >= 100 || exponent === 0 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${units[exponent]}`
}

function formatTelemetryCount(value: number, locale: string): string {
  return Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0).toLocaleString(locale)
}

function formatTelemetryTimestamp(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatConnectionAge(
  startedAt: number,
  now: number,
  t: <T>(chinese: T, english: T) => T,
): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (elapsedSeconds < 60) return t(`${elapsedSeconds} 秒`, `${elapsedSeconds}s`)
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return t(`${elapsedMinutes} 分钟`, `${elapsedMinutes}m`)
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  return t(`${elapsedHours} 小时`, `${elapsedHours}h`)
}

function sameTelemetryFilters(left: TelemetryConnectionFilters, right: TelemetryConnectionFilters): boolean {
  return left.query === right.query
    && left.target === right.target
    && left.network === right.network
    && left.outbound === right.outbound
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}
