import { app, BrowserWindow, dialog, Menu, session, shell, type Session } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  Account,
  AppSnapshot,
  ChatGptWebWmVerificationResult,
  ChatGptWebWmVerificationStage,
  PublicProxyDefinition,
} from '@shared/types'
import {
  GPT_5_6_SOL_WM_MODEL,
  hasVerifiedChatGptWebWm,
  isChatGptWebWmPoolProtocol,
} from '@shared/wm-routing'
import { deserializeChatGptCredential, type ChatGptCredentialBundle } from './auth'
import { readBoundedResponseBuffer } from './auth/bounded-response'
import { ChatGptWebWmProtocolRuntime } from './chatgpt-web-wm'
import type { ChatGptWebWmTransportRequest } from './gateway'
import { ChatGptCredentialRefreshError, resolveChatGptCredential } from './providers/chatgpt-codex'
import { resolveEffectiveProxy, type OutboundTransportManager } from './proxy'
import type { AppStore } from './store/app-store'

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const CHATGPT_HOME = `${CHATGPT_ORIGIN}/`
const CHATGPT_LOGIN_RECOVERY = `${CHATGPT_ORIGIN}/auth/login?next=%2F`
const WEB_BRIDGE_TIMEOUT_MS = 90_000
const WEB_PROBE_TIMEOUT_MS = 10_000
const WEB_PROBE_MAX_ATTEMPTS = 4
const WEB_PROBE_RETRY_DELAYS_MS = [200, 700, 1_500] as const
const WEB_NAVIGATION_MAX_ATTEMPTS = 3
const WEB_NAVIGATION_RETRY_DELAYS_MS = [250, 800] as const
const STATUS_PAGE_MARKER = 'stone-chatgpt-web-status'
const AUTHENTICATED_LOADING_STYLE_ID = 'stone-chatgpt-authenticated-loading'
const IMAGE_VIEWER_ACTION_SCHEME = 'stone-chatgpt-image:'
const IMAGE_VIEWER_BRIDGE_KEY = '__stoneChatGptImageViewer'
const MAX_IMAGE_DOWNLOAD_BYTES = 64 * 1024 * 1024
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000
const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/26.803.41515 (Windows NT 10.0; x64)'

interface FetchPausedParameters {
  requestId: string
  request?: { url?: string }
  resourceType?: string
  responseStatusCode?: number
  responseStatusText?: string
  responseHeaders?: Array<{ name: string; value: string }>
}

interface DocumentPatchResult {
  body: string
  count: number
  recognizedApplicationDocument: boolean
}

interface WebProbeResult {
  me?: number | 'timeout' | 'network-error'
  accounts?: number | 'timeout' | 'network-error'
}

export interface ChatGptLightAccount {
  id: string
  organizationId?: string
  residencyRegion: string
  computeResidency: string
  structure: 'personal' | 'workspace'
  planType: string
  isUsageBasedSeatEnabled: boolean
  isFedrampCompliantWorkspace: boolean
  isConversationClassifierEnabledForWorkspace: boolean
  hasFloraFeature: boolean
  isDelinquent: boolean
  gracePeriodId?: string
}

interface ChatGptAccountBootstrap {
  status: NonNullable<WebProbeResult['accounts']>
  lightAccount?: ChatGptLightAccount
}

type ChatGptWebWmProbeStage = Exclude<ChatGptWebWmVerificationStage, 'persist' | 'complete'>

export type ChatGptAccountCookieMode = 'preferred' | 'account-id' | 'none'

interface ChatGptWebHistoryItem {
  id: string
  title: string
}

interface ProxyAuthentication {
  host: string
  port: number
  username?: string
  password?: string
}

interface ActiveWebLogin {
  accountId: string
  window: BrowserWindow
  electronSession: Session
  credential: ChatGptCredentialBundle
  lightAccount?: ChatGptLightAccount
  history?: ChatGptWebHistoryItem[]
  proxyAuthentication?: ProxyAuthentication
  networkRoute: string
  imageActionToken: string
  imageSaveInFlight: boolean
  debuggerAttached: boolean
  ready: boolean
  visible: boolean
  webUiReady: boolean
  webUiPreparation?: Promise<void>
  webWmRuntime?: ChatGptWebWmProtocolRuntime
  cleaned: boolean
}

interface ChatGptImageDescriptor {
  source: string
  filenameHint?: string
  width?: number
  height?: number
}

interface ChatGptImagePayload {
  buffer: Buffer
  mimeType?: string
}

export interface ChatGptWebLoginController {
  open(accountId: string): Promise<void>
  verifyWebWm(
    accountId: string,
    onProgress?: (stage: ChatGptWebWmProbeStage, percent: number) => void,
  ): Promise<ChatGptWebWmVerificationResult>
  requestWebWm(input: ChatGptWebWmTransportRequest): Promise<Response>
  dispose(): Promise<void>
}

export function primaryChatGptWebWmPrewarmAccountId(
  snapshot: Pick<AppSnapshot, 'accounts' | 'pools' | 'routes'>,
): string | undefined {
  const routedPoolIds = new Set(snapshot.routes
    .filter((route) => route.enabled)
    .map((route) => route.poolId))
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]))
  for (const pool of snapshot.pools) {
    if (!routedPoolIds.has(pool.id) || !isChatGptWebWmPoolProtocol(pool.protocol)) continue
    for (const member of pool.members) {
      if (!member.enabled) continue
      const account = accounts.get(member.accountId)
      if (!account || account.status === 'disabled' || !hasVerifiedChatGptWebWm(account)) continue
      return account.id
    }
  }
  return undefined
}

export interface ChatGptWebLoginServiceOptions {
  store: AppStore
  outboundTransport: OutboundTransportManager
  iconPath?: string
  webWmPreloadPath?: string
}

/**
 * Opens an account-isolated Chromium surface for ChatGPT web.
 * ChatGPT's public web session is not derived from the Codex OAuth token, so
 * the bridge validates the bearer online, patches the initial logged-out
 * hydration atomically, and fails closed whenever that frontend contract no
 * longer matches. No token or account state is shared between accounts. Each
 * account keeps an isolated Chromium profile. Authentication storage is
 * purged on shutdown, while public hash-addressed frontend assets remain
 * cached so the same account does not cold-download ChatGPT on every launch.
 */
export class ChatGptWebLoginService implements ChatGptWebLoginController {
  private readonly active = new Map<string, ActiveWebLogin>()
  private readonly opening = new Map<string, Promise<void>>()
  private readonly reopenAfterOpening = new Set<string>()
  private readonly historyCache = new Map<string, ChatGptWebHistoryItem[]>()
  private disposed = false

  constructor(private readonly options: ChatGptWebLoginServiceOptions) {}

  public async open(accountId: string): Promise<void> {
    if (this.disposed) throw new Error('Stone+ 正在退出，无法打开 ChatGPT 网页。')
    const pending = this.opening.get(accountId)
    if (pending) {
      const context = this.active.get(accountId)
      if (context && !context.window.isDestroyed()) {
        this.showContext(context)
        void pending.then(async () => {
          const ready = this.active.get(accountId)
          if (!ready || ready.window.isDestroyed()) return
          await this.ensureVisibleWebUi(ready)
        }).catch(async (error) => {
          const failed = this.active.get(accountId)
          if (failed && !failed.window.isDestroyed()) await this.showFailure(failed, error)
        })
      } else if (!this.reopenAfterOpening.has(accountId)) {
        this.reopenAfterOpening.add(accountId)
        void pending.finally(() => {
          this.reopenAfterOpening.delete(accountId)
          if (!this.disposed && !this.active.has(accountId)) void this.open(accountId).catch(() => undefined)
        })
      }
      return
    }
    const existing = this.active.get(accountId)
    if (existing && !existing.window.isDestroyed()) {
      this.showContext(existing)
      void this.ensureVisibleWebUi(existing).catch(async (error) => {
        if (!existing.window.isDestroyed()) await this.showFailure(existing, error)
      })
      return
    }
    const selected = this.readSelectedAccount(accountId)
    const operation = this.startOpening(selected.account, selected.serialized, selected.credential, true)
    void operation.catch(async (error) => {
      const context = this.active.get(accountId)
      if (!context || context.window.isDestroyed()) return
      await this.showFailure(context, error)
    })
    // The account action must not stay busy while Chromium, Cloudflare or a
    // remote proxy is warming up. The owned window is created synchronously
    // before openFresh reaches its first await and reports progress itself.
  }

  public async requestWebWm(input: ChatGptWebWmTransportRequest): Promise<Response> {
    try {
      const context = await this.ensureTransportContext(input.account.id)
      if (context.accountId !== input.account.id) {
        throw new Error('Web WM account isolation check failed.')
      }
      this.synchronizeTransportCredential(context, input.credential)
      const runtime = await this.ensureWebWmRuntime(context)
      return input.operation === 'search'
        ? await runtime.search(input.body, context.credential.accessToken, input.signal)
        : await runtime.responses(input.body, context.credential.accessToken, input.signal)
    } catch (error) {
      if (input.signal.aborted) throw error
      return webWmTransportErrorResponse(502, 'web_wm_transport_failed', safeWebWmErrorMessage(error))
    }
  }

  public async prewarmWebWm(accountId: string): Promise<void> {
    const selectedId = accountId.trim()
    if (!selectedId || this.disposed) return
    const context = await this.ensureTransportContext(selectedId)
    const runtime = await this.ensureWebWmRuntime(context)
    await runtime.prewarm()
  }

