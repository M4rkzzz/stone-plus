import type {
  BuiltInProxyAccessMode,
  BuiltInProxyProfileSummary,
  BuiltInProxyRuleMode,
  BuiltInProxyRuntimeState,
  EffectiveOutboundRoute,
  OutboundNetworkMode,
} from '@shared/types'

export const BUILT_IN_PROXY_WORKSPACE_TABS = [
  'overview',
  'profiles',
  'nodes',
  'rules',
  'access',
  'activity',
] as const

export type BuiltInProxyWorkspaceTab = typeof BUILT_IN_PROXY_WORKSPACE_TABS[number]

export const DEFAULT_BUILT_IN_PROXY_WORKSPACE_TAB: BuiltInProxyWorkspaceTab = 'overview'
export const BUILT_IN_PROXY_WORKSPACE_PREFERENCES_VERSION = 1 as const

export interface BuiltInProxyWorkspacePreferences {
  version: typeof BUILT_IN_PROXY_WORKSPACE_PREFERENCES_VERSION
  activeTab: BuiltInProxyWorkspaceTab
}

export type BuiltInProxyWorkspacePhase =
  | 'inactive'
  | 'needs-profile'
  | 'starting'
  | 'ready'
  | 'restoring'
  | 'blocked'
  | 'failed'
  | 'inconsistent'

export type BuiltInProxyWorkspaceTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface BuiltInProxyWorkspaceRuntimeSummary {
  phase: BuiltInProxyWorkspacePhase
  tone: BuiltInProxyWorkspaceTone
  desiredEnabled: boolean
  /** A previously verified route generation still serving Stone+ requests. */
  effectiveBuiltInRouteActive: boolean
  takeoverVerified: boolean
  accessApplied: boolean
  failClosed: boolean
  needsProfile: boolean
  canRetry: boolean
  generationConsistent: boolean
  routeGeneration: number
  accessMode: BuiltInProxyAccessMode
  ruleMode: BuiltInProxyRuleMode
  profileCount: number
  nodeCount: number
  activeProfileId?: string
  activeProfileName?: string
  selectedNodeId?: string
  selectedNodeName?: string
  effectiveNodeId?: string
  effectiveNodeName?: string
  mixedPort?: number
  effectiveMixedPort?: number
  errorCategory?: NonNullable<BuiltInProxyRuntimeState['error']>['category']
}

export type BuiltInProxyStoneRequestImpact =
  | 'external-route'
  | 'built-in-route'
  | 'blocked'
  | 'transitioning'
  | 'unconfirmed'

export interface BuiltInProxyImpactSummary {
  newStoneRequests: BuiltInProxyStoneRequestImpact
  allNewStoneRequestsAffected: boolean
  externalBindings: 'active' | 'preserved-paused'
  savedExternalRoute: 'preserved'
  accessMode: BuiltInProxyAccessMode
  accessStatus: BuiltInProxyRuntimeState['accessState']['status']
}

export type BuiltInProxyRouteChainStep =
  | { kind: 'stone' }
  | { kind: 'external'; mode?: OutboundNetworkMode }
  | { kind: 'mixed'; endpoint: string; port: number }
  | { kind: 'tun'; mixedEndpoint: string; mixedPort: number }
  | {
    kind: 'policy'
    mode: BuiltInProxyRuleMode
    source: 'profile' | 'built-in-fallback' | 'custom' | 'not-applicable' | 'unconfirmed'
  }
  | {
    kind: 'node'
    role: 'selected-proxy-outbound'
    profileId: string
    nodeId: string
    name: string
  }
  | { kind: 'direct' }
  | { kind: 'blocked' }
  | { kind: 'transition'; lifecycle: BuiltInProxyRuntimeState['status'] }

export interface BuiltInProxyRouteChainSummary {
  kind: 'external' | 'built-in' | 'blocked' | 'unconfirmed'
  generation: number
  verified: boolean
  steps: BuiltInProxyRouteChainStep[]
}

/** Parse a single persisted tab value without trusting arbitrary strings. */
export function parseBuiltInProxyWorkspaceTab(
  value: unknown,
  fallback: BuiltInProxyWorkspaceTab = DEFAULT_BUILT_IN_PROXY_WORKSPACE_TAB,
): BuiltInProxyWorkspaceTab {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return isWorkspaceTab(trimmed) ? trimmed : fallback
}

