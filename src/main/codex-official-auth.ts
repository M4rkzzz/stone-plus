import type { Account } from '@shared/types'
import {
  deserializeChatGptCredential,
  serializeChatGptCredential,
  type ChatGptCredentialBundle,
} from './auth'
import type {
  ClientConfigService,
  CodexOfficialAccountAuthSnapshot,
} from './client-config'
import { CODEX_OAUTH_CLIENT_ID } from './providers/chatgpt-codex'
import type { AppStore } from './store/app-store'

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const STABLE_CREDENTIAL_ATTEMPTS = 3
const GATEWAY_ACCESS_MIN_VALIDITY_MS = 30_000

export interface CodexOwnedGatewayCredential {
  /** True means Codex is the refresh-token owner; Stone must not refresh its copy. */
  owned: boolean
  accessToken?: string
  accountId?: string
}

/**
 * Coordinates the one rotating OAuth generation shared by Stone and Codex's
 * file-backed managed login. Codex remains the sole refresher while auth.json
 * selects that account; Stone can use the current access token but never races
 * the single-use refresh token.
 */
export class CodexOfficialAuthBridge {
  constructor(
    private readonly clientConfig: ClientConfigService,
    private readonly store: AppStore,
  ) {}

  async reclaimCurrent(): Promise<void> {
    for (let attempt = 0; attempt < STABLE_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const auth = await this.clientConfig.readCodexOfficialAccountAuth()
      if (!auth) return
      const match = matchingStoredCredential(this.store, auth)
      if (!match) return
      const candidate = authSnapshotBundle(auth, match.bundle)
      if (!candidate || !shouldReclaim(auth, candidate, match.bundle)) return
      try {
        await this.store.persistRotatedChatGptCredential(
          match.account.id,
          serializeChatGptCredential(candidate),
          match.serialized,
        )
        return
      } catch (error) {
        if (!credentialRotationConflict(error) || attempt === STABLE_CREDENTIAL_ATTEMPTS - 1) throw error
      }
    }
  }

  async gatewayCredential(account: Account, now = Date.now()): Promise<CodexOwnedGatewayCredential> {
    const auth = await this.clientConfig.readCodexOfficialAccountAuth()
    if (!auth) return { owned: false }
    const serialized = this.store.getCredential(account.credentialId)
    const stored = serialized ? deserializeChatGptCredential(serialized) : undefined
    if (!stored || auth.accountId !== stored.accountId) return { owned: false }
    if (account.chatgptAccountId && account.chatgptAccountId !== auth.accountId) return { owned: false }

    const candidate = authSnapshotBundle(auth, stored)
    // Once the selected auth.json account matches this Stone account, Codex is
    // authoritative even when its file is incomplete or expired. Falling back
    // to Stone's refresh token here would reintroduce the cross-process race.
    if (!candidate || identityIssue(candidate) || !sameStoredUser(stored, candidate)) {
      return { owned: true }
    }
    if (candidate.expiresAt <= now + GATEWAY_ACCESS_MIN_VALIDITY_MS) return { owned: true }
    return {
      owned: true,
      accessToken: candidate.accessToken,
      accountId: candidate.accountId,
    }
  }
}

interface StoredCredentialMatch {
  account: Account
  serialized: string
  bundle: ChatGptCredentialBundle
}

function matchingStoredCredential(
  store: AppStore,
  auth: CodexOfficialAccountAuthSnapshot,
): StoredCredentialMatch | undefined {
  const matches: StoredCredentialMatch[] = []
  for (const account of store.getRuntimeAccounts()) {
    if (account.credentialType !== 'chatgpt-oauth') continue
    if (account.chatgptAccountId && account.chatgptAccountId !== auth.accountId) continue
    const serialized = store.getCredential(account.credentialId)
    if (!serialized) continue
    const bundle = deserializeChatGptCredential(serialized)
    if (!bundle || bundle.accountId !== auth.accountId) continue
    const candidate = authSnapshotBundle(auth, bundle)
    if (!candidate || identityIssue(candidate) || !sameStoredUser(bundle, candidate)) continue
    matches.push({ account, serialized, bundle })
  }
  // Never guess when duplicated imports map one official identity to multiple
  // independently managed Stone records.
  return matches.length === 1 ? matches[0] : undefined
}

