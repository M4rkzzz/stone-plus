import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { clientNativeProtocols } from '@shared/types'
import { previewRoute } from '@shared/route-preview'
import {
  hasRouteSourceIdCollision,
  isAvailableRouteAccount,
  resolveRouteSource
} from '@shared/route-sources'
import type {
  Account,
  AccountFitnessSnapshot,
  AccountImportProgress,
  AccountModelTestResult,
  AppRuntimeDelta,
  AppSnapshot,
  ClientConfigEditorSaveInput,
  ClientConfigEditorState,
  ClientConfigPreview,
  ClientConfigStatus,
  ClientConfigProfile,
  GatewayApi,
  GatewaySettings,
  GatewayStatus,
  RequestLog,
  RequestReplayResult,
  RequestReplayTemplate,
  Route,
  RouteClient,
  UiLanguage
} from '@shared/types'
import type { GatewayAccountState, GatewayConfig, GatewayRuntimeStateUpdate } from '../gateway'
import { checkChatGptAccountAuthorized, codexQuotaCooldownUntil, codexQuotaIsExhausted, getProviderAdapter, probeChatGptAccountAuthorized, probeChatGptCodexModel, probeProviderModel, queryChatGptCodexModels, queryChatGptCodexModelsAuthorized, queryChatGptCodexQuota, queryChatGptCodexQuotaAuthorized, resolveChatGptCredential, type ProviderFailure } from '../providers'
import { validateAccountImportProxySelection, type AppStore } from '../store/app-store'
import type { ClientConfigService } from '../client-config'
import { WebDavBackupService, type DatabaseBackupService } from '../backup'
import type { PersistedState } from '../store/types'
import { serializeDiagnostics } from './diagnostics'
import { assertTrustedSender } from './trusted-sender'
import { OutboundTransportManager, probeProxy, resolveEffectiveProxy } from '../proxy'
import {
  OutboundReloadCoordinator,
  collectEnabledOutboundTargets,
  type EnabledOutboundTarget
} from '../proxy/outbound-reload-coordinator'
import { runNetworkDiagnostics } from '../network-diagnostics'
import type { BrowserImportQueue } from '../browser-import-queue'
import { verifySetupRouteRequest } from '../setup/setup-verification'
import { probeApiSource as runApiSourceProbe } from '../sources/api-source-service'
import { ChatGptOAuthFlowManager, type ChatGptOAuthSessionController } from '../auth/chatgpt-oauth-flow'
import { resolveChatGptAgentIdentity, serializeChatGptCredential } from '../auth'
import type { LocalEventServer } from '../events'

export interface GatewayController {
  start(settings?: GatewaySettings): Promise<void>
  stop(options?: { force?: boolean; drainTimeoutMs?: number }): Promise<void>
  getStatus(): GatewayStatus
  getConfigGeneration?(): number
  updateConfig(config: GatewayConfig): void
  updateRuntimeAccounts(accounts: ReadonlyArray<GatewayConfig['accounts'][number]>): void
  resetAccountHealth(accountId: string, options?: { clearPerformance?: boolean }): void
  getAccountFitness(accountIds?: readonly string[]): Record<string, AccountFitnessSnapshot>
  getAccountInFlight(accountIds?: readonly string[]): Record<string, number>
  getRequestReplayTemplate?(id: string): RequestReplayTemplate | undefined
  replayRequest?(id: string): Promise<RequestReplayResult>
  clearRequestReplays?(): void
  onLog(listener: (log: RequestLog) => void): () => void
  onAccountState(listener: (state: GatewayAccountState) => void): () => void
  onRuntimeState(listener: (update?: GatewayRuntimeStateUpdate) => void): () => void
}