  public async verifyWebWm(
    accountId: string,
    onProgress?: (stage: ChatGptWebWmProbeStage, percent: number) => void,
  ): Promise<ChatGptWebWmVerificationResult> {
    const selectedId = accountId.trim()
    if (!selectedId) throw new Error('Web WM verification requires an account.')
    const signal = AbortSignal.timeout(180_000)
    try {
      onProgress?.('session', 8)
      const context = await this.ensureTransportContext(selectedId)
      signal.throwIfAborted()
      onProgress?.('identity', 40)
      if (context.accountId !== selectedId) throw new Error('Web WM account isolation check failed.')
      onProgress?.('catalog', 50)
      const catalog = await this.verifyWebWmCatalog(context, signal)
      onProgress?.('protocol', 62)
      const runtime = await this.ensureWebWmRuntime(context)
      const turn = await runtime.probe(
        context.credential.accessToken,
        signal,
        () => onProgress?.('turn', 78),
      )
      return { ...turn, ...catalog }
    } catch (error) {
      if (signal.aborted) throw new Error('Web WM verification timed out after 180 seconds.')
      throw error
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    const contexts = [...this.active.values()]
    this.active.clear()
    await Promise.allSettled(contexts.map((context) => this.cleanup(context, true, true)))
    await Promise.allSettled([...this.opening.values()])
  }

  private async openFresh(
    account: Account,
    serialized: string,
    initialCredential: ChatGptCredentialBundle,
    showWindow: boolean,
  ): Promise<void> {
    const accountId = account.id
    const fetchImplementation = this.accountFetch(account)
    const electronSession = session.fromPartition(
      `persist:stone-chatgpt-web-${accountPartitionKey(account.id)}`,
      { cache: true },
    )
    const context: ActiveWebLogin = {
      accountId,
      electronSession,
      credential: initialCredential,
      history: this.historyCache.get(accountId),
      window: new BrowserWindow({
        width: 1_220,
        height: 820,
        minWidth: 860,
        minHeight: 620,
        show: false,
        backgroundColor: '#ffffff',
        title: `ChatGPT · ${account.name}`,
        ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
        webPreferences: {
          session: electronSession,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
          devTools: false,
          spellcheck: true,
        },
      }),
      networkRoute: 'unconfigured',
      imageActionToken: randomBytes(24).toString('hex'),
      imageSaveInFlight: false,
      debuggerAttached: false,
      ready: false,
      visible: showWindow,
      webUiReady: false,
      cleaned: false,
    }
    this.active.set(accountId, context)
    context.window.setMenuBarVisibility(false)
    context.window.webContents.setUserAgent(chatGptUserAgent())
    void context.window.loadURL(statusPageUrl(account.name, '正在建立账号专属安全会话…'))
    if (showWindow) this.showContext(context)
    this.installMediaPermissions(context)
    this.installNavigationGuards(context)
    context.window.once('closed', () => { void this.cleanup(context, false, false) })

    let resolved
    try {
        resolved = await resolveChatGptCredential(
          serialized,
          (rotated, expectedSource) => this.options.store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
          fetchImplementation,
          Date.now(),
          {
            refreshKey: account.id,
            timeoutMs: WEB_PROBE_TIMEOUT_MS,
            backgroundRefreshWindowMs: 0,
            blockingRefreshWindowMs: 0,
          },
        )
        assertSelectedChatGptAccount(account, resolved.bundle)
        context.credential = resolved.bundle
    } catch (error) {
      throw webCredentialError(error)
    }
    await electronSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    })
    context.proxyAuthentication = await this.configureSessionProxy(context.electronSession, account)
    // setProxy() only governs future requests. Reload Chromium's proxy
    // configuration and drain any socket created by the status document before
    // the authenticated probes start, so the first probe cannot race an old
    // direct/system route.
    await electronSession.forceReloadProxyConfig()
    await electronSession.closeAllConnections()
    this.installProxyAuthentication(context)
    this.installAuthorizationHeader(context)
    let { accountBootstrap, probe } = await this.loadWebProbeWithRecovery(context)
    if (probeNeedsRefresh(probe)) {
      try {
        // Re-read before recovery. A concurrent gateway request may already
        // have rotated the refresh token after this web probe used the old
        // access token.
        const latestSerialized = this.options.store.getCredential(account.credentialId) ?? resolved.serialized
        const latestCredential = deserializeChatGptCredential(latestSerialized)
        if (!latestCredential) throw new Error('ChatGPT account credential is invalid.')
        resolved = await resolveChatGptCredential(
          latestSerialized,
          (rotated, expectedSource) => this.options.store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
          fetchImplementation,
          Date.now(),
          {
            refreshKey: account.id,
            timeoutMs: WEB_PROBE_TIMEOUT_MS,
            backgroundRefreshWindowMs: 0,
            blockingRefreshWindowMs: 0,
            forceRefresh: latestCredential.accessToken === context.credential.accessToken,
          },
        )
        assertSelectedChatGptAccount(account, resolved.bundle)
        context.credential = resolved.bundle
        ;({ accountBootstrap, probe } = await this.loadWebProbeWithRecovery(context))
      } catch (error) {
        throw webCredentialError(error)
      }
    }
    assertUsableWebProbe(probe, context.networkRoute)
    if (!accountBootstrap.lightAccount) {
      throw new Error('当前 OAuth 凭据中找不到所选 ChatGPT 账号或工作区，请重新授权该账号。')
    }
    context.lightAccount = accountBootstrap.lightAccount
    await this.installAccountSelectionCookies(electronSession, context.credential, context.lightAccount)
    if (showWindow) await this.ensureVisibleWebUi(context)
    if (this.disposed || context.window.isDestroyed()) throw new Error('Stone+ 正在退出，无法打开 ChatGPT 网页。')
    context.ready = true
  }

  private ensureVisibleWebUi(context: ActiveWebLogin): Promise<void> {
    if (context.webUiReady) return Promise.resolve()
    if (context.webUiPreparation) return context.webUiPreparation
    const operation = this.prepareVisibleWebUi(context).finally(() => {
      if (context.webUiPreparation === operation) context.webUiPreparation = undefined
    })
    context.webUiPreparation = operation
    return operation
  }

  private async prepareVisibleWebUi(context: ActiveWebLogin): Promise<void> {
    if (context.cleaned || context.window.isDestroyed()) {
      throw new Error('ChatGPT 网页会话已经关闭。')
    }
    const bridge = this.installAuthenticatedBridge(context)
    const history = this.refreshHistory(context)
    await bridge
    context.history = await history
    this.historyCache.set(context.accountId, context.history)
    await this.installStableSidebarHistory(context, context.history)
    await context.window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(AUTHENTICATED_LOADING_STYLE_ID)})?.remove()`).catch(() => undefined)
    if (context.cleaned || context.window.isDestroyed()) {
      throw new Error('ChatGPT 网页会话已经关闭。')
    }
    context.webUiReady = true
  }

  private readSelectedAccount(accountId: string): {
    account: Account
    serialized: string
    credential: ChatGptCredentialBundle
  } {
    const account = this.options.store.getRuntimeAccount(accountId)
    if (!account) throw new Error('账号不存在或已被删除。')
    if (account.credentialType !== 'chatgpt-oauth') {
      throw new Error('仅 ChatGPT OAuth 账号支持网页登录。')
    }
    const serialized = this.options.store.getCredential(account.credentialId)
    if (!serialized) throw new Error('无法读取该 ChatGPT OAuth 凭据。')
    const credential = deserializeChatGptCredential(serialized)
    if (!credential) throw new Error('ChatGPT OAuth 凭据格式无效，请重新授权该账号。')
    return { account, serialized, credential }
  }

  private startOpening(
    account: Account,
    serialized: string,
    credential: ChatGptCredentialBundle,
    showWindow: boolean,
  ): Promise<void> {
    const operation = this.openFresh(account, serialized, credential, showWindow).finally(() => {
      if (this.opening.get(account.id) === operation) this.opening.delete(account.id)
    })
    this.opening.set(account.id, operation)
    return operation
  }

  private async ensureTransportContext(accountId: string): Promise<ActiveWebLogin> {
    if (this.disposed) throw new Error('Stone+ is shutting down.')
    let pending = this.opening.get(accountId)
    let context = this.active.get(accountId)
    if (!pending && context?.ready && !context.window.isDestroyed()) return context
    if (!pending) {
      if (context) await this.cleanup(context, true, false)
      const selected = this.readSelectedAccount(accountId)
      pending = this.startOpening(selected.account, selected.serialized, selected.credential, false)
    }
    await pending
    context = this.active.get(accountId)
    if (!context?.ready || context.window.isDestroyed()) {
      throw new Error('ChatGPT Web WM account session did not become ready.')
    }
    return context
  }

  private synchronizeTransportCredential(
    context: ActiveWebLogin,
    credential: ChatGptWebWmTransportRequest['credential'],
  ): void {
    if (!credential.accessToken.trim()) throw new Error('Web WM OAuth access token is unavailable.')
    if (credential.accountId !== context.credential.accountId) {
      throw new Error('Web WM OAuth account identity changed during the active session.')
    }
    if (credential.accessToken === context.credential.accessToken) return
    context.credential = {
      ...context.credential,
      accessToken: credential.accessToken,
    }
  }

  private showContext(context: ActiveWebLogin): void {
    context.visible = true
    if (context.window.isMinimized()) context.window.restore()
    context.window.show()
    context.window.focus()
  }

  private async ensureWebWmRuntime(context: ActiveWebLogin): Promise<ChatGptWebWmProtocolRuntime> {
    if (context.webWmRuntime) {
      await context.webWmRuntime.initialize()
      return context.webWmRuntime
    }
    const captured = await context.window.webContents.executeJavaScript(`(() => {
      const valid = (value) => value && typeof value === 'object' && !Array.isArray(value)
      let bootstrapState = null
      const element = document.getElementById('client-bootstrap')
      if (element?.textContent) {
        try {
          const parsed = JSON.parse(element.textContent)
          if (valid(parsed)) bootstrapState = parsed
        } catch {}
      }
      if (!bootstrapState && valid(globalThis.CLIENT_BOOTSTRAP)) {
        bootstrapState = JSON.parse(JSON.stringify(globalThis.CLIENT_BOOTSTRAP))
      }
      const assets = new Set()
      const add = (value) => {
        try {
          const url = new URL(value, location.href)
          if (url.origin === location.origin && /\\.js(?:$|\\?)/i.test(url.href)) assets.add(url.href)
        } catch {}
      }
      document.querySelectorAll('script[src]').forEach((script) => add(script.src))
      performance.getEntriesByType('resource').forEach((entry) => add(entry.name))
      return { bootstrapState, assets: [...assets].slice(0, 140) }
    })()`)
    const bootstrapState = authenticatedBootstrapState(
      captured?.bootstrapState,
      context.credential,
      context.lightAccount,
    )
    const runtime = new ChatGptWebWmProtocolRuntime({
      electronSession: context.electronSession,
      bootstrapState,
      preloadPath: this.options.webWmPreloadPath,
      seedAssetUrls: Array.isArray(captured?.assets)
        ? captured.assets.filter((value: unknown): value is string => typeof value === 'string')
        : [],
    })
    context.webWmRuntime = runtime
    try {
      await runtime.initialize()
      return runtime
    } catch (error) {
      runtime.dispose()
      if (context.webWmRuntime === runtime) context.webWmRuntime = undefined
      throw error
    }
  }

  private accountFetch(account: Pick<Account, 'proxyId'>): typeof fetch {
    const proxy = resolveEffectiveProxy(account, undefined, this.options.store.getSnapshot().proxies)
    return this.options.outboundTransport.fetchFor(
      proxy,
      proxy ? this.options.store.getProxyPassword(proxy.id) : undefined,
    )
  }

  private async installAccountSelectionCookies(
    electronSession: Session,
    credential: ChatGptCredentialBundle,
    lightAccount?: ChatGptLightAccount,
    mode: ChatGptAccountCookieMode = 'preferred',
  ): Promise<void> {
    const accessAuth = objectClaim(jwtClaims(credential.accessToken)['https://api.openai.com/auth'])
    const planType = stringClaim(accessAuth.chatgpt_plan_type)?.toLowerCase()
    const accountCookie = chatGptAccountCookieValue(credential, lightAccount, planType, mode)
    const computeResidency = lightAccount?.computeResidency
      ?? stringClaim(accessAuth.chatgpt_compute_residency)
      ?? 'no_constraint'
    await Promise.all([
      accountCookie ? electronSession.cookies.set({
        url: CHATGPT_ORIGIN,
        name: '_account',
        value: accountCookie,
        path: '/',
        secure: true,
        sameSite: 'lax',
      }) : electronSession.cookies.remove(CHATGPT_ORIGIN, '_account'),
      electronSession.cookies.set({
        url: CHATGPT_ORIGIN,
        name: '_account_residency_region',
        value: computeResidency,
        path: '/',
        secure: true,
        sameSite: 'lax',
      }),
    ])
  }

  private async configureSessionProxy(electronSession: Session, account: Account): Promise<ProxyAuthentication | undefined> {
    const effective = this.options.outboundTransport.builtInRoutes.getSnapshot().effectiveRoute
    if (effective.kind === 'blocked') throw new Error('内置代理当前不可用，已阻止 ChatGPT 网页直连。')
    if (effective.kind === 'built-in-mixed') {
      if (!effective.mixedPort) throw new Error('内置代理 mixed 端口不可用。')
      await electronSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http://127.0.0.1:${effective.mixedPort}`,
        proxyBypassRules: '<local>,localhost,127.0.0.1,[::1]',
      })
      const context = this.active.get(account.id)
      if (context) context.networkRoute = 'built-in-mixed'
      return undefined
    }
    if (effective.kind === 'built-in-tun') {
      await electronSession.setProxy({ mode: 'direct' })
      const context = this.active.get(account.id)
      if (context) context.networkRoute = 'built-in-tun'
      return undefined
    }

    const proxy = resolveEffectiveProxy(account, undefined, this.options.store.getSnapshot().proxies)
    if (proxy) {
      const password = this.options.store.getProxyPassword(proxy.id)
      if (proxy.hasPassword && !password) throw new Error('代理密码无法从凭据保险库读取。')
      await electronSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: chromiumProxyRule(proxy),
        proxyBypassRules: '<local>,localhost,127.0.0.1,[::1]',
      })
      const context = this.active.get(account.id)
      if (context) context.networkRoute = `account-${proxy.protocol}`
      return {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password,
      }
    }
    const mode = effective.externalMode ?? this.options.store.getRuntimeGatewaySettings().outboundNetworkMode ?? 'direct'
    await electronSession.setProxy({ mode: mode === 'system' ? 'system' : 'direct' })
    const context = this.active.get(account.id)
    if (context) context.networkRoute = mode === 'system' ? 'system' : 'direct'
    return undefined
  }

  private installProxyAuthentication(context: ActiveWebLogin): void {
    context.window.webContents.on('login', (event, _details, authInfo, callback) => {
      const configured = context.proxyAuthentication
      if (!configured || !authInfo.isProxy || !sameProxyEndpoint(authInfo.host, authInfo.port, configured)) return
      event.preventDefault()
      callback(configured.username ?? '', configured.password ?? '')
    })
  }

  private installMediaPermissions(context: ActiveWebLogin): void {
    context.window.webContents.setAudioMuted(false)
    context.electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const request = details as Electron.MediaAccessPermissionRequest
      callback(
        webContents === context.window.webContents
        && isAllowedChatGptMediaPermission(permission, request.requestingUrl, request.mediaTypes),
      )
    })
    context.electronSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
      webContents === context.window.webContents
      && isAllowedChatGptMediaPermissionCheck(
        permission,
        details.requestingUrl ?? details.securityOrigin ?? requestingOrigin,
        details.mediaType,
      )
    ))
  }

  private installAuthorizationHeader(context: ActiveWebLogin): void {
    context.electronSession.webRequest.onBeforeSendHeaders(
      { urls: [`${CHATGPT_ORIGIN}/backend-api/*`, 'wss://chatgpt.com/backend-api/*'] },
      (details, callback) => {
        const requestHeaders = applyChatGptWebIdentityHeaders(details.requestHeaders, context.credential)
        if (details.webContentsId === context.webWmRuntime?.webContentsId) {
          for (const key of Object.keys(requestHeaders)) {
            if (key.toLowerCase() === 'originator' || key.toLowerCase() === 'user-agent') {
              delete requestHeaders[key]
            }
          }
          requestHeaders.originator = 'Codex Desktop'
          requestHeaders['User-Agent'] = CODEX_DESKTOP_USER_AGENT
        }
        callback({
          requestHeaders,
        })
      },
    )
  }

  private async fetchAccountBootstrap(context: ActiveWebLogin): Promise<ChatGptAccountBootstrap> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEB_PROBE_TIMEOUT_MS)
    try {
      const response = await context.electronSession.fetch(
        `${CHATGPT_ORIGIN}/backend-api/accounts/check/v4-2023-04-27`,
        {
          cache: 'no-store',
          headers: applyChatGptWebIdentityHeaders({ Accept: 'application/json' }, context.credential),
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { status: response.status }
      }
      const value = await response.json().catch(() => undefined)
      return {
        status: response.status,
        lightAccount: parseChatGptLightAccount(value, context.credential.accountId, { requireExact: true }),
      }
    } catch (error) {
      return {
        status: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network-error',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async verifyWebWmCatalog(
    context: ActiveWebLogin,
    signal: AbortSignal,
  ): Promise<Pick<ChatGptWebWmVerificationResult,
    'catalogModel' | 'workspacePlanType' | 'workspaceStructure'>> {
    const lightAccount = context.lightAccount
    if (!lightAccount || lightAccount.id !== context.credential.accountId) {
      throw new Error('Web WM verification could not confirm the exact ChatGPT workspace identity.')
    }
    const response = await context.electronSession.fetch(`${CHATGPT_ORIGIN}/backend-api/tpp/models/`, {
      cache: 'no-store',
      headers: applyChatGptWebIdentityHeaders({ Accept: 'application/json' }, context.credential),
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `This ChatGPT workspace does not expose the ${GPT_5_6_SOL_WM_MODEL} model catalog (HTTP ${response.status}).`,
      )
    }
    const catalogModel = chatGptWebWmCatalogModel(await response.json().catch(() => undefined))
    if (!catalogModel) {
      throw new Error(`This ChatGPT workspace does not list ${GPT_5_6_SOL_WM_MODEL} as a Work model.`)
    }
    return {
      catalogModel,
      workspacePlanType: lightAccount.planType,
      workspaceStructure: lightAccount.structure,
    }
  }

  private async loadWebProbe(context: ActiveWebLogin): Promise<{
    accountBootstrap: ChatGptAccountBootstrap
    probe: WebProbeResult
  }> {
    const [accountBootstrap, me] = await Promise.all([
      this.fetchAccountBootstrap(context),
      this.probeMe(context),
    ])
    return { accountBootstrap, probe: { me, accounts: accountBootstrap.status } }
  }

  private async loadWebProbeWithRecovery(context: ActiveWebLogin): Promise<{
    accountBootstrap: ChatGptAccountBootstrap
    probe: WebProbeResult
  }> {
    let latest = await this.loadWebProbe(context)
    for (let attempt = 1; attempt < WEB_PROBE_MAX_ATTEMPTS && probeNeedsTransientRetry(latest.probe); attempt += 1) {
      if (context.cleaned || context.window.isDestroyed()) return latest
      // These operations are deliberately ordered: first publish the current
      // proxy configuration, then make sure no request can reuse a connection
      // that was opened with the previous route.
      await context.electronSession.forceReloadProxyConfig().catch(() => undefined)
      await context.electronSession.closeAllConnections().catch(() => undefined)
      await waitForRetry(WEB_PROBE_RETRY_DELAYS_MS[attempt - 1] ?? 480)
      if (context.cleaned || context.window.isDestroyed()) return latest
      latest = await this.loadWebProbe(context)
    }
    return latest
  }

  private async probeMe(context: ActiveWebLogin): Promise<NonNullable<WebProbeResult['me']>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEB_PROBE_TIMEOUT_MS)
    try {
      const response = await context.electronSession.fetch(`${CHATGPT_ORIGIN}/backend-api/me`, {
        cache: 'no-store',
        headers: applyChatGptWebIdentityHeaders({ Accept: 'application/json' }, context.credential),
        signal: controller.signal,
      })
      await response.body?.cancel().catch(() => undefined)
      return response.status
    } catch (error) {
      return error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network-error'
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchHistory(context: ActiveWebLogin): Promise<ChatGptWebHistoryItem[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEB_PROBE_TIMEOUT_MS)
    try {
      const response = await context.electronSession.fetch(
        `${CHATGPT_ORIGIN}/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`,
        {
          cache: 'no-store',
          headers: applyChatGptWebIdentityHeaders({ Accept: 'application/json' }, context.credential),
          signal: controller.signal,
        },
      )
      if (!response.ok) return context.history ?? []
      const body = await response.json() as { items?: unknown }
      if (!Array.isArray(body.items)) return context.history ?? []
      return body.items.flatMap((entry): ChatGptWebHistoryItem[] => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
        const item = entry as Record<string, unknown>
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!id || !title || id.length > 160 || title.length > 500) return []
        return [{ id, title }]
      })
    } catch {
      return context.history ?? []
    } finally {
      clearTimeout(timer)
    }
  }

  private refreshHistory(context: ActiveWebLogin): Promise<ChatGptWebHistoryItem[]> {
    const operation = this.fetchHistory(context)
    void operation.then(async (items) => {
      if (context.cleaned || context.window.isDestroyed()) return
      context.history = items
      this.historyCache.set(context.accountId, items)
      const installed = await this.installStableSidebarHistory(context, items)
      if (!installed || context.window.isDestroyed()) return
      await context.window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(AUTHENTICATED_LOADING_STYLE_ID)})?.remove()`).catch(() => undefined)
    })
    return operation
  }

  private async installStableSidebarHistory(
    context: ActiveWebLogin,
    history: ChatGptWebHistoryItem[],
  ): Promise<boolean> {
    if (context.window.isDestroyed()) return false
    const serialized = scriptJson(history)
    const installed = await context.window.webContents.executeJavaScript(`new Promise((resolve) => {
      const bridgeKey = '__stoneChatGptHistoryBridge'
      const items = ${serialized}
      const previous = window[bridgeKey]
      if (previous && typeof previous.disconnect === 'function') previous.disconnect()
      let queued = false
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(value)
      }
      const render = () => {
        queued = false
        const nav = Array.from(document.querySelectorAll('nav')).find((candidate) => (
          candidate.querySelector('[data-testid="close-sidebar-button"]')
        ))
        if (!nav) return
        const existing = nav.querySelector('[data-stone-chatgpt-history]')
        const officialHistory = Array.from(nav.querySelectorAll('a[href^="/c/"]')).some((anchor) => (
          !anchor.closest('[data-stone-chatgpt-history]')
        ))
        if (officialHistory || items.length === 0) {
          existing?.remove()
          finish(true)
          return
        }
        if (existing) {
          finish(true)
          return
        }
        const host = Array.from(nav.children).find((child) => child.classList.contains('grow')) || nav
        const section = document.createElement('section')
        section.dataset.stoneChatgptHistory = 'true'
        section.style.cssText = 'padding:14px 8px 8px;min-width:0'
        const heading = document.createElement('div')
        heading.textContent = '最近对话'
        heading.style.cssText = 'padding:0 10px 7px;color:var(--text-tertiary);font-size:12px;font-weight:600'
        section.appendChild(heading)
        for (const item of items) {
          const link = document.createElement('a')
          link.href = '/c/' + encodeURIComponent(item.id)
          link.dataset.sidebarItem = 'true'
          link.className = 'group __menu-item hoverable keyboard-focused:focus-ring keyboard-focused:-outline-offset-2'
          link.style.cssText = 'display:block;min-width:0'
          link.title = item.title
          link.addEventListener('click', (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            const router = window.__reactRouterDataRouter
            if (!router || typeof router.navigate !== 'function') return
            event.preventDefault()
            void router.navigate(link.pathname)
          })
          const label = document.createElement('div')
          label.textContent = item.title
          label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          link.appendChild(label)
          section.appendChild(link)
        }
        host.prepend(section)
        finish(true)
      }
      const schedule = () => {
        if (queued) return
        queued = true
        queueMicrotask(render)
      }
      const observer = new MutationObserver((mutations) => {
        const sidebarChanged = mutations.some((mutation) => {
          const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
          if (target?.closest('nav')) return true
          return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
            node instanceof Element && (
              node.matches('[data-stone-chatgpt-history],nav')
              || node.querySelector('[data-stone-chatgpt-history],[data-testid="close-sidebar-button"]')
            )
          ))
        })
        if (sidebarChanged) schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      window[bridgeKey] = { disconnect: () => observer.disconnect() }
      const deadline = setTimeout(() => finish(false), 8_000)
      render()
    })`).catch(() => false)
    return installed === true
  }

  private async installAuthenticatedBridge(context: ActiveWebLogin): Promise<void> {
    const debuggerApi = context.window.webContents.debugger
    let unauthenticatedAppRetries = 0
    const unauthenticatedShellDiagnostics: string[] = []
    let patchedApplicationDocuments = 0
    let navigationGeneration = 0
    let resolvePatched: (() => void) | undefined
    let rejectPatched: ((error: Error) => void) | undefined
    let resolvePatchedDomReady: (() => void) | undefined
    const patched = new Promise<void>((resolve, reject) => {
      resolvePatched = resolve
      rejectPatched = reject
    })
    const patchedDomReady = new Promise<void>((resolve) => {
      resolvePatchedDomReady = resolve
    })
    const fail = (error: Error) => {
      rejectPatched?.(error)
      rejectPatched = undefined
      resolvePatched = undefined
    }
    const onDomReady = () => {
      // The retry/status documents are intentionally allowed to become ready.
      // Startup is complete only when the document whose authenticated state we
      // actually patched reaches DOM readiness.
      if (patchedApplicationDocuments > 0) {
        resolvePatchedDomReady?.()
        resolvePatchedDomReady = undefined
      }
    }
    context.window.webContents.on('dom-ready', onDomReady)
    const navigate = (target: string, failureMessage: string, attempt = 0): void => {
      const generation = ++navigationGeneration
      void context.window.loadURL(target, {
        extraHeaders: 'Cache-Control: no-cache\r\nPragma: no-cache',
      }).catch(async (error) => {
        // A recovery navigation deliberately supersedes the previous loadURL.
        // Electron rejects that older promise; only the current generation is
        // allowed to turn a navigation failure into a bridge failure.
        if (generation !== navigationGeneration || context.window.isDestroyed()) return
        const classification = classifyChatGptNavigationError(error)
        // Chromium reports ERR_ABORTED when the page itself replaces the
        // navigation. The debugger bridge remains authoritative in that case.
        if (classification === 'aborted') return
        if (classification === 'transient' && attempt + 1 < WEB_NAVIGATION_MAX_ATTEMPTS) {
          await context.electronSession.forceReloadProxyConfig().catch(() => undefined)
          await context.electronSession.closeAllConnections().catch(() => undefined)
          await waitForRetry(WEB_NAVIGATION_RETRY_DELAYS_MS[attempt] ?? 800)
          if (generation !== navigationGeneration || context.window.isDestroyed()) return
          navigate(target, failureMessage, attempt + 1)
          return
        }
        fail(new Error(failureMessage))
      })
    }
    debuggerApi.on('message', (_event, method, rawParameters) => {
      if (method !== 'Fetch.requestPaused') return
      const parameters = rawParameters as FetchPausedParameters
      const requestId = parameters.requestId
      const target = parameters.request?.url ?? ''
      if (
        parameters.resourceType === 'Document'
        && parameters.responseStatusCode
        && parameters.responseStatusCode >= 200
        && parameters.responseStatusCode < 300
        && isAllowedChatGptWebUrl(target)
      ) {
        void debuggerApi.sendCommand('Fetch.getResponseBody', { requestId }).then(async ({ body, base64Encoded }) => {
          const decoded = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : String(body)
          const result = patchChatGptAuthenticatedDocument(decoded, context.credential, {
            // The mask prevents the anonymous shell from flashing during the
            // first authenticated bootstrap. ChatGPT can immediately perform a
            // full-page account refresh after comparing the light and full
            // account records; masking that follow-up document can leave the
            // already usable page visually blank if the refresh is interrupted.
            includeLoadingMask: patchedApplicationDocuments === 0,
            lightAccount: context.lightAccount,
          })
          if (result.count === 0) {
            if (isChatGptUnauthenticatedApp(decoded)) {
              unauthenticatedShellDiagnostics.push(chatGptShellDiagnostic({
                attempt: unauthenticatedAppRetries,
                source: decoded,
                target,
                status: parameters.responseStatusCode,
                structure: context.lightAccount?.structure,
                planType: context.lightAccount?.planType,
                edgeRay: responseHeaderValue(parameters.responseHeaders, 'cf-ray'),
              }))
              const recovery = chatGptUnauthenticatedShellRecovery(unauthenticatedAppRetries)
              if (!recovery) {
                await debuggerApi.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
                fail(new Error(`ChatGPT 持续返回匿名网页壳，Stone+ 已阻止账号状态降级。诊断码：${unauthenticatedShellDiagnostics.join(' > ')}`))
                return
              }
              unauthenticatedAppRetries += 1
              await this.installAccountSelectionCookies(
                context.electronSession,
                context.credential,
                context.lightAccount,
                recovery.accountCookieMode,
              )
              await debuggerApi.sendCommand('Fetch.fulfillRequest', {
                requestId,
                responseCode: 200,
                responseHeaders: [
                  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                  { name: 'Cache-Control', value: 'no-store' },
                ],
                body: Buffer.from(chatGptRetryDocument()).toString('base64'),
              })
              await context.electronSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
              await context.electronSession.clearCache()
              await context.electronSession.forceReloadProxyConfig().catch(() => undefined)
              await context.electronSession.closeAllConnections().catch(() => undefined)
              if (!context.window.isDestroyed()) navigate(recovery.target, 'ChatGPT 网页匿名缓存恢复失败。')
              return
            }
            if (result.recognizedApplicationDocument) {
              await debuggerApi.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
              fail(new Error('ChatGPT 网页认证结构已变化，Stone+ 已阻止匿名回退。'))
              return
            }
            // Cloudflare and other same-origin bootstrap documents do not carry
            // ChatGPT's client state. Let Chromium finish them and wait for the
            // real application document instead of reporting a false contract
            // change. The window remains hidden until a patched document and
            // the synthetic session endpoint both pass validation.
            if (isChatGptSecurityInterstitial(decoded) && context.visible && !context.window.isDestroyed()) {
              this.showContext(context)
            }
            await debuggerApi.sendCommand('Fetch.continueRequest', { requestId })
            return
          }
          const headers = (parameters.responseHeaders ?? []).filter((header) => (
            !/^(?:content-length|content-encoding|transfer-encoding|cache-control|etag)$/i.test(header.name)
          ))
          headers.push({ name: 'Cache-Control', value: 'no-store' })
          await debuggerApi.sendCommand('Fetch.fulfillRequest', {
            requestId,
            responseCode: parameters.responseStatusCode,
            responsePhrase: parameters.responseStatusText || 'OK',
            responseHeaders: headers,
            body: Buffer.from(result.body).toString('base64'),
          })
          patchedApplicationDocuments += 1
          resolvePatched?.()
          resolvePatched = undefined
          rejectPatched = undefined
        }).catch(async () => {
          await debuggerApi.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => undefined)
          fail(new Error('无法建立 ChatGPT 网页认证桥。'))
        })
        return
      }
      if (target.startsWith(`${CHATGPT_ORIGIN}/api/auth/session`)) {
        const sessionBody = Buffer.from(JSON.stringify(syntheticSession(
          context.credential,
          context.lightAccount,
        ))).toString('base64')
        void debuggerApi.sendCommand('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: sessionBody,
        }).catch(() => undefined)
        return
      }
      void debuggerApi.sendCommand('Fetch.continueRequest', { requestId }).catch(() => undefined)
    })
    debuggerApi.attach('1.3')
    context.debuggerAttached = true
    await debuggerApi.sendCommand('Network.enable')
    await debuggerApi.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })
    await debuggerApi.sendCommand('Fetch.enable', {
      patterns: [
        { urlPattern: `${CHATGPT_ORIGIN}/*`, resourceType: 'Document', requestStage: 'Response' },
        { urlPattern: `${CHATGPT_ORIGIN}/api/auth/session*`, requestStage: 'Request' },
      ],
    })
    navigate(CHATGPT_HOME, 'ChatGPT 网页加载失败。')
    try {
      await Promise.all([
        withTimeout(patchedDomReady, WEB_BRIDGE_TIMEOUT_MS, 'ChatGPT 网页认证文档加载超时；若页面显示安全验证，请完成后重试。'),
        withTimeout(patched, WEB_BRIDGE_TIMEOUT_MS, 'ChatGPT 网页认证桥启动超时；若页面显示安全验证，请完成后重试。'),
      ])
    } finally {
      context.window.webContents.removeListener('dom-ready', onDomReady)
    }
    const authenticated = await context.window.webContents.executeJavaScript(`fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' }).then(async (response) => {
      const value = await response.json().catch(() => null)
      return response.status === 200 && Boolean(value?.user) && typeof value?.accessToken === 'string'
    }).catch(() => false)`)
    if (authenticated !== true) throw new Error('ChatGPT 网页未能进入登录状态。')
    await context.window.webContents.executeJavaScript(`(() => {
      if (!location.pathname.startsWith('/auth/login')) return true
      const router = window.__reactRouterDataRouter
      if (!router || typeof router.navigate !== 'function') return false
      return Promise.resolve(router.navigate('/')).then(() => true).catch(() => false)
    })()`).catch(() => false)
    await debuggerApi.sendCommand('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined)
    if (process.env.STONE_CHATGPT_WEB_DIAGNOSTICS === '1') void this.reportAuthenticatedState(context)
  }

  private async reportAuthenticatedState(context: ActiveWebLogin): Promise<void> {
    if (context.window.isDestroyed()) return
    const result = await context.window.webContents.executeJavaScript(`Promise.all([
      fetch('/backend-api/accounts/check/v4-2023-04-27', { cache: 'no-store' }).then(async (response) => ({ name: 'accounts', status: response.status, body: await response.json().catch(() => null) })),
      fetch('/backend-api/conversations?offset=0&limit=1', { cache: 'no-store' }).then(async (response) => ({ name: 'conversations', status: response.status, body: await response.json().catch(() => null) })),
      fetch('/backend-api/models', { cache: 'no-store' }).then(async (response) => ({ name: 'models', status: response.status, body: await response.json().catch(() => null) })),
    ]).then((entries) => entries.map((entry) => ({
      name: entry.name,
      status: entry.status,
      total: typeof entry.body?.total === 'number' ? entry.body.total : undefined,
      models: Array.isArray(entry.body?.models) ? entry.body.models.length : undefined,
      activeSubscription: Boolean(Object.values(entry.body?.accounts || {}).some((value) => value?.entitlement?.has_active_subscription === true)),
    }))).catch(() => [])`).catch(() => []) as Array<Record<string, unknown>>
    console.info(`[chatgpt-web] account=${accountPartitionKey(context.accountId)} state=${JSON.stringify(result)}`)
  }

  private installNavigationGuards(context: ActiveWebLogin): void {
    context.window.webContents.on('dom-ready', () => {
      if (context.window.isDestroyed()) return
      context.window.webContents.setAudioMuted(false)
      if (isAllowedChatGptWebUrl(context.window.webContents.getURL())) {
        void this.installImageViewer(context)
      }
      if (!context.history || context.window.isDestroyed()) return
      void this.installStableSidebarHistory(context, context.history).then(async (installed) => {
        if (!installed || context.window.isDestroyed()) return
        await context.window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(AUTHENTICATED_LOADING_STYLE_ID)})?.remove()`).catch(() => undefined)
      })
    })
    context.window.webContents.setWindowOpenHandler(({ url }) => {
      const imageAction = parseChatGptImageActionUrl(url, context.imageActionToken)
      if (imageAction) void this.saveImageFromViewer(context, imageAction.imageId)
      else if (isAllowedChatGptWebUrl(url)) void context.window.loadURL(url)
      else if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    context.window.webContents.on('context-menu', (_event, parameters) => {
      if (parameters.mediaType !== 'image' || !isSupportedImageSource(parameters.srcURL)) return
      const source = parameters.srcURL
      const menu = Menu.buildFromTemplate([
        {
          label: '在图片浏览器中查看',
          click: () => {
            if (context.window.isDestroyed()) return
            void context.window.webContents.executeJavaScript(
              `window[${JSON.stringify(IMAGE_VIEWER_BRIDGE_KEY)}]?.openBySource(${scriptJson(source)})`,
            ).catch(() => undefined)
          },
        },
        {
          label: '图片另存为…',
          click: () => {
            void this.saveImage(context, {
              source,
              filenameHint: parameters.altText,
            })
          },
        },
      ])
      menu.popup({ window: context.window })
    })
    const guard = (event: Electron.Event, target: string) => {
      if (isAllowedChatGptWebUrl(target) || isStoneStatusUrl(target)) return
      event.preventDefault()
      const imageAction = parseChatGptImageActionUrl(target, context.imageActionToken)
      if (imageAction) {
        void this.saveImageFromViewer(context, imageAction.imageId)
        return
      }
      if (isSafeExternalUrl(target)) void shell.openExternal(target)
    }
    context.window.webContents.on('will-navigate', guard)
    context.window.webContents.on('will-redirect', guard)
  }

  private async installImageViewer(context: ActiveWebLogin): Promise<void> {
    if (context.window.isDestroyed()) return
    await context.window.webContents.executeJavaScript(
      chatGptImageViewerScript(context.imageActionToken),
    ).catch(() => undefined)
  }

  private async saveImageFromViewer(context: ActiveWebLogin, imageId: string): Promise<void> {
    if (context.window.isDestroyed()) return
    const descriptor = await context.window.webContents.executeJavaScript(
      `window[${JSON.stringify(IMAGE_VIEWER_BRIDGE_KEY)}]?.describe(${scriptJson(imageId)}) ?? null`,
    ).catch(() => null) as ChatGptImageDescriptor | null
    if (!descriptor || !isSupportedImageSource(descriptor.source)) {
      await this.notifyImageViewer(context, 'error', '无法读取这张图片，请重新打开后再试。')
      return
    }
    await this.saveImage(context, descriptor, imageId)
  }

  private async saveImage(
    context: ActiveWebLogin,
    descriptor: ChatGptImageDescriptor,
    imageId?: string,
  ): Promise<void> {
    if (context.imageSaveInFlight || context.window.isDestroyed()) {
      if (context.imageSaveInFlight) await this.notifyImageViewer(context, 'busy', '上一张图片仍在保存。')
      return
    }
    context.imageSaveInFlight = true
    try {
      const extension = imageExtension(descriptor.source)
      const defaultName = safeImageFilename(descriptor.filenameHint, extension)
      const result = await dialog.showSaveDialog(context.window, {
        title: '图片另存为',
        defaultPath: join(app.getPath('pictures'), defaultName),
        buttonLabel: '保存',
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        filters: imageSaveFilters(extension),
      })
      if (result.canceled || !result.filePath) {
        await this.notifyImageViewer(context, 'idle', '')
        return
      }
      await this.notifyImageViewer(context, 'saving', '正在保存原图…')
      const payload = await this.readImagePayload(context, descriptor, imageId)
      await writeFile(result.filePath, payload.buffer)
      await this.notifyImageViewer(context, 'saved', `已保存到 ${result.filePath}`)
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : '图片保存失败。'
      await this.notifyImageViewer(context, 'error', message)
      if (!context.window.isDestroyed()) {
        await dialog.showMessageBox(context.window, {
          type: 'error',
          title: '图片保存失败',
          message,
        })
      }
    } finally {
      context.imageSaveInFlight = false
    }
  }

  private async readImagePayload(
    context: ActiveWebLogin,
    descriptor: ChatGptImageDescriptor,
    imageId?: string,
  ): Promise<ChatGptImagePayload> {
    if (descriptor.source.startsWith('data:')) return decodeImageDataUrl(descriptor.source)
    if (descriptor.source.startsWith('blob:')) {
      if (!imageId || context.window.isDestroyed()) throw new Error('这张临时图片已失效，请重新打开后再试。')
      const dataUrl = await context.window.webContents.executeJavaScript(
        `window[${JSON.stringify(IMAGE_VIEWER_BRIDGE_KEY)}]?.readDataUrl(${scriptJson(imageId)})`,
      ).catch(() => undefined) as unknown
      if (typeof dataUrl !== 'string') throw new Error('无法读取这张临时图片。')
      return decodeImageDataUrl(dataUrl)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await context.electronSession.fetch(descriptor.source, {
        cache: 'no-store',
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' },
        referrer: context.window.webContents.getURL(),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`原图下载失败（HTTP ${response.status}）。`)
      const declaredSize = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_DOWNLOAD_BYTES) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('图片超过 64 MiB，Stone+ 已停止保存。')
      }
      const buffer = await readBoundedResponseBuffer(
        response,
        MAX_IMAGE_DOWNLOAD_BYTES,
        '图片超过 64 MiB，Stone+ 已停止保存。',
        controller.signal,
      )
      const mimeType = normalizedImageMimeType(response.headers.get('content-type'))
      if (mimeType === undefined && buffer.length === 0) throw new Error('下载结果不是有效图片。')
      return { buffer, mimeType }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('原图下载超时。')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async notifyImageViewer(
    context: ActiveWebLogin,
    state: 'idle' | 'busy' | 'saving' | 'saved' | 'error',
    message: string,
  ): Promise<void> {
    if (context.window.isDestroyed()) return
    await context.window.webContents.executeJavaScript(
      `window[${JSON.stringify(IMAGE_VIEWER_BRIDGE_KEY)}]?.notify(${scriptJson(state)}, ${scriptJson(message)})`,
    ).catch(() => undefined)
  }

  private async showFailure(context: ActiveWebLogin, error: unknown): Promise<void> {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : '无法建立 ChatGPT 网页会话。'
    if (context.debuggerAttached && !context.window.isDestroyed()) {
      try { context.window.webContents.debugger.detach() } catch (detachError) { void detachError }
      context.debuggerAttached = false
    }
    if (context.window.isDestroyed()) return
    await context.window.loadURL(statusPageUrl(
      'ChatGPT 网页登录失败',
      `${message} 关闭窗口后可重新点击账号右侧的浏览器按钮。`,
      true,
    )).catch(() => undefined)
    if (!context.window.isDestroyed()) {
      this.showContext(context)
    }
  }

  private async cleanup(context: ActiveWebLogin, destroyWindow: boolean, purgeSession: boolean): Promise<void> {
    if (context.cleaned) return
    context.cleaned = true
    if (this.active.get(context.accountId) === context) this.active.delete(context.accountId)
    context.webWmRuntime?.dispose()
    context.webWmRuntime = undefined
    context.electronSession.webRequest.onBeforeSendHeaders(null)
    if (context.debuggerAttached && !context.window.isDestroyed()) {
      try { context.window.webContents.debugger.detach() } catch (error) { void error }
    }
    context.electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    context.electronSession.setPermissionCheckHandler(() => false)
    if (!context.window.isDestroyed()) context.window.webContents.setAudioMuted(true)
    if (destroyWindow && !context.window.isDestroyed()) context.window.destroy()
    const operations: Array<Promise<unknown>> = [context.electronSession.closeAllConnections()]
    if (purgeSession) operations.push(context.electronSession.clearStorageData())
    await Promise.allSettled(operations)
  }
}

function webWmTransportErrorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    error: { type: 'chatgpt_web_wm_transport_error', code, message },
  }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function safeWebWmErrorMessage(error: unknown): string {
  const source = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'ChatGPT Web WM transport failed.'
  return source
    .replace(/\b(?:eyJ|at-)[A-Za-z0-9._-]{20,}\b/g, '[redacted-token]')
    .slice(0, 1_000)
}

export function isAllowedChatGptMediaPermission(
  permission: string,
  requestingUrl: string | undefined,
  mediaTypes: Array<'video' | 'audio'> | undefined,
): boolean {
  if (!isExactChatGptOrigin(requestingUrl)) return false
  if (permission === 'speaker-selection') return true
  return permission === 'media'
    && Array.isArray(mediaTypes)
    && mediaTypes.length > 0
    && mediaTypes.every((mediaType) => mediaType === 'audio')
}

export function chatGptAccountCookieValue(
  credential: Pick<ChatGptCredentialBundle, 'accountId'>,
  lightAccount: Pick<ChatGptLightAccount, 'id' | 'structure'> | undefined,
  planType: string | undefined,
  mode: ChatGptAccountCookieMode,
): string | undefined {
  if (mode === 'none') return undefined
  if (mode === 'account-id') return lightAccount?.id ?? credential.accountId
  if (lightAccount) return lightAccount.structure === 'personal' ? 'personal' : lightAccount.id
  return planType && personalChatGptPlan(planType) ? 'personal' : credential.accountId
}

export function chatGptUnauthenticatedShellRecovery(
  retry: number,
): { accountCookieMode: ChatGptAccountCookieMode; target: string } | undefined {
  if (retry === 0) return { accountCookieMode: 'account-id', target: CHATGPT_HOME }
  if (retry === 1) return { accountCookieMode: 'none', target: CHATGPT_LOGIN_RECOVERY }
  if (retry === 2) return { accountCookieMode: 'preferred', target: CHATGPT_HOME }
  if (retry === 3) return { accountCookieMode: 'account-id', target: CHATGPT_LOGIN_RECOVERY }
  return undefined
}

export function chatGptShellDiagnostic(input: {
  attempt: number
  source: string
  target: string
  status?: number
  structure?: ChatGptLightAccount['structure']
  planType?: string
  edgeRay?: string
}): string {
  const shell = input.source.includes('/unauth-mweb/') ? 'mweb' : 'signin'
  const route = safeChatGptRoute(input.target)
  const edgeRay = input.edgeRay?.replace(/[^a-z0-9-]/gi, '').slice(0, 64)
  return [
    `U${Math.max(0, Math.trunc(input.attempt))}`,
    shell,
    `${input.structure ?? 'unknown'}-${input.planType?.toLowerCase() ?? 'unknown'}`,
    route,
    String(input.status ?? 0),
    ...(edgeRay ? [`cf-${edgeRay}`] : []),
  ].join(':')
}

function safeChatGptRoute(value: string): string {
  try {
    const url = new URL(value)
    if (url.origin !== CHATGPT_ORIGIN) return 'other'
    return url.pathname.replace(/[^a-z0-9/_-]/gi, '').slice(0, 80) || '/'
  } catch {
    return 'invalid'
  }
}

function responseHeaderValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value
}

export function isAllowedChatGptMediaPermissionCheck(
  permission: string,
  requestingUrl: string | undefined,
  mediaType: 'video' | 'audio' | 'unknown' | undefined,
): boolean {
  return permission === 'media'
    && mediaType === 'audio'
    && isExactChatGptOrigin(requestingUrl)
}

export function parseChatGptImageActionUrl(
  value: string,
  expectedToken: string,
): { imageId: string } | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== IMAGE_VIEWER_ACTION_SCHEME || url.hostname !== 'save') return undefined
    if (url.searchParams.get('token') !== expectedToken) return undefined
    const imageId = url.searchParams.get('id') ?? ''
    return /^[a-z0-9-]{1,80}$/i.test(imageId) ? { imageId } : undefined
  } catch {
    return undefined
  }
}

function isExactChatGptOrigin(value: string | undefined): boolean {
  if (!value) return false
  try {
    return new URL(value).origin === CHATGPT_ORIGIN
  } catch {
    return false
  }
}

function isSupportedImageSource(value: string): boolean {
  if (value.startsWith('blob:') || value.startsWith('data:image/')) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

export function chatGptImageViewerScript(actionToken: string): string {
  return `(() => {
    const bridgeKey = ${scriptJson(IMAGE_VIEWER_BRIDGE_KEY)}
    const previous = window[bridgeKey]
    if (previous && previous.version === 1) return true
    if (previous && typeof previous.destroy === 'function') previous.destroy()

    const actionToken = ${scriptJson(actionToken)}
    const entries = new Map()
    let serial = 0
    let root = null
    let stage = null
    let image = null
    let countLabel = null
    let sizeLabel = null
    let zoomLabel = null
    let toast = null
    let current = null
    let currentIndex = 0
    let visibleImages = []
    let scale = 1
    let panX = 0
    let panY = 0
    let fitMode = true
    let dragging = false
    let dragStartX = 0
    let dragStartY = 0
    let dragOriginX = 0
    let dragOriginY = 0
    let toastTimer = 0

    const sourceOf = (candidate) => candidate.currentSrc || candidate.src || ''
    const usable = (candidate) => {
      if (!(candidate instanceof HTMLImageElement) || candidate.closest('[data-stone-image-viewer]')) return false
      const rect = candidate.getBoundingClientRect()
      return candidate.naturalWidth >= 240
        && candidate.naturalHeight >= 180
        && rect.width >= 120
        && rect.height >= 90
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < innerHeight
        && rect.left < innerWidth
        && Boolean(sourceOf(candidate))
    }
    const idFor = (candidate) => {
      let id = candidate.dataset.stoneImageViewerId
      if (!id) {
        serial += 1
        id = 'image-' + serial.toString(36)
        candidate.dataset.stoneImageViewerId = id
      }
      entries.set(id, candidate)
      return id
    }
    const collect = () => {
      const seen = new Set()
      return Array.from(document.images).filter((candidate) => {
        if (!usable(candidate)) return false
        const source = sourceOf(candidate)
        if (seen.has(source)) return false
        seen.add(source)
        idFor(candidate)
        return true
      })
    }
    const button = (label, title, action, className) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.textContent = label
      element.title = title
      element.setAttribute('aria-label', title)
      element.className = className || ''
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        action()
      })
      return element
    }
    const ensureRoot = () => {
      if (root?.isConnected) return
      const style = document.createElement('style')
      style.dataset.stoneImageViewer = 'true'
      style.textContent = '[data-stone-image-viewer]{position:fixed;inset:0;z-index:2147483646;display:none;background:rgba(8,10,10,.94);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;touch-action:none;backdrop-filter:blur(12px)}[data-stone-image-viewer].is-open{display:block}[data-stone-image-viewer] .stone-image-stage{position:absolute;inset:58px 62px 52px;display:grid;place-items:center;overflow:hidden;cursor:grab}[data-stone-image-viewer] .stone-image-stage.is-dragging{cursor:grabbing}[data-stone-image-viewer] .stone-image-preview{display:block;max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;will-change:transform;box-shadow:0 18px 70px rgba(0,0,0,.45);pointer-events:none}[data-stone-image-viewer] .stone-image-toolbar{position:absolute;top:12px;left:50%;display:flex;align-items:center;gap:5px;padding:5px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(24,26,26,.88);box-shadow:0 8px 30px rgba(0,0,0,.3);transform:translateX(-50%)}[data-stone-image-viewer] button{height:34px;min-width:34px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#f7f8f8;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}[data-stone-image-viewer] button:hover{background:rgba(255,255,255,.12)}[data-stone-image-viewer] .stone-image-save{background:#14775d}[data-stone-image-viewer] .stone-image-save:hover{background:#18866a}[data-stone-image-viewer] .stone-image-zoom{min-width:54px;color:#cbd0ce;font-variant-numeric:tabular-nums}[data-stone-image-viewer] .stone-image-close{position:absolute;top:14px;right:16px;width:38px;height:38px;padding:0;border-radius:50%;font-size:25px;background:rgba(24,26,26,.76)}[data-stone-image-viewer] .stone-image-nav{position:absolute;top:50%;width:42px;height:58px;padding:0;border-radius:12px;background:rgba(24,26,26,.68);font-size:30px;transform:translateY(-50%)}[data-stone-image-viewer] .stone-image-prev{left:14px}[data-stone-image-viewer] .stone-image-next{right:14px}[data-stone-image-viewer] .stone-image-meta{position:absolute;left:50%;bottom:14px;display:flex;gap:12px;color:#cbd0ce;transform:translateX(-50%);font-variant-numeric:tabular-nums}[data-stone-image-viewer] .stone-image-toast{position:absolute;left:50%;bottom:50px;max-width:min(620px,calc(100% - 60px));padding:8px 12px;border-radius:9px;background:rgba(24,26,26,.9);color:#fff;opacity:0;transform:translate(-50%,8px);transition:opacity .16s,transform .16s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}[data-stone-image-viewer] .stone-image-toast.is-visible{opacity:1;transform:translate(-50%,0)}[data-stone-image-viewer] .stone-image-toast.is-error{background:#8f2424}@media(max-width:700px){[data-stone-image-viewer] .stone-image-stage{inset:58px 10px 50px}[data-stone-image-viewer] .stone-image-nav{display:none}[data-stone-image-viewer] .stone-image-toolbar{max-width:calc(100% - 70px);overflow-x:auto}}'
      document.head.appendChild(style)
      root = document.createElement('div')
      root.dataset.stoneImageViewer = 'true'
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      root.setAttribute('aria-label', '图片浏览器')
      stage = document.createElement('div')
      stage.className = 'stone-image-stage'
      image = document.createElement('img')
      image.className = 'stone-image-preview'
      image.alt = ''
      image.draggable = false
      stage.appendChild(image)
      root.appendChild(stage)
      const toolbar = document.createElement('div')
      toolbar.className = 'stone-image-toolbar'
      toolbar.append(
        button('−', '缩小', () => zoom(.82)),
        button('100%', '当前缩放', () => undefined, 'stone-image-zoom'),
        button('+', '放大', () => zoom(1.22)),
        button('适应', '适应窗口', () => reset(true)),
        button('1:1', '原始尺寸', () => reset(false)),
        button('保存', '图片另存为', save, 'stone-image-save'),
      )
      zoomLabel = toolbar.querySelector('.stone-image-zoom')
      root.appendChild(toolbar)
      root.appendChild(button('×', '关闭图片浏览器', close, 'stone-image-close'))
      root.appendChild(button('‹', '上一张图片', () => move(-1), 'stone-image-nav stone-image-prev'))
      root.appendChild(button('›', '下一张图片', () => move(1), 'stone-image-nav stone-image-next'))
      const meta = document.createElement('div')
      meta.className = 'stone-image-meta'
      countLabel = document.createElement('span')
      sizeLabel = document.createElement('span')
      meta.append(countLabel, sizeLabel)
      root.appendChild(meta)
      toast = document.createElement('div')
      toast.className = 'stone-image-toast'
      root.appendChild(toast)
      document.body.appendChild(root)

      root.addEventListener('click', (event) => { if (event.target === root) close() })
      stage.addEventListener('dblclick', (event) => { event.preventDefault(); reset(!fitMode) })
      stage.addEventListener('wheel', (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.15 : .87) }, { passive: false })
      stage.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        dragging = true
        dragStartX = event.clientX
        dragStartY = event.clientY
        dragOriginX = panX
        dragOriginY = panY
        stage.classList.add('is-dragging')
        stage.setPointerCapture(event.pointerId)
      })
      stage.addEventListener('pointermove', (event) => {
        if (!dragging) return
        panX = dragOriginX + event.clientX - dragStartX
        panY = dragOriginY + event.clientY - dragStartY
        applyTransform()
      })
      const stopDragging = (event) => {
        dragging = false
        stage.classList.remove('is-dragging')
        if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
      }
      stage.addEventListener('pointerup', stopDragging)
      stage.addEventListener('pointercancel', stopDragging)
    }
    const applyTransform = () => {
      if (!image) return
      image.style.maxWidth = fitMode ? '100%' : 'none'
      image.style.maxHeight = fitMode ? '100%' : 'none'
      image.style.width = fitMode ? 'auto' : Math.max(1, current?.naturalWidth || 1) + 'px'
      image.style.height = fitMode ? 'auto' : Math.max(1, current?.naturalHeight || 1) + 'px'
      image.style.transform = 'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + scale + ')'
      if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%'
    }
    const reset = (fit) => {
      fitMode = fit
      scale = 1
      panX = 0
      panY = 0
      applyTransform()
    }
    const zoom = (factor) => {
      scale = Math.min(8, Math.max(.1, scale * factor))
      applyTransform()
    }
    const show = (candidate) => {
      ensureRoot()
      current = candidate
      const id = idFor(candidate)
      const source = sourceOf(candidate)
      if (!source) return false
      image.src = source
      image.alt = candidate.alt || ''
      countLabel.textContent = (currentIndex + 1) + ' / ' + visibleImages.length
      const updateSize = () => {
        sizeLabel.textContent = (candidate.naturalWidth || image.naturalWidth || 0) + ' × ' + (candidate.naturalHeight || image.naturalHeight || 0)
      }
      image.onload = updateSize
      updateSize()
      reset(true)
      root.classList.add('is-open')
      root.dataset.currentImageId = id
      return true
    }
    const open = (candidate) => {
      visibleImages = collect()
      currentIndex = Math.max(0, visibleImages.indexOf(candidate))
      if (!visibleImages.includes(candidate)) visibleImages.push(candidate)
      return show(candidate)
    }
    const close = () => {
      root?.classList.remove('is-open')
      dragging = false
      current = null
      if (image) image.removeAttribute('src')
    }
    const move = (offset) => {
      if (visibleImages.length < 2) return
      currentIndex = (currentIndex + offset + visibleImages.length) % visibleImages.length
      show(visibleImages[currentIndex])
    }
    const save = () => {
      if (!current) return
      const id = idFor(current)
      notify('saving', '请选择保存位置…')
      const target = ${scriptJson(IMAGE_VIEWER_ACTION_SCHEME)} + '//save/?token=' + encodeURIComponent(actionToken) + '&id=' + encodeURIComponent(id)
      window.open(target, '_blank', 'noopener,noreferrer')
    }
    const notify = (state, message) => {
      ensureRoot()
      clearTimeout(toastTimer)
      toast.textContent = message || ''
      toast.classList.toggle('is-error', state === 'error')
      toast.classList.toggle('is-visible', Boolean(message))
      if (message && (state === 'saved' || state === 'busy')) {
        toastTimer = setTimeout(() => toast.classList.remove('is-visible'), state === 'saved' ? 4200 : 2200)
      }
    }
    const openBySource = (source) => {
      const candidate = Array.from(document.images).find((entry) => sourceOf(entry) === source)
      if (candidate) return open(candidate)
      const detached = new Image()
      detached.src = source
      detached.alt = 'ChatGPT 图片'
      detached.onload = () => {
        visibleImages = collect()
        visibleImages.push(detached)
        currentIndex = visibleImages.length - 1
        show(detached)
      }
      return true
    }
    const describe = (id) => {
      const candidate = entries.get(id)
      if (!candidate) return null
      const source = sourceOf(candidate)
      if (!source) return null
      return {
        source,
        filenameHint: candidate.alt || candidate.getAttribute('aria-label') || 'ChatGPT 图片',
        width: candidate.naturalWidth || undefined,
        height: candidate.naturalHeight || undefined,
      }
    }
    const readDataUrl = async (id) => {
      const descriptor = describe(id)
      if (!descriptor || (!descriptor.source.startsWith('blob:') && !descriptor.source.startsWith('data:'))) return null
      const response = await fetch(descriptor.source)
      const blob = await response.blob()
      if (blob.size > ${MAX_IMAGE_DOWNLOAD_BYTES}) throw new Error('image-too-large')
      return await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => reject(reader.error || new Error('image-read-failed'))
        reader.readAsDataURL(blob)
      })
    }
    const onDocumentClick = (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const candidate = event.target instanceof Element ? event.target.closest('img') : null
      if (!usable(candidate)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      open(candidate)
    }
    const onKeyDown = (event) => {
      if (!root?.classList.contains('is-open')) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.22) }
      else if (event.key === '-') { event.preventDefault(); zoom(.82) }
      else if (event.key === '0') { event.preventDefault(); reset(true) }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
    }
    document.addEventListener('click', onDocumentClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    window[bridgeKey] = {
      version: 1,
      describe,
      readDataUrl,
      openBySource,
      notify,
      destroy: () => {
        document.removeEventListener('click', onDocumentClick, true)
        document.removeEventListener('keydown', onKeyDown, true)
        document.querySelectorAll('[data-stone-image-viewer]').forEach((element) => element.remove())
        entries.clear()
      },
    }
    return true
  })()`
}

function decodeImageDataUrl(value: string): ChatGptImagePayload {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i)
  if (!match) throw new Error('图片数据格式无效。')
  let buffer: Buffer
  try {
    buffer = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  } catch {
    throw new Error('图片数据无法解码。')
  }
  if (buffer.length === 0) throw new Error('图片内容为空。')
  if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error('图片超过 64 MiB，Stone+ 已停止保存。')
  return { buffer, mimeType: match[1].toLowerCase() }
}

function normalizedImageMimeType(value: string | null): string | undefined {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mimeType && /^image\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : undefined
}

function imageExtension(source: string): string {
  const dataMime = source.match(/^data:(image\/[a-z0-9.+-]+)/i)?.[1]?.toLowerCase()
  const byMime: Record<string, string> = {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  }
  if (dataMime && byMime[dataMime]) return byMime[dataMime]
  try {
    const extension = extname(new URL(source).pathname).toLowerCase()
    if (['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(extension)) return extension
  } catch {
    // Blob URLs and malformed optional hints use PNG as the safe default.
  }
  return '.png'
}

function safeImageFilename(hint: string | undefined, extension: string): string {
  const normalized = (hint ?? '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .slice(0, 72)
    .trim()
  const safeBase = !normalized || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalized)
    ? `ChatGPT-image-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    : normalized
  return `${safeBase}${extension}`
}

function imageSaveFilters(extension: string): Electron.FileFilter[] {
  const selected = extension.replace(/^\./, '')
  return [
    { name: '当前图片格式', extensions: [selected] },
    { name: '所有文件', extensions: ['*'] },
  ]
}

export function patchChatGptAuthenticatedDocument(
  source: string,
  credential: ChatGptCredentialBundle,
  options: { includeLoadingMask?: boolean; lightAccount?: ChatGptLightAccount } = {},
): DocumentPatchResult {
  const sessionValue = syntheticSession(credential, options.lightAccount)
  const userValue = { ...sessionValue.user, groups: [], mfa: false }
  const bootstrap = patchClientBootstrapDocument(source, credential, sessionValue, userValue)
  if (bootstrap.count > 0) {
    const authenticatedDocument = patchAuthenticatedPrefetchDocument(bootstrap.body)
    return {
      ...bootstrap,
      body: options.includeLoadingMask === false
        ? authenticatedDocument
        : injectAuthenticatedLoadingMask(authenticatedDocument),
    }
  }
  if (bootstrap.recognizedApplicationDocument) return bootstrap

  return patchLegacyHydrationDocument(source, sessionValue, userValue)
}

function injectAuthenticatedLoadingMask(source: string): string {
  const headEnd = source.search(/<\/head\s*>/i)
  if (headEnd < 0 || source.includes(`id="${AUTHENTICATED_LOADING_STYLE_ID}"`)) return source
  const style = `<style id="${AUTHENTICATED_LOADING_STYLE_ID}">body>*{visibility:hidden!important}body:before{visibility:visible!important;content:"正在同步 ChatGPT 账号与历史会话…";position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#f7f9f8;color:#50605a;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){body:before{background:#151716;color:#eef1ef}}</style>`
  return source.slice(0, headEnd) + style + source.slice(headEnd)
}

function patchClientBootstrapDocument(
  source: string,
  credential: ChatGptCredentialBundle,
  sessionValue: ReturnType<typeof syntheticSession>,
  userValue: ReturnType<typeof syntheticSession>['user'] & { groups: never[]; mfa: boolean },
): DocumentPatchResult {
  const lowerSource = source.toLowerCase()
  let scanCursor = 0
  let outputCursor = 0
  let body = ''
  let count = 0
  let recognizedApplicationDocument = false

  while (scanCursor < source.length) {
    const start = lowerSource.indexOf('<script', scanCursor)
    if (start < 0) break
    const tagEnd = source.indexOf('>', start + 7)
    if (tagEnd < 0 || tagEnd - start > 4_096) break
    const openingTag = source.slice(start, tagEnd + 1)
    if (!/\bid\s*=\s*(?:["']client-bootstrap["']|client-bootstrap)(?=[\s>])/i.test(openingTag)) {
      scanCursor = tagEnd + 1
      continue
    }

    recognizedApplicationDocument = true
    const contentStart = tagEnd + 1
    const contentEnd = lowerSource.indexOf('</script>', contentStart)
    if (contentEnd < 0) break
    const raw = source.slice(contentStart, contentEnd)
    const leadingLength = raw.length - raw.trimStart().length
    const trailingLength = raw.length - raw.trimEnd().length
    const leading = raw.slice(0, leadingLength)
    const trailing = trailingLength > 0 ? raw.slice(raw.length - trailingLength) : ''

    try {
      const parsed = JSON.parse(raw.trim()) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        scanCursor = contentEnd + 9
        continue
      }
      const state = parsed as Record<string, unknown>
      if (state.authStatus !== 'logged_out' || !Object.hasOwn(state, 'session') || !Object.hasOwn(state, 'user')) {
        scanCursor = contentEnd + 9
        continue
      }
      state.authStatus = 'logged_in'
      state.session = sessionValue
      state.user = userValue
      if (Object.hasOwn(state, 'isNoAuthEnabled')) state.isNoAuthEnabled = false
      if (Array.isArray(state.flags)) {
        state.flags = state.flags.filter((flag) => flag !== 'naefu')
      }
      patchStatsigAuthenticatedState(state, credential, sessionValue)
      body += source.slice(outputCursor, contentStart) + leading + scriptJson(state) + trailing
      outputCursor = contentEnd
      scanCursor = contentEnd + 9
      count += 1
    } catch {
      scanCursor = contentEnd + 9
    }
  }

  if (count === 0) return { body: source, count, recognizedApplicationDocument }
  body += source.slice(outputCursor)
  return { body, count, recognizedApplicationDocument }
}

/**
 * ChatGPT's logged-out server shell deliberately disables its authenticated
 * route loaders. Patching only client-bootstrap leaves React believing that
 * account, entitlement, model and conversation data must not be requested;
 * this produces the misleading free-plan picker and removes the expanded
 * profile footer during hydration. Flip only the known loader booleans in the
 * devalue stream so the official components hydrate from authenticated
 * backend responses. Unknown stream shapes are left byte-for-byte unchanged.
 */
