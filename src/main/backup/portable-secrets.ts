import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { requireSecureCredentialVault, type CredentialVaultLike } from './credential-vault'

const MANIFEST_KEY = 'portable_secret_wrapping_v2'
const WEBDAV_KEY = 'webdav_backup_configuration_v1'
const PREFIX = 'stoneportable:v2:'

export type PortableSecretVault = CredentialVaultLike

interface PortableWebDavConfiguration {
  version: 1
  baseUrl: string
  username: string
  encryptedPassword?: string
}

interface NormalizedPortableWebDav {
  configuration: PortableWebDavConfiguration
  embeddedPassword?: string
  changed: boolean
}

interface SecretManifest { version: 2; salt: string }

export async function preparePortableExportDatabase(
  sourcePath: string,
  destinationPath: string,
  password: string,
  vault?: PortableSecretVault,
): Promise<void> {
  await copyFile(sourcePath, destinationPath)
  const database = new DatabaseSync(destinationPath)
  let key: Buffer | undefined
  try {
    const credentialRows = database.prepare('SELECT id, encrypted_value FROM credentials').all() as Array<{
      id: string; encrypted_value: string
    }>
    const rawWebDav = readWebDav(database)
    const webDav = rawWebDav ? normalizePortableWebDav(rawWebDav) : undefined
    const hasSecrets = credentialRows.length > 0
      || Boolean(webDav?.configuration.encryptedPassword)
      || Boolean(webDav?.embeddedPassword)
    if (!hasSecrets && !webDav?.changed) return
    if (!hasSecrets) {
      database.exec('BEGIN IMMEDIATE')
      try {
        writeWebDav(database, webDav!.configuration)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return
    }
    requireVault(vault)
    const salt = randomBytes(16)
    key = await deriveSecretKey(password, salt)
    database.exec('BEGIN IMMEDIATE')
    try {
      const updateCredential = database.prepare('UPDATE credentials SET encrypted_value = ? WHERE id = ?')
      for (const row of credentialRows) {
        const plaintext = decryptVault(vault, row.encrypted_value, row.id)
        updateCredential.run(wrapSecret(plaintext, key, `credentials/${row.id}`), row.id)
      }
      if (webDav) {
        const encryptedPassword = webDav.configuration.encryptedPassword
          ? wrapSecret(
            decryptVault(vault, webDav.configuration.encryptedPassword, 'webdav/password'),
            key,
            'webdav/password',
          )
          : webDav.embeddedPassword
            ? wrapSecret(webDav.embeddedPassword, key, 'webdav/password')
            : undefined
        writeWebDav(database, {
          ...webDav.configuration,
          ...(encryptedPassword ? { encryptedPassword } : {}),
        })
      }
      const manifest: SecretManifest = { version: 2, salt: salt.toString('base64url') }
      writeMetadata(database, MANIFEST_KEY, JSON.stringify(manifest))
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    key?.fill(0)
    database.close()
  }
}

export async function preparePortableImportedDatabase(
  databasePath: string,
  password: string,
  version: 1 | 2,
  vault?: PortableSecretVault,
): Promise<void> {
  const database = new DatabaseSync(databasePath)
  let key: Buffer | undefined
  try {
    const credentialRows = database.prepare('SELECT id, encrypted_value FROM credentials').all() as Array<{
      id: string; encrypted_value: string
    }>
    const rawWebDav = readWebDav(database)
    const webDav = rawWebDav ? normalizePortableWebDav(rawWebDav) : undefined
    const hasWrappedSecrets = credentialRows.length > 0 || Boolean(webDav?.configuration.encryptedPassword)
    const hasSecrets = hasWrappedSecrets || Boolean(webDav?.embeddedPassword)
    if (!hasSecrets && !webDav?.changed) return
    if (!hasSecrets) {
      database.exec('BEGIN IMMEDIATE')
      try {
        writeWebDav(database, webDav!.configuration)
        if (version === 2) database.prepare('DELETE FROM app_metadata WHERE key = ?').run(MANIFEST_KEY)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return
    }
    requireVault(vault)
    if (version === 1) {
      // Legacy archives contain original OS-vault ciphertext. They are usable
      // only in the same vault context; validate every secret before accepting.
      for (const row of credentialRows) decryptVault(vault, row.encrypted_value, row.id, true)
      if (webDav?.configuration.encryptedPassword) {
        decryptVault(vault, webDav.configuration.encryptedPassword, 'webdav/password', true)
      }
      if (webDav?.changed) {
        database.exec('BEGIN IMMEDIATE')
        try {
          writeWebDav(database, {
            ...webDav.configuration,
            ...(webDav.configuration.encryptedPassword
              ? { encryptedPassword: webDav.configuration.encryptedPassword }
              : webDav.embeddedPassword
                ? { encryptedPassword: vault.encryptString(webDav.embeddedPassword).toString('base64') }
                : {}),
          })
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
      return
    }
    if (hasWrappedSecrets) {
      const manifest = readManifest(database)
      key = await deriveSecretKey(password, Buffer.from(manifest.salt, 'base64url'))
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      const updateCredential = database.prepare('UPDATE credentials SET encrypted_value = ? WHERE id = ?')
      for (const row of credentialRows) {
        const plaintext = unwrapSecret(row.encrypted_value, key!, `credentials/${row.id}`)
        updateCredential.run(vault.encryptString(plaintext).toString('base64'), row.id)
      }
      if (webDav) {
        const plaintext = webDav.configuration.encryptedPassword
          ? unwrapSecret(webDav.configuration.encryptedPassword, key!, 'webdav/password')
          : webDav.embeddedPassword
        const { encryptedPassword: _portableCiphertext, ...configuration } = webDav.configuration
        writeWebDav(database, {
          ...configuration,
          ...(plaintext !== undefined
            ? { encryptedPassword: vault.encryptString(plaintext).toString('base64') }
            : {}),
        })
      }
      database.prepare('DELETE FROM app_metadata WHERE key = ?').run(MANIFEST_KEY)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    key?.fill(0)
    database.close()
  }
}

function requireVault(vault: PortableSecretVault | undefined): asserts vault is PortableSecretVault {
  requireSecureCredentialVault(vault,
    'System credential encryption is unavailable; portable secrets cannot be migrated')
}

function decryptVault(vault: PortableSecretVault, encrypted: string, locator: string, legacy = false): string {
  try {
    return vault.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    if (legacy) {
      throw new Error('portable-v1-vault-mismatch: this legacy backup must be imported on its original device')
    }
    throw new Error(`Unable to migrate protected credential ${locator}`)
  }
}

function wrapSecret(plaintext: string, key: Buffer, locator: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`stone-portable-v2\0${locator}`))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

function unwrapSecret(value: string, key: Buffer, locator: string): string {
  if (!value.startsWith(PREFIX)) throw new Error(`Portable credential ${locator} is not wrapped`)
  const [ivValue, tagValue, encryptedValue, extra] = value.slice(PREFIX.length).split('.')
  if (!ivValue || !tagValue || encryptedValue === undefined || extra !== undefined) {
    throw new Error(`Portable credential ${locator} is malformed`)
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'))
    decipher.setAAD(Buffer.from(`stone-portable-v2\0${locator}`))
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error(`Portable credential ${locator} cannot be authenticated`)
  }
}

function readManifest(database: DatabaseSync): SecretManifest {
  const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get(MANIFEST_KEY) as { value?: string } | undefined
  try {
    const value = JSON.parse(row?.value ?? '') as Partial<SecretManifest>
    const salt = typeof value.salt === 'string' ? Buffer.from(value.salt, 'base64url') : Buffer.alloc(0)
    if (value.version !== 2 || salt.length !== 16) throw new Error()
    return { version: 2, salt: value.salt! }
  } catch {
    throw new Error('Portable secret manifest is missing or invalid')
  }
}

function readWebDav(database: DatabaseSync): PortableWebDavConfiguration | undefined {
  const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get(WEBDAV_KEY) as { value?: string } | undefined
  if (!row?.value) return undefined
  try {
    const value = JSON.parse(row.value) as Record<string, unknown>
    if (value.version !== 1 || typeof value.baseUrl !== 'string' || typeof value.username !== 'string') return undefined
    return {
      version: 1,
      baseUrl: value.baseUrl,
      username: value.username,
      ...(typeof value.encryptedPassword === 'string' ? { encryptedPassword: value.encryptedPassword } : {}),
    }
  } catch { return undefined }
}

/**
 * Legacy builds accepted Basic credentials in the URL. Portable staging must
 * never retain that plaintext: independently encrypted fields take precedence;
 * otherwise the embedded password is returned for immediate wrapping.
 */
function normalizePortableWebDav(value: PortableWebDavConfiguration): NormalizedPortableWebDav {
  let url: URL
  try {
    url = new URL(value.baseUrl)
  } catch {
    if (value.baseUrl.includes('@')) {
      throw new Error('Legacy WebDAV credentials could not be migrated safely')
    }
    return { configuration: value, changed: false }
  }
  if (!url.username && !url.password) return { configuration: value, changed: false }

  const embeddedUsername = decodeUrlCredential(url.username)
  const embeddedPassword = decodeUrlCredential(url.password)
  const username = value.username || embeddedUsername
  if (!value.encryptedPassword && embeddedPassword) {
    if (!username) throw new Error('Legacy WebDAV password has no associated username')
    if (value.username && embeddedUsername && value.username !== embeddedUsername) {
      throw new Error('Legacy WebDAV credentials conflict with the configured username')
    }
  }
  url.username = ''
  url.password = ''
  return {
    configuration: {
      ...value,
      baseUrl: url.toString(),
      username,
    },
    ...(!value.encryptedPassword && embeddedPassword ? { embeddedPassword } : {}),
    changed: true,
  }
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('Legacy WebDAV credentials use invalid URL encoding')
  }
}

function writeWebDav(database: DatabaseSync, value: object): void {
  writeMetadata(database, WEBDAV_KEY, JSON.stringify(value))
}

function writeMetadata(database: DatabaseSync, key: string, value: string): void {
  database.prepare(`
    INSERT INTO app_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

async function deriveSecretKey(password: string, salt: Buffer): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey))
  })
}
