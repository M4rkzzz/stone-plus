import { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, powerMonitor, safeStorage, session, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  GatewayServer,
  type GatewayConfig,
  type PersistedGrokVideoBinding,
  type ResolvedGatewayCredential,
} from './gateway'
import { ClientConfigService } from './client-config'
import { rebuildGatewayConnections, registerGatewayApi, warmGatewayConnections } from './ipc/gateway-api'
import { registerUpdateApi } from './ipc/update-api'
import { TITLE_BAR_HEIGHT, windowChromePalette } from './window-chrome'
import { AppStore } from './store/app-store'
import { DatabaseBackupService, WebDavBackupService } from './backup'
import { CodexClientVersionSyncService, resolveChatGptCredential } from './providers'
import {
  deserializeChatGptCredential,
  deserializeGrokOAuthCredential,
  resolveChatGptAgentIdentity,
  resolveGrokOAuthCredential,
} from './auth'
import {
  collectEnabledOutboundTargets,
  createOutboundReloadCoordinator,
  OutboundTransportManager,
  resolveEffectiveProxy,
  type OutboundReloadCoordinator,
} from './proxy'
import { UpdateService } from './update'
import { FrpTunnelService, verifyFrpcBinaryIntegrity } from './tunnel'
import { registerTunnelApi } from './ipc/tunnel-api'
import {
  CodexConversationTitleResolver,
  CodexRepairAndRestartService,
  CodexSessionManager,
  CodexSessionIndexCleanupService,
  CodexSessionRepairService,
  MacChatGptDesktopController,
  UnsupportedChatGptDesktopController,
  WindowsChatGptDesktopController,
} from './codex'
import { registerCodexSessionRepairApi } from './ipc/session-repair-api'
import { ClientInstanceManager } from './client-instances'
import { registerClientInstanceApi } from './ipc/client-instance-api'
import { registerAgentLifecycleApi } from './ipc/agent-lifecycle-api'
import { registerClaudeDesktopApi } from './ipc/claude-desktop-api'
import { createAgentLifecycleService } from './agent-lifecycle/integration'
import { ClaudeDesktopConfig } from './agent-lifecycle/claude-desktop-config'
import { ClaudeDesktopOperationCoordinator } from './agent-lifecycle/claude-desktop-operation-coordinator'
import type { AgentLifecycleService } from './agent-lifecycle/service'
import { AgentInstallationService } from './agent-installation'
import { registerCodexSessionManagerApi } from './ipc/session-manager-api'
import { registerPersistentTaskApi } from './ipc/persistent-task-api'
import { registerRequestMonitorApi } from './ipc/request-monitor-api'
import { BROWSER_SESSION_PARTITION, BrowserImportQueue } from './browser-import-queue'
import { LocalEventServer, startLocalEventServerForBootstrap } from './events'
import { SystemLifecycleCoordinator } from './system-lifecycle'
import { registerBuiltInProxyApi, shutdownBuiltInProxyBoundary } from './ipc/built-in-proxy-api'
import { SingBoxService } from './proxy/built-in/sing-box-service'
import { BuiltInProxyOrchestrator } from './proxy/built-in/orchestrator'
import { createChromiumMixedSessionGeneration } from './proxy/built-in/chromium-route-session'
import { FileSystemProxyLeaseRecoveryStore } from './proxy/built-in/lease-recovery'
import { SystemProxyLease } from './proxy/built-in/system-proxy-lease'
import { builtInProxyPlatformCapabilities, createSystemProxyPlatformAdapter } from './proxy/built-in/platform-adapters'
import { ElevatedSingBoxTunAdapter } from './proxy/built-in/tun-sidecar-adapter'
import { TunController } from './proxy/built-in/tun-controller'
import { RequestMonitorWindowController } from './request-monitor-window'
import { FileRequestMonitorWindowStateStore } from './request-monitor-window-state'
import { ChatGptWebLoginService } from './chatgpt-web-login'
import { ChatGptCodexAppLoginService } from './chatgpt-codex-app-login'
import { CodexOfficialAuthBridge } from './codex-official-auth'
import { PersistentDiagnosticLog } from './diagnostics/persistent-diagnostic-log'

const { autoUpdater } = electronUpdater
const WINDOWS_APP_USER_MODEL_ID = 'io.github.m4rkzzz.stoneplus'
const WINDOWS_DEV_APP_USER_MODEL_ID = `${WINDOWS_APP_USER_MODEL_ID}.dev`
const GROK_VIDEO_BINDINGS_METADATA_KEY = 'grok_video_bindings_v1'
const GROK_VIDEO_BINDINGS_METADATA_MAX_CHARS = 1024 * 1024

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let store: AppStore
let gateway: GatewayServer
let backups: DatabaseBackupService<import('./store/types').PersistedState>
let webDavBackups: WebDavBackupService
let outboundTransport: OutboundTransportManager
let outboundReloadCoordinator: OutboundReloadCoordinator
let builtInProxy: BuiltInProxyOrchestrator
let singBoxService: SingBoxService
let updateService: UpdateService
let codexClientVersionSync: CodexClientVersionSyncService
let tunnelService: FrpTunnelService
let codexConversationTitles: CodexConversationTitleResolver
let codexSessionRepair: CodexSessionRepairService
let codexSessionIndexCleanup: CodexSessionIndexCleanupService
let codexRepairAndRestart: CodexRepairAndRestartService
let codexSessionManager: CodexSessionManager
let clientInstanceManager: ClientInstanceManager
let claudeDesktopConfig: ClaudeDesktopConfig
let claudeDesktopCoordinator: ClaudeDesktopOperationCoordinator
let agentLifecycle: AgentLifecycleService
let agentInstaller: AgentInstallationService
let browserImportQueue: BrowserImportQueue
let localEventServer: LocalEventServer
let systemLifecycle: SystemLifecycleCoordinator
let isQuitting = false
let storeClosed = false
let shutdownForUpdate = false
let shutdownPromise: Promise<void> | undefined
let flushGatewayApiState: (() => Promise<void>) | undefined
let disposeBuiltInProxyApi: (() => Promise<void>) | undefined
let disposeClientInstanceApi: (() => Promise<void>) | undefined
let disposeAgentLifecycleApi: (() => Promise<void>) | undefined
let disposeClaudeDesktopApi: (() => Promise<void>) | undefined
let disposeRequestMonitorApi: (() => void) | undefined
let requestMonitorWindow: RequestMonitorWindowController | undefined
let focusMainWindowOnReady = false
let mainWindowReadyToShow = false
let rendererThemeReady = false
let rendererThemeReadyTimeout: ReturnType<typeof setTimeout> | undefined
let builtInChromiumGeneration = 0
const LOGIN_STARTUP_ARGUMENT = '--hidden'
const RENDERER_THEME_READY_TIMEOUT_MS = 1_000
let startedHidden = app.isPackaged && process.argv.includes(LOGIN_STARTUP_ARGUMENT)

