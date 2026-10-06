import { BrowserWindow, type Session } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CHATGPT_WEB_WM_STREAM_CHANNEL,
  CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS,
  CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT,
  isChatGptWebWmReasoningObservedEvent,
  isChatGptWebWmRequestId,
  isChatGptWebWmStreamEvent,
  isChatGptWebWmTextDeltaEvent,
  isChatGptWebWmToolCallDeltaEvent,
  isChatGptWebWmToolCallDoneEvent,
  isChatGptWebWmToolCallStartEvent,
} from '@shared/chatgpt-web-wm-stream'
import { estimateWebWmTokens } from '@shared/web-wm-responses'

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const WEB_WM_MODEL = 'gpt-5.6-sol-wm'
// SSE and WebSocket transports below enforce 60s/30s no-activity limits.
// Keep a separate cumulative ceiling so an actively streaming coding turn is
// not aborted merely because it runs longer than two minutes.
const WEB_WM_TURN_HARD_TIMEOUT_MS = 10 * 60_000
const WEB_WM_PROTOCOL_DISCOVERY_TIMEOUT_MS = 120_000
const WEB_WM_BINDING_TTL_MS = 60 * 60 * 1_000
const WEB_WM_MAX_BINDINGS = 512
const WEB_WM_MAX_CONSUMED_TOOL_OUTPUTS = 65_536
const WEB_WM_REPLAY_MAX_BYTES = 512 * 1024
const WEB_WM_CURRENT_ASSET_SEEDS = [
  '/cdn/assets/4813494d-jkpkgwwqilpq9s2f.js',
  '/cdn/assets/conversation-small-dhn31isu2k7gsyv4.js',
] as const

interface WebWmTurnResult {
  status: number
  ok: boolean
  observedModel?: string
  conversationId?: string
  currentNode?: string
  reasoningMessageId?: string
  output?: string
  toolCalls?: WebWmTurnToolCall[]
  incompleteReason?: 'max_output_tokens' | 'content_filter'
  errorCode?: string
  errorMessage?: string
  streamDiagnostics?: {
    bridgeAvailable: boolean
    finalMessages: number
    nonEmptyFinalMessages: number
    finalMessageIdChanges: number
    prefixCompatibleIdChanges: number
    reasoningMessages: number
    emittedChars: number
    emitCount: number
    bridgeDisabled: boolean
    patchEvents: number
    patchEntries: number
    continuationRequested: boolean
    websocketTransportOpen: boolean
    handoffBusAvailable: boolean
    handoffHeaderAvailable: boolean
    handoffAttempted: boolean
    handoffReceived: boolean
    sseHandoffReceived: boolean
    websocketAvailable: boolean
    websocketUsed: boolean
    websocketFailed: boolean
    snapshotOnlyFallback: boolean
    authoritativeCompletion: boolean
    websocketTopicMessages: number
    websocketDecodedItems: number
    websocketMode?: 'frontend_resume' | 'direct_topic'
    websocketError?: string
  }
}

type WebWmToolKind = 'function' | 'custom' | 'tool_search'
type WebWmResponsesReasoningEffort =
  | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
type WebWmThinkingEffort = 'min' | 'standard' | 'extended' | 'xhigh' | 'max' | 'ultra'
type WebWmResponsesReasoningSummary = 'concise' | 'detailed' | null
type WebWmResponsesTextVerbosity = 'low' | 'medium' | 'high'

interface WebWmTurnToolCall {
  id: string
  name: string
  arguments: string
}

export interface WebWmLocalTool {
  kind: WebWmToolKind
  wireName: string
  name: string
  namespace?: string
  signature: Record<string, unknown>
}

interface WebWmConversationBinding {
  conversationId: string
  parentMessageId: string
  estimatedContextTokens: number
  expiresAt: number
}

interface WebWmToolCallBinding extends WebWmConversationBinding {
  tool: WebWmLocalTool
}

/** A completed tool continuation cached for an identical client retry. */
interface WebWmToolOutputReplay extends WebWmConversationBinding {
  outputFingerprints: string[]
  requestFingerprint: string
  wireBody: string
}

/** Fixed-size proof that a prior client tool output was already consumed. */
interface WebWmConsumedToolOutput {
  conversationId: string
  fingerprint: string
}

interface WebWmPendingImage {
  imageUrl: string
  detail?: string
}

interface WebWmWorkToolResultMessage {
  id: string
  author: { role: 'tool'; name: string; metadata: Record<string, never> }
  channel: 'commentary'
  content: {
    content_type: 'code'
    language: 'python3'
    text: string
  }
  create_time: number
  end_turn: null
  metadata: { is_visually_hidden_from_conversation: true }
  recipient: 'all'
  status: 'finished_successfully'
  update_time: null
  weight: 1
  stoneInputImages?: WebWmPendingImage[]
}

interface WebWmWorkContinuationMessage {
  id: string
  author: { role: 'user' }
  content: { content_type: 'text'; parts: [string] }
  create_time: number
  metadata: { is_visually_hidden_from_conversation: true }
}

type WebWmWorkMessage = WebWmWorkToolResultMessage | WebWmWorkContinuationMessage

interface WebWmPreparedResponsesTurn {
  prompt: string
  messages: WebWmWorkMessage[]
  inputImages: WebWmPendingImage[]
  tools: WebWmLocalTool[]
  toolConstraint?: { wireName?: string }
  parallelToolCalls: boolean
  thinkingEffort: WebWmThinkingEffort
  bodyExtras: Record<string, unknown>
  conversationId?: string
  parentMessageId?: string
  consumedCallIds: string[]
  consumedOutputs: WebWmResponsesToolOutput[]
  consumedRequestFingerprint?: string
  previousContextTokens: number
  replay?: WebWmToolOutputReplay
}

interface WebWmResponsesUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: 0; cache_write_tokens: 0 }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

interface WebWmEstimatedUsage {
  usage: WebWmResponsesUsage
  contextTokens: number
}

class WebWmResponsesRequestError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly param?: string,
  ) {
    super(message)
    this.name = 'WebWmResponsesRequestError'
  }
}

export interface ChatGptWebWmRuntimeOptions {
  electronSession: Session
  bootstrapState: Record<string, unknown>
  seedAssetUrls: readonly string[]
  preloadPath?: string
}

/** Build the user turn for Codex's standalone search RPC without inventing a second tool schema. */
export function buildChatGptWebWmSearchPrompt(body: Record<string, unknown>): string {
  const commands = objectValue(body.commands) ?? {}
  const settings = objectValue(body.settings) ?? {}
  const request = JSON.stringify({ commands, settings })
  const sourceInput = typeof body.input === 'string' && body.input.trim()
    ? `\nAdditional request context:\n${body.input.trim()}`
    : ''
  return [
    'Execute this standalone web-search request using the built-in web search capability.',
    'Return concise findings with exact source URLs. Do not explain these instructions.',
    request,
    sourceInput,
  ].filter(Boolean).join('\n')
}

/** Preserve the Responses conversation as explicit role-tagged text when no native Work continuation exists. */
export function buildChatGptWebWmResponsesPrompt(body: Record<string, unknown>): string {
  const sections: string[] = []
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
  if (instructions) sections.push(`<instructions>\n${instructions}\n</instructions>`)
  const responseStyle = webWmResponsesStyleInstruction(body)
  if (responseStyle) sections.push(`<response_style>\n${responseStyle}\n</response_style>`)
  const input = renderResponsesInput(body.input)
  if (input) sections.push(`<conversation>\n${input}\n</conversation>`)
  const toolChoice = renderToolChoice(body.tool_choice)
  if (toolChoice) sections.push(`<tool_choice>\n${toolChoice}\n</tool_choice>`)
  if (sections.length === 0) sections.push('<conversation>\nContinue the conversation.\n</conversation>')
  return sections.join('\n\n')
}

