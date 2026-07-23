import type { AppSnapshot, NetworkDiagnosticStatus } from '@shared/types'
import { listRouteSources } from '@shared/route-sources'
import { localizeBackendMessage } from './backend-message'
import type { UiLanguage } from './i18n'

type Translator = (chinese: string, english: string) => string

export interface LocalDiagnosticCheck {
  id: string
  label: string
  status: NetworkDiagnosticStatus
  message: string
}

export function buildLocalChecks(snapshot: AppSnapshot, proxyId: string, language: UiLanguage, t: Translator): LocalDiagnosticCheck[] {
  const now = Date.now()
  const activeAccounts = snapshot.accounts.filter((account) => account.status === 'active').length
  const unavailableAccounts = snapshot.accounts.filter((account) => account.status === 'disabled' || account.status === 'expired').length
  const exhaustedAccounts = snapshot.accounts.filter((account) =>
    account.cooldownReason === 'quota' && (account.cooldownUntil === undefined || account.cooldownUntil > now)).length
  const enabledRoutes = snapshot.routes.filter((route) => route.enabled)
  const availableSourceIds = new Set(listRouteSources(snapshot).map((source) => source.id))
  const invalidRoutes = enabledRoutes.filter((route) => !availableSourceIds.has(route.poolId)).length
  const enabledRoutePoolIds = new Set(enabledRoutes.map((route) => route.poolId))
  const emptyPools = snapshot.pools.filter((pool) => enabledRoutePoolIds.has(pool.id) && !pool.members.some((member) =>
    member.enabled && snapshot.accounts.some((account) => account.id === member.accountId))).length
  const expiringOAuth = snapshot.accounts.filter((account) => account.credentialType === 'chatgpt-oauth'
    && account.credentialExpiresAt !== undefined && account.credentialExpiresAt <= now + 15 * 60_000
    && account.renewable !== true).length
  const proxy = proxyId ? snapshot.proxies.find((candidate) => candidate.id === proxyId) : undefined
  return [
    {
      id: 'gateway', label: t('本地网关', 'Local gateway'),
      status: snapshot.gatewayStatus.running ? 'success' : 'warning',
      message: snapshot.gatewayStatus.running
        ? t(`运行中 · ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} · ${snapshot.gatewayStatus.activeRequests} 个活跃请求`, `Running · ${snapshot.gatewayStatus.host}:${snapshot.gatewayStatus.port} · ${snapshot.gatewayStatus.activeRequests} active requests`)
        : t('当前未启动；网络诊断仍可运行，但客户端暂时无法通过 Stone+ 请求。', 'Not running. Diagnostics remain available, but clients cannot currently send requests through Stone+.')
    },
    {
      id: 'accounts', label: t('上游账号', 'Upstream accounts'),
      status: activeAccounts > 0 ? unavailableAccounts > 0 || exhaustedAccounts > 0 ? 'warning' : 'success' : 'error',
      message: t(`${activeAccounts} 个可用 · ${unavailableAccounts} 个停用/过期 · ${exhaustedAccounts} 个额度冷却`, `${activeAccounts} available · ${unavailableAccounts} disabled/expired · ${exhaustedAccounts} quota cooldown`)
    },
    {
      id: 'routing', label: t('源与客户端路由', 'Sources and client routes'),
      status: invalidRoutes > 0 || emptyPools > 0 ? 'error' : enabledRoutes.length > 0 ? 'success' : 'warning',
      message: invalidRoutes > 0 || emptyPools > 0
        ? t(`${invalidRoutes} 条路由缺少可用源 · ${emptyPools} 个号池没有启用成员`, `${invalidRoutes} routes lack a usable source · ${emptyPools} pools have no enabled members`)
        : t(`${snapshot.pools.length} 个号池/聚合中转 · ${enabledRoutes.length} 条已启用路由`, `${snapshot.pools.length} pools/aggregates · ${enabledRoutes.length} enabled routes`)
    },
    {
      id: 'oauth', label: t('ChatGPT OAuth 会话', 'ChatGPT OAuth sessions'),
      status: expiringOAuth > 0 ? 'warning' : 'success',
      message: expiringOAuth > 0
        ? t(`${expiringOAuth} 个不可续期会话将在 15 分钟内过期，需要重新导入。`, `${expiringOAuth} non-renewable sessions expire within 15 minutes and must be imported again.`)
        : t('未发现即将到期且无法自动续期的 ChatGPT 会话。', 'No ChatGPT sessions are both near expiry and unable to renew automatically.')
    },
    {
      id: 'proxy', label: t('本次测试出口', 'Route used for this test'),
      status: proxyId && !proxy ? 'error' : proxy?.status === 'error' ? 'warning' : 'success',
      message: proxy
        ? `${proxy.name} · ${proxy.protocol.toUpperCase()} · ${proxy.status === 'available' ? t(`已验证${proxy.exitIp ? ` · ${proxy.exitIp}` : ''}`, `Verified${proxy.exitIp ? ` · ${proxy.exitIp}` : ''}`) : proxy.status === 'error' ? localizeBackendMessage(proxy.lastError, language, t('上次检测失败', 'Last proxy check failed.')) : t('尚未单独检测', 'Not tested separately')}`
        : proxyId
          ? t('所选代理已不存在。', 'The selected proxy no longer exists.')
          : snapshot.gateway.outboundNetworkMode === 'system'
            ? t('系统代理（全局）', 'System proxy (global)')
            : t('直连（系统网络）', 'Direct (system network)')
    }
  ]
}
