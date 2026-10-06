import { BrowserWindow, ipcMain } from 'electron'
import {
  AGENT_TARGETS,
  AGENT_INSTALL_CHANNELS,
  type AgentInstallChannel,
  type AgentLifecycleOperationResult,
  type AgentLifecycleProgressEvent,
  type AgentLifecycleSnapshot,
  type AgentLifecycleChangedEvent,
  type AgentRestoreOptions,
  type AgentStartOptions,
  type AgentTarget,
} from '@shared/agent-lifecycle'
import type { AgentLifecycleExecutionOptions } from '../agent-lifecycle/service'
import { assertTrustedSender } from './trusted-sender'

/**
 * Structural IPC boundary for the main-process lifecycle coordinator.
 * The renderer receives shared, serializable result contracts and cannot
 * provide commands, executable paths, or download URLs.
 */
export interface AgentLifecycleIpcService {
  getSnapshot(): AgentLifecycleSnapshot | Promise<AgentLifecycleSnapshot>
  install(target: AgentTarget, channel?: AgentInstallChannel): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  close(target: AgentTarget): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  restore(target: AgentTarget, options?: AgentRestoreOptions, execution?: AgentLifecycleExecutionOptions): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  restart(target: AgentTarget, execution?: AgentLifecycleExecutionOptions): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  start(target: AgentTarget, options?: AgentStartOptions): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  smartRepair(target?: AgentTarget, execution?: AgentLifecycleExecutionOptions): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  repairAllAffected(execution?: AgentLifecycleExecutionOptions): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  closeAllManaged(): AgentLifecycleOperationResult | Promise<AgentLifecycleOperationResult>
  onChange?(listener: (event: AgentLifecycleChangedEvent) => void): () => void
}

const agentLifecycleChannels = [
  'stone:get-agent-lifecycle-snapshot',
  'stone:install-agent',
  'stone:close-agent',
  'stone:restore-agent',
  'stone:restart-agent',
  'stone:start-agent',
  'stone:smart-repair-agent',
  'stone:repair-all-affected-agents',
  'stone:cancel-agent-lifecycle-operation',
  'stone:close-all-managed-agents',
] as const

export function registerAgentLifecycleApi(service: AgentLifecycleIpcService): () => Promise<void> {
  let disposed = false
  let disposeFlight: Promise<void> | undefined
  const acceptedOperations = new Set<Promise<unknown>>()
  const cancellableOperations = new Map<string, AbortController>()
  const unsubscribe = service.onChange?.((update) => {
    if (disposed) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:agent-lifecycle-changed', update)
    }
  })
  ipcMain.handle('stone:get-agent-lifecycle-snapshot', (event) => {
    assertTrustedSender(event)
    return service.getSnapshot()
  })
  ipcMain.handle('stone:install-agent', (event, target: unknown, channel?: unknown) => {
    assertTrustedSender(event)
    return trackOperation(() => service.install(parseTarget(target), parseInstallChannel(channel)))
  })
  ipcMain.handle('stone:close-agent', (event, target: unknown) => {
    assertTrustedSender(event)
    return trackOperation(() => service.close(parseTarget(target)))
  })
  ipcMain.handle('stone:restore-agent', (event, target: unknown, options?: unknown, operationId?: unknown) => {
    assertTrustedSender(event)
    const parsedTarget = parseTarget(target)
    const parsedOptions = parseRestoreOptions(options)
    return runCancellableOperation(operationId, (execution) => execution
      ? service.restore(parsedTarget, parsedOptions, execution)
      : service.restore(parsedTarget, parsedOptions))
  })
  ipcMain.handle('stone:restart-agent', (event, target: unknown, operationId?: unknown) => {
    assertTrustedSender(event)
    const parsedTarget = parseTarget(target)
    return runCancellableOperation(operationId, (execution) => execution
      ? service.restart(parsedTarget, execution)
      : service.restart(parsedTarget))
  })
  ipcMain.handle('stone:start-agent', (event, target: unknown, options?: unknown) => {
    assertTrustedSender(event)
    return trackOperation(() => service.start(parseTarget(target), parseStartOptions(options)))
  })
  ipcMain.handle('stone:smart-repair-agent', (event, target?: unknown, operationId?: unknown) => {
    assertTrustedSender(event)
    const parsedTarget = target === undefined ? undefined : parseTarget(target)
    return runCancellableOperation(operationId, (execution) => execution
      ? service.smartRepair(parsedTarget, execution)
      : service.smartRepair(parsedTarget))
  })
  ipcMain.handle('stone:repair-all-affected-agents', (event, operationId?: unknown) => {
    assertTrustedSender(event)
    return runCancellableOperation(operationId, (execution) => execution
      ? service.repairAllAffected(execution)
      : service.repairAllAffected())
  })
  ipcMain.handle('stone:cancel-agent-lifecycle-operation', (event, operationId: unknown) => {
    assertTrustedSender(event)
    const controller = cancellableOperations.get(parseOperationId(operationId))
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  })
  ipcMain.handle('stone:close-all-managed-agents', (event) => {
    assertTrustedSender(event)
    return trackOperation(() => service.closeAllManaged())
  })

  return () => {
    if (disposeFlight) return disposeFlight
    disposed = true
    for (const controller of cancellableOperations.values()) controller.abort()
    unsubscribe?.()
    for (const channel of agentLifecycleChannels) ipcMain.removeHandler(channel)
    disposeFlight = Promise.allSettled([...acceptedOperations]).then(() => undefined)
    return disposeFlight
  }

  function trackOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const flight = Promise.resolve().then(operation)
    acceptedOperations.add(flight)
    void flight.then(
      () => acceptedOperations.delete(flight),
      () => acceptedOperations.delete(flight),
    )
    return flight
  }

  function runCancellableOperation<T>(
    operationId: unknown,
    operation: (execution?: AgentLifecycleExecutionOptions) => T | Promise<T>,
  ): Promise<T> {
    if (operationId === undefined) return trackOperation(() => operation())
    const id = parseOperationId(operationId)
    if (cancellableOperations.has(id)) {
      return Promise.reject(new Error('An Agent lifecycle operation with this identifier is already running.'))
    }
    const controller = new AbortController()
    cancellableOperations.set(id, controller)
    const flight = trackOperation(() => operation({
      signal: controller.signal,
      onProgress: (progress) => {
        if (!disposed) broadcastProgress({ operationId: id, ...progress })
      },
    }))
    return flight.finally(() => {
      if (cancellableOperations.get(id) === controller) cancellableOperations.delete(id)
    })
  }
}

