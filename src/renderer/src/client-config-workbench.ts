import type {
  ClientConfigEditorField,
  ClientConfigEditorState,
  ClientConfigFieldValue,
  ClientConfigFileFormat,
  ClientConfigFileRole,
} from '@shared/types'
import type { UiLanguage } from './i18n'
import { mutateJsonObject, objectField, parseJsonObject, type JsonObject } from '../../main/client-config/json-format'
import { locateCodexTomlPath, parseCodexToml, patchCodexTomlPaths } from '../../main/client-config/toml-format'

export type ClientConfigFieldDrafts = Record<string, ClientConfigFieldValue>
export type ClientConfigFileDrafts = Partial<Record<ClientConfigFileRole, string>>

export interface ClientConfigFieldGuide {
  role: ClientConfigFileRole
  path: readonly string[]
  description: string
  defaultLabel: string
  recommendedValue: ClientConfigFieldValue
  optionHelp?: Readonly<Record<string, string>>
}

interface EnglishFieldMetadata {
  label: string
  description: string
  placeholder?: string
}

export interface ClientConfigPreviewLocation {
  role: ClientConfigFileRole
  path: readonly string[]
  key: string
  keyword: string
  lineStart?: number
  lineEnd?: number
  startLine?: number
  endLine?: number
}

export interface ClientConfigWorkbenchDocument {
  role: ClientConfigFileRole
  path: string
  format: ClientConfigFileFormat
  content?: string
  exists: boolean
  editable: boolean
  protectedValueCount: number
  changed: boolean
  syntaxError?: string
  error?: string
}

export interface ClientConfigWorkbenchPreview {
  documents: ClientConfigWorkbenchDocument[]
  fieldLocations: Record<string, ClientConfigPreviewLocation>
  dirty: boolean
  hasErrors: boolean
}

export interface ClientConfigWorkbenchDrafts {
  fieldDrafts: ClientConfigFieldDrafts
  fileDrafts: ClientConfigFileDrafts
}

const guide = (
  role: ClientConfigFileRole,
  path: readonly string[],
  description: string,
  recommendedValue: ClientConfigFieldValue = null,
  defaultLabel = '跟随客户端默认值',
  optionHelp?: Readonly<Record<string, string>>,
): ClientConfigFieldGuide => ({ role, path, description, defaultLabel, recommendedValue, ...(optionHelp ? { optionHelp } : {}) })

/**
 * Renderer-side presentation metadata for every field currently exposed by the
 * backend catalog. Paths intentionally mirror the catalog and are also used to
 * produce an exact draft preview without exposing credentials.
 */
