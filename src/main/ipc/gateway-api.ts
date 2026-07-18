import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { clientNativeProtocols } from '@shared/types'
import type {
  AccountFitnessSnapshot,
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
  RouteClient
} from '@shared/types'
import type { GatewayAccountState, GatewayConfig } from '../gateway'
import { CHATGPT_CODEX_RESPONSES_URL, codexQuotaCooldownUntil, codexQuotaIsExhausted, getProviderAdapter, getProviderPreset, probeChatGptAccount, probeChatGptCodexModel, probeProviderModel, providerPresets, queryChatGptCodexModels, queryChatGptCodexQuota, resolveChatGptCredential, type ProviderFailure } from '../providers'
import { validateAccountImportProxySelection, type AppStore } from '../store/app-store'
import type { ClientConfigService } from '../client-config'
import type { DatabaseBackupService } from '../backup'
import type { PersistedState } from '../store/types'
import { serializeDiagnostics } from './diagnostics'
import { assertTrustedSender } from './trusted-sender'
import { OutboundTransportManager, probeProxy, resolveEffectiveProxy } from '../proxy'
import { runNetworkDiagnostics } from '../network-diagnostics'

export interface GatewayController {
  start(settings?: GatewaySettings): Promise<void>
  stop(options?: { force?: boolean; drainTimeoutMs?: number }): Promise<void>
  getStatus(): GatewayStatus
  updateConfig(config: GatewayConfig): void
  resetAccountHealth(accountId: string): void
  getAccountFitness(): Record<string, AccountFitnessSnapshot>
  onLog(listener: (log: RequestLog) => void): () => void
  onAccountState(listener: (state: GatewayAccountState) => void): () => void
}

