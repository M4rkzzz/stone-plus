# Stone+ 中文首发与推广物料

本文档用于 Stone+ `v0.8.0` 的中文首发、社区介绍和视频制作。文案中的链接均为项目正式地址，可直接使用。发布前只需确认 GitHub Release 已公开、下载文件与版本号一致。

## 固定链接

- GitHub 项目：https://github.com/M4rkzzz/stone-plus
- 中文 README：https://github.com/M4rkzzz/stone-plus/blob/main/README.md
- 最新版下载：https://github.com/M4rkzzz/stone-plus/releases/latest
- `v0.8.0` Release：https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.0
- Issues：https://github.com/M4rkzzz/stone-plus/issues
- Apache-2.0 许可证：https://github.com/M4rkzzz/stone-plus/blob/main/LICENSE
- QQ 交流群：`1061282900`

QQ群目前只使用群号，不编造或转发无法长期验证的加群链接。

## 仓库内推广素材

| 文件 | 用途 |
| --- | --- |
| `docs/media/stone-demo.gif` | README、论坛首帖和支持直接显示 GIF 的社区，12.6 秒无敏感信息产品导览 |
| `docs/media/stone-demo.mp4` | 高清产品导览，可上传到视频平台或作为帖子附件 |
| `docs/media/social-preview.png` | GitHub、社交媒体和即时通讯分享卡片，尺寸为 1280×640 |
| `docs/screenshots/*.png` | 功能长文、教程和问题说明中的单页截图 |

GitHub Social preview 没有公开 REST API。仓库管理员需要在 **Settings → General → Social preview → Edit** 中手工上传 `docs/media/social-preview.png`。上传后应在聊天工具或社交平台重新粘贴项目地址，确认抓取到新卡片；旧卡片可能受平台缓存影响，不要反复修改图片来规避缓存。

GIF 与 MP4 均使用 Stone 的 Mock 数据，不含真实邮箱、账号 ID、Token、代理凭据或本机路径。二次剪辑和站外上传时仍需逐帧检查新增画面。

## 统一定位

### 产品定位

Stone+ 是一个面向个人开发者的、本地优先的多厂商 AI 账号与编程客户端控制中心，同时提供仅监听本机的 API 网关。

它解决的是四件事：

1. 在一个桌面应用里管理用户自己有权使用的多厂商账号与兼容端点。
2. 按账号发现、开放和测试模型，再将账号组成带健康检查与故障切换的号池。
3. 为 Claude Code、Codex 和 Gemini CLI 管理本地连接与配置 Profile。
4. 在 OpenAI、Anthropic 和 Gemini 的常用协议之间转发或转换请求。

### 一句话介绍

> 在一个本地桌面应用里，管理你的 AI 账号、号池、出口代理和 Claude Code、Codex、Gemini CLI。

### 30 秒介绍

Stone+ 是一个运行在 Windows、macOS 和 Linux 上的开源本地控制中心。你可以添加自己有权使用的不同厂商账号，按账号拉取和测试模型，将账号组成号池，再让 Claude Code、Codex 或 Gemini CLI 通过同一个本地网关使用它们。Stone 会结合模型支持情况、额度、健康状态和号池策略选择可用账号，也支持常用协议转换、账号或号池级出口代理、客户端配置备份与恢复。

### 适合谁

- 同时使用多个 AI 厂商、兼容端点或编程客户端的个人开发者。
- 希望把账号、模型、代理和客户端配置集中在本机管理的用户。
- 需要在不同客户端协议和上游协议之间做本地适配的用户。
- 希望看到账号健康、请求元数据和 Codex 额度趋势的用户。

### 边界说明

- Stone 是个人本地应用，不是多租户、计费、支付或远程管理平台。
- Stone 不提供账号交易、多人共用或公共转发服务。用户应只接入自己有权使用的账号，并遵守对应厂商条款。
- 网关只监听回环地址，不作为局域网或公网服务暴露。
- 模型和额度由上游账号决定，Stone 不增加订阅权益，也不保证某个模型始终可用。
- 出口代理用于用户自己的上游网络路径，不是供其他应用连接的通用代理服务。

