import {
  ChevronDown,
  CircleCheck,
  Info,
  MonitorCog,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  TriangleAlert,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentLifecycleBusyAction,
  type AgentLifecycleError,
  type AgentLifecycleOperationResult,
  type AgentLifecycleState,
  type AgentTarget,
  type AgentTargetLifecycleResult,
} from '@shared/agent-lifecycle'
import { clientBrandMeta } from './brand-icons'
import { useI18n } from './i18n'
import { useVisibilityAwareInterval } from './visibility-interval'
import './agent-lifecycle-control.css'

export type AgentLifecycleControlAction = 'close' | 'restore' | 'restart' | 'start'
export type AgentLifecycleDisplayState =
  | 'ready'
  | 'new-session'
  | 'restart-required'
  | 'repair-required'
  | 'repairing'
  | 'partial'
  | 'failed'

export interface AgentLifecycleControlProps {
  agents: readonly AgentLifecycleState[]
  lastOperation?: AgentLifecycleOperationResult
  disabled?: boolean
  /** Covers renderer-to-main IPC latency before the lifecycle busy snapshot arrives. */
  operationPending?: boolean
  /** Refreshes externally launched/stopped processes while the panel is visible. */
  onRequestRefresh?: () => void | Promise<void>
  onAction: (target: AgentTarget, action: AgentLifecycleControlAction) => void | Promise<void>
  /** Preferred aggregate repair entry point. Legacy callbacks remain supported below. */
  onRepair?: () => void | Promise<void>
  onSmartRepair?: () => void | Promise<void>
  onRepairAll?: () => void | Promise<void>
  onCloseAll?: () => void | Promise<void>
  onOpenClientConfiguration?: () => void
}

interface AgentDisplayMeta {
  name: string
  icon: string
  iconClassName?: string
}

const targetMeta: Record<AgentTarget, AgentDisplayMeta> = {
  'codex-desktop': { name: 'Codex Desktop', icon: clientBrandMeta.codex.icon, iconClassName: clientBrandMeta.codex.iconClassName },
  'codex-cli': { name: 'Codex CLI', icon: clientBrandMeta.codex.icon, iconClassName: clientBrandMeta.codex.iconClassName },
  'claude-code': { name: 'Claude Code CLI', icon: clientBrandMeta.claude.icon },
  'claude-code-desktop': { name: 'Claude Code Desktop', icon: clientBrandMeta.claude.icon },
  'claude-code-vsc': { name: 'Claude Code VSC', icon: clientBrandMeta.claude.icon },
  'gemini-cli': { name: 'Gemini CLI', icon: clientBrandMeta.gemini.icon },
  'grok-build': { name: 'Grok Build', icon: clientBrandMeta.grokbuild.icon },
}

const targetOrder: readonly AgentTarget[] = [
  'codex-desktop',
  'codex-cli',
  'claude-code',
  'claude-code-desktop',
  'claude-code-vsc',
  'gemini-cli',
  'grok-build',
]

const displayPriority: Record<AgentLifecycleDisplayState, number> = {
  ready: 0,
  'new-session': 1,
  'restart-required': 2,
  'repair-required': 3,
  repairing: 4,
  partial: 5,
  failed: 6,
}

export function summarizeAgentLifecycle(
  agents: readonly AgentLifecycleState[],
  operation?: AgentLifecycleOperationResult,
): AgentLifecycleDisplayState {
  if (operation?.status === 'partial') return 'partial'
  if (operation?.status === 'failed') return 'failed'
  const states = agents.map(displayStateForAgent)
  if (states.includes('failed')) {
    const completed = operation?.results.some((outcome) => outcome.status === 'succeeded')
    return completed ? 'partial' : 'failed'
  }
  return states.reduce<AgentLifecycleDisplayState>((summary, state) => (
    displayPriority[state] > displayPriority[summary] ? state : summary
  ), 'ready')
}

