import type {
  AccountInput,
  AccountTagDefinition,
  AccountImportProgress,
  ApiSourceInput,
  ApiSourceProbeInput,
  AppSnapshot,
  AppUpdateState,
  BrowserImportQueueState,
  BrowserJsonCacheState,
  BuiltInProxyRuntimeState,
  ClientConfigBackup,
  ClientConfigEditorState,
  ClientConfigFileRole,
  ClientConfigStatus,
  CodexSessionRepairProgressEvent,
  GatewayApi,
  GatewaySettings,
  FrpTunnelState,
  Pool,
  PoolInput,
  ProxyInput,
  PublicAccount,
  PublicProxyDefinition,
  ProviderDefinition,
  ProviderInput,
  Protocol,
  RequestLog,
  Route,
  RouteClient,
  SetupWizardState,
} from '@shared/types'
import { previewRoute as buildRoutePreview } from '@shared/route-preview'
import { normalizeRouteModelSourceMap, routeReferencesSource } from '@shared/route-models'
import { DEFAULT_ACCOUNT_MAX_CONCURRENCY, supportsFastServiceTier, supportsPoolFastServiceTier } from '@shared/types'
import { accountMatchesPoolProtocol } from '@shared/pool-protocol'
import { normalizeProviderHttpUrl } from '@shared/provider-url'
import {
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_RESPONSES_DEFAULT_MODEL,
  isOfficialDeepSeekResponsesModel,
  normalizeDeepSeekReasoningEffort,
} from '@shared/deepseek'
import { providerSourceFamily } from '@shared/source-family'
import {
  AGENT_CAPABILITIES,
  AGENT_TARGETS,
  type AgentLifecycleAction,
  type AgentLifecycleChangedEvent,
  type AgentLifecycleOperationResult,
  type AgentLifecycleSnapshot,
  type AgentTarget,
} from '@shared/agent-lifecycle'
import { summarizeOpenAiTokenCosts } from '@shared/openai-pricing'
import { hasRouteSourceIdCollision, isAvailableRouteAccount, isNativeGrokRouteSource, resolveRouteSource } from '@shared/route-sources'
import { patchCodexTomlPaths } from '../../main/client-config/toml-format'
import { protocolsByProviderKind } from './grok-relay-ui'
import { buildPoolModelCoverage, pruneModelSelection } from './model-policy'

const STORAGE_KEY = 'stone.browser-mock.v2'
const UI_LANGUAGE_STORAGE_KEY = 'stone.ui.language'
const now = Date.now()

function mockUsesChinese(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const preference = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    if (preference === 'zh-CN') return true
    if (preference === 'en') return false
  } catch {
    // Fall through to the document or browser locale.
  }
  const locale = typeof navigator !== 'undefined'
    ? navigator.language
    : typeof document !== 'undefined'
      ? document.documentElement.lang
      : ''
  return /^zh(?:[-_]|$)/i.test(locale)
}

function mockText(chinese: string, english: string): string {
  return mockUsesChinese() ? chinese : english
}

function localizeKnownMockValue(value: string, chinese: string, english: string): string {
  return value === chinese || value === english ? mockText(chinese, english) : value
}

const accountTags: AccountTagDefinition[] = [
  { id: 'tag-k12', name: 'K12', createdAt: now, updatedAt: now },
  { id: 'tag-plus', name: 'Plus', createdAt: now, updatedAt: now },
]

const proxies: PublicProxyDefinition[] = [
  {
    id: 'proxy-local-socks',
    name: '本地 SOCKS5',
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 7890,
    hasPassword: false,
    status: 'available',
    exitIp: '203.0.113.24',
    latencyMs: 186,
    lastCheckedAt: now - 4 * 60 * 1000,
    createdAt: now - 12 * 24 * 60 * 60 * 1000,
    updatedAt: now - 4 * 60 * 1000,
  },
]

const providers: ProviderDefinition[] = [
  {
    id: 'provider-anthropic',
    name: 'Anthropic',
    sourceType: 'official-api',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    models: ['claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet-latest'],
    color: '#d97757',
    createdAt: now - 1000 * 60 * 60 * 24 * 18,
    updatedAt: now - 1000 * 60 * 60 * 24 * 2,
  },
  {
    id: 'provider-openai',
    name: 'OpenAI Platform',
    sourceType: 'official-api',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    models: ['gpt-5', 'gpt-5-mini', 'o3'],
    color: '#111827',
    createdAt: now - 1000 * 60 * 60 * 24 * 14,
    updatedAt: now - 1000 * 60 * 60 * 8,
  },
  {
    id: 'provider-openrouter',
    name: 'OpenRouter',
    sourceType: 'relay',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-chat',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
    color: '#5b63d3',
    createdAt: now - 1000 * 60 * 60 * 24 * 9,
    updatedAt: now - 1000 * 60 * 34,
  },
  {
    id: 'provider-grok-oauth',
    name: 'Grok OAuth',
    sourceType: 'oauth-system',
    kind: 'xai',
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    protocol: 'openai-responses',
    models: ['grok-4.5'],
    color: '#111111',
    createdAt: now - 1000 * 60 * 60 * 24 * 4,
    updatedAt: now - 1000 * 60 * 12,
  },
  {
    id: 'provider-google',
    name: 'Google AI Studio',
    sourceType: 'official-api',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    color: '#4285f4',
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 60 * 3,
  },
]

