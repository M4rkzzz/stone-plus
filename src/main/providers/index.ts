import type { ProviderKind } from '../../shared/types'
import { anthropicAdapter, anthropicCompatibleAdapter } from './anthropic'
import { customAdapter } from './custom'
import { deepSeekAdapter, deepSeekCompatibleAdapter } from './deepseek'
import { googleAdapter } from './google'
import { kiroClaudeAdapter } from './kiro-claude'
import { openAIAdapter, openAICompatibleAdapter } from './openai'
import type { ProviderAdapter } from './types'
import { xAIAdapter, xAICompatibleAdapter } from './xai'

const adapters: Readonly<Record<ProviderKind, ProviderAdapter>> = Object.freeze({
  anthropic: anthropicAdapter,
  openai: openAIAdapter,
  deepseek: deepSeekAdapter,
  xai: xAIAdapter,
  google: googleAdapter,
  'openai-compatible': openAICompatibleAdapter,
  'deepseek-compatible': deepSeekCompatibleAdapter,
  'xai-compatible': xAICompatibleAdapter,
  'anthropic-compatible': anthropicCompatibleAdapter,
  'kiro-compatible': kiroClaudeAdapter,
  custom: customAdapter
})

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  return adapters[kind] ?? customAdapter
}

export {
  anthropicAdapter,
  anthropicCompatibleAdapter,
  customAdapter,
  deepSeekAdapter,
  deepSeekCompatibleAdapter,
  googleAdapter,
  kiroClaudeAdapter,
  openAIAdapter,
  openAICompatibleAdapter,
  xAIAdapter,
  xAICompatibleAdapter
}
export {
  KIRO_CLAUDE_AMZ_TARGET,
  KIRO_CLAUDE_REQUEST_CONTENT_TYPE,
  KIRO_CLAUDE_RESPONSE_CONTENT_TYPE,
} from './kiro-claude'
export { classifyProviderFailure, MAX_RETRY_AFTER_MS, parseRetryAfter } from './failure'
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
  BUNDLED_CODEX_CLIENT_VERSION,
  CHATGPT_CODEX_MODELS_URL,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_CODEX_RESET_CREDITS_URL,
  CHATGPT_CODEX_RESET_CREDITS_CONSUME_URL,
  CHATGPT_CODEX_SEARCH_URL,
  CHATGPT_CODEX_USAGE_URL,
  CODEX_CLIENT_VERSION,
  CodexClientVersionSyncService,
  checkChatGptAccountAuthorized,
  classifyChatGptCredentialRefreshFailure,
  classifyChatGptCodexFailure,
  probeChatGptAccount,
  probeChatGptAccountAuthorized,
  queryChatGptCodexModels,
  queryChatGptCodexModelsAuthorized,
  getChatGptCodexModelsUrl,
  getCodexClientVersion,
  queryChatGptCodexQuota,
  queryChatGptCodexQuotaAuthorized,
  consumeChatGptCodexResetCredit,
  consumeChatGptCodexResetCreditAuthorized,
  refreshChatGptCredential,
  resolveChatGptCredential,
  sanitizeChatGptCodexInput,
  isChatGptCodexResponsesLiteBody,
  withChatGptCodexBody
} from './chatgpt-codex'
export type { ChatGptCredentialRefreshErrorCode } from './chatgpt-codex'
export type { ChatGptCodexResetCreditResult } from './chatgpt-codex'
export { ChatGptCodexEndpointError, ChatGptCredentialRefreshError } from './chatgpt-codex'
export {
  extractProtocolUsage,
  extractCodexQuotaFromHeaders,
  extractCodexQuotaFromUsagePayload,
  CODEX_QUOTA_STALE_AFTER_MS,
  codexQuotaCooldownUntil,
  codexQuotaIsExhausted,
  extractQuotaSignals,
  extractRateLimitSignals,
  mergeQuotaSignals,
  mergeCodexQuotaSnapshots,
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
