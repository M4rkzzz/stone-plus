import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { parse } from 'smol-toml'
import type { FrpTunnelState } from '@shared/types'

const MAX_LOG_LINES = 120
type FrpcProcess = ChildProcessByStdio<null, Readable, Readable>

interface ParsedTunnelEndpoint {
  remoteAddress?: string
  serverAddress?: string
  remotePort?: number
}

export interface FrpTunnelServiceOptions {
  userDataPath: string
  binaryPath: string
  binaryExists?: (path: string) => Promise<boolean>
}

export class FrpTunnelService {
  private readonly configPath: string
  private readonly binaryPath: string
  private readonly binaryExists: (path: string) => Promise<boolean>
  private config = ''
  private child?: FrpcProcess
  private startedAt?: number
  private lastError?: string
  private logs: string[] = []

  public constructor(options: FrpTunnelServiceOptions) {
    this.configPath = join(options.userDataPath, 'frp', 'frpc.toml')
    this.binaryPath = options.binaryPath
    this.binaryExists = options.binaryExists ?? fileExists
  }

  public async initialize(): Promise<void> {
    try {
      this.config = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }

  public async getState(): Promise<FrpTunnelState> {
    const endpoint = parseTunnelEndpoint(this.config)
    return {
      config: this.config,
      configSaved: Boolean(this.config.trim()),
      binaryAvailable: await this.binaryExists(this.binaryPath),
      running: Boolean(this.child && this.child.exitCode === null && !this.child.killed),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...endpoint,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      logs: [...this.logs]
    }
  }

  public async saveConfig(content: string): Promise<FrpTunnelState> {
    if (this.child) throw new Error('Stop frpc before changing its configuration.')
    const normalized = normalizeConfig(content)
    parseTunnelEndpoint(normalized, true)
    await mkdir(dirname(this.configPath), { recursive: true })
    const temporaryPath = `${this.configPath}.tmp`
    await writeFile(temporaryPath, normalized, 'utf8')
    await rename(temporaryPath, this.configPath)
    this.config = normalized
    this.lastError = undefined
    this.appendLog('Configuration saved.')
    return this.getState()
  }

  public async start(): Promise<FrpTunnelState> {
    if (this.child) return this.getState()
    if (!this.config.trim()) throw new Error('Paste and save an frpc TOML configuration first.')
    if (!await this.binaryExists(this.binaryPath)) {
      throw new Error('The embedded frpc executable is unavailable or was blocked by antivirus software.')
    }
    parseTunnelEndpoint(this.config, true)
    await verifyConfiguration(this.binaryPath, this.configPath)
    this.lastError = undefined
    this.appendLog('Starting frpc...')
    const child = spawn(this.binaryPath, ['-c', this.configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const spawned = waitForSpawn(child)
    this.child = child
    this.startedAt = Date.now()
    pipeLines(child.stdout, (line) => this.appendLog(line))
    pipeLines(child.stderr, (line) => this.appendLog(line))
    child.once('error', (error) => {
      this.lastError = error.message
      this.appendLog(`frpc error: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.startedAt = undefined
      if (code !== 0 && !child.killed) {
        this.lastError = `frpc exited with ${code === null ? signal ?? 'unknown status' : `code ${code}`}.`
      }
      this.appendLog(code === 0 || child.killed ? 'frpc stopped.' : this.lastError ?? 'frpc stopped unexpectedly.')
    })
    try {
      await spawned
    } catch (error) {
      if (this.child === child) {
        this.child = undefined
        this.startedAt = undefined
      }
      throw error
    }
    return this.getState()
  }

  public async stop(): Promise<FrpTunnelState> {
    const child = this.child
    if (!child) return this.getState()
    this.child = undefined
    this.startedAt = undefined
    child.kill()
    await waitForExit(child, 3_000)
    this.appendLog('frpc stopped.')
    return this.getState()
  }

  public async clearLogs(): Promise<FrpTunnelState> {
    this.logs = []
    return this.getState()
  }

  public async close(): Promise<void> {
    await this.stop()
  }

  private appendLog(line: string): void {
    const value = sanitizeLogLine(line)
    if (!value) return
    this.logs.push(`[${new Date().toLocaleTimeString()}] ${value}`)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
  }
}

export function parseTunnelEndpoint(content: string, required = false): ParsedTunnelEndpoint {
  if (!content.trim()) {
    if (required) throw new Error('frpc configuration is empty.')
    return {}
  }
  let root: Record<string, unknown>
  try {
    root = parse(content) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Invalid frpc TOML: ${error instanceof Error ? error.message : 'parse failed'}`)
  }
  const serverAddress = stringValue(root.serverAddr)
  const proxies = Array.isArray(root.proxies) ? root.proxies : []
  const proxy = proxies
    .map(objectValue)
    .find((candidate) => candidate?.type === 'tcp' && integerValue(candidate.remotePort) !== undefined)
  const remotePort = integerValue(proxy?.remotePort)
  if (required && !serverAddress) throw new Error('frpc configuration is missing serverAddr.')
  if (required && !remotePort) throw new Error('frpc configuration needs a TCP proxy with remotePort.')
  return {
    ...(serverAddress ? { serverAddress } : {}),
    ...(remotePort ? { remotePort } : {}),
    ...(serverAddress && remotePort ? { remoteAddress: `http://${urlHost(serverAddress)}:${remotePort}/v1` } : {})
  }
}

function normalizeConfig(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  if (!normalized) throw new Error('frpc configuration is empty.')
  if (normalized.length > 256_000) throw new Error('frpc configuration is too large.')
  return `${normalized}\n`
}

async function verifyConfiguration(binaryPath: string, configPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(binaryPath, ['verify', '-c', configPath], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (!error) return resolve()
      const detail = sanitizeLogLine(stderr || stdout || error.message)
      reject(new Error(`frpc configuration validation failed${detail ? `: ${detail}` : '.'}`))
    })
  })
}

function waitForSpawn(child: FrpcProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function waitForExit(child: FrpcProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function pipeLines(stream: Readable, listener: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) listener(line)
  })
  stream.on('end', () => { if (buffer) listener(buffer) })
}

function sanitizeLogLine(value: string): string {
  return value
    .replace(/\b(auth\.token|token)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1 = [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : undefined
}

function urlHost(value: string): string {
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
}
