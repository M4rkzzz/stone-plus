import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  extractProtocolUsage,
  extractRateLimitSignals,
  getProviderAdapter,
  applyChatGptCodexHeaders,
  applyChatGptCodexSearchHeaders,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_CODEX_SEARCH_URL,
  classifyChatGptCodexFailure,
  codexQuotaCooldownUntil,
  codexQuotaIsExhausted,
  isChatGptCodexResponsesLiteBody,
  withChatGptCodexBody,
  type NormalizedTokenUsage,
  type NormalizedQuotaSignals,
  type ProviderFailure
} from '../providers'
import type {
  Account,
  AccountCodexQuotaSnapshot,
  AccountQuotaSnapshot,
  GatewaySettings,
  GatewayStatus,
  Pool,
  Protocol,
  ProviderDefinition,
  RequestLog,
  Route
} from '../../shared/types'
import {
  convertRequest,
  convertResponse,
  getRequestModel,
  UnsupportedProtocolConversionError
} from './protocol'
import {
  ModelNotExposedError,
  NoEligibleAccountError,
  PoolScheduler
} from './scheduler'
import {
  createCanonicalStreamEncoder,
  createCanonicalStreamParser,
  createOpenAiResponsesStreamCollector,
  type CanonicalStreamEvent,
  type StreamEncodingOptions
} from './streaming'
import type {
  CredentialResolver,
  GatewayAccountState,
  GatewayAccountStateHandler,
  GatewayConfig,
  GatewayController,
  GatewayLogHandler,
  OutboundFetchResolver,
  ConversationTitleResolver,
  GatewayServerOptions
} from './types'

type JsonObject = Record<string, unknown>

interface IncomingRoute {
  protocol: Protocol
  operation: 'generate' | 'codex-search'
  geminiMethod?: 'generateContent' | 'streamGenerateContent'
}

const MIN_FIRST_BODY_TIMEOUT_MS = 1_000
const MAX_FIRST_BODY_TIMEOUT_MS = 12_000
const HEDGE_ERROR_GRACE_MS = 750

export class GatewayServer implements GatewayController {
  private config: GatewayConfig
  private credentialResolver: CredentialResolver
  private readonly fetchImplementation: typeof fetch
  private readonly outboundFetchResolver?: OutboundFetchResolver
  private readonly conversationTitleResolver?: ConversationTitleResolver
  private readonly scheduler: PoolScheduler
  private readonly logListeners = new Set<GatewayLogHandler>()
  private readonly accountStateListeners = new Set<GatewayAccountStateHandler>()
  private readonly now: () => number
  private server?: Server
  private startedAt?: number
  private activeRequests = 0
  private totalRequests = 0
  private successRequests = 0

  constructor(options: GatewayServerOptions) {
    this.config = options.config
    this.credentialResolver = options.credentialResolver
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.outboundFetchResolver = options.outboundFetchResolver
    this.conversationTitleResolver = options.conversationTitleResolver
    this.now = options.now ?? (() => Date.now())
    this.scheduler = new PoolScheduler(this.now, options.random)
    this.scheduler.hydrate(this.config.accounts)
    this.scheduler.hydratePerformance(this.config.recentRequestLogs ?? [])
    if (options.onLog) this.logListeners.add(options.onLog)
    if (options.onAccountState) this.accountStateListeners.add(options.onAccountState)
  }

