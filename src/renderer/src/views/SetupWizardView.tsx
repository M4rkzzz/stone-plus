import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Cloud,
  Copy,
  ExternalLink,
  FileJson2,
  Files,
  Gauge,
  KeyRound,
  Link2,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  Router,
  Server,
  Settings2,
  ShieldCheck,
  Tag,
  Waypoints,
  XCircle,
} from 'lucide-react'
import type {
  ApiSourceInput,
  ApiSourceProbeResult,
  AppSnapshot,
  ChatGptAccountImportResult,
  ChatGptOAuthSessionStart,
  GatewayApi,
  ProviderKind,
  Protocol,
  RouteClient,
  SetupRoutingResult,
  SetupRouteVerificationResult,
  SetupSourceMethod,
  SetupWizardProgressInput,
  SetupWizardState,
  SetupWizardStep,
} from '@shared/types'
import { Badge, protocolLabels } from '../ui'
import { confirmSetupWizardAction, persistSetupWizardSourceProxy } from '../setup-wizard-operations'
import '../setup-wizard.css'

type SourceMode = 'existing' | 'oauth-import' | 'official-api' | 'relay' | 'aggregate'
type AccountAddMethod = 'oauth' | 'token-json'
type OAuthUiStage = 'idle' | 'starting' | 'waiting' | 'submitting' | 'exchanging' | 'cancelling' | 'success' | 'error' | 'cancelled'
type WizardProgressPatch = Omit<SetupWizardProgressInput, 'sessionId' | 'step'>

const steps: Array<{ id: SetupWizardStep; label: string }> = [
  { id: 'scan', label: '环境扫描' },
  { id: 'source', label: '选择来源' },
  { id: 'source-config', label: '配置来源' },
  { id: 'network', label: '网络出口' },
  { id: 'upstream-test', label: '上游验证' },
  { id: 'client', label: '选择客户端' },
  { id: 'routing', label: '号池与路由' },
  { id: 'gateway', label: '启动网关' },
  { id: 'verify', label: '端到端验证' },
  { id: 'client-config', label: '客户端配置' },
  { id: 'complete', label: '完成' },
]

const clientLabels: Record<RouteClient, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
}

const emptyApiSource = (sourceType: 'official-api' | 'relay'): ApiSourceInput => ({
  name: '',
  sourceType,
  kind: sourceType === 'official-api' ? 'openai' : 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  protocol: 'openai-responses',
  credential: '',
  models: [],
  defaultModel: '',
  priority: 10,
  weight: 10,
  maxConcurrency: 4,
  proxyId: '',
})

