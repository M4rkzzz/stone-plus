import { memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import {
  Activity,
  Boxes,
  ChevronLeft,
  CircleGauge,
  Globe2,
  CircleHelp,
  Menu,
  MonitorCog,
  Network,
  Play,
  Power,
  RefreshCw,
  Route as RouteIcon,
  Share2,
  Settings,
  Stethoscope,
  Wrench,
  Waypoints,
  Square,
  X,
} from 'lucide-react'
import type { AppSnapshot, AppUpdateState, GatewayApi } from '@shared/types'
import type { AgentLifecycleOperationResult, AgentLifecycleSnapshot, AgentTarget } from '@shared/agent-lifecycle'
import { listRouteSources } from '@shared/route-sources'
import { getGatewayApi } from './api'
import { OverviewView } from './views/OverviewView'
import { ProvidersView } from './views/ProvidersView'
import { ProxyView } from './views/ProxyView'
import { PoolsView } from './views/PoolsView'
import { RoutesView } from './views/RoutesView'
import { RequestsView } from './views/RequestsView'
import { SettingsView } from './views/SettingsView'
import { ClientsView } from './views/ClientsView'
import { TunnelView } from './views/TunnelView'
import { SessionRepairView } from './views/SessionRepairView'
import { NetworkTestView } from './views/NetworkTestView'
import { BrowserView } from './views/BrowserView'
import { SetupWizardView } from './views/SetupWizardView'
import { HelpView } from './views/HelpView'
import { gatewayBaseUrl } from './ui'
import { StoneMark } from './StoneMark'
import { summarizeAccountQuota } from './account-quota'
import {
  UpdateDialog,
  type AppUpdateController,
  type UpdateAction,
} from './UpdateDialog'
import { useI18n } from './i18n'
import { applyRuntimeDelta, RuntimeSnapshotReloadCoordinator, shouldAcceptSnapshotRevision } from './runtime-delta'
import { AgentLifecycleControl, type AgentLifecycleControlAction } from './agent-lifecycle-control'
import { agentLifecycleRenderKey, appSnapshotAffectsPage } from './app-render-state'

export type PageId = 'overview' | 'setup' | 'providers' | 'proxies' | 'pools' | 'routes' | 'clients' | 'session-repair' | 'tunnel' | 'browser' | 'diagnostics' | 'requests' | 'settings' | 'help'
export type ActionRunner = (key: string, operation: () => Promise<AppSnapshot>) => Promise<boolean>

function localizedError(cause: unknown, fallback: string, language: 'zh-CN' | 'en'): string {
  if (!(cause instanceof Error)) return fallback
  return language === 'en' && /[\u3400-\u9fff]/u.test(cause.message) ? fallback : cause.message
}

const desktopTunnelSupported = !window.stone || window.stonePlatform === 'win32'

const allNavigation: Array<{ id: PageId; label: readonly [string, string]; icon: typeof Activity }> = [
  { id: 'overview', label: ['总览', 'Overview'], icon: CircleGauge },
  { id: 'providers', label: ['账号与中转', 'Accounts & Relays'], icon: Boxes },
  { id: 'proxies', label: ['代理', 'Proxies'], icon: Waypoints },
  { id: 'pools', label: ['号池', 'Pools'], icon: Network },
  { id: 'routes', label: ['路由', 'Routes'], icon: RouteIcon },
  { id: 'clients', label: ['客户端配置', 'Client Configuration'], icon: MonitorCog },
  { id: 'session-repair', label: ['会话修复', 'Session Repair'], icon: Wrench },
  { id: 'tunnel', label: ['内网穿透', 'Tunnel'], icon: Share2 },
  { id: 'browser', label: ['内置浏览器', 'Built-in Browser'], icon: Globe2 },
  { id: 'diagnostics', label: ['诊断', 'Diagnostics'], icon: Stethoscope },
  { id: 'requests', label: ['请求记录', 'Request Logs'], icon: Activity },
  { id: 'settings', label: ['设置', 'Settings'], icon: Settings },
]

const navigation = allNavigation.filter((item) => desktopTunnelSupported || item.id !== 'tunnel')

function pageFromHash(): PageId {
  const candidate = window.location.hash.slice(1) as PageId
  return candidate === 'setup' || candidate === 'help' || navigation.some((item) => item.id === candidate) ? candidate : 'overview'
}

const SETUP_AUTO_SHOWN_STORAGE_KEY = 'stone.setup.auto-shown.v1'

function LoadingScreen() {
  const { t } = useI18n()
  return (
    <div className="boot-screen">
      <StoneMark />
      <RefreshCw size={20} className="spin" />
      <p>{t('正在连接本地网关…', 'Connecting to the local gateway…')}</p>
    </div>
  )
}

interface ActivePageProps {
  page: PageId
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
  update: AppUpdateController
  navigate: (page: PageId) => void
}

const ActivePage = memo(function ActivePage({
  page,
  snapshot,
  api,
  runAction,
  busyKeys,
  update,
  navigate,
}: ActivePageProps) {
  if (page === 'overview') return <OverviewView snapshot={snapshot} navigate={navigate} />
  if (page === 'setup') return <SetupWizardView snapshot={snapshot} api={api} onExit={() => navigate('overview')} />
  if (page === 'providers') return <ProvidersView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'proxies') return <ProxyView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'pools') return <PoolsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'routes') return <RoutesView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'clients') return <ClientsView snapshot={snapshot} api={api} />
  if (page === 'session-repair') return <SessionRepairView api={api} />
  if (page === 'tunnel' && desktopTunnelSupported) return <TunnelView snapshot={snapshot} api={api} />
  if (page === 'browser') return <BrowserView snapshot={snapshot} api={api} />
  if (page === 'diagnostics') return <NetworkTestView snapshot={snapshot} api={api} />
  if (page === 'requests') return <RequestsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'settings') return <SettingsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} update={update} />
  if (page === 'help') return <HelpView snapshot={snapshot} api={api} navigate={navigate} />
  return null
})

