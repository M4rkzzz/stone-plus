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
      const token = Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')
      this.authorization = `Basic ${token}`
      this.sensitiveValues.push(token)
    }
  }

  public async test(signal?: AbortSignal): Promise<void> {
    const response = await this.request(this.baseUrl, {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      signal,
    })
    if (response.status !== 207) throw await webDavError('WebDAV connection test failed', response, this.sensitiveValues)
    const xml = await readBoundedResponse(response, 256 * 1024)
    if (!isWebDavCollectionResponse(xml, this.baseUrl)) {
      throw new Error('WebDAV connection test failed: the server did not return a DAV collection')
    }
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
    cancelBody(response.body)
  }

  public async download(remoteName: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    const name = validRemoteName(remoteName)
    const response = await this.request(new URL(encodeURIComponent(name), this.baseUrl), { signal })
    if (!response.ok || !response.body) throw await webDavError('Unable to download WebDAV backup', response, this.sensitiveValues)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_BACKUP_BYTES) {
      cancelBody(response.body, 'Remote WebDAV backup is too large')
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
    cancelBody(response.body)
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

interface XmlElement {
  qname: string
  localName: string
  namespace: string
  children: XmlElement[]
  text: string
}

const DAV_NAMESPACE = 'DAV:'
const XML_NAME = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?'

function parseWebDavEntries(xml: string, baseUrl: URL): WebDavBackupEntry[] {
  const root = parseDavMultistatus(xml)
  const output: WebDavBackupEntry[] = []
  for (const response of davChildren(root, 'response')) {
    const hrefValue = davText(response, 'href')
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
    const successfulProperties = successfulDavProperties(response)
    if (successfulProperties.length === 0) continue
    const sizeValue = firstDavPropertyText(successfulProperties, 'getcontentlength')
    const modifiedValue = firstDavPropertyText(successfulProperties, 'getlastmodified')
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

function isWebDavCollectionResponse(xml: string, baseUrl: URL): boolean {
  let root: XmlElement
  try {
    root = parseDavMultistatus(xml)
  } catch {
    return false
  }
  return davChildren(root, 'response').some((response) => {
    const hrefValue = davText(response, 'href')
    const isCollection = successfulDavProperties(response).some((properties) => {
      const resourceType = davChildren(properties, 'resourcetype')[0]
      return Boolean(resourceType && davChildren(resourceType, 'collection').length > 0)
    })
    if (!hrefValue || !isCollection) return false
    try {
      const href = new URL(decodeXml(hrefValue), baseUrl)
      return href.origin === baseUrl.origin
        && normalizedCollectionPath(href.pathname) === normalizedCollectionPath(baseUrl.pathname)
    } catch {
      return false
    }
  })
}

function parseDavMultistatus(xml: string): XmlElement {
  const root = parseXml(xml)
  if (root.namespace !== DAV_NAMESPACE || root.localName !== 'multistatus') {
    throw new Error('WebDAV response is not a valid DAV multistatus document')
  }
  return root
}

function successfulDavProperties(response: XmlElement): XmlElement[] {
  const properties: XmlElement[] = []
  for (const propstat of davChildren(response, 'propstat')) {
    const status = davText(propstat, 'status')
    const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/i.exec(status ?? '')
    const code = Number(match?.[1])
    if (!Number.isInteger(code) || code < 200 || code >= 300) continue
    const property = davChildren(propstat, 'prop')[0]
    if (property) properties.push(property)
  }
  return properties
}

function firstDavPropertyText(properties: readonly XmlElement[], localName: string): string | undefined {
  for (const property of properties) {
    const value = davText(property, localName)
    if (value !== undefined) return value
  }
  return undefined
}

function davChildren(element: XmlElement, localName: string): XmlElement[] {
  return element.children.filter((child) => child.namespace === DAV_NAMESPACE && child.localName === localName)
}

function davText(element: XmlElement, localName: string): string | undefined {
  const child = davChildren(element, localName)[0]
  return child ? elementText(child).trim() : undefined
}

function elementText(element: XmlElement): string {
  return element.text + element.children.map(elementText).join('')
}

/** A deliberately small, non-validating XML reader with namespace resolution. */
function parseXml(xml: string): XmlElement {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new Error('Unsafe XML declaration')
  const tokenPattern = new RegExp(
    `<\\?[\\s\\S]*?\\?>|<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\/?${XML_NAME}(?:\\s+[^<>]*?)?\\/?>|[^<]+`,
    'g',
  )
  const stack: Array<{ element: XmlElement; namespaces: Map<string, string> }> = []
  let root: XmlElement | undefined
  let consumed = 0
  for (const match of xml.matchAll(tokenPattern)) {
    if (match.index !== consumed) throw new Error('Malformed XML')
    const token = match[0]
    consumed += token.length
    if (token.startsWith('<?') || token.startsWith('<!--')) continue
    if (token.startsWith('<![CDATA[')) {
      if (stack.length === 0) throw new Error('CDATA outside the document element')
      stack.at(-1)!.element.text += token.slice(9, -3)
      continue
    }
    if (!token.startsWith('<')) {
      if (stack.length > 0) stack.at(-1)!.element.text += decodeXml(token)
      else if (token.trim()) throw new Error('Text outside the document element')
      continue
    }
    if (token.startsWith('</')) {
      const qname = new RegExp(`^</(${XML_NAME})\\s*>$`).exec(token)?.[1]
      const current = stack.pop()
      if (!qname || !current || current.element.qname !== qname) throw new Error('Mismatched XML closing tag')
      continue
    }
    const opening = new RegExp(`^<(${XML_NAME})([\\s\\S]*?)(/?)>$`).exec(token)
    if (!opening) throw new Error('Malformed XML start tag')
    const [, qname, rawAttributes, selfClosing] = opening
    const inherited = stack.length > 0 ? stack.at(-1)!.namespaces : new Map<string, string>()
    const namespaces = new Map(inherited)
    parseXmlAttributes(rawAttributes, namespaces)
    const { prefix, localName } = splitXmlName(qname)
    const namespace = namespaces.get(prefix) ?? ''
    const element: XmlElement = { qname, localName, namespace, children: [], text: '' }
    if (stack.length > 0) stack.at(-1)!.element.children.push(element)
    else if (root) throw new Error('Multiple XML document elements')
    else root = element
    if (!selfClosing) stack.push({ element, namespaces })
  }
  if (consumed !== xml.length || stack.length > 0 || !root) throw new Error('Malformed XML document')
  return root
}

function parseXmlAttributes(value: string, namespaces: Map<string, string>): void {
  const attributePattern = new RegExp(`\\s+(${XML_NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g')
  const seen = new Set<string>()
  let consumed = 0
  for (const match of value.matchAll(attributePattern)) {
    if (value.slice(consumed, match.index).trim()) throw new Error('Malformed XML attributes')
    consumed = match.index! + match[0].length
    const name = match[1]
    if (seen.has(name)) throw new Error('Duplicate XML attribute')
    seen.add(name)
    const attributeValue = decodeXml(match[2] ?? match[3] ?? '')
    if (name === 'xmlns') namespaces.set('', attributeValue)
    else if (name.startsWith('xmlns:')) namespaces.set(name.slice('xmlns:'.length), attributeValue)
  }
  if (value.slice(consumed).trim()) throw new Error('Malformed XML attributes')
}

function splitXmlName(qname: string): { prefix: string; localName: string } {
  const separator = qname.indexOf(':')
  return separator < 0
    ? { prefix: '', localName: qname }
    : { prefix: qname.slice(0, separator), localName: qname.slice(separator + 1) }
}

function normalizedCollectionPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/'
}

function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"
  })[entity] ?? entity)
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    cancelBody(response.body, 'WebDAV response is too large')
    throw new Error('WebDAV response is too large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!next.value?.byteLength) continue
      received += next.value.byteLength
      if (received > limit) {
        cancelReader(reader, 'WebDAV response is too large')
        throw new Error('WebDAV response is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received).toString('utf8')
}

function cancelBody(body: ReadableStream<Uint8Array> | null | undefined, reason?: unknown): void {
  try {
    void body?.cancel(reason).catch(() => undefined)
  } catch {
    // Cancellation is cleanup only and must never delay the terminal result.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined)
  } catch {
    // Cancellation is cleanup only and must never delay the terminal result.
  }
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
