import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  GnomeSystemProxyPlatformAdapter,
  MacOsSystemProxyPlatformAdapter,
  NativeTemporaryElevationProcessRunner,
  PlatformProxyCommandError,
  SingBoxTemporaryTunPlatformAdapter,
  UnsupportedDesktopProxyError,
  WindowsSystemProxyPlatformAdapter,
  createSystemProxyPlatformAdapter,
  defaultPlatformCommandRunner,
  type PlatformCommandRequest,
  type PlatformCommandResult,
  type PlatformCommandRunner,
  type TemporaryElevatedProcessHandle,
  type TemporaryElevatedProcessRequest,
  type TemporaryElevationProcessRunner
} from '../../src/main/proxy/built-in/platform-adapters'
import {
  normalizeLeaseTarget,
  type SystemProxySnapshot
} from '../../src/main/proxy/built-in/system-proxy-lease'
import {
  TunElevationDeniedError,
  createTunBypassPlan
} from '../../src/main/proxy/built-in/tun-controller'

const ok = (stdout = ''): PlatformCommandResult => ({ exitCode: 0, stdout, stderr: '' })

describe('real system-proxy platform adapters', () => {
  it('captures all WinINet values and atomically restores only fields still owned by Stone+', async () => {
    const native = windowsSettings({
      ProxyEnable: winValue('dword', 1),
      ProxyServer: winValue('string', 'http=corp.example:8080;https=secure.example:8443'),
      AutoConfigURL: winValue('string', 'https://pac.example/full/path/proxy.pac?profile=corp'),
      ProxyOverride: winValue('string', '<local>;*.corp.example;10.*'),
      AutoDetect: winValue('dword', 1),
      DefaultConnectionSettings: winValue('binary', winInetConnectionBlob({
        version: 70,
        counter: 42,
        flags: 0x0f,
        proxy: 'http=corp.example:8080;https=secure.example:8443',
        bypass: '<local>;*.corp.example;10.*',
        pac: 'https://pac.example/full/path/proxy.pac?profile=corp',
        tail: Buffer.alloc(32, 7)
      })),
      SavedLegacySettings: winValue('binary', winInetConnectionBlob({
        version: 70,
        counter: 17,
        flags: 0x03,
        proxy: 'old-socks.example:1080',
        bypass: '<local>',
        pac: '',
        tail: Buffer.alloc(32, 9)
      }))
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
      if (request.operation === 'win32.system-proxy.compare-apply') {
        const payload = clone(request.payload) as unknown as {
          expected: typeof native
          replacement: typeof native
        }
        const restored = compareAndRestoreWindowsSettings(current, payload.expected, payload.replacement)
        current = restored.settings
        return ok(`${restored.result}\n`)
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
    const captureCall = calls.find((call) => call.operation === 'win32.system-proxy.capture')
    const applyCall = calls.find((call) => call.operation === 'win32.system-proxy.apply')
    expect(captureCall?.args.slice(0, 5)).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'
    ])
    expect(captureCall?.args.at(-1)).toContain('DoNotExpandEnvironmentNames')
    expect(captureCall?.args.at(-1)).toContain('DefaultConnectionSettings')
    expect(captureCall?.args.at(-1)).toContain('SavedLegacySettings')
    expect(captureCall?.input).toBeUndefined()
    expect(applyCall?.file).toBe('powershell.exe')
    expect(applyCall?.args.slice(0, 5)).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'
    ])
    expect(applyCall?.args.join(' ')).toContain('InternetSetOption')
    expect(applyCall?.args.join(' ')).toContain('[Console]::In.ReadToEnd()')
    expect(applyCall?.args.join(' ')).toContain('Windows did not retain the Stone+ registry value')
    expect(applyCall?.args.join(' ')).toContain('INTERNET_OPTION_SETTINGS_CHANGED')
    expect(applyCall?.args.join(' ')).not.toContain('[void][StoneWinInetRefresh]')
    expect(applyCall?.args.join(' ')).not.toContain('pac.example/full/path')
    expect(applyCall?.input).toContain('127.0.0.1:20800')
    const applyScript = applyCall?.args.at(-1) ?? ''
    const connectionWrite = applyScript.indexOf("Set-StoneValue $connections 'DefaultConnectionSettings'")
    const proxyServerWrite = applyScript.indexOf("Set-StoneValue $internet 'ProxyServer'")
    const pacWrite = applyScript.indexOf("Set-StoneValue $internet 'AutoConfigURL'")
    const proxyEnableWrite = applyScript.indexOf("Set-StoneValue $internet 'ProxyEnable'")
    const settingsChanged = applyScript.indexOf('InternetSetOption([IntPtr]::Zero, 39')
    const refresh = applyScript.indexOf('InternetSetOption([IntPtr]::Zero, 37')
    expect(connectionWrite).toBeGreaterThanOrEqual(0)
    expect(proxyServerWrite).toBeGreaterThan(connectionWrite)
    expect(pacWrite).toBeGreaterThan(proxyServerWrite)
    expect(proxyEnableWrite).toBeGreaterThan(pacWrite)
    expect(settingsChanged).toBeGreaterThan(proxyEnableWrite)
    expect(refresh).toBeGreaterThan(settingsChanged)
    await expect(adapter.isSnapshotApplied(mixed)).resolves.toBe(true)
    current.values.ProxyEnable = winValue('dword', 0)
    await expect(adapter.isSnapshotApplied(mixed)).resolves.toBe(false)
    current.values.ProxyEnable = winValue('dword', 1)
    current.values.ProxyServer = winValue('string', 'user-changed.example:3128')
    await expect(adapter.isSnapshotApplied(mixed)).resolves.toBe(false)
    current.values.ProxyServer = winValue('string', '127.0.0.1:20800')
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(current).toEqual(native)

    await adapter.applySnapshot(mixed)
    current.values.AutoConfigURL = winValue('string', 'https://user.example/new-proxy.pac')
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
    expect(current.values.ProxyServer).toEqual(native.values.ProxyServer)
    expect(current.values.AutoConfigURL).toEqual(winValue('string', 'https://user.example/new-proxy.pac'))

    await adapter.applySnapshot(mixed)
    const userBlob = parseWinInetConnectionBlob(String(current.values.DefaultConnectionSettings.value))
    current.values.DefaultConnectionSettings = winValue('binary', winInetConnectionBlob({
      ...userBlob,
      flags: 0x05,
      bypass: 'user-bypass.example;<local>',
      pac: 'https://user.example/inside-connection-blob.pac'
    }))
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
    const restoredBlob = parseWinInetConnectionBlob(String(current.values.DefaultConnectionSettings.value))
    const originalBlob = parseWinInetConnectionBlob(String(native.values.DefaultConnectionSettings.value))
    expect(restoredBlob).toMatchObject({
      flags: 0x05,
      proxy: originalBlob.proxy,
      bypass: 'user-bypass.example;<local>',
      pac: 'https://user.example/inside-connection-blob.pac'
    })
    const afterPartial = clone(current)
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('mismatch')
    expect(current).toEqual(afterPartial)

    const compareCall = calls.find((call) => call.operation === 'win32.system-proxy.compare-apply')
    expect(compareCall?.args.join(' ')).toContain('Parse-StoneConnectionBlob')
    expect(compareCall?.args.join(' ')).toContain('Publish-StoneProxySettings')
    expect(compareCall?.args.join(' ')).toContain('Read-StoneValue $internet $name')
    expect(compareCall?.args.join(' ')).not.toContain('[void][StoneWinInetCompareRefresh]')
    expect(compareCall?.args.join(' ')).not.toContain('Contains-StoneProxy')
    expect(compareCall?.args.join('').length).toBeLessThan(32_767)
    expect(compareCall?.input).toContain('"expected"')
    expect(compareCall?.input).toContain('https://pac.example/full/path/proxy.pac?profile=corp')
    expect(compareCall?.args.join(' ')).not.toContain('pac.example/full/path')

    current.values.ProxyServer = winValue('string', 'user-changed.example:3128')
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('mismatch')
    expect(current.values.ProxyServer.value).toBe('user-changed.example:3128')
  })

  it('streams large Windows snapshots over stdin instead of exceeding the process command line', async () => {
    const hugePac = `https://pac.example/${'profile/'.repeat(10_000)}proxy.pac`
    const native = windowsSettings({
      ProxyEnable: winValue('dword', 0),
      ProxyServer: winValue('string', ''),
      AutoConfigURL: winValue('string', hugePac),
      ProxyOverride: winValue('string', '<local>'),
      AutoDetect: winValue('dword', 0),
      DefaultConnectionSettings: winValue('binary', winInetConnectionBlob({
        version: 70, counter: 1, flags: 0x05, proxy: '', bypass: '<local>', pac: hugePac, tail: Buffer.alloc(32)
      })),
      SavedLegacySettings: winValue('binary', winInetConnectionBlob({
        version: 70, counter: 1, flags: 0x05, proxy: '', bypass: '<local>', pac: hugePac, tail: Buffer.alloc(32)
      }))
    })
    const calls: PlatformCommandRequest[] = []
    const runner: PlatformCommandRunner = vi.fn(async (request) => {
      calls.push(request)
      if (request.operation === 'win32.system-proxy.capture') return ok(JSON.stringify(native))
      if (request.operation === 'win32.system-proxy.compare-apply') return ok('applied\n')
      return ok()
    })
    const adapter = new WindowsSystemProxyPlatformAdapter({ runner })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20809 }
    }))
    await adapter.applySnapshot(original)
    await adapter.compareAndApplySnapshot(mixed, original)

    for (const call of calls.filter((item) => item.operation?.endsWith('apply'))) {
      expect(call.args.join('').length).toBeLessThan(32_767)
      expect(call.args.join(' ')).not.toContain('profile/profile')
      expect(call.input).toContain('profile/profile')
    }
  })

  it('rejects an exit-zero Windows restore when the native route still owns the mixed endpoint', async () => {
    const native = windowsSettings({
      ProxyEnable: winValue('dword', 0),
      ProxyServer: winValue('string', 'old.example:8080'),
      AutoConfigURL: winValue('string', 'https://pac.example/original.pac'),
      ProxyOverride: winValue('string', '<local>'),
      AutoDetect: winValue('dword', 1),
      DefaultConnectionSettings: winValue('binary', winInetConnectionBlob({
        version: 70, counter: 1, flags: 0x05, proxy: 'old.example:8080', bypass: '<local>', pac: 'https://pac.example/original.pac', tail: Buffer.alloc(32)
      })),
      SavedLegacySettings: winValue('binary', winInetConnectionBlob({
        version: 70, counter: 1, flags: 0x05, proxy: 'old.example:8080', bypass: '<local>', pac: 'https://pac.example/original.pac', tail: Buffer.alloc(32)
      }))
    })
    let current = clone(native)
    let normalizeOnRestore = false
    const runner: PlatformCommandRunner = vi.fn(async (request) => {
      if (request.operation === 'win32.system-proxy.capture') return ok(JSON.stringify(current))
      if (request.operation === 'win32.system-proxy.apply') {
        current = clone(request.payload) as typeof native
        return ok()
      }
      if (request.operation === 'win32.system-proxy.compare-apply') {
        // Simulate a setter/notification process which exits successfully but
        // was intercepted before any native state was restored.
        if (normalizeOnRestore) {
          current = clone(native)
          current.values.ProxyServer = winValue('string', '')
          current.values.ProxyOverride = winValue('string', '')
          current.values.DefaultConnectionSettings = winValue('binary', winInetConnectionBlob({
            version: 70, counter: 2, flags: 0x01, proxy: '', bypass: '', pac: '', tail: Buffer.alloc(32)
          }))
          current.values.SavedLegacySettings = clone(current.values.DefaultConnectionSettings)
        }
        return ok('applied\n')
      }
      throw new Error(`Unexpected operation ${request.operation}`)
    })
    const adapter = new WindowsSystemProxyPlatformAdapter({ runner })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20812 }
    }))
    await adapter.applySnapshot(mixed)

    await expect(adapter.compareAndApplySnapshot(mixed, original)).rejects.toMatchObject({
      code: 'platform_proxy_command_failed',
      message: expect.stringContaining('safe system-proxy restore')
    })
    await expect(adapter.isSnapshotApplied(mixed)).resolves.toBe(true)

    normalizeOnRestore = true
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
  })

  it('turns a child stdin pipe failure into a bounded platform command error', async () => {
    const operation = defaultPlatformCommandRunner({
      file: process.execPath,
      args: [
        '-e',
        "require('node:fs').closeSync(0); setTimeout(() => process.exit(0), 1_000)"
      ],
      input: 'x'.repeat(8 * 1024 * 1024),
      operation: 'test.stdin-closed'
    })

    await expect(operation).rejects.toMatchObject({
      code: 'platform_proxy_command_failed',
      command: expect.not.stringContaining('xxxxxxxx')
    })
    await expect(operation).rejects.toBeInstanceOf(PlatformProxyCommandError)
  })

  it('captures and restores every active macOS network service proxy field', async () => {
    const emulator = new MacNetworksetupEmulator()
    const adapter = new MacOsSystemProxyPlatformAdapter({ runner: emulator.run })
    const original = await adapter.captureSnapshot()
    expect(original.settings.services).toEqual([
      {
        name: 'Wi-Fi',
        disabled: false,
        web: { enabled: true, server: 'old-http.example', port: 8080, authenticated: false },
        secureWeb: { enabled: false, server: 'old-https.example', port: 8443, authenticated: false },
        socks: { enabled: true, server: 'old-socks.example', port: 1080, authenticated: false },
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
    expect(emulator.service.web).toEqual({ enabled: true, server: '::1', port: 20810, authenticated: false })
    expect(emulator.service.secureWeb).toEqual({ enabled: true, server: '::1', port: 20810, authenticated: false })
    expect(emulator.service.socks).toEqual({ enabled: true, server: '::1', port: 20810, authenticated: false })
    expect(emulator.service.pac).toEqual({ enabled: false, url: '' })
    expect(emulator.service.autoDiscovery).toBe(false)
    expect(emulator.service.bypass).toContain('*.stone.internal')

    emulator.service.pac = { enabled: true, url: 'https://user.example/new.pac' }
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
    expect(emulator.service.web).toEqual(MacNetworksetupEmulator.originalService().web)
    expect(emulator.service.pac).toEqual({ enabled: true, url: 'https://user.example/new.pac' })

    await adapter.applySnapshot(mixed)
    emulator.failNextOperation = 'darwin.system-proxy.restore-socksfirewall'
    await expect(adapter.compareAndApplySnapshot(mixed, original)).rejects.toThrow()
    expect(emulator.service.socks.server).toBe('::1')
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(emulator.service).toEqual(MacNetworksetupEmulator.originalService())

    await adapter.applySnapshot(mixed)
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(emulator.service).toEqual(MacNetworksetupEmulator.originalService())
    expect(emulator.calls.every((call) => call.file === '/usr/sbin/networksetup')).toBe(true)
  })

  it('refuses to overwrite macOS authenticated proxy credentials that networksetup cannot replay', async () => {
    const emulator = new MacNetworksetupEmulator()
    emulator.service.web.authenticated = true
    const adapter = new MacOsSystemProxyPlatformAdapter({ runner: emulator.run })
    const original = await adapter.captureSnapshot()

    expect(original.settings.services[0].web).toMatchObject({ authenticated: true })
    expect(() => adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20811 }
    }))).toThrow(UnsupportedDesktopProxyError)
    expect(emulator.calls.filter((call) => call.args[0]?.startsWith('-set'))).toHaveLength(0)
  })

  it('normalizes authentication metadata missing from a legacy macOS v1 recovery journal', async () => {
    const emulator = new MacNetworksetupEmulator()
    const adapter = new MacOsSystemProxyPlatformAdapter({ runner: emulator.run })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20812 }
    }))
    const legacyOriginal = clone(original)
    const legacyMixed = clone(mixed)
    stripMacAuthenticationMetadata(legacyOriginal)
    stripMacAuthenticationMetadata(legacyMixed)

    await adapter.applySnapshot(mixed)
    await expect(adapter.compareAndApplySnapshot(legacyMixed, legacyOriginal)).resolves.toBe('applied')
    expect(emulator.service).toEqual(MacNetworksetupEmulator.originalService())
  })

  it('retains macOS lease ownership when authentication changes on a Stone+-owned endpoint', async () => {
    const emulator = new MacNetworksetupEmulator()
    const adapter = new MacOsSystemProxyPlatformAdapter({ runner: emulator.run })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20813 }
    }))
    await adapter.applySnapshot(mixed)
    emulator.service.web.authenticated = true
    const changed = clone(emulator.service)

    await expect(adapter.compareAndApplySnapshot(mixed, original))
      .rejects.toBeInstanceOf(UnsupportedDesktopProxyError)
    expect(emulator.service).toEqual(changed)

    emulator.service.web.authenticated = false
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('applied')
    expect(emulator.service).toEqual(MacNetworksetupEmulator.originalService())
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

    await adapter.applySnapshot(mixed)
    emulator.values['org.gnome.system.proxy']['autoconfig-url'] = "'https://user.example/new.pac'"
    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
    expect(emulator.values['org.gnome.system.proxy']['autoconfig-url'])
      .toBe("'https://user.example/new.pac'")

    await adapter.applySnapshot(mixed)
    emulator.failNextSet = { schema: 'org.gnome.system.proxy.http', key: 'port' }
    await expect(adapter.compareAndApplySnapshot(mixed, original)).rejects.toThrow()
    expect(emulator.values['org.gnome.system.proxy'].mode).toBe("'auto'")
    expect(emulator.values['org.gnome.system.proxy.http']).toMatchObject({
      host: "'old-http.example'",
      port: '20820'
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

  it('does not infer GNOME ownership from optional schemas missing on both sides', async () => {
    const emulator = new GSettingsEmulator()
    delete emulator.values['org.gnome.system.proxy.https']
    delete emulator.values['org.gnome.system.proxy.ftp']
    delete emulator.values['org.gnome.system.proxy.socks']
    const adapter = new GnomeSystemProxyPlatformAdapter({
      runner: emulator.run,
      desktopEnvironment: 'GNOME'
    })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20821 }
    }))
    await adapter.applySnapshot(mixed)
    emulator.values['org.gnome.system.proxy.http'].host = "'user-proxy.example'"
    emulator.values['org.gnome.system.proxy.http'].port = '3128'
    const userSettings = clone(emulator.values)

    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('mismatch')
    expect(emulator.values).toEqual(userSettings)
    expect(emulator.values['org.gnome.system.proxy'].mode).toBe("'manual'")
  })

  it('does not let a secondary GNOME marker overwrite a user-owned primary manual route', async () => {
    const emulator = new GSettingsEmulator()
    const adapter = new GnomeSystemProxyPlatformAdapter({
      runner: emulator.run,
      desktopEnvironment: 'GNOME'
    })
    const original = await adapter.captureSnapshot()
    const mixed = adapter.createMixedProxySnapshot(original, normalizeLeaseTarget({
      mixed: { host: '127.0.0.1', port: 20822 }
    }))
    await adapter.applySnapshot(mixed)
    emulator.values['org.gnome.system.proxy.http'].host = "'user-proxy.example'"
    emulator.values['org.gnome.system.proxy.http'].port = '3128'

    await expect(adapter.compareAndApplySnapshot(mixed, original)).resolves.toBe('partial')
    expect(emulator.values['org.gnome.system.proxy']).toMatchObject({
      mode: "'manual'",
      'use-same-proxy': 'true',
      'autoconfig-url': "'https://pac.example/proxy.pac'"
    })
    expect(emulator.values['org.gnome.system.proxy.http']).toMatchObject({
      host: "'user-proxy.example'",
      port: '3128'
    })
    expect(emulator.values['org.gnome.system.proxy.https']).toEqual(
      GSettingsEmulator.originalValues()['org.gnome.system.proxy.https']
    )
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
    await expect(adapter.observeTemporaryExit(session)).resolves.toEqual({ code: 0, signal: null })
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
    expect(windowsCommands[0].args.join(' ')).not.toContain('Stone Data')
    expect(windowsCommands[0].input).toContain('Stone Data')
    const encodedStop = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(windowsCommands[1].args.join(' '))?.[1]
    expect(Buffer.from(String(encodedStop), 'base64').toString('utf16le')).toContain('/T /F')

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
      const exit = handle.exit
      let askpassPath: string | undefined
      if (launcher === 'macos-sudo') {
        expect(spawnMock).toHaveBeenCalledWith(
          'sudo', ['-A', '-k', '--', executable, 'run', '-c', '/tmp/tun.json'], expect.any(Object)
        )
        const spawnOptions = spawnMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
        askpassPath = spawnOptions.env?.SUDO_ASKPASS
        expect(askpassPath).toBeTruthy()
        const askpass = await readFile(String(askpassPath), 'utf8')
        expect(askpass).toContain('/usr/bin/osascript')
        expect(askpass).toContain('with hidden answer')
        expect(askpass).toContain('/bin/rm -f -- "$0"')
        expect(spawnOptions.env?.SUDO_ASKPASS).not.toBe(process.env.SUDO_ASKPASS)
      } else {
        expect(spawnMock).toHaveBeenCalledWith(
          'pkexec', [executable, 'run', '-c', '/tmp/tun.json'], expect.any(Object)
        )
      }
      await handle.stop()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(exit).resolves.toEqual({ code: 0, signal: null })
      if (askpassPath) await expect(readFile(askpassPath, 'utf8')).rejects.toThrow()
    }
  })

  it('classifies a rejected macOS authorization prompt as elevation denied', async () => {
    const child = new FakeChildProcess()
    child.exitCode = 126
    const spawnMock = vi.fn(() => child as unknown as ReturnType<typeof spawn>)
    const runner = new NativeTemporaryElevationProcessRunner({
      spawnImplementation: spawnMock as unknown as typeof spawn
    })

    await expect(runner.start({
      launcher: 'macos-sudo',
      executablePath: '/Applications/Stone.app/Contents/Resources/sing-box',
      args: ['run', '-c', '/tmp/tun.json']
    })).rejects.toBeInstanceOf(TunElevationDeniedError)
    const options = spawnMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
    await expect(readFile(String(options.env?.SUDO_ASKPASS), 'utf8')).rejects.toThrow()
  })

  it('exposes late elevated-process exits instead of treating a fixed delay as readiness', async () => {
    const child = new FakeChildProcess()
    const runner = new NativeTemporaryElevationProcessRunner({
      spawnImplementation: vi.fn(() => child as unknown as ReturnType<typeof spawn>) as unknown as typeof spawn
    })
    const handle = await runner.start({
      launcher: 'linux-pkexec',
      executablePath: '/opt/stone/sing-box',
      args: ['run', '-c', '/tmp/tun.json']
    })

    child.exitCode = 23
    child.emit('exit', 23, null)
    child.stderr.end()
    child.emit('close', 23, null)
    await expect(handle.exit).resolves.toEqual({ code: 23, signal: null })
  })

  it('retains bounded stderr for a late macOS authorization refusal', async () => {
    const child = new FakeChildProcess()
    const runner = new NativeTemporaryElevationProcessRunner({
      spawnImplementation: vi.fn(() => child as unknown as ReturnType<typeof spawn>) as unknown as typeof spawn
    })
    const handle = await runner.start({
      launcher: 'macos-sudo',
      executablePath: '/Applications/Stone.app/Contents/Resources/sing-box',
      args: ['run', '-c', '/tmp/tun.json']
    })

    child.stderr.write(`sudo: no password was provided\n${'detail'.repeat(2_000)}`)
    child.stderr.end()
    child.exitCode = 1
    child.emit('exit', 1, null)
    child.emit('close', 1, null)
    const exit = await handle.exit
    expect(exit).toMatchObject({ code: 1, signal: null })
    expect(exit?.stderr).toContain('no password was provided')
    expect(exit?.stderr?.length).toBeLessThanOrEqual(8_000)
  })
})

