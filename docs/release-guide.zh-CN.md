# Stone+ Release Guide

本文档是 Stone+ 后续正式版与预发布版的可重复发布手册。当前跨平台签名、打包、完整源码归档、
provenance 与线上发布基线来自 `v0.9.6` 已实际跑通并完成线上验收的流程。`v0.9.6` 同时完成了
源码可见只读授权、品牌隔离、完整 StonePlus 源码归档及五个运行时目标的统一发布。发布工作流仍以
[`release.yml`](../.github/workflows/release.yml) 为唯一执行源，合规要求以
[`distribution-compliance.md`](distribution-compliance.md) 为准。

## 1. 发布原则

- 发布准备直接在最新 `main` 上完成并推送，不再创建 `release/*` 分支或 Release PR。
- 只提交本次发布范围；推送前必须完整通过本地质量门，并确认暂存区没有夹带其他工作。
- 正式版必须先创建并推送 GitHub Verified 的签名附注标签；标签推送自动启动工作流。
- 正式标签创建前，必须执行本文“GitHub 文件列表版本状态”步骤，使仓库文件和目录右侧的最后提交说明
  统一显示当前版本号；最终版本状态提交也必须签名并通过 GitHub Verified。
- `workflow_dispatch` 只用于重跑已经存在且签名有效的同一标签，工作流不再代为创建标签。
- 发布失败后只要需要修改代码、文档或工作流，就必须提升补丁版本并创建新的签名发布提交和标签；
  `gh run rerun` 只能用于目标提交完全不变的外部瞬时故障。
- 已公开的 Release 和 updater 资产视为不可变。工作流会拒绝覆盖已发布 Release；需要修复时发布新的补丁版本。
- 内置代理核心、Windows 签名、对应源码、更新元数据、许可证、第三方 NOTICE 或商标隔离任一验收失败都阻断发布。
- 不因某个平台失败而手工发布其余平台的残缺正式版。

## 2. 当前发布基线

| 项目 | 当前值 |
| --- | --- |
| Node.js | 24 |
| sing-box | v1.13.14 |
| StonePlus 自有材料 | StonePlus Source Available License 1.0（`SEE LICENSE IN LICENSE`） |
| 上游 Stone | Apache-2.0，完整原文保留在 `LICENSES/Apache-2.0.txt` |
| 历史授权边界 | v0.9.5 及更早版本保留随附的 Apache-2.0；迁移前以 AGPL 首次发布的修订保留当时条款 |
| 运行时目标 | Windows x64、Linux x64、Linux arm64、macOS x64、macOS arm64 |
| Windows 证书 SHA-1 | `FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D` |
| Windows 公钥证书 SHA-256 | `f4ccc82f3ade7eb06f76e55afce698179b37f299fb75ad70e5cec32e0740ca05` |
| Windows 证书有效期 | 2026-07-23 至 2029-07-23 |
| 正式 Release 资产数 | 23 |
| provenance 覆盖 | 除 `SHA256SUMS` 外的 22 个构建与源码资产 |

Windows 使用项目持续自签名 Authenticode 证书并加 RFC 3161 时间戳。该证书不在
Microsoft 公共信任链中，`UnknownError` 或 SmartScreen 提示可以是预期信任结果；
`NotSigned`、`HashMismatch`、签名者指纹不一致或缺少时间戳绝不能放行。
证书 Subject 中历史遗留的 `Open Source Release` 只是不可变身份文字，不代表当前许可证；
对外说明和安装包法律文件必须以根 `LICENSE` 为准。

### 2.2 当前安全证书与官方开发者身份

当前 Windows 正式包使用以下 StonePlus 持续签名证书。每次发布都必须从仓库文件、安装包签名和
`PROJECT_IDENTITY.json` 三处交叉核对，不能只看安装包属性中显示的名称：

| 项目 | 当前受信基线 |
| --- | --- |
| 证书文件 | `build/signing/StonePlus-CodeSigning.cer` |
| Subject | `CN=StonePlus Open Source Release, O=StonePlus Contributors` |
| SHA-1 Thumbprint | `FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D` |
| DER SHA-256 | `f4ccc82f3ade7eb06f76e55afce698179b37f299fb75ad70e5cec32e0740ca05` |
| 有效期 | 2026-07-23 至 2029-07-23 |
| 官方 GitHub 仓库 | `M4rkzzz/stone-plus` |
| 授权维护者 | `M4rkzzz` |
| 授权签名邮箱 | `221565539+M4rkzzz@users.noreply.github.com` |

这里存在三层不同的验证，发布公告和验收记录不得混为一谈：

1. **开发者与仓库身份**：发布 Commit 和附注 Tag 必须由 `PROJECT_IDENTITY.json` 中授权维护者签名，
   且 GitHub API 返回 `verification.verified=true`。
2. **Windows 文件身份**：Setup 与 Portable 必须通过 Authenticode 校验，签名者 Thumbprint 必须等于
   上表 SHA-1，并且 `TimeStamperCertificate` 非空。
3. **构建来源与内容完整性**：Release 资产必须匹配 `SHA256SUMS` 和 GitHub API digest；除
   `SHA256SUMS` 外的资产必须具有由官方 `release.yml` 生成的 provenance attestation。

当前 Authenticode 证书是项目持续自签名证书，不是商业 CA 或 Microsoft 公共信任链签发的身份凭证。
它用于确认“本次文件与其他 StonePlus 正式包使用同一持续密钥”，不能单独证明现实世界个人或企业身份，
也不保证消除 SmartScreen。官方开发者身份最终以规范仓库、GitHub Verified 签名、授权维护者清单、
固定证书指纹、校验和及 provenance 的组合验证为准。

发布前验证身份与证书元数据：

