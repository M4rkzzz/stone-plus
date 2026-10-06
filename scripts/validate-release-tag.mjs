import { readFileSync } from 'node:fs'

const tag = (process.argv[2] || process.env.RELEASE_TAG || '').trim()
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const expectedTag = `v${packageMetadata.version}`
const semanticVersionTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

if (!tag) {
  throw new Error('A release tag is required. Pass one as an argument or set RELEASE_TAG.')
}
if (!semanticVersionTag.test(tag)) {
  throw new Error(`Release tag "${tag}" is not a valid v-prefixed semantic version.`)
}
if (tag !== expectedTag) {
  throw new Error(`Release tag "${tag}" does not match package version ${packageMetadata.version}. Expected "${expectedTag}".`)
}
if (packageLock.version !== packageMetadata.version || packageLock.packages?.['']?.version !== packageMetadata.version) {
  throw new Error('package-lock.json version does not match package.json.')
}

console.log(`Release metadata is consistent for ${tag}.`)
