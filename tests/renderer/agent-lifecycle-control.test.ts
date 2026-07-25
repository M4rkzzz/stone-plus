import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  agentActionBlockReasonFor,
  agentActionDescription,
  agentRowActionsFor,
  agentOutcomeLabel,
  agentActionBlockReason,
  localizedLifecycleError,
  managedAgentInstanceCount,
  primaryAgentActionFor,
  summarizeAgentLifecycle,
} from '../../src/renderer/src/agent-lifecycle-control'
import type {
  AgentCapabilities,
  AgentLifecycleOperationResult,
  AgentLifecycleState,
} from '../../src/shared/agent-lifecycle'

const capabilities: AgentCapabilities = {
  canInstall: true,
  canDetectInstallation: true,
  canDetectRunning: true,
  canCloseKnownProcess: true,
  canRestoreConnection: true,
  canRepairSessions: false,
  canRepairWorkspaceIndex: false,
  canRestart: true,
}

const zh = <T>(chinese: T, _english: T): T => chinese

function agent(overrides: Partial<AgentLifecycleState> = {}): AgentLifecycleState {
  return {
    target: 'claude-code',
    capabilities,
    installed: true,
    enabled: true,
    configured: true,
    compatibility: 'native',
    running: false,
    managedInstanceCount: 0,
    processControl: 'managed-only',
    attention: 'normal',
    pendingNewSession: false,
    needsRestart: false,
    ...overrides,
  }
}