export function primaryAgentActionFor(agent: AgentLifecycleState): AgentLifecycleControlAction | undefined {
  const canClose = agent.running
    && agent.capabilities.canCloseKnownProcess
    && agent.processControl !== 'unavailable'
  const canRestore = agent.installed && agent.enabled
    && (agent.capabilities.canRestoreConnection || agent.capabilities.canRepairSessions)
  const canStart = agent.installed && agent.enabled
    && (isLaunchOnly(agent) || agent.configured)
    && agent.compatibility !== 'unsupported' && canLaunchAgent(agent.capabilities)
  const needsRepair = agent.attention === 'repair' || agent.error?.phase === 'restore-connection'
    || agent.error?.phase === 'repair-sessions' || agent.error?.phase === 'repair-workspace-index'
    || agent.error?.phase === 'validate'
  if (needsRepair && canRestore) return 'restore'
  if (!agent.capabilities.canDetectRunning) return canStart ? 'start' : canRestore ? 'restore' : undefined
  if (agent.running) {
    if ((agent.needsRestart || agent.attention === 'restart') && canStart) return 'restart'
    return canClose ? 'close' : undefined
  }
  return canStart ? 'start' : canRestore ? 'restore' : undefined
}

/**
 * The compact header control deliberately exposes process state, rather than
 * repair phases, as buttons: a running client can be closed or restarted and
 * a stopped client can only be started. Restart remains a single operation;
 * the main process owns its close/repair/start phases.
 */
export function agentRowActionsFor(agent: AgentLifecycleState): readonly AgentLifecycleControlAction[] {
  if (!agent.capabilities.canDetectRunning) return ['start']
  return agent.running ? ['close', 'restart'] : ['start']
}

export function managedAgentInstanceCount(agent: AgentLifecycleState): number {
  if (!agent.running || agent.processControl === 'unavailable') return 0
  if (agent.processControl === 'managed-only') return Math.max(0, agent.managedInstanceCount)
  return Math.max(1, agent.managedInstanceCount)
}

