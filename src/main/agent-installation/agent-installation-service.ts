import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { clean as cleanSemver, satisfies as satisfiesSemver } from 'semver'
import type { AgentTarget } from '../../shared/agent-lifecycle'
import { terminateProcessTree } from '../proxy/built-in/process-utils'

export type AgentInstallTarget = AgentTarget
export type AgentInstallChannel = 'recommended' | 'preview'
export type AgentInstallStage =
  | 'queued'
  | 'checking-node'
  | 'checking-npm'
  | 'installing'
  | 'verifying'
  | 'opening-download-page'
  | 'completed'
  | 'failed'

export type AgentInstallErrorCode =
  | 'unsupported-target'
  | 'unsupported-channel'
  | 'node-not-found'
  | 'npm-not-found'
  | 'install-timeout'
  | 'install-failed'
  | 'verification-failed'
  | 'open-download-page-failed'

export interface AgentInstallProgress {
  operationId: string
  target: AgentInstallTarget
  channel: AgentInstallChannel
  stage: AgentInstallStage
  timestamp: number
  queuePosition?: number
  packageName?: string
  detail?: string
}

export interface AgentInstallResult {
  operationId: string
  target: AgentInstallTarget
  channel: AgentInstallChannel
  status: 'installed' | 'opened-download-page' | 'failed'
  packageName?: string
  version?: string
  error?: {
    code: AgentInstallErrorCode
    message: string
    detail?: string
  }
}

export interface AgentInstallerProcessResult {
  stdout: string
  stderr: string
}

export interface AgentInstallerProcessPort {
  execute(executable: string, args: readonly string[], options: {
    timeoutMs: number
  }): Promise<AgentInstallerProcessResult>
}

export type AgentInstallProgressListener = (progress: AgentInstallProgress) => void

export interface AgentInstallationServiceOptions {
  processPort?: AgentInstallerProcessPort
  openExternal?: (url: string) => Promise<unknown>
  platform?: NodeJS.Platform
  runtimeCheckTimeoutMs?: number
  installTimeoutMs?: number
  verificationTimeoutMs?: number
  now?: () => number
  createOperationId?: () => string
  environment?: NodeJS.ProcessEnv
  homeDir?: string
}

export const CODEX_DESKTOP_DOWNLOAD_URL = 'https://chatgpt.com/download/'
export const DEEPSEEK_HARNESS_PACKAGE_NAME = '@deepseek-ai/dsh'
export const DEEPSEEK_HARNESS_VERSION = '0.1.0-rc.6'
export const DEEPSEEK_HARNESS_PACKAGE_SPEC = `${DEEPSEEK_HARNESS_PACKAGE_NAME}@${DEEPSEEK_HARNESS_VERSION}`
export const DEEPSEEK_HARNESS_NODE_RANGE = '^22.19.0 || >=24.0.0'
export const AGENT_INSTALL_GUIDE_URLS = Object.freeze({
  'codex-cli': 'https://learn.chatgpt.com/docs/codex/cli',
  'claude-code': 'https://code.claude.com/docs/en/getting-started',
  'claude-code-desktop': 'https://claude.com/download',
  'claude-code-vsc': 'https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code',
  'gemini-cli': 'https://github.com/google-gemini/gemini-cli',
  'grok-build': 'https://x.ai/cli',
  'deepseek-harness': 'https://github.com/deepseek-ai/deepseek-harness',
} satisfies Readonly<Record<Exclude<AgentInstallTarget, 'codex-desktop'>, string>>)

const MAX_DETAIL_LENGTH = 2_000
const DEFAULT_RUNTIME_CHECK_TIMEOUT_MS = 10_000
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000
const DEFAULT_VERIFICATION_TIMEOUT_MS = 30_000

interface NpmInvocation {
  executable: string
  leadingArgs: string[]
}

/**
 * Opens hard-coded official installation guidance for external products. The
 * DeepSeek Harness exception uses a fixed official npm package and version,
 * invokes npm without a shell, and verifies the installed CLI before handing
 * it to the lifecycle coordinator. Calls remain serialized so the UI receives
 * deterministic progress.
 */