interface TestWindowsNativeValue {
  present: boolean
  kind: 'dword' | 'string' | 'binary'
  value: number | string | null
}

interface TestWindowsSettings {
  adapter: string
  values: Record<string, TestWindowsNativeValue>
}

interface TestWinInetConnectionBlob {
  version: number
  counter: number
  flags: number
  proxy: string
  bypass: string
  pac: string
  tail: Buffer
}

function windowsSettings(values: Record<string, TestWindowsNativeValue>): TestWindowsSettings {
  return { adapter: 'stone-wininet-v1', values }
}

function winValue(kind: 'dword' | 'string' | 'binary', value: number | string): TestWindowsNativeValue {
  return { present: true, kind, value }
}

function winInetConnectionBlob(value: TestWinInetConnectionBlob): string {
  const fields = [value.proxy, value.bypass, value.pac].map((field) => Buffer.from(field, 'utf8'))
  const header = Buffer.alloc(12)
  header.writeUInt32LE(value.version, 0)
  header.writeUInt32LE(value.counter, 4)
  header.writeUInt32LE(value.flags, 8)
  return Buffer.concat([
    header,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4)
      length.writeUInt32LE(field.length)
      return [length, field]
    }),
    value.tail
  ]).toString('base64')
}

function parseWinInetConnectionBlob(base64: string): TestWinInetConnectionBlob {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 24) throw new Error('Invalid test WinINet connection blob.')
  let offset = 12
  const readField = (): string => {
    if (offset + 4 > bytes.length) throw new Error('Invalid test WinINet field length.')
    const length = bytes.readUInt32LE(offset)
    offset += 4
    if (offset + length > bytes.length) throw new Error('Invalid test WinINet field.')
    const value = bytes.subarray(offset, offset + length).toString('utf8')
    offset += length
    return value
  }
  return {
    version: bytes.readUInt32LE(0),
    counter: bytes.readUInt32LE(4),
    flags: bytes.readUInt32LE(8),
    proxy: readField(),
    bypass: readField(),
    pac: readField(),
    tail: Buffer.from(bytes.subarray(offset))
  }
}

