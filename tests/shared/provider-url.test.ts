import { describe, expect, it } from 'vitest'
import {
  inferProviderUrlScheme,
  normalizeProviderHttpUrl,
  parseProviderHttpUrl,
} from '../../src/shared/provider-url'

describe('provider URL normalization', () => {
  it('allows remote HTTP and HTTPS URLs', () => {
    expect(normalizeProviderHttpUrl('http://relay.example.test:8080/v1'))
      .toBe('http://relay.example.test:8080/v1')
    expect(normalizeProviderHttpUrl('https://relay.example.test/v1/'))
      .toBe('https://relay.example.test/v1')
  })

  it('infers HTTP only for explicit bare IP shapes', () => {
    expect(inferProviderUrlScheme('192.168.1.20:8080/v1'))
      .toBe('http://192.168.1.20:8080/v1')
    expect(inferProviderUrlScheme('[2001:db8::20]:8080/v1'))
      .toBe('http://[2001:db8::20]:8080/v1')
    expect(() => parseProviderHttpUrl('relay.example.test/v1')).toThrow()
  })

  it('continues to reject unsafe protocols, embedded credentials, query strings and fragments', () => {
    expect(() => parseProviderHttpUrl('file:///tmp/provider')).toThrow(/HTTP or HTTPS/)
    expect(() => parseProviderHttpUrl('http://user:secret@relay.example/v1')).toThrow(/credentials/)
    expect(() => parseProviderHttpUrl('http://relay.example/v1?token=secret')).toThrow(/query string/)
    expect(() => parseProviderHttpUrl('http://relay.example/v1#secret')).toThrow(/fragment/)
  })
})
