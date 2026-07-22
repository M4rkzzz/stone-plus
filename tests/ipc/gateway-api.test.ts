import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Account, AppSnapshot, PersistentTask, ProviderDefinition, PublicProxyDefinition, RequestLog, RouteClient } from '../../src/shared/types'
import type { GatewayController } from '../../src/main/ipc/gateway-api'
import type { GatewayAccountState, GatewayRuntimeStateUpdate } from '../../src/main/gateway'
import { registerGatewayApi } from '../../src/main/ipc/gateway-api'
import type { AppStore } from '../../src/main/store/app-store'
import type { ClientConfigService } from '../../src/main/client-config'
import type { OutboundTransportManager } from '../../src/main/proxy'
import { OutboundReloadCoordinator } from '../../src/main/proxy/outbound-reload-coordinator'
import type { ChatGptOAuthSessionController } from '../../src/main/auth/chatgpt-oauth-flow'
import { PersistentTaskRunner } from '../../src/main/tasks'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

class MemoryPersistentTaskStore {
  private readonly tasks = new Map<string, PersistentTask>()
  listPersistentTasks(limit = 200): PersistentTask[] { return [...this.tasks.values()].slice(0, limit).map((task) => structuredClone(task)) }
  getPersistentTask(id: string): PersistentTask | undefined { const task = this.tasks.get(id); return task ? structuredClone(task) : undefined }
  async upsertPersistentTask(task: PersistentTask): Promise<void> { this.tasks.set(task.id, structuredClone(task)) }
  async deletePersistentTask(id: string): Promise<void> { this.tasks.delete(id) }
  async prunePersistentTasks(cutoff: number, maximumTerminalRows: number): Promise<number> {
    const terminal = [...this.tasks.values()]
      .filter((task) => ['completed', 'cancelled', 'failed'].includes(task.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const removed = new Set(terminal.filter((task, index) => task.updatedAt < cutoff || index >= maximumTerminalRows).map((task) => task.id))
    for (const id of removed) this.tasks.delete(id)
    return removed.size
  }
  async clearTerminalPersistentTasks(): Promise<number> {
    const ids = [...this.tasks.values()].filter((task) => ['completed', 'cancelled', 'failed'].includes(task.status)).map((task) => task.id)
    for (const id of ids) this.tasks.delete(id)
    return ids.length
  }
}

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  getAllWindows: vi.fn(() => []),
  getLocale: vi.fn(() => 'zh-CN'),
  showOpenDialog: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Stone'),
    getVersion: vi.fn(() => '0.7.0'),
    getLocale: electron.getLocale,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn()
  },
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getAllWindows: electron.getAllWindows
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler))
  },
  Notification: class {
    static isSupported(): boolean { return false }
  },
  shell: { openExternal: electron.openExternal }
}))

const provider: ProviderDefinition = {
  id: 'provider-openai',
  name: 'OpenAI',
  sourceType: 'official-api',
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  protocol: 'openai-responses',
  models: [],
  createdAt: 1,
  updatedAt: 1
}

