import { execFile, spawn } from 'node:child_process'
import type {
  ChatGptDesktopRestartState,
  CodexSessionRepairRestartResult,
} from '@shared/types'
import type { CodexSessionRepairService } from './session-repair-service'

interface CommandResult {
  stdout: string
  stderr: string
}

export interface ChatGptDesktopController {
  shutdownForRepair(): Promise<ChatGptDesktopRestartState>
  relaunch(state: ChatGptDesktopRestartState): Promise<void>
}

interface WindowsControllerOptions {
  platform?: NodeJS.Platform
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  launch?: (file: string, args: string[]) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
}

const fallbackChatGptAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
const discoverChatGptCommand = [
  "$entry = Get-StartApps | Where-Object { $_.Name -eq 'ChatGPT' -and $_.AppID -notmatch 'uninstall' } | Select-Object -First 1;",
  "if ($entry) { [Console]::Out.Write($entry.AppID); exit 0 };",
  "$process = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1;",
  "if ($process) { [Console]::Out.Write($process.Path) }",
].join(' ')

export class WindowsChatGptDesktopController implements ChatGptDesktopController {
  private readonly platform: NodeJS.Platform
  private readonly runCommand: (file: string, args: string[]) => Promise<CommandResult>
  private readonly launch: (file: string, args: string[]) => Promise<void>
  private readonly delay: (milliseconds: number) => Promise<void>

  constructor(options: WindowsControllerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.runCommand = options.runCommand ?? runCommand
    this.launch = options.launch ?? launchDetached
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async shutdownForRepair(): Promise<ChatGptDesktopRestartState> {
    if (this.platform !== 'win32') throw new Error('会话修复快捷重启目前仅支持 Windows ChatGPT。')
    const launchTarget = await this.discoverLaunchTarget()
    const listing = await this.runCommand('tasklist.exe', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'])
    const wasRunning = /"ChatGPT\.exe"/i.test(listing.stdout)
    if (wasRunning) {
      try {
        await this.runCommand('taskkill.exe', ['/F', '/T', '/IM', 'ChatGPT.exe'])
      } catch (cause) {
        throw new Error('无法关闭 ChatGPT：' + messageOf(cause))
      }
      await this.delay(450)
    }
    return { wasRunning, launchTarget }
  }

  async relaunch(state: ChatGptDesktopRestartState): Promise<void> {
    if (this.platform !== 'win32') throw new Error('会话修复快捷重启目前仅支持 Windows ChatGPT。')
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
}

export class CodexRepairAndRestartService {
  private active = false
  private closing = false
  private inFlight: Promise<CodexSessionRepairRestartResult> | null = null

  constructor(
    private readonly repairService: CodexSessionRepairService,
    private readonly desktop: ChatGptDesktopController,
  ) {}

  run(): Promise<CodexSessionRepairRestartResult> {
    if (this.closing) return Promise.reject(new Error('Stone+ 正在退出，无法启动会话修复。'))
    if (this.active) return Promise.reject(new Error('会话修复与 ChatGPT 重启正在进行。'))
    this.active = true
    const operation = this.execute()
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

  private async execute(): Promise<CodexSessionRepairRestartResult> {
    let restartState: ChatGptDesktopRestartState | undefined
    let relaunched = false
    try {
      restartState = await this.desktop.shutdownForRepair()
      const overview = await this.repairService.inspect()
      const targetProvider = overview.currentProvider
        || overview.targets.find((target) => target.isCurrentProvider)?.id
        || overview.targets[0]?.id
      if (!targetProvider) throw new Error('未找到可用于会话修复的 provider。')
      const preview = await this.repairService.preview(targetProvider)
      const repair = await this.repairService.repair(targetProvider, preview.revision)
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
        } catch (restartCause) {
          throw new Error(messageOf(cause) + '；ChatGPT 重新启动失败：' + messageOf(restartCause))
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
