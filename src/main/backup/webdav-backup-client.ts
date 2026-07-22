import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

const MAX_REMOTE_BACKUP_BYTES = 4 * 1024 * 1024 * 1024

export interface WebDavBackupClientOptions {
  baseUrl: string
  username?: string
  password?: string
  fetchImplementation?: typeof fetch
}

export interface WebDavBackupEntry {
  name: string
  size?: number
  modifiedAt?: number
}

export class WebDavBackupClient {
  private readonly baseUrl: URL
  private readonly authorization?: string
  private readonly sensitiveValues: string[]
  private readonly fetchImplementation: typeof fetch

  public constructor(options: WebDavBackupClientOptions) {
    this.baseUrl = normalizeWebDavUrl(options.baseUrl)
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.sensitiveValues = [options.username, options.password].filter((value): value is string => Boolean(value))
    if (this.baseUrl.username || this.baseUrl.password) throw new Error('WebDAV credentials must not be embedded in the URL')
    if (options.username || options.password) {
      if (!options.username || !options.password) throw new Error('Both WebDAV username and password are required')
      this.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`
    }
  }

  public async test(signal?: AbortSignal): Promise<void> {
    const response = await this.request(this.baseUrl, { method: 'PROPFIND', headers: { depth: '0' }, signal })
    if (response.status !== 207) throw await webDavError('WebDAV connection test failed', response, this.sensitiveValues)
    await response.body?.cancel().catch(() => undefined)
  }

  public async list(signal?: AbortSignal): Promise<WebDavBackupEntry[]> {
    const response = await this.request(this.baseUrl, { method: 'PROPFIND', headers: { depth: '1' }, signal })
    if (response.status !== 207) throw await webDavError('Unable to list WebDAV backups', response, this.sensitiveValues)
    const xml = await readBoundedResponse(response, 2 * 1024 * 1024)
    const entries = parseWebDavEntries(xml, this.baseUrl)
    return entries.filter((entry) => entry.name.endsWith('.stonebackup'))
  }

  public async upload(localPath: string, remoteName = basename(localPath), signal?: AbortSignal): Promise<void> {
    const name = validRemoteName(remoteName)
    const source = await lstat(localPath)
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('WebDAV upload source must be a regular file')
    const response = await this.request(new URL(encodeURIComponent(name), this.baseUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(source.size) },
      body: createReadStream(localPath) as unknown as BodyInit,
      signal,
      // Node fetch requires duplex for streaming request bodies.
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    if (!response.ok) throw await webDavError('Unable to upload WebDAV backup', response, this.sensitiveValues)
    await response.body?.cancel().catch(() => undefined)
  }

  public async download(remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    const name = validRemoteName(remoteName)
    const response = await this.request(new URL(encodeURIComponent(name), this.baseUrl), { signal })
    if (!response.ok || !response.body) throw await webDavError('Unable to download WebDAV backup', response, this.sensitiveValues)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_BACKUP_BYTES) {
      await response.body.cancel().catch(() => undefined)
      throw new Error('Remote WebDAV backup is too large')
    }
    const temporaryPath = `${destinationPath}.${process.pid}.webdav.tmp`
    try {
      await pipeline(
        response.body as unknown as NodeJS.ReadableStream,
        new DownloadSizeGuard(MAX_REMOTE_BACKUP_BYTES),
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
      )
      await rename(temporaryPath, destinationPath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  public async delete(remoteName: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(new URL(encodeURIComponent(validRemoteName(remoteName)), this.baseUrl), {
      method: 'DELETE', signal
    })
    if (!response.ok && response.status !== 404) throw await webDavError('Unable to delete WebDAV backup', response, this.sensitiveValues)
    await response.body?.cancel().catch(() => undefined)
  }

  private request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.authorization) headers.set('authorization', this.authorization)
    headers.set('user-agent', 'StonePlus-WebDAV/1')
    return this.fetchImplementation(url, { ...init, headers, redirect: 'error' })
  }
}

export function normalizeWebDavUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('WebDAV URL is invalid')
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('WebDAV requires HTTPS except for loopback testing')
  }
  if (url.username || url.password) throw new Error('WebDAV credentials must not be embedded in the URL')
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function validRemoteName(value: string): string {
  const name = value.trim()
  if (name !== basename(name) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.stonebackup$/.test(name)) {
    throw new Error('WebDAV backup name is invalid')
  }
  return name
}

function parseWebDavEntries(xml: string, baseUrl: URL): WebDavBackupEntry[] {
  const responses = xml.match(/<(?:[a-z]+:)?response\b[\s\S]*?<\/(?:[a-z]+:)?response>/gi) ?? []
  const output: WebDavBackupEntry[] = []
  for (const response of responses) {
    const hrefValue = firstXmlText(response, 'href')
    if (!hrefValue) continue
    let href: URL
    try {
      href = new URL(decodeXml(hrefValue), baseUrl)
    } catch {
      continue
    }
    let name = ''
    try { name = decodeURIComponent(href.pathname.split('/').filter(Boolean).at(-1) ?? '') } catch { continue }
    if (!name || href.pathname.replace(/\/+$/, '/') === baseUrl.pathname.replace(/\/+$/, '/')) continue
    const sizeValue = firstXmlText(response, 'getcontentlength')
    const modifiedValue = firstXmlText(response, 'getlastmodified')
    const size = sizeValue === undefined ? undefined : Number(sizeValue)
    const modifiedAt = modifiedValue === undefined ? undefined : Date.parse(modifiedValue)
    output.push({
      name,
      ...(Number.isFinite(size) && size! >= 0 ? { size } : {}),
      ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {})
    })
  }
  return output
}

function firstXmlText(xml: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<(?:[a-z]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z]+:)?${escaped}>`, 'i').exec(xml)?.[1]?.trim()
}

function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"
  })[entity] ?? entity)
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) throw new Error('WebDAV response is too large')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > limit) throw new Error('WebDAV response is too large')
  return buffer.toString('utf8')
}

async function webDavError(prefix: string, response: Response, secrets: readonly string[] = []): Promise<Error> {
  let detail = ''
  try {
    detail = redactSecrets((await readBoundedResponse(response, 8 * 1024)), secrets)
      .replace(/\s+/g, ' ').trim().slice(0, 240)
  } catch {
    detail = ''
  }
  return new Error(`${prefix}: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`)
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let output = value.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[redacted]')
  return output
}

class DownloadSizeGuard extends Transform {
  private received = 0

  constructor(private readonly maximum: number) { super() }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.received += chunk.byteLength
    if (this.received > this.maximum) return callback(new Error('Remote WebDAV backup is too large'))
    callback(null, chunk)
  }
}
