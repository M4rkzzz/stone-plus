import type { Account } from '@shared/types'
import type { CodexModelRepairPolicy } from '@shared/codex-model-repair'
import { deserializeChatGptCredential, type ChatGptCredentialBundle } from './auth'
import type {
  ClientConfigService,
  CodexOfficialAccountCredential,
} from './client-config'
import { CodexOfficialAuthBridge } from './codex-official-auth'
import type { CodexRepairAndRestartService } from './codex'
import {
  ChatGptCodexEndpointError,
  ChatGptCredentialRefreshError,
  CODEX_OAUTH_CLIENT_ID,
  queryChatGptCodexModels,
  resolveChatGptCredential,
} from './providers/chatgpt-codex'
import { resolveEffectiveProxy, type OutboundTransportManager } from './proxy'
import type { AppStore } from './store/app-store'

const BLOCKING_REFRESH_WINDOW_MS = 15 * 60 * 1000
const OAUTH_REFRESH_TIMEOUT_MS = 15_000
const CODEX_PROBE_RETRY_DELAYS_MS = [250, 750] as const
const CODEX_ID_TOKEN_MIN_VALIDITY_MS = 2 * 60 * 1000
const CODEX_ACCESS_TOKEN_MIN_VALIDITY_MS = 2 * 60 * 1000
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const STABLE_CREDENTIAL_ATTEMPTS = 3

type CodexIdTokenIssueKind =
  | 'missing'
  | 'format'
  | 'issuer'
  | 'audience'
  | 'expiry'
  | 'plan'
  | 'account'
  | 'subject'
  | 'time'

interface CodexIdTokenIssue {
  kind: CodexIdTokenIssueKind
  message: string
}

interface PreparedCodexAppAccount {
  serialized: string
  credential: CodexOfficialAccountCredential
  models?: string[]
}

interface CodexCredentialProbe {
  status: number
  models?: string[]
}

export interface ChatGptCodexAppLoginController {
  open(accountId: string): Promise<void>
}

export interface ChatGptCodexAppLoginServiceOptions {
  store: AppStore
  outboundTransport: OutboundTransportManager
  clientConfig: ClientConfigService
  repairAndRestart: CodexRepairAndRestartService
  officialAuthBridge?: CodexOfficialAuthBridge
  backupRetention?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

/**
 * Moves the single default Codex App between Stone+ and one selected official
 * ChatGPT OAuth account. Session provider metadata is synchronized to `openai`
 * before the app is relaunched; no second app profile is created.
 */
export class ChatGptCodexAppLoginService implements ChatGptCodexAppLoginController {
  private inFlight: { accountId: string; operation: Promise<void> } | undefined
  private readonly officialAuthBridge: CodexOfficialAuthBridge

  constructor(private readonly options: ChatGptCodexAppLoginServiceOptions) {
    this.officialAuthBridge = options.officialAuthBridge
      ?? new CodexOfficialAuthBridge(options.clientConfig, options.store)
  }

  open(accountId: string): Promise<void> {
    const normalizedId = accountId.trim()
    if (!normalizedId) return Promise.reject(new Error('ChatGPT OAuth 账号参数无效。'))
    if (this.inFlight) {
      if (this.inFlight.accountId === normalizedId) return this.inFlight.operation
      return Promise.reject(new Error('另一个 Codex App 账号切换正在进行，请等待完成后再试。'))
    }
    const operation = this.switchAccount(normalizedId).finally(() => {
      if (this.inFlight?.operation === operation) this.inFlight = undefined
    })
    this.inFlight = { accountId: normalizedId, operation }
    return operation
  }

