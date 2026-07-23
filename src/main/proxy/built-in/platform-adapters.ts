import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const MAX_ELEVATION_STDERR_LENGTH = 8_000

export interface PlatformCommandRequest {
  file: string
  args: readonly string[]
  /** Optional standard input. Keep large or sensitive payloads out of argv. */
  input?: string
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
  new Promise<PlatformCommandResult>((resolve, reject) => {
    let settled = false
    const child = execFile(
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
        if (settled) return
        settled = true
        const numericCode = error && typeof error.code === 'number' ? error.code : undefined
        resolve({
          exitCode: error ? numericCode ?? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || error?.message || '')
        })
      }
    )
    const stdin = child.stdin
    if (!stdin) return
    const failInput = (error: unknown): void => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* The failed pipe normally means the child already exited. */ }
      reject(new PlatformProxyCommandError(
        `Could not write standard input for ${request.operation ?? request.file}.`,
        request,
        undefined,
        { cause: error }
      ))
    }
    stdin.once('error', failInput)
    try {
      stdin.end(request.input ?? '')
    } catch (error) {
      failInput(error)
    }
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
    await runChecked(this.runner, {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_APPLY_SCRIPT],
      input: JSON.stringify(settings),
      timeoutMs: 15_000,
      operation: 'win32.system-proxy.apply',
      payload: settings as unknown as ProxySnapshotJson
    })
  }

  public async isSnapshotApplied(snapshot: SystemProxySnapshot): Promise<boolean> {
    const expected = parseWindowsSnapshot(snapshot)
    const observed = parseWindowsSnapshot(await this.captureSnapshot())
    return windowsTakeoverMatches(observed, expected)
  }

  public async compareAndApplySnapshot(
    expected: SystemProxySnapshot,
    replacement: SystemProxySnapshot
  ): Promise<SystemProxyCompareResult> {
    const expectedSettings = parseWindowsSnapshot(expected)
    const replacementSettings = parseWindowsSnapshot(replacement)
    const result = await runChecked(this.runner, {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_COMPARE_AND_APPLY_SCRIPT
      ],
      input: JSON.stringify({ expected: expectedSettings, replacement: replacementSettings }),
      timeoutMs: 15_000,
      operation: 'win32.system-proxy.compare-apply',
      payload: {
        expected: expectedSettings as unknown as ProxySnapshotJson,
        replacement: replacementSettings as unknown as ProxySnapshotJson
      }
    })
    const outcome = result.stdout.trim()
    if (outcome === 'applied' || outcome === 'partial' || outcome === 'mismatch') {
      const observed = parseWindowsSnapshot(await this.captureSnapshot())
      if (outcome === 'applied' && windowsTakeoverMatches(observed, replacementSettings)) {
        return 'applied'
      }
      // WinINet or another proxy manager may normalize dormant values after
      // the refresh (for example a remembered ProxyServer while disabled).
      // That is a partial/preserved restore, but it is terminally safe once no
      // Stone+ endpoint survives in either the scalar or connection blobs.
      if (!windowsOwnsSnapshotMarker(observed, expectedSettings)) {
        return outcome === 'applied' ? 'partial' : outcome
      }
      throw new PlatformProxyCommandError(
        'Windows did not retain a safe system-proxy restore result.',
        { file: 'powershell.exe', args: [], operation: 'win32.system-proxy.compare-verify' },
        result
      )
    }
    throw new PlatformProxyCommandError(
      'Windows returned an invalid system-proxy compare-and-apply result.',
      { file: 'powershell.exe', args: [], operation: 'win32.system-proxy.compare-apply' },
      result
    )
  }
}

const WINDOWS_APPLY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payloadText)) { throw 'Missing Stone+ proxy payload.' }
$payload = $payloadText | ConvertFrom-Json
$internet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$connections = Join-Path $internet 'Connections'
function Read-StoneValue([string]$Path, [string]$Name, [string]$Kind) {
  if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ present = $false; kind = $Kind; value = $null } }
  $key = Get-Item -LiteralPath $Path
  if ($key.GetValueNames() -notcontains $Name) { return [ordered]@{ present = $false; kind = $Kind; value = $null } }
  $value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($Kind -eq 'binary') { $value = [Convert]::ToBase64String([byte[]]$value) }
  elseif ($Kind -eq 'dword') { $value = [int]$value }
  else { $value = [string]$value }
  return [ordered]@{ present = $true; kind = $Kind; value = $value }
}
function Same-StoneValue($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right) { return $false }
  if ([bool]$Left.present -ne [bool]$Right.present) { return $false }
  if ([string]$Left.kind -cne [string]$Right.kind) { return $false }
  if (-not [bool]$Left.present) { return $true }
  if ([string]$Left.kind -eq 'dword') { return [int64]$Left.value -eq [int64]$Right.value }
  return [string]$Left.value -ceq [string]$Right.value
}
function Set-StoneValue([string]$Path, [string]$Name, $Entry) {
  if (-not $Entry.present) {
    if (Test-Path -LiteralPath $Path) {
      $key = Get-Item -LiteralPath $Path
      if ($key.GetValueNames() -contains $Name) {
        Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
      }
    }
  } else {
    New-Item -Path $Path -Force | Out-Null
    if ($Entry.kind -eq 'binary') {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([Convert]::FromBase64String([string]$Entry.value)) -PropertyType Binary -Force | Out-Null
    } elseif ($Entry.kind -eq 'dword') {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([int]$Entry.value) -PropertyType DWord -Force | Out-Null
    } else {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([string]$Entry.value) -PropertyType String -Force | Out-Null
    }
  }
  $observed = Read-StoneValue $Path $Name ([string]$Entry.kind)
  if (-not (Same-StoneValue $observed $Entry)) {
    throw "Windows did not retain the Stone+ registry value '$Name'."
  }
}

