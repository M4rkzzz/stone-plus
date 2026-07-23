import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  GnomeSystemProxyPlatformAdapter,
  MacOsSystemProxyPlatformAdapter,
  NativeTemporaryElevationProcessRunner,
  SingBoxTemporaryTunPlatformAdapter,
  UnsupportedDesktopProxyError,
  WindowsSystemProxyPlatformAdapter,
  createSystemProxyPlatformAdapter,
  type PlatformCommandRequest,
  type PlatformCommandResult,
  type PlatformCommandRunner,
  type TemporaryElevatedProcessHandle,
  type TemporaryElevatedProcessRequest,
  type TemporaryElevationProcessRunner
} from '../../src/main/proxy/built-in/platform-adapters'
import { normalizeLeaseTarget } from '../../src/main/proxy/built-in/system-proxy-lease'
import { createTunBypassPlan } from '../../src/main/proxy/built-in/tun-controller'

const ok = (stdout = ''): PlatformCommandResult => ({ exitCode: 0, stdout, stderr: '' })

describe('real system-proxy platform adapters', () => {
  it('captures all WinINet values, writes mixed, refreshes WinINet, and restores only after an exact comparison', async () => {
    const native = windowsSettings({
      ProxyEnable: winValue('dword', 1),
      ProxyServer: winValue('string', 'http=corp.example:8080;https=secure.example:8443'),
      AutoConfigURL: winValue('string', 'https://pac.example/full/path/proxy.pac?profile=corp'),
      ProxyOverride: winValue('string', '<local>;*.corp.example;10.*'),
      AutoDetect: winValue('dword', 1),
      DefaultConnectionSettings: winValue('binary', Buffer.alloc(64, 7).toString('base64')),
      SavedLegacySettings: winValue('binary', Buffer.alloc(64, 9).toString('base64'))
    })
    let current = clone(native)
    const calls: PlatformCommandRequest[] = []
    const runner: PlatformCommandRunner = vi.fn(async (request) => {
      calls.push(request)
      if (request.operation === 'win32.system-proxy.capture') return ok(JSON.stringify(current))
      if (request.operation === 'win32.system-proxy.apply') {
        current = clone(request.payload) as typeof native
        return ok()
      }
      throw new Error(`Unexpected operation ${request.operation}`)
    })
    const adapter = new WindowsSystemProxyPlatformAdapter({ runner })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20800 }
    }))

    expect(mixed.settings.values).toMatchObject({
      ProxyEnable: { present: true, kind: 'dword', value: 1 },
      ProxyServer: { present: true, kind: 'string', value: '127.0.0.1:20800' },
      AutoConfigURL: { present: false, kind: 'string', value: null },
      ProxyOverride: {
        present: true,
        value: '<local>;localhost;127.*;[::1]'
      },
      AutoDetect: { present: true, kind: 'dword', value: 0 }
    })
    expect(typeof (mixed.settings.values as Record<string, { value?: unknown }>).DefaultConnectionSettings.value)
      .toBe('string')

    await adapter.applySnapshot(mixed)
    const applyCall = calls.find((call) => call.operation === 'win32.system-proxy.apply')
    expect(applyCall?.file).toBe('powershell.exe')
    expect(applyCall?.args.join(' ')).toContain('InternetSetOption')
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(current).toEqual(native)

    current.values.ProxyServer = winValue('string', 'user-changed.example:3128')
    await expect(adapter.compareAndApplySnapshot(original, mixed)).resolves.toBe('mismatch')
    expect(current.values.ProxyServer.value).toBe('user-changed.example:3128')
  })

  it('captures and restores every active macOS network service proxy field', async () => {
    const emulator = new MacNetworksetupEmulator()
    const adapter = new MacOsSystemProxyPlatformAdapter({ runner: emulator.run })
    const original = await adapter.captureSnapshot()
    expect(original.settings.services).toEqual([
      {
        name: 'Wi-Fi',
        disabled: false,
        web: { enabled: true, server: 'old-http.example', port: 8080 },
        secureWeb: { enabled: false, server: 'old-https.example', port: 8443 },
        socks: { enabled: true, server: 'old-socks.example', port: 1080 },
        pac: { enabled: true, url: 'https://pac.example/full/proxy.pac' },
        autoDiscovery: true,
        bypass: ['localhost', '*.internal.example']
      },
      { name: 'Disabled USB', disabled: true }
    ])

    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '::1', port: 20810 },
      additionalBypassRules: ['*.stone.internal']
    }))
    await adapter.applySnapshot(mixed)
    expect(emulator.service.web).toEqual({ enabled: true, server: '::1', port: 20810 })
    expect(emulator.service.secureWeb).toEqual({ enabled: true, server: '::1', port: 20810 })
    expect(emulator.service.socks).toEqual({ enabled: true, server: '::1', port: 20810 })
    expect(emulator.service.pac).toEqual({ enabled: false, url: '' })
    expect(emulator.service.autoDiscovery).toBe(false)
    expect(emulator.service.bypass).toContain('*.stone.internal')

    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(emulator.service).toEqual(MacNetworksetupEmulator.originalService())
    expect(emulator.calls.every((call) => call.file === '/usr/sbin/networksetup')).toBe(true)
  })

  it('round-trips raw GNOME GVariant values and reports unsupported desktops explicitly', async () => {
    const emulator = new GSettingsEmulator()
    const adapter = new GnomeSystemProxyPlatformAdapter({
      runner: emulator.run,
      desktopEnvironment: 'ubuntu:GNOME'
    })
    const original = await adapter.captureSnapshot()
    expect(original.settings.schemas).toMatchObject({
      'org.gnome.system.proxy': {
        mode: "'auto'",
        'autoconfig-url': "'https://pac.example/proxy.pac'",
        'ignore-hosts': "['localhost', '*.internal.example']"
      },
      'org.gnome.system.proxy.http': { host: "'old-http.example'", port: '8080' }
    })
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20820 }
    }))
    await adapter.applySnapshot(mixed)
    expect(emulator.values['org.gnome.system.proxy'].mode).toBe("'manual'")
    expect(emulator.values['org.gnome.system.proxy']['autoconfig-url']).toBe("''")
    expect(emulator.values['org.gnome.system.proxy.http']).toMatchObject({
      host: "'127.0.0.1'",
      port: '20820',
      'use-authentication': 'false'
    })
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(emulator.values).toEqual(GSettingsEmulator.originalValues())

    const noCommands = vi.fn<PlatformCommandRunner>()
    const unsupported = new GnomeSystemProxyPlatformAdapter({
      runner: noCommands,
      desktopEnvironment: 'KDE'
    })
    await expect(unsupported.captureSnapshot()).rejects.toBeInstanceOf(UnsupportedDesktopProxyError)
    expect(noCommands).not.toHaveBeenCalled()
  })

  it('constructs the platform implementation without probing or mutating the real OS', () => {
    const runner = vi.fn<PlatformCommandRunner>()
    expect(createSystemProxyPlatformAdapter({ platform: 'win32', runner }))
      .toBeInstanceOf(WindowsSystemProxyPlatformAdapter)
    expect(createSystemProxyPlatformAdapter({ platform: 'darwin', runner }))
      .toBeInstanceOf(MacOsSystemProxyPlatformAdapter)
    expect(createSystemProxyPlatformAdapter({ platform: 'linux', runner, desktopEnvironment: 'GNOME' }))
      .toBeInstanceOf(GnomeSystemProxyPlatformAdapter)
    expect(() => createSystemProxyPlatformAdapter({ platform: 'aix', runner }))
      .toThrow(UnsupportedDesktopProxyError)
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('temporary sing-box TUN elevation adapters', () => {
  it.each([
    ['win32', 'windows-uac'],
    ['darwin', 'macos-sudo'],
    ['linux', 'linux-pkexec']
  ] as const)('maps %s to one-shot %s elevation and retains a stoppable handle', async (platform, launcher) => {
    const processRunner = new FakeElevationProcessRunner()
    const adapter = new SingBoxTemporaryTunPlatformAdapter({
      platform,
      executablePath: platform === 'win32' ? 'C:\\Stone\\sing-box.exe' : '/opt/stone/sing-box',
      buildArguments: (bypass) => ['run', '-c', `/tmp/config-${bypass.excludedProcessIds[0]}.json`],
      processRunner
    })
    const bypass = tunBypass()

    const session = await adapter.startTemporaryElevated({ bypass })
    expect(processRunner.requests).toEqual([{
      launcher,
      executablePath: platform === 'win32' ? 'C:\\Stone\\sing-box.exe' : '/opt/stone/sing-box',
      args: ['run', '-c', '/tmp/config-5512.json']
    }])
    expect(JSON.stringify(processRunner.requests)).not.toMatch(/install|create-service|systemctl/i)
    await adapter.stopTemporary(session)
    expect(processRunner.stop).toHaveBeenCalledOnce()
  })

  it('uses UAC, sudo, and pkexec launch commands without installing a service', async () => {
    const windowsCommands: PlatformCommandRequest[] = []
    const windowsRunner = new NativeTemporaryElevationProcessRunner({
      commandRunner: async (request) => {
        windowsCommands.push(request)
        return request.operation === 'tun.windows-uac.start' ? ok('62001\n') : ok()
      }
    })
    const windows = await windowsRunner.start({
      launcher: 'windows-uac',
      executablePath: 'C:\\Stone\\sing-box.exe',
      args: ['run', '-c', 'C:\\Stone Data\\tun.json']
    })
    await windows.stop()
    expect(windowsCommands.map((command) => command.operation)).toEqual([
      'tun.windows-uac.start', 'tun.windows-uac.stop'
    ])
    expect(windowsCommands[0].args.join(' ')).toContain("Verb = 'RunAs'")

    for (const [launcher, executable] of [
      ['macos-sudo', '/Applications/Stone.app/Contents/Resources/sing-box'],
      ['linux-pkexec', '/opt/stone/sing-box']
    ] as const) {
      const child = new FakeChildProcess()
      const spawnMock = vi.fn(() => child as unknown as ReturnType<typeof spawn>)
      const runner = new NativeTemporaryElevationProcessRunner({
        spawnImplementation: spawnMock as unknown as typeof spawn,
        startupObservationMs: 0
      })
      const handle = await runner.start({ launcher, executablePath: executable, args: ['run', '-c', '/tmp/tun.json'] })
      if (launcher === 'macos-sudo') {
        expect(spawnMock).toHaveBeenCalledWith(
          'sudo', ['-A', '--', executable, 'run', '-c', '/tmp/tun.json'], expect.any(Object)
        )
      } else {
        expect(spawnMock).toHaveBeenCalledWith(
          'pkexec', [executable, 'run', '-c', '/tmp/tun.json'], expect.any(Object)
        )
      }
      await handle.stop()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    }
  })
})

function windowsSettings(values: Record<string, unknown>): Record<string, unknown> {
  return { adapter: 'stone-wininet-v1', values }
}

function winValue(kind: 'dword' | 'string' | 'binary', value: number | string): Record<string, unknown> {
  return { present: true, kind, value }
}

class MacNetworksetupEmulator {
  public static originalService(): MacServiceState {
    return {
      web: { enabled: true, server: 'old-http.example', port: 8080 },
      secureWeb: { enabled: false, server: 'old-https.example', port: 8443 },
      socks: { enabled: true, server: 'old-socks.example', port: 1080 },
      pac: { enabled: true, url: 'https://pac.example/full/proxy.pac' },
      autoDiscovery: true,
      bypass: ['localhost', '*.internal.example']
    }
  }

  public service = MacNetworksetupEmulator.originalService()
  public readonly calls: PlatformCommandRequest[] = []

  public readonly run: PlatformCommandRunner = vi.fn(async (request) => {
    this.calls.push(request)
    const [command, service, ...values] = request.args
    if (command === '-listallnetworkservices') {
      return ok('An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n* Disabled USB\n')
    }
    if (service !== 'Wi-Fi') throw new Error(`Unexpected service ${service}`)
    if (command === '-getwebproxy') return ok(manualProxyOutput(this.service.web))
    if (command === '-getsecurewebproxy') return ok(manualProxyOutput(this.service.secureWeb))
    if (command === '-getsocksfirewallproxy') return ok(manualProxyOutput(this.service.socks))
    if (command === '-getautoproxyurl') {
      return ok(`URL: ${this.service.pac.url}\nEnabled: ${this.service.pac.enabled ? 'Yes' : 'No'}\n`)
    }
    if (command === '-getproxyautodiscovery') {
      return ok(`Auto Proxy Discovery: ${this.service.autoDiscovery ? 'On' : 'Off'}\n`)
    }
    if (command === '-getproxybypassdomains') return ok(`${this.service.bypass.join('\n')}\n`)
    const manualMatch = /^-set(web|secureweb|socksfirewall)proxy$/.exec(command)
    if (manualMatch) {
      const key = manualMatch[1] === 'web' ? 'web' : manualMatch[1] === 'secureweb' ? 'secureWeb' : 'socks'
      this.service[key].server = values[0]
      this.service[key].port = Number(values[1])
      return ok()
    }
    const stateMatch = /^-set(web|secureweb|socksfirewall)proxystate$/.exec(command)
    if (stateMatch) {
      const key = stateMatch[1] === 'web' ? 'web' : stateMatch[1] === 'secureweb' ? 'secureWeb' : 'socks'
      this.service[key].enabled = values[0] === 'on'
      return ok()
    }
    if (command === '-setautoproxyurl') { this.service.pac.url = values[0]; return ok() }
    if (command === '-setautoproxystate') { this.service.pac.enabled = values[0] === 'on'; return ok() }
    if (command === '-setproxyautodiscovery') { this.service.autoDiscovery = values[0] === 'on'; return ok() }
    if (command === '-setproxybypassdomains') {
      this.service.bypass = values[0] === 'Empty' ? [] : [...values]
      return ok()
    }
    throw new Error(`Unexpected networksetup command ${command}`)
  })
}

interface MacServiceState {
  web: { enabled: boolean; server: string; port: number }
  secureWeb: { enabled: boolean; server: string; port: number }
  socks: { enabled: boolean; server: string; port: number }
  pac: { enabled: boolean; url: string }
  autoDiscovery: boolean
  bypass: string[]
}

function manualProxyOutput(value: MacServiceState['web']): string {
  return `Enabled: ${value.enabled ? 'Yes' : 'No'}\nServer: ${value.server}\nPort: ${value.port}\nAuthenticated Proxy Enabled: 0\n`
}

class GSettingsEmulator {
  public static originalValues(): Record<string, Record<string, string>> {
    return {
      'org.gnome.system.proxy': {
        mode: "'auto'",
        'autoconfig-url': "'https://pac.example/proxy.pac'",
        'ignore-hosts': "['localhost', '*.internal.example']",
        'use-same-proxy': 'false'
      },
      'org.gnome.system.proxy.http': {
        host: "'old-http.example'", port: '8080', enabled: 'true', 'use-authentication': 'true'
      },
      'org.gnome.system.proxy.https': { host: "'old-https.example'", port: '8443' },
      'org.gnome.system.proxy.ftp': { host: "''", port: '0' },
      'org.gnome.system.proxy.socks': { host: "'old-socks.example'", port: '1080' }
    }
  }

  public values = GSettingsEmulator.originalValues()

  public readonly run: PlatformCommandRunner = vi.fn(async (request) => {
    const [command, schema, key, rawValue] = request.args
    const values = this.values[schema]
    if (!values) return { exitCode: 1, stdout: '', stderr: 'No such schema' }
    if (command === 'list-keys') return ok(`${Object.keys(values).join('\n')}\n`)
    if (command === 'get') return ok(`${values[key]}\n`)
    if (command === 'set') { values[key] = rawValue; return ok() }
    throw new Error(`Unexpected gsettings command ${command}`)
  })
}

class FakeElevationProcessRunner implements TemporaryElevationProcessRunner {
  public readonly requests: TemporaryElevatedProcessRequest[] = []
  public readonly stop = vi.fn(async () => undefined)

  public async start(request: TemporaryElevatedProcessRequest): Promise<TemporaryElevatedProcessHandle> {
    this.requests.push({ ...request, args: [...request.args] })
    return { id: `handle-${this.requests.length}`, pid: 8000 + this.requests.length, stop: this.stop }
  }
}

class FakeChildProcess extends EventEmitter {
  public pid = 73001
  public exitCode: number | null = null
  public stderr = new PassThrough()
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.exitCode = 0
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  })
}

function tunBypass() {
  return createTunBypassPlan({
    localGateway: { host: '127.0.0.1', port: 15721 },
    mixed: { host: '127.0.0.1', port: 20800 },
    controller: { host: '127.0.0.1', port: 20801 },
    singBoxProcessId: 5512,
    nodeServers: [{ host: 'node.example', port: 443 }],
    dnsUpstreams: [{ host: '1.1.1.1', port: 53 }]
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