```powershell
npm run identity:verify

$identity = Get-Content PROJECT_IDENTITY.json -Raw | ConvertFrom-Json
$certificate = Get-PfxCertificate -FilePath $identity.signing.windowsAuthenticode.certificateFile
if ($certificate.Thumbprint -ne $identity.signing.windowsAuthenticode.sha1Thumbprint) {
  throw 'Windows signing certificate thumbprint mismatch'
}

$certificateHash = (Get-FileHash -Algorithm SHA256 `
  -LiteralPath $identity.signing.windowsAuthenticode.certificateFile).Hash.ToLowerInvariant()
if ($certificateHash -ne $identity.signing.windowsAuthenticode.sha256) {
  throw 'Windows signing certificate SHA-256 mismatch'
}

$certificate | Select-Object Subject, Thumbprint, NotBefore, NotAfter
```

验证 GitHub 上的最终发布 Commit 与签名附注 Tag：

```powershell
$releaseTag = 'vX.Y.Z'
$tagRef = gh api "repos/M4rkzzz/stone-plus/git/ref/tags/$releaseTag" | ConvertFrom-Json
$tagObject = gh api "repos/M4rkzzz/stone-plus/git/tags/$($tagRef.object.sha)" | ConvertFrom-Json
$commitObject = gh api "repos/M4rkzzz/stone-plus/commits/$($tagObject.object.sha)" | ConvertFrom-Json

if (-not $tagObject.verification.verified) { throw 'Release tag is not GitHub Verified' }
if (-not $commitObject.commit.verification.verified) { throw 'Release commit is not GitHub Verified' }
if ($commitObject.author.login -ne 'M4rkzzz') { throw 'Unexpected release maintainer' }
```

证书轮换时必须同时更新 CER、`PROJECT_IDENTITY.json`、`build/signing/README.md`、工作流变量、
GitHub Secrets 和本文基线；发布一个 prerelease 完成签名、时间戳、下载后校验和与 provenance 验证后，
才能把新证书用于正式版。旧 Release 保留原证书、原指纹和原校验和，不得覆盖。

### 2.3 受保护源码身份门与许可证分布检查

从 `v0.9.6` 起，以下文件共同组成 StonePlus 的受保护源码身份门。它们不是可选说明文件；发布前必须
逐项确认仍存在、内容互相一致，并且已进入 StonePlus 完整源码归档。任何一项缺失、摘要不一致或被
绕过都必须阻断发布。

#### `PROJECT_IDENTITY.json`

该文件是机器可读的官方身份基线，至少必须准确记录：

- 官方仓库 `M4rkzzz/stone-plus`、GitHub 所有者和 canonical URL；
- 授权维护者及允许的 GitHub 仓库权限；
- 授权提交与标签签名邮箱；
- StonePlus 主许可证名称、文件路径和 SHA-256；
- Windows Authenticode CER 路径、SHA-1 Thumbprint 和 DER SHA-256；
- Release provenance 工作流、attestation 要求及 `SHA256SUMS` 文件名；
- 首个 Source Available 版本和历史许可证边界。

修改许可证、证书、仓库、维护者、签名邮箱或 provenance 工作流时，必须同步更新此文件及所有引用
文档。发布前不允许通过临时跳过字段、放宽权限或改写摘要来让验证“变绿”。

#### `scripts/verify-maintainer.mjs`

`npm run identity:verify` 调用该脚本，并且必须同时完成：

1. 读取当前 GitHub CLI 登录用户，确认属于授权维护者；
2. 查询其对规范仓库的 `ADMIN`、`MAINTAIN` 或 `WRITE` 权限；
3. 确认 `origin` 指向 `PROJECT_IDENTITY.json` 中的 canonical repository；
4. 重新计算根 `LICENSE`、许可证镜像和 Windows CER 摘要；
5. 核对许可证边界、签名配置和 provenance 配置；
6. 只有全部通过时返回 `"verified": true`。

这既是人工发布门，也是仓库内 AI 编辑门。官方维护者使用 Codex、Claude Code、Gemini CLI、Copilot
或其他自动化编辑器前，必须先执行：

```powershell
npm run identity:verify
```

只有输出 `"verified": true` 才允许继续编辑。仓库名称、目录名称、口头声明、Fork 所有者身份或复制的
身份文件本身都不能替代在线 GitHub 身份和权限验证。发布质量门必须再次运行该命令，不能只依赖开发
会话开始时的一次结果。

#### `.github/CODEOWNERS`

根规则和显式关键路径必须把审核责任指向 `@M4rkzzz`。至少覆盖：

- `PROJECT_IDENTITY.json`、根许可证、许可证边界和 `LICENSES/`；
- `NOTICE`、`MODIFICATIONS.md`、`THIRD_PARTY_NOTICES.md`、`SOURCE_ACCESS.md`；
- `TRADEMARKS.md`、`AI_USAGE_POLICY.md`；
- `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、Copilot instructions；
- `.github/workflows/`、`scripts/verify-maintainer.mjs`、`build/signing/`；
- `package.json`、lockfile 以及应用的 main、preload 和 renderer 关键入口。

发布前检查 CODEOWNERS 不能只确认文件存在，还要确认 `@M4rkzzz` 没有被删除、被更宽泛的后置规则
覆盖，或将法律、品牌、身份和发布路径交给未知账号。

#### AI 工具入口文件

以下四个入口必须同时要求编辑前阅读许可证、身份和 AI 使用政策，并执行
`npm run identity:verify`：

- `AGENTS.md`；
- `CLAUDE.md`；
- `GEMINI.md`；
- `.github/copilot-instructions.md`。

发布前统一检查：

```powershell
$agentFiles = @(
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'
)
foreach ($file in $agentFiles) {
  if (-not (Select-String -LiteralPath $file -SimpleMatch 'npm run identity:verify' -Quiet)) {
    throw "$file no longer requires identity verification"
  }
}
```

#### 多处许可证与来源声明

以下位置必须继续公开且互相一致地说明 Source Available 许可证、历史许可边界、第三方归属、品牌限制
和官方来源，不能只在根 `LICENSE` 中出现一次：

