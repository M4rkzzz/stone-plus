import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, LoaderCircle, RefreshCw } from 'lucide-react'
import { CODEX_QUOTA_HISTORY_RETENTION_MS } from '@shared/types'
import type { AppSnapshot, CodexQuotaCycleCosts, CodexQuotaHistoryPoint, CodexQuotaWindow, GatewayApi } from '@shared/types'
import type { ActionRunner } from '../App'
import { formatAccountQuotaUsd } from '../account-quota'
import { localizeBackendError } from '../backend-message'
import { codexLongQuotaPeriodLabel } from '../codex-quota-period'
import { useI18n } from '../i18n'
import { Badge, Modal } from '../ui'

type PublicAccount = AppSnapshot['accounts'][number]

export function CodexQuotaModal({
  account,
  api,
  runAction,
  busyKeys,
  onClose,
}: {
  account: PublicAccount | null
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
  onClose: () => void
}) {
  const { t, language, locale } = useI18n()
  const [history, setHistory] = useState<CodexQuotaHistoryPoint[]>([])
  const [cycleCosts, setCycleCosts] = useState<CodexQuotaCycleCosts>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const autoRefreshAttempt = useRef<string | undefined>(undefined)

  const loadHistory = useCallback(async (accountId: string) => {
    setLoading(true)
    setError('')
    try {
      const end = Date.now()
      const [points, costs] = await Promise.all([
        api.getAccountCodexQuotaHistory(accountId, end - CODEX_QUOTA_HISTORY_RETENTION_MS, end),
        api.getAccountCodexQuotaCycleCosts(accountId),
      ])
      setHistory(points)
      setCycleCosts(costs)
    } catch (cause) {
      setCycleCosts({})
      setError(localizeBackendError(cause, language, t('额度历史读取失败', 'Failed to load quota history.')))
    } finally {
      setLoading(false)
    }
  }, [api, language, t])

  const accountId = account?.id
  const quotaObservedAt = account?.codexQuota?.observedAt
  useEffect(() => {
    if (accountId) void loadHistory(accountId)
    else {
      setHistory([])
      setCycleCosts({})
    }
  }, [accountId, loadHistory, quotaObservedAt])

  const refresh = useCallback(async () => {
    if (!accountId) return
    const success = await runAction(`refresh-quota-${accountId}`, () => api.refreshAccountCodexQuota(accountId))
    if (success) await loadHistory(accountId)
  }, [accountId, api, loadHistory, runAction])

  useEffect(() => {
    if (!accountId) {
      autoRefreshAttempt.current = undefined
      return
    }
    const currentIsFresh = quotaObservedAt !== undefined && Date.now() - quotaObservedAt <= 10 * 60 * 1000
    if (currentIsFresh || autoRefreshAttempt.current === accountId) return
    autoRefreshAttempt.current = accountId
    void refresh()
  }, [accountId, quotaObservedAt, refresh])

  const quota = account?.codexQuota
  const stale = quota ? Date.now() - quota.observedAt > 10 * 60 * 1000 : false
  const longWindow = quota?.sevenDay ?? quota?.monthly
  const exhausted = quotaExhaustionIsCurrent(quota)
  const longQuotaPeriodZh = codexLongQuotaPeriodLabel(longWindow?.windowSeconds)
  const longQuotaPeriod = t(longQuotaPeriodZh, longQuotaPeriodZh === '月' ? 'Monthly' : 'Weekly')
  const consumeResetCredit = useCallback(async () => {
    if (!accountId) return
    const confirmed = window.confirm(t(
      '确定消耗 1 张额度重置券吗？此操作会立即在上游重置 Codex 额度，无法撤销。',
      'Consume one quota reset credit? This resets Codex quota upstream immediately and cannot be undone.',
    ))
    if (!confirmed) return
    const success = await runAction(
      `consume-quota-credit-${accountId}`,
      () => api.consumeAccountCodexResetCredit(accountId),
    )
    if (success) await loadHistory(accountId)
  }, [accountId, api, loadHistory, runAction, t])
  return (
    <Modal
      open={Boolean(account)}
      title={t(`${account?.name ?? ''} · Codex 额度`, `${account?.name ?? ''} · Codex quota`)}
      width="large"
      onClose={onClose}
      footer={<><span className="quota-modal__source">{quota ? `${quota.source === 'usage-endpoint' ? t('主动查询', 'Usage query') : t('响应头', 'Response headers')} · ${new Date(quota.observedAt).toLocaleString(locale)}` : t('尚无快照', 'No snapshot yet')}</span><button className="button button--secondary" type="button" disabled={!account || busyKeys.has(`refresh-quota-${account?.id}`)} onClick={() => void refresh()}>{busyKeys.has(`refresh-quota-${account?.id}`) ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('刷新额度', 'Refresh quota')}</button></>}
    >
      <div className="quota-modal">
        <div className="quota-summary-grid">
          <QuotaSummary label={t('5 小时额度', '5-hour quota')} window={quota?.fiveHour} stale={stale} costUsd={cycleCosts.fiveHourUsd} unpricedTokens={cycleCosts.fiveHourUnpricedUsdTokens} />
          <QuotaSummary label={t(`${longQuotaPeriod}额度`, `${longQuotaPeriod} quota`)} window={longWindow} stale={stale} costUsd={cycleCosts.sevenDayUsd} unpricedTokens={cycleCosts.sevenDayUnpricedUsdTokens} />
        </div>
        <div className="quota-credit-note">{t('美元消耗按 OpenAI 当前官方 Token 费率由本地请求记录估算；左侧为已记录消耗，右侧为按额度使用比例推算的整周期消耗。缓存写入不计费，Fast 模式附加费不作猜测。', 'USD usage is estimated from local request logs using OpenAI’s current official token rate card. The left value is recorded usage and the right value projects the full cycle from the quota percentage. Cache writes are free; Fast-mode surcharges are not guessed.')}</div>
        {(cycleCosts.hiddenQuotaUsd ?? 0) > 0 && <div className="quota-hidden-credit-note" role="status">
          <span className="quota-hidden-credit-note__mark">$</span>
          <div>
            <strong>{t(`Stone+ 已释放 ${formatAccountQuotaUsd(cycleCosts.hiddenQuotaUsd, locale)} 隐藏额度`, `Stone+ released ${formatAccountQuotaUsd(cycleCosts.hiddenQuotaUsd, locale)} in hidden quota`)}</strong>
            <span>{t('指额度达到 100% 后仍记录到的 Token，按本地请求记录与官方费率估算。', 'Tokens recorded after the quota reached 100%, estimated from local request logs and the official rate card.')}</span>
            {(cycleCosts.hiddenQuotaUnpricedTokens ?? 0) > 0 && <small>{t('部分模型未列入费率表，金额可能低估。', 'Some models are not on the rate card; the amount may be understated.')}</small>}
          </div>
        </div>}
        {quota?.planType && <div className="quota-credit-note"><strong>{t('订阅方案', 'Plan')}：{quota.planType}</strong></div>}
        {quota?.resetCredits && <div className="quota-credit-note"><strong>{t(`可用额度重置券：${quota.resetCredits.availableCount}`, `Available quota reset credits: ${quota.resetCredits.availableCount}`)}</strong>{quota.resetCredits.expiresAt?.[0] ? ` · ${t('最近到期', 'Earliest expiry')} ${new Date(quota.resetCredits.expiresAt[0]).toLocaleString(locale)}` : ''}{quota.resetCredits.availableCount > 0 && <button className="button button--secondary" type="button" disabled={busyKeys.has(`consume-quota-credit-${accountId}`)} onClick={() => void consumeResetCredit()}>{busyKeys.has(`consume-quota-credit-${accountId}`) ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('使用重置券', 'Use reset credit')}</button>}</div>}
        {(quota?.additionalBuckets?.length ?? 0) > 0 && <section className="quota-additional-buckets">
          <strong>{t('模型专属额度', 'Model-specific quota')}</strong>
          {quota!.additionalBuckets!.map((bucket) => {
            const bucketLong = bucket.sevenDay ?? bucket.monthly
            return <div key={bucket.id} className="quota-additional-buckets__row"><span>{bucket.label ?? bucket.id}</span><CompactWindow label="5h" window={bucket.fiveHour} /><CompactWindow label={bucket.monthly ? t('月', 'Month') : t('周', 'Week')} window={bucketLong} /></div>
          })}
        </section>}
        {exhausted && <div className="warning-banner"><Clock3 size={17} /><div><strong>{t('上游已标记额度耗尽', 'Upstream reports that the quota is exhausted')}</strong><span>{t('Stone+ 会按实际 429 重置时间冷却账号', 'Stone+ cools the account down until the reset time reported by the actual 429 response.')}</span></div></div>}
        <QuotaTrend
          label={t('5 小时额度 · 最近 24 小时', '5-hour quota · Last 24 hours')}
          points={history.filter((point) => point.observedAt >= Date.now() - 24 * 60 * 60 * 1000)}
          value={(point) => point.fiveHourUsedPercent}
        />
        <QuotaTrend label={t(`${longQuotaPeriod}额度 · 最近 14 天`, `${longQuotaPeriod} quota · Last 14 days`)} points={history} value={(point) => point.sevenDayUsedPercent} weekly />
        {loading && <div className="quota-history-state"><LoaderCircle size={17} className="spin" />{t('正在读取本地采样…', 'Loading local samples…')}</div>}
        {error && <div className="quota-history-state quota-history-state--error">{error}</div>}
      </div>
    </Modal>
  )
}

