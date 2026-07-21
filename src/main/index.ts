import { app, BrowserWindow, Menu, nativeImage, net, powerMonitor, session, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewayServer, type GatewayConfig } from './gateway'
import { ClientConfigService } from './client-config'
import { rebuildGatewayConnections, registerGatewayApi, warmGatewayConnections } from './ipc/gateway-api'
import { registerUpdateApi } from './ipc/update-api'
import { AppStore } from './store/app-store'
import { DatabaseBackupService } from './backup'
import { resolveChatGptCredential } from './providers'
import { OutboundTransportManager, resolveEffectiveProxy } from './proxy'
import { UpdateService } from './update'
import { FrpTunnelService } from './tunnel'
import { registerTunnelApi } from './ipc/tunnel-api'
import {
  CodexConversationTitleResolver,
  CodexRepairAndRestartService,
  CodexSessionRepairService,
  WindowsChatGptDesktopController,
} from './codex'
import { registerCodexSessionRepairApi } from './ipc/session-repair-api'
import { BROWSER_SESSION_PARTITION, BrowserImportQueue } from './browser-import-queue'

const { autoUpdater } = electronUpdater
const WINDOWS_APP_USER_MODEL_ID = 'io.github.m4rkzzz.stoneplus'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let store: AppStore
let gateway: GatewayServer
let backups: DatabaseBackupService<import('./store/types').PersistedState>
let outboundTransport: OutboundTransportManager
let updateService: UpdateService
let tunnelService: FrpTunnelService
let codexConversationTitles: CodexConversationTitleResolver
let codexSessionRepair: CodexSessionRepairService
let codexRepairAndRestart: CodexRepairAndRestartService
let browserImportQueue: BrowserImportQueue
let isQuitting = false
let storeClosed = false
let shutdownForUpdate = false
let shutdownPromise: Promise<void> | undefined
let flushGatewayApiState: (() => Promise<void>) | undefined
let focusMainWindowOnReady = false

if (process.env.STONE_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.STONE_USER_DATA_DIR))
}

if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
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
  outboundTransport = new OutboundTransportManager({
    outboundNetworkMode: gatewaySettings.outboundNetworkMode ?? 'direct',
    localGatewayPort: gatewaySettings.port,
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
    onSystemProxyWarning: (message) => console.warn(`[system-proxy] ${message}`)
  })
  codexConversationTitles = new CodexConversationTitleResolver(app.getPath('home'))
  codexSessionRepair = new CodexSessionRepairService({ codexHome: join(app.getPath('home'), '.codex') })
  codexRepairAndRestart = new CodexRepairAndRestartService(
    codexSessionRepair,
    new WindowsChatGptDesktopController(),
  )
  await store.refreshRequestConversationTitles((conversationId) => codexConversationTitles.resolve(conversationId))
  backups = new DatabaseBackupService({
    userDataPath: app.getPath('userData'),
    store: store.getStateRepository(),
    automaticRetention: store.getSnapshot().gateway.backupRetention ?? 10
  })
  await backups.initialize()
  if (store.getSnapshot().gateway.automaticBackups !== false) backups.startAutomaticBackups()
  gateway = new GatewayServer({
    config: toGatewayConfig(store),
    credentialResolver: async (account, fetchImplementation = fetch, signal) => {
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
    outboundFetchResolver: (account, pool) => {
      const proxy = resolveEffectiveProxy(account, pool, store.getRuntimeProxies())
      return outboundTransport.fetchFor(proxy, proxy ? store.getProxyPassword(proxy.id) : undefined)
    },
    conversationTitleResolver: (conversationId) => codexConversationTitles.resolve(conversationId)
  })
  const clientConfigHome = process.env.STONE_CLIENT_CONFIG_HOME
  const clientConfig = new ClientConfigService({
    homeDir: clientConfigHome ? resolve(clientConfigHome) : app.getPath('home'),
    platform: process.platform
  })

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

  flushGatewayApiState = registerGatewayApi(store, gateway, clientConfig, outboundTransport, backups, updateTrayMenu, browserImportQueue)
  powerMonitor.on('resume', () => {
    void rebuildGatewayConnections(store, outboundTransport).catch(() => undefined)
  })
  registerCodexSessionRepairApi(codexSessionRepair, codexRepairAndRestart)
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
      appId: WINDOWS_APP_USER_MODEL_ID,
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
    try {
      if (!shutdownForUpdate && updateService) updateService.close()
      if (codexRepairAndRestart) await codexRepairAndRestart.close()
      if (tunnelService) await tunnelService.close()
      if (gateway) await gateway.stop({ force: true })
      if (flushGatewayApiState) await flushGatewayApiState()
      if (backups) await backups.close()
      if (outboundTransport) await outboundTransport.close()
      if (codexConversationTitles) codexConversationTitles.close()
      if (browserImportQueue) await browserImportQueue.close()
      if (store) await store.close()
    } catch (error: unknown) {
      console.error('Stone+ could not finish graceful shutdown', error)
    } finally {
      storeClosed = true
    }
  })()
  return shutdownPromise
}