# Write the composite connection state first and ProxyEnable last. Consumers
# can therefore never observe an enabled proxy paired with the previous route.
Set-StoneValue $connections 'DefaultConnectionSettings' $payload.values.DefaultConnectionSettings
Set-StoneValue $connections 'SavedLegacySettings' $payload.values.SavedLegacySettings
Set-StoneValue $internet 'ProxyServer' $payload.values.ProxyServer
Set-StoneValue $internet 'AutoConfigURL' $payload.values.AutoConfigURL
Set-StoneValue $internet 'ProxyOverride' $payload.values.ProxyOverride
Set-StoneValue $internet 'AutoDetect' $payload.values.AutoDetect
Set-StoneValue $internet 'ProxyEnable' $payload.values.ProxyEnable
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StoneWinInetRefresh {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length);
}
'@
if (-not [StoneWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)) {
  throw "WinINet rejected INTERNET_OPTION_SETTINGS_CHANGED ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
}
if (-not [StoneWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)) {
  throw "WinINet rejected INTERNET_OPTION_REFRESH ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
}
# A notification can wake another proxy manager. Re-read the ownership marker
# after the broadcast so a competing writer cannot produce a false success.
foreach ($name in @('ProxyEnable','ProxyServer','AutoConfigURL','ProxyOverride','AutoDetect')) {
  $observed = Read-StoneValue $internet $name ([string]$payload.values.$name.kind)
  if (-not (Same-StoneValue $observed $payload.values.$name)) {
    throw "Windows changed the Stone+ proxy value '$name' during activation."
  }
}
`.trim()

const WINDOWS_COMPARE_AND_APPLY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payloadText)) { throw 'Missing Stone+ compare payload.' }
$payload = $payloadText | ConvertFrom-Json
$internet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$connections = Join-Path $internet 'Connections'
function Read-StoneValue([string]$Path, [string]$Name, [string]$Kind) {
  if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ present = $false; kind = $Kind; value = $null } }
  $key = Get-Item -LiteralPath $Path
  if ($key.GetValueNames() -notcontains $Name) { return [ordered]@{ present = $false; kind = $Kind; value = $null } }
  $value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($Kind -eq 'binary') { $value = [Convert]::ToBase64String([byte[]]$value) }
  elseif ($Kind -eq 'dword') { $value = [int]$value }
  else { $value = [string]$value }
  return [ordered]@{ present = $true; kind = $Kind; value = $value }
}
function Same-StoneValue($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right) { return $false }
  if ([bool]$Left.present -ne [bool]$Right.present) { return $false }
  if ([string]$Left.kind -cne [string]$Right.kind) { return $false }
  if (-not [bool]$Left.present) { return $true }
  if ([string]$Left.kind -eq 'dword') { return [int64]$Left.value -eq [int64]$Right.value }
  return [string]$Left.value -ceq [string]$Right.value
}

function Read-StoneBlobField([byte[]]$Bytes, [ref]$Offset) {
  if ($Offset.Value -lt 0 -or $Offset.Value + 4 -gt $Bytes.Length) { throw 'Invalid connection blob length.' }
  $length = [BitConverter]::ToUInt32($Bytes, $Offset.Value)
  $Offset.Value += 4
  if ([uint64]$length -gt [uint64]($Bytes.Length - $Offset.Value)) { throw 'Invalid connection blob field.' }
  $field = New-Object byte[] ([int]$length)
  if ($length -gt 0) { [Array]::Copy($Bytes, $Offset.Value, $field, 0, [int]$length) }
  $Offset.Value += [int]$length
  return [Convert]::ToBase64String($field)
}

function Parse-StoneConnectionBlob($Entry) {
  if ($null -eq $Entry -or -not [bool]$Entry.present -or [string]$Entry.kind -ne 'binary') { return $null }
  try {
    $bytes = [Convert]::FromBase64String([string]$Entry.value)
    if ($bytes.Length -lt 24) { return $null }
    $offset = 12
    $proxy = Read-StoneBlobField $bytes ([ref]$offset)
    $bypass = Read-StoneBlobField $bytes ([ref]$offset)
    $pac = Read-StoneBlobField $bytes ([ref]$offset)
    $tail = New-Object byte[] ($bytes.Length - $offset)
    if ($tail.Length -gt 0) { [Array]::Copy($bytes, $offset, $tail, 0, $tail.Length) }
    return [pscustomobject]@{
      version = [BitConverter]::ToUInt32($bytes, 0)
      counter = [BitConverter]::ToUInt32($bytes, 4)
      flags = [BitConverter]::ToUInt32($bytes, 8)
      proxy = $proxy
      bypass = $bypass
      pac = $pac
      tail = [Convert]::ToBase64String($tail)
    }
  } catch { return $null }
}

function New-StoneConnectionEntry($Blob) {
  $stream = New-Object IO.MemoryStream
  $writer = New-Object IO.BinaryWriter($stream)
  try {
    $writer.Write([uint32]$Blob.version)
    $writer.Write([uint32]$Blob.counter)
    $writer.Write([uint32]$Blob.flags)
    foreach ($name in @('proxy','bypass','pac')) {
      $bytes = [Convert]::FromBase64String([string]$Blob.$name)
      $writer.Write([uint32]$bytes.Length)
      if ($bytes.Length -gt 0) { $writer.Write([byte[]]$bytes) }
    }
    $tail = [Convert]::FromBase64String([string]$Blob.tail)
    if ($tail.Length -gt 0) { $writer.Write([byte[]]$tail) }
    $writer.Flush()
    return [pscustomobject]@{
      present = $true
      kind = 'binary'
      value = [Convert]::ToBase64String($stream.ToArray())
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

function Test-StoneConnectionOwnership($Current, $Expected) {
  $currentBlob = Parse-StoneConnectionBlob $Current
  $expectedBlob = Parse-StoneConnectionBlob $Expected
  return ($null -ne $currentBlob -and $null -ne $expectedBlob -and
    [string]$expectedBlob.proxy -ne '' -and
    [string]$currentBlob.proxy -ceq [string]$expectedBlob.proxy)
}

function Merge-StoneConnectionBlob($Current, $Expected, $Replacement) {
  if (Same-StoneValue $Current $Expected) {
    return [pscustomobject]@{
      entry = $Replacement
      changed = -not (Same-StoneValue $Current $Replacement)
      preserved = $false
    }
  }
  if (Same-StoneValue $Current $Replacement) {
    return [pscustomobject]@{ entry = $Current; changed = $false; preserved = $false }
  }
  $currentBlob = Parse-StoneConnectionBlob $Current
  $expectedBlob = Parse-StoneConnectionBlob $Expected
  $replacementBlob = Parse-StoneConnectionBlob $Replacement
  if ($null -eq $currentBlob -or $null -eq $expectedBlob -or $null -eq $replacementBlob) {
    return [pscustomobject]@{ entry = $Current; changed = $false; preserved = $true }
  }
  $output = [ordered]@{}
  $preserved = $false
  foreach ($name in @('version','counter','flags','proxy','bypass','pac','tail')) {
    $observed = [string]$currentBlob.$name
    $owned = [string]$expectedBlob.$name
    $original = [string]$replacementBlob.$name
    if ($observed -ceq $owned) { $output[$name] = $replacementBlob.$name }
    elseif ($observed -ceq $original) { $output[$name] = $currentBlob.$name }
    else { $output[$name] = $currentBlob.$name; $preserved = $true }
  }
  $entry = New-StoneConnectionEntry ([pscustomobject]$output)
  return [pscustomobject]@{
    entry = $entry
    changed = -not (Same-StoneValue $Current $entry)
    preserved = $preserved
  }
}

function Set-StoneValue([string]$Path, [string]$Name, $Entry) {
  if (-not [bool]$Entry.present) {
    if (Test-Path -LiteralPath $Path) {
      $key = Get-Item -LiteralPath $Path
      if ($key.GetValueNames() -contains $Name) {
        Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
      }
    }
  } else {
    New-Item -Path $Path -Force | Out-Null
    if ($Entry.kind -eq 'binary') {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([Convert]::FromBase64String([string]$Entry.value)) -PropertyType Binary -Force | Out-Null
    } elseif ($Entry.kind -eq 'dword') {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([int]$Entry.value) -PropertyType DWord -Force | Out-Null
    } else {
      New-ItemProperty -LiteralPath $Path -Name $Name -Value ([string]$Entry.value) -PropertyType String -Force | Out-Null
    }
  }
  $observed = Read-StoneValue $Path $Name ([string]$Entry.kind)
  if (-not (Same-StoneValue $observed $Entry)) {
    throw "Windows did not retain the Stone+ registry value '$Name'."
  }
}

function Publish-StoneProxySettings {
  if ($null -eq ('StoneWinInetCompareRefresh' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class StoneWinInetCompareRefresh { [DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length); }' | Out-Null
  }
  if (-not [StoneWinInetCompareRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)) {
    throw "WinINet rejected INTERNET_OPTION_SETTINGS_CHANGED ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
  }
  if (-not [StoneWinInetCompareRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)) {
    throw "WinINet rejected INTERNET_OPTION_REFRESH ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
  }
}

$current = [ordered]@{
  ProxyEnable = Read-StoneValue $internet 'ProxyEnable' 'dword'
  ProxyServer = Read-StoneValue $internet 'ProxyServer' 'string'
  AutoConfigURL = Read-StoneValue $internet 'AutoConfigURL' 'string'
  ProxyOverride = Read-StoneValue $internet 'ProxyOverride' 'string'
  AutoDetect = Read-StoneValue $internet 'AutoDetect' 'dword'
  DefaultConnectionSettings = Read-StoneValue $connections 'DefaultConnectionSettings' 'binary'
  SavedLegacySettings = Read-StoneValue $connections 'SavedLegacySettings' 'binary'
}
$allRestored = $true
foreach ($name in @('ProxyEnable','ProxyServer','AutoConfigURL','ProxyOverride','AutoDetect','DefaultConnectionSettings','SavedLegacySettings')) {
  if (-not (Same-StoneValue $current[$name] $payload.replacement.values.$name)) {
    $allRestored = $false
    break
  }
}
if ($allRestored) {
  Publish-StoneProxySettings
  Write-Output 'applied'
  exit 0
}
$expectedProxyServer = $payload.expected.values.ProxyServer
$ownsStone = (
  ([bool]$expectedProxyServer.present -and [string]$expectedProxyServer.value -ne '' -and
    (Same-StoneValue $current.ProxyServer $expectedProxyServer)) -or
  (Test-StoneConnectionOwnership $current.DefaultConnectionSettings $payload.expected.values.DefaultConnectionSettings) -or
  (Test-StoneConnectionOwnership $current.SavedLegacySettings $payload.expected.values.SavedLegacySettings)
)
if (-not $ownsStone) {
  Write-Output 'mismatch'
  exit 0
}
$changed = $false
$preserved = $false

# Restore non-marker scalar values first. A surviving endpoint marker keeps a
# failed operation retryable without claiming ownership of unrelated settings.
foreach ($name in @('ProxyEnable','AutoConfigURL','ProxyOverride','AutoDetect')) {
  $latest = Read-StoneValue $internet $name ([string]$payload.expected.values.$name.kind)
  if (Same-StoneValue $latest $payload.expected.values.$name) {
    if (-not (Same-StoneValue $latest $payload.replacement.values.$name)) {
      Set-StoneValue $internet $name $payload.replacement.values.$name
      $changed = $true
    }
  } elseif (-not (Same-StoneValue $latest $payload.replacement.values.$name)) {
    $preserved = $true
  }
}

# ConnectionSettings is a composite value. Merge its flags, proxy, bypass,
# PAC, sequence/header, and opaque tail independently; never replace a blob
# merely because the Stone+ endpoint is still present inside it.
foreach ($name in @('DefaultConnectionSettings','SavedLegacySettings')) {
  $latest = Read-StoneValue $connections $name 'binary'
  $merge = Merge-StoneConnectionBlob $latest $payload.expected.values.$name $payload.replacement.values.$name
  if ([bool]$merge.preserved) { $preserved = $true }
  if ([bool]$merge.changed) {
    Set-StoneValue $connections $name $merge.entry
    $changed = $true
  }
}

# The top-level endpoint is the final ownership marker to be released.
$latestProxyServer = Read-StoneValue $internet 'ProxyServer' 'string'
if (Same-StoneValue $latestProxyServer $payload.expected.values.ProxyServer) {
  if (-not (Same-StoneValue $latestProxyServer $payload.replacement.values.ProxyServer)) {
    Set-StoneValue $internet 'ProxyServer' $payload.replacement.values.ProxyServer
    $changed = $true
  }
} elseif (-not (Same-StoneValue $latestProxyServer $payload.replacement.values.ProxyServer)) {
  $preserved = $true
}

if ($changed) {
  try {
    Publish-StoneProxySettings
  } catch {
    # Keep the ownership marker when possible so a failed notification remains
    # retryable instead of clearing the recovery journal on the next attempt.
    $observedProxyServer = Read-StoneValue $internet 'ProxyServer' 'string'
    if (Same-StoneValue $observedProxyServer $payload.replacement.values.ProxyServer) {
      Set-StoneValue $internet 'ProxyServer' $payload.expected.values.ProxyServer
    }
    throw
  }
}
Write-Output $(if ($preserved) { 'partial' } else { 'applied' })
`.trim()

