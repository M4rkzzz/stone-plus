import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedSingBoxRuntime } from '../../src/main/proxy/built-in/binary-manifest'
import {
  ElevatedSingBoxTunAdapter,
  ElevatedSingBoxTunError,
  STONE_WINDOWS_SIGNER_SUBJECT,
  STONE_WINDOWS_SIGNER_THUMBPRINT,
  buildElevatedTunSidecarConfig,
  isPackagedElectronApplication,
  validatePackagedStoneHostSignature,
  type TunSidecarFileSystem
} from '../../src/main/proxy/built-in/tun-sidecar-adapter'
import {
  TunElevationDeniedError,
  createTunBypassPlan
} from '../../src/main/proxy/built-in/tun-controller'
import type {
  PlatformCommandRequest,
  TemporaryElevatedProcessHandle,
  TemporaryElevatedProcessRecoveryRequest,
  TemporaryElevatedProcessRequest,
  TemporaryElevationProcessRunner
} from '../../src/main/proxy/built-in/platform-adapters'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('elevated sing-box TUN sidecar configuration', () => {
  it('keeps the elevation signer trust anchor synchronized with project identity', async () => {
    const identity = JSON.parse(await readFile(join(process.cwd(), 'PROJECT_IDENTITY.json'), 'utf8'))
    expect(STONE_WINDOWS_SIGNER_THUMBPRINT).toBe(identity.signing.windowsAuthenticode.sha1Thumbprint)
  })

  it('accepts the exact self-signed packaged host only for an untrusted-root UnknownError', () => {
    const executablePath = 'C:\\Users\\test user\\AppData\\Local\\Programs\\stone-desktop\\Stone+.exe'
    const untrustedRoot = {
      Status: 1,
      StatusMessage: 'A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider',
      Path: executablePath,
      Subject: STONE_WINDOWS_SIGNER_SUBJECT,
      Thumbprint: STONE_WINDOWS_SIGNER_THUMBPRINT,
    }

    expect(validatePackagedStoneHostSignature(executablePath, untrustedRoot)).toBeNull()
    expect(validatePackagedStoneHostSignature(executablePath, {
      ...untrustedRoot,
      StatusMessage: 'An unknown signature verification error occurred.',
    })).toContain('verification failed')
    expect(validatePackagedStoneHostSignature(executablePath, {
      ...untrustedRoot,
      Status: 4,
      StatusMessage: 'Not trusted.',
    })).toContain('verification failed')
  })

  it('rejects the self-signed host when its exact path, subject, or thumbprint differs', () => {
    const executablePath = 'C:\\Program Files\\Stone+\\Stone+.exe'
    const signature = {
      Status: 0,
      Path: executablePath,
      Subject: STONE_WINDOWS_SIGNER_SUBJECT,
      Thumbprint: STONE_WINDOWS_SIGNER_THUMBPRINT,
    }

    expect(validatePackagedStoneHostSignature(executablePath, { ...signature, Path: '' }))
      .toContain('did not return the inspected file path')
    expect(validatePackagedStoneHostSignature(executablePath, { ...signature, Path: 'C:\\Temp\\Stone+.exe' }))
      .toContain('different file path')
    expect(validatePackagedStoneHostSignature(executablePath, {
      ...signature,
      Subject: 'CN=StonePlus Open Source Release, O=Unrelated Publisher',
    })).toContain('verification failed')
    expect(validatePackagedStoneHostSignature(executablePath, {
      ...signature,
      Thumbprint: '0000000000000000000000000000000000000000',
    })).toContain('verification failed')
  })

  it('distinguishes plain Node, Electron dev/defaultApp, and an asar packaged application', () => {
    expect(isPackagedElectronApplication({ versions: {}, resourcesPath: 'C:\\Stone\\resources' }, () => true)).toBe(false)
    expect(isPackagedElectronApplication({
      versions: { electron: '39.0.0' },
      defaultApp: true,
      resourcesPath: 'C:\\Stone\\resources',
    }, () => true)).toBe(false)
    expect(isPackagedElectronApplication({
      versions: { electron: '39.0.0' },
      defaultApp: false,
      resourcesPath: 'C:\\Stone\\resources',
    }, (path) => path.endsWith('app.asar'))).toBe(true)
    expect(isPackagedElectronApplication({
      versions: { electron: '39.0.0' },
      defaultApp: false,
      resourcesPath: 'C:\\Stone\\resources',
    }, () => false)).toBe(false)
  })

  it('routes default traffic through loopback mixed while directly excluding every self-routing edge', () => {
    const bypass = sidecarBypass()
    const config = buildElevatedTunSidecarConfig({
      bypass,
      executablePath: 'C:\\Stone\\runtime\\sing-box.exe',
      executableName: 'sing-box.exe'
    }) as SidecarConfig

    expect(config.inbounds).toEqual([expect.objectContaining({
      type: 'tun',
      tag: 'stone-tun-in',
      auto_route: true,
      strict_route: true,
      stack: 'mixed',
      address: ['172.30.255.1/30', 'fdfe:dcba:9876::1/126']
    })])
    expect(config.inbounds[0].route_exclude_address).toEqual(expect.arrayContaining([
      '127.0.0.0/8',
      '::1/128',
      '10.77.0.0/16',
      '203.0.113.9/32',
      '1.1.1.1/32'
    ]))
    expect(config.outbounds).toEqual([
      {
        type: 'socks',
        tag: 'stone-tun-upstream-mixed',
        server: '127.0.0.1',
        server_port: 20800,
        version: '5'
      },
      { type: 'direct', tag: 'stone-tun-direct' }
    ])
    expect(config.route.final).toBe('stone-tun-upstream-mixed')
    expect(config.route.auto_detect_interface).toBe(true)
    expect(config.route.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        process_path: ['C:\\Stone\\runtime\\sing-box.exe'],
        process_name: ['sing-box.exe'],
        outbound: 'stone-tun-direct'
      }),
      expect.objectContaining({
        ip_cidr: expect.arrayContaining(['10.77.0.0/16', '203.0.113.9/32', '1.1.1.1/32']),
        outbound: 'stone-tun-direct'
      }),
      expect.objectContaining({
        domain: expect.arrayContaining(['edge.example', 'dns.example']),
        outbound: 'stone-tun-direct'
      })
    ]))
    expect(JSON.stringify(config)).not.toMatch(/install|create-service|systemctl/i)
  })

  it('rejects a non-loopback mixed upstream instead of creating a recursive TUN', () => {
    const bypass = sidecarBypass()
    const mixed = bypass.excludedEndpoints.find((endpoint) => endpoint.role === 'mixed')!
    mixed.host = '192.0.2.20'
    expect(() => buildElevatedTunSidecarConfig({
      bypass,
      executablePath: '/opt/stone/sing-box'
    })).toThrowError(expect.objectContaining({ code: 'tun_config_invalid' }))
  })
})

