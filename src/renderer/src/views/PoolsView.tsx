import { useEffect, useMemo, useState } from 'react'
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
  RefreshCw,
  Shuffle,
  Trash2,
  Zap,
} from 'lucide-react'
import { supportsFastServiceTier, supportsPoolFastServiceTier } from '@shared/types'
import type {
  AppSnapshot,
  ChatGptWebWmVerificationProgress,
  GatewayApi,
  ModelPolicy,
  Pool,
  PoolInput,
  PoolProtocol,
  PoolStrategy,
  ProviderDefinition,
  PublicAccount,
  ReasoningEffort,
} from '@shared/types'
import { REASONING_EFFORTS } from '@shared/reasoning-policy'
import {
  accountMatchesPoolProtocol,
  accountPoolProtocol,
  isChatGptWebWmAccountCandidate,
} from '@shared/pool-protocol'
import { providerSourceFamily } from '@shared/source-family'
import { routeReferencesSource } from '@shared/route-models'
import {
  GPT_5_6_SOL_WM_MODEL,
  hasVerifiedChatGptWebWm,
  isChatGptWebWmPoolProtocol,
} from '@shared/wm-routing'
import type { ActionRunner } from '../App'
import { accountSourceLabel } from '../account-source-label'
import { localizeBackendError } from '../backend-message'
import { BUILT_IN_PROXY_BINDING_NOTICE, useBuiltInProxyInterlock } from '../built-in-proxy-interlocks'
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
  ProviderAvatar,
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

const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

const strategyDescriptionsEn: Record<PoolStrategy, string> = {
  balanced: 'Distribute requests by concurrency load and remaining quota',
  autobalanced: 'Choose dynamically based on time to first token and output speed',
  priority: 'Prefer accounts with lower priority values',
  'round-robin': 'Distribute requests in a fixed order',
  'weighted-random': 'Distribute requests randomly by account weight',
  'weighted-round-robin': 'Alternate requests smoothly by weight',
}

const protocols: PoolProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'chatgpt-web-wm',
  'openai-chat',
  'gemini',
  'grok',
]

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

interface WebWmVerificationViewState {
  progressId: string
  status: 'running' | 'passed' | 'failed'
  stage?: ChatGptWebWmVerificationProgress['stage']
  percent: number
  message: string
  latencyMs?: number
  verifiedAt?: number
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
    reasoningEffortMap: undefined,
    reasoningEffortCap: undefined,
    forceFastMode: false,
    hedgedRequests: false,
    hedgeDelayMs: 2500,
    firstBodyTimeoutMs: 8000,
    quotaProtection: undefined,
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
  const { t, language } = useI18n()
  const builtInProxyInterlocked = useBuiltInProxyInterlock(snapshot, api)
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<PoolDraft>(emptyDraft())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<Pool | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [pendingFastModes, setPendingFastModes] = useState<Record<string, boolean>>({})
  const [webWmVerification, setWebWmVerification] = useState<Record<string, WebWmVerificationViewState>>({})

