import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  NormalizedSystemProxyLeaseTarget,
  SystemProxyCompareResult,
  SystemProxyPlatformAdapter
} from './system-proxy-lease'
import type { ProxySnapshotJson, SystemProxySnapshot } from './lease-recovery'
import {
  TunElevationDeniedError,
  type TunBypassPlan,
  type TunPlatformAdapter,
  type TunPlatformSession,
  type TunPlatformStartRequest
} from './tun-controller'

const WINDOWS_SETTINGS_ADAPTER = 'stone-wininet-v1'
const MACOS_SETTINGS_ADAPTER = 'stone-networksetup-v1'
const GNOME_SETTINGS_ADAPTER = 'stone-gnome-gsettings-v1'

export interface PlatformCommandRequest {
  file: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  /** Stable diagnostic/testing label; it is not passed to the child process. */
  operation?: string
  /** Structured non-secret context for injected runners; ignored by the default runner. */
  payload?: ProxySnapshotJson
}

export interface PlatformCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type PlatformCommandRunner = (
  request: PlatformCommandRequest
) => Promise<PlatformCommandResult>

export class PlatformProxyCommandError extends Error {
  public readonly code = 'platform_proxy_command_failed'
  public readonly command: string
  public readonly exitCode?: number

  public constructor(
    message: string,
    request: PlatformCommandRequest,
    result?: PlatformCommandResult,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'PlatformProxyCommandError'
    this.command = `${request.file} ${request.args.join(' ')}`
    this.exitCode = result?.exitCode
  }
}

export class UnsupportedDesktopProxyError extends Error {
  public readonly code = 'unsupported_desktop_proxy'

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UnsupportedDesktopProxyError'
  }
}

export const defaultPlatformCommandRunner: PlatformCommandRunner = async (request) => (
  new Promise<PlatformCommandResult>((resolve) => {
    execFile(
      request.file,
      [...request.args],
      {
        cwd: request.cwd,
        env: request.env ? { ...process.env, ...request.env } : process.env,
        timeout: request.timeoutMs ?? 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        const numericCode = error && typeof error.code === 'number' ? error.code : undefined
        resolve({
          exitCode: error ? numericCode ?? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || error?.message || '')
        })
      }
    )
  })
)

export interface SystemProxyPlatformAdapterFactoryOptions {
  platform?: NodeJS.Platform
  runner?: PlatformCommandRunner
  desktopEnvironment?: string
}

export function createSystemProxyPlatformAdapter(
  options: SystemProxyPlatformAdapterFactoryOptions = {}
): SystemProxyPlatformAdapter {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? defaultPlatformCommandRunner
  if (platform === 'win32') return new WindowsSystemProxyPlatformAdapter({ runner })
  if (platform === 'darwin') return new MacOsSystemProxyPlatformAdapter({ runner })
  if (platform === 'linux') {
    return new GnomeSystemProxyPlatformAdapter({
      runner,
      desktopEnvironment: options.desktopEnvironment ?? process.env.XDG_CURRENT_DESKTOP
    })
  }
  throw new UnsupportedDesktopProxyError(
    `Built-in system-proxy takeover is not supported on ${platform}.`
  )
}

export interface ConcreteSystemProxyAdapterOptions {
  runner?: PlatformCommandRunner
}

type NativeValueKind = 'dword' | 'string' | 'binary'

interface WindowsNativeValue {
  present: boolean
  kind: NativeValueKind
  value: number | string | null
}

interface WindowsProxySettings {
  adapter: typeof WINDOWS_SETTINGS_ADAPTER
  values: Record<string, WindowsNativeValue>
}

