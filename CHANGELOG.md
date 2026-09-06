# Changelog

## 0.9.23

- 合并 thok404 的 #11：自动压缩遇到特定中转站 502（Cloudflare 源站故障、非 JSON 网关响应及明确的通用 upstream failed）时，回退普通 Responses 摘要；无关 JSON 错误仍明确失败。
- 自动摘要回退使用低推理强度和 4096 输出 Token 上限，兼容工具历史的可移植表示；不改变普通生成请求。
- 压缩回退中的超大文本字段限制为 8 MiB，保留首尾并显式标记中段截断，避免再次触发上游单字段限制；此边界并非无损历史转换。
- 授权维护者与 CODEOWNERS 增加 thok404，同步发布指南，保留签名提交、发布证书和来源验证要求。

## 0.9.22

- 兼容中转站仅在 response.completed.output 返回压缩结果的事件流，在严格终态校验后补齐客户端需要的输出项事件，保留历史与用量。
- 原生 Compact V2 增加传输保活与独立的有界等待预算；心跳不计为模型输出，超时、截断和取消继续正确释放请求。
- 补齐原生压缩能力协商，防止保活提交后静默混用不同来源的续接状态；失败仍明确返回错误，不伪造成功终态。

## 0.9.21

- 修复原生 Compact V2 收到完整 JSON 压缩结果时，因仅按 SSE 解析而误报缺少终止事件的 502。
- 根据实际响应内容识别 JSON/SSE，兼容错误 Content-Type、BOM 和分片；将校验通过的压缩 JSON 转换为客户端事件流，保留历史、用量和续接头。
- 对截断、失败、缺少或重复压缩项继续明确失败；为未完成 JSON 保留体积、等待时限、取消和故障转移保护。

## 0.9.20

- 将 DeepSeek Harness、WM 路由和 OpenAI Responses 兼容链路整理为隔离的客户端专属通道，
  保持主 Codex 链路的流式、工具、并行调用、压缩和终止语义不变。
- 加固 ChatGPT 网页登录、OAuth 账号恢复、Codex 配置残留修复和客户端生命周期操作，
  失败时保持回滚与明确进度，不把失效配置或半成品会话留给用户。
- 完善额度、模型定价、隐藏额度统计、DeepSeek/Grok 工具调用和长上下文限制，
  对不可无损转换的请求继续 fail-closed，不静默降级为文本或直连。
- 清理研究探针与历史烟测产物，收紧 ESLint/Git 忽略边界；补齐 DSH 终端第三方许可证，
  保持 Windows、Linux、macOS 运行目录和发布合规材料完整。

## 0.9.18

- 新增 DeepSeek Harness 一键安装、配置、启动、停止和重新聚焦能力，支持 GPT 官方账号、OpenAI
  Responses 中转与原生 DeepSeek 来源；模型目录同步上下文、输出限制和 GPT-5.6/DeepSeek 推理档位，
  新会话可自由选族，首次真实生成后永久保持模型家族，避免历史和工具状态跨协议混用。
- 新增 Codex 会话选择性迁入 DeepSeek Harness：仅快速扫描会话摘要，按需转换为 Harness 原生事件历史、
  创建并绑定工作区、保留用户/助手/推理/工具调用及结果顺序，并使用来源修订收据实现幂等导入；迁入
  不自动打开客户端，重复迁入明确显示已存在。
- 完善 DSH 网关与长上下文：DeepSeek Harness 客户端和持久化路由现在以 OpenAI Responses 为原生协议，
  真实传递会话 ID、工具定义、并行调用、结构化结果和终止语义；旧版 Chat Completions 仅保留为同一
  路由令牌下的兼容别名，不再把 DSH 新请求默认引到 Chat。Chat 与 Responses 历史均使用受控 10–64 MiB
  大请求通道，保持共享内存门控和明确 413 边界。
- 加固 Responses 流和上游自适应：健康流终态等待统一为 65 秒；对输出前的非 JSON、空响应、错误
  Content-Type、提前断流和短时过载进行有界同请求恢复，连续同类错误达到阈值才显式报告，开始输出后
  仍禁止换源续写。
- 扩展 Codex 额度管理：解析月度窗口、订阅方案、模型专属额度桶和重置券，支持用户确认后消耗重置券；
  额度 100% 后仍成功使用的 Token 按本地日志和官方费率估算为“隐藏额度”，过期或陈旧的额度标记不再
  永久冷却健康账号。
