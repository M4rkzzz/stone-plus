import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { BrowserWindow, ipcMain } from 'electron'
import type {
  BuiltInProxyCustomRuleSet,
  BuiltInProxyImportInput,
  BuiltInProxyNodeSummary,
  BuiltInProxyRuntimeState,
  BuiltInProxySettings,
  ProxyConnectionSummary,
  ProxyTrafficSnapshot,
} from '@shared/types'
import { assertTrustedSender } from './trusted-sender'

type MaybePromise<T> = T | Promise<T>

export type BuiltInProxyReconcileReason =
  | 'profile-imported'
  | 'profile-refreshed'
  | 'profile-deleted'
  | 'profile-selected'
  | 'node-selected'
  | 'rule-mode-changed'
  | 'custom-rules-changed'
  | 'access-mode-changed'
  | 'lan-changed'
  | 'auto-start-changed'

export interface BuiltInProxyStoreFacade {
  importProfile(input: BuiltInProxyImportInput): Promise<void>
  refreshProfile(id: string): Promise<void>
  deleteProfile(id: string): Promise<void>
  selectProfile(id: string): Promise<void>
  selectNode(profileId: string, nodeId: string): Promise<void>
  updateSettings(
    patch: Partial<Pick<BuiltInProxySettings, 'ruleMode' | 'customRules' | 'accessMode' | 'lanEnabled' | 'autoStart'>>,
  ): Promise<void>
}

export interface BuiltInProxyRuntimeFacade {
  getState(): MaybePromise<BuiltInProxyRuntimeState>
  setEnabled(enabled: boolean): Promise<void>
  retry(): Promise<void>
  reconcile(reason: BuiltInProxyReconcileReason): Promise<void>
  /** Allows a coordinator to put persistence and route reconciliation in one rollback boundary. */
  coordinateMutation?(
    reason: BuiltInProxyReconcileReason,
    mutation: () => Promise<void>,
  ): Promise<void>
  testLatency(profileId?: string, nodeIds?: string[]): Promise<BuiltInProxyNodeSummary[]>
  getTraffic(): MaybePromise<ProxyTrafficSnapshot>
  listConnections(): MaybePromise<ProxyConnectionSummary[]>
  closeConnection(id: string): Promise<void>
  subscribe?(listener: (state: BuiltInProxyRuntimeState) => void): () => void
}

export interface BuiltInProxyShutdownBoundary {
  quiesceIpc(): Promise<void>
  closeProxy(): Promise<void>
  resumeIpc(): void
}

/**
 * Crosses the process-exit boundary only after renderer mutations have
 * drained. A failed route/access cleanup reopens IPC so the user can retry
 * while the still-owned proxy core remains supervised by the main process.
 */
export async function shutdownBuiltInProxyBoundary(
  boundary: BuiltInProxyShutdownBoundary,
): Promise<void> {
  try {
    await boundary.quiesceIpc()
    await boundary.closeProxy()
  } catch (error) {
    boundary.resumeIpc()
    throw error
  }
}

export const builtInProxyIpcChannels = {
  getState: 'stone:get-built-in-proxy-state',
  setEnabled: 'stone:set-built-in-proxy-enabled',
  retry: 'stone:retry-built-in-proxy',
  importProfile: 'stone:import-built-in-proxy-profile',
  refreshProfile: 'stone:refresh-built-in-proxy-profile',
  deleteProfile: 'stone:delete-built-in-proxy-profile',
  selectProfile: 'stone:select-built-in-proxy-profile',
  selectNode: 'stone:select-built-in-proxy-node',
  setRuleMode: 'stone:set-built-in-proxy-rule-mode',
  setCustomRules: 'stone:set-built-in-proxy-custom-rules',
  setAccessMode: 'stone:set-built-in-proxy-access-mode',
  setLanEnabled: 'stone:set-built-in-proxy-lan-enabled',
  setAutoStart: 'stone:set-built-in-proxy-auto-start',
  testLatency: 'stone:test-built-in-proxy-latency',
  getTraffic: 'stone:get-built-in-proxy-traffic',
  listConnections: 'stone:list-built-in-proxy-connections',
  closeConnection: 'stone:close-built-in-proxy-connection',
  stateChanged: 'stone:built-in-proxy-state',
} as const