if (process.env.STONE_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.STONE_USER_DATA_DIR))
}

const diagnosticLog = new PersistentDiagnosticLog(join(app.getPath('userData'), 'logs'))
diagnosticLog.installProcessHandlers()
diagnosticLog.record('main-process-start', 'Stone+ main process started', {
  appVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
})
app.on('render-process-gone', (_event, webContents, details) => {
  diagnosticLog.record('render-process-gone', details.reason, {
    webContentsId: webContents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  })
})
app.on('child-process-gone', (_event, details) => {
  diagnosticLog.record('child-process-gone', details.reason, {
    processType: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  })
})

if (process.platform === 'win32') app.setAppUserModelId(windowsAppUserModelId())
const ownsSingleInstanceLock = app.requestSingleInstanceLock()
if (ownsSingleInstanceLock) {
  app.on('second-instance', () => {
    focusMainWindowOnReady = true
    showMainWindow()
  })
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  if (app.isPackaged) {
    const loginLaunch = app.getLoginItemSettings()
    startedHidden ||= loginLaunch.wasOpenedAsHidden === true || loginLaunch.wasOpenedAtLogin === true
  }
  if (bootstrapShouldStop()) return

  store = new AppStore(app.getPath('userData'))
  await store.initialize()
  if (bootstrapShouldStop()) return
  codexClientVersionSync = new CodexClientVersionSyncService({
    userDataPath: app.getPath('userData'),
    fetchImplementation: (url, init) => net.fetch(url, init),
  })
  await codexClientVersionSync.initialize()
  codexClientVersionSync.start()
  const gatewaySettings = store.getSnapshot().gateway
  const clientConfigHome = process.env.STONE_CLIENT_CONFIG_HOME?.trim()
  const resolvedClientConfigHome = clientConfigHome ? resolve(clientConfigHome) : app.getPath('home')
  const configuredCodexHome = clientConfigHome ? undefined : process.env.CODEX_HOME?.trim()
  const defaultCodexHome = configuredCodexHome
    ? resolve(configuredCodexHome)
    : join(resolvedClientConfigHome, '.codex')
  const grokBuildHome = process.env.GROK_HOME?.trim()
  const clientConfig = new ClientConfigService({
    homeDir: resolvedClientConfigHome,
    platform: process.platform,
    ...((configuredCodexHome || grokBuildHome) ? {
      overrides: {
        ...(configuredCodexHome ? { codexDirectory: defaultCodexHome } : {}),
        ...(grokBuildHome ? { grokbuildDirectory: resolve(grokBuildHome) } : {}),
      },
    } : {}),
  })
  const codexOfficialAuthBridge = new CodexOfficialAuthBridge(clientConfig, store)
  const singBoxRuntimeRoot = app.isPackaged
    ? join(process.resourcesPath, 'sing-box')
    : resolve('build', 'sing-box')
  const systemProxyLease = new SystemProxyLease({
    adapter: createSystemProxyPlatformAdapter(),
    recoveryStore: new FileSystemProxyLeaseRecoveryStore(
      join(app.getPath('userData'), 'built-in-proxy', 'system-proxy-lease.json')
    )
  })
  let startupSystemProxyRecoveryError: unknown
  // A stale OS proxy lease must be repaired before Chromium reloads PAC/system
  // state or any background service gets a chance to issue an outbound request.
  // initialize() retries and publishes a fail-closed error if this first repair
  // attempt cannot complete.
  try {
    await systemProxyLease.recoverStaleLease()
  } catch (error) {
    startupSystemProxyRecoveryError = error
    console.error('[built-in-proxy] Could not repair the previous system-proxy lease before startup', error)
  }
  const ensureSystemProxyRecoveryBarrier = async (): Promise<void> => {
    const state = systemProxyLease.getState()
    if (state.status === 'active') {
      startupSystemProxyRecoveryError = undefined
      return
    }
    if (!startupSystemProxyRecoveryError && !state.recoveryPending && state.status !== 'error') return
    await systemProxyLease.recoverStaleLease()
    startupSystemProxyRecoveryError = undefined
  }
  if (bootstrapShouldStop()) return
  singBoxService = new SingBoxService({
    userDataPath: app.getPath('userData'),
    runtimeRoot: singBoxRuntimeRoot,
    manifestPath: join(singBoxRuntimeRoot, 'runtime-manifest.json')
  })
  const tunController = new TunController({
    adapter: new ElevatedSingBoxTunAdapter({
      userDataPath: app.getPath('userData'),
      runtimeRoot: singBoxRuntimeRoot,
      manifestPath: join(singBoxRuntimeRoot, 'runtime-manifest.json')
    })
  })
  outboundTransport = new OutboundTransportManager({
    outboundNetworkMode: gatewaySettings.outboundNetworkMode ?? 'direct',
    localGatewayPort: gatewaySettings.port,
    // System mode must execute through Chromium's network stack rather than
    // reimplementing its PAC/WinINET decision with an Undici proxy. This keeps
    // Windows trust, integrated proxy auth, bypass and failover semantics.
    systemProxyFetch: ((input, init) => session.defaultSession.fetch(
      input instanceof URL ? input.toString() : input,
      { ...init, bypassCustomProtocolHandlers: true }
    )) as typeof fetch,
    reloadSystemProxy: () => session.defaultSession.forceReloadProxyConfig(),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
    onSystemProxyWarning: (message) => console.warn(`[system-proxy] ${message}`)
  })
  if (gatewaySettings.outboundNetworkMode === 'system') {
    await outboundTransport.reloadSystemProxyConfiguration().catch((error) => {
      console.warn('[system-proxy] Could not refresh the saved system proxy configuration at startup', error)
    })
    if (bootstrapShouldStop()) return
  }
  outboundReloadCoordinator = createOutboundReloadCoordinator(store, outboundTransport)
  builtInProxy = new BuiltInProxyOrchestrator({
    store,
    core: singBoxService,
    routes: outboundTransport.builtInRoutes,
    systemProxyLease,
    tunController,
    createChromiumGeneration: (mixedEndpoint) => createChromiumMixedSessionGeneration({
      mixedEndpoint,
      // Non-persistent, per-generation partitions keep a node/rule switch from
      // changing the proxy underneath responses still draining on the old route.
      createSession: () => session.fromPartition(
        `stone-built-in-proxy-${process.pid}-${++builtInChromiumGeneration}`,
        { cache: false }
      )
    }),
    subscriptionFetch: outboundTransport.fetchFor(undefined),
    localGateway: { host: '127.0.0.1', port: gatewaySettings.port, transport: 'tcp' },
    requiredProxyDomains: () => {
      try {
        return [...collectEnabledOutboundTargets(store).values()].flatMap((target) => {
          try {
            return [new URL(target.targetUrl).hostname]
          } catch {
            return []
          }
        })
      } catch (error) {
        console.warn('[built-in-proxy] Could not collect dynamic required proxy domains', error)
        return []
      }
    },
    reloadExternalSystemProxy: () => outboundReloadCoordinator.reloadExternalSystemRouteStrict(),
    detectBuiltInTargets: async (targets) => {
      await outboundTransport.builtInRoutes.warm(targets)
      return { targets: [...targets] }
    },
    coordinateBuiltInRouteChange: outboundReloadCoordinator.builtInRouteChangeCoordinator(),
    scheduleBuiltInRouteChange: (detector) => outboundReloadCoordinator.scheduleBuiltInRouteChange(detector),
    platformCapabilities: builtInProxyPlatformCapabilities(),
  })
  codexConversationTitles = new CodexConversationTitleResolver(defaultCodexHome)
  codexSessionRepair = new CodexSessionRepairService({ codexHome: defaultCodexHome })
  codexSessionIndexCleanup = new CodexSessionIndexCleanupService({ codexHome: defaultCodexHome })
  codexSessionManager = new CodexSessionManager({ codexHome: defaultCodexHome })
  const codexDesktop = process.platform === 'darwin'
    ? new MacChatGptDesktopController()
    : process.platform === 'win32'
      ? new WindowsChatGptDesktopController({
      shouldDisableCodexMicro: () => store.getRuntimeGatewaySettings().disableCodexMicro === true,
      })
      : new UnsupportedChatGptDesktopController(process.platform)
  codexRepairAndRestart = new CodexRepairAndRestartService(
    codexSessionRepair,
    codexDesktop,
    codexSessionIndexCleanup,
  )
  await store.refreshRequestConversationTitles((conversationId) => codexConversationTitles.resolve(conversationId))
  if (bootstrapShouldStop()) return
  backups = new DatabaseBackupService({
    userDataPath: app.getPath('userData'),
    store: store.getStateRepository(),
    automaticRetention: store.getSnapshot().gateway.backupRetention ?? 10,
    portableSecretVault: safeStorage,
    beforeRawBackup: async () => {
      if (!webDavBackups) throw new Error('WebDAV backup safety checks are not ready')
      await webDavBackups.prepareForRawBackup()
    },
    onRestoreCommitted: async () => {
      // The old generation's plaintext cache must disappear before any read of
      // restored state, then persisted transient data is normalized before the
      // shared WebDAV migration gate permits another raw SQLite copy.
      store.invalidateCredentialCache()
      await store.sanitizePersistedData()
    },
  })
  await backups.initialize()
  webDavBackups = new WebDavBackupService({
    metadata: store.getStateRepository(),
    safeStorage,
    backups,
    backupDirectory: backups.directory,
    temporaryDirectory: join(app.getPath('userData'), 'webdav-transfer'),
  })
  try {
    if (store.getSnapshot().gateway.automaticBackups !== false) {
      await backups.startAutomaticBackups()
    } else {
      // Even with automatic backups disabled, eagerly remove legacy userinfo;
      // manual/export paths will retry the same gate if this attempt fails.
      await webDavBackups.prepareForRawBackup()
    }
  } catch {
    // Do not include the migration error here: a legacy error can contain the
    // credential-bearing URL that this startup barrier is protecting.
    console.warn('[backup] Raw database backups remain safety-blocked because legacy WebDAV credentials could not be removed safely.')
  }
  if (bootstrapShouldStop()) return
  gateway = new GatewayServer({
    config: toGatewayConfig(store),
    beforeStart: ensureSystemProxyRecoveryBarrier,
    credentialResolver: async (account, fetchImplementation = fetch, signal) => {
      if (account.credentialType === 'chatgpt-agent-identity') {
        const serialized = store.getCredential(account.credentialId)
        if (!serialized) return undefined
        const resolve = async (
          source: string,
          forceTaskRegistration = false,
          expectedTaskId?: string
        ): Promise<ResolvedGatewayCredential> => {
          const access = await resolveChatGptAgentIdentity(
            source,
            (rotated, expectedSource) => store.persistRotatedChatGptAgentIdentityCredential(account.id, rotated, expectedSource),
            fetchImplementation,
            { signal, forceTaskRegistration, expectedTaskId }
          )
          return {
            secret: access.authorization,
            kind: 'chatgpt-agent-identity' as const,
            accountId: access.bundle.accountId,
            fedramp: access.bundle.fedramp,
            recoverInvalidTask: async () => {
              // Re-read after initial registration so compare-and-swap task
              // persistence never overwrites a newer import.
              const latest = store.getCredential(account.credentialId)
              if (!latest) throw new Error('Agent Identity credential is unavailable.')
              return await resolve(latest, true, access.bundle.taskId)
            }
          }
        }
        return await resolve(serialized)
      }
      if (account.credentialType === 'chatgpt-oauth') {
        const codexOwned = await codexOfficialAuthBridge.gatewayCredential(account)
        if (codexOwned.owned) {
          return codexOwned.accessToken && codexOwned.accountId
            ? {
                secret: codexOwned.accessToken,
                kind: 'chatgpt-oauth' as const,
                accountId: codexOwned.accountId,
              }
            : undefined
        }
        const serialized = store.getCredential(account.credentialId)
        if (!serialized) return undefined
        const resolve = async (
          source: string,
          forceRefresh = false,
          includeRecovery = true,
        ): Promise<ResolvedGatewayCredential> => {
          const resolved = await resolveChatGptCredential(
            source,
            (rotated, expectedSource) => store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
            fetchImplementation,
            Date.now(),
            {
              refreshKey: account.id,
              signal,
              forceRefresh,
            }
          )
          if (account.chatgptAccountId && resolved.bundle.accountId !== account.chatgptAccountId) {
            throw new Error('ChatGPT credential account identity does not match the selected account.')
          }
          return {
            secret: resolved.bundle.accessToken,
            kind: 'chatgpt-oauth' as const,
            accountId: resolved.bundle.accountId,
            ...(includeRecovery ? {
              recoverRejectedAccess: async (rejectedAccessToken = resolved.bundle.accessToken) => {
                // Re-read after the 401. Another request may already have
                // rotated the refresh token; never overwrite or refresh that
                // newer credential merely because this request used the old
                // access token.
                const latest = store.getCredential(account.credentialId)
                if (!latest) throw new Error('ChatGPT credential is unavailable.')
                const latestBundle = deserializeChatGptCredential(latest)
                if (!latestBundle) throw new Error('ChatGPT account credential is invalid.')
                return await resolve(latest, latestBundle.accessToken === rejectedAccessToken, false)
              },
            } : {}),
          }
        }
        return await resolve(serialized)
      }
      if (account.credentialType === 'grok-oauth') {
        const serialized = store.getCredential(account.credentialId)
        if (!serialized) return undefined
        const resolve = async (
          source: string,
          forceRefresh = false,
          includeRecovery = true,
        ): Promise<ResolvedGatewayCredential> => {
          const resolved = await resolveGrokOAuthCredential(
            source,
            (rotated, expectedSource) => store.persistRotatedGrokOAuthCredential(account.id, rotated, expectedSource),
            fetchImplementation,
            Date.now(),
            { refreshKey: account.id, signal, forceRefresh },
          )
          return {
            secret: resolved.bundle.accessToken,
            kind: 'grok-oauth' as const,
            accountId: resolved.bundle.subjectId,
            ...(includeRecovery ? {
              recoverRejectedAccess: async (rejectedAccessToken = resolved.bundle.accessToken) => {
                // Refresh tokens rotate. Re-read the encrypted credential after
                // a 401 so this request can reuse a newer rotation instead of
                // revoking or overwriting it with stale state.
                const latest = store.getCredential(account.credentialId)
                if (!latest) throw new Error('Grok OAuth credential is unavailable.')
                const latestBundle = deserializeGrokOAuthCredential(latest)
                if (!latestBundle) throw new Error('Grok OAuth account credential is invalid.')
                if (latestBundle.subjectId !== resolved.bundle.subjectId) {
                  throw new Error('Grok OAuth credential account identity changed unexpectedly.')
                }
                return await resolve(latest, latestBundle.accessToken === rejectedAccessToken, false)
              },
            } : {}),
          }
        }
        return await resolve(serialized)
      }
      const secret = store.getCredential(account.credentialId)
      return secret ? { secret, kind: 'api-key' as const } : undefined
    },
    loadGrokVideoBindings: () => {
      const serialized = store.getStateRepository().readAppMetadata(GROK_VIDEO_BINDINGS_METADATA_KEY)
      if (!serialized) return []
      if (serialized.length > GROK_VIDEO_BINDINGS_METADATA_MAX_CHARS) return []
      try {
        const parsed: unknown = JSON.parse(serialized)
        return Array.isArray(parsed) ? parsed as PersistedGrokVideoBinding[] : []
      } catch {
        return []
      }
    },
    saveGrokVideoBindings: async (bindings) => {
      const repository = store.getStateRepository()
      if (bindings.length === 0) {
        await repository.removeAppMetadata(GROK_VIDEO_BINDINGS_METADATA_KEY)
        return
      }
      await repository.writeAppMetadata(GROK_VIDEO_BINDINGS_METADATA_KEY, JSON.stringify(bindings))
    },
    outboundFetchResolver: (account, pool, proxies) => {
      const proxy = resolveEffectiveProxy(account, pool, proxies)
      if (!proxy) return outboundTransport.fetchFor(undefined)
      const cached = outboundTransport.fetchForCached(proxy)
      if (cached) return cached
      return outboundTransport.fetchFor(proxy, proxy.hasPassword ? store.getProxyPassword(proxy.id) : undefined)
    },
    conversationTitleResolver: (conversationId) => codexConversationTitles.resolve(conversationId)
  })
  localEventServer = new LocalEventServer({ userDataPath: app.getPath('userData') })
  const eventServerStart = await startLocalEventServerForBootstrap(localEventServer, bootstrapShouldStop)
  if (eventServerStart.status === 'stopping' || bootstrapShouldStop()) return
  if (eventServerStart.status === 'ready') {
    gateway.onLog((log) => localEventServer.publish('request.log', log))
    gateway.onAccountState((state) => localEventServer.publish('account.state', state))
    gateway.onRuntimeState((state) => {
      localEventServer.publish('gateway.runtime', state)
      if (state.gatewayStatus) localEventServer.publish('gateway.status', gateway.getStatus())
    })
  } else {
    // The event stream is an optional local integration surface. A port or
    // filesystem failure must never prevent the gateway itself from starting.
    console.warn('Stone+ local event stream is unavailable', eventServerStart.error)
  }
  // Claude Desktop lifecycle setup and its dedicated recovery IPC must share
  // one serialized configuration owner so repair/rollback operations cannot
  // race through separate in-memory queues.
  claudeDesktopConfig = new ClaudeDesktopConfig()
  claudeDesktopCoordinator = new ClaudeDesktopOperationCoordinator(claudeDesktopConfig)
  clientInstanceManager = new ClientInstanceManager({
    store: store.getStateRepository(),
    validateLaunchPlan: async () => {
      const expected = store.getSnapshot().gateway
      if (!gateway.getStatus().running) await gateway.start(expected)
      const status = gateway.getStatus()
      if (!status.running) throw new Error('The local gateway could not be started.')
      if (status.host !== expected.host || status.port !== expected.port) {
        throw new Error('The local gateway is running on a different address. Restart it before launching this client.')
      }
    },
    resolveBinding: (instance) => {
      const snapshot = store.getSnapshot()
      const route = instance.routeId
        ? snapshot.routes.find((candidate) => candidate.id === instance.routeId)
        : snapshot.routes.find((candidate) => candidate.client === instance.client && candidate.enabled)
      if (!route) throw new Error(instance.routeId ? 'The bound client route no longer exists.' : 'No enabled client route is available.')
      if (!route.enabled) throw new Error('The bound client route is disabled.')
      if (route.client !== instance.client) throw new Error('The bound route does not match this client type.')
      if (instance.profileId) {
        const profile = snapshot.clientProfiles.find((candidate) => candidate.id === instance.profileId)
        if (!profile || profile.client !== instance.client) throw new Error('The bound client profile is unavailable.')
        if (profile.directory && resolve(profile.directory) !== resolve(instance.configDirectory)) {
          throw new Error('The bound client profile uses a different configuration directory. Update this instance before starting it.')
        }
      }
      const host = snapshot.gateway.host.includes(':') ? `[${snapshot.gateway.host}]` : snapshot.gateway.host
      const base = `http://${host}:${snapshot.gateway.port}`
      if (instance.client === 'codex') return { env: { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: route.localToken } }
      if (instance.client === 'claude') return { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: route.localToken } }
      if (instance.client === 'gemini') return { env: { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: route.localToken } }
      // Grok Build primarily reads config.toml, but env fallbacks keep a managed
      // launch usable when the selected profile was not rewritten yet.
      return {
        env: {
          OPENAI_BASE_URL: `${base}/grokbuild/v1`,
          OPENAI_API_KEY: route.localToken,
        },
      }
    }
  })
  agentInstaller = new AgentInstallationService({
    openExternal: (url) => shell.openExternal(url),
  })
  agentLifecycle = createAgentLifecycleService({
    store,
    clientConfig,
    instances: clientInstanceManager,
    codexRepair: codexRepairAndRestart,
    codexDesktop,
    installer: agentInstaller,
    openExternal: (url) => shell.openExternal(url),
    claudeDesktopCoordinator,
    beforeDefaultCodexConnectionRepair: () => codexOfficialAuthBridge.reclaimCurrent(),
  })
  clientInstanceManager.initialize()
  const initializedInstances = await clientInstanceManager.recoverOrphanedProcesses()
  const instanceSnapshot = store.getSnapshot()
  const profiles = instanceSnapshot.clientProfiles
  for (const instance of initializedInstances) {
    const routeId = instance.routeId
      ?? instanceSnapshot.routes.find((candidate) => candidate.client === instance.client && candidate.enabled)?.id
    const profile = instance.profileId
      ? profiles.find((candidate) => candidate.id === instance.profileId && candidate.client === instance.client)
      : undefined
    const profileId = profile && (!profile.directory || resolve(profile.directory) === resolve(instance.configDirectory))
      ? profile.id
      : undefined
    if (routeId !== instance.routeId || profileId !== instance.profileId) {
      await clientInstanceManager.save({ ...instance, routeId, profileId })
    }
  }
  if (bootstrapShouldStop()) return

  updateService = new UpdateService({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    updater: autoUpdater,
    preferences: store,
    fetchImplementation: (url, init) => net.fetch(url, init),
    openExternal: (url) => shell.openExternal(url),
    prepareToInstall: async () => {
      isQuitting = true
      shutdownForUpdate = true
      try {
        await shutdownServices()
      } catch (error) {
        isQuitting = false
        shutdownForUpdate = false
        throw error
      }
    },
    onInstallHandoff: () => {
      // electron-updater accepted the installer launch, and every runtime
      // service is already closed. If its scheduled app.quit never completes,
      // do not leave a visible process serving a gateway with a closed
      // outbound transport. The installer owns reopening the application.
      const timer = setTimeout(() => app.exit(0), 5_000)
      timer.unref()
    },
    recoverAfterInstallFailure: () => {
      // Full shutdown is intentionally irreversible. Relaunch the current
      // build when installer startup fails instead of leaving a half-dead UI
      // that can only return "Outbound transport manager is closed".
      setImmediate(() => {
        app.relaunch()
        app.exit(0)
      })
    },
  })
  await updateService.initialize()
  if (bootstrapShouldStop()) return

  tunnelService = new FrpTunnelService({
    userDataPath: app.getPath('userData'),
    binaryPath: app.isPackaged
      ? join(process.resourcesPath, 'frp', 'frpc.exe')
      : resolve('build/frp/frpc.exe'),
    verifyBinaryIntegrity: verifyFrpcBinaryIntegrity,
  })
  await tunnelService.initialize()
  if (bootstrapShouldStop()) return

  browserImportQueue = new BrowserImportQueue(
    join(app.getPath('temp'), 'stone-plus-browser-imports'),
    join(app.getPath('userData'), 'browser-json-cache')
  )
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION, { cache: true })
  browserImportQueue.watch(browserSession)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview' || contents.session !== browserSession) return
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeBrowserUrl(url)) {
        contents.hostWebContents?.send('stone:browser-open-tab', { url, guestId: contents.id })
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isSafeBrowserUrl(url)) event.preventDefault()
    })
  })

  const chatGptWebLogin = new ChatGptWebLoginService({
    store,
    outboundTransport,
    iconPath: stoneIconPath(),
  })
  const chatGptCodexAppLogin = new ChatGptCodexAppLoginService({
    store,
    outboundTransport,
    clientConfig,
    repairAndRestart: codexRepairAndRestart,
    officialAuthBridge: codexOfficialAuthBridge,
    backupRetention: () => store.getSnapshot().gateway.backupRetention ?? 10,
  })

  flushGatewayApiState = registerGatewayApi(
    store, gateway, clientConfig, outboundTransport, backups,
    updateTrayMenu, browserImportQueue, undefined, localEventServer, outboundReloadCoordinator, webDavBackups,
    (_theme, preference) => {
      nativeTheme.themeSource = preference
      rendererThemeReady = true
      if (rendererThemeReadyTimeout) clearTimeout(rendererThemeReadyTimeout)
      rendererThemeReadyTimeout = undefined
      revealMainWindowIfReady()
    },
    chatGptWebLogin,
    chatGptCodexAppLogin,
  )
  disposeBuiltInProxyApi = registerBuiltInProxyApi(builtInProxy, builtInProxy)
  systemLifecycle = new SystemLifecycleCoordinator({
    rebuildConnections: () => rebuildGatewayConnections(store, outboundTransport),
    isOnline: () => net.isOnline()
  })
  registerCodexSessionRepairApi(codexSessionRepair, codexRepairAndRestart, {
    clientConfig,
    clientProfiles: () => store.getSnapshot().clientProfiles,
  }, codexSessionIndexCleanup)
  disposeClientInstanceApi = registerClientInstanceApi(clientInstanceManager, store)
  disposeAgentLifecycleApi = registerAgentLifecycleApi(agentLifecycle)
  disposeClaudeDesktopApi = registerClaudeDesktopApi(claudeDesktopCoordinator)
  registerCodexSessionManagerApi(codexSessionManager)
  registerPersistentTaskApi(store.getPersistentTaskRunner())
  registerUpdateApi(updateService)
  registerTunnelApi(tunnelService)
  requestMonitorWindow = new RequestMonitorWindowController({
    preloadPath: join(__dirname, '../preload/index.cjs'),
    rendererTarget: rendererTargetUrl(),
    iconPath: stoneIconPath(),
    windowsAppUserModelId: windowsAppUserModelId(),
    showMainWindow,
    stateStore: new FileRequestMonitorWindowStateStore(join(app.getPath('userData'), 'request-monitor-window.json')),
  })
  disposeRequestMonitorApi = registerRequestMonitorApi(requestMonitorWindow)
  createWindow()
  createTray()
  requestMonitorWindow.restore()
  await builtInProxy.initialize().catch((error) => {
    // The window and IPC surface are ready before optional proxy auto-start so
    // slow subscriptions and health checks remain visible to the user.
    console.error('[built-in-proxy] Automatic initialization failed', error)
  })
  if (bootstrapShouldStop()) return
  powerMonitor.on('suspend', () => systemLifecycle.onSuspend())
  powerMonitor.on('resume', () => systemLifecycle.onResume())
  systemLifecycle.start()
  updateService.startAutomaticChecks()

  if (store.getSnapshot().gateway.autoStart) {
    try {
      await gateway.start()
      if (bootstrapShouldStop()) return
      warmGatewayConnections(store, outboundTransport)
    } catch (error: unknown) {
      if (!bootstrapShouldStop()) console.error('Stone+ could not auto-start the gateway', error)
    } finally {
      if (!bootstrapShouldStop()) store.setGatewayStatus(gateway.getStatus())
    }
  }
  if (bootstrapShouldStop()) return

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      showMainWindow()
    }
  })
}

