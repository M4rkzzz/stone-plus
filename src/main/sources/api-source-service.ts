import type {
  ApiSourceProbeInput,
  ApiSourceProbeResult,
  ApiSourceProbeStage,
  ProviderKind
} from '@shared/types'
import { buildModelCatalog, inferUpstreamCapabilities } from '@shared/source-capabilities'
import {
  AccountModelProbeError,
  getProviderAdapter,
  probeProviderModel
} from '../providers'
import type { ProviderAdapter, ProviderFailure } from '../providers'

const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const DEFAULT_GENERATION_TIMEOUT_MS = 30_000
const MAX_SAFE_MESSAGE_LENGTH = 320

export interface ApiSourceProbeDependencies {
  /** Credential already stored for an edited source. A non-empty input credential wins. */
  storedCredential?: string
  /** Caller-selected direct, system, or explicit-proxy transport. */
  fetchImplementation?: typeof fetch
  getAdapter?: (kind: ProviderKind) => ProviderAdapter
  probeModel?: typeof probeProviderModel
  timeoutMs?: number
  generationTimeoutMs?: number
  now?: () => number
}

/**
 * Runs a complete API-key source probe without retaining or returning credentials.
 *
 * The transport is deliberately supplied by the caller so gateway IPC can apply
 * the same direct/system/explicit proxy resolution used by normal account traffic.
 * An empty credential on an edit falls back to `storedCredential`.
 */
