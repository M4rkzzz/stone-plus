import type { Account, PoolProtocol, PublicAccount } from './types'

export const GPT_5_6_SOL_WM_MODEL = 'gpt-5.6-sol-wm'
export const GPT_5_6_SOL_MODEL = 'gpt-5.6-sol'
export const CHATGPT_WEB_WM_POOL_PROTOCOL = 'chatgpt-web-wm'
export const CHATGPT_WEB_WM_PROTOCOL_REVISION = 'chatgpt-web-wm-v2'
export const MINIMUM_CODEX_DESKTOP_WEB_WM_VERSION = '26.810.7004.0'
export const MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION = '0.148.0-alpha.9'

type WebWmAccount = Pick<Account | PublicAccount, 'credentialType' | 'chatgptWebWm'>

export function hasVerifiedChatGptWebWm(account: WebWmAccount): boolean {
  const capability = account.chatgptWebWm
  return account.credentialType === 'chatgpt-oauth'
    && capability?.version === 2
    && capability.protocolRevision === CHATGPT_WEB_WM_PROTOCOL_REVISION
    && capability.model === GPT_5_6_SOL_WM_MODEL
    && capability.catalogModel === GPT_5_6_SOL_WM_MODEL
    && capability.turnModel === GPT_5_6_SOL_WM_MODEL
    && Boolean(capability.workspacePlanType.trim())
    && (capability.workspaceStructure === 'personal' || capability.workspaceStructure === 'workspace')
    && Number.isFinite(capability.verifiedAt)
    && capability.verifiedAt > 0
    && Number.isFinite(capability.latencyMs)
    && capability.latencyMs >= 0
}

export function isChatGptWebWmPoolProtocol(
  protocol: PoolProtocol,
): protocol is typeof CHATGPT_WEB_WM_POOL_PROTOCOL {
  return protocol === CHATGPT_WEB_WM_POOL_PROTOCOL
}

/**
 * Codex Desktop uses Luna for small auxiliary structured-output turns. Those
 * requests are not user-selected Web WM turns and must retain the official
 * Codex Responses transport instead of being rewritten to Sol WM.
 */
export function isChatGptWebWmPassthroughModel(model: string): boolean {
  return model.trim().toLowerCase() === 'gpt-5.6-luna'
}

export function codexDesktopWebWmUpdateRequired(version: string | undefined): boolean {
  return versionIsOlder(version, MINIMUM_CODEX_DESKTOP_WEB_WM_VERSION)
}

export function codexWebWmClientUpdateRequired(userAgent: string | undefined): boolean {
  const version = userAgent?.match(
    /\b(?:codex_cli_rs|codex-cli)\/([0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z.-]+)?)/i,
  )?.[1]
  return versionIsOlder(version, MINIMUM_CODEX_APP_SERVER_WEB_WM_VERSION)
}

function versionIsOlder(current: string | undefined, minimum: string): boolean {
  const currentVersion = parsedVersion(current)
  const minimumVersion = parsedVersion(minimum)
  if (!currentVersion || !minimumVersion) return false
  const width = Math.max(currentVersion.core.length, minimumVersion.core.length)
  for (let index = 0; index < width; index += 1) {
    const left = currentVersion.core[index] ?? 0
    const right = minimumVersion.core[index] ?? 0
    if (left !== right) return left < right
  }
  if (!currentVersion.prerelease && minimumVersion.prerelease) return false
  if (currentVersion.prerelease && !minimumVersion.prerelease) return true
  if (!currentVersion.prerelease || !minimumVersion.prerelease) return false
  const prereleaseWidth = Math.max(
    currentVersion.prerelease.length,
    minimumVersion.prerelease.length,
  )
  for (let index = 0; index < prereleaseWidth; index += 1) {
    const left = currentVersion.prerelease[index]
    const right = minimumVersion.prerelease[index]
    if (left === undefined) return true
    if (right === undefined) return false
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left < right
    if (typeof left === 'number') return true
    if (typeof right === 'number') return false
    return left.localeCompare(right) < 0
  }
  return false
}

function parsedVersion(value: string | undefined): {
  core: number[]
  prerelease?: Array<number | string>
} | undefined {
  const match = value?.trim().replace(/^v/i, '').match(
    /^([0-9]+(?:\.[0-9]+)+)(?:-([0-9A-Za-z.-]+))?$/,
  )
  if (!match) return undefined
  const core = match[1].split('.').map(Number)
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined
  const prerelease = match[2]?.split('.').map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part))
  return { core, ...(prerelease ? { prerelease } : {}) }
}
