import { classifyProviderFailure, invalidResponseFailure } from './failure'
import type {
  ModelDiscoveryCursor,
  ModelDiscoveryResult,
  ProviderAdapter,
  ProviderAdapterDefinition,
  ProviderEndpointInput,
  ProviderHeaderInput,
  ProviderHealthResult,
  ProviderProbeInput,
  ProviderSourceHeaders
} from './types'
import { buildVersionedEndpoint } from './url'
import { filterOpenAIGenerativeModels, parseModelDiscoveryPagination } from './model-parsers'

const MAX_MODEL_DISCOVERY_PAGES = 20

export function createProviderAdapter(definition: ProviderAdapterDefinition): ProviderAdapter {
  const adapter: ProviderAdapter = {
    kind: definition.kind,
    capabilities: definition.capabilities,

    buildEndpoint(input): string {
      assertSupportedProtocol(definition, input.protocol)
      const operation = definition.buildOperationPath(input)
      const defaultVersion = typeof definition.defaultVersion === 'function'
        ? definition.defaultVersion(input)
        : definition.defaultVersion
      return buildVersionedEndpoint(input.baseUrl, defaultVersion, operation.path, operation.query)
    },

    applyRequestHeaders(headers, input): void {
      assertSupportedProtocol(definition, input.protocol)
      if (!input.credential.trim()) throw new Error('Provider credential is required')

      const accept = readSourceHeader(input.sourceHeaders, 'accept')
      headers.set('accept', input.stream ? 'text/event-stream' : (accept ?? 'application/json'))
      if (input.hasBody !== false) headers.set('content-type', 'application/json')

      const userAgent = readSourceHeader(input.sourceHeaders, 'user-agent')
      if (userAgent) headers.set('user-agent', userAgent)
      definition.applyAuthentication(headers, input)
    },

    async discoverModels(input): Promise<ModelDiscoveryResult> {
      return discoverModels(adapter, definition, input)
    },

    async probeHealth(input): Promise<ProviderHealthResult> {
      return probeHealth(adapter, input)
    },

    classifyFailure: classifyProviderFailure
  }
  return Object.freeze(adapter)
}

async function discoverModels(
  adapter: ProviderAdapter,
  definition: ProviderAdapterDefinition,
  input: ProviderProbeInput
): Promise<ModelDiscoveryResult> {
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  let statusCode: number | undefined
  const signal = probeSignal(input)
  const models: string[] = []
  const seenCursors = new Set<string>()
  let cursor: ModelDiscoveryCursor | undefined
  try {
    for (let page = 0; page < MAX_MODEL_DISCOVERY_PAGES; page += 1) {
      statusCode = undefined
      const response = await fetchProbe(adapter, input, 'models', signal, cursor)
      statusCode = response.status
      if (!response.ok) {
        return {
          ok: false,
          models: [],
          checkedAt: startedAt,
          latencyMs: elapsed(now, startedAt),
          statusCode,
          failure: adapter.classifyFailure({ statusCode, headers: response.headers, now: now() })
        }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return invalidModelDiscoveryResult(now, startedAt, statusCode)
      }

      models.push(...definition.parseModels(payload))
      const pagination = parseModelDiscoveryPagination(payload, input.protocol)
      if (pagination.invalid) return invalidModelDiscoveryResult(now, startedAt, statusCode)
      if (!pagination.nextCursor) {
        const normalized = normalizeModels(models)
        return {
          ok: true,
          models: definition.kind === 'openai' || definition.kind === 'openai-compatible'
            ? filterOpenAIGenerativeModels(normalized)
            : normalized,
          checkedAt: startedAt,
          latencyMs: elapsed(now, startedAt),
          statusCode
        }
      }

      const cursorKey = `${pagination.nextCursor.parameter}:${pagination.nextCursor.value}`
      if (seenCursors.has(cursorKey) || page === MAX_MODEL_DISCOVERY_PAGES - 1) {
        return invalidModelDiscoveryResult(now, startedAt, statusCode)
      }
      seenCursors.add(cursorKey)
      cursor = pagination.nextCursor
    }

    return invalidModelDiscoveryResult(now, startedAt, statusCode)
  } catch (error) {
    return {
      ok: false,
      models: [],
      checkedAt: startedAt,
      latencyMs: elapsed(now, startedAt),
      ...(statusCode === undefined ? {} : { statusCode }),
      failure: adapter.classifyFailure({ error, now: now() })
    }
  }
}

async function probeHealth(adapter: ProviderAdapter, input: ProviderProbeInput): Promise<ProviderHealthResult> {
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  try {
    const response = await fetchProbe(adapter, input, 'health', probeSignal(input))
    const statusCode = response.status
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) {
      return {
        ok: false,
        checkedAt: startedAt,
        latencyMs: elapsed(now, startedAt),
        statusCode,
        failure: adapter.classifyFailure({ statusCode, headers: response.headers, now: now() })
      }
    }
    return {
      ok: true,
      checkedAt: startedAt,
      latencyMs: elapsed(now, startedAt),
      statusCode
    }
  } catch (error) {
    return {
      ok: false,
      checkedAt: startedAt,
      latencyMs: elapsed(now, startedAt),
      failure: adapter.classifyFailure({ error, now: now() })
    }
  }
}

async function fetchProbe(
  adapter: ProviderAdapter,
  input: ProviderProbeInput,
  operation: 'models' | 'health',
  signal: AbortSignal | undefined,
  cursor?: ModelDiscoveryCursor
): Promise<Response> {
  const headers = new Headers()
  adapter.applyRequestHeaders(headers, {
    protocol: input.protocol,
    credential: input.credential,
    hasBody: false
  })
  const endpoint = adapter.buildEndpoint({
    baseUrl: input.baseUrl,
    protocol: input.protocol,
    operation
  })
  return (input.fetchImplementation ?? fetch)(withCursor(endpoint, cursor), {
    method: 'GET',
    headers,
    signal
  })
}

function probeSignal(input: ProviderProbeInput): AbortSignal | undefined {
  if (input.timeoutMs === 0) return input.signal
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 10_000)
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
}

function withCursor(endpoint: string, cursor: ModelDiscoveryCursor | undefined): string {
  if (!cursor) return endpoint
  const url = new URL(endpoint)
  url.searchParams.set(cursor.parameter, cursor.value)
  return url.toString()
}

function invalidModelDiscoveryResult(
  now: () => number,
  startedAt: number,
  statusCode: number | undefined
): ModelDiscoveryResult {
  return {
    ok: false,
    models: [],
    checkedAt: startedAt,
    latencyMs: elapsed(now, startedAt),
    ...(statusCode === undefined ? {} : { statusCode }),
    failure: invalidResponseFailure()
  }
}

function assertSupportedProtocol(definition: ProviderAdapterDefinition, protocol: ProviderEndpointInput['protocol']): void {
  if (!definition.capabilities.protocols[protocol]) {
    throw new Error(`${definition.kind} does not support the ${protocol} protocol`)
  }
}

function readSourceHeader(source: ProviderSourceHeaders | undefined, name: string): string | undefined {
  if (!source) return undefined
  if (source instanceof Headers) return source.get(name) ?? undefined
  const entry = Object.entries(source).find(([key]) => key.toLowerCase() === name)
  const value = entry?.[1]
  return Array.isArray(value) ? value[0] : value
}

function normalizeModels(models: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const candidate of models) {
    const model = candidate.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    result.push(model)
  }
  return result
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

export function readHeader(input: ProviderHeaderInput, name: string): string | undefined {
  return readSourceHeader(input.sourceHeaders, name)
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
