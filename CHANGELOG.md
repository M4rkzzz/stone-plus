# Changelog

## 0.9.6

- 将内置代理重构为完整工作台：统一展示节点、规则、系统代理、TUN、LAN、运行状态与连接遥测，
  支持节点搜索排序、延迟测试、自定义有序规则及连接关闭。
- 强化系统代理租约、TUN 和 sing-box 生命周期：加入系统状态回读、漂移监控、竞争所有者保护、
  原子代际切换、崩溃恢复及安全退出，避免退出后遗留失效代理。
- 完善 Responses、Chat、Anthropic 与 Gemini 协议转换和流式处理：严格拒绝无法无损转换的请求，
  修复 SSE 分帧、终态去重、上下文溢出、失败误报成功和调度状态竞争。
- 强化本地及 WebDAV 备份：引入系统安全保险库检查、凭据脱敏、HTTPS/DAV 校验、恢复回滚、
  SQLite checkpoint 和客户端配置文件存在性记录。
- 修复路由热切源、来源测试结果串线、重复异步保存、向导进度覆盖及弹窗焦点管理等交互问题；
  新增覆盖内置代理、备份、网关、协议转换和 UI 并发场景的回归测试。

- StonePlus 后续自有代码迁移至 StonePlus Source Available License 1.0：允许查看、审计、
  学习、运行未修改版本、有限安全研究和向官方提交建议；禁止修改、衍生产品、重包装、
  再分发、商业发行/对外托管、AI 训练及自动代码生成。
- 许可证迁移不追溯：v0.9.5 及更早版本保留随附的 Apache-2.0；在本次迁移前以
  AGPL-3.0-or-later 首次公开的仓库修订保留其当时条款；上游 Stone 与第三方组件继续
  保留各自原许可证、归属和 NOTICE。
- 强化 Stone+/StonePlus 商标与品牌政策：禁止通过人工、生成式 AI 或脚本只改名称、Logo、
  颜色、UI 或少量代码后重新包装为 Clone，也不得复用官方更新、签名或 provenance 身份。
- 官方 Release 新增当前 Tag 的完整 StonePlus 源码归档，并与其他构建资产一同生成
  SHA-256 校验和及 GitHub build provenance。

## 0.9.5

- “出口代理”统一更名为“代理”，新增独立的内置代理总开关；关闭时完整保留原账号、号池、
  系统代理与直连优先级，开启后由专属 Chromium session 原子接管 Stone+ 新请求。
- 内置 sing-box 固定为 v1.13.14，支持 sing-box JSON、Clash Meta YAML、Base64 与明文 URI
  导入，以及规则、全局、直连、单活动配置、节点选择、延迟、流量与连接管理。
- 新增系统代理租约和临时提权 TUN 接入；保存并比较恢复原 PAC、绕过规则和系统设置，
  核心崩溃或已激活配置故障时 fail-closed，不自动回退直连。
- 数据库升级到 schema v9，内置代理状态与 profile 独立持久化；完整配置、订阅凭据和节点
  凭据继续通过 safeStorage 与 credentials 加密，旧代理配置及绑定保持无损。
- 重构外部网络重载与检测协调流程，保留完整 PAC URL、5 秒单飞边界和既有故障分类；
  内置代理切换只检测启用来源，并继续排除废弃号池和额度耗尽账号。
- Windows x64 正式包随附经 SHA-256 清单校验的 sing-box、libcronet、GPL 与第三方声明；
  同步提供固定上游 commit、vendored Go 依赖与 NaiveProxy 源码的对应源码归档。
- Windows 主程序、安装器和便携包新增持久的项目 Authenticode 签名、DigiCert 时间戳与
  GitHub build provenance；项目证书为自签名证书，不代表 Microsoft 或商业 CA 身份背书。

## 0.9.3

- 为 Codex 增加完整的 compact 能力适配：官方来源走原生压缩，中转来源自动使用普通
  Responses 生成兼容摘要，并保留会话状态头、粘滞路由和压缩后的继续对话能力。
- 修复长上下文超时后任务反复 499 的关键链路：请求上传完成后才开始计算上游响应超时，
  客户端取消不会污染后续同任务请求，compact 后取消与继续均可正常恢复。
- Codex Responses 与 compact 请求体在 10 MiB 以上自动进入无感大请求通道，最高支持
  64 MiB；使用按字节加权的内存保护，大请求不会阻塞普通小请求，超限稳定返回 413。