const accounts: PublicAccount[] = [
  {
    id: 'account-anthropic-main',
    providerId: 'provider-anthropic',
    name: 'Claude 主账号',
    maskedCredential: 'sk-ant-••••••••5Q2K',
    status: 'active',
    priority: 10,
    weight: 8,
    maxConcurrency: 4,
    inFlight: 1,
    availableModels: ['claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet-latest'],
    modelsRefreshedAt: now - 2 * 60 * 60 * 1000,
    modelPolicy: 'all',
    modelAllowlist: [],
    quotaRemaining: 72,
    quotaUnit: 'percent',
    latencyMs: 842,
    lastUsedAt: now - 1000 * 42,
    createdAt: now - 1000 * 60 * 60 * 24 * 18,
    updatedAt: now - 1000 * 42,
  },
  {
    id: 'account-anthropic-backup',
    providerId: 'provider-anthropic',
    name: 'Claude 备用',
    maskedCredential: 'sk-ant-••••••••9AVP',
    status: 'cooldown',
    priority: 20,
    weight: 4,
    maxConcurrency: 2,
    inFlight: 0,
    availableModels: ['claude-sonnet-4'],
    modelsRefreshedAt: now - 3 * 60 * 60 * 1000,
    modelPolicy: 'selected',
    modelAllowlist: ['claude-sonnet-4'],
    quotaRemaining: 38,
    quotaUnit: 'percent',
    cooldownUntil: now + 1000 * 60 * 6,
    cooldownReason: 'quota',
    latencyMs: 1214,
    lastUsedAt: now - 1000 * 60 * 3,
    lastError: '上游返回 429，等待额度窗口恢复',
    createdAt: now - 1000 * 60 * 60 * 24 * 7,
    updatedAt: now - 1000 * 60 * 3,
  },
  {
    id: 'account-openai-main',
    providerId: 'provider-openai',
    name: 'OpenAI 主账号',
    maskedCredential: 'chatgpt-****DK8M',
    credentialType: 'chatgpt-oauth',
    renewable: true,
    status: 'active',
    priority: 10,
    weight: 10,
    maxConcurrency: 6,
    inFlight: 2,
    availableModels: ['gpt-5.5'],
    modelsRefreshedAt: now - 8 * 60 * 1000,
    modelPolicy: 'all',
    modelAllowlist: [],
    proxyId: 'proxy-local-socks',
    codexQuota: {
      fiveHour: { usedPercent: 42, windowSeconds: 18_000, resetAt: now + 2 * 60 * 60 * 1000 },
      sevenDay: { usedPercent: 68, windowSeconds: 604_800, resetAt: now + 3 * 24 * 60 * 60 * 1000 },
      observedAt: now - 4 * 60 * 1000,
      source: 'usage-endpoint',
      allowed: true,
      limitReached: false,
    },
    fitness: {
      score: 91,
      sampleCount: 18,
      successCount: 17,
      failureCount: 1,
      successRate: 91.6,
      recentSuccessRate: 96.4,
      confidence: 77.7,
      firstTokenMs: 654,
      outputTokensPerSecond: 72.4,
      failurePenalty: 0,
      components: { reliability: 94, responsiveness: 81, throughput: 80, stability: 100 },
      updatedAt: now - 1000 * 9,
      stale: false,
      dynamicConcurrency: 6,
    },
    quotaRemaining: 46.2,
    quotaUnit: 'usd',
    latencyMs: 654,
    lastUsedAt: now - 1000 * 9,
    createdAt: now - 1000 * 60 * 60 * 24 * 14,
    updatedAt: now - 1000 * 9,
  },
  {
    id: 'account-openai-backup',
    providerId: 'provider-openai',
    name: 'OpenAI 扩展账号',
    maskedCredential: 'chatgpt-****M5NI',
    credentialType: 'chatgpt-oauth',
    renewable: true,
    status: 'active',
    priority: 20,
    weight: 6,
    maxConcurrency: 4,
    inFlight: 0,
    availableModels: ['gpt-5.5', 'gpt-5.5-mini'],
    modelsRefreshedAt: now - 5 * 60 * 1000,
    modelPolicy: 'all',
    modelAllowlist: [],
    codexQuota: {
      fiveHour: { usedPercent: 18, windowSeconds: 18_000, resetAt: now + 3 * 60 * 60 * 1000 },
      sevenDay: { usedPercent: 31, windowSeconds: 604_800, resetAt: now + 5 * 24 * 60 * 60 * 1000 },
      observedAt: now - 5 * 60 * 1000,
      source: 'usage-endpoint',
      allowed: true,
      limitReached: false,
    },
    fitness: {
      score: 82,
      sampleCount: 12,
      successCount: 10,
      failureCount: 2,
      successRate: 81.8,
      recentSuccessRate: 84.7,
      confidence: 63.2,
      firstTokenMs: 812,
      outputTokensPerSecond: 58.7,
      failurePenalty: 0.4,
      components: { reliability: 83, responsiveness: 74, throughput: 73, stability: 96 },
      updatedAt: now - 1000 * 60 * 2,
      stale: false,
      dynamicConcurrency: 4,
    },
    latencyMs: 712,
    lastUsedAt: now - 1000 * 60 * 2,
    createdAt: now - 1000 * 60 * 60 * 24 * 8,
    updatedAt: now - 1000 * 60 * 2,
  },
  {
    id: 'account-openrouter',
    providerId: 'provider-openrouter',
    name: 'OpenRouter 日常',
    maskedCredential: 'sk-or-v1-••••••••7N4C',
    status: 'active',
    priority: 30,
    weight: 3,
    maxConcurrency: 8,
    inFlight: 0,
    availableModels: ['anthropic/claude-sonnet-4', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
    modelsRefreshedAt: now - 34 * 60 * 1000,
    modelPolicy: 'all',
    modelAllowlist: [],
    quotaRemaining: 18.65,
    quotaUnit: 'usd',
    latencyMs: 932,
    lastUsedAt: now - 1000 * 60 * 12,
    createdAt: now - 1000 * 60 * 60 * 24 * 9,
    updatedAt: now - 1000 * 60 * 12,
  },
  {
    id: 'account-grok-oauth',
    providerId: 'provider-grok-oauth',
    name: 'Grok Build 主账号',
    maskedCredential: 'grok-****oauth',
    credentialType: 'grok-oauth',
    renewable: true,
    status: 'active',
    priority: 1,
    weight: 10,
    maxConcurrency: 1,
    inFlight: 0,
    availableModels: ['grok-4.5'],
    modelsRefreshedAt: now - 12 * 60 * 1000,
    modelPolicy: 'selected',
    modelAllowlist: ['grok-4.5'],
    latencyMs: 688,
    lastUsedAt: now - 1000 * 60 * 8,
    createdAt: now - 1000 * 60 * 60 * 24 * 4,
    updatedAt: now - 1000 * 60 * 8,
  },
  {
    id: 'account-google',
    providerId: 'provider-google',
    name: 'Gemini 开发',
    maskedCredential: 'AIza••••••••p3rA',
    status: 'active',
    priority: 10,
    weight: 10,
    maxConcurrency: 5,
    inFlight: 0,
    availableModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    modelsRefreshedAt: now - 3 * 60 * 60 * 1000,
    modelPolicy: 'all',
    modelAllowlist: [],
    quotaRemaining: 890,
    quotaUnit: 'requests',
    latencyMs: 508,
    lastUsedAt: now - 1000 * 60 * 4,
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 4,
  },
]

const pools: Pool[] = [
  {
    id: 'pool-claude',
    name: 'Claude 稳定池',
    kind: 'standard',
    protocol: 'anthropic-messages',
    strategy: 'priority',
    members: [
      { accountId: 'account-anthropic-main', enabled: true },
      { accountId: 'account-anthropic-backup', enabled: true },
    ],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 2,
    createdAt: now - 1000 * 60 * 60 * 24 * 7,
    updatedAt: now - 1000 * 60 * 18,
  },
  {
    id: 'pool-codex',
    name: 'Codex 主线路',
    kind: 'standard',
    protocol: 'openai-responses',
    strategy: 'balanced',
    members: [
      { accountId: 'account-openai-main', enabled: true },
      { accountId: 'account-openai-backup', enabled: true },
    ],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: false,
    stickyTtlMinutes: 15,
    maxRetries: 1,
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 26,
  },
  {
    id: 'pool-gemini',
    name: 'Gemini 默认池',
    kind: 'standard',
    protocol: 'gemini',
    strategy: 'round-robin',
    members: [{ accountId: 'account-google', enabled: true }],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 20,
    maxRetries: 2,
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 60,
  },
  {
    id: 'pool-grok',
    name: 'Grok Build 专用池',
    kind: 'standard',
    protocol: 'grok',
    strategy: 'balanced',
    members: [{ accountId: 'account-grok-oauth', enabled: true }],
    modelPolicy: 'selected',
    modelAllowlist: ['grok-4.5'],
    stickySessions: true,
    stickyTtlMinutes: 30,
    maxRetries: 1,
    createdAt: now - 1000 * 60 * 60 * 24 * 4,
    updatedAt: now - 1000 * 60 * 12,
  },
]

const routes: Route[] = [
  {
    id: 'route-claude',
    client: 'claude',
    enabled: true,
    highConcurrencyMode: false,
    poolId: 'pool-claude',
    inboundProtocol: 'anthropic-messages',
    modelMap: { 'claude-sonnet-4-20250514': 'claude-sonnet-4' },
    localToken: 'stone_claude_dev_7d9f3a',
    createdAt: now - 1000 * 60 * 60 * 24 * 7,
    updatedAt: now - 1000 * 60 * 18,
  },
  {
    id: 'route-codex',
    client: 'codex',
    enabled: true,
    highConcurrencyMode: false,
    poolId: 'pool-codex',
    inboundProtocol: 'openai-responses',
    modelMap: { 'gpt-5-codex': 'gpt-5', 'gpt-5-mini': 'gpt-5-mini' },
    localToken: 'stone_codex_dev_3b21e8',
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 26,
  },
  {
    id: 'route-grokbuild',
    client: 'grokbuild',
    enabled: true,
    highConcurrencyMode: false,
    poolId: 'pool-grok',
    inboundProtocol: 'openai-responses',
    modelMap: {},
    localToken: 'stone_grokbuild_dev_46a7c2',
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 52,
  },
  {
    id: 'route-gemini',
    client: 'gemini',
    enabled: false,
    highConcurrencyMode: false,
    poolId: 'pool-gemini',
    inboundProtocol: 'gemini',
    modelMap: {},
    localToken: 'stone_gemini_dev_91c47f',
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 60,
  },
]

const logs: RequestLog[] = [
  ['req-01', 22, 'codex', 'openai-responses', 'OpenAI Platform', 'OpenAI 主账号', 'gpt-5.6-sol', 'streaming', 200, 1280, 4812, 0],
  ['req-02', 68, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 主账号', 'claude-sonnet-4', 'success', 200, 2384, 9204, 1837],
  ['req-03', 194, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 备用', 'claude-sonnet-4', 'error', 429, 312, 1240, 0],
  ['req-04', 285, 'gemini', 'gemini', 'Google AI Studio', 'Gemini 开发', 'gemini-2.5-pro', 'success', 200, 1748, 6240, 2210],
  ['req-05', 460, 'codex', 'openai-responses', 'OpenRouter', 'OpenRouter 日常', 'openai/gpt-5-mini', 'success', 200, 936, 3174, 894],
  ['req-06', 725, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 主账号', 'claude-opus-4-1', 'success', 200, 4421, 12140, 3352],
  ['req-07', 1160, 'codex', 'openai-responses', 'OpenAI Platform', 'OpenAI 主账号', 'gpt-5.6-sol', 'success', 200, 2156, 8051, 1620],
  ['req-08', 1680, 'gemini', 'gemini', 'Google AI Studio', 'Gemini 开发', 'gemini-2.5-flash', 'success', 200, 604, 1430, 730],
  ['req-09', 2240, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 主账号', 'claude-sonnet-4', 'error', 502, 30004, 6740, 0],
  ['req-10', 3620, 'codex', 'openai-responses', 'OpenRouter', 'OpenRouter 日常', 'anthropic/claude-sonnet-4', 'success', 200, 1602, 5230, 1480],
].map((entry) => {
  const [id, secondsAgo, client, protocol, providerName, accountName, model, status, statusCode, latencyMs, inputTokens, outputTokens] = entry as [
    string,
    number,
    RequestLog['client'],
    RequestLog['protocol'],
    string,
    string,
    string,
    RequestLog['status'],
    number,
    number,
    number,
    number,
  ]
  return {
    id,
    conversationId: `thread-${id}`,
    conversationName: client === 'codex' ? `Stone+ 开发对话 ${id.slice(-2)}` : `${clientNamesForMock(client)} 会话 ${id.slice(-2)}`,
    timestamp: now - secondsAgo * 1000,
    client,
    protocol,
    providerName,
    accountName,
    model,
    status,
    statusCode,
    latencyMs,
    firstTokenMs: status === 'error' ? undefined : Math.max(80, Math.round(latencyMs * 0.32)),
    inputTokens,
    cachedInputTokens: model === 'gpt-5.6-sol' ? Math.round(inputTokens * 0.75) : undefined,
    outputTokens,
    error: status === 'error' ? (statusCode === 429 ? '上游请求频率受限' : '上游连接超时') : undefined,
  }
})

function clientNamesForMock(client: RequestLog['client']): string {
  if (client === 'claude') return 'Claude'
  if (client === 'gemini') return 'Gemini'
  if (client === 'grokbuild') return 'Grok Build'
  return 'Codex'
}

const initialSnapshot: AppSnapshot = {
  providers,
  accounts,
  accountTags,
  proxies,
  pools,
  routes,
  gateway: {
    host: '127.0.0.1',
    port: 15721,
    autoStart: true,
    logPayloads: false,
    requestTimeoutSeconds: 120,
    launchAtLogin: false,
    desktopNotifications: true,
    automaticBackups: true,
    backupRetention: 10,
  },
  gatewayStatus: {
    running: true,
    host: '127.0.0.1',
    port: 15721,
    startedAt: now - 1000 * 60 * 43,
    activeRequests: 3,
    totalRequests: 1284,
    successRequests: 1261,
  },
  requestLogs: logs,
  clientProfiles: (['claude', 'codex', 'gemini', 'grokbuild'] as const).map((client) => ({
    id: `default-${client}`,
    name: '默认配置',
    client,
    backupRetention: 10,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  })),
  healthEvents: [],
  observability: {
    last24Hours: summarizeLogs(logs, now - 24 * 60 * 60 * 1000, now),
    last7Days: summarizeLogs(logs, now - 7 * 24 * 60 * 60 * 1000, now),
    hourly: [],
    tokenRates: {
      last30Minutes: summarizeTokenRate(logs, now, 30 * 60 * 1000, 30),
      last4Hours: summarizeTokenRate(logs, now, 4 * 60 * 60 * 1000, 48),
      last24Hours: summarizeTokenRate(logs, now, 24 * 60 * 60 * 1000, 48),
      last7Days: summarizeTokenRate(logs, now, 7 * 24 * 60 * 60 * 1000, 56),
    },
    tokenCosts: summarizeOpenAiTokenCosts(logs, now),
  },
  vaultAvailable: true,
  vaultBackend: '系统凭据保险库',
}

function summarizeLogs(logs: RequestLog[], windowStart: number, windowEnd: number) {
  const selected = logs.filter((log) => log.timestamp >= windowStart && log.timestamp <= windowEnd)
  const successCount = selected.filter((log) => log.status === 'success').length
  const errorCount = selected.filter((log) => log.status === 'error').length
  const errorsByStatus: Record<string, number> = {}
  for (const log of selected) {
    if (log.status !== 'error') continue
    const key = String(log.statusCode ?? 'unknown')
    errorsByStatus[key] = (errorsByStatus[key] ?? 0) + 1
  }
  return {
    windowStart,
    windowEnd,
    requestCount: selected.length,
    successCount,
    errorCount,
    successRate: selected.length ? successCount / selected.length : 0,
    averageLatencyMs: selected.length
      ? Math.round(selected.reduce((total, log) => total + log.latencyMs, 0) / selected.length)
      : 0,
    inputTokens: selected.reduce((total, log) => total + (log.inputTokens ?? 0), 0),
    outputTokens: selected.reduce((total, log) => total + (log.outputTokens ?? 0), 0),
    cachedInputTokens: selected.reduce((total, log) => total + (log.cachedInputTokens ?? 0), 0),
    reasoningTokens: selected.reduce((total, log) => total + (log.reasoningTokens ?? 0), 0),
    failoverCount: selected.reduce((total, log) => total + (log.failoverCount ?? 0), 0),
    errorsByStatus,
  }
}

function summarizeTokenRate(logs: RequestLog[], windowEnd: number, windowMs: number, bucketCount: number) {
  const windowStart = windowEnd - windowMs
  const bucketMs = windowMs / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    timestamp: windowStart + index * bucketMs,
    requestCount: 0,
    outputTokens: 0,
    rateTotal: 0,
  }))
  for (const log of logs) {
    if (log.status !== 'success' || log.timestamp < windowStart || log.timestamp > windowEnd) continue
    if (!log.outputTokens || log.outputTokens <= 0 || log.latencyMs <= 0) continue
    const generationStartedMs = log.upstreamFirstByteMs
      ?? log.clientFirstWriteMs
      ?? log.firstTokenMs
      ?? 0
    const generationDurationMs = log.latencyMs - generationStartedMs
    if (generationDurationMs <= 0) continue
    const index = Math.min(bucketCount - 1, Math.floor((log.timestamp - windowStart) / bucketMs))
    buckets[index].requestCount += 1
    buckets[index].outputTokens += log.outputTokens
    buckets[index].rateTotal += log.outputTokens * 1000 / generationDurationMs
  }
  return buckets.map(({ rateTotal, ...bucket }) => ({
    ...bucket,
    tokensPerSecond: bucket.requestCount ? Math.round(rateTotal / bucket.requestCount * 10) / 10 : 0,
  }))
}

const clone = <T,>(value: T): T => structuredClone(value)

const mockAccountNames: Record<string, readonly [string, string]> = {
  'account-anthropic-main': ['Claude 主账号', 'Claude Primary'],
  'account-anthropic-backup': ['Claude 备用', 'Claude Backup'],
  'account-openai-main': ['OpenAI 主账号', 'OpenAI Primary'],
  'account-openai-backup': ['OpenAI 扩展账号', 'OpenAI Additional'],
  'account-openrouter': ['OpenRouter 日常', 'OpenRouter Daily'],
  'account-grok-oauth': ['Grok Build 主账号', 'Grok Build Primary'],
  'account-google': ['Gemini 开发', 'Gemini Development'],
}

const mockPoolNames: Record<string, readonly [string, string]> = {
  'pool-claude': ['Claude 稳定池', 'Claude Stable Pool'],
  'pool-codex': ['Codex 主线路', 'Codex Primary Route'],
  'pool-gemini': ['Gemini 默认池', 'Gemini Default Pool'],
  'pool-grok': ['Grok Build 专用池', 'Grok Build Dedicated Pool'],
}

function localizeMockConversationName(value: string | undefined): string | undefined {
  if (!value) return value
  const codex = value.match(/^(?:Stone\+? 开发对话|Stone\+? development chat) (.+)$/)
  if (codex) return `${mockText('Stone+ 开发对话', 'Stone+ development chat')} ${codex[1]}`
  const session = value.match(/^(Claude|Codex|Gemini) (?:会话|session) (.+)$/)
  if (session) return `${session[1]} ${mockText('会话', 'session')} ${session[2]}`
  return value
}

function localizeMockSnapshot(value: AppSnapshot): AppSnapshot {
  const translated = clone(value)
  translated.proxies = translated.proxies.map((proxy) => proxy.id === 'proxy-local-socks'
    ? { ...proxy, name: localizeKnownMockValue(proxy.name, '本地 SOCKS5', 'Local SOCKS5') }
    : proxy)
  translated.accounts = translated.accounts.map((account) => {
    const names = mockAccountNames[account.id]
    return {
      ...account,
      ...(names ? { name: localizeKnownMockValue(account.name, names[0], names[1]) } : {}),
      lastError: account.lastError
        ? localizeKnownMockValue(
          account.lastError,
          '上游返回 429，等待额度窗口恢复',
          'Upstream returned 429; waiting for the quota window to recover',
        )
        : undefined,
    }
  })
  translated.pools = translated.pools.map((pool) => {
    const names = mockPoolNames[pool.id]
    return names ? { ...pool, name: localizeKnownMockValue(pool.name, names[0], names[1]) } : pool
  })
  translated.requestLogs = translated.requestLogs.map((log) => {
    let accountName = log.accountName
    for (const names of Object.values(mockAccountNames)) {
      accountName = localizeKnownMockValue(accountName, names[0], names[1])
    }
    return {
      ...log,
      accountName,
      conversationName: localizeMockConversationName(log.conversationName),
      error: log.error
        ? localizeKnownMockValue(
          localizeKnownMockValue(log.error, '上游请求频率受限', 'Upstream rate limit exceeded'),
          '上游连接超时',
          'Upstream connection timed out',
        )
        : undefined,
    }
  })
  translated.clientProfiles = translated.clientProfiles.map((profile) => profile.id.startsWith('default-')
    ? { ...profile, name: localizeKnownMockValue(profile.name, '默认配置', 'Default Profile') }
    : profile)
  translated.vaultBackend = localizeKnownMockValue(
    translated.vaultBackend,
    '系统凭据保险库',
    'System credential vault',
  )
  return translated
}

function localizeMockImportProgress(message: string): string {
  if (mockUsesChinese() || !/[\u3400-\u9fff]/u.test(message)) return message
  const replacements: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
    [/^正在解析并导入账号…?$/, 'Parsing and importing accounts…'],
    [/^已导入\s*(\d+)\s*个账号$/, (match) => `Imported ${match[1]} account(s)`],
    [/^正在刷新状态与查询模型\s*(\d+)\/(\d+)$/, (match) => `Refreshing status and models ${match[1]}/${match[2]}`],
    [/^正在整理 Tag 与号池成员…?$/, 'Organizing Tags and pool members…'],
    [/^导入、状态刷新与模型查询已完成$/, 'Import, status refresh, and model lookup complete'],
    [/^正在导入文件\s*(\d+)\/(\d+)$/, (match) => `Importing files ${match[1]}/${match[2]}`],
  ]
  for (const [pattern, replacement] of replacements) {
    const match = message.match(pattern)
    if (match) return typeof replacement === 'string' ? replacement : replacement(match)
  }
  return 'Processing account import…'
}

const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
const pause = (duration = 140) => new Promise((resolve) => window.setTimeout(resolve, duration))

const defaultMockSourceModels = (kind: ProviderDefinition['kind'], protocol: Protocol): string[] => {
  if (protocol === 'kiro-claude') return []
  if (protocol === 'anthropic-messages') {
    return ['claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet-latest']
  }
  if (protocol === 'gemini') return ['gemini-2.5-pro', 'gemini-2.5-flash']
  if (kind === 'xai' || kind === 'xai-compatible') return ['grok-4.5']
  if (kind === 'deepseek' || kind === 'deepseek-compatible') return ['deepseek-v4-flash']
  return ['gpt-5', 'gpt-5-mini', 'o3']
}

function mockSourceRequiresToolRoundtrip(source: Pick<ApiSourceProbeInput, 'sourceType' | 'kind' | 'protocol'>): boolean {
  return source.protocol === 'kiro-claude'
    || (source.sourceType === 'relay'
      && source.kind === 'anthropic-compatible'
      && source.protocol === 'anthropic-messages')
}

const mockOfficialSources: Readonly<Partial<Record<ProviderDefinition['kind'], {
  baseUrl: string
  protocols: readonly Protocol[]
}>>> = Object.freeze({
  openai: { baseUrl: 'https://api.openai.com/v1', protocols: ['openai-responses', 'openai-chat'] },
  deepseek: { baseUrl: 'https://api.deepseek.com', protocols: ['openai-responses'] },
  xai: { baseUrl: 'https://api.x.ai/v1', protocols: ['openai-responses'] },
  anthropic: { baseUrl: 'https://api.anthropic.com', protocols: ['anthropic-messages'] },
  google: { baseUrl: 'https://generativelanguage.googleapis.com', protocols: ['gemini'] },
})

function mockMaskCredential(credential: string): string {
  return credential.length <= 4 ? '****' : `****${credential.slice(-4)}`
}

function normalizeMockSourceUrl(value: string, exact: boolean): string {
  try {
    return normalizeProviderHttpUrl(value, exact)
  } catch {
    throw new Error(mockText('请输入有效的 HTTP(S) 来源地址；裸 IP 可省略 http://', 'Enter a valid HTTP(S) source URL; a bare IP may omit http://'))
  }
}

function normalizeMockApiSourceInput(input: ApiSourceInput): ApiSourceInput & { baseUrl: string; models: string[] } {
  const name = input.name.trim()
  if (!name) throw new Error(mockText('请输入来源名称', 'Enter a source name'))
  const official = input.sourceType === 'official-api' ? mockOfficialSources[input.kind] : undefined
  if (input.sourceType === 'official-api' && !official) {
    throw new Error(mockText('官方 API 类型无效', 'The official API type is invalid'))
  }
  if (official && !official.protocols.includes(input.protocol)) {
    throw new Error(mockText('官方 API 协议不匹配', 'The official API protocol is incompatible'))
  }
  if (input.sourceType === 'relay' && !protocolsByProviderKind[input.kind]?.includes(input.protocol)) {
    throw new Error(mockText('中转类型与协议不匹配', 'The relay type and protocol are incompatible'))
  }
  const normalizedModels = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))]
  const defaultModel = input.defaultModel?.trim()
  if (input.kind === 'deepseek'
    && (normalizedModels.some((model) => !isOfficialDeepSeekResponsesModel(model))
      || (defaultModel !== undefined && !isOfficialDeepSeekResponsesModel(defaultModel)))) {
    throw new Error(mockText(
      `DeepSeek 官方 Responses 当前仅支持 ${DEEPSEEK_RESPONSES_DEFAULT_MODEL}`,
      `Official DeepSeek Responses currently supports only ${DEEPSEEK_RESPONSES_DEFAULT_MODEL}`,
    ))
  }
  if (defaultModel && !normalizedModels.includes(defaultModel)) normalizedModels.unshift(defaultModel)
  else if (defaultModel) {
    normalizedModels.splice(normalizedModels.indexOf(defaultModel), 1)
    normalizedModels.unshift(defaultModel)
  }
  if (input.protocol === 'kiro-claude' && (!defaultModel || normalizedModels.length === 0)) {
    throw new Error(mockText('Kiro Claude 需要手动填写模型和默认测试模型', 'Kiro Claude requires a manually entered model and default test model'))
  }
  for (const [label, value] of [['优先级', input.priority], ['权重', input.weight], ['最大并发', input.maxConcurrency]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(mockText(`${label}必须是正整数`, `${label} must be a positive integer`))
  }
  return {
    ...input,
    name,
    baseUrl: official?.baseUrl ?? normalizeMockSourceUrl(input.baseUrl, input.protocol === 'kiro-claude'),
    credential: input.credential?.trim() || undefined,
    models: normalizedModels,
    defaultModel,
    responsesCompactMode: input.kind === 'deepseek' || input.kind === 'deepseek-compatible'
      ? undefined
      : input.responsesCompactMode,
    deepSeekReasoningEffort: providerSourceFamily(input.kind) === 'deepseek'
      ? normalizeDeepSeekReasoningEffort(input.deepSeekReasoningEffort, DEEPSEEK_DEFAULT_REASONING_EFFORT)
      : undefined,
    proxyId: input.proxyId?.trim() || undefined,
  }
}

function mockProbeEvidenceFingerprint(input: Pick<ApiSourceProbeInput, 'sourceType' | 'kind' | 'baseUrl' | 'protocol' | 'model'>): string {
  const officialBaseUrl = input.sourceType === 'official-api' ? mockOfficialSources[input.kind]?.baseUrl : undefined
  return JSON.stringify({
    sourceType: input.sourceType,
    kind: input.kind,
    baseUrl: officialBaseUrl ?? normalizeMockSourceUrl(input.baseUrl, input.protocol === 'kiro-claude'),
    protocol: input.protocol,
    model: input.model?.trim() || '',
  })
}

function mockSessionRepairCancelled(): Error {
  const error = new Error('Session repair cancelled.')
  error.name = 'AbortError'
  return error
}

const mockClientFiles: Record<RouteClient, Array<{ role: ClientConfigFileRole; path: string; containsCredential: boolean }>> = {
  claude: [
    { role: 'claude-settings', path: '~/.claude/settings.json', containsCredential: true },
    { role: 'claude-mcp', path: '~/.claude.json', containsCredential: true },
  ],
  codex: [
    { role: 'codex-config', path: '~/.codex/config.toml', containsCredential: true },
    { role: 'codex-auth', path: '~/.codex/auth.json', containsCredential: true },
    { role: 'codex-model-catalog', path: '~/.codex/stone-deepseek-model-catalog.json', containsCredential: false },
    { role: 'codex-agents', path: '~/.codex/AGENTS.md', containsCredential: false },
    { role: 'codex-rules', path: '~/.codex/rules/default.rules', containsCredential: false },
  ],
  gemini: [
    { role: 'gemini-settings', path: '~/.gemini/settings.json', containsCredential: false },
    { role: 'gemini-env', path: '~/.gemini/.env', containsCredential: true },
  ],
  grokbuild: [
    { role: 'grok-config', path: '~/.grok/config.toml', containsCredential: true },
  ],
}

const mockEditorContent: Record<RouteClient, Partial<Record<ClientConfigFileRole, string>>> = {
  claude: {
    'claude-settings': '{\n  "model": "claude-sonnet-4-5",\n  "effortLevel": "high",\n  "permissions": {\n    "defaultMode": "default",\n    "allow": ["Read", "Grep"]\n  },\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "stone-demo-claude-token"\n  }\n}\n',
    'claude-mcp': '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem"]\n    }\n  }\n}\n',
  },
  codex: {
    'codex-config': 'model_provider = "stone"\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\nmodel_reasoning_summary = "auto"\nmodel_verbosity = "medium"\npersonality = "pragmatic"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nweb_search = "cached"\ncli_auth_credentials_store = "file"\n\n[features]\nfast_mode = true\nmulti_agent = true\n\n[agents]\nmax_threads = 6\n\n[windows]\nsandbox = "elevated"\n\n[model_providers.stone]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:15720/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n',
    'codex-auth': '{\n  "OPENAI_API_KEY": "stone-demo-codex-token"\n}\n',
    'codex-model-catalog': '{\n  "models": []\n}\n',
    'codex-agents': '# Personal Codex instructions\n\nKeep changes focused and run relevant tests.\n',
    'codex-rules': 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n',
  },
  gemini: { 'gemini-settings': '{\n  "model": { "name": "gemini-2.5-pro" },\n  "general": { "defaultApprovalMode": "default" },\n  "ui": { "theme": "Default" }\n}\n', 'gemini-env': 'GEMINI_API_KEY="stone-demo-gemini-token"\nGOOGLE_GEMINI_BASE_URL="http://127.0.0.1:15720"\n' },
  grokbuild: {
    'grok-config': '[auth]\npreferred_method = "api_key"\n\n[models]\ndefault = "stoneplus"\n\n[model.stoneplus]\nmodel = "grok-4.5"\nbase_url = "http://127.0.0.1:15721/grokbuild/v1"\nname = "Stone+"\napi_key = "stone-demo-grok-token"\napi_backend = "responses"\ncontext_window = 500000\n',
  },
}

