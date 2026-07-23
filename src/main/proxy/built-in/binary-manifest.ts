import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

export const SING_BOX_VERSION = '1.13.14' as const

export type SupportedSingBoxTarget =
  | 'win-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'mac-x64'
  | 'mac-arm64'

export interface SingBoxTargetLayout {
  target: SupportedSingBoxTarget
  runtimeDirectory: string
  executable: string
  /** macOS upstream archives link Cronet into sing-box and have no sidecar. */
  cronetLibrary?: string
}

export interface SingBoxManifestFile {
  path: string
  sha256: string
  size?: number
}

export interface SingBoxManifestTarget {
  runtimeDirectory: string
  executable: string
  cronetLibrary?: string
  files: SingBoxManifestFile[]
}

export interface SingBoxBinaryManifest {
  schemaVersion: 1
  version: typeof SING_BOX_VERSION
  targets: Partial<Record<SupportedSingBoxTarget, SingBoxManifestTarget>>
}

export interface VerifiedSingBoxRuntime extends SingBoxTargetLayout {
  version: typeof SING_BOX_VERSION
  runtimePath: string
  executablePath: string
  cronetLibraryPath?: string
  files: ReadonlyArray<{ path: string; sha256: string; size: number }>
}

export type SingBoxManifestErrorCode =
  | 'unsupported_platform'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'runtime_incomplete'
  | 'runtime_untrusted'

export class SingBoxManifestError extends Error {
  public readonly code: SingBoxManifestErrorCode

  public constructor(code: SingBoxManifestErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SingBoxManifestError'
    this.code = code
  }
}

const TARGET_LAYOUTS: Readonly<Record<SupportedSingBoxTarget, SingBoxTargetLayout>> = {
  'win-x64': {
    target: 'win-x64',
    runtimeDirectory: 'win-x64',
    executable: 'sing-box.exe',
    cronetLibrary: 'libcronet.dll'
  },
  'linux-x64': {
    target: 'linux-x64',
    runtimeDirectory: 'linux-x64',
    executable: 'sing-box',
    cronetLibrary: 'libcronet.so'
  },
  'linux-arm64': {
    target: 'linux-arm64',
    runtimeDirectory: 'linux-arm64',
    executable: 'sing-box',
    cronetLibrary: 'libcronet.so'
  },
  'mac-x64': {
    target: 'mac-x64',
    runtimeDirectory: 'mac-x64',
    executable: 'sing-box'
  },
  'mac-arm64': {
    target: 'mac-arm64',
    runtimeDirectory: 'mac-arm64',
    executable: 'sing-box'
  }
}

export function resolveSingBoxTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): SingBoxTargetLayout {
  const target = platform === 'win32' && architecture === 'x64'
    ? 'win-x64'
    : platform === 'linux' && architecture === 'x64'
      ? 'linux-x64'
      : platform === 'linux' && architecture === 'arm64'
        ? 'linux-arm64'
        : platform === 'darwin' && architecture === 'x64'
          ? 'mac-x64'
          : platform === 'darwin' && architecture === 'arm64'
            ? 'mac-arm64'
            : undefined
  if (!target) {
    throw new SingBoxManifestError(
      'unsupported_platform',
      `sing-box ${SING_BOX_VERSION} is not bundled for ${platform}/${architecture}.`
    )
  }
  return { ...TARGET_LAYOUTS[target] }
}

/**
 * Verifies the complete, immutable sing-box runtime directory before any
 * executable in it is launched. Unlisted files and symbolic links are rejected
 * because either could influence native library loading.
 */
