import { createHash } from 'node:crypto'

export interface ChatGptCredentialBundle {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId: string
  userId?: string
  email?: string
  expiresAt: number
}

export interface ParsedChatGptAccounts {
  accounts: ChatGptCredentialBundle[]
  warnings: string[]
  accessTokenOnlyCount: number
  repairedAccountIdCount: number
}

export function parseChatGptAccountImport(content: string, now = Date.now()): ParsedChatGptAccounts {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('ChatGPT account import is empty.')
  const parsedValues = parseValues(trimmed)
  const values = parsedValues.values
  const accounts: ChatGptCredentialBundle[] = []
  const warnings: string[] = []
  let repairedAccountIdCount = 0
  for (const value of values) {
    const parsedAccount = parseAccount(value)
    const account = parsedAccount.bundle
    if (parsedAccount.repairedAccountId) repairedAccountIdCount += 1
    if (account.expiresAt <= now - 30_000) throw new Error('ChatGPT account access token has expired.')
    const existingIndex = accounts.findIndex((existing) => matchesChatGptCredential(account, existing))
    if (existingIndex >= 0) {
      if (account.refreshToken) accounts[existingIndex] = account
      continue
    }
    accounts.push(account)
  }
  if (!accounts.length) throw new Error('No ChatGPT/Codex accounts were found in the import.')
  const accessTokenOnlyCount = accounts.filter((account) => !account.refreshToken).length
  const accessTokenWarning = chatGptAccessTokenOnlyWarning(accessTokenOnlyCount)
  if (accessTokenWarning) warnings.push(accessTokenWarning)
  if (parsedValues.sub2Api) {
    warnings.push(`已读取 Sub2API 导出格式中的 ${accounts.length} 个 OpenAI OAuth 账号。`)
    if (parsedValues.skippedAccounts > 0) {
      warnings.push(`已忽略 ${parsedValues.skippedAccounts} 个非 OpenAI OAuth 的 Sub2API 账号。`)
    }
  }
  if (repairedAccountIdCount > 0) {
    warnings.push(`已从 JWT user_id 自动补全 ${repairedAccountIdCount} 个 CPA 账号的 account_id。`)
  }
  return { accounts, warnings, accessTokenOnlyCount, repairedAccountIdCount }
}

export function serializeChatGptCredential(bundle: ChatGptCredentialBundle): string {
  return JSON.stringify(bundle)
}

export function deserializeChatGptCredential(value: string): ChatGptCredentialBundle | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<ChatGptCredentialBundle>
    if (!validString(parsed.accessToken) || !validString(parsed.accountId) || !validTimestamp(parsed.expiresAt)) return undefined
    const bundle: ChatGptCredentialBundle = {
      accessToken: parsed.accessToken.trim(), accountId: parsed.accountId.trim(), expiresAt: parsed.expiresAt,
      ...(validString(parsed.refreshToken) ? { refreshToken: parsed.refreshToken.trim() } : {}),
      ...(validString(parsed.idToken) ? { idToken: parsed.idToken.trim() } : {}),
      ...(validString(parsed.userId) ? { userId: parsed.userId.trim() } : {}),
      ...(validString(parsed.email) ? { email: parsed.email.trim() } : {})
    }
    const userId = chatGptUserId(bundle)
    return userId && !bundle.userId ? { ...bundle, userId } : bundle
  } catch {
    return undefined
  }
}

export function chatGptAccessTokenOnlyWarning(count: number): string | undefined {
  if (!Number.isInteger(count) || count <= 0) return undefined
  const subject = count === 1 ? 'account has' : 'accounts have'
  return `${count} imported ChatGPT ${subject} no refresh token and will stop when the access token expires.`
}

