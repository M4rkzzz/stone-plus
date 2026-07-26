import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  FRPC_RUNTIME_EXPECTATION,
  verifyFrpcBinary,
  verifyFrpcRuntime,
} from '../../scripts/verify-frpc-runtime.mjs'
import { FRPC_RUNTIME_TRUST } from '../../src/main/tunnel/frp-runtime-integrity'
const sourceRuntimeRoot = resolve('build/frp')
const fetchScript = await readFile(resolve('scripts/fetch-frpc.ps1'), 'utf8')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('pinned frpc runtime', () => {
  it('verifies the checked-in executable, license, and manifest', async () => {
    await expect(verifyFrpcRuntime({ runtimeRoot: sourceRuntimeRoot })).resolves.toMatchObject({
      version: '0.69.0',
      target: 'windows-amd64',
    })
    await expect(verifyFrpcBinary(join(sourceRuntimeRoot, 'frpc.exe'))).resolves.toMatchObject({
      sha256: FRPC_RUNTIME_EXPECTATION.files['frpc.exe'].sha256,
      size: FRPC_RUNTIME_EXPECTATION.files['frpc.exe'].size,
    })
  })

  it('keeps build-time and packaged runtime trust anchors identical', () => {
    expect({
      version: FRPC_RUNTIME_EXPECTATION.version,
      target: FRPC_RUNTIME_EXPECTATION.target,
      size: FRPC_RUNTIME_EXPECTATION.files['frpc.exe'].size,
      sha256: FRPC_RUNTIME_EXPECTATION.files['frpc.exe'].sha256,
    }).toEqual(FRPC_RUNTIME_TRUST)
  })

  it('keeps the acquisition script pinned to the same archive and runtime files', () => {
    const archive = FRPC_RUNTIME_EXPECTATION.upstream.archive
    const executable = FRPC_RUNTIME_EXPECTATION.files['frpc.exe']
    const license = FRPC_RUNTIME_EXPECTATION.files['LICENSE.frp.txt']

    expect(fetchScript).toContain(`$Version = '${FRPC_RUNTIME_EXPECTATION.version}'`)
    expect(fetchScript).toContain(`$ExpectedArchiveSize = ${archive.size}`)
    expect(fetchScript).toContain(`$ExpectedSha256 = '${archive.sha256}'`)
    expect(fetchScript).toContain(`$ExpectedExecutableSize = ${executable.size}`)
    expect(fetchScript).toContain(`$ExpectedExecutableSha256 = '${executable.sha256}'`)
    expect(fetchScript).toContain(`$ExpectedLicenseSize = ${license.size}`)
    expect(fetchScript).toContain(`$ExpectedLicenseSha256 = '${license.sha256}'`)
  })

  it('fails closed when a same-size executable is modified', async () => {
    const runtimeRoot = await copyRuntime()
    const executablePath = join(runtimeRoot, 'frpc.exe')
    const executable = await readFile(executablePath)
    executable[0] ^= 0xff
    await writeFile(executablePath, executable)

    await expect(verifyFrpcBinary(executablePath)).rejects.toThrow(/SHA-256 mismatch/i)
    await expect(verifyFrpcRuntime({ runtimeRoot })).rejects.toThrow(/SHA-256 mismatch/i)
  })

  it('does not trust a manifest changed alongside the executable', async () => {
    const runtimeRoot = await copyRuntime()
    const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.files[0].sha256 = '0'.repeat(64)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifyFrpcRuntime({ runtimeRoot })).rejects.toThrow(/pinned Stone\+ trust anchor/i)
  })
})

async function copyRuntime(): Promise<string> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'stone-frpc-runtime-'))
  temporaryDirectories.push(runtimeRoot)
  for (const fileName of ['frpc.exe', 'LICENSE.frp.txt', 'runtime-manifest.json']) {
    await copyFile(join(sourceRuntimeRoot, fileName), join(runtimeRoot, fileName))
  }
  return runtimeRoot
}
