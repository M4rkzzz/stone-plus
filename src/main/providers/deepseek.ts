import { createProviderAdapter } from './adapter'
import { parseDataModels } from './model-parsers'
import { protocolOperationPath } from './paths'
import { filterOfficialDeepSeekResponsesModels } from '../../shared/deepseek'
import type { ProviderKind } from '../../shared/types'
import type { ProviderAdapter, ProviderCapabilityMatrix } from './types'

const officialCapabilities: ProviderCapabilityMatrix = {
  protocols: {
    'openai-responses': { streaming: true, toolCalls: true, modelInPath: false },
  },
  modelDiscovery: true,
  healthProbe: true,
  authentication: 'bearer',
}

const compatibleCapabilities: ProviderCapabilityMatrix = {
  ...officialCapabilities,
  protocols: {
    ...officialCapabilities.protocols,
    'openai-chat': { streaming: true, toolCalls: true, modelInPath: false },
  },
}

export const deepSeekAdapter = makeDeepSeekAdapter('deepseek')
export const deepSeekCompatibleAdapter = makeDeepSeekAdapter('deepseek-compatible')

/**
 * DeepSeek exposes a native Responses wire. Keep it in a distinct trust and
 * pooling family and never forward OpenAI tenant identity to the endpoint.
 */
function makeDeepSeekAdapter(
  kind: Extract<ProviderKind, 'deepseek' | 'deepseek-compatible'>,
): ProviderAdapter {
  return createProviderAdapter({
    kind,
    capabilities: kind === 'deepseek' ? officialCapabilities : compatibleCapabilities,
    forwardUserAgent: false,
    defaultVersion: 'v1',
    buildOperationPath: protocolOperationPath,
    applyAuthentication(headers, input): void {
      headers.delete('user-agent')
      headers.delete('openai-organization')
      headers.delete('openai-project')
      headers.set('authorization', `Bearer ${input.credential}`)
    },
    parseModels: kind === 'deepseek'
      ? (payload) => filterOfficialDeepSeekResponsesModels(parseDataModels(payload))
      : parseDataModels,
  })
}