/** Convert Responses function/custom/namespace declarations into ChatGPT Work local functions. */
export function buildChatGptWebWmLocalTools(body: Record<string, unknown>): WebWmLocalTool[] {
  if (body.tool_choice === 'none') return []
  const tools: WebWmLocalTool[] = []
  const usedWireNames = new Set<string>()
  const seen = new Set<string>()
  const append = (value: unknown, namespace?: string): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      const tool = objectValue(entry)
      if (!tool) continue
      const type = typeof tool.type === 'string' ? tool.type : ''
      if (type === 'namespace') {
        const nestedNamespace = cleanToolName(tool.name)
        if (nestedNamespace) append(tool.tools, nestedNamespace)
        continue
      }
      if (type === 'tool_search') {
        const key = 'tool_search'
        if (seen.has(key)) continue
        seen.add(key)
        const wireName = uniqueWorkToolName('search_tools', usedWireNames)
        const parameters = objectValue(tool.parameters) ?? {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        }
        tools.push({
          kind: 'tool_search',
          wireName,
          name: 'search_tools',
          signature: workFunctionSignature(
            wireName,
            'Search the client tool catalog and return matching tool declarations.',
            parameters,
          ),
        })
        continue
      }
      if (type !== 'function' && type !== 'custom') continue
      const name = cleanToolName(tool.name)
      if (!name) continue
      const key = `${type}:${namespace ?? ''}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      const wireName = uniqueWorkToolName(namespace ? `${namespace}__${name}` : name, usedWireNames)
      const description = typeof tool.description === 'string' ? tool.description.trim() : ''
      if (type === 'custom') {
        tools.push({
          kind: 'custom',
          wireName,
          name,
          ...(namespace ? { namespace } : {}),
          signature: workFunctionSignature(
            wireName,
            [description, 'Pass the complete free-form tool input in the input parameter.']
              .filter(Boolean).join('\n'),
            {
              type: 'object',
              properties: { input: { type: 'string', description: 'Complete raw input for this custom tool.' } },
              required: ['input'],
              additionalProperties: false,
            },
          ),
        })
        continue
      }
      tools.push({
        kind: 'function',
        wireName,
        name,
        ...(namespace ? { namespace } : {}),
        signature: workFunctionSignature(
          wireName,
          description,
          objectValue(tool.parameters) ?? { type: 'object', properties: {} },
        ),
      })
    }
  }
  append(body.tools)
  for (const item of arrayValue(body.input)) {
    const input = objectValue(item)
    if (!input) continue
    if (input.type === 'additional_tools') append(input.tools)
    if (input.type === 'tool_search_output') append(input.tools)
  }
  return tools
}

/**
 * Account-isolated implementation detail behind ChatGptWebWmTransport.
 * The gateway never imports Electron or the changing ChatGPT frontend contract.
 */
export class ChatGptWebWmProtocolRuntime {
  private readonly window: BrowserWindow
  private readonly bridgeToken = randomBytes(24).toString('hex')
  private initializeOperation?: Promise<void>
  private protocolReadyOperation?: Promise<void>
  private readonly responseBindings = new Map<string, WebWmConversationBinding>()
  private readonly reasoningStateBindings = new Map<string, WebWmConversationBinding>()
  private readonly toolCallBindings = new Map<string, WebWmToolCallBinding>()
  private consumedToolOutputs?: Map<string, WebWmConsumedToolOutput>
  private toolOutputReplays?: Map<string, WebWmToolOutputReplay>
  private toolOutputFlights?: Map<string, Promise<void>>
  private readonly conversationCleanupTimers = new Map<string, NodeJS.Timeout>()
  private streamingRequests?: Map<string, WebWmResponsesEventStream>
  private disposed = false

  public constructor(private readonly options: ChatGptWebWmRuntimeOptions) {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: options.electronSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
        ...(options.preloadPath ? {
          preload: options.preloadPath,
          additionalArguments: [`${CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT}${this.bridgeToken}`],
        } : {}),
      },
    })
    this.window.setMenuBarVisibility(false)
    this.window.webContents.setAudioMuted(true)
    this.window.webContents.on('ipc-message', (_event, channel, ...args) => {
      this.receiveStreamEvent(channel, args)
    })
  }

  public get webContentsId(): number {
    return this.window.webContents.id
  }

  public async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web WM runtime is closed.')
    if (!this.initializeOperation) {
      this.initializeOperation = this.initializeFresh().catch((error) => {
        this.initializeOperation = undefined
        throw error
      })
    }
    return await this.initializeOperation
  }

  public async prewarm(): Promise<void> {
    await this.initialize()
    await this.ensureProtocolReady()
  }

  public async search(
    body: Record<string, unknown>,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    throwIfAborted(signal)
    await this.initialize()
    await this.ensureProtocolReady()
    throwIfAborted(signal)
    const result = await this.executeTurn(
      {
        prompt: buildChatGptWebWmSearchPrompt(body),
        messages: [],
        bodyExtras: {},
        hideOnFinal: true,
      },
      accessToken,
      signal,
    )
    if (!result.ok) {
      return jsonResponse({
        error: {
          type: 'chatgpt_web_wm_search_error',
          code: result.errorCode ?? 'web_wm_search_failed',
          message: result.errorMessage ?? 'ChatGPT Web WM search failed.',
        },
      }, normalizeUpstreamStatus(result.status))
    }
    if (result.observedModel !== WEB_WM_MODEL) {
      return jsonResponse({
        error: {
          type: 'chatgpt_web_wm_search_error',
          code: 'web_wm_model_mismatch',
          message: `ChatGPT did not serve this search with ${WEB_WM_MODEL}.`,
        },
      }, 502)
    }
    const output = result.output?.trim()
    if (!output) {
      return jsonResponse({
        error: {
          type: 'chatgpt_web_wm_search_error',
          code: 'empty_search_result',
          message: 'ChatGPT Web WM search returned no final text.',
        },
      }, 502)
    }
    return jsonResponse({ encrypted_output: null, output, results: null }, 200)
  }

  public async probe(
    accessToken: string,
    signal: AbortSignal,
    onTurnReady?: () => void,
  ): Promise<{ latencyMs: number; statusCode: number; turnModel: typeof WEB_WM_MODEL }> {
    const startedAt = Date.now()
    const marker = `STONE_WEB_WM_VERIFY_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
    throwIfAborted(signal)
    await this.initialize()
    await this.ensureProtocolReady()
    throwIfAborted(signal)
    onTurnReady?.()
    const result = await this.executeTurn({
      prompt: `Reply with exactly this string and nothing else: ${marker}`,
      messages: [],
      bodyExtras: {},
      thinkingEffort: 'min',
      hideOnFinal: true,
    }, accessToken, signal)
    if (!result.ok) {
      throw new Error(
        `Web WM verification failed (HTTP ${normalizeUpstreamStatus(result.status)}): ${result.errorMessage ?? 'the Work turn was rejected.'}`,
      )
    }
    if (!result.output?.includes(marker)) {
      throw new Error('Web WM verification returned a completed turn without the one-time marker.')
    }
    if (result.observedModel !== WEB_WM_MODEL) {
      throw new Error(
        `Web WM verification was not served by ${WEB_WM_MODEL}; observed ${result.observedModel ?? 'no model metadata'}.`,
      )
    }
    return {
      latencyMs: Math.max(0, Date.now() - startedAt),
      statusCode: result.status,
      turnModel: WEB_WM_MODEL,
    }
  }

  public async responses(
    body: Record<string, unknown>,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    throwIfAborted(signal)
    let prepared: WebWmPreparedResponsesTurn
    try {
      validateWebWmResponsesBody(body)
      this.pruneBindings()
      prepared = this.prepareResponsesTurn(body)
    } catch (error) {
      if (!(error instanceof WebWmResponsesRequestError)) throw error
      return jsonResponse({
        error: {
          type: 'invalid_request_error',
          code: error.code,
          message: error.message,
          ...(error.param ? { param: error.param } : {}),
        },
        }, 400)
    }
    if (prepared.replay) return webWmReplayResponse(prepared.replay)
    const activeToolOutputFlights = this.activeToolOutputFlights(prepared.consumedCallIds)
    if (activeToolOutputFlights.length > 0) {
      await waitForWebWmFlights(activeToolOutputFlights, signal)
      return this.responses(body, accessToken, signal)
    }
    const releaseToolOutputFlight = this.reserveToolOutputFlight(prepared.consumedCallIds)
    let handedOffToolOutputFlight = false
    try {
      await this.initialize()
      await this.ensureProtocolReady()
      throwIfAborted(signal)
      const responseId = `resp_${randomUUID().replaceAll('-', '')}`
      const requestId = randomUUID()
      const turnController = new AbortController()
      const abortTurn = (): void => turnController.abort(signal.reason)
      signal.addEventListener('abort', abortTurn, { once: true })
      if (signal.aborted) abortTurn()
      const stream = new WebWmResponsesEventStream(body, responseId, prepared.tools, (reason) => {
        turnController.abort(reason)
      })
      this.streamRequestMap().set(requestId, stream)
      void this.completeResponsesTurn(
        requestId,
        responseId,
        prepared,
        accessToken,
        turnController.signal,
        stream,
      ).finally(() => {
        signal.removeEventListener('abort', abortTurn)
        if (this.streamingRequests?.get(requestId) === stream) this.streamingRequests.delete(requestId)
        releaseToolOutputFlight?.()
      })
      handedOffToolOutputFlight = true
      return stream.response
    } finally {
      if (!handedOffToolOutputFlight) releaseToolOutputFlight?.()
    }
  }

  private streamRequestMap(): Map<string, WebWmResponsesEventStream> {
    this.streamingRequests ??= new Map()
    return this.streamingRequests
  }

  private activeToolOutputFlights(callIds: readonly string[]): Promise<void>[] {
    if (!this.toolOutputFlights || callIds.length === 0) return []
    return [...new Set(callIds.flatMap((callId) => {
      const flight = this.toolOutputFlights?.get(callId)
      return flight ? [flight] : []
    }))]
  }

  private reserveToolOutputFlight(callIds: readonly string[]): (() => void) | undefined {
    const uniqueCallIds = [...new Set(callIds)]
    if (uniqueCallIds.length === 0) return undefined
    this.toolOutputFlights ??= new Map()
    let resolveFlight!: () => void
    const flight = new Promise<void>((resolve) => { resolveFlight = resolve })
    for (const callId of uniqueCallIds) this.toolOutputFlights.set(callId, flight)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const callId of uniqueCallIds) {
        if (this.toolOutputFlights?.get(callId) === flight) this.toolOutputFlights.delete(callId)
      }
      resolveFlight()
    }
  }

  private receiveStreamEvent(channel: string, args: unknown[]): void {
    if (channel !== CHATGPT_WEB_WM_STREAM_CHANNEL || args.length !== 3) return
    const [token, requestId, event] = args
    if (token !== this.bridgeToken || !isChatGptWebWmRequestId(requestId)
      || !isChatGptWebWmStreamEvent(event)) return
    const stream = this.streamingRequests?.get(requestId)
    if (isChatGptWebWmTextDeltaEvent(event)) {
      stream?.appendTextDelta(event.messageId, event.delta)
    } else if (isChatGptWebWmReasoningObservedEvent(event)) {
      stream?.observeReasoning(event.messageId)
    } else if (isChatGptWebWmToolCallStartEvent(event)) {
      stream?.startToolCall(event.messageId, event.name)
    } else if (isChatGptWebWmToolCallDeltaEvent(event)) {
      stream?.appendToolCallDelta(event.messageId, event.delta)
    } else if (isChatGptWebWmToolCallDoneEvent(event)) {
      stream?.finishToolCall(event.messageId)
    }
  }

  private async completeResponsesTurn(
    requestId: string,
    responseId: string,
    prepared: WebWmPreparedResponsesTurn,
    accessToken: string,
    signal: AbortSignal,
    stream: WebWmResponsesEventStream,
  ): Promise<void> {
    try {
      const result = await this.executeTurn(
        { ...prepared, hideOnFinal: false, streamText: true },
        accessToken,
        signal,
        requestId,
      )
      if (!result.ok) {
        stream.fail(
          result.errorCode ?? 'web_wm_responses_failed',
          result.errorMessage ?? 'ChatGPT Web WM Responses request failed.',
          result.status,
        )
        return
      }
      if (result.observedModel !== WEB_WM_MODEL) {
        stream.fail(
          'web_wm_model_mismatch',
          `ChatGPT did not serve this response with ${WEB_WM_MODEL}.`,
        )
        return
      }
      const output = result.output?.trim() ?? ''
      if (result.reasoningMessageId) stream.observeReasoning(result.reasoningMessageId)
      const finalToolCalls = (result.toolCalls ?? []).filter((call) => (
        call.id && call.name && prepared.tools.some((tool) => tool.wireName === call.name)
      ))
      const toolCalls = stream.reconcileToolCalls(finalToolCalls)
      if (!toolCalls) {
        stream.fail(
          'web_wm_tool_stream_mismatch',
          'ChatGPT Web WM final tool calls did not match their streamed arguments.',
        )
        return
      }
      if (prepared.toolConstraint && toolCalls.length === 0) {
        stream.fail(
          'tool_choice_not_satisfied',
          'ChatGPT Web WM did not produce the required client tool call.',
        )
        return
      }
      if (prepared.toolConstraint?.wireName
        && !toolCalls.some((call) => call.name === prepared.toolConstraint?.wireName)) {
        stream.fail(
          'tool_choice_not_satisfied',
          'ChatGPT Web WM did not produce the specifically selected client tool call.',
        )
        return
      }
      // Work can emit more than one independent client call even after
      // receiving parallel_tool_calls=false. Those items have already been
      // streamed to Codex by this point. Turning the terminal event into a
      // failure makes Codex replay the whole sampling request and can execute
      // the same tools twice. Preserve the independent calls and their
      // bindings so Codex can return both outputs in one continuation.
      if (!output && toolCalls.length === 0 && !result.incompleteReason) {
        stream.fail(
          'empty_responses_result',
          'ChatGPT Web WM returned neither final text nor a client tool call.',
        )
        return
      }
      if (!stream.canReconcileText(output)) {
        stream.fail(
          'web_wm_stream_mismatch',
          'ChatGPT Web WM final text did not match its streamed prefix.',
        )
        return
      }
      const estimated = estimateWebWmResponsesUsage(
        prepared,
        output,
        toolCalls,
        Boolean(result.reasoningMessageId) || stream.reasoningWasObserved,
      )
      this.rememberResponsesTurn(
        responseId,
        prepared,
        result,
        stream,
        toolCalls,
        estimated.contextTokens,
      )
      if (result.incompleteReason) {
        stream.incomplete(output, result.incompleteReason, estimated.usage)
        this.rememberToolOutputReplay(prepared, result, stream)
        return
      }
      stream.complete(output, estimated.usage)
      this.rememberToolOutputReplay(prepared, result, stream)
    } catch (error) {
      if (signal.aborted) {
        stream.abort(signal.reason)
        return
      }
      stream.fail('web_wm_responses_failed', safeWebWmResponsesErrorMessage(error))
    }
  }

  private rememberResponsesTurn(
    responseId: string,
    prepared: WebWmPreparedResponsesTurn,
    result: WebWmTurnResult,
    stream: WebWmResponsesEventStream,
    toolCalls: readonly WebWmTurnToolCall[],
    estimatedContextTokens: number,
  ): void {
    if (!result.conversationId || !result.currentNode) return
    this.retainConversation(result.conversationId)
    const binding = {
      conversationId: result.conversationId,
      parentMessageId: result.currentNode,
      estimatedContextTokens,
      expiresAt: Date.now() + WEB_WM_BINDING_TTL_MS,
    }
    this.rememberBinding(this.responseBindings, responseId, binding)
    if (stream.reasoningEncryptedContent) {
      this.rememberBinding(this.reasoningStateBindings, stream.reasoningEncryptedContent, binding)
    }
    for (const call of toolCalls) {
      const tool = prepared.tools.find((candidate) => candidate.wireName === call.name)
      if (!tool) continue
      this.rememberBinding(this.toolCallBindings, call.id, { ...binding, tool })
    }
  }

  public dispose(): void {
    this.disposed = true
    for (const stream of this.streamingRequests?.values() ?? []) {
      stream.abort(new Error('Web WM runtime is closed.'))
    }
    this.streamingRequests?.clear()
    for (const timer of this.conversationCleanupTimers.values()) clearTimeout(timer)
    const retainedConversationIds = [...this.conversationCleanupTimers.keys()]
    this.conversationCleanupTimers.clear()
    this.responseBindings.clear()
    this.reasoningStateBindings.clear()
    this.toolCallBindings.clear()
    this.consumedToolOutputs?.clear()
    this.toolOutputReplays?.clear()
    if (this.window.isDestroyed()) return
    if (retainedConversationIds.length === 0) {
      this.window.destroy()
      return
    }
    void this.window.webContents.executeJavaScript(`Promise.allSettled(
      ${scriptJson(retainedConversationIds)}.map((conversationId) => fetch(
        '/backend-api/conversation/' + encodeURIComponent(conversationId),
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_visible: false }),
        }
      ))
    )`).finally(() => {
      if (!this.window.isDestroyed()) this.window.destroy()
    })
  }

  private async initializeFresh(): Promise<void> {
    await withTimeout(
      this.window.loadURL(`${CHATGPT_ORIGIN}/robots.txt`, {
        extraHeaders: 'Cache-Control: no-cache\r\nPragma: no-cache',
      }),
      45_000,
      'Web WM protocol origin navigation timed out.',
    )
    if (this.disposed || this.window.isDestroyed()) throw new Error('Web WM runtime is closed.')
    const seedAssetUrls = [...new Set([
      ...this.options.seedAssetUrls,
      ...WEB_WM_CURRENT_ASSET_SEEDS,
    ])]
    const initialized = await this.window.webContents.executeJavaScript(`(async () => {
      const bootstrapState = ${scriptJson(this.options.bootstrapState)}
      const nativeFetch = globalThis.fetch.bind(globalThis)
      document.open()
      document.write('<!doctype html><html><head><meta charset="utf-8"><title>Stone Web WM Protocol</title></head><body></body></html>')
      document.close()
      const bootstrap = document.createElement('script')
      bootstrap.id = 'client-bootstrap'
      bootstrap.type = 'application/json'
      bootstrap.textContent = JSON.stringify(bootstrapState)
      document.head.appendChild(bootstrap)
      globalThis.CLIENT_BOOTSTRAP = bootstrapState
      globalThis.fetch = (input, init) => {
        let url
        try {
          url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href)
        } catch {
          return nativeFetch(input, init)
        }
        if (url.origin === location.origin && url.pathname === '/api/auth/session') {
          return Promise.resolve(new Response(JSON.stringify(bootstrapState.session), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          }))
        }
        return nativeFetch(input, init)
      }
       globalThis[Symbol.for('stone.chatgptWebWm.runtime')] = {
         seedAssetUrls: ${scriptJson(seedAssetUrls)},
         descriptor: null,
         controllers: new Map(),
         uploadedImages: new Map(),
       }
      const session = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' })
        .then((response) => response.json()).catch(() => null)
      return {
        origin: location.origin,
        authenticated: Boolean(session?.user?.id && session?.accessToken && session?.account?.id),
      }
    })()`)
    if (initialized?.origin !== CHATGPT_ORIGIN || initialized?.authenticated !== true) {
      throw new Error('Web WM controlled protocol runtime is not authenticated.')
    }
  }

  private prepareResponsesTurn(body: Record<string, unknown>): WebWmPreparedResponsesTurn {
    const tools = buildChatGptWebWmLocalTools(body)
    const toolConstraint = webWmToolConstraint(body.tool_choice, tools)
    const parallelToolCalls = body.parallel_tool_calls !== false
    const thinkingEffort = webWmThinkingEffort(body)
    const bodyExtras: Record<string, unknown> = {
      supported_encodings: ['v1'],
      parallel_tool_calls: parallelToolCalls,
      ...(tools.length > 0
        ? { local_function_signatures: tools.map((tool) => tool.signature) }
        : {}),
    }
    const previousResponseId = typeof body.previous_response_id === 'string'
      ? body.previous_response_id.trim()
      : ''
    const previousById = previousResponseId ? this.responseBindings.get(previousResponseId) : undefined
    const recoverMissingPreviousByVisibleHistory = Boolean(
      previousResponseId
      && !previousById
      && hasReplayableVisibleResponseHistory(body),
    )
    if (previousResponseId && !previousById && !recoverMissingPreviousByVisibleHistory) {
      throw new WebWmResponsesRequestError(
        'web_wm_state_not_found',
        'The previous Web WM response is unavailable on this account. Start a new response or retry the owning session.',
        'previous_response_id',
      )
    }
    const reasoningState = previousById ? undefined : this.findReasoningState(body)
    const currentTurnBody = reasoningState
      ? reasoningState.binding
        ? responsesBodyAfterReasoningState(body, reasoningState.inputIndex)
        : responsesBodyWithoutUnavailableReasoningState(body, reasoningState.inputIndex)
      : responsesBodyAfterLatestAssistantMessage(body)
    const outputs = responseToolOutputs(currentTurnBody)
    const requestFingerprint = toolOutputRequestFingerprint(currentTurnBody)
    // A client can resend the exact tool-output turn when it reconnects just
    // after the previous SSE completed.  Replay the already completed SSE
    // instead of treating the now-consumed call id as lost state.  Do not use
    // this shortcut for reasoning-state history: that path intentionally
    // strips a previously consumed tool output before the next user turn.
    const replay = !reasoningState
      ? this.findToolOutputReplay(outputs, requestFingerprint)
      : undefined
    if (replay) return {
      prompt: '',
      messages: [],
      inputImages: [],
      tools,
      ...(toolConstraint ? { toolConstraint } : {}),
      parallelToolCalls,
      thinkingEffort,
      bodyExtras,
      consumedCallIds: [],
      consumedOutputs: [],
      previousContextTokens: replay.estimatedContextTokens,
      replay,
    }
    const outputBindings = outputs.map((output) => ({
      output,
      binding: this.toolCallBindings.get(output.callId),
      consumed: this.findConsumedToolOutput(output),
      conflictsWithConsumed: this.hasConsumedToolOutputConflict(output),
    }))
    if (outputBindings.length > 0) {
      const activeOutputBindings = outputBindings.filter((entry) => entry.binding)
      const hasUnknownOutput = outputBindings.some((entry) => !entry.binding && !entry.consumed)
      const recoverVisibleToolHistory = !previousById
        && hasUnknownOutput
        && outputBindings.every((entry) => !entry.conflictsWithConsumed)
        && hasReplayableVisibleToolHistory(currentTurnBody)
      if (activeOutputBindings.length === 0 && !recoverVisibleToolHistory) {
        throw new WebWmResponsesRequestError(
          'web_wm_state_not_found',
          'A tool output no longer belongs to an active Web WM response on this account.',
          'input',
        )
      }
      if (!recoverVisibleToolHistory) {
        if (outputBindings.some((entry) => !entry.binding && !entry.consumed)) {
          throw new WebWmResponsesRequestError(
            'web_wm_state_not_found',
            'A tool output no longer belongs to an active Web WM response on this account.',
            'input',
          )
        }
        const bindings = activeOutputBindings.flatMap((entry) => entry.binding ? [entry.binding] : [])
        const conversationIds = [
          ...bindings.map((binding) => binding.conversationId),
          ...outputBindings.flatMap((entry) => entry.consumed ? [entry.consumed.conversationId] : []),
        ]
        if (new Set(conversationIds).size !== 1
          || new Set(bindings.map((binding) => binding.parentMessageId)).size !== 1) {
          throw new WebWmResponsesRequestError(
            'web_wm_state_mismatch',
            'Tool outputs from different Web WM turns cannot be continued together.',
            'input',
          )
        }
        const first = bindings[0]
        if (first) {
          const messages: WebWmWorkMessage[] = activeOutputBindings.flatMap(({ output, binding }) => (
            binding ? [workToolResultMessage(output, binding)] : []
          ))
          const continuationInstruction = workToolContinuationMessage(toolConstraint, tools)
          if (continuationInstruction) messages.push(continuationInstruction)
          return {
            prompt: '',
            messages,
            inputImages: [],
            tools,
            ...(toolConstraint ? { toolConstraint } : {}),
            parallelToolCalls,
            thinkingEffort,
            bodyExtras,
            conversationId: first.conversationId,
            parentMessageId: first.parentMessageId,
            consumedCallIds: activeOutputBindings.map(({ output }) => output.callId),
            consumedOutputs: activeOutputBindings.map(({ output }) => output),
            consumedRequestFingerprint: requestFingerprint,
            previousContextTokens: first.estimatedContextTokens,
          }
        }
      }
      if (recoverVisibleToolHistory) {
        return {
          prompt: buildRecoveredWebWmResponsesPrompt(currentTurnBody),
          messages: [],
          inputImages: responseInputImages(currentTurnBody),
          tools,
          ...(toolConstraint ? { toolConstraint } : {}),
          parallelToolCalls,
          thinkingEffort,
          bodyExtras,
          consumedCallIds: outputs.map((output) => output.callId),
          consumedOutputs: outputs,
          consumedRequestFingerprint: requestFingerprint,
          previousContextTokens: 0,
        }
      }
    }
    const previous = previousById ?? reasoningState?.binding
    // When a live Web WM binding exists, ChatGPT already owns the preceding
    // turn on the Work conversation.  Codex may still resend the visible
    // history alongside `previous_response_id`; forwarding that whole body
    // would make the same history count twice (once in Work and once in the
    // rendered prompt), causing the client to compact after only a few turns.
    // Keep the full body for new/recovered conversations, but only send the
    // delta after the latest assistant item for an established binding.
    const promptBody = previousById || reasoningState ? currentTurnBody : body
    return {
      prompt: buildChatGptWebWmResponsesPrompt(
        promptBody,
      ),
      messages: [],
      inputImages: responseInputImages(promptBody),
      tools,
      ...(toolConstraint ? { toolConstraint } : {}),
      parallelToolCalls,
      thinkingEffort,
      bodyExtras,
      ...(previous ? {
        conversationId: previous.conversationId,
        parentMessageId: previous.parentMessageId,
      } : {}),
      consumedCallIds: [],
      consumedOutputs: [],
      previousContextTokens: previous?.estimatedContextTokens ?? 0,
    }
  }

  private findReasoningState(body: Record<string, unknown>): {
    binding?: WebWmConversationBinding
    inputIndex: number
  } | undefined {
    const input = arrayValue(body.input)
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = objectValue(input[index])
      if (item?.type !== 'reasoning' || typeof item.encrypted_content !== 'string') continue
      if (!item.encrypted_content.startsWith('wmrs_')) continue
      const binding = this.reasoningStateBindings.get(item.encrypted_content)
      // The state map is deliberately account-local and in-memory. If Stone+
      // was restarted or the hidden Work conversation aged out, continue from
      // the visible items after the opaque state in a fresh Web WM conversation
      // instead of failing the entire Codex task or falling back to normal Sol.
      return { ...(binding ? { binding } : {}), inputIndex: index }
    }
    return undefined
  }

  private rememberBinding<T extends { expiresAt: number }>(
    target: Map<string, T>,
    key: string,
    value: T,
  ): void {
    target.delete(key)
    target.set(key, value)
    while (target.size > WEB_WM_MAX_BINDINGS) {
      const oldest = target.keys().next().value
      if (typeof oldest !== 'string') break
      target.delete(oldest)
    }
  }

  private pruneBindings(): void {
    const now = Date.now()
    for (const [key, binding] of this.responseBindings) {
      if (binding.expiresAt <= now) this.responseBindings.delete(key)
    }
    for (const [key, binding] of this.reasoningStateBindings) {
      if (binding.expiresAt <= now) this.reasoningStateBindings.delete(key)
    }
    for (const [key, binding] of this.toolCallBindings) {
      if (binding.expiresAt <= now) this.toolCallBindings.delete(key)
    }
    for (const [key, replay] of this.toolOutputReplayMap()) {
      if (replay.expiresAt <= now) this.toolOutputReplayMap().delete(key)
    }
  }

  private retainConversation(conversationId: string): void {
    const previous = this.conversationCleanupTimers.get(conversationId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.conversationCleanupTimers.delete(conversationId)
      for (const [key, binding] of this.responseBindings) {
        if (binding.conversationId === conversationId) this.responseBindings.delete(key)
      }
      for (const [key, binding] of this.reasoningStateBindings) {
        if (binding.conversationId === conversationId) this.reasoningStateBindings.delete(key)
      }
      for (const [key, binding] of this.toolCallBindings) {
        if (binding.conversationId === conversationId) this.toolCallBindings.delete(key)
      }
      const consumedToolOutputs = this.consumedToolOutputs
      if (consumedToolOutputs) {
        for (const [key, receipt] of consumedToolOutputs) {
          if (receipt.conversationId === conversationId) consumedToolOutputs.delete(key)
        }
      }
      const replays = this.toolOutputReplays
      if (replays) {
        for (const [key, replay] of replays) {
          if (replay.conversationId === conversationId) replays.delete(key)
        }
      }
      if (this.disposed || this.window.isDestroyed()) return
      void this.window.webContents.executeJavaScript(`fetch(
        '/backend-api/conversation/' + encodeURIComponent(${JSON.stringify(conversationId)}),
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_visible: false }),
        }
      ).then(() => undefined, () => undefined)`).catch(() => undefined)
    }, WEB_WM_BINDING_TTL_MS)
    timer.unref?.()
    this.conversationCleanupTimers.set(conversationId, timer)
  }

  private toolOutputReplayMap(): Map<string, WebWmToolOutputReplay> {
    this.toolOutputReplays ??= new Map()
    return this.toolOutputReplays
  }

  private consumedToolOutputMap(): Map<string, WebWmConsumedToolOutput> {
    this.consumedToolOutputs ??= new Map()
    return this.consumedToolOutputs
  }

  private findToolOutputReplay(
    outputs: readonly WebWmResponsesToolOutput[],
    requestFingerprint: string,
  ): WebWmToolOutputReplay | undefined {
    if (outputs.length === 0 || !this.toolOutputReplays) return undefined
    const candidate = [...outputs].reverse().map((output) => (
      this.findExactToolOutputReplay(output)
    )).find((replay) => replay?.requestFingerprint === requestFingerprint)
    if (!candidate) return undefined
    const consumed = outputs.map((output) => this.findConsumedToolOutput(output))
    if (consumed.some((receipt) => !receipt || receipt.conversationId !== candidate.conversationId)) {
      return undefined
    }
    const candidateFingerprints = outputs.flatMap((output) => (
      this.toolOutputReplays?.get(output.callId) === candidate ? [toolOutputFingerprint(output)] : []
    ))
    if (candidate.outputFingerprints.length !== candidateFingerprints.length
      || candidate.outputFingerprints.some((value, index) => value !== candidateFingerprints[index])) return undefined
    return candidate
  }

  private findExactToolOutputReplay(
    output: WebWmResponsesToolOutput,
  ): WebWmToolOutputReplay | undefined {
    const replay = this.toolOutputReplays?.get(output.callId)
    if (!replay || replay.expiresAt <= Date.now()) return undefined
    return replay.outputFingerprints.includes(toolOutputFingerprint(output)) ? replay : undefined
  }

  private findConsumedToolOutput(
    output: WebWmResponsesToolOutput,
  ): WebWmConsumedToolOutput | undefined {
    const consumed = this.consumedToolOutputs?.get(output.callId)
    return consumed?.fingerprint === toolOutputFingerprint(output) ? consumed : undefined
  }

  private hasConsumedToolOutputConflict(output: WebWmResponsesToolOutput): boolean {
    const consumed = this.consumedToolOutputs?.get(output.callId)
    return Boolean(consumed && consumed.fingerprint !== toolOutputFingerprint(output))
  }

  private rememberConsumedToolOutputs(
    outputs: readonly WebWmResponsesToolOutput[],
    conversationId: string,
  ): void {
    const consumedToolOutputs = this.consumedToolOutputMap()
    for (const output of outputs) {
      consumedToolOutputs.delete(output.callId)
      consumedToolOutputs.set(output.callId, {
        conversationId,
        fingerprint: toolOutputFingerprint(output),
      })
      this.toolCallBindings.delete(output.callId)
    }
    while (consumedToolOutputs.size > WEB_WM_MAX_CONSUMED_TOOL_OUTPUTS) {
      const oldest = consumedToolOutputs.keys().next().value
      if (typeof oldest !== 'string') break
      consumedToolOutputs.delete(oldest)
    }
  }

  private rememberToolOutputReplay(
    prepared: WebWmPreparedResponsesTurn,
    result: WebWmTurnResult,
    stream: WebWmResponsesEventStream,
  ): void {
    if (prepared.consumedCallIds.length === 0 || !result.conversationId || !result.currentNode) return
    this.rememberConsumedToolOutputs(prepared.consumedOutputs, result.conversationId)
    if (prepared.consumedRequestFingerprint && stream.wireBody
      && Buffer.byteLength(stream.wireBody, 'utf8') <= WEB_WM_REPLAY_MAX_BYTES) {
      const replay: WebWmToolOutputReplay = {
        conversationId: result.conversationId,
        parentMessageId: result.currentNode,
        estimatedContextTokens: prepared.previousContextTokens,
        expiresAt: Date.now() + WEB_WM_BINDING_TTL_MS,
        outputFingerprints: prepared.consumedOutputs.map(toolOutputFingerprint),
        requestFingerprint: prepared.consumedRequestFingerprint,
        wireBody: stream.wireBody,
      }
      const replays = this.toolOutputReplayMap()
      for (const callId of prepared.consumedCallIds) replays.set(callId, replay)
      while (replays.size > WEB_WM_MAX_BINDINGS) {
        const oldest = replays.keys().next().value
        if (typeof oldest !== 'string') break
        replays.delete(oldest)
      }
    }
  }


  private async executeTurn(
    turn: Pick<WebWmPreparedResponsesTurn,
      'prompt' | 'messages' | 'bodyExtras' | 'conversationId' | 'parentMessageId'> & {
        inputImages?: readonly WebWmPendingImage[]
        thinkingEffort?: WebWmThinkingEffort
        hideOnFinal?: boolean
        streamText?: boolean
      },
    accessToken: string,
    signal: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<WebWmTurnResult> {
    const execution = this.window.webContents.executeJavaScript(buildChatGptWebWmSearchExecutionScript({
      requestId,
      prompt: turn.prompt,
      messages: turn.messages,
      inputImages: turn.inputImages,
      bodyExtras: turn.bodyExtras,
      conversationId: turn.conversationId,
      parentMessageId: turn.parentMessageId,
      thinkingEffort: turn.thinkingEffort,
      hideOnFinal: turn.hideOnFinal,
      streamText: turn.streamText,
      accessToken,
      timeoutMs: WEB_WM_TURN_HARD_TIMEOUT_MS,
    })) as Promise<WebWmTurnResult>
    const abort = (): void => {
      if (this.window.isDestroyed()) return
      void this.window.webContents.executeJavaScript(`(() => {
        const state = globalThis[Symbol.for('stone.chatgptWebWm.runtime')]
        state?.controllers?.get(${JSON.stringify(requestId)})?.abort()
      })()`).catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      return await withTimeout(
        execution,
        WEB_WM_TURN_HARD_TIMEOUT_MS + 5_000,
        'Web WM request timed out.',
      )
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async ensureProtocolReady(): Promise<void> {
    if (this.disposed) throw new Error('Web WM runtime is closed.')
    if (!this.protocolReadyOperation) {
      this.protocolReadyOperation = this.discoverProtocol().catch((error) => {
        this.protocolReadyOperation = undefined
        throw error
      })
    }
    await this.protocolReadyOperation
  }

  private async discoverProtocol(): Promise<void> {
    const result = await withTimeout(
      this.window.webContents.executeJavaScript(buildChatGptWebWmSearchExecutionScript({
        requestId: randomUUID(),
        prompt: '',
        accessToken: '',
        timeoutMs: WEB_WM_PROTOCOL_DISCOVERY_TIMEOUT_MS,
        discoverOnly: true,
      })) as Promise<WebWmTurnResult>,
      WEB_WM_PROTOCOL_DISCOVERY_TIMEOUT_MS + 5_000,
      'Web WM protocol discovery timed out.',
    )
    if (!result.ok) {
      throw new Error(result.errorMessage ?? 'Current ChatGPT frontend protocol discovery failed.')
    }
  }
}

export function buildChatGptWebWmSearchExecutionScript(input: {
  requestId: string
  prompt: string
  messages?: readonly WebWmWorkMessage[]
  inputImages?: readonly WebWmPendingImage[]
  bodyExtras?: Record<string, unknown>
  thinkingEffort?: WebWmThinkingEffort
  conversationId?: string
  parentMessageId?: string
  hideOnFinal?: boolean
  streamText?: boolean
  accessToken: string
  timeoutMs: number
  discoverOnly?: boolean
}): string {
  return `(async () => {
    const runtime = globalThis[Symbol.for('stone.chatgptWebWm.runtime')]
    if (!runtime) throw new Error('Web WM runtime state is missing')
    const pendingInputImages = ${scriptJson(input.inputImages ?? [])}
    const pendingWorkMessages = ${scriptJson(input.messages ?? [])}
    const requiresImageUpload = pendingInputImages.length > 0 || pendingWorkMessages.some((message) => (
      Array.isArray(message?.stoneInputImages) && message.stoneInputImages.length > 0
    ))
    const startedAt = performance.now()
    const controller = new AbortController()
    runtime.controllers.set(${JSON.stringify(input.requestId)}, controller)
    const timer = setTimeout(() => controller.abort(), ${Math.max(2_000, input.timeoutMs - 1_000)})
    const errorResult = (status, code, message) => ({
      status: Number.isFinite(status) ? status : 502,
      ok: false,
      errorCode: typeof code === 'string' ? code.slice(0, 160) : undefined,
      errorMessage: typeof message === 'string' ? message.slice(0, 1_000) : 'Web WM request failed',
    })
    let earlyHandoffCleanup = () => undefined
    let executionStage = 'runtime-start'
    const streamBridge = ${input.streamText === true ? 'globalThis.__stoneWebWmStream' : 'null'}
    let streamMessageId = null
    let streamedText = ''
    let streamPreviousFinalText = ''
    let streamBridgeDisabled = false
    let streamFinalMessages = 0
    let streamNonEmptyFinalMessages = 0
    let streamFinalMessageIdChanges = 0
    let streamPrefixCompatibleIdChanges = 0
    let streamEmitCount = 0
    const streamReasoningMessageIds = new Set()
    const streamToolCalls = new Map()
    let streamToolEmitCount = 0
    let streamToolBridgeDisabled = false
    const streamPatchMessages = new Map()
    let activeStreamPatchMessageId = null
    let streamPatchEvents = 0
    let streamPatchEntries = 0
    let websocketTopicMessages = 0
    let websocketDecodedItems = 0
    let streamAuthoritativeCompletion = false
    const textFromContent = (value, depth = 0) => {
      if (depth > 3 || value == null) return ''
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.map((entry) => textFromContent(entry, depth + 1)).join('')
      if (typeof value !== 'object') return ''
      if (typeof value.text === 'string') return value.text
      if (typeof value.content === 'string') return value.content
      if (typeof value.value === 'string' &&
          (typeof value.type !== 'string' || /text|delta/i.test(value.type))) return value.value
      return Array.isArray(value.parts) ? textFromContent(value.parts, depth + 1) : ''
    }
    const inspectStreamMessage = (message, allowStreamText = false) => {
      if (message?.author?.role !== 'assistant') return
      const contentType = message.content?.content_type
      if (contentType === 'reasoning_recap' || contentType === 'thoughts') {
        const reasoningMessageId = typeof message.id === 'string' && message.id
          ? message.id.slice(0, 160)
          : 'assistant-reasoning'
        if (!streamReasoningMessageIds.has(reasoningMessageId)) {
          streamReasoningMessageIds.add(reasoningMessageId)
          streamBridge?.emit(${JSON.stringify(input.requestId)}, {
            type: 'reasoning_observed',
            messageId: reasoningMessageId,
          })
        }
      }
      const recipient = typeof message.recipient === 'string' ? message.recipient : ''
      if (recipient.startsWith('local.')) {
        if (!allowStreamText || streamToolBridgeDisabled || !streamBridge) return
        const messageId = typeof message.id === 'string' && message.id
          ? message.id.slice(0, 160)
          : ''
        const name = recipient.slice('local.'.length, 'local.'.length + 256)
        if (!messageId || !/^[a-z0-9_.:-]{1,256}$/i.test(name)) return
        let state = streamToolCalls.get(messageId)
        if (!state) {
          const accepted = streamBridge.emit(${JSON.stringify(input.requestId)}, {
            type: 'tool_call_start',
            messageId,
            name,
          })
          if (accepted !== true) {
            streamToolBridgeDisabled = true
            return
          }
          state = { name, arguments: '', done: false, disabled: false }
          streamToolCalls.set(messageId, state)
          streamToolEmitCount += 1
        } else if (state.name !== name || state.disabled) {
          state.disabled = true
          return
        }
        const argumentsValue = textFromContent(message.content).trim()
        if (!argumentsValue.startsWith(state.arguments)) {
          state.disabled = true
          return
        }
        while (state.arguments.length < argumentsValue.length) {
          let nextLength = Math.min(
            argumentsValue.length,
            state.arguments.length + ${CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS},
          )
          if (nextLength < argumentsValue.length
              && /[\\uD800-\\uDBFF]/.test(argumentsValue[nextLength - 1])
              && /[\\uDC00-\\uDFFF]/.test(argumentsValue[nextLength])) nextLength -= 1
          const accepted = streamBridge.emit(${JSON.stringify(input.requestId)}, {
            type: 'tool_call_delta',
            messageId,
            delta: argumentsValue.slice(state.arguments.length, nextLength),
          })
          if (accepted !== true) {
            streamToolBridgeDisabled = true
            return
          }
          state.arguments = argumentsValue.slice(0, nextLength)
          streamToolEmitCount += 1
        }
        const complete = argumentsValue.length > 0
          && message.status === 'finished_successfully'
          && (message.metadata?.is_complete !== false)
        if (complete && !state.done) {
          const accepted = streamBridge.emit(${JSON.stringify(input.requestId)}, {
            type: 'tool_call_done',
            messageId,
          })
          if (accepted !== true) {
            streamToolBridgeDisabled = true
            return
          }
          state.done = true
          streamToolEmitCount += 1
        }
        return
      }
      if (message.channel !== 'final') return
      streamFinalMessages += 1
      const rawText = textFromContent(message.content)
      const text = rawText.trim()
      if (!allowStreamText || streamBridgeDisabled || !streamBridge) return
      if (!text) return
      streamNonEmptyFinalMessages += 1
      const messageId = typeof message.id === 'string' && message.id
        ? message.id.slice(0, 160)
        : 'assistant-final'
      if (streamMessageId && streamMessageId !== messageId) {
        streamFinalMessageIdChanges += 1
        if (streamPreviousFinalText
            && (text.startsWith(streamPreviousFinalText) || streamPreviousFinalText.startsWith(text))) {
          streamPrefixCompatibleIdChanges += 1
        }
        if (streamedText) {
          streamBridgeDisabled = true
          return
        }
        streamPreviousFinalText = ''
      }
      streamMessageId = messageId
      if (!text.startsWith(streamedText)) {
        streamBridgeDisabled = true
        return
      }
      streamPreviousFinalText = text
      const safeLength = text.length
      while (streamedText.length < safeLength) {
        let nextLength = Math.min(
          safeLength,
          streamedText.length + ${CHATGPT_WEB_WM_STREAM_MAX_DELTA_CHARS},
        )
        if (nextLength < safeLength && /[\\uD800-\\uDBFF]/.test(text[nextLength - 1]) &&
            /[\\uDC00-\\uDFFF]/.test(text[nextLength])) nextLength -= 1
        const accepted = streamBridge.emit(${JSON.stringify(input.requestId)}, {
          type: 'text_delta',
          messageId,
          delta: text.slice(streamedText.length, nextLength),
        })
        if (accepted !== true) {
          streamBridgeDisabled = true
          return
        }
        streamedText = text.slice(0, nextLength)
        streamEmitCount += 1
      }
    }
    const rememberPatchMessage = (message) => {
      if (message?.author?.role !== 'assistant' || typeof message.id !== 'string' || !message.id) return
      const messageId = message.id
      const text = textFromContent(message.content)
      const previous = streamPatchMessages.get(messageId)
      streamPatchMessages.set(messageId, {
        message,
        text: text || previous?.text || '',
      })
      activeStreamPatchMessageId = messageId
    }
    const patchMessageId = (patch, path) => {
      const direct = [
        patch?.message_id,
        patch?.messageId,
        patch?.message?.id,
        patch?.v?.message?.id,
        patch?.value?.message?.id,
      ].find((value) => typeof value === 'string' && streamPatchMessages.has(value))
      if (direct) return direct
      if (typeof path === 'string') {
        for (const messageId of streamPatchMessages.keys()) {
          if (path.includes(messageId)) return messageId
        }
      }
      return activeStreamPatchMessageId
    }
    const applyTransportPatch = (patch, allowStreamText = false) => {
      if (!patch || typeof patch !== 'object') return
      if (Array.isArray(patch)) {
        for (const entry of patch) {
          if (Array.isArray(entry)) {
            const operations = new Set(['add', 'append', 'replace', 'patch'])
            if (typeof entry[0] === 'string' && operations.has(entry[0])) {
              applyTransportPatch({ op: entry[0], path: entry[1], value: entry[2] }, allowStreamText)
            } else if (typeof entry[1] === 'string' && operations.has(entry[1])) {
              applyTransportPatch({ path: entry[0], op: entry[1], value: entry[2] }, allowStreamText)
            }
          } else {
            applyTransportPatch(entry, allowStreamText)
          }
        }
        return
      }
      const operation = typeof patch.o === 'string' ? patch.o : patch.op
      const path = typeof patch.p === 'string' ? patch.p : patch.path
      const value = Object.hasOwn(patch, 'v') ? patch.v : patch.value
      if (operation === 'patch' && Array.isArray(value)) {
        // The outer inspector walks the nested value next. Applying it here as well
        // duplicates append operations in the downstream Responses stream.
        return
      }
      const textPartPath = '/message/content/parts/0'
      const messageId = patchMessageId(patch, path)
      const state = messageId ? streamPatchMessages.get(messageId) : null
      const patchMessage = state?.message
      const patchRecipient = typeof patchMessage?.recipient === 'string'
        ? patchMessage.recipient
        : ''
      if (typeof path !== 'string' ||
          (path !== textPartPath && !path.endsWith(textPartPath)) ||
          patchMessage?.author?.role !== 'assistant' ||
          (patchMessage.channel !== 'final' && !patchRecipient.startsWith('local.'))) return
      if (operation === 'append' && typeof value === 'string') state.text += value
      else if ((operation === 'add' || operation === 'replace') && typeof value === 'string') {
        state.text = value
      } else {
        return
      }
      inspectStreamMessage({
        ...patchMessage,
        content: { content_type: 'text', parts: [state.text] },
      }, allowStreamText)
    }
    const exportFor = (source, localName) => {
      if (!localName) return null
      for (const match of source.matchAll(/export\\s*\\{([^}]*)\\}/g)) {
        for (const specifier of match[1].split(',')) {
          const [local, exported = local] = specifier.trim().split(/\\s+as\\s+/)
          if (local === localName && exported) return exported
        }
      }
      return null
    }
    const importFor = (source, localName, baseUrl) => {
      if (!localName) return null
      for (const match of source.matchAll(/import\\{([^}]*)\\}from["']([^"']+)["']/g)) {
        for (const specifier of match[1].split(',')) {
          const [imported, local = imported] = specifier.trim().split(/\\s+as\\s+/)
          if (local === localName && imported) {
            try {
              return { module: new URL(match[2], baseUrl).href, exported: imported }
            } catch {}
          }
        }
      }
      return null
    }
    const localForExport = (source, exportedName) => {
      if (!exportedName) return null
      for (const match of source.matchAll(/export\\s*\\{([^}]*)\\}/g)) {
        for (const specifier of match[1].split(',')) {
          const [local, exported = local] = specifier.trim().split(/\\s+as\\s+/)
          if (exported === exportedName && local) return local
        }
      }
      return null
    }
    const discoverProtocol = async () => {
      if (runtime.descriptor && (!requiresImageUpload || runtime.descriptor.upload)) {
        return runtime.descriptor
      }
      const previousDescriptor = runtime.descriptor
      const urls = new Set()
      const queue = []
      const add = (value, base = location.href) => {
        try {
          const url = new URL(value, base)
          if (url.origin !== location.origin || !/\\.js(?:$|\\?)/i.test(url.href) || urls.has(url.href)) return
          if (urls.size >= 140) return
          urls.add(url.href)
          queue.push(url.href)
        } catch {}
      }
      runtime.seedAssetUrls.forEach((value) => add(value))
      let security = previousDescriptor?.security ?? null
      let transport = previousDescriptor?.transport ?? null
      let websocketTransport = previousDescriptor?.websocketTransport ?? null
      let upload = previousDescriptor?.upload ?? null
      let websocketStateCandidate = null
      let totalBytes = 0
      let scannedAssets = 0
      let failedAssets = 0
      let securityCandidates = 0
      let transportCandidates = 0
      let websocketCandidates = 0
      let uploadCandidates = 0
      let transportSource = null
      let lastSecurityParts = null
      let lastTransportParts = null
      for (let index = 0; index < queue.length && index < 140 && totalBytes < 64 * 1024 * 1024; index += 1) {
        const url = queue[index]
        let prioritizedWebsocketCandidate = false
        let source
        try {
          const response = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: controller.signal })
          scannedAssets += 1
          if (!response.ok) {
            failedAssets += 1
            continue
          }
          source = await response.text()
        } catch (error) {
          if (controller.signal.aborted) throw error
          failedAssets += 1
          continue
        }
        totalBytes += source.length
        if (!websocketStateCandidate && source.includes('pubsub.init') &&
            source.includes('isTransportOpen')) {
          const pubsubMarker = source.indexOf('pubsub.init')
          const pubsubStart = Math.max(0, pubsubMarker - 16_000)
          const pubsubSegment = source.slice(pubsubStart, pubsubMarker + 3_000)
          const stateMatches = [...pubsubSegment.matchAll(
            /([A-Za-z_$][A-Za-z0-9_$]*)=[A-Za-z_$][A-Za-z0-9_$]*\\(e=>new [A-Za-z_$][A-Za-z0-9_$]*\\(e\\)\\)/g
          )]
          const stateMatch = stateMatches.at(-1)
          const initializerMatches = stateMatch
            ? [...pubsubSegment.slice(0, stateMatch.index).matchAll(
                /([A-Za-z_$][A-Za-z0-9_$]*)=e\\(\\(\\(\\)=>\\{/g
              )]
            : []
          const stateLocal = stateMatch?.[1]
          const initializerLocal = initializerMatches.at(-1)?.[1]
          const exported = exportFor(source, stateLocal)
          const initializer = exportFor(source, initializerLocal)
          if (exported && initializer) {
            websocketStateCandidate = { module: url, exported, initializer }
          }
        }
        for (const match of source.matchAll(
          /["']((?:https:\\/\\/(?:chatgpt\\.com|cdn\\.oaistatic\\.com))?\\/(?:cdn\\/)?assets\\/[a-z0-9._~!$&()*+,;=:@%/-]+\\.js(?:\\?[^"']*)?)["']/gi
        )) add(match[1], url)
        const conversationUiAsset = source.match(
          /import\\(\\x60(\\.\\/[a-z0-9._~!$&()*+,;=:@%/-]+\\.js)\\x60\\)[\\s\\S]{0,320}?ConversationTurns/
        )?.[1]
        if (conversationUiAsset) {
          try {
            const candidateUrl = new URL(conversationUiAsset, url)
            const existingIndex = queue.indexOf(candidateUrl.href)
            if (candidateUrl.origin === location.origin && /\\.js(?:$|\\?)/i.test(candidateUrl.href)) {
              if (existingIndex > index) {
                queue.splice(existingIndex, 1)
                queue.splice(index + 1, 0, candidateUrl.href)
                prioritizedWebsocketCandidate = true
              } else if (existingIndex < 0 && !urls.has(candidateUrl.href) && urls.size < 140) {
                urls.add(candidateUrl.href)
                queue.splice(index + 1, 0, candidateUrl.href)
                prioritizedWebsocketCandidate = true
              }
            }
          } catch {}
        }
        if (!upload && source.includes('/files/process_upload_stream') &&
            source.includes('supports_direct_azure_multipart')) {
          uploadCandidates += 1
          const uploadLocal = source.match(
            /async function\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\(e,t,n,r,i,a,o\\)\\{return\\s+[A-Za-z_$][A-Za-z0-9_$]*\\(e,t,n,r,i,a,o,\\{logged:!1\\}\\)\\}/
          )?.[1]
          const uploadExport = exportFor(source, uploadLocal)
          if (uploadExport) upload = { module: url, upload: uploadExport }
        }
        if (!websocketTransport && source.includes('conversation.turn_topic.subscribe-attempt') &&
            source.includes('conversation-turn-stream')) {
          websocketCandidates += 1
          const resumeMarker = source.indexOf('websocketTopicId')
          const resumePrefix = source.slice(Math.max(0, resumeMarker - 2_500), resumeMarker)
          const resumeMatches = [...resumePrefix.matchAll(
            /function\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\(/g
          )]
          const resumeLocal = resumeMatches.at(-1)?.[1]
          const resumeOffset = resumeLocal
            ? source.lastIndexOf('function ' + resumeLocal + '(', resumeMarker)
            : -1
          const resumeSegment = resumeOffset >= 0
            ? source.slice(resumeOffset, resumeOffset + 8_000)
            : ''
          const resume = exportFor(source, resumeLocal)
          const topicMarker = source.indexOf('conversation.turn_topic.subscribe-attempt')
          const topicPrefix = source.slice(Math.max(0, topicMarker - 12_000), topicMarker)
          const topicFunction = [...topicPrefix.matchAll(
            /function\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\(/g
          )].at(-1)?.[1]
          const topicFunctionOffset = topicFunction
            ? source.lastIndexOf('function ' + topicFunction + '(', topicMarker)
            : -1
          const topicSegment = topicFunctionOffset >= 0
            ? source.slice(topicFunctionOffset, topicFunctionOffset + 18_000)
            : ''
          const topicFactories = topicSegment.match(
            /let\\s+[A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\\(\\),[A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\\(e\\)/
          )
          const payloadParserLocal = topicSegment.match(
            /let\\s+[A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\\([A-Za-z_$][A-Za-z0-9_$]*\\.data\\)/
          )?.[1]
          const deltaDecoderLocal = resumeSegment.match(
            /([A-Za-z_$][A-Za-z0-9_$]*)\\([A-Za-z_$][A-Za-z0-9_$]*,[A-Za-z_$][A-Za-z0-9_$]*=>\\{[A-Za-z_$][A-Za-z0-9_$]*\\.stream_encoding=/
          )?.[1]
          const topicFactory = importFor(source, topicFactories?.[2], url)
          const payloadParser = importFor(source, payloadParserLocal, url)
          const deltaDecoder = importFor(source, deltaDecoderLocal, url)
          const handoffBusLocal = source.match(
            /([A-Za-z_$][A-Za-z0-9_$]*)\\.on\\(\\x60conversation-turn-handoff-control\\x60/
          )?.[1]
          const handoffBus = importFor(source, handoffBusLocal, url)
          const topicManagerMatch = source.match(
            /(?:let\\s+|,)([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\\(\\)[\\s\\S]{0,1200}?isTransportOpen:\\1\\.isTransportOpen/
          )
          const transportStateLocal = topicManagerMatch?.[2] ?? source.match(
            /([A-Za-z_$][A-Za-z0-9_$]*)\\(\\)\\.isTransportOpen/
          )?.[1]
          const transportState = importFor(source, transportStateLocal, url)
          const handoffHeader = source.includes('x-oai-stream-handoff-attempt-id')
            ? 'x-oai-stream-handoff-attempt-id'
            : null
          if (resume || (topicFactory && payloadParser && deltaDecoder)) websocketTransport = {
            ...(resume ? { module: url, resume } : {}),
            ...(topicFactory && payloadParser && deltaDecoder
              ? { topicFactory, payloadParser, deltaDecoder }
              : {}),
            ...(transportState ? { transportState } : {}),
            ...(handoffBus && handoffHeader && transportState
              ? { handoffBus, handoffHeader }
              : {}),
          }
        }
        if (!security && source.includes('/sentinel/chat-requirements/prepare') &&
            source.includes('/sentinel/chat-requirements/finalize')) {
          securityCandidates += 1
          const finalizedLocal = source.match(
            /function\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\(e=!1,t=[^)]*none[^)]*\\)\\{return\\s+[A-Za-z_$][A-Za-z0-9_$]*\\([^,]*finalized/
          )?.[1]
          const finalizedOffset = finalizedLocal ? source.indexOf('function ' + finalizedLocal + '(') : -1
          const sentinelSegment = finalizedOffset >= 0 ? source.slice(finalizedOffset, finalizedOffset + 15_000) : ''
          const initializerLocal = sentinelSegment.match(
            /var\\s+(?:[A-Za-z_$][A-Za-z0-9_$]*,)*([A-Za-z_$][A-Za-z0-9_$]*)=e\\(\\(\\(\\)=>\\{[\\s\\S]{0,8000}?OpenAI-Sentinel-Chat-Requirements-Token/
          )?.[1]
          const providers = source.match(
            /Promise\\.all\\(\\[([A-Za-z_$][A-Za-z0-9_$]*)\\.getEnforcementToken\\(t,\\{forceSync:!0\\}\\),([A-Za-z_$][A-Za-z0-9_$]*)\\.getEnforcementToken\\(t\\)\\]\\)/
          )
          const descriptor = {
            module: url,
            finalized: exportFor(source, finalizedLocal),
            initializer: exportFor(source, initializerLocal),
            proofProvider: exportFor(source, providers?.[1]),
            turnstileProvider: exportFor(source, providers?.[2]),
          }
          lastSecurityParts = {
            finalizedLocal: Boolean(finalizedLocal),
            finalized: Boolean(descriptor.finalized),
            initializerLocal: Boolean(initializerLocal),
            initializer: Boolean(descriptor.initializer),
            providers: Boolean(providers),
            proofProvider: Boolean(descriptor.proofProvider),
            turnstileProvider: Boolean(descriptor.turnstileProvider),
          }
          if (descriptor.finalized && descriptor.initializer && descriptor.proofProvider && descriptor.turnstileProvider) {
            security = descriptor
          }
        }
        if (!transport && source.includes('/f/conversation') && source.includes('initialOpenTimeoutMs')) {
          transportCandidates += 1
          const streamMatch = source.match(
            /async function\\*([A-Za-z_$][A-Za-z0-9_$]*)\\(e,\\{shouldRetry:[\\s\\S]{0,600}?retryConfig:\\{MIN_RETRY_INTERVAL:/
          )
          const streamOffset = streamMatch?.index ?? -1
          const streamSegment = streamOffset >= 0 ? source.slice(streamOffset, streamOffset + 8_000) : ''
          const initializerLocal = streamSegment.match(
            /}var\\s+(?:[A-Za-z_$][A-Za-z0-9_$]*,)*([A-Za-z_$][A-Za-z0-9_$]*)=e\\(\\(\\(\\)=>/
          )?.[1]
          const descriptor = {
            module: url,
            stream: exportFor(source, streamMatch?.[1]),
            initializer: exportFor(source, initializerLocal),
          }
          lastTransportParts = {
            streamLocal: Boolean(streamMatch?.[1]),
            stream: Boolean(descriptor.stream),
            initializerLocal: Boolean(initializerLocal),
            initializer: Boolean(descriptor.initializer),
          }
          if (descriptor.stream && descriptor.initializer) transport = descriptor
          if (descriptor.stream && descriptor.initializer) transportSource = source
        }
        if (security && transport && (!requiresImageUpload || upload) &&
            (websocketTransport || (scannedAssets >= 24 && !prioritizedWebsocketCandidate))) break
      }
      if (!security || !transport) {
        throw new Error('Current ChatGPT frontend does not expose the required Web WM protocol: ' + JSON.stringify({
          scannedAssets,
          failedAssets,
          totalBytes,
          securityCandidates,
          transportCandidates,
          websocketCandidates,
          uploadCandidates,
          securityResolved: Boolean(security),
          transportResolved: Boolean(transport),
          lastSecurityParts,
          lastTransportParts,
        }))
      }
      if (requiresImageUpload && !upload) {
        throw new Error('Current ChatGPT frontend does not expose its multimodal upload protocol: ' + JSON.stringify({
          scannedAssets,
          failedAssets,
          totalBytes,
          uploadCandidates,
        }))
      }
      const deltaDescriptor = websocketTransport?.deltaDecoder
      if (deltaDescriptor?.module && deltaDescriptor?.exported) {
        let deltaSource = deltaDescriptor.module === transport?.module ? transportSource : null
        if (!deltaSource) {
          try {
            const response = await fetch(deltaDescriptor.module, {
              credentials: 'include', cache: 'force-cache', signal: controller.signal,
            })
            if (response.ok) deltaSource = await response.text()
          } catch (error) {
            if (controller.signal.aborted) throw error
          }
        }
        const deltaLocal = deltaSource
          ? localForExport(deltaSource, deltaDescriptor.exported)
          : null
        const deltaOffset = deltaLocal && deltaSource
          ? deltaSource.indexOf('function ' + deltaLocal + '(')
          : -1
        const initializerMatches = deltaOffset >= 0
          ? [...deltaSource.slice(Math.max(0, deltaOffset - 5_000), deltaOffset).matchAll(
              /([A-Za-z_$][A-Za-z0-9_$]*)=e\\(\\(\\(\\)=>\\{/g
            )]
          : []
        const initializer = deltaSource
          ? exportFor(deltaSource, initializerMatches.at(-1)?.[1])
          : null
        if (initializer) deltaDescriptor.initializer = initializer
      }
      const discoveredState = websocketTransport?.transportState
      if (discoveredState && websocketStateCandidate &&
          discoveredState.module === websocketStateCandidate.module &&
          discoveredState.exported === websocketStateCandidate.exported) {
        websocketTransport.transportState = websocketStateCandidate
      }
      runtime.descriptor = { security, transport, websocketTransport, upload }
      return runtime.descriptor
    }
    const ensureWebsocketTransportOpen = async (descriptor, waitMs = 0) => {
      const transportState = descriptor.websocketTransport?.transportState
      if (!transportState?.module || !transportState?.exported) return false
      try {
        const module = await import(transportState.module)
        const initialize = module?.[transportState.initializer]
        if (typeof initialize === 'function') initialize()
        const factory = module?.[transportState.exported]
        const manager = typeof factory === 'function' ? factory() : null
        if (!manager) return false
        if (!manager.ws && typeof manager.init === 'function') {
          const initialization = manager.init()
          if (initialization && typeof initialization.then === 'function') await initialization
        }
        if (!manager.isTransportOpen && waitMs > 0 && typeof manager.onConnect === 'function') {
          await new Promise((resolve) => {
            let settled = false
            let unsubscribe = () => undefined
            const finish = () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              unsubscribe()
              resolve(undefined)
            }
            const timer = setTimeout(finish, waitMs)
            unsubscribe = manager.onConnect(finish)
          })
        }
        return manager.isTransportOpen === true
      } catch {
        return false
      }
    }
    const payloadError = (payload, fallback) => ({
      code: typeof payload?.code === 'string' ? payload.code :
        typeof payload?.error?.code === 'string' ? payload.error.code : undefined,
      message: typeof payload?.detail === 'string' ? payload.detail :
        typeof payload?.detail?.message === 'string' ? payload.detail.message :
        typeof payload?.error?.message === 'string' ? payload.error.message : fallback,
    })
    const imageDimensions = async (blob) => {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob)
        try {
          return { width: bitmap.width, height: bitmap.height }
        } finally {
          bitmap.close()
        }
      }
      const objectUrl = URL.createObjectURL(blob)
      try {
        return await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
          image.onerror = () => reject(new Error('ChatGPT Web WM could not decode an input image.'))
          image.src = objectUrl
        })
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
    const materializePendingImages = async (images, descriptor) => {
      if (!Array.isArray(images) || images.length === 0) return []
      const uploadDescriptor = descriptor.upload
      if (!uploadDescriptor?.module || !uploadDescriptor?.upload) {
        throw new Error('ChatGPT Web WM multimodal upload protocol is unavailable.')
      }
      const uploadModule = await import(uploadDescriptor.module)
      const uploadFile = uploadModule?.[uploadDescriptor.upload]
      if (typeof uploadFile !== 'function') {
        throw new Error('Resolved ChatGPT Web WM upload function is not callable.')
      }
      runtime.uploadedImages ??= new Map()
      const uploadOne = async (pending) => {
        if (controller.signal.aborted) throw controller.signal.reason
        const imageUrl = typeof pending?.imageUrl === 'string' ? pending.imageUrl : ''
        if (!imageUrl.startsWith('data:image/')) {
          throw new Error('ChatGPT Web WM accepts inline image data URLs only.')
        }
        const response = await fetch(imageUrl, { signal: controller.signal })
        if (!response.ok) throw new Error('ChatGPT Web WM could not read an input image.')
        const blob = await response.blob()
        const mimeType = blob.type.toLowerCase().split(';', 1)[0]
        const extensions = {
          'image/gif': 'gif',
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
        }
        const extension = extensions[mimeType]
        if (!extension || blob.size === 0) {
          throw new Error('ChatGPT Web WM received an unsupported or empty input image.')
        }
        const bytes = await blob.arrayBuffer()
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        const cacheKey = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')
        const cached = runtime.uploadedImages.get(cacheKey)
        if (cached) {
          runtime.uploadedImages.delete(cacheKey)
          runtime.uploadedImages.set(cacheKey, cached)
          return cached
        }
        const dimensions = await imageDimensions(blob)
        if (!(dimensions.width > 0 && dimensions.height > 0)) {
          throw new Error('ChatGPT Web WM received an image with invalid dimensions.')
        }
        const temporaryId = crypto.randomUUID()
        const file = new File(
          [bytes],
          'stone-wm-' + temporaryId + '.' + extension,
          { type: mimeType, lastModified: Date.now() },
        )
        let fileId = ''
        let uploaded = false
        let uploadError = ''
        const handlers = {
          onFileCreated: (_tempId, value) => {
            if (typeof value === 'string') fileId = value
          },
          onFileUploadProgress: () => undefined,
          onFileUploaded: (_tempId, value) => {
            if (typeof value === 'string') fileId = value
            uploaded = true
          },
          onError: (_tempId, _status, code) => {
            uploadError = typeof code === 'string' ? code : 'image_upload_failed'
          },
          onLibraryFileReused: () => false,
        }
        await uploadFile(
          temporaryId,
          file,
          undefined,
          undefined,
          { kind: 'multimodal' },
          handlers,
          {
            imageDimensions: dimensions,
            entrySurface: 'composer_replay',
            selectionMethod: 'picker',
            isTemporaryChat: false,
            isProjectThread: false,
            storeInLibrary: false,
            modelSlug: 'gpt-5.6-sol-wm',
            suppressDefaultErrorToast: true,
          },
        )
        if (controller.signal.aborted) throw controller.signal.reason
        if (!uploaded || !fileId) {
          throw new Error('ChatGPT Web WM image upload failed' + (uploadError ? ': ' + uploadError : '.'))
        }
        const asset = {
          content_type: 'image_asset_pointer',
          asset_pointer: fileId.startsWith('file_')
            ? 'sediment://' + fileId
            : 'file-service://' + fileId,
          size_bytes: file.size,
          width: dimensions.width,
          height: dimensions.height,
        }
        runtime.uploadedImages.set(cacheKey, asset)
        while (runtime.uploadedImages.size > 64) {
          const oldest = runtime.uploadedImages.keys().next().value
          if (typeof oldest !== 'string') break
          runtime.uploadedImages.delete(oldest)
        }
        return asset
      }
      const output = new Array(images.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < images.length) {
          const index = cursor
          cursor += 1
          output[index] = await uploadOne(images[index])
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(2, images.length) },
        () => worker(),
      ))
      return output
    }
    const materializeWorkMessages = async (messages, descriptor) => {
      return await Promise.all(messages.map(async (message) => {
        const images = Array.isArray(message?.stoneInputImages) ? message.stoneInputImages : []
        const { stoneInputImages: _pendingImages, ...wireMessage } = message
        if (images.length === 0) return wireMessage
        const imageParts = await materializePendingImages(images, descriptor)
        const text = wireMessage.content?.content_type === 'code'
          ? wireMessage.content.text
          : textFromContent(wireMessage.content)
        return {
          ...wireMessage,
          content: {
            content_type: 'multimodal_text',
            parts: [...imageParts, text],
          },
        }
      }))
    }
    const directWebsocketStream = async function* (websocketDescriptor, topicId, signal) {
      const [topicModule, parserModule, decoderModule] = await Promise.all([
        import(websocketDescriptor.topicFactory.module),
        import(websocketDescriptor.payloadParser.module),
        import(websocketDescriptor.deltaDecoder.module),
      ])
      const topicFactory = topicModule?.[websocketDescriptor.topicFactory.exported]
      const payloadParser = parserModule?.[websocketDescriptor.payloadParser.exported]
      const deltaDecoder = decoderModule?.[websocketDescriptor.deltaDecoder.exported]
      const initializeDeltaDecoder = decoderModule?.[websocketDescriptor.deltaDecoder.initializer]
      if (typeof initializeDeltaDecoder === 'function') initializeDeltaDecoder()
      if (typeof topicFactory !== 'function' || typeof payloadParser !== 'function' ||
          typeof deltaDecoder !== 'function') {
        throw new Error('Resolved Web WM WebSocket primitives are not callable')
      }
      const topic = topicFactory(topicId)
      if (!topic || typeof topic.subscribe !== 'function' ||
          typeof topic.onMessage !== 'function' || typeof topic.unsubscribe !== 'function') {
        throw new Error('Resolved Web WM WebSocket topic is invalid')
      }
      const queued = []
      const waiting = []
      const unsubscribers = []
      const seenStreamItemIds = new Set()
      let closed = false
      let failure = null
      let activityTimer = null
      const clearActivityTimer = () => {
        if (activityTimer) clearTimeout(activityTimer)
        activityTimer = null
      }
      const armActivityTimer = (timeoutMs) => {
        clearActivityTimer()
        activityTimer = setTimeout(() => {
          fail(new Error('Web WM WebSocket topic timed out'))
        }, timeoutMs)
      }
      const settle = () => {
        while (waiting.length > 0) {
          const waiter = waiting.shift()
          if (failure) waiter.reject(failure)
          else if (queued.length > 0) waiter.resolve({ value: queued.shift(), done: false })
          else if (closed) waiter.resolve({ value: undefined, done: true })
          else {
            waiting.unshift(waiter)
            break
          }
        }
      }
      const push = (value) => {
        if (closed || failure) return
        queued.push(value)
        settle()
      }
      const finish = () => {
        if (closed || failure) return
        clearActivityTimer()
        closed = true
        settle()
      }
      const fail = (error) => {
        if (closed || failure) return
        clearActivityTimer()
        failure = error instanceof Error ? error : new Error(String(error))
        settle()
      }
      const listen = (method, handler) => {
        if (typeof topic[method] !== 'function') return
        const unsubscribe = topic[method](handler)
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe)
      }
      const decodeEncodedItem = (encoded) => {
        if (typeof encoded !== 'string') return null
        let event
        const data = []
        for (const line of encoded.replaceAll('\\r\\n', '\\n').replaceAll('\\r', '\\n').split('\\n')) {
          if (!line || line.startsWith(':')) continue
          const separator = line.indexOf(':')
          const field = separator < 0 ? line : line.slice(0, separator)
          let value = separator < 0 ? '' : line.slice(separator + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
        return data.length > 0 ? { event, data: data.join('\\n') } : null
      }
      const rawStream = {
        [Symbol.asyncIterator]() { return this },
        next() {
          if (failure) return Promise.reject(failure)
          if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
        },
        return() {
          finish()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
      const onAbort = () => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      try {
        listen('onPotentialMissedMessages', () => {
          fail(new Error('Web WM WebSocket topic reported missed messages'))
        })
        listen('onMessage', (event) => {
          websocketTopicMessages += 1
          if (event?.type !== 'conversation-turn-stream') return
          armActivityTimer(30_000)
          const payload = event.payload
          if (payload?.type === 'done') {
            streamAuthoritativeCompletion = true
            finish()
            return
          }
          let encodedEvent
          if (payload?.type === 'stream-item') {
            const streamItemId = typeof payload.stream_item_id === 'string' ? payload.stream_item_id : ''
            const parentStreamItemId = typeof payload.parent_stream_item_id === 'string'
              ? payload.parent_stream_item_id
              : ''
            if (streamItemId && seenStreamItemIds.has(streamItemId)) return
            if (parentStreamItemId && !seenStreamItemIds.has(parentStreamItemId)) {
              fail(new Error('Web WM WebSocket topic returned an out-of-order stream item'))
              return
            }
            if (streamItemId) seenStreamItemIds.add(streamItemId)
            encodedEvent = decodeEncodedItem(payload.encoded_item)
          } else if (payload?.type === 'delta' && typeof payload.data === 'string') {
            encodedEvent = {
              ...(typeof payload.event === 'string' ? { event: payload.event } : {}),
              data: payload.data,
            }
          } else {
            return
          }
          if (!encodedEvent?.data || encodedEvent.data === '[DONE]') return
          try {
            const parsed = payloadParser(encodedEvent.data)
            if (parsed?.error) {
              const detail = payloadError(parsed, 'Web WM WebSocket returned an error')
              fail(Object.assign(new Error(detail.message), { code: detail.code }))
              return
            }
            push({
              ...(typeof encodedEvent.event === 'string' ? { event: encodedEvent.event } : {}),
              data: parsed,
            })
          } catch (error) {
            fail(error)
          }
        })
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        armActivityTimer(5_000)
        topic.subscribe({ includeAllHistory: true })
        const encodedStream = (async function* () {
          yield { event: 'delta_encoding', data: 'v1' }
          for await (const item of rawStream) yield item
        })()
        for await (const item of deltaDecoder(encodedStream, () => undefined)) yield item
      } finally {
        clearActivityTimer()
        signal.removeEventListener('abort', onAbort)
        for (const unsubscribe of unsubscribers.reverse()) {
          try { unsubscribe() } catch {}
        }
        try { topic.unsubscribe() } catch {}
      }
    }
    const turnSnapshot = (conversation, parentMessageId) => {
      const mapping = conversation?.mapping
      if (!mapping || typeof mapping !== 'object') {
        return { output: '', toolCalls: [], currentNode: null, reasoningMessageId: null }
      }
      const chain = []
      const visited = new Set()
      let nodeId = conversation.current_node
      while (typeof nodeId === 'string' && nodeId !== parentMessageId && !visited.has(nodeId)) {
        visited.add(nodeId)
        const node = mapping[nodeId]
        if (!node || typeof node !== 'object') break
        if (node.message) chain.push(node.message)
        nodeId = node.parent
      }
      const textOf = (message) => {
        return textFromContent(message?.content)
      }
      const assistants = chain.filter((message) => message?.author?.role === 'assistant')
      const workingTurnId = assistants.find((message) => (
        typeof message?.metadata?.working_turn_id === 'string'
      ))?.metadata?.working_turn_id
      // Work sends progress text on commentary/all before a local tool call.
      // Only an explicit final channel or end-turn marker is terminal text.
      const final = assistants.find((message) => message.channel === 'final' && textOf(message).trim())
        ?? assistants.find((message) => message.end_turn === true && textOf(message).trim())
      const belongsToTurn = (candidateId) => {
        const lineage = new Set()
        let current = candidateId
        while (typeof current === 'string' && !lineage.has(current)) {
          lineage.add(current)
          const node = mapping[current]
          if (!node || typeof node !== 'object') return false
          if (node.parent === parentMessageId) return true
          current = node.parent
        }
        return false
      }
      const turnMessages = Object.entries(mapping).flatMap(([id, node]) => (
        belongsToTurn(id) && node?.message ? [node.message] : []
      ))
      const turnAssistants = turnMessages.filter((message) => message?.author?.role === 'assistant')
      const scopedTurnAssistants = workingTurnId
        ? turnAssistants.filter((message) => message?.metadata?.working_turn_id === workingTurnId)
        : turnAssistants
      const scopedTurnMessages = workingTurnId
        ? turnMessages.filter((message) => message?.metadata?.working_turn_id === workingTurnId)
        : turnMessages
      const observedModel = scopedTurnMessages.map((message) => (
        typeof message?.metadata?.default_model_slug === 'string'
          ? message.metadata.default_model_slug
          : ''
      )).find(Boolean) ?? null
      const toolMessages = [...assistants, ...scopedTurnAssistants].filter((message, index, values) => (
        values.findIndex((candidate) => candidate?.id === message?.id) === index
      ))
      const reasoningMessage = toolMessages.find((message) => (
        message?.content?.content_type === 'reasoning_recap'
        || message?.content?.content_type === 'thoughts'
      ))
      const toolCalls = toolMessages.flatMap((message) => {
        const recipient = typeof message?.recipient === 'string' ? message.recipient : ''
        const id = typeof message?.id === 'string' ? message.id : ''
        const argumentsValue = textOf(message).trim()
        return recipient.startsWith('local.') && id && argumentsValue
          ? [{ id, name: recipient.slice('local.'.length), arguments: argumentsValue }]
          : []
      })
      const terminalMessages = final
        ? [final]
        : toolMessages.filter((message) => (
            typeof message?.recipient === 'string' && message.recipient.startsWith('local.')
          ))
      const finishType = terminalMessages.map((message) => (
        typeof message?.metadata?.finish_details?.type === 'string'
          ? message.metadata.finish_details.type.toLowerCase()
          : ''
      )).find(Boolean) ?? ''
      const incompleteReason = /max[_-]?(?:output[_-]?)?tokens|length/.test(finishType)
        ? 'max_output_tokens'
        : /content[_-]?filter|safety/.test(finishType) ? 'content_filter' : null
      const complete = terminalMessages.length > 0 && !incompleteReason
        && terminalMessages.every((message) => (
          message?.status === 'finished_successfully'
          && (message?.metadata?.is_complete === true || message?.end_turn === true)
        ))
      return {
        output: textOf(final).trim(),
        toolCalls,
        currentNode: typeof conversation.current_node === 'string' ? conversation.current_node : null,
        reasoningMessageId: typeof reasoningMessage?.id === 'string'
          ? reasoningMessage.id.slice(0, 160)
          : null,
        observedModel,
        complete,
        incompleteReason,
      }
    }
    let conversationId = ${JSON.stringify(input.conversationId ?? null)}
    try {
      executionStage = 'protocol-discovery'
      const descriptor = await discoverProtocol()
      const websocketTransportOpenPromise = ensureWebsocketTransportOpen(descriptor, 2_000)
      executionStage = 'sentinel-import'
      const securityModule = await import(descriptor.security.module)
      const initializeSecurity = securityModule[descriptor.security.initializer]
      const prepareSecurity = securityModule[descriptor.security.finalized]
      if (typeof initializeSecurity !== 'function' || typeof prepareSecurity !== 'function') {
        runtime.descriptor = null
        throw new Error('Resolved Web WM Sentinel initializer exports are not callable')
      }
      executionStage = 'sentinel-initialize'
      initializeSecurity()
      if (${input.discoverOnly === true}) {
        executionStage = 'sentinel-prewarm'
        await Promise.all([
          prepareSecurity(true, 'none'),
          websocketTransportOpenPromise,
        ])
        return { status: 200, ok: true }
      }
      const proofProvider = securityModule[descriptor.security.proofProvider]
      const turnstileProvider = securityModule[descriptor.security.turnstileProvider]
      if (typeof proofProvider?.getEnforcementToken !== 'function' ||
          typeof turnstileProvider?.getEnforcementToken !== 'function') {
        runtime.descriptor = null
        throw new Error('Resolved Web WM Sentinel enforcement providers are not callable')
      }
      const parentMessageId = ${JSON.stringify(input.parentMessageId ?? null)} ?? crypto.randomUUID()
      const turnTraceId = crypto.randomUUID()
      const bodyExtras = ${scriptJson(input.bodyExtras ?? {})}
      const transportModulePromise = import(descriptor.transport.module)
      const materializedInputsPromise = Promise.all([
        materializeWorkMessages(pendingWorkMessages, descriptor),
        materializePendingImages(pendingInputImages, descriptor),
      ])
      const prepareResponsePromise = fetch('/backend-api/f/conversation/prepare', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-oai-turn-trace-id': turnTraceId,
        },
        body: JSON.stringify({
          action: 'next',
          ...(conversationId ? { conversation_id: conversationId } : {}),
          parent_message_id: parentMessageId,
          model: ${JSON.stringify(WEB_WM_MODEL)},
          client_prepare_state: 'none',
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          conversation_mode: { kind: 'primary_assistant' },
          supports_buffering: true,
          supported_encodings: ['v1'],
          thinking_effort: ${JSON.stringify(input.thinkingEffort ?? 'standard')},
          ...bodyExtras,
        }),
        signal: controller.signal,
      })
      executionStage = 'sentinel-prepare'
      const chatReq = await prepareSecurity(false, 'none')
      if (!chatReq?.token) throw new Error('Sentinel did not return a finalized chat requirements token')
      void prepareSecurity(true, 'none').catch(() => undefined)
      executionStage = 'parallel-prepare'
      const [[proofToken, turnstileToken], prepareResponse, transportModule, materializedInputs] = await Promise.all([
        Promise.all([
          proofProvider.getEnforcementToken(chatReq, { forceSync: true }),
          turnstileProvider.getEnforcementToken(chatReq),
        ]),
        prepareResponsePromise,
        transportModulePromise,
        materializedInputsPromise,
      ])
      const [suppliedMessages, inputImageParts] = materializedInputs
      executionStage = 'conversation-prepare'
      const prepareText = await prepareResponse.text()
      let preparePayload
      try { preparePayload = JSON.parse(prepareText) } catch { preparePayload = null }
      const conduitToken = typeof preparePayload?.conduit_token === 'string' ? preparePayload.conduit_token : ''
      if (!prepareResponse.ok || !conduitToken) {
        const detail = payloadError(preparePayload, prepareText.slice(0, 1_000))
        return errorResult(prepareResponse.status, detail.code, detail.message)
      }

      executionStage = 'transport-import'
      const initializeTransport = transportModule[descriptor.transport.initializer]
      const requestStream = transportModule[descriptor.transport.stream]
      if (typeof initializeTransport !== 'function' || typeof requestStream !== 'function') {
        runtime.descriptor = null
        throw new Error('Resolved Web WM stream exports are not callable')
      }
      executionStage = 'transport-initialize'
      initializeTransport()
      let earlyHandoff = null
      let handoffAttemptId = null
      let rootStreamController = null
      const handoffBusDescriptor = descriptor.websocketTransport?.handoffBus
      const handoffHeader = descriptor.websocketTransport?.handoffHeader
      if (conversationId &&
          handoffBusDescriptor?.module && handoffBusDescriptor?.exported && handoffHeader) {
        const handoffModule = await import(handoffBusDescriptor.module)
        const handoffBus = handoffModule?.[handoffBusDescriptor.exported]
        if (typeof handoffBus?.on === 'function') {
          handoffAttemptId = crypto.randomUUID()
          rootStreamController = new AbortController()
          const cleanup = handoffBus.on('conversation-turn-handoff-control', (event) => {
            const payload = event?.kind === 'conversation-turn-handoff-control' ? event.payload : null
            if (!payload || payload.handoff_attempt_id !== handoffAttemptId ||
                typeof payload.conversation_id !== 'string' ||
                typeof payload.topic_id !== 'string' ||
                (!payload.topic_id.startsWith('conversation-') &&
                  !payload.topic_id.startsWith('conv-turn-low-ttl-'))) return
            earlyHandoff = {
              conversationId: payload.conversation_id,
              topicId: payload.topic_id,
            }
            rootStreamController?.abort()
          })
          if (typeof cleanup === 'function') earlyHandoffCleanup = cleanup
        }
      }
      const headers = {
        'OpenAI-Sentinel-Chat-Requirements-Token': chatReq.token,
        ...(turnstileToken ? { 'OpenAI-Sentinel-Turnstile-Token': turnstileToken } : {}),
        ...(proofToken ? { 'OpenAI-Sentinel-Proof-Token': proofToken } : {}),
        'OAI-Telemetry': globalThis.SentinelSDK?.timing?.() ?? '[1,null]',
        'OAI-Echo-Logs': '',
        'x-conduit-token': conduitToken,
        'x-oai-turn-trace-id': turnTraceId,
        ...(handoffAttemptId && handoffHeader ? { [handoffHeader]: handoffAttemptId } : {}),
      }
      const requestOptions = {
        accessToken: ${JSON.stringify(input.accessToken)},
        method: 'POST',
        headers,
        body: {
          action: 'next',
          messages: suppliedMessages.length ? suppliedMessages : [{
            id: crypto.randomUUID(),
            author: { role: 'user' },
            create_time: Date.now() / 1000,
            content: inputImageParts.length > 0
              ? { content_type: 'multimodal_text', parts: [...inputImageParts, ${JSON.stringify(input.prompt)}] }
              : { content_type: 'text', parts: [${JSON.stringify(input.prompt)}] },
            metadata: {},
          }],
          ...(conversationId ? { conversation_id: conversationId } : {}),
          parent_message_id: parentMessageId,
          model: ${JSON.stringify(WEB_WM_MODEL)},
          client_prepare_state: 'success',
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          conversation_mode: { kind: 'primary_assistant' },
          supports_buffering: true,
          supported_encodings: ['v1'],
          thinking_effort: ${JSON.stringify(input.thinkingEffort ?? 'standard')},
          ...bodyExtras,
        },
        targetBaseUrl: ${JSON.stringify(`${CHATGPT_ORIGIN}/backend-api`)},
        routeName: '/f/conversation',
        signal: rootStreamController && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([controller.signal, rootStreamController.signal])
          : controller.signal,
        initialOpenTimeoutMs: 30_000,
        idleTimeoutMs: 60_000,
        shouldRetry: () => false,
        retryConfig: {
          MIN_RETRY_INTERVAL: 300,
          MAX_RETRY_INTERVAL: 5_000,
          RETRY_FACTOR: 1.5,
          MAX_RETRY_COUNT: 0,
        },
      }
      let resumeToken = null
      let handoff = false
      let websocketTopicId = null
      let websocketAvailable = false
      let websocketUsed = false
      let websocketFailed = false
      let websocketMode = null
      let websocketError = ''
      let websocketTransportOpen = false
      let sseHandoffReceived = false
      let streamStatus = 200
      const inspect = (payload, depth = 0, seen = new Set(), allowStreamText = false) => {
        if (!payload || depth > 8) return
        if (typeof payload === 'string') {
          const encoded = payload.trim()
          if (encoded.length === 0 || encoded.length > 2 * 1024 * 1024 ||
              (encoded[0] !== '{' && encoded[0] !== '[')) return
          try { inspect(JSON.parse(encoded), depth + 1, seen, allowStreamText) } catch {}
          return
        }
        if (typeof payload !== 'object' || seen.has(payload)) return
        seen.add(payload)
        if (Array.isArray(payload)) {
          for (const entry of payload) inspect(entry, depth + 1, seen, allowStreamText)
          return
        }
        const messages = [payload, payload.message, payload.input_message, payload.v?.message, payload.v?.input_message]
        if (payload.type === 'stream-message-patch') {
          streamPatchEvents += 1
          const patches = Array.isArray(payload.patches) ? payload.patches : [payload.patches]
          streamPatchEntries += patches.filter((patch) => patch != null).length
        }
        for (const message of messages) rememberPatchMessage(message)
        applyTransportPatch(payload, allowStreamText)
        for (const message of messages) inspectStreamMessage(message, allowStreamText)
        if (typeof payload.conversation_id === 'string') conversationId = payload.conversation_id
        if (payload.type === 'resume_conversation_token' && typeof payload.token === 'string') {
          resumeToken = payload.token
        }
        if (payload.type === 'stream_handoff' && Array.isArray(payload.options)) {
          sseHandoffReceived = true
          const websocketOption = payload.options.find((option) => (
            option?.type === 'subscribe_ws_topic' && typeof option.topic_id === 'string'
          ))
          if (websocketOption) websocketTopicId = websocketOption.topic_id
          if (websocketOption || payload.options.some((option) => option?.type === 'resume_sse_endpoint')) {
            handoff = true
          }
        }
        const detail = payloadError(payload, '')
        if (detail.message && (payload.error || payload.error_code || /error|fail/i.test(payload.type ?? ''))) {
          throw Object.assign(new Error(detail.message), { code: detail.code })
        }
        for (const key of ['data', 'v', 'value', 'event', 'events', 'patches']) {
          const nested = payload[key]
          if (nested && (typeof nested === 'object' || typeof nested === 'string')) {
            inspect(nested, depth + 1, seen, allowStreamText)
          }
        }
      }
      executionStage = 'conversation-stream'
      const stream = requestStream(${JSON.stringify(`${CHATGPT_ORIGIN}/backend-api/f/conversation`)}, requestOptions)
      try {
        for await (const item of stream) {
          if ('response' in item) streamStatus = item.response.status
          else inspect(item.data)
        }
      } catch (error) {
        if (!earlyHandoff || controller.signal.aborted) throw error
      }
      if (earlyHandoff) {
        conversationId = earlyHandoff.conversationId
        websocketTopicId = earlyHandoff.topicId
        handoff = true
      }
      earlyHandoffCleanup()
      earlyHandoffCleanup = () => undefined
      if (handoff) {
        if (!conversationId) throw new Error('Web WM stream handoff is incomplete')
        executionStage = 'websocket-preflight'
        websocketTransportOpen = await websocketTransportOpenPromise
        const websocketDescriptor = descriptor.websocketTransport
        const websocketModule = websocketDescriptor?.module
          ? await import(websocketDescriptor.module)
          : null
        const websocketResume = websocketModule?.[websocketDescriptor?.resume]
        const directTopicAvailable = Boolean(
          websocketDescriptor?.topicFactory?.module && websocketDescriptor?.topicFactory?.exported &&
          websocketDescriptor?.payloadParser?.module && websocketDescriptor?.payloadParser?.exported &&
          websocketDescriptor?.deltaDecoder?.module && websocketDescriptor?.deltaDecoder?.exported
        )
        const useFrontendResume = websocketTransportOpen && typeof websocketResume === 'function'
        websocketAvailable = useFrontendResume || directTopicAvailable
        if (websocketTopicId && websocketAvailable) {
          const noop = () => undefined
          const logger = new Proxy({}, { get: () => noop })
          const tracker = new Proxy({
            logger,
            turn_trace_id: turnTraceId,
            stream_protocol: 'ws',
            getModelSlug: () => ${JSON.stringify(WEB_WM_MODEL)},
            markAuthoritativeStreamCompletion: () => { streamAuthoritativeCompletion = true },
            hasReceivedAuthoritativeStreamCompletion: () => streamAuthoritativeCompletion,
          }, {
            get: (target, key) => Object.hasOwn(target, key) ? target[key] : noop,
          })
          try {
            executionStage = 'websocket-stream'
            streamPreviousFinalText = ''
            const topicStream = useFrontendResume
              ? websocketResume(
                  {
                    conversationId,
                    model: ${JSON.stringify(WEB_WM_MODEL)},
                    websocketTopicId,
                    ...(resumeToken ? { resumeToken } : {}),
                  },
                  tracker,
                  undefined,
                  undefined,
                  controller.signal,
                  null,
                )
              : directWebsocketStream(websocketDescriptor, websocketTopicId, controller.signal)
            websocketMode = useFrontendResume ? 'frontend_resume' : 'direct_topic'
            for await (const item of topicStream) {
              websocketDecodedItems += 1
              inspect(item?.data ?? item, 0, new Set(), true)
            }
            websocketUsed = true
          } catch (error) {
            if (controller.signal.aborted) throw error
            websocketFailed = true
            websocketError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
          }
        }
        if (!websocketUsed && resumeToken) {
          executionStage = 'conversation-resume'
          const resumeStream = requestStream(${JSON.stringify(`${CHATGPT_ORIGIN}/backend-api/f/conversation/resume`)}, {
            ...requestOptions,
            headers: {
              'Content-Type': 'application/json',
              'OAI-Echo-Logs': '',
              'x-conduit-token': resumeToken,
              'x-oai-turn-trace-id': turnTraceId,
            },
            body: { conversation_id: conversationId, offset: 0 },
            signal: controller.signal,
            routeName: '/f/conversation/resume',
            initialOpenTimeoutMs: 60_000,
          })
          for await (const item of resumeStream) {
            if ('response' in item) streamStatus = item.response.status
            else inspect(item.data, 0, new Set(), true)
          }
        }
      }
      if (!conversationId) return errorResult(streamStatus, 'missing_conversation', 'Web WM returned no conversation id')
      executionStage = 'conversation-snapshot'
      const snapshotOnlyFallback = handoff && !websocketUsed && !resumeToken
      let snapshot = {
        output: '', toolCalls: [], currentNode: null, reasoningMessageId: null,
        observedModel: null, complete: false, incompleteReason: null,
      }
      const snapshotAttempts = snapshotOnlyFallback ? 84 : 24
      for (let attempt = 0; attempt < snapshotAttempts && !snapshot.complete && !snapshot.incompleteReason; attempt += 1) {
        const conversationResponse = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (conversationResponse.ok) {
          snapshot = turnSnapshot(await conversationResponse.json().catch(() => null), parentMessageId)
        }
        if (streamAuthoritativeCompletion && (snapshot.output || snapshot.toolCalls.length > 0)) break
        if (!snapshot.complete && !snapshot.incompleteReason) {
          await new Promise((resolve) => setTimeout(resolve, attempt < 24 ? 250 : 1_000))
        }
      }
      // Search turns have no continuation. Responses turns are retained by
      // the owning runtime until their previous_response_id/tool TTL expires.
      if (snapshot.output && ${input.hideOnFinal !== false}) {
        void fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_visible: false }),
        }).catch(() => undefined)
      }
      const hasOutput = Boolean(snapshot.output || snapshot.toolCalls.length)
      const successful = streamStatus >= 200 && streamStatus < 300
        && ((hasOutput && (snapshot.complete || streamAuthoritativeCompletion))
          || Boolean(snapshot.incompleteReason))
      return {
        status: streamStatus,
        ok: successful,
        conversationId,
        currentNode: snapshot.currentNode,
        reasoningMessageId: snapshot.reasoningMessageId,
        observedModel: snapshot.observedModel ?? undefined,
        output: snapshot.output,
        toolCalls: snapshot.toolCalls,
        ...(snapshot.incompleteReason ? { incompleteReason: snapshot.incompleteReason } : {}),
        ...(!successful && !snapshot.incompleteReason ? {
          errorCode: streamStatus < 200 || streamStatus >= 300
            ? 'web_wm_upstream_http_error'
            : hasOutput ? 'turn_not_complete' : 'missing_turn_output',
          errorMessage: streamStatus < 200 || streamStatus >= 300
            ? 'Web WM upstream rejected the request'
            : hasOutput
              ? 'Web WM returned output before the Work turn reached a completed state'
              : 'Web WM conversation completed without readable text or a client tool call',
        } : {}),
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(${input.streamText === true} ? {
          streamDiagnostics: {
            bridgeAvailable: Boolean(streamBridge),
            finalMessages: streamFinalMessages,
            nonEmptyFinalMessages: streamNonEmptyFinalMessages,
            finalMessageIdChanges: streamFinalMessageIdChanges,
            prefixCompatibleIdChanges: streamPrefixCompatibleIdChanges,
            reasoningMessages: streamReasoningMessageIds.size,
            emittedChars: streamedText.length,
            emitCount: streamEmitCount,
            bridgeDisabled: streamBridgeDisabled,
            toolCalls: streamToolCalls.size,
            toolEmitCount: streamToolEmitCount,
            toolBridgeDisabled: streamToolBridgeDisabled,
            patchEvents: streamPatchEvents,
            patchEntries: streamPatchEntries,
            continuationRequested: Boolean(${JSON.stringify(input.conversationId ?? null)}),
            websocketTransportOpen,
            handoffBusAvailable: Boolean(handoffBusDescriptor?.module && handoffBusDescriptor?.exported),
            handoffHeaderAvailable: Boolean(handoffHeader),
            handoffAttempted: Boolean(handoffAttemptId),
            handoffReceived: Boolean(earlyHandoff),
            sseHandoffReceived,
            websocketAvailable,
            websocketUsed,
            websocketFailed,
            snapshotOnlyFallback,
            authoritativeCompletion: streamAuthoritativeCompletion,
            websocketTopicMessages,
            websocketDecodedItems,
            ...(websocketMode ? { websocketMode } : {}),
            ...(websocketError ? { websocketError } : {}),
          },
        } : {}),
      }
    } catch (error) {
      if (controller.signal.aborted) throw error
      const body = error?.body ?? error?.data ?? error?.responseBody
      const detail = payloadError(body, error instanceof Error ? error.message : String(error))
      return errorResult(
        error?.status ?? error?.statusCode ?? 502,
        error?.code ?? detail.code,
        '[' + executionStage + '] ' + detail.message,
      )
    } finally {
      clearTimeout(timer)
      try { earlyHandoffCleanup() } catch {}
      runtime.controllers.delete(${JSON.stringify(input.requestId)})
    }
  })()`
}

const WEB_WM_SUPPORTED_TOOL_TYPES = new Set(['function', 'custom', 'namespace', 'tool_search'])
const WEB_WM_SUPPORTED_INPUT_TYPES = new Set([
  'additional_tools',
  'agent_message',
  'custom_tool_call',
  'custom_tool_call_output',
  'function_call',
  'function_call_output',
  'message',
  'reasoning',
  'tool_search_call',
  'tool_search_output',
])
const WEB_WM_SUPPORTED_CONTENT_TYPES = new Set([
  'encrypted_content', 'input_image', 'input_text', 'output_text', 'refusal', 'text',
])
const WEB_WM_DATA_IMAGE_URL = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\r\n]+$/i

function validateWebWmResponsesBody(body: Record<string, unknown>): void {
  if (body.background === true) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM does not support background Responses.',
      'background',
    )
  }
  if (body.store === true) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM cannot provide stored Responses retrieval semantics.',
      'store',
    )
  }
  if (body.conversation !== undefined && body.conversation !== null) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM supports previous_response_id continuation, not Responses conversation objects.',
      'conversation',
    )
  }
  const reasoning = objectValue(body.reasoning)
  if (body.reasoning !== undefined && body.reasoning !== null && !reasoning) {
    throw new WebWmResponsesRequestError(
      'invalid_request_error',
      'Responses reasoning must be an object.',
      'reasoning',
    )
  }
  if (reasoning?.effort !== undefined && reasoning.effort !== null
    && !WEB_WM_RESPONSES_REASONING_EFFORTS.has(String(reasoning.effort))) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM cannot map this Responses reasoning effort.',
      'reasoning.effort',
    )
  }
  if (reasoning?.summary !== undefined && reasoning.summary !== null
    && !WEB_WM_RESPONSES_REASONING_SUMMARIES.has(String(reasoning.summary))) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM cannot map this Responses reasoning summary mode.',
      'reasoning.summary',
    )
  }
  if (reasoning?.context !== undefined && reasoning.context !== null
    && reasoning.context !== 'all_turns') {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM supports only all_turns reasoning context.',
      'reasoning.context',
    )
  }
  for (const [field, message] of [
    ['context_management', 'ChatGPT Web WM does not expose Responses context management.'],
    ['prompt', 'ChatGPT Web WM does not support Responses prompt templates.'],
    ['max_output_tokens', 'ChatGPT Web WM cannot enforce an exact Responses output-token limit.'],
    ['max_tool_calls', 'ChatGPT Web WM cannot enforce an exact Responses tool-call limit.'],
  ] as const) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new WebWmResponsesRequestError('unsupported_web_wm_feature', message, field)
    }
  }
  if (body.truncation !== undefined && body.truncation !== null && body.truncation !== 'disabled') {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM does not expose Responses automatic truncation.',
      'truncation',
    )
  }
  const fixedNumericOptions: Array<[string, number]> = [
    ['frequency_penalty', 0],
    ['presence_penalty', 0],
    ['temperature', 1],
    ['top_logprobs', 0],
    ['top_p', 0.98],
  ]
  for (const [field, supported] of fixedNumericOptions) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== supported) {
      throw new WebWmResponsesRequestError(
        'unsupported_web_wm_feature',
        `ChatGPT Web WM uses a fixed ${field} value of ${supported}.`,
        field,
      )
    }
  }
  if (body.service_tier !== undefined && body.service_tier !== null
    && body.service_tier !== 'auto' && body.service_tier !== 'default') {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM supports only the default service tier.',
      'service_tier',
    )
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new WebWmResponsesRequestError('invalid_request_error', 'Responses include must be an array.', 'include')
  }
  for (const [index, value] of arrayValue(body.include).entries()) {
    if (value !== 'reasoning.encrypted_content') {
      throw new WebWmResponsesRequestError(
        'unsupported_web_wm_feature',
        `ChatGPT Web WM cannot provide Responses include value ${String(value)}.`,
        `include[${index}]`,
      )
    }
  }
  const text = objectValue(body.text)
  if (body.text !== undefined && body.text !== null && !text) {
    throw new WebWmResponsesRequestError(
      'invalid_request_error',
      'Responses text controls must be an object.',
      'text',
    )
  }
  const textFormat = objectValue(text?.format)
  if (textFormat && textFormat.type !== undefined && textFormat.type !== 'text') {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM currently supports only plain text response format.',
      'text.format.type',
    )
  }
  if (text?.verbosity !== undefined && text.verbosity !== null
    && !WEB_WM_RESPONSES_TEXT_VERBOSITIES.has(String(text.verbosity))) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM cannot map this Responses text verbosity.',
      'text.verbosity',
    )
  }
  if (body.response_format !== undefined) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM currently supports only plain text response format.',
      'response_format',
    )
  }

  validateWebWmToolDeclarations(body.tools, 'tools')
  for (const [index, value] of arrayValue(body.input).entries()) {
    const item = objectValue(value)
    if (!item) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type && !WEB_WM_SUPPORTED_INPUT_TYPES.has(type)) {
      throw new WebWmResponsesRequestError(
        'unsupported_web_wm_feature',
        `ChatGPT Web WM cannot replay Responses item type ${type}.`,
        `input[${index}].type`,
      )
    }
    if (type === 'additional_tools' || type === 'tool_search_output') {
      validateWebWmToolDeclarations(item.tools, `input[${index}].tools`)
    }
    const content = arrayValue(item.content)
    for (const [contentIndex, contentValue] of content.entries()) {
      const part = objectValue(contentValue)
      if (!part) continue
      const partType = typeof part.type === 'string' ? part.type : ''
      if (partType === 'encrypted_content') {
        if (type === 'agent_message' && typeof part.encrypted_content === 'string') continue
        throw new WebWmResponsesRequestError(
          'unsupported_web_wm_feature',
          'ChatGPT Web WM can preserve encrypted content only as part of a readable Codex agent message.',
          `input[${index}].content[${contentIndex}]`,
        )
      }
      if (partType === 'input_image') {
        validateWebWmInputImage(part, `input[${index}].content[${contentIndex}]`)
        continue
      }
      if ((partType && !WEB_WM_SUPPORTED_CONTENT_TYPES.has(partType))
        || part.image_url !== undefined || part.file_url !== undefined || part.file_id !== undefined) {
        throw new WebWmResponsesRequestError(
          'unsupported_web_wm_feature',
          'ChatGPT Web WM supports text and inline PNG, JPEG, WebP, or GIF input only.',
          `input[${index}].content[${contentIndex}]`,
        )
      }
    }
    for (const [outputIndex, outputValue] of arrayValue(item.output).entries()) {
      const part = objectValue(outputValue)
      if (!part || part.type !== 'input_image') continue
      validateWebWmInputImage(part, `input[${index}].output[${outputIndex}]`)
    }
  }
}