  private async switchAccount(accountId: string): Promise<void> {
    try {
      // Codex owns auth.json while it is on an official login and may rotate a
      // single-use refresh token independently. Reclaim that newer generation
      // before consulting Stone+'s copy.
      await this.officialAuthBridge.reclaimCurrent()
    } catch (error) {
      throw credentialPreparationError(error, false)
    }
    const account = this.options.store.getRuntimeAccount(accountId)
    if (!account || account.credentialType !== 'chatgpt-oauth') {
      throw new Error('仅完整的 ChatGPT OAuth 账号可以切换到 Codex App。')
    }
    const serialized = this.options.store.getCredential(account.credentialId)
    if (!serialized) throw new Error('所选 ChatGPT OAuth 凭据无法从系统凭据库读取。')

    const proxy = resolveEffectiveProxy(account, undefined, this.options.store.getSnapshot().proxies)
    const proxyPassword = proxy ? this.options.store.getProxyPassword(proxy.id) : undefined
    if (proxy?.hasPassword && !proxyPassword) throw new Error('账号代理密码无法从系统凭据库读取。')
    const fetchImplementation = this.options.outboundTransport.fetchFor(proxy, proxyPassword)
    const deferPreparationUntilShutdown = (await this.officialAuthBridge.gatewayCredential(account)).owned
    let coordinatorEntered = false
    let requiresSessionRepair = true
    let prepared: PreparedCodexAppAccount
    try {
      prepared = deferPreparationUntilShutdown
        ? provisionalOwnedAccount(account, serialized)
        : await this.prepareAccount(account, serialized, fetchImplementation)
      // Parse both managed files before closing Codex. The post-shutdown apply
      // re-reads them because Codex may legitimately flush state while exiting.
      const validation = await this.options.clientConfig.validateCodexOfficialAccountActivation(prepared.credential)
      requiresSessionRepair = validation.requiresSessionRepair
    } catch (error) {
      throw credentialPreparationError(error, false)
    }

    const modelRepair = officialModelRepairPolicy(prepared.models)
    let backupGroupId: string | undefined
    try {
      coordinatorEntered = true
      await this.options.repairAndRestart.run({
        targetProvider: 'openai',
        ...(!requiresSessionRepair ? { skipSessionRepair: true } : {}),
        ...(requiresSessionRepair ? { sessionRepairScope: 'startup-index' as const } : {}),
        ...(requiresSessionRepair && modelRepair ? { modelRepair } : {}),
        beforeRepair: async () => {
          // The running desktop gets one final chance to flush auth.json during
          // shutdown. Capture that stable generation before the file is replaced.
          await this.officialAuthBridge.reclaimCurrent()
          if (deferPreparationUntilShutdown) {
            const latest = this.options.store.getCredential(account.credentialId)
            if (!latest) throw new Error('所选 ChatGPT OAuth 凭据在 Codex 关闭后不可用。')
            prepared = await this.prepareAccount(account, latest, fetchImplementation)
          }
          const stable = await this.applyStableCredentialBeforeRepair(account, prepared, fetchImplementation)
          prepared = stable.prepared
          backupGroupId = stable.backupGroupId
          if (modelRepair && prepared.models) updateOfficialModelRepairPolicy(modelRepair, prepared.models)
        },
        rollbackBeforeRepair: async () => {
          if (backupGroupId) {
            const restoring = backupGroupId
            backupGroupId = undefined
            await this.options.clientConfig.restoreBackupSet('codex', restoring)
          }
        },
        beforeRelaunch: async () => {
          prepared = await this.synchronizeLatestCredentialBeforeRelaunch(account, prepared, fetchImplementation)
        },
      })
    } catch (error) {
      throw credentialPreparationError(error, coordinatorEntered)
    }
  }

  private async prepareAccount(
    account: Account,
    initialSerialized: string,
    fetchImplementation: typeof fetch,
  ): Promise<PreparedCodexAppAccount> {
    let serialized = initialSerialized
    for (let attempt = 0; attempt < STABLE_CREDENTIAL_ATTEMPTS; attempt += 1) {
      try {
        return await this.prepareAccountOnce(account, serialized, fetchImplementation)
      } catch (error) {
        const latest = this.options.store.getCredential(account.credentialId)
        if (!credentialRotationConflict(error) || !latest || latest === serialized || attempt === STABLE_CREDENTIAL_ATTEMPTS - 1) {
          throw error
        }
        serialized = latest
      }
    }
    throw new Error('ChatGPT OAuth 凭据持续变化，请稍后重试。')
  }