function compareAndRestoreWindowsSettings(
  current: TestWindowsSettings,
  expected: TestWindowsSettings,
  replacement: TestWindowsSettings
): { settings: TestWindowsSettings; result: 'applied' | 'partial' | 'mismatch' } {
  const names = Object.keys(expected.values)
  if (names.every((name) => sameWindowsValue(current.values[name], replacement.values[name]))) {
    return { settings: clone(current), result: 'applied' }
  }
  const ownsStone = sameWindowsValue(current.values.ProxyServer, expected.values.ProxyServer)
    || ownsWindowsConnectionBlob(current.values.DefaultConnectionSettings, expected.values.DefaultConnectionSettings)
    || ownsWindowsConnectionBlob(current.values.SavedLegacySettings, expected.values.SavedLegacySettings)
  if (!ownsStone) return { settings: clone(current), result: 'mismatch' }

  const output = clone(current)
  let partial = false
  for (const name of ['ProxyEnable', 'AutoConfigURL', 'ProxyOverride', 'AutoDetect']) {
    if (sameWindowsValue(current.values[name], expected.values[name])) {
      output.values[name] = clone(replacement.values[name])
    } else if (!sameWindowsValue(current.values[name], replacement.values[name])) {
      partial = true
    }
  }
  for (const name of ['DefaultConnectionSettings', 'SavedLegacySettings']) {
    const merged = mergeWindowsConnectionBlob(
      current.values[name], expected.values[name], replacement.values[name]
    )
    output.values[name] = merged.entry
    partial ||= merged.partial
  }
  if (sameWindowsValue(current.values.ProxyServer, expected.values.ProxyServer)) {
    output.values.ProxyServer = clone(replacement.values.ProxyServer)
  } else if (!sameWindowsValue(current.values.ProxyServer, replacement.values.ProxyServer)) {
    partial = true
  }
  return { settings: output, result: partial ? 'partial' : 'applied' }
}

