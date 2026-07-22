import { randomUUID } from 'node:crypto'
import { clientNativeProtocols } from '@shared/types'
import type { SetupRoutingInput, SetupRoutingResult } from '@shared/types'
import { evaluateSourceEligibility } from '../../shared/source-eligibility'
import { isAvailableRouteAccount } from '../../shared/route-sources'
import type { PersistedState } from '../store/types'

export interface ApplySetupRoutingOptions {
  preferredPoolId?: string
  now?: number
}

export type SetupRoutingDraftResult = Omit<SetupRoutingResult, 'snapshot'>

/** Applies the route and its backing pool in one caller-owned state transaction. */
export function applySetupRoutingDraft(
  state: PersistedState,
  input: SetupRoutingInput,
  options: ApplySetupRoutingOptions = {},
): SetupRoutingDraftResult {
  const timestamp = options.now ?? Date.now()
  const model = requiredText(input.model, '模型')
  const source = state.accounts.find((account) => account.id === input.sourceId)
  if (!source) throw new Error('向导选择的来源已不存在。')
  const provider = state.providers.find((candidate) => candidate.id === source.providerId)
  if (!provider) throw new Error('向导选择的来源缺少上游定义。')

  let pool = input.aggregatePoolId
    ? state.pools.find((candidate) => candidate.id === input.aggregatePoolId)
    : undefined
  if (input.aggregatePoolId) {
    if (!pool || pool.kind !== 'relay-aggregate') throw new Error('选择的聚合中转已不存在。')
    if (!pool.members.some((member) => member.enabled && member.accountId === source.id)) {
      throw new Error('聚合中转不包含当前来源。')
    }
  } else if (!isAvailableRouteAccount(source)) {
    throw new Error('向导选择的来源当前不可用。')
  }

  if (!pool && options.preferredPoolId) {
    const candidate = state.pools.find((item) => item.id === options.preferredPoolId)
    if (candidate?.kind === 'standard'
      && candidate.protocol === provider.protocol
      && candidate.members.some((member) => member.accountId === source.id)
      && poolSupportsSetupRequest(state, candidate, model)) {
      pool = candidate
    }
  }

  if (!pool) {
    pool = state.pools.find((candidate) => candidate.kind === 'standard'
      && candidate.protocol === provider.protocol
      && candidate.members.some((member) => member.accountId === source.id)
      && poolSupportsSetupRequest(state, candidate, model))
  }

  let createdPool = false
  if (!pool) {
    const memberIds = source.credentialType === 'chatgpt-oauth' || source.credentialType === 'chatgpt-agent-identity'
      ? healthyOAuthPeers(state, provider.protocol, source.id, model)
      : [source.id]
    pool = {
      id: randomUUID(),
      name: memberIds.length > 1 ? '向导·OAuth 智能均衡' : `向导·${source.name}`,
      kind: 'standard',
      protocol: provider.protocol,
      strategy: memberIds.length > 1 ? 'balanced' : 'priority',
      members: memberIds.map((accountId) => ({ accountId, enabled: true })),
      modelPolicy: 'all',
      modelAllowlist: [],
      stickySessions: memberIds.length > 1,
      stickyTtlMinutes: 60,
      maxRetries: memberIds.length > 1 ? Math.min(2, memberIds.length - 1) : 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    state.pools.push(pool)
    createdPool = true
  }

  if (!poolSupportsSetupRequest(state, pool, model)) {
    throw new Error('选择的号池没有可完成向导验证的模型与基础生成能力。')
  }

  const inboundProtocol = clientNativeProtocols[input.client]
  const existingRoute = state.routes.find((candidate) => candidate.client === input.client)
  const routeId = existingRoute?.id ?? randomUUID()
  const route = {
    // Preserve fields owned by other route features. The setup wizard only
    // changes the source, enablement and model mapping below.
    ...existingRoute,
    id: routeId,
    client: input.client,
    enabled: true,
    highConcurrencyMode: existingRoute?.highConcurrencyMode === true,
    poolId: pool.id,
    inboundProtocol,
    modelMap: { ...(existingRoute?.modelMap ?? {}), [model]: model },
    localToken: existingRoute?.localToken?.trim() || createLocalToken(),
    createdAt: existingRoute?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
  if (existingRoute) state.routes[state.routes.indexOf(existingRoute)] = route
  else state.routes.push(route)

  return { poolId: pool.id, routeId, createdPool }
}

function healthyOAuthPeers(state: PersistedState, protocol: string, selectedId: string, model: string): string[] {
  const providerById = new Map(state.providers.map((provider) => [provider.id, provider]))
  const candidates = state.accounts
    .filter((account) => (account.credentialType === 'chatgpt-oauth' || account.credentialType === 'chatgpt-agent-identity')
      && isAvailableRouteAccount(account)
      && providerById.get(account.providerId)?.protocol === protocol)
  const peers = evaluateSourceEligibility({
    accounts: candidates,
    providers: state.providers,
    model,
    requiredCapabilities: ['nonStreaming'],
  }).schedulable.map((account) => account.id)
  if (!peers.includes(selectedId)) peers.unshift(selectedId)
  return [...new Set(peers)]
}

function poolSupportsSetupRequest(state: PersistedState, pool: PersistedState['pools'][number], model: string): boolean {
  const enabledIds = new Set(pool.members.filter((member) => member.enabled).map((member) => member.accountId))
  const accounts = state.accounts.filter((account) => enabledIds.has(account.id) && isAvailableRouteAccount(account))
  return evaluateSourceEligibility({
    accounts,
    providers: state.providers,
    model,
    poolModelPolicy: pool.modelPolicy,
    poolModelAllowlist: pool.modelAllowlist,
    requiredCapabilities: ['nonStreaming'],
  }).schedulable.length > 0
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

function createLocalToken(): string {
  return randomUUID().replaceAll('-', '')
}
