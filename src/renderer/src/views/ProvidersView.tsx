import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  CircleAlert,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Files,
  FolderOpen,
  KeyRound,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Tag,
  Tags,
  Trash2,
  XCircle,
} from 'lucide-react'
import type {
  AccountInput,
  AccountFitnessSnapshot,
  AccountImportProgress,
  AccountModelTestResult,
  AccountTagDefinition,
  AggregateRelayInput,
  ApiSourceInput,
  ApiSourceProbeResult,
  AppSnapshot,
  ChatGptAccountImportResult,
  ChatGptAccountImportProxyMode,
  ChatGptOAuthSessionStart,
  GatewayApi,
  ModelPolicy,
  Pool,
  Protocol,
  ProviderDefinition,
  ProviderKind,
  PublicAccount,
  PublicProxyDefinition,
} from '@shared/types'
import type { ActionRunner } from '../App'
import { normalizeAggregateRelayMembers, toggleAggregateRelayMember } from '../aggregate-relay-members'
import { providerBrandIcon } from '../brand-icons'
import {
  localizeBackendError,
  localizeBackendMessage,
  localizeBackendMessages,
  localizeProviderProbeStage,
  providerProbeStageLabel,
  providerProbeStatusLabel,
} from '../backend-message'
import { useI18n } from '../i18n'
import { setupPoolDisplayName } from '../system-generated-text'
import {
  AccountStatusBadge,
  Badge,
  ConfirmDialog,
  durationLabel,
  EmptyState,
  FieldError,
  InfoTip,
  ImportProgress,
  Modal,
  OverflowMenu,
  PageHeader,
  protocolLabels,
  relativeTime,
} from '../ui'
import { CodexQuotaCompact, CodexQuotaModal } from './CodexQuotaModal'

const HIDE_EXHAUSTED_ACCOUNTS_STORAGE_KEY = 'stone.providers.hide-exhausted-accounts'
const ACCOUNT_COLUMN_STORAGE_KEY = 'stone:account-column-widths:v1'

type AccountAddMethod = 'oauth' | 'token-json'
type OAuthUiStage = 'idle' | 'starting' | 'waiting' | 'submitting' | 'exchanging' | 'cancelling' | 'success' | 'error' | 'cancelled'

type AccountColumnId = 'select' | 'account' | 'tag' | 'status' | 'fitness' | 'credential' | 'concurrency' | 'quota' | 'latency' | 'lastUsed' | 'actions'

interface AccountColumnDefinition {
  id: AccountColumnId
  label: string
  defaultWidth: number
  minimumWidth: number
  resizable?: boolean
}

const ACCOUNT_COLUMNS: AccountColumnDefinition[] = [
  { id: 'select', label: '选择', defaultWidth: 42, minimumWidth: 38, resizable: false },
  { id: 'account', label: '账号', defaultWidth: 205, minimumWidth: 125 },
  { id: 'tag', label: 'Tag', defaultWidth: 96, minimumWidth: 76 },
  { id: 'status', label: '状态', defaultWidth: 185, minimumWidth: 105 },
  { id: 'fitness', label: '体质', defaultWidth: 190, minimumWidth: 90 },
  { id: 'credential', label: '凭据', defaultWidth: 160, minimumWidth: 105 },
  { id: 'concurrency', label: '并发', defaultWidth: 105, minimumWidth: 78 },
  { id: 'quota', label: '额度', defaultWidth: 130, minimumWidth: 82 },
  { id: 'latency', label: '延迟', defaultWidth: 90, minimumWidth: 70 },
  { id: 'lastUsed', label: '最近使用', defaultWidth: 110, minimumWidth: 82 },
  { id: 'actions', label: '操作', defaultWidth: 150, minimumWidth: 140 },
]

const ACCOUNT_COLUMN_LABELS_EN: Record<AccountColumnId, string> = {
  select: 'Select',
  account: 'Account',
  tag: 'Tag',
  status: 'Status',
  fitness: 'Fitness',
  credential: 'Credential',
  concurrency: 'Concurrency',
  quota: 'Quota',
  latency: 'Latency',
  lastUsed: 'Last used',
  actions: 'Actions',
}

type AccountColumnWidths = Record<AccountColumnId, number>

function defaultAccountColumnWidths(): AccountColumnWidths {
  return Object.fromEntries(ACCOUNT_COLUMNS.map((column) => [column.id, column.defaultWidth])) as AccountColumnWidths
}

function loadAccountColumnWidths(): AccountColumnWidths {
  const defaults = defaultAccountColumnWidths()
  try {
    const stored = JSON.parse(window.localStorage.getItem(ACCOUNT_COLUMN_STORAGE_KEY) ?? '{}') as Record<string, unknown>
    for (const column of ACCOUNT_COLUMNS) {
      const width = stored[column.id]
      if (typeof width === 'number' && Number.isFinite(width)) {
        defaults[column.id] = Math.max(column.minimumWidth, Math.min(640, Math.round(width)))
      }
    }
  } catch {
    // Invalid renderer storage falls back to the defaults.
  }
  return defaults
}

function importProxyValue(mode: ChatGptAccountImportProxyMode, proxyId: string): string {
  if (mode === 'preserve') return '__preserve__'
  if (mode === 'direct') return '__direct__'
  return proxyId
}