- 增加号池级 WM 路由和模型预览一致性，更新 GPT-5.6、DeepSeek 与相关模型定价；修复 Codex 第三方
  配置残留、一键连接/重启修复、客户端安装检测、进程生命周期、设置向导和请求记录边界，并将
  `nanoid` 固定到安全修订，生产与开发依赖审计恢复为零漏洞。
- 加固内置代理回环边界：识别 IPv4-mapped IPv6 回环地址、兼容 SOCKS4 解析，并在启动 sing-box
  前为 mixed/controller 统一预检 Chromium Fetch 可用端口，避免远端系统代理或端口策略造成启动假成功。

## 0.9.17

- 加固 ChatGPT OAuth 与 Codex App 切换闭环：刷新令牌单飞轮换、401 同账号恢复、官方认证所有权校验、
  失败自动回滚及一键连接回收官方残留，避免并发刷新撤销凭据、身份串号或损坏 `auth.json`。
- 重构 Codex 会话与配置修复的低写入事务：启动只维护 SQLite 索引和模型缓存，完整历史修复支持取消、
  分阶段进度、空间预检、硬链接/补丁备份及失败回滚；同时统一支持 `CODEX_HOME`、`sqlite_home` 和
  `CODEX_SQLITE_HOME`，外置状态库的标题、删除、恢复与备份不再遗漏。
- 扩展 Codex 网关兼容性：支持 gzip、Brotli、deflate、Zstandard 及叠加编码的压缩 JSON 请求，压缩前后
  均执行 64 MiB 上限和共享内存门控；长请求、压缩炸弹、畸形编码和未知编码均稳定 fail-closed。
- 完善 DeepSeek 与 Grok 工具链：保持声明工具、并行调用、结构化结果和终止语义，修复自定义工具参数、
  模型级拒绝、短时过载和额度信号误伤账号；Grok 增加图片/视频代理、会话绑定、响应上限及 OAuth
  轮换恢复，非成功响应会及时释放连接。
- 强化调度稳定性：模型不可用改为账号/模型维度的有界冷却，请求级过载优先在同账号短延迟重试，
  不再把健康账号全局停用；重试时重建身份头并只重放已验证的内存 JSON，请求开始输出后仍禁止换源续写。
- 新增持久化脱敏诊断、上游客户端版本同步和更严格的有界响应读取；升级 Undici 并固定传递依赖的安全
  修订，开发与生产依赖审计保持 0 漏洞。

## 0.9.16

- 完善 DeepSeek V4 在 Codex 中的完整工具链：同时支持原生 Responses DSML 与兼容中转的
  Chat Completions 方言，恢复函数、自定义工具、工具搜索、命名空间及跨任务消息调用，保持调用 ID、
  结构化参数、并行批次和流式终止语义；未声明、混合或损坏的工具输出继续 fail-closed。
- 为 DeepSeek V4 Flash 默认启用最高 `max` 推理档，补齐 1,048,576 Token 上下文、384,000 Token
  最大输出和 Codex 模型能力目录；仅在整条 Codex 路由均为 DeepSeek 时写入全局窗口，避免混合来源
  被错误套用限制，并把健康流终态等待放宽到 65 秒。
- 扩展 DeepSeek-compatible 中转，允许明确选择 OpenAI Responses 或 Chat Completions；来源保存、
  探测、模型目录、持久化恢复和真实调度使用同一协议与推理强度规则。
- 加固 Codex 全量配置维护与第三方残留修复：纳入 `config.toml`、认证文件、生成模型目录、
  `AGENTS.md` 和默认规则文件；重启修复会同步会话 JSONL、SQLite 模型/Provider 索引和工作区状态，
  并在备份、校验成功后再启动客户端。
- 修复客户端页显示“配置正常”但生命周期仍判定“未接入”而无法启动的问题；页面与主进程改用同一
  Codex 连接元数据，旧快照不会再阻止主进程执行配置修复、校验和启动事务。
- 补齐 DeepSeek V4 Flash/Pro Token 定价与未定价 Token 诊断，额度卡片不再把未知价格误算为零。
- 将开发、Lint 与 Electron 打包链路中的 `brace-expansion` 固定到对应主版本的安全修订，完整依赖
  审计恢复为零漏洞，同时保持旧版 `minimatch` 消费者的兼容性。

## 0.9.13

- 新增 Codex 按模型选择独立来源：默认模型继续使用主号池，精确模型可映射到另一号池或中转站，
  路由保存、恢复、删除来源、模型列表和真实请求调度保持一致。
- 新增 DeepSeek 原生 Responses 官方 API 与兼容中转来源，直接供 Codex 使用；完整保留流式工具请求，
  明确拒绝 DeepSeek 不支持且会丢失语义的服务端历史和缓存控制，不设置烟测绑定门槛。