export function registerGatewayApi(
  store: AppStore,
  gateway: GatewayController,
  clientConfig: ClientConfigService,
  outboundTransport: OutboundTransportManager,
  backups?: DatabaseBackupService<PersistedState>,
  onRuntimeChanged?: () => void,
  browserImports?: BrowserImportQueue,
  chatGptOAuth: ChatGptOAuthSessionController = new ChatGptOAuthFlowManager({
    openExternal: (url) => shell.openExternal(url)
  }),
  localEvents?: LocalEventServer,
  sharedOutboundReloadCoordinator?: OutboundReloadCoordinator,
  sharedWebDavBackups?: WebDavBackupService,
): () => Promise<void> {
  const webDavBackups = sharedWebDavBackups ?? (backups ? new WebDavBackupService({
    metadata: store.getStateRepository(),
    safeStorage,
    backups,
    backupDirectory: backups.directory,
    temporaryDirectory: join(app.getPath('userData'), 'webdav-transfer'),
  }) : undefined)
  const runtimeDeltaPublishIntervalMs = 50
  const accountStateFlushDelayMs = 250
  const requestLogCheckpointIntervalMs = 10_000
  const noEligibleProbeCooldownMs = 30_000
  let scheduledRuntimeDeltaPublish: ReturnType<typeof setTimeout> | undefined
  let scheduledRequestLogCheckpoint: ReturnType<typeof setTimeout> | undefined
  let lastRuntimeDeltaPublishAt: number | undefined
  let runtimeRevision = 0
  let pendingGatewayStatus = false
  let pendingObservability = false
  let pendingAllAccountRuntime = false
  const pendingRequestLogs = new Map<string, RequestLog>()
  const pendingRuntimeAccountIds = new Set<string>()
  const pendingHealthEvents = new Map<string, AppSnapshot['healthEvents'][number]>()
  const publishedAccountRuntimeKeys = new Map<string, string>()
  let scheduledAccountStateFlush: ReturnType<typeof setTimeout> | undefined
  let accountStateFlushFlight: Promise<void> | undefined
  const pendingActiveAccountStates = new Map<string, GatewayAccountState>()
  const latestObservedAccountStates = new Map<string, GatewayAccountState>()
  const accountStateRevisions = new Map<string, number>()
  const accountStatePersistenceFlights = new Map<string, Promise<void>>()
  const quotaProbeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const quotaProbeFlights = new Set<string>()
  const lastQuotaProbeAt = new Map<string, number>()
  const apiSourceCapabilityProbeOwners = new Map<string, symbol>()
  const unsavedApiSourceProbeEvidence = new Map<string, {
    draftId: string
    connectionFingerprint: string
    testedModel: string
    discoveredModels: readonly string[]
    expiresAt: number
    capabilityProfile: Awaited<ReturnType<GatewayApi['probeApiSource']>>['capabilityProfile']
    modelCatalog: Awaited<ReturnType<GatewayApi['probeApiSource']>>['modelCatalog']
  }>()
  const unsavedApiSourceProbeEvidenceTtlMs = 5 * 60_000
  const maximumUnsavedApiSourceProbeEvidence = 128
  const issueUnsavedApiSourceProbeEvidence = (
    input: Parameters<GatewayApi['probeApiSource']>[0],
    result: Awaited<ReturnType<GatewayApi['probeApiSource']>>,
  ): string => {
    const now = Date.now()
    for (const [token, evidence] of unsavedApiSourceProbeEvidence) {
      if (evidence.expiresAt <= now) unsavedApiSourceProbeEvidence.delete(token)
    }
    while (unsavedApiSourceProbeEvidence.size >= maximumUnsavedApiSourceProbeEvidence) {
      const oldest = unsavedApiSourceProbeEvidence.keys().next().value as string | undefined
      if (!oldest) break
      unsavedApiSourceProbeEvidence.delete(oldest)
    }
    const token = randomUUID()
    unsavedApiSourceProbeEvidence.set(token, {
      draftId: apiSourceDraftIdentity(input),
      connectionFingerprint: apiSourceProbeConnectionFingerprint(input),
      testedModel: normalizeApiSourceEvidenceModel(result.testedModel)
        ?? normalizeApiSourceEvidenceModel(input.model)
        ?? normalizeApiSourceEvidenceModel(result.models[0])
        ?? '',
      discoveredModels: normalizeApiSourceEvidenceModels(result.models),
      expiresAt: now + unsavedApiSourceProbeEvidenceTtlMs,
      capabilityProfile: structuredClone(result.capabilityProfile),
      modelCatalog: structuredClone(result.modelCatalog),
    })
    return token
  }
  const consumeUnsavedApiSourceProbeEvidence = (
    token: unknown,
    input: Parameters<GatewayApi['saveApiSource']>[0],
  ): { capabilityProfile: typeof unsavedApiSourceProbeEvidence extends Map<string, infer T>
      ? T extends { capabilityProfile: infer P } ? P : never
      : never
    modelCatalog: typeof unsavedApiSourceProbeEvidence extends Map<string, infer T>
      ? T extends { modelCatalog: infer M } ? M : never
      : never
  } | undefined => {
    if (typeof token !== 'string' || !token) return undefined
    const evidence = unsavedApiSourceProbeEvidence.get(token)
    // A token is single-use even when the caller presents it with a modified
    // draft. This prevents probing A, trying B, then replaying it for A.
    unsavedApiSourceProbeEvidence.delete(token)
    if (!evidence || evidence.expiresAt <= Date.now()) return undefined
    try {
      if (evidence.draftId !== apiSourceDraftIdentity(input)) return undefined
      if (evidence.connectionFingerprint !== apiSourceProbeConnectionFingerprint(input)) return undefined
      if (!apiSourceSaveMatchesProbeModels(input, evidence.testedModel, evidence.discoveredModels)) return undefined
      return {
        capabilityProfile: structuredClone(evidence.capabilityProfile),
        modelCatalog: structuredClone(evidence.modelCatalog),
      }
    } catch {
      return undefined
    }
  }
  let automaticCooldownRefreshTriggered = false
  let automaticCooldownRefreshFlight: Promise<void> | undefined
  const noEligibleProbeFlights = new Map<string, Promise<void>>()
  const noEligibleProbeLastStartedAt = new Map<string, number>()
  const noEligibleRefreshFlights = new Set<Promise<void>>()
  let evaluateAutomaticCooldownRefresh = (): void => undefined
  let refreshNoEligibleAccounts = (_context: NonNullable<GatewayRuntimeStateUpdate['noEligibleAccounts']>): void => undefined
  let gatewayLifecycleTail: Promise<void> = Promise.resolve()
  const enqueueGatewayLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = gatewayLifecycleTail.then(operation, operation)
    gatewayLifecycleTail = result.then(() => undefined, () => undefined)
    return result
  }
  const pendingRequestLogWrites = new Set<Promise<unknown>>()
  const pendingTerminalLogs = new Map<string, {
    log: RequestLog
    attempts: number
    retryTimer?: ReturnType<typeof setTimeout>
    flight?: Promise<RequestLog | undefined>
  }>()
  let orphanedLogReconciliationScheduled = false
  let closed = false
  let rendererLanguage: UiLanguage | undefined
  const resolvedNativeLanguage = (): UiLanguage => {
    if (rendererLanguage) return rendererLanguage
    try {
      const locale = typeof app.getLocale === 'function' ? app.getLocale() : 'zh-CN'
      return /^zh(?:[-_]|$)/i.test(locale) ? 'zh-CN' : 'en'
    } catch {
      return 'zh-CN'
    }
  }
  const nativeText = (chinese: string, english: string): string => {
    return resolvedNativeLanguage() === 'zh-CN' ? chinese : english
  }
  type OAuthStartInput = Parameters<GatewayApi['startChatGptOAuth']>[0]
  type OAuthImportResult = Awaited<ReturnType<GatewayApi['waitChatGptOAuth']>>
  interface OAuthImportSession {
    input: OAuthStartInput
    owner: WebContents
    ownerId: number
    onOwnerGone: () => void
    cleanupTimer: ReturnType<typeof setTimeout>
    cancelled: boolean
    committing: boolean
    cleaned: boolean
    completion?: Promise<OAuthImportResult>
  }
  const oauthImportSessions = new Map<string, OAuthImportSession>()
  const oauthCompletionFlights = new Set<Promise<OAuthImportResult>>()

  const cleanupOAuthSession = (
    sessionId: string,
    session: OAuthImportSession,
    options: { cancelFlow: boolean; markCancelled: boolean }
  ): void => {
    if (options.markCancelled) session.cancelled = true
    if (session.cleaned) return
    session.cleaned = true
    clearTimeout(session.cleanupTimer)
    session.owner.removeListener('destroyed', session.onOwnerGone)
    session.owner.removeListener('render-process-gone', session.onOwnerGone)
    if (oauthImportSessions.get(sessionId) === session) oauthImportSessions.delete(sessionId)
    if (options.cancelFlow) chatGptOAuth.cancel(sessionId)
  }

  const cancelOAuthSession = (sessionId: string, session: OAuthImportSession): boolean => {
    // Once token exchange has completed, account persistence is the commit
    // boundary. An ordinary renderer cancellation must not create a valid but
    // unpersisted refresh token.
    if (session.committing) return false
    cleanupOAuthSession(sessionId, session, { cancelFlow: true, markCancelled: true })
    return true
  }

  const requireOwnedOAuthSession = (sessionId: unknown, sender: WebContents): {
    id: string
    session: OAuthImportSession
  } => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const session = oauthImportSessions.get(id)
    if (!session || session.owner !== sender || session.ownerId !== sender.id) {
      throw new Error('OAuth 授权会话不存在或不属于当前窗口。')
    }
    return { id, session }
  }
  const withRuntimeMetrics = (snapshot: AppSnapshot, revision = runtimeRevision): AppSnapshot => {
    const fitness = gateway.getAccountFitness?.() ?? {}
    const inFlight = gateway.getAccountInFlight()
    return {
      ...snapshot,
      runtimeRevision: revision,
      accounts: snapshot.accounts.map((account) => ({
        ...account,
        inFlight: Math.max(0, inFlight[account.id] ?? account.inFlight),
        ...(fitness[account.id] ? { fitness: fitness[account.id] } : {})
      }))
    }
  }
  const canReceiveSnapshot = (window: BrowserWindow): boolean => {
    const visible = typeof window.isVisible !== 'function' || window.isVisible()
    const minimized = typeof window.isMinimized === 'function' && window.isMinimized()
    return !window.isDestroyed() && visible && !minimized
  }
  const publish = (
    snapshot: AppSnapshot,
    options: { runtimeChanged?: boolean } = { runtimeChanged: true }
  ): AppSnapshot => {
    if (scheduledRuntimeDeltaPublish) clearTimeout(scheduledRuntimeDeltaPublish)
    scheduledRuntimeDeltaPublish = undefined
    pendingGatewayStatus = false
    pendingObservability = false
    pendingAllAccountRuntime = false
    pendingRequestLogs.clear()
    pendingRuntimeAccountIds.clear()
    pendingHealthEvents.clear()
    const enriched = withRuntimeMetrics(snapshot, ++runtimeRevision)
    publishedAccountRuntimeKeys.clear()
    for (const account of enriched.accounts) publishedAccountRuntimeKeys.set(account.id, JSON.stringify(account))
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('stone:snapshot', enriched)
      }
    }
    if (options.runtimeChanged !== false) onRuntimeChanged?.()
    return enriched
  }
  const publishBrowserImports = (state: ReturnType<BrowserImportQueue['getState']>): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:browser-import-queue', state)
    }
  }
  const unsubscribeBrowserImports = browserImports?.subscribe(publishBrowserImports)

  const publicRuntimeAccounts = (ids?: ReadonlySet<string>): AppSnapshot['accounts'] => {
    const selectedIds = ids ? [...ids] : undefined
    const fitness = gateway.getAccountFitness?.(selectedIds) ?? {}
    const inFlight = gateway.getAccountInFlight(selectedIds)
    return store.getPublicRuntimeAccounts(ids).map((account) => ({
      ...account,
      inFlight: Math.max(0, inFlight[account.id] ?? account.inFlight),
      ...(fitness[account.id] ? { fitness: fitness[account.id] } : {})
    }))
  }

  const flushRuntimeDelta = (): void => {
    scheduledRuntimeDeltaPublish = undefined
    if (closed) return
    lastRuntimeDeltaPublishAt = Date.now()
    const recipients = BrowserWindow.getAllWindows().filter(canReceiveSnapshot)
    const sendGatewayStatus = pendingGatewayStatus
    const sendObservability = pendingObservability
    const sendAllAccounts = pendingAllAccountRuntime
    const logs = [...pendingRequestLogs.values()]
    const accountIds = new Set(pendingRuntimeAccountIds)
    const healthEvents = [...pendingHealthEvents.values()]
    pendingGatewayStatus = false
    pendingObservability = false
    pendingAllAccountRuntime = false
    pendingRequestLogs.clear()
    pendingRuntimeAccountIds.clear()
    pendingHealthEvents.clear()
    // A focused renderer always reloads one authoritative snapshot. Do not do
    // any database clone/observability work for hidden or minimized windows.
    // Still advance the revision: otherwise two focus-triggered snapshots can
    // carry the same revision even though one predates hidden runtime changes,
    // allowing an older response to overwrite the newer one in the renderer.
    if (recipients.length === 0) {
      if (sendGatewayStatus || sendObservability || sendAllAccounts || logs.length
        || accountIds.size || healthEvents.length) runtimeRevision += 1
      return
    }

    const candidateAccounts = sendAllAccounts
      ? publicRuntimeAccounts()
      : accountIds.size > 0 ? publicRuntimeAccounts(accountIds) : []
    const accounts = candidateAccounts.filter((account) => {
      const key = JSON.stringify(account)
      if (publishedAccountRuntimeKeys.get(account.id) === key) return false
      publishedAccountRuntimeKeys.set(account.id, key)
      return true
    })
    const delta: AppRuntimeDelta = {
      revision: ++runtimeRevision,
      ...(sendGatewayStatus ? { gatewayStatus: gateway.getStatus() } : {}),
      ...(logs.length ? { requestLogs: logs } : {}),
      ...(accounts.length ? { accounts } : {}),
      ...(healthEvents.length ? { healthEvents } : {}),
      ...(sendObservability ? { observability: store.getRuntimeObservability() } : {})
    }
    const hasPayload = delta.gatewayStatus || delta.requestLogs || delta.accounts
      || delta.healthEvents || delta.observability
    if (!hasPayload) {
      runtimeRevision -= 1
      return
    }
    for (const window of recipients) window.webContents.send('stone:runtime-delta', delta)
  }

  const scheduleRuntimeDelta = (options: {
    gatewayStatus?: boolean
    requestLog?: RequestLog
    accountId?: string
    allAccounts?: boolean
    healthEvent?: AppSnapshot['healthEvents'][number]
    observability?: boolean
  } = {}): void => {
    if (closed) return
    if (options.gatewayStatus) pendingGatewayStatus = true
    if (options.requestLog) pendingRequestLogs.set(options.requestLog.id, options.requestLog)
    if (options.accountId) pendingRuntimeAccountIds.add(options.accountId)
    if (options.allAccounts) pendingAllAccountRuntime = true
    if (options.healthEvent) pendingHealthEvents.set(options.healthEvent.id, options.healthEvent)
    if (options.observability) pendingObservability = true
    if (scheduledRuntimeDeltaPublish) return
    const elapsed = lastRuntimeDeltaPublishAt === undefined
      ? runtimeDeltaPublishIntervalMs
      : Date.now() - lastRuntimeDeltaPublishAt
    const delay = Math.max(0, runtimeDeltaPublishIntervalMs - elapsed)
    scheduledRuntimeDeltaPublish = setTimeout(flushRuntimeDelta, delay)
    scheduledRuntimeDeltaPublish.unref?.()
  }

  const trackRequestLogWrite = (write: Promise<unknown>): void => {
    pendingRequestLogWrites.add(write)
    void write.then(
      () => pendingRequestLogWrites.delete(write),
      () => pendingRequestLogWrites.delete(write)
    )
  }

  const scheduleRequestLogCheckpoint = (): void => {
    if (closed || scheduledRequestLogCheckpoint) return
    scheduledRequestLogCheckpoint = setTimeout(() => {
      scheduledRequestLogCheckpoint = undefined
      if (closed || !store.hasUncheckpointedLiveRequestLogs()) return
      const checkpoint = store.checkpointLiveRequestLogs()
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('Stone+ could not checkpoint live gateway request logs', error)
        })
      trackRequestLogWrite(checkpoint)
      void checkpoint.finally(() => {
        if (store.hasUncheckpointedLiveRequestLogs()) scheduleRequestLogCheckpoint()
      })
    }, requestLogCheckpointIntervalMs)
    scheduledRequestLogCheckpoint.unref?.()
  }

  const scheduleOrphanedLogReconciliation = (): void => {
    if (closed || orphanedLogReconciliationScheduled || gateway.getStatus().activeRequests !== 0
      || pendingTerminalLogs.size > 0) return
    orphanedLogReconciliationScheduled = true
    const pendingLogs = [...pendingRequestLogWrites]
    void Promise.allSettled(pendingLogs).then(async () => {
      orphanedLogReconciliationScheduled = false
      if (closed || gateway.getStatus().activeRequests !== 0 || pendingTerminalLogs.size > 0) return
      const finalized = await store.finalizeOrphanedStreamingLogs()
      for (const log of finalized) {
        scheduleRuntimeDelta({
          gatewayStatus: true,
          requestLog: log,
          observability: true
        })
      }
    }).catch((error: unknown) => {
      orphanedLogReconciliationScheduled = false
      console.error('Stone+ could not reconcile an orphaned gateway request log', error)
    })
  }

  const unsubscribeRuntimeState = gateway.onRuntimeState((update = { gatewayStatus: true, allAccounts: true }) => {
    if (update.noEligibleAccounts?.accountIds.length) {
      refreshNoEligibleAccounts(update.noEligibleAccounts)
    }
    if (update.allAccounts) {
      scheduleRuntimeDelta({ gatewayStatus: update.gatewayStatus === true, allAccounts: true })
    } else if (update.accountIds?.length) {
      for (const accountId of update.accountIds) scheduleRuntimeDelta({ accountId })
      if (update.gatewayStatus) scheduleRuntimeDelta({ gatewayStatus: true })
    } else if (update.gatewayStatus) {
      scheduleRuntimeDelta({ gatewayStatus: true })
    }
    scheduleOrphanedLogReconciliation()
  })

  const refreshRuntime = (): AppSnapshot => {
    gateway.updateConfig(toGatewayConfig(store))
    store.setGatewayStatus(gateway.getStatus())
    return store.getSnapshot()
  }

  const publishRuntimeAccount = (accountId: string): AppSnapshot => {
    const account = store.getRuntimeAccount(accountId)
    if (account) gateway.updateRuntimeAccounts([account])
    return publish(store.getSnapshot())
  }

  const scheduleQuotaProbe = (accountId: string, at: number): void => {
    const existing = quotaProbeTimers.get(accountId)
    if (existing) clearTimeout(existing)
    if (closed) return
    const delay = Math.max(1_000, Math.min(2_147_000_000, at - Date.now()))
    const timer = setTimeout(() => {
      quotaProbeTimers.delete(accountId)
      void probeQuotaCooldownAccount(accountId)
    }, delay)
    timer.unref?.()
    quotaProbeTimers.set(accountId, timer)
  }

  const probeQuotaCooldownAccount = async (accountId: string): Promise<void> => {
    if (closed || quotaProbeFlights.has(accountId)) return
    const account = store.getRuntimeAccount(accountId)
    if (!account || (account.credentialType !== 'chatgpt-oauth' && account.credentialType !== 'chatgpt-agent-identity') || account.cooldownReason !== 'quota') return
    quotaProbeFlights.add(accountId)
    lastQuotaProbeAt.set(accountId, Date.now())
    try {
      const quota = await refreshAccountCodexQuota(store, outboundTransport, accountId)
      if (closed) return
      const now = Date.now()
      const exhausted = codexQuotaIsExhausted(quota, now)
      const cooldownUntil = exhausted ? codexQuotaCooldownUntil(quota, now) ?? now + 60_000 : undefined
      await store.setAccountCheckResult(accountId, exhausted ? {
        codexQuota: quota,
        status: 'cooldown',
        circuitState: 'open',
        cooldownReason: 'quota',
        cooldownUntil,
        lastError: 'ChatGPT Codex 额度已耗尽。'
      } : {
        codexQuota: quota,
        status: 'active',
        circuitState: 'closed',
        consecutiveFailures: 0,
        cooldownReason: undefined,
        cooldownUntil: undefined,
        lastError: undefined
      })
      if (exhausted && cooldownUntil !== undefined) scheduleQuotaProbe(accountId, cooldownUntil + 1_000)
      else gateway.resetAccountHealth(accountId)
      publish(refreshRuntime())
    } catch (error) {
      console.error('Stone+ could not probe an exhausted ChatGPT account quota', error)
      scheduleQuotaProbe(accountId, Date.now() + 60_000)
    } finally {
      quotaProbeFlights.delete(accountId)
    }
  }

  const mutate = async (operation: () => Promise<AppSnapshot>): Promise<AppSnapshot> => {
    await operation()
    const snapshot = publish(refreshRuntime())
    if (gateway.getStatus().running) warmGatewayConnections(store, outboundTransport)
    return snapshot
  }

  const accountProbeOwners = new Map<string, {
    token: symbol
    previousState?: ReturnType<typeof accountCheckState>
  }>()
  const probeAndPersistAccount = async (id: string, signal?: AbortSignal): Promise<{
    snapshot: AppSnapshot
    ok: boolean
    latencyMs?: number
    error?: string
  }> => {
    signal?.throwIfAborted()
    const token = Symbol(id)
    const currentOwner = accountProbeOwners.get(id)
    const currentAccount = store.getRuntimeAccount(id)
    const owner = {
      token,
      // A newer probe supersedes an older one. Keep the last stable state from
      // before the whole probe chain so cancelling the newer probe cannot
      // restore the transient `checking` state left by its predecessor.
      previousState: currentOwner && currentAccount?.status === 'checking'
        ? currentOwner.previousState
        : (currentAccount ? accountCheckState(currentAccount) : undefined),
    }
    accountProbeOwners.set(id, owner)
    await store.setAccountCheckResultIf(
      id,
      { status: 'checking', lastError: undefined },
      () => accountProbeOwners.get(id)?.token === token && !signal?.aborted,
    )
    publishRuntimeAccount(id)
    try {
      const result = await checkAccount(store, outboundTransport, id, signal)
      signal?.throwIfAborted()
      const now = Date.now()
      const exhausted = codexQuotaIsExhausted(result.codexQuota, now)
      const cooldownUntil = exhausted
        ? codexQuotaCooldownUntil(result.codexQuota, now) ?? now + 60_000
        : undefined
      // Only the newest probe for an account may publish health. This check is
      // deliberately immediately before the durable write so a slow response
      // cannot overwrite a newer probe's result.
      if (accountProbeOwners.get(id)?.token !== token) {
        return {
          snapshot: store.getSnapshot(),
          ok: !exhausted,
          latencyMs: result.latencyMs,
          ...(exhausted ? { error: 'ChatGPT Codex 额度已耗尽。' } : {}),
        }
      }
      const persisted = await store.setAccountCheckResultIf(id, {
        status: exhausted ? 'cooldown' : 'active',
        circuitState: exhausted ? 'open' : 'closed',
        consecutiveFailures: 0,
        latencyMs: result.latencyMs,
        lastError: exhausted ? 'ChatGPT Codex 额度已耗尽。' : undefined,
        lastUsedAt: now,
        cooldownUntil,
        cooldownReason: exhausted ? 'quota' : undefined,
        ...(result.codexQuota ? { codexQuota: result.codexQuota } : {})
      }, () => accountProbeOwners.get(id)?.token === token && !signal?.aborted)
      signal?.throwIfAborted()
      if (!persisted.applied || accountProbeOwners.get(id)?.token !== token) {
        return {
          snapshot: persisted.snapshot,
          ok: !exhausted,
          latencyMs: result.latencyMs,
          ...(exhausted ? { error: 'ChatGPT Codex 额度已耗尽。' } : {}),
        }
      }
      if (exhausted && cooldownUntil !== undefined) scheduleQuotaProbe(id, cooldownUntil + 1_000)
      else gateway.resetAccountHealth(id)
      const snapshot = publishRuntimeAccount(id)
      evaluateAutomaticCooldownRefresh()
      return { snapshot, ok: !exhausted, latencyMs: result.latencyMs,
        ...(exhausted ? { error: 'ChatGPT Codex 额度已耗尽。' } : {}) }
    } catch (error: unknown) {
      if (signal?.aborted) {
        if (accountProbeOwners.get(id)?.token === token
          && store.getRuntimeAccount(id)?.status === 'checking'
          && owner.previousState) {
          await store.setAccountCheckResultIf(
            id,
            owner.previousState,
            () => accountProbeOwners.get(id)?.token === token
              && store.getRuntimeAccount(id)?.status === 'checking',
          )
          publishRuntimeAccount(id)
        }
        throw abortReason(signal)
      }
      if (accountProbeOwners.get(id)?.token !== token) {
        return { snapshot: store.getSnapshot(), ok: false,
          error: error instanceof Error ? error.message : 'Account check failed.' }
      }
      const failure = error instanceof AccountProbeError ? error.failure : undefined
      const shouldDisable = failure?.accountAction === 'disable'
      const shouldCooldown = failure?.accountAction === 'cooldown'
      const errorMessage = error instanceof Error ? error.message : 'Account check failed.'
      const persisted = await store.setAccountCheckResultIf(id, {
        status: shouldDisable ? 'disabled' : shouldCooldown ? 'cooldown' : owner.previousState?.status ?? 'disabled',
        circuitState: shouldDisable || shouldCooldown ? 'open' : owner.previousState?.circuitState,
        consecutiveFailures: (store.getSnapshot().accounts.find((account) => account.id === id)?.consecutiveFailures ?? 0) + 1,
        cooldownUntil: shouldCooldown ? Date.now() + (failure?.retryAfterMs ?? 30_000) : owner.previousState?.cooldownUntil,
        cooldownReason: shouldCooldown ? 'failure' : owner.previousState?.cooldownReason,
        lastError: errorMessage
      }, () => accountProbeOwners.get(id)?.token === token)
      if (!persisted.applied || accountProbeOwners.get(id)?.token !== token) {
        return { snapshot: persisted.snapshot, ok: false, error: errorMessage }
      }
      const snapshot = publishRuntimeAccount(id)
      evaluateAutomaticCooldownRefresh()
      return { snapshot, ok: false, error: errorMessage }
    } finally {
      if (accountProbeOwners.get(id)?.token === token) accountProbeOwners.delete(id)
    }
  }

  const persistentTaskRunner = store.getPersistentTaskRunner()
  const unregisterBulkAccountCheckTask = persistentTaskRunner.register<{
    accountIds: string[]
  }, { checked: number; succeeded: number; failed: number; skipped: number }>(
    'account.bulk-check',
    async ({ payload, progress, signal, checkpoint, waitIfPaused }) => {
      const accountIds = [...new Set(payload.accountIds)]
      let cursor = Math.max(0, Math.min(accountIds.length, Math.floor(progress.completed)))
      let checked = taskProgressCount(progress.details?.checked)
      let succeeded = taskProgressCount(progress.details?.succeeded)
      let failed = taskProgressCount(progress.details?.failed)
      let skipped = taskProgressCount(progress.details?.skipped)
      await checkpoint({
        total: accountIds.length,
        completed: cursor,
        details: { checked, succeeded, failed, skipped },
        message: cursor > 0
          ? nativeText(`正在从 ${cursor}/${accountIds.length} 恢复账号检测…`, `Resuming account checks at ${cursor}/${accountIds.length}…`)
          : nativeText('准备批量检测账号…', 'Preparing bulk account checks…')
      })
      for (let index = cursor; index < accountIds.length; index += 1) {
        const accountId = accountIds[index]
        await waitIfPaused()
        if (signal.aborted) throw signal.reason
        const account = store.getRuntimeAccount(accountId)
        if (!account) {
          skipped += 1
        } else {
          const result = await probeAndPersistAccount(accountId, signal)
          checked += 1
          if (result.ok) succeeded += 1
          else failed += 1
        }
        cursor = index + 1
        await checkpoint({
          completed: cursor,
          total: accountIds.length,
          details: { checked, succeeded, failed, skipped },
          message: nativeText(
            `账号检测 ${cursor}/${accountIds.length} · 成功 ${succeeded} · 失败 ${failed} · 跳过 ${skipped}`,
            `Account checks ${cursor}/${accountIds.length} · ${succeeded} succeeded · ${failed} failed · ${skipped} skipped`
          )
        })
      }
      return { checked, succeeded, failed, skipped }
    }
  )

  evaluateAutomaticCooldownRefresh = (): void => {
    if (closed) return
    const candidates = store.getRuntimeAccounts().filter((account) => (
      account.status !== 'disabled'
      && account.status !== 'expired'
      && account.cooldownReason !== 'quota'
      && !quotaExhausted(account)
    ))
    const allCooling = candidates.length > 0
      && candidates.every((account) => account.status === 'cooldown')
    if (!allCooling) {
      // Checking is a transient state created by this refresh. Only a proven
      // active account rearms the next collective-cooldown episode.
      if (!automaticCooldownRefreshFlight && candidates.some((account) => account.status === 'active')) {
        automaticCooldownRefreshTriggered = false
      }
      return
    }
    if (automaticCooldownRefreshTriggered || automaticCooldownRefreshFlight) return

    automaticCooldownRefreshTriggered = true
    const accountIds = candidates.map((account) => account.id)
    const flight = (async (): Promise<void> => {
      await mapConcurrent(accountIds, 3, async (accountId) => {
        await probeAndPersistAccount(accountId)
      })
    })()
    automaticCooldownRefreshFlight = flight
    void flight.catch((error: unknown) => {
      console.error('Stone+ could not automatically refresh collectively cooled accounts', error)
    }).finally(() => {
      if (automaticCooldownRefreshFlight === flight) automaticCooldownRefreshFlight = undefined
      evaluateAutomaticCooldownRefresh()
    })
  }

  const currentNoEligibleAccountIds = (
    context: NonNullable<GatewayRuntimeStateUpdate['noEligibleAccounts']>,
  ): Set<string> => {
    const currentGeneration = gateway.getConfigGeneration?.()
    if (!Number.isSafeInteger(context.configGeneration)
      || typeof context.routeId !== 'string'
      || !context.routeId.trim()
      || currentGeneration === undefined
      || context.configGeneration !== currentGeneration) return new Set()
    const configuration = store.getRuntimeConfiguration()
    const route = configuration.routes.find((candidate) => candidate.id === context.routeId)
    if (!route?.enabled || route.poolId !== context.poolId) return new Set()
    const source = resolveRouteSource(context.poolId, {
      // Persisted pools, rather than runtime-only leftovers, decide whether a
      // scheduler event still belongs to a live source.
      pools: store.getSnapshot().pools,
      providers: configuration.providers,
      accounts: configuration.accounts,
    })
    if (!source) return new Set()
    const liveMembers = new Set(source.accounts.map((account) => account.id))
    return new Set(context.accountIds.filter((accountId) => liveMembers.has(accountId)))
  }

  refreshNoEligibleAccounts = (context): void => {
    if (closed) return
    const now = Date.now()
    const candidates = [...currentNoEligibleAccountIds(context)].filter((accountId) => {
      const account = store.getRuntimeAccount(accountId)
      if (!account || account.status === 'expired' || account.status === 'checking') return false
      // Active sources can be absent only because of concurrency or an
      // in-memory circuit decision. Neither is evidence that a credential
      // probe is useful. Known quota cooldowns have their own reset timer.
      if (account.status === 'disabled') return true
      if (account.status !== 'cooldown') return false
      return account.cooldownReason !== 'quota' && !quotaExhausted(account)
    }).filter((accountId) => {
      const lastStartedAt = noEligibleProbeLastStartedAt.get(accountId)
      return !noEligibleProbeFlights.has(accountId)
        && (lastStartedAt === undefined || now - lastStartedAt >= noEligibleProbeCooldownMs)
    })
    if (candidates.length === 0) return

    const refreshFlight = mapConcurrent(candidates, 3, async (accountId) => {
      if (!currentNoEligibleAccountIds(context).has(accountId)) return
      const existing = noEligibleProbeFlights.get(accountId)
      if (existing) return existing
      noEligibleProbeLastStartedAt.set(accountId, Date.now())
      const probeFlight = probeAndPersistAccount(accountId).then(() => undefined)
      noEligibleProbeFlights.set(accountId, probeFlight)
      try {
        await probeFlight
      } finally {
        if (noEligibleProbeFlights.get(accountId) === probeFlight) {
          noEligibleProbeFlights.delete(accountId)
        }
      }
    }).then(() => undefined)
    noEligibleRefreshFlights.add(refreshFlight)
    void refreshFlight.catch((error: unknown) => {
      console.error('Stone+ could not refresh accounts after a zero-candidate schedule', error)
    }).finally(() => {
      noEligibleRefreshFlights.delete(refreshFlight)
    })
  }

  const ownsOutboundReloadCoordinator = sharedOutboundReloadCoordinator === undefined
  const outboundReloadCoordinator = sharedOutboundReloadCoordinator ?? new OutboundReloadCoordinator({
    transport: outboundTransport,
    collectTargets: () => gatewayConnectionTargets(store)
  })
  outboundReloadCoordinator.configureAccountRecheck({
    getRuntimeAccounts: () => store.getRuntimeAccounts(),
    getRuntimeAccount: (accountId) => store.getRuntimeAccount(accountId),
    probeAccount: (accountId) => probeAndPersistAccount(accountId),
    isQuotaExhausted: quotaExhausted,
    onRecheckCycleStarted: () => {
      automaticCooldownRefreshTriggered = false
    },
    onRecheckCycleSettled: evaluateAutomaticCooldownRefresh
  })

  const detectImportedAccounts = async (
    accountIds: readonly string[],
    onProgress?: (completed: number, total: number) => void
  ) => {
    const uniqueIds = [...new Set(accountIds)]
    let completed = 0
    return mapConcurrent(uniqueIds, 3, async (accountId) => {
      const checked = await probeAndPersistAccount(accountId)
      let availableModelCount: number | undefined
      let modelRefreshError: string | undefined
      try {
        const discoveryFingerprint = store.getAccountModelDiscoveryFingerprint(accountId)
        const models = await discoverAccountModels(store, outboundTransport, accountId)
        await store.setAccountModels(accountId, models, discoveryFingerprint)
        availableModelCount = models.length
      } catch (error) {
        modelRefreshError = error instanceof Error ? error.message : 'Account model refresh failed.'
      }
      const accountName = store.getSnapshot().accounts.find((account) => account.id === accountId)?.name ?? 'ChatGPT account'
      const result = {
        accountId,
        accountName,
        ok: checked.ok,
        ...(checked.latencyMs !== undefined ? { latencyMs: checked.latencyMs } : {}),
        ...(checked.error ? { error: checked.error } : {}),
        ...(availableModelCount !== undefined ? { availableModelCount } : {}),
        ...(modelRefreshError ? { modelRefreshError } : {})
      }
      completed += 1
      onProgress?.(completed, uniqueIds.length)
      return result
    })
  }

  const finalizeImportAssignments = async (
    accountIds: readonly string[],
    detectionResults: readonly { accountId: string; ok: boolean }[],
    tagId: string | null | undefined,
    poolId: string | null | undefined
  ) => {
    const uniqueAccountIds = [...new Set(accountIds)]
    const successfulIds = new Set(detectionResults.filter((result) => result.ok).map((result) => result.accountId))
    const eligibleIds = uniqueAccountIds.filter((id) => successfulIds.has(id))
    let poolAssignment = { added: 0, alreadyPresent: 0 }
    let poolAppendError: string | undefined
    try {
      poolAssignment = await store.addDetectedChatGptAccountsToPool(poolId, eligibleIds)
    } catch (error) {
      poolAppendError = importErrorMessage(error)
    }
    return {
      tagId: tagId ?? null,
      tagUpdatedAccountCount: uniqueAccountIds.length,
      poolId: poolId ?? null,
      poolMembersAdded: poolAssignment.added,
      poolMembersAlreadyPresent: poolAssignment.alreadyPresent,
      poolMembersSkipped: poolId ? uniqueAccountIds.length - eligibleIds.length : 0,
      ...(poolAppendError ? { poolAppendError } : {})
    }
  }

  const completeChatGptOAuth = async (
    sessionId: string,
    session: OAuthImportSession
  ): Promise<OAuthImportResult> => {
    let lazyTransportFailure: string | undefined
    const fetchImplementation = (async (request, init) => {
      if (session.cancelled) throw new Error('OAuth 授权已取消。')
      // Resolve the selected proxy, its latest revision and its password only
      // when the token POST is actually dispatched. OAuth can remain open for
      // minutes and must not retain stale proxy credentials from start().
      const proxy = session.input.proxyMode === 'proxy'
        ? store.getSnapshot().proxies.find((candidate) => candidate.id === session.input.proxyId)
        : undefined
      if (session.input.proxyMode === 'proxy' && !proxy) {
        lazyTransportFailure = '选择的代理已被删除，请重新开始 OAuth 授权。'
        throw new Error(lazyTransportFailure)
      }
      try {
        const transport = outboundTransport.fetchFor(
          proxy,
          proxy ? store.getProxyPassword(proxy.id) : undefined
        )
        return await transport(request, init)
      } catch (error) {
        if (error instanceof Error && error.message === 'Proxy authentication is unavailable from the credential vault.') {
          lazyTransportFailure = error.message
        }
        throw error
      }
    }) as typeof fetch
    let bundle: Awaited<ReturnType<ChatGptOAuthSessionController['wait']>>
    try {
      bundle = await chatGptOAuth.wait(sessionId, fetchImplementation)
    } catch (error) {
      if (session.cancelled) throw new Error('OAuth 授权已取消。')
      if (lazyTransportFailure) throw new Error(lazyTransportFailure)
      throw error
    }
    if (session.cancelled) throw new Error('OAuth 授权已取消。')
    // Commit boundary: this assignment runs in the same promise continuation
    // that receives the token bundle, before another IPC cancellation can run.
    session.committing = true

    // Pool membership is deliberately finalized after account detection. Do
    // not pass the selected pool to the store import: the pool can be deleted
    // while the browser authorization is open, but the account and Tag must
    // still be persisted in that race.
    let effectiveTagId = session.input.tagId
    let tagRaceWarning: string | undefined
    const tagExists = (tagId: string): boolean => store.getSnapshot().accountTags.some((tag) => tag.id === tagId)
    if (effectiveTagId && !tagExists(effectiveTagId)) {
      effectiveTagId = null
      tagRaceWarning = 'OAuth 授权期间所选 Tag 已被删除，账号已按“未标记”导入。'
    }
    const persistAccount = (tagId: string | null) => store.importChatGptAccounts({
      content: serializeChatGptCredential(bundle),
      name: session.input.name,
      tagId,
      poolId: null,
      proxyMode: session.input.proxyMode,
      proxyId: session.input.proxyId
    })
    let imported: Awaited<ReturnType<AppStore['importChatGptAccounts']>>
    try {
      imported = await persistAccount(effectiveTagId)
    } catch (error) {
      // Close the narrow race between the preflight check and the atomic store
      // update. Only retry when the selected Tag demonstrably disappeared.
      if (!effectiveTagId || tagExists(effectiveTagId)) throw error
      effectiveTagId = null
      tagRaceWarning = 'OAuth 授权期间所选 Tag 已被删除，账号已按“未标记”导入。'
      imported = await persistAccount(null)
    }
    publish(refreshRuntime())
    const detectionResults = await detectImportedAccounts(imported.importedAccountIds)
    const assignmentSummary = await finalizeImportAssignments(
      imported.importedAccountIds,
      detectionResults,
      effectiveTagId,
      session.input.poolId
    )
    publish(refreshRuntime())
    return {
      ...imported,
      warnings: tagRaceWarning ? [...imported.warnings, tagRaceWarning] : imported.warnings,
      detectionResults,
      assignmentSummary,
      snapshot: store.getSnapshot()
    }
  }

  const emitImportProgress = (
    sender: WebContents,
    progressId: unknown,
    progress: Omit<AccountImportProgress, 'progressId'>
  ): void => {
    if (typeof progressId !== 'string' || !progressId || progressId.length > 120 || sender.isDestroyed()) return
    sender.send('stone:account-import-progress', { progressId, ...progress } satisfies AccountImportProgress)
  }

  const persistTerminalLog = (id: string): void => {
    const pending = pendingTerminalLogs.get(id)
    if (!pending || pending.flight || closed) return
    const persistedLog = pending.log
    const write = store.appendLog(persistedLog)
    pending.flight = write
    trackRequestLogWrite(write)
    void write.then((safeLog) => {
      const current = pendingTerminalLogs.get(id)
      // The log may have been explicitly cleared while durability was in
      // flight. Its ID is tombstoned by AppStore; do not publish or retry the
      // stale completion after the clear operation.
      if (!current) return
      if (current?.log !== persistedLog) {
        // This terminal version is already durable. Publish completion now;
        // a newer title/metadata patch can follow independently and must not
        // keep the renderer showing an otherwise finished request as live.
        if (safeLog) {
          scheduleRuntimeDelta({
            gatewayStatus: true,
            requestLog: safeLog,
            observability: true
          })
        }
        if (current) {
          current.flight = undefined
          persistTerminalLog(id)
        }
        return
      }
      if (!safeLog) {
        // AppStore returns undefined for a lifecycle tombstoned by clearLogs.
        // Treat that as an intentional drop, not a failed write; retrying it
        // forever would keep shutdown and orphan reconciliation alive. An
        // active cleared request may still have advanced the lifetime token
        // ledger, so publish observability without recreating its row.
        pendingTerminalLogs.delete(id)
        scheduleRuntimeDelta({ gatewayStatus: true, observability: true })
        return
      }
      pendingTerminalLogs.delete(id)
      scheduleRuntimeDelta({
        gatewayStatus: true,
        requestLog: safeLog,
        observability: true
      })
      scheduleOrphanedLogReconciliation()
    }, (error: unknown) => {
      const current = pendingTerminalLogs.get(id)
      if (!current || closed) return
      if (current.log !== persistedLog) {
        current.flight = undefined
        persistTerminalLog(id)
        return
      }
      current.flight = undefined
      current.attempts += 1
      console.error(`Stone+ could not persist terminal request log; retry ${current.attempts}`, error)
      const delay = Math.min(30_000, 250 * (2 ** Math.min(7, current.attempts - 1)))
      current.retryTimer = setTimeout(() => {
        current.retryTimer = undefined
        persistTerminalLog(id)
      }, delay)
      current.retryTimer.unref?.()
    })
  }

  /**
   * Shutdown runs after the normal retry timers have been cancelled. Give each
   * terminal lifecycle a short, bounded retry window so a transient SQLite/WAL
   * busy error cannot silently discard the only terminal record before the
   * AppStore closes. A tombstoned ID is considered intentionally handled.
   */
  const persistTerminalLogForShutdown = async (log: RequestLog): Promise<boolean> => {
    const maxAttempts = 8
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await store.appendLog(log)
        return true
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          console.error('Stone+ could not persist terminal request log during shutdown', error)
          return false
        }
        const delay = Math.min(1_000, 50 * (2 ** attempt))
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
    return false
  }

  const unsubscribeLog = gateway.onLog((log) => {
    if (log.status !== 'streaming') {
      const previous = pendingTerminalLogs.get(log.id)
      if (previous?.retryTimer) clearTimeout(previous.retryTimer)
      pendingTerminalLogs.set(log.id, {
        log,
        attempts: previous?.attempts ?? 0,
        flight: previous?.flight
      })
      if (!previous?.flight) persistTerminalLog(log.id)
      return
    }

    const write = store.appendLog(log)
    trackRequestLogWrite(write)
    void write.then((safeLog) => {
      if (!safeLog) return
      scheduleRuntimeDelta({ gatewayStatus: true, requestLog: safeLog })
      if (store.hasUncheckpointedLiveRequestLogs()) scheduleRequestLogCheckpoint()
    }, (error: unknown) => {
      console.error('Stone+ could not retain a live gateway request log', error)
    })
  })

  const persistAccountState = async (state: GatewayAccountState, revision: number): Promise<void> => {
    const before = store.getRuntimeAccount(state.accountId)
    await store.updateAccountRuntimeState(state.accountId, {
      status: state.status,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil,
      cooldownReason: state.cooldownReason,
      latencyMs: state.latencyMs,
      lastError: state.lastError,
      lastUsedAt: state.lastUsedAt,
      ...(state.quota ? { quota: state.quota } : {}),
      ...(state.codexQuota ? { codexQuota: state.codexQuota } : {})
    })
    // Persistence is serialized per account below, but a newer lifecycle state
    // may already be queued while this write is completing. Do not publish an
    // obsolete cooldown, notification, or runtime patch in that interval; the
    // newest queued state owns all post-commit side effects.
    if (accountStateRevisions.get(state.accountId) !== revision) return
    const account = store.getRuntimeAccount(state.accountId)
    if (account?.cooldownReason === 'quota'
      && (account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity')) {
      const knownResetAt = codexQuotaCooldownUntil(account.codexQuota)
      const recentlyProbed = Date.now() - (lastQuotaProbeAt.get(account.id) ?? 0) < 30_000
      scheduleQuotaProbe(account.id, recentlyProbed && knownResetAt ? knownResetAt + 1_000 : Date.now() + 1_000)
    } else {
      const timer = quotaProbeTimers.get(state.accountId)
      if (timer) clearTimeout(timer)
      quotaProbeTimers.delete(state.accountId)
    }
    const provider = account ? store.getRuntimeProvider(account.providerId) : undefined
    const event = account ? healthEventForTransition(before, account, provider?.name ?? 'Unknown provider') : undefined
    let persistedEvent: AppSnapshot['healthEvents'][number] | undefined
    if (event && account) {
      persistedEvent = await store.persistHealthEvent(event)
      if (store.getRuntimeGatewaySettings().desktopNotifications && Notification.isSupported()) {
        const body = resolvedNativeLanguage() === 'zh-CN' || !/[\u3400-\u9fff]/u.test(event.message)
          ? event.message
          : event.kind === 'quota-exhausted'
            ? 'Quota is exhausted. Stone+ paused scheduling for this account.'
            : event.kind === 'quota-restored'
              ? 'The quota window recovered. This account can be scheduled again.'
              : event.kind === 'account-recovered'
                ? 'The account health status recovered.'
                : event.kind === 'account-disabled'
                  ? 'The upstream rejected and disabled this account.'
                  : 'The account entered cooldown after consecutive failures.'
        new Notification({ title: `Stone+ · ${account.name}`, body }).show()
      }
    }
    // Quota and health are account-local runtime data. Patch the pinned gateway
    // account rather than rebuilding every route/index and replaying retained
    // performance history for each upstream response.
    if (account) gateway.updateRuntimeAccounts([account])
    if (event || state.status !== 'active') onRuntimeChanged?.()
    scheduleRuntimeDelta({
      gatewayStatus: true,
      accountId: state.accountId,
      ...(persistedEvent ? { healthEvent: persistedEvent } : {})
    })
    evaluateAutomaticCooldownRefresh()
  }

  const enqueueAccountStatePersistence = (state: GatewayAccountState, revision: number): void => {
    const previous = accountStatePersistenceFlights.get(state.accountId)
    const operation = (previous
      ? previous.catch(() => undefined).then(() => persistAccountState(state, revision))
      : persistAccountState(state, revision))
      .catch((error: unknown) => {
        console.error('Stone+ could not persist account health state', error)
      })
    accountStatePersistenceFlights.set(state.accountId, operation)
    void operation.finally(() => {
      if (accountStatePersistenceFlights.get(state.accountId) === operation) {
        accountStatePersistenceFlights.delete(state.accountId)
      }
    })
  }

  const flushPendingAccountStates = async (): Promise<void> => {
    scheduledAccountStateFlush = undefined
    const pending = [...pendingActiveAccountStates.values()]
    pendingActiveAccountStates.clear()
    const eligible = pending.filter((state) => {
      const current = store.getRuntimeAccount(state.accountId)
      // Coalesced success telemetry is stale-able by design. Never let it undo
      // a user disable or a newer circuit-breaker transition.
      return current?.status === 'active'
        && current.circuitState !== 'open'
        && current.circuitState !== 'half-open'
        && (current.consecutiveFailures ?? 0) === 0
    })
    if (eligible.length === 0) return
    try {
      await store.updateAccountRuntimeStates(eligible.map((state) => ({
        id: state.accountId,
        patch: {
          latencyMs: state.latencyMs,
          lastUsedAt: state.lastUsedAt,
          ...(state.quota ? { quota: state.quota } : {}),
          ...(state.codexQuota ? { codexQuota: state.codexQuota } : {})
        }
      })))
      const refreshedAccounts = eligible
        .filter((state) => state.quota || state.codexQuota)
        .flatMap((state) => {
        const account = store.getRuntimeAccount(state.accountId)
        return account ? [account] : []
      })
      if (refreshedAccounts.length) gateway.updateRuntimeAccounts(refreshedAccounts)
      for (const state of eligible) scheduleRuntimeDelta({
        gatewayStatus: true,
        accountId: state.accountId
      })
    } catch (error: unknown) {
      console.error('Stone+ could not persist coalesced account health state', error)
    }
  }

  const runAccountStateFlush = (): Promise<void> => {
    if (accountStateFlushFlight) return accountStateFlushFlight
    const flight = flushPendingAccountStates().finally(() => {
      if (accountStateFlushFlight === flight) accountStateFlushFlight = undefined
    })
    accountStateFlushFlight = flight
    return flight
  }

  const unsubscribeAccountState = gateway.onAccountState((state) => {
    const persisted = store.getRuntimeAccount(state.accountId)
    // A gateway callback can race a manual disable/delete that has already won
    // the durable state. Runtime health telemetry must never revive it.
    if (!persisted || persisted.status === 'disabled' || persisted.status === 'expired') {
      pendingActiveAccountStates.delete(state.accountId)
      latestObservedAccountStates.delete(state.accountId)
      accountStateRevisions.set(
        state.accountId,
        (accountStateRevisions.get(state.accountId) ?? 0) + 1
      )
      return
    }
    const before = latestObservedAccountStates.get(state.accountId) ?? {
      accountId: persisted.id,
      status: persisted.status,
      circuitState: persisted.circuitState,
      consecutiveFailures: persisted.consecutiveFailures ?? 0,
      cooldownUntil: persisted.cooldownUntil,
      cooldownReason: persisted.cooldownReason,
      latencyMs: persisted.latencyMs,
      lastError: persisted.lastError,
      lastUsedAt: persisted.lastUsedAt,
      quota: persisted.quota,
      codexQuota: persisted.codexQuota
    }
    latestObservedAccountStates.set(state.accountId, state)
    const routingTransition = state.status !== 'active'
      || before.status !== 'active'
      || before.circuitState === 'open'
      || before.circuitState === 'half-open'
      || (before.consecutiveFailures ?? 0) > 0
    if (routingTransition) {
      const revision = (accountStateRevisions.get(state.accountId) ?? 0) + 1
      accountStateRevisions.set(state.accountId, revision)
      pendingActiveAccountStates.delete(state.accountId)
      enqueueAccountStatePersistence(state, revision)
      return
    }
    const pending = pendingActiveAccountStates.get(state.accountId)
    pendingActiveAccountStates.set(state.accountId, pending ? { ...pending, ...state } : state)
    if (!scheduledAccountStateFlush) {
      scheduledAccountStateFlush = setTimeout(() => {
        scheduledAccountStateFlush = undefined
        void runAccountStateFlush().catch((error: unknown) => {
          console.error('Stone+ could not flush account health state', error)
        })
      }, accountStateFlushDelayMs)
    }
  })

  for (const account of store.getRuntimeAccounts()) {
    if ((account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity')
      && account.cooldownReason === 'quota') {
      const resetAt = codexQuotaCooldownUntil(account.codexQuota)
      scheduleQuotaProbe(account.id, resetAt ? resetAt + 1_000 : Date.now() + 1_000)
    }
  }
  evaluateAutomaticCooldownRefresh()

  ipcMain.handle('stone:set-ui-language', (event, language: UiLanguage) => {
    assertTrustedSender(event)
    if (language !== 'zh-CN' && language !== 'en') throw new Error('Invalid UI language.')
    rendererLanguage = language
  })
  ipcMain.handle('stone:get-snapshot', (event) => {
    assertTrustedSender(event)
    store.setGatewayStatus(gateway.getStatus())
    return withRuntimeMetrics(store.getSnapshot())
  })
  ipcMain.handle('stone:save-provider', (event, input: Parameters<GatewayApi['saveProvider']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.saveProvider(input))
  })
  ipcMain.handle('stone:refresh-provider-models', async (event, id: string) => {
    assertTrustedSender(event)
    const models = await discoverProviderModels(store, outboundTransport, id)
    return mutate(() => store.setProviderModels(id, models))
  })
  ipcMain.handle('stone:delete-provider', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteProvider(id))
  })
  ipcMain.handle('stone:save-account', (event, input: Parameters<GatewayApi['saveAccount']>[0]) => {
    assertTrustedSender(event)
    return mutate(async () => {
      const snapshot = await store.saveAccount(input)
      if (input.id && input.credential?.trim()) gateway.resetAccountHealth(input.id)
      return snapshot
    })
  })
  ipcMain.handle('stone:save-account-tag', (event, input: Parameters<GatewayApi['saveAccountTag']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.saveAccountTag(input))
  })
  ipcMain.handle('stone:delete-account-tag', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteAccountTag(id))
  })
  ipcMain.handle('stone:set-account-tags', (event, input: Parameters<GatewayApi['setAccountTags']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.setAccountTags(input))
  })
  ipcMain.handle('stone:refresh-account-models', async (event, id: string) => {
    assertTrustedSender(event)
    const discoveryFingerprint = store.getAccountModelDiscoveryFingerprint(id)
    const models = await discoverAccountModels(store, outboundTransport, id)
    return mutate(() => store.setAccountModels(id, models, discoveryFingerprint))
  })
  ipcMain.handle('stone:test-account-model', async (event, accountId: string, model: string) => {
    assertTrustedSender(event)
    return testAccountModel(store, outboundTransport, accountId, model)
  })
  ipcMain.handle('stone:import-chatgpt-accounts', async (event, input: Parameters<GatewayApi['importChatGptAccounts']>[0]) => {
    assertTrustedSender(event)
    emitImportProgress(event.sender, input?.progressId, { phase: 'importing', completed: 0, total: 1, percent: 0, message: nativeText('正在解析并导入账号…', 'Parsing and importing accounts…') })
    const imported = await store.importChatGptAccounts(input)
    emitImportProgress(event.sender, input?.progressId, { phase: 'importing', completed: 1, total: 1, percent: 50, message: nativeText(`已导入 ${imported.importedAccountIds.length} 个账号`, `Imported ${imported.importedAccountIds.length} account(s)`) })
    publish(refreshRuntime())
    emitImportProgress(event.sender, input?.progressId, { phase: 'refreshing', completed: 0, total: imported.importedAccountIds.length, percent: 50, message: nativeText(`正在刷新状态与查询模型 0/${imported.importedAccountIds.length}`, `Refreshing status and models 0/${imported.importedAccountIds.length}`) })
    const detectionResults = await detectImportedAccounts(imported.importedAccountIds, (completed, total) => {
      emitImportProgress(event.sender, input?.progressId, { phase: 'refreshing', completed, total, percent: 50 + Math.round(completed / Math.max(1, total) * 50), message: nativeText(`正在刷新状态与查询模型 ${completed}/${total}`, `Refreshing status and models ${completed}/${total}`) })
    })
    emitImportProgress(event.sender, input?.progressId, { phase: 'assigning', completed: 0, total: 1, percent: 95, message: nativeText('正在整理 Tag 与号池成员…', 'Organizing Tags and pool members…') })
    const assignmentSummary = await finalizeImportAssignments(
      imported.importedAccountIds,
      detectionResults,
      input.tagId,
      input.poolId
    )
    publish(refreshRuntime())
    emitImportProgress(event.sender, input?.progressId, { phase: 'complete', completed: imported.importedAccountIds.length, total: imported.importedAccountIds.length, percent: 100, message: nativeText('导入、状态刷新与模型查询已完成', 'Import, status refresh, and model lookup complete') })
    return { ...imported, detectionResults, assignmentSummary, snapshot: store.getSnapshot() }
  })
  ipcMain.handle('stone:start-chatgpt-oauth', async (event, input: Parameters<GatewayApi['startChatGptOAuth']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('OAuth 授权参数无效。')
    const normalized: OAuthStartInput = {
      ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
      tagId: input.tagId ?? null,
      poolId: input.poolId ?? null,
      // OAuth has no file-provided proxy to preserve. Treat the shared import
      // control's legacy “preserve” value as an explicit direct selection.
      proxyMode: input.proxyMode === 'preserve' ? 'direct' : input.proxyMode ?? 'direct',
      ...(typeof input.proxyId === 'string' && input.proxyId.trim() ? { proxyId: input.proxyId.trim() } : {})
    }
    validateAccountImportProxySelection(normalized.proxyMode, normalized.proxyId, store.getRuntimeProxies())
    store.validateChatGptImportAssignments(normalized.tagId, normalized.poolId)
    const owner = event.sender
    let ownerGoneDuringStart = owner.isDestroyed()
    const markOwnerGone = (): void => { ownerGoneDuringStart = true }
    owner.once('destroyed', markOwnerGone)
    owner.once('render-process-gone', markOwnerGone)
    let started: Awaited<ReturnType<ChatGptOAuthSessionController['start']>>
    try {
      started = await chatGptOAuth.start(resolvedNativeLanguage())
    } finally {
      owner.removeListener('destroyed', markOwnerGone)
      owner.removeListener('render-process-gone', markOwnerGone)
    }
    if (ownerGoneDuringStart || owner.isDestroyed()) {
      chatGptOAuth.cancel(started.sessionId)
      throw new Error('OAuth 授权窗口已经关闭。')
    }
    const onOwnerGone = (): void => {
      const current = oauthImportSessions.get(started.sessionId)
      if (current) cancelOAuthSession(started.sessionId, current)
    }
    const cleanupTimer = setTimeout(() => {
      const current = oauthImportSessions.get(started.sessionId)
      if (!current) return
      cancelOAuthSession(started.sessionId, current)
    }, Math.max(1, started.expiresAt - Date.now() + 1_000))
    cleanupTimer.unref?.()
    const session: OAuthImportSession = {
      input: normalized,
      owner,
      ownerId: owner.id,
      onOwnerGone,
      cleanupTimer,
      cancelled: false,
      committing: false,
      cleaned: false
    }
    oauthImportSessions.set(started.sessionId, session)
    owner.once('destroyed', onOwnerGone)
    owner.once('render-process-gone', onOwnerGone)
    if (owner.isDestroyed()) {
      cancelOAuthSession(started.sessionId, session)
      throw new Error('OAuth 授权窗口已经关闭。')
    }
    return started
  })
  ipcMain.handle('stone:open-chatgpt-oauth', async (event, sessionId: string) => {
    assertTrustedSender(event)
    const owned = requireOwnedOAuthSession(sessionId, event.sender)
    await chatGptOAuth.open(owned.id)
  })
  ipcMain.handle('stone:submit-chatgpt-oauth-callback', (event, input: Parameters<GatewayApi['submitChatGptOAuthCallback']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('OAuth 回调参数无效。')
    const owned = requireOwnedOAuthSession(input.sessionId, event.sender)
    chatGptOAuth.submitCallback(owned.id, input.callbackUrl)
  })
  ipcMain.handle('stone:wait-chatgpt-oauth', (event, sessionId: string) => {
    assertTrustedSender(event)
    const owned = requireOwnedOAuthSession(sessionId, event.sender)
    if (!owned.session.completion) {
      const completion = completeChatGptOAuth(owned.id, owned.session).finally(() => {
        cleanupOAuthSession(owned.id, owned.session, { cancelFlow: false, markCancelled: true })
      })
      owned.session.completion = completion
      oauthCompletionFlights.add(completion)
      void completion.then(
        () => oauthCompletionFlights.delete(completion),
        () => oauthCompletionFlights.delete(completion)
      )
    }
    return owned.session.completion
  })
  ipcMain.handle('stone:cancel-chatgpt-oauth', (event, sessionId: string) => {
    assertTrustedSender(event)
    const owned = requireOwnedOAuthSession(sessionId, event.sender)
    return cancelOAuthSession(owned.id, owned.session)
  })
  ipcMain.handle('stone:import-chatgpt-account-files', async (event, input: Parameters<GatewayApi['importChatGptAccountFiles']>[0]) => {
    assertTrustedSender(event)
    if (!input) throw new Error(nativeText('账号导入参数无效。', 'The account import parameters are invalid.'))
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error(nativeText('无法打开账号文件选择器。', 'Unable to open the account file picker.'))
    const selection = await dialog.showOpenDialog(owner, {
      title: nativeText('选择 CPA / Sub2API 账号 JSON', 'Select CPA / Sub2API account JSON files'),
      buttonLabel: nativeText('导入并检测', 'Import and check'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'CPA / Sub2API JSON', extensions: ['json', 'txt'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (selection.canceled || !selection.filePaths.length) {
      return emptyFileImportResult(store.getSnapshot(), input.tagId, input.poolId)
    }
    emitImportProgress(event.sender, input.progressId, { phase: 'importing', completed: 0, total: selection.filePaths.length, percent: 0, message: nativeText(`正在导入文件 0/${selection.filePaths.length}`, `Importing files 0/${selection.filePaths.length}`) })
    validateAccountImportProxySelection(input.proxyMode, input.proxyId, store.getRuntimeProxies())
    store.validateChatGptImportAssignments(input.tagId, input.poolId)
    if (selection.filePaths.length > 100) throw new Error(nativeText('一次最多导入 100 个账号文件。', 'You can import up to 100 account files at a time.'))

    const fileResults: Awaited<ReturnType<GatewayApi['importChatGptAccountFiles']>>['fileResults'] = []
    const readableFiles: Array<{ fileName: string; content: string }> = []
    let totalBytes = 0
    for (const path of selection.filePaths) {
      const fileName = basename(path)
      try {
        if (!['.json', '.txt'].includes(extname(fileName).toLowerCase())) throw new Error(nativeText('只支持 .json 或 .txt 文件。', 'Only .json and .txt files are supported.'))
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(nativeText('所选路径不是普通账号文件。', 'The selected path is not a regular account file.'))
        if (info.size > 4 * 1024 * 1024) throw new Error(nativeText('单个账号文件不能超过 4 MB。', 'Each account file must be no larger than 4 MB.'))
        totalBytes += info.size
        readableFiles.push({ fileName, content: await readFile(path, 'utf8') })
      } catch (error) {
        fileResults.push({ fileName, status: 'failed', importedAccounts: 0, createdAccounts: 0, updatedAccounts: 0, error: importErrorMessage(error) })
      }
    }
    if (totalBytes > 32 * 1024 * 1024) throw new Error(nativeText('本次所选账号文件总大小不能超过 32 MB。', 'The selected account files must total no more than 32 MB.'))

    const importedAccountIds: string[] = []
    const createdAccountIds: string[] = []
    const updatedAccountIds: string[] = []
    const warnings: string[] = []
    let processedFiles = fileResults.length
    if (processedFiles > 0) {
      emitImportProgress(event.sender, input.progressId, { phase: 'importing', completed: processedFiles, total: selection.filePaths.length, percent: Math.round(processedFiles / selection.filePaths.length * 50), message: nativeText(`正在导入文件 ${processedFiles}/${selection.filePaths.length}`, `Importing files ${processedFiles}/${selection.filePaths.length}`) })
    }
    for (const file of readableFiles) {
      try {
        const imported = await store.importChatGptAccounts({
          content: file.content,
          proxyMode: input.proxyMode,
          proxyId: input.proxyId,
          tagId: input.tagId,
          poolId: input.poolId
        })
        importedAccountIds.push(...imported.importedAccountIds)
        createdAccountIds.push(...imported.createdAccountIds)
        updatedAccountIds.push(...imported.updatedAccountIds)
        warnings.push(...imported.warnings.map((warning) => `${file.fileName}：${warning}`))
        fileResults.push({
          fileName: file.fileName,
          status: 'imported',
          importedAccounts: imported.importedAccountIds.length,
          createdAccounts: imported.createdAccountIds.length,
          updatedAccounts: imported.updatedAccountIds.length
        })
      } catch (error) {
        fileResults.push({ fileName: file.fileName, status: 'failed', importedAccounts: 0, createdAccounts: 0, updatedAccounts: 0, error: importErrorMessage(error) })
      }
      processedFiles += 1
      emitImportProgress(event.sender, input.progressId, { phase: 'importing', completed: processedFiles, total: selection.filePaths.length, percent: Math.round(processedFiles / selection.filePaths.length * 50), message: nativeText(`正在导入文件 ${processedFiles}/${selection.filePaths.length}`, `Importing files ${processedFiles}/${selection.filePaths.length}`) })
    }
    publish(refreshRuntime())

    const uniqueImportedIds = [...new Set(importedAccountIds)]
    emitImportProgress(event.sender, input.progressId, { phase: 'refreshing', completed: 0, total: uniqueImportedIds.length, percent: 50, message: nativeText(`正在刷新状态与查询模型 0/${uniqueImportedIds.length}`, `Refreshing status and models 0/${uniqueImportedIds.length}`) })
    const detectionResults = await detectImportedAccounts(uniqueImportedIds, (completed, total) => {
      emitImportProgress(event.sender, input.progressId, { phase: 'refreshing', completed, total, percent: 50 + Math.round(completed / Math.max(1, total) * 50), message: nativeText(`正在刷新状态与查询模型 ${completed}/${total}`, `Refreshing status and models ${completed}/${total}`) })
    })
    emitImportProgress(event.sender, input.progressId, { phase: 'assigning', completed: 0, total: 1, percent: 95, message: nativeText('正在整理 Tag 与号池成员…', 'Organizing Tags and pool members…') })
    const assignmentSummary = await finalizeImportAssignments(
      uniqueImportedIds,
      detectionResults,
      input.tagId,
      input.poolId
    )
    publish(refreshRuntime())
    emitImportProgress(event.sender, input.progressId, { phase: 'complete', completed: uniqueImportedIds.length, total: uniqueImportedIds.length, percent: 100, message: nativeText('导入、状态刷新与模型查询已完成', 'Import, status refresh, and model lookup complete') })
    return {
      snapshot: store.getSnapshot(),
      cancelled: false,
      selectedFiles: selection.filePaths.length,
      fileResults: fileResults.sort((left, right) => left.fileName.localeCompare(right.fileName)),
      importedAccountIds: uniqueImportedIds,
      createdAccountIds: [...new Set(createdAccountIds)],
      updatedAccountIds: [...new Set(updatedAccountIds)],
      detectionResults,
      warnings: [...new Set(warnings)],
      assignmentSummary
    }

  })
  ipcMain.handle('stone:get-browser-import-queue', (event) => {
    assertTrustedSender(event)
    return browserImports?.getState() ?? { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
  })
  ipcMain.handle('stone:remove-browser-import-item', (event, id: string) => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || !id) throw new Error('无效的挂起文件。')
    return browserImports?.remove(id) ?? { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
  })
  ipcMain.handle('stone:clear-browser-import-queue', (event) => {
    assertTrustedSender(event)
    return browserImports?.clear() ?? { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
  })
  ipcMain.handle('stone:get-browser-json-cache', (event) => {
    assertTrustedSender(event)
    return browserImports?.getCacheState() ?? { items: [], totalBytes: 0 }
  })
  ipcMain.handle('stone:save-browser-json-cache-item', async (event, id: string) => {
    assertTrustedSender(event)
    if (!browserImports || typeof id !== 'string' || !id) throw new Error(nativeText('无效的缓存文件。', 'The cached file is invalid.'))
    const item = browserImports.getCachedItem(id)
    if (!item) throw new Error(nativeText('缓存中的 JSON 已不存在。', 'The cached JSON file no longer exists.'))
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error(nativeText('无法打开 JSON 另存为窗口。', 'Unable to open the Save JSON dialog.'))
    const selection = await dialog.showSaveDialog(owner, {
      title: nativeText('另存为下载过的 JSON', 'Save downloaded JSON as'),
      buttonLabel: nativeText('保存 JSON', 'Save JSON'),
      defaultPath: item.fileName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (selection.canceled || !selection.filePath) return { cancelled: true }
    await browserImports.saveCachedItem(id, selection.filePath)
    return { cancelled: false, filePath: selection.filePath }
  })
  ipcMain.handle('stone:remove-browser-json-cache-item', async (event, id: string) => {
    assertTrustedSender(event)
    if (!browserImports || typeof id !== 'string' || !id) throw new Error('无效的缓存文件。')
    return browserImports.removeCachedItem(id)
  })
  ipcMain.handle('stone:clear-browser-json-cache', (event) => {
    assertTrustedSender(event)
    return browserImports?.clearCache() ?? { items: [], totalBytes: 0 }
  })
  ipcMain.handle('stone:import-browser-json-queue', async (event, input: Parameters<GatewayApi['importBrowserJsonQueue']>[0]) => {
    assertTrustedSender(event)
    if (!browserImports) throw new Error('内置浏览器下载队列尚未初始化。')
    if (!input) throw new Error('账号导入参数无效。')
    if (!Array.isArray(input.itemIds)) throw new Error('请选择需要导入的挂起 JSON。')
    validateAccountImportProxySelection(input.proxyMode, input.proxyId, store.getRuntimeProxies())
    store.validateChatGptImportAssignments(input.tagId, input.poolId)
    const files = browserImports.getReadyItems(input.itemIds)
    emitImportProgress(event.sender, input.progressId, { phase: 'importing', completed: 0, total: files.length, percent: 0, message: nativeText(`正在导入文件 0/${files.length}`, `Importing files 0/${files.length}`) })
    const fileResults: Awaited<ReturnType<GatewayApi['importBrowserJsonQueue']>>['fileResults'] = []
    const importedAccountIds: string[] = []
    const createdAccountIds: string[] = []
    const updatedAccountIds: string[] = []
    const importedItemIds: string[] = []
    const warnings: string[] = []

    let processedFiles = 0
    for (const file of files) {
      try {
        const imported = await store.importChatGptAccounts({
          content: file.content,
          proxyMode: input.proxyMode,
          proxyId: input.proxyId,
          tagId: input.tagId,
          poolId: input.poolId
        })
        importedAccountIds.push(...imported.importedAccountIds)
        createdAccountIds.push(...imported.createdAccountIds)
        updatedAccountIds.push(...imported.updatedAccountIds)
        warnings.push(...imported.warnings.map((warning) => `${file.fileName}：${warning}`))
        importedItemIds.push(file.id)
        fileResults.push({
          fileName: file.fileName,
          status: 'imported',
          importedAccounts: imported.importedAccountIds.length,
          createdAccounts: imported.createdAccountIds.length,
          updatedAccounts: imported.updatedAccountIds.length
        })
      } catch (error) {
        fileResults.push({
          fileName: file.fileName,
          status: 'failed',
          importedAccounts: 0,
          createdAccounts: 0,
          updatedAccounts: 0,
          error: importErrorMessage(error)
        })
      }
      processedFiles += 1
      emitImportProgress(event.sender, input.progressId, { phase: 'importing', completed: processedFiles, total: files.length, percent: Math.round(processedFiles / Math.max(1, files.length) * 50), message: nativeText(`正在导入文件 ${processedFiles}/${files.length}`, `Importing files ${processedFiles}/${files.length}`) })
    }
    if (importedItemIds.length) browserImports.removeMany(importedItemIds)
    publish(refreshRuntime())
    const uniqueImportedIds = [...new Set(importedAccountIds)]
    emitImportProgress(event.sender, input.progressId, { phase: 'refreshing', completed: 0, total: uniqueImportedIds.length, percent: 50, message: nativeText(`正在刷新状态与查询模型 0/${uniqueImportedIds.length}`, `Refreshing status and models 0/${uniqueImportedIds.length}`) })
    const detectionResults = await detectImportedAccounts(uniqueImportedIds, (completed, total) => {
      emitImportProgress(event.sender, input.progressId, { phase: 'refreshing', completed, total, percent: 50 + Math.round(completed / Math.max(1, total) * 50), message: nativeText(`正在刷新状态与查询模型 ${completed}/${total}`, `Refreshing status and models ${completed}/${total}`) })
    })
    emitImportProgress(event.sender, input.progressId, { phase: 'assigning', completed: 0, total: 1, percent: 95, message: nativeText('正在整理 Tag 与号池成员…', 'Organizing Tags and pool members…') })
    const assignmentSummary = await finalizeImportAssignments(
      uniqueImportedIds,
      detectionResults,
      input.tagId,
      input.poolId
    )
    publish(refreshRuntime())
    emitImportProgress(event.sender, input.progressId, { phase: 'complete', completed: uniqueImportedIds.length, total: uniqueImportedIds.length, percent: 100, message: nativeText('导入、状态刷新与模型查询已完成', 'Import, status refresh, and model lookup complete') })
    return {
      snapshot: store.getSnapshot(),
      cancelled: false,
      selectedFiles: files.length,
      fileResults,
      importedAccountIds: uniqueImportedIds,
      createdAccountIds: [...new Set(createdAccountIds)],
      updatedAccountIds: [...new Set(updatedAccountIds)],
      detectionResults,
      warnings: [...new Set(warnings)],
      assignmentSummary
    }
  })
  ipcMain.handle('stone:export-chatgpt-accounts', async (event, input: Parameters<GatewayApi['exportChatGptAccounts']>[0]) => {
    assertTrustedSender(event)
    if (!input || !Array.isArray(input.accountIds) || !['cpa', 'sub2api'].includes(input.format)
      || !['merged', 'separate'].includes(input.mode)) {
      throw new Error(nativeText('账号导出参数无效。', 'The account export parameters are invalid.'))
    }
    const accountIds = [...new Set(input.accountIds)]
    if (!accountIds.length) throw new Error(nativeText('请至少选择一个账号。', 'Select at least one account.'))
    if (accountIds.length > 500) throw new Error(nativeText('一次最多导出 500 个账号。', 'You can export up to 500 accounts at a time.'))
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error(nativeText('无法打开账号导出文件选择器。', 'Unable to open the account export file picker.'))
    const date = new Date().toISOString().slice(0, 10)
    if (input.mode === 'merged') {
      const exported = store.exportChatGptAccounts(accountIds, input.format)
      const selection = await dialog.showSaveDialog(owner, {
        title: nativeText(
          `合并导出 ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} 账号 JSON`,
          `Export merged ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} account JSON`,
        ),
        buttonLabel: nativeText('保存账号 JSON', 'Save account JSON'),
        defaultPath: `stoneplus-${input.format}-accounts-${date}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (selection.canceled || !selection.filePath) {
        return { cancelled: true, exportedAccounts: 0, exportedFiles: 0 }
      }
      await writeFile(selection.filePath, exported.content, { encoding: 'utf8', flag: 'w' })
      return {
        cancelled: false,
        exportedAccounts: exported.exportedAccounts,
        exportedFiles: 1,
        filePath: selection.filePath
      }
    }

    const selection = await dialog.showOpenDialog(owner, {
      title: nativeText(
        `选择分别导出 ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} JSON 的目录`,
        `Select a folder for separate ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} JSON files`,
      ),
      buttonLabel: nativeText('导出到此目录', 'Export to this folder'),
      properties: ['openDirectory', 'createDirectory']
    })
    const directoryPath = selection.filePaths[0]
    if (selection.canceled || !directoryPath) {
      return { cancelled: true, exportedAccounts: 0, exportedFiles: 0 }
    }
    const snapshot = store.getSnapshot()
    const accountById = new Map(snapshot.accounts.map((account) => [account.id, account]))
    const batchId = randomUUID().slice(0, 8)
    const files = accountIds.map((accountId, index) => {
      const account = accountById.get(accountId)
      if (!account) throw new Error(nativeText('所选账号中有账号已不存在。', 'One of the selected accounts no longer exists.'))
      const exported = store.exportChatGptAccounts([accountId], input.format)
      const prefix = String(index + 1).padStart(3, '0')
      return {
        path: join(directoryPath, `${prefix}-${safeExportFileName(account.name)}-${input.format}-${batchId}.json`),
        content: exported.content
      }
    })
    await mapConcurrent(files, 4, async (file) => {
      await writeFile(file.path, file.content, { encoding: 'utf8', flag: 'wx' })
    })
    return {
      cancelled: false,
      exportedAccounts: accountIds.length,
      exportedFiles: files.length,
      directoryPath
    }
  })
  ipcMain.handle('stone:delete-account', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteAccount(id))
  })
  ipcMain.handle('stone:delete-accounts', (event, ids: string[]) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteAccounts(ids))
  })
  ipcMain.handle('stone:save-proxy', (event, input: Parameters<GatewayApi['saveProxy']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.saveProxy(input))
  })
  ipcMain.handle('stone:delete-proxy', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteProxy(id))
  })
  ipcMain.handle('stone:check-proxy', async (event, id: string) => {
    assertTrustedSender(event)
    const proxy = store.getSnapshot().proxies.find((candidate) => candidate.id === id)
    if (!proxy) throw new Error('Proxy not found.')
    try {
      const result = await probeProxy(outboundTransport, proxy, store.getProxyPassword(id))
      return publish(await store.setProxyCheckResult(id, {
        status: 'available',
        exitIp: result.exitIp,
        latencyMs: result.latencyMs,
        lastCheckedAt: Date.now(),
        lastError: undefined
      }))
    } catch (error) {
      return publish(await store.setProxyCheckResult(id, {
        status: 'error',
        lastCheckedAt: Date.now(),
        lastError: proxyCheckErrorMessage(error),
        exitIp: undefined,
        latencyMs: undefined
      }))
    }
  })
  ipcMain.handle('stone:save-pool', (event, input: Parameters<GatewayApi['savePool']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.savePool(input))
  })
  ipcMain.handle('stone:delete-pool', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deletePool(id))
  })
  ipcMain.handle('stone:set-route-source-fast-mode', (event, input: Parameters<GatewayApi['setRouteSourceFastMode']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('FAST 配置参数无效。')
    return mutate(() => store.setRouteSourceFastMode(input))
  })
  ipcMain.handle('stone:save-api-source', async (event, input: Parameters<GatewayApi['saveApiSource']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('API 来源参数无效。')
    const initialProbeEvidence = !input.id?.trim()
      ? consumeUnsavedApiSourceProbeEvidence(input.probeEvidenceToken, input)
      : undefined
    const sourceInput = initialProbeEvidence
      ? {
          ...input,
          capabilityProfile: initialProbeEvidence.capabilityProfile,
          modelCatalog: initialProbeEvidence.modelCatalog,
        }
      : input
    const saved = await store.saveApiSource(sourceInput, {
      acceptInitialProbeEvidence: Boolean(initialProbeEvidence),
    })
    if (saved.source.connectionChanged) {
      gateway.resetAccountHealth(saved.source.accountId, { clearPerformance: true })
    }
    const snapshot = publish(refreshRuntime())
    if (saved.source.connectionChanged && gateway.getStatus().running) {
      warmGatewayConnections(store, outboundTransport)
    }
    return snapshot
  })
  ipcMain.handle('stone:probe-api-source', async (event, input: Parameters<GatewayApi['probeApiSource']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('API 来源测试参数无效。')
    const normalized = normalizeApiSourceProbeInput(input)
    const persistentSourceId = input.id?.trim() && input.persistCapabilities ? input.id.trim() : undefined
    const probeOwner = persistentSourceId ? Symbol(persistentSourceId) : undefined
    if (persistentSourceId && probeOwner) apiSourceCapabilityProbeOwners.set(persistentSourceId, probeOwner)
    try {
      const connectionFingerprint = persistentSourceId
        ? store.getApiSourceProbeConnectionFingerprint(normalized)
        : undefined
      const existingAccount = input.id
        ? store.getRuntimeAccounts().find((account) => account.providerId === input.id
          && account.credentialType !== 'chatgpt-oauth'
          && account.credentialType !== 'chatgpt-agent-identity')
        : undefined
      const selectedProxyId = typeof normalized.proxyId === 'string' && normalized.proxyId.trim()
        ? normalized.proxyId.trim()
        : existingAccount?.proxyId
      const proxy = selectedProxyId
        ? store.getSnapshot().proxies.find((candidate) => candidate.id === selectedProxyId)
        : undefined
      if (selectedProxyId && !proxy) throw new Error('选择的代理已被删除。')
      const fetchImplementation = outboundTransport.fetchFor(
        proxy,
        proxy ? store.getProxyPassword(proxy.id) : undefined
      )
      const result = await runApiSourceProbe(normalized, {
        storedCredential: input.id ? store.getApiSourceCredential(input.id) : undefined,
        fetchImplementation,
      })
      if (!input.id?.trim() && result.ok) {
        result.probeEvidenceToken = issueUnsavedApiSourceProbeEvidence(normalized, result)
      }
      if (persistentSourceId && result.ok && connectionFingerprint) {
        if (apiSourceCapabilityProbeOwners.get(persistentSourceId) !== probeOwner) {
          result.warnings.push(nativeText(
            '更新的来源探测已启动，本次较旧的能力结果未保存。',
            'A newer source probe superseded this result, so the older capability result was not saved.',
          ))
        } else {
          const persisted = await store.saveApiSourceCapabilityProbe(
            persistentSourceId,
            result,
            connectionFingerprint,
          )
          if (persisted) publish(persisted)
          else result.warnings.push(nativeText(
            '来源连接配置已在探测期间变化，本次能力结果未保存。',
            'The source connection changed during probing, so this capability result was not saved.',
          ))
        }
      }
      return result
    } finally {
      if (persistentSourceId && apiSourceCapabilityProbeOwners.get(persistentSourceId) === probeOwner) {
        apiSourceCapabilityProbeOwners.delete(persistentSourceId)
      }
    }
  })
  ipcMain.handle('stone:delete-api-source', (event, id: string) => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('API 来源 ID 无效。')
    return mutate(() => store.deleteApiSource(id))
  })
  ipcMain.handle('stone:save-aggregate-relay', (event, input: Parameters<GatewayApi['saveAggregateRelay']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('聚合中转参数无效。')
    return mutate(() => store.saveAggregateRelay(input))
  })
  ipcMain.handle('stone:get-setup-wizard-state', (event) => {
    assertTrustedSender(event)
    return store.getSetupWizardState()
  })
  ipcMain.handle('stone:save-setup-wizard-progress', (event, input: Parameters<GatewayApi['saveSetupWizardProgress']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('配置向导进度无效。')
    return store.saveSetupWizardProgress(input)
  })
  ipcMain.handle('stone:discard-setup-wizard', async (event) => {
    assertTrustedSender(event)
    await store.discardSetupWizard()
    publish(refreshRuntime())
  })
  ipcMain.handle('stone:complete-setup-wizard', async (event, sessionId: string) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('配置向导会话无效。')
    await store.completeSetupWizard(sessionId)
  })
  ipcMain.handle('stone:apply-setup-routing', async (event, input: Parameters<GatewayApi['applySetupRouting']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('向导路由参数无效。')
    const result = await store.applySetupRouting(input)
    const snapshot = publish(refreshRuntime())
    return { ...result, snapshot }
  })
  ipcMain.handle('stone:ensure-gateway-running', async (event, input: Parameters<GatewayApi['ensureGatewayRunning']>[0] = {}) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('网关启动参数无效。')
    return enqueueGatewayLifecycle(async () => {
      const status = gateway.getStatus()
      if (status.running) {
        store.setGatewayStatus(status)
        return { snapshot: publish(store.getSnapshot()), host: status.host, port: status.port, changedPort: false, started: false }
      }
      const current = store.getSnapshot().gateway
      const host = typeof input.host === 'string' && input.host.trim() ? input.host.trim() : current.host
      const requestedPort = normalizeSetupPort(input.port ?? current.port)
      const candidates = [requestedPort, ...Array.from({ length: 19 }, (_, index) => 15722 + index)]
        .filter((port, index, values) => values.indexOf(port) === index)
      let lastError: unknown
      for (const port of candidates) {
        const settings = { ...current, host, port }
        gateway.updateConfig(toGatewayConfig(store))
        try {
          await gateway.start(settings)
          await store.updateGateway(settings)
          outboundTransport.configureOutboundNetwork(settings.outboundNetworkMode ?? 'direct', settings.port)
          gateway.updateConfig(toGatewayConfig(store))
          warmGatewayConnections(store, outboundTransport)
          store.setGatewayStatus(gateway.getStatus())
          const wizard = store.getSetupWizardState()
          if (wizard) await store.saveSetupWizardProgress({ sessionId: wizard.sessionId, step: 'verify' })
          return {
            snapshot: publish(store.getSnapshot()),
            host,
            port,
            changedPort: port !== requestedPort,
            started: true,
          }
        } catch (error) {
          lastError = error
          if (!isAddressInUseError(error)) break
        }
      }
      gateway.updateConfig(toGatewayConfig(store))
      store.setGatewayStatus(gateway.getStatus())
      throw lastError instanceof Error ? lastError : new Error('无法启动本地网关。')
    })
  })
  ipcMain.handle('stone:verify-setup-route', async (event, input: Parameters<GatewayApi['verifySetupRoute']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('端到端验证参数无效。')
    assertRouteClient(input.client)
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const routeId = typeof input.routeId === 'string' ? input.routeId.trim() : ''
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!sessionId || !routeId) throw new Error('端到端验证缺少向导会话或路由绑定。')
    if (!model) throw new Error('请选择端到端验证模型。')
    const wizard = store.getSetupWizardState()
    if (!wizard || wizard.sessionId !== sessionId) throw new Error('配置向导会话不存在或已过期。')
    if (wizard.routeId !== routeId || wizard.client !== input.client || wizard.model !== model) {
      throw new Error('端到端验证目标与本次向导已应用的路由不一致。')
    }
    const snapshot = store.getSnapshot()
    const route = snapshot.routes.find((candidate) => candidate.id === routeId
      && candidate.client === input.client && candidate.enabled)
    if (!route) throw new Error('当前客户端路由未启用。')
    const routeRevision = route.updatedAt
    const status = gateway.getStatus()
    if (!status.running) throw new Error('本地网关尚未运行。')
    const host = status.host.includes(':') ? `[${status.host}]` : status.host
    const result = await verifySetupRouteRequest({
      baseUrl: `http://${host}:${status.port}`,
      client: input.client,
      model,
      token: route.localToken,
      timeoutMs: Math.max(10_000, snapshot.gateway.requestTimeoutSeconds * 1_000),
    })
    const currentWizard = store.getSetupWizardState()
    const currentRoute = store.getSnapshot().routes.find((candidate) => candidate.id === routeId)
    const targetUnchanged = currentWizard?.sessionId === sessionId
      && currentWizard.routeId === routeId
      && currentWizard.client === input.client
      && currentWizard.model === model
      && currentRoute?.updatedAt === routeRevision
      && currentRoute.enabled
    if (currentWizard?.sessionId === sessionId) {
      if (result.ok && targetUnchanged) {
        await store.markSetupWizardVerified(sessionId)
      } else {
        await store.saveSetupWizardProgress({
          sessionId,
          step: 'verify',
          client: input.client,
          model,
          lastError: result.ok ? '验证期间路由已变更，请重新运行端到端验证。' : result.error,
        })
      }
    }
    return result.ok && !targetUnchanged
      ? { ...result, ok: false, error: '验证期间路由已变更，请重新运行端到端验证。' }
      : result
  })
  ipcMain.handle('stone:update-route', (event, route: Route) => {
    assertTrustedSender(event)
    return mutate(() => store.updateRoute(route))
  })
  ipcMain.handle('stone:preview-route', (event, input: Parameters<GatewayApi['previewRoute']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object' || !input.route || typeof input.route !== 'object') {
      throw new Error('Route preview input is invalid.')
    }
    return previewRoute(input, store.getSnapshot())
  })
  ipcMain.handle('stone:set-client-route-source', (
    event,
    input: Parameters<GatewayApi['setClientRouteSource']>[0]
  ) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('路由来源参数无效。')
    assertRouteClient(input.client)
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
    if (!sourceId) throw new Error('请选择号池、官方 API 或中转站。')

    const snapshot = store.getSnapshot()
    if (hasRouteSourceIdCollision(sourceId, snapshot)) {
      throw new Error('所选来源 ID 与现有号池 ID 冲突。')
    }
    const source = resolveRouteSource(sourceId, snapshot)
    if (!source) throw new Error('所选号池、官方 API 或中转站不存在。')
    if (!source.accounts.some(isAvailableRouteAccount)) {
      throw new Error('所选来源没有可用账号。')
    }
    return mutate(() => store.setRouteSource(input.client, sourceId))
  })
  ipcMain.handle('stone:update-gateway', async (event, settings: GatewaySettings) => {
    assertTrustedSender(event)
    return enqueueGatewayLifecycle(async () => {
      const wasRunning = gateway.getStatus().running
      const previousSettings = store.getSnapshot().gateway
      const enablingAutomaticBackups = backups
        && previousSettings.automaticBackups === false
        && settings.automaticBackups !== false
      if (enablingAutomaticBackups) await backups.prepareForRawBackup()
      await store.updateGateway(settings)
      const savedGateway = store.getSnapshot().gateway
      if (backups
        && (previousSettings.automaticBackups !== false) !== (savedGateway.automaticBackups !== false)) {
        if (savedGateway.automaticBackups === false) {
          backups.stopAutomaticBackups()
        } else {
          try {
            await backups.startAutomaticBackups()
          } catch (error) {
            backups.stopAutomaticBackups()
            await store.updateGateway(previousSettings).catch(() => undefined)
            throw error
          }
        }
      }
      const requiresRestart = wasRunning
        && (previousSettings.host !== savedGateway.host || previousSettings.port !== savedGateway.port)
      const outboundModeChanged = (previousSettings.outboundNetworkMode ?? 'direct')
        !== (savedGateway.outboundNetworkMode ?? 'direct')
      outboundTransport.configureOutboundNetwork(
        savedGateway.outboundNetworkMode ?? 'direct',
        savedGateway.port
      )
      if (outboundModeChanged && savedGateway.outboundNetworkMode === 'system') {
        // Network failures recorded before this switch may have opened account
        // circuits. Re-check only failure-cooled accounts that actually use the
        // global system route; quota cooldowns and explicit proxies are left
        // untouched.
        await outboundReloadCoordinator.reloadExternalSystemRoute()
      }
      if (outboundModeChanged && wasRunning) warmGatewayConnections(store, outboundTransport)
      if (backups) {
        if ((previousSettings.backupRetention ?? 10) !== (savedGateway.backupRetention ?? 10)) {
          await backups.setAutomaticRetention(savedGateway.backupRetention ?? 10)
        }
      }
      if (requiresRestart) await gateway.stop()
      gateway.updateConfig(toGatewayConfig(store))
      try {
        if (requiresRestart) {
          await gateway.start()
          warmGatewayConnections(store, outboundTransport)
        }
      } catch (error: unknown) {
        store.setGatewayStatus(gateway.getStatus())
        publish(store.getSnapshot())
        throw error
      }
      store.setGatewayStatus(gateway.getStatus())
      return publish(store.getSnapshot())
    })
  })
  ipcMain.handle('stone:start-gateway', async (event) => {
    assertTrustedSender(event)
    return enqueueGatewayLifecycle(async () => {
      gateway.updateConfig(toGatewayConfig(store))
      await gateway.start()
      warmGatewayConnections(store, outboundTransport)
      store.setGatewayStatus(gateway.getStatus())
      return publish(store.getSnapshot())
    })
  })
  ipcMain.handle('stone:stop-gateway', async (event) => {
    assertTrustedSender(event)
    return enqueueGatewayLifecycle(async () => {
      await gateway.stop({ force: true })
      store.setGatewayStatus(gateway.getStatus())
      return publish(store.getSnapshot())
    })
  })
  ipcMain.handle('stone:rebuild-outbound-connections', async (event) => {
    assertTrustedSender(event)
    await rebuildGatewayConnections(store, outboundTransport)
  })
  ipcMain.handle('stone:detect-system-proxy', async (event) => {
    assertTrustedSender(event)
    return outboundReloadCoordinator.detectExternalSystemProxy()
  })
  ipcMain.handle('stone:run-network-diagnostics', async (event, input: Parameters<GatewayApi['runNetworkDiagnostics']>[0] = {}) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('Network diagnostic options are invalid.')
    const proxyId = typeof input.proxyId === 'string' && input.proxyId.trim() ? input.proxyId.trim() : undefined
    const proxy = proxyId ? store.getSnapshot().proxies.find((candidate) => candidate.id === proxyId) : undefined
    if (proxyId && !proxy) throw new Error('The selected proxy no longer exists.')
    const fetchImplementation = outboundTransport.fetchFor(
      proxy,
      proxy ? store.getProxyPassword(proxy.id) : undefined
    )
    return runNetworkDiagnostics({
      fetchImplementation,
      route: outboundTransport.describeEffectiveDiagnosticRoute(proxy)
    })
  })
  ipcMain.handle('stone:check-account', async (event, id: string) => {
    assertTrustedSender(event)
    return (await probeAndPersistAccount(id)).snapshot
  })
  ipcMain.handle('stone:start-account-check-task', async (event, requestedIds?: string[]) => {
    assertTrustedSender(event)
    const existing = persistentTaskRunner.list(2_000).find((task) => (
      task.kind === 'account.bulk-check' && (task.status === 'running' || task.status === 'paused')
    ))
    if (existing) return existing
    const requested = Array.isArray(requestedIds) ? new Set(requestedIds.filter((id) => typeof id === 'string')) : undefined
    const accountIds = store.getRuntimeAccounts()
      .filter((account) => !requested || requested.has(account.id))
      // Preserve the store order within each group while checking usable
      // accounts first and quota-exhausted accounts afterwards.
      .sort((left, right) => Number(accountCheckIsQuotaDeferred(left)) - Number(accountCheckIsQuotaDeferred(right)))
      .map((account) => account.id)
    if (accountIds.length === 0) throw new Error(nativeText('没有可检测的账号。', 'No accounts are available to check.'))
    const task = await persistentTaskRunner.create({
      kind: 'account.bulk-check',
      payload: { accountIds },
      total: accountIds.length,
      resumable: true
    })
    return persistentTaskRunner.resume(task.id)
  })
  ipcMain.handle('stone:refresh-account-codex-quota', async (event, id: string) => {
    assertTrustedSender(event)
    const quota = await refreshAccountCodexQuota(store, outboundTransport, id)
    const account = store.getRuntimeAccount(id)
    const now = Date.now()
    const exhausted = codexQuotaIsExhausted(quota, now)
    const cooldownUntil = exhausted ? codexQuotaCooldownUntil(quota, now) ?? now + 60_000 : undefined
    await store.setAccountCheckResult(id, exhausted ? {
      codexQuota: quota,
      status: 'cooldown',
      circuitState: 'open',
      cooldownReason: 'quota',
      cooldownUntil,
      lastError: 'ChatGPT Codex 额度已耗尽。'
    } : {
      codexQuota: quota,
      ...(account?.cooldownReason === 'quota' ? {
        status: 'active' as const,
        circuitState: 'closed' as const,
        consecutiveFailures: 0,
        cooldownReason: undefined,
        cooldownUntil: undefined,
        lastError: undefined
      } : {})
    })
    if (exhausted && cooldownUntil !== undefined) scheduleQuotaProbe(id, cooldownUntil + 1_000)
    else if (account?.cooldownReason === 'quota') gateway.resetAccountHealth(id)
    return publish(refreshRuntime())
  })
  ipcMain.handle('stone:get-account-codex-quota-history', (event, id: string, from?: number, to?: number) => {
    assertTrustedSender(event)
    if (!store.getSnapshot().accounts.some((account) => account.id === id)) throw new Error('Account not found.')
    return store.getAccountCodexQuotaHistory(id, from, to)
  })
  ipcMain.handle('stone:get-account-codex-quota-cycle-costs', (event, id: string) => {
    assertTrustedSender(event)
    return store.getAccountCodexQuotaCycleCosts(id)
  })
  ipcMain.handle('stone:clear-logs', (event) => {
    assertTrustedSender(event)
    const clearedPendingIds = [...pendingTerminalLogs.keys()]
    for (const pending of pendingTerminalLogs.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer)
    }
    pendingTerminalLogs.clear()
    pendingRequestLogs.clear()
    pendingRuntimeAccountIds.clear()
    pendingHealthEvents.clear()
    pendingObservability = false
    pendingGatewayStatus = false
    gateway.clearRequestReplays?.()
    return mutate(() => store.clearLogs(clearedPendingIds))
  })
  ipcMain.handle('stone:get-request-replay-template', (event, id: string) => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid request ID.')
    return gateway.getRequestReplayTemplate?.(id) ?? null
  })
  ipcMain.handle('stone:replay-request', async (event, id: string) => {
    assertTrustedSender(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid request ID.')
    if (!gateway.replayRequest) throw new Error('Request replay is unavailable.')
    return await gateway.replayRequest(id)
  })
  ipcMain.handle('stone:get-local-event-server-status', (event) => {
    assertTrustedSender(event)
    return localEvents?.getPublicStatus() ?? {
      running: false,
      discoveryFile: '',
      authentication: 'bearer-token' as const,
      connectedClients: 0
    }
  })
  ipcMain.handle('stone:clear-health-events', (event) => {
    assertTrustedSender(event)
    return mutate(() => store.clearHealthEvents())
  })
  ipcMain.handle('stone:save-client-profile', (event, input: Parameters<GatewayApi['saveClientProfile']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.saveClientProfile(input))
  })
  ipcMain.handle('stone:delete-client-profile', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteClientProfile(id))
  })
  ipcMain.handle('stone:export-client-profile', (event, id: string) => {
    assertTrustedSender(event)
    return store.exportClientProfile(id)
  })
  ipcMain.handle('stone:import-client-profile', (event, bundle: Parameters<GatewayApi['importClientProfile']>[0]) => {
    assertTrustedSender(event)
    return mutate(() => store.importClientProfile(bundle))
  })
  ipcMain.handle('stone:get-desktop-runtime-settings', (event) => {
    assertTrustedSender(event)
    return { launchAtLogin: app.getLoginItemSettings().openAtLogin, supported: app.isPackaged }
  })
  ipcMain.handle('stone:update-desktop-runtime-settings', (event, settings: { launchAtLogin: boolean }) => {
    assertTrustedSender(event)
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin) })
    return { launchAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false, supported: app.isPackaged }
  })
  ipcMain.handle('stone:export-diagnostics', (event) => {
    assertTrustedSender(event)
    const snapshot = store.getSnapshot()
    return serializeDiagnostics(snapshot, {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    })
  })
  ipcMain.handle('stone:list-state-backups', async (event) => {
    assertTrustedSender(event)
    if (!backups) return []
    return Promise.all((await backups.listBackups()).map(toBackupSummary))
  })
  ipcMain.handle('stone:get-automatic-backup-runtime-state', async (event) => {
    assertTrustedSender(event)
    return enqueueGatewayLifecycle(async () => {
      if (!backups) {
        return {
          configuredEnabled: false,
          running: false,
          blocked: true,
          message: 'Database backup service is unavailable.',
        }
      }
      if (store.getSnapshot().gateway.automaticBackups !== false && !backups.automaticBackupsRunning) {
        await backups.startAutomaticBackups().catch(() => undefined)
      }
      const configuredEnabled = store.getSnapshot().gateway.automaticBackups !== false
      const blocked = configuredEnabled && !backups.automaticBackupsRunning
      return {
        configuredEnabled,
        running: backups.automaticBackupsRunning,
        blocked,
        ...(blocked ? {
          message: backups.backupBlockReason
            ?? 'Automatic database backups are blocked by the credential safety check.',
        } : {}),
      }
    })
  })
  ipcMain.handle('stone:create-state-backup', async (event) => {
    assertTrustedSender(event)
    if (!backups) throw new Error('Database backup service is unavailable.')
    return { backup: toBackupSummary(await backups.createBackup('manual')) }
  })
  ipcMain.handle('stone:verify-state-backup', async (event, path: string) => {
    assertTrustedSender(event)
    if (!backups) throw new Error('Database backup service is unavailable.')
    return toBackupSummary(await backups.verifyBackup(backupIdFromPath(path)))
  })
  ipcMain.handle('stone:restore-state-backup', async (event, path: string) => {
    assertTrustedSender(event)
    if (!backups) throw new Error('Database backup service is unavailable.')
    return enqueueGatewayLifecycle(async () => {
      const wasRunning = gateway.getStatus().running
      if (wasRunning) await gateway.stop({ force: true })
      try {
        const result = await backups.restoreBackup(backupIdFromPath(path))
        gateway.updateConfig(toGatewayConfig(store))
        store.setGatewayStatus(gateway.getStatus())
        return { restored: toBackupSummary(result.restoredBackup), restartRequired: true }
      } catch (error) {
        if (wasRunning) {
          gateway.updateConfig(toGatewayConfig(store))
          await gateway.start().catch((restartError: unknown) => {
            console.error('Stone+ could not restart the gateway after a failed database restore', restartError)
          })
        }
        store.setGatewayStatus(gateway.getStatus())
        publish(store.getSnapshot())
        throw error
      }
    })
  })
  ipcMain.handle('stone:export-portable-state-backup', async (event, password: string) => {
    assertTrustedSender(event)
    if (!backups) throw new Error('Database backup service is unavailable.')
    assertPortableBackupPassword(password)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const saveOptions: Electron.SaveDialogOptions = {
      title: nativeText('导出加密迁移备份', 'Export encrypted portable backup'),
      defaultPath: join(app.getPath('documents'), `StonePlus-state-${new Date().toISOString().slice(0, 10)}.stonebackup`),
      filters: [{ name: 'Stone+ Portable Backup', extensions: ['stonebackup'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, saveOptions) : await dialog.showSaveDialog(saveOptions)
    if (result.canceled || !result.filePath) return { cancelled: true }
    const exported = await backups.exportPortableBackup(result.filePath, password)
    return { cancelled: false, path: result.filePath, backup: toBackupSummary(exported.backup) }
  })
  ipcMain.handle('stone:import-portable-state-backup', async (event, password: string) => {
    assertTrustedSender(event)
    if (!backups) throw new Error('Database backup service is unavailable.')
    assertPortableBackupPassword(password)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const openOptions: Electron.OpenDialogOptions = {
      title: nativeText('导入加密迁移备份', 'Import encrypted portable backup'),
      properties: ['openFile'],
      filters: [{ name: 'Stone+ Portable Backup', extensions: ['stonebackup'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, openOptions) : await dialog.showOpenDialog(openOptions)
    const path = result.filePaths[0]
    if (result.canceled || !path) return { cancelled: true }
    const backup = await backups.importPortableBackup(path, password)
    return { cancelled: false, path, backup: toBackupSummary(backup) }
  })
  ipcMain.handle('stone:get-webdav-backup-configuration', (event) => {
    assertTrustedSender(event)
    return webDavBackups?.getConfiguration() ?? { baseUrl: '', username: '', hasPassword: false, configured: false }
  })
  ipcMain.handle('stone:save-webdav-backup-configuration', (event, input: Parameters<GatewayApi['saveWebDavBackupConfiguration']>[0]) => {
    assertTrustedSender(event)
    if (!webDavBackups) throw new Error('Database backup service is unavailable.')
    if (!input || typeof input !== 'object') throw new Error('WebDAV backup configuration is invalid.')
    return webDavBackups.saveConfiguration(input)
  })
  ipcMain.handle('stone:clear-webdav-backup-configuration', (event) => {
    assertTrustedSender(event)
    if (!webDavBackups) throw new Error('Database backup service is unavailable.')
    return webDavBackups.clearConfiguration()
  })
  ipcMain.handle('stone:test-webdav-backup', async (event) => {
    assertTrustedSender(event)
    if (!webDavBackups) throw new Error('Database backup service is unavailable.')
    await webDavBackups.test(AbortSignal.timeout(15_000))
  })
  ipcMain.handle('stone:list-webdav-backups', (event) => {
    assertTrustedSender(event)
    if (!webDavBackups) return []
    return webDavBackups.list(AbortSignal.timeout(20_000))
  })
  ipcMain.handle('stone:upload-latest-webdav-backup', (event, password: string) => {
    assertTrustedSender(event)
    if (!webDavBackups) throw new Error('Database backup service is unavailable.')
    assertPortableBackupPassword(password)
    return webDavBackups.uploadLatest(password, AbortSignal.timeout(120_000))
  })
  ipcMain.handle('stone:download-webdav-backup', (event, name: string, password: string) => {
    assertTrustedSender(event)
    if (!webDavBackups) throw new Error('Database backup service is unavailable.')
    assertPortableBackupPassword(password)
    if (typeof name !== 'string' || !name.trim()) throw new Error('Choose a WebDAV backup to import.')
    return webDavBackups.downloadAndImport(name, password, AbortSignal.timeout(120_000))
  })
  ipcMain.handle('stone:get-client-configs', async (event, profileId?: string) => {
    assertTrustedSender(event)
    const profile = resolveClientProfile(store, profileId)
    return summarizeClientConfigs(scopedClientConfig(clientConfig, profile))
  })
  ipcMain.handle('stone:choose-client-config-directory', async (event, client: RouteClient, currentDirectory?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error(nativeText('无法打开目录选择器。', 'Unable to open the folder picker.'))
    const selection = await dialog.showOpenDialog(owner, {
      title: nativeText(`选择 ${client} 配置目录`, `Select the ${client} configuration folder`),
      buttonLabel: nativeText('选择此目录', 'Select this folder'),
      ...(currentDirectory?.trim() ? { defaultPath: currentDirectory.trim() } : {}),
      properties: ['openDirectory', 'createDirectory'],
    })
    return selection.canceled ? null : selection.filePaths[0] ?? null
  })
  ipcMain.handle('stone:preview-client-config', async (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    const plan = await scopedClientConfig(clientConfig, profile).plan(client, clientConnectionTarget(store, client))
    return {
      client,
      profileId: profile?.id ?? `default-${client}`,
      files: plan.files.map((file) => ({
        role: file.role,
        path: file.path,
        existed: file.existed,
        changed: file.changed,
        containsCredential: file.containsCredential,
        managedFields: file.managedFields
      }))
    } satisfies ClientConfigPreview
  })
  ipcMain.handle('stone:apply-client-config', async (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).apply(
      client,
      clientConnectionTarget(store, client),
      { backupRetention: profile?.backupRetention ?? 10 }
    )
  })
  ipcMain.handle('stone:repair-client-config', async (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).repair(
      client,
      clientConnectionTarget(store, client),
      { backupRetention: profile?.backupRetention ?? 10 }
    )
  })
  ipcMain.handle('stone:list-client-config-backups', (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).listBackups(client)
  })
  ipcMain.handle('stone:create-client-config-backup', (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).createBackupSet(
      client,
      profile?.backupRetention ?? 10,
    )
  })
  ipcMain.handle('stone:restore-latest-client-config-backup', (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).restoreLatestBackupSet(client)
  })
  ipcMain.handle('stone:restore-client-config-backup-set', (event, groupId: string, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    if (typeof groupId !== 'string' || !groupId.trim()) throw new Error('A client backup group id is required.')
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).restoreBackupSet(client, groupId)
  })
  ipcMain.handle('stone:restore-client-config', (event, backupPath: string, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    if (typeof backupPath !== 'string' || !backupPath) throw new Error('A backup path is required.')
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).restore(backupPath, profile?.client ?? client)
  })
  ipcMain.handle('stone:get-client-config-editor', async (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    const editor = await scopedClientConfig(clientConfig, profile).editor(client)
    return {
      ...editor,
      profileId: profile?.id ?? `default-${client}`
    } satisfies ClientConfigEditorState
  })
  ipcMain.handle('stone:save-client-config-editor', (event, input: ClientConfigEditorSaveInput) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('Client configuration changes are required.')
    assertRouteClient(input.client)
    if (!Array.isArray(input.patches) || !Array.isArray(input.files)) {
      throw new Error('Client configuration changes are invalid.')
    }
    const profile = resolveClientProfile(store, input.profileId, input.client)
    return scopedClientConfig(clientConfig, profile).applyEditor(
      input.client,
      clientConnectionTarget(store, input.client),
      { patches: input.patches, files: input.files },
      { backupRetention: profile?.backupRetention ?? 10 }
    )
  })
  return async () => {
    closed = true
    unregisterBulkAccountCheckTask()
    await persistentTaskRunner.interruptAllForShutdown()
    // Stop accepting new gateway callbacks before draining the work already
    // observed below. Otherwise a late account/log event can be enqueued after
    // the shutdown snapshots have been taken and race the store close.
    unsubscribeLog()
    unsubscribeAccountState()
    unsubscribeRuntimeState()
    unsubscribeBrowserImports?.()
    if (scheduledAccountStateFlush) {
      clearTimeout(scheduledAccountStateFlush)
      scheduledAccountStateFlush = undefined
    }
    do {
      await runAccountStateFlush()
    } while (pendingActiveAccountStates.size > 0)
    await Promise.allSettled([...accountStatePersistenceFlights.values()])
    latestObservedAccountStates.clear()
    accountStateRevisions.clear()
    if (scheduledRequestLogCheckpoint) clearTimeout(scheduledRequestLogCheckpoint)
    scheduledRequestLogCheckpoint = undefined
    if (scheduledRuntimeDeltaPublish) clearTimeout(scheduledRuntimeDeltaPublish)
    scheduledRuntimeDeltaPublish = undefined
    for (const pending of pendingTerminalLogs.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer)
    }
    await Promise.allSettled([...pendingRequestLogWrites])
    // One final retry window gives every observed terminal lifecycle a durable
    // outcome before AppStore performs its forced live checkpoint. Clear stale
    // rejected flights first; their callbacks intentionally stop scheduling
    // timers once `closed` is true.
    for (const pending of pendingTerminalLogs.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer)
      pending.retryTimer = undefined
      pending.flight = undefined
    }
    await Promise.all([...pendingTerminalLogs.values()].map(({ log }) => (
      persistTerminalLogForShutdown(log)
    )))
    pendingTerminalLogs.clear()
    if (automaticCooldownRefreshFlight) {
      await Promise.allSettled([automaticCooldownRefreshFlight])
    }
    await Promise.allSettled([...noEligibleRefreshFlights, ...noEligibleProbeFlights.values()])
    noEligibleRefreshFlights.clear()
    noEligibleProbeFlights.clear()
    noEligibleProbeLastStartedAt.clear()
    if (ownsOutboundReloadCoordinator) await outboundReloadCoordinator.close()
    else await outboundReloadCoordinator.settle()
    const oauthCompletions = new Set<Promise<unknown>>(oauthCompletionFlights)
    for (const [sessionId, session] of [...oauthImportSessions]) {
      session.cancelled = true
      if (session.completion) oauthCompletions.add(session.completion)
      if (!session.committing) {
        cleanupOAuthSession(sessionId, session, { cancelFlow: true, markCancelled: true })
      }
    }
    // A token bundle that crossed the commit boundary must finish encrypted
    // persistence before the store is closed.
    await Promise.allSettled([...oauthCompletions])
    for (const [sessionId, session] of [...oauthImportSessions]) {
      cleanupOAuthSession(sessionId, session, { cancelFlow: false, markCancelled: true })
    }
    chatGptOAuth.dispose()
    for (const timer of quotaProbeTimers.values()) clearTimeout(timer)
    quotaProbeTimers.clear()
  }
}