export function AgentLifecycleControl({
  agents,
  lastOperation,
  disabled = false,
  operationPending = false,
  onRequestRefresh,
  onAction,
  onRepair,
  onSmartRepair,
  onRepairAll,
  onCloseAll,
  onOpenClientConfiguration,
}: AgentLifecycleControlProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const orderedAgents = useMemo(() => [...agents].sort(
    (left, right) => targetOrder.indexOf(left.target) - targetOrder.indexOf(right.target),
  ), [agents])
  const summary = summarizeAgentLifecycle(agents, lastOperation)
  const runningCount = agents.reduce((count, agent) => count + managedAgentInstanceCount(agent), 0)
  const busy = operationPending || agents.some((agent) => Boolean(agent.busyAction))
  const repair = onRepair ?? onRepairAll ?? onSmartRepair

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useVisibilityAwareInterval(
    () => onRequestRefresh?.(),
    2_000,
    open && Boolean(onRequestRefresh),
    true,
    undefined,
    2,
  )

  const invoke = (target: AgentTarget, action: AgentLifecycleControlAction) => {
    void onAction(target, action)
  }

  return (
    <div className="agent-lifecycle" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`agent-lifecycle__trigger agent-lifecycle__trigger--${summary}`}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('Agent 控制', 'Agent controls')}
        title={t('管理 Codex、Claude Code CLI、Desktop、VSC、Gemini CLI 和 Grok Build', 'Manage Codex, Claude Code CLI, Desktop, VSC, Gemini CLI, and Grok Build')}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="agent-lifecycle__brands" aria-hidden="true">
          <span><img className={clientBrandMeta.codex.iconClassName} src={clientBrandMeta.codex.icon} alt="" /></span>
          <span><img src={clientBrandMeta.claude.icon} alt="" /></span>
          <span><img src={clientBrandMeta.gemini.icon} alt="" /></span>
          <span><img src={clientBrandMeta.grokbuild.icon} alt="" /></span>
        </span>
        {busy ? <RefreshCw className="agent-lifecycle__busy spin" size={13} aria-hidden="true" /> : <ChevronDown className="agent-lifecycle__chevron" size={13} aria-hidden="true" />}
      </button>

      {open && (
        <section
          id={panelId}
          className="agent-lifecycle__panel"
          role="dialog"
          aria-label={t('Agent 生命周期控制', 'Agent lifecycle controls')}
        >
          <header className="agent-lifecycle__header">
            <div>
              <strong>{t('Agent 控制', 'Agent controls')}</strong>
              <span>{summaryLabel(summary, t)}</span>
            </div>
            <StatusGlyph state={summary} />
          </header>

          <div className="agent-lifecycle__list">
            {orderedAgents.map((agent) => (
              <AgentRow key={agent.target} agent={agent} agents={orderedAgents} operationBusy={busy} onAction={invoke} />
            ))}
            {orderedAgents.length === 0 && (
              <div className="agent-lifecycle__empty">
                <Info size={15} />
                <span>{t('尚未检测到可管理的 Agent。', 'No manageable agents were detected.')}</span>
              </div>
            )}
          </div>

          {lastOperation && lastOperation.results.length > 0 && (
            <div className="agent-lifecycle__outcomes" aria-label={t('最近操作结果', 'Recent operation results')}>
              {lastOperation.results.map((outcome) => (
                <div className={`agent-lifecycle__outcome agent-lifecycle__outcome--${outcome.status}`} key={`${lastOperation.operationId}-${outcome.target}`}>
                  {outcome.status === 'succeeded' ? <CircleCheck size={13} /> : outcome.status === 'failed' || outcome.status === 'rolled-back' ? <TriangleAlert size={13} /> : <Info size={13} />}
                  <span><strong>{targetMeta[outcome.target].name}</strong> · {agentOutcomeLabel(outcome, lastOperation.action, t)}</span>
                </div>
              ))}
            </div>
          )}

          {(repair || onCloseAll || onOpenClientConfiguration) && (
            <footer className="agent-lifecycle__footer">
              <div className="agent-lifecycle__bulk-actions">
                {repair && (
                  <button type="button" disabled={busy} onClick={() => void repair()}>
                    <RotateCcw size={13} />{t('修复并启动', 'Repair & start')}
                  </button>
                )}
                {onCloseAll && (
                  <button type="button" disabled={busy || runningCount === 0} onClick={() => void onCloseAll()}>
                    <Square size={12} />{t('关闭受管 Agent', 'Close managed agents')}
                  </button>
                )}
              </div>
              {onOpenClientConfiguration && (
                <button className="agent-lifecycle__config-link" type="button" onClick={() => {
                  setOpen(false)
                  onOpenClientConfiguration()
                }}>
                  <MonitorCog size={14} />{t('客户端配置', 'Client Configuration')}
                </button>
              )}
            </footer>
          )}
        </section>
      )}
    </div>
  )
}