function ownsWindowsConnectionBlob(
  current: TestWindowsNativeValue | undefined,
  expected: TestWindowsNativeValue | undefined
): boolean {
  try {
    if (!current?.present || !expected?.present || current.kind !== 'binary' || expected.kind !== 'binary') return false
    const expectedProxy = parseWinInetConnectionBlob(String(expected.value)).proxy
    return Boolean(expectedProxy) && parseWinInetConnectionBlob(String(current.value)).proxy === expectedProxy
  } catch {
    return false
  }
}

function mergeWindowsConnectionBlob(
  current: TestWindowsNativeValue,
  expected: TestWindowsNativeValue,
  replacement: TestWindowsNativeValue
): { entry: TestWindowsNativeValue; partial: boolean } {
  if (sameWindowsValue(current, expected)) return { entry: clone(replacement), partial: false }
  if (sameWindowsValue(current, replacement)) return { entry: clone(current), partial: false }
  try {
    const observed = parseWinInetConnectionBlob(String(current.value))
    const owned = parseWinInetConnectionBlob(String(expected.value))
    const original = parseWinInetConnectionBlob(String(replacement.value))
    const output = { ...observed, tail: Buffer.from(observed.tail) }
    let partial = false
    for (const name of ['version', 'counter', 'flags', 'proxy', 'bypass', 'pac', 'tail'] as const) {
      if (sameBlobComponent(observed[name], owned[name])) output[name] = cloneBlobComponent(original[name]) as never
      else if (!sameBlobComponent(observed[name], original[name])) partial = true
    }
    return { entry: winValue('binary', winInetConnectionBlob(output)), partial }
  } catch {
    return { entry: clone(current), partial: true }
  }
}