describe('ElevatedSingBoxTunAdapter lifecycle', () => {
  it('writes a pending ownership journal before starting the elevated process', async () => {
    const directory = await temporaryDirectory()
    const recoveryPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'active-sidecar.json')
    const pendingRecoveryPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'pending-sidecar.json')
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => {
      const pending = JSON.parse(await readFile(pendingRecoveryPath, 'utf8'))
      expect(pending).toMatchObject({ version: 2, phase: 'pending' })
      expect(pending).not.toHaveProperty('pid')
      return { id: 'journal-first', pid: 9301, stop }
    })
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'runtime'),
      platform: 'win32',
      verifyRuntime: async () => verifiedRuntime(directory, 'win32'),
      commandRunner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      processRunner: { start, recover: vi.fn(async () => undefined) },
      randomId: () => 'journal-first-session',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })

    const session = await adapter.startTemporaryElevated({ bypass: sidecarBypass() })
    expect(JSON.parse(await readFile(recoveryPath, 'utf8'))).toMatchObject({
      version: 2,
      phase: 'active',
      pid: 9301
    })
    await adapter.stopTemporary(session)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('recovers and stops an authenticated sidecar journal left by a prior main process', async () => {
    const directory = await temporaryDirectory()
    const runner = new FakeProcessRunner()
    const first = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'runtime'),
      platform: 'win32',
      verifyRuntime: async () => verifiedRuntime(directory, 'win32'),
      commandRunner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }),
      processRunner: runner,
      randomId: () => 'crash-recovery-session',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })
    const session = await first.startTemporaryElevated({ bypass: sidecarBypass() })
    const recoveredStop = vi.fn(async () => undefined)
    runner.recoveryHandle = { id: 'recovered', pid: session.pid, stop: recoveredStop }

    const restarted = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'runtime'),
      platform: 'win32',
      verifyRuntime: async () => verifiedRuntime(directory, 'win32'),
      commandRunner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }),
      processRunner: runner,
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })
    await restarted.cleanupPending()

    expect(runner.recover).toHaveBeenCalledWith(expect.objectContaining({
      pid: session.pid,
      launcher: 'windows-uac',
      args: ['run', '-c', expect.stringContaining('sidecar-crash-recovery-session.json')]
    }))
    expect(recoveredStop).toHaveBeenCalledOnce()
    await expect(readFile(join(directory, 'built-in-proxy', 'tun-sidecar', 'active-sidecar.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies runtime, atomically writes mode-0600 config, checks it, elevates it, and cleans up on stop', async () => {
    const directory = await temporaryDirectory()
    const runtime = verifiedRuntime(directory, 'win32')
    const verifyRuntime = vi.fn(async () => runtime)
    const commands: PlatformCommandRequest[] = []
    const processRunner = new FakeProcessRunner()
    const writes: Array<{ path: string; mode: number; flag: string }> = []
    const fileSystem = observingFileSystem(writes)
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      manifestPath: join(directory, 'bundled', 'runtime-manifest.json'),
      platform: 'win32',
      architecture: 'x64',
      environment: { PATH: 'C:\\Windows\\System32' },
      verifyRuntime,
      commandRunner: async (request) => { commands.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
      processRunner,
      fileSystem,
      randomId: () => 'fixed-session-id',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })

    const session = await adapter.startTemporaryElevated({ bypass: sidecarBypass() })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-fixed-session-id.json')
    expect(verifyRuntime).toHaveBeenCalledWith({
      runtimeRoot: join(directory, 'bundled'),
      manifestPath: join(directory, 'bundled', 'runtime-manifest.json'),
      platform: 'win32',
      architecture: 'x64'
    })
    expect(writes).toEqual([{ path: `${configPath}.tmp`, mode: 0o600, flag: 'wx' }])
    expect(commands.filter((command) => command.operation === 'tun.sidecar.check')).toEqual([expect.objectContaining({
      file: runtime.executablePath,
      args: ['check', '-c', configPath],
      cwd: runtime.runtimePath,
      operation: 'tun.sidecar.check'
    })])
    const protectConfigCommand = commands.find((command) => (
      command.operation === 'tun.windows.protect-config-directory'
    ))
    expect(protectConfigCommand).toMatchObject({
      file: 'powershell.exe',
      env: {
        STONE_BUILT_IN_PROXY_TUN_ACL_TARGET: join(directory, 'built-in-proxy', 'tun-sidecar'),
      },
    })
    expect(protectConfigCommand?.args).not.toContain(join(directory, 'built-in-proxy', 'tun-sidecar'))
    expect(processRunner.requests).toEqual([expect.objectContaining({
      launcher: 'windows-uac',
      executablePath: runtime.executablePath,
      args: ['run', '-c', configPath],
      cwd: runtime.runtimePath,
      env: expect.objectContaining({
        PATH: `${runtime.runtimePath};C:\\Windows\\System32`
      })
    })])
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      inbounds: [{ type: 'tun', auto_route: true, strict_route: true }],
      route: { final: 'stone-tun-upstream-mixed' }
    })
    expect(JSON.parse(await readFile(configPath, 'utf8')).inbounds[0].route_exclude_address)
      .toEqual(expect.arrayContaining(['198.51.100.44/32', '9.9.9.9/32']))
    expect(session).toEqual({ id: 'elevated-1', pid: 9101 })

    await adapter.stopTemporary(session)
    expect(processRunner.stop).toHaveBeenCalledOnce()
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the protected config when elevation is declined and preserves the denial category', async () => {
    const directory = await temporaryDirectory()
    const runtime = verifiedRuntime(directory, 'linux')
    const processRunner = new FakeProcessRunner()
    processRunner.startError = new TunElevationDeniedError('pkexec dialog dismissed')
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'linux',
      architecture: 'x64',
      verifyRuntime: async () => runtime,
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      processRunner,
      randomId: () => 'declined-session',
      resolveHost: resolveTestHost
    })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-declined-session.json')

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toBeInstanceOf(TunElevationDeniedError)
    expect(adapter.isElevationDenied(processRunner.startError)).toBe(true)
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(processRunner.requests[0].launcher).toBe('linux-pkexec')
  })

  it('retains both handle and config after stop failure so cleanup can be retried', async () => {
    const directory = await temporaryDirectory()
    const runtime = verifiedRuntime(directory, 'darwin')
    const processRunner = new FakeProcessRunner()
    processRunner.stop.mockRejectedValueOnce(new Error('sudo process still owns utun'))
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'darwin',
      architecture: 'arm64',
      verifyRuntime: async () => runtime,
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      processRunner,
      randomId: () => 'retry-stop-session',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })
    const session = await adapter.startTemporaryElevated({ bypass: sidecarBypass() })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-retry-stop-session.json')
    const activeJournal = join(directory, 'built-in-proxy', 'tun-sidecar', 'active-sidecar.json')
    const pendingJournal = join(directory, 'built-in-proxy', 'tun-sidecar', 'pending-sidecar.json')

    await expect(adapter.stopTemporary(session)).rejects.toMatchObject({ code: 'tun_cleanup_failed' })
    await expect(readFile(configPath, 'utf8')).resolves.toContain('stone-tun-in')
    await expect(readFile(activeJournal, 'utf8')).resolves.toContain('"phase":"active"')
    await expect(readFile(pendingJournal, 'utf8')).resolves.toContain('"phase":"pending"')
    await expect(adapter.stopTemporary(session)).resolves.toBeUndefined()
    expect(processRunner.stop).toHaveBeenCalledTimes(2)
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an elevated process that exits before the authenticated health gate', async () => {
    const directory = await temporaryDirectory()
    const stop = vi.fn(async () => undefined)
    const processRunner: TemporaryElevationProcessRunner = {
      start: vi.fn(async () => ({
        id: 'early-exit-sidecar',
        pid: 9191,
        exit: Promise.resolve({ code: 1, signal: null }),
        stop,
      })),
    }
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'linux',
      architecture: 'x64',
      verifyRuntime: async () => verifiedRuntime(directory, 'linux'),
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      processRunner,
      randomId: () => 'early-exit-session',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch,
    })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-early-exit-session.json')

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toMatchObject({ code: 'tun_start_failed' })
    expect(stop).toHaveBeenCalledOnce()
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a late native authorization refusal through the health gate', async () => {
    const directory = await temporaryDirectory()
    const stop = vi.fn(async () => undefined)
    const processRunner: TemporaryElevationProcessRunner = {
      start: vi.fn(async () => ({
        id: 'late-denial-sidecar',
        pid: 9193,
        exit: Promise.resolve({
          code: 1,
          signal: null,
          stderr: 'sudo: no password was provided'
        }),
        stop
      }))
    }
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'darwin',
      architecture: 'arm64',
      verifyRuntime: async () => verifiedRuntime(directory, 'darwin'),
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      processRunner,
      randomId: () => 'late-denial-session',
      resolveHost: resolveTestHost,
      fetchImplementation: healthyTunFetch
    })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-late-denial-session.json')

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toBeInstanceOf(TunElevationDeniedError)
    expect(stop).toHaveBeenCalledOnce()
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains an unreturned sidecar when cleanup fails and removes it on a later cleanup retry', async () => {
    const directory = await temporaryDirectory()
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('elevated process is still alive'))
      .mockResolvedValueOnce(undefined)
    const processRunner: TemporaryElevationProcessRunner = {
      start: vi.fn(async () => ({ id: '', pid: 9192, stop })),
    }
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'linux',
      architecture: 'x64',
      verifyRuntime: async () => verifiedRuntime(directory, 'linux'),
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      processRunner,
      randomId: () => 'pending-cleanup-session',
      resolveHost: resolveTestHost,
    })
    const configPath = join(directory, 'built-in-proxy', 'tun-sidecar', 'sidecar-pending-cleanup-session.json')

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toMatchObject({ code: 'tun_cleanup_failed' })
    await expect(readFile(configPath, 'utf8')).resolves.toContain('stone-tun-in')
    await expect(adapter.cleanupPending()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(2)
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not write or elevate anything when runtime integrity verification fails', async () => {
    const directory = await temporaryDirectory()
    const processRunner = new FakeProcessRunner()
    const fileSystem = observingFileSystem([])
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'linux',
      architecture: 'x64',
      verifyRuntime: async () => { throw new Error('sha256 mismatch') },
      processRunner,
      fileSystem,
      resolveHost: resolveTestHost
    })

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toBeInstanceOf(ElevatedSingBoxTunError)
    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toMatchObject({ code: 'tun_runtime_invalid' })
    expect(fileSystem.mkdir).not.toHaveBeenCalled()
    expect(processRunner.requests).toHaveLength(0)
  })

  it('fails closed before writing config when a node bypass address cannot be resolved', async () => {
    const directory = await temporaryDirectory()
    const processRunner = new FakeProcessRunner()
    const fileSystem = observingFileSystem([])
    const adapter = new ElevatedSingBoxTunAdapter({
      userDataPath: directory,
      runtimeRoot: join(directory, 'bundled'),
      platform: 'linux',
      architecture: 'x64',
      verifyRuntime: async () => verifiedRuntime(directory, 'linux'),
      processRunner,
      fileSystem,
      resolveHost: async () => { throw new Error('DNS unavailable') }
    })

    await expect(adapter.startTemporaryElevated({ bypass: sidecarBypass() }))
      .rejects.toMatchObject({ code: 'tun_config_invalid' })
    expect(fileSystem.mkdir).not.toHaveBeenCalled()
    expect(processRunner.requests).toHaveLength(0)
  })
})