async function summarizeClientConfigs(service: ClientConfigService, client?: RouteClient): Promise<ClientConfigStatus[]> {
  const [detected, backups] = await Promise.all([service.detect(client), service.listBackups(client)])
  return detected.map((client) => {
    const clientBackups = backups.filter((backup) => backup.client === client.client)
    return {
      client: client.client,
      directory: client.directory,
      directoryExists: client.directoryExists,
      configured: client.configured,
      files: client.files.map((file) => ({
        role: file.role,
        path: file.path,
        exists: file.exists,
        containsCredential: file.containsCredential,
        size: file.size,
        modifiedAt: file.modifiedAt
      })),
      backupCount: clientBackups.length,
      lastBackupAt: clientBackups[0]?.createdAt
    }
  })
}

function resolveClientProfile(store: AppStore, profileId?: string, client?: RouteClient): ClientConfigProfile | undefined {
  if (!profileId) return undefined
  const profile = store.getSnapshot().clientProfiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('Client configuration profile not found.')
  if (client && profile.client !== client) throw new Error('Client configuration profile does not match the client.')
  return profile
}

function scopedClientConfig(service: ClientConfigService, profile?: ClientConfigProfile): ClientConfigService {
  if (!profile?.directory) return service
  const key = `${profile.client}Directory` as const
  return service.withOverrides({ [key]: profile.directory })
}