const WINDOWS_CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$internet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$connections = Join-Path $internet 'Connections'
function Read-StoneValue([string]$Path, [string]$Name, [string]$Kind) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ present = $false; kind = $Kind; value = $null }
  }
  $key = Get-Item -LiteralPath $Path
  if ($key.GetValueNames() -notcontains $Name) {
    return [ordered]@{ present = $false; kind = $Kind; value = $null }
  }
  $value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($Kind -eq 'binary') { $value = [Convert]::ToBase64String([byte[]]$value) }
  elseif ($Kind -eq 'dword') { $value = [int]$value }
  else { $value = [string]$value }
  return [ordered]@{ present = $true; kind = $Kind; value = $value }
}
$result = [ordered]@{
  adapter = '${WINDOWS_SETTINGS_ADAPTER}'
  values = [ordered]@{
    ProxyEnable = Read-StoneValue $internet 'ProxyEnable' 'dword'
    ProxyServer = Read-StoneValue $internet 'ProxyServer' 'string'
    AutoConfigURL = Read-StoneValue $internet 'AutoConfigURL' 'string'
    ProxyOverride = Read-StoneValue $internet 'ProxyOverride' 'string'
    AutoDetect = Read-StoneValue $internet 'AutoDetect' 'dword'
    DefaultConnectionSettings = Read-StoneValue $connections 'DefaultConnectionSettings' 'binary'
    SavedLegacySettings = Read-StoneValue $connections 'SavedLegacySettings' 'binary'
  }
}
$result | ConvertTo-Json -Depth 8 -Compress
`.trim()

export class WindowsSystemProxyPlatformAdapter implements SystemProxyPlatformAdapter {
  private readonly runner: PlatformCommandRunner

  public constructor(options: ConcreteSystemProxyAdapterOptions = {}) {
    this.runner = options.runner ?? defaultPlatformCommandRunner
  }

  public async captureSnapshot(): Promise<SystemProxySnapshot> {
    const result = await runChecked(this.runner, {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CAPTURE_SCRIPT],
      timeoutMs: 10_000,
      operation: 'win32.system-proxy.capture'
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout.trim())
    } catch (error) {
      throw new PlatformProxyCommandError(
        'Windows returned an invalid WinINet proxy snapshot.',
        { file: 'powershell.exe', args: [], operation: 'win32.system-proxy.capture' },
        result,
        { cause: error }
      )
    }
    const settings = parseWindowsSettings(parsed)
    return { platform: 'win32', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public createMixedProxySnapshot(
    original: SystemProxySnapshot,
    target: NormalizedSystemProxyLeaseTarget
  ): SystemProxySnapshot {
    const settings = cloneJson(parseWindowsSnapshot(original))
    const proxyServer = `${windowsHost(target.mixed.host)}:${target.mixed.port}`
    const bypass = target.bypassRules.map(windowsBypassRule).join(';')
    settings.values.ProxyEnable = nativeValue('dword', 1)
    settings.values.ProxyServer = nativeValue('string', proxyServer)
    settings.values.AutoConfigURL = absentNativeValue('string')
    settings.values.ProxyOverride = nativeValue('string', bypass)
    settings.values.AutoDetect = nativeValue('dword', 0)
    const sourceBlob = binaryValue(settings.values.DefaultConnectionSettings)
      ?? binaryValue(settings.values.SavedLegacySettings)
    const connectionBlob = createWinInetConnectionBlob(sourceBlob, proxyServer, bypass)
    settings.values.DefaultConnectionSettings = nativeValue('binary', connectionBlob)
    settings.values.SavedLegacySettings = nativeValue('binary', connectionBlob)
    return { platform: 'win32', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public async applySnapshot(snapshot: SystemProxySnapshot): Promise<void> {
    const settings = parseWindowsSnapshot(snapshot)
    const script = windowsApplyScript(settings)
    await runChecked(this.runner, {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      timeoutMs: 15_000,
      operation: 'win32.system-proxy.apply',
      payload: settings as unknown as ProxySnapshotJson
    })
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    const current = await this.captureSnapshot()
    if (!snapshotsEqual(current, expected)) return 'mismatch'
    await this.applySnapshot(replacement)
    return 'applied'
  }
}

function windowsApplyScript(settings: WindowsProxySettings): string {
  const encoded = Buffer.from(JSON.stringify(settings), 'utf8').toString('base64')
  return String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$internet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$connections = Join-Path $internet 'Connections'
New-Item -Path $internet -Force | Out-Null
New-Item -Path $connections -Force | Out-Null
function Set-StoneValue([string]$Path, [string]$Name, $Entry) {
  if (-not $Entry.present) {
    Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
    return
  }
  if ($Entry.kind -eq 'binary') {
    New-ItemProperty -LiteralPath $Path -Name $Name -Value ([Convert]::FromBase64String([string]$Entry.value)) -PropertyType Binary -Force | Out-Null
  } elseif ($Entry.kind -eq 'dword') {
    New-ItemProperty -LiteralPath $Path -Name $Name -Value ([int]$Entry.value) -PropertyType DWord -Force | Out-Null
  } else {
    New-ItemProperty -LiteralPath $Path -Name $Name -Value ([string]$Entry.value) -PropertyType String -Force | Out-Null
  }
}
Set-StoneValue $internet 'ProxyEnable' $payload.values.ProxyEnable
Set-StoneValue $internet 'ProxyServer' $payload.values.ProxyServer
Set-StoneValue $internet 'AutoConfigURL' $payload.values.AutoConfigURL
Set-StoneValue $internet 'ProxyOverride' $payload.values.ProxyOverride
Set-StoneValue $internet 'AutoDetect' $payload.values.AutoDetect
Set-StoneValue $connections 'DefaultConnectionSettings' $payload.values.DefaultConnectionSettings
Set-StoneValue $connections 'SavedLegacySettings' $payload.values.SavedLegacySettings
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StoneWinInetRefresh {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length);
}
'@
[void][StoneWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][StoneWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`.trim()
}