export const clientConfigFieldGuides: Readonly<Record<string, ClientConfigFieldGuide>> = Object.freeze({
  'claude.model': guide('claude-settings', ['model'], '指定 Claude Code 启动新对话时优先使用的模型；留空时由客户端或服务端选择。'),
  'claude.effort': guide('claude-settings', ['effortLevel'], '控制模型在速度、Token 消耗与推理深度之间的取舍。', 'medium', '跟随 Claude Code 默认值', {
    low: '响应更快、推理较少', medium: '速度与质量均衡', high: '更深入地推理', xhigh: '最大化推理深度',
  }),
  'claude.permissionMode': guide('claude-settings', ['permissions', 'defaultMode'], '决定 Claude Code 调用工具、修改文件或执行命令前如何请求授权。', 'default', '跟随 Claude Code 默认权限', {
    default: '按客户端规则询问', acceptEdits: '自动接受文件编辑', plan: '只规划，不直接执行', dontAsk: '不主动弹出询问', bypassPermissions: '跳过权限确认', auto: '由客户端自动判断',
  }),
  'claude.permissionsAllow': guide('claude-settings', ['permissions', 'allow'], '每行一条始终允许的工具规则；适合可信且高频的操作。'),
  'claude.permissionsAsk': guide('claude-settings', ['permissions', 'ask'], '每行一条始终需要确认的工具规则。'),
  'claude.permissionsDeny': guide('claude-settings', ['permissions', 'deny'], '每行一条禁止执行的工具规则；拒绝规则应保持最小且明确。'),

  'codex.model': guide('codex-config', ['model'], '指定 Codex 默认模型；留空可避免把 Profile 锁定到某个模型。'),
  'codex.reasoningEffort': guide('codex-config', ['model_reasoning_effort'], '控制模型的推理投入。任务越复杂可选越高，但响应时间与用量也可能增加。', 'medium', '跟随模型默认推理强度', {
    none: '不额外请求推理', minimal: '极少推理', low: '较快', medium: '速度与质量均衡', high: '深入推理', xhigh: '最大推理投入',
  }),
  'codex.approvalPolicy': guide('codex-config', ['approval_policy'], '决定 Codex 在执行命令前何时向你确认；它与沙箱模式共同控制操作边界。', 'on-request', '跟随 Codex 默认审批策略', {
    untrusted: '仅可信命令免确认', 'on-request': 'Codex 判断有需要时确认', never: '从不弹出审批确认',
  }),
  'codex.sandboxMode': guide('codex-config', ['sandbox_mode'], '限制 Codex 可读取或写入的文件范围，以及命令所处的隔离级别。', 'workspace-write', '跟随 Codex 默认沙箱', {
    'read-only': '只能读取，不能写入', 'workspace-write': '可写当前工作区', 'danger-full-access': '不限制文件系统访问',
  }),
  'codex.webSearch': guide('codex-config', ['web_search'], '选择 Codex 是否以及如何使用网页搜索结果。', 'cached', '跟随 Codex 默认联网策略', {
    disabled: '禁止网页搜索', cached: '优先使用缓存索引', indexed: '使用受控索引', live: '实时访问网页',
  }),
  'codex.personality': guide('codex-config', ['personality'], '调整 Codex 的表达方式，不改变权限或模型能力。', 'pragmatic', '跟随 Codex 默认交流风格', {
    none: '不指定风格', friendly: '更友好、解释更多', pragmatic: '直接、工程化',
  }),

  'gemini.model': guide('gemini-settings', ['model', 'name'], '指定 Gemini CLI 默认模型；留空时由客户端选择。'),
  'gemini.approvalMode': guide('gemini-settings', ['general', 'defaultApprovalMode'], '决定 Gemini CLI 执行工具和修改文件前的确认方式。', 'default', '跟随 Gemini CLI 默认审批', {
    default: '按默认规则确认', auto_edit: '自动接受编辑', plan: '只进行规划',
  }),
  'gemini.allowedTools': guide('gemini-settings', ['tools', 'allowed'], '每行一项，限定允许使用的工具。留空表示不额外添加允许清单。'),
  'gemini.excludedTools': guide('gemini-settings', ['tools', 'exclude'], '每行一项，明确禁止 Gemini CLI 使用的工具。'),
  'gemini.theme': guide('gemini-settings', ['ui', 'theme'], '设置 Gemini CLI 的界面主题；留空保留客户端默认主题。'),
})

/**
 * English presentation copy is kept in the renderer so the main-process
 * catalog can remain backward compatible with existing integrations. Every
 * catalog field has an explicit entry; newly discovered Codex keys use the
 * safe English fallback in `localizeClientConfigEditorField`.
 */
