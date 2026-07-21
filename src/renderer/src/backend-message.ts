import type { ApiSourceProbeStage } from '@shared/types'
import type { UiLanguage } from './i18n'

const HAN_TEXT = /[\u3400-\u9fff]/u

/**
 * Stable messages emitted by the main process. Keeping the translation here
 * prevents an English renderer from accidentally exposing an implementation
 * message in Chinese while still leaving upstream/provider English untouched.
 */
const backendMessageEnglish = new Map<string, string>([
  // Account and OAuth flows.
  ['ChatGPT Codex 额度已耗尽。', 'ChatGPT Codex quota is exhausted.'],
  ['系统浏览器打开能力不可用。', 'Opening the system browser is unavailable.'],
  ['无法在系统浏览器中打开 OAuth 授权页面。', 'Could not open the OAuth page in the system browser.'],
  ['OAuth 授权已取消。', 'OAuth authorization was cancelled.'],
  ['OAuth 授权会话已过期，请重新开始。', 'The OAuth session expired. Start again.'],
  ['OAuth 授权会话不存在或已结束。', 'The OAuth session does not exist or has ended.'],
  ['OAuth 授权会话不存在或不属于当前窗口。', 'The OAuth session does not exist or does not belong to this window.'],
  ['OAuth 授权参数无效。', 'The OAuth authorization parameters are invalid.'],
  ['OAuth 授权窗口已经关闭。', 'The OAuth authorization window was closed.'],
  ['OAuth 回调参数无效。', 'The OAuth callback parameters are invalid.'],
  ['OAuth 回调地址来源不正确。', 'The OAuth callback has the wrong origin.'],
  ['回调地址路径不正确。', 'The callback URL has the wrong path.'],
  ['OAuth 回调 state 校验失败。', 'OAuth callback state validation failed.'],
  ['OAuth 回调缺少授权码。', 'The OAuth callback is missing an authorization code.'],
  ['OAuth Token 交换超时。', 'OAuth token exchange timed out.'],
  ['无法连接 OpenAI OAuth Token 服务。', 'Could not connect to the OpenAI OAuth token service.'],
  ['OAuth 授权码已失效、已使用或被拒绝，请重新授权。', 'The OAuth code expired, was already used, or was rejected. Authorize again.'],
  ['OpenAI OAuth 请求过于频繁，请稍后重试。', 'Too many OpenAI OAuth requests. Try again later.'],
  ['OpenAI OAuth 服务暂时不可用。', 'The OpenAI OAuth service is temporarily unavailable.'],
  ['OpenAI OAuth Token 响应格式无效。', 'The OpenAI OAuth token response has an invalid format.'],
  ['OpenAI OAuth Token 响应缺少必要凭据。', 'The OpenAI OAuth token response is missing required credentials.'],
  ['无法从 OAuth Token 中识别 ChatGPT 账号。', 'Could not identify a ChatGPT account from the OAuth token.'],
  ['请粘贴完整 OAuth 回调地址。', 'Paste the complete OAuth callback URL.'],
  ['OAuth 回调地址格式无效。', 'The OAuth callback URL is invalid.'],
  ['OAuth issuer 必须使用 HTTPS。', 'The OAuth issuer must use HTTPS.'],
  ['OAuth 授权会话 ID 无效。', 'The OAuth session ID is invalid.'],
  ['OpenAI OAuth 授权已取消或被拒绝。', 'OpenAI OAuth authorization was cancelled or denied.'],
  ['OpenAI 要求重新登录后再授权。', 'OpenAI requires you to sign in again before authorizing.'],
  ['OpenAI OAuth 授权未完成，请重新开始。', 'OpenAI OAuth authorization did not complete. Start again.'],
  ['OAuth 授权失败。', 'OAuth authorization failed.'],
  ['选择的出口代理已被删除，请重新开始 OAuth 授权。', 'The selected outbound proxy was deleted. Restart OAuth authorization.'],
  ['OAuth 授权期间所选 Tag 已被删除，账号已按“未标记”导入。', 'The selected Tag was deleted during OAuth authorization. The account was imported as untagged.'],

  // Account import/export and browser queue.
  ['未找到 access_token。', 'No access_token was found.'],
  ['未找到 account_id，且无法从 JWT user_id 自动补全。', 'No account_id was found and it could not be recovered from JWT user_id.'],
  ['账号 Access Token 已过期。', 'The account access token has expired.'],
  ['无法确定账号过期时间。', 'Could not determine when the account expires.'],
  ['JSON 格式无效。', 'The JSON is invalid.'],
  ['无效的挂起文件。', 'The queued file is invalid.'],
  ['无效的缓存文件。', 'The cached file is invalid.'],
  ['缓存中的 JSON 已不存在。', 'The cached JSON file no longer exists.'],
  ['无法打开 JSON 另存为窗口。', 'Unable to open the Save JSON dialog.'],
  ['内置浏览器下载队列尚未初始化。', 'The built-in browser download queue is not initialized.'],
  ['账号导入参数无效。', 'The account import parameters are invalid.'],
  ['请选择需要导入的挂起 JSON。', 'Select the queued JSON files to import.'],
  ['所选 JSON 已不存在或尚未下载完成，请刷新后重试。', 'The selected JSON no longer exists or has not finished downloading. Refresh and try again.'],
  ['下载已取消。', 'The download was cancelled.'],
  ['下载未完成。', 'The download did not complete.'],
  ['下载结果不是普通文件。', 'The downloaded item is not a regular file.'],
  ['下载内容不是有效 JSON。', 'The downloaded content is not valid JSON.'],

  // API source probe stages and validation.
  ['尚未发起网络请求。', 'No network request was sent.'],
  ['请输入 API Key；编辑已有来源时可留空以保留原 Key。', 'Enter an API key. Leave it blank when editing an existing source to keep the stored key.'],
  ['缺少可用凭据，未继续检测。', 'No usable credential was provided, so the remaining checks were skipped.'],
  ['缺少可用凭据。', 'No usable credential was provided.'],
  ['来源地址无效，未继续检测。', 'The source URL is invalid, so the remaining checks were skipped.'],
  ['所选供应商类型不支持当前协议。', 'The selected provider type does not support this protocol.'],
  ['协议配置无效，尚未发起网络请求。', 'The protocol configuration is invalid. No network request was sent.'],
  ['协议配置无效，未检测认证。', 'The protocol configuration is invalid. Authentication was not checked.'],
  ['协议配置无效，未发起生成请求。', 'The protocol configuration is invalid. No generation request was sent.'],
  ['已连接上游服务。', 'Connected to the upstream service.'],
  ['API Key 已通过上游认证。', 'The API key was accepted by the upstream service.'],
  ['无法连接上游服务。', 'Could not connect to the upstream service.'],
  ['网络连接失败，未继续检测。', 'The network connection failed, so the remaining checks were skipped.'],
  ['上游端点已返回 HTTP 响应。', 'The upstream endpoint returned an HTTP response.'],
  ['上游拒绝了 API Key。', 'The upstream service rejected the API key.'],
  ['认证未通过，未继续检测。', 'Authentication failed, so the remaining checks were skipped.'],
  ['上游基础检测未通过。', 'The upstream basic check did not pass.'],
  ['上游已响应，但暂时无法单独确认认证状态。', 'The upstream responded, but authentication could not be confirmed independently.'],
  ['来源基础检测未能完成。', 'The source basic check could not be completed.'],
  ['基础检测失败，未继续检测。', 'The basic check failed, so the remaining checks were skipped.'],
  ['上游模型列表为空；可手动填写测试模型。', 'The upstream model list is empty. You can enter a test model manually.'],
  ['模型发现失败；可手动填写测试模型。', 'Model discovery failed. You can enter a test model manually.'],
  ['模型发现时认证失败，未发起生成请求。', 'Authentication failed during model discovery. No generation request was sent.'],
  ['模型发现未能完成；可手动填写测试模型。', 'Model discovery could not be completed. You can enter a test model manually.'],
  ['未提供测试模型，且无法从上游发现可用模型。', 'No test model was provided and no usable model could be discovered upstream.'],
  ['最小真实生成请求已成功返回。', 'The minimal real generation request succeeded.'],
  ['真实生成请求已确认 API Key 可用。', 'The real generation request confirmed that the API key works.'],
  ['最小真实生成请求失败。', 'The minimal real generation request failed.'],
  ['最小真实生成请求未能完成。', 'The minimal real generation request could not be completed.'],
  ['Base URL 仅支持 HTTP 或 HTTPS。', 'The Base URL must use HTTP or HTTPS.'],
  ['请输入有效的 Base URL。', 'Enter a valid Base URL.'],
  ['非本地 Base URL 必须使用 HTTPS。', 'A non-local Base URL must use HTTPS.'],
  ['Base URL 不能嵌入凭据、查询参数或片段。', 'The Base URL cannot contain credentials, query parameters, or a fragment.'],

  // Application updater.
  ['开发模式不会安装在线更新。', 'Online updates are not installed in development mode.'],
  ['Portable 版本无法原地更新，请从 GitHub Release 下载新版。', 'The portable build cannot update in place. Download the new version from GitHub Releases.'],
  ['当前 Linux 安装形式不支持一键替换，请从 GitHub Release 下载新版。', 'This Linux installation cannot be replaced in app. Download the new version from GitHub Releases.'],
  ['macOS 自动安装将在正式代码签名与 Apple 公证启用后开放。', 'Automatic installation on macOS will be enabled after production code signing and Apple notarization are available.'],
  ['当前平台不支持一键安装，请从 GitHub Release 下载新版。', 'This platform does not support one-click installation. Download the new version from GitHub Releases.'],
  ['检查更新超时，请确认网络后重试。', 'The update check timed out. Check the network and try again.'],
  ['GitHub 暂时限制了更新检查，请稍后重试。', 'GitHub temporarily rate-limited update checks. Try again later.'],
  ['GitHub 上暂时没有可用的正式版本。', 'No stable release is currently available on GitHub.'],
  ['无法连接 GitHub 检查更新，请确认网络后重试。', 'Could not connect to GitHub to check for updates. Check the network and try again.'],
  ['更新文件与已确认版本不一致，已停止安装。', 'The update file does not match the confirmed release. Installation was stopped.'],
  ['该版本缺少在线更新文件，请改为打开 GitHub Release 下载。', 'This release has no in-app update asset. Download it from GitHub Releases instead.'],
  ['下载更新失败，请确认网络后重试。', 'The update download failed. Check the network and try again.'],
  ['在线更新失败，请重试或从 GitHub Release 手动下载。', 'The online update failed. Try again or download it manually from GitHub Releases.'],
  ['此版本没有提供更新说明。', 'No release notes were provided for this version.'],
  ['完整更新说明请打开 GitHub Release 查看。', 'Open the GitHub Release to view the complete release notes.'],

  // Session repair.
  ['会话修复预览无效，请重新预览。', 'The session repair preview is invalid. Preview again.'],
  ['已有会话修复正在运行。', 'A session repair is already running.'],
  ['Codex 会话数据已在预览后发生变化；为避免覆盖新内容，本次修复已中止，请重新预览。', 'Codex session data changed after the preview. Repair was stopped to avoid overwriting newer content; preview again.'],
  ['Provider ID 只能包含字母、数字、点、下划线和连字符。', 'Provider IDs may contain only letters, numbers, dots, underscores, and hyphens.'],
  ['会话修复快捷重启目前仅支持 Windows ChatGPT。', 'Quick restart after session repair currently supports only ChatGPT for Windows.'],
  ['StonePlus 正在退出，无法启动会话修复。', 'StonePlus is exiting, so session repair cannot start.'],
  ['会话修复与 ChatGPT 重启正在进行。', 'Session repair and ChatGPT restart are already in progress.'],
  ['未找到可用于会话修复的 provider。', 'No provider is available for session repair.'],
])

