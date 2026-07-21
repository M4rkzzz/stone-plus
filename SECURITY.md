# Security Policy / 安全政策

Stone+ is a local-first desktop gateway. Security reports are taken seriously because the application handles upstream credentials, local route tokens, proxy authentication, and client configuration files.

Stone+ 是一个本地优先的桌面网关。由于应用会处理上游凭据、本地路由 Token、代理认证信息和客户端配置文件，我们会认真对待安全问题。

## Supported Versions / 支持版本

| Version / 版本 | Security support / 安全支持 |
| --- | --- |
| Latest stable GitHub Release / GitHub Releases 中的最新稳定版 | Supported / 支持 |
| Older stable releases / 较旧稳定版 | Not guaranteed; reproduce on and upgrade to the latest release first / 不保证；请先升级并在最新版复现 |
| Pre-release, source, and development builds / 预发布、源码与开发构建 | Best effort only / 仅尽力支持 |

Security fixes are normally made against the latest stable release. A report about an older version may be closed after the reporter confirms that the issue no longer exists in the latest release.

安全修复通常以最新稳定版为目标。如果旧版本中的问题在最新版已不存在，维护者可能在确认后关闭报告。

## Local Security Model / 本地安全模型

- Upstream credentials and proxy passwords are encrypted with Electron `safeStorage`, backed by the operating system credential store. Stone+ refuses to save new credentials when secure storage is unavailable instead of silently falling back to plaintext.
- Stored upstream credentials are not returned from the main process to the renderer. The regular UI receives masks and non-secret status metadata.
- Stone+ listens only on loopback addresses. Every enabled client route requires a local route token, which is visible in the UI because the local client must use it.
- Request logs contain routing metadata, status, latency, and token counts. Stone+ does not intentionally persist prompts or model responses. Known credential values and sensitive error fields are redacted before errors are returned or stored.
- The local SQLite database and its backups can contain account names, provider and proxy metadata, request metadata, route tokens, and encrypted credential blobs. Treat them as sensitive even though credential values are encrypted.
- Diagnostic reports are designed to omit credentials and account identity, but users should still review every report, screenshot, and log before sharing it.

- 上游凭据和代理密码使用 Electron `safeStorage` 加密，并由操作系统凭据存储提供保护。安全存储不可用时，Stone+ 会拒绝保存新凭据，而不会静默降级为明文。
- 已保存的上游凭据不会由 main process 返回 renderer；常规界面只接收掩码和非敏感状态元数据。
- Stone+ 仅监听回环地址。每条启用的客户端路由都需要本地路由 Token；该 Token 会显示在 UI 中，因为本机客户端需要使用它。
- 请求日志只记录路由元数据、状态、延迟和 Token 计数，不会主动持久化提示词或模型回复。已知凭据和敏感错误字段会在返回或保存前脱敏。
- 本地 SQLite 数据库及其备份可能包含账号名称、供应商与代理元数据、请求元数据、路由 Token 和加密后的凭据数据。即使凭据已加密，也应把这些文件视为敏感材料。
- 诊断报告会尽量排除凭据和账号身份，但分享前仍应人工检查每一份报告、截图和日志。

## Never Post Secrets in Public / 禁止公开粘贴敏感信息

Do not attach or paste any of the following into a public Issue, Discussion, pull request, screenshot, or chat:

- API keys, access tokens, refresh tokens, ID tokens, authorization headers, cookies, or ChatGPT/Codex session JSON.
- Full ChatGPT account IDs, proxy passwords, proxy URLs containing credentials, or Stone+ local route tokens.
- `stone-state.sqlite3`, SQLite `-wal` / `-shm` files, Stone+ database backups, or migrated state files.
- `.env`, `auth.json`, client credential files, signing certificates, private keys, or unredacted client configuration.
- Prompts, model responses, account email addresses, private provider URLs, local paths, or public egress IP addresses unless they are essential and safely anonymized.