function bootstrapShouldStop(): boolean {
  return isQuitting || storeClosed
}

function createWindow(): void {
  const iconPath = stoneIconPath()
  mainWindowReadyToShow = false
  rendererThemeReady = false
  if (rendererThemeReadyTimeout) clearTimeout(rendererThemeReadyTimeout)
  rendererThemeReadyTimeout = undefined
  // Seed the hidden window from the OS, then wait for the renderer's persisted
  // preference handshake before showing it. The timeout below remains a
  // fail-safe if the renderer cannot initialize.
  const initialChrome = windowChromePalette(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: initialChrome.background,
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: initialChrome.titleBar,
        symbolColor: initialChrome.titleBarSymbol,
        height: TITLE_BAR_HEIGHT
      }
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
      spellcheck: false
    }
  })

  // Windows taskbar grouping can fall back to Electron's executable icon when
  // a PNG window icon is used. Reapply the packaged multi-size ICO explicitly.
  if (process.platform === 'win32') {
    const windowIcon = nativeImage.createFromPath(iconPath)
    if (!windowIcon.isEmpty()) mainWindow.setIcon(windowIcon)
    mainWindow.setAppDetails({
      appId: windowsAppUserModelId(),
      appIconPath: iconPath,
      appIconIndex: 0
    })
  }

  mainWindow.setMenuBarVisibility(false)
  const rendererTarget = rendererTargetUrl()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    const partition = params.partition || webPreferences.partition
    if (!isSafeBrowserUrl(params.src) || partition !== BROWSER_SESSION_PARTITION) event.preventDefault()
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = trustedDevelopmentRendererUrl()
      ? new URL(targetUrl).origin === new URL(rendererTarget).origin
      : targetUrl === rendererTarget
    if (!allowed) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => {
    mainWindowReadyToShow = true
    if (!rendererThemeReady) {
      rendererThemeReadyTimeout = setTimeout(() => {
        rendererThemeReadyTimeout = undefined
        rendererThemeReady = true
        revealMainWindowIfReady()
      }, RENDERER_THEME_READY_TIMEOUT_MS)
    }
    revealMainWindowIfReady()
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindowReadyToShow = false
    rendererThemeReady = false
    if (rendererThemeReadyTimeout) clearTimeout(rendererThemeReadyTimeout)
    rendererThemeReadyTimeout = undefined
  })

  if (trustedDevelopmentRendererUrl()) {
    void mainWindow.loadURL(rendererTarget)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function trustedDevelopmentRendererUrl(): string | undefined {
  if (app.isPackaged) return undefined
  const candidate = process.env.ELECTRON_RENDERER_URL?.trim()
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    return loopback && (url.protocol === 'http:' || url.protocol === 'https:') ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function rendererTargetUrl(): string {
  return trustedDevelopmentRendererUrl()
    ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(stoneIconPath())
  if (icon.isEmpty()) {
    console.warn('Stone+ tray icon could not be created; continuing without a tray')
    return
  }

  tray = new Tray(icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('Stone+ local gateway')
  updateTrayMenu()
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide()
    } else {
      showMainWindow()
    }
  })
}