type PatternTranslation = {
  pattern: RegExp
  translate: (match: RegExpMatchArray, fallback: string) => string
}

const backendMessagePatterns: PatternTranslation[] = [
  {
    pattern: /^OpenAI OAuth Token 交换失败（HTTP (\d{3})）。$/,
    translate: (match) => `OpenAI OAuth token exchange failed (HTTP ${match[1]}).`,
  },
  {
    pattern: /^已发现\s*(\d+)\s*个可用模型。$/,
    translate: (match) => `${match[1]} available model(s) found.`,
  },
  {
    pattern: /^已忽略\s*(\d+)\s*个不存在的文件代理配置，相关账号改为直连。$/,
    translate: (match) => `${match[1]} missing proxy setting(s) from imported files were ignored; the affected accounts now connect directly.`,
  },
  {
    pattern: /^已读取 Sub2API 导出格式中的\s*(\d+)\s*个 OpenAI OAuth 账号。$/,
    translate: (match) => `Read ${match[1]} OpenAI OAuth account(s) from the Sub2API export.`,
  },
  {
    pattern: /^已忽略\s*(\d+)\s*个非 OpenAI OAuth 的 Sub2API 账号。$/,
    translate: (match) => `Ignored ${match[1]} Sub2API account(s) that are not OpenAI OAuth accounts.`,
  },
  {
    pattern: /^已从 JWT user_id 自动补全\s*(\d+)\s*个 CPA 账号的 account_id。$/,
    translate: (match) => `Recovered account_id from JWT user_id for ${match[1]} CPA account(s).`,
  },
  {
    pattern: /^JSON 已挂起，但写入下载缓存失败：(.+)$/,
    translate: (match, fallback) => `The JSON was queued, but it could not be written to the download cache: ${localizeNested(match[1], fallback)}`,
  },
  {
    pattern: /^无法读取 Codex config\.toml：(.+)$/,
    translate: (match, fallback) => `Could not read Codex config.toml: ${localizeNested(match[1], fallback)}`,
  },
  {
    pattern: /^无法读取 Codex 全局状态：(.+)$/,
    translate: (match, fallback) => `Could not read Codex global state: ${localizeNested(match[1], fallback)}`,
  },
  {
    pattern: /^会话文件在修复前发生变化，请重新预览：(.+)$/,
    translate: (match) => `A session file changed before repair. Preview again: ${match[1]}`,
  },
  {
    pattern: /^线程\s+(.+)\s+的 (provider|用户事件索引|工作区索引)已发生变化$/,
    translate: (match) => `Thread ${match[1]}'s ${sessionIndexName(match[2])} changed.`,
  },
  {
    pattern: /^线程\s+(.+)\s+的 (provider|用户事件索引|工作区索引)无法安全回滚$/,
    translate: (match) => `Thread ${match[1]}'s ${sessionIndexName(match[2])} could not be rolled back safely.`,
  },
  {
    pattern: /^Codex 文件不在受管目录中：(.+)$/,
    translate: (match) => `The Codex file is outside the managed directory: ${match[1]}`,
  },
  {
    pattern: /^无法关闭 ChatGPT：(.+)$/,
    translate: (match, fallback) => `Could not close ChatGPT: ${localizeNested(match[1], fallback)}`,
  },
  {
    pattern: /^(.+)；ChatGPT 重新启动失败：(.+)$/,
    translate: (match, fallback) => `${localizeNested(match[1], fallback)}; ChatGPT could not be restarted: ${localizeNested(match[2], fallback)}`,
  },
  {
    pattern: /^会话已修复，但旧备份清理失败：(.+)$/,
    translate: (match, fallback) => `Sessions were repaired, but old backups could not be cleaned up: ${localizeNested(match[1], fallback)}`,
  },
]

