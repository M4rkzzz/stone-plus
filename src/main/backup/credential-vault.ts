/** Minimal Electron safeStorage surface used by backup features. */
export interface CredentialVaultLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * Electron reports `basic_text` as "available" on Linux even though it does
 * not provide credential protection. Keep every backup credential path on the
 * same fail-closed policy as the main credential store.
 */
export function isSecureCredentialVaultAvailable(vault: CredentialVaultLike | undefined): boolean {
  try {
    if (!vault?.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true
    const backend = vault.getSelectedStorageBackend?.()
    return Boolean(backend && backend !== 'basic_text' && backend !== 'unknown')
  } catch {
    return false
  }
}

export function requireSecureCredentialVault<T extends CredentialVaultLike>(
  vault: T | undefined,
  unavailableMessage = 'System credential encryption is unavailable',
): asserts vault is T {
  if (!isSecureCredentialVaultAvailable(vault)) throw new Error(unavailableMessage)
}