const profileFormats = new Set(['sing-box-json', 'clash-meta-yaml', 'uri-list'])
const ruleModes = new Set(['rule', 'global', 'direct'])
const customRuleConditions = new Set([
  'domain',
  'domain-suffix',
  'domain-keyword',
  'ip-cidr',
  'port',
  'port-range',
  'network',
  'protocol',
  'private-network',
  'mainland-china',
])
const customRuleActions = new Set(['proxy', 'direct', 'block'])
const customRuleFinalActions = new Set(['proxy', 'direct'])
const valuelessCustomRuleConditions = new Set(['private-network', 'mainland-china'])
const maxCustomRules = 500
const maxCustomRuleValues = 128
const maxCustomRuleTotalValues = 5_000
const maxCustomRuleValueLength = 1_024
const maxCustomRulesPayloadLength = 256 * 1_024
const networkValues = new Set(['tcp', 'udp'])
const accessModes = new Set(['system', 'tun'])
const publicErrorCategories = new Set([
  'core-missing',
  'core-integrity',
  'configuration-invalid',
  'node-handshake',
  'mixed-port',
  'tun-elevation',
  'subscription-update',
  'system-proxy',
  'health-check',
  'core-crashed',
  'unknown',
])
const publicErrorMarker = 'stone-built-in-proxy-error'