- `README.md` 与 `README.en.md`；
- `SECURITY.md`；
- `NOTICE`；
- `SOURCE_ACCESS.md`；
- `TRADEMARKS.md`；
- `AI_USAGE_POLICY.md`；
- `LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt`；
- `REUSE.toml`；
- Release Note、完整源码归档和安装包 resources。

根 `LICENSE` 与 `LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt` 必须字节完全一致，且 SHA-256
等于 `PROJECT_IDENTITY.json.license.sha256`。继承的 Apache、AGPL、GPL 及其他第三方材料必须继续
保留各自文件和 NOTICE，不得被 StonePlus 自定义许可证覆盖。

#### 安装包 resources

`package.json.build.extraResources` 必须把关键法律和身份文件复制进安装包 resources。至少包括：

- `LICENSE`、`LICENSE_BOUNDARY.md`、`NOTICE`、`MODIFICATIONS.md`；
- `THIRD_PARTY_NOTICES.md`、`SOURCE_ACCESS.md`、`TRADEMARKS.md`；
- `AI_USAGE_POLICY.md`、`PROJECT_IDENTITY.json`；
- Source Available、Apache、AGPL、GPL、sing-box 和 libcronet 的许可证材料；
- `SOURCE_OFFER-sing-box.md` 及随包第三方组件需要的声明。

不能以“仓库里有”为理由跳过安装包验收。Windows unpacked resources 检查见本文 4.4；其他平台由
原生 runner 的打包产物和 Release 源码/资产门共同验证。正式发布记录必须明确写出身份门、CODEOWNERS、
四个 AI 入口、许可证镜像和安装包 resources 均已验收。

macOS 应用为 ad-hoc 签名且未经过 Apple 公证。上游 sing-box Mach-O 必须保持原始
字节，`package.json` 中的 `mac.signIgnore` 不得在没有同步调整完整性设计的情况下移除。

StonePlus Source Available License 只约束 StonePlus 有权授权的材料，不替换上游或第三方许可证；
源码可见不授权修改、衍生、再分发、商业发行/对外托管或 AI 自动改造，也不授予 Stone+、StonePlus、
Logo、官方更新入口或签名身份。边界分别以 `LICENSE`、`NOTICE`、
`THIRD_PARTY_NOTICES.md`、`SOURCE_ACCESS.md` 和 `TRADEMARKS.md` 为准。

### 2.1 v0.9.6 已验收发布记录

`v0.9.6` 是历史截断后第一个受保护的正式版本，也是本文当前发布合同的实际例证：

| 项目 | v0.9.6 实际结果 |
| --- | --- |
| 发布时间 | 2026-07-24（Asia/Shanghai） |
| Release | <https://github.com/M4rkzzz/stone-plus/releases/tag/v0.9.6> |
| 成功工作流 | <https://github.com/M4rkzzz/stone-plus/actions/runs/30027538691> |
| 发布提交 | `f4be9e3b493f32b303962c2b8467ac1d090cb7b5`，GitHub Verified |
| 发布标签 | 签名附注标签 `v0.9.6`，GitHub Verified |
| 质量门 | lint、typecheck、生产构建通过；108 个测试文件，1474 通过、1 跳过 |
| 运行时目标 | Windows x64、Linux x64、Linux arm64、macOS x64、macOS arm64 全部打包成功 |
| Release 资产 | 23 个，包含安装包、更新元数据、证书、两份源码归档和 `SHA256SUMS` |
| provenance | 除 `SHA256SUMS` 外的 22 个资产全部完成 attestation |
| 源码资产 | `StonePlus-0.9.6-source.tar.gz` 与 `StonePlus-0.9.6-sing-box-1.13.14-corresponding-source.tar.gz` |

本次发布确认了两个容易被本机环境掩盖的问题，后续版本必须保留对应防线：

- renderer 本地化测试必须显式固定预期 locale，不能依赖维护者电脑的系统语言；
- 在启用 Bash `pipefail` 时，不得用 `tar -t | grep -q` 校验大型归档，否则 `grep` 提前退出可能让
  `tar` 收到 SIGPIPE 并以 141 失败。应先把归档清单完整写入临时文件，再逐项精确匹配。

`v0.9.6` 的 23 项资产名称、签名、校验和、源码内容和线上可下载性均已完成验收。后续版本应复制
本流程并替换版本号，不能把本节中的 SHA、Run ID 或资产名称直接当作新版本结果。

## 3. 一次性仓库配置

GitHub Actions 必须配置以下内容：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `WIN_CSC_LINK` | Windows 签名 PFX 的 Base64 内容 |
| Secret | `WIN_CSC_KEY_PASSWORD` | PFX 密码 |
| Variable | `WIN_SIGNING_CERT_SHA1` | 预期签名证书 SHA-1 指纹 |

正式发布维护者还必须配置 Git 提交/标签签名。推荐使用上传到 GitHub 账号的独立 SSH signing key，
并保证本机 `user.email` 是 `PROJECT_IDENTITY.json` 中登记的签名邮箱：

```powershell
$email = '221565539+M4rkzzz@users.noreply.github.com'
$signingKey = "$HOME/.ssh/stoneplus_signing"
if (-not (Test-Path -LiteralPath $signingKey)) {
  ssh-keygen -t ed25519 -a 100 -C $email -f $signingKey
}
$allowedSigners = "$HOME/.ssh/stoneplus_allowed_signers"
"$email $((Get-Content -LiteralPath "$signingKey.pub" -Raw).Trim())" |
  Set-Content -LiteralPath $allowedSigners -Encoding utf8NoBOM

git config --global gpg.format ssh
git config --global user.signingkey $signingKey
git config --global gpg.ssh.allowedSignersFile $allowedSigners
git config --global commit.gpgsign true
git config --global tag.gpgsign true
git config --global user.email $email

gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add "$signingKey.pub" --type signing --title 'StonePlus release signing'
```