function clientConnectionTarget(store: AppStore, client: RouteClient): { gatewayBaseUrl: string; token: string } {
  const snapshot = store.getSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.client === client)
  if (!route) throw new Error(`The ${client} route does not exist.`)
  if (!route.localToken) throw new Error(`The ${client} route has no local token.`)
  if (route.inboundProtocol !== clientNativeProtocols[client]) {
    throw new Error(`The ${client} route does not use its native client protocol.`)
  }
  const host = snapshot.gateway.host.includes(':') ? `[${snapshot.gateway.host}]` : snapshot.gateway.host
  return {
    gatewayBaseUrl: `http://${host}:${snapshot.gateway.port}`,
    token: route.localToken
  }
}

function assertRouteClient(value: unknown): asserts value is RouteClient {
  if (value !== 'claude' && value !== 'codex' && value !== 'gemini') {
    throw new Error('Unsupported client configuration target.')
  }
}

function normalizeSetupPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('网关端口必须介于 1 到 65535。')
  }
  return port
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'EADDRINUSE'
    || (typeof candidate.message === 'string' && /EADDRINUSE|address already in use|only one usage/i.test(candidate.message))
}

function normalizeApiSourceProbeInput(
  input: Parameters<GatewayApi['probeApiSource']>[0]
): Parameters<GatewayApi['probeApiSource']>[0] {
  if (input.sourceType !== 'official-api' && input.sourceType !== 'relay') {
    throw new Error('不支持的 API 来源类型。')
  }
  if (input.sourceType === 'relay') return input
  if (input.kind === 'openai') {
    if (input.protocol !== 'openai-responses' && input.protocol !== 'openai-chat') {
      throw new Error('OpenAI 官方 API 仅支持 Responses 或 Chat Completions。')
    }
    return { ...input, baseUrl: 'https://api.openai.com/v1' }
  }
  if (input.kind === 'anthropic') {
    if (input.protocol !== 'anthropic-messages') throw new Error('Anthropic 官方 API 仅支持 Messages。')
    return { ...input, baseUrl: 'https://api.anthropic.com' }
  }
  if (input.kind === 'google') {
    if (input.protocol !== 'gemini') throw new Error('Google 官方 API 仅支持 Gemini。')
    return { ...input, baseUrl: 'https://generativelanguage.googleapis.com' }
  }
  throw new Error('官方 API 仅支持 OpenAI、Anthropic 和 Google Gemini。')
}

