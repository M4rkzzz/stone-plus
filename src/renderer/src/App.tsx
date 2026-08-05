import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import {
  Activity,
  ArrowUp,
  Boxes,
  ChevronLeft,
  CircleGauge,
  Globe2,
  History,
  CircleHelp,
  Menu,
  MonitorCog,
  Network,
  Play,
  Power,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Share2,
  Settings,
  Sparkles,
  Stethoscope,
  Wrench,
  Waypoints,
  Square,
  X,
} from 'lucide-react'
import type { AppSnapshot, AppUpdateState, GatewayApi } from '@shared/types'
import type {
  AgentLifecycleOperationResult,
  AgentLifecycleProgressEvent,
  AgentLifecycleSnapshot,
  AgentTarget,
} from '@shared/agent-lifecycle'
import { listRouteSources } from '@shared/route-sources'
import { getGatewayApi } from './api'
import { OverviewView } from './views/OverviewView'
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
import { PageErrorBoundary } from './page-error-boundary'
import { QuickNavigation } from './quick-navigation'
import type { QuickNavigationItem } from './quick-navigation-model'
import {
  OperationCenter,
  OperationToast,
  operationLabelForKey,
  operationShouldNotify,
  type OperationRecord,
  type OperationStatus,
} from './operation-center'

export type PageId = 'overview' | 'setup' | 'providers' | 'proxies' | 'pools' | 'routes' | 'clients' | 'session-repair' | 'tunnel' | 'browser' | 'diagnostics' | 'requests' | 'settings' | 'help'
export type ActionRunner = (key: string, operation: () => Promise<AppSnapshot>) => Promise<boolean>

const loadSetupWizardView = () => import('./views/SetupWizardView')
const loadProvidersView = () => import('./views/ProvidersView')
const loadProxyView = () => import('./views/ProxyView')
const loadPoolsView = () => import('./views/PoolsView')
const loadRoutesView = () => import('./views/RoutesView')
const loadClientsView = () => import('./views/ClientsView')
const loadSessionRepairView = () => import('./views/SessionRepairView')
const loadTunnelView = () => import('./views/TunnelView')
const loadBrowserView = () => import('./views/BrowserView')
const loadNetworkTestView = () => import('./views/NetworkTestView')
const loadRequestsView = () => import('./views/RequestsView')
const loadSettingsView = () => import('./views/SettingsView')
const loadHelpView = () => import('./views/HelpView')

const LazySetupWizardView = lazy(() => loadSetupWizardView().then((module) => ({ default: module.SetupWizardView })))
const LazyProvidersView = lazy(() => loadProvidersView().then((module) => ({ default: module.ProvidersView })))
const LazyProxyView = lazy(() => loadProxyView().then((module) => ({ default: module.ProxyView })))
const LazyPoolsView = lazy(() => loadPoolsView().then((module) => ({ default: module.PoolsView })))
const LazyRoutesView = lazy(() => loadRoutesView().then((module) => ({ default: module.RoutesView })))
const LazyClientsView = lazy(() => loadClientsView().then((module) => ({ default: module.ClientsView })))
const LazySessionRepairView = lazy(() => loadSessionRepairView().then((module) => ({ default: module.SessionRepairView })))
const LazyTunnelView = lazy(() => loadTunnelView().then((module) => ({ default: module.TunnelView })))
const LazyBrowserView = lazy(() => loadBrowserView().then((module) => ({ default: module.BrowserView })))
const LazyNetworkTestView = lazy(() => loadNetworkTestView().then((module) => ({ default: module.NetworkTestView })))
const LazyRequestsView = lazy(() => loadRequestsView().then((module) => ({ default: module.RequestsView })))
const LazySettingsView = lazy(() => loadSettingsView().then((module) => ({ default: module.SettingsView })))
const LazyHelpView = lazy(() => loadHelpView().then((module) => ({ default: module.HelpView })))

const pagePreloaders: Partial<Record<PageId, () => Promise<unknown>>> = {
  setup: loadSetupWizardView,
  providers: loadProvidersView,
  proxies: loadProxyView,
  pools: loadPoolsView,
  routes: loadRoutesView,
  clients: loadClientsView,
  'session-repair': loadSessionRepairView,
  tunnel: loadTunnelView,
  browser: loadBrowserView,
  diagnostics: loadNetworkTestView,
  requests: loadRequestsView,
  settings: loadSettingsView,
  help: loadHelpView,
}