interface SidecarConfig {
  inbounds: Array<{
    type: string
    tag: string
    address: string[]
    auto_route: boolean
    strict_route: boolean
    route_exclude_address: string[]
    stack: string
  }>
  outbounds: Array<Record<string, unknown>>
  route: {
    auto_detect_interface: boolean
    rules: Array<Record<string, unknown>>
    final: string
  }
}

class FakeProcessRunner implements TemporaryElevationProcessRunner {
  public readonly requests: TemporaryElevatedProcessRequest[] = []
  public startError?: unknown
  public readonly stop = vi.fn(async () => undefined)
  public readonly recover = vi.fn(async (_request: TemporaryElevatedProcessRecoveryRequest) => this.recoveryHandle)
  public recoveryHandle?: TemporaryElevatedProcessHandle

  public async start(request: TemporaryElevatedProcessRequest): Promise<TemporaryElevatedProcessHandle> {
    this.requests.push({ ...request, args: [...request.args] })
    if (this.startError) throw this.startError
    return {
      id: `elevated-${this.requests.length}`,
      pid: 9100 + this.requests.length,
      stop: this.stop
    }
  }
}

const healthyTunFetch = vi.fn(async () => new Response(
  JSON.stringify({ version: 'sing-box 1.13.14' }),
  { status: 200, headers: { 'content-type': 'application/json' } }
)) as unknown as typeof fetch

