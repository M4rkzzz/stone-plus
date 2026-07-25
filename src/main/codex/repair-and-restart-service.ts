import { execFile, spawn } from 'node:child_process'
import type {
  ChatGptDesktopRestartState,
  CodexSessionIndexCleanupRestartResult,
  CodexSessionRepairRestartResult,
} from '@shared/types'
import type { CodexSessionIndexCleanupService } from './session-index-cleanup-service'
import type { CodexSessionRepairOperationOptions, CodexSessionRepairService } from './session-repair-service'
import { WindowsCodexMicroDisabledLauncher } from './codex-micro-launcher'
import { findBlockingWindowsCodexPids } from './windows-codex-processes'

interface CommandResult {
  stdout: string
  stderr: string
}

export interface ChatGptDesktopController {
  shutdownForRepair(): Promise<ChatGptDesktopRestartState>
  relaunch(state: ChatGptDesktopRestartState): Promise<void>
}

export class UnsupportedChatGptDesktopController implements ChatGptDesktopController {
  public constructor(private readonly platform: NodeJS.Platform) {}

  async shutdownForRepair(): Promise<ChatGptDesktopRestartState> {
    throw new Error(`Codex desktop restart is not supported on ${this.platform}. Close Codex manually before running session maintenance.`)
  }

  async relaunch(_state: ChatGptDesktopRestartState): Promise<void> {
    throw new Error(`Codex desktop restart is not supported on ${this.platform}. Start Codex manually after session maintenance.`)
  }
}

export interface CodexRepairAndRestartOptions {
  /** Force every repaired session to this provider instead of the current one. */
  targetProvider?: string
  /** Bind a reviewed preview to the post-shutdown repair transaction. */
  expectedRevision?: string
  /** Runs only after Codex is closed and before any session file is inspected. */
  beforeRepair?: () => Promise<void>
  /** Preserve the pre-maintenance running state instead of opening an app that was already closed. */
  preserveRunningState?: boolean
  /** Cancels scanning or mutation at the next safe service checkpoint. */
  signal?: AbortSignal
  /** Reports progress from the single repair plan built after desktop shutdown. */
  onProgress?: CodexSessionRepairOperationOptions['onProgress']
}

interface WindowsControllerOptions {
  platform?: NodeJS.Platform
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  launch?: (file: string, args: string[]) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
  shouldDisableCodexMicro?: () => boolean
  launchCodexMicroDisabled?: (executablePath: string) => Promise<void>
}

interface MacControllerOptions {
  platform?: NodeJS.Platform
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  launch?: (file: string, args: string[]) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
}

const fallbackChatGptAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
const desktopStartupProbeAttempts = 26
const microStartupProbeAttempts = 8
const desktopStartupProbeIntervalMs = 400
const codexMicroHookTimeoutMs = 5_000
const discoverChatGptCommand = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  "$portable = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFileName($_.Path) -ceq 'Codex.exe' -and $_.Path -notmatch '\\WindowsApps\\' } | Select-Object -First 1;",
  'if ($portable) { [Console]::Out.Write($portable.Path); exit 0 };',
  "$unpackaged = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -notmatch '\\WindowsApps\\' } | Select-Object -First 1;",
  'if ($unpackaged) { [Console]::Out.Write($unpackaged.Path); exit 0 };',
  "$entry = Get-StartApps | Where-Object { ($_.Name -eq 'Codex' -or $_.Name -eq 'ChatGPT') -and $_.AppID -notmatch 'uninstall' } | Select-Object -First 1;",
  "if ($entry) { [Console]::Out.Write($entry.AppID); exit 0 };",
  "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;",
  "if ($package -and $package.PackageFamilyName) { [Console]::Out.Write($package.PackageFamilyName + '!App') }",
  'exit 0',
].join(' ')
const discoverChatGptExecutableCommand = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  "$portable = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFileName($_.Path) -ceq 'Codex.exe' -and $_.Path -notmatch '\\WindowsApps\\' } | Select-Object -First 1;",
  'if ($portable) { [Console]::Out.Write($portable.Path); exit 0 };',
  "$process = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1;",
  'if ($process) { [Console]::Out.Write($process.Path); exit 0 };',
  "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;",
  "if ($package) { $candidate = Join-Path $package.InstallLocation 'app\\ChatGPT.exe'; if (Test-Path -LiteralPath $candidate) { [Console]::Out.Write($candidate) } };",
  'exit 0',
].join(' ')
export class WindowsChatGptDesktopController implements ChatGptDesktopController {
  private readonly platform: NodeJS.Platform
  private readonly runCommand: (file: string, args: string[]) => Promise<CommandResult>
  private readonly launch: (file: string, args: string[]) => Promise<void>
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly shouldDisableCodexMicro: () => boolean
  private readonly launchCodexMicroDisabled: (executablePath: string) => Promise<void>