/**
 * Parse localStorage-compatible preferences. A direct tab string is accepted
 * as a harmless legacy representation; malformed or future-version JSON is
 * reset to the supplied fallback.
 */
export function parseBuiltInProxyWorkspacePreferences(
  persisted: unknown,
  fallback: BuiltInProxyWorkspaceTab = DEFAULT_BUILT_IN_PROXY_WORKSPACE_TAB,
): BuiltInProxyWorkspacePreferences {
  let candidate = persisted
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim()
    if (isWorkspaceTab(trimmed)) return workspacePreferences(trimmed)
    if (!trimmed || trimmed.length > 4_096) return workspacePreferences(fallback)
    try {
      candidate = JSON.parse(trimmed) as unknown
    } catch {
      return workspacePreferences(fallback)
    }
  }
  if (!isRecord(candidate) || candidate.version !== BUILT_IN_PROXY_WORKSPACE_PREFERENCES_VERSION) {
    return workspacePreferences(fallback)
  }
  return workspacePreferences(parseBuiltInProxyWorkspaceTab(candidate.activeTab, fallback))
}

export function serializeBuiltInProxyWorkspacePreferences(
  preferences: Pick<BuiltInProxyWorkspacePreferences, 'activeTab'>,
): string {
  return JSON.stringify(workspacePreferences(parseBuiltInProxyWorkspaceTab(preferences.activeTab)))
}

/** Reduce backend truth into stable presentation tokens; no planned endpoint is reported as active. */
export function summarizeBuiltInProxyRuntime(
  runtime: BuiltInProxyRuntimeState,
): BuiltInProxyWorkspaceRuntimeSummary {
  const selection = resolveWorkspaceSelection(runtime)
  const generationConsistent = runtime.routeGeneration === runtime.effectiveRoute.generation
  const effectiveMixedPort = generationConsistent
    && (runtime.effectiveRoute.kind === 'built-in-mixed' || runtime.effectiveRoute.kind === 'built-in-tun')
    && validPort(runtime.effectiveRoute.mixedPort)
    ? runtime.effectiveRoute.mixedPort
    : undefined
  const effectiveBuiltInRouteActive = effectiveMixedPort !== undefined
  const mixedPort = verifiedMixedPort(runtime, generationConsistent)
  const takeoverVerified = mixedPort !== undefined
  const needsProfile = runtime.desiredEnabled
    && runtime.profiles.length === 0
    && !runtime.settings.hasEverActivated
  const phase = resolveWorkspacePhase(runtime, takeoverVerified, needsProfile)
  const effectiveNode = effectiveBuiltInRouteActive && selection.profile
    ? selection.profile.nodes.find((node) => node.id === runtime.effectiveRoute.nodeId)
    : undefined
  return {
    phase,
    tone: toneForPhase(phase),
    desiredEnabled: runtime.desiredEnabled,
    effectiveBuiltInRouteActive,
    takeoverVerified,
    accessApplied: takeoverVerified,
    failClosed: runtime.effectiveRoute.kind === 'blocked',
    needsProfile,
    canRetry: runtime.error?.retryable === true,
    generationConsistent,
    routeGeneration: runtime.effectiveRoute.generation,
    accessMode: runtime.settings.accessMode,
    ruleMode: runtime.settings.ruleMode,
    profileCount: runtime.profiles.length,
    nodeCount: runtime.profiles.reduce((total, profile) => total + profile.nodeCount, 0),
    ...(selection.profile ? {
      activeProfileId: selection.profile.id,
      activeProfileName: selection.profile.name,
    } : {}),
    ...(selection.selectedNode ? {
      selectedNodeId: selection.selectedNode.id,
      selectedNodeName: selection.selectedNode.name,
    } : {}),
    ...(effectiveNode ? {
      effectiveNodeId: effectiveNode.id,
      effectiveNodeName: effectiveNode.name,
    } : {}),
    ...(mixedPort !== undefined ? { mixedPort } : {}),
    ...(effectiveMixedPort !== undefined ? { effectiveMixedPort } : {}),
    ...(runtime.error ? { errorCategory: runtime.error.category } : {}),
  }
}

