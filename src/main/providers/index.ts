import type { ProviderKind } from '../../shared/types'
import { anthropicAdapter, anthropicCompatibleAdapter } from './anthropic'
import { customAdapter } from './custom'
import { googleAdapter } from './google'
import { openAIAdapter, openAICompatibleAdapter } from './openai'
import type { ProviderAdapter } from './types'
import { xAIAdapter, xAICompatibleAdapter } from './xai'

const adapters: Readonly<Record<ProviderKind, ProviderAdapter>> = Object.freeze({
  anthropic: anthropicAdapter,
  openai: openAIAdapter,
  xai: xAIAdapter,
  google: googleAdapter,
  'openai-compatible': openAICompatibleAdapter,
  'xai-compatible': xAICompatibleAdapter,
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
  openAICompatibleAdapter,
  xAIAdapter,
  xAICompatibleAdapter
}
export { classifyProviderFailure, parseRetryAfter } from './failure'
export {
  applyGrokBuildHeaders,
  GROK_BUILD_BILLING_URL,
  GROK_BUILD_CLIENT_IDENTIFIER,
  GROK_BUILD_CLIENT_VERSION,
  GROK_BUILD_TOKEN_AUTH,
  GROK_BUILD_USER_AGENT,
  GROK_BUILD_USER_URL,
  parseGrokBuildBillingPayload,
  queryGrokBuildQuota
} from './grok-build-quota'
export type {
  GrokBuildClientMode,
  GrokBuildHeaderInput,
  GrokBuildMonthlyQuota,
  GrokBuildOnDemandQuota,
  GrokBuildPaidClassification,
  GrokBuildQuotaPeriod,
  GrokBuildQuotaPlan,
  GrokBuildQuotaQueryOptions,
  GrokBuildQuotaResult,
  GrokBuildQuotaSnapshot,
  GrokBuildQuotaSuccess,
  GrokBuildQuotaUnavailable
} from './grok-build-quota'
export {
  applyChatGptCodexHeaders,
  applyChatGptCodexSearchHeaders,
  applyChatGptAgentIdentityHeaders,
  CHATGPT_CODEX_MODELS_URL,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_CODEX_SEARCH_URL,
  CHATGPT_CODEX_USAGE_URL,
  CODEX_CLIENT_VERSION,
  checkChatGptAccountAuthorized,
  classifyChatGptCodexFailure,
  probeChatGptAccount,
  probeChatGptAccountAuthorized,
  queryChatGptCodexModels,
  queryChatGptCodexModelsAuthorized,
  queryChatGptCodexQuota,
  queryChatGptCodexQuotaAuthorized,
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
