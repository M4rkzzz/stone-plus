import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type PropsWithChildren,
} from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Clock3,
  FileCode2,
  Gauge,
  Globe2,
  HardDriveUpload,
  Laptop,
  LoaderCircle,
  Network,
  Plus,
  Power,
  RefreshCw,
  Router,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
  Wifi,
  XCircle,
  Zap,
} from 'lucide-react'
import type {
  BuiltInProxyAccessMode,
  BuiltInProxyImportInput,
  BuiltInProxyNodeSummary,
  BuiltInProxyProfileFormat,
  BuiltInProxyProfileSummary,
  BuiltInProxyRuleMode,
  BuiltInProxyRuntimeState,
  GatewayApi,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '@shared/types'
import { useI18n } from '../i18n'
import { Badge, ConfirmDialog, durationLabel, relativeTime } from '../ui'
import '../built-in-proxy.css'

type ImportSource = BuiltInProxyImportInput['source']

const profileFormatLabels: Record<BuiltInProxyProfileFormat, readonly [string, string]> = {
  'sing-box-json': ['sing-box JSON', 'sing-box JSON'],
  'clash-meta-yaml': ['Clash Meta YAML', 'Clash Meta YAML'],
  'uri-list': ['URI 列表', 'URI list'],
}

const ruleModeLabels: Record<BuiltInProxyRuleMode, readonly [string, string, string, string]> = {
  rule: ['规则', 'Rule', '私网与中国大陆直连，其余请求使用选中节点。', 'Route private and mainland China traffic directly; use the selected node for everything else.'],
  global: ['全局', 'Global', '除必要的本地回环外，所有请求使用选中节点。', 'Use the selected node for all traffic except required local loopback traffic.'],
  direct: ['直连', 'Direct', '不通过节点转发，用于临时排查规则与节点问题。', 'Bypass the selected node temporarily to diagnose rules and node issues.'],
}

const accessModeLabels: Record<BuiltInProxyAccessMode, readonly [string, string, string, string]> = {
  system: ['系统代理', 'System proxy', '接管系统代理，同时让 Stone+ 新请求使用专属 mixed 路由。', 'Lease the system proxy and route new Stone+ requests through its dedicated mixed route.'],
  tun: ['TUN', 'TUN', '每次启动临时提权，覆盖不遵循系统代理的应用。', 'Request temporary elevation on every start and cover apps that ignore the system proxy.'],
}

export function BuiltInProxyView({
  api,
  initialState,
  children,
}: PropsWithChildren<{
  api: GatewayApi
  initialState?: BuiltInProxyRuntimeState
}>) {
  const { t, locale } = useI18n()
  const [runtime, setRuntime] = useState<BuiltInProxyRuntimeState | null>(initialState ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const pendingRef = useRef(new Set<string>())
  const [importSource, setImportSource] = useState<ImportSource>('subscription')
  const [importName, setImportName] = useState('')
  const [importFormat, setImportFormat] = useState<BuiltInProxyProfileFormat | ''>('')
  const [subscriptionUrl, setSubscriptionUrl] = useState('')
  const [subscriptionToken, setSubscriptionToken] = useState('')
  const [importContent, setImportContent] = useState('')
  const [deleteProfile, setDeleteProfile] = useState<BuiltInProxyProfileSummary | null>(null)
  const [confirmLan, setConfirmLan] = useState(false)
  const [groupFilter, setGroupFilter] = useState('all')
  const [traffic, setTraffic] = useState<ProxyTrafficSnapshot | null>(null)
  const [connections, setConnections] = useState<ProxyConnectionSummary[]>([])
  const [telemetryBusy, setTelemetryBusy] = useState(false)
  const telemetryInFlight = useRef(false)

  const acceptRuntime = useCallback((next: BuiltInProxyRuntimeState) => {
    setRuntime((current) => !current || next.routeGeneration >= current.routeGeneration ? next : current)
    setLoadError(null)
  }, [])

  const loadRuntime = useCallback(async () => {
    try {
      const next = await api.getBuiltInProxyState()
      acceptRuntime(next)
    } catch (cause) {
      setLoadError(errorMessage(cause, t('无法读取内置代理状态', 'Unable to read built-in proxy state.')))
    }
  }, [acceptRuntime, api, t])

  useEffect(() => {
    let mounted = true
    void api.getBuiltInProxyState().then((next) => {
      if (mounted) acceptRuntime(next)
    }).catch((cause: unknown) => {
      if (mounted) setLoadError(errorMessage(cause, t('无法读取内置代理状态', 'Unable to read built-in proxy state.')))
    })
    const unsubscribe = api.onBuiltInProxyState((next) => {
      if (mounted) acceptRuntime(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [acceptRuntime, api, t])

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
  ): Promise<boolean> => {
    if (!begin(key)) return false
    try {
      acceptRuntime(await operation())
      return true
    } catch (cause) {
      setActionError(errorMessage(cause, t('内置代理操作失败', 'The built-in proxy operation failed.')))
      return false
    } finally {
      finish(key)
    }
  }

  const runTask = async <T,>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (!begin(key)) return undefined
    try {
      return await operation()
    } catch (cause) {
      setActionError(errorMessage(cause, t('内置代理操作失败', 'The built-in proxy operation failed.')))
      return undefined
    } finally {
      finish(key)
    }
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
  const visibleNodes = useMemo(() => {
    if (!activeProfile || groupFilter === 'all') return activeProfile?.nodes ?? []
    if (groupFilter === '__ungrouped__') return activeProfile.nodes.filter((node) => node.groupIds.length === 0)
    return activeProfile.nodes.filter((node) => node.groupIds.includes(groupFilter))
  }, [activeProfile, groupFilter])
  const hasUngroupedNodes = Boolean(activeProfile?.nodes.some((node) => node.groupIds.length === 0))
  const routeReady = runtime?.status === 'ready'
    && (runtime.effectiveRoute.kind === 'built-in-mixed' || runtime.effectiveRoute.kind === 'built-in-tun')
  const firstRunWithoutProfile = Boolean(runtime && runtime.profiles.length === 0 && !runtime.settings.hasEverActivated)

  const refreshTelemetry = useCallback(async (reportError: boolean) => {
    if (telemetryInFlight.current) return
    telemetryInFlight.current = true
    if (reportError) setTelemetryBusy(true)
    try {
      const [nextTraffic, nextConnections] = await Promise.all([
        api.getBuiltInProxyTraffic(),
        api.listBuiltInProxyConnections(),
      ])
      setTraffic(nextTraffic)
      setConnections(nextConnections)
    } catch (cause) {
      if (reportError) setActionError(errorMessage(cause, t('无法读取流量与连接', 'Unable to read traffic and connections.')))
    } finally {
      telemetryInFlight.current = false
      if (reportError) setTelemetryBusy(false)
    }
  }, [api, t])

  useEffect(() => {
    if (!routeReady) return
    void refreshTelemetry(false)
    const timer = window.setInterval(() => void refreshTelemetry(false), 3_000)
    return () => window.clearInterval(timer)
  }, [refreshTelemetry, routeReady])

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
    try {
      const content = await file.text()
      setImportContent(content)
      if (!importName.trim()) setImportName(file.name.replace(/\.(json|ya?ml|txt)$/i, ''))
      if (!importFormat) setImportFormat(formatFromFilename(file.name))
    } catch (cause) {
      setActionError(errorMessage(cause, t('无法读取所选配置文件', 'Unable to read the selected configuration file.')))
    }
  }

  const testLatency = async (profile: BuiltInProxyProfileSummary, nodeIds?: string[]) => {
    const key = nodeIds?.length === 1 ? `latency-${nodeIds[0]}` : `latency-${profile.id}`
    const tested = await runTask(key, () => api.testBuiltInProxyLatency(profile.id, nodeIds))
    if (!tested) return
    const byId = new Map(tested.map((node) => [node.id, node]))
    setRuntime((current) => current ? {
      ...current,
      profiles: current.profiles.map((candidate) => candidate.id === profile.id ? {
        ...candidate,
        nodes: candidate.nodes.map((node) => byId.get(node.id) ?? node),
      } : candidate),
    } : current)
  }

  const closeConnection = async (connectionId: string) => {
    const key = `close-connection-${connectionId}`
    if (!begin(key)) return
    try {
      await api.closeBuiltInProxyConnection(connectionId)
      setConnections((current) => current.filter((connection) => connection.id !== connectionId))
      void refreshTelemetry(false)
    } catch (cause) {
      setActionError(errorMessage(cause, t('无法关闭连接', 'Unable to close the connection.')))
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
            '内置代理已经开启，但在配置通过校验并成功启动前，Stone+ 不会切换新请求。账号与号池的原代理绑定、系统代理或直连仍按原路由生效。',
            'The built-in proxy is enabled, but Stone+ will not switch new requests until a profile validates and starts successfully. Existing account/pool bindings and the saved system/direct route remain active.',
          ) : t(
            '内置代理曾经成功接管，但当前没有有效配置。Stone+ 新请求保持 fail-closed，不会自动回退到原代理或直连；请重新导入配置或关闭内置代理。',
            'The built-in proxy was previously active but no valid profile remains. New Stone+ requests stay fail-closed and will not fall back to the previous proxy or a direct connection; import a profile or disable the built-in proxy.',
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
        onSource={setImportSource}
        onName={setImportName}
        onFormat={setImportFormat}
        onSubscriptionUrl={setSubscriptionUrl}
        onSubscriptionToken={setSubscriptionToken}
        onContent={setImportContent}
        onFile={readImportFile}
        onSubmit={(event) => void submitImport(event)}
        t={t}
      />
    </>}

    {runtime && showBuiltIn && runtime.profiles.length > 0 && <>
      <div className="built-in-proxy__overview-grid">
        <ProfilePanel
          runtime={runtime}
          activeProfile={activeProfile}
          disabled={controlsDisabled}
          pending={pending}
          locale={locale}
          onSelect={(profileId) => { setGroupFilter('all'); void runStateAction(`select-profile-${profileId}`, () => api.selectBuiltInProxyProfile(profileId)) }}
          onRefresh={(profileId) => void runStateAction(`refresh-profile-${profileId}`, () => api.refreshBuiltInProxyProfile(profileId))}
          onDelete={(profile) => setDeleteProfile(profile)}
          t={t}
        />
        <RouteStatusPanel runtime={runtime} profile={activeProfile} t={t} />
      </div>

      <NodePanel
        profile={activeProfile}
        nodes={visibleNodes}
        groups={groups}
        hasUngroupedNodes={hasUngroupedNodes}
        groupFilter={groupFilter}
        disabled={controlsDisabled}
        pending={pending}
        locale={locale}
        onGroup={setGroupFilter}
        onSelect={(profileId, nodeId) => void runStateAction(`select-node-${nodeId}`, () => api.selectBuiltInProxyNode(profileId, nodeId))}
        onTest={(profile, nodeIds) => void testLatency(profile, nodeIds)}
        t={t}
      />

      <div className="built-in-proxy__settings-grid">
        <ModePanel
          runtime={runtime}
          profile={activeProfile}
          disabled={controlsDisabled}
          onMode={(mode) => void runStateAction(`rule-mode-${mode}`, () => api.setBuiltInProxyRuleMode(mode))}
          t={t}
        />
        <AccessPanel
          runtime={runtime}
          disabled={controlsDisabled}
          onAccess={(mode) => void runStateAction(`access-mode-${mode}`, () => api.setBuiltInProxyAccessMode(mode))}
          onLan={(enabled) => enabled ? setConfirmLan(true) : void runStateAction('lan', () => api.setBuiltInProxyLanEnabled(false))}
          onAutoStart={(enabled) => void runStateAction('auto-start', () => api.setBuiltInProxyAutoStart(enabled))}
          t={t}
        />
      </div>

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
        onSource={setImportSource}
        onName={setImportName}
        onFormat={setImportFormat}
        onSubscriptionUrl={setSubscriptionUrl}
        onSubscriptionToken={setSubscriptionToken}
        onContent={setImportContent}
        onFile={readImportFile}
        onSubmit={(event) => void submitImport(event)}
        t={t}
      />

      <TelemetryPanel
        traffic={traffic}
        connections={connections}
        ready={routeReady}
        refreshing={telemetryBusy}
        pending={pending}
        locale={locale}
        onRefresh={() => void refreshTelemetry(true)}
        onClose={(id) => void closeConnection(id)}
        t={t}
      />
    </>}

    <ConfirmDialog
      open={confirmLan}
      title={t('允许局域网访问？', 'Allow LAN access?')}
      message={t(
        '开启后，同一网络中的设备可能在没有额外认证的情况下访问此代理入口。请仅在可信局域网中使用。',
        'Devices on the same network may be able to use this proxy endpoint without additional authentication. Enable it only on a trusted LAN.',
      )}
      confirmLabel={t('确认开启', 'Enable LAN access')}
      busy={pending.has('lan')}
      onCancel={() => setConfirmLan(false)}
      onConfirm={() => void runStateAction('lan', () => api.setBuiltInProxyLanEnabled(true)).then((success) => success && setConfirmLan(false))}
    />
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
  const awaitingFirstProfile = Boolean(runtime?.desiredEnabled && runtime.profiles.length === 0 && !runtime.settings.hasEverActivated)
  const badgeTone = awaitingFirstProfile ? 'info' : status === 'ready' ? 'success' : status === 'error' ? 'danger' : status === 'starting' || status === 'stopping' ? 'warning' : 'neutral'
  const statusLabel = awaitingFirstProfile
    ? t('等待配置', 'Waiting for profile')
    : status === 'ready'
    ? t('已接管', 'Ready')
    : status === 'starting'
      ? t('正在启动', 'Starting')
      : status === 'stopping'
        ? t('正在恢复', 'Stopping')
        : status === 'error'
          ? t('错误 / 已阻断', 'Error / blocked')
          : t('已关闭', 'Off')
  const description = loadError
    ? loadError
    : !runtime
    ? t('正在确认当前路由，不会在状态未知时切换请求。', 'Confirming the current route; requests are not switched while state is unknown.')
    : runtime.desiredEnabled && runtime.profiles.length === 0
      ? runtime.settings.hasEverActivated
        ? t('当前缺少有效配置，新请求保持 fail-closed。', 'No valid profile remains; new requests stay fail-closed.')
        : t('等待导入有效配置，当前外部路由保持不变。', 'Waiting for a valid profile; the current external route remains unchanged.')
      : status === 'ready'
        ? t('Stone+ 新请求强制经过内置代理；原账号与号池绑定已保留并暂停。', 'New Stone+ requests are forced through the built-in proxy; account and pool bindings are preserved and paused.')
        : status === 'starting'
          ? t('核心健康后才会原子接管新请求。', 'New requests are taken over atomically only after the core is healthy.')
          : status === 'stopping'
            ? t('正在恢复原外部路由并排空旧连接，完成前继续保持接管。', 'Restoring the previous external route and draining old connections; takeover remains active until complete.')
            : status === 'error'
              ? t('请求保持 fail-closed，不会自动回退或直连泄漏。', 'Requests remain fail-closed; there is no automatic fallback or direct-connection leak.')
              : t('账号代理优先于号池代理，随后使用已保存的系统代理或直连。', 'Account proxies take priority over pool proxies, followed by the saved system-proxy or direct route.')

  return <section className={`panel built-in-proxy-master ${status === 'error' ? 'built-in-proxy-master--error' : ''}`}>
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
  return <section className="built-in-proxy-runtime-error" role="alert">
    <ShieldAlert size={22} />
    <div>
      <strong>{errorCategoryLabel(runtime.error.category, t)}</strong>
      <p>{runtime.error.message}</p>
      <small>{t('Stone+ 请求保持阻断，不会自动改用原代理或直连。', 'Stone+ requests remain blocked and will not automatically use the previous proxy or a direct connection.')}</small>
    </div>
    {runtime.error.retryable && <button type="button" className="button button--secondary" disabled={busy} onClick={onRetry}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('重试', 'Retry')}
    </button>}
  </section>
}

function ImportPanel({
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
  return <section className={`panel built-in-proxy-import ${compact ? 'built-in-proxy-import--compact' : ''}`}>
    <div className="built-in-proxy-section-heading">
      <div><Upload size={18} /><span><strong>{compact ? t('导入更多配置', 'Import another profile') : t('导入配置', 'Import a profile')}</strong><small>{t('只解析受支持的节点、分组与规则，不运行外来 inbound、脚本或文件路径。', 'Only supported nodes, groups, and rules are parsed; foreign inbounds, scripts, and file paths are never executed.')}</small></span></div>
    </div>
    <form onSubmit={onSubmit}>
      <div className="built-in-proxy-tabs" role="tablist" aria-label={t('配置来源', 'Profile source')}>
        <button type="button" role="tab" aria-selected={source === 'subscription'} className={source === 'subscription' ? 'active' : ''} disabled={disabled || busy} onClick={() => onSource('subscription')}><Globe2 size={15} />{t('订阅', 'Subscription')}</button>
        <button type="button" role="tab" aria-selected={source === 'import'} className={source === 'import' ? 'active' : ''} disabled={disabled || busy} onClick={() => onSource('import')}><FileCode2 size={15} />{t('文件 / 文本', 'File / text')}</button>
      </div>
      <div className="built-in-proxy-import__fields">
        <label className="field"><span>{t('名称（可选）', 'Name (optional)')}</span><input value={name} disabled={disabled || busy} onChange={(event) => onName(event.target.value)} placeholder={t('例如：日常订阅', 'e.g. Daily subscription')} /></label>
        <label className="field"><span>{t('格式', 'Format')}</span><select value={format} disabled={disabled || busy} onChange={(event) => onFormat(event.target.value as BuiltInProxyProfileFormat | '')}><option value="">{t('自动识别', 'Auto-detect')}</option>{(Object.keys(profileFormatLabels) as BuiltInProxyProfileFormat[]).map((value) => <option key={value} value={value}>{t(...profileFormatLabels[value])}</option>)}</select></label>
        {source === 'subscription' ? <>
          <label className="field field--full"><span>{t('订阅 URL', 'Subscription URL')}</span><input className="mono" type="url" value={subscriptionUrl} disabled={disabled || busy} onChange={(event) => onSubscriptionUrl(event.target.value)} placeholder="https://example.com/subscription" /></label>
          <label className="field field--full"><span>{t('Token（可选）', 'Token (optional)')}</span><input type="password" autoComplete="new-password" value={subscriptionToken} disabled={disabled || busy} onChange={(event) => onSubscriptionToken(event.target.value)} /><small>{t('URL 与 Token 会加密保存，之后不会返回到页面。', 'The URL and token are encrypted and are not returned to the page later.')}</small></label>
        </> : <div className="field field--full"><span>{t('配置内容', 'Configuration content')}</span><textarea className="mono" rows={compact ? 4 : 7} value={content} disabled={disabled || busy} onChange={(event) => onContent(event.target.value)} placeholder={t('粘贴 sing-box JSON、Clash Meta YAML，或 Base64 / 明文 URI 列表', 'Paste sing-box JSON, Clash Meta YAML, or a Base64/plain URI list')} /><label className="built-in-proxy-file"><input type="file" accept=".json,.yaml,.yml,.txt,application/json,text/yaml,text/plain" disabled={disabled || busy} onChange={onFile} /><HardDriveUpload size={14} />{t('选择本地文件', 'Choose local file')}</label></div>}
      </div>
      <div className="built-in-proxy-import__footer">
        <span><ShieldCheck size={14} />{t('凭据使用系统安全存储加密', 'Credentials are encrypted with system secure storage')}</span>
        <button className="button button--primary" type="submit" disabled={disabled || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{t('校验并导入', 'Validate and import')}</button>
      </div>
    </form>
  </section>
}

function ProfilePanel({ runtime, activeProfile, disabled, pending, locale, onSelect, onRefresh, onDelete, t }: {
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

function RouteStatusPanel({ runtime, profile, t }: {
  runtime: BuiltInProxyRuntimeState
  profile?: BuiltInProxyProfileSummary
  t: Translator
}) {
  const route = runtime.effectiveRoute
  const activeNode = profile?.nodes.find((node) => node.id === profile.activeNodeId)
  const active = runtime.status === 'ready' && (route.kind === 'built-in-mixed' || route.kind === 'built-in-tun')
  return <section className={`panel built-in-proxy-route ${active ? 'is-ready' : route.kind === 'blocked' ? 'is-blocked' : ''}`}>
    <div className="built-in-proxy-section-heading">
      <div><Router size={18} /><span><strong>{t('当前接管', 'Current takeover')}</strong><small>{t(`路由代次 ${route.generation}`, `Route generation ${route.generation}`)}</small></span></div>
      <Badge tone={active ? 'success' : route.kind === 'blocked' ? 'danger' : 'warning'}>{active ? t('已原子切换', 'Atomically active') : route.kind === 'blocked' ? t('已阻断', 'Blocked') : t('准备中', 'Preparing')}</Badge>
    </div>
    <div className="built-in-proxy-route__path">
      <span><Laptop size={16} />Stone+</span><i />
      <span><Network size={16} />{route.kind === 'built-in-tun' ? 'TUN' : `mixed · 127.0.0.1:${route.mixedPort ?? runtime.settings.mixedPort}`}</span><i />
      <span><Globe2 size={16} />{activeNode?.name ?? t('等待节点', 'Waiting for node')}</span>
    </div>
    <p>{active
      ? t('全部 Stone+ 新请求使用此代次；切换前的旧请求可在原代次完成。', 'All new Stone+ requests use this generation; requests started before the switch may finish on the previous generation.')
      : route.kind === 'blocked'
        ? t('当前没有可用的内置出口，新请求不会绕过代理直连。', 'No built-in exit is currently available, and new requests will not bypass the proxy with a direct connection.')
        : t('健康检查完成后才接管新请求。', 'New requests are taken over only after health checks pass.')}</p>
    {runtime.coreVersion && <small className="built-in-proxy-route__core">sing-box {runtime.coreVersion}</small>}
  </section>
}

function NodePanel({ profile, nodes, groups, hasUngroupedNodes, groupFilter, disabled, pending, locale, onGroup, onSelect, onTest, t }: {
  profile?: BuiltInProxyProfileSummary
  nodes: BuiltInProxyNodeSummary[]
  groups: string[]
  hasUngroupedNodes: boolean
  groupFilter: string
  disabled: boolean
  pending: Set<string>
  locale: string
  onGroup: (group: string) => void
  onSelect: (profileId: string, nodeId: string) => void
  onTest: (profile: BuiltInProxyProfileSummary, nodeIds?: string[]) => void
  t: Translator
}) {
  if (!profile) return null
  return <section className="panel panel--flush built-in-proxy-nodes">
    <div className="built-in-proxy-section-heading built-in-proxy-nodes__heading">
      <div><Zap size={18} /><span><strong>{t('节点与分组', 'Nodes and groups')}</strong><small>{t('选择一个全局节点，切换后原子更新新请求', 'Choose one global node; new requests switch atomically')}</small></span></div>
      <button type="button" className="button button--secondary" disabled={disabled || pending.has(`latency-${profile.id}`)} onClick={() => onTest(profile)}>{pending.has(`latency-${profile.id}`) ? <LoaderCircle size={15} className="spin" /> : <Gauge size={15} />}{t('测试全部延迟', 'Test all latency')}</button>
    </div>
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
  </section>
}

function ModePanel({ runtime, profile, disabled, onMode, t }: {
  runtime: BuiltInProxyRuntimeState
  profile?: BuiltInProxyProfileSummary
  disabled: boolean
  onMode: (mode: BuiltInProxyRuleMode) => void
  t: Translator
}) {
  return <section className="panel built-in-proxy-mode">
    <div className="built-in-proxy-section-heading"><div><Wifi size={18} /><span><strong>{t('规则模式', 'Routing mode')}</strong><small>{t('只影响内置代理，不修改原外部网络设置', 'Affects only the built-in proxy; the saved external setting is unchanged')}</small></span></div></div>
    <div className="built-in-proxy-choice-grid">
      {(Object.keys(ruleModeLabels) as BuiltInProxyRuleMode[]).map((mode) => {
        const selected = runtime.settings.ruleMode === mode
        const label = ruleModeLabels[mode]
        return <button type="button" key={mode} className={selected ? 'is-selected' : ''} aria-pressed={selected} disabled={disabled} onClick={() => onMode(mode)}><span>{selected && <Check size={13} />}</span><strong>{t(label[0], label[1])}</strong><small>{t(label[2], label[3])}</small></button>
      })}
    </div>
    {runtime.settings.ruleMode === 'rule' && profile?.ruleStatus === 'preserved' && <div className="built-in-proxy-mode__preserved"><ShieldCheck size={15} />{t('订阅规则已安全保留', 'Subscription rules were preserved safely')}</div>}
  </section>
}

function AccessPanel({ runtime, disabled, onAccess, onLan, onAutoStart, t }: {
  runtime: BuiltInProxyRuntimeState
  disabled: boolean
  onAccess: (mode: BuiltInProxyAccessMode) => void
  onLan: (enabled: boolean) => void
  onAutoStart: (enabled: boolean) => void
  t: Translator
}) {
  return <section className="panel built-in-proxy-access">
    <div className="built-in-proxy-section-heading"><div><ShieldCheck size={18} /><span><strong>{t('接入方式', 'Access mode')}</strong><small>{t('mixed 与控制接口默认仅监听回环', 'Mixed and controller endpoints listen on loopback by default')}</small></span></div></div>
    <div className="built-in-proxy-access__choices">
      {(Object.keys(accessModeLabels) as BuiltInProxyAccessMode[]).map((mode) => {
        const selected = runtime.settings.accessMode === mode
        const label = accessModeLabels[mode]
        return <button type="button" key={mode} className={selected ? 'is-selected' : ''} aria-pressed={selected} disabled={disabled} onClick={() => onAccess(mode)}><span>{mode === 'system' ? <Network size={17} /> : <Router size={17} />}</span><div><strong>{t(label[0], label[1])}</strong><small>{t(label[2], label[3])}</small></div>{selected && <Check size={15} />}</button>
      })}
    </div>
    <div className="built-in-proxy-access__endpoint"><span>{t('本地 mixed 入口', 'Local mixed endpoint')}</span><code>{runtime.settings.lanEnabled ? `0.0.0.0:${runtime.settings.mixedPort}` : `127.0.0.1:${runtime.settings.mixedPort}`}</code></div>
    <SettingToggle
      title={t('允许局域网访问', 'Allow LAN access')}
      description={runtime.settings.lanEnabled ? t('入口可能被同一网络中的设备访问', 'The endpoint may be reachable by devices on the same network') : t('仅本机可访问', 'Accessible only from this device')}
      checked={runtime.settings.lanEnabled}
      disabled={disabled}
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

function SettingToggle({ title, description, checked, disabled, warning = false, onChange, t }: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  warning?: boolean
  onChange: (checked: boolean) => void
  t: Translator
}) {
  return <div className={`built-in-proxy-setting ${warning ? 'built-in-proxy-setting--warning' : ''}`}>
    <div><strong>{title}</strong><small>{description}</small></div>
    <button type="button" role="switch" aria-checked={checked} aria-label={checked ? t(`关闭${title}`, `Disable ${title}`) : t(`开启${title}`, `Enable ${title}`)} className={`toggle ${checked ? 'toggle--on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
  </div>
}

function TelemetryPanel({ traffic, connections, ready, refreshing, pending, locale, onRefresh, onClose, t }: {
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

function errorCategoryLabel(category: NonNullable<BuiltInProxyRuntimeState['error']>['category'], t: Translator): string {
  const labels: Record<NonNullable<BuiltInProxyRuntimeState['error']>['category'], readonly [string, string]> = {
    'core-missing': ['缺少 sing-box 核心', 'sing-box core missing'],
    'core-integrity': ['核心完整性校验失败', 'Core integrity check failed'],
    'configuration-invalid': ['配置无效', 'Invalid configuration'],
    'node-handshake': ['节点握手失败', 'Node handshake failed'],
    'mixed-port': ['mixed 端口不可用', 'Mixed port unavailable'],
    'tun-elevation': ['TUN 提权失败', 'TUN elevation failed'],
    'subscription-update': ['订阅更新失败', 'Subscription update failed'],
    'system-proxy': ['系统代理接管失败', 'System proxy takeover failed'],
    'health-check': ['核心健康检查失败', 'Core health check failed'],
    'core-crashed': ['sing-box 意外退出', 'sing-box exited unexpectedly'],
    unknown: ['内置代理错误', 'Built-in proxy error'],
  }
  return t(...labels[category])
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback
}

type Translator = (zh: string, en: string) => string
