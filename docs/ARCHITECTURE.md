# Stone+ v0.7 架构边界

## 进程模型

```text
React renderer
  | metadata + protected config IPC
Electron preload (contextBridge)
  |
Electron main process
  +-- AppStore + SQLite: metadata, profiles, logs + encrypted credential blobs
  +-- CredentialLifecycleResolver: API key / renewable bearer / refresh lock
  +-- ClientConfigService: profile-scoped detect, plan, backup, apply, restore
  +-- Provider Adapter registry: endpoint, auth, discovery, probe, errors
  +-- OutboundTransportManager: direct / HTTP(S) / SOCKS4 / SOCKS5 dispatchers
  +-- PoolScheduler: strategy, concurrency, sticky session, circuit breaker
  +-- Protocol conversion: request/response + canonical stream events
  +-- GatewayServer: loopback HTTP server, retry, failover, backpressure
```

Renderer 不持有上游明文凭据。账号保存时，明文只进入 main process，使用系统凭据能力加密后写入状态快照；网关发起请求时才按 `credentialId` 解密。

客户端配置文件只由 main process 读取和修改。用户主动打开配置编辑器后，renderer 可以接收配置正文，但环境变量、Header、Token、Secret、Credential 等敏感值会先替换为占位符；保存时 main process 从 revision 对应的原文件恢复占位值。Codex `auth.json` 不提供正文，Claude `~/.claude.json` 只投影 `mcpServers`。

## 领域模型

- `ProviderDefinition`：供应商种类、URL、协议和模型目录，不含账号凭据。
- `ProxyDefinition`：本地代理入口协议、主机、端口、可选用户名、加密密码引用与出口探测状态。
- `Account`：供应商下的独立凭据、优先级、权重、并发、健康状态、可选代理覆盖，以及账号级可用模型目录与开放策略。
- `Pool`：同协议账号集合及其调度、粘性、重试策略、可选默认代理和号池级开放模型策略。
- `Route`：客户端原生入站协议、本地 Token、目标号池和模型映射。Claude Code 固定使用 Anthropic Messages，Codex 固定使用 OpenAI Responses，Gemini CLI 固定使用 Gemini；协议转换发生在 Route 与目标 Pool 之间。

这些层保持独立，避免把“厂商配置”“一把 Key”“网络出口”“调度集合”和“客户端入口”压成同一个对象。供应商种类与协议的兼容性由存储层校验，renderer 只提供合法组合。

## 出口代理

`OutboundTransportManager` 为 HTTP、HTTPS、SOCKS4 和 SOCKS5 构造可复用 dispatcher。每次网关尝试先解析“账号代理 > 当前号池默认代理 > 直连”，并把同一个 fetch 实现同时交给 OAuth 刷新和生成请求，避免凭据刷新与业务流量从不同出口发出。账号独立检测、模型发现和额度刷新没有确定的号池上下文，因此只使用账号代理，未配置时直连。

代理密码复用 `credentials` 表和 Electron `safeStorage`；renderer 快照只包含 `hasPassword`，不包含密码或 `credentialId`。主机、端口和用户名是可见的本机元数据。dispatcher 缓存键包含代理更新时间和认证指纹，修改密码后不会继续复用旧连接配置。引用丢失、密码不可读或连接失败均 fail closed，不回退直连。

代理检测通过该代理访问受限大小的公网 IP 服务，并只持久化校验后的 IP、延迟和固定脱敏错误。检测结果不参与自动绕过逻辑；异常代理仍需用户修复或显式解除绑定。

## Provider Adapter

Provider Adapter 与协议转换是两个不同边界。前者负责“如何访问某类上游”，后者负责“不同 API 语义如何互换”。当前注册表包含 OpenAI、OpenAI Compatible、Anthropic、Anthropic Compatible、Google Gemini 和 Custom 适配器。

每个适配器统一提供：

- 生成、模型发现和健康探测端点的构造，并规范化带版本或不带版本的 Base URL。
- Bearer、`x-api-key` 或 `x-goog-api-key` 等认证头注入；适配器不保存或返回凭据。
- 协议能力矩阵、模型列表解析和账号连通性探测。
- HTTP、超时、取消和网络故障的统一分类，以及可重试性、账号动作和 `Retry-After` 解析。

模型刷新和账号检测通过同一适配器执行，避免 UI 检测逻辑与真实网关请求使用不同的 URL、认证或错误规则。模型发现使用单个总超时完整读取 Gemini `pageToken` 或 Anthropic `after_id` 分页；重复游标、超过 20 页或任一后续页失败都会放弃整个结果。OpenAI 目录只排除高置信度的 embedding、moderation、TTS、转录、图像等端点专用模型，未知兼容模型默认保留。

