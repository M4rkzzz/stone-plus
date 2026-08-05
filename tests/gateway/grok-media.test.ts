import { describe, expect, it } from 'vitest'
import {
  buildGrokMediaUpstreamUrl,
  classifyGrokMediaRoute,
  extractGrokVideoRequestId,
  grokMediaEligibility,
  prepareGrokMediaRequest,
  rewriteGrokVideoContentUrl,
  validGrokSignedVideoUrl,
} from '../../src/main/gateway/grok-media'
import type { Account, ProviderDefinition } from '../../src/shared/types'

const now = 1_700_000_000_000

function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'grok-provider',
    name: 'Grok',
    sourceType: 'official-api',
    kind: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-responses',
    models: ['grok-4.5'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'grok-account',
    providerId: 'grok-provider',
    name: 'Grok',
    credentialId: 'credential',
    maskedCredential: '***',
    credentialType: 'api-key',
    status: 'active',
    priority: 1,
    weight: 1,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: [],
    modelPolicy: 'all',
    modelAllowlist: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('Grok media routing boundary', () => {
  it('recognizes only the supported image and video paths', () => {
    expect(classifyGrokMediaRoute('POST', '/v1/images/generations')).toMatchObject({
      endpoint: 'images-generations', capability: 'imageGeneration', requiresBody: true,
    })
    expect(classifyGrokMediaRoute('POST', '/v1/videos/extensions')).toMatchObject({
      endpoint: 'videos-extensions', capability: 'videoEdit',
    })
    expect(classifyGrokMediaRoute('GET', '/v1/videos/request%201/content')).toMatchObject({
      endpoint: 'video-content', requestId: 'request 1', requiresBody: false,
    })
    expect(classifyGrokMediaRoute('GET', '/v1/videos/..%2Fsecret')).toBeUndefined()
    expect(classifyGrokMediaRoute('DELETE', '/v1/videos/request')).toBeUndefined()
  })

  it('normalizes native aliases and strips unsupported image size', async () => {
    const route = classifyGrokMediaRoute('POST', '/v1/images/generations')!
    const prepared = await prepareGrokMediaRequest(
      route,
      'application/json',
      Buffer.from(JSON.stringify({ model: 'grok-imagine', prompt: 'stone', size: '1024x1024' })),
    )
    expect(prepared.model).toBe('grok-imagine-image-quality')
    expect(JSON.parse(prepared.body!.toString('utf8'))).toEqual({
      model: 'grok-imagine-image-quality', prompt: 'stone',
    })
  })

  it('preserves the distinct general and image-to-video model ids', async () => {
    const route = classifyGrokMediaRoute('POST', '/v1/videos/generations')!
    const imageToVideo = await prepareGrokMediaRequest(
      route,
      'application/json',
      Buffer.from(JSON.stringify({
        model: 'grok-imagine-video-1.5', prompt: 'stone', image: { url: 'https://example.test/a.png' },
      })),
    )
    const textToVideo = await prepareGrokMediaRequest(
      route,
      'application/json',
      Buffer.from(JSON.stringify({ model: 'grok-imagine-video', prompt: 'stone' })),
    )
    expect(imageToVideo.model).toBe('grok-imagine-video-1.5')
    expect(textToVideo.model).toBe('grok-imagine-video')
  })

  it('fails closed for unverified/free OAuth media but permits paid and API-key sources', () => {
    const oauth = account({ credentialType: 'grok-oauth' })
    expect(grokMediaEligibility(oauth, provider({ sourceType: 'oauth-system' }), 'imageGeneration'))
      .toEqual({ eligible: false, reason: 'oauth-unverified' })
    expect(grokMediaEligibility({
      ...oauth,
      grokQuota: { paidClassification: 'free', observedAt: now, source: 'grok-build-billing' },
    }, provider({ sourceType: 'oauth-system' }), 'imageGeneration'))
      .toEqual({ eligible: false, reason: 'oauth-free' })
    expect(grokMediaEligibility({
      ...oauth,
      grokQuota: { paidClassification: 'paid', observedAt: now, source: 'grok-build-billing' },
    }, provider({ sourceType: 'oauth-system' }), 'imageGeneration')).toEqual({ eligible: true })
    expect(grokMediaEligibility(account(), provider(), 'videoGeneration')).toEqual({ eligible: true })
  })

  it('requires explicit media declarations from compatible relays', () => {
    const relay = provider({ sourceType: 'relay', kind: 'xai-compatible' })
    expect(grokMediaEligibility(account(), relay, 'imageGeneration')).toEqual({
      eligible: false, reason: 'capability-unverified',
    })
    expect(grokMediaEligibility(account(), {
      ...relay,
      capabilityProfile: {
        version: 1, origin: 'declared', imageGeneration: true,
      },
    }, 'imageGeneration')).toEqual({ eligible: true })
  })

  it('routes OAuth status polling to api.x.ai and validates signed video URLs', () => {
    const route = classifyGrokMediaRoute('GET', '/v1/videos/request-1')!
    expect(buildGrokMediaUpstreamUrl(provider({ baseUrl: 'https://cli-chat-proxy.grok.com/v1' }), 'grok-oauth', route))
      .toBe('https://api.x.ai/v1/videos/request-1')
    expect(validGrokSignedVideoUrl('https://vidgen.x.ai/content/one?sig=ok'))
      .toBe('https://vidgen.x.ai/content/one?sig=ok')
    expect(validGrokSignedVideoUrl('https://evil.example/content/one')).toBeUndefined()
  })

  it('extracts request ids and rewrites only the protected video content URL', () => {
    expect(extractGrokVideoRequestId({ request_id: 'task-1' })).toBe('task-1')
    expect(rewriteGrokVideoContentUrl(
      { id: 'task-1', video: { url: 'https://vidgen.x.ai/private' } },
      'task-1',
      'http://127.0.0.1:15720/v1/videos/task-1/content',
    )).toEqual({
      id: 'task-1',
      video: { id: 'task-1', url: 'http://127.0.0.1:15720/v1/videos/task-1/content' },
    })
  })
})
