import type { Protocol, ProviderKind } from '../../shared/types'

export type ProviderEndpointOperation = 'generate' | 'search' | 'models' | 'health'

export interface ProviderEndpointInput {
  baseUrl: string
  protocol: Protocol
  operation: ProviderEndpointOperation
  model?: string
  stream?: boolean
}

export type ProviderSourceHeaders = Headers | Readonly<Record<string, string | string[] | undefined>>

export interface ProviderHeaderInput {
  protocol: Protocol
  credential: string
  sourceHeaders?: ProviderSourceHeaders
  stream?: boolean
  hasBody?: boolean
}

export interface ProtocolCapabilities {
  streaming: boolean
  toolCalls: boolean
  modelInPath: boolean
}

export interface ProviderCapabilityMatrix {
  protocols: Readonly<Partial<Record<Protocol, Readonly<ProtocolCapabilities>>>>
  modelDiscovery: boolean
  healthProbe: boolean
  authentication: 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'protocol-dependent'
}

export type ProviderFailureCategory =
  | 'authentication'
  | 'permission'
  | 'quota'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'timeout'
  | 'cancelled'
  | 'upstream'
  | 'network'
  | 'invalid_response'
  | 'unknown'

export type ProviderAccountAction = 'none' | 'cooldown' | 'disable'

export interface ProviderFailure {
  category: ProviderFailureCategory
  message: string
  retryable: boolean
  accountAction: ProviderAccountAction
  statusCode?: number
  retryAfterMs?: number
  retryAt?: number
}

export interface ProviderFailureInput {
  statusCode?: number
  headers?: HeadersInit
  error?: unknown
  now?: number
}

export interface ProviderProbeInput {
  baseUrl: string
  protocol: Protocol
  credential: string
  fetchImplementation?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  now?: () => number
}

export interface ModelDiscoveryResult {
  ok: boolean
  models: string[]
  checkedAt: number
  latencyMs: number
  statusCode?: number
  failure?: ProviderFailure
}

export type ModelDiscoveryCursorParameter = 'pageToken' | 'after_id'

export interface ModelDiscoveryCursor {
  parameter: ModelDiscoveryCursorParameter
  value: string
}

export interface ModelDiscoveryPagination {
  nextCursor?: ModelDiscoveryCursor
  invalid: boolean
}

export interface ProviderHealthResult {
  ok: boolean
  checkedAt: number
  latencyMs: number
  statusCode?: number
  failure?: ProviderFailure
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilityMatrix

  buildEndpoint(input: ProviderEndpointInput): string

  /**
   * Mutates caller-owned headers so the adapter never returns or retains a credential.
   */
  applyRequestHeaders(headers: Headers, input: ProviderHeaderInput): void

  discoverModels(input: ProviderProbeInput): Promise<ModelDiscoveryResult>
  probeHealth(input: ProviderProbeInput): Promise<ProviderHealthResult>
  classifyFailure(input: ProviderFailureInput): ProviderFailure
}

export interface ProviderAdapterDefinition {
  kind: ProviderKind
  capabilities: ProviderCapabilityMatrix
  defaultVersion: string | ((input: ProviderEndpointInput) => string)
  buildOperationPath(input: ProviderEndpointInput): {
    path: string
    query?: Readonly<Record<string, string>>
  }
  applyAuthentication(headers: Headers, input: ProviderHeaderInput): void
  parseModels(payload: unknown): string[]
}