function revealMainWindowIfReady(): void {
  if (!mainWindowReadyToShow || !rendererThemeReady) return
  if (!startedHidden || focusMainWindowOnReady) showMainWindow()
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindowReadyToShow || !rendererThemeReady) {
    focusMainWindowOnReady = true
    return
  }
  focusMainWindowOnReady = false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function stoneIconPath(): string {
  const filename = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return app.isPackaged
    ? join(process.resourcesPath, filename)
    : resolve('build', filename)
}

function windowsAppUserModelId(): string {
  // Development runs use Electron's executable and may leave an Electron.lnk
  // shortcut behind. Sharing the production ID lets Explorer associate that
  // shortcut's default Electron icon with the installed Stone+ taskbar group.
  return app.isPackaged ? WINDOWS_APP_USER_MODEL_ID : WINDOWS_DEV_APP_USER_MODEL_ID
}

function isSafeBrowserUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function updateTrayMenu(): void {
  if (!tray) return
  const snapshot = store.getSnapshot()
  tray.setToolTip(snapshot.gatewayStatus.running ? 'Stone+ gateway is running' : 'Stone+ gateway is stopped')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Stone+',
        click: () => showMainWindow()
      },
      { type: 'separator' },
      {
        label: snapshot.gatewayStatus.running ? 'Stop Gateway' : 'Start Gateway',
        click: () => void toggleGatewayFromTray()
      },
      ...snapshot.routes.map((route) => ({
        label: `${route.client === 'claude'
          ? 'Claude Code'
          : route.client === 'codex'
            ? 'Codex'
            : route.client === 'grokbuild' ? 'Grok Build' : 'Gemini CLI'} Route`,
        type: 'checkbox' as const,
        checked: route.enabled,
        click: () => void toggleRouteFromTray(route.id)
      })),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

