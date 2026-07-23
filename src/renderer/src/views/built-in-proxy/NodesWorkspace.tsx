import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileCode2,
  Gauge,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unplug,
  Zap,
} from 'lucide-react'
import type {
  BuiltInProxyNodeSummary,
  BuiltInProxyProfileFormat,
  BuiltInProxyProfileSummary,
} from '@shared/types'
import { useI18n } from '../../i18n'
import { Badge, durationLabel, relativeTime } from '../../ui'
import {
  selectBuiltInProxyNodes,
  type BuiltInProxyNodeSortMode,
} from '../../built-in-proxy-node-tools'
import {
  ALL_NODE_GROUPS,
  UNGROUPED_NODES,
  deriveNodesWorkspaceModel,
} from './nodes-workspace-model'
import './nodes-workspace.css'

const EMPTY_PENDING = new Set<string>()

const profileFormatLabels: Record<BuiltInProxyProfileFormat, readonly [string, string]> = {
  'sing-box-json': ['sing-box JSON', 'sing-box JSON'],
  'clash-meta-yaml': ['Clash Meta YAML', 'Clash Meta YAML'],
  'uri-list': ['URI 列表', 'URI list'],
}

export interface NodesWorkspaceProps {
  section?: 'all' | 'profiles' | 'nodes'
  profiles: readonly BuiltInProxyProfileSummary[]
  activeProfileId?: string
  /** Controlled value from the existing per-profile localStorage preference. */
  groupFilter: string
  /** Controlled value from the existing node-panel localStorage preference. */
  collapsed: boolean
  disabled?: boolean
  pending?: ReadonlySet<string>
  onSelectProfile: (profileId: string) => void
  onRefreshProfile: (profileId: string) => void
  onDeleteProfile: (profile: BuiltInProxyProfileSummary) => void
  onImportProfile: () => void
  onSelectGroup: (group: string) => void
  onToggleCollapsed: () => void
  onSelectNode: (profileId: string, nodeId: string) => void
  onTestLatency: (profile: BuiltInProxyProfileSummary, nodeIds?: string[]) => void
}

