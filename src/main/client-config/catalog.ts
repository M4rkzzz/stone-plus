import type {
  ClientConfigEditorField,
  ClientConfigFieldControl,
  ClientConfigFieldOption,
  ClientConfigFieldPatch,
  ClientConfigFieldValue,
} from '@shared/types'
import { isSensitiveConfigPath } from './editor'
import { mutateJsonObject, objectField, parseJsonObject, type JsonObject } from './json-format'
import { parseCodexToml, patchCodexTomlPaths } from './toml-format'
import type { ClientConfigFileRole, ExistingClientConfig, SupportedClient } from './types'
import { ClientConfigValidationError } from './types'

interface FieldDefinition {
  id: string
  client: SupportedClient
  role: ClientConfigFileRole
  path: string[]
  section: string
  label: string
  description: string
  control: ClientConfigFieldControl
  options?: ClientConfigFieldOption[]
  placeholder?: string
  defaultValue?: ClientConfigFieldValue
  recommendedValue?: ClientConfigFieldValue
  advanced?: boolean
  readOnly?: boolean
  managedByStone?: boolean
  min?: number
  max?: number
  step?: number
}

function option(
  value: string,
  label: string,
  description?: string,
  recommended = false,
): ClientConfigFieldOption {
  return {
    value,
    label,
    ...(description ? { description } : {}),
    ...(recommended ? { recommended: true } : {}),
  }
}

const reasoningOptions = [
  option('minimal', '最小', '最低延迟，适合极简单任务'),
  option('low', '低', '速度优先的简单任务'),
  option('medium', '中', '速度与质量均衡', true),
  option('high', '高', '复杂分析和多步骤任务'),
  option('xhigh', '超高', '支持该档位的模型进行更深入推理'),
]

