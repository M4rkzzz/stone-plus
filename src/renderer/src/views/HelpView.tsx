import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Globe2,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  Maximize2,
  MonitorCog,
  Network,
  Play,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Unplug,
  Waypoints,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { AppSnapshot, ClientConfigStatus, GatewayApi } from '@shared/types'
import type { PageId } from '../App'
import { evaluateHelpReadiness, type HelpReadiness } from '../help-readiness'
import { useI18n } from '../i18n'
import { PageHeader } from '../ui'
import demoGif from '../../../../docs/media/stone-demo.gif'
import accountsScreenshot from '../../../../docs/screenshots/accounts.png'
import browserScreenshot from '../../../../docs/screenshots/browser.png'
import clientsScreenshot from '../../../../docs/screenshots/clients.png'
import diagnosticsScreenshot from '../../../../docs/screenshots/diagnostics.png'
import onlineUpdateScreenshot from '../../../../docs/screenshots/online-update.png'
import overviewScreenshot from '../../../../docs/screenshots/overview.png'
import poolsScreenshot from '../../../../docs/screenshots/pools.png'
import routesScreenshot from '../../../../docs/screenshots/routes.png'
import setupScreenshot from '../../../../docs/screenshots/setup-wizard.png'
import '../help-view.css'

type HelpViewProps = {
  snapshot: AppSnapshot
  api: GatewayApi
  navigate: (page: PageId) => void
}

type Translate = <T>(chinese: T, english: T) => T

type TopicId =
  | 'quick-start'
  | 'providers'
  | 'proxies'
  | 'pools'
  | 'routes'
  | 'clients'
  | 'session-repair'
  | 'tunnel'
  | 'browser'
  | 'diagnostics'
  | 'requests'
  | 'settings'
  | 'updates'
  | 'faq'

type TopicGroup = '开始使用' | '配置链路' | '实用工具' | '维护与排障'

type Topic = {
  id: TopicId
  group: TopicGroup
  title: string
  summary: string
  icon: LucideIcon
  page?: PageId
  keywords: string
  headings: Array<{ id: string; label: string }>
}

const topics: Topic[] = [
  {
    id: 'quick-start', group: '开始使用', title: '快速开始', icon: Sparkles,
    summary: '从零完成来源、号池、路由、网关和客户端配置。', page: 'setup',
    keywords: '新手 入门 第一次 三分钟 向导 流程 最低配置 请求链路',
    headings: [{ id: 'understand-flow', label: '先理解一条请求' }, { id: 'first-run', label: '第一次配置' }, { id: 'verify-ready', label: '怎样算配置成功' }],
  },
  {
    id: 'providers', group: '配置链路', title: '账号与中转', icon: Boxes,
    summary: '添加 ChatGPT、API Key 和中转来源，管理状态、配额与模型。', page: 'providers',
    keywords: '账号 OAuth Token JSON API Key 官方 中转 CPA Sub2API 批量 导入 配额 模型 标签',
    headings: [{ id: 'choose-source', label: '选择来源类型' }, { id: 'add-source', label: '添加与验证' }, { id: 'manage-accounts', label: '日常管理' }],
  },
  {
    id: 'proxies', group: '配置链路', title: '出口代理', icon: Waypoints,
    summary: '按账号或号池指定代理，并用内置检测确认网络可达。', page: 'proxies',
    keywords: '代理 HTTP HTTPS SOCKS5 网络 出口 系统代理 直连 测试',
    headings: [{ id: 'proxy-needed', label: '什么时候需要代理' }, { id: 'proxy-create', label: '添加并测试' }, { id: 'proxy-assign', label: '绑定与排错' }],
  },
  {
    id: 'pools', group: '配置链路', title: '号池', icon: Network,
    summary: '把多个账号组成一个可调度来源，设置均衡、优先级与重试。', page: 'pools',
    keywords: '号池 调度 均衡 智能均衡 优先级 轮询 权重 并发 重试 粘性会话 聚合',
    headings: [{ id: 'pool-meaning', label: '号池是什么' }, { id: 'pool-create', label: '创建号池' }, { id: 'pool-strategy', label: '策略怎么选' }],
  },
  {
    id: 'routes', group: '配置链路', title: '路由', icon: RouteIcon,
    summary: '把客户端协议映射到来源，并控制模型映射和本地访问令牌。', page: 'routes',
    keywords: '路由 Codex Claude Gemini 协议 映射 模型 本地 Token 启用 来源',
    headings: [{ id: 'route-meaning', label: '路由的作用' }, { id: 'route-create', label: '创建与启用' }, { id: 'route-models', label: '模型与协议' }],
  },
  {
    id: 'clients', group: '配置链路', title: '客户端配置', icon: MonitorCog,
    summary: '无损切换上游；配置异常时自动备份并一键修复连接。', page: 'clients',
    keywords: '客户端 Codex Claude Code Gemini CLI 配置文件 反代 上游 切换 修复 Profile 备份 恢复',
    headings: [{ id: 'client-before', label: '先看当前状态' }, { id: 'client-apply', label: '一键修复连接' }, { id: 'client-backup', label: '恢复与高级设置' }],
  },
  {
    id: 'session-repair', group: '实用工具', title: '会话修复', icon: Wrench,
    summary: '旧会话更换账号或来源后无法继续时，修复本地会话关联。', page: 'session-repair',
    keywords: '会话修复 ChatGPT Codex 401 conversation previous_response_id 重启',
    headings: [{ id: 'repair-when', label: '什么时候使用' }, { id: 'repair-how', label: '修复步骤' }, { id: 'repair-safe', label: '安全与回退' }],
  },
  {
    id: 'tunnel', group: '实用工具', title: '内网穿透', icon: Share2,
    summary: '把本机网关临时提供给其他设备，并掌握暴露范围与关闭方法。', page: 'tunnel',
    keywords: '内网穿透 tunnel 远程 其他设备 公网 地址 安全 Windows',
    headings: [{ id: 'tunnel-use', label: '适用场景' }, { id: 'tunnel-start', label: '启动与连接' }, { id: 'tunnel-security', label: '安全检查' }],
  },
  {
    id: 'browser', group: '实用工具', title: '内置浏览器', icon: Globe2,
    summary: '在应用内下载账号文件，并把下载结果批量导入 StonePlus。', page: 'browser',
    keywords: '内置浏览器 下载 文件 导入 登录 CPA Sub2API 历史 隔离',
    headings: [{ id: 'browser-purpose', label: '能做什么' }, { id: 'browser-import', label: '下载并导入' }, { id: 'browser-privacy', label: '登录与隐私' }],
  },
  {
    id: 'diagnostics', group: '维护与排障', title: '诊断', icon: Stethoscope,
    summary: '检查本地链路、网络出口和上游可达性，得到可操作结果。', page: 'diagnostics',
    keywords: '诊断 网络测试 可达 401 超时 DNS TLS 代理 端口 上游',
    headings: [{ id: 'diagnose-first', label: '先做哪种检查' }, { id: 'diagnose-read', label: '看懂结果' }, { id: 'diagnose-fix', label: '按结果修复' }],
  },
  {
    id: 'requests', group: '维护与排障', title: '请求记录', icon: Activity,
    summary: '查看成功、错误、流式状态、耗时、Token 与实际命中的账号。', page: 'requests',
    keywords: '请求日志 记录 错误 延迟 首字 Token 模型 账号 streaming active 活跃',
    headings: [{ id: 'logs-read', label: '记录包含什么' }, { id: 'logs-filter', label: '筛选与定位' }, { id: 'logs-privacy', label: '负载与隐私' }],
  },
  {
    id: 'settings', group: '维护与排障', title: '设置', icon: Settings,
    summary: '管理监听地址、端口、开机启动、超时、备份和数据安全。', page: 'settings',
    keywords: '设置 网关 host port 端口 自动启动 开机启动 超时 日志 备份 导入导出 密钥库',
    headings: [{ id: 'settings-gateway', label: '网关与启动' }, { id: 'settings-data', label: '数据与备份' }, { id: 'settings-safe', label: '安全建议' }],
  },
  {
    id: 'updates', group: '维护与排障', title: '检查更新', icon: Zap,
    summary: '在线检查、下载并安装新版，了解平台差异和失败回退。', page: 'settings',
    keywords: '更新 升级 下载 安装 版本 Release 自动检查 重启 校验',
    headings: [{ id: 'update-check', label: '在线更新' }, { id: 'update-before', label: '更新前准备' }, { id: 'update-failed', label: '更新失败' }],
  },
  {
    id: 'faq', group: '维护与排障', title: '常见问题', icon: CircleHelp,
    summary: '高频现象、直接原因与逐步解决办法。',
    keywords: 'FAQ 常见问题 解决 失败 卡住 1个活跃请求 401 403 429 timeout 端口 模型',
    headings: [{ id: 'faq-startup', label: '启动与连接' }, { id: 'faq-requests', label: '请求与账号' }, { id: 'faq-config', label: '配置与更新' }],
  },
]

const groups: TopicGroup[] = ['开始使用', '配置链路', '实用工具', '维护与排障']
const groupEnglish: Record<TopicGroup, string> = {
  '开始使用': 'Getting started',
  '配置链路': 'Request setup',
  '实用工具': 'Tools',
  '维护与排障': 'Maintenance and troubleshooting',
}

type TopicEnglishCopy = Pick<Topic, 'title' | 'summary' | 'keywords' | 'headings'>

const topicEnglish: Record<TopicId, TopicEnglishCopy> = {
  'quick-start': {
    title: 'Quick start', summary: 'Set up a source, pool, route, gateway, and client from scratch.',
    keywords: 'beginner first time quick start wizard workflow minimum setup request path',
    headings: [{ id: 'understand-flow', label: 'Understand one request' }, { id: 'first-run', label: 'First-time setup' }, { id: 'verify-ready', label: 'How to know it works' }],
  },
  providers: {
    title: 'Accounts and relays', summary: 'Add ChatGPT, API key, and relay sources; manage health, quota, and models.',
    keywords: 'account OAuth Token JSON API Key official relay CPA Sub2API batch import quota models tags',
    headings: [{ id: 'choose-source', label: 'Choose a source type' }, { id: 'add-source', label: 'Add and verify' }, { id: 'manage-accounts', label: 'Ongoing management' }],
  },
  proxies: {
    title: 'Outbound proxies', summary: 'Assign proxies to accounts or pools and verify connectivity with built-in tests.',
    keywords: 'proxy HTTP HTTPS SOCKS5 network exit system proxy direct connection test',
    headings: [{ id: 'proxy-needed', label: 'When a proxy is needed' }, { id: 'proxy-create', label: 'Add and test' }, { id: 'proxy-assign', label: 'Assignment and troubleshooting' }],
  },
  pools: {
    title: 'Pools', summary: 'Combine accounts into a schedulable source with balancing, priority, and retry controls.',
    keywords: 'pool scheduling balance smart balance priority round robin weight concurrency retry sticky session aggregate',
    headings: [{ id: 'pool-meaning', label: 'What a pool is' }, { id: 'pool-create', label: 'Create a pool' }, { id: 'pool-strategy', label: 'Choose a strategy' }],
  },
  routes: {
    title: 'Routes', summary: 'Map client protocols to sources and control model mapping and local access tokens.',
    keywords: 'route Codex Claude Gemini protocol mapping model local token enabled source',
    headings: [{ id: 'route-meaning', label: 'What routes do' }, { id: 'route-create', label: 'Create and enable' }, { id: 'route-models', label: 'Models and protocols' }],
  },
  clients: {
    title: 'Client configuration', summary: 'Switch upstreams safely and repair connections with automatic backups.',
    keywords: 'client Codex Claude Code Gemini CLI config file reverse proxy upstream switch repair profile backup restore',
    headings: [{ id: 'client-before', label: 'Check the current status' }, { id: 'client-apply', label: 'Repair connection' }, { id: 'client-backup', label: 'Restore and advanced settings' }],
  },
  'session-repair': {
    title: 'Session repair', summary: 'Repair local session links when old conversations stop working after changing accounts or sources.',
    keywords: 'session repair ChatGPT Codex 401 conversation previous_response_id restart',
    headings: [{ id: 'repair-when', label: 'When to use it' }, { id: 'repair-how', label: 'Repair steps' }, { id: 'repair-safe', label: 'Safety and rollback' }],
  },
  tunnel: {
    title: 'Remote tunnel', summary: 'Temporarily expose the local gateway to another device and close it safely afterward.',
    keywords: 'tunnel remote another device public address security Windows',
    headings: [{ id: 'tunnel-use', label: 'Use cases' }, { id: 'tunnel-start', label: 'Start and connect' }, { id: 'tunnel-security', label: 'Security checklist' }],
  },
  browser: {
    title: 'Built-in browser', summary: 'Download account files in the app and import the completed downloads in batches.',
    keywords: 'built in browser download files import login CPA Sub2API history isolation',
    headings: [{ id: 'browser-purpose', label: 'What it can do' }, { id: 'browser-import', label: 'Download and import' }, { id: 'browser-privacy', label: 'Sign-in and privacy' }],
  },
  diagnostics: {
    title: 'Diagnostics', summary: 'Check the local path, network exit, and upstream reachability with actionable results.',
    keywords: 'diagnostics network test reachable 401 timeout DNS TLS proxy port upstream',
    headings: [{ id: 'diagnose-first', label: 'Which check to run first' }, { id: 'diagnose-read', label: 'Read the results' }, { id: 'diagnose-fix', label: 'Fix by result' }],
  },
  requests: {
    title: 'Request history', summary: 'Inspect success, errors, streaming state, latency, tokens, and the account actually selected.',
    keywords: 'request log history error latency first token model account streaming active',
    headings: [{ id: 'logs-read', label: 'What a record contains' }, { id: 'logs-filter', label: 'Filter and locate issues' }, { id: 'logs-privacy', label: 'Payloads and privacy' }],
  },
  settings: {
    title: 'Settings', summary: 'Manage the listen address, port, startup, timeouts, backups, and data security.',
    keywords: 'settings gateway host port auto start login timeout logs backup import export keychain',
    headings: [{ id: 'settings-gateway', label: 'Gateway and startup' }, { id: 'settings-data', label: 'Data and backups' }, { id: 'settings-safe', label: 'Security guidance' }],
  },
  updates: {
    title: 'Check for updates', summary: 'Check, download, and install releases; understand platform differences and recovery options.',
    keywords: 'update upgrade download install version release automatic check restart verify',
    headings: [{ id: 'update-check', label: 'Online update' }, { id: 'update-before', label: 'Before updating' }, { id: 'update-failed', label: 'Update failed' }],
  },
  faq: {
    title: 'FAQ', summary: 'Common symptoms, likely causes, and step-by-step fixes.',
    keywords: 'FAQ common issue solution failed stuck active request 401 403 429 timeout port model',
    headings: [{ id: 'faq-startup', label: 'Startup and connection' }, { id: 'faq-requests', label: 'Requests and accounts' }, { id: 'faq-config', label: 'Configuration and updates' }],
  },
}

function localizeTopics(t: Translate): Topic[] {
  return topics.map((topic) => {
    const english = topicEnglish[topic.id]
    return {
      ...topic,
      title: t(topic.title, english.title),
      summary: t(topic.summary, english.summary),
      keywords: t(topic.keywords, english.keywords),
      headings: topic.headings.map((heading, index) => ({
        ...heading,
        label: t(heading.label, english.headings[index]?.label ?? heading.label),
      })),
    }
  })
}

const tunnelSupported = !window.stone || window.stonePlatform === 'win32'

