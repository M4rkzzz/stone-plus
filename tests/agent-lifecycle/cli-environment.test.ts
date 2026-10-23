import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createCliEnvironmentResolver, readLoginShellPath } from '../../src/main/agent-lifecycle/cli-environment'
import { NativeAgentInstallerProcessPort } from '../../src/main/agent-installation/agent-installation-service'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function shellProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined,
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

describe('CLI runtime environment', () => {
  it('does not probe shells or alter Windows PATH', async () => {
    const reader = vi.fn()
    const resolve = createCliEnvironmentResolver(reader)
    const env = { Path: 'C:\\node;C:\\Windows', KEEP: 'yes' }
    expect(await resolve(env, 'win32')).toEqual(env)
    expect(reader).not.toHaveBeenCalled()
  })

  it('merges login PATH without importing credentials, duplicates or relative directories', async () => {
    const resolve = createCliEnvironmentResolver(async () => '/Users/a/.nvm/versions/node/v22/bin:/usr/bin::.:relative:/bad\nvalue')
    const env = { PATH: '/custom/bin:/usr/bin', HOME: '/Users/a', OPENAI_API_KEY: 'current' }
    const result = await resolve(env, 'darwin')
    expect(result.PATH?.split(':')).toEqual([
      '/custom/bin', '/usr/bin', '/Users/a/.nvm/versions/node/v22/bin',
      '/Users/a/.local/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin', '/usr/sbin', '/sbin',
    ])
    expect(result.OPENAI_API_KEY).toBe('current')
    expect(env.PATH).toBe('/custom/bin:/usr/bin')
  })

  it('shares concurrent probes but reads credentials afresh and expires the cache', async () => {
    let now = 0
    const reader = vi.fn(async () => '/opt/node/bin')
    const resolve = createCliEnvironmentResolver(reader, () => now)
    const base = { PATH: '/usr/bin', HOME: '/Users/a' }
    const [one, two] = await Promise.all([
      resolve({ ...base, TOKEN: 'one' }, 'darwin'), resolve({ ...base, TOKEN: 'two' }, 'darwin'),
    ])
    expect(reader).toHaveBeenCalledTimes(1)
    expect(one.TOKEN).toBe('one')
    expect(two.TOKEN).toBe('two')
    now = 60_001
    await resolve(base, 'darwin')
    expect(reader).toHaveBeenCalledTimes(2)
    await resolve({ ...base, HOME: '/Users/b' }, 'darwin')
    await resolve({ ...base, PATH: '/other/bin' }, 'darwin')
    expect(reader).toHaveBeenCalledTimes(4)
  })

  it('falls back on shell errors and retries failed probes after five seconds', async () => {
    let now = 0
    const reader = vi.fn(async () => { throw new Error('shell unavailable') })
    const resolve = createCliEnvironmentResolver(reader, () => now)
    const env = { HOME: '/home/a', PATH: '/custom/bin' }
    expect((await resolve(env, 'linux')).PATH).toBe('/custom/bin:/home/a/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    await resolve(env, 'linux')
    expect(reader).toHaveBeenCalledTimes(1)
    now = 5_001
    await resolve(env, 'linux')
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('extracts only framed PATH, including split multibyte paths, from a noisy shell', async () => {
    const child = shellProcess()
    const pending = readLoginShellPath({ HOME: '/Users/a', SHELL: '/bin/zsh' }, 'darwin')
    const bytes = Buffer.from('welcome\nTOKEN=do-not-import\n__STONE_CLI_PATH_START__\n/Users/用户/bin:/usr/bin\n\n__STONE_CLI_PATH_END__\n')
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
    expect(await pending).toBe('/Users/用户/bin:/usr/bin')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('/usr/bin/printenv PATH')], expect.objectContaining({
      cwd: '/Users/a', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    expect(child.stdout.destroyed).toBe(true)
  })

  it('has a hard deadline even if the shell never closes its pipes', async () => {
    vi.useFakeTimers()
    const child = shellProcess()
    const pending = readLoginShellPath({ HOME: '/Users/a' }, 'darwin')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toBeUndefined()
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
  })

  it.each(['stdout', 'stderr'] as const)('bounds %s output', async (stream) => {
    const child = shellProcess()
    const pending = readLoginShellPath({}, 'linux')
    child[stream].write(Buffer.alloc(65_537, 'a'))
    expect(await pending).toBeUndefined()
  })

  it('handles a missing shell without surfacing an unrelated Agent failure', async () => {
    const child = shellProcess()
    const pending = readLoginShellPath({}, 'darwin')
    child.emit('error', new Error('ENOENT'))
    expect(await pending).toBeUndefined()
  })

  it('uses the resolved environment for installer subprocesses', async () => {
    const child = shellProcess()
    const resolveEnvironment = vi.fn(async (env: NodeJS.ProcessEnv) => ({ ...env, PATH: '/opt/node/bin:/usr/bin' }))
    const port = new NativeAgentInstallerProcessPort('darwin', { PATH: '/usr/bin', KEEP: 'yes' }, resolveEnvironment)
    const pending = port.execute('node', ['--version'], { timeoutMs: 1_000 })
    await Promise.resolve()
    child.stdout.write('v22.20.0')
    child.emit('close', 0, null)
    expect(await pending).toEqual({ stdout: 'v22.20.0', stderr: '' })
    expect(spawn).toHaveBeenCalledWith('node', ['--version'], expect.objectContaining({
      env: { PATH: '/opt/node/bin:/usr/bin', KEEP: 'yes' }, shell: false,
    }))
  })
})