const probeFallbacks: Record<ApiSourceProbeStage['id'], Record<ApiSourceProbeStage['status'], string>> = {
  network: {
    success: 'The upstream network endpoint is reachable.',
    warning: 'The upstream network check returned a warning.',
    error: 'The upstream network endpoint could not be reached.',
    skipped: 'The upstream network check was skipped.',
  },
  authentication: {
    success: 'Upstream authentication succeeded.',
    warning: 'Upstream authentication could not be fully confirmed.',
    error: 'Upstream authentication failed.',
    skipped: 'The authentication check was skipped.',
  },
  models: {
    success: 'The upstream model catalog was loaded.',
    warning: 'The upstream model catalog check returned a warning.',
    error: 'The upstream model catalog could not be loaded.',
    skipped: 'The model catalog check was skipped.',
  },
  generation: {
    success: 'The real generation request succeeded.',
    warning: 'The real generation check returned a warning.',
    error: 'The real generation request failed.',
    skipped: 'The real generation request was skipped.',
  },
}

const probeStageLabels: Record<ApiSourceProbeStage['id'], readonly [string, string]> = {
  network: ['网络', 'Network'],
  authentication: ['认证', 'Authentication'],
  models: ['模型', 'Models'],
  generation: ['生成', 'Generation'],
}