function apiSourceProbeConnectionFingerprint(input: Pick<
  Parameters<GatewayApi['probeApiSource']>[0],
  'id' | 'sourceType' | 'kind' | 'baseUrl' | 'protocol' | 'responsesCompactMode' | 'credential' | 'proxyId'
>): string {
  const normalized = normalizeApiSourceProbeInput({
    ...input,
    name: '',
  })
  const baseUrl = normalized.sourceType === 'relay'
    ? normalizeApiSourceEvidenceUrl(normalized.baseUrl)
    : normalized.baseUrl
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    draftId: normalizedApiSourceDraftId(normalized.id),
    sourceType: normalized.sourceType,
    kind: normalized.kind,
    baseUrl,
    protocol: normalized.protocol,
    responsesCompactMode: normalized.responsesCompactMode ?? null,
    credential: normalized.credential?.trim() ?? '',
    proxyId: normalized.proxyId?.trim() || null,
  })).digest('base64url')
}

function normalizedApiSourceDraftId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function apiSourceDraftIdentity(input: { id?: string; name: string }): string {
  const sourceId = normalizedApiSourceDraftId(input.id)
  return sourceId ? `source:${sourceId}` : `draft:${input.name.trim()}`
}

function normalizeApiSourceEvidenceModel(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function normalizeApiSourceEvidenceModels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function apiSourceSaveMatchesProbeModels(
  input: Parameters<GatewayApi['saveApiSource']>[0],
  testedModel: string,
  discoveredModels: readonly string[],
): boolean {
  const savedModels = normalizeApiSourceEvidenceModels(input.models)
  if (discoveredModels.length > 0
    && JSON.stringify(savedModels) !== JSON.stringify(discoveredModels)) return false
  const savedDefaultModel = normalizeApiSourceEvidenceModel(input.defaultModel)
  const effectiveDefaultModel = savedDefaultModel ?? savedModels[0]
  if (!testedModel || effectiveDefaultModel !== testedModel) return false
  // saveApiSourceDraft promotes a manually tested default into the persisted
  // model list. Mirror that normalization here so a successful manual probe is
  // not rejected merely because model discovery returned an empty/partial list.
  return savedModels.includes(testedModel) || savedDefaultModel === testedModel
}

function normalizeApiSourceEvidenceUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API source URL is invalid.')
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && !loopback) throw new Error('API source URL is invalid.')
  if (url.username || url.password || url.search || url.hash) throw new Error('API source URL is invalid.')
  return url.toString().replace(/\/$/, '')
}