请勿在公开 Issue、Discussion、Pull Request、截图或聊天中附加或粘贴以下内容：

- API Key、Access Token、Refresh Token、ID Token、认证 Header、Cookie 或 ChatGPT/Codex session JSON。
- 完整 ChatGPT account ID、代理密码、含凭据的代理 URL 或 Stone+ 本地路由 Token。
- `stone-state.sqlite3`、SQLite `-wal` / `-shm` 文件、Stone+ 数据库备份或迁移后的状态文件。
- `.env`、`auth.json`、客户端凭据文件、签名证书、私钥或未脱敏的客户端配置。
- 提示词、模型回复、账号邮箱、私有供应商 URL、本机路径或公网出口 IP，除非确有必要且已经安全匿名化。

Use obvious placeholders such as `sk-example-redacted`, `acct-example`, `127.0.0.1`, and `example.invalid`. If a secret was posted accidentally, revoke or rotate it immediately; editing the post is not sufficient because copies may remain in notifications, caches, and repository history.

请使用 `sk-example-redacted`、`acct-example`、`127.0.0.1`、`example.invalid` 等明显占位值。如果意外公开了凭据，请立即撤销或轮换；只编辑帖子并不充分，因为通知、缓存和仓库历史中可能仍有副本。

## Reporting a Vulnerability / 报告安全漏洞

Do not open a public Issue for a suspected vulnerability.

Please use GitHub **Private Vulnerability Reporting**:

1. Open the repository's [Security advisories page](https://github.com/M4rkzzz/stone-plus/security/advisories/new).
2. Select **Report a vulnerability**.
3. Submit the smallest safe reproduction using dummy credentials and anonymized metadata.

If Private Vulnerability Reporting is unavailable, open a public Issue only to ask the maintainers for a private reporting channel. Do not include vulnerability details, exploit code, logs, database files, or secrets in that Issue. This repository does not currently publish a dedicated security email address.

发现疑似漏洞时，请勿创建包含细节的公开 Issue。

请使用 GitHub **Private Vulnerability Reporting**：

1. 打开仓库的 [Security advisories 页面](https://github.com/M4rkzzz/stone-plus/security/advisories/new)。
2. 选择 **Report a vulnerability**。
3. 使用虚拟凭据和匿名元数据提交最小、安全的复现过程。

如果 Private Vulnerability Reporting 不可用，只能创建一个不含技术细节的公开 Issue，请维护者提供私下报告渠道。不要在其中加入漏洞细节、利用代码、日志、数据库文件或任何凭据。本仓库目前没有公布专用安全邮箱。

## What to Include / 报告内容

- Stone+ version, operating system, CPU architecture, and installation type.
- Affected feature and realistic security impact.
- Reproduction steps with dummy credentials and the minimum required configuration.
- Whether the issue requires local access, a malicious upstream, or user interaction.
- Redacted evidence and, when possible, a suggested mitigation.
- Whether the issue is already public or has been reported elsewhere.

- Stone+ 版本、操作系统、CPU 架构和安装形式。
- 受影响功能及实际安全影响。
- 使用虚拟凭据和最小配置的复现步骤。
- 问题是否需要本机访问、恶意上游或用户交互。
- 已脱敏的证据，以及可能的缓解建议。
- 问题是否已经公开或已向其他渠道报告。

Please allow maintainers time to validate and coordinate a fix before public disclosure. Do not test against accounts, providers, or systems that you do not own or have explicit permission to assess.

公开披露前，请给维护者留出验证和协调修复的时间。不要对自己不拥有、或未获得明确授权的账号、供应商和系统进行测试。

## Ordinary Bugs / 普通问题

Provider outages, rejected credentials, model availability differences, setup questions, and non-security defects should use the public bug report template after all sensitive information has been removed.

供应商故障、凭据被拒绝、模型可用性差异、配置问题和非安全缺陷，请在彻底移除敏感信息后使用公开 Bug 模板。