## 模型开放策略

账号模型刷新严格使用指定账号的凭据和账号代理。成功结果原子写入 `availableModels`，并以 `modelsRefreshedAt` 标记为权威目录；发现开始与提交之间通过不含明文凭据的配置指纹做乐观并发校验，迟到的旧凭据或旧 Provider 结果不能覆盖新配置。

账号和号池均使用显式 `all | selected` 策略，`selected + []` 表示明确不开放任何模型。号池的有限候选目录是所有启用成员账号开放模型的并集；UI 同时显示每个模型的支持账号数。Scheduler 在 Route 模型映射后先检查号池策略，再筛选支持目标模型的账号，最后应用健康、额度、冷却和并发约束。

旧账号的非空白名单迁移为 `selected`，空白名单迁移为尚未刷新的 `all`。后者为了兼容旧请求在调度时仍是 wildcard，但 Provider 目录 fallback 只用于有限枚举，不能据此破坏性修剪已保存的号池选择。首次成功账号刷新后，权威目录替代 wildcard。按 Route Token 访问 `GET /v1/models` 或 `GET /v1beta/models` 时只读取本地策略，不解密账号凭据，也不访问上游。

## 凭据生命周期

`CredentialLifecycleResolver` 把凭据解析与厂商授权传输分离。API Key 直接从受保护的 secret reference 读取；可续期 Bearer 在过期前进入刷新窗口，同一 credential 的并发请求共享一个 refresh flight。刷新适配器可以返回轮换后的 Refresh Token，Stone+ 只在其安全持久化完成后使用新 Access Token。取消、`invalid_grant`、撤销、临时失败和无效响应分别分类，错误与可序列化结果不含 Secret。

ChatGPT Team / Business 账号通过用户显式导入的 Codex session JSON 接入。Stone+ 将整个 session bundle 用系统凭据保险库加密，renderer 只看到账号类型、掩码、到期时间和是否可续期；完整 `chatgpt-account-id` 不进入 renderer 快照或诊断报告。实际请求固定发送到 `https://chatgpt.com/backend-api/codex/responses`，携带 Bearer、`chatgpt-account-id` 与 Codex 客户端头，并强制 `store=false`、`stream=true`。存在 Refresh Token 时通过 OpenAI OAuth token endpoint 提前续期并原子轮换，刷新 scope 使用 `openid profile email`；没有 Refresh Token 时按 Access Token 到期时间停止调度。Stone+ 不自动读取 Codex 登录缓存，也不抓取 Cookie。

## 请求生命周期

```text
本机客户端
  -> 校验路径、入站协议与 Route Token
  -> 解析模型映射并加载 Pool
  -> 校验 Pool 开放策略并筛选支持目标模型的 Account
  -> Scheduler 选择并占用 Account
  -> 解析账号覆盖或号池默认出口
  -> 转换请求协议
  -> Provider Adapter 构造端点并注入上游凭据
  -> 请求上游 Provider
  -> 同协议流原样透传，或转换非流式/跨协议流式响应
  -> 更新账号健康状态并释放并发槽
  -> 写入不含正文的元数据日志
```

每次重试都会独立占用和释放账号并发槽。客户端断开会取消上游读取，请求超时与客户端断开信号共同传递给上游请求。

## 协议与流式转换

Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 和 Gemini 使用统一的非流式请求/响应模型执行互转。
ChatGPT Codex OAuth 上游始终返回 Responses SSE。当下游请求 `stream=false` 时，Stone+ 增量解析事件，以 `response.completed` 或 `response.incomplete` 为终止依据，聚合文本、工具调用与用量为普通 Responses JSON，再走现有非流式协议转换；不完整或失败的流不会伪装成成功响应。

跨协议流式响应先被解析为协议无关事件，再编码为入站协议：

```text
upstream SSE / chunked JSON
  -> CanonicalStreamEvent
     start | text-delta | tool-call-delta | usage | stop | error | done
  -> client protocol stream
```

解析器接受任意网络分块和拆开的 UTF-8 字节，并处理 SSE、JSON 流与 `[DONE]`。工具调用的 ID、名称和参数按索引增量拼接；用量、停止原因和流内错误会转换成目标协议对应事件。跨协议流中解析出的用量会进入请求日志，流内错误会影响账号健康状态。

