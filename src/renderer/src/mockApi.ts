import type {
  AccountInput,
  AppSnapshot,
  AppUpdateState,
  ClientConfigBackup,
  ClientConfigEditorState,
  ClientConfigFileRole,
  ClientConfigStatus,
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
  RequestLog,
  Route,
  RouteClient,
} from '@shared/types'
import { buildPoolModelCoverage, pruneModelSelection } from './model-policy'

const STORAGE_KEY = 'stone.browser-mock.v2'
const now = Date.now()

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
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-chat',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
    color: '#5b63d3',
    createdAt: now - 1000 * 60 * 60 * 24 * 9,
    updatedAt: now - 1000 * 60 * 34,
  },
  {
    id: 'provider-google',
    name: 'Google AI Studio',
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
]

const routes: Route[] = [
  {
    id: 'route-claude',
    client: 'claude',
    enabled: true,
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
    poolId: 'pool-codex',
    inboundProtocol: 'openai-responses',
    modelMap: { 'gpt-5-codex': 'gpt-5', 'gpt-5-mini': 'gpt-5-mini' },
    localToken: 'stone_codex_dev_3b21e8',
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 26,
  },
  {
    id: 'route-gemini',
    client: 'gemini',
    enabled: false,
    poolId: 'pool-gemini',
    inboundProtocol: 'gemini',
    modelMap: {},
    localToken: 'stone_gemini_dev_91c47f',
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 60,
  },
]

const logs: RequestLog[] = [
  ['req-01', 22, 'codex', 'openai-responses', 'OpenAI Platform', 'OpenAI 主账号', 'gpt-5', 'streaming', 200, 1280, 4812, 0],
  ['req-02', 68, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 主账号', 'claude-sonnet-4', 'success', 200, 2384, 9204, 1837],
  ['req-03', 194, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 备用', 'claude-sonnet-4', 'error', 429, 312, 1240, 0],
  ['req-04', 285, 'gemini', 'gemini', 'Google AI Studio', 'Gemini 开发', 'gemini-2.5-pro', 'success', 200, 1748, 6240, 2210],
  ['req-05', 460, 'codex', 'openai-responses', 'OpenRouter', 'OpenRouter 日常', 'openai/gpt-5-mini', 'success', 200, 936, 3174, 894],
  ['req-06', 725, 'claude', 'anthropic-messages', 'Anthropic', 'Claude 主账号', 'claude-opus-4-1', 'success', 200, 4421, 12140, 3352],
  ['req-07', 1160, 'codex', 'openai-responses', 'OpenAI Platform', 'OpenAI 主账号', 'gpt-5', 'success', 200, 2156, 8051, 1620],
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
    conversationName: client === 'codex' ? `Stone 开发对话 ${id.slice(-2)}` : `${clientNamesForMock(client)} 会话 ${id.slice(-2)}`,
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
    outputTokens,
    error: status === 'error' ? (statusCode === 429 ? '上游请求频率受限' : '上游连接超时') : undefined,
  }
})

function clientNamesForMock(client: RequestLog['client']): string {
  if (client === 'claude') return 'Claude'
  if (client === 'gemini') return 'Gemini'
  return 'Codex'
}

