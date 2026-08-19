import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  agentActionBlockReasonFor,
  agentActionDescription,
  agentActionLabel,
  agentRowActionsFor,
  agentOutcomeLabel,
  agentActionBlockReason,
  localizedLifecycleError,
  managedAgentInstanceCount,
  primaryAgentActionFor,
  summarizeAgentLifecycle,
} from '../../src/renderer/src/agent-lifecycle-control'
import {
  AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentLifecycleOperationResult,
  type AgentLifecycleState,
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
  it('shows a Web WM-specific Codex Desktop update action without an old-client compatibility path', () => {
    const source = readFileSync(
      new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url),
      'utf8',
    )

    expect(source).toContain('codexDesktopWebWmUpdateRequired(item?.version)')
    expect(source).toContain("t('需要更新', 'Update required')")
    expect(source).toContain("t('更新 Codex', 'Update Codex')")
    expect(source).toContain('不支持 Web WM')
  })

  it('keeps the dark-mode OpenAI filter off the icon background surface', () => {
    const source = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.css', import.meta.url), 'utf8')

    expect(source).toContain('<span className="agent-lifecycle__agent-icon"')
    expect(source).toContain('<img className={meta.iconClassName}')
    expect(source).toContain('<span><img className={clientBrandMeta.codex.iconClassName}')
    expect(styles).toContain('.agent-lifecycle__brands > span')
    expect(styles).toContain('.agent-lifecycle__agent-icon img')
  })

  it('does not render a running-instance count badge in the header trigger', () => {
    const source = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.css', import.meta.url), 'utf8')
    expect(source).not.toContain('agent-lifecycle__count')
    expect(styles).not.toContain('agent-lifecycle__count')
    expect(source).toContain('disabled={busy || runningCount === 0}')
  })

  it('labels the legacy Claude target as CLI and exposes Desktop and VSC as separate rows', () => {
    const source = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    expect(source).toContain("'claude-code': { name: 'Claude Code CLI'")
    expect(source).toContain("'claude-code-desktop': { name: 'Claude Code Desktop'")
    expect(source).toContain("'claude-code-vsc': { name: 'Claude Code VSC'")
    expect(source.indexOf("'claude-code'", source.indexOf('const targetOrder')))
      .toBeLessThan(source.indexOf("'claude-code-desktop'", source.indexOf('const targetOrder')))
    expect(source.indexOf("'claude-code-desktop'", source.indexOf('const targetOrder')))
      .toBeLessThan(source.indexOf("'claude-code-vsc'", source.indexOf('const targetOrder')))
  })

  it('presents Claude Desktop as automatic whole-app configuration without manual token instructions', () => {
    const controlSource = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    const clientsSource = readFileSync(new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url), 'utf8')

    expect(controlSource).not.toContain('需手动配置')
    expect(controlSource).not.toContain('Configure Third-Party Inference')
    expect(clientsSource).not.toContain('Desktop 手动网关参数')
    expect(clientsSource).not.toContain('inferenceGatewayApiKey')
    expect(clientsSource).toContain('接管时自动允许 Cowork 访问任意网络主机并隐藏官方模式选择器')
    expect(clientsSource).toContain('同时允许 Cowork 访问任意网络主机并隐藏官方模式选择器')
    expect(clientsSource).toContain('完整退出并重开 Claude Desktop 后生效')
    expect(clientsSource).toContain('Stone+ 不会结束宿主进程')
    expect(clientsSource).not.toContain('claudeDesktopCapabilities:')
    expect(clientsSource).not.toContain('Cowork 全域网络放行')
    expect(clientsSource).toContain("installAction: ['打开官方下载页', 'Open official download page']")
  })

  it('keeps Claude Desktop official-mode recovery reachable and blocks lifecycle races', () => {
    const clientsSource = readFileSync(new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url), 'utf8')
    const restoreButtonStart = clientsSource.indexOf('{isClaudeDesktop && (')
    const restoreButtonEnd = clientsSource.indexOf(
      '{!item?.installed || desktopUpdateRequired ? (',
      restoreButtonStart,
    )
    const restoreButtonSource = clientsSource.slice(restoreButtonStart, restoreButtonEnd)

    expect(clientsSource).toContain('restoreClaudeDesktopOfficialMode()')
    expect(clientsSource).toContain('if (claudeDesktopOfficialRestoreInFlight.current || agentLifecycle?.busy) return')
    expect(clientsSource).toContain('const claudeDesktopOfficialRestoreDisabled = claudeDesktopOfficialRestoreBusy')
    expect(clientsSource).toContain('|| claudeDesktopOfficialRestoreBlockedByLifecycle')
    expect(clientsSource).toContain('disabled={claudeDesktopOfficialRestoreDisabled}')
    expect(clientsSource).toContain('aria-label={claudeDesktopOfficialRestoreLabel}')
    expect(clientsSource).toContain('title={claudeDesktopOfficialRestoreTitle}')
    expect(clientsSource).toContain('客户端操作进行中，完成后可恢复 Claude Desktop 官方模式')
    expect(clientsSource).toContain('另一项客户端接管、修复或启动操作正在进行；完成后可恢复官方模式')
    expect(clientsSource).toContain('此操作只会移除 Stone+ 写入的 Claude Desktop 第三方推理配置')
    expect(clientsSource).toContain('官方模式选择器才会恢复并生效')
    expect(clientsSource).toContain('请完整退出并重开 Claude Desktop 后使用官方模式')
    expect(restoreButtonStart).toBeGreaterThanOrEqual(0)
    expect(restoreButtonEnd).toBeGreaterThan(restoreButtonStart)
    expect(restoreButtonSource).not.toContain('item?.installed')
    expect(restoreButtonSource).not.toContain('itemError')
    expect(restoreButtonSource).not.toContain('routeSelection')
    expect(restoreButtonSource).not.toContain('Boolean(busy)')
  })

  it('explicitly starts a stopped client after the user chooses repair and start', () => {
    const appSource = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(appSource).toContain('api.restoreAgent(target, { ensureRunning: true }, operationId)')
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

  it('keeps the running DeepSeek Harness card actionable as Open', () => {
    const clientsSource = readFileSync(new URL('../../src/renderer/src/views/ClientsView.tsx', import.meta.url), 'utf8')
    expect(clientsSource).toContain('const opensRunningInstance = Boolean(item?.running && item.capabilities.canOpenWhenRunning)')
    expect(clientsSource).toContain('item.running && !opensRunningInstance')
    expect(clientsSource).toContain('launchOnly || opensRunningInstance')
  })

  it('shows real repair progress and exposes safe cancellation', () => {
    const appSource = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    const controlSource = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../src/renderer/src/agent-lifecycle-control.css', import.meta.url), 'utf8')

    expect(appSource).toContain('api.onAgentLifecycleProgress')
    expect(appSource).toContain('api.cancelAgentLifecycleOperation(operationId)')
    expect(controlSource).toContain('<AgentRepairProgress')
    expect(controlSource).toContain("t('安全取消', 'Cancel safely')")
    expect(styles).toContain('.agent-lifecycle__progress-track')
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

  it('does not leave the control in an error state after a safely cancelled repair', () => {
    const cancelled = operation('failed')
    const result = {
      target: 'codex-desktop',
      status: 'failed',
      phases: ['repair-sessions'],
      wasRunning: true,
      runningAfter: true,
      changed: false,
      pendingNewSession: false,
      error: { code: 'cancelled', message: 'cancelled', retryable: true, phase: 'repair-sessions' },
    } as const
    expect(summarizeAgentLifecycle([agent()], { ...cancelled, results: [result] })).toBe('ready')
    expect(agentOutcomeLabel(result, 'restore', zh)).toBe('已安全取消并回滚')
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

  it('lets start repair a stale connection instead of blocking before main-process validation', () => {
    const stale = agent({ configured: false })

    expect(primaryAgentActionFor(stale)).toBe('start')
    expect(agentActionBlockReasonFor(stale, [stale], 'start', zh)).toBeUndefined()
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

  it.each(['claude-code-desktop', 'claude-code-vsc'] as const)(
    'offers only one launch action for launch-only %s and never close or restart',
    (target) => {
      const launchOnly = agent({
        target,
        capabilities: AGENT_CAPABILITIES[target],
        configured: false,
        running: false,
        managedInstanceCount: 0,
        processControl: 'unavailable',
      })

      expect(primaryAgentActionFor(launchOnly)).toBe('start')
      expect(agentRowActionsFor(launchOnly)).toEqual(['start'])
      expect(agentActionBlockReasonFor(launchOnly, [launchOnly], 'start', zh)).toBeUndefined()
    },
  )

  it('uses configured state to label the Claude Desktop launch action', () => {
    const unconfigured = agent({
      target: 'claude-code-desktop',
      capabilities: AGENT_CAPABILITIES['claude-code-desktop'],
      configured: false,
      processControl: 'unavailable',
    })
    const configured = agent({ ...unconfigured, configured: true })

    expect(agentActionLabel(unconfigured, 'start', zh)).toBe('配置并打开 Code')
    expect(agentActionLabel(configured, 'start', zh)).toBe('打开 Code')
    expect(agentActionDescription(unconfigured, 'start', zh)).toContain('整个 Claude Desktop')
    expect(agentActionDescription(unconfigured, 'start', zh)).toContain('不会结束宿主进程')
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
    expect(agentOutcomeLabel({
      ...repaired,
      target: 'deepseek-harness',
      wasRunning: false,
      runningAfter: true,
    }, 'install', zh)).toBe('已安装、配置并启动')
  })

  it.each(['claude-code-desktop', 'claude-code-vsc'] as const)(
    'reports a successful launch-only %s handoff as opened without a running process',
    (target) => {
      expect(agentOutcomeLabel({
        target,
        status: 'succeeded',
        phases: ['inspect', 'start'],
        wasRunning: false,
        runningAfter: false,
        changed: true,
        pendingNewSession: false,
      }, 'start', zh)).toBe(target === 'claude-code-desktop'
        ? '配置已确认并已打开 Code；完整退出并重开 Claude Desktop 后生效'
        : '已打开')
    },
  )

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
        'claude-code-desktop': agent({
          target: 'claude-code-desktop',
          capabilities: AGENT_CAPABILITIES['claude-code-desktop'],
          processControl: 'unavailable',
        }),
        'claude-code-vsc': agent({
          target: 'claude-code-vsc',
          capabilities: AGENT_CAPABILITIES['claude-code-vsc'],
          processControl: 'unavailable',
        }),
        'gemini-cli': agent({ target: 'gemini-cli' }),
        'grok-build': agent({ target: 'grok-build' }),
      },
    },
  }
}