当入站与上游协议相同时，Stone+ 不重编码正文；除跨 chunk 替换当前上游凭据外，直接透传上游字节和关键流式响应头，同时用旁路解析器观察标准终止、错误和用量事件。两条路径都会遵守 Node 响应背压；这样既保留同协议流的原始兼容性，也允许跨协议流逐块转换而不缓存完整响应。流在没有协议终止标记或停止原因时结束会被视为截断，而不是合成正常完成。

## 错误、重试与熔断

Provider Adapter 的错误分类决定网关是否切换账号：

- `401` / `403`：凭据或权限被拒绝；`402`：账号额度耗尽或需要付费。这三类错误会停用当前账号，但本次请求仍可在重试额度内切换到其他账号。
- `408`、`409`、`425`、`429`、`5xx`、超时和网络错误：可重试，并让账号进入冷却。
- 客户端取消：不重试，也不把取消当成上游账号故障。
- 其他请求错误：直接返回，不盲目切换账号。

调度器使用指数退避，默认从 30 秒开始并限制最大延迟；如果上游 `Retry-After` 更长，则以它为准。熔断状态为 `closed`、`open` 和 `half-open`：冷却期内跳过 open 账号，到期后只允许一个 half-open 探测请求，成功后清零连续失败并关闭熔断，失败则重新进入更长冷却。

网关通过 IPC 层把账号状态、连续失败数、冷却截止时间、最近错误和延迟写回 `AppStore`。调度器启动时会恢复这些状态和退避次数，冷却到期后仍只放行一个 half-open 探测。手动检测成功或更换凭据会同时清除持久化状态与调度器内存状态。

成功响应中的 RateLimit 头会归一化为请求、总 Token、输入 Token 和输出 Token 窗口。remaining 为零且 reset 时间未到的账号不可选；接近耗尽的账号根据压力降低有效优先级或权重。窗口到期后账号无需人工操作即可再次参与调度。

ChatGPT OAuth 账号还会主动查询 `https://chatgpt.com/backend-api/wham/usage`，并从所有 Codex 生成响应（包括 `429`）读取 `x-codex-*` 头。窗口按上游报告的时长识别为 5 小时或 7 天，不依赖 primary/secondary 的固定顺序。WHAM payload 只提取额度数值，不持久化用户、邮箱、完整账号 ID 或原始响应。

## 客户端配置服务

当前管理的默认文件为：

| 客户端 | 文件 |
| --- | --- |
| Claude Code | `~/.claude/settings.json`、`~/.claude.json` 中的 `mcpServers` |
| Codex | `~/.codex/config.toml`、`~/.codex/auth.json` |
| Gemini CLI | `~/.gemini/settings.json`、`~/.gemini/.env` |

服务先在内存中生成变更计划，解析失败时不会写文件或创建备份。JSON 与 dotenv 修改保留未知字段、无关行和原换行风格；Codex TOML 使用 `smol-toml` 在修改前后校验，并定点更新 Stone+ 管理的字段，保留注释、未知配置和其他 section。常用设置通过受限 `fieldId` 局部 patch，完整编辑器只接受受管文件 role，不接受 renderer 提交的任意路径。

编辑器 revision 使用进程内随机密钥计算 HMAC。保存时如果磁盘内容已被外部 CLI 修改，revision 校验会在备份和写入前拒绝操作。JSON 的敏感键与 `env` / Header 容器、dotenv 的所有值在 IPC 前替换为占位符；Claude 用户状态文件的 OAuth、缓存和项目状态从不进入投影。

每个客户端至少有一个不可删除的默认 Profile，也可以创建指向绝对路径的自定义 Profile。普通预览只返回文件路径、是否变化和 Stone+ 管理的字段名；完整编辑器按用户操作加载受保护正文。Profile 不存储客户端配置正文。备份保留策略按文件独立计算，应用成功后才清理超出上限的旧备份。

应用计划时，每个已存在且将变化的文件先创建同目录 `.stone-backup.*` 备份，再通过临时文件和重命名原子替换。多文件写入中途失败会回滚已写文件。恢复操作只接受服务能够枚举到的受管备份，并在覆盖当前文件前再创建一份安全备份。

POSIX 系统上的临时文件和备份使用 `0600`；包含路由 Token 的目标文件也固定为 `0600`。这些备份仍位于用户目录并可能包含本地路由 Token，因此属于本机敏感数据。

### CLI 运行环境与 CC Switch 对齐边界