### 统一用词

建议使用：

- “本地控制中心”“本地网关”“号池调度”“故障切换”
- “用户自己有权使用的账号”“兼容端点”“上游账号”
- “减少使用中断”“按模型与健康状态选择可用账号”
- “协议转换”“本地客户端配置管理”“出口代理”

避免使用：

- 暗示规避厂商限制、订阅规则或额度规则的表述
- 暗示多人共用账号、公开提供账号或向第三方转售访问的表述
- “绝对安全”“完全兼容所有模型”“零故障”“永久免费”等无法证明的承诺
- 把未签名、未公证或仍需手工更新的平台描述为完整生产级发布体验

## Linux.do / V2EX 首发长文

### 标题备选

1. `[开源自荐] Stone+：把多厂商 AI 账号、号池和编程客户端放进一个本地桌面应用`
2. `做了一个本地 AI 账号与 Claude Code / Codex / Gemini CLI 控制中心`
3. `Stone+ v0.8.0：本地管理账号、模型、号池、代理与协议转换`

V2EX 可发布在“分享创造”节点。Linux.do 按站内当时的分类规则选择开源分享或开发工具相关分类。不要在标题里堆叠“神器”“全能”“颠覆”等词。

### 正文

大家好，我最近做了一个开源桌面项目：**Stone+**。

- 项目地址：https://github.com/M4rkzzz/stone-plus
- 下载地址：https://github.com/M4rkzzz/stone-plus/releases/latest

我自己同时使用不同厂商的模型和多个编程客户端时，经常遇到几类重复工作：账号与模型分散在不同地方；Claude Code、Codex、Gemini CLI 的配置方式各不相同；某个账号暂时不可用时需要手工切换；不同客户端与上游使用的 API 格式也不一定一致。

Stone 想做的是一个**只在本机运行的个人控制中心**，把这些工作放进同一个界面，而不是再部署一套服务端。

目前可以完成下面这些事情：

- 管理 OpenAI、Anthropic、Gemini、兼容端点和自定义上游，并在同一厂商下保存多个独立账号。
- 每个账号单独拉取可用模型，选择开放全部或指定模型；也可以对某个模型发送一次很小的真实请求，确认它当前能否返回结果。
- 将协议兼容的账号组成号池，使用优先级、均衡、轮询或加权随机策略，并配置并发限制、会话粘性、重试、冷却和故障切换。
- 为账号或号池指定 HTTP、HTTPS、SOCKS4、SOCKS5 出口代理，并检查公网出口 IP 与延迟。
- 为 Claude Code、Codex、Gemini CLI 管理配置 Profile，写入前可以预览，并自动备份已有文件。
- 接收 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Gemini generateContent，在需要时转换普通请求和流式请求，包括文本、工具调用与用量信息。
- 查看请求状态、延迟、Token 用量和账号健康事件。请求历史只保存元数据，不保存提示词或模型输出正文。
- 对 ChatGPT OAuth 账号显示 Codex 5 小时与周额度，以及从本机开始采集后的趋势。

一个典型流程是：

```text
Claude Code / Codex / Gemini CLI
                 |
                 v
          Stone 本地网关
         模型策略 + 号池调度
          /      |      \
      账号 A   账号 B   账号 C
```

客户端只连接 `127.0.0.1` 上的 Stone，并使用独立的本地路由 Token。Stone 根据目标模型、账号状态和号池策略选择账号，再按客户端需要的协议返回结果。

#### 本地数据与凭据

Stone 没有云端控制面。账号元数据、Profile、额度历史和请求统计保存在本机 SQLite 中。已保存的上游凭据和代理密码使用 Electron `safeStorage`，由 Windows DPAPI、macOS Keychain 或 Linux 的 Secret Service 兼容后端保护；如果 Linux 上没有可用的安全存储，Stone 不会把凭据降级成明文保存。