  async start(settings?: GatewaySettings, credentialResolver?: CredentialResolver): Promise<void> {
    if (settings) this.config = { ...this.config, settings }
    if (credentialResolver) this.credentialResolver = credentialResolver
    if (this.server) return
    this.scheduler.hydrate(this.config.accounts)
    this.scheduler.hydratePerformance(this.config.recentRequestLogs ?? [])

    const { host, port } = this.config.settings
    if (!isLoopbackHost(host)) {
      throw new Error(`Gateway host must be loopback-only; received ${host}`)
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    // Codex clients frequently submit consecutive turns. Keep their local
    // connection alive so FRP and cross-network users do not pay another TCP
    // handshake between requests.
    this.server.keepAliveTimeout = 120_000
    this.server.headersTimeout = 125_000
    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (!server) return reject(new Error('Gateway server was not created'))
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.server = undefined
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        this.startedAt = this.now()
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  async stop(options: { force?: boolean; drainTimeoutMs?: number } = {}): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeIdleConnections()
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    if (options.force) {
      server.closeAllConnections()
      await closed
    } else {
      const drainTimeoutMs = Math.max(1_000, options.drainTimeoutMs ?? 30_000)
      let timer: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), drainTimeoutMs) })
      ])
      if (timer) clearTimeout(timer)
      if (!drained) {
        server.closeAllConnections()
        await closed
      }
    }
    this.server = undefined
    this.startedAt = undefined
    this.activeRequests = 0
    this.scheduler.clear()
  }

  getStatus(): GatewayStatus {
    return {
      running: this.server !== undefined,
      host: this.config.settings.host,
      port: this.config.settings.port,
      startedAt: this.startedAt,
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      successRequests: this.successRequests
    }
  }

  updateConfig(config: GatewayConfig): void {
    this.config = config
    this.scheduler.hydrate(config.accounts)
    this.scheduler.hydratePerformance(config.recentRequestLogs ?? [])
  }

  resetAccountHealth(accountId: string): void {
    this.scheduler.recordSuccess(accountId)
  }

  getAccountFitness(): ReturnType<PoolScheduler['getFitness']> {
    const smartAccountIds = new Set(this.config.pools
      .filter((pool) => pool.strategy === 'autobalanced')
      .flatMap((pool) => pool.members.filter((member) => member.enabled).map((member) => member.accountId)))
    return this.scheduler.getFitness(this.config.accounts.filter((account) => smartAccountIds.has(account.id)))
  }

  onLog(listener: GatewayLogHandler): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onAccountState(listener: GatewayAccountStateHandler): () => void {
    this.accountStateListeners.add(listener)
    return () => this.accountStateListeners.delete(listener)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.socket.setNoDelay(true)
    const started = this.now()
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const modelListKind = request.method === 'GET' ? classifyModelListRoute(pathname) : undefined
    if (modelListKind) {
      this.handleModelList(request, response, modelListKind)
      return
    }
    const incoming = request.method === 'POST' ? classifyIncomingRoute(pathname) : undefined
    if (!incoming) {
      this.writeJson(response, 404, { error: { message: 'Route not found', type: 'not_found_error' } })
      return
    }

    this.totalRequests += 1
    this.activeRequests += 1
    const clientAbortController = new AbortController()
    const abortForClientDisconnect = (): void => {
      if (!clientAbortController.signal.aborted && !response.writableEnded) {
        clientAbortController.abort(new DOMException('Client disconnected', 'AbortError'))
      }
    }
    request.once('aborted', abortForClientDisconnect)
    response.once('close', abortForClientDisconnect)
    let selectedAccount: Account | undefined
    let logRoute: Route | undefined
    let model = ''
    let failoverCount = 0
    let conversationId: string | undefined
    let conversationName: string | undefined
    let firstTokenAt: number | undefined
    let bodyReadMs: number | undefined
    let schedulerSelectMs: number | undefined
    let credentialResolveMs: number | undefined
    let outboundFetchStartMs: number | undefined
    let upstreamHeadersAt: number | undefined
    let upstreamFirstByteAt: number | undefined
    let clientFirstWriteAt: number | undefined
    let successfulAttemptStarted: number | undefined
    const markFirstToken = (): void => {
      firstTokenAt ??= this.now()
    }
    const markUpstreamFirstByte = (): void => {
      upstreamFirstByteAt ??= this.now()
    }
    const markClientFirstWrite = (): void => {
      clientFirstWriteAt ??= this.now()
    }
    const phaseTimings = () => ({
      bodyReadMs,
      schedulerSelectMs,
      credentialResolveMs,
      outboundFetchStartMs
    })
    try {
      logRoute = this.authenticate(request, incoming.protocol)
      const body = await readJsonBody(request)
      bodyReadMs = Math.max(0, this.now() - started)
      model = getRequestModel(incoming.protocol, body, pathname)
      if (!model) throw new GatewayHttpError(400, 'A model is required')
      const codexSearch = incoming.operation === 'codex-search'
      if (codexSearch && (typeof body.id !== 'string' || !body.id.trim())) {
        throw new GatewayHttpError(400, 'A search session id is required')
      }

      const pool = this.config.pools.find((candidate) => candidate.id === logRoute?.poolId)
      if (!pool) throw new GatewayHttpError(503, 'The matched route has no available pool')
      const providerAccounts = this.config.accounts.filter((account) =>
        pool.members.some((member) => member.accountId === account.id && member.enabled)
      )
      const sessionId = getSessionId(request, body)
      conversationId = sessionId
      conversationName = getConversationName(request, body)
      const resolveConversationNameForLog = async (): Promise<string | undefined> => {
        conversationName ??= await this.resolveConversationName(sessionId)
        return conversationName
      }
      const targetModel = logRoute.modelMap[model] ?? model
      const streaming = !codexSearch && (body.stream === true || incoming.geminiMethod === 'streamGenerateContent')
      const responsesLite = incoming.protocol === 'openai-responses' && isChatGptCodexResponsesLiteBody(body)
      const schedulingPool = sessionId && (codexSearch || responsesLite)
        ? { ...pool, stickySessions: true }
        : pool
      const retryLimit = Number.isFinite(pool.maxRetries) ? Math.max(0, Math.floor(pool.maxRetries)) : 0
      let lastRetryableError: GatewayHttpError | undefined

      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        let release: (() => void) | undefined
        let attemptedAccount: Account | undefined
        const attemptStarted = this.now()
        firstTokenAt = undefined
        schedulerSelectMs = undefined
        credentialResolveMs = undefined
        outboundFetchStartMs = undefined
        upstreamHeadersAt = undefined
        upstreamFirstByteAt = undefined
        clientFirstWriteAt = undefined
        successfulAttemptStarted = attemptStarted
        try {
          let scheduled
          const schedulerSelectStarted = this.now()
          try {
            scheduled = this.scheduler.selectAndAcquire({
              pool: schedulingPool,
              accounts: providerAccounts,
              model: targetModel,
              sessionId
            })
          } catch (error) {
            if (error instanceof NoEligibleAccountError && lastRetryableError) throw lastRetryableError
            throw error
          } finally {
            schedulerSelectMs = Math.max(0, this.now() - schedulerSelectStarted)
          }
          const account = scheduled.account
          attemptedAccount = account
          selectedAccount = account
          release = scheduled.release

          const provider = this.config.providers.find((candidate) => candidate.id === account.providerId)
          if (!provider) throw new GatewayHttpError(503, 'The selected account has no provider', 'account_unavailable')
          const adapter = getProviderAdapter(provider.kind)
          if (codexSearch && provider.protocol !== 'openai-responses') {
            throw new GatewayHttpError(400, 'Standalone web search requires an OpenAI Responses provider', 'unsupported_conversion')
          }
          const convertedBody = codexSearch
            ? { ...body, model: targetModel }
            : convertRequest(incoming.protocol, provider.protocol, body, targetModel).body
          const outboundFetch = this.outboundFetchResolver?.(account, pool) ?? this.fetchImplementation
          const credentialResolveStarted = this.now()
          let resolvedValue: Awaited<ReturnType<CredentialResolver>>
          try {
            resolvedValue = await this.credentialResolver(account, outboundFetch, clientAbortController.signal)
          } finally {
            credentialResolveMs = Math.max(0, this.now() - credentialResolveStarted)
          }
          if (!resolvedValue) {
            throw new GatewayHttpError(503, 'The selected account credential is unavailable', 'account_unavailable')
          }
          const resolvedCredential = typeof resolvedValue === 'string'
            ? { secret: resolvedValue, kind: 'api-key' as const }
            : resolvedValue
          const credential = resolvedCredential.secret

          const upstreamHeaders = new Headers()
          if (resolvedCredential.kind === 'chatgpt-oauth') {
            if (provider.protocol !== 'openai-responses' || !resolvedCredential.accountId) {
              throw new GatewayHttpError(503, 'ChatGPT account requires an OpenAI Responses provider', 'account_unavailable')
            }
            const credentialBundle = {
              accessToken: credential,
              accountId: resolvedCredential.accountId,
              expiresAt: account.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER
            }
            if (codexSearch) {
              applyChatGptCodexSearchHeaders(upstreamHeaders, credentialBundle, request.headers)
            } else {
              applyChatGptCodexHeaders(upstreamHeaders, credentialBundle, request.headers)
            }
            if (sessionId && !upstreamHeaders.has('session-id')) upstreamHeaders.set('session-id', sessionId)
          } else {
            adapter.applyRequestHeaders(upstreamHeaders, {
              protocol: provider.protocol,
              credential,
              sourceHeaders: request.headers,
              stream: streaming,
              hasBody: true
            })
          }
          const outboundBody = codexSearch
            ? convertedBody
            : withStreamingFlag(convertedBody, provider.protocol, streaming)
          const tieredOutboundBody = !codexSearch && provider.protocol === 'openai-responses'
            ? normalizeOpenAIServiceTier(outboundBody, pool.forceFastMode === true)
            : outboundBody
          const upstreamBody = resolvedCredential.kind === 'chatgpt-oauth' && !codexSearch
            ? withChatGptCodexBody(tieredOutboundBody)
            : tieredOutboundBody
          let upstreamResponse: Response
          try {
            const upstreamUrl = resolvedCredential.kind === 'chatgpt-oauth'
              ? codexSearch ? CHATGPT_CODEX_SEARCH_URL : CHATGPT_CODEX_RESPONSES_URL
              : adapter.buildEndpoint({
                baseUrl: provider.baseUrl,
                protocol: provider.protocol,
                operation: codexSearch ? 'search' : 'generate',
                model: targetModel,
                stream: streaming
              })
            const upstreamInit: RequestInit = {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.any([
                clientAbortController.signal,
                AbortSignal.timeout(Math.max(1, this.config.settings.requestTimeoutSeconds) * 1000)
              ])
            }
            outboundFetchStartMs = Math.max(0, this.now() - started)
            upstreamResponse = await fetchWithOptionalHedge(
              outboundFetch,
              upstreamUrl,
              upstreamInit,
              streaming && !codexSearch && pool.hedgedRequests === true
                ? Math.max(250, Math.min(15_000, pool.hedgeDelayMs ?? 2_500))
                : undefined
            )
            upstreamHeadersAt = this.now()
          } catch (error) {
            throw gatewayErrorFromProviderFailure(adapter.classifyFailure({ error, now: this.now() }))
          }

          const headerSignals = extractRateLimitSignals(
            upstreamResponse.headers,
            provider.protocol,
            this.now()
          )

          if (!upstreamResponse.ok) {
            const payload = await readUpstreamJson(upstreamResponse)
            const safePayload = sanitizeUpstreamPayload(payload, sensitiveValues(resolvedCredential))
            const providerFailure = resolvedCredential.kind === 'chatgpt-oauth'
              ? classifyChatGptCodexFailure(upstreamResponse.status, upstreamResponse.headers, this.now())
              : adapter.classifyFailure({
                  statusCode: upstreamResponse.status,
                  headers: upstreamResponse.headers,
                  now: this.now()
                })
            throw new GatewayHttpError(
              upstreamResponse.status,
              resolvedCredential.kind === 'chatgpt-oauth' ? providerFailure.message : upstreamErrorMessage(safePayload),
              `provider_${providerFailure.category}`,
              resolvedCredential.kind === 'chatgpt-oauth'
                ? { error: { message: providerFailure.message, type: `provider_${providerFailure.category}` } }
                : safePayload,
              providerFailure,
              observedQuotaSignals(headerSignals, this.now())
            )
          }

          if (codexSearch) {
            const payload = sanitizeUpstreamPayload(
              await readUpstreamJson(upstreamResponse),
              sensitiveValues(resolvedCredential)
            )
            markFirstToken()
            markClientFirstWrite()
            this.writeJson(response, upstreamResponse.status, payload)
            const completedAt = this.now()
            this.reportAccountSuccess(account, attemptStarted, headerSignals)
            release?.()
            release = undefined
            this.successRequests += 1
            await resolveConversationNameForLog()
            const log = this.makeLog({
              route: logRoute,
              account,
              model,
              started,
              finished: completedAt,
              conversationId,
              conversationName,
              firstTokenAt,
              status: 'success',
              statusCode: upstreamResponse.status,
              failoverCount,
              ...phaseTimings(),
              upstreamHeadersAt,
              upstreamFirstByteAt,
              clientFirstWriteAt,
              accountFirstTokenMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - attemptStarted)
            })
            this.emitLog(log)
            return
          }

          if (streaming) {
            const streamTiming = {
              firstBodyTimeoutMs: Math.min(MAX_FIRST_BODY_TIMEOUT_MS, Math.max(
                MIN_FIRST_BODY_TIMEOUT_MS,
                pool.firstBodyTimeoutMs ?? Math.floor(this.config.settings.requestTimeoutSeconds * 250)
              )),
              onFirstByte: markUpstreamFirstByte,
              onFirstToken: markFirstToken,
              onClientWrite: markClientFirstWrite
            }
            const streamResult = incoming.protocol === provider.protocol
              ? await pipeUpstreamResponse(upstreamResponse, response, provider.protocol, sensitiveValues(resolvedCredential), streamTiming)
              : await pipeConvertedUpstreamResponse(
                upstreamResponse,
                response,
                provider.protocol,
                incoming.protocol,
                { id: randomUUID(), model },
                sensitiveValues(resolvedCredential),
                streamTiming
              )
            if (!streamResult.completed) {
              throw gatewayErrorFromProviderFailure(adapter.classifyFailure({
                error: new DOMException('Client disconnected', 'AbortError'),
                now: this.now()
              }))
            }
            if (streamResult.error) {
              throw new GatewayHttpError(502, streamResult.error, 'upstream_stream_error')
            }
            const completedAt = this.now()
            this.reportAccountSuccess(account, attemptStarted, headerSignals)
            release?.()
            release = undefined
            this.successRequests += 1
            await resolveConversationNameForLog()
            const log = this.makeLog({
              route: logRoute,
              account,
              model,
              started,
              finished: completedAt,
              conversationId,
              conversationName,
              firstTokenAt,
              status: 'success',
              statusCode: upstreamResponse.status,
              usage: normalizeLogUsage(streamResult.usage),
              failoverCount,
              ...phaseTimings(),
              upstreamHeadersAt,
              upstreamFirstByteAt,
              clientFirstWriteAt,
              accountFirstTokenMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - attemptStarted)
            })
            this.recordAccountPerformance(log)
            this.emitLog(log)
            return
          }

          let payload: JsonObject
          if (resolvedCredential.kind === 'chatgpt-oauth') {
            const streamResult = await collectOpenAiResponsesUpstream(
              upstreamResponse,
              { id: randomUUID(), model, now: this.now }
            )
            if (streamResult.error || !streamResult.response) {
              throw new GatewayHttpError(
                502,
                redactSensitiveText(streamResult.error ?? 'Upstream Responses stream did not produce a response', sensitiveValues(resolvedCredential)),
                'upstream_stream_error'
              )
            }
            payload = streamResult.response
          } else {
            payload = await readUpstreamJson(upstreamResponse)
          }
          const result = convertResponse(provider.protocol, incoming.protocol, payload, model, this.now)
          const usage = extractProtocolUsage(provider.protocol, payload)
          markFirstToken()
          markClientFirstWrite()
          this.writeJson(response, 200, result)
          const completedAt = this.now()
          this.reportAccountSuccess(account, attemptStarted, headerSignals)
          release?.()
          release = undefined
          this.successRequests += 1
          await resolveConversationNameForLog()
          const log = this.makeLog({
            route: logRoute, account, model, started, finished: completedAt, conversationId, conversationName,
            firstTokenAt, status: 'success', statusCode: 200, usage, failoverCount,
            ...phaseTimings(),
            upstreamHeadersAt, upstreamFirstByteAt, clientFirstWriteAt,
            accountFirstTokenMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - attemptStarted)
          })
          this.recordAccountPerformance(log)
          this.emitLog(log)
          return
        } catch (error) {
          if (clientAbortController.signal.aborted) {
            throw new GatewayHttpError(499, 'Client closed the request', 'client_closed')
          }
          const gatewayError = normalizeError(error)
          const retryable = isRetryable(gatewayError)
          const accountAction = gatewayError.providerFailure?.accountAction
          if (attemptedAccount && (retryable || accountAction === 'disable' || accountAction === 'cooldown')) {
            const failureNow = this.now()
            const actualResetAt = quotaSignalCooldownUntil(gatewayError.quotaSignals, failureNow)
            const retryAfterMs = Math.max(
              gatewayError.providerFailure?.retryAfterMs ?? 0,
              actualResetAt === undefined ? 0 : Math.max(0, actualResetAt - failureNow)
            )
            const health = this.scheduler.recordFailure(attemptedAccount.id, {
              retryAfterMs,
              maxConcurrency: attemptedAccount.maxConcurrency
            })
            this.emitAccountState({
              accountId: attemptedAccount.id,
              status: accountAction === 'disable' ? 'disabled' : 'cooldown',
              circuitState: health.circuitState,
              consecutiveFailures: health.consecutiveFailures,
              cooldownUntil: accountAction === 'disable' ? undefined : health.cooldownUntil,
              cooldownReason: accountAction === 'disable'
                ? undefined
                : gatewayError.providerFailure?.category === 'rate_limit' ? 'quota' : 'failure',
              lastError: gatewayError.message,
              lastUsedAt: this.now(),
              ...gatewayError.quotaSignals
            })
          }
          const canRetry = attempt < retryLimit && !response.headersSent && retryable
          if (!canRetry) throw gatewayError
          lastRetryableError = gatewayError
          failoverCount += 1
        } finally {
          release?.()
        }
      }
    } catch (error) {
      const gatewayError = clientAbortController.signal.aborted
        ? new GatewayHttpError(499, 'Client closed the request', 'client_closed')
        : normalizeError(error)
      this.writeJson(
        response,
        gatewayError.statusCode,
        gatewayError.responseBody ?? { error: { message: gatewayError.message, type: gatewayError.type } }
      )
      if (logRoute && selectedAccount) {
        conversationName ??= await this.resolveConversationName(conversationId)
        this.emitLog(this.makeLog({
          route: logRoute, account: selectedAccount, model, started, conversationId, conversationName, firstTokenAt,
          status: 'error', statusCode: gatewayError.statusCode, error: gatewayError.message, failoverCount,
          ...phaseTimings(),
          upstreamHeadersAt, upstreamFirstByteAt, clientFirstWriteAt,
          accountFirstTokenMs: firstTokenAt === undefined || successfulAttemptStarted === undefined
            ? undefined : Math.max(0, firstTokenAt - successfulAttemptStarted)
        }))
      }
    } finally {
      request.off('aborted', abortForClientDisconnect)
      response.off('close', abortForClientDisconnect)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
  }

  private authenticate(request: IncomingMessage, protocol: Protocol): Route {
    const token = readLocalToken(request)
    if (!token) throw new GatewayHttpError(401, 'A local gateway token is required', 'authentication_error')
    const route = this.config.routes.find((candidate) =>
      candidate.enabled && candidate.inboundProtocol === protocol && secureEquals(candidate.localToken, token)
    )
    if (!route) throw new GatewayHttpError(401, 'Invalid local gateway token', 'authentication_error')
    return route
  }

  private async resolveConversationName(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return undefined
    try {
      const resolved = normalizeConversationName(await this.conversationTitleResolver?.(sessionId))
      if (resolved) return resolved
    } catch {
      // Missing, locked, or foreign Codex title data must never affect routing.
    }
    return fallbackConversationName(sessionId)
  }

  private handleModelList(
    request: IncomingMessage,
    response: ServerResponse,
    kind: 'openai' | 'gemini'
  ): void {
    try {
      const route = this.authenticateModelList(request, kind)
      const pool = this.config.pools.find((candidate) => candidate.id === route.poolId)
      if (!pool) throw new GatewayHttpError(503, 'The matched route has no available pool')
      const accounts = this.config.accounts.filter((account) =>
        pool.members.some((member) => member.accountId === account.id && member.enabled)
      )
      const models = projectRouteModels(
        enumerablePoolModels(pool, accounts, this.config.providers),
        route.modelMap
      )
      response.setHeader('cache-control', 'no-store')
      this.writeJson(
        response,
        200,
        kind === 'gemini'
          ? geminiModelList(models)
          : route.inboundProtocol === 'anthropic-messages'
            ? anthropicModelList(models, pool.updatedAt)
            : openAiModelList(models, pool.updatedAt)
      )
    } catch (error) {
      const gatewayError = normalizeError(error)
      this.writeJson(
        response,
        gatewayError.statusCode,
        gatewayError.responseBody ?? { error: { message: gatewayError.message, type: gatewayError.type } }
      )
    }
  }

  private authenticateModelList(request: IncomingMessage, kind: 'openai' | 'gemini'): Route {
    const token = readLocalToken(request)
    if (!token) throw new GatewayHttpError(401, 'A local gateway token is required', 'authentication_error')
    const route = this.config.routes.find((candidate) =>
      candidate.enabled &&
      (kind === 'gemini' ? candidate.inboundProtocol === 'gemini' : candidate.inboundProtocol !== 'gemini') &&
      secureEquals(candidate.localToken, token)
    )
    if (!route) throw new GatewayHttpError(401, 'Invalid local gateway token', 'authentication_error')
    return route
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: JsonObject): void {
    if (response.writableEnded || response.destroyed) return
    if (response.headersSent) {
      response.end()
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    response.statusCode = statusCode
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('content-length', body.byteLength)
    response.end(body)
  }

  private makeLog(input: {
    route: Route
    account: Account
    model: string
    started: number
    finished?: number
    conversationId?: string
    conversationName?: string
    firstTokenAt?: number
    bodyReadMs?: number
    schedulerSelectMs?: number
    credentialResolveMs?: number
    outboundFetchStartMs?: number
    upstreamHeadersAt?: number
    upstreamFirstByteAt?: number
    clientFirstWriteAt?: number
    accountFirstTokenMs?: number
    status: RequestLog['status']
    statusCode?: number
    error?: string
    usage?: NormalizedTokenUsage
    failoverCount?: number
  }): RequestLog {
    const providerName = this.config.providers.find((provider) => provider.id === input.account.providerId)?.name ?? 'Unknown provider'
    const usage = input.usage
    const finished = input.finished ?? this.now()
    return {
      id: randomUUID(),
      accountId: input.account.id,
      conversationId: input.conversationId,
      conversationName: input.conversationName,
      timestamp: finished,
      client: input.route.client,
      protocol: input.route.inboundProtocol,
      providerName,
      accountName: input.account.name,
      model: input.model,
      status: input.status,
      statusCode: input.statusCode,
      latencyMs: Math.max(0, finished - input.started),
      bodyReadMs: input.bodyReadMs,
      schedulerSelectMs: input.schedulerSelectMs,
      credentialResolveMs: input.credentialResolveMs,
      outboundFetchStartMs: input.outboundFetchStartMs,
      upstreamHeadersMs: input.upstreamHeadersAt === undefined ? undefined : Math.max(0, input.upstreamHeadersAt - input.started),
      upstreamFirstByteMs: input.upstreamFirstByteAt === undefined ? undefined : Math.max(0, input.upstreamFirstByteAt - input.started),
      clientFirstWriteMs: input.clientFirstWriteAt === undefined ? undefined : Math.max(0, input.clientFirstWriteAt - input.started),
      accountFirstTokenMs: input.accountFirstTokenMs,
      firstTokenMs: input.firstTokenAt === undefined ? undefined : Math.max(0, input.firstTokenAt - input.started),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
      failoverCount: input.failoverCount,
      error: input.error
    }
  }

  private emitLog(log: RequestLog): void {
    for (const listener of this.logListeners) listener(log)
  }

  private recordAccountPerformance(log: RequestLog): void {
    if (log.status !== 'success' || !log.accountId || log.upstreamFirstByteMs === undefined) return
    const previousAttemptsMs = log.firstTokenMs !== undefined && log.accountFirstTokenMs !== undefined
      ? Math.max(0, log.firstTokenMs - log.accountFirstTokenMs)
      : 0
    const accountFirstByteMs = Math.max(0, log.upstreamFirstByteMs - previousAttemptsMs)
    if (accountFirstByteMs <= 0) return
    const generationStartedMs = log.upstreamFirstByteMs
      ?? log.clientFirstWriteMs
      ?? log.firstTokenMs
      ?? accountFirstByteMs
    this.scheduler.recordPerformance(log.accountId, {
      firstTokenMs: accountFirstByteMs,
      outputTokens: log.outputTokens,
      generationDurationMs: Math.max(0, log.latencyMs - generationStartedMs)
    })
  }

  private reportAccountSuccess(account: Account, attemptStarted: number, signals?: NormalizedQuotaSignals): void {
    const now = this.now()
    const quota = observedQuotaSignals(signals, now)
    const actualResetAt = quotaSignalCooldownUntil(quota, now)
    const quotaExhausted = codexQuotaIsExhausted(quota.codexQuota, now)
      || genericQuotaExhausted(quota.quota, now)
    if (quotaExhausted && actualResetAt !== undefined) this.scheduler.setCooldown(account.id, actualResetAt)
    const health = quotaExhausted && actualResetAt !== undefined
      ? this.scheduler.getHealth(account.id)
      : this.scheduler.recordSuccess(account.id)
    this.emitAccountState({
      accountId: account.id,
      status: quotaExhausted && actualResetAt !== undefined ? 'cooldown' : 'active',
      circuitState: health.circuitState,
      consecutiveFailures: health.consecutiveFailures,
      cooldownUntil: quotaExhausted ? actualResetAt : undefined,
      cooldownReason: quotaExhausted ? 'quota' : undefined,
      latencyMs: Math.max(0, now - attemptStarted),
      lastError: undefined,
      lastUsedAt: now,
      ...quota
    })
  }

  private emitAccountState(state: GatewayAccountState): void {
    for (const listener of this.accountStateListeners) listener(state)
  }
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
  return new GatewayServer(options)
}

class GatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly type = 'invalid_request_error',
    readonly responseBody?: JsonObject,
    readonly providerFailure?: ProviderFailure,
    readonly quotaSignals?: {
      quota?: AccountQuotaSnapshot
      codexQuota?: AccountCodexQuotaSnapshot
    }
  ) {
    super(message)
    this.name = 'GatewayHttpError'
  }
}

function classifyIncomingRoute(pathname: string): IncomingRoute | undefined {
  if (pathname === '/v1/messages') return { protocol: 'anthropic-messages', operation: 'generate' }
  if (pathname === '/v1/responses') return { protocol: 'openai-responses', operation: 'generate' }
  if (pathname === '/v1/alpha/search') return { protocol: 'openai-responses', operation: 'codex-search' }
  if (pathname === '/v1/chat/completions') return { protocol: 'openai-chat', operation: 'generate' }
  if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(pathname)) {
    return { protocol: 'gemini', operation: 'generate', geminiMethod: 'generateContent' }
  }
  if (/^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(pathname)) {
    return { protocol: 'gemini', operation: 'generate', geminiMethod: 'streamGenerateContent' }
  }
  return undefined
}

function classifyModelListRoute(pathname: string): 'openai' | 'gemini' | undefined {
  if (pathname === '/v1/models') return 'openai'
  if (pathname === '/v1beta/models') return 'gemini'
  return undefined
}