function AgentRow({
  agent,
  agents,
  operationBusy,
  onAction,
}: {
  agent: AgentLifecycleState
  agents: readonly AgentLifecycleState[]
  operationBusy: boolean
  onAction: (target: AgentTarget, action: AgentLifecycleControlAction) => void
}) {
  const { t } = useI18n()
  const [notice, setNotice] = useState<string>()
  const meta = targetMeta[agent.target]
  const busy = Boolean(agent.busyAction)
  const actions = agentRowActionsFor(agent)
  useEffect(() => {
    setNotice(undefined)
  }, [agent.running, agent.installed, agent.enabled, agent.configured, agent.compatibility, agent.error?.code])

  const displayState = displayStateForAgent(agent)
  return (
    <article className={`agent-lifecycle__agent agent-lifecycle__agent--${displayState}`}>
      <span className="agent-lifecycle__agent-icon" aria-hidden="true">
        <img className={meta.iconClassName} src={meta.icon} alt="" />
      </span>
      <div className="agent-lifecycle__agent-copy">
        <div className="agent-lifecycle__agent-title">
          <strong>{meta.name}</strong>
          <span className={`agent-lifecycle__state agent-lifecycle__state--${displayState}`}>
            {agent.busyAction ? actionProgressLabel(agent.busyAction, t, agent) : agentStateLabel(agent, t)}
          </span>
        </div>
        <span
          className={`agent-lifecycle__agent-detail${notice ? ' agent-lifecycle__agent-detail--notice' : ''}`}
          role={notice ? 'status' : undefined}
        >
          {notice ?? defaultAgentDetail(agent, t)}
        </span>
      </div>
      <div className="agent-lifecycle__agent-actions" aria-label={t(`${meta.name} 操作`, `${meta.name} actions`)}>
        {actions.map((action) => {
          const blockedReason = agentActionBlockReasonFor(agent, agents, action, t)
          const label = agentActionLabel(agent, action, t)
          const title = blockedReason ?? agentActionDescription(agent, action, t)
          const actionBusy = busy && agent.busyAction === action
          return (
            <button
              key={action}
              type="button"
              title={title}
              aria-label={blockedReason ? `${label}：${blockedReason}` : title}
              aria-disabled={Boolean(blockedReason)}
              disabled={operationBusy}
              data-agent-action={action}
              onClick={() => {
                if (blockedReason) {
                  setNotice(blockedReason)
                  return
                }
                setNotice(undefined)
                onAction(agent.target, action)
              }}
            >
              {actionBusy
                ? <RefreshCw className="spin" size={12} />
                : agentActionIcon(action)}
              <span>{actionBusy ? actionProgressLabel(agent.busyAction!, t, agent) : label}</span>
            </button>
          )
        })}
      </div>
    </article>
  )
}

function agentActionIcon(action: AgentLifecycleControlAction) {
  if (action === 'restart' || action === 'restore') return <RotateCcw size={12} />
  if (action === 'close') return <Square size={11} />
  return <Play size={12} />
}

export function agentActionLabel(agent: AgentLifecycleState, action: AgentLifecycleControlAction, t: Translator): string {
  if (action === 'close') return t('关闭', 'Close')
  if (action === 'restart') return t('重启', 'Restart')
  if (action === 'restore') return t('修复', 'Repair')
  if (agent.target === 'claude-code-desktop') {
    return agent.configured
      ? t('打开 Code', 'Open Code')
      : t('配置并打开 Code', 'Configure and open Code')
  }
  if (isLaunchOnly(agent)) return t('打开', 'Open')
  return t('开启', 'Start')
}

export function agentActionDescription(
  agent: AgentLifecycleState,
  action: AgentLifecycleControlAction,
  t: Translator,
): string {
  if (action === 'restart') {
    return agent.capabilities.canRepairSessions
      ? t('重启：关闭客户端，修复会话和配置文件，再重新开启', 'Restart: close the client, repair sessions and configuration, then start it again')
      : t('重启：关闭客户端，修复配置文件，再重新开启', 'Restart: close the client, repair configuration, then start it again')
  }
  if (action === 'close') return t('关闭客户端', 'Close client')
  if (action === 'restore') return t('修复客户端连接', 'Repair client connection')
  if (action === 'start' && agent.target === 'claude-code-desktop') {
    return agent.configured
      ? t('打开 Code；配置影响整个 Claude Desktop，Stone+ 不会结束宿主进程', 'Open Code. The settings affect all of Claude Desktop; Stone+ does not close the host app')
      : t('写入整个 Claude Desktop 的第三方推理配置并打开 Code；Stone+ 不会结束宿主进程', 'Write the third-party inference settings for all of Claude Desktop and open Code; Stone+ does not close the host app')
  }
  if (isLaunchOnly(agent)) return t('打开客户端', 'Open client')
  return t('开启客户端', 'Start client')
}

function StatusGlyph({ state }: { state: AgentLifecycleDisplayState }) {
  if (state === 'failed' || state === 'partial') return <TriangleAlert size={16} aria-hidden="true" />
  if (state === 'repairing') return <RefreshCw size={16} className="spin" aria-hidden="true" />
  if (state === 'ready') return <CircleCheck size={16} aria-hidden="true" />
  return <Info size={16} aria-hidden="true" />
}

