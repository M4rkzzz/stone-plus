import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PersistentDiagnosticLog,
  redactDiagnosticString,
  redactDiagnosticValue,
} from '../../src/main/diagnostics/persistent-diagnostic-log'

describe('PersistentDiagnosticLog', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  }))))

  it('writes bounded structured diagnostics without credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stone-diagnostics-'))
    directories.push(directory)
    const log = new PersistentDiagnosticLog(directory, {
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    })
    log.record('network-failure', 'Bearer secret-token-value sk-abcdefghijklmnopqrstuvwxyz', {
      authorization: 'Bearer another-secret',
      nested: { apiKey: 'top-secret', statusCode: 502 },
      url: 'https://example.test/path?access_token=secret-value',
    })

    const entry = JSON.parse((await readFile(log.path, 'utf8')).trim()) as Record<string, unknown>
    const serialized = JSON.stringify(entry)
    expect(entry).toMatchObject({
      timestamp: '2026-08-05T12:00:00.000Z',
      event: 'network-failure',
      details: {
        authorization: '[REDACTED]',
        nested: { apiKey: '[REDACTED]', statusCode: 502 },
      },
    })
    expect(serialized).not.toContain('secret-token-value')
    expect(serialized).not.toContain('another-secret')
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('secret-value')
  })

  it('redacts standalone values without mutating safe diagnostic fields', () => {
    expect(redactDiagnosticString('failed https://x.test/?token=abc')).toContain('token=[REDACTED]')
    expect(redactDiagnosticString(
      'refresh_token="rotation-value-123456" id_token=eyJheader123.payloadvalue123.signature123',
    )).not.toContain('rotation-value-123456')
    expect(redactDiagnosticString(
      'refresh_token="rotation-value-123456" id_token=eyJheader123.payloadvalue123.signature123',
    )).not.toContain('eyJheader123')
    expect(redactDiagnosticValue({ reason: 'crashed', exitCode: 9, cookie: 'private' }))
      .toEqual({ reason: 'crashed', exitCode: 9, cookie: '[REDACTED]' })
  })
})
