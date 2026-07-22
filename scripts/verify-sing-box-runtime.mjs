import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const manifestRoot = path.join(repositoryRoot, 'build', 'sing-box')
const defaultRuntimeRoot = manifestRoot
const supportedTargets = ['win-x64', 'linux-x64', 'linux-arm64', 'mac-x64', 'mac-arm64']

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\\')) {
    throw new Error(`Invalid portable runtime path: ${String(relativePath)}`)
  }
  if (path.posix.isAbsolute(relativePath) || relativePath.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Unsafe runtime path: ${relativePath}`)
  }
}

async function sha256(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}

async function collectFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = path.join(directory, entry.name)
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Runtime contains a symbolic link: ${relativePath}`)
    }
    if (metadata.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath))
    } else if (metadata.isFile()) {
      files.push({ relativePath, absolutePath, size: metadata.size })
    } else {
      throw new Error(`Runtime contains an unsupported filesystem entry: ${relativePath}`)
    }
  }
  return files
}

export function runtimeTargetName(platform = process.platform, architecture = process.arch) {
  const platformPrefix = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform
  const targetName = `${platformPrefix}-${architecture}`
  if (!supportedTargets.includes(targetName)) {
    throw new Error(`No pinned sing-box runtime for ${platform}/${architecture}.`)
  }
  return targetName
}

export async function verifyRuntimeTarget(targetName, options = {}) {
  if (!supportedTargets.includes(targetName)) {
    throw new Error(`Unsupported sing-box runtime target: ${targetName}`)
  }
  const runtimeRoot = path.resolve(options.runtimeRoot ?? defaultRuntimeRoot)
  const runtimeManifest = await readJson(path.join(manifestRoot, 'runtime-manifest.json'))
  const distributionManifest = await readJson(path.join(manifestRoot, 'distribution-manifest.json'))

  if (runtimeManifest.schemaVersion !== 1 || distributionManifest.schemaVersion !== 1) {
    throw new Error('Unsupported sing-box manifest schema.')
  }
  if (runtimeManifest.version !== '1.13.14' || distributionManifest.version !== '1.13.14') {
    throw new Error('The sing-box build input must remain pinned to v1.13.14.')
  }

  const target = runtimeManifest.targets?.[targetName]
  const distributionTarget = distributionManifest.targets?.[targetName]
  if (!target || !distributionTarget || target.runtimeDirectory !== targetName) {
    throw new Error(`Incomplete sing-box manifest entry for ${targetName}.`)
  }
  const archive = distributionTarget.archive
  const expectedUrlPrefix = `https://github.com/SagerNet/sing-box/releases/download/v${distributionManifest.version}/`
  if (!archive?.url?.startsWith(expectedUrlPrefix) || path.posix.basename(new URL(archive.url).pathname) !== archive.name) {
    throw new Error(`Untrusted sing-box archive metadata for ${targetName}.`)
  }
  if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || !/^[a-f0-9]{64}$/.test(archive.sha256)) {
    throw new Error(`Invalid sing-box archive integrity metadata for ${targetName}.`)
  }

  if ((targetName.startsWith('win-') || targetName.startsWith('linux-')) && !target.cronetLibrary) {
    throw new Error(`${targetName} must declare its official libcronet sidecar.`)
  }
  if (targetName.startsWith('mac-') && Object.hasOwn(target, 'cronetLibrary')) {
    throw new Error(`${targetName} must match the official archive and omit an external libcronet.`)
  }

  assertSafeRelativePath(target.executable)
  if (target.cronetLibrary) assertSafeRelativePath(target.cronetLibrary)
  const expectedFiles = new Map()
  for (const expectedFile of target.files ?? []) {
    assertSafeRelativePath(expectedFile.path)
    if (expectedFiles.has(expectedFile.path)) {
      throw new Error(`Duplicate manifest path for ${targetName}: ${expectedFile.path}`)
    }
    if (!Number.isSafeInteger(expectedFile.size) || expectedFile.size < 0 || !/^[a-f0-9]{64}$/.test(expectedFile.sha256)) {
      throw new Error(`Invalid integrity metadata for ${targetName}/${expectedFile.path}`)
    }
    expectedFiles.set(expectedFile.path, expectedFile)
  }
  for (const requiredPath of [target.executable, target.cronetLibrary].filter(Boolean)) {
    if (!expectedFiles.has(requiredPath)) {
      throw new Error(`Required file is not protected by the manifest: ${targetName}/${requiredPath}`)
    }
  }

  const targetRoot = path.join(runtimeRoot, target.runtimeDirectory)
  const actualFiles = await collectFiles(targetRoot)
  if (actualFiles.length !== expectedFiles.size) {
    throw new Error(`${targetName} contains ${actualFiles.length} files; expected ${expectedFiles.size}.`)
  }
  for (const actualFile of actualFiles) {
    const expectedFile = expectedFiles.get(actualFile.relativePath)
    if (!expectedFile) {
      throw new Error(`Unexpected sing-box runtime file: ${targetName}/${actualFile.relativePath}`)
    }
    if (actualFile.size !== expectedFile.size) {
      throw new Error(`Size mismatch for ${targetName}/${actualFile.relativePath}.`)
    }
    if (await sha256(actualFile.absolutePath) !== expectedFile.sha256) {
      throw new Error(`SHA-256 mismatch for ${targetName}/${actualFile.relativePath}.`)
    }
  }

  return { targetName, runtimeRoot: targetRoot, version: runtimeManifest.version }
}

function readOption(args, optionName) {
  const index = args.indexOf(optionName)
  if (index === -1) return undefined
  if (!args[index + 1]) throw new Error(`${optionName} requires a value.`)
  return args[index + 1]
}

async function main() {
  const args = process.argv.slice(2)
  const runtimeRoot = readOption(args, '--runtime-root')
  const selectedTarget = readOption(args, '--target')
  const targets = args.includes('--all') ? supportedTargets : [selectedTarget ?? runtimeTargetName()]
  for (const targetName of targets) {
    const result = await verifyRuntimeTarget(targetName, { runtimeRoot })
    process.stdout.write(`Verified sing-box ${result.version} runtime: ${result.targetName}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
