import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BuiltInProxyImportInput,
  BuiltInProxyRuntimeState,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '../../src/shared/types'
import {
  builtInProxyIpcChannels,
  registerBuiltInProxyApi,
  type BuiltInProxyRuntimeFacade,
  type BuiltInProxyStoreFacade,
} from '../../src/main/ipc/built-in-proxy-api'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  fromWebContents: vi.fn(() => ({})),
  send: vi.fn(),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  exposeInMainWorld: vi.fn(),
  ipcInvoke: vi.fn(),
  ipcOn: vi.fn(),
  ipcRemoveListener: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: electron.send } }]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler)),
    removeHandler: electron.removeHandler,
  },
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.ipcInvoke,
    on: electron.ipcOn,
    removeListener: electron.ipcRemoveListener,
  },
}))

describe('built-in proxy IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.send.mockReset()
    electron.removeHandler.mockClear()
    electron.fromWebContents.mockReturnValue({})
    electron.exposeInMainWorld.mockReset()
    electron.ipcInvoke.mockReset()
    electron.ipcOn.mockReset()
    electron.ipcRemoveListener.mockReset()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  })

  it('registers only the dedicated API and routes mutations through store plus reconciliation', async () => {
    const harness = createHarness()
    registerBuiltInProxyApi(harness.store, harness.runtime)

    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(builtInProxyIpcChannels)
      .filter((channel) => channel !== builtInProxyIpcChannels.stateChanged)
      .sort())

    await invoke(builtInProxyIpcChannels.setEnabled, true)
    await invoke(builtInProxyIpcChannels.importProfile, {
      source: 'import',
      name: 'Local',
      content: 'vmess://private-node-credential',
      format: 'uri-list',
      controllerSecret: 'must-not-reach-store',
    })
    await invoke(builtInProxyIpcChannels.selectProfile, 'profile-imported')
    harness.state.profiles[0].activeNodeId = undefined
    await invoke(builtInProxyIpcChannels.selectNode, 'profile-imported', 'node-imported')
    await invoke(builtInProxyIpcChannels.setRuleMode, 'global')
    await invoke(builtInProxyIpcChannels.setAccessMode, 'tun')
    await invoke(builtInProxyIpcChannels.setLanEnabled, true)
    await invoke(builtInProxyIpcChannels.setAutoStart, false)
    await invoke(builtInProxyIpcChannels.refreshProfile, 'profile-imported')
    await invoke(builtInProxyIpcChannels.retry)

    expect(harness.runtime.setEnabled).toHaveBeenCalledWith(true)
    expect(harness.store.importProfile).toHaveBeenCalledWith({
      source: 'import', name: 'Local', content: 'vmess://private-node-credential', format: 'uri-list',
    })
    expect(harness.store.selectProfile).toHaveBeenCalledWith('profile-imported')
    expect(harness.store.selectNode).toHaveBeenCalledWith('profile-imported', 'node-imported')
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ ruleMode: 'global' })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ accessMode: 'tun' })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ lanEnabled: true })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ autoStart: false })
    expect(harness.runtime.reconcile.mock.calls.map(([reason]) => reason)).toEqual([
      'profile-imported',
      'profile-selected',
      'node-selected',
      'rule-mode-changed',
      'access-mode-changed',
      'lan-changed',
      'auto-start-changed',
      'profile-refreshed',
    ])
    expect(harness.runtime.retry).toHaveBeenCalledOnce()
  })

  it('serializes every mutation and coalesces double-click imports', async () => {
    const harness = createHarness()
    let releaseFirst: (() => void) | undefined
    const firstMutation = new Promise<void>((resolve) => { releaseFirst = resolve })
    harness.store.updateSettings.mockImplementation(async (patch) => {
      if (patch.ruleMode === 'global') await firstMutation
      Object.assign(harness.state.settings, patch)
    })
    registerBuiltInProxyApi(harness.store, harness.runtime)

    const first = invoke(builtInProxyIpcChannels.setRuleMode, 'global')
    await vi.waitFor(() => expect(harness.store.updateSettings).toHaveBeenCalledTimes(1))
    const second = invoke(builtInProxyIpcChannels.setLanEnabled, true)
    await Promise.resolve()
    expect(harness.store.updateSettings).toHaveBeenCalledTimes(1)
    releaseFirst?.()
    await Promise.all([first, second])
    expect(harness.store.updateSettings).toHaveBeenNthCalledWith(2, { lanEnabled: true })

    const input: BuiltInProxyImportInput = {
      source: 'subscription',
      name: 'Remote',
      url: 'https://proxy.example/sub?token=private',
      token: 'private-token',
    }
    const [left, right] = await Promise.all([
      invoke(builtInProxyIpcChannels.importProfile, input),
      invoke(builtInProxyIpcChannels.importProfile, input),
    ])
    expect(left).toEqual(right)
    expect(harness.store.importProfile).toHaveBeenCalledTimes(1)
  })

  it('makes repeated lifecycle and selection commands idempotent', async () => {
    const harness = createHarness()
    harness.state.profiles.push(profileSummary())
    harness.state.settings.activeProfileId = 'profile-imported'
    registerBuiltInProxyApi(harness.store, harness.runtime)

    await invoke(builtInProxyIpcChannels.setEnabled, false)
    await invoke(builtInProxyIpcChannels.selectProfile, 'profile-imported')
    await invoke(builtInProxyIpcChannels.selectNode, 'profile-imported', 'node-imported')
    await invoke(builtInProxyIpcChannels.setRuleMode, 'rule')
    await invoke(builtInProxyIpcChannels.setAccessMode, 'system')
    await invoke(builtInProxyIpcChannels.setLanEnabled, false)
    await invoke(builtInProxyIpcChannels.setAutoStart, true)

    expect(harness.runtime.setEnabled).not.toHaveBeenCalled()
    expect(harness.store.selectProfile).not.toHaveBeenCalled()
    expect(harness.store.selectNode).not.toHaveBeenCalled()
    expect(harness.store.updateSettings).not.toHaveBeenCalled()
  })

  it('allows a persisted enabled-but-not-started state to be started explicitly', async () => {
    const harness = createHarness()
    harness.state.desiredEnabled = true
    harness.state.settings.desiredEnabled = true
    harness.state.status = 'disabled'
    registerBuiltInProxyApi(harness.store, harness.runtime)

    await invoke(builtInProxyIpcChannels.setEnabled, true)

    expect(harness.runtime.setEnabled).toHaveBeenCalledWith(true)
  })

  it('whitelists runtime, event, latency, traffic, and connection projections', async () => {
    const harness = createHarness()
    const unsafeState = harness.state as BuiltInProxyRuntimeState & Record<string, unknown>
    unsafeState.controllerSecret = 'controller-private'
    unsafeState.profiles.push(Object.assign(profileSummary(), {
      subscriptionUrl: 'https://proxy.example/private-subscription',
      token: 'subscription-private',
    }))
    Object.assign(unsafeState.profiles[0].nodes[0], {
      password: 'node-private',
      server: 'secret-node.example',
      rawConfig: 'raw-private',
    })
    unsafeState.error = {
      category: 'node-handshake',
      message: 'failed at vmess://private-credential token=private-token',
      retryable: true,
    }
    harness.runtime.testLatency.mockResolvedValue(unsafeState.profiles[0].nodes)
    const unsafeTraffic = Object.assign(trafficSnapshot(), { controllerSecret: 'traffic-private' })
    harness.runtime.getTraffic.mockReturnValue(unsafeTraffic)
    const unsafeConnections = [Object.assign(connectionSummary(), {
      subscriptionToken: 'connection-private',
      credentials: { password: 'connection-password' },
    })]
    harness.runtime.listConnections.mockReturnValue(unsafeConnections)
    let stateListener: ((state: BuiltInProxyRuntimeState) => void) | undefined
    harness.runtime.subscribe.mockImplementation((listener) => {
      stateListener = listener
      return vi.fn()
    })
    registerBuiltInProxyApi(harness.store, harness.runtime)

    const state = await invoke(builtInProxyIpcChannels.getState) as BuiltInProxyRuntimeState
    const latency = await invoke(builtInProxyIpcChannels.testLatency, 'profile-imported', ['node-imported'])
    const traffic = await invoke(builtInProxyIpcChannels.getTraffic)
    const connections = await invoke(builtInProxyIpcChannels.listConnections)
    stateListener?.(unsafeState)

    for (const value of [state, latency, traffic, connections, electron.send.mock.calls[0]?.[1]]) {
      const serialized = JSON.stringify(value)
      expect(serialized).not.toContain('controller-private')
      expect(serialized).not.toContain('subscription-private')
      expect(serialized).not.toContain('node-private')
      expect(serialized).not.toContain('raw-private')
      expect(serialized).not.toContain('traffic-private')
      expect(serialized).not.toContain('connection-private')
      expect(serialized).not.toContain('connection-password')
      expect(serialized).not.toContain('private-credential')
      expect(serialized).not.toContain('private-token')
    }
    expect(state.profiles[0]).toMatchObject({ nodeCount: 1, groupCount: 1, ruleStatus: 'preserved' })
    expect((traffic as ProxyTrafficSnapshot).uploadRateBytesPerSecond).toBe(128)
    expect((connections as ProxyConnectionSummary[])[0]).toMatchObject({
      destination: 'api.openai.com:443', profileId: 'profile-imported', nodeId: 'node-imported',
    })
    expect(electron.send).toHaveBeenCalledWith(builtInProxyIpcChannels.stateChanged, expect.any(Object))
  })

  it('passes through safe error classification while redacting URLs, tokens, and node URIs', async () => {
    const harness = createHarness()
    harness.store.refreshProfile.mockRejectedValue(Object.assign(
      new Error('subscription failed https://proxy.example/sub?token=private token=private-token vmess://private-node'),
      { category: 'subscription-update', retryable: true },
    ))
    registerBuiltInProxyApi(harness.store, harness.runtime)

    let thrown: unknown
    try {
      await invoke(builtInProxyIpcChannels.refreshProfile, 'profile-one')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ category: 'subscription-update', code: 'subscription-update', retryable: true })
    expect((thrown as Error).message).not.toContain('proxy.example')
    expect((thrown as Error).message).not.toContain('private-token')
    expect((thrown as Error).message).not.toContain('private-node')
  })

  it('validates arguments after sender trust and never calls a facade for rejected input', async () => {
    const harness = createHarness()
    registerBuiltInProxyApi(harness.store, harness.runtime)
    const evilFrame = { url: 'https://evil.example/index.html' }

    await expect(invokeWithEvent(
      builtInProxyIpcChannels.setEnabled,
      { senderFrame: evilFrame, sender: { mainFrame: evilFrame } },
      true,
    )).rejects.toThrow('untrusted origin')
    await expect(invoke(builtInProxyIpcChannels.setEnabled, 'yes')).rejects.toMatchObject({
      category: 'configuration-invalid',
    })
    await expect(invoke(builtInProxyIpcChannels.importProfile, {
      source: 'subscription', url: 'file:///private/config',
    })).rejects.toMatchObject({ category: 'subscription-update' })
    await expect(invoke(builtInProxyIpcChannels.setRuleMode, 'invalid')).rejects.toMatchObject({
      category: 'configuration-invalid',
    })

    expect(harness.runtime.setEnabled).not.toHaveBeenCalled()
    expect(harness.store.importProfile).not.toHaveBeenCalled()
    expect(harness.store.updateSettings).not.toHaveBeenCalled()
  })

  it('unsubscribes and removes fixed handlers on disposal', () => {
    const harness = createHarness()
    const unsubscribe = vi.fn()
    harness.runtime.subscribe.mockReturnValue(unsubscribe)
    const dispose = registerBuiltInProxyApi(harness.store, harness.runtime)

    dispose()
    dispose()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
    expect(electron.removeHandler).toHaveBeenCalledTimes(Object.values(builtInProxyIpcChannels).length - 1)
  })

  it('reconstructs classified errors in preload after Electron strips custom properties', async () => {
    vi.resetModules()
    electron.ipcInvoke.mockRejectedValue(new Error(
      'Error invoking remote method: [stone-built-in-proxy-error:tun-elevation:retryable] Elevation was denied.',
    ))
    await import('../../src/preload/index')
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'stone')?.[1] as {
      retryBuiltInProxy(): Promise<unknown>
    }

    let thrown: unknown
    try {
      await exposed.retryBuiltInProxy()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'BuiltInProxyError',
      message: 'Elevation was denied.',
      category: 'tun-elevation',
      code: 'tun-elevation',
      retryable: true,
    })
  })
})