  private async prepareAccountOnce(
    account: Account,
    serialized: string,
    fetchImplementation: typeof fetch,
  ): Promise<PreparedCodexAppAccount> {
    let resolved = await resolveChatGptCredential(
      serialized,
      (rotated, expectedSource) => this.options.store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
      fetchImplementation,
      Date.now(),
      {
        refreshKey: account.id,
        timeoutMs: OAUTH_REFRESH_TIMEOUT_MS,
        backgroundRefreshWindowMs: BLOCKING_REFRESH_WINDOW_MS,
        blockingRefreshWindowMs: BLOCKING_REFRESH_WINDOW_MS,
      },
    )
    assertSelectedAccount(account.chatgptAccountId, resolved.bundle)

    // Codex app-server consumes the ID token during initialization. Its
    // lifetime can be shorter than the access token, so refresh it while the
    // desktop is still untouched.
    if (codexAppIdTokenIssue(resolved.bundle, Date.now()) && resolved.bundle.refreshToken) {
      resolved = await resolveChatGptCredential(
        resolved.serialized,
        (rotated, expectedSource) => this.options.store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
        fetchImplementation,
        Date.now(),
        {
          refreshKey: account.id,
          timeoutMs: OAUTH_REFRESH_TIMEOUT_MS,
          backgroundRefreshWindowMs: Number.MAX_SAFE_INTEGER,
          blockingRefreshWindowMs: Number.MAX_SAFE_INTEGER,
          forceRefresh: true,
        },
      )
      assertSelectedAccount(account.chatgptAccountId, resolved.bundle)
    }

    let credential = completeOfficialCredential(resolved.bundle, Date.now())
    let probe = await probeCodexAppCredential(resolved.bundle, fetchImplementation, this.options.delay)
    if (probe.status === 401) {
      const latestSerialized = this.options.store.getCredential(account.credentialId) ?? resolved.serialized
      const latestBundle = deserializeChatGptCredential(latestSerialized)
      if (!latestBundle) throw new Error('所选 ChatGPT OAuth 凭据格式无效，请重新授权。')
      resolved = await resolveChatGptCredential(
        latestSerialized,
        (rotated, expectedSource) => this.options.store.persistRotatedChatGptCredential(account.id, rotated, expectedSource),
        fetchImplementation,
        Date.now(),
        {
          refreshKey: account.id,
          timeoutMs: OAUTH_REFRESH_TIMEOUT_MS,
          backgroundRefreshWindowMs: 0,
          blockingRefreshWindowMs: 0,
          forceRefresh: latestBundle.accessToken === resolved.bundle.accessToken,
        },
      )
      assertSelectedAccount(account.chatgptAccountId, resolved.bundle)
      credential = completeOfficialCredential(resolved.bundle, Date.now())
      probe = await probeCodexAppCredential(resolved.bundle, fetchImplementation, this.options.delay)
    }
    assertCodexAppProbeStatus(probe.status)
    const cachedModels = [...new Set((account.availableModels ?? []).map((model) => model.trim()).filter(Boolean))]
    const models = probe.models?.length ? probe.models : cachedModels
    if (probe.status === 429 && !models.length) {
      throw new Error('OpenAI Codex 模型目录暂时限流，且本地没有该账号的可用模型缓存；为避免写入无法启动的模型配置，本次未切换，请稍后重试。')
    }
    return {
      serialized: resolved.serialized,
      credential: {
        ...credential,
        ...(models.length ? { availableModels: models } : {}),
      },
      ...(models.length ? { models } : {}),
    }
  }

  private assertAccountUnchanged(original: Account): Account {
    const current = this.options.store.getRuntimeAccount(original.id)
    if (!current || current.credentialType !== 'chatgpt-oauth' || current.credentialId !== original.credentialId) {
      throw new Error('所选 ChatGPT OAuth 账号在切换期间已被删除或替换，请重新选择。')
    }
    if (current.proxyId !== original.proxyId) {
      throw new Error('所选账号的代理设置在切换期间发生变化；为避免混用网络身份，本次切换已中止，请重试。')
    }
    return current
  }