function sidecarBypass() {
  return createTunBypassPlan({
    localGateway: { host: '127.0.0.1', port: 15721, transport: 'tcp' },
    mixed: { host: '127.0.0.1', port: 20800, transport: 'any' },
    controller: { host: '127.0.0.1', port: 20801, transport: 'tcp' },
    singBoxProcessId: 8801,
    nodeServers: [
      { host: 'edge.example', port: 443, transport: 'tcp' },
      { host: '203.0.113.9', port: 8443, transport: 'udp' }
    ],
    dnsUpstreams: [
      { host: 'dns.example', port: 853, transport: 'tcp' },
      { host: '1.1.1.1', port: 53, transport: 'udp' }
    ],
    additionalExcludedCidrs: ['10.77.0.0/16']
  })
}

function verifiedRuntime(directory: string, platform: 'win32' | 'linux' | 'darwin'): VerifiedSingBoxRuntime {
  const executable = platform === 'win32' ? 'sing-box.exe' : 'sing-box'
  const runtimePath = join(directory, 'bundled', platform)
  return {
    target: platform === 'win32' ? 'win-x64' : platform === 'darwin' ? 'mac-arm64' : 'linux-x64',
    runtimeDirectory: platform,
    executable,
    ...(platform === 'darwin' ? {} : {
      cronetLibrary: platform === 'win32' ? 'libcronet.dll' : 'libcronet.so'
    }),
    version: '1.13.14',
    runtimePath,
    executablePath: join(runtimePath, executable),
    ...(platform === 'darwin' ? {} : {
      cronetLibraryPath: join(runtimePath, platform === 'win32' ? 'libcronet.dll' : 'libcronet.so')
    }),
    files: []
  }
}

function observingFileSystem(
  writes: Array<{ path: string; mode: number; flag: string }>
): TunSidecarFileSystem & { mkdir: ReturnType<typeof vi.fn> } {
  return {
    mkdir: vi.fn((path: string, options: { recursive: true; mode: number }) => mkdir(path, options)),
    writeFile: vi.fn((path: string, content: string, options: { encoding: 'utf8'; flag: 'wx'; mode: number }) => {
      writes.push({ path, mode: options.mode, flag: options.flag })
      return writeFile(path, content, options)
    }),
    rename: vi.fn((source: string, destination: string) => rename(source, destination)),
    rm: vi.fn((path: string, options: { force: true }) => rm(path, options))
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stone-tun-sidecar-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function resolveTestHost(host: string): Promise<readonly string[]> {
  if (host === 'edge.example') return ['198.51.100.44']
  if (host === 'dns.example') return ['9.9.9.9']
  throw new Error(`Unexpected host ${host}`)
}