function validateWebWmInputImage(part: Record<string, unknown>, path: string): void {
  if (typeof part.image_url === 'string' && WEB_WM_DATA_IMAGE_URL.test(part.image_url)
    && part.file_url === undefined && part.file_id === undefined) return
  throw new WebWmResponsesRequestError(
    'unsupported_web_wm_feature',
    'ChatGPT Web WM currently accepts inline PNG, JPEG, WebP, or GIF data URLs only.',
    path,
  )
}

const WEB_WM_RESPONSES_REASONING_EFFORTS = new Set<string>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])
const WEB_WM_RESPONSES_REASONING_SUMMARIES = new Set<string>(['auto', 'concise', 'detailed'])
const WEB_WM_RESPONSES_TEXT_VERBOSITIES = new Set<string>(['low', 'medium', 'high'])

function webWmRequestedReasoningEffort(
  body: Record<string, unknown>,
): WebWmResponsesReasoningEffort | undefined {
  const effort = objectValue(body.reasoning)?.effort
  return typeof effort === 'string' && WEB_WM_RESPONSES_REASONING_EFFORTS.has(effort)
    ? effort as WebWmResponsesReasoningEffort
    : undefined
}

function webWmThinkingEffort(body: Record<string, unknown>): WebWmThinkingEffort {
  const effort = webWmRequestedReasoningEffort(body)
  if (effort === 'none' || effort === 'minimal' || effort === 'low') return 'min'
  if (effort === 'high') return 'extended'
  if (effort === 'xhigh' || effort === 'max' || effort === 'ultra') return effort
  return 'standard'
}

