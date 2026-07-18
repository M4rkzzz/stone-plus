import { useMemo, useState } from 'react'
import {
  Check,
  CheckCircle2,
  Edit3,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Network,
  Plus,
  Shuffle,
  Trash2,
} from 'lucide-react'
import type { AppSnapshot, GatewayApi, ModelPolicy, Pool, PoolInput, PoolStrategy, Protocol } from '@shared/types'
import type { ActionRunner } from '../App'
import { buildPoolModelCoverage, effectiveAccountModels, effectivePoolModels, isAccountModelWildcard, isPoolModelWildcard, pruneModelSelection } from '../model-policy'
import {
  AccountStatusBadge,
  Badge,
  ConfirmDialog,
  EmptyState,
  FieldError,
  Modal,
  PageHeader,
  protocolLabels,
} from '../ui'
import { ModelPolicyEditor } from './ModelPolicyEditor'

const strategyLabels: Record<PoolStrategy, string> = {
  balanced: '均衡调度',
  autobalanced: '智能均衡',
  priority: '优先级',
  'round-robin': '轮询',
  'weighted-random': '加权随机',
}

const strategyDescriptions: Record<PoolStrategy, string> = {
  balanced: '按并发负载与额度均衡分配',
  autobalanced: '根据首字与输出速度动态择优',
  priority: '优先使用数值较小的账号',
  'round-robin': '按固定顺序依次分配请求',
  'weighted-random': '按照账号权重随机分配',
}

const protocols: Protocol[] = ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini']

type PoolDraft = Omit<PoolInput, 'modelPolicy' | 'modelAllowlist' | 'forceFastMode'> & {
  modelPolicy: ModelPolicy
  modelAllowlist: string[]
  forceFastMode: boolean
}