export async function probeApiSource(
  input: ApiSourceProbeInput,
  dependencies: ApiSourceProbeDependencies = {}
): Promise<ApiSourceProbeResult> {
  const now = dependencies.now ?? (() => Date.now())
  const startedAt = now()
  const stages: ApiSourceProbeStage[] = []
  const warnings: string[] = []
  let capabilityProfile = inferUpstreamCapabilities({
    protocol: input.protocol,
    sourceType: input.sourceType,
    responsesCompactMode: input.responsesCompactMode,
  })
  const credential = resolveCredential(input.credential, dependencies.storedCredential)
  const secrets = [credential, input.credential, dependencies.storedCredential]

  if (!credential) {
    stages.push(skippedStage('network', '尚未发起网络请求。'))
    stages.push(errorStage('authentication', '请输入 API Key；编辑已有来源时可留空以保留原 Key。'))
    appendSkippedStages(stages, ['models', 'generation'], '缺少可用凭据，未继续检测。')
    return failedResult(stages, [], warnings, '缺少可用凭据。', now, startedAt, capabilityProfile)
  }

  const baseUrlError = validateBaseUrl(input.baseUrl)
  if (baseUrlError) {
    stages.push(errorStage('network', baseUrlError))
    appendSkippedStages(stages, ['authentication', 'models', 'generation'], '来源地址无效，未继续检测。')
    return failedResult(stages, [], warnings, baseUrlError, now, startedAt, capabilityProfile)
  }

  const adapter = (dependencies.getAdapter ?? getProviderAdapter)(input.kind)
  const protocolCapabilities = adapter.capabilities.protocols[input.protocol]
  capabilityProfile = inferUpstreamCapabilities({
    protocol: input.protocol,
    sourceType: input.sourceType,
    responsesCompactMode: input.responsesCompactMode,
    modelDiscovery: adapter.capabilities.modelDiscovery,
    streaming: protocolCapabilities?.streaming,
    toolCalls: protocolCapabilities?.toolCalls,
  })
  if (!protocolCapabilities) {
    const message = '所选供应商类型不支持当前协议。'
    stages.push(skippedStage('network', '协议配置无效，尚未发起网络请求。'))
    stages.push(skippedStage('authentication', '协议配置无效，未检测认证。'))
    stages.push(errorStage('models', message))
    stages.push(skippedStage('generation', '协议配置无效，未发起生成请求。'))
    return failedResult(stages, [], warnings, message, now, startedAt, capabilityProfile)
  }

  const fetchImplementation = dependencies.fetchImplementation ?? fetch
  const probeTimeoutMs = normalizeTimeout(dependencies.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS)
  const generationTimeoutMs = normalizeTimeout(
    dependencies.generationTimeoutMs,
    DEFAULT_GENERATION_TIMEOUT_MS
  )

  let healthFailure: ProviderFailure | undefined
  try {
    const health = await adapter.probeHealth({
      baseUrl: input.baseUrl.trim(),
      protocol: input.protocol,
      credential,
      fetchImplementation,
      timeoutMs: probeTimeoutMs,
      now
    })

    if (health.ok) {
      stages.push(successStage('network', '已连接上游服务。', health.latencyMs))
      stages.push(successStage('authentication', 'API Key 已通过上游认证。', health.latencyMs))
    } else {
      healthFailure = normalizedFailure(health.failure)
      if (isTransportFailure(healthFailure) && health.statusCode === undefined) {
        const message = safeFailureMessage(healthFailure, secrets, '无法连接上游服务。')
        stages.push(errorStage('network', message, health.latencyMs))
        appendSkippedStages(stages, ['authentication', 'models', 'generation'], '网络连接失败，未继续检测。')
        return failedResult(stages, [], warnings, message, now, startedAt, capabilityProfile)
      }

      stages.push(successStage('network', '上游端点已返回 HTTP 响应。', health.latencyMs))
      if (isCredentialFailure(healthFailure)) {
        const message = safeFailureMessage(healthFailure, secrets, '上游拒绝了 API Key。')
        stages.push(errorStage('authentication', message, health.latencyMs))
        appendSkippedStages(stages, ['models', 'generation'], '认证未通过，未继续检测。')
        return failedResult(stages, [], warnings, message, now, startedAt, capabilityProfile)
      }

      const message = safeFailureMessage(healthFailure, secrets, '上游基础检测未通过。')
      stages.push(warningStage('authentication', '上游已响应，但暂时无法单独确认认证状态。'))
      stages.push(warningStage('models', message, health.latencyMs))
      warnings.push(message)
    }
  } catch {
    const message = '来源基础检测未能完成。'
    stages.push(errorStage('network', message))
    appendSkippedStages(stages, ['authentication', 'models', 'generation'], '基础检测失败，未继续检测。')
    return failedResult(stages, [], warnings, message, now, startedAt, capabilityProfile)
  }

  let models: string[] = []
  if (!healthFailure) {
    try {
      const discovery = await adapter.discoverModels({
        baseUrl: input.baseUrl.trim(),
        protocol: input.protocol,
        credential,
        fetchImplementation,
        timeoutMs: probeTimeoutMs,
        now
      })
      models = safeModels(discovery.models, secrets)
      if (discovery.ok && models.length > 0) {
        stages.push(successStage('models', `已发现 ${models.length} 个可用模型。`, discovery.latencyMs))
      } else if (discovery.ok) {
        const message = '上游模型列表为空；可手动填写测试模型。'
        stages.push(warningStage('models', message, discovery.latencyMs))
        warnings.push(message)
      } else {
        const failure = normalizedFailure(discovery.failure)
        const message = safeFailureMessage(failure, secrets, '模型发现失败；可手动填写测试模型。')
        if (isCredentialFailure(failure)) {
          replaceStage(stages, 'authentication', errorStage('authentication', message, discovery.latencyMs))
          stages.push(errorStage('models', message, discovery.latencyMs))
          stages.push(skippedStage('generation', '模型发现时认证失败，未发起生成请求。'))
          return failedResult(stages, models, warnings, message, now, startedAt, capabilityProfile)
        }
        stages.push(warningStage('models', message, discovery.latencyMs))
        warnings.push(message)
      }
    } catch {
      const message = '模型发现未能完成；可手动填写测试模型。'
      stages.push(warningStage('models', message))
      warnings.push(message)
    }
  }

  const model = normalizeModel(input.model) ?? models[0]
  if (!model) {
    const message = '未提供测试模型，且无法从上游发现可用模型。'
    stages.push(errorStage('generation', message))
    return failedResult(stages, models, warnings, message, now, startedAt, capabilityProfile)
  }

  try {
    const generation = await (dependencies.probeModel ?? probeProviderModel)({
      adapter,
      baseUrl: input.baseUrl.trim(),
      protocol: input.protocol,
      credential,
      model,
      fetchImplementation,
      signal: AbortSignal.timeout(generationTimeoutMs),
      now
    })
    stages.push(successStage('generation', '最小真实生成请求已成功返回。', generation.latencyMs))
    if (healthFailure) {
      replaceStage(
        stages,
        'authentication',
        successStage('authentication', '真实生成请求已确认 API Key 可用。', generation.latencyMs)
      )
    }
    capabilityProfile = { ...capabilityProfile, origin: 'probed', checkedAt: now() }
    return {
      ok: true,
      stages,
      models,
      latencyMs: elapsed(now, startedAt),
      warnings: unique(warnings),
      capabilityProfile,
      modelCatalog: buildModelCatalog(models, capabilityProfile, capabilityProfile.checkedAt),
    }
  } catch (error) {
    const failure = error instanceof AccountModelProbeError ? error.failure : undefined
    const message = failure
      ? safeFailureMessage(failure, secrets, '最小真实生成请求失败。')
      : '最小真实生成请求未能完成。'
    if (failure && isCredentialFailure(failure)) {
      replaceStage(stages, 'authentication', errorStage('authentication', message))
    }
    stages.push(errorStage('generation', message))
    return failedResult(stages, models, warnings, message, now, startedAt, capabilityProfile)
  }
}

