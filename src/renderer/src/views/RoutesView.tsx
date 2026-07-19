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
import { Badge, EmptyState, gatewayBaseUrl, PageHeader, protocolLabels, Toggle } from '../ui'

const clientMeta: Record<RouteClient, { name: string; label: string; color: string }> = {
  claude: { name: 'Claude Code', label: 'C', color: '#d97757' },
  codex: { name: 'Codex', label: 'X', color: '#171a19' },
  gemini: { name: 'Gemini CLI', label: 'G', color: '#4285f4' },
}

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
    { kind: 'standard', label: '普通号池' },
    { kind: 'relay-aggregate', label: '聚合中转' },
    { kind: 'official-api', label: '官方 API' },
    { kind: 'relay', label: '中转站' },
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
        <span className="client-logo" style={{ '--client-color': meta.color } as React.CSSProperties}>{meta.label}</span>
        <div><h2>{meta.name}</h2><span>{protocolLabels[draft.inboundProtocol]}</span></div>
        <div className="route-editor__state"><span>{draft.enabled ? '已启用' : '已停用'}</span><Toggle checked={draft.enabled} onChange={(value) => void toggleEnabled(value)} label={`${draft.enabled ? '停用' : '启用'} ${meta.name} 路由`} /></div>
      </header>

      <div className="route-editor__body">
        <div className="route-fields">
          <label className="field">
            <span>源</span>
            <select value={draft.poolId} onChange={(event) => setDraft({ ...draft, poolId: event.target.value })}>
              <option value="">未选择</option>
              {draft.poolId && !selectedSourceAvailable && (
                <option value={draft.poolId} disabled>{source?.summary.name ?? '当前源'} · 已不可用</option>
              )}
              {sourceGroups.map((group) => {
                const options = routeSources.filter((item) => item.kind === group.kind)
                return options.length ? <optgroup key={group.kind} label={group.label}>
                  {options.map((item) => <option key={item.id} value={item.id}>{item.name} · {protocolLabels[item.protocol]}</option>)}
                </optgroup> : null
              })}
            </select>
          </label>
          <label className="field">
            <span>入站协议</span>
            <select value={clientNativeProtocols[draft.client]} disabled aria-label={`${meta.name} 固定入站协议`}>
              <option value={clientNativeProtocols[draft.client]}>{protocolLabels[clientNativeProtocols[draft.client]]}</option>
            </select>
          </label>
        </div>

        {source && source.summary.protocol !== draft.inboundProtocol && (
          <div className="conversion-line"><RefreshCw size={14} /><span>{protocolLabels[draft.inboundProtocol]}</span><span className="conversion-arrow">→</span><span>{protocolLabels[source.summary.protocol]}</span><Badge tone="warning">协议转换</Badge></div>
        )}

        <div className="route-access">
          <div className="route-access__heading"><span>本地端点</span><button type="button" className="icon-button" title="复制端点" onClick={() => void copyText('endpoint', endpoint)}>{copied === 'endpoint' ? <Check size={16} /> : <Copy size={16} />}</button></div>
          <code>{endpoint}</code>
        </div>

        <div className="route-access">
          <div className="route-access__heading"><span>本地访问令牌</span><div><button type="button" className="icon-button" title={showToken ? '隐藏令牌' : '显示令牌'} onClick={() => setShowToken((value) => !value)}>{showToken ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" className="icon-button" title="复制令牌" onClick={() => void copyText('token', draft.localToken)}>{copied === 'token' ? <Check size={16} /> : <Copy size={16} />}</button><button type="button" className="icon-button" title="重新生成令牌" onClick={() => setDraft({ ...draft, localToken: randomToken(route.client) })}><RefreshCw size={15} /></button></div></div>
          <code>{showToken ? draft.localToken : `••••••••••••${draft.localToken.slice(-6)}`}</code>
        </div>

        <div className="mapping-section">
          <div className="mapping-section__heading"><div><strong>模型映射</strong><span>{mappings.length ? `${mappings.length} 条规则` : '直接使用请求中的模型标识'}</span></div><button className="text-button" type="button" onClick={() => setMappings([...mappings, { id: crypto.randomUUID(), source: '', target: '' }])}><Plus size={15} />添加规则</button></div>
          {mappings.length > 0 && (
            <div className="mapping-list">
              {mappings.map((row) => (
                <div className="mapping-row" key={row.id}>
                  <input className="mono" value={row.source} onChange={(event) => setMappings(mappings.map((item) => item.id === row.id ? { ...item, source: event.target.value } : item))} placeholder="请求模型" />
                  <span>→</span>
                  <input className="mono" value={row.target} onChange={(event) => setMappings(mappings.map((item) => item.id === row.id ? { ...item, target: event.target.value } : item))} placeholder="上游模型" />
                  <button className="icon-button" type="button" title="删除映射" onClick={() => setMappings(mappings.filter((item) => item.id !== row.id))}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <details className="client-config">
          <summary><KeyRound size={15} />客户端环境变量</summary>
          <div><pre>{clientEnvironment(draft, baseUrl)}</pre><button className="icon-button" type="button" title="复制环境变量" onClick={() => void copyText('environment', clientEnvironment(draft, baseUrl))}>{copied === 'environment' ? <Check size={16} /> : <Clipboard size={16} />}</button></div>
        </details>
      </div>

      <footer className="route-editor__footer">
        <span>{hasChanges ? '有未保存的更改' : '配置已同步'}</span>
        <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || !hasChanges || (draft.enabled && !draft.poolId)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存路由</button>
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
  return (
    <div className="page-stack">
      <PageHeader title="客户端路由" description="为本机 AI 编程客户端选择号池、官方 API 或中转站来源" />
      {snapshot.routes.length ? (
        <div className="routes-grid">
          {snapshot.routes.map((route) => <RouteEditor key={route.id} route={route} snapshot={snapshot} api={api} runAction={runAction} busy={busyKeys.has(`save-route-${route.id}`) || busyKeys.has(`toggle-route-${route.id}`)} />)}
        </div>
      ) : (
        <section className="panel"><EmptyState icon={<RouteIcon size={25} />} title="没有可配置的客户端路由" description="本地服务尚未初始化默认路由" /></section>
      )}
    </div>
  )
}