function patchAuthenticatedPrefetchDocument(source: string): string {
  const marker = 'window.__reactRouterContext.streamController.enqueue('
  let cursor = 0
  let outputCursor = 0
  let body = ''

  while (cursor < source.length) {
    const callStart = source.indexOf(marker, cursor)
    if (callStart < 0) break
    let literalStart = callStart + marker.length
    while (/\s/.test(source[literalStart] ?? '')) literalStart += 1
    if (source[literalStart] !== '"') {
      cursor = literalStart + 1
      continue
    }
    const literalEnd = javascriptStringLiteralEnd(source, literalStart)
    if (literalEnd < 0) break

    try {
      const decoded = JSON.parse(source.slice(literalStart, literalEnd + 1)) as unknown
      if (typeof decoded !== 'string') {
        cursor = literalEnd + 1
        continue
      }
      const patched = patchAuthenticatedPrefetchChunk(decoded)
      if (patched === decoded) {
        cursor = literalEnd + 1
        continue
      }
      body += source.slice(outputCursor, literalStart) + scriptJson(patched)
      outputCursor = literalEnd + 1
      cursor = literalEnd + 1
    } catch {
      cursor = literalEnd + 1
    }
  }

  if (outputCursor === 0) return source
  return body + source.slice(outputCursor)
}

