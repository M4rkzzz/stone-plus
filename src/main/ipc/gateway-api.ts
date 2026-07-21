import { app, BrowserWindow, dialog, ipcMain, Notification, shell, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { clientNativeProtocols } from '@shared/types'
import {
  hasRouteSourceIdCollision,
  isAvailableRouteAccount,
  resolveRouteSource
} from '@shared/route-sources'
import type {
  AccountFitnessSnapshot,
  AccountImportProgress,
  AccountModelTestResult,
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
  Route,
  RouteClient,
  UiLanguage
} from '@shared/types'
import type { GatewayAccountState, GatewayConfig } from '../gateway'
import { CHATGPT_CODEX_RESPONSES_URL, codexQuotaCooldownUntil, codexQuotaIsExhausted, getProviderAdapter, probeChatGptAccount, probeChatGptCodexModel, probeProviderModel, queryChatGptCodexModels, queryChatGptCodexQuota, resolveChatGptCredential, type ProviderFailure } from '../providers'
import { validateAccountImportProxySelection, type AppStore } from '../store/app-store'
import type { ClientConfigService } from '../client-config'
import type { DatabaseBackupService } from '../backup'
import type { PersistedState } from '../store/types'
import { serializeDiagnostics } from './diagnostics'
import { assertTrustedSender } from './trusted-sender'
import { OutboundTransportManager, probeProxy, resolveEffectiveProxy } from '../proxy'
import { runNetworkDiagnostics } from '../network-diagnostics'
import type { BrowserImportQueue } from '../browser-import-queue'
import { verifySetupRouteRequest } from '../setup/setup-verification'
import { probeApiSource as runApiSourceProbe } from '../sources/api-source-service'
import { ChatGptOAuthFlowManager, type ChatGptOAuthSessionController } from '../auth/chatgpt-oauth-flow'
import { serializeChatGptCredential } from '../auth'

export interface GatewayController {
  start(settings?: GatewaySettings): Promise<void>
  stop(options?: { force?: boolean; drainTimeoutMs?: number }): Promise<void>
  getStatus(): GatewayStatus
  updateConfig(config: GatewayConfig): void
  resetAccountHealth(accountId: string): void
  getAccountFitness(): Record<string, AccountFitnessSnapshot>
  getAccountInFlight(): Record<string, number>
  onLog(listener: (log: RequestLog) => void): () => void
  onAccountState(listener: (state: GatewayAccountState) => void): () => void
  onRuntimeState(listener: () => void): () => void
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
  })
): () => Promise<void> {
  const snapshotPublishDelayMs = 1_000
  const liveRuntimePublishIntervalMs = 50
  const accountStateFlushDelayMs = 250
  let scheduledSnapshotPublish: ReturnType<typeof setTimeout> | undefined
  let scheduledLiveRuntimePublish: ReturnType<typeof setTimeout> | undefined
  let lastLiveRuntimePublishAt: number | undefined
  let scheduledAccountStateFlush: ReturnType<typeof setTimeout> | undefined
  const pendingActiveAccountStates = new Map<string, GatewayAccountState>()
  const quotaProbeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const quotaProbeFlights = new Set<string>()
  const lastQuotaProbeAt = new Map<string, number>()
  let automaticCooldownRefreshTriggered = false
  let automaticCooldownRefreshFlight: Promise<void> | undefined
  let evaluateAutomaticCooldownRefresh = (): void => undefined
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
  const withRuntimeMetrics = (snapshot: AppSnapshot): AppSnapshot => {
    const fitness = gateway.getAccountFitness?.() ?? {}
    const inFlight = gateway.getAccountInFlight()
    return {
      ...snapshot,
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
    const enriched = withRuntimeMetrics(snapshot)
    if (scheduledSnapshotPublish) {
      clearTimeout(scheduledSnapshotPublish)
      scheduledSnapshotPublish = undefined
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('stone:snapshot', enriched)
      }
    }
    if (options.runtimeChanged !== false) onRuntimeChanged?.()
    return enriched
  }

  const publishRoutine = (snapshot: AppSnapshot): AppSnapshot => {
    const enriched = withRuntimeMetrics(snapshot)
    if (scheduledSnapshotPublish) {
      clearTimeout(scheduledSnapshotPublish)
      scheduledSnapshotPublish = undefined
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (canReceiveSnapshot(window)) window.webContents.send('stone:snapshot', enriched)
    }
    return enriched
  }
  const publishBrowserImports = (state: ReturnType<BrowserImportQueue['getState']>): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:browser-import-queue', state)
    }
  }
  const unsubscribeBrowserImports = browserImports?.subscribe(publishBrowserImports)

  const scheduleRuntimePublish = (): void => {
    if (scheduledSnapshotPublish) return
    scheduledSnapshotPublish = setTimeout(() => {
      scheduledSnapshotPublish = undefined
      store.setGatewayStatus(gateway.getStatus())
      if (!BrowserWindow.getAllWindows().some(canReceiveSnapshot)) return
      publishRoutine(store.getSnapshot())
    }, snapshotPublishDelayMs)
  }

  const flushLiveRuntimePublish = (): void => {
    scheduledLiveRuntimePublish = undefined
    if (closed) return
    lastLiveRuntimePublishAt = Date.now()
    store.setGatewayStatus(gateway.getStatus())
    if (!BrowserWindow.getAllWindows().some(canReceiveSnapshot)) return
    publishRoutine(store.getSnapshot())
  }

  const scheduleLiveRuntimePublish = (): void => {
    if (closed || scheduledLiveRuntimePublish) return
    const elapsed = lastLiveRuntimePublishAt === undefined
      ? liveRuntimePublishIntervalMs
      : Date.now() - lastLiveRuntimePublishAt
    const delay = Math.max(0, liveRuntimePublishIntervalMs - elapsed)
    if (delay === 0) {
      flushLiveRuntimePublish()
      return
    }
    scheduledLiveRuntimePublish = setTimeout(flushLiveRuntimePublish, delay)
    scheduledLiveRuntimePublish.unref?.()
  }

  const unsubscribeRuntimeState = gateway.onRuntimeState(scheduleLiveRuntimePublish)

  const refreshRuntime = (): AppSnapshot => {
    gateway.updateConfig(toGatewayConfig(store))
    store.setGatewayStatus(gateway.getStatus())
    return store.getSnapshot()
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
    if (!account || account.credentialType !== 'chatgpt-oauth' || account.cooldownReason !== 'quota') return
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

  const probeAndPersistAccount = async (id: string): Promise<{
    snapshot: AppSnapshot
    ok: boolean
    latencyMs?: number
    error?: string
  }> => {
    const previous = store.getSnapshot().accounts.find((account) => account.id === id)
    await store.setAccountCheckResult(id, { status: 'checking', lastError: undefined })
    publish(refreshRuntime())
    try {
      const result = await checkAccount(store, outboundTransport, id)
      const now = Date.now()
      const exhausted = codexQuotaIsExhausted(result.codexQuota, now)
      const cooldownUntil = exhausted
        ? codexQuotaCooldownUntil(result.codexQuota, now) ?? now + 60_000
        : undefined
      await store.setAccountCheckResult(id, {
        status: exhausted ? 'cooldown' : 'active',
        circuitState: exhausted ? 'open' : 'closed',
        consecutiveFailures: 0,
        latencyMs: result.latencyMs,
        lastError: exhausted ? 'ChatGPT Codex 额度已耗尽。' : undefined,
        lastUsedAt: now,
        cooldownUntil,
        cooldownReason: exhausted ? 'quota' : undefined,
        ...(result.codexQuota ? { codexQuota: result.codexQuota } : {})
      })
      if (exhausted && cooldownUntil !== undefined) scheduleQuotaProbe(id, cooldownUntil + 1_000)
      else gateway.resetAccountHealth(id)
      const snapshot = publish(refreshRuntime())
      evaluateAutomaticCooldownRefresh()
      return { snapshot, ok: !exhausted, latencyMs: result.latencyMs,
        ...(exhausted ? { error: 'ChatGPT Codex 额度已耗尽。' } : {}) }
    } catch (error: unknown) {
      const failure = error instanceof AccountProbeError ? error.failure : undefined
      const shouldDisable = failure?.accountAction === 'disable'
      const shouldCooldown = failure?.accountAction === 'cooldown'
      const errorMessage = error instanceof Error ? error.message : 'Account check failed.'
      await store.setAccountCheckResult(id, {
        status: shouldDisable ? 'disabled' : shouldCooldown ? 'cooldown' : previous?.status ?? 'disabled',
        circuitState: shouldDisable || shouldCooldown ? 'open' : previous?.circuitState,
        consecutiveFailures: (store.getSnapshot().accounts.find((account) => account.id === id)?.consecutiveFailures ?? 0) + 1,
        cooldownUntil: shouldCooldown ? Date.now() + (failure?.retryAfterMs ?? 30_000) : previous?.cooldownUntil,
        cooldownReason: shouldCooldown ? 'failure' : previous?.cooldownReason,
        lastError: errorMessage
      })
      const snapshot = publish(refreshRuntime())
      evaluateAutomaticCooldownRefresh()
      return { snapshot, ok: false, error: errorMessage }
    }
  }

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
        lazyTransportFailure = '选择的出口代理已被删除，请重新开始 OAuth 授权。'
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

  gateway.onLog((log) => {
    void store.appendLog(log).then(() => {
      scheduleRuntimePublish()
    }).catch((error: unknown) => {
      console.error('Stone+ could not persist a gateway request log', error)
    })
  })

  const persistAccountState = async (state: GatewayAccountState): Promise<void> => {
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
    const account = store.getRuntimeAccount(state.accountId)
    if (account?.cooldownReason === 'quota' && account.credentialType === 'chatgpt-oauth') {
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
    if (event && account) {
      await store.appendHealthEvent(event)
      const snapshot = store.getSnapshot()
      if (snapshot.gateway.desktopNotifications && Notification.isSupported()) {
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
    // Routine success telemetry (latency/lastUsedAt) must not rebuild the whole
    // gateway configuration or tray menu. Only routing-affecting transitions do.
    if (event || state.status !== 'active') {
      publish(refreshRuntime())
    } else if (state.quota) {
      // Quota affects scheduling, but not the desktop tray. Refresh routing
      // without triggering unrelated runtime UI side effects.
      publish(refreshRuntime(), { runtimeChanged: false })
    } else {
      scheduleRuntimePublish()
    }
    evaluateAutomaticCooldownRefresh()
  }

  const persistRoutineAccountState = async (state: GatewayAccountState): Promise<void> => {
    const current = store.getRuntimeAccount(state.accountId)
    // Coalesced success telemetry is stale-able by design. Never let it undo a
    // user disable or a newer circuit-breaker transition.
    if (!current || current.status !== 'active' || current.circuitState === 'open'
      || current.circuitState === 'half-open' || (current.consecutiveFailures ?? 0) > 0) return
    await store.updateAccountRuntimeState(state.accountId, {
      latencyMs: state.latencyMs,
      lastUsedAt: state.lastUsedAt,
      ...(state.quota ? { quota: state.quota } : {}),
      ...(state.codexQuota ? { codexQuota: state.codexQuota } : {})
    })
    if (state.quota || state.codexQuota) publishRoutine(refreshRuntime())
    else scheduleRuntimePublish()
  }

  const flushPendingAccountStates = async (): Promise<void> => {
    scheduledAccountStateFlush = undefined
    const pending = [...pendingActiveAccountStates.values()]
    pendingActiveAccountStates.clear()
    await Promise.all(pending.map(async (state) => {
      await persistRoutineAccountState(state).catch((error: unknown) => {
        console.error('Stone+ could not persist account health state', error)
      })
    }))
  }

  gateway.onAccountState((state) => {
    const before = store.getRuntimeAccount(state.accountId)
    const routingTransition = state.status !== 'active'
      || !before
      || before.status !== 'active'
      || before.circuitState === 'open'
      || before.circuitState === 'half-open'
      || (before.consecutiveFailures ?? 0) > 0
    if (routingTransition) {
      pendingActiveAccountStates.delete(state.accountId)
      void persistAccountState(state).catch((error: unknown) => {
        console.error('Stone+ could not persist account health state', error)
      })
      return
    }
    const pending = pendingActiveAccountStates.get(state.accountId)
    pendingActiveAccountStates.set(state.accountId, pending ? { ...pending, ...state } : state)
    if (!scheduledAccountStateFlush) {
      scheduledAccountStateFlush = setTimeout(() => {
        void flushPendingAccountStates()
      }, accountStateFlushDelayMs)
    }
  })

  for (const account of store.getRuntimeAccounts()) {
    if (account.credentialType === 'chatgpt-oauth' && account.cooldownReason === 'quota') {
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
    const saved = await store.saveApiSource(input)
    if (saved.source.connectionChanged) gateway.resetAccountHealth(saved.source.accountId)
    const snapshot = publish(refreshRuntime())
    if (gateway.getStatus().running) warmGatewayConnections(store, outboundTransport)
    return snapshot
  })
  ipcMain.handle('stone:probe-api-source', async (event, input: Parameters<GatewayApi['probeApiSource']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('API 来源测试参数无效。')
    const normalized = normalizeApiSourceProbeInput(input)
    const existingAccount = input.id
      ? store.getRuntimeAccounts().find((account) => account.providerId === input.id && account.credentialType !== 'chatgpt-oauth')
      : undefined
    const selectedProxyId = typeof normalized.proxyId === 'string' && normalized.proxyId.trim()
      ? normalized.proxyId.trim()
      : existingAccount?.proxyId
    const proxy = selectedProxyId
      ? store.getSnapshot().proxies.find((candidate) => candidate.id === selectedProxyId)
      : undefined
    if (selectedProxyId && !proxy) throw new Error('选择的出口代理已被删除。')
    const fetchImplementation = outboundTransport.fetchFor(
      proxy,
      proxy ? store.getProxyPassword(proxy.id) : undefined
    )
    return runApiSourceProbe(normalized, {
      storedCredential: input.id ? store.getApiSourceCredential(input.id) : undefined,
      fetchImplementation,
    })
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
  ipcMain.handle('stone:verify-setup-route', async (event, input: Parameters<GatewayApi['verifySetupRoute']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('端到端验证参数无效。')
    assertRouteClient(input.client)
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new Error('请选择端到端验证模型。')
    const snapshot = store.getSnapshot()
    const route = snapshot.routes.find((candidate) => candidate.client === input.client && candidate.enabled)
    if (!route) throw new Error('当前客户端路由未启用。')
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
    const wizard = store.getSetupWizardState()
    if (wizard) {
      if (result.ok) {
        await store.markSetupWizardVerified(wizard.sessionId)
      } else {
        await store.saveSetupWizardProgress({
          sessionId: wizard.sessionId,
          step: 'verify',
          client: input.client,
          model,
          lastError: result.error,
        })
      }
    }
    return result
  })
  ipcMain.handle('stone:update-route', (event, route: Route) => {
    assertTrustedSender(event)
    return mutate(() => store.updateRoute(route))
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
    const wasRunning = gateway.getStatus().running
    const previousSettings = store.getSnapshot().gateway
    const requiresRestart = wasRunning
      && (previousSettings.host !== settings.host || previousSettings.port !== settings.port)
    const outboundModeChanged = (previousSettings.outboundNetworkMode ?? 'direct')
      !== (settings.outboundNetworkMode ?? 'direct')
    await store.updateGateway(settings)
    const savedGateway = store.getSnapshot().gateway
    outboundTransport.configureOutboundNetwork(
      savedGateway.outboundNetworkMode ?? 'direct',
      savedGateway.port
    )
    if (outboundModeChanged && wasRunning) warmGatewayConnections(store, outboundTransport)
    if (backups) {
      await backups.setAutomaticRetention(settings.backupRetention ?? 10)
      if (settings.automaticBackups === false) backups.stopAutomaticBackups()
      else backups.startAutomaticBackups()
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
  ipcMain.handle('stone:start-gateway', async (event) => {
    assertTrustedSender(event)
    gateway.updateConfig(toGatewayConfig(store))
    await gateway.start()
    warmGatewayConnections(store, outboundTransport)
    store.setGatewayStatus(gateway.getStatus())
    return publish(store.getSnapshot())
  })
  ipcMain.handle('stone:stop-gateway', async (event) => {
    assertTrustedSender(event)
    await gateway.stop({ force: true })
    store.setGatewayStatus(gateway.getStatus())
    return publish(store.getSnapshot())
  })
  ipcMain.handle('stone:rebuild-outbound-connections', async (event) => {
    assertTrustedSender(event)
    await rebuildGatewayConnections(store, outboundTransport)
  })
  ipcMain.handle('stone:detect-system-proxy', async (event) => {
    assertTrustedSender(event)
    return outboundTransport.detectSystemProxy([
      new URL(CHATGPT_CODEX_RESPONSES_URL).origin,
      'https://api.openai.com'
    ])
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
      route: proxy
        ? { kind: 'proxy', name: proxy.name, proxyId: proxy.id }
        : store.getSnapshot().gateway.outboundNetworkMode === 'system'
          ? { kind: 'system', name: '跟随系统代理' }
          : { kind: 'direct', name: '直连' }
    })
  })
  ipcMain.handle('stone:check-account', async (event, id: string) => {
    assertTrustedSender(event)
    return (await probeAndPersistAccount(id)).snapshot
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
    return mutate(() => store.clearLogs())
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
    const wasRunning = gateway.getStatus().running
    if (wasRunning) await gateway.stop({ force: true })
    try {
      const result = await backups.restoreBackup(backupIdFromPath(path))
      await store.sanitizePersistedData()
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
    if (automaticCooldownRefreshFlight) {
      await Promise.allSettled([automaticCooldownRefreshFlight])
    }
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
    unsubscribeRuntimeState()
    unsubscribeBrowserImports?.()
    for (const timer of quotaProbeTimers.values()) clearTimeout(timer)
    quotaProbeTimers.clear()
    if (scheduledSnapshotPublish) {
      clearTimeout(scheduledSnapshotPublish)
      scheduledSnapshotPublish = undefined
    }
    if (scheduledLiveRuntimePublish) {
      clearTimeout(scheduledLiveRuntimePublish)
      scheduledLiveRuntimePublish = undefined
    }
    if (scheduledAccountStateFlush) {
      clearTimeout(scheduledAccountStateFlush)
      scheduledAccountStateFlush = undefined
    }
    await flushPendingAccountStates()
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
  const configuration = store.getRuntimeConfiguration()
  const targets = new Map<string, {
    proxy: AppSnapshot['proxies'][number] | undefined
    password: string | undefined
    origin: string
  }>()
  for (const pool of configuration.pools) {
    for (const member of pool.members) {
      if (!member.enabled) continue
      const account = configuration.accounts.find((candidate) => candidate.id === member.accountId)
      if (!account || account.status === 'disabled' || account.status === 'expired') continue
      const provider = configuration.providers.find((candidate) => candidate.id === account.providerId)
      if (!provider) continue
      const proxy = resolveEffectiveProxy(account, pool, configuration.proxies)
      const origin = new URL(
        account.credentialType === 'chatgpt-oauth' ? CHATGPT_CODEX_RESPONSES_URL : provider.baseUrl
      ).origin
      const key = `${proxy?.id ?? 'direct'}\0${origin}`
      if (!targets.has(key)) {
        targets.set(key, {
          proxy,
          password: proxy ? store.getProxyPassword(proxy.id) : undefined,
          origin
        })
      }
    }
  }
  void Promise.allSettled([...targets.values()].map((target) =>
    transport.warmFor(target.proxy, target.password, target.origin)
  ))
}

export async function rebuildGatewayConnections(store: AppStore, transport: OutboundTransportManager): Promise<void> {
  transport.invalidateSystemProxyCache()
  const targets = gatewayConnectionTargets(store)
  const grouped = new Map<string, {
    proxy: AppSnapshot['proxies'][number] | undefined
    password: string | undefined
    origins: Set<string>
  }>()
  for (const target of targets.values()) {
    const key = target.proxy?.id ?? 'direct'
    const group = grouped.get(key) ?? {
      proxy: target.proxy,
      password: target.password,
      origins: new Set<string>()
    }
    group.origins.add(target.origin)
    grouped.set(key, group)
  }
  await Promise.all([...grouped.values()].map((group) =>
    transport.rebuild(group.proxy, group.password, [...group.origins])
  ))
}

function gatewayConnectionTargets(store: AppStore): Map<string, {
  proxy: AppSnapshot['proxies'][number] | undefined
  password: string | undefined
  origin: string
}> {
  const configuration = store.getRuntimeConfiguration()
  const targets = new Map<string, {
    proxy: AppSnapshot['proxies'][number] | undefined
    password: string | undefined
    origin: string
  }>()
  for (const pool of configuration.pools) {
    for (const member of pool.members) {
      if (!member.enabled) continue
      const account = configuration.accounts.find((candidate) => candidate.id === member.accountId)
      if (!account || account.status === 'disabled' || account.status === 'expired') continue
      const provider = configuration.providers.find((candidate) => candidate.id === account.providerId)
      if (!provider) continue
      const proxy = resolveEffectiveProxy(account, pool, configuration.proxies)
      const origin = new URL(
        account.credentialType === 'chatgpt-oauth' ? CHATGPT_CODEX_RESPONSES_URL : provider.baseUrl
      ).origin
      const key = `${proxy?.id ?? 'direct'}\0${origin}`
      if (!targets.has(key)) targets.set(key, {
        proxy,
        password: proxy ? store.getProxyPassword(proxy.id) : undefined,
        origin
      })
    }
  }
  return targets
}

async function checkAccount(
  store: AppStore,
  outboundTransport: OutboundTransportManager,
  accountId: string
): Promise<{ latencyMs: number; codexQuota?: AppSnapshot['accounts'][number]['codexQuota'] }> {
  const snapshot = store.getSnapshot()
  const account = store.getRuntimeAccount(accountId)
  if (!account) throw new Error('Account not found.')
  const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
  if (!provider) throw new Error('The account provider no longer exists.')
  const fetchImplementation = accountFetchImplementation(store, outboundTransport, account)
  if (account.credentialType === 'chatgpt-oauth') {
    const serialized = store.getCredential(account.credentialId)
    if (!serialized) throw new Error('This ChatGPT account has no readable credential.')
    const resolved = await resolveChatGptCredential(
      serialized,
      (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
      fetchImplementation,
      Date.now(),
      { refreshKey: account.id }
    )
    try {
      const result = await queryChatGptCodexQuota(
        resolved.bundle,
        fetchImplementation,
        AbortSignal.timeout(30_000)
      )
      return { latencyMs: result.latencyMs, codexQuota: result.quota }
    } catch {
      const result = await probeChatGptAccount(account, resolved.bundle, fetchImplementation, AbortSignal.timeout(30_000))
      if (!result.ok) throw new AccountProbeError(result.failure)
      return { latencyMs: result.latencyMs }
    }
  }
  const credential = store.getCredential(account.credentialId)
  if (!credential) throw new Error('This account has no readable credential.')
  const result = await getProviderAdapter(provider.kind).probeHealth({
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    credential,
    fetchImplementation,
    timeoutMs: 15_000
  })
  if (!result.ok) throw new AccountProbeError(result.failure)
  return { latencyMs: result.latencyMs }
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

  const apiKeyAccount = accounts.find((candidate) => candidate.credentialType !== 'chatgpt-oauth')
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
  if (account.credentialType !== 'chatgpt-oauth') {
    throw new Error('Codex usage is only available for ChatGPT OAuth accounts.')
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
  if (codexQuotaIsExhausted(account.codexQuota, now)) return true
  if (!account.quota) return false
  return [account.quota.requests, account.quota.tokens, account.quota.inputTokens, account.quota.outputTokens]
    .some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
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