const fields: readonly FieldDefinition[] = Object.freeze([
  // Claude Code
  {
    id: 'claude.model', client: 'claude', role: 'claude-settings', path: ['model'], section: '模型与语言',
    label: '默认模型', description: 'Claude Code 新会话默认使用的模型；留空时由客户端选择。',
    control: 'text', placeholder: '使用客户端默认模型', defaultValue: null,
  },
  {
    id: 'claude.effort', client: 'claude', role: 'claude-settings', path: ['effortLevel'], section: '模型与语言',
    label: '推理强度', description: '控制支持推理档位的模型在速度与思考深度之间的取舍。',
    control: 'select', options: [
      option('low', '低', '更快响应'), option('medium', '中', '日常任务的均衡选择', true),
      option('high', '高', '复杂任务'), option('xhigh', '最高', '最深入的可用档位'),
    ], defaultValue: null, recommendedValue: 'medium',
  },
  {
    id: 'claude.alwaysThinking', client: 'claude', role: 'claude-settings', path: ['alwaysThinkingEnabled'], section: '模型与语言',
    label: '始终启用扩展思考', description: '在支持的模型上默认启用扩展思考；可能增加耗时和用量。',
    control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.language', client: 'claude', role: 'claude-settings', path: ['language'], section: '模型与语言',
    label: '首选语言', description: 'Claude Code 回复时优先使用的自然语言。',
    control: 'text', placeholder: '例如 Chinese', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.permissionMode', client: 'claude', role: 'claude-settings', path: ['permissions', 'defaultMode'], section: '权限',
    label: '默认权限模式', description: '决定 Claude Code 何时询问以及能否直接修改或运行工具。',
    control: 'select', options: [
      option('default', '默认', '使用 Claude Code 的标准确认流程', true),
      option('acceptEdits', '自动接受编辑', '自动接受文件编辑，其他敏感操作仍可能询问'),
      option('plan', '计划模式', '只规划，不直接修改'),
      option('auto', '自动', '由客户端自动判断'),
      option('dontAsk', '不询问', '不弹出权限询问，受限操作会被拒绝'),
      option('bypassPermissions', '跳过权限', '跳过权限检查'),
    ], defaultValue: null, recommendedValue: 'default',
  },
  {
    id: 'claude.permissionsAllow', client: 'claude', role: 'claude-settings', path: ['permissions', 'allow'], section: '权限',
    label: '允许规则', description: '无需询问即可执行的工具匹配规则，每行一条。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.permissionsAsk', client: 'claude', role: 'claude-settings', path: ['permissions', 'ask'], section: '权限',
    label: '询问规则', description: '命中后必须先询问用户的工具匹配规则，每行一条。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.permissionsDeny', client: 'claude', role: 'claude-settings', path: ['permissions', 'deny'], section: '权限',
    label: '拒绝规则', description: '始终禁止执行的工具匹配规则，每行一条；优先级高于允许规则。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.includeGitInstructions', client: 'claude', role: 'claude-settings', path: ['includeGitInstructions'], section: '体验',
    label: '包含 Git 指引', description: '允许客户端在上下文中加入内置 Git 工作流提示。',
    control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'claude.autoUpdatesChannel', client: 'claude', role: 'claude-settings', path: ['autoUpdatesChannel'], section: '更新与通知',
    label: '自动更新通道', description: '选择稳定更新或尽早获取最新版。', control: 'select',
    options: [option('stable', '稳定版', '优先稳定性', true), option('latest', '最新版', '更早获得新功能')],
    defaultValue: null, recommendedValue: 'stable', advanced: true,
  },

  // Codex
  {
    id: 'codex.model', client: 'codex', role: 'codex-config', path: ['model'], section: '模型',
    label: '默认模型', description: 'Codex 启动新会话时使用的模型；留空时跟随客户端推荐。',
    control: 'text', placeholder: '使用客户端推荐模型', defaultValue: null,
  },
  {
    id: 'codex.reviewModel', client: 'codex', role: 'codex-config', path: ['review_model'], section: '模型',
    label: '代码审查模型', description: '执行 /review 时单独使用的模型；留空时沿用当前会话模型。',
    control: 'text', placeholder: '沿用当前模型', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.modelProvider', client: 'codex', role: 'codex-config', path: ['model_provider'], section: 'Stone+ 连接',
    label: '模型供应商', description: 'Stone+ 应用配置时固定为 stone，以便请求进入本地网关。',
    control: 'text', readOnly: true, managedByStone: true, advanced: true,
  },
  {
    id: 'codex.credentialsStore', client: 'codex', role: 'codex-config', path: ['cli_auth_credentials_store'], section: 'Stone+ 连接',
    label: '认证存储', description: 'Stone+ 路由使用受保护的 auth.json，因此应用配置时固定为 file。',
    control: 'select', options: [
      option('file', '文件', '由受保护的 auth.json 保存认证'),
      option('keyring', '系统密钥环', '使用操作系统凭据存储'),
      option('auto', '自动', '由 Codex 选择存储方式'),
    ], readOnly: true, managedByStone: true, advanced: true,
  },
  {
    id: 'codex.serviceTier', client: 'codex', role: 'codex-config', path: ['service_tier'], section: '模型',
    label: '服务档位', description: '选择模型供应商支持的响应档位；Stone+ 上游不支持时应留空。',
    control: 'select', options: [
      option('fast', 'Fast', '更低延迟的快速档位'), option('flex', 'Flex', '更灵活的后台处理档位'),
    ], defaultValue: null, advanced: true,
  },
  {
    id: 'codex.reasoningEffort', client: 'codex', role: 'codex-config', path: ['model_reasoning_effort'], section: '推理与输出',
    label: '推理强度', description: '控制支持推理的模型在速度、用量与思考深度之间的取舍。',
    control: 'select', options: reasoningOptions, defaultValue: null, recommendedValue: 'medium',
  },
  {
    id: 'codex.planReasoningEffort', client: 'codex', role: 'codex-config', path: ['plan_mode_reasoning_effort'], section: '推理与输出',
    label: '计划模式推理强度', description: '仅在计划模式下覆盖普通推理强度。', control: 'select',
    options: [option('none', '无', '不额外推理'), ...reasoningOptions], defaultValue: null, advanced: true,
  },
  {
    id: 'codex.reasoningSummary', client: 'codex', role: 'codex-config', path: ['model_reasoning_summary'], section: '推理与输出',
    label: '推理摘要', description: '控制是否以及以何种详细程度展示模型的推理摘要。', control: 'select',
    options: [
      option('auto', '自动', '由模型决定', true), option('concise', '简洁', '只显示精简摘要'),
      option('detailed', '详细', '显示更完整摘要'), option('none', '关闭', '不请求推理摘要'),
    ], defaultValue: null, recommendedValue: 'auto', advanced: true,
  },
  {
    id: 'codex.modelVerbosity', client: 'codex', role: 'codex-config', path: ['model_verbosity'], section: '推理与输出',
    label: '回答详细度', description: '控制支持该参数的模型输出文本的详细程度。', control: 'select',
    options: [option('low', '简洁', '短回答'), option('medium', '适中', '默认平衡', true), option('high', '详细', '更充分解释')],
    defaultValue: null, recommendedValue: 'medium', advanced: true,
  },
  {
    id: 'codex.personality', client: 'codex', role: 'codex-config', path: ['personality'], section: '推理与输出',
    label: '交流风格', description: '设置支持该功能的模型默认交流风格。', control: 'select',
    options: [option('none', '无偏好', '不附加风格'), option('friendly', '友好', '更亲切地沟通'), option('pragmatic', '务实', '直接聚焦解决问题', true)],
    defaultValue: null, recommendedValue: 'pragmatic',
  },
  {
    id: 'codex.modelContextWindow', client: 'codex', role: 'codex-config', path: ['model_context_window'], section: '上下文与压缩',
    label: '上下文窗口', description: '手动覆盖模型上下文容量（Token）；通常应留空让模型目录决定。',
    control: 'number', min: 1024, step: 1024, defaultValue: null, advanced: true,
  },
  {
    id: 'codex.autoCompactLimit', client: 'codex', role: 'codex-config', path: ['model_auto_compact_token_limit'], section: '上下文与压缩',
    label: '自动压缩阈值', description: '达到此 Token 数后触发历史压缩；留空时使用模型默认值。',
    control: 'number', min: 1024, step: 1024, defaultValue: null, advanced: true,
  },
  {
    id: 'codex.autoCompactScope', client: 'codex', role: 'codex-config', path: ['model_auto_compact_token_limit_scope'], section: '上下文与压缩',
    label: '压缩计数范围', description: '决定自动压缩阈值按整个上下文还是固定前缀之后的正文计算。', control: 'select',
    options: [option('total', '全部上下文', '计算所有上下文 Token', true), option('body_after_prefix', '固定前缀之后', '忽略固定前缀的 Token')],
    defaultValue: null, recommendedValue: 'total', advanced: true,
  },
  {
    id: 'codex.toolOutputLimit', client: 'codex', role: 'codex-config', path: ['tool_output_token_limit'], section: '上下文与压缩',
    label: '单次工具输出上限', description: '每次工具输出保留到上下文中的最大 Token 数。',
    control: 'number', min: 256, step: 256, defaultValue: null, advanced: true,
  },
  {
    id: 'codex.developerInstructions', client: 'codex', role: 'codex-config', path: ['developer_instructions'], section: '指令',
    label: '全局附加指令', description: '在项目 AGENTS.md 之前注入的个人级指令；会影响每次会话。',
    control: 'text', placeholder: '留空不注入', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.approvalPolicy', client: 'codex', role: 'codex-config', path: ['approval_policy'], section: '权限与沙箱',
    label: '审批策略', description: '决定 Codex 在执行命令或敏感操作前何时请求确认。', control: 'select',
    options: [
      option('untrusted', '仅可信命令免确认', '未知或可能修改系统的命令会询问'),
      option('on-request', '按需确认', '由模型在需要额外权限时询问', true),
      option('never', '从不确认', '不弹出确认；应配合合适的沙箱'),
    ], defaultValue: null, recommendedValue: 'on-request',
  },
  {
    id: 'codex.approvalsReviewer', client: 'codex', role: 'codex-config', path: ['approvals_reviewer'], section: '权限与沙箱',
    label: '审批审核者', description: '选择由用户手动确认，或由自动审核代理先判断符合条件的审批。', control: 'select',
    options: [option('user', '用户', '所有确认交给用户', true), option('auto_review', '自动审核', '符合条件的请求先交给审核代理')],
    defaultValue: null, recommendedValue: 'user', advanced: true,
  },
  {
    id: 'codex.sandboxMode', client: 'codex', role: 'codex-config', path: ['sandbox_mode'], section: '权限与沙箱',
    label: '沙箱模式', description: '限制工具可读取、写入和访问网络的范围。', control: 'select',
    options: [
      option('read-only', '只读', '只能读取文件，修改需额外授权'),
      option('workspace-write', '工作区可写', '允许修改当前工作区', true),
      option('danger-full-access', '完全访问', '不使用文件系统沙箱'),
    ], defaultValue: null, recommendedValue: 'workspace-write',
  },
  {
    id: 'codex.allowLoginShell', client: 'codex', role: 'codex-config', path: ['allow_login_shell'], section: '权限与沙箱',
    label: '允许登录 Shell', description: '允许工具请求登录 Shell 语义以加载用户 Shell 配置。',
    control: 'toggle', defaultValue: null, recommendedValue: true, advanced: true,
  },
  {
    id: 'codex.workspaceNetwork', client: 'codex', role: 'codex-config', path: ['sandbox_workspace_write', 'network_access'], section: '权限与沙箱',
    label: '工作区沙箱联网', description: '在 workspace-write 模式下允许工具访问网络。',
    control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.writableRoots', client: 'codex', role: 'codex-config', path: ['sandbox_workspace_write', 'writable_roots'], section: '权限与沙箱',
    label: '额外可写目录', description: '除当前工作区外允许写入的绝对路径，每行一个。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.windowsSandbox', client: 'codex', role: 'codex-config', path: ['windows', 'sandbox'], section: '权限与沙箱',
    label: 'Windows 原生沙箱', description: '原生 Windows 上优先使用 elevated；设置失败或无管理员权限时可选 unelevated。', control: 'select',
    options: [option('elevated', '增强隔离', '推荐的 Windows 沙箱', true), option('unelevated', '普通隔离', '无管理员权限时的兼容模式')],
    defaultValue: null, recommendedValue: 'elevated', advanced: true,
  },
  {
    id: 'codex.webSearch', client: 'codex', role: 'codex-config', path: ['web_search'], section: '工具与联网',
    label: '网页搜索', description: '控制网页搜索使用缓存索引、受控外网或实时网络。', control: 'select',
    options: [
      option('disabled', '关闭', '不提供网页搜索'), option('cached', '缓存索引', '使用预索引结果，暴露面较低', true),
      option('indexed', '受控联网', '由搜索索引判断是否访问外网'), option('live', '实时联网', '获取最新网页结果'),
    ], defaultValue: null, recommendedValue: 'cached',
  },
  {
    id: 'codex.projectDocMaxBytes', client: 'codex', role: 'codex-config', path: ['project_doc_max_bytes'], section: '项目上下文',
    label: '项目指引读取上限', description: '首次提示中最多加载多少字节的 AGENTS.md 内容。',
    control: 'number', min: 0, step: 1024, defaultValue: null, recommendedValue: 32768, advanced: true,
  },
  {
    id: 'codex.projectDocFallbacks', client: 'codex', role: 'codex-config', path: ['project_doc_fallback_filenames'], section: '项目上下文',
    label: '项目指引备用文件名', description: '某级目录没有 AGENTS.md 时依次尝试的备用文件名。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.projectRootMarkers', client: 'codex', role: 'codex-config', path: ['project_root_markers'], section: '项目上下文',
    label: '项目根标记', description: '向上寻找项目根目录时识别的文件或目录名。',
    control: 'string-list', defaultValue: null, recommendedValue: ['.git'], advanced: true,
  },
  {
    id: 'codex.fileOpener', client: 'codex', role: 'codex-config', path: ['file_opener'], section: '界面体验',
    label: '文件链接打开方式', description: '终端输出中的文件引用点击后交给哪个编辑器。', control: 'select',
    options: [
      option('vscode', 'VS Code', '使用 vscode://'), option('vscode-insiders', 'VS Code Insiders'),
      option('windsurf', 'Windsurf'), option('cursor', 'Cursor'), option('none', '不生成链接'),
    ], defaultValue: null, advanced: true,
  },
  {
    id: 'codex.hideAgentReasoning', client: 'codex', role: 'codex-config', path: ['hide_agent_reasoning'], section: '界面体验',
    label: '隐藏推理事件', description: '不在输出中显示内部推理事件。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.showRawReasoning', client: 'codex', role: 'codex-config', path: ['show_raw_agent_reasoning'], section: '界面体验',
    label: '显示原始推理', description: '模型提供原始推理内容时将其显示；通常保持关闭。',
    control: 'toggle', defaultValue: null, recommendedValue: false, advanced: true,
  },
  {
    id: 'codex.disablePasteBurst', client: 'codex', role: 'codex-config', path: ['disable_paste_burst'], section: '界面体验',
    label: '关闭快速粘贴检测', description: '关闭终端对突发大量键入的粘贴识别。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'codex.checkUpdates', client: 'codex', role: 'codex-config', path: ['check_for_update_on_startup'], section: '界面体验',
    label: '启动时检查 Codex 更新', description: 'Codex CLI 启动时检查自身更新。',
    control: 'toggle', defaultValue: null, recommendedValue: true, advanced: true,
  },
  {
    id: 'codex.notifications', client: 'codex', role: 'codex-config', path: ['notify'], section: '界面体验',
    label: '外部通知命令', description: '任务事件发生时调用的外部通知程序及参数，每行一个 argv 元素。',
    control: 'string-list', defaultValue: null, advanced: true,
  },
  ...[
    ['apps', '应用连接器', '启用应用与连接器集成', true],
    ['goals', '持久目标', '启用目标记录和自动续跑', true],
    ['hooks', '生命周期 Hooks', '启用 hooks.json 或内联 Hooks', true],
    ['fast_mode', 'Fast 模式', '启用 Fast 档位选择', true],
    ['memories', '记忆', '启用实验性的跨会话记忆', false],
    ['multi_agent', '多代理协作', '启用子代理协作工具', true],
    ['personality', '个性选择', '启用交流风格选择控件', true],
    ['remote_plugin', '远程插件目录', '启用远程插件目录', true],
    ['shell_snapshot', 'Shell 快照', '缓存 Shell 环境以加快重复命令', true],
    ['shell_tool', 'Shell 工具', '启用默认 Shell 工具', true],
    ['unified_exec', '统一执行终端', '使用 PTY 驱动的统一命令执行工具', true],
  ].map(([key, label, description, recommended]) => ({
    id: `codex.feature.${key}`,
    client: 'codex' as const,
    role: 'codex-config' as const,
    path: ['features', String(key)],
    section: '功能开关',
    label: String(label),
    description: String(description),
    control: 'toggle' as const,
    defaultValue: null,
    recommendedValue: Boolean(recommended),
    advanced: true,
  })),
  {
    id: 'codex.agentsMaxThreads', client: 'codex', role: 'codex-config', path: ['agents', 'max_threads'], section: '多代理',
    label: '最大并发代理数', description: '允许同时保持打开的代理线程上限。',
    control: 'number', min: 1, max: 64, step: 1, defaultValue: null, recommendedValue: 6, advanced: true,
  },
  {
    id: 'codex.agentsMaxDepth', client: 'codex', role: 'codex-config', path: ['agents', 'max_depth'], section: '多代理',
    label: '代理嵌套深度', description: '子代理继续派生下级代理的最大层数；提高会增加扇出和用量。',
    control: 'number', min: 0, max: 8, step: 1, defaultValue: null, recommendedValue: 1, advanced: true,
  },
  {
    id: 'codex.agentsJobTimeout', client: 'codex', role: 'codex-config', path: ['agents', 'job_max_runtime_seconds'], section: '多代理',
    label: '批量代理超时', description: 'spawn_agents_on_csv 每个工作代理的默认最长运行秒数。',
    control: 'number', min: 1, step: 1, defaultValue: null, recommendedValue: 1800, advanced: true,
  },
  {
    id: 'codex.agentsInterruptMessage', client: 'codex', role: 'codex-config', path: ['agents', 'interrupt_message'], section: '多代理',
    label: '记录中断消息', description: '代理被中断时在模型上下文中记录可见消息。',
    control: 'toggle', defaultValue: null, recommendedValue: true, advanced: true,
  },

  // Gemini CLI
  {
    id: 'gemini.model', client: 'gemini', role: 'gemini-settings', path: ['model', 'name'], section: '模型与会话',
    label: '默认模型', description: 'Gemini CLI 新会话默认使用的模型；留空时由客户端选择。',
    control: 'text', placeholder: '使用客户端默认模型', defaultValue: null,
  },
  {
    id: 'gemini.maxSessionTurns', client: 'gemini', role: 'gemini-settings', path: ['model', 'maxSessionTurns'], section: '模型与会话',
    label: '会话最大轮数', description: '限制单个会话允许的模型轮数；留空时不额外限制。',
    control: 'number', min: 1, step: 1, defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.approvalMode', client: 'gemini', role: 'gemini-settings', path: ['general', 'defaultApprovalMode'], section: '权限',
    label: '默认审批模式', description: '决定工具调用和文件编辑需要何种确认。', control: 'select',
    options: [
      option('default', '默认', '敏感操作正常询问', true),
      option('auto_edit', '自动编辑', '自动批准文件编辑'),
      option('plan', '计划模式', '只规划，不直接执行修改'),
    ], defaultValue: null, recommendedValue: 'default',
  },
  {
    id: 'gemini.vimMode', client: 'gemini', role: 'gemini-settings', path: ['general', 'vimMode'], section: '体验',
    label: 'Vim 输入模式', description: '在交互输入框启用 Vim 风格键位。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.enableAutoUpdate', client: 'gemini', role: 'gemini-settings', path: ['general', 'enableAutoUpdate'], section: '更新与通知',
    label: '自动更新', description: '允许 Gemini CLI 自动检查并安装更新。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.enableNotifications', client: 'gemini', role: 'gemini-settings', path: ['general', 'enableNotifications'], section: '更新与通知',
    label: '系统通知', description: '允许 Gemini CLI 在任务完成等事件时发送系统通知。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.maxAttempts', client: 'gemini', role: 'gemini-settings', path: ['general', 'maxAttempts'], section: '模型与会话',
    label: '最大尝试次数', description: '请求或工具流程失败时允许的最大尝试次数。',
    control: 'number', min: 1, max: 10, step: 1, defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.allowedTools', client: 'gemini', role: 'gemini-settings', path: ['tools', 'allowed'], section: '工具',
    label: '允许工具', description: '无需额外限制即可使用的工具名称，每行一个。', control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.excludedTools', client: 'gemini', role: 'gemini-settings', path: ['tools', 'exclude'], section: '工具',
    label: '排除工具', description: '禁止 Gemini CLI 使用的工具名称，每行一个。', control: 'string-list', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.theme', client: 'gemini', role: 'gemini-settings', path: ['ui', 'theme'], section: '体验',
    label: '界面主题', description: 'Gemini CLI 终端界面的主题名称。', control: 'text', placeholder: '使用客户端默认主题', defaultValue: null,
  },
  {
    id: 'gemini.hideBanner', client: 'gemini', role: 'gemini-settings', path: ['ui', 'hideBanner'], section: '体验',
    label: '隐藏启动横幅', description: '启动时不显示品牌横幅。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.hideTips', client: 'gemini', role: 'gemini-settings', path: ['ui', 'hideTips'], section: '体验',
    label: '隐藏使用提示', description: '不在终端界面显示随机使用提示。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.usageStatistics', client: 'gemini', role: 'gemini-settings', path: ['privacy', 'usageStatisticsEnabled'], section: '隐私',
    label: '使用统计', description: '允许发送匿名使用统计以改进 Gemini CLI。', control: 'toggle', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.contextFileName', client: 'gemini', role: 'gemini-settings', path: ['context', 'fileName'], section: '项目上下文',
    label: '上下文文件名', description: '指定项目级上下文说明文件的名称。', control: 'text', placeholder: '例如 GEMINI.md', defaultValue: null, advanced: true,
  },
  {
    id: 'gemini.includeDirectories', client: 'gemini', role: 'gemini-settings', path: ['context', 'includeDirectories'], section: '项目上下文',
    label: '附加上下文目录', description: '额外纳入项目上下文的目录，每行一个。', control: 'string-list', defaultValue: null, advanced: true,
  },
])

