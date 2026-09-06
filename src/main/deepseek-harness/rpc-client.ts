import { randomUUID } from 'node:crypto'
export const DEFAULT_DEEPSEEK_HARNESS_ORIGIN = 'http://127.0.0.1:3080'

interface HarnessRpcSuccess<T> {
  ok: true
  value: T
}

interface HarnessRpcFailure {
  ok: false
  error: {
    code?: string
    message?: string
  }
}

interface HarnessRpcEnvelope<T> {
  type: 'server-response'
  rpcId: string
  result: HarnessRpcSuccess<T> | HarnessRpcFailure
}

export interface DeepSeekHarnessRpcClientOptions {
  fetchImplementation?: typeof fetch
  origin?: string
}

export interface DeepSeekHarnessStoneRoute {
  gatewayBaseUrl: string
  token: string
  preferredModel?: string
}

interface HarnessSessionSummary {
  sessionId: string
  blank: boolean
  updatedAt?: number
}

interface HarnessSessionList {
  items: HarnessSessionSummary[]
}

interface HarnessHistory {
  events: Array<{ event: { type: string } }>
}

interface HarnessProviderSummary {
  provider: string
  settingsNs?: string
  active: boolean
}

interface HarnessProviderList {
  providers: HarnessProviderSummary[]
}

interface HarnessModelCatalogEntry {
  id: string
  contextWindow: number
  maxTokens: number
}

type HarnessThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface HarnessPiAiModel extends HarnessModelCatalogEntry {
  name: string
  input: ['text']
  reasoningEfforts: Partial<Record<HarnessThinkingLevel, string>>
}

const GPT_REASONING_EFFORTS: HarnessPiAiModel['reasoningEfforts'] = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

const DEEPSEEK_REASONING_EFFORTS: HarnessPiAiModel['reasoningEfforts'] = {
  off: 'none',
  high: 'high',
  max: 'max',
}

export interface DeepSeekHarnessWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface DeepSeekHarnessWorkspaceResolution {
  workspace: DeepSeekHarnessWorkspace
  created: boolean
}

/** Narrow client for the public DeepSeek Harness HTTP RPC surface. */
export class DeepSeekHarnessRpcClient {
  readonly origin: string

  private readonly fetchImplementation: typeof fetch

  constructor(options: DeepSeekHarnessRpcClientOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.origin = normalizeHarnessOrigin(options.origin ?? DEFAULT_DEEPSEEK_HARNESS_ORIGIN)
  }