  private async applyStableCredentialBeforeRepair(
    original: Account,
    initial: PreparedCodexAppAccount,
    fetchImplementation: typeof fetch,
  ): Promise<{ prepared: PreparedCodexAppAccount; backupGroupId?: string }> {
    let prepared = initial
    for (let attempt = 0; attempt < STABLE_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const account = this.assertAccountUnchanged(original)
      const latest = this.options.store.getCredential(account.credentialId)
      if (!latest) throw new Error('所选 ChatGPT OAuth 凭据在切换期间已被删除。')
      if (latest !== prepared.serialized) prepared = await this.prepareAccount(account, latest, fetchImplementation)

      const applied = await this.options.clientConfig.activateCodexOfficialAccount(prepared.credential, {
        backupRetention: this.options.backupRetention?.() ?? 10,
      })
      const groupId = applied.backups[0]?.groupId
      const afterApply = this.options.store.getCredential(account.credentialId)
      if (afterApply === prepared.serialized) {
        return { prepared, ...(groupId ? { backupGroupId: groupId } : {}) }
      }

      if (groupId) {
        try {
          await this.options.clientConfig.restoreBackupSet('codex', groupId)
        } catch (error) {
          throw new Error(`OAuth 凭据在配置写入期间发生变化，且原配置恢复失败：${messageOf(error)}`)
        }
      }
      if (attempt === STABLE_CREDENTIAL_ATTEMPTS - 1) {
        throw new Error('OAuth 凭据在配置写入期间持续轮换；原配置已恢复，请稍后重试。')
      }
    }
    throw new Error('无法稳定写入 Codex App OAuth 凭据。')
  }