interface MacManualProxy {
  enabled: boolean
  server: string
  port: number
  /** Undefined means networksetup did not expose enough state to replay auth safely. */
  authenticated?: boolean
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
    assertMacAuthenticationReplayable(settings)
    for (const service of settings.services) {
      if (service.disabled) continue
      const proxy: MacManualProxy = {
        enabled: true,
        server: target.mixed.host,
        port: target.mixed.port,
        authenticated: false
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
    assertMacAuthenticationReplayable(settings)
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
    const current = parseMacSnapshot(await this.captureSnapshot())
    const expectedSettings = normalizeMacRecoveryAuthentication(parseMacSnapshot(expected))
    const replacementSettings = normalizeMacRecoveryAuthentication(parseMacSnapshot(replacement))
    const restore = mergeMacOwnedRestore(
      current,
      expectedSettings,
      replacementSettings
    )
    if (!restore) return 'mismatch'
    await this.applyMacOwnedRestore(current, restore.settings)
    return restore.partial ? 'partial' : 'applied'
  }

  private async applyMacOwnedRestore(
    current: MacProxySettings,
    replacement: MacProxySettings
  ): Promise<void> {
    const currentByName = new Map(current.services.map((service) => [service.name, service]))
    const changes = replacement.services.flatMap((service) => {
      const observed = currentByName.get(service.name)
      return !observed || observed.disabled || service.disabled ? [] : [{ observed, service }]
    })

    // Reject before the first setter. Calling networksetup's four-argument
    // -set*proxy form would silently discard credentials which its getter does
    // not expose, so an authenticated/unknown target is never replayed.
    for (const { observed, service } of changes) {
      for (const key of ['web', 'secureWeb', 'socks'] as const) {
        const before = observed[key]
        const after = service[key]
        if (!before || !after || (before.server === after.server && before.port === after.port)) continue
        if (after.authenticated !== false) {
          throw new UnsupportedDesktopProxyError(
            `Cannot safely restore authenticated proxy credentials for macOS service '${service.name}'.`
          )
        }
      }
    }

    // Non-marker settings go first. Only fields selected by the compare are
    // written, avoiding a stale capture overwriting independently changed data.
    for (const { observed, service } of changes) {
      const beforePac = observed.pac ?? { enabled: false, url: '' }
      const afterPac = service.pac ?? { enabled: false, url: '' }
      if (beforePac.url !== afterPac.url) {
        await this.networksetup(
          ['-setautoproxyurl', service.name, afterPac.url],
          'darwin.system-proxy.restore-pac-url'
        )
      }
      if (beforePac.enabled !== afterPac.enabled) {
        await this.networksetup(
          ['-setautoproxystate', service.name, afterPac.enabled ? 'on' : 'off'],
          'darwin.system-proxy.restore-pac-state'
        )
      }
      if (observed.autoDiscovery !== service.autoDiscovery) {
        await this.networksetup(
          ['-setproxyautodiscovery', service.name, service.autoDiscovery ? 'on' : 'off'],
          'darwin.system-proxy.restore-autodiscovery'
        )
      }
      if (stableJson(observed.bypass) !== stableJson(service.bypass)) {
        const bypass = service.bypass?.length ? service.bypass : ['Empty']
        await this.networksetup(
          ['-setproxybypassdomains', service.name, ...bypass],
          'darwin.system-proxy.restore-bypass'
        )
      }
    }

    // Restore enablement before endpoints, then release endpoint ownership as
    // the final commands. A mid-sequence failure therefore remains retryable.
    for (const { observed, service } of changes) {
      for (const [key, kind] of [
        ['web', 'web'],
        ['secureWeb', 'secureweb'],
        ['socks', 'socksfirewall']
      ] as const) {
        const before = observed[key] ?? { enabled: false, server: '', port: 0, authenticated: false }
        const after = service[key] ?? { enabled: false, server: '', port: 0, authenticated: false }
        if (before.enabled !== after.enabled) {
          await this.networksetup(
            [`-set${kind}proxystate`, service.name, after.enabled ? 'on' : 'off'],
            `darwin.system-proxy.restore-${kind}-state`
          )
        }
      }
    }
    for (const { observed, service } of changes) {
      for (const [key, kind] of [
        ['web', 'web'],
        ['secureWeb', 'secureweb'],
        ['socks', 'socksfirewall']
      ] as const) {
        const before = observed[key]
        const after = service[key]
        if (!before || !after || (before.server === after.server && before.port === after.port)) continue
        await this.networksetup(
          [`-set${kind}proxy`, service.name, after.server, String(after.port)],
          `darwin.system-proxy.restore-${kind}`
        )
      }
    }
  }

  private async applyManualProxy(
    service: string,
    kind: 'web' | 'secureweb' | 'socksfirewall',
    proxy: MacManualProxy | undefined
  ): Promise<void> {
    const value = proxy ?? { enabled: false, server: '', port: 0, authenticated: false }
    if (value.authenticated !== false) {
      throw new UnsupportedDesktopProxyError(
        `Cannot safely apply authenticated proxy credentials for macOS service '${service}'.`
      )
    }
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
    const current = parseGnomeSnapshot(await this.captureSnapshot())
    const restore = mergeGnomeOwnedRestore(
      current,
      parseGnomeSnapshot(expected),
      parseGnomeSnapshot(replacement)
    )
    if (!restore) return 'mismatch'
    await this.applyGnomeOwnedRestore(current, restore.settings)
    return restore.partial ? 'partial' : 'applied'
  }

  private async applyGnomeOwnedRestore(
    current: GnomeProxySettings,
    replacement: GnomeProxySettings
  ): Promise<void> {
    const changes: Array<{ schema: string; key: string; value: string }> = []
    for (const [schema, values] of Object.entries(replacement.schemas)) {
      const observed = current.schemas[schema]
      if (!observed) continue
      for (const [key, value] of Object.entries(values)) {
        if (observed[key] !== value) changes.push({ schema, key, value })
      }
    }
    const isEndpoint = (change: { schema: string; key: string }): boolean => (
      change.schema !== 'org.gnome.system.proxy'
      && (change.key === 'host' || change.key === 'port')
    )
    const isMode = (change: { schema: string; key: string }): boolean => (
      change.schema === 'org.gnome.system.proxy' && change.key === 'mode'
    )
    const ordered = [
      ...changes.filter((change) => !isEndpoint(change) && !isMode(change)),
      ...changes.filter(isMode),
      ...changes.filter(isEndpoint)
    ]
    for (const change of ordered) {
      await this.gsettings(
        ['set', change.schema, change.key, change.value],
        `linux.system-proxy.restore.${change.schema}.${change.key}`,
        change
      )
    }
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
  /** Resolves exactly once for early or late exits and never rejects. */
  exit?: Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    /** Bounded native-launcher diagnostics used only for startup classification. */
    stderr?: string
  }>
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
    return {
      id: handle.id,
      ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
      ...(handle.exit ? { exit: handle.exit } : {})
    }
  }

