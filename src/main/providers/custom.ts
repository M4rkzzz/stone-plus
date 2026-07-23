import { createProviderAdapter, readHeader } from './adapter'
import { parseDataModels } from './model-parsers'
import { protocolOperationPath } from './paths'
import type { ProviderCapabilityMatrix } from './types'

const capabilities: ProviderCapabilityMatrix = {
  protocols: {
    'anthropic-messages': { streaming: true, toolCalls: true, modelInPath: false },
    'openai-responses': { streaming: true, toolCalls: true, modelInPath: false },
    'openai-chat': { streaming: true, toolCalls: true, modelInPath: false },
    gemini: { streaming: true, toolCalls: true, modelInPath: true }
  },
  modelDiscovery: true,
  healthProbe: true,
  authentication: 'protocol-dependent'
}

export const customAdapter = createProviderAdapter({
  kind: 'custom',
  capabilities,
  defaultVersion: (input) => input.protocol === 'gemini' ? 'v1beta' : 'v1',
  buildOperationPath: protocolOperationPath,
  applyAuthentication(headers, input): void {
    if (input.protocol === 'anthropic-messages') {
      headers.set('x-api-key', input.credential)
      headers.set('anthropic-version', readHeader(input, 'anthropic-version') ?? '2023-06-01')
      const beta = readHeader(input, 'anthropic-beta')
      if (beta) headers.set('anthropic-beta', beta)
      return
    }
    if (input.protocol === 'gemini') {
      headers.set('x-goog-api-key', input.credential)
      return
    }
    headers.set('authorization', `Bearer ${input.credential}`)
  },
  parseModels: parseDataModels
})