/** Describe only Stone+ request routing and the preserved external bindings. */
export function summarizeBuiltInProxyImpact(
  runtime: BuiltInProxyRuntimeState,
): BuiltInProxyImpactSummary {
  const summary = summarizeBuiltInProxyRuntime(runtime)
  const routeKind = runtime.effectiveRoute.kind
  let newStoneRequests: BuiltInProxyStoneRequestImpact
  if (routeKind === 'external') {
    newStoneRequests = runtime.status === 'starting' ? 'transitioning' : 'external-route'
  } else if (routeKind === 'blocked') {
    newStoneRequests = 'blocked'
  } else if (summary.takeoverVerified) {
    newStoneRequests = 'built-in-route'
  } else if (runtime.status === 'starting' || runtime.status === 'stopping') {
    newStoneRequests = 'transitioning'
  } else {
    newStoneRequests = 'unconfirmed'
  }
  return {
    newStoneRequests,
    allNewStoneRequestsAffected: routeKind !== 'external',
    externalBindings: routeKind === 'external' ? 'active' : 'preserved-paused',
    savedExternalRoute: 'preserved',
    accessMode: runtime.settings.accessMode,
    accessStatus: runtime.accessState.status,
  }
}

/** Build a renderer-safe chain from the effective route, hiding unverified local endpoints. */
export function summarizeBuiltInProxyRouteChain(
  runtime: BuiltInProxyRuntimeState,
): BuiltInProxyRouteChainSummary {
  const route = runtime.effectiveRoute
  if (route.kind === 'external') {
    return {
      kind: 'external',
      generation: route.generation,
      verified: true,
      steps: [{ kind: 'stone' }, { kind: 'external', ...(route.externalMode ? { mode: route.externalMode } : {}) }],
    }
  }
  if (route.kind === 'blocked') {
    return {
      kind: 'blocked',
      generation: route.generation,
      verified: true,
      steps: [{ kind: 'stone' }, { kind: 'blocked' }],
    }
  }
  const summary = summarizeBuiltInProxyRuntime(runtime)
  if (!summary.effectiveBuiltInRouteActive || summary.effectiveMixedPort === undefined) {
    return {
      kind: 'unconfirmed',
      generation: route.generation,
      verified: false,
      steps: [{ kind: 'stone' }, { kind: 'transition', lifecycle: runtime.status }],
    }
  }
  const selection = resolveWorkspaceSelection(runtime)
  const effectiveEndpoint = `http://127.0.0.1:${summary.effectiveMixedPort}`
  const accessStep: BuiltInProxyRouteChainStep = route.kind === 'built-in-tun'
    ? { kind: 'tun', mixedEndpoint: effectiveEndpoint, mixedPort: summary.effectiveMixedPort }
    : { kind: 'mixed', endpoint: effectiveEndpoint, port: summary.effectiveMixedPort }
  const steps: BuiltInProxyRouteChainStep[] = [
    { kind: 'stone' },
    accessStep,
  ]
  // Settings are persisted before a replacement generation is committed. Do
  // not label the retained route with candidate policy values while a switch,
  // restore, or failed mutation is in progress.
  if (runtime.status === 'ready') {
    const policySource = resolvePolicySource(runtime, selection.profile)
    steps.push({ kind: 'policy', mode: runtime.settings.ruleMode, source: policySource })
    if (runtime.settings.ruleMode === 'direct') steps.push({ kind: 'direct' })
  }
  if ((runtime.status !== 'ready' || runtime.settings.ruleMode !== 'direct') && selection.profile && summary.effectiveNodeId && summary.effectiveNodeName) {
    steps.push({
      kind: 'node',
      role: 'selected-proxy-outbound',
      profileId: selection.profile.id,
      nodeId: summary.effectiveNodeId,
      name: summary.effectiveNodeName,
    })
  }
  return { kind: 'built-in', generation: route.generation, verified: true, steps }
}

function workspacePreferences(activeTab: BuiltInProxyWorkspaceTab): BuiltInProxyWorkspacePreferences {
  return { version: BUILT_IN_PROXY_WORKSPACE_PREFERENCES_VERSION, activeTab }
}

function isWorkspaceTab(value: string): value is BuiltInProxyWorkspaceTab {
  return (BUILT_IN_PROXY_WORKSPACE_TABS as readonly string[]).includes(value)
}

