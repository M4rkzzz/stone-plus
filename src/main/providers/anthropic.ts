import { createProviderAdapter, readHeader } from './adapter'
import { parseDataModels } from './model-parsers'
import { protocolOperationPath } from './paths'
import type { ProviderKind } from '../../shared/types'
import type { ProviderAdapter, ProviderCapabilityMatrix } from './types'

const capabilities: ProviderCapabilityMatrix = {
  protocols: {
    'anthropic-messages': { streaming: true, toolCalls: true, modelInPath: false }
  },
  modelDiscovery: true,
  healthProbe: true,
  authentication: 'x-api-key'
}

export const anthropicAdapter = makeAnthropicAdapter('anthropic')
export const anthropicCompatibleAdapter = makeAnthropicAdapter('anthropic-compatible')

function makeAnthropicAdapter(kind: Extract<ProviderKind, 'anthropic' | 'anthropic-compatible'>): ProviderAdapter {
  return createProviderAdapter({
    kind,
    capabilities,
    defaultVersion: 'v1',
    buildOperationPath: protocolOperationPath,
    applyAuthentication(headers, input): void {
      headers.set('x-api-key', input.credential)
      headers.set('anthropic-version', readHeader(input, 'anthropic-version') ?? '2023-06-01')
      const beta = readHeader(input, 'anthropic-beta')
      if (beta) headers.set('anthropic-beta', beta)
    },
    parseModels: parseDataModels
  })
}
