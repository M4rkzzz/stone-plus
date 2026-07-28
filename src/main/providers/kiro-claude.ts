import { randomUUID } from 'node:crypto'
import type { Protocol } from '../../shared/types'
import { inferProviderUrlScheme } from '../../shared/provider-url'
import { classifyProviderFailure } from './failure'
import type {
  ModelDiscoveryResult,
  ProviderAdapter,
  ProviderCapabilityMatrix,
  ProviderEndpointInput,
  ProviderHeaderInput,
  ProviderHealthResult,
  ProviderProbeInput,
} from './types'

export const KIRO_CLAUDE_AMZ_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
export const KIRO_CLAUDE_REQUEST_CONTENT_TYPE = 'application/x-amz-json-1.0'
export const KIRO_CLAUDE_RESPONSE_CONTENT_TYPE = 'application/vnd.amazon.eventstream'

const capabilities: ProviderCapabilityMatrix = {
  protocols: {
    // Tool support is deliberately false until the dedicated two-turn probe
    // persists positive evidence for this exact endpoint, key and model.
    'kiro-claude': { streaming: true, toolCalls: false, modelInPath: false },
  },
  modelDiscovery: false,
  healthProbe: false,
  authentication: 'bearer',
}

/**
 * Kiro Claude relay endpoints are complete GenerateAssistantResponse URLs.
 * Unlike versioned REST adapters, no operation path may be inferred or added.
 */
export const kiroClaudeAdapter: ProviderAdapter = Object.freeze({
  kind: 'kiro-compatible',
  capabilities,

  buildEndpoint(input: ProviderEndpointInput): string {
    assertKiroProtocol(input.protocol)
    if (input.operation !== 'generate') {
      throw new Error('Kiro Claude supports only its exact GenerateAssistantResponse endpoint.')
    }
    return normalizeExactEndpoint(input.baseUrl)
  },

  applyRequestHeaders(headers: Headers, input: ProviderHeaderInput): void {
    assertKiroProtocol(input.protocol)
    const credential = input.credential.trim()
    if (!credential) throw new Error('Provider credential is required')

    // Never forward downstream client identity, tenant metadata or protocol
    // headers across the Kiro relay trust boundary.
    for (const name of [
      'authorization',
      'x-api-key',
      'anthropic-version',
      'anthropic-beta',
      'openai-organization',
      'openai-project',
      'user-agent',
      'x-amz-target',
      'x-amzn-codewhisperer-optout',
      'amz-sdk-invocation-id',
      'amz-sdk-request',
      'accept',
      'content-type',
    ]) headers.delete(name)

    headers.set('authorization', `Bearer ${credential}`)
    headers.set('content-type', KIRO_CLAUDE_REQUEST_CONTENT_TYPE)
    headers.set('accept', '*/*')
    headers.set('x-amz-target', KIRO_CLAUDE_AMZ_TARGET)
    headers.set('x-amzn-codewhisperer-optout', 'false')
    headers.set('amz-sdk-invocation-id', randomUUID())
    headers.set('amz-sdk-request', 'attempt=1; max=1')
  },

  async discoverModels(input: ProviderProbeInput): Promise<ModelDiscoveryResult> {
    assertKiroProtocol(input.protocol)
    const checkedAt = (input.now ?? (() => Date.now()))()
    return { ok: true, models: [], checkedAt, latencyMs: 0 }
  },

  async probeHealth(input: ProviderProbeInput): Promise<ProviderHealthResult> {
    assertKiroProtocol(input.protocol)
    const checkedAt = (input.now ?? (() => Date.now()))()
    return {
      ok: false,
      checkedAt,
      latencyMs: 0,
      failure: {
        category: 'invalid_request',
        message: 'Kiro Claude authentication must be verified by the dedicated tool round-trip probe.',
        retryable: false,
        accountAction: 'none',
      },
    }
  },

  classifyFailure: classifyProviderFailure,
})

function assertKiroProtocol(protocol: Protocol): void {
  if (protocol !== 'kiro-claude') {
    throw new Error(`kiro-compatible does not support the ${protocol} protocol`)
  }
}

function normalizeExactEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(inferProviderUrlScheme(value))
  } catch {
    throw new Error('Kiro Claude endpoint must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Kiro Claude endpoint must use HTTP(S)')
  }
  if (url.username || url.password) {
    throw new Error('Kiro Claude endpoint must not contain credentials')
  }
  if (url.search || url.hash) {
    throw new Error('Kiro Claude endpoint must not contain a query string or fragment')
  }
  return url.toString()
}