function resolveCredential(inputCredential: string | undefined, storedCredential: string | undefined): string {
  const candidate = inputCredential?.trim()
  return candidate || storedCredential?.trim() || ''
}

function validateBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Base URL 仅支持 HTTP 或 HTTPS。'
    if (!url.hostname) return '请输入有效的 Base URL。'
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (url.protocol === 'http:' && !loopback) return '非本地 Base URL 必须使用 HTTPS。'
    if (url.username || url.password || url.search || url.hash) return 'Base URL 不能嵌入凭据、查询参数或片段。'
    return undefined
  } catch {
    return '请输入有效的 Base URL。'
  }
}

function normalizeModel(value: string | undefined): string | undefined {
  const model = value?.trim()
  if (!model || model.length > 256 || hasControlCharacters(model)) return undefined
  return model
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

function normalizedFailure(failure: ProviderFailure | undefined): ProviderFailure {
  return failure ?? {
    category: 'unknown',
    message: 'Provider request failed.',
    retryable: false,
    accountAction: 'none'
  }
}

function isTransportFailure(failure: ProviderFailure): boolean {
  return failure.category === 'network'
    || failure.category === 'timeout'
    || failure.category === 'cancelled'
}

function isCredentialFailure(failure: ProviderFailure): boolean {
  return failure.category === 'authentication' || failure.category === 'permission'
}

function safeFailureMessage(
  failure: ProviderFailure,
  secrets: Array<string | undefined>,
  fallback: string
): string {
  return sanitizeText(failure.message || fallback, secrets) || fallback
}

function safeModels(models: readonly string[], secrets: Array<string | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const normalizedSecrets = secrets.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
  for (const value of models) {
    const model = value.trim()
    if (!model || model.length > 256 || hasControlCharacters(model)) continue
    if (normalizedSecrets.some((secret) => model.includes(secret))) continue
    if (containsKeyShapedSecret(model) || seen.has(model)) continue
    seen.add(model)
    result.push(model)
  }
  return result
}

function sanitizeText(value: string, secrets: Array<string | undefined>): string {
  let output = value
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, '[redacted]')
  }
  output = output
    .replace(/Bearer\s+[-A-Za-z0-9._~+/=]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
  output = replaceControlCharacters(output).replace(/\s+/g, ' ')
    .trim()
  if (output.length <= MAX_SAFE_MESSAGE_LENGTH) return output
  return `${output.slice(0, MAX_SAFE_MESSAGE_LENGTH - 3).trimEnd()}...`
}

function containsKeyShapedSecret(value: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{8,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function replaceControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}

function successStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number
): ApiSourceProbeStage {
  return { id, status: 'success', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function warningStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number
): ApiSourceProbeStage {
  return { id, status: 'warning', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function errorStage(
  id: ApiSourceProbeStage['id'],
  message: string,
  latencyMs?: number
): ApiSourceProbeStage {
  return { id, status: 'error', message, ...(latencyMs === undefined ? {} : { latencyMs }) }
}

function skippedStage(id: ApiSourceProbeStage['id'], message: string): ApiSourceProbeStage {
  return { id, status: 'skipped', message }
}

function appendSkippedStages(
  stages: ApiSourceProbeStage[],
  ids: ApiSourceProbeStage['id'][],
  message: string
): void {
  for (const id of ids) stages.push(skippedStage(id, message))
}

function replaceStage(
  stages: ApiSourceProbeStage[],
  id: ApiSourceProbeStage['id'],
  replacement: ApiSourceProbeStage
): void {
  const index = stages.findIndex((stage) => stage.id === id)
  if (index >= 0) stages[index] = replacement
  else stages.push(replacement)
}

function failedResult(
  stages: ApiSourceProbeStage[],
  models: string[],
  warnings: string[],
  error: string,
  now: () => number,
  startedAt: number,
  capabilityProfile: ApiSourceProbeResult['capabilityProfile'],
): ApiSourceProbeResult {
  const checkedProfile = { ...capabilityProfile, checkedAt: now() }
  return {
    ok: false,
    stages,
    models,
    latencyMs: elapsed(now, startedAt),
    error,
    warnings: unique(warnings),
    capabilityProfile: checkedProfile,
    modelCatalog: buildModelCatalog(models, checkedProfile, checkedProfile.checkedAt),
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt)
}