describe('agent lifecycle control summary', () => {
  it('does not render a running-instance count badge in the header trigger', () => {
    const source = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.css', import.meta.url), 'utf8')
    expect(source).not.toContain('agent-lifecycle__count')
    expect(styles).not.toContain('agent-lifecycle__count')
    expect(source).toContain('disabled={busy || runningCount === 0}')
  })

  it('explicitly starts a stopped client after the user chooses repair and start', () => {
    const appSource = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(appSource).toContain('api.restoreAgent(target, { ensureRunning: true })')
    expect(appSource).not.toContain('api.restoreAgent(target, { preserveRunningState: false })')
  })

  it('keeps late lifecycle refreshes from overwriting newer process state and closes the click-to-IPC race', () => {
    const appSource = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    const clientsSource = readFileSync(new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url), 'utf8')
    expect(appSource).toContain('shouldAcceptSnapshotRevision(agentLifecycleRevision.current, next.revision)')
    expect(appSource).toContain('if (agentOperationInFlight.current) return')
    expect(appSource).toContain('operationPending={agentOperationPending}')
    expect(appSource).toContain('if (agentLifecycleRefreshInFlight.current) return agentLifecycleRefreshInFlight.current')
    expect(appSource).toContain('onRequestRefresh={refreshAgentLifecycle}')
    expect(clientsSource).toContain('shouldAcceptSnapshotRevision(agentLifecycleRevision.current, next.revision)')
    expect(clientsSource).toContain('operationGate.current.run')
  })

  it('surfaces the most actionable state across agents', () => {
    expect(summarizeAgentLifecycle([
      agent(),
      agent({ target: 'gemini-cli', attention: 'restart', needsRestart: true }),
      agent({ target: 'codex-cli', attention: 'new-session', pendingNewSession: true }),
    ])).toBe('restart-required')
  })

  it('reports a mixed operation as partially completed', () => {
    expect(summarizeAgentLifecycle([agent()], operation('partial'))).toBe('partial')
  })

  it('does not disguise a sole failure as partial success', () => {
    expect(summarizeAgentLifecycle([agent()], operation('failed'))).toBe('failed')
  })

  it('keeps an active repair visible until it completes', () => {
    expect(summarizeAgentLifecycle([
      agent({ target: 'codex-desktop', attention: 'repair', busyAction: 'restore' }),
    ])).toBe('repairing')
  })

  it('uses one contextual operation for each agent row', () => {
    expect(primaryAgentActionFor(agent({ running: true, managedInstanceCount: 1 }))).toBe('close')
    expect(primaryAgentActionFor(agent({ running: true, managedInstanceCount: 1, attention: 'restart', needsRestart: true }))).toBe('restart')
    expect(primaryAgentActionFor(agent({ running: true, managedInstanceCount: 1, attention: 'repair' }))).toBe('restore')
    expect(primaryAgentActionFor(agent({ running: false }))).toBe('start')
    expect(primaryAgentActionFor(agent({ installed: false, configured: false }))).toBeUndefined()
  })

  it('shows close and restart for a running client, or only start for a stopped client', () => {
    expect(agentRowActionsFor(agent({ running: true, managedInstanceCount: 1 }))).toEqual(['close', 'restart'])
    expect(agentRowActionsFor(agent({
      running: true,
      managedInstanceCount: 1,
      attention: 'repair',
    }))).toEqual(['close', 'restart'])
    expect(agentRowActionsFor(agent({ running: false }))).toEqual(['start'])
    expect(agentRowActionsFor(agent({ running: false, attention: 'repair' }))).toEqual(['start'])
  })

  it('describes the repair depth represented by the single restart button', () => {
    expect(agentActionDescription(agent({
      running: true,
      managedInstanceCount: 1,
      capabilities: { ...capabilities, canRepairSessions: true },
    }), 'restart', zh)).toContain('修复会话和配置文件')
    expect(agentActionDescription(agent({
      running: true,
      managedInstanceCount: 1,
      capabilities: { ...capabilities, canRepairSessions: false },
    }), 'restart', zh)).toContain('修复配置文件')
  })

  it('keeps visible process actions inert when Stone+ does not control the process', () => {
    const external = agent({
      running: true,
      managedInstanceCount: 0,
      processControl: 'managed-only',
    })
    expect(agentActionBlockReasonFor(external, [external], 'close', zh)).toContain('不是由 Stone+ 启动')
    expect(agentActionBlockReasonFor(external, [external], 'restart', zh)).toContain('不是由 Stone+ 启动')
    expect(managedAgentInstanceCount(external)).toBe(0)
    expect(managedAgentInstanceCount(agent({
      running: true,
      managedInstanceCount: 2,
      processControl: 'managed-only',
    }))).toBe(2)
    expect(managedAgentInstanceCount(agent({
      running: true,
      managedInstanceCount: 0,
      processControl: 'full',
    }))).toBe(1)
  })

  it('keeps unavailable rows explainable instead of silently disabling them', () => {
    expect(agentActionBlockReason(
      agent({ installed: false, configured: false }),
      [],
      zh,
    )).toContain('官方安装指引')
  })

  it('explains the Codex Desktop and CLI mutual exclusion before starting', () => {
    const cli = agent({ target: 'codex-cli' })
    const desktop = agent({ target: 'codex-desktop', running: true, managedInstanceCount: 1 })

    expect(agentActionBlockReason(cli, [desktop, cli], zh)).toBe(
      'Codex Desktop 正在运行，不能同时启动 Codex CLI。请先关闭 Codex Desktop。',
    )
    expect(agentActionBlockReason(
      agent({ target: 'codex-cli', running: true, managedInstanceCount: 1 }),
      [desktop, cli],
      zh,
    )).toBeUndefined()
    expect(agentActionBlockReasonFor(
      agent({ target: 'codex-cli', running: true, managedInstanceCount: 1 }),
      [desktop, cli],
      'restart',
      zh,
    )).toContain('Codex Desktop 正在运行')
    expect(agentActionBlockReasonFor(
      agent({ target: 'codex-cli', running: true, managedInstanceCount: 1 }),
      [desktop, cli],
      'close',
      zh,
    )).toBeUndefined()
  })

  it('reports whether repair and restart actually left the process running', () => {
    const repaired = {
      target: 'claude-code', status: 'succeeded', phases: ['inspect', 'close', 'restore-connection', 'validate', 'start'],
      wasRunning: true, runningAfter: true, changed: true, pendingNewSession: false,
    } as const
    expect(agentOutcomeLabel(repaired, 'restore', zh)).toBe('修复完成并已重新启动')
    expect(agentOutcomeLabel({ ...repaired, runningAfter: false }, 'restore', zh)).toBe('修复完成，但客户端未能重新启动')
    expect(agentOutcomeLabel({ ...repaired, wasRunning: false, runningAfter: false }, 'restore', zh)).toBe('修复完成；客户端保持停止')
    expect(agentOutcomeLabel({ ...repaired, wasRunning: false, runningAfter: true }, 'restore', zh)).toBe('修复完成并已启动')
    expect(agentOutcomeLabel({ ...repaired, wasRunning: false, runningAfter: false }, 'install', zh)).toBe('已打开官方安装指引')
  })

  it('turns backend failure codes into localized actionable reasons', () => {
    expect(localizedLifecycleError({
      code: 'process-start-failed',
      message: 'fail',
      retryable: true,
      phase: 'start',
    }, zh)).toBe('客户端启动失败。请确认已正确安装，或尝试手动启动。')

    expect(localizedLifecycleError({
      code: 'process-close-failed',
      message: 'process remained alive',
      retryable: true,
      phase: 'close',
    }, zh)).toBe('关闭客户端失败。请手动关闭后重试。')
  })
})

function operation(status: AgentLifecycleOperationResult['status']): AgentLifecycleOperationResult {
  return {
    operationId: 'operation-1',
    action: 'restore',
    status,
    startedAt: 1,
    completedAt: 2,
    results: [],
    snapshot: {
      revision: 1,
      capturedAt: 2,
      busy: false,
      agents: {
        'codex-desktop': agent({ target: 'codex-desktop' }),
        'codex-cli': agent({ target: 'codex-cli' }),
        'claude-code': agent({ target: 'claude-code' }),
        'gemini-cli': agent({ target: 'gemini-cli' }),
        'grok-build': agent({ target: 'grok-build' }),
      },
    },
  }
}