export function CodexQuotaCompact({ quota, onClick }: { quota: PublicAccount['codexQuota']; onClick?: () => void }) {
  const { t } = useI18n()
  if (!quota) return <button className="quota-compact quota-compact--empty" type="button" onClick={onClick}>{t('尚未采集', 'Not collected')}</button>
  const longWindow = quota.sevenDay ?? quota.monthly
  const longQuotaPeriodZh = codexLongQuotaPeriodLabel(longWindow?.windowSeconds)
  const longQuotaPeriod = t(longQuotaPeriodZh, longQuotaPeriodZh === '月' ? 'Month' : 'Week')
  return <button className="quota-compact" type="button" title={t('查看额度趋势', 'View quota trends')} onClick={onClick}>
    <CompactWindow label="5h" window={quota.fiveHour} />
    <CompactWindow label={longQuotaPeriod} window={longWindow} />
  </button>
}

function CompactWindow({ label, window }: { label: string; window?: CodexQuotaWindow }) {
  const percent = window?.usedPercent
  return <span className="quota-compact__row"><span>{label}</span><span className="quota-compact__track"><i style={{ width: `${clampPercent(percent)}%` }} /></span><strong>{percent === undefined ? '—' : `${formatPercent(percent)}%`}</strong></span>
}

function QuotaSummary({
  label,
  window,
  stale,
  costUsd,
  unpricedTokens
}: {
  label: string
  window?: CodexQuotaWindow
  stale: boolean
  costUsd?: number
  unpricedTokens?: number
}) {
  const { t, locale } = useI18n()
  const incomplete = (unpricedTokens ?? 0) > 0
  const displayedUsd = incomplete ? undefined : costUsd
  return <section className="quota-summary">
    <header><span>{label}</span><Badge tone={!window ? 'neutral' : stale ? 'warning' : window.usedPercent >= 90 ? 'danger' : 'success'}>{!window ? t('未知', 'Unknown') : stale ? t('待刷新', 'Stale') : t('实时', 'Live')}</Badge></header>
    <div className="quota-summary__value">
      <strong>{window ? formatPercent(window.usedPercent, locale) : '—'}</strong>
      <span>{t('% 已使用', '% used')}</span>
      <b title={incomplete
        ? t('包含官方费率表未列出的模型，无法无损估算美元消耗', 'Contains a model absent from the official rate card; USD usage cannot be estimated losslessly.')
        : undefined}
      >
        <span>{formatAccountQuotaUsd(displayedUsd, locale)}</span>
        <i>/</i>
        <span>{formatAccountQuotaUsd(projectedQuotaAmount(displayedUsd, window?.usedPercent), locale)}</span>
      </b>
    </div>
    <div className="quota-summary__track"><span style={{ width: `${clampPercent(window?.usedPercent)}%` }} /></div>
    <footer><span>{window?.windowSeconds ? formatWindow(window.windowSeconds, t) : t('窗口时长未知', 'Window duration unknown')}</span><span>{resetLabel(window?.resetAt, t)}</span></footer>
  </section>
}