function patchAuthenticatedPrefetchChunk(chunk: string): string {
  const leadingLength = chunk.length - chunk.trimStart().length
  const trailingLength = chunk.length - chunk.trimEnd().length
  const leading = chunk.slice(0, leadingLength)
  const trailing = trailingLength > 0 ? chunk.slice(chunk.length - trailingLength) : ''
  let values: unknown
  try {
    values = JSON.parse(chunk.trim()) as unknown
  } catch {
    return chunk
  }
  if (!Array.isArray(values)) return chunk

  let trueReference = values.findIndex((value) => value === true)
  if (trueReference < 0) {
    trueReference = values.length
    values.push(true)
  }
  let falseReference = values.findIndex((value) => value === false)
  if (falseReference < 0) {
    falseReference = values.length
    values.push(false)
  }

  const desiredValues = new Map<string, number>([
    ['disablePrefetch', falseReference],
    ['shouldPrefetchAccount', trueReference],
    ['shouldPrefetchUser', trueReference],
    ['shouldPrefetchSystemHints', trueReference],
    ['shouldPrefetchModels', trueReference],
    ['shouldPrefetchInternalModels', trueReference],
    ['shouldPrefetchStarterPrompts', trueReference],
    ['shouldPrefetchHistory', trueReference],
    ['shouldPrefetchStarredConversations', trueReference],
  ])
  let changed = false
  for (const [key, reference] of desiredValues) {
    const keyReference = values.findIndex((value) => value === key)
    if (keyReference < 0) continue
    const serializedKey = `_${keyReference}`
    for (const candidate of values) {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      if (!Object.hasOwn(record, serializedKey) || record[serializedKey] === reference) continue
      record[serializedKey] = reference
      changed = true
    }
  }
  return changed ? `${leading}${JSON.stringify(values)}${trailing}` : chunk
}

