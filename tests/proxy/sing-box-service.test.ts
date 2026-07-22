import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SING_BOX_VERSION,
  SingBoxManifestError,
  resolveSingBoxTarget,
  verifyBundledSingBoxRuntime,
  type SingBoxBinaryManifest,
  type VerifiedSingBoxRuntime
} from '../../src/main/proxy/built-in/binary-manifest'
import {
  SingBoxService,
  buildRuntimeConfiguration,
  type LoopbackPortLease,
  type SingBoxRuntimeEvent,
  type SingBoxServiceOptions
} from '../../src/main/proxy/built-in/sing-box-service'
import { terminateProcessTree } from '../../src/main/proxy/built-in/process-utils'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('sing-box binary manifest', () => {
  it('resolves only the five supported packaged targets', () => {
    expect(resolveSingBoxTarget('win32', 'x64')).toMatchObject({ target: 'win-x64', executable: 'sing-box.exe' })
    expect(resolveSingBoxTarget('linux', 'x64')).toMatchObject({ target: 'linux-x64', cronetLibrary: 'libcronet.so' })
    expect(resolveSingBoxTarget('linux', 'arm64')).toMatchObject({ target: 'linux-arm64' })
    expect(resolveSingBoxTarget('darwin', 'x64')).toEqual({
      target: 'mac-x64', runtimeDirectory: 'mac-x64', executable: 'sing-box'
    })
    expect(resolveSingBoxTarget('darwin', 'arm64')).toMatchObject({ target: 'mac-arm64' })
    expect(() => resolveSingBoxTarget('win32', 'arm64')).toThrow(/not bundled/)
  })

  it('verifies every declared file, the fixed version, and the complete runtime directory', async () => {
    const root = await temporaryDirectory()
    const runtime = join(root, 'win-x64')
    await mkdir(runtime, { recursive: true })
    const executable = Buffer.from('verified sing-box executable')
    const cronet = Buffer.from('verified cronet library')
    await writeFile(join(runtime, 'sing-box.exe'), executable)
    await writeFile(join(runtime, 'libcronet.dll'), cronet)
    await writeManifest(root, executable, cronet)

    const result = await verifyBundledSingBoxRuntime({
      runtimeRoot: root,
      platform: 'win32',
      architecture: 'x64'
    })
    expect(result).toMatchObject({
      version: SING_BOX_VERSION,
      target: 'win-x64',
      runtimePath: runtime,
      executablePath: join(runtime, 'sing-box.exe'),
      cronetLibraryPath: join(runtime, 'libcronet.dll')
    })
    expect(result.files).toHaveLength(2)

    await writeFile(join(runtime, 'unlisted.dll'), 'native injection')
    await expect(verifyBundledSingBoxRuntime({
      runtimeRoot: root,
      platform: 'win32',
      architecture: 'x64'
    })).rejects.toMatchObject({ code: 'runtime_incomplete' })
  })

  it('rejects a tampered runtime before returning an executable path', async () => {
    const root = await temporaryDirectory()
    const runtime = join(root, 'win-x64')
    await mkdir(runtime, { recursive: true })
    const executable = Buffer.from('original executable')
    const cronet = Buffer.from('original cronet')
    await writeFile(join(runtime, 'sing-box.exe'), executable)
    await writeFile(join(runtime, 'libcronet.dll'), cronet)
    await writeManifest(root, executable, cronet)
    await writeFile(join(runtime, 'sing-box.exe'), 'tampered executable')

    await expect(verifyBundledSingBoxRuntime({
      runtimeRoot: root,
      platform: 'win32',
      architecture: 'x64'
    })).rejects.toEqual(expect.objectContaining<SingBoxManifestError>({ code: 'runtime_untrusted' }))
  })
})