const MemoAgentLifecycleControl = memo(AgentLifecycleControl)

export default function App() {
  const { t, language } = useI18n()
  const api = useMemo(() => getGatewayApi(), [])
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateAction, setUpdateAction] = useState<UpdateAction | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [agentLifecycleSnapshot, setAgentLifecycleSnapshot] = useState<AgentLifecycleSnapshot | null>(null)
  const [lastAgentOperation, setLastAgentOperation] = useState<AgentLifecycleOperationResult | undefined>()
  const [agentOperationPending, setAgentOperationPending] = useState(false)
  const updateRevision = useRef(-1)
  const runtimeRevision = useRef(-1)
  const agentLifecycleRevision = useRef(-1)
  const agentLifecycleRenderState = useRef<string | undefined>(undefined)
  const agentOperationInFlight = useRef(false)
  const agentLifecycleRefreshInFlight = useRef<Promise<void> | null>(null)
  const activePageSnapshot = useRef<{ page: PageId; snapshot: AppSnapshot } | undefined>(undefined)
  const scrollbarHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const acceptUpdateState = useCallback((next: AppUpdateState) => {
    if (next.revision <= updateRevision.current) return
    updateRevision.current = next.revision
    setUpdateState(next)
  }, [])

  const acceptSnapshot = useCallback((next: AppSnapshot) => {
    if (next.runtimeRevision !== undefined) {
      if (!shouldAcceptSnapshotRevision(runtimeRevision.current, next.runtimeRevision)) return
      // Focus and visibility events can both request the same authoritative
      // snapshot. A repeated revision cannot contain a newer published state,
      // so retain the existing object graph instead of re-rendering the app.
      if (runtimeRevision.current === next.runtimeRevision) return
      runtimeRevision.current = next.runtimeRevision
    }
    setSnapshot(next)
  }, [])

  const acceptAgentLifecycleSnapshot = useCallback((next: AgentLifecycleSnapshot) => {
    if (!shouldAcceptSnapshotRevision(agentLifecycleRevision.current, next.revision)) return
    agentLifecycleRevision.current = next.revision
    const renderState = agentLifecycleRenderKey(next)
    if (agentLifecycleRenderState.current === renderState) return
    agentLifecycleRenderState.current = renderState
    setAgentLifecycleSnapshot(next)
  }, [])

  const refreshAgentLifecycle = useCallback((): Promise<void> => {
    if (agentLifecycleRefreshInFlight.current) return agentLifecycleRefreshInFlight.current
    const request = api.getAgentLifecycleSnapshot()
      .then(acceptAgentLifecycleSnapshot)
      .catch(() => undefined)
    const tracked = request.finally(() => {
      if (agentLifecycleRefreshInFlight.current === tracked) agentLifecycleRefreshInFlight.current = null
    })
    agentLifecycleRefreshInFlight.current = tracked
    return tracked
  }, [acceptAgentLifecycleSnapshot, api])

  const snapshotReload = useMemo(() => new RuntimeSnapshotReloadCoordinator({
    fetchSnapshot: () => api.getSnapshot(),
    acceptSnapshot,
    acceptedRevision: () => runtimeRevision.current,
    onError: (cause) => {
      setError(localizedError(cause, t('无法连接本地服务', 'Unable to connect to the local service'), language))
    },
  }), [acceptSnapshot, api, language, t])

  const load = useCallback((minimumRevision = -1) => {
    setError(null)
    return snapshotReload.request(minimumRevision)
  }, [snapshotReload])

  useEffect(() => {
    snapshotReload.activate()
    void load()
    const unsubscribeSnapshot = api.onSnapshot(acceptSnapshot)
    const unsubscribeRuntime = api.onRuntimeDelta((delta) => {
      if (delta.revision <= runtimeRevision.current) return
      if (runtimeRevision.current < 0 || delta.revision !== runtimeRevision.current + 1) {
        void load(delta.revision)
        return
      }
      runtimeRevision.current = delta.revision
      setSnapshot((current) => current ? applyRuntimeDelta(current, delta) : current)
    })
    return () => {
      unsubscribeSnapshot()
      unsubscribeRuntime()
      snapshotReload.dispose()
    }
  }, [acceptSnapshot, api, load, snapshotReload])

  useEffect(() => {
    const refreshVisibleSnapshot = () => {
      if (document.visibilityState === 'hidden') return
      void load()
    }
    window.addEventListener('focus', refreshVisibleSnapshot)
    document.addEventListener('visibilitychange', refreshVisibleSnapshot)
    return () => {
      window.removeEventListener('focus', refreshVisibleSnapshot)
      document.removeEventListener('visibilitychange', refreshVisibleSnapshot)
    }
  }, [load])

  useEffect(() => {
    const unsubscribe = api.onUpdateState(acceptUpdateState)
    void api.getUpdateState()
      .then(acceptUpdateState)
      .catch((cause: unknown) => setUpdateError(localizedError(cause, t('无法读取应用更新状态', 'Unable to read the app update status'), language)))
    return unsubscribe
  }, [acceptUpdateState, api, language, t])

  useEffect(() => {
    void refreshAgentLifecycle()
    const unsubscribeLifecycle = api.onAgentLifecycleChanged((event) => {
      acceptAgentLifecycleSnapshot(event.snapshot)
      if (event.operation) setLastAgentOperation(event.operation)
    })
    const refresh = () => void refreshAgentLifecycle()
    const unsubscribeInstances = api.onManagedClientInstancesChanged(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      unsubscribeLifecycle()
      unsubscribeInstances()
      window.removeEventListener('focus', refresh)
    }
  }, [acceptAgentLifecycleSnapshot, api, refreshAgentLifecycle])

  useEffect(() => {
    const handleHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (!snapshot || page === 'setup' || window.localStorage.getItem(SETUP_AUTO_SHOWN_STORAGE_KEY) === 'true') return
    const usableAccounts = snapshot.accounts.filter((account) => account.status !== 'disabled' && account.status !== 'expired')
    const usableSourceIds = new Set(listRouteSources(snapshot).map((source) => source.id))
    const hasEnabledRoute = snapshot.routes.some((route) => route.enabled && usableSourceIds.has(route.poolId))
    if (usableAccounts.length && usableSourceIds.size && hasEnabledRoute) return
    window.localStorage.setItem(SETUP_AUTO_SHOWN_STORAGE_KEY, 'true')
    setPage('setup')
    window.history.replaceState(null, '', '#setup')
  }, [page, snapshot])

  useEffect(() => {
    const rebuildAfterNetworkReturn = () => {
      void api.rebuildOutboundConnections().catch(() => undefined)
    }
    window.addEventListener('online', rebuildAfterNetworkReturn)
    return () => window.removeEventListener('online', rebuildAfterNetworkReturn)
  }, [api])

  const runAction: ActionRunner = useCallback(async (key, operation) => {
    setBusyKeys((current) => new Set(current).add(key))
    setError(null)
    try {
      acceptSnapshot(await operation())
      return true
    } catch (cause) {
      setError(localizedError(cause, t('操作失败，请稍后重试', 'The operation failed. Please try again later.'), language))
      return false
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [acceptSnapshot, language, t])

  const runAgentLifecycle = useCallback(async (
    operation: () => Promise<AgentLifecycleOperationResult>,
  ) => {
    if (agentOperationInFlight.current) return
    agentOperationInFlight.current = true
    setAgentOperationPending(true)
    setError(null)
    try {
      const result = await operation()
      setLastAgentOperation(result)
      acceptAgentLifecycleSnapshot(result.snapshot)
    } catch (cause) {
      setError(localizedError(cause, t('Agent 操作失败', 'Agent operation failed'), language))
    } finally {
      agentOperationInFlight.current = false
      setAgentOperationPending(false)
    }
  }, [acceptAgentLifecycleSnapshot, language, t])

  const runAgentAction = useCallback((target: AgentTarget, action: AgentLifecycleControlAction) => {
    const operation = action === 'close'
      ? () => api.closeAgent(target)
      : action === 'restore'
        ? () => api.restoreAgent(target, { ensureRunning: true })
        : action === 'restart'
          ? () => api.restartAgent(target)
          : () => api.startAgent(target)
    return runAgentLifecycle(operation)
  }, [api, runAgentLifecycle])

  const setActivePage = useCallback((id: PageId) => {
    setPage(id)
    window.history.replaceState(null, '', `#${id}`)
    setMobileNavOpen(false)
  }, [])

  const repairAllAgents = useCallback(
    () => runAgentLifecycle(() => api.repairAllAffectedAgents()),
    [api, runAgentLifecycle],
  )
  const closeAllAgents = useCallback(
    () => runAgentLifecycle(() => api.closeAllManagedAgents()),
    [api, runAgentLifecycle],
  )
  const openClientConfiguration = useCallback(
    () => setActivePage('clients'),
    [setActivePage],
  )

  const revealContentScrollbar = useCallback((event: UIEvent<HTMLElement>) => {
    const element = event.currentTarget
    element.classList.add('page-content--scrolling')
    if (scrollbarHideTimer.current) clearTimeout(scrollbarHideTimer.current)
    scrollbarHideTimer.current = setTimeout(() => {
      element.classList.remove('page-content--scrolling')
      scrollbarHideTimer.current = undefined
    }, 700)
  }, [])

  useEffect(() => () => {
    if (scrollbarHideTimer.current) clearTimeout(scrollbarHideTimer.current)
  }, [])

  const runUpdateStateOperation = useCallback(async (
    action: UpdateAction,
    operation: () => Promise<AppUpdateState>,
  ): Promise<AppUpdateState | undefined> => {
    setUpdateAction(action)
    setUpdateError(null)
    try {
      const next = await operation()
      acceptUpdateState(next)
      return next
    } catch (cause) {
      setUpdateError(localizedError(cause, t('应用更新操作失败', 'The app update operation failed'), language))
      return undefined
    } finally {
      setUpdateAction(null)
    }
  }, [acceptUpdateState, language, t])

  const checkForUpdates = useCallback(async () => {
    const next = await runUpdateStateOperation('check', () => api.checkForUpdates())
    if (next && (next.status === 'available' || next.status === 'downloaded' || next.status === 'unsupported')) {
      setUpdateDialogOpen(true)
    }
  }, [api, runUpdateStateOperation])

  const ignoreUpdate = useCallback(async () => {
    const version = updateState?.release?.version
    if (!version) return
    const next = await runUpdateStateOperation('ignore', () => api.ignoreUpdate(version))
    if (next) setUpdateDialogOpen(false)
  }, [api, runUpdateStateOperation, updateState?.release?.version])

  const downloadUpdate = useCallback(async () => {
    if (snapshot && snapshot.gatewayStatus.activeRequests > 0) {
      const confirmed = window.confirm(t(
        `当前仍有 ${snapshot.gatewayStatus.activeRequests} 个活跃请求。更新安装会关闭 Stone+ 并中断这些请求，是否继续？`,
        `${snapshot.gatewayStatus.activeRequests} active request(s) are still running. Installing the update will close Stone+ and interrupt them. Continue?`,
      ))
      if (!confirmed) return
    }

    setUpdateAction('download')
    setUpdateError(null)
    try {
      const next = await api.downloadUpdate()
      acceptUpdateState(next)
      if (next.status !== 'downloaded') {
        setUpdateError(next.error ?? t('更新包下载失败，请稍后重试', 'The update package could not be downloaded. Please try again later.'))
        return
      }

      setUpdateAction('install')
      await api.installUpdate()
    } catch (cause) {
      setUpdateError(localizedError(cause, t('无法下载或安装应用更新', 'Unable to download or install the app update'), language))
    } finally {
      setUpdateAction(null)
    }
  }, [acceptUpdateState, api, language, snapshot, t])

  const installUpdate = useCallback(async () => {
    if (snapshot && snapshot.gatewayStatus.activeRequests > 0) {
      const confirmed = window.confirm(t(
        `当前仍有 ${snapshot.gatewayStatus.activeRequests} 个活跃请求。更新会关闭 Stone+ 并中断这些请求，是否继续？`,
        `${snapshot.gatewayStatus.activeRequests} active request(s) are still running. The update will close Stone+ and interrupt them. Continue?`,
      ))
      if (!confirmed) return
    }
    setUpdateAction('install')
    setUpdateError(null)
    try {
      await api.installUpdate()
    } catch (cause) {
      setUpdateError(localizedError(cause, t('无法安装应用更新', 'Unable to install the app update'), language))
      setUpdateAction(null)
    }
  }, [api, language, snapshot, t])

  const openUpdatePage = useCallback(async () => {
    setUpdateAction('open-page')
    setUpdateError(null)
    try {
      await api.openUpdatePage()
    } catch (cause) {
      setUpdateError(localizedError(cause, t('无法打开 GitHub Releases', 'Unable to open GitHub Releases'), language))
    } finally {
      setUpdateAction(null)
    }
  }, [api, language, t])

  const updateController = useMemo<AppUpdateController>(() => ({
    state: updateState,
    action: updateAction,
    error: updateError,
    openDialog: () => setUpdateDialogOpen(true),
    check: checkForUpdates,
    ignore: ignoreUpdate,
    download: downloadUpdate,
    install: installUpdate,
    openPage: openUpdatePage,
  }), [checkForUpdates, downloadUpdate, ignoreUpdate, installUpdate, openUpdatePage, updateAction, updateError, updateState])

  const lifecycleAgents = useMemo(
    () => agentLifecycleSnapshot ? Object.values(agentLifecycleSnapshot.agents) : [],
    [agentLifecycleSnapshot],
  )
  const snapshotAccounts = snapshot?.accounts
  const accountQuota = useMemo(
    () => snapshotAccounts ? summarizeAccountQuota(snapshotAccounts) : null,
    [snapshotAccounts],
  )
  const pageSnapshot = useMemo(() => {
    if (!snapshot) return null
    const previous = activePageSnapshot.current
    if (!previous || previous.page !== page || appSnapshotAffectsPage(page, previous.snapshot, snapshot)) {
      activePageSnapshot.current = { page, snapshot }
    }
    return activePageSnapshot.current?.snapshot ?? snapshot
  }, [page, snapshot])

  if (!snapshot || !pageSnapshot) {
    return (
      <>
        <LoadingScreen />
        {error && (
          <div className="boot-error">
            <span>{error}</span>
            <button className="button button--secondary" type="button" onClick={() => void load()}>
              <RefreshCw size={16} /> {t('重试', 'Retry')}
            </button>
          </div>
        )}
      </>
    )
  }

  const gatewayBusy = busyKeys.has('gateway-power')
  const endpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)
  const accountQuotaPercent = accountQuota ? Math.round(accountQuota.percent) : undefined
  const updateReleaseVisible = Boolean(
    updateState?.release
    && updateState.ignoredVersion !== updateState.release.version
    && (
      updateState.status === 'available'
      || updateState.status === 'downloading'
      || updateState.status === 'downloaded'
      || updateState.status === 'installing'
      || updateState.status === 'error'
    )
  )

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      {mobileNavOpen && <button className="nav-scrim" type="button" aria-label={t('关闭导航', 'Close navigation')} onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <StoneMark />
          <div className="sidebar__brand-text">
            <div className="sidebar__brand-title">
              <strong>Stone+</strong>
              {updateReleaseVisible && (
                <button
                  className="brand-update-link"
                  type="button"
                  title={t(`更新到 v${updateState?.release?.version}`, `Update to v${updateState?.release?.version}`)}
                  onClick={() => setUpdateDialogOpen(true)}
                >
                  {t('更新', 'Update')}
                </button>
              )}
            </div>
            <span>Local Gateway</span>
          </div>
          <button className="icon-button sidebar__mobile-close" type="button" onClick={() => setMobileNavOpen(false)} title={t('关闭导航', 'Close navigation')}>
            <X size={18} />
          </button>
        </div>

        <div
          className={`sidebar-quota ${accountQuota ? '' : 'sidebar-quota--empty'}`}
          title={accountQuota ? t(`${accountQuota.accountCount} 个可用账号 · 总体剩余额度 ${accountQuotaPercent}%`, `${accountQuota.accountCount} available account(s) · ${accountQuotaPercent}% quota remaining overall`) : t('暂无可统计的账号额度', 'No account quota data available')}
          aria-label={accountQuota ? t(`总体剩余额度 ${accountQuotaPercent}%`, `${accountQuotaPercent}% quota remaining overall`) : t('总体剩余额度未知', 'Overall remaining quota unknown')}
        >
          <span className="sidebar-quota__label">{t('额度', 'Quota')}</span>
          <span className="sidebar-quota__track" aria-hidden="true">
            <i style={{ width: `${accountQuotaPercent ?? 0}%` }} />
          </span>
          <strong>{accountQuotaPercent === undefined ? '—' : `${accountQuotaPercent}%`}</strong>
        </div>

        <nav className="sidebar__nav" aria-label={t('主导航', 'Main navigation')}>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={`nav-item ${page === item.id ? 'nav-item--active' : ''}`}
                key={item.id}
                type="button"
                title={sidebarCollapsed ? t(item.label[0], item.label[1]) : undefined}
                onClick={() => setActivePage(item.id)}
              >
                <Icon size={18} />
                <span>{t(item.label[0], item.label[1])}</span>
                {item.id === 'requests' && snapshot.gatewayStatus.activeRequests > 0 && (
                  <span className="nav-count">{snapshot.gatewayStatus.activeRequests}</span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="sidebar__footer">
          <button
            className={`nav-item sidebar-help ${page === 'help' ? 'nav-item--active' : ''}`}
            type="button"
            title={sidebarCollapsed ? t('帮助与下一步', 'Help & Next Steps') : undefined}
            aria-current={page === 'help' ? 'page' : undefined}
            onClick={() => setActivePage('help')}
          >
            <CircleHelp size={18} />
            <span>{t('帮助与下一步', 'Help & Next Steps')}</span>
          </button>
          <button className="sidebar-collapse" type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')}>
            <ChevronLeft size={17} />
            <span>{sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')}</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__left">
            <button className="icon-button topbar__menu" type="button" onClick={() => setMobileNavOpen(true)} title={t('打开导航', 'Open navigation')}>
              <Menu size={19} />
            </button>
            <div className="gateway-state">
              <span className={`status-dot ${snapshot.gatewayStatus.running ? 'status-dot--online status-dot--pulse' : ''}`} />
              <div>
                <strong>{snapshot.gatewayStatus.running ? t('网关运行中', 'Gateway running') : t('网关已停止', 'Gateway stopped')}</strong>
                <span className="mono">{endpoint}</span>
              </div>
            </div>
          </div>

          <div className="topbar__right">
            {(page === 'overview' || page === 'providers') && (
              <button className="button button--secondary topbar__setup" type="button" onClick={() => setActivePage('setup')}>
                <Play size={15} />{t('配置向导', 'Setup Wizard')}
              </button>
            )}
            {snapshot.gatewayStatus.running && (
              <div className="active-request-indicator" title={t('当前活跃请求', 'Active requests')}>
                <Activity size={15} />
                <span>{t(`${snapshot.gatewayStatus.activeRequests} 个活跃请求`, `${snapshot.gatewayStatus.activeRequests} active request(s)`)}</span>
              </div>
            )}
            <button
              className={`button ${snapshot.gatewayStatus.running ? 'button--stop' : 'button--primary'}`}
              type="button"
              disabled={gatewayBusy}
              onClick={() =>
                void runAction('gateway-power', () =>
                  snapshot.gatewayStatus.running ? api.stopGateway() : api.startGateway(),
                )
              }
            >
              {gatewayBusy ? <RefreshCw size={16} className="spin" /> : snapshot.gatewayStatus.running ? <Square size={14} /> : <Play size={16} />}
              {snapshot.gatewayStatus.running ? t('停止', 'Stop') : t('启动', 'Start')}
            </button>
            {agentLifecycleSnapshot && (
              <MemoAgentLifecycleControl
                agents={lifecycleAgents}
                lastOperation={lastAgentOperation}
                operationPending={agentOperationPending}
                onRequestRefresh={refreshAgentLifecycle}
                onAction={runAgentAction}
                onRepair={repairAllAgents}
                onCloseAll={closeAllAgents}
                onOpenClientConfiguration={openClientConfiguration}
              />
            )}
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <div><Power size={16} /><span>{error}</span></div>
            <button type="button" className="icon-button" title={t('关闭', 'Close')} onClick={() => setError(null)}><X size={16} /></button>
          </div>
        )}

        <main className="page-content" onScroll={revealContentScrollbar}>
          <ActivePage
            page={page}
            snapshot={pageSnapshot}
            api={api}
            runAction={runAction}
            busyKeys={busyKeys}
            update={updateController}
            navigate={setActivePage}
          />
        </main>
      </div>
      <UpdateDialog
        open={updateDialogOpen}
        state={updateState}
        action={updateAction}
        actionError={updateError}
        onClose={() => setUpdateDialogOpen(false)}
        onCheck={checkForUpdates}
        onIgnore={ignoreUpdate}
        onDownload={downloadUpdate}
        onInstall={installUpdate}
        onOpenPage={openUpdatePage}
      />
    </div>
  )
}
