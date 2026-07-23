# Stone+ Release Guide

本文档是 Stone+ 后续正式版与预发布版的可重复发布手册。它记录的是
`v0.9.5` 已实际跑通并完成线上验收的流程；发布工作流仍以
[`release.yml`](../.github/workflows/release.yml) 为唯一执行源，合规要求以
[`distribution-compliance.md`](distribution-compliance.md) 为准。

## 1. 发布原则

- 只从已评审并合并到 `main` 的提交发布。
- 正式版优先使用 `workflow_dispatch`，让工作流创建标签；不要同时手工推送同一标签。
- 修复发布失败后必须从新 `main` SHA 启动新运行。`gh run rerun` 会继续使用旧 SHA，不能用于带代码修复的重试。
- 已公开的 Release 和 updater 资产视为不可变。工作流会拒绝覆盖已发布 Release；需要修复时发布新的补丁版本。
- 内置代理核心、Windows 签名、对应源码、更新元数据或许可证任一验收失败都阻断发布。
- 不因某个平台失败而手工发布其余平台的残缺正式版。

## 2. 当前发布基线

| 项目 | 当前值 |
| --- | --- |
| Node.js | 24 |
| sing-box | v1.13.14 |
| 运行时目标 | Windows x64、Linux x64、Linux arm64、macOS x64、macOS arm64 |
| Windows 证书 SHA-1 | `FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D` |
| Windows 公钥证书 SHA-256 | `f4ccc82f3ade7eb06f76e55afce698179b37f299fb75ad70e5cec32e0740ca05` |
| Windows 证书有效期 | 2026-07-23 至 2029-07-23 |
| 正式 Release 资产数 | 22 |
| provenance 覆盖 | 除 `SHA256SUMS` 外的 21 个构建资产 |

Windows 使用项目持续自签名 Authenticode 证书并加 RFC 3161 时间戳。该证书不在
Microsoft 公共信任链中，`UnknownError` 或 SmartScreen 提示可以是预期信任结果；
`NotSigned`、`HashMismatch`、签名者指纹不一致或缺少时间戳绝不能放行。

macOS 应用为 ad-hoc 签名且未经过 Apple 公证。上游 sing-box Mach-O 必须保持原始
字节，`package.json` 中的 `mac.signIgnore` 不得在没有同步调整完整性设计的情况下移除。

## 3. 一次性仓库配置

GitHub Actions 必须配置以下内容：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `WIN_CSC_LINK` | Windows 签名 PFX 的 Base64 内容 |
| Secret | `WIN_CSC_KEY_PASSWORD` | PFX 密码 |
| Variable | `WIN_SIGNING_CERT_SHA1` | 预期签名证书 SHA-1 指纹 |

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

### 4.2 创建发布分支并更新版本

从最新主线创建分支：

```powershell
git switch main
git pull --ff-only origin main
git switch -c release/vX.Y.Z
npm version X.Y.Z --no-git-tag-version
```

随后完成：

- 更新 `CHANGELOG.md`，写清功能、修复、迁移与已知限制。
- 检查 `package.json` 和 `package-lock.json` 的版本一致。
- 若修改 sing-box 版本或平台矩阵，同步更新两个 manifest、下载脚本、许可证、
  `THIRD_PARTY_NOTICES.md`、对应源码脚本、工作流资产白名单和本文档。
- 检查 README 和 Release 警告仍准确描述 Windows 自签名与 macOS 未公证限制。
- 确认工作树中没有 PFX、私钥、Token、订阅 URL 或真实账号数据。

不要在这个阶段创建或推送正式标签。

### 4.3 本地质量门

将标签保存在任务专用变量中：

```powershell
$releaseTag = 'vX.Y.Z'
npm ci
npm run release:check -- $releaseTag
npm run check
npm run sing-box:verify
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

### 4.4 PR 与合并

只提交本次发布范围，避免把未跟踪诊断文件或其他人的工作带入：

```powershell
git status --short
git diff --check
git diff --cached --check
git push -u origin release/vX.Y.Z
```

创建 PR，记录本地检查结果。PR 合并后再次确认：

```powershell
git switch main
git pull --ff-only origin main
git status --short --branch
gh api repos/M4rkzzz/stone-plus/commits/main --jq .sha
```

## 5. 启动正式发布

先确认目标版本还没有公开 Release：

```powershell
$releaseTag = 'vX.Y.Z'
gh release view $releaseTag -R M4rkzzz/stone-plus
```

命令应返回“未找到”。如果已经是公开 Release，不得覆盖；提升补丁版本后重新准备。

启动工作流：

```powershell
gh workflow run release.yml `
  -R M4rkzzz/stone-plus `
  --ref main `
  -f release_tag=$releaseTag `
  -f prerelease=false

Start-Sleep -Seconds 3
gh run list `
  -R M4rkzzz/stone-plus `
  --workflow release.yml `
  --event workflow_dispatch `
  --limit 3 `
  --json databaseId,status,conclusion,headSha,url,createdAt
```

预发布版将 `prerelease` 设为 `true`，并确保 package 版本和标签都使用同一个 SemVer
预发布版本。不要拿正式版标签运行 prerelease，也不要在同一版本上来回切换发布状态。

记录新运行的 `databaseId` 和 `headSha`，确认它等于刚才的 `main` SHA，再监控：

```powershell
$releaseRunId = 123456789
gh run watch $releaseRunId -R M4rkzzz/stone-plus --interval 10 --exit-status
```

