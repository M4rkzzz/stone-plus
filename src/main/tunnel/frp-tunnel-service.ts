import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
import { access, chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { parse, stringify } from 'smol-toml'
import type { FrpTunnelState } from '@shared/types'

const MAX_LOG_LINES = 120
const REDACTED_TUNNEL_SECRET = '[REDACTED]'
const SENSITIVE_TUNNEL_KEY = /(token|secret|password|credential|authorization)/i
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
  /** Must compare the executable against a digest anchored in packaged app code/metadata. */
  verifyBinaryIntegrity?: (path: string) => Promise<void>
  platform?: NodeJS.Platform
  inspectProcess?: (pid: number) => Promise<{ executablePath: string; commandLine: string } | undefined>
  terminateProcessTree?: (pid: number) => Promise<void>
}

interface FrpcProcessMarker {
  version: 1
  pid: number
  executablePath: string
  configPath: string
  startedAt: number
}

export class FrpTunnelService {
  private readonly configPath: string
  private readonly binaryPath: string
  private readonly binaryExists: (path: string) => Promise<boolean>
  private readonly verifyBinaryIntegrity: (path: string) => Promise<void>
  private readonly markerPath: string
  private readonly platform: NodeJS.Platform
  private readonly inspectProcess: NonNullable<FrpTunnelServiceOptions['inspectProcess']>
  private readonly terminateProcessTree: NonNullable<FrpTunnelServiceOptions['terminateProcessTree']>
  private config = ''
  private child?: FrpcProcess
  private recoveredPid?: number
  private startedAt?: number
  private lastError?: string
  private logs: string[] = []

  public constructor(options: FrpTunnelServiceOptions) {
    this.configPath = join(options.userDataPath, 'frp', 'frpc.toml')
    this.binaryPath = options.binaryPath
    this.binaryExists = options.binaryExists ?? fileExists
    this.verifyBinaryIntegrity = options.verifyBinaryIntegrity ?? missingBinaryIntegrityVerifier
    this.markerPath = join(options.userDataPath, 'frp', 'frpc-process.json')
    this.platform = options.platform ?? process.platform
    this.inspectProcess = options.inspectProcess ?? ((pid) => inspectNativeProcess(pid, this.platform))
    this.terminateProcessTree = options.terminateProcessTree ?? ((pid) => terminateNativeProcessTree(pid, this.platform))
  }

