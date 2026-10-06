import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronDown, CircleAlert, CircleDot, MonitorCog, Network, Radio, Server, Waypoints } from 'lucide-react'
import type { PageId } from './App'
import type { HelpReadiness, HelpReadinessCheckId } from './help-readiness'
import type { SmartGuidanceAction } from './smart-guidance'
import { useI18n } from './i18n'

const stageIcons: Record<HelpReadinessCheckId, typeof Server> = {
  source: Server,
  'route-source': Waypoints,
  route: Network,
  gateway: Radio,
  client: MonitorCog,
}

const READINESS_PANEL_EXPANDED_STORAGE_KEY = 'stone.overview.readiness.expanded.v1'

function storedExpandedState(): boolean {
  try {
    return window.localStorage.getItem(READINESS_PANEL_EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function ReadinessPanel({
  readiness,
  actions,
  scanning,
  navigate,
}: {
  readiness: HelpReadiness
  actions: readonly SmartGuidanceAction[]
  scanning: boolean
  navigate: (page: PageId) => void
}) {
  const { t } = useI18n()
  const nextId = readiness.nextAction?.id
  const warningCount = actions.filter((action) => action.tone === 'warning').length
  const [expanded, setExpanded] = useState(storedExpandedState)

  useEffect(() => {
    try {
      window.localStorage.setItem(READINESS_PANEL_EXPANDED_STORAGE_KEY, String(expanded))
    } catch {
      // Collapsing this optional overview panel must never affect readiness.
    }
  }, [expanded])

  return (
    <section className={`readiness-panel ${expanded ? 'readiness-panel--expanded' : 'readiness-panel--collapsed'}`} aria-labelledby="readiness-title">
      <header className="readiness-panel__header">
        <div className="readiness-panel__identity">
          <span className="readiness-panel__eyebrow"><CircleDot size={13} />{t('端到端就绪链', 'End-to-end readiness')}</span>
          <h2 id="readiness-title">{readiness.ready ? t('Stone+ 已经可以接收客户端请求', 'Stone+ is ready for client requests') : t('当前链路还差一步', 'The route still needs attention')}</h2>
          {expanded && <p>{scanning ? t('正在检查本机客户端配置…', 'Checking local client configuration…') : readiness.ready ? t('来源、路由、网关和客户端配置均已就绪。', 'Source, route, gateway, and client configuration are ready.') : readiness.nextAction?.description}</p>}
        </div>
        <div className="readiness-panel__summary">
          <span className="readiness-panel__score" title={t('就绪项目', 'Ready checks')}>{readiness.completedCount}<span>/ {readiness.totalCount}</span></span>
          {scanning && <span className="readiness-panel__summary-note readiness-panel__summary-note--scanning"><CircleDot size={12} />{t('检查中', 'Checking')}</span>}
          {!scanning && warningCount > 0 && <span className="readiness-panel__summary-note readiness-panel__summary-note--warning"><CircleAlert size={13} />{t(`${warningCount} 项需关注`, `${warningCount} need attention`)}</span>}
          {!scanning && warningCount === 0 && readiness.ready && <span className="readiness-panel__summary-note readiness-panel__summary-note--ready"><Check size={13} />{t('全部就绪', 'All ready')}</span>}
          {!scanning && !readiness.ready && readiness.nextAction && <span className="readiness-panel__summary-note">{t('下一步', 'Next')}：{readiness.nextAction.label}</span>}
          <button className="readiness-panel__toggle" type="button" aria-expanded={expanded} aria-controls="readiness-panel-details" onClick={() => setExpanded((current) => !current)}>
            <span>{expanded ? t('收起详情', 'Hide details') : t('展开详情', 'Show details')}</span><ChevronDown size={15} />
          </button>
        </div>
      </header>

      <div className="readiness-panel__details" id="readiness-panel-details" hidden={!expanded}>
        <section className="readiness-panel__region" aria-labelledby="readiness-chain-title">
          <header className="readiness-panel__region-title"><strong id="readiness-chain-title">{t('链路状态', 'Route status')}</strong><span>{readiness.percentage}%</span></header>
          <div className="readiness-chain" aria-label={t('配置链路状态', 'Configuration route status')}>
            {readiness.items.map((item) => {
              const Icon = stageIcons[item.id]
              const current = item.id === nextId
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`readiness-stage ${item.complete ? 'readiness-stage--ready' : current ? 'readiness-stage--current' : 'readiness-stage--pending'}`}
                  title={item.description}
                  onClick={() => navigate(item.page)}
                >
                  <span className="readiness-stage__icon">{item.complete ? <Check size={15} /> : <Icon size={16} />}</span>
                  <span><strong>{item.label}</strong><small>{item.complete ? t('已就绪', 'Ready') : current ? t('下一步', 'Next') : t('待完成', 'Pending')}</small></span>
                </button>
              )
            })}
          </div>
        </section>

        {actions.length > 0 && (
          <section className="readiness-panel__region readiness-panel__region--actions" aria-labelledby="readiness-actions-title">
            <header className="readiness-panel__region-title"><strong id="readiness-actions-title">{t('建议操作', 'Suggested actions')}</strong><span>{t(`${actions.length} 项`, `${actions.length} items`)}</span></header>
            <div className="smart-guidance" aria-label={t('建议的下一步', 'Suggested next steps')}>
              {actions.map((action) => (
                <button className={`smart-guidance__item smart-guidance__item--${action.tone}`} type="button" key={action.id} onClick={() => navigate(action.page)}>
                  <span className="smart-guidance__icon">{action.tone === 'warning' ? <CircleAlert size={16} /> : <ArrowRight size={16} />}</span>
                  <span><strong>{action.title}</strong><small>{action.description}</small></span>
                  <span className="smart-guidance__action">{action.actionLabel}<ArrowRight size={13} /></span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  )
}