const englishFieldMetadata: Readonly<Record<string, EnglishFieldMetadata>> = Object.freeze(Object.fromEntries([
  ['claude.model', 'Default model', 'The model Claude Code uses for new conversations. Leave blank to let the client choose.', 'Use the client default model'],
  ['claude.effort', 'Reasoning effort', 'Balances response speed and reasoning depth for models that support effort levels.'],
  ['claude.alwaysThinking', 'Always use extended thinking', 'Enables extended thinking by default on supported models. This can increase latency and usage.'],
  ['claude.language', 'Preferred language', 'The natural language Claude Code should prefer in its responses.', 'For example: English'],
  ['claude.permissionMode', 'Default permission mode', 'Controls when Claude Code asks for permission and whether it can edit files or run tools directly.'],
  ['claude.permissionsAllow', 'Allow rules', 'Tool-matching rules that can run without prompting, one rule per line.'],
  ['claude.permissionsAsk', 'Ask rules', 'Tool-matching rules that must prompt the user first, one rule per line.'],
  ['claude.permissionsDeny', 'Deny rules', 'Tool-matching rules that are always blocked, one per line. Deny rules take precedence over allow rules.'],
  ['claude.includeGitInstructions', 'Include Git guidance', 'Allows the client to include its built-in Git workflow guidance in context.'],
  ['claude.autoUpdatesChannel', 'Automatic update channel', 'Choose stable updates or receive the latest release earlier.'],

  ['codex.model', 'Default model', 'The model Codex uses for new conversations. Leave blank to follow the client recommendation.', 'Use the client-recommended model'],
  ['codex.reviewModel', 'Code review model', 'The model used specifically for /review. Leave blank to use the current conversation model.', 'Use the current model'],
  ['codex.modelProvider', 'Model provider', 'StonePlus fixes this value to stone so requests are sent through the local gateway.'],
  ['codex.credentialsStore', 'Credential storage', 'StonePlus routing uses a protected auth.json file, so applying the configuration fixes this value to file.'],
  ['codex.serviceTier', 'Service tier', 'Select a response tier supported by the model provider. Leave blank when the StonePlus upstream does not support one.'],
  ['codex.reasoningEffort', 'Reasoning effort', 'Balances speed, usage, and reasoning depth for models that support reasoning.'],
  ['codex.planReasoningEffort', 'Plan mode reasoning effort', 'Overrides the normal reasoning effort only while Plan mode is active.'],
  ['codex.reasoningSummary', 'Reasoning summary', 'Controls whether a reasoning summary is shown and how detailed it should be.'],
  ['codex.modelVerbosity', 'Response verbosity', 'Controls the amount of detail in text produced by models that support this setting.'],
  ['codex.personality', 'Communication style', 'Sets the default communication style for models that support personalities.'],
  ['codex.modelContextWindow', 'Context window', 'Manually overrides the model context capacity in tokens. Normally this should be left blank.'],
  ['codex.autoCompactLimit', 'Automatic compaction threshold', 'Compacts conversation history after this token count. Leave blank to use the model default.'],
  ['codex.autoCompactScope', 'Compaction counting scope', 'Counts the automatic compaction threshold against either the full context or only the body after a fixed prefix.'],
  ['codex.toolOutputLimit', 'Per-tool output limit', 'The maximum number of tokens retained in context from each tool output.'],
  ['codex.developerInstructions', 'Global additional instructions', 'Personal instructions injected before the project AGENTS.md file. They affect every conversation.', 'Leave blank to inject nothing'],
  ['codex.approvalPolicy', 'Approval policy', 'Controls when Codex asks for confirmation before running commands or sensitive operations.'],
  ['codex.approvalsReviewer', 'Approval reviewer', 'Choose whether approvals go directly to the user or are first evaluated by an automatic reviewer.'],
  ['codex.sandboxMode', 'Sandbox mode', 'Limits the files and network resources that tools can read or write.'],
  ['codex.allowLoginShell', 'Allow login shell', 'Allows tools to request login-shell semantics and load the user shell configuration.'],
  ['codex.workspaceNetwork', 'Workspace sandbox network access', 'Allows tools to access the network while workspace-write sandbox mode is active.'],
  ['codex.writableRoots', 'Additional writable directories', 'Absolute paths that can be written outside the current workspace, one per line.'],
  ['codex.windowsSandbox', 'Native Windows sandbox', 'Prefer elevated isolation on Windows, or use unelevated isolation when elevation is unavailable.'],
  ['codex.webSearch', 'Web search', 'Controls whether web search is disabled or uses cached, indexed, or live results.'],
  ['codex.projectDocMaxBytes', 'Project guidance read limit', 'The maximum number of bytes of AGENTS.md content loaded into the initial prompt.'],
  ['codex.projectDocFallbacks', 'Project guidance fallback names', 'File names to try when a directory does not contain AGENTS.md, one per line.'],
  ['codex.projectRootMarkers', 'Project root markers', 'File or directory names used while searching upward for the project root.'],
  ['codex.fileOpener', 'File link opener', 'Selects the editor used when opening file references from terminal output.'],
  ['codex.hideAgentReasoning', 'Hide reasoning events', 'Hides internal reasoning events from terminal output.'],
  ['codex.showRawReasoning', 'Show raw reasoning', 'Shows raw reasoning content when a model provides it. This is normally left off.'],
  ['codex.disablePasteBurst', 'Disable rapid-paste detection', 'Disables terminal detection of a sudden burst of typed or pasted text.'],
  ['codex.checkUpdates', 'Check for Codex updates at startup', 'Checks for Codex CLI updates when the client starts.'],
  ['codex.notifications', 'External notification command', 'An external notification program and its arguments, one argv element per line.'],
  ['codex.feature.apps', 'App connectors', 'Enables integrations with apps and connectors.'],
  ['codex.feature.goals', 'Persistent goals', 'Enables goal tracking and automatic continuation.'],
  ['codex.feature.hooks', 'Lifecycle hooks', 'Enables hooks.json and inline lifecycle hooks.'],
  ['codex.feature.fast_mode', 'Fast mode', 'Enables selection of the Fast service tier.'],
  ['codex.feature.memories', 'Memories', 'Enables experimental memories shared across conversations.'],
  ['codex.feature.multi_agent', 'Multi-agent collaboration', 'Enables tools for collaborating with sub-agents.'],
  ['codex.feature.personality', 'Personality selection', 'Enables the communication-style selector.'],
  ['codex.feature.remote_plugin', 'Remote plugin catalog', 'Enables the remote plugin catalog.'],
  ['codex.feature.shell_snapshot', 'Shell snapshot', 'Caches the shell environment to speed up repeated commands.'],
  ['codex.feature.shell_tool', 'Shell tool', 'Enables the default shell tool.'],
  ['codex.feature.unified_exec', 'Unified execution terminal', 'Uses the PTY-based unified command execution tool.'],
  ['codex.agentsMaxThreads', 'Maximum concurrent agents', 'The maximum number of agent tasks that may remain open at the same time.'],
  ['codex.agentsMaxDepth', 'Agent nesting depth', 'The maximum number of levels at which sub-agents can create more agents. Higher values increase fan-out and usage.'],
  ['codex.agentsJobTimeout', 'Batch agent timeout', 'The default maximum runtime in seconds for each spawn_agents_on_csv worker.'],
  ['codex.agentsInterruptMessage', 'Record interruption messages', 'Records a visible message in model context when an agent is interrupted.'],

  ['gemini.model', 'Default model', 'The model Gemini CLI uses for new conversations. Leave blank to let the client choose.', 'Use the client default model'],
  ['gemini.maxSessionTurns', 'Maximum conversation turns', 'Limits the number of model turns in a single conversation. Leave blank for no additional limit.'],
  ['gemini.approvalMode', 'Default approval mode', 'Controls which confirmations are required for tool calls and file edits.'],
  ['gemini.vimMode', 'Vim input mode', 'Enables Vim-style key bindings in the interactive input.'],
  ['gemini.enableAutoUpdate', 'Automatic updates', 'Allows Gemini CLI to check for and install updates automatically.'],
  ['gemini.enableNotifications', 'System notifications', 'Allows Gemini CLI to send system notifications for events such as task completion.'],
  ['gemini.maxAttempts', 'Maximum attempts', 'The maximum number of attempts allowed after a request or tool workflow fails.'],
  ['gemini.allowedTools', 'Allowed tools', 'Tool names that may be used without additional restrictions, one per line.'],
  ['gemini.excludedTools', 'Excluded tools', 'Tool names that Gemini CLI must not use, one per line.'],
  ['gemini.theme', 'Interface theme', 'The theme name used by the Gemini CLI terminal interface.', 'Use the client default theme'],
  ['gemini.hideBanner', 'Hide startup banner', 'Hides the branded banner at startup.'],
  ['gemini.hideTips', 'Hide usage tips', 'Hides random usage tips in the terminal interface.'],
  ['gemini.usageStatistics', 'Usage statistics', 'Allows anonymous usage statistics to be sent to improve Gemini CLI.'],
  ['gemini.contextFileName', 'Context file name', 'Sets the name of the project-level context instruction file.', 'For example: GEMINI.md'],
  ['gemini.includeDirectories', 'Additional context directories', 'Additional directories to include in project context, one per line.'],
].map(([id, label, description, placeholder]) => [id, { label, description, ...(placeholder ? { placeholder } : {}) }])))