- 完善 SSE 逻辑终止、延迟终帧、分片传输、重试及请求日志终态处理，避免请求记录落后、
  账号占槽不释放或完成请求残留为“正在传输”。
- Codex 客户端配置默认关闭不兼容的远程压缩 V2，并兼容 TOML 行内表，避免配置写入破坏
  其他字段；补充 compact、499 恢复、大请求、取消、随机压力和 Electron 耐久回归。

## 0.9.2

- 请求记录新增实时生命周期：接收请求、选择上游、准备凭据、连接上游、等待首字、正在传输与
  切换重试会原位更新；传输中耗时每 250ms 刷新，Token 尚未结算时显示已接收流数据量。
- 客户端配置页保留真正的“一键连接”，自动启用路由、启动网关并备份修复客户端配置，且不发送
  真实验证请求；配置损坏与内部路由分别提供独立修复入口。
- Profile 导入导出更名为更准确的“目录定义”，配置目录新增 Electron 原生目录选择器，便携版、
  多用户和多套配置无需再手工输入路径。
- Codex 额度窗口新增本周期 Token 等价美元金额，并根据当前消耗比例显示预测周期总额。
- 客户端页签、客户端详情、路由卡片和官方 API 卡片统一使用 Claude、Anthropic、OpenAI 与
  Google Gemini 真实品牌图标，并简化客户端切换页签的视觉层级。

- 完成桌面界面中英双语适配：系统语言为中文时默认显示中文，其他语言默认显示英文；
  设置页首项提供始终双语的语言选择，切换即时生效并同步原生文件对话框与导入进度。
- 侧栏底部新增“帮助与下一步”帮助中心，自动检查可用来源、可路由来源、有效路由、
  网关和客户端配置五项最低运行条件，并给出当前建议、完成进度和对应快速入口。
- 内置完整中英双语使用手册，提供 14 个功能章节、分组目录、关键词搜索、真实操作 GIF、
  功能截图、可放大图文、动画流程示意以及覆盖常见状态码和故障现象的 FAQ。
- 修复上游已经发送 Responses 终止事件但仍保持 SSE 连接时，界面长期显示一个活跃请求、
  账号占槽无法释放的问题；同协议透传、协议转换与非流式收集现在都会按逻辑结束释放资源。
- 修复“粘滞会话 + 超时竞态”造成的死会话：上游 502、504、连接失败、首包超时或首次输出前
  客户端关闭后会立即解除失效粘滞，同一请求重试排除已失败账号，成功切换后再粘住新账号。
- 流式请求不再被固定总时长误切断；总超时现在保护连接阶段，开始传输后改为按连续无数据的
  空闲时间判断，持续输出的长推理可超过 120 秒，真正卡死的流仍会切号并结束。
- 请求通过本地鉴权后立即创建同一条生命周期日志，选号前失败、无可用账号、上游连接失败和
  客户端 499 均可见；完成时原位更新并标注读取、调度、凭据、连接、首包、传输或客户端阶段。
- 重构 OAuth 与 Token/JSON 账号导入界面的视觉顺序，优先突出授权和选择文件，Tag、号池、
  代理等可选设置后置折叠，并修复窄窗口中 OAuth 主按钮被裁切的问题。
- 将“客户端配置”重构为 Codex 默认打开的超级易用页：日常只显示当前上游、连接健康状态、
  一键修复和恢复入口；标题说明、空白与大面积编辑器全部移除或收进高级设置。
- 客户端切换反代时只原子更新 Stone+ 内部路由，不再改写 `config.toml`、`settings.json`
  或 `.env`；有效配置只修复必要连接字段，损坏文件会先备份原文再重建最小可用配置。
- 高级设置保留三客户端 Profile 快切、40 余项字段解释、脱敏实时预览、源码编辑、格式校验、
  手动整组备份与整组恢复；多文件恢复前会再做安全快照，避免相关文件版本错配。
- 更新桌面及窄窗口视觉回归脚本，覆盖帮助中心、账号导入和视口级操作菜单。

## 0.9.0

- 桌面端改为沉浸式原生标题栏，让标题栏与侧栏形成统一底层；主内容区新增圆角、
  轻量交界阴影，并调整品牌标识尺寸与位置，使窗口布局更接近 Codex App 风格。
- ChatGPT/CPA/Sub2API 账号导入新增分阶段实时进度；导入后会自动刷新账号状态并查询
  可用模型，粘贴、文件批量导入和内置浏览器下载队列均使用同一流程。
