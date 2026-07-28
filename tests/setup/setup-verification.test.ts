import { describe, expect, it, vi } from 'vitest'
import { buildSetupVerificationRequest, verifySetupRouteRequest } from '../../src/main/setup/setup-verification'

describe('setup route verification', () => {
  it('builds native requests for every supported client', async () => {
    const codex = buildSetupVerificationRequest('http://127.0.0.1:15721/', 'codex', 'gpt-test', 'local-token')
    const claude = buildSetupVerificationRequest('http://127.0.0.1:15721', 'claude', 'claude-test', 'local-token')
    const gemini = buildSetupVerificationRequest('http://127.0.0.1:15721', 'gemini', 'gemini/test', 'local-token')

    expect(codex.url).toBe('http://127.0.0.1:15721/v1/responses')
    expect(JSON.parse(String(codex.init.body))).toMatchObject({ model: 'gpt-test', max_output_tokens: 16 })
    expect(claude.url).toBe('http://127.0.0.1:15721/v1/messages')
    expect(new Headers(claude.init.headers).get('x-api-key')).toBe('local-token')
    expect(gemini.url).toContain('/v1beta/models/gemini%2Ftest:generateContent')
  })

  it('returns a short parsed success preview', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ output_text: 'OK' }), { status: 200 })) as unknown as typeof fetch
    const result = await verifySetupRouteRequest({
      baseUrl: 'http://127.0.0.1:15721',
      client: 'codex',
      model: 'gpt-test',
      token: 'private-token',
      fetchImplementation,
    })
    expect(result).toMatchObject({ ok: true, status: 200, responsePreview: 'OK' })
    expect(JSON.stringify(result)).not.toContain('private-token')
  })

  it('returns a sanitized gateway error without throwing', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'No eligible account' } }), { status: 503 })) as unknown as typeof fetch
    const result = await verifySetupRouteRequest({
      baseUrl: 'http://127.0.0.1:15721',
      client: 'claude',
      model: 'claude-test',
      token: 'private-token',
      fetchImplementation,
    })
    expect(result).toMatchObject({ ok: false, status: 503 })
    expect(result.error).toContain('No eligible account')
  })

  it('redacts the local route token from gateway responses', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Rejected private-local-token' },
    }), { status: 401 })) as unknown as typeof fetch
    const result = await verifySetupRouteRequest({
      baseUrl: 'http://127.0.0.1:15721',
      client: 'codex',
      model: 'gpt-test',
      token: 'private-local-token',
      fetchImplementation,
    })
    expect(JSON.stringify(result)).not.toContain('private-local-token')
    expect(result.error).toContain('[redacted]')
  })
})
