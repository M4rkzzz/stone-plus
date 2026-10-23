import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

type LoginPathReader = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<string | undefined>
export type CliEnvironmentResolver = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<NodeJS.ProcessEnv>

const PATH_START = '__STONE_CLI_PATH_START__'
const PATH_END = '__STONE_CLI_PATH_END__'
const SHELL_TIMEOUT_MS = 2_000

/** Cache only PATH, never credentials or a client's isolated configuration. */
export function createCliEnvironmentResolver(
  readLoginPath: LoginPathReader = readLoginShellPath,
  now: () => number = Date.now,
): CliEnvironmentResolver {
  const cache = new Map<string, { expires: number; flight: Promise<string | undefined> }>()
  return async (environment, platform) => {
    if (platform !== 'darwin' && platform !== 'linux') return { ...environment }
    const home = environment.HOME || homedir()
    const key = JSON.stringify([platform, home, environment.SHELL, environment.PATH])
    let entry = cache.get(key)
    if (!entry || entry.expires <= now()) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!)
      entry = { expires: Infinity, flight: Promise.resolve().then(() => readLoginPath(environment, platform)).catch(() => undefined) }
      const current = entry
      cache.set(key, current)
      void current.flight.then((path) => { current.expires = now() + (path ? 60_000 : 5_000) })
    }
    const loginPath = await entry.flight
    // Retain explicit process PATH precedence. Only append absolute shell paths;
    // an empty/relative entry must not introduce implicit cwd executable lookup.
    const additions = (loginPath ?? '').split(':').filter((path) => posix.isAbsolute(path) && !/[\r\n\0]/.test(path))
    additions.push(posix.join(home, '.local', 'bin'), '/usr/local/bin')
    if (platform === 'darwin') additions.push('/opt/homebrew/bin')
    additions.push('/usr/bin', '/bin', '/usr/sbin', '/sbin')
    const original = environment.PATH ? environment.PATH.split(':') : []
    return { ...environment, PATH: [...new Set([...original, ...additions])].join(':') }
  }
}

export const resolveCliEnvironment = createCliEnvironmentResolver()

/** A login shell may print banners, prompt, hang, or leave pipe-owning children. */
export function readLoginShellPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform !== 'darwin' && platform !== 'linux') return Promise.resolve(undefined)
  const shell = environment.SHELL && posix.isAbsolute(environment.SHELL)
    ? environment.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
  return new Promise((resolve) => {
    let output = ''
    const decoder = new StringDecoder('utf8')
    let bytes = 0
    let settled = false
    // Read only PATH; never deserialize a full login environment into an Agent.
    const command = `/usr/bin/printf '\\n${PATH_START}\\n'; /usr/bin/printenv PATH; /usr/bin/printf '\\n${PATH_END}\\n'`
    const child = spawn(shell, ['-ilc', command], {
      env: { ...environment }, cwd: environment.HOME || homedir(),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const finish = (path?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Own process group only, never the user's existing terminal shell.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch {
          try { child.kill('SIGKILL') } catch { /* Already exited. */ }
        }
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(path)
    }
    const timer = setTimeout(() => finish(), SHELL_TIMEOUT_MS)
    const consume = (chunk: Buffer, stdout: boolean): void => {
      bytes += chunk.length
      if (bytes > 64 * 1024) { finish(); return }
      if (!stdout) return
      output += decoder.write(chunk)
      const start = output.indexOf(`${PATH_START}\n`)
      const end = output.indexOf(`\n${PATH_END}`, start)
      if (start >= 0 && end >= 0) finish(output.slice(start + PATH_START.length + 1, end).trim())
    }
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk, true))
    child.stderr?.on('data', (chunk: Buffer) => consume(chunk, false))
    child.once('error', () => finish())
    child.once('close', () => finish())
  })
}
