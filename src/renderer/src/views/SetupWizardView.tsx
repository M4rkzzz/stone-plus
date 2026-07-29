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
  ClientConfigStatus,
  EnsureGatewayRunningResult,
  GatewayApi,
  NetworkDiagnosticReport,
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
import { providerSourceFamily } from '@shared/source-family'
import { DEFAULT_ACCOUNT_MAX_CONCURRENCY } from '@shared/types'
import {
  isAvailableRouteAccount,
  isKiroClaudeRouteSource,
  isNativeGrokRouteSource,
  resolveRouteSource,
  routeSourceUsesKiroClaude,
} from '@shared/route-sources'
import { Badge, ConfirmDialog, InfoTip, protocolLabels } from '../ui'
import { clientBrandMeta } from '../brand-icons'
import { ExclusiveAsyncOperation, SerializedAsyncOperation } from '../async-operation'
import { BUILT_IN_PROXY_BINDING_NOTICE, useBuiltInProxyInterlock } from '../built-in-proxy-interlocks'
import { useI18n } from '../i18n'
import { useVisibilityAwareInterval } from '../visibility-interval'
import {
  effectiveResponsesCompactMode,
  officialOpenAiUsesNativeCompact,
  relayCanConfigureResponsesCompact,
  responsesCompactModeCopy,
  responsesCompactModes,
  type ResponsesCompactMode,
} from '../responses-compact-mode'
import {
  captureSetupSourceProbeBinding,
  confirmSetupWizardAction,
  persistSetupWizardSourceProxy,
  setupSourceProbeMatches,
  type SetupSourceProbeBinding,
} from '../setup-wizard-operations'
import {
  newRelayConnectionDefaults,
  protocolAfterProviderKindChange,
  protocolOptionLabel,
  protocolsByProviderKind,
  providerKindLabelsEn,
  providerKindLabelsZh,
  relayProtocolSelectLocked,
  KIRO_COMPATIBLE_KIND,
  XAI_COMPATIBLE_KIND,
} from '../grok-relay-ui'
import { setupPoolDisplayName } from '../system-generated-text'
import {
  parseSetupSourceDraft,
  serializeSetupSourceDraft,
  setupWizardDraftStorageKey,
  setupWizardPhaseForStep,
  setupWizardPhases,
  setupWizardStepLabel,
} from '../setup-wizard-presentation'
import '../setup-wizard.css'

type SourceMode = 'existing' | 'oauth-import' | 'official-api' | 'relay' | 'aggregate'
type AccountAddMethod = 'oauth' | 'token-json'
type OAuthUiStage = 'idle' | 'starting' | 'waiting' | 'submitting' | 'exchanging' | 'cancelling' | 'success' | 'error' | 'cancelled'
type WizardProgressPatch = Omit<SetupWizardProgressInput, 'sessionId' | 'step'>

type Translate = <T>(chinese: T, english: T) => T

const wizardStepOrder: SetupWizardStep[] = [
  'scan',
  'source',
  'source-config',
  'network',
  'upstream-test',
  'client',
  'routing',
  'gateway',
  'verify',
  'client-config',
  'complete',
]

interface SetupEnvironmentScan {
  network: NetworkDiagnosticReport
  clients: ClientConfigStatus[]
  clientScanFailed: boolean
}

const clientLabels: Record<RouteClient, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  grokbuild: 'Grok Build',
}

const emptyApiSource = (sourceType: 'official-api' | 'relay'): ApiSourceInput => {
  const relayDefaults = sourceType === 'relay' ? newRelayConnectionDefaults() : undefined
  return {
    name: '',
    sourceType,
    kind: sourceType === 'official-api' ? 'openai' : relayDefaults!.kind,
    baseUrl: sourceType === 'official-api' ? 'https://api.openai.com/v1' : relayDefaults!.baseUrl,
    protocol: sourceType === 'official-api' ? 'openai-responses' : relayDefaults!.protocol,
    responsesCompactMode: sourceType === 'relay' ? relayDefaults!.responsesCompactMode : undefined,
    credential: '',
    models: [],
    defaultModel: '',
    priority: 10,
    weight: 10,
    maxConcurrency: DEFAULT_ACCOUNT_MAX_CONCURRENCY,
    proxyId: '',
  }
}

