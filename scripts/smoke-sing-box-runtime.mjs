import { execFile as execFileCallback, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { verifyRuntimeTarget } from './verify-sing-box-runtime.mjs'

const execFile = promisify(execFileCallback)
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultManifestRoot = path.join(repositoryRoot, 'build', 'sing-box')

function readOption(args, optionName) {
  const index = args.indexOf(optionName)
  if (index === -1) return undefined
  if (!args[index + 1]) throw new Error(`${optionName} requires a value.`)
  return args[index + 1]
}

function runtimeEnvironment(runtimePath) {
  const environment = { ...process.env }
  const append = (name) => {
    environment[name] = environment[name]
      ? `${runtimePath}${path.delimiter}${environment[name]}`
      : runtimePath
  }
  append('PATH')
  if (process.platform === 'linux') append('LD_LIBRARY_PATH')
  if (process.platform === 'darwin') append('DYLD_LIBRARY_PATH')
  return environment
}

async function freeLoopbackPort() {
  const server = createServer()
  server.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a loopback port.')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function probeLoopbackPort(port, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (error) => {
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => finish(new Error(`Port ${port} probe timed out.`)))
    socket.once('connect', () => finish())
    socket.once('error', finish)
  })
}

async function waitForPorts(child, ports, shouldBeOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (shouldBeOpen && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`sing-box exited before its loopback listeners became ready (${child.exitCode ?? child.signalCode}).`)
    }
    const results = await Promise.allSettled(ports.map((port) => probeLoopbackPort(port)))
    const matches = shouldBeOpen
      ? results.every((result) => result.status === 'fulfilled')
      : results.every((result) => result.status === 'rejected')
    if (matches) return
    lastError = results.find((result) => result.status === 'rejected')?.reason
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`sing-box loopback listeners did not become ${shouldBeOpen ? 'ready' : 'closed'} in time.`, {
    cause: lastError,
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 5_000)) return

  if (process.platform === 'win32' && child.pid) {
    await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
  if (!await waitForExit(child, 5_000)) throw new Error('sing-box did not exit after forced termination.')
}

async function main() {
  const args = process.argv.slice(2)
  const targetName = readOption(args, '--target')
  const runtimeRoot = readOption(args, '--runtime-root')
  const selectedManifestRoot = path.resolve(readOption(args, '--manifest-root') ?? defaultManifestRoot)
  if (!targetName || !runtimeRoot) throw new Error('--target and --runtime-root are required.')

  const verified = await verifyRuntimeTarget(targetName, {
    runtimeRoot,
    manifestRoot: selectedManifestRoot,
    requireExecutable: true,
  })
  const manifest = JSON.parse(await readFile(path.join(selectedManifestRoot, 'runtime-manifest.json'), 'utf8'))
  const target = manifest.targets?.[targetName]
  if (!target?.executable) throw new Error(`Missing executable metadata for ${targetName}.`)
  const executablePath = path.join(verified.runtimeRoot, target.executable)
  const environment = runtimeEnvironment(verified.runtimeRoot)

  const versionResult = await execFile(executablePath, ['version'], {
    cwd: verified.runtimeRoot,
    env: environment,
    timeout: 10_000,
    windowsHide: true,
  })
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
  if (!new RegExp(`\\bsing-box\\s+version\\s+${verified.version.replaceAll('.', '\\.')}(?:\\s|$)`, 'i').test(versionOutput)) {
    throw new Error(`Unexpected sing-box version output for ${targetName}.`)
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'stone-sing-box-smoke-'))
  const mixedPort = await freeLoopbackPort()
  let controllerPort = await freeLoopbackPort()
  while (controllerPort === mixedPort) controllerPort = await freeLoopbackPort()
  const configPath = path.join(temporaryRoot, 'config.json')
  const config = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{
      type: 'mixed',
      tag: 'stone-release-smoke-mixed',
      listen: '127.0.0.1',
      listen_port: mixedPort,
    }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${controllerPort}`,
        secret: 'stone-release-smoke-controller-key',
      },
    },
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  let child
  let output = ''
  try {
    await execFile(executablePath, ['check', '-c', configPath], {
      cwd: verified.runtimeRoot,
      env: environment,
      timeout: 15_000,
      windowsHide: true,
    })
    child = spawn(executablePath, ['run', '-c', configPath], {
      cwd: verified.runtimeRoot,
      env: environment,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        output = `${output}${chunk}`.slice(-8_000)
      })
    }
    await once(child, 'spawn')
    await waitForPorts(child, [mixedPort, controllerPort], true, 10_000)
    const pid = child.pid
    await terminateChild(child)
    await waitForPorts(child, [mixedPort, controllerPort], false, 5_000)
    if (pid) {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') alive = false
        else throw error
      }
      if (alive) throw new Error(`sing-box process ${pid} remained alive after shutdown.`)
    }
    process.stdout.write(`Smoke-tested sing-box ${verified.version} runtime: ${targetName}\n`)
  } catch (error) {
    if (output) process.stderr.write(`${output}\n`)
    throw error
  } finally {
    if (child) await terminateChild(child).catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