function webWmResponsesReasoningSummary(
  body: Record<string, unknown>,
): WebWmResponsesReasoningSummary {
  const summary = objectValue(body.reasoning)?.summary
  if (summary === 'auto') return 'detailed'
  return summary === 'concise' || summary === 'detailed' ? summary : null
}

function webWmRequestedTextVerbosity(
  body: Record<string, unknown>,
): WebWmResponsesTextVerbosity | undefined {
  const verbosity = objectValue(body.text)?.verbosity
  return typeof verbosity === 'string' && WEB_WM_RESPONSES_TEXT_VERBOSITIES.has(verbosity)
    ? verbosity as WebWmResponsesTextVerbosity
    : undefined
}

function webWmResponsesStyleInstruction(body: Record<string, unknown>): string {
  const verbosity = webWmRequestedTextVerbosity(body)
  if (verbosity === 'low') return 'Keep the final answer concise while preserving required technical details.'
  if (verbosity === 'high') return 'Provide a detailed final answer with all relevant technical details.'
  return verbosity === 'medium' ? 'Use a balanced level of detail in the final answer.' : ''
}

function validateWebWmToolDeclarations(value: unknown, path: string): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new WebWmResponsesRequestError('invalid_request_error', 'Tool declarations must be an array.', path)
  }
  for (const [index, entry] of value.entries()) {
    const tool = objectValue(entry)
    const type = typeof tool?.type === 'string' ? tool.type : ''
    if (!WEB_WM_SUPPORTED_TOOL_TYPES.has(type)) {
      throw new WebWmResponsesRequestError(
        'unsupported_web_wm_feature',
        `ChatGPT Web WM does not support Responses tool type ${type || '<missing>'}.`,
        `${path}[${index}].type`,
      )
    }
    if (type === 'namespace') validateWebWmToolDeclarations(tool?.tools, `${path}[${index}].tools`)
  }
}