function toGatewayConfig(store: AppStore): GatewayConfig {
  const configuration = store.getRuntimeConfiguration()
  return {
    providers: configuration.providers,
    accounts: configuration.accounts,
    proxies: configuration.proxies,
    pools: configuration.pools,
    routes: configuration.routes,
    settings: configuration.gateway,
    recentRequestLogs: store.getAccountFitnessHistory()
  }
}

export function warmGatewayConnections(store: AppStore, transport: OutboundTransportManager): void {
  const targets = gatewayConnectionTargets(store)
  void Promise.allSettled([...targets.values()].map((target) =>
    transport.warmFor(target.proxy, target.password, target.targetUrl)
  ))
}

export async function rebuildGatewayConnections(store: AppStore, transport: OutboundTransportManager): Promise<void> {
  const targets = gatewayConnectionTargets(store)
  if (transport.builtInRoutes.isIntercepting()) {
    // Built-in routing owns every non-loopback target regardless of its saved
    // explicit binding. Rotate the mixed/TUN generation once with the complete
    // enabled target set; external PAC/cache state remains untouched.
    await transport.rebuild(
      undefined,
      undefined,
      [...new Set([...targets.values()].map((target) => target.targetUrl))],
    )
    return
  }
  if (store.getSnapshot().gateway.outboundNetworkMode === 'system') {
    await transport.reloadSystemProxyConfiguration().catch((error) => {
      // A slow/broken WPAD or PAC refresh must not prevent explicit-proxy
      // sources from rebuilding. Chromium can continue with its last loaded
      // proxy snapshot while the affected system targets report their own
      // warmup failures below.
      console.warn('[system-proxy] Could not refresh the operating-system proxy configuration before rebuild', error)
    })
  }
  transport.invalidateSystemProxyCache()
  const grouped = new Map<string, {
    proxy: AppSnapshot['proxies'][number] | undefined
    password: string | undefined
    targets: Set<string>
  }>()
  for (const target of targets.values()) {
    const key = target.proxy?.id ?? 'direct'
    const group = grouped.get(key) ?? {
      proxy: target.proxy,
      password: target.password,
      targets: new Set<string>()
    }
    group.targets.add(target.targetUrl)
    grouped.set(key, group)
  }
  await Promise.all([...grouped.values()].map((group) =>
    transport.rebuild(group.proxy, group.password, [...group.targets])
  ))
}

