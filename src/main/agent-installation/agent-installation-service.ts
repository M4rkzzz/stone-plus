import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { terminateProcessTree } from '../proxy/built-in/process-utils'

export type AgentInstallTarget = 'codex-desktop' | 'codex-cli' | 'claude-code' | 'gemini-cli' | 'grok-build'
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
export const AGENT_INSTALL_GUIDE_URLS = Object.freeze({
  'codex-cli': 'https://learn.chatgpt.com/docs/codex/cli',
  'claude-code': 'https://code.claude.com/docs/en/getting-started',
  'gemini-cli': 'https://github.com/google-gemini/gemini-cli',
  'grok-build': 'https://x.ai/cli',
} satisfies Readonly<Record<Exclude<AgentInstallTarget, 'codex-desktop'>, string>>)

const MAX_DETAIL_LENGTH = 2_000

/**
 * Opens only hard-coded official installation guidance. Stone+ deliberately
 * does not pipe mutable network content into a shell or install floating npm
 * tags; calls remain serialized so the UI receives deterministic progress.
 */
export class AgentInstallationService {
  private readonly openExternal?: (url: string) => Promise<unknown>
  private readonly now: () => number
  private readonly createOperationId: () => string
  private readonly listeners = new Set<AgentInstallProgressListener>()
  private queueTail: Promise<void> = Promise.resolve()
  private queueDepth = 0

  public constructor(options: AgentInstallationServiceOptions = {}) {
    this.openExternal = options.openExternal
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

    return this.openOfficialInstallGuide(operationId, target, channel, onProgress)
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
    || value === 'gemini-cli' || value === 'grok-build'
}

function displayName(target: Exclude<AgentInstallTarget, 'codex-desktop'>): string {
  if (target === 'codex-cli') return 'Codex CLI'
  if (target === 'claude-code') return 'Claude Code'
  return target === 'gemini-cli' ? 'Gemini CLI' : 'Grok Build'
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const combined = current + String(chunk)
  return combined.length <= MAX_DETAIL_LENGTH ? combined : combined.slice(-MAX_DETAIL_LENGTH)
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