function enumerablePoolModels(
  pool: Pool,
  accounts: Account[],
  providers: ProviderDefinition[]
): string[] {
  const availableModels = uniqueModels(accounts.flatMap((account) => {
    if (account.modelPolicy === 'selected') return account.modelAllowlist
    if (account.modelsRefreshedAt !== undefined) return account.availableModels
    return providers.find((provider) => provider.id === account.providerId)?.models ?? []
  }))
  if (pool.modelPolicy !== 'selected') return availableModels
  const available = new Set(availableModels)
  return uniqueModels(pool.modelAllowlist.filter((model) => available.has(model)))
}

function projectRouteModels(models: string[], modelMap: Record<string, string>): string[] {
  const aliasesByTarget = new Map<string, string[]>()
  for (const [source, target] of Object.entries(modelMap)) {
    const aliases = aliasesByTarget.get(target) ?? []
    aliases.push(source)
    aliasesByTarget.set(target, aliases)
  }
  return uniqueModels(models.flatMap((model) => [model, ...(aliasesByTarget.get(model) ?? [])]))
}

function openAiModelList(models: string[], updatedAt: number): JsonObject {
  const created = Math.max(0, Math.floor((Number.isFinite(updatedAt) ? updatedAt : 0) / 1000))
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created, owned_by: 'stone' }))
  }
}