- 完善 ChatGPT 网页会话入口：使用本地账号打开隔离网页窗口，强化认证启动时序、账号类型识别、
  页面稳定等待、历史会话、图片查看与另存、麦克风和声音权限处理及失败诊断。
- 完善迷你请求监控浮窗：持久化尺寸、位置、置顶、不透明度和开启状态，修复原生右键菜单、主题同步、
  无滚动紧凑布局及活动/完成状态辨识。
- 更新 OpenAI、Codex、Grok 与 Anthropic 模型计价目录和历史账本迁移，按实际映射后的上游模型统计；
  同时优化额度视图、账号冷却开关、流式终态等待和请求来源展示。
- 加固客户端启动检测、Windows 进程唤醒、系统代理重载、设置向导和更新服务，并补充来源、路由、
  网关、网页登录、浮窗、定价及持久化回归测试。

## 0.9.12

- 重构首次启动与后台刷新路径：按页面延迟加载大型界面模块，隐藏窗口暂停非必要轮询，并提供低资源模式，
  降低打开设置程序时的未响应时间、前台高并发下的渲染压力和窗口聚焦时的系统卡顿。
- 将 SQLite 备份完整性检查迁移到独立 Worker，批量备份验证不再阻塞 Electron 主线程；保留 schema、
  必需表、初始化标记、超时和损坏备份的原有 fail-closed 校验。
- 全面重做设置向导的阶段呈现、恢复和完成页：增加直观进度、动画、就绪摘要、失败定位与下一步引导，
  同时保持来源、网络、路由、网关和客户端配置的真实业务校验。
- 新增全局快速导航、操作中心、链路就绪面板和上下文建议，将常用页面、进行中任务、失败请求及需关注
  账号集中到可直接到达的入口；紧凑模式只保留关键信息，避免占用主工作区。
- 新增无边框常驻请求监控浮窗，以超紧凑布局实时展示活跃请求、首字、耗时、生命周期总 Token 和逐条请求；
  整窗可拖动，右键可显示主程序或只关闭浮窗，并始终同步主程序主题。
- 修复高压力下顶部活跃请求数与账号实时并发不同步的问题；账号占槽现在始终发布合并后的运行时增量，
  不再因性能遥测降采样而长期停留在 `0 / N`。

## 0.9.11

- 重构内置代理订阅规则与运行时接管：优先完整保留订阅自带规则，在缺少 Stone+、OpenAI、
  Claude、Grok 等必要代理目标时安全补齐，并强化节点切换、端口、系统代理与核心生命周期稳定性。
- 新增可扩展主题编辑器，内置系统、浅色和深色主题，支持创建、删除自定义主题及简易颜色选择；
  统一深色模式文字、品牌图标、状态色、滚动条、阴影和嵌套控件层级。
- 修复 Windows 安装器自定义许可证的 UTF-8 编码生成，避免中文许可正文乱码，并继续在安装前要求
  用户明确同意 StonePlus Source Available License 1.0。
- 优化账号与号池生命周期：删除最后一个账号时保留标准号池并停用关联路由，避免用户的号池配置、
  名称和后续复用入口被一并删除。
- 放宽 API 中转地址输入边界：支持 HTTPS、HTTP、裸 IPv4 及带端口的局域网地址，自动规范化
  无协议地址；OAuth、WebDAV 和更新通道仍保持原有安全边界。
- 完善客户端配置、来源编辑、品牌标志、请求记录数字字体及界面细节，并补充代理、主题、来源、
  Store、安装器和客户端并发状态的回归测试。

## 0.9.10

- 重构客户端真实进程管理与会话修复：统一 Codex、Claude Code、Gemini CLI 和 Grok Build
  的启动、关闭、重启及配置修复边界，补齐启动就绪确认、残留进程识别、会话维护锁和失败回滚。
- 加固内置代理生命周期与崩溃恢复：完善 sing-box、TUN sidecar、系统代理租约、端口释放和退出清理，
  避免重复启停、残留代理与应用关闭阶段的竞态。
- 优化账号、来源与路由状态：修复额度标签、来源名称、Kiro 工具烟测资格、保存恢复和设置向导边界，
  并为关键状态补充持久化迁移和回归覆盖。
- 更新客户端配置与内网穿透工作台：四类客户端高级配置支持完整内容预览和直接打开文件，FRP 配置
  与本地令牌可按用户操作明文查看；日志、诊断和错误信息继续保持脱敏。
- 重整浅色/深色界面层级，修复标题栏阴影、嵌套背景、状态标签、数字字体和窄屏布局；新增页面级
  错误边界与轻量交互动效，降低局部界面故障对其他功能的影响。