const probeStatusLabels: Record<ApiSourceProbeStage['status'], readonly [string, string]> = {
  success: ['成功', 'Passed'],
  warning: ['警告', 'Warning'],
  error: ['失败', 'Failed'],
  skipped: ['已跳过', 'Skipped'],
}

export function containsHanText(value: string | null | undefined): boolean {
  return Boolean(value && HAN_TEXT.test(value))
}

export function localizeBackendMessage(
  message: string | null | undefined,
  language: UiLanguage,
  fallback = 'The operation could not be completed.',
): string {
  if (!message) return language === 'zh-CN' ? fallback : safeEnglishFallback(fallback)
  if (language === 'zh-CN' || !containsHanText(message)) return message

  const exact = backendMessageEnglish.get(message.trim())
  if (exact) return exact
  for (const entry of backendMessagePatterns) {
    const match = message.trim().match(entry.pattern)
    if (match) return entry.translate(match, safeEnglishFallback(fallback))
  }
  return withDiagnosticSignals(safeEnglishFallback(fallback), message)
}

export function localizeBackendError(
  cause: unknown,
  language: UiLanguage,
  fallback: string,
): string {
  return localizeBackendMessage(cause instanceof Error ? cause.message : undefined, language, fallback)
}

export function localizeBackendMessages(
  messages: readonly string[],
  language: UiLanguage,
  fallback: string,
): string[] {
  return messages.map((message) => localizeBackendMessage(message, language, fallback))
}