公钥必须在 GitHub **Settings → SSH and GPG keys → New SSH key → Signing Key** 登记。
私钥不得提交到仓库、GitHub Secret、Release 或诊断包。正式发布提交和标签都必须在 GitHub API
中显示 `verification.verified=true`；仅在本机 `git verify-*` 成功还不够。

仓库只提交 `build/signing/StonePlus-CodeSigning.cer` 和说明文档。PFX、私钥、密码、
临时导出文件不得进入 Git、Release、日志或 renderer。

发布前可确认名称存在，但不要读取或输出 Secret 值：

```powershell
gh secret list -R M4rkzzz/stone-plus
gh variable list -R M4rkzzz/stone-plus
```

证书轮换至少提前 60 天处理：生成或取得新的持续证书，替换公开 CER 和指纹文档，
更新两个 Secret 与 `WIN_SIGNING_CERT_SHA1`，先发布 prerelease 验证，再用于下一个正式版。
旧 Release 保留原证书和原校验值，不做覆盖。

## 4. 发布前准备

### 4.1 检查本机 GitHub CLI

Windows 上先确认 `gh` 没有被旧 npm 包或 PATH 包装器抢占：

```powershell
Get-Command gh -All | Select-Object Name, Source, CommandType
gh --version
gh auth status
gh repo set-default M4rkzzz/stone-plus
gh repo view --json nameWithOwner,url
```

正常情况下应只解析到官方 `C:\Program Files\GitHub CLI\gh.exe`。如果出现
`%APPDATA%\npm\gh.cmd`、`gh.ps1` 或旧 `node-gh`，先用 `npm list -g` 确认来源，
再卸载对应的旧全局 `gh` npm 包；不要删除官方 GitHub CLI 或凭感觉清理 PATH。

### 4.2 在 main 上更新版本

先同步主线，直接在 `main` 上准备版本：

```powershell
git switch main
git pull --ff-only origin main
npm version X.Y.Z --no-git-tag-version
```

随后完成：

- 更新 `CHANGELOG.md`，写清功能、修复、迁移与已知限制。
- 新建 `docs/releases/vX.Y.Z.md`，按下方 v0.9.3 范例编写中文 Release Note；禁止使用 GitHub 自动生成的 PR/贡献者列表代替正式说明。
- 检查 `package.json` 和 `package-lock.json` 的版本一致。
- 检查二者根包许可证均为 `SEE LICENSE IN LICENSE`，根 `LICENSE` 标题为 `StonePlus Source Available License 1.0`。
- 若修改 sing-box 版本或平台矩阵，同步更新两个 manifest、下载脚本、许可证、
  `THIRD_PARTY_NOTICES.md`、对应源码脚本、工作流资产白名单和本文档。
- 检查 README 和 Release 警告仍准确描述 Windows 自签名与 macOS 未公证限制。
- 检查 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`MODIFICATIONS.md` 与
  `TRADEMARKS.md`、`SOURCE_ACCESS.md`、`LICENSES/Apache-2.0.txt` 和
  `LICENSES/AGPL-3.0-or-later.txt` 均被官方安装包保留。
- 检查 `AI_USAGE_POLICY.md`、`AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 和
  `.github/copilot-instructions.md` 与当前许可证一致，且只允许官方维护或向官方提交私有补丁。
- 检查 `PROJECT_IDENTITY.json` 中的官方仓库、维护者、许可证 digest、Windows 证书指纹与
  provenance 工作流准确，`.github/CODEOWNERS` 仍由 `@M4rkzzz` 覆盖法律、身份和发布文件。
- 检查 `REUSE.toml` 只把 StonePlus 新增且有权授权的文件标记为
  `LicenseRef-StonePlus-Source-Available-1.0`，不得覆盖继承的 Apache 或第三方材料。
- 第一个源码可见授权正式版的 Release Note 必须明确说明：当前许可证不是开源许可证，禁止修改、
  衍生产品、再分发、商业发行或对外托管及 AI 自动代码生成；同时说明历史 Apache/AGPL 授权不追溯撤销。
- 确认工作树中没有 PFX、私钥、Token、订阅 URL 或真实账号数据。

不要在这个阶段创建或推送正式标签。

### 4.3 Release Note 固定结构与 v0.9.3 范例

Release Note 必须使用以下顺序：

1. `版本亮点`：按用户能理解的主题拆成 3–5 组，每组包含标题、emoji 和具体变化。
2. `验证`：写真实通过的测试文件数、测试项数、构建及烟测结果，不使用未经验证的数字。
3. `下载`：明确推荐安装包、便携包、其他平台包及校验文件。
4. `WARNING`：如实说明 Windows 签名、macOS 公证、Linux 密钥环等限制。
5. `完整变更`：使用相邻版本的 compare 链接。

从第一个源码可见授权版本开始，`下载` 还必须列出 `StonePlus-X.Y.Z-source.tar.gz`；版本亮点或
升级说明须链接 `LICENSE`、`SOURCE_ACCESS.md` 与 `TRADEMARKS.md`，并明确源码归档公开不等于授权修改或再分发。

不要出现 `What's Changed`、PR 编号列表、`New Contributors` 或只有一段自动生成的
`Full Changelog`。以下为风格基准，后续版本应保持同等信息密度与可读性：

<details>
<summary><strong>Stone+ v0.9.3 Release Note 完整范例</strong></summary>

