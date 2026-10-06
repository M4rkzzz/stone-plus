import { createProviderAdapter } from './adapter'
import { parseDataModels } from './model-parsers'
import { protocolOperationPath } from './paths'
import type { ProviderKind } from '../../shared/types'
import type { ProviderAdapter, ProviderCapabilityMatrix } from './types'

const capabilities: ProviderCapabilityMatrix = {
  protocols: {
    'openai-responses': { streaming: true, toolCalls: true, modelInPath: false },
    'openai-chat': { streaming: true, toolCalls: true, modelInPath: false }
  },
  modelDiscovery: true,
  healthProbe: true,
  authentication: 'bearer'
}

/**
 * xAI-compatible relays use the OpenAI wire shapes, but are kept separate so
 * downstream OpenAI tenant identity never crosses into a third-party relay.
 */
export const xAIAdapter = makeXAIAdapter('xai')
export const xAICompatibleAdapter = makeXAIAdapter('xai-compatible')

function makeXAIAdapter(kind: Extract<ProviderKind, 'xai' | 'xai-compatible'>): ProviderAdapter {
  return createProviderAdapter({
    kind,
    capabilities,
    forwardUserAgent: false,
    defaultVersion: 'v1',
    buildOperationPath: protocolOperationPath,
    applyAuthentication(headers, input): void {
      headers.delete('user-agent')
      headers.delete('openai-organization')
      headers.delete('openai-project')
      headers.set('authorization', `Bearer ${input.credential}`)
    },
    parseModels: parseDataModels
  })
}