function parseOperationId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Agent lifecycle operation identifier.')
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(id)) {
    throw new Error('Invalid Agent lifecycle operation identifier.')
  }
  return id
}

function broadcastProgress(progress: AgentLifecycleProgressEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('stone:agent-lifecycle-progress', progress)
  }
}

function parseTarget(value: unknown): AgentTarget {
  if (typeof value === 'string' && (AGENT_TARGETS as readonly string[]).includes(value)) {
    return value as AgentTarget
  }
  throw new Error('Unsupported Agent lifecycle target.')
}

function parseInstallChannel(value: unknown): AgentInstallChannel | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (AGENT_INSTALL_CHANNELS as readonly string[]).includes(value)) {
    return value as AgentInstallChannel
  }
  throw new Error('Unsupported Agent install channel.')
}

function parseStartOptions(value: unknown): AgentStartOptions | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw new Error('Invalid Agent start options.')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'workingDirectory' && key !== 'profileId')) {
    throw new Error('Invalid Agent start options.')
  }
  if (value.workingDirectory !== undefined) {
    if (typeof value.workingDirectory !== 'string' || value.workingDirectory.trim().length === 0) {
      throw new Error('Invalid Agent working directory.')
    }
  }
  if (value.profileId !== undefined && !isNonEmptyString(value.profileId)) {
    throw new Error('Invalid Agent profile identifier.')
  }
  return {
    ...(value.workingDirectory === undefined ? {} : { workingDirectory: value.workingDirectory.trim() }),
    ...(value.profileId === undefined ? {} : { profileId: value.profileId.trim() }),
  }
}

function parseRestoreOptions(value: unknown): AgentRestoreOptions | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw new Error('Invalid Agent restore options.')
  const allowed = new Set(['preserveRunningState', 'ensureRunning', 'repairSessions', 'repairWorkspaceIndex'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Invalid Agent restore options.')
  }
  const preserveRunningState = parseOptionalBoolean(value.preserveRunningState, 'Invalid Agent restore options.')
  const ensureRunning = parseOptionalBoolean(value.ensureRunning, 'Invalid Agent restore options.')
  const repairSessions = parseOptionalBoolean(value.repairSessions, 'Invalid Agent restore options.')
  const repairWorkspaceIndex = parseOptionalBoolean(value.repairWorkspaceIndex, 'Invalid Agent restore options.')
  return {
    ...(preserveRunningState === undefined ? {} : { preserveRunningState }),
    ...(ensureRunning === undefined ? {} : { ensureRunning }),
    ...(repairSessions === undefined ? {} : { repairSessions }),
    ...(repairWorkspaceIndex === undefined ? {} : { repairWorkspaceIndex }),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseOptionalBoolean(value: unknown, errorMessage: string): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value
  throw new Error(errorMessage)
}
