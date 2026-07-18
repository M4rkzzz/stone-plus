import { app, BrowserWindow, Menu, nativeImage, net, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewayServer, type GatewayConfig } from './gateway'
import { ClientConfigService } from './client-config'
import { registerGatewayApi } from './ipc/gateway-api'
import { registerUpdateApi } from './ipc/update-api'
import { AppStore } from './store/app-store'
import { DatabaseBackupService } from './backup'
import { resolveChatGptCredential } from './providers'
import { OutboundTransportManager, resolveEffectiveProxy } from './proxy'
import { UpdateService } from './update'
import { FrpTunnelService } from './tunnel'
import { registerTunnelApi } from './ipc/tunnel-api'
import { CodexConversationTitleResolver } from './codex'

const { autoUpdater } = electronUpdater

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let store: AppStore
let gateway: GatewayServer
let backups: DatabaseBackupService<import('./store/types').PersistedState>
let outboundTransport: OutboundTransportManager
let updateService: UpdateService
let tunnelService: FrpTunnelService
let codexConversationTitles: CodexConversationTitleResolver
let isQuitting = false
let storeClosed = false
let shutdownForUpdate = false
let shutdownPromise: Promise<void> | undefined

if (process.env.STONE_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.STONE_USER_DATA_DIR))
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  store = new AppStore(app.getPath('userData'))
  await store.initialize()
  outboundTransport = new OutboundTransportManager()
  codexConversationTitles = new CodexConversationTitleResolver(app.getPath('home'))
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
    credentialResolver: async (account, fetchImplementation = fetch) => {
      if (account.credentialType === 'chatgpt-oauth') {
        const serialized = store.getCredential(account.credentialId)
        if (!serialized) return undefined
        const resolved = await resolveChatGptCredential(
          serialized,
          (rotated) => store.updateChatGptCredential(account.id, rotated),
          fetchImplementation
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

  registerGatewayApi(store, gateway, clientConfig, outboundTransport, backups, updateTrayMenu)
  registerUpdateApi(updateService)
  registerTunnelApi(tunnelService)
  createWindow()
  createTray()
  updateService.startAutomaticChecks()

  if (store.getSnapshot().gateway.autoStart) {
    try {
      await gateway.start()
    } catch (error: unknown) {
      console.error('Stone could not auto-start the gateway', error)
    } finally {
      store.setGatewayStatus(gateway.getStatus())
    }
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f3f5f4',
    icon: stoneIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.setMenuBarVisibility(false)
  const rendererTarget = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? new URL(targetUrl).origin === new URL(rendererTarget).origin
      : targetUrl === rendererTarget
    if (!allowed) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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
    console.warn('Stone tray icon could not be created; continuing without a tray')
    return
  }

  tray = new Tray(icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('Stone local gateway')
  updateTrayMenu()
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
}

function stoneIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : resolve('build/icon.png')
}

function updateTrayMenu(): void {
  if (!tray) return
  const snapshot = store.getSnapshot()
  tray.setToolTip(snapshot.gatewayStatus.running ? 'Stone gateway is running' : 'Stone gateway is stopped')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Stone',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
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
    if (gateway.getStatus().running) await gateway.stop()
    else {
      gateway.updateConfig(toGatewayConfig(store))
      await gateway.start()
    }
    store.setGatewayStatus(gateway.getStatus())
    updateTrayMenu()
  } catch (error) {
    console.error('Stone tray could not toggle gateway', error)
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
    console.error('Stone tray could not toggle route', error)
  }
}

function toGatewayConfig(store: AppStore): GatewayConfig {
  const snapshot = store.getSnapshot()
  return {
    providers: snapshot.providers,
    accounts: store.getRuntimeAccounts(),
    pools: snapshot.pools,
    proxies: snapshot.proxies,
    routes: snapshot.routes,
    settings: snapshot.gateway
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

void bootstrap().catch((error: unknown) => {
  console.error('Stone failed to start', error)
  app.quit()
})

function shutdownServices(): Promise<void> {
  if (storeClosed) return Promise.resolve()
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    try {
      if (!shutdownForUpdate && updateService) updateService.close()
      if (tunnelService) await tunnelService.close()
      if (gateway) await gateway.stop()
      if (backups) await backups.close()
      if (outboundTransport) await outboundTransport.close()
      if (codexConversationTitles) codexConversationTitles.close()
      if (store) await store.close()
    } catch (error: unknown) {
      console.error('Stone could not finish graceful shutdown', error)
    } finally {
      storeClosed = true
    }
  })()
  return shutdownPromise
}
