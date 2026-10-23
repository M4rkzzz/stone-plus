import type { AppSnapshot } from '@shared/types'
import type { PageId } from './App'
import type { HelpReadiness, HelpReadinessTranslator } from './help-readiness'

export type SmartGuidanceTone = 'primary' | 'warning' | 'neutral'

export interface SmartGuidanceAction {
  id: string
  title: string
  description: string
  page: PageId
  actionLabel: string
  tone: SmartGuidanceTone
}

export function buildSmartGuidanceActions(
  snapshot: AppSnapshot,
  readiness: HelpReadiness,
  t: HelpReadinessTranslator,
  now = Date.now(),
): SmartGuidanceAction[] {
  const actions: SmartGuidanceAction[] = []
  const next = readiness.nextAction
  if (next) {
    actions.push({
      id: `readiness:${next.id}`,
      title: next.label,
      description: next.description,
      page: next.page,
      actionLabel: next.actionLabel,
      tone: 'primary',
    })
  }

  const recentFailures = snapshot.requestLogs.filter((log) => (
    log.status === 'error' && now - log.timestamp >= 0 && now - log.timestamp <= 30 * 60_000
  )).length
  if (recentFailures > 0) {
    actions.push({
      id: 'recent-failures',
      title: t('检查最近失败请求', 'Review recent failed requests'),
      description: t(
        `最近 30 分钟有 ${recentFailures} 个失败请求，可从失败阶段和状态码定位问题。`,
        `${recentFailures} request(s) failed in the last 30 minutes. Use the failure stage and status code to locate the issue.`,
      ),
      page: 'requests',
      actionLabel: t('查看失败记录', 'View failures'),
      tone: 'warning',
    })
  }

  const attentionAccounts = snapshot.accounts.filter((account) => (
    account.status === 'cooldown' || account.status === 'disabled' || account.status === 'expired'
  )).length
  if (attentionAccounts > 0) {
    actions.push({
      id: 'account-attention',
      title: t('处理需关注账号', 'Review accounts needing attention'),
      description: t(
        `${attentionAccounts} 个账号正在冷却、已停用或凭据过期；不会自动重新启用。`,
        `${attentionAccounts} account(s) are cooling down, disabled, or expired. Stone+ will not re-enable them automatically.`,
      ),
      page: 'providers',
      actionLabel: t('查看账号状态', 'Review accounts'),
      tone: 'warning',
    })
  }

  if (readiness.ready && snapshot.requestLogs.length === 0) {
    actions.push({
      id: 'first-request',
      title: t('发送第一条客户端请求', 'Send the first client request'),
      description: t('链路已经就绪，可以打开已连接的客户端验证完整转发。', 'The route is ready. Open a connected client to verify end-to-end forwarding.'),
      page: 'clients',
      actionLabel: t('打开客户端配置', 'Open client configuration'),
      tone: 'neutral',
    })
  } else if (readiness.ready) {
    actions.push({
      id: 'observe-requests',
      title: t('观察实时请求', 'Observe live requests'),
      description: t('链路已就绪，可查看首字延迟、上游来源、Token 和失败阶段。', 'The route is ready. Inspect first-token latency, upstream source, tokens, and failure stages.'),
      page: 'requests',
      actionLabel: t('打开请求记录', 'Open request logs'),
      tone: 'neutral',
    })
  }

  const seen = new Set<string>()
  return actions.filter((action) => {
    if (seen.has(action.id)) return false
    seen.add(action.id)
    return true
  }).slice(0, 3)
}