上游凭据不会提供给 renderer，界面只能看到掩码。网关只允许回环监听，请求历史不写入请求和响应正文。Stone 的必要联网包括用户发起的上游请求、GitHub Releases 更新检查，以及用户主动执行代理出口检测时访问公共 IP 检测服务。

#### 账号与使用边界

Stone 面向个人管理自己有权使用的账号，不提供多租户、计费、支付、远程管理或公共访问服务。导入 Codex / ChatGPT session 需要用户显式提供自己的 session JSON；Stone 不扫描浏览器 Cookie，也不会自动读取 `~/.codex/auth.json`。账号能使用哪些模型、拥有多少额度以及是否允许某种接入方式，始终由上游决定，使用时也需要遵守对应厂商条款。

#### 平台和当前限制

当前 Release 提供：

- Windows x64：安装版和 Portable。
- macOS：Intel 与 Apple Silicon 的 dmg / zip。
- Linux x64 / arm64：AppImage 和 deb。

需要提前说明，当前 Windows 包尚未代码签名，macOS 包尚未经过 Apple 公证，系统可能显示未知发布者或首次启动警告。Release 同时提供 `SHA256SUMS`，建议下载后先核对校验值。

从 `v0.7.1` 升级到 `v0.8.0` 需要手工下载安装一次，因为 `v0.7.1` 还没有在线更新组件。安装 `v0.8.0` 后，Windows 安装版与 Linux AppImage 可以在应用内下载更新并重启完成替换；Windows Portable、Linux deb 和当前 macOS 构建仍会打开 Releases，由用户手工替换。

Linux 还需要 Secret Service 兼容的 Keyring，例如 `libsecret` 或 KWallet；部分发行版运行 AppImage 时可能需要 FUSE 2。

Stone 采用 Apache-2.0 许可证。目前更希望先把真实使用中的边界和兼容问题做扎实，所以欢迎通过 Issues 或 QQ 群反馈具体环境、客户端、上游类型和复现步骤。

- GitHub：https://github.com/M4rkzzz/stone-plus
- Releases：https://github.com/M4rkzzz/stone-plus/releases/latest
- Issues：https://github.com/M4rkzzz/stone-plus/issues
- QQ 群：`1061282900`

如果你准备尝试，建议先用一个测试账号和单独的客户端 Profile，确认模型发现、路由与配置预览符合预期，再逐步加入日常配置。

### 首发配图顺序

1. `docs/screenshots/overview.png`：放在“目前可以完成”之前。
2. `docs/screenshots/accounts.png`：放在模型与额度部分之后。
3. `docs/screenshots/pools.png`：放在工作流程图之后。
4. `docs/screenshots/clients.png`：放在客户端配置说明之后。
5. `docs/screenshots/online-update.png`：放在平台与升级说明之后。

发布到站外时直接上传原图，避免依赖可能被防盗链拦截的图片地址。截图中只使用演示数据，不出现真实邮箱、账号 ID、Token、代理地址或本机路径。

## 掘金文章提纲

### 标题备选

- `我把多厂商 AI 账号、号池和三个编程 CLI 做进了一个 Electron 桌面应用`
- `Stone+ 的实现：本地 AI 网关、模型策略与跨协议流式转换`
- `从客户端配置到号池调度：一个本地 AI 控制中心的工程边界`

### 文章结构

1. **为什么做桌面端而不是服务端**
   - 目标是个人本地使用，不需要多租户、计费和远程控制。
   - 凭据、配置文件和调试记录天然更适合留在用户设备。

2. **整体架构**
   - Electron main process 持有凭据、SQLite、网关和文件系统权限。
   - renderer 只通过受限 IPC 获取脱敏快照。
   - 本地网关固定回环监听，客户端使用独立路由 Token。

