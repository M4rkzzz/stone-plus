import { app, BrowserWindow, Menu, nativeImage, net, powerMonitor, safeStorage, session, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewayServer, type GatewayConfig, type ResolvedGatewayCredential } from './gateway'
import { ClientConfigService } from './client-config'
import { rebuildGatewayConnections, registerGatewayApi, warmGatewayConnections } from './ipc/gateway-api'
import { registerUpdateApi } from './ipc/update-api'
import { AppStore } from './store/app-store'
import { DatabaseBackupService } from './backup'
import { resolveChatGptCredential } from './providers'
import { resolveChatGptAgentIdentity } from './auth'
import {
  createOutboundReloadCoordinator,
  OutboundTransportManager,
  resolveEffectiveProxy,
  type OutboundReloadCoordinator,
} from './proxy'
import { UpdateService } from './update'
import { FrpTunnelService } from './tunnel'
import { registerTunnelApi } from './ipc/tunnel-api'
import {
  CodexConversationTitleResolver,
  CodexRepairAndRestartService,
  CodexSessionManager,
  CodexSessionIndexCleanupService,
  CodexSessionRepairService,
  WindowsChatGptDesktopController,
} from './codex'
import { registerCodexSessionRepairApi } from './ipc/session-repair-api'
import { ClientInstanceManager } from './client-instances'
import { registerClientInstanceApi } from './ipc/client-instance-api'
import { registerCodexSessionManagerApi } from './ipc/session-manager-api'
import { registerPersistentTaskApi } from './ipc/persistent-task-api'
import { BROWSER_SESSION_PARTITION, BrowserImportQueue } from './browser-import-queue'
import { LocalEventServer } from './events'
import { SystemLifecycleCoordinator } from './system-lifecycle'
import { registerBuiltInProxyApi } from './ipc/built-in-proxy-api'
import { SingBoxService } from './proxy/built-in/sing-box-service'
import { BuiltInProxyOrchestrator } from './proxy/built-in/orchestrator'
import { createChromiumMixedSessionGeneration } from './proxy/built-in/chromium-route-session'
import { FileSystemProxyLeaseRecoveryStore } from './proxy/built-in/lease-recovery'
import { SystemProxyLease } from './proxy/built-in/system-proxy-lease'
import { createSystemProxyPlatformAdapter } from './proxy/built-in/platform-adapters'
import { ElevatedSingBoxTunAdapter } from './proxy/built-in/tun-sidecar-adapter'
import { TunController } from './proxy/built-in/tun-controller'

const { autoUpdater } = electronUpdater
const WINDOWS_APP_USER_MODEL_ID = 'io.github.m4rkzzz.stoneplus'
const WINDOWS_DEV_APP_USER_MODEL_ID = `${WINDOWS_APP_USER_MODEL_ID}.dev`

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let store: AppStore
let gateway: GatewayServer
let backups: DatabaseBackupService<import('./store/types').PersistedState>
let outboundTransport: OutboundTransportManager
let outboundReloadCoordinator: OutboundReloadCoordinator
let builtInProxy: BuiltInProxyOrchestrator
let singBoxService: SingBoxService
let updateService: UpdateService
let tunnelService: FrpTunnelService
let codexConversationTitles: CodexConversationTitleResolver
let codexSessionRepair: CodexSessionRepairService
let codexSessionIndexCleanup: CodexSessionIndexCleanupService
let codexRepairAndRestart: CodexRepairAndRestartService
let codexSessionManager: CodexSessionManager
let clientInstanceManager: ClientInstanceManager
let browserImportQueue: BrowserImportQueue
let localEventServer: LocalEventServer
let systemLifecycle: SystemLifecycleCoordinator
let isQuitting = false
let storeClosed = false
let shutdownForUpdate = false
let shutdownPromise: Promise<void> | undefined
let flushGatewayApiState: (() => Promise<void>) | undefined
let disposeBuiltInProxyApi: (() => void) | undefined
let focusMainWindowOnReady = false
let builtInChromiumGeneration = 0

