import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FRPC_RUNTIME_TRUST, verifyFrpcBinaryIntegrity } from '../../src/main/tunnel'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('frpc runtime integrity', () => {
  it('wires the fixed verifier into the production tunnel service', async () => {
    const entrypoint = await readFile(resolve('src/main/index.ts'), 'utf8')

    expect(entrypoint).toContain("import { FrpTunnelService, verifyFrpcBinaryIntegrity } from './tunnel'")
    expect(entrypoint).toMatch(/new FrpTunnelService\([\s\S]*verifyBinaryIntegrity:\s*verifyFrpcBinaryIntegrity/)
  })

  it('accepts the exact repository runtime anchored by packaged source metadata', async () => {
    const runtimePath = resolve('build/frp/frpc.exe')
    const contents = await readFile(runtimePath)

    expect(contents.byteLength).toBe(FRPC_RUNTIME_TRUST.size)
    await expect(verifyFrpcBinaryIntegrity(runtimePath)).resolves.toBeUndefined()
  })

  it('rejects same-size tampering before frpc can execute', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-frpc-integrity-'))
    temporaryDirectories.push(directory)
    const runtimePath = join(directory, 'frpc.exe')
    await copyFile(resolve('build/frp/frpc.exe'), runtimePath)
    const contents = await readFile(runtimePath)
    contents[Math.floor(contents.length / 2)] ^= 0xff
    await writeFile(runtimePath, contents)

    await expect(verifyFrpcBinaryIntegrity(runtimePath)).rejects.toThrow(/checksum/i)
  })
})