function createHarness(): {
  state: BuiltInProxyRuntimeState
  store: BuiltInProxyStoreFacade & Record<keyof BuiltInProxyStoreFacade, ReturnType<typeof vi.fn>>
  runtime: BuiltInProxyRuntimeFacade & Record<keyof BuiltInProxyRuntimeFacade, ReturnType<typeof vi.fn>>
} {
  const state = runtimeState()
  const store = {
    importProfile: vi.fn(async (_input: BuiltInProxyImportInput) => {
      if (!state.profiles.some((profile) => profile.id === 'profile-imported')) state.profiles.push(profileSummary())
    }),
    refreshProfile: vi.fn(async (_id: string) => undefined),
    deleteProfile: vi.fn(async (id: string) => {
      state.profiles = state.profiles.filter((profile) => profile.id !== id)
      if (state.settings.activeProfileId === id) state.settings.activeProfileId = undefined
    }),
    selectProfile: vi.fn(async (id: string) => { state.settings.activeProfileId = id }),
    selectNode: vi.fn(async (profileId: string, nodeId: string) => {
      const profile = state.profiles.find((candidate) => candidate.id === profileId)
      if (profile) profile.activeNodeId = nodeId
    }),
    updateSettings: vi.fn(async (patch: Partial<BuiltInProxyRuntimeState['settings']>) => {
      Object.assign(state.settings, patch)
    }),
  } as unknown as BuiltInProxyStoreFacade & Record<keyof BuiltInProxyStoreFacade, ReturnType<typeof vi.fn>>
  const runtime = {
    getState: vi.fn(() => state),
    setEnabled: vi.fn(async (enabled: boolean) => {
      state.desiredEnabled = enabled
      state.settings.desiredEnabled = enabled
      state.status = enabled ? 'ready' : 'disabled'
    }),
    retry: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    testLatency: vi.fn(async () => state.profiles.flatMap((profile) => profile.nodes)),
    getTraffic: vi.fn(() => trafficSnapshot()),
    listConnections: vi.fn(() => [connectionSummary()]),
    closeConnection: vi.fn(async (_id: string) => undefined),
    subscribe: vi.fn(() => vi.fn()),
  } as unknown as BuiltInProxyRuntimeFacade & Record<keyof BuiltInProxyRuntimeFacade, ReturnType<typeof vi.fn>>
  return { state, store, runtime }
}

