import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  encodeInstallerLicense,
  UTF8_BOM,
} from '../../scripts/prepare-installer-license.mjs'

const packageMetadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  build: {
    beforePack: string
    nsis: { license: string }
  }
}

describe('NSIS installer license encoding', () => {
  it('adds one UTF-8 BOM without changing the protected license content', () => {
    const source = readFileSync(resolve('LICENSE'))
    const encoded = encodeInstallerLicense(source)

    expect(encoded.subarray(0, UTF8_BOM.length)).toEqual(UTF8_BOM)
    expect(encoded.subarray(UTF8_BOM.length)).toEqual(source)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(UTF8_BOM.length)))
      .toContain('核心限制')
  })

  it('does not duplicate an existing BOM', () => {
    const source = readFileSync(resolve('LICENSE'))
    const encoded = encodeInstallerLicense(Buffer.concat([UTF8_BOM, source]))

    expect(encoded).toEqual(Buffer.concat([UTF8_BOM, source]))
  })

  it('keeps electron-builder wired to the generated Unicode license', () => {
    expect(packageMetadata.build.beforePack).toBe('./scripts/electron-builder-before-pack.mjs')
    expect(packageMetadata.build.nsis.license).toBe('build/installer-license.txt')
  })
})
