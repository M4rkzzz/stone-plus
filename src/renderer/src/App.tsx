import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Boxes,
  ChevronLeft,
  CircleGauge,
  Menu,
  MonitorCog,
  Network,
  Play,
  Power,
  RefreshCw,
  Route as RouteIcon,
  Share2,
  Settings,
  Wrench,
  Square,
  X,
} from 'lucide-react'
import type { AppSnapshot, AppUpdateState } from '@shared/types'
import { getGatewayApi } from './api'
import { OverviewView } from './views/OverviewView'
import { ProvidersView } from './views/ProvidersView'
import { PoolsView } from './views/PoolsView'
import { RoutesView } from './views/RoutesView'
import { RequestsView } from './views/RequestsView'
import { SettingsView } from './views/SettingsView'
import { ClientsView } from './views/ClientsView'
import { TunnelView } from './views/TunnelView'
import { SessionRepairView } from './views/SessionRepairView'
import { gatewayBaseUrl } from './ui'
import { StoneMark } from './StoneMark'
import {
  UpdateBanner,
  UpdateDialog,
  type AppUpdateController,
  type UpdateAction,
} from './UpdateDialog'

export type PageId = 'overview' | 'providers' | 'pools' | 'routes' | 'clients' | 'session-repair' | 'tunnel' | 'requests' | 'settings'
export type ActionRunner = (key: string, operation: () => Promise<AppSnapshot>) => Promise<boolean>

const navigation: Array<{ id: PageId; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '总览', icon: CircleGauge },
  { id: 'providers', label: '供应商', icon: Boxes },
  { id: 'pools', label: '号池', icon: Network },
  { id: 'routes', label: '路由', icon: RouteIcon },
  { id: 'clients', label: '客户端', icon: MonitorCog },
  { id: 'session-repair', label: '会话修复', icon: Wrench },
  { id: 'tunnel', label: '内网穿透', icon: Share2 },
  { id: 'requests', label: '请求', icon: Activity },
  { id: 'settings', label: '设置', icon: Settings },
]

function pageFromHash(): PageId {
  const candidate = window.location.hash.slice(1) as PageId
  return navigation.some((item) => item.id === candidate) ? candidate : 'overview'
}

function LoadingScreen() {
  return (
    <div className="boot-screen">
      <StoneMark />
      <RefreshCw size={20} className="spin" />
      <p>正在连接本地网关…</p>
    </div>
  )
}