function runtimeState(): BuiltInProxyRuntimeState {
  return {
    desiredEnabled: false,
    status: 'disabled',
    routeGeneration: 7,
    settings: {
      desiredEnabled: false,
      accessMode: 'system',
      ruleMode: 'rule',
      mixedPort: 17890,
      lanEnabled: false,
      autoStart: true,
      hasEverActivated: false,
      updatedAt: 1,
    },
    profiles: [],
    effectiveRoute: { generation: 7, kind: 'external', externalMode: 'system' },
  }
}

function profileSummary(): BuiltInProxyRuntimeState['profiles'][number] {
  return {
    id: 'profile-imported',
    name: 'Imported profile',
    source: 'import',
    format: 'uri-list',
    nodes: [{
      id: 'node-imported',
      name: 'Node',
      type: 'vmess',
      groupIds: ['global'],
      latencyMs: 42,
      latencyStatus: 'available',
      lastTestedAt: 3,
    }],
    nodeCount: 1,
    groupCount: 1,
    ruleStatus: 'preserved',
    activeNodeId: 'node-imported',
    createdAt: 1,
    updatedAt: 2,
    lastRefreshAt: 2,
  }
}

function trafficSnapshot(): ProxyTrafficSnapshot {
  return {
    capturedAt: 10,
    uploadBytes: 1_024,
    downloadBytes: 2_048,
    uploadRateBytesPerSecond: 128,
    downloadRateBytesPerSecond: 256,
    activeConnections: 1,
    totalConnections: 3,
  }
}

function connectionSummary(): ProxyConnectionSummary {
  return {
    id: 'connection-one',
    network: 'tcp',
    protocol: 'https',
    source: '127.0.0.1:50000',
    destination: 'api.openai.com:443',
    outbound: 'selected-node',
    profileId: 'profile-imported',
    nodeId: 'node-imported',
    uploadBytes: 10,
    downloadBytes: 20,
    startedAt: 5,
  }
}

function trustedEvent() {
  const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
  return { senderFrame: mainFrame, sender: { mainFrame } }
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeWithEvent(channel, trustedEvent(), ...args)
}

async function invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}