```markdown
## 版本亮点

### 🧠 Codex Compact 完整适配

- 官方 OpenAI / ChatGPT OAuth 来源使用原生 compact；普通中转来源自动通过 Responses 生成兼容摘要。
- 保留会话状态头、粘滞路由和压缩后的继续对话能力。
- Codex 客户端配置默认关闭中转不支持的远程压缩 V2，并兼容 TOML 行内表。

### 🛡️ 修复超长任务反复 499

- 请求体上传完成后才开始计算上游响应超时，长上下文不再刚进入上游就立即超时。
- compact 后取消、继续和再次继续均会形成新请求，不再进入 retry5 或任务永久 499。
- 客户端取消不会污染账号健康或后续同任务请求。

### 📦 10–64 MiB 大请求无感支持

- Codex Responses 与 compact 请求超过 10 MiB 后自动进入大请求通道，无需设置、不弹窗、不截断上下文。
- 使用按字节加权的内存保护；大请求排队不会阻塞普通小请求。
- 超过 64 MiB 时稳定返回 413，不再误标为 499。

### 📡 流式与请求记录可靠性

- 完善 SSE 逻辑终止、延迟终帧、随机分片、重试和终态日志处理。
- 避免请求记录落后、账号占槽不释放或已完成请求残留为“正在传输”。

## 验证

- lint、typecheck、生产构建全部通过。
- 55 个测试文件：648 通过，1 跳过。
- 新构建 Electron 随机压力 400 请求零失败。
- 原生 Codex + Electron 连续模拟 30 分钟：97 轮同任务续聊全部成功；10–32 MiB 与 chunked 请求完整性校验通过；无非预期 499/5xx，最终 active/inFlight/streaming 全部归零。

## 下载

- Windows x64 推荐下载 `StonePlus-0.9.3-windows-x64-setup.exe`。
- 免安装使用 `StonePlus-0.9.3-windows-x64-portable.exe`。
- `SHA256SUMS-0.9.3.txt` 包含全部发布文件的 SHA-256 校验值。

> [!WARNING]
> Windows 构建未进行 Authenticode 代码签名，首次运行可能出现 SmartScreen 提示。

**完整变更**：https://github.com/M4rkzzz/stone-plus/compare/v0.9.2...v0.9.3
```

</details>

### 4.4 本地质量门

将标签保存在任务专用变量中：

```powershell
$releaseTag = 'vX.Y.Z'
npm ci
npm run identity:verify
npm run release:check -- $releaseTag
npm run check
npm run sing-box:verify
```

Windows 维护者还应生成 unpacked 包，并验证法律文件真正进入安装资源，而不只是存在于仓库：

```powershell
npm run package
$resources = 'release/win-unpacked/resources'
$required = @(
  'LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'THIRD_PARTY_NOTICES.md',
  'TRADEMARKS.md', 'SOURCE_ACCESS.md', 'PROJECT_IDENTITY.json',
  'AI_USAGE_POLICY.md', 'licenses/LicenseRef-StonePlus-Source-Available-1.0.txt',
  'licenses/Apache-2.0.txt',
  'licenses/AGPL-3.0-or-later.txt',
  'licenses/GPL-3.0-or-later.txt', 'SOURCE_OFFER-sing-box.md'
)
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $resources $_)) }
if ($missing) { throw "Packaged legal files are missing: $($missing -join ', ')" }
```

Windows 发布维护者还应至少完成一次本机签名打包与 packaged core smoke。CI 会在对应
原生 runner 上为所有五个运行时目标重新执行：

- manifest 字节一致性；
- 完整文件集合、size 和 SHA-256；
- Linux/macOS 可执行权限；
- `sing-box version`；
- `sing-box check`；
- mixed/controller 实际启动；
- 正常停止、端口关闭和无残留进程。

本机不具备所有平台时，不用跨平台伪造包；由 GitHub-hosted 原生 runner 验收。

### 4.5 提交发布内容

只提交本次发布范围，避免把未跟踪诊断文件或其他人的工作带入：

```powershell
git status --short
git diff --check
git add package.json package-lock.json CHANGELOG.md docs/releases/vX.Y.Z.md
git diff --cached --check
git commit -S -m "release: prepare vX.Y.Z"
git verify-commit HEAD

$version = 'X.Y.Z'
$sourceArchive = Join-Path $env:TEMP "StonePlus-$version-source.tar.gz"
git archive --format=tar.gz --prefix="StonePlus-$version-source/" --output=$sourceArchive HEAD
$sourceEntries = tar -tzf $sourceArchive
foreach ($required in @(
  'LICENSE', 'LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt',
  'PROJECT_IDENTITY.json', 'AI_USAGE_POLICY.md', 'package-lock.json',
  'SOURCE_ACCESS.md', 'TRADEMARKS.md'
)) {
  if ($sourceEntries -notcontains "StonePlus-$version-source/$required") {
    throw "Source archive is missing $required"
  }
}

```

此时先不要推送、不要创建标签。下一步还要生成统一的 GitHub 文件列表版本状态提交。

### 4.6 统一 GitHub 文件列表版本状态（每个版本必做）

GitHub 仓库文件列表右侧显示的文字，不是文件属性或版本字段，而是“最后一次影响该路径的 Commit
标题”。因此只更新 `package.json` 或 Release Note，不会让其他目录和文件自动显示新版本号。

每个正式版和预发布版都必须在发布内容提交后、推送正式标签前执行一次状态刷新。刷新过程用两个
签名的 mode-only Commit 让每个受 Git 跟踪的路径都由最终版本提交触达；第二个 Commit 恢复原权限，
所以最终源码内容和文件模式与刷新前完全一致。最终 Commit 标题必须只写当前版本号，例如 `v0.9.7`。

当前仓库的受跟踪文件模式基线全部为 `100644`。先确认工作区干净且没有新增可执行模式；如果命令输出
任何文件，立即停止，不得套用下面的统一恢复命令：

```powershell
git status --short
git ls-files --stage | Where-Object { $_ -notmatch '^100644 ' }
```

然后在仓库根目录打开 **Git Bash**，执行：

