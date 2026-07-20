import { useMemo, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Edit3,
  Layers3,
  LoaderCircle,
  Network,
  Plus,
  RadioTower,
  Shuffle,
  Trash2,
  Zap,
} from 'lucide-react'
import { supportsFastServiceTier } from '@shared/types'
import type { AppSnapshot, GatewayApi, ModelPolicy, Pool, PoolInput, PoolStrategy, Protocol } from '@shared/types'
import type { ActionRunner } from '../App'
import { useI18n } from '../i18n'
import { buildPoolModelCoverage, effectiveAccountModels, effectivePoolModels, isAccountModelWildcard, isPoolModelWildcard, pruneModelSelection } from '../model-policy'
import {
  AccountStatusBadge,
  Badge,
  ConfirmDialog,
  EmptyState,
  FieldError,
  InfoTip,
  Modal,
  OverflowMenu,
  PageHeader,
  protocolLabels,
} from '../ui'
import { ModelPolicyEditor } from './ModelPolicyEditor'
import { setupPoolDisplayName } from '../system-generated-text'

const strategyLabels: Record<PoolStrategy, string> = {
  balanced: '均衡调度',
  autobalanced: '智能均衡',
  priority: '优先级',
  'round-robin': '轮询',
  'weighted-random': '加权随机',
  'weighted-round-robin': '平滑加权轮询',
}

const strategyDescriptions: Record<PoolStrategy, string> = {
  balanced: '按并发负载与额度均衡分配',
  autobalanced: '根据首字与输出速度动态择优',
  priority: '优先使用数值较小的账号',
  'round-robin': '按固定顺序依次分配请求',
  'weighted-random': '按照账号权重随机分配',
  'weighted-round-robin': '按权重平滑交替分配请求',
}

const strategyLabelsEn: Record<PoolStrategy, string> = {
  balanced: 'Balanced',
  autobalanced: 'Smart balance',
  priority: 'Priority',
  'round-robin': 'Round robin',
  'weighted-random': 'Weighted random',
  'weighted-round-robin': 'Smooth weighted round robin',
}

const strategyDescriptionsEn: Record<PoolStrategy, string> = {
  balanced: 'Distribute requests by concurrency load and remaining quota',
  autobalanced: 'Choose dynamically based on time to first token and output speed',
  priority: 'Prefer accounts with lower priority values',
  'round-robin': 'Distribute requests in a fixed order',
  'weighted-random': 'Distribute requests randomly by account weight',
  'weighted-round-robin': 'Alternate requests smoothly by weight',
}

const protocols: Protocol[] = ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini']

function FastModeControl({
  sourceName,
  sourceKind,
  enabled,
  supported,
  busy,
  onToggle,
}: {
  sourceName: string
  sourceKind: 'pool' | 'relay'
  enabled: boolean
  supported: boolean
  busy: boolean
  onToggle: () => void
}) {
  const { t } = useI18n()
  const unsupportedMessage = t('FAST 服务层仅支持 OpenAI Responses 与 OpenAI Chat 协议', 'The FAST service tier supports only OpenAI Responses and OpenAI Chat.')
  return (
    <div
      className={`pool-card__fast ${enabled ? 'pool-card__fast--on' : ''} ${!supported ? 'pool-card__fast--unsupported' : ''}`}
      title={supported ? (enabled ? t('已强制所有对话使用 Fast 服务层', 'All conversations are using the FAST service tier') : t('开启后强制所有对话使用 Fast 服务层', 'Enable to force all conversations to use the FAST service tier')) : unsupportedMessage}
    >
      <span className="pool-card__fast-label">
        {busy ? <LoaderCircle aria-hidden="true" className="spin" size={13} /> : <Zap aria-hidden="true" size={13} />}
        <strong>FAST<InfoTip text={t('强制该来源使用上游 Fast 服务层，可能提升速度并消耗对应服务额度。', 'Force this source to use the upstream FAST service tier. This may improve speed and consume the corresponding service quota.')} /></strong>
      </span>
      <button
        className={`toggle pool-card__fast-switch ${enabled ? 'toggle--on' : ''}`}
        type="button"
        role="switch"
        aria-label={t(`${sourceKind === 'pool' ? '号池' : '中转站'} ${sourceName} FAST`, `${sourceKind === 'pool' ? 'Pool' : 'Relay'} ${sourceName} FAST`)}
        aria-checked={enabled}
        aria-busy={busy}
        disabled={!supported || busy}
        title={supported ? undefined : unsupportedMessage}
        onClick={onToggle}
      ><span /></button>
    </div>
  )
}

