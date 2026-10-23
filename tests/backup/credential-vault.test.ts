import { afterEach, describe, expect, it } from 'vitest'
import {
  isSecureCredentialVaultAvailable,
  requireSecureCredentialVault,
  type CredentialVaultLike,
} from '../../src/main/backup'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('backup credential vault policy', () => {
  it.each([
    ['missing backend', undefined],
    ['plaintext backend', 'basic_text'],
    ['unknown backend', 'unknown'],
  ])('fails closed on Linux for a %s', (_label, backend) => {
    setPlatform('linux')
    const vault = createVault(backend)
    expect(isSecureCredentialVaultAvailable(vault)).toBe(false)
    expect(() => requireSecureCredentialVault(vault, 'secure vault required')).toThrow('secure vault required')
  })

  it('accepts a secure Linux Secret Service backend', () => {
    setPlatform('linux')
    expect(isSecureCredentialVaultAvailable(createVault('gnome_libsecret'))).toBe(true)
  })

  it('fails closed when Electron vault inspection throws', () => {
    setPlatform('linux')
    const vault = createVault('gnome_libsecret')
    vault.getSelectedStorageBackend = () => { throw new Error('backend unavailable') }
    expect(isSecureCredentialVaultAvailable(vault)).toBe(false)
  })
})

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
}

function createVault(backend: string | undefined): CredentialVaultLike {
  return {
    isEncryptionAvailable: () => true,
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf8'),
  }
}
