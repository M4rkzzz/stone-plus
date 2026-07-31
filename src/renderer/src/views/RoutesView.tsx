/* eslint-disable react-refresh/only-export-components -- regression-tested editor state helpers live beside the component. */
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CircleAlert,
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
import {
  enumerateRouteSourceModels,
  analyzeRouteSourceCompatibility,
  isGrokRouteSource,
  isNativeGrokRouteSource,
  listRouteSourcesForClient,
  resolveRouteSource,
  routeSourceUsesKiroClaude,
  type RouteSourceKind,
} from '@shared/route-sources'
import {
  normalizeRouteModelMap,
  normalizeRouteModelSourceMap,
  validateRouteModelMapping,
} from '@shared/route-models'
import type { AppSnapshot, GatewayApi, Route, RouteClient, RoutePreviewIssue, RoutePreviewResult } from '@shared/types'
import type { ActionRunner } from '../App'
import { clientBrandMeta as clientMeta } from '../brand-icons'
import { BoundAsyncOperation, ExclusiveAsyncOperation } from '../async-operation'
import { localizeBackendError } from '../backend-message'
import { useI18n } from '../i18n'
import { Badge, EmptyState, FieldError, gatewayBaseUrl, PageHeader, protocolLabels, Toggle } from '../ui'
import { setupPoolDisplayName } from '../system-generated-text'
import {
  CLAUDE_TOOLCHAIN_UNVERIFIED_COPY,
  routeSourceNeedsClaudeToolchainWarning,
} from '../claude-toolchain-ui'

type MappingRow = { id: string; source: string; target: string; sourceId?: string }
export const DEFAULT_ROUTE_MODEL_KEY = '*'

export function splitRouteModelMap(modelMap: Readonly<Record<string, string>>): {
  defaultUpstreamModel: string
  exactMappings: Array<{ source: string; target: string }>
} {
  return {
    defaultUpstreamModel: modelMap[DEFAULT_ROUTE_MODEL_KEY] ?? '',
    exactMappings: Object.entries(modelMap)
      .filter(([source]) => source !== DEFAULT_ROUTE_MODEL_KEY)
      .map(([source, target]) => ({ source, target })),
  }
}

export function splitRouteModelRules(
  modelMap: Readonly<Record<string, string>>,
  modelSourceMap: Readonly<Record<string, string>> = {},
): Array<{ source: string; target: string; sourceId: string }> {
  const models = new Set([
    ...Object.keys(modelMap).filter((source) => source !== DEFAULT_ROUTE_MODEL_KEY),
    ...Object.keys(modelSourceMap).filter((source) => source !== DEFAULT_ROUTE_MODEL_KEY),
  ])
  return [...models].map((source) => ({
    source,
    target: modelMap[source] ?? '',
    sourceId: modelSourceMap[source] ?? '',
  }))
}

export type RouteMappingValidation = {
  valid: true
  modelMap: Record<string, string>
  modelSourceMap: Record<string, string>
} | {
  valid: false
  reason: 'incomplete' | 'duplicate-source' | 'reserved-source' | 'unsafe-source' | 'unsafe-target' | 'unsafe-source-id'
}

/** Validate without silently dropping rows the user can still see in the editor. */
export function validateRouteMappings(
  rows: readonly Pick<MappingRow, 'source' | 'target' | 'sourceId'>[],
  defaultUpstreamModel = '',
): RouteMappingValidation {
  const entries: Array<[string, string]> = []
  const sourceEntries: Array<[string, string]> = []
  const sources = new Set<string>()
  for (const row of rows) {
    const source = row.source.trim()
    const target = row.target.trim()
    const sourceId = row.sourceId?.trim() ?? ''
    if (!source || (!target && !sourceId)) return { valid: false, reason: 'incomplete' }
    if (source === DEFAULT_ROUTE_MODEL_KEY) return { valid: false, reason: 'reserved-source' }
    const sharedValidation = validateRouteModelMapping(source, target || source)
    if (!sharedValidation.valid) {
      return { valid: false, reason: sharedValidation.reason === 'invalid-source' ? 'unsafe-source' : 'unsafe-target' }
    }
    if (sources.has(source)) return { valid: false, reason: 'duplicate-source' }
    sources.add(source)
    if (target) entries.push([source, target])
    if (sourceId) sourceEntries.push([source, sourceId])
  }
  const normalizedDefault = defaultUpstreamModel.trim()
  if (normalizedDefault) {
    if (!validateRouteModelMapping(DEFAULT_ROUTE_MODEL_KEY, normalizedDefault).valid) {
      return { valid: false, reason: 'unsafe-target' }
    }
    entries.push([DEFAULT_ROUTE_MODEL_KEY, normalizedDefault])
  }
  const modelSourceMap = { ...normalizeRouteModelSourceMap(Object.fromEntries(sourceEntries)) }
  if (Object.keys(modelSourceMap).length !== sourceEntries.length) {
    return { valid: false, reason: 'unsafe-source-id' }
  }
  return {
    valid: true,
    modelMap: { ...normalizeRouteModelMap(Object.fromEntries(entries)) },
    modelSourceMap,
  }
}