function gatewayConnectionTargets(store: AppStore): Map<string, EnabledOutboundTarget> {
  return collectEnabledOutboundTargets(store)
}

async function resolveAgentIdentityForOperation(
  store: AppStore,
  account: Account,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal
): Promise<{ authorization: string; accountId: string; fedramp?: boolean }> {
  const serialized = store.getCredential(account.credentialId)
  if (!serialized) throw new Error('This Agent Identity account has no readable credential.')
  const access = await resolveChatGptAgentIdentity(
    serialized,
    (rotated, expectedSource) => store.updateChatGptAgentIdentityCredential(account.id, rotated, expectedSource),
    fetchImplementation,
    { signal }
  )
  return {
    authorization: access.authorization,
    accountId: access.bundle.accountId,
    fedramp: access.bundle.fedramp
  }
}

async function checkAccount(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  accountId: string,
  signal?: AbortSignal,
): Promise<{ latencyMs: number; codexQuota?: AppSnapshot['accounts'][number]['codexQuota'] }> {
  signal?.throwIfAborted()
  const snapshot = store.getSnapshot()
  const account = store.getRuntimeAccount(accountId)
  if (!account) throw new Error('Account not found.')
  const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
  if (!provider) throw new Error('The account provider no longer exists.')
  const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)
  if (account.credentialType === 'chatgpt-agent-identity') {
    const authorization = await resolveAgentIdentityForOperation(store, account, fetchImplementation, signal)
    const result = await checkChatGptAccountAuthorized(
      account,
      authorization, fetchImplementation, boundedAbortSignal(signal, 30_000)
    )
    if (!result.ok) throw new AccountProbeError(result.failure)
    return { latencyMs: result.latencyMs, ...(result.quota ? { codexQuota: result.quota } : {}) }
  }
  if (account.credentialType === 'chatgpt-oauth') {
    const serialized = store.getCredential(account.credentialId)
    if (!serialized) throw new Error('This ChatGPT account has no readable credential.')
    const resolved = await resolveChatGptCredential(
      serialized,
      (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
      fetchImplementation,
      Date.now(),
      { refreshKey: account.id, signal }
    )
    const result = await checkChatGptAccountAuthorized(account, {
      authorization: `Bearer ${resolved.bundle.accessToken}`,
      accountId: resolved.bundle.accountId
    }, fetchImplementation, boundedAbortSignal(signal, 30_000))
    if (!result.ok) throw new AccountProbeError(result.failure)
    return { latencyMs: result.latencyMs, ...(result.quota ? { codexQuota: result.quota } : {}) }
  }
  const credential = store.getCredential(account.credentialId)
  if (!credential) throw new Error('This account has no readable credential.')
  const result = await getProviderAdapter(provider.kind).probeHealth({
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    credential,
    fetchImplementation,
    signal,
    timeoutMs: 15_000
  })
  if (!result.ok) throw new AccountProbeError(result.failure)
  return { latencyMs: result.latencyMs }
}

function boundedAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function accountCheckState(account: Account): Parameters<AppStore['setAccountCheckResult']>[1] {
  return {
    status: account.status,
    latencyMs: account.latencyMs,
    lastError: account.lastError,
    lastUsedAt: account.lastUsedAt,
    cooldownUntil: account.cooldownUntil,
    cooldownReason: account.cooldownReason,
    circuitState: account.circuitState,
    consecutiveFailures: account.consecutiveFailures,
    quota: account.quota,
    codexQuota: account.codexQuota,
  }
}

export async function discoverProviderModels(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  providerId: string
): Promise<string[]> {
  const snapshot = store.getSnapshot()
  const provider = snapshot.providers.find((candidate) => candidate.id === providerId)
  if (!provider) throw new Error('Provider not found.')
  const accounts = store.getRuntimeAccounts()
    .filter((candidate) => candidate.providerId === providerId && candidate.status !== 'disabled')
  if (accounts.length === 0) throw new Error('Add an enabled account before refreshing provider models.')

  const apiKeyAccount = accounts.find((candidate) => candidate.credentialType !== 'chatgpt-oauth'
    && candidate.credentialType !== 'chatgpt-agent-identity')
  return discoverAccountModels(store, outboundTransport, (apiKeyAccount ?? accounts[0]).id)
}

export async function discoverAccountModels(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  accountId: string
): Promise<string[]> {
  const snapshot = store.getSnapshot()
  const account = store.getRuntimeAccount(accountId)
  if (!account) throw new Error('Account not found.')
  const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
  if (!provider) throw new Error('The account provider no longer exists.')
  const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)

  if (account.credentialType === 'chatgpt-agent-identity') {
    const authorization = await resolveAgentIdentityForOperation(store, account, fetchImplementation)
    return queryChatGptCodexModelsAuthorized(
      authorization, fetchImplementation, AbortSignal.timeout(15_000)
    )
  }

  if (account.credentialType !== 'chatgpt-oauth') {
    const credential = store.getCredential(account.credentialId)
    if (!credential) throw new Error('The selected account has no readable credential.')
    const result = await getProviderAdapter(provider.kind).discoverModels({
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      credential,
      fetchImplementation,
      timeoutMs: 15_000
    })
    if (!result.ok) throw new AccountProbeError(result.failure)
    if (result.models.length === 0) throw new Error('Provider returned an empty model list.')
    return result.models
  }

  const serialized = store.getCredential(account.credentialId)
  if (!serialized) throw new Error('The selected ChatGPT account has no readable credential.')
  const resolved = await resolveChatGptCredential(
    serialized,
    (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
    fetchImplementation,
    Date.now(),
    { refreshKey: account.id }
  )
  return queryChatGptCodexModels(
    resolved.bundle,
    fetchImplementation,
    AbortSignal.timeout(15_000)
  )
}

export async function testAccountModel(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  accountId: string,
  model: string
): Promise<AccountModelTestResult> {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('An account is required for the model test.')
  }
  const snapshot = store.getSnapshot()
  const account = store.getRuntimeAccount(accountId)
  if (!account) throw new Error('Account not found.')
  const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
  if (!provider) throw new Error('The account provider no longer exists.')
  const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)
  const signal = AbortSignal.timeout(30_000)

  if (account.credentialType === 'chatgpt-agent-identity') {
    if (provider.protocol !== 'openai-responses') throw new Error('ChatGPT accounts require an OpenAI Responses provider.')
    const authorization = await resolveAgentIdentityForOperation(store, account, fetchImplementation, signal)
    const result = await probeChatGptAccountAuthorized(
      { ...account, modelPolicy: 'selected', modelAllowlist: [model] },
      authorization,
      fetchImplementation,
      signal
    )
    if (!result.ok) throw new AccountProbeError(result.failure)
    return { ok: true, model, latencyMs: result.latencyMs, statusCode: result.statusCode }
  }

  if (account.credentialType === 'chatgpt-oauth') {
    if (provider.protocol !== 'openai-responses') {
      throw new Error('ChatGPT accounts require an OpenAI Responses provider.')
    }
    const serialized = store.getCredential(account.credentialId)
    if (!serialized) throw new Error('The selected ChatGPT account has no readable credential.')
    const resolved = await resolveChatGptCredential(
      serialized,
      (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
      fetchImplementation,
      Date.now(),
      { refreshKey: account.id, signal }
    )
    return probeChatGptCodexModel({
      bundle: resolved.bundle,
      model,
      fetchImplementation,
      signal
    })
  }

  const credential = store.getCredential(account.credentialId)
  if (!credential) throw new Error('The selected account has no readable credential.')
  return probeProviderModel({
    adapter: getProviderAdapter(provider.kind),
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    credential,
    model,
    fetchImplementation,
    signal
  })
}

async function refreshAccountCodexQuota(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  accountId: string
) {
  const account = store.getRuntimeAccount(accountId)
  if (!account) throw new Error('Account not found.')
  if (account.credentialType === 'chatgpt-agent-identity') {
    const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)
    const authorization = await resolveAgentIdentityForOperation(store, account, fetchImplementation)
    return (await queryChatGptCodexQuotaAuthorized(
      authorization,
      fetchImplementation,
      AbortSignal.timeout(30_000)
    )).quota
  }
  if (account.credentialType !== 'chatgpt-oauth') {
    throw new Error('Codex usage is only available for ChatGPT accounts.')
  }
  const serialized = store.getCredential(account.credentialId)
  if (!serialized) throw new Error('This ChatGPT account has no readable credential.')
  const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)
  const resolved = await resolveChatGptCredential(
    serialized,
    (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
    fetchImplementation,
    Date.now(),
    { refreshKey: account.id }
  )
  return (await queryChatGptCodexQuota(
    resolved.bundle,
    fetchImplementation,
    AbortSignal.timeout(30_000)
  )).quota
}

function accountFetchImplementation(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  account: Pick<AppSnapshot['accounts'][number], 'proxyId'>
): typeof fetch {
  const proxy = resolveEffectiveProxy(account, undefined, store.getSnapshot().proxies)
  return outboundTransport.fetchFor(proxy, proxy ? store.getProxyPassword(proxy.id) : undefined)
}

function proxyCheckErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'Proxy authentication is unavailable from the credential vault.') {
    return error.message
  }
  if (error instanceof Error && error.message === 'Proxy probe timed out.') return error.message
  return 'Proxy could not reach an external IP service.'
}

class AccountProbeError extends Error {
  constructor(readonly failure?: ProviderFailure) {
    super(failure?.message ?? 'Provider check failed.')
    this.name = 'AccountProbeError'
  }
}

function healthEventForTransition(
  before: AppSnapshot['accounts'][number] | undefined,
  after: AppSnapshot['accounts'][number],
  providerName: string
) {
  let kind: AppSnapshot['healthEvents'][number]['kind'] | undefined
  let severity: AppSnapshot['healthEvents'][number]['severity'] = 'info'
  let message = ''
  const wasExhausted = quotaExhausted(before)
  const exhausted = quotaExhausted(after)
  if (!wasExhausted && exhausted) {
    kind = 'quota-exhausted'; severity = 'warning'; message = '额度已耗尽，Stone+ 已暂停调度该账号。'
  } else if (wasExhausted && !exhausted) {
    kind = 'quota-restored'; message = '额度窗口已恢复，账号可以重新参与调度。'
  } else if (before && before.status !== 'active' && after.status === 'active') {
    kind = 'account-recovered'; message = '账号健康状态已恢复。'
  } else if (before?.status !== after.status && after.status === 'disabled') {
    kind = 'account-disabled'; severity = 'error'; message = after.lastError ?? '账号已被上游拒绝并停用。'
  } else if (before?.status !== after.status && after.status === 'cooldown') {
    kind = 'account-cooldown'; severity = 'warning'; message = after.lastError ?? '账号连续失败，已进入冷却。'
  }
  if (!kind) return undefined
  return {
    id: randomUUID(), timestamp: Date.now(), accountId: after.id, accountName: after.name,
    providerName, kind, severity, message
  }
}

function quotaExhausted(account: AppSnapshot['accounts'][number] | undefined): boolean {
  if (!account) return false
  const now = Date.now()
  if (account.quotaRemaining !== undefined && account.quotaRemaining <= 0) return true
  if (codexQuotaIsExhausted(account.codexQuota, now)) return true
  if (!account.quota) return false
  return [account.quota.requests, account.quota.tokens, account.quota.inputTokens, account.quota.outputTokens]
    .some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}

function accountCheckIsQuotaDeferred(account: AppSnapshot['accounts'][number]): boolean {
  return account.cooldownReason === 'quota' || quotaExhausted(account)
}

function toBackupSummary(info: { id: string; createdAt: number; sizeBytes: number; valid: boolean; kind: string }) {
  return {
    path: join(app.getPath('userData'), 'backups', info.id),
    createdAt: info.createdAt,
    size: info.sizeBytes,
    integrity: info.valid ? 'valid' as const : 'invalid' as const,
    automatic: info.kind === 'automatic'
  }
}

function backupIdFromPath(path: string): string {
  if (typeof path !== 'string' || !path) throw new Error('A backup path is required.')
  const id = basename(path)
  const expectedPath = join(app.getPath('userData'), 'backups', id)
  if (path !== id && path !== expectedPath) throw new Error('Backup path is outside Stone+ backup storage.')
  return id
}

function assertPortableBackupPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1_024) {
    throw new Error('Portable backup password must contain between 8 and 1024 characters.')
  }
}

function emptyFileImportResult(
  snapshot: AppSnapshot,
  tagId: string | null | undefined,
  poolId: string | null | undefined
): Awaited<ReturnType<GatewayApi['importChatGptAccountFiles']>> {
  return {
    snapshot,
    cancelled: true,
    selectedFiles: 0,
    fileResults: [],
    importedAccountIds: [],
    createdAccountIds: [],
    updatedAccountIds: [],
    detectionResults: [],
    warnings: [],
    assignmentSummary: {
      tagId: tagId ?? null,
      tagUpdatedAccountCount: 0,
      poolId: poolId ?? null,
      poolMembersAdded: 0,
      poolMembersAlreadyPresent: 0,
      poolMembersSkipped: 0
    }
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()))
  return results
}

function taskProgressCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function importErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/access_token/i.test(message)) return '未找到 access_token。'
  if (/account_id/i.test(message)) return '未找到 account_id，且无法从 JWT user_id 自动补全。'
  if (/expired/i.test(message)) return '账号 Access Token 已过期。'
  if (/expiration/i.test(message)) return '无法确定账号过期时间。'
  if (/JSON|Unexpected token|Unexpected end/i.test(message)) return 'JSON 格式无效。'
  return message.slice(0, 240)
}

function safeExportFileName(value: string): string {
  const withoutControls = Array.from(value.normalize('NFKC'))
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
  const normalized = withoutControls
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  return normalized || 'account'
}
