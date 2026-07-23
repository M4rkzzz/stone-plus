import { execFile, type ChildProcess } from 'node:child_process'

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
        const failure = new Error(error.message, { cause: error }) as Error & { stdout?: string; stderr?: string }
        failure.stdout = String(stdout ?? '')
        failure.stderr = String(stderr ?? '')
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
  execute: ExecuteFile = executeFile
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

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
    await waitForProcessExit(child, 2_000)
    return
  }

  signalProcessTree(child, platform, 'SIGTERM')
  const rootExited = await waitForProcessExit(child, 2_000)
  if (!rootExited || processGroupExists(child.pid)) {
    try {
      signalProcessTree(child, platform, 'SIGKILL')
    } catch {
      // A process group disappearing between the probe and signal is expected.
    }
  }
  await waitForProcessExit(child, 2_000)
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