export function registerGatewayApi(
  store: AppStore,
  gateway: GatewayController,
  clientConfig: ClientConfigService,
  outboundTransport: OutboundTransportManager,
  backups?: DatabaseBackupService<PersistedState>,
  onRuntimeChanged?: () => void
): () => Promise<void> {
  const snapshotPublishDelayMs = 1_000
  const accountStateFlushDelayMs = 250
  let scheduledSnapshotPublish: ReturnType<typeof setTimeout> | undefined
  let scheduledAccountStateFlush: ReturnType<typeof setTimeout> | undefined
  const pendingActiveAccountStates = new Map<string, GatewayAccountState>()
  const quotaProbeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const quotaProbeFlights = new Set<string>()
  const lastQuotaProbeAt = new Map<string, number>()
  let closed = false
  const withRuntimeMetrics = (snapshot: AppSnapshot): AppSnapshot => {
    const fitness = gateway.getAccountFitness?.() ?? {}
    return {
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({
        ...account,
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

  const scheduleRuntimePublish = (): void => {
    if (scheduledSnapshotPublish) return
    scheduledSnapshotPublish = setTimeout(() => {
      scheduledSnapshotPublish = undefined
      store.setGatewayStatus(gateway.getStatus())
      if (!BrowserWindow.getAllWindows().some(canReceiveSnapshot)) return
      publishRoutine(store.getSnapshot())
    }, snapshotPublishDelayMs)
  }

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
      console.error('Stone could not probe an exhausted ChatGPT account quota', error)
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
      return { snapshot: publish(refreshRuntime()), ok: !exhausted, latencyMs: result.latencyMs,
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
      return { snapshot: publish(refreshRuntime()), ok: false, error: errorMessage }
    }
  }

  const detectImportedAccounts = async (accountIds: readonly string[]) =>
    mapConcurrent([...new Set(accountIds)], 3, async (accountId) => {
      const checked = await probeAndPersistAccount(accountId)
      const accountName = checked.snapshot.accounts.find((account) => account.id === accountId)?.name ?? 'ChatGPT account'
      return {
        accountId,
        accountName,
        ok: checked.ok,
        ...(checked.latencyMs !== undefined ? { latencyMs: checked.latencyMs } : {}),
        ...(checked.error ? { error: checked.error } : {})
      }
    })

  gateway.onLog((log) => {
    void store.appendLog(log).then(() => {
      scheduleRuntimePublish()
    }).catch((error: unknown) => {
      console.error('Stone could not persist a gateway request log', error)
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
        new Notification({ title: `Stone · ${account.name}`, body: event.message }).show()
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
        console.error('Stone could not persist account health state', error)
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
        console.error('Stone could not persist account health state', error)
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
    const imported = await store.importChatGptAccounts(input)
    publish(refreshRuntime())
    const detectionResults = await detectImportedAccounts(imported.importedAccountIds)
    return { ...imported, detectionResults, snapshot: store.getSnapshot() }
  })
  ipcMain.handle('stone:import-chatgpt-account-files', async (event, input: Parameters<GatewayApi['importChatGptAccountFiles']>[0]) => {
    assertTrustedSender(event)
    if (!input || typeof input.providerId !== 'string' || !input.providerId.trim()) {
      throw new Error('批量导入前请选择 OpenAI Responses Provider。')
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error('无法打开账号文件选择器。')
    const selection = await dialog.showOpenDialog(owner, {
      title: '选择 CPA / Sub2API 账号 JSON',
      buttonLabel: '导入并检测',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'CPA / Sub2API JSON', extensions: ['json', 'txt'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (selection.canceled || !selection.filePaths.length) {
      return emptyFileImportResult(store.getSnapshot())
    }
    validateAccountImportProxySelection(input.proxyMode, input.proxyId, store.getRuntimeProxies())
    if (selection.filePaths.length > 100) throw new Error('一次最多导入 100 个账号文件。')

    const fileResults: Awaited<ReturnType<GatewayApi['importChatGptAccountFiles']>>['fileResults'] = []
    const readableFiles: Array<{ fileName: string; content: string }> = []
    let totalBytes = 0
    for (const path of selection.filePaths) {
      const fileName = basename(path)
      try {
        if (!['.json', '.txt'].includes(extname(fileName).toLowerCase())) throw new Error('只支持 .json 或 .txt 文件。')
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('所选路径不是普通账号文件。')
        if (info.size > 4 * 1024 * 1024) throw new Error('单个账号文件不能超过 4 MB。')
        totalBytes += info.size
        readableFiles.push({ fileName, content: await readFile(path, 'utf8') })
      } catch (error) {
        fileResults.push({ fileName, status: 'failed', importedAccounts: 0, createdAccounts: 0, updatedAccounts: 0, error: importErrorMessage(error) })
      }
    }
    if (totalBytes > 32 * 1024 * 1024) throw new Error('本次所选账号文件总大小不能超过 32 MB。')

    const importedAccountIds: string[] = []
    const createdAccountIds: string[] = []
    const updatedAccountIds: string[] = []
    const warnings: string[] = []
    for (const file of readableFiles) {
      try {
        const imported = await store.importChatGptAccounts({
          providerId: input.providerId,
          content: file.content,
          proxyMode: input.proxyMode,
          proxyId: input.proxyId
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
    }
    publish(refreshRuntime())

    const uniqueImportedIds = [...new Set(importedAccountIds)]
    const detectionResults = await detectImportedAccounts(uniqueImportedIds)
    return {
      snapshot: store.getSnapshot(),
      cancelled: false,
      selectedFiles: selection.filePaths.length,
      fileResults: fileResults.sort((left, right) => left.fileName.localeCompare(right.fileName)),
      importedAccountIds: uniqueImportedIds,
      createdAccountIds: [...new Set(createdAccountIds)],
      updatedAccountIds: [...new Set(updatedAccountIds)],
      detectionResults,
      warnings: [...new Set(warnings)]
    }

  })
  ipcMain.handle('stone:export-chatgpt-accounts', async (event, input: Parameters<GatewayApi['exportChatGptAccounts']>[0]) => {
    assertTrustedSender(event)
    if (!input || !Array.isArray(input.accountIds) || !['cpa', 'sub2api'].includes(input.format)
      || !['merged', 'separate'].includes(input.mode)) {
      throw new Error('账号导出参数无效。')
    }
    const accountIds = [...new Set(input.accountIds)]
    if (!accountIds.length) throw new Error('请至少选择一个账号。')
    if (accountIds.length > 500) throw new Error('一次最多导出 500 个账号。')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) throw new Error('无法打开账号导出文件选择器。')
    const date = new Date().toISOString().slice(0, 10)
    if (input.mode === 'merged') {
      const exported = store.exportChatGptAccounts(accountIds, input.format)
      const selection = await dialog.showSaveDialog(owner, {
        title: `合并导出 ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} 账号 JSON`,
        buttonLabel: '保存账号 JSON',
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
      title: `选择分别导出 ${input.format === 'cpa' ? 'CPA' : 'Sub2API'} JSON 的目录`,
      buttonLabel: '导出到此目录',
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
      if (!account) throw new Error('所选账号中有账号已不存在。')
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
  ipcMain.handle('stone:update-route', (event, route: Route) => {
    assertTrustedSender(event)
    return mutate(() => store.updateRoute(route))
  })
  ipcMain.handle('stone:update-gateway', async (event, settings: GatewaySettings) => {
    assertTrustedSender(event)
    const wasRunning = gateway.getStatus().running
    const previousSettings = store.getSnapshot().gateway
    const requiresRestart = wasRunning
      && (previousSettings.host !== settings.host || previousSettings.port !== settings.port)
    await store.updateGateway(settings)
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
  ipcMain.handle('stone:clear-logs', (event) => {
    assertTrustedSender(event)
    return mutate(() => store.clearLogs())
  })
  ipcMain.handle('stone:clear-health-events', (event) => {
    assertTrustedSender(event)
    return mutate(() => store.clearHealthEvents())
  })
  ipcMain.handle('stone:list-provider-presets', (event) => {
    assertTrustedSender(event)
    return structuredClone(providerPresets)
  })
  ipcMain.handle('stone:onboard-provider', (event, input: Parameters<GatewayApi['onboardProvider']>[0]) => {
    assertTrustedSender(event)
    const preset = getProviderPreset(input.presetId)
    if (!preset) throw new Error('Provider preset not found.')
    return mutate(() => store.onboardProvider({
      preset: { ...preset, name: input.providerName?.trim() || preset.name },
      accountName: input.accountName,
      credential: input.credential
    }))
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
          console.error('Stone could not restart the gateway after a failed database restore', restartError)
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
  ipcMain.handle('stone:list-client-config-backups', (event, client: RouteClient, profileId?: string) => {
    assertTrustedSender(event)
    assertRouteClient(client)
    const profile = resolveClientProfile(store, profileId, client)
    return scopedClientConfig(clientConfig, profile).listBackups(client)
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
    for (const timer of quotaProbeTimers.values()) clearTimeout(timer)
    quotaProbeTimers.clear()
    if (scheduledSnapshotPublish) {
      clearTimeout(scheduledSnapshotPublish)
      scheduledSnapshotPublish = undefined
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

function toGatewayConfig(store: AppStore): GatewayConfig {
  const configuration = store.getRuntimeConfiguration()
  const recentRequestLogs = store.getSnapshot().requestLogs.filter((log) =>
    log.timestamp >= Date.now() - 30 * 60_000)
  return {
    providers: configuration.providers,
    accounts: configuration.accounts,
    proxies: configuration.proxies,
    pools: configuration.pools,
    routes: configuration.routes,
    settings: configuration.gateway,
    recentRequestLogs
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
    kind = 'quota-exhausted'; severity = 'warning'; message = '额度已耗尽，Stone 已暂停调度该账号。'
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
  if (path !== id && path !== expectedPath) throw new Error('Backup path is outside Stone backup storage.')
  return id
}

function emptyFileImportResult(snapshot: AppSnapshot): Awaited<ReturnType<GatewayApi['importChatGptAccountFiles']>> {
  return {
    snapshot,
    cancelled: true,
    selectedFiles: 0,
    fileResults: [],
    importedAccountIds: [],
    createdAccountIds: [],
    updatedAccountIds: [],
    detectionResults: [],
    warnings: []
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