type Translator = <T>(chinese: T, english: T) => T

function summaryLabel(state: AgentLifecycleDisplayState, t: Translator): string {
  const labels: Record<AgentLifecycleDisplayState, readonly [string, string]> = {
    ready: ['连接正常', 'Connections ready'],
    'new-session': ['新会话生效', 'Applies to new sessions'],
    'restart-required': ['需要重启', 'Restart required'],
    'repair-required': ['需要修复', 'Repair required'],
    repairing: ['正在处理', 'Operation in progress'],
    partial: ['部分操作失败', 'Partially completed'],
    failed: ['操作失败', 'Operation failed'],
  }
  return t(...labels[state])
}

function agentStateLabel(agent: AgentLifecycleState, t: Translator): string {
  if (!agent.installed) return t('未安装', 'Not installed')
  if (agent.target === 'claude-code-desktop' && agent.enabled) {
    return agent.configured
      ? t('已写入 · 需重开', 'Written · reopen required')
      : t('打开时自动写入', 'Configures when opened')
  }
  if (agent.target === 'claude-code-vsc' && agent.enabled && !agent.configured) {
    return t('打开时配置', 'Configures when opened')
  }
  if (!agent.enabled || !agent.configured) return t('未接入', 'Not connected')
  if (isLaunchOnly(agent)) return t('可打开', 'Ready to open')
  if (agent.running) return t('运行中', 'Running')
  return summaryLabel(displayStateForAgent(agent), t)
}

function actionProgressLabel(action: AgentLifecycleBusyAction, t: Translator, agent?: AgentLifecycleState): string {
  if (action === 'close') return t('正在关闭', 'Closing')
  if (action === 'restore') return t('正在修复', 'Repairing')
  if (action === 'restart') return t('正在重启', 'Restarting')
  if (action === 'install') return t('正在打开安装指引', 'Opening installation guide')
  if (action === 'smart-repair') return t('正在智能修复', 'Smart repair in progress')
  if (agent?.target === 'claude-code-desktop') {
    return agent.configured
      ? t('正在打开 Code', 'Opening Code')
      : t('正在配置并打开 Code', 'Configuring and opening Code')
  }
  return agent && isLaunchOnly(agent) ? t('正在打开', 'Opening') : t('正在启动', 'Starting')
}

function defaultAgentDetail(agent: AgentLifecycleState, t: Translator): string {
  if (agent.error) return localizedLifecycleError(agent.error, t)
  if (!agent.installed) return t('可在客户端配置中打开官方安装指引', 'Open the official installation guide from Client Configuration')
  if (agent.target === 'claude-code-desktop') {
    if (!agent.enabled) return t('请先启用兼容的 Claude 路由', 'Enable a compatible Claude route first')
    if (!agent.configured) {
      return t('打开时自动写入全局配置；影响 Chat、Cowork 和 Code，Stone+ 不会结束宿主进程', 'Opening writes the global settings automatically. They affect Chat, Cowork, and Code; Stone+ does not close the host app')
    }
    return t('已写入；完整退出并重开 Claude Desktop 后生效。Stone+ 不会结束宿主进程', 'Written; fully quit and reopen Claude Desktop to apply. Stone+ does not close the host app')
  }
  if (agent.target === 'claude-code-vsc') {
    if (!agent.enabled) return t('请先启用兼容的 Claude 路由', 'Enable a compatible Claude route first')
    if (!agent.configured) return t('打开时自动写入 VS Code 连接配置', 'Stone+ writes the VS Code connection settings when opened')
    return t('Stone+ 只打开 Claude Code 扩展，不接管或关闭 VS Code', 'Stone+ opens the Claude Code extension without controlling or closing VS Code')
  }
  if (!agent.enabled || !agent.configured) return t('尚未连接 Stone+', 'Not connected to Stone+')
  if (agent.processControl === 'managed-only') {
    return agent.managedInstanceCount > 0
      ? t(`Stone+ 启动了 ${agent.managedInstanceCount} 个实例`, `${agent.managedInstanceCount} Stone+-managed instance(s)`)
      : t('外部终端会话不受 Stone+ 控制', 'External terminal sessions are not controlled')
  }
  if (agent.sourceName) return t(`当前源：${agent.sourceName}`, `Source: ${agent.sourceName}`)
  return agent.running ? t('客户端正在运行', 'Client is running') : t('客户端未运行', 'Client is not running')
}