- 修复账号并发长期显示为 `0/N`：界面现在读取调度器的实时占槽状态，并在请求获取、
  重试和释放账号时及时更新，同时保持该瞬时数据不写入持久化数据库。
- 删除单个或批量账号时会自动从相关号池移除成员并重新协调模型白名单，不再要求用户
  先逐个编辑号池；账号筛选同时补充“已停用”快捷选择。
- 供应商、账号与号池的更多操作菜单改为视口级浮层，避免被表格、卡片或滚动容器裁切。
- 修复沉浸式布局下长页面无法滚动、侧栏底部操作被推出窗口的问题；移除凭据保险库状态
  指示，并让侧栏收起/展开按钮在所有桌面页面保持可见；主内容滚动条改为滚动时出现、
  停止后自动隐藏的沉浸式窄条，同时修正侧栏收起时图标先向右跳再回落的动画问题。
- 修复诊断页无内边距的标题区域，并统一“适配系统代理”开关、内网穿透页和其他细节文案。
- Windows 安装器改为带安装范围、安装目录、许可证、桌面/开始菜单快捷方式和完成后启动
  选项的引导式安装；补充单实例运行、任务栏应用标识、卸载自启动清理，并自动清除早期
  `Stone` 品牌遗留的无效卸载项和快捷方式，同时默认保留用户数据。
- “供应商”重构为“账号与中转”：分离 OAuth 账号、官方 API 和兼容中转站，并将出口代理拆为
  独立页面；新增多来源聚合中转、故障转移、会话/请求轮询和平滑加权轮询。
- Sub2API / CPA 导入支持 K12、Plus 与自定义 Tag，可将检测成功的账号幂等追加到现有号池；
  账号表格和号池编辑器增加 Tag 筛选、批量设置与快选。
- 新增可恢复的端到端配置向导，覆盖来源、网络出口、真实生成验证、号池路由、网关启动、
  loopback 请求和可选客户端配置写入；Codex 账号步骤同步支持 OAuth 与 Token/JSON 双入口，
  并复用 Tag（替代备注）、已有号池和出口代理选择。
- 路由目标统一改为“源”，可直接选择普通号池、聚合中转、官方 API 或中转站；修复聚合中转
  成员勾选状态不可见的问题，并增强账号/官方 API/中转站页签及 Tag 的视觉层级。
- 号池页新增独立中转站只读卡片；普通号池、聚合中转和中转站均可在卡面切换 FAST，
  对 OpenAI Responses/Chat 请求强制使用 `service_tier: priority`。
- “添加 Codex 账号”新增 OpenAI OAuth PKCE 授权方式，并保留 Sub2API / CPA Token/JSON
  导入；两种方式共享账号 Tag、目标号池与出口代理设置，OAuth 回调和 Token 交换仅在主进程处理。
- 顶栏网关启停按钮右侧新增 ChatGPT 快捷按钮：关闭 ChatGPT 后按当前 provider 安全修复
  Codex 会话与索引，并在成功或失败后重新启动 ChatGPT，避免会话文件占用。

## 0.8.8

- 总览新增“今日 Token”和“总 Token”成本卡片，按本地自然日及全部持久请求日志
  分别统计输入、缓存输入和输出 Token，并显示官方标准 API 美元价格估算。
- 成本估算严格逐条读取请求日志的 `model` 字段，支持 GPT-5.6 Sol/alias、
  Terra、Luna，以及 GPT-5.5/Pro、GPT-5.4/Pro/Mini/Nano 和官方日期快照；
  未知型号明确标记为未计价，不会套用猜测价格。
- 缓存感知计价会从总输入中扣除缓存读取和单独上报的缓存写入，避免重复计费；
  GPT-5.6 缓存写入按 1.25 倍输入价，5.4/5.5 不擅自套用该规则，Pro
  缓存读取按普通输入价。
- GPT-5.4、5.4 Pro、5.5 和 5.5 Pro 单次输入超过 272K Token 时按官方规则
  对整次输入应用 2 倍价格、输出应用 1.5 倍价格；恰好 272K 不加价。
- CPA/Sub2API 批量账号导入新增出口代理选择，可保留有效文件代理、强制直连，
  或让整批账号统一使用指定代理；导入后的账号检测也使用最终选定的出口。
- 粘贴 JSON 与批量文件导入现在共享并发受控的导入后健康检查，并显示新增、更新、
  检测成功和检测失败数量。