const englishSections: Readonly<Record<string, string>> = Object.freeze({
  '模型与语言': 'Model & language',
  '权限': 'Permissions',
  '体验': 'Experience',
  '更新与通知': 'Updates & notifications',
  '模型': 'Models',
  'StonePlus 连接': 'StonePlus connection',
  '推理与输出': 'Reasoning & output',
  '上下文与压缩': 'Context & compaction',
  '指令': 'Instructions',
  '权限与沙箱': 'Permissions & sandbox',
  '工具与联网': 'Tools & network',
  '项目上下文': 'Project context',
  '界面体验': 'Interface',
  '功能开关': 'Feature flags',
  '多代理': 'Multi-agent',
  '模型与会话': 'Models & conversations',
  '工具': 'Tools',
  '隐私': 'Privacy',
  '模型供应商（扩展）': 'Model providers (extended)',
  'MCP 服务（扩展）': 'MCP servers (extended)',
  '功能开关（扩展）': 'Feature flags (extended)',
  '多代理（扩展）': 'Multi-agent (extended)',
  'Codex Profiles（扩展）': 'Codex profiles (extended)',
  '项目配置（扩展）': 'Project configuration (extended)',
  '插件（扩展）': 'Plugins (extended)',
  '插件市场（扩展）': 'Plugin marketplaces (extended)',
  '终端界面（扩展）': 'Terminal interface (extended)',
  '命令环境（扩展）': 'Command environment (extended)',
  '现有扩展项': 'Existing extended settings',
})