export function clientConfigEditorFields(
  client: SupportedClient,
  existing: ExistingClientConfig,
): ClientConfigEditorField[] {
  const documents = new Map<ClientConfigFileRole, JsonObject>()
  const catalogFields = definitionsFor(client).map((definition) => {
    let root = documents.get(definition.role)
    if (!root) {
      const source = existing[definition.role]
      root = definition.role === 'codex-config'
        ? parseCodexToml(source ?? '')
        : parseJsonObject(source, definition.role)
      documents.set(definition.role, root)
    }
    return editorField(definition, normalizedValue(valueAt(root, definition.path), definition.control))
  })
  if (client !== 'codex') return catalogFields
  const root = documents.get('codex-config') ?? parseCodexToml(existing['codex-config'] ?? '')
  return [...catalogFields, ...discoveredCodexFields(root)]
}

export function applyClientConfigFieldPatches(
  client: SupportedClient,
  existing: ExistingClientConfig,
  patches: ClientConfigFieldPatch[],
): ExistingClientConfig {
  if (patches.length > 100) throw new ClientConfigValidationError('Too many client configuration fields were submitted')
  const definitions = new Map(definitionsFor(client).map((definition) => [definition.id, definition]))
  const seen = new Set<string>()
  const result = { ...existing }
  const grouped = new Map<ClientConfigFileRole, Array<{ definition: FieldDefinition; value: ClientConfigFieldValue }>>()
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new ClientConfigValidationError('A client configuration field was submitted more than once')
    seen.add(patch.id)
    const definition = definitions.get(patch.id)
    if (!definition) throw new ClientConfigValidationError('Unknown client configuration field')
    if (definition.readOnly) throw new ClientConfigValidationError('A Stone+-managed client configuration field is read-only')
    const value = validateValue(definition, patch.value)
    const values = grouped.get(definition.role) ?? []
    values.push({ definition, value })
    grouped.set(definition.role, values)
  }

  for (const [role, values] of grouped) {
    if (role === 'codex-config') {
      result[role] = patchCodexTomlPaths(result[role], values.map(({ definition, value }) => ({
        path: definition.path,
        value,
      }))).content
      continue
    }
    result[role] = mutateJsonObject(result[role], role, (root) => {
      for (const { definition, value } of values) setJsonPath(root, definition.path, value, role)
    }).content
  }
  return result
}