function anthropicModelList(models: string[], updatedAt: number): JsonObject {
  const createdAt = new Date(Number.isFinite(updatedAt) ? updatedAt : 0).toISOString()
  return {
    data: models.map((id) => ({ type: 'model', id, display_name: id, created_at: createdAt })),
    has_more: false,
    first_id: models[0] ?? null,
    last_id: models.at(-1) ?? null
  }
}

function geminiModelList(models: string[]): JsonObject {
  return {
    models: models.map((id) => ({
      name: `models/${id}`,
      baseModelId: id,
      version: '001',
      displayName: id,
      supportedGenerationMethods: ['generateContent']
    }))
  }
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4 && octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 10 * 1024 * 1024) throw new GatewayHttpError(413, 'Request body exceeds 10 MiB')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) throw new GatewayHttpError(400, 'A JSON request body is required')
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!objectValue(parsed)) throw new Error('not an object')
    return parsed as JsonObject
  } catch {
    throw new GatewayHttpError(400, 'Invalid JSON request body')
  }
}

function withStreamingFlag(body: JsonObject, protocol: Protocol, streaming: boolean): JsonObject {
  if (!streaming || protocol === 'gemini') return body
  return { ...body, stream: true }
}

async function readUpstreamJson(response: Response): Promise<JsonObject> {
  const text = await response.text()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return objectValue(parsed) ?? { error: { message: 'Upstream returned a non-object JSON response' } }
  } catch {
    return { error: { message: 'Upstream returned a non-JSON response' }, raw: text.slice(0, 2000) }
  }
}

async function collectOpenAiResponsesUpstream(
  upstream: Response,
  options: StreamEncodingOptions
): Promise<ReturnType<ReturnType<typeof createOpenAiResponsesStreamCollector>['finish']>> {
  const collector = createOpenAiResponsesStreamCollector(options)
  if (!upstream.body) return collector.finish()
  const reader = upstream.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    collector.push(value)
  }
  return collector.finish()
}