```bash
set -euo pipefail

release_tag='vX.Y.Z'
before_status_refresh="$(git rev-parse HEAD)"

test -z "$(git status --porcelain)"
test -z "$(git ls-files --stage | awk '$1 != "100644" { print }')"

# 第一个提交只临时切换 index 中的文件模式，使所有路径产生一次可审计变更。
git ls-files -z | git update-index --chmod=+x -z --stdin
git commit -S -m "chore: refresh ${release_tag} repository status"

# 第二个提交恢复仓库既有 100644 模式；它将成为所有文件和目录显示的最终版本状态。
git ls-files -z | git update-index --chmod=-x -z --stdin
git commit -S -m "${release_tag}"

# 两次提交前后的最终 Tree 必须完全一致，仅 Commit 历史发生变化。
git diff --exit-code "${before_status_refresh}" HEAD
git verify-commit HEAD
test "$(git log -1 --format=%s)" = "${release_tag}"
test -z "$(git status --porcelain)"
```

如果未来仓库需要保留 `100755` 可执行文件，必须先升级本节为“记录并精确恢复原始 mode”的脚本；不得
直接运行统一 `--chmod=-x`。状态刷新只允许发生在正式标签创建前。发布后不得为了改右侧文字而移动
标签、覆盖 Release 或补做状态提交；应在下一个补丁版本按本节处理。

回到 PowerShell，确认最终 Commit、所有主要路径和版本号一致，再直接推送 `main`：

```powershell
$releaseTag = 'vX.Y.Z'
git diff --check
git status --short --branch
git log -1 --format='%s'
git push origin main

$pathsToVerify = @(
  '.github', 'LICENSES', 'build', 'docs', 'scripts', 'src', 'tests',
  '.gitattributes', '.gitignore', 'AGENTS.md', 'LICENSE', 'package.json'
)
foreach ($path in $pathsToVerify) {
  $encodedPath = [Uri]::EscapeDataString($path)
  $message = gh api "repos/M4rkzzz/stone-plus/commits?path=$encodedPath&per_page=1" `
    --jq '.[0].commit.message'
  if ($message -ne $releaseTag) { throw "$path still shows: $message" }
}
```

必须确认 GitHub 页面中的目录、根文件和源码文件右侧都显示当前 `$releaseTag`，而不是旧的功能提交、
测试提交或基线提交。此步骤更新的是 GitHub 展示状态，不修改程序逻辑，也不能替代 package 版本、
Release Note、签名标签或发布资产版本检查。

不创建发布分支和 PR。推送完成后再次确认远端 `main`、本地提交和准备发布的 SHA 一致：

```powershell
git switch main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
gh api repos/M4rkzzz/stone-plus/commits/main --jq .sha
gh api repos/M4rkzzz/stone-plus/commits/main --jq .commit.verification
```

最后一条必须显示 `verified: true`，并且关联的 GitHub 用户必须在
`PROJECT_IDENTITY.json.authorizedMaintainers` 中。此时仍不要创建轻量标签。

## 5. 启动正式发布

先确认目标版本还没有标签或公开 Release，并再次核对 Release Note：

```powershell
$releaseTag = 'vX.Y.Z'
gh release view $releaseTag -R M4rkzzz/stone-plus
gh api "repos/M4rkzzz/stone-plus/git/ref/tags/$releaseTag"
```

两个命令都应返回“未找到”。如果已经存在公开 Release 或标签，不得移动、覆盖或重建；
提升补丁版本后重新准备。

还要确认当前提交中已有本版本人工编写的 Release Note：

```powershell
$releaseNotes = "docs/releases/$releaseTag.md"
if (-not (Test-Path -LiteralPath $releaseNotes)) { throw "Missing $releaseNotes" }
Select-String -Path $releaseNotes -Pattern '^## 版本亮点$','^## 验证$','^## 下载$','^> \[!WARNING\]$'
```

创建签名附注标签并推送。推送标签会自动启动工作流：

```powershell
git tag -s $releaseTag -m "Stone+ $releaseTag"
git verify-tag $releaseTag
git push origin $releaseTag

Start-Sleep -Seconds 3
gh run list `
  -R M4rkzzz/stone-plus `
  --workflow release.yml `
  --event push `
  --limit 3 `
  --json databaseId,status,conclusion,headSha,url,createdAt
```

如果构建只因临时网络或 runner 故障失败，且代码、标签和 Release 仍无需变化，可以对同一签名标签
手动重跑；`--ref` 必须是标签本身，不能是 `main`：

```powershell
gh workflow run release.yml `
  -R M4rkzzz/stone-plus `
  --ref $releaseTag `
  -f release_tag=$releaseTag `
  -f prerelease=false
```

预发布版将 `prerelease` 设为 `true`，并确保 package 版本和标签都使用同一个 SemVer
预发布版本。不要拿正式版标签运行 prerelease，也不要在同一版本上来回切换发布状态。

记录新运行的 `databaseId` 和 `headSha`，确认它等于签名标签指向的提交 SHA，再监控：

```powershell
$releaseRunId = 123456789
gh run watch $releaseRunId -R M4rkzzz/stone-plus --interval 10 --exit-status
```

## 6. 工作流必须全部通过的阶段

1. `Quality gate`
   - 官方身份文件、GitHub Verified 发布提交、签名附注标签、标签/版本一致性、人工 Release Note
     结构、lint、TypeScript、全量测试和生产构建。
2. `Package Windows x64`
   - Setup、Portable、签名、公钥证书、updater metadata、packaged sing-box smoke。
3. `Package Linux x64` 与 `Package Linux arm64`
   - AppImage、deb、updater metadata、packaged sing-box smoke。
4. `Package macOS Intel and Apple Silicon`
   - x64/arm64 的 dmg、zip、blockmap、updater metadata、原始 sing-box 哈希和 smoke。
5. `Prepare corresponding source`
   - 当前 StonePlus Tag 的完整源码归档，以及固定提交的 sing-box、cronet-go、NaiveProxy、vendor 依赖和集成构建材料。
