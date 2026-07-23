/* eslint-disable react-refresh/only-export-components -- request ordering helper is regression tested with the component. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PropsWithChildren,
} from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileCode2,
  Files,
  Gauge,
  Globe2,
  HardDriveUpload,
  Laptop,
  LayoutDashboard,
  ListTree,
  LoaderCircle,
  Network,
  Plus,
  Power,
  RefreshCw,
  Router,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unplug,
  Upload,
  Wifi,
  XCircle,
  Zap,
} from 'lucide-react'
import type {
  BuiltInProxyAccessMode,
  BuiltInProxyCustomRuleSet,
  BuiltInProxyEditableRule,
  BuiltInProxyImportInput,
  BuiltInProxyNodeSummary,
  BuiltInProxyProfileFormat,
  BuiltInProxyProfileSummary,
  BuiltInProxyRuleMode,
  BuiltInProxyRuleAction,
  BuiltInProxyRuleCondition,
  BuiltInProxyRuntimeState,
  GatewayApi,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
  OutboundNetworkMode,
} from '@shared/types'
import { useI18n } from '../i18n'
import { BoundAsyncOperation, SingleFlightAsyncOperation } from '../async-operation'
import { Badge, ConfirmDialog, durationLabel, relativeTime } from '../ui'
import {
  parseBuiltInProxyWorkspacePreferences,
  serializeBuiltInProxyWorkspacePreferences,
  summarizeBuiltInProxyImpact,
  summarizeBuiltInProxyRouteChain,
  summarizeBuiltInProxyRuntime,
  type BuiltInProxyWorkspaceTab,
} from '../built-in-proxy-workspace'
import { TelemetryWorkspace } from '../telemetry-workspace'
import { NetworkPolicyPanel } from './built-in-proxy/NetworkPolicyPanel'
import { NodesWorkspace } from './built-in-proxy/NodesWorkspace'
import { OverviewPanel } from './built-in-proxy/OverviewPanel'
import { SettingsWorkspace } from './built-in-proxy/SettingsPanel'
import '../built-in-proxy.css'

type ImportSource = BuiltInProxyImportInput['source']

const importSources: readonly ImportSource[] = ['subscription', 'import']

const NODE_PANEL_PREFERENCES_STORAGE_KEY = 'stone.built-in-proxy.node-panel.v1'
const WORKSPACE_PREFERENCES_STORAGE_KEY = 'stone.built-in-proxy.workspace.v1'

const workspaceTabs: readonly BuiltInProxyWorkspaceTab[] = [
  'overview',
  'profiles',
  'nodes',
  'rules',
  'access',
  'activity',
]

export interface BuiltInProxyExternalContext {
  outboundMode: OutboundNetworkMode
  accountBindingCount: number
  poolBindingCount: number
}

export interface BuiltInProxyNodePanelPreferences {
  collapsed: boolean
  groupFilters: Record<string, string>
}

const defaultNodePanelPreferences: BuiltInProxyNodePanelPreferences = {
  collapsed: false,
  groupFilters: {},
}

export function parseBuiltInProxyNodePanelPreferences(value: string | null): BuiltInProxyNodePanelPreferences {
  if (!value || value.length > 64_000) return defaultNodePanelPreferences
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultNodePanelPreferences
    const candidate = parsed as Record<string, unknown>
    const groupFilters: Record<string, string> = {}
    if (candidate.groupFilters && typeof candidate.groupFilters === 'object' && !Array.isArray(candidate.groupFilters)) {
      for (const [profileId, group] of Object.entries(candidate.groupFilters as Record<string, unknown>)) {
        // Keep this boundary aligned with the persisted profile and group-id
        // contract. Legacy/restored ids may be longer than the usual UUID or
        // stable hash, but are still valid up to 512 characters.
        if (profileId && profileId.length <= 512 && typeof group === 'string' && group.length <= 512) {
          groupFilters[profileId] = group
        }
      }
    }
    return {
      collapsed: candidate.collapsed === true,
      groupFilters,
    }
  } catch {
    return defaultNodePanelPreferences
  }
}

export function resolveBuiltInProxyGroupFilter(
  saved: string | undefined,
  groups: readonly string[],
  hasUngroupedNodes: boolean,
): string {
  if (saved === '__ungrouped__') return hasUngroupedNodes ? saved : 'all'
  if (saved && groups.includes(saved)) return saved
  return 'all'
}

function readNodePanelPreferences(): BuiltInProxyNodePanelPreferences {
  try {
    return parseBuiltInProxyNodePanelPreferences(window.localStorage.getItem(NODE_PANEL_PREFERENCES_STORAGE_KEY))
  } catch {
    return defaultNodePanelPreferences
  }
}

function persistNodePanelPreferences(preferences: BuiltInProxyNodePanelPreferences): void {
  try {
    window.localStorage.setItem(NODE_PANEL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage can be disabled; the current session still keeps the preference.
  }
}

function readWorkspaceTab(): BuiltInProxyWorkspaceTab {
  try {
    return parseBuiltInProxyWorkspacePreferences(
      window.localStorage.getItem(WORKSPACE_PREFERENCES_STORAGE_KEY),
    ).activeTab
  } catch {
    return 'overview'
  }
}

function persistWorkspaceTab(activeTab: BuiltInProxyWorkspaceTab): void {
  try {
    window.localStorage.setItem(
      WORKSPACE_PREFERENCES_STORAGE_KEY,
      serializeBuiltInProxyWorkspacePreferences({ activeTab }),
    )
  } catch {
    // The workbench remains usable when localStorage is unavailable.
  }
}

export interface BuiltInRuntimeRequestGuard {
  requestSequence: number
  eventRevision: number
}

/** A read may publish only if no newer read or pushed runtime event superseded it. */
export function isCurrentBuiltInRuntimeRequest(
  guard: BuiltInRuntimeRequestGuard,
  latestRequestSequence: number,
  currentEventRevision: number,
): boolean {
  return guard.requestSequence === latestRequestSequence
    && guard.eventRevision === currentEventRevision
}

export function shouldAcceptBuiltInRuntimeResponse(
  guard: BuiltInRuntimeRequestGuard,
  latestRequestSequence: number,
  currentEventRevision: number,
  currentRouteGeneration: number,
  nextRouteGeneration: number,
): boolean {
  return isCurrentBuiltInRuntimeRequest(guard, latestRequestSequence, currentEventRevision)
    || nextRouteGeneration > currentRouteGeneration
}

const profileFormatLabels: Record<BuiltInProxyProfileFormat, readonly [string, string]> = {
  'sing-box-json': ['sing-box JSON', 'sing-box JSON'],
  'clash-meta-yaml': ['Clash Meta YAML', 'Clash Meta YAML'],
  'uri-list': ['URI 列表', 'URI list'],
}

const ruleModeLabels: Record<BuiltInProxyRuleMode, readonly [string, string, string, string]> = {
  rule: ['规则', 'Rule', '按配置规则、安全降级规则或已保存的自定义规则从上到下匹配。', 'Match the profile, safe fallback, or saved custom rules from top to bottom.'],
  global: ['全局', 'Global', '除必要的本地回环外，所有请求使用选中节点。', 'Use the selected node for all traffic except required local loopback traffic.'],
  direct: ['直连', 'Direct', '不通过节点转发，用于临时排查规则与节点问题。', 'Bypass the selected node temporarily to diagnose rules and node issues.'],
}

const accessModeLabels: Record<BuiltInProxyAccessMode, readonly [string, string, string, string]> = {
  system: ['系统代理', 'System proxy', '接管系统代理，同时让 Stone+ 新请求使用专属 mixed 路由。', 'Lease the system proxy and route new Stone+ requests through its dedicated mixed route.'],
  tun: ['TUN', 'TUN', '每次启动临时提权，覆盖不遵循系统代理的应用。', 'Request temporary elevation on every start and cover apps that ignore the system proxy.'],
}

export type BuiltInProxyTakeoverPhase =
  | 'inactive'
  | 'starting'
  | 'ready'
  | 'restoring'
  | 'failed'
  | 'blocked'
  | 'inconsistent'

export interface BuiltInProxyTakeoverPresentation {
  phase: BuiltInProxyTakeoverPhase
  effectiveBuiltInRouteActive: boolean
  accessApplied: boolean
  expectedRouteKind: 'built-in-mixed' | 'built-in-tun'
  mixedPort?: number
}

/**
 * Renderer truth boundary: a lifecycle `ready` flag alone must never be
 * presented as takeover. The published route must match the selected access
 * mode and identify the healthy mixed generation that was activated only
 * after the system-proxy lease or TUN start completed.
 */
export function resolveBuiltInProxyTakeoverPresentation(
  runtime: BuiltInProxyRuntimeState,
): BuiltInProxyTakeoverPresentation {
  const expectedRouteKind = runtime.settings.accessMode === 'tun'
    ? 'built-in-tun'
    : 'built-in-mixed'
  const routePort = runtime.effectiveRoute.mixedPort
  const mixedPort = validProxyPort(routePort) ? routePort : undefined
  const generationMatches = runtime.routeGeneration === runtime.effectiveRoute.generation
  const publishedBuiltInRoute = (
    runtime.effectiveRoute.kind === 'built-in-mixed'
    || runtime.effectiveRoute.kind === 'built-in-tun'
  ) && mixedPort !== undefined && generationMatches
  const routeMatchesDesiredAccess = runtime.effectiveRoute.kind === expectedRouteKind && mixedPort !== undefined && generationMatches
  const accessEndpointPort = loopbackProxyEndpointPort(runtime.accessState?.endpoint)
  const accessProofMatches = runtime.accessState?.status === 'ready'
    && runtime.accessState.mode === runtime.settings.accessMode
    && mixedPort !== undefined
    && accessEndpointPort === mixedPort

  if (runtime.status === 'ready') {
    if (routeMatchesDesiredAccess && accessProofMatches) {
      return { phase: 'ready', effectiveBuiltInRouteActive: true, accessApplied: true, expectedRouteKind, mixedPort }
    }
    if (runtime.effectiveRoute.kind === 'blocked') {
      return { phase: 'blocked', effectiveBuiltInRouteActive: false, accessApplied: false, expectedRouteKind }
    }
    return { phase: 'inconsistent', effectiveBuiltInRouteActive: publishedBuiltInRoute, accessApplied: false, expectedRouteKind, ...(mixedPort !== undefined ? { mixedPort } : {}) }
  }
  if (runtime.status === 'starting') return { phase: 'starting', effectiveBuiltInRouteActive: publishedBuiltInRoute, accessApplied: false, expectedRouteKind, ...(mixedPort !== undefined ? { mixedPort } : {}) }
  if (runtime.status === 'stopping') return { phase: 'restoring', effectiveBuiltInRouteActive: publishedBuiltInRoute, accessApplied: false, expectedRouteKind, ...(mixedPort !== undefined ? { mixedPort } : {}) }
  if (runtime.status === 'error') {
    return {
      phase: runtime.effectiveRoute.kind === 'blocked' ? 'blocked' : 'failed',
      effectiveBuiltInRouteActive: publishedBuiltInRoute,
      accessApplied: false,
      expectedRouteKind,
      ...(mixedPort !== undefined ? { mixedPort } : {}),
    }
  }
  if (runtime.effectiveRoute.kind !== 'external') {
    return { phase: 'inconsistent', effectiveBuiltInRouteActive: publishedBuiltInRoute, accessApplied: false, expectedRouteKind, ...(mixedPort !== undefined ? { mixedPort } : {}) }
  }
  return { phase: 'inactive', effectiveBuiltInRouteActive: publishedBuiltInRoute, accessApplied: false, expectedRouteKind, ...(mixedPort !== undefined ? { mixedPort } : {}) }
}