- 移除未使用的 Zustand 生产依赖，更新 Electron Builder 及构建锁文件，并固定 Star History 工作流
  的 GitHub Action 提交摘要；生产依赖审计保持零漏洞。

## 0.9.9

- 新增 Kiro Claude 专用中转协议与原生兼容桥：Claude Code CLI、Desktop 和 VSC 继续使用
  Anthropic Messages 入站，Stone+ 直接转换为 Kiro conversation state 与 AWS Event Stream，
  完整保持并行 `tool_use` / `tool_result` 的 ID、顺序、停止原因和结构化结果。
- 扩展 Claude Code 客户端管理，加入 Desktop 与 VS Code 表面、官方模式恢复、配置事务回滚、
  启动就绪确认和更可靠的关闭/重启/会话修复；清理残留模型覆盖并补充权限模式新会话提示。
- 新增系统/浅色/深色主题与原生窗口 chrome 同步，优化账号分页、后台轮询、请求记录和高并发
  渲染，降低窗口聚焦时的桌面卡顿并修复标题栏、阴影和紧凑布局问题。
- 加固 Gateway、路由和号池边界：完善 Kiro/Grok/Anthropic 工具流与终态校验、缓冲响应故障切换、
  WebSocket 背压、粘滞会话和精确协议拓扑，阻止跨协议成员及 OAuth 系统来源篡改。
- 强化 SQLite、备份与凭据生命周期：加入敏感页物理清除、数据库替换 journal、导入持久回滚、
  浏览器缓存 safeStorage 加密、Grok 刷新令牌单飞轮换和有界认证响应。
- 强化 sing-box/TUN/系统代理/FRP 生命周期与 Windows PowerShell、ACL、进程身份和自签名校验；
  固定 Node/npm 工具链、frpc 包体清单与 Electron fuses，并升级 PostCSS 修复路径穿越告警。

## 0.9.8

- 新增 Grok OAuth、xAI API Key 与 xAI-compatible 中转支持，引入独立 Grok 号池协议与
  Grok Build 原生反代端点；完善 Sub2API 凭据导入、刷新令牌轮换保存、Grok Tag、
  模型目录及 Codex 工具调用桥接。
- 完善 OpenAI Responses 与 Anthropic Messages 的双向转换，覆盖系统提示、图文输入、
  函数工具、流式事件、停止原因、reasoning/thinking 及 Token 用量；清理 Claude 客户端
  中残留的 GPT/xAI 模型覆盖。
- 重构 Agent 客户端管理，统一 Codex Desktop、Codex CLI、Claude Code、Gemini CLI 和
  Grok Build 的启停与重启事务，强化 Windows 进程树终止、配置/会话修复、启动就绪确认和失败回滚。
- 修复 Windows 系统代理接管未实际写入 mixed 地址、系统代理/TUN/LAN 切换竞态、
  延迟测试失真与节点选择不持久化；核心异常继续 fail-closed，不回退直连。
- 优化前台高并发下的运行时增量同步、请求记录分页与有界渲染，并修复 Windows 原生
  titlebar 与主内容区之间的阴影断层。
- 新增 Grok 4.5 和 Anthropic Claude 系列的标准 API 等价计价，区分 5 分钟/1 小时
  缓存写入、缓存读取与长上下文阶梯；按路由后的实际上游模型计价并安全迁移可证明的历史账本。
- 加固 IPC 来源、路由模型映射、OAuth 上游边界、Windows 更新签名指纹与 GitHub Release
  供应链，继续生成对应源码、SHA-256 和 Artifact Attestation provenance。

## 0.9.7

- 为 Codex Responses Compact V2 增加按能力自动适配：优先使用支持原生 opaque compact 的来源，
  没有原生能力时将压缩请求转换为普通 Responses 摘要，再还原为客户端可继续消费的终止帧，
  避免中转站不支持远程压缩时返回 422 或把会话卡死。
- 完善 compact 的来源筛选、协议转换、凭据类型识别、失败切换与敏感信息脱敏；原生 opaque
  历史仍严格只发送给明确支持的上游，不伪造上游能力或终止状态。
- 优化流式解析的推理进度信号，支持在不泄露隐藏思考文本的情况下刷新健康流的活跃状态，
  并保持 Gemini thinking、Anthropic thinking 与 OpenAI reasoning 的协议边界。
- 修复后续版本无法通过 Source Available 版本边界检查的问题：发布校验现在允许当前版本在
  首个 Source Available 版本之后持续递增，同时继续拒绝早于许可证边界的版本。

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