function parseValues(content: string): { values: unknown[]; sub2Api: boolean; skippedAccounts: number } {
  try {
    const parsed = JSON.parse(content) as unknown
    if (Array.isArray(parsed)) return { values: parsed, sub2Api: false, skippedAccounts: 0 }
    const object = objectValue(parsed)
    if (Array.isArray(object?.accounts)) {
      const values = object.accounts.filter((value) => {
        const account = objectValue(value)
        return stringValue(account?.platform)?.toLowerCase() === 'openai'
          && stringValue(account?.type)?.toLowerCase() === 'oauth'
      })
      return { values, sub2Api: true, skippedAccounts: object.accounts.length - values.length }
    }
    return { values: [parsed], sub2Api: false, skippedAccounts: 0 }
  } catch {
    return { values: content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line) as unknown } catch { return line }
    }), sub2Api: false, skippedAccounts: 0 }
  }
}

function parseAccount(value: unknown): { bundle: ChatGptCredentialBundle; repairedAccountId: boolean } {
  const object = objectValue(value)
  const accessToken = firstString(
    object,
    ['access_token'], ['accessToken'], ['tokens', 'access_token'], ['tokens', 'accessToken'],
    ['credentials', 'access_token'], ['credentials', 'accessToken']
  )
    ?? (typeof value === 'string' ? value.trim() : '')
  if (!accessToken) throw new Error('ChatGPT account is missing access_token.')
  const claims = jwtClaims(accessToken)
  const auth = objectValue(claims?.['https://api.openai.com/auth'])
  const idToken = firstString(
    object,
    ['id_token'], ['idToken'], ['tokens', 'id_token'], ['tokens', 'idToken'],
    ['credentials', 'id_token'], ['credentials', 'idToken']
  )
  const idClaims = idToken ? jwtClaims(idToken) : undefined
  const idAuth = objectValue(idClaims?.['https://api.openai.com/auth'])
  const explicitAccountId = firstString(
    object,
    ['chatgpt_account_id'], ['chatgptAccountId'], ['account_id'], ['accountId'], ['account', 'id'],
    ['credentials', 'chatgpt_account_id'], ['credentials', 'chatgptAccountId'],
    ['credentials', 'account_id'], ['credentials', 'accountId'],
    ['extra', 'chatgpt_account_id'], ['extra', 'account_id']
  )
    ?? stringValue(auth?.chatgpt_account_id)
    ?? stringValue(idAuth?.chatgpt_account_id)
  const recoveredUserId = firstString(
    object,
    ['chatgpt_account_user_id'], ['chatgptAccountUserId'], ['chatgpt_user_id'], ['chatgptUserId'],
    ['user_id'], ['userId'], ['user', 'id'],
    ['credentials', 'user_id'], ['credentials', 'userId'],
    ['credentials', 'chatgpt_account_user_id'], ['credentials', 'chatgpt_user_id'],
    ['extra', 'user_id'], ['extra', 'chatgpt_account_user_id']
  )
    ?? firstString(auth, ['chatgpt_account_user_id'], ['chatgpt_user_id'], ['user_id'])
    ?? stringValue(claims?.user_id)
    ?? firstString(idAuth, ['chatgpt_account_user_id'], ['chatgpt_user_id'], ['user_id'])
    ?? stringValue(idClaims?.user_id)
  const accountId = explicitAccountId ?? recoveredUserId
  if (!accountId) throw new Error('ChatGPT account is missing account_id.')
  const expiresAt = firstTimestamp(
    object,
    ['expired'], ['expires_at'], ['expiresAt'], ['expires'],
    ['credentials', 'expired'], ['credentials', 'expires_at'], ['credentials', 'expiresAt'],
    ['extra', 'expired'], ['extra', 'expires_at']
  )
    ?? (numberValue(claims?.exp) ? numberValue(claims?.exp)! * 1000 : undefined)
  if (!expiresAt) throw new Error('ChatGPT account expiration could not be determined.')
  const refreshToken = firstString(
    object,
    ['refresh_token'], ['refreshToken'], ['tokens', 'refresh_token'], ['tokens', 'refreshToken'],
    ['credentials', 'refresh_token'], ['credentials', 'refreshToken']
  )
  const userId = recoveredUserId
    ?? stringValue(claims?.sub)
    ?? stringValue(idClaims?.sub)
  const email = firstString(
    object,
    ['email'], ['user', 'email'], ['credentials', 'email'], ['extra', 'email']
  )
    ?? stringValue(claims?.email)
    ?? emailLike(firstString(object, ['name']))
  return {
    repairedAccountId: !explicitAccountId && Boolean(recoveredUserId),
    bundle: {
      accessToken, accountId, expiresAt,
      ...(refreshToken ? { refreshToken } : {}),
      ...(idToken ? { idToken } : {}),
      ...(userId ? { userId } : {}),
      ...(email ? { email } : {})
    }
  }
}