interface MacManualProxy {
  enabled: boolean
  server: string
  port: number
}

interface MacProxyService {
  name: string
  disabled: boolean
  web?: MacManualProxy
  secureWeb?: MacManualProxy
  socks?: MacManualProxy
  pac?: { enabled: boolean; url: string }
  autoDiscovery?: boolean
  bypass?: string[]
}

interface MacProxySettings {
  adapter: typeof MACOS_SETTINGS_ADAPTER
  services: MacProxyService[]
}

export class MacOsSystemProxyPlatformAdapter implements SystemProxyPlatformAdapter {
  private readonly runner: PlatformCommandRunner

  public constructor(options: ConcreteSystemProxyAdapterOptions = {}) {
    this.runner = options.runner ?? defaultPlatformCommandRunner
  }

  public async captureSnapshot(): Promise<SystemProxySnapshot> {
    const listed = await this.networksetup(['-listallnetworkservices'], 'darwin.system-proxy.list-services')
    const services: MacProxyService[] = []
    for (const entry of parseMacNetworkServices(listed.stdout)) {
      const service: MacProxyService = { name: entry.name, disabled: entry.disabled }
      if (!entry.disabled) {
        service.web = parseMacManualProxy((await this.networksetup(
          ['-getwebproxy', entry.name], 'darwin.system-proxy.get-web'
        )).stdout)
        service.secureWeb = parseMacManualProxy((await this.networksetup(
          ['-getsecurewebproxy', entry.name], 'darwin.system-proxy.get-secure-web'
        )).stdout)
        service.socks = parseMacManualProxy((await this.networksetup(
          ['-getsocksfirewallproxy', entry.name], 'darwin.system-proxy.get-socks'
        )).stdout)
        service.pac = parseMacPac((await this.networksetup(
          ['-getautoproxyurl', entry.name], 'darwin.system-proxy.get-pac'
        )).stdout)
        service.autoDiscovery = parseMacAutoDiscovery((await this.networksetup(
          ['-getproxyautodiscovery', entry.name], 'darwin.system-proxy.get-autodiscovery'
        )).stdout)
        service.bypass = parseMacBypassDomains((await this.networksetup(
          ['-getproxybypassdomains', entry.name], 'darwin.system-proxy.get-bypass'
        )).stdout)
      }
      services.push(service)
    }
    const settings: MacProxySettings = { adapter: MACOS_SETTINGS_ADAPTER, services }
    return { platform: 'darwin', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public createMixedProxySnapshot(
    original: SystemProxySnapshot,
    target: NormalizedSystemProxyLeaseTarget
  ): SystemProxySnapshot {
    const settings = cloneJson(parseMacSnapshot(original))
    for (const service of settings.services) {
      if (service.disabled) continue
      const proxy: MacManualProxy = {
        enabled: true,
        server: target.mixed.host,
        port: target.mixed.port
      }
      service.web = { ...proxy }
      service.secureWeb = { ...proxy }
      service.socks = { ...proxy }
      service.pac = { enabled: false, url: '' }
      service.autoDiscovery = false
      service.bypass = [...target.bypassRules]
    }
    return { platform: 'darwin', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public async applySnapshot(snapshot: SystemProxySnapshot): Promise<void> {
    const settings = parseMacSnapshot(snapshot)
    for (const service of settings.services) {
      if (service.disabled) continue
      await this.applyManualProxy(service.name, 'web', service.web)
      await this.applyManualProxy(service.name, 'secureweb', service.secureWeb)
      await this.applyManualProxy(service.name, 'socksfirewall', service.socks)
      const pac = service.pac ?? { enabled: false, url: '' }
      await this.networksetup(
        ['-setautoproxyurl', service.name, pac.url],
        'darwin.system-proxy.set-pac-url'
      )
      await this.networksetup(
        ['-setautoproxystate', service.name, pac.enabled ? 'on' : 'off'],
        'darwin.system-proxy.set-pac-state'
      )
      await this.networksetup(
        ['-setproxyautodiscovery', service.name, service.autoDiscovery ? 'on' : 'off'],
        'darwin.system-proxy.set-autodiscovery'
      )
      const bypass = service.bypass?.length ? service.bypass : ['Empty']
      await this.networksetup(
        ['-setproxybypassdomains', service.name, ...bypass],
        'darwin.system-proxy.set-bypass'
      )
    }
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    const current = await this.captureSnapshot()
    if (!snapshotsEqual(current, expected)) return 'mismatch'
    await this.applySnapshot(replacement)
    return 'applied'
  }

  private async applyManualProxy(
    service: string,
    kind: 'web' | 'secureweb' | 'socksfirewall',
    proxy: MacManualProxy | undefined
  ): Promise<void> {
    const value = proxy ?? { enabled: false, server: '', port: 0 }
    await this.networksetup(
      [`-set${kind}proxy`, service, value.server, String(value.port)],
      `darwin.system-proxy.set-${kind}`
    )
    await this.networksetup(
      [`-set${kind}proxystate`, service, value.enabled ? 'on' : 'off'],
      `darwin.system-proxy.set-${kind}-state`
    )
  }

  private networksetup(args: readonly string[], operation: string): Promise<PlatformCommandResult> {
    return runChecked(this.runner, {
      file: '/usr/sbin/networksetup',
      args,
      timeoutMs: 10_000,
      operation
    })
  }
}

const GNOME_PROXY_SCHEMAS = Object.freeze({
  'org.gnome.system.proxy': ['mode', 'autoconfig-url', 'ignore-hosts', 'use-same-proxy'],
  'org.gnome.system.proxy.http': ['host', 'port', 'enabled', 'use-authentication'],
  'org.gnome.system.proxy.https': ['host', 'port'],
  'org.gnome.system.proxy.ftp': ['host', 'port'],
  'org.gnome.system.proxy.socks': ['host', 'port']
})

interface GnomeProxySettings {
  adapter: typeof GNOME_SETTINGS_ADAPTER
  schemas: Record<string, Record<string, string>>
}

export interface GnomeSystemProxyAdapterOptions extends ConcreteSystemProxyAdapterOptions {
  desktopEnvironment?: string
}

export class GnomeSystemProxyPlatformAdapter implements SystemProxyPlatformAdapter {
  private readonly runner: PlatformCommandRunner
  private readonly desktopEnvironment?: string

  public constructor(options: GnomeSystemProxyAdapterOptions = {}) {
    this.runner = options.runner ?? defaultPlatformCommandRunner
    this.desktopEnvironment = options.desktopEnvironment
  }

  public async captureSnapshot(): Promise<SystemProxySnapshot> {
    this.assertDesktopEnvironment()
    const schemas: Record<string, Record<string, string>> = {}
    for (const [schema, desiredKeys] of Object.entries(GNOME_PROXY_SCHEMAS)) {
      let availableKeys: Set<string>
      try {
        const result = await this.gsettings(['list-keys', schema], `linux.system-proxy.list-keys.${schema}`)
        availableKeys = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
      } catch (error) {
        if (schema === 'org.gnome.system.proxy') {
          throw new UnsupportedDesktopProxyError(
            'The GNOME system proxy schema is unavailable in this desktop session.',
            { cause: error }
          )
        }
        continue
      }
      const values: Record<string, string> = {}
      for (const key of desiredKeys) {
        if (!availableKeys.has(key)) continue
        const result = await this.gsettings(
          ['get', schema, key],
          `linux.system-proxy.get.${schema}.${key}`
        )
        values[key] = result.stdout.trim()
      }
      schemas[schema] = values
    }
    if (!schemas['org.gnome.system.proxy']?.mode) {
      throw new UnsupportedDesktopProxyError(
        'The current GNOME session does not expose a usable system proxy mode.'
      )
    }
    const settings: GnomeProxySettings = { adapter: GNOME_SETTINGS_ADAPTER, schemas }
    return { platform: 'linux', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public createMixedProxySnapshot(
    original: SystemProxySnapshot,
    target: NormalizedSystemProxyLeaseTarget
  ): SystemProxySnapshot {
    const settings = cloneJson(parseGnomeSnapshot(original))
    setGSettingsValue(settings, 'org.gnome.system.proxy', 'mode', gvariantString('manual'), true)
    setGSettingsValue(settings, 'org.gnome.system.proxy', 'autoconfig-url', gvariantString(''))
    setGSettingsValue(settings, 'org.gnome.system.proxy', 'ignore-hosts', gvariantStringArray(target.bypassRules))
    setGSettingsValue(settings, 'org.gnome.system.proxy', 'use-same-proxy', 'true')
    setGSettingsValue(settings, 'org.gnome.system.proxy.http', 'host', gvariantString(target.mixed.host), true)
    setGSettingsValue(settings, 'org.gnome.system.proxy.http', 'port', String(target.mixed.port), true)
    setGSettingsValue(settings, 'org.gnome.system.proxy.http', 'enabled', 'true')
    setGSettingsValue(settings, 'org.gnome.system.proxy.http', 'use-authentication', 'false')
    for (const schema of [
      'org.gnome.system.proxy.https',
      'org.gnome.system.proxy.ftp',
      'org.gnome.system.proxy.socks'
    ]) {
      setGSettingsValue(settings, schema, 'host', gvariantString(target.mixed.host))
      setGSettingsValue(settings, schema, 'port', String(target.mixed.port))
    }
    return { platform: 'linux', settings: settings as unknown as SystemProxySnapshot['settings'] }
  }

  public async applySnapshot(snapshot: SystemProxySnapshot): Promise<void> {
    this.assertDesktopEnvironment()
    const settings = parseGnomeSnapshot(snapshot)
    for (const [schema, values] of Object.entries(settings.schemas)) {
      for (const [key, rawValue] of Object.entries(values)) {
        await this.gsettings(
          ['set', schema, key, rawValue],
          `linux.system-proxy.set.${schema}.${key}`,
          { schema, key, value: rawValue }
        )
      }
    }
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    const current = await this.captureSnapshot()
    if (!snapshotsEqual(current, expected)) return 'mismatch'
    await this.applySnapshot(replacement)
    return 'applied'
  }

  private assertDesktopEnvironment(): void {
    if (!this.desktopEnvironment) return
    if (!/(^|:)(gnome|unity|budgie)(:|$)/i.test(this.desktopEnvironment)) {
      throw new UnsupportedDesktopProxyError(
        `Desktop '${this.desktopEnvironment}' does not use the supported GNOME system proxy schema.`
      )
    }
  }

  private gsettings(
    args: readonly string[],
    operation: string,
    payload?: ProxySnapshotJson
  ): Promise<PlatformCommandResult> {
    return runChecked(this.runner, {
      file: 'gsettings',
      args,
      timeoutMs: 10_000,
      operation,
      ...(payload === undefined ? {} : { payload })
    })
  }
}

export type TemporaryElevationLauncher = 'windows-uac' | 'macos-sudo' | 'linux-pkexec'

export interface TemporaryElevatedProcessRequest {
  launcher: TemporaryElevationLauncher
  executablePath: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
}

export interface TemporaryElevatedProcessHandle {
  id: string
  pid?: number
  stop(): Promise<void>
}

export interface TemporaryElevationProcessRunner {
  start(request: TemporaryElevatedProcessRequest): Promise<TemporaryElevatedProcessHandle>
}

export interface SingBoxTemporaryTunAdapterOptions {
  platform?: NodeJS.Platform
  executablePath: string
  args?: readonly string[]
  buildArguments?: (bypass: TunBypassPlan) => readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  processRunner?: TemporaryElevationProcessRunner
}

/**
 * Starts sing-box through a one-shot platform elevation mechanism. It retains
 * only process-scoped handles and never installs, starts, or references a
 * privileged service.
 */
export class SingBoxTemporaryTunPlatformAdapter implements TunPlatformAdapter {
  private readonly platform: NodeJS.Platform
  private readonly executablePath: string
  private readonly args: readonly string[]
  private readonly buildArguments?: (bypass: TunBypassPlan) => readonly string[]
  private readonly cwd?: string
  private readonly env?: Readonly<Record<string, string>>
  private readonly processRunner: TemporaryElevationProcessRunner
  private readonly handles = new Map<string, TemporaryElevatedProcessHandle>()

  public constructor(options: SingBoxTemporaryTunAdapterOptions) {
    if (!options.executablePath.trim()) throw new Error('A sing-box executable path is required for TUN elevation.')
    this.platform = options.platform ?? process.platform
    this.executablePath = options.executablePath
    this.args = [...(options.args ?? [])]
    this.buildArguments = options.buildArguments
    this.cwd = options.cwd
    this.env = options.env
    this.processRunner = options.processRunner ?? new NativeTemporaryElevationProcessRunner()
    launcherForPlatform(this.platform)
  }

  public async startTemporaryElevated(
    request: TunPlatformStartRequest
  ): Promise<TunPlatformSession> {
    const args = this.buildArguments
      ? [...this.buildArguments(request.bypass)]
      : [...this.args]
    const handle = await this.processRunner.start({
      launcher: launcherForPlatform(this.platform),
      executablePath: this.executablePath,
      args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.env ? { env: this.env } : {})
    })
    if (!handle.id?.trim() || this.handles.has(handle.id)) {
      await handle.stop().catch(() => undefined)
      throw new Error('The temporary elevation runner returned an invalid or duplicate process handle.')
    }
    this.handles.set(handle.id, handle)
    return { id: handle.id, ...(handle.pid !== undefined ? { pid: handle.pid } : {}) }
  }

  public async stopTemporary(session: TunPlatformSession): Promise<void> {
    const handle = this.handles.get(session.id)
    if (!handle) throw new Error(`Temporary TUN process handle '${session.id}' is no longer available.`)
    await handle.stop()
    this.handles.delete(session.id)
  }

  public isElevationDenied(error: unknown): boolean {
    if (error instanceof TunElevationDeniedError) return true
    if (error === null || typeof error !== 'object') return false
    const value = error as { code?: unknown; errno?: unknown; message?: unknown }
    return value.errno === 1223
      || ['EACCES', 'EPERM', 'ERROR_CANCELLED', 'USER_CANCELLED', 'TUN_ELEVATION_DENIED']
        .includes(String(value.code ?? '').toUpperCase())
      || /cancel(?:led|ed)|declined|not authorized|dismissed/i.test(String(value.message ?? ''))
  }
}

export interface NativeTemporaryElevationProcessRunnerOptions {
  commandRunner?: PlatformCommandRunner
  spawnImplementation?: typeof spawn
  startupObservationMs?: number
  stopTimeoutMs?: number
}

export class NativeTemporaryElevationProcessRunner implements TemporaryElevationProcessRunner {
  private readonly commandRunner: PlatformCommandRunner
  private readonly spawnImplementation: typeof spawn
  private readonly startupObservationMs: number
  private readonly stopTimeoutMs: number

  public constructor(options: NativeTemporaryElevationProcessRunnerOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultPlatformCommandRunner
    this.spawnImplementation = options.spawnImplementation ?? spawn
    this.startupObservationMs = Math.max(0, options.startupObservationMs ?? 150)
    this.stopTimeoutMs = Math.max(250, options.stopTimeoutMs ?? 3_000)
  }

  public async start(
    request: TemporaryElevatedProcessRequest
  ): Promise<TemporaryElevatedProcessHandle> {
    if (request.launcher === 'windows-uac') return this.startWindowsUac(request)
    const unixLauncher: 'macos-sudo' | 'linux-pkexec' = request.launcher
    const launcher = unixLauncher === 'macos-sudo' ? 'sudo' : 'pkexec'
    const args = unixLauncher === 'macos-sudo'
      ? ['-A', '--', request.executablePath, ...request.args]
      : [request.executablePath, ...request.args]
    const child = this.spawnImplementation(launcher, args, {
      cwd: request.cwd,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const stderr: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string | Buffer) => {
      if (stderr.join('').length < 8_000) stderr.push(String(chunk))
    })
    await waitForChildSpawn(child)
    if (this.startupObservationMs > 0) await delay(this.startupObservationMs)
    if (child.exitCode !== null) {
      const detail = stderr.join('').trim()
      if (isNativeElevationDenial(child.exitCode, detail)) throw new TunElevationDeniedError(detail || undefined)
      throw new Error(detail || `${launcher} exited with code ${child.exitCode}.`)
    }
    const pid = child.pid
    const id = `${request.launcher}-${pid ?? 'unknown'}-${randomUUID()}`
    return {
      id,
      ...(pid ? { pid } : {}),
      stop: () => this.stopUnixElevatedProcess(unixLauncher, child, pid)
    }
  }

  private async startWindowsUac(
    request: TemporaryElevatedProcessRequest
  ): Promise<TemporaryElevatedProcessHandle> {
    const payload = {
      file: request.executablePath,
      argumentLine: request.args.map(quoteWindowsArgument).join(' '),
      cwd: request.cwd ?? '',
      environment: request.env ?? {}
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$p.environment.psobject.Properties | ForEach-Object { Set-Item -LiteralPath ('Env:' + $_.Name) -Value ([string]$_.Value) }
$options = @{ FilePath = [string]$p.file; ArgumentList = [string]$p.argumentLine; Verb = 'RunAs'; PassThru = $true; WindowStyle = 'Hidden' }
if ([string]$p.cwd) { $options.WorkingDirectory = [string]$p.cwd }
$child = Start-Process @options
[Console]::Out.WriteLine($child.Id)
`.trim()
    let result: PlatformCommandResult
    try {
      result = await runChecked(this.commandRunner, {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        timeoutMs: 120_000,
        operation: 'tun.windows-uac.start'
      })
    } catch (error) {
      if (isCommandElevationDenial(error)) throw new TunElevationDeniedError(undefined, { cause: error })
      throw error
    }
    const pid = Number(result.stdout.trim().split(/\r?\n/).at(-1))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Windows UAC did not return the elevated sing-box process ID.')
    return {
      id: `windows-uac-${pid}-${randomUUID()}`,
      pid,
      stop: () => this.stopWindowsUac(pid)
    }
  }

  private async stopWindowsUac(pid: number): Promise<void> {
    const inner = `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
    const encodedInner = Buffer.from(inner, 'utf16le').toString('base64')
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encodedInner}' -Verb RunAs -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Elevated TUN stop failed with exit code $($process.ExitCode)." }
`.trim()
    try {
      await runChecked(this.commandRunner, {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        timeoutMs: 120_000,
        operation: 'tun.windows-uac.stop'
      })
    } catch (error) {
      if (isCommandElevationDenial(error)) throw new TunElevationDeniedError(undefined, { cause: error })
      throw error
    }
  }

  private async stopUnixElevatedProcess(
    launcher: 'macos-sudo' | 'linux-pkexec',
    child: ChildProcess,
    pid: number | undefined
  ): Promise<void> {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    if (await waitForChildExit(child, this.stopTimeoutMs)) return
    if (!pid) throw new Error('The elevated TUN process did not expose a PID for forced cleanup.')
    const request: PlatformCommandRequest = launcher === 'macos-sudo'
      ? {
          file: 'sudo',
          args: ['-A', '--', 'kill', '-TERM', String(pid)],
          timeoutMs: 120_000,
          operation: 'tun.macos-sudo.stop'
        }
      : {
          file: 'pkexec',
          args: ['kill', '-TERM', String(pid)],
          timeoutMs: 120_000,
          operation: 'tun.linux-pkexec.stop'
        }
    await runChecked(this.commandRunner, request)
    if (!await waitForChildExit(child, this.stopTimeoutMs)) {
      throw new Error(`Elevated TUN process ${pid} did not exit after cleanup.`)
    }
  }
}

function launcherForPlatform(platform: NodeJS.Platform): TemporaryElevationLauncher {
  if (platform === 'win32') return 'windows-uac'
  if (platform === 'darwin') return 'macos-sudo'
  if (platform === 'linux') return 'linux-pkexec'
  throw new UnsupportedDesktopProxyError(`Temporary TUN elevation is not supported on ${platform}.`)
}

async function runChecked(
  runner: PlatformCommandRunner,
  request: PlatformCommandRequest
): Promise<PlatformCommandResult> {
  let result: PlatformCommandResult
  try {
    result = await runner(request)
  } catch (error) {
    throw new PlatformProxyCommandError(
      `Could not run ${request.operation ?? request.file}.`,
      request,
      undefined,
      { cause: error }
    )
  }
  if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(0, 500)
    throw new PlatformProxyCommandError(
      `${request.operation ?? request.file} failed${detail ? `: ${detail}` : '.'}`,
      request,
      result
    )
  }
  return result
}

function parseWindowsSettings(value: unknown): WindowsProxySettings {
  const root = objectValue(value)
  const values = objectValue(root?.values)
  if (root?.adapter !== WINDOWS_SETTINGS_ADAPTER || !values) throw new Error('Invalid Windows proxy settings.')
  const parsed: Record<string, WindowsNativeValue> = {}
  for (const [name, expectedKind] of Object.entries({
    ProxyEnable: 'dword',
    ProxyServer: 'string',
    AutoConfigURL: 'string',
    ProxyOverride: 'string',
    AutoDetect: 'dword',
    DefaultConnectionSettings: 'binary',
    SavedLegacySettings: 'binary'
  } as const)) {
    const entry = objectValue(values[name])
    if (!entry || typeof entry.present !== 'boolean' || entry.kind !== expectedKind) {
      throw new Error(`Invalid Windows proxy setting ${name}.`)
    }
    if (entry.present) {
      if (expectedKind === 'dword' && !Number.isInteger(entry.value)) throw new Error(`Invalid ${name}.`)
      if (expectedKind !== 'dword' && typeof entry.value !== 'string') throw new Error(`Invalid ${name}.`)
    }
    parsed[name] = {
      present: entry.present,
      kind: expectedKind,
      value: entry.present ? entry.value as number | string : null
    }
  }
  return { adapter: WINDOWS_SETTINGS_ADAPTER, values: parsed }
}

function parseWindowsSnapshot(snapshot: SystemProxySnapshot): WindowsProxySettings {
  if (snapshot.platform !== 'win32') throw new Error('The proxy snapshot does not belong to Windows.')
  return parseWindowsSettings(snapshot.settings)
}

function nativeValue(kind: NativeValueKind, value: number | string): WindowsNativeValue {
  return { present: true, kind, value }
}

function absentNativeValue(kind: NativeValueKind): WindowsNativeValue {
  return { present: false, kind, value: null }
}

function binaryValue(value: WindowsNativeValue | undefined): string | undefined {
  return value?.present && value.kind === 'binary' && typeof value.value === 'string'
    ? value.value
    : undefined
}

function createWinInetConnectionBlob(
  originalBase64: string | undefined,
  proxyServer: string,
  bypass: string
): string {
  let source: Buffer | undefined
  try {
    if (originalBase64) source = Buffer.from(originalBase64, 'base64')
  } catch {
    source = undefined
  }
  const prefix = Buffer.alloc(12)
  prefix.writeUInt32LE(source && source.length >= 4 ? source.readUInt32LE(0) : 70, 0)
  prefix.writeUInt32LE(source && source.length >= 8 ? (source.readUInt32LE(4) + 1) >>> 0 : 1, 4)
  // DIRECT | PROXY. PAC and WPAD flags are deliberately absent.
  prefix.writeUInt32LE(0x03, 8)
  const proxyBytes = Buffer.from(proxyServer, 'utf8')
  const bypassBytes = Buffer.from(bypass, 'utf8')
  const length = (bytes: Buffer): Buffer => {
    const output = Buffer.alloc(4)
    output.writeUInt32LE(bytes.length, 0)
    return output
  }
  return Buffer.concat([
    prefix,
    length(proxyBytes), proxyBytes,
    length(bypassBytes), bypassBytes,
    Buffer.alloc(4),
    Buffer.alloc(32)
  ]).toString('base64')
}

function windowsBypassRule(rule: string): string {
  if (rule === '127.0.0.0/8') return '127.*'
  if (rule === '::1') return '[::1]'
  return rule
}

function windowsHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function parseMacNetworkServices(value: string): Array<{ name: string; disabled: boolean }> {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^An asterisk \(\*\)/i.test(line))
    .map((line) => ({
      disabled: line.startsWith('*'),
      name: line.replace(/^\*\s*/, '').trim()
    }))
    .filter((service) => Boolean(service.name))
}

function parseMacManualProxy(value: string): MacManualProxy {
  const fields = parseLabelledOutput(value)
  const port = Number(fields.Port ?? 0)
  return {
    enabled: yesValue(fields.Enabled),
    server: fields.Server ?? '',
    port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0
  }
}

function parseMacPac(value: string): { enabled: boolean; url: string } {
  const fields = parseLabelledOutput(value)
  return { enabled: yesValue(fields.Enabled), url: fields.URL ?? '' }
}

function parseMacAutoDiscovery(value: string): boolean {
  const fields = parseLabelledOutput(value)
  return yesValue(fields['Auto Proxy Discovery'])
}

function parseMacBypassDomains(value: string): string[] {
  if (/There aren't any bypass domains set/i.test(value)) return []
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function parseLabelledOutput(value: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return fields
}

function yesValue(value: string | undefined): boolean {
  return /^(yes|on|1|true)$/i.test(value ?? '')
}

function parseMacSnapshot(snapshot: SystemProxySnapshot): MacProxySettings {
  if (snapshot.platform !== 'darwin') throw new Error('The proxy snapshot does not belong to macOS.')
  const root = objectValue(snapshot.settings)
  if (root?.adapter !== MACOS_SETTINGS_ADAPTER || !Array.isArray(root.services)) {
    throw new Error('Invalid macOS proxy settings.')
  }
  for (const service of root.services) {
    const item = objectValue(service)
    if (!item || typeof item.name !== 'string' || typeof item.disabled !== 'boolean') {
      throw new Error('Invalid macOS network service proxy settings.')
    }
  }
  return cloneJson(root as unknown as MacProxySettings)
}

function parseGnomeSnapshot(snapshot: SystemProxySnapshot): GnomeProxySettings {
  if (snapshot.platform !== 'linux') throw new Error('The proxy snapshot does not belong to Linux.')
  const root = objectValue(snapshot.settings)
  const schemas = objectValue(root?.schemas)
  if (root?.adapter !== GNOME_SETTINGS_ADAPTER || !schemas) throw new Error('Invalid GNOME proxy settings.')
  const parsed: Record<string, Record<string, string>> = {}
  for (const [schema, rawValues] of Object.entries(schemas)) {
    const values = objectValue(rawValues)
    if (!values) throw new Error(`Invalid GNOME proxy schema ${schema}.`)
    parsed[schema] = {}
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') throw new Error(`Invalid GNOME proxy value ${schema}.${key}.`)
      parsed[schema][key] = value
    }
  }
  return { adapter: GNOME_SETTINGS_ADAPTER, schemas: parsed }
}

function setGSettingsValue(
  settings: GnomeProxySettings,
  schema: string,
  key: string,
  value: string,
  required = false
): void {
  const values = settings.schemas[schema]
  if (!values || !(key in values)) {
    if (required) throw new UnsupportedDesktopProxyError(`GNOME proxy key ${schema}.${key} is unavailable.`)
    return
  }
  values[key] = value
}

function gvariantString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function gvariantStringArray(values: readonly string[]): string {
  return `[${values.map(gvariantString).join(', ')}]`
}

function snapshotsEqual(left: SystemProxySnapshot, right: SystemProxySnapshot): boolean {
  return stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = objectValue(value)
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
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

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
    const onExit = (): void => { cleanup(); resolve(true) }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

function isNativeElevationDenial(exitCode: number | null, stderr: string): boolean {
  return exitCode === 126
    || exitCode === 127
    || /cancel(?:led|ed)|declined|not authorized|dismissed/i.test(stderr)
}

function isCommandElevationDenial(error: unknown): boolean {
  if (error instanceof TunElevationDeniedError) return true
  if (error === null || typeof error !== 'object') return false
  const value = error as { exitCode?: unknown; message?: unknown; cause?: unknown }
  return value.exitCode === 1223
    || /cancel(?:led|ed)|declined|not authorized|dismissed|1223/i.test(String(value.message ?? ''))
    || (value.cause !== undefined && isCommandElevationDenial(value.cause))
}