async function toggleGatewayFromTray(): Promise<void> {
  try {
    if (gateway.getStatus().running) await gateway.stop({ force: true })
    else {
      gateway.updateConfig(toGatewayConfig(store))
      await gateway.start()
    }
    store.setGatewayStatus(gateway.getStatus())
    updateTrayMenu()
  } catch (error) {
    console.error('Stone+ tray could not toggle gateway', error)
  }
}

async function toggleRouteFromTray(routeId: string): Promise<void> {
  const route = store.getSnapshot().routes.find((candidate) => candidate.id === routeId)
  if (!route) return
  try {
    await store.updateRoute({ ...route, enabled: !route.enabled })
    gateway.updateConfig(toGatewayConfig(store))
    updateTrayMenu()
  } catch (error) {
    console.error('Stone+ tray could not toggle route', error)
  }
}

function toGatewayConfig(store: AppStore): GatewayConfig {
  const configuration = store.getRuntimeConfiguration()
  return {
    providers: configuration.providers,
    accounts: configuration.accounts,
    pools: configuration.pools,
    proxies: configuration.proxies,
    routes: configuration.routes,
    settings: configuration.gateway,
    recentRequestLogs: store.getAccountFitnessHistory()
  }
}

app.on('before-quit', (event) => {
  isQuitting = true
  if (storeClosed) return
  event.preventDefault()
  void shutdownServices().then(
    () => app.quit(),
    (error: unknown) => {
      // Access restoration is a hard exit boundary: keeping the app and core
      // alive is safer than orphaning sing-box or leaving the OS on a dead
      // mixed endpoint. A later quit retries the durable lease cleanup.
      isQuitting = false
      console.error('Stone+ cancelled shutdown because built-in proxy cleanup is incomplete', error)
      showMainWindow()
    },
  )
})