function preloadAppPage(page: PageId): void {
  void pagePreloaders[page]?.().catch(() => undefined)
}

function localizedError(cause: unknown, fallback: string, language: 'zh-CN' | 'en'): string {
  if (!(cause instanceof Error)) return fallback
  return language === 'en' && /[\u3400-\u9fff]/u.test(cause.message) ? fallback : cause.message
}

function agentLifecycleProgressStageLabel(
  stage: AgentLifecycleProgressEvent['stage'],
  language: 'zh-CN' | 'en',
): string {
  const labels: Record<AgentLifecycleProgressEvent['stage'], readonly [string, string]> = {
    discover: ['发现会话文件', 'Discovering session files'],
    scan: ['扫描会话', 'Scanning sessions'],
    verify: ['复核变更', 'Verifying changes'],
    backup: ['创建恢复点', 'Creating restore point'],
    apply: ['安全写入', 'Applying safely'],
  }
  return labels[stage][language === 'zh-CN' ? 0 : 1]
}

const desktopTunnelSupported = !window.stone || window.stonePlatform === 'win32'

const allNavigation: Array<QuickNavigationItem<PageId>> = [
  { id: 'overview', label: ['总览', 'Overview'], description: ['查看运行状态、额度、请求和健康概况', 'See gateway status, quota, requests, and health'], keywords: ['主页 状态 健康 额度', 'home status health quota'], icon: CircleGauge },
  { id: 'providers', label: ['账号与中转', 'Accounts & Relays'], description: ['管理 OpenAI、Grok 账号、官方 API 和中转站', 'Manage OpenAI and Grok accounts, official APIs, and relays'], keywords: ['账户 key 密钥 oauth api 中转 导入', 'account key oauth api relay import'], icon: Boxes },
  { id: 'proxies', label: ['代理', 'Proxies'], description: ['管理外部代理、订阅节点和内置代理接管', 'Manage external proxies, subscriptions, nodes, and built-in takeover'], keywords: ['系统代理 sing-box clash tun 节点 订阅', 'system proxy sing-box clash tun node subscription'], icon: Waypoints },
  { id: 'pools', label: ['号池', 'Pools'], description: ['组合来源并设置轮换、粘性、并发和重试', 'Combine sources and configure rotation, stickiness, concurrency, and retries'], keywords: ['聚合 轮询 负载均衡 并发', 'aggregate rotation load balance concurrency'], icon: Network },
  { id: 'routes', label: ['路由', 'Routes'], description: ['为 Codex、Claude、Gemini 和 Grok Build 选择上游', 'Choose upstreams for Codex, Claude, Gemini, and Grok Build'], keywords: ['模型 映射 协议 来源 客户端', 'model mapping protocol source client'], icon: RouteIcon },
  { id: 'clients', label: ['客户端配置', 'Client Configuration'], description: ['一键连接、修复、启动并管理 AI 客户端', 'Connect, repair, launch, and manage AI clients'], keywords: ['codex claude gemini grok vscode desktop cli 启动 配置', 'codex claude gemini grok vscode desktop cli launch config'], icon: MonitorCog },
  { id: 'session-repair', label: ['会话修复', 'Session Repair'], description: ['检查并修复会话索引、记录和残留状态', 'Inspect and repair session indexes, records, and stale state'], keywords: ['对话 恢复 历史 索引', 'conversation recovery history index'], icon: Wrench },
  { id: 'tunnel', label: ['内网穿透', 'Tunnel'], description: ['配置 FRP，将本地网关提供给远端设备', 'Configure FRP access to the local gateway from remote devices'], keywords: ['frp frpc 远程 公网', 'frp frpc remote public network'], icon: Share2 },
  { id: 'browser', label: ['内置浏览器', 'Built-in Browser'], description: ['在 Stone+ 内完成登录、授权和账号导入', 'Complete sign-in, authorization, and account imports inside Stone+'], keywords: ['登录 网页 oauth 导入 cookie', 'login web oauth import cookie'], icon: Globe2 },
  { id: 'diagnostics', label: ['诊断', 'Diagnostics'], description: ['测试网关、代理、DNS、TLS 和上游连通性', 'Test gateway, proxy, DNS, TLS, and upstream connectivity'], keywords: ['网络 检测 故障 测试 证书', 'network test troubleshoot certificate'], icon: Stethoscope },
  { id: 'requests', label: ['请求记录', 'Request Logs'], description: ['查看实时请求、延迟、Token、费用和错误', 'Inspect live requests, latency, tokens, cost, and errors'], keywords: ['日志 统计 流量 费用 失败', 'log statistics traffic cost failure'], icon: Activity },
  { id: 'settings', label: ['设置', 'Settings'], description: ['调整网关、主题、备份、更新和高级选项', 'Configure gateway, themes, backups, updates, and advanced options'], keywords: ['偏好 端口 深色 语言 更新 备份', 'preferences port dark language update backup'], icon: Settings },
]

