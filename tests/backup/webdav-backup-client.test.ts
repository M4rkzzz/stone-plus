import { describe, expect, it, vi } from 'vitest'
import { WebDavBackupClient } from '../../src/main/backup'

describe('WebDavBackupClient', () => {
  it('lists only portable backups and sends protected basic authentication', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/stone/</d:href></d:response>
      <d:response><d:href>/stone/backup-1.stonebackup</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:getlastmodified>Wed, 22 Jul 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
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
})
