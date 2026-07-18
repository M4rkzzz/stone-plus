import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { clientNativeProtocols } from '@shared/types'
import type {
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
import { CHATGPT_CODEX_RESPONSES_URL, getProviderAdapter, getProviderPreset, probeChatGptAccount, probeChatGptCodexModel, probeProviderModel, providerPresets, queryChatGptCodexModels, queryChatGptCodexQuota, resolveChatGptCredential, type ProviderFailure } from '../providers'
import type { AppStore } from '../store/app-store'
import type { ClientConfigService } from '../client-config'
import type { DatabaseBackupService } from '../backup'
import type { PersistedState } from '../store/types'
import { serializeDiagnostics } from './diagnostics'
import { assertTrustedSender } from './trusted-sender'
import { OutboundTransportManager, probeProxy, resolveEffectiveProxy } from '../proxy'

export interface GatewayController {
  start(settings?: GatewaySettings): Promise<void>
  stop(): Promise<void>
  getStatus(): GatewayStatus
  updateConfig(config: GatewayConfig): void
  resetAccountHealth(accountId: string): void
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
): void {
  const snapshotPublishDelayMs = 250
  let scheduledSnapshotPublish: ReturnType<typeof setTimeout> | undefined
  const publish = (snapshot: AppSnapshot): AppSnapshot => {
    if (scheduledSnapshotPublish) {
      clearTimeout(scheduledSnapshotPublish)
      scheduledSnapshotPublish = undefined
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('stone:snapshot', snapshot)
      }
    }
    onRuntimeChanged?.()
    return snapshot
  }

  const scheduleRuntimePublish = (): void => {
    if (scheduledSnapshotPublish) return
    scheduledSnapshotPublish = setTimeout(() => {
      scheduledSnapshotPublish = undefined
      gateway.updateConfig(toGatewayConfig(store))
      store.setGatewayStatus(gateway.getStatus())
      publish(store.getSnapshot())
    }, snapshotPublishDelayMs)
  }

  const refreshRuntime = (): AppSnapshot => {
    gateway.updateConfig(toGatewayConfig(store))
    store.setGatewayStatus(gateway.getStatus())
    return store.getSnapshot()
  }

  const mutate = async (operation: () => Promise<AppSnapshot>): Promise<AppSnapshot> => {
    await operation()
    const snapshot = publish(refreshRuntime())
    if (gateway.getStatus().running) warmGatewayConnections(store, outboundTransport)
    return snapshot
  }

  gateway.onLog((log) => {
    void store.appendLog(log).then(() => {
      scheduleRuntimePublish()
    }).catch((error: unknown) => {
      console.error('Stone could not persist a gateway request log', error)
    })
  })

  gateway.onAccountState((state) => {
    const before = store.getRuntimeAccount(state.accountId)
    void store.updateAccountRuntimeState(state.accountId, {
      status: state.status,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil,
      latencyMs: state.latencyMs,
      lastError: state.lastError,
      lastUsedAt: state.lastUsedAt,
      ...(state.quota ? { quota: state.quota } : {}),
      ...(state.codexQuota ? { codexQuota: state.codexQuota } : {})
    }).then(async () => {
      const account = store.getRuntimeAccount(state.accountId)
      const provider = account ? store.getRuntimeProvider(account.providerId) : undefined
      const event = account ? healthEventForTransition(before, account, provider?.name ?? 'Unknown provider') : undefined
      if (event && account) {
        await store.appendHealthEvent(event)
        const snapshot = store.getSnapshot()
        if (snapshot.gateway.desktopNotifications && Notification.isSupported()) {
          new Notification({ title: `Stone · ${account.name}`, body: event.message }).show()
        }
      }
      if (event || state.status !== 'active') publish(refreshRuntime())
      else scheduleRuntimePublish()
    }).catch((error: unknown) => {
      console.error('Stone could not persist account health state', error)
    })
  })

  ipcMain.handle('stone:get-snapshot', (event) => {
    assertTrustedSender(event)
    store.setGatewayStatus(gateway.getStatus())
    return store.getSnapshot()
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
  ipcMain.handle('stone:import-chatgpt-accounts', (event, input: Parameters<GatewayApi['importChatGptAccounts']>[0]) => {
    assertTrustedSender(event)
    return store.importChatGptAccounts(input).then((result) => ({ ...result, snapshot: publish(refreshRuntime()) }))
  })
  ipcMain.handle('stone:delete-account', (event, id: string) => {
    assertTrustedSender(event)
    return mutate(() => store.deleteAccount(id))
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
    await store.updateGateway(settings)
    if (backups) {
      await backups.setAutomaticRetention(settings.backupRetention ?? 10)
      if (settings.automaticBackups === false) backups.stopAutomaticBackups()
      else backups.startAutomaticBackups()
    }
    if (wasRunning) await gateway.stop()
    gateway.updateConfig(toGatewayConfig(store))
    try {
      if (wasRunning) {
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
    await gateway.stop()
    store.setGatewayStatus(gateway.getStatus())
    return publish(store.getSnapshot())
  })
  ipcMain.handle('stone:check-account', async (event, id: string) => {
    assertTrustedSender(event)
    const previous = store.getSnapshot().accounts.find((account) => account.id === id)
    await store.setAccountCheckResult(id, { status: 'checking', lastError: undefined })
    publish(refreshRuntime())
    try {
      const result = await checkAccount(store, outboundTransport, id)
      await store.setAccountCheckResult(id, {
        status: 'active',
        circuitState: 'closed',
        consecutiveFailures: 0,
        latencyMs: result.latencyMs,
        lastError: undefined,
        lastUsedAt: Date.now(),
        cooldownUntil: undefined,
        ...(result.codexQuota ? { codexQuota: result.codexQuota } : {})
      })
      gateway.resetAccountHealth(id)
      return publish(refreshRuntime())
    } catch (error: unknown) {
      const failure = error instanceof AccountProbeError ? error.failure : undefined
      const shouldDisable = failure?.accountAction === 'disable'
      const shouldCooldown = failure?.accountAction === 'cooldown'
      await store.setAccountCheckResult(id, {
        status: shouldDisable ? 'disabled' : shouldCooldown ? 'cooldown' : previous?.status ?? 'disabled',
        circuitState: shouldDisable || shouldCooldown ? 'open' : previous?.circuitState,
        consecutiveFailures: (store.getSnapshot().accounts.find((account) => account.id === id)?.consecutiveFailures ?? 0) + 1,
        cooldownUntil: shouldCooldown ? Date.now() + (failure?.retryAfterMs ?? 30_000) : previous?.cooldownUntil,
        lastError: error instanceof Error ? error.message : 'Account check failed.'
      })
      return publish(refreshRuntime())
    }
  })
  ipcMain.handle('stone:refresh-account-codex-quota', async (event, id: string) => {
    assertTrustedSender(event)
    const quota = await refreshAccountCodexQuota(store, outboundTransport, id)
    await store.setAccountCheckResult(id, { codexQuota: quota })
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
    if (wasRunning) await gateway.stop()
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
  return {
    providers: configuration.providers,
    accounts: configuration.accounts,
    proxies: configuration.proxies,
    pools: configuration.pools,
    routes: configuration.routes,
    settings: configuration.gateway
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
      (rotated) => store.updateChatGptCredential(account.id, rotated),
      fetchImplementation
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
    (rotated) => store.updateChatGptCredential(account.id, rotated),
    fetchImplementation
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
      (rotated) => store.updateChatGptCredential(account.id, rotated),
      fetchImplementation
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
    (rotated) => store.updateChatGptCredential(account.id, rotated),
    fetchImplementation
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
  if (!account?.quota) return false
  const now = Date.now()
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
