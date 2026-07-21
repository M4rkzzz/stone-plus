import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  Info,
  Network,
  Radio,
  Server,
  ShieldCheck,
  BellRing,
  Waypoints,
} from 'lucide-react'
import type {
  AppSnapshot,
  HealthEvent,
  OpenAiTokenCostBreakdown,
  RouteClient,
  TokenRatePoint,
  TokenRateSeries
} from '@shared/types'
import { resolveRouteSource } from '@shared/route-sources'
import type { PageId } from '../App'
import {
  AccountStatusBadge,
  Badge,
  durationLabel,
  formatCompactNumber,
  PageHeader,
  relativeTime,
  RequestStatusBadge,
} from '../ui'
import { translate, useI18n, type UiLanguage } from '../i18n'
import { accountDisplayName, setupPoolDisplayName } from '../system-generated-text'

const clientNames: Record<RouteClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

type TokenRateRange = keyof TokenRateSeries

const TOKEN_RATE_RANGE_STORAGE_KEY = 'stone:overview-token-rate-range:v1'
const EMPTY_TOKEN_RATE_POINTS: TokenRatePoint[] = []
const tokenRateRanges: Array<{ id: TokenRateRange; label: readonly [string, string] }> = [
  { id: 'last30Minutes', label: ['30 分钟', '30 min'] },
  { id: 'last4Hours', label: ['4 小时', '4 hours'] },
  { id: 'last24Hours', label: ['24 小时', '24 hours'] },
  { id: 'last7Days', label: ['一周', '1 week'] },
]

const TOKEN_COST_TOOLTIP_ZH = [
  '按 OpenAI 2026-07-19 标准 API 价格估算（每 100 万 Token）：',
  '每条请求均按自身日志中的 model 字符串匹配价格，不使用当前模型统一套价。',
  'gpt-5.6 / Sol：输入 $5、缓存读取 $0.5、输出 $30；',
  'Terra：$2.5 / $0.25 / $15；Luna：$1 / $0.1 / $6。',
  'gpt-5.5：$5 / $0.5 / $30；5.5 Pro：$30 / $30 / $180。',
  'gpt-5.4：$2.5 / $0.25 / $15；5.4 Pro：$30 / $30 / $180；',
  '5.4 Mini：$0.75 / $0.075 / $4.5；5.4 Nano：$0.20 / $0.02 / $1.25。',
  '非 Pro 型号的缓存读取价为普通输入价的 10%，即 90% 折扣。',
  '普通输入 = max(输入 - 缓存读取 - 缓存写入, 0)，避免重复计费。',
  '5.6 缓存写入若由上游单独上报则按输入价 1.25 倍计入输入成本；未单独上报时计入普通输入。',
  '5.4、5.4 Pro、5.5、5.5 Pro 单次输入超过 272K Token 时，整次输入价格 2 倍、输出价格 1.5 倍；恰好 272K 不加价。5.6 不套用该规则。',
  'Pro 没有缓存读取折扣，缓存读取按普通输入价格计算。',
  '未知模型会显示为未计价，不会套用猜测价格。'
].join(' ')

const TOKEN_COST_TOOLTIP_EN = [
  'Estimated using OpenAI standard API pricing as of 2026-07-19 (per 1 million Tokens):',
  'Each request is priced using the model string in its own log, rather than applying one current-model price to all requests.',
  'gpt-5.6 / Sol: $5 input, $0.5 cached input, $30 output;',
  'Terra: $2.5 / $0.25 / $15; Luna: $1 / $0.1 / $6.',
  'gpt-5.5: $5 / $0.5 / $30; 5.5 Pro: $30 / $30 / $180.',
  'gpt-5.4: $2.5 / $0.25 / $15; 5.4 Pro: $30 / $30 / $180;',
  '5.4 Mini: $0.75 / $0.075 / $4.5; 5.4 Nano: $0.20 / $0.02 / $1.25.',
  'Cached input for non-Pro models costs 10% of regular input, a 90% discount.',
  'Regular input = max(input - cached input - cache writes, 0), preventing duplicate charges.',
  'Separately reported 5.6 cache writes are priced at 1.25x input; otherwise they count as regular input.',
  'For 5.4, 5.4 Pro, 5.5, and 5.5 Pro requests above 272K input Tokens, all input costs 2x and output costs 1.5x. Exactly 272K is not surcharged. This rule does not apply to 5.6.',
  'Pro models do not receive a cached-input discount.',
  'Unknown models are shown as unpriced instead of using an estimated price.',
].join(' ')