if (process.env.STONE_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.STONE_USER_DATA_DIR))
}

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

  store = new AppStore(app.getPath('userData'))
  await store.initialize()
  const gatewaySettings = store.getSnapshot().gateway
  const singBoxRuntimeRoot = app.isPackaged
    ? join(process.resourcesPath, 'sing-box')
    : resolve('build', 'sing-box')
  const systemProxyLease = new SystemProxyLease({
    adapter: createSystemProxyPlatformAdapter(),
    recoveryStore: new FileSystemProxyLeaseRecoveryStore(
      join(app.getPath('userData'), 'built-in-proxy', 'system-proxy-lease.json')
    )
  })
  // A stale OS proxy lease must be repaired before Chromium reloads PAC/system
  // state or any background service gets a chance to issue an outbound request.
  // initialize() retries and publishes a fail-closed error if this first repair
  // attempt cannot complete.
  await systemProxyLease.recoverStaleLease().catch((error) => {
    console.error('[built-in-proxy] Could not repair the previous system-proxy lease before startup', error)
  })
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
    reloadExternalSystemProxy: () => outboundReloadCoordinator.reloadExternalSystemRoute(),
    detectBuiltInTargets: async (targets) => {
      await outboundTransport.builtInRoutes.warm(targets)
      return { targets: [...targets] }
    },
    coordinateBuiltInRouteChange: outboundReloadCoordinator.builtInRouteChangeCoordinator(),
    scheduleBuiltInRouteChange: (detector) => outboundReloadCoordinator.scheduleBuiltInRouteChange(detector)
  })
  codexConversationTitles = new CodexConversationTitleResolver(app.getPath('home'))
  codexSessionRepair = new CodexSessionRepairService({ codexHome: join(app.getPath('home'), '.codex') })
  codexSessionIndexCleanup = new CodexSessionIndexCleanupService({ codexHome: join(app.getPath('home'), '.codex') })
  codexSessionManager = new CodexSessionManager({ codexHome: join(app.getPath('home'), '.codex') })
  codexRepairAndRestart = new CodexRepairAndRestartService(
    codexSessionRepair,
    new WindowsChatGptDesktopController({
      shouldDisableCodexMicro: () => store.getRuntimeGatewaySettings().disableCodexMicro === true,
    }),
    codexSessionIndexCleanup,
  )
  await store.refreshRequestConversationTitles((conversationId) => codexConversationTitles.resolve(conversationId))
  backups = new DatabaseBackupService({
    userDataPath: app.getPath('userData'),
    store: store.getStateRepository(),
    automaticRetention: store.getSnapshot().gateway.backupRetention ?? 10,
    portableSecretVault: safeStorage,
  })
  await backups.initialize()
  if (store.getSnapshot().gateway.automaticBackups !== false) backups.startAutomaticBackups()
  gateway = new GatewayServer({
    config: toGatewayConfig(store),
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
            (rotated, expectedSource) => store.updateChatGptAgentIdentityCredential(account.id, rotated, expectedSource),
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
        const serialized = store.getCredential(account.credentialId)
        if (!serialized) return undefined
        const resolved = await resolveChatGptCredential(
          serialized,
          (rotated, expectedSource) => store.updateChatGptCredential(account.id, rotated, expectedSource),
          fetchImplementation,
          Date.now(),
          { refreshKey: account.id, signal }
        )
        return { secret: resolved.bundle.accessToken, kind: 'chatgpt-oauth' as const, accountId: resolved.bundle.accountId }
      }
      const secret = store.getCredential(account.credentialId)
      return secret ? { secret, kind: 'api-key' as const } : undefined
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
  try {
    await localEventServer.start()
    gateway.onLog((log) => localEventServer.publish('request.log', log))
    gateway.onAccountState((state) => localEventServer.publish('account.state', state))
    gateway.onRuntimeState((state) => {
      localEventServer.publish('gateway.runtime', state)
      if (state.gatewayStatus) localEventServer.publish('gateway.status', gateway.getStatus())
    })
  } catch (error) {
    // The event stream is an optional local integration surface. A port or
    // filesystem failure must never prevent the gateway itself from starting.
    console.warn('Stone+ local event stream is unavailable', error)
  }
  const clientConfigHome = process.env.STONE_CLIENT_CONFIG_HOME
  const clientConfig = new ClientConfigService({
    homeDir: clientConfigHome ? resolve(clientConfigHome) : app.getPath('home'),
    platform: process.platform
  })
  clientInstanceManager = new ClientInstanceManager({
    store: store.getStateRepository(),
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
      return { env: { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: route.localToken } }
    }
  })
  const initializedInstances = clientInstanceManager.initialize()
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
      await shutdownServices()
    }
  })
  await updateService.initialize()

  tunnelService = new FrpTunnelService({
    userDataPath: app.getPath('userData'),
    binaryPath: app.isPackaged
      ? join(process.resourcesPath, 'frp', 'frpc.exe')
      : resolve('build/frp/frpc.exe')
  })
  await tunnelService.initialize()

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

  flushGatewayApiState = registerGatewayApi(
    store, gateway, clientConfig, outboundTransport, backups,
    updateTrayMenu, browserImportQueue, undefined, localEventServer, outboundReloadCoordinator
  )
  disposeBuiltInProxyApi = registerBuiltInProxyApi(builtInProxy, builtInProxy)
  await builtInProxy.initialize().catch((error) => {
    // Built-in startup failures are renderer-visible and deliberately do not
    // prevent the local gateway UI from opening. Previously activated routes
    // have already moved to the coordinator's fail-closed generation.
    console.error('[built-in-proxy] Automatic initialization failed', error)
  })
  systemLifecycle = new SystemLifecycleCoordinator({
    rebuildConnections: () => rebuildGatewayConnections(store, outboundTransport),
    isOnline: () => net.isOnline()
  })
  powerMonitor.on('suspend', () => systemLifecycle.onSuspend())
  powerMonitor.on('resume', () => systemLifecycle.onResume())
  systemLifecycle.start()
  registerCodexSessionRepairApi(codexSessionRepair, codexRepairAndRestart, {
    clientConfig,
    clientProfiles: () => store.getSnapshot().clientProfiles,
  }, codexSessionIndexCleanup)
  registerClientInstanceApi(clientInstanceManager, store)
  registerCodexSessionManagerApi(codexSessionManager)
  registerPersistentTaskApi(store.getPersistentTaskRunner())
  registerUpdateApi(updateService)
  registerTunnelApi(tunnelService)
  createWindow()
  createTray()
  updateService.startAutomaticChecks()

  if (store.getSnapshot().gateway.autoStart) {
    try {
      await gateway.start()
      warmGatewayConnections(store, outboundTransport)
    } catch (error: unknown) {
      console.error('Stone+ could not auto-start the gateway', error)
    } finally {
      store.setGatewayStatus(gateway.getStatus())
    }
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      showMainWindow()
    }
  })
}