function proxySafeSummary(proxy: PublicProxyDefinition): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol.toUpperCase()} · ${host}:${proxy.port}`
}

function accountQuotaIsExhausted(account: PublicAccount, now = Date.now()): boolean {
  if (account.quotaRemaining !== undefined && account.quotaRemaining <= 0) return true
  if (account.codexQuota?.limitReached || account.codexQuota?.allowed === false) return true
  if ([account.codexQuota?.fiveHour, account.codexQuota?.sevenDay].some((window) =>
    window !== undefined && window.usedPercent >= 100 && (window.resetAt === undefined || window.resetAt > now)
  )) return true
  return [account.quota?.requests, account.quota?.tokens, account.quota?.inputTokens, account.quota?.outputTokens]
    .some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

function accountIsCooling(account: PublicAccount, now = Date.now()): boolean {
  return account.status === 'cooldown' || (account.cooldownUntil !== undefined && account.cooldownUntil > now)
}

function thawCountdown(until: number, now: number): string {
  const totalMinutes = Math.max(1, Math.ceil((until - now) / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor(totalMinutes % 1_440 / 60)
  if (days > 0) return `${days}d${hours}h`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours > 0) return `${totalHours}h${minutes}m`
  return `${totalMinutes}m`
}

function accountRecoveryAt(account: PublicAccount, now: number): number | undefined {
  const candidates: number[] = []
  if (account.cooldownUntil !== undefined && account.cooldownUntil > now) candidates.push(account.cooldownUntil)

  const quotaResets = [account.quota?.requests, account.quota?.tokens, account.quota?.inputTokens, account.quota?.outputTokens]
    .filter((window) => window?.remaining === 0 && window.resetAt !== undefined && window.resetAt > now)
    .map((window) => window!.resetAt!)
  if (quotaResets.length) candidates.push(Math.max(...quotaResets))

  if (accountQuotaIsExhausted(account, now) && account.codexQuota) {
    const windows = [account.codexQuota.fiveHour, account.codexQuota.sevenDay].filter(Boolean)
    const exhaustedResets = windows
      .filter((window) => window!.usedPercent >= 100 && window!.resetAt !== undefined && window!.resetAt! > now)
      .map((window) => window!.resetAt!)
    if (exhaustedResets.length) candidates.push(Math.max(...exhaustedResets))
    else {
      const futureResets = windows
        .filter((window) => window!.resetAt !== undefined && window!.resetAt! > now)
        .map((window) => window!.resetAt!)
      if (futureResets.length) candidates.push(Math.min(...futureResets))
    }
  }
  return candidates.length ? Math.max(...candidates) : undefined
}

function accountDisplayNames(accounts: readonly PublicAccount[]): Map<string, string> {
  const bases = accounts.map((account) => ({
    account,
    base: Array.from(account.name).slice(0, 8).join('')
  }))
  const counts = new Map<string, number>()
  for (const { base } of bases) counts.set(base, (counts.get(base) ?? 0) + 1)
  const occurrences = new Map<string, number>()
  return new Map(bases.map(({ account, base }) => {
    if ((counts.get(base) ?? 0) <= 1) return [account.id, base]
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)
    return [account.id, `${base}(${occurrence})`]
  }))
}

function AccountFitness({ fitness }: { fitness?: AccountFitnessSnapshot }) {
  const { t, locale } = useI18n()
  if (!fitness) return <span className="muted">{t('未启用', 'Disabled')}</span>
  if (fitness.score === undefined) {
    return <div className="fitness-cell"><span className="fitness-score fitness-score--pending">{t('待采样', 'Pending')}</span><small>{t('智能均衡尚无数据', 'No smart-balance data yet')}</small></div>
  }
  const number = (value: number, maximumFractionDigits: number) => new Intl.NumberFormat(locale, { maximumFractionDigits, minimumFractionDigits: maximumFractionDigits }).format(value)
  const tone = fitness.score >= 85 ? 'strong' : fitness.score >= 60 ? 'medium' : 'weak'
  const summary = [
    fitness.successRate === undefined ? undefined : t(`长期 ${number(fitness.successRate, 1)}%`, `Long-term ${number(fitness.successRate, 1)}%`),
    fitness.recentSuccessRate === undefined ? undefined : t(`近期 ${number(fitness.recentSuccessRate, 1)}%`, `Recent ${number(fitness.recentSuccessRate, 1)}%`),
    fitness.confidence === undefined ? undefined : t(`可信度 ${number(fitness.confidence, 0)}%`, `Confidence ${number(fitness.confidence, 0)}%`),
    t(`${fitness.sampleCount} 个样本`, `${fitness.sampleCount} ${fitness.sampleCount === 1 ? 'sample' : 'samples'}`)
  ].filter(Boolean).join(' · ')
  const performance = [
    fitness.firstTokenMs === undefined ? undefined : t(`首字 ${durationLabel(fitness.firstTokenMs)}`, `First token ${durationLabel(fitness.firstTokenMs)}`),
    fitness.outputTokensPerSecond === undefined ? undefined : `${number(fitness.outputTokensPerSecond, 1)} tok/s`,
  ].filter(Boolean).join(' · ')
  const components = fitness.components
    ? t(`可靠性 ${fitness.components.reliability}、响应 ${fitness.components.responsiveness}、吞吐 ${fitness.components.throughput}、稳定性 ${fitness.components.stability}`, `Reliability ${fitness.components.reliability}, responsiveness ${fitness.components.responsiveness}, throughput ${fitness.components.throughput}, stability ${fitness.components.stability}`)
    : undefined
  const explanation = [
    t('移动体质分采用绝对评价，不按当前账号排名强制设为 100；结合近 30 天历史、近期 EWMA、长期成功率、响应、吞吐、失败与熔断。', 'The moving fitness score is absolute rather than normalized to the current account ranking. It combines 30-day history, recent EWMA, long-term success rate, responsiveness, throughput, failures, and circuit breaks.'),
    summary,
    performance,
    components
  ].filter(Boolean).join(' ')
  return <div className="fitness-cell" title={explanation}>
    <span className={`fitness-score fitness-score--${tone}`}>SP{fitness.score}</span>
    <small>{fitness.stale ? t('历史样本 · ', 'Historical samples · ') : ''}{summary}</small>
  </div>
}

function CooldownCountdown({ account }: { account: PublicAccount }) {
  const { t, locale } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const until = accountRecoveryAt(account, now)
  useEffect(() => {
    if (until === undefined || until <= Date.now()) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [until])
  if (until === undefined || until <= now) return null
  return <span className="row-note row-note--warning" title={t(`预计解冻：${new Date(until).toLocaleString(locale)}`, `Expected recovery: ${new Date(until).toLocaleString(locale)}`)}>
    {account.cooldownReason === 'quota' || accountQuotaIsExhausted(account, now) ? t('额度恢复', 'Quota recovery') : t('冷却恢复', 'Cooldown recovery')} {thawCountdown(until, now)}
  </span>
}
import { ModelPolicyEditor } from './ModelPolicyEditor'
import { accountModelCatalog, effectiveAccountModels, isAccountModelWildcard } from '../model-policy'

const providerKindLabels: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'openai-compatible': 'OpenAI 兼容',
  'anthropic-compatible': 'Anthropic 兼容',
  custom: '自定义',
}

const providerKindLabelsEn: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'openai-compatible': 'OpenAI compatible',
  'anthropic-compatible': 'Anthropic compatible',
  custom: 'Custom',
}

const protocols: Protocol[] = ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini']
const protocolsByKind: Record<ProviderKind, Protocol[]> = {
  anthropic: ['anthropic-messages'],
  openai: ['openai-responses', 'openai-chat'],
  google: ['gemini'],
  'openai-compatible': ['openai-responses', 'openai-chat'],
  'anthropic-compatible': ['anthropic-messages'],
  custom: protocols,
}
type ApiSourceDraft = Omit<ApiSourceInput, 'models' | 'defaultModel'> & { modelsText: string; defaultModel: string }
type AccountDraft = Omit<AccountInput, 'modelPolicy'> & { modelPolicy: ModelPolicy }
type AggregateRelayDraft = AggregateRelayInput

const officialSourceDefaults: Record<'openai' | 'anthropic' | 'google', Pick<ApiSourceDraft, 'baseUrl' | 'protocol'>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  anthropic: { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini' },
}

function emptyApiSource(sourceType: 'official-api' | 'relay'): ApiSourceDraft {
  const official = officialSourceDefaults.openai
  return {
    name: '',
    sourceType,
    kind: sourceType === 'official-api' ? 'openai' : 'openai-compatible',
    baseUrl: sourceType === 'official-api' ? official.baseUrl : 'https://',
    protocol: sourceType === 'official-api' ? official.protocol : 'openai-chat',
    credential: '',
    modelsText: '',
    defaultModel: '',
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    proxyId: '',
  }
}

function emptyAggregateRelay(): AggregateRelayDraft {
  return {
    name: '',
    protocol: 'openai-responses',
    strategy: 'priority',
    members: [],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2,
    proxyId: '',
  }
}

function makeAccountDraft(providerId = ''): AccountDraft {
  return {
    providerId,
    name: '',
    credential: '',
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    modelPolicy: 'all',
    modelAllowlist: [],
    proxyId: '',
  }
}

function ApiSourceForm({
  draft,
  setDraft,
  proxies,
  errors,
}: {
  draft: ApiSourceDraft
  setDraft: (value: ApiSourceDraft) => void
  proxies: PublicProxyDefinition[]
  errors: Record<string, string>
}) {
  const { t } = useI18n()
  const availableProtocols = protocolsByKind[draft.kind]
  const availableKinds: ProviderKind[] = draft.sourceType === 'official-api'
    ? ['openai', 'anthropic', 'google']
    : ['openai-compatible', 'anthropic-compatible', 'custom']
  return (
    <div className="form-grid">
      <label className="field field--full">
        <span>{t('显示名称', 'Display name')}</span>
        <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例如：OpenAI 主线路', 'e.g. Primary OpenAI route')} />
        <FieldError>{errors.name}</FieldError>
      </label>
      <label className="field">
        <span>{draft.sourceType === 'official-api' ? t('官方服务', 'Official service') : t('兼容类型', 'Compatibility type')}</span>
        <select value={draft.kind} onChange={(event) => {
          const kind = event.target.value as ProviderKind
          const supported = protocolsByKind[kind]
          const official = kind === 'openai' || kind === 'anthropic' || kind === 'google' ? officialSourceDefaults[kind] : undefined
          setDraft({
            ...draft,
            kind,
            protocol: official?.protocol ?? (supported.includes(draft.protocol) ? draft.protocol : supported[0]),
            baseUrl: official?.baseUrl ?? draft.baseUrl,
          })
        }}>
          {availableKinds.map((kind) => <option value={kind} key={kind}>{t(providerKindLabels[kind], providerKindLabelsEn[kind])}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t('上游协议', 'Upstream protocol')}</span>
        <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as Protocol })}>
          {availableProtocols.map((protocol) => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}
        </select>
      </label>
      <label className="field field--full">
        <span className="field-label-with-help">{t('基础地址', 'Base URL')}{draft.sourceType === 'official-api' && <InfoTip text={t('官方 API 地址由 StonePlus 锁定，避免误接到第三方中转端点。', 'StonePlus locks official API URLs to prevent accidental routing through a third-party relay.')} />}</span>
        <input className="mono" disabled={draft.sourceType === 'official-api'} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
        <FieldError>{errors.baseUrl}</FieldError>
      </label>
      <label className="field field--full">
        <span>API Key / Access Token</span>
        <div className="input-with-icon"><KeyRound size={16} /><input type="password" className="mono" value={draft.credential ?? ''} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} placeholder={draft.id ? t('留空表示保留原凭据', 'Leave blank to keep the current credential') : t('输入上游凭据', 'Enter the upstream credential')} /></div>
        <FieldError>{errors.credential}</FieldError>
      </label>
      <label className="field field--full">
        <span className="field-label-with-help">{t('目录模型（兼容）', 'Catalog models (fallback)')}<InfoTip text={t('每行一个模型标识，仅在账号尚未单独刷新时作为兼容候选。', 'Enter one model identifier per line. These are fallback candidates until the account refreshes its own models.')} /></span>
        <textarea value={draft.modelsText} onChange={(event) => setDraft({ ...draft, modelsText: event.target.value })} rows={4} placeholder={'gpt-5\ngpt-5-mini'} />
      </label>
      <label className="field field--full">
        <span>{t('默认 / 测试模型', 'Default / test model')}</span>
        <input className="mono" value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })} placeholder={t('例如：gpt-5-mini', 'e.g. gpt-5-mini')} />
      </label>
      <label className="field"><span className="field-label-with-help">{t('优先级', 'Priority')}<InfoTip text={t('数值越小越优先，仅在优先级调度或故障转移时决定先后顺序。', 'Lower values have higher priority and determine order only for priority scheduling or failover.')} /></span><input type="number" min={1} max={999} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} /></label>
      <label className="field"><span className="field-label-with-help">{t('调度权重', 'Scheduling weight')}<InfoTip text={t('数值越大，被加权策略分配到请求的比例越高。', 'Higher values receive a larger share of requests under weighted strategies.')} /></span><input type="number" min={1} max={100} value={draft.weight} onChange={(event) => setDraft({ ...draft, weight: Number(event.target.value) })} /></label>
      <label className="field"><span className="field-label-with-help">{t('最大并发', 'Maximum concurrency')}<InfoTip text={t('限制该来源同时处理的请求数，达到上限后会等待或选择其他来源。', 'Limits simultaneous requests for this source. At the limit, requests wait or use another source.')} /></span><input type="number" min={1} max={100} value={draft.maxConcurrency} onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })} /></label>
      <label className="field"><span>{t('出口代理', 'Exit proxy')}</span><select value={draft.proxyId ?? ''} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}><option value="">{t('直连', 'Direct')}</option>{proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}</select></label>
    </div>
  )
}

function AccountForm({
  draft,
  setDraft,
  providers,
  proxies,
  account,
  editing,
  oauthAccount,
  refreshingModels,
  refreshDisabledReason,
  onRefreshModels,
  onTestModel,
  errors,
}: {
  draft: AccountDraft
  setDraft: (value: AccountDraft) => void
  providers: ProviderDefinition[]
  proxies: PublicProxyDefinition[]
  account?: PublicAccount
  editing: boolean
  oauthAccount: boolean
  refreshingModels: boolean
  refreshDisabledReason?: string
  onRefreshModels: () => void
  onTestModel?: (model: string) => Promise<AccountModelTestResult>
  errors: Record<string, string>
}) {
  const { t } = useI18n()
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId)
  const catalogAccount = account?.providerId === draft.providerId ? account : undefined
  const catalog = catalogAccount
    ? accountModelCatalog(catalogAccount, selectedProvider?.models)
    : { models: selectedProvider?.models ?? [], source: 'provider-fallback' as const }
  const catalogNotice = catalog.source === 'provider-fallback'
    ? t('当前显示供应商目录的兼容候选，尚未验证此账号。保存账号后请刷新可用模型。', 'Showing compatible candidates from the provider catalog; this account has not been verified. Save the account, then refresh its available models.')
    : undefined
  return (
    <div className="form-grid">
      {!oauthAccount && <label className="field">
        <span>{t('所属供应商', 'Provider')}</span>
        <select autoFocus value={draft.providerId} onChange={(event) => setDraft({ ...draft, providerId: event.target.value, modelPolicy: 'all', modelAllowlist: [] })}>
          <option value="">{t('选择供应商', 'Select a provider')}</option>
          {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>
        <FieldError>{errors.providerId}</FieldError>
      </label>}
      {oauthAccount && <div className="form-context"><Server size={16} /><span>{t('系统 ChatGPT OAuth 来源', 'System ChatGPT OAuth source')}</span></div>}
      <label className="field">
        <span>{t('账号名称', 'Account name')}</span>
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例如：日常开发', 'e.g. Daily development')} />
        <FieldError>{errors.name}</FieldError>
      </label>
      {!oauthAccount && <label className="field field--full">
        <span>API Key / Access Token</span>
        <div className="input-with-icon"><KeyRound size={16} /><input type="password" className="mono" value={draft.credential ?? ''} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} placeholder={editing ? t('留空表示不更换凭据', 'Leave blank to keep the current credential') : t('输入上游凭据', 'Enter the upstream credential')} /></div>
        <FieldError>{errors.credential}</FieldError>
      </label>}
      {oauthAccount && <div className="form-context field--full"><KeyRound size={16} /><span>{t('ChatGPT OAuth 凭据只能通过重新导入更新', 'ChatGPT OAuth credentials can be updated only by importing them again.')}</span></div>}
      <label className="field">
        <span className="field-label-with-help">{t('优先级', 'Priority')}<InfoTip text={t('数值越小越优先，仅在优先级调度或故障转移时决定先后顺序。', 'Lower values have higher priority and determine order only for priority scheduling or failover.')} /></span>
        <input type="number" min={1} max={999} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} />
      </label>
      <label className="field field--full">
        <span className="field-label-with-help">{t('账号出口代理', 'Account exit proxy')}<InfoTip text={t('账号专属代理优先于号池默认代理，独立检测未设置时使用直连。', 'An account-specific proxy takes precedence over the pool default. Standalone checks use a direct connection when none is set.')} /></span>
        <select value={draft.proxyId ?? ''} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}>
          <option value="">{t('使用号池默认（独立检测时直连）', 'Use pool default (direct for standalone checks)')}</option>
          {proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label-with-help">{t('调度权重', 'Scheduling weight')}<InfoTip text={t('数值越大，被加权策略分配到请求的比例越高。', 'Higher values receive a larger share of requests under weighted strategies.')} /></span>
        <input type="number" min={1} max={100} value={draft.weight} onChange={(event) => setDraft({ ...draft, weight: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span className="field-label-with-help">{t('最大并发', 'Maximum concurrency')}<InfoTip text={t('限制该账号同时处理的请求数，达到上限后会等待或切换账号。', 'Limits simultaneous requests for this account. At the limit, requests wait or switch accounts.')} /></span>
        <input type="number" min={1} max={100} value={draft.maxConcurrency} onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })} />
      </label>
      {selectedProvider && <div className="form-context field--full"><Server size={16} /><span>{protocolLabels[selectedProvider.protocol]}</span><code>{selectedProvider.baseUrl}</code></div>}
      <div className="field field--full">
        <ModelPolicyEditor
          title={t('开放模型', 'Allowed models')}
          description={t('先拉取此账号实际可用的模型，再决定对号池开放哪些模型。', 'Fetch the models actually available to this account, then choose which models to expose to pools.')}
          policy={draft.modelPolicy}
          selectedModels={draft.modelAllowlist}
          options={catalog.models.map((model) => ({ model }))}
          onPolicyChange={(modelPolicy) => setDraft({ ...draft, modelPolicy })}
          onSelectedModelsChange={(modelAllowlist) => setDraft({ ...draft, modelAllowlist })}
          onRefresh={onRefreshModels}
          onTestModel={onTestModel}
          testDisabledReason={refreshDisabledReason}
          refreshing={refreshingModels}
          refreshDisabledReason={refreshDisabledReason}
          refreshedAt={catalogAccount?.modelsRefreshedAt}
          catalogNotice={catalogNotice}
          emptyMessage={catalog.source === 'account' ? t('此账号没有返回可用模型。', 'This account returned no available models.') : t('供应商目录尚无兼容候选；保存账号后可直接刷新。', 'The provider catalog has no compatible candidates yet. Save the account, then refresh directly.')}
          emptySelectionMessage={t('已明确不开放任何模型；该账号不会承接号池模型请求。', 'No models are explicitly allowed, so this account will not handle pool model requests.')}
        />
      </div>
    </div>
  )
}

export function ProvidersView({
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
  const { t, language, locale } = useI18n()
  const [tab, setTab] = useState<'accounts' | 'official' | 'relays'>('accounts')
  const [providerModal, setProviderModal] = useState(false)
  const [accountModal, setAccountModal] = useState(false)
  const [providerDraft, setProviderDraft] = useState<ApiSourceDraft>(() => emptyApiSource('official-api'))
  const [providerProbe, setProviderProbe] = useState<ApiSourceProbeResult | null>(null)
  const [providerProbeBusy, setProviderProbeBusy] = useState(false)
  const [testingSourceId, setTestingSourceId] = useState('')
  const [aggregateModalOpen, setAggregateModalOpen] = useState(false)
  const [aggregateDraft, setAggregateDraft] = useState<AggregateRelayDraft>(emptyAggregateRelay)
  const [aggregateDeleteTarget, setAggregateDeleteTarget] = useState<Pool | null>(null)
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(makeAccountDraft(snapshot.providers[0]?.id))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'provider' | 'account'; id: string; name: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [chatGptImportOpen, setChatGptImportOpen] = useState(false)
  const [accountAddMethod, setAccountAddMethod] = useState<AccountAddMethod>('oauth')
  const [chatGptImport, setChatGptImport] = useState({
    name: '',
    content: '',
    tagId: null as string | null,
    poolId: null as string | null,
    proxyMode: 'preserve' as ChatGptAccountImportProxyMode,
    proxyId: ''
  })
  const [importNotice, setImportNotice] = useState('')
  const [fileImportBusy, setFileImportBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<AccountImportProgress | null>(null)
  const importProgressId = useRef<string | null>(null)
  const [oauthStage, setOauthStage] = useState<OAuthUiStage>('idle')
  const [oauthSession, setOauthSession] = useState<ChatGptOAuthSessionStart | null>(null)
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('')
  const [oauthError, setOauthError] = useState('')
  const [oauthCallbackError, setOauthCallbackError] = useState('')
  const [oauthOpenHint, setOauthOpenHint] = useState('')
  const [oauthOpenBusy, setOauthOpenBusy] = useState(false)
  const [oauthCopied, setOauthCopied] = useState(false)
  const [oauthCommitLocked, setOauthCommitLocked] = useState(false)
  const [oauthResult, setOauthResult] = useState<ChatGptAccountImportResult | null>(null)
  const [oauthNow, setOauthNow] = useState(Date.now())
  const oauthSessionIdRef = useRef<string | null>(null)
  const oauthAttemptRef = useRef(0)
  const [quotaAccountId, setQuotaAccountId] = useState<string | null>(null)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<'sub2api' | 'cpa'>('sub2api')
  const [exportMode, setExportMode] = useState<'merged' | 'separate'>('merged')
  const [exportAccountIds, setExportAccountIds] = useState<string[]>([])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  const [accountColumnWidths, setAccountColumnWidths] = useState<AccountColumnWidths>(loadAccountColumnWidths)
  const resizingAccountColumn = useRef<{ id: AccountColumnId; startX: number; startWidth: number } | null>(null)
  const [hideExhaustedAccounts, setHideExhaustedAccounts] = useState(() =>
    window.localStorage.getItem(HIDE_EXHAUSTED_ACCOUNTS_STORAGE_KEY) === 'true'
  )
  const [tagFilter, setTagFilter] = useState<'all' | 'untagged' | string>('all')
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [tagAssignmentOpen, setTagAssignmentOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState<{ id?: string; name: string }>({ name: '' })
  const [tagDeleteTarget, setTagDeleteTarget] = useState<AccountTagDefinition | null>(null)
  const [importTagName, setImportTagName] = useState('')

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const proxyById = useMemo(() => new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy])), [snapshot.proxies])
  const accountNameById = useMemo(() => accountDisplayNames(snapshot.accounts), [snapshot.accounts])
  const quotaAccount = quotaAccountId ? snapshot.accounts.find((account) => account.id === quotaAccountId) ?? null : null
  const editingAccount = accountDraft.id ? snapshot.accounts.find((account) => account.id === accountDraft.id) : undefined
  const accountModelsBusy = Boolean(accountDraft.id && busyKeys.has(`refresh-account-models-${accountDraft.id}`))
  const oauthAccounts = useMemo(
    () => snapshot.accounts.filter((account) => account.credentialType === 'chatgpt-oauth'),
    [snapshot.accounts]
  )
  const tagById = useMemo(() => new Map(snapshot.accountTags.map((tag) => [tag.id, tag])), [snapshot.accountTags])
  const exhaustedAccountCount = useMemo(
    () => oauthAccounts.filter((account) => accountQuotaIsExhausted(account)).length,
    [oauthAccounts]
  )
  const visibleAccounts = useMemo(() => oauthAccounts.filter((account) => {
    if (hideExhaustedAccounts && accountQuotaIsExhausted(account)) return false
    if (tagFilter === 'untagged') return !account.tagId
    if (tagFilter !== 'all') return account.tagId === tagFilter
    return true
  }), [hideExhaustedAccounts, oauthAccounts, tagFilter])
  const checkingAllAccounts = busyKeys.has('check-all-accounts')
  const officialProviders = useMemo(() => snapshot.providers.filter((provider) => provider.sourceType === 'official-api'), [snapshot.providers])
  const relayProviders = useMemo(() => snapshot.providers.filter((provider) => provider.sourceType === 'relay'), [snapshot.providers])
  const aggregateRelays = useMemo(() => snapshot.pools.filter((pool) => pool.kind === 'relay-aggregate'), [snapshot.pools])
  const compatibleImportPools = useMemo(() => snapshot.pools.filter((pool) => pool.kind === 'standard' && pool.protocol === 'openai-responses'), [snapshot.pools])
  const oauthActive = oauthStage === 'starting' || oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging' || oauthStage === 'cancelling'
  const importConfigurationLocked = fileImportBusy || oauthActive
  const oauthExpiresInSeconds = oauthSession ? Math.max(0, Math.ceil((oauthSession.expiresAt - oauthNow) / 1000)) : 0
  const refreshModelsDisabledReason = !accountDraft.id
    ? t('请先保存账号，再拉取此账号的可用模型。', 'Save the account before fetching its available models.')
    : accountDraft.credential?.trim()
      ? t('凭据有未保存的更改，请先保存账号。', 'The credential has unsaved changes. Save the account first.')
      : undefined

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCOUNT_COLUMN_STORAGE_KEY, JSON.stringify(accountColumnWidths))
    } catch {
      // The table remains resizable if renderer storage is unavailable.
    }
  }, [accountColumnWidths])

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const resize = resizingAccountColumn.current
      if (!resize) return
      const definition = ACCOUNT_COLUMNS.find((column) => column.id === resize.id)
      if (!definition) return
      const width = Math.max(definition.minimumWidth, Math.min(640, Math.round(resize.startWidth + event.clientX - resize.startX)))
      setAccountColumnWidths((current) => current[resize.id] === width ? current : { ...current, [resize.id]: width })
    }
    const stop = () => {
      resizingAccountColumn.current = null
      document.body.classList.remove('account-column-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('account-column-resizing')
    }
  }, [])

  const accountTableWidth = ACCOUNT_COLUMNS.reduce((total, column) => total + accountColumnWidths[column.id], 0)

  const beginAccountColumnResize = (event: React.MouseEvent, column: AccountColumnDefinition) => {
    event.preventDefault()
    event.stopPropagation()
    resizingAccountColumn.current = { id: column.id, startX: event.clientX, startWidth: accountColumnWidths[column.id] }
    document.body.classList.add('account-column-resizing')
  }

  const resizeAccountColumnByKeyboard = (event: React.KeyboardEvent, column: AccountColumnDefinition) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    setAccountColumnWidths((current) => ({
      ...current,
      [column.id]: event.key === 'Home'
        ? column.defaultWidth
        : Math.max(column.minimumWidth, Math.min(640, current[column.id] + (event.key === 'ArrowLeft' ? -8 : 8)))
    }))
  }

  const accountColumnResizer = (column: AccountColumnDefinition) => column.resizable === false ? null : <span
    aria-label={t(`调整${column.label}列宽`, `Resize ${ACCOUNT_COLUMN_LABELS_EN[column.id]} column`)}
    aria-orientation="vertical"
    aria-valuemax={640}
    aria-valuemin={column.minimumWidth}
    aria-valuenow={accountColumnWidths[column.id]}
    className="account-column-resizer"
    data-account-column-resizer={column.id}
    role="separator"
    tabIndex={0}
    title={t('拖动调整列宽；双击或按 Home 恢复默认', 'Drag to resize; double-click or press Home to restore the default width')}
    onDoubleClick={(event) => { event.stopPropagation(); setAccountColumnWidths((current) => ({ ...current, [column.id]: column.defaultWidth })) }}
    onKeyDown={(event) => resizeAccountColumnByKeyboard(event, column)}
    onMouseDown={(event) => beginAccountColumnResize(event, column)}
  />
  const persistedAccountModelState = editingAccount ? JSON.stringify({
    id: editingAccount.id,
    revision: editingAccount.modelsRefreshedAt,
    modelPolicy: editingAccount.modelPolicy,
    modelAllowlist: editingAccount.modelAllowlist,
  }) : ''

  useEffect(() => {
    if (!accountModal || !persistedAccountModelState) return
    const persisted = JSON.parse(persistedAccountModelState) as {
      id: string
      modelPolicy: ModelPolicy
      modelAllowlist: string[]
    }
    setAccountDraft((current) => current.id === persisted.id ? {
      ...current,
      modelPolicy: persisted.modelPolicy,
      modelAllowlist: [...persisted.modelAllowlist],
    } : current)
  }, [accountModal, persistedAccountModelState])

  useEffect(() => {
    window.localStorage.setItem(HIDE_EXHAUSTED_ACCOUNTS_STORAGE_KEY, String(hideExhaustedAccounts))
  }, [hideExhaustedAccounts])

  useEffect(() => api.onAccountImportProgress((progress) => {
    if (progress.progressId === importProgressId.current) setImportProgress(progress)
  }), [api])

  useEffect(() => {
    if (!oauthSession || !oauthActive) return
    setOauthNow(Date.now())
    const timer = window.setInterval(() => setOauthNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [oauthActive, oauthSession])

  useEffect(() => () => {
    oauthAttemptRef.current += 1
    const sessionId = oauthSessionIdRef.current
    oauthSessionIdRef.current = null
    if (sessionId) void api.cancelChatGptOAuth(sessionId).catch(() => undefined)
  }, [api])

  useEffect(() => {
    const existingIds = new Set(snapshot.accounts.map((account) => account.id))
    setSelectedAccountIds((current) => current.filter((id) => existingIds.has(id)))
    setExportAccountIds((current) => current.filter((id) => existingIds.has(id)))
  }, [snapshot.accounts])

  useEffect(() => {
    if (tagFilter !== 'all' && tagFilter !== 'untagged' && !tagById.has(tagFilter)) setTagFilter('all')
  }, [tagById, tagFilter])

  const openProvider = (sourceType: 'official-api' | 'relay', provider?: ProviderDefinition) => {
    const account = provider ? snapshot.accounts.find((candidate) => candidate.providerId === provider.id && candidate.credentialType !== 'chatgpt-oauth') : undefined
    setProviderDraft(provider ? {
      id: provider.id,
      name: provider.name,
      sourceType,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      credential: '',
      modelsText: provider.models.join('\n'),
      defaultModel: account?.modelAllowlist[0] ?? provider.models[0] ?? '',
      priority: account?.priority ?? 10,
      weight: account?.weight ?? 10,
      maxConcurrency: account?.maxConcurrency ?? 4,
      proxyId: account?.proxyId ?? '',
    } : emptyApiSource(sourceType))
    setProviderProbe(null)
    setErrors({})
    setProviderModal(true)
    setMenuOpen(null)
  }

  const openAggregateRelay = (pool?: Pool) => {
    setAggregateDraft(pool ? {
      id: pool.id,
      name: pool.name,
      protocol: pool.protocol,
      strategy: pool.strategy === 'round-robin' || pool.strategy === 'weighted-round-robin' ? pool.strategy : 'priority',
      members: pool.members
        .filter((member) => member.enabled)
        .map((member, index) => ({
          accountId: member.accountId,
          order: member.order ?? index,
          weight: member.weight ?? snapshot.accounts.find((account) => account.id === member.accountId)?.weight ?? 10,
        }))
        .sort((a, b) => a.order - b.order),
      stickySessions: pool.stickySessions,
      stickyTtlMinutes: pool.stickyTtlMinutes,
      maxRetries: pool.maxRetries,
      proxyId: pool.proxyId ?? '',
    } : emptyAggregateRelay())
    setErrors({})
    setAggregateModalOpen(true)
    setMenuOpen(null)
  }

  const updateAggregateMembers = (members: AggregateRelayDraft['members']) => {
    setAggregateDraft((current) => ({ ...current, members: normalizeAggregateRelayMembers(members) }))
  }

  const toggleAggregateMember = (account: PublicAccount) => {
    setAggregateDraft((current) => ({
      ...current,
      members: toggleAggregateRelayMember(current.members, account),
    }))
    setErrors((current) => current.aggregateMembers ? { ...current, aggregateMembers: '' } : current)
  }

  const submitAggregateRelay = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!aggregateDraft.name.trim()) nextErrors.aggregateName = t('请输入聚合中转名称', 'Enter an aggregate relay name.')
    if (aggregateDraft.members.length < 2) nextErrors.aggregateMembers = t('至少选择两个同协议 API 来源', 'Select at least two API sources with the same protocol.')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-aggregate-relay', () => api.saveAggregateRelay({
      ...aggregateDraft,
      name: aggregateDraft.name.trim(),
      proxyId: aggregateDraft.proxyId || undefined,
    }))
    if (success) setAggregateModalOpen(false)
  }

  const deleteAggregateRelay = async () => {
    if (!aggregateDeleteTarget) return
    const success = await runAction('delete-aggregate-relay', () => api.deletePool(aggregateDeleteTarget.id))
    if (success) setAggregateDeleteTarget(null)
  }

  const openAccount = (account?: PublicAccount) => {
    setAccountDraft(account ? {
      id: account.id,
      providerId: account.providerId,
      name: account.name,
      credential: '',
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelPolicy: account.modelPolicy,
      modelAllowlist: [...account.modelAllowlist],
      proxyId: account.proxyId ?? '',
    } : makeAccountDraft(snapshot.providers[0]?.id))
    setErrors({})
    setAccountModal(true)
    setMenuOpen(null)
  }

  const refreshEditingAccountModels = async () => {
    const accountId = accountDraft.id
    if (!accountId || refreshModelsDisabledReason) return
    let refreshedSnapshot: AppSnapshot | undefined
    const success = await runAction(`refresh-account-models-${accountId}`, async () => {
      refreshedSnapshot = await api.refreshAccountModels(accountId)
      return refreshedSnapshot
    })
    const refreshedAccount = refreshedSnapshot?.accounts.find((account) => account.id === accountId)
    if (success && refreshedAccount) {
      setAccountDraft((current) => current.id === accountId ? {
        ...current,
        modelPolicy: refreshedAccount.modelPolicy,
        modelAllowlist: [...refreshedAccount.modelAllowlist],
      } : current)
    }
  }

  const submitProvider = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!providerDraft.name.trim()) nextErrors.name = t('请输入来源名称', 'Enter a source name.')
    try { new URL(providerDraft.baseUrl) } catch { nextErrors.baseUrl = t('请输入有效的 HTTP(S) 地址', 'Enter a valid HTTP(S) URL.') }
    if (!/^https?:\/\//.test(providerDraft.baseUrl)) nextErrors.baseUrl = t('地址必须以 http:// 或 https:// 开头', 'The URL must start with http:// or https://.')
    if (!providerDraft.id && !providerDraft.credential?.trim()) nextErrors.credential = t('首次添加需要填写 API Key', 'An API key is required when adding a source.')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const sourceAccount = providerDraft.id
      ? snapshot.accounts.find((account) => account.providerId === providerDraft.id && account.credentialType !== 'chatgpt-oauth')
      : undefined
    const incompatiblePools = sourceAccount
      ? snapshot.pools.filter((pool) => pool.protocol !== providerDraft.protocol && pool.members.some((member) => member.accountId === sourceAccount.id))
      : []
    const unlinkIncompatiblePools = incompatiblePools.length > 0
      ? window.confirm(t(`修改协议将从 ${incompatiblePools.map((pool) => `“${pool.name}”`).join('、')} 解除此来源。聚合成员不足时相关聚合中转也会被删除，是否继续？`, `Changing the protocol will unlink this source from ${incompatiblePools.map((pool) => `“${setupPoolDisplayName(pool.name, t)}”`).join(', ')}. Aggregate relays with too few members will also be deleted. Continue?`))
      : false
    if (incompatiblePools.length > 0 && !unlinkIncompatiblePools) return
    const success = await runAction('save-api-source', () => api.saveApiSource({
      id: providerDraft.id,
      name: providerDraft.name.trim(),
      sourceType: providerDraft.sourceType,
      kind: providerDraft.kind,
      baseUrl: providerDraft.baseUrl.replace(/\/$/, ''),
      protocol: providerDraft.protocol,
      credential: providerDraft.credential?.trim() || undefined,
      models: providerDraft.modelsText.split(/[\n,]/).map((model) => model.trim()).filter(Boolean),
      defaultModel: providerDraft.defaultModel.trim() || undefined,
      priority: providerDraft.priority,
      weight: providerDraft.weight,
      maxConcurrency: providerDraft.maxConcurrency,
      proxyId: providerDraft.proxyId || undefined,
      unlinkIncompatiblePools,
    }))
    if (success) setProviderModal(false)
  }

  const probeProvider = async () => {
    setProviderProbe(null)
    setErrors({})
    setProviderProbeBusy(true)
    try {
      const result = await api.probeApiSource({
        id: providerDraft.id,
        name: providerDraft.name.trim() || t('未命名来源', 'Unnamed source'),
        sourceType: providerDraft.sourceType,
        kind: providerDraft.kind,
        baseUrl: providerDraft.baseUrl.replace(/\/$/, ''),
        protocol: providerDraft.protocol,
        credential: providerDraft.credential?.trim() || undefined,
        model: providerDraft.defaultModel.trim() || undefined,
        proxyId: providerDraft.proxyId || undefined,
      })
      setProviderProbe(result)
      if (result.models.length) {
        setProviderDraft((current) => ({
          ...current,
          modelsText: result.models.join('\n'),
          defaultModel: current.defaultModel || result.models[0],
        }))
      }
    } catch (cause) {
      setErrors({ sourceProbe: localizeBackendError(cause, language, t('连接测试失败', 'Connection test failed.')) })
    } finally {
      setProviderProbeBusy(false)
    }
  }

  const testSavedSource = async (provider: ProviderDefinition, account: PublicAccount | undefined) => {
    setTestingSourceId(provider.id)
    setImportNotice('')
    try {
      const result = await api.probeApiSource({
        id: provider.id,
        name: provider.name,
        sourceType: provider.sourceType === 'relay' ? 'relay' : 'official-api',
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        model: account?.modelAllowlist[0] ?? account?.availableModels[0] ?? provider.models[0],
        proxyId: account?.proxyId,
      })
      const resultError = localizeBackendMessage(
        result.error ?? result.stages.find((stage) => stage.status === 'error')?.message,
        language,
        t('未知错误', 'Unknown error'),
      )
      setImportNotice(result.ok
        ? t(`“${provider.name}”真实生成测试通过，耗时 ${result.latencyMs ?? 0} ms。`, `“${provider.name}” passed the real generation test in ${result.latencyMs ?? 0} ms.`)
        : t(`“${provider.name}”测试未通过：${resultError}`, `“${provider.name}” failed the test: ${resultError}`))
    } catch (cause) {
      const detail = localizeBackendError(cause, language, t('未知错误', 'Unknown error'))
      setImportNotice(t(`“${provider.name}”测试失败：${detail}`, `“${provider.name}” test failed: ${detail}`))
    } finally {
      setTestingSourceId('')
      setMenuOpen(null)
    }
  }

  const copySourceConfiguration = (provider: ProviderDefinition, account: PublicAccount | undefined) => {
    setProviderDraft({
      ...emptyApiSource(provider.sourceType === 'relay' ? 'relay' : 'official-api'),
      name: t(`${provider.name} 副本`, `${provider.name} copy`),
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      modelsText: provider.models.join('\n'),
      defaultModel: account?.modelAllowlist[0] ?? account?.availableModels[0] ?? provider.models[0] ?? '',
      priority: account?.priority ?? 10,
      weight: account?.weight ?? 10,
      maxConcurrency: account?.maxConcurrency ?? 4,
      proxyId: account?.proxyId ?? '',
      credential: '',
    })
    setProviderProbe(null)
    setErrors({})
    setProviderModal(true)
    setMenuOpen(null)
  }

  const submitAccount = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const existingAccount = accountDraft.id
      ? snapshot.accounts.find((account) => account.id === accountDraft.id)
      : undefined
    if (!accountDraft.providerId) nextErrors.providerId = t('请选择供应商', 'Select a provider.')
    if (!accountDraft.name.trim()) nextErrors.name = t('请输入账号名称', 'Enter an account name.')
    if (!accountDraft.id && !accountDraft.credential?.trim()) nextErrors.credential = t('首次添加需要填写凭据', 'A credential is required when adding an account.')
    if (existingAccount && existingAccount.providerId !== accountDraft.providerId && !accountDraft.credential?.trim()) {
      nextErrors.credential = t('更换供应商时必须填写该供应商的新凭据', 'Enter a new credential for the newly selected provider.')
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-account', () => api.saveAccount({
      id: accountDraft.id,
      providerId: accountDraft.providerId,
      name: accountDraft.name.trim(),
      credential: accountDraft.credential?.trim() || undefined,
      priority: accountDraft.priority,
      weight: accountDraft.weight,
      maxConcurrency: accountDraft.maxConcurrency,
      modelPolicy: accountDraft.modelPolicy,
      modelAllowlist: accountDraft.modelAllowlist,
      proxyId: accountDraft.proxyId ?? '',
    }))
    if (success) setAccountModal(false)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const success = await runAction('delete-item', () => deleteTarget.kind === 'provider'
      ? api.deleteApiSource(deleteTarget.id)
      : api.deleteAccount(deleteTarget.id))
    if (success) setDeleteTarget(null)
  }

  const clearOAuthUi = () => {
    setOauthStage('idle')
    setOauthSession(null)
    setOauthCallbackUrl('')
    setOauthError('')
    setOauthCallbackError('')
    setOauthOpenHint('')
    setOauthOpenBusy(false)
    setOauthCopied(false)
    setOauthCommitLocked(false)
    setOauthResult(null)
  }

  const abandonOAuthSession = () => {
    oauthAttemptRef.current += 1
    const sessionId = oauthSessionIdRef.current
    oauthSessionIdRef.current = null
    if (sessionId) void api.cancelChatGptOAuth(sessionId).catch(() => undefined)
  }

  const cancelChatGptOAuth = async (): Promise<boolean> => {
    if (oauthCommitLocked) {
      setOauthOpenHint(t('授权结果正在保存并检测账号，此阶段不可取消，请等待完成。', 'The authorization result is being saved and the account is being checked. This stage cannot be cancelled.'))
      return false
    }
    const sessionId = oauthSessionIdRef.current
    if (!sessionId) {
      if (oauthStage === 'starting') {
        oauthAttemptRef.current += 1
        setOauthStage('cancelled')
      }
      return true
    }
    const attempt = oauthAttemptRef.current
    const resumeStage: OAuthUiStage = oauthStage === 'submitting' || oauthStage === 'exchanging' ? 'exchanging' : 'waiting'
    setOauthStage('cancelling')
    setOauthOpenHint('')
    try {
      const cancelled = await api.cancelChatGptOAuth(sessionId)
      if (oauthAttemptRef.current !== attempt || oauthSessionIdRef.current !== sessionId) return false
      if (!cancelled) {
        setOauthCommitLocked(true)
        setOauthStage('exchanging')
        setOauthOpenHint(t('授权结果已进入 Token 保存与账号检测阶段，现在不能取消，请等待完成。', 'The authorization result is now saving tokens and checking the account. It can no longer be cancelled.'))
        return false
      }
      oauthAttemptRef.current += 1
      oauthSessionIdRef.current = null
      setOauthSession(null)
      setOauthCommitLocked(false)
      setOauthCallbackUrl('')
      setOauthCallbackError('')
      setOauthOpenHint('')
      setOauthStage('cancelled')
      return true
    } catch (cause) {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) {
        setOauthStage(resumeStage)
        setOauthOpenHint(localizeBackendError(cause, language, t('取消失败，请稍后重试。', 'Cancellation failed. Try again later.')))
      }
      return false
    }
  }

  const openChatGptAccountDialog = () => {
    abandonOAuthSession()
    clearOAuthUi()
    setAccountAddMethod('oauth')
    setChatGptImport((current) => current.proxyMode === 'preserve' ? { ...current, proxyMode: 'direct', proxyId: '' } : current)
    setErrors({})
    setImportNotice('')
    setChatGptImportOpen(true)
  }

  const closeChatGptAccountDialog = async () => {
    if (fileImportBusy) return
    if (oauthSessionIdRef.current && !await cancelChatGptOAuth()) return
    clearOAuthUi()
    setChatGptImportOpen(false)
  }

  const switchAccountAddMethod = (method: AccountAddMethod) => {
    if (method === accountAddMethod || importConfigurationLocked) return
    setErrors({})
    setAccountAddMethod(method)
    if (method === 'oauth') {
      setChatGptImport((current) => current.proxyMode === 'preserve' ? { ...current, proxyMode: 'direct', proxyId: '' } : current)
    }
  }

  const oauthImportSummary = (result: ChatGptAccountImportResult) => {
    const detected = result.detectionResults.filter((item) => item.ok).length
    const assignment = result.assignmentSummary
    const tagName = assignment.tagId ? tagById.get(assignment.tagId)?.name ?? t('已选 Tag', 'Selected tag') : t('未标记', 'Untagged')
    const assignedPoolName = assignment.poolId ? snapshot.pools.find((pool) => pool.id === assignment.poolId)?.name : undefined
    const poolName = assignment.poolId
      ? assignedPoolName ? setupPoolDisplayName(assignedPoolName, t) : t('已选号池', 'Selected pool')
      : t('未加入号池', 'Not added to a pool')
    const poolAppendError = assignment.poolAppendError
      ? localizeBackendMessage(assignment.poolAppendError, language, t('号池追加失败', 'Pool update failed.'))
      : undefined
    const warnings = localizeBackendMessages(result.warnings, language, t('导入警告', 'Import warning.'))
    return t(
      `OAuth 添加完成：新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个；检测可用 ${detected} 个；Tag：${tagName}；号池：${poolName}${assignment.poolMembersAdded ? `（新增成员 ${assignment.poolMembersAdded} 个）` : ''}${poolAppendError ? `；号池追加失败：${poolAppendError}` : ''}${warnings.length ? `；${warnings.join(' ')}` : ''}`,
      `OAuth complete: ${result.createdAccountIds.length} added, ${result.updatedAccountIds.length} updated; ${detected} available; Tag: ${tagName}; Pool: ${poolName}${assignment.poolMembersAdded ? ` (${assignment.poolMembersAdded} members added)` : ''}${poolAppendError ? `; failed to add to pool: ${poolAppendError}` : ''}${warnings.length ? `; ${warnings.join(' ')}` : ''}`,
    )
  }

  const waitForChatGptOAuth = async (session: ChatGptOAuthSessionStart, attempt: number) => {
    try {
      const result = await api.waitChatGptOAuth(session.sessionId)
      if (oauthAttemptRef.current !== attempt) return
      oauthSessionIdRef.current = null
      setOauthCommitLocked(false)
      setOauthResult(result)
      setOauthError('')
      setOauthCallbackError('')
      setOauthStage('success')
      setImportNotice(oauthImportSummary(result))
    } catch (cause) {
      if (oauthAttemptRef.current !== attempt) return
      oauthSessionIdRef.current = null
      setOauthCommitLocked(false)
      setOauthError(localizeBackendError(cause, language, t('OAuth 授权未完成，请重试', 'OAuth authorization did not complete. Try again.')))
      setOauthStage('error')
    }
  }

  const openOAuthInSystemBrowser = async (session = oauthSession) => {
    if (!session || oauthOpenBusy) return
    const attempt = oauthAttemptRef.current
    const sessionId = session.sessionId
    if (oauthSessionIdRef.current !== sessionId) return
    setOauthOpenBusy(true)
    setOauthOpenHint('')
    try {
      await api.openChatGptOAuth(sessionId)
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenHint(t('已在系统浏览器中打开授权页面。', 'The authorization page was opened in your system browser.'))
    } catch (cause) {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) {
        setOauthOpenHint(localizeBackendError(cause, language, t('无法打开系统浏览器，请复制授权链接后手动打开。', 'Could not open the system browser. Copy the authorization link and open it manually.')))
      }
    } finally {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenBusy(false)
    }
  }

  const startChatGptOAuth = async () => {
    abandonOAuthSession()
    const attempt = oauthAttemptRef.current
    setOauthStage('starting')
    setOauthSession(null)
    setOauthResult(null)
    setOauthError('')
    setOauthCallbackError('')
    setOauthCallbackUrl('')
    setOauthOpenHint('')
    setOauthOpenBusy(false)
    setOauthCopied(false)
    setOauthCommitLocked(false)
    try {
      const session = await api.startChatGptOAuth({
        name: chatGptImport.name.trim() || undefined,
        tagId: chatGptImport.tagId,
        poolId: chatGptImport.poolId,
        proxyMode: chatGptImport.proxyMode,
        proxyId: chatGptImport.proxyId || undefined,
      })
      if (oauthAttemptRef.current !== attempt) {
        void api.cancelChatGptOAuth(session.sessionId).catch(() => undefined)
        return
      }
      oauthSessionIdRef.current = session.sessionId
      setOauthSession(session)
      setOauthNow(Date.now())
      setOauthStage('waiting')
      void waitForChatGptOAuth(session, attempt)
      await openOAuthInSystemBrowser(session)
    } catch (cause) {
      if (oauthAttemptRef.current !== attempt) return
      oauthSessionIdRef.current = null
      setOauthError(localizeBackendError(cause, language, t('无法启动 OAuth 授权', 'Could not start OAuth authorization.')))
      setOauthStage('error')
    }
  }

  const copyOAuthAuthorizationUrl = async () => {
    if (!oauthSession) return
    const attempt = oauthAttemptRef.current
    const sessionId = oauthSession.sessionId
    if (oauthSessionIdRef.current !== sessionId) return
    try {
      await navigator.clipboard.writeText(oauthSession.authorizationUrl)
      if (oauthAttemptRef.current !== attempt || oauthSessionIdRef.current !== sessionId) return
      setOauthCopied(true)
      setOauthOpenHint(t('授权链接已复制。', 'Authorization link copied.'))
    } catch {
      if (oauthAttemptRef.current !== attempt || oauthSessionIdRef.current !== sessionId) return
      setOauthOpenHint(t('复制失败，请手动选择授权链接。', 'Copy failed. Select the authorization link manually.'))
    }
  }

  const submitOAuthCallback = async () => {
    const sessionId = oauthSessionIdRef.current
    const callbackUrl = oauthCallbackUrl.trim()
    if (!sessionId || !callbackUrl || oauthStage === 'submitting' || oauthStage === 'exchanging') return
    setOauthStage('submitting')
    setOauthCallbackError('')
    try {
      await api.submitChatGptOAuthCallback({ sessionId, callbackUrl })
      if (oauthSessionIdRef.current === sessionId) {
        setOauthCallbackUrl('')
        setOauthStage('exchanging')
      }
    } catch (cause) {
      if (oauthSessionIdRef.current !== sessionId) return
      setOauthCallbackError(localizeBackendError(cause, language, t('回调地址提交失败', 'Failed to submit the callback URL.')))
      setOauthStage('waiting')
    }
  }

  const submitChatGptImport = async (event: React.FormEvent) => {
    event.preventDefault()
    if (accountAddMethod !== 'token-json') return
    const progressId = crypto.randomUUID()
    importProgressId.current = progressId
    setImportProgress({ progressId, phase: 'importing', completed: 0, total: 1, percent: 0, message: t('正在准备导入…', 'Preparing import…') })
    setFileImportBusy(true)
    setErrors({})
    try {
      const result = await api.importChatGptAccounts({ ...chatGptImport, progressId })
      setChatGptImportOpen(false)
      setChatGptImport({ ...chatGptImport, content: '' })
      const detected = result.detectionResults.filter((item) => item.ok).length
      const modelsRefreshed = result.detectionResults.filter((item) => item.availableModelCount !== undefined).length
      const modelFailures = result.detectionResults.length - modelsRefreshed
      const modelWarnings = result.detectionResults.filter((item) => item.modelRefreshError).slice(0, 3).map((item) => {
        const detail = localizeBackendMessage(item.modelRefreshError, language, t('模型刷新失败', 'Model refresh failed.'))
        return t(`${item.accountName} 模型：${detail}`, `${item.accountName} models: ${detail}`)
      })
      const assignment = result.assignmentSummary
      const poolAppendError = assignment.poolAppendError
        ? localizeBackendMessage(assignment.poolAppendError, language, t('号池追加失败', 'Pool update failed.'))
        : undefined
      const importWarnings = localizeBackendMessages(result.warnings, language, t('导入警告', 'Import warning.'))
      setImportNotice(t(
        `导入完成：新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个 ChatGPT/Codex 账号；检测可用 ${detected} 个，失败 ${result.detectionResults.length - detected} 个；Tag 更新 ${assignment.tagUpdatedAccountCount} 个；加入号池 ${assignment.poolMembersAdded} 个，已存在 ${assignment.poolMembersAlreadyPresent} 个，跳过 ${assignment.poolMembersSkipped} 个；模型刷新成功 ${modelsRefreshed} 个，失败 ${modelFailures} 个${poolAppendError ? `；号池追加失败：${poolAppendError}` : ''}${[...modelWarnings, ...importWarnings].length ? `；${[...modelWarnings, ...importWarnings].join(' ')}` : ''}`,
        `Import complete: ${result.createdAccountIds.length} added and ${result.updatedAccountIds.length} updated; ${detected} available and ${result.detectionResults.length - detected} failed; ${assignment.tagUpdatedAccountCount} tags updated; ${assignment.poolMembersAdded} added to pools, ${assignment.poolMembersAlreadyPresent} already present, ${assignment.poolMembersSkipped} skipped; ${modelsRefreshed} model refreshes succeeded and ${modelFailures} failed${poolAppendError ? `; failed to add to pool: ${poolAppendError}` : ''}${[...modelWarnings, ...importWarnings].length ? `; ${[...modelWarnings, ...importWarnings].join(' ')}` : ''}`,
      ))
    } catch (cause) {
      setErrors({ chatgptImport: localizeBackendError(cause, language, t('ChatGPT 账号导入失败', 'Failed to import ChatGPT accounts.')) })
    } finally {
      importProgressId.current = null
      setImportProgress(null)
      setFileImportBusy(false)
    }
  }

  const importChatGptFiles = async () => {
    const progressId = crypto.randomUUID()
    importProgressId.current = progressId
    setImportProgress({ progressId, phase: 'importing', completed: 0, total: 1, percent: 0, message: t('等待选择账号文件…', 'Waiting for account files…') })
    setFileImportBusy(true)
    setErrors({})
    try {
      const result = await api.importChatGptAccountFiles({
        tagId: chatGptImport.tagId,
        poolId: chatGptImport.poolId,
        proxyMode: chatGptImport.proxyMode,
        proxyId: chatGptImport.proxyId || undefined,
        progressId,
      })
      if (result.cancelled) return
      setChatGptImportOpen(false)
      const importedFiles = result.fileResults.filter((file) => file.status === 'imported').length
      const failedFiles = result.fileResults.filter((file) => file.status === 'failed')
      const detected = result.detectionResults.filter((item) => item.ok).length
      const detectionFailed = result.detectionResults.length - detected
      const modelsRefreshed = result.detectionResults.filter((item) => item.availableModelCount !== undefined).length
      const modelFailures = result.detectionResults.length - modelsRefreshed
      const details = [
        t(`批量导入完成：选择 ${result.selectedFiles} 个文件，成功 ${importedFiles} 个，失败 ${failedFiles.length} 个`, `Batch import complete: ${result.selectedFiles} files selected, ${importedFiles} succeeded, ${failedFiles.length} failed`),
        t(`新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个账号`, `${result.createdAccountIds.length} accounts added, ${result.updatedAccountIds.length} updated`),
        t(`检测可用 ${detected} 个，检测失败 ${detectionFailed} 个`, `${detected} accounts available, ${detectionFailed} checks failed`),
        t(`Tag 更新 ${result.assignmentSummary.tagUpdatedAccountCount} 个`, `${result.assignmentSummary.tagUpdatedAccountCount} tags updated`),
        t(`号池新增 ${result.assignmentSummary.poolMembersAdded} 个，已存在 ${result.assignmentSummary.poolMembersAlreadyPresent} 个，跳过 ${result.assignmentSummary.poolMembersSkipped} 个${result.assignmentSummary.poolAppendError ? `（追加失败：${localizeBackendMessage(result.assignmentSummary.poolAppendError, language, t('号池追加失败', 'Pool update failed.'))}）` : ''}`, `${result.assignmentSummary.poolMembersAdded} added to pools, ${result.assignmentSummary.poolMembersAlreadyPresent} already present, ${result.assignmentSummary.poolMembersSkipped} skipped${result.assignmentSummary.poolAppendError ? ` (failed to add: ${localizeBackendMessage(result.assignmentSummary.poolAppendError, language, 'Pool update failed.')})` : ''}`),
        t(`模型刷新成功 ${modelsRefreshed} 个，失败 ${modelFailures} 个`, `${modelsRefreshed} model refreshes succeeded, ${modelFailures} failed`),
        ...failedFiles.slice(0, 3).map((file) => `${file.fileName}${t('：', ': ')}${localizeBackendMessage(file.error, language, t('导入失败', 'Import failed.'))}`),
        ...result.detectionResults.filter((item) => !item.ok).slice(0, 3).map((item) => `${item.accountName}${t('：', ': ')}${localizeBackendMessage(item.error, language, t('检测失败', 'Check failed.'))}`),
        ...result.detectionResults.filter((item) => item.modelRefreshError).slice(0, 3).map((item) => `${item.accountName}${t(' 模型：', ' models: ')}${localizeBackendMessage(item.modelRefreshError, language, t('模型刷新失败', 'Model refresh failed.'))}`),
        ...localizeBackendMessages(result.warnings.slice(0, 3), language, t('导入警告', 'Import warning.')),
      ]
      setImportNotice(details.join(t('；', '; ')))
    } catch (cause) {
      setErrors({ chatgptImport: localizeBackendError(cause, language, t('CPA / Sub2API 文件导入失败', 'Failed to import CPA / Sub2API files.')) })
    } finally {
      importProgressId.current = null
      setImportProgress(null)
      setFileImportBusy(false)
    }
  }

  const checkAllAccounts = async () => {
    if (!oauthAccounts.length || checkingAllAccounts) return
    await runAction('check-all-accounts', async () => {
      const accountIds = oauthAccounts.map((account) => account.id)
      let cursor = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= accountIds.length) return
          await api.checkAccount(accountIds[index]).catch(() => undefined)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, accountIds.length) }, () => worker()))
      return api.getSnapshot()
    })
  }

  const selectAccounts = (predicate: (account: PublicAccount) => boolean) => {
    setSelectedAccountIds(oauthAccounts.filter(predicate).map((account) => account.id))
  }

  const saveTag = async (selectForImport = false) => {
    const name = (selectForImport ? importTagName : tagDraft.name).trim()
    if (!name) return
    let savedSnapshot: AppSnapshot | undefined
    const success = await runAction('save-account-tag', async () => {
      savedSnapshot = await api.saveAccountTag(selectForImport ? { name } : { id: tagDraft.id, name })
      return savedSnapshot
    })
    if (!success || !savedSnapshot) return
    const savedTag = savedSnapshot.accountTags.find((tag) => tag.id === tagDraft.id)
      ?? savedSnapshot.accountTags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (selectForImport && savedTag) {
      setChatGptImport((current) => ({ ...current, tagId: savedTag.id }))
      setImportTagName('')
    } else {
      setTagDraft({ name: '' })
    }
  }

  const deleteTag = async () => {
    if (!tagDeleteTarget) return
    const success = await runAction('delete-account-tag', () => api.deleteAccountTag(tagDeleteTarget.id))
    if (success) setTagDeleteTarget(null)
  }

  const assignSelectedTag = async (tagId: string | null) => {
    if (!selectedAccountIds.length) return
    const success = await runAction('set-account-tags', () => api.setAccountTags({ accountIds: selectedAccountIds, tagId }))
    if (success) setTagAssignmentOpen(false)
  }

  const toggleSelectedAccount = (accountId: string) => {
    setSelectedAccountIds((current) => current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId])
  }

  const toggleVisibleAccounts = (checked: boolean) => {
    const visibleIds = new Set(visibleAccounts.map((account) => account.id))
    setSelectedAccountIds((current) => checked
      ? [...new Set([...current, ...visibleIds])]
      : current.filter((id) => !visibleIds.has(id)))
  }

  const openAccountExport = () => {
    const oauthIds = new Set(oauthAccounts.map((account) => account.id))
    const alreadySelected = selectedAccountIds.filter((id) => oauthIds.has(id))
    setExportAccountIds(alreadySelected.length ? alreadySelected : [...oauthIds])
    setExportNotice('')
    setErrors({})
    setExportOpen(true)
  }

  const selectExportAccounts = (predicate: (account: PublicAccount) => boolean) => {
    setExportAccountIds(oauthAccounts.filter(predicate).map((account) => account.id))
  }

  const toggleExportAccount = (accountId: string) => {
    setExportAccountIds((current) => current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId])
  }

  const exportSelectedAccounts = async () => {
    if (!exportAccountIds.length || exportBusy) return
    setExportBusy(true)
    setExportNotice('')
    try {
      const result = await api.exportChatGptAccounts({ accountIds: exportAccountIds, format: exportFormat, mode: exportMode })
      if (result.cancelled) return
      setExportOpen(false)
      const target = result.filePath ?? result.directoryPath ?? t('导出位置', 'Export location')
      setExportNotice(t(`已导出 ${result.exportedAccounts} 个账号、${result.exportedFiles} 个文件：${target}`, `Exported ${result.exportedAccounts} accounts in ${result.exportedFiles} files: ${target}`))
    } catch (cause) {
      setErrors({ accountExport: localizeBackendError(cause, language, t('账号导出失败', 'Account export failed.')) })
    } finally {
      setExportBusy(false)
    }
  }

  const confirmBulkDelete = async () => {
    if (!selectedAccountIds.length) return
    const success = await runAction('delete-accounts', () => api.deleteAccounts(selectedAccountIds))
    if (success) {
      setSelectedAccountIds([])
      setBulkDeleteOpen(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('账号与中转', 'Accounts & relays')}
        actions={
          tab === 'accounts'
            ? <button type="button" className="button button--primary" onClick={openChatGptAccountDialog}><Plus size={16} /> {t('添加 Codex 账号', 'Add Codex account')}</button>
            : tab === 'official'
              ? <button type="button" className="button button--primary" onClick={() => openProvider('official-api')}><Plus size={16} /> {t('添加官方 API', 'Add official API')}</button>
              : <><button type="button" className="button button--secondary" onClick={() => openAggregateRelay()}><Boxes size={16} /> {t('添加聚合中转', 'Add aggregate relay')}</button><button type="button" className="button button--primary" onClick={() => openProvider('relay')}><Plus size={16} /> {t('添加中转站', 'Add relay')}</button></>
        }
      />

      <div className="segmented-control source-type-tabs" role="tablist" aria-label={t('账号与中转管理视图', 'Accounts and relays management view')}>
        <button type="button" role="tab" aria-selected={tab === 'accounts'} className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>
          <KeyRound size={15} />{t('账号', 'Accounts')} <span>{oauthAccounts.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'official'} className={tab === 'official' ? 'active' : ''} onClick={() => setTab('official')}>
          <Server size={15} />{t('官方 API', 'Official APIs')} <span>{officialProviders.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'relays'} className={tab === 'relays' ? 'active' : ''} onClick={() => setTab('relays')}>
          <Boxes size={15} />{t('中转站', 'Relays')} <span>{relayProviders.length + aggregateRelays.length}</span>
        </button>
      </div>
      {importNotice && <div className="client-config-notice"><CheckCircle2 size={16} />{importNotice}</div>}
      {exportNotice && <div className="client-config-notice"><Download size={16} />{exportNotice}</div>}

      {tab === 'accounts' ? (
        <section className="panel panel--flush">
          {oauthAccounts.length ? (
            <>
              <div className="table-toolbar account-table-toolbar">
                <div className="account-toolbar-summary">
                  <label className="account-quota-filter"><input type="checkbox" checked={hideExhaustedAccounts} onChange={(event) => setHideExhaustedAccounts(event.target.checked)} /><span>{t('隐藏额度耗尽账号', 'Hide quota-exhausted accounts')}</span><small>{exhaustedAccountCount ? t(`${exhaustedAccountCount} 个`, `${exhaustedAccountCount}`) : t('暂无', 'None')}</small></label>
                  <strong>{t(`已选择 ${selectedAccountIds.length} 个`, `${selectedAccountIds.length} selected`)}</strong>
                </div>
                <div className="account-tag-filter" aria-label={t('按 Tag 筛选账号', 'Filter accounts by tag')}>
                  <button type="button" className={tagFilter === 'all' ? 'active' : ''} onClick={() => setTagFilter('all')}>{t('全部', 'All')} <span>{oauthAccounts.length}</span></button>
                  <button type="button" className={tagFilter === 'untagged' ? 'active' : ''} onClick={() => setTagFilter(tagFilter === 'untagged' ? 'all' : 'untagged')}>{t('未标记', 'Untagged')} <span>{oauthAccounts.filter((account) => !account.tagId).length}</span></button>
                  {snapshot.accountTags.map((tag) => <button type="button" key={tag.id} className={tagFilter === tag.id ? 'active' : ''} onClick={() => setTagFilter(tagFilter === tag.id ? 'all' : tag.id)}>{tag.name} <span>{oauthAccounts.filter((account) => account.tagId === tag.id).length}</span></button>)}
                </div>
                <div className="account-selection-actions" aria-label={t('按条件选择账号', 'Select accounts by condition')}>
                  <button type="button" onClick={() => selectAccounts(() => true)}>{t('全选', 'Select all')}</button>
                  <button type="button" onClick={() => selectAccounts((account) => !accountIsCooling(account))}>{t('非冷却', 'Not cooling')}</button>
                  <button type="button" onClick={() => selectAccounts((account) => accountIsCooling(account))}>{t('冷却中', 'Cooling down')}</button>
                  <button type="button" onClick={() => selectAccounts((account) => account.status === 'disabled')}>{t('已停用', 'Disabled')}</button>
                  <button type="button" onClick={() => selectAccounts((account) => accountQuotaIsExhausted(account))}>{t('额度耗尽', 'Quota exhausted')}</button>
                  <button type="button" disabled={!selectedAccountIds.length} onClick={() => setSelectedAccountIds([])}>{t('清空', 'Clear')}</button>
                </div>
                <div className="account-toolbar-actions">
                  <button className="button button--secondary" type="button" onClick={() => setTagManagerOpen(true)}><Tags size={16} />{t('管理 Tag', 'Manage tags')}</button>
                  <button className="button button--secondary" type="button" disabled={!selectedAccountIds.length} onClick={() => setTagAssignmentOpen(true)}><Tag size={16} />{t('设置 Tag', 'Set tag')}</button>
                  <button className="button button--secondary" type="button" disabled={!oauthAccounts.length} onClick={openAccountExport}><Download size={16} />{t('导出账号', 'Export accounts')}</button>
                  <button className="button button--secondary button--danger-text" type="button" disabled={!selectedAccountIds.length} onClick={() => setBulkDeleteOpen(true)}><Trash2 size={16} />{t('删除所选', 'Delete selected')}</button>
                  <button className="button button--secondary" type="button" disabled={checkingAllAccounts} onClick={() => void checkAllAccounts()}>{checkingAllAccounts ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{checkingAllAccounts ? t('正在检测…', 'Checking…') : t('检测全部', 'Check all')}</button>
                </div>
              </div>
              {visibleAccounts.length ? <div className="table-wrap">
              <table className="data-table accounts-table" style={{ width: accountTableWidth, minWidth: '100%' }}>
                <colgroup>{ACCOUNT_COLUMNS.map((column) => <col key={column.id} style={{ width: accountColumnWidths[column.id] }} />)}</colgroup>
                <thead><tr>
                  <th className="account-select-column account-column-header"><input type="checkbox" aria-label={t('选择当前显示的全部账号', 'Select all currently visible accounts')} checked={visibleAccounts.length > 0 && visibleAccounts.every((account) => selectedAccountIds.includes(account.id))} onChange={(event) => toggleVisibleAccounts(event.target.checked)} /></th>
                  {ACCOUNT_COLUMNS.slice(1).map((column) => <th className="account-column-header" key={column.id} aria-label={column.id === 'actions' ? t(column.label, ACCOUNT_COLUMN_LABELS_EN[column.id]) : undefined}>{column.id === 'actions' ? null : t(column.label, ACCOUNT_COLUMN_LABELS_EN[column.id])}{accountColumnResizer(column)}</th>)}
                </tr></thead>
                <tbody>
                  {visibleAccounts.map((account) => {
                    const provider = providerById.get(account.providerId)
                    const checking = checkingAllAccounts || busyKeys.has(`check-${account.id}`) || account.status === 'checking'
                    const refreshingModels = busyKeys.has(`refresh-account-models-${account.id}`)
                    const openModels = effectiveAccountModels(account, provider?.models)
                    const modelSummary = isAccountModelWildcard(account)
                      ? t('待刷新 · 兼容通配', 'Refresh pending · Compatible wildcard')
                      : account.modelsRefreshedAt === undefined
                        ? t(`待刷新 · 开放 ${openModels.length} 个模型`, `Refresh pending · ${openModels.length} models allowed`)
                        : t(`开放 ${openModels.length} 个模型`, `${openModels.length} models allowed`)
                    return (
                      <tr key={account.id}>
                        <td className="account-select-column"><input type="checkbox" aria-label={t(`选择账号 ${account.name}`, `Select account ${account.name}`)} checked={selectedAccountIds.includes(account.id)} onChange={() => toggleSelectedAccount(account.id)} /></td>
                        <td><div className="provider-cell"><span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1) ?? '?'}</span><div><strong title={account.name}>{accountNameById.get(account.id) ?? account.name}</strong><span>{provider?.name ?? t('供应商已删除', 'Provider deleted')}{account.proxyId ? ` · ${proxyById.get(account.proxyId)?.name ?? t('代理已删除', 'Proxy deleted')}` : ''} · {modelSummary}</span></div></div></td>
                        <td>{account.tagId && tagById.has(account.tagId) ? <span className="account-tag-chip"><Tag size={12} />{tagById.get(account.tagId)?.name}</span> : <span className="muted">{t('未标记', 'Untagged')}</span>}</td>
                        <td><AccountStatusBadge status={account.status} circuitState={account.circuitState} /><CooldownCountdown account={account} />{account.credentialType === 'chatgpt-oauth' && <span className="row-note">ChatGPT OAuth · {account.renewable ? t('可续期', 'Renewable') : t('会话到期即停用', 'Disabled when the session expires')}</span>}{Boolean(account.consecutiveFailures) && <span className="row-note">{t('连续失败', 'Consecutive failures')} {account.consecutiveFailures}</span>}{account.lastError && <span className="row-note row-note--danger" title={localizeBackendMessage(account.lastError, language, t('账号检测失败', 'Account check failed.'))}>{localizeBackendMessage(account.lastError, language, t('账号检测失败', 'Account check failed.'))}</span>}</td>
                        <td><AccountFitness fitness={account.fitness} /></td>
                        <td><span className="mono masked-key">{account.maskedCredential}</span></td>
                        <td><div className="concurrency-cell"><strong>{account.inFlight} / {account.maxConcurrency}</strong><div className="mini-progress"><span style={{ width: `${Math.min(100, account.inFlight / account.maxConcurrency * 100)}%` }} /></div></div></td>
                        <td>{account.credentialType === 'chatgpt-oauth'
                          ? <CodexQuotaCompact quota={account.codexQuota} onClick={() => setQuotaAccountId(account.id)} />
                          : account.quotaRemaining !== undefined ? <strong>{account.quotaUnit === 'usd' ? new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }).format(account.quotaRemaining) : `${new Intl.NumberFormat(locale).format(account.quotaRemaining)}${account.quotaUnit === 'percent' ? '%' : ''}`}</strong> : <span className="muted">{t('未知', 'Unknown')}</span>}</td>
                        <td>{account.latencyMs ? durationLabel(account.latencyMs) : '—'}</td>
                        <td>{relativeTime(account.lastUsedAt, locale)}</td>
                        <td className="actions-cell">
                          <button className="icon-button" type="button" title={t('刷新此账号的可用模型', 'Refresh available models for this account')} disabled={refreshingModels} onClick={() => void runAction(`refresh-account-models-${account.id}`, () => api.refreshAccountModels(account.id))}>{refreshingModels ? <LoaderCircle size={16} className="spin" /> : <Boxes size={16} />}</button>
                          <button className="icon-button" type="button" title={t('检测账号', 'Check account')} disabled={checking} onClick={() => void runAction(`check-${account.id}`, () => api.checkAccount(account.id))}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button>
                          <OverflowMenu open={menuOpen === account.id} onOpenChange={(open) => setMenuOpen(open ? account.id : null)} label={t('更多操作', 'More actions')}><button type="button" onClick={() => openAccount(account)}><Edit3 size={15} />{t('编辑', 'Edit')}</button><button className="danger" type="button" onClick={() => { setDeleteTarget({ kind: 'account', id: account.id, name: account.name }); setMenuOpen(null) }}><Trash2 size={15} />{t('删除', 'Delete')}</button></OverflowMenu>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div> : <div className="account-filter-empty"><CheckCircle2 size={22} /><strong>{t('当前筛选下没有账号', 'No accounts match the current filters')}</strong><span>{t('更换 Tag 筛选或取消“隐藏额度耗尽账号”后再试。', 'Change the tag filter or turn off “Hide quota-exhausted accounts.”')}</span></div>}
            </>
          ) : (
            <EmptyState
              icon={<KeyRound size={24} />}
              title={t('尚未添加 Codex 账号', 'No Codex accounts yet')}
              action={<button className="button button--primary" type="button" onClick={openChatGptAccountDialog}><Plus size={16} />{t('添加 Codex 账号', 'Add Codex account')}</button>}
            />
          )}
        </section>
      ) : (
        (tab === 'official' ? officialProviders.length : relayProviders.length + aggregateRelays.length) ? (
          <div className="provider-grid">
            {(tab === 'official' ? officialProviders : relayProviders).map((provider) => {
              const sourceAccount = snapshot.accounts.find((account) => account.providerId === provider.id && account.credentialType !== 'chatgpt-oauth')
              const brandIcon = providerBrandIcon(provider.kind)
              return (
                <article className="provider-card" key={provider.id}>
                  <div className="provider-card__top">
                    <span className={`provider-avatar provider-avatar--large ${brandIcon ? 'provider-avatar--brand' : ''}`} style={{ '--provider-color': provider.color ?? '#61736f' } as React.CSSProperties}>
                      {brandIcon ? <img src={brandIcon} alt="" /> : provider.name.slice(0, 1)}
                    </span>
                    <div><h2>{provider.name}</h2><span>{t(providerKindLabels[provider.kind], providerKindLabelsEn[provider.kind])}</span></div>
                    <OverflowMenu open={menuOpen === provider.id} onOpenChange={(open) => setMenuOpen(open ? provider.id : null)} label={t('来源操作', 'Source actions')}><button type="button" disabled={testingSourceId === provider.id || !sourceAccount} onClick={() => void testSavedSource(provider, sourceAccount)}>{testingSourceId === provider.id ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('测试', 'Test')}</button><button type="button" onClick={() => openProvider(provider.sourceType === 'relay' ? 'relay' : 'official-api', provider)}><Edit3 size={15} />{t('编辑', 'Edit')}</button><button type="button" onClick={() => copySourceConfiguration(provider, sourceAccount)}><Copy size={15} />{t('复制配置', 'Copy configuration')}</button><button className="danger" type="button" onClick={() => { setDeleteTarget({ kind: 'provider', id: provider.id, name: provider.name }); setMenuOpen(null) }}><Trash2 size={15} />{t('删除', 'Delete')}</button></OverflowMenu>
                  </div>
                  <div className="provider-card__endpoint"><span>{t('基础地址', 'Base URL')}</span><code>{provider.baseUrl}</code></div>
                  <div className="provider-card__meta"><Badge tone="info">{protocolLabels[provider.protocol]}</Badge><span><KeyRound size={14} />{sourceAccount?.maskedCredential ?? t('凭据待完善', 'Credential required')}</span><span><Boxes size={14} />{t(`${provider.models.length} 个模型`, `${provider.models.length} ${provider.models.length === 1 ? 'model' : 'models'}`)}</span></div>
                  {sourceAccount && <div className="provider-source-health"><AccountStatusBadge status={sourceAccount.status} circuitState={sourceAccount.circuitState} /><span>{t('并发', 'Concurrency')} {sourceAccount.inFlight} / {sourceAccount.maxConcurrency}</span><span>{t('权重', 'Weight')} {sourceAccount.weight}</span>{sourceAccount.latencyMs !== undefined && <span>{durationLabel(sourceAccount.latencyMs)}</span>}</div>}
                  <div className="model-tags">
                    {provider.models.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                    {provider.models.length > 3 && <span>+{provider.models.length - 3}</span>}
                    {!provider.models.length && <span className="muted">{t('未限制模型', 'No model restrictions')}</span>}
                  </div>
                </article>
              )
            })}
            {tab === 'relays' && aggregateRelays.map((pool) => {
              const members = pool.members
                .filter((member) => member.enabled)
                .map((member) => snapshot.accounts.find((account) => account.id === member.accountId))
                .filter((account) => account !== undefined)
              return <article className="provider-card aggregate-relay-card" key={pool.id}>
                <div className="provider-card__top">
                  <span className="provider-avatar provider-avatar--large aggregate-relay-card__icon"><Boxes size={18} /></span>
                  <div><h2>{pool.name}</h2><span>{t('聚合中转', 'Aggregate relay')} · {pool.strategy === 'priority' ? t('故障转移', 'Failover') : pool.strategy === 'round-robin' ? t('轮询', 'Round robin') : t('平滑加权轮询', 'Smooth weighted round robin')}</span></div>
                  <OverflowMenu open={menuOpen === pool.id} onOpenChange={(open) => setMenuOpen(open ? pool.id : null)} label={t('聚合中转操作', 'Aggregate relay actions')}><button type="button" onClick={() => openAggregateRelay(pool)}><Edit3 size={15} />{t('编辑', 'Edit')}</button><button className="danger" type="button" onClick={() => { setAggregateDeleteTarget(pool); setMenuOpen(null) }}><Trash2 size={15} />{t('删除', 'Delete')}</button></OverflowMenu>
                </div>
                <div className="provider-card__endpoint"><span>{t('成员顺序', 'Member order')}</span><code>{members.map((account) => account.name).join(' → ') || t('暂无成员', 'No members')}</code></div>
                <div className="provider-card__meta"><Badge tone="info">{protocolLabels[pool.protocol]}</Badge><span><KeyRound size={14} />{t(`${members.length} 个 API 来源`, `${members.length} API ${members.length === 1 ? 'source' : 'sources'}`)}</span><span>{t(`重试 ${pool.maxRetries} 次`, `${pool.maxRetries} ${pool.maxRetries === 1 ? 'retry' : 'retries'}`)}</span></div>
                <div className="model-tags">{members.slice(0, 4).map((account) => <span key={account.id}>{account.name} · {t('权重', 'Weight')} {pool.members.find((member) => member.accountId === account.id)?.weight ?? account.weight}</span>)}{members.length > 4 && <span>+{members.length - 4}</span>}</div>
              </article>
            })}
          </div>
        ) : (
          <section className="panel"><EmptyState icon={<Server size={24} />} title={tab === 'official' ? t('尚未配置官方 API', 'No official APIs configured') : t('尚未配置中转站', 'No relays configured')} action={<button className="button button--primary" type="button" onClick={() => openProvider(tab === 'official' ? 'official-api' : 'relay')}><Plus size={16} />{tab === 'official' ? t('添加官方 API', 'Add official API') : t('添加中转站', 'Add relay')}</button>} /></section>
        )
      )}

      <Modal
        open={exportOpen}
        title={t('导出 ChatGPT / Codex 账号', 'Export ChatGPT / Codex accounts')}
        description={t('选择账号和目标格式；导出文件包含 Access Token 与 Refresh Token，请妥善保存。', 'Select accounts and a target format. Exported files contain access and refresh tokens, so store them securely.')}
        onClose={() => !exportBusy && setExportOpen(false)}
        width="large"
        closable={!exportBusy}
        footer={<><span className="modal-selection-count">{t(`已选择 ${exportAccountIds.length} / ${oauthAccounts.length}`, `${exportAccountIds.length} / ${oauthAccounts.length} selected`)}</span><button className="button button--secondary" type="button" disabled={exportBusy} onClick={() => setExportOpen(false)}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="button" disabled={exportBusy || !exportAccountIds.length} onClick={() => void exportSelectedAccounts()}>{exportBusy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{exportBusy ? t('正在导出…', 'Exporting…') : exportMode === 'merged' ? t('选择文件并导出', 'Choose file and export') : t('选择目录并导出', 'Choose folder and export')}</button></>}
      >
        <div className="account-export">
          <div className="account-export__format" role="radiogroup" aria-label={t('账号导出格式', 'Account export format')}>
            <button type="button" role="radio" aria-checked={exportFormat === 'sub2api'} className={exportFormat === 'sub2api' ? 'selected' : ''} onClick={() => setExportFormat('sub2api')}><strong>Sub2API JSON</strong><span>{t('包含 accounts、credentials、并发和优先级', 'Includes accounts, credentials, concurrency, and priority')}</span></button>
            <button type="button" role="radio" aria-checked={exportFormat === 'cpa'} className={exportFormat === 'cpa' ? 'selected' : ''} onClick={() => setExportFormat('cpa')}><strong>CPA JSON</strong><span>{t('snake_case Codex OAuth 账号对象', 'snake_case Codex OAuth account objects')}</span></button>
          </div>
          <div className="account-export__mode" role="radiogroup" aria-label={t('账号文件组织方式', 'Account file organization')}>
            <span>{t('文件组织', 'File organization')}</span>
            <button type="button" role="radio" aria-checked={exportMode === 'merged'} className={exportMode === 'merged' ? 'selected' : ''} onClick={() => setExportMode('merged')}><strong>{t('合并导出', 'Merged export')}</strong><small>{t('全部账号写入一个 JSON 文件', 'Write all accounts to one JSON file')}</small></button>
            <button type="button" role="radio" aria-checked={exportMode === 'separate'} className={exportMode === 'separate' ? 'selected' : ''} onClick={() => setExportMode('separate')}><strong>{t('分别导出', 'Separate export')}</strong><small>{t('每个账号生成一个独立 JSON 文件', 'Create one JSON file per account')}</small></button>
          </div>
          <div className="account-export__selection-bar">
            <span>{t('选择账号', 'Select accounts')}</span>
            <button type="button" onClick={() => selectExportAccounts(() => true)}>{t('一键全选', 'Select all')}</button>
            <button type="button" onClick={() => selectExportAccounts((account) => !accountIsCooling(account))}>{t('选中非冷却账号', 'Select non-cooling accounts')}</button>
            <button type="button" disabled={!exportAccountIds.length} onClick={() => setExportAccountIds([])}>{t('清空', 'Clear')}</button>
          </div>
          <div className="account-export__list">
            {oauthAccounts.map((account) => {
              const provider = providerById.get(account.providerId)
              const selected = exportAccountIds.includes(account.id)
              return <label className={selected ? 'selected' : ''} key={account.id}><input type="checkbox" checked={selected} onChange={() => toggleExportAccount(account.id)} /><span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1) ?? '?'}</span><span><strong title={account.name}>{accountNameById.get(account.id) ?? account.name}</strong><small>{provider?.name ?? t('供应商已删除', 'Provider deleted')} · {accountIsCooling(account) ? t('冷却中', 'Cooling down') : t('非冷却', 'Not cooling')} · {account.renewable ? t('可续期', 'Renewable') : 'Access Token only'}</small></span><AccountStatusBadge status={account.status} circuitState={account.circuitState} /></label>
            })}
          </div>
          <FieldError>{errors.accountExport}</FieldError>
        </div>
      </Modal>

      <Modal
        open={chatGptImportOpen}
        title={t('添加 Codex 账号', 'Add Codex account')}
        onClose={() => void closeChatGptAccountDialog()}
        width="large"
        closable={!fileImportBusy && oauthStage !== 'cancelling' && !oauthCommitLocked}
        footer={accountAddMethod === 'token-json'
          ? <><button className="button button--secondary" type="button" disabled={fileImportBusy} onClick={() => void closeChatGptAccountDialog()}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" form="chatgpt-account-import" disabled={fileImportBusy}>{fileImportBusy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{fileImportBusy ? t('正在导入并刷新…', 'Importing and refreshing…') : t('粘贴内容导入', 'Import pasted content')}</button></>
          : oauthActive
            ? <><button className="button button--secondary" type="button" disabled={oauthStage === 'cancelling' || oauthCommitLocked} onClick={() => void cancelChatGptOAuth()}>{oauthStage === 'cancelling' || oauthCommitLocked ? <LoaderCircle size={16} className="spin" /> : <XCircle size={16} />}{oauthCommitLocked ? t('正在保存（不可取消）', 'Saving (cannot cancel)') : oauthStage === 'cancelling' ? t('正在取消…', 'Cancelling…') : t('取消授权', 'Cancel authorization')}</button>{oauthStage === 'waiting' ? <button className="button button--primary" type="button" disabled={oauthOpenBusy || !oauthSession} onClick={() => void openOAuthInSystemBrowser()}>{oauthOpenBusy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{oauthOpenBusy ? t('正在打开…', 'Opening…') : t('打开系统浏览器', 'Open system browser')}</button> : <button className="button button--primary" type="button" disabled><LoaderCircle size={16} className="spin" />{oauthStage === 'starting' ? t('正在创建授权…', 'Creating authorization…') : t('正在完成授权…', 'Completing authorization…')}</button>}</>
            : oauthStage === 'success'
              ? <><button className="button button--secondary" type="button" onClick={() => { clearOAuthUi(); setChatGptImport((current) => ({ ...current, name: '' })) }}><Plus size={16} />{t('继续添加', 'Add another')}</button><button className="button button--primary" type="button" onClick={() => void closeChatGptAccountDialog()}><CheckCircle2 size={16} />{t('完成', 'Done')}</button></>
              : <button className="button button--secondary" type="button" onClick={() => void closeChatGptAccountDialog()}>{t('关闭', 'Close')}</button>}
      >
        <form id="chatgpt-account-import" className="form-grid" onSubmit={(event) => void submitChatGptImport(event)}>
          <div className="account-add-method-tabs field--full" role="tablist" aria-label={t('Codex 账号添加方式', 'Method for adding a Codex account')}>
            <button type="button" role="tab" aria-selected={accountAddMethod === 'oauth'} className={accountAddMethod === 'oauth' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => switchAccountAddMethod('oauth')}>
              <span className="account-add-method-tabs__icon"><ShieldCheck size={18} /></span>
              <span><strong>{t('OAuth 授权', 'OAuth authorization')}</strong><small>{t('在 OpenAI 页面登录，无需手动查找 Token', 'Sign in on the OpenAI page without locating a token manually')}</small></span>
              <Badge tone="success">{t('推荐', 'Recommended')}</Badge>
            </button>
            <button type="button" role="tab" aria-selected={accountAddMethod === 'token-json'} className={accountAddMethod === 'token-json' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => switchAccountAddMethod('token-json')}>
              <span className="account-add-method-tabs__icon"><Files size={18} /></span>
              <span><strong>Token / JSON</strong><small>{t('导入 Sub2API / CPA 或粘贴 Access Token', 'Import Sub2API / CPA or paste an access token')}</small></span>
              <Badge tone="neutral">{t('兼容导入', 'Compatible import')}</Badge>
            </button>
          </div>

          <details className="account-import-options field--full">
            <summary><div><strong>{t('账号归类与网络（可选）', 'Account organization and network (optional)')}</strong><span>{t('以下设置同时应用于 OAuth 授权和 Token / JSON 导入', 'These settings apply to both OAuth authorization and Token / JSON imports.')}</span></div><span className="account-import-options__summary-side">{importConfigurationLocked && <Badge tone="info">{t('授权期间已锁定', 'Locked during authorization')}</Badge>}<ChevronDown size={16} /></span></summary>
            <div className="account-import-options__body">
          <div className="field field--full">
            <span>{t('本批次 Tag', 'Tag for this batch')}</span>
            <div className="tag-choice-grid" role="radiogroup" aria-label={t('本批次 Tag', 'Tag for this batch')}>
              <button type="button" role="radio" aria-checked={chatGptImport.tagId === null} className={chatGptImport.tagId === null ? 'selected' : ''} disabled={importConfigurationLocked} onClick={() => setChatGptImport({ ...chatGptImport, tagId: null })}>{t('未标记', 'Untagged')}</button>
              {snapshot.accountTags.map((tag) => <button type="button" role="radio" aria-checked={chatGptImport.tagId === tag.id} className={chatGptImport.tagId === tag.id ? 'selected' : ''} disabled={importConfigurationLocked} key={tag.id} onClick={() => setChatGptImport({ ...chatGptImport, tagId: tag.id })}><Tag size={13} />{tag.name}</button>)}
            </div>
            <div className="tag-inline-create"><input value={importTagName} maxLength={24} disabled={importConfigurationLocked} onChange={(event) => setImportTagName(event.target.value)} placeholder={t('新建自定义 Tag', 'New custom tag')} /><button className="button button--secondary" type="button" disabled={importConfigurationLocked || !importTagName.trim() || busyKeys.has('save-account-tag')} onClick={() => void saveTag(true)}><Plus size={15} />{t('新建并选中', 'Create and select')}</button></div>
            <small>{t('未标记会清空本批次中重复账号原有的 Tag。', 'Choosing Untagged clears existing tags on duplicate accounts in this batch.')}</small>
          </div>
          <label className="field field--full">
            <span>{t('导入后加入号池（可选）', 'Add to pool after import (optional)')}</span>
            <select value={chatGptImport.poolId ?? ''} disabled={importConfigurationLocked} onChange={(event) => setChatGptImport({ ...chatGptImport, poolId: event.target.value || null })}>
              <option value="">{t('不加入号池', 'Do not add to a pool')}</option>
              {compatibleImportPools.map((pool) => <option key={pool.id} value={pool.id}>{setupPoolDisplayName(pool.name, t)} · {t(`${pool.members.length} 个成员`, `${pool.members.length} members`)} · {pool.strategy}</option>)}
            </select>
            <small>{t('只显示普通 OpenAI Responses 号池；仅检测成功的账号会加入。', 'Only standard OpenAI Responses pools are shown, and only accounts that pass checks are added.')}</small>
          </label>
          <label className="field field--full">
            <span>{accountAddMethod === 'oauth' ? t('Token 交换与后续检测出口', 'Proxy for token exchange and later checks') : t('出口代理', 'Exit proxy')}</span>
            <select
              value={importProxyValue(chatGptImport.proxyMode, chatGptImport.proxyId)}
              disabled={importConfigurationLocked}
              onChange={(event) => {
                const value = event.target.value
                if (value === '__preserve__') setChatGptImport({ ...chatGptImport, proxyMode: 'preserve', proxyId: '' })
                else if (value === '__direct__') setChatGptImport({ ...chatGptImport, proxyMode: 'direct', proxyId: '' })
                else setChatGptImport({ ...chatGptImport, proxyMode: 'proxy', proxyId: value })
              }}
            >
              {accountAddMethod === 'token-json' && <option value="__preserve__">{t('不指定 / 沿用文件配置', 'Unspecified / Keep file configuration')}</option>}
              <option value="__direct__">{accountAddMethod === 'oauth' ? t('StonePlus 直连 / 全局出口设置', 'StonePlus direct / Global exit setting') : t('直连（清除文件代理）', 'Direct (clear file proxy)')}</option>
              {chatGptImport.proxyMode === 'proxy' && chatGptImport.proxyId && !proxyById.has(chatGptImport.proxyId)
                && <option value={chatGptImport.proxyId} disabled>{t('原选择已删除，请重新选择', 'The previous selection was deleted. Choose another.')}</option>}
              {snapshot.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxySafeSummary(proxy)}</option>)}
            </select>
            <small>{chatGptImport.proxyMode === 'preserve'
              ? t('保留文件中仍然存在的 proxyId；未配置或已失效时使用 StonePlus 全局出口设置。', 'Keep a proxyId from the file if it still exists; otherwise use the StonePlus global exit setting.')
              : chatGptImport.proxyMode === 'direct'
                ? accountAddMethod === 'oauth'
                  ? t('系统浏览器登录使用浏览器自身网络；StonePlus 仅对 Token 交换与后续检测使用此选项，并仍受 StonePlus 全局出口设置影响。', 'The system browser uses its own network. StonePlus applies this option only to token exchange and later checks, still subject to the global exit setting.')
                  : t('本批次账号移除文件代理；后续请求仍受 StonePlus 全局出口设置影响。', 'Remove file proxies from accounts in this batch. Later requests still use the StonePlus global exit setting.')
                : accountAddMethod === 'oauth'
                  ? t('系统浏览器登录使用浏览器自身网络；StonePlus 仅在 Token 交换与后续检测时使用所选代理。', 'The system browser uses its own network. StonePlus uses the selected proxy only for token exchange and later checks.')
                  : t('本批次所有账号统一使用所选代理；导入后的状态刷新与模型查询也通过该代理。', 'All accounts in this batch use the selected proxy, including post-import status refreshes and model queries.')}</small>
          </label>
          <label className="field field--full"><span>{t('账号名称（可选）', 'Account name (optional)')}</span><input value={chatGptImport.name} disabled={importConfigurationLocked} onChange={(event) => setChatGptImport({ ...chatGptImport, name: event.target.value })} placeholder={t('留空则使用账号邮箱', 'Leave blank to use the account email')} /></label>
            </div>
          </details>

          {accountAddMethod === 'oauth' ? <section className="oauth-account-flow field--full" role="tabpanel" aria-label={t('OAuth 授权添加账号', 'Add account using OAuth')}>
            {oauthStage === 'idle' || oauthStage === 'starting' ? <div className="oauth-account-flow__intro">
              <span className="oauth-account-flow__hero"><ShieldCheck size={25} /></span>
              <div><h3>{oauthStage === 'starting' ? t('正在创建安全授权会话', 'Creating a secure authorization session') : t('使用 OpenAI OAuth 添加 Codex 账号', 'Add a Codex account with OpenAI OAuth')}</h3><p>{oauthStage === 'starting' ? t('正在准备 PKCE 授权链接和本机回调监听…', 'Preparing the PKCE authorization link and local callback listener…') : t('点击开始后将在系统浏览器打开 OpenAI 登录页，授权成功后 StonePlus 会自动接收回调、保存账号并立即检测可用性。', 'Starting opens the OpenAI sign-in page in your system browser. After authorization, StonePlus receives the callback, saves the account, and checks availability.')}</p></div>
              {oauthStage === 'starting' ? <LoaderCircle className="spin" size={21} /> : <button className="button button--primary" type="button" onClick={() => void startChatGptOAuth()}><ShieldCheck size={16} />{t('开始 OAuth 授权', 'Start OAuth authorization')}</button>}
            </div> : null}

            {(oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging') && oauthSession ? <div className="oauth-account-flow__waiting">
              <div className="oauth-account-flow__status-heading"><div><span className="oauth-pulse"><span /></span><div><h3>{oauthStage === 'exchanging' ? t('正在交换 Token 并检测账号', 'Exchanging tokens and checking the account') : oauthStage === 'submitting' ? t('正在提交回调地址', 'Submitting callback URL') : t('等待 OpenAI 授权回调', 'Waiting for the OpenAI authorization callback')}</h3><p>{oauthStage === 'exchanging' ? t('回调已接收，请保持此窗口开启。', 'Callback received. Keep this window open.') : t('请在系统浏览器完成登录与授权。', 'Complete sign-in and authorization in your system browser.')}</p></div></div><Badge tone={oauthSession.loopbackListening ? 'success' : 'warning'}>{oauthSession.loopbackListening ? t('自动回调监听中', 'Listening for automatic callback') : t('需要手动回调', 'Manual callback required')}</Badge></div>
              <div className="oauth-session-status">
                <span><Link2 size={14} /><strong>{oauthSession.loopbackListening ? t('本机回调已就绪', 'Local callback ready') : t('本机端口不可用', 'Local port unavailable')}</strong><small>{oauthSession.redirectUri}</small></span>
                <span><Clock3 size={14} /><strong>{oauthExpiresInSeconds > 0 ? `${Math.floor(oauthExpiresInSeconds / 60)}:${String(oauthExpiresInSeconds % 60).padStart(2, '0')}` : t('即将过期', 'Expiring soon')}</strong><small>{t('授权会话剩余时间', 'Authorization session time remaining')}</small></span>
              </div>
              <div className="oauth-authorization-link"><span>{t('授权链接', 'Authorization link')}</span><div><input className="mono" readOnly value={oauthSession.authorizationUrl} aria-label={t('OpenAI OAuth 授权链接', 'OpenAI OAuth authorization link')} /><button className="icon-button" type="button" aria-label={t('复制 OAuth 授权链接', 'Copy OAuth authorization link')} title={t('复制授权链接', 'Copy authorization link')} onClick={() => void copyOAuthAuthorizationUrl()}>{oauthCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}</button></div></div>
              <div className="oauth-account-flow__actions"><button className="button button--primary" type="button" disabled={oauthOpenBusy || oauthStage === 'exchanging'} onClick={() => void openOAuthInSystemBrowser()}>{oauthOpenBusy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{t('在系统浏览器中打开', 'Open in system browser')}</button><button className="button button--secondary" type="button" onClick={() => void copyOAuthAuthorizationUrl()}><Copy size={16} />{t('复制链接', 'Copy link')}</button></div>
              {oauthOpenHint && <div className="oauth-inline-message"><CircleAlert size={14} />{oauthOpenHint}</div>}
              <div className="oauth-manual-callback">
                <div><strong>{t('浏览器没有自动返回？', 'Did the browser fail to return automatically?')}</strong><span>{t('从浏览器地址栏复制跳转后的完整 localhost 回调 URL，粘贴到下方。', 'Copy the complete localhost callback URL from the browser address bar and paste it below.')}</span></div>
                <textarea className="mono" rows={3} value={oauthCallbackUrl} disabled={oauthStage === 'submitting' || oauthStage === 'exchanging'} onChange={(event) => setOauthCallbackUrl(event.target.value)} placeholder={`${oauthSession.redirectUri}?code=...&state=...`} aria-label={t('完整 OAuth 回调 URL', 'Complete OAuth callback URL')} />
                <div><FieldError>{oauthCallbackError}</FieldError><button className="button button--secondary" type="button" disabled={!oauthCallbackUrl.trim() || oauthStage === 'submitting' || oauthStage === 'exchanging'} onClick={() => void submitOAuthCallback()}>{oauthStage === 'submitting' ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}{oauthStage === 'submitting' ? t('正在提交…', 'Submitting…') : t('提交完整回调 URL', 'Submit complete callback URL')}</button></div>
              </div>
            </div> : null}

            {oauthStage === 'success' && oauthResult ? <div className="oauth-account-flow__result oauth-account-flow__result--success">
              <span className="oauth-result-icon"><CheckCircle2 size={25} /></span><div><h3>{t('Codex 账号添加成功', 'Codex account added')}</h3><p>{t('授权凭据已安全保存，并完成账号状态与模型检测。', 'The credentials were saved securely, and the account status and models were checked.')}</p></div>
              <div className="oauth-result-stats"><span><small>{t('新增', 'Added')}</small><strong>{oauthResult.createdAccountIds.length}</strong></span><span><small>{t('更新', 'Updated')}</small><strong>{oauthResult.updatedAccountIds.length}</strong></span><span><small>{t('检测可用', 'Available')}</small><strong>{oauthResult.detectionResults.filter((item) => item.ok).length}</strong></span><span><small>{t('加入号池', 'Added to pool')}</small><strong>{oauthResult.assignmentSummary.poolMembersAdded}</strong></span></div>
              <div className="oauth-result-assignment"><Badge tone="info">{oauthResult.assignmentSummary.tagId ? tagById.get(oauthResult.assignmentSummary.tagId)?.name ?? t('已选 Tag', 'Selected tag') : t('未标记', 'Untagged')}</Badge><span>{oauthResult.assignmentSummary.poolId ? t(`已处理目标号池，新增 ${oauthResult.assignmentSummary.poolMembersAdded} 个成员`, `Target pool processed; ${oauthResult.assignmentSummary.poolMembersAdded} members added`) : t('本次未加入号池', 'Not added to a pool')}</span></div>
              {oauthResult.warnings.length > 0 && <div className="oauth-inline-message oauth-inline-message--warning"><CircleAlert size={14} />{localizeBackendMessages(oauthResult.warnings, language, t('导入警告', 'Import warning.')).join(' ')}</div>}
            </div> : null}

            {oauthStage === 'error' ? <div className="oauth-account-flow__result oauth-account-flow__result--error"><span className="oauth-result-icon"><CircleAlert size={25} /></span><div><h3>{t('OAuth 授权未完成', 'OAuth authorization incomplete')}</h3><p>{oauthError || t('授权会话已结束，请重新开始。', 'The authorization session ended. Start again.')}</p></div><button className="button button--secondary" type="button" onClick={() => void startChatGptOAuth()}><RefreshCw size={15} />{t('重试授权', 'Retry authorization')}</button><button className="text-button" type="button" onClick={() => switchAccountAddMethod('token-json')}>{t('改用 Token / JSON 导入', 'Use Token / JSON import instead')}</button></div> : null}
            {oauthStage === 'cancelled' ? <div className="oauth-account-flow__result oauth-account-flow__result--cancelled"><span className="oauth-result-icon"><XCircle size={25} /></span><div><h3>{t('本次授权已取消', 'Authorization cancelled')}</h3><p>{t('未保存任何 OAuth 回调或新账号，可以随时重新开始。', 'No OAuth callback or new account was saved. You can start again at any time.')}</p></div><button className="button button--secondary" type="button" onClick={() => void startChatGptOAuth()}><RefreshCw size={15} />{t('重新授权', 'Authorize again')}</button></div> : null}
          </section> : <section className="token-json-import field--full" role="tabpanel" aria-label={t('Token 或 JSON 导入账号', 'Import accounts using Token or JSON')}>
            <div className="account-file-import">
              <span className="account-file-import__icon"><Files size={20} /></span>
              <div><strong>{t('批量导入 CPA / Sub2API JSON', 'Batch import CPA / Sub2API JSON')}</strong><span>{t('在文件选择器中按 Ctrl 或 Shift 多选；自动补全缺失的 account_id，导入后立即刷新状态并查询可用模型。', 'Use Ctrl or Shift to select multiple files. Missing account_id values are filled automatically, then status and available models are refreshed.')}</span></div>
              <button className="button button--primary" type="button" disabled={fileImportBusy} onClick={() => void importChatGptFiles()}>
                {fileImportBusy ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}{fileImportBusy ? t('正在导入并检测…', 'Importing and checking…') : t('选择多个 JSON', 'Select multiple JSON files')}
              </button>
            </div>
            {fileImportBusy && importProgress && <ImportProgress progress={importProgress} />}
            <label className="field"><span>{t('粘贴 JSON / Token', 'Paste JSON / Token')}</span><textarea required className="mono" rows={10} value={chatGptImport.content} onChange={(event) => setChatGptImport({ ...chatGptImport, content: event.target.value })} placeholder={t('粘贴 CPA 对象、Sub2API 导出、数组、逐行 JSON 或 Access Token', 'Paste a CPA object, Sub2API export, array, JSON Lines, or access token')} /><small>{t('支持 snake_case、camelCase、Sub2API credentials 嵌套字段，以及从 JWT user_id 自动修复空 account_id。', 'Supports snake_case, camelCase, nested Sub2API credentials, and repairing an empty account_id from the JWT user_id.')}</small><FieldError>{errors.chatgptImport}</FieldError></label>
          </section>}
        </form>
      </Modal>

      <Modal
        open={providerModal}
        title={providerDraft.id ? (providerDraft.sourceType === 'official-api' ? t('编辑官方 API', 'Edit official API') : t('编辑中转站', 'Edit relay')) : (providerDraft.sourceType === 'official-api' ? t('添加官方 API', 'Add official API') : t('添加中转站', 'Add relay'))}
        onClose={() => setProviderModal(false)}
        width="large"
        footer={<><button type="button" className="button button--secondary" onClick={() => setProviderModal(false)}>{t('取消', 'Cancel')}</button><button type="button" className="button button--secondary" disabled={providerProbeBusy} onClick={() => void probeProvider()}>{providerProbeBusy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('测试连接', 'Test connection')}</button><button type="submit" form="provider-form" className="button button--primary" disabled={busyKeys.has('save-api-source')}>{busyKeys.has('save-api-source') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{t('保存来源', 'Save source')}</button></>}
      >
        <form id="provider-form" onSubmit={(event) => void submitProvider(event)}><ApiSourceForm draft={providerDraft} setDraft={setProviderDraft} proxies={snapshot.proxies} errors={errors} /></form>
        {(providerProbe || errors.sourceProbe) && <div className={`source-probe-result ${providerProbe?.ok ? 'source-probe-result--ok' : 'source-probe-result--error'}`}>
          <strong>{providerProbe?.ok ? t('连接验证通过', 'Connection verified') : t('连接验证未通过', 'Connection verification failed')}</strong>
          {providerProbe?.stages.map((stage) => {
            const localizedStage = localizeProviderProbeStage(stage, language)
            return <div key={stage.id}><Badge tone={stage.status === 'success' ? 'success' : stage.status === 'warning' ? 'warning' : stage.status === 'error' ? 'danger' : 'neutral'}>{providerProbeStatusLabel(stage, language)}</Badge><span><strong>{providerProbeStageLabel(stage, language)}</strong> · {localizedStage.message}</span>{stage.latencyMs !== undefined && <small>{durationLabel(stage.latencyMs)}</small>}</div>
          })}
          {providerProbe?.models.length ? <small>{t(`发现 ${providerProbe.models.length} 个模型`, `${providerProbe.models.length} models found`)}</small> : null}
          <FieldError>{errors.sourceProbe ?? (providerProbe?.error ? localizeBackendMessage(providerProbe.error, language, t('连接验证失败', 'Connection verification failed.')) : undefined)}</FieldError>
        </div>}
      </Modal>

      <Modal
        open={accountModal}
        title={accountDraft.id ? t('编辑账号', 'Edit account') : t('添加账号', 'Add account')}
        description={t('凭据将写入系统安全存储', 'The credential will be stored securely by the system.')}
        onClose={() => setAccountModal(false)}
        width="xlarge"
        footer={<><button type="button" className="button button--secondary" onClick={() => setAccountModal(false)}>{t('取消', 'Cancel')}</button><button type="submit" form="account-form" className="button button--primary" disabled={busyKeys.has('save-account')}>{busyKeys.has('save-account') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{t('保存账号', 'Save account')}</button></>}
      >
        <form id="account-form" onSubmit={(event) => void submitAccount(event)}><AccountForm draft={accountDraft} setDraft={setAccountDraft} providers={snapshot.providers} proxies={snapshot.proxies} account={editingAccount} editing={Boolean(accountDraft.id)} oauthAccount={editingAccount?.credentialType === 'chatgpt-oauth'} refreshingModels={accountModelsBusy} refreshDisabledReason={refreshModelsDisabledReason} onRefreshModels={() => void refreshEditingAccountModels()} onTestModel={accountDraft.id ? (model) => api.testAccountModel(accountDraft.id as string, model) : undefined} errors={errors} /></form>
      </Modal>

      <Modal
        open={aggregateModalOpen}
        title={aggregateDraft.id ? t('编辑聚合中转', 'Edit aggregate relay') : t('添加聚合中转', 'Add aggregate relay')}
        onClose={() => setAggregateModalOpen(false)}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={() => setAggregateModalOpen(false)}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" form="aggregate-relay-form" disabled={busyKeys.has('save-aggregate-relay')}>{busyKeys.has('save-aggregate-relay') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{t('保存聚合中转', 'Save aggregate relay')}</button></>}
      >
        <form id="aggregate-relay-form" className="form-grid" onSubmit={(event) => void submitAggregateRelay(event)}>
          <label className="field"><span>{t('显示名称', 'Display name')}</span><input autoFocus value={aggregateDraft.name} onChange={(event) => setAggregateDraft({ ...aggregateDraft, name: event.target.value })} placeholder={t('例如：Codex 多线路', 'e.g. Multi-route Codex')} /><FieldError>{errors.aggregateName}</FieldError></label>
          <label className="field"><span>{t('对外协议', 'Public protocol')}</span><select value={aggregateDraft.protocol} onChange={(event) => { const protocol = event.target.value as Protocol; setAggregateDraft({ ...aggregateDraft, protocol, members: aggregateDraft.members.filter((member) => providerById.get(snapshot.accounts.find((account) => account.id === member.accountId)?.providerId ?? '')?.protocol === protocol) }) }}>{protocols.map((protocol) => <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>)}</select></label>
          <div className="field field--full"><span>{t('调度策略', 'Scheduling strategy')}</span><div className="aggregate-strategy-grid">
            {([
              ['priority', '故障转移', 'Failover', '按成员顺序使用，失败时切换下一条', 'Use members in order and switch to the next after a failure'],
              ['round-robin', '按请求轮询', 'Round robin by request', '每次请求依次切换来源', 'Switch sources in order for each request'],
              ['weighted-round-robin', '平滑加权轮询', 'Smooth weighted round robin', '按成员权重平滑分配请求', 'Distribute requests smoothly by member weight'],
            ] as const).map(([strategy, name, nameEn, description, descriptionEn]) => <button type="button" className={aggregateDraft.strategy === strategy ? 'active' : ''} key={strategy} onClick={() => setAggregateDraft({ ...aggregateDraft, strategy })}><strong>{t(name, nameEn)}<InfoTip text={t(description, descriptionEn)} focusable={false} /></strong></button>)}
          </div></div>
          <div className="field field--full">
            <span>{t('API 来源成员', 'API source members')}</span>
            <div className="aggregate-member-picker">
              {snapshot.accounts.filter((account) => {
                if (account.credentialType === 'chatgpt-oauth') return false
                const provider = providerById.get(account.providerId)
                return (provider?.sourceType === 'official-api' || provider?.sourceType === 'relay') && provider.protocol === aggregateDraft.protocol
              }).map((account) => {
                const provider = providerById.get(account.providerId)
                const memberIndex = aggregateDraft.members.findIndex((member) => member.accountId === account.id)
                const member = memberIndex >= 0 ? aggregateDraft.members[memberIndex] : undefined
                return <div className={member ? 'selected' : ''} key={account.id}>
                  <button className="aggregate-member-picker__toggle" type="button" aria-pressed={Boolean(member)} aria-label={member ? t(`取消选择${provider?.name ?? account.name}`, `Deselect ${provider?.name ?? account.name}`) : t(`选择${provider?.name ?? account.name}`, `Select ${provider?.name ?? account.name}`)} onClick={() => toggleAggregateMember(account)}><span className="checkbox-mark" aria-hidden="true">{member && <CheckCircle2 size={13} />}</span><span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1)}</span><span><strong>{provider?.name}</strong><small>{account.maskedCredential} · {protocolLabels[aggregateDraft.protocol]}</small></span></button>
                  {member && <div className="aggregate-member-controls"><button type="button" title={t('上移', 'Move up')} disabled={memberIndex === 0} onClick={() => { const next = [...aggregateDraft.members]; [next[memberIndex - 1], next[memberIndex]] = [next[memberIndex], next[memberIndex - 1]]; updateAggregateMembers(next) }}>↑</button><button type="button" title={t('下移', 'Move down')} disabled={memberIndex === aggregateDraft.members.length - 1} onClick={() => { const next = [...aggregateDraft.members]; [next[memberIndex + 1], next[memberIndex]] = [next[memberIndex], next[memberIndex + 1]]; updateAggregateMembers(next) }}>↓</button><label>{t('权重', 'Weight')} <input type="number" min={1} max={100} value={member.weight} onChange={(event) => updateAggregateMembers(aggregateDraft.members.map((item) => item.accountId === member.accountId ? { ...item, weight: Number(event.target.value) } : item))} /></label><span>#{memberIndex + 1}</span></div>}
                </div>
              })}
              {!snapshot.accounts.some((account) => account.credentialType !== 'chatgpt-oauth' && providerById.get(account.providerId)?.protocol === aggregateDraft.protocol) && <div className="aggregate-member-picker__empty">{t('没有同协议的官方 API 或中转站，请先添加来源。', 'No official API or relay uses this protocol. Add a source first.')}</div>}
            </div>
            <FieldError>{errors.aggregateMembers}</FieldError>
          </div>
          <label className="field"><span>{t('失败重试次数', 'Failure retries')}</span><input type="number" min={0} max={10} value={aggregateDraft.maxRetries} onChange={(event) => setAggregateDraft({ ...aggregateDraft, maxRetries: Number(event.target.value) })} /></label>
          <label className="field"><span>{t('默认出口代理', 'Default exit proxy')}</span><select value={aggregateDraft.proxyId ?? ''} onChange={(event) => setAggregateDraft({ ...aggregateDraft, proxyId: event.target.value })}><option value="">{t('直连', 'Direct')}</option>{snapshot.proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}</select></label>
          <div className="field field--full inline-settings"><div><strong>{t('会话粘性', 'Session stickiness')}<InfoTip text={t('同一会话优先复用已分配来源，减少上下文和缓存命中波动。', 'Prefer the assigned source for the same session to reduce context and cache-hit variability.')} /></strong></div><button className={`toggle ${aggregateDraft.stickySessions ? 'toggle--on' : ''}`} role="switch" aria-label={t('会话粘性', 'Session stickiness')} aria-checked={aggregateDraft.stickySessions} type="button" onClick={() => setAggregateDraft({ ...aggregateDraft, stickySessions: !aggregateDraft.stickySessions })}><span /></button></div>
          {aggregateDraft.stickySessions && <label className="field"><span>{t('粘性时长（分钟）', 'Stickiness duration (minutes)')}</span><input type="number" min={1} max={1440} value={aggregateDraft.stickyTtlMinutes} onChange={(event) => setAggregateDraft({ ...aggregateDraft, stickyTtlMinutes: Number(event.target.value) })} /></label>}
        </form>
      </Modal>

      <Modal
        open={tagManagerOpen}
        title={t('管理账号 Tag', 'Manage account tags')}
        description={t('K12、Plus 与自定义 Tag 都可改名或删除；删除后相关账号变为未标记。', 'K12, Plus, and custom tags can be renamed or deleted. Accounts become untagged after deletion.')}
        onClose={() => { setTagManagerOpen(false); setTagDraft({ name: '' }) }}
        footer={<button className="button button--secondary" type="button" onClick={() => { setTagManagerOpen(false); setTagDraft({ name: '' }) }}>{t('完成', 'Done')}</button>}
      >
        <div className="tag-manager">
          <div className="tag-manager__create"><input autoFocus maxLength={24} value={tagDraft.name} onChange={(event) => setTagDraft({ ...tagDraft, name: event.target.value })} placeholder={tagDraft.id ? t('输入新名称', 'Enter a new name') : t('新建 Tag（最多 24 字符）', 'New tag (up to 24 characters)')} /><button className="button button--primary" type="button" disabled={!tagDraft.name.trim() || busyKeys.has('save-account-tag')} onClick={() => void saveTag()}>{tagDraft.id ? t('保存改名', 'Save rename') : t('新建 Tag', 'New tag')}</button>{tagDraft.id && <button className="button button--secondary" type="button" onClick={() => setTagDraft({ name: '' })}>{t('取消编辑', 'Cancel editing')}</button>}</div>
          <div className="tag-manager__list">
            {snapshot.accountTags.map((tag) => <div key={tag.id}><span className="account-tag-chip"><Tag size={12} />{tag.name}</span><span>{t(`${oauthAccounts.filter((account) => account.tagId === tag.id).length} 个账号`, `${oauthAccounts.filter((account) => account.tagId === tag.id).length} accounts`)}</span><button className="icon-button" type="button" title={t('改名', 'Rename')} onClick={() => setTagDraft({ id: tag.id, name: tag.name })}><Edit3 size={15} /></button><button className="icon-button icon-button--danger" type="button" title={t('删除', 'Delete')} onClick={() => setTagDeleteTarget(tag)}><Trash2 size={15} /></button></div>)}
            {!snapshot.accountTags.length && <div className="muted">{t('尚未创建 Tag', 'No tags created yet')}</div>}
          </div>
        </div>
      </Modal>

      <Modal
        open={tagAssignmentOpen}
        title={t('批量设置 Tag', 'Set tag in bulk')}
        description={t(`将 ${selectedAccountIds.length} 个已选账号设置为一个 Tag`, `Assign one tag to ${selectedAccountIds.length} selected accounts`)}
        onClose={() => setTagAssignmentOpen(false)}
        footer={<button className="button button--secondary" type="button" onClick={() => setTagAssignmentOpen(false)}>{t('取消', 'Cancel')}</button>}
      >
        <div className="tag-assignment-grid"><button type="button" onClick={() => void assignSelectedTag(null)}><span className="muted">—</span><strong>{t('未标记', 'Untagged')}</strong><small>{t('清空已有 Tag', 'Clear existing tag')}</small></button>{snapshot.accountTags.map((tag) => <button type="button" key={tag.id} onClick={() => void assignSelectedTag(tag.id)}><Tag size={16} /><strong>{tag.name}</strong><small>{t(`${oauthAccounts.filter((account) => account.tagId === tag.id).length} 个账号`, `${oauthAccounts.filter((account) => account.tagId === tag.id).length} accounts`)}</small></button>)}</div>
      </Modal>

      <CodexQuotaModal account={quotaAccount} api={api} runAction={runAction} busyKeys={busyKeys} onClose={() => setQuotaAccountId(null)} />

      <ConfirmDialog
        open={Boolean(tagDeleteTarget)}
        title={t('删除 Tag', 'Delete tag')}
        message={t(`确定删除“${tagDeleteTarget?.name ?? ''}”吗？${tagDeleteTarget ? ` ${oauthAccounts.filter((account) => account.tagId === tagDeleteTarget.id).length} 个账号将变为未标记。` : ''}`, `Delete “${tagDeleteTarget?.name ?? ''}”?${tagDeleteTarget ? ` ${oauthAccounts.filter((account) => account.tagId === tagDeleteTarget.id).length} accounts will become untagged.` : ''}`)}
        busy={busyKeys.has('delete-account-tag')}
        onCancel={() => setTagDeleteTarget(null)}
        onConfirm={() => void deleteTag()}
      />

      <ConfirmDialog
        open={Boolean(aggregateDeleteTarget)}
        title={t('删除聚合中转', 'Delete aggregate relay')}
        message={t(`确定删除“${aggregateDeleteTarget?.name ?? ''}”吗？被启用路由引用时将无法删除。`, `Delete “${aggregateDeleteTarget?.name ?? ''}”? It cannot be deleted while referenced by an enabled route.`)}
        busy={busyKeys.has('delete-aggregate-relay')}
        onCancel={() => setAggregateDeleteTarget(null)}
        onConfirm={() => void deleteAggregateRelay()}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        title={t('批量删除账号', 'Delete accounts in bulk')}
        message={t(`确定删除已选择的 ${selectedAccountIds.length} 个账号吗？这些账号会自动从所属号池移除，此操作无法撤销。`, `Delete the ${selectedAccountIds.length} selected accounts? They will be removed from their pools automatically. This cannot be undone.`)}
        busy={busyKeys.has('delete-accounts')}
        onCancel={() => setBulkDeleteOpen(false)}
        onConfirm={() => void confirmBulkDelete()}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.kind === 'provider' ? t('删除来源', 'Delete source') : t('删除账号', 'Delete account')}
        message={deleteTarget?.kind === 'account'
          ? t(`确定删除“${deleteTarget.name}”吗？该账号会自动从所属号池移除，此操作无法撤销。`, `Delete “${deleteTarget.name}”? It will be removed from its pools automatically. This cannot be undone.`)
          : t(`确定删除“${deleteTarget?.name ?? ''}”吗？此操作无法撤销。`, `Delete “${deleteTarget?.name ?? ''}”? This cannot be undone.`)}
        busy={busyKeys.has('delete-item')}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