function formatUsd(value: number): string {
  if (value >= 100) return `$${value.toFixed(2)}`
  if (value >= 1) return `$${value.toFixed(3)}`
  if (value >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

function TokenCostCard({
  title,
  cost
}: {
  title: string
  cost: OpenAiTokenCostBreakdown
}) {
  const { t, locale } = useI18n()
  const tooltip = t(TOKEN_COST_TOOLTIP_ZH, TOKEN_COST_TOOLTIP_EN)
  const hasUsage = cost.totalTokens > 0
  const unknownModelLabel = cost.unknownModels.length
    ? t(`未定价模型：${cost.unknownModels.join('、')}`, `Unpriced models: ${cost.unknownModels.join(', ')}`)
    : undefined
  return (
    <article className="panel token-cost-card">
      <header className="token-cost-card__header">
        <div className="token-cost-card__heading">
          <span className="token-cost-card__icon"><CircleDollarSign size={18} /></span>
          <div><h2>{title}</h2></div>
        </div>
        <span
          aria-label={tooltip}
          className="token-cost-help"
          data-tooltip={tooltip}
          role="img"
          tabIndex={0}
          title={tooltip}
        ><Info size={16} /></span>
      </header>
      <div className="token-cost-card__total">
        <div><span>{t('Token 总量', 'Total Tokens')}</span><strong>{formatCompactNumber(cost.totalTokens, locale)}</strong></div>
        <div className="token-cost-card__usd">
          <strong>{formatUsd(cost.totalCostUsd)}</strong>
        </div>
      </div>
      <div className="token-cost-breakdown" aria-label={t(`${title}成本分项`, `${title} cost breakdown`)}>
        <div className="token-cost-breakdown__item token-cost-breakdown__item--input">
          <span><i />{t('输入成本', 'Input cost')}</span><strong>{formatUsd(cost.inputCostUsd)}</strong>
        </div>
        <div className="token-cost-breakdown__item token-cost-breakdown__item--cached">
          <span><i />{t('缓存输入成本', 'Cached input cost')}</span><strong>{formatUsd(cost.cachedInputCostUsd)}</strong>
        </div>
        <div className="token-cost-breakdown__item token-cost-breakdown__item--output">
          <span><i />{t('输出成本', 'Output cost')}</span><strong>{formatUsd(cost.outputCostUsd)}</strong>
        </div>
      </div>
      {(!hasUsage || cost.unpricedTokens > 0 || cost.cacheWriteInputTokens > 0 || cost.longContextRequestCount > 0) && <footer className="token-cost-card__footer">
        {!hasUsage && <span>{t('暂无包含 Token usage 的请求记录', 'No request logs contain Token usage')}</span>}
        {cost.unpricedTokens > 0 && (
          <span className="token-cost-unpriced" title={unknownModelLabel}>
            {t(`${formatCompactNumber(cost.unpricedTokens, locale)} Token 因模型价格未知未计价`, `${formatCompactNumber(cost.unpricedTokens, locale)} Tokens are unpriced because the model price is unknown`)}
          </span>
        )}
        {cost.cacheWriteInputTokens > 0 && <span>{t(`其中 ${formatCompactNumber(cost.cacheWriteInputTokens, locale)} 缓存写入 Token 已按对应模型规则计价`, `${formatCompactNumber(cost.cacheWriteInputTokens, locale)} cache-write Tokens were priced using their model rules`)}</span>}
        {cost.longContextRequestCount > 0 && <span>{t(`${cost.longContextRequestCount} 次长上下文请求已应用附加价格`, `Long-context surcharges were applied to ${cost.longContextRequestCount} request(s)`)}</span>}
      </footer>}
    </article>
  )
}

function initialTokenRateRange(): TokenRateRange {
  try {
    const stored = window.localStorage.getItem(TOKEN_RATE_RANGE_STORAGE_KEY) as TokenRateRange | null
    if (tokenRateRanges.some((range) => range.id === stored)) return stored!
  } catch {
    // Renderer storage is optional; use the default range when unavailable.
  }
  return 'last30Minutes'
}

function niceRateMaximum(value: number): number {
  if (value <= 0) return 10
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function formatTokenRate(value: number, locale: string): string {
  if (value >= 1000) return `${formatCompactNumber(value, locale)}/s`
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}/s`
}

function tokenRateTimeLabel(timestamp: number, range: TokenRateRange, locale: string): string {
  const date = new Date(timestamp)
  if (range === 'last7Days') return `${date.getMonth() + 1}/${date.getDate()}`
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
}

function linePath(points: Array<{ x: number; y: number; active: boolean }>): string {
  return points
    .filter((point) => point.active)
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
}

function TokenRateChart({ points, range }: { points: TokenRatePoint[]; range: TokenRateRange }) {
  const { t, locale } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const height = 220
  const plot = { left: 58, right: width - 12, top: 12, bottom: 178 }
  const maximum = niceRateMaximum(Math.max(0, ...points.map((point) => point.tokensPerSecond)))
  const coordinates = points.map((point, index) => ({
    x: plot.left + (points.length <= 1 ? 0 : index / (points.length - 1)) * (plot.right - plot.left),
    y: plot.bottom - point.tokensPerSecond / maximum * (plot.bottom - plot.top),
    active: point.requestCount > 0,
    point,
  }))
  const path = linePath(coordinates)
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  const activePoints = points.filter((point) => point.requestCount > 0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateWidth = () => setWidth(Math.max(280, Math.round(container.clientWidth)))
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="token-rate-chart" ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('Token 输出速率折线图', 'Token output rate line chart')}>
        {ticks.map((ratio) => {
          const y = plot.bottom - ratio * (plot.bottom - plot.top)
          return (
            <g key={ratio}>
              <line className="token-rate-chart__grid" x1={plot.left} x2={plot.right} y1={y} y2={y} />
              <text className="token-rate-chart__y-label" x={plot.left - 10} y={y + 3}>{maximum < 10 ? (maximum * ratio).toFixed(1) : Math.round(maximum * ratio)}</text>
            </g>
          )
        })}
        {path && <path className="token-rate-chart__line" d={path} />}
        {coordinates.filter((point) => point.active).map(({ x, y, point }) => (
          <circle className="token-rate-chart__point" cx={x} cy={y} key={point.timestamp} r="3.5">
            <title>{t(
              `${tokenRateTimeLabel(point.timestamp, range, locale)} · ${formatTokenRate(point.tokensPerSecond, locale)} · ${point.requestCount} 个请求 · ${point.outputTokens} 输出 Token`,
              `${tokenRateTimeLabel(point.timestamp, range, locale)} · ${formatTokenRate(point.tokensPerSecond, locale)} · ${point.requestCount} request(s) · ${point.outputTokens} output Tokens`,
            )}</title>
          </circle>
        ))}
        {points.length > 0 && (
          <>
            <text className="token-rate-chart__x-label" x={plot.left} y={207}>{tokenRateTimeLabel(points[0].timestamp, range, locale)}</text>
            <text className="token-rate-chart__x-label token-rate-chart__x-label--middle" x={(plot.left + plot.right) / 2} y={207}>{tokenRateTimeLabel(points[Math.floor((points.length - 1) / 2)].timestamp, range, locale)}</text>
            <text className="token-rate-chart__x-label token-rate-chart__x-label--end" x={plot.right} y={207}>{t('现在', 'Now')}</text>
          </>
        )}
      </svg>
      {!activePoints.length && <div className="token-rate-chart__empty">{t('所选时段暂无可计算的输出数据', 'No calculable output data for the selected period')}</div>}
    </div>
  )
}

function uptimeLabel(startedAt: number | undefined, language: UiLanguage) {
  if (!startedAt) return '—'
  const minutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60000))
  if (minutes < 60) return translate(language, `${minutes} 分钟`, `${minutes} min`)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return translate(language, `${hours} 小时 ${remainder} 分钟`, `${hours}h ${remainder}m`)
}

function requestActivity(logs: AppSnapshot['requestLogs']): number[] {
  const buckets = Array.from({ length: 12 }, () => 0)
  const now = Date.now()
  for (const log of logs) {
    const age = now - log.timestamp
    if (age < 0 || age >= 60 * 60 * 1000) continue
    const newestFirst = Math.floor(age / (5 * 60 * 1000))
    buckets[11 - newestFirst] += 1
  }
  const maximum = Math.max(...buckets)
  return maximum === 0 ? buckets : buckets.map((count) => count === 0 ? 0 : Math.max(10, Math.round((count / maximum) * 100)))
}

function healthEventMessage(event: HealthEvent, language: UiLanguage): string {
  if (language === 'zh-CN' || !/[\u3400-\u9fff]/u.test(event.message)) return event.message
  if (event.kind === 'quota-exhausted') return 'Quota exhausted; Stone+ paused scheduling for this account.'
  if (event.kind === 'quota-restored') return 'The quota window has recovered and the account can be scheduled again.'
  if (event.kind === 'account-recovered') return 'The account has returned to a healthy state.'
  if (event.kind === 'account-disabled' && event.message === '账号已被上游拒绝并停用。') return 'The upstream rejected and disabled this account.'
  if (event.kind === 'account-cooldown' && event.message === '账号连续失败，已进入冷却。') return 'The account entered cooldown after consecutive failures.'
  if (/过期/.test(event.message)) return 'The account access token has expired.'
  return event.kind === 'account-disabled' ? 'The account was disabled.' : 'The account entered cooldown.'
}

export function OverviewView({ snapshot, navigate }: { snapshot: AppSnapshot; navigate: (page: PageId) => void }) {
  const { t, language, locale } = useI18n()
  const [tokenRateRange, setTokenRateRange] = useState<TokenRateRange>(initialTokenRateRange)
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled)
  const availableAccounts = snapshot.accounts.filter((account) => account.status === 'active')
  const recentLogs = snapshot.requestLogs.slice(0, 6)
  const totalTokens = snapshot.requestLogs.reduce((total, log) => total + (log.inputTokens ?? 0) + (log.outputTokens ?? 0), 0)
  const chartBars = requestActivity(snapshot.requestLogs)
  const daily = snapshot.observability.last24Hours
  const tokenCosts = snapshot.observability.tokenCosts
  const tokenRatePoints = snapshot.observability.tokenRates?.[tokenRateRange] ?? EMPTY_TOKEN_RATE_POINTS
  const tokenRateStats = useMemo(() => {
    const selected = tokenRatePoints.filter((point) => point.requestCount > 0)
    const requestCount = selected.reduce((total, point) => total + point.requestCount, 0)
    const weightedTotal = selected.reduce((total, point) => total + point.tokensPerSecond * point.requestCount, 0)
    return {
      average: requestCount ? weightedTotal / requestCount : 0,
      peak: Math.max(0, ...selected.map((point) => point.tokensPerSecond)),
      requestCount,
    }
  }, [tokenRatePoints])

  useEffect(() => {
    try {
      window.localStorage.setItem(TOKEN_RATE_RANGE_STORAGE_KEY, tokenRateRange)
    } catch {
      // Keep the in-memory selection when renderer storage is unavailable.
    }
  }, [tokenRateRange])

  return (
    <div className="page-stack">
      <PageHeader title={t('总览', 'Overview')} />

      <section className="metrics-grid" aria-label={t('网关指标', 'Gateway metrics')}>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--green"><Activity size={19} /></div>
          <div className="metric-card__label">{t('24 小时请求', '24-hour Requests')}</div>
          <strong>{formatCompactNumber(daily.requestCount, locale)}</strong>
          <span>{t(`${snapshot.gatewayStatus.activeRequests} 个正在处理`, `${snapshot.gatewayStatus.activeRequests} in progress`)}</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--blue"><CheckCircle2 size={19} /></div>
          <div className="metric-card__label">{t('24 小时成功率', '24-hour Success Rate')}</div>
          <strong>{(daily.successRate * 100).toFixed(1)}%</strong>
          <span>{t(`${formatCompactNumber(daily.successCount, locale)} 个成功请求`, `${formatCompactNumber(daily.successCount, locale)} successful request(s)`)}</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--amber"><Network size={19} /></div>
          <div className="metric-card__label">{t('可用账号', 'Available Accounts')}</div>
          <strong>{availableAccounts.length}<small> / {snapshot.accounts.length}</small></strong>
          <span>{t(`${snapshot.pools.length} 个号池参与调度`, `${snapshot.pools.length} pool(s) in scheduling`)}</span>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--violet"><Clock3 size={19} /></div>
          <div className="metric-card__label">{t('24 小时平均延迟', '24-hour Average Latency')}</div>
          <strong className="metric-card__uptime">{daily.averageLatencyMs ? durationLabel(daily.averageLatencyMs) : '—'}</strong>
          <span>{t(`${daily.failoverCount} 次账号切换 · 运行 ${uptimeLabel(snapshot.gatewayStatus.startedAt, language)}`, `${daily.failoverCount} account switch(es) · Up ${uptimeLabel(snapshot.gatewayStatus.startedAt, language)}`)}</span>
        </article>
      </section>

      <section className="token-cost-grid" aria-label={t('Token 消耗与成本', 'Token usage and cost')}>
        <TokenCostCard
          title={t('今日 Token', "Today's Tokens")}
          cost={tokenCosts.today}
        />
        <TokenCostCard
          title={t('总 Token', 'All-time Tokens')}
          cost={tokenCosts.allTime}
        />
      </section>

      <div className="overview-grid">
        <section className="panel traffic-panel">
          <header className="panel__header">
            <div>
              <h2>{t('请求活动', 'Request Activity')}</h2>
              <p>{t('最近 60 分钟', 'Last 60 minutes')}</p>
            </div>
            <div className="traffic-total">
              <span>{t('日志内 Token', 'Logged Tokens')}</span>
              <strong>{formatCompactNumber(totalTokens, locale)}</strong>
            </div>
          </header>
          <div className="traffic-chart" aria-label={t('最近 60 分钟请求趋势', 'Request trend over the last 60 minutes')}>
            {chartBars.map((height, index) => (
              <div className="traffic-chart__column" key={index}>
                <span style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
          <div className="traffic-chart__axis"><span>{t('60 分钟前', '60 min ago')}</span><span>{t('现在', 'Now')}</span></div>
        </section>

        <section className="panel route-summary">
          <header className="panel__header">
            <div>
              <h2>{t('客户端路由', 'Client Routes')}</h2>
              <p>{t(`${enabledRoutes.length} / ${snapshot.routes.length} 条已启用`, `${enabledRoutes.length} / ${snapshot.routes.length} enabled`)}</p>
            </div>
            <button className="text-button" type="button" onClick={() => navigate('routes')}>{t('管理路由', 'Manage Routes')} <ArrowRight size={15} /></button>
          </header>
          <div className="route-summary__list">
            {snapshot.routes.map((route) => {
              const source = resolveRouteSource(route.poolId, snapshot)
              return (
                <div className="route-summary__row" key={route.id}>
                  <div className={`client-glyph client-glyph--${route.client}`}>{route.client.slice(0, 1).toUpperCase()}</div>
                  <div className="route-summary__name">
                    <strong>{clientNames[route.client]}</strong>
                    <span>{source ? setupPoolDisplayName(source.summary.name, t) : t('未选择源', 'No source selected')}</span>
                  </div>
                  <Badge tone={route.enabled ? 'success' : 'neutral'}>{route.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</Badge>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <section className="panel observability-panel">
        <header className="panel__header"><div><h2>{t('24 小时运行趋势', '24-hour Runtime Trend')}</h2></div><Badge tone="neutral">{formatCompactNumber(daily.inputTokens + daily.outputTokens, locale)} Tokens</Badge></header>
        <div className="observability-chart" aria-label={t('24 小时运行趋势', '24-hour runtime trend')}>
          {snapshot.observability.hourly.map((point) => {
            const maximum = Math.max(1, ...snapshot.observability.hourly.map((item) => item.requestCount))
            const height = Math.max(point.requestCount ? 8 : 0, point.requestCount / maximum * 100)
            const errorHeight = point.requestCount ? point.errorCount / point.requestCount * height : 0
            return <div className="observability-chart__bar" key={point.timestamp} title={t(`${new Date(point.timestamp).getHours()}:00 · ${point.requestCount} 请求 · ${point.averageLatencyMs}ms`, `${new Date(point.timestamp).getHours()}:00 · ${point.requestCount} request(s) · ${point.averageLatencyMs}ms`)}><span style={{ height: `${height}%` }}><i style={{ height: `${errorHeight}%` }} /></span></div>
          })}
        </div>
        <div className="observability-legend"><span><i className="legend-success" />{t('请求', 'Requests')}</span><span><i className="legend-error" />{t('错误', 'Errors')}</span><span>{t(`7 天：${snapshot.observability.last7Days.requestCount} 请求 · ${(snapshot.observability.last7Days.successRate * 100).toFixed(1)}% 成功`, `7 days: ${snapshot.observability.last7Days.requestCount} request(s) · ${(snapshot.observability.last7Days.successRate * 100).toFixed(1)}% success`)}</span></div>
      </section>

      <section className="panel token-rate-panel">
        <header className="panel__header token-rate-panel__header">
          <div>
            <h2>{t('Token 输出速率', 'Token Output Rate')}</h2>
          </div>
          <div className="segmented-control token-rate-range" aria-label={t('Token 输出速率时间范围', 'Token output rate time range')}>
            {tokenRateRanges.map((range) => (
              <button
                aria-pressed={tokenRateRange === range.id}
                className={tokenRateRange === range.id ? 'active' : undefined}
                key={range.id}
                type="button"
                onClick={() => setTokenRateRange(range.id)}
              >{t(range.label[0], range.label[1])}</button>
            ))}
          </div>
        </header>
        <div className="token-rate-summary">
          <div><span>{t('平均速度', 'Average Rate')}</span><strong>{tokenRateStats.requestCount ? formatTokenRate(tokenRateStats.average, locale) : '—'}</strong></div>
          <div><span>{t('峰值', 'Peak')}</span><strong>{tokenRateStats.requestCount ? formatTokenRate(tokenRateStats.peak, locale) : '—'}</strong></div>
          <div><span>{t('有效请求', 'Valid Requests')}</span><strong>{tokenRateStats.requestCount}</strong></div>
        </div>
        <TokenRateChart points={tokenRatePoints} range={tokenRateRange} />
      </section>

      <section className="panel health-events-panel">
        <header className="panel__header"><div><h2>{t('健康事件', 'Health Events')}</h2></div><BellRing size={18} /></header>
        {snapshot.healthEvents.length ? <div className="health-event-list">{snapshot.healthEvents.slice(0, 8).map((event) => <div key={event.id} className={`health-event health-event--${event.severity}`}><span className="status-dot" /><div><strong>{event.accountName} · {event.providerName}</strong><span>{healthEventMessage(event, language)}</span></div><small>{relativeTime(event.timestamp, locale)}</small></div>)}</div> : <div className="empty-inline"><ShieldCheck size={18} /><span>{t('暂无健康告警，所有账号运行正常', 'No health alerts; all accounts are operating normally')}</span></div>}
      </section>

      <section className="panel account-health">
        <header className="panel__header">
          <div>
            <h2>{t('账号健康', 'Account Health')}</h2>
          </div>
          <button className="text-button" type="button" onClick={() => navigate('providers')}>{t('查看全部', 'View All')} <ArrowRight size={15} /></button>
        </header>
        {snapshot.accounts.length ? <div className="health-strip">
          {snapshot.accounts.slice(0, 5).map((account) => {
            const provider = snapshot.providers.find((item) => item.id === account.providerId)
            const usage = Math.min(100, (account.inFlight / account.maxConcurrency) * 100)
            return (
              <div className="health-strip__item" key={account.id}>
                <div className="health-strip__top">
                  <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>
                    {provider?.name.slice(0, 1) ?? '?'}
                  </span>
                  <div><strong>{account.name}</strong><span>{provider?.name}</span></div>
                  <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                </div>
                <div className="usage-line"><span style={{ width: `${usage}%` }} /></div>
                <div className="health-strip__meta">
                  <span>{t(`${account.inFlight} / ${account.maxConcurrency} 并发`, `${account.inFlight} / ${account.maxConcurrency} concurrent`)}</span>
                  <span>{account.latencyMs ? durationLabel(account.latencyMs) : t('未检测', 'Not tested')}</span>
                </div>
              </div>
            )
          })}
        </div> : <div className="empty-inline"><Server size={17} /><span>{t('尚未添加上游账号', 'No upstream accounts added')}</span></div>}
      </section>

      <section className="panel recent-requests">
        <header className="panel__header">
          <div>
            <h2>{t('最近请求', 'Recent Requests')}</h2>
          </div>
          <button className="text-button" type="button" onClick={() => navigate('requests')}>{t('查看请求日志', 'View Request Logs')} <ArrowRight size={15} /></button>
        </header>
        {recentLogs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('客户端', 'Client')}</th><th>{t('模型', 'Model')}</th><th>{t('上游', 'Upstream')}</th><th>{t('状态', 'Status')}</th><th>{t('延迟', 'Latency')}</th><th>{t('时间', 'Time')}</th></tr></thead>
              <tbody>
                {recentLogs.map((log) => (
                  <tr key={log.id}>
                    <td><div className="cell-with-icon"><span className={`client-dot client-dot--${log.client}`} /><span>{clientNames[log.client]}</span></div></td>
                    <td><span className="mono table-model">{log.model}</span></td>
                    <td><div className="table-primary"><strong>{log.providerName}</strong><span>{accountDisplayName(log.accountName, t)}</span></div></td>
                    <td><RequestStatusBadge status={log.status} statusCode={log.statusCode} requestKind={log.requestKind} /></td>
                    <td>{durationLabel(log.latencyMs)}</td>
                    <td>{relativeTime(log.timestamp, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline"><Radio size={18} /><span>{t('暂无请求记录', 'No request records')}</span></div>
        )}
      </section>

      <section className="quick-links" aria-label={t('快捷入口', 'Quick links')}>
        <button type="button" onClick={() => navigate('providers')}><Server size={17} /><span>{t('添加上游账号', 'Add Upstream Account')}</span><ArrowRight size={15} /></button>
        <button type="button" onClick={() => navigate('pools')}><Waypoints size={17} /><span>{t('调整调度策略', 'Adjust Scheduling')}</span><ArrowRight size={15} /></button>
        <button type="button" onClick={() => navigate('settings')}><ShieldCheck size={17} /><span>{t('网关与安全设置', 'Gateway & Security Settings')}</span><ArrowRight size={15} /></button>
      </section>
    </div>
  )
}