  public async stopTemporary(session: TunPlatformSession): Promise<void> {
    const handle = this.handles.get(session.id)
    if (!handle) throw new Error(`Temporary TUN process handle '${session.id}' is no longer available.`)
    await handle.stop()
    this.handles.delete(session.id)
  }

  /** Sidecars can subscribe immediately and transition routing fail-closed on a late exit. */
  public observeTemporaryExit(
    session: TunPlatformSession
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined {
    return this.handles.get(session.id)?.exit
  }

  public isElevationDenied(error: unknown): boolean {
    if (error instanceof TunElevationDeniedError) return true
    if (error === null || typeof error !== 'object') return false
    const value = error as { code?: unknown; errno?: unknown; message?: unknown }
    return value.errno === 1223
      || ['EACCES', 'EPERM', 'ERROR_CANCELLED', 'USER_CANCELLED', 'TUN_ELEVATION_DENIED']
        .includes(String(value.code ?? '').toUpperCase())
      || /cancel(?:led|ed)|declined|not authorized|dismissed|no password|password.*required|authentication fail/i
        .test(String(value.message ?? ''))
  }
}

export interface NativeTemporaryElevationProcessRunnerOptions {
  commandRunner?: PlatformCommandRunner
  spawnImplementation?: typeof spawn
  /** @deprecated Readiness is established by the authenticated controller health check. */
  startupObservationMs?: number
  stopTimeoutMs?: number
}

export class NativeTemporaryElevationProcessRunner implements TemporaryElevationProcessRunner {
  private readonly commandRunner: PlatformCommandRunner
  private readonly spawnImplementation: typeof spawn
  private readonly stopTimeoutMs: number