3. **Provider、Account、Pool、Route 为什么分层**
   - Provider 描述协议和端点。
   - Account 持有独立凭据、模型策略、健康和代理。
   - Pool 聚合协议兼容账号并决定调度策略与开放模型。
   - Route 将 Claude Code、Codex、Gemini CLI 指向目标号池。

4. **模型策略不是写死一张全局表**
   - 每个账号使用自己的凭据和代理发现模型。
   - 账号决定开放范围，号池只从成员账号开放模型的并集中选择。
   - 单模型测试发送最小真实请求，但会产生真实用量。

5. **跨协议转换中最容易出错的部分**
   - 普通响应容易，流式文本、工具调用、停止原因、错误和用量更难。
   - 同协议尽量旁路，跨协议才转换，减少丢失厂商私有事件的风险。

6. **健康、额度和调度**
   - 并发、冷却、重试、熔断和 `Retry-After`。
   - 模型支持是调度前置条件，不把请求发给不开放目标模型的账号。
   - 额度信息来自上游响应或专用接口，不凭空推断。

7. **凭据和配置文件安全**
   - `safeStorage`、renderer 隔离、日志不记录正文。
   - 配置写入前预览、备份、原子替换与恢复。
   - Linux 安全存储不可用时拒绝明文降级。

8. **跨平台发布与在线更新**
   - GitHub Actions 构建 Windows、macOS、Linux 多架构产物。
   - GitHub Release metadata、SHA-256、应用内更新能力边界。
   - 坦诚说明尚未完成 Windows 正式签名与 macOS 公证。

9. **项目现状和下一步**
   - 不承诺所有上游兼容，优先收集可复现问题。
   - 链接 GitHub、Release、Issues 和 QQ 群。

### 掘金写作提示

- 使用架构图、状态流或真实代码片段，不把 README 功能列表重新抄一遍。
- 对流式协议、凭据隔离和 SQLite 持久化给出具体取舍。
- 不发布真实账号响应、请求头或 session 示例。
- 结尾邀请具体 Issue，不用“求一键三连”作为主诉求。

## 知乎文章提纲

### 标题备选

- `同时使用 Claude Code、Codex 和 Gemini CLI，怎样减少配置与账号切换成本？`
- `为什么我选择做一个本地 AI 账号与编程客户端控制中心？`
- `多模型、多账号和多客户端并存时，个人开发者真正需要什么工具？`

### 文章结构

1. **从实际工作流出发**
   - 不同客户端配置文件、协议和模型名称不同。
   - 账号可用模型、额度和网络路径也不同。
   - 手工切换会中断工作，但把一切放到远程服务又增加凭据与运维成本。

2. **Stone 的答案：本地控制面与本地数据面**
   - 桌面 UI 管理账号、模型、号池、代理和 Profile。
   - 回环网关承接客户端请求。
   - 不设云端账号体系，不把个人工具做成团队 SaaS。

3. **号池的价值与边界**
   - 目标是对用户自己有权使用的账号做健康感知和故障切换。
   - 不改变上游权益，不提供多人共用或公共服务。
   - 可用模型和额度以上游返回为准。

4. **为什么模型开放策略要做到账号级**
   - 同一厂商的不同账号可能看到不同模型。
   - 号池模型目录应来自成员账号真实开放能力的并集。
   - 最小模型测试用于验证当下可调用性，不替代厂商承诺。

5. **本地优先并不等于不用考虑安全**
   - OS 安全存储、renderer 隔离、回环监听、本地 Token。
   - 配置备份和请求元数据的敏感边界。
   - 软件签名、公证与校验值的现实限制。

6. **适用与不适用场景**
   - 适合个人、多客户端、多上游、本机使用。
   - 不适合组织权限、团队共享、计费、云端高可用和远程运维。

7. **当前版本体验与参与方式**
   - 支持平台与升级方式。
   - GitHub、Release、Issues、QQ群。

### 知乎写作提示

