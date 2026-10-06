import { randomBytes, randomUUID } from 'node:crypto'
import type {
  ApiSourceProbeInput,
  ApiSourceProbeResult,
  ApiSourceProbeStage,
  ApiSourceToolRoundtripDiagnostics,
  UpstreamCapabilityProfile,
} from '@shared/types'
import { buildModelCatalog, inferUpstreamCapabilities } from '@shared/source-capabilities'
import {
  collectKiroEventStreamBody,
  isKiroEventStreamContentType,
  type KiroCollectedResponse,
} from '../gateway/kiro-event-stream'
import { convertAnthropicMessagesToKiroClaude } from '../gateway/kiro-claude-request'
import type { ProviderAdapter } from '../providers'

const PROBE_TOOL_NAME = 'stone_kiro_probe'

export interface KiroClaudeProbeValues {
  conversationId: string
  proof: string
}

export interface KiroClaudeSourceProbeOptions {
  input: ApiSourceProbeInput
  credential: string
  model: string | undefined
  adapter: ProviderAdapter
  fetchImplementation: typeof fetch
  timeoutMs: number
  now: () => number
  startedAt: number
  createProbeValues?: () => KiroClaudeProbeValues
}

type ProbeFailureKind =
  | 'configuration'
  | 'transport'
  | 'authentication'
  | 'http'
  | 'invalid-response'
  | 'roundtrip'

class KiroClaudeProbeFailure extends Error {
  constructor(
    readonly kind: ProbeFailureKind,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'KiroClaudeProbeFailure'
  }
}

/**
 * Runs the only authoritative Kiro capability check: a two-request structured
 * tool round trip against the exact configured GenerateAssistantResponse URL.
 * No generic health, model discovery, or one-turn generation request is made.
 */
export async function probeKiroClaudeSource(
  options: KiroClaudeSourceProbeOptions
): Promise<ApiSourceProbeResult> {
  const {
    input,
    credential,
    model,
    adapter,
    fetchImplementation,
    timeoutMs,
    now,
    startedAt,
  } = options
  const failedProfile = capabilityProfile(input, false, now())

  if (input.sourceType !== 'relay' || input.kind !== 'kiro-compatible' || input.protocol !== 'kiro-claude') {
    return failedResult(
      options,
      new KiroClaudeProbeFailure(
        'configuration',
        'Kiro Claude 仅支持 relay / kiro-compatible / kiro-claude 组合。'
      ),
      failedProfile,
    )
  }
  if (!model) {
    return failedResult(
      options,
      new KiroClaudeProbeFailure('configuration', 'Kiro Claude 必须手动填写测试模型。'),
      failedProfile,
    )
  }

  try {
    const endpoint = adapter.buildEndpoint({
      baseUrl: input.baseUrl.trim(),
      protocol: 'kiro-claude',
      operation: 'generate',
      model,
      stream: true,
    })
    const values = safeProbeValues(options.createProbeValues?.() ?? defaultProbeValues())
    const signal = AbortSignal.timeout(timeoutMs)
    const firstRequest = buildFirstTurn(model, values)
    const firstResponse = await postKiroRequest({
      endpoint,
      credential,
      adapter,
      fetchImplementation,
      body: firstRequest.body,
      signal,
    })
    const first = await collectProbeResponse(firstResponse, values.proof)
    assertFirstTurn(first, firstRequest.diagnostics.toolsCount, values.proof)

    const firstTool = first.tools[0]
    const secondRequest = buildSecondTurn(model, values, firstTool.id, firstTool.input)
    const secondResponse = await postKiroRequest({
      endpoint,
      credential,
      adapter,
      fetchImplementation,
      body: secondRequest.body,
      signal,
    })
    const second = await collectProbeResponse(secondResponse, values.proof)
    assertSecondTurn(second, secondRequest.diagnostics.toolResultCount, values.proof)

    const diagnostics: ApiSourceToolRoundtripDiagnostics = {
      firstTurn: {
        toolsCount: firstRequest.diagnostics.toolsCount,
        toolUseCount: first.tools.length,
        stopReason: anthropicStopReason(first.stopReason),
      },
      secondTurn: {
        toolResultCount: secondRequest.diagnostics.toolResultCount,
        toolUseCount: second.tools.length,
        stopReason: anthropicStopReason(second.stopReason),
      },
    }
    const checkedAt = now()
    const profile = capabilityProfile(input, true, checkedAt)
    const models = [model]
    return {
      ok: true,
      stages: successStages(diagnostics, elapsed(now, startedAt)),
      models,
      testedModel: model,
      latencyMs: elapsed(now, startedAt),
      warnings: [],
      capabilityProfile: profile,
      modelCatalog: buildModelCatalog(models, profile, checkedAt),
      toolRoundtrip: diagnostics,
    }
  } catch (error) {
    const failure = error instanceof KiroClaudeProbeFailure
      ? error
      : new KiroClaudeProbeFailure(
        isAbortError(error) ? 'transport' : 'invalid-response',
        isAbortError(error)
          ? 'Kiro Claude 两轮工具链检测超时。'
          : 'Kiro Claude 两轮工具链检测未能完成。'
      )
    return failedResult(options, failure, failedProfile, model)
  }
}