  public constructor(options: NativeTemporaryElevationProcessRunnerOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultPlatformCommandRunner
    this.spawnImplementation = options.spawnImplementation ?? spawn
    this.stopTimeoutMs = Math.max(250, options.stopTimeoutMs ?? 3_000)
  }

  public async start(
    request: TemporaryElevatedProcessRequest
  ): Promise<TemporaryElevatedProcessHandle> {
    if (request.launcher === 'windows-uac') return this.startWindowsUac(request)
    const unixLauncher: 'macos-sudo' | 'linux-pkexec' = request.launcher
    const launcher = unixLauncher === 'macos-sudo' ? 'sudo' : 'pkexec'
    const askpass = unixLauncher === 'macos-sudo' ? await createMacOsAskpass() : undefined
    const args = unixLauncher === 'macos-sudo'
      ? ['-A', '-k', '--', request.executablePath, ...request.args]
      : [request.executablePath, ...request.args]
    let child: ChildProcess
    try {
      child = this.spawnImplementation(launcher, args, {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...request.env,
          ...(askpass ? { SUDO_ASKPASS: askpass.path } : {})
        },
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (error) {
      await askpass?.cleanup()
      throw error
    }
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string | Buffer) => {
      if (stderr.length >= MAX_ELEVATION_STDERR_LENGTH) return
      stderr += String(chunk).slice(0, MAX_ELEVATION_STDERR_LENGTH - stderr.length)
    })
    const exit = observeChildExit(child, () => stderr)
    if (askpass) void exit.then(() => askpass.cleanup().catch(() => undefined))
    try {
      await waitForChildSpawn(child)
    } catch (error) {
      await askpass?.cleanup()
      throw error
    }
    if (child.exitCode !== null) {
      const detail = stderr.trim()
      await askpass?.cleanup()
      if (isNativeElevationDenial(child.exitCode, detail)) throw new TunElevationDeniedError(detail || undefined)
      throw new Error(detail || `${launcher} exited with code ${child.exitCode}.`)
    }
    const pid = child.pid
    const id = `${request.launcher}-${pid ?? 'unknown'}-${randomUUID()}`
    return {
      id,
      ...(pid ? { pid } : {}),
      exit,
      stop: async () => {
        try {
          await this.stopUnixElevatedProcess(unixLauncher, child, pid)
        } finally {
          await askpass?.cleanup()
        }
      }
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
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payloadText)) { throw 'Missing Stone+ elevation payload.' }
$p = $payloadText | ConvertFrom-Json
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
        input: JSON.stringify(payload),
        timeoutMs: 120_000,
        operation: 'tun.windows-uac.start'
      })
    } catch (error) {
      if (isCommandElevationDenial(error)) throw new TunElevationDeniedError(undefined, { cause: error })
      throw error
    }
    const pid = Number(result.stdout.trim().split(/\r?\n/).at(-1))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Windows UAC did not return the elevated sing-box process ID.')
    const exit = observeProcessIdExit(pid)
    return {
      id: `windows-uac-${pid}-${randomUUID()}`,
      pid,
      exit,
      stop: () => this.stopWindowsUac(pid)
    }
  }

  private async stopWindowsUac(pid: number): Promise<void> {
    const inner = String.raw`
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
& $taskkill /PID ${pid} /T /F 2>$null
if ($LASTEXITCODE -ne 0) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }
`.trim()
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
    for (const signal of ['TERM', 'KILL'] as const) {
      if (launcher === 'macos-sudo') {
        await this.runMacOsSudo(
          ['/bin/kill', `-${signal}`, '--', `-${pid}`],
          `tun.macos-sudo.stop-${signal.toLowerCase()}`
        )
      } else {
        await runChecked(this.commandRunner, {
          file: 'pkexec',
          args: ['/bin/kill', `-${signal}`, '--', `-${pid}`],
          timeoutMs: 120_000,
          operation: `tun.linux-pkexec.stop-${signal.toLowerCase()}`
        })
      }
      if (await waitForChildExit(child, this.stopTimeoutMs)) return
    }
    throw new Error(`Elevated TUN process tree ${pid} did not exit after TERM/KILL cleanup.`)
  }

  private async runMacOsSudo(args: readonly string[], operation: string): Promise<void> {
    const askpass = await createMacOsAskpass()
    try {
      await runChecked(this.commandRunner, {
        file: 'sudo',
        args: ['-A', '-k', '--', ...args],
        env: { SUDO_ASKPASS: askpass.path },
        timeoutMs: 120_000,
        operation
      })
    } catch (error) {
      if (isCommandElevationDenial(error)) throw new TunElevationDeniedError(undefined, { cause: error })
      throw error
    } finally {
      await askpass.cleanup()
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

interface WinInetConnectionRoute {
  flags: number
  proxy: string
  bypass: string
  pac: string
}

function windowsTakeoverMatches(
  observed: WindowsProxySettings,
  expected: WindowsProxySettings
): boolean {
  for (const name of [
    'ProxyEnable',
    'ProxyServer',
    'AutoConfigURL',
    'ProxyOverride',
    'AutoDetect'
  ]) {
    if (!sameWindowsNativeValue(observed.values[name], expected.values[name])) return false
  }
  for (const name of ['DefaultConnectionSettings', 'SavedLegacySettings']) {
    const observedRoute = parseWinInetConnectionRoute(observed.values[name])
    const expectedRoute = parseWinInetConnectionRoute(expected.values[name])
    if (
      !observedRoute
      || !expectedRoute
      || observedRoute.flags !== expectedRoute.flags
      || observedRoute.proxy !== expectedRoute.proxy
      || observedRoute.bypass !== expectedRoute.bypass
      || observedRoute.pac !== expectedRoute.pac
    ) {
      return false
    }
  }
  return true
}

function windowsOwnsSnapshotMarker(
  observed: WindowsProxySettings,
  expected: WindowsProxySettings
): boolean {
  const expectedProxyServer = expected.values.ProxyServer
  if (
    expectedProxyServer?.present
    && typeof expectedProxyServer.value === 'string'
    && expectedProxyServer.value.length > 0
    && sameWindowsNativeValue(observed.values.ProxyServer, expectedProxyServer)
  ) {
    return true
  }
  for (const name of ['DefaultConnectionSettings', 'SavedLegacySettings']) {
    const observedRoute = parseWinInetConnectionRoute(observed.values[name])
    const expectedRoute = parseWinInetConnectionRoute(expected.values[name])
    if (
      observedRoute
      && expectedRoute
      && expectedRoute.proxy.length > 0
      && observedRoute.proxy === expectedRoute.proxy
    ) {
      return true
    }
  }
  return false
}

function sameWindowsNativeValue(
  left: WindowsNativeValue | undefined,
  right: WindowsNativeValue | undefined
): boolean {
  return Boolean(
    left
    && right
    && left.present === right.present
    && left.kind === right.kind
    && (!left.present || left.value === right.value)
  )
}

function parseWinInetConnectionRoute(
  entry: WindowsNativeValue | undefined
): WinInetConnectionRoute | undefined {
  const encoded = binaryValue(entry)
  if (!encoded) return undefined
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 24) return undefined
    let offset = 12
    const readField = (): string | undefined => {
      if (offset + 4 > bytes.length) return undefined
      const length = bytes.readUInt32LE(offset)
      offset += 4
      if (length > bytes.length - offset) return undefined
      const value = bytes.subarray(offset, offset + length).toString('utf8')
      offset += length
      return value
    }
    const proxy = readField()
    const bypass = readField()
    const pac = readField()
    if (proxy === undefined || bypass === undefined || pac === undefined) return undefined
    return { flags: bytes.readUInt32LE(8), proxy, bypass, pac }
  } catch {
    return undefined
  }
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
  const authenticated = fields['Authenticated Proxy Enabled']
  return {
    enabled: yesValue(fields.Enabled),
    server: fields.Server ?? '',
    port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0,
    ...(authenticated === undefined ? {} : { authenticated: yesValue(authenticated) })
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
    for (const key of ['web', 'secureWeb', 'socks'] as const) {
      const proxy = objectValue(item[key])
      if (!proxy) continue
      if (
        typeof proxy.enabled !== 'boolean'
        || typeof proxy.server !== 'string'
        || !Number.isInteger(proxy.port)
        || (proxy.authenticated !== undefined && typeof proxy.authenticated !== 'boolean')
      ) {
        throw new Error(`Invalid macOS ${key} proxy settings.`)
      }
    }
  }
  return cloneJson(root as unknown as MacProxySettings)
}