function authSnapshotBundle(
  auth: CodexOfficialAccountAuthSnapshot,
  current: ChatGptCredentialBundle,
): ChatGptCredentialBundle | undefined {
  const accessClaims = jwtClaims(auth.accessToken)
  const expiresAt = typeof accessClaims?.exp === 'number'
    && Number.isFinite(accessClaims.exp)
    && accessClaims.exp > 0
    ? accessClaims.exp * 1000
    : auth.accessToken === current.accessToken ? current.expiresAt : undefined
  if (!expiresAt) return undefined
  return {
    ...current,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    idToken: auth.idToken,
    accountId: auth.accountId,
    expiresAt,
  }
}

function identityIssue(bundle: ChatGptCredentialBundle): boolean {
  if (!bundle.idToken) return true
  const idClaims = jwtClaims(bundle.idToken)
  if (!idClaims || idClaims.iss !== 'https://auth.openai.com') return true
  const audiences = typeof idClaims.aud === 'string'
    ? [idClaims.aud]
    : Array.isArray(idClaims.aud)
      ? idClaims.aud.filter((value): value is string => typeof value === 'string')
      : []
  if (!audiences.includes(CODEX_OAUTH_CLIENT_ID)) return true
  const idAuth = objectValue(idClaims[OPENAI_AUTH_CLAIM])
  if (!stringValue(idAuth?.chatgpt_plan_type)) return true
  if (stringValue(idAuth?.chatgpt_account_id) !== bundle.accountId) return true
  const accessClaims = jwtClaims(bundle.accessToken)
  const accessAuth = objectValue(accessClaims?.[OPENAI_AUTH_CLAIM])
  const accessAccountId = stringValue(accessAuth?.chatgpt_account_id)
  if (accessAccountId && accessAccountId !== bundle.accountId) return true
  const idSubject = stringValue(idClaims.sub)
  const accessSubject = stringValue(accessClaims?.sub)
  return Boolean(idSubject && accessSubject && idSubject !== accessSubject)
}

function sameStoredUser(current: ChatGptCredentialBundle, candidate: ChatGptCredentialBundle): boolean {
  const currentSubject = current.userId
    ?? stringValue(jwtClaims(current.accessToken)?.sub)
    ?? stringValue(current.idToken ? jwtClaims(current.idToken)?.sub : undefined)
  const candidateSubject = stringValue(jwtClaims(candidate.accessToken)?.sub)
    ?? stringValue(candidate.idToken ? jwtClaims(candidate.idToken)?.sub : undefined)
  return !currentSubject || !candidateSubject || currentSubject === candidateSubject
}

function shouldReclaim(
  auth: CodexOfficialAccountAuthSnapshot,
  candidate: ChatGptCredentialBundle,
  current: ChatGptCredentialBundle,
): boolean {
  const accessChanged = candidate.accessToken !== current.accessToken
  const idChanged = candidate.idToken !== current.idToken
  const refreshChanged = candidate.refreshToken !== current.refreshToken
  if (!accessChanged && !idChanged && !refreshChanged) return false

  const candidateGeneration = tokenGeneration(candidate)
  const currentGeneration = tokenGeneration(current)
  if (accessChanged) {
    if (candidateGeneration > currentGeneration + 1_000) return true
    return candidateGeneration >= currentGeneration
      && candidate.expiresAt > current.expiresAt + 1_000
  }
  if (idChanged) return candidateGeneration > currentGeneration + 1_000
  return refreshChanged
    && Boolean(auth.lastRefreshAt && auth.lastRefreshAt > currentGeneration + 1_000)
}

function tokenGeneration(bundle: ChatGptCredentialBundle): number {
  const issued = [jwtClaims(bundle.accessToken), bundle.idToken ? jwtClaims(bundle.idToken) : undefined]
    .map((claims) => claims?.iat)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .map((value) => value * 1000)
  return issued.length ? Math.max(...issued) : 0
}

function credentialRotationConflict(error: unknown): boolean {
  return error instanceof Error && /credential changed while it was being rotated/i.test(error.message)
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    return objectValue(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