  public async initialize(): Promise<void> {
    if (this.platform !== 'win32') {
      await chmod(dirname(this.configPath), 0o700).catch((error) => {
        if (!isMissingFile(error)) throw error
      })
    }
    try {
      this.config = await readFile(this.configPath, 'utf8')
      if (this.platform !== 'win32') await chmod(this.configPath, 0o600)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    await this.recoverManagedProcess()
  }

  public async getState(): Promise<FrpTunnelState> {
    const endpoint = parseTunnelEndpoint(this.config)
    return {
      config: redactTunnelConfig(this.config),
      configSaved: Boolean(this.config.trim()),
      binaryAvailable: await this.binaryExists(this.binaryPath),
      running: Boolean(this.recoveredPid || (this.child && this.child.exitCode === null && !this.child.killed)),
      ...(this.child?.pid || this.recoveredPid ? { pid: this.child?.pid ?? this.recoveredPid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...endpoint,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      logs: [...this.logs]
    }
  }

  public async saveConfig(content: string): Promise<FrpTunnelState> {
    if (this.child || this.recoveredPid) throw new Error('Stop frpc before changing its configuration.')
    const normalized = normalizeConfig(restoreRedactedSecrets(content, this.config))
    parseTunnelEndpoint(normalized, true)
    await mkdir(dirname(this.configPath), { recursive: true })
    if (this.platform !== 'win32') await chmod(dirname(this.configPath), 0o700)
    const temporaryPath = `${this.configPath}.tmp`
    await writeFile(temporaryPath, normalized, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.configPath)
    if (this.platform !== 'win32') await chmod(this.configPath, 0o600)
    this.config = normalized
    this.lastError = undefined
    this.appendLog('Configuration saved.')
    return this.getState()
  }

  public async start(): Promise<FrpTunnelState> {
    if (this.child || this.recoveredPid) return this.getState()
    if (!this.config.trim()) throw new Error('Paste and save an frpc TOML configuration first.')
    if (!await this.binaryExists(this.binaryPath)) {
      throw new Error('The embedded frpc executable is unavailable or was blocked by antivirus software.')
    }
    try {
      await this.verifyBinaryIntegrity(this.binaryPath)
    } catch (cause) {
      const detail = sanitizeLogLine(cause instanceof Error ? cause.message : String(cause))
      this.lastError = `frpc binary integrity verification failed${detail ? `: ${detail}` : '.'}`
      this.appendLog(this.lastError)
      throw new Error(this.lastError)
    }
    parseTunnelEndpoint(this.config, true)
    await verifyConfiguration(this.binaryPath, this.configPath)
    this.lastError = undefined
    this.appendLog('Starting frpc...')
    const child = spawn(this.binaryPath, ['-c', this.configPath], {
      windowsHide: true,
      detached: this.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const spawned = waitForSpawn(child)
    this.child = child
    this.startedAt = Date.now()
    pipeLines(child.stdout, (line) => this.appendLog(line))
    pipeLines(child.stderr, (line) => this.appendLog(line))
    child.once('error', (error) => {
      this.lastError = sanitizeLogLine(error.message) || 'frpc process error.'
      this.appendLog(`frpc error: ${this.lastError}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.startedAt = undefined
      void this.clearProcessMarker().catch((error) => {
        console.error('Stone+ could not clear the stopped frpc recovery marker', error)
      })
      if (code !== 0 && !child.killed) {
        this.lastError = `frpc exited with ${code === null ? signal ?? 'unknown status' : `code ${code}`}.`
      }
      this.appendLog(code === 0 || child.killed ? 'frpc stopped.' : this.lastError ?? 'frpc stopped unexpectedly.')
    })
    try {
      await spawned
      if (!child.pid) throw new Error('frpc started without a process identifier.')
      await this.writeProcessMarker({
        version: 1,
        pid: child.pid,
        executablePath: await canonicalPath(this.binaryPath),
        configPath: resolve(this.configPath),
        startedAt: this.startedAt ?? Date.now(),
      })
      if (child.exitCode !== null) {
        await this.clearProcessMarker()
        throw new Error('frpc exited before startup recovery state could be saved.')
      }
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
    const recoveredPid = this.recoveredPid
    if (!child && !recoveredPid) return this.getState()
    if (child) {
      child.kill()
      if (!await waitForExit(child, 3_000) && child.pid) await this.terminateProcessTree(child.pid)
    } else if (recoveredPid) {
      const markerMatches = await this.recoveredProcessStillMatches(recoveredPid)
      if (markerMatches) await this.terminateProcessTree(recoveredPid)
    }
    this.child = undefined
    this.recoveredPid = undefined
    this.startedAt = undefined
    await this.clearProcessMarker()
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

  private async recoverManagedProcess(): Promise<void> {
    let marker: FrpcProcessMarker | undefined
    try {
      const candidate = JSON.parse(await readFile(this.markerPath, 'utf8')) as Partial<FrpcProcessMarker>
      if (candidate.version === 1 && Number.isSafeInteger(candidate.pid) && candidate.pid! > 0
        && typeof candidate.executablePath === 'string' && typeof candidate.configPath === 'string'
        && typeof candidate.startedAt === 'number') marker = candidate as FrpcProcessMarker
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error
    }
    if (!marker) {
      await this.clearProcessMarker()
      return
    }
    const expectedExecutable = await canonicalPath(this.binaryPath)
    const expectedConfig = resolve(this.configPath)
    const markerExecutableMatches = samePath(marker.executablePath, expectedExecutable, this.platform)
    const markerConfigMatches = samePath(marker.configPath, expectedConfig, this.platform)
    if (!markerExecutableMatches || !markerConfigMatches) {
      this.lastError = `Discarded stale frpc recovery state (marker executable: ${markerExecutableMatches}, config: ${markerConfigMatches}).`
      await this.clearProcessMarker()
      return
    }
    try {
      // The marker is untrusted persisted state. Verify the packaged executable
      // before inspecting or adopting its PID so a failed recovery can never
      // make Stone+ terminate an unknown process later.
      await this.verifyBinaryIntegrity(expectedExecutable)
    } catch (cause) {
      const detail = sanitizeLogLine(cause instanceof Error ? cause.message : String(cause))
      this.lastError = `Discarded frpc recovery state because binary integrity verification failed${detail ? `: ${detail}` : '.'}`
      this.appendLog(this.lastError)
      await this.clearProcessMarker()
      return
    }
    let live: Awaited<ReturnType<NonNullable<FrpTunnelServiceOptions['inspectProcess']>>>
    try {
      live = await this.inspectProcess(marker.pid)
    } catch (error) {
      // Do not allow a transient process-inspection failure to turn a known
      // managed process into an untracked duplicate. Keep it adoptable and
      // require an explicit stop/retry instead.
      this.recoveredPid = marker.pid
      this.startedAt = marker.startedAt
      const detail = sanitizeLogLine(error instanceof Error ? error.message : String(error))
      this.lastError = `Could not verify the recovered frpc process${detail ? `: ${detail}` : '.'}`
      return
    }
    const liveExecutableMatches = Boolean(live && samePath(live.executablePath, expectedExecutable, this.platform))
    const commandMatches = Boolean(live && commandLineContainsPath(live.commandLine, expectedConfig, this.platform))
    if (!liveExecutableMatches || !commandMatches) {
      this.lastError = `Discarded stale frpc recovery state (live executable: ${liveExecutableMatches}, command: ${commandMatches}).`
      await this.clearProcessMarker()
      return
    }
    this.recoveredPid = marker.pid
    this.startedAt = marker.startedAt
    this.appendLog(`Recovered the managed frpc process (${marker.pid}) after Stone+ restarted.`)
  }

  private async recoveredProcessStillMatches(pid: number): Promise<boolean> {
    const live = await this.inspectProcess(pid)
    if (!live) return false
    const expectedExecutable = await canonicalPath(this.binaryPath)
    return samePath(live.executablePath, expectedExecutable, this.platform)
      && commandLineContainsPath(live.commandLine, resolve(this.configPath), this.platform)
  }

  private async writeProcessMarker(marker: FrpcProcessMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true })
    const temporaryPath = `${this.markerPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, 'utf8')
    await rename(temporaryPath, this.markerPath)
  }

  private async clearProcessMarker(): Promise<void> {
    await unlink(this.markerPath).catch((error) => {
      if (!isMissingFile(error)) throw error
    })
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

function redactTunnelConfig(content: string): string {
  if (!content.trim()) return content
  const document = parseTomlDocument(content)
  const redacted = transformTomlSecrets(document, undefined, [], 'redact')
  if (!isTomlTable(redacted)) throw new Error('frpc redaction did not produce a TOML document.')
  return serializeTomlDocument(redacted)
}

function restoreRedactedSecrets(content: string, current: string): string {
  if (!content.includes(REDACTED_TUNNEL_SECRET)) return content
  const candidate = parseTomlDocument(content)
  const persisted = current.trim() ? parseTomlDocument(current) : undefined
  const restored = transformTomlSecrets(candidate, persisted, [], 'restore')
  if (!isTomlTable(restored)) throw new Error('frpc secret restoration did not produce a TOML document.')
  return serializeTomlDocument(restored)
}

type TomlDocument = Record<string, unknown>
type TunnelSecretMode = 'redact' | 'restore'

function parseTomlDocument(content: string): TomlDocument {
  const value = parse(content)
  if (!isTomlTable(value)) throw new Error('frpc configuration root must be a TOML table.')
  return value
}

function serializeTomlDocument(document: TomlDocument): string {
  const serialized = stringify(document).replace(/\r\n/g, '\n').trimEnd()
  return serialized ? `${serialized}\n` : ''
}

function transformTomlSecrets(
  candidate: unknown,
  persisted: unknown,
  path: Array<string | number>,
  mode: TunnelSecretMode,
): unknown {
  if (Array.isArray(candidate)) {
    const persistedItems = Array.isArray(persisted) ? persisted : []
    return candidate.map((item, index) => transformTomlSecrets(
      item,
      matchingPersistedArrayItem(item, index, persistedItems),
      [...path, index],
      mode,
    ))
  }
  if (!isTomlTable(candidate)) return candidate

  const persistedTable = isTomlTable(persisted) ? persisted : undefined
  return Object.fromEntries(Object.entries(candidate).map(([key, value]) => {
    const nextPath = [...path, key]
    const previous = persistedTable?.[key]
    if (SENSITIVE_TUNNEL_KEY.test(key)) {
      if (mode === 'redact') return [key, REDACTED_TUNNEL_SECRET]
      if (value === REDACTED_TUNNEL_SECRET) {
        if (previous === undefined) {
          throw new Error(`The redacted frpc secret at ${formatTomlPath(nextPath)} has no stored secret to restore.`)
        }
        return [key, cloneTomlValue(previous)]
      }
      return [key, value]
    }
    return [key, transformTomlSecrets(value, previous, nextPath, mode)]
  }))
}

function matchingPersistedArrayItem(candidate: unknown, index: number, persisted: unknown[]): unknown {
  if (!isTomlTable(candidate) || typeof candidate.name !== 'string') return persisted[index]
  const matches = persisted.filter((item) => isTomlTable(item) && item.name === candidate.name)
  return matches.length === 1 ? matches[0] : undefined
}

function cloneTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneTomlValue)
  if (isTomlTable(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTomlValue(item)]))
  return value
}

function isTomlTable(value: unknown): value is TomlDocument {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function formatTomlPath(path: Array<string | number>): string {
  return path.reduce<string>((result, part) => {
    return typeof part === 'number' ? `${result}[${part}]` : result ? `${result}.${part}` : part
  }, '')
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

async function waitForExit(child: FrpcProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function inspectNativeProcess(pid: number, platform: NodeJS.Platform): Promise<{ executablePath: string; commandLine: string } | undefined> {
  if (platform === 'win32') {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if($p){[Console]::Out.Write(($p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress))}`
    const result = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    if (!result.stdout.trim()) return undefined
    const parsed = JSON.parse(result.stdout) as { ExecutablePath?: unknown; CommandLine?: unknown }
    return typeof parsed.ExecutablePath === 'string' && typeof parsed.CommandLine === 'string'
      ? { executablePath: parsed.ExecutablePath, commandLine: parsed.CommandLine }
      : undefined
  }
  const result = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'comm=', '-o', 'args='])
  const line = result.stdout.trim()
  if (!line) return undefined
  const separator = line.search(/\s/)
  return separator > 0 ? { executablePath: line.slice(0, separator), commandLine: line.slice(separator).trim() } : undefined
}

async function terminateNativeProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await executeFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function executeFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => resolve(value).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function commandLineContainsPath(commandLine: string, expectedPath: string, platform: NodeJS.Platform): boolean {
  const haystack = platform === 'win32' ? commandLine.toLowerCase() : commandLine
  const needle = platform === 'win32' ? expectedPath.toLowerCase() : expectedPath
  return haystack.includes(needle)
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
    .replace(
      /\b(["']?authorization[A-Za-z0-9_.-]*["']?)\s*[:=]\s*(?:["']?)(?:Bearer|Basic)\s+[^\s,;}"']+/gi,
      '$1 = [REDACTED]',
    )
    .replace(
      /\b(["']?[A-Za-z0-9_.-]*(?:token|secret|password|credential|authorization)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1 = [REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /([?&][A-Za-z0-9_.-]*(?:token|secret|password|credential|authorization)[A-Za-z0-9_.-]*=)[^&\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000)
}

async function missingBinaryIntegrityVerifier(): Promise<void> {
  throw new Error('Bundled frpc binary integrity verifier is unavailable.')
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