const navigation = allNavigation.filter((item) => desktopTunnelSupported || item.id !== 'tunnel')
const auxiliaryNavigation: Array<QuickNavigationItem<PageId>> = [
  { id: 'setup', label: ['配置向导', 'Setup Wizard'], description: ['按步骤完成来源、号池、路由和客户端连接', 'Configure sources, pools, routes, and client connections step by step'], keywords: ['首次 新手 引导 开始', 'first run onboarding guide start'], icon: Play },
  { id: 'help', label: ['帮助与下一步', 'Help & Next Steps'], description: ['按功能、现象或错误码查找解决方案', 'Find solutions by feature, symptom, or error code'], keywords: ['文档 教程 faq 问题', 'docs guide faq problem'], icon: CircleHelp },
]
const quickNavigationItems = [...navigation, ...auxiliaryNavigation]
const quickNavigationPageIds = new Set<string>(quickNavigationItems.map((item) => item.id))

function isPageId(value: string): value is PageId {
  return quickNavigationPageIds.has(value)
}

function pageFromHash(): PageId {
  const candidate = window.location.hash.slice(1) as PageId
  return candidate === 'setup' || candidate === 'help' || navigation.some((item) => item.id === candidate) ? candidate : 'overview'
}

const SETUP_AUTO_SHOWN_STORAGE_KEY = 'stone.setup.auto-shown.v1'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'stone.sidebar.collapsed.v1'
const RECENT_PAGES_STORAGE_KEY = 'stone.navigation.recent.v1'
const MOBILE_NAVIGATION_QUERY = '(max-width: 780px)'

function storedBoolean(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function storedRecentPages(): PageId[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_PAGES_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    const valid = new Set(quickNavigationItems.map((item) => item.id))
    return value.filter((id): id is PageId => typeof id === 'string' && valid.has(id as PageId)).slice(0, 5)
  } catch {
    return []
  }
}
const mobileSidebarFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function mobileSidebarFocusables(sidebar: HTMLElement): HTMLElement[] {
  return Array.from(sidebar.querySelectorAll<HTMLElement>(mobileSidebarFocusableSelector))
    .filter((element) => !element.closest('[inert], [hidden], [aria-hidden="true"]'))
}

function focusMobileSidebarElement(element: HTMLElement | undefined): void {
  if (!element) return
  try {
    element.focus({ preventScroll: true })
  } catch {
    element.focus()
  }
}

function trapMobileSidebarTabKey(event: KeyboardEvent, sidebar: HTMLElement): void {
  if (event.key !== 'Tab') return
  const focusable = mobileSidebarFocusables(sidebar)
  if (!focusable.length) {
    event.preventDefault()
    focusMobileSidebarElement(sidebar)
    return
  }
  const activeIndex = focusable.findIndex((element) => element === sidebar.ownerDocument.activeElement)
  if (activeIndex < 0 || (event.shiftKey ? activeIndex === 0 : activeIndex === focusable.length - 1)) {
    event.preventDefault()
    focusMobileSidebarElement(event.shiftKey ? focusable[focusable.length - 1] : focusable[0])
  }
}

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

