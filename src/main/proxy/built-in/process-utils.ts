import { execFile, type ChildProcess } from 'node:child_process'
import { basename, isAbsolute, normalize, resolve } from 'node:path'

export interface FileExecutionResult {
  stdout: string
  stderr: string
}

export interface FileExecutionOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBuffer?: number
}

export type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options?: FileExecutionOptions
) => Promise<FileExecutionResult>

/**
 * Windows PowerShell treats everything after `-Command` as command text and
 * reparses it. Dynamic values must be passed through the child environment;
 * this helper deliberately has no trailing-argument API so paths containing
 * whitespace or PowerShell metacharacters can never become command source.
 */
export function createWindowsPowerShellCommandArgs(
  script: string,
): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `& {\n${script.trim()}\n}`,
  ]
}

/**
 * Pin ACL and Authenticode cmdlets to the inbox Windows PowerShell module.
 * This avoids inheriting a PSModulePath that resolves a PowerShell 7 module
 * which Windows PowerShell 5.1 cannot load.
 *
 * Keep this after any `param(...)` declaration and before security cmdlet use.
 */
export const WINDOWS_POWERSHELL_SECURITY_MODULE_IMPORT = String.raw`
$stoneSecurityModule = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $stoneSecurityModule -Force -ErrorAction Stop
`.trim()

export async function executeFile(
  executable: string,
  args: readonly string[],
  options: FileExecutionOptions = {}
): Promise<FileExecutionResult> {
  return new Promise<FileExecutionResult>((resolve, reject) => {
    execFile(executable, [...args], {
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(error.message, { cause: error }) as Error & {
          stdout?: string
          stderr?: string
          code?: string | number | null
        }
        failure.stdout = String(stdout ?? '')
        failure.stderr = String(stderr ?? '')
        failure.code = error.code
        reject(failure)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export function waitForProcessSpawn(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error('sing-box exited before it started.'))
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out while starting sing-box.')), timeoutMs)
    const onSpawn = (): void => finish()
    const onError = (error: Error): void => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`sing-box exited while starting (${exitDescription(code, signal)}).`))
    }
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs)
    const onExit = (): void => finish(true)
    const finish = (exited: boolean): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    child.once('exit', onExit)
  })
}

export type TerminateProcessTree = (child: ChildProcess, platform?: NodeJS.Platform) => Promise<void>