export function registerBuiltInProxyApi(
  store: BuiltInProxyStoreFacade,
  runtime: BuiltInProxyRuntimeFacade,
): () => Promise<void> {
  let mutationTail: Promise<void> = Promise.resolve()
  let lastQueuedMutation: { key: string; promise: Promise<unknown> } | undefined
  let disposed = false
  let disposeFlight: Promise<void> | undefined

  const readPublicState = async (): Promise<BuiltInProxyRuntimeState> => {
    return projectRuntimeState(await runtime.getState())
  }

  const runRead = async <T>(operation: () => MaybePromise<T>, projector: (value: T) => T): Promise<T> => {
    try {
      return projector(await operation())
    } catch (error) {
      throw toPublicError(error)
    }
  }

  const enqueueMutation = <T>(
    key: string,
    operation: () => Promise<T>,
    secrets: readonly string[] = [],
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(toPublicError(new BuiltInProxyIpcError(
        'unknown',
        'The built-in proxy API is closing.',
      )))
    }
    // Coalesce only adjacent identical intent. A(true) -> B(false) -> C(true)
    // must execute C after B; a global key map incorrectly reused A for C.
    if (lastQueuedMutation?.key === key) return lastQueuedMutation.promise as Promise<T>

    const result = mutationTail.then(operation, operation).catch((error: unknown) => {
      throw toPublicError(error, secrets)
    })
    mutationTail = result.then(() => undefined, () => undefined)
    lastQueuedMutation = { key, promise: result }
    void result.then(() => {
      if (lastQueuedMutation?.promise === result) lastQueuedMutation = undefined
    }, () => {
      if (lastQueuedMutation?.promise === result) lastQueuedMutation = undefined
    })
    return result
  }

  const reconcileStoreMutation = async (
    reason: BuiltInProxyReconcileReason,
    mutation: () => Promise<void>,
  ): Promise<BuiltInProxyRuntimeState> => {
    if (runtime.coordinateMutation) {
      await runtime.coordinateMutation(reason, mutation)
    } else {
      await mutation()
      await runtime.reconcile(reason)
    }
    return readPublicState()
  }

  const register = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, handler)
  }

  register(builtInProxyIpcChannels.getState, (event) => {
    assertTrustedSender(event)
    return runRead(() => runtime.getState(), projectRuntimeState)
  })

  register(builtInProxyIpcChannels.setEnabled, (event, value: unknown) => {
    assertTrustedSender(event)
    const enabled = requireBoolean(value, 'enabled')
    return enqueueMutation(`enabled:${enabled}`, async () => {
      const state = await readPublicState()
      if (
        state.desiredEnabled === enabled
        && (enabled ? state.status !== 'disabled' : state.status === 'disabled')
      ) return state
      await runtime.setEnabled(enabled)
      return readPublicState()
    })
  })

  register(builtInProxyIpcChannels.retry, (event) => {
    assertTrustedSender(event)
    return enqueueMutation('retry', async () => {
      await runtime.retry()
      return readPublicState()
    })
  })

  register(builtInProxyIpcChannels.importProfile, (event, value: unknown) => {
    assertTrustedSender(event)
    const input = normalizeImportInput(value)
    const fingerprint = digestMutationInput(input)
    const secrets = input.source === 'subscription'
      ? [input.url, input.token ?? '']
      : [input.content]
    return enqueueMutation(`import:${fingerprint}`, () => reconcileStoreMutation(
      'profile-imported',
      () => store.importProfile(input),
    ), secrets)
  })

  register(builtInProxyIpcChannels.refreshProfile, (event, value: unknown) => {
    assertTrustedSender(event)
    const id = requireIdentifier(value, 'profile id')
    return enqueueMutation(`refresh:${id}`, () => reconcileStoreMutation(
      'profile-refreshed',
      () => store.refreshProfile(id),
    ))
  })

  register(builtInProxyIpcChannels.deleteProfile, (event, value: unknown) => {
    assertTrustedSender(event)
    const id = requireIdentifier(value, 'profile id')
    return enqueueMutation(`delete:${id}`, async () => {
      const state = await readPublicState()
      if (!state.profiles.some((profile) => profile.id === id)) return state
      return reconcileStoreMutation('profile-deleted', () => store.deleteProfile(id))
    })
  })

  register(builtInProxyIpcChannels.selectProfile, (event, value: unknown) => {
    assertTrustedSender(event)
    const id = requireIdentifier(value, 'profile id')
    return enqueueMutation(`select-profile:${id}`, async () => {
      const state = await readPublicState()
      if (state.settings.activeProfileId === id) return state
      return reconcileStoreMutation('profile-selected', () => store.selectProfile(id))
    })
  })

  register(builtInProxyIpcChannels.selectNode, (event, profileValue: unknown, nodeValue: unknown) => {
    assertTrustedSender(event)
    const profileId = requireIdentifier(profileValue, 'profile id')
    const nodeId = requireIdentifier(nodeValue, 'node id')
    return enqueueMutation(`select-node:${profileId}:${nodeId}`, async () => {
      const state = await readPublicState()
      const profile = state.profiles.find((candidate) => candidate.id === profileId)
      if (profile?.activeNodeId === nodeId) return state
      return reconcileStoreMutation('node-selected', () => store.selectNode(profileId, nodeId))
    })
  })

  register(builtInProxyIpcChannels.setRuleMode, (event, value: unknown) => {
    assertTrustedSender(event)
    const mode = requireEnum(value, ruleModes, 'rule mode') as BuiltInProxySettings['ruleMode']
    return enqueueMutation(`rule-mode:${mode}`, async () => {
      const state = await readPublicState()
      if (state.settings.ruleMode === mode) return state
      return reconcileStoreMutation('rule-mode-changed', () => store.updateSettings({ ruleMode: mode }))
    })
  })

  register(builtInProxyIpcChannels.setCustomRules, (event, value: unknown) => {
    assertTrustedSender(event)
    const requestedRules = normalizeCustomRules(value)
    const customRules = requestedRules ?? undefined
    const fingerprint = digestMutationInput(requestedRules)
    return enqueueMutation(`custom-rules:${fingerprint}`, async () => {
      const state = await readPublicState()
      if (JSON.stringify(state.settings.customRules) === JSON.stringify(customRules)) return state
      return reconcileStoreMutation(
        'custom-rules-changed',
        () => store.updateSettings({ customRules }),
      )
    })
  })

  register(builtInProxyIpcChannels.setAccessMode, (event, value: unknown) => {
    assertTrustedSender(event)
    const mode = requireEnum(value, accessModes, 'access mode') as BuiltInProxySettings['accessMode']
    return enqueueMutation(`access-mode:${mode}`, async () => {
      const state = await readPublicState()
      if (state.settings.accessMode === mode) return state
      return reconcileStoreMutation('access-mode-changed', () => store.updateSettings({ accessMode: mode }))
    })
  })

  register(builtInProxyIpcChannels.setLanEnabled, (event, value: unknown) => {
    assertTrustedSender(event)
    const enabled = requireBoolean(value, 'LAN enabled')
    return enqueueMutation(`lan:${enabled}`, async () => {
      const state = await readPublicState()
      if (state.settings.lanEnabled === enabled) return state
      return reconcileStoreMutation('lan-changed', () => store.updateSettings({ lanEnabled: enabled }))
    })
  })

  register(builtInProxyIpcChannels.setAutoStart, (event, value: unknown) => {
    assertTrustedSender(event)
    const enabled = requireBoolean(value, 'auto-start enabled')
    return enqueueMutation(`auto-start:${enabled}`, async () => {
      const state = await readPublicState()
      if (state.settings.autoStart === enabled) return state
      return reconcileStoreMutation('auto-start-changed', () => store.updateSettings({ autoStart: enabled }))
    })
  })

  register(builtInProxyIpcChannels.testLatency, (event, profileValue: unknown, nodeValues: unknown) => {
    assertTrustedSender(event)
    const profileId = profileValue === undefined
      ? undefined
      : requireIdentifier(profileValue, 'profile id')
    const nodeIds = normalizeOptionalIdentifiers(nodeValues, 'node ids')
    const key = digestMutationInput({ profileId, nodeIds })
    return enqueueMutation(`latency:${key}`, () => runRead(
      () => runtime.testLatency(profileId, nodeIds),
      projectNodeSummaries,
    ))
  })

  register(builtInProxyIpcChannels.getTraffic, (event) => {
    assertTrustedSender(event)
    return runRead(() => runtime.getTraffic(), projectTrafficSnapshot)
  })

  register(builtInProxyIpcChannels.listConnections, (event) => {
    assertTrustedSender(event)
    return runRead(() => runtime.listConnections(), projectConnectionSummaries)
  })

  register(builtInProxyIpcChannels.closeConnection, (event, value: unknown) => {
    assertTrustedSender(event)
    const id = requireIdentifier(value, 'connection id')
    return enqueueMutation(`close-connection:${id}`, () => runtime.closeConnection(id))
  })

  const unsubscribe = runtime.subscribe?.((state) => {
    if (disposed) return
    const publicState = projectRuntimeState(state)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(builtInProxyIpcChannels.stateChanged, publicState)
    }
  })

  return () => {
    if (disposeFlight) return disposeFlight
    disposed = true
    unsubscribe?.()
    for (const channel of Object.values(builtInProxyIpcChannels)) {
      if (channel !== builtInProxyIpcChannels.stateChanged) ipcMain.removeHandler(channel)
    }
    const acceptedMutations = mutationTail
    disposeFlight = acceptedMutations.finally(() => {
      lastQueuedMutation = undefined
    })
    return disposeFlight
  }
}

