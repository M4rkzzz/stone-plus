import { execFile, spawn } from 'node:child_process'
import type {
  ChatGptDesktopRestartState,
  CodexSessionIndexCleanupRestartResult,
  CodexSessionRepairRestartResult,
} from '@shared/types'
import type { CodexSessionIndexCleanupService } from './session-index-cleanup-service'
import type { CodexSessionRepairService } from './session-repair-service'
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

export interface CodexRepairAndRestartOptions {
  /** Force every repaired session to this provider instead of the current one. */
  targetProvider?: string
  /** Bind a reviewed preview to the post-shutdown repair transaction. */
  expectedRevision?: string
  /** Runs only after Codex is closed and before any session file is inspected. */
  beforeRepair?: () => Promise<void>
}

interface WindowsControllerOptions {
  platform?: NodeJS.Platform
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  launch?: (file: string, args: string[]) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
  shouldDisableCodexMicro?: () => boolean
  launchCodexMicroDisabled?: (executablePath: string) => Promise<void>
}

const fallbackChatGptAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
const discoverChatGptCommand = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  "$portable = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFileName($_.Path) -ceq 'Codex.exe' } | Select-Object -First 1;",
  'if ($portable) { [Console]::Out.Write($portable.Path); exit 0 };',
  "$entry = Get-StartApps | Where-Object { $_.Name -eq 'ChatGPT' -and $_.AppID -notmatch 'uninstall' } | Select-Object -First 1;",
  "if ($entry) { [Console]::Out.Write($entry.AppID); exit 0 };",
  "$process = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1;",
  "if ($process) { [Console]::Out.Write($process.Path) }",
  'exit 0',
].join(' ')
const discoverChatGptExecutableCommand = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  "$portable = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFileName($_.Path) -ceq 'Codex.exe' } | Select-Object -First 1;",
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
    const microLauncher = new WindowsCodexMicroDisabledLauncher()
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
    if (this.shouldDisableCodexMicro() && state.executablePath) {
      try {
        await this.launchCodexMicroDisabled(state.executablePath)
        return
      } catch (cause) {
        // Codex updates can change private startup internals. The launcher kills
        // its paused child before throwing, so normal startup remains safe.
        console.warn('[codex-micro] disable hook failed; falling back to normal startup:', messageOf(cause))
      }
    }
    const target = state.launchTarget.trim() || fallbackChatGptAppId
    if (target.includes('!') && !target.includes('\\') && !target.includes('/')) {
      await this.launch('explorer.exe', ['shell:AppsFolder\\' + target])
      return
    }
    await this.launch(target, [])
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
    let repair: CodexSessionRepairRestartResult['repair'] | undefined
    try {
      if (options.targetProvider && options.expectedRevision) {
        const reviewed = await this.repairService.preview(options.targetProvider)
        if (reviewed.revision !== options.expectedRevision) {
          throw new Error('Codex 会话数据已在预览后发生变化；为避免覆盖新内容，本次修复已中止，请重新预览。')
        }
      }
      restartState = await this.desktop.shutdownForRepair()
      await options.beforeRepair?.()
      const overview = options.targetProvider ? undefined : await this.repairService.inspect()
      const targetProvider = options.targetProvider
        || overview?.currentProvider
        || overview?.targets.find((target) => target.isCurrentProvider)?.id
        || overview?.targets[0]?.id
      if (!targetProvider) throw new Error('未找到可用于会话修复的 provider。')
      // A normal Codex shutdown can flush global state and SQLite. Bind the
      // repair transaction to the stable post-shutdown snapshot rather than a
      // user preview captured while Codex was still running.
      const revision = (await this.repairService.preview(targetProvider)).revision
      repair = await this.repairService.repair(targetProvider, revision)
      await this.desktop.relaunch(restartState)
      relaunched = true
      return {
        repair,
        chatGptWasRunning: restartState.wasRunning,
        chatGptRestarted: true,
      }
    } catch (cause) {
      if (restartState && !relaunched) {
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
      throw cause
    }
  }

  private async executeSessionIndexCleanup(
    snapshotSha256: string,
    threadIds: string[],
  ): Promise<CodexSessionIndexCleanupRestartResult> {
    let restartState: ChatGptDesktopRestartState | undefined
    let relaunched = false
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
      await this.desktop.relaunch(restartState)
      relaunched = true
      return {
        cleanup,
        chatGptWasRunning: restartState.wasRunning,
        chatGptRestarted: true,
      }
    } catch (cause) {
      if (restartState && !relaunched) {
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