async function fetchWithOptionalHedge(
  fetchImplementation: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  hedgeDelayMs?: number
): Promise<Response> {
  if (hedgeDelayMs === undefined) return fetchImplementation(input, init)
  const start = (controller: AbortController) => fetchImplementation(input, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
  })
  const primaryController = new AbortController()
  const primary = start(primaryController)
  const first = await Promise.race([
    primary.then((response) => ({ kind: 'response' as const, response })),
    new Promise<{ kind: 'delay' }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'delay' }), hedgeDelayMs)
      void primary.finally(() => clearTimeout(timer)).catch(() => undefined)
    })
  ])
  if (first.kind === 'response') return first.response

  const secondaryController = new AbortController()
  const secondary = start(secondaryController)
  type Outcome = { source: 'primary' | 'secondary'; response?: Response; error?: unknown }
  const outcome = (source: Outcome['source'], promise: Promise<Response>): Promise<Outcome> => promise.then(
    (response) => ({ source, response }),
    (error) => ({ source, error })
  )
  const primaryOutcome = outcome('primary', primary)
  const secondaryOutcome = outcome('secondary', secondary)
  const firstOutcome = await Promise.race([primaryOutcome, secondaryOutcome])
  let winner = firstOutcome
  if (!winner.response) {
    const other = await (winner.source === 'primary' ? secondaryOutcome : primaryOutcome)
    winner = other
  } else if (!winner.response.ok) {
    // Give the other lane only a short grace window to replace a fast 429/5xx;
    // never turn a quick upstream error into a full request-timeout wait.
    const other = await settleWithin(
      winner.source === 'primary' ? secondaryOutcome : primaryOutcome,
      HEDGE_ERROR_GRACE_MS
    )
    if (other?.response?.ok) winner = other
  }
  if (!winner.response) throw winner.error

  const loserController = winner.source === 'primary' ? secondaryController : primaryController
  const loserOutcome = winner.source === 'primary' ? secondaryOutcome : primaryOutcome
  loserController.abort(new DOMException('Hedged request lost the response race', 'AbortError'))
  void loserOutcome.then(async (loser) => {
    await loser.response?.body?.cancel().catch(() => undefined)
  })
  return winner.response
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface StreamPipeResult {
  completed: boolean
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    cached_input_tokens?: number
    reasoning_tokens?: number
  }
  error?: string
}

interface StreamTimingCallbacks {
  firstBodyTimeoutMs: number
  onFirstByte?: () => void
  onFirstToken?: () => void
  onClientWrite?: () => void
}

async function pipeUpstreamResponse(
  upstream: Response,
  response: ServerResponse,
  protocol: Protocol,
  secrets: readonly string[],
  timing: StreamTimingCallbacks
): Promise<StreamPipeResult> {
  const parser = createCanonicalStreamParser(protocol)
  const redactor = new StreamingSecretRedactor(secrets)
  if (!upstream.body) {
    throw new GatewayHttpError(502, 'Upstream stream ended before its first body chunk', 'upstream_stream_error')
  }
  const reader = upstream.body.getReader()
  const usage: NonNullable<StreamPipeResult['usage']> = {}
  let streamError: string | undefined
  let terminalObserved = false
  let completedToolCallObserved = false
  let completedMessageObserved = false
  const pendingToolCalls = new Set<number>()
  const logicalCompletionObserved = (): boolean => (
    terminalObserved
    || ((completedMessageObserved || completedToolCallObserved) && pendingToolCalls.size === 0)
  )
  let observationFailed = false
  const observe = (events: CanonicalStreamEvent[], acceptTerminal: boolean): void => {
    for (const event of events) {
      if (event.type === 'usage') {
        if (event.inputTokens !== undefined) usage.input_tokens = event.inputTokens
        if (event.outputTokens !== undefined) usage.output_tokens = event.outputTokens
        if (event.totalTokens !== undefined) usage.total_tokens = event.totalTokens
        if (event.cachedInputTokens !== undefined) usage.cached_input_tokens = event.cachedInputTokens
        if (event.reasoningTokens !== undefined) usage.reasoning_tokens = event.reasoningTokens
      } else if (event.type === 'error') {
        streamError = redactSensitiveText(event.message, secrets)
      } else if (event.type === 'tool-call-delta') {
        pendingToolCalls.add(event.index)
      } else if (acceptTerminal && event.type === 'tool-call-complete') {
        completedToolCallObserved = true
        pendingToolCalls.delete(event.index)
      } else if (acceptTerminal && event.type === 'message-complete') {
        completedMessageObserved = true
      } else if (acceptTerminal && (
        event.type === 'done' || (event.type === 'stop' && event.reason === 'tool_calls')
      )) {
        terminalObserved = true
      }
      if (meaningfulStreamEvent(event)) timing.onFirstToken?.()
    }
  }
  const observeSafely = (operation: () => CanonicalStreamEvent[], acceptTerminal = true): void => {
    if (observationFailed) return
    try {
      observe(operation(), acceptTerminal)
    } catch (error) {
      observationFailed = true
      streamError = error instanceof Error ? error.message : 'Unable to inspect upstream stream'
    }
  }
  const cancelOnClose = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  response.once('close', cancelOnClose)
  try {
    const first = await readFirstStreamChunk(reader, timing.firstBodyTimeoutMs)
    if (first.done || !first.value?.byteLength) {
      throw new GatewayHttpError(502, 'Upstream stream ended before its first body chunk', 'upstream_stream_error')
    }
    timing.onFirstByte?.()
    response.statusCode = upstream.status
    response.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-cache')
    response.setHeader('x-accel-buffering', upstream.headers.get('x-accel-buffering') ?? 'no')
    response.flushHeaders()
    const consume = async (value: Uint8Array): Promise<boolean> => {
      const events = parser.push(value)
      observeSafely(() => events)
      if (response.destroyed) return false
      for (const chunk of redactor.push(value)) {
        if (chunk.byteLength > 0) timing.onClientWrite?.()
        if (!response.write(chunk)) await waitForDrain(response)
      }
      return !response.destroyed
    }
    if (!await consume(first.value)) {
      await reader.cancel()
      return streamPipeResult(logicalCompletionObserved(), usage, streamError)
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!await consume(value)) {
        await reader.cancel()
        return streamPipeResult(logicalCompletionObserved(), usage, streamError)
      }
    }
    if (response.destroyed && logicalCompletionObserved()) {
      return streamPipeResult(true, usage, streamError)
    }
    for (const chunk of redactor.finish()) {
      if (chunk.byteLength > 0) timing.onClientWrite?.()
      if (!response.write(chunk)) await waitForDrain(response)
    }
    observeSafely(() => parser.finish(), false)
  } catch (error) {
    if (response.destroyed && logicalCompletionObserved()) {
      return streamPipeResult(true, usage, streamError)
    }
    throw error
  } finally {
    response.off('close', cancelOnClose)
    if (response.headersSent && !response.writableEnded && !response.destroyed) response.end()
  }
  return streamPipeResult(logicalCompletionObserved() || !response.destroyed, usage, streamError)
}