function javascriptStringLiteralEnd(source: string, start: number): number {
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') return index
  }
  return -1
}

function patchLegacyHydrationDocument(
  source: string,
  sessionValue: ReturnType<typeof syntheticSession>,
  userValue: ReturnType<typeof syntheticSession>['user'] & { groups: never[]; mfa: boolean },
): DocumentPatchResult {
  const prefix = '"authStatus":"logged_out","session":null,"user":'
  const suffix = ',"sessionId":'
  const replacement = `"authStatus":"logged_in","session":${scriptJson(sessionValue)},"user":${scriptJson(userValue)}`
  let cursor = 0
  let body = ''
  let count = 0
  while (cursor < source.length) {
    const start = source.indexOf(prefix, cursor)
    if (start < 0) {
      body += source.slice(cursor)
      break
    }
    const end = source.indexOf(suffix, start + prefix.length)
    if (end < 0 || end - start > 8_192) {
      body += source.slice(cursor, start + prefix.length)
      cursor = start + prefix.length
      continue
    }
    body += source.slice(cursor, start) + replacement + suffix
    cursor = end + suffix.length
    count += 1
  }
  return {
    body,
    count,
    recognizedApplicationDocument: count > 0 || source.includes('"authStatus"') || source.includes('"logged_out"'),
  }
}

