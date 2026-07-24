import { evaluateSourceEligibility } from './source-eligibility'
import { isAvailableRouteAccount, resolveRouteSource } from './route-sources'
import { clientNativeProtocols } from './types'
import type {
  AppSnapshot,
  RoutePreviewInput,
  RoutePreviewIssue,
  RoutePreviewResult,
  UpstreamCapabilityRequirement,
} from './types'

/** Static route analysis. It never opens a socket or sends an upstream request. */
export function previewRoute(
  input: RoutePreviewInput,
  snapshot: Pick<AppSnapshot, 'providers' | 'accounts' | 'pools'>,
): RoutePreviewResult {
  const route = input.route
  const issues: RoutePreviewIssue[] = []
  const requestedModel = normalizeModel(input.requestedModel)
  const upstreamModel = requestedModel ? route.modelMap[requestedModel] ?? requestedModel : undefined
  if (!route.enabled) issues.push(issue('route-disabled', 'warning', '路由当前处于停用状态。'))
  if (route.inboundProtocol !== clientNativeProtocols[route.client]) {
    issues.push(issue('invalid-inbound-protocol', 'error', '入站协议与客户端原生协议不一致。'))
  }

  const source = resolveRouteSource(route.poolId, snapshot)
  if (!source) {
    issues.push(issue('source-missing', 'error', '目标来源不存在或配置不完整。'))
    return result(route.poolId, route.inboundProtocol, requestedModel, upstreamModel, 0, issues)
  }
  const eligibleAccounts = source.accounts.filter(isAvailableRouteAccount)
  if (!eligibleAccounts.length) {
    issues.push(issue('source-unavailable', 'error', '来源没有可参与调度的账号。'))
  }
  if (source.summary.protocol !== route.inboundProtocol) {
    issues.push(issue('protocol-conversion', 'info', `请求将从 ${route.inboundProtocol} 转换为 ${source.summary.protocol}。`))
  }
  if (requestedModel && requestedModel !== upstreamModel) {
    issues.push(issue('model-mapped', 'info', `模型将映射为 ${upstreamModel}。`))
  }

  const eligibility = evaluateSourceEligibility({
    accounts: eligibleAccounts,
    providers: snapshot.providers,
    model: upstreamModel,
    poolModelPolicy: source.pool.modelPolicy,
    poolModelAllowlist: source.pool.modelAllowlist,
    requiredCapabilities: input.requiredCapabilities,
    requireProvider: true,
  })
  const modelEligible = eligibility.modelEligible
  if (upstreamModel && eligibleAccounts.length && !modelEligible.length) {
    issues.push(issue('model-unavailable', 'error', `没有可用成员声明支持模型 ${upstreamModel}。`))
  } else if (!upstreamModel && eligibleAccounts.length && !modelEligible.length) {
    issues.push(issue('source-unavailable', 'error', '来源成员缺少有效的供应商配置。'))
  }

  for (const capability of uniqueCapabilities(input.requiredCapabilities)) {
    const capabilityOnly = evaluateSourceEligibility({
      accounts: modelEligible,
      providers: snapshot.providers,
      model: upstreamModel,
      poolModelPolicy: source.pool.modelPolicy,
      poolModelAllowlist: source.pool.modelAllowlist,
      requiredCapabilities: [capability],
      requireProvider: true,
    })
    // Runtime scheduling is verified-first: once one available member has
    // proved the capability, legacy/unknown siblings are not candidates and
    // therefore must not downgrade an otherwise runnable route to a warning.
    if (capabilityOnly.verified.length) continue
    if (!capabilityOnly.verified.length && !capabilityOnly.unknown.length) {
      issues.push({
        ...issue('capability-unsupported', 'error', `来源不支持所需能力：${capability}。`),
        capability,
      })
    } else {
      issues.push({
        ...issue('capability-unknown', 'warning', `来源尚未确认所需能力：${capability}。`),
        capability,
      })
    }
  }
  if (modelEligible.length && uniqueCapabilities(input.requiredCapabilities).length
    && !eligibility.schedulable.length
    && !issues.some((item) => item.code === 'capability-unsupported')) {
    issues.push(issue('capability-unsupported', 'error', '没有单个可用成员同时支持全部所需能力。'))
  }

  return {
    ...result(route.poolId, route.inboundProtocol, requestedModel, upstreamModel, eligibility.schedulable.length, issues),
    sourceName: source.summary.name,
    sourceProtocol: source.summary.protocol,
  }
}

function uniqueCapabilities(value: readonly UpstreamCapabilityRequirement[] | undefined): UpstreamCapabilityRequirement[] {
  return [...new Set(value ?? [])]
}

function normalizeModel(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function issue(
  code: RoutePreviewIssue['code'],
  severity: RoutePreviewIssue['severity'],
  message: string,
): RoutePreviewIssue {
  return { code, severity, message }
}

function result(
  sourceId: string,
  inboundProtocol: RoutePreviewResult['inboundProtocol'],
  requestedModel: string | undefined,
  upstreamModel: string | undefined,
  eligibleAccountCount: number,
  issues: RoutePreviewIssue[],
): RoutePreviewResult {
  return {
    status: issues.some((item) => item.severity === 'error')
      ? 'blocked'
      : issues.some((item) => item.severity === 'warning')
        ? 'warning'
        : 'ready',
    sourceId,
    inboundProtocol,
    requestedModel,
    upstreamModel,
    eligibleAccountCount,
    issues,
  }
}
