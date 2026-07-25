/** Agent products whose lifecycle Stone+ can coordinate. */
export const AGENT_TARGETS = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'gemini-cli',
  'grok-build',
] as const

export type AgentTarget = (typeof AGENT_TARGETS)[number]

export type AgentRouteClient = 'codex' | 'claude' | 'gemini' | 'grokbuild'
export type AgentSharedStateGroup = 'codex-home' | 'claude-home' | 'gemini-home' | 'grok-home'

export interface AgentCapabilities {
  readonly canInstall: boolean
  readonly canDetectInstallation: boolean
  readonly canDetectRunning: boolean
  readonly canCloseKnownProcess: boolean
  readonly canRestoreConnection: boolean
  readonly canRepairSessions: boolean
  readonly canRepairWorkspaceIndex: boolean
  readonly canRestart: boolean
  /** Targets in the same group must not mutate their shared state concurrently. */
  readonly sharedStateGroup?: AgentSharedStateGroup
}

/**
 * Product capability, not a claim that every process is controllable. Runtime
 * control scope is reported separately through `processControl`.
 */
export const AGENT_CAPABILITIES: Readonly<Record<AgentTarget, AgentCapabilities>> = Object.freeze({
  'codex-desktop': Object.freeze({
    canInstall: true,
    canDetectInstallation: true,
    canDetectRunning: true,
    canCloseKnownProcess: true,
    canRestoreConnection: true,
    canRepairSessions: true,
    canRepairWorkspaceIndex: true,
    canRestart: true,
    sharedStateGroup: 'codex-home',
  }),
  'codex-cli': Object.freeze({
    canInstall: true,
    canDetectInstallation: true,
    canDetectRunning: true,
    canCloseKnownProcess: true,
    canRestoreConnection: true,
    // The CLI participates only when it shares the repaired CODEX_HOME.
    canRepairSessions: true,
    canRepairWorkspaceIndex: true,
    canRestart: true,
    sharedStateGroup: 'codex-home',
  }),
  'claude-code': Object.freeze({
    canInstall: true,
    canDetectInstallation: true,
    canDetectRunning: true,
    canCloseKnownProcess: true,
    canRestoreConnection: true,
    canRepairSessions: false,
    canRepairWorkspaceIndex: false,
    canRestart: true,
    sharedStateGroup: 'claude-home',
  }),
  'gemini-cli': Object.freeze({
    canInstall: true,
    canDetectInstallation: true,
    canDetectRunning: true,
    canCloseKnownProcess: true,
    canRestoreConnection: true,
    canRepairSessions: false,
    canRepairWorkspaceIndex: false,
    canRestart: true,
    sharedStateGroup: 'gemini-home',
  }),
  'grok-build': Object.freeze({
    canInstall: true,
    canDetectInstallation: true,
    canDetectRunning: true,
    canCloseKnownProcess: true,
    canRestoreConnection: true,
    canRepairSessions: false,
    canRepairWorkspaceIndex: false,
    canRestart: true,
    sharedStateGroup: 'grok-home',
  }),
})

export const AGENT_ROUTE_CLIENT: Readonly<Record<AgentTarget, AgentRouteClient>> = Object.freeze({
  'codex-desktop': 'codex',
  'codex-cli': 'codex',
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'grok-build': 'grokbuild',
})

export type AgentCompatibility = 'native' | 'compatible' | 'needs-check' | 'unsupported'
export type AgentProcessControl = 'full' | 'managed-only' | 'unavailable'
export type AgentLifecycleAttention = 'normal' | 'new-session' | 'restart' | 'repair' | 'failed'
export type AgentLifecycleBusyAction = 'install' | 'close' | 'restore' | 'restart' | 'start' | 'smart-repair'

/** Fixed, backend-owned release channels. Renderers cannot supply package names, commands, or URLs. */
export const AGENT_INSTALL_CHANNELS = ['recommended', 'preview'] as const
export type AgentInstallChannel = (typeof AGENT_INSTALL_CHANNELS)[number]

