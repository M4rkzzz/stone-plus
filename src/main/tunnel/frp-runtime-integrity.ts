import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

/**
 * Trusted metadata for the exact frpc build shipped by Stone+.
 *
 * Keep this value inside the packaged application rather than accepting a
 * sibling manifest as the trust root. Electron's embedded ASAR integrity and
 * the platform signature protect this constant in release builds.
 */
export const FRPC_RUNTIME_TRUST = Object.freeze({
  version: '0.69.0',
  target: 'windows-amd64',
  size: 16_921_088,
  sha256: 'f8467a4f8d57cde5ba808a764b528147acd81db0955e51bee80fde0fea0e5243',
})

export async function verifyFrpcBinaryIntegrity(binaryPath: string): Promise<void> {
  const metadata = await stat(binaryPath)
  if (!metadata.isFile()) throw new Error('The embedded frpc runtime is not a regular file.')
  if (metadata.size !== FRPC_RUNTIME_TRUST.size) {
    throw new Error('The embedded frpc runtime size does not match the trusted release.')
  }

  const digest = createHash('sha256')
  for await (const chunk of createReadStream(binaryPath)) digest.update(chunk)
  const actual = digest.digest()
  const expected = Buffer.from(FRPC_RUNTIME_TRUST.sha256, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('The embedded frpc runtime checksum does not match the trusted release.')
  }
}