/** Every field sent to previewRoute participates in the result identity. */
export function routePreviewBinding(
  draft: Route,
  mappings: readonly Pick<MappingRow, 'source' | 'target' | 'sourceId'>[],
  defaultUpstreamModel: string,
  requestedModel: string,
): string {
  return JSON.stringify({
    route: {
      id: draft.id,
      client: draft.client,
      enabled: draft.enabled,
      highConcurrencyMode: draft.highConcurrencyMode === true,
      poolId: draft.poolId,
      inboundProtocol: draft.inboundProtocol,
      modelSourceMap: draft.modelSourceMap ?? {},
      localToken: draft.localToken,
    },
    mappings: mappings.map(({ source, target, sourceId }) => ({ source, target, sourceId: sourceId ?? '' })),
    defaultUpstreamModel,
    requestedModel,
  })
}

export function routeSourceModelOptions(
  sourceId: string,
  snapshot: Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>,
): string[] {
  const source = resolveRouteSource(sourceId, snapshot)
  return enumerateRouteSourceModels(source, snapshot)
}

export function routeSourceUsesGrok(
  sourceId: string,
  snapshot: Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>,
): boolean {
  const source = resolveRouteSource(sourceId, snapshot)
  return isGrokRouteSource(source, snapshot)
}

export function routeSourceUsesNativeGrok(
  sourceId: string,
  snapshot: Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>,
): boolean {
  const source = resolveRouteSource(sourceId, snapshot)
  return isNativeGrokRouteSource(source, snapshot)
}

export function routePreviewIssuesForDisplay(
  route: Pick<Route, 'client'>,
  issues: readonly RoutePreviewIssue[],
  nativeGrokSource: boolean,
): RoutePreviewIssue[] {
  if (route.client !== 'grokbuild' || !nativeGrokSource) return [...issues]
  return issues.filter((item) => item.code !== 'protocol-conversion')
}

export function defaultModelAfterRouteSourceChange(
  sourceId: string,
  currentModel: string,
  snapshot: Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>,
): string {
  const models = routeSourceModelOptions(sourceId, snapshot)
  if (models.length === 1) return models[0]
  return currentModel && models.includes(currentModel) ? currentModel : ''
}

/** Enabling/disabling is an isolated persisted mutation, never a draft save. */
export function routeEnabledPayload(route: Route, enabled: boolean): Route {
  return { ...route, enabled }
}

/** Signature of every persisted route field except the server-owned timestamp. */
export function routeToggleAcknowledgementSignature(route: Route): string {
  return JSON.stringify({
    id: route.id,
    client: route.client,
    enabled: route.enabled,
    highConcurrencyMode: route.highConcurrencyMode === true,
    poolId: route.poolId,
    inboundProtocol: route.inboundProtocol,
    modelMap: route.modelMap,
    modelSourceMap: route.modelSourceMap ?? {},
    localToken: route.localToken,
    createdAt: route.createdAt,
  })
}