function createWindow(): void {
  const iconPath = stoneIconPath()
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f9fbfa',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: '#f9fbfa00',
        symbolColor: '#3d4a45',
        height: 38
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
  const rendererTarget = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
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
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? new URL(targetUrl).origin === new URL(rendererTarget).origin
      : targetUrl === rendererTarget
    if (!allowed) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (focusMainWindowOnReady) showMainWindow()
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(rendererTarget)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
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
        label: `${route.client === 'claude' ? 'Claude Code' : route.client === 'codex' ? 'Codex' : 'Gemini CLI'} Route`,
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
  void shutdownServices().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (!tray) app.quit()
})

if (!ownsSingleInstanceLock) {
  storeClosed = true
  app.quit()
} else {
  void bootstrap().catch((error: unknown) => {
    console.error('Stone+ failed to start', error)
    app.quit()
  })
}

function shutdownServices(): Promise<void> {
  if (storeClosed) return Promise.resolve()
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    // Every service gets its own best-effort shutdown step. In particular, a
    // failed gateway stop must not skip pending-state flushes, backup cleanup,
    // transport teardown, or the durable store close. The store is
    // intentionally the final step because most preceding services can still
    // have state to checkpoint while they are closing.
    await shutdownStep('update service', () => {
      if (!shutdownForUpdate && updateService) updateService.close()
    })
    await shutdownStep('managed client instances', async () => {
      if (clientInstanceManager) await clientInstanceManager.stopAll()
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
    await shutdownStep('built-in proxy IPC', () => {
      disposeBuiltInProxyApi?.()
      disposeBuiltInProxyApi = undefined
    })
    await shutdownStep('built-in proxy', async () => {
      if (builtInProxy) await builtInProxy.close()
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
  return shutdownPromise
}

async function shutdownStep(name: string, operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    console.error(`Stone+ could not close ${name} during graceful shutdown`, error)
  }
}
