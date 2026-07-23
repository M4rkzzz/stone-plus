import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WebDavBackupClient } from '../../src/main/backup'

describe('WebDavBackupClient', () => {
  it('lists only portable backups and sends protected basic authentication', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/stone/</d:href></d:response>
      <d:response><d:href>/stone/backup-1.stonebackup</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:getlastmodified>Wed, 22 Jul 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/stone/readme.txt</d:href></d:response>
    </d:multistatus>`
    const fetchImplementation = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers)
      expect(init?.method).toBe('PROPFIND')
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
      return new Response(xml, { status: 207 })
    }) as unknown as typeof fetch
    const client = new WebDavBackupClient({ baseUrl: 'https://dav.example/stone/', username: 'user', password: 'pass', fetchImplementation })
    await expect(client.list()).resolves.toEqual([{ name: 'backup-1.stonebackup', size: 42, modifiedAt: Date.parse('Wed, 22 Jul 2026 10:00:00 GMT') }])
  })

  it('accepts XML namespace prefixes containing digits', async () => {
    const xml = `<?xml version="1.0"?><ns0:multistatus xmlns:ns0="DAV:">
      <ns0:response><ns0:href>/stone/</ns0:href></ns0:response>
      <ns0:response><ns0:href>/stone/ns.stonebackup</ns0:href><ns0:propstat><ns0:prop>
        <ns0:getcontentlength>7</ns0:getcontentlength>
      </ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat></ns0:response>
    </ns0:multistatus>`
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(xml, { status: 207 })) as unknown as typeof fetch,
    })
    await expect(client.list()).resolves.toEqual([{ name: 'ns.stonebackup', size: 7 }])
  })

  it('validates that a successful connection test describes the target DAV collection', async () => {
    const fetchImplementation = vi.fn(async (_url, init) => {
      expect(String(init?.body)).toContain('resourcetype')
      return new Response(`<?xml version="1.0"?><ns0:multistatus xmlns:ns0="DAV:">
        <ns0:response><ns0:href>/stone/</ns0:href><ns0:propstat><ns0:prop>
          <ns0:resourcetype><ns0:collection/></ns0:resourcetype>
        </ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat></ns0:response>
      </ns0:multistatus>`, { status: 207 })
    }) as unknown as typeof fetch
    const client = new WebDavBackupClient({ baseUrl: 'https://dav.example/stone/', fetchImplementation })
    await expect(client.test()).resolves.toBeUndefined()

    const invalid = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/stone/</d:href></d:response></d:multistatus>',
        { status: 207 },
      )) as unknown as typeof fetch,
    })
    await expect(invalid.test()).rejects.toThrow(/DAV collection/)
  })

  it.each([
    [
      'a non-DAV namespace',
      '<x:multistatus xmlns:x="urn:not-dav"><x:response><x:href>/stone/</x:href><x:propstat><x:prop><x:resourcetype><x:collection/></x:resourcetype></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response></x:multistatus>',
    ],
    [
      'an unqualified XML vocabulary',
      '<multistatus><response><href>/stone/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
    ],
    [
      'a failed collection propstat',
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/stone/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>',
    ],
  ])('rejects %s during the connection test', async (_label, xml) => {
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(xml, { status: 207 })) as unknown as typeof fetch,
    })
    await expect(client.test()).rejects.toThrow(/DAV collection/)
  })

  it('uses only successful DAV propstats when parsing list metadata', async () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/stone/entry.stonebackup</d:href>
        <d:propstat><d:prop><d:getcontentlength>999</d:getcontentlength></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
        <d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      </d:response>
    </d:multistatus>`
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(xml, { status: 207 })) as unknown as typeof fetch,
    })
    await expect(client.list()).resolves.toEqual([{ name: 'entry.stonebackup', size: 7 }])
  })

  it('rejects a list response whose XML vocabulary is not DAV', async () => {
    const xml = '<x:multistatus xmlns:x="urn:not-dav"><x:response><x:href>/stone/fake.stonebackup</x:href><x:propstat><x:prop><x:getcontentlength>7</x:getcontentlength></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response></x:multistatus>'
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(xml, { status: 207 })) as unknown as typeof fetch,
    })
    await expect(client.list()).rejects.toThrow(/DAV multistatus/)
  })

  it('bounds streamed WebDAV metadata and cancels an oversized body', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
      cancel() {
        cancelled = true
        return new Promise<void>(() => undefined)
      },
    })
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response(body, { status: 207 })) as unknown as typeof fetch,
    })
    await expect(settlesWithin(client.list())).resolves.toBe('rejected')
    expect(cancelled).toBe(true)
  })

  it('never waits for response body cancellation on terminal WebDAV paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-webdav-cancel-'))
    const source = join(directory, 'source.stonebackup')
    const destination = join(directory, 'download.stonebackup')
    await writeFile(source, 'portable bytes')
    const fetchImplementation = vi.fn(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => new Promise<void>(() => undefined),
      })
      if (init?.method === 'PROPFIND') {
        return new Response(body, { status: 207, headers: { 'content-length': String(3 * 1024 * 1024) } })
      }
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(body, { status: 200 })
      return new Response(body, { status: 200, headers: { 'content-length': String(5 * 1024 * 1024 * 1024) } })
    }) as unknown as typeof fetch
    const client = new WebDavBackupClient({ baseUrl: 'https://dav.example/stone/', fetchImplementation })
    try {
      await expect(settlesWithin(client.upload(source))).resolves.toBe('resolved')
      await expect(settlesWithin(client.delete('source.stonebackup'))).resolves.toBe('resolved')
      await expect(settlesWithin(client.list())).resolves.toBe('rejected')
      await expect(settlesWithin(client.download('source.stonebackup', destination))).resolves.toBe('rejected')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects plaintext remote WebDAV and path traversal names', async () => {
    expect(() => new WebDavBackupClient({ baseUrl: 'http://dav.example/backups/' })).toThrow(/HTTPS/)
    const client = new WebDavBackupClient({ baseUrl: 'http://127.0.0.1:8080/backups/', fetchImplementation: vi.fn() as unknown as typeof fetch })
    await expect(client.delete('../state.stonebackup')).rejects.toThrow(/invalid/)
  })

  it('rejects embedded URL credentials and a generic HTTP 200 connection test', async () => {
    expect(() => new WebDavBackupClient({ baseUrl: 'https://alice:secret@dav.example/stone/' }))
      .toThrow(/embedded/)
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      fetchImplementation: vi.fn(async () => new Response('<html>login</html>', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(client.test()).rejects.toThrow(/HTTP 200/)
  })

  it('redacts credentials echoed by an untrusted WebDAV error response', async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      `Authorization: Basic ${Buffer.from('alice:top-secret').toString('base64')} top-secret`,
      { status: 401 },
    )) as unknown as typeof fetch
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/', username: 'alice', password: 'top-secret', fetchImplementation,
    })
    const error = await client.list().catch((cause: unknown) => cause)
    expect(String(error)).not.toContain('top-secret')
    expect(String(error)).not.toContain(Buffer.from('alice:top-secret').toString('base64'))
  })

  it('redacts a bare Base64 authorization token without a Basic prefix', async () => {
    const token = Buffer.from('alice:top-secret').toString('base64')
    const client = new WebDavBackupClient({
      baseUrl: 'https://dav.example/stone/',
      username: 'alice',
      password: 'top-secret',
      fetchImplementation: vi.fn(async () => new Response(`Rejected token ${token}`, { status: 401 })) as unknown as typeof fetch,
    })
    const error = await client.list().catch((cause: unknown) => cause)
    expect(String(error)).not.toContain(token)
    expect(String(error)).toContain('[redacted]')
  })
})

async function settlesWithin(operation: Promise<unknown>): Promise<'resolved' | 'rejected' | 'timeout'> {
  return await Promise.race([
    operation.then(() => 'resolved' as const, () => 'rejected' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
  ])
}