export function routeEditorHasChanges(
  draft: Route,
  mappings: readonly Pick<MappingRow, 'source' | 'target' | 'sourceId'>[],
  persisted: Route,
  defaultUpstreamModel = splitRouteModelMap(persisted.modelMap).defaultUpstreamModel,
): boolean {
  const { modelMap: _draftModelMap, modelSourceMap: _draftModelSourceMap, updatedAt: _draftUpdatedAt, ...draftFields } = draft
  const { modelMap: _persistedModelMap, modelSourceMap: _persistedModelSourceMap, updatedAt: _persistedUpdatedAt, ...persistedFields } = persisted
  return JSON.stringify({
    fields: draftFields,
    mappings: mappings.map(({ source, target, sourceId }) => ({ source, target, sourceId: sourceId ?? '' })),
    defaultUpstreamModel,
  })
    !== JSON.stringify({
      fields: persistedFields,
      mappings: splitRouteModelRules(persisted.modelMap, persisted.modelSourceMap),
      defaultUpstreamModel: splitRouteModelMap(persisted.modelMap).defaultUpstreamModel,
    })
}

function randomToken(client: RouteClient) {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `stone_${client}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function routePath(route: Route) {
  if (route.client === 'grokbuild') return '/grokbuild/v1/responses'
  if (route.inboundProtocol === 'anthropic-messages') return '/v1/messages'
  if (route.inboundProtocol === 'openai-responses') return '/v1/responses'
  if (route.inboundProtocol === 'openai-chat') return '/v1/chat/completions'
  return '/v1beta/models/{model}:generateContent'
}

function clientEnvironment(route: Route, baseUrl: string) {
  if (route.client === 'claude') return `ANTHROPIC_BASE_URL=${baseUrl}\nANTHROPIC_AUTH_TOKEN=${route.localToken}`
  if (route.client === 'codex') return `OPENAI_BASE_URL=${baseUrl}/v1\nOPENAI_API_KEY=${route.localToken}`
  if (route.client === 'grokbuild') return `[auth]\npreferred_method = "api_key"\n\n[models]\ndefault = "stoneplus"\n\n[model.stoneplus]\nmodel = "grok-4.5"\nbase_url = "${baseUrl}/grokbuild/v1"\nname = "Stone+"\napi_key = "${route.localToken}"\napi_backend = "responses"\ncontext_window = 500000`
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
  if (item.code === 'source-unavailable') return item.message.includes('Grok Build')
    ? t('Grok Build 只能使用 Grok 号池或 Grok 中转站。', 'Grok Build can use only Grok pools or Grok relays.')
    : t('来源没有可参与调度的账号。', 'The source has no account eligible for scheduling.')
  if (item.code === 'source-overridden') return t(
    `该请求模型将改走 ${preview.sourceName ?? '指定来源'}。`,
    `This requested model will use ${preview.sourceName ?? 'the selected source'}.`,
  )
  if (item.code === 'protocol-conversion') {
    const target = preview.sourceProtocol ? protocolLabels[preview.sourceProtocol] : undefined
    return t(`将转换为 ${target ?? '上游协议'}。`, `The request will be converted to ${target ?? 'the upstream protocol'}.`)
  }
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
  const { t, language } = useI18n()
  const [draft, setDraft] = useState(route)
  const [mappings, setMappings] = useState<MappingRow[]>(() => splitRouteModelRules(route.modelMap, route.modelSourceMap)
    .map((rule) => ({ id: crypto.randomUUID(), ...rule })))
  const [defaultUpstreamModel, setDefaultUpstreamModel] = useState(() => splitRouteModelMap(route.modelMap).defaultUpstreamModel)
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [previewModel, setPreviewModel] = useState('')
  const [preview, setPreview] = useState<{ binding: string; value: RoutePreviewResult } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [mappingValidationAttempted, setMappingValidationAttempted] = useState(false)
  const syncedRouteSignature = useRef('')
  const pendingToggle = useRef<{ token: symbol; signature: string } | undefined>(undefined)
  const persistedRoute = useRef(route)
  const mutation = useRef(new ExclusiveAsyncOperation())
  const previewOperation = useRef(new BoundAsyncOperation())
  const [localMutation, setLocalMutation] = useState<'save' | 'toggle' | null>(null)
  persistedRoute.current = route
  const meta = clientMeta[route.client]
  const routeSignature = JSON.stringify(route)

  useEffect(() => {
    // Snapshot polling creates a new route object even when its persisted data
    // has not changed. Do not let those refreshes overwrite an in-progress edit.
    if (syncedRouteSignature.current === routeSignature) return
    syncedRouteSignature.current = routeSignature
    if (pendingToggle.current?.signature === routeToggleAcknowledgementSignature(route)) {
      pendingToggle.current = undefined
      // Preserve every unsaved field and mapping. The incoming snapshot is
      // only the acknowledgement of the isolated enabled-state mutation.
      setDraft((current) => ({ ...current, enabled: route.enabled, updatedAt: route.updatedAt }))
      return
    }
    pendingToggle.current = undefined
    setDraft(route)
    const mapping = splitRouteModelMap(route.modelMap)
    setMappings(splitRouteModelRules(route.modelMap, route.modelSourceMap)
      .map((rule) => ({ id: crypto.randomUUID(), ...rule })))
    setDefaultUpstreamModel(mapping.defaultUpstreamModel)
    setMappingValidationAttempted(false)
  }, [route, routeSignature])

  const source = resolveRouteSource(draft.poolId, snapshot)
  const grokCompatibility = routeSourceUsesGrok(draft.poolId, snapshot)
  const nativeGrokSource = routeSourceUsesNativeGrok(draft.poolId, snapshot)
  const kiroClaudeSource = routeSourceUsesKiroClaude(source, snapshot)
  const claudeToolchainUnverified = draft.client === 'claude'
    && routeSourceNeedsClaudeToolchainWarning(source, snapshot.providers)
  const sourceCompatibility = analyzeRouteSourceCompatibility(draft.client, source, snapshot)
  const routeSources = listRouteSourcesForClient(draft.client, snapshot)
  const selectedSourceAvailable = routeSources.some((item) => item.id === draft.poolId)
  const sourceAllowed = sourceCompatibility.eligible
  const sourceGroups: Array<{ kind: RouteSourceKind; label: string }> = [
    { kind: 'standard', label: t('普通号池', 'Standard pools') },
    { kind: 'relay-aggregate', label: t('聚合中转', 'Aggregate relays') },
    { kind: 'official-api', label: t('官方 API', 'Official APIs') },
    { kind: 'relay', label: t('中转站', 'Relays') },
  ]
  const baseUrl = gatewayBaseUrl(snapshot.gateway.host, snapshot.gateway.port)
  const endpoint = `${baseUrl}${routePath(draft)}`
  const previewBinding = routePreviewBinding(draft, mappings, defaultUpstreamModel, previewModel.trim())
  const previewBindingRef = useRef(previewBinding)
  previewBindingRef.current = previewBinding
  const visiblePreview = preview?.binding === previewBinding ? preview.value : null

  useEffect(() => {
    previewOperation.current.invalidate()
    setPreview(null)
    setPreviewError('')
    setPreviewBusy(false)
  }, [previewBinding])

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied(null), 1400)
  }

  const updateMappings = (next: MappingRow[]) => {
    setMappings(next)
    if (validateRouteMappings(next, defaultUpstreamModel).valid) setMappingValidationAttempted(false)
  }

  const save = async () => {
    const validation = validateRouteMappings(mappings, defaultUpstreamModel)
    if (!validation.valid) {
      setMappingValidationAttempted(true)
      return
    }
    setMappingValidationAttempted(false)
    await mutation.current.run(async () => {
      setLocalMutation('save')
      try {
        return await runAction(`save-route-${route.id}`, () => api.updateRoute({
          ...draft,
          modelMap: validation.modelMap,
          modelSourceMap: draft.client === 'codex' ? validation.modelSourceMap : {},
        }))
      } finally {
        setLocalMutation(null)
      }
    })
  }

  const runPreview = async () => {
    const validation = validateRouteMappings(mappings, defaultUpstreamModel)
    if (!validation.valid) {
      setMappingValidationAttempted(true)
      return
    }
    const binding = previewBinding
    setPreviewBusy(true)
    setPreview(null)
    setPreviewError('')
    const result = await previewOperation.current.run(
      binding,
      () => previewBindingRef.current,
      () => api.previewRoute({
        route: {
          ...draft,
          modelMap: validation.modelMap,
          modelSourceMap: draft.client === 'codex' ? validation.modelSourceMap : {},
        },
        requestedModel: previewModel.trim() || undefined,
      }),
    )
    if (result.status === 'applied') setPreview({ binding, value: result.value })
    else if (result.status === 'failed') {
      setPreviewError(localizeBackendError(result.error, language, t('路由预演失败，请重试。', 'Route preview failed. Try again.')))
    }
    if (previewOperation.current.isLatest(result.token) && previewBindingRef.current === binding) {
      setPreviewBusy(false)
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    if (enabled && (!draft.poolId || !sourceAllowed)) return
    await mutation.current.run(async () => {
      const requestToken = Symbol('route-toggle')
      const previousEnabled = draft.enabled
      const persistedNext = routeEnabledPayload(persistedRoute.current, enabled)
      pendingToggle.current = {
        token: requestToken,
        signature: routeToggleAcknowledgementSignature(persistedNext),
      }
      setDraft((current) => ({ ...current, enabled }))
      setLocalMutation('toggle')
      try {
        const success = await runAction(`toggle-route-${route.id}`, () => api.updateRoute(persistedNext))
        if (!success && pendingToggle.current?.token === requestToken) {
          pendingToggle.current = undefined
          setDraft((current) => current.enabled === enabled
            ? { ...current, enabled: previousEnabled }
            : current)
        }
        return success
      } finally {
        setLocalMutation(null)
      }
    })
  }

  const mappingValidation = validateRouteMappings(mappings, defaultUpstreamModel)
  const hasChanges = routeEditorHasChanges(draft, mappings, route, defaultUpstreamModel)
  const sourceModelOptions = routeSourceModelOptions(draft.poolId, snapshot)
  const modelSourceAllowed = draft.client !== 'codex' || mappings.every((row) => (
    !row.sourceId || routeSources.some((item) => item.id === row.sourceId)
  ))
  const modelSourceOverrideCount = draft.client === 'codex'
    ? mappings.filter((row) => row.sourceId).length
    : 0
  const changeSource = (sourceId: string) => {
    setDraft({ ...draft, poolId: sourceId })
    setDefaultUpstreamModel((current) => defaultModelAfterRouteSourceChange(sourceId, current, snapshot))
    setMappingValidationAttempted(false)
  }

  return (
    <article className={`route-editor ${!draft.enabled ? 'route-editor--disabled' : ''}`}>
      <header className="route-editor__header">
        <span className="client-logo route-client-brand"><img className={meta.iconClassName} src={meta.icon} alt="" /></span>
        <div><h2>{meta.name}</h2><span>{draft.client === 'grokbuild' ? t('Grok 原生 · Responses', 'Grok native · Responses') : protocolLabels[draft.inboundProtocol]}</span></div>
        <div className="route-editor__state"><span>{draft.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span><Toggle checked={draft.enabled} disabled={busy || localMutation !== null || (!draft.enabled && (!draft.poolId || !sourceAllowed))} onChange={(value) => void toggleEnabled(value)} label={draft.enabled ? t(`停用 ${meta.name} 路由`, `Disable ${meta.name} route`) : t(`启用 ${meta.name} 路由`, `Enable ${meta.name} route`)} /></div>
      </header>

      <div className="route-editor__body">
        <div className="route-fields">
          <label className="field">
            <span>{t('源', 'Source')}</span>
            <select value={draft.poolId} onChange={(event) => changeSource(event.target.value)}>
              <option value="">{t('未选择', 'Not selected')}</option>
              {draft.poolId && !selectedSourceAvailable && (
                <option value={draft.poolId} disabled>{source ? setupPoolDisplayName(source.summary.name, t) : t('当前源', 'Current source')} · {t('已不可用', 'Unavailable')}</option>
              )}
              {sourceGroups.map((group) => {
                const options = routeSources.filter((item) => item.kind === group.kind)
                return options.length ? <optgroup key={group.kind} label={group.label}>
                  {options.map((item) => <option key={item.id} value={item.id}>{setupPoolDisplayName(item.name, t)} · {protocolLabels[item.protocol]}{draft.client === 'claude' && routeSourceNeedsClaudeToolchainWarning(resolveRouteSource(item.id, snapshot), snapshot.providers) ? ` · ${t(CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.zh, CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.en)}` : ''}</option>)}
                </optgroup> : null
              })}
            </select>
            {draft.client === 'grokbuild' && <small>{t('仅显示 Grok 原生 Responses 号池或中转站；Chat 兼容来源不会出现在这里。', 'Only Responses-native Grok pools or relays are shown; Chat compatibility sources are hidden.')}</small>}
            {draft.client === 'grokbuild' && draft.poolId && !sourceAllowed && <FieldError>{t('当前来源不是 Grok 原生 Responses 来源，请重新选择。', 'The current source is not a Responses-native Grok source. Select a different source.')}</FieldError>}
            {draft.client !== 'claude' && kiroClaudeSource && <FieldError>{t('Kiro Claude 来源只能由 Claude Code 系列客户端使用。', 'Kiro Claude sources are available only to Claude Code clients.')}</FieldError>}
            {draft.client === 'claude' && kiroClaudeSource && draft.poolId && !sourceAllowed && <FieldError>{t('该来源尚未通过 Kiro Claude 两轮工具链测试，不能绑定。', 'This source has not passed the Kiro Claude two-round tool test and cannot be bound.')}</FieldError>}
          </label>
          <label className="field">
            <span>{t('入站协议', 'Inbound protocol')}</span>
            <select value={clientNativeProtocols[draft.client]} disabled aria-label={t(`${meta.name} 固定入站协议`, `${meta.name} fixed inbound protocol`)}>
              <option value={clientNativeProtocols[draft.client]}>{draft.client === 'grokbuild' ? t('Grok 原生 · Responses', 'Grok native · Responses') : protocolLabels[clientNativeProtocols[draft.client]]}</option>
            </select>
          </label>
        </div>

        {claudeToolchainUnverified && <div className="claude-toolchain-warning"><CircleAlert size={15} /><span>{t(CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.zh, CLAUDE_TOOLCHAIN_UNVERIFIED_COPY.en)}</span></div>}

        {kiroClaudeSource && draft.client === 'claude' ? (
          <div className="conversion-line conversion-line--kiro"><RefreshCw size={14} /><span>Anthropic Messages</span><span className="conversion-arrow">→</span><span>Kiro Claude</span><Badge tone="warning">{t('方言兼容已启用', 'Dialect bridge enabled')}</Badge></div>
        ) : draft.client === 'grokbuild' && source && nativeGrokSource ? (
          <div className="conversion-line conversion-line--native"><Check size={14} /><span>Grok Build</span><span className="conversion-arrow">→</span><span>{t('Grok 原生 Responses', 'Grok native Responses')}</span><Badge tone="success">{t('原生直通', 'Native passthrough')}</Badge></div>
        ) : draft.client !== 'grokbuild' && source && source.summary.protocol !== draft.inboundProtocol ? (
          <div className="conversion-line"><RefreshCw size={14} /><span>{protocolLabels[draft.inboundProtocol]}</span><span className="conversion-arrow">→</span><span>{protocolLabels[source.summary.protocol]}</span><Badge tone="warning">{grokCompatibility ? t('Grok 兼容转换', 'Grok compatibility conversion') : t('协议转换', 'Protocol conversion')}</Badge></div>
        ) : null}

        {kiroClaudeSource && draft.client === 'claude' && <div className="kiro-compatibility-panel" role="status">
          <div><Check size={16} /><strong>{t('Kiro Claude 结构化兼容', 'Kiro Claude structured compatibility')}</strong><Badge tone="success">{t('强制开启', 'Always on')}</Badge></div>
          <code>Anthropic Messages → Kiro Claude → AWS Event Stream → Anthropic SSE</code>
          <ul>
            <li>{t('完整保持 tool_use / tool_result 的 ID、顺序与并行关系', 'Preserves tool_use / tool_result IDs, ordering, and parallel batches')}</li>
            <li>{t('不会把工具结果转换为 Continue 或占位文本', 'Never converts tool results into Continue or placeholder text')}</li>
            <li>{t('Manual 切换 Auto 后请新建会话；旧待确认调用不会自动重放', 'Start a new conversation after switching Manual to Auto; old pending calls are not replayed')}</li>
          </ul>
        </div>}

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

        <div className={`mapping-section ${draft.client === 'codex' ? 'mapping-section--source-routing' : ''}`}>
          <div className="mapping-section__heading"><div><strong>{draft.client === 'codex' ? t('按模型分流与映射', 'Per-model routing and mapping') : t('模型映射', 'Model mapping')}</strong><span>{draft.client === 'codex' && modelSourceOverrideCount > 0
            ? t(`${modelSourceOverrideCount} 个模型使用独立来源`, `${modelSourceOverrideCount} model(s) use a separate source`)
            : defaultUpstreamModel
              ? t(`${mappings.length} 条精确规则 + 1 条默认`, `${mappings.length} exact + 1 default`)
              : mappings.length
                ? t(`${mappings.length} 条规则`, `${mappings.length} ${mappings.length === 1 ? 'rule' : 'rules'}`)
                : t('未命中规则时使用上方默认来源', 'Unmatched models use the default source above')}</span></div><button className="text-button" type="button" onClick={() => { updateMappings([...mappings, { id: crypto.randomUUID(), source: '', target: '', sourceId: '' }]); setMappingValidationAttempted(false) }}><Plus size={15} />{t('添加规则', 'Add rule')}</button></div>
          {draft.client === 'codex' && <div className="model-source-routing-note"><RouteIcon size={14} /><span>{t('每条规则都可单独选择来源/号池；不选择时继续使用上方默认来源。上游模型留空表示保持请求模型不变。', 'Each rule may select its own source or pool. Leaving it unset keeps the default source above; leaving the upstream model blank preserves the requested model.')}</span></div>}
          <div className="mapping-default">
            <label className="field">
              <span>{t('默认上游模型', 'Default upstream model')}</span>
              <select value={defaultUpstreamModel} onChange={(event) => { setDefaultUpstreamModel(event.target.value); setMappingValidationAttempted(false) }}>
                <option value="">{t('不设置（保持请求模型）', 'Not set (keep requested model)')}</option>
                {defaultUpstreamModel && !sourceModelOptions.includes(defaultUpstreamModel) && <option value={defaultUpstreamModel}>{t('已保存 · 当前来源未发现', 'Saved · not found in current source')} · {defaultUpstreamModel}</option>}
                {sourceModelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </label>
            <small>{t('未命中下方精确规则时使用；精确映射始终优先。Stone+ 内部保存为默认规则，无需输入 *。', 'Used when no exact rule below matches; exact mappings always win. Stone+ stores this as the default rule, so you do not need to type *.')}</small>
          </div>
          {mappings.length > 0 && (
            <div className="mapping-list">
              {mappings.map((row) => (
                <div className="mapping-row" key={row.id}>
                  <input className="mono" value={row.source} onChange={(event) => updateMappings(mappings.map((item) => item.id === row.id ? { ...item, source: event.target.value } : item))} placeholder={t('请求模型', 'Requested model')} />
                  <span>→</span>
                  <input className="mono" value={row.target} onChange={(event) => updateMappings(mappings.map((item) => item.id === row.id ? { ...item, target: event.target.value } : item))} placeholder={draft.client === 'codex' ? t('上游模型（留空保持）', 'Upstream model (keep if blank)') : t('上游模型', 'Upstream model')} />
                  {draft.client === 'codex' && <select className="mapping-row__source" value={row.sourceId ?? ''} onChange={(event) => updateMappings(mappings.map((item) => item.id === row.id ? { ...item, sourceId: event.target.value } : item))} aria-label={t(`${row.source || '该模型'} 的来源`, `Source for ${row.source || 'this model'}`)}>
                    <option value="">{t('默认来源', 'Default source')}</option>
                    {routeSources.map((item) => <option key={item.id} value={item.id}>{setupPoolDisplayName(item.name, t)}</option>)}
                  </select>}
                  <button className="icon-button" type="button" title={t('删除映射', 'Delete mapping')} onClick={() => updateMappings(mappings.filter((item) => item.id !== row.id))}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}
          {mappingValidationAttempted && !mappingValidation.valid && <FieldError>{mappingValidation.reason === 'duplicate-source'
            ? t('同一个请求模型只能设置一条映射。', 'Each requested model can have only one mapping.')
            : mappingValidation.reason === 'reserved-source'
              ? t('* 已保留给默认上游模型，请使用上方选择器。', '* is reserved for the default upstream model; use the selector above.')
              : mappingValidation.reason === 'unsafe-source'
                ? t('请求模型名称无效：不能使用保留对象键、控制字符或超过 256 个字符。', 'The requested model name is invalid: reserved object keys, control characters, and names over 256 characters are not allowed.')
                : mappingValidation.reason === 'unsafe-target'
                  ? t('上游模型名称无效：不能包含控制字符或超过 256 个字符。', 'The upstream model name is invalid: control characters and names over 256 characters are not allowed.')
                  : mappingValidation.reason === 'unsafe-source-id'
                    ? t('模型来源标识无效，请重新选择来源。', 'The model source identifier is invalid. Select the source again.')
            : t('请填写请求模型，并至少选择一个独立来源或填写上游模型。', 'Enter the requested model and either select a separate source or provide an upstream model.')}</FieldError>}
          {!modelSourceAllowed && <FieldError>{t('某条模型分流规则引用了已不可用的来源，请重新选择。', 'A model-routing rule references an unavailable source. Select it again.')}</FieldError>}
        </div>

        <details className="client-config route-preview">
          <summary><RouteIcon size={15} />{t('静态路由预演', 'Static route preview')}</summary>
          <div className="route-preview__body">
            <div className="route-preview__controls"><input className="mono" value={previewModel} onChange={(event) => setPreviewModel(event.target.value)} placeholder={t('请求模型（可选）', 'Requested model (optional)')} /><button className="button button--secondary" type="button" disabled={previewBusy} onClick={() => void runPreview()}>{previewBusy ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}{t('预演', 'Preview')}</button></div>
            {previewError && <FieldError>{previewError}</FieldError>}
            {visiblePreview && <div className="route-preview__result"><Badge tone={visiblePreview.status === 'ready' ? 'success' : visiblePreview.status === 'blocked' ? 'danger' : 'warning'}>{visiblePreview.status === 'ready' ? t('可路由', 'Ready') : visiblePreview.status === 'blocked' ? t('已阻止', 'Blocked') : t('需注意', 'Attention')}</Badge><span>{t(`${visiblePreview.eligibleAccountCount} 个可用成员`, `${visiblePreview.eligibleAccountCount} eligible account(s)`)}</span>{visiblePreview.upstreamModel && <code>{visiblePreview.requestedModel && visiblePreview.requestedModel !== visiblePreview.upstreamModel ? `${visiblePreview.requestedModel} → ${visiblePreview.upstreamModel}` : visiblePreview.upstreamModel}</code>}{routePreviewIssuesForDisplay(draft, visiblePreview.issues, nativeGrokSource).map((item) => <small key={`${item.code}-${item.capability ?? ''}`}>{item.severity === 'error' ? '✕' : item.severity === 'warning' ? '!' : '·'} {previewIssueText(item, visiblePreview, t)}</small>)}</div>}
          </div>
        </details>

        <details className="client-config">
          <summary><KeyRound size={15} />{draft.client === 'grokbuild' ? t('Grok Build 配置片段', 'Grok Build configuration snippet') : t('客户端环境变量', 'Client environment variables')}</summary>
          <div><pre>{clientEnvironment(draft, baseUrl)}</pre><button className="icon-button" type="button" title={draft.client === 'grokbuild' ? t('复制 Grok Build 配置', 'Copy Grok Build configuration') : t('复制环境变量', 'Copy environment variables')} onClick={() => void copyText('environment', clientEnvironment(draft, baseUrl))}>{copied === 'environment' ? <Check size={16} /> : <Clipboard size={16} />}</button></div>
        </details>
      </div>

      <footer className="route-editor__footer">
        <span>{hasChanges ? t('有未保存的更改', 'Unsaved changes') : t('配置已同步', 'Configuration synced')}</span>
        <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || localMutation !== null || !hasChanges || !modelSourceAllowed || (draft.enabled && (!draft.poolId || !sourceAllowed))}>{busy || localMutation === 'save' ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{t('保存路由', 'Save route')}</button>
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