  async call<T = unknown>(method: string, payload: unknown, timeoutMs = 8_000): Promise<T> {
    if (!/^[a-z][a-zA-Z0-9.]*$/.test(method)) throw new Error('DeepSeek Harness RPC method is invalid.')
    const rpcId = `stone-${randomUUID()}`
    const response = await this.fetchImplementation(`${this.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}.`)
    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw new Error(`${method} returned an invalid JSON response.`)
    }
    if (!isHarnessRpcEnvelope<T>(envelope)) throw new Error(`${method} returned an invalid RPC envelope.`)
    if (envelope.rpcId !== rpcId) throw new Error(`${method} returned a mismatched RPC response.`)
    if (!envelope.result.ok) {
      const code = envelope.result.error.code?.trim()
      const message = envelope.result.error.message?.trim() || `${method} was rejected by DeepSeek Harness.`
      throw new Error(code ? `${message} (${code})` : message)
    }
    return envelope.result.value
  }

  async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await this.call('session.list', {})
        return
      } catch (error) {
        lastError = error
        await delay(250)
      }
    }
    throw new Error(`DeepSeek Harness did not become ready on ${this.origin}: ${errorMessage(lastError)}`)
  }

  async isReady(timeoutMs = 500): Promise<boolean> {
    try {
      await this.call('session.list', {}, timeoutMs)
      return true
    } catch {
      return false
    }
  }

  async waitForImportedSession(sessionId: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const sessions = await this.call('session.list', {})
        if (!isSessionList(sessions)) throw new Error('session.list returned an invalid value')
        const imported = sessions.items.find((item) => item.sessionId === sessionId)
        if (!imported) throw new Error('the imported session is absent from session.list')
        if (imported.blank) throw new Error('the imported session is still marked blank')
        const history = await this.call('session.history', { sessionId, maxMessages: 500 })
        if (!isImportedHistory(history)) throw new Error('the imported history is empty or incomplete')
        return
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    throw new Error(`DeepSeek Harness did not expose the migrated conversation: ${errorMessage(lastError)}`)
  }

  async ensureWorkspace(path: string): Promise<DeepSeekHarnessWorkspaceResolution> {
    const requestedPath = path.trim()
    if (!requestedPath) throw new Error('The imported Codex session has no project directory.')
    const result = await this.call('workspace.create', { path: requestedPath })
    if (!isWorkspaceResolution(result)) {
      throw new Error('workspace.create returned an invalid value.')
    }
    return result
  }

  async attachImportedSession(
    workspaceId: string,
    sessionId: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const attached = await this.call('session.create', { workspaceId, sessionId })
    if (!isRecord(attached) || attached.sessionId !== sessionId) {
      throw new Error('DeepSeek Harness did not attach the imported conversation to its project.')
    }

    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const workspaces = await this.call('workspace.list', {})
        if (!isWorkspaceList(workspaces)) throw new Error('workspace.list returned an invalid value')
        const workspace = workspaces.items.find((item) => item.workspaceId === workspaceId)
        if (!workspace) throw new Error('the imported project is absent from workspace.list')
        if (!workspace.sessionIds.includes(sessionId)) {
          throw new Error('the imported conversation is not attached to its project')
        }
        return
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    throw new Error(`DeepSeek Harness did not attach the migrated conversation to its project: ${errorMessage(lastError)}`)
  }

  async configureStoneRoute(route: DeepSeekHarnessStoneRoute): Promise<string[]> {
    const gatewayBaseUrl = normalizeGatewayBaseUrl(route.gatewayBaseUrl)
    const token = route.token.trim()
    if (!token) throw new Error('The DeepSeek Harness route has no local token.')
    const response = await this.fetchImplementation(`${gatewayBaseUrl}/deepseek-harness/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`Stone+ model catalog returned HTTP ${response.status}.`)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('Stone+ model catalog returned invalid JSON.')
    }
    const catalog = parseModelCatalog(payload)
    if (catalog.length === 0) throw new Error('The selected Stone+ source exposes no models to DeepSeek Harness.')
    const models = catalog.map((entry) => entry.id)
    const requestedModel = route.preferredModel?.trim()
    const preferred = requestedModel && models.includes(requestedModel)
      ? requestedModel
      : models[0]!
    await this.call('settings.update', {
      ns: 'llm-pi-ai',
      patch: {
        providers: {
          'deepseek-official': {
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            displayName: 'Stone+',
            // pi-ai's Responses adapter always forwards its request-scoped
            // sessionId. Its Chat Completions adapter deliberately omits that
            // header for generic loopback providers, which makes restored DSH
            // sessions indistinguishable at the gateway.
            api: 'openai-responses',
            baseURL: `${gatewayBaseUrl}/deepseek-harness/v1`,
            reasoning: 'high',
            defaultContextWindow: Math.min(...catalog.map((entry) => entry.contextWindow)),
            models: catalog.map(toPiAiModel),
          },
        },
      },
    })
    await this.waitForStoneModelProvider()
    await this.call('settings.update', {
      ns: 'web-search-deepseek',
      patch: {
        baseURL: `${gatewayBaseUrl}/deepseek-harness/anthropic/v1`,
        model: preferred,
      },
    })
    return models
  }

  private async waitForStoneModelProvider(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const result = await this.call('llm.providers', {}, Math.min(1_000, timeoutMs))
        if (!isProviderList(result)) throw new Error('llm.providers returned an invalid value')
        const provider = result.providers.find((entry) => entry.provider === 'deepseek-official')
        if (provider?.active && provider.settingsNs === 'llm-pi-ai') return
        lastError = provider?.active
          ? new Error(`deepseek-official is still owned by ${provider.settingsNs ?? 'an unknown adapter'}`)
          : new Error('deepseek-official is not active yet')
      } catch (error) {
        lastError = error
      }
      await delay(50)
    }
    throw new Error(`DeepSeek Harness did not activate the Stone+ model adapter: ${errorMessage(lastError)}`)
  }
}

function toPiAiModel(entry: HarnessModelCatalogEntry): HarnessPiAiModel {
  return {
    ...entry,
    name: entry.id,
    input: ['text'],
    reasoningEfforts: /^gpt-/i.test(entry.id)
      ? { ...GPT_REASONING_EFFORTS }
      : { ...DEEPSEEK_REASONING_EFFORTS },
  }
}

function isSessionList(value: unknown): value is HarnessSessionList {
  return isRecord(value) && Array.isArray(value.items) && value.items.every((item) => (
    isRecord(item) && typeof item.sessionId === 'string' && typeof item.blank === 'boolean'
  ))
}

function isProviderList(value: unknown): value is HarnessProviderList {
  return isRecord(value)
    && Array.isArray(value.providers)
    && value.providers.every((provider) => (
      isRecord(provider)
      && typeof provider.provider === 'string'
      && (provider.settingsNs === undefined || typeof provider.settingsNs === 'string')
      && typeof provider.active === 'boolean'
    ))
}

function isImportedHistory(value: unknown): value is HarnessHistory {
  if (!isRecord(value) || !Array.isArray(value.events) || value.events.length === 0) return false
  const types = new Set(value.events.flatMap((entry) => (
    isRecord(entry) && isRecord(entry.event) && typeof entry.event.type === 'string'
      ? [entry.event.type]
      : []
  )))
  return types.has('turn/start') && (types.has('user/message') || types.has('assistant/message'))
}

function isWorkspaceResolution(value: unknown): value is DeepSeekHarnessWorkspaceResolution {
  return isRecord(value)
    && typeof value.created === 'boolean'
    && isWorkspace(value.workspace)
}

function isWorkspaceList(value: unknown): value is { items: DeepSeekHarnessWorkspace[] } {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(isWorkspace)
}

function isWorkspace(value: unknown): value is DeepSeekHarnessWorkspace {
  return isRecord(value)
    && typeof value.workspaceId === 'string'
    && value.workspaceId.length > 0
    && typeof value.path === 'string'
    && value.path.length > 0
    && typeof value.title === 'string'
    && Array.isArray(value.sessionIds)
    && value.sessionIds.every((sessionId) => typeof sessionId === 'string')
}

function parseModelCatalog(value: unknown): HarnessModelCatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('Stone+ model catalog has an invalid shape.')
  if (value.data.length > 512) throw new Error('Stone+ model catalog is unexpectedly large.')
  const models: HarnessModelCatalogEntry[] = []
  const seen = new Set<string>()
  for (const entry of value.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const model = entry.id.trim()
    if (!model || model.length > 256 || hasControlCharacter(model) || seen.has(model)) continue
    seen.add(model)
    models.push({
      id: model,
      contextWindow: positiveInteger(entry.context_window) ?? fallbackContextWindow(model),
      maxTokens: positiveInteger(entry.max_output_tokens) ?? fallbackMaxTokens(model),
    })
  }
  return models
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function fallbackContextWindow(model: string): number {
  if (/^deepseek-/i.test(model)) return 1_048_576
  if (/^gpt-/i.test(model)) return 272_000
  return 128_000
}

function fallbackMaxTokens(model: string): number {
  if (/^deepseek-/i.test(model)) return 384_000
  if (/^gpt-/i.test(model)) return 128_000
  return 32_768
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function normalizeHarnessOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DeepSeek Harness RPC must use a loopback HTTP origin.')
  }
  return url.toString().replace(/\/$/, '')
}

function normalizeGatewayBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The Stone+ gateway must use a plain local HTTP origin.')
  }
  return url.toString().replace(/\/$/, '')
}

function isHarnessRpcEnvelope<T>(value: unknown): value is HarnessRpcEnvelope<T> {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string' || !isRecord(value.result)) {
    return false
  }
  if (value.result.ok === true) return Object.hasOwn(value.result, 'value')
  return value.result.ok === false && isRecord(value.result.error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