- 先回答工作流问题，再介绍项目，不写成纯产品说明书。
- 对“为什么不是 New API 类服务端”“为什么不是客户端切换器”给出边界对比，但不贬低其他项目。
- 将限制放在正文中，不只放在文末免责声明。

## B站 60–90 秒视频

### 成片建议

- 时长：约 80 秒。
- 画面：1920×1080 屏幕录制，125% 左右界面缩放，鼠标移动放慢。
- 数据：使用演示账号、模型和代理；不得录入或短暂闪现真实凭据。
- 字幕：完整人工字幕；功能名与界面文字保持一致。
- 音乐：弱背景或不使用，确保口播清楚。

### 口播稿

> 如果你同时在用 Claude Code、Codex、Gemini CLI，又有不同厂商的模型和账号，配置、切换和排查状态很容易散落到很多地方。
>
> 这是 Stone+，一个运行在 Windows、macOS 和 Linux 上的开源本地控制中心。
>
> 你可以添加自己有权使用的上游账号，分别拉取和测试它们真正可用的模型，再把协议兼容的账号组成号池。Stone 会结合目标模型、账号健康、额度和调度策略选择当前可用账号。
>
> 客户端只连接本机网关。Claude Code、Codex 和 Gemini CLI 可以各自选择号池，Stone 还能在 OpenAI、Anthropic 和 Gemini 的常用协议之间转换，并支持流式文本和工具调用。
>
> 每个账号或号池也可以指定 HTTP 或 SOCKS 出口代理。配置客户端前会先预览并备份，账号凭据由操作系统安全存储保护，请求历史不保存提示词和回复正文。
>
> Stone 是个人本地工具，不是团队共享或计费平台。项目采用 Apache-2.0 开源，下载和当前限制都在 GitHub Release，欢迎通过 Issue 或 QQ 群反馈实际兼容问题。

### 镜头脚本

| 时间 | 画面 | 字幕重点 |
| --- | --- | --- |
| 0–6 秒 | 快速切换 Claude Code、Codex、Gemini CLI 图标或终端，再切 Stone 总览 | 多客户端、多账号，如何集中管理？ |
| 6–13 秒 | Stone 总览页，停留在网关状态和统计区域 | Stone+ · 本地开源控制中心 |
| 13–25 秒 | 账号页：展示多个演示账号、模型刷新、开放策略和单模型测试 | 每个账号独立发现与开放模型 |
| 25–36 秒 | 号池页：展示成员、策略、模型覆盖数 | 模型支持 + 健康 + 额度 + 调度策略 |
| 36–48 秒 | 路由页和客户端配置页：依次选择 Claude、Codex、Gemini | 一个本地网关，连接三个编程客户端 |
| 48–58 秒 | 展示协议选择、一次流式响应或工具调用的请求元数据 | 常用协议转换，支持流式与工具调用 |
| 58–66 秒 | 代理管理与 Codex 额度图 | 账号/号池出口代理与额度趋势 |
| 66–74 秒 | 配置预览、备份列表和安全存储状态 | 写入前预览，凭据留在本机 |
| 74–82 秒 | 在线更新弹窗，再切 GitHub 项目页与 Release 页 | Apache-2.0 · GitHub / Issues / QQ群 1061282900 |

### 视频简介

Stone+ 是一个面向个人开发者的本地 AI 账号、号池、代理与编程客户端控制中心，支持 Claude Code、Codex、Gemini CLI，以及 OpenAI、Anthropic、Gemini 常用协议的本地转发与转换。

- 项目：https://github.com/M4rkzzz/stone-plus
- 下载：https://github.com/M4rkzzz/stone-plus/releases/latest
- 问题反馈：https://github.com/M4rkzzz/stone-plus/issues
- QQ 群：`1061282900`

当前 Windows 尚未正式代码签名，macOS 尚未公证，请从 GitHub Release 下载并核对 `SHA256SUMS`。用户应只接入自己有权使用的账号，并遵守对应厂商条款。