export function SetupWizardView({
  snapshot,
  api,
  onExit,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  onExit: () => void
}) {
  const { t } = useI18n()
  const builtInProxyInterlocked = useBuiltInProxyInterlock(snapshot, api)
  const phases = useMemo(() => setupWizardPhases(t), [t])
  const [wizard, setWizard] = useState<SetupWizardState | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>('existing')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [aggregatePoolId, setAggregatePoolId] = useState('')
  const [aggregateMemberId, setAggregateMemberId] = useState('')
  const [sourceDraft, setSourceDraft] = useState<ApiSourceInput>(() => emptyApiSource('official-api'))
  const [accountAddMethod, setAccountAddMethod] = useState<AccountAddMethod>('oauth')
  const [accountName, setAccountName] = useState('')
  const [importContent, setImportContent] = useState('')
  const [tagId, setTagId] = useState<string | null>(null)
  const [newTagName, setNewTagName] = useState('')
  const [poolId, setPoolId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState('')
  const [probe, setProbe] = useState<ApiSourceProbeResult | null>(null)
  const [probeBinding, setProbeBinding] = useState<SetupSourceProbeBinding | null>(null)
  const [model, setModel] = useState('')
  const [client, setClient] = useState<RouteClient>('codex')
  const [clientProfileId, setClientProfileId] = useState('')
  const [routing, setRouting] = useState<SetupRoutingResult | null>(null)
  const [connectedGateway, setConnectedGateway] = useState<EnsureGatewayRunningResult | null>(null)
  const [verification, setVerification] = useState<SetupRouteVerificationResult | null>(null)
  const [environmentScan, setEnvironmentScan] = useState<SetupEnvironmentScan | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [busy, setBusy] = useState('load')
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
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
  const sourceDraftRef = useRef(sourceDraft)
  const proxyIdRef = useRef(proxyId)
  const modelRef = useRef(model)
  const actionOperationRef = useRef(new ExclusiveAsyncOperation())
  const progressOperationRef = useRef(new SerializedAsyncOperation())
  const hydratedDraftSessionRef = useRef<string | null>(null)
  const busyRef = useRef('load')
  sourceDraftRef.current = sourceDraft
  proxyIdRef.current = proxyId
  modelRef.current = model

  const providerById = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider])), [snapshot.providers])
  const availableAccounts = useMemo(() => snapshot.accounts.filter(isAvailableRouteAccount), [snapshot.accounts])
  const setupEligibleAccounts = useMemo(() => availableAccounts.filter((account) => {
    const provider = providerById.get(account.providerId)
    if (!provider || provider.kind !== KIRO_COMPATIBLE_KIND && provider.protocol !== 'kiro-claude') return true
    return isKiroClaudeRouteSource(resolveRouteSource(provider.id, snapshot), snapshot)
  }), [availableAccounts, providerById, snapshot])
  const selectedAccount = oauthImportedSnapshot?.accounts.find((account) => account.id === selectedAccountId)
    ?? snapshot.accounts.find((account) => account.id === selectedAccountId)
  const selectedProvider = selectedAccount
    ? oauthImportedSnapshot?.providers.find((provider) => provider.id === selectedAccount.providerId)
      ?? providerById.get(selectedAccount.providerId)
    : undefined
  const selectedSourceIsGrok = aggregatePoolId
    ? isNativeGrokRouteSource(resolveRouteSource(aggregatePoolId, snapshot), snapshot)
    : selectedProvider !== undefined
      && selectedProvider.protocol === 'openai-responses'
      && providerSourceFamily(selectedProvider.kind) === 'grok'
  const selectedRouteSource = resolveRouteSource(aggregatePoolId || selectedProvider?.id || '', snapshot)
  const selectedSourceIsKiroClaude = routeSourceUsesKiroClaude(selectedRouteSource, snapshot)
  const compatiblePools = snapshot.pools.filter((pool) => pool.kind === 'standard'
    && pool.protocol === 'openai-responses'
    && pool.members.every((member) => {
      const account = snapshot.accounts.find((candidate) => candidate.id === member.accountId)
      const provider = providerById.get(account?.providerId ?? '')
      return provider !== undefined && providerSourceFamily(provider.kind) === 'openai'
    }))
  const aggregatePools = useMemo(() => snapshot.pools.filter((pool) => pool.kind === 'relay-aggregate'
    && pool.members.some((member) => member.enabled
      && setupEligibleAccounts.some((account) => account.id === member.accountId))
    && (!routeSourceUsesKiroClaude(resolveRouteSource(pool.id, snapshot), snapshot)
      || isKiroClaudeRouteSource(resolveRouteSource(pool.id, snapshot), snapshot))), [setupEligibleAccounts, snapshot])
  const selectedAggregate = useMemo(
    () => aggregatePools.find((pool) => pool.id === aggregatePoolId),
    [aggregatePoolId, aggregatePools],
  )
  const aggregateCandidates = useMemo(() => selectedAggregate?.members.flatMap((member) => {
    if (!member.enabled) return []
    const account = setupEligibleAccounts.find((candidate) => candidate.id === member.accountId)
    return account ? [{ member, account, provider: providerById.get(account.providerId) }] : []
  }) ?? [], [providerById, selectedAggregate, setupEligibleAccounts])
  const effectivePoolId = routing?.poolId ?? poolId ?? wizard?.poolId
  const effectivePool = routing?.snapshot.pools.find((pool) => pool.id === effectivePoolId)
    ?? snapshot.pools.find((pool) => pool.id === effectivePoolId)
  const connectedGatewayHost = connectedGateway?.host ?? snapshot.gatewayStatus.host
  const connectedGatewayPort = connectedGateway?.port ?? snapshot.gatewayStatus.port
  const selectedSourceName = selectedProvider?.name ?? selectedAccount?.name ?? (selectedAccountId || t('已配置来源', 'Configured source'))
  const currentStep = wizard?.step ?? 'scan'
  const currentIndex = Math.max(0, wizardStepOrder.indexOf(currentStep))
  const currentPhaseId = setupWizardPhaseForStep(currentStep)
  const currentPhaseIndex = Math.max(0, phases.findIndex((phase) => phase.id === currentPhaseId))
  const previousStepIndexRef = useRef(currentIndex)
  const stepMotionDirection = currentIndex < previousStepIndexRef.current ? 'backward' : 'forward'
  const oauthActive = oauthStage === 'starting' || oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging' || oauthStage === 'cancelling'
  const importConfigurationLocked = oauthActive || Boolean(busy)
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
  const currentProbe = probe && setupSourceProbeMatches(probeBinding, sourceDraft, proxyId, model) ? probe : null

  useEffect(() => {
    previousStepIndexRef.current = currentIndex
  }, [currentIndex])

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
          setClientProfileId(next.profileId ?? '')
          const restoredMode = sourceModeFromProgress(next.sourceMethod, next.sourceType, next.sourceId)
          setSourceMode(restoredMode)
          setAccountAddMethod(next.sourceMethod === 'token-json' ? 'token-json' : 'oauth')
          if (next.sourceMethod === 'aggregate' && next.poolId) setAggregatePoolId(next.poolId)
          const cachedDraft = readSetupSourceDraftCache(next.sessionId)
          if (cachedDraft && (restoredMode === 'official-api' || restoredMode === 'relay')) {
            setSourceDraft(cachedDraft)
            sourceDraftRef.current = cachedDraft
            setProxyId(next.proxyId ?? cachedDraft.proxyId ?? '')
            setModel(next.model ?? cachedDraft.defaultModel ?? '')
          }
          hydratedDraftSessionRef.current = next.sessionId
        }
      })
      .catch((cause) => setError(messageOf(cause, t)))
      .finally(() => {
        busyRef.current = ''
        setBusy('')
      })
    return () => { cancelled = true }
  }, [api, t])

  useVisibilityAwareInterval(
    () => setOauthNow(Date.now()),
    1_000,
    Boolean(oauthSession) && oauthActive,
    true,
    oauthSession?.sessionId,
  )

  useEffect(() => () => {
    oauthAttemptRef.current += 1
    const sessionId = oauthSessionIdRef.current
    oauthSessionIdRef.current = null
    if (sessionId) void api.cancelChatGptOAuth(sessionId).catch(() => undefined)
  }, [api])

  useEffect(() => {
    if (!model && modelOptions.length) setModel(modelOptions[0])
  }, [model, modelOptions])

  useEffect(() => {
    const sessionId = wizard?.sessionId
    if (!sessionId || hydratedDraftSessionRef.current !== sessionId) return
    if (sourceMode !== 'official-api' && sourceMode !== 'relay') return
    writeSetupSourceDraftCache(sessionId, {
      ...sourceDraft,
      proxyId: proxyId || sourceDraft.proxyId,
      defaultModel: model || sourceDraft.defaultModel,
    })
  }, [model, proxyId, sourceDraft, sourceMode, wizard?.sessionId])

  useEffect(() => {
    if (!aggregateCandidates.length) {
      if (aggregateMemberId) setAggregateMemberId('')
      return
    }
    if (!aggregateCandidates.some(({ account }) => account.id === aggregateMemberId)) {
      setAggregateMemberId(aggregateCandidates[0].account.id)
    }
  }, [aggregateCandidates, aggregateMemberId])

  useEffect(() => {
    const profiles = snapshot.clientProfiles.filter((profile) => profile.client === client)
    if (!profiles.some((profile) => profile.id === clientProfileId)) setClientProfileId(profiles[0]?.id ?? '')
  }, [client, clientProfileId, snapshot.clientProfiles])

  const run = async <T,>(key: string, operation: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined
    const outcome = await actionOperationRef.current.run(async () => {
      busyRef.current = key
      setBusy(key)
      setError('')
      setNotice('')
      try {
        return await operation()
      } catch (cause) {
        setError(messageOf(cause, t))
        return undefined
      } finally {
        busyRef.current = ''
        setBusy('')
      }
    })
    return outcome.started ? outcome.value : undefined
  }

  const move = async (step: SetupWizardStep, patch: WizardProgressPatch = {}): Promise<SetupWizardState | undefined> => {
    const input: SetupWizardProgressInput = {
      sessionId: wizard?.sessionId,
      step,
      sourceType: patch.sourceType ?? wizard?.sourceType,
      sourceMethod: patch.sourceMethod !== undefined ? patch.sourceMethod : wizard?.sourceMethod,
      sourceId: patch.sourceId !== undefined ? patch.sourceId : selectedAccountId || wizard?.sourceId,
      tagId: patch.tagId !== undefined ? patch.tagId : tagId,
      poolId: patch.poolId !== undefined ? patch.poolId : poolId,
      routeId: patch.routeId !== undefined ? patch.routeId : wizard?.routeId,
      client: patch.client ?? client,
      profileId: patch.profileId !== undefined ? patch.profileId : clientProfileId || null,
      model: patch.model ?? (model || wizard?.model),
      proxyId: patch.proxyId !== undefined ? patch.proxyId : proxyId || null,
      lastError: patch.lastError,
    }
    return progressOperationRef.current.enqueue(async () => {
      const next = await run('progress', () => api.saveSetupWizardProgress(input))
      if (next) setWizard(next)
      return next
    })
  }

  const moveWithNotice = async (step: SetupWizardStep, patch: WizardProgressPatch, message: string) => {
    const next = await move(step, patch)
    if (next) setNotice(message)
    return next
  }

  const back = async () => {
    if (currentIndex <= 0) return
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    await move(wizardStepOrder[currentIndex - 1])
  }

  const exitWizard = async () => {
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    onExit()
  }

  const scan = async () => {
    const result = await run('scan', async (): Promise<SetupEnvironmentScan> => {
      const [network, clientResult] = await Promise.all([
        api.runNetworkDiagnostics(proxyId ? { proxyId } : {}),
        api.getClientConfigs().then((clients) => ({ clients, failed: false })).catch(() => ({ clients: [], failed: true })),
      ])
      return { network, clients: clientResult.clients, clientScanFailed: clientResult.failed }
    })
    if (!result) return
    setEnvironmentScan(result)
    setNotice(result.network.summary === 'error'
      ? t('基础网络存在异常，仍可继续并在网络步骤选择代理。', 'Basic network checks found a problem. You can continue and choose a proxy in the network step.')
      : result.clientScanFailed
        ? t('网络检查完成；客户端配置检测未完成，但不影响继续。', 'Network checks completed. Client configuration detection did not finish, but you can continue.')
        : t('环境检查完成，可以开始添加来源。', 'Environment checks completed. You can now add a source.'))
  }

  const chooseMode = (mode: SourceMode) => {
    setSourceMode(mode)
    if (mode === 'oauth-import') setAccountAddMethod('oauth')
    setSelectedAccountId('')
    setAggregatePoolId('')
    setProbe(null)
    setProbeBinding(null)
    setModel('')
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
    if (!selectedAccountId) return setError(t('请选择一个已有来源。', 'Choose an existing source.'))
    const account = snapshot.accounts.find((candidate) => candidate.id === selectedAccountId)
    if (!account) return setError(t('选择的来源已不存在。', 'The selected source no longer exists.'))
    const provider = providerById.get(account.providerId)
    const nextProxyId = account.proxyId ?? ''
    const nextModel = account.availableModels[0] || provider?.models[0] || ''
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
    if (!pool) return setError(t('请选择一个聚合中转。', 'Choose an aggregate relay.'))
    const selectedCandidate = aggregateCandidates.find(({ account }) => account.id === aggregateMemberId)
    if (!selectedCandidate) return setError(t('请选择一个可用于验证的聚合成员。', 'Choose an aggregate member to verify.'))
    setSelectedAccountId(selectedCandidate.account.id)
    setPoolId(pool.id)
    const nextProxyId = pool.proxyId ?? ''
    setProxyId(nextProxyId)
    const account = selectedCandidate.account
    const provider = selectedCandidate.provider
    const nextModel = pool.modelAllowlist[0] || account?.availableModels[0] || provider?.models[0] || ''
    setModel(nextModel)
    await move('network', { sourceMethod: 'aggregate', sourceId: account.id, poolId: pool.id, sourceType: 'relay', proxyId: nextProxyId || null, model: nextModel || undefined })
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
      setOauthOpenHint(t('授权结果正在保存并检测账号，此阶段不可退出，请等待完成。', 'The authorization result is being saved and the account is being checked. Keep the wizard open until this finishes.'))
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
        setOauthOpenHint(t('授权结果已进入 Token 保存与账号检测阶段，现在不能退出，请等待完成。', 'The authorization result is now saving the token and checking the account. Keep the wizard open until this finishes.'))
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
        setOauthOpenHint(cause instanceof Error
          ? t(`取消失败：${cause.message}`, `Could not cancel: ${localizedGatewayMessage(cause.message, t)}`)
          : t('取消失败，请稍后重试。', 'Could not cancel. Try again in a moment.'))
      }
      return false
    }
  }

  const finishOAuthImport = async (result: ChatGptAccountImportResult) => {
    const healthy = result.detectionResults.find((item) => item.ok)
    const accountId = healthy?.accountId ?? result.importedAccountIds[0]
    if (!accountId) throw new Error(t('OAuth 授权完成，但没有生成可继续配置的账号。', 'OAuth authorization completed, but no account was created for the remaining setup.'))
    const account = result.snapshot.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error(t('OAuth 账号已保存，但返回结果中缺少账号详情。', 'The OAuth account was saved, but its details are missing from the result.'))
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
    const selectedTag = assignment.tagId
      ? result.snapshot.accountTags.find((item) => item.id === assignment.tagId)?.name ?? t('已选 Tag', 'Selected tag')
      : t('未标记', 'Untagged')
    const poolAppendError = assignment.poolAppendError ? localizedGatewayMessage(assignment.poolAppendError, t) : ''
    const warnings = result.warnings.map((warning) => localizedGatewayMessage(warning, t))
    const completionNotice = t(
      `OAuth 添加完成：新增 ${result.createdAccountIds.length} 个，更新 ${result.updatedAccountIds.length} 个，检测可用 ${detected} 个；Tag：${selectedTag}${assignment.poolMembersAdded ? `；加入号池 ${assignment.poolMembersAdded} 个` : ''}${assignment.poolAppendError ? `；号池追加失败：${assignment.poolAppendError}` : ''}${result.warnings.length ? `；${result.warnings.join(' ')}` : ''}`,
      `OAuth import complete: ${result.createdAccountIds.length} created, ${result.updatedAccountIds.length} updated, ${detected} passed checks; tag: ${selectedTag}${assignment.poolMembersAdded ? `; ${assignment.poolMembersAdded} added to the pool` : ''}${poolAppendError ? `; could not add to pool: ${poolAppendError}` : ''}${warnings.length ? `; ${warnings.join(' ')}` : ''}`,
    )
    await moveWithNotice('network', {
      sourceMethod: 'oauth',
      sourceType: 'oauth-system',
      sourceId: accountId,
      tagId: assignment.tagId,
      poolId: assignment.poolId,
      proxyId: proxyId || null,
      model: nextModel || undefined,
    }, completionNotice)
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
      setOauthError(cause instanceof Error ? localizedGatewayMessage(cause.message, t) : t('OAuth 授权未完成，请重试。', 'OAuth authorization did not complete. Try again.'))
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
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenHint(t('已在系统浏览器中打开授权页面。', 'The authorization page is open in your system browser.'))
    } catch (cause) {
      if (oauthAttemptRef.current === attempt && oauthSessionIdRef.current === sessionId) setOauthOpenHint(cause instanceof Error ? localizedGatewayMessage(cause.message, t) : t('无法打开系统浏览器，请复制链接后手动打开。', 'Could not open the system browser. Copy the link and open it manually.'))
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
      setOauthError(cause instanceof Error ? localizedGatewayMessage(cause.message, t) : t('无法启动 OAuth 授权。', 'Could not start OAuth authorization.'))
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
      setOauthOpenHint(t('复制失败，请手动选择授权链接。', 'Copy failed. Select and copy the authorization link manually.'))
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
      setOauthCallbackError(cause instanceof Error ? localizedGatewayMessage(cause.message, t) : t('回调地址提交失败。', 'Could not submit the callback URL.'))
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
    if (!accountId) return setError(t('没有导入可用账号。', 'No usable account was imported.'))
    const account = result.snapshot.accounts.find((candidate) => candidate.id === accountId)
    const provider = account ? result.snapshot.providers.find((candidate) => candidate.id === account.providerId) : undefined
    setOauthImportedSnapshot(result.snapshot)
    setSelectedAccountId(accountId)
    setModel(account?.availableModels[0] ?? provider?.models[0] ?? '')
    const poolAppendError = result.assignmentSummary.poolAppendError
      ? localizedGatewayMessage(result.assignmentSummary.poolAppendError, t)
      : ''
    const completionNotice = t(
      `已导入 ${result.importedAccountIds.length} 个账号，检测成功 ${result.detectionResults.filter((item) => item.ok).length} 个，Tag 更新 ${result.assignmentSummary.tagUpdatedAccountCount} 个，加入号池 ${result.assignmentSummary.poolMembersAdded} 个。${result.assignmentSummary.poolAppendError ? ` 号池追加失败：${result.assignmentSummary.poolAppendError}` : ''}`,
      `Imported ${result.importedAccountIds.length} account(s); ${result.detectionResults.filter((item) => item.ok).length} passed checks, ${result.assignmentSummary.tagUpdatedAccountCount} tag assignment(s) updated, and ${result.assignmentSummary.poolMembersAdded} added to the pool.${poolAppendError ? ` Could not add to pool: ${poolAppendError}` : ''}`,
    )
    await moveWithNotice('network', { sourceMethod: 'token-json', sourceId: accountId, sourceType: 'oauth-system', tagId, poolId, proxyId: proxyId || null }, completionNotice)
  }

  const createImportTag = async () => {
    const name = newTagName.trim()
    if (!name) return setError(t('请输入 Tag 名称。', 'Enter a tag name.'))
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
    const presets: Record<'openai' | 'xai' | 'anthropic' | 'google', Pick<ApiSourceInput, 'kind' | 'baseUrl' | 'protocol' | 'name'>> = {
      openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', name: 'OpenAI API' },
      xai: { kind: 'xai', baseUrl: 'https://api.x.ai/v1', protocol: 'openai-responses', name: 'Grok / xAI' },
      anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', name: 'Anthropic API' },
      google: { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini', name: 'Google Gemini API' },
    }
    if (kind !== 'openai' && kind !== 'xai' && kind !== 'anthropic' && kind !== 'google') return
    setSourceDraft((current) => {
      const next = { ...current, ...presets[kind], responsesCompactMode: undefined }
      sourceDraftRef.current = next
      return next
    })
  }

  const probeDraft = async () => {
    const draft = sourceDraftRef.current
    const selectedProxyId = proxyIdRef.current
    const selectedModel = modelRef.current
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.credential?.trim()) {
      return setError(t('请填写名称、Base URL 和 API Key。', 'Enter a name, Base URL, and API key.'))
    }
    if (draft.kind === KIRO_COMPATIBLE_KIND && !(selectedModel || draft.defaultModel)?.trim()) {
      return setError(t('Kiro Claude 不提供模型发现，请手动填写测试模型。', 'Kiro Claude does not use model discovery. Enter the test model manually.'))
    }
    setProbe(null)
    setProbeBinding(null)
    const requestBinding = captureSetupSourceProbeBinding(draft, selectedProxyId, selectedModel)
    const result = await run('probe', () => api.probeApiSource({
      id: draft.id,
      name: draft.name,
      sourceType: draft.sourceType,
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      protocol: draft.protocol,
      responsesCompactMode: draft.responsesCompactMode,
      credential: draft.credential,
      model: selectedModel || draft.defaultModel,
      proxyId: selectedProxyId || draft.proxyId,
    }))
    if (!result) return
    if (!setupSourceProbeMatches(requestBinding, sourceDraftRef.current, proxyIdRef.current, modelRef.current)) {
      setError(t('来源配置在测试期间发生了变化，本次结果已忽略，请重新测试。', 'The source changed while it was being tested. This result was ignored; test again.'))
      return
    }
    setProbe(result)
    const testedModel = selectedModel || draft.defaultModel || result.models[0] || ''
    if (!selectedModel && testedModel) setModel(testedModel)
    setProbeBinding(captureSetupSourceProbeBinding(draft, selectedProxyId, testedModel))
    if (result.ok) setNotice(t('来源验证通过，可以安全保存。', 'Source verification passed. It is ready to save.'))
  }

  const saveDraft = async () => {
    if (!currentProbe?.ok) return setError(t('来源配置已在测试后变更，请重新运行真实上游验证。', 'The source changed after it was tested. Run the real upstream test again.'))
    const result = await run('save-source', () => api.saveApiSource({
      ...sourceDraft,
      proxyId: proxyId || sourceDraft.proxyId,
      defaultModel: model || sourceDraft.defaultModel,
      models: currentProbe.models.length ? currentProbe.models : sourceDraft.models,
      capabilityProfile: currentProbe.capabilityProfile,
      modelCatalog: currentProbe.modelCatalog,
      probeEvidenceToken: currentProbe.probeEvidenceToken,
    }))
    if (!result) return
    const provider = sourceDraft.id
      ? result.providers.find((candidate) => candidate.id === sourceDraft.id)
      : [...result.providers]
        .filter((candidate) => candidate.sourceType === sourceDraft.sourceType && candidate.name === sourceDraft.name.trim())
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    const account = provider ? result.accounts.find((candidate) => candidate.providerId === provider.id) : undefined
    if (!account) return setError(t('来源已保存，但未找到对应凭据账号。', 'The source was saved, but its credential account could not be found.'))
    setOauthImportedSnapshot(result)
    setSelectedAccountId(account.id)
    if (wizard?.sessionId) clearSetupSourceDraftCache(wizard.sessionId)
    const nextClient = provider?.protocol === 'kiro-claude' ? 'claude' : client
    setClient(nextClient)
    const completionNotice = t(
      '来源已经通过真实请求验证，已跳过重复的网络与上游测试。',
      'The source already passed a real request, so duplicate network and upstream tests were skipped.',
    )
    await moveWithNotice('client', {
      sourceId: account.id,
      sourceType: sourceDraft.sourceType,
      proxyId: account.proxyId,
      model: model || sourceDraft.defaultModel,
      client: nextClient,
    }, completionNotice)
  }

  const checkNetwork = async () => {
    if (!selectedAccount) return setError(t('来源账号不存在。', 'The source account does not exist.'))
    const aggregate = aggregatePoolId
      ? snapshot.pools.find((pool) => pool.id === aggregatePoolId && pool.kind === 'relay-aggregate')
      : undefined
    const outcome = await run('network', async () => {
      const report = await api.runNetworkDiagnostics(proxyId ? { proxyId } : {})
      if (report.summary === 'error') {
        throw new Error(report.diagnoses[0]
          ? t(report.diagnoses[0], containsCjk(report.diagnoses[0]) ? 'Network diagnostics reported an error for this exit.' : report.diagnoses[0])
          : t('当前网络出口不可用。', 'The selected network exit is unavailable.'))
      }
      const updated = await persistSetupWizardSourceProxy(api, selectedAccount, proxyId, aggregate)
      if (selectedProvider && (selectedProvider.protocol === 'kiro-claude' || aggregate)) {
        const checkedModel = model || selectedAccount.availableModels[0] || selectedProvider.models[0] || ''
        if (!checkedModel) throw new Error(selectedProvider.protocol === 'kiro-claude'
          ? t('Kiro Claude 必须手动填写测试模型。', 'Enter a test model for Kiro Claude.')
          : t('聚合成员没有可用于真实测试的模型。', 'The aggregate member has no model available for a real test.'))
        const checked = await api.probeApiSource({
          id: selectedProvider.id,
          name: selectedProvider.name,
          sourceType: selectedProvider.sourceType === 'oauth-system' ? 'relay' : selectedProvider.sourceType,
          kind: selectedProvider.kind,
          baseUrl: selectedProvider.baseUrl,
          protocol: selectedProvider.protocol,
          model: checkedModel,
          proxyId: proxyId || selectedAccount.proxyId,
          persistCapabilities: true,
        })
        return {
          report,
          updated,
          checked: { ok: checked.ok, responsePreview: checked.error },
          checkedModel: checked.testedModel ?? checkedModel,
        }
      }
      await api.checkAccount(selectedAccount.id)
      let checkedModel = model
      if (!checkedModel) {
        const refreshed = await api.refreshAccountModels(selectedAccount.id)
        const refreshedAccount = refreshed.accounts.find((candidate) => candidate.id === selectedAccount.id)
        const refreshedProvider = refreshedAccount
          ? refreshed.providers.find((candidate) => candidate.id === refreshedAccount.providerId)
          : undefined
        checkedModel = refreshedAccount?.availableModels[0] ?? refreshedProvider?.models[0] ?? ''
      }
      if (!checkedModel) throw new Error(t('没有可用于真实测试的模型。', 'No model is available for a real test.'))
      const checked = await api.testAccountModel(selectedAccount.id, checkedModel)
      return { report, updated, checked, checkedModel }
    })
    if (!outcome) return
    if (outcome.updated) setOauthImportedSnapshot(outcome.updated)
    if (!outcome.checked.ok) return setError(outcome.checked.responsePreview
      ? t(outcome.checked.responsePreview, containsCjk(outcome.checked.responsePreview) ? 'The real upstream request failed. Check the source details.' : outcome.checked.responsePreview)
      : t('来源真实请求未通过。', 'The real source request failed.'))
    setModel(outcome.checkedModel)
    const completionNotice = outcome.report.summary === 'warning'
      ? t('网络存在非阻塞警告，但来源真实请求已经通过。', 'The network has a non-blocking warning, but the real source request passed.')
      : t('网络与来源真实请求均已通过。', 'Both the network and the real source request passed.')
    await moveWithNotice('client', { proxyId: proxyId || undefined, model: outcome.checkedModel }, completionNotice)
  }

  const verifyExistingSource = async () => {
    if (!selectedAccountId) return setError(t('来源账号不存在。', 'The source account does not exist.'))
    if (selectedProvider?.protocol === 'kiro-claude') {
      if (!model) return setError(t('Kiro Claude 必须手动填写测试模型。', 'Enter a test model for Kiro Claude.'))
      const checked = currentProbe?.ok
        ? currentProbe
        : await run('upstream', () => api.probeApiSource({
            id: selectedProvider.id,
            name: selectedProvider.name,
            sourceType: 'relay',
            kind: KIRO_COMPATIBLE_KIND,
            baseUrl: selectedProvider.baseUrl,
            protocol: 'kiro-claude',
            model,
            proxyId: selectedAccount?.proxyId,
            persistCapabilities: true,
          }))
      if (!checked) return
      if (!checked.ok) return setError(checked.error
        ? localizedProbeMessage('tool-roundtrip', 'error', checked.error, t)
        : t('Kiro Claude 两轮工具链测试未通过。', 'The Kiro Claude two-round tool test failed.'))
      setClient('claude')
      await moveWithNotice('client', { sourceId: selectedAccountId, model: checked.testedModel ?? model, client: 'claude' }, t(`Kiro Claude 两轮工具链测试通过，耗时 ${checked.latencyMs ?? 0} ms。`, `The Kiro Claude two-round tool test passed in ${checked.latencyMs ?? 0} ms.`))
      return
    }
    const checked = await run('upstream', async () => {
      await api.checkAccount(selectedAccountId)
      if (!model) {
        const refreshed = await api.refreshAccountModels(selectedAccountId)
        const account = refreshed.accounts.find((candidate) => candidate.id === selectedAccountId)
        const provider = account ? refreshed.providers.find((candidate) => candidate.id === account.providerId) : undefined
        const discovered = account?.availableModels[0] ?? provider?.models[0]
        if (discovered) setModel(discovered)
        return discovered ? api.testAccountModel(selectedAccountId, discovered) : Promise.reject(new Error(t('没有可用于真实测试的模型。', 'No model is available for a real test.')))
      }
      return api.testAccountModel(selectedAccountId, model)
    })
    if (!checked) return
    if (!checked.ok) return setError(checked.responsePreview
      ? t(checked.responsePreview, containsCjk(checked.responsePreview) ? 'The real upstream request failed. Check the source details.' : checked.responsePreview)
      : t('上游真实请求未通过。', 'The real upstream request failed.'))
    await moveWithNotice('client', { sourceId: selectedAccountId, model: checked.model }, t(`上游验证成功，耗时 ${checked.latencyMs} ms。`, `Upstream verification succeeded in ${checked.latencyMs} ms.`))
  }

  const createRouting = async () => {
    if (!wizard?.sessionId || !selectedAccountId || !model) return setError(t('缺少来源、模型或向导会话。', 'The source, model, or wizard session is missing.'))
    if (client === 'grokbuild' && !selectedSourceIsGrok) return setError(t('Grok Build 仅可连接原生 Responses 的 Grok 号池或中转站。', 'Grok Build can connect only to Responses-native Grok pools or relays.'))
    if (selectedSourceIsKiroClaude && client !== 'claude') return setError(t('Kiro Claude 中转只能绑定 Claude Code 客户端。', 'Kiro Claude relays can be bound only to Claude Code clients.'))
    const sessionId = wizard.sessionId
    const result = await run('connect', async () => {
      const routingResult = await api.applySetupRouting({
        sessionId,
        sourceId: selectedAccountId,
        client,
        model,
        aggregatePoolId: aggregatePoolId || (snapshot.pools.find((pool) => pool.id === poolId)?.kind === 'relay-aggregate' ? poolId ?? undefined : undefined),
      })
      const gatewayResult = await api.ensureGatewayRunning({
        host: routingResult.snapshot.gateway.host,
        port: routingResult.snapshot.gateway.port,
      })
      const verificationResult = await api.verifySetupRoute({
        sessionId,
        routeId: routingResult.routeId,
        client,
        model,
      })
      const nextWizard = await api.getSetupWizardState()
      return { routingResult, gatewayResult, verificationResult, nextWizard }
    })
    if (!result) {
      const resumable = await api.getSetupWizardState().catch(() => null)
      if (resumable?.sessionId === sessionId) setWizard(resumable)
      return
    }
    setRouting(result.routingResult)
    setConnectedGateway(result.gatewayResult)
    setPoolId(result.routingResult.poolId)
    setVerification(result.verificationResult)
    if (result.nextWizard) setWizard(result.nextWizard)
    else if (result.verificationResult.ok) setWizard((current) => current ? {
      ...current,
      step: 'client-config',
      poolId: result.routingResult.poolId,
      routeId: result.routingResult.routeId,
      client,
      model,
    } : current)
    if (!result.verificationResult.ok) return setError(result.verificationResult.error
      ? t(result.verificationResult.error, containsCjk(result.verificationResult.error) ? 'The end-to-end request failed. Check the route and upstream source.' : result.verificationResult.error)
      : t('端到端请求失败。', 'The end-to-end request failed.'))
    setNotice(t(
      `连接已建立并通过真实请求验证，耗时 ${result.verificationResult.latencyMs} ms${result.gatewayResult.changedPort ? '；网关已自动切换到可用端口' : ''}。`,
      `The connection passed a real request in ${result.verificationResult.latencyMs} ms${result.gatewayResult.changedPort ? '; the gateway automatically selected an available port' : ''}.`,
    ))
  }

  const startGateway = async () => {
    const result = await run('gateway', () => api.ensureGatewayRunning({ host: snapshot.gateway.host, port: snapshot.gateway.port }))
    if (!result) return
    setConnectedGateway(result)
    const completionNotice = t(
      `网关已监听 http://${result.host}:${result.port}${result.changedPort ? '（原端口被占用，已改用可用端口）' : ''}`,
      `Gateway is listening at http://${result.host}:${result.port}${result.changedPort ? ' (the requested port was busy, so an available port was used)' : ''}`,
    )
    await moveWithNotice('verify', {}, completionNotice)
  }

  const verifyRoute = async () => {
    if (!model) return setError(t('请选择测试模型。', 'Choose a model to test.'))
    if (!wizard?.sessionId || !wizard.routeId) return setError(t('缺少本次向导的路由绑定，请重新应用号池与路由。', 'This setup is no longer bound to a route. Apply the pool and route again.'))
    const { sessionId, routeId } = wizard
    const result = await run('verify', () => api.verifySetupRoute({ sessionId, routeId, client, model }))
    if (!result) return
    setVerification(result)
    if (!result.ok) return setError(result.error
      ? t(result.error, containsCjk(result.error) ? 'The end-to-end request failed. Check the route and upstream source.' : result.error)
      : t('端到端请求失败。', 'The end-to-end request failed.'))
    await moveWithNotice('client-config', {}, t(`本地端到端请求成功，耗时 ${result.latencyMs} ms。`, `The local end-to-end request succeeded in ${result.latencyMs} ms.`))
  }

  const previewClient = async () => {
    const result = await run('preview-client', () => api.previewClientConfig(client, clientProfileId || undefined))
    if (!result) return
    setPreviewText(result.files.map((file) => `${file.path}\n${file.changed
      ? t(`将更新：${file.managedFields.join('、') || '受管配置'}`, `Will update: ${file.managedFields.join(', ') || 'managed settings'}`)
      : t('无需更改', 'No changes needed')}`).join('\n\n'))
  }

  const applyClient = async () => {
    const result = await run('apply-client', () => api.applyClientConfig(client, clientProfileId || undefined))
    if (!result) return
    const completionNotice = result.changedFiles.length
      ? t(`已更新 ${result.changedFiles.length} 个客户端配置文件并创建备份。`, `Updated ${result.changedFiles.length} client configuration file(s) and created backups.`)
      : t('客户端配置已经正确，无需改动。', 'The client configuration is already correct; no changes were needed.')
    await finish(completionNotice)
  }

  const finish = async (completionNotice?: string) => {
    if (!wizard?.sessionId || (wizard.step !== 'client-config' && !verification?.ok)) return setError(t('必须先完成端到端验证。', 'Complete the end-to-end test first.'))
    const completed = await run('finish', () => confirmSetupWizardAction(() => api.completeSetupWizard(wizard.sessionId)))
    if (!completed) return
    clearSetupSourceDraftCache(wizard.sessionId)
    setWizard((current) => current ? { ...current, step: 'complete', completed: true } : current)
    setNotice(completionNotice ?? t('连接已经验证完成；客户端配置保持不变。', 'The connection is verified. Client configuration was left unchanged.'))
  }

  const discard = async () => {
    if (oauthSessionIdRef.current && !await cancelWizardOAuth()) return
    const discarded = await run('discard', () => confirmSetupWizardAction(() => api.discardSetupWizard()))
    if (!discarded) return
    if (wizard?.sessionId) clearSetupSourceDraftCache(wizard.sessionId)
    setDiscardConfirmOpen(false)
    onExit()
  }

  const configureAnotherSource = async () => {
    const previousSessionId = wizard?.sessionId
    const next = await run('restart', async () => {
      await api.discardSetupWizard()
      return api.saveSetupWizardProgress({ step: 'source' })
    })
    if (!next) return
    if (previousSessionId) clearSetupSourceDraftCache(previousSessionId)
    hydratedDraftSessionRef.current = next.sessionId
    setWizard(next)
    setSourceMode('existing')
    setSelectedAccountId('')
    setAggregatePoolId('')
    setAggregateMemberId('')
    setSourceDraft(emptyApiSource('official-api'))
    setTagId(null)
    setPoolId(null)
    setProxyId('')
    setProbe(null)
    setProbeBinding(null)
    setModel('')
    setClientProfileId('')
    setRouting(null)
    setConnectedGateway(null)
    setVerification(null)
    setPreviewText('')
    setOauthImportedSnapshot(null)
  }

  return (
    <div className="setup-wizard page-stack">
      <header className="setup-wizard__header">
        <div><span className="eyebrow">STONE+ QUICK START</span><h1>{t('配置向导', 'Setup wizard')}</h1><p>{t('五个阶段完成来源接入、客户端连接和真实请求验证。', 'Connect a source and client, then verify a real request in five stages.')}</p></div>
        <div className="setup-wizard__exit"><small>{t('非敏感表单会自动保存；Key 和导入内容不会落盘。', 'Non-sensitive fields are saved automatically. Keys and import payloads are never cached.')}</small><button className="button button--secondary" type="button" disabled={oauthCommitLocked || Boolean(busy)} onClick={() => void exitWizard()}>{oauthCommitLocked ? t('正在保存账号…', 'Saving account…') : t('暂时退出', 'Exit for now')}</button></div>
      </header>

      <div className="setup-wizard__layout">
        <aside className="setup-wizard__steps" aria-label={t('配置步骤', 'Setup steps')}>
          {phases.map((item, index) => <div className={`${index === currentPhaseIndex ? 'active' : ''} ${index < currentPhaseIndex ? 'done' : ''}`} key={item.id}>
            <span>{index < currentPhaseIndex ? <CheckCircle2 size={15} /> : index + 1}</span><strong>{item.label}</strong>
          </div>)}
        </aside>

        <main className="setup-wizard__content">
          <div className="setup-wizard__phase-context" data-phase-index={currentPhaseIndex} key={`${currentPhaseId}-${currentStep}`} aria-live="polite"><span>{t(`阶段 ${currentPhaseIndex + 1} / ${phases.length}`, `Stage ${currentPhaseIndex + 1} / ${phases.length}`)}</span><strong>{setupWizardStepLabel(currentStep, t)}</strong></div>
          <div className={`setup-wizard__stage setup-wizard__stage--${stepMotionDirection}`} key={currentStep}>
          {error && <div className="setup-message setup-message--error"><CircleAlert size={17} /><span>{error}</span></div>}
          {notice && <div className="setup-message setup-message--success"><CheckCircle2 size={17} /><span>{notice}</span></div>}

          {currentStep === 'scan' && <WizardSection icon={<Gauge />} title={t('先检查当前环境', 'Check your environment first')} description={t('真实检查网络出口、四类客户端配置和现有 Stone+ 资源，不会修改任何文件。', 'Check the network exit, all four client configurations, and existing Stone+ resources without changing files.')}>
            <ScanSummary snapshot={snapshot} scan={environmentScan} />
            {environmentScan && <ScanDetails scan={environmentScan} />}
            {!environmentScan
              ? <PrimaryAction busy={busy === 'scan'} disabled={Boolean(busy)} onClick={() => void scan()} label={t('开始检查', 'Start checks')} icon={<RefreshCw size={16} />} />
              : <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void scan()}>{busy === 'scan' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('重新检查', 'Run again')}</button><PrimaryAction busy={false} disabled={Boolean(busy)} onClick={() => void move('source')} label={t('下一步：添加来源', 'Next: add a source')} /></div>}
          </WizardSection>}

          {currentStep === 'source' && <WizardSection icon={<Waypoints />} title={t('你准备使用什么来源？', 'What kind of source will you use?')} description={t('可以导入订阅账号、添加 API，也可以复用已有配置。', 'Import a subscription account, add an API, or reuse an existing configuration.')}>
            <div className="setup-choice-grid">
              <Choice icon={<ShieldCheck />} title={t('ChatGPT / Codex 账号', 'ChatGPT / Codex account')} description={t('推荐使用浏览器登录，也支持 Sub2API / CPA JSON 或 Token 导入', 'Browser sign-in is recommended; Sub2API / CPA JSON and token imports are also supported')} onClick={() => chooseMode('oauth-import')} disabled={Boolean(busy)} />
              <Choice icon={<Cloud />} title={t('官方 API', 'Official API')} description={t('OpenAI、xAI、Anthropic 或 Google Gemini', 'OpenAI, xAI, Anthropic, or Google Gemini')} onClick={() => chooseMode('official-api')} disabled={Boolean(busy)} />
              <Choice icon={<Server />} title={t('API 中转站', 'API relay')} description={t('填写中转地址、兼容协议和一把 Key', 'Enter the relay address, compatible protocol, and one API key')} onClick={() => chooseMode('relay')} disabled={Boolean(busy)} />
              <Choice icon={<KeyRound />} title={t('使用已添加来源', 'Use an existing source')} description={t(`已有 ${setupEligibleAccounts.length} 个可用来源`, `${setupEligibleAccounts.length} source(s) are ready`)} onClick={() => chooseMode('existing')} disabled={Boolean(busy) || !setupEligibleAccounts.length} />
              <Choice icon={<Network />} title={t('使用聚合中转', 'Use an aggregate relay')} description={t(`已有 ${aggregatePools.length} 个可用聚合`, `${aggregatePools.length} aggregate relay(s) are ready`)} onClick={() => chooseMode('aggregate')} disabled={Boolean(busy) || !aggregatePools.length} />
            </div>
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'existing' && <WizardSection icon={<KeyRound />} title={t('选择已有来源', 'Choose an existing source')} description={t('向导会重新检查账号状态和模型。', 'The wizard will check the account status and models again.')}>
            <select className="setup-select" value={selectedAccountId} disabled={Boolean(busy)} onChange={(event) => { setSelectedAccountId(event.target.value); setModel('') }}>
              <option value="">{t('选择来源', 'Choose a source')}</option>
              {setupEligibleAccounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {providerById.get(account.providerId)?.name}</option>)}
            </select>
            <PrimaryAction disabled={Boolean(busy) || !selectedAccountId} busy={false} onClick={() => void selectExisting()} label={t('使用此来源', 'Use this source')} />
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'aggregate' && <WizardSection icon={<Network />} title={t('选择聚合中转', 'Choose an aggregate relay')} description={t('路由将直接复用聚合中转的成员和策略。', 'The route will reuse the aggregate relay members and scheduling policy.')}>
            <div className="setup-form-grid">
              <label className="full"><span>{t('聚合中转', 'Aggregate relay')}</span><select value={aggregatePoolId} disabled={Boolean(busy)} onChange={(event) => { setAggregatePoolId(event.target.value); setAggregateMemberId(''); setModel('') }}><option value="">{t('选择聚合中转', 'Choose an aggregate relay')}</option>{aggregatePools.map((pool) => <option value={pool.id} key={pool.id}>{setupPoolDisplayName(pool.name, t)} · {protocolLabels[pool.protocol]} · {t(`${pool.members.length} 个成员`, `${pool.members.length} member(s)`)}</option>)}</select></label>
              {selectedAggregate && <label className="full"><span>{t('先用哪个成员做来源验证', 'Member used for the source check')}</span><select value={aggregateMemberId} disabled={Boolean(busy)} onChange={(event) => { setAggregateMemberId(event.target.value); setModel('') }}><option value="">{t('选择验证成员', 'Choose a member')}</option>{aggregateCandidates.map(({ account, provider }) => <option value={account.id} key={account.id}>{account.name} · {provider?.name ?? t('未知来源', 'Unknown source')} · {t('可用', 'Ready')}</option>)}</select><small>{t(`当前 ${aggregateCandidates.length} 个启用成员可验证。这里只决定先检查谁；最终端到端测试仍会经过聚合调度。`, `${aggregateCandidates.length} enabled member(s) can be checked. This only chooses the initial source check; the final end-to-end test still uses aggregate scheduling.`)}</small></label>}
            </div>
            {selectedAggregate && <SummaryRows rows={[[t('调度策略', 'Scheduling'), selectedAggregate.strategy], [t('启用且可用', 'Enabled and ready'), String(aggregateCandidates.length)], [t('成员总数', 'Total members'), String(selectedAggregate.members.length)]]} />}
            <PrimaryAction disabled={Boolean(busy) || !aggregatePoolId || !aggregateMemberId} busy={false} onClick={() => void selectAggregate()} label={t('使用此聚合', 'Use this aggregate')} />
          </WizardSection>}

          {currentStep === 'source-config' && sourceMode === 'oauth-import' && <WizardSection icon={<ShieldCheck />} title={t('添加 Codex 账号', 'Add a Codex account')} description={t('先完成 OAuth 授权或选择 JSON 文件；账号归类与网络设置可在下方按需展开。', 'Authorize with OAuth or select a JSON file. Expand the optional section to organize the account or choose its network exit.')}>
            <div className="setup-account-method-tabs" role="tablist" aria-label={t('Codex 账号添加方式', 'Ways to add a Codex account')}>
              <button type="button" role="tab" aria-selected={accountAddMethod === 'oauth'} className={accountAddMethod === 'oauth' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => void switchAccountAddMethod('oauth')}><ShieldCheck size={18} /><span><strong>{t('OAuth 授权', 'OAuth authorization')}</strong><small>{t('系统浏览器登录，推荐', 'Sign in with your system browser; recommended')}</small></span></button>
              <button type="button" role="tab" aria-selected={accountAddMethod === 'token-json'} className={accountAddMethod === 'token-json' ? 'active' : ''} disabled={importConfigurationLocked} onClick={() => void switchAccountAddMethod('token-json')}><Files size={18} /><span><strong>Token / JSON</strong><small>{t('Sub2API / CPA 兼容导入', 'Compatible Sub2API / CPA import')}</small></span></button>
            </div>

            <details className="setup-account-shared">
              <summary><div><strong>{t('账号归类与网络（可选）', 'Account organization and network (optional)')}</strong><span>{t('截图中的“备注”已适配为 Stone+ Tag，授权和导入使用相同设置。', 'Stone+ uses tags in place of the note field shown in some tools. OAuth and file imports share these settings.')}</span></div><span className="setup-account-shared__summary-side">{importConfigurationLocked && <Badge tone="info">{t('授权期间已锁定', 'Locked during authorization')}</Badge>}<ChevronDown size={17} /></span></summary>
              <div className="setup-account-shared__body">
              <div className="setup-form-grid">
                <label><span><Tag size={13} />{t('账号 Tag（代替备注）', 'Account tag (replaces notes)')}</span><select value={tagId ?? ''} disabled={importConfigurationLocked} onChange={(event) => { const value = event.target.value || null; setTagId(value); void move('source-config', { sourceMethod: accountAddMethod, tagId: value }) }}><option value="">{t('未标记', 'Untagged')}</option>{snapshot.accountTags.map((tag) => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select><small>{t('同一账号仅使用一个 Tag；未标记会清空重复账号原 Tag。', 'An account can have one tag. Choosing Untagged clears the existing tag on a duplicate account.')}</small></label>
                <label><span>{t('导入后加入号池（可选）', 'Add to a pool after import (optional)')}</span><select value={poolId ?? ''} disabled={importConfigurationLocked} onChange={(event) => { const value = event.target.value || null; setPoolId(value); void move('source-config', { sourceMethod: accountAddMethod, poolId: value }) }}><option value="">{t('不加入号池', 'Do not add to a pool')}</option>{compatiblePools.map((pool) => <option value={pool.id} key={pool.id}>{setupPoolDisplayName(pool.name, t)} · {t(`${pool.members.length} 个成员`, `${pool.members.length} member(s)`)} · {pool.strategy}</option>)}</select><small>{t('仅列出普通 OpenAI Responses 号池；只加入检测成功账号。', 'Only standard OpenAI Responses pools are listed, and only accounts that pass checks are added.')}</small></label>
                <label className="full"><span>{t('快速新建 Tag', 'Create a tag')}</span><div className="setup-inline-create"><input maxLength={24} disabled={importConfigurationLocked} value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder={t('自定义 Tag', 'Custom tag')} /><button className="button button--secondary" type="button" disabled={importConfigurationLocked || !newTagName.trim() || Boolean(busy)} onClick={() => void createImportTag()}>{busy === 'create-tag' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{t('新建并选中', 'Create and select')}</button></div></label>
                <label><span>{accountAddMethod === 'oauth' ? t('Token 交换与后续检测代理', 'Proxy for token exchange and checks') : t('代理', 'Proxy')}</span><select value={proxyId} disabled={importConfigurationLocked || builtInProxyInterlocked} onChange={(event) => { const value = event.target.value; setProxyId(value); void move('source-config', { sourceMethod: accountAddMethod, proxyId: value || null }) }}><option value="">{t('Stone+ 直连 / 全局出口设置', 'Direct / global outbound setting')}</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}</select><small>{builtInProxyInterlocked ? t(BUILT_IN_PROXY_BINDING_NOTICE.zh, BUILT_IN_PROXY_BINDING_NOTICE.en) : accountAddMethod === 'oauth' ? t('系统浏览器使用自身网络；此选择只用于 Token 交换、检测和后续上游请求。', 'Your system browser uses its own network. This proxy is only used for token exchange, account checks, and later upstream requests.') : t('所选代理用于导入后的账号检测和后续上游请求。', 'The selected proxy is used to check imported accounts and for later upstream requests.')}</small></label>
                <label><span>{t('账号名称（可选）', 'Account name (optional)')}</span><input value={accountName} disabled={importConfigurationLocked} onChange={(event) => setAccountName(event.target.value)} placeholder={t('留空则使用账号邮箱', 'Leave blank to use the account email')} /></label>
              </div>
              </div>
            </details>

            {accountAddMethod === 'oauth' ? <section className="setup-oauth-flow" role="tabpanel" aria-label={t('OAuth 授权添加账号', 'Add an account with OAuth')}>
              {(oauthStage === 'idle' || oauthStage === 'starting') && <div className="setup-oauth-intro"><span><ShieldCheck size={24} /></span><div><h3>{oauthStage === 'starting' ? t('正在创建安全授权会话', 'Creating a secure authorization session') : t('使用 OpenAI OAuth 添加 Codex 账号', 'Add a Codex account with OpenAI OAuth')}</h3><p>{oauthStage === 'starting' ? t('正在准备 PKCE 授权链接和本机回调监听…', 'Preparing the PKCE authorization link and local callback listener…') : t('Stone+ 会在系统浏览器打开 OpenAI 登录页；授权成功后自动保存、检测，并进入网络出口步骤。', 'Stone+ opens the OpenAI sign-in page in your system browser. After authorization, it saves and checks the account, then continues to the network step.')}</p></div>{oauthStage === 'starting' ? <LoaderCircle size={20} className="spin" /> : <button className="button button--primary" type="button" onClick={() => void startWizardOAuth()}><ShieldCheck size={16} />{t('开始 OAuth 授权', 'Start OAuth authorization')}</button>}</div>}

              {(oauthStage === 'waiting' || oauthStage === 'submitting' || oauthStage === 'exchanging' || oauthStage === 'cancelling') && oauthSession && <div className="setup-oauth-waiting">
                <div className="setup-oauth-heading"><div><span className="setup-oauth-pulse" /><div><h3>{oauthStage === 'exchanging' ? t('正在交换 Token 并检测账号', 'Exchanging the token and checking the account') : oauthStage === 'submitting' ? t('正在提交回调地址', 'Submitting the callback URL') : oauthStage === 'cancelling' ? t('正在取消授权', 'Cancelling authorization') : t('等待 OpenAI 授权回调', 'Waiting for the OpenAI callback')}</h3><p>{oauthStage === 'exchanging' ? t('回调已接收，请保持向导开启。', 'The callback was received. Keep this wizard open.') : t('请在系统浏览器完成登录与授权。', 'Complete sign-in and authorization in your system browser.')}</p></div></div><Badge tone={oauthSession.loopbackListening ? 'success' : 'warning'}>{oauthSession.loopbackListening ? t('自动回调监听中', 'Listening for automatic callback') : t('需要手工回调', 'Manual callback required')}</Badge></div>
                <div className="setup-oauth-status"><span><Link2 size={14} /><strong>{oauthSession.loopbackListening ? t('本机回调已就绪', 'Local callback ready') : t('本机端口不可用', 'Local port unavailable')}</strong><small>{oauthSession.redirectUri}</small></span><span><Clock3 size={14} /><strong>{oauthExpiresInSeconds > 0 ? `${Math.floor(oauthExpiresInSeconds / 60)}:${String(oauthExpiresInSeconds % 60).padStart(2, '0')}` : t('即将过期', 'Expiring soon')}</strong><small>{t('授权会话剩余时间', 'Authorization session time remaining')}</small></span></div>
                <label className="setup-oauth-link"><span>{t('授权链接', 'Authorization link')}</span><div><input className="mono" readOnly value={oauthSession.authorizationUrl} /><button className="icon-button" type="button" aria-label={t('复制 OAuth 授权链接', 'Copy OAuth authorization link')} onClick={() => void copyOAuthAuthorizationUrl()}>{oauthCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}</button></div></label>
                <div className="setup-actions"><button className="button button--secondary" type="button" disabled={oauthStage === 'cancelling' || oauthCommitLocked} onClick={() => void cancelWizardOAuth()}>{oauthStage === 'cancelling' || oauthCommitLocked ? <LoaderCircle size={16} className="spin" /> : <XCircle size={16} />}{oauthCommitLocked ? t('正在保存（不可取消）', 'Saving (cannot cancel)') : oauthStage === 'cancelling' ? t('正在取消…', 'Cancelling…') : t('取消授权', 'Cancel authorization')}</button><button className="button button--primary" type="button" disabled={oauthOpenBusy || oauthStage !== 'waiting'} onClick={() => void openOAuthInSystemBrowser()}>{oauthOpenBusy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{oauthOpenBusy ? t('正在打开…', 'Opening…') : t('打开系统浏览器', 'Open system browser')}</button></div>
                {oauthOpenHint && <div className="setup-oauth-message"><CircleAlert size={14} /><span>{oauthOpenHint}</span></div>}
                <div className="setup-oauth-callback"><div><strong>{t('浏览器没有自动返回？', 'Did the browser fail to return automatically?')}</strong><span>{t('复制跳转后的完整 localhost 回调 URL，粘贴到下方继续。', 'Copy the complete localhost callback URL after the redirect and paste it below.')}</span></div><textarea className="mono" rows={3} value={oauthCallbackUrl} disabled={oauthStage !== 'waiting'} onChange={(event) => setOauthCallbackUrl(event.target.value)} placeholder={`${oauthSession.redirectUri}?code=...&state=...`} aria-label={t('完整 OAuth 回调 URL', 'Complete OAuth callback URL')} /><div>{oauthCallbackError && <small className="danger">{oauthCallbackError}</small>}<button className="button button--secondary" type="button" disabled={!oauthCallbackUrl.trim() || oauthStage !== 'waiting'} onClick={() => void submitOAuthCallback()}><Link2 size={15} />{t('提交完整回调 URL', 'Submit callback URL')}</button></div></div>
              </div>}

              {oauthStage === 'error' && <div className="setup-oauth-result setup-oauth-result--error"><CircleAlert size={24} /><div><h3>{t('OAuth 授权未完成', 'OAuth authorization did not complete')}</h3><p>{oauthError || t('授权会话已结束，请重新开始。', 'The authorization session ended. Start again.')}</p></div><button className="button button--secondary" type="button" onClick={() => void startWizardOAuth()}><RefreshCw size={15} />{t('重试授权', 'Retry authorization')}</button><button className="text-button" type="button" onClick={() => void switchAccountAddMethod('token-json')}>{t('改用 Token / JSON', 'Use Token / JSON instead')}</button></div>}
              {oauthStage === 'success' && <div className="setup-oauth-result setup-oauth-result--success"><CheckCircle2 size={24} /><div><h3>{t('Codex 账号已保存', 'Codex account saved')}</h3><p>{t('账号、Tag 与号池设置已完成，正在进入网络出口检查。', 'The account, tag, and pool settings are complete. Continuing to the network exit check.')}</p></div></div>}
              {oauthStage === 'cancelled' && <div className="setup-oauth-result"><XCircle size={24} /><div><h3>{t('本次授权已取消', 'Authorization cancelled')}</h3><p>{t('未保存回调或新账号，可以重新授权或返回上一步。', 'No callback or new account was saved. You can authorize again or return to the previous step.')}</p></div><button className="button button--secondary" type="button" onClick={() => void startWizardOAuth()}><RefreshCw size={15} />{t('重新授权', 'Authorize again')}</button></div>}
            </section> : <section className="setup-token-import" role="tabpanel" aria-label={t('Token 或 JSON 导入账号', 'Import accounts from Token or JSON')}>
              <div className="setup-token-import__heading"><Files size={20} /><div><strong>{t('导入 Sub2API / CPA', 'Import Sub2API / CPA')}</strong><span>{t('支持多文件、JSON、逐行 JSON 和 Access Token；完成后立即检测并进入网络出口步骤。', 'Supports multiple files, JSON, line-delimited JSON, and access tokens. Imported accounts are checked before continuing to the network step.')}</span></div><button className="button button--primary" disabled={Boolean(busy)} type="button" onClick={() => void importTokenJson(true)}><FileJson2 size={16} />{t('选择多个 JSON', 'Choose JSON files')}</button></div>
              <label className="setup-field"><span>{t('粘贴 JSON / Token', 'Paste JSON / Token')}</span><textarea className="mono" rows={9} value={importContent} onChange={(event) => setImportContent(event.target.value)} placeholder={t('粘贴 CPA 对象、Sub2API 导出、数组、逐行 JSON 或 Access Token', 'Paste a CPA object, Sub2API export, array, line-delimited JSON, or access token')} /></label>
              <PrimaryAction disabled={Boolean(busy) || !importContent.trim()} busy={busy === 'import'} onClick={() => void importTokenJson(false)} label={t('导入并检测', 'Import and check')} />
            </section>}
          </WizardSection>}

          {currentStep === 'source-config' && (sourceMode === 'official-api' || sourceMode === 'relay') && <WizardSection icon={<Server />} title={sourceDraft.kind === KIRO_COMPATIBLE_KIND ? t('配置 Kiro Claude 中转', 'Configure Kiro Claude relay') : sourceMode === 'official-api' ? t('配置官方 API', 'Configure official API') : t('配置中转站', 'Configure relay')} description={sourceDraft.kind === KIRO_COMPATIBLE_KIND ? t('填写完整端点、Key 和模型，并完成真实两轮工具链测试。', 'Enter the full endpoint, key, and model, then run the real two-round tool test.') : t('先完成真实请求测试，再保存到本机安全存储。', 'Run a real request test before saving the source to secure local storage.')}>
            <ApiSourceForm
              draft={sourceDraft}
              proxyId={proxyId}
              proxies={snapshot.proxies}
              proxyInterlocked={builtInProxyInterlocked}
              onProxyChange={(next) => {
                proxyIdRef.current = next
                setProxyId(next)
              }}
              onChange={(next) => {
                sourceDraftRef.current = next
                setSourceDraft(next)
              }}
              onVendor={applyOfficialVendor}
              official={sourceMode === 'official-api'}
            />
            {currentProbe && <ProbeResult result={currentProbe} />}
            {probe && !currentProbe && <div className="setup-message setup-message--error"><CircleAlert size={17} /><span>{t('来源配置已变更，原测试结果已失效。', 'The source changed, so the previous test result is no longer valid.')}</span></div>}
            <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void probeDraft()}>{busy === 'probe' ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{sourceDraft.kind === KIRO_COMPATIBLE_KIND ? t('测试 Kiro 工具链', 'Test Kiro tool chain') : t('测试连接', 'Test connection')}</button><PrimaryAction disabled={Boolean(busy) || !currentProbe?.ok} busy={busy === 'save-source'} onClick={() => void saveDraft()} label={t('保存并继续', 'Save and continue')} /></div>
          </WizardSection>}

          {currentStep === 'network' && <WizardSection icon={<Router />} title={t('验证这个来源', 'Verify this source')} description={t('一次完成网络出口、账号状态、模型发现和最小真实请求。', 'Check the network exit, account status, model discovery, and a minimal real request in one action.')}>
            <label className="setup-field"><span>{t('代理', 'Proxy')}</span><select value={proxyId} disabled={builtInProxyInterlocked || Boolean(busy)} onChange={(event) => setProxyId(event.target.value)}><option value="">{t('直连 / 跟随全局网络设置', 'Direct / use global network setting')}</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()}</option>)}</select>{builtInProxyInterlocked && <small>{t(BUILT_IN_PROXY_BINDING_NOTICE.zh, BUILT_IN_PROXY_BINDING_NOTICE.en)}</small>}</label>
            <ModelChoice value={model} options={modelOptions} disabled={Boolean(busy)} onChange={setModel} />
            <PrimaryAction busy={busy === 'network'} disabled={Boolean(busy)} onClick={() => void checkNetwork()} label={t('验证来源并继续', 'Verify source and continue')} icon={<ShieldCheck size={16} />} />
          </WizardSection>}

          {currentStep === 'upstream-test' && <WizardSection icon={<ShieldCheck />} title={t('验证账号与模型', 'Verify the account and model')} description={t('这一步会发送一次极小的真实模型请求。', 'This step sends one very small real model request.')}>
            <ModelChoice value={model} options={modelOptions} disabled={Boolean(busy)} onChange={setModel} />
            <PrimaryAction busy={busy === 'upstream'} disabled={Boolean(busy)} onClick={() => void verifyExistingSource()} label={t('发送真实测试', 'Send real test')} icon={<Play size={16} />} />
          </WizardSection>}

          {currentStep === 'client' && <WizardSection icon={<Settings2 />} title={t('选择主客户端', 'Choose your primary client')} description={t('向导一次配置一个客户端，完成后可以继续配置其他客户端。', 'The wizard configures one client at a time. You can add more after this setup.')}>
            <div className="setup-choice-grid setup-choice-grid--clients">{(['codex', 'claude', 'gemini', 'grokbuild'] as RouteClient[]).map((item) => {
              const brand = clientBrandMeta[item]
              return <Choice key={item} icon={<img className={brand.iconClassName} src={brand.icon} alt="" />} title={clientLabels[item]} description={item === 'codex' ? t('推荐用于 OAuth / Responses 来源', 'Recommended for OAuth / Responses sources') : item === 'grokbuild' ? t('仅连接原生 Responses 的 Grok 号池或中转站', 'Connects only to Responses-native Grok pools or relays') : t(`通过 Stone+ 协议转换接入 ${clientLabels[item]}`, `Connect ${clientLabels[item]} through Stone+ protocol conversion`)} selected={client === item} onClick={() => setClient(item)} disabled={Boolean(busy) || (item === 'grokbuild' && !selectedSourceIsGrok) || (selectedSourceIsKiroClaude && item !== 'claude')} />
            })}</div>
            {!selectedSourceIsGrok && <small>{t('当前来源不是 Grok 原生 Responses 来源，因此不能选择 Grok Build。', 'The current source is not a Responses-native Grok source, so Grok Build is unavailable.')}</small>}
            {selectedSourceIsKiroClaude && <small>{t('Kiro Claude 使用 Anthropic Messages 入站并直转 AWS Event Stream，仅支持 Claude Code CLI、Desktop 与 VSC。', 'Kiro Claude accepts Anthropic Messages and translates directly to AWS Event Stream. It is available only to Claude Code CLI, Desktop, and VSC.')}</small>}
            <PrimaryAction busy={false} disabled={Boolean(busy) || (client === 'grokbuild' && !selectedSourceIsGrok) || (selectedSourceIsKiroClaude && client !== 'claude')} onClick={() => void move('routing', { client, model })} label={t('下一步：确认连接', 'Next: confirm connection')} />
          </WizardSection>}

          {currentStep === 'routing' && <WizardSection icon={<Waypoints />} title={t('建立连接并自动验证', 'Connect and verify automatically')} description={t('确认后 Stone+ 会连续完成号池与路由、网关启动和端到端真实请求。', 'Stone+ will create the pool and route, start the gateway, and run a real end-to-end request in one sequence.')}>
            <SummaryRows rows={[[t('来源', 'Source'), selectedSourceName], [t('客户端', 'Client'), clientLabels[client]], [t('模型', 'Model'), model || t('未选择', 'Not selected')], [t('目标号池', 'Target pool'), snapshot.pools.find((pool) => pool.id === (aggregatePoolId || poolId))?.name ?? t('自动创建或复用', 'Create or reuse automatically')]]} />
            <div className="setup-auto-flow"><span><CheckCircle2 size={16} />{t('原子创建或复用号池与客户端路由', 'Atomically create or reuse the pool and client route')}</span><span><CheckCircle2 size={16} />{t('启动本地网关；端口冲突时自动选择可用端口', 'Start the local gateway and select an available port if needed')}</span><span><CheckCircle2 size={16} />{t('通过本地鉴权、调度和协议转换发送真实请求', 'Send a real request through local authentication, scheduling, and protocol conversion')}</span></div>
            <PrimaryAction busy={busy === 'connect'} disabled={Boolean(busy)} onClick={() => void createRouting()} label={t('一键连接并验证', 'Connect and verify')} />
          </WizardSection>}

          {currentStep === 'gateway' && <WizardSection icon={<Server />} title={t('启动本地网关', 'Start the local gateway')} description={t('默认监听 127.0.0.1:15721；端口冲突时会选择相邻可用端口。', 'The default is 127.0.0.1:15721. If that port is busy, Stone+ chooses a nearby available port.')}>
            <SummaryRows rows={[[t('监听地址', 'Listen address'), `${snapshot.gateway.host}:${snapshot.gateway.port}`], [t('当前状态', 'Current status'), snapshot.gatewayStatus.running ? t('运行中', 'Running') : t('已停止', 'Stopped')], [t('号池', 'Pool'), effectivePool ? setupPoolDisplayName(effectivePool.name, t) : t('已配置', 'Configured')]]} />
            <PrimaryAction busy={busy === 'gateway'} disabled={Boolean(busy)} onClick={() => void startGateway()} label={t('确保网关运行', 'Ensure gateway is running')} />
          </WizardSection>}

          {currentStep === 'verify' && <WizardSection icon={<Play />} title={t('完成端到端真实请求', 'Run a real end-to-end request')} description={t('验证本地鉴权、路由、调度、协议转换和上游响应。', 'Verify local authentication, routing, scheduling, protocol conversion, and the upstream response.')}>
            <ModelChoice value={model} options={modelOptions} disabled={Boolean(busy)} onChange={setModel} />
            {verification && <SummaryRows rows={[[t('结果', 'Result'), verification.ok ? t('成功', 'Success') : t('失败', 'Failed')], [t('耗时', 'Duration'), `${verification.latencyMs} ms`], [t('响应', 'Response'), verification.responsePreview ?? verification.error ?? '—']]} />}
            <PrimaryAction busy={busy === 'verify'} disabled={Boolean(busy)} onClick={() => void verifyRoute()} label={t('运行端到端验证', 'Run end-to-end test')} />
          </WizardSection>}

          {currentStep === 'client-config' && <WizardSection icon={<Settings2 />} title={t('连接客户端（可选）', 'Connect the client (optional)')} description={t('可以先预览并备份配置，也可以跳过后手动处理。', 'Preview and back up the configuration now, or skip this step and configure it manually later.')}>
            <SummaryRows rows={[[t('已验证来源', 'Verified source'), selectedSourceName], [t('号池', 'Pool'), effectivePool ? setupPoolDisplayName(effectivePool.name, t) : t('已配置', 'Configured')], [t('本地网关', 'Local gateway'), `http://${connectedGatewayHost}:${connectedGatewayPort}`], [t('真实请求', 'Real request'), verification ? t(`已通过 · ${verification.latencyMs} ms`, `Passed · ${verification.latencyMs} ms`) : t('已通过', 'Passed')]]} />
            {snapshot.clientProfiles.some((profile) => profile.client === client) && <label className="setup-field"><span>{t('配置目录', 'Configuration directory')}</span><select value={clientProfileId} disabled={Boolean(busy)} onChange={(event) => { setClientProfileId(event.target.value); setPreviewText(''); void move('client-config', { profileId: event.target.value || null }) }}>{snapshot.clientProfiles.filter((profile) => profile.client === client).map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.directory || t('默认目录', 'Default directory')}</option>)}</select><small>{t('向导只会写入所选目录的 Stone+ 受管连接字段；托管实例和高级字段请在客户端页配置。', 'The wizard writes only Stone+-managed connection fields in the selected directory. Configure managed instances and advanced fields on the Clients page.')}</small></label>}
            {previewText && <pre className="setup-preview">{previewText}</pre>}
            <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void previewClient()}>{t('预览配置', 'Preview configuration')}</button><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void finish()}>{t('暂时跳过', 'Skip for now')}</button><PrimaryAction busy={busy === 'apply-client'} disabled={Boolean(busy)} onClick={() => void applyClient()} label={t('应用并备份', 'Apply and back up')} /></div>
          </WizardSection>}

          {currentStep === 'complete' && <WizardSection icon={<CheckCircle2 />} title={t('配置已经跑通', 'Setup is working')} description={t('Stone+ 已完成一次从本地网关到上游模型的真实请求。', 'Stone+ completed a real request from the local gateway to the upstream model.')}>
            <SummaryRows rows={[[t('来源', 'Source'), selectedSourceName], [t('客户端', 'Client'), clientLabels[client]], [t('模型', 'Model'), model], [t('号池', 'Pool'), effectivePool ? setupPoolDisplayName(effectivePool.name, t) : t('已配置', 'Configured')], [t('本地网关', 'Local gateway'), `http://${connectedGatewayHost}:${connectedGatewayPort}`], [t('测试耗时', 'Test duration'), verification ? `${verification.latencyMs} ms` : t('已验证', 'Verified')]]} />
            <div className="setup-actions"><button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void configureAnotherSource()}>{busy === 'restart' ? <LoaderCircle size={16} className="spin" /> : null}{t('继续配置另一个来源', 'Configure another source')}</button><button className="button button--primary" type="button" disabled={Boolean(busy)} onClick={() => void exitWizard()}>{t('返回总览', 'Return to overview')}</button></div>
          </WizardSection>}
          </div>

          {currentStep !== 'complete' && <footer className="setup-wizard__footer"><button className="text-button" type="button" disabled={currentIndex === 0 || Boolean(busy) || oauthCommitLocked} onClick={() => void back()}><ArrowLeft size={15} />{t('上一步', 'Previous')}</button><button className="text-button danger" type="button" disabled={Boolean(busy) || oauthCommitLocked} onClick={() => setDiscardConfirmOpen(true)}>{t('放弃连接配置', 'Discard connection setup')}</button></footer>}
        </main>
      </div>
      <ConfirmDialog
        open={discardConfirmOpen}
        title={t('放弃本次连接配置？', 'Discard this connection setup?')}
        message={t(
          '为避免误删凭据，已导入账号和已保存的 API / 中转来源会保留；本向导创建或修改的号池与路由会安全回滚。',
          'Imported accounts and saved API or relay sources are kept to avoid deleting credentials. Pools and routes created or changed by this setup are safely rolled back.',
        )}
        confirmLabel={t('确认放弃', 'Discard setup')}
        busy={busy === 'discard'}
        onCancel={() => setDiscardConfirmOpen(false)}
        onConfirm={() => void discard()}
      />
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