type EnglishOptionMetadata = Readonly<Record<string, readonly [label: string, description: string]>>

const englishOptions: Readonly<Record<string, EnglishOptionMetadata>> = Object.freeze({
  'claude.effort': {
    low: ['Low', 'Faster responses'], medium: ['Medium', 'Balanced for everyday tasks'],
    high: ['High', 'For complex tasks'], xhigh: ['Highest', 'The deepest available reasoning level'],
  },
  'claude.permissionMode': {
    default: ['Default', 'Use the standard Claude Code confirmation flow'],
    acceptEdits: ['Accept edits automatically', 'Accept file edits automatically; other sensitive actions may still prompt'],
    plan: ['Plan mode', 'Plan without making changes'], auto: ['Automatic', 'Let the client decide'],
    dontAsk: ['Do not ask', 'Do not show permission prompts; restricted actions are rejected'],
    bypassPermissions: ['Bypass permissions', 'Skip permission checks'],
  },
  'claude.autoUpdatesChannel': {
    stable: ['Stable', 'Prioritize stability'], latest: ['Latest', 'Receive new features earlier'],
  },
  'codex.credentialsStore': {
    file: ['File', 'Store credentials in the protected auth.json file'],
    keyring: ['System keyring', 'Use the operating system credential store'], auto: ['Automatic', 'Let Codex choose the storage method'],
  },
  'codex.serviceTier': { fast: ['Fast', 'Lower-latency fast tier'], flex: ['Flex', 'Flexible background-processing tier'] },
  'codex.reasoningEffort': reasoningOptionMetadata(),
  'codex.planReasoningEffort': { none: ['None', 'Do not request additional reasoning'], ...reasoningOptionMetadata() },
  'codex.reasoningSummary': {
    auto: ['Automatic', 'Let the model decide'], concise: ['Concise', 'Show only a compact summary'],
    detailed: ['Detailed', 'Show a more complete summary'], none: ['Off', 'Do not request a reasoning summary'],
  },
  'codex.modelVerbosity': {
    low: ['Concise', 'Short responses'], medium: ['Medium', 'Balanced detail'], high: ['Detailed', 'More complete explanations'],
  },
  'codex.personality': {
    none: ['No preference', 'Do not add a style'], friendly: ['Friendly', 'Communicate more warmly'],
    pragmatic: ['Pragmatic', 'Focus directly on solving the problem'],
  },
  'codex.autoCompactScope': {
    total: ['Full context', 'Count all context tokens'], body_after_prefix: ['Body after fixed prefix', 'Ignore tokens in the fixed prefix'],
  },
  'codex.approvalPolicy': {
    untrusted: ['Only trusted commands run without approval', 'Ask about unknown commands or commands that may change the system'],
    'on-request': ['Ask when needed', 'Let the model ask when it needs additional permission'],
    never: ['Never ask', 'Do not show approvals; use an appropriate sandbox'],
  },
  'codex.approvalsReviewer': {
    user: ['User', 'Send all confirmations to the user'], auto_review: ['Automatic review', 'Send eligible requests to an automatic reviewer first'],
  },
  'codex.sandboxMode': {
    'read-only': ['Read only', 'Files can be read but edits need additional permission'],
    'workspace-write': ['Workspace write', 'Allow changes in the current workspace'],
    'danger-full-access': ['Full access', 'Do not use a filesystem sandbox'],
  },
  'codex.windowsSandbox': {
    elevated: ['Enhanced isolation', 'Recommended Windows sandbox'],
    unelevated: ['Standard isolation', 'Compatible mode when administrator access is unavailable'],
  },
  'codex.webSearch': {
    disabled: ['Off', 'Do not provide web search'], cached: ['Cached index', 'Use pre-indexed results with lower exposure'],
    indexed: ['Controlled network access', 'Let the search index decide whether network access is needed'], live: ['Live network access', 'Fetch current web results'],
  },
  'codex.fileOpener': {
    vscode: ['VS Code', 'Use vscode:// links'], 'vscode-insiders': ['VS Code Insiders', 'Use VS Code Insiders'],
    windsurf: ['Windsurf', 'Use Windsurf'], cursor: ['Cursor', 'Use Cursor'], none: ['No links', 'Do not generate file links'],
  },
  'gemini.approvalMode': {
    default: ['Default', 'Prompt normally for sensitive actions'], auto_edit: ['Automatic edits', 'Approve file edits automatically'],
    plan: ['Plan mode', 'Plan without making changes'],
  },
})

