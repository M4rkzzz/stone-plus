import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AppSnapshot, ProviderDefinition, PublicProxyDefinition, RequestLog } from '../../src/shared/types'
import type { GatewayController } from '../../src/main/ipc/gateway-api'
import type { GatewayAccountState } from '../../src/main/gateway'
import { registerGatewayApi } from '../../src/main/ipc/gateway-api'
import type { AppStore } from '../../src/main/store/app-store'
import type { ClientConfigService } from '../../src/main/client-config'
import type { OutboundTransportManager } from '../../src/main/proxy'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  getAllWindows: vi.fn(() => []),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Stone'),
    getVersion: vi.fn(() => '0.7.0'),
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
  }
}))

const provider: ProviderDefinition = {
  id: 'provider-openai',
  name: 'OpenAI',
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
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('opens a multi-file picker for CPA and Sub2API account JSON imports', async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const harness = createHarness([oauthAccount()], {}, vi.fn())
    const handler = electron.handlers.get('stone:import-chatgpt-account-files')
    if (!handler) throw new Error('import-chatgpt-account-files handler was not registered')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }

    const result = await handler(
      { senderFrame: mainFrame, sender: { mainFrame } },
      { providerId: provider.id }
    ) as { cancelled: boolean; selectedFiles: number }

    expect(result).toMatchObject({ cancelled: true, selectedFiles: 0 })
    expect(electron.showOpenDialog).toHaveBeenCalledOnce()
    expect(electron.showOpenDialog.mock.calls[0][1]).toMatchObject({
      properties: ['openFile', 'multiSelections'],
      filters: expect.arrayContaining([expect.objectContaining({ extensions: ['json', 'txt'] })])
    })
    expect(harness.store.getSnapshot).toHaveBeenCalled()
  })

  it('coalesces rapid request-log snapshots before publishing to the renderer', async () => {
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
        providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'success', latencyMs: 10
      } satisfies RequestLog
      harness.emitLog(log)
      harness.emitLog({ ...log, id: 'log-2' })
      await Promise.resolve()
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(999)
      expect(send).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledOnce()
      expect(harness.store.appendLog).toHaveBeenCalledTimes(2)
      expect(harness.gateway.updateConfig).not.toHaveBeenCalled()
      expect(harness.runtimeChanged).not.toHaveBeenCalled()
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
  })

  it('does not push routine telemetry snapshots to a hidden window', async () => {
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
      harness.emitLog({
        id: 'hidden-log', timestamp: Date.now(), client: 'codex', protocol: 'openai-responses',
        providerName: 'OpenAI', accountName: 'Account', model: 'gpt', status: 'success', latencyMs: 10
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(send).not.toHaveBeenCalled()
    } finally {
      electron.getAllWindows.mockReturnValue([])
      vi.useRealTimers()
    }
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
      expect(harness.store.updateAccountRuntimeState).toHaveBeenCalledOnce()
      expect(harness.store.updateAccountRuntimeState).toHaveBeenCalledWith(oauth.id, expect.objectContaining({
        latencyMs: 80,
        lastUsedAt: 2_000
      }))
      expect(harness.gateway.updateConfig).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

function createHarness(
  accounts: Account[],
  credentials: Readonly<Record<string, string>>,
  upstreamFetch: ReturnType<typeof vi.fn>,
  proxies: PublicProxyDefinition[] = [],
  discoveryFingerprint: { current: string } = { current: 'discovery-fingerprint' }
): {
  store: AppStore
  gateway: GatewayController
  transport: OutboundTransportManager
  emitLog: (log: RequestLog) => void
  emitAccountState: (state: GatewayAccountState) => void
  runtimeChanged: ReturnType<typeof vi.fn>
} {
  const snapshot = {
    providers: [{ ...provider, models: [] }],
    accounts: accounts.map(({ credentialId: _credentialId, chatgptAccountId: _chatgptAccountId, ...account }) => account),
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

  const store = {
    getSnapshot: vi.fn(() => snapshot),
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
    getAccountModelDiscoveryFingerprint: vi.fn(() => discoveryFingerprint.current),
    getCredential: vi.fn((credentialId: string) => credentials[credentialId]),
    getProxyPassword: vi.fn(() => undefined),
    updateChatGptCredential: vi.fn(async () => undefined),
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
    appendLog: vi.fn(async () => undefined),
    updateAccountRuntimeState: vi.fn(async (id: string, patch: Partial<Account>) => {
      const runtimeAccount = accounts.find((account) => account.id === id)
      if (runtimeAccount) Object.assign(runtimeAccount, patch)
    }),
    getRuntimeProvider: vi.fn((id: string) => snapshot.providers.find((candidate) => candidate.id === id)),
    appendHealthEvent: vi.fn(async () => snapshot)
  } as unknown as AppStore
  let logListener: ((log: RequestLog) => void) | undefined
  let accountStateListener: ((state: GatewayAccountState) => void) | undefined
  const gateway = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(() => snapshot.gatewayStatus),
    updateConfig: vi.fn(),
    resetAccountHealth: vi.fn(),
    onLog: vi.fn((listener: (log: RequestLog) => void) => {
      logListener = listener
      return () => undefined
    }),
    onAccountState: vi.fn((listener: (state: GatewayAccountState) => void) => {
      accountStateListener = listener
      return () => undefined
    })
  } as unknown as GatewayController
  const transport = {
    fetchFor: vi.fn(() => upstreamFetch as unknown as typeof fetch)
  } as unknown as OutboundTransportManager
  const runtimeChanged = vi.fn()

  registerGatewayApi(
    store,
    gateway,
    {} as ClientConfigService,
    transport,
    undefined,
    runtimeChanged
  )
  return {
    store,
    gateway,
    transport,
    runtimeChanged,
    emitLog: (log) => {
      if (!logListener) throw new Error('Gateway log listener was not registered')
      logListener(log)
    },
    emitAccountState: (state) => {
      if (!accountStateListener) throw new Error('Gateway account-state listener was not registered')
      accountStateListener(state)
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