function displayStateForAgent(agent: AgentLifecycleState): AgentLifecycleDisplayState {
  if (agent.busyAction) return 'repairing'
  if (agent.error || agent.attention === 'failed') return 'failed'
  if (agent.attention === 'repair') return 'repair-required'
  if (agent.needsRestart || agent.attention === 'restart') return 'restart-required'
  if (agent.pendingNewSession || agent.attention === 'new-session') return 'new-session'
  return 'ready'
}

export function agentOutcomeLabel(
  outcome: AgentTargetLifecycleResult,
  action: AgentLifecycleOperationResult['action'],
  t: Translator,
): string {
  if (outcome.error) return localizedLifecycleError(outcome.error, t)
  if (outcome.status === 'succeeded') {
    if (action === 'install') return t('已打开官方安装指引', 'Official installation guide opened')
    if (action === 'close') return outcome.runningAfter
      ? t('关闭未完成，客户端仍在运行', 'Close did not complete; the client is still running')
      : t('已关闭', 'Closed')
    if (action === 'start' && outcome.target === 'claude-code-desktop') {
      return t(
        '配置已确认并已打开 Code；完整退出并重开 Claude Desktop 后生效',
        'Settings verified and Code opened; fully quit and reopen Claude Desktop to apply',
      )
    }
    if (action === 'start' && !AGENT_CAPABILITIES[outcome.target].canDetectRunning) {
      return t('已打开', 'Opened')
    }
    if (action === 'start') return outcome.runningAfter
      ? t('已启动', 'Started')
      : t('启动未完成，客户端仍未运行', 'Start did not complete; the client is still stopped')
    if (action === 'restart') return outcome.runningAfter
      ? t('已重新启动', 'Restarted')
      : t('重启未完成，客户端仍未运行', 'Restart did not complete; the client is still stopped')
    if (action === 'restore' || action === 'smart-repair' || action === 'repair-all-affected') {
      if (outcome.wasRunning) return outcome.runningAfter
        ? t('修复完成并已重新启动', 'Repaired and restarted')
        : t('修复完成，但客户端未能重新启动', 'Repair completed, but the client did not restart')
      return outcome.runningAfter
        ? t('修复完成并已启动', 'Repaired and started')
        : t('修复完成；客户端保持停止', 'Repair completed; the client remains stopped')
    }
    return t('操作完成', 'Completed')
  }
  if (outcome.status === 'rolled-back') return t('已回滚', 'Rolled back')
  if (outcome.status === 'skipped') return t('无需更改', 'No change needed')
  return t('操作失败', 'Operation failed')
}

export function agentActionBlockReason(
  agent: AgentLifecycleState,
  agents: readonly AgentLifecycleState[],
  t: Translator,
): string | undefined {
  return agentActionBlockReasonFor(agent, agents, primaryAgentActionFor(agent), t)
}