export function isAllowedChatGptWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com'
  } catch {
    return false
  }
}

export function applyChatGptWebIdentityHeaders(
  source: Record<string, string>,
  credential: Pick<ChatGptCredentialBundle, 'accessToken' | 'accountId'>,
): Record<string, string> {
  const headers = { ...source }
  for (const key of Object.keys(headers)) {
    const normalized = key.toLowerCase()
    if (normalized === 'authorization' || normalized === 'chatgpt-account-id') delete headers[key]
  }
  headers.Authorization = `Bearer ${credential.accessToken}`
  headers['ChatGPT-Account-Id'] = credential.accountId
  return headers
}

export function chatGptWebWmCatalogModel(
  value: unknown,
): typeof GPT_5_6_SOL_WM_MODEL | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const models = (value as { models?: unknown }).models
  if (!Array.isArray(models)) return undefined
  const exact = models.some((model) => (
    model !== null
    && typeof model === 'object'
    && !Array.isArray(model)
    && (model as { slug?: unknown }).slug === GPT_5_6_SOL_WM_MODEL
    && (model as { is_work_mode_model?: unknown }).is_work_mode_model === true
  ))
  return exact ? GPT_5_6_SOL_WM_MODEL : undefined
}

export function isChatGptSecurityInterstitial(source: string): boolean {
  return source.includes('/cdn-cgi/challenge-platform')
    || /enable javascript and cookies to continue/i.test(source)
    || /<title>\s*just a moment[.!]?\s*<\/title>/i.test(source)
}