  const accountById = useMemo(() => new Map(snapshot.accounts.map((account) => [account.id, account])), [snapshot.accounts])
  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const poolEligibleAccounts = useMemo(
    () => snapshot.accounts.filter((account) => {
      const provider = providerById.get(account.providerId)
      return provider !== undefined && provider.sourceType !== 'relay'
    }),
    [providerById, snapshot.accounts],
  )
  const webWmCandidateAccounts = useMemo(
    () => poolEligibleAccounts.filter((account) => (
      isChatGptWebWmAccountCandidate(account, providerById.get(account.providerId))
    )),
    [poolEligibleAccounts, providerById],
  )
  const proxyById = useMemo(() => new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy])), [snapshot.proxies])
  const relaySources = useMemo(() => snapshot.providers.flatMap((provider) => {
    if (provider.sourceType !== 'relay') return []
    const accounts = snapshot.accounts.filter((account) => account.providerId === provider.id)
    return accounts.length === 1 && accounts[0].credentialType === 'api-key' ? [{ provider, account: accounts[0] }] : []
  }), [snapshot.accounts, snapshot.providers])

  useEffect(() => api.onChatGptWebWmVerificationProgress((progress) => {
    setWebWmVerification((current) => {
      const existing = current[progress.accountId]
      if (!existing || existing.progressId !== progress.progressId) return current
      return {
        ...current,
        [progress.accountId]: {
          ...existing,
          stage: progress.stage,
          percent: progress.percent,
          message: progress.message,
          status: progress.status === 'failed'
            ? 'failed'
            : progress.status === 'complete' ? 'passed' : 'running',
        },
      }
    })
  }), [api])

  const hasDraftWebWmVerification = (account: PublicAccount): boolean => (
    hasVerifiedChatGptWebWm(account) || webWmVerification[account.id]?.status === 'passed'
  )

  const accountMatchesDraftProtocol = (
    protocol: PoolProtocol,
    account: PublicAccount,
    provider: ProviderDefinition | undefined,
  ): boolean => {
    if (!isChatGptWebWmPoolProtocol(protocol)) {
      return accountMatchesPoolProtocol(protocol, account, provider)
    }
    return isChatGptWebWmAccountCandidate(account, provider)
      && hasDraftWebWmVerification(account)
  }

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
      reasoningEffortMap: pool.reasoningEffortMap ? { ...pool.reasoningEffortMap } : undefined,
      reasoningEffortCap: pool.reasoningEffortCap,
      forceFastMode: pool.forceFastMode ?? false,
      hedgedRequests: pool.hedgedRequests ?? false,
      hedgeDelayMs: pool.hedgeDelayMs ?? 2500,
      firstBodyTimeoutMs: pool.firstBodyTimeoutMs ?? 8000,
      quotaProtection: pool.quotaProtection ? { ...pool.quotaProtection } : undefined,
      proxyId: pool.proxyId ?? '',
    } : emptyDraft())
    setErrors({})
    setWebWmVerification({})
    setModalOpen(true)
    setMenuOpen(null)
  }

  const verifyWebWmAccount = async (accountId: string) => {
    if (webWmVerification[accountId]?.status === 'running') return
    const progressId = `web-wm-${crypto.randomUUID()}`
    setWebWmVerification((current) => ({
      ...current,
      [accountId]: {
        progressId,
        status: 'running',
        percent: 0,
        message: t('正在启动检测…', 'Starting verification…'),
      },
    }))
    let resultSnapshot: AppSnapshot | undefined
    let failureMessage = t('Web WM 检测失败', 'Web WM verification failed')
    const success = await runAction(`verify-web-wm-${accountId}`, async () => {
      try {
        resultSnapshot = await api.verifyChatGptWebWmAccount(accountId, progressId)
        return resultSnapshot
      } catch (cause) {
        failureMessage = localizeBackendError(cause, language, failureMessage)
        throw cause
      }
    })
    const capability = resultSnapshot?.accounts.find((account) => account.id === accountId)?.chatgptWebWm
    setWebWmVerification((current) => {
      const existing = current[accountId]
      if (!existing || existing.progressId !== progressId) return current
      return {
        ...current,
        [accountId]: success ? {
          ...existing,
          status: 'passed',
          stage: 'complete',
          percent: 100,
          message: t('Web WM 实测通过', 'Web WM verification passed'),
          latencyMs: capability?.latencyMs,
          verifiedAt: capability?.verifiedAt,
        } : {
          ...existing,
          status: 'failed',
          message: failureMessage,
        },
      }
    })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!draft.name.trim()) nextErrors.name = t('请输入号池名称', 'Enter a pool name.')
    if (!draft.accountIds.length) nextErrors.accounts = t('至少选择一个账号', 'Select at least one account.')
    if (draft.accountIds.some((id) => {
      const account = accountById.get(id)
      const provider = providerById.get(account?.providerId ?? '')
      return !account || !accountMatchesDraftProtocol(draft.protocol, account, provider)
    })) {
      nextErrors.accounts = t('所选账号与号池对外协议不兼容。', 'A selected account is incompatible with the pool protocol.')
    }
    const families = new Set(draft.accountIds.flatMap((id) => {
      const account = accountById.get(id)
      const provider = providerById.get(account?.providerId ?? '')
      return provider ? [providerSourceFamily(provider.kind)] : []
    }))
    if (families.size > 1) nextErrors.accounts = t('一个号池只能使用同一种来源。', 'A pool can use only one source family.')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-pool', () => api.savePool({ ...draft, name: draft.name.trim() }))
    if (success) setModalOpen(false)
  }

  const coverageForAccounts = (accountIds: string[], protocol = draft.protocol) => {
    const accounts = accountIds.flatMap((accountId) => {
      const account = accountById.get(accountId)
      const provider = account ? providerById.get(account.providerId) : undefined
      return account && provider && accountMatchesDraftProtocol(protocol, account, provider) ? [account] : []
    })
    if (isChatGptWebWmPoolProtocol(protocol)) {
      return {
        options: accounts.length ? [{
          model: GPT_5_6_SOL_WM_MODEL,
          supportCount: accounts.length,
          totalAccounts: accounts.length,
        }] : [],
        totalAccounts: accounts.length,
        fallbackAccountCount: 0,
      }
    }
    return buildPoolModelCoverage(
      accounts,
      (providerId) => providerById.get(providerId)?.models ?? [],
    )
  }

  const updateMemberIds = (accountIds: string[]) => {
    const candidates = coverageForAccounts(accountIds).options.map((option) => option.model)
    const sourceFamily = accountIds
      .map((id) => accountById.get(id))
      .map((account) => providerById.get(account?.providerId ?? ''))
      .find(Boolean)
    setDraft((current) => ({
      ...current,
      accountIds,
      modelAllowlist: pruneModelSelection(current.modelAllowlist, candidates),
      forceFastMode: sourceFamily && providerSourceFamily(sourceFamily.kind) === 'deepseek'
        ? false
        : current.forceFastMode,
    }))
  }

  const toggleTagMembers = (tagId: string) => {
    const matchingIds = snapshot.accounts
      .filter((account) => (account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity') && account.tagId === tagId)
      .filter((account) => accountMatchesDraftProtocol(draft.protocol, account, providerById.get(account.providerId)))
      .map((account) => account.id)
    if (!matchingIds.length) return
    const selected = new Set(draft.accountIds)
    const allSelected = matchingIds.every((id) => selected.has(id))
    if (allSelected) matchingIds.forEach((id) => selected.delete(id))
    else matchingIds.forEach((id) => selected.add(id))
    updateMemberIds([...selected])
  }

  const draftCoverage = coverageForAccounts(draft.accountIds)
  const draftSourceFamily = useMemo(() => {
    const account = draft.accountIds.map((id) => accountById.get(id)).find(Boolean)
    const provider = providerById.get(account?.providerId ?? '')
    return provider ? providerSourceFamily(provider.kind) : undefined
  }, [accountById, draft.accountIds, providerById])
  const draftFastSupported = supportsPoolFastServiceTier(draft.protocol) && draftSourceFamily !== 'deepseek'

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
            const modelCoverage = isChatGptWebWmPoolProtocol(pool.protocol)
              ? {
                  options: enabledMembers.length ? [{
                    model: GPT_5_6_SOL_WM_MODEL,
                    supportCount: enabledMembers.length,
                    totalAccounts: enabledMembers.length,
                  }] : [],
                  totalAccounts: enabledMembers.length,
                  fallbackAccountCount: 0,
                }
              : buildPoolModelCoverage(enabledMembers, (providerId) => providerById.get(providerId)?.models ?? [])
            const openModels = effectivePoolModels(pool, modelCoverage.options)
            const wildcard = !isChatGptWebWmPoolProtocol(pool.protocol) && isPoolModelWildcard(pool, enabledMembers)
            const availableCount = members.filter((member) => member?.status === 'active').length
            const inFlight = members.reduce((sum, member) => sum + (member?.inFlight ?? 0), 0)
            const capacity = members.reduce((sum, member) => sum + (member?.maxConcurrency ?? 0), 0)
            const routeCount = snapshot.routes.filter((route) => routeReferencesSource(route, pool.id)).length
            const poolUsesDeepSeek = enabledMembers.some((account) => {
              const provider = providerById.get(account.providerId)
              return provider !== undefined && providerSourceFamily(provider.kind) === 'deepseek'
            })
            const fastSupported = supportsPoolFastServiceTier(pool.protocol) && !poolUsesDeepSeek
            const fastEnabled = fastSupported && (pendingFastModes[pool.id] ?? pool.forceFastMode ?? false)
            const fastBusy = busyKeys.has(`set-fast-mode:${pool.id}`)
            return (
              <article className="pool-card" key={pool.id}>
                <header className="pool-card__header">
                  <div className="pool-icon"><Network size={19} /></div>
                  <div><h2>{setupPoolDisplayName(pool.name, t)}</h2><span>{poolUsesDeepSeek ? 'DeepSeek Responses' : protocolLabels[pool.protocol]} · {wildcard ? t(`兼容通配（已枚举 ${openModels.length}）`, `Compatible wildcard (${openModels.length} enumerated)`) : t(`开放 ${openModels.length} 个模型`, `${openModels.length} ${openModels.length === 1 ? 'model' : 'models'} allowed`)}</span></div>
                  {!isChatGptWebWmPoolProtocol(pool.protocol) && <FastModeControl
                    sourceName={setupPoolDisplayName(pool.name, t)}
                    sourceKind="pool"
                    enabled={fastEnabled}
                    supported={fastSupported}
                    busy={fastBusy}
                    onToggle={() => void setFastMode(pool.id, !fastEnabled)}
                  />}
                  <OverflowMenu open={menuOpen === pool.id} onOpenChange={(open) => setMenuOpen(open ? pool.id : null)} label={t('号池操作', 'Pool actions')}>{pool.kind === 'standard' ? <><button type="button" onClick={() => openPool(pool)}><Edit3 size={15} />{t('编辑', 'Edit')}</button><button className="danger" type="button" onClick={() => { setDeleteTarget(pool); setMenuOpen(null) }}><Trash2 size={15} />{t('删除', 'Delete')}</button></> : <button type="button" onClick={() => { window.location.hash = '#providers'; setMenuOpen(null) }}><Edit3 size={15} />{t('前往中转站管理', 'Manage relays')}</button>}</OverflowMenu>
                </header>

                <div className="pool-card__stats">
                  <div><span>{t('可用账号', 'Available accounts')}</span><strong>{availableCount} / {members.length}</strong></div>
                  <div><span>{t('当前并发', 'Current concurrency')}</span><strong>{inFlight} / {capacity}</strong></div>
                  <div><span>{t('客户端路由', 'Client routes')}</span><strong>{routeCount}</strong></div>
                </div>

                <div className="pool-strategy"><Shuffle size={15} /><div><strong>{t(strategyLabels[pool.strategy], strategyLabelsEn[pool.strategy])}</strong><span>{t(strategyDescriptions[pool.strategy], strategyDescriptionsEn[pool.strategy])}</span></div>{isChatGptWebWmPoolProtocol(pool.protocol) && <Badge tone="info">Web WM</Badge>}{pool.kind === 'relay-aggregate' && <Badge tone="info">{t('聚合中转', 'Aggregate relay')}</Badge>}</div>

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
                    const sourceLabel = accountSourceLabel(account.credentialType, provider?.name)
                    return (
                      <div className="pool-member" key={account.id}>
                        <span className="pool-member__order">{index + 1}</span>
                        <ProviderAvatar kind={provider?.kind} name={sourceLabel} color={provider?.color} />
                        <div><strong>{account.name}</strong><span>{sourceLabel} · {t('权重', 'Weight')} {account.weight}{account.proxyId ? t(` · 账号代理：${proxyById.get(account.proxyId)?.name ?? '已删除'}`, ` · Account proxy: ${proxyById.get(account.proxyId)?.name ?? 'Deleted'}`) : ''}</span></div>
                        <AccountStatusBadge status={account.status} circuitState={account.circuitState} />
                      </div>
                    )
                  })}
                </div>

                <footer className="pool-card__footer"><span>{t(`失败重试 ${pool.maxRetries} 次`, `${pool.maxRetries} failure ${pool.maxRetries === 1 ? 'retry' : 'retries'}`)} · {pool.proxyId ? t(`默认代理 ${proxyById.get(pool.proxyId)?.name ?? '代理已删除'}`, `Default proxy: ${proxyById.get(pool.proxyId)?.name ?? 'Deleted proxy'}`) : t('默认直连', 'Direct by default')}</span>{pool.kind === 'standard' ? <button type="button" className="text-button" onClick={() => openPool(pool)}>{t('编辑配置', 'Edit configuration')}</button> : <button type="button" className="text-button" onClick={() => { window.location.hash = '#providers' }}>{t('前往“账号与中转”管理', 'Manage in Accounts & Relays')}</button>}</footer>
              </article>
            )
          })}
          {relaySources.map(({ provider, account }) => {
            const openModels = effectiveAccountModels(account, provider.models)
            const wildcard = isAccountModelWildcard(account)
            const routeCount = snapshot.routes.filter((route) => routeReferencesSource(route, provider.id)).length
            const fastSupported = supportsFastServiceTier(provider.protocol)
              && providerSourceFamily(provider.kind) !== 'deepseek'
            const fastEnabled = fastSupported && (pendingFastModes[provider.id] ?? provider.forceFastMode ?? false)
            const fastBusy = busyKeys.has(`set-fast-mode:${provider.id}`)
            return (
              <article className="pool-card pool-card--relay-source" key={`relay-source:${provider.id}`}>
                <header className="pool-card__header">
                  <div className="pool-icon pool-icon--relay"><RadioTower size={19} /></div>
                  <div><h2>{provider.name}</h2><span>{providerSourceFamily(provider.kind) === 'deepseek' ? 'DeepSeek Responses' : protocolLabels[provider.protocol]} · {t('独立中转来源', 'Standalone relay source')}</span></div>
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
                    <ProviderAvatar kind={provider.kind} name={provider.name} color={provider.color} />
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
          <EmptyState icon={<Layers3 size={25} />} title={t('尚未建立号池', 'No pools yet')} description={poolEligibleAccounts.length ? t('把同协议来源组合起来，即可获得轮换、故障转移和并发控制。', 'Combine sources using the same protocol for rotation, failover, and concurrency control.') : t('请先添加账号或官方 API，再建立号池。', 'Add an account or official API before creating a pool.')} action={poolEligibleAccounts.length ? <button className="button button--primary" type="button" onClick={() => openPool()}><Plus size={16} />{t('新建号池', 'New pool')}</button> : <button className="button button--primary" type="button" onClick={() => { window.location.hash = '#providers' }}><Plus size={16} />{t('前往添加来源', 'Add a source first')}</button>} />
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
                  const protocol = event.target.value as PoolProtocol
                  const accountIds = draft.accountIds.filter((accountId) => {
                    const account = accountById.get(accountId)
                    const provider = account ? providerById.get(account.providerId) : undefined
                    return Boolean(account && accountMatchesDraftProtocol(protocol, account, provider))
                  })
                  const candidates = coverageForAccounts(accountIds, protocol).options.map((option) => option.model)
                  setDraft({
                    ...draft,
                    protocol,
                    accountIds,
                    modelPolicy: isChatGptWebWmPoolProtocol(protocol) ? 'selected' : draft.modelPolicy,
                    modelAllowlist: isChatGptWebWmPoolProtocol(protocol)
                      ? [GPT_5_6_SOL_WM_MODEL]
                      : pruneModelSelection(draft.modelAllowlist, candidates),
                    forceFastMode: supportsPoolFastServiceTier(protocol) ? draft.forceFastMode : false,
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
              <span className="field-label-with-help">{t('号池默认代理', 'Default pool proxy')}<InfoTip text={t('成员账号配置专属代理时优先使用账号代理。', 'An account-specific proxy takes precedence over the pool default.')} /></span>
              <select value={draft.proxyId ?? ''} disabled={builtInProxyInterlocked} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}>
                <option value="">{t('直连', 'Direct')}</option>
                {snapshot.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}
              </select>
              {builtInProxyInterlocked && <small>{t(BUILT_IN_PROXY_BINDING_NOTICE.zh, BUILT_IN_PROXY_BINDING_NOTICE.en)}</small>}
            </label>
            <div className="field field--full">
              <span>{t('账号成员', 'Account members')}</span>
              {isChatGptWebWmPoolProtocol(draft.protocol) && <div className="web-wm-verifier">
                <div className="web-wm-verifier__header">
                  <div><CheckCircle2 size={17} /><span><strong>{t('Web WM 资格检测', 'Web WM eligibility')}</strong><small>{t('模型目录与真实回合均确认 5.6 Sol WM 后才可加入。', 'Both the model catalog and a real turn must confirm 5.6 Sol WM.')}</small></span></div>
                  <Badge tone={webWmCandidateAccounts.some((account) => hasDraftWebWmVerification(account)) ? 'success' : 'warning'}>
                    {webWmCandidateAccounts.filter((account) => hasDraftWebWmVerification(account)).length} / {webWmCandidateAccounts.length}
                  </Badge>
                </div>
                {webWmCandidateAccounts.length ? <div className="web-wm-verifier__list">
                  {webWmCandidateAccounts.map((account) => {
                    const provider = providerById.get(account.providerId)
                    const state = webWmVerification[account.id]
                    const storedCapability = hasVerifiedChatGptWebWm(account) ? account.chatgptWebWm : undefined
                    const passed = Boolean(storedCapability) || state?.status === 'passed'
                    const checking = state?.status === 'running'
                    const failed = state?.status === 'failed'
                    const latencyMs = state?.latencyMs ?? storedCapability?.latencyMs
                    const plan = storedCapability?.workspacePlanType
                      ?? account.codexQuota?.planType?.trim()
                    const statusText = checking || failed
                      ? state.message
                      : passed
                        ? t(`5.6 Sol 实测通过${latencyMs !== undefined ? ` · ${latencyMs} ms` : ''}`, `5.6 Sol verified${latencyMs !== undefined ? ` · ${latencyMs} ms` : ''}`)
                        : t('等待 Sol 模型检测', 'Waiting for a Sol model check')
                    return <div className="web-wm-verifier__row" key={account.id}>
                      <ProviderAvatar kind={provider?.kind} name={provider?.name} color={provider?.color} />
                      <div className="web-wm-verifier__account">
                        <strong>{account.name}</strong>
                        <small>{[plan, accountSourceLabel(account.credentialType, provider?.name)].filter(Boolean).join(' · ')}</small>
                        <span className={failed ? 'web-wm-verifier__message web-wm-verifier__message--error' : 'web-wm-verifier__message'}>{statusText}</span>
                        {(checking || failed) && <div className={`web-wm-verifier__progress ${failed ? 'web-wm-verifier__progress--failed' : ''}`} role="progressbar" aria-label={t(`${account.name} 检测进度`, `${account.name} verification progress`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
                          <span style={{ width: `${Math.max(0, Math.min(100, state.percent))}%` }} />
                        </div>}
                      </div>
                      <Badge tone={checking ? 'info' : failed ? 'danger' : passed ? 'success' : 'neutral'}>{checking ? `${state.percent}%` : failed ? t('失败', 'Failed') : passed ? t('已通过', 'Passed') : t('待检测', 'Pending')}</Badge>
                      <button className="button button--secondary web-wm-verifier__action" type="button" disabled={checking} onClick={() => void verifyWebWmAccount(account.id)}>
                        {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
                        {checking ? t('检测中', 'Checking') : passed ? t('重测', 'Retest') : failed ? t('重试', 'Retry') : t('检测', 'Check')}
                      </button>
                    </div>
                  })}
                </div> : <div className="web-wm-verifier__empty">{t('没有可检测的 ChatGPT OAuth 账号。', 'No ChatGPT OAuth account is available for verification.')}</div>}
              </div>}
              {snapshot.accountTags.length > 0 && draft.protocol !== 'grok' && <div className="pool-tag-quick-select" aria-label={t('按 Tag 快速选择账号', 'Quickly select accounts by tag')}>
                <span>{t('Tag 快选', 'Quick tag selection')}</span>
                {snapshot.accountTags.map((tag) => {
                  const matchingIds = snapshot.accounts
                    .filter((account) => (account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity') && account.tagId === tag.id)
                    .filter((account) => accountMatchesDraftProtocol(draft.protocol, account, providerById.get(account.providerId)))
                    .map((account) => account.id)
                  const allSelected = matchingIds.length > 0 && matchingIds.every((id) => draft.accountIds.includes(id))
                  return <button type="button" key={tag.id} disabled={!matchingIds.length} className={allSelected ? 'active' : ''} onClick={() => toggleTagMembers(tag.id)}>{tag.name}<span>{matchingIds.length}</span></button>
                })}
              </div>}
              <div className="account-picker">
                {poolEligibleAccounts.map((account) => {
                  const selected = draft.accountIds.includes(account.id)
                  const provider = providerById.get(account.providerId)
                  const wmCandidate = isChatGptWebWmAccountCandidate(account, provider)
                  const wmVerified = hasDraftWebWmVerification(account)
                  const protocolCompatible = Boolean(provider && accountMatchesDraftProtocol(draft.protocol, account, provider))
                  const familyCompatible = selected || !draftSourceFamily || (provider !== undefined && providerSourceFamily(provider.kind) === draftSourceFamily)
                  const compatible = protocolCompatible && familyCompatible
                  const canToggle = selected || compatible
                  const wildcard = isAccountModelWildcard(account)
                  const sourceLabel = accountSourceLabel(account.credentialType, provider?.name)
                  return (
                    <button
                      type="button"
                      className={`${selected ? 'selected' : ''} ${!compatible ? 'incompatible' : ''}`}
                      key={account.id}
                      disabled={!canToggle}
                      title={compatible ? undefined : !familyCompatible
                        ? t('号池已锁定为另一种来源。', 'The pool is locked to another source family.')
                        : isChatGptWebWmPoolProtocol(draft.protocol) && wmCandidate && !wmVerified
                          ? t(`请先在上方检测小窗完成 ${GPT_5_6_SOL_WM_MODEL} 真实验证。`, `Complete the real ${GPT_5_6_SOL_WM_MODEL} verification in the panel above first.`)
                        : t(`账号协议为 ${provider ? protocolLabels[provider.protocol] : '未知'}，与号池不匹配`, `Account protocol is ${provider ? protocolLabels[provider.protocol] : 'unknown'} and does not match the pool.`)}
                      onClick={() => updateMemberIds(selected ? draft.accountIds.filter((id) => id !== account.id) : [...draft.accountIds, account.id])}
                    >
                      <span className="checkbox-mark">{selected && <Check size={13} />}</span>
                      <ProviderAvatar kind={provider?.kind} name={sourceLabel} color={provider?.color} />
                      <span><strong>{account.name}</strong><small>{sourceLabel} · {provider ? protocolLabels[isChatGptWebWmPoolProtocol(draft.protocol) && wmVerified ? draft.protocol : accountPoolProtocol(account, provider)] : t('未知协议', 'Unknown protocol')} · {isChatGptWebWmPoolProtocol(draft.protocol) && wmVerified ? t('实测通过', 'Verified') : wildcard ? t('待刷新 · 兼容通配', 'Refresh pending · Compatible wildcard') : t(`开放 ${effectiveAccountModels(account, provider?.models).length} 个模型`, `${effectiveAccountModels(account, provider?.models).length} models allowed`)}</small></span>
                      {compatible ? <AccountStatusBadge status={account.status} circuitState={account.circuitState} /> : <Badge tone="neutral">{!familyCompatible ? t('来源不匹配', 'Source mismatch') : isChatGptWebWmPoolProtocol(draft.protocol) && wmCandidate && !wmVerified ? t('待检测', 'Pending check') : t('协议不匹配', 'Protocol mismatch')}</Badge>}
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
            {!isChatGptWebWmPoolProtocol(draft.protocol) && <div className="field field--full inline-settings">
              <div><strong>{t('FAST 服务层', 'FAST service tier')}<InfoTip text={draftFastSupported ? t('强制号池内所有对话使用上游 Fast 服务层，可能消耗对应服务额度。', 'Force every conversation in the pool to use the upstream FAST service tier, which may consume the corresponding service quota.') : draftSourceFamily === 'deepseek' ? t('DeepSeek Responses 不支持 FAST 服务层。', 'DeepSeek Responses does not support the FAST service tier.') : t('仅 OpenAI Responses 与 OpenAI Chat 协议支持此选项。', 'Only OpenAI Responses and OpenAI Chat support this option.')} /></strong></div>
              <button
                className={`toggle ${draft.forceFastMode ? 'toggle--on' : ''}`}
                role="switch"
                aria-label={t('FAST 服务层', 'FAST service tier')}
                aria-checked={draft.forceFastMode}
                type="button"
                disabled={!draftFastSupported}
                onClick={() => setDraft({ ...draft, forceFastMode: !draft.forceFastMode })}
              ><span /></button>
            </div>}
            <div className="field field--full inline-settings">
              <div><strong>{t('会话粘性', 'Session stickiness')}<InfoTip text={t('同一会话优先复用已分配账号，减少上下文和缓存命中波动。', 'Prefer the assigned account for the same session to reduce context and cache-hit variability.')} /></strong></div>
              <button className={`toggle ${draft.stickySessions ? 'toggle--on' : ''}`} role="switch" aria-label={t('会话粘性', 'Session stickiness')} aria-checked={draft.stickySessions} type="button" onClick={() => setDraft({ ...draft, stickySessions: !draft.stickySessions })}><span /></button>
            </div>
            <label className="field">
              <span className="field-label-with-help">{t('推理强度上限', 'Reasoning effort cap')}<InfoTip text={t('先应用下方精确映射，再限制最高强度；不会把较低强度主动抬高。DeepSeek 使用来源自身的原生强度设置。', 'Apply exact mappings first, then cap the maximum effort without raising lower efforts. DeepSeek uses its source-native effort setting.')} /></span>
              <select value={draft.reasoningEffortCap ?? ''} disabled={draftSourceFamily === 'deepseek'} onChange={(event) => setDraft({ ...draft, reasoningEffortCap: (event.target.value || undefined) as ReasoningEffort | undefined })}>
                <option value="">{t('不限制', 'No cap')}</option>
                {REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{reasoningEffortLabels[effort]}</option>)}
              </select>
            </label>
            <details className="field field--full" open={Boolean(draft.reasoningEffortMap && Object.keys(draft.reasoningEffortMap).length)}>
              <summary>{t('高级：精确映射推理强度', 'Advanced: exact reasoning effort mapping')}</summary>
              <div className="form-grid">
                {REASONING_EFFORTS.map((effort) => <label className="field" key={effort}>
                  <span>{reasoningEffortLabels[effort]}</span>
                  <select disabled={draftSourceFamily === 'deepseek'} value={draft.reasoningEffortMap?.[effort] ?? ''} onChange={(event) => {
                    const next = { ...(draft.reasoningEffortMap ?? {}) }
                    const value = event.target.value as ReasoningEffort | ''
                    if (!value || value === effort) delete next[effort]
                    else next[effort] = value
                    setDraft({ ...draft, reasoningEffortMap: Object.keys(next).length ? next : undefined })
                  }}>
                    <option value="">{t('保持原值', 'Keep original')}</option>
                    {REASONING_EFFORTS.map((target) => <option value={target} key={target}>{reasoningEffortLabels[target]}</option>)}
                  </select>
                </label>)}
              </div>
            </details>
            <div className="field field--full inline-settings">
              <div><strong>{t('额度保护线', 'Quota reserve guard')}<InfoTip text={t('达到保留额度后停止从该号池选择账号；不影响正在传输的请求。', 'Stop selecting accounts from this pool when its reserve is reached. In-flight requests are not interrupted.')} /></strong></div>
              <button className={`toggle ${draft.quotaProtection ? 'toggle--on' : ''}`} role="switch" aria-label={t('额度保护线', 'Quota reserve guard')} aria-checked={Boolean(draft.quotaProtection)} type="button" onClick={() => setDraft({ ...draft, quotaProtection: draft.quotaProtection ? undefined : { fiveHourRemainingPercent: 10, sevenDayRemainingPercent: 10, unavailableBehavior: 'allow', staleAfterMinutes: 15 } })}><span /></button>
            </div>
            {draft.quotaProtection && <>
              <label className="field"><span>{t('5 小时最低保留（%）', '5-hour minimum reserve (%)')}</span><input type="number" min={0} max={100} value={draft.quotaProtection.fiveHourRemainingPercent ?? ''} onChange={(event) => setDraft({ ...draft, quotaProtection: { ...draft.quotaProtection!, fiveHourRemainingPercent: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
              <label className="field"><span>{t('周额度最低保留（%）', 'Weekly minimum reserve (%)')}</span><input type="number" min={0} max={100} value={draft.quotaProtection.sevenDayRemainingPercent ?? ''} onChange={(event) => setDraft({ ...draft, quotaProtection: { ...draft.quotaProtection!, sevenDayRemainingPercent: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
              <label className="field"><span>{t('额度未知或过期', 'Unknown or stale quota')}</span><select value={draft.quotaProtection.unavailableBehavior ?? 'allow'} onChange={(event) => setDraft({ ...draft, quotaProtection: { ...draft.quotaProtection!, unavailableBehavior: event.target.value as 'allow' | 'block' } })}><option value="allow">{t('继续调度（兼容旧行为）', 'Continue scheduling (legacy behavior)')}</option><option value="block">{t('保守停用', 'Block conservatively')}</option></select></label>
              <label className="field"><span>{t('快照有效期（分钟）', 'Snapshot validity (minutes)')}</span><input type="number" min={1} max={10080} value={draft.quotaProtection.staleAfterMinutes ?? ''} onChange={(event) => setDraft({ ...draft, quotaProtection: { ...draft.quotaProtection!, staleAfterMinutes: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            </>}
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
