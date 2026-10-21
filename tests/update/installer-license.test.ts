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
  it('adds one UTF-8 BOM without changing the Apache-2.0 license content', () => {
    const source = readFileSync(resolve('LICENSE'))
    const encoded = encodeInstallerLicense(source)

    expect(encoded.subarray(0, UTF8_BOM.length)).toEqual(UTF8_BOM)
    expect(encoded.subarray(UTF8_BOM.length)).toEqual(source)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(UTF8_BOM.length)))
      .toContain('Version 2.0, January 2004')
  })

  it('does not duplicate an existing BOM', () => {
    const source = readFileSync(resolve('LICENSE'))
    const encoded = encodeInstallerLicense(Buffer.concat([UTF8_BOM, source]))

    expect(encoded).toEqual(Buffer.concat([UTF8_BOM, source]))
  })

  it('rejects the former custom license instead of packaging its restrictions', () => {
    expect(() => encodeInstallerLicense(Buffer.from('StonePlus Source Available License 1.0\n核心限制')))
      .toThrow('complete Apache License 2.0')
  })

  it('rejects malformed UTF-8 instead of producing a garbled installer page', () => {
    expect(() => encodeInstallerLicense(Buffer.from([0xff, 0xfe, 0x80]))).toThrow()
  })

  it('keeps electron-builder wired to the generated Unicode license', () => {
    expect(packageMetadata.build.beforePack).toBe('./scripts/electron-builder-before-pack.mjs')
    expect(packageMetadata.build.nsis.license).toBe('build/installer-license.txt')
  })
})