export function SetupWizardView({
  snapshot,
  api,
  onExit,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  onExit: () => void
}) {
  const [wizard, setWizard] = useState<SetupWizardState | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>('existing')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [aggregatePoolId, setAggregatePoolId] = useState('')
  const [sourceDraft, setSourceDraft] = useState<ApiSourceInput>(() => emptyApiSource('official-api'))
  const [accountAddMethod, setAccountAddMethod] = useState<AccountAddMethod>('oauth')
  const [accountName, setAccountName] = useState('')
  const [importContent, setImportContent] = useState('')
  const [tagId, setTagId] = useState<string | null>(null)
  const [newTagName, setNewTagName] = useState('')
  const [poolId, setPoolId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState('')
  const [probe, setProbe] = useState<ApiSourceProbeResult | null>(null)
  const [model, setModel] = useState('')
  const [client, setClient] = useState<RouteClient>('codex')
  const [routing, setRouting] = useState<SetupRoutingResult | null>(null)
  const [verification, setVerification] = useState<SetupRouteVerificationResult | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [oauthStage, setOauthStage] = useState<OAuthUiStage>('idle')
  const [oauthSession, setOauthSession] = useState<ChatGptOAuthSessionStart | null>(null)
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('')
  const [oauthCallbackError, setOauthCallbackError] = useState('')
  const [oauthError, setOauthError] = useState('')
  const [oauthOpenHint, setOauthOpenHint] = useState('')
  const [oauthOpenBusy, setOauthOpenBusy] = useState(false)
  const [oauthCopied, setOauthCopied] = useState(false)
  const [oauthCommitLocked, setOauthCommitLocked] = useState(false)
  const [oauthNow, setOauthNow] = useState(Date.now())
  const [oauthImportedSnapshot, setOauthImportedSnapshot] = useState<AppSnapshot | null>(null)
  const oauthSessionIdRef = useRef<string | null>(null)
  const oauthAttemptRef = useRef(0)

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const selectedAccount = oauthImportedSnapshot?.accounts.find((account) => account.id === selectedAccountId)
    ?? snapshot.accounts.find((account) => account.id === selectedAccountId)
  const selectedProvider = selectedAccount
    ? oauthImportedSnapshot?.providers.find((provider) => provider.id === selectedAccount.providerId)
      ?? providerById.get(selectedAccount.providerId)
    : undefined
  const compatiblePools = snapshot.pools.filter((pool) => pool.kind === 'standard' && pool.protocol === 'openai-responses')
  const aggregatePools = snapshot.pools.filter((pool) => pool.kind === 'relay-aggregate')
  const currentStep = wizard?.step ?? 'scan'
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === currentStep))
  const oauthActive = oauthStage === 'starting' || oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging' || oauthStage === 'cancelling'
  const importConfigurationLocked = oauthActive || busy === 'import'
  const oauthExpiresInSeconds = oauthSession ? Math.max(0, Math.ceil((oauthSession.expiresAt - oauthNow) / 1_000)) : 0
  const modelOptions = useMemo(() => {
    const values = new Set<string>()
    for (const item of probe?.models ?? []) values.add(item)
    for (const item of selectedAccount?.availableModels ?? []) values.add(item)
    for (const item of selectedProvider?.models ?? []) values.add(item)
    for (const item of sourceDraft.models) values.add(item)
    if (sourceDraft.defaultModel) values.add(sourceDraft.defaultModel)
    return [...values]
  }, [probe, selectedAccount, selectedProvider, sourceDraft])

  useEffect(() => {
    let cancelled = false
    void api.getSetupWizardState()
      .then(async (saved) => {
        if (cancelled) return
        const next = saved ?? await api.saveSetupWizardProgress({ step: 'scan' })
        if (!cancelled) {
          setWizard(next)
          setSelectedAccountId(next.sourceId ?? '')
          setTagId(next.tagId ?? null)
          setPoolId(next.poolId ?? null)
          setProxyId(next.proxyId ?? '')
          setModel(next.model ?? '')
          setClient(next.client ?? 'codex')
          const restoredMode = sourceModeFromProgress(next.sourceMethod, next.sourceType, next.sourceId)
          setSourceMode(restoredMode)
          setAccountAddMethod(next.sourceMethod === 'token-json' ? 'token-json' : 'oauth')
          if (next.sourceMethod === 'aggregate' && next.poolId) setAggregatePoolId(next.poolId)
        }
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(''))
    return () => { cancelled = true }
  }, [api])

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
    if (!model && modelOptions.length) setModel(modelOptions[0])
  }, [model, modelOptions])

  const run = async <T,>(key: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      return await operation()
    } catch (cause) {
      setError(messageOf(cause))
      return undefined
    } finally {
      setBusy('')
    }
  }

  const move = async (step: SetupWizardStep, patch: WizardProgressPatch = {}): Promise<SetupWizardState | undefined> => {
    const next = await run('progress', () => api.saveSetupWizardProgress({
      sessionId: wizard?.sessionId,
      step,
      sourceType: patch.sourceType ?? wizard?.sourceType,
      sourceMethod: patch.sourceMethod !== undefined ? patch.sourceMethod : wizard?.sourceMethod,
      sourceId: patch.sourceId !== undefined ? patch.sourceId : selectedAccountId || wizard?.sourceId,
      tagId: patch.tagId !== undefined ? patch.tagId : tagId,
      poolId: patch.poolId !== undefined ? patch.poolId : poolId,
      routeId: patch.routeId !== undefined ? patch.routeId : wizard?.routeId,
      client: patch.client ?? client,
      model: patch.model ?? (model || wizard?.model),
      proxyId: patch.proxyId !== undefined ? patch.proxyId : proxyId || null,
      lastError: patch.lastError,
    }))
    if (next) setWizard(next)
    return next
  }

  const back = async () => {
    if (currentIndex <= 0) return
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    await move(steps[currentIndex - 1].id)
  }

  const exitWizard = async () => {
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    onExit()
  }

  const scan = async () => {
    const report = await run('scan', () => api.runNetworkDiagnostics(proxyId ? { proxyId } : {}))
    if (!report) return
    setNotice(report.summary === 'error'
      ? '基础网络存在异常，仍可继续并在网络步骤选择出口代理。'
      : '环境扫描完成，可以开始选择来源。')
    await move('source')
  }

  const chooseMode = (mode: SourceMode) => {
    setSourceMode(mode)
    if (mode === 'oauth-import') setAccountAddMethod('oauth')
    setSelectedAccountId('')
    setAggregatePoolId('')
    setProbe(null)
    setVerification(null)
    setOauthImportedSnapshot(null)
    if (mode === 'official-api' || mode === 'relay') setSourceDraft(emptyApiSource(mode))
    const sourceMethod: SetupSourceMethod = mode === 'oauth-import' ? 'oauth' : mode
    void move('source-config', {
      sourceMethod,
      sourceId: null,
      sourceType: mode === 'oauth-import' ? 'oauth-system' : mode === 'official-api' || mode === 'relay' ? mode : undefined,
    })
  }

  const selectExisting = async () => {
    if (!selectedAccountId) return setError('请选择一个已有来源。')
    const account = snapshot.accounts.find((candidate) => candidate.id === selectedAccountId)
    if (!account) return setError('选择的来源已不存在。')
    const provider = providerById.get(account.providerId)
    const nextProxyId = account.proxyId ?? ''
    const nextModel = model || account.availableModels[0] || provider?.models[0] || ''
    setProxyId(nextProxyId)
    setModel(nextModel)
    await move('network', {
      sourceMethod: 'existing',
      sourceId: account.id,
      sourceType: provider?.sourceType,
      proxyId: nextProxyId || null,
      model: nextModel || undefined,
    })
  }

  const selectAggregate = async () => {
    const pool = snapshot.pools.find((candidate) => candidate.id === aggregatePoolId && candidate.kind === 'relay-aggregate')
    if (!pool) return setError('请选择一个聚合中转。')
    const first = pool.members.find((member) => member.enabled)
    if (!first) return setError('聚合中转没有启用成员。')
    setSelectedAccountId(first.accountId)
    setPoolId(pool.id)
    const nextProxyId = pool.proxyId ?? ''
    setProxyId(nextProxyId)
    const nextModel = model || pool.modelAllowlist[0] || ''
    setModel(nextModel)
    await move('network', { sourceMethod: 'aggregate', sourceId: first.accountId, poolId: pool.id, sourceType: 'relay', proxyId: nextProxyId || null, model: nextModel || undefined })
  }

  const clearOAuthUi = () => {
    setOauthStage('idle')
    setOauthSession(null)
    setOauthCallbackUrl('')
    setOauthCallbackError('')
    setOauthError('')
    setOauthOpenHint('')
    setOauthOpenBusy(false)
    setOauthCopied(false)
    setOauthCommitLocked(false)
  }

  const cancelWizardOAuth = async (): Promise<boolean> => {
    if (oauthCommitLocked) {
      setOauthOpenHint('授权结果正在保存并检测账号，此阶段不可退出，请等待完成。')
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
        setOauthOpenHint('授权结果已进入 Token 保存与账号检测阶段，现在不能退出，请等待完成。')
        return false
      }
      oauthAttemptRef.current += 1
      oauthSessionIdRef.current = null
      setOauthSession(null)
      setOauthCommitLocked(false)
      setOauthCallbackUrl('')
      setOauthCallbackError('')
      setOauthStage('cancelled')
      return true
    } catch (cause) {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) {
        setOauthStage(resumeStage)
        setOauthOpenHint(cause instanceof Error ? `取消失败：${cause.message}` : '取消失败，请稍后重试。')
      }
      return false
    }
  }

  const finishOAuthImport = async (result: ChatGptAccountImportResult) => {
    const healthy = result.detectionResults.find((item) => item.ok)
    const accountId = healthy?.accountId ?? result.importedAccountIds[0]
    if (!accountId) throw new Error('OAuth 授权完成，但没有生成可继续配置的账号。')
    const account = result.snapshot.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('OAuth 账号已保存，但返回结果中缺少账号详情。')
    const provider = result.snapshot.providers.find((candidate) => candidate.id === account.providerId)
    const nextModel = account.availableModels[0] ?? provider?.models[0] ?? model
    const assignment = result.assignmentSummary
    setOauthImportedSnapshot(result.snapshot)
    setSelectedAccountId(accountId)
    setTagId(assignment.tagId)
    setPoolId(assignment.poolId)
    setModel(nextModel)
    setOauthStage('success')
    const detected = result.detectionResults.filter((item) => item.ok).length
    const selectedTag = assignment.tagId ? result.snapshot.accountTags.find((item) => item.id === assignment.tagId)?.name ?? '已选 Tag' : '未标记'
    setNotice(`OAuth 添加完成：新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个，检测可用 ${detected} 个；Tag：${selectedTag}${assignment.poolMembersAdded ? `；加入号池 ${assignment.poolMembersAdded} 个` : ''}${assignment.poolAppendError ? `；号池追加失败：${assignment.poolAppendError}` : ''}${result.warnings.length ? `；${result.warnings.join(' ')}` : ''}`)
    await move('network', {
      sourceMethod: 'oauth',
      sourceType: 'oauth-system',
      sourceId: accountId,
      tagId: assignment.tagId,
      poolId: assignment.poolId,
      proxyId: proxyId || null,
      model: nextModel || undefined,
    })
  }

  const waitForChatGptOAuth = async (session: ChatGptOAuthSessionStart, attempt: number) => {
    try {
      const result = await api.waitChatGptOAuth(session.sessionId)
      if (oauthAttemptRef.current !== attempt) return
      oauthSessionIdRef.current = null
      setOauthCommitLocked(false)
      setOauthError('')
      setOauthCallbackError('')
      await finishOAuthImport(result)
    } catch (cause) {
      if (oauthAttemptRef.current !== attempt) return
      oauthSessionIdRef.current = null
      setOauthCommitLocked(false)
      setOauthError(cause instanceof Error ? cause.message : 'OAuth 授权未完成，请重试。')
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
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenHint('已在系统浏览器中打开授权页面。')
    } catch (cause) {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenHint(cause instanceof Error ? cause.message : '无法打开系统浏览器，请复制链接后手动打开。')
    } finally {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenBusy(false)
    }
  }

  const startWizardOAuth = async () => {
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    const saved = await move('source-config', {
      sourceMethod: 'oauth',
      sourceType: 'oauth-system',
      sourceId: null,
      tagId,
      poolId,
      proxyId: proxyId || null,
    })
    if (!saved) return
    oauthAttemptRef.current += 1
    const attempt = oauthAttemptRef.current
    setOauthStage('starting')
    setOauthSession(null)
    setOauthError('')
    setOauthCallbackError('')
    setOauthCallbackUrl('')
    setOauthOpenHint('')
    setOauthOpenBusy(false)
    setOauthCopied(false)
    setOauthCommitLocked(false)
    try {
      const session = await api.startChatGptOAuth({
        name: accountName.trim() || undefined,
        tagId,
        poolId,
        proxyMode: proxyId ? 'proxy' : 'direct',
        proxyId: proxyId || undefined,
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
      setOauthError(cause instanceof Error ? cause.message : '无法启动 OAuth 授权。')
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
      setOauthOpenHint('授权链接已复制。')
    } catch {
      if (oauthAttemptRef.current !== attempt || oauthSessionIdRef.current !== sessionId) return
      setOauthOpenHint('复制失败，请手动选择授权链接。')
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
      setOauthCallbackError(cause instanceof Error ? cause.message : '回调地址提交失败。')
      setOauthStage('waiting')
    }
  }

  const switchAccountAddMethod = async (method: AccountAddMethod) => {
    if (method === accountAddMethod || importConfigurationLocked) return
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    clearOAuthUi()
    setAccountAddMethod(method)
    await move('source-config', { sourceMethod: method })
  }

  const importTokenJson = async (files: boolean) => {
    const saved = await move('source-config', {
      sourceMethod: 'token-json',
      sourceType: 'oauth-system',
      sourceId: null,
      tagId,
      poolId,
      proxyId: proxyId || null,
    })
    if (!saved) return
    const result = await run('import', () => files
      ? api.importChatGptAccountFiles({ tagId, poolId, proxyMode: proxyId ? 'proxy' : 'direct', proxyId: proxyId || undefined })
      : api.importChatGptAccounts({ content: importContent, name: accountName.trim() || undefined, tagId, poolId, proxyMode: proxyId ? 'proxy' : 'direct', proxyId: proxyId || undefined }))
    if (!result || ('cancelled' in result && result.cancelled)) return
    const healthy = result.detectionResults.find((item) => item.ok)
    const accountId = healthy?.accountId ?? result.importedAccountIds[0]
    if (!accountId) return setError('没有导入可用账号。')
    const account = result.snapshot.accounts.find((candidate) => candidate.id === accountId)
    const provider = account ? result.snapshot.providers.find((candidate) => candidate.id === account.providerId) : undefined
    setOauthImportedSnapshot(result.snapshot)
    setSelectedAccountId(accountId)
    setModel(account?.availableModels[0] ?? provider?.models[0] ?? '')
    setNotice(`已导入 ${result.importedAccountIds.length} 个账号，检测成功 ${result.detectionResults.filter((item) => item.ok).length} 个，Tag 更新 ${result.assignmentSummary.tagUpdatedAccountCount} 个，加入号池 ${result.assignmentSummary.poolMembersAdded} 个。${result.assignmentSummary.poolAppendError ? ` 号池追加失败：${result.assignmentSummary.poolAppendError}` : ''}`)
    await move('network', { sourceMethod: 'token-json', sourceId: accountId, sourceType: 'oauth-system', tagId, poolId, proxyId: proxyId || null })
  }

  const createImportTag = async () => {
    const name = newTagName.trim()
    if (!name) return setError('请输入 Tag 名称。')
    const result = await run('create-tag', () => api.saveAccountTag({ name }))
    if (!result) return
    const created = [...result.accountTags]
      .filter((tag) => tag.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
      .sort((left, right) => right.createdAt - left.createdAt)[0]
    if (created) {
      setTagId(created.id)
      await move('source-config', { sourceMethod: accountAddMethod, tagId: created.id })
    }
    setNewTagName('')
  }

  const applyOfficialVendor = (kind: ProviderKind) => {
    const presets: Record<'openai' | 'anthropic' | 'google', Pick<ApiSourceInput, 'kind' | 'baseUrl' | 'protocol' | 'name'>> = {
      openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', name: 'OpenAI API' },
      anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', name: 'Anthropic API' },
      google: { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini', name: 'Google Gemini API' },
    }
    if (kind !== 'openai' && kind !== 'anthropic' && kind !== 'google') return
    setSourceDraft((current) => ({ ...current, ...presets[kind] }))
  }

  const probeDraft = async () => {
    if (!sourceDraft.name.trim() || !sourceDraft.baseUrl.trim() || !sourceDraft.credential?.trim()) {
      return setError('请填写名称、Base URL 和 API Key。')
    }
    const result = await run('probe', () => api.probeApiSource({
      id: sourceDraft.id,
      name: sourceDraft.name,
      sourceType: sourceDraft.sourceType,
      kind: sourceDraft.kind,
      baseUrl: sourceDraft.baseUrl,
      protocol: sourceDraft.protocol,
      credential: sourceDraft.credential,
      model: model || sourceDraft.defaultModel,
      proxyId: proxyId || sourceDraft.proxyId,
    }))
    if (!result) return
    setProbe(result)
    if (!model && result.models.length) setModel(result.models[0])
    if (result.ok) setNotice('来源验证通过，可以安全保存。')
  }

  const saveDraft = async () => {
    if (!probe?.ok) return setError('配置向导要求先完成一次真实上游验证。')
    const result = await run('save-source', () => api.saveApiSource({
      ...sourceDraft,
      proxyId: proxyId || sourceDraft.proxyId,
      defaultModel: model || sourceDraft.defaultModel,
      models: probe.models.length ? probe.models : sourceDraft.models,
    }))
    if (!result) return
    const provider = sourceDraft.id
      ? result.providers.find((candidate) => candidate.id === sourceDraft.id)
      : [...result.providers]
        .filter((candidate) => candidate.sourceType === sourceDraft.sourceType && candidate.name === sourceDraft.name.trim())
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    const account = provider ? result.accounts.find((candidate) => candidate.providerId === provider.id) : undefined
    if (!account) return setError('来源已保存，但未找到对应凭据账号。')
    setSelectedAccountId(account.id)
    await move('network', { sourceId: account.id, sourceType: sourceDraft.sourceType, proxyId: account.proxyId })
  }

  const checkNetwork = async () => {
    const report = await run('network', () => api.runNetworkDiagnostics(proxyId ? { proxyId } : {}))
    if (!report) return
    if (report.summary === 'error') return setError(report.diagnoses[0] ?? '当前网络出口不可用。')
    if (!selectedAccount) return setError('来源账号不存在。')
    const aggregate = aggregatePoolId
      ? snapshot.pools.find((pool) => pool.id === aggregatePoolId && pool.kind === 'relay-aggregate')
      : undefined
    const updated = await run('network', () => persistSetupWizardSourceProxy(api, selectedAccount, proxyId, aggregate))
    if (updated === undefined) return
    if (updated) setOauthImportedSnapshot(updated)
    setNotice(report.summary === 'warning' ? '网络部分项目有警告，可继续验证来源。' : '网络出口可用。')
    await move('upstream-test', { proxyId: proxyId || undefined })
  }

  const verifyExistingSource = async () => {
    if (!selectedAccountId) return setError('来源账号不存在。')
    const checked = await run('upstream', async () => {
      await api.checkAccount(selectedAccountId)
      if (!model) {
        const refreshed = await api.refreshAccountModels(selectedAccountId)
        const account = refreshed.accounts.find((candidate) => candidate.id === selectedAccountId)
        const provider = account ? refreshed.providers.find((candidate) => candidate.id === account.providerId) : undefined
        const discovered = account?.availableModels[0] ?? provider?.models[0]
        if (discovered) setModel(discovered)
        return discovered ? api.testAccountModel(selectedAccountId, discovered) : Promise.reject(new Error('没有可用于真实测试的模型。'))
      }
      return api.testAccountModel(selectedAccountId, model)
    })
    if (!checked) return
    if (!checked.ok) return setError(checked.responsePreview || '上游真实请求未通过。')
    setNotice(`上游验证成功，耗时 ${checked.latencyMs} ms。`)
    await move('client', { sourceId: selectedAccountId, model: checked.model })
  }

  const createRouting = async () => {
    if (!wizard?.sessionId || !selectedAccountId || !model) return setError('缺少来源、模型或向导会话。')
    const result = await run('routing', () => api.applySetupRouting({
      sessionId: wizard.sessionId,
      sourceId: selectedAccountId,
      client,
      model,
      aggregatePoolId: aggregatePoolId || (snapshot.pools.find((pool) => pool.id === poolId)?.kind === 'relay-aggregate' ? poolId ?? undefined : undefined),
    }))
    if (!result) return
    setRouting(result)
    setPoolId(result.poolId)
    await move('gateway', { poolId: result.poolId, routeId: result.routeId, client, model })
  }

  const startGateway = async () => {
    const result = await run('gateway', () => api.ensureGatewayRunning({ host: snapshot.gateway.host, port: snapshot.gateway.port }))
    if (!result) return
    setNotice(`网关已监听 http://${result.host}:${result.port}${result.changedPort ? '（原端口被占用，已改用可用端口）' : ''}`)
    await move('verify')
  }

  const verifyRoute = async () => {
    if (!model) return setError('请选择测试模型。')
    const result = await run('verify', () => api.verifySetupRoute({ client, model }))
    if (!result) return
    setVerification(result)
    if (!result.ok) return setError(result.error ?? '端到端请求失败。')
    setNotice(`本地端到端请求成功，耗时 ${result.latencyMs} ms。`)
    await move('client-config')
  }

  const previewClient = async () => {
    const result = await run('preview-client', () => api.previewClientConfig(client))
    if (!result) return
    setPreviewText(result.files.map((file) => `${file.path}\n${file.changed ? `将更新：${file.managedFields.join('、') || '受管配置'}` : '无需更改'}`).join('\n\n'))
  }

  const applyClient = async () => {
    const result = await run('apply-client', () => api.applyClientConfig(client))
    if (!result) return
    setNotice(result.changedFiles.length ? `已更新 ${result.changedFiles.length} 个客户端配置文件并创建备份。` : '客户端配置已经正确。')
    await finish()
  }

  const finish = async () => {
    if (!wizard?.sessionId || (wizard.step !== 'client-config' && !verification?.ok)) return setError('必须先完成端到端验证。')
    const completed = await run('finish', () => confirmSetupWizardAction(() => api.completeSetupWizard(wizard.sessionId)))
    if (!completed) return
    setWizard((current) => current ? { ...current, step: 'complete', completed: true } : current)
  }

  const discard = async () => {
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    const discarded = await run('discard', () => confirmSetupWizardAction(() => api.discardSetupWizard()))
    if (!discarded) return
    onExit()
  }

  return (
    <div className="setup-wizard page-stack">
      <header className="setup-wizard__header">
        <div><span className="eyebrow">STONE+ QUICK START</span><h1>配置向导</h1><p>逐步完成来源、号池、路由和真实请求验证。</p></div>
        <button className="button button--secondary" type="button" disabled={oauthCommitLocked} onClick={() => void exitWizard()}>{oauthCommitLocked ? '正在保存账号…' : '暂时退出'}</button>
      </header>

      <div className="setup-wizard__layout">
        <aside className="setup-wizard__steps" aria-label="配置步骤">
          {steps.map((item, index) => <div className={`${index === currentIndex ? 'active' : ''} ${index < currentIndex ? 'done' : ''}`} key={item.id}>
            <span>{index < currentIndex ? <CheckCircle2 size={15} /> : index + 1}</span><strong>{item.label}</strong>
          </div>)}
        </aside>

        <main className="setup-wizard__content">
          {error && <div className="setup-message setup-message--error"><CircleAlert size={17} /><span>{error}</span></div>}
          {notice && <div className="setup-message setup-message--success"><CheckCircle2 size={17} /><span>{notice}</span></div>}

          {currentStep === 'scan' && <WizardSection icon={<Gauge />} title="先检查当前环境" description="扫描本地配置、网络出口和已有资源，不会修改任何文件。">
            <ScanSummary snapshot={snapshot} />
            <PrimaryAction busy={busy === 'scan'} onClick={() => void scan()} label="开始扫描" icon={<RefreshCw size={16} />} />
          </WizardSection>}

          {currentStep === 'source' && <WizardSection icon={<Waypoints />} title="你准备使用什么来源？" description="可以导入订阅账号、添加 API，也可以复用已有配置。">
            <div className="setup-choice-grid">
              <Choice icon={<ShieldCheck />} title="Codex OAuth / Sub2API CPA" description="浏览器 OAuth 授权，或使用 Token / JSON 兼容导入" onClick={() => chooseMode('oauth-import')} />
              <Choice icon={<Cloud />} title="官方 API" description="OpenAI、Anthropic 或 Google Gemini" onClick={() => chooseMode('official-api')} />
              <Choice icon={<Server />} title="中转站" description="配置兼容 Base URL 与单把 Key" onClick={() => chooseMode('relay')} />
              <Choice icon={<KeyRound />} title="已有来源" description={`${snapshot.accounts.length} 个可调度凭据`} onClick={() => chooseMode('existing')} disabled={!snapshot.accounts.length} />
              <Choice icon={<Network />} title="已有聚合中转" description={`${aggregatePools.length} 个聚合配置`} onClick={() => chooseMode('aggregate')} disabled={!aggregatePools.length} />
            </div>
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'existing' && <WizardSection icon={<KeyRound />} title="选择已有来源" description="向导会重新检查账号状态和模型。">
            <select className="setup-select" value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}>
              <option value="">选择来源</option>
              {snapshot.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {providerById.get(account.providerId)?.name}</option>)}
            </select>
            <PrimaryAction disabled={!selectedAccountId} busy={false} onClick={() => void selectExisting()} label="使用此来源" />
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'aggregate' && <WizardSection icon={<Network />} title="选择聚合中转" description="路由将直接复用聚合中转的成员和策略。">
            <select className="setup-select" value={aggregatePoolId} onChange={(event) => setAggregatePoolId(event.target.value)}>
              <option value="">选择聚合中转</option>
              {aggregatePools.map((pool) => <option value={pool.id} key={pool.id}>{pool.name} · {protocolLabels[pool.protocol]} · {pool.members.length} 个成员</option>)}
            </select>
            <PrimaryAction disabled={!aggregatePoolId} busy={false} onClick={() => void selectAggregate()} label="使用此聚合" />
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'oauth-import' && <WizardSection icon={<ShieldCheck />} title="添加 Codex 账号" description="先完成 OAuth 授权或选择 JSON 文件；账号归类与网络设置可在下方按需展开。">
            <div className="setup-account-method-tabs" role="tablist" aria-label="Codex 账号添加方式">
              <button type="button" role="tab" aria-selected={accountAddMethod === 'oauth'} className={accountAddMethod === 'oauth' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => void switchAccountAddMethod('oauth')}><ShieldCheck size={18} /><span><strong>OAuth 授权</strong><small>系统浏览器登录，推荐</small></span></button>
              <button type="button" role="tab" aria-selected={accountAddMethod === 'token-json'} className={accountAddMethod === 'token-json' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => void switchAccountAddMethod('token-json')}><Files size={18} /><span><strong>Token / JSON</strong><small>Sub2API / CPA 兼容导入</small></span></button>
            </div>

            <details className="setup-account-shared">
              <summary><div><strong>账号归类与网络（可选）</strong><span>截图中的“备注”已适配为 Stone+ Tag，授权和导入使用相同设置。</span></div><span className="setup-account-shared__summary-side">{importConfigurationLocked && <Badge tone="info">授权期间已锁定</Badge>}<ChevronDown size={17} /></span></summary>
              <div className="setup-account-shared__body">
              <div className="setup-form-grid">
                <label><span><Tag size={13} />账号 Tag（代替备注）</span><select value={tagId ?? ''} disabled={importConfigurationLocked} onChange={(event) => { const value = event.target.value || null; setTagId(value); void move('source-config', { sourceMethod: accountAddMethod, tagId: value }) }}><option value="">未标记</option>{snapshot.accountTags.map((tag) => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select><small>同一账号仅使用一个 Tag；未标记会清空重复账号原 Tag。</small></label>
                <label><span>导入后加入号池（可选）</span><select value={poolId ?? ''} disabled={importConfigurationLocked} onChange={(event) => { const value = event.target.value || null; setPoolId(value); void move('source-config', { sourceMethod: accountAddMethod, poolId: value }) }}><option value="">不加入号池</option>{compatiblePools.map((pool) => <option value={pool.id} key={pool.id}>{pool.name} · {pool.members.length} 个成员 · {pool.strategy}</option>)}</select><small>仅列出普通 OpenAI Responses 号池；只加入检测成功账号。</small></label>
                <label className="full"><span>快速新建 Tag</span><div className="setup-inline-create"><input maxLength={24} disabled={importConfigurationLocked} value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="自定义 Tag" /><button className="button button--secondary" type="button" disabled={importConfigurationLocked || !newTagName.trim() || Boolean(busy)} onClick={() => void createImportTag()}>{busy === 'create-tag' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}新建并选中</button></div></label>
                <label><span>{accountAddMethod === 'oauth' ? 'Token 交换与后续检测出口' : '出口代理'}</span><select value={proxyId} disabled={importConfigurationLocked} onChange={(event) => { const value = event.target.value; setProxyId(value); void move('source-config', { sourceMethod: accountAddMethod, proxyId: value || null }) }}><option value="">Stone 直连 / 全局出口设置</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}</select><small>{accountAddMethod === 'oauth' ? '系统浏览器使用自身网络；此选择只用于 Token 交换、检测和后续上游请求。' : '所选出口用于导入后的账号检测和后续上游请求。'}</small></label>
                <label><span>账号名称（可选）</span><input value={accountName} disabled={importConfigurationLocked} onChange={(event) => setAccountName(event.target.value)} placeholder="留空则使用账号邮箱" /></label>
              </div>
              </div>
            </details>

            {accountAddMethod === 'oauth' ? <section className="setup-oauth-flow" role="tabpanel" aria-label="OAuth 授权添加账号">
              {(oauthStage === 'idle' || oauthStage === 'starting') && <div className="setup-oauth-intro"><span><ShieldCheck size={24} /></span><div><h3>{oauthStage === 'starting' ? '正在创建安全授权会话' : '使用 OpenAI OAuth 添加 Codex 账号'}</h3><p>{oauthStage === 'starting' ? '正在准备 PKCE 授权链接和本机回调监听…' : 'Stone+ 会在系统浏览器打开 OpenAI 登录页；授权成功后自动保存、检测，并进入网络出口步骤。'}</p></div>{oauthStage === 'starting' ? <LoaderCircle size={20} className="spin" /> : <button className="button button--primary" type="button" onClick={() => void startWizardOAuth()}><ShieldCheck size={16} />开始 OAuth 授权</button>}</div>}

              {(oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging' || oauthStage === 'cancelling') && oauthSession && <div className="setup-oauth-waiting">
                <div className="setup-oauth-heading"><div><span className="setup-oauth-pulse" /><div><h3>{oauthStage === 'exchanging' ? '正在交换 Token 并检测账号' : oauthStage === 'submitting' ? '正在提交回调地址' : oauthStage === 'cancelling' ? '正在取消授权' : '等待 OpenAI 授权回调'}</h3><p>{oauthStage === 'exchanging' ? '回调已接收，请保持向导开启。' : '请在系统浏览器完成登录与授权。'}</p></div></div><Badge tone={oauthSession.loopbackListening ? 'success' : 'warning'}>{oauthSession.loopbackListening ? '自动回调监听中' : '需要手工回调'}</Badge></div>
                <div className="setup-oauth-status"><span><Link2 size={14} /><strong>{oauthSession.loopbackListening ? '本机回调已就绪' : '本机端口不可用'}</strong><small>{oauthSession.redirectUri}</small></span><span><Clock3 size={14} /><strong>{oauthExpiresInSeconds > 0 ? `${Math.floor(oauthExpiresInSeconds / 60)}:${String(oauthExpiresInSeconds % 60).padStart(2, '0')}` : '即将过期'}</strong><small>授权会话剩余时间</small></span></div>
                <label className="setup-oauth-link"><span>授权链接</span><div><input className="mono" readOnly value={oauthSession.authorizationUrl} /><button className="icon-button" type="button" aria-label="复制 OAuth 授权链接" onClick={() => void copyOAuthAuthorizationUrl()}>{oauthCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}</button></div></label>
                <div className="setup-actions"><button className="button button--secondary" type="button" disabled={oauthStage === 'cancelling' || oauthCommitLocked} onClick={() => void cancelWizardOAuth()}>{oauthStage === 'cancelling' || oauthCommitLocked ? <LoaderCircle size={16} className="spin" /> : <XCircle size={16} />}{oauthCommitLocked ? '正在保存（不可取消）' : oauthStage === 'cancelling' ? '正在取消…' : '取消授权'}</button><button className="button button--primary" type="button" disabled={oauthOpenBusy || oauthStage !== 'waiting'} onClick={() => void openOAuthInSystemBrowser()}>{oauthOpenBusy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{oauthOpenBusy ? '正在打开…' : '打开系统浏览器'}</button></div>
                {oauthOpenHint && <div className="setup-oauth-message"><CircleAlert size={14} /><span>{oauthOpenHint}</span></div>}
                <div className="setup-oauth-callback"><div><strong>浏览器没有自动返回？</strong><span>复制跳转后的完整 localhost 回调 URL，粘贴到下方继续。</span></div><textarea className="mono" rows={3} value={oauthCallbackUrl} disabled={oauthStage !== 'waiting'} onChange={(event) => setOauthCallbackUrl(event.target.value)} placeholder={`${oauthSession.redirectUri}?code=...&state=...`} aria-label="完整 OAuth 回调 URL" /><div>{oauthCallbackError && <small className="danger">{oauthCallbackError}</small>}<button className="button button--secondary" type="button" disabled={!oauthCallbackUrl.trim() || oauthStage !== 'waiting'} onClick={() => void submitOAuthCallback()}><Link2 size={15} />提交完整回调 URL</button></div></div>
              </div>}

              {oauthStage === 'error' && <div className="setup-oauth-result setup-oauth-result--error"><CircleAlert size={24} /><div><h3>OAuth 授权未完成</h3><p>{oauthError || '授权会话已结束，请重新开始。'}</p></div><button className="button button--secondary" type="button" onClick={() => void startWizardOAuth()}><RefreshCw size={15} />重试授权</button><button className="text-button" type="button" onClick={() => void switchAccountAddMethod('token-json')}>改用 Token / JSON</button></div>}
              {oauthStage === 'success' && <div className="setup-oauth-result setup-oauth-result--success"><CheckCircle2 size={24} /><div><h3>Codex 账号已保存</h3><p>账号、Tag 与号池设置已完成，正在进入网络出口检查。</p></div></div>}
              {oauthStage === 'cancelled' && <div className="setup-oauth-result"><XCircle size={24} /><div><h3>本次授权已取消</h3><p>未保存回调或新账号，可以重新授权或返回上一步。</p></div><button className="button button--secondary" type="button" onClick={() => void startWizardOAuth()}><RefreshCw size={15} />重新授权</button></div>}
            </section> : <section className="setup-token-import" role="tabpanel" aria-label="Token 或 JSON 导入账号">
              <div className="setup-token-import__heading"><Files size={20} /><div><strong>导入 Sub2API / CPA</strong><span>支持多文件、JSON、逐行 JSON 和 Access Token；完成后立即检测并进入网络出口步骤。</span></div><button className="button button--primary" disabled={Boolean(busy)} type="button" onClick={() => void importTokenJson(true)}><FileJson2 size={16} />选择多个 JSON</button></div>
              <label className="setup-field"><span>粘贴 JSON / Token</span><textarea className="mono" rows={9} value={importContent} onChange={(event) => setImportContent(event.target.value)} placeholder="粘贴 CPA 对象、Sub2API 导出、数组、逐行 JSON 或 Access Token" /></label>
              <PrimaryAction disabled={!importContent.trim()} busy={busy === 'import'} onClick={() => void importTokenJson(false)} label="导入并检测" />
            </section>}
          </WizardSection>}

          {currentStep === 'source-config' && (sourceMode === 'official-api' || sourceMode === 'relay') && <WizardSection icon={<Server />} title={sourceMode === 'official-api' ? '配置官方 API' : '配置中转站'} description="先完成真实请求测试，再保存到本机安全存储。">
            <ApiSourceForm draft={sourceDraft} proxyId={proxyId} proxies={snapshot.proxies} onProxyChange={setProxyId} onChange={setSourceDraft} onVendor={applyOfficialVendor} official={sourceMode === 'official-api'} />
            {probe && <ProbeResult result={probe} />}
            <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void probeDraft()}>{busy === 'probe' ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}测试连接</button><PrimaryAction disabled={!probe?.ok} busy={busy === 'save-source'} onClick={() => void saveDraft()} label="保存并继续" /></div>
          </WizardSection>}

          {currentStep === 'network' && <WizardSection icon={<Router />} title="检查网络出口" description="使用来源配置的实际出口运行网络诊断。">
            <label className="setup-field"><span>出口代理</span><select value={proxyId} onChange={(event) => setProxyId(event.target.value)}><option value="">直连 / 跟随全局网络设置</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}</select></label>
            <PrimaryAction busy={busy === 'network'} onClick={() => void checkNetwork()} label="检测此出口" icon={<Network size={16} />} />
          </WizardSection>}

          {currentStep === 'upstream-test' && <WizardSection icon={<ShieldCheck />} title="验证账号与模型" description="这一步会发送一次极小的真实模型请求。">
            <ModelChoice value={model} options={modelOptions} onChange={setModel} />
            <PrimaryAction busy={busy === 'upstream'} onClick={() => void verifyExistingSource()} label="发送真实测试" icon={<Play size={16} />} />
          </WizardSection>}

          {currentStep === 'client' && <WizardSection icon={<Settings2 />} title="选择主客户端" description="向导一次配置一个客户端，完成后可以继续配置其他客户端。">
            <div className="setup-choice-grid setup-choice-grid--clients">{(['codex', 'claude', 'gemini'] as RouteClient[]).map((item) => <Choice key={item} title={clientLabels[item]} description={item === 'codex' ? '推荐用于 OAuth / Responses 来源' : `通过 Stone 协议转换接入 ${clientLabels[item]}`} selected={client === item} onClick={() => setClient(item)} />)}</div>
            <PrimaryAction busy={false} onClick={() => void move('routing', { client, model })} label="继续配置路由" />
          </WizardSection>}

          {currentStep === 'routing' && <WizardSection icon={<Waypoints />} title="创建号池与路由" description="Stone 会原子创建或复用号池，并启用对应客户端路由。">
            <SummaryRows rows={[['来源', selectedAccount?.name ?? selectedAccountId], ['客户端', clientLabels[client]], ['模型', model || '未选择'], ['目标号池', snapshot.pools.find((pool) => pool.id === (aggregatePoolId || poolId))?.name ?? '自动创建或复用']]} />
            <PrimaryAction busy={busy === 'routing'} onClick={() => void createRouting()} label="应用号池与路由" />
          </WizardSection>}

          {currentStep === 'gateway' && <WizardSection icon={<Server />} title="启动本地网关" description="默认监听 127.0.0.1:15721；端口冲突时会选择相邻可用端口。">
            <SummaryRows rows={[['监听地址', `${snapshot.gateway.host}:${snapshot.gateway.port}`], ['当前状态', snapshot.gatewayStatus.running ? '运行中' : '已停止'], ['号池', routing?.poolId ?? poolId ?? '已配置']]} />
            <PrimaryAction busy={busy === 'gateway'} onClick={() => void startGateway()} label="确保网关运行" />
          </WizardSection>}

          {currentStep === 'verify' && <WizardSection icon={<Play />} title="完成端到端真实请求" description="验证本地鉴权、路由、调度、协议转换和上游响应。">
            <ModelChoice value={model} options={modelOptions} onChange={setModel} />
            {verification && <SummaryRows rows={[['结果', verification.ok ? '成功' : '失败'], ['耗时', `${verification.latencyMs} ms`], ['响应', verification.responsePreview ?? verification.error ?? '—']]} />}
            <PrimaryAction busy={busy === 'verify'} onClick={() => void verifyRoute()} label="运行端到端验证" />
          </WizardSection>}

          {currentStep === 'client-config' && <WizardSection icon={<Settings2 />} title="连接客户端（可选）" description="可以先预览并备份配置，也可以跳过后手动处理。">
            {previewText && <pre className="setup-preview">{previewText}</pre>}
            <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewClient()}>预览配置</button><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void finish()}>暂时跳过</button><PrimaryAction busy={busy === 'apply-client'} onClick={() => void applyClient()} label="应用并备份" /></div>
          </WizardSection>}

          {currentStep === 'complete' && <WizardSection icon={<CheckCircle2 />} title="配置已经跑通" description="Stone 已完成一次从本地网关到上游模型的真实请求。">
            <SummaryRows rows={[['客户端', clientLabels[client]], ['模型', model], ['号池', poolId ?? routing?.poolId ?? '—'], ['本地网关', `http://${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port}`], ['测试耗时', verification ? `${verification.latencyMs} ms` : '—']]} />
            <div className="setup-actions"><button className="button button--secondary" type="button" onClick={() => { setVerification(null); void api.saveSetupWizardProgress({ step: 'source' }).then(setWizard) }}>继续配置另一个来源</button><button className="button button--primary" type="button" onClick={() => void exitWizard()}>返回总览</button></div>
          </WizardSection>}

          {currentStep !== 'complete' && <footer className="setup-wizard__footer"><button className="text-button" type="button" disabled={currentIndex === 0 || Boolean(busy) || oauthCommitLocked} onClick={() => void back()}><ArrowLeft size={15} />上一步</button><button className="text-button danger" type="button" disabled={Boolean(busy) || oauthCommitLocked} onClick={() => void discard()}>放弃本次向导</button></footer>}
        </main>
      </div>
    </div>
  )
}

