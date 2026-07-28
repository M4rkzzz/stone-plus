import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyStonePlusWindowsUpdateSignature } from '../../src/main/update/windows-signature'

describe('Windows update signature integration', () => {
  it.skipIf(process.platform !== 'win32')(
    'loads the inbox security module when PSModulePath is polluted',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'Stone+ unsigned update '))
      const updatePath = join(directory, 'unsigned update.exe')
      const originalModulePath = process.env.PSModulePath
      try {
        await writeFile(updatePath, 'not a signed Windows executable', 'utf8')
        process.env.PSModulePath = join(directory, 'incompatible modules')

        const result = await verifyStonePlusWindowsUpdateSignature(
          ['StonePlus Open Source Release'],
          updatePath,
        )

        expect(result).toMatch(/verification failed \(status \d+\)\./)
        expect(result).not.toContain('could not run')
      } finally {
        if (originalModulePath === undefined) delete process.env.PSModulePath
        else process.env.PSModulePath = originalModulePath
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