## 6. 工作流必须全部通过的阶段

1. `Quality gate`
   - 标签/版本一致性、lint、TypeScript、全量测试和生产构建。
2. `Package Windows x64`
   - Setup、Portable、签名、公钥证书、updater metadata、packaged sing-box smoke。
3. `Package Linux x64` 与 `Package Linux arm64`
   - AppImage、deb、updater metadata、packaged sing-box smoke。
4. `Package macOS Intel and Apple Silicon`
   - x64/arm64 的 dmg、zip、blockmap、updater metadata、原始 sing-box 哈希和 smoke。
5. `Prepare corresponding source`
   - 固定提交的 sing-box、cronet-go、NaiveProxy、vendor 依赖和集成构建材料。
6. `Attest release artifacts`
   - 为前述 21 个资产生成 GitHub/Sigstore provenance。
7. `Publish GitHub Release`
   - 精确资产白名单、updater SHA-512、`SHA256SUMS`、草稿上传核对、转为公开 Release。

`actions/setup-go` 必须保持 `cache: false`，因为 Go 源码由对应源码脚本下载，仓库根没有
`go.sum`。打开默认缓存会让 source job 在脚本运行前失败。

## 7. 当前正式版资产合同

将下表中的 `X.Y.Z` 替换为实际版本。文件名集合必须恰好为 22 个，不多也不少。

| 分组 | 数量 | 文件 |
| --- | ---: | --- |
| Windows | 5 | setup、setup blockmap、portable、`latest.yml`、`StonePlus-CodeSigning.cer` |
| Linux x64 | 3 | x86_64 AppImage、amd64 deb、`latest-linux.yml` |
| Linux arm64 | 3 | arm64 AppImage、arm64 deb、`latest-linux-arm64.yml` |
| macOS | 9 | x64/arm64 的 dmg、dmg blockmap、zip、zip blockmap，以及 `latest-mac.yml` |
| 合规 | 2 | `StonePlus-X.Y.Z-sing-box-1.13.14-corresponding-source.tar.gz`、`SHA256SUMS` |

完整命名由 `.github/workflows/release.yml` 的发布白名单强制检查。`SHA256SUMS` 应有
21 行，覆盖自身以外的全部资产。

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

- 测试断言失败：先判断实现回归还是测试硬编码了平台行为；修复后走 PR。
- macOS sing-box size/SHA 变化：优先检查 ad-hoc 深度签名是否重新签了上游 Mach-O，
  不得更新 manifest 来接受被意外改写的二进制。
- source job 在 `setup-go` 失败：确认仍为 `cache: false`，并检查 Go 版本可用性。
- Windows 签名失败：检查 Secret/Variable 名称、证书有效期、指纹、时间戳网络；不要降级成未签名发布。
- 资产上传前失败：通常没有公开 Release。合并修复后启动一条新 workflow run。
- 已存在草稿 Release：工作流可以核对并覆盖草稿资产后发布；先确认草稿标签和目标 SHA 正确。
- 已存在公开 Release：工作流会拒绝覆盖。发布新补丁版本，不删除并重建同一稳定版本。

代码或工作流有任何修改时都不要使用 `gh run rerun`；它仍构建旧 `headSha`。

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
gh api "repos/M4rkzzz/stone-plus/git/ref/tags/$releaseTag" --jq .object.sha
gh api repos/M4rkzzz/stone-plus/commits/main --jq .sha
```

正式版必须满足：

- `isDraft=false`；
- `isPrerelease=false`；
- latest 指向本次标签，标签 SHA 等于成功运行的 `headSha` 和启动前记录的 `main` SHA；
- 如果发布期间已有后续提交合入，当前 `main` 可以是该发布 SHA 的后代，不应因此判定旧构建被发布；
- 资产数为 22，名称集合与工作流白名单完全一致；
- 所有资产非空且 GitHub API 提供 `sha256:` digest。

### 9.2 校验和与 updater metadata

下载 `SHA256SUMS`、四份 updater metadata、Windows Setup/Portable 和公钥证书：

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
  --pattern 'StonePlus-*-windows-x64-setup.exe' `
  --pattern 'StonePlus-*-windows-x64-portable.exe'
```

核对：

- `SHA256SUMS` 恰好 21 行；
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

### 9.4 provenance

对下载样本执行强约束验证：

```powershell
$releaseSha = '发布运行的 headSha'
gh attestation verify $setup.FullName `
  --repo M4rkzzz/stone-plus `
  --signer-workflow M4rkzzz/stone-plus/.github/workflows/release.yml `
  --source-digest $releaseSha `
  --source-ref refs/heads/main `
  --deny-self-hosted-runners
```

还应通过 GitHub attestation API 确认除 `SHA256SUMS` 外的 21 个资产 digest 都至少有一份
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

每次发布在任务、PR 或维护日志中保留：

- Release URL；
- 成功 Actions run URL 和 run ID；
- 启动前记录的 `main` SHA，以及与其一致的标签 SHA 和 run `headSha`；
- 测试通过/跳过数量；
- 22 个资产与 21 行校验和验证结果；
- Windows 签名指纹、时间戳和自签名信任限制；
- provenance 覆盖数量；
- sing-box 对应源码归档名称和 digest；
- 已知限制与任何不阻断的警告。

只有以上线上验收全部完成，才能宣布 Release 完成。