function ScanSummary({ snapshot, scan }: { snapshot: AppSnapshot; scan: SetupEnvironmentScan | null }) {
  const { t } = useI18n()
  const usable = snapshot.accounts.filter((account) => account.status === 'active').length
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled).length
  const configuredClients = scan?.clients.filter((client) => client.configured).length ?? 0
  const networkLabel = !scan
    ? t('待检查', 'Not checked')
    : scan.network.summary === 'success'
      ? t('正常', 'Ready')
      : scan.network.summary === 'warning'
        ? t('有警告', 'Warning')
        : t('需处理', 'Needs attention')
  return <div className="setup-metrics"><div><span>{t('网络出口', 'Network exit')}</span><strong>{networkLabel}</strong></div><div><span>{t('客户端配置', 'Client configs')}</span><strong>{scan?.clientScanFailed ? t('检测失败', 'Check failed') : scan ? `${configuredClients} / ${scan.clients.length}` : '—'}</strong></div><div><span>{t('可用来源', 'Usable sources')}</span><strong>{usable}</strong></div><div><span>{t('现有连接', 'Existing connections')}</span><strong>{t(`${enabledRoutes} 条路由`, `${enabledRoutes} route(s)`)}</strong></div></div>
}

function ScanDetails({ scan }: { scan: SetupEnvironmentScan }) {
  const { t } = useI18n()
  return <div className="setup-scan-details">
    <section><header><strong>{t('网络检查', 'Network checks')}</strong><span>{scan.network.route.name}</span></header><div>{scan.network.results.map((result) => <span className={`setup-scan-item setup-scan-item--${result.status}`} key={result.id}><i /> <b>{result.label}</b><small>{result.status === 'success' ? t('正常', 'Ready') : result.message}{result.latencyMs > 0 ? ` · ${result.latencyMs} ms` : ''}</small></span>)}</div>{scan.network.diagnoses.length > 0 && <p><CircleAlert size={14} />{scan.network.diagnoses[0]}</p>}</section>
    <section><header><strong>{t('客户端配置', 'Client configurations')}</strong><span>{scan.clientScanFailed ? t('本次未完成检测', 'Detection did not finish') : t('只读检查，不修改文件', 'Read-only; no files changed')}</span></header><div>{scan.clientScanFailed
      ? <span className="setup-scan-item setup-scan-item--warning"><i /><b>{t('稍后可在客户端配置页重试', 'Retry later on the Clients page')}</b></span>
      : scan.clients.map((config) => <span className={`setup-scan-item setup-scan-item--${config.configured ? 'success' : 'skipped'}`} key={`${config.client}:${config.directory}`}><i /><b>{clientLabels[config.client]}</b><small>{config.configured ? t('已配置', 'Configured') : config.directoryExists ? t('检测到目录，尚未连接 Stone+', 'Directory found; not connected to Stone+') : t('未检测到配置目录', 'Configuration directory not found')}</small></span>)}</div></section>
  </div>
}