  constructor(options: WindowsControllerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.runCommand = options.runCommand ?? runCommand
    this.launch = options.launch ?? launchDetached
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.shouldDisableCodexMicro = options.shouldDisableCodexMicro ?? (() => false)
    // The normal AppsFolder path is the recovery route. Do not spend another
    // full desktop-start deadline waiting for a private inspector hook that an
    // app update may have removed.
    const microLauncher = new WindowsCodexMicroDisabledLauncher({ timeoutMs: codexMicroHookTimeoutMs })
    this.launchCodexMicroDisabled = options.launchCodexMicroDisabled ?? ((executablePath) => microLauncher.launch(executablePath))
  }

  async shutdownForRepair(): Promise<ChatGptDesktopRestartState> {
    if (this.platform !== 'win32') throw new Error('会话修复快捷重启目前仅支持 Windows ChatGPT。')
    const [launchTarget, executablePath] = await Promise.all([
      this.discoverLaunchTarget(),
      this.discoverExecutablePath(),
    ])
    const blockingPids = await this.listBlockingDesktopPids()
    const wasRunning = blockingPids.length > 0
    if (wasRunning) {
      let killWarning = ''
      try {
        await this.runCommand('taskkill.exe', ['/F', '/T', ...blockingPids.flatMap((pid) => ['/PID', String(pid)])])
      } catch (cause) {
        // taskkill returns a non-zero aggregate exit code when any PID exits
        // between enumeration and termination, even if every live process was
        // closed successfully. The post-kill process list is authoritative.
        killWarning = messageOf(cause)
      }
      let remaining = blockingPids
      for (let attempt = 0; attempt < 5 && remaining.length; attempt += 1) {
        await this.delay(attempt === 0 ? 250 : 100)
        remaining = await this.listBlockingDesktopPids()
        if (remaining.length && attempt < 4) {
          for (const pid of remaining) {
            try {
              await this.runCommand('taskkill.exe', ['/F', '/T', '/PID', String(pid)])
            } catch (cause) {
              killWarning ||= messageOf(cause)
            }
          }
        }
      }
      if (remaining.length) {
        const detail = killWarning ? `；关闭命令：${killWarning}` : ''
        throw new Error(`Codex / ChatGPT 未完全退出（进程：${remaining.join(', ')}），会话维护未开始${detail}。`)
      }
    }
    return { wasRunning, launchTarget, ...(executablePath ? { executablePath } : {}) }
  }

  async relaunch(state: ChatGptDesktopRestartState): Promise<void> {
    if (this.platform !== 'win32') throw new Error('会话修复快捷重启目前仅支持 Windows ChatGPT。')
    let microFailure = ''
    if (this.shouldDisableCodexMicro() && state.executablePath) {
      try {
        await this.launchCodexMicroDisabled(state.executablePath)
        await this.waitForDesktopStartup(microStartupProbeAttempts)
        return
      } catch (cause) {
        // Codex updates can change private startup internals. The launcher kills
        // its paused child before throwing, so normal startup remains safe.
        microFailure = messageOf(cause)
        console.warn('[codex-micro] disable hook failed; falling back to normal startup:', microFailure)
      }
    }
    const target = state.launchTarget.trim() || fallbackChatGptAppId
    try {
      if (target.includes('!') && !target.includes('\\') && !target.includes('/')) {
        await this.launch('explorer.exe', ['shell:AppsFolder\\' + target])
      } else {
        await this.launch(target, [])
      }
      await this.waitForDesktopStartup()
    } catch (cause) {
      const microDetail = microFailure ? `；禁用 Codex Micro 启动失败：${microFailure}` : ''
      throw new Error(`Codex / ChatGPT 启动失败：${messageOf(cause)}${microDetail}`)
    }
  }

  private async discoverLaunchTarget(): Promise<string> {
    try {
      const result = await this.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        discoverChatGptCommand,
      ])
      return result.stdout.trim() || fallbackChatGptAppId
    } catch {
      return fallbackChatGptAppId
    }
  }

  private async discoverExecutablePath(): Promise<string> {
    try {
      const result = await this.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        discoverChatGptExecutableCommand,
      ])
      return result.stdout.trim()
    } catch {
      return ''
    }
  }

  private async listBlockingDesktopPids(): Promise<number[]> {
    return findBlockingWindowsCodexPids({ platform: this.platform, runCommand: this.runCommand })
  }

  private async waitForDesktopStartup(attempts = desktopStartupProbeAttempts): Promise<void> {
    let lastProbeError = ''
    let previousPids = new Set<number>()
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const pids = await this.listBlockingDesktopPids()
        // A detached spawn only proves that process creation was attempted.
        // Require the same desktop process set across two probes so an
        // immediately crashing bootstrap cannot be reported as a successful
        // repair restart.
        if (pids.some((pid) => previousPids.has(pid))) return
        previousPids = new Set(pids)
        lastProbeError = ''
      } catch (cause) {
        previousPids = new Set()
        lastProbeError = messageOf(cause)
      }
      if (attempt < attempts - 1) await this.delay(desktopStartupProbeIntervalMs)
    }
    const detail = lastProbeError ? `；进程检测失败：${lastProbeError}` : ''
    const timeoutSeconds = Math.ceil(Math.max(0, attempts - 1) * desktopStartupProbeIntervalMs / 1000)
    throw new Error(`启动命令已执行，但 ${timeoutSeconds} 秒内未检测到稳定的 Codex / ChatGPT 桌面进程${detail}`)
  }
}