export function isChatGptUnauthenticatedApp(source: string): boolean {
  return /(?:src|href)=["'][^"']*\/unauth-mweb\//i.test(source)
    || source.includes('Sign in is required to continue.')
}

export function parseChatGptLightAccount(
  value: unknown,
  preferredAccountId: string,
  options: { requireExact?: boolean } = {},
): ChatGptLightAccount | undefined {
  const root = objectClaim(value)
  const accounts = objectClaim(root.accounts)
  const direct = objectClaim(accounts[preferredAccountId])
  const candidates = Object.values(accounts).map(objectClaim)
  const exact = stringClaim(objectClaim(direct.account).account_id) === preferredAccountId
    ? direct
    : candidates.find((candidate) => (
      stringClaim(objectClaim(candidate.account).account_id) === preferredAccountId
    ))
  const defaultEntry = objectClaim(accounts.default)
  const orderedIds = Array.isArray(root.account_ordering)
    ? root.account_ordering.filter((id): id is string => typeof id === 'string')
    : []
  const orderedEntry = orderedIds
    .map((id) => objectClaim(accounts[id]))
    .find((candidate) => objectClaim(candidate.account).is_deactivated !== true)
  // Older/imported Codex credentials do not always carry the ChatGPT web
  // account id. In that case the API's explicit default (or first active
  // ordered account) is the authoritative selection.
  const entry = exact
    ?? (options.requireExact
      ? undefined
      : (stringClaim(objectClaim(defaultEntry.account).account_id) ? defaultEntry : undefined)
        ?? orderedEntry)
  if (!entry) return undefined

  const account = objectClaim(entry.account)
  const entitlement = objectClaim(entry.entitlement)
  const id = stringClaim(account.account_id)
  const planType = stringClaim(account.plan_type)?.toLowerCase()
  if (!id || !planType) return undefined
  const features = Array.isArray(entry.features)
    ? entry.features.filter((feature): feature is string => typeof feature === 'string')
    : []
  const organizationId = stringClaim(account.organization_id)
  const gracePeriodId = stringClaim(entitlement.grace_period_id)

  return {
    id,
    ...(organizationId ? { organizationId } : {}),
    residencyRegion: stringClaim(account.account_residency_region)
      ?? stringClaim(account.account_compute_residency)
      ?? 'no_constraint',
    computeResidency: stringClaim(account.account_compute_residency) ?? 'no_constraint',
    structure: account.structure === 'personal' ? 'personal' : 'workspace',
    planType,
    isUsageBasedSeatEnabled: account.is_usage_based_seat_enabled === true,
    isFedrampCompliantWorkspace: account.is_fedramp_compliant_workspace === true,
    isConversationClassifierEnabledForWorkspace: account.is_conversation_classifier_enabled_for_workspace === true,
    hasFloraFeature: features.includes('flora'),
    isDelinquent: entitlement.is_delinquent === true,
    ...(gracePeriodId ? { gracePeriodId } : {}),
  }
}

function syntheticSession(
  credential: ChatGptCredentialBundle,
  verifiedLightAccount?: ChatGptLightAccount,
) {
  const idClaims = jwtClaims(credential.idToken ?? credential.accessToken)
  const accessClaims = jwtClaims(credential.accessToken)
  const accessAuth = objectClaim(accessClaims['https://api.openai.com/auth'])
  const email = credential.email ?? stringClaim(idClaims.email) ?? stringClaim(accessClaims.email)
  const userId = chatGptWebUserId(credential, accessClaims, idClaims)
  const image = stringClaim(idClaims.picture) ?? stringClaim(accessClaims.picture) ?? null
  const planType = stringClaim(accessAuth.chatgpt_plan_type)?.toLowerCase()
  const account = verifiedLightAccount ?? (planType ? {
    id: credential.accountId,
    // `poid` belongs to the API identity and is not guaranteed to be the
    // organization backing the selected ChatGPT workspace. Supplying it here
    // can make the light account disagree with /accounts/check.
    residencyRegion: 'no_constraint',
    computeResidency: stringClaim(accessAuth.chatgpt_compute_residency) ?? 'no_constraint',
    structure: personalChatGptPlan(planType) ? 'personal' : 'workspace',
    planType,
    isUsageBasedSeatEnabled: false,
    isFedrampCompliantWorkspace: false,
    isConversationClassifierEnabledForWorkspace: true,
    hasFloraFeature: planType !== 'free',
    isDelinquent: false,
    // The web account mapper normalizes a missing/null grace period to
    // `undefined`. Omitting the property keeps the bootstrap light account
    // strictly equal and prevents ChatGPT's refresh_account reload loop.
  } : undefined)
  return {
    user: {
      id: userId,
      ...(email ? { email } : {}),
      name: stringClaim(idClaims.name) ?? email ?? 'ChatGPT User',
      image,
      picture: image,
      groups: [],
      mfa: false,
    },
    expires: new Date(credential.expiresAt).toISOString(),
    accessToken: credential.accessToken,
    authProvider: 'openai',
    ...(account ? { account } : {}),
  }
}

export function authenticatedBootstrapState(
  source: unknown,
  credential: ChatGptCredentialBundle,
  lightAccount?: ChatGptLightAccount,
): Record<string, unknown> {
  const state = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? structuredClone(source as Record<string, unknown>)
    : {}
  const sessionValue = syntheticSession(credential, lightAccount)
  state.authStatus = 'logged_in'
  if (typeof state.sessionId !== 'string' || !state.sessionId.trim()) {
    state.sessionId = randomUUID()
  }
  state.session = sessionValue
  state.user = { ...sessionValue.user, groups: [], mfa: false }
  state.isNoAuthEnabled = false
  if (Array.isArray(state.flags)) state.flags = state.flags.filter((flag) => flag !== 'naefu')
  if (!validStatsigBootstrapPayload(state.statsigPayload)) {
    state.statsigPayload = JSON.stringify({
      user: {
        userID: sessionValue.user.id,
        ...(sessionValue.user.email ? { email: sessionValue.user.email } : {}),
        custom: {
          auth_status: 'logged_in',
          has_logged_in_before: true,
          account_user_id: credential.userId ?? sessionValue.user.id,
          ...(sessionValue.account ? { is_paid: sessionValue.account.planType !== 'free' } : {}),
        },
      },
      evaluated_keys: { userID: sessionValue.user.id },
      feature_gates: {},
      dynamic_configs: {},
      layer_configs: {},
      has_updates: false,
    })
  }
  patchStatsigAuthenticatedState(state, credential, sessionValue)
  return state
}

function validStatsigBootstrapPayload(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function personalChatGptPlan(planType: string): boolean {
  return ['free', 'plus', 'pro', 'prolite', 'go'].includes(planType)
}

function chatGptWebUserId(
  credential: ChatGptCredentialBundle,
  accessClaims: Record<string, unknown>,
  idClaims: Record<string, unknown>,
): string {
  const accessAuth = objectClaim(accessClaims['https://api.openai.com/auth'])
  const idAuth = objectClaim(idClaims['https://api.openai.com/auth'])
  const claimed = stringClaim(accessAuth.chatgpt_user_id)
    ?? stringClaim(accessAuth.user_id)
    ?? stringClaim(idAuth.chatgpt_user_id)
    ?? stringClaim(idAuth.user_id)
    ?? normalizedWebUserId(stringClaim(accessAuth.chatgpt_account_user_id), credential.accountId)
    ?? normalizedWebUserId(stringClaim(idAuth.chatgpt_account_user_id), credential.accountId)
  if (claimed) return claimed

  const stored = credential.userId?.trim()
  const compositeSuffix = `__${credential.accountId}`
  if (stored?.endsWith(compositeSuffix)) return stored.slice(0, -compositeSuffix.length)
  return stored ?? stringClaim(idClaims.sub) ?? stringClaim(accessClaims.sub) ?? credential.accountId
}

function patchStatsigAuthenticatedState(
  state: Record<string, unknown>,
  credential: ChatGptCredentialBundle,
  sessionValue: ReturnType<typeof syntheticSession>,
): void {
  if (typeof state.statsigPayload !== 'string') return
  try {
    const parsed = JSON.parse(state.statsigPayload) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const payload = parsed as Record<string, unknown>
    const user = { ...objectClaim(payload.user) }
    const custom = { ...objectClaim(user.custom) }
    const accessAuth = objectClaim(jwtClaims(credential.accessToken)['https://api.openai.com/auth'])
    const accountUserId = stringClaim(accessAuth.chatgpt_account_user_id)
      ?? credential.userId
      ?? sessionValue.user.id
    const plan = sessionValue.account?.planType
      ?? stringClaim(accessAuth.chatgpt_plan_type)?.toLowerCase()

    user.userID = sessionValue.user.id
    if (sessionValue.user.email) user.email = sessionValue.user.email
    user.custom = {
      ...custom,
      auth_status: 'logged_in',
      has_logged_in_before: true,
      account_user_id: accountUserId,
      ...(plan ? { is_paid: plan !== 'free' } : {}),
    }
    payload.user = user
    const evaluatedKeys = { ...objectClaim(payload.evaluated_keys), userID: sessionValue.user.id }
    payload.evaluated_keys = evaluatedKeys
    state.statsigPayload = JSON.stringify(payload)
  } catch {
    // Authentication still relies on the validated session and backend
    // identity headers. A malformed optional experimentation payload must not
    // make the bridge mutate it partially.
  }
}

function normalizedWebUserId(value: string | undefined, accountId: string): string | undefined {
  if (!value) return undefined
  const compositeSuffix = `__${accountId}`
  return value.endsWith(compositeSuffix) ? value.slice(0, -compositeSuffix.length) : value
}

function jwtClaims(token: string): Record<string, unknown> {
  const segment = token.split('.')[1]
  if (!segment) return {}
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function objectClaim(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function accountPartitionKey(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 16)
}

function statusPageUrl(title: string, message: string, failed = false): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  const accent = failed ? '#b42318' : '#14775d'
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="${STATUS_PAGE_MARKER}" content="1"><meta name="color-scheme" content="light dark"><title>${safeTitle}</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f7f9f8;color:#17221f;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(460px,calc(100% - 48px));padding:30px 32px;border-radius:18px;background:rgba(255,255,255,.92);box-shadow:0 18px 60px rgba(27,49,42,.12)}.mark{width:34px;height:34px;margin-bottom:18px;border:3px solid ${accent}33;border-top-color:${accent};border-radius:50%;animation:spin .9s linear infinite}.failed .mark{border:0;border-radius:10px;background:${accent};animation:none;position:relative}.failed .mark:after{content:"!";position:absolute;inset:0;display:grid;place-items:center;color:white;font-weight:800;font-size:20px}h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#50605a}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){body{background:#121514;color:#f2f5f4}.card{background:#1b1f1e;box-shadow:none}p{color:#c6cdca}}</style></head><body><main class="card${failed ? ' failed' : ''}"><div class="mark"></div><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

function chatGptRetryDocument(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>ChatGPT</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f7f9f8;color:#50605a;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){body{background:#151716;color:#eef1ef}}</style></head><body>正在恢复完整 ChatGPT 会话…</body></html>'
}

function isStoneStatusUrl(value: string): boolean {
  if (!value.startsWith('data:text/html;charset=UTF-8,')) return false
  try { return decodeURIComponent(value).includes(STATUS_PAGE_MARKER) } catch { return false }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

function chatGptUserAgent(): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
}

function chromiumProxyRule(proxy: PublicProxyDefinition): string {
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${host}:${proxy.port}`
}

function sameProxyEndpoint(host: string, port: number, configured: ProxyAuthentication): boolean {
  return host.replace(/^\[|\]$/g, '').toLowerCase() === configured.host.replace(/^\[|\]$/g, '').toLowerCase()
    && port === configured.port
}

function probeNeedsRefresh(result: WebProbeResult): boolean {
  return result.me === 401 || result.accounts === 401
}

export function probeNeedsTransientRetry(result: WebProbeResult): boolean {
  const transient = (value: NonNullable<WebProbeResult['me']>): boolean => (
    value === 'timeout'
    || value === 'network-error'
    || (typeof value === 'number' && (value === 408 || value === 425 || value === 429 || value >= 500))
  )
  return transient(result.me ?? 'network-error') || transient(result.accounts ?? 'network-error')
}

export function classifyChatGptNavigationError(error: unknown): 'aborted' | 'transient' | 'fatal' {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/ERR_ABORTED|(?:^|\s)-3(?=\s|$)/i.test(message)) return 'aborted'
  if (
    /ERR_(?:CONNECTION_(?:CLOSED|RESET|TIMED_OUT)|INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|TIMED_OUT)|(?:^|\s)-(?:21|101|102|105|106|111|118|130|138)(?=\s|$)/i.test(message)
  ) return 'transient'
  return 'fatal'
}

function assertUsableWebProbe(result: WebProbeResult, networkRoute: string): void {
  if (result.me === 200 && result.accounts === 200) return
  if (probeNeedsRefresh(result)) throw new Error('ChatGPT OAuth 已失效，请重新授权该账号。')
  if (result.me === 403 || result.accounts === 403) {
    throw new Error('该 ChatGPT OAuth 凭据无权访问所选账号或工作区（HTTP 403）。')
  }
  if (result.me === 402 || result.accounts === 402) throw new Error('该 ChatGPT 账号或工作区当前不可用。')
  const diagnostic = `me=${String(result.me)}, accounts=${String(result.accounts)}, route=${networkRoute}`
  if (result.me === 'timeout' || result.accounts === 'timeout') throw new Error(`ChatGPT OAuth 验活超时（${diagnostic}）。`)
  if (result.me === 'network-error' || result.accounts === 'network-error') throw new Error(`无法连接 ChatGPT 网页进行 OAuth 验活（${diagnostic}）。`)
  const status = [result.me, result.accounts].find((value) => typeof value === 'number')
  throw new Error(status ? `ChatGPT OAuth 验活失败（HTTP ${status}；${diagnostic}）。` : `ChatGPT OAuth 验活失败（${diagnostic}）。`)
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function webCredentialError(error: unknown): Error {
  if (error instanceof ChatGptCredentialRefreshError) {
    if (error.code === 'reauthorization-required') return new Error('ChatGPT OAuth 已失效，请重新授权该账号。')
    if (error.code === 'timeout') return new Error('刷新 ChatGPT OAuth 凭据超时。')
    return new Error('无法连接 OpenAI OAuth 服务刷新凭据。')
  }
  const message = error instanceof Error ? error.message : ''
  if (/rejected|expired|invalid/i.test(message)) return new Error('ChatGPT OAuth 已失效，请重新授权该账号。')
  if (/timed out/i.test(message)) return new Error('刷新 ChatGPT OAuth 凭据超时。')
  if (/could not be reached|network/i.test(message)) return new Error('无法连接 OpenAI OAuth 服务刷新凭据。')
  return error instanceof Error ? error : new Error('无法准备 ChatGPT OAuth 凭据。')
}

function assertSelectedChatGptAccount(
  account: Pick<Account, 'chatgptAccountId'>,
  credential: ChatGptCredentialBundle,
): void {
  if (account.chatgptAccountId && account.chatgptAccountId !== credential.accountId) {
    throw new Error('ChatGPT OAuth 凭据与所选账号或工作区不匹配，请重新授权。')
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}