const mockEditorFields: Record<RouteClient, ClientConfigEditorState['fields']> = {
  claude: [
    { id: 'claude.model', role: 'claude-settings', path: ['model'], section: '模型', label: '默认模型', description: 'Claude Code 新会话默认使用的模型。', control: 'text', value: 'claude-sonnet-4-5', defaultValue: null },
    { id: 'claude.effort', role: 'claude-settings', path: ['effortLevel'], section: '模型', label: '推理强度', description: '控制速度与思考深度之间的取舍。', control: 'select', value: 'high', recommendedValue: 'medium', options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中', recommended: true }, { value: 'high', label: '高' }, { value: 'xhigh', label: '最高' }] },
    { id: 'claude.permissionMode', role: 'claude-settings', path: ['permissions', 'defaultMode'], section: '权限', label: '默认权限模式', description: '决定 Claude Code 在执行工具前如何确认。', control: 'select', value: 'default', recommendedValue: 'default', options: [{ value: 'default', label: '默认', recommended: true }, { value: 'acceptEdits', label: '自动接受编辑' }, { value: 'plan', label: '计划模式' }] },
    { id: 'claude.permissionsAllow', role: 'claude-settings', path: ['permissions', 'allow'], section: '权限', label: '允许规则', description: '无需确认即可执行的工具规则，每行一项。', control: 'string-list', value: ['Read', 'Grep'], advanced: true },
  ],
  codex: [
    { id: 'codex.model', role: 'codex-config', path: ['model'], section: '模型', label: '默认模型', description: 'Codex 启动新会话时使用的模型。', control: 'text', value: 'gpt-5.6-sol', defaultValue: null },
    { id: 'codex.reasoningEffort', role: 'codex-config', path: ['model_reasoning_effort'], section: '推理与输出', label: '推理强度', description: '控制速度、用量与思考深度之间的取舍。', control: 'select', value: 'medium', recommendedValue: 'medium', options: [{ value: 'minimal', label: '最小' }, { value: 'low', label: '低' }, { value: 'medium', label: '中', recommended: true }, { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }] },
    { id: 'codex.approvalPolicy', role: 'codex-config', path: ['approval_policy'], section: '权限与沙箱', label: '审批策略', description: '决定 Codex 在敏感操作前何时请求确认。', control: 'select', value: 'on-request', recommendedValue: 'on-request', options: [{ value: 'untrusted', label: '仅可信命令免确认' }, { value: 'on-request', label: '按需确认', recommended: true }, { value: 'never', label: '从不确认' }] },
    { id: 'codex.sandboxMode', role: 'codex-config', path: ['sandbox_mode'], section: '权限与沙箱', label: '沙箱模式', description: '限制工具可读取、写入和访问网络的范围。', control: 'select', value: 'workspace-write', recommendedValue: 'workspace-write', options: [{ value: 'read-only', label: '只读' }, { value: 'workspace-write', label: '工作区可写', recommended: true }, { value: 'danger-full-access', label: '完全访问' }] },
    { id: 'codex.webSearch', role: 'codex-config', path: ['web_search'], section: '工具与联网', label: '网页搜索', description: '控制网页搜索使用缓存索引还是实时网络。', control: 'select', value: 'cached', recommendedValue: 'cached', options: [{ value: 'disabled', label: '关闭' }, { value: 'cached', label: '缓存索引', recommended: true }, { value: 'indexed', label: '受控联网' }, { value: 'live', label: '实时联网' }] },
    { id: 'codex.feature.multi_agent', role: 'codex-config', path: ['features', 'multi_agent'], section: '功能开关', label: '多代理协作', description: '启用子代理协作工具。', control: 'toggle', value: true, recommendedValue: true, advanced: true },
    { id: 'codex.agentsMaxThreads', role: 'codex-config', path: ['agents', 'max_threads'], section: '多代理', label: '子代理上限', description: '同时运行的子代理数量上限，不包含主任务；提高上限会增加并行能力和资源占用。', control: 'number', value: 6, min: 1, max: 64, step: 1, defaultValue: null, recommendedValue: 6 },
    { id: 'codex.windowsSandbox', role: 'codex-config', path: ['windows', 'sandbox'], section: '权限与沙箱', label: 'Windows 原生沙箱', description: '选择原生 Windows 沙箱实现。', control: 'select', value: 'elevated', recommendedValue: 'elevated', advanced: true, options: [{ value: 'elevated', label: '增强隔离', recommended: true }, { value: 'unelevated', label: '普通隔离' }] },
    { id: 'codex.discovered.model_providers/stone/base_url', role: 'codex-config', path: ['model_providers', 'stone', 'base_url'], section: '模型供应商（扩展）', label: 'base_url', description: 'Stone+ 本地网关地址；应用路由时自动维护。', control: 'text', value: 'http://127.0.0.1:15720/v1', readOnly: true, managedByStone: true, advanced: true, source: 'discovered' },
  ],
  gemini: [
    { id: 'gemini.model', role: 'gemini-settings', path: ['model', 'name'], section: '模型与会话', label: '默认模型', description: 'Gemini CLI 新会话默认使用的模型。', control: 'text', value: 'gemini-2.5-pro', defaultValue: null },
    { id: 'gemini.approvalMode', role: 'gemini-settings', path: ['general', 'defaultApprovalMode'], section: '权限', label: '默认审批模式', description: '决定工具调用和文件编辑需要何种确认。', control: 'select', value: 'default', recommendedValue: 'default', options: [{ value: 'default', label: '默认', recommended: true }, { value: 'auto_edit', label: '自动编辑' }, { value: 'plan', label: '计划模式' }] },
    { id: 'gemini.allowedTools', role: 'gemini-settings', path: ['tools', 'allowed'], section: '工具', label: '允许工具', description: '无需额外限制即可使用的工具名称。', control: 'string-list', value: [], advanced: true },
    { id: 'gemini.theme', role: 'gemini-settings', path: ['ui', 'theme'], section: '体验', label: '界面主题', description: 'Gemini CLI 终端界面的主题名称。', control: 'text', value: 'Default' },
    { id: 'gemini.enableAutoUpdate', role: 'gemini-settings', path: ['general', 'enableAutoUpdate'], section: '更新与通知', label: '自动更新', description: '允许 Gemini CLI 自动检查并安装更新。', control: 'toggle', value: true, advanced: true },
  ],
  grokbuild: [
    { id: 'grokbuild.model', role: 'grok-config', path: ['model', 'stoneplus', 'model'], section: '模型', label: '默认模型', description: 'Grok Build 通过 Stone+ 启动新会话时使用的模型。', control: 'text', value: 'grok-4.5', defaultValue: null },
    { id: 'grokbuild.name', role: 'grok-config', path: ['model', 'stoneplus', 'name'], section: '模型', label: '配置名称', description: 'Grok Build 模型选择器中显示的名称。', control: 'text', value: 'Stone+', defaultValue: null },
    { id: 'grokbuild.contextWindow', role: 'grok-config', path: ['model', 'stoneplus', 'context_window'], section: '模型', label: '上下文窗口', description: 'Grok Build 为当前模型预留的上下文窗口大小。', control: 'number', value: 500000, min: 1, step: 1, defaultValue: null },
    { id: 'grokbuild.baseUrl', role: 'grok-config', path: ['model', 'stoneplus', 'base_url'], section: 'Stone+ 连接', label: 'base_url', description: 'Stone+ 的 Grok Build 专属 Responses 入口；应用路由时自动维护。', control: 'text', value: 'http://127.0.0.1:15721/grokbuild/v1', readOnly: true, managedByStone: true },
    { id: 'grokbuild.apiBackend', role: 'grok-config', path: ['model', 'stoneplus', 'api_backend'], section: 'Stone+ 连接', label: 'API 后端', description: 'Grok Build 通过 OpenAI Responses 协议连接 Stone+。', control: 'text', value: 'responses', readOnly: true, managedByStone: true },
  ],
}

function mockConfigFormat(role: ClientConfigFileRole): 'json' | 'toml' | 'dotenv' | 'text' {
  if (role === 'codex-config' || role === 'grok-config') return 'toml'
  if (role === 'gemini-env') return 'dotenv'
  if (role === 'codex-agents' || role === 'codex-rules') return 'text'
  return 'json'
}

function normalizeLoadedModelPolicies(snapshot: AppSnapshot): AppSnapshot {
  const normalizedProviders = [
    ...snapshot.providers,
    ...providers
      .filter((fallback) => fallback.id === 'provider-grok-oauth'
        && !snapshot.providers.some((provider) => provider.id === fallback.id))
      .map(clone),
  ]
  const normalizedAccounts = [
    ...snapshot.accounts,
    ...accounts
      .filter((fallback) => fallback.id === 'account-grok-oauth'
        && !snapshot.accounts.some((account) => account.id === fallback.id))
      .map(clone),
  ]
  const normalizedPools = [
    ...snapshot.pools,
    ...pools
      .filter((fallback) => fallback.id === 'pool-grok'
        && !snapshot.pools.some((pool) => pool.id === fallback.id))
      .map(clone),
  ]
  const normalizedRoutes = [
    ...snapshot.routes,
    ...routes.filter((fallback) => !snapshot.routes.some((route) => route.client === fallback.client)).map(clone),
  ].map((route) => {
    const normalizedRoute = {
      ...route,
      modelSourceMap: route.client === 'codex'
        ? normalizeRouteModelSourceMap(route.modelSourceMap)
        : {},
    }
    if (normalizedRoute.client !== 'grokbuild') return normalizedRoute
    const source = resolveRouteSource(normalizedRoute.poolId, {
      providers: normalizedProviders,
      accounts: normalizedAccounts,
      pools: normalizedPools,
    })
    return source?.summary.protocol === 'grok' ? normalizedRoute : { ...normalizedRoute, poolId: 'pool-grok' }
  })
  const normalizedClientProfiles = [
    ...snapshot.clientProfiles,
    ...initialSnapshot.clientProfiles
      .filter((fallback) => !snapshot.clientProfiles.some((profile) => profile.id === fallback.id))
      .map(clone),
  ]
  return {
    ...snapshot,
    routes: normalizedRoutes,
    clientProfiles: normalizedClientProfiles,
    accountTags: Array.isArray(snapshot.accountTags) ? snapshot.accountTags : clone(accountTags),
    providers: normalizedProviders.map((provider) => {
      const persistedSourceType = provider.sourceType
        ?? (['anthropic', 'openai', 'deepseek', 'xai', 'google'].includes(provider.kind) ? 'official-api' : 'relay')
      const grokOAuthProvider = provider.kind === 'xai' && persistedSourceType === 'oauth-system'
      return {
        ...provider,
        sourceType: provider.kind === 'deepseek'
          ? 'official-api'
          : provider.kind === 'deepseek-compatible'
            ? 'relay'
            : provider.kind === 'xai' && !grokOAuthProvider ? 'official-api' : persistedSourceType,
        ...(provider.kind === 'xai' ? {
          baseUrl: grokOAuthProvider ? 'https://cli-chat-proxy.grok.com/v1' : 'https://api.x.ai/v1',
          protocol: 'openai-responses' as const,
        } : {}),
        ...(provider.kind === 'deepseek' ? {
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai-responses' as const,
          responsesCompactMode: undefined,
          forceFastMode: false,
        } : provider.kind === 'deepseek-compatible' ? {
          protocol: 'openai-responses' as const,
          responsesCompactMode: undefined,
          forceFastMode: false,
        } : {}),
      }
    }),
    accounts: normalizedAccounts.map((account) => ({
      ...account,
      availableModels: Array.isArray(account.availableModels) ? account.availableModels : [],
      modelPolicy: account.modelPolicy ?? (account.modelAllowlist?.length ? 'selected' : 'all'),
      modelAllowlist: Array.isArray(account.modelAllowlist) ? account.modelAllowlist : [],
    })),
    pools: normalizedPools.map((pool) => ({
      ...pool,
      kind: pool.kind ?? 'standard',
      modelPolicy: pool.modelPolicy ?? (pool.modelAllowlist?.length ? 'selected' : 'all'),
      modelAllowlist: Array.isArray(pool.modelAllowlist) ? pool.modelAllowlist : [],
    })),
  }
}

function loadSnapshot(): AppSnapshot {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return clone(initialSnapshot)
    const parsed = JSON.parse(saved) as Partial<AppSnapshot>
    const requestLogs = parsed.requestLogs ?? clone(initialSnapshot.requestLogs)
    return normalizeLoadedModelPolicies({
      ...clone(initialSnapshot),
      ...parsed,
      requestLogs,
      observability: {
        ...clone(initialSnapshot.observability),
        ...parsed.observability,
        tokenCosts: summarizeOpenAiTokenCosts(requestLogs)
      },
      clientProfiles: parsed.clientProfiles ?? clone(initialSnapshot.clientProfiles),
      healthEvents: parsed.healthEvents ?? [],
    })
  } catch {
    return clone(initialSnapshot)
  }
}

function mockAgentLifecycleSnapshot(): AgentLifecycleSnapshot {
  const agents = Object.fromEntries(AGENT_TARGETS.map((target) => [target, {
    target,
    capabilities: AGENT_CAPABILITIES[target],
    installed: true,
    enabled: true,
    configured: true,
    compatibility: 'native' as const,
    running: target === 'codex-desktop',
    managedInstanceCount: target === 'codex-desktop' ? 1 : 0,
    processControl: target === 'codex-desktop' ? 'full' as const : 'managed-only' as const,
    attention: 'normal' as const,
    pendingNewSession: false,
    needsRestart: false,
  }])) as AgentLifecycleSnapshot['agents']
  return { revision: 1, capturedAt: Date.now(), agents, busy: false }
}

function detachMockRouteSources(
  route: Route,
  removedSourceIds: ReadonlySet<string>,
  timestamp: number,
): Route {
  if (removedSourceIds.has(route.poolId)) {
    return { ...route, enabled: false, poolId: '', updatedAt: timestamp }
  }
  const entries = Object.entries(route.modelSourceMap ?? {})
  const modelSourceMap = Object.fromEntries(entries.filter(([, sourceId]) => !removedSourceIds.has(sourceId)))
  return entries.length === Object.keys(modelSourceMap).length
    ? route
    : { ...route, modelSourceMap, updatedAt: timestamp }
}

