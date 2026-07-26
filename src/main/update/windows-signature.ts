import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalize } from 'node:path'

const execFileAsync = promisify(execFile)

// The release certificate is intentionally self-signed. Pinning its published
// thumbprint lets clean Windows installations verify the project continuity
// certificate without asking users to trust it as a system root.
export const STONEPLUS_RELEASE_CERTIFICATE_SHA1 = 'FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D'

export type AuthenticodeResult = {
  Status?: number
  StatusMessage?: string
  Path?: string
  Subject?: string
  Thumbprint?: string
}

// Pin the inbox Windows PowerShell 5.1 security module instead of relying on
// PSModulePath auto-loading. A parent launched from PowerShell 7 can put its
// incompatible module directory first, which otherwise makes the signature
// check fail before it can inspect the update. The verification result remains
// fail-closed; this only makes the trusted Windows API deterministic.
const WINDOWS_POWERSHELL_SECURITY_MODULE_IMPORT = [
  "$stoneSecurityModule = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
  'Import-Module -Name $stoneSecurityModule -Force -ErrorAction Stop',
]

/**
 * Verifies a Windows update with the same Authenticode API electron-updater
 * uses, while allowing the published Stone+ continuity certificate when its
 * chain is unknown to the local trust provider.
 */
export async function verifyStonePlusWindowsUpdateSignature(
  publisherNames: string[],
  updatePath: string,
): Promise<string | null> {
  let result: AuthenticodeResult
  try {
    const output = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-InputFormat',
        'None',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "$ErrorActionPreference = 'Stop'",
          ...WINDOWS_POWERSHELL_SECURITY_MODULE_IMPORT,
          '$signature = Get-AuthenticodeSignature -LiteralPath $env:STONEPLUS_UPDATE_PATH',
          '$certificate = $signature.SignerCertificate',
          '$subject = if ($null -eq $certificate) { \'\' } else { [string]$certificate.Subject }',
          '$thumbprint = if ($null -eq $certificate) { \'\' } else { [string]$certificate.Thumbprint }',
          '[pscustomobject]@{',
          '  Status = [int]$signature.Status',
          '  StatusMessage = [string]$signature.StatusMessage',
          '  Path = [string]$signature.Path',
          '  Subject = $subject',
          '  Thumbprint = $thumbprint',
          '} | ConvertTo-Json -Compress',
        ].join('\n'),
      ],
      {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 128 * 1024,
        env: { ...process.env, STONEPLUS_UPDATE_PATH: updatePath },
      },
    )
    const parsed: unknown = JSON.parse(output.stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Windows update signature verification returned invalid PowerShell data.'
    }
    result = parsed as AuthenticodeResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Windows update signature verification could not run: ${message}`
  }

  return validateStonePlusWindowsUpdateSignature(publisherNames, updatePath, result)
}

export function validateStonePlusWindowsUpdateSignature(
  publisherNames: string[],
  updatePath: string,
  result: AuthenticodeResult,
): string | null {
  if (result.Path && !sameWindowsPath(result.Path, updatePath)) {
    return 'Windows update signature verification returned a different file path.'
  }

  const publisherMatches = publisherNames.some((publisherName) => publisherMatchesSubject(publisherName, result.Subject ?? ''))
  const thumbprint = normalizeThumbprint(result.Thumbprint)
  const certificateMatches = thumbprint === STONEPLUS_RELEASE_CERTIFICATE_SHA1
  if (result.Status === 0 && publisherMatches && certificateMatches) return null

  // PowerShell reports a valid Authenticode signature with an untrusted root
  // as UnknownError (1). Accept that status only for the exact published
  // Stone+ certificate and the expected publisher, never by CN alone.
  if (
    result.Status === 1
    && certificateMatches
    && publisherMatches
    && isUntrustedRootStatus(result.StatusMessage)
  ) {
    return null
  }

  return `Windows update signature verification failed (status ${String(result.Status ?? 'unknown')}).`
}

export function normalizeThumbprint(value: string | undefined): string {
  return (value ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase()
}

export function publisherMatchesSubject(publisherName: string, subject: string): boolean {
  const expected = publisherName.trim()
  const actual = subject.trim()
  if (!expected || !actual) return false
  if (expected.includes('=')) return normalizeDn(actual) === normalizeDn(expected)
  const commonName = /(?:^|,\s*)CN=([^,]+)/i.exec(actual)?.[1]?.trim()
  return commonName?.toLowerCase() === expected.toLowerCase()
}

function normalizeDn(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

export function isUntrustedRootStatus(message: string | undefined): boolean {
  return /untrusted|not trusted|root certificate|certificate chain|trust provider|不受信任|信任提供程序|证书链|根证书/i.test(message ?? '')
}