function assertMacAuthenticationReplayable(settings: MacProxySettings): void {
  for (const service of settings.services) {
    if (service.disabled) continue
    for (const key of ['web', 'secureWeb', 'socks'] as const) {
      const proxy = service[key]
      if (proxy && proxy.authenticated !== false) {
        throw new UnsupportedDesktopProxyError(
          `macOS service '${service.name}' has authenticated or unreadable ${key} proxy credentials; `
          + 'Stone+ will not overwrite them.'
        )
      }
    }
  }
}

/**
 * Recovery record v1 predates authentication metadata. The old adapter always
 * used networksetup's unauthenticated setter when it acquired the lease, so a
 * missing value in a persisted applied/original pair must compare as false.
 * Freshly captured current state is deliberately not normalized: unknown or
 * newly enabled authentication must stop restoration and keep the journal.
 */
function normalizeMacRecoveryAuthentication(settings: MacProxySettings): MacProxySettings {
  const normalized = cloneJson(settings)
  for (const service of normalized.services) {
    for (const key of ['web', 'secureWeb', 'socks'] as const) {
      const proxy = service[key]
      if (proxy && proxy.authenticated === undefined) proxy.authenticated = false
    }
  }
  return normalized
}

interface MacOwnedRestore {
  settings: MacProxySettings
  partial: boolean
}