## 短帖版本

### 通用短帖

开源项目 Stone+ `v0.8.0`：一个运行在 Windows、macOS 和 Linux 上的本地 AI 账号与编程客户端控制中心。

可以按账号发现、开放和测试模型，将账号组成带健康检查与故障切换的号池，为账号或号池指定 HTTP/SOCKS 出口代理，并让 Claude Code、Codex、Gemini CLI 通过同一个本地网关工作。支持 OpenAI、Anthropic、Gemini 常用协议的普通与流式转换。

Stone 面向个人管理自己有权使用的账号，不提供多租户或远程共享。凭据由操作系统安全存储保护，请求历史不保存提示词和回复正文。

- GitHub：https://github.com/M4rkzzz/stone-plus
- 下载：https://github.com/M4rkzzz/stone-plus/releases/latest
- QQ群：`1061282900`

### 100 字版本

Stone+ `v0.8.0` 开源发布：在本机统一管理多厂商 AI 账号、账号级模型、号池、HTTP/SOCKS 出口代理，以及 Claude Code、Codex、Gemini CLI 配置与路由。支持常用协议转换，数据留在本机。GitHub：https://github.com/M4rkzzz/stone-plus

### Release 转发版本

Stone+ `v0.8.0` 已发布：Windows、macOS、Linux 多平台构建，新增 GitHub Releases 更新检查、版本忽略、下载进度和更新说明。`v0.7.1` 用户需手工安装 `v0.8.0` 一次。下载：https://github.com/M4rkzzz/stone-plus/releases/latest

### QQ 群公告版本

Stone+ `v0.8.0` 已发布。请只从 GitHub Release 下载，并核对 `SHA256SUMS`：https://github.com/M4rkzzz/stone-plus/releases/latest

从 `v0.7.1` 升级需要手工安装一次。遇到问题请提供操作系统、安装形式、客户端、上游类型和可脱敏复现步骤，不要在群里发送 API Key、Token、session JSON 或完整日志。

## FAQ 与评论区回复

以下回答可以直接使用，也可以按上下文缩短。

### 这是一个面向多人的公共转发工具吗？

不是。Stone 是个人本地桌面应用，网关固定监听当前电脑的回环地址，不提供多租户、计费、远程管理或公共访问能力。它用于管理用户自己有权使用的账号；使用权限和规则仍由上游厂商决定。

### 号池会改变上游的额度规则吗？

不是。号池用于对用户自己的多个合法上游连接做模型匹配、健康检查、并发控制、冷却和故障切换。Stone 会读取并遵守能够获取到的额度或 RateLimit 信息，不会改变账号权益，也不会让不支持某个模型的账号获得该模型。

### 凭据保存在哪里？开发者能看到吗？

凭据保存在用户本机，并通过 Electron `safeStorage` 交给操作系统安全存储保护，例如 Windows DPAPI、macOS Keychain 或 Linux Secret Service 兼容后端。完整凭据只在 Electron main process 中使用，不发送给 renderer，也不会进入请求历史。Stone 没有用于收集账号凭据的云端控制服务。

### Linux 没有 Keyring 时会不会明文保存？

不会。Linux 如果只能使用 Electron 的 `basic_text` 后端，Stone 会拒绝保存凭据。请先安装并配置 `libsecret`、KWallet 等 Secret Service 兼容 Keyring。

### Stone 会上传哪些数据？

Stone 不设云端账号体系。正常联网包括：用户请求对应的上游 API、启动或手动触发的 GitHub Releases 更新检查，以及用户主动检测代理出口时访问 `api.ipify.org`，失败时回退到 `icanhazip.com`。请求历史只保存状态、延迟、Token 等元数据，不保存请求或响应正文。

### 本地网关会不会被局域网其他人访问？

Stone 在存储和服务启动两层都只允许回环地址，例如 `127.0.0.1` 或 `::1`，并要求每条客户端路由使用独立本地 Token。它不是用于局域网或公网部署的服务端。

