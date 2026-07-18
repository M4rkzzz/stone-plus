import type { ProviderKind } from '../../shared/types'
import { anthropicAdapter, anthropicCompatibleAdapter } from './anthropic'
import { customAdapter } from './custom'
import { googleAdapter } from './google'
import { openAIAdapter, openAICompatibleAdapter } from './openai'
import type { ProviderAdapter } from './types'

const adapters: Readonly<Record<ProviderKind, ProviderAdapter>> = Object.freeze({
  anthropic: anthropicAdapter,
  openai: openAIAdapter,
  google: googleAdapter,
  'openai-compatible': openAICompatibleAdapter,
  'anthropic-compatible': anthropicCompatibleAdapter,
  custom: customAdapter
})

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  return adapters[kind] ?? customAdapter
}

export {
  anthropicAdapter,
  anthropicCompatibleAdapter,
  customAdapter,
  googleAdapter,
  openAIAdapter,
  openAICompatibleAdapter
}
export { classifyProviderFailure, parseRetryAfter } from './failure'
export { getProviderPreset, providerPresets } from './presets'
export {
  applyChatGptCodexHeaders,
  applyChatGptCodexSearchHeaders,
  CHATGPT_CODEX_MODELS_URL,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_CODEX_SEARCH_URL,
  CHATGPT_CODEX_USAGE_URL,
  CODEX_CLIENT_VERSION,
  classifyChatGptCodexFailure,
  probeChatGptAccount,
  queryChatGptCodexModels,
  queryChatGptCodexQuota,
  refreshChatGptCredential,
  resolveChatGptCredential,
  isChatGptCodexResponsesLiteBody,
  withChatGptCodexBody
} from './chatgpt-codex'
export {
  extractProtocolUsage,
  extractCodexQuotaFromHeaders,
  extractCodexQuotaFromUsagePayload,
  codexQuotaCooldownUntil,
  codexQuotaIsExhausted,
  extractQuotaSignals,
  extractRateLimitSignals,
  mergeQuotaSignals,
  parseQuotaResetAt
} from './quota'
export {
  AccountModelProbeError,
  probeChatGptCodexModel,
  probeProviderModel
} from './model-probe'
export type {
  ChatGptModelProbeInput,
  ProviderModelProbeInput
} from './model-probe'
export type {
  NormalizedQuotaSignals,
  NormalizedQuotaWindow,
  NormalizedRateLimits,
  NormalizedTokenUsage,
  QuotaSignalInput
} from './quota'
export type {
  ModelDiscoveryResult,
  ProtocolCapabilities,
  ProviderAccountAction,
  ProviderAdapter,
  ProviderCapabilityMatrix,
  ProviderEndpointInput,
  ProviderEndpointOperation,
  ProviderFailure,
  ProviderFailureCategory,
  ProviderFailureInput,
  ProviderHeaderInput,
  ProviderHealthResult,
  ProviderProbeInput,
  ProviderSourceHeaders
} from './types'