export function NodesWorkspace({
  section = 'all',
  profiles,
  activeProfileId,
  groupFilter: requestedGroupFilter,
  collapsed,
  disabled = false,
  pending = EMPTY_PENDING,
  onSelectProfile,
  onRefreshProfile,
  onDeleteProfile,
  onImportProfile,
  onSelectGroup,
  onToggleCollapsed,
  onSelectNode,
  onTestLatency,
}: NodesWorkspaceProps) {
  const { t, locale } = useI18n()
  const model = deriveNodesWorkspaceModel(profiles, activeProfileId, requestedGroupFilter)
  const { activeProfile, activeNode, groups, hasUngroupedNodes, groupFilter, visibleNodes } = model
  const [nodeQuery, setNodeQuery] = useState('')
  const [nodeSort, setNodeSort] = useState<BuiltInProxyNodeSortMode>('current')
  const selectedNodes = useMemo(() => selectBuiltInProxyNodes(visibleNodes, {
    query: nodeQuery,
    sortMode: nodeSort,
    activeNodeId: activeProfile?.activeNodeId,
    locale,
  }), [activeProfile?.activeNodeId, locale, nodeQuery, nodeSort, visibleNodes])
  const selectedGroupLabel = groupFilter === ALL_NODE_GROUPS
    ? t('全部节点', 'All nodes')
    : groupFilter === UNGROUPED_NODES
      ? t('未分组', 'Ungrouped')
      : groupFilter

  return <div className="nodes-workspace">
    {section !== 'nodes' && <section className="panel nodes-workspace__profiles" aria-labelledby="nodes-workspace-profiles-title">
      <div className="nodes-workspace__section-heading">
        <div>
          <FileCode2 size={18} />
          <span>
            <strong id="nodes-workspace-profiles-title">{t('代理配置', 'Proxy profiles')}</strong>
            <small>{t('选择一份配置；节点选择会随配置保存', 'Choose one profile; its selected node is saved with it')}</small>
          </span>
        </div>
        <div className="nodes-workspace__heading-actions">
          <Badge tone="neutral">{profiles.length}</Badge>
          <button type="button" className="button button--secondary" disabled={disabled || pending.has('import')} onClick={onImportProfile}>
            <Plus size={14} />{t('导入配置', 'Import profile')}
          </button>
        </div>
      </div>

      <div className="nodes-workspace__profile-grid">
        {profiles.map((profile) => {
          const active = activeProfile?.id === profile.id
          const selectedNode = profile.nodes.find((node) => node.id === profile.activeNodeId)
          const selecting = pending.has(`select-profile-${profile.id}`)
          const refreshing = pending.has(`refresh-profile-${profile.id}`)
          const deleting = pending.has(`delete-profile-${profile.id}`)
          return <article className={`nodes-workspace__profile-card ${active ? 'is-active' : ''}`} key={profile.id}>
            <button
              type="button"
              className="nodes-workspace__profile-select"
              aria-pressed={active}
              disabled={disabled || selecting}
              onClick={() => onSelectProfile(profile.id)}
            >
              <span className="nodes-workspace__radio">
                {selecting ? <LoaderCircle size={13} className="spin" /> : active ? <Check size={13} /> : null}
              </span>
              <span>
                <strong>{profile.name}</strong>
                <small>{t(...profileFormatLabels[profile.format])} · {t(`${profile.nodeCount} 个节点`, `${profile.nodeCount} node(s)`)}</small>
              </span>
            </button>
            <div className="nodes-workspace__profile-current">
              <small>{t('当前节点', 'Selected node')}</small>
              <strong>{selectedNode?.name ?? t('等待可用节点', 'Waiting for an available node')}</strong>
              <span>{profile.source === 'subscription' ? t('订阅', 'Subscription') : t('本地导入', 'Local import')} · {relativeTime(profile.lastRefreshAt ?? profile.updatedAt, locale)}</span>
            </div>
            <div className="nodes-workspace__profile-footer">
              {profile.ruleStatus === 'fallback'
                ? <Badge tone="warning">{t('规则降级', 'Rule fallback')}</Badge>
                : <Badge tone="success">{t('规则已保留', 'Rules preserved')}</Badge>}
              <div>
                {profile.source === 'subscription' && <button
                  type="button"
                  className="nodes-workspace__icon-button"
                  title={t('刷新订阅', 'Refresh subscription')}
                  aria-label={t(`刷新订阅 ${profile.name}`, `Refresh subscription ${profile.name}`)}
                  disabled={disabled || refreshing}
                  onClick={() => onRefreshProfile(profile.id)}
                >{refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button>}
                <button
                  type="button"
                  className="nodes-workspace__icon-button nodes-workspace__icon-button--danger"
                  title={t('删除配置', 'Delete profile')}
                  aria-label={t(`删除配置 ${profile.name}`, `Delete profile ${profile.name}`)}
                  disabled={disabled || deleting}
                  onClick={() => onDeleteProfile(profile)}
                >{deleting ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}</button>
              </div>
            </div>
          </article>
        })}

        <button type="button" className="nodes-workspace__import-card" disabled={disabled || pending.has('import')} onClick={onImportProfile}>
          <Plus size={18} />
          <strong>{t('导入订阅或配置', 'Import a subscription or profile')}</strong>
          <small>{t('支持 sing-box JSON、Clash Meta YAML 与 URI 列表', 'Supports sing-box JSON, Clash Meta YAML, and URI lists')}</small>
        </button>
      </div>
    </section>}

    {section !== 'profiles' && <section className="panel nodes-workspace__nodes" aria-labelledby="nodes-workspace-nodes-title">
      <div className="nodes-workspace__section-heading nodes-workspace__nodes-heading">
        <button type="button" className="nodes-workspace__collapse" aria-expanded={!collapsed} onClick={onToggleCollapsed}>
          <Zap size={18} />
          <span>
            <strong id="nodes-workspace-nodes-title">{t('节点与分组', 'Nodes and groups')}</strong>
            <small>{t(
              `已选：${activeNode?.name ?? '等待节点'} · ${selectedGroupLabel}`,
              `Selected: ${activeNode?.name ?? 'Waiting for node'} · ${selectedGroupLabel}`,
            )}</small>
          </span>
          <ChevronDown size={16} className={collapsed ? 'is-collapsed' : ''} />
        </button>
        {!collapsed && activeProfile && <button
          type="button"
          className="button button--secondary"
          disabled={disabled || pending.has(`latency-${activeProfile.id}`)}
          onClick={() => onTestLatency(activeProfile)}
        >
          {pending.has(`latency-${activeProfile.id}`) ? <LoaderCircle size={14} className="spin" /> : <Gauge size={14} />}
          {t('测试全部延迟', 'Test all latency')}
        </button>}
      </div>

      <div className="nodes-workspace__selection" aria-label={t('当前选择概览', 'Current selection overview')}>
        <span><FileCode2 size={14} /><small>{t('配置', 'Profile')}</small><strong>{activeProfile?.name ?? t('未选择', 'Not selected')}</strong></span>
        <i aria-hidden="true" />
        <span><Layers3 size={14} /><small>{t('分组', 'Group')}</small><strong>{selectedGroupLabel}</strong></span>
        <i aria-hidden="true" />
        <span><Zap size={14} /><small>{t('节点', 'Node')}</small><strong>{activeNode?.name ?? t('等待节点', 'Waiting for node')}</strong></span>
      </div>

      {!collapsed && <>
        {activeProfile && (groups.length > 0 || hasUngroupedNodes) && <div className="nodes-workspace__groups" role="group" aria-label={t('筛选节点分组', 'Filter node groups')}>
          <button type="button" aria-pressed={groupFilter === ALL_NODE_GROUPS} className={groupFilter === ALL_NODE_GROUPS ? 'is-active' : ''} onClick={() => onSelectGroup(ALL_NODE_GROUPS)}>{t('全部', 'All')}<span>{activeProfile.nodes.length}</span></button>
          {groups.map((group) => <button type="button" key={group} aria-pressed={groupFilter === group} className={groupFilter === group ? 'is-active' : ''} onClick={() => onSelectGroup(group)}>{group}<span>{activeProfile.nodes.filter((node) => node.groupIds.includes(group)).length}</span></button>)}
          {hasUngroupedNodes && <button type="button" aria-pressed={groupFilter === UNGROUPED_NODES} className={groupFilter === UNGROUPED_NODES ? 'is-active' : ''} onClick={() => onSelectGroup(UNGROUPED_NODES)}>{t('未分组', 'Ungrouped')}<span>{activeProfile.nodes.filter((node) => node.groupIds.length === 0).length}</span></button>}
        </div>}

        {activeProfile && <div className="nodes-workspace__node-toolbar">
          <label>
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">{t('搜索节点', 'Search nodes')}</span>
            <input
              type="search"
              value={nodeQuery}
              placeholder={t('搜索名称、协议或分组', 'Search name, protocol, or group')}
              onChange={(event) => setNodeQuery(event.target.value)}
            />
          </label>
          <label>
            <span>{t('排序', 'Sort')}</span>
            <select value={nodeSort} onChange={(event) => setNodeSort(event.target.value as BuiltInProxyNodeSortMode)}>
              <option value="current">{t('当前节点优先', 'Current node first')}</option>
              <option value="latency">{t('延迟从低到高', 'Lowest latency')}</option>
              <option value="name">{t('按名称', 'By name')}</option>
            </select>
          </label>
          <small aria-live="polite" aria-atomic="true">{t(`显示 ${selectedNodes.length} / ${visibleNodes.length}`, `Showing ${selectedNodes.length} / ${visibleNodes.length}`)}</small>
        </div>}

        <div className="nodes-workspace__table-wrap">
          <table className="nodes-workspace__table">
            <thead><tr><th scope="col">{t('节点', 'Node')}</th><th scope="col">{t('分组', 'Groups')}</th><th scope="col">{t('延迟', 'Latency')}</th><th scope="col">{t('最近测试', 'Last tested')}</th><th scope="col" aria-label={t('操作', 'Actions')} /></tr></thead>
            <tbody>{activeProfile && selectedNodes.map((node) => {
              const active = activeProfile.activeNodeId === node.id
              const selecting = pending.has(`select-node-${node.id}`)
              const testing = pending.has(`latency-${activeProfile.id}`)
                || pending.has(`latency-${node.id}`)
                || node.latencyStatus === 'testing'
              return <tr key={node.id} className={active ? 'is-active' : ''}>
                <td data-label={t('节点', 'Node')}>
                  <div className="nodes-workspace__node-name">
                    <span className="nodes-workspace__radio">{selecting ? <LoaderCircle size={13} className="spin" /> : active ? <Check size={13} /> : null}</span>
                    <span><strong>{node.name}</strong><small>{node.type}</small></span>
                    {active && <Badge tone="success">{t('使用中', 'Active')}</Badge>}
                  </div>
                </td>
                <td data-label={t('分组', 'Groups')}><div className="nodes-workspace__node-groups">{node.groupIds.length ? node.groupIds.map((group) => <span key={group}>{group}</span>) : <span>{t('未分组', 'Ungrouped')}</span>}</div></td>
                <td data-label={t('延迟', 'Latency')}><NodeLatency node={node} testing={testing} /></td>
                <td data-label={t('最近测试', 'Last tested')}>{relativeTime(node.lastTestedAt, locale)}</td>
                <td className="nodes-workspace__node-actions">
                  <button type="button" className="nodes-workspace__icon-button" title={t('测试此节点延迟', 'Test this node latency')} aria-label={t(`测试节点 ${node.name} 的延迟`, `Test latency for node ${node.name}`)} disabled={disabled || testing} onClick={() => onTestLatency(activeProfile, [node.id])}>{testing ? <LoaderCircle size={15} className="spin" /> : <Gauge size={15} />}</button>
                  <button type="button" className={`nodes-workspace__use ${active ? 'is-active' : ''}`} disabled={disabled || active || selecting} onClick={() => onSelectNode(activeProfile.id, node.id)}>{selecting ? <LoaderCircle size={13} className="spin" /> : active ? t('已选择', 'Selected') : t('使用', 'Use')}</button>
                </td>
              </tr>
            })}</tbody>
          </table>
          {(!activeProfile || selectedNodes.length === 0) && <div className="nodes-workspace__empty"><Unplug size={20} /><span>{activeProfile ? nodeQuery.trim() ? t('没有匹配的节点', 'No matching nodes') : t('此分组没有节点', 'No nodes in this group') : t('请先导入一份代理配置', 'Import a proxy profile first')}</span>{!activeProfile && <button type="button" className="button button--primary" disabled={disabled} onClick={onImportProfile}><Plus size={14} />{t('导入配置', 'Import profile')}</button>}</div>}
        </div>

        {activeProfile && (activeProfile.warning || activeProfile.ruleStatus === 'fallback') && <div className="nodes-workspace__warning"><AlertTriangle size={16} /><span>{activeProfile.warning ?? t('配置规则无法安全转换，当前使用内置安全规则。', 'Profile rules could not be converted safely; the built-in safe rules are active.')}</span></div>}
      </>}
    </section>}
  </div>
}

function NodeLatency({ node, testing }: { node: BuiltInProxyNodeSummary; testing: boolean }) {
  const { t } = useI18n()
  if (testing) return <Badge tone="info"><LoaderCircle size={12} className="spin" />{t('测试中', 'Testing')}</Badge>
  if (node.latencyStatus === 'timeout') return <Badge tone="danger">{t('超时', 'Timeout')}</Badge>
  if (node.latencyStatus === 'error') return <Badge tone="danger">{t('失败', 'Error')}</Badge>
  if (node.latencyStatus === 'available' && node.latencyMs !== undefined) {
    return <Badge tone={node.latencyMs <= 200 ? 'success' : node.latencyMs <= 500 ? 'warning' : 'danger'}>{durationLabel(node.latencyMs)}</Badge>
  }
  return <Badge tone="neutral">{t('未测试', 'Untested')}</Badge>
}