async function pipeConvertedUpstreamResponse(
  upstream: Response,
  response: ServerResponse,
  from: Protocol,
  to: Protocol,
  options: StreamEncodingOptions,
  secrets: readonly string[],
  timing: StreamTimingCallbacks
): Promise<StreamPipeResult> {
  const parser = createCanonicalStreamParser(from)
  const encoder = createCanonicalStreamEncoder(to, options)
  if (!upstream.body) {
    throw new GatewayHttpError(502, 'Upstream stream ended before its first body chunk', 'upstream_stream_error')
  }
  const reader = upstream.body.getReader()
  const usage: NonNullable<StreamPipeResult['usage']> = {}
  let streamError: string | undefined
  let terminalObserved = false
  let completedToolCallObserved = false
  let completedMessageObserved = false
  const pendingToolCalls = new Set<number>()
  const logicalCompletionObserved = (): boolean => (
    terminalObserved
    || ((completedMessageObserved || completedToolCallObserved) && pendingToolCalls.size === 0)
  )
  const cancelOnClose = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  const forward = async (events: CanonicalStreamEvent[], acceptTerminal = true): Promise<boolean> => {
    for (const event of events) {
      const safeEvent = event.type === 'error'
        ? {
            ...event,
            message: redactSensitiveText(event.message, secrets),
            code: event.code ? redactSensitiveText(event.code, secrets) : undefined,
            errorType: event.errorType ? redactSensitiveText(event.errorType, secrets) : undefined
          }
        : event
      if (safeEvent.type === 'usage') {
        if (safeEvent.inputTokens !== undefined) usage.input_tokens = safeEvent.inputTokens
        if (safeEvent.outputTokens !== undefined) usage.output_tokens = safeEvent.outputTokens
        if (safeEvent.totalTokens !== undefined) usage.total_tokens = safeEvent.totalTokens
        if (safeEvent.cachedInputTokens !== undefined) usage.cached_input_tokens = safeEvent.cachedInputTokens
        if (safeEvent.reasoningTokens !== undefined) usage.reasoning_tokens = safeEvent.reasoningTokens
      } else if (safeEvent.type === 'error') {
        streamError = safeEvent.message
      } else if (safeEvent.type === 'tool-call-delta') {
        pendingToolCalls.add(safeEvent.index)
      } else if (acceptTerminal && safeEvent.type === 'tool-call-complete') {
        completedToolCallObserved = true
        pendingToolCalls.delete(safeEvent.index)
      } else if (acceptTerminal && safeEvent.type === 'message-complete') {
        completedMessageObserved = true
      } else if (acceptTerminal && (
        safeEvent.type === 'done' || (safeEvent.type === 'stop' && safeEvent.reason === 'tool_calls')
      )) {
        terminalObserved = true
      }
      if (meaningfulStreamEvent(safeEvent)) timing.onFirstToken?.()
      if (!await writeStreamChunks(response, encoder.encode(safeEvent), timing.onClientWrite)) return false
    }
    return true
  }

  response.once('close', cancelOnClose)
  try {
    const first = await readFirstStreamChunk(reader, timing.firstBodyTimeoutMs)
    if (first.done || !first.value?.byteLength) {
      throw new GatewayHttpError(502, 'Upstream stream ended before its first body chunk', 'upstream_stream_error')
    }
    timing.onFirstByte?.()
    response.statusCode = upstream.status
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    if (!await forward(parser.push(first.value))) {
      await reader.cancel()
      return streamPipeResult(logicalCompletionObserved(), usage, streamError)
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!await forward(parser.push(value))) {
        await reader.cancel()
        return streamPipeResult(logicalCompletionObserved(), usage, streamError)
      }
    }
    if (response.destroyed && logicalCompletionObserved()) {
      return streamPipeResult(true, usage, streamError)
    }
    if (!await forward(parser.finish(), false)) return streamPipeResult(logicalCompletionObserved(), usage, streamError)
    if (!await writeStreamChunks(response, encoder.finish(), timing.onClientWrite)) return streamPipeResult(logicalCompletionObserved(), usage, streamError)
  } catch (error) {
    if (response.destroyed) {
      return streamPipeResult(logicalCompletionObserved(), usage, streamError)
    }
    // A failure before headers/body are committed is still eligible for account
    // failover. Do not turn it into an implicit HTTP 200 error stream.
    if (!response.headersSent) throw error
    streamError = error instanceof Error ? error.message : 'Upstream stream failed'
    await forward([
      { type: 'error', message: streamError, errorType: 'upstream_stream_error' },
      { type: 'done' }
    ])
    await writeStreamChunks(response, encoder.finish(), timing.onClientWrite)
  } finally {
    response.off('close', cancelOnClose)
    if (response.headersSent && !response.writableEnded && !response.destroyed) response.end()
  }

  return streamPipeResult(logicalCompletionObserved() || !response.destroyed, usage, streamError)
}

function streamPipeResult(
  completed: boolean,
  usage: NonNullable<StreamPipeResult['usage']>,
  error?: string
): StreamPipeResult {
  return {
    completed,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(error ? { error } : {})
  }
}

async function writeStreamChunks(
  response: ServerResponse,
  chunks: Uint8Array[],
  onClientWrite?: () => void
): Promise<boolean> {
  for (const chunk of chunks) {
    if (response.destroyed) return false
    if (chunk.byteLength > 0) onClientWrite?.()
    if (!response.write(Buffer.from(chunk))) await waitForDrain(response)
    if (response.destroyed) return false
  }
  return true
}

async function readFirstStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new GatewayHttpError(
        504,
        `Upstream stream produced no body within ${timeoutMs} ms`,
        'upstream_first_body_timeout'
      )), timeoutMs)
    })
    for (;;) {
      const result = await Promise.race([reader.read(), timeout])
      if (result.done || (result.value?.byteLength ?? 0) > 0) return result
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function meaningfulStreamEvent(event: CanonicalStreamEvent): boolean {
  return event.type === 'text-delta'
    || event.type === 'tool-call-delta'
    || event.type === 'message-complete'
}

async function waitForDrain(response: ServerResponse): Promise<void> {
  if (response.destroyed) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onClose = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
  })
}

function getSessionId(request: IncomingMessage, body: JsonObject): string | undefined {
  const headerNames = ['x-stone-session-id', 'session-id', 'session_id', 'thread-id'] as const
  for (const name of headerNames) {
    const value = request.headers[name]
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string' && first.trim()) return first.trim()
  }
  const clientMetadata = objectValue(body.client_metadata)
  const metadata = objectValue(body.metadata)
  const candidates = [
    clientMetadata?.session_id,
    clientMetadata?.thread_id,
    metadata?.session_id,
    metadata?.sessionId,
    body.id
  ]
  return candidates.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
}

function getConversationName(request: IncomingMessage, body: JsonObject): string | undefined {
  const headerNames = [
    'x-stone-conversation-name',
    'x-codex-conversation-name',
    'x-conversation-name',
    'conversation-name',
    'x-thread-name'
  ] as const
  for (const name of headerNames) {
    const value = request.headers[name]
    const first = Array.isArray(value) ? value[0] : value
    const normalized = normalizeConversationName(first)
    if (normalized) return normalized
  }
  const clientMetadata = objectValue(body.client_metadata)
  const metadata = objectValue(body.metadata)
  const candidates = [
    clientMetadata?.conversation_name,
    clientMetadata?.conversation_title,
    clientMetadata?.thread_name,
    clientMetadata?.title,
    metadata?.conversation_name,
    metadata?.conversation_title,
    metadata?.thread_name,
    metadata?.title,
    body.conversation_name,
    body.conversation_title,
    body.thread_name
  ]
  for (const value of candidates) {
    const normalized = normalizeConversationName(value)
    if (normalized) return normalized
  }
  return undefined
}