function WizardSection({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <section className="setup-card"><header><span>{icon}</span><div><h2>{title}</h2><p>{description}</p></div></header><div className="setup-card__body">{children}</div></section>
}

function Choice({ icon, title, description, onClick, disabled = false, selected = false }: { icon?: ReactNode; title: string; description: string; onClick: () => void; disabled?: boolean; selected?: boolean }) {
  return <button className={`setup-choice ${selected ? 'selected' : ''}`} type="button" disabled={disabled} onClick={onClick}>{icon && <span>{icon}</span>}<div><strong>{title}</strong><small>{description}</small></div><ArrowRight size={16} /></button>
}

function PrimaryAction({ label, onClick, busy, disabled = false, icon }: { label: string; onClick: () => void; busy: boolean; disabled?: boolean; icon?: ReactNode }) {
  return <button className="button button--primary setup-primary" type="button" disabled={busy || disabled} onClick={onClick}>{busy ? <LoaderCircle size={16} className="spin" /> : icon}{label}<ArrowRight size={15} /></button>
}

function ScanSummary({ snapshot }: { snapshot: AppSnapshot }) {
  const usable = snapshot.accounts.filter((account) => account.status === 'active').length
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled).length
  return <div className="setup-metrics"><div><span>可用来源</span><strong>{usable}</strong></div><div><span>号池</span><strong>{snapshot.pools.length}</strong></div><div><span>启用路由</span><strong>{enabledRoutes}</strong></div><div><span>网关</span><strong>{snapshot.gatewayStatus.running ? '运行中' : '未启动'}</strong></div></div>
}