export async function verifyBundledSingBoxRuntime(options: {
  runtimeRoot: string
  manifestPath?: string
  platform?: NodeJS.Platform
  architecture?: string
}): Promise<VerifiedSingBoxRuntime> {
  const layout = resolveSingBoxTarget(options.platform, options.architecture)
  const manifestPath = options.manifestPath ?? join(options.runtimeRoot, 'runtime-manifest.json')
  const manifest = await readManifest(manifestPath)
  if (manifest.version !== SING_BOX_VERSION) {
    throw new SingBoxManifestError(
      'manifest_invalid',
      `Bundled sing-box manifest declares ${manifest.version}; Stone+ requires ${SING_BOX_VERSION}.`
    )
  }

  const target = manifest.targets[layout.target]
  if (!target) {
    throw new SingBoxManifestError('runtime_incomplete', `Manifest has no ${layout.target} runtime.`)
  }
  assertExpectedLayout(layout, target)

  const runtimePath = resolve(options.runtimeRoot, layout.runtimeDirectory)
  await assertPlainDirectory(runtimePath)
  const declared = validateFileEntries(target.files)
  if (!declared.has(normalizeManifestPath(layout.executable))) {
    throw new SingBoxManifestError('manifest_invalid', 'Manifest does not authenticate the sing-box executable.')
  }
  if (layout.cronetLibrary && !declared.has(normalizeManifestPath(layout.cronetLibrary))) {
    throw new SingBoxManifestError('manifest_invalid', 'Manifest does not authenticate libcronet.')
  }

  const actualFiles = await listPlainFiles(runtimePath)
  const actualNames = new Set(actualFiles.map((path) => normalizeManifestPath(relative(runtimePath, path))))
  const declaredNames = new Set(declared.keys())
  const missing = [...declaredNames].filter((path) => !actualNames.has(path))
  const unexpected = [...actualNames].filter((path) => !declaredNames.has(path))
  if (missing.length || unexpected.length) {
    const detail = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unlisted: ${unexpected.join(', ')}` : ''
    ].filter(Boolean).join('; ')
    throw new SingBoxManifestError('runtime_incomplete', `Bundled sing-box runtime is incomplete (${detail}).`)
  }

  const verifiedFiles: Array<{ path: string; sha256: string; size: number }> = []
  for (const [manifestRelativePath, entry] of declared) {
    const absolutePath = resolveRuntimeFile(runtimePath, manifestRelativePath)
    const stats = await lstat(absolutePath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new SingBoxManifestError('runtime_untrusted', `${manifestRelativePath} is not a regular file.`)
    }
    if (entry.size !== undefined && stats.size !== entry.size) {
      throw new SingBoxManifestError('runtime_untrusted', `${manifestRelativePath} has an unexpected size.`)
    }
    const digest = await sha256File(absolutePath)
    if (digest !== entry.sha256) {
      throw new SingBoxManifestError('runtime_untrusted', `${manifestRelativePath} failed SHA-256 verification.`)
    }
    verifiedFiles.push({ path: absolutePath, sha256: digest, size: stats.size })
  }

  return {
    ...layout,
    version: SING_BOX_VERSION,
    runtimePath,
    executablePath: join(runtimePath, layout.executable),
    ...(layout.cronetLibrary ? { cronetLibraryPath: join(runtimePath, layout.cronetLibrary) } : {}),
    files: verifiedFiles
  }
}

async function readManifest(path: string): Promise<SingBoxBinaryManifest> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new SingBoxManifestError('manifest_missing', 'Bundled sing-box version manifest is unavailable.', {
      cause: error
    })
  }
  if (Buffer.byteLength(source, 'utf8') > 1_000_000) {
    throw new SingBoxManifestError('manifest_invalid', 'Bundled sing-box manifest is unexpectedly large.')
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new SingBoxManifestError('manifest_invalid', 'Bundled sing-box manifest is not valid JSON.', {
      cause: error
    })
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== 'string' || !isRecord(value.targets)) {
    throw new SingBoxManifestError('manifest_invalid', 'Bundled sing-box manifest has an invalid shape.')
  }
  return value as unknown as SingBoxBinaryManifest
}

function assertExpectedLayout(layout: SingBoxTargetLayout, target: SingBoxManifestTarget): void {
  if (!isRecord(target)) {
    throw new SingBoxManifestError('manifest_invalid', `Manifest entry for ${layout.target} is invalid.`)
  }
  if (
    target.runtimeDirectory !== layout.runtimeDirectory
    || target.executable !== layout.executable
    || target.cronetLibrary !== layout.cronetLibrary
    || !Array.isArray(target.files)
  ) {
    throw new SingBoxManifestError('manifest_invalid', `Manifest entry for ${layout.target} changes its fixed layout.`)
  }
}

function validateFileEntries(entries: SingBoxManifestFile[]): Map<string, SingBoxManifestFile> {
  if (!entries.length) throw new SingBoxManifestError('manifest_invalid', 'Manifest runtime file list is empty.')
  const result = new Map<string, SingBoxManifestFile>()
  for (const candidate of entries) {
    if (!isRecord(candidate) || typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string') {
      throw new SingBoxManifestError('manifest_invalid', 'Manifest contains an invalid file entry.')
    }
    const path = normalizeManifestPath(candidate.path)
    if (!isSafeRelativePath(path)) {
      throw new SingBoxManifestError('manifest_invalid', `Manifest contains an unsafe path: ${candidate.path}.`)
    }
    const sha256 = candidate.sha256.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new SingBoxManifestError('manifest_invalid', `Manifest contains an invalid SHA-256 for ${path}.`)
    }
    if (candidate.size !== undefined && (!Number.isSafeInteger(candidate.size) || candidate.size < 0)) {
      throw new SingBoxManifestError('manifest_invalid', `Manifest contains an invalid size for ${path}.`)
    }
    if (result.has(path)) throw new SingBoxManifestError('manifest_invalid', `Manifest lists ${path} more than once.`)
    result.set(path, { path, sha256, ...(candidate.size === undefined ? {} : { size: candidate.size }) })
  }
  return result
}

async function assertPlainDirectory(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    throw new SingBoxManifestError('runtime_incomplete', `Bundled runtime directory ${basename(path)} is unavailable.`, {
      cause: error
    })
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SingBoxManifestError('runtime_untrusted', `Bundled runtime directory ${basename(path)} is not trusted.`)
  }
}

async function listPlainFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SingBoxManifestError('runtime_untrusted', `Bundled runtime contains a symbolic link: ${entry.name}.`)
      }
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
      else throw new SingBoxManifestError('runtime_untrusted', `Bundled runtime contains a non-regular entry: ${entry.name}.`)
    }
  }
  await visit(root)
  return result
}

function resolveRuntimeFile(runtimePath: string, manifestPath: string): string {
  const path = resolve(runtimePath, ...manifestPath.split('/'))
  if (path !== runtimePath && !path.startsWith(`${runtimePath}${sep}`)) {
    throw new SingBoxManifestError('manifest_invalid', `Manifest path escapes the runtime: ${manifestPath}.`)
  }
  return path
}

function normalizeManifestPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith('/')
    && !/^[a-z]:/i.test(path)
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
