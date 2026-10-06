import { isAvailableRouteAccount, listRouteSources } from '@shared/route-sources'
import type { AppSnapshot, ClientConfigStatus } from '@shared/types'
import type { PageId } from './App'

export type HelpReadinessCheckId = 'source' | 'route-source' | 'route' | 'gateway' | 'client'

export interface HelpReadinessCheck {
  id: HelpReadinessCheckId
  label: string
  description: string
  complete: boolean
  page: PageId
  actionLabel: string
}

export interface HelpReadiness {
  items: HelpReadinessCheck[]
  completedCount: number
  totalCount: number
  percentage: number
  ready: boolean
  nextAction: HelpReadinessCheck | null
}

export type HelpReadinessTranslator = (chinese: string, english: string) => string

const chineseHelpCopy: HelpReadinessTranslator = (chinese) => chinese

/**
 * Produces the minimum setup checklist displayed by the help centre.
 *
 * Client configuration status is intentionally supplied separately because it
 * is detected from files on disk by `GatewayApi.getClientConfigs()` and is not
 * persisted in `AppSnapshot`.
 */
export function evaluateHelpReadiness(
  snapshot: AppSnapshot,
  clientConfigs: readonly ClientConfigStatus[] = [],
  t: HelpReadinessTranslator = chineseHelpCopy,
): HelpReadiness {
  // Keep readiness in lockstep with the gateway's route-source resolver. This
  // covers persisted standard/aggregate pools and provider-backed API sources,
  // while rejecting dangling members, unavailable accounts, and id collisions.
  const routableSources = listRouteSources(snapshot)
  const routeSourceIds = new Set(routableSources.map((source) => source.id))
  const providerIds = new Set(snapshot.providers.map((provider) => provider.id))
  const usableSource = snapshot.accounts.some((account) =>
    providerIds.has(account.providerId) && isAvailableRouteAccount(account))
    || routableSources.length > 0
  const routableSource = routableSources.length > 0
  const validRoutes = snapshot.routes.filter((route) => route.enabled && routeSourceIds.has(route.poolId))
  const routedClients = new Set(validRoutes.map((route) => route.client))
  const configuredClient = clientConfigs.some((status) =>
    status.configured && routedClients.has(status.client))

  const items: HelpReadinessCheck[] = [
    {
      id: 'source',
      label: t('已添加可用来源', 'Usable source added'),
      description: usableSource
        ? t('已找到可用的账号、官方 API 或中转来源。', 'A usable account, official API, or relay source is available.')
        : t('先添加一个 OAuth 账号、官方 API 或中转来源。', 'Add an OAuth account, official API, or relay source first.'),
      complete: usableSource,
      page: 'providers',
      actionLabel: t('添加来源', 'Add source'),
    },
    {
      id: 'route-source',
      label: t('已准备可路由来源', 'Routable source ready'),
      description: routableSource
        ? t('已有可用号池、聚合中转或可直接路由的 API 来源。', 'A usable pool, aggregate relay, or directly routable API source is ready.')
        : t('为 OAuth 账号创建号池，或添加可直接路由的 API 来源。', 'Create a pool for OAuth accounts, or add a directly routable API source.'),
      complete: routableSource,
      page: 'pools',
      actionLabel: t('创建号池', 'Create pool'),
    },
    {
      id: 'route',
      label: t('已启用有效路由', 'Valid route enabled'),
      description: validRoutes.length > 0
        ? t(`已找到 ${validRoutes.length} 条引用有效来源的启用路由。`, `${validRoutes.length} enabled route(s) point to a valid source.`)
        : t('创建并启用一条路由，然后选择已存在的号池或 API 来源。', 'Create and enable a route, then select an existing pool or API source.'),
      complete: validRoutes.length > 0,
      page: 'routes',
      actionLabel: t('配置路由', 'Configure route'),
    },
    {
      id: 'gateway',
      label: t('网关正在运行', 'Gateway running'),
      description: snapshot.gatewayStatus.running
        ? t(`网关正在 ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} 监听。`, `The gateway is listening on ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port}.`)
        : t('启动本地网关，让客户端可以连接 Stone+。', 'Start the local gateway so clients can connect to Stone+.'),
      complete: snapshot.gatewayStatus.running,
      page: 'settings',
      actionLabel: t('启动网关', 'Start gateway'),
    },
    {
      id: 'client',
      label: t('客户端已配置', 'Client configured'),
      description: configuredClient
        ? t('至少一个已启用路由对应的客户端已连接 Stone+。', 'At least one client with an enabled route is connected to Stone+.')
        : t('将启用路由对应的 Claude Code、Codex 或 Gemini CLI 连接到 Stone+。', 'Connect Claude Code, Codex, or Gemini CLI for an enabled route to Stone+.'),
      complete: configuredClient,
      page: 'clients',
      actionLabel: t('配置客户端', 'Configure client'),
    },
  ]

  const completedCount = items.filter((item) => item.complete).length
  const totalCount = items.length
  return {
    items,
    completedCount,
    totalCount,
    percentage: totalCount === 0 ? 100 : Math.round((completedCount / totalCount) * 100),
    ready: completedCount === totalCount,
    nextAction: items.find((item) => !item.complete) ?? null,
  }
}