function QuotaTrend({
  label,
  points,
  value,
  weekly = false,
}: {
  label: string
  points: CodexQuotaHistoryPoint[]
  value: (point: CodexQuotaHistoryPoint) => number | undefined
  weekly?: boolean
}) {
  const { t, locale } = useI18n()
  const samples = useMemo(() => downsample(points.filter((point) => value(point) !== undefined), 72), [points, value])
  return <section className={`quota-trend ${weekly ? 'quota-trend--weekly' : ''}`}>
    <header><div><strong>{label}</strong><span>{samples.length ? t(`${samples.length} 个本地采样`, `${samples.length} local ${samples.length === 1 ? 'sample' : 'samples'}`) : t('从启用后开始记录', 'Recording starts after this feature is enabled')}</span></div><span className="quota-trend__legend">0–100%</span></header>
    {samples.length ? <div className="quota-trend__plot" aria-label={label}>{samples.map((point) => {
      const percent = value(point) ?? 0
      return <span key={`${point.observedAt}-${percent}`} title={`${new Date(point.observedAt).toLocaleString(locale)} · ${formatPercent(percent, locale)}%`}><i style={{ height: `${Math.max(2, clampPercent(percent))}%` }} /></span>
    })}<div className="quota-trend__line quota-trend__line--50" /><div className="quota-trend__line quota-trend__line--100" /></div> : <div className="quota-trend__empty">{t('暂无历史采样', 'No historical samples')}</div>}
  </section>
}

