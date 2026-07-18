# Changelog

## 0.8.9

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