describe('refresh provider models IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.showOpenDialog.mockReset()
    electron.fromWebContents.mockReturnValue({})
    electron.getLocale.mockReturnValue('zh-CN')
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('opens a multi-file picker for CPA and Sub2API account JSON imports', async () => {
    electron.getLocale.mockReturnValue('en-US')
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:import-chatgpt-account-files')
    if (!handler) throw new Error('import-chatgpt-account-files handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const result = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      { tagId: null, poolId: null }
    ) as { cancelled: boolean; selectedFiles: number }

    expect(result).toMatchObject({ cancelled: true, selectedFiles: 0 })
    expect(electron.showOpenDialog).toHaveBeenCalledOnce()
    expect(electron.showOpenDialog.mock.calls[0][1]).toMatchObject({
      title: 'Select CPA / Sub2API account JSON files',
      buttonLabel: 'Import and check',
      properties: ['openFile', 'multiSelections'],
      filters: expect.arrayContaining([expect.objectContaining({ extensions: ['json', 'txt'] })])
    })
    expect(harness.store.getSnapshot).toHaveBeenCalled()
    expect(harness.store.importChatGptAccounts).not.toHaveBeenCalled()
  })

  it('uses the renderer language override for native dialogs', async () => {
    electron.getLocale.mockReturnValue('zh-CN')
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    createHarness([oauthAccount()], {}, vi.fn())
    const setLanguage = electron.handlers.get('stone:set-ui-language')
    const importFiles = electron.handlers.get('stone:import-chatgpt-account-files')
    if (!setLanguage || !importFiles) throw new Error('language and import handlers were not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }

    await setLanguage(event, 'en')
    await importFiles(event, { tagId: null, poolId: null })

    expect(electron.showOpenDialog.mock.calls[0][1]).toMatchObject({
      title: 'Select CPA / Sub2API account JSON files',
      buttonLabel: 'Import and check',
    })
  })

  it('runs fixed network diagnostics through the selected Stone proxy', async () => {
    const proxy = testProxy()
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 401 }))
    const harness = createHarness([oauthAccount()], {}, upstreamFetch, [proxy])
    const handler = electron.handlers.get('stone:run-network-diagnostics')
    if (!handler) throw new Error('run-network-diagnostics handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const report = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      { proxyId: proxy.id }
    ) as { route: { kind: string; proxyId?: string }; results: Array<{ kind: string; status: string }> }

    expect(report.route).toEqual({ kind: 'proxy', name: proxy.name, proxyId: proxy.id })
    expect(report.results.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dns', status: 'skipped' }),
      expect.objectContaining({ kind: 'tls', status: 'skipped' })
    ]))
    expect(upstreamFetch).toHaveBeenCalledTimes(4)
    expect(harness.transport.fetchFor).toHaveBeenCalledWith(proxy, undefined)
  })

  it('detects the Electron system proxy targets through the transport manager', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:detect-system-proxy')
    if (!handler) throw new Error('detect-system-proxy handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const result = await handler({ senderFrame: mainFrame, sender: { mainFrame } })

    expect(result).toMatchObject({ targets: [{ summary: 'DIRECT', reachable: true }] })
    expect(harness.transport.reloadSystemProxyConfiguration).toHaveBeenCalledOnce()
    expect(harness.transport.detectSystemProxy).toHaveBeenCalledWith(expect.arrayContaining([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://api.openai.com/v1/models',
      'https://auth.openai.com/.well-known/openid-configuration',
    ]))
  })

  it('detects only enabled route sources and preserves a custom upstream path for PAC routing', async () => {
    const account = apiKeyAccount()
    const harness = createHarness([account], { [account.credentialId]: 'sk-private' }, vi.fn())
    const snapshot = harness.store.getSnapshot()
    snapshot.providers[0].baseUrl = 'https://relay.example/custom/v1?tenant=stone'
    snapshot.pools.push({
      id: 'pool-custom-relay', name: 'Custom relay', kind: 'standard', protocol: 'openai-responses',
      strategy: 'priority', members: [{ accountId: account.id, enabled: true, order: 0, weight: 1 }],
      modelPolicy: 'all', modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 30,
      maxRetries: 0, forceFastMode: false, createdAt: 1, updatedAt: 1
    })
    const handler = electron.handlers.get('stone:detect-system-proxy')
    if (!handler) throw new Error('detect-system-proxy handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } })
    expect(harness.transport.detectSystemProxy).not.toHaveBeenLastCalledWith(
      expect.arrayContaining(['https://relay.example/custom/v1?tenant=stone'])
    )

    snapshot.routes.push({
      id: 'route-custom-relay', client: 'codex', enabled: true, poolId: provider.id,
      inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'local-token',
      createdAt: 1, updatedAt: 1
    })
    await handler({ senderFrame: mainFrame, sender: { mainFrame } })
    expect(harness.transport.detectSystemProxy).toHaveBeenLastCalledWith(
      expect.arrayContaining(['https://relay.example/custom/v1?tenant=stone'])
    )
  })

  it('accepts a shared outbound reload coordinator without taking ownership of it', async () => {
    const detection = { detectedAt: 9, targets: [] }
    const reload = vi.fn(async () => undefined)
    const detect = vi.fn(async () => detection)
    const shared = new OutboundReloadCoordinator({
      transport: {
        reloadSystemProxyConfiguration: reload,
        detectSystemProxy: detect
      },
      collectTargets: () => new Map()
    })
    const harness = createHarness(
      [oauthAccount()],
      {},
      vi.fn(),
      [],
      { current: 'discovery-fingerprint' },
      {} as ClientConfigService,
      shared
    )
    const handler = electron.handlers.get('stone:detect-system-proxy')
    if (!handler) throw new Error('detect-system-proxy handler was not registered')

    await expect(handler(rendererEvent(404))).resolves.toBe(detection)
    await harness.dispose()
    await expect(shared.detectExternalSystemProxy()).resolves.toBe(detection)
    expect(reload).toHaveBeenCalledTimes(2)
    await shared.close()
  })

  it('repairs client configuration through its selected profile directory', async () => {
    const repair = vi.fn(async () => ({
      client: 'codex' as const,
      rebuiltRoles: ['codex-config' as const],
      changedFiles: ['D:\\profiles\\relay-b\\config.toml'],
      backups: [],
      removedBackups: []
    }))
    const scoped = { repair }
    const clientConfig = {
      withOverrides: vi.fn(() => scoped)
    } as unknown as ClientConfigService
    const harness = createHarness(
      [oauthAccount()],
      {},
      vi.fn(),
      [],
      { current: 'discovery-fingerprint' },
      clientConfig
    )
    const snapshot = harness.store.getSnapshot()
    snapshot.clientProfiles.push({
      id: 'profile-relay-b',
      name: 'Relay B',
      client: 'codex',
      directory: 'D:\\profiles\\relay-b',
      backupRetention: 7,
      isDefault: false,
      createdAt: 1,
      updatedAt: 1
    })
    snapshot.routes.push({
      id: 'route-codex',
      client: 'codex',
      enabled: true,
      poolId: 'pool-codex',
      inboundProtocol: 'openai-responses',
      modelMap: {},
      localToken: 'local-repair-token',
      createdAt: 1,
      updatedAt: 1
    })
    const handler = electron.handlers.get('stone:repair-client-config')
    if (!handler) throw new Error('repair-client-config handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const result = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      'codex',
      'profile-relay-b'
    )

    expect(clientConfig.withOverrides).toHaveBeenCalledWith({ codexDirectory: 'D:\\profiles\\relay-b' })
    expect(repair).toHaveBeenCalledWith(
      'codex',
      { gatewayBaseUrl: 'http://127.0.0.1:15721', token: 'local-repair-token' },
      { backupRetention: 7 }
    )
    expect(result).toMatchObject({ rebuiltRoles: ['codex-config'] })
  })

  it('overlays live account concurrency without persisting it in the store snapshot', async () => {
    const oauth = oauthAccount()
    const harness = createHarness([oauth], {}, vi.fn())
    vi.mocked(harness.gateway.getAccountInFlight).mockReturnValue({ [oauth.id]: 2 })
    const handler = electron.handlers.get('stone:get-snapshot')
    if (!handler) throw new Error('get-snapshot handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const result = await handler({ senderFrame: mainFrame, sender: { mainFrame } }) as AppSnapshot

    expect(result.accounts.find((account) => account.id === oauth.id)?.inFlight).toBe(2)
    expect(harness.store.getSnapshot().accounts.find((account) => account.id === oauth.id)?.inFlight).toBe(0)
  })

  it('applies an outbound mode change without restarting the local gateway', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:update-gateway')
    if (!handler) throw new Error('update-gateway handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } }, {
      host: '127.0.0.1',
      port: 15721,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 120,
      outboundNetworkMode: 'system'
    })

    expect(harness.transport.configureOutboundNetwork).toHaveBeenCalledWith('system', 15721)
    expect(harness.transport.reloadSystemProxyConfiguration).toHaveBeenCalledOnce()
    expect(harness.gateway.stop).not.toHaveBeenCalled()
  })

  it('rechecks failure-cooled accounts on enabled implicit routes after system proxy activation', async () => {
    const account = apiKeyAccount()
    const upstreamFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const harness = createHarness([account], { [account.credentialId]: 'sk-private' }, upstreamFetch)
    const snapshot = harness.store.getSnapshot()
    snapshot.pools.push({
      id: 'pool-system-route', name: 'System route', kind: 'standard', protocol: 'openai-responses',
      strategy: 'priority', members: [{ accountId: account.id, enabled: true, order: 0, weight: 1 }],
      modelPolicy: 'all', modelAllowlist: [], stickySessions: false, stickyTtlMinutes: 30,
      maxRetries: 0, forceFastMode: false, createdAt: 1, updatedAt: 1
    })
    snapshot.routes.push({
      id: 'route-system', client: 'codex', enabled: true, poolId: 'pool-system-route',
      inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'local-token',
      createdAt: 1, updatedAt: 1
    })
    Object.assign(account, {
      status: 'cooldown' as const,
      circuitState: 'open' as const,
      cooldownReason: 'failure' as const,
      cooldownUntil: Date.now() + 60_000,
      consecutiveFailures: 2,
      lastError: 'old direct-route failure'
    })
    const handler = electron.handlers.get('stone:update-gateway')
    if (!handler) throw new Error('update-gateway handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } }, {
      host: '127.0.0.1', port: 15721, autoStart: false, logPayloads: false,
      requestTimeoutSeconds: 120, outboundNetworkMode: 'system'
    })

    await vi.waitFor(() => expect(account).toMatchObject({
      status: 'active', circuitState: 'closed', consecutiveFailures: 0
    }))
    expect(account.cooldownReason).toBeUndefined()
    expect(upstreamFetch).toHaveBeenCalledOnce()
    await harness.dispose()
  })

  it('serializes concurrent gateway setting updates across the complete restart lifecycle', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:update-gateway')
    if (!handler) throw new Error('update-gateway handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }
    harness.store.getSnapshot().gatewayStatus.running = true
    let releaseFirstStop!: () => void
    vi.mocked(harness.gateway.stop).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirstStop = resolve })
    })
    const gatewaySettings = (port: number) => ({
      host: '127.0.0.1',
      port,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 120,
    })

    const first = handler(event, gatewaySettings(15722)) as Promise<AppSnapshot>
    await vi.waitFor(() => expect(harness.gateway.stop).toHaveBeenCalledOnce())
    const second = handler(event, gatewaySettings(15723)) as Promise<AppSnapshot>
    await Promise.resolve()

    expect(harness.store.updateGateway).toHaveBeenCalledOnce()
    expect(harness.gateway.start).not.toHaveBeenCalled()
    releaseFirstStop()
    await Promise.all([first, second])

    expect(harness.store.updateGateway).toHaveBeenCalledTimes(2)
    expect(harness.gateway.stop).toHaveBeenCalledTimes(2)
    expect(harness.gateway.start).toHaveBeenCalledTimes(2)
    expect(harness.store.getSnapshot().gateway.port).toBe(15723)
    expect(vi.mocked(harness.gateway.start).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(harness.store.updateGateway).mock.invocationCallOrder[1])
  })

  it('continues the gateway lifecycle queue after an earlier update fails', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:update-gateway')
    if (!handler) throw new Error('update-gateway handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }
    harness.store.getSnapshot().gatewayStatus.running = true
    vi.mocked(harness.gateway.stop).mockRejectedValueOnce(new Error('temporary stop failure'))
    const gatewaySettings = (port: number) => ({
      host: '127.0.0.1',
      port,
      autoStart: false,
      logPayloads: false,
      requestTimeoutSeconds: 120,
    })

    const first = handler(event, gatewaySettings(15722)) as Promise<AppSnapshot>
    const second = handler(event, gatewaySettings(15723)) as Promise<AppSnapshot>

    await expect(first).rejects.toThrow('temporary stop failure')
    await expect(second).resolves.toMatchObject({ gateway: { port: 15723 } })
    expect(harness.store.updateGateway).toHaveBeenCalledTimes(2)
    expect(harness.gateway.stop).toHaveBeenCalledTimes(2)
    expect(harness.gateway.start).toHaveBeenCalledOnce()
  })

  it('forwards an explicit Responses compact capability through save-provider IPC', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:save-provider')
    if (!handler) throw new Error('save-provider handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const input = {
      id: provider.id,
      name: 'Relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-responses',
      models: [],
      responsesCompactMode: 'passthrough'
    }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } }, input)

    expect(harness.store.saveProvider).toHaveBeenCalledWith(input)
    expect(harness.gateway.updateConfig).toHaveBeenCalled()
    expect(harness.store.getSnapshot().providers[0]).toMatchObject({
      sourceType: 'relay',
      responsesCompactMode: 'passthrough'
    })
  })

  it('forwards an explicit Responses compact capability through the current API-source IPC', async () => {
    const account = apiKeyAccount()
    const harness = createHarness([account], {}, vi.fn())
    const handler = electron.handlers.get('stone:save-api-source')
    if (!handler) throw new Error('save-api-source handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const input = {
      id: provider.id,
      name: 'Relay',
      sourceType: 'relay',
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-responses',
      models: [],
      priority: 1,
      weight: 1,
      maxConcurrency: 1,
      responsesCompactMode: 'native'
    }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } }, input)

    expect(harness.store.saveApiSource).toHaveBeenCalledWith(input)
    expect(harness.store.getSnapshot().providers[0]).toMatchObject({ responsesCompactMode: 'native' })
    expect(harness.gateway.updateConfig).toHaveBeenCalled()
  })

  it('applies a FAST source toggle and refreshes the live gateway configuration', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:set-route-source-fast-mode')
    if (!handler) throw new Error('set-route-source-fast-mode handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      { sourceId: 'pool-fast', enabled: true }
    )

    expect(harness.store.setRouteSourceFastMode).toHaveBeenCalledWith({ sourceId: 'pool-fast', enabled: true })
    expect(harness.gateway.updateConfig).toHaveBeenCalled()
    expect(harness.runtimeChanged).toHaveBeenCalled()
  })

  it('switches a client route source atomically and refreshes the live gateway', async () => {
    const account = apiKeyAccount()
    const harness = createHarness([account], { [account.credentialId]: 'sk-private' }, vi.fn())
    const snapshot = harness.store.getSnapshot()
    snapshot.routes.push({
      id: 'route-codex',
      client: 'codex',
      enabled: true,
      poolId: 'previous-source',
      inboundProtocol: 'openai-responses',
      modelMap: { alias: 'upstream-model' },
      localToken: 'stable-local-token',
      createdAt: 1,
      updatedAt: 1
    })
    const handler = electron.handlers.get('stone:set-client-route-source')
    if (!handler) throw new Error('set-client-route-source handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      { client: 'codex', sourceId: `  ${provider.id}  ` }
    )

    expect(harness.store.setRouteSource).toHaveBeenCalledWith('codex', provider.id)
    expect(snapshot.routes[0]).toMatchObject({
      poolId: provider.id,
      modelMap: { alias: 'upstream-model' },
      localToken: 'stable-local-token'
    })
    expect(harness.gateway.updateConfig).toHaveBeenCalled()
    expect(harness.runtimeChanged).toHaveBeenCalled()
  })

  it('rejects missing, colliding, and unavailable client route sources before mutation', async () => {
    const account = { ...apiKeyAccount(), status: 'disabled' as const }
    const harness = createHarness([account], { [account.credentialId]: 'sk-private' }, vi.fn())
    const snapshot = harness.store.getSnapshot()
    snapshot.routes.push({
      id: 'route-codex', client: 'codex', enabled: true, poolId: 'previous-source',
      inboundProtocol: 'openai-responses', modelMap: {}, localToken: 'stable-local-token',
      createdAt: 1, updatedAt: 1
    })
    const handler = electron.handlers.get('stone:set-client-route-source')
    if (!handler) throw new Error('set-client-route-source handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }

    expect(() => handler(event, { client: 'codex', sourceId: 'missing-source' }))
      .toThrow(/不存在/)
    expect(() => handler(event, { client: 'codex', sourceId: provider.id }))
      .toThrow(/没有可用账号/)

    snapshot.pools.push({
      id: 'unavailable-pool',
      name: 'Unavailable pool',
      kind: 'standard',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [{ accountId: account.id, enabled: true, order: 0, weight: 1 }],
      modelPolicy: 'all',
      modelAllowlist: [],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0,
      createdAt: 1,
      updatedAt: 1
    })
    expect(() => handler(event, { client: 'codex', sourceId: 'unavailable-pool' }))
      .toThrow(/没有可用账号/)

    snapshot.pools.push({
      id: provider.id,
      name: 'Colliding pool',
      kind: 'standard',
      protocol: 'openai-responses',
      strategy: 'priority',
      members: [{ accountId: account.id, enabled: true, order: 0, weight: 1 }],
      modelPolicy: 'all',
      modelAllowlist: [],
      stickySessions: false,
      stickyTtlMinutes: 30,
      maxRetries: 0,
      createdAt: 1,
      updatedAt: 1
    })
    expect(() => handler(event, { client: 'codex', sourceId: provider.id }))
      .toThrow(/冲突/)
    expect(harness.store.setRouteSource).not.toHaveBeenCalled()
  })

  it('detects a pasted batch through the final selected account proxy', async () => {
    electron.getLocale.mockReturnValue('en-US')
    const oauth = oauthAccount()
    const proxy = testProxy()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: { allowed: true, limit_reached: false },
      models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch, [proxy])
    const handler = electron.handlers.get('stone:import-chatgpt-accounts')
    if (!handler) throw new Error('import-chatgpt-accounts handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const send = vi.fn()
    const sender = { mainFrame, send, isDestroyed: () => false }

    const result = await handler({ senderFrame: mainFrame, sender }, {
      content: '{"access_token":"redacted-by-mock"}',
      tagId: 'tag-plus',
      poolId: 'pool-codex',
      proxyMode: 'proxy',
      proxyId: proxy.id,
      progressId: 'paste-import-progress'
    }) as {
      detectionResults: Array<{ ok: boolean; availableModelCount?: number }>
      assignmentSummary: { tagId: string | null; poolId: string | null; poolMembersAdded: number }
    }

    expect(result.detectionResults).toEqual([expect.objectContaining({ ok: true, availableModelCount: 2 })])
    expect(result.assignmentSummary).toMatchObject({ tagId: 'tag-plus', poolId: 'pool-codex', poolMembersAdded: 1 })
    expect(harness.store.addDetectedChatGptAccountsToPool).toHaveBeenCalledWith('pool-codex', [oauth.id])
    expect(harness.transport.fetchFor).toHaveBeenCalledWith(proxy, undefined)
    expect(harness.store.importChatGptAccounts).toHaveBeenCalledWith(expect.objectContaining({
      proxyMode: 'proxy', proxyId: proxy.id
    }))
    expect(harness.store.setAccountModels).toHaveBeenCalledWith(
      oauth.id,
      ['gpt-5.6-sol', 'gpt-5.6-terra'],
      expect.any(String)
    )
    const progressEvents = send.mock.calls.filter(([channel]) => channel === 'stone:account-import-progress').map(([, progress]) => progress)
    expect(progressEvents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ progressId: 'paste-import-progress', phase: 'importing', percent: 0 }),
        expect.objectContaining({ progressId: 'paste-import-progress', phase: 'importing', percent: 50 }),
        expect.objectContaining({ progressId: 'paste-import-progress', phase: 'refreshing', percent: 100 }),
        expect.objectContaining({ progressId: 'paste-import-progress', phase: 'complete', percent: 100 })
      ]))
    expect(progressEvents.every((progress) => !/[\u3400-\u9fff]/u.test(progress.message))).toBe(true)
  })

  it('exchanges OAuth through the selected proxy and only returns the sanitized import result', async () => {
    const oauth = oauthAccount()
    const proxy = testProxy()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: { allowed: true, limit_reached: false },
      models: [{ slug: 'gpt-5.6-sol' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch, [proxy])
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const open = electron.handlers.get('stone:open-chatgpt-oauth')
    const submit = electron.handlers.get('stone:submit-chatgpt-oauth-callback')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    if (!start || !open || !submit || !wait) throw new Error('OAuth IPC handlers were not registered')
    const event = rendererEvent(101)

    try {
      const started = await start(event, {
        name: 'OAuth imported',
        tagId: 'tag-plus',
        poolId: 'pool-deleted-during-oauth',
        proxyMode: 'proxy',
        proxyId: proxy.id
      }) as { sessionId: string; authorizationUrl: string }
      await open(event, started.sessionId)
      await submit(event, {
        sessionId: started.sessionId,
        callbackUrl: 'http://localhost:1455/auth/callback?code=public-code&state=public-state'
      })
      vi.mocked(harness.store.addDetectedChatGptAccountsToPool).mockRejectedValueOnce(new Error('Pool not found.'))
      const result = await wait(event, started.sessionId) as {
        assignmentSummary: { tagId: string | null; poolId: string | null; poolAppendError?: string }
      }

      expect(harness.oauthFlow.open).toHaveBeenCalledWith('oauth-session')
      expect(harness.oauthFlow.submitCallback).toHaveBeenCalledWith(
        'oauth-session',
        expect.stringContaining('code=public-code')
      )
      expect(harness.oauthFlow.wait).toHaveBeenCalledWith('oauth-session', expect.any(Function))
      expect(harness.transport.fetchFor).toHaveBeenCalledWith(proxy, undefined)
      expect(harness.store.importChatGptAccounts).toHaveBeenCalledWith(expect.objectContaining({
        name: 'OAuth imported',
        tagId: 'tag-plus',
        // Membership happens after detection so deleting a pool does not lose
        // the freshly exchanged OAuth account.
        poolId: null,
        proxyMode: 'proxy',
        proxyId: proxy.id
      }))
      expect(result.assignmentSummary).toMatchObject({
        tagId: 'tag-plus',
        poolId: 'pool-deleted-during-oauth',
        poolAppendError: 'Pool not found.'
      })
      expect(JSON.stringify(result)).not.toContain('oauth-access-exchanged-private')
      expect(JSON.stringify(result)).not.toContain('oauth-refresh-exchanged-private')
      expect(JSON.stringify(result)).not.toContain('oauth-id-exchanged-private')
    } finally {
      await harness.dispose()
    }
  })

  it('passes the selected renderer language to the OAuth loopback flow', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const setLanguage = electron.handlers.get('stone:set-ui-language')
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    if (!setLanguage || !start) throw new Error('language and OAuth handlers were not registered')
    const event = rendererEvent(109)

    try {
      await setLanguage(event, 'en')
      await start(event, { name: '', tagId: null, poolId: null })
      expect(harness.oauthFlow.start).toHaveBeenCalledWith('en')
    } finally {
      await harness.dispose()
    }
  })

  it('does not persist exchanged credentials when OAuth is cancelled during token exchange', async () => {
    const oauth = oauthAccount()
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, vi.fn())
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    const cancel = electron.handlers.get('stone:cancel-chatgpt-oauth')
    if (!start || !wait || !cancel) throw new Error('OAuth IPC handlers were not registered')
    const event = rendererEvent(102)
    let finishExchange: (() => void) | undefined
    let disposed = false
    vi.mocked(harness.oauthFlow.wait).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishExchange = resolve })
      return {
        accessToken: 'cancelled-access-private',
        refreshToken: 'cancelled-refresh-private',
        idToken: 'cancelled-id-private',
        accountId: 'acct-cancelled',
        expiresAt: Date.now() + 3_600_000
      }
    })

    try {
      const started = await start(event, {
        tagId: null,
        poolId: null,
        proxyMode: 'direct'
      }) as { sessionId: string }
      const waiting = Promise.resolve(wait(event, started.sessionId))
      await vi.waitFor(() => expect(finishExchange).toBeTypeOf('function'))
      expect(cancel(event, started.sessionId)).toBe(true)
      const disposing = harness.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      finishExchange?.()

      await expect(waiting).rejects.toThrow('OAuth 授权已取消')
      await disposing
      expect(disposed).toBe(true)
      expect(harness.store.importChatGptAccounts).not.toHaveBeenCalled()
      expect(harness.oauthFlow.cancel).toHaveBeenCalledWith(started.sessionId)
    } finally {
      finishExchange?.()
      if (!disposed) await harness.dispose()
    }
  })

  it('binds every OAuth session to its renderer owner and cancels it when that owner exits', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const open = electron.handlers.get('stone:open-chatgpt-oauth')
    const submit = electron.handlers.get('stone:submit-chatgpt-oauth-callback')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    const cancel = electron.handlers.get('stone:cancel-chatgpt-oauth')
    if (!start || !open || !submit || !wait || !cancel) throw new Error('OAuth IPC handlers were not registered')
    const owner = rendererEvent(201)
    const stranger = rendererEvent(202)

    try {
      const started = await start(owner, { tagId: null, poolId: null, proxyMode: 'direct' }) as { sessionId: string }

      await expect(open(stranger, started.sessionId)).rejects.toThrow('不属于当前窗口')
      expect(() => submit(stranger, { sessionId: started.sessionId, callbackUrl: 'http://localhost/callback' }))
        .toThrow('不属于当前窗口')
      expect(() => wait(stranger, started.sessionId)).toThrow('不属于当前窗口')
      expect(() => cancel(stranger, started.sessionId)).toThrow('不属于当前窗口')
      expect(harness.oauthFlow.cancel).not.toHaveBeenCalled()

      owner.sender.crashForTest()
      expect(harness.oauthFlow.cancel).toHaveBeenCalledWith(started.sessionId)
      expect(() => wait(owner, started.sessionId)).toThrow('不存在或不属于当前窗口')
      expect(owner.sender.listenerCount('destroyed')).toBe(0)
      expect(owner.sender.listenerCount('render-process-gone')).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  it('cancels a newly-created flow when its renderer exits while start is binding loopback', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    if (!start) throw new Error('OAuth start IPC handler was not registered')
    const owner = rendererEvent(206)
    let finishStart: (() => void) | undefined
    vi.mocked(harness.oauthFlow.start).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishStart = resolve })
      return {
        sessionId: 'oauth-start-race',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=public',
        redirectUri: 'http://localhost:1455/auth/callback',
        expiresAt: Date.now() + 600_000,
        loopbackListening: true,
        status: 'waiting'
      }
    })

    try {
      const starting = Promise.resolve(start(owner, { tagId: null, poolId: null, proxyMode: 'direct' }))
      await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'))
      owner.sender.crashForTest()
      finishStart?.()

      await expect(starting).rejects.toThrow('OAuth 授权窗口已经关闭')
      expect(harness.oauthFlow.cancel).toHaveBeenCalledWith('oauth-start-race')
      expect(owner.sender.listenerCount('destroyed')).toBe(0)
      expect(owner.sender.listenerCount('render-process-gone')).toBe(0)
    } finally {
      finishStart?.()
      await harness.dispose()
    }
  })

  it('makes cancellation non-destructive after the OAuth persistence commit boundary', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: { allowed: true, limit_reached: false },
      models: [{ slug: 'gpt-5.6-sol' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    const cancel = electron.handlers.get('stone:cancel-chatgpt-oauth')
    if (!start || !wait || !cancel) throw new Error('OAuth IPC handlers were not registered')
    const owner = rendererEvent(203)
    const importAccount = vi.mocked(harness.store.importChatGptAccounts)
    const persist = importAccount.getMockImplementation()
    if (!persist) throw new Error('Import mock has no implementation')
    let continueCommit: (() => void) | undefined
    importAccount.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => { continueCommit = resolve })
      return persist(input)
    })
    let disposed = false

    try {
      const started = await start(owner, { tagId: null, poolId: null, proxyMode: 'direct' }) as { sessionId: string }
      const waiting = Promise.resolve(wait(owner, started.sessionId))
      await vi.waitFor(() => expect(continueCommit).toBeTypeOf('function'))

      expect(cancel(owner, started.sessionId)).toBe(false)
      expect(harness.oauthFlow.cancel).not.toHaveBeenCalled()
      const disposing = harness.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)

      continueCommit?.()
      await expect(waiting).resolves.toMatchObject({ importedAccountIds: [oauth.id] })
      await disposing
      expect(disposed).toBe(true)
      expect(importAccount).toHaveBeenCalledOnce()
    } finally {
      continueCommit?.()
      if (!disposed) await harness.dispose()
    }
  })

  it('falls back to an untagged import when the selected Tag is deleted during OAuth', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: { allowed: true, limit_reached: false },
      models: [{ slug: 'gpt-5.6-sol' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    if (!start || !wait) throw new Error('OAuth IPC handlers were not registered')
    const owner = rendererEvent(204)

    try {
      const started = await start(owner, { tagId: 'tag-plus', poolId: null, proxyMode: 'direct' }) as { sessionId: string }
      harness.store.getSnapshot().accountTags = []
      const result = await wait(owner, started.sessionId) as {
        warnings: string[]
        assignmentSummary: { tagId: string | null }
      }

      expect(harness.store.importChatGptAccounts).toHaveBeenCalledWith(expect.objectContaining({ tagId: null }))
      expect(result.assignmentSummary.tagId).toBeNull()
      expect(result.warnings).toContain('OAuth 授权期间所选 Tag 已被删除，账号已按“未标记”导入。')
    } finally {
      await harness.dispose()
    }
  })

  it('resolves the selected proxy lazily and reports deletion before token persistence', async () => {
    const oauth = oauthAccount()
    const proxy = testProxy()
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, vi.fn(), [proxy])
    const start = electron.handlers.get('stone:start-chatgpt-oauth')
    const wait = electron.handlers.get('stone:wait-chatgpt-oauth')
    if (!start || !wait) throw new Error('OAuth IPC handlers were not registered')
    const owner = rendererEvent(205)

    try {
      const started = await start(owner, {
        tagId: null,
        poolId: null,
        proxyMode: 'proxy',
        proxyId: proxy.id
      }) as { sessionId: string }
      harness.store.getSnapshot().proxies = []

      await expect(wait(owner, started.sessionId)).rejects.toThrow('选择的代理已被删除')
      expect(harness.transport.fetchFor).not.toHaveBeenCalled()
      expect(harness.store.importChatGptAccounts).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('rejects a file batch when its selected proxy was deleted before confirmation', async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\accounts\\batch.json'] })
    const harness = createHarness([oauthAccount()], {}, vi.fn(), [])
    const handler = electron.handlers.get('stone:import-chatgpt-account-files')
    if (!handler) throw new Error('import-chatgpt-account-files handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await expect(handler({ senderFrame: mainFrame, sender: { mainFrame } }, {
      tagId: null,
      poolId: null,
      proxyMode: 'proxy',
      proxyId: 'proxy-deleted-after-modal-open'
    })).rejects.toThrow('代理已被删除')

    expect(harness.store.importChatGptAccounts).not.toHaveBeenCalled()
  })

  it('coalesces rapid request-log deltas without building a full snapshot', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    electron.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { send }
    }])
    try {
      const harness = createHarness([oauthAccount()], {}, vi.fn())
      const log = {
        id: 'log', timestamp: Date.now(), client: 'codex', protocol: 'openai-responses',
        providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'streaming', latencyMs: 10
      } satisfies RequestLog
      harness.emitLog(log)
      harness.emitLog({ ...log, id: 'log-2' })
      await Promise.resolve()
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(50)
      expect(send).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith('stone:runtime-delta', expect.objectContaining({
        requestLogs: [expect.objectContaining({ id: 'log' }), expect.objectContaining({ id: 'log-2' })]
      }))
      expect(harness.store.appendLog).toHaveBeenCalledTimes(2)
      expect(harness.gateway.updateConfig).not.toHaveBeenCalled()
      expect(harness.runtimeChanged).not.toHaveBeenCalled()
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
  })

  it('checkpoints long live requests once per interval instead of persisting every progress event', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness([oauthAccount()], {}, vi.fn())
      const needsCheckpoint = vi.mocked(harness.store.hasUncheckpointedLiveRequestLogs)
      const checkpoint = vi.mocked(harness.store.checkpointLiveRequestLogs)
      needsCheckpoint.mockReturnValue(true)
      checkpoint.mockImplementation(async () => {
        needsCheckpoint.mockReturnValue(false)
        return 1
      })
      const log = {
        id: 'long-live-log', timestamp: Date.now(), client: 'codex', protocol: 'openai-responses',
        providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'streaming', latencyMs: 10
      } satisfies RequestLog

      for (let index = 0; index < 100; index += 1) {
        harness.emitLog({ ...log, latencyMs: index })
      }
      expect(harness.store.appendLog).toHaveBeenCalledTimes(100)
      expect(checkpoint).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(9_999)
      expect(checkpoint).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(checkpoint).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes live account concurrency changes with a short trailing update', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    electron.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { send }
    }])
    try {
      const oauth = oauthAccount()
      const harness = createHarness([oauth], {}, vi.fn())
      vi.mocked(harness.gateway.getAccountInFlight).mockReturnValue({ [oauth.id]: 1 })

      harness.emitRuntimeState()
      expect(send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0][1].accounts.find((account: Account) => account.id === oauth.id)?.inFlight).toBe(1)

      vi.mocked(harness.gateway.getAccountInFlight).mockReturnValue({ [oauth.id]: 0 })
      harness.emitRuntimeState()
      await vi.advanceTimersByTimeAsync(49)
      expect(send).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][1].accounts.find((account: Account) => account.id === oauth.id)?.inFlight).toBe(0)
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
  })

  it('does not build or send live and terminal telemetry while the renderer is hidden', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    electron.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      webContents: { send }
    }])
    try {
      const harness = createHarness([oauthAccount()], {}, vi.fn())
      const getSnapshot = electron.handlers.get('stone:get-snapshot')
      if (!getSnapshot) throw new Error('get-snapshot handler was not registered')
      const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
      const event = { senderFrame: mainFrame, sender: { mainFrame } }
      const before = await getSnapshot(event) as AppSnapshot
      const appendLog = vi.mocked(harness.store.appendLog)
      appendLog.mockImplementation(async (log) => {
        const snapshot = harness.store.getSnapshot()
        const index = snapshot.requestLogs.findIndex((candidate) => candidate.id === log.id)
        if (index >= 0) snapshot.requestLogs[index] = log
        else snapshot.requestLogs.unshift(log)
        return log
      })
      const liveLog = {
        id: 'hidden-log', timestamp: Date.now(), startedAt: Date.now(), client: 'codex', protocol: 'openai-responses',
        providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'streaming', latencyMs: 10
      } satisfies RequestLog
      harness.emitLog(liveLog)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(send).not.toHaveBeenCalled()

      harness.emitLog({ ...liveLog, timestamp: Date.now() + 20, status: 'success', statusCode: 200, latencyMs: 30 })
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)

      expect(send).not.toHaveBeenCalled()
      const after = await getSnapshot(event) as AppSnapshot
      expect(after.runtimeRevision).toBeGreaterThan(before.runtimeRevision ?? -1)
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
  })

  it('retries a failed terminal write and publishes completion only after it is durable', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    electron.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send }
    }])
    try {
      const harness = createHarness([oauthAccount()], {}, vi.fn())
      const appendLog = vi.mocked(harness.store.appendLog)
      appendLog.mockRejectedValueOnce(new Error('database busy')).mockImplementation(async (log) => log)
      const terminal = {
        id: 'durable-terminal', timestamp: Date.now(), startedAt: Date.now(),
        client: 'codex', protocol: 'openai-responses', providerName: 'OpenAI',
        accountName: 'Account', model: 'gpt', status: 'success', statusCode: 200, latencyMs: 10
      } satisfies RequestLog

      harness.emitLog(terminal)
      await Promise.resolve()
      expect(send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(249)
      expect(appendLog).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(50)

      expect(appendLog).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledWith('stone:runtime-delta', expect.objectContaining({
        requestLogs: [expect.objectContaining({ id: terminal.id, status: 'success' })]
      }))
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
  })

  it('tombstones pending terminal ids when logs are cleared and ignores their late completion', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const appendLog = vi.mocked(harness.store.appendLog)
    let resolveWrite!: (log: RequestLog | undefined) => void
    appendLog.mockReturnValueOnce(new Promise((resolve) => { resolveWrite = resolve }))
    const terminal = {
      id: 'clear-pending-terminal', timestamp: Date.now(), startedAt: Date.now(),
      client: 'codex', protocol: 'openai-responses', providerName: 'OpenAI',
      accountName: 'Account', model: 'gpt', status: 'success', statusCode: 200, latencyMs: 10
    } satisfies RequestLog
    harness.emitLog(terminal)
    const clear = electron.handlers.get('stone:clear-logs')
    if (!clear) throw new Error('clear-logs handler was not registered')

    await clear(rendererEvent(301))
    expect(harness.store.clearLogs).toHaveBeenCalledWith(['clear-pending-terminal'])
    resolveWrite(terminal)
    await Promise.resolve()
    await Promise.resolve()
    expect(appendLog).toHaveBeenCalledOnce()
    await harness.dispose()
  })

  it('retries terminal durability during shutdown and unsubscribes every gateway listener', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const appendLog = vi.mocked(harness.store.appendLog)
    appendLog
      .mockRejectedValueOnce(new Error('database busy before shutdown'))
      .mockRejectedValueOnce(new Error('database busy during shutdown'))
      .mockImplementation(async (log) => log)
    const terminal = {
      id: 'shutdown-retry-terminal', timestamp: Date.now(), startedAt: Date.now(),
      client: 'codex', protocol: 'openai-responses', providerName: 'OpenAI',
      accountName: 'Account', model: 'gpt', status: 'success', statusCode: 200, latencyMs: 10
    } satisfies RequestLog
    try {
      harness.emitLog(terminal)
      await vi.waitFor(() => expect(appendLog).toHaveBeenCalledOnce())
      await harness.dispose()

      expect(appendLog).toHaveBeenCalledTimes(3)
      expect(appendLog.mock.calls.at(-1)?.[0]).toEqual(terminal)
      expect(harness.unsubscribers.log).toHaveBeenCalledOnce()
      expect(harness.unsubscribers.accountState).toHaveBeenCalledOnce()
      expect(harness.unsubscribers.runtimeState).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('reconciles orphaned live logs only after pending terminal writes settle', async () => {
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const appendLog = vi.mocked(harness.store.appendLog)
    const finalize = vi.mocked(harness.store.finalizeOrphanedStreamingLogs)
    appendLog.mockImplementation(async (log) => log)
    finalize.mockResolvedValue([{
      id: 'possibly-orphaned', timestamp: Date.now(), client: 'codex', protocol: 'openai-responses',
      providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'error', latencyMs: 10
    }])

    harness.emitLog({
      id: 'possibly-orphaned',
      timestamp: Date.now(),
      startedAt: Date.now(),
      client: 'codex',
      protocol: 'openai-responses',
      providerName: 'OpenAI',
      accountName: 'Account',
      model: 'gpt',
      status: 'success',
      statusCode: 200,
      latencyMs: 10
    })
    harness.emitRuntimeState()

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce())
    expect(appendLog.mock.invocationCallOrder[0]).toBeLessThan(finalize.mock.invocationCallOrder[0])
  })

  it('coalesces routine active account telemetry without refreshing gateway config', async () => {
    vi.useFakeTimers()
    try {
      const oauth = oauthAccount()
      const harness = createHarness([oauth], {}, vi.fn())
      harness.emitAccountState(activeAccountState(oauth.id, 100, 1_000))
      harness.emitAccountState(activeAccountState(oauth.id, 80, 2_000))

      await vi.advanceTimersByTimeAsync(249)
      expect(harness.store.updateAccountRuntimeState).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.store.updateAccountRuntimeStates).toHaveBeenCalledOnce()
      expect(harness.store.updateAccountRuntimeStates).toHaveBeenCalledWith([
        expect.objectContaining({
          id: oauth.id,
          patch: expect.objectContaining({ latencyMs: 80, lastUsedAt: 2_000 })
        })
      ])
      expect(harness.gateway.updateConfig).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('patches quota on the affected gateway account without replaying full history', async () => {
    vi.useFakeTimers()
    try {
      const oauth = oauthAccount()
      const harness = createHarness([oauth], {}, vi.fn())
      harness.emitAccountState({
        ...activeAccountState(oauth.id, 80, 2_000),
        quota: {
          requests: { limit: 100, remaining: 75 },
          observedAt: 2_000
        }
      })

      await vi.advanceTimersByTimeAsync(250)

      expect(harness.gateway.updateRuntimeAccounts).toHaveBeenCalledOnce()
      expect(harness.gateway.updateRuntimeAccounts).toHaveBeenCalledWith([
        expect.objectContaining({ id: oauth.id })
      ])
      expect(harness.gateway.updateConfig).not.toHaveBeenCalled()
      expect(harness.store.getAccountFitnessHistory).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes all non-quota accounts once when they are collectively cooling down', async () => {
    const first = apiKeyAccount()
    const second = {
      ...apiKeyAccount(),
      id: 'account-api-key-2',
      name: 'OpenAI API key 2',
      credentialId: 'credential-api-key-2'
    }
    const exhausted = {
      ...oauthAccount(),
      id: 'account-quota-exhausted',
      credentialId: 'credential-quota-exhausted',
      status: 'cooldown' as const,
      circuitState: 'open' as const,
      cooldownReason: 'quota' as const,
      cooldownUntil: Date.now() + 60_000
    }
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 503 }))
    const harness = createHarness(
      [first, second, exhausted],
      {
        [first.credentialId]: 'sk-first',
        [second.credentialId]: 'sk-second',
        [exhausted.credentialId]: oauthCredential()
      },
      upstreamFetch
    )
    const cooldownState = (accountId: string): GatewayAccountState => ({
      accountId,
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 1,
      cooldownReason: 'failure',
      cooldownUntil: Date.now() + 30_000,
      lastError: 'Temporary upstream failure'
    })

    harness.emitAccountState(cooldownState(first.id))
    harness.emitAccountState(cooldownState(second.id))

    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2))
    expect(harness.store.setAccountCheckResult).toHaveBeenCalledWith(first.id, expect.objectContaining({ status: 'checking' }))
    expect(harness.store.setAccountCheckResult).toHaveBeenCalledWith(second.id, expect.objectContaining({ status: 'checking' }))
    expect(harness.store.setAccountCheckResult).not.toHaveBeenCalledWith(exhausted.id, expect.anything())

    // Failed automatic probes leave the group cooled, but must not create a
    // self-sustaining retry loop or repeat on duplicate cooldown telemetry.
    harness.emitAccountState(cooldownState(first.id))
    harness.emitAccountState(cooldownState(second.id))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('cools an exhausted OAuth account until the reset reported by the usage probe', async () => {
    const oauth = oauthAccount()
    const resetAfterSeconds = 3_600
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: resetAfterSeconds },
        secondary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_after_seconds: 86_400 }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)
    void harness
    const handler = electron.handlers.get('stone:refresh-account-codex-quota')
    if (!handler) throw new Error('refresh-account-codex-quota handler was not registered')
    const before = Date.now()
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    await handler({ senderFrame: mainFrame, sender: { mainFrame } }, oauth.id)

    expect(oauth).toMatchObject({
      status: 'cooldown',
      circuitState: 'open',
      cooldownReason: 'quota'
    })
    expect(oauth.cooldownUntil).toBeGreaterThanOrEqual(before + resetAfterSeconds * 1_000)
    expect(oauth.cooldownUntil).toBeLessThanOrEqual(Date.now() + resetAfterSeconds * 1_000)
  })

  it('runs bulk account checks as a durable credential-free task', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 30, limit_window_seconds: 604_800 }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)
    const handler = electron.handlers.get('stone:start-account-check-task')
    if (!handler) throw new Error('start-account-check-task handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const started = await handler({ senderFrame: mainFrame, sender: { mainFrame } }, [oauth.id]) as PersistentTask
    await vi.waitFor(() => expect(harness.taskRunner.get(started.id)?.status).toBe('completed'))
    const completed = harness.taskRunner.get(started.id)!
    expect(completed).toMatchObject({
      kind: 'account.bulk-check',
      status: 'completed',
      payload: { accountIds: [oauth.id] },
      result: { checked: 1, succeeded: 1, failed: 0, skipped: 0 },
      progress: { completed: 1, total: 1, percent: 100 }
    })
    expect(JSON.stringify(completed.payload)).not.toContain('oauth-access-private')
  })

  it('checks quota-exhausted accounts after non-exhausted accounts', async () => {
    const available = apiKeyAccount()
    const exhausted = {
      ...apiKeyAccount(),
      id: 'account-api-key-exhausted',
      name: 'Exhausted API key',
      credentialId: 'credential-api-key-exhausted',
      status: 'cooldown' as const,
      circuitState: 'open' as const,
      cooldownReason: 'quota' as const,
      quotaRemaining: 0,
      quotaUnit: 'percent' as const,
    }
    const upstreamFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const harness = createHarness(
      [exhausted, available],
      {
        [available.credentialId]: 'sk-available',
        [exhausted.credentialId]: 'sk-exhausted',
      },
      upstreamFetch,
    )
    const handler = electron.handlers.get('stone:start-account-check-task')
    if (!handler) throw new Error('start-account-check-task handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const started = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      [exhausted.id, available.id],
    ) as PersistentTask
    await vi.waitFor(() => expect(harness.taskRunner.get(started.id)?.status).toBe('completed'))

    const completed = harness.taskRunner.get(started.id)!
    expect(completed).toMatchObject({
      payload: { accountIds: [available.id, exhausted.id] },
      result: { checked: 2, succeeded: 2, failed: 0, skipped: 0 },
    })
    const checkingOrder = vi.mocked(harness.store.setAccountCheckResult).mock.calls
      .filter(([, patch]) => (patch as Partial<Account>).status === 'checking')
      .map(([id]) => id)
    expect(checkingOrder).toEqual([available.id, exhausted.id])
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('starts a bulk check when every selected account is quota exhausted', async () => {
    const exhausted = {
      ...oauthAccount(),
      status: 'cooldown' as const,
      circuitState: 'open' as const,
      cooldownReason: 'quota' as const,
      codexQuota: {
        allowed: false,
        limitReached: true,
        fiveHour: { usedPercent: 100, resetAt: Date.now() + 3_600_000 },
        observedAt: Date.now(),
      },
    }
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness(
      [exhausted],
      { [exhausted.credentialId]: oauthCredential() },
      upstreamFetch,
    )
    const handler = electron.handlers.get('stone:start-account-check-task')
    if (!handler) throw new Error('start-account-check-task handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const started = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      [exhausted.id],
    ) as PersistentTask
    await vi.waitFor(() => expect(harness.taskRunner.get(started.id)?.status).toBe('completed'))

    expect(harness.taskRunner.get(started.id)).toMatchObject({
      payload: { accountIds: [exhausted.id] },
      result: { checked: 1, succeeded: 0, failed: 1, skipped: 0 },
    })
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight durable account probe without recording a health failure', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)
    const handler = electron.handlers.get('stone:start-account-check-task')
    if (!handler) throw new Error('start-account-check-task handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const started = await handler({ senderFrame: mainFrame, sender: { mainFrame } }, [oauth.id]) as PersistentTask
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1))
    await harness.taskRunner.cancel(started.id)

    await vi.waitFor(() => expect(oauth.status).toBe('active'))
    expect(harness.taskRunner.get(started.id)?.status).toBe('cancelled')
    expect(harness.store.setAccountCheckResult).not.toHaveBeenCalledWith(
      oauth.id,
      expect.objectContaining({ status: 'disabled' }),
    )
    expect(harness.store.setAccountCheckResult).toHaveBeenLastCalledWith(
      oauth.id,
      expect.objectContaining({ status: 'active', consecutiveFailures: 0 }),
    )
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('does not let an older account probe overwrite a newer health result', async () => {
    const account = apiKeyAccount()
    const replies: Array<(response: Response) => void> = []
    const upstreamFetch = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)))
    const harness = createHarness(
      [account],
      { [account.credentialId]: 'sk-api-private' },
      upstreamFetch,
    )
    const handler = electron.handlers.get('stone:check-account')
    if (!handler) throw new Error('check-account handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }

    const older = handler(event, account.id) as Promise<AppSnapshot>
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(1))
    const newer = handler(event, account.id) as Promise<AppSnapshot>
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledTimes(2))

    replies[1](new Response('{}', { status: 200 }))
    await newer
    expect(account).toMatchObject({ status: 'active', circuitState: 'closed', consecutiveFailures: 0 })

    replies[0](new Response(JSON.stringify({ error: 'stale rejection' }), { status: 401 }))
    await older
    expect(account).toMatchObject({ status: 'active', circuitState: 'closed', consecutiveFailures: 0 })
    expect(harness.store.setAccountCheckResult).not.toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ status: 'disabled', lastError: expect.any(String) }),
    )
  })

  it('does not let delayed success telemetry re-enable a manually disabled account', async () => {
    vi.useFakeTimers()
    try {
      const oauth = oauthAccount()
      const harness = createHarness([oauth], {}, vi.fn())
      harness.emitAccountState(activeAccountState(oauth.id, 100, 1_000))
      oauth.status = 'disabled'

      await vi.advanceTimersByTimeAsync(250)

      expect(harness.store.updateAccountRuntimeState).not.toHaveBeenCalled()
      expect(oauth.status).toBe('disabled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes a cooldown followed by recovery so the older write cannot win', async () => {
    const oauth = oauthAccount()
    const harness = createHarness([oauth], {}, vi.fn())
    const updateState = vi.mocked(harness.store.updateAccountRuntimeState)
    const applyState = updateState.getMockImplementation()
    if (!applyState) throw new Error('Account runtime-state mock is unavailable')
    let releaseCooldown!: () => void
    const cooldownGate = new Promise<void>((resolve) => { releaseCooldown = resolve })
    updateState.mockImplementationOnce(async (...args) => {
      await cooldownGate
      await applyState(...args)
    })

    harness.emitAccountState({
      accountId: oauth.id,
      status: 'cooldown',
      circuitState: 'open',
      consecutiveFailures: 1,
      cooldownReason: 'failure',
      cooldownUntil: Date.now() + 30_000,
      lastError: 'temporary upstream failure'
    })
    harness.emitAccountState(activeAccountState(oauth.id, 70, 3_000))
    // A routine active telemetry update must not supersede the queued recovery's
    // health side effects while the older cooldown write is still blocked.
    harness.emitAccountState(activeAccountState(oauth.id, 60, 3_100))

    expect(updateState).toHaveBeenCalledOnce()
    releaseCooldown()
    await vi.waitFor(() => expect(updateState).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(oauth).toMatchObject({
      status: 'active',
      circuitState: 'closed',
      consecutiveFailures: 0
    }))
    expect(oauth.cooldownReason).toBeUndefined()
    expect(harness.gateway.updateRuntimeAccounts).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: oauth.id, status: 'active', circuitState: 'closed' })
    ])
    await harness.dispose()
  })

  it('uses the ChatGPT Codex model catalog with the unpacked OAuth credential', async () => {
    const oauth = oauthAccount()
    const serialized = oauthCredential()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.4', visibility: 'list', priority: 1 },
        { slug: 'gpt-5.3-codex', visibility: 'list', priority: 2 }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: serialized }, upstreamFetch)

    const snapshot = await invokeRefresh(harness)

    expect(snapshot.providers[0].models).toEqual(['gpt-5.4', 'gpt-5.3-codex'])
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [input, init] = upstreamFetch.mock.calls[0]
    const url = new URL(String(input))
    expect(`${url.origin}${url.pathname}`).toBe('https://chatgpt.com/backend-api/codex/models')
    expect(url.searchParams.get('client_version')).toBeTruthy()
    expect(url.pathname).not.toBe('/v1/models')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()

    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer oauth-access-private')
    expect(headers.get('chatgpt-account-id')).toBe('acct-team-private')
    expect(JSON.stringify({ input: String(input), init })).not.toContain(serialized)
    expect(JSON.stringify({ input: String(input), init })).not.toContain('oauth-refresh-private')
  })

  it('prefers an API-key account for a mixed provider', async () => {
    const oauth = oauthAccount()
    const apiKey = apiKeyAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-platform-model' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness(
      [oauth, apiKey],
      { [oauth.credentialId]: oauthCredential(), [apiKey.credentialId]: 'sk-api-private' },
      upstreamFetch
    )

    const snapshot = await invokeRefresh(harness)

    expect(snapshot.providers[0].models).toEqual(['gpt-platform-model'])
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [input, init] = upstreamFetch.mock.calls[0]
    expect(String(input)).toBe('https://api.openai.com/v1/models')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-api-private')
    expect(JSON.stringify(init)).not.toContain('oauth-access-private')
  })

  it('preserves a ChatGPT authentication failure for a 401 model response', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'Bearer oauth-access-private for acct-team-private'
    }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)

    const error = await invokeRefresh(harness).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('ChatGPT session access token was rejected.')
    expect((error as Error).message).not.toContain('Provider rejected the account credential')
    expect((error as Error).message).not.toContain('oauth-access-private')
    expect((error as Error).message).not.toContain('acct-team-private')
  })

  it('refreshes models with the selected account credential and transport', async () => {
    const first = oauthAccount()
    const selected = apiKeyAccount()
    const proxy = testProxy()
    selected.proxyId = proxy.id
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-selected-account' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness(
      [first, selected],
      { [first.credentialId]: oauthCredential(), [selected.credentialId]: 'sk-selected-private' },
      upstreamFetch,
      [proxy]
    )

    const snapshot = await invokeAccountRefresh(harness, selected.id)

    expect(snapshot.accounts.find((account) => account.id === selected.id)?.availableModels)
      .toEqual(['gpt-selected-account'])
    expect(harness.transport.fetchFor).toHaveBeenCalledWith(proxy, undefined)
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [, init] = upstreamFetch.mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-selected-private')
    expect(JSON.stringify(init)).not.toContain('oauth-access-private')
    expect(harness.store.setAccountModels).toHaveBeenCalledWith(
      selected.id,
      ['gpt-selected-account'],
      'discovery-fingerprint'
    )
  })

  it('refreshes an OAuth account through the Codex model catalog', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      models: [{ slug: 'gpt-5.4', visibility: 'list', priority: 1 }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)

    await invokeAccountRefresh(harness, oauth.id)

    const [input, init] = upstreamFetch.mock.calls[0]
    expect(new URL(String(input)).pathname).toBe('/backend-api/codex/models')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('acct-team-private')
    expect(harness.store.setAccountModels).toHaveBeenCalledWith(
      oauth.id,
      ['gpt-5.4'],
      'discovery-fingerprint'
    )
  })

  it('does not overwrite the account catalog when discovery fails', async () => {
    const selected = apiKeyAccount()
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid' }), { status: 401 }))
    const harness = createHarness(
      [selected],
      { [selected.credentialId]: 'sk-selected-private' },
      upstreamFetch
    )

    await expect(invokeAccountRefresh(harness, selected.id)).rejects.toThrow('Provider rejected the account credential')
    expect(harness.store.setAccountModels).not.toHaveBeenCalled()
  })

  it('rejects a model response when the account configuration changes during discovery', async () => {
    const selected = apiKeyAccount()
    const fingerprint = { current: 'discovery-fingerprint' }
    let resolveResponse: ((response: Response) => void) | undefined
    const upstreamFetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve
    }))
    const harness = createHarness(
      [selected],
      { [selected.credentialId]: 'sk-selected-private' },
      upstreamFetch,
      [],
      fingerprint
    )

    const refreshing = invokeAccountRefresh(harness, selected.id)
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    fingerprint.current = 'changed-during-discovery'
    resolveResponse?.(new Response(JSON.stringify({
      data: [{ id: 'stale-model' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(refreshing).rejects.toThrow(/configuration changed while models were refreshing/)
    expect(harness.store.setAccountModels).toHaveBeenCalledWith(
      selected.id,
      ['stale-model'],
      'discovery-fingerprint'
    )
    expect(harness.store.getSnapshot().accounts.find((account) => account.id === selected.id)?.availableModels)
      .toEqual([])
  })

  it('tests one model directly with the selected account credential and proxy', async () => {
    const selected = apiKeyAccount()
    const proxy = testProxy()
    selected.proxyId = proxy.id
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const harness = createHarness(
      [selected],
      { [selected.credentialId]: 'sk-selected-private' },
      upstreamFetch,
      [proxy]
    )

    const result = await invokeAccountModelTest(harness, selected.id, 'gpt-5.6')

    expect(result).toMatchObject({ ok: true, model: 'gpt-5.6', statusCode: 200, responsePreview: 'OK' })
    expect(harness.transport.fetchFor).toHaveBeenCalledWith(proxy, undefined)
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [url, init] = upstreamFetch.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-selected-private')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-5.6', stream: false })
    expect(harness.store.setAccountModels).not.toHaveBeenCalled()
  })

  it('tests an OAuth model through the forced streaming Codex endpoint without exposing reasoning', async () => {
    const oauth = oauthAccount()
    const upstreamFetch = vi.fn(async () => new Response([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"private reasoning"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const harness = createHarness([oauth], { [oauth.credentialId]: oauthCredential() }, upstreamFetch)

    const result = await invokeAccountModelTest(harness, oauth.id, 'gpt-5.6')

    expect(result).toMatchObject({ ok: true, model: 'gpt-5.6', statusCode: 200, responsePreview: 'OK' })
    expect(JSON.stringify(result)).not.toContain('private reasoning')
    const [url, init] = upstreamFetch.mock.calls[0]
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('acct-team-private')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-5.6', stream: true, store: false })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(harness.store.setAccountModels).not.toHaveBeenCalled()
  })
})

function rendererEvent(id: number) {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  let destroyed = false
  const sender = Object.assign(new EventEmitter(), {
    id,
    mainFrame,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    destroyForTest: () => {
      destroyed = true
      sender.emit('destroyed')
    },
    crashForTest: () => sender.emit('render-process-gone')
  })
  return { senderFrame: mainFrame, sender }
}

function createHarness(
  accounts: Account[],
  credentials: Readonly<Record<string, string>>,
  upstreamFetch: ReturnType<typeof vi.fn>,
  proxies: PublicProxyDefinition[] = [],
  discoveryFingerprint: { current: string } = { current: 'discovery-fingerprint' },
  clientConfigService: ClientConfigService = {} as ClientConfigService,
  sharedOutboundReloadCoordinator?: OutboundReloadCoordinator
): {
  store: AppStore
  gateway: GatewayController
  transport: OutboundTransportManager
  emitLog: (log: RequestLog) => void
  emitAccountState: (state: GatewayAccountState) => void
  emitRuntimeState: (update?: GatewayRuntimeStateUpdate) => void
  runtimeChanged: ReturnType<typeof vi.fn>
  oauthFlow: ChatGptOAuthSessionController
  taskRunner: PersistentTaskRunner
  dispose: () => Promise<void>
  unsubscribers: {
    log: ReturnType<typeof vi.fn>
    accountState: ReturnType<typeof vi.fn>
    runtimeState: ReturnType<typeof vi.fn>
  }
} {
  const taskRunner = new PersistentTaskRunner(new MemoryPersistentTaskStore())
  void taskRunner.recover()
  const snapshot = {
    providers: [{ ...provider, models: [] }],
    accounts: accounts.map(({ credentialId: _credentialId, chatgptAccountId: _chatgptAccountId, ...account }) => account),
    accountTags: [{ id: 'tag-plus', name: 'Plus', createdAt: 1, updatedAt: 1 }],
    proxies,
    pools: [],
    routes: [],
    gateway: {
      host: '127.0.0.1', port: 15721, autoStart: false, desktopNotifications: false,
      logRetentionDays: 7, requestTimeoutMs: 120_000
    },
    gatewayStatus: {
      running: false, host: '127.0.0.1', port: 15721,
      activeRequests: 0, totalRequests: 0, successRequests: 0
    },
    healthEvents: [],
    requestLogs: [],
    clientProfiles: [],
    observability: { last24Hours: {}, last7Days: {}, hourly: [], tokenRates: { last30Minutes: [], last4Hours: [], last24Hours: [], last7Days: [] } },
    vaultAvailable: true,
    vaultBackend: 'test'
  } as unknown as AppSnapshot

  const setAccountCheckResult = vi.fn(async (id: string, patch: Partial<Account>) => {
    const runtimeAccount = accounts.find((account) => account.id === id)
    if (runtimeAccount) Object.assign(runtimeAccount, patch)
    const publicAccount = snapshot.accounts.find((account) => account.id === id)
    if (publicAccount) Object.assign(publicAccount, patch)
    return snapshot
  })

  const store = {
    getPersistentTaskRunner: vi.fn(() => taskRunner),
    getSnapshot: vi.fn(() => snapshot),
    getAccountFitnessHistory: vi.fn(() => snapshot.requestLogs),
    getRuntimeConfiguration: vi.fn(() => ({
      providers: snapshot.providers,
      accounts,
      proxies,
      pools: snapshot.pools,
      routes: snapshot.routes,
      gateway: snapshot.gateway
    })),
    getRuntimeAccounts: vi.fn(() => accounts),
    getRuntimeAccount: vi.fn((id: string) => accounts.find((account) => account.id === id)),
    getRuntimeProxies: vi.fn(() => proxies),
    saveProvider: vi.fn(async (input: Record<string, unknown>) => {
      snapshot.providers[0] = { ...snapshot.providers[0], ...input } as ProviderDefinition
      return snapshot
    }),
    saveApiSource: vi.fn(async (input: Record<string, unknown>) => {
      snapshot.providers[0] = { ...snapshot.providers[0], ...input } as ProviderDefinition
      return {
        snapshot,
        source: {
          sourceId: provider.id,
          providerId: provider.id,
          accountId: accounts[0]?.id ?? 'account',
          credentialId: accounts[0]?.credentialId ?? 'credential',
          created: false,
          credentialChanged: false,
          connectionChanged: false
        }
      }
    }),
    setRouteSourceFastMode: vi.fn(async () => snapshot),
    setRouteSource: vi.fn(async (client: RouteClient, sourceId: string) => {
      const route = snapshot.routes.find((candidate) => candidate.client === client)
      if (!route) throw new Error('Client route does not exist')
      snapshot.routes = snapshot.routes.map((candidate) => candidate.id === route.id
        ? { ...candidate, poolId: sourceId, updatedAt: Date.now() }
        : candidate)
      return snapshot
    }),
    validateChatGptImportAssignments: vi.fn(),
    addDetectedChatGptAccountsToPool: vi.fn(async (poolId: string | null | undefined, accountIds: string[]) => ({
      added: poolId ? accountIds.length : 0,
      alreadyPresent: 0
    })),
    getAccountModelDiscoveryFingerprint: vi.fn(() => discoveryFingerprint.current),
    getCredential: vi.fn((credentialId: string) => credentials[credentialId]),
    getProxyPassword: vi.fn(() => undefined),
    updateChatGptCredential: vi.fn(async () => undefined),
    importChatGptAccounts: vi.fn(async (input: { proxyMode?: string; proxyId?: string }) => {
      const imported = accounts[0]
      if (!imported) throw new Error('No mock account available for import')
      imported.proxyId = input.proxyMode === 'proxy' ? input.proxyId : undefined
      const publicAccount = snapshot.accounts.find((account) => account.id === imported.id)
      if (publicAccount) publicAccount.proxyId = imported.proxyId
      return {
        snapshot,
        importedAccountIds: [imported.id],
        createdAccountIds: [],
        updatedAccountIds: [imported.id],
        warnings: []
      }
    }),
    setAccountCheckResult,
    setAccountCheckResultIf: vi.fn(async (
      id: string,
      patch: Partial<Account>,
      isCurrent: () => boolean,
    ) => {
      if (!isCurrent()) return { applied: false, snapshot }
      await setAccountCheckResult(id, patch)
      return { applied: true, snapshot }
    }),
    setProviderModels: vi.fn(async (_id: string, models: string[]) => {
      snapshot.providers[0].models = models
      return snapshot
    }),
    setAccountModels: vi.fn(async (id: string, models: string[], expectedFingerprint?: string) => {
      if (expectedFingerprint !== undefined && expectedFingerprint !== discoveryFingerprint.current) {
        throw new Error('Account or provider configuration changed while models were refreshing. Refresh again.')
      }
      const refreshedAt = Date.now()
      const runtimeAccount = accounts.find((account) => account.id === id)
      if (runtimeAccount) {
        runtimeAccount.availableModels = models
        runtimeAccount.modelsRefreshedAt = refreshedAt
      }
      const publicAccount = snapshot.accounts.find((account) => account.id === id)
      if (publicAccount) {
        publicAccount.availableModels = models
        publicAccount.modelsRefreshedAt = refreshedAt
      }
      return snapshot
    }),
    setGatewayStatus: vi.fn(),
    updateGateway: vi.fn(async (settings) => {
      snapshot.gateway = { ...snapshot.gateway, ...settings }
      return snapshot
    }),
    getPublicRuntimeAccounts: vi.fn((ids?: ReadonlySet<string>) => snapshot.accounts.filter((account) => !ids || ids.has(account.id))),
    getRuntimeObservability: vi.fn(() => snapshot.observability),
    getRuntimeGatewaySettings: vi.fn(() => snapshot.gateway),
    persistHealthEvent: vi.fn(async (event) => event),
    appendLog: vi.fn(async (log: RequestLog) => log),
    clearLogs: vi.fn(async () => {
      snapshot.requestLogs = []
      return snapshot
    }),
    hasLiveRequestLogs: vi.fn(() => false),
    hasUncheckpointedLiveRequestLogs: vi.fn(() => false),
    checkpointLiveRequestLogs: vi.fn(async () => 0),
    finalizeOrphanedStreamingLogs: vi.fn(async () => []),
    updateAccountRuntimeState: vi.fn(async (id: string, patch: Partial<Account>) => {
      const runtimeAccount = accounts.find((account) => account.id === id)
      if (runtimeAccount) Object.assign(runtimeAccount, patch)
    }),
    updateAccountRuntimeStates: vi.fn(async (updates: Array<{ id: string; patch: Partial<Account> }>) => {
      for (const { id, patch } of updates) {
        const runtimeAccount = accounts.find((account) => account.id === id)
        if (runtimeAccount) Object.assign(runtimeAccount, patch)
      }
    }),
    getRuntimeProvider: vi.fn((id: string) => snapshot.providers.find((candidate) => candidate.id === id)),
    getApiSourceProbeConnectionFingerprint: vi.fn(() => 'connection-fingerprint'),
    saveApiSourceCapabilityProbe: vi.fn(async () => snapshot),
    appendHealthEvent: vi.fn(async () => snapshot)
  } as unknown as AppStore
  let logListener: ((log: RequestLog) => void) | undefined
  let accountStateListener: ((state: GatewayAccountState) => void) | undefined
  let runtimeStateListener: ((update?: GatewayRuntimeStateUpdate) => void) | undefined
  const unsubscribeLog = vi.fn()
  const unsubscribeAccountState = vi.fn()
  const unsubscribeRuntimeState = vi.fn()
  const gateway = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(() => snapshot.gatewayStatus),
    updateConfig: vi.fn(),
    updateRuntimeAccounts: vi.fn(),
    resetAccountHealth: vi.fn(),
    getAccountFitness: vi.fn(() => ({})),
    getAccountInFlight: vi.fn((ids?: readonly string[]) => Object.fromEntries(accounts
      .filter((account) => !ids || ids.includes(account.id))
      .map((account) => [account.id, account.inFlight]))),
    onLog: vi.fn((listener: (log: RequestLog) => void) => {
      logListener = listener
      return unsubscribeLog
    }),
    onAccountState: vi.fn((listener: (state: GatewayAccountState) => void) => {
      accountStateListener = listener
      return unsubscribeAccountState
    }),
    onRuntimeState: vi.fn((listener: (update?: GatewayRuntimeStateUpdate) => void) => {
      runtimeStateListener = listener
      return unsubscribeRuntimeState
    })
  } as unknown as GatewayController
  const transport = {
    fetchFor: vi.fn(() => upstreamFetch as unknown as typeof fetch),
    configureOutboundNetwork: vi.fn(),
    invalidateSystemProxyCache: vi.fn(),
    reloadSystemProxyConfiguration: vi.fn(async () => undefined),
    detectSystemProxy: vi.fn(async () => ({
      detectedAt: Date.now(),
      targets: [{ target: 'https://chatgpt.com', summary: 'DIRECT', reachable: true }]
    }))
  } as unknown as OutboundTransportManager
  const runtimeChanged = vi.fn()
  const oauthFlow = {
    start: vi.fn(async () => ({
      sessionId: 'oauth-session',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=public-state',
      redirectUri: 'http://localhost:1455/auth/callback',
      expiresAt: Date.now() + 600_000,
      loopbackListening: true,
      status: 'waiting' as const
    })),
    open: vi.fn(async () => undefined),
    submitCallback: vi.fn(),
    wait: vi.fn(async (_sessionId: string, fetchImplementation?: typeof fetch) => {
      await fetchImplementation?.('https://auth.openai.com/oauth/token', { method: 'POST' })
      return {
        accessToken: 'oauth-access-exchanged-private',
        refreshToken: 'oauth-refresh-exchanged-private',
        idToken: 'oauth-id-exchanged-private',
        accountId: 'acct-team-private',
        email: 'oauth@example.com',
        expiresAt: Date.now() + 3_600_000
      }
    }),
    cancel: vi.fn(),
    dispose: vi.fn()
  } satisfies ChatGptOAuthSessionController

  const dispose = registerGatewayApi(
    store,
    gateway,
    clientConfigService,
    transport,
    undefined,
    runtimeChanged,
    undefined,
    oauthFlow,
    undefined,
    sharedOutboundReloadCoordinator
  )
  return {
    store,
    gateway,
    transport,
    runtimeChanged,
    oauthFlow,
    taskRunner,
    dispose,
    unsubscribers: {
      log: unsubscribeLog,
      accountState: unsubscribeAccountState,
      runtimeState: unsubscribeRuntimeState
    },
    emitLog: (log) => {
      if (!logListener) throw new Error('Gateway log listener was not registered')
      logListener(log)
    },
    emitAccountState: (state) => {
      if (!accountStateListener) throw new Error('Gateway account-state listener was not registered')
      accountStateListener(state)
    },
    emitRuntimeState: (update) => {
      if (!runtimeStateListener) throw new Error('Gateway runtime-state listener was not registered')
      runtimeStateListener(update)
    }
  }
}

function activeAccountState(accountId: string, latencyMs: number, lastUsedAt: number): GatewayAccountState {
  return {
    accountId,
    status: 'active',
    circuitState: 'closed',
    consecutiveFailures: 0,
    latencyMs,
    lastUsedAt
  }
}

async function invokeRefresh(harness: { store: AppStore; transport: OutboundTransportManager }): Promise<AppSnapshot> {
  void harness
  const handler = electron.handlers.get('stone:refresh-provider-models')
  if (!handler) throw new Error('refresh-provider-models handler was not registered')
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return await handler({ senderFrame: mainFrame, sender: { mainFrame } }, provider.id) as AppSnapshot
}

async function invokeAccountRefresh(
  harness: { store: AppStore; transport: OutboundTransportManager },
  accountId: string
): Promise<AppSnapshot> {
  void harness
  const handler = electron.handlers.get('stone:refresh-account-models')
  if (!handler) throw new Error('refresh-account-models handler was not registered')
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return await handler({ senderFrame: mainFrame, sender: { mainFrame } }, accountId) as AppSnapshot
}

async function invokeAccountModelTest(
  harness: { store: AppStore; transport: OutboundTransportManager },
  accountId: string,
  model: string
) {
  void harness
  const handler = electron.handlers.get('stone:test-account-model')
  if (!handler) throw new Error('test-account-model handler was not registered')
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return await handler({ senderFrame: mainFrame, sender: { mainFrame } }, accountId, model) as {
    ok: boolean
    model: string
    latencyMs: number
    statusCode?: number
    responsePreview?: string
  }
}

function oauthAccount(): Account {
  return {
    ...baseAccount('account-oauth', 'credential-oauth'),
    name: 'ChatGPT Team',
    credentialType: 'chatgpt-oauth',
    chatgptAccountId: 'acct-team-private',
    maskedCredential: 'chatgpt-****vate',
    credentialExpiresAt: Date.now() + 60 * 60 * 1000,
    renewable: true
  }
}

function apiKeyAccount(): Account {
  return {
    ...baseAccount('account-api-key', 'credential-api-key'),
    name: 'OpenAI API key',
    credentialType: 'api-key',
    maskedCredential: '****vate'
  }
}

function baseAccount(id: string, credentialId: string): Account {
  return {
    id,
    providerId: provider.id,
    name: id,
    credentialId,
    maskedCredential: '****',
    status: 'active',
    priority: 10,
    weight: 10,
    maxConcurrency: 4,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    circuitState: 'closed',
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function oauthCredential(): string {
  return JSON.stringify({
    accessToken: 'oauth-access-private',
    refreshToken: 'oauth-refresh-private',
    accountId: 'acct-team-private',
    expiresAt: Date.now() + 60 * 60 * 1000
  })
}

function testProxy(): PublicProxyDefinition {
  return {
    id: 'proxy-selected',
    name: 'Selected account proxy',
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    hasPassword: false,
    status: 'available',
    createdAt: 1,
    updatedAt: 1
  }
}