const initialSnapshot: AppSnapshot = {
  providers,
  accounts,
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
  clientProfiles: (['claude', 'codex', 'gemini'] as const).map((client) => ({
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
    const generationDurationMs = log.firstTokenMs === undefined ? log.latencyMs : log.latencyMs - log.firstTokenMs
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
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
const pause = (duration = 140) => new Promise((resolve) => window.setTimeout(resolve, duration))

const mockClientFiles: Record<RouteClient, Array<{ role: ClientConfigFileRole; path: string; containsCredential: boolean }>> = {
  claude: [
    { role: 'claude-settings', path: '~/.claude/settings.json', containsCredential: true },
    { role: 'claude-mcp', path: '~/.claude.json', containsCredential: true },
  ],
  codex: [
    { role: 'codex-config', path: '~/.codex/config.toml', containsCredential: false },
    { role: 'codex-auth', path: '~/.codex/auth.json', containsCredential: true },
  ],
  gemini: [
    { role: 'gemini-settings', path: '~/.gemini/settings.json', containsCredential: false },
    { role: 'gemini-env', path: '~/.gemini/.env', containsCredential: true },
  ],
}

const mockEditorContent: Record<RouteClient, Partial<Record<ClientConfigFileRole, string>>> = {
  claude: {
    'claude-settings': '{\n  "model": "claude-sonnet-4-5",\n  "effortLevel": "high",\n  "permissions": {\n    "defaultMode": "default",\n    "allow": ["Read", "Grep"]\n  },\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "__STONE_PROTECTED_VALUE__"\n  }\n}\n',
    'claude-mcp': '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem"]\n    }\n  }\n}\n',
  },
  codex: { 'codex-config': 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n' },
  gemini: { 'gemini-settings': '{\n  "model": { "name": "gemini-2.5-pro" },\n  "general": { "defaultApprovalMode": "default" },\n  "ui": { "theme": "Default" }\n}\n', 'gemini-env': 'GEMINI_API_KEY="__STONE_PROTECTED_VALUE__"\nGOOGLE_GEMINI_BASE_URL="__STONE_PROTECTED_VALUE__"\n' },
}

const mockEditorFields: Record<RouteClient, ClientConfigEditorState['fields']> = {
  claude: [
    { id: 'claude.model', section: '模型', label: '默认模型', control: 'text', value: 'claude-sonnet-4-5' },
    { id: 'claude.effort', section: '模型', label: '推理强度', control: 'select', value: 'high', options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '最高' }] },
    { id: 'claude.permissionMode', section: '权限', label: '默认权限模式', control: 'select', value: 'default', options: [{ value: 'default', label: '默认' }, { value: 'acceptEdits', label: '自动接受编辑' }, { value: 'plan', label: '计划模式' }] },
    { id: 'claude.permissionsAllow', section: '权限', label: '允许规则', control: 'string-list', value: ['Read', 'Grep'] },
  ],
  codex: [
    { id: 'codex.model', section: '模型', label: '默认模型', control: 'text', value: 'gpt-5.4' },
    { id: 'codex.reasoningEffort', section: '模型', label: '推理强度', control: 'select', value: 'high', options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '最高' }] },
    { id: 'codex.approvalPolicy', section: '权限', label: '审批策略', control: 'select', value: 'on-request', options: [{ value: 'untrusted', label: '仅可信命令免确认' }, { value: 'on-request', label: '按需确认' }, { value: 'never', label: '从不确认' }] },
    { id: 'codex.sandboxMode', section: '权限', label: '沙箱模式', control: 'select', value: 'workspace-write', options: [{ value: 'read-only', label: '只读' }, { value: 'workspace-write', label: '工作区可写' }, { value: 'danger-full-access', label: '完全访问' }] },
  ],
  gemini: [
    { id: 'gemini.model', section: '模型', label: '默认模型', control: 'text', value: 'gemini-2.5-pro' },
    { id: 'gemini.approvalMode', section: '权限', label: '默认审批模式', control: 'select', value: 'default', options: [{ value: 'default', label: '默认' }, { value: 'auto_edit', label: '自动编辑' }, { value: 'plan', label: '计划模式' }] },
    { id: 'gemini.allowedTools', section: '工具', label: '允许工具', control: 'string-list', value: [] },
    { id: 'gemini.theme', section: '体验', label: '界面主题', control: 'text', value: 'Default' },
    { id: 'gemini.writeTodos', section: '体验', label: '任务清单工具', control: 'toggle', value: true },
  ],
}

function mockConfigFormat(role: ClientConfigFileRole): 'json' | 'toml' | 'dotenv' {
  if (role === 'codex-config') return 'toml'
  if (role === 'gemini-env') return 'dotenv'
  return 'json'
}

function normalizeLoadedModelPolicies(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      availableModels: Array.isArray(account.availableModels) ? account.availableModels : [],
      modelPolicy: account.modelPolicy ?? (account.modelAllowlist?.length ? 'selected' : 'all'),
      modelAllowlist: Array.isArray(account.modelAllowlist) ? account.modelAllowlist : [],
    })),
    pools: snapshot.pools.map((pool) => ({
      ...pool,
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
    return normalizeLoadedModelPolicies({
      ...clone(initialSnapshot),
      ...parsed,
      observability: parsed.observability ?? clone(initialSnapshot.observability),
      clientProfiles: parsed.clientProfiles ?? clone(initialSnapshot.clientProfiles),
      healthEvents: parsed.healthEvents ?? [],
    })
  } catch {
    return clone(initialSnapshot)
  }
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
  const updateListeners = new Set<(value: AppUpdateState) => void>()
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    const value = clone(snapshot)
    listeners.forEach((listener) => listener(value))
    return value
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

  return {
    async getSnapshot() {
      await pause(280)
      return clone(snapshot)
    },
    async saveProvider(input: ProviderInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.providers.find((provider) => provider.id === input.id) : undefined
      const provider: ProviderDefinition = {
        ...input,
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
      if (!snapshot.providers.some((provider) => provider.id === id)) throw new Error('供应商不存在')
      return changed()
    },
    async deleteProvider(id: string) {
      if (snapshot.accounts.some((account) => account.providerId === id)) {
        throw new Error('请先删除该供应商下的账号')
      }
      snapshot.providers = snapshot.providers.filter((provider) => provider.id !== id)
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
          ? `${input.credential.slice(0, 5)}••••••••${input.credential.slice(-4)}`
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
    async refreshAccountModels(id: string) {
      const account = snapshot.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new Error('账号不存在')
      const provider = snapshot.providers.find((candidate) => candidate.id === account.providerId)
      if (!provider) throw new Error('账号供应商不存在')
      const overrides: Record<string, string[]> = {
        'account-openai-main': ['gpt-5.5'],
        'account-openai-backup': ['gpt-5.5', 'gpt-5.5-mini'],
      }
      const availableModels = overrides[id] ?? provider.models
      if (!availableModels.length) throw new Error('上游返回了空模型列表')
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
    async testAccountModel(accountId: string, model: string) {
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error('账号不存在')
      if (!model.trim()) throw new Error('模型标识不能为空')
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
      const parsed = JSON.parse(input.content) as { account_id?: string; email?: string; expired?: string }
      const timestamp = Date.now()
      const account: PublicAccount = {
        id: makeId('chatgpt'), providerId: input.providerId, name: input.name || parsed.email || 'ChatGPT Team',
        maskedCredential: `chatgpt-****${parsed.account_id?.slice(-4) ?? 'acct'}`,
        credentialType: 'chatgpt-oauth',
        credentialExpiresAt: parsed.expired ? Date.parse(parsed.expired) : timestamp + 3_600_000,
        renewable: false, status: 'active', priority: 10, weight: 10, maxConcurrency: 4, inFlight: 0,
        availableModels: [], modelPolicy: 'all', modelAllowlist: [], circuitState: 'closed', consecutiveFailures: 0, createdAt: timestamp, updatedAt: timestamp
      }
      snapshot.accounts.push(account)
      return {
        snapshot: await changed(),
        importedAccountIds: [account.id],
        createdAccountIds: [account.id],
        updatedAccountIds: [],
        warnings: ['No refresh token']
      }
    },
    async importChatGptAccountFiles(input) {
      await pause(500)
      const accountId = makeId('chatgpt-file')
      const timestamp = Date.now()
      const account: PublicAccount = {
        id: accountId, providerId: input.providerId, name: 'CPA Plus Account',
        maskedCredential: 'chatgpt-****demo', credentialType: 'chatgpt-oauth',
        credentialExpiresAt: timestamp + 3_600_000, renewable: false, status: 'active', priority: 10, weight: 10,
        maxConcurrency: 4, inFlight: 0, latencyMs: 820, availableModels: [], modelPolicy: 'all', modelAllowlist: [],
        circuitState: 'closed', consecutiveFailures: 0, createdAt: timestamp, updatedAt: timestamp
      }
      snapshot.accounts.push(account)
      publish()
      return {
        snapshot: clone(snapshot),
        cancelled: false,
        selectedFiles: 2,
        fileResults: [
          { fileName: 'codex-plus-1.json', status: 'imported', importedAccounts: 1, createdAccounts: 1, updatedAccounts: 0 },
          { fileName: 'sub2api-export.json', status: 'imported', importedAccounts: 1, createdAccounts: 0, updatedAccounts: 1 },
        ],
        importedAccountIds: [accountId],
        createdAccountIds: [accountId],
        updatedAccountIds: [],
        detectionResults: [{ accountId, accountName: account.name, ok: true, latencyMs: 820 }],
        warnings: ['codex-plus-1.json：已从 JWT user_id 自动补全 1 个 CPA 账号的 account_id。']
      }
    },
    async deleteAccount(id: string) {
      if (snapshot.pools.some((pool) => pool.members.some((member) => member.accountId === id))) {
        throw new Error('该账号仍在号池中，请先从号池移除')
      }
      snapshot.accounts = snapshot.accounts.filter((account) => account.id !== id)
      return changed()
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
        throw new Error('该代理仍被账号或号池使用')
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
    async savePool(input: PoolInput) {
      const timestamp = Date.now()
      const existing = input.id ? snapshot.pools.find((pool) => pool.id === input.id) : undefined
      const modelPolicy = input.modelPolicy ?? existing?.modelPolicy ?? 'all'
      const modelAllowlist = modelPolicy === 'selected'
        ? pruneModelSelection(input.modelAllowlist ?? existing?.modelAllowlist ?? [], poolModelCandidates(input.accountIds))
        : []
      const pool: Pool = {
        id: existing?.id ?? makeId('pool'),
        name: input.name,
        protocol: input.protocol,
        strategy: input.strategy,
        members: input.accountIds.map((accountId) => ({ accountId, enabled: true })),
        modelPolicy,
        modelAllowlist,
        stickySessions: input.stickySessions,
        stickyTtlMinutes: input.stickyTtlMinutes,
        maxRetries: input.maxRetries,
        forceFastMode: input.protocol === 'openai-responses'
          && (input.forceFastMode ?? existing?.forceFastMode) === true,
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
      if (snapshot.routes.some((route) => route.poolId === id)) {
        throw new Error('该号池正被客户端路由使用')
      }
      snapshot.pools = snapshot.pools.filter((pool) => pool.id !== id)
      return changed()
    },
    async updateRoute(route: Route) {
      snapshot.routes = snapshot.routes.map((item) => (item.id === route.id ? { ...route, updatedAt: Date.now() } : item))
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
      if (!account) throw new Error('账号不存在')
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
    async clearLogs() {
      snapshot.requestLogs = []
      return changed()
    },
    async clearHealthEvents() {
      snapshot.healthEvents = []
      return changed()
    },
    async listProviderPresets() {
      return [
        { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', models: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5-mini'] },
        { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', models: ['claude-sonnet-4-5'] },
        { id: 'gemini', name: 'Google Gemini', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'gemini', models: ['gemini-2.5-pro'] }
      ]
    },
    async onboardProvider(input) {
      const presets = await this.listProviderPresets()
      const preset = presets.find((candidate) => candidate.id === input.presetId)
      if (!preset) throw new Error('Provider preset not found')
      await this.saveProvider({ ...preset, name: input.providerName || preset.name })
      const provider = snapshot.providers.at(-1)!
      return this.saveAccount({ providerId: provider.id, name: input.accountName, credential: input.credential, priority: 10, weight: 10, maxConcurrency: 4, modelAllowlist: [] })
    },
    async saveClientProfile(input) {
      const existing = snapshot.clientProfiles.find((profile) => profile.id === input.id)
      if (input.id && !existing) throw new Error('客户端配置 Profile 不存在')
      if (existing?.isDefault) throw new Error('默认客户端 Profile 不可编辑')
      if (existing && existing.client !== input.client) throw new Error('已有 Profile 的客户端不可修改')
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
      return this.saveClientProfile(bundle.profile)
    },
    async getClientConfigs(profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      const clients = profile ? [profile.client] : (Object.keys(mockClientFiles) as RouteClient[])
      return clients.map((client): ClientConfigStatus => ({
        client,
        directory: profile?.directory ?? `~/.${client === 'claude' ? 'claude' : client === 'codex' ? 'codex' : 'gemini'}`,
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
    async previewClientConfig(client, profileId) {
      await pause()
      return {
        client,
        profileId: profileId ?? `default-${client}`,
        files: mockClientFiles[client].map((file) => ({
          ...file,
          existed: client !== 'gemini',
          changed: true,
          managedFields: ['Stone 管理字段'],
        })),
      }
    },
    async applyClientConfig(client) {
      await pause()
      const createdAt = Date.now()
      const backups = mockClientFiles[client].filter(() => client !== 'gemini').map((file, index): ClientConfigBackup => ({
        client,
        role: file.role,
        targetPath: file.path,
        backupPath: `${file.path}.stone-backup.${createdAt}.${index}`,
        createdAt,
        size: 320,
      }))
      clientBackups.unshift(...backups)
      return { client, changedFiles: mockClientFiles[client].map((file) => file.path), backups, removedBackups: [] }
    },
    async listClientConfigBackups(client) {
      await pause()
      return clone(clientBackups.filter((backup) => backup.client === client))
    },
    async restoreClientConfig(backupPath, client, profileId) {
      await pause()
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === profileId)
      if (profileId && !profile) throw new Error('客户端配置 Profile 不存在')
      if (profile && profile.client !== client) throw new Error('客户端配置 Profile 与客户端不匹配')
      const backup = clientBackups.find((candidate) => candidate.backupPath === backupPath)
      if (!backup) throw new Error('备份不存在')
      if (backup.client !== client) throw new Error('备份不属于所选客户端')
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
      if (profileId && !profile) throw new Error('客户端配置 Profile 不存在')
      if (profile && profile.client !== client) throw new Error('客户端配置 Profile 与客户端不匹配')
      return {
        client,
        profileId: profile?.id ?? `default-${client}`,
        fields: clone(mockEditorFields[client]),
        files: mockClientFiles[client].map((file) => {
          const content = mockEditorContent[client][file.role]
          const editable = file.role !== 'codex-auth'
          return {
            role: file.role,
            path: file.path,
            format: mockConfigFormat(file.role),
            exists: content !== undefined || client !== 'gemini',
            editable,
            containsCredential: file.containsCredential,
            ...(editable ? { content: content ?? (mockConfigFormat(file.role) === 'json' ? '{}\n' : '') } : {}),
            revision: `mock-${client}-${file.role}`,
            protectedValueCount: content?.match(/__STONE_PROTECTED_VALUE__/g)?.length ?? (editable ? 0 : 1),
          }
        }),
      }
    },
    async saveClientConfigEditor(input) {
      await pause()
      const changedFiles = new Set<string>()
      for (const draft of input.files) {
        mockEditorContent[input.client][draft.role] = draft.content
        const file = mockClientFiles[input.client].find((candidate) => candidate.role === draft.role)
        if (file) changedFiles.add(file.path)
      }
      if (input.patches.length) changedFiles.add(mockClientFiles[input.client][0].path)
      return { client: input.client, changedFiles: [...changedFiles], backups: [], removedBackups: [] }
    },
    async listStateBackups() { return [] },
    async createStateBackup() { return {} },
    async verifyStateBackup(path) { return { path, createdAt: Date.now(), size: 0, integrity: 'valid', automatic: false } },
    async restoreStateBackup(path) { return { restored: { path, createdAt: Date.now(), size: 0, integrity: 'valid', automatic: false }, restartRequired: true } },
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
          version: '0.8.1',
          tagName: 'v0.8.1',
          title: 'Stone+ 0.8.1 · 更稳健的本地更新体验',
          publishedAt: new Date().toISOString(),
          url: 'https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.1',
          notes: [
            '本次更新',
            '',
            '- 新增 GitHub Releases 在线更新与新版本提醒。',
            '- 支持忽略版本、查看下载进度和更新后重启。',
            '- 优化账号、号池与客户端配置体验。',
            '',
            '更新方式',
            '',
            '- Windows 安装版与 Linux AppImage 支持应用内更新。',
            '- Portable、deb 与当前 macOS 版本可前往 Releases 手动更新。',
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
    async previewCodexSessionRepair(targetProvider) {
      return {
        ...(await this.inspectCodexSessionRepair()),
        targetProvider,
        revision: 'a'.repeat(64),
        rolloutFilesToUpdate: targetProvider === 'stone' ? 18 : 90,
        sqliteProviderRowsToUpdate: targetProvider === 'stone' ? 21 : 86,
        sqliteUserEventRowsToUpdate: 2,
        sqliteCwdRowsToUpdate: 3,
        encryptedSessionFiles: 1,
        encryptedSourceProviders: ['openai'],
      }
    },
    async repairCodexSessions(targetProvider) {
      await pause(420)
      return {
        targetProvider,
        repairedRolloutFiles: 18,
        sqliteProviderRowsUpdated: 21,
        sqliteUserEventRowsUpdated: 2,
        sqliteCwdRowsUpdated: 3,
        skippedFiles: [],
        encryptedSessionFiles: 1,
        encryptedSourceProviders: ['openai'],
        backupPath: 'C:\\Users\\demo\\.codex\\backups_state\\stone-session-repair\\20260718210000000-demo',
      }
    },
    onSnapshot(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onUpdateState(listener) {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
  }
}