interface WebWmResponsesToolOutput {
  callId: string
  output: unknown
}

function responseToolOutputs(body: Record<string, unknown>): WebWmResponsesToolOutput[] {
  const outputs: WebWmResponsesToolOutput[] = []
  const fingerprints = new Map<string, string>()
  for (const value of arrayValue(body.input)) {
    const item = objectValue(value)
    if (!item) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (!['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(type)) continue
    const callId = typeof item.call_id === 'string' ? item.call_id.trim() : ''
    if (!callId) continue
    const output = {
      callId,
      output: type === 'tool_search_output' ? { tools: item.tools ?? [] } : item.output,
    }
    const fingerprint = toolOutputFingerprint(output)
    const previous = fingerprints.get(callId)
    if (previous) {
      if (previous !== fingerprint) {
        throw new WebWmResponsesRequestError(
          'invalid_request_error',
          'A Responses tool call cannot have conflicting outputs in the same request.',
          'input',
        )
      }
      continue
    }
    fingerprints.set(callId, fingerprint)
    outputs.push(output)
  }
  return outputs
}

/**
 * Responses clients may manage history themselves and resend prior output
 * items without an account-local state token. Only reconstruct a fresh Work
 * conversation when every visible tool result has one unambiguous preceding
 * call of the matching kind. The history is rendered as prompt context; it is
 * never attached as a native result to an unrelated hidden conversation.
 */
function hasReplayableVisibleToolHistory(body: Record<string, unknown>): boolean {
  const calls = new Map<string, string>()
  const completed = new Set<string>()
  let outputCount = 0
  for (const value of arrayValue(body.input)) {
    const item = objectValue(value)
    if (!item) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id.trim() : ''
      if (!callId || calls.has(callId) || completed.has(callId)) return false
      calls.set(callId, type)
      continue
    }
    const expectedCallType = type === 'function_call_output'
      ? 'function_call'
      : type === 'custom_tool_call_output'
        ? 'custom_tool_call'
        : type === 'tool_search_output'
          ? 'tool_search_call'
          : undefined
    if (!expectedCallType) continue
    outputCount += 1
    const callId = typeof item.call_id === 'string' ? item.call_id.trim() : ''
    if (!callId || calls.get(callId) !== expectedCallType || completed.has(callId)) return false
    completed.add(callId)
  }
  return outputCount > 0 && completed.size === outputCount
}

function hasReplayableVisibleResponseHistory(body: Record<string, unknown>): boolean {
  if (hasReplayableVisibleToolHistory(body)) return true
  return arrayValue(body.input).some((value) => {
    const item = objectValue(value)
    const type = typeof item?.type === 'string' ? item.type : ''
    return Boolean(
      item
      && ((type === 'message' || (!type && typeof item.role === 'string'))
        ? item.role === 'assistant'
        : type === 'agent_message')
      && renderResponseContent(item.content),
    )
  })
}

function buildRecoveredWebWmResponsesPrompt(body: Record<string, unknown>): string {
  return [
    buildChatGptWebWmResponsesPrompt(body),
    '<continuation_state>\n'
      + 'The tool calls and results above are completed Responses history. '
      + 'Continue after the final provided item. Do not repeat a completed tool call unless its result '
      + 'explicitly requires a deliberate retry.\n'
      + '</continuation_state>',
  ].join('\n\n')
}

function toolOutputFingerprint(output: WebWmResponsesToolOutput): string {
  return jsonFingerprint({ callId: output.callId, output: output.output })
}

function toolOutputRequestFingerprint(body: Record<string, unknown>): string {
  return jsonFingerprint(body)
}

function jsonFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('base64url')
}

