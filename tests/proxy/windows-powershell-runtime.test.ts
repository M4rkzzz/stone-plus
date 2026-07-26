import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWindowsPowerShellCommandArgs,
  executeFile,
  WINDOWS_POWERSHELL_SECURITY_MODULE_IMPORT,
} from '../../src/main/proxy/built-in/process-utils'
import { SingBoxService } from '../../src/main/proxy/built-in/sing-box-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('Windows PowerShell runtime commands', () => {
  it.skipIf(process.platform !== 'win32')(
    'passes metacharacter paths through the environment and loads the inbox security module',
    async () => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'Stone+ ACL $value; integration '))
      temporaryDirectories.push(userDataPath)
      const directory = join(userDataPath, 'built-in-proxy')
      await mkdir(directory, { recursive: true })
      await executeFile('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)F'])
      const service = new SingBoxService({
        userDataPath,
        runtimeRoot: join(userDataPath, 'unused runtime'),
        platform: 'win32',
        environment: {
          ...process.env,
          PSModulePath: join(userDataPath, 'empty modules'),
        },
      })

      await service.cleanupStaleRuntimeConfigs()

      const script = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_POWERSHELL_SECURITY_MODULE_IMPORT}
$Target = [Environment]::GetEnvironmentVariable('STONE_TEST_ACL_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($Target)) { throw 'Missing test ACL target.' }
$observed = Get-Acl -LiteralPath $Target
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$payload = [ordered]@{
  target = $Target
  protected = [bool]$observed.AreAccessRulesProtected
  modulePath = [string](Get-Module Microsoft.PowerShell.Security).Path
  currentSid = [string]$sid.Value
  accessSids = @($observed.Access | ForEach-Object { [string]$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
}
[Console]::Out.Write(($payload | ConvertTo-Json -Compress))
`.trim()

      const result = await executeFile(
        'powershell.exe',
        createWindowsPowerShellCommandArgs(script),
        {
          // Deliberately exclude inherited module paths. Production must still
          // load the Windows PowerShell 5.1 inbox security module explicitly.
          env: {
            ...process.env,
            PSModulePath: join(userDataPath, 'empty modules'),
            STONE_TEST_ACL_TARGET: directory,
          },
          timeoutMs: 10_000,
        },
      )
      const payload = JSON.parse(result.stdout) as {
        target: string
        protected: boolean
        modulePath: string
        currentSid: string
        accessSids: string[]
      }

      expect(payload).toMatchObject({ target: directory, protected: true })
      expect(payload.modulePath.toLowerCase()).toContain(
        '\\windowspowershell\\v1.0\\modules\\microsoft.powershell.security\\',
      )
      expect(payload.accessSids).toEqual([payload.currentSid])
    },
  )
})