function ApiSourceForm({ draft, proxies, proxyId, official, onChange, onProxyChange, onVendor }: { draft: ApiSourceInput; proxies: AppSnapshot['proxies']; proxyId: string; official: boolean; onChange: (value: ApiSourceInput) => void; onProxyChange: (value: string) => void; onVendor: (kind: ProviderKind) => void }) {
  const compatibleKinds: ProviderKind[] = ['openai-compatible', 'anthropic-compatible', 'custom']
  const protocols: Protocol[] = draft.kind === 'anthropic' || draft.kind === 'anthropic-compatible'
    ? ['anthropic-messages']
    : draft.kind === 'google' ? ['gemini'] : ['openai-responses', 'openai-chat']
  return <div className="setup-form-grid">
    {official && <label><span>官方厂商</span><select value={draft.kind} onChange={(event) => onVendor(event.target.value as ProviderKind)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label>}
    {!official && <label><span>兼容类型</span><select value={draft.kind} onChange={(event) => { const kind = event.target.value as ProviderKind; onChange({ ...draft, kind, protocol: kind === 'anthropic-compatible' ? 'anthropic-messages' : draft.protocol === 'anthropic-messages' ? 'openai-responses' : draft.protocol }) }}>{compatibleKinds.map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label>}
    <label><span>显示名称</span><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
    <label className="full"><span>Base URL</span><input className="mono" disabled={official} value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} /></label>
    <label><span>协议</span><select value={draft.protocol} onChange={(event) => onChange({ ...draft, protocol: event.target.value as Protocol })}>{protocols.map((protocol) => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}</select></label>
    <label><span>测试/默认模型</span><input value={draft.defaultModel ?? ''} onChange={(event) => onChange({ ...draft, defaultModel: event.target.value })} placeholder="例如 gpt-5.4" /></label>
    <label className="full"><span>API Key</span><input type="password" value={draft.credential ?? ''} onChange={(event) => onChange({ ...draft, credential: event.target.value })} /></label>
    <label><span>最大并发</span><input type="number" min={1} max={100} value={draft.maxConcurrency} onChange={(event) => onChange({ ...draft, maxConcurrency: Number(event.target.value) })} /></label>
    <label><span>出口代理</span><select value={proxyId} onChange={(event) => onProxyChange(event.target.value)}><option value="">直连</option>{proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name}</option>)}</select></label>
  </div>
}