function reasoningOptionMetadata(): EnglishOptionMetadata {
  return {
    minimal: ['Minimal', 'Lowest latency for very simple tasks'], low: ['Low', 'Prioritize speed for simple tasks'],
    medium: ['Medium', 'Balance speed and quality'], high: ['High', 'Complex analysis and multi-step tasks'],
    xhigh: ['Extra high', 'Use deeper reasoning on models that support this level'],
  }
}

export function localizeClientConfigEditorField(
  field: ClientConfigEditorField,
  language: UiLanguage,
): ClientConfigEditorField {
  if (language === 'zh-CN') return field
  const metadata = englishFieldMetadata[field.id]
  const path = field.path.join('.')
  const label = metadata?.label ?? humanizeConfigKey(field.path.at(-1) ?? field.id)
  const description = metadata?.description ?? (field.sensitive
    ? `${path} contains a credential or sensitive connection value. Its current value is hidden; use the protected full-file editor to preserve or replace it.`
    : `${path} is an existing client setting not yet included in the StonePlus catalog. StonePlus preserves it unchanged; use the full-file editor to modify it.`)
  return {
    ...field,
    section: englishSections[field.section] ?? (field.source === 'discovered' ? 'Existing extended settings' : 'Client settings'),
    label,
    description,
    ...(field.placeholder !== undefined ? {
      placeholder: metadata?.placeholder ?? (field.sensitive ? 'Securely hidden' : 'Use the client default'),
    } : {}),
    ...(field.options ? {
      options: field.options.map((item) => {
        const optionMetadata = englishOptions[field.id]?.[item.value]
        const customValue = /当前值/.test(item.label)
        return {
          ...item,
          label: optionMetadata?.[0] ?? (customValue ? `Current value: ${item.value}` : humanizeConfigKey(item.value)),
          description: optionMetadata?.[1] ?? (customValue
            ? 'Existing value from a newer client or a custom configuration'
            : `Use ${humanizeConfigKey(item.value)} for this setting`),
        }
      }),
    } : {}),
  }
}

function humanizeConfigKey(value: string): string {
  const normalized = value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Setting'
}

export function getClientConfigFieldGuide(
  field: ClientConfigEditorField,
  language: UiLanguage = 'zh-CN',
): ClientConfigFieldGuide | undefined {
  const presentedField = localizeClientConfigEditorField(field, language)
  const enriched = presentedField as ClientConfigEditorField & Partial<Pick<ClientConfigFieldGuide, 'role' | 'path' | 'description' | 'defaultLabel' | 'recommendedValue' | 'optionHelp'>>
  const fallback = clientConfigFieldGuides[field.id]
  const role = enriched.role ?? fallback?.role
  const path = enriched.path ?? fallback?.path
  if (!role || !path) return undefined
  const localizedOptionHelp = language === 'en' && presentedField.options
    ? Object.fromEntries(presentedField.options.map((item) => [item.value, item.description ?? `Use ${item.label}`]))
    : undefined
  return {
    role,
    path,
    description: enriched.description ?? (language === 'en'
      ? `${presentedField.label} is a client configuration setting.`
      : fallback?.description ?? `${field.label} 的客户端配置项。`),
    defaultLabel: language === 'en'
      ? 'Use the client default'
      : enriched.defaultLabel ?? fallback?.defaultLabel ?? '跟随客户端默认值',
    recommendedValue: enriched.recommendedValue !== undefined ? enriched.recommendedValue : (fallback?.recommendedValue ?? null),
    ...(localizedOptionHelp ?? enriched.optionHelp ?? fallback?.optionHelp
      ? { optionHelp: localizedOptionHelp ?? enriched.optionHelp ?? fallback?.optionHelp }
      : {}),
  }
}