### 为什么 Windows 会显示未知发布者？macOS 为什么会拦截？

当前 Windows 包尚未使用正式代码签名，macOS 包尚未经过 Apple 公证，因此系统可能显示未知发布者或首次启动警告。这是当前发布限制，不应被隐藏。请只从项目 GitHub Release 下载，并先使用同一 Release 中的 `SHA256SUMS` 核对文件。正式签名和公证仍在后续计划中。

### 支持哪些平台和架构？

当前提供 Windows x64 安装版与 Portable；macOS Intel 和 Apple Silicon 的 dmg/zip；Linux x64 与 arm64 的 AppImage/deb。Linux 安全凭据存储需要兼容 Keyring，部分系统运行 AppImage 还需要 FUSE 2。目前没有 Windows ARM64 构建。

### 为什么 `v0.7.1` 不能直接在线升级？

`v0.7.1` 本身没有在线更新组件，所以需要从 GitHub Releases 手工下载并安装 `v0.8.0` 一次。数据目录不因覆盖安装而主动清空，但重要数据仍建议先在 Stone 设置中创建备份。安装 `v0.8.0` 后，Windows 安装版与 Linux AppImage 可以应用内下载更新；Windows Portable、Linux deb 和当前 macOS 构建仍需手工替换。

### Portable、deb 和 macOS 为什么不能一键更新？

不同安装形式的安全替换机制不同。当前只对 Windows 安装版和 Linux AppImage 开放应用内下载与重启安装。Portable、deb 和尚未正式签名公证的 macOS 构建会打开可信的 GitHub Release 页面，让用户手工完成替换，避免假装支持一个没有充分验证的安装流程。

### 导入 Codex / ChatGPT session 安全吗？

Stone 只处理用户显式粘贴或导入的 session JSON，不扫描浏览器 Cookie，也不自动读取 `~/.codex/auth.json`。session 会作为凭据由操作系统安全存储保护。没有 Refresh Token 的 session 到期后需要重新导入。是否允许使用、可用模型和订阅权益均以上游条款与实际响应为准。

### “拉取模型”的依据是什么？

Stone 使用当前账号自己的凭据和账号级出口代理请求对应上游的模型目录，并保存该账号实际返回的结果。号池可选模型来自成员账号开放模型的并集，不是 Stone 写死的一张全局权益表。上游目录仍可能因版本、账号或服务状态变化。

### 单模型测试会做什么？

它会使用所选账号与代理向该模型发送一个很小的真实生成请求，并等待有效回复。因此它会消耗少量额度，也可能产生上游费用。测试结果只说明当时这次请求是否成功，不等于厂商对长期可用性的承诺。

### Codex 额度图为什么没有历史数据或显示未知？

额度图只适用于能够返回相关信息的 ChatGPT OAuth 账号，并从 Stone 第一次主动查询或收到额度响应头之后开始在本机积累。上游没有返回某个窗口时，Stone 会显示未知，而不是猜测数值。

### Stone 会改动 Claude Code、Codex 或 Gemini CLI 的哪些文件？

Stone 只管理所选 Profile 目录对应的用户层配置。写入前可以预览，已有文件会先备份，并使用原子替换。未知字段会尽量原样保留。建议首次使用独立测试 Profile，确认结果后再应用到日常环境。

### 配置出口代理后，失败时会自动直连吗？

不会。配置了代理但代理不可用、引用丢失或认证材料不可读时，请求会失败，不会静默回退直连。这样可以避免用户以为流量走代理，实际却从默认网络出口发出。

### 是否支持所有 OpenAI / Anthropic / Gemini 兼容服务？

不能这样承诺。Stone 覆盖常用标准协议和已测试路径，但兼容服务可能有私有字段、事件或认证规则。同协议流会尽量旁路保留上游事件；遇到问题请提交脱敏复现信息，项目会按具体实现补充兼容。