function webWmReplayResponse(replay: WebWmToolOutputReplay): Response {
  return new Response(replay.wireBody, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

function workToolResultMessage(
  output: WebWmResponsesToolOutput,
  binding: WebWmToolCallBinding,
): WebWmWorkToolResultMessage {
  const images = responseImagesFromParts(output.output)
  return {
    id: randomUUID(),
    author: { role: 'tool', name: binding.tool.wireName, metadata: {} },
    channel: 'commentary',
    content: {
      content_type: 'code',
      language: 'python3',
      text: JSON.stringify({
        call_id: output.callId,
        result: parseJsonString(toolOutputWithoutImages(output.output)),
        tool: binding.tool.wireName,
      }),
    },
    create_time: Date.now() / 1_000,
    end_turn: null,
    metadata: { is_visually_hidden_from_conversation: true },
    recipient: 'all',
    status: 'finished_successfully',
    update_time: null,
    weight: 1,
    ...(images.length > 0 ? { stoneInputImages: images } : {}),
  }
}

function workToolContinuationMessage(
  constraint: WebWmPreparedResponsesTurn['toolConstraint'],
  tools: readonly WebWmLocalTool[],
): WebWmWorkContinuationMessage | undefined {
  if (!constraint) return undefined
  const selected = constraint.wireName
    ? tools.find((tool) => tool.wireName === constraint.wireName)
    : undefined
  const target = selected
    ? selected.namespace ? `${selected.namespace}.${selected.name}` : selected.name
    : ''
  const instruction = target
    ? `Continue by calling the declared client tool named ${target}. Do not answer before making that tool call.`
    : 'Continue by calling at least one declared client tool. Do not answer before making a tool call.'
  return {
    id: randomUUID(),
    author: { role: 'user' },
    content: { content_type: 'text', parts: [instruction] },
    create_time: Date.now() / 1_000,
    metadata: { is_visually_hidden_from_conversation: true },
  }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toolOutputWithoutImages(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const filtered = value.filter((entry) => objectValue(entry)?.type !== 'input_image')
  return filtered.length > 0 ? filtered : { images_attached: responseImagesFromParts(value).length }
}

function responseInputImages(body: Record<string, unknown>): WebWmPendingImage[] {
  return arrayValue(body.input).flatMap((value) => {
    const item = objectValue(value)
    if (!item) return []
    return [
      ...responseImagesFromParts(item.content),
      ...responseImagesFromParts(item.output),
    ]
  })
}

function responseImagesFromParts(value: unknown): WebWmPendingImage[] {
  return arrayValue(value).flatMap((entry) => {
    const part = objectValue(entry)
    if (part?.type !== 'input_image' || typeof part.image_url !== 'string'
      || !WEB_WM_DATA_IMAGE_URL.test(part.image_url)) return []
    return [{
      imageUrl: part.image_url,
      ...(typeof part.detail === 'string' ? { detail: part.detail } : {}),
    }]
  })
}

function responsesBodyAfterReasoningState(
  body: Record<string, unknown>,
  reasoningInputIndex: number,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body
  const continuation = body.input.slice(reasoningInputIndex + 1)
  while (continuation.length > 0 && isPriorResponseOutput(continuation[0])) continuation.shift()
  return { ...body, input: continuation }
}

function responsesBodyWithoutUnavailableReasoningState(
  body: Record<string, unknown>,
  reasoningInputIndex: number,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body
  return {
    ...body,
    input: body.input.filter((_value, index) => index !== reasoningInputIndex),
  }
}

function responsesBodyAfterLatestAssistantMessage(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body
  let latestAssistantIndex = -1
  for (const [index, value] of body.input.entries()) {
    const item = objectValue(value)
    if (!item) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if ((type === 'message' || (!type && typeof item.role === 'string'))
      && item.role === 'assistant') {
      latestAssistantIndex = index
    }
  }
  return latestAssistantIndex >= 0
    ? { ...body, input: body.input.slice(latestAssistantIndex + 1) }
    : body
}

function isPriorResponseOutput(value: unknown): boolean {
  const item = objectValue(value)
  if (!item) return false
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'reasoning' || type === 'compaction' || type === 'item_reference') return true
  if (type === 'message' || (!type && typeof item.role === 'string')) return item.role === 'assistant'
  return type.endsWith('_call') && !type.endsWith('_call_output')
}

function renderResponsesInput(value: unknown): string {
  if (typeof value === 'string') return `[user]\n${value.trim()}`.trim()
  if (!Array.isArray(value)) return renderUnknownValue(value)
  return value.map((entry) => renderResponsesItem(entry)).filter(Boolean).join('\n\n')
}

function renderResponsesItem(value: unknown): string {
  const item = objectValue(value)
  if (!item) return renderUnknownValue(value)
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'message' || (!type && typeof item.role === 'string')) {
    const role = typeof item.role === 'string' ? item.role : 'user'
    return `[${role}]\n${renderResponseContent(item.content)}`.trim()
  }
  if (type === 'agent_message') {
    const author = typeof item.author === 'string' ? item.author : 'agent'
    const recipient = typeof item.recipient === 'string' ? item.recipient : 'agent'
    return `[agent message ${author} -> ${recipient}]\n${renderResponseContent(item.content)}`.trim()
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = typeof item.name === 'string' ? item.name : 'unknown_tool'
    const namespace = typeof item.namespace === 'string' ? `${item.namespace}.` : ''
    const callId = typeof item.call_id === 'string' ? ` ${item.call_id}` : ''
    const payload = type === 'custom_tool_call' ? item.input : item.arguments
    return `[assistant tool call ${namespace}${name}${callId}]\n${renderUnknownValue(payload)}`
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const callId = typeof item.call_id === 'string' ? item.call_id : 'unknown'
    return `[tool result ${callId}]\n${renderUnknownValue(toolOutputWithoutImages(item.output))}`
  }
  if (type === 'tool_search_call') {
    return `[assistant tool catalog search ${String(item.call_id ?? '')}]\n${renderUnknownValue(item.arguments)}`
  }
  if (type === 'tool_search_output') {
    return `[tool catalog result ${String(item.call_id ?? '')}]\n${renderUnknownValue(item.tools)}`
  }
  if (type === 'reasoning') {
    const summary = renderResponseContent(item.summary)
    return summary ? `[assistant reasoning summary]\n${summary}` : ''
  }
  if (type === 'compaction') return ''
  return `[${type || 'input'}]\n${renderUnknownValue(item)}`
}

function renderResponseContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return renderUnknownValue(value)
  return value.map((entry) => {
    if (typeof entry === 'string') return entry
    const part = objectValue(entry)
    if (!part) return renderUnknownValue(entry)
    if (part.type === 'encrypted_content') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.refusal === 'string') return part.refusal
    if (typeof part.image_url === 'string') return '[attached image]'
    if (typeof part.file_url === 'string') return `[file: ${part.file_url}]`
    return renderUnknownValue(part)
  }).filter(Boolean).join('\n')
}

function renderUnknownValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function renderToolChoice(value: unknown): string {
  if (value === undefined || value === null || value === 'auto') return ''
  if (value === 'none') return 'Do not call a client tool in this turn.'
  if (value === 'required') return 'Call at least one declared client tool before producing a final answer.'
  const choice = objectValue(value)
  if (!choice) return renderUnknownValue(value)
  const name = typeof choice.name === 'string'
    ? choice.name
    : typeof objectValue(choice.function)?.name === 'string'
      ? objectValue(choice.function)?.name as string
      : ''
  return name ? `Call the declared client tool named ${name}.` : renderUnknownValue(choice)
}

function webWmToolConstraint(
  value: unknown,
  tools: readonly WebWmLocalTool[],
): { wireName?: string } | undefined {
  if (value === undefined || value === null || value === 'auto' || value === 'none') return undefined
  if (value === 'required') {
    if (tools.length === 0) {
      throw new WebWmResponsesRequestError(
        'invalid_request_error',
        'Responses tool_choice required needs at least one declared client tool.',
        'tool_choice',
      )
    }
    return {}
  }
  const choice = objectValue(value)
  if (!choice) {
    throw new WebWmResponsesRequestError(
      'unsupported_web_wm_feature',
      'ChatGPT Web WM does not support this Responses tool_choice value.',
      'tool_choice',
    )
  }
  const type = typeof choice.type === 'string' ? choice.type : ''
  const nestedFunction = objectValue(choice.function)
  const name = cleanToolName(choice.name ?? nestedFunction?.name)
  const namespace = cleanToolName(choice.namespace)
  const matched = type === 'tool_search'
    ? tools.find((tool) => tool.kind === 'tool_search')
    : tools.find((tool) => (
        (type === 'function' || type === 'custom')
        && tool.kind === type
        && (tool.name === name || tool.wireName === name)
        && (!namespace || tool.namespace === namespace)
      ))
  if (!matched) {
    const supportedChoice = type === 'tool_search'
      || ((type === 'function' || type === 'custom') && Boolean(name))
    throw new WebWmResponsesRequestError(
      supportedChoice ? 'invalid_request_error' : 'unsupported_web_wm_feature',
      supportedChoice
        ? 'Responses tool_choice must select a declared client tool.'
        : 'ChatGPT Web WM does not support this Responses tool_choice object.',
      'tool_choice',
    )
  }
  return { wireName: matched.wireName }
}

function workFunctionSignature(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = objectValue(parameters.properties) ?? {}
  const required = new Set(arrayValue(parameters.required).filter((value): value is string => (
    typeof value === 'string'
  )))
  return {
    name,
    description: description || `Call the client tool ${name}.`,
    params: Object.entries(properties).map(([parameterName, schema]) => ({
      name: parameterName,
      required: required.has(parameterName),
      type: objectValue(schema) ?? { type: 'string' },
    })),
    type: 'kwargs',
  }
}

function cleanToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}

function uniqueWorkToolName(value: string, used: Set<string>): string {
  const base = value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 120)
    || 'client_tool'
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 112)}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function customToolInput(argumentsValue: string): string {
  const parsed = parseJsonString(argumentsValue)
  const object = objectValue(parsed)
  return object && typeof object.input === 'string' && Object.keys(object).every((key) => key === 'input')
    ? object.input
    : argumentsValue
}

function partialCustomToolInput(argumentsValue: string): string | undefined {
  const header = /^\s*\{\s*"input"\s*:\s*"/.exec(argumentsValue)
  if (!header) return argumentsValue.length <= 32 ? '' : undefined
  let decoded = ''
  for (let index = header[0].length; index < argumentsValue.length; index += 1) {
    const character = argumentsValue[index]
    if (character === '"') return decoded
    if (character !== '\\') {
      if (character.charCodeAt(0) < 0x20) return undefined
      decoded += character
      continue
    }
    if (index + 1 >= argumentsValue.length) return decoded
    const escaped = argumentsValue[index + 1]
    const simpleEscapes: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    }
    if (Object.hasOwn(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped]
      index += 1
      continue
    }
    if (escaped !== 'u' || index + 5 >= argumentsValue.length) return decoded
    const hex = argumentsValue.slice(index + 2, index + 6)
    if (!/^[0-9a-f]{4}$/i.test(hex)) return undefined
    decoded += String.fromCharCode(Number.parseInt(hex, 16))
    index += 5
  }
  return decoded
}

function toolSearchArguments(argumentsValue: string): Record<string, unknown> {
  return objectValue(parseJsonString(argumentsValue)) ?? { query: argumentsValue }
}

interface WebWmStreamingToolCall {
  sourceMessageId: string
  tool: WebWmLocalTool
  outputIndex: number
  itemId: string
  callId: string
  rawArguments: string
  streamedCustomInput: string
  customInputStreamingDisabled: boolean
  done: boolean
}

