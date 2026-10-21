// SPDX-License-Identifier: Apache-2.0
// See LICENSE and PROJECT_IDENTITY.json in the repository root.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export function encodeInstallerLicense(source) {
  const bytes = Buffer.from(source)
  const hasBom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  const textBytes = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes
  const text = new TextDecoder('utf-8', { fatal: true }).decode(textBytes)

  if (!text.includes('Apache License') || !text.includes('Version 2.0, January 2004') || !text.includes('END OF TERMS AND CONDITIONS')) {
    throw new Error('Stone+ installer license must contain the complete Apache License 2.0 text.')
  }

  return hasBom ? bytes : Buffer.concat([UTF8_BOM, bytes])
}

export async function prepareInstallerLicense(projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const sourcePath = resolve(projectDir, 'LICENSE')
  const destinationPath = resolve(projectDir, 'build', 'installer-license.txt')
  const encoded = encodeInstallerLicense(await readFile(sourcePath))

  await mkdir(dirname(destinationPath), { recursive: true })
  await writeFile(destinationPath, encoded)
  return destinationPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destinationPath = await prepareInstallerLicense()
  console.info(`Prepared Unicode NSIS license: ${destinationPath}`)
}