function downsample(points: CodexQuotaHistoryPoint[], maximum: number): CodexQuotaHistoryPoint[] {
  if (points.length <= maximum) return points
  const step = (points.length - 1) / (maximum - 1)
  return Array.from({ length: maximum }, (_, index) => points[Math.round(index * step)])
}

function clampPercent(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.min(100, value))
}

function formatPercent(value: number, locale = 'zh-CN'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
}

function projectedQuotaAmount(used: number | undefined, usedPercent: number | undefined): number | undefined {
  if (used === undefined || usedPercent === undefined || usedPercent <= 0) return undefined
  return used * 100 / Math.min(100, usedPercent)
}

function quotaExhaustionIsCurrent(quota: PublicAccount['codexQuota'], now = Date.now()): boolean {
  if (!quota) return false
  const windows = [quota.fiveHour, quota.sevenDay, quota.monthly].filter(Boolean) as CodexQuotaWindow[]
  const activeExhausted = windows.some((window) => (
    window.usedPercent >= 100 && (window.resetAt === undefined || window.resetAt > now)
  ))
  if (activeExhausted) return true
  const topLevelExhausted = quota.allowed === false || quota.limitReached === true
  if (!topLevelExhausted || now - quota.observedAt > 2 * 60 * 60 * 1000) return false
  return !windows.some((window) => window.resetAt !== undefined && window.resetAt <= now)
}

function formatWindow(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  if (seconds <= 6 * 60 * 60) {
    const hours = Math.round(seconds / 3600)
    return t(`${hours} 小时窗口`, `${hours}-hour window`)
  }
  const days = Math.round(seconds / 86_400)
  return t(`${days} 天窗口`, `${days}-day window`)
}

function resetLabel(resetAt: number | undefined, t: ReturnType<typeof useI18n>['t']): string {
  if (!resetAt) return t('重置时间未知', 'Reset time unknown')
  const remaining = resetAt - Date.now()
  if (remaining <= 0) return t('窗口已到期', 'Window expired')
  const hours = Math.floor(remaining / 3_600_000)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return t(`${days} 天 ${remainingHours} 小时后重置`, `Resets in ${days}d ${remainingHours}h`)
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  return hours > 0
    ? t(`${hours} 小时 ${minutes % 60} 分后重置`, `Resets in ${hours}h ${minutes % 60}m`)
    : t(`${minutes} 分钟后重置`, `Resets in ${minutes}m`)
}
