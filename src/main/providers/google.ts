import { createProviderAdapter } from './adapter'
import { parseGoogleModels } from './model-parsers'
import { protocolOperationPath } from './paths'
import type { ProviderCapabilityMatrix } from './types'

const capabilities: ProviderCapabilityMatrix = {
  protocols: {
    gemini: { streaming: true, toolCalls: true, modelInPath: true }
  },
  modelDiscovery: true,
  healthProbe: true,
  authentication: 'x-goog-api-key'
}

export const googleAdapter = createProviderAdapter({
  kind: 'google',
  capabilities,
  defaultVersion: 'v1beta',
  buildOperationPath: protocolOperationPath,
  applyAuthentication(headers, input): void {
    headers.set('x-goog-api-key', input.credential)
  },
  parseModels: parseGoogleModels
})