class WebWmResponsesEventStream {
  public readonly response: Response
  public readonly reasoningEncryptedContent?: string

  private readonly model: string
  private readonly createdAt = Math.floor(Date.now() / 1_000)
  private readonly output: Record<string, unknown>[] = []
  private readonly encoder = new TextEncoder()
  private readonly reasoningItemId = `rs_${randomUUID().replaceAll('-', '')}`
  private readonly textItemId = `msg_${randomUUID().replaceAll('-', '')}`
  private readonly reasoningConfiguration?: Record<string, unknown>
  private readonly requestBody: Record<string, unknown>
  private readonly includeObfuscation: boolean
  private readonly toolCalls = new Map<string, WebWmStreamingToolCall>()
  private controller?: ReadableStreamDefaultController<Uint8Array>
  private sequenceNumber = 0
  private textOutput = ''
  private textMessageId?: string
  private reasoningObserved = false
  private reasoningStarted = false
  private reasoningFinished = false
  private textStarted = false
  private closed = false
  private cancellationNotified = false
  private terminalUsage?: WebWmResponsesUsage
  private wire = ''

  public get wireBody(): string {
    return this.wire
  }

  public constructor(
    body: Record<string, unknown>,
    private readonly responseId: string,
    private readonly tools: readonly WebWmLocalTool[],
    private readonly onCancel: (reason?: unknown) => void,
  ) {
    this.requestBody = body
    this.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : WEB_WM_MODEL
    this.includeObfuscation = objectValue(body.stream_options)?.include_obfuscation !== false
    const reasoningEffort = webWmRequestedReasoningEffort(body) ?? 'medium'
    this.reasoningConfiguration = {
      context: 'all_turns',
      effort: reasoningEffort,
      mode: 'standard',
      summary: webWmResponsesReasoningSummary(body),
    }
    if (arrayValue(body.include).includes('reasoning.encrypted_content')) {
      this.reasoningEncryptedContent = `wmrs_${randomBytes(96).toString('base64url')}`
    }
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
        this.event('response.created', { response: this.envelope('in_progress', []) })
        this.event('response.in_progress', { response: this.envelope('in_progress', []) })
      },
      cancel: (reason) => {
        this.closed = true
        this.notifyCancellation(reason)
      },
    })
    this.response = new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    })
  }

  public appendTextDelta(messageId: string, delta: string): void {
    if (this.closed || !delta) return
    if (this.textMessageId && this.textMessageId !== messageId) return
    this.textMessageId ??= messageId
    this.appendText(delta)
  }

  public observeReasoning(messageId: string): void {
    if (this.closed || this.reasoningObserved || !messageId) return
    this.reasoningObserved = true
    if (!this.textStarted) this.startReasoning()
  }

  public startToolCall(messageId: string, wireName: string): void {
    if (this.closed || this.toolCalls.has(messageId)) return
    const tool = this.tools.find((candidate) => candidate.wireName === wireName)
    if (!tool) return
    this.finishPendingReasoning()
    const outputIndex = this.output.length
    const itemPrefix = tool.kind === 'tool_search' ? 'tsc' : tool.kind === 'custom' ? 'ctc' : 'fc'
    const state: WebWmStreamingToolCall = {
      sourceMessageId: messageId,
      tool,
      outputIndex,
      itemId: `${itemPrefix}_${randomUUID().replaceAll('-', '')}`,
      callId: `call_${randomUUID().replaceAll('-', '')}`,
      rawArguments: '',
      streamedCustomInput: '',
      customInputStreamingDisabled: false,
      done: false,
    }
    this.toolCalls.set(messageId, state)
    const item = this.toolItem(state, 'in_progress')
    this.output.push(item)
    this.event('response.output_item.added', { output_index: outputIndex, item })
  }

  public appendToolCallDelta(messageId: string, delta: string): void {
    const state = this.toolCalls.get(messageId)
    if (this.closed || !state || state.done || !delta) return
    state.rawArguments += delta
    if (state.tool.kind === 'function') {
      this.event('response.function_call_arguments.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta,
        ...(this.includeObfuscation ? { obfuscation: responsesDeltaObfuscation(delta) } : {}),
      })
      return
    }
    if (state.tool.kind !== 'custom' || state.customInputStreamingDisabled) return
    const input = partialCustomToolInput(state.rawArguments)
    if (input === undefined || !input.startsWith(state.streamedCustomInput)) {
      state.customInputStreamingDisabled = true
      return
    }
    const inputDelta = input.slice(state.streamedCustomInput.length)
    if (!inputDelta) return
    this.event('response.custom_tool_call_input.delta', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      delta: inputDelta,
      ...(this.includeObfuscation ? { obfuscation: responsesDeltaObfuscation(inputDelta) } : {}),
    })
    state.streamedCustomInput = input
  }

  public finishToolCall(messageId: string): void {
    const state = this.toolCalls.get(messageId)
    if (this.closed || !state || state.done) return
    this.finishToolState(state)
  }

  public reconcileToolCalls(calls: readonly WebWmTurnToolCall[]): WebWmTurnToolCall[] | undefined {
    if (this.closed) return undefined
    const finalMessageIds = new Set<string>()
    const reconciled: WebWmTurnToolCall[] = []
    for (const call of calls) {
      if (finalMessageIds.has(call.id)) return undefined
      finalMessageIds.add(call.id)
      let state = this.toolCalls.get(call.id)
      if (!state) {
        this.startToolCall(call.id, call.name)
        state = this.toolCalls.get(call.id)
      }
      if (!state || state.tool.wireName !== call.name) return undefined
      if (state.done) {
        if (state.rawArguments !== call.arguments) return undefined
      } else {
        if (!call.arguments.startsWith(state.rawArguments)) return undefined
        this.appendToolCallDelta(call.id, call.arguments.slice(state.rawArguments.length))
        this.finishToolCall(call.id)
      }
      reconciled.push({ id: state.callId, name: call.name, arguments: call.arguments })
    }
    if ([...this.toolCalls.keys()].some((messageId) => !finalMessageIds.has(messageId))) return undefined
    return reconciled
  }

  public canReconcileText(finalText: string): boolean {
    return finalText.startsWith(this.textOutput)
  }

  public get reasoningWasObserved(): boolean {
    return this.reasoningObserved
  }

  public complete(
    finalText: string,
    usage: WebWmResponsesUsage,
  ): void {
    if (this.closed) return
    if (!this.canReconcileText(finalText)) {
      this.fail('web_wm_stream_mismatch', 'ChatGPT Web WM final text did not match its streamed prefix.')
      return
    }
    this.appendText(finalText.slice(this.textOutput.length))
    if (this.closed) return
    if (this.textStarted) this.finishText('completed')
    this.finishPendingReasoning()
    this.terminalUsage = usage
    this.event('response.completed', { response: this.envelope('completed', this.output) })
    this.close()
  }

  public incomplete(
    finalText: string,
    reason: 'max_output_tokens' | 'content_filter',
    usage: WebWmResponsesUsage,
  ): void {
    if (this.closed) return
    if (!this.canReconcileText(finalText)) {
      this.fail('web_wm_stream_mismatch', 'ChatGPT Web WM final text did not match its streamed prefix.')
      return
    }
    this.appendText(finalText.slice(this.textOutput.length))
    if (this.closed) return
    if (this.textStarted) this.finishText('incomplete')
    this.finishPendingReasoning()
    this.terminalUsage = usage
    this.event('response.incomplete', {
      response: {
        ...this.envelope('incomplete', this.output),
        incomplete_details: { reason },
      },
    })
    this.close()
  }

  public fail(code: string, message: string, status = 502): void {
    if (this.closed) return
    const upstreamCode = code.trim().slice(0, 160) || 'web_wm_responses_failed'
    const safeCode = webWmResponsesFailureCode(status, upstreamCode)
    const safeMessage = safeWebWmResponsesErrorMessage(message)
    this.event('response.failed', {
      response: {
        ...this.envelope('failed', []),
        error: {
          code: safeCode,
          message: safeMessage,
        },
      },
    })
    this.close()
  }

  public abort(reason?: unknown): void {
    if (this.closed) return
    this.closed = true
    try { this.controller?.close() } catch { /* The reader may already be cancelled. */ }
    this.notifyCancellation(reason)
  }

  private appendText(delta: string): void {
    if (this.closed || !delta) return
    this.finishReasoningBeforeText()
    this.startText()
    if (this.closed) return
    const outputIndex = this.output.length
    const itemId = this.textItemId
    this.event('response.output_text.delta', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
      ...(this.includeObfuscation ? { obfuscation: responsesDeltaObfuscation(delta) } : {}),
    })
    if (!this.closed) this.textOutput += delta
  }

  private startReasoning(): void {
    if (this.closed || !this.hasReasoningItem || this.reasoningStarted) return
    this.reasoningStarted = true
    this.event('response.output_item.added', {
      output_index: this.output.length,
      item: this.reasoningItem(),
    })
  }

  private finishReasoningBeforeText(): void {
    if (!this.hasReasoningItem || this.textStarted || this.reasoningFinished) return
    this.startReasoning()
    this.finishReasoning()
  }

  private finishPendingReasoning(): void {
    if (!this.hasReasoningItem || this.reasoningFinished) return
    this.startReasoning()
    this.finishReasoning()
  }

  private get hasReasoningItem(): boolean {
    return this.reasoningObserved || Boolean(this.reasoningEncryptedContent)
  }

  private finishReasoning(): void {
    if (this.closed || !this.reasoningStarted || this.reasoningFinished) return
    const outputIndex = this.output.length
    const item = this.reasoningItem()
    this.event('response.output_item.done', {
      output_index: outputIndex,
      item,
    })
    this.output.push(item)
    this.reasoningFinished = true
  }

  private reasoningItem(): Record<string, unknown> {
    return {
      id: this.reasoningItemId,
      type: 'reasoning',
      content: [],
      summary: [],
      ...(this.reasoningEncryptedContent
        ? { encrypted_content: this.reasoningEncryptedContent }
        : {}),
    }
  }

  private startText(): void {
    if (this.textStarted || this.closed) return
    this.textStarted = true
    const outputIndex = this.output.length
    const itemId = this.textItemId
    this.event('response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
        phase: 'final_answer',
      },
    })
    this.event('response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    })
  }

  private finishText(status: 'completed' | 'incomplete'): void {
    const outputIndex = this.output.length
    const itemId = this.textItemId
    this.event('response.output_text.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: this.textOutput,
      logprobs: [],
    })
    const part = { type: 'output_text', text: this.textOutput, annotations: [], logprobs: [] }
    this.event('response.content_part.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    })
    const item = {
      id: itemId,
      type: 'message',
      status,
      role: 'assistant',
      content: [part],
      phase: 'final_answer',
    }
    this.event('response.output_item.done', {
      output_index: outputIndex,
      item,
    })
    this.output.push(item)
  }

  private finishToolState(state: WebWmStreamingToolCall): void {
    if (this.closed || state.done) return
    const streamedValue = state.tool.kind === 'custom'
      ? customToolInput(state.rawArguments)
      : state.rawArguments || '{}'
    if (state.tool.kind === 'custom') {
      if (!streamedValue.startsWith(state.streamedCustomInput)) {
        this.fail(
          'web_wm_tool_stream_mismatch',
          'ChatGPT Web WM final custom tool input did not match its streamed prefix.',
        )
        return
      }
      const remaining = streamedValue.slice(state.streamedCustomInput.length)
      if (remaining) {
        this.event('response.custom_tool_call_input.delta', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: remaining,
          ...(this.includeObfuscation ? { obfuscation: responsesDeltaObfuscation(remaining) } : {}),
        })
        state.streamedCustomInput = streamedValue
      }
    }
    if (state.tool.kind !== 'tool_search') {
      this.event(state.tool.kind === 'custom'
        ? 'response.custom_tool_call_input.done'
        : 'response.function_call_arguments.done', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        ...(state.tool.kind === 'custom'
          ? { input: streamedValue }
          : { arguments: streamedValue, name: state.tool.name }),
      })
    }
    const item = this.toolItem(state, 'completed')
    this.output[state.outputIndex] = item
    this.event('response.output_item.done', { output_index: state.outputIndex, item })
    state.done = true
  }

  private toolItem(
    state: WebWmStreamingToolCall,
    status: 'in_progress' | 'completed',
  ): Record<string, unknown> {
    if (state.tool.kind === 'tool_search') {
      return {
        id: state.itemId,
        type: 'tool_search_call',
        status,
        execution: 'client',
        call_id: state.callId,
        arguments: status === 'completed' ? toolSearchArguments(state.rawArguments) : {},
      }
    }
    if (state.tool.kind === 'custom') {
      return {
        id: state.itemId,
        type: 'custom_tool_call',
        status,
        call_id: state.callId,
        name: state.tool.name,
        input: status === 'completed' ? customToolInput(state.rawArguments) : '',
      }
    }
    return {
      id: state.itemId,
      type: 'function_call',
      status,
      call_id: state.callId,
      name: state.tool.name,
      ...(state.tool.namespace ? { namespace: state.tool.namespace } : {}),
      arguments: status === 'completed' ? state.rawArguments || '{}' : '',
    }
  }

  private event(type: string, payload: Record<string, unknown>): void {
    if (this.closed) return
    const frame = `event: ${type}\ndata: ${JSON.stringify({
      type,
      sequence_number: this.sequenceNumber,
      ...payload,
    })}\n\n`
    this.wire += frame
    try {
      this.controller?.enqueue(this.encoder.encode(frame))
      this.sequenceNumber += 1
    } catch (error) {
      this.closed = true
      this.notifyCancellation(error)
    }
  }

  private envelope(status: string, items: readonly Record<string, unknown>[]): Record<string, unknown> {
    const completed = status === 'completed'
    const body = this.requestBody
    const serviceTier = typeof body.service_tier === 'string' && body.service_tier !== 'auto'
      ? body.service_tier
      : 'default'
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      completed_at: completed ? Math.floor(Date.now() / 1_000) : null,
      background: false,
      error: null,
      frequency_penalty: finiteNumber(body.frequency_penalty) ?? 0,
      incomplete_details: null,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      max_output_tokens: finiteNumber(body.max_output_tokens),
      max_tool_calls: finiteNumber(body.max_tool_calls),
      moderation: null,
      model: this.model,
      output: items,
      parallel_tool_calls: body.parallel_tool_calls !== false,
      presence_penalty: finiteNumber(body.presence_penalty) ?? 0,
      previous_response_id: typeof body.previous_response_id === 'string' ? body.previous_response_id : null,
      prompt_cache_key: typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : null,
      prompt_cache_retention: typeof body.prompt_cache_retention === 'string'
        ? body.prompt_cache_retention
        : '24h',
      reasoning: this.reasoningConfiguration,
      safety_identifier: typeof body.safety_identifier === 'string' ? body.safety_identifier : null,
      service_tier: serviceTier,
      store: false,
      temperature: finiteNumber(body.temperature) ?? 1,
      text: {
        format: objectValue(objectValue(body.text)?.format) ?? { type: 'text' },
        verbosity: webWmRequestedTextVerbosity(body) ?? 'medium',
      },
      tool_choice: body.tool_choice ?? 'auto',
      tool_usage: {
        image_gen: {
          input_tokens: 0,
          input_tokens_details: { image_tokens: 0, text_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { image_tokens: 0, text_tokens: 0 },
          total_tokens: 0,
        },
        web_search: { num_requests: 0 },
      },
      tools: arrayValue(body.tools),
      top_logprobs: finiteNumber(body.top_logprobs) ?? 0,
      top_p: finiteNumber(body.top_p) ?? 0.98,
      truncation: typeof body.truncation === 'string' ? body.truncation : 'disabled',
      usage: this.terminalUsage ?? null,
      user: typeof body.user === 'string' ? body.user : null,
      metadata: objectValue(body.metadata) ?? {},
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    try { this.controller?.close() } catch { /* The reader may already be cancelled. */ }
  }

  private notifyCancellation(reason?: unknown): void {
    if (this.cancellationNotified) return
    this.cancellationNotified = true
    this.onCancel(reason)
  }
}

function estimateWebWmResponsesUsage(
  prepared: WebWmPreparedResponsesTurn,
  output: string,
  calls: readonly WebWmTurnToolCall[],
  reasoningObserved: boolean,
): WebWmEstimatedUsage {
  const incrementalContextTokens = estimateWebWmTokens({
    prompt: prepared.prompt,
    messages: prepared.messages,
  })
  const requestControlTokens = estimateWebWmTokens(prepared.bodyExtras)
  const inputTokens = Math.max(
    1,
    prepared.previousContextTokens + incrementalContextTokens + requestControlTokens,
  )
  const visibleOutputTokens = Math.max(1, estimateWebWmTokens({ output, calls }))
  const reasoningMultiplier: Record<WebWmThinkingEffort, number> = {
    min: 0.25,
    standard: 1,
    extended: 2,
    xhigh: 3,
    max: 4,
    ultra: 6,
  }
  const reasoningTokens = reasoningObserved
    ? Math.max(4, Math.ceil(visibleOutputTokens * reasoningMultiplier[prepared.thinkingEffort]))
    : 0
  const outputTokens = visibleOutputTokens + reasoningTokens
  return {
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: inputTokens + outputTokens,
    },
    // Tool declarations are per-request controls, so do not compound their
    // size across server-side Work conversation continuations.
    contextTokens: prepared.previousContextTokens + incrementalContextTokens + outputTokens,
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function normalizeUpstreamStatus(value: number): number {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 502
}

function webWmResponsesFailureCode(status: number, fallback: string): string {
  switch (normalizeUpstreamStatus(status)) {
    case 400: return 'invalid_request_error'
    case 401: return 'authentication_error'
    case 402: return 'payment_required'
    case 403: return 'permission_denied'
    case 404: return 'not_found'
    case 408:
    case 504: return 'timeout_exception'
    case 409: return 'conflict_exception'
    case 422: return 'unprocessable_entity'
    case 429: return 'rate_limit_error'
    case 500: return 'internal_server_exception'
    case 503: return 'service_unavailable_exception'
    default: return fallback
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function responsesDeltaObfuscation(delta: string): string {
  const length = 16 - (delta.length % 16)
  return randomBytes(Math.ceil(length * 3 / 4) + 1).toString('base64url').slice(0, length)
}

function safeWebWmResponsesErrorMessage(error: unknown): string {
  const source = typeof error === 'string'
    ? error
    : error instanceof Error && error.message.trim()
      ? error.message
      : 'ChatGPT Web WM Responses request failed.'
  return source
    .replace(/\b(?:eyJ|at-)[A-Za-z0-9._-]{20,}\b/g, '[redacted-token]')
    .slice(0, 1_000)
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ))
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

async function waitForWebWmFlights(
  flights: readonly Promise<void>[],
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void Promise.all(flights).then(
      () => {
        cleanup()
        resolve()
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