  private async synchronizeLatestCredentialBeforeRelaunch(
    original: Account,
    initial: PreparedCodexAppAccount,
    fetchImplementation: typeof fetch,
  ): Promise<PreparedCodexAppAccount> {
    let prepared = initial
    for (let attempt = 0; attempt < STABLE_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const account = this.assertAccountUnchanged(original)
      const latest = this.options.store.getCredential(account.credentialId)
      if (!latest) throw new Error('所选 ChatGPT OAuth 凭据在 Codex 重启前已被删除。')
      if (latest === prepared.serialized) return prepared
      prepared = await this.prepareAccount(account, latest, fetchImplementation)
      await this.options.clientConfig.activateCodexOfficialAccount(prepared.credential, {
        backupRetention: this.options.backupRetention?.() ?? 10,
      })
      // The last permitted write can itself be the stable generation. Check it
      // before consuming another retry or reporting a false switch failure.
      if (this.options.store.getCredential(account.credentialId) === prepared.serialized) {
        return prepared
      }
    }
    throw new Error('OAuth 凭据在 Codex 重启前持续轮换，请稍后重试。')
  }
}

function provisionalOwnedAccount(account: Account, serialized: string): PreparedCodexAppAccount {
  const bundle = deserializeChatGptCredential(serialized)
  if (!bundle) throw new Error('所选 ChatGPT OAuth 凭据格式无效，请重新授权。')
  assertSelectedAccount(account.chatgptAccountId, bundle)
  if (!bundle.refreshToken || !bundle.idToken) {
    throw new Error('Codex App 当前账号缺少完整的可续期 OAuth 凭据。')
  }
  const issuedAt = jwtClaims(bundle.idToken)?.iat
  const models = [...new Set((account.availableModels ?? []).map((model) => model.trim()).filter(Boolean))]
  return {
    serialized,
    credential: {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      idToken: bundle.idToken,
      accountId: bundle.accountId,
      lastRefreshAt: typeof issuedAt === 'number' && Number.isFinite(issuedAt) && issuedAt > 0
        ? Math.min(Date.now(), issuedAt * 1000)
        : Date.now(),
      ...(models.length ? { availableModels: models } : {}),
    },
    ...(models.length ? { models } : {}),
  }
}

function completeOfficialCredential(bundle: ChatGptCredentialBundle, now: number): {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  lastRefreshAt: number
} {
  if (!bundle.refreshToken) {
    throw new Error('该账号只有临时 access token，无法稳定登录 Codex App；请重新导入包含 refresh_token 的完整 OAuth JSON。')
  }
  if (!bundle.idToken) {
    throw new Error('该账号缺少 id_token，无法写入 Codex App 官方登录缓存；请重新导入完整 OAuth JSON。')
  }
  if (!hasUsableAccessToken(bundle, now)) {
    throw new Error('该账号的 access token 已过期或即将过期，请重新授权后再切换到 Codex App。')
  }
  const issue = codexAppIdTokenIssue(bundle, now)
  if (issue) {
    throw new Error(`该账号无法安全切换到 Codex App：${issue.message}。请重新进行 OpenAI OAuth 授权后再试。`)
  }
  const claims = jwtClaims(bundle.idToken)!
  return {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    idToken: bundle.idToken,
    accountId: bundle.accountId,
    lastRefreshAt: typeof claims.iat === 'number' && Number.isFinite(claims.iat) && claims.iat > 0
      ? Math.min(now, claims.iat * 1000)
      : now,
  }
}

function codexAppIdTokenIssue(bundle: ChatGptCredentialBundle, now: number): CodexIdTokenIssue | undefined {
  if (!bundle.idToken) return { kind: 'missing', message: '缺少 Codex 身份令牌' }
  const claims = jwtClaims(bundle.idToken)
  if (!claims) return { kind: 'format', message: 'Codex 身份令牌格式无效' }
  if (claims.iss !== 'https://auth.openai.com') {
    return { kind: 'issuer', message: 'Codex 身份令牌签发方无效' }
  }
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud)
      ? claims.aud.filter((value): value is string => typeof value === 'string')
      : []
  if (!audiences.includes(CODEX_OAUTH_CLIENT_ID)) {
    return { kind: 'audience', message: 'Codex 身份令牌不属于官方客户端' }
  }
  const auth = objectValue(claims[OPENAI_AUTH_CLAIM])
  const planType = stringValue(auth?.chatgpt_plan_type)
  if (!planType) return { kind: 'plan', message: 'Codex 身份令牌缺少 ChatGPT 计划声明' }
  const tokenAccountId = stringValue(auth?.chatgpt_account_id)
  if (!tokenAccountId || tokenAccountId !== bundle.accountId.trim()) {
    return { kind: 'account', message: 'Codex 身份令牌与所选账号不匹配' }
  }
  if (typeof claims.iat === 'number' && Number.isFinite(claims.iat) && claims.iat * 1000 > now + 5 * 60_000) {
    return { kind: 'time', message: 'Codex 身份令牌签发时间异常' }
  }
  if (typeof claims.nbf === 'number' && Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60_000) {
    return { kind: 'time', message: 'Codex 身份令牌尚未生效' }
  }
  const accessClaims = jwtClaims(bundle.accessToken)
  const accessAuth = objectValue(accessClaims?.[OPENAI_AUTH_CLAIM])
  const accessAccountId = stringValue(accessAuth?.chatgpt_account_id)
  if (accessAccountId && accessAccountId !== bundle.accountId.trim()) {
    return { kind: 'account', message: 'access token 与所选账号不匹配' }
  }
  const idSubject = stringValue(claims.sub)
  const accessSubject = stringValue(accessClaims?.sub)
  if (idSubject && accessSubject && idSubject !== accessSubject) {
    return { kind: 'subject', message: 'OAuth access token 与身份令牌不属于同一用户' }
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)
    || claims.exp * 1000 <= now + CODEX_ID_TOKEN_MIN_VALIDITY_MS) {
    return { kind: 'expiry', message: 'Codex 身份令牌已过期或即将过期' }
  }
  return undefined
}

function hasUsableAccessToken(bundle: ChatGptCredentialBundle, now: number): boolean {
  let expiresAt = bundle.expiresAt
  const claims = jwtClaims(bundle.accessToken)
  if (typeof claims?.exp === 'number' && Number.isFinite(claims.exp)) {
    expiresAt = Math.min(expiresAt, claims.exp * 1000)
  }
  return Number.isFinite(expiresAt) && expiresAt > now + CODEX_ACCESS_TOKEN_MIN_VALIDITY_MS
}