export function createInitialClientConfigDrafts(editor: ClientConfigEditorState): ClientConfigWorkbenchDrafts {
  return {
    fieldDrafts: Object.fromEntries(editor.fields.map((field) => [field.id, cloneConfigValue(field.value)])),
    fileDrafts: Object.fromEntries(editor.files
      .filter((file) => file.editable && file.content !== undefined)
      .map((file) => [file.role, file.content])),
  }
}

/** Reset the complete draft either to the loaded file or to conservative recommended settings. */
export function resetClientConfigDrafts(
  editor: ClientConfigEditorState,
  mode: 'recommended' | 'current' = 'recommended',
): ClientConfigWorkbenchDrafts {
  const initial = createInitialClientConfigDrafts(editor)
  if (mode === 'current') return initial
  return {
    ...initial,
    fieldDrafts: Object.fromEntries(editor.fields.map((field) => [
      field.id,
      cloneConfigValue(field.readOnly ? field.value : (getClientConfigFieldGuide(field)?.recommendedValue ?? null)),
    ])),
  }
}

export function isClientConfigWorkbenchDirty(
  editor: ClientConfigEditorState,
  fieldDrafts: ClientConfigFieldDrafts,
  fileDrafts: ClientConfigFileDrafts,
): boolean {
  return editor.fields.some((field) => !field.readOnly && !sameConfigValue(field.value, draftValue(field, fieldDrafts)))
    || editor.files.some((file) => (
      file.editable
      && file.content !== undefined
      && hasOwn(fileDrafts, file.role)
      && fileDrafts[file.role] !== file.content
    ))
}