export function createMockApi(): GatewayApi {
  const snapshot = loadSnapshot()
  let frpTunnelState: FrpTunnelState = {
    config: '',
    configSaved: false,
    binaryAvailable: true,
    running: false,
    logs: [],
  }
  const listeners = new Set<(value: AppSnapshot) => void>()
  const builtInProxyListeners = new Set<(value: BuiltInProxyRuntimeState) => void>()
  const accountImportProgressListeners = new Set<(value: AccountImportProgress) => void>()
  const updateListeners = new Set<(value: AppUpdateState) => void>()
  const browserImportListeners = new Set<(value: BrowserImportQueueState) => void>()
  const agentLifecycleListeners = new Set<(value: AgentLifecycleChangedEvent) => void>()
  const sessionRepairProgressListeners = new Set<(value: CodexSessionRepairProgressEvent) => void>()
  const apiSourceProbeEvidence = new Map<string, { fingerprint: string; expiresAt: number }>()
  const activeSessionRepairOperations = new Set<string>()
  const cancelledSessionRepairOperations = new Set<string>()
  let agentLifecycleSnapshot = mockAgentLifecycleSnapshot()
  let browserImportQueue: BrowserImportQueueState = { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
  let browserJsonCache: BrowserJsonCacheState = { items: [], totalBytes: 0 }
  let setupWizardState: Awaited<ReturnType<GatewayApi['getSetupWizardState']>> = null
  let webDavConfiguration = { baseUrl: '', username: '', hasPassword: false, configured: false }
  let builtInProxyState: BuiltInProxyRuntimeState = {
    desiredEnabled: false,
    status: 'disabled',
    routeGeneration: 0,
    settings: {
      desiredEnabled: false,
      accessMode: 'system',
      ruleMode: 'rule',
      mixedPort: 20800,
      lanEnabled: false,
      autoStart: false,
      hasEverActivated: false,
      updatedAt: Date.now(),
    },
    profiles: [],
    effectiveRoute: { generation: 0, kind: 'external', externalMode: 'direct' },
    accessState: { mode: 'system', status: 'idle' },
  }
  const oauthSessions = new Map<string, {
    input: Parameters<GatewayApi['startChatGptOAuth']>[0]
    callbackSubmitted: boolean
    committing: boolean
  }>()
  const clientBackups: ClientConfigBackup[] = []
  let updateState: AppUpdateState = {
    revision: 0,
    currentVersion: __APP_VERSION__,
    status: 'idle',
    automaticUpdateSupported: true,
  }

  const poolModelCandidates = (accountIds: string[]) => buildPoolModelCoverage(
    accountIds.map((accountId) => snapshot.accounts.find((account) => account.id === accountId)).filter((account) => account !== undefined),
    (providerId) => snapshot.providers.find((provider) => provider.id === providerId)?.models ?? [],
  ).options.map((option) => option.model)

  const ensureOAuthProvider = (): ProviderDefinition => {
    const existing = snapshot.providers.find((provider) => provider.sourceType === 'oauth-system')
    if (existing) return existing
    const timestamp = Date.now()
    const provider: ProviderDefinition = {
      id: 'provider-chatgpt-oauth',
      name: 'ChatGPT OAuth',
      sourceType: 'oauth-system',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      models: ['gpt-5', 'gpt-5-mini', 'o3'],
      color: '#10a37f',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    snapshot.providers.push(provider)
    return provider
  }

  const assignImportedAccountToPool = (poolId: string | null, accountId: string) => {
    if (!poolId) return { added: 0, existing: 0 }
    const pool = snapshot.pools.find((candidate) => candidate.id === poolId)
    if (!pool || pool.kind !== 'standard' || pool.protocol !== 'openai-responses') {
      throw new Error(mockText('导入账号只能加入标准 OpenAI Responses 号池', 'Imported accounts can only be added to a standard OpenAI Responses pool'))
    }
    if (pool.members.some((member) => member.accountId === accountId)) return { added: 0, existing: 1 }
    pool.members.push({ accountId, enabled: true })
    pool.updatedAt = Date.now()
    return { added: 1, existing: 0 }
  }

  const reconcileMockPoolModels = () => {
    snapshot.pools = snapshot.pools.map((pool) => pool.modelPolicy === 'selected' ? {
      ...pool,
      modelAllowlist: pruneModelSelection(
        pool.modelAllowlist,
        poolModelCandidates(pool.members.filter((member) => member.enabled).map((member) => member.accountId)),
      ),
    } : pool)
  }

  const publish = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Browser mock state remains usable for this session when storage is unavailable.
    }
    const value = localizeMockSnapshot(snapshot)
    listeners.forEach((listener) => listener(value))
    return value
  }

  const emitImportProgress = (progressId: string | undefined, progress: Omit<AccountImportProgress, 'progressId'>) => {
    if (!progressId) return
    const value = { progressId, ...progress, message: localizeMockImportProgress(progress.message) }
    for (const listener of accountImportProgressListeners) listener(value)
  }

  const changed = async () => {
    await pause()
    return publish()
  }

  const publishUpdate = (patch: Partial<AppUpdateState>): AppUpdateState => {
    updateState = {
      ...updateState,
      ...patch,
      revision: updateState.revision + 1,
    }
    const value = clone(updateState)
    updateListeners.forEach((listener) => listener(value))
    return value
  }

  const reconcileBuiltInProxyState = (): BuiltInProxyRuntimeState => {
    const timestamp = Date.now()
    const activeProfile = builtInProxyState.profiles.find((profile) => (
      profile.id === builtInProxyState.settings.activeProfileId
    ))
    const activeNode = activeProfile?.nodes.find((node) => node.id === activeProfile.activeNodeId)
    const generation = builtInProxyState.routeGeneration + 1
    const ready = builtInProxyState.desiredEnabled && activeProfile !== undefined && activeNode !== undefined
    const awaitingFirstConfiguration = builtInProxyState.desiredEnabled
      && builtInProxyState.profiles.length === 0
      && !builtInProxyState.settings.hasEverActivated
    const failClosed = builtInProxyState.desiredEnabled
      && !ready
      && builtInProxyState.settings.hasEverActivated
    builtInProxyState = {
      ...builtInProxyState,
      status: !builtInProxyState.desiredEnabled || awaitingFirstConfiguration
        ? 'disabled'
        : ready ? 'ready' : 'error',
      routeGeneration: generation,
      settings: {
        ...builtInProxyState.settings,
        desiredEnabled: builtInProxyState.desiredEnabled,
        hasEverActivated: builtInProxyState.settings.hasEverActivated || ready,
        ...(ready ? { lastActivatedAt: timestamp } : {}),
        updatedAt: timestamp,
      },
      effectiveRoute: ready ? {
        generation,
        kind: builtInProxyState.settings.accessMode === 'tun' ? 'built-in-tun' : 'built-in-mixed',
        profileId: activeProfile.id,
        nodeId: activeNode.id,
        mixedPort: builtInProxyState.settings.mixedPort,
        activatedAt: timestamp,
      } : {
        generation,
        kind: failClosed ? 'blocked' : 'external',
        ...(!failClosed ? { externalMode: snapshot.gateway.outboundNetworkMode ?? 'direct' } : {}),
      },
      accessState: ready ? {
        mode: builtInProxyState.settings.accessMode,
        status: 'ready',
        endpoint: `http://127.0.0.1:${builtInProxyState.settings.mixedPort}`,
        verifiedAt: timestamp,
      } : {
        mode: builtInProxyState.settings.accessMode,
        status: failClosed ? 'error' : 'idle',
      },
      ...(ready || !builtInProxyState.desiredEnabled || awaitingFirstConfiguration ? { error: undefined } : {
        error: {
          category: 'configuration-invalid',
          message: mockText('请选择可用的内置代理节点', 'Select an available built-in proxy node.'),
          retryable: false,
        },
      }),
    }
    const value = clone(builtInProxyState)
    builtInProxyListeners.forEach((listener) => listener(value))
    return value
  }

  async function mockAgentOperation(
    action: AgentLifecycleAction,
    targets: AgentTarget[],
    running: boolean,
  ): Promise<AgentLifecycleOperationResult> {
    const startedAt = Date.now()
    const results = targets.map((target) => {
      const before = agentLifecycleSnapshot.agents[target]
      return {
        target,
        status: 'succeeded' as const,
        phases: action === 'close' || action === 'close-all-managed'
          ? ['inspect' as const, 'close' as const]
          : action === 'install'
            ? ['inspect' as const, 'install' as const, 'validate' as const]
            : action === 'restart'
              ? ['inspect' as const, 'close' as const, 'start' as const]
            : ['inspect' as const, 'restore-connection' as const, 'validate' as const],
        wasRunning: before.running,
        runningAfter: running,
        changed: true,
        pendingNewSession: false,
      }
    })
    const agents = { ...agentLifecycleSnapshot.agents }
    for (const target of targets) {
      agents[target] = {
        ...agents[target],
        ...(action === 'install' ? { installed: true } : {}),
        running,
        managedInstanceCount: running ? 1 : 0,
      }
    }
    agentLifecycleSnapshot = {
      ...agentLifecycleSnapshot,
      revision: agentLifecycleSnapshot.revision + 1,
      capturedAt: Date.now(),
      agents,
    }
    const operation: AgentLifecycleOperationResult = {
      operationId: `mock-agent-${startedAt}`,
      action,
      status: 'succeeded',
      startedAt,
      completedAt: Date.now(),
      results,
      snapshot: clone(agentLifecycleSnapshot),
    }
    agentLifecycleListeners.forEach((listener) => listener({ snapshot: operation.snapshot, operation }))
    return operation
  }

  return {
    async setUiLanguage() {},
    async setUiTheme() {},
    async getSnapshot() {
      await pause(280)
      return localizeMockSnapshot(snapshot)
    },
    async openRequestMonitor() {},
    async getRequestMonitorAlwaysOnTop() { return true },
    async toggleRequestMonitorAlwaysOnTop() { return true },
    async setRequestMonitorDragging() {},
    async saveProvider(input: ProviderInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.providers.find((provider) => provider.id === input.id) : undefined
      const sourceType = input.sourceType ?? existing?.sourceType
        ?? (['anthropic', 'openai', 'deepseek', 'xai', 'google'].includes(input.kind) ? 'official-api' : 'relay')
      if (input.kind === 'xai' && sourceType !== 'official-api') {
        throw new Error(mockText('官方 xAI 来源必须使用官方 API 类型', 'Official xAI sources must use the official API type'))
      }
      if (input.kind === 'xai' && input.protocol !== 'openai-responses') {
        throw new Error(mockText('官方 xAI 来源使用原生 OpenAI Responses API', 'Official xAI sources use the native OpenAI Responses API'))
      }
      if (input.kind === 'deepseek' && sourceType !== 'official-api') {
        throw new Error(mockText('官方 DeepSeek 来源必须使用官方 API 类型', 'Official DeepSeek sources must use the official API type'))
      }
      if (input.kind === 'deepseek-compatible' && sourceType !== 'relay') {
        throw new Error(mockText('DeepSeek 兼容来源必须使用中转站类型', 'DeepSeek-compatible sources must use the relay type'))
      }
      if (input.kind === 'deepseek' && input.protocol !== 'openai-responses') {
        throw new Error(mockText('DeepSeek 来源使用原生 Responses API', 'DeepSeek sources use the native Responses API'))
      }
      if (input.kind === 'deepseek-compatible'
        && input.protocol !== 'openai-responses'
        && input.protocol !== 'openai-chat') {
        throw new Error(mockText('DeepSeek 兼容来源必须使用 Responses 或 Chat Completions', 'DeepSeek-compatible sources must use Responses or Chat Completions'))
      }
      const provider: ProviderDefinition = {
        ...input,
        sourceType,
        ...(input.kind === 'xai' ? { baseUrl: 'https://api.x.ai/v1', protocol: 'openai-responses' as const } : {}),
        ...(input.kind === 'deepseek' ? { baseUrl: 'https://api.deepseek.com', protocol: 'openai-responses' as const } : {}),
        id: existing?.id ?? makeId('provider'),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        color: existing?.color ?? '#2f7668',
      }
      snapshot.providers = existing
        ? snapshot.providers.map((item) => (item.id === existing.id ? provider : item))
        : [...snapshot.providers, provider]
      return changed()
    },
    async refreshProviderModels(id: string) {
      if (!snapshot.providers.some((provider) => provider.id === id)) throw new Error(mockText('供应商不存在', 'Provider not found'))
      return changed()
    },
    async deleteProvider(id: string) {
      if (snapshot.accounts.some((account) => account.providerId === id)) {
        throw new Error(mockText('请先删除该供应商下的账号', 'Delete the accounts under this provider first'))
      }
      snapshot.providers = snapshot.providers.filter((provider) => provider.id !== id)
      const timestamp = Date.now()
      snapshot.routes = snapshot.routes.map((route) => detachMockRouteSources(route, new Set([id]), timestamp))
      return changed()
    },
    async saveAccount(input: AccountInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.accounts.find((account) => account.id === input.id) : undefined
      const credentialChanged = Boolean(input.credential)
      const modelPolicy = input.modelPolicy ?? existing?.modelPolicy ?? 'all'
      const account: PublicAccount = {
        id: existing?.id ?? makeId('account'),
        providerId: input.providerId,
        name: input.name,
        maskedCredential: input.credential
          ? mockMaskCredential(input.credential)
          : existing?.maskedCredential ?? '••••••••',
        status: existing?.status ?? 'active',
        priority: input.priority,
        weight: input.weight,
        maxConcurrency: input.maxConcurrency,
        inFlight: existing?.inFlight ?? 0,
        availableModels: credentialChanged ? [] : existing?.availableModels ?? [],
        modelsRefreshedAt: credentialChanged ? undefined : existing?.modelsRefreshedAt,
        modelPolicy,
        modelAllowlist: modelPolicy === 'selected' ? input.modelAllowlist : [],
        proxyId: input.proxyId === undefined ? existing?.proxyId : input.proxyId || undefined,
        credentialType: existing?.credentialType,
        credentialExpiresAt: existing?.credentialExpiresAt,
        renewable: existing?.renewable,
        tagId: input.tagId === undefined ? existing?.tagId : input.tagId || undefined,
        quota: existing?.quota,
        codexQuota: existing?.codexQuota,
        cooldownUntil: existing?.cooldownUntil,
        circuitState: existing?.circuitState,
        consecutiveFailures: existing?.consecutiveFailures,
        lastError: existing?.lastError,
        quotaRemaining: existing?.quotaRemaining,
        quotaUnit: existing?.quotaUnit,
        latencyMs: existing?.latencyMs,
        lastUsedAt: existing?.lastUsedAt,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      snapshot.accounts = existing
        ? snapshot.accounts.map((item) => (item.id === existing.id ? account : item))
        : [...snapshot.accounts, account]
      reconcileMockPoolModels()
      return changed()
    },
    async saveAccountTag(input) {
      const name = input.name.trim()
      if (!name) throw new Error(mockText('请输入标签名称', 'Enter a tag name'))
      if (name.length > 24) throw new Error(mockText('标签名称不能超过 24 个字符', 'Tag names cannot exceed 24 characters'))
      const existing = input.id ? snapshot.accountTags.find((tag) => tag.id === input.id) : undefined
      if (input.id && !existing) throw new Error(mockText('标签不存在', 'Tag not found'))
      if (!existing && snapshot.accountTags.length >= 50) throw new Error(mockText('最多创建 50 个标签', 'You can create up to 50 tags'))
      if (snapshot.accountTags.some((tag) => tag.id !== existing?.id && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(mockText('标签名称已存在', 'That tag name already exists'))
      }
      const timestamp = Date.now()
      const tag = { id: existing?.id ?? makeId('tag'), name, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }
      snapshot.accountTags = existing
        ? snapshot.accountTags.map((item) => item.id === existing.id ? tag : item)
        : [...snapshot.accountTags, tag]
      return changed()
    },
    async deleteAccountTag(id) {
      if (!snapshot.accountTags.some((tag) => tag.id === id)) throw new Error(mockText('标签不存在', 'Tag not found'))
      snapshot.accountTags = snapshot.accountTags.filter((tag) => tag.id !== id)
      snapshot.accounts = snapshot.accounts.map((account) => account.tagId === id
        ? { ...account, tagId: undefined, updatedAt: Date.now() }
        : account)
      return changed()
    },
    async setAccountTags(input) {
      const selected = new Set(input.accountIds)
      if (!selected.size) throw new Error(mockText('请至少选择一个账号', 'Select at least one account'))
      if (input.tagId && !snapshot.accountTags.some((tag) => tag.id === input.tagId)) throw new Error(mockText('标签不存在', 'Tag not found'))
      snapshot.accounts = snapshot.accounts.map((account) => selected.has(account.id)
        ? { ...account, tagId: input.tagId || undefined, updatedAt: Date.now() }
        : account)
      return changed()
    },
    async refreshAccountModels(id: string) {
      const account = snapshot.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new Error(mockText('账号不存在', 'Account not found'))
      const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
      if (!provider) throw new Error(mockText('账号供应商不存在', 'The account provider does not exist'))
      const overrides: Record<string, string[]> = {
        'account-openai-main': ['gpt-5.5'],
        'account-openai-backup': ['gpt-5.5', 'gpt-5.5-mini'],
      }
      const availableModels = overrides[id] ?? provider.models
      if (!availableModels.length) throw new Error(mockText('上游返回了空模型列表', 'The upstream returned an empty model list'))
      snapshot.accounts = snapshot.accounts.map((candidate) => candidate.id === id ? {
        ...candidate,
        availableModels: [...new Set(availableModels)],
        modelsRefreshedAt: Date.now(),
        modelAllowlist: candidate.modelPolicy === 'selected'
          ? candidate.modelAllowlist.filter((model) => availableModels.includes(model))
          : [],
        updatedAt: Date.now(),
      } : candidate)
      reconcileMockPoolModels()
      return changed()
    },
    async openChatGptWebLogin() {
      return structuredClone(snapshot)
    },
    async testAccountModel(accountId: string, model: string) {
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error(mockText('账号不存在', 'Account not found'))
      if (!model.trim()) throw new Error(mockText('模型标识不能为空', 'The model identifier cannot be empty'))
      const startedAt = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 180))
      return {
        ok: true,
        model,
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
        statusCode: 200,
        responsePreview: 'OK',
      }
    },
    async importChatGptAccounts(input) {
      emitImportProgress(input.progressId, { phase: 'importing', completed: 0, total: 1, percent: 0, message: '正在解析并导入账号…' })
      const parsed = JSON.parse(input.content) as { account_id?: string; email?: string; expired?: string; proxy_id?: string; proxyId?: string }
      const selectedProxyId = input.proxyMode === 'proxy'
        ? input.proxyId
        : input.proxyMode === 'direct'
          ? undefined
          : parsed.proxy_id ?? parsed.proxyId
      if (selectedProxyId && !snapshot.proxies.some((proxy) => proxy.id === selectedProxyId)) {
        throw new Error(input.proxyMode === 'proxy'
          ? mockText('选择的代理已被删除，请重新选择后再导入。', 'The selected proxy was deleted. Select another proxy before importing.')
          : mockText('文件代理不存在。', 'The proxy specified by the file does not exist.'))
      }
      if (input.tagId && !snapshot.accountTags.some((tag) => tag.id === input.tagId)) throw new Error(mockText('标签不存在', 'Tag not found'))
      const provider = ensureOAuthProvider()
      const timestamp = Date.now()
      const account: PublicAccount = {
        id: makeId('chatgpt'), providerId: provider.id, name: input.name || parsed.email || 'ChatGPT Team',
        maskedCredential: `chatgpt-****${parsed.account_id?.slice(-4) ?? 'acct'}`,
        credentialType: 'chatgpt-oauth',
        credentialExpiresAt: parsed.expired ? Date.parse(parsed.expired) : timestamp + 3_600_000,
        renewable: false, tagId: input.tagId || undefined, status: 'active', priority: 10, weight: 10, maxConcurrency: DEFAULT_ACCOUNT_MAX_CONCURRENCY, inFlight: 0,
        availableModels: [], modelPolicy: 'all', modelAllowlist: [], proxyId: selectedProxyId,
        circuitState: 'closed', consecutiveFailures: 0, createdAt: timestamp, updatedAt: timestamp
      }
      snapshot.accounts.push(account)
      await changed()
      emitImportProgress(input.progressId, { phase: 'importing', completed: 1, total: 1, percent: 50, message: '已导入 1 个账号' })
      emitImportProgress(input.progressId, { phase: 'refreshing', completed: 0, total: 1, percent: 50, message: '正在刷新状态与查询模型 0/1' })
      await pause(180)
      account.availableModels = ['gpt-5.5', 'gpt-5.5-mini']
      account.modelsRefreshedAt = Date.now()
      const poolAssignment = assignImportedAccountToPool(input.poolId, account.id)
      const refreshedSnapshot = publish()
      emitImportProgress(input.progressId, { phase: 'refreshing', completed: 1, total: 1, percent: 100, message: '正在刷新状态与查询模型 1/1' })
      emitImportProgress(input.progressId, { phase: 'complete', completed: 1, total: 1, percent: 100, message: '导入、状态刷新与模型查询已完成' })
      return {
        snapshot: refreshedSnapshot,
        importedAccountIds: [account.id],
        createdAccountIds: [account.id],
        updatedAccountIds: [],
        warnings: ['No refresh token'],
        detectionResults: [{ accountId: account.id, accountName: account.name, ok: true, latencyMs: 820, availableModelCount: 2 }],
        assignmentSummary: {
          tagId: input.tagId,
          tagUpdatedAccountCount: 1,
          poolId: input.poolId,
          poolMembersAdded: poolAssignment.added,
          poolMembersAlreadyPresent: poolAssignment.existing,
          poolMembersSkipped: 0,
        }
      }
    },
    async importGrokAccounts(input) {
      const root = JSON.parse(input.content) as { accounts?: Array<Record<string, unknown>> }
      const importedAccounts = root.accounts?.filter((item) => item.platform === 'grok' && item.type === 'oauth') ?? []
      if (!importedAccounts.length) throw new Error(mockText('未找到 Grok OAuth 账号', 'No Grok OAuth account found'))
      const pool = input.poolId ? snapshot.pools.find((candidate) => candidate.id === input.poolId) : undefined
      if (input.poolId && !pool) throw new Error(mockText('Grok 号池不存在', 'Grok pool not found'))
      if (input.proxyId && !snapshot.proxies.some((proxy) => proxy.id === input.proxyId)) {
        throw new Error(mockText('选择的代理已被删除', 'The selected proxy was deleted'))
      }
      if (pool && (pool.kind !== 'standard' || pool.protocol !== 'grok' || pool.members.some((member) => {
        const account = snapshot.accounts.find((candidate) => candidate.id === member.accountId)
        const provider = snapshot.providers.find((candidate) => candidate.id === account?.providerId)
        return !account || !accountMatchesPoolProtocol('grok', account, provider)
      }))) throw new Error(mockText('Grok OAuth 账号只能加入 Grok 号池', 'Grok OAuth accounts can only join Grok pools'))
      let provider = snapshot.providers.find((item) => item.kind === 'xai' && item.sourceType === 'oauth-system')
      const timestamp = Date.now()
      if (!provider) {
        provider = { id: makeId('grok-oauth-provider'), name: 'Grok OAuth', sourceType: 'oauth-system', kind: 'xai', baseUrl: 'https://cli-chat-proxy.grok.com/v1', protocol: 'openai-responses', models: ['grok-4.5'], createdAt: timestamp, updatedAt: timestamp }
        snapshot.providers.push(provider)
      }
      let grokTag = snapshot.accountTags.find((tag) => tag.name.localeCompare('Grok', undefined, { sensitivity: 'accent' }) === 0)
      if (!grokTag) {
        grokTag = { id: makeId('grok-tag'), name: 'Grok', createdAt: timestamp, updatedAt: timestamp }
        snapshot.accountTags.push(grokTag)
      }
      const importedAccountIds: string[] = []
      const createdAccountIds: string[] = []
      const updatedAccountIds: string[] = []
      for (const [index, imported] of importedAccounts.entries()) {
        const credentials = imported.credentials as Record<string, unknown> | undefined
        const name = String(imported.name || credentials?.email || `Grok account ${index + 1}`)
        const existing = snapshot.accounts.find((account) => account.credentialType === 'grok-oauth'
          && account.name.toLowerCase() === name.toLowerCase())
        const parsedExpiration = typeof credentials?.expires_at === 'string' ? Date.parse(credentials.expires_at) : NaN
        const account: PublicAccount = {
          id: existing?.id ?? makeId('grok'), providerId: provider.id, name,
          maskedCredential: 'grok-****oauth', credentialType: 'grok-oauth', renewable: Boolean(credentials?.refresh_token),
          credentialExpiresAt: Number.isFinite(parsedExpiration) ? parsedExpiration : timestamp + 3_600_000,
          tagId: grokTag.id,
          status: 'active', priority: existing?.priority ?? 1, weight: existing?.weight ?? 10,
          maxConcurrency: existing?.maxConcurrency ?? 1, inFlight: existing?.inFlight ?? 0,
          availableModels: ['grok-4.5'], modelPolicy: 'selected', modelAllowlist: ['grok-4.5'],
          proxyId: input.proxyId, circuitState: 'closed', consecutiveFailures: 0,
          createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        }
        if (existing) {
          snapshot.accounts = snapshot.accounts.map((candidate) => candidate.id === existing.id ? account : candidate)
          updatedAccountIds.push(account.id)
        } else {
          snapshot.accounts.push(account)
          createdAccountIds.push(account.id)
        }
        importedAccountIds.push(account.id)
        if (pool && !pool.members.some((member) => member.accountId === account.id)) {
          pool.members.push({ accountId: account.id, enabled: true })
          pool.updatedAt = timestamp
        }
      }
      return { snapshot: await changed(), importedAccountIds, createdAccountIds, updatedAccountIds, warnings: [] }
    },
    async importChatGptAccountFiles(input) {
      emitImportProgress(input.progressId, { phase: 'importing', completed: 0, total: 2, percent: 0, message: '正在导入文件 0/2' })
      await pause(180)
      emitImportProgress(input.progressId, { phase: 'importing', completed: 1, total: 2, percent: 25, message: '正在导入文件 1/2' })
      await pause(180)
      emitImportProgress(input.progressId, { phase: 'importing', completed: 2, total: 2, percent: 50, message: '正在导入文件 2/2' })
      if (input.proxyMode === 'proxy' && !snapshot.proxies.some((proxy) => proxy.id === input.proxyId)) {
        throw new Error(mockText('选择的代理已被删除，请重新选择后再导入。', 'The selected proxy was deleted. Select another proxy before importing.'))
      }
      if (input.tagId && !snapshot.accountTags.some((tag) => tag.id === input.tagId)) throw new Error(mockText('标签不存在', 'Tag not found'))
      const provider = ensureOAuthProvider()
      const accountId = makeId('chatgpt-file')
      const timestamp = Date.now()
      const account: PublicAccount = {
        id: accountId, providerId: provider.id, name: 'CPA Plus Account',
        maskedCredential: 'chatgpt-****demo', credentialType: 'chatgpt-oauth',
        credentialExpiresAt: timestamp + 3_600_000, renewable: false, tagId: input.tagId || undefined, status: 'active', priority: 10, weight: 10,
        maxConcurrency: DEFAULT_ACCOUNT_MAX_CONCURRENCY, inFlight: 0, latencyMs: 820, availableModels: [], modelPolicy: 'all', modelAllowlist: [],
        proxyId: input.proxyMode === 'proxy' ? input.proxyId : undefined,
        circuitState: 'closed', consecutiveFailures: 0, createdAt: timestamp, updatedAt: timestamp
      }
      snapshot.accounts.push(account)
      publish()
      emitImportProgress(input.progressId, { phase: 'refreshing', completed: 0, total: 1, percent: 50, message: '正在刷新状态与查询模型 0/1' })
      await pause(180)
      account.availableModels = ['gpt-5.5', 'gpt-5.5-mini']
      account.modelsRefreshedAt = Date.now()
      const poolAssignment = assignImportedAccountToPool(input.poolId, account.id)
      publish()
      emitImportProgress(input.progressId, { phase: 'refreshing', completed: 1, total: 1, percent: 100, message: '正在刷新状态与查询模型 1/1' })
      emitImportProgress(input.progressId, { phase: 'complete', completed: 1, total: 1, percent: 100, message: '导入、状态刷新与模型查询已完成' })
      return {
        snapshot: localizeMockSnapshot(snapshot),
        cancelled: false,
        selectedFiles: 2,
        fileResults: [
          { fileName: 'codex-plus-1.json', status: 'imported', importedAccounts: 1, createdAccounts: 1, updatedAccounts: 0 },
          { fileName: 'sub2api-export.json', status: 'imported', importedAccounts: 1, createdAccounts: 0, updatedAccounts: 1 },
        ],
        importedAccountIds: [accountId],
        createdAccountIds: [accountId],
        updatedAccountIds: [],
        detectionResults: [{ accountId, accountName: account.name, ok: true, latencyMs: 820, availableModelCount: 2 }],
        warnings: [mockText(
          'codex-plus-1.json：已从 JWT user_id 自动补全 1 个 CPA 账号的 account_id。',
          'codex-plus-1.json: Filled in account_id for 1 CPA account from JWT user_id.',
        )],
        assignmentSummary: {
          tagId: input.tagId,
          tagUpdatedAccountCount: 1,
          poolId: input.poolId,
          poolMembersAdded: poolAssignment.added,
          poolMembersAlreadyPresent: poolAssignment.existing,
          poolMembersSkipped: 0,
        }
      }
    },
    async startChatGptOAuth(input) {
      if (input.proxyMode === 'proxy' && !snapshot.proxies.some((proxy) => proxy.id === input.proxyId)) {
        throw new Error(mockText('选择的代理已被删除，请重新选择后再授权。', 'The selected proxy was deleted. Select another proxy before authorizing.'))
      }
      if (input.tagId && !snapshot.accountTags.some((tag) => tag.id === input.tagId)) throw new Error(mockText('标签不存在', 'Tag not found'))
      const sessionId = makeId('oauth')
      const redirectUri = 'http://localhost:1455/auth/callback'
      const expiresAt = Date.now() + 10 * 60_000
      oauthSessions.set(sessionId, { input: clone(input), callbackSubmitted: false, committing: false })
      return {
        sessionId,
        authorizationUrl: `https://auth.openai.com/oauth/authorize?response_type=code&client_id=stone-mock&redirect_uri=${encodeURIComponent(redirectUri)}&state=${sessionId}`,
        redirectUri,
        expiresAt,
        loopbackListening: true,
        status: 'waiting' as const,
      }
    },
    async openChatGptOAuth(sessionId) {
      if (!oauthSessions.has(sessionId)) throw new Error(mockText('OAuth 授权会话不存在或已结束。', 'The OAuth authorization session does not exist or has ended.'))
    },
    async submitChatGptOAuthCallback(input) {
      const session = oauthSessions.get(input.sessionId)
      if (!session) throw new Error(mockText('OAuth 授权会话不存在或已结束。', 'The OAuth authorization session does not exist or has ended.'))
      if (!input.callbackUrl.trim()) throw new Error(mockText('请粘贴完整 OAuth 回调地址。', 'Paste the complete OAuth callback URL.'))
      session.callbackSubmitted = true
    },
    async waitChatGptOAuth(sessionId) {
      const session = oauthSessions.get(sessionId)
      if (!session) throw new Error(mockText('OAuth 授权会话不存在或已结束。', 'The OAuth authorization session does not exist or has ended.'))
      await pause(450)
      if (oauthSessions.get(sessionId) !== session) throw new Error(mockText('OAuth 授权已取消。', 'OAuth authorization was canceled.'))
      session.committing = true
      const tagWasDeleted = Boolean(session.input.tagId
        && !snapshot.accountTags.some((tag) => tag.id === session.input.tagId))
      const result = await this.importChatGptAccounts({
        content: JSON.stringify({
          account_id: `acct-${sessionId}`,
          email: 'oauth.demo@stone.local',
          expired: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
        name: session.input.name,
        tagId: tagWasDeleted ? null : session.input.tagId,
        poolId: session.input.poolId,
        proxyMode: session.input.proxyMode,
        proxyId: session.input.proxyId,
      })
      oauthSessions.delete(sessionId)
      return tagWasDeleted ? {
        ...result,
        warnings: [...result.warnings, mockText(
          'OAuth 授权期间所选 Tag 已被删除，账号已按“未标记”导入。',
          'The selected Tag was deleted during OAuth authorization. The account was imported as untagged.',
        )]
      } : result
    },
    async cancelChatGptOAuth(sessionId) {
      const session = oauthSessions.get(sessionId)
      if (session?.committing) return false
      oauthSessions.delete(sessionId)
      return true
    },
    async getBrowserImportQueue() {
      return clone(browserImportQueue)
    },
    async removeBrowserImportItem(id) {
      browserImportQueue = {
        ...browserImportQueue,
        items: browserImportQueue.items.filter((item) => item.id !== id),
        revision: browserImportQueue.revision + 1,
      }
      browserImportQueue.readyCount = browserImportQueue.items.filter((item) => item.status === 'ready').length
      browserImportQueue.totalBytes = browserImportQueue.items.reduce((total, item) => total + item.sizeBytes, 0)
      for (const listener of browserImportListeners) listener(clone(browserImportQueue))
      return clone(browserImportQueue)
    },
    async clearBrowserImportQueue() {
      browserImportQueue = { items: [], readyCount: 0, totalBytes: 0, revision: browserImportQueue.revision + 1 }
      for (const listener of browserImportListeners) listener(clone(browserImportQueue))
      return clone(browserImportQueue)
    },
    async getBrowserJsonCache() {
      return clone(browserJsonCache)
    },
    async saveBrowserJsonCacheItem(id) {
      if (!browserJsonCache.items.some((item) => item.id === id)) throw new Error(mockText('缓存中的 JSON 已不存在。', 'The cached JSON file no longer exists.'))
      return { cancelled: false, filePath: `C:\\Downloads\\${browserJsonCache.items.find((item) => item.id === id)!.fileName}` }
    },
    async removeBrowserJsonCacheItem(id) {
      browserJsonCache = {
        items: browserJsonCache.items.filter((item) => item.id !== id),
        totalBytes: browserJsonCache.items.filter((item) => item.id !== id).reduce((total, item) => total + item.sizeBytes, 0)
      }
      return clone(browserJsonCache)
    },
    async clearBrowserJsonCache() {
      browserJsonCache = { items: [], totalBytes: 0 }
      return clone(browserJsonCache)
    },
    async importBrowserJsonQueue(input) {
      if (!input.itemIds.length) throw new Error(mockText('请至少选择一个已挂起的 JSON 文件。', 'Select at least one queued JSON file.'))
      const selectedFiles = input.itemIds.length
      const result = await this.importChatGptAccountFiles(input)
      browserImportQueue = {
        ...browserImportQueue,
        items: browserImportQueue.items.filter((item) => !input.itemIds.includes(item.id)),
        revision: browserImportQueue.revision + 1,
      }
      browserImportQueue.readyCount = browserImportQueue.items.filter((item) => item.status === 'ready').length
      browserImportQueue.totalBytes = browserImportQueue.items.reduce((total, item) => total + item.sizeBytes, 0)
      return { ...result, selectedFiles }
    },
    async deleteAccount(id: string) {
      snapshot.accounts = snapshot.accounts.filter((account) => account.id !== id)
      const deletedAggregatePoolIds = new Set<string>()
      snapshot.pools = snapshot.pools.flatMap((pool) => {
        const members = pool.members.filter((member) => member.accountId !== id)
        if (pool.kind === 'relay-aggregate' && members.length < 2) {
          deletedAggregatePoolIds.add(pool.id)
          return []
        }
        return [{ ...pool, members }]
      })
      const emptyPoolIds = new Set(snapshot.pools
        .filter((pool) => pool.kind === 'standard' && pool.members.length === 0)
        .map((pool) => pool.id))
      const timestamp = Date.now()
      snapshot.routes = snapshot.routes.map((route) => {
        const detached = detachMockRouteSources(route, deletedAggregatePoolIds, timestamp)
        return emptyPoolIds.has(route.poolId) && detached.enabled
          ? { ...detached, enabled: false, updatedAt: timestamp }
          : detached
      })
      reconcileMockPoolModels()
      return changed()
    },
    async deleteAccounts(ids: string[]) {
      const selected = new Set(ids)
      snapshot.accounts = snapshot.accounts.filter((account) => !selected.has(account.id))
      const deletedAggregatePoolIds = new Set<string>()
      snapshot.pools = snapshot.pools.flatMap((pool) => {
        const members = pool.members.filter((member) => !selected.has(member.accountId))
        if (pool.kind === 'relay-aggregate' && members.length < 2) {
          deletedAggregatePoolIds.add(pool.id)
          return []
        }
        return [{ ...pool, members }]
      })
      const emptyPoolIds = new Set(snapshot.pools
        .filter((pool) => pool.kind === 'standard' && pool.members.length === 0)
        .map((pool) => pool.id))
      const timestamp = Date.now()
      snapshot.routes = snapshot.routes.map((route) => {
        const detached = detachMockRouteSources(route, deletedAggregatePoolIds, timestamp)
        return emptyPoolIds.has(route.poolId) && detached.enabled
          ? { ...detached, enabled: false, updatedAt: timestamp }
          : detached
      })
      reconcileMockPoolModels()
      return changed()
    },
    async exportChatGptAccounts(input) {
      await pause(120)
      return {
        cancelled: false,
        exportedAccounts: input.accountIds.length,
        exportedFiles: input.mode === 'merged' ? 1 : input.accountIds.length,
        ...(input.mode === 'merged'
          ? { filePath: `C:\\Users\\Demo\\Downloads\\stoneplus-${input.format}-accounts.json` }
          : { directoryPath: 'C:\\Users\\Demo\\Downloads\\stoneplus-accounts' })
      }
    },
    async saveProxy(input: ProxyInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.proxies.find((proxy) => proxy.id === input.id) : undefined
      const proxy: PublicProxyDefinition = {
        id: existing?.id ?? makeId('proxy'),
        name: input.name,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        username: input.username || undefined,
        hasPassword: input.clearPassword ? false : Boolean(input.password || existing?.hasPassword),
        status: 'unchecked',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      snapshot.proxies = existing
        ? snapshot.proxies.map((candidate) => candidate.id === proxy.id ? proxy : candidate)
        : [...snapshot.proxies, proxy]
      return changed()
    },
    async deleteProxy(id: string) {
      if (snapshot.accounts.some((account) => account.proxyId === id) || snapshot.pools.some((pool) => pool.proxyId === id)) {
        throw new Error(mockText('该代理仍被账号或号池使用', 'This proxy is still used by an account or pool'))
      }
      snapshot.proxies = snapshot.proxies.filter((proxy) => proxy.id !== id)
      return changed()
    },
    async checkProxy(id: string) {
      await pause(420)
      snapshot.proxies = snapshot.proxies.map((proxy) => proxy.id === id ? {
        ...proxy,
        status: 'available',
        exitIp: '203.0.113.24',
        latencyMs: 160,
        lastCheckedAt: Date.now(),
        lastError: undefined,
        updatedAt: Date.now(),
      } : proxy)
      return publish()
    },
    async getBuiltInProxyState() {
      return clone(builtInProxyState)
    },
    async setBuiltInProxyEnabled(enabled: boolean) {
      builtInProxyState = { ...builtInProxyState, desiredEnabled: enabled }
      return reconcileBuiltInProxyState()
    },
    async retryBuiltInProxy() {
      return reconcileBuiltInProxyState()
    },
    async importBuiltInProxyProfile(input) {
      const timestamp = Date.now()
      const profileId = makeId('built-in-profile')
      const nodeId = makeId('built-in-node')
      const profile: BuiltInProxyRuntimeState['profiles'][number] = {
        id: profileId,
        name: input.name?.trim() || mockText('演示内置代理', 'Demo built-in proxy'),
        source: input.source,
        format: input.format ?? (input.source === 'subscription' ? 'clash-meta-yaml' : 'sing-box-json'),
        nodes: [{
          id: nodeId,
          name: mockText('演示节点', 'Demo node'),
          type: 'mock',
          groupIds: [],
          latencyStatus: 'untested',
        }],
        nodeCount: 1,
        groupCount: 0,
        ruleStatus: 'fallback',
        activeNodeId: nodeId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      builtInProxyState = {
        ...builtInProxyState,
        profiles: [...builtInProxyState.profiles, profile],
        settings: {
          ...builtInProxyState.settings,
          activeProfileId: builtInProxyState.settings.activeProfileId ?? profileId,
        },
      }
      return reconcileBuiltInProxyState()
    },
    async refreshBuiltInProxyProfile(id: string) {
      if (!builtInProxyState.profiles.some((profile) => profile.id === id)) {
        throw new Error(mockText('内置代理配置不存在', 'Built-in proxy profile not found'))
      }
      const timestamp = Date.now()
      builtInProxyState = {
        ...builtInProxyState,
        profiles: builtInProxyState.profiles.map((profile) => profile.id === id ? {
          ...profile,
          updatedAt: timestamp,
          lastRefreshAt: timestamp,
        } : profile),
      }
      return reconcileBuiltInProxyState()
    },
    async deleteBuiltInProxyProfile(id: string) {
      const profiles = builtInProxyState.profiles.filter((profile) => profile.id !== id)
      builtInProxyState = {
        ...builtInProxyState,
        profiles,
        settings: {
          ...builtInProxyState.settings,
          activeProfileId: builtInProxyState.settings.activeProfileId === id
            ? profiles[0]?.id
            : builtInProxyState.settings.activeProfileId,
        },
      }
      return reconcileBuiltInProxyState()
    },
    async selectBuiltInProxyProfile(id: string) {
      if (!builtInProxyState.profiles.some((profile) => profile.id === id)) {
        throw new Error(mockText('内置代理配置不存在', 'Built-in proxy profile not found'))
      }
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, activeProfileId: id },
      }
      return reconcileBuiltInProxyState()
    },
    async selectBuiltInProxyNode(profileId: string, nodeId: string) {
      const profile = builtInProxyState.profiles.find((candidate) => candidate.id === profileId)
      if (!profile?.nodes.some((node) => node.id === nodeId)) {
        throw new Error(mockText('内置代理节点不存在', 'Built-in proxy node not found'))
      }
      builtInProxyState = {
        ...builtInProxyState,
        profiles: builtInProxyState.profiles.map((candidate) => candidate.id === profileId
          ? { ...candidate, activeNodeId: nodeId, updatedAt: Date.now() }
          : candidate),
        settings: { ...builtInProxyState.settings, activeProfileId: profileId },
      }
      return reconcileBuiltInProxyState()
    },
    async setBuiltInProxyRuleMode(ruleMode) {
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, ruleMode },
      }
      return reconcileBuiltInProxyState()
    },
    async setBuiltInProxyCustomRules(customRules) {
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, customRules: customRules ? clone(customRules) : undefined },
      }
      return reconcileBuiltInProxyState()
    },
    async setBuiltInProxyAccessMode(accessMode) {
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, accessMode },
      }
      return reconcileBuiltInProxyState()
    },
    async setBuiltInProxyLanEnabled(lanEnabled: boolean) {
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, lanEnabled },
      }
      return reconcileBuiltInProxyState()
    },
    async setBuiltInProxyAutoStart(autoStart: boolean) {
      builtInProxyState = {
        ...builtInProxyState,
        settings: { ...builtInProxyState.settings, autoStart },
      }
      return reconcileBuiltInProxyState()
    },
    async testBuiltInProxyLatency(profileId, nodeIds) {
      const selectedProfileId = profileId ?? builtInProxyState.settings.activeProfileId
      const selectedNodeIds = nodeIds ? new Set(nodeIds) : undefined
      const testedNodes: BuiltInProxyRuntimeState['profiles'][number]['nodes'] = []
      const timestamp = Date.now()
      builtInProxyState = {
        ...builtInProxyState,
        profiles: builtInProxyState.profiles.map((profile) => {
          if (profile.id !== selectedProfileId) return profile
          return {
            ...profile,
            nodes: profile.nodes.map((node) => {
              if (selectedNodeIds && !selectedNodeIds.has(node.id)) return node
              const tested = {
                ...node,
                latencyMs: 42,
                latencyStatus: 'available' as const,
                lastTestedAt: timestamp,
              }
              testedNodes.push(tested)
              return tested
            }),
            updatedAt: timestamp,
          }
        }),
      }
      return clone(testedNodes)
    },
    async getBuiltInProxyTraffic() {
      return {
        capturedAt: Date.now(),
        uploadBytes: 0,
        downloadBytes: 0,
        uploadRateBytesPerSecond: 0,
        downloadRateBytesPerSecond: 0,
        activeConnections: 0,
        totalConnections: 0,
      }
    },
    async listBuiltInProxyConnections() {
      return []
    },
    async closeBuiltInProxyConnection(_id: string) {},
    async savePool(input: PoolInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.pools.find((pool) => pool.id === input.id) : undefined
      const selected = input.accountIds.map((accountId) => snapshot.accounts.find((account) => account.id === accountId))
      if (!selected.length || selected.some((account) => {
        const provider = snapshot.providers.find((candidate) => candidate.id === account?.providerId)
        return !account || !accountMatchesPoolProtocol(input.protocol, account, provider)
      })) throw new Error(mockText('号池成员与对外协议不兼容', 'Pool members are incompatible with its public protocol'))
      const families = new Set(selected.map((account) => {
        const provider = snapshot.providers.find((candidate) => candidate.id === account?.providerId)
        return provider ? providerSourceFamily(provider.kind) : undefined
      }))
      if (families.has(undefined) || families.size !== 1) throw new Error(mockText('一个号池只能使用同一种来源', 'A pool can use only one source family'))
      const modelPolicy = input.modelPolicy ?? existing?.modelPolicy ?? 'all'
      const modelAllowlist = modelPolicy === 'selected'
        ? pruneModelSelection(input.modelAllowlist ?? existing?.modelAllowlist ?? [], poolModelCandidates(input.accountIds))
        : []
      const pool: Pool = {
        id: existing?.id ?? makeId('pool'),
        name: input.name,
        kind: input.kind ?? existing?.kind ?? 'standard',
        protocol: input.protocol,
        strategy: input.strategy,
        members: input.accountIds.map((accountId) => ({ accountId, enabled: true })),
        modelPolicy,
        modelAllowlist,
        stickySessions: input.stickySessions,
        stickyTtlMinutes: input.stickyTtlMinutes,
        maxRetries: input.maxRetries,
        forceFastMode: supportsPoolFastServiceTier(input.protocol)
          && (input.forceFastMode ?? existing?.forceFastMode) === true,
        hedgedRequests: input.protocol === 'openai-responses'
          && (input.hedgedRequests ?? existing?.hedgedRequests) === true,
        hedgeDelayMs: input.hedgeDelayMs ?? existing?.hedgeDelayMs ?? 2_500,
        firstBodyTimeoutMs: input.firstBodyTimeoutMs ?? existing?.firstBodyTimeoutMs ?? 8_000,
        proxyId: input.proxyId || undefined,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      snapshot.pools = existing
        ? snapshot.pools.map((item) => (item.id === existing.id ? pool : item))
        : [...snapshot.pools, pool]
      return changed()
    },
    async deletePool(id: string) {
      if (snapshot.routes.some((route) => routeReferencesSource(route, id))) {
        throw new Error(mockText('该号池正被客户端路由使用', 'This pool is used by a client route'))
      }
      snapshot.pools = snapshot.pools.filter((pool) => pool.id !== id)
      return changed()
    },
    async setRouteSourceFastMode(input) {
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
      if (!sourceId) throw new Error(mockText('请选择号池或中转站', 'Select a pool or relay'))
      if (typeof input.enabled !== 'boolean') throw new Error(mockText('FAST 状态无效', 'The FAST state is invalid'))
      const pool = snapshot.pools.find((candidate) => candidate.id === sourceId)
      const provider = snapshot.providers.find((candidate) => candidate.id === sourceId)
      if (pool && provider) throw new Error(mockText('来源 ID 与号池 ID 冲突', 'The source ID conflicts with a pool ID'))
      if (pool) {
        if (input.enabled && !supportsPoolFastServiceTier(pool.protocol)) {
          throw new Error(mockText('FAST 仅支持 OpenAI Responses 与 OpenAI Chat', 'FAST supports only OpenAI Responses and OpenAI Chat'))
        }
        snapshot.pools = snapshot.pools.map((candidate) => candidate.id === sourceId
          ? { ...candidate, forceFastMode: input.enabled, updatedAt: Date.now() }
          : candidate)
        return changed()
      }
      if (!provider) throw new Error(mockText('号池或中转站不存在', 'The pool or relay does not exist'))
      if (provider.sourceType === 'oauth-system') throw new Error(mockText('系统 OAuth 来源不能作为独立 FAST 中转站', 'A system OAuth source cannot be used as a standalone FAST relay'))
      if (provider.sourceType !== 'relay') throw new Error(mockText('FAST 仅能直接配置中转站来源', 'FAST can be configured directly only for relay sources'))
      if (input.enabled && !supportsFastServiceTier(provider.protocol)) {
        throw new Error(mockText('FAST 仅支持 OpenAI Responses 与 OpenAI Chat', 'FAST supports only OpenAI Responses and OpenAI Chat'))
      }
      if (input.enabled && providerSourceFamily(provider.kind) === 'deepseek') {
        throw new Error(mockText('DeepSeek Responses 不支持 FAST', 'DeepSeek Responses does not support FAST'))
      }
      snapshot.providers = snapshot.providers.map((candidate) => candidate.id === sourceId
        ? { ...candidate, forceFastMode: input.enabled, updatedAt: Date.now() }
        : candidate)
      return changed()
    },
    async saveApiSource(rawInput) {
      const input = normalizeMockApiSourceInput(rawInput)
      const timestamp = Date.now()
      const existing = input.id ? snapshot.providers.find((provider) => provider.id === input.id) : undefined
      if (input.id && !existing) throw new Error(mockText('API 来源不存在', 'The API source does not exist'))
      if (input.proxyId && !snapshot.proxies.some((proxy) => proxy.id === input.proxyId)) {
        throw new Error(mockText('请选择现有代理', 'Choose an existing proxy'))
      }
      const existingAccounts = existing
        ? snapshot.accounts.filter((account) => account.providerId === existing.id)
        : []
      if (existingAccounts.some((account) => ['chatgpt-oauth', 'chatgpt-agent-identity', 'grok-oauth'].includes(account.credentialType ?? ''))) {
        throw new Error(mockText('OAuth 账号不能转换为 API Key 来源', 'OAuth accounts cannot be converted into API-key sources'))
      }
      if (existingAccounts.length > 1) throw new Error(mockText('该来源包含多个账号，无法安全编辑', 'This source has multiple accounts and cannot be edited safely'))
      const existingAccount = existingAccounts[0]
      if (!existingAccount && !input.credential) {
        throw new Error(mockText('首次添加需要填写 API Key', 'An API key is required when adding a source'))
      }

      const evidence = input.probeEvidenceToken ? apiSourceProbeEvidence.get(input.probeEvidenceToken) : undefined
      if (input.probeEvidenceToken) apiSourceProbeEvidence.delete(input.probeEvidenceToken)
      if (input.probeEvidenceToken && (!evidence
        || evidence.expiresAt < timestamp
        || evidence.fingerprint !== mockProbeEvidenceFingerprint({ ...input, model: input.defaultModel }))) {
        throw new Error(mockText('来源探针凭据无效或已使用，请重新测试', 'The source probe evidence is invalid or already used; run the test again'))
      }

      const models = input.models.length ? [...input.models] : defaultMockSourceModels(input.kind, input.protocol)
      const connectionChanged = !existing
        || !existingAccount
        || existing.sourceType !== input.sourceType
        || existing.kind !== input.kind
        || existing.baseUrl !== input.baseUrl
        || existing.protocol !== input.protocol
        || existing.models[0] !== models[0]
        || existingAccount.proxyId !== input.proxyId
        || Boolean(input.credential)
      const providerId = existing?.id ?? makeId('provider')
      const provider: ProviderDefinition = {
        id: providerId,
        name: input.name,
        sourceType: input.sourceType,
        kind: input.kind,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        responsesCompactMode: input.kind === 'deepseek' || input.kind === 'deepseek-compatible'
          ? undefined
          : input.responsesCompactMode,
        deepSeekReasoningEffort: providerSourceFamily(input.kind) === 'deepseek'
          ? normalizeDeepSeekReasoningEffort(
              input.deepSeekReasoningEffort ?? existing?.deepSeekReasoningEffort,
              DEEPSEEK_DEFAULT_REASONING_EFFORT,
            )
          : undefined,
        models,
        capabilityProfile: evidence ? input.capabilityProfile : connectionChanged ? undefined : existing?.capabilityProfile,
        toolRoundtripVerified: connectionChanged ? false : existing?.toolRoundtripVerified,
        modelCatalog: evidence ? input.modelCatalog : connectionChanged ? undefined : existing?.modelCatalog,
        forceFastMode: providerSourceFamily(input.kind) === 'deepseek' ? false : existing?.forceFastMode,
        color: existing?.color ?? '#2f7668',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      const account: PublicAccount = {
        id: existingAccount?.id ?? makeId('account'),
        providerId,
        name: input.name,
        maskedCredential: input.credential ? mockMaskCredential(input.credential) : existingAccount?.maskedCredential ?? '••••••••',
        status: connectionChanged ? 'active' : existingAccount?.status ?? 'active',
        priority: input.priority,
        weight: input.weight,
        maxConcurrency: input.maxConcurrency,
        inFlight: connectionChanged ? 0 : existingAccount?.inFlight ?? 0,
        availableModels: models,
        modelsRefreshedAt: timestamp,
        modelPolicy: existingAccount?.modelPolicy ?? 'all',
        modelAllowlist: existingAccount?.modelAllowlist ?? [],
        proxyId: input.proxyId,
        credentialType: existingAccount?.credentialType ?? 'api-key',
        credentialExpiresAt: existingAccount?.credentialExpiresAt,
        renewable: existingAccount?.renewable,
        tagId: existingAccount?.tagId,
        quota: connectionChanged ? undefined : existingAccount?.quota,
        codexQuota: existingAccount?.codexQuota,
        cooldownUntil: connectionChanged ? undefined : existingAccount?.cooldownUntil,
        circuitState: connectionChanged ? 'closed' : existingAccount?.circuitState,
        consecutiveFailures: connectionChanged ? 0 : existingAccount?.consecutiveFailures,
        lastError: connectionChanged ? undefined : existingAccount?.lastError,
        quotaRemaining: connectionChanged ? undefined : existingAccount?.quotaRemaining,
        quotaUnit: connectionChanged ? undefined : existingAccount?.quotaUnit,
        latencyMs: connectionChanged ? undefined : existingAccount?.latencyMs,
        lastUsedAt: connectionChanged ? undefined : existingAccount?.lastUsedAt,
        createdAt: existingAccount?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }

      const nextProviders = existing
        ? snapshot.providers.map((item) => (item.id === provider.id ? provider : item))
        : [...snapshot.providers, provider]
      const nextAccounts = existingAccount
        ? snapshot.accounts.map((item) => (item.id === account.id ? account : item))
        : [...snapshot.accounts, account]
      let nextPools = [...snapshot.pools]
      let nextRoutes = [...snapshot.routes]
      if (input.unlinkIncompatiblePools) {
        const deletedPoolIds = new Set<string>()
        nextPools = nextPools.flatMap((pool) => {
          if (!pool.members.some((member) => member.accountId === account.id)) return [pool]
          const compatible = pool.kind === 'relay-aggregate'
            ? input.sourceType === 'relay' && pool.protocol === input.protocol
            : accountMatchesPoolProtocol(pool.protocol, account, provider)
              && pool.members.every((member) => {
                if (member.accountId === account.id) return true
                const memberAccount = nextAccounts.find((candidate) => candidate.id === member.accountId)
                const memberProvider = nextProviders.find((candidate) => candidate.id === memberAccount?.providerId)
                return Boolean(memberProvider) && providerSourceFamily(memberProvider!.kind) === providerSourceFamily(provider.kind)
              })
          if (compatible) return [pool]
          const members = pool.members.filter((member) => member.accountId !== account.id)
          if (!members.length || (pool.kind === 'relay-aggregate' && members.length < 2)) {
            deletedPoolIds.add(pool.id)
            return []
          }
          return [{ ...pool, members, updatedAt: timestamp }]
        })
        nextRoutes = nextRoutes.map((route) => detachMockRouteSources(route, deletedPoolIds, timestamp))
      }

      // Commit only after every validation and derived update has succeeded.
      snapshot.providers = nextProviders
      snapshot.accounts = nextAccounts
      snapshot.pools = nextPools
      snapshot.routes = nextRoutes
      reconcileMockPoolModels()
      return changed()
    },
    async probeApiSource(input) {
      await pause()
      const existing = input.id ? snapshot.providers.find((provider) => provider.id === input.id) : undefined
      const discoveredModels = defaultMockSourceModels(input.kind, input.protocol)
      const configuredModel = input.model?.trim() || existing?.models[0] || discoveredModels[0]
      const models = existing?.models.length
        ? [...existing.models]
        : configuredModel
          ? [configuredModel, ...discoveredModels.filter((model) => model !== configuredModel)]
          : discoveredModels
      if (mockSourceRequiresToolRoundtrip(input)) {
        const isKiro = input.protocol === 'kiro-claude'
        const bridgeName = isKiro ? 'Kiro Claude' : 'Claude'
        const result = {
          ok: false,
          stages: [
            { id: 'network' as const, status: 'success' as const, message: mockText('网络可达（示例数据）', 'Network reachable (sample data)'), latencyMs: 38 },
            { id: 'authentication' as const, status: 'warning' as const, message: mockText('浏览器 Mock 不会发送真实上游凭据', 'Browser mock never sends real upstream credentials') },
            isKiro
              ? { id: 'models' as const, status: 'skipped' as const, message: mockText('Kiro Claude 模型必须手动填写', 'Kiro Claude models must be entered manually') }
              : { id: 'models' as const, status: 'success' as const, message: mockText(`使用 ${models.length} 个示例模型`, `Using ${models.length} sample model(s)`) },
            { id: 'generation' as const, status: 'skipped' as const, message: mockText('未执行真实生成请求', 'No real generation request was made') },
            { id: 'tool-roundtrip' as const, status: 'error' as const, message: mockText(`Mock 模式不能证明 ${bridgeName} 两轮工具链；请在桌面版完成真实测试`, `Mock mode cannot prove the ${bridgeName} two-turn tool chain; run the real test in the desktop app`) },
          ],
          models,
          testedModel: configuredModel,
          latencyMs: 38,
          error: mockText(`${bridgeName} 工具链仍待验证`, `${bridgeName} tool-chain verification is still required`),
          warnings: [isKiro
            ? mockText('此来源可以保存为待验证，但不能绑定或加入聚合中转。', 'This source may be saved as pending verification, but cannot be bound or added to an aggregate relay.')
            : mockText('此来源可以保存，但聊天可用不代表结构化工具链已验证。', 'This source may be saved, but working chat does not prove the structured tool chain.')],
          capabilityProfile: { version: 1 as const, origin: 'inferred' as const, checkedAt: Date.now(), streaming: true, toolCalls: false, modelDiscovery: !isKiro },
          modelCatalog: [],
        }
        if (input.persistCapabilities && existing) {
          snapshot.providers = snapshot.providers.map((provider) => provider.id === existing.id
            ? { ...provider, capabilityProfile: result.capabilityProfile, toolRoundtripVerified: false, updatedAt: Date.now() }
            : provider)
          publish()
        }
        return result
      }

      const probeEvidenceToken = makeId('probe-evidence')
      apiSourceProbeEvidence.set(probeEvidenceToken, {
        fingerprint: mockProbeEvidenceFingerprint({ ...input, model: configuredModel }),
        expiresAt: Date.now() + 5 * 60_000,
      })
      return {
        ok: true,
        stages: [
          { id: 'network', status: 'success', message: mockText('网络可达（示例数据）', 'Network reachable (sample data)'), latencyMs: 38 },
          { id: 'authentication', status: 'success', message: mockText('凭据格式有效（示例数据）', 'Credential accepted (sample data)') },
          { id: 'models', status: 'success', message: mockText(`发现 ${models.length} 个模型`, `Discovered ${models.length} model(s)`) },
          { id: 'generation', status: 'success', message: mockText('生成测试通过（示例数据）', 'Generation test passed (sample data)'), latencyMs: 320 },
        ],
        models,
        testedModel: configuredModel,
        latencyMs: 358,
        warnings: [],
        capabilityProfile: { version: 1, origin: 'probed', checkedAt: Date.now(), streaming: true, toolCalls: true, modelDiscovery: true },
        modelCatalog: [],
        probeEvidenceToken,
      }
    },
    async previewRoute(input) {
      return buildRoutePreview(input, snapshot)
    },
    async deleteApiSource(id: string) {
      const provider = snapshot.providers.find((candidate) => candidate.id === id)
      if (!provider || provider.sourceType === 'oauth-system') throw new Error(mockText('API 来源不存在', 'The API source does not exist'))
      const accountIds = new Set(snapshot.accounts.filter((account) => account.providerId === id).map((account) => account.id))
      const deletedPoolIds = new Set<string>()
      snapshot.providers = snapshot.providers.filter((candidate) => candidate.id !== id)
      snapshot.accounts = snapshot.accounts.filter((account) => !accountIds.has(account.id))
      snapshot.pools = snapshot.pools.flatMap((pool) => {
        const members = pool.members.filter((member) => !accountIds.has(member.accountId))
        if (members.length === pool.members.length) return [pool]
        if (!members.length || (pool.kind === 'relay-aggregate' && members.length < 2)) {
          deletedPoolIds.add(pool.id)
          return []
        }
        return [{ ...pool, members, updatedAt: Date.now() }]
      })
      const timestamp = Date.now()
      snapshot.routes = snapshot.routes.map((route) => detachMockRouteSources(
        route,
        new Set([id, ...deletedPoolIds]),
        timestamp,
      ))
      return changed()
    },
    async saveAggregateRelay() {
      throw new Error('Aggregate relay mock is not implemented yet.')
    },
    async getSetupWizardState() {
      return setupWizardState ? clone(setupWizardState) : null
    },
    async saveSetupWizardProgress(input) {
      const timestamp = Date.now()
      const current = setupWizardState
      const next: SetupWizardState = {
        sessionId: input.sessionId ?? setupWizardState?.sessionId ?? makeId('setup'),
        step: input.step,
        completed: current?.completed ?? false,
        dismissed: false,
        sourceType: input.sourceType ?? current?.sourceType,
        sourceMethod: input.sourceMethod === null ? undefined : input.sourceMethod ?? current?.sourceMethod,
        sourceId: input.sourceId === null ? undefined : input.sourceId ?? current?.sourceId,
        tagId: input.tagId === null ? undefined : input.tagId ?? current?.tagId,
        poolId: input.poolId === null ? undefined : input.poolId ?? current?.poolId,
        routeId: input.routeId === null ? undefined : input.routeId ?? current?.routeId,
        client: input.client ?? current?.client,
        model: input.model ?? current?.model,
        proxyId: input.proxyId === null ? undefined : input.proxyId ?? current?.proxyId,
        lastError: input.lastError,
        verifiedAt: current?.completed || input.step === 'client-config' || input.step === 'complete'
          ? current?.verifiedAt
          : undefined,
        createdAt: setupWizardState?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      setupWizardState = next
      return clone(next)
    },
    async discardSetupWizard() {
      setupWizardState = null
    },
    async completeSetupWizard() {
      if (!setupWizardState?.verifiedAt) throw new Error(mockText('只有端到端真实请求成功后才能完成配置向导。', 'The setup wizard can be completed only after a real end-to-end request succeeds.'))
      setupWizardState = { ...setupWizardState, completed: true, step: 'complete', updatedAt: Date.now() }
    },
    async applySetupRouting(input) {
      const poolId = input.aggregatePoolId
        ?? snapshot.pools.find((pool) => pool.members.some((member) => member.accountId === input.sourceId))?.id
        ?? ''
      const routeId = snapshot.routes.find((route) => route.client === input.client)?.id ?? ''
      return { snapshot: localizeMockSnapshot(snapshot), poolId, routeId, createdPool: false }
    },
    async ensureGatewayRunning() {
      return {
        snapshot: localizeMockSnapshot(snapshot),
        host: snapshot.gateway.host,
        port: snapshot.gateway.port,
        changedPort: false,
        started: snapshot.gatewayStatus.running,
      }
    },
    async verifySetupRoute() {
      if (setupWizardState) {
        const timestamp = Date.now()
        setupWizardState = { ...setupWizardState, step: 'client-config', verifiedAt: timestamp, updatedAt: timestamp }
      }
      return { ok: true, latencyMs: 120, status: 200, responsePreview: 'OK' }
    },
    async setClientRouteSource(input) {
      if (input.client !== 'claude' && input.client !== 'codex' && input.client !== 'gemini' && input.client !== 'grokbuild') {
        throw new Error(mockText('不支持的客户端路由', 'Unsupported client route'))
      }
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
      if (!sourceId) throw new Error(mockText('请选择号池、官方 API 或中转站', 'Select a pool, official API, or relay'))
      if (hasRouteSourceIdCollision(sourceId, snapshot)) throw new Error(mockText('所选来源 ID 与现有号池 ID 冲突', 'The selected source ID conflicts with an existing pool ID'))
      const source = resolveRouteSource(sourceId, snapshot)
      if (!source) throw new Error(mockText('所选号池、官方 API 或中转站不存在', 'The selected pool, official API, or relay does not exist'))
      if (input.client === 'grokbuild' && !isNativeGrokRouteSource(source, snapshot)) {
        throw new Error(mockText('Grok Build 只能绑定原生 Responses 的 Grok 号池或中转来源', 'Grok Build can only use a Responses-native Grok pool or relay source'))
      }
      if (!source.accounts.some(isAvailableRouteAccount)) {
        throw new Error(mockText('所选来源没有可用账号', 'The selected source has no available accounts'))
      }
      const route = snapshot.routes.find((candidate) => candidate.client === input.client)
      if (!route) throw new Error(mockText('当前客户端路由不存在', 'The current client route does not exist'))
      snapshot.routes = snapshot.routes.map((candidate) => candidate.id === route.id
        ? { ...candidate, poolId: sourceId, updatedAt: Date.now() }
        : candidate)
      return changed()
    },
    async updateRoute(route: Route) {
      const existingRoute = snapshot.routes.find((candidate) => candidate.id === route.id)
      if (route.enabled && hasRouteSourceIdCollision(route.poolId, snapshot)) {
        throw new Error(mockText('所选源 ID 与号池 ID 冲突', 'The selected source ID conflicts with a pool ID'))
      }
      const source = resolveRouteSource(route.poolId, snapshot)
      if (route.client === 'grokbuild' && route.poolId && !isNativeGrokRouteSource(source, snapshot)) {
        throw new Error(mockText('Grok Build 只能绑定原生 Responses 的 Grok 号池或中转来源', 'Grok Build can only use a Responses-native Grok pool or relay source'))
      }
      if (route.enabled && !source) throw new Error(mockText('请选择现有号池、官方 API 或中转站', 'Select an existing pool, official API, or relay'))
      if (route.enabled && source?.provider && !source.accounts.some(isAvailableRouteAccount)) {
        throw new Error(mockText('所选 API 来源没有可用账号', 'The selected API source has no available accounts'))
      }
      const modelSourceMap = normalizeRouteModelSourceMap(
        route.modelSourceMap === undefined ? existingRoute?.modelSourceMap : route.modelSourceMap,
      )
      if (route.client !== 'codex' && Object.keys(modelSourceMap).length) {
        throw new Error(mockText('只有 Codex 路由支持按模型选择来源', 'Only Codex routes support per-model sources'))
      }
      for (const sourceId of new Set(Object.values(modelSourceMap))) {
        const modelSource = resolveRouteSource(sourceId, snapshot)
        if (!modelSource) throw new Error(mockText('模型分流来源不存在', 'A model-routing source does not exist'))
      }
      snapshot.routes = snapshot.routes.map((item) => (item.id === route.id ? {
        ...route,
        modelSourceMap,
        highConcurrencyMode: route.highConcurrencyMode === true,
        updatedAt: Date.now()
      } : item))
      return changed()
    },
    async updateGateway(settings: GatewaySettings) {
      snapshot.gateway = { ...settings }
      snapshot.gatewayStatus = { ...snapshot.gatewayStatus, host: settings.host, port: settings.port }
      return changed()
    },
    async startGateway() {
      snapshot.gatewayStatus = {
        ...snapshot.gatewayStatus,
        running: true,
        host: snapshot.gateway.host,
        port: snapshot.gateway.port,
        startedAt: Date.now(),
      }
      return changed()
    },
    async stopGateway() {
      snapshot.gatewayStatus = { ...snapshot.gatewayStatus, running: false, activeRequests: 0, startedAt: undefined }
      return changed()
    },
    async rebuildOutboundConnections() {},
    async detectSystemProxy() {
      return {
        detectedAt: Date.now(),
        targets: [
          { target: 'https://chatgpt.com', summary: 'DIRECT', reachable: true, latencyMs: 120 },
          { target: 'https://api.openai.com', summary: 'DIRECT', reachable: true, latencyMs: 135 }
        ]
      }
    },
    async runNetworkDiagnostics(input = {}) {
      await pause(700)
      const startedAt = Date.now() - 680
      const proxy = input.proxyId ? snapshot.proxies.find((candidate) => candidate.id === input.proxyId) : undefined
      const usingProxy = Boolean(proxy)
      return {
        startedAt,
        finishedAt: Date.now(),
        route: usingProxy
          ? { kind: 'proxy' as const, name: proxy!.name, proxyId: proxy!.id }
          : { kind: 'direct' as const, name: mockText('直连', 'Direct') },
        summary: 'success' as const,
        results: [
          { id: 'dns-chatgpt', label: mockText('DNS 解析', 'DNS resolution'), target: 'chatgpt.com', kind: 'dns' as const, status: usingProxy ? 'skipped' as const : 'success' as const, latencyMs: usingProxy ? 0 : 18, message: usingProxy ? mockText('代理模式下由代理节点处理域名解析。', 'The proxy resolves domain names in proxy mode.') : mockText('已解析 2 个地址', 'Resolved 2 addresses'), addresses: usingProxy ? undefined : ['104.18.32.47', '172.64.155.209'] },
          { id: 'tls-chatgpt', label: mockText('TLS 握手', 'TLS handshake'), target: 'chatgpt.com:443', kind: 'tls' as const, status: usingProxy ? 'skipped' as const : 'success' as const, latencyMs: usingProxy ? 0 : 96, message: usingProxy ? mockText('代理模式下由代理链路建立目标连接。', 'The proxy establishes the target connection in proxy mode.') : mockText('握手成功 · TLSv1.3', 'Handshake succeeded · TLSv1.3') },
          { id: 'chatgpt-web', label: mockText('ChatGPT 网站', 'ChatGPT website'), target: 'chatgpt.com/', kind: 'http' as const, status: 'success' as const, latencyMs: 182, httpStatus: 200, message: mockText('连接成功 · HTTP 200', 'Connected · HTTP 200') },
          { id: 'codex-models', label: mockText('Codex 模型接口', 'Codex models endpoint'), target: 'chatgpt.com/backend-api/codex/models', kind: 'http' as const, status: 'success' as const, latencyMs: 224, httpStatus: 401, message: mockText('接口可达 · 未携带账号凭据，HTTP 401 属预期响应', 'Endpoint reachable · HTTP 401 is expected without account credentials') },
          { id: 'codex-usage', label: mockText('Codex 额度接口', 'Codex quota endpoint'), target: 'chatgpt.com/backend-api/wham/usage', kind: 'http' as const, status: 'success' as const, latencyMs: 238, httpStatus: 401, message: mockText('接口可达 · 未携带账号凭据，HTTP 401 属预期响应', 'Endpoint reachable · HTTP 401 is expected without account credentials') },
          { id: 'openai-auth', label: 'OpenAI OAuth', target: 'auth.openai.com/.well-known/openid-configuration', kind: 'http' as const, status: 'success' as const, latencyMs: 194, httpStatus: 200, message: mockText('连接成功 · HTTP 200', 'Connected · HTTP 200') },
        ],
        diagnoses: [mockText(
          '基础网络链路正常。若账号请求仍失败，优先检查凭据有效期、账号权限、额度和模型访问资格。',
          'The basic network path is healthy. If account requests still fail, check credential expiry, account permissions, quota, and model access first.',
        )]
      }
    },
    async checkAccount(id: string) {
      snapshot.accounts = snapshot.accounts.map((account) =>
        account.id === id ? { ...account, status: 'checking', updatedAt: Date.now() } : account,
      )
      publish()
      await pause(650)
      snapshot.accounts = snapshot.accounts.map((account) =>
        account.id === id
          ? { ...account, status: 'active', latencyMs: 420 + Math.round(Math.random() * 760), lastError: undefined, cooldownUntil: undefined }
          : account,
      )
      return publish()
    },
    async refreshAccountCodexQuota(id: string) {
      const observedAt = Date.now()
      snapshot.accounts = snapshot.accounts.map((account) => account.id === id ? {
        ...account,
        codexQuota: {
          fiveHour: { usedPercent: 42, windowSeconds: 18_000, resetAt: observedAt + 2 * 60 * 60 * 1000 },
          sevenDay: { usedPercent: 68, windowSeconds: 604_800, resetAt: observedAt + 3 * 24 * 60 * 60 * 1000 },
          observedAt,
          source: 'usage-endpoint',
          allowed: true,
          limitReached: false,
        },
      } : account)
      return changed()
    },
    async getAccountCodexQuotaHistory(id, from, to) {
      const account = snapshot.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new Error(mockText('账号不存在', 'Account not found'))
      const end = to ?? Date.now()
      const start = from ?? end - 14 * 24 * 60 * 60 * 1000
      return Array.from({ length: 56 }, (_, index) => {
        const observedAt = start + (end - start) * index / 55
        return {
          accountId: id,
          observedAt,
          fiveHourUsedPercent: Math.max(4, Math.min(96, 18 + (index % 15) * 5.2)),
          fiveHourResetAt: observedAt + 2 * 60 * 60 * 1000,
          sevenDayUsedPercent: Math.max(10, Math.min(92, 30 + index * 0.7)),
          sevenDayResetAt: observedAt + 3 * 24 * 60 * 60 * 1000,
          source: 'response-headers' as const,
        }
      })
    },
    async getAccountCodexQuotaCycleCosts(id) {
      if (!snapshot.accounts.some((candidate) => candidate.id === id)) throw new Error(mockText('账号不存在', 'Account not found'))
      return {
        fiveHourUsd: 12.486,
        sevenDayUsd: 184.32,
        fiveHourUnpricedUsdTokens: 0,
        sevenDayUnpricedUsdTokens: 0,
        fiveHourCredits: 312.15,
        sevenDayCredits: 4_608,
        fiveHourUnpricedCreditTokens: 0,
        sevenDayUnpricedCreditTokens: 0
      }
    },
    async clearLogs() {
      snapshot.requestLogs = []
      return changed()
    },
    async getRequestReplayTemplate() {
      return null
    },
    async replayRequest() {
      throw new Error(mockText('开发预览没有可回放的内存请求', 'No memory-only replay is available in the development preview'))
    },
    async getLocalEventServerStatus() {
      return {
        running: true,
        address: 'ws://127.0.0.1:15741/events',
        discoveryFile: '~/.stone/event-server.json',
        authentication: 'bearer-token' as const,
        connectedClients: 0,
        startedAt: Date.now()
      }
    },
    async clearHealthEvents() {
      snapshot.healthEvents = []
      return changed()
    },
    async saveClientProfile(input) {
      const existing = snapshot.clientProfiles.find((profile) => profile.id === input.id)
      if (input.id && !existing) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      if (existing?.isDefault) throw new Error(mockText('默认客户端 Profile 不可编辑', 'The default client profile cannot be edited'))
      if (existing && existing.client !== input.client) throw new Error(mockText('已有 Profile 的客户端不可修改', 'The client of an existing profile cannot be changed'))
      const timestamp = Date.now()
      const profile = {
        id: existing?.id ?? makeId('client-profile'),
        name: input.name,
        client: existing?.client ?? input.client,
        directory: input.directory || undefined,
        backupRetention: input.backupRetention,
        isDefault: false,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      if (existing) snapshot.clientProfiles = snapshot.clientProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      else snapshot.clientProfiles.push(profile)
      return changed()
    },
    async deleteClientProfile(id) {
      snapshot.clientProfiles = snapshot.clientProfiles.filter((profile) => profile.id !== id || profile.isDefault)
      return changed()
    },
    async exportClientProfile(id) {
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === id)
      if (!profile) throw new Error('Profile not found')
      return { format: 'stone-client-profile', version: 1, profile: { name: profile.name, client: profile.client, directory: profile.directory, backupRetention: profile.backupRetention } }
    },
    async importClientProfile(bundle) {
      const client = bundle.profile.client
      if (client !== 'claude' && client !== 'codex' && client !== 'gemini' && client !== 'grokbuild') {
        throw new Error(mockText('不支持的客户端配置 Profile', 'Unsupported client configuration profile'))
      }
      return this.saveClientProfile(bundle.profile)
    },
    async getClientConfigs(profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      const clients = Object.keys(mockClientFiles) as RouteClient[]
      return clients.map((client): ClientConfigStatus => ({
        client,
        directory: profile?.client === client && profile.directory
          ? profile.directory
          : `~/.${client === 'grokbuild' ? 'grok' : client}`,
        directoryExists: client !== 'gemini',
        configured: client !== 'gemini',
        files: mockClientFiles[client].map((file) => ({
          ...file,
          exists: client !== 'gemini',
          modifiedAt: client !== 'gemini' ? now - 3_600_000 : undefined,
          size: client !== 'gemini' ? 320 : undefined,
        })),
        backupCount: clientBackups.filter((backup) => backup.client === client).length,
        lastBackupAt: clientBackups.find((backup) => backup.client === client)?.createdAt,
      }))
    },
    async chooseClientConfigDirectory(client) {
      return `C:\\Users\\Demo\\.${client === 'grokbuild' ? 'grok' : client}-custom`
    },
    async previewClientConfig(client, profileId) {
      await pause()
      return {
        client,
        profileId: profileId ?? `default-${client}`,
        files: mockClientFiles[client].map((file) => ({
          ...file,
          existed: client !== 'gemini',
          changed: client === 'gemini',
          managedFields: [mockText('Stone+ 管理字段', 'Stone+ managed field')],
        })),
      }
    },
    async applyClientConfig(client) {
      await pause()
      const createdAt = Date.now()
      const groupId = `${createdAt}:0`
      const backups = mockClientFiles[client].filter(() => client !== 'gemini').map((file, index): ClientConfigBackup => ({
        client,
        role: file.role,
        targetPath: file.path,
        backupPath: `${file.path}.stone-backup.${createdAt}.${index}`,
        groupId,
        createdAt,
        size: 320,
      }))
      clientBackups.unshift(...backups)
      return { client, changedFiles: mockClientFiles[client].map((file) => file.path), backups, removedBackups: [] }
    },
    async repairClientConfig(client, profileId) {
      const result = await this.applyClientConfig(client, profileId)
      return { ...result, rebuiltRoles: [] }
    },
    async restoreCodexOfficialLoginAndSessions(profileId) {
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      if (profile && profile.client !== 'codex') throw new Error(mockText('客户端配置 Profile 与 Codex 不匹配', 'The client configuration profile does not match Codex'))
      const clientConfig = await this.applyClientConfig('codex', profileId)
      const repair = await this.repairCodexSessions('openai', 'a'.repeat(64))
      return {
        clientConfig,
        repair,
        chatGptWasRunning: true,
        chatGptRestarted: true,
      }
    },
    async listClientConfigBackups(client) {
      await pause()
      return clone(clientBackups.filter((backup) => backup.client === client))
    },
    async createClientConfigBackup(client) {
      await pause()
      const createdAt = Date.now()
      const groupId = `${createdAt}:0`
      const backups = mockClientFiles[client].map((file, index): ClientConfigBackup => ({
        client,
        role: file.role,
        targetPath: file.path,
        backupPath: `${file.path}.stone-backup.${createdAt}.${index}`,
        groupId,
        createdAt,
        size: 320,
      }))
      clientBackups.unshift(...backups)
      return { client, groupId, createdAt, backups: clone(backups), removedBackups: [] }
    },
    async restoreLatestClientConfigBackup(client, profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      const latest = clientBackups.find((candidate) => candidate.client === client)
      if (!latest) throw new Error(mockText('暂无可恢复备份', 'No restorable backup is available'))
      const sourceBackups = clientBackups.filter((candidate) => candidate.client === client && candidate.groupId === latest.groupId)
      return { client, groupId: latest.groupId, createdAt: latest.createdAt, restoredFiles: sourceBackups.map((item) => item.targetPath), sourceBackups: clone(sourceBackups) }
    },
    async restoreClientConfigBackupSet(groupId, client, profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      const sourceBackups = clientBackups.filter((candidate) => candidate.client === client && candidate.groupId === groupId)
      if (!sourceBackups.length) throw new Error(mockText('备份组不存在', 'The backup set does not exist'))
      return { client, groupId, createdAt: sourceBackups[0].createdAt, restoredFiles: sourceBackups.map((item) => item.targetPath), sourceBackups: clone(sourceBackups) }
    },
    async restoreClientConfig(backupPath, client, profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      if (profile && profile.client !== client) throw new Error(mockText('客户端配置 Profile 与客户端不匹配', 'The client configuration profile does not match the client'))
      const backup = clientBackups.find((candidate) => candidate.backupPath === backupPath)
      if (!backup) throw new Error(mockText('备份不存在', 'The backup does not exist'))
      if (backup.client !== client) throw new Error(mockText('备份不属于所选客户端', 'The backup does not belong to the selected client'))
      return {
        client: backup.client,
        role: backup.role,
        restoredFile: backup.targetPath,
        sourceBackup: backup.backupPath,
      }
    },
    async getClientConfigEditor(client, profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error(mockText('客户端配置 Profile 不存在', 'The client configuration profile does not exist'))
      if (profile && profile.client !== client) throw new Error(mockText('客户端配置 Profile 与客户端不匹配', 'The client configuration profile does not match the client'))
      return {
        client,
        profileId: profile?.id ?? `default-${client}`,
        fields: clone(mockEditorFields[client]),
        files: mockClientFiles[client].map((file) => {
          const content = mockEditorContent[client][file.role]
          const editable = file.role !== 'codex-auth' && file.role !== 'codex-model-catalog'
          return {
            role: file.role,
            path: file.path,
            format: mockConfigFormat(file.role),
            exists: content !== undefined || client !== 'gemini',
            editable,
            containsCredential: file.containsCredential,
            ...(content !== undefined || editable ? { content: content ?? (mockConfigFormat(file.role) === 'json' ? '{}\n' : '') } : {}),
            revision: `mock-${client}-${file.role}`,
            protectedValueCount: 0,
          }
        }),
      }
    },
    async openClientConfigFile() {},
    async saveClientConfigEditor(input) {
      await pause()
      const changedFiles = new Set<string>()
      for (const draft of input.files) {
        mockEditorContent[input.client][draft.role] = draft.content
        const file = mockClientFiles[input.client].find((candidate) => candidate.role === draft.role)
        if (file) changedFiles.add(file.path)
      }
      const tomlPatches: Array<{ path: string[]; value: ClientConfigEditorState['fields'][number]['value'] }> = []
      for (const patch of input.patches) {
        const field = mockEditorFields[input.client].find((candidate) => candidate.id === patch.id)
        if (!field || field.readOnly) continue
        field.value = clone(patch.value)
        if ((input.client === 'codex' && field.role === 'codex-config')
          || (input.client === 'grokbuild' && field.role === 'grok-config')) {
          tomlPatches.push({ path: field.path, value: patch.value })
        }
      }
      if (tomlPatches.length && input.client === 'codex') {
        mockEditorContent.codex['codex-config'] = patchCodexTomlPaths(
          mockEditorContent.codex['codex-config'],
          tomlPatches,
        ).content
      }
      if (tomlPatches.length && input.client === 'grokbuild') {
        mockEditorContent.grokbuild['grok-config'] = patchCodexTomlPaths(
          mockEditorContent.grokbuild['grok-config'],
          tomlPatches,
        ).content
      }
      if (input.patches.length) changedFiles.add(mockClientFiles[input.client][0].path)
      return { client: input.client, changedFiles: [...changedFiles], backups: [], removedBackups: [] }
    },
    async listManagedClientInstances() { return [] },
    async saveManagedClientInstance() { return [] },
    async deleteManagedClientInstance() { return [] },
    async startManagedClientInstance() { return [] },
    async stopManagedClientInstance() { return [] },
    onManagedClientInstancesChanged() { return () => undefined },
    async getAgentLifecycleSnapshot() { return clone(agentLifecycleSnapshot) },
    async installAgent(target) { return mockAgentOperation('install', [target], false) },
    async closeAgent(target) { return mockAgentOperation('close', [target], false) },
    async restoreAgent(target) { return mockAgentOperation('restore', [target], agentLifecycleSnapshot.agents[target].running) },
    async restartAgent(target) { return mockAgentOperation('restart', [target], true) },
    async startAgent(target) { return mockAgentOperation('start', [target], true) },
    async smartRepairAgent(target) { return mockAgentOperation('smart-repair', target ? [target] : [...AGENT_TARGETS], true) },
    async repairAllAffectedAgents() { return mockAgentOperation('repair-all-affected', [...AGENT_TARGETS], true) },
    async closeAllManagedAgents() { return mockAgentOperation('close-all-managed', [...AGENT_TARGETS], false) },
    async restoreClaudeDesktopOfficialMode() { return { changed: false } },
    onAgentLifecycleChanged(listener) {
      agentLifecycleListeners.add(listener)
      return () => agentLifecycleListeners.delete(listener)
    },
    async listPersistentTasks() { return [] },
    async pausePersistentTask() { throw new Error('Persistent task not found.') },
    async resumePersistentTask() { throw new Error('Persistent task not found.') },
    async waitForPersistentTask() { throw new Error('Persistent task not found.') },
    async cancelPersistentTask() { throw new Error('Persistent task not found.') },
    async clearPersistentTasks() { return [] },
    async startAccountCheckTask() { throw new Error('Persistent tasks are unavailable in mock mode.') },
    async listStateBackups() { return [] },
    async getAutomaticBackupRuntimeState() {
      const configuredEnabled = snapshot.gateway.automaticBackups !== false
      return { configuredEnabled, running: configuredEnabled, blocked: false }
    },
    async createStateBackup() { return {} },
    async verifyStateBackup(path) { return { path, createdAt: Date.now(), size: 0, integrity: 'valid', automatic: false } },
    async restoreStateBackup(path) { return { restored: { path, createdAt: Date.now(), size: 0, integrity: 'valid', automatic: false }, restartRequired: true } },
    async exportPortableStateBackup() { return { cancelled: false, path: 'C:\\Users\\demo\\Documents\\StonePlus-state.stonebackup' } },
    async importPortableStateBackup() { return { cancelled: false, path: 'C:\\Users\\demo\\Documents\\StonePlus-state.stonebackup' } },
    async getWebDavBackupConfiguration() { return { ...webDavConfiguration } },
    async saveWebDavBackupConfiguration(input) {
      webDavConfiguration = {
        baseUrl: input.baseUrl,
        username: input.username ?? '',
        hasPassword: Boolean(input.password) || (webDavConfiguration.hasPassword && !input.clearPassword),
        configured: Boolean(input.baseUrl),
      }
      return { ...webDavConfiguration }
    },
    async clearWebDavBackupConfiguration() {
      webDavConfiguration = { baseUrl: '', username: '', hasPassword: false, configured: false }
      return { ...webDavConfiguration }
    },
    async testWebDavBackup() {},
    async listWebDavBackups() { return [] },
    async uploadLatestWebDavBackup() { throw new Error('WebDAV backup is unavailable in browser preview.') },
    async downloadWebDavBackup() { throw new Error('WebDAV backup is unavailable in browser preview.') },
    async getDesktopRuntimeSettings() { return { launchAtLogin: false, supported: false } },
    async updateDesktopRuntimeSettings() { return { launchAtLogin: false, supported: false } },
    async exportDiagnostics() { return JSON.stringify({ version: __APP_VERSION__, platform: 'browser-preview' }, null, 2) },
    async getUpdateState() { return clone(updateState) },
    async checkForUpdates() {
      publishUpdate({ status: 'checking', error: undefined, checkedAt: Date.now() })
      await pause(360)
      return publishUpdate({
        status: 'available',
        checkedAt: Date.now(),
        error: undefined,
        progress: undefined,
        release: {
          version: '9.9.9',
          tagName: 'v9.9.9',
          title: mockText('Stone+ 更新流程预览', 'Stone+ update flow preview'),
          publishedAt: new Date().toISOString(),
          url: 'https://github.com/M4rkzzz/stone-plus/releases/latest',
          notes: mockUsesChinese() ? [
            '- 品牌标识旁新增绿色“更新”提醒，不再打断当前操作。',
            '- 点击提醒即可查看本次 Release 的核心亮点。',
            '- 确认更新后自动下载、校验并覆盖安装。',
            '- 安装完成后自动重新启动 Stone+。',
          ].join('\n') : [
            '- A green “Update” indicator appears beside the brand without interrupting your work.',
            '- Select the indicator to view the highlights of this release.',
            '- After confirmation, Stone+ automatically downloads, verifies, and installs the update.',
            '- Stone+ restarts automatically after installation.',
          ].join('\n'),
        },
      })
    },
    async ignoreUpdate(version) {
      await pause()
      return publishUpdate({ ignoredVersion: version })
    },
    async downloadUpdate() {
      publishUpdate({
        status: 'downloading',
        error: undefined,
        progress: { percent: 0, transferred: 0, total: 92 * 1024 * 1024, bytesPerSecond: 0 },
      })
      for (const percent of [18, 47, 76, 100]) {
        await pause(180)
        publishUpdate({
          status: 'downloading',
          progress: {
            percent,
            transferred: Math.round(92 * 1024 * 1024 * percent / 100),
            total: 92 * 1024 * 1024,
            bytesPerSecond: 8.4 * 1024 * 1024,
          },
        })
      }
      return publishUpdate({ status: 'downloaded', progress: undefined })
    },
    async installUpdate() {
      publishUpdate({ status: 'installing', error: undefined })
    },
    async openUpdatePage() { await pause(80) },
    async openProjectPage() { await pause(40) },
    async getFrpTunnelState() { return clone(frpTunnelState) },
    async saveFrpTunnelConfig(content) {
      frpTunnelState = { ...frpTunnelState, config: content, configSaved: Boolean(content.trim()), lastError: undefined }
      return clone(frpTunnelState)
    },
    async startFrpTunnel() {
      frpTunnelState = { ...frpTunnelState, running: true, pid: 14521, startedAt: Date.now(), remoteAddress: 'http://frps.example.com:15721/v1', serverAddress: 'frps.example.com', remotePort: 15721, logs: [...frpTunnelState.logs, '[12:00:00] frpc started.'] }
      return clone(frpTunnelState)
    },
    async stopFrpTunnel() {
      frpTunnelState = { ...frpTunnelState, running: false, pid: undefined, startedAt: undefined, logs: [...frpTunnelState.logs, '[12:01:00] frpc stopped.'] }
      return clone(frpTunnelState)
    },
    async clearFrpTunnelLogs() {
      frpTunnelState = { ...frpTunnelState, logs: [] }
      return clone(frpTunnelState)
    },
    async inspectCodexSessionRepair() {
      return {
        codexHome: 'C:\\Users\\demo\\.codex',
        currentProvider: 'stone',
        targets: [
          { id: 'stone', sources: ['config', 'rollout', 'sqlite'], isCurrentProvider: true },
          { id: 'openai', sources: ['config', 'rollout', 'sqlite'], isCurrentProvider: false },
        ],
        sessionFiles: 44,
        archivedSessionFiles: 64,
        indexedThreads: 107,
        sqliteDatabases: ['C:\\Users\\demo\\.codex\\state_5.sqlite'],
        skippedFiles: [],
      }
    },
    async analyzeCodexSessionRepair(targetProvider = 'stone', operationId) {
      if (operationId) {
        activeSessionRepairOperations.add(operationId)
        sessionRepairProgressListeners.forEach((listener) => listener({ operationId, stage: 'discover', completed: 0 }))
        await pause(80)
        if (cancelledSessionRepairOperations.has(operationId)) {
          activeSessionRepairOperations.delete(operationId)
          cancelledSessionRepairOperations.delete(operationId)
          throw mockSessionRepairCancelled()
        }
        sessionRepairProgressListeners.forEach((listener) => listener({ operationId, stage: 'scan', completed: 54, total: 108 }))
        await pause(80)
        if (cancelledSessionRepairOperations.has(operationId)) {
          activeSessionRepairOperations.delete(operationId)
          cancelledSessionRepairOperations.delete(operationId)
          throw mockSessionRepairCancelled()
        }
        sessionRepairProgressListeners.forEach((listener) => listener({ operationId, stage: 'scan', completed: 108, total: 108 }))
        activeSessionRepairOperations.delete(operationId)
        cancelledSessionRepairOperations.delete(operationId)
      }
      return {
        ...(await this.inspectCodexSessionRepair()),
        targetProvider,
        revision: 'a'.repeat(64),
        rolloutFilesToUpdate: targetProvider === 'stone' ? 18 : 90,
        rolloutFilesWithSessionMeta: 108,
        rolloutFilesWithoutSessionMeta: 0,
        rolloutFilesAlreadyTargetProvider: targetProvider === 'stone' ? 90 : 18,
        sqliteProviderRowsToUpdate: targetProvider === 'stone' ? 21 : 86,
        sqliteModelRowsToUpdate: 0,
        sqliteUserEventRowsToUpdate: 2,
        sqliteCwdRowsToUpdate: 3,
        globalStateFieldsToUpdate: 2,
        globalStateConflictingFields: [],
        encryptedSessionFiles: 1,
        encryptedSourceProviders: ['openai'],
      }
    },
    async previewCodexSessionRepair(targetProvider, operationId) {
      return this.analyzeCodexSessionRepair(targetProvider, operationId)
    },
    async repairCodexSessions(targetProvider, _expectedRevision, operationId) {
      if (operationId) activeSessionRepairOperations.add(operationId)
      for (const [stage, completed, total] of [
        ['discover', 108, 108],
        ['scan', 108, 108],
        ['verify', 18, 18],
        ['backup', 24, 24],
        ['apply', 26, 26],
      ] as const) {
        if (operationId) sessionRepairProgressListeners.forEach((listener) => listener({ operationId, stage, completed, total }))
        await pause(80)
        if (operationId && cancelledSessionRepairOperations.has(operationId)) {
          activeSessionRepairOperations.delete(operationId)
          cancelledSessionRepairOperations.delete(operationId)
          throw mockSessionRepairCancelled()
        }
      }
      if (operationId) {
        activeSessionRepairOperations.delete(operationId)
        cancelledSessionRepairOperations.delete(operationId)
      }
      return {
        targetProvider,
        repairedRolloutFiles: 18,
        sqliteProviderRowsUpdated: 21,
        sqliteModelRowsUpdated: 0,
        sqliteUserEventRowsUpdated: 2,
        sqliteCwdRowsUpdated: 3,
        globalStateFieldsUpdated: 2,
        globalStateConflictingFields: [],
        skippedFiles: [],
        encryptedSessionFiles: 1,
        encryptedSourceProviders: ['openai'],
        backupPath: 'C:\\Users\\demo\\.codex\\backups_state\\stone-session-repair\\20260718210000000-demo',
      }
    },
    async repairCodexSessionsAndRestartChatGpt(targetProvider = 'stone', expectedRevision = 'a'.repeat(64), operationId) {
      const repair = await this.repairCodexSessions(targetProvider, expectedRevision, operationId)
      return { repair, chatGptWasRunning: true, chatGptRestarted: true }
    },
    async cancelCodexSessionRepair(operationId) {
      if (!activeSessionRepairOperations.has(operationId)) return false
      cancelledSessionRepairOperations.add(operationId)
      return true
    },
    onCodexSessionRepairProgress(listener) {
      sessionRepairProgressListeners.add(listener)
      return () => sessionRepairProgressListeners.delete(listener)
    },
    async previewCodexSessionIndexCleanup() {
      return {
        snapshotSha256: 'b'.repeat(64),
        candidates: [
          { id: '0197f80d-1111-7000-8000-000000000001', threadName: '旧的测试任务', updatedAt: '2026-07-08T10:20:00Z' },
          { id: '0197f80d-2222-7000-8000-000000000002', threadName: '可能仍在云端', updatedAt: '2026-07-09T09:12:00Z' },
        ],
      }
    },
    async cleanupCodexSessionIndexAndRestart(_snapshotSha256, threadIds) {
      await pause(420)
      return {
        cleanup: {
          prunedEntries: threadIds.length,
          backupPath: 'C:\\Users\\demo\\.codex\\backups_state\\stone-session-index-cleanup\\20260718210000000-demo',
        },
        chatGptWasRunning: true,
        chatGptRestarted: true,
      }
    },
    async listCodexSessions() { return [] },
    async openCodexSessionLocation() {},
    async exportCodexSession(id) { return { cancelled: true, sessionId: id } },
    async trashCodexSession() { return [] },
    async restoreCodexSession() { return [] },
    onSnapshot(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onBuiltInProxyState(listener) {
      builtInProxyListeners.add(listener)
      return () => builtInProxyListeners.delete(listener)
    },
    onRuntimeDelta() {
      return () => undefined
    },
    onAccountImportProgress(listener) {
      accountImportProgressListeners.add(listener)
      return () => accountImportProgressListeners.delete(listener)
    },
    onBrowserImportQueue(listener) {
      browserImportListeners.add(listener)
      return () => browserImportListeners.delete(listener)
    },
    onBrowserOpenTab() {
      return () => undefined
    },
    onUpdateState(listener) {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
  }
}