const helpEnglish = new Map<string, string>([
  // Shared document UI and diagrams.
  ['使用手册', 'User guide'],
  ['搜索结果', 'Search results'],
  ['选择要查看的章节', 'Choose a section to read'],
  ['搜索会匹配功能名、操作目标、常见现象和错误关键词。', 'Search matches feature names, tasks, common symptoms, and error keywords.'],
  ['打开功能', 'Open feature'],
  ['照着操作仍没解决？', 'Still not fixed?'],
  ['先运行“一键诊断”，再到“请求记录”查看最近一次错误的状态码和错误详情。', 'Run Diagnostics first, then open Request History and inspect the latest error code and details.'],
  ['去诊断 ', 'Run diagnostics '],
  ['点击放大', 'Click to enlarge'],
  ['来源', 'Source'], ['号池', 'Pool'], ['路由', 'Route'], ['网关', 'Gateway'], ['客户端', 'Client'],
  ['配置时从左到右准备；真正发请求时从客户端反向进入 StonePlus。', 'Prepare the pieces from left to right. At request time, traffic enters StonePlus from the client in the opposite direction.'],
  ['本地网关', 'Local gateway'], ['路由与来源', 'Routes and sources'], ['自动检测', 'Automatic check'],

  // Quick start.
  ['第一次使用不必逐页研究。最省事的方法是打开新手向导，按页面提示准备一个可用来源，然后让 StonePlus 自动建立最小链路。', 'You do not need to study every page before using StonePlus. The simplest path is to open the setup wizard, add one usable source, and let StonePlus build the minimum working request path.'],
  ['StonePlus 从向导到配置完成的操作演示', 'StonePlus setup wizard walkthrough'],
  ['完整流程动图：环境扫描、选择来源、验证网络、建立路由、启动网关并写入客户端。', 'Full walkthrough: scan the environment, choose a source, verify the network, create a route, start the gateway, and configure the client.'],
  ['先理解一条请求', 'Understand one request'],
  ['请求从客户端经过网关、路由、号池到达来源的动画示意', 'Animation showing a request moving through the gateway, route, and pool to a source'],
  ['把 StonePlus 想成一个本地总机：', 'Think of StonePlus as a local switchboard: '],
  ['提供账号或 API；', ' provides an account or API; '],
  ['决定多个账号怎么轮换；', ' decides how multiple accounts are selected; '],
  ['决定某个客户端该走哪个来源；', ' sends each client to the right source; '],
  ['在本机接收请求；最后由', ' receives requests locally; and '],
  ['客户端配置', 'client configuration'],
  ['把 Codex、Claude Code 或 Gemini CLI 指向网关。', ' points Codex, Claude Code, or Gemini CLI at the gateway.'],
  ['不一定必须手动建号池', 'You do not always need to create a pool'],
  ['官方 API 或单个中转可以直接作为路由来源；多个 ChatGPT 账号需要号池。顶部助手会按实际来源类型判断，不会要求多余步骤。', 'A single official API or relay can be routed directly. Multiple ChatGPT accounts need a pool. The assistant checks the actual source type and will not ask for unnecessary steps.'],
  ['第一次配置', 'First-time setup'],
  ['打开新手向导', 'Open the setup wizard'],
  ['点击本页顶部“打开新手向导”，先让系统扫描客户端目录和本机网络。', 'Use the button at the top of this page and let StonePlus scan client directories and the local network.'],
  ['添加一个来源', 'Add one source'],
  ['可用 ChatGPT OAuth 登录、Token JSON、官方 API Key 或兼容中转。按向导中的“测试”确认凭据与网络。', 'Use ChatGPT OAuth, Token JSON, an official API key, or a compatible relay. Run the wizard test to verify both credentials and network access.'],
  ['确认调度与路由', 'Confirm scheduling and routing'],
  ['多个账号选择号池策略；选择你实际使用的客户端和模型，向导会创建并启用匹配路由。', 'Choose a pool policy for multiple accounts, then select the client and model you actually use. The wizard creates and enables the matching route.'],
  ['启动网关并真实验证', 'Start the gateway and run a real test'],
  ['向导会启动本地网关，并发送一次端到端测试；看到响应预览才表示上游链路真的跑通。', 'The wizard starts the local gateway and sends an end-to-end test. The path is truly working only when a response preview appears.'],
  ['一键接好客户端', 'Connect the client'],
  ['选择客户端后点“一键修复连接”；StonePlus 会先备份，并只处理必要连接字段。', 'Choose the client and select Repair connection. StonePlus creates a backup first and only changes the fields required for the connection.'],
  ['现在开始配置', 'Start setup now'], ['检查当前环境', 'Check this environment'],
  ['StonePlus 新手向导界面', 'StonePlus setup wizard'],
  ['左侧显示完整步骤，主区域一次只要求完成当前任务；随时退出也会保留非敏感进度。', 'The left side shows every step while the main area focuses on one task. Exiting keeps non-sensitive progress.'],
  ['怎样算配置成功', 'How to know setup works'], ['最低可用的五个信号', 'Five signs of a working setup'],
  ['不要只看“保存成功”，要确认整条链路', 'Do not stop at Saved; verify the whole request path'],
  ['来源可用', 'Source is usable'], ['：至少一个账号未禁用、未过期，或一个 API / 中转来源可用。', ': at least one account is enabled and unexpired, or an API/relay source is available.'],
  ['路由来源可用', 'Route source is usable'], ['：号池中有启用成员，或路由可以直接使用 API / 中转。', ': a pool has an enabled member, or the route can use an API/relay directly.'],
  ['路由已启用', 'Route is enabled'], ['：客户端类型正确，并且指向上面的可用来源。', ': its client type is correct and it points to a usable source.'],
  ['网关运行中', 'Gateway is running'], ['：总览显示实际监听地址与端口。', ': Overview shows the actual listen address and port.'],
  ['客户端已配置', 'Client is configured'], ['：对应客户端的检测结果显示“已配置”。', ': the matching client check reports Configured.'],
  ['最后做一次真实请求', 'Finish with one real request'],
  ['在客户端发送一句简短消息，然后到“请求记录”确认状态为成功、命中的来源和模型符合预期。仅网络测试成功不等于完整请求一定成功。', 'Send a short message from the client, then confirm in Request History that it succeeded and used the expected source and model. A successful network test alone does not prove a complete request will work.'],
  ['StonePlus 总览页面', 'StonePlus Overview'],
  ['日常首先看总览：网关状态、启用路由、账号健康和最近请求会集中显示。', 'Start with Overview during day-to-day use. It brings gateway status, enabled routes, account health, and recent requests together.'],

  // Accounts and relays.
  ['“来源”是 StonePlus 能调用模型的凭据入口。一个来源可以是 ChatGPT 账号、官方 API Key，也可以是 OpenAI / Anthropic / Gemini 兼容中转。', 'A source is the credential StonePlus uses to call a model. It can be a ChatGPT account, an official API key, or an OpenAI-, Anthropic-, or Gemini-compatible relay.'],
  ['选择来源类型', 'Choose a source type'], ['ChatGPT 账号', 'ChatGPT account'],
  ['优先用 OAuth 登录；已有 Token JSON 可直接导入。适合 Codex / ChatGPT 订阅账号。', 'Prefer OAuth sign-in. You can also import an existing Token JSON file. This is intended for Codex/ChatGPT subscription accounts.'],
  ['官方 API', 'Official API'], ['填写服务商 API Key 与基础地址，适合按量计费和稳定生产调用。', 'Enter the provider API key and base URL for metered, production-oriented use.'],
  ['兼容中转', 'Compatible relay'], ['填写中转地址、密钥、协议和模型。添加前确认服务商明确支持目标协议。', 'Enter the relay URL, key, protocol, and model. Confirm that the provider explicitly supports the protocol you need.'],
  ['凭据不要混用', 'Do not mix credential types'],
  ['OAuth / Token JSON 与普通 API Key 的登录方式、刷新方式不同。不要把 OAuth access token 当作中转 API Key 粘贴。', 'OAuth/Token JSON credentials and ordinary API keys use different sign-in and refresh flows. Do not paste an OAuth access token into a relay API-key field.'],
  ['添加与验证', 'Add and verify'], ['OAuth 登录 ChatGPT', 'Sign in to ChatGPT with OAuth'], ['浏览器授权完成后自动回到 StonePlus', 'Return to StonePlus automatically after browser authorization'],
  ['选择“登录 ChatGPT”', 'Choose Sign in to ChatGPT'], ['可先选择账号标签、目标号池和网络出口。', 'You can choose an account tag, target pool, and network exit first.'],
  ['在浏览器完成授权', 'Complete authorization in the browser'], ['不要关闭 StonePlus；授权页面完成后等待应用自动交换凭据。', 'Keep StonePlus open. After authorization, wait for the app to exchange the credentials.'],
  ['检查检测结果', 'Review the check results'], ['确认账号名、到期时间、可刷新状态和模型信息；有警告时先展开查看。', 'Confirm the account name, expiry, refresh status, and model information. Expand any warning before continuing.'],
  ['批量导入 Token JSON / 文件', 'Batch import Token JSON/files'], ['先解析，再确认导入去向', 'Parse first, then confirm where accounts will be added'],
  ['可以粘贴 JSON、选择文件，或从内置浏览器的下载记录导入。预览阶段会识别重复账号、无效文件和代理信息；确认后才写入。', 'Paste JSON, choose files, or import from built-in browser downloads. The preview identifies duplicates, invalid files, and proxy data before anything is written.'],
  ['批量导入建议', 'Batch import tip'], ['先建立标签与号池，再在导入时一次分配。重复账号默认更新同一记录，不需要先删除旧账号。', 'Create tags and pools first so you can assign them during import. Duplicate accounts update the existing record by default; you do not need to delete the old account.'],
  ['添加官方 API 或中转', 'Add an official API or relay'], ['基础地址、协议、密钥、模型缺一不可', 'The base URL, protocol, key, and model must all be correct'],
  ['基础地址填服务商文档给出的 API 根地址，不要多拼一次 ', 'Use the API root from the provider documentation. Do not append '],
  ['。', '.'],
  ['协议按真实接口选择 OpenAI Responses、OpenAI Chat、Anthropic Messages 或 Gemini。', 'Choose OpenAI Responses, OpenAI Chat, Anthropic Messages, or Gemini according to the actual endpoint.'],
  ['先点连接 / 模型测试，再保存；测试失败不会破坏现有来源。', 'Run the connection/model test before saving. A failed test does not damage existing sources.'],
  ['模型留空或写错会导致客户端模型无法命中，保存后再刷新一次模型。', 'A missing or incorrect model can prevent client requests from matching. Refresh the model list after saving.'],
  ['StonePlus 账号与中转管理页面', 'StonePlus accounts and relays page'], ['账号卡集中显示状态、配额、模型、并发、代理和所属标签；批量操作不会要求逐个打开。', 'Account cards show status, quota, models, concurrency, proxy, and tags together. Batch actions do not require opening every account.'],
  ['日常管理', 'Ongoing management'], ['状态', 'Status'], ['“可用”可参与调度；“冷却”会临时跳过；“禁用 / 过期”不会被选择。', 'Available accounts can be scheduled; Cooling down accounts are skipped temporarily; Disabled/Expired accounts are not selected.'],
  ['优先级与权重', 'Priority and weight'], ['优先级由号池策略解释；权重只在加权策略中影响选择概率。', 'Priority is interpreted by the pool strategy. Weight affects selection only in weighted strategies.'],
  ['最大并发', 'Maximum concurrency'], ['限制同一账号同时处理的请求数，达到上限后调度其他账号或等待。', 'Limits simultaneous requests on one account. At the limit, StonePlus schedules another account or waits.'],
  ['模型策略', 'Model policy'], ['全部模型最省事；白名单适合只允许已验证模型，避免请求错误模型。', 'All models is simplest. Use an allowlist when only verified models should be accepted.'],
  ['标签', 'Tags'], ['仅用于整理和批量分配，不改变路由结果。', 'Tags organize accounts and support batch assignment; they do not change routing.'],
  ['修改后如何确认生效', 'How to verify a change'], ['刷新账号状态，再到“号池”确认成员仍启用。发送一个测试请求，在请求记录中核对实际命中的账号。', 'Refresh account status, confirm the member is still enabled in its pool, then send a test request and verify which account was selected in Request History.'],
  ['管理账号与中转', 'Manage accounts and relays'],

  // Outbound proxies.
  ['代理是可选项。直连能稳定访问上游时不要为了“完整配置”而添加代理；只有网络受限、服务商要求固定出口或需要按账号隔离出口时才使用。', 'Proxies are optional. If direct access is stable, do not add one just to make the setup look complete. Use a proxy only for restricted networks, a provider-required fixed exit, or account-level exit isolation.'],
  ['什么时候需要代理', 'When a proxy is needed'], ['建议直连', 'Use direct connection'], ['诊断中目标均可达、延迟稳定，账号没有地域限制。', 'Diagnostic targets are reachable with stable latency and the account has no region restriction.'],
  ['建议代理', 'Use a proxy'], ['连接超时 / TLS 失败、上游区域受限，或不同账号必须固定不同出口。', 'Connections time out, TLS fails, the upstream is region-restricted, or accounts must use separate fixed exits.'],
  ['代理可连不等于上游可用', 'A reachable proxy does not prove the upstream works'], ['代理“测试成功”通常只证明代理服务器可握手。随后还要到“诊断”选择这个出口，检查真实 GPT / OAuth 目标。', 'A successful proxy test usually proves only that StonePlus can connect to the proxy server. Select the same exit in Diagnostics and test the real GPT/OAuth targets.'],
  ['添加并测试', 'Add and test'], ['准备连接信息', 'Prepare connection details'], ['确认协议（HTTP / HTTPS / SOCKS5）、主机、端口，以及可选的用户名和密码。', 'Confirm the protocol (HTTP/HTTPS/SOCKS5), host, port, and optional username and password.'],
  ['新建出口代理', 'Create an outbound proxy'], ['不要把 http://、路径或 PAC 地址放进“主机”；只填写主机名或 IP。', 'Enter only a hostname or IP in Host; do not include http://, a path, or a PAC URL.'],
  ['运行连接测试', 'Run the connection test'], ['查看延迟、出口 IP 和最近错误。密码只显示是否已保存，不会明文回显。', 'Check latency, exit IP, and the latest error. Passwords are never shown again in plain text.'],
  ['到诊断页复测', 'Retest in Diagnostics'], ['选择刚建立的代理，确认 OpenAI、ChatGPT 与 OAuth 所需目标符合你的用途。', 'Select the new proxy and verify the OpenAI, ChatGPT, and OAuth targets required by your workflow.'],
  ['绑定与排错', 'Assignment and troubleshooting'], ['代理绑定在哪里', 'Where to assign a proxy'], ['精确到账号最稳妥，号池适合统一出口', 'Account-level assignment is most precise; use a pool for a shared exit'],
  ['可以在账号上指定代理，也可以给号池指定统一代理。账号已经指定代理时，账号设置优先；都没有指定时，按设置中的出站网络模式使用直连或系统代理。', 'Assign a proxy to an account or to a whole pool. An account-level proxy overrides the pool. If neither is set, the outbound network setting chooses direct access or the system proxy.'],
  ['同一批账号要求固定出口：逐账号绑定。', 'Accounts that require fixed exits: assign each account.'], ['整个号池共用一条稳定链路：号池绑定。', 'A whole pool sharing one stable path: assign the pool.'], ['想跟随 Windows / macOS 系统网络：设置中选择系统网络模式。', 'To follow Windows/macOS networking, choose System in outbound network settings.'],
  ['测试失败怎么排', 'Troubleshoot a failed test'], ['按从近到远的顺序检查', 'Check from the nearest component outward'],
  ['先检查代理软件是否运行、端口是否监听。', 'Confirm the proxy application is running and its port is listening.'], ['核对协议，SOCKS 端口不能按 HTTP 添加。', 'Verify the protocol; a SOCKS port cannot be configured as HTTP.'], ['核对用户名、密码与 IP 白名单。', 'Verify the username, password, and IP allowlist.'], ['在诊断页比较直连与代理结果；直连成功而代理失败说明问题在代理链路。', 'Compare direct and proxy results in Diagnostics. If direct works and the proxy fails, the proxy path is the problem.'], ['若只有 OAuth 失败，换支持该域名和 HTTPS CONNECT 的节点。', 'If only OAuth fails, use a node that supports the required domain and HTTPS CONNECT.'],
  ['打开出口代理', 'Open outbound proxies'], ['用实际出口诊断', 'Diagnose with the actual exit'],

  // Pools.
  ['号池把多个账号包装成一个稳定来源。客户端不需要知道本次用了哪个账号；StonePlus 会按策略选择可用成员，并在允许时切换或重试。', 'A pool presents several accounts as one stable source. The client does not need to know which account was selected; StonePlus chooses an available member and can switch or retry when allowed.'],
  ['号池是什么', 'What a pool is'], ['三个账号汇入号池再输出一个稳定来源的动画示意', 'Animation of three accounts becoming one stable pool source'], ['我的号池', 'My pool'], ['一个稳定入口', 'One stable entry point'],
  ['API / 中转不总需要号池', 'APIs and relays do not always need a pool'], ['单个官方 API 或中转可以直接作为路由来源。只有希望合并多个账号、统一重试或调度时才建立号池。', 'A single official API or relay can be routed directly. Create a pool when you need to combine accounts or apply shared scheduling and retry behavior.'],
  ['创建号池', 'Create a pool'], ['选择协议', 'Choose a protocol'], ['协议必须与成员来源兼容，也要能转换到目标客户端的入站协议。', 'The protocol must match the member sources and be convertible to the target client protocol.'],
  ['选择成员', 'Choose members'], ['只加入你确认可用的账号；成员可临时关闭而不必从号池删除。', 'Add only accounts you know work. A member can be disabled temporarily without removing it.'],
  ['选择策略', 'Choose a strategy'], ['新手优先选择智能均衡或优先级。没有明确目标时不要同时改很多高级参数。', 'Smart balancing or priority is a good starting point. Do not change several advanced controls at once without a specific goal.'],
  ['设置失败处理', 'Set failure handling'], ['重试次数过高会放大等待时间；先使用默认值，结合请求记录调整。', 'Too many retries increase wait time. Start with the defaults and adjust using Request History.'],
  ['保存并用于路由', 'Save and use it in a route'], ['创建号池本身不会接收客户端请求，必须有一条启用路由指向它。', 'A pool does not receive client requests by itself. An enabled route must point to it.'],
  ['StonePlus 号池与调度策略页面', 'StonePlus pools and scheduling page'], ['成员、模型范围、调度策略、粘性会话与重试集中配置；高级项按需展开。', 'Configure members, model scope, scheduling, sticky sessions, and retries together. Expand advanced controls only when needed.'],
  ['策略怎么选', 'Choose a strategy'], ['策略', 'Strategy'], ['适合情况', 'Best for'], ['你会看到的行为', 'Behavior'],
  ['智能均衡', 'Smart balance'], ['大多数多账号场景', 'Most multi-account setups'], ['结合在途请求、近期速度与健康状态，自动避开拥堵成员。', 'Uses in-flight work, recent speed, and health to avoid congested members.'],
  ['优先级', 'Priority'], ['主账号优先、备用账号兜底', 'Primary account with fallbacks'], ['优先用高优先级可用成员，必要时才落到下一层。', 'Uses the highest-priority available member and falls back only when needed.'],
  ['轮询', 'Round robin'], ['账号能力相近，希望平均轮换', 'Similar accounts that should rotate evenly'], ['按顺序选择可用成员，行为直观。', 'Selects available members in order.'],
  ['加权', 'Weighted'], ['账号额度或性能差异明确', 'Accounts with known quota or performance differences'], ['权重越大，被选中的机会越高；仍会受可用性与并发限制。', 'Higher weight increases selection frequency, subject to health and concurrency limits.'],
  ['粘性会话、对冲和首包超时', 'Sticky sessions, hedging, and first-byte timeout'], ['高级功能，先理解再开启', 'Advanced controls; understand them before enabling'],
  ['粘性会话', 'Sticky sessions'], ['让同一会话在一段时间内尽量使用同一账号，适合依赖上游会话上下文的调用。', ' keep a conversation on the same account for a period, which helps calls that depend on upstream session context.'],
  ['对冲请求', 'Hedged requests'], ['在首个请求迟迟不返回时并行尝试另一个成员，可能降低尾延迟，也可能增加调用量。', ' try another member in parallel when the first is slow. This may reduce tail latency but can increase usage.'],
  ['首包超时', 'First-byte timeout'], ['只控制多久没收到响应体时触发处理，不等于整个请求的总超时。', ' controls how long to wait for response data; it is not the total request timeout.'],
  ['管理号池', 'Manage pools'],

  // Routes.
  ['路由回答三个问题：哪种客户端发来的请求、用哪种协议接收、交给哪个来源。路由保存但未启用时不会参与请求。', 'A route answers three questions: which client sent the request, which protocol StonePlus receives, and which source handles it. A saved but disabled route does not receive traffic.'],
  ['路由的作用', 'What routes do'], ['Codex 路由', 'Codex route'], ['智能号池', 'Smart pool'],
  ['Codex、Claude Code 或 Gemini CLI；客户端配置只会选择同类型启用路由。', 'Codex, Claude Code, or Gemini CLI. Client setup only uses an enabled route for the same client type.'],
  ['入站协议', 'Inbound protocol'], ['StonePlus 在本地接收的请求格式，通常按客户端默认值即可。', 'The format StonePlus accepts locally. The client default is usually correct.'],
  ['路由来源', 'Route source'], ['一个号池，或可直接路由的官方 API / 中转。', 'A pool or a directly routable official API/relay.'],
  ['本地令牌', 'Local token'], ['客户端访问本机网关使用的密钥，不是上游账号凭据。', 'The secret a client uses to access the local gateway; it is not an upstream credential.'],
  ['创建与启用', 'Create and enable'], ['选择客户端', 'Choose a client'], ['与你真正使用的工具一致；每个客户端至少保留一条明确启用的路由。', 'Match the tool you actually use. Keep at least one clearly enabled route for each client.'],
  ['选择可用来源', 'Choose a usable source'], ['下拉列表只应选择当前有可用账号的号池或有效 API / 中转。', 'Choose a pool with an available account or a valid API/relay.'],
  ['确认协议', 'Confirm the protocol'], ['新手保留推荐协议；只有上游或客户端有特殊兼容要求时才修改。', 'Keep the recommended protocol unless the upstream or client has a specific compatibility requirement.'],
  ['保存并启用', 'Save and enable'], ['启用后到客户端配置页应用配置，再发送真实请求。', 'After enabling it, apply the client configuration and send a real request.'],
  ['同一客户端多条路由', 'Multiple routes for one client'], ['请明确哪条需要启用，并检查模型映射是否会产生歧义。排障时可临时只保留一条启用路由，先把链路跑通。', 'Be explicit about which route is enabled and avoid ambiguous model mappings. During troubleshooting, temporarily keep one route enabled until the path works.'],
  ['StonePlus 路由管理页面', 'StonePlus routes page'], ['路由卡会显示客户端、入站协议、目标来源、模型映射和启用状态。', 'Route cards show the client, inbound protocol, target source, model mappings, and enabled state.'],
  ['模型与协议', 'Models and protocols'], ['模型映射什么时候用', 'When to use model mapping'], ['客户端模型名与上游模型名不同才需要', 'Only when the client and upstream use different model names'],
  ['例如客户端请求一个固定别名，而中转只接受另一模型名，可以建立“请求模型 → 上游模型”的映射。没有映射时 StonePlus 会尽量保留原模型名。', 'If a client requests a fixed alias but the relay accepts a different model name, map requested model → upstream model. Without a mapping, StonePlus preserves the requested name when possible.'],
  ['先在来源 / 号池确认目标模型允许使用。', 'Confirm the target model is allowed by the source or pool.'], ['映射目标必须是上游真实接受的模型 ID，不要只填显示名称。', 'The target must be a real upstream model ID, not just a display name.'], ['出现 model_not_found 时，先在请求记录核对最终模型，再修改映射。', 'For model_not_found, check the final model in Request History before changing the mapping.'],
  ['本地令牌与上游密钥的区别', 'Local token vs. upstream key'], ['客户端只应拿到本地令牌', 'The client should receive only the local token'],
  ['客户端配置写入的是路由的本地令牌，请求到达 StonePlus 后才在本地安全存储中取上游凭据。不要把上游 OAuth Token 或 API Key 手工写进客户端配置。', 'Client files contain the route local token. StonePlus reads upstream credentials from secure local storage only after a request arrives. Never put an upstream OAuth token or API key directly in client configuration.'],
  ['打开路由', 'Open routes'], ['下一步：配置客户端', 'Next: configure a client'],

  // Client configuration.
  ['客户端配置页把日常操作收成两件事：', 'The client configuration page focuses everyday work on two actions: '], ['切换当前上游', 'switch the current upstream'], ['，或在客户端连不上时点', ', or select '], ['一键修复连接', 'Repair connection'], ['。高级编辑器默认收起，不需要理解 TOML、JSON 或环境变量也能完成配置。', ' when a client cannot connect. The advanced editor stays collapsed, so no TOML, JSON, or environment-variable knowledge is required.'],
  ['先看当前状态', 'Check the current status'], ['顶部 Tab 选择 Codex、Claude Code 或 Gemini CLI；默认打开 Codex。', 'Choose Codex, Claude Code, or Gemini CLI from the tabs; Codex opens by default.'],
  ['“当前上游”显示这个客户端正在使用的号池、官方 API 或中转站。', 'Current upstream shows the pool, official API, or relay used by this client.'], ['“配置正常”表示必要连接字段已能把客户端指向当前 StonePlus 网关。', 'Configuration OK means the required fields point the client at the current StonePlus gateway.'], ['显示“配置损坏”或“尚未配置”时，直接使用“一键修复连接”。', 'If it reports a damaged or missing configuration, use Repair connection.'],
  ['切换上游不会再改坏客户端文件', 'Switching upstreams does not rewrite client files'], ['下拉选择新上游时，StonePlus 只原子更新内部路由；不会重写 ', 'Choosing a new upstream only updates the internal route atomically. It does not rewrite '], ['、', ', '], [' 或 ', ' or '], ['，客户端始终稳定连接本地 StonePlus。', '; the client remains connected to local StonePlus.'],
  ['一键修复连接', 'Repair connection'], ['备份、修复、重启、验证四步动画示意', 'Four-step animation: back up, repair, restart, verify'], ['自动备份', 'Back up'], ['修复连接', 'Repair'], ['重启客户端', 'Restart client'], ['发送验证', 'Verify'],
  ['选择出问题的客户端', 'Choose the affected client'], ['顶部 Tab 切换客户端，StonePlus 会自动检测默认配置目录和文件健康状态。', 'Use the tabs to switch clients. StonePlus detects the default directory and file health automatically.'],
  ['点击“一键修复连接”', 'Select Repair connection'], ['StonePlus 先备份现有文件；文件有效时只修复本地地址和本地令牌，模型、MCP、插件等用户设置保持不变。', 'StonePlus backs up existing files first. If they parse correctly, it changes only the local address and token; models, MCP, plugins, and other user settings remain intact.'],
  ['损坏文件自动重建', 'Rebuild damaged files safely'], ['若文件已经无法解析，会保留原始备份，再重建一份能连接 StonePlus 的最小配置。需要时可恢复修复前版本。', 'If a file cannot be parsed, StonePlus preserves the original and creates a minimal working configuration. You can restore the pre-repair version later.'],
  ['重启客户端并验证', 'Restart and verify'], ['大多数 CLI 只在启动时读取配置。完全退出后重新打开，再发送一条短请求。', 'Most CLI tools read configuration only at startup. Exit completely, reopen the client, and send one short request.'],
  ['StonePlus 超级易用客户端配置', 'StonePlus client configuration page'], ['默认页只保留上游切换、连接状态和修复入口；完整编辑器收在高级设置中。', 'The default view shows upstream switching, connection status, and repair. Full editors are under Advanced settings.'],
  ['恢复与高级设置', 'Restore and advanced settings'], ['修复后想退回怎么办', 'How to undo a repair'], ['恢复最近备份', 'Restore the latest backup'],
  ['检测到需要写入时，StonePlus 会先把已有相关文件保存为同一备份组。“恢复最近备份”会先给当前状态再做一次安全快照，然后整组恢复，避免 config/auth 或 settings/env 混用不同版本。', 'Before writing, StonePlus saves related files as one backup group. Restore latest backup first snapshots the current state, then restores the group together so paired files never come from different versions.'],
  ['什么时候才需要展开高级设置', 'When to use advanced settings'], ['多目录、手工字段和完整源码编辑', 'Multiple directories, manual fields, and full source editing'],
  ['普通用户不需要展开。只有便携版配置目录、多套 Profile、手工调整模型/MCP/沙箱，或需要查看完整脱敏预览时再进入；未知设置仍会保留。', 'Most users can leave this closed. Use it for portable directories, multiple profiles, manual model/MCP/sandbox changes, or a full redacted preview. Unknown settings are still preserved.'],
  ['什么时候建立 Profile', 'When to create a profile'], ['多套安装目录或不同用途才需要', 'Only for multiple installations or distinct uses'],
  ['默认 Profile 适合标准安装路径。便携版、测试目录、多个用户环境可各建一个 Profile，并独立设置目录和备份保留数量。Profile 只是本地配置模板，不包含上游明文凭据。', 'The default profile fits standard installs. Create separate profiles for portable builds, test directories, or different user environments, each with its own directory and backup retention. Profiles do not contain plaintext upstream credentials.'],
  ['没有“恢复出厂配置”', 'There is no factory reset for client files'], ['StonePlus 不会用一套大而全的模板覆盖你的文件。“一键修复连接”只处理连接链路；无法解析时才重建最小文件，并且始终先留备份。', 'StonePlus never overwrites your files with a large generic template. Repair connection changes only the connection path; it creates a minimal file only when parsing fails, and always backs up first.'],
  ['打开客户端配置', 'Open client configuration'],

  // Session repair.
  ['会话修复是', 'Session repair is an '], ['按需工具', 'on-demand tool'], ['，不是首次运行必做项。它用于客户端仍记着旧 provider / 旧地址，导致新请求能用但旧会话无法继续的情况。', ', not a required first-run step. Use it when a client still refers to an old provider or address, so new conversations work but old ones cannot continue.'],
  ['什么时候使用', 'When to use it'], ['适合修复', 'Good repair candidate'], ['换到 StonePlus 后只有旧 Codex 会话报 provider、401 或关联错误；新会话正常。', 'After switching to StonePlus, only old Codex conversations fail with provider, 401, or linkage errors while new conversations work.'],
  ['不要先修复', 'Do not repair first'], ['所有新旧请求都失败、网关未运行、账号过期或网络诊断失败；先解决基础链路。', 'All new and old requests fail, the gateway is stopped, the account is expired, or diagnostics fail. Fix the basic path first.'],
  ['先验证新会话', 'Test a new conversation first'], ['新建一个最小对话。如果新会话也失败，会话文件通常不是根因，请先看诊断和请求记录。', 'Start a minimal new conversation. If it also fails, session files are probably not the cause; inspect Diagnostics and Request History first.'],
  ['修复步骤', 'Repair steps'], ['关闭 ChatGPT / Codex', 'Close ChatGPT/Codex'], ['确保相关进程不再写入会话文件或 SQLite 数据库。', 'Make sure related processes are no longer writing session files or SQLite databases.'],
  ['打开会话修复并扫描', 'Open Session Repair and scan'], ['系统会检查 Codex Home、rollout 文件、索引和数据库，先给出只读预览。', 'StonePlus checks Codex Home, rollout files, indexes, and databases, then presents a read-only preview.'],
  ['选择目标 provider', 'Choose the target provider'], ['确认目标是当前 StonePlus 配置，不要在不清楚来源时批量替换。', 'Confirm it matches the current StonePlus configuration. Do not run a bulk replacement if the source is unclear.'],
  ['查看影响范围', 'Review the scope'], ['核对待更新文件数、数据库行数、跳过项目和安全备份说明。', 'Check the number of files and database rows, skipped items, and backup details.'],
  ['执行修复并重启', 'Repair and restart'], ['修复完成后重新打开客户端，用原会话发送一条消息。', 'After repair, reopen the client and send one message in the original conversation.'],
  ['安全与回退', 'Safety and rollback'], ['修复会改什么', 'What repair changes'], ['只调整本地 provider / 路由关联，不改聊天正文', 'Only local provider/route links, never conversation text'],
  ['预览会列出 rollout 与 SQLite 中需要修改的关联字段。工具会跳过无法识别或无法安全处理的内容，并记录备份 / 跳过数量。', 'The preview lists the rollout and SQLite relationship fields that will change. Unrecognized or unsafe content is skipped, and backup/skip counts are recorded.'],
  ['修复后仍失败', 'If it still fails'], ['用新旧会话对比定位', 'Compare new and old conversations'], ['确认客户端已经完全重启。', 'Confirm the client was fully restarted.'], ['比较新会话与旧会话在请求记录中的模型、路由和错误。', 'Compare model, route, and error details for new and old conversations in Request History.'], ['若没有任何请求到达 StonePlus，到客户端配置页一键修复连接。', 'If no request reaches StonePlus, repair the client connection.'], ['若到达但上游 401 / 429，处理账号或配额，而不是重复修复会话。', 'If it arrives but returns upstream 401/429, fix the account or quota instead of repeating session repair.'],
  ['打开会话修复', 'Open Session Repair'],

  // Tunnel and built-in browser.
  ['内网穿透把本机 StonePlus 网关临时映射为其他设备能访问的地址。它适合短期远程使用或局域网外测试，不应替代长期、受控的服务部署。', 'A tunnel temporarily gives another device access to the local StonePlus gateway. It is suitable for short remote use or testing outside the LAN, not as a permanent managed deployment.'],
  ['适用场景', 'Use cases'], ['另一台设备临时调用', 'Temporary access from another device'], ['StonePlus 运行在主机，笔记本或测试机通过穿透地址访问。', 'StonePlus runs on the host while a laptop or test machine uses the tunnel URL.'],
  ['短时间验证集成', 'Short integration test'], ['无需修改路由器，验证外部客户端是否能正确使用本地路由。', 'Test whether an external client can use local routes without changing the router.'],
  ['不适合公开分享', 'Not for public sharing'], ['地址和本地令牌都属于访问凭据，不要发布到群聊、截图或公共仓库。', 'The URL and local token are both access credentials. Never post them in chats, screenshots, or public repositories.'],
  ['启动与连接', 'Start and connect'], ['先完成本地链路', 'Make the local path work first'], ['本机客户端必须能请求成功；穿透无法修复来源、路由或网关问题。', 'A local client must already succeed. A tunnel cannot fix source, route, or gateway problems.'],
  ['打开内网穿透并启动', 'Open Remote Tunnel and start it'], ['等待状态变为运行中，复制系统生成的远程地址。该功能可能仅在受支持的桌面平台显示。', 'Wait for Running, then copy the generated remote URL. This feature may appear only on supported desktop platforms.'],
  ['配置远程客户端', 'Configure the remote client'], ['用远程地址替换本地 Base URL，同时使用目标路由的本地令牌。', 'Replace the local Base URL with the remote URL and use the target route local token.'],
  ['发送短请求', 'Send a short request'], ['在 StonePlus 请求记录中确认远程请求到达；测试完成立即停止穿透。', 'Confirm the remote request appears in StonePlus Request History, then stop the tunnel immediately after testing.'],
  ['安全检查', 'Security checklist'], ['只启用确实需要的路由，并为本地令牌按凭据级别保密。', 'Enable only required routes and protect local tokens like credentials.'], ['不使用时停止穿透；地址失效后再从远程客户端移除。', 'Stop the tunnel when not in use, then remove the expired URL from remote clients.'], ['请求记录不要长期启用完整负载日志，尤其是远程多人使用时。', 'Do not keep full payload logging enabled, especially with multiple remote users.'], ['出现未知请求立即停止穿透、轮换路由本地令牌并检查日志。', 'If an unknown request appears, stop the tunnel, rotate the local token, and inspect logs.'],
  ['监听所有网卡与穿透是两回事', 'Listening on all interfaces is not the same as tunneling'], ['StonePlus 为保护本地凭据只允许 127.0.0.1、localhost 或 ::1，不接受 0.0.0.0。需要其他设备访问时请使用受控的内网穿透，不要直接暴露网关端口。', 'StonePlus accepts only 127.0.0.1, localhost, or ::1 to protect local credentials; it does not accept 0.0.0.0. Use the controlled tunnel instead of exposing the gateway port.'],
  ['打开内网穿透', 'Open Remote Tunnel'], ['当前平台不提供内网穿透', 'Remote Tunnel is unavailable on this platform'], ['内置穿透目前只在 Windows 桌面端启用；其他平台仍可正常使用本地网关与全部账号调度功能。', 'The built-in tunnel is currently enabled only on Windows desktop. Other platforms still support the local gateway and all scheduling features.'],
  ['内置浏览器的目标是缩短“网页下载账号文件 → 找到文件 → 批量导入”的路径。浏览、下载和导入是分开的，文件不会因为下载完成就自动写入账号库。', 'The built-in browser shortens the path from downloading account files to batch import. Browsing, downloading, and importing remain separate; a completed download is never added to your account library automatically.'],
  ['能做什么', 'What it can do'], ['网页访问', 'Browse pages'], ['在 StonePlus 内打开需要的账号管理 / 下载页面，保留当前操作上下文。', 'Open account management or download pages inside StonePlus and keep the current workflow together.'],
  ['下载管理', 'Manage downloads'], ['查看进行中、成功和失败的下载；文件完全落盘后才允许导入。', 'See active, successful, and failed downloads. Import is enabled only after the file is fully written.'],
  ['批量导入', 'Batch import'], ['勾选多个已完成文件，打开账号导入预览，统一设置标签、号池和代理。', 'Select completed files, preview account import, and assign tags, pools, and proxies together.'],
  ['StonePlus 内置浏览器与下载管理页面', 'StonePlus built-in browser and download manager'], ['浏览器主区与下载抽屉在同一页面；下载完成后可勾选文件批量送往账号导入。', 'The browser and download drawer share one page. Select completed files and send them to account import in a batch.'],
  ['下载并导入', 'Download and import'], ['打开可信页面', 'Open a trusted page'], ['核对地址栏域名，不在不可信页面输入账号、验证码或密钥。', 'Check the address-bar domain. Never enter accounts, verification codes, or keys on an untrusted page.'],
  ['等待下载完成', 'Wait for completion'], ['只有状态显示完成、文件大小稳定后再勾选；失败项可查看原因并重新下载。', 'Select a file only after its status is complete and size is stable. Inspect and retry failed downloads.'],
  ['选择“导入到账号”', 'Choose Import to accounts'], ['浏览器只是把文件交给账号导入器，此时仍可取消。', 'The browser only hands files to the importer; you can still cancel.'],
  ['检查解析预览', 'Review the parse preview'], ['确认识别账号数、重复项、警告、目标号池 / 标签和代理策略。', 'Confirm the account count, duplicates, warnings, target pool/tag, and proxy policy.'],
  ['确认导入', 'Confirm import'], ['导入后去账号页刷新状态，删除不再需要的下载文件。', 'Refresh account status after import, then delete download files you no longer need.'],
  ['登录与隐私', 'Sign-in and privacy'], ['浏览器登录状态', 'Browser sign-in state'], ['把它当作独立的应用内浏览环境', 'Treat it as a separate in-app browser environment'],
  ['内置浏览器的 Cookie / 登录会话可能与日常浏览器不同。完成敏感操作后主动退出网站；公用电脑上不要勾选长期保持登录。', 'Its cookies and sessions may differ from your usual browser. Sign out after sensitive work and never choose persistent sign-in on a shared computer.'],
  ['下载项无法导入', 'A download cannot be imported'], ['不是所有下载文件都是账号文件', 'Not every downloaded file contains account data'],
  ['确认下载状态为完成且文件未被移动。', 'Confirm the download completed and the file has not moved.'], ['确认格式是账号导入器支持的 JSON / 文本结构，而不是网页、压缩包或错误页。', 'Confirm it is supported JSON/text, not a web page, archive, or error response.'], ['单独打开账号与中转页手工选择文件，可看到更详细的解析错误。', 'Choose the file manually on Accounts and Relays to see detailed parse errors.'], ['解析出 0 个账号时不要强行导入，回到来源网站重新导出。', 'If zero accounts are parsed, export the file again instead of forcing import.'],
  ['打开内置浏览器', 'Open built-in browser'], ['打开账号导入', 'Open account import'],

  // Diagnostics and request history.
  ['诊断页不会“猜一个原因”，而是把本地配置、所选网络出口和真实上游目标分层检查。排障时先诊断，再改配置，可以避免越改越乱。', 'Diagnostics does not guess one cause. It checks local configuration, the selected network exit, and real upstream targets as separate layers. Diagnose before changing settings to avoid making several unrelated changes.'],
  ['自动诊断动画示意', 'Automatic diagnostics animation'], ['先做哪种检查', 'Which check to run first'], ['保持问题现场', 'Preserve the failing state'], ['先不要批量删除账号或重建路由，记住刚才失败的客户端和出口。', 'Do not delete accounts or rebuild routes yet. Note the client and network exit that failed.'],
  ['选择实际网络出口', 'Choose the actual network exit'], ['账号走代理就选择相同代理；否则选择直连 / 系统网络。', 'Select the same proxy used by the account; otherwise choose direct/system networking.'],
  ['运行一键诊断', 'Run Diagnostics'], ['检查本地网关、可用来源、启用路由，以及 ChatGPT、Codex、OAuth 等网络目标。', 'Check the local gateway, usable sources, enabled routes, and network targets required by ChatGPT, Codex, and OAuth.'],
  ['展开失败项目', 'Expand the failed item'], ['记录错误类别、目标、耗时和建议；再去对应页面修复一项并复测。', 'Record the error category, target, duration, and suggestion. Fix one item on the relevant page and retest.'],
  ['StonePlus 一键诊断结果页面', 'StonePlus diagnostics results'], ['顶部给出整体结论，下方分别显示本地配置和网络目标；失败项带直接说明。', 'The summary appears at the top, followed by local and network checks. Failed items include a direct explanation.'],
  ['看懂结果', 'Read the results'], ['结果', 'Result'], ['含义', 'Meaning'], ['下一步', 'Next step'], ['正常', 'Healthy'], ['目标按预期响应；未必代表凭据有权调用所有模型。', 'The target responded as expected; this does not prove the credential can call every model.'], ['继续检查下一层，最后发真实请求。', 'Continue to the next layer and finish with a real request.'],
  ['需关注', 'Needs attention'], ['目标可达但响应不理想，或检查被代理模式跳过。', 'The target is reachable but the response is imperfect, or the selected proxy mode skipped the check.'], ['展开说明，确认是否符合当前出口设计。', 'Expand the details and confirm this matches the intended exit design.'],
  ['失败', 'Failed'], ['连接、DNS、TLS、超时或本地配置有明确错误。', 'There is a specific connection, DNS, TLS, timeout, or local configuration error.'], ['按错误类别修复，不要盲目更换模型。', 'Fix the reported category instead of changing models at random.'],
  ['为什么未携带 Token 收到 401 也可能是正常', 'Why a 401 without a token may be expected'], ['对仅检查接口可达性的项目，401 说明已经通过 DNS、连接和 TLS 到达服务端；它证明网络可达，不证明你的账号凭据有效。', 'For a reachability-only check, 401 proves that DNS, connection, and TLS reached the server. It proves network access, not credential validity.'],
  ['按结果修复', 'Fix by result'], ['DNS / 连接超时', 'DNS / connection timeout'], ['优先比较直连和代理', 'Compare direct and proxy access first'], ['检查本机网络与系统时间。', 'Check the local network and system clock.'], ['直连和目标代理各跑一次，比较是哪条出口失败。', 'Run both direct and target-proxy tests to identify the failing exit.'], ['确认代理协议 / 端口并检查防火墙。', 'Verify proxy protocol/port and firewall rules.'], ['网络恢复后重新诊断，StonePlus 会重建出站连接。', 'Run diagnostics again after recovery; StonePlus rebuilds outbound connections.'],
  ['TLS / 证书错误', 'TLS / certificate error'], ['检查代理拦截、系统时间与证书环境', 'Check proxy interception, system time, and trust store'], ['先关闭会做 HTTPS 解密的代理规则复测；公司网络需要自签根证书时，确认运行 StonePlus 的环境真正信任该证书。不要用关闭证书校验作为长期解决方案。', 'Retest without HTTPS-decryption proxy rules. If a corporate network uses a private root CA, ensure the environment running StonePlus trusts it. Do not disable certificate verification as a permanent fix.'],
  ['本地配置失败', 'Local configuration failed'], ['按助手顺序补齐来源、路由、网关与客户端', 'Complete source, route, gateway, and client in assistant order'], ['返回本页顶部“下一步助手”，点击第一项未完成任务。完成一项后重新检测，不必把所有高级设置都配置一遍。', 'Return to the assistant at the top and select the first incomplete task. Recheck after each item; advanced settings are not required.'],
  ['运行一键诊断', 'Run Diagnostics'], ['查看请求错误', 'View request errors'],
  ['请求记录是“客户端实际请求发生了什么”的证据。每条记录会关联客户端、路由后的来源 / 账号、模型、状态、延迟和可用的 Token 统计。', 'Request History is evidence of what actually happened to a client request. Each entry links the client, routed source/account, model, state, latency, and available token usage.'],
  ['记录包含什么', 'What a record contains'], ['请求从流式处理中变为成功的动画示意', 'Animation of a streaming request becoming successful'], ['账号 A · OpenAI Responses', 'Account A · OpenAI Responses'], ['流式 → 成功', 'Streaming → Success'],
  ['成功、错误或流式中。流式请求结束后会自动转为最终状态并释放活跃槽位。', 'Success, Error, or Streaming. A completed stream moves to a final state and releases its active slot.'], ['状态码 / 错误', 'Status code / error'], ['区分本地鉴权、路由、上游账号、限流和网络错误。', 'Distinguishes local authentication, routing, upstream account, rate-limit, and network errors.'],
  ['耗时', 'Timing'], ['总耗时、首字 / 首 Token、上游响应头等阶段指标帮助区分排队慢还是上游慢。', 'Total time, first byte/token, and upstream headers help distinguish queueing from upstream slowness.'], ['来源与账号', 'Source and account'], ['显示调度实际选中了谁；重试时可结合详情查看不同尝试。', 'Shows the member actually selected. Retry details show each attempt.'], ['上游提供统计时显示输入、缓存和输出；缺失不代表没有产生用量。', 'Shows input, cache, and output usage when provided upstream. Missing counts do not mean no usage occurred.'],
  ['筛选与定位', 'Filter and locate issues'], ['复现一次最小请求', 'Reproduce one minimal request'], ['记住发生时间、客户端和模型；不要连续发送很多相同请求。', 'Note the time, client, and model; do not send many duplicate requests.'], ['按状态与客户端筛选', 'Filter by status and client'], ['先只看错误，再缩小到刚才的客户端 / 时间范围。', 'Show errors first, then narrow to the client and time range.'], ['打开详情', 'Open details'], ['复制状态码和错误文本，核对路由、账号、最终模型以及各阶段耗时。', 'Copy the code and error text, then verify the route, account, final model, and stage timings.'], ['按类别跳转修复', 'Fix by category'], ['401 看凭据 / 本地令牌，404 看地址 / 模型，429 看配额与并发，超时看诊断和代理。', 'For 401 check credentials/local token; 404 address/model; 429 quota/concurrency; timeouts diagnostics/proxy.'], ['修复后只复测一次', 'Retest once'], ['用同一输入对比新旧记录，确认错误类别真正改变或消失。', 'Use the same input and compare records to confirm the error changed or disappeared.'],
  ['一直显示 1 个活跃请求怎么办', 'What if one request stays active?'], ['先刷新总览确认是否只是旧界面；再看最新记录是否仍是“流式”。若客户端已经收到完整结果，更新到包含流结束修复的最新版本并重启网关；若仍在传输，不要强制结束正常长请求。', 'Refresh Overview to rule out stale UI, then check whether the newest record is still Streaming. If the client already received the full result, update StonePlus and restart the gateway. Do not stop a legitimately active long request.'],
  ['负载与隐私', 'Payloads and privacy'], ['是否记录请求正文', 'Whether to log request bodies'], ['默认只需要元数据，排障时再短期开启', 'Metadata is normally enough; enable payloads only briefly'], ['设置中的“记录请求负载”可能保存提示词或响应内容。日常保持关闭；确需排查协议问题时短期开启，复现一次后立即关闭，并在分享日志前删除凭据和私人内容。', 'Request payload logging may store prompts and responses. Keep it off normally; enable it briefly for protocol troubleshooting, turn it off after one reproduction, and redact credentials/private content before sharing logs.'],
  ['日志太多如何处理', 'Handling too many logs'], ['先导出证据，再按设置清理', 'Export evidence, then clean up'], ['保留故障时间附近的记录和截图即可。清理历史不会删除账号、号池或路由，但会失去统计和排障证据。', 'Keep records and screenshots around the failure time. Clearing history does not remove accounts, pools, or routes, but it removes metrics and troubleshooting evidence.'],
  ['打开请求记录', 'Open Request History'],

  // Settings and updates.
  ['设置页控制本地网关如何启动、监听和保存数据。第一次使用保留默认值最稳妥，确认有明确需求后再改监听范围、负载日志和网络模式。', 'Settings controls how the local gateway starts, listens, and stores data. Defaults are safest for first-time use; change listen scope, payload logging, or network mode only for a specific need.'],
  ['网关与启动', 'Gateway and startup'], ['设置', 'Setting'], ['推荐值', 'Recommended'], ['什么时候修改', 'When to change it'], ['监听地址', 'Listen address'], ['仅当明确要让局域网设备访问，并已理解防火墙与令牌风险。', 'Only when LAN access is explicitly required and firewall/token risks are understood.'],
  ['端口', 'Port'], [' 或当前可用端口', ' or the current available port'], ['端口冲突时调整；修改后重新应用所有客户端配置。', 'Change it on a port conflict, then reapply every client configuration.'],
  ['自动启动网关', 'Start gateway automatically'], ['常用时开启', 'Enable for regular use'], ['只偶尔使用或需要手工控制服务时关闭。', 'Disable if you use StonePlus rarely or want manual service control.'],
  ['登录时启动应用', 'Launch app at login'], ['按习惯', 'Your preference'], ['希望开机后客户端立即可用时开启。', 'Enable when clients should work immediately after sign-in.'],
  ['连接 / 流空闲超时', 'Connection / stream idle timeout'], ['保留默认', 'Keep the default'], ['非流式请求按总时长控制；流式请求只在连接或连续无数据超过该时间时终止，持续返回内容的长任务不会被误切断。', 'Non-streaming requests use a total timeout. Streaming requests stop only after connection or data inactivity exceeds this time, so active long streams are not cut off.'],
  ['出站网络', 'Outbound network'], ['直连 / 系统模式择一', 'Direct or System'], ['需要跟随系统代理时选系统；账号 / 号池显式代理仍按其设置。', 'Choose System to follow the OS proxy. Explicit account/pool proxies still take precedence.'],
  ['设置显示端口和实际端口', 'Configured port vs. actual port'], ['运行中的真实地址以总览 / 网关状态为准。改端口后先重启网关，再到客户端配置页一键修复连接，避免客户端仍连旧端口。', 'Use the address shown in Overview/Gateway Status as the running truth. After changing the port, restart the gateway and repair client connections so they do not keep using the old port.'],
  ['数据与备份', 'Data and backups'], ['自动备份与保留数量', 'Automatic backups and retention'], ['保留足够回退点，但不要无限增长', 'Keep enough rollback points without unbounded growth'], ['自动备份用于本地配置和客户端文件的安全回退。建议保持开启并使用合理保留数；定期把重要导出放到受保护位置。', 'Automatic backups provide safe rollback for local and client configuration. Keep a reasonable retention count and periodically store important exports in a protected location.'],
  ['导出 / 导入配置', 'Export / import configuration'], ['迁移前先确认凭据处理方式', 'Understand credential handling before migration'], ['导出前查看说明，区分普通配置与敏感凭据。', 'Read the export description and distinguish ordinary settings from sensitive credentials.'], ['导入会影响现有来源、号池、路由或设置时，先做当前版本备份。', 'Back up the current state before importing changes to sources, pools, routes, or settings.'], ['迁移到另一台机器后重新检测客户端目录、网络出口和系统密钥库。', 'After moving machines, redetect client directories, network exits, and the system keychain.'], ['不要把包含敏感信息的导出提交到 Git 或网盘公开链接。', 'Never commit sensitive exports to Git or public cloud links.'],
  ['安全建议', 'Security guidance'], ['保持本机监听；只有明确需要时才扩大到局域网或穿透。', 'Keep local-only listening; expand access only for a clear need.'], ['本地令牌也属于凭据，不要贴到截图、Issue 和群聊。', 'Local tokens are credentials; keep them out of screenshots, issues, and chats.'], ['日常关闭完整请求负载日志，敏感排障完成后及时清理。', 'Keep full payload logging off and clean sensitive troubleshooting data promptly.'], ['密钥库不可用时先解决系统环境，不要用明文文件绕过。', 'Fix the system environment when the keychain is unavailable; do not bypass it with plaintext files.'], ['更新或大规模导入前先备份，恢复后再运行一次端到端验证。', 'Back up before updates or large imports and run an end-to-end test after restoring.'], ['打开设置', 'Open settings'],
  ['桌面版可以在应用内检查更新、查看版本说明并下载安装。便携版或部分平台的安装方式可能不同，界面会给出适合当前构建的操作。', 'Desktop builds can check for updates, show release notes, and download/install in the app. Portable builds and some platforms use different installation flows; the UI shows the action appropriate to the current build.'],
  ['在线更新', 'Online update'], ['检查、下载、校验、重启安装动画示意', 'Animation: check, download, verify, restart'], ['检查版本', 'Check version'], ['下载更新', 'Download update'], ['校验文件', 'Verify file'], ['重启安装', 'Restart and install'],
  ['打开更新入口', 'Open the updater'], ['从设置或更新提示打开对话框，查看当前版本、新版本和发布说明。', 'Open the dialog from Settings or an update prompt to see current/new versions and release notes.'], ['开始下载', 'Start download'], ['保持 StonePlus 运行；界面会显示进度、速度或阶段，不要重复点击。', 'Keep StonePlus running. Watch progress/speed/stage and do not click repeatedly.'], ['等待校验', 'Wait for verification'], ['下载完成后还需校验文件完整性，校验失败不会直接安装。', 'After download, StonePlus verifies integrity. A failed verification is not installed.'], ['保存工作并重启', 'Save work and restart'], ['确认没有进行中的请求或导入任务，再按提示重启完成更新。', 'Make sure no requests or imports are running, then restart when prompted.'], ['更新后验证', 'Verify after updating'], ['查看版本号，启动网关并发一个短请求，确认客户端配置仍匹配实际端口。', 'Check the version, start the gateway, and send a short request to confirm client configuration still matches the actual port.'],
  ['StonePlus 在线更新对话框', 'StonePlus update dialog'], ['更新对话框展示版本说明、下载 / 校验阶段和下一步按钮，不需要手工寻找安装包。', 'The dialog shows release notes, download/verification stages, and the next action without requiring you to find an installer manually.'],
  ['更新前准备', 'Before updating'], ['等待活跃请求归零，暂停批量导入、OAuth 授权和会话修复。', 'Wait for active requests to reach zero and pause batch imports, OAuth, and session repair.'], ['保留一份近期自动备份；跨大版本时额外导出普通配置。', 'Keep a recent automatic backup and export ordinary configuration before a major-version upgrade.'], ['确认磁盘空间和网络稳定，不要在下载中强制结束进程。', 'Confirm disk space and network stability; do not kill the app during download.'], ['使用与当前系统架构一致的构建：Windows / Linux / macOS、x64 / ARM64。', 'Use a build matching your OS and architecture: Windows/Linux/macOS and x64/ARM64.'],
  ['更新失败', 'Update failed'], ['下载失败或速度为零', 'Download failed or stays at zero'], ['保留当前版本，检查网络后重试', 'Keep the current version and retry after checking the network'], ['关闭更新窗口后重新检查，确认不是短暂断网。', 'Close the updater and check again to rule out a brief outage.'], ['用诊断确认基础网络；下载源受限时切换系统网络环境。', 'Use Diagnostics for basic connectivity; change the system network if the download source is restricted.'], ['检查磁盘空间和临时目录权限。', 'Check disk space and temporary-directory permissions.'], ['仍失败时从项目 Release 页面手工下载当前平台安装包。', 'If it still fails, manually download the correct installer from the project Releases page.'],
  ['校验失败 / 安装后仍是旧版本', 'Verification failed / old version remains'], ['不要反复安装同一个损坏文件', 'Do not reinstall the same damaged file'], ['重新下载，确认安全软件没有截断或隔离安装文件。完全退出 StonePlus 后再运行安装包；便携版应替换正确目录而不是启动旧快捷方式。', 'Download again and ensure security software did not truncate or quarantine the installer. Fully exit StonePlus before installing. For portable builds, replace the correct directory rather than launching an old shortcut.'],
  ['不要卸载来“清缓存”', 'Do not uninstall just to clear cache'], ['更新失败通常不需要先卸载。先保留现有可用版本和数据，备份后再选择覆盖安装或便携版替换。', 'An update failure normally does not require uninstalling. Keep the working version and data, back up, then choose an in-place install or portable replacement.'], ['前往设置检查更新', 'Check for updates in Settings'],

  // Assistant and FAQ UI.
  ['自动检测 · 下一步助手', 'Automatic check · Next-step assistant'], [' 项', ' items'], ['正在检查…', 'Checking…'], ['已完成', 'Complete'], ['只检查能跑通请求的最低条件；代理、穿透等按需配置。', 'Checks only the minimum requirements for a working request; proxies and tunnels are optional.'], ['客户端检查失败，重试', 'Client check failed; retry'], ['重新检测', 'Check again'], ['运行一键诊断', 'Run Diagnostics'],
  ['按现象找到问题后，先执行答案中的第一项并复测。排障的目标是确认错误发生在哪一层，而不是把所有配置重新做一遍。', 'Find the matching symptom, perform the first suggested action, and retest. The goal is to locate the failing layer, not rebuild every setting.'], ['启动与连接', 'Startup and connection'], ['请求与账号', 'Requests and accounts'], ['配置与更新', 'Configuration and updates'],
  ['提交问题时带什么信息', 'What to include in a bug report'], ['StonePlus 版本与系统、失败时间、客户端、诊断结果、请求状态码和已脱敏错误即可。不要附 OAuth Token、API Key、本地令牌、Cookie 或完整私人提示词。', 'Include the StonePlus version and OS, failure time, client, diagnostics result, request status code, and a redacted error. Never include OAuth tokens, API keys, local tokens, cookies, or full private prompts.'],
  ['网关启动失败，提示端口被占用怎么办？', 'The gateway says its port is already in use. What should I do?'], ['先在设置中换到相邻空闲端口并重启网关。随后到客户端配置页点击“一键修复连接”，让客户端改用实际端口。若必须使用原端口，先退出占用它的旧 StonePlus 或其他服务。', 'Choose a nearby free port in Settings and restart the gateway. Then use Repair connection so clients use the actual port. If the original port is required, stop the old StonePlus instance or other service using it.'], ['检查网关设置', 'Check gateway settings'],
  ['客户端提示无法连接或 Connection refused？', 'The client reports Connection refused.'], ['确认客户端配置页的“配置文件、内部路由、本地网关”三个状态。点击“一键修复连接”后完全重启客户端；仍无请求记录时，再检查客户端实际读取的配置目录。', 'Check Configuration file, Internal route, and Local gateway on the client page. Run Repair connection and fully restart the client. If no request appears, verify which configuration directory the client actually reads.'], ['一键检查并修复', 'Check and repair'],
  ['顶部助手一直说客户端未配置，但我已经保存了 Profile？', 'The assistant says the client is not configured, but I saved a profile.'], ['保存 Profile 只是选择配置目录，不等于已经建立连接。打开客户端配置页，选择对应客户端并点击“一键修复连接”，然后完全重启客户端。', 'A profile only selects a configuration directory; it does not establish the connection. Open Client Configuration, choose the client, run Repair connection, and fully restart it.'], ['修复客户端连接', 'Repair client connection'],
  ['一定要创建号池吗？', 'Do I have to create a pool?'], ['不一定。多个 OAuth / ChatGPT 账号通常先组成号池；保存正确的单个官方 API 或中转可以直接作为路由来源。顶部助手会按实际可路由来源判断。', 'No. Multiple OAuth/ChatGPT accounts usually use a pool, but one valid official API or relay can be routed directly. The assistant checks the actual routable source.'],
  ['请求后一直显示 1 个活跃请求怎么办？', 'One active request remains after the response.'], ['先确认客户端是否仍在接收流式响应。若结果已经完整返回，刷新页面并更新到包含流结束修复的最新版本，然后重启网关。请求记录仍显示“流式”时展开详情；不要在正常长请求尚未结束时强制停止。', 'Confirm whether the client is still receiving a stream. If it already received the full result, refresh, update StonePlus, and restart the gateway. Expand a record that remains Streaming; do not stop a legitimately active long request.'], ['查看最新请求', 'View latest request'],
  ['出现 401 / Unauthorized 怎么定位？', 'How do I diagnose 401 / Unauthorized?'], ['没有请求记录时多半是客户端使用了错误的本地令牌；有记录且错误来自上游时，刷新账号状态、重新 OAuth 登录或核对 API Key。不要把上游密钥直接写到客户端来绕过 StonePlus。', 'No request record usually means the client has the wrong local token. If a record shows an upstream 401, refresh account status, sign in with OAuth again, or verify the API key. Never bypass StonePlus by putting upstream credentials in the client.'], ['区分本地与上游 401', 'Distinguish local vs. upstream 401'],
  ['出现 403 或地区限制怎么办？', 'What about 403 or region restrictions?'], ['先用诊断比较直连和代理出口。403 也可能是账号权限或服务商策略，不要只靠反复重试；核对目标模型权限、出口地区和中转规则。', 'Compare direct and proxy exits in Diagnostics. A 403 may also reflect account permissions or provider policy, so verify model access, exit region, and relay rules rather than retrying blindly.'], ['比较网络出口', 'Compare network exits'],
  ['出现 429 / 配额不足或并发限制？', 'What about 429, quota, or concurrency limits?'], ['查看账号配额、冷却状态和最大并发。多个账号可用智能均衡号池分担；只有一个账号时降低并发并等待上游限流窗口恢复。增加重试次数不会产生新额度。', 'Check quota, cooldown, and maximum concurrency. A smart-balance pool can spread work across accounts. With one account, lower concurrency and wait for the upstream window to reset; retries do not create quota.'], ['检查账号配额', 'Check account quota'],
  ['模型不存在 / model_not_found？', 'Model not found / model_not_found?'], ['在请求详情确认“客户端请求模型”和最终上游模型；刷新来源可用模型，检查号池白名单与路由模型映射。映射目标必须使用上游真实模型 ID。', 'Compare the requested and final upstream models in request details. Refresh source models and check pool allowlists and route mappings. Mapping targets must be real upstream model IDs.'], ['检查模型映射', 'Check model mapping'],
  ['请求很慢，应该调哪个参数？', 'Which setting should I change for slow requests?'], ['先看首 Token、调度、凭据解析与上游响应头耗时。网络慢先处理代理；账号排队先看并发和号池；只有尾延迟明显时才考虑对冲请求。不要一次同时修改超时、重试、并发和策略。', 'Inspect first-token, scheduling, credential resolution, and upstream-header timings. Fix network/proxy delays first, then account queueing/concurrency. Consider hedging only for tail latency, and do not change timeout, retries, concurrency, and strategy at once.'], ['查看阶段耗时', 'View stage timings'],
  ['换账号后旧会话不能继续，但新会话正常？', 'Old conversations fail after changing accounts, but new ones work.'], ['这是会话修复的典型场景。先关闭 ChatGPT / Codex，扫描并预览旧 provider 关联，确认影响范围后执行修复，再重启客户端。', 'This is the main Session Repair use case. Close ChatGPT/Codex, scan and preview old provider links, confirm the scope, repair, and restart the client.'], ['预览会话修复', 'Preview session repair'],
  ['代理显示可用，但请求仍超时？', 'The proxy test passes, but requests still time out.'], ['代理卡测试可能只验证代理握手。到诊断页选择同一出口，检查真实 GPT / OAuth 目标；同时确认账号级代理是否覆盖了号池代理。', 'The proxy card may test only the proxy handshake. Select the same exit in Diagnostics and test real GPT/OAuth targets. Also check whether an account proxy overrides the pool proxy.'], ['用该代理诊断', 'Diagnose with this proxy'],
  ['一键修复连接会覆盖我原来的配置吗？', 'Will Repair connection overwrite my configuration?'], ['文件能正常解析时，只修改连接 StonePlus 所需的地址、provider 和本地令牌，模型、MCP、插件与未知字段会保留。文件已经损坏时会先完整备份原文，再重建最小可用文件；可随时恢复修复前版本。', 'When files parse correctly, only the address, provider, and local token needed for StonePlus are changed; models, MCP, plugins, and unknown fields remain. A damaged file is backed up in full before a minimal working file is created.'], ['检查并修复连接', 'Check and repair connection'],
  ['内置浏览器下载完成但无法导入？', 'A built-in browser download cannot be imported.'], ['确认文件状态是完成、路径仍存在、内容是支持的账号 JSON / 文本而不是 HTML 错误页或压缩包。到账号导入页手工选择该文件可查看详细解析错误。', 'Confirm the download completed, the path still exists, and the content is supported account JSON/text rather than an HTML error page or archive. Select it manually in account import for detailed parse errors.'], ['手工选择文件', 'Choose file manually'],
  ['在线更新失败会损坏现有配置吗？', 'Can a failed online update damage my configuration?'], ['下载或校验失败不会要求你先卸载。保留当前可用版本，检查网络、磁盘和安全软件后重试；更新前做好备份，必要时从 Release 下载匹配平台的安装包覆盖安装。', 'A download or verification failure does not require uninstalling. Keep the working version, check network/disk/security software, and retry. Back up first and use the matching Release installer if needed.'], ['重新检查更新', 'Check for updates again'],
  ['项', 'items'], ['去诊断', 'Run diagnostics'], ['OpenAI / OAuth 网络', 'OpenAI / OAuth network'],
  ['基础地址填服务商文档给出的 API 根地址，不要多拼一次', 'Use the API root from the provider documentation. Do not append'],
  ['下拉选择新上游时，StonePlus 只原子更新内部路由；不会重写', 'Choosing a new upstream only updates the internal route atomically. It does not rewrite'],
  ['或', 'or'], ['或当前可用端口', 'or the current available port'],
])