function sameWindowsValue(
  left: TestWindowsNativeValue | undefined,
  right: TestWindowsNativeValue | undefined
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameBlobComponent(left: number | string | Buffer, right: number | string | Buffer): boolean {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) ? left.equals(right) : left === right
}

function cloneBlobComponent(value: number | string | Buffer): number | string | Buffer {
  return Buffer.isBuffer(value) ? Buffer.from(value) : value
}

class MacNetworksetupEmulator {
  public static originalService(): MacServiceState {
    return {
      web: { enabled: true, server: 'old-http.example', port: 8080, authenticated: false },
      secureWeb: { enabled: false, server: 'old-https.example', port: 8443, authenticated: false },
      socks: { enabled: true, server: 'old-socks.example', port: 1080, authenticated: false },
      pac: { enabled: true, url: 'https://pac.example/full/proxy.pac' },
      autoDiscovery: true,
      bypass: ['localhost', '*.internal.example']
    }
  }

  public service = MacNetworksetupEmulator.originalService()
  public readonly calls: PlatformCommandRequest[] = []
  public failNextOperation?: string

  public readonly run: PlatformCommandRunner = vi.fn(async (request) => {
    this.calls.push(request)
    if (request.operation === this.failNextOperation) {
      this.failNextOperation = undefined
      return { exitCode: 1, stdout: '', stderr: 'simulated networksetup failure' }
    }
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
      this.service[key].authenticated = false
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
  web: { enabled: boolean; server: string; port: number; authenticated: boolean }
  secureWeb: { enabled: boolean; server: string; port: number; authenticated: boolean }
  socks: { enabled: boolean; server: string; port: number; authenticated: boolean }
  pac: { enabled: boolean; url: string }
  autoDiscovery: boolean
  bypass: string[]
}

function manualProxyOutput(value: MacServiceState['web']): string {
  return `Enabled: ${value.enabled ? 'Yes' : 'No'}\nServer: ${value.server}\nPort: ${value.port}\nAuthenticated Proxy Enabled: ${value.authenticated ? 1 : 0}\n`
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
  public failNextSet?: { schema: string; key: string }

  public readonly run: PlatformCommandRunner = vi.fn(async (request) => {
    const [command, schema, key, rawValue] = request.args
    const values = this.values[schema]
    if (!values) return { exitCode: 1, stdout: '', stderr: 'No such schema' }
    if (command === 'list-keys') return ok(`${Object.keys(values).join('\n')}\n`)
    if (command === 'get') return ok(`${values[key]}\n`)
    if (command === 'set') {
      if (this.failNextSet?.schema === schema && this.failNextSet.key === key) {
        this.failNextSet = undefined
        return { exitCode: 1, stdout: '', stderr: 'simulated gsettings failure' }
      }
      values[key] = rawValue
      return ok()
    }
    throw new Error(`Unexpected gsettings command ${command}`)
  })
}

class FakeElevationProcessRunner implements TemporaryElevationProcessRunner {
  public readonly requests: TemporaryElevatedProcessRequest[] = []
  public readonly stop = vi.fn(async () => undefined)

  public async start(request: TemporaryElevatedProcessRequest): Promise<TemporaryElevatedProcessHandle> {
    this.requests.push({ ...request, args: [...request.args] })
    return {
      id: `handle-${this.requests.length}`,
      pid: 8000 + this.requests.length,
      exit: Promise.resolve({ code: 0, signal: null }),
      stop: this.stop
    }
  }
}

class FakeChildProcess extends EventEmitter {
  public pid = 73001
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  public stderr = new PassThrough()
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.exitCode = 0
    queueMicrotask(() => {
      this.emit('exit', 0, null)
      this.stderr.end()
      this.emit('close', 0, null)
    })
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

function stripMacAuthenticationMetadata(snapshot: SystemProxySnapshot): void {
  const settings = snapshot.settings as unknown as {
    services: Array<{
      web?: { authenticated?: boolean }
      secureWeb?: { authenticated?: boolean }
      socks?: { authenticated?: boolean }
    }>
  }
  for (const service of settings.services) {
    delete service.web?.authenticated
    delete service.secureWeb?.authenticated
    delete service.socks?.authenticated
  }
}