export function BuiltInProxyView({
  api,
  initialState,
  externalContext,
  children,
}: PropsWithChildren<{
  api: GatewayApi
  initialState?: BuiltInProxyRuntimeState
  externalContext?: BuiltInProxyExternalContext
}>) {
  const { t } = useI18n()
  const [runtime, setRuntime] = useState<BuiltInProxyRuntimeState | null>(initialState ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [accessActionError, setAccessActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const pendingRef = useRef(new Set<string>())
  const [importSource, setImportSource] = useState<ImportSource>('subscription')
  const [importName, setImportName] = useState('')
  const [importFormat, setImportFormat] = useState<BuiltInProxyProfileFormat | ''>('')
  const [subscriptionUrl, setSubscriptionUrl] = useState('')
  const [subscriptionToken, setSubscriptionToken] = useState('')
  const [importContent, setImportContent] = useState('')
  const [deleteProfile, setDeleteProfile] = useState<BuiltInProxyProfileSummary | null>(null)
  const [nodePanelPreferences, setNodePanelPreferences] = useState(readNodePanelPreferences)
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState(readWorkspaceTab)
  const [traffic, setTraffic] = useState<ProxyTrafficSnapshot | null>(null)
  const [connections, setConnections] = useState<ProxyConnectionSummary[]>([])
  const [telemetryBusy, setTelemetryBusy] = useState(false)
  const runtimeRef = useRef<BuiltInProxyRuntimeState | null>(initialState ?? null)
  const runtimeRevision = useRef(0)
  const telemetryOperation = useRef(new BoundAsyncOperation())
  const telemetryFlight = useRef(new SingleFlightAsyncOperation())
  const telemetryMounted = useRef(true)
  const latencyOperation = useRef(new BoundAsyncOperation())
  const runtimeRequestSequence = useRef(0)
  const runtimeEventRevision = useRef(0)
  const importFileSequence = useRef(0)

  const selectWorkspaceTab = useCallback((tab: BuiltInProxyWorkspaceTab) => {
    setActiveWorkspaceTab(tab)
    persistWorkspaceTab(tab)
  }, [])

  const acceptRuntime = useCallback((next: BuiltInProxyRuntimeState) => {
    const current = runtimeRef.current
    if (current && next.routeGeneration < current.routeGeneration) return false
    runtimeRef.current = next
    runtimeRevision.current += 1
    telemetryOperation.current.invalidate()
    latencyOperation.current.invalidate()
    setRuntime(next)
    setLoadError(null)
    if (resolveBuiltInProxyTakeoverPresentation(next).phase === 'ready') setAccessActionError(null)
    return true
  }, [])

  const beginRuntimeRequest = useCallback((): BuiltInRuntimeRequestGuard => ({
    requestSequence: ++runtimeRequestSequence.current,
    eventRevision: runtimeEventRevision.current,
  }), [])

  const acceptRuntimeRequest = useCallback((guard: BuiltInRuntimeRequestGuard, next: BuiltInProxyRuntimeState) => {
    const shouldAccept = shouldAcceptBuiltInRuntimeResponse(
      guard,
      runtimeRequestSequence.current,
      runtimeEventRevision.current,
      runtimeRef.current?.routeGeneration ?? -1,
      next.routeGeneration,
    )
    // A state-changing IPC can legitimately finish after a newer read began.
    // Its higher route generation must still win; an equal-generation response
    // remains stale so it cannot overwrite a pushed event's newer details.
    if (!shouldAccept) return false
    return acceptRuntime(next)
  }, [acceptRuntime])

  const acceptRuntimeEvent = useCallback((next: BuiltInProxyRuntimeState) => {
    runtimeEventRevision.current += 1
    // Invalidate every get/action response that began before this pushed
    // snapshot, including responses with the same route generation.
    runtimeRequestSequence.current += 1
    acceptRuntime(next)
  }, [acceptRuntime])

  const loadRuntime = useCallback(async () => {
    const guard = beginRuntimeRequest()
    try {
      const next = await api.getBuiltInProxyState()
      acceptRuntimeRequest(guard, next)
    } catch (cause) {
      if (isCurrentBuiltInRuntimeRequest(
        guard,
        runtimeRequestSequence.current,
        runtimeEventRevision.current,
      )) setLoadError(errorMessage(cause, t('无法读取内置代理状态', 'Unable to read built-in proxy state.')))
    }
  }, [acceptRuntimeRequest, api, beginRuntimeRequest, t])

  useEffect(() => {
    let mounted = true
    const guard = beginRuntimeRequest()
    void api.getBuiltInProxyState().then((next) => {
      if (mounted) acceptRuntimeRequest(guard, next)
    }).catch((cause: unknown) => {
      if (mounted && isCurrentBuiltInRuntimeRequest(
        guard,
        runtimeRequestSequence.current,
        runtimeEventRevision.current,
      )) setLoadError(errorMessage(cause, t('无法读取内置代理状态', 'Unable to read built-in proxy state.')))
    })
    const unsubscribe = api.onBuiltInProxyState((next) => {
      if (mounted) acceptRuntimeEvent(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [acceptRuntimeEvent, acceptRuntimeRequest, api, beginRuntimeRequest, t])

  useEffect(() => {
    const telemetry = telemetryOperation.current
    const latency = latencyOperation.current
    telemetryMounted.current = true
    return () => {
      telemetryMounted.current = false
      runtimeRequestSequence.current += 1
      importFileSequence.current += 1
      telemetry.invalidate()
      latency.invalidate()
    }
  }, [])

  const begin = (key: string): boolean => {
    if (pendingRef.current.has(key)) return false
    pendingRef.current.add(key)
    setPending(new Set(pendingRef.current))
    setActionError(null)
    return true
  }

  const finish = (key: string) => {
    pendingRef.current.delete(key)
    setPending(new Set(pendingRef.current))
  }

  const runStateAction = async (
    key: string,
    operation: () => Promise<BuiltInProxyRuntimeState>,
    failureFallback = t('内置代理操作失败', 'The built-in proxy operation failed.'),
    onFailure?: (message: string) => void,
  ): Promise<boolean> => {
    if (!begin(key)) return false
    const guard = beginRuntimeRequest()
    try {
      acceptRuntimeRequest(guard, await operation())
      return true
    } catch (cause) {
      const message = errorMessage(cause, failureFallback, t)
      setActionError(message)
      onFailure?.(message)
      return false
    } finally {
      finish(key)
    }
  }

  const runAccessStateAction = async (
    key: string,
    operation: () => Promise<BuiltInProxyRuntimeState>,
    failureFallback: string,
  ): Promise<boolean> => {
    setAccessActionError(null)
    return runStateAction(key, operation, failureFallback, setAccessActionError)
  }

  const transitional = runtime?.status === 'starting' || runtime?.status === 'stopping'
  const masterBusy = pending.size > 0 || transitional
  const showBuiltIn = Boolean(runtime && (runtime.desiredEnabled || runtime.status !== 'disabled'))
  const masterChecked = showBuiltIn
  const controlsDisabled = masterBusy || runtime?.status === 'stopping'
  const activeProfile = useMemo(() => runtime?.profiles.find((profile) => (
    profile.id === runtime.settings.activeProfileId
  )) ?? runtime?.profiles[0], [runtime])
  const groups = useMemo(() => activeProfile
    ? Array.from(new Set(activeProfile.nodes.flatMap((node) => node.groupIds))).sort((left, right) => left.localeCompare(right))
    : [], [activeProfile])
  const hasUngroupedNodes = Boolean(activeProfile?.nodes.some((node) => node.groupIds.length === 0))
  const groupFilter = resolveBuiltInProxyGroupFilter(
    activeProfile ? nodePanelPreferences.groupFilters[activeProfile.id] : undefined,
    groups,
    hasUngroupedNodes,
  )
  const updateNodePanelPreferences = useCallback((
    update: (current: BuiltInProxyNodePanelPreferences) => BuiltInProxyNodePanelPreferences,
  ) => {
    setNodePanelPreferences((current) => {
      const next = update(current)
      persistNodePanelPreferences(next)
      return next
    })
  }, [])
  const takeover = runtime ? resolveBuiltInProxyTakeoverPresentation(runtime) : null
  const workspaceSummary = runtime ? summarizeBuiltInProxyRuntime(runtime) : null
  const workspaceImpact = runtime ? summarizeBuiltInProxyImpact(runtime) : null
  const workspaceRoute = runtime ? summarizeBuiltInProxyRouteChain(runtime) : null
  const overviewExternal = externalContext ?? {
    outboundMode: 'direct' as const,
    accountBindingCount: 0,
    poolBindingCount: 0,
  }
  const routeReady = takeover?.effectiveBuiltInRouteActive === true
  const telemetryContext = runtime ? JSON.stringify({
    generation: runtime.routeGeneration,
    kind: runtime.effectiveRoute.kind,
    profileId: runtime.effectiveRoute.profileId ?? runtime.settings.activeProfileId ?? null,
    nodeId: runtime.effectiveRoute.nodeId ?? activeProfile?.activeNodeId ?? null,
  }) : 'unavailable'
  const firstRunWithoutProfile = Boolean(
    runtime
    && runtime.profiles.length === 0
    && !runtime.settings.hasEverActivated
    && runtime.status === 'disabled'
    && runtime.effectiveRoute.kind === 'external'
    && !runtime.error,
  )

  const refreshTelemetry = useCallback(async (reportError: boolean) => {
    const current = runtimeRef.current
    const ready = current
      ? resolveBuiltInProxyTakeoverPresentation(current).effectiveBuiltInRouteActive
      : false
    if (!current || !ready) return
    const binding = `runtime:${runtimeRevision.current}`
    if (reportError) setTelemetryBusy(true)
    try {
      const outcome = await telemetryFlight.current.run(() => telemetryOperation.current.run(
        binding,
        () => `runtime:${runtimeRevision.current}`,
        () => Promise.all([
          api.getBuiltInProxyTraffic(),
          api.listBuiltInProxyConnections(),
        ]),
      ))
      if (outcome.status === 'applied') {
        const [nextTraffic, nextConnections] = outcome.value
        setTraffic(nextTraffic)
        setConnections(nextConnections)
      } else if (outcome.status === 'failed' && reportError) {
        setActionError(errorMessage(outcome.error, t('无法读取流量与连接', 'Unable to read traffic and connections.')))
      }
    } finally {
      if (reportError && telemetryMounted.current) setTelemetryBusy(false)
    }
  }, [api, t])

  useEffect(() => {
    if (!routeReady) {
      telemetryOperation.current.invalidate()
      setTelemetryBusy(false)
      setTraffic(null)
      setConnections([])
      return
    }
    void refreshTelemetry(false)
    const timer = window.setInterval(() => void refreshTelemetry(false), 3_000)
    return () => window.clearInterval(timer)
  }, [refreshTelemetry, routeReady, telemetryContext])

  const toggleMaster = async () => {
    if (!runtime || masterBusy) return
    await runStateAction('master', () => api.setBuiltInProxyEnabled(!masterChecked))
  }

  const submitImport = async (event: FormEvent) => {
    event.preventDefault()
    const name = importName.trim() || undefined
    const format = importFormat || undefined
    const input: BuiltInProxyImportInput = importSource === 'subscription'
      ? {
          source: 'subscription',
          name,
          url: subscriptionUrl.trim(),
          token: subscriptionToken || undefined,
          format,
        }
      : {
          source: 'import',
          name,
          content: importContent.trim(),
          format,
        }
    if (input.source === 'subscription' && !input.url) {
      setActionError(t('请输入订阅 URL', 'Enter a subscription URL.'))
      return
    }
    if (input.source === 'import' && !input.content) {
      setActionError(t('请选择配置文件或粘贴配置内容', 'Choose a configuration file or paste configuration content.'))
      return
    }
    const success = await runStateAction('import', () => api.importBuiltInProxyProfile(input))
    if (!success) return
    setImportName('')
    setSubscriptionUrl('')
    setSubscriptionToken('')
    setImportContent('')
  }

  const readImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const sequence = ++importFileSequence.current
    try {
      const content = await file.text()
      if (sequence !== importFileSequence.current) return
      setImportContent(content)
      if (!importName.trim()) setImportName(file.name.replace(/\.(json|ya?ml|txt)$/i, ''))
      if (!importFormat) setImportFormat(formatFromFilename(file.name))
    } catch (cause) {
      if (sequence === importFileSequence.current) {
        setActionError(errorMessage(cause, t('无法读取所选配置文件', 'Unable to read the selected configuration file.')))
      }
    }
  }

  const testLatency = async (profile: BuiltInProxyProfileSummary, nodeIds?: string[]) => {
    const key = nodeIds?.length === 1 ? `latency-${nodeIds[0]}` : `latency-${profile.id}`
    if (!begin(key)) return
    try {
      const binding = `runtime:${runtimeRevision.current}:profile:${profile.id}`
      const outcome = await latencyOperation.current.run(
        binding,
        () => `runtime:${runtimeRevision.current}:profile:${profile.id}`,
        () => api.testBuiltInProxyLatency(profile.id, nodeIds),
      )
      if (outcome.status === 'applied') {
        const byId = new Map(outcome.value.map((node) => [node.id, node]))
        setRuntime((current) => {
          if (!current) return current
          const next = {
            ...current,
            profiles: current.profiles.map((candidate) => candidate.id === profile.id ? {
              ...candidate,
              nodes: candidate.nodes.map((node) => {
                const tested = byId.get(node.id)
                return tested ? {
                  ...node,
                  latencyMs: tested.latencyMs,
                  latencyStatus: tested.latencyStatus,
                  lastTestedAt: tested.lastTestedAt,
                } : node
              }),
            } : candidate),
          }
          runtimeRef.current = next
          return next
        })
      } else if (outcome.status === 'failed') {
        setActionError(errorMessage(outcome.error, t('内置代理操作失败', 'The built-in proxy operation failed.')))
      }
    } finally {
      finish(key)
    }
  }

  const closeConnection = async (connectionId: string) => {
    const key = `close-connection-${connectionId}`
    if (!begin(key)) return
    const revision = runtimeRevision.current
    try {
      await api.closeBuiltInProxyConnection(connectionId)
      if (runtimeRevision.current === revision) {
        setConnections((current) => current.filter((connection) => connection.id !== connectionId))
      }
      void refreshTelemetry(false)
    } catch (cause) {
      if (runtimeRevision.current === revision) {
        setActionError(errorMessage(cause, t('无法关闭连接', 'Unable to close the connection.')))
      }
    } finally {
      finish(key)
    }
  }

  const rebuildOutboundConnections = async () => {
    const key = 'rebuild-outbound'
    if (!begin(key)) return
    try {
      await api.rebuildOutboundConnections()
    } catch (cause) {
      setActionError(errorMessage(cause, t('重建低延迟出口失败', 'Failed to rebuild the low-latency route.')))
    } finally {
      finish(key)
    }
  }

  const deleteSelectedProfile = async () => {
    if (!deleteProfile) return
    const success = await runStateAction(`delete-profile-${deleteProfile.id}`, () => api.deleteBuiltInProxyProfile(deleteProfile.id))
    if (success) setDeleteProfile(null)
  }

  return <div className="built-in-proxy">
    <MasterSwitch
      runtime={runtime}
      checked={masterChecked}
      busy={masterBusy}
      loadError={loadError}
      onToggle={() => void toggleMaster()}
      onReload={() => void loadRuntime()}
      t={t}
    />

    {actionError && <div className="built-in-proxy__notice built-in-proxy__notice--error" role="alert">
      <CircleAlert size={17} />
      <span>{actionError}</span>
      <button type="button" className="icon-button" title={t('关闭', 'Close')} onClick={() => setActionError(null)}><XCircle size={16} /></button>
    </div>}

    {runtime?.error && showBuiltIn && !firstRunWithoutProfile && <RuntimeError
      runtime={runtime}
      busy={pending.has('retry') || transitional}
      onRetry={() => void runStateAction('retry', () => api.retryBuiltInProxy())}
      t={t}
    />}

    {!runtime && !loadError && <section className="panel built-in-proxy__loading" aria-busy="true">
      <LoaderCircle size={20} className="spin" />
      <span>{t('正在读取内置代理状态…', 'Loading built-in proxy state…')}</span>
    </section>}

    {runtime && !showBuiltIn && children}

    {runtime && showBuiltIn && runtime.profiles.length === 0 && <>
      <section className="panel built-in-proxy-guide">
        <div className="built-in-proxy-guide__icon"><ShieldCheck size={30} /></div>
        <div>
          <Badge tone={firstRunWithoutProfile ? 'info' : 'danger'}>{firstRunWithoutProfile ? t('尚未接管', 'Not taking over yet') : t('保持阻断', 'Fail-closed')}</Badge>
          <h2>{firstRunWithoutProfile ? t('导入第一份有效配置', 'Import your first valid profile') : t('恢复一份有效配置', 'Restore a valid profile')}</h2>
          <p>{firstRunWithoutProfile ? t(
            '导入配置通过校验后，Stone+ 会立即启动核心并尝试应用当前接入方式；在核心、接入方式和专属 Chromium 路由全部校验成功前，不会切换新请求。账号与号池的原代理绑定、系统代理或直连仍按原路由生效。',
            'After an imported profile passes validation, Stone+ immediately starts the core and tries to apply the current access mode. New requests are not switched until the core, access mode, and dedicated Chromium route all validate successfully. Existing account/pool bindings and the saved system/direct route remain active.',
          ) : t(
            '当前没有可用配置，且接管流程未处于安全的外部路由状态。Stone+ 新请求保持 fail-closed，不会自动回退到原代理或直连；请重新导入配置、重试或关闭内置代理。',
            'No usable profile is available and takeover is not in a safe external-route state. New Stone+ requests stay fail-closed and will not fall back to the previous proxy or a direct connection; import a profile, retry, or disable the built-in proxy.',
          )}</p>
        </div>
      </section>
      <ImportPanel
        source={importSource}
        name={importName}
        format={importFormat}
        subscriptionUrl={subscriptionUrl}
        subscriptionToken={subscriptionToken}
        content={importContent}
        busy={pending.has('import')}
        disabled={controlsDisabled}
        onSource={(next) => {
          importFileSequence.current += 1
          setImportSource(next)
        }}
        onName={(next) => {
          importFileSequence.current += 1
          setImportName(next)
        }}
        onFormat={(next) => {
          importFileSequence.current += 1
          setImportFormat(next)
        }}
        onSubscriptionUrl={setSubscriptionUrl}
        onSubscriptionToken={setSubscriptionToken}
        onContent={(next) => {
          importFileSequence.current += 1
          setImportContent(next)
        }}
        onFile={readImportFile}
        onSubmit={(event) => void submitImport(event)}
        t={t}
      />
    </>}

    {runtime && showBuiltIn && runtime.profiles.length > 0 && workspaceSummary && workspaceImpact && workspaceRoute && <>
      <WorkspaceNavigation active={activeWorkspaceTab} onSelect={selectWorkspaceTab} t={t} />

      <div
        id="built-in-proxy-workspace-panel"
        className="built-in-proxy-workspace"
        role="tabpanel"
        aria-labelledby={`built-in-proxy-tab-${activeWorkspaceTab}`}
      >
        {activeWorkspaceTab === 'overview' && <OverviewPanel
          takeover={{
            status: overviewTakeoverStatus(workspaceSummary.phase),
            detail: overviewTakeoverDetail(workspaceSummary.phase, workspaceSummary.effectiveBuiltInRouteActive, t),
            evidence: [
              {
                id: 'access',
                label: t('当前已发布路由', 'Published route'),
                value: workspaceSummary.effectiveBuiltInRouteActive && workspaceSummary.effectiveMixedPort
                  ? `${runtime.effectiveRoute.kind === 'built-in-tun' ? 'TUN + mixed' : 'mixed'} · 127.0.0.1:${workspaceSummary.effectiveMixedPort}`
                  : t('尚未通过最终校验', 'Not finally verified'),
                tone: workspaceSummary.effectiveBuiltInRouteActive ? 'success' : workspaceSummary.failClosed ? 'danger' : 'warning',
              },
              {
                id: 'system-access',
                label: t('系统接入', 'System access'),
                value: overviewAccessStateLabel(runtime, t),
                tone: runtime.accessState.status === 'ready' ? 'success' : runtime.accessState.status === 'error' ? 'danger' : 'warning',
              },
              {
                id: 'generation',
                label: t('路由代次', 'Route generation'),
                value: `#${runtime.effectiveRoute.generation}`,
                tone: workspaceSummary.generationConsistent ? 'success' : 'danger',
              },
              {
                id: 'core',
                label: t('代理核心', 'Proxy core'),
                value: runtime.coreVersion
                  ? `sing-box ${runtime.coreVersion}`
                  : workspaceSummary.effectiveBuiltInRouteActive
                    ? t('运行中（版本未上报）', 'Running (version unavailable)')
                    : t('等待启动', 'Waiting to start'),
                tone: runtime.coreVersion || workspaceSummary.effectiveBuiltInRouteActive ? 'neutral' : 'warning',
              },
            ],
          }}
          route={{
            status: overviewRouteStatus(workspaceRoute.kind, runtime.status),
            stone: { label: 'Stone+', detail: t('全部新网关请求', 'All new gateway requests') },
            mixed: workspaceRoute.kind === 'external'
              ? { label: t('外部路由优先级', 'External route priority'), detail: t('账号 > 号池 > 系统/直连', 'Account > pool > system/direct') }
              : workspaceSummary.effectiveBuiltInRouteActive && workspaceSummary.effectiveMixedPort
                ? { label: runtime.effectiveRoute.kind === 'built-in-tun' ? 'TUN + mixed' : 'mixed', detail: `127.0.0.1:${workspaceSummary.effectiveMixedPort}` }
                : { label: workspaceRoute.kind === 'blocked' ? 'Fail-closed' : t('等待健康检查', 'Awaiting health check'), detail: t('未验证的端口不会显示为已生效', 'Unverified endpoints are never shown as active') },
            node: runtime.status === 'ready' && runtime.settings.ruleMode === 'direct'
              ? { label: t('直连', 'Direct'), detail: t('仅用于排查', 'Diagnostic mode') }
              : {
                  label: workspaceSummary.effectiveNodeName
                    ?? (runtime.status === 'ready' ? workspaceSummary.selectedNodeName : undefined)
                    ?? t('当前策略未固化在快照中', 'Current policy is not captured in this snapshot'),
                  detail: workspaceSummary.activeProfileName,
                },
          }}
          selection={{
            profileName: workspaceSummary.activeProfileName,
            nodeName: workspaceSummary.effectiveBuiltInRouteActive
              ? workspaceSummary.effectiveNodeName
              : workspaceSummary.selectedNodeName,
            ...(runtime.status === 'ready'
              ? { ruleMode: runtime.settings.ruleMode }
              : workspaceSummary.effectiveBuiltInRouteActive
                ? { ruleLabel: t('当前代次策略未包含在快照中', 'Current generation policy is not captured') }
                : { ruleMode: runtime.settings.ruleMode }),
            accessMode: runtime.effectiveRoute.kind === 'built-in-tun'
              ? 'tun'
              : runtime.effectiveRoute.kind === 'built-in-mixed'
                ? 'system'
                : runtime.settings.accessMode,
          }}
          externalBindings={{
            accountCount: overviewExternal.accountBindingCount,
            poolCount: overviewExternal.poolBindingCount,
            paused: workspaceImpact.externalBindings === 'preserved-paused',
          }}
          externalOutbound={{ mode: overviewExternal.outboundMode, preserved: true }}
          protection={{
            loopbackBypasses: [
              t('Stone+ 本地网关', 'Stone+ local gateway'),
              t('mixed 与控制接口', 'mixed and controller endpoints'),
              t('节点与 DNS 引导流量', 'node and DNS bootstrap traffic'),
            ],
            failClosedEnabled: runtime.settings.hasEverActivated,
            failClosedActive: workspaceSummary.failClosed,
          }}
          retrying={pending.has('retry')}
          rebuilding={pending.has('rebuild-outbound')}
          onRetry={runtime.error?.retryable ? () => void runStateAction('retry', () => api.retryBuiltInProxy()) : undefined}
          onRebuild={() => void rebuildOutboundConnections()}
          onNavigate={(target) => selectWorkspaceTab(target === 'connections' ? 'activity' : target)}
        />}

        {activeWorkspaceTab === 'profiles' && <>
          <NodesWorkspace
            section="profiles"
            profiles={runtime.profiles}
            activeProfileId={runtime.settings.activeProfileId}
            groupFilter={groupFilter}
            collapsed={nodePanelPreferences.collapsed}
            disabled={controlsDisabled}
            pending={pending}
            onSelectProfile={(profileId) => void runStateAction(`select-profile-${profileId}`, () => api.selectBuiltInProxyProfile(profileId))}
            onRefreshProfile={(profileId) => void runStateAction(`refresh-profile-${profileId}`, () => api.refreshBuiltInProxyProfile(profileId))}
            onDeleteProfile={setDeleteProfile}
            onImportProfile={() => document.getElementById('built-in-profile-import')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            onSelectGroup={() => undefined}
            onToggleCollapsed={() => undefined}
            onSelectNode={() => undefined}
            onTestLatency={() => undefined}
          />
          <div id="built-in-profile-import">
            <ImportPanel
              compact
              source={importSource}
              name={importName}
              format={importFormat}
              subscriptionUrl={subscriptionUrl}
              subscriptionToken={subscriptionToken}
              content={importContent}
              busy={pending.has('import')}
              disabled={controlsDisabled}
              onSource={(next) => { importFileSequence.current += 1; setImportSource(next) }}
              onName={(next) => { importFileSequence.current += 1; setImportName(next) }}
              onFormat={(next) => { importFileSequence.current += 1; setImportFormat(next) }}
              onSubscriptionUrl={setSubscriptionUrl}
              onSubscriptionToken={setSubscriptionToken}
              onContent={(next) => { importFileSequence.current += 1; setImportContent(next) }}
              onFile={readImportFile}
              onSubmit={(event) => void submitImport(event)}
              t={t}
            />
          </div>
        </>}

        {activeWorkspaceTab === 'nodes' && <NodesWorkspace
          section="nodes"
          profiles={runtime.profiles}
          activeProfileId={runtime.settings.activeProfileId}
          groupFilter={groupFilter}
          collapsed={nodePanelPreferences.collapsed}
          disabled={controlsDisabled}
          pending={pending}
          onSelectProfile={() => undefined}
          onRefreshProfile={() => undefined}
          onDeleteProfile={() => undefined}
          onImportProfile={() => selectWorkspaceTab('profiles')}
          onSelectGroup={(group) => {
            if (!activeProfile) return
            updateNodePanelPreferences((current) => ({ ...current, groupFilters: { ...current.groupFilters, [activeProfile.id]: group } }))
          }}
          onToggleCollapsed={() => updateNodePanelPreferences((current) => ({ ...current, collapsed: !current.collapsed }))}
          onSelectNode={(profileId, nodeId) => void runStateAction(`select-node-${nodeId}`, () => api.selectBuiltInProxyNode(profileId, nodeId))}
          onTestLatency={(profile, nodeIds) => void testLatency(profile, nodeIds)}
        />}

        {activeWorkspaceTab === 'rules' && <div className="built-in-proxy-workspace__stack">
          <ModePanel
            runtime={runtime}
            profile={activeProfile}
            disabled={controlsDisabled}
            pending={pending.has('custom-rules')}
            onMode={(mode) => void runStateAction(`rule-mode-${mode}`, () => api.setBuiltInProxyRuleMode(mode))}
            onCustomRules={(rules) => runStateAction('custom-rules', () => api.setBuiltInProxyCustomRules(rules))}
            t={t}
          />
          <NetworkPolicyPanel runtime={runtime} profile={activeProfile} pending={runtime.status !== 'ready'} t={t} />
        </div>}

        {activeWorkspaceTab === 'access' && <SettingsWorkspace
          runtime={runtime}
          disabled={controlsDisabled}
          pending={{
            ...(pending.has('access-mode-system') ? { accessMode: 'system' as const } : {}),
            ...(pending.has('access-mode-tun') ? { accessMode: 'tun' as const } : {}),
            ...(pending.has('lan') ? { lanEnabled: !runtime.settings.lanEnabled } : {}),
            ...(pending.has('auto-start') ? { autoStart: !runtime.settings.autoStart } : {}),
          }}
          actionError={accessActionError}
          onAccessModeChange={(mode) => void runAccessStateAction(
            `access-mode-${mode}`,
            () => api.setBuiltInProxyAccessMode(mode),
            t(mode === 'tun' ? '切换到 TUN 失败' : '应用系统代理失败', mode === 'tun' ? 'Failed to switch to TUN.' : 'Failed to apply the system proxy.'),
          )}
          onLanEnabledChange={(enabled) => runAccessStateAction(
            'lan',
            () => api.setBuiltInProxyLanEnabled(enabled),
            t(
              enabled ? '开启局域网访问失败' : '关闭局域网访问失败',
              enabled ? 'Failed to enable LAN access.' : 'Failed to disable LAN access.',
            ),
          )}
          onAutoStartChange={(enabled) => void runStateAction('auto-start', () => api.setBuiltInProxyAutoStart(enabled))}
        />}

        {activeWorkspaceTab === 'activity' && <TelemetryWorkspace
          traffic={traffic}
          connections={connections}
          state={routeReady ? 'ready' : runtime.effectiveRoute.kind === 'blocked' ? 'fail-closed' : 'waiting'}
          refreshing={telemetryBusy}
          closingConnectionIds={new Set(connections.filter((connection) => pending.has(`close-connection-${connection.id}`)).map((connection) => connection.id))}
          actionsDisabled={pending.size > 0}
          onRefresh={() => void refreshTelemetry(true)}
          onCloseConnection={(id) => void closeConnection(id)}
        />}
      </div>
    </>}

    <ConfirmDialog
      open={Boolean(deleteProfile)}
      title={t('删除配置', 'Delete profile')}
      message={t(
        `确定删除“${deleteProfile?.name ?? ''}”吗？节点凭据也会从本机安全存储中移除。`,
        `Delete “${deleteProfile?.name ?? ''}”? Its node credentials will also be removed from secure local storage.`,
      )}
      busy={deleteProfile ? pending.has(`delete-profile-${deleteProfile.id}`) : false}
      onCancel={() => setDeleteProfile(null)}
      onConfirm={() => void deleteSelectedProfile()}
    />
  </div>
}

function WorkspaceNavigation({ active, onSelect, t }: {
  active: BuiltInProxyWorkspaceTab
  onSelect: (tab: BuiltInProxyWorkspaceTab) => void
  t: Translator
}) {
  const moveFocus = (tab: BuiltInProxyWorkspaceTab, direction: -1 | 1) => {
    const index = workspaceTabs.indexOf(tab)
    const next = workspaceTabs[(index + direction + workspaceTabs.length) % workspaceTabs.length]
    onSelect(next)
    window.requestAnimationFrame(() => document.getElementById(`built-in-proxy-tab-${next}`)?.focus())
  }
  return <nav className="built-in-proxy-workspace-nav" role="tablist" aria-label={t('代理工作台', 'Proxy workspace')}>
    {workspaceTabs.map((tab) => <button
      id={`built-in-proxy-tab-${tab}`}
      key={tab}
      type="button"
      role="tab"
      aria-selected={active === tab}
      aria-controls="built-in-proxy-workspace-panel"
      tabIndex={active === tab ? 0 : -1}
      className={active === tab ? 'is-active' : ''}
      onClick={() => onSelect(tab)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(tab, -1)
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          moveFocus(tab, 1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onSelect(workspaceTabs[0])
          window.requestAnimationFrame(() => document.getElementById(`built-in-proxy-tab-${workspaceTabs[0]}`)?.focus())
        } else if (event.key === 'End') {
          event.preventDefault()
          const last = workspaceTabs[workspaceTabs.length - 1]
          onSelect(last)
          window.requestAnimationFrame(() => document.getElementById(`built-in-proxy-tab-${last}`)?.focus())
        }
      }}
    >
      {workspaceTabIcon(tab)}
      <span>{workspaceTabLabel(tab, t)}</span>
    </button>)}
  </nav>
}

function workspaceTabLabel(tab: BuiltInProxyWorkspaceTab, t: Translator): string {
  const labels: Record<BuiltInProxyWorkspaceTab, readonly [string, string]> = {
    overview: ['概览', 'Overview'],
    profiles: ['配置', 'Profiles'],
    nodes: ['节点', 'Nodes'],
    rules: ['规则', 'Rules'],
    access: ['接入', 'Access'],
    activity: ['连接', 'Connections'],
  }
  return t(...labels[tab])
}

function workspaceTabIcon(tab: BuiltInProxyWorkspaceTab): React.ReactNode {
  if (tab === 'overview') return <LayoutDashboard size={15} aria-hidden="true" />
  if (tab === 'profiles') return <Files size={15} aria-hidden="true" />
  if (tab === 'nodes') return <ListTree size={15} aria-hidden="true" />
  if (tab === 'rules') return <SlidersHorizontal size={15} aria-hidden="true" />
  if (tab === 'access') return <Settings2 size={15} aria-hidden="true" />
  return <Activity size={15} aria-hidden="true" />
}

function overviewTakeoverStatus(
  phase: ReturnType<typeof summarizeBuiltInProxyRuntime>['phase'],
): 'inactive' | 'starting' | 'ready' | 'stopping' | 'blocked' | 'error' {
  if (phase === 'starting' || phase === 'needs-profile') return 'starting'
  if (phase === 'ready') return 'ready'
  if (phase === 'restoring') return 'stopping'
  if (phase === 'blocked') return 'blocked'
  if (phase === 'failed' || phase === 'inconsistent') return 'error'
  return 'inactive'
}

function overviewTakeoverDetail(
  phase: ReturnType<typeof summarizeBuiltInProxyRuntime>['phase'],
  currentRouteActive: boolean,
  t: Translator,
): string {
  if (phase === 'ready') return t('系统接入、核心健康和 Stone+ 专属路由均已通过最终校验。', 'System access, core health, and the Stone+ route passed final verification.')
  if (phase === 'starting') return currentRouteActive
    ? t('正在准备候选代次；当前已发布的内置路由继续接管，直到原子切换完成。', 'Preparing a candidate generation; the published built-in route remains active until the atomic switch.')
    : t('首次启动尚未接管；核心与系统接入通过最终校验后才会原子切换。', 'First startup has not taken over; the route switches only after final core and system-access verification.')
  if (phase === 'restoring') return currentRouteActive
    ? t('正在恢复外部路由；完成前当前内置代次继续接管。', 'Restoring the external route; the current built-in generation remains active until completion.')
    : t('正在恢复外部路由。', 'Restoring the external route.')
  if (phase === 'blocked') return t('新请求保持 fail-closed，不会自动直连或回退。', 'New requests remain fail-closed with no direct or automatic fallback.')
  if (phase === 'failed' || phase === 'inconsistent') return currentRouteActive
    ? t('操作未完成，但当前已发布的内置代次仍承担 Stone+ 请求；请按错误提示重试。', 'The operation did not complete, but the published built-in generation still serves Stone+ requests; retry from the error shown.')
    : t('操作未完成；请按错误提示恢复，页面不会把计划状态冒充为已生效。', 'The operation did not complete; recover from the error shown. Planned state is never presented as active.')
  if (phase === 'needs-profile') return t('导入有效配置前，原外部路由保持生效。', 'The external route remains active until a valid profile is imported.')
  return t('当前使用账号、号池与保存的外部网络设置。', 'Account, pool, and saved external network settings are active.')
}

function overviewRouteStatus(
  kind: ReturnType<typeof summarizeBuiltInProxyRouteChain>['kind'],
  status: BuiltInProxyRuntimeState['status'],
): 'inactive' | 'preparing' | 'active' | 'blocked' {
  if (kind === 'blocked') return 'blocked'
  if (kind === 'built-in') return 'active'
  if (status === 'starting' || status === 'stopping' || kind === 'unconfirmed') return 'preparing'
  return 'inactive'
}

function overviewAccessStateLabel(runtime: BuiltInProxyRuntimeState, t: Translator): string {
  const tun = runtime.accessState.mode === 'tun'
  if (runtime.accessState.status === 'ready') return tun ? t('TUN 已验证', 'TUN verified') : t('系统代理已验证', 'System proxy verified')
  if (runtime.accessState.status === 'applying') return tun ? t('TUN 正在切换', 'TUN switching') : t('系统代理正在切换', 'System proxy switching')
  if (runtime.accessState.status === 'error') return tun ? t('TUN 未就绪', 'TUN not ready') : t('系统代理未就绪', 'System proxy not ready')
  return tun ? t('TUN 未启用', 'TUN inactive') : t('系统代理未启用', 'System proxy inactive')
}

function MasterSwitch({ runtime, checked, busy, loadError, onToggle, onReload, t }: {
  runtime: BuiltInProxyRuntimeState | null
  checked: boolean
  busy: boolean
  loadError: string | null
  onToggle: () => void
  onReload: () => void
  t: Translator
}) {
  const status = runtime?.status
  const awaitingFirstProfile = Boolean(
    runtime?.desiredEnabled
    && runtime.profiles.length === 0
    && !runtime.settings.hasEverActivated
    && runtime.status === 'disabled'
    && runtime.effectiveRoute.kind === 'external'
    && !runtime.error,
  )
  const takeover = runtime ? resolveBuiltInProxyTakeoverPresentation(runtime) : null
  const badgeTone = awaitingFirstProfile
    ? 'info'
    : takeover?.phase === 'ready'
      ? 'success'
      : takeover?.phase === 'failed' || takeover?.phase === 'blocked' || takeover?.phase === 'inconsistent'
        ? 'danger'
        : takeover?.phase === 'starting' || takeover?.phase === 'restoring'
          ? 'warning'
          : 'neutral'
  const statusLabel = awaitingFirstProfile
    ? t('等待配置', 'Waiting for profile')
    : takeover?.phase === 'ready'
      ? t('已接管', 'Taken over')
      : takeover?.phase === 'starting'
      ? takeover.effectiveBuiltInRouteActive ? t('切换中 · 当前已接管', 'Switching · route active') : t('正在启动', 'Starting')
      : takeover?.phase === 'restoring'
        ? takeover.effectiveBuiltInRouteActive ? t('恢复中 · 当前已接管', 'Restoring · route active') : t('正在恢复', 'Stopping')
        : takeover?.phase === 'blocked'
          ? t('错误 / 已阻断', 'Error / blocked')
          : takeover?.phase === 'failed'
            ? takeover.effectiveBuiltInRouteActive ? t('操作失败 · 当前已接管', 'Operation failed · route active') : t('接管失败', 'Takeover failed')
            : takeover?.phase === 'inconsistent'
              ? t('状态未确认', 'State unconfirmed')
          : t('已关闭', 'Off')
  const description = loadError
    ? loadError
    : !runtime
    ? t('正在确认当前路由，不会在状态未知时切换请求。', 'Confirming the current route; requests are not switched while state is unknown.')
    : awaitingFirstProfile
      ? t('等待导入有效配置，当前外部路由保持不变。', 'Waiting for a valid profile; the current external route remains unchanged.')
      : takeover?.phase === 'ready'
        ? t('Stone+ 新请求强制经过内置代理；原账号与号池绑定已保留并暂停。', 'New Stone+ requests are forced through the built-in proxy; account and pool bindings are preserved and paused.')
        : takeover?.phase === 'starting'
          ? takeover.effectiveBuiltInRouteActive
            ? t('正在准备候选代次；当前内置路由继续接管，完成后原子切换。', 'Preparing a candidate generation; the current built-in route remains active until the atomic switch.')
            : t('核心健康后才会原子接管新请求。', 'New requests are taken over atomically only after the core is healthy.')
          : takeover?.phase === 'restoring'
            ? takeover.effectiveBuiltInRouteActive
              ? t('正在恢复原外部路由并排空旧连接，完成前当前内置代次继续接管。', 'Restoring the previous external route and draining old connections; the current built-in generation remains active until complete.')
              : t('正在恢复原外部路由。', 'Restoring the previous external route.')
            : takeover?.phase === 'blocked'
              ? t('请求保持 fail-closed，不会自动回退或直连泄漏。', 'Requests remain fail-closed; there is no automatic fallback or direct-connection leak.')
              : takeover?.phase === 'failed'
                ? takeover.effectiveBuiltInRouteActive
                  ? t('操作失败，但当前已发布的内置代次仍承担 Stone+ 请求；请查看错误后重试。', 'The operation failed, but the published built-in generation still serves Stone+ requests; review the error and retry.')
                  : t('接入方式未成功应用，Stone+ 没有把此状态显示为已接管；请查看下方错误后重试。', 'The access mode was not applied, so Stone+ does not show takeover; review the error below and retry.')
                : takeover?.phase === 'inconsistent'
                  ? t('运行状态与接入方式不一致，已隐藏接管标识并等待状态恢复。', 'The runtime route does not match the selected access mode; takeover is hidden until state recovers.')
              : t('账号代理优先于号池代理，随后使用已保存的系统代理或直连。', 'Account proxies take priority over pool proxies, followed by the saved system-proxy or direct route.')
  const visuallyFailed = takeover?.phase === 'failed'
    || takeover?.phase === 'blocked'
    || takeover?.phase === 'inconsistent'

  return <section className={`panel built-in-proxy-master ${status === 'error' || visuallyFailed ? 'built-in-proxy-master--error' : ''}`}>
    <div className="built-in-proxy-master__identity">
      <span className="built-in-proxy-master__icon"><Power size={21} /></span>
      <div>
        <div className="built-in-proxy-master__title">
          <h2>{t('内置代理', 'Built-in proxy')}</h2>
          {runtime && <Badge tone={badgeTone}>{busy && <LoaderCircle size={12} className="spin" />}{statusLabel}</Badge>}
        </div>
        <p>{description}</p>
      </div>
    </div>
    {loadError ? <button className="button button--secondary" type="button" onClick={onReload}><RefreshCw size={15} />{t('重试读取', 'Retry')}</button> : <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? t('关闭内置代理', 'Disable built-in proxy') : t('开启内置代理', 'Enable built-in proxy')}
      className={`built-in-proxy-master__switch ${checked ? 'is-on' : ''}`}
      disabled={!runtime || busy}
      onClick={onToggle}
    >
      <span>{busy ? <LoaderCircle size={14} className="spin" /> : checked ? t('开启', 'On') : t('关闭', 'Off')}</span>
      <i aria-hidden="true" />
    </button>}
  </section>
}

function RuntimeError({ runtime, busy, onRetry, t }: {
  runtime: BuiltInProxyRuntimeState
  busy: boolean
  onRetry: () => void
  t: Translator
}) {
  if (!runtime.error) return null
  const takeover = resolveBuiltInProxyTakeoverPresentation(runtime)
  return <section className="built-in-proxy-runtime-error" role="alert">
    <ShieldAlert size={22} />
    <div>
      <strong>{errorCategoryLabel(runtime.error.category, t)}</strong>
      <p>{runtimeErrorMessage(runtime.error, t)}</p>
      <small>{takeover.phase === 'blocked'
        ? t('Stone+ 请求保持阻断，不会自动改用原代理或直连。', 'Stone+ requests remain blocked and will not automatically use the previous proxy or a direct connection.')
        : takeover.effectiveBuiltInRouteActive
          ? t('操作失败，但当前已发布的内置代次仍承担 Stone+ 新请求；重试不会自动改用直连。', 'The operation failed, but the published built-in generation still serves new Stone+ requests; retrying will not fall back to direct.')
        : t('此次接管没有成功应用；页面不会把计划中的 mixed/TUN 地址显示为已生效。', 'This takeover was not applied; the page will not show the planned mixed/TUN endpoint as active.')}</small>
    </div>
    {runtime.error.retryable && <button type="button" className="button button--secondary" disabled={busy} onClick={onRetry}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('重试', 'Retry')}
    </button>}
  </section>
}

export function resolveBuiltInProxyImportSourceKey(
  source: ImportSource,
  key: string,
): ImportSource | undefined {
  const index = importSources.indexOf(source)
  if (key === 'Home') return importSources[0]
  if (key === 'End') return importSources[importSources.length - 1]
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined
  const offset = key === 'ArrowLeft' ? -1 : 1
  return importSources[(index + offset + importSources.length) % importSources.length]
}

export function ImportPanel({
  compact = false,
  source,
  name,
  format,
  subscriptionUrl,
  subscriptionToken,
  content,
  busy,
  disabled,
  onSource,
  onName,
  onFormat,
  onSubscriptionUrl,
  onSubscriptionToken,
  onContent,
  onFile,
  onSubmit,
  t,
}: {
  compact?: boolean
  source: ImportSource
  name: string
  format: BuiltInProxyProfileFormat | ''
  subscriptionUrl: string
  subscriptionToken: string
  content: string
  busy: boolean
  disabled: boolean
  onSource: (source: ImportSource) => void
  onName: (name: string) => void
  onFormat: (format: BuiltInProxyProfileFormat | '') => void
  onSubscriptionUrl: (url: string) => void
  onSubscriptionToken: (token: string) => void
  onContent: (content: string) => void
  onFile: (event: ChangeEvent<HTMLInputElement>) => void
  onSubmit: (event: FormEvent) => void
  t: Translator
}) {
  const id = `built-in-proxy-import-${useId()}`
  const tabId = (value: ImportSource) => `${id}-tab-${value}`
  const panelId = (value: ImportSource) => `${id}-panel-${value}`
  const contentId = `${id}-configuration-content`
  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const next = resolveBuiltInProxyImportSourceKey(source, event.key)
    if (!next) return
    event.preventDefault()
    onSource(next)
    window.requestAnimationFrame(() => document.getElementById(tabId(next))?.focus())
  }
  return <section className={`panel built-in-proxy-import ${compact ? 'built-in-proxy-import--compact' : ''}`}>
    <div className="built-in-proxy-section-heading">
      <div><Upload size={18} /><span><strong>{compact ? t('导入更多配置', 'Import another profile') : t('导入配置', 'Import a profile')}</strong><small>{t('只解析受支持的节点、分组与规则，不运行外来 inbound、脚本或文件路径。', 'Only supported nodes, groups, and rules are parsed; foreign inbounds, scripts, and file paths are never executed.')}</small></span></div>
    </div>
    <form onSubmit={onSubmit}>
      <div className="built-in-proxy-tabs" role="tablist" aria-label={t('配置来源', 'Profile source')} aria-orientation="horizontal">
        <button id={tabId('subscription')} type="button" role="tab" aria-selected={source === 'subscription'} aria-controls={panelId('subscription')} tabIndex={source === 'subscription' ? 0 : -1} className={source === 'subscription' ? 'active' : ''} disabled={disabled || busy} onKeyDown={handleTabKey} onClick={() => onSource('subscription')}><Globe2 size={15} />{t('订阅', 'Subscription')}</button>
        <button id={tabId('import')} type="button" role="tab" aria-selected={source === 'import'} aria-controls={panelId('import')} tabIndex={source === 'import' ? 0 : -1} className={source === 'import' ? 'active' : ''} disabled={disabled || busy} onKeyDown={handleTabKey} onClick={() => onSource('import')}><FileCode2 size={15} />{t('文件 / 文本', 'File / text')}</button>
      </div>
      <div id={panelId(source)} className="built-in-proxy-import__fields" role="tabpanel" aria-labelledby={tabId(source)}>
        <label className="field"><span>{t('名称（可选）', 'Name (optional)')}</span><input value={name} disabled={disabled || busy} onChange={(event) => onName(event.target.value)} placeholder={t('例如：日常订阅', 'e.g. Daily subscription')} /></label>
        <label className="field"><span>{t('格式', 'Format')}</span><select value={format} disabled={disabled || busy} onChange={(event) => onFormat(event.target.value as BuiltInProxyProfileFormat | '')}><option value="">{t('自动识别', 'Auto-detect')}</option>{(Object.keys(profileFormatLabels) as BuiltInProxyProfileFormat[]).map((value) => <option key={value} value={value}>{t(...profileFormatLabels[value])}</option>)}</select></label>
        {source === 'subscription' ? <>
          <label className="field field--full"><span>{t('订阅 URL', 'Subscription URL')}</span><input className="mono" type="url" value={subscriptionUrl} disabled={disabled || busy} onChange={(event) => onSubscriptionUrl(event.target.value)} placeholder="https://example.com/subscription" /></label>
          <label className="field field--full"><span>{t('Token（可选）', 'Token (optional)')}</span><input type="password" autoComplete="new-password" value={subscriptionToken} disabled={disabled || busy} onChange={(event) => onSubscriptionToken(event.target.value)} /><small>{t('URL 与 Token 会加密保存，之后不会返回到页面。', 'The URL and token are encrypted and are not returned to the page later.')}</small></label>
        </> : <div className="field field--full"><label htmlFor={contentId}>{t('配置内容', 'Configuration content')}</label><textarea id={contentId} className="mono" rows={compact ? 4 : 7} value={content} disabled={disabled || busy} onChange={(event) => onContent(event.target.value)} placeholder={t('粘贴 sing-box JSON、Clash Meta YAML，或 Base64 / 明文 URI 列表', 'Paste sing-box JSON, Clash Meta YAML, or a Base64/plain URI list')} /><label className="built-in-proxy-file"><input type="file" accept=".json,.yaml,.yml,.txt,application/json,text/yaml,text/plain" disabled={disabled || busy} onChange={onFile} /><span className="built-in-proxy-file__trigger"><HardDriveUpload size={14} />{t('选择本地文件', 'Choose local file')}</span></label></div>}
      </div>
      <div className="built-in-proxy-import__footer">
        <span><ShieldCheck size={14} />{t('凭据使用系统安全存储加密', 'Credentials are encrypted with system secure storage')}</span>
        <button className="button button--primary" type="submit" disabled={disabled || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{t('校验并导入', 'Validate and import')}</button>
      </div>
    </form>
  </section>
}

function _ProfilePanel({ runtime, activeProfile, disabled, pending, locale, onSelect, onRefresh, onDelete, t }: {
  runtime: BuiltInProxyRuntimeState
  activeProfile?: BuiltInProxyProfileSummary
  disabled: boolean
  pending: Set<string>
  locale: string
  onSelect: (profileId: string) => void
  onRefresh: (profileId: string) => void
  onDelete: (profile: BuiltInProxyProfileSummary) => void
  t: Translator
}) {
  return <section className="panel built-in-proxy-profiles">
    <div className="built-in-proxy-section-heading">
      <div><FileCode2 size={18} /><span><strong>{t('配置', 'Profiles')}</strong><small>{t('同一时间只激活一份配置', 'One profile is active at a time')}</small></span></div>
      <Badge tone="neutral">{runtime.profiles.length}</Badge>
    </div>
    <div className="built-in-proxy-profile-list">
      {runtime.profiles.map((profile) => {
        const active = activeProfile?.id === profile.id
        const refreshing = pending.has(`refresh-profile-${profile.id}`)
        const selecting = pending.has(`select-profile-${profile.id}`)
        return <div className={`built-in-proxy-profile ${active ? 'is-active' : ''}`} key={profile.id}>
          <button type="button" className="built-in-proxy-profile__select" disabled={disabled || selecting} onClick={() => onSelect(profile.id)}>
            <span className="built-in-proxy-profile__check">{selecting ? <LoaderCircle size={13} className="spin" /> : active ? <Check size={13} /> : null}</span>
            <span><strong>{profile.name}</strong><small>{t(...profileFormatLabels[profile.format])} · {t(`${profile.nodeCount} 个节点`, `${profile.nodeCount} node(s)`)} · {relativeTime(profile.lastRefreshAt ?? profile.updatedAt, locale)}</small></span>
          </button>
          <div className="built-in-proxy-profile__actions">
            {profile.ruleStatus === 'fallback' && <Badge tone="warning">{t('规则降级', 'Rule fallback')}</Badge>}
            {profile.source === 'subscription' && <button type="button" className="icon-button" title={t('刷新订阅', 'Refresh subscription')} disabled={disabled || refreshing} onClick={() => onRefresh(profile.id)}>{refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button>}
            <button type="button" className="icon-button icon-button--danger" title={t('删除配置', 'Delete profile')} disabled={disabled} onClick={() => onDelete(profile)}><Trash2 size={15} /></button>
          </div>
        </div>
      })}
    </div>
  </section>
}

function _RouteStatusPanel({ runtime, profile, t }: {
  runtime: BuiltInProxyRuntimeState
  profile?: BuiltInProxyProfileSummary
  t: Translator
}) {
  const route = runtime.effectiveRoute
  const activeNode = profile?.nodes.find((node) => node.id === route.nodeId)
  const takeover = resolveBuiltInProxyTakeoverPresentation(runtime)
  const active = takeover.phase === 'ready'
  const blocked = takeover.phase === 'blocked'
  const statusLabel = active
    ? t('已原子切换', 'Atomically active')
    : blocked
      ? t('已阻断', 'Blocked')
      : takeover.phase === 'starting'
        ? t('准备中', 'Preparing')
        : takeover.phase === 'restoring'
          ? t('恢复中', 'Restoring')
          : takeover.phase === 'failed'
            ? t('未接管', 'Not applied')
            : takeover.phase === 'inconsistent'
              ? t('状态未确认', 'State unconfirmed')
              : t('未启用', 'Inactive')
  const inactiveMessage = takeover.phase === 'blocked'
    ? t('当前没有可用的内置出口，新请求已阻断，不会绕过代理直连。', 'No built-in exit is available; new requests are blocked and will not bypass the proxy with a direct connection.')
    : takeover.phase === 'starting'
      ? t('正在检查核心与接入方式；完成前不会显示或发布 mixed/TUN 接管链路。', 'The core and access mode are being checked; no mixed/TUN takeover path is shown or published until both are ready.')
      : takeover.phase === 'restoring'
        ? t('正在恢复系统接入与原外部路由，完成前不把此状态标记为已接管。', 'System access and the previous external route are being restored; this state is not marked as active takeover.')
        : takeover.phase === 'failed'
          ? t('接入方式未成功应用。下方地址仅是计划目标，并非当前系统代理或 TUN 状态。', 'The access mode was not applied. The address below is only the planned target, not the current system-proxy or TUN state.')
          : takeover.phase === 'inconsistent'
            ? t('生命周期、接入方式与路由代次不一致，已隐藏可能误导的出口链路。', 'Lifecycle, access mode, and route generation disagree, so the potentially misleading exit path is hidden.')
            : t('内置代理没有接管请求。', 'The built-in proxy is not taking over requests.')
  return <section className={`panel built-in-proxy-route ${active ? 'is-ready' : blocked ? 'is-blocked' : ''}`}>
    <div className="built-in-proxy-section-heading">
      <div><Router size={18} /><span><strong>{t('当前接管', 'Current takeover')}</strong><small>{t(`路由代次 ${route.generation}`, `Route generation ${route.generation}`)}</small></span></div>
      <Badge tone={active ? 'success' : blocked || takeover.phase === 'failed' || takeover.phase === 'inconsistent' ? 'danger' : 'warning'}>{statusLabel}</Badge>
    </div>
    {active ? <div className="built-in-proxy-route__path">
      <span><Laptop size={16} />Stone+</span><i />
      <span><Network size={16} />{route.kind === 'built-in-tun' ? 'TUN' : `mixed · 127.0.0.1:${takeover.mixedPort}`}</span><i />
      <span><Globe2 size={16} />{activeNode?.name ?? t('等待节点', 'Waiting for node')}</span>
    </div> : <div className={`built-in-proxy-route__inactive built-in-proxy-route__inactive--${takeover.phase}`}>
      {blocked ? <ShieldAlert size={19} /> : takeover.phase === 'failed' || takeover.phase === 'inconsistent' ? <CircleAlert size={19} /> : <Clock3 size={19} />}
      <span><strong>{statusLabel}</strong><small>{inactiveMessage}</small></span>
    </div>}
    {active && <p>{t('全部 Stone+ 新请求使用此代次；切换前的旧请求可在原代次完成。', 'All new Stone+ requests use this generation; requests started before the switch may finish on the previous generation.')}</p>}
    {runtime.coreVersion && <small className="built-in-proxy-route__core">sing-box {runtime.coreVersion}</small>}
  </section>
}

function _NodePanel({ profile, nodes, groups, hasUngroupedNodes, groupFilter, collapsed, disabled, pending, locale, onGroup, onToggleCollapsed, onSelect, onTest, t }: {
  profile?: BuiltInProxyProfileSummary
  nodes: BuiltInProxyNodeSummary[]
  groups: string[]
  hasUngroupedNodes: boolean
  groupFilter: string
  collapsed: boolean
  disabled: boolean
  pending: Set<string>
  locale: string
  onGroup: (group: string) => void
  onToggleCollapsed: () => void
  onSelect: (profileId: string, nodeId: string) => void
  onTest: (profile: BuiltInProxyProfileSummary, nodeIds?: string[]) => void
  t: Translator
}) {
  if (!profile) return null
  const activeNode = profile.nodes.find((node) => node.id === profile.activeNodeId)
  const selectedGroup = groupFilter === 'all'
    ? t('全部', 'All')
    : groupFilter === '__ungrouped__'
      ? t('未分组', 'Ungrouped')
      : groupFilter
  return <section className="panel panel--flush built-in-proxy-nodes">
    <div className="built-in-proxy-section-heading built-in-proxy-nodes__heading">
      <button
        type="button"
        className="built-in-proxy-nodes__toggle"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        <Zap size={18} />
        <span>
          <strong>{t('节点与分组', 'Nodes and groups')}</strong>
          <small>{t(
            `当前：${activeNode?.name ?? '等待节点'} · ${selectedGroup}`,
            `Current: ${activeNode?.name ?? 'Waiting for node'} · ${selectedGroup}`,
          )}</small>
        </span>
        <ChevronDown size={16} className={collapsed ? 'is-collapsed' : ''} />
      </button>
      {!collapsed && <button type="button" className="button button--secondary" disabled={disabled || pending.has(`latency-${profile.id}`)} onClick={() => onTest(profile)}>{pending.has(`latency-${profile.id}`) ? <LoaderCircle size={15} className="spin" /> : <Gauge size={15} />}{t('测试全部延迟', 'Test all latency')}</button>}
    </div>
    {!collapsed && <>
    {(groups.length > 0 || hasUngroupedNodes) && <div className="built-in-proxy-group-filter" aria-label={t('节点分组', 'Node groups')}>
      <button type="button" className={groupFilter === 'all' ? 'active' : ''} onClick={() => onGroup('all')}>{t('全部', 'All')}<span>{profile.nodeCount}</span></button>
      {groups.map((group) => <button type="button" key={group} className={groupFilter === group ? 'active' : ''} onClick={() => onGroup(group)}>{group}<span>{profile.nodes.filter((node) => node.groupIds.includes(group)).length}</span></button>)}
      {hasUngroupedNodes && <button type="button" className={groupFilter === '__ungrouped__' ? 'active' : ''} onClick={() => onGroup('__ungrouped__')}>{t('未分组', 'Ungrouped')}<span>{profile.nodes.filter((node) => node.groupIds.length === 0).length}</span></button>}
    </div>}
    <div className="table-wrap">
      <table className="data-table built-in-proxy-node-table">
        <thead><tr><th>{t('节点', 'Node')}</th><th>{t('分组', 'Groups')}</th><th>{t('延迟', 'Latency')}</th><th>{t('最近测试', 'Last tested')}</th><th aria-label={t('操作', 'Actions')} /></tr></thead>
        <tbody>{nodes.map((node) => {
          const active = profile.activeNodeId === node.id
          const selecting = pending.has(`select-node-${node.id}`)
          const testing = pending.has(`latency-${node.id}`) || node.latencyStatus === 'testing'
          return <tr key={node.id} className={active ? 'is-active' : ''}>
            <td><div className="built-in-proxy-node-name"><span className="built-in-proxy-node-name__radio">{selecting || testing && node.latencyStatus === 'testing' ? <LoaderCircle size={13} className="spin" /> : active ? <Check size={13} /> : null}</span><div><strong>{node.name}</strong><small>{node.type}</small></div>{active && <Badge tone="success">{t('使用中', 'Active')}</Badge>}</div></td>
            <td><div className="built-in-proxy-node-groups">{node.groupIds.length ? node.groupIds.map((group) => <span key={group}>{group}</span>) : <span>{t('未分组', 'Ungrouped')}</span>}</div></td>
            <td><LatencyBadge node={node} t={t} /></td>
            <td>{relativeTime(node.lastTestedAt, locale)}</td>
            <td className="actions-cell"><button type="button" className="icon-button" title={t('测试此节点延迟', 'Test this node latency')} disabled={disabled || testing} onClick={() => onTest(profile, [node.id])}>{testing ? <LoaderCircle size={15} className="spin" /> : <Gauge size={15} />}</button><button type="button" className={`button ${active ? 'button--secondary' : 'button--primary'} built-in-proxy-node-use`} disabled={disabled || active || selecting} onClick={() => onSelect(profile.id, node.id)}>{active ? t('已选择', 'Selected') : t('使用', 'Use')}</button></td>
          </tr>
        })}</tbody>
      </table>
      {nodes.length === 0 && <div className="built-in-proxy-empty-row"><Unplug size={21} /><span>{t('此分组没有节点', 'No nodes in this group')}</span></div>}
    </div>
    {(profile.warning || profile.ruleStatus === 'fallback') && <div className="built-in-proxy-rule-warning"><AlertTriangle size={16} /><span>{profile.warning ?? t('订阅规则无法安全转换，已使用“私网直连、中国大陆直连、其余走选中节点”的内置规则。', 'Subscription rules could not be converted safely. The built-in private/direct-mainland-China/selected-node fallback is active.')}</span></div>}
    </>}
  </section>
}

export interface EditableRuleDraft {
  id: string
  condition: BuiltInProxyRuleCondition
  valueText: string
  action: BuiltInProxyRuleAction
}

const ruleConditionLabels: Record<BuiltInProxyRuleCondition, readonly [string, string]> = {
  domain: ['完整域名', 'Exact domain'],
  'domain-suffix': ['域名后缀', 'Domain suffix'],
  'domain-keyword': ['域名关键词', 'Domain keyword'],
  'ip-cidr': ['IP / CIDR', 'IP / CIDR'],
  port: ['端口', 'Port'],
  'port-range': ['端口范围', 'Port range'],
  network: ['网络协议', 'Network'],
  protocol: ['应用协议', 'Application protocol'],
  'private-network': ['私有网络', 'Private network'],
  'mainland-china': ['中国大陆', 'Mainland China'],
}

const ruleActionLabels: Record<BuiltInProxyRuleAction, readonly [string, string]> = {
  proxy: ['代理', 'Proxy'],
  direct: ['直连', 'Direct'],
  block: ['阻断', 'Block'],
}

const noValueConditions = new Set<BuiltInProxyRuleCondition>(['private-network', 'mainland-china'])
const commonApplicationProtocols = ['http', 'tls', 'quic', 'dns', 'stun', 'ntp', 'bittorrent', 'dtls', 'ssh', 'rdp'] as const

export function splitBuiltInProxyRuleValues(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))]
}

function customRulesToDraft(rules?: BuiltInProxyCustomRuleSet): EditableRuleDraft[] {
  return (rules?.rules ?? []).map((rule) => ({
    id: rule.id,
    condition: rule.condition,
    valueText: rule.values.join(', '),
    action: rule.action,
  }))
}

function createRuleDraft(condition: BuiltInProxyRuleCondition = 'domain-suffix'): EditableRuleDraft {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { id: `rule-${suffix}`, condition, valueText: '', action: 'proxy' }
}

export function buildBuiltInProxyCustomRuleSet(
  drafts: readonly EditableRuleDraft[],
  finalAction: BuiltInProxyCustomRuleSet['finalAction'],
): BuiltInProxyCustomRuleSet | null {
  const rules: BuiltInProxyEditableRule[] = []
  for (const draft of drafts) {
    const values = noValueConditions.has(draft.condition)
      ? []
      : splitBuiltInProxyRuleValues(draft.valueText).map((value) => draft.condition === 'port-range'
        ? value.replace(/^(\d+)\s*-\s*(\d+)$/u, '$1:$2')
        : value)
    if (!noValueConditions.has(draft.condition) && values.length === 0) return null
    rules.push({ id: draft.id, condition: draft.condition, values, action: draft.action })
  }
  return { rules, finalAction }
}

export function shouldSyncBuiltInProxyRuleDraft(
  serverSignature: string,
  baselineSignature: string,
  dirty: boolean,
): boolean {
  return !dirty && serverSignature !== baselineSignature
}

export function ModePanel({ runtime, profile, disabled, pending, onMode, onCustomRules, t }: {
  runtime: BuiltInProxyRuntimeState
  profile?: BuiltInProxyProfileSummary
  disabled: boolean
  pending: boolean
  onMode: (mode: BuiltInProxyRuleMode) => void
  onCustomRules: (rules: BuiltInProxyCustomRuleSet | null) => Promise<boolean>
  t: Translator
}) {
  const serverRules = runtime.settings.customRules
  const serverSignature = JSON.stringify(serverRules ?? null)
  const [baselineSignature, setBaselineSignature] = useState(serverSignature)
  const [editorMode, setEditorMode] = useState<'profile' | 'custom'>(serverRules ? 'custom' : 'profile')
  const [drafts, setDrafts] = useState<EditableRuleDraft[]>(() => customRulesToDraft(serverRules))
  const [finalAction, setFinalAction] = useState<BuiltInProxyCustomRuleSet['finalAction']>(serverRules?.finalAction ?? 'proxy')
  const [dirty, setDirty] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)

  useEffect(() => {
    if (!shouldSyncBuiltInProxyRuleDraft(serverSignature, baselineSignature, dirty)) return
    setBaselineSignature(serverSignature)
    setEditorMode(serverRules ? 'custom' : 'profile')
    setDrafts(customRulesToDraft(serverRules))
    setFinalAction(serverRules?.finalAction ?? 'proxy')
    setDirty(false)
    setValidationError(null)
  }, [baselineSignature, dirty, serverRules, serverSignature])

  const updateDraft = (id: string, update: (draft: EditableRuleDraft) => EditableRuleDraft) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? update(draft) : draft))
    setDirty(true)
    setValidationError(null)
  }
  const moveDraft = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= drafts.length) return
    setDrafts((current) => {
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setDirty(true)
  }
  const discardDraft = () => {
    setEditorMode(serverRules ? 'custom' : 'profile')
    setDrafts(customRulesToDraft(serverRules))
    setFinalAction(serverRules?.finalAction ?? 'proxy')
    setDirty(false)
    setValidationError(null)
  }
  const saveDraft = async () => {
    const ruleSet = buildBuiltInProxyCustomRuleSet(drafts, finalAction)
    if (!ruleSet) {
      setValidationError(t('请填写每条规则的匹配值。多个值可用逗号或换行分隔。', 'Enter match values for every rule. Separate multiple values with commas or new lines.'))
      return
    }
    if (await onCustomRules(ruleSet)) setDirty(false)
  }
  const chooseProfileRules = () => {
    if (serverRules || dirty) setConfirmRestore(true)
    else discardDraft()
  }
  const restoreProfileRules = async () => {
    if (serverRules && !await onCustomRules(null)) return
    setBaselineSignature(JSON.stringify(null))
    setEditorMode('profile')
    setDrafts([])
    setFinalAction('proxy')
    setDirty(false)
    setValidationError(null)
    setConfirmRestore(false)
  }

  return <section className="panel built-in-proxy-mode">
    <div className="built-in-proxy-section-heading"><div><Wifi size={18} /><span><strong>{t('规则模式', 'Routing mode')}</strong><small>{t('只影响内置代理，不修改原外部网络设置', 'Affects only the built-in proxy; the saved external setting is unchanged')}</small></span></div></div>
    <div className="built-in-proxy-choice-grid">
      {(Object.keys(ruleModeLabels) as BuiltInProxyRuleMode[]).map((mode) => {
        const selected = runtime.settings.ruleMode === mode
        const label = ruleModeLabels[mode]
        return <button type="button" key={mode} className={selected ? 'is-selected' : ''} aria-pressed={selected} disabled={disabled} onClick={() => onMode(mode)}><span>{selected && <Check size={13} />}</span><strong>{t(label[0], label[1])}</strong><small>{t(label[2], label[3])}</small></button>
      })}
    </div>
    {runtime.settings.ruleMode === 'rule' && <div className="built-in-proxy-rule-editor">
      <div className="built-in-proxy-rule-source" role="group" aria-label={t('规则来源', 'Rule source')}>
        <button type="button" className={editorMode === 'profile' ? 'active' : ''} aria-pressed={editorMode === 'profile'} disabled={disabled || pending} onClick={chooseProfileRules}>
          <strong>{t('使用配置规则', 'Use profile rules')}</strong>
          <small>{profile?.ruleStatus === 'preserved' ? t('订阅规则已安全保留', 'Imported rules preserved') : t('使用安全内置规则', 'Use safe built-in rules')}</small>
        </button>
        <button type="button" className={editorMode === 'custom' ? 'active' : ''} aria-pressed={editorMode === 'custom'} disabled={disabled || pending} onClick={() => {
          if (editorMode === 'custom') return
          setEditorMode('custom')
          setDirty(true)
        }}>
          <strong>{t('自定义规则', 'Custom rules')}</strong>
          <small>{t(`${drafts.length} 条有序规则`, `${drafts.length} ordered rule(s)`)}</small>
        </button>
      </div>
      {editorMode === 'profile' && <div className="built-in-proxy-mode__preserved"><ShieldCheck size={15} />{profile?.ruleStatus === 'preserved'
        ? t('请求将按当前配置中的规则从上到下匹配', 'Requests match the current profile rules from top to bottom')
        : t('使用“私网直连、中国大陆直连、其余代理”的安全规则', 'Uses the safe private-direct, mainland-direct, otherwise-proxy policy')}</div>}
      {editorMode === 'custom' && <>
        <div className="built-in-proxy-rule-editor__hint">{t('自定义规则是所有配置共用的全局设置；从上到下匹配，命中第一条后停止。切换到全局或直连模式不会删除已保存规则。', 'Custom rules are a global setting shared by every profile. They run top to bottom and stop after the first match. Switching to Global or Direct mode keeps them saved.')}</div>
        <div className="built-in-proxy-rule-list">
          {drafts.map((draft, index) => <div className="built-in-proxy-rule-row" key={draft.id}>
            <span className="built-in-proxy-rule-row__order">{index + 1}</span>
            <select aria-label={t(`规则 ${index + 1} 条件`, `Rule ${index + 1} condition`)} value={draft.condition} disabled={disabled || pending} onChange={(event) => updateDraft(draft.id, (current) => ({ ...current, condition: event.target.value as BuiltInProxyRuleCondition, valueText: '' }))}>
              {(Object.keys(ruleConditionLabels) as BuiltInProxyRuleCondition[]).map((condition) => <option key={condition} value={condition}>{t(...ruleConditionLabels[condition])}</option>)}
            </select>
            <RuleValueEditor draft={draft} label={t(`规则 ${index + 1} 匹配值`, `Rule ${index + 1} match values`)} disabled={disabled || pending} onChange={(valueText) => updateDraft(draft.id, (current) => ({ ...current, valueText }))} t={t} />
            <div className="built-in-proxy-rule-actions" role="group" aria-label={t(`规则 ${index + 1} 动作`, `Rule ${index + 1} action`)}>
              {(Object.keys(ruleActionLabels) as BuiltInProxyRuleAction[]).map((action) => <button type="button" key={action} className={draft.action === action ? `active action-${action}` : ''} aria-pressed={draft.action === action} disabled={disabled || pending} onClick={() => updateDraft(draft.id, (current) => ({ ...current, action }))}>{t(...ruleActionLabels[action])}</button>)}
            </div>
            <div className="built-in-proxy-rule-row__controls">
              <button type="button" className="icon-button" title={t('上移', 'Move up')} disabled={disabled || pending || index === 0} onClick={() => moveDraft(index, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="icon-button" title={t('下移', 'Move down')} disabled={disabled || pending || index === drafts.length - 1} onClick={() => moveDraft(index, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="icon-button built-in-proxy-rule-delete" title={t('删除规则', 'Delete rule')} disabled={disabled || pending} onClick={() => { setDrafts((current) => current.filter((item) => item.id !== draft.id)); setDirty(true) }}><Trash2 size={14} /></button>
            </div>
          </div>)}
          {drafts.length === 0 && <div className="built-in-proxy-rule-empty">{t('还没有规则；所有流量将使用下方的默认动作。', 'No rules yet; all traffic uses the final action below.')}</div>}
        </div>
        <button type="button" className="button button--secondary built-in-proxy-rule-add" disabled={disabled || pending} onClick={() => { setDrafts((current) => [...current, createRuleDraft()]); setDirty(true) }}><Plus size={14} />{t('新增规则', 'Add rule')}</button>
        <div className="built-in-proxy-rule-final">
          <div><strong>{t('未匹配流量', 'Unmatched traffic')}</strong><small>{t('所有规则都未命中时执行', 'Used when no rule above matches')}</small></div>
          <div className="built-in-proxy-rule-actions" role="group" aria-label={t('未匹配流量动作', 'Unmatched traffic action')}>
            {(['proxy', 'direct'] as const).map((action) => <button type="button" key={action} className={finalAction === action ? `active action-${action}` : ''} aria-pressed={finalAction === action} disabled={disabled || pending} onClick={() => { setFinalAction(action); setDirty(true) }}>{t(...ruleActionLabels[action])}</button>)}
          </div>
        </div>
        {validationError && <div className="built-in-proxy-rule-validation" role="alert"><CircleAlert size={14} />{validationError}</div>}
        <div className="built-in-proxy-rule-editor__footer">
          <span>{dirty ? t('有未保存的修改', 'Unsaved changes') : t('自定义规则已保存', 'Custom rules saved')}</span>
          <div><button type="button" className="button button--secondary" disabled={disabled || pending || !dirty} onClick={discardDraft}>{t('放弃修改', 'Discard')}</button><button type="button" className="button button--primary" disabled={disabled || pending || !dirty} onClick={() => void saveDraft()}>{pending && <LoaderCircle size={14} className="spin" />}{t('保存规则', 'Save rules')}</button></div>
        </div>
      </>}
      <ConfirmDialog
        open={confirmRestore}
        title={t('恢复配置规则？', 'Restore profile rules?')}
        message={serverRules
          ? t('已保存的自定义规则及未保存修改将被移除，随后恢复当前配置的订阅规则或安全内置规则。', 'Saved custom rules and unsaved edits will be removed, then the current profile or safe built-in rules will be restored.')
          : t('未保存的自定义规则将被放弃，并继续使用当前配置的订阅规则或安全内置规则。', 'Unsaved custom rules will be discarded and the current profile or safe built-in rules will remain active.')}
        confirmLabel={t('恢复配置规则', 'Restore profile rules')}
        busy={pending}
        onCancel={() => setConfirmRestore(false)}
        onConfirm={() => void restoreProfileRules()}
      />
    </div>}
  </section>
}

function RuleValueEditor({ draft, label, disabled, onChange, t }: {
  draft: EditableRuleDraft
  label: string
  disabled: boolean
  onChange: (value: string) => void
  t: Translator
}) {
  if (noValueConditions.has(draft.condition)) {
    return <div className="built-in-proxy-rule-value built-in-proxy-rule-value--fixed">{draft.condition === 'private-network' ? t('自动匹配私网与本地地址', 'Matches private and local addresses') : t('自动匹配中国大陆地址与域名', 'Matches mainland China addresses and domains')}</div>
  }
  if (draft.condition === 'network') {
    const selected = splitBuiltInProxyRuleValues(draft.valueText)
    return <div className="built-in-proxy-rule-network" role="group" aria-label={t('网络协议', 'Network protocol')}>{(['tcp', 'udp'] as const).map((network) => <button type="button" key={network} className={selected.includes(network) ? 'active' : ''} aria-pressed={selected.includes(network)} disabled={disabled} onClick={() => onChange(selected.includes(network) ? selected.filter((item) => item !== network).join(', ') : [...selected, network].join(', '))}>{network.toUpperCase()}</button>)}</div>
  }
  if (draft.condition === 'protocol') {
    const selected = splitBuiltInProxyRuleValues(draft.valueText).map((protocol) => protocol.toLowerCase())
    const options = [...commonApplicationProtocols, ...selected.filter((protocol) => !commonApplicationProtocols.includes(protocol as typeof commonApplicationProtocols[number]))]
    return <div className="built-in-proxy-rule-protocols" role="group" aria-label={t('应用协议', 'Application protocol')}>{options.map((protocol) => <button type="button" key={protocol} className={selected.includes(protocol) ? 'active' : ''} aria-pressed={selected.includes(protocol)} disabled={disabled} onClick={() => onChange(selected.includes(protocol) ? selected.filter((item) => item !== protocol).join(', ') : [...selected, protocol].join(', '))}>{protocol.toUpperCase()}</button>)}</div>
  }
  const placeholders: Partial<Record<BuiltInProxyRuleCondition, readonly [string, string]>> = {
    domain: ['例如 api.example.com', 'e.g. api.example.com'],
    'domain-suffix': ['例如 example.com，可输入多个', 'e.g. example.com; multiple values allowed'],
    'domain-keyword': ['例如 video', 'e.g. video'],
    'ip-cidr': ['例如 10.0.0.0/8', 'e.g. 10.0.0.0/8'],
    port: ['例如 80, 443', 'e.g. 80, 443'],
    'port-range': ['例如 1000-2000 或 1000:2000', 'e.g. 1000-2000 or 1000:2000'],
  }
  const placeholder = placeholders[draft.condition] ?? ['', '']
  return <textarea rows={1} className="built-in-proxy-rule-value" aria-label={label} value={draft.valueText} disabled={disabled} placeholder={t(...placeholder)} onChange={(event) => onChange(event.target.value)} />
}

function _AccessPanel({ runtime, disabled, pending, actionError, onAccess, onLan, onAutoStart, t }: {
  runtime: BuiltInProxyRuntimeState
  disabled: boolean
  pending: Set<string>
  actionError: string | null
  onAccess: (mode: BuiltInProxyAccessMode) => void
  onLan: (enabled: boolean) => void
  onAutoStart: (enabled: boolean) => void
  t: Translator
}) {
  const takeover = resolveBuiltInProxyTakeoverPresentation(runtime)
  const switchingAccess = pending.has('access-mode-system') || pending.has('access-mode-tun')
  const changingLan = pending.has('lan')
  const plannedPort = takeover.phase === 'ready' && takeover.mixedPort !== undefined
    ? takeover.mixedPort
    : runtime.settings.mixedPort
  const accessStatus = switchingAccess || takeover.phase === 'starting' || runtime.accessState?.status === 'applying'
    ? t('正在应用', 'Applying')
    : takeover.phase === 'ready'
      ? runtime.settings.accessMode === 'system'
        ? t('已应用', 'Applied')
        : t('已运行', 'Running')
      : takeover.phase === 'restoring'
        ? t('正在恢复', 'Restoring')
        : takeover.phase === 'failed' || takeover.phase === 'blocked' || takeover.phase === 'inconsistent'
          ? runtime.settings.accessMode === 'system'
            ? t('未应用', 'Not applied')
            : t('未运行', 'Not running')
          : t('未启用', 'Inactive')
  const accessStatusTone = takeover.phase === 'ready'
    ? 'success'
    : takeover.phase === 'failed' || takeover.phase === 'blocked' || takeover.phase === 'inconsistent'
      ? 'danger'
      : 'warning'
  const runtimeAccessError = runtime.accessState?.status === 'error'
    || takeover.phase === 'failed' || takeover.phase === 'blocked' || takeover.phase === 'inconsistent'
    ? runtime.error
      ? runtimeErrorMessage(runtime.error, t)
      : t('尚未收到可验证的系统接入状态。', 'No verifiable system-access state has been received yet.')
    : undefined
  return <section className="panel built-in-proxy-access">
    <div className="built-in-proxy-section-heading"><div><ShieldCheck size={18} /><span><strong>{t('接入方式', 'Access mode')}</strong><small>{t('mixed 与控制接口默认仅监听回环', 'Mixed and controller endpoints listen on loopback by default')}</small></span></div></div>
    <div className="built-in-proxy-access__choices">
      {(Object.keys(accessModeLabels) as BuiltInProxyAccessMode[]).map((mode) => {
        const selected = runtime.settings.accessMode === mode
        const applying = pending.has(`access-mode-${mode}`)
        const label = accessModeLabels[mode]
        return <button type="button" key={mode} className={`${selected ? 'is-selected' : ''} ${applying ? 'is-pending' : ''}`} aria-pressed={selected} disabled={disabled || applying} onClick={() => onAccess(mode)}><span>{mode === 'system' ? <Network size={17} /> : <Router size={17} />}</span><div><strong>{t(label[0], label[1])}</strong><small>{t(label[2], label[3])}</small>{(selected || applying) && <em>{applying ? t('正在应用', 'Applying') : switchingAccess ? t('正在切换', 'Switching') : accessStatus}</em>}</div>{applying ? <LoaderCircle size={15} className="spin" /> : selected && <Check size={15} />}</button>
      })}
    </div>
    <div className={`built-in-proxy-access__endpoint ${takeover.phase === 'ready' ? 'is-applied' : 'is-unapplied'}`}>
      <span>{runtime.settings.accessMode === 'system' ? t('系统代理目标', 'System proxy target') : t('TUN 上游 mixed', 'TUN upstream mixed')}</span>
      <code>127.0.0.1:{plannedPort}</code>
      <Badge tone={accessStatusTone}>{accessStatus}</Badge>
    </div>
    <div className="built-in-proxy-access__endpoint built-in-proxy-access__endpoint--secondary">
      <span>{t('mixed 监听地址', 'Mixed listen address')}</span>
      <code>{runtime.settings.lanEnabled ? `0.0.0.0:${plannedPort}` : `127.0.0.1:${plannedPort}`}</code>
      <small>{takeover.phase === 'ready' ? t('运行中', 'Listening') : t('计划值', 'Planned')}</small>
    </div>
    {(actionError || runtimeAccessError) && <div className="built-in-proxy-access__error" role="status"><CircleAlert size={15} /><span><strong>{actionError && takeover.phase === 'ready'
      ? t('切换失败，已恢复原接入方式', 'Switch failed; the previous access mode was restored')
      : t('接入方式未就绪', 'Access mode is not ready')}</strong><small>{actionError ?? runtimeAccessError}</small></span></div>}
    <SettingToggle
      title={t('允许局域网访问', 'Allow LAN access')}
      description={changingLan
        ? t('正在重启 mixed 入口并恢复当前接入方式', 'Restarting the mixed endpoint and restoring the selected access mode')
        : runtime.settings.lanEnabled
          ? t('入口可能被同一网络中的设备访问', 'The endpoint may be reachable by devices on the same network')
          : t('仅本机可访问', 'Accessible only from this device')}
      checked={runtime.settings.lanEnabled}
      disabled={disabled || changingLan}
      busy={changingLan}
      warning={runtime.settings.lanEnabled}
      onChange={onLan}
      t={t}
    />
    <SettingToggle
      title={t('随 Stone+ 启动', 'Start with Stone+')}
      description={t('启动应用时恢复内置代理的期望开启状态', 'Restore the desired built-in proxy state when the app starts')}
      checked={runtime.settings.autoStart}
      disabled={disabled}
      onChange={onAutoStart}
      t={t}
    />
  </section>
}

function SettingToggle({ title, description, checked, disabled, busy = false, warning = false, onChange, t }: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  busy?: boolean
  warning?: boolean
  onChange: (checked: boolean) => void
  t: Translator
}) {
  return <div className={`built-in-proxy-setting ${warning ? 'built-in-proxy-setting--warning' : ''}`}>
    <div><strong>{title}</strong><small>{description}</small></div>
    <button type="button" role="switch" aria-checked={checked} aria-busy={busy || undefined} aria-label={checked ? t(`关闭${title}`, `Disable ${title}`) : t(`开启${title}`, `Enable ${title}`)} className={`toggle ${checked ? 'toggle--on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>{busy ? <LoaderCircle size={13} className="spin" /> : <span />}</button>
  </div>
}

function _TelemetryPanel({ traffic, connections, ready, refreshing, pending, locale, onRefresh, onClose, t }: {
  traffic: ProxyTrafficSnapshot | null
  connections: ProxyConnectionSummary[]
  ready: boolean
  refreshing: boolean
  pending: Set<string>
  locale: string
  onRefresh: () => void
  onClose: (id: string) => void
  t: Translator
}) {
  return <section className="panel panel--flush built-in-proxy-telemetry">
    <div className="built-in-proxy-section-heading built-in-proxy-telemetry__heading">
      <div><Activity size={18} /><span><strong>{t('流量与连接', 'Traffic and connections')}</strong><small>{ready ? t('数据每 3 秒刷新', 'Refreshes every 3 seconds') : t('核心 ready 后开始采集', 'Collection starts when the core is ready')}</small></span></div>
      <button type="button" className="icon-button" title={t('刷新流量与连接', 'Refresh traffic and connections')} disabled={!ready || refreshing || pending.size > 0} onClick={onRefresh}>{refreshing ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button>
    </div>
    <div className="built-in-proxy-traffic">
      <TrafficMetric icon={<ArrowDown size={17} />} label={t('下载速率', 'Download rate')} value={traffic ? `${formatBytes(traffic.downloadRateBytesPerSecond)}/s` : '—'} detail={traffic ? t(`累计 ${formatBytes(traffic.downloadBytes)}`, `${formatBytes(traffic.downloadBytes)} total`) : undefined} />
      <TrafficMetric icon={<ArrowUp size={17} />} label={t('上传速率', 'Upload rate')} value={traffic ? `${formatBytes(traffic.uploadRateBytesPerSecond)}/s` : '—'} detail={traffic ? t(`累计 ${formatBytes(traffic.uploadBytes)}`, `${formatBytes(traffic.uploadBytes)} total`) : undefined} />
      <TrafficMetric icon={<Activity size={17} />} label={t('活动连接', 'Active connections')} value={traffic ? String(traffic.activeConnections) : '—'} detail={traffic ? t(`累计 ${traffic.totalConnections}`, `${traffic.totalConnections} total`) : undefined} />
      <TrafficMetric icon={<Clock3 size={17} />} label={t('采集时间', 'Captured')} value={traffic ? relativeTime(traffic.capturedAt, locale) : '—'} />
    </div>
    <div className="table-wrap">
      <table className="data-table built-in-proxy-connection-table">
        <thead><tr><th>{t('目标', 'Destination')}</th><th>{t('网络', 'Network')}</th><th>{t('出口', 'Outbound')}</th><th>{t('流量', 'Traffic')}</th><th>{t('开始时间', 'Started')}</th><th aria-label={t('操作', 'Actions')} /></tr></thead>
        <tbody>{connections.map((connection) => {
          const closing = pending.has(`close-connection-${connection.id}`)
          return <tr key={connection.id}>
            <td><div className="built-in-proxy-connection-target"><strong className="mono">{connection.destination}</strong><small>{connection.source}</small></div></td>
            <td><Badge tone="neutral">{connection.network.toUpperCase()}{connection.protocol ? ` · ${connection.protocol}` : ''}</Badge></td>
            <td>{connection.outbound}</td>
            <td><span className="built-in-proxy-connection-bytes"><span><ArrowDown size={12} />{formatBytes(connection.downloadBytes)}</span><span><ArrowUp size={12} />{formatBytes(connection.uploadBytes)}</span></span></td>
            <td>{relativeTime(connection.startedAt, locale)}</td>
            <td className="actions-cell"><button type="button" className="icon-button icon-button--danger" title={t('关闭连接', 'Close connection')} disabled={closing || pending.size > 0} onClick={() => onClose(connection.id)}>{closing ? <LoaderCircle size={15} className="spin" /> : <XCircle size={15} />}</button></td>
          </tr>
        })}</tbody>
      </table>
      {connections.length === 0 && <div className="built-in-proxy-empty-row"><Unplug size={21} /><span>{ready ? t('当前没有活动连接', 'No active connections') : t('内置代理尚未 ready', 'The built-in proxy is not ready')}</span></div>}
    </div>
  </section>
}

function TrafficMetric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return <div className="built-in-proxy-traffic__metric"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</div></div>
}

function LatencyBadge({ node, t }: { node: BuiltInProxyNodeSummary; t: Translator }) {
  if (node.latencyStatus === 'testing') return <Badge tone="info"><LoaderCircle size={12} className="spin" />{t('测试中', 'Testing')}</Badge>
  if (node.latencyStatus === 'timeout') return <Badge tone="danger">{t('超时', 'Timeout')}</Badge>
  if (node.latencyStatus === 'error') return <Badge tone="danger">{t('失败', 'Error')}</Badge>
  if (node.latencyStatus === 'available' && node.latencyMs !== undefined) {
    return <Badge tone={node.latencyMs <= 200 ? 'success' : node.latencyMs <= 500 ? 'warning' : 'danger'}>{durationLabel(node.latencyMs)}</Badge>
  }
  return <Badge tone="neutral">{t('未测试', 'Untested')}</Badge>
}

export function errorCategoryLabel(category: NonNullable<BuiltInProxyRuntimeState['error']>['category'], t: Translator): string {
  const labels: Record<NonNullable<BuiltInProxyRuntimeState['error']>['category'], readonly [string, string]> = {
    'core-missing': ['缺少 sing-box 核心', 'sing-box core missing'],
    'core-integrity': ['核心完整性校验失败', 'Core integrity check failed'],
    'configuration-invalid': ['配置无效', 'Invalid configuration'],
    'node-handshake': ['节点握手失败', 'Node handshake failed'],
    'mixed-port': ['mixed 端口不可用', 'Mixed port unavailable'],
    // This category also covers a verified sidecar that failed to start, stop,
    // or remain alive. Do not mislabel every lifecycle failure as a UAC denial.
    'tun-elevation': ['TUN 接入失败', 'TUN access failed'],
    'subscription-update': ['订阅更新失败', 'Subscription update failed'],
    'system-proxy': ['系统代理接管失败', 'System proxy takeover failed'],
    'health-check': ['核心健康检查失败', 'Core health check failed'],
    'core-crashed': ['sing-box 意外退出', 'sing-box exited unexpectedly'],
    unknown: ['内置代理错误', 'Built-in proxy error'],
  }
  return t(...labels[category])
}

export function runtimeErrorMessage(
  error: NonNullable<BuiltInProxyRuntimeState['error']>,
  t: Translator,
): string {
  if (
    error.category === 'system-proxy'
    && /another proxy application|no longer points|changed or rejected/i.test(error.message)
  ) {
    return t(
      'Windows 或其他代理软件改写/拒绝了系统代理；请关闭其他软件的系统代理接管后重试。',
      error.message,
    )
  }
  return error.message
}

function formatFromFilename(filename: string): BuiltInProxyProfileFormat | '' {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) return 'sing-box-json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'clash-meta-yaml'
  if (lower.endsWith('.txt')) return 'uri-list'
  return ''
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** unit
  return `${scaled >= 100 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

function validProxyPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
}

function loopbackProxyEndpointPort(value: string | undefined): number | undefined {
  if (!value) return undefined
  try {
    const endpoint = new URL(value)
    if (
      endpoint.protocol !== 'http:'
      || endpoint.hostname !== '127.0.0.1'
      || endpoint.username
      || endpoint.password
      || endpoint.pathname !== '/'
      || endpoint.search
      || endpoint.hash
    ) return undefined
    const port = Number(endpoint.port)
    return validProxyPort(port) ? port : undefined
  } catch {
    return undefined
  }
}

export function errorMessage(cause: unknown, fallback: string, t?: Translator): string {
  if (cause instanceof Error && cause.message.trim()) {
    const category = (cause as Error & { category?: unknown }).category
    if (t && category === 'system-proxy') {
      return runtimeErrorMessage({ category, message: cause.message, retryable: true }, t)
    }
    return cause.message
  }
  if (cause && typeof cause === 'object') {
    const record = cause as { category?: unknown; message?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) {
      if (t && record.category === 'system-proxy') {
        return runtimeErrorMessage({ category: record.category, message: record.message, retryable: true }, t)
      }
      return record.message
    }
  }
  return fallback
}

type Translator = (zh: string, en: string) => string