function normalizeImportInput(value: unknown): BuiltInProxyImportInput {
  if (!isRecord(value)) throw new BuiltInProxyIpcError('configuration-invalid', 'Import input must be an object.')
  const source = value.source
  const name = normalizeOptionalName(value.name)
  const format = value.format === undefined
    ? undefined
    : requireEnum(value.format, profileFormats, 'profile format') as BuiltInProxyImportInput['format']

  if (source === 'subscription') {
    const rawUrl = requireText(value.url, 'subscription URL', 16_384)
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new BuiltInProxyIpcError('subscription-update', 'Subscription URL is invalid.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BuiltInProxyIpcError('subscription-update', 'Subscription URL must use HTTP or HTTPS.')
    }
    const token = normalizeOptionalSecret(value.token, 'subscription token')
    return { source, ...(name ? { name } : {}), url: rawUrl, ...(token ? { token } : {}), ...(format ? { format } : {}) }
  }

  if (source === 'import') {
    const content = requireText(value.content, 'profile content', 10 * 1024 * 1024, false)
    return { source, ...(name ? { name } : {}), content, ...(format ? { format } : {}) }
  }

  throw new BuiltInProxyIpcError('configuration-invalid', 'Import source must be subscription or import.')
}

function normalizeOptionalName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const name = requireText(value, 'profile name', 256)
  return name
}

