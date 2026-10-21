// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StonePlus Contributors

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyLicense(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  const pkg = json('package.json')
  const lock = json('package-lock.json')
  const identity = json('PROJECT_IDENTITY.json')
  if (pkg.license !== 'Apache-2.0' || lock.packages?.['']?.license !== 'Apache-2.0'
    || identity.license.spdxReference !== 'Apache-2.0'
    || identity.license.primaryFile !== 'LICENSE'
    || identity.license.mirrorFile !== 'LICENSES/Apache-2.0.txt') {
    throw new Error('Root package and identity metadata must use standard Apache-2.0.')
  }
  if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) {
    throw new Error('Package and lockfile versions are inconsistent.')
  }
  const license = readFileSync(resolve(root, 'LICENSE'))
  const mirror = readFileSync(resolve(root, identity.license.mirrorFile))
  const text = license.toString('utf8')
  if (!text.includes('Apache License') || !text.includes('Version 2.0, January 2004')
    || !text.includes('END OF TERMS AND CONDITIONS') || text.includes('LicenseRef-StonePlus')) {
    throw new Error('LICENSE must contain complete standard Apache-2.0 text.')
  }
  const digest = createHash('sha256').update(license).digest('hex')
  if (!license.equals(mirror) || digest !== identity.license.sha256) {
    throw new Error('LICENSE, Apache-2.0 mirror, and identity SHA-256 must match.')
  }
  if (pkg.build.extraResources.some((entry) => /LicenseRef-StonePlus/.test(entry.from))) {
    throw new Error('Current packages must not ship the former custom license.')
  }
  return { license: 'Apache-2.0', sha256: digest, version: pkg.version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyLicense(), null, 2))
}