app.on('window-all-closed', () => {
  if (!tray) app.quit()
})

if (!ownsSingleInstanceLock) {
  storeClosed = true
  app.quit()
} else {
  void bootstrap().catch((error: unknown) => {
    if (bootstrapShouldStop()) return
    console.error('Stone+ failed to start', error)
    app.quit()
  })
}

function shutdownServices(): Promise<void> {
  if (storeClosed) return Promise.resolve()
  if (shutdownPromise) return shutdownPromise
  const flight = (async () => {
    // Quiesce and drain renderer mutations before touching any process-owned
    // network state. This critical phase is intentionally not best-effort.
    const disposeApi = disposeBuiltInProxyApi
    await shutdownBuiltInProxyBoundary({
      quiesceIpc: async () => {
        if (!disposeApi) return
        const drain = disposeApi()
        disposeBuiltInProxyApi = undefined
        await drain
      },
      closeProxy: async () => {
        if (builtInProxy) await builtInProxy.close()
      },
      // close() leaves the live core supervised when access restoration fails.
      // Restore IPC admission so the user can retry without restarting.
      resumeIpc: () => {
        if (builtInProxy && !disposeBuiltInProxyApi) {
          disposeBuiltInProxyApi = registerBuiltInProxyApi(builtInProxy, builtInProxy)
        }
      },
    })

    // Every service gets its own best-effort shutdown step. In particular, a
    // failed gateway stop must not skip pending-state flushes, backup cleanup,
    // transport teardown, or the durable store close. The store is
    // intentionally the final step because most preceding services can still
    // have state to checkpoint while they are closing.
    await shutdownStep('update service', () => {
      if (!shutdownForUpdate && updateService) updateService.close()
    })
    await shutdownStep('Codex client version sync', () => {
      if (codexClientVersionSync) codexClientVersionSync.close()
    })
    await shutdownStep('request monitor', () => {
      disposeRequestMonitorApi?.()
      disposeRequestMonitorApi = undefined
      requestMonitorWindow?.dispose()
      requestMonitorWindow = undefined
    })
    await shutdownStep('managed client instances', async () => {
      await Promise.all([
        disposeAgentLifecycleApi?.(),
        disposeClaudeDesktopApi?.(),
        disposeClientInstanceApi?.(),
      ])
      disposeAgentLifecycleApi = undefined
      disposeClaudeDesktopApi = undefined
      disposeClientInstanceApi = undefined
      if (agentLifecycle) await agentLifecycle.dispose()
      if (clientInstanceManager) {
        const result = await clientInstanceManager.stopAll()
        if (result.stillRunning.length > 0) {
          console.error('Stone+ could not terminate every managed client instance', result.stillRunning)
        }
      }
    })
    await shutdownStep('Codex repair service', async () => {
      if (codexRepairAndRestart) await codexRepairAndRestart.close()
    })
    await shutdownStep('tunnel service', async () => {
      if (tunnelService) await tunnelService.close()
    })
    await shutdownStep('system lifecycle coordinator', async () => {
      if (systemLifecycle) await systemLifecycle.close()
    })
    await shutdownStep('gateway', async () => {
      if (gateway) await gateway.stop({ force: true })
    })
    await shutdownStep('gateway state flush', async () => {
      if (flushGatewayApiState) await flushGatewayApiState()
    })
    await shutdownStep('outbound reload coordinator', async () => {
      if (outboundReloadCoordinator) await outboundReloadCoordinator.close()
    })
    await shutdownStep('database backup service', async () => {
      if (backups) await backups.close()
    })
    await shutdownStep('outbound transport', async () => {
      if (outboundTransport) await outboundTransport.close()
    })
    await shutdownStep('conversation title resolver', () => {
      if (codexConversationTitles) codexConversationTitles.close()
    })
    await shutdownStep('browser import queue', async () => {
      if (browserImportQueue) await browserImportQueue.close()
    })
    await shutdownStep('local event server', async () => {
      if (localEventServer) await localEventServer.close()
    })
    await shutdownStep('application store', async () => {
      if (store) await store.close()
    })
    storeClosed = true
  })()
  shutdownPromise = flight
  void flight.catch(() => {
    if (shutdownPromise === flight) shutdownPromise = undefined
  })
  return flight
}

async function shutdownStep(name: string, operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    console.error(`Stone+ could not close ${name} during graceful shutdown`, error)
  }
}