export default function App() {
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
  const updateRevision = useRef(-1)

  const acceptUpdateState = useCallback((next: AppUpdateState) => {
    if (next.revision <= updateRevision.current) return
    updateRevision.current = next.revision
    setUpdateState(next)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      setSnapshot(await api.getSnapshot())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接本地服务')
    }
  }, [api])

  useEffect(() => {
    void load()
    return api.onSnapshot(setSnapshot)
  }, [api, load])

  useEffect(() => {
    const unsubscribe = api.onUpdateState(acceptUpdateState)
    void api.getUpdateState()
      .then(acceptUpdateState)
      .catch((cause: unknown) => setUpdateError(cause instanceof Error ? cause.message : '无法读取应用更新状态'))
    return unsubscribe
  }, [acceptUpdateState, api])

  useEffect(() => {
    if (
      updateState?.status === 'available'
      && updateState.release
      && updateState.ignoredVersion !== updateState.release.version
    ) {
      setUpdateDialogOpen(true)
    }
  }, [updateState])

  useEffect(() => {
    const handleHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  const runAction: ActionRunner = useCallback(async (key, operation) => {
    setBusyKeys((current) => new Set(current).add(key))
    setError(null)
    try {
      setSnapshot(await operation())
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试')
      return false
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  const setActivePage = (id: PageId) => {
    setPage(id)
    window.history.replaceState(null, '', `#${id}`)
    setMobileNavOpen(false)
  }

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
      setUpdateError(cause instanceof Error ? cause.message : '应用更新操作失败')
      return undefined
    } finally {
      setUpdateAction(null)
    }
  }, [acceptUpdateState])

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
    await runUpdateStateOperation('download', () => api.downloadUpdate())
  }, [api, runUpdateStateOperation])

  const installUpdate = useCallback(async () => {
    if (snapshot && snapshot.gatewayStatus.activeRequests > 0) {
      const confirmed = window.confirm(`当前仍有 ${snapshot.gatewayStatus.activeRequests} 个活跃请求。更新会关闭 Stone 并中断这些请求，是否继续？`)
      if (!confirmed) return
    }
    setUpdateAction('install')
    setUpdateError(null)
    try {
      await api.installUpdate()
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : '无法安装应用更新')
      setUpdateAction(null)
    }
  }, [api, snapshot])

  const openUpdatePage = useCallback(async () => {
    setUpdateAction('open-page')
    setUpdateError(null)
    try {
      await api.openUpdatePage()
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : '无法打开 GitHub Releases')
    } finally {
      setUpdateAction(null)
    }
  }, [api])

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

  if (!snapshot) {
    return (
      <>
        <LoadingScreen />
        {error && (
          <div className="boot-error">
            <span>{error}</span>
            <button className="button button--secondary" type="button" onClick={() => void load()}>
              <RefreshCw size={16} /> 重试
            </button>
          </div>
        )}
      </>
    )
  }

  const gatewayBusy = busyKeys.has('gateway-power')
  const endpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      {mobileNavOpen && <button className="nav-scrim" type="button" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <StoneMark />
          <div className="sidebar__brand-text">
            <strong>Stone+</strong>
            <span>Local Gateway</span>
          </div>
          <button className="icon-button sidebar__mobile-close" type="button" onClick={() => setMobileNavOpen(false)} title="关闭导航">
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={`nav-item ${page === item.id ? 'nav-item--active' : ''}`}
                key={item.id}
                type="button"
                title={sidebarCollapsed ? item.label : undefined}
                onClick={() => setActivePage(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id === 'requests' && snapshot.gatewayStatus.activeRequests > 0 && (
                  <span className="nav-count">{snapshot.gatewayStatus.activeRequests}</span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="sidebar__footer">
          <div className="vault-indicator" title={`凭据存储：${snapshot.vaultBackend}`}>
            <span className={`status-dot ${snapshot.vaultAvailable ? 'status-dot--online' : 'status-dot--error'}`} />
            <span>{snapshot.vaultAvailable ? '凭据保险库可用' : '凭据保险库不可用'}</span>
          </div>
          <button className="sidebar-collapse" type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
            <ChevronLeft size={17} />
            <span>收起侧栏</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__left">
            <button className="icon-button topbar__menu" type="button" onClick={() => setMobileNavOpen(true)} title="打开导航">
              <Menu size={19} />
            </button>
            <div className="gateway-state">
              <span className={`status-dot ${snapshot.gatewayStatus.running ? 'status-dot--online status-dot--pulse' : ''}`} />
              <div>
                <strong>{snapshot.gatewayStatus.running ? '网关运行中' : '网关已停止'}</strong>
                <span className="mono">{endpoint}</span>
              </div>
            </div>
          </div>

          <div className="topbar__right">
            {snapshot.gatewayStatus.running && (
              <div className="active-request-indicator" title="当前活跃请求">
                <Activity size={15} />
                <span>{snapshot.gatewayStatus.activeRequests} 个活跃请求</span>
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
              {snapshot.gatewayStatus.running ? '停止' : '启动'}
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <div><Power size={16} /><span>{error}</span></div>
            <button type="button" className="icon-button" title="关闭" onClick={() => setError(null)}><X size={16} /></button>
          </div>
        )}

        {updateState && (
          <UpdateBanner
            state={updateState}
            action={updateAction}
            onOpen={() => setUpdateDialogOpen(true)}
            onCheck={checkForUpdates}
            onIgnore={ignoreUpdate}
            onDownload={downloadUpdate}
            onInstall={installUpdate}
            onOpenPage={openUpdatePage}
          />
        )}

        <main className="page-content">
          {page === 'overview' && <OverviewView snapshot={snapshot} navigate={setActivePage} />}
          {page === 'providers' && <ProvidersView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />}
          {page === 'pools' && <PoolsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />}
          {page === 'routes' && <RoutesView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />}
          {page === 'clients' && <ClientsView snapshot={snapshot} api={api} />}
          {page === 'session-repair' && <SessionRepairView api={api} />}
          {page === 'tunnel' && <TunnelView snapshot={snapshot} api={api} />}
          {page === 'requests' && <RequestsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />}
          {page === 'settings' && <SettingsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} update={updateController} />}
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