function editorField(definition: FieldDefinition, value: ClientConfigFieldValue): ClientConfigEditorField {
  return {
    id: definition.id,
    role: definition.role,
    path: definition.path,
    section: definition.section,
    label: definition.label,
    description: definition.description,
    control: definition.control,
    value,
    source: 'catalog',
    ...(definition.options ? { options: withCurrentOption(definition.options, value) } : {}),
    ...(definition.placeholder ? { placeholder: definition.placeholder } : {}),
    ...(definition.defaultValue !== undefined ? { defaultValue: definition.defaultValue } : {}),
    ...(definition.recommendedValue !== undefined ? { recommendedValue: definition.recommendedValue } : {}),
    ...(definition.advanced ? { advanced: true } : {}),
    ...(definition.readOnly ? { readOnly: true } : {}),
    ...(definition.managedByStone ? { managedByStone: true } : {}),
    ...(definition.min !== undefined ? { min: definition.min } : {}),
    ...(definition.max !== undefined ? { max: definition.max } : {}),
    ...(definition.step !== undefined ? { step: definition.step } : {}),
  }
}

function withCurrentOption(
  options: ClientConfigFieldOption[],
  value: ClientConfigFieldValue,
): ClientConfigFieldOption[] {
  if (typeof value !== 'string' || options.some((candidate) => candidate.value === value)) return options
  return [...options, option(value, `当前值：${value}`, '较新客户端或自定义配置中的现有值')]
}

