import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  Gauge,
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
import type { AppSnapshot, GatewayApi, Route, RouteClient, RoutePreviewIssue, RoutePreviewResult } from '@shared/types'
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

function previewIssueText(
  item: RoutePreviewIssue,
  preview: RoutePreviewResult,
  t: (zh: string, en: string) => string,
): string {
  if (item.code === 'route-disabled') return t('路由当前处于停用状态。', 'The route is currently disabled.')
  if (item.code === 'invalid-inbound-protocol') return t('入站协议与客户端原生协议不一致。', 'The inbound protocol does not match the client native protocol.')
  if (item.code === 'source-missing') return t('目标来源不存在或配置不完整。', 'The target source is missing or incomplete.')
  if (item.code === 'source-unavailable') return t('来源没有可参与调度的账号。', 'The source has no account eligible for scheduling.')
  if (item.code === 'protocol-conversion') return t(`将转换为 ${preview.sourceProtocol ?? '上游协议'}。`, `The request will be converted to ${preview.sourceProtocol ?? 'the upstream protocol'}.`)
  if (item.code === 'model-mapped') return t(`模型将映射为 ${preview.upstreamModel ?? ''}。`, `The model will be mapped to ${preview.upstreamModel ?? ''}.`)
  if (item.code === 'model-unavailable') return t(`没有成员声明支持 ${preview.upstreamModel ?? '该模型'}。`, `No member declares support for ${preview.upstreamModel ?? 'this model'}.`)
  if (item.code === 'capability-unsupported') return t(`来源不支持 ${item.capability ?? '所需能力'}。`, `The source does not support ${item.capability ?? 'the required capability'}.`)
  if (item.code === 'capability-unknown') return t(`尚未确认 ${item.capability ?? '所需能力'}。`, `${item.capability ?? 'The required capability'} has not been confirmed.`)
  return item.message
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
  const [previewModel, setPreviewModel] = useState('')
  const [preview, setPreview] = useState<RoutePreviewResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
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

  const runPreview = async () => {
    setPreviewBusy(true)
    try {
      const modelMap = Object.fromEntries(mappings.filter((row) => row.source.trim() && row.target.trim()).map((row) => [row.source.trim(), row.target.trim()]))
      setPreview(await api.previewRoute({
        route: { ...draft, modelMap },
        requestedModel: previewModel.trim() || undefined,
      }))
    } finally {
      setPreviewBusy(false)
    }
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

        <div className={`route-performance-option ${draft.highConcurrencyMode ? 'route-performance-option--active' : ''}`}>
          <Gauge size={17} />
          <div>
            <strong>{t('高并发模式', 'High-concurrency mode')}</strong>
            <span>{t(
              '暂停进度明细、回放和对冲等非必要活动，优先保障高并发首字速度',
              'Pause detailed progress, replay, and hedging to prioritize first-token latency at high concurrency'
            )}</span>
          </div>
          <Toggle
            checked={draft.highConcurrencyMode === true}
            onChange={(value) => setDraft({ ...draft, highConcurrencyMode: value })}
            label={draft.highConcurrencyMode
              ? t(`关闭 ${meta.name} 高并发模式`, `Disable high-concurrency mode for ${meta.name}`)
              : t(`开启 ${meta.name} 高并发模式`, `Enable high-concurrency mode for ${meta.name}`)}
          />
        </div>

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

        <details className="client-config route-preview">
          <summary><RouteIcon size={15} />{t('静态路由预演', 'Static route preview')}</summary>
          <div className="route-preview__body">
            <div className="route-preview__controls"><input className="mono" value={previewModel} onChange={(event) => { setPreviewModel(event.target.value); setPreview(null) }} placeholder={t('请求模型（可选）', 'Requested model (optional)')} /><button className="button button--secondary" type="button" disabled={previewBusy} onClick={() => void runPreview()}>{previewBusy ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}{t('预演', 'Preview')}</button></div>
            {preview && <div className="route-preview__result"><Badge tone={preview.status === 'ready' ? 'success' : preview.status === 'blocked' ? 'danger' : 'warning'}>{preview.status === 'ready' ? t('可路由', 'Ready') : preview.status === 'blocked' ? t('已阻止', 'Blocked') : t('需注意', 'Attention')}</Badge><span>{t(`${preview.eligibleAccountCount} 个可用成员`, `${preview.eligibleAccountCount} eligible account(s)`)}</span>{preview.upstreamModel && <code>{preview.requestedModel && preview.requestedModel !== preview.upstreamModel ? `${preview.requestedModel} → ${preview.upstreamModel}` : preview.upstreamModel}</code>}{preview.issues.map((item) => <small key={`${item.code}-${item.capability ?? ''}`}>{item.severity === 'error' ? '✕' : item.severity === 'warning' ? '!' : '·'} {previewIssueText(item, preview, t)}</small>)}</div>}
          </div>
        </details>

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