describe('SingBoxService', () => {
  it('checks the pinned binary and generated config before publishing healthy loopback endpoints', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory)
    const states: string[] = []
    harness.service.subscribe((state) => states.push(state.status))

    const state = await harness.service.start({
      config: {
        log: { level: 'warn' },
        inbounds: [{ type: 'tun', auto_route: true }],
        experimental: { clash_api: { external_controller: '0.0.0.0:9090', secret: 'attacker' } },
        outbounds: [{ type: 'direct', tag: 'direct' }]
      },
      mixedPort: 20_801,
      controllerPort: 20_802
    })

    expect(state).toMatchObject({
      desiredEnabled: true,
      status: 'ready',
      version: SING_BOX_VERSION,
      target: 'win-x64',
      mixedPort: 20_801,
      mixedEndpoint: 'http://127.0.0.1:20801',
      controllerPort: 20_802,
      generation: 1,
      pid: 4_242
    })
    expect(states).toContain('starting')
    expect(harness.execute.mock.calls.map((call) => call[1])).toEqual([
      ['version'],
      ['check', '-c', join(directory, 'built-in-proxy', 'sing-box.runtime.json')]
    ])
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1)
    expect(harness.fetchImplementation).toHaveBeenCalledWith(
      'http://127.0.0.1:20802/version',
      expect.objectContaining({ redirect: 'error' })
    )
    const healthRequest = harness.fetchImplementation.mock.calls.find((call) => String(call[0]).endsWith('/version'))
    expect(new Headers(healthRequest?.[1]?.headers).get('authorization')).toBe(`Bearer ${'s'.repeat(43)}`)
    const written = JSON.parse(await readFile(join(directory, 'built-in-proxy', 'sing-box.runtime.json'), 'utf8'))
    expect(written.inbounds).toEqual([{
      type: 'mixed',
      tag: 'stone-mixed-in',
      listen: '127.0.0.1',
      listen_port: 20_801
    }])
    expect(written.experimental).toEqual({
      clash_api: {
        external_controller: '127.0.0.1:20802',
        secret: 's'.repeat(43)
      }
    })
    expect(JSON.stringify(written)).not.toContain('attacker')

    await harness.service.stop()
    expect(harness.terminateProcess).toHaveBeenCalledWith(harness.children[0], 'win32')
    await expect(readFile(join(directory, 'built-in-proxy', 'sing-box.runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.service.getState()).toMatchObject({ desiredEnabled: false, status: 'idle' })
  })

  it('exposes only mixed to LAN while the controller and Stone endpoint remain on loopback', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory)
    const request = { config: { outbounds: [{ type: 'direct', tag: 'direct' }] }, mixedPort: 20_871, controllerPort: 20_872 }

    await harness.service.start(request)
    await harness.service.start({ ...request, allowLan: true })

    expect(harness.spawnProcess).toHaveBeenCalledTimes(2)
    expect(harness.reservePort).toHaveBeenNthCalledWith(1, 20_871, '127.0.0.1')
    expect(harness.reservePort).toHaveBeenNthCalledWith(2, 20_872, '127.0.0.1')
    expect(harness.reservePort).toHaveBeenNthCalledWith(3, 20_871, '0.0.0.0')
    expect(harness.reservePort).toHaveBeenNthCalledWith(4, 20_872, '127.0.0.1')
    const written = JSON.parse(await readFile(join(directory, 'built-in-proxy', 'sing-box.runtime.json'), 'utf8'))
    expect(written.inbounds).toEqual([expect.objectContaining({
      type: 'mixed',
      listen: '0.0.0.0',
      listen_port: 20_871
    })])
    expect(written.experimental.clash_api).toEqual({
      external_controller: '127.0.0.1:20872',
      secret: 's'.repeat(43)
    })
    expect(harness.service.getState()).toMatchObject({
      status: 'ready',
      mixedEndpoint: 'http://127.0.0.1:20871',
      controllerPort: 20_872,
      generation: 2
    })
    expect(harness.fetchImplementation.mock.calls.every((call) => String(call[0]).startsWith('http://127.0.0.1:'))).toBe(true)
    await harness.service.close()
  })

  it('rejects a mismatched executable version before check, spawn, or controller access', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory, {
      executeFile: vi.fn(async (_executable, args) => {
        if (args[0] === 'version') return { stdout: 'sing-box version 1.13.13', stderr: '' }
        return { stdout: '', stderr: '' }
      })
    })

    await expect(harness.service.start({ config: {}, mixedPort: 20_811, controllerPort: 20_812 }))
      .rejects.toMatchObject({ code: 'core_version' })
    expect(harness.spawnProcess).not.toHaveBeenCalled()
    expect(harness.reservePort).not.toHaveBeenCalled()
    expect(harness.fetchImplementation).not.toHaveBeenCalled()
    expect(harness.service.getState()).toMatchObject({
      desiredEnabled: true,
      status: 'error',
      error: { code: 'core_version' }
    })
  })

  it('classifies a reserved mixed-port conflict without probing an unknown local service', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory, {
      reservePort: vi.fn(async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) })
    })

    await expect(harness.service.start({ config: {}, mixedPort: 20_821, controllerPort: 20_822 }))
      .rejects.toMatchObject({ code: 'mixed_port' })
    expect(harness.spawnProcess).not.toHaveBeenCalled()
    expect(harness.fetchImplementation).not.toHaveBeenCalled()
    expect(harness.probeTcp).not.toHaveBeenCalled()
  })

  it('terminates an unhealthy child and never publishes ready', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory, {
      fetchImplementation: vi.fn(async () => { throw new Error('controller refused connection') }),
      healthTimeoutMs: 3,
      healthIntervalMs: 1,
      sleep: vi.fn(async () => undefined)
    })

    await expect(harness.service.start({ config: {}, mixedPort: 20_831, controllerPort: 20_832 }))
      .rejects.toMatchObject({ code: 'health_check' })
    expect(harness.terminateProcess).toHaveBeenCalledTimes(1)
    expect(harness.service.getState()).toMatchObject({ status: 'error', error: { code: 'health_check' } })
    expect(harness.service.getState().generation).toBe(0)
  })

  it('fails closed on a crash, emits the crash event, and performs a bounded restart', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory, { restartDelaysMs: [0] })
    const events: SingBoxRuntimeEvent[] = []
    harness.service.onEvent((event) => events.push(event))
    await harness.service.start({ config: {}, mixedPort: 20_841, controllerPort: 20_842 })

    harness.children[0].finish(7, null)
    expect(harness.service.getState()).toMatchObject({
      desiredEnabled: true,
      status: 'error',
      error: { code: 'unexpected_exit' }
    })
    expect(events.some((event) => event.type === 'crash')).toBe(true)

    await vi.waitFor(() => expect(harness.spawnProcess).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(harness.service.getState().status).toBe('ready'))
    expect(harness.service.getState()).toMatchObject({ generation: 2, restartAttempt: 1 })

    harness.children[1].finish(8, null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2)
    expect(harness.service.getState()).toMatchObject({ status: 'error', restartAttempt: 1 })
    await harness.service.stop()
  })

  it('exposes authenticated traffic, connections, close, refresh, and latency control calls', async () => {
    const directory = await temporaryDirectory()
    let now = 1_000
    const harness = createHarness(directory, { now: () => now })
    await harness.service.start({ config: {}, mixedPort: 20_851, controllerPort: 20_852 })

    const firstTraffic = await harness.service.getTraffic()
    expect(firstTraffic).toEqual({
      capturedAt: 1_000,
      uploadBytes: 1_024,
      downloadBytes: 4_096,
      uploadRateBytesPerSecond: 0,
      downloadRateBytesPerSecond: 0,
      activeConnections: 1,
      totalConnections: 1
    })
    now = 2_000
    harness.connectionPayload.uploadTotal = 2_048
    harness.connectionPayload.downloadTotal = 6_144
    expect(await harness.service.getTraffic()).toMatchObject({
      uploadRateBytesPerSecond: 1_024,
      downloadRateBytesPerSecond: 2_048
    })
    expect(await harness.service.getConnections()).toEqual([{
      id: 'connection-1',
      network: 'tcp',
      protocol: 'HTTP',
      source: '127.0.0.1:50123',
      destination: '203.0.113.8:443',
      outbound: 'selected-node',
      uploadBytes: 32,
      downloadBytes: 128,
      startedAt: Date.parse('2026-07-22T12:00:00.000Z')
    }])
    await harness.service.closeConnection('connection-1')
    await harness.service.refreshConnections()
    expect(await harness.service.testLatency('selected-node')).toEqual({
      proxyName: 'selected-node',
      delayMs: 37,
      testedAt: 2_000
    })
    expect(harness.requestedPaths).toContain('/connections/connection-1')
    expect(harness.requestedPaths).toContain('/connections')
    expect(harness.requestedPaths.some((path) => path.startsWith('/proxies/selected-node/delay?'))).toBe(true)
    await harness.service.close()
  })

  it('serializes duplicate starts and close leaves no managed child', async () => {
    const directory = await temporaryDirectory()
    const harness = createHarness(directory)
    const request = { config: {}, mixedPort: 20_861, controllerPort: 20_862 }
    const [first, second] = await Promise.all([harness.service.start(request), harness.service.start(request)])
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect(harness.spawnProcess).toHaveBeenCalledTimes(1)
    await harness.service.close()
    expect(harness.terminateProcess).toHaveBeenCalledTimes(1)
    expect(harness.children[0].exitCode).toBe(0)
    await expect(harness.service.start(request)).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('buildRuntimeConfiguration', () => {
  it('always owns loopback inbounds and the controller', () => {
    expect(buildRuntimeConfiguration({
      inbounds: [{ listen: '0.0.0.0' }],
      experimental: { clash_api: { secret: 'foreign' } },
      route: { final: 'proxy' }
    }, 10_800, 10_801, 'z'.repeat(43))).toEqual({
      route: { final: 'proxy' },
      inbounds: [{ type: 'mixed', tag: 'stone-mixed-in', listen: '127.0.0.1', listen_port: 10_800 }],
      experimental: {
        clash_api: { external_controller: '127.0.0.1:10801', secret: 'z'.repeat(43) }
      }
    })
  })

  it('changes only the mixed listen address when LAN access is enabled', () => {
    const config = buildRuntimeConfiguration({}, 10_800, 10_801, 'z'.repeat(43), true)
    expect(config.inbounds).toEqual([expect.objectContaining({ listen: '0.0.0.0' })])
    expect(config.experimental).toEqual({
      clash_api: { external_controller: '127.0.0.1:10801', secret: 'z'.repeat(43) }
    })
  })
})

describe('sing-box process cleanup', () => {
  it('uses Windows tree termination even when the root exits immediately', async () => {
    const child = new FakeChild(7_777)
    const execute = vi.fn(async (_file: string, args: readonly string[]) => {
      expect(args).toEqual(['/pid', '7777', '/t', '/f'])
      child.finish(0, null)
      return { stdout: '', stderr: '' }
    })
    await terminateProcessTree(child as unknown as ChildProcess, 'win32', execute)
    expect(execute).toHaveBeenCalledWith('taskkill.exe', ['/pid', '7777', '/t', '/f'], { timeoutMs: 5_000 })
  })
})

class FakeChild extends EventEmitter {
  public readonly pid: number
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  public killed = false
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()

  public constructor(pid: number) {
    super()
    this.pid = pid
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.finish(0, signal)
    return true
  }

  public finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

function createHarness(directory: string, overrides: Partial<SingBoxServiceOptions> = {}) {
  const children: FakeChild[] = []
  const requestedPaths: string[] = []
  const connectionPayload: Record<string, unknown> = {
    uploadTotal: 1_024,
    downloadTotal: 4_096,
    connections: [{
      id: 'connection-1',
      metadata: {
        network: 'tcp',
        type: 'HTTP',
        sourceIP: '127.0.0.1',
        sourcePort: '50123',
        destinationIP: '203.0.113.8',
        destinationPort: '443'
      },
      chains: ['selected-node', 'GLOBAL'],
      upload: 32,
      download: 128,
      start: '2026-07-22T12:00:00.000Z'
    }]
  }
  const verifiedRuntime: VerifiedSingBoxRuntime = {
    version: SING_BOX_VERSION,
    target: 'win-x64',
    runtimeDirectory: 'win-x64',
    executable: 'sing-box.exe',
    cronetLibrary: 'libcronet.dll',
    runtimePath: join(directory, 'runtime'),
    executablePath: join(directory, 'runtime', 'sing-box.exe'),
    cronetLibraryPath: join(directory, 'runtime', 'libcronet.dll'),
    files: []
  }
  const execute = vi.fn(async (_executable: string, args: readonly string[]) => args[0] === 'version'
    ? { stdout: `sing-box version ${SING_BOX_VERSION}`, stderr: '' }
    : { stdout: '', stderr: '' })
  const reservePort = vi.fn(async (requestedPort: number): Promise<LoopbackPortLease> => ({
    port: requestedPort || (20_900 + reservePort.mock.calls.length),
    release: vi.fn(async () => undefined)
  }))
  const spawnProcess = vi.fn((_executable: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeChild(4_242 + children.length)
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  })
  const terminateProcess = vi.fn(async (child: ChildProcess) => {
    ;(child as unknown as FakeChild).finish(0, 'SIGTERM')
  })
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    requestedPaths.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/version') return jsonResponse({ version: `sing-box ${SING_BOX_VERSION}` })
    if (url.pathname === '/connections' && (init?.method ?? 'GET') === 'GET') return jsonResponse(connectionPayload)
    if (url.pathname.includes('/delay')) return jsonResponse({ delay: 37 })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  const probeTcp = vi.fn(async () => undefined)

  const options: SingBoxServiceOptions = {
    userDataPath: directory,
    runtimeRoot: join(directory, 'bundled'),
    platform: 'win32',
    architecture: 'x64',
    verifyRuntime: vi.fn(async () => verifiedRuntime),
    executeFile: execute,
    spawnProcess,
    terminateProcess,
    reservePort,
    probeTcp,
    fetchImplementation,
    createSecret: () => 's'.repeat(43),
    healthTimeoutMs: 10,
    healthIntervalMs: 1,
    sleep: vi.fn(async () => undefined),
    ...overrides
  }
  const service = new SingBoxService(options)
  return {
    service,
    children,
    requestedPaths,
    connectionPayload,
    execute: options.executeFile as ReturnType<typeof vi.fn>,
    spawnProcess: options.spawnProcess as ReturnType<typeof vi.fn>,
    terminateProcess: options.terminateProcess as ReturnType<typeof vi.fn>,
    reservePort: options.reservePort as ReturnType<typeof vi.fn>,
    probeTcp: options.probeTcp as ReturnType<typeof vi.fn>,
    fetchImplementation: options.fetchImplementation as ReturnType<typeof vi.fn>
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stone-sing-box-test-'))
  temporaryDirectories.push(path)
  return path
}

async function writeManifest(root: string, executable: Buffer, cronet: Buffer): Promise<void> {
  const manifest: SingBoxBinaryManifest = {
    schemaVersion: 1,
    version: SING_BOX_VERSION,
    targets: {
      'win-x64': {
        runtimeDirectory: 'win-x64',
        executable: 'sing-box.exe',
        cronetLibrary: 'libcronet.dll',
        files: [
          { path: 'sing-box.exe', sha256: sha256(executable), size: executable.length },
          { path: 'libcronet.dll', sha256: sha256(cronet), size: cronet.length }
        ]
      }
    }
  }
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(manifest), 'utf8')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