function discoveredCodexFields(root: JsonObject): ClientConfigEditorField[] {
  const known = new Set(definitionsFor('codex').map((definition) => pathIdentity(definition.path)))
  const discovered: ClientConfigEditorField[] = []
  visitDiscoveredValue(root, [], known, discovered)
  return discovered.sort((left, right) => left.path.join('.').localeCompare(right.path.join('.')))
}

function visitDiscoveredValue(
  value: unknown,
  path: string[],
  known: ReadonlySet<string>,
  result: ClientConfigEditorField[],
): void {
  if (path.length && known.has(pathIdentity(path)) && !isPlainObject(value)) return
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) visitDiscoveredValue(child, [...path, key], known, result)
    return
  }
  if (!path.length) return
  const sensitive = isSensitiveConfigPath(path) || containsSensitiveValue(value, path)
  const projected = sensitive ? null : discoveredValue(value)
  result.push({
    id: `codex.discovered.${path.map(encodeURIComponent).join('/')}`,
    role: 'codex-config',
    path,
    section: discoveredSection(path),
    label: path.at(-1) ?? path.join('.'),
    description: discoveredDescription(path, sensitive),
    control: discoveredControl(projected),
    value: projected,
    placeholder: sensitive ? '已安全隐藏' : undefined,
    advanced: true,
    readOnly: true,
    sensitive,
    managedByStone: isStoneManagedPath(path),
    source: 'discovered',
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function containsSensitiveValue(value: unknown, path: string[]): boolean {
  if (!value || typeof value !== 'object') return isSensitiveConfigPath(path)
  if (Array.isArray(value)) return value.some((child, index) => containsSensitiveValue(child, [...path, String(index)]))
  return Object.entries(value).some(([key, child]) => containsSensitiveValue(child, [...path, key]))
}

function discoveredValue(value: unknown): ClientConfigFieldValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function discoveredControl(value: ClientConfigFieldValue): ClientConfigFieldControl {
  if (typeof value === 'boolean') return 'toggle'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'string-list'
  return 'text'
}

function discoveredSection(path: string[]): string {
  const sections: Record<string, string> = {
    model_providers: '模型供应商（扩展）',
    mcp_servers: 'MCP 服务（扩展）',
    features: '功能开关（扩展）',
    agents: '多代理（扩展）',
    profiles: 'Codex Profiles（扩展）',
    projects: '项目配置（扩展）',
    plugins: '插件（扩展）',
    marketplaces: '插件市场（扩展）',
    tui: '终端界面（扩展）',
    shell_environment_policy: '命令环境（扩展）',
  }
  return sections[path[0]] ?? '现有扩展项'
}

function discoveredDescription(path: string[], sensitive: boolean): string {
  const fullPath = path.join('.')
  if (sensitive) return `${fullPath} 是凭据或敏感连接项，当前值已隐藏；可在右侧受保护的完整文件中保留或替换。`
  const descriptions: Record<string, string> = {
    model_providers: '自定义模型供应商的连接或能力参数',
    mcp_servers: 'MCP 服务的启动、连接或工具配置',
    features: '当前 Codex 版本识别的额外功能开关',
    agents: '自定义代理角色或额外的多代理参数',
    profiles: 'Codex 原生配置 Profile 覆盖项',
    projects: '特定项目的信任或行为设置',
    plugins: '已安装插件的配置',
    marketplaces: '插件市场来源配置',
    tui: 'Codex 终端界面的高级设置',
    shell_environment_policy: '传递给命令的环境变量策略',
  }
  const meaning = descriptions[path[0]] ?? 'Stone+ 尚未收录的当前 Codex 配置'
  return `${fullPath}：${meaning}。Stone+ 会原样保留，可在完整文件编辑器中修改。`
}

function isStoneManagedPath(path: string[]): boolean {
  return pathIdentity(path) === pathIdentity(['model_provider'])
    || pathIdentity(path) === pathIdentity(['cli_auth_credentials_store'])
    || (path[0] === 'model_providers' && path[1] === 'stone')
}

function pathIdentity(path: readonly string[]): string {
  return JSON.stringify(path)
}

function definitionsFor(client: SupportedClient): FieldDefinition[] {
  return fields.filter((field) => field.client === client)
}

function valueAt(root: JsonObject, path: string[]): unknown {
  let current: unknown = root
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as JsonObject)[part]
  }
  return current
}