/**
 * Access-token-only cards are intentionally keyed by token fingerprint. Team
 * workspaces can share account and user claims across otherwise distinct cards.
 */
export function matchesChatGptCredential(
  incoming: ChatGptCredentialBundle,
  stored: ChatGptCredentialBundle
): boolean {
  const storedKeys = new Set(chatGptStoredIdentityKeys(stored))
  return chatGptImportIdentityKeys(incoming).some((key) =>
    storedKeys.has(key) && !chatGptIdentityConflicts(key, incoming, stored))
}

function chatGptImportIdentityKeys(bundle: ChatGptCredentialBundle): string[] {
  const accessKey = identityKey('access', bundle.accessToken)
  return bundle.refreshToken ? chatGptStoredIdentityKeys(bundle) : [accessKey]
}

function chatGptStoredIdentityKeys(bundle: ChatGptCredentialBundle): string[] {
  const keys: string[] = []
  const userId = chatGptUserId(bundle)
  const email = chatGptEmail(bundle)
  if (userId) keys.push(identityKey('user', `${bundle.accountId}\0${userId}`))
  else if (email) keys.push(identityKey('email', `${bundle.accountId}\0${email.toLowerCase()}`))
  keys.push(identityKey('access', bundle.accessToken))
  keys.push(identityKey('account', bundle.accountId))
  return keys
}

function chatGptIdentityConflicts(
  key: string,
  incoming: ChatGptCredentialBundle,
  stored: ChatGptCredentialBundle
): boolean {
  if (!key.startsWith('account:')) return false
  const incomingUserId = chatGptUserId(incoming)
  const storedUserId = chatGptUserId(stored)
  return Boolean(incomingUserId && storedUserId && incomingUserId !== storedUserId)
}

function chatGptUserId(bundle: ChatGptCredentialBundle): string | undefined {
  if (validString(bundle.userId)) return bundle.userId.trim()
  for (const token of [bundle.accessToken, bundle.idToken]) {
    if (!token) continue
    const claims = jwtClaims(token)
    const auth = objectValue(claims?.['https://api.openai.com/auth'])
    const userId = firstString(auth, ['chatgpt_account_user_id'], ['chatgpt_user_id'], ['user_id'])
      ?? stringValue(claims?.sub)
    if (userId) return userId
  }
  return undefined
}

function chatGptEmail(bundle: ChatGptCredentialBundle): string | undefined {
  if (validString(bundle.email)) return bundle.email.trim()
  for (const token of [bundle.accessToken, bundle.idToken]) {
    if (!token) continue
    const email = stringValue(jwtClaims(token)?.email)
    if (email) return email
  }
  return undefined
}

function identityKey(kind: 'user' | 'email' | 'access' | 'account', value: string): string {
  return `${kind}:${fingerprint(value.trim())}`
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const segment = token.split('.')[1]
  if (!segment) return undefined
  try { return objectValue(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))) } catch { return undefined }
}

function firstString(object: Record<string, unknown> | undefined, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let value: unknown = object
    for (const key of path) value = objectValue(value)?.[key]
    const candidate = stringValue(value)
    if (candidate) return candidate
  }
  return undefined
}

function firstTimestamp(object: Record<string, unknown> | undefined, ...paths: string[][]): number | undefined {
  for (const path of paths) {
    let value: unknown = object
    for (const key of path) value = objectValue(value)?.[key]
    const numeric = numberValue(value)
    if (numeric !== undefined) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function validString(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function validTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function emailLike(value: string | undefined): string | undefined { return value?.includes('@') ? value : undefined }
function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex') }