type PoolDraft = Omit<PoolInput, 'modelPolicy' | 'modelAllowlist' | 'forceFastMode' | 'hedgedRequests' | 'hedgeDelayMs' | 'firstBodyTimeoutMs'> & {
  modelPolicy: ModelPolicy
  modelAllowlist: string[]
  forceFastMode: boolean
  hedgedRequests: boolean
  hedgeDelayMs: number
  firstBodyTimeoutMs: number
}

function emptyDraft(): PoolDraft {
  return {
    name: '',
    kind: 'standard',
    protocol: 'anthropic-messages',
    strategy: 'balanced',
    accountIds: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2,
    forceFastMode: false,
    hedgedRequests: false,
    hedgeDelayMs: 2500,
    firstBodyTimeoutMs: 8000,
    proxyId: '',
  }
}

export function PoolsView({
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
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<PoolDraft>(emptyDraft())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<Pool | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [pendingFastModes, setPendingFastModes] = useState<Record<string, boolean>>({})

  const accountById = useMemo(() => new Map(snapshot.accounts.map((account) => [account.id, account])), [snapshot.accounts])
  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const poolEligibleAccounts = useMemo(
    () => snapshot.accounts.filter((account) => providerById.get(account.providerId)?.sourceType !== 'relay'),
    [providerById, snapshot.accounts],
  )
  const proxyById = useMemo(() => new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy])), [snapshot.proxies])
  const relaySources = useMemo(() => snapshot.providers.flatMap((provider) => {
    if (provider.sourceType !== 'relay') return []
    const accounts = snapshot.accounts.filter((account) => account.providerId === provider.id)
    return accounts.length === 1 && accounts[0].credentialType === 'api-key' ? [{ provider, account: accounts[0] }] : []
  }), [snapshot.accounts, snapshot.providers])

  const setFastMode = async (sourceId: string, enabled: boolean) => {
    const actionKey = `set-fast-mode:${sourceId}`
    setPendingFastModes((current) => ({ ...current, [sourceId]: enabled }))
    try {
      await runAction(actionKey, () => api.setRouteSourceFastMode({ sourceId, enabled }))
    } finally {
      setPendingFastModes((current) => {
        const next = { ...current }
        delete next[sourceId]
        return next
      })
    }
  }

  const openPool = (pool?: Pool) => {
    setDraft(pool ? {
      id: pool.id,
      name: pool.name,
      kind: pool.kind,
      protocol: pool.protocol,
      strategy: pool.strategy,
      accountIds: pool.members
        .filter((member) => member.enabled && providerById.get(accountById.get(member.accountId)?.providerId ?? '')?.sourceType !== 'relay')
        .map((member) => member.accountId),
      modelPolicy: pool.modelPolicy,
      modelAllowlist: [...pool.modelAllowlist],
      stickySessions: pool.stickySessions,
      stickyTtlMinutes: pool.stickyTtlMinutes,
      maxRetries: pool.maxRetries,
      forceFastMode: pool.forceFastMode ?? false,
      hedgedRequests: pool.hedgedRequests ?? false,
      hedgeDelayMs: pool.hedgeDelayMs ?? 2500,
      firstBodyTimeoutMs: pool.firstBodyTimeoutMs ?? 8000,
      proxyId: pool.proxyId ?? '',
    } : emptyDraft())
    setErrors({})
    setModalOpen(true)
    setMenuOpen(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!draft.name.trim()) nextErrors.name = t('请输入号池名称', 'Enter a pool name.')
    if (!draft.accountIds.length) nextErrors.accounts = t('至少选择一个账号', 'Select at least one account.')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-pool', () => api.savePool({ ...draft, name: draft.name.trim() }))
    if (success) setModalOpen(false)
  }

  const coverageForAccounts = (accountIds: string[]) => buildPoolModelCoverage(
    accountIds.flatMap((accountId) => {
      const account = accountById.get(accountId)
      return account && providerById.get(account.providerId)?.sourceType !== 'relay' ? [account] : []
    }),
    (providerId) => providerById.get(providerId)?.models ?? [],
  )

  const updateMemberIds = (accountIds: string[]) => {
    const candidates = coverageForAccounts(accountIds).options.map((option) => option.model)
    setDraft((current) => ({
      ...current,
      accountIds,
      modelAllowlist: pruneModelSelection(current.modelAllowlist, candidates),
    }))
  }

  const toggleTagMembers = (tagId: string) => {
    const matchingIds = snapshot.accounts
      .filter((account) => account.credentialType === 'chatgpt-oauth' && account.tagId === tagId)
      .filter((account) => providerById.get(account.providerId)?.protocol === draft.protocol)
      .map((account) => account.id)
    if (!matchingIds.length) return
    const selected = new Set(draft.accountIds)
    const allSelected = matchingIds.every((id) => selected.has(id))
    if (allSelected) matchingIds.forEach((id) => selected.delete(id))
    else matchingIds.forEach((id) => selected.add(id))
    updateMemberIds([...selected])
  }

  const draftCoverage = coverageForAccounts(draft.accountIds)

  const removePool = async () => {
    if (!deleteTarget) return
    const success = await runAction('delete-pool', () => api.deletePool(deleteTarget.id))
    if (success) setDeleteTarget(null)
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('号池', 'Pools')}
        actions={<button className="button button--primary" type="button" onClick={() => openPool()} disabled={!poolEligibleAccounts.length}><Plus size={16} />{t('新建号池', 'New pool')}</button>}
      />

      {snapshot.pools.length || relaySources.length ? (
        <div className="pool-grid">
          {snapshot.pools.map((pool) => {
            const members = pool.members.map((member) => accountById.get(member.accountId)).filter(Boolean)
            const enabledMembers = pool.members
              .filter((member) => member.enabled)
              .map((member) => accountById.get(member.accountId))
              .filter((account) => account !== undefined)
            const modelCoverage = buildPoolModelCoverage(enabledMembers, (providerId) => providerById.get(providerId)?.models ?? [])
            const openModels = effectivePoolModels(pool, modelCoverage.options)
            const wildcard = isPoolModelWildcard(pool, enabledMembers)
            const availableCount = members.filter((member) => member?.status === 'active').length
            const inFlight = members.reduce((sum, member) => sum + (member?.inFlight ?? 0), 0)
            const capacity = members.reduce((sum, member) => sum + (member?.maxConcurrency ?? 0), 0)
            const routeCount = snapshot.routes.filter((route) => route.poolId === pool.id).length
            const fastSupported = supportsFastServiceTier(pool.protocol)
            const fastEnabled = fastSupported && (pendingFastModes[pool.id] ?? pool.forceFastMode ?? false)
            const fastBusy = busyKeys.has(`set-fast-mode:${pool.id}`)
            return (
              <article className="pool-card" key={pool.id}>
                <header className="pool-card__header">
                  <div className="pool-icon"><Network size={19} /></div>
                  <div><h2>{setupPoolDisplayName(pool.name, t)}</h2><span>{protocolLabels[pool.protocol]} · {wildcard ? t(`兼容通配（已枚举 ${openModels.length}）`, `Compatible wildcard (${openModels.length} enumerated)`) : t(`开放 ${openModels.length} 个模型`, `${openModels.length} ${openModels.length === 1 ? 'model' : 'models'} allowed`)}</span></div>
                  <FastModeControl
                    sourceName={setupPoolDisplayName(pool.name, t)}
                    sourceKind="pool"
                    enabled={fastEnabled}
                    supported={fastSupported}
                    busy={fastBusy}
                    onToggle={() => void setFastMode(pool.id, !fastEnabled)}
                  />
                  <OverflowMenu open={menuOpen === pool.id} onOpenChange={(open) => setMenuOpen(open ? pool.id : null)} label={t('号池操作', 'Pool actions')}>{pool.kind === 'standard' ? <><button type="button" onClick={() => openPool(pool)}><Edit3 size={15} />{t('编辑', 'Edit')}</button><button className="danger" type="button" onClick={() => { setDeleteTarget(pool); setMenuOpen(null) }}><Trash2 size={15} />{t('删除', 'Delete')}</button></> : <button type="button" onClick={() => { window.location.hash = '#providers'; setMenuOpen(null) }}><Edit3 size={15} />{t('前往中转站管理', 'Manage relays')}</button>}</OverflowMenu>
                </header>

                <div className="pool-card__stats">
                  <div><span>{t('可用账号', 'Available accounts')}</span><strong>{availableCount} / {members.length}</strong></div>
                  <div><span>{t('当前并发', 'Current concurrency')}</span><strong>{inFlight} / {capacity}</strong></div>
                  <div><span>{t('客户端路由', 'Client routes')}</span><strong>{routeCount}</strong></div>
                </div>

                <div className="pool-strategy"><Shuffle size={15} /><div><strong>{t(strategyLabels[pool.strategy], strategyLabelsEn[pool.strategy])}</strong><span>{t(strategyDescriptions[pool.strategy], strategyDescriptionsEn[pool.strategy])}</span></div>{pool.kind === 'relay-aggregate' && <Badge tone="info">{t('聚合中转', 'Aggregate relay')}</Badge>}</div>

                <div className="model-tags pool-card__models">
                  {openModels.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                  {openModels.length > 3 && <span>+{openModels.length - 3}</span>}
                  {!openModels.length && <span className="muted">{wildcard ? t('兼容通配 · 尚无目录候选', 'Compatible wildcard · No catalog candidates') : t('未开放模型', 'No models allowed')}</span>}
                </div>

                <div className="pool-members">
                  <div className="pool-members__heading"><span>{t('账号顺序', 'Account order')}</span><div className="badge-row"><Badge tone={pool.stickySessions ? 'info' : 'neutral'}>{pool.stickySessions ? t(`${pool.stickyTtlMinutes} 分钟粘性`, `${pool.stickyTtlMinutes}-minute stickiness`) : t('无会话粘性', 'No session stickiness')}</Badge></div></div>
                  {members.map((account, index) => {
                    if (!account) return null
                    const provider = providerById.get(account.providerId)
                    return (
                      <div className="pool-member" key={account.id}>
                        <span className="pool-member__order">{index + 1}</span>
                        <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1)}</span>
                        <div><strong>{account.name}</strong><span>{provider?.name} · {t('权重', 'Weight')} {account.weight}{account.proxyId ? t(` · 账号代理：${proxyById.get(account.proxyId)?.name ?? '已删除'}`, ` · Account proxy: ${proxyById.get(account.proxyId)?.name ?? 'Deleted'}`) : ''}</span></div>
                        <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                      </div>
                    )
                  })}
                </div>

                <footer className="pool-card__footer"><span>{t(`失败重试 ${pool.maxRetries} 次`, `${pool.maxRetries} failure ${pool.maxRetries === 1 ? 'retry' : 'retries'}`)} · {pool.proxyId ? t(`默认出口 ${proxyById.get(pool.proxyId)?.name ?? '代理已删除'}`, `Default proxy: ${proxyById.get(pool.proxyId)?.name ?? 'Deleted proxy'}`) : t('默认直连', 'Direct by default')}</span>{pool.kind === 'standard' ? <button type="button" className="text-button" onClick={() => openPool(pool)}>{t('编辑配置', 'Edit configuration')}</button> : <button type="button" className="text-button" onClick={() => { window.location.hash = '#providers' }}>{t('前往“账号与中转”管理', 'Manage in Accounts & Relays')}</button>}</footer>
              </article>
            )
          })}
          {relaySources.map(({ provider, account }) => {
            const openModels = effectiveAccountModels(account, provider.models)
            const wildcard = isAccountModelWildcard(account)
            const routeCount = snapshot.routes.filter((route) => route.poolId === provider.id).length
            const fastSupported = supportsFastServiceTier(provider.protocol)
            const fastEnabled = fastSupported && (pendingFastModes[provider.id] ?? provider.forceFastMode ?? false)
            const fastBusy = busyKeys.has(`set-fast-mode:${provider.id}`)
            return (
              <article className="pool-card pool-card--relay-source" key={`relay-source:${provider.id}`}>
                <header className="pool-card__header">
                  <div className="pool-icon pool-icon--relay"><RadioTower size={19} /></div>
                  <div><h2>{provider.name}</h2><span>{protocolLabels[provider.protocol]} · {t('独立中转来源', 'Standalone relay source')}</span></div>
                  <FastModeControl
                    sourceName={provider.name}
                    sourceKind="relay"
                    enabled={fastEnabled}
                    supported={fastSupported}
                    busy={fastBusy}
                    onToggle={() => void setFastMode(provider.id, !fastEnabled)}
                  />
                  <Badge tone="neutral">{t('只读', 'Read only')}</Badge>
                </header>

                <div className="pool-card__stats">
                  <div><span>{t('来源状态', 'Source status')}</span><strong>{account.status === 'active' ? t('可用', 'Available') : account.status === 'disabled' ? t('已停用', 'Disabled') : account.status === 'checking' ? t('检测中', 'Checking') : t('需关注', 'Needs attention')}</strong></div>
                  <div><span>{t('当前并发', 'Current concurrency')}</span><strong>{account.inFlight} / {account.maxConcurrency}</strong></div>
                  <div><span>{t('客户端路由', 'Client routes')}</span><strong>{routeCount}</strong></div>
                </div>

                <div className="pool-strategy pool-strategy--relay"><RadioTower size={15} /><div><strong>{t('独立中转站', 'Standalone relay')}</strong><span>{provider.baseUrl}</span></div><Badge tone="info">{t('来源', 'Source')}</Badge></div>

                <div className="model-tags pool-card__models">
                  {openModels.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                  {openModels.length > 3 && <span>+{openModels.length - 3}</span>}
                  {!openModels.length && <span className="muted">{wildcard ? t('兼容通配 · 尚无目录候选', 'Compatible wildcard · No catalog candidates') : t('未开放模型', 'No models allowed')}</span>}
                </div>

                <div className="pool-members">
                  <div className="pool-members__heading"><span>{t('中转来源', 'Relay source')}</span><Badge tone="neutral">{t('配置只读', 'Read-only configuration')}</Badge></div>
                  <div className="pool-member">
                    <span className="pool-member__order">1</span>
                    <span className="provider-avatar" style={{ '--provider-color': provider.color ?? '#61736f' } as React.CSSProperties}>{provider.name.slice(0, 1)}</span>
                    <div><strong>{account.name}</strong><span>{t('优先级', 'Priority')} {account.priority} · {t('权重', 'Weight')} {account.weight}{account.proxyId ? t(` · 代理：${proxyById.get(account.proxyId)?.name ?? '已删除'}`, ` · Proxy: ${proxyById.get(account.proxyId)?.name ?? 'Deleted'}`) : ''}</span></div>
                    <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                  </div>
                </div>

                <footer className="pool-card__footer"><button type="button" className="text-button" onClick={() => { window.location.hash = '#providers' }}>{t('前往管理', 'Manage')}<ArrowUpRight size={13} /></button></footer>
              </article>
            )
          })}
        </div>
      ) : (
        <section className="panel">
          <EmptyState icon={<Layers3 size={25} />} title={t('尚未建立号池', 'No pools yet')} description={poolEligibleAccounts.length ? undefined : t('请先添加账号或官方 API，再建立号池', 'Add an account or official API before creating a pool.')} action={poolEligibleAccounts.length ? <button className="button button--primary" type="button" onClick={() => openPool()}><Plus size={16} />{t('新建号池', 'New pool')}</button> : undefined} />
        </section>
      )}

      <Modal
        open={modalOpen}
        title={draft.id ? t('编辑号池', 'Edit pool') : t('新建号池', 'New pool')}
        width="large"
        onClose={() => setModalOpen(false)}
        footer={<><button className="button button--secondary" type="button" onClick={() => setModalOpen(false)}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" form="pool-form" disabled={busyKeys.has('save-pool')}>{busyKeys.has('save-pool') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{t('保存号池', 'Save pool')}</button></>}
      >
        <form id="pool-form" onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <label className="field">
              <span>{t('号池名称', 'Pool name')}</span>
              <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例如：Claude 稳定池', 'e.g. Stable Claude pool')} />
              <FieldError>{errors.name}</FieldError>
            </label>
            <label className="field">
              <span>{t('对外协议', 'Public protocol')}</span>
              <select
                value={draft.protocol}
                onChange={(event) => {
                  const protocol = event.target.value as Protocol
                  const accountIds = draft.accountIds.filter((accountId) => {
                    const account = accountById.get(accountId)
                    const provider = account ? providerById.get(account.providerId) : undefined
                    return provider?.sourceType !== 'relay' && provider?.protocol === protocol
                  })
                  const candidates = coverageForAccounts(accountIds).options.map((option) => option.model)
                  setDraft({
                    ...draft,
                    protocol,
                    accountIds,
                    modelAllowlist: pruneModelSelection(draft.modelAllowlist, candidates),
                    forceFastMode: supportsFastServiceTier(protocol) ? draft.forceFastMode : false,
                    hedgedRequests: protocol === 'openai-responses' ? draft.hedgedRequests : false,
                  })
                }}
              >
                {protocols.map((protocol) => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}
              </select>
            </label>
            <label className="field field--full">
              <span>{t('调度策略', 'Scheduling strategy')}</span>
              <div className="strategy-options">
                {(Object.keys(strategyLabels) as PoolStrategy[]).map((strategy) => (
                  <button className={draft.strategy === strategy ? 'active' : ''} type="button" key={strategy} onClick={() => setDraft({ ...draft, strategy })}>
                    <span className="radio-mark">{draft.strategy === strategy && <Check size={13} />}</span>
                    <span><strong>{t(strategyLabels[strategy], strategyLabelsEn[strategy])}<InfoTip text={t(strategyDescriptions[strategy], strategyDescriptionsEn[strategy])} focusable={false} /></strong></span>
                  </button>
                ))}
              </div>
            </label>
            <label className="field field--full">
              <span className="field-label-with-help">{t('号池默认出口代理', 'Default pool proxy')}<InfoTip text={t('成员账号配置专属代理时优先使用账号代理。', 'An account-specific proxy takes precedence over the pool default.')} /></span>
              <select value={draft.proxyId ?? ''} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}>
                <option value="">{t('直连', 'Direct')}</option>
                {snapshot.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}
              </select>
            </label>
            <div className="field field--full">
              <span>{t('账号成员', 'Account members')}</span>
              {snapshot.accountTags.length > 0 && <div className="pool-tag-quick-select" aria-label={t('按 Tag 快速选择账号', 'Quickly select accounts by tag')}>
                <span>{t('Tag 快选', 'Quick tag selection')}</span>
                {snapshot.accountTags.map((tag) => {
                  const matchingIds = snapshot.accounts
                    .filter((account) => account.credentialType === 'chatgpt-oauth' && account.tagId === tag.id)
                    .filter((account) => providerById.get(account.providerId)?.protocol === draft.protocol)
                    .map((account) => account.id)
                  const allSelected = matchingIds.length > 0 && matchingIds.every((id) => draft.accountIds.includes(id))
                  return <button type="button" key={tag.id} disabled={!matchingIds.length} className={allSelected ? 'active' : ''} onClick={() => toggleTagMembers(tag.id)}>{tag.name}<span>{matchingIds.length}</span></button>
                })}
              </div>}
              <div className="account-picker">
                {poolEligibleAccounts.map((account) => {
                  const selected = draft.accountIds.includes(account.id)
                  const provider = providerById.get(account.providerId)
                  const compatible = provider?.protocol === draft.protocol
                  const wildcard = isAccountModelWildcard(account)
                  return (
                    <button
                      type="button"
                      className={`${selected ? 'selected' : ''} ${!compatible ? 'incompatible' : ''}`}
                      key={account.id}
                      disabled={!compatible}
                      title={compatible ? undefined : t(`账号协议为 ${provider ? protocolLabels[provider.protocol] : '未知'}，与号池不匹配`, `Account protocol is ${provider ? protocolLabels[provider.protocol] : 'unknown'} and does not match the pool.`)}
                      onClick={() => updateMemberIds(selected ? draft.accountIds.filter((id) => id !== account.id) : [...draft.accountIds, account.id])}
                    >
                      <span className="checkbox-mark">{selected && <Check size={13} />}</span>
                      <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1)}</span>
                      <span><strong>{account.name}</strong><small>{provider?.name} · {protocolLabels[provider?.protocol ?? 'openai-chat']} · {wildcard ? t('待刷新 · 兼容通配', 'Refresh pending · Compatible wildcard') : t(`开放 ${effectiveAccountModels(account, provider?.models).length} 个模型`, `${effectiveAccountModels(account, provider?.models).length} models allowed`)}</small></span>
                      {compatible ? <AccountStatusBadge status={account.status} circuitState={account.circuitState} /> : <Badge tone="neutral">{t('协议不匹配', 'Protocol mismatch')}</Badge>}
                    </button>
                  )
                })}
              </div>
              <FieldError>{errors.accounts}</FieldError>
            </div>
            <div className="field field--full">
              <ModelPolicyEditor
                title={t('号池开放模型', 'Models allowed by the pool')}
                description={t(`候选来自 ${draftCoverage.totalAccounts} 个成员账号开放模型的并集；部分支持的模型只会调度到兼容账号。`, `Candidates are the union of models allowed by ${draftCoverage.totalAccounts} member accounts. Partially supported models are routed only to compatible accounts.`)}
                policy={draft.modelPolicy}
                selectedModels={draft.modelAllowlist}
                options={draftCoverage.options}
                onPolicyChange={(modelPolicy) => setDraft({ ...draft, modelPolicy })}
                onSelectedModelsChange={(modelAllowlist) => setDraft({ ...draft, modelAllowlist })}
                catalogNotice={draftCoverage.fallbackAccountCount > 0 ? t(`${draftCoverage.fallbackAccountCount} 个成员账号尚未单独刷新模型，当前包含供应商目录兼容候选。`, `${draftCoverage.fallbackAccountCount} member accounts have not refreshed their models yet, so compatible provider-catalog candidates are included.`) : undefined}
                emptyMessage={t('所选成员账号没有开放模型；请先在账号中拉取并开放模型。', 'The selected member accounts do not allow any models. Refresh and allow models on those accounts first.')}
                emptySelectionMessage={t('已明确不对外开放任何模型；保存后此号池不会承接模型请求。', 'No models are explicitly allowed. After saving, this pool will not accept model requests.')}
              />
            </div>
            <div className="field field--full inline-settings">
              <div><strong>{t('FAST 服务层', 'FAST service tier')}<InfoTip text={supportsFastServiceTier(draft.protocol) ? t('强制号池内所有对话使用上游 Fast 服务层，可能消耗对应服务额度。', 'Force every conversation in the pool to use the upstream FAST service tier, which may consume the corresponding service quota.') : t('仅 OpenAI Responses 与 OpenAI Chat 协议支持此选项。', 'Only OpenAI Responses and OpenAI Chat support this option.')} /></strong></div>
              <button
                className={`toggle ${draft.forceFastMode ? 'toggle--on' : ''}`}
                role="switch"
                aria-label={t('FAST 服务层', 'FAST service tier')}
                aria-checked={draft.forceFastMode}
                type="button"
                disabled={!supportsFastServiceTier(draft.protocol)}
                onClick={() => setDraft({ ...draft, forceFastMode: !draft.forceFastMode })}
              ><span /></button>
            </div>
            <div className="field field--full inline-settings">
              <div><strong>{t('会话粘性', 'Session stickiness')}<InfoTip text={t('同一会话优先复用已分配账号，减少上下文和缓存命中波动。', 'Prefer the assigned account for the same session to reduce context and cache-hit variability.')} /></strong></div>
              <button className={`toggle ${draft.stickySessions ? 'toggle--on' : ''}`} role="switch" aria-label={t('会话粘性', 'Session stickiness')} aria-checked={draft.stickySessions} type="button" onClick={() => setDraft({ ...draft, stickySessions: !draft.stickySessions })}><span /></button>
            </div>
            <div className="field field--full inline-settings">
              <div><strong>{t('极低延迟竞速', 'Low-latency hedging')}<InfoTip text={draft.protocol === 'openai-responses' ? t('响应头等待过久时发起备用请求，可能增加短时额度消耗。', 'Start a backup request when response headers take too long. This may briefly increase quota usage.') : t('仅 OpenAI Responses 协议支持此选项。', 'Only OpenAI Responses supports this option.')} /></strong></div>
              <button className={`toggle ${draft.hedgedRequests ? 'toggle--on' : ''}`} role="switch" aria-label={t('极低延迟竞速', 'Low-latency hedging')} aria-checked={draft.hedgedRequests} type="button" disabled={draft.protocol !== 'openai-responses'} onClick={() => setDraft({ ...draft, hedgedRequests: !draft.hedgedRequests })}><span /></button>
            </div>
            {draft.stickySessions && <label className="field"><span>{t('粘性时长（分钟）', 'Stickiness duration (minutes)')}</span><input type="number" min={1} max={1440} value={draft.stickyTtlMinutes} onChange={(event) => setDraft({ ...draft, stickyTtlMinutes: Number(event.target.value) })} /></label>}
            <label className="field"><span>{t('失败重试次数', 'Failure retries')}</span><input type="number" min={0} max={5} value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })} /></label>
            <label className="field"><span className="field-label-with-help">{t('首正文截止（毫秒）', 'First-body deadline (ms)')}<InfoTip text={t('超过此时间仍未收到正文时，本次上游尝试会进入超时处理。', 'If no response body arrives by this deadline, the upstream attempt times out.')} /></span><input type="number" min={1000} max={12000} step={250} value={draft.firstBodyTimeoutMs} onChange={(event) => setDraft({ ...draft, firstBodyTimeoutMs: Number(event.target.value) })} /></label>
            {draft.hedgedRequests && <label className="field"><span className="field-label-with-help">{t('备用请求启动（毫秒）', 'Backup request delay (ms)')}<InfoTip text={t('主请求等待超过此时间后启动备用请求，较小数值会更积极地消耗额度。', 'Start a backup request after the primary waits this long. Lower values consume quota more aggressively.')} /></span><input type="number" min={250} max={15000} step={250} value={draft.hedgeDelayMs} onChange={(event) => setDraft({ ...draft, hedgeDelayMs: Number(event.target.value) })} /></label>}
          </div>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title={t('删除号池', 'Delete pool')} message={t(`确定删除“${deleteTarget?.name ?? ''}”吗？已引用该号池的路由需要先切换。`, `Delete “${deleteTarget?.name ?? ''}”? Routes that reference this pool must be switched first.`)} busy={busyKeys.has('delete-pool')} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removePool()} />
    </div>
  )
}