function normalizedValue(value: unknown, control: ClientConfigFieldControl): ClientConfigFieldValue {
  if (control === 'toggle') return typeof value === 'boolean' ? value : null
  if (control === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null
  if (control === 'string-list') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
  }
  return typeof value === 'string' ? value : null
}

function validateValue(definition: FieldDefinition, value: ClientConfigFieldValue): ClientConfigFieldValue {
  if (value === null) return null
  if (definition.control === 'toggle') {
    if (typeof value !== 'boolean') throw new ClientConfigValidationError('A toggle client setting must be true or false')
    return value
  }
  if (definition.control === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ClientConfigValidationError('A numeric client setting must be a finite number')
    }
    if (definition.min !== undefined && value < definition.min) throw new ClientConfigValidationError('A numeric client setting is below its minimum')
    if (definition.max !== undefined && value > definition.max) throw new ClientConfigValidationError('A numeric client setting is above its maximum')
    if (definition.step === 1 && !Number.isInteger(value)) throw new ClientConfigValidationError('A numeric client setting must be an integer')
    return value
  }
  if (definition.control === 'string-list') {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new ClientConfigValidationError('A client setting list is invalid')
    }
    return value.map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value !== 'string' || value.length > 10_000) throw new ClientConfigValidationError('A client setting value is invalid')
  if (definition.control === 'select' && !definition.options?.some((candidate) => candidate.value === value)) {
    throw new ClientConfigValidationError('A client setting option is invalid')
  }
  return value
}

function setJsonPath(
  root: JsonObject,
  path: string[],
  value: ClientConfigFieldValue,
  role: ClientConfigFileRole,
): void {
  let parent = root
  for (const part of path.slice(0, -1)) parent = objectField(parent, part, role)
  const key = path.at(-1)
  if (!key) throw new ClientConfigValidationError('A client setting path is invalid')
  if (value === null) delete parent[key]
  else parent[key] = value
}
