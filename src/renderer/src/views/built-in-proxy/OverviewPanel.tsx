import { useId, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  Network,
  RefreshCw,
  RotateCcw,
  Router,
  ShieldCheck,
  Unplug,
  Waypoints,
} from 'lucide-react'
import type {
  BuiltInProxyAccessMode,
  BuiltInProxyRuleMode,
  OutboundNetworkMode,
} from '@shared/types'
import { useI18n } from '../../i18n'
import styles from './OverviewPanel.module.css'

export type ProxyOverviewTakeoverStatus =
  | 'inactive'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'blocked'
  | 'error'

export type ProxyOverviewEvidenceTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ProxyOverviewEvidence {
  id: string
  label: string
  value: string
  tone?: ProxyOverviewEvidenceTone
}

export interface ProxyOverviewRouteHop {
  /** Visible, caller-supplied identity. No endpoint or node is inferred here. */
  label: string
  detail?: string
}

export interface ProxyOverviewRouteChain {
  status: 'inactive' | 'preparing' | 'active' | 'blocked'
  stone: ProxyOverviewRouteHop
  mixed: ProxyOverviewRouteHop
  node: ProxyOverviewRouteHop
}

export interface ProxyOverviewSelection {
  profileName?: string
  nodeName?: string
  ruleMode?: BuiltInProxyRuleMode
  accessMode?: BuiltInProxyAccessMode
  ruleLabel?: string
  accessLabel?: string
}

export interface ProxyOverviewExternalBindings {
  accountCount: number
  poolCount: number
  /** Set only from the authoritative built-in-proxy interlock state. */
  paused: boolean
}

export interface ProxyOverviewExternalOutbound {
  mode: OutboundNetworkMode
  /** True only when the original gateway outbound mode remains stored unchanged. */
  preserved: boolean
}

export interface ProxyOverviewProtection {
  /** Caller-supplied loopback endpoints or roles proven to bypass PAC/TUN. */
  loopbackBypasses: readonly string[]
  failClosedEnabled: boolean
  failClosedActive: boolean
}

export type ProxyOverviewNavigationTarget = 'profiles' | 'nodes' | 'rules' | 'connections'

export interface ProxyOverviewPanelProps {
  takeover: {
    status: ProxyOverviewTakeoverStatus
    detail?: string
    evidence: readonly ProxyOverviewEvidence[]
  }
  route: ProxyOverviewRouteChain
  selection: ProxyOverviewSelection
  externalBindings: ProxyOverviewExternalBindings
  externalOutbound: ProxyOverviewExternalOutbound
  protection: ProxyOverviewProtection
  retrying?: boolean
  rebuilding?: boolean
  onRetry?: () => void
  onRebuild?: () => void
  onNavigate?: (target: ProxyOverviewNavigationTarget) => void
  navigationTargets?: readonly ProxyOverviewNavigationTarget[]
  className?: string
}

const defaultNavigationTargets: readonly ProxyOverviewNavigationTarget[] = [
  'profiles',
  'nodes',
  'rules',
  'connections',
]

const takeoverStatusClass: Record<ProxyOverviewTakeoverStatus, string> = {
  inactive: styles.statusInactive,
  starting: styles.statusWorking,
  ready: styles.statusReady,
  stopping: styles.statusWorking,
  blocked: styles.statusDanger,
  error: styles.statusDanger,
}

const evidenceToneClass: Record<ProxyOverviewEvidenceTone, string> = {
  neutral: styles.evidenceNeutral,
  success: styles.evidenceSuccess,
  warning: styles.evidenceWarning,
  danger: styles.evidenceDanger,
}

const routeStatusClass: Record<ProxyOverviewRouteChain['status'], string> = {
  inactive: styles.routeInactive,
  preparing: styles.routePreparing,
  active: styles.routeActive,
  blocked: styles.routeBlocked,
}