function PageLoadingScreen() {
  const { t } = useI18n()
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <RefreshCw size={18} className="spin" />
      <span>{t('正在加载页面…', 'Loading page…')}</span>
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
  if (page === 'overview') return <OverviewView snapshot={snapshot} api={api} navigate={navigate} />
  if (page === 'setup') return <LazySetupWizardView snapshot={snapshot} api={api} onExit={() => navigate('overview')} />
  if (page === 'providers') return <LazyProvidersView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'proxies') return <LazyProxyView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'pools') return <LazyPoolsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'routes') return <LazyRoutesView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'clients') return <LazyClientsView snapshot={snapshot} api={api} />
  if (page === 'session-repair') return <LazySessionRepairView api={api} />
  if (page === 'tunnel' && desktopTunnelSupported) return <LazyTunnelView snapshot={snapshot} api={api} />
  if (page === 'browser') return <LazyBrowserView snapshot={snapshot} api={api} />
  if (page === 'diagnostics') return <LazyNetworkTestView snapshot={snapshot} api={api} />
  if (page === 'requests') return <LazyRequestsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
  if (page === 'settings') return <LazySettingsView snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} update={update} />
  if (page === 'help') return <LazyHelpView snapshot={snapshot} api={api} navigate={navigate} />
  return null
})

const MemoAgentLifecycleControl = memo(AgentLifecycleControl)

