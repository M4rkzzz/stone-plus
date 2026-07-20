import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Save,
  Trash2,
} from 'lucide-react'
import { clientNativeProtocols } from '@shared/types'
import { listRouteSources, resolveRouteSource, type RouteSourceKind } from '@shared/route-sources'
import type { AppSnapshot, GatewayApi, Route, RouteClient } from '@shared/types'
import type { ActionRunner } from '../App'
import { clientBrandMeta as clientMeta } from '../brand-icons'
import { useI18n } from '../i18n'
import { Badge, EmptyState, gatewayBaseUrl, PageHeader, protocolLabels, Toggle } from '../ui'
import { setupPoolDisplayName } from '../system-generated-text'

type MappingRow = { id: string; source: string; target: string }

function randomToken(client: RouteClient) {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `stone_${client}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function routePath(route: Route) {
  if (route.inboundProtocol === 'anthropic-messages') return '/v1/messages'
  if (route.inboundProtocol === 'openai-responses') return '/v1/responses'
  if (route.inboundProtocol === 'openai-chat') return '/v1/chat/completions'
  return '/v1beta/models/{model}:generateContent'
}

function clientEnvironment(route: Route, baseUrl: string) {
  if (route.client === 'claude') return `ANTHROPIC_BASE_URL=${baseUrl}\nANTHROPIC_AUTH_TOKEN=${route.localToken}`
  if (route.client === 'codex') return `OPENAI_BASE_URL=${baseUrl}/v1\nOPENAI_API_KEY=${route.localToken}`
  return `GOOGLE_GEMINI_BASE_URL=${baseUrl}\nGEMINI_API_KEY=${route.localToken}`
}

function RouteEditor({
  route,
  snapshot,
  api,
  runAction,
  busy,
}: {
  route: Route
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busy: boolean
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(route)
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const syncedRouteSignature = useRef('')
  const meta = clientMeta[route.client]
  const routeSignature = JSON.stringify(route)

  useEffect(() => {
    // Snapshot polling creates a new route object even when its persisted data
    // has not changed. Do not let those refreshes overwrite an in-progress edit.
    if (syncedRouteSignature.current === routeSignature) return
    syncedRouteSignature.current = routeSignature
    setDraft(route)
    setMappings(Object.entries(route.modelMap).map(([source, target]) => ({ id: crypto.randomUUID(), source, target })))
  }, [route, routeSignature])

  const source = resolveRouteSource(draft.poolId, snapshot)
  const routeSources = listRouteSources(snapshot)
  const selectedSourceAvailable = routeSources.some((item) => item.id === draft.poolId)
  const sourceGroups: Array<{ kind: RouteSourceKind; label: string }> = [
    { kind: 'standard', label: t('普通号池', 'Standard pools') },
    { kind: 'relay-aggregate', label: t('聚合中转', 'Aggregate relays') },
    { kind: 'official-api', label: t('官方 API', 'Official APIs') },
    { kind: 'relay', label: t('中转站', 'Relays') },
  ]
  const baseUrl = gatewayBaseUrl(snapshot.gateway.host, snapshot.gateway.port)
  const endpoint = `${baseUrl}${routePath(draft)}`

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied(null), 1400)
  }

  const save = async () => {
    const modelMap = Object.fromEntries(mappings.filter((row) => row.source.trim() && row.target.trim()).map((row) => [row.source.trim(), row.target.trim()]))
    await runAction(`save-route-${route.id}`, () => api.updateRoute({ ...draft, modelMap }))
  }

  const toggleEnabled = async (enabled: boolean) => {
    const modelMap = Object.fromEntries(mappings.filter((row) => row.source.trim() && row.target.trim()).map((row) => [row.source.trim(), row.target.trim()]))
    const previous = draft
    const next = { ...draft, enabled, modelMap }
    setDraft(next)
    const success = await runAction(`toggle-route-${route.id}`, () => api.updateRoute(next))
    if (!success) setDraft(previous)
  }

  const hasChanges = JSON.stringify({ ...draft, modelMap: Object.fromEntries(mappings.map((row) => [row.source, row.target])) }) !== JSON.stringify(route)

  return (
    <article className={`route-editor ${!draft.enabled ? 'route-editor--disabled' : ''}`}>
      <header className="route-editor__header">
        <span className="client-logo route-client-brand"><img src={meta.icon} alt="" /></span>
        <div><h2>{meta.name}</h2><span>{protocolLabels[draft.inboundProtocol]}</span></div>
        <div className="route-editor__state"><span>{draft.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span><Toggle checked={draft.enabled} onChange={(value) => void toggleEnabled(value)} label={draft.enabled ? t(`停用 ${meta.name} 路由`, `Disable ${meta.name} route`) : t(`启用 ${meta.name} 路由`, `Enable ${meta.name} route`)} /></div>
      </header>

      <div className="route-editor__body">
        <div className="route-fields">
          <label className="field">
            <span>{t('源', 'Source')}</span>
            <select value={draft.poolId} onChange={(event) => setDraft({ ...draft, poolId: event.target.value })}>
              <option value="">{t('未选择', 'Not selected')}</option>
              {draft.poolId && !selectedSourceAvailable && (
                <option value={draft.poolId} disabled>{source ? setupPoolDisplayName(source.summary.name, t) : t('当前源', 'Current source')} · {t('已不可用', 'Unavailable')}</option>
              )}
              {sourceGroups.map((group) => {
                const options = routeSources.filter((item) => item.kind === group.kind)
                return options.length ? <optgroup key={group.kind} label={group.label}>
                  {options.map((item) => <option key={item.id} value={item.id}>{setupPoolDisplayName(item.name, t)} · {protocolLabels[item.protocol]}</option>)}
                </optgroup> : null
              })}
            </select>
          </label>
          <label className="field">
            <span>{t('入站协议', 'Inbound protocol')}</span>
            <select value={clientNativeProtocols[draft.client]} disabled aria-label={t(`${meta.name} 固定入站协议`, `${meta.name} fixed inbound protocol`)}>
              <option value={clientNativeProtocols[draft.client]}>{protocolLabels[clientNativeProtocols[draft.client]]}</option>
            </select>
          </label>
        </div>

        {source && source.summary.protocol !== draft.inboundProtocol && (
          <div className="conversion-line"><RefreshCw size={14} /><span>{protocolLabels[draft.inboundProtocol]}</span><span className="conversion-arrow">→</span><span>{protocolLabels[source.summary.protocol]}</span><Badge tone="warning">{t('协议转换', 'Protocol conversion')}</Badge></div>
        )}

        <div className="route-access">
          <div className="route-access__heading"><span>{t('本地端点', 'Local endpoint')}</span><button type="button" className="icon-button" title={t('复制端点', 'Copy endpoint')} onClick={() => void copyText('endpoint', endpoint)}>{copied === 'endpoint' ? <Check size={16} /> : <Copy size={16} />}</button></div>
          <code>{endpoint}</code>
        </div>

        <div className="route-access">
          <div className="route-access__heading"><span>{t('本地访问令牌', 'Local access token')}</span><div><button type="button" className="icon-button" title={showToken ? t('隐藏令牌', 'Hide token') : t('显示令牌', 'Show token')} onClick={() => setShowToken((value) => !value)}>{showToken ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" className="icon-button" title={t('复制令牌', 'Copy token')} onClick={() => void copyText('token', draft.localToken)}>{copied === 'token' ? <Check size={16} /> : <Copy size={16} />}</button><button type="button" className="icon-button" title={t('重新生成令牌', 'Regenerate token')} onClick={() => setDraft({ ...draft, localToken: randomToken(route.client) })}><RefreshCw size={15} /></button></div></div>
          <code>{showToken ? draft.localToken : `••••••••••••${draft.localToken.slice(-6)}`}</code>
        </div>

        <div className="mapping-section">
          <div className="mapping-section__heading"><div><strong>{t('模型映射', 'Model mapping')}</strong><span>{mappings.length ? t(`${mappings.length} 条规则`, `${mappings.length} ${mappings.length === 1 ? 'rule' : 'rules'}`) : t('直接使用请求中的模型标识', 'Use the requested model identifier directly')}</span></div><button className="text-button" type="button" onClick={() => setMappings([...mappings, { id: crypto.randomUUID(), source: '', target: '' }])}><Plus size={15} />{t('添加规则', 'Add rule')}</button></div>
          {mappings.length > 0 && (
            <div className="mapping-list">
              {mappings.map((row) => (
                <div className="mapping-row" key={row.id}>
                  <input className="mono" value={row.source} onChange={(event) => setMappings(mappings.map((item) => item.id === row.id ? { ...item, source: event.target.value } : item))} placeholder={t('请求模型', 'Requested model')} />
                  <span>→</span>
                  <input className="mono" value={row.target} onChange={(event) => setMappings(mappings.map((item) => item.id === row.id ? { ...item, target: event.target.value } : item))} placeholder={t('上游模型', 'Upstream model')} />
                  <button className="icon-button" type="button" title={t('删除映射', 'Delete mapping')} onClick={() => setMappings(mappings.filter((item) => item.id !== row.id))}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <details className="client-config">
          <summary><KeyRound size={15} />{t('客户端环境变量', 'Client environment variables')}</summary>
          <div><pre>{clientEnvironment(draft, baseUrl)}</pre><button className="icon-button" type="button" title={t('复制环境变量', 'Copy environment variables')} onClick={() => void copyText('environment', clientEnvironment(draft, baseUrl))}>{copied === 'environment' ? <Check size={16} /> : <Clipboard size={16} />}</button></div>
        </details>
      </div>

      <footer className="route-editor__footer">
        <span>{hasChanges ? t('有未保存的更改', 'Unsaved changes') : t('配置已同步', 'Configuration synced')}</span>
        <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || !hasChanges || (draft.enabled && !draft.poolId)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{t('保存路由', 'Save route')}</button>
      </footer>
    </article>
  )
}

export function RoutesView({
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
  const { t } = useI18n()
  return (
    <div className="page-stack">
      <PageHeader title={t('客户端路由', 'Client routes')} />
      {snapshot.routes.length ? (
        <div className="routes-grid">
          {snapshot.routes.map((route) => <RouteEditor key={route.id} route={route} snapshot={snapshot} api={api} runAction={runAction} busy={busyKeys.has(`save-route-${route.id}`) || busyKeys.has(`toggle-route-${route.id}`)} />)}
        </div>
      ) : (
        <section className="panel"><EmptyState icon={<RouteIcon size={25} />} title={t('没有可配置的客户端路由', 'No configurable client routes')} description={t('本地服务尚未初始化默认路由', 'The local service has not initialized its default routes yet.')} /></section>
      )}
    </div>
  )
}
