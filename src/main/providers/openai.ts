import { createProviderAdapter, readHeader } from './adapter'
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

export const openAIAdapter = makeOpenAIAdapter('openai')
export const openAICompatibleAdapter = makeOpenAIAdapter('openai-compatible')

function makeOpenAIAdapter(kind: Extract<ProviderKind, 'openai' | 'openai-compatible'>): ProviderAdapter {
  return createProviderAdapter({
    kind,
    capabilities,
    defaultVersion: 'v1',
    buildOperationPath: protocolOperationPath,
    applyAuthentication(headers, input): void {
      headers.set('authorization', `Bearer ${input.credential}`)
      const organization = readHeader(input, 'openai-organization')
      const project = readHeader(input, 'openai-project')
      if (organization) headers.set('openai-organization', organization)
      if (project) headers.set('openai-project', project)
    },
    parseModels: parseDataModels
  })
}