function fallbackConversationName(sessionId: string): string {
  const compact = sessionId.length > 24
    ? `${sessionId.slice(0, 10)}…${sessionId.slice(-6)}`
    : sessionId
  return `对话 ${compact}`
}

function normalizeConversationName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 120)
  return normalized || undefined
}

function normalizeOpenAIServiceTier(body: JsonObject, forceFastMode: boolean): JsonObject {
  if (forceFastMode) return { ...body, service_tier: 'priority' }
  if (typeof body.service_tier === 'string' && body.service_tier.trim().toLowerCase() === 'fast') {
    return { ...body, service_tier: 'priority' }
  }
  return body
}

function readLocalToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) return authorization.slice(7).trim()
  const apiKey = request.headers['x-api-key']
  return typeof apiKey === 'string' && apiKey ? apiKey : undefined
}

function secureEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return mismatch === 0
}

function gatewayErrorFromProviderFailure(failure: ProviderFailure): GatewayHttpError {
  const statusCode = failure.statusCode ?? (
    failure.category === 'timeout' ? 504 :
      failure.category === 'cancelled' ? 499 : 502
  )
  return new GatewayHttpError(statusCode, failure.message, `provider_${failure.category}`, undefined, failure)
}

function normalizeError(error: unknown): GatewayHttpError {
  if (error instanceof GatewayHttpError) return error
  if (error instanceof ModelNotExposedError) return new GatewayHttpError(404, error.message, 'model_not_found')
  if (error instanceof NoEligibleAccountError) return new GatewayHttpError(503, error.message, 'account_unavailable')
  if (error instanceof UnsupportedProtocolConversionError) return new GatewayHttpError(400, error.message, 'unsupported_conversion')
  if (error instanceof Error && error.name === 'TimeoutError') return new GatewayHttpError(504, 'Upstream request timed out', 'timeout_error')
  return new GatewayHttpError(502, error instanceof Error ? error.message : 'Gateway request failed', 'gateway_error')
}

function isRetryable(error: GatewayHttpError): boolean {
  if (error.providerFailure) return error.providerFailure.retryable
  return error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 425 ||
    error.statusCode === 429 || error.statusCode >= 500
}

function upstreamErrorMessage(payload: JsonObject): string {
  const error = objectValue(payload.error)
  return typeof error?.message === 'string' ? error.message : 'Upstream request failed'
}

const sensitiveErrorField = /^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|credential|secret|password)$/i

function sanitizeUpstreamPayload(payload: JsonObject, secrets: readonly string[]): JsonObject {
  try {
    const serialized = JSON.stringify(payload, (key, value: unknown) => {
      if (key && sensitiveErrorField.test(key)) return '[REDACTED]'
      if (typeof value === 'string') return redactSensitiveText(value, secrets)
      return value
    })
    return objectValue(JSON.parse(serialized) as unknown)
      ?? { error: { message: 'Upstream request failed' } }
  } catch {
    return { error: { message: 'Upstream request failed' } }
  }
}

function redactSensitiveText(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => secret && safe.includes(secret) ? safe.split(secret).join('[REDACTED]') : safe,
    value
  )
}

function sensitiveValues(credential: { secret: string; accountId?: string }): string[] {
  return [credential.secret, credential.accountId].filter((value): value is string => Boolean(value))
}

class StreamingSecretRedactor {
  private pending = Buffer.alloc(0)
  private readonly secrets: Buffer[]
  private readonly replacement = Buffer.from('[REDACTED]', 'utf8')

  constructor(values: readonly string[]) {
    this.secrets = [...new Set(values.filter(Boolean))]
      .map((value) => Buffer.from(value, 'utf8'))
      .sort((left, right) => right.length - left.length)
  }

  push(chunk: Uint8Array): Buffer[] {
    if (this.secrets.length === 0) return [Buffer.from(chunk)]
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)])
    const output: Buffer[] = []
    while (true) {
      const match = this.secrets
        .map((secret) => ({ secret, index: this.pending.indexOf(secret) }))
        .filter(({ index }) => index >= 0)
        .sort((left, right) => left.index - right.index || right.secret.length - left.secret.length)[0]
      if (!match) break
      if (match.index > 0) output.push(this.pending.subarray(0, match.index))
      output.push(this.replacement)
      this.pending = this.pending.subarray(match.index + match.secret.length)
    }
    const retainedBytes = longestSecretPrefixSuffix(this.pending, this.secrets)
    const flushLength = this.pending.length - retainedBytes
    if (flushLength > 0) output.push(this.pending.subarray(0, flushLength))
    this.pending = this.pending.subarray(flushLength)
    return output
  }

  finish(): Buffer[] {
    if (this.pending.length === 0) return []
    const final = this.pending
    this.pending = Buffer.alloc(0)
    return [final]
  }
}

function longestSecretPrefixSuffix(value: Buffer, secrets: readonly Buffer[]): number {
  let retained = 0
  for (const secret of secrets) {
    const maximum = Math.min(value.length, secret.length - 1)
    for (let length = maximum; length > retained; length -= 1) {
      const start = value.length - length
      if (value[start] !== secret[0]) continue
      if (value.subarray(start).equals(secret.subarray(0, length))) {
        retained = length
        break
      }
    }
  }
  return retained
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function normalizeLogUsage(
  usage: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    cached_input_tokens?: number
    reasoning_tokens?: number
  } | undefined
): NormalizedTokenUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    reasoningTokens: usage.reasoning_tokens
  }
}

function observedQuotaSignals(
  signals: Pick<NormalizedQuotaSignals, 'rateLimits' | 'codexQuota'> | undefined,
  observedAt: number
): { quota?: AccountQuotaSnapshot; codexQuota?: AccountCodexQuotaSnapshot } {
  return {
    ...(signals?.rateLimits ? { quota: { ...signals.rateLimits, observedAt } } : {}),
    ...(signals?.codexQuota ? { codexQuota: signals.codexQuota } : {})
  }
}

function quotaSignalCooldownUntil(
  signals: GatewayHttpError['quotaSignals'] | undefined,
  now: number
): number | undefined {
  const codexResetAt = codexQuotaCooldownUntil(signals?.codexQuota, now)
  const genericResetAt = signals?.quota
    ? [signals.quota.requests, signals.quota.tokens, signals.quota.inputTokens, signals.quota.outputTokens]
        .filter((window) => window?.remaining === 0 && window.resetAt !== undefined && window.resetAt > now)
        .map((window) => window!.resetAt!)
    : []
  const candidates = [codexResetAt, ...genericResetAt].filter((value): value is number => value !== undefined)
  return candidates.length > 0 ? Math.max(...candidates) : undefined
}

function genericQuotaExhausted(quota: AccountQuotaSnapshot | undefined, now: number): boolean {
  if (!quota) return false
  return [quota.requests, quota.tokens, quota.inputTokens, quota.outputTokens]
    .some((window) => window?.remaining === 0 && (window.resetAt === undefined || window.resetAt > now))
}