export class AgentInstallationService {
  private readonly processPort: AgentInstallerProcessPort
  private readonly openExternal?: (url: string) => Promise<unknown>
  private readonly platform: NodeJS.Platform
  private readonly runtimeCheckTimeoutMs: number
  private readonly installTimeoutMs: number
  private readonly verificationTimeoutMs: number
  private readonly environment: NodeJS.ProcessEnv
  private readonly homeDir: string
  private readonly now: () => number
  private readonly createOperationId: () => string
  private readonly listeners = new Set<AgentInstallProgressListener>()
  private queueTail: Promise<void> = Promise.resolve()
  private queueDepth = 0

  public constructor(options: AgentInstallationServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.processPort = options.processPort ?? new NativeAgentInstallerProcessPort(this.platform)
    this.openExternal = options.openExternal
    this.runtimeCheckTimeoutMs = positiveTimeout(options.runtimeCheckTimeoutMs, DEFAULT_RUNTIME_CHECK_TIMEOUT_MS)
    this.installTimeoutMs = positiveTimeout(options.installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS)
    this.verificationTimeoutMs = positiveTimeout(options.verificationTimeoutMs, DEFAULT_VERIFICATION_TIMEOUT_MS)
    this.environment = options.environment ?? process.env
    this.homeDir = options.homeDir ?? homedir()
    this.now = options.now ?? Date.now
    this.createOperationId = options.createOperationId ?? randomUUID
  }