function ProbeResult({ result }: { result: ApiSourceProbeResult }) {
  return <div className="setup-probe"><header><strong>连接诊断</strong><Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? '通过' : '未通过'}</Badge></header>{result.stages.map((stage) => <div key={stage.id}><span className={`status-dot status-dot--${stage.status}`} /><strong>{stageLabel(stage.id)}</strong><p>{stage.message}</p><small>{stage.latencyMs === undefined ? '—' : `${stage.latencyMs} ms`}</small></div>)}</div>
}

function ModelChoice({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="setup-field"><span>测试模型</span><input list="setup-model-options" value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入或选择模型" /><datalist id="setup-model-options">{options.map((model) => <option value={model} key={model} />)}</datalist></label>
}

function SummaryRows({ rows }: { rows: Array<[string, string]> }) {
  return <div className="setup-summary">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || '—'}</strong></div>)}</div>
}

function sourceModeFromProgress(method?: SetupSourceMethod, sourceType?: SetupWizardState['sourceType'], sourceId?: string): SourceMode {
  if (method === 'oauth' || method === 'token-json') return 'oauth-import'
  if (method === 'official-api' || method === 'relay' || method === 'aggregate' || method === 'existing') return method
  if (sourceId) return 'existing'
  if (sourceType === 'official-api' || sourceType === 'relay') return sourceType
  if (sourceType === 'oauth-system') return 'existing'
  return 'existing'
}

function stageLabel(id: string): string {
  if (id === 'network') return '网络'
  if (id === 'authentication') return '认证'
  if (id === 'models') return '模型发现'
  return '真实生成'
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败，请重试。'
}