async function probeCodexAppCredential(
  bundle: ChatGptCredentialBundle,
  fetchImplementation: typeof fetch,
  delayImplementation: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<CodexCredentialProbe> {
  let lastError: unknown
  for (let attempt = 0; attempt <= CODEX_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const models = await queryChatGptCodexModels(
        bundle,
        fetchImplementation,
        AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
      )
      return { status: 200, models }
    } catch (error) {
      lastError = error
      if (error instanceof ChatGptCodexEndpointError) {
        if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 429) {
          return { status: error.statusCode }
        }
        if (!transientProbeStatus(error.statusCode) || attempt === CODEX_PROBE_RETRY_DELAYS_MS.length) {
          return { status: error.statusCode }
        }
      } else if (attempt === CODEX_PROBE_RETRY_DELAYS_MS.length) {
        break
      }
      await (delayImplementation ?? delay)(CODEX_PROBE_RETRY_DELAYS_MS[attempt])
    }
  }
  const detail = messageOf(lastError)
  if (/timed out|timeout|abort/i.test(detail)) {
    throw new Error('OpenAI Codex 凭据验活连续超时。')
  }
  if (/could not be reached|network|closed|fetch failed/i.test(detail)) {
    throw new Error('无法连接 OpenAI Codex 服务验活凭据。')
  }
  throw new Error('OpenAI Codex 凭据验活返回了无效的模型目录。')
}

function assertCodexAppProbeStatus(status: number): void {
  if ((status >= 200 && status < 300) || status === 429) return
  if (status === 401) throw new Error('ChatGPT OAuth 刷新后仍被 Codex 拒绝，请重新授权该账号。')
  if (status === 403) throw new Error('该 ChatGPT 账号或工作区无权使用 Codex，未修改 Codex App。')
  throw new Error(`Codex 凭据验活失败（HTTP ${status}），未修改或重启 Codex App。`)
}

function assertSelectedAccount(expectedAccountId: string | undefined, bundle: ChatGptCredentialBundle): void {
  if (expectedAccountId && expectedAccountId !== bundle.accountId) {
    throw new Error('刷新后的 ChatGPT OAuth 凭据与所选账号或工作区不匹配，未修改 Codex App。')
  }
}

function officialModelRepairPolicy(models: string[] | undefined): CodexModelRepairPolicy | undefined {
  if (!models?.length) return undefined
  return {
    modelMap: {},
    fallbackModel: models[0],
    allowedModels: [...models],
  }
}

function updateOfficialModelRepairPolicy(policy: CodexModelRepairPolicy, models: string[]): void {
  if (!models.length) return
  policy.fallbackModel = models[0]
  policy.allowedModels = [...models]
}

function credentialPreparationError(error: unknown, coordinatorEntered: boolean): Error {
  if (error instanceof ChatGptCredentialRefreshError) {
    const suffix = coordinatorEntered
      ? '；切换未完成，Stone+ 已恢复并重新启动最近一次可用配置。'
      : '；Codex App 未被关闭或修改。'
    if (error.code === 'reauthorization-required') {
      return new Error(`ChatGPT OAuth 已失效，请重新授权该账号${suffix}`)
    }
    if (error.code === 'timeout') return new Error(`刷新 ChatGPT OAuth 凭据超时${suffix}`)
    return new Error(`无法连接 OpenAI OAuth 服务刷新凭据${suffix}`)
  }
  if (error instanceof Error) {
    if (coordinatorEntered) return error
    return new Error(`${error.message}；Codex App 未被关闭或修改。`)
  }
  return new Error(coordinatorEntered
    ? 'Codex App 账号切换失败。'
    : 'Codex App 账号切换预检失败；应用未被关闭或修改。')
}

function credentialRotationConflict(error: unknown): boolean {
  return error instanceof Error && /credential changed while it was being rotated/i.test(error.message)
}

function transientProbeStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
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