/** Renderer-safe state; it never exposes commands, credentials, or raw configuration. */
export interface AgentLifecycleState {
  readonly target: AgentTarget
  readonly capabilities: AgentCapabilities
  readonly installed: boolean
  readonly version?: string
  readonly enabled: boolean
  readonly configured: boolean
  readonly sourceId?: string
  readonly sourceName?: string
  readonly compatibility: AgentCompatibility
  /** True only for a process Stone+ can positively identify. */
  readonly running: boolean
  readonly managedInstanceCount: number
  readonly processControl: AgentProcessControl
  readonly attention: AgentLifecycleAttention
  readonly pendingNewSession: boolean
  readonly needsRestart: boolean
  readonly busyAction?: AgentLifecycleBusyAction
  readonly error?: AgentLifecycleError
}

export interface AgentLifecycleSnapshot {
  readonly revision: number
  readonly capturedAt: number
  readonly agents: Readonly<Record<AgentTarget, AgentLifecycleState>>
  readonly busy: boolean
  readonly activeOperationId?: string
}

export type AgentLifecycleAction =
  | 'install'
  | 'close'
  | 'restore'
  | 'restart'
  | 'start'
  | 'smart-repair'
  | 'repair-all-affected'
  | 'close-all-managed'

export type AgentLifecyclePhase =
  | 'inspect'
  | 'install'
  | 'close'
  | 'backup'
  | 'restore-connection'
  | 'repair-sessions'
  | 'repair-workspace-index'
  | 'validate'
  | 'start'
  | 'rollback'

export type AgentLifecycleErrorCode =
  | 'not-installed'
  | 'not-enabled'
  | 'unsupported-platform'
  | 'unsupported-source'
  | 'unsupported-channel'
  | 'installation-prerequisite-missing'
  | 'installation-failed'
  | 'installation-timeout'
  | 'download-page-failed'
  | 'external-process-unmanaged'
  | 'process-close-failed'
  | 'backup-failed'
  | 'configuration-failed'
  | 'session-repair-failed'
  | 'workspace-index-repair-failed'
  | 'validation-failed'
  | 'process-start-failed'
  | 'operation-conflict'
  | 'rollback-failed'
  | 'cancelled'
  | 'unknown'

export interface AgentLifecycleError {
  readonly code: AgentLifecycleErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly phase?: AgentLifecyclePhase
}

export interface AgentStartOptions {
  readonly workingDirectory?: string
  readonly profileId?: string
}

export interface AgentRestoreOptions {
  /** Defaults to true for a running, controllable target. */
  readonly preserveRunningState?: boolean
  /** Start the target after a successful repair even when it was initially stopped. */
  readonly ensureRunning?: boolean
  /** Deep repair is ignored when the target does not declare the capability. */
  readonly repairSessions?: boolean
  readonly repairWorkspaceIndex?: boolean
}

export type AgentTargetResultStatus = 'succeeded' | 'skipped' | 'failed' | 'rolled-back'

export interface AgentTargetLifecycleResult {
  readonly target: AgentTarget
  readonly status: AgentTargetResultStatus
  readonly phases: readonly AgentLifecyclePhase[]
  readonly wasRunning: boolean
  readonly runningAfter: boolean
  readonly changed: boolean
  readonly pendingNewSession: boolean
  readonly error?: AgentLifecycleError
}

export type AgentLifecycleOperationStatus = 'succeeded' | 'partial' | 'failed' | 'no-op'

/** Result envelope used by both single-target and aggregate operations. */
export interface AgentLifecycleOperationResult {
  readonly operationId: string
  readonly action: AgentLifecycleAction
  readonly status: AgentLifecycleOperationStatus
  readonly startedAt: number
  readonly completedAt: number
  readonly results: readonly AgentTargetLifecycleResult[]
  readonly snapshot: AgentLifecycleSnapshot
}

export interface AgentLifecycleChangedEvent {
  readonly snapshot: AgentLifecycleSnapshot
  readonly operation?: AgentLifecycleOperationResult
}

export function agentCapabilities(target: AgentTarget): AgentCapabilities {
  return AGENT_CAPABILITIES[target]
}

export function agentRouteClient(target: AgentTarget): AgentRouteClient {
  return AGENT_ROUTE_CLIENT[target]
}
