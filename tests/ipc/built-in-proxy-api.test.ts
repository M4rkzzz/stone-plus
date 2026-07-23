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
  shutdownBuiltInProxyBoundary,
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
    await invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [
        { id: 'rule-domain', condition: 'domain-suffix', values: [' .Example.com '], action: 'proxy' },
        { id: 'rule-private', condition: 'private-network', values: [], action: 'direct' },
      ],
      finalAction: 'direct',
    })
    await invoke(builtInProxyIpcChannels.setAccessMode, 'tun')
    await invoke(builtInProxyIpcChannels.setLanEnabled, true)
    await invoke(builtInProxyIpcChannels.setAutoStart, false)
    await invoke(builtInProxyIpcChannels.refreshProfile, 'profile-imported')
    await invoke(builtInProxyIpcChannels.closeConnection, 'connection-one')
    await invoke(builtInProxyIpcChannels.retry)

    expect(harness.runtime.setEnabled).toHaveBeenCalledWith(true)
    expect(harness.store.importProfile).toHaveBeenCalledWith({
      source: 'import', name: 'Local', content: 'vmess://private-node-credential', format: 'uri-list',
    })
    expect(harness.store.selectProfile).toHaveBeenCalledWith('profile-imported')
    expect(harness.store.selectNode).toHaveBeenCalledWith('profile-imported', 'node-imported')
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ ruleMode: 'global' })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({
      customRules: {
        rules: [
          { id: 'rule-domain', condition: 'domain-suffix', values: ['example.com'], action: 'proxy' },
          { id: 'rule-private', condition: 'private-network', values: [], action: 'direct' },
        ],
        finalAction: 'direct',
      },
    })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ accessMode: 'tun' })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ lanEnabled: true })
    expect(harness.store.updateSettings).toHaveBeenCalledWith({ autoStart: false })
    expect(harness.runtime.closeConnection).toHaveBeenCalledWith('connection-one')
    expect(harness.runtime.reconcile.mock.calls.map(([reason]) => reason)).toEqual([
      'profile-imported',
      'profile-selected',
      'node-selected',
      'rule-mode-changed',
      'custom-rules-changed',
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

  it('preserves the last intent across true-false-true and mode reversal bursts', async () => {
    const master = createHarness()
    let releaseMaster!: () => void
    const masterGate = new Promise<void>((resolve) => { releaseMaster = resolve })
    let firstMaster = true
    master.runtime.setEnabled.mockImplementation(async (enabled: boolean) => {
      if (firstMaster) { firstMaster = false; await masterGate }
      master.state.desiredEnabled = enabled
      master.state.settings.desiredEnabled = enabled
      master.state.status = enabled ? 'ready' : 'disabled'
    })
    registerBuiltInProxyApi(master.store, master.runtime)
    const masterBurst = [
      invoke(builtInProxyIpcChannels.setEnabled, true),
      invoke(builtInProxyIpcChannels.setEnabled, false),
      invoke(builtInProxyIpcChannels.setEnabled, true),
    ]
    await vi.waitFor(() => expect(master.runtime.setEnabled).toHaveBeenCalledOnce())
    releaseMaster()
    await Promise.all(masterBurst)
    expect(master.runtime.setEnabled.mock.calls.map(([value]) => value)).toEqual([true, false, true])

    const lan = createHarness()
    let releaseLan!: () => void
    const lanGate = new Promise<void>((resolve) => { releaseLan = resolve })
    let firstLan = true
    lan.store.updateSettings.mockImplementation(async (patch) => {
      if (firstLan) { firstLan = false; await lanGate }
      Object.assign(lan.state.settings, patch)
    })
    registerBuiltInProxyApi(lan.store, lan.runtime)
    const lanBurst = [
      invoke(builtInProxyIpcChannels.setLanEnabled, true),
      invoke(builtInProxyIpcChannels.setLanEnabled, false),
      invoke(builtInProxyIpcChannels.setLanEnabled, true),
    ]
    await vi.waitFor(() => expect(lan.store.updateSettings).toHaveBeenCalledOnce())
    releaseLan()
    await Promise.all(lanBurst)
    expect(lan.store.updateSettings.mock.calls.map(([patch]) => patch)).toEqual([
      { lanEnabled: true }, { lanEnabled: false }, { lanEnabled: true },
    ])

    const access = createHarness()
    let releaseAccess!: () => void
    const accessGate = new Promise<void>((resolve) => { releaseAccess = resolve })
    let firstAccess = true
    access.store.updateSettings.mockImplementation(async (patch) => {
      if (firstAccess) { firstAccess = false; await accessGate }
      Object.assign(access.state.settings, patch)
    })
    registerBuiltInProxyApi(access.store, access.runtime)
    const accessBurst = [
      invoke(builtInProxyIpcChannels.setAccessMode, 'tun'),
      invoke(builtInProxyIpcChannels.setAccessMode, 'system'),
      invoke(builtInProxyIpcChannels.setAccessMode, 'tun'),
    ]
    await vi.waitFor(() => expect(access.store.updateSettings).toHaveBeenCalledOnce())
    releaseAccess()
    await Promise.all(accessBurst)
    expect(access.store.updateSettings.mock.calls.map(([patch]) => patch)).toEqual([
      { accessMode: 'tun' }, { accessMode: 'system' }, { accessMode: 'tun' },
    ])
  })

  it('keeps LAN exposure and access mode as independent persisted settings', async () => {
    const harness = createHarness()
    harness.state.settings.accessMode = 'system'
    harness.state.settings.lanEnabled = true
    registerBuiltInProxyApi(harness.store, harness.runtime)

    await invoke(builtInProxyIpcChannels.setAccessMode, 'tun')
    expect(harness.state.settings).toMatchObject({ accessMode: 'tun', lanEnabled: true })
    await invoke(builtInProxyIpcChannels.setLanEnabled, false)
    expect(harness.state.settings).toMatchObject({ accessMode: 'tun', lanEnabled: false })
    expect(harness.store.updateSettings.mock.calls.map(([patch]) => patch)).toEqual([
      { accessMode: 'tun' },
      { lanEnabled: false },
    ])
  })

  it('validates, serializes, and clears visual custom rules through reconciliation', async () => {
    const harness = createHarness()
    registerBuiltInProxyApi(harness.store, harness.runtime)

    const configured = {
      rules: [
        { id: 'rule-cidr', condition: 'ip-cidr', values: ['10.0.0.0/8'], action: 'block' },
        { id: 'rule-ports', condition: 'port-range', values: ['8000-9000'], action: 'proxy' },
      ],
      finalAction: 'proxy',
    }
    await invoke(builtInProxyIpcChannels.setCustomRules, configured)
    await invoke(builtInProxyIpcChannels.setCustomRules, configured)
    await invoke(builtInProxyIpcChannels.setCustomRules, null)

    expect(harness.store.updateSettings).toHaveBeenCalledTimes(2)
    expect(harness.store.updateSettings).toHaveBeenNthCalledWith(1, {
      customRules: {
        rules: [
          { id: 'rule-cidr', condition: 'ip-cidr', values: ['10.0.0.0/8'], action: 'block' },
          { id: 'rule-ports', condition: 'port-range', values: ['8000:9000'], action: 'proxy' },
        ],
        finalAction: 'proxy',
      },
    })
    expect(harness.store.updateSettings).toHaveBeenNthCalledWith(2, { customRules: undefined })
    expect(harness.runtime.reconcile).toHaveBeenCalledTimes(2)
    expect(harness.runtime.reconcile).toHaveBeenNthCalledWith(1, 'custom-rules-changed')
    expect(harness.runtime.reconcile).toHaveBeenNthCalledWith(2, 'custom-rules-changed')
  })

  it('closes mutation admission synchronously, drains accepted work, and shares one dispose flight', async () => {
    const harness = createHarness()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    harness.store.updateSettings.mockImplementation(async (patch) => {
      if (patch.ruleMode === 'global') await firstGate
      Object.assign(harness.state.settings, patch)
    })
    const dispose = registerBuiltInProxyApi(harness.store, harness.runtime)
    const staleHandler = electron.handlers.get(builtInProxyIpcChannels.setAutoStart)!

    const first = invoke(builtInProxyIpcChannels.setRuleMode, 'global')
    await vi.waitFor(() => expect(harness.store.updateSettings).toHaveBeenCalledTimes(1))
    const acceptedSecond = invoke(builtInProxyIpcChannels.setLanEnabled, true)
    const firstDispose = dispose()
    const secondDispose = dispose()

    expect(firstDispose).toBe(secondDispose)
    expect(electron.handlers.size).toBe(0)
    await expect(staleHandler(trustedEvent(), false)).rejects.toMatchObject({ category: 'unknown' })
    expect(harness.store.updateSettings).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.all([first, acceptedSecond, firstDispose])
    expect(harness.store.updateSettings).toHaveBeenNthCalledWith(2, { lanEnabled: true })
    expect(harness.store.updateSettings).not.toHaveBeenCalledWith({ autoStart: false })
  })

  it('drains an accepted mutation before the main-process exit boundary and resumes IPC on close failure', async () => {
    const harness = createHarness()
    let releaseMutation!: () => void
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve })
    harness.store.updateSettings.mockImplementation(async (patch) => {
      await mutationGate
      Object.assign(harness.state.settings, patch)
    })
    const dispose = registerBuiltInProxyApi(harness.store, harness.runtime)
    const accepted = invoke(builtInProxyIpcChannels.setLanEnabled, true)
    await vi.waitFor(() => expect(harness.store.updateSettings).toHaveBeenCalledOnce())
    const closeProxy = vi.fn(async () => { throw new Error('system proxy lease restore failed') })
    const resumeIpc = vi.fn()

    const shutdown = shutdownBuiltInProxyBoundary({
      quiesceIpc: dispose,
      closeProxy,
      resumeIpc,
    })
    void shutdown.catch(() => undefined)
    expect(electron.handlers.size).toBe(0)
    expect(closeProxy).not.toHaveBeenCalled()

    releaseMutation()
    await accepted
    await expect(shutdown).rejects.toThrow('system proxy lease restore failed')
    expect(closeProxy).toHaveBeenCalledOnce()
    expect(resumeIpc).toHaveBeenCalledOnce()
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

  it('coalesces only concurrent duplicates and never suppresses a later opposite lifecycle transition', async () => {
    const harness = createHarness()
    registerBuiltInProxyApi(harness.store, harness.runtime)

    await invoke(builtInProxyIpcChannels.setEnabled, true)
    await invoke(builtInProxyIpcChannels.setEnabled, false)
    await invoke(builtInProxyIpcChannels.setEnabled, true)

    expect(harness.runtime.setEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true])
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
    unsafeState.settings.customRules = {
      rules: [Object.assign(
        { id: 'rule-safe', condition: 'domain', values: ['safe.example'], action: 'proxy' },
        { controllerSecret: 'rule-private' },
      )],
      finalAction: 'direct',
      controllerSecret: 'rules-private',
    } as BuiltInProxyRuntimeState['settings']['customRules']
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
      expect(serialized).not.toContain('rule-private')
      expect(serialized).not.toContain('rules-private')
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
    await expect(invoke(builtInProxyIpcChannels.closeConnection, '')).rejects.toMatchObject({
      category: 'configuration-invalid',
    })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [{ id: 'bad-condition', condition: 'script', values: ['alert(1)'], action: 'proxy' }],
      finalAction: 'proxy',
    })).rejects.toMatchObject({ category: 'configuration-invalid' })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [], finalAction: 'proxy', unsupported: true,
    })).rejects.toMatchObject({ category: 'configuration-invalid' })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [{ id: 'extra-field', condition: 'domain', values: ['example.com'], action: 'proxy', unsafe: true }],
      finalAction: 'proxy',
    })).rejects.toMatchObject({ category: 'configuration-invalid' })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [{ id: 'bad-range', condition: 'port-range', values: ['9000:8000'], action: 'proxy' }],
      finalAction: 'direct',
    })).rejects.toMatchObject({ category: 'configuration-invalid' })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [{ id: 'empty-domain', condition: 'domain', values: [], action: 'proxy' }],
      finalAction: 'proxy',
    })).rejects.toMatchObject({ category: 'configuration-invalid' })
    await expect(invoke(builtInProxyIpcChannels.setCustomRules, {
      rules: [{ id: 'bad-private', condition: 'private-network', values: ['unexpected'], action: 'direct' }],
      finalAction: 'proxy',
    })).rejects.toMatchObject({ category: 'configuration-invalid' })

    expect(harness.runtime.setEnabled).not.toHaveBeenCalled()
    expect(harness.runtime.closeConnection).not.toHaveBeenCalled()
    expect(harness.store.importProfile).not.toHaveBeenCalled()
    expect(harness.store.updateSettings).not.toHaveBeenCalled()
  })

  it('exposes the custom-rule mutation through preload without widening its payload', async () => {
    vi.resetModules()
    electron.ipcInvoke.mockResolvedValue({ status: 'ready' })
    await import('../../src/preload/index')
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'stone')?.[1] as {
      setBuiltInProxyCustomRules(value: unknown): Promise<unknown>
    }
    const value = { rules: [], finalAction: 'direct' }

    await exposed.setBuiltInProxyCustomRules(value)

    expect(electron.ipcInvoke).toHaveBeenCalledWith(
      builtInProxyIpcChannels.setCustomRules,
      value,
    )
  })

  it('unsubscribes and removes fixed handlers on disposal', async () => {
    const harness = createHarness()
    const unsubscribe = vi.fn()
    harness.runtime.subscribe.mockReturnValue(unsubscribe)
    const dispose = registerBuiltInProxyApi(harness.store, harness.runtime)

    await Promise.all([dispose(), dispose()])

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
    accessState: { mode: 'system', status: 'idle' },
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