function buildFirstTurn(model: string, values: KiroClaudeProbeValues) {
  return convertAnthropicMessagesToKiroClaude({
    system: [
      {
        type: 'text',
        text: 'This is a two-step capability probe. In the first step, call the supplied probe tool exactly once. After its result arrives, do not call any tool again and include the returned proof verbatim in the final answer.',
      },
    ],
    messages: [{
      role: 'user',
      content: `Call ${PROBE_TOOL_NAME} exactly once with proof set to ${values.proof}.`,
    }],
    tools: [{
      name: PROBE_TOOL_NAME,
      description: 'Returns an in-memory proof for a Stone+ Kiro Claude capability check.',
      input_schema: probeToolSchema(values.proof),
    }],
    tool_choice: { type: 'auto' },
    stream: true,
  }, { model, conversationId: values.conversationId })
}

function buildSecondTurn(
  model: string,
  values: KiroClaudeProbeValues,
  toolUseId: string,
  toolInput: Record<string, unknown>,
) {
  return convertAnthropicMessagesToKiroClaude({
    system: [
      {
        type: 'text',
        text: 'This is a two-step capability probe. In the first step, call the supplied probe tool exactly once. After its result arrives, do not call any tool again and include the returned proof verbatim in the final answer.',
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Call ${PROBE_TOOL_NAME} exactly once with proof set to ${values.proof}.`,
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: PROBE_TOOL_NAME,
          input: toolInput,
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: values.proof,
        }],
      },
    ],
    tools: [{
      name: PROBE_TOOL_NAME,
      description: 'Returns an in-memory proof for a Stone+ Kiro Claude capability check.',
      input_schema: probeToolSchema(values.proof),
    }],
    tool_choice: { type: 'auto' },
    stream: true,
  }, { model, conversationId: values.conversationId })
}

async function postKiroRequest(input: {
  endpoint: string
  credential: string
  adapter: ProviderAdapter
  fetchImplementation: typeof fetch
  body: unknown
  signal: AbortSignal
}): Promise<Response> {
  const headers = new Headers()
  input.adapter.applyRequestHeaders(headers, {
    protocol: 'kiro-claude',
    credential: input.credential,
    stream: true,
    hasBody: true,
  })
  let response: Response
  try {
    response = await input.fetchImplementation(input.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: input.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new KiroClaudeProbeFailure(
      'transport',
      isAbortError(error)
        ? 'Kiro Claude 两轮工具链检测超时。'
        : '无法连接 Kiro Claude 中转端点。'
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const authentication = response.status === 401 || response.status === 403
    throw new KiroClaudeProbeFailure(
      authentication ? 'authentication' : 'http',
      authentication
        ? 'Kiro Claude 中转拒绝了 API Key。'
        : `Kiro Claude 中转返回 HTTP ${response.status}。`,
      response.status,
    )
  }
  if (!isKiroEventStreamContentType(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => undefined)
    throw new KiroClaudeProbeFailure(
      'invalid-response',
      'Kiro Claude 中转未返回 AWS Event Stream。'
    )
  }
  if (!response.body) {
    throw new KiroClaudeProbeFailure('invalid-response', 'Kiro Claude 中转返回了空响应体。')
  }
  return response
}

async function collectProbeResponse(response: Response, proof: string): Promise<KiroCollectedResponse> {
  const result = await collectKiroEventStreamBody(response.body as ReadableStream<Uint8Array>, {
    declaredTools: [{ name: PROBE_TOOL_NAME, inputSchema: probeToolSchema(proof) }],
  })
  if (result.error || result.stopReason === 'error') {
    throw new KiroClaudeProbeFailure(
      'invalid-response',
      'Kiro Claude 中转返回了无效的工具事件流。'
    )
  }
  return result
}

function probeToolSchema(proof: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: { proof: { type: 'string', const: proof } },
    required: ['proof'],
    additionalProperties: false,
  }
}

function assertFirstTurn(result: KiroCollectedResponse, toolsCount: number, proof: string): void {
  const valid = toolsCount === 1
    && result.tools.length === 1
    && result.stopReason === 'tool_calls'
    && result.tools[0].name === PROBE_TOOL_NAME
    && result.tools[0].input.proof === proof
  if (!valid) {
    throw new KiroClaudeProbeFailure(
      'roundtrip',
      `第一轮工具诊断未通过（tools=${toolsCount}, tool_use=${result.tools.length}, stop_reason=${anthropicStopReason(result.stopReason)}）。`
    )
  }
}

function assertSecondTurn(result: KiroCollectedResponse, toolResultCount: number, proof: string): void {
  const valid = toolResultCount === 1
    && result.tools.length === 0
    && result.stopReason === 'stop'
    && result.text.includes(proof)
  if (!valid) {
    throw new KiroClaudeProbeFailure(
      'roundtrip',
      `第二轮工具诊断未通过（tool_result=${toolResultCount}, tool_use=${result.tools.length}, stop_reason=${anthropicStopReason(result.stopReason)}）。`
    )
  }
}

function capabilityProfile(
  input: ApiSourceProbeInput,
  toolCalls: boolean,
  checkedAt: number,
): UpstreamCapabilityProfile {
  return inferUpstreamCapabilities({
    protocol: 'kiro-claude',
    kind: input.kind,
    sourceType: input.sourceType,
    modelDiscovery: false,
    streaming: true,
    toolCalls,
    origin: toolCalls ? 'probed' : 'inferred',
    checkedAt,
  })
}

function successStages(
  diagnostics: ApiSourceToolRoundtripDiagnostics,
  latencyMs: number,
): ApiSourceProbeStage[] {
  return [
    successStage('network', '两轮请求均已连接 Kiro Claude 中转。', latencyMs),
    successStage('authentication', 'API Key 已通过两轮真实请求认证。', latencyMs),
    skippedStage('models', 'Kiro Claude 不提供模型发现；已使用手动测试模型。'),
    skippedStage('generation', 'Kiro Claude 使用专用两轮工具链检测，不执行通用单轮生成。'),
    successStage(
      'tool-roundtrip',
      `两轮工具链已通过：第一轮 tools=${diagnostics.firstTurn.toolsCount}, tool_use=${diagnostics.firstTurn.toolUseCount}, stop_reason=${diagnostics.firstTurn.stopReason}；第二轮 tool_result=${diagnostics.secondTurn.toolResultCount}, tool_use=${diagnostics.secondTurn.toolUseCount}, stop_reason=${diagnostics.secondTurn.stopReason}。`,
      latencyMs,
    ),
  ]
}

function failedResult(
  options: KiroClaudeSourceProbeOptions,
  failure: KiroClaudeProbeFailure,
  profile: UpstreamCapabilityProfile,
  model?: string,
): ApiSourceProbeResult {
  const latencyMs = elapsed(options.now, options.startedAt)
  const stages = failureStages(failure, latencyMs)
  const models = model ? [model] : []
  return {
    ok: false,
    stages,
    models,
    ...(model ? { testedModel: model } : {}),
    latencyMs,
    error: failure.message,
    warnings: [],
    capabilityProfile: profile,
    modelCatalog: buildModelCatalog(models, profile, profile.checkedAt),
  }
}

function failureStages(failure: KiroClaudeProbeFailure, latencyMs: number): ApiSourceProbeStage[] {
  if (failure.kind === 'configuration') {
    return [
      skippedStage('network', '配置尚未满足 Kiro Claude 检测条件。'),
      skippedStage('authentication', '尚未检测认证。'),
      skippedStage('models', 'Kiro Claude 不提供模型发现。'),
      skippedStage('generation', '未执行通用单轮生成。'),
      errorStage('tool-roundtrip', failure.message),
    ]
  }
  if (failure.kind === 'transport') {
    return [
      errorStage('network', failure.message, latencyMs),
      skippedStage('authentication', '网络连接失败，未确认认证。'),
      skippedStage('models', 'Kiro Claude 不提供模型发现。'),
      skippedStage('generation', '未执行通用单轮生成。'),
      skippedStage('tool-roundtrip', '网络连接失败，未完成两轮工具链。'),
    ]
  }
  if (failure.kind === 'authentication') {
    return [
      successStage('network', 'Kiro Claude 中转已返回 HTTP 响应。', latencyMs),
      errorStage('authentication', failure.message, latencyMs),
      skippedStage('models', 'Kiro Claude 不提供模型发现。'),
      skippedStage('generation', '未执行通用单轮生成。'),
      skippedStage('tool-roundtrip', '认证未通过，未完成两轮工具链。'),
    ]
  }
  return [
    successStage('network', 'Kiro Claude 中转已返回 HTTP 响应。', latencyMs),
    failure.kind === 'http'
      ? warningStage('authentication', '中转已响应，但无法确认 API Key 是否有效。', latencyMs)
      : successStage('authentication', 'Kiro Claude 中转已接受 API Key。', latencyMs),
    skippedStage('models', 'Kiro Claude 不提供模型发现。'),
    skippedStage('generation', '未执行通用单轮生成。'),
    errorStage('tool-roundtrip', failure.message, latencyMs),
  ]
}

function successStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number,
): ApiSourceProbeStage {
  return { id, status: 'success', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function warningStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number,
): ApiSourceProbeStage {
  return { id, status: 'warning', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function errorStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number,
): ApiSourceProbeStage {
  return { id, status: 'error', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function skippedStage(id: ApiSourceProbeStage['id'], message: string): ApiSourceProbeStage {
  return { id, status: 'skipped', message }
}

function anthropicStopReason(reason: KiroCollectedResponse['stopReason']): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  return reason ?? 'unknown'
}

function defaultProbeValues(): KiroClaudeProbeValues {
  return {
    conversationId: randomUUID(),
    proof: `stone-${randomBytes(18).toString('hex')}`,
  }
}

function safeProbeValues(value: KiroClaudeProbeValues): KiroClaudeProbeValues {
  const conversationId = value.conversationId?.trim()
  const proof = value.proof?.trim()
  if (!conversationId || !proof || conversationId.length > 256 || proof.length > 256) {
    throw new KiroClaudeProbeFailure('configuration', '无法创建安全的 Kiro Claude 工具链探测值。')
  }
  return { conversationId, proof }
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