/**
 * Stops the process group used for sing-box. POSIX children are launched as a
 * process-group leader; on Windows taskkill /T is the available tree primitive.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  execute: ExecuteFile = executeFile,
  exitTimeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const identity = expectedChildIdentity(child)
  if (child.pid && identity) {
    const stillOwned = await assertProcessIdentity(child.pid, identity, platform, execute)
    if (!stillOwned) {
      if (platform !== 'win32' && processGroupExists(child.pid)) {
        throw new Error(`Process ${child.pid} exited but its remaining process group cannot be identity-verified.`)
      }
      return
    }
  }

  if (platform === 'win32') {
    if (child.pid) {
      try {
        // Windows has no process-group signal equivalent. /T is required even
        // when the root exits quickly, otherwise native helpers can outlive it.
        await execute('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { timeoutMs: 5_000 })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process may already have exited.
        }
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // A pid-less failed spawn may already be closed.
      }
    }
    const exited = await waitForProcessExit(child, exitTimeoutMs)
    if (!exited) {
      await assertProcessGone(child.pid, identity, platform, execute)
    }
    return
  }

  signalProcessTree(child, platform, 'SIGTERM')
  const rootExited = await waitForProcessExit(child, exitTimeoutMs)
  if (!rootExited || processGroupExists(child.pid)) {
    try {
      signalProcessTree(child, platform, 'SIGKILL')
    } catch {
      // A process group disappearing between the probe and signal is expected.
    }
  }
  const exited = await waitForProcessExit(child, exitTimeoutMs)
  if (!exited || processGroupExists(child.pid)) {
    await assertProcessGone(child.pid, identity, platform, execute)
    if (processGroupExists(child.pid)) {
      throw new Error(`Process group ${child.pid ?? 'unknown'} is still alive after forced termination.`)
    }
  }
}

export function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`
  if (signal) return `signal ${signal}`
  return 'unknown status'
}

function signalProcessTree(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  if (platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The process may have left its group during shutdown; fall back to the
      // direct child handle so normal cleanup still completes.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Exiting between the liveness check and the signal is harmless.
  }
}

function processGroupExists(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

interface ExpectedProcessIdentity {
  imagePath: string
  commandArguments: readonly string[]
}

interface ObservedProcessIdentity {
  imagePath: string
  commandLine: string
}

function expectedChildIdentity(child: ChildProcess): ExpectedProcessIdentity | undefined {
  const processChild = child as ChildProcess & { spawnfile?: string; spawnargs?: string[] }
  const imagePath = processChild.spawnfile?.trim()
  if (!imagePath) return undefined
  const spawnArgs = processChild.spawnargs ?? []
  return {
    imagePath,
    commandArguments: spawnArgs.length > 0 ? spawnArgs.slice(1) : [],
  }
}

async function assertProcessIdentity(
  pid: number,
  expected: ExpectedProcessIdentity,
  platform: NodeJS.Platform,
  execute: ExecuteFile,
): Promise<boolean> {
  const observed = await inspectProcessIdentity(pid, platform, execute)
  if (!observed) return false
  const imageMatches = sameImage(observed.imagePath, expected.imagePath, platform)
  const commandMatches = expected.commandArguments.every((argument) => (
    !argument || observed.commandLine.includes(argument)
  ))
  if (!imageMatches || !commandMatches) {
    throw new Error(`Refusing to terminate process ${pid}: its image or command line no longer matches Stone+ ownership.`)
  }
  return true
}

async function assertProcessGone(
  pid: number | undefined,
  expected: ExpectedProcessIdentity | undefined,
  platform: NodeJS.Platform,
  execute: ExecuteFile,
): Promise<void> {
  if (!pid) throw new Error('The process did not exit and has no PID for final verification.')
  if (!expected) {
    throw new Error(`Process ${pid} is still alive after forced termination and lacks a verifiable image/command identity.`)
  }
  const observed = await inspectProcessIdentity(pid, platform, execute)
  if (!observed) return
  const stillOwned = sameImage(observed.imagePath, expected.imagePath, platform)
    && expected.commandArguments.every((argument) => !argument || observed.commandLine.includes(argument))
  if (stillOwned) throw new Error(`Stone+ process ${pid} is still alive after forced termination.`)
  throw new Error(`PID ${pid} is still alive after forced termination and cannot be safely released.`)
}

async function inspectProcessIdentity(
  pid: number,
  platform: NodeJS.Platform,
  execute: ExecuteFile,
): Promise<ObservedProcessIdentity | undefined> {
  try {
    if (platform === 'win32') {
      const script = String.raw`
$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ${pid}') -ErrorAction SilentlyContinue
if ($null -eq $p) { [Console]::Out.Write('missing'); exit 0 }
[ordered]@{ imagePath = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress
`.trim()
      const result = await execute('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { timeoutMs: 5_000 })
      if (result.stdout.trim() === 'missing') return undefined
      const parsed = JSON.parse(result.stdout.trim()) as Partial<ObservedProcessIdentity>
      if (!parsed.imagePath || !parsed.commandLine) throw new Error(`Windows withheld process identity for PID ${pid}.`)
      return { imagePath: parsed.imagePath, commandLine: parsed.commandLine }
    }
    const image = await execute('/usr/bin/readlink', [`/proc/${pid}/exe`], { timeoutMs: 5_000 })
      .catch(async () => execute('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeoutMs: 5_000 }))
    const command = await execute('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5_000 })
    const imagePath = image.stdout.trim()
    const commandLine = command.stdout.trim()
    return imagePath && commandLine ? { imagePath, commandLine } : undefined
  } catch (error) {
    const cause = error as Error & {
      code?: unknown
      cause?: { code?: unknown }
      stdout?: string
      stderr?: string
    }
    const code = cause.code ?? cause.cause?.code
    if (code === 'ESRCH' || (platform !== 'win32' && (code === 1 || code === 3))) return undefined
    const output = `${(error as Error & { stdout?: string; stderr?: string }).stdout ?? ''}\n${(error as Error & { stderr?: string }).stderr ?? ''}`
    if (
      platform !== 'win32'
      && /no process|not found|cannot find|failed to open|exit code 3/i.test(`${String((error as Error).message)}\n${output}`)
    ) return undefined
    throw error
  }
}

function sameImage(observed: string, expected: string, platform: NodeJS.Platform): boolean {
  const normalizePath = (value: string): string => {
    const normalized = normalize(resolve(value))
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  if (normalizePath(observed) === normalizePath(expected)) return true
  if (isAbsolute(observed) && isAbsolute(expected)) return false
  const observedName = basename(observed)
  const expectedName = basename(expected)
  return platform === 'win32'
    ? observedName.toLowerCase() === expectedName.toLowerCase()
    : observedName === expectedName
}
