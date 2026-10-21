import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLicense } from '../../scripts/verify-license.mjs'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stoneplus-license-'))
  roots.push(root)
  mkdirSync(join(root, 'LICENSES'))
  for (const file of ['LICENSE', 'LICENSES/Apache-2.0.txt', 'package.json', 'package-lock.json', 'PROJECT_IDENTITY.json']) {
    writeFileSync(join(root, file), readFileSync(file))
  }
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('open-source packaging license', () => {
  it('verifies a clone offline without GitHub credentials or .git', () => {
    expect(verifyLicense(fixture()).license).toBe('Apache-2.0')
  })

  it('rejects stale package metadata pointing to the custom license', () => {
    const root = fixture()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    pkg.license = 'SEE LICENSE IN LICENSE'
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
    expect(() => verifyLicense(root)).toThrow('standard Apache-2.0')
  })

  it('rejects license additions not present in the standard mirror', () => {
    const root = fixture()
    writeFileSync(join(root, 'LICENSE'), readFileSync('LICENSE', 'utf8') + '\nNo forks permitted.\n')
    expect(() => verifyLicense(root)).toThrow('SHA-256 must match')
  })
})