/** Controls only the two known Codex desktop process names on macOS. */
export class MacChatGptDesktopController implements ChatGptDesktopController {
  private readonly platform: NodeJS.Platform
  private readonly runCommand: (file: string, args: string[]) => Promise<CommandResult>
  private readonly launch: (file: string, args: string[]) => Promise<void>
  private readonly delay: (milliseconds: number) => Promise<void>

  constructor(options: MacControllerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.runCommand = options.runCommand ?? runCommand
    this.launch = options.launch ?? launchDetached
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async shutdownForRepair(): Promise<ChatGptDesktopRestartState> {
    if (this.platform !== 'darwin') throw new Error('macOS Codex controller is only available on macOS.')
    const runningNames = await this.runningNames()
    const wasRunning = runningNames.length > 0
    const launchTarget = runningNames.includes('Codex') ? 'Codex' : runningNames.includes('ChatGPT') ? 'ChatGPT' : 'Codex'
    if (wasRunning) {
      for (const name of runningNames) {
        await this.runCommand('/usr/bin/pkill', ['-TERM', '-x', name]).catch(() => undefined)
      }
      let remaining = runningNames
      for (let attempt = 0; attempt < 20 && remaining.length > 0; attempt += 1) {
        await this.delay(100)
        remaining = await this.runningNames()
      }
      if (remaining.length > 0) {
        for (const name of remaining) {
          await this.runCommand('/usr/bin/pkill', ['-KILL', '-x', name]).catch(() => undefined)
        }
        await this.delay(100)
        remaining = await this.runningNames()
      }
      if (remaining.length > 0) throw new Error(`Codex did not exit completely: ${remaining.join(', ')}`)
    }
    return { wasRunning, launchTarget }
  }

  async relaunch(state: ChatGptDesktopRestartState): Promise<void> {
    if (this.platform !== 'darwin') throw new Error('macOS Codex controller is only available on macOS.')
    const application = state.launchTarget === 'ChatGPT' ? 'ChatGPT' : 'Codex'
    await this.launch('/usr/bin/open', ['-a', application])
  }

  private async runningNames(): Promise<string[]> {
    const names: string[] = []
    for (const name of ['Codex', 'ChatGPT']) {
      try {
        const result = await this.runCommand('/usr/bin/pgrep', ['-x', name])
        if (result.stdout.trim()) names.push(name)
      } catch {
        // pgrep exits non-zero when no matching process exists.
      }
    }
    return names
  }
}

export class CodexRepairAndRestartService {
  private active = false
  private closing = false
  private inFlight: Promise<unknown> | null = null

  constructor(
    private readonly repairService: CodexSessionRepairService,
    private readonly desktop: ChatGptDesktopController,
    private readonly sessionIndexCleanup?: CodexSessionIndexCleanupService,
  ) {}

  run(options: CodexRepairAndRestartOptions = {}): Promise<CodexSessionRepairRestartResult> {
    return this.runExclusive(() => this.execute(options))
  }

  cleanupSessionIndex(
    snapshotSha256: string,
    threadIds: string[],
  ): Promise<CodexSessionIndexCleanupRestartResult> {
    if (!this.sessionIndexCleanup) return Promise.reject(new Error('Codex 幽灵索引清理服务不可用。'))
    return this.runExclusive(() => this.executeSessionIndexCleanup(snapshotSha256, threadIds))
  }