export function agentActionBlockReasonFor(
  agent: AgentLifecycleState,
  agents: readonly AgentLifecycleState[],
  action: AgentLifecycleControlAction | undefined,
  t: Translator,
): string | undefined {
  if (!agent.installed) {
    return t('尚未安装该客户端。请打开“客户端配置”中的官方安装指引。', 'This client is not installed. Open its official installation guide from Client Configuration.')
  }

  if (!action) {
    if (!agent.enabled || !agent.configured) {
      return t('该客户端尚未接入 Stone+。请先在“客户端配置”中完成配置。', 'This client is not connected to Stone+. Finish its setup in Client Configuration first.')
    }
    if (agent.compatibility === 'unsupported') {
      return t('当前来源不支持该客户端。请在“客户端配置”中更换兼容来源。', 'The current source does not support this client. Choose a compatible source in Client Configuration.')
    }
    return t('当前状态无法执行此操作，请先检查客户端配置。', 'This action is unavailable in the current state. Check Client Configuration first.')
  }

  if (action === 'close' || action === 'restart') {
    if (!agent.running) {
      return t('客户端当前未运行。', 'The client is not currently running.')
    }
    const hasManagedProcess = agent.processControl === 'full'
      || (agent.processControl === 'managed-only' && agent.managedInstanceCount > 0)
    if (!agent.capabilities.canCloseKnownProcess || !hasManagedProcess) {
      return t('该进程不是由 Stone+ 启动，无法在这里关闭或重启。', 'This process was not started by Stone+ and cannot be closed or restarted here.')
    }
  }

  if (action === 'start' || action === 'restart' || action === 'restore') {
    if (!agent.enabled || (!isLaunchOnly(agent) && !agent.configured)) {
      return t('该客户端尚未接入 Stone+。请先在“客户端配置”中完成配置。', 'This client is not connected to Stone+. Finish its setup in Client Configuration first.')
    }
    if (agent.compatibility === 'unsupported') {
      return t('当前来源不支持该客户端。请在“客户端配置”中更换兼容来源。', 'The current source does not support this client. Choose a compatible source in Client Configuration.')
    }
    if (action === 'restore' && !agent.capabilities.canRestoreConnection) {
      return t('该客户端不支持自动修复。', 'This client does not support automatic repair.')
    }
    if (action === 'start' && !canLaunchAgent(agent.capabilities)) {
      return t('该客户端不支持由 Stone+ 开启。', 'This client cannot be started by Stone+.')
    }
    if (action === 'restart' && !agent.capabilities.canRestart) {
      return t('该客户端不支持由 Stone+ 重启。', 'This client cannot be restarted by Stone+.')
    }
  }

  if ((action === 'start' || action === 'restart' || action === 'restore') && agent.target === 'codex-cli') {
    const desktop = agents.find((candidate) => candidate.target === 'codex-desktop')
    if (desktop?.running) {
      return t('Codex Desktop 正在运行，不能同时启动 Codex CLI。请先关闭 Codex Desktop。', 'Codex Desktop is running, so Codex CLI cannot be started at the same time. Close Codex Desktop first.')
    }
  }

  if ((action === 'start' || action === 'restart' || action === 'restore') && agent.target === 'codex-desktop') {
    const cli = agents.find((candidate) => candidate.target === 'codex-cli')
    if (cli?.running) {
      return t('Codex CLI 正在运行，不能同时启动 Codex Desktop。请先关闭 Codex CLI。', 'Codex CLI is running, so Codex Desktop cannot be started at the same time. Close Codex CLI first.')
    }
  }

  return undefined
}

function canLaunchAgent(capabilities: AgentCapabilities): boolean {
  return capabilities.canLaunch ?? capabilities.canRestart
}

function isLaunchOnly(agent: AgentLifecycleState): boolean {
  return !agent.capabilities.canDetectRunning && canLaunchAgent(agent.capabilities)
}