function localizeHelpValue(value: unknown, t: Translate): unknown {
  if (typeof value === 'string') return t(value, helpEnglish.get(value) ?? value)
  if (Array.isArray(value)) return value.map((item) => localizeHelpValue(item, t))
  if (isValidElement(value)) {
    const element = value as ReactElement<Record<string, unknown>>
    const props = Object.fromEntries(Object.entries(element.props).map(([key, item]) => [key, localizeHelpValue(item, t)]))
    return cloneElement(element, props)
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeHelpValue(item, t)]))
  }
  return value
}

function LocalizedDoc({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return <>{localizeHelpValue(children, t) as ReactNode}</>
}

export function HelpView({ snapshot, api, navigate }: HelpViewProps) {
  const { t, language, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [activeTopic, setActiveTopic] = useState<TopicId>('quick-start')
  const [clientConfigs, setClientConfigs] = useState<ClientConfigStatus[]>()
  const [scanBusy, setScanBusy] = useState(true)
  const [scanError, setScanError] = useState('')
  const [scanRevision, setScanRevision] = useState(0)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const clientDetectionKey = useMemo(() => [
    ...snapshot.routes.map((route) => `${route.id}:${route.client}:${route.enabled}:${route.poolId}:${route.updatedAt}`),
    ...snapshot.clientProfiles.map((profile) => `${profile.id}:${profile.directory ?? ''}:${profile.updatedAt}`),
  ].sort().join('|'), [snapshot.clientProfiles, snapshot.routes])

  useEffect(() => {
    let active = true
    setScanBusy(true)
    setScanError('')
    void api.getClientConfigs()
      .then((result) => {
        if (!active) return
        setClientConfigs(result)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setClientConfigs([])
        setScanError(cause instanceof Error && (language === 'zh-CN' || !/[\u3400-\u9fff]/u.test(cause.message))
          ? cause.message
          : t('无法读取客户端配置', 'Could not read client configuration'))
      })
      .finally(() => {
        if (active) setScanBusy(false)
      })
    return () => { active = false }
  }, [api, clientDetectionKey, language, scanRevision, t])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === '/' && !isTyping) {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    if (!lightbox) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [lightbox])

  const readiness = useMemo(
    () => evaluateHelpReadiness(snapshot, clientConfigs, t),
    [clientConfigs, snapshot, t],
  )

  const localizedTopics = useMemo(() => localizeTopics(t), [t])
  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const filteredTopics = useMemo(() => {
    if (!normalizedQuery) return localizedTopics
    return localizedTopics.filter((topic) => [topic.title, topic.summary, topic.keywords, ...topic.headings.map((heading) => heading.label)]
      .join(' ').toLocaleLowerCase(locale).includes(normalizedQuery))
  }, [locale, localizedTopics, normalizedQuery])

  const selectedTopic = localizedTopics.find((topic) => topic.id === activeTopic) ?? localizedTopics[0]

  const selectTopic = (id: TopicId, headingId?: string) => {
    setActiveTopic(id)
    window.requestAnimationFrame(() => {
      const target = document.getElementById(headingId ? `help-${id}-${headingId}` : 'help-article-top')
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  return (
    <div className="page-stack help-page">
      <PageHeader
        title={t('帮助中心', 'Help center')}
        actions={<button className="button button--secondary" type="button" onClick={() => navigate('setup')}><Sparkles size={16} />{t('打开新手向导', 'Open setup wizard')}</button>}
      />

      <NextStepAssistant
        readiness={readiness}
        scanBusy={scanBusy}
        scanError={scanError}
        navigate={navigate}
        onRefresh={() => setScanRevision((value) => value + 1)}
      />

      <section className="help-library" aria-label={t('StonePlus 使用文档', 'StonePlus documentation')}>
        <header className="help-library__header">
          <div>
            <span className="help-eyebrow"><BookOpen size={14} /> {t('使用手册', 'User guide')}</span>
            <h2>{t('从第一次配置到日常排障', 'From first-time setup to everyday troubleshooting')}</h2>
            <p>{t('按用户要完成的事情组织，不要求先理解技术名词。', 'Organized by the task you want to complete, without requiring technical background.')}</p>
          </div>
          <label className="help-search">
            <Search size={17} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={t('搜索功能、现象或错误码', 'Search features, symptoms, or error codes')}
              aria-label={t('搜索帮助文档', 'Search help documentation')}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query
              ? <button type="button" aria-label={t('清空搜索', 'Clear search')} onClick={() => setQuery('')}><X size={15} /></button>
              : <kbd>Ctrl K</kbd>}
          </label>
        </header>

        {normalizedQuery && <div className="help-search-summary" role="status">
          <Search size={14} /> {t(`找到 ${filteredTopics.length} 个相关章节`, `${filteredTopics.length} matching section(s)`)}
        </div>}

        <div className="help-library__layout">
          <aside className="help-toc" aria-label={t('帮助目录', 'Help contents')}>
            {groups.map((group) => {
              const groupTopics = filteredTopics.filter((topic) => topic.group === group)
              if (!groupTopics.length) return null
              return <div className="help-toc__group" key={group}>
                <strong>{t(group, groupEnglish[group])}</strong>
                {groupTopics.map((topic) => {
                  const Icon = topic.icon
                  const active = topic.id === activeTopic
                  return <div className="help-toc__entry" key={topic.id}>
                    <button className={active ? 'active' : ''} type="button" onClick={() => selectTopic(topic.id)}>
                      <Icon size={15} /><span>{topic.title}</span><ChevronRight size={13} />
                    </button>
                    {active && <div className="help-toc__sub">
                      {topic.headings.map((heading) => <button type="button" key={heading.id} onClick={() => selectTopic(topic.id, heading.id)}>{heading.label}</button>)}
                    </div>}
                  </div>
                })}
              </div>
            })}
            {!filteredTopics.length && <div className="help-toc__empty"><CircleHelp size={20} /><span>{t('没有匹配章节', 'No matching sections')}</span><button type="button" onClick={() => setQuery('')}>{t('清空搜索', 'Clear search')}</button></div>}
          </aside>

          <main className="help-article" id="help-article-top" tabIndex={-1}>
            {normalizedQuery && filteredTopics.length > 0 && !filteredTopics.some((topic) => topic.id === activeTopic)
              ? <SearchResults topics={filteredTopics} onSelect={selectTopic} />
              : <DocArticle topic={selectedTopic} navigate={navigate} onImage={setLightbox} />}
          </main>
        </div>
      </section>

      {lightbox && <div className="help-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.alt} onMouseDown={(event) => {
        if (event.target === event.currentTarget) setLightbox(null)
      }}>
        <button type="button" className="help-lightbox__close" aria-label={t('关闭图片', 'Close image')} onClick={() => setLightbox(null)}><X size={20} /></button>
        <img src={lightbox.src} alt={lightbox.alt} />
        <span>{lightbox.alt}</span>
      </div>}
    </div>
  )
}

function NextStepAssistant({
  readiness,
  scanBusy,
  scanError,
  navigate,
  onRefresh,
}: {
  readiness: HelpReadiness
  scanBusy: boolean
  scanError: string
  navigate: (page: PageId) => void
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const next = readiness.nextAction
  const recommendation = scanBusy && next?.id === 'client'
      ? { title: t('正在确认客户端配置', 'Checking client configuration'), detail: t('马上完成最后一项本地文件检查。', 'The final local file check will finish shortly.') }
    : readiness.ready
      ? { title: t('最低运行配置已经完成', 'Minimum setup is complete'), detail: t('可以直接使用客户端；建议先运行一次诊断，留下健康基线。', 'Your client is ready. Run Diagnostics once to establish a healthy baseline.') }
      : { title: next?.label ?? t('继续完成配置', 'Continue setup'), detail: next?.description ?? t('跟随推荐操作补齐最低运行配置。', 'Follow the recommended action to complete the minimum setup.') }

  return <LocalizedDoc><section className={`help-assistant ${readiness.ready ? 'help-assistant--ready' : ''}`} aria-labelledby="help-assistant-title">
    <div className="help-assistant__summary">
      <div className="help-assistant__title">
        <span className="help-assistant__spark"><Sparkles size={18} /></span>
        <div><span className="help-eyebrow">自动检测 · 下一步助手</span><h2 id="help-assistant-title">{recommendation.title}</h2><p>{recommendation.detail}</p></div>
      </div>
      <div className="help-progress-ring" style={{ '--help-progress': `${readiness.percentage * 3.6}deg` } as React.CSSProperties} aria-label={t(`配置进度 ${readiness.percentage}%`, `Setup progress ${readiness.percentage}%`)}>
        <div><strong>{readiness.percentage}%</strong><span>{readiness.completedCount}/{readiness.totalCount} 项</span></div>
      </div>
    </div>

    <div className="help-assistant__track" aria-hidden="true"><span style={{ width: `${readiness.percentage}%` }} /></div>

    <div className="help-checklist">
      {readiness.items.map((item, index) => {
        const checking = item.id === 'client' && scanBusy
        const current = !readiness.ready && item.id === next?.id
        return <button className={`${item.complete ? 'complete' : ''} ${current ? 'current' : ''}`} type="button" key={item.id} onClick={() => navigate(item.page)}>
          <span className="help-checklist__index">{checking ? <LoaderCircle size={14} className="spin" /> : item.complete ? <Check size={14} /> : index + 1}</span>
          <span><strong>{item.label}</strong><small>{checking ? '正在检查…' : item.complete ? '已完成' : item.description}</small></span>
          <ArrowRight size={14} />
        </button>
      })}
    </div>

    <footer className="help-assistant__actions">
      <div className="help-assistant__note"><ShieldCheck size={15} /><span>只检查能跑通请求的最低条件；代理、穿透等按需配置。</span></div>
      <div>
        {scanError && <button className="help-scan-error" type="button" title={scanError} onClick={onRefresh}><AlertCircle size={14} />客户端检查失败，重试</button>}
        <button className="button button--secondary" type="button" onClick={onRefresh} disabled={scanBusy}><RefreshCw size={15} className={scanBusy ? 'spin' : ''} />重新检测</button>
        {readiness.ready
          ? <button className="button button--primary" type="button" onClick={() => navigate('diagnostics')}><Stethoscope size={15} />运行一键诊断</button>
          : next && <button className="button button--primary" type="button" onClick={() => navigate(next.page)}>{next.actionLabel}<ArrowRight size={15} /></button>}
      </div>
    </footer>
  </section></LocalizedDoc>
}

function SearchResults({ topics: results, onSelect }: { topics: Topic[]; onSelect: (id: TopicId) => void }) {
  return <LocalizedDoc><div className="help-results">
    <div className="help-article__heading"><span className="help-eyebrow">搜索结果</span><h2>选择要查看的章节</h2><p>搜索会匹配功能名、操作目标、常见现象和错误关键词。</p></div>
    <div className="help-results__grid">{results.map((topic) => {
      const Icon = topic.icon
      return <button type="button" key={topic.id} onClick={() => onSelect(topic.id)}><Icon size={19} /><span><strong>{topic.title}</strong><small>{topic.summary}</small></span><ArrowRight size={15} /></button>
    })}</div>
  </div></LocalizedDoc>
}

function DocArticle({
  topic,
  navigate,
  onImage,
}: {
  topic: Topic
  navigate: (page: PageId) => void
  onImage: (image: { src: string; alt: string }) => void
}) {
  const Icon = topic.icon
  return <LocalizedDoc><article aria-labelledby={`help-${topic.id}-title`}>
    <header className="help-article__heading">
      <span className="help-article__icon"><Icon size={22} /></span>
      <div><span className="help-eyebrow">使用手册</span><h2 id={`help-${topic.id}-title`}>{topic.title}</h2><p>{topic.summary}</p></div>
      {topic.page && topic.page !== 'tunnel' && <button className="button button--secondary" type="button" onClick={() => navigate(topic.page!)}>打开功能<ExternalLink size={14} /></button>}
      {topic.page === 'tunnel' && tunnelSupported && <button className="button button--secondary" type="button" onClick={() => navigate('tunnel')}>打开功能<ExternalLink size={14} /></button>}
    </header>
    <TopicContent id={topic.id} navigate={navigate} onImage={onImage} />
    <footer className="help-article__footer">
      <LifeBuoy size={17} />
      <div><strong>照着操作仍没解决？</strong><span>先运行“一键诊断”，再到“请求记录”查看最近一次错误的状态码和错误详情。</span></div>
      <button type="button" onClick={() => navigate('diagnostics')}>去诊断 <ArrowRight size={14} /></button>
    </footer>
  </article></LocalizedDoc>
}

function TopicContent({ id, navigate, onImage }: { id: TopicId; navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  switch (id) {
    case 'quick-start': return <QuickStartDoc navigate={navigate} onImage={onImage} />
    case 'providers': return <ProvidersDoc navigate={navigate} onImage={onImage} />
    case 'proxies': return <ProxiesDoc navigate={navigate} />
    case 'pools': return <PoolsDoc navigate={navigate} onImage={onImage} />
    case 'routes': return <RoutesDoc navigate={navigate} onImage={onImage} />
    case 'clients': return <ClientsDoc navigate={navigate} onImage={onImage} />
    case 'session-repair': return <SessionRepairDoc navigate={navigate} />
    case 'tunnel': return <TunnelDoc navigate={navigate} />
    case 'browser': return <BrowserDoc navigate={navigate} onImage={onImage} />
    case 'diagnostics': return <DiagnosticsDoc navigate={navigate} onImage={onImage} />
    case 'requests': return <RequestsDoc navigate={navigate} />
    case 'settings': return <SettingsDoc navigate={navigate} />
    case 'updates': return <UpdatesDoc navigate={navigate} onImage={onImage} />
    case 'faq': return <FaqDoc navigate={navigate} />
  }
}

function SectionHeading({ topic, id, children }: { topic: TopicId; id: string; children: ReactNode }) {
  return <h3 className="help-section-title" id={`help-${topic}-${id}`}>{children}</h3>
}

function Steps({ items }: { items: Array<{ title: string; text: ReactNode }> }) {
  return <ol className="help-steps">{items.map((item, index) => <li key={item.title}>
    <span>{index + 1}</span><div><strong>{item.title}</strong><p>{item.text}</p></div>
  </li>)}</ol>
}

function Guide({ title, summary, children, open = false }: { title: string; summary: string; children: ReactNode; open?: boolean }) {
  return <details className="help-guide" open={open}>
    <summary><span><strong>{title}</strong><small>{summary}</small></span><ChevronRight size={16} /></summary>
    <div className="help-guide__body">{children}</div>
  </details>
}

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning'; title: string; children: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertCircle : ShieldCheck
  return <div className={`help-callout help-callout--${tone}`}><Icon size={18} /><div><strong>{title}</strong><p>{children}</p></div></div>
}

function OpenPageButton({ page, children, navigate }: { page: PageId; children: ReactNode; navigate: (page: PageId) => void }) {
  return <button className="help-inline-action" type="button" onClick={() => navigate(page)}>{children}<ArrowRight size={14} /></button>
}

function ScreenshotFigure({ src, alt, caption, onImage }: { src: string; alt: string; caption: string; onImage: (image: { src: string; alt: string }) => void }) {
  const { t } = useI18n()
  return <LocalizedDoc><figure className="help-figure">
    <button type="button" onClick={() => onImage({ src, alt })} aria-label={t(`放大查看：${alt}`, `Enlarge: ${alt}`)}>
      <img src={src} alt={alt} loading="lazy" />
      <span><Maximize2 size={15} />点击放大</span>
    </button>
    <figcaption>{caption}</figcaption>
  </figure></LocalizedDoc>
}

function FlowDemo() {
  const nodes = [
    { label: '来源', icon: KeyRound },
    { label: '号池', icon: Network },
    { label: '路由', icon: RouteIcon },
    { label: '网关', icon: Zap },
    { label: '客户端', icon: MonitorCog },
  ]
  return <LocalizedDoc><div className="help-flow-demo" aria-label="请求从客户端经过网关、路由、号池到达来源的动画示意">
    <div className="help-flow-demo__line"><i /></div>
    {nodes.map(({ label, icon: Icon }) => <div className="help-flow-demo__node" key={label}><span><Icon size={17} /></span><strong>{label}</strong></div>)}
    <p>配置时从左到右准备；真正发请求时从客户端反向进入 StonePlus。</p>
  </div></LocalizedDoc>
}

function ScanDemo() {
  return <LocalizedDoc><div className="help-scan-demo" aria-label="自动诊断动画示意">
    <div className="help-scan-demo__beam" />
    {['本地网关', '路由与来源', 'OpenAI / OAuth 网络'].map((item, index) => <div key={item} style={{ '--scan-index': index } as React.CSSProperties}><span><Check size={13} /></span><strong>{item}</strong><small>自动检测</small></div>)}
  </div></LocalizedDoc>
}

function QuickStartDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>第一次使用不必逐页研究。最省事的方法是打开新手向导，按页面提示准备一个可用来源，然后让 StonePlus 自动建立最小链路。</p></div>
    <ScreenshotFigure src={demoGif} alt="StonePlus 从向导到配置完成的操作演示" caption="完整流程动图：环境扫描、选择来源、验证网络、建立路由、启动网关并写入客户端。" onImage={onImage} />

    <SectionHeading topic="quick-start" id="understand-flow">先理解一条请求</SectionHeading>
    <FlowDemo />
    <p className="help-copy">把 StonePlus 想成一个本地总机：<strong>来源</strong>提供账号或 API；<strong>号池</strong>决定多个账号怎么轮换；<strong>路由</strong>决定某个客户端该走哪个来源；<strong>网关</strong>在本机接收请求；最后由<strong>客户端配置</strong>把 Codex、Claude Code 或 Gemini CLI 指向网关。</p>
    <Callout title="不一定必须手动建号池">官方 API 或单个中转可以直接作为路由来源；多个 ChatGPT 账号需要号池。顶部助手会按实际来源类型判断，不会要求多余步骤。</Callout>

    <SectionHeading topic="quick-start" id="first-run">第一次配置</SectionHeading>
    <Steps items={[
      { title: '打开新手向导', text: <>点击本页顶部“打开新手向导”，先让系统扫描客户端目录和本机网络。</> },
      { title: '添加一个来源', text: <>可用 ChatGPT OAuth 登录、Token JSON、官方 API Key 或兼容中转。按向导中的“测试”确认凭据与网络。</> },
      { title: '确认调度与路由', text: <>多个账号选择号池策略；选择你实际使用的客户端和模型，向导会创建并启用匹配路由。</> },
      { title: '启动网关并真实验证', text: <>向导会启动本地网关，并发送一次端到端测试；看到响应预览才表示上游链路真的跑通。</> },
      { title: '一键接好客户端', text: <>选择客户端后点“一键修复连接”；StonePlus 会先备份，并只处理必要连接字段。</> },
    ]} />
    <div className="help-action-row"><OpenPageButton page="setup" navigate={navigate}><Play size={14} />现在开始配置</OpenPageButton><OpenPageButton page="diagnostics" navigate={navigate}><Stethoscope size={14} />检查当前环境</OpenPageButton></div>
    <ScreenshotFigure src={setupScreenshot} alt="StonePlus 新手向导界面" caption="左侧显示完整步骤，主区域一次只要求完成当前任务；随时退出也会保留非敏感进度。" onImage={onImage} />

    <SectionHeading topic="quick-start" id="verify-ready">怎样算配置成功</SectionHeading>
    <Guide title="最低可用的五个信号" summary="不要只看“保存成功”，要确认整条链路" open>
      <ul className="help-check-list">
        <li><CheckCircle2 size={16} /><span><strong>来源可用</strong>：至少一个账号未禁用、未过期，或一个 API / 中转来源可用。</span></li>
        <li><CheckCircle2 size={16} /><span><strong>路由来源可用</strong>：号池中有启用成员，或路由可以直接使用 API / 中转。</span></li>
        <li><CheckCircle2 size={16} /><span><strong>路由已启用</strong>：客户端类型正确，并且指向上面的可用来源。</span></li>
        <li><CheckCircle2 size={16} /><span><strong>网关运行中</strong>：总览显示实际监听地址与端口。</span></li>
        <li><CheckCircle2 size={16} /><span><strong>客户端已配置</strong>：对应客户端的检测结果显示“已配置”。</span></li>
      </ul>
    </Guide>
    <Callout tone="success" title="最后做一次真实请求">在客户端发送一句简短消息，然后到“请求记录”确认状态为成功、命中的来源和模型符合预期。仅网络测试成功不等于完整请求一定成功。</Callout>
    <ScreenshotFigure src={overviewScreenshot} alt="StonePlus 总览页面" caption="日常首先看总览：网关状态、启用路由、账号健康和最近请求会集中显示。" onImage={onImage} />
  </></LocalizedDoc>
}

function ProvidersDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>“来源”是 StonePlus 能调用模型的凭据入口。一个来源可以是 ChatGPT 账号、官方 API Key，也可以是 OpenAI / Anthropic / Gemini 兼容中转。</p></div>
    <SectionHeading topic="providers" id="choose-source">选择来源类型</SectionHeading>
    <div className="help-choice-grid">
      <div><KeyRound size={18} /><strong>ChatGPT 账号</strong><p>优先用 OAuth 登录；已有 Token JSON 可直接导入。适合 Codex / ChatGPT 订阅账号。</p></div>
      <div><ShieldCheck size={18} /><strong>官方 API</strong><p>填写服务商 API Key 与基础地址，适合按量计费和稳定生产调用。</p></div>
      <div><Boxes size={18} /><strong>兼容中转</strong><p>填写中转地址、密钥、协议和模型。添加前确认服务商明确支持目标协议。</p></div>
    </div>
    <Callout tone="warning" title="凭据不要混用">OAuth / Token JSON 与普通 API Key 的登录方式、刷新方式不同。不要把 OAuth access token 当作中转 API Key 粘贴。</Callout>

    <SectionHeading topic="providers" id="add-source">添加与验证</SectionHeading>
    <Guide title="OAuth 登录 ChatGPT" summary="浏览器授权完成后自动回到 StonePlus" open>
      <Steps items={[
        { title: '选择“登录 ChatGPT”', text: '可先选择账号标签、目标号池和网络出口。' },
        { title: '在浏览器完成授权', text: '不要关闭 StonePlus；授权页面完成后等待应用自动交换凭据。' },
        { title: '检查检测结果', text: '确认账号名、到期时间、可刷新状态和模型信息；有警告时先展开查看。' },
      ]} />
    </Guide>
    <Guide title="批量导入 Token JSON / 文件" summary="先解析，再确认导入去向">
      <p>可以粘贴 JSON、选择文件，或从内置浏览器的下载记录导入。预览阶段会识别重复账号、无效文件和代理信息；确认后才写入。</p>
      <Callout title="批量导入建议">先建立标签与号池，再在导入时一次分配。重复账号默认更新同一记录，不需要先删除旧账号。</Callout>
    </Guide>
    <Guide title="添加官方 API 或中转" summary="基础地址、协议、密钥、模型缺一不可">
      <ul>
        <li>基础地址填服务商文档给出的 API 根地址，不要多拼一次 <code>/v1/responses</code>。</li>
        <li>协议按真实接口选择 OpenAI Responses、OpenAI Chat、Anthropic Messages 或 Gemini。</li>
        <li>先点连接 / 模型测试，再保存；测试失败不会破坏现有来源。</li>
        <li>模型留空或写错会导致客户端模型无法命中，保存后再刷新一次模型。</li>
      </ul>
    </Guide>
    <ScreenshotFigure src={accountsScreenshot} alt="StonePlus 账号与中转管理页面" caption="账号卡集中显示状态、配额、模型、并发、代理和所属标签；批量操作不会要求逐个打开。" onImage={onImage} />

    <SectionHeading topic="providers" id="manage-accounts">日常管理</SectionHeading>
    <div className="help-definition-list">
      <div><strong>状态</strong><span>“可用”可参与调度；“冷却”会临时跳过；“禁用 / 过期”不会被选择。</span></div>
      <div><strong>优先级与权重</strong><span>优先级由号池策略解释；权重只在加权策略中影响选择概率。</span></div>
      <div><strong>最大并发</strong><span>限制同一账号同时处理的请求数，达到上限后调度其他账号或等待。</span></div>
      <div><strong>模型策略</strong><span>全部模型最省事；白名单适合只允许已验证模型，避免请求错误模型。</span></div>
      <div><strong>标签</strong><span>仅用于整理和批量分配，不改变路由结果。</span></div>
    </div>
    <Callout title="修改后如何确认生效">刷新账号状态，再到“号池”确认成员仍启用。发送一个测试请求，在请求记录中核对实际命中的账号。</Callout>
    <OpenPageButton page="providers" navigate={navigate}>管理账号与中转</OpenPageButton>
  </></LocalizedDoc>
}

function ProxiesDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>代理是可选项。直连能稳定访问上游时不要为了“完整配置”而添加代理；只有网络受限、服务商要求固定出口或需要按账号隔离出口时才使用。</p></div>
    <SectionHeading topic="proxies" id="proxy-needed">什么时候需要代理</SectionHeading>
    <div className="help-scenario-grid">
      <div><CheckCircle2 size={18} /><strong>建议直连</strong><p>诊断中目标均可达、延迟稳定，账号没有地域限制。</p></div>
      <div><Waypoints size={18} /><strong>建议代理</strong><p>连接超时 / TLS 失败、上游区域受限，或不同账号必须固定不同出口。</p></div>
    </div>
    <Callout tone="warning" title="代理可连不等于上游可用">代理“测试成功”通常只证明代理服务器可握手。随后还要到“诊断”选择这个出口，检查真实 GPT / OAuth 目标。</Callout>

    <SectionHeading topic="proxies" id="proxy-create">添加并测试</SectionHeading>
    <Steps items={[
      { title: '准备连接信息', text: '确认协议（HTTP / HTTPS / SOCKS5）、主机、端口，以及可选的用户名和密码。' },
      { title: '新建出口代理', text: '不要把 http://、路径或 PAC 地址放进“主机”；只填写主机名或 IP。' },
      { title: '运行连接测试', text: '查看延迟、出口 IP 和最近错误。密码只显示是否已保存，不会明文回显。' },
      { title: '到诊断页复测', text: '选择刚建立的代理，确认 OpenAI、ChatGPT 与 OAuth 所需目标符合你的用途。' },
    ]} />

    <SectionHeading topic="proxies" id="proxy-assign">绑定与排错</SectionHeading>
    <Guide title="代理绑定在哪里" summary="精确到账号最稳妥，号池适合统一出口" open>
      <p>可以在账号上指定代理，也可以给号池指定统一代理。账号已经指定代理时，账号设置优先；都没有指定时，按设置中的出站网络模式使用直连或系统代理。</p>
      <ul><li>同一批账号要求固定出口：逐账号绑定。</li><li>整个号池共用一条稳定链路：号池绑定。</li><li>想跟随 Windows / macOS 系统网络：设置中选择系统网络模式。</li></ul>
    </Guide>
    <Guide title="测试失败怎么排" summary="按从近到远的顺序检查">
      <ol><li>先检查代理软件是否运行、端口是否监听。</li><li>核对协议，SOCKS 端口不能按 HTTP 添加。</li><li>核对用户名、密码与 IP 白名单。</li><li>在诊断页比较直连与代理结果；直连成功而代理失败说明问题在代理链路。</li><li>若只有 OAuth 失败，换支持该域名和 HTTPS CONNECT 的节点。</li></ol>
    </Guide>
    <div className="help-action-row"><OpenPageButton page="proxies" navigate={navigate}>打开出口代理</OpenPageButton><OpenPageButton page="diagnostics" navigate={navigate}>用实际出口诊断</OpenPageButton></div>
  </></LocalizedDoc>
}

function PoolsDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>号池把多个账号包装成一个稳定来源。客户端不需要知道本次用了哪个账号；StonePlus 会按策略选择可用成员，并在允许时切换或重试。</p></div>
    <SectionHeading topic="pools" id="pool-meaning">号池是什么</SectionHeading>
    <div className="help-pool-demo" aria-label="三个账号汇入号池再输出一个稳定来源的动画示意">
      <div className="help-pool-demo__accounts"><span>A</span><span>B</span><span>C</span></div><i /><div className="help-pool-demo__pool"><Network size={20} /><strong>我的号池</strong><small>一个稳定入口</small></div>
    </div>
    <Callout title="API / 中转不总需要号池">单个官方 API 或中转可以直接作为路由来源。只有希望合并多个账号、统一重试或调度时才建立号池。</Callout>

    <SectionHeading topic="pools" id="pool-create">创建号池</SectionHeading>
    <Steps items={[
      { title: '选择协议', text: '协议必须与成员来源兼容，也要能转换到目标客户端的入站协议。' },
      { title: '选择成员', text: '只加入你确认可用的账号；成员可临时关闭而不必从号池删除。' },
      { title: '选择策略', text: '新手优先选择智能均衡或优先级。没有明确目标时不要同时改很多高级参数。' },
      { title: '设置失败处理', text: '重试次数过高会放大等待时间；先使用默认值，结合请求记录调整。' },
      { title: '保存并用于路由', text: '创建号池本身不会接收客户端请求，必须有一条启用路由指向它。' },
    ]} />
    <ScreenshotFigure src={poolsScreenshot} alt="StonePlus 号池与调度策略页面" caption="成员、模型范围、调度策略、粘性会话与重试集中配置；高级项按需展开。" onImage={onImage} />

    <SectionHeading topic="pools" id="pool-strategy">策略怎么选</SectionHeading>
    <div className="help-table-wrap"><table className="help-table"><thead><tr><th>策略</th><th>适合情况</th><th>你会看到的行为</th></tr></thead><tbody>
      <tr><td>智能均衡</td><td>大多数多账号场景</td><td>结合在途请求、近期速度与健康状态，自动避开拥堵成员。</td></tr>
      <tr><td>优先级</td><td>主账号优先、备用账号兜底</td><td>优先用高优先级可用成员，必要时才落到下一层。</td></tr>
      <tr><td>轮询</td><td>账号能力相近，希望平均轮换</td><td>按顺序选择可用成员，行为直观。</td></tr>
      <tr><td>加权</td><td>账号额度或性能差异明确</td><td>权重越大，被选中的机会越高；仍会受可用性与并发限制。</td></tr>
    </tbody></table></div>
    <Guide title="粘性会话、对冲和首包超时" summary="高级功能，先理解再开启">
      <ul><li><strong>粘性会话</strong>让同一会话在一段时间内尽量使用同一账号，适合依赖上游会话上下文的调用。</li><li><strong>对冲请求</strong>在首个请求迟迟不返回时并行尝试另一个成员，可能降低尾延迟，也可能增加调用量。</li><li><strong>首包超时</strong>只控制多久没收到响应体时触发处理，不等于整个请求的总超时。</li></ul>
    </Guide>
    <OpenPageButton page="pools" navigate={navigate}>管理号池</OpenPageButton>
  </></LocalizedDoc>
}

function RoutesDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>路由回答三个问题：哪种客户端发来的请求、用哪种协议接收、交给哪个来源。路由保存但未启用时不会参与请求。</p></div>
    <SectionHeading topic="routes" id="route-meaning">路由的作用</SectionHeading>
    <div className="help-route-demo"><span>Codex</span><ArrowRight size={15} /><strong>Codex 路由</strong><ArrowRight size={15} /><span>智能号池</span></div>
    <div className="help-definition-list">
      <div><strong>客户端</strong><span>Codex、Claude Code 或 Gemini CLI；客户端配置只会选择同类型启用路由。</span></div>
      <div><strong>入站协议</strong><span>StonePlus 在本地接收的请求格式，通常按客户端默认值即可。</span></div>
      <div><strong>路由来源</strong><span>一个号池，或可直接路由的官方 API / 中转。</span></div>
      <div><strong>本地令牌</strong><span>客户端访问本机网关使用的密钥，不是上游账号凭据。</span></div>
    </div>

    <SectionHeading topic="routes" id="route-create">创建与启用</SectionHeading>
    <Steps items={[
      { title: '选择客户端', text: '与你真正使用的工具一致；每个客户端至少保留一条明确启用的路由。' },
      { title: '选择可用来源', text: '下拉列表只应选择当前有可用账号的号池或有效 API / 中转。' },
      { title: '确认协议', text: '新手保留推荐协议；只有上游或客户端有特殊兼容要求时才修改。' },
      { title: '保存并启用', text: '启用后到客户端配置页应用配置，再发送真实请求。' },
    ]} />
    <Callout tone="warning" title="同一客户端多条路由">请明确哪条需要启用，并检查模型映射是否会产生歧义。排障时可临时只保留一条启用路由，先把链路跑通。</Callout>
    <ScreenshotFigure src={routesScreenshot} alt="StonePlus 路由管理页面" caption="路由卡会显示客户端、入站协议、目标来源、模型映射和启用状态。" onImage={onImage} />

    <SectionHeading topic="routes" id="route-models">模型与协议</SectionHeading>
    <Guide title="模型映射什么时候用" summary="客户端模型名与上游模型名不同才需要">
      <p>例如客户端请求一个固定别名，而中转只接受另一模型名，可以建立“请求模型 → 上游模型”的映射。没有映射时 StonePlus 会尽量保留原模型名。</p>
      <ul><li>先在来源 / 号池确认目标模型允许使用。</li><li>映射目标必须是上游真实接受的模型 ID，不要只填显示名称。</li><li>出现 model_not_found 时，先在请求记录核对最终模型，再修改映射。</li></ul>
    </Guide>
    <Guide title="本地令牌与上游密钥的区别" summary="客户端只应拿到本地令牌" open>
      <p>客户端配置写入的是路由的本地令牌，请求到达 StonePlus 后才在本地安全存储中取上游凭据。不要把上游 OAuth Token 或 API Key 手工写进客户端配置。</p>
    </Guide>
    <div className="help-action-row"><OpenPageButton page="routes" navigate={navigate}>打开路由</OpenPageButton><OpenPageButton page="clients" navigate={navigate}>下一步：配置客户端</OpenPageButton></div>
  </></LocalizedDoc>
}

function ClientsDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>客户端配置页把日常操作收成两件事：<strong>切换当前上游</strong>，或在客户端连不上时点<strong>一键修复连接</strong>。高级编辑器默认收起，不需要理解 TOML、JSON 或环境变量也能完成配置。</p></div>
    <SectionHeading topic="clients" id="client-before">先看当前状态</SectionHeading>
    <ul className="help-check-list">
      <li><CheckCircle2 size={16} /><span>顶部 Tab 选择 Codex、Claude Code 或 Gemini CLI；默认打开 Codex。</span></li>
      <li><CheckCircle2 size={16} /><span>“当前上游”显示这个客户端正在使用的号池、官方 API 或中转站。</span></li>
      <li><CheckCircle2 size={16} /><span>“配置正常”表示必要连接字段已能把客户端指向当前 StonePlus 网关。</span></li>
      <li><CheckCircle2 size={16} /><span>显示“配置损坏”或“尚未配置”时，直接使用“一键修复连接”。</span></li>
    </ul>
    <Callout title="切换上游不会再改坏客户端文件">下拉选择新上游时，StonePlus 只原子更新内部路由；不会重写 <code>config.toml</code>、<code>settings.json</code> 或 <code>.env</code>，客户端始终稳定连接本地 StonePlus。</Callout>

    <SectionHeading topic="clients" id="client-apply">一键修复连接</SectionHeading>
    <div className="help-apply-demo" aria-label="备份、修复、重启、验证四步动画示意">
      {['自动备份', '修复连接', '重启客户端', '发送验证'].map((step, index) => <div key={step} style={{ '--apply-index': index } as React.CSSProperties}><span>{index + 1}</span><strong>{step}</strong></div>)}
    </div>
    <Steps items={[
      { title: '选择出问题的客户端', text: '顶部 Tab 切换客户端，StonePlus 会自动检测默认配置目录和文件健康状态。' },
      { title: '点击“一键修复连接”', text: 'StonePlus 先备份现有文件；文件有效时只修复本地地址和本地令牌，模型、MCP、插件等用户设置保持不变。' },
      { title: '损坏文件自动重建', text: '若文件已经无法解析，会保留原始备份，再重建一份能连接 StonePlus 的最小配置。需要时可恢复修复前版本。' },
      { title: '重启客户端并验证', text: '大多数 CLI 只在启动时读取配置。完全退出后重新打开，再发送一条短请求。' },
    ]} />
    <ScreenshotFigure src={clientsScreenshot} alt="StonePlus 超级易用客户端配置" caption="默认页只保留上游切换、连接状态和修复入口；完整编辑器收在高级设置中。" onImage={onImage} />

    <SectionHeading topic="clients" id="client-backup">恢复与高级设置</SectionHeading>
    <Guide title="修复后想退回怎么办" summary="恢复最近备份" open>
      <p>检测到需要写入时，StonePlus 会先把已有相关文件保存为同一备份组。“恢复最近备份”会先给当前状态再做一次安全快照，然后整组恢复，避免 config/auth 或 settings/env 混用不同版本。</p>
    </Guide>
    <Guide title="什么时候才需要展开高级设置" summary="多目录、手工字段和完整源码编辑">
      <p>普通用户不需要展开。只有便携版配置目录、多套 Profile、手工调整模型/MCP/沙箱，或需要查看完整脱敏预览时再进入；未知设置仍会保留。</p>
    </Guide>
    <Guide title="什么时候建立 Profile" summary="多套安装目录或不同用途才需要">
      <p>默认 Profile 适合标准安装路径。便携版、测试目录、多个用户环境可各建一个 Profile，并独立设置目录和备份保留数量。Profile 只是本地配置模板，不包含上游明文凭据。</p>
    </Guide>
    <Callout tone="warning" title="没有“恢复出厂配置”">StonePlus 不会用一套大而全的模板覆盖你的文件。“一键修复连接”只处理连接链路；无法解析时才重建最小文件，并且始终先留备份。</Callout>
    <OpenPageButton page="clients" navigate={navigate}>打开客户端配置</OpenPageButton>
  </></LocalizedDoc>
}

function SessionRepairDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>会话修复是<strong>按需工具</strong>，不是首次运行必做项。它用于客户端仍记着旧 provider / 旧地址，导致新请求能用但旧会话无法继续的情况。</p></div>
    <SectionHeading topic="session-repair" id="repair-when">什么时候使用</SectionHeading>
    <div className="help-scenario-grid">
      <div><Wrench size={18} /><strong>适合修复</strong><p>换到 StonePlus 后只有旧 Codex 会话报 provider、401 或关联错误；新会话正常。</p></div>
      <div><Unplug size={18} /><strong>不要先修复</strong><p>所有新旧请求都失败、网关未运行、账号过期或网络诊断失败；先解决基础链路。</p></div>
    </div>
    <Callout title="先验证新会话">新建一个最小对话。如果新会话也失败，会话文件通常不是根因，请先看诊断和请求记录。</Callout>

    <SectionHeading topic="session-repair" id="repair-how">修复步骤</SectionHeading>
    <Steps items={[
      { title: '关闭 ChatGPT / Codex', text: '确保相关进程不再写入会话文件或 SQLite 数据库。' },
      { title: '打开会话修复并扫描', text: '系统会检查 Codex Home、rollout 文件、索引和数据库，先给出只读预览。' },
      { title: '选择目标 provider', text: '确认目标是当前 StonePlus 配置，不要在不清楚来源时批量替换。' },
      { title: '查看影响范围', text: '核对待更新文件数、数据库行数、跳过项目和安全备份说明。' },
      { title: '执行修复并重启', text: '修复完成后重新打开客户端，用原会话发送一条消息。' },
    ]} />

    <SectionHeading topic="session-repair" id="repair-safe">安全与回退</SectionHeading>
    <Guide title="修复会改什么" summary="只调整本地 provider / 路由关联，不改聊天正文" open>
      <p>预览会列出 rollout 与 SQLite 中需要修改的关联字段。工具会跳过无法识别或无法安全处理的内容，并记录备份 / 跳过数量。</p>
    </Guide>
    <Guide title="修复后仍失败" summary="用新旧会话对比定位">
      <ol><li>确认客户端已经完全重启。</li><li>比较新会话与旧会话在请求记录中的模型、路由和错误。</li><li>若没有任何请求到达 StonePlus，到客户端配置页一键修复连接。</li><li>若到达但上游 401 / 429，处理账号或配额，而不是重复修复会话。</li></ol>
    </Guide>
    <OpenPageButton page="session-repair" navigate={navigate}>打开会话修复</OpenPageButton>
  </></LocalizedDoc>
}

function TunnelDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>内网穿透把本机 StonePlus 网关临时映射为其他设备能访问的地址。它适合短期远程使用或局域网外测试，不应替代长期、受控的服务部署。</p></div>
    <SectionHeading topic="tunnel" id="tunnel-use">适用场景</SectionHeading>
    <div className="help-choice-grid">
      <div><MonitorCog size={18} /><strong>另一台设备临时调用</strong><p>StonePlus 运行在主机，笔记本或测试机通过穿透地址访问。</p></div>
      <div><Share2 size={18} /><strong>短时间验证集成</strong><p>无需修改路由器，验证外部客户端是否能正确使用本地路由。</p></div>
      <div><ShieldCheck size={18} /><strong>不适合公开分享</strong><p>地址和本地令牌都属于访问凭据，不要发布到群聊、截图或公共仓库。</p></div>
    </div>

    <SectionHeading topic="tunnel" id="tunnel-start">启动与连接</SectionHeading>
    <Steps items={[
      { title: '先完成本地链路', text: '本机客户端必须能请求成功；穿透无法修复来源、路由或网关问题。' },
      { title: '打开内网穿透并启动', text: '等待状态变为运行中，复制系统生成的远程地址。该功能可能仅在受支持的桌面平台显示。' },
      { title: '配置远程客户端', text: '用远程地址替换本地 Base URL，同时使用目标路由的本地令牌。' },
      { title: '发送短请求', text: '在 StonePlus 请求记录中确认远程请求到达；测试完成立即停止穿透。' },
    ]} />

    <SectionHeading topic="tunnel" id="tunnel-security">安全检查</SectionHeading>
    <ul className="help-check-list">
      <li><ShieldCheck size={16} /><span>只启用确实需要的路由，并为本地令牌按凭据级别保密。</span></li>
      <li><ShieldCheck size={16} /><span>不使用时停止穿透；地址失效后再从远程客户端移除。</span></li>
      <li><ShieldCheck size={16} /><span>请求记录不要长期启用完整负载日志，尤其是远程多人使用时。</span></li>
      <li><ShieldCheck size={16} /><span>出现未知请求立即停止穿透、轮换路由本地令牌并检查日志。</span></li>
    </ul>
    <Callout tone="warning" title="监听所有网卡与穿透是两回事">StonePlus 为保护本地凭据只允许 127.0.0.1、localhost 或 ::1，不接受 0.0.0.0。需要其他设备访问时请使用受控的内网穿透，不要直接暴露网关端口。</Callout>
    {tunnelSupported
      ? <OpenPageButton page="tunnel" navigate={navigate}>打开内网穿透</OpenPageButton>
      : <Callout title="当前平台不提供内网穿透">内置穿透目前只在 Windows 桌面端启用；其他平台仍可正常使用本地网关与全部账号调度功能。</Callout>}
  </></LocalizedDoc>
}

function BrowserDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>内置浏览器的目标是缩短“网页下载账号文件 → 找到文件 → 批量导入”的路径。浏览、下载和导入是分开的，文件不会因为下载完成就自动写入账号库。</p></div>
    <SectionHeading topic="browser" id="browser-purpose">能做什么</SectionHeading>
    <div className="help-definition-list">
      <div><strong>网页访问</strong><span>在 StonePlus 内打开需要的账号管理 / 下载页面，保留当前操作上下文。</span></div>
      <div><strong>下载管理</strong><span>查看进行中、成功和失败的下载；文件完全落盘后才允许导入。</span></div>
      <div><strong>批量导入</strong><span>勾选多个已完成文件，打开账号导入预览，统一设置标签、号池和代理。</span></div>
    </div>
    <ScreenshotFigure src={browserScreenshot} alt="StonePlus 内置浏览器与下载管理页面" caption="浏览器主区与下载抽屉在同一页面；下载完成后可勾选文件批量送往账号导入。" onImage={onImage} />

    <SectionHeading topic="browser" id="browser-import">下载并导入</SectionHeading>
    <Steps items={[
      { title: '打开可信页面', text: '核对地址栏域名，不在不可信页面输入账号、验证码或密钥。' },
      { title: '等待下载完成', text: '只有状态显示完成、文件大小稳定后再勾选；失败项可查看原因并重新下载。' },
      { title: '选择“导入到账号”', text: '浏览器只是把文件交给账号导入器，此时仍可取消。' },
      { title: '检查解析预览', text: '确认识别账号数、重复项、警告、目标号池 / 标签和代理策略。' },
      { title: '确认导入', text: '导入后去账号页刷新状态，删除不再需要的下载文件。' },
    ]} />

    <SectionHeading topic="browser" id="browser-privacy">登录与隐私</SectionHeading>
    <Guide title="浏览器登录状态" summary="把它当作独立的应用内浏览环境" open>
      <p>内置浏览器的 Cookie / 登录会话可能与日常浏览器不同。完成敏感操作后主动退出网站；公用电脑上不要勾选长期保持登录。</p>
    </Guide>
    <Guide title="下载项无法导入" summary="不是所有下载文件都是账号文件">
      <ul><li>确认下载状态为完成且文件未被移动。</li><li>确认格式是账号导入器支持的 JSON / 文本结构，而不是网页、压缩包或错误页。</li><li>单独打开账号与中转页手工选择文件，可看到更详细的解析错误。</li><li>解析出 0 个账号时不要强行导入，回到来源网站重新导出。</li></ul>
    </Guide>
    <div className="help-action-row"><OpenPageButton page="browser" navigate={navigate}>打开内置浏览器</OpenPageButton><OpenPageButton page="providers" navigate={navigate}>打开账号导入</OpenPageButton></div>
  </></LocalizedDoc>
}

function DiagnosticsDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>诊断页不会“猜一个原因”，而是把本地配置、所选网络出口和真实上游目标分层检查。排障时先诊断，再改配置，可以避免越改越乱。</p></div>
    <ScanDemo />
    <SectionHeading topic="diagnostics" id="diagnose-first">先做哪种检查</SectionHeading>
    <Steps items={[
      { title: '保持问题现场', text: '先不要批量删除账号或重建路由，记住刚才失败的客户端和出口。' },
      { title: '选择实际网络出口', text: '账号走代理就选择相同代理；否则选择直连 / 系统网络。' },
      { title: '运行一键诊断', text: '检查本地网关、可用来源、启用路由，以及 ChatGPT、Codex、OAuth 等网络目标。' },
      { title: '展开失败项目', text: '记录错误类别、目标、耗时和建议；再去对应页面修复一项并复测。' },
    ]} />
    <ScreenshotFigure src={diagnosticsScreenshot} alt="StonePlus 一键诊断结果页面" caption="顶部给出整体结论，下方分别显示本地配置和网络目标；失败项带直接说明。" onImage={onImage} />

    <SectionHeading topic="diagnostics" id="diagnose-read">看懂结果</SectionHeading>
    <div className="help-table-wrap"><table className="help-table"><thead><tr><th>结果</th><th>含义</th><th>下一步</th></tr></thead><tbody>
      <tr><td><span className="help-result help-result--success">正常</span></td><td>目标按预期响应；未必代表凭据有权调用所有模型。</td><td>继续检查下一层，最后发真实请求。</td></tr>
      <tr><td><span className="help-result help-result--warning">需关注</span></td><td>目标可达但响应不理想，或检查被代理模式跳过。</td><td>展开说明，确认是否符合当前出口设计。</td></tr>
      <tr><td><span className="help-result help-result--danger">失败</span></td><td>连接、DNS、TLS、超时或本地配置有明确错误。</td><td>按错误类别修复，不要盲目更换模型。</td></tr>
    </tbody></table></div>
    <Callout title="为什么未携带 Token 收到 401 也可能是正常">对仅检查接口可达性的项目，401 说明已经通过 DNS、连接和 TLS 到达服务端；它证明网络可达，不证明你的账号凭据有效。</Callout>

    <SectionHeading topic="diagnostics" id="diagnose-fix">按结果修复</SectionHeading>
    <Guide title="DNS / 连接超时" summary="优先比较直连和代理">
      <ol><li>检查本机网络与系统时间。</li><li>直连和目标代理各跑一次，比较是哪条出口失败。</li><li>确认代理协议 / 端口并检查防火墙。</li><li>网络恢复后重新诊断，StonePlus 会重建出站连接。</li></ol>
    </Guide>
    <Guide title="TLS / 证书错误" summary="检查代理拦截、系统时间与证书环境">
      <p>先关闭会做 HTTPS 解密的代理规则复测；公司网络需要自签根证书时，确认运行 StonePlus 的环境真正信任该证书。不要用关闭证书校验作为长期解决方案。</p>
    </Guide>
    <Guide title="本地配置失败" summary="按助手顺序补齐来源、路由、网关与客户端" open>
      <p>返回本页顶部“下一步助手”，点击第一项未完成任务。完成一项后重新检测，不必把所有高级设置都配置一遍。</p>
    </Guide>
    <div className="help-action-row"><OpenPageButton page="diagnostics" navigate={navigate}>运行一键诊断</OpenPageButton><OpenPageButton page="requests" navigate={navigate}>查看请求错误</OpenPageButton></div>
  </></LocalizedDoc>
}

function RequestsDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>请求记录是“客户端实际请求发生了什么”的证据。每条记录会关联客户端、路由后的来源 / 账号、模型、状态、延迟和可用的 Token 统计。</p></div>
    <SectionHeading topic="requests" id="logs-read">记录包含什么</SectionHeading>
    <div className="help-log-demo" aria-label="请求从流式处理中变为成功的动画示意">
      <Activity size={18} /><div><span><strong>Codex · gpt-5.x</strong><small>账号 A · OpenAI Responses</small></span><i /></div><b>流式 → 成功</b>
    </div>
    <div className="help-definition-list">
      <div><strong>状态</strong><span>成功、错误或流式中。流式请求结束后会自动转为最终状态并释放活跃槽位。</span></div>
      <div><strong>状态码 / 错误</strong><span>区分本地鉴权、路由、上游账号、限流和网络错误。</span></div>
      <div><strong>耗时</strong><span>总耗时、首字 / 首 Token、上游响应头等阶段指标帮助区分排队慢还是上游慢。</span></div>
      <div><strong>来源与账号</strong><span>显示调度实际选中了谁；重试时可结合详情查看不同尝试。</span></div>
      <div><strong>Token</strong><span>上游提供统计时显示输入、缓存和输出；缺失不代表没有产生用量。</span></div>
    </div>

    <SectionHeading topic="requests" id="logs-filter">筛选与定位</SectionHeading>
    <Steps items={[
      { title: '复现一次最小请求', text: '记住发生时间、客户端和模型；不要连续发送很多相同请求。' },
      { title: '按状态与客户端筛选', text: '先只看错误，再缩小到刚才的客户端 / 时间范围。' },
      { title: '打开详情', text: '复制状态码和错误文本，核对路由、账号、最终模型以及各阶段耗时。' },
      { title: '按类别跳转修复', text: '401 看凭据 / 本地令牌，404 看地址 / 模型，429 看配额与并发，超时看诊断和代理。' },
      { title: '修复后只复测一次', text: '用同一输入对比新旧记录，确认错误类别真正改变或消失。' },
    ]} />
    <Callout tone="warning" title="一直显示 1 个活跃请求怎么办">先刷新总览确认是否只是旧界面；再看最新记录是否仍是“流式”。若客户端已经收到完整结果，更新到包含流结束修复的最新版本并重启网关；若仍在传输，不要强制结束正常长请求。</Callout>

    <SectionHeading topic="requests" id="logs-privacy">负载与隐私</SectionHeading>
    <Guide title="是否记录请求正文" summary="默认只需要元数据，排障时再短期开启" open>
      <p>设置中的“记录请求负载”可能保存提示词或响应内容。日常保持关闭；确需排查协议问题时短期开启，复现一次后立即关闭，并在分享日志前删除凭据和私人内容。</p>
    </Guide>
    <Guide title="日志太多如何处理" summary="先导出证据，再按设置清理">
      <p>保留故障时间附近的记录和截图即可。清理历史不会删除账号、号池或路由，但会失去统计和排障证据。</p>
    </Guide>
    <OpenPageButton page="requests" navigate={navigate}>打开请求记录</OpenPageButton>
  </></LocalizedDoc>
}

function SettingsDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>设置页控制本地网关如何启动、监听和保存数据。第一次使用保留默认值最稳妥，确认有明确需求后再改监听范围、负载日志和网络模式。</p></div>
    <SectionHeading topic="settings" id="settings-gateway">网关与启动</SectionHeading>
    <div className="help-table-wrap"><table className="help-table"><thead><tr><th>设置</th><th>推荐值</th><th>什么时候修改</th></tr></thead><tbody>
      <tr><td>监听地址</td><td><code>127.0.0.1</code></td><td>仅当明确要让局域网设备访问，并已理解防火墙与令牌风险。</td></tr>
      <tr><td>端口</td><td><code>15721</code> 或当前可用端口</td><td>端口冲突时调整；修改后重新应用所有客户端配置。</td></tr>
      <tr><td>自动启动网关</td><td>常用时开启</td><td>只偶尔使用或需要手工控制服务时关闭。</td></tr>
      <tr><td>登录时启动应用</td><td>按习惯</td><td>希望开机后客户端立即可用时开启。</td></tr>
      <tr><td>连接 / 流空闲超时</td><td>保留默认</td><td>非流式请求按总时长控制；流式请求只在连接或连续无数据超过该时间时终止，持续返回内容的长任务不会被误切断。</td></tr>
      <tr><td>出站网络</td><td>直连 / 系统模式择一</td><td>需要跟随系统代理时选系统；账号 / 号池显式代理仍按其设置。</td></tr>
    </tbody></table></div>
    <Callout title="设置显示端口和实际端口">运行中的真实地址以总览 / 网关状态为准。改端口后先重启网关，再到客户端配置页一键修复连接，避免客户端仍连旧端口。</Callout>

    <SectionHeading topic="settings" id="settings-data">数据与备份</SectionHeading>
    <Guide title="自动备份与保留数量" summary="保留足够回退点，但不要无限增长" open>
      <p>自动备份用于本地配置和客户端文件的安全回退。建议保持开启并使用合理保留数；定期把重要导出放到受保护位置。</p>
    </Guide>
    <Guide title="导出 / 导入配置" summary="迁移前先确认凭据处理方式">
      <ul><li>导出前查看说明，区分普通配置与敏感凭据。</li><li>导入会影响现有来源、号池、路由或设置时，先做当前版本备份。</li><li>迁移到另一台机器后重新检测客户端目录、网络出口和系统密钥库。</li><li>不要把包含敏感信息的导出提交到 Git 或网盘公开链接。</li></ul>
    </Guide>

    <SectionHeading topic="settings" id="settings-safe">安全建议</SectionHeading>
    <ul className="help-check-list">
      <li><ShieldCheck size={16} /><span>保持本机监听；只有明确需要时才扩大到局域网或穿透。</span></li>
      <li><ShieldCheck size={16} /><span>本地令牌也属于凭据，不要贴到截图、Issue 和群聊。</span></li>
      <li><ShieldCheck size={16} /><span>日常关闭完整请求负载日志，敏感排障完成后及时清理。</span></li>
      <li><ShieldCheck size={16} /><span>密钥库不可用时先解决系统环境，不要用明文文件绕过。</span></li>
      <li><ShieldCheck size={16} /><span>更新或大规模导入前先备份，恢复后再运行一次端到端验证。</span></li>
    </ul>
    <OpenPageButton page="settings" navigate={navigate}>打开设置</OpenPageButton>
  </></LocalizedDoc>
}

function UpdatesDoc({ navigate, onImage }: { navigate: (page: PageId) => void; onImage: (image: { src: string; alt: string }) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>桌面版可以在应用内检查更新、查看版本说明并下载安装。便携版或部分平台的安装方式可能不同，界面会给出适合当前构建的操作。</p></div>
    <SectionHeading topic="updates" id="update-check">在线更新</SectionHeading>
    <div className="help-update-demo" aria-label="检查、下载、校验、重启安装动画示意">
      {['检查版本', '下载更新', '校验文件', '重启安装'].map((label, index) => <div key={label} style={{ '--update-index': index } as React.CSSProperties}><span>{index < 3 ? <Check size={13} /> : <RefreshCw size={13} />}</span><strong>{label}</strong></div>)}
    </div>
    <Steps items={[
      { title: '打开更新入口', text: '从设置或更新提示打开对话框，查看当前版本、新版本和发布说明。' },
      { title: '开始下载', text: '保持 StonePlus 运行；界面会显示进度、速度或阶段，不要重复点击。' },
      { title: '等待校验', text: '下载完成后还需校验文件完整性，校验失败不会直接安装。' },
      { title: '保存工作并重启', text: '确认没有进行中的请求或导入任务，再按提示重启完成更新。' },
      { title: '更新后验证', text: '查看版本号，启动网关并发一个短请求，确认客户端配置仍匹配实际端口。' },
    ]} />
    <ScreenshotFigure src={onlineUpdateScreenshot} alt="StonePlus 在线更新对话框" caption="更新对话框展示版本说明、下载 / 校验阶段和下一步按钮，不需要手工寻找安装包。" onImage={onImage} />

    <SectionHeading topic="updates" id="update-before">更新前准备</SectionHeading>
    <ul className="help-check-list">
      <li><CheckCircle2 size={16} /><span>等待活跃请求归零，暂停批量导入、OAuth 授权和会话修复。</span></li>
      <li><CheckCircle2 size={16} /><span>保留一份近期自动备份；跨大版本时额外导出普通配置。</span></li>
      <li><CheckCircle2 size={16} /><span>确认磁盘空间和网络稳定，不要在下载中强制结束进程。</span></li>
      <li><CheckCircle2 size={16} /><span>使用与当前系统架构一致的构建：Windows / Linux / macOS、x64 / ARM64。</span></li>
    </ul>

    <SectionHeading topic="updates" id="update-failed">更新失败</SectionHeading>
    <Guide title="下载失败或速度为零" summary="保留当前版本，检查网络后重试" open>
      <ol><li>关闭更新窗口后重新检查，确认不是短暂断网。</li><li>用诊断确认基础网络；下载源受限时切换系统网络环境。</li><li>检查磁盘空间和临时目录权限。</li><li>仍失败时从项目 Release 页面手工下载当前平台安装包。</li></ol>
    </Guide>
    <Guide title="校验失败 / 安装后仍是旧版本" summary="不要反复安装同一个损坏文件">
      <p>重新下载，确认安全软件没有截断或隔离安装文件。完全退出 StonePlus 后再运行安装包；便携版应替换正确目录而不是启动旧快捷方式。</p>
    </Guide>
    <Callout tone="warning" title="不要卸载来“清缓存”">更新失败通常不需要先卸载。先保留现有可用版本和数据，备份后再选择覆盖安装或便携版替换。</Callout>
    <OpenPageButton page="settings" navigate={navigate}>前往设置检查更新</OpenPageButton>
  </></LocalizedDoc>
}

type FaqItem = {
  group: 'startup' | 'requests' | 'config'
  question: string
  answer: ReactNode
  action?: { page: PageId; label: string }
}

const faqItems: FaqItem[] = [
  {
    group: 'startup', question: '网关启动失败，提示端口被占用怎么办？',
    answer: <>先在设置中换到相邻空闲端口并重启网关。随后到客户端配置页点击“一键修复连接”，让客户端改用实际端口。若必须使用原端口，先退出占用它的旧 StonePlus 或其他服务。</>,
    action: { page: 'settings', label: '检查网关设置' },
  },
  {
    group: 'startup', question: '客户端提示无法连接或 Connection refused？',
    answer: <>确认客户端配置页的“配置文件、内部路由、本地网关”三个状态。点击“一键修复连接”后完全重启客户端；仍无请求记录时，再检查客户端实际读取的配置目录。</>,
    action: { page: 'clients', label: '一键检查并修复' },
  },
  {
    group: 'startup', question: '顶部助手一直说客户端未配置，但我已经保存了 Profile？',
    answer: <>保存 Profile 只是选择配置目录，不等于已经建立连接。打开客户端配置页，选择对应客户端并点击“一键修复连接”，然后完全重启客户端。</>,
    action: { page: 'clients', label: '修复客户端连接' },
  },
  {
    group: 'startup', question: '一定要创建号池吗？',
    answer: <>不一定。多个 OAuth / ChatGPT 账号通常先组成号池；保存正确的单个官方 API 或中转可以直接作为路由来源。顶部助手会按实际可路由来源判断。</>,
  },
  {
    group: 'requests', question: '请求后一直显示 1 个活跃请求怎么办？',
    answer: <>先确认客户端是否仍在接收流式响应。若结果已经完整返回，刷新页面并更新到包含流结束修复的最新版本，然后重启网关。请求记录仍显示“流式”时展开详情；不要在正常长请求尚未结束时强制停止。</>,
    action: { page: 'requests', label: '查看最新请求' },
  },
  {
    group: 'requests', question: '出现 401 / Unauthorized 怎么定位？',
    answer: <>没有请求记录时多半是客户端使用了错误的本地令牌；有记录且错误来自上游时，刷新账号状态、重新 OAuth 登录或核对 API Key。不要把上游密钥直接写到客户端来绕过 StonePlus。</>,
    action: { page: 'requests', label: '区分本地与上游 401' },
  },
  {
    group: 'requests', question: '出现 403 或地区限制怎么办？',
    answer: <>先用诊断比较直连和代理出口。403 也可能是账号权限或服务商策略，不要只靠反复重试；核对目标模型权限、出口地区和中转规则。</>,
    action: { page: 'diagnostics', label: '比较网络出口' },
  },
  {
    group: 'requests', question: '出现 429 / 配额不足或并发限制？',
    answer: <>查看账号配额、冷却状态和最大并发。多个账号可用智能均衡号池分担；只有一个账号时降低并发并等待上游限流窗口恢复。增加重试次数不会产生新额度。</>,
    action: { page: 'providers', label: '检查账号配额' },
  },
  {
    group: 'requests', question: '模型不存在 / model_not_found？',
    answer: <>在请求详情确认“客户端请求模型”和最终上游模型；刷新来源可用模型，检查号池白名单与路由模型映射。映射目标必须使用上游真实模型 ID。</>,
    action: { page: 'routes', label: '检查模型映射' },
  },
  {
    group: 'requests', question: '请求很慢，应该调哪个参数？',
    answer: <>先看首 Token、调度、凭据解析与上游响应头耗时。网络慢先处理代理；账号排队先看并发和号池；只有尾延迟明显时才考虑对冲请求。不要一次同时修改超时、重试、并发和策略。</>,
    action: { page: 'requests', label: '查看阶段耗时' },
  },
  {
    group: 'config', question: '换账号后旧会话不能继续，但新会话正常？',
    answer: <>这是会话修复的典型场景。先关闭 ChatGPT / Codex，扫描并预览旧 provider 关联，确认影响范围后执行修复，再重启客户端。</>,
    action: { page: 'session-repair', label: '预览会话修复' },
  },
  {
    group: 'config', question: '代理显示可用，但请求仍超时？',
    answer: <>代理卡测试可能只验证代理握手。到诊断页选择同一出口，检查真实 GPT / OAuth 目标；同时确认账号级代理是否覆盖了号池代理。</>,
    action: { page: 'diagnostics', label: '用该代理诊断' },
  },
  {
    group: 'config', question: '一键修复连接会覆盖我原来的配置吗？',
    answer: <>文件能正常解析时，只修改连接 StonePlus 所需的地址、provider 和本地令牌，模型、MCP、插件与未知字段会保留。文件已经损坏时会先完整备份原文，再重建最小可用文件；可随时恢复修复前版本。</>,
    action: { page: 'clients', label: '检查并修复连接' },
  },
  {
    group: 'config', question: '内置浏览器下载完成但无法导入？',
    answer: <>确认文件状态是完成、路径仍存在、内容是支持的账号 JSON / 文本而不是 HTML 错误页或压缩包。到账号导入页手工选择该文件可查看详细解析错误。</>,
    action: { page: 'providers', label: '手工选择文件' },
  },
  {
    group: 'config', question: '在线更新失败会损坏现有配置吗？',
    answer: <>下载或校验失败不会要求你先卸载。保留当前可用版本，检查网络、磁盘和安全软件后重试；更新前做好备份，必要时从 Release 下载匹配平台的安装包覆盖安装。</>,
    action: { page: 'settings', label: '重新检查更新' },
  },
]

function FaqDoc({ navigate }: { navigate: (page: PageId) => void }) {
  return <LocalizedDoc><>
    <div className="help-lead"><p>按现象找到问题后，先执行答案中的第一项并复测。排障的目标是确认错误发生在哪一层，而不是把所有配置重新做一遍。</p></div>
    <SectionHeading topic="faq" id="faq-startup">启动与连接</SectionHeading>
    <FaqList items={faqItems.filter((item) => item.group === 'startup')} navigate={navigate} />
    <SectionHeading topic="faq" id="faq-requests">请求与账号</SectionHeading>
    <FaqList items={faqItems.filter((item) => item.group === 'requests')} navigate={navigate} />
    <SectionHeading topic="faq" id="faq-config">配置与更新</SectionHeading>
    <FaqList items={faqItems.filter((item) => item.group === 'config')} navigate={navigate} />
    <Callout title="提交问题时带什么信息">StonePlus 版本与系统、失败时间、客户端、诊断结果、请求状态码和已脱敏错误即可。不要附 OAuth Token、API Key、本地令牌、Cookie 或完整私人提示词。</Callout>
  </></LocalizedDoc>
}

function FaqList({ items, navigate }: { items: FaqItem[]; navigate: (page: PageId) => void }) {
  return <div className="help-faq-list">{items.map((item) => <details key={item.question}>
    <summary><CircleHelp size={16} /><strong>{item.question}</strong><ChevronRight size={16} /></summary>
    <div><p>{item.answer}</p>{item.action && <button type="button" onClick={() => navigate(item.action!.page)}>{item.action.label}<ArrowRight size={14} /></button>}</div>
  </details>)}</div>
}