function normalizeOptionalSecret(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} is invalid.`)
  }
  return value
}

function normalizeOptionalIdentifiers(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} must be an array.`)
  }
  return [...new Set(value.map((item) => requireIdentifier(item, label)))]
}

function normalizeCustomRules(value: unknown): BuiltInProxyCustomRuleSet | null {
  if (value === null) return null
  if (!isRecord(value)) {
    throw new BuiltInProxyIpcError('configuration-invalid', 'Custom rules must be an object.')
  }
  if (JSON.stringify(value).length > maxCustomRulesPayloadLength) {
    throw new BuiltInProxyIpcError('configuration-invalid', 'Custom rules payload is too large.')
  }
  requireOnlyKeys(value, new Set(['rules', 'finalAction']), 'Custom rules')
  if (!Array.isArray(value.rules) || value.rules.length > maxCustomRules) {
    throw new BuiltInProxyIpcError(
      'configuration-invalid',
      `Custom rules must contain at most ${maxCustomRules} rules.`,
    )
  }
  const finalAction = requireEnum(
    value.finalAction,
    customRuleFinalActions,
    'custom rule final action',
  ) as BuiltInProxyCustomRuleSet['finalAction']
  let totalValues = 0
  const ids = new Set<string>()
  const rules = value.rules.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new BuiltInProxyIpcError('configuration-invalid', `Custom rule ${index + 1} must be an object.`)
    }
    requireOnlyKeys(candidate, new Set(['id', 'condition', 'values', 'action']), `Custom rule ${index + 1}`)
    const id = requireText(candidate.id, `custom rule ${index + 1} id`, 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || ids.has(id)) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rule ${index + 1} has an invalid or duplicate id.`,
      )
    }
    ids.add(id)
    const condition = requireEnum(
      candidate.condition,
      customRuleConditions,
      `custom rule ${index + 1} condition`,
    ) as BuiltInProxyCustomRuleSet['rules'][number]['condition']
    const action = requireEnum(
      candidate.action,
      customRuleActions,
      `custom rule ${index + 1} action`,
    ) as BuiltInProxyCustomRuleSet['rules'][number]['action']
    if (!Array.isArray(candidate.values) || candidate.values.length > maxCustomRuleValues) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rule ${index + 1} values must contain at most ${maxCustomRuleValues} items.`,
      )
    }
    totalValues += candidate.values.length
    if (totalValues > maxCustomRuleTotalValues) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rules must contain at most ${maxCustomRuleTotalValues} values.`,
      )
    }
    const values = candidate.values.map((item) => validateCustomRuleValue(
      condition,
      requireText(item, `custom rule ${index + 1} value`, maxCustomRuleValueLength),
      index,
    ))
    if (new Set(values).size !== values.length) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rule ${index + 1} contains duplicate values.`,
      )
    }
    if (!valuelessCustomRuleConditions.has(condition) && values.length === 0) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rule ${index + 1} requires at least one value.`,
      )
    }
    if (valuelessCustomRuleConditions.has(condition) && values.length !== 0) {
      throw new BuiltInProxyIpcError(
        'configuration-invalid',
        `Custom rule ${index + 1} condition does not accept values.`,
      )
    }
    return { id, condition, values, action }
  })
  return { rules, finalAction }
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} contains unsupported fields.`)
  }
}