function ApiSourceForm({ draft, proxies, proxyId, proxyInterlocked, official, onChange, onProxyChange, onVendor }: { draft: ApiSourceInput; proxies: AppSnapshot['proxies']; proxyId: string; proxyInterlocked: boolean; official: boolean; onChange: (value: ApiSourceInput) => void; onProxyChange: (value: string) => void; onVendor: (kind: ProviderKind) => void }) {
  const { t } = useI18n()
  const compatibleKinds: ProviderKind[] = [XAI_COMPATIBLE_KIND, KIRO_COMPATIBLE_KIND, 'openai-compatible', 'anthropic-compatible', 'custom']
  const protocols = official && draft.kind === 'xai'
    ? ['openai-responses'] as const
    : protocolsByProviderKind[draft.kind]
  const compactMode = effectiveResponsesCompactMode(draft.responsesCompactMode)
  const compactCopy = responsesCompactModeCopy[compactMode]
  return <div className="setup-form-grid">
    {official && <label><span>{t('官方厂商', 'Official provider')}</span><select value={draft.kind} onChange={(event) => onVendor(event.target.value as ProviderKind)}><option value="openai">OpenAI</option><option value="xai">Grok / xAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label>}
    {!official && <label><span>{t('兼容类型', 'Compatibility type')}</span><select value={draft.kind} onChange={(event) => {
      const kind = event.target.value as ProviderKind
      const protocol = protocolAfterProviderKindChange(kind, draft.protocol)
      onChange({
        ...draft,
        kind,
        protocol,
        responsesCompactMode: relayCanConfigureResponsesCompact(draft.sourceType, protocol)
          ? effectiveResponsesCompactMode(draft.responsesCompactMode)
          : undefined,
      })
    }}>{compatibleKinds.map((kind) => <option value={kind} key={kind}>{t(providerKindLabelsZh[kind], providerKindLabelsEn[kind])}</option>)}</select></label>}
    <label><span>{t('显示名称', 'Display name')}</span><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
    <label className="full"><span>{draft.kind === KIRO_COMPATIBLE_KIND ? t('完整 GenerateAssistantResponse 端点', 'Full GenerateAssistantResponse endpoint') : 'Base URL'}</span><input className="mono" disabled={official} value={draft.baseUrl} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} />{draft.kind === KIRO_COMPATIBLE_KIND && <small>{t('按原样请求此完整端点，不会拼接 /v1/messages 或 /models。', 'This exact endpoint is requested as entered; Stone+ does not append /v1/messages or /models.')}</small>}</label>
    <label><span>{t('协议', 'Protocol')}</span><select value={draft.protocol} disabled={(official && draft.kind === 'xai') || relayProtocolSelectLocked(draft.kind)} onChange={(event) => {
      const protocol = event.target.value as Protocol
      onChange({
        ...draft,
        protocol,
        responsesCompactMode: relayCanConfigureResponsesCompact(draft.sourceType, protocol)
          ? effectiveResponsesCompactMode(draft.responsesCompactMode)
          : undefined,
      })
    }}>{protocols.map((protocol) => <option value={protocol} key={protocol}>{protocolOptionLabel(draft.kind, protocol, protocolLabels, t)}</option>)}</select>{draft.kind === XAI_COMPATIBLE_KIND && <small>{t('默认使用官方当前主路径 Responses；仅当中转明确只兼容 Chat Completions 时选择高级兼容模式。', 'Responses is the current primary API path. Choose advanced Chat compatibility only when the relay explicitly requires Chat Completions.')}</small>}{draft.kind === KIRO_COMPATIBLE_KIND && <small>{t('协议固定为 Kiro Claude；保存前必须通过两轮结构化工具测试。', 'The protocol is fixed to Kiro Claude. A two-round structured tool test is required before binding.')}</small>}</label>
    {relayCanConfigureResponsesCompact(draft.sourceType, draft.protocol) && <label className="full"><span className="field-label-with-help">{t('Responses Compact 能力', 'Responses compact capability')}<InfoTip text={t(compactCopy.helpZh, compactCopy.helpEn)} /></span><select value={compactMode} onChange={(event) => onChange({ ...draft, responsesCompactMode: event.target.value as ResponsesCompactMode })}>{responsesCompactModes.map((mode) => <option value={mode} key={mode}>{t(responsesCompactModeCopy[mode].labelZh, responsesCompactModeCopy[mode].labelEn)}</option>)}</select></label>}
    {officialOpenAiUsesNativeCompact(draft.sourceType, draft.kind, draft.protocol) && <label className="full"><span className="field-label-with-help"><ShieldCheck size={13} />{t('Responses Compact 能力', 'Responses compact capability')}<InfoTip text={t('官方 OpenAI 按 Responses 协议自动使用完整原生 Compact，无需手动配置。', 'Official OpenAI automatically uses full native compact through the Responses protocol. No manual setting is needed.')} /></span><input disabled value={t('自动：完整原生 Compact', 'Automatic: full native compact')} /></label>}
    <label><span>{t('测试/默认模型', 'Test/default model')}</span><input value={draft.defaultModel ?? ''} onChange={(event) => onChange({ ...draft, defaultModel: event.target.value })} placeholder={draft.kind === KIRO_COMPATIBLE_KIND ? t('手动填写 Kiro 模型', 'Enter the Kiro model manually') : t('例如 gpt-5.4', 'For example, gpt-5.4')} />{draft.kind === KIRO_COMPATIBLE_KIND && <small>{t('Kiro Claude 不进行模型发现。', 'Kiro Claude does not use model discovery.')}</small>}</label>
    <label className="full"><span>API Key</span><input type="password" value={draft.credential ?? ''} onChange={(event) => onChange({ ...draft, credential: event.target.value })} /></label>
    <label><span>{t('最大并发', 'Max concurrency')}</span><input type="number" min={1} max={100} value={draft.maxConcurrency} onChange={(event) => onChange({ ...draft, maxConcurrency: Number(event.target.value) })} /></label>
    <label><span>{t('代理', 'Proxy')}</span><select value={proxyId} disabled={proxyInterlocked} onChange={(event) => onProxyChange(event.target.value)}><option value="">{t('直连', 'Direct')}</option>{proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name}</option>)}</select>{proxyInterlocked && <small>{t(BUILT_IN_PROXY_BINDING_NOTICE.zh, BUILT_IN_PROXY_BINDING_NOTICE.en)}</small>}</label>
  </div>
}