export default function App() {
  const { t, language } = useI18n()
  const api = useMemo(() => getGatewayApi(), [])
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia?.(MOBILE_NAVIGATION_QUERY).matches ?? false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storedBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY))
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [operationCenterOpen, setOperationCenterOpen] = useState(false)
  const [operationRecords, setOperationRecords] = useState<OperationRecord[]>([])
  const [operationToast, setOperationToast] = useState<OperationRecord>()
  const [recentPages, setRecentPages] = useState<PageId[]>(storedRecentPages)
  const [backToTopVisible, setBackToTopVisible] = useState(false)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateAction, setUpdateAction] = useState<UpdateAction | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [agentLifecycleSnapshot, setAgentLifecycleSnapshot] = useState<AgentLifecycleSnapshot | null>(null)
  const [lastAgentOperation, setLastAgentOperation] = useState<AgentLifecycleOperationResult | undefined>()
  const [agentOperationPending, setAgentOperationPending] = useState(false)
  const [agentProgress, setAgentProgress] = useState<AgentLifecycleProgressEvent | null>(null)
  const [agentCancellableOperationId, setAgentCancellableOperationId] = useState<string | null>(null)
  const [agentCancelPending, setAgentCancelPending] = useState(false)
  const updateRevision = useRef(-1)
  const runtimeRevision = useRef(-1)
  const agentLifecycleRevision = useRef(-1)
  const agentLifecycleRenderState = useRef<string | undefined>(undefined)
  const agentOperationInFlight = useRef(false)
  const agentOperationIdRef = useRef<string | null>(null)
  const agentLifecycleRefreshInFlight = useRef<Promise<void> | null>(null)
  const activePageSnapshot = useRef<{ page: PageId; snapshot: AppSnapshot } | undefined>(undefined)
  const scrollbarHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pageContentRef = useRef<HTMLElement>(null)
  const backToTopVisibleRef = useRef(false)
  const mobileSidebarRef = useRef<HTMLElement>(null)
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null)
  const operationSequence = useRef(0)

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

  useEffect(() => api.onAgentLifecycleProgress((progress) => {
    if (progress.operationId !== agentOperationIdRef.current) return
    setAgentProgress(progress)
    const stage = agentLifecycleProgressStageLabel(progress.stage, language)
    const count = progress.total === undefined
      ? `${progress.completed}`
      : `${progress.completed}/${progress.total}`
    setOperationRecords((current) => current.map((record) => record.id === progress.operationId
      ? { ...record, message: `${stage} · ${count}` }
      : record))
  }), [api, language])

  useEffect(() => {
    const handleHashChange = () => {
      setPage(pageFromHash())
      setMobileNavOpen(false)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    const handleQuickNavigationShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLocaleLowerCase() !== 'k') return
      event.preventDefault()
      if (!quickNavigationOpen && document.querySelector('.modal-backdrop')) return
      setQuickNavigationOpen((current) => !current)
    }
    document.addEventListener('keydown', handleQuickNavigationShortcut)
    return () => document.removeEventListener('keydown', handleQuickNavigationShortcut)
  }, [quickNavigationOpen])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed))
    } catch {
      // The UI remains usable when local storage is unavailable.
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    pageContentRef.current?.scrollTo({ top: 0, left: 0 })
    backToTopVisibleRef.current = false
    setBackToTopVisible(false)
    setRecentPages((current) => {
      if (current[0] === page) return current
      const next = [page, ...current.filter((id) => id !== page)].slice(0, 5)
      try {
        window.localStorage.setItem(RECENT_PAGES_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Recent navigation is an optional convenience only.
      }
      return next
    })
  }, [page])

  useEffect(() => {
    const media = window.matchMedia?.(MOBILE_NAVIGATION_QUERY)
    if (!media) return
    const syncLayout = () => {
      setMobileLayout(media.matches)
      if (!media.matches) setMobileNavOpen(false)
    }
    syncLayout()
    media.addEventListener('change', syncLayout)
    return () => media.removeEventListener('change', syncLayout)
  }, [])

  useEffect(() => {
    if (!mobileLayout || !mobileNavOpen) return
    const sidebar = mobileSidebarRef.current
    if (!sidebar) return
    const restoreFocusTo = mobileNavTriggerRef.current
    const closeNavigation = () => setMobileNavOpen(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeNavigation()
        return
      }
      trapMobileSidebarTabKey(event, sidebar)
    }
    document.addEventListener('keydown', handleKeyDown)
    focusMobileSidebarElement(sidebar.querySelector<HTMLElement>('[data-mobile-sidebar-initial-focus]') ?? mobileSidebarFocusables(sidebar)[0] ?? sidebar)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      queueMicrotask(() => {
        if (window.matchMedia?.(MOBILE_NAVIGATION_QUERY).matches && restoreFocusTo?.isConnected) {
          focusMobileSidebarElement(restoreFocusTo)
        }
      })
    }
  }, [mobileLayout, mobileNavOpen])

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

  const beginOperation = useCallback((key: string): string => {
    const id = `${Date.now()}-${operationSequence.current += 1}`
    const record: OperationRecord = {
      id,
      key,
      label: operationLabelForKey(key, language),
      status: 'running',
      startedAt: Date.now(),
    }
    setOperationRecords((current) => [record, ...current].slice(0, 20))
    return id
  }, [language])

  const finishOperation = useCallback((id: string, key: string, status: Exclude<OperationStatus, 'running'>, message?: string) => {
    const completedAt = Date.now()
    let completed: OperationRecord = {
      id,
      key,
      label: operationLabelForKey(key, language),
      status,
      startedAt: completedAt,
      completedAt,
      message,
    }
    setOperationRecords((current) => current.map((record) => {
      if (record.id !== id) return record
      completed = { ...record, status, completedAt, message }
      return completed
    }))
    if (operationShouldNotify(key, status)) setOperationToast(completed)
  }, [language])

  useEffect(() => {
    if (!operationToast) return
    const timer = window.setTimeout(() => setOperationToast(undefined), operationToast.status === 'error' ? 6000 : 3200)
    return () => window.clearTimeout(timer)
  }, [operationToast])

  const runAction: ActionRunner = useCallback(async (key, operation) => {
    const operationId = beginOperation(key)
    setBusyKeys((current) => new Set(current).add(key))
    setError(null)
    try {
      acceptSnapshot(await operation())
      finishOperation(operationId, key, 'success')
      return true
    } catch (cause) {
      const message = localizedError(cause, t('操作失败，请稍后重试', 'The operation failed. Please try again later.'), language)
      setError(message)
      finishOperation(operationId, key, 'error', message)
      return false
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [acceptSnapshot, beginOperation, finishOperation, language, t])

  const runAgentLifecycle = useCallback(async (
    operation: (operationId: string) => Promise<AgentLifecycleOperationResult>,
    operationKey = 'agent-operation',
    cancellable = false,
  ) => {
    if (agentOperationInFlight.current) return
    const operationId = beginOperation(operationKey)
    agentOperationInFlight.current = true
    agentOperationIdRef.current = operationId
    setAgentOperationPending(true)
    setAgentProgress(null)
    setAgentCancelPending(false)
    setAgentCancellableOperationId(cancellable ? operationId : null)
    setError(null)
    try {
      const result = await operation(operationId)
      setLastAgentOperation(result)
      acceptAgentLifecycleSnapshot(result.snapshot)
      if (result.status === 'succeeded' || result.status === 'no-op') {
        finishOperation(operationId, operationKey, 'success')
      } else {
        const firstError = result.results.find((entry) => entry.error)?.error
        const cancelled = result.results.some((entry) => entry.error?.code === 'cancelled')
          && result.results.every((entry) => entry.status === 'skipped' || entry.error?.code === 'cancelled')
        const message = cancelled
          ? t('操作已安全取消，已写入内容已回滚', 'Operation safely cancelled; written changes were rolled back')
          : firstError?.message ?? t('Agent 操作未完整完成', 'Agent operation did not complete')
        if (!cancelled) setError(message)
        finishOperation(operationId, operationKey, 'error', message)
      }
    } catch (cause) {
      const message = localizedError(cause, t('Agent 操作失败', 'Agent operation failed'), language)
      setError(message)
      finishOperation(operationId, operationKey, 'error', message)
    } finally {
      agentOperationInFlight.current = false
      if (agentOperationIdRef.current === operationId) agentOperationIdRef.current = null
      setAgentOperationPending(false)
      setAgentProgress(null)
      setAgentCancellableOperationId(null)
      setAgentCancelPending(false)
    }
  }, [acceptAgentLifecycleSnapshot, beginOperation, finishOperation, language, t])

  const runAgentAction = useCallback((target: AgentTarget, action: AgentLifecycleControlAction) => {
    const operation = action === 'close'
      ? () => api.closeAgent(target)
      : action === 'restore'
        ? (operationId: string) => api.restoreAgent(target, { ensureRunning: true }, operationId)
        : action === 'restart'
          ? (operationId: string) => api.restartAgent(target, operationId)
          : () => api.startAgent(target)
    return runAgentLifecycle(operation, `agent-${action}`, action === 'restore' || action === 'restart')
  }, [api, runAgentLifecycle])

  const setActivePage = useCallback((id: PageId) => {
    setPage(id)
    window.history.replaceState(null, '', `#${id}`)
    setMobileNavOpen(false)
  }, [])

  const repairAllAgents = useCallback(
    () => runAgentLifecycle((operationId) => api.repairAllAffectedAgents(operationId), 'agent-repair-all', true),
    [api, runAgentLifecycle],
  )
  const closeAllAgents = useCallback(
    () => runAgentLifecycle(() => api.closeAllManagedAgents(), 'agent-close-all'),
    [api, runAgentLifecycle],
  )
  const cancelAgentLifecycle = useCallback(async () => {
    const operationId = agentOperationIdRef.current
    if (!operationId || operationId !== agentCancellableOperationId || agentCancelPending) return
    setAgentCancelPending(true)
    try {
      const accepted = await api.cancelAgentLifecycleOperation(operationId)
      if (!accepted && agentOperationIdRef.current === operationId) setAgentCancelPending(false)
    } catch (cause) {
      if (agentOperationIdRef.current !== operationId) return
      setAgentCancelPending(false)
      setError(localizedError(cause, t('无法取消当前操作', 'Unable to cancel the current operation'), language))
    }
  }, [agentCancelPending, agentCancellableOperationId, api, language, t])
  const openClientConfiguration = useCallback(
    () => setActivePage('clients'),
    [setActivePage],
  )

  const revealContentScrollbar = useCallback((event: UIEvent<HTMLElement>) => {
    const element = event.currentTarget
    const nextBackToTopVisible = element.scrollTop > 420
    if (backToTopVisibleRef.current !== nextBackToTopVisible) {
      backToTopVisibleRef.current = nextBackToTopVisible
      setBackToTopVisible(nextBackToTopVisible)
    }
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
    const operationKey = `update-${action}`
    const operationId = beginOperation(operationKey)
    setUpdateAction(action)
    setUpdateError(null)
    try {
      const next = await operation()
      acceptUpdateState(next)
      finishOperation(operationId, operationKey, 'success')
      return next
    } catch (cause) {
      const message = localizedError(cause, t('应用更新操作失败', 'The app update operation failed'), language)
      setUpdateError(message)
      finishOperation(operationId, operationKey, 'error', message)
      return undefined
    } finally {
      setUpdateAction(null)
    }
  }, [acceptUpdateState, beginOperation, finishOperation, language, t])

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

  const quickActionItems = useMemo<Array<QuickNavigationItem<string>>>(() => [
    {
      id: 'action:gateway-power',
      label: snapshot?.gatewayStatus.running ? ['停止网关', 'Stop gateway'] : ['启动网关', 'Start gateway'],
      description: snapshot?.gatewayStatus.running
        ? ['停止接收新请求；执行前会再次确认', 'Stop accepting new requests after confirmation']
        : ['启动本地网关并恢复客户端入口', 'Start the local gateway and restore client access'],
      keywords: ['网关 开关 启动 停止', 'gateway power start stop'],
      icon: Power,
      kind: 'action',
    },
    {
      id: 'action:rebuild-outbound',
      label: ['重建低延迟出口', 'Rebuild low-latency connections'],
      description: ['刷新连接并预热当前启用来源，不修改路由配置', 'Refresh connections and warm enabled sources without changing routes'],
      keywords: ['网络 代理 节点 预热 重连', 'network proxy node warm reconnect'],
      icon: RefreshCw,
      kind: 'action',
    },
    {
      id: 'action:check-updates',
      label: ['检查应用更新', 'Check for updates'],
      description: ['检查新的 Stone+ 正式版本', 'Check for a newer Stone+ release'],
      keywords: ['版本 升级 release github', 'version upgrade release github'],
      icon: Sparkles,
      kind: 'action',
    },
    {
      id: 'action:recent-operations',
      label: ['查看最近操作', 'View recent operations'],
      description: ['查看本次运行中的保存、检测、网关和重建结果', 'Review save, check, gateway, and rebuild results from this run'],
      keywords: ['历史 进度 结果 失败', 'history progress result failure'],
      icon: History,
      kind: 'action',
    },
  ], [snapshot?.gatewayStatus.running])

  const allQuickNavigationItems = useMemo(
    () => [...quickNavigationItems, ...quickActionItems],
    [quickActionItems],
  )

  const selectQuickNavigationItem = useCallback((id: string) => {
    if (isPageId(id)) {
      setActivePage(id)
      return
    }
    if (id === 'action:recent-operations') {
      setOperationCenterOpen(true)
      return
    }
    if (!snapshot) return
    if (id === 'action:gateway-power') {
      if (snapshot.gatewayStatus.running) {
        const active = snapshot.gatewayStatus.activeRequests
        const confirmed = window.confirm(t(
          active > 0
            ? `停止网关会中断当前 ${active} 个活跃请求，是否继续？`
            : '停止网关后客户端将暂时无法发送请求，是否继续？',
          active > 0
            ? `Stopping the gateway will interrupt ${active} active request(s). Continue?`
            : 'Clients cannot send requests while the gateway is stopped. Continue?',
        ))
        if (!confirmed) return
      }
      void runAction('gateway-power', () => snapshot.gatewayStatus.running ? api.stopGateway() : api.startGateway())
      return
    }
    if (id === 'action:rebuild-outbound') {
      void runAction('rebuild-outbound', async () => {
        await api.rebuildOutboundConnections()
        return api.getSnapshot()
      })
      return
    }
    if (id === 'action:check-updates') void checkForUpdates()
  }, [api, checkForUpdates, runAction, setActivePage, snapshot, t])

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
  const mobileSidebarHidden = mobileLayout && !mobileNavOpen
  const mobileWorkspaceHidden = mobileLayout && mobileNavOpen
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
      <aside
        ref={mobileSidebarRef}
        id="stone-primary-navigation"
        className={`sidebar ${mobileNavOpen ? 'sidebar--open' : ''}`}
        role={mobileLayout ? 'dialog' : undefined}
        aria-modal={mobileLayout && mobileNavOpen || undefined}
        aria-label={mobileLayout ? t('主导航', 'Main navigation') : undefined}
        aria-hidden={mobileSidebarHidden || undefined}
        inert={mobileSidebarHidden || undefined}
        tabIndex={mobileLayout ? -1 : undefined}
      >
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
                  onClick={() => { setMobileNavOpen(false); setUpdateDialogOpen(true) }}
                >
                  {t('更新', 'Update')}
                </button>
              )}
            </div>
            <span>Local Gateway</span>
          </div>
          <button className="icon-button sidebar__mobile-close" type="button" data-mobile-sidebar-initial-focus onClick={() => setMobileNavOpen(false)} title={t('关闭导航', 'Close navigation')} aria-label={t('关闭导航', 'Close navigation')}>
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
                title={t(item.description[0], item.description[1])}
                aria-current={page === item.id ? 'page' : undefined}
                onPointerEnter={() => preloadAppPage(item.id)}
                onFocus={() => preloadAppPage(item.id)}
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
            onPointerEnter={() => preloadAppPage('help')}
            onFocus={() => preloadAppPage('help')}
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

      <div className="workspace" inert={mobileWorkspaceHidden || undefined} aria-hidden={mobileWorkspaceHidden || undefined}>
        <header className="topbar">
          <div className="topbar__left">
            <button ref={mobileNavTriggerRef} className="icon-button topbar__menu" type="button" aria-controls="stone-primary-navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)} title={t('打开导航', 'Open navigation')} aria-label={t('打开导航', 'Open navigation')}>
              <Menu size={19} />
            </button>
            <div className="gateway-state">
              <span className={`status-dot ${snapshot.gatewayStatus.running ? 'status-dot--online status-dot--pulse' : ''}`} />
              <div>
                <strong>{snapshot.gatewayStatus.running ? t('网关运行中', 'Gateway running') : t('网关已停止', 'Gateway stopped')}</strong>
                <span className="mono">{endpoint}</span>
              </div>
            </div>
            <button
              className="quick-navigation-trigger"
              type="button"
              aria-keyshortcuts="Control+K Meta+K"
              onClick={() => setQuickNavigationOpen(true)}
              title={t('查找功能或执行操作（Ctrl+K）', 'Find a feature or run an action (Ctrl+K)')}
            >
              <Search size={15} />
              <span>{t('查找 / 操作', 'Find / Run')}</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>

          <div className="topbar__right">
            <button
              className="icon-button topbar__operations"
              type="button"
              onClick={() => setOperationCenterOpen(true)}
              title={t('查看最近操作', 'View recent operations')}
              aria-label={t('查看最近操作', 'View recent operations')}
            >
              <History size={17} />
            </button>
            {(page === 'overview' || page === 'providers') && (
              <button className="button button--secondary topbar__setup" type="button" onPointerEnter={() => preloadAppPage('setup')} onFocus={() => preloadAppPage('setup')} onClick={() => setActivePage('setup')}>
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
                progress={agentProgress ?? undefined}
                cancellable={Boolean(agentCancellableOperationId)}
                cancelPending={agentCancelPending}
                onCancel={cancelAgentLifecycle}
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

        <main ref={pageContentRef} className="page-content" onScroll={revealContentScrollbar}>
          <PageErrorBoundary resetKey={page}>
            <div className="page-transition" key={page}>
              <Suspense fallback={<PageLoadingScreen />}>
                <ActivePage
                  page={page}
                  snapshot={pageSnapshot}
                  api={api}
                  runAction={runAction}
                  busyKeys={busyKeys}
                  update={updateController}
                  navigate={setActivePage}
                />
              </Suspense>
            </div>
          </PageErrorBoundary>
        </main>
        {backToTopVisible && (
          <button
            className="page-back-to-top"
            type="button"
            onClick={() => pageContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            title={t('返回页面顶部', 'Back to the top of this page')}
          >
            <ArrowUp size={15} />
            <span>{t('返回顶部', 'Back to top')}</span>
          </button>
        )}
      </div>
      <QuickNavigation
        open={quickNavigationOpen}
        activeId={page}
        recentIds={recentPages}
        items={allQuickNavigationItems}
        onClose={() => setQuickNavigationOpen(false)}
        onSelect={selectQuickNavigationItem}
      />
      <OperationCenter
        open={operationCenterOpen}
        records={operationRecords}
        onClose={() => setOperationCenterOpen(false)}
        onClear={() => setOperationRecords([])}
      />
      <OperationToast record={operationToast} onClose={() => setOperationToast(undefined)} />
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