  public subscribe(listener: AgentInstallProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public install(
    target: AgentInstallTarget,
    channel: AgentInstallChannel = 'recommended',
    onProgress?: AgentInstallProgressListener,
  ): Promise<AgentInstallResult> {
    const operationId = this.createOperationId()
    const queuePosition = this.queueDepth
    this.queueDepth += 1
    if (queuePosition > 0) this.emit({ operationId, target, channel, stage: 'queued', queuePosition }, onProgress)

    const operation = this.queueTail.then(() => this.run(operationId, target, channel, onProgress))
    this.queueTail = operation.then(() => undefined, () => undefined)
    return operation.finally(() => { this.queueDepth = Math.max(0, this.queueDepth - 1) })
  }

  private async run(
    operationId: string,
    target: AgentInstallTarget,
    channel: AgentInstallChannel,
    onProgress?: AgentInstallProgressListener,
  ): Promise<AgentInstallResult> {
    if (!isAgentInstallTarget(target)) {
      return this.fail(operationId, target, channel, 'unsupported-target', 'This Agent cannot be installed by Stone+.', undefined, onProgress)
    }
    if (channel !== 'recommended' && channel !== 'preview') {
      return this.fail(operationId, target, channel, 'unsupported-channel', 'This installation channel is not supported.', undefined, onProgress)
    }
    if (target === 'codex-desktop') {
      if (channel !== 'recommended') {
        return this.fail(operationId, target, channel, 'unsupported-channel', 'Codex Desktop does not provide a supported preview installer.', undefined, onProgress)
      }
      return this.openCodexDesktopPage(operationId, target, channel, onProgress)
    }

    if (channel === 'preview' && target !== 'gemini-cli') {
      return this.fail(operationId, target, channel, 'unsupported-channel', `${displayName(target)} does not provide a supported preview installation channel.`, undefined, onProgress)
    }

    if (target === 'deepseek-harness') {
      return this.installDeepSeekHarness(operationId, channel, onProgress)
    }

    return this.openOfficialInstallGuide(operationId, target, channel, onProgress)
  }

  private async installDeepSeekHarness(
    operationId: string,
    channel: AgentInstallChannel,
    onProgress?: AgentInstallProgressListener,
  ): Promise<AgentInstallResult> {
    const target = 'deepseek-harness' as const
    const packageName = DEEPSEEK_HARNESS_PACKAGE_NAME
    this.emit({ operationId, target, channel, stage: 'checking-node', packageName }, onProgress)

    let nodeExecutable: string
    try {
      const command = this.platform === 'win32' ? 'node.exe' : 'node'
      const [versionResult, executableResult] = await Promise.all([
        this.processPort.execute(command, ['--version'], { timeoutMs: this.runtimeCheckTimeoutMs }),
        this.processPort.execute(command, ['-p', 'process.execPath'], { timeoutMs: this.runtimeCheckTimeoutMs }),
      ])
      const version = cleanSemver(firstOutputLine(versionResult.stdout))
      if (!version || !satisfiesSemver(version, DEEPSEEK_HARNESS_NODE_RANGE)) {
        return this.fail(
          operationId,
          target,
          channel,
          'node-not-found',
          `DeepSeek Harness requires Node.js ${DEEPSEEK_HARNESS_NODE_RANGE}.`,
          version ? `Detected Node.js ${version}.` : 'Unable to read the installed Node.js version.',
          onProgress,
          packageName,
        )
      }
      nodeExecutable = firstOutputLine(executableResult.stdout)
      const pathApi = this.platform === 'win32' ? win32 : posix
      if (!pathApi.isAbsolute(nodeExecutable)) throw new Error('Node.js did not report an absolute executable path.')
    } catch (cause) {
      return this.fail(
        operationId,
        target,
        channel,
        'node-not-found',
        `DeepSeek Harness requires Node.js ${DEEPSEEK_HARNESS_NODE_RANGE}.`,
        errorDetail(cause),
        onProgress,
        packageName,
      )
    }

    this.emit({ operationId, target, channel, stage: 'checking-npm', packageName }, onProgress)
    let npm: NpmInvocation
    try {
      npm = await this.resolveNpmInvocation(nodeExecutable)
    } catch (cause) {
      return this.fail(
        operationId,
        target,
        channel,
        'npm-not-found',
        'DeepSeek Harness installation requires npm from the selected Node.js installation.',
        errorDetail(cause),
        onProgress,
        packageName,
      )
    }

    const prefix = managedNpmPrefix(this.platform, this.homeDir, this.environment)
    this.emit({
      operationId,
      target,
      channel,
      stage: 'installing',
      packageName,
      detail: DEEPSEEK_HARNESS_VERSION,
    }, onProgress)
    try {
      await this.processPort.execute(npm.executable, [
        ...npm.leadingArgs,
        'install',
        '--global',
        '--prefix',
        prefix,
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        DEEPSEEK_HARNESS_PACKAGE_SPEC,
      ], { timeoutMs: this.installTimeoutMs })
    } catch (cause) {
      const timedOut = cause instanceof AgentInstallerProcessError && cause.timedOut
      return this.fail(
        operationId,
        target,
        channel,
        timedOut ? 'install-timeout' : 'install-failed',
        timedOut
          ? 'DeepSeek Harness installation timed out.'
          : 'DeepSeek Harness could not be installed from the official npm package.',
        errorDetail(cause),
        onProgress,
        packageName,
      )
    }

    this.emit({ operationId, target, channel, stage: 'verifying', packageName }, onProgress)
    try {
      const result = await this.processPort.execute(nodeExecutable, [
        deepSeekHarnessEntrypoint(this.platform, prefix),
        '--version',
      ], { timeoutMs: this.verificationTimeoutMs })
      const version = firstOutputLine(result.stdout)
      if (version !== DEEPSEEK_HARNESS_VERSION) {
        throw new Error(`Expected ${DEEPSEEK_HARNESS_VERSION}, but the installed CLI reported ${version || 'no version'}.`)
      }
    } catch (cause) {
      return this.fail(
        operationId,
        target,
        channel,
        'verification-failed',
        'DeepSeek Harness was installed, but its fixed version could not be verified.',
        errorDetail(cause),
        onProgress,
        packageName,
      )
    }

    this.emit({ operationId, target, channel, stage: 'completed', packageName }, onProgress)
    return {
      operationId,
      target,
      channel,
      status: 'installed',
      packageName,
      version: DEEPSEEK_HARNESS_VERSION,
    }
  }

  private async resolveNpmInvocation(nodeExecutable: string): Promise<NpmInvocation> {
    if (this.platform !== 'win32') {
      await this.processPort.execute('npm', ['--version'], { timeoutMs: this.runtimeCheckTimeoutMs })
      return { executable: 'npm', leadingArgs: [] }
    }

    const npmCliCandidates = [
      win32.join(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ...await this.windowsNpmCliCandidates(),
    ]
    let lastError: unknown
    for (const npmCli of uniqueWindowsPaths(npmCliCandidates)) {
      try {
        await this.processPort.execute(nodeExecutable, [npmCli, '--version'], { timeoutMs: this.runtimeCheckTimeoutMs })
        return { executable: nodeExecutable, leadingArgs: [npmCli] }
      } catch (cause) {
        lastError = cause
      }
    }
    throw lastError ?? new Error('npm could not be located next to the selected Node.js installation.')
  }

  private async windowsNpmCliCandidates(): Promise<string[]> {
    try {
      const result = await this.processPort.execute('where.exe', ['npm.cmd'], { timeoutMs: this.runtimeCheckTimeoutMs })
      return outputLines(result.stdout)
        .filter((path) => win32.isAbsolute(path))
        .map((path) => win32.join(win32.dirname(path), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    } catch {
      return []
    }
  }

  private async openOfficialInstallGuide(
    operationId: string,
    target: Exclude<AgentInstallTarget, 'codex-desktop'>,
    channel: AgentInstallChannel,
    onProgress?: AgentInstallProgressListener,
  ): Promise<AgentInstallResult> {
    this.emit({ operationId, target, channel, stage: 'opening-download-page' }, onProgress)
    try {
      if (!this.openExternal) throw new Error('External browser integration is unavailable.')
      await this.openExternal(AGENT_INSTALL_GUIDE_URLS[target])
      this.emit({ operationId, target, channel, stage: 'completed' }, onProgress)
      return { operationId, target, channel, status: 'opened-download-page' }
    } catch (cause) {
      return this.fail(
        operationId,
        target,
        channel,
        'open-download-page-failed',
        `The official ${displayName(target)} installation guide could not be opened.`,
        errorDetail(cause),
        onProgress,
      )
    }
  }

  private async openCodexDesktopPage(
    operationId: string,
    target: 'codex-desktop',
    channel: AgentInstallChannel,
    onProgress?: AgentInstallProgressListener,
  ): Promise<AgentInstallResult> {
    this.emit({ operationId, target, channel, stage: 'opening-download-page' }, onProgress)
    try {
      if (!this.openExternal) throw new Error('External browser integration is unavailable.')
      await this.openExternal(CODEX_DESKTOP_DOWNLOAD_URL)
      this.emit({ operationId, target, channel, stage: 'completed' }, onProgress)
      return { operationId, target, channel, status: 'opened-download-page' }
    } catch (cause) {
      return this.fail(operationId, target, channel, 'open-download-page-failed', 'The official Codex Desktop download page could not be opened.', errorDetail(cause), onProgress)
    }
  }

  private fail(
    operationId: string,
    target: AgentInstallTarget,
    channel: AgentInstallChannel,
    code: AgentInstallErrorCode,
    message: string,
    detail: string | undefined,
    onProgress: AgentInstallProgressListener | undefined,
    packageName?: string,
  ): AgentInstallResult {
    this.emit({ operationId, target, channel, stage: 'failed', packageName, detail: code }, onProgress)
    return {
      operationId,
      target,
      channel,
      status: 'failed',
      ...(packageName ? { packageName } : {}),
      error: { code, message, ...(detail ? { detail } : {}) },
    }
  }

  private emit(
    progress: Omit<AgentInstallProgress, 'timestamp'>,
    operationListener?: AgentInstallProgressListener,
  ): void {
    const event = { ...progress, timestamp: this.now() }
    try { operationListener?.(event) } catch { /* Observers cannot fail an installation. */ }
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Observers cannot fail an installation. */ }
    }
  }
}

export class AgentInstallerProcessError extends Error {
  public constructor(
    message: string,
    public readonly timedOut: boolean,
    public readonly stdout = '',
    public readonly stderr = '',
  ) {
    super(message)
    this.name = 'AgentInstallerProcessError'
  }
}

export class NativeAgentInstallerProcessPort implements AgentInstallerProcessPort {
  public constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public execute(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ): Promise<AgentInstallerProcessResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      const spawnOptions: SpawnOptions = {
        shell: false,
        windowsHide: true,
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      try {
        child = spawn(executable, [...args], spawnOptions)
      } catch (cause) {
        reject(new AgentInstallerProcessError(errorMessage(cause), false))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = appendOutput(stdout, chunk) })
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr = appendOutput(stderr, chunk) })