2026-10-23 对照 [CC Switch v4.0.18](https://github.com/farion1231/cc-switch/releases/tag/v4.0.18) 核对客户端生命周期能力，保留 Stone+ 的界面与路由模型，不复制其 Provider 管理模型或源代码。

- `cli-environment.ts` 为 CLI 发现、安装命令和受管实例启动提供同一套 PATH 补齐能力。macOS/Linux 从登录 shell 仅读取 PATH，保留当前进程 PATH 优先级，不导入 shell 的认证、模型或配置目录变量，也不修改 `process.env`。
- shell 探测有 2 秒硬截止和 64 KiB 输出上限；超时、启动失败时使用已知目录回退。同一环境的并发探测合并，成功缓存 60 秒、失败缓存 5 秒。Windows 不启动登录 shell。
- Windows 终端启动已使用启动稳定窗口确认，不等待用户关闭终端；`start /wait` 仅保留受管进程树，不作为启动完成条件。
- 客户端配置继续使用字段级修改、原子写入、备份和回滚，保留用户 MCP 等无关字段。配置目录与路由环境在 PATH 补齐之后注入，保持实例隔离。
- 本次不新增 Antigravity 等客户端，不引入 Rust 专用的文件描述符调整或 MSI 更新选项；这些不等同于现有 Electron/NSIS 实现。macOS/Linux 登录 shell 行为有模拟回归，本机真实进程烟测在 Windows 执行，不代表已完成 macOS 真机验收。

### Agent 业务流程约束

Agent 控制入口通过 `resolveAgentRouteState` 复用路由的真实来源兼容性分析，而不是仅凭客户端入站协议判断。原生来源与可转换来源分别呈现；临时冷却、并发占满不等于协议不兼容，也不因此丢失来源名称。启动、重启、修复在执行破坏性动作之前重新检查当前路由；受管实例直接启动也检查所绑定来源。

全局修复保持原运行状态：只恢复操作前运行的实例，不启动原本关闭的客户端。来源不兼容时返回独立 Agent 错误，不先关闭正在运行的客户端。

桌面端、CLI 与只负责打开应用的入口共用网关就绪检查；启动或恢复运行前，确保网关在当前配置地址监听。端口占用/地址不匹配先报错，不先关闭客户端。仅修复一个已停止客户端的配置时，不因此启动网关。网关准备结束后重查来源与取消信号，避免等待期间的切源或取消被忽略。

`tests/gateway/client-business-flow.test.ts` 使用隔离回环端口与受控 HTTP 上游验证工具结果回传、切中转、原生 compact 后续聊、多个客户端路由/凭证隔离，以及单源 502 和客户端取消后的下一请求恢复、连接与并发槽释放。它覆盖真实网关传输，不使用真实供应商凭据，也不等同于真实桌面客户端/供应商端到端验收。

继续对照 [CC Switch 的切源业务边界（v4.0.18）](https://github.com/farion1231/cc-switch/blob/v4.0.18/docs/user-manual/zh/2-providers/2.2-switch.md)：纯路由切换不等同于修改客户端连接配置，不因切换上游而无条件重启客户端。回环烟测覆盖旧流未结束时切源：旧流完成、新请求进入新源、其他客户端保持原路由，最终释放全部并发槽。

网关设置变更通过 `gateway-settings-transaction.ts` 在既有生命周期队列内执行失败补偿。停止、启动或出口应用失败时恢复之前的网关设置、出口模式、被修改的备份调度，以及原监听状态；不会用旧全量快照覆盖期间更新的路由或账号。原来停止的网关保持停止，恢复不完整时返回原始错误和补偿错误并发布实际状态。账号冷却清理推迟至监听迁移成功之后。真实回环测试占用目标端口，验证失败后旧地址能继续完成请求。

上述补偿是进程内失败恢复，并非跨进程崩溃事务；不承诺配置保存期间断电或强制结束进程后的自动回滚。成功修改监听地址也不等同于自动迁移所有外部客户端配置，客户端接入检查仍需按实际地址校验。

一键连接与客户端配置页切源共用 `client-connection-workflow.ts`：先只读比较新旧路由对应的客户端配置，再决定是否需要重启。需要重启时先确认，取消不写配置或路由；纯路由热切换不修改客户端文件。运行中的受管客户端由生命周期服务完成关闭、备份、修复、校验、启动，renderer 不再提前写配置导致备份变成新配置。自定义 Profile 不自动重启默认目录的客户端；外部会话明确提示手动重启或新开会话。

显式一键连接的预览与最终检查使用 `planRepair`，与实际修复语义一致，包含普通连接预览不修改的 Codex 外来模型残留；纯切源仍比较普通连接配置，不顺带触发无关修复。未托管运行状态下的直接配置修复保留本次备份组和写入 revision，最终校验失败时在路由恢复后执行受保护的配置回滚；不会回退外部新写入的文件或较新的路由。新增回滚 IPC 要求非空备份组和 revision，且仍经过可信发送者、客户端与 Profile 校验。

路由写入和失败补偿使用完整旧值 compare-and-swap，而非仅比较毫秒时间戳，避免回滚覆盖后来的切源。激活关键步骤重新检查路由；新版本连接预览仅返回差异标记，不返回配置内容或凭据。纯切源的连接重启不运行 Codex 会话迁移；多客户端中途失败时，已成功激活的客户端在旧路由恢复成功后尝试重新应用旧连接，补偿失败单独报告。

CLI 连接备份保留到启动成功，启动失败后先停止本次部分启动的受管实例，再恢复文件与原运行状态。自动恢复使用写入时的 HMAC revision 校验；用户或客户端的新改动优先，冲突时不覆盖、不宣称恢复成功。手动选择备份恢复仍是明确的用户操作。Codex Desktop 连接准备同样覆盖启动失败；深度会话修复只在迁移提交前允许回滚连接，迁移已提交而启动失败时保留备份并报告部分完成，不擅自反向改写会话历史。

配置回滚不完整使用独立的 `ClientConfigRollbackError`，生命周期沿 cause 链识别该状态，不靠错误文本匹配。连接准备和深度修复遇到此状态时保持 Codex 停止，不在无法确认配置一致性时自动重新启动。`tests/renderer/client-connection-files.test.ts` 使用真实临时配置覆盖上述修复预览、失败恢复与外部编辑冲突；生命周期测试覆盖成功回滚后恢复进程以及失败回滚后禁止启动。

这些流程仍是可补偿的进程内编排，不是跨多个客户端、SQLite、文件系统和进程的全局原子事务。外部进程不参与 Stone+ 操作锁；冲突保护不等于外部文件系统锁。多客户端深度会话迁移部分完成、进程拒绝退出、文件已被外部修改时会返回可见的恢复错误，不能承诺无条件回到操作前所有状态。

## 持久化

`AppStore` 使用 `node:sqlite`、WAL、`BEGIN IMMEDIATE` 和串行写队列。Providers、Accounts、Proxies、Pools、Routes、Profiles、日志与凭据密文分别存表，schema migration 在事务中执行。旧 JSON 仅导入一次，数据库标记成功后源文件改名为 `.migrated*.bak`；迁移或提交失败会回滚，内存状态不会提前切换。

SQLite 最多保留 20,000 条请求历史，逐条增量写入并裁剪超限旧记录，renderer 只获得最近 500 条。日志记录路由结果、模型、状态码、延迟、Token 计数和故障切换次数；24 小时/7 天统计从完整本地历史聚合。`logPayloads` 强制关闭。同协议流由旁路解析器提取标准用量事件，跨协议流记录规范化事件中出现的用量；两者都不会记录正文。

小时级请求、错误、Token、延迟和故障切换趋势，以及账号停用、冷却、额度耗尽与恢复事件都保存在本地。健康事件最多保留 2,000 条；桌面通知只包含账号显示名和脱敏状态说明。

Codex 额度采样使用独立表，以账号和 5 分钟桶作为主键覆盖写入，保留 14 天。`AppSnapshot` 只携带每个账号的最新额度；详情页按账号和时间范围单独查询历史，避免每次 IPC 更新复制完整图表数据。删除账号会同时清理其额度历史。

数据库备份使用 SQLite 在线 backup API 生成一致性快照，写入 `userData/backups` 后执行 `PRAGMA integrity_check`、schema 版本和必需表校验。自动备份按日执行并轮换；恢复前先创建 `pre-restore` 安全备份，损坏、目录外路径或更高 schema 版本会在替换当前数据库之前被拒绝。

Provider 接入向导只使用内置公开端点模板，一次事务创建 Provider 和首个加密账号。Profile 导入导出采用版本化 JSON，仅包含客户端、目录和备份保留策略，不包含配置正文或 Route Token。诊断报告同样不包含凭据、Route Token、请求正文或响应正文。

## 后续优先级

1. 公开厂商 OAuth 适配器、授权 UI、撤销和账号重新授权。
2. 按小时健康事件表、图表下钻和额度恢复通知。
3. SQLite 整库导出、校验、恢复和状态 schema 灾难恢复工具。
4. Profile 导入导出、更精细的 value-free semantic diff 和更多客户端版本兼容测试。
5. 代码签名、自动更新、系统登录项、品牌资源和 macOS 公证。