export function buildClientConfigWorkbenchPreview(
  editor: ClientConfigEditorState,
  fieldDrafts: ClientConfigFieldDrafts,
  fileDrafts: ClientConfigFileDrafts,
  language: UiLanguage = 'zh-CN',
): ClientConfigWorkbenchPreview {
  const changesByRole = new Map<ClientConfigFileRole, Array<{ field: ClientConfigEditorField; value: ClientConfigFieldValue; guide: ClientConfigFieldGuide }>>()
  for (const field of editor.fields) {
    if (field.readOnly) continue
    const value = draftValue(field, fieldDrafts)
    if (sameConfigValue(field.value, value)) continue
    const fieldGuide = getClientConfigFieldGuide(field)
    if (!fieldGuide) continue
    const changes = changesByRole.get(fieldGuide.role) ?? []
    changes.push({ field, value, guide: fieldGuide })
    changesByRole.set(fieldGuide.role, changes)
  }

  const documents = editor.files.map((file): ClientConfigWorkbenchDocument => {
    if (!file.editable || file.content === undefined) {
      return {
        role: file.role,
        path: file.path,
        format: file.format,
        exists: file.exists,
        editable: file.editable,
        protectedValueCount: file.protectedValueCount,
        changed: false,
      }
    }
    const original = file.content
    const source = hasOwn(fileDrafts, file.role) ? fileDrafts[file.role] ?? '' : original
    try {
      const content = overlayFields(file.role, file.format, source, changesByRole.get(file.role) ?? [])
      return {
        role: file.role,
        path: file.path,
        format: file.format,
        content,
        exists: file.exists,
        editable: true,
        protectedValueCount: file.protectedValueCount,
        changed: content !== original,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : undefined
      const localizedError = language === 'en' && errorMessage && /[\u3400-\u9fff]/u.test(errorMessage)
        ? 'Invalid configuration format'
        : errorMessage ?? (language === 'zh-CN' ? '配置格式无效' : 'Invalid configuration format')
      return {
        role: file.role,
        path: file.path,
        format: file.format,
        content: source,
        exists: file.exists,
        editable: true,
        protectedValueCount: file.protectedValueCount,
        changed: source !== original,
        syntaxError: localizedError,
        error: localizedError,
      }
    }
  })

  const fieldLocations: Record<string, ClientConfigPreviewLocation> = {}
  for (const field of editor.fields) {
    const fieldGuide = getClientConfigFieldGuide(field)
    if (!fieldGuide) continue
    const document = documents.find((candidate) => candidate.role === fieldGuide.role)
    const range = document?.content ? locatePath(document.content, document.format, fieldGuide.path) : undefined
    fieldLocations[field.id] = {
      role: fieldGuide.role,
      path: fieldGuide.path,
      key: fieldGuide.path.join('.'),
      keyword: fieldGuide.path.join('.'),
      ...(range ? {
        lineStart: range.startLine,
        lineEnd: range.endLine,
        startLine: range.startLine,
        endLine: range.endLine,
      } : {}),
    }
  }

  return {
    documents,
    fieldLocations,
    dirty: isClientConfigWorkbenchDirty(editor, fieldDrafts, fileDrafts),
    hasErrors: documents.some((document) => Boolean(document.error)),
  }
}

function overlayFields(
  role: ClientConfigFileRole,
  format: ClientConfigFileFormat,
  source: string,
  changes: Array<{ field: ClientConfigEditorField; value: ClientConfigFieldValue; guide: ClientConfigFieldGuide }>,
): string {
  if (!changes.length) {
    if (format === 'toml') parseCodexToml(source)
    else if (format === 'json') parseJsonObject(source, role)
    return source
  }
  if (format === 'toml') {
    return patchCodexTomlPaths(source, changes.map((change) => ({
      path: [...change.guide.path],
      value: change.value,
    }))).content
  }
  if (format === 'json') {
    return mutateJsonObject(source, role, (root) => {
      for (const change of changes) setJsonPath(root, change.guide.path, change.value, role)
    }).content
  }
  // No catalog field currently writes dotenv. The complete file remains visible
  // and editable; connection secrets stay as protected placeholders.
  return source
}

function setJsonPath(root: JsonObject, path: readonly string[], value: ClientConfigFieldValue, role: ClientConfigFileRole): void {
  let parent = root
  for (const part of path.slice(0, -1)) parent = objectField(parent, part, role)
  const key = path.at(-1)
  if (!key) throw new Error('客户端配置字段路径无效')
  if (value === null) delete parent[key]
  else parent[key] = cloneConfigValue(value)
}

function locatePath(content: string, format: ClientConfigFileFormat, path: readonly string[]): Pick<ClientConfigPreviewLocation, 'startLine' | 'endLine'> | undefined {
  if (!path.length) return undefined
  const lines = content.split(/\r?\n/)
  if (format === 'toml') return locateCodexTomlPath(content, path)
  if (format === 'dotenv') {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(path.at(-1)!)}\\s*=`)
    const index = lines.findIndex((line) => pattern.test(line))
    return index < 0 ? undefined : { startLine: index + 1, endLine: index + 1 }
  }
  return locateJsonPath(lines, path)
}

function locateJsonPath(lines: string[], path: readonly string[]): Pick<ClientConfigPreviewLocation, 'startLine' | 'endLine'> | undefined {
  let cursor = 0
  let matchIndex = -1
  for (const part of path) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(JSON.stringify(part))}\\s*:`)
    matchIndex = lines.findIndex((line, index) => index >= cursor && pattern.test(line))
    if (matchIndex < 0) return undefined
    cursor = matchIndex + 1
  }
  const endIndex = jsonValueEnd(lines, matchIndex)
  return { startLine: matchIndex + 1, endLine: endIndex + 1 }
}

function jsonValueEnd(lines: string[], start: number): number {
  const valueStart = lines[start].indexOf(':') + 1
  const initial = lines[start].slice(valueStart)
  if (!initial.includes('[') && !initial.includes('{')) return start
  let depth = 0
  let inString = false
  let escaped = false
  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lineIndex === start ? lines[lineIndex].slice(valueStart) : lines[lineIndex]
    for (const character of line) {
      if (inString && escaped) { escaped = false; continue }
      if (inString && character === '\\') { escaped = true; continue }
      if (character === '"') { inString = !inString; continue }
      if (inString) continue
      if (character === '[' || character === '{') depth += 1
      else if (character === ']' || character === '}') depth -= 1
    }
    if (depth <= 0) return lineIndex
  }
  return start
}

function draftValue(field: ClientConfigEditorField, drafts: ClientConfigFieldDrafts): ClientConfigFieldValue {
  return hasOwn(drafts, field.id) ? drafts[field.id] : field.value
}

function cloneConfigValue(value: ClientConfigFieldValue): ClientConfigFieldValue {
  return Array.isArray(value) ? [...value] : value
}

function sameConfigValue(left: ClientConfigFieldValue, right: ClientConfigFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