function mergeMacOwnedRestore(
  current: MacProxySettings,
  expected: MacProxySettings,
  replacement: MacProxySettings
): MacOwnedRestore | undefined {
  if (stableJson(current) === stableJson(replacement)) {
    return { settings: cloneJson(current), partial: false }
  }
  const currentByName = new Map(current.services.map((service) => [service.name, service]))
  const expectedByName = new Map(expected.services.map((service) => [service.name, service]))
  const replacementByName = new Map(replacement.services.map((service) => [service.name, service]))
  const ownsAnyService = expected.services.some((owned) => {
    if (owned.disabled) return false
    const observed = currentByName.get(owned.name)
    if (!observed || observed.disabled) return false
    return (['web', 'secureWeb', 'socks'] as const).some((key) => (
      sameMacProxyEndpoint(observed[key], owned[key])
    ))
  })
  if (!ownsAnyService) return undefined

  // Authentication cannot be replayed with networksetup's non-interactive
  // setter. If it changes while Stone+ still owns the endpoint, leave the
  // lease/core alive and retain the journal so the user can undo it and retry.
  for (const owned of expected.services) {
    const observed = currentByName.get(owned.name)
    if (!observed || observed.disabled || owned.disabled) continue
    for (const key of ['web', 'secureWeb', 'socks'] as const) {
      const observedProxy = observed[key]
      const ownedProxy = owned[key]
      if (
        sameMacProxyEndpoint(observedProxy, ownedProxy)
        && observedProxy?.authenticated !== ownedProxy?.authenticated
      ) {
        throw new UnsupportedDesktopProxyError(
          `Authentication changed for the Stone+-owned ${key} proxy on macOS service '${owned.name}'; `
          + 'restore it to the previous state before retrying.'
        )
      }
    }
  }

  const merged = cloneJson(current)
  let partial = false
  for (const service of merged.services) {
    const observed = currentByName.get(service.name)
    const owned = expectedByName.get(service.name)
    const original = replacementByName.get(service.name)
    if (!observed || !owned || !original || observed.disabled !== owned.disabled) {
      partial = true
      continue
    }
    const serviceStillOwned = (['web', 'secureWeb', 'socks'] as const).some((key) => (
      sameMacProxyEndpoint(observed[key], owned[key])
    ))
    if (!serviceStillOwned) {
      if (stableJson(observed) !== stableJson(original)) partial = true
      continue
    }
    for (const key of ['web', 'secureWeb', 'socks', 'pac', 'autoDiscovery', 'bypass'] as const) {
      const observedValue = stableJson(observed[key])
      const ownedValue = stableJson(owned[key])
      const originalValue = stableJson(original[key])
      if (observedValue === ownedValue) {
        const output = service as unknown as Record<string, unknown>
        if (original[key] === undefined) delete output[key]
        else output[key] = cloneJson(original[key])
      } else if (observedValue !== originalValue) {
        partial = true
      }
    }
  }
  for (const owned of expected.services) {
    if (!currentByName.has(owned.name)) partial = true
  }
  return { settings: merged, partial }
}