  private runExclusive<T>(execute: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Stone+ 正在退出，无法启动会话维护。'))
    if (this.active) return Promise.reject(new Error('会话维护与 ChatGPT 重启正在进行。'))
    this.active = true
    const operation = execute()
    this.inFlight = operation
    return operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null
      this.active = false
    })
  }

  async waitForIdle(): Promise<void> {
    if (!this.inFlight) return
    await this.inFlight.catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closing = true
    await this.waitForIdle()
  }

  private async execute(options: CodexRepairAndRestartOptions): Promise<CodexSessionRepairRestartResult> {
    let restartState: ChatGptDesktopRestartState | undefined
    let relaunched = false
    let relaunchAttempted = false
    let repair: CodexSessionRepairRestartResult['repair'] | undefined
    const operationOptions = options.signal || options.onProgress
      ? { signal: options.signal, onProgress: options.onProgress }
      : undefined
    try {
      if (options.targetProvider && options.expectedRevision) {
        const reviewed = operationOptions
          ? await this.repairService.analyze(options.targetProvider, operationOptions)
          : await this.repairService.analyze(options.targetProvider)
        if (reviewed.revision !== options.expectedRevision) {
          throw new Error('Codex 会话数据已在预览后发生变化；为避免覆盖新内容，本次修复已中止，请重新预览。')
        }
      }
      restartState = await this.desktop.shutdownForRepair()
      await options.beforeRepair?.()
      // A normal Codex shutdown can flush global state and SQLite. Bind the
      // repair transaction to one stable post-shutdown plan rather than doing
      // inspect + preview + repair scans over every rollout.
      repair = operationOptions
        ? await this.repairService.analyzeAndRepair(options.targetProvider, undefined, operationOptions)
        : await this.repairService.analyzeAndRepair(options.targetProvider)
      if (!options.preserveRunningState || restartState.wasRunning) {
        relaunchAttempted = true
        await this.desktop.relaunch(restartState)
        relaunched = true
      }
      return {
        repair,
        chatGptWasRunning: restartState.wasRunning,
        chatGptRestarted: relaunched,
      }
    } catch (cause) {
      if (restartState && !relaunched && !relaunchAttempted
        && (!options.preserveRunningState || restartState.wasRunning)) {
        try {
          await this.desktop.relaunch(restartState)
          relaunched = true
        } catch (restartCause) {
          throw new Error(messageOf(cause) + '；ChatGPT 重新启动失败：' + messageOf(restartCause))
        }
      }
      if (repair && relaunched && restartState) {
        return {
          repair,
          chatGptWasRunning: restartState.wasRunning,
          chatGptRestarted: true,
        }
      }
      if (repair && relaunchAttempted && !relaunched) {
        throw new Error(`Codex 会话修复已完成，但桌面端未能重新启动：${messageOf(cause)}`)
      }
      throw cause
    }
  }

  private async executeSessionIndexCleanup(
    snapshotSha256: string,
    threadIds: string[],
  ): Promise<CodexSessionIndexCleanupRestartResult> {
    let restartState: ChatGptDesktopRestartState | undefined
    let relaunched = false
    let relaunchAttempted = false
    let cleanup: CodexSessionIndexCleanupRestartResult['cleanup'] | undefined
    try {
      const reviewed = await this.sessionIndexCleanup!.preview()
      if (reviewed.snapshotSha256 !== snapshotSha256) {
        throw new Error('session_index.jsonl 已在预览后发生变化；为避免覆盖 Codex 新内容，本次清理已中止，请重新扫描。')
      }
      restartState = await this.desktop.shutdownForRepair()
      const stable = await this.sessionIndexCleanup!.preview()
      const stableCandidates = new Set(stable.candidates.map((candidate) => candidate.id))
      if (threadIds.some((id) => !stableCandidates.has(id))) {
        throw new Error('确认列表已在 Codex 关闭时发生变化或包含非候选任务；本次清理未执行，请重新扫描。')
      }
      cleanup = await this.sessionIndexCleanup!.apply(stable.snapshotSha256, threadIds)
      relaunchAttempted = true
      await this.desktop.relaunch(restartState)
      relaunched = true
      return {
        cleanup,
        chatGptWasRunning: restartState.wasRunning,
        chatGptRestarted: true,
      }
    } catch (cause) {
      if (restartState && !relaunched && !relaunchAttempted) {
        try {
          await this.desktop.relaunch(restartState)
          relaunched = true
        } catch (restartCause) {
          const applied = cleanup
            ? `索引清理已完成${cleanup.backupPath ? `，备份位于：${cleanup.backupPath}` : ''}`
            : messageOf(cause)
          throw new Error(`${applied}；ChatGPT 重新启动失败：${messageOf(restartCause)}`)
        }
      }
      if (cleanup && relaunched && restartState) {
        return {
          cleanup,
          chatGptWasRunning: restartState.wasRunning,
          chatGptRestarted: true,
        }
      }
      if (cleanup && relaunchAttempted && !relaunched) {
        const applied = `索引清理已完成${cleanup.backupPath ? `，备份位于：${cleanup.backupPath}` : ''}`
        throw new Error(`${applied}；ChatGPT 重新启动失败：${messageOf(cause)}`)
      }
      throw cause
    }
  }
}

function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function launchDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