### 是免费的吗？可以商用吗？

Stone 根据 Apache License 2.0 开源，可以按许可证条款使用、修改和分发，包括商业场景。第三方组件继续适用各自许可证。上游模型或账号产生的费用与使用规则不属于 Stone 许可证范围。

### 出问题时应该提供什么？

请提供 Stone 版本、操作系统与架构、安装形式、目标客户端、上游类型、是否使用代理、可复现步骤和脱敏后的错误信息。不要提交 API Key、Access Token、Refresh Token、session JSON、真实账号 ID 或包含凭据的完整配置文件。

## 发布节奏

### T-3 至 T-1 天：准备

- 完成 `v0.8.0` tag、跨平台构建、校验和与 Release notes。
- 在干净环境验证 Windows 安装版/Portable、Linux AppImage/deb；记录 macOS 未签名公证的实际提示。
- 确认 https://github.com/M4rkzzz/stone-plus/releases/tag/v0.8.0 可公开访问。
- 准备 5 张演示截图与一段无真实凭据的录屏。
- 在 QQ 群预告发布日期，但不提前分发非最终安装包。

### T 日：GitHub 与首发社区

1. 先发布 GitHub Release，确认所有安装包、updater metadata 和 `SHA256SUMS` 均已上传。
2. 更新 GitHub 首页置顶信息与中文 README。
3. 上午或午后发布 Linux.do 长文。
4. 间隔至少 2–4 小时，再在 V2EX“分享创造”发布适配后的长文。
5. QQ 群发布简短公告和唯一 Release 链接。
6. 首日优先回答安装、安全边界和可复现兼容问题，不与用户争论使用习惯。

### T+1 至 T+3 天：技术内容

- T+1：发布掘金工程文章，重点讲架构、模型策略、流式协议与安全边界。
- T+2：发布知乎文章，从多客户端工作流和本地优先取舍切入。
- T+3：发布 B站 60–90 秒演示视频，并在简介中放 GitHub、Release、Issues 和 QQ 群。
- 每个平台根据受众改写开头，不在同一分钟机械同步完全相同的正文。

### T+4 至 T+7 天：复盘

- 汇总高频问题，更新 README FAQ 或新建 Issue，而不是只留在群聊里。
- 将确认过的兼容问题标记平台、版本和上游类型。
- 发布一条“首周问题修复/已知限制”短帖；没有实际更新时不制造版本新闻。
- 根据问题严重性决定补丁版本，不承诺固定日期后再延期。

### 后续版本节奏

- 修复安全、数据损坏或更新链路问题时优先发布补丁版本。
- 普通兼容和 UI 改进按完成度发布，不为了周更而发布未经验证的构建。
- 每个 Release 都保留不可变安装资产、updater metadata、`SHA256SUMS`、明确变更和已知限制。
- 功能宣传以已经进入公开 Release 的内容为准，不宣传仅存在于本地开发分支的能力。

## 发布前检查清单

- [ ] `package.json`、Git tag、应用关于页和 Release 版本一致。
- [ ] https://github.com/M4rkzzz/stone-plus/releases/latest 指向本次稳定版本。
- [ ] Windows、macOS、Linux 文件名与 README 下载表一致。
- [ ] `SHA256SUMS` 已生成，并在下载后抽样复核。
- [ ] Release notes 明确 Windows 未签名、macOS 未公证和各安装形式的更新方式。
- [ ] `v0.7.1` 手工升级说明位于 Release notes 和社区首发正文。
- [ ] 截图和视频不含真实邮箱、账号 ID、Token、session、代理地址或本机用户名。
- [ ] 演示模型测试使用可承受费用的测试账号，并说明会产生真实用量。
- [ ] 所有外部帖子只链接 `M4rkzzz/stone-plus` 官方仓库与 Release。
- [ ] QQ 群管理员准备好安全提醒，及时删除用户误发的凭据。