export function localizeProviderProbeStage(
  stage: ApiSourceProbeStage,
  language: UiLanguage,
): ApiSourceProbeStage {
  if (language === 'zh-CN') return stage
  return {
    ...stage,
    message: localizeBackendMessage(stage.message, language, probeFallbacks[stage.id][stage.status]),
  }
}

export function providerProbeStageLabel(stage: ApiSourceProbeStage, language: UiLanguage): string {
  return probeStageLabels[stage.id][language === 'zh-CN' ? 0 : 1]
}

export function providerProbeStatusLabel(stage: ApiSourceProbeStage, language: UiLanguage): string {
  return probeStatusLabels[stage.status][language === 'zh-CN' ? 0 : 1]
}

/** Internal updater fallback notes are localized; downloaded release content is preserved. */
export function localizeReleaseNotes(notes: string, language: UiLanguage): string {
  return language === 'zh-CN' ? notes : backendMessageEnglish.get(notes.trim()) ?? notes
}

function localizeNested(value: string, fallback: string): string {
  if (!containsHanText(value)) return value
  return localizeBackendMessage(value, 'en', fallback)
}

function safeEnglishFallback(fallback: string): string {
  return fallback && !containsHanText(fallback) ? fallback : 'The operation could not be completed.'
}

function sessionIndexName(value: string): string {
  if (value === '用户事件索引') return 'user-event index'
  if (value === '工作区索引') return 'workspace index'
  return 'provider'
}

function withDiagnosticSignals(fallback: string, message: string): string {
  const signals = new Set<string>()
  for (const match of message.matchAll(/\bHTTP\s*[:=]?\s*(\d{3})\b/gi)) signals.add(`HTTP ${match[1]}`)
  for (const match of message.matchAll(/\b(?:status(?:\s+code)?\s*[:=]?\s*)(\d{3})\b/gi)) signals.add(`HTTP ${match[1]}`)
  for (const match of message.matchAll(/\b(?:E[A-Z][A-Z0-9_]+|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)\b/g)) signals.add(match[0])
  for (const match of message.matchAll(/\b\d+(?:\.\d+)?(?:\s*(?:(?:ms|s|sec(?:onds?)?|KB|MB|GB)\b|%|秒|分钟|小时)|\b)/gi)) {
    const value = match[0].trim()
      .replace(/\s*秒$/u, ' s')
      .replace(/\s*分钟$/u, ' min')
      .replace(/\s*小时$/u, ' h')
    signals.add(value)
    if (signals.size >= 8) break
  }
  return signals.size ? `${fallback} (${[...signals].join(' · ')})` : fallback
}