- 账号列表新增官方额度解冻时间与调度适应度信息，展示成功率、首字、输出速度、
  失败惩罚和有效并发，便于判断 `autobalanced` 的实际选择依据。
- 修正账号列表操作列对齐和紧凑布局，避免按钮在不同内容高度下错位。
- 加固应用更新检查在 Electron/GitHub Release 重定向与 API 限流场景下的可信回退，
  避免有效更新被误判为检查失败。

## 0.8.7

- Added a warmed primary outbound lane with load-triggered secondary lanes, safer
  dispatcher rotation, longer gateway keepalive, and manual/resume/online rebuilds.
- Added per-account OAuth refresh singleflight and proactive background renewal so
  concurrent requests no longer serialize behind redundant token refreshes.
- Added semantic TTFT and detailed phase timing (`body read`, `account scheduling`,
  `credential resolution`, `outbound start`, `upstream headers`, `first byte`,
  `first token`, and `client first write`) plus cached-input and reasoning-token metrics.
- Added first-body timeout failover and an opt-in low-latency hedged request mode;
  hedging remains disabled by default because a duplicate request can consume quota.
- Improved `autobalanced` with conservative priors, controlled exploration,
  decaying failure penalties, and adaptive per-account concurrency.
- Batched SQLite request-log writes and throttled/coalesced telemetry and renderer
  snapshots to reduce main-process work on the streaming hot path.
- Fixed stale OAuth refreshes overwriting edited credentials, stale transport
  rotations replacing newer proxy generations, and shutdown-time connection leaks.
- Fixed delayed success telemetry re-enabling disabled accounts, hidden-window
  snapshot staleness, zero-length first stream chunks, and Responses usage shape.
- Gateway setting saves now update live unless the listening address changes;
  address changes drain active streams before restarting instead of creating 499s.
- Added an account-table filter for hiding quota-exhausted accounts and a
  concurrency-limited one-click health check for every configured account.
- Fixed inflated output-token rates after semantic visible-TTFT tracking by
  measuring generation duration from the first upstream body byte instead.
- Restored the request table's original first-byte-based "首字" display while
  retaining semantic visible-TTFT as a separate request-detail diagnostic.
- Added secure CPA/Sub2API account export with selectable OAuth accounts,
  one-click all/non-cooldown selection, merged or per-account files, and native
  file/directory save dialogs.
- Added account-list multi-selection by all/non-cooldown/cooldown/quota-exhausted
  conditions plus atomic, reference-safe bulk deletion.

## 0.8.6

- Fixed session repair exhausting memory and terminating Stone+ when Codex history
  contains multiple gigabytes of rollout files; previews now scan bounded metadata.
- Added Codex historical-session repair with provider discovery, dry-run counts,
  stale-preview protection, automatic rollout/SQLite backups, transactional index
  updates, rollback, encrypted-content guidance, and a dedicated Stone+ UI.
- Added native multi-file CPA and Sub2API JSON account imports, automatic recovery
  of missing CPA `account_id` values from JWT claims, and immediate concurrent
  account health checks after import.

## 0.8.5

- Added an overview chart for average output-token speed over 30 minutes, 4 hours,
  24 hours, and one week.
- Reduced gateway main-thread work with targeted SQLite writes, cached observability
  summaries, and coalesced renderer snapshot updates.
- Extended direct and proxied HTTP/2 connection keepalive and added connection warming.
- Added an optional `autobalanced` strategy that prefers accounts with better EWMA
  TTFT/output speed without changing the existing `balanced` behavior.
- Kept update checks working when GitHub's anonymous REST API is rate limited by
  falling back to the trusted latest-release redirect, and completed Stone+ branding
  across the application-update UI.

## 0.8.4

- Fixed completed streams being recorded as HTTP 499 when a client closed the
  connection immediately after receiving the protocol terminal event.
- A close before the terminal event remains a real 499 and still does not cool
  down the account or trigger failover.

## 0.8.3 — Stone+ initial release

- Added embedded FRP tunnel management and copyable remote endpoint/token.
- Added pool-level Fast On priority routing for OpenAI Responses-compatible pools.
- Added TTFT and conversation titles to request logs, persisted adjustable columns,
  compact layout, and a header privacy toggle.
- Treat client disconnects as HTTP 499 without penalizing accounts or failing over.
- Reused outbound connections, enabled HTTP/2 negotiation, forwarded SSE data sooner,
  reduced redaction buffering, and removed large state clones from the request path.

See [MODIFICATIONS.md](MODIFICATIONS.md) for upstream and licensing details.