function sameMacProxyEndpoint(
  current: MacManualProxy | undefined,
  expected: MacManualProxy | undefined
): boolean {
  return Boolean(
    current
    && expected
    && current.server === expected.server
    && current.port === expected.port
  )
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

function mergeGnomeOwnedRestore(
  current: GnomeProxySettings,
  expected: GnomeProxySettings,
  replacement: GnomeProxySettings
): { settings: GnomeProxySettings; partial: boolean } | undefined {
  if (stableJson(current) === stableJson(replacement)) {
    return { settings: cloneJson(current), partial: false }
  }
  const currentRoot = current.schemas['org.gnome.system.proxy']
  const expectedRoot = expected.schemas['org.gnome.system.proxy']
  const replacementRoot = replacement.schemas['org.gnome.system.proxy']
  const endpointSchemas = [
    'org.gnome.system.proxy.http',
    'org.gnome.system.proxy.https',
    'org.gnome.system.proxy.ftp',
    'org.gnome.system.proxy.socks'
  ]
  const endpointOwnership = new Map(endpointSchemas.map((schema) => [
    schema,
    gnomeEndpointIsOwnedOrPartiallyRestored(
      current.schemas[schema],
      expected.schemas[schema],
      replacement.schemas[schema]
    )
  ]))
  const ownsEndpoint = [...endpointOwnership.values()].some(Boolean)
  const ownsPrimaryEndpoint = endpointOwnership.get('org.gnome.system.proxy.http') === true
  const modeIsLeaseOrOriginal = typeof currentRoot?.mode === 'string'
    && (currentRoot.mode === expectedRoot?.mode || currentRoot.mode === replacementRoot?.mode)
  const ownsManualProxy = expectedRoot?.mode === "'manual'"
    && modeIsLeaseOrOriginal
    && ownsEndpoint
  if (!ownsManualProxy) return undefined

  const merged = cloneJson(current)
  let partial = false
  for (const [schema, observedValues] of Object.entries(current.schemas)) {
    const ownedValues = expected.schemas[schema]
    const originalValues = replacement.schemas[schema]
    const mergedValues = merged.schemas[schema]
    if (!ownedValues || !originalValues || !mergedValues) {
      partial = true
      continue
    }
    for (const [key, observed] of Object.entries(observedValues)) {
      const endpointSchemaIsOwned = endpointOwnership.get(schema)
      const controlsActiveManualRoute = schema === 'org.gnome.system.proxy'
        && (key === 'mode' || key === 'use-same-proxy')
      if (
        (endpointSchemaIsOwned === false)
        || (controlsActiveManualRoute && !ownsPrimaryEndpoint)
      ) {
        if (originalValues[key] !== observed) partial = true
        continue
      }
      if (ownedValues[key] === observed && key in originalValues) {
        mergedValues[key] = originalValues[key]
      } else if (originalValues[key] !== observed) {
        partial = true
      }
    }
  }
  for (const schema of Object.keys(expected.schemas)) {
    if (!current.schemas[schema]) partial = true
  }
  return { settings: merged, partial }
}

function gnomeEndpointIsOwnedOrPartiallyRestored(
  current: Record<string, string> | undefined,
  expected: Record<string, string> | undefined,
  replacement: Record<string, string> | undefined
): boolean {
  if (
    typeof current?.host !== 'string'
    || typeof current.port !== 'string'
    || typeof expected?.host !== 'string'
    || typeof expected.port !== 'string'
    || typeof replacement?.host !== 'string'
    || typeof replacement.port !== 'string'
  ) return false
  const hostRecognized = current.host === expected.host || current.host === replacement.host
  const portRecognized = current.port === expected.port || current.port === replacement.port
  const stillOwned = current.host === expected.host || current.port === expected.port
  return hostRecognized && portRecognized && stillOwned
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

interface MacOsAskpass {
  path: string
  cleanup(): Promise<void>
}

async function createMacOsAskpass(): Promise<MacOsAskpass> {
  const directory = await mkdtemp(join(tmpdir(), 'stone-tun-askpass-'))
  const path = join(directory, 'askpass.sh')
  try {
    await writeFile(path, `#!/bin/sh
password=$(/usr/bin/osascript <<'STONE_ASKPASS'
display dialog "Stone+ needs administrator permission for this temporary TUN session." default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel" with icon caution
text returned of result
STONE_ASKPASS
)
status=$?
/bin/rm -f -- "$0"
/bin/rmdir "$(/usr/bin/dirname "$0")" 2>/dev/null || true
if [ "$status" -ne 0 ]; then exit "$status"; fi
/usr/bin/printf '%s\n' "$password"
`, { encoding: 'utf8', mode: 0o700 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let cleanupPromise: Promise<void> | undefined
  return {
    path,
    cleanup(): Promise<void> {
      cleanupPromise ??= rm(directory, { recursive: true, force: true })
      return cleanupPromise
    }
  }
}

function observeChildExit(
  child: ChildProcess,
  readStderr: () => string = () => ''
): NonNullable<TemporaryElevatedProcessHandle['exit']> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      child.off('close', onClose)
      child.off('error', onError)
      const stderr = readStderr().trim().slice(0, MAX_ELEVATION_STDERR_LENGTH)
      resolve({ code, signal, ...(stderr ? { stderr } : {}) })
    }
    // `close` follows stdio shutdown, so sudo/pkexec diagnostics are available
    // before startup code decides whether this was an authorization refusal.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => finish(code, signal)
    const onError = (): void => finish(child.exitCode ?? null, child.signalCode ?? null)
    child.once('close', onClose)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode != null) {
      finish(child.exitCode ?? null, child.signalCode ?? null)
    }
  })
}

function observeProcessIdExit(
  pid: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const check = (): void => {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
          resolve({ code: null, signal: null })
          return
        }
      }
      const timer = setTimeout(check, 500)
      timer.unref()
    }
    check()
  })
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
  if (child.exitCode !== null || child.signalCode != null) return Promise.resolve(true)
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
    || /cancel(?:led|ed)|declined|not authorized|dismissed|no password|password.*required|authentication fail/i
      .test(stderr)
}

function isCommandElevationDenial(error: unknown): boolean {
  if (error instanceof TunElevationDeniedError) return true
  if (error === null || typeof error !== 'object') return false
  const value = error as { exitCode?: unknown; message?: unknown; cause?: unknown }
  return value.exitCode === 1223
    || /cancel(?:led|ed)|declined|not authorized|dismissed|no password|password.*required|authentication fail|1223/i
      .test(String(value.message ?? ''))
    || (value.cause !== undefined && isCommandElevationDenial(value.cause))
}
