import { useEffect, useMemo, useState } from 'react'
import {
  Boxes,
  CheckCircle2,
  Edit3,
  Files,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react'
import type {
  AccountInput,
  AccountModelTestResult,
  AppSnapshot,
  GatewayApi,
  ModelPolicy,
  Protocol,
  ProviderDefinition,
  ProviderInput,
  ProviderKind,
  ProviderPreset,
  PublicAccount,
  PublicProxyDefinition,
} from '@shared/types'
import type { ActionRunner } from '../App'
import {
  AccountStatusBadge,
  Badge,
  ConfirmDialog,
  durationLabel,
  EmptyState,
  FieldError,
  Modal,
  PageHeader,
  protocolLabels,
  relativeTime,
} from '../ui'
import { ProxyManager } from './ProxyManager'
import { CodexQuotaCompact, CodexQuotaModal } from './CodexQuotaModal'
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

const protocols: Protocol[] = ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini']
const protocolsByKind: Record<ProviderKind, Protocol[]> = {
  anthropic: ['anthropic-messages'],
  openai: ['openai-responses', 'openai-chat'],
  google: ['gemini'],
  'openai-compatible': ['openai-responses', 'openai-chat'],
  'anthropic-compatible': ['anthropic-messages'],
  custom: protocols,
}
const kinds = Object.keys(providerKindLabels) as ProviderKind[]

type ProviderDraft = Omit<ProviderInput, 'models'> & { modelsText: string }
type AccountDraft = Omit<AccountInput, 'modelPolicy'> & { modelPolicy: ModelPolicy }

const emptyProvider: ProviderDraft = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: 'https://',
  protocol: 'openai-chat',
  modelsText: '',
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

function ProviderForm({
  draft,
  setDraft,
  errors,
}: {
  draft: ProviderDraft
  setDraft: (value: ProviderDraft) => void
  errors: Record<string, string>
}) {
  const availableProtocols = protocolsByKind[draft.kind]
  return (
    <div className="form-grid">
      <label className="field field--full">
        <span>显示名称</span>
        <input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：OpenAI 主线路" />
        <FieldError>{errors.name}</FieldError>
      </label>
      <label className="field">
        <span>供应商类型</span>
        <select value={draft.kind} onChange={(event) => {
          const kind = event.target.value as ProviderKind
          const supported = protocolsByKind[kind]
          setDraft({ ...draft, kind, protocol: supported.includes(draft.protocol) ? draft.protocol : supported[0] })
        }}>
          {kinds.map((kind) => <option value={kind} key={kind}>{providerKindLabels[kind]}</option>)}
        </select>
      </label>
      <label className="field">
        <span>上游协议</span>
        <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as Protocol })}>
          {availableProtocols.map((protocol) => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}
        </select>
      </label>
      <label className="field field--full">
        <span>基础地址</span>
        <input className="mono" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
        <FieldError>{errors.baseUrl}</FieldError>
      </label>
      <label className="field field--full">
        <span>目录模型（兼容）</span>
        <textarea value={draft.modelsText} onChange={(event) => setDraft({ ...draft, modelsText: event.target.value })} rows={4} placeholder={'gpt-5\ngpt-5-mini'} />
        <small>每行一个模型标识；仅在账号尚未单独刷新时作为兼容候选</small>
      </label>
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
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId)
  const catalogAccount = account?.providerId === draft.providerId ? account : undefined
  const catalog = catalogAccount
    ? accountModelCatalog(catalogAccount, selectedProvider?.models)
    : { models: selectedProvider?.models ?? [], source: 'provider-fallback' as const }
  const catalogNotice = catalog.source === 'provider-fallback'
    ? '当前显示供应商目录的兼容候选，尚未验证此账号。保存账号后请刷新可用模型。'
    : undefined
  return (
    <div className="form-grid">
      <label className="field">
        <span>所属供应商</span>
        <select autoFocus disabled={oauthAccount} value={draft.providerId} onChange={(event) => setDraft({ ...draft, providerId: event.target.value, modelPolicy: 'all', modelAllowlist: [] })}>
          <option value="">选择供应商</option>
          {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>
        <FieldError>{errors.providerId}</FieldError>
      </label>
      <label className="field">
        <span>账号名称</span>
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：日常开发" />
        <FieldError>{errors.name}</FieldError>
      </label>
      {!oauthAccount && <label className="field field--full">
        <span>API Key / Access Token</span>
        <div className="input-with-icon"><KeyRound size={16} /><input type="password" className="mono" value={draft.credential ?? ''} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} placeholder={editing ? '留空表示不更换凭据' : '输入上游凭据'} /></div>
        <FieldError>{errors.credential}</FieldError>
      </label>}
      {oauthAccount && <div className="form-context field--full"><KeyRound size={16} /><span>ChatGPT OAuth 凭据只能通过重新导入更新</span></div>}
      <label className="field">
        <span>优先级</span>
        <input type="number" min={1} max={999} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} />
        <small>数值越小越优先</small>
      </label>
      <label className="field field--full">
        <span>账号出口代理</span>
        <select value={draft.proxyId ?? ''} onChange={(event) => setDraft({ ...draft, proxyId: event.target.value })}>
          <option value="">使用号池默认（独立检测时直连）</option>
          {proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}
        </select>
        <small>账号覆盖优先于号池默认代理</small>
      </label>
      <label className="field">
        <span>调度权重</span>
        <input type="number" min={1} max={100} value={draft.weight} onChange={(event) => setDraft({ ...draft, weight: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>最大并发</span>
        <input type="number" min={1} max={100} value={draft.maxConcurrency} onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })} />
      </label>
      {selectedProvider && <div className="form-context field--full"><Server size={16} /><span>{protocolLabels[selectedProvider.protocol]}</span><code>{selectedProvider.baseUrl}</code></div>}
      <div className="field field--full">
        <ModelPolicyEditor
          title="开放模型"
          description="先拉取此账号实际可用的模型，再决定对号池开放哪些模型。"
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
          emptyMessage={catalog.source === 'account' ? '此账号没有返回可用模型。' : '供应商目录尚无兼容候选；保存账号后可直接刷新。'}
          emptySelectionMessage="已明确不开放任何模型；该账号不会承接号池模型请求。"
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
  const [tab, setTab] = useState<'accounts' | 'providers' | 'proxies'>('accounts')
  const [providerModal, setProviderModal] = useState(false)
  const [accountModal, setAccountModal] = useState(false)
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider)
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(makeAccountDraft(snapshot.providers[0]?.id))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'provider' | 'account'; id: string; name: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [wizard, setWizard] = useState({ presetId: '', providerName: '', accountName: '', credential: '' })
  const [chatGptImportOpen, setChatGptImportOpen] = useState(false)
  const [chatGptImport, setChatGptImport] = useState({ providerId: snapshot.providers.find((provider) => provider.kind === 'openai' && provider.protocol === 'openai-responses')?.id ?? '', name: '', content: '' })
  const [importNotice, setImportNotice] = useState('')
  const [fileImportBusy, setFileImportBusy] = useState(false)
  const [quotaAccountId, setQuotaAccountId] = useState<string | null>(null)

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const proxyById = useMemo(() => new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy])), [snapshot.proxies])
  const quotaAccount = quotaAccountId ? snapshot.accounts.find((account) => account.id === quotaAccountId) ?? null : null
  const editingAccount = accountDraft.id ? snapshot.accounts.find((account) => account.id === accountDraft.id) : undefined
  const accountModelsBusy = Boolean(accountDraft.id && busyKeys.has(`refresh-account-models-${accountDraft.id}`))
  const refreshModelsDisabledReason = !accountDraft.id
    ? '请先保存账号，再拉取此账号的可用模型。'
    : accountDraft.credential?.trim()
      ? '凭据有未保存的更改，请先保存账号。'
      : undefined
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

  const openProvider = (provider?: ProviderDefinition) => {
    setProviderDraft(provider ? {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      modelsText: provider.models.join('\n'),
    } : { ...emptyProvider })
    setErrors({})
    setProviderModal(true)
    setMenuOpen(null)
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
    if (!providerDraft.name.trim()) nextErrors.name = '请输入供应商名称'
    try { new URL(providerDraft.baseUrl) } catch { nextErrors.baseUrl = '请输入有效的 HTTP(S) 地址' }
    if (!/^https?:\/\//.test(providerDraft.baseUrl)) nextErrors.baseUrl = '地址必须以 http:// 或 https:// 开头'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-provider', () => api.saveProvider({
      id: providerDraft.id,
      name: providerDraft.name.trim(),
      kind: providerDraft.kind,
      baseUrl: providerDraft.baseUrl.replace(/\/$/, ''),
      protocol: providerDraft.protocol,
      models: providerDraft.modelsText.split(/[\n,]/).map((model) => model.trim()).filter(Boolean),
    }))
    if (success) setProviderModal(false)
  }

  const submitAccount = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const existingAccount = accountDraft.id
      ? snapshot.accounts.find((account) => account.id === accountDraft.id)
      : undefined
    if (!accountDraft.providerId) nextErrors.providerId = '请选择供应商'
    if (!accountDraft.name.trim()) nextErrors.name = '请输入账号名称'
    if (!accountDraft.id && !accountDraft.credential?.trim()) nextErrors.credential = '首次添加需要填写凭据'
    if (existingAccount && existingAccount.providerId !== accountDraft.providerId && !accountDraft.credential?.trim()) {
      nextErrors.credential = '更换供应商时必须填写该供应商的新凭据'
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
      ? api.deleteProvider(deleteTarget.id)
      : api.deleteAccount(deleteTarget.id))
    if (success) setDeleteTarget(null)
  }

  const openWizard = async () => {
    const available = await api.listProviderPresets()
    const preset = available[0]
    setPresets(available)
    setWizard({ presetId: preset?.id ?? '', providerName: preset?.name ?? '', accountName: 'Primary', credential: '' })
    setWizardOpen(true)
  }

  const selectPreset = (presetId: string) => {
    const preset = presets.find((candidate) => candidate.id === presetId)
    setWizard((current) => ({ ...current, presetId, providerName: preset?.name ?? current.providerName }))
  }

  const submitWizard = async (event: React.FormEvent) => {
    event.preventDefault()
    const success = await runAction('onboard-provider', () => api.onboardProvider(wizard))
    if (success) setWizardOpen(false)
  }

  const submitChatGptImport = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const result = await api.importChatGptAccounts(chatGptImport)
      setChatGptImportOpen(false)
      setChatGptImport({ ...chatGptImport, content: '' })
      setImportNotice(`导入完成：新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个 ChatGPT/Codex 账号${result.warnings.length ? `；${result.warnings.join(' ')}` : ''}`)
    } catch (cause) {
      setErrors({ chatgptImport: cause instanceof Error ? cause.message : 'ChatGPT 账号导入失败' })
    }
  }

  const importChatGptFiles = async () => {
    if (!chatGptImport.providerId) {
      setErrors({ chatgptImport: '批量导入前请选择 OpenAI Responses Provider' })
      return
    }
    setFileImportBusy(true)
    setErrors({})
    try {
      const result = await api.importChatGptAccountFiles({ providerId: chatGptImport.providerId })
      if (result.cancelled) return
      setChatGptImportOpen(false)
      const importedFiles = result.fileResults.filter((file) => file.status === 'imported').length
      const failedFiles = result.fileResults.filter((file) => file.status === 'failed')
      const detected = result.detectionResults.filter((item) => item.ok).length
      const detectionFailed = result.detectionResults.length - detected
      const details = [
        `批量导入完成：选择 ${result.selectedFiles} 个文件，成功 ${importedFiles} 个，失败 ${failedFiles.length} 个`,
        `新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个账号`,
        `检测可用 ${detected} 个，检测失败 ${detectionFailed} 个`,
        ...failedFiles.slice(0, 3).map((file) => `${file.fileName}：${file.error ?? '导入失败'}`),
        ...result.detectionResults.filter((item) => !item.ok).slice(0, 3).map((item) => `${item.accountName}：${item.error ?? '检测失败'}`),
        ...result.warnings.slice(0, 3),
      ]
      setImportNotice(details.join('；'))
    } catch (cause) {
      setErrors({ chatgptImport: cause instanceof Error ? cause.message : 'CPA / Sub2API 文件导入失败' })
    } finally {
      setFileImportBusy(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="供应商与账号"
        description="管理上游端点、模型能力和本地凭据"
        actions={
          tab === 'proxies' ? undefined : <>
            <button type="button" className="button button--secondary" onClick={() => void openWizard()}><CheckCircle2 size={16} /> 接入向导</button>
            <button type="button" className="button button--secondary" onClick={() => { setErrors({}); setChatGptImportOpen(true) }}><KeyRound size={16} /> 导入 ChatGPT 账号</button>
            <button type="button" className="button button--secondary" onClick={() => openProvider()}><Server size={16} /> 添加供应商</button>
            <button type="button" className="button button--primary" onClick={() => openAccount()} disabled={!snapshot.providers.length}><Plus size={16} /> 添加账号</button>
          </>
        }
      />

      <div className="segmented-control" role="tablist" aria-label="供应商管理视图">
        <button type="button" role="tab" aria-selected={tab === 'accounts'} className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>
          账号 <span>{snapshot.accounts.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'providers'} className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
          供应商 <span>{snapshot.providers.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'proxies'} className={tab === 'proxies' ? 'active' : ''} onClick={() => setTab('proxies')}>
          <Network size={15} />出口代理 <span>{snapshot.proxies.length}</span>
        </button>
      </div>
      {importNotice && <div className="client-config-notice"><CheckCircle2 size={16} />{importNotice}</div>}

      {tab === 'accounts' ? (
        <section className="panel panel--flush">
          {snapshot.accounts.length ? (
            <div className="table-wrap">
              <table className="data-table accounts-table">
                <thead><tr><th>账号</th><th>状态</th><th>凭据</th><th>并发</th><th>额度</th><th>延迟</th><th>最近使用</th><th aria-label="操作" /></tr></thead>
                <tbody>
                  {snapshot.accounts.map((account) => {
                    const provider = providerById.get(account.providerId)
                    const checking = busyKeys.has(`check-${account.id}`) || account.status === 'checking'
                    const refreshingModels = busyKeys.has(`refresh-account-models-${account.id}`)
                    const openModels = effectiveAccountModels(account, provider?.models)
                    const modelSummary = isAccountModelWildcard(account)
                      ? '待刷新 · 兼容通配'
                      : account.modelsRefreshedAt === undefined
                        ? `待刷新 · 开放 ${openModels.length} 个模型`
                        : `开放 ${openModels.length} 个模型`
                    return (
                      <tr key={account.id}>
                        <td><div className="provider-cell"><span className="provider-avatar" style={{ '--provider-color': provider?.color ?? '#61736f' } as React.CSSProperties}>{provider?.name.slice(0, 1) ?? '?'}</span><div><strong>{account.name}</strong><span>{provider?.name ?? '供应商已删除'}{account.proxyId ? ` · ${proxyById.get(account.proxyId)?.name ?? '代理已删除'}` : ''} · {modelSummary}</span></div></div></td>
                        <td><AccountStatusBadge status={account.status} circuitState={account.circuitState} />{account.credentialType === 'chatgpt-oauth' && <span className="row-note">ChatGPT OAuth · {account.renewable ? '可续期' : '会话到期即停用'}</span>}{Boolean(account.consecutiveFailures) && <span className="row-note">连续失败 {account.consecutiveFailures}</span>}{account.lastError && <span className="row-note row-note--danger" title={account.lastError}>{account.lastError}</span>}</td>
                        <td><span className="mono masked-key">{account.maskedCredential}</span></td>
                        <td><div className="concurrency-cell"><strong>{account.inFlight} / {account.maxConcurrency}</strong><div className="mini-progress"><span style={{ width: `${Math.min(100, account.inFlight / account.maxConcurrency * 100)}%` }} /></div></div></td>
                        <td>{account.credentialType === 'chatgpt-oauth'
                          ? <CodexQuotaCompact quota={account.codexQuota} onClick={() => setQuotaAccountId(account.id)} />
                          : account.quotaRemaining !== undefined ? <strong>{account.quotaUnit === 'usd' ? `$${account.quotaRemaining.toFixed(2)}` : `${account.quotaRemaining}${account.quotaUnit === 'percent' ? '%' : ''}`}</strong> : <span className="muted">未知</span>}</td>
                        <td>{account.latencyMs ? durationLabel(account.latencyMs) : '—'}</td>
                        <td>{relativeTime(account.lastUsedAt)}</td>
                        <td className="actions-cell">
                          <button className="icon-button" type="button" title="刷新此账号的可用模型" disabled={refreshingModels} onClick={() => void runAction(`refresh-account-models-${account.id}`, () => api.refreshAccountModels(account.id))}>{refreshingModels ? <LoaderCircle size={16} className="spin" /> : <Boxes size={16} />}</button>
                          <button className="icon-button" type="button" title="检测账号" disabled={checking} onClick={() => void runAction(`check-${account.id}`, () => api.checkAccount(account.id))}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button>
                          <div className="menu-wrap">
                            <button className="icon-button" type="button" title="更多操作" onClick={() => setMenuOpen(menuOpen === account.id ? null : account.id)}><MoreHorizontal size={18} /></button>
                            {menuOpen === account.id && <div className="context-menu"><button type="button" onClick={() => openAccount(account)}><Edit3 size={15} />编辑</button><button className="danger" type="button" onClick={() => { setDeleteTarget({ kind: 'account', id: account.id, name: account.name }); setMenuOpen(null) }}><Trash2 size={15} />删除</button></div>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<KeyRound size={24} />}
              title="尚未添加账号"
              description={snapshot.providers.length ? '添加一个上游凭据后即可加入号池' : '请先建立供应商端点，再添加访问凭据'}
              action={snapshot.providers.length
                ? <button className="button button--primary" type="button" onClick={() => openAccount()}><Plus size={16} />添加账号</button>
                : <button className="button button--primary" type="button" onClick={() => { setTab('providers'); openProvider() }}><Server size={16} />添加供应商</button>}
            />
          )}
        </section>
      ) : tab === 'providers' ? (
        snapshot.providers.length ? (
          <div className="provider-grid">
            {snapshot.providers.map((provider) => {
              const count = snapshot.accounts.filter((account) => account.providerId === provider.id).length
              return (
                <article className="provider-card" key={provider.id}>
                  <div className="provider-card__top">
                    <span className="provider-avatar provider-avatar--large" style={{ '--provider-color': provider.color ?? '#61736f' } as React.CSSProperties}>{provider.name.slice(0, 1)}</span>
                    <div><h2>{provider.name}</h2><span>{providerKindLabels[provider.kind]}</span></div>
                    <div className="menu-wrap">
                      <button className="icon-button" type="button" title="供应商操作" onClick={() => setMenuOpen(menuOpen === provider.id ? null : provider.id)}><MoreHorizontal size={18} /></button>
                      {menuOpen === provider.id && <div className="context-menu"><button type="button" onClick={() => openProvider(provider)}><Edit3 size={15} />编辑</button><button className="danger" type="button" onClick={() => { setDeleteTarget({ kind: 'provider', id: provider.id, name: provider.name }); setMenuOpen(null) }}><Trash2 size={15} />删除</button></div>}
                    </div>
                  </div>
                  <div className="provider-card__endpoint"><span>基础地址</span><code>{provider.baseUrl}</code></div>
                  <div className="provider-card__meta"><Badge tone="info">{protocolLabels[provider.protocol]}</Badge><span><KeyRound size={14} />{count} 个账号</span><span><Boxes size={14} />{provider.models.length} 个模型</span></div>
                  <div className="model-tags">
                    {provider.models.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                    {provider.models.length > 3 && <span>+{provider.models.length - 3}</span>}
                    {!provider.models.length && <span className="muted">未限制模型</span>}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <section className="panel"><EmptyState icon={<Server size={24} />} title="尚未配置供应商" description="先建立一个上游端点，再添加访问凭据" action={<button className="button button--primary" type="button" onClick={() => openProvider()}><Plus size={16} />添加供应商</button>} /></section>
        )
      ) : <ProxyManager snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />}

      <Modal
        open={chatGptImportOpen}
        title="导入 ChatGPT / Codex 账号"
        description="支持 CPA、Sub2API 导出和 Codex OAuth session JSON；Stone+ 会加密保存 Token。"
        onClose={() => setChatGptImportOpen(false)}
        width="large"
        closable={!fileImportBusy}
        footer={<><button className="button button--secondary" type="button" disabled={fileImportBusy} onClick={() => setChatGptImportOpen(false)}>取消</button><button className="button button--primary" type="submit" form="chatgpt-account-import" disabled={fileImportBusy}><KeyRound size={16} />粘贴内容导入</button></>}
      >
        <form id="chatgpt-account-import" className="form-grid" onSubmit={(event) => void submitChatGptImport(event)}>
          <label className="field field--full"><span>OpenAI Responses Provider</span><select required value={chatGptImport.providerId} onChange={(event) => setChatGptImport({ ...chatGptImport, providerId: event.target.value })}><option value="">选择 Provider</option>{snapshot.providers.filter((provider) => provider.kind === 'openai' && provider.protocol === 'openai-responses').map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><small>没有可选项时，先用接入向导创建 OpenAI Provider。</small></label>
          <div className="account-file-import field--full">
            <span className="account-file-import__icon"><Files size={20} /></span>
            <div><strong>批量导入 CPA / Sub2API JSON</strong><span>在文件选择器中按 Ctrl 或 Shift 多选；自动补全缺失的 account_id，导入后立即并发检测账号。</span></div>
            <button className="button button--secondary" type="button" disabled={fileImportBusy || !chatGptImport.providerId} onClick={() => void importChatGptFiles()}>
              {fileImportBusy ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}{fileImportBusy ? '正在导入并检测…' : '选择多个 JSON'}
            </button>
          </div>
          <label className="field field--full"><span>账号名称（可选）</span><input value={chatGptImport.name} onChange={(event) => setChatGptImport({ ...chatGptImport, name: event.target.value })} placeholder="留空则使用账号邮箱" /></label>
          <label className="field field--full"><span>粘贴 JSON / Token</span><textarea required className="mono" rows={10} value={chatGptImport.content} onChange={(event) => setChatGptImport({ ...chatGptImport, content: event.target.value })} placeholder={'粘贴 CPA 对象、Sub2API 导出、数组、逐行 JSON 或 Access Token'} /><small>支持 snake_case、camelCase、Sub2API credentials 嵌套字段，以及从 JWT user_id 自动修复空 account_id。</small><FieldError>{errors.chatgptImport}</FieldError></label>
        </form>
      </Modal>

      <Modal
        open={wizardOpen}
        title="供应商接入向导"
        description="选择常用厂商模板，一次创建供应商和首个账号。"
        onClose={() => setWizardOpen(false)}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={() => setWizardOpen(false)}>取消</button><button className="button button--primary" type="submit" form="provider-wizard" disabled={busyKeys.has('onboard-provider')}><CheckCircle2 size={16} />完成接入</button></>}
      >
        <form id="provider-wizard" className="form-grid" onSubmit={(event) => void submitWizard(event)}>
          <label className="field field--full"><span>厂商模板</span><select autoFocus value={wizard.presetId} onChange={(event) => selectPreset(event.target.value)}>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {protocolLabels[preset.protocol]}</option>)}</select></label>
          <label className="field"><span>供应商名称</span><input required value={wizard.providerName} onChange={(event) => setWizard({ ...wizard, providerName: event.target.value })} /></label>
          <label className="field"><span>账号名称</span><input required value={wizard.accountName} onChange={(event) => setWizard({ ...wizard, accountName: event.target.value })} /></label>
          <label className="field field--full"><span>API Key / Access Token</span><input required type="password" className="mono" value={wizard.credential} onChange={(event) => setWizard({ ...wizard, credential: event.target.value })} /></label>
          {presets.find((preset) => preset.id === wizard.presetId) && <div className="form-context field--full"><Server size={16} /><span>{presets.find((preset) => preset.id === wizard.presetId)?.baseUrl}</span></div>}
        </form>
      </Modal>

      <Modal
        open={providerModal}
        title={providerDraft.id ? '编辑供应商' : '添加供应商'}
        description="配置上游端点与原生协议"
        onClose={() => setProviderModal(false)}
        footer={<><button type="button" className="button button--secondary" onClick={() => setProviderModal(false)}>取消</button><button type="submit" form="provider-form" className="button button--primary" disabled={busyKeys.has('save-provider')}>{busyKeys.has('save-provider') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}保存供应商</button></>}
      >
        <form id="provider-form" onSubmit={(event) => void submitProvider(event)}><ProviderForm draft={providerDraft} setDraft={setProviderDraft} errors={errors} /></form>
      </Modal>

      <Modal
        open={accountModal}
        title={accountDraft.id ? '编辑账号' : '添加账号'}
        description="凭据将写入系统安全存储"
        onClose={() => setAccountModal(false)}
        width="xlarge"
        footer={<><button type="button" className="button button--secondary" onClick={() => setAccountModal(false)}>取消</button><button type="submit" form="account-form" className="button button--primary" disabled={busyKeys.has('save-account')}>{busyKeys.has('save-account') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}保存账号</button></>}
      >
        <form id="account-form" onSubmit={(event) => void submitAccount(event)}><AccountForm draft={accountDraft} setDraft={setAccountDraft} providers={snapshot.providers} proxies={snapshot.proxies} account={editingAccount} editing={Boolean(accountDraft.id)} oauthAccount={editingAccount?.credentialType === 'chatgpt-oauth'} refreshingModels={accountModelsBusy} refreshDisabledReason={refreshModelsDisabledReason} onRefreshModels={() => void refreshEditingAccountModels()} onTestModel={accountDraft.id ? (model) => api.testAccountModel(accountDraft.id as string, model) : undefined} errors={errors} /></form>
      </Modal>

      <CodexQuotaModal account={quotaAccount} api={api} runAction={runAction} busyKeys={busyKeys} onClose={() => setQuotaAccountId(null)} />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除${deleteTarget?.kind === 'provider' ? '供应商' : '账号'}`}
        message={`确定删除“${deleteTarget?.name ?? ''}”吗？此操作无法撤销。`}
        busy={busyKeys.has('delete-item')}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