6. `Attest release artifacts`
   - 为前述 22 个构建与源码资产生成 GitHub/Sigstore provenance。
7. `Publish GitHub Release`
   - 精确资产白名单、updater SHA-512、`SHA256SUMS`、草稿上传核对、转为公开 Release。

`actions/setup-go` 必须保持 `cache: false`，因为 Go 源码由对应源码脚本下载，仓库根没有
`go.sum`。打开默认缓存会让 source job 在脚本运行前失败。

## 7. 当前正式版资产合同

将下表中的 `X.Y.Z` 替换为实际版本。文件名集合必须恰好为 23 个，不多也不少。

| 分组 | 数量 | 文件 |
| --- | ---: | --- |
| Windows | 5 | setup、setup blockmap、portable、`latest.yml`、`StonePlus-CodeSigning.cer` |
| Linux x64 | 3 | x86_64 AppImage、amd64 deb、`latest-linux.yml` |
| Linux arm64 | 3 | arm64 AppImage、arm64 deb、`latest-linux-arm64.yml` |
| macOS | 9 | x64/arm64 的 dmg、dmg blockmap、zip、zip blockmap，以及 `latest-mac.yml` |
| 源码与合规 | 3 | `StonePlus-X.Y.Z-source.tar.gz`、`StonePlus-X.Y.Z-sing-box-1.13.14-corresponding-source.tar.gz`、`SHA256SUMS` |

完整命名由 `.github/workflows/release.yml` 的发布白名单强制检查。`SHA256SUMS` 应有
22 行，覆盖自身以外的全部资产。

`StonePlus-X.Y.Z-source.tar.gz` 必须由发布 `headSha` 通过 `git archive` 生成，包含应用源码、
依赖锁文件、构建/打包脚本、工作流和法律文件，不包含 Secret 或私钥。GitHub 自动展示的
“Source code (zip/tar.gz)”可作为辅助下载，但不能替代这个被校验和与 provenance 覆盖的明确资产。

## 8. 发布失败处理

先查看失败步骤：

```powershell
gh run view $releaseRunId -R M4rkzzz/stone-plus --log-failed
```

如果整个运行尚未结束，但某个 job 已完成，可直接读取该 job 日志：

```powershell
$releaseJobId = 123456789
gh api "repos/M4rkzzz/stone-plus/actions/jobs/$releaseJobId/logs"
```

处理规则：

- 测试断言失败：先判断实现回归还是测试硬编码了平台行为；在 `main` 修复并完整复测后启动新运行。
- 发布提交或标签未显示 GitHub Verified：不得降级为轻量/未签名标签，也不得关闭身份门；检查 GitHub
  signing key、`user.email`、签名格式与 `PROJECT_IDENTITY.json`。如果标签已推送，使用新补丁版本。
- macOS sing-box size/SHA 变化：优先检查 ad-hoc 深度签名是否重新签了上游 Mach-O，
  不得更新 manifest 来接受被意外改写的二进制。
- source job 在 `setup-go` 失败：确认仍为 `cache: false`，并检查 Go 版本可用性。
- StonePlus 源码归档缺文件：不得手工上传临时压缩包；修复 `git archive` 输入或追踪文件后，
  直接推送新的 `main` 提交并启动新运行。
- Windows 签名失败：检查 Secret/Variable 名称、证书有效期、指纹、时间戳网络；不要降级成未签名发布。
- 资产上传前失败：通常没有公开 Release。修复并直接推送 `main` 后启动一条新 workflow run。
- 已存在草稿 Release：工作流可以核对并覆盖草稿资产后发布；先确认草稿标签和目标 SHA 正确。
- 已存在公开 Release：工作流会拒绝覆盖。发布新补丁版本，不删除并重建同一稳定版本。

签名标签视为不可变。代码或工作流有任何修改时，不得移动旧标签或使用 `gh run rerun`；提升补丁版本，
重新创建签名发布提交和标签。只有外部瞬时故障且目标提交完全不变时，才可对同一标签重跑。

## 9. 发布后线上验收

### 9.1 Release、标签和资产

```powershell
$releaseTag = 'vX.Y.Z'
$release = gh release view $releaseTag `
  -R M4rkzzz/stone-plus `
  --json name,tagName,url,isDraft,isPrerelease,publishedAt,targetCommitish,assets |
  ConvertFrom-Json

$release | Select-Object name,tagName,url,isDraft,isPrerelease,publishedAt,targetCommitish
"AssetCount=$($release.assets.Count)"

gh api repos/M4rkzzz/stone-plus/releases/latest --jq .tag_name
$tagRef = gh api "repos/M4rkzzz/stone-plus/git/ref/tags/$releaseTag" | ConvertFrom-Json
$tagObject = gh api "repos/M4rkzzz/stone-plus/git/tags/$($tagRef.object.sha)" | ConvertFrom-Json
$releaseSha = $tagObject.object.sha
$tagObject | Select-Object tag,verification,tagger,object
gh api "repos/M4rkzzz/stone-plus/commits/$releaseSha" --jq .commit.verification
gh api repos/M4rkzzz/stone-plus/commits/main --jq .sha
```

正式版必须满足：

- `isDraft=false`；
- `isPrerelease=false`；
- latest 指向本次标签；标签为附注标签且 `verification.verified=true`，签名邮箱在身份文件白名单中；
- 标签直接指向的发布提交与成功运行的 `headSha` 一致，该提交也必须 `verification.verified=true`；
- 如果发布期间已有后续提交合入，当前 `main` 可以是该发布 SHA 的后代，不应因此判定旧构建被发布；
- 资产数为 23，名称集合与工作流白名单完全一致；
- 所有资产非空且 GitHub API 提供 `sha256:` digest。

### 9.2 校验和与 updater metadata

下载 `SHA256SUMS`、四份 updater metadata、Windows Setup/Portable、公钥证书和两份源码归档：