function verifiedMixedPort(runtime: BuiltInProxyRuntimeState, generationConsistent: boolean): number | undefined {
  const expectedKind: EffectiveOutboundRoute['kind'] = runtime.settings.accessMode === 'tun'
    ? 'built-in-tun'
    : 'built-in-mixed'
  const routePort = validPort(runtime.effectiveRoute.mixedPort) ? runtime.effectiveRoute.mixedPort : undefined
  const endpointPort = loopbackEndpointPort(runtime.accessState.endpoint)
  return runtime.status === 'ready'
    && generationConsistent
    && runtime.effectiveRoute.kind === expectedKind
    && runtime.accessState.status === 'ready'
    && runtime.accessState.mode === runtime.settings.accessMode
    && routePort !== undefined
    && endpointPort === routePort
    ? routePort
    : undefined
}

function resolveWorkspacePhase(
  runtime: BuiltInProxyRuntimeState,
  takeoverVerified: boolean,
  needsProfile: boolean,
): BuiltInProxyWorkspacePhase {
  if (runtime.effectiveRoute.kind === 'blocked') return 'blocked'
  if (runtime.status === 'starting') return 'starting'
  if (runtime.status === 'stopping') return 'restoring'
  if (runtime.status === 'ready') return takeoverVerified ? 'ready' : 'inconsistent'
  if (runtime.status === 'error') return 'failed'
  if (runtime.effectiveRoute.kind !== 'external') return 'inconsistent'
  if (needsProfile) return 'needs-profile'
  return 'inactive'
}

function toneForPhase(phase: BuiltInProxyWorkspacePhase): BuiltInProxyWorkspaceTone {
  if (phase === 'ready') return 'success'
  if (phase === 'blocked' || phase === 'failed' || phase === 'inconsistent') return 'danger'
  if (phase === 'starting' || phase === 'needs-profile') return 'info'
  if (phase === 'restoring') return 'warning'
  return 'neutral'
}

function resolveWorkspaceSelection(runtime: BuiltInProxyRuntimeState): {
  profile?: BuiltInProxyProfileSummary
  selectedNode?: BuiltInProxyProfileSummary['nodes'][number]
} {
  const routeCarriesPublishedIdentity = runtime.effectiveRoute.kind !== 'external'
  const routeProfile = runtime.effectiveRoute.profileId
    ? runtime.profiles.find((profile) => profile.id === runtime.effectiveRoute.profileId)
    : undefined
  const configuredProfile = runtime.settings.activeProfileId
    ? runtime.profiles.find((profile) => profile.id === runtime.settings.activeProfileId)
    : undefined
  // A built-in/blocked generation owns its profile and node identity. Falling
  // back to the newly persisted candidate selection would relabel the old
  // published generation while its replacement is still being prepared.
  const profile = routeCarriesPublishedIdentity
    ? routeProfile
    : configuredProfile ?? runtime.profiles[0]
  if (!profile) return {}
  const nodeId = routeCarriesPublishedIdentity
    ? runtime.effectiveRoute.nodeId
    : profile.activeNodeId
  const selectedNode = nodeId ? profile.nodes.find((node) => node.id === nodeId) : undefined
  return { profile, ...(selectedNode ? { selectedNode } : {}) }
}

function resolvePolicySource(
  runtime: BuiltInProxyRuntimeState,
  profile: BuiltInProxyProfileSummary | undefined,
): Extract<BuiltInProxyRouteChainStep, { kind: 'policy' }>['source'] {
  if (runtime.settings.ruleMode !== 'rule') return 'not-applicable'
  if (runtime.settings.customRules !== undefined) return 'custom'
  if (!profile) return 'unconfirmed'
  return profile.ruleStatus === 'preserved' ? 'profile' : 'built-in-fallback'
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
}

function loopbackEndpointPort(value: string | undefined): number | undefined {
  if (!value) return undefined
  try {
    const endpoint = new URL(value)
    if (
      endpoint.protocol !== 'http:'
      || endpoint.hostname !== '127.0.0.1'
      || endpoint.username
      || endpoint.password
      || endpoint.pathname !== '/'
      || endpoint.search
      || endpoint.hash
    ) return undefined
    const port = Number(endpoint.port)
    return validPort(port) ? port : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
