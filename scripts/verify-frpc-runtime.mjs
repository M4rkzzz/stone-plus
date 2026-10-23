import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultRuntimeRoot = path.join(repositoryRoot, 'build', 'frp')

const executableExpectation = Object.freeze({
  path: 'frpc.exe',
  size: 16_921_088,
  sha256: 'f8467a4f8d57cde5ba808a764b528147acd81db0955e51bee80fde0fea0e5243',
})
const licenseExpectation = Object.freeze({
  path: 'LICENSE.frp.txt',
  size: 11_358,
  sha256: 'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08',
})

export const FRPC_RUNTIME_EXPECTATION = Object.freeze({
  schemaVersion: 1,
  component: 'frpc',
  version: '0.69.0',
  target: 'windows-amd64',
  upstream: Object.freeze({
    repository: 'https://github.com/fatedier/frp',
    release: 'https://github.com/fatedier/frp/releases/tag/v0.69.0',
    archive: Object.freeze({
      name: 'frp_0.69.0_windows_amd64.zip',
      url: 'https://github.com/fatedier/frp/releases/download/v0.69.0/frp_0.69.0_windows_amd64.zip',
      size: 14_182_750,
      sha256: '0e38f6dbe7761d648ca5c6ee323b7309544f48c01e9476f553902f3bc0949089',
    }),
  }),
  files: Object.freeze({
    [executableExpectation.path]: executableExpectation,
    [licenseExpectation.path]: licenseExpectation,
  }),
})

const pinnedManifest = Object.freeze({
  schemaVersion: FRPC_RUNTIME_EXPECTATION.schemaVersion,
  component: FRPC_RUNTIME_EXPECTATION.component,
  version: FRPC_RUNTIME_EXPECTATION.version,
  target: FRPC_RUNTIME_EXPECTATION.target,
  upstream: FRPC_RUNTIME_EXPECTATION.upstream,
  files: Object.freeze([executableExpectation, licenseExpectation]),
})

async function sha256(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function verifyFile(filePath, expectation) {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Pinned frpc asset must be a regular file: ${filePath}`)
  }
  if (metadata.size !== expectation.size) {
    throw new Error(`Size mismatch for pinned frpc asset ${expectation.path}.`)
  }
  const digest = await sha256(filePath)
  if (digest !== expectation.sha256) {
    throw new Error(`SHA-256 mismatch for pinned frpc asset ${expectation.path}.`)
  }
  return { path: filePath, size: metadata.size, sha256: digest }
}

/**
 * Verifies the executable against constants bundled with Stone+, without
 * trusting a mutable manifest next to the executable. Use this immediately
 * before FrpTunnelService spawns frpc.
 */
export async function verifyFrpcBinary(binaryPath) {
  return verifyFile(path.resolve(binaryPath), executableExpectation)
}

/** Verifies all packaged frpc assets and their human-readable manifest. */
export async function verifyFrpcRuntime(options = {}) {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? defaultRuntimeRoot)
  const manifestPath = path.resolve(options.manifestPath ?? path.join(runtimeRoot, 'runtime-manifest.json'))
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read the pinned frpc runtime manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isDeepStrictEqual(manifest, pinnedManifest)) {
    throw new Error('frpc runtime manifest differs from the pinned Stone+ trust anchor.')
  }
  const files = await Promise.all(pinnedManifest.files.map((expectation) => (
    verifyFile(path.join(runtimeRoot, expectation.path), expectation)
  )))
  return {
    version: pinnedManifest.version,
    target: pinnedManifest.target,
    runtimeRoot,
    files,
  }
}

function readOption(args, optionName) {
  const index = args.indexOf(optionName)
  if (index === -1) return undefined
  if (!args[index + 1]) throw new Error(`${optionName} requires a value.`)
  return args[index + 1]
}

async function main() {
  const args = process.argv.slice(2)
  const result = await verifyFrpcRuntime({
    runtimeRoot: readOption(args, '--runtime-root'),
    manifestPath: readOption(args, '--manifest'),
  })
  process.stdout.write(`Verified frpc ${result.version} runtime: ${result.target}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