export function localizedLifecycleError(error: AgentLifecycleError, t: Translator): string {
  if (error.code === 'installation-prerequisite-missing' && /Node\.js 20/i.test(error.message)) {
    return t('安装 Gemini CLI 需要 Node.js 20 或更高版本。请先安装或升级 Node.js，再点击重试。', 'Gemini CLI requires Node.js 20 or newer. Install or update Node.js, then try again.')
  }
  if (error.code === 'installation-prerequisite-missing' && /npm/i.test(error.message)) {
    return t('安装 Gemini CLI 需要 npm。请先安装 Node.js 20 或更高版本，再点击重试。', 'Gemini CLI requires npm. Install Node.js 20 or newer, then try again.')
  }
  if (error.code === 'operation-conflict' && /timed out/i.test(error.message)) {
    return t('客户端未在预期时间内响应，Stone+ 已停止等待并保留其他修复结果。请稍后重试。', 'The client did not respond in time. Stone+ stopped waiting and kept the other repair results. Try again shortly.')
  }
  if (error.code === 'operation-conflict' && /shared Codex state/i.test(error.message)) {
    return t('另一个 Codex 客户端正在使用 Stone+ 的共享状态。请先关闭它，再启动当前客户端。', 'Another Codex client is using Stone+ shared state. Close it before starting this client.')
  }
  const messages: Record<AgentLifecycleError['code'], readonly [string, string]> = {
    'not-installed': ['客户端尚未安装，请先在客户端配置中打开官方安装指引。', 'The client is not installed. Open its official installation guide from Client Configuration first.'],
    'not-enabled': ['客户端尚未接入 Stone+，请先完成客户端配置。', 'The client is not connected to Stone+. Complete Client Configuration first.'],
    'unsupported-platform': ['当前系统不支持该客户端。', 'This client is not supported on the current system.'],
    'unsupported-channel': ['当前安装渠道不可用。请使用推荐渠道，或在高级设置中选择其他渠道。', 'The selected installation channel is unavailable. Use the recommended channel or choose another one in Advanced settings.'],
    'installation-prerequisite-missing': ['缺少安装所需的系统组件。Stone+ 已停止安装，请按错误提示补齐后重试。', 'A required system component is missing. Stone+ stopped the installation; follow the error details and try again.'],
    'installation-failed': ['客户端安装失败，现有配置未受影响。请检查网络或系统权限后重试。', 'The client installation failed. Existing configuration was not changed. Check the network or system permissions and try again.'],
    'installation-timeout': ['安装等待超时，Stone+ 已结束等待。请确认网络后重试。', 'The installation timed out and Stone+ stopped waiting. Check the network and try again.'],
    'download-page-failed': ['无法打开官方下载页面。请检查系统默认浏览器设置后重试。', 'The official download page could not be opened. Check the default browser setting and try again.'],
    'unsupported-source': ['当前来源与该客户端不兼容，请更换来源后重试。', 'The current source is incompatible with this client. Choose another source and try again.'],
    'external-process-unmanaged': ['检测到外部启动的会话，Stone+ 无法直接控制。请先在原终端中关闭。', 'An externally started session was detected and cannot be controlled by Stone+. Close it in its original terminal first.'],
    'process-close-failed': ['关闭客户端失败。请手动关闭后重试。', 'The client could not be closed. Close it manually, then try again.'],
    'backup-failed': ['创建安全备份失败，未继续修复。请检查磁盘空间和文件权限。', 'The safety backup failed, so repair did not continue. Check disk space and file permissions.'],
    'configuration-failed': ['写入客户端配置失败。请检查文件权限后重试。', 'Client configuration could not be written. Check file permissions and try again.'],
    'session-repair-failed': ['会话数据修复失败，原数据已保留。请重试或查看诊断。', 'Session repair failed and the original data was preserved. Try again or open Diagnostics.'],
    'workspace-index-repair-failed': ['工作区索引修复失败。请关闭客户端后重试。', 'Workspace index repair failed. Close the client and try again.'],
    'validation-failed': ['修复后校验未通过，未应用不完整的配置。请重试。', 'Post-repair validation failed, so the incomplete configuration was not applied. Try again.'],
    'process-start-failed': ['客户端启动失败。请确认已正确安装，或尝试手动启动。', 'The client failed to start. Confirm it is installed correctly or start it manually.'],
    'operation-conflict': ['另一项 Agent 操作正在进行，请等待完成后重试。', 'Another Agent operation is in progress. Wait for it to finish, then try again.'],
    'rollback-failed': ['操作失败，且无法完整恢复原配置。请立即打开诊断检查。', 'The operation failed and the previous configuration could not be fully restored. Open Diagnostics now.'],
    cancelled: ['操作已取消，未应用更改。', 'The operation was cancelled and no changes were applied.'],
    unknown: ['操作未完成。请重试；如果仍失败，请打开诊断查看详情。', 'The operation did not complete. Try again; if it still fails, open Diagnostics for details.'],
  }
  return t(...messages[error.code])
}