```powershell
$verifyRoot = Join-Path $env:TEMP "stone-release-$releaseTag"
New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null

gh release download $releaseTag `
  -R M4rkzzz/stone-plus `
  --dir $verifyRoot `
  --clobber `
  --pattern 'SHA256SUMS' `
  --pattern 'StonePlus-CodeSigning.cer' `
  --pattern 'latest*.yml' `
  --pattern 'StonePlus-*-source.tar.gz' `
  --pattern 'StonePlus-*-sing-box-*-corresponding-source.tar.gz' `
  --pattern 'StonePlus-*-windows-x64-setup.exe' `
  --pattern 'StonePlus-*-windows-x64-portable.exe'
```

核对：

- `SHA256SUMS` 恰好 22 行；
- 每行与 Release API 中同名资产的 digest 一致；
- 下载样本的本地 SHA-256 与 API digest 一致；
- 四份 YAML 的 `version` 正确、URL 集合精确；
- `latest.yml` 中 Setup 的 SHA-512 和 size 与下载文件一致。

工作流已在发布前验证所有平台 updater metadata；发布后再核对 API digest，可以证明上传
后内容未变化。

### 9.3 Windows 签名

```powershell
$setup = Get-ChildItem $verifyRoot\StonePlus-*-windows-x64-setup.exe -File
$portable = Get-ChildItem $verifyRoot\StonePlus-*-windows-x64-portable.exe -File
Get-AuthenticodeSignature -LiteralPath $setup.FullName
Get-AuthenticodeSignature -LiteralPath $portable.FullName
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verifyRoot 'StonePlus-CodeSigning.cer')
```

两份 EXE 都必须满足：

- `SignerCertificate.Thumbprint` 等于仓库变量；
- `TimeStamperCertificate` 非空；
- 状态不是 `NotSigned` 或 `HashMismatch`；
- 发布 CER 的 SHA-256 与 `build/signing/README.md` 一致。

### 9.4 源码、许可证与品牌文件

```powershell
$source = Get-ChildItem $verifyRoot\StonePlus-*-source.tar.gz -File
$entries = tar -tzf $source.FullName
$prefix = ($source.BaseName -replace '\.tar$', '') + '/'
foreach ($required in @(
  'LICENSE', 'NOTICE', 'package-lock.json', 'SOURCE_ACCESS.md',
  'PROJECT_IDENTITY.json', 'AI_USAGE_POLICY.md', 'AGENTS.md',
  '.github/CODEOWNERS', 'REUSE.toml',
  'LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt',
  'TRADEMARKS.md', 'LICENSES/Apache-2.0.txt',
  'LICENSES/AGPL-3.0-or-later.txt', '.github/workflows/release.yml'
)) {
  if ($entries -notcontains "$prefix$required") { throw "Source archive is missing $required" }
}
```

还必须核对：

- 根 `LICENSE` 是 StonePlus Source Available License 1.0，包元数据使用 `SEE LICENSE IN LICENSE`；
- `PROJECT_IDENTITY.json` 的官方仓库、维护者、证书指纹和许可证 SHA-256 与实际文件一致，
  `LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt` 与根 `LICENSE` 字节完全一致；
- `LICENSES/Apache-2.0.txt`、`LICENSES/AGPL-3.0-or-later.txt`、`NOTICE` 和
  `THIRD_PARTY_NOTICES.md` 仍保留上游、历史修订及第三方条款；
- 安装包构建日志确认 `TRADEMARKS.md`、`SOURCE_ACCESS.md` 和上述法律文件进入 resources；
- Release Note 明确新许可证不是开源许可证，且没有追溯覆盖历史 Apache/AGPL 修订；
- `LICENSE` 明确禁止修改、衍生、换标和再分发；`TRADEMARKS.md` 另行保护名称、Logo、更新及签名身份。

### 9.5 provenance

对下载样本执行强约束验证：

```powershell
gh attestation verify $setup.FullName `
  --repo M4rkzzz/stone-plus `
  --signer-workflow M4rkzzz/stone-plus/.github/workflows/release.yml `
  --source-digest $releaseSha `
  --source-ref "refs/tags/$releaseTag" `
  --deny-self-hosted-runners
```

还应通过 GitHub attestation API 确认除 `SHA256SUMS` 外的 22 个资产 digest 都至少有一份
证明。`SHA256SUMS` 在 attestation job 完成后生成，因此按设计不自证明；它由已证明资产
的 digest、Release API digest 和 HTTPS 发布页面共同交叉核对。

单个资产可按 API digest 查询证明数量：

```powershell
$asset = $release.assets | Where-Object name -eq $setup.Name
$assetDigest = $asset.digest -replace '^sha256:', ''
gh api "repos/M4rkzzz/stone-plus/attestations/sha256:$assetDigest" `
  --jq '.attestations | length'
```

## 10. 发布完成记录

每次发布在任务或维护日志中保留：

- Release URL；
- 成功 Actions run URL 和 run ID；
- GitHub Verified 发布提交与签名附注标签、维护者身份，以及与其一致的 run `headSha`；
- 测试通过/跳过数量；
- 23 个资产与 22 行校验和验证结果；
- Windows 签名指纹、时间戳和自签名信任限制；
- provenance 覆盖数量；
- StonePlus 完整源码归档、sing-box 对应源码归档名称和 digest；
- Source Available 1.0、历史 Apache/AGPL、第三方 NOTICE、SOURCE_ACCESS 和品牌隔离验收结果；
- `PROJECT_IDENTITY.json`、维护者权限、canonical remote、许可证/CER 摘要、CODEOWNERS、四个 AI
  编辑入口、许可证多处声明和安装包 resources 的身份门验收结果；
- GitHub 文件列表中主要目录与根文件右侧均显示本次版本号的检查结果；
- 已知限制与任何不阻断的警告。

只有以上线上验收全部完成，才能宣布 Release 完成。