export function OverviewPanel({
  takeover,
  route,
  selection,
  externalBindings,
  externalOutbound,
  protection,
  retrying = false,
  rebuilding = false,
  onRetry,
  onRebuild,
  onNavigate,
  navigationTargets = defaultNavigationTargets,
  className,
}: ProxyOverviewPanelProps) {
  const { t } = useI18n()
  const titleId = useId()
  const routeTitleId = useId()
  const statusLabel = takeoverStatusLabel(takeover.status, t)
  const statusIcon = takeoverStatusIcon(takeover.status)
  const selectionItems = [
    selection.profileName
      ? { id: 'profile', label: t('当前配置', 'Profile'), value: selection.profileName }
      : undefined,
    selection.nodeName
      ? { id: 'node', label: t('当前节点', 'Node'), value: selection.nodeName }
      : undefined,
    selection.ruleLabel || selection.ruleMode
      ? { id: 'rule', label: t('代理模式', 'Proxy mode'), value: selection.ruleLabel ?? ruleModeLabel(selection.ruleMode!, t) }
      : undefined,
    selection.accessLabel || selection.accessMode
      ? { id: 'access', label: t('接入方式', 'Access'), value: selection.accessLabel ?? accessModeLabel(selection.accessMode!, t) }
      : undefined,
  ].filter((item): item is { id: string; label: string; value: string } => Boolean(item))
  const hasActions = Boolean(onRetry || onRebuild || onNavigate)
  const rootClassName = [styles.panel, className].filter(Boolean).join(' ')

  return (
    <section className={rootClassName} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.headingIcon} aria-hidden="true"><Waypoints size={20} /></span>
          <div>
            <h2 id={titleId}>{t('Stone+ 代理概览', 'Stone+ proxy overview')}</h2>
            <p>{t('集中查看接管、路由与防泄漏状态。', 'See takeover, routing, and leak protection in one place.')}</p>
          </div>
        </div>
        <div
          className={`${styles.status} ${takeoverStatusClass[takeover.status]}`}
          aria-live="polite"
          role="status"
        >
          <span aria-hidden="true">{statusIcon}</span>
          <strong>{statusLabel}</strong>
        </div>
      </header>

      {takeover.detail && <p className={styles.statusDetail}>{takeover.detail}</p>}

      {takeover.evidence.length > 0 && (
        <dl className={styles.evidence} aria-label={t('接管证据', 'Takeover evidence')}>
          {takeover.evidence.map((item) => (
            <div
              className={`${styles.evidenceItem} ${evidenceToneClass[item.tone ?? 'neutral']}`}
              key={item.id}
            >
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <section className={`${styles.routeSection} ${routeStatusClass[route.status]}`} aria-labelledby={routeTitleId}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>{t('新请求路径', 'New request path')}</span>
            <h3 id={routeTitleId}>{t('当前路由链', 'Current route chain')}</h3>
          </div>
          <div className={styles.routeState}>
            <Network size={18} aria-hidden="true" />
            <StatePill tone={routeStatusTone(route.status)}>{routeStatusLabel(route.status, t)}</StatePill>
          </div>
        </div>
        <ol className={styles.routeChain}>
          <RouteHop icon={<Activity size={18} />} hop={route.stone} />
          <RouteConnector />
          <RouteHop icon={<Router size={18} />} hop={route.mixed} />
          <RouteConnector />
          <RouteHop icon={<Network size={18} />} hop={route.node} />
        </ol>
      </section>

      <div className={styles.summaryGrid}>
        <section className={styles.summaryCard} aria-label={t('当前选择', 'Current selection')}>
          <div className={styles.cardHeading}>
            <Waypoints size={17} aria-hidden="true" />
            <h3>{t('当前选择', 'Current selection')}</h3>
          </div>
          <dl className={styles.selectionList}>
            {selectionItems.map((item) => (
              <div key={item.id}>
                <dt>{item.label}</dt>
                <dd title={item.value}>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={styles.summaryCard} aria-label={t('外部设置保留状态', 'Preserved external settings')}>
          <div className={styles.cardHeading}>
            <Unplug size={17} aria-hidden="true" />
            <h3>{t('外部设置', 'External settings')}</h3>
          </div>
          <div className={styles.bindingRow}>
            <div>
              <span>{t('外部代理绑定', 'External proxy bindings')}</span>
              <strong>
                {t(
                  `账号 ${externalBindings.accountCount} · 号池 ${externalBindings.poolCount}`,
                  `${externalBindings.accountCount} account${externalBindings.accountCount === 1 ? '' : 's'} · ${externalBindings.poolCount} pool${externalBindings.poolCount === 1 ? '' : 's'}`,
                )}
              </strong>
            </div>
            <StatePill tone={externalBindings.paused ? 'warning' : 'success'}>
              {externalBindings.paused
                ? t('保留但暂停', 'Retained, paused')
                : t('正常生效', 'Active')}
            </StatePill>
          </div>
          <div className={styles.bindingRow}>
            <div>
              <span>outboundNetworkMode</span>
              <strong>{outboundModeLabel(externalOutbound.mode, t)}</strong>
            </div>
            <StatePill tone={externalOutbound.preserved ? 'success' : 'neutral'}>
              {externalOutbound.preserved ? t('原值已保留', 'Original retained') : t('当前值', 'Current value')}
            </StatePill>
          </div>
        </section>

        <section className={`${styles.summaryCard} ${styles.protectionCard}`} aria-label={t('防泄漏保护', 'Leak protection')}>
          <div className={styles.cardHeading}>
            <ShieldCheck size={17} aria-hidden="true" />
            <h3>{t('防泄漏保护', 'Leak protection')}</h3>
          </div>
          <div className={styles.protectionStatus}>
            <div>
              <span>Fail-closed</span>
              <strong>{failClosedLabel(protection, t)}</strong>
            </div>
            <StatePill tone={protection.failClosedActive ? 'danger' : protection.failClosedEnabled ? 'success' : 'neutral'}>
              {protection.failClosedActive
                ? t('正在阻断', 'Blocking')
                : protection.failClosedEnabled
                  ? t('已启用', 'Enabled')
                  : t('未启用', 'Disabled')}
            </StatePill>
          </div>
          {protection.loopbackBypasses.length > 0 && (
            <div className={styles.bypassBlock}>
              <span>{t('回环直连 / 旁路', 'Loopback direct / bypass')}</span>
              <ul>
                {protection.loopbackBypasses.map((bypass) => <li key={bypass}>{bypass}</li>)}
              </ul>
            </div>
          )}
        </section>
      </div>

      {hasActions && (
        <footer className={styles.actions} aria-label={t('代理快捷操作', 'Proxy quick actions')}>
          <div className={styles.primaryActions}>
            {onRetry && (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={onRetry}
                disabled={retrying}
                aria-busy={retrying}
              >
                {retrying ? <LoaderCircle className={styles.spin} size={16} /> : <RotateCcw size={16} />}
                {retrying ? t('正在重试…', 'Retrying…') : t('重试接管', 'Retry takeover')}
              </button>
            )}
            {onRebuild && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onRebuild}
                disabled={rebuilding}
                aria-busy={rebuilding}
              >
                {rebuilding ? <LoaderCircle className={styles.spin} size={16} /> : <RefreshCw size={16} />}
                {rebuilding ? t('正在重建…', 'Rebuilding…') : t('重建低延迟出口', 'Rebuild low-latency route')}
              </button>
            )}
          </div>
          {onNavigate && navigationTargets.length > 0 && (
            <nav className={styles.navigation} aria-label={t('前往代理详情', 'Open proxy details')}>
              {navigationTargets.map((target) => (
                <button
                  type="button"
                  className={styles.navigationButton}
                  key={target}
                  onClick={() => onNavigate(target)}
                >
                  {navigationLabel(target, t)}
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              ))}
            </nav>
          )}
        </footer>
      )}
    </section>
  )
}

function RouteHop({ icon, hop }: { icon: ReactNode; hop: ProxyOverviewRouteHop }) {
  return (
    <li className={styles.routeHop}>
      <span className={styles.routeIcon} aria-hidden="true">{icon}</span>
      <div>
        <strong>{hop.label}</strong>
        {hop.detail && <span title={hop.detail}>{hop.detail}</span>}
      </div>
    </li>
  )
}

function RouteConnector() {
  return (
    <li className={styles.routeConnector} aria-hidden="true">
      <span />
      <ArrowRight size={16} />
    </li>
  )
}

function StatePill({
  tone,
  children,
}: {
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  children: ReactNode
}) {
  return <span className={`${styles.statePill} ${styles[`pill${capitalize(tone)}`]}`}>{children}</span>
}

function takeoverStatusIcon(status: ProxyOverviewTakeoverStatus): ReactNode {
  if (status === 'ready') return <CheckCircle2 size={17} />
  if (status === 'blocked' || status === 'error') return <AlertTriangle size={17} />
  if (status === 'starting' || status === 'stopping') return <LoaderCircle className={styles.spin} size={17} />
  return <CircleDashed size={17} />
}

type Translator = <T>(chinese: T, english: T) => T

function takeoverStatusLabel(status: ProxyOverviewTakeoverStatus, t: Translator): string {
  const labels: Record<ProxyOverviewTakeoverStatus, readonly [string, string]> = {
    inactive: ['未接管', 'Not taking over'],
    starting: ['正在接管', 'Taking over'],
    ready: ['已接管', 'Taken over'],
    stopping: ['正在恢复', 'Restoring'],
    blocked: ['已阻断', 'Blocked'],
    error: ['接管错误', 'Takeover error'],
  }
  return t(...labels[status])
}

function ruleModeLabel(mode: BuiltInProxyRuleMode, t: Translator): string {
  if (mode === 'rule') return t('规则', 'Rule')
  if (mode === 'global') return t('全局', 'Global')
  return t('直连', 'Direct')
}

function accessModeLabel(mode: BuiltInProxyAccessMode, t: Translator): string {
  return mode === 'system' ? t('系统代理', 'System proxy') : 'TUN'
}

function outboundModeLabel(mode: OutboundNetworkMode, t: Translator): string {
  return mode === 'system' ? t('系统代理', 'System proxy') : t('直连', 'Direct')
}

function failClosedLabel(protection: ProxyOverviewProtection, t: Translator): string {
  if (protection.failClosedActive) return t('故障时禁止直连回退', 'Direct fallback is blocked during failure')
  if (protection.failClosedEnabled) return t('故障后将阻断新请求', 'New requests will be blocked after a failure')
  return t('未提供阻断保证', 'No blocking guarantee is provided')
}

function navigationLabel(target: ProxyOverviewNavigationTarget, t: Translator): string {
  if (target === 'profiles') return t('配置', 'Profiles')
  if (target === 'nodes') return t('节点', 'Nodes')
  if (target === 'rules') return t('规则', 'Rules')
  return t('连接', 'Connections')
}

function routeStatusLabel(status: ProxyOverviewRouteChain['status'], t: Translator): string {
  if (status === 'active') return t('路由生效', 'Route active')
  if (status === 'preparing') return t('准备中', 'Preparing')
  if (status === 'blocked') return t('路由阻断', 'Route blocked')
  return t('未接管', 'Inactive')
}

function routeStatusTone(
  status: ProxyOverviewRouteChain['status'],
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'preparing') return 'warning'
  if (status === 'blocked') return 'danger'
  return 'neutral'
}

function capitalize<T extends string>(value: T): Capitalize<T> {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}` as Capitalize<T>
}