function ProbeResult({ result }: { result: ApiSourceProbeResult }) {
  const { t } = useI18n()
  return <div className="setup-probe"><header><strong>{t('连接诊断', 'Connection diagnostics')}</strong><Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? t('通过', 'Passed') : t('未通过', 'Failed')}</Badge></header>{result.stages.map((stage) => <div key={stage.id}><span className={`status-dot status-dot--${stage.status}`} /><strong>{stageLabel(stage.id, t)}</strong><p>{localizedProbeMessage(stage.id, stage.status, stage.message, t)}</p><small>{stage.latencyMs === undefined ? '—' : `${stage.latencyMs} ms`}</small></div>)}</div>
}

function ModelChoice({ value, options, disabled = false, onChange }: { value: string; options: string[]; disabled?: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return <label className="setup-field"><span>{t('测试模型', 'Test model')}</span><input list="setup-model-options" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={t('输入或选择模型', 'Enter or choose a model')} /><datalist id="setup-model-options">{options.map((model) => <option value={model} key={model} />)}</datalist></label>
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

function readSetupSourceDraftCache(sessionId: string): ApiSourceInput | null {
  try {
    return parseSetupSourceDraft(window.localStorage.getItem(setupWizardDraftStorageKey(sessionId)))
  } catch {
    return null
  }
}

function writeSetupSourceDraftCache(sessionId: string, draft: ApiSourceInput): void {
  try {
    window.localStorage.setItem(setupWizardDraftStorageKey(sessionId), serializeSetupSourceDraft(draft))
  } catch {
    // Draft persistence is a convenience only; setup must remain usable when storage is unavailable.
  }
}

function clearSetupSourceDraftCache(sessionId: string): void {
  try {
    window.localStorage.removeItem(setupWizardDraftStorageKey(sessionId))
  } catch {
    // Ignore unavailable renderer storage while completing or discarding setup.
  }
}

function stageLabel(id: string, t: Translate): string {
  if (id === 'network') return t('网络', 'Network')
  if (id === 'authentication') return t('认证', 'Authentication')
  if (id === 'models') return t('模型发现', 'Model discovery')
  if (id === 'tool-roundtrip') return t('两轮工具链', 'Two-round tool test')
  return t('真实生成', 'Real generation')
}

const gatewayErrorEnglish = new Map<string, string>([
  ['系统浏览器打开能力不可用。', 'Opening the system browser is unavailable.'],
  ['无法在系统浏览器中打开 OAuth 授权页面。', 'Could not open the OAuth page in the system browser.'],
  ['OAuth 授权已取消。', 'OAuth authorization was cancelled.'],
  ['OAuth 授权会话已过期，请重新开始。', 'The OAuth session expired. Start again.'],
  ['OAuth 回调地址来源不正确。', 'The OAuth callback has the wrong origin.'],
  ['回调地址路径不正确。', 'The callback URL has the wrong path.'],
  ['OAuth 回调 state 校验失败。', 'OAuth callback state validation failed.'],
  ['OAuth 回调缺少授权码。', 'The OAuth callback is missing an authorization code.'],
  ['OAuth Token 交换超时。', 'OAuth token exchange timed out.'],
  ['无法连接 OpenAI OAuth Token 服务。', 'Could not connect to the OpenAI OAuth token service.'],
  ['OAuth 授权码已失效、已使用或被拒绝，请重新授权。', 'The OAuth code expired, was already used, or was rejected. Authorize again.'],
  ['OpenAI OAuth 请求过于频繁，请稍后重试。', 'Too many OpenAI OAuth requests. Try again later.'],
  ['OpenAI OAuth Token 响应格式无效。', 'The OpenAI OAuth token response has an invalid format.'],
  ['OpenAI OAuth Token 响应缺少必要凭据。', 'The OpenAI OAuth token response is missing required credentials.'],
  ['无法从 OAuth Token 中识别 ChatGPT 账号。', 'Could not identify a ChatGPT account from the OAuth token.'],
  ['OAuth 授权会话不存在或已结束。', 'The OAuth session does not exist or has ended.'],
  ['请粘贴完整 OAuth 回调地址。', 'Paste the complete OAuth callback URL.'],
  ['OAuth 回调地址格式无效。', 'The OAuth callback URL is invalid.'],
  ['OAuth issuer 必须使用 HTTPS。', 'The OAuth issuer must use HTTPS.'],
  ['OAuth 授权会话 ID 无效。', 'The OAuth session ID is invalid.'],
  ['向导选择的来源已不存在。', 'The source selected by the wizard no longer exists.'],
  ['向导选择的来源当前不可用。', 'The source selected by the wizard is currently unavailable.'],
  ['向导选择的来源缺少上游定义。', 'The selected source is missing its upstream definition.'],
  ['选择的聚合中转已不存在。', 'The selected aggregate relay no longer exists.'],
  ['聚合中转不包含当前来源。', 'The aggregate relay does not contain the current source.'],
  ['选择的号池没有可完成向导验证的模型与基础生成能力。', 'The selected pool has no member that can serve the model and baseline generation required by the wizard.'],
  ['配置向导会话已更新，请重新打开向导。', 'The setup session changed. Reopen the wizard.'],
  ['配置向导步骤无效。', 'The setup wizard step is invalid.'],
  ['配置向导会话不存在或已过期。', 'The setup session does not exist or has expired.'],
  ['只有端到端真实请求成功后才能完成配置向导。', 'The wizard can finish only after a successful real end-to-end request.'],
  ['无法应用向导路由。', 'Could not apply the wizard route.'],
  ['端到端验证缺少向导会话或路由绑定。', 'The end-to-end test is missing its setup session or route binding.'],
  ['端到端验证目标与本次向导已应用的路由不一致。', 'The end-to-end target no longer matches the route applied by this setup.'],
  ['验证期间路由已变更，请重新运行端到端验证。', 'The route changed during verification. Run the end-to-end test again.'],
  ['不支持的账号导入代理选项。', 'The selected account-import proxy option is unsupported.'],
  ['请选择一个代理后再导入账号。', 'Choose a proxy before importing accounts.'],
  ['选择的代理已被删除，请重新选择后再导入。', 'The selected proxy was deleted. Choose another before importing.'],
])

const probeMessageEnglish = new Map<string, string>([
  ['尚未发起网络请求。', 'No network request was sent.'],
  ['请输入 API Key；编辑已有来源时可留空以保留原 Key。', 'Enter an API key. Leave it blank while editing to keep the saved key.'],
  ['缺少可用凭据，未继续检测。', 'No usable credential was provided, so remaining checks were skipped.'],
  ['来源地址无效，未继续检测。', 'The source URL is invalid, so remaining checks were skipped.'],
  ['所选供应商类型不支持当前协议。', 'The selected provider type does not support this protocol.'],
  ['协议配置无效，尚未发起网络请求。', 'The protocol configuration is invalid; no network request was sent.'],
  ['协议配置无效，未检测认证。', 'The protocol configuration is invalid; authentication was not checked.'],
  ['协议配置无效，未发起生成请求。', 'The protocol configuration is invalid; no generation request was sent.'],
  ['已连接上游服务。', 'Connected to the upstream service.'],
  ['API Key 已通过上游认证。', 'The upstream accepted the API key.'],
  ['无法连接上游服务。', 'Could not connect to the upstream service.'],
  ['网络连接失败，未继续检测。', 'The network connection failed, so remaining checks were skipped.'],
  ['上游端点已返回 HTTP 响应。', 'The upstream endpoint returned an HTTP response.'],
  ['上游拒绝了 API Key。', 'The upstream rejected the API key.'],
  ['认证未通过，未继续检测。', 'Authentication failed, so remaining checks were skipped.'],
  ['上游基础检测未通过。', 'The basic upstream check failed.'],
  ['上游已响应，但暂时无法单独确认认证状态。', 'The upstream responded, but authentication could not be confirmed independently.'],
  ['来源基础检测未能完成。', 'The basic source check could not complete.'],
  ['基础检测失败，未继续检测。', 'The basic check failed, so remaining checks were skipped.'],
  ['上游模型列表为空；可手动填写测试模型。', 'The upstream model list is empty; enter a test model manually.'],
  ['模型发现失败；可手动填写测试模型。', 'Model discovery failed; enter a test model manually.'],
  ['模型发现时认证失败，未发起生成请求。', 'Authentication failed during model discovery; no generation request was sent.'],
  ['模型发现未能完成；可手动填写测试模型。', 'Model discovery could not complete; enter a test model manually.'],
  ['未提供测试模型，且无法从上游发现可用模型。', 'No test model was provided or discovered upstream.'],
  ['最小真实生成请求已成功返回。', 'The minimal real generation request succeeded.'],
  ['真实生成请求已确认 API Key 可用。', 'A real generation request confirmed that the API key works.'],
  ['最小真实生成请求失败。', 'The minimal real generation request failed.'],
  ['最小真实生成请求未能完成。', 'The minimal real generation request could not complete.'],
  ['Base URL 仅支持 HTTP 或 HTTPS。', 'Base URL supports only HTTP or HTTPS.'],
  ['请输入有效的 Base URL。', 'Enter a valid Base URL.'],
  ['请输入有效的 HTTP(S) Base URL；裸 IP 可省略 http://。', 'Enter a valid HTTP(S) Base URL; a bare IP may omit http://.'],
  ['Base URL 不能嵌入凭据、查询参数或片段。', 'Base URL cannot include credentials, query parameters, or a fragment.'],
])

function localizedGatewayMessage(message: string, t: Translate): string {
  const translated = gatewayErrorEnglish.get(message)
  return t(message, translated ?? (containsCjk(message) ? 'The operation returned an error. Check the configuration and try again.' : message))
}

function localizedProbeMessage(id: string, status: string, message: string, t: Translate): string {
  const discovered = message.match(/^已发现 (\d+) 个可用模型。$/)
  if (discovered) return t(message, `Discovered ${discovered[1]} available model(s).`)
  const translated = probeMessageEnglish.get(message)
  if (translated) return t(message, translated)
  if (!containsCjk(message)) return message
  const englishStage = stageLabel(id, (_chinese, english) => english)
  const englishStatus = status === 'success' ? 'completed' : status === 'skipped' ? 'was skipped' : status === 'warning' ? 'completed with a warning' : 'failed'
  return t(message, `${englishStage} ${englishStatus}.`)
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value)
}

function messageOf(cause: unknown, t: Translate): string {
  return cause instanceof Error ? localizedGatewayMessage(cause.message, t) : t('操作失败，请重试。', 'The operation failed. Try again.')
}