      const timer = setTimeout(() => {
        timedOut = true
        void terminateProcessTree(child, this.platform).finally(() => {
          finish(new AgentInstallerProcessError(`Command timed out after ${options.timeoutMs} ms.`, true, stdout, stderr))
        })
      }, options.timeoutMs)
      timer.unref?.()

      const finish = (error?: Error, result?: AgentInstallerProcessResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(result ?? { stdout, stderr })
      }
      child.once('error', (cause) => finish(new AgentInstallerProcessError(errorMessage(cause), false, stdout, stderr)))
      child.once('close', (code, signal) => {
        if (timedOut) return
        if (code === 0) finish(undefined, { stdout, stderr })
        else finish(new AgentInstallerProcessError(`Command exited with ${code === null ? signal ?? 'unknown status' : `code ${code}`}.`, false, stdout, stderr))
      })
    })
  }
}

export function isAgentInstallTarget(value: unknown): value is AgentInstallTarget {
  return value === 'codex-desktop' || value === 'codex-cli' || value === 'claude-code'
    || value === 'claude-code-desktop' || value === 'claude-code-vsc'
    || value === 'gemini-cli' || value === 'grok-build' || value === 'deepseek-harness'
}

function displayName(target: Exclude<AgentInstallTarget, 'codex-desktop'>): string {
  if (target === 'codex-cli') return 'Codex CLI'
  if (target === 'claude-code') return 'Claude Code CLI'
  if (target === 'claude-code-desktop') return 'Claude Code Desktop'
  if (target === 'claude-code-vsc') return 'Claude Code VSC'
  if (target === 'gemini-cli') return 'Gemini CLI'
  return target === 'grok-build' ? 'Grok Build' : 'DeepSeek Harness'
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const combined = current + String(chunk)
  return combined.length <= MAX_DETAIL_LENGTH ? combined : combined.slice(-MAX_DETAIL_LENGTH)
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function outputLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function firstOutputLine(value: string): string {
  return outputLines(value)[0] ?? ''
}

function managedNpmPrefix(
  platform: NodeJS.Platform,
  homeDir: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform !== 'win32') return posix.join(homeDir, '.local')
  const appData = environment.APPDATA?.trim()
  const roaming = appData && win32.isAbsolute(appData)
    ? appData
    : win32.join(homeDir, 'AppData', 'Roaming')
  return win32.join(roaming, 'npm')
}

function deepSeekHarnessEntrypoint(platform: NodeJS.Platform, prefix: string): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return platform === 'win32'
    ? pathApi.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : pathApi.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = win32.normalize(path).toLocaleLowerCase('en-US')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function errorDetail(cause: unknown): string | undefined {
  if (cause instanceof AgentInstallerProcessError) {
    const output = `${cause.stderr}\n${cause.stdout}`.trim()
    return truncateDetail(output || cause.message)
  }
  return truncateDetail(errorMessage(cause))
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function truncateDetail(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized.length <= MAX_DETAIL_LENGTH ? normalized : normalized.slice(-MAX_DETAIL_LENGTH)
}