function validateCustomRuleValue(condition: string, value: string, index: number): string {
  const invalid = (): never => {
    throw new BuiltInProxyIpcError(
      'configuration-invalid',
      `Custom rule ${index + 1} contains an invalid ${condition} value.`,
    )
  }
  if (condition === 'ip-cidr') {
    const [address, rawPrefix, extra] = value.split('/')
    const version = isIP(address)
    const prefix = rawPrefix === undefined ? (version === 4 ? 32 : 128) : Number(rawPrefix)
    if (version === 0 || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) invalid()
    return `${address}/${prefix}`
  }
  if (condition === 'port') {
    if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65_535) invalid()
    return String(Number(value))
  }
  if (condition === 'port-range') {
    const match = /^(\d{1,5})[:-](\d{1,5})$/.exec(value)
    if (!match) return invalid()
    const start = Number(match[1])
    const end = Number(match[2])
    if (start < 1 || end > 65_535 || start > end) invalid()
    return `${start}:${end}`
  }
  if (condition === 'network') {
    const normalized = value.toLowerCase()
    if (!networkValues.has(normalized)) invalid()
    return normalized
  }
  if (condition === 'protocol') {
    const normalized = value.toLowerCase()
    if (!/^[a-z0-9_-]{1,32}$/.test(normalized)) invalid()
    return normalized
  }
  if (condition === 'domain' || condition === 'domain-suffix') {
    const normalized = value.toLowerCase().replace(condition === 'domain-suffix' ? /^\./ : /$^/, '')
    if (
      isIP(normalized)
      || !/^(?=.{1,253}$)(?:[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?\.)*[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?$/i.test(normalized)
    ) invalid()
    return normalized
  }
  if (condition === 'domain-keyword') {
    if (value.length > 128 || hasControlCharacters(value)) invalid()
    return value
  }
  return invalid()
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
}

function requireIdentifier(value: unknown, label: string): string {
  return requireText(value, label, 512)
}

function requireText(value: unknown, label: string, maxLength: number, trim = true): string {
  if (typeof value !== 'string') {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} must be text.`)
  }
  const normalized = trim ? value.trim() : value
  if (normalized.trim().length === 0 || normalized.length > maxLength) {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} is invalid.`)
  }
  return normalized
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} must be a boolean.`)
  }
  return value
}

function requireEnum(value: unknown, allowed: ReadonlySet<string>, label: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new BuiltInProxyIpcError('configuration-invalid', `${label} is invalid.`)
  }
  return value
}

function digestMutationInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

type Projection = true | { readonly [key: string]: Projection } | readonly [Projection]

const nodeProjection = {
  id: true,
  name: true,
  type: true,
  groupIds: [true],
  latencyMs: true,
  latencyStatus: true,
  lastTestedAt: true,
} as const satisfies Projection

const runtimeStateProjection = {
  desiredEnabled: true,
  status: true,
  routeGeneration: true,
  settings: {
    desiredEnabled: true,
    activeProfileId: true,
    accessMode: true,
    ruleMode: true,
    customRules: {
      rules: [{
        id: true,
        condition: true,
        values: [true],
        action: true,
      }],
      finalAction: true,
    },
    mixedPort: true,
    lanEnabled: true,
    autoStart: true,
    hasEverActivated: true,
    lastActivatedAt: true,
    updatedAt: true,
  },
  profiles: [{
    id: true,
    name: true,
    source: true,
    format: true,
    nodes: [nodeProjection],
    nodeCount: true,
    groupCount: true,
    ruleStatus: true,
    activeNodeId: true,
    warning: true,
    createdAt: true,
    updatedAt: true,
    lastRefreshAt: true,
  }],
  effectiveRoute: {
    generation: true,
    kind: true,
    externalMode: true,
    profileId: true,
    nodeId: true,
    mixedPort: true,
    activatedAt: true,
  },
  accessState: {
    mode: true,
    status: true,
    endpoint: true,
    verifiedAt: true,
  },
  coreVersion: true,
  startedAt: true,
  lastReadyAt: true,
  error: {
    category: true,
    message: true,
    retryable: true,
  },
} as const satisfies Projection

const trafficProjection = {
  capturedAt: true,
  uploadBytes: true,
  downloadBytes: true,
  uploadRateBytesPerSecond: true,
  downloadRateBytesPerSecond: true,
  activeConnections: true,
  totalConnections: true,
} as const satisfies Projection

const connectionProjection = {
  id: true,
  protocol: true,
  network: true,
  source: true,
  destination: true,
  outbound: true,
  profileId: true,
  nodeId: true,
  uploadBytes: true,
  downloadBytes: true,
  startedAt: true,
} as const satisfies Projection

function projectRuntimeState(value: BuiltInProxyRuntimeState): BuiltInProxyRuntimeState {
  const projected = projectValue(value, runtimeStateProjection) as BuiltInProxyRuntimeState
  if (projected.error) {
    projected.error.message = sanitizeMessage(projected.error.message)
  }
  return projected
}

function projectNodeSummaries(value: BuiltInProxyNodeSummary[]): BuiltInProxyNodeSummary[] {
  return projectValue(value, [nodeProjection]) as BuiltInProxyNodeSummary[]
}

function projectTrafficSnapshot(value: ProxyTrafficSnapshot): ProxyTrafficSnapshot {
  return projectValue(value, trafficProjection) as ProxyTrafficSnapshot
}

function projectConnectionSummaries(value: ProxyConnectionSummary[]): ProxyConnectionSummary[] {
  return projectValue(value, [connectionProjection]) as ProxyConnectionSummary[]
}

function projectValue(value: unknown, projection: Projection): unknown {
  if (projection === true) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
    return undefined
  }
  if (Array.isArray(projection)) {
    if (!Array.isArray(value)) return []
    return value.map((item) => projectValue(item, projection[0]))
  }
  if (!isRecord(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, childProjection] of Object.entries(projection)) {
    if (!(key in value) || value[key] === undefined) continue
    const child = projectValue(value[key], childProjection)
    if (child !== undefined) result[key] = child
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class BuiltInProxyIpcError extends Error {
  readonly category: string
  readonly code: string
  readonly retryable: boolean

  constructor(category: string, message: string, retryable = false) {
    // Electron preserves an invoked handler's error message, but not custom Error
    // properties. The preload converts this marker back into a classified Error.
    super(`[${publicErrorMarker}:${category}:${retryable ? 'retryable' : 'fatal'}] ${message}`)
    this.name = 'BuiltInProxyError'
    this.category = category
    this.code = category
    this.retryable = retryable
  }
}

function toPublicError(error: unknown, secrets: readonly string[] = []): BuiltInProxyIpcError {
  const record = isRecord(error) ? error : undefined
  const rawCategory = record?.category ?? record?.code
  const category = typeof rawCategory === 'string' && publicErrorCategories.has(rawCategory)
    ? rawCategory
    : 'unknown'
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : 'Built-in proxy operation failed.'
  const retryable = typeof record?.retryable === 'boolean' ? record.retryable : false
  return new BuiltInProxyIpcError(category, sanitizeMessage(rawMessage, secrets), retryable)
}

function sanitizeMessage(message: string, secrets: readonly string[] = []): string {
  let safe = String(message).slice(0, 2_000)
  for (const secret of [...secrets].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    safe = safe.replaceAll(secret, '[redacted]')
  }
  safe = safe
    .replace(/\b(?:https?|socks5?|ss|ssr|vmess|vless|trojan|hysteria2?|tuic):\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(?:bearer|token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/("(?:token|password|passwd|secret|authorization)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
  return safe || 'Built-in proxy operation failed.'
}