function emptyDraft(): PoolDraft {
  return {
    name: '',
    protocol: 'anthropic-messages',
    strategy: 'balanced',
    accountIds: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2,
    forceFastMode: false,
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
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<PoolDraft>(emptyDraft())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<Pool | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)

  const accountById = useMemo(() => new Map(snapshot.accounts.map((account) => [account.id, account])), [snapshot.accounts])
  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const proxyById = useMemo(() => new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy])), [snapshot.proxies])

  const openPool = (pool?: Pool) => {
    setDraft(pool ? {
      id: pool.id,
      name: pool.name,
      protocol: pool.protocol,
      strategy: pool.strategy,
      accountIds: pool.members.filter((member) => member.enabled).map((member) => member.accountId),
      modelPolicy: pool.modelPolicy,
      modelAllowlist: [...pool.modelAllowlist],
      stickySessions: pool.stickySessions,
      stickyTtlMinutes: pool.stickyTtlMinutes,
      maxRetries: pool.maxRetries,
      forceFastMode: pool.forceFastMode ?? false,
      proxyId: pool.proxyId ?? '',
    } : emptyDraft())
    setErrors({})
    setModalOpen(true)
    setMenuOpen(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!draft.name.trim()) nextErrors.name = '请输入号池名称'
    if (!draft.accountIds.length) nextErrors.accounts = '至少选择一个账号'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-pool', () => api.savePool({ ...draft, name: draft.name.trim() }))
    if (success) setModalOpen(false)
  }

  const coverageForAccounts = (accountIds: string[]) => buildPoolModelCoverage(
    accountIds.map((accountId) => accountById.get(accountId)).filter((account) => account !== undefined),
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

  const draftCoverage = coverageForAccounts(draft.accountIds)

  const removePool = async () => {
    if (!deleteTarget) return
    const success = await runAction('delete-pool', () => api.deletePool(deleteTarget.id))
    if (success) setDeleteTarget(null)
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="号池"
        description="组合上游账号并定义本地调度策略"
        actions={<button className="button button--primary" type="button" onClick={() => openPool()} disabled={!snapshot.accounts.length}><Plus size={16} />新建号池</button>}
      />

      {snapshot.pools.length ? (
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
            return (
              <article className="pool-card" key={pool.id}>
                <header className="pool-card__header">
                  <div className="pool-icon"><Network size={19} /></div>
                  <div><h2>{pool.name}</h2><span>{protocolLabels[pool.protocol]} · {wildcard ? `兼容通配（已枚举 ${openModels.length}）` : `开放 ${openModels.length} 个模型`}</span></div>
                  <div className="menu-wrap">
                    <button className="icon-button" type="button" title="号池操作" onClick={() => setMenuOpen(menuOpen === pool.id ? null : pool.id)}><MoreHorizontal size={18} /></button>
                    {menuOpen === pool.id && <div className="context-menu"><button type="button" onClick={() => openPool(pool)}><Edit3 size={15} />编辑</button><button className="danger" type="button" onClick={() => { setDeleteTarget(pool); setMenuOpen(null) }}><Trash2 size={15} />删除</button></div>}
                  </div>
                </header>

                <div className="pool-card__stats">
                  <div><span>可用账号</span><strong>{availableCount} / {members.length}</strong></div>
                  <div><span>当前并发</span><strong>{inFlight} / {capacity}</strong></div>
                  <div><span>客户端路由</span><strong>{routeCount}</strong></div>
                </div>

                <div className="pool-strategy"><Shuffle size={15} /><div><strong>{strategyLabels[pool.strategy]}</strong><span>{strategyDescriptions[pool.strategy]}</span></div></div>

                <div className="model-tags pool-card__models">
                  {openModels.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                  {openModels.length > 3 && <span>+{openModels.length - 3}</span>}
                  {!openModels.length && <span className="muted">{wildcard ? '兼容通配 · 尚无目录候选' : '未开放模型'}</span>}
                </div>

                <div className="pool-members">
                  <div className="pool-members__heading"><span>账号顺序</span><div className="badge-row">{pool.forceFastMode && <Badge tone="info">Fast On</Badge>}<Badge tone={pool.stickySessions ? 'info' : 'neutral'}>{pool.stickySessions ? `${pool.stickyTtlMinutes} 分钟粘性` : '无会话粘性'}</Badge></div></div>
                  {members.map((account, index) => {
                    if (!account) return null
                    const provider = providerById.get(account.providerId)
                    return (
                      <div className="pool-member" key={account.id}>
                        <span className="pool-member__order">{index + 1}</span>
                        <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1)}</span>
                        <div><strong>{account.name}</strong><span>{provider?.name} · 权重 {account.weight}{account.proxyId ? ` · 账号代理：${proxyById.get(account.proxyId)?.name ?? '已删除'}` : ''}</span></div>
                        <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                      </div>
                    )
                  })}
                </div>

                <footer className="pool-card__footer"><span>失败重试 {pool.maxRetries} 次 · {pool.proxyId ? `默认出口 ${proxyById.get(pool.proxyId)?.name ?? '代理已删除'}` : '默认直连'}</span><button type="button" className="text-button" onClick={() => openPool(pool)}>编辑配置</button></footer>
              </article>
            )
          })}
        </div>
      ) : (
        <section className="panel">
          <EmptyState icon={<Layers3 size={25} />} title="尚未建立号池" description={snapshot.accounts.length ? '组合一个或多个账号作为路由目标' : '请先添加供应商账号，再建立号池'} action={snapshot.accounts.length ? <button className="button button--primary" type="button" onClick={() => openPool()}><Plus size={16} />新建号池</button> : undefined} />
        </section>
      )}

      <Modal
        open={modalOpen}
        title={draft.id ? '编辑号池' : '新建号池'}
        description="选择账号并设置请求分配规则"
        width="large"
        onClose={() => setModalOpen(false)}
        footer={<><button className="button button--secondary" type="button" onClick={() => setModalOpen(false)}>取消</button><button className="button button--primary" type="submit" form="pool-form" disabled={busyKeys.has('save-pool')}>{busyKeys.has('save-pool') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}保存号池</button></>}
      >
        <form id="pool-form" onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <label className="field">
              <span>号池名称</span>
              <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：Claude 稳定池" />
              <FieldError>{errors.name}</FieldError>
            </label>
            <label className="field">
              <span>对外协议</span>
              <select
                value={draft.protocol}
                onChange={(event) => {
                  const protocol = event.target.value as Protocol
                  const accountIds = draft.accountIds.filter((accountId) => {
                    const account = accountById.get(accountId)
                    return account ? providerById.get(account.providerId)?.protocol === protocol : false
                  })
                  const candidates = coverageForAccounts(accountIds).options.map((option) => option.model)
                  setDraft({
                    ...draft,
                    protocol,
                    accountIds,
                    modelAllowlist: pruneModelSelection(draft.modelAllowlist, candidates),
                    forceFastMode: protocol === 'openai-responses' ? draft.forceFastMode : false,
                  })
                }}
              >
                {protocols.map((protocol) => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}
              </select>
            </label>
            <label className="field field--full">
              <span>调度策略</span>
              <div className="strategy-options">
                {(Object.keys(strategyLabels) as PoolStrategy[]).map((strategy) => (
                  <button className={draft.strategy === strategy ? 'active' : ''} type="button" key={strategy} onClick={() => setDraft({ ...draft, strategy })}>
                    <span className="radio-mark">{draft.strategy === strategy && <Check size={13} />}</span>
                    <span><strong>{strategyLabels[strategy]}</strong><small>{strategyDescriptions[strategy]}</small></span>
                  </button>
                ))}
              </div>
            </label>
            <label className="field field--full">
              <span>号池默认出口代理</span>
              <select value={draft.proxyId ?? ''} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}>
                <option value="">直连</option>
                {snapshot.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}
              </select>
              <small>成员账号配置专属代理时优先使用账号代理</small>
            </label>
            <div className="field field--full">
              <span>账号成员</span>
              <div className="account-picker">
                {snapshot.accounts.map((account) => {
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
                      title={compatible ? undefined : `账号协议为 ${provider ? protocolLabels[provider.protocol] : '未知'}，与号池不匹配`}
                      onClick={() => updateMemberIds(selected ? draft.accountIds.filter((id) => id !== account.id) : [...draft.accountIds, account.id])}
                    >
                      <span className="checkbox-mark">{selected && <Check size={13} />}</span>
                      <span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1)}</span>
                      <span><strong>{account.name}</strong><small>{provider?.name} · {protocolLabels[provider?.protocol ?? 'openai-chat']} · {wildcard ? '待刷新 · 兼容通配' : `开放 ${effectiveAccountModels(account, provider?.models).length} 个模型`}</small></span>
                      {compatible ? <AccountStatusBadge status={account.status} circuitState={account.circuitState} /> : <Badge tone="neutral">协议不匹配</Badge>}
                    </button>
                  )
                })}
              </div>
              <FieldError>{errors.accounts}</FieldError>
            </div>
            <div className="field field--full">
              <ModelPolicyEditor
                title="号池开放模型"
                description={`候选来自 ${draftCoverage.totalAccounts} 个成员账号开放模型的并集；部分支持的模型只会调度到兼容账号。`}
                policy={draft.modelPolicy}
                selectedModels={draft.modelAllowlist}
                options={draftCoverage.options}
                onPolicyChange={(modelPolicy) => setDraft({ ...draft, modelPolicy })}
                onSelectedModelsChange={(modelAllowlist) => setDraft({ ...draft, modelAllowlist })}
                catalogNotice={draftCoverage.fallbackAccountCount > 0 ? `${draftCoverage.fallbackAccountCount} 个成员账号尚未单独刷新模型，当前包含供应商目录兼容候选。` : undefined}
                emptyMessage="所选成员账号没有开放模型；请先在账号中拉取并开放模型。"
                emptySelectionMessage="已明确不对外开放任何模型；保存后此号池不会承接模型请求。"
              />
            </div>
            <div className="field field--full inline-settings">
              <div><strong>Fast On</strong><span>{draft.protocol === 'openai-responses' ? '强制号池内所有对话使用 Fast 服务层' : '仅 OpenAI Responses 协议可用'}</span></div>
              <button
                className={`toggle ${draft.forceFastMode ? 'toggle--on' : ''}`}
                role="switch"
                aria-label="Fast On"
                aria-checked={draft.forceFastMode}
                type="button"
                disabled={draft.protocol !== 'openai-responses'}
                onClick={() => setDraft({ ...draft, forceFastMode: !draft.forceFastMode })}
              ><span /></button>
            </div>
            <div className="field field--full inline-settings">
              <div><strong>会话粘性</strong><span>同一会话优先复用已分配账号</span></div>
              <button className={`toggle ${draft.stickySessions ? 'toggle--on' : ''}`} role="switch" aria-checked={draft.stickySessions} type="button" onClick={() => setDraft({ ...draft, stickySessions: !draft.stickySessions })}><span /></button>
            </div>
            {draft.stickySessions && <label className="field"><span>粘性时长（分钟）</span><input type="number" min={1} max={1440} value={draft.stickyTtlMinutes} onChange={(event) => setDraft({ ...draft, stickyTtlMinutes: Number(event.target.value) })} /></label>}
            <label className="field"><span>失败重试次数</span><input type="number" min={0} max={5} value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })} /></label>
          </div>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title="删除号池" message={`确定删除“${deleteTarget?.name ?? ''}”吗？已引用该号池的路由需要先切换。`} busy={busyKeys.has('delete-pool')} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removePool()} />
    </div>
  )
}
