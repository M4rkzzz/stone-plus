import { CheckCircle2, CircleAlert, Clock3, LoaderCircle, Trash2, X } from 'lucide-react'
import { useI18n, type UiLanguage } from './i18n'
import { Modal } from './ui'

export type OperationStatus = 'running' | 'success' | 'error'

export interface OperationRecord {
  id: string
  key: string
  label: string
  status: OperationStatus
  startedAt: number
  completedAt?: number
  message?: string
}

const operationLabels: Array<[prefix: string, zh: string, en: string]> = [
  ['gateway-power', '切换网关状态', 'Change gateway state'],
  ['agent-repair-all', '修复全部 Agent', 'Repair all agents'],
  ['agent-close-all', '关闭受管 Agent', 'Close managed agents'],
  ['agent-restart', '重启 Agent', 'Restart agent'],
  ['agent-restore', '修复并恢复 Agent', 'Repair and restore agent'],
  ['agent-close', '关闭 Agent', 'Close agent'],
  ['agent-start', '启动 Agent', 'Start agent'],
  ['rebuild-outbound', '重建低延迟出口', 'Rebuild low-latency connections'],
  ['check-all-accounts', '检测全部账号', 'Check all accounts'],
  ['refresh-account-models-', '刷新账号模型', 'Refresh account models'],
  ['open-chatgpt-codex-app-', '切换 Codex App OAuth 账号', 'Switch Codex App OAuth account'],
  ['refresh-quota-', '刷新账号额度', 'Refresh account quota'],
  ['check-proxy-', '检测代理出口', 'Check proxy exit'],
  ['check-', '检测账号', 'Check account'],
  ['save-aggregate-relay', '保存聚合中转', 'Save aggregate relay'],
  ['delete-aggregate-relay', '删除聚合中转', 'Delete aggregate relay'],
  ['save-api-source', '保存 API 来源', 'Save API source'],
  ['save-account-tag', '保存账号标签', 'Save account tag'],
  ['delete-account-tag', '删除账号标签', 'Delete account tag'],
  ['set-account-tags', '更新账号标签', 'Update account tags'],
  ['delete-accounts', '删除所选账号', 'Delete selected accounts'],
  ['save-account', '保存账号', 'Save account'],
  ['delete-item', '删除来源', 'Delete source'],
  ['save-proxy', '保存代理', 'Save proxy'],
  ['delete-proxy', '删除代理', 'Delete proxy'],
  ['save-pool', '保存号池', 'Save pool'],
  ['delete-pool', '删除号池', 'Delete pool'],
  ['save-route-', '保存路由', 'Save route'],
  ['toggle-route-', '切换路由', 'Toggle route'],
  ['fast-mode-', '切换高并发模式', 'Toggle high-concurrency mode'],
  ['clear-logs', '清空请求记录', 'Clear request logs'],
  ['update-check', '检查应用更新', 'Check for updates'],
  ['update-ignore', '忽略应用更新', 'Ignore app update'],
  ['update-download', '下载应用更新', 'Download app update'],
  ['update-install', '安装应用更新', 'Install app update'],
]

export function operationLabelForKey(key: string, language: UiLanguage): string {
  const match = operationLabels.find(([prefix]) => key === prefix || key.startsWith(prefix))
  return match ? match[language === 'zh-CN' ? 1 : 2] : language === 'zh-CN' ? '执行操作' : 'Run operation'
}

export function operationShouldNotify(key: string, status: OperationStatus): boolean {
  return status === 'error' || key === 'gateway-power' || key === 'rebuild-outbound' || key.startsWith('open-chatgpt-codex-app-') || key.startsWith('update-')
}

function OperationStatusIcon({ status }: { status: OperationStatus }) {
  if (status === 'running') return <LoaderCircle className="spin" size={16} />
  if (status === 'success') return <CheckCircle2 size={16} />
  return <CircleAlert size={16} />
}

export function OperationCenter({
  open,
  records,
  onClose,
  onClear,
}: {
  open: boolean
  records: readonly OperationRecord[]
  onClose: () => void
  onClear: () => void
}) {
  const { t, locale } = useI18n()
  return (
    <Modal
      open={open}
      title={t('最近操作', 'Recent operations')}
      description={t('仅保留本次运行中的最近 20 条操作，不记录账号、密钥或工具内容。', 'Keeps only the latest 20 operations from this run. Accounts, secrets, and tool contents are never recorded.')}
      onClose={onClose}
      width="medium"
    >
      <div className="operation-center">
        {records.length > 0 ? (
          <div className="operation-center__list">
            {records.map((record) => (
              <div className={`operation-center__item operation-center__item--${record.status}`} key={record.id}>
                <span className="operation-center__status"><OperationStatusIcon status={record.status} /></span>
                <span className="operation-center__copy">
                  <strong>{record.label}</strong>
                  <small>{record.message || (record.status === 'running' ? t('正在执行…', 'Running…') : record.status === 'success' ? t('已完成', 'Completed') : t('操作失败', 'Failed'))}</small>
                </span>
                <time dateTime={new Date(record.startedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(record.startedAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <div className="operation-center__empty"><Clock3 size={24} /><strong>{t('还没有操作记录', 'No operations yet')}</strong><span>{t('保存、检测、重建和网关操作会显示在这里。', 'Save, check, rebuild, and gateway operations will appear here.')}</span></div>
        )}
        {records.length > 0 && <div className="operation-center__footer"><button className="button button--secondary" type="button" onClick={onClear}><Trash2 size={15} />{t('清空记录', 'Clear history')}</button></div>}
      </div>
    </Modal>
  )
}

export function OperationToast({ record, onClose }: { record?: OperationRecord; onClose: () => void }) {
  const { t } = useI18n()
  if (!record) return null
  return (
    <div className={`operation-toast operation-toast--${record.status}`} role={record.status === 'error' ? 'alert' : 'status'}>
      <OperationStatusIcon status={record.status} />
      <div><strong>{record.label}</strong><span>{record.message || (record.status === 'success' ? t('已完成', 'Completed') : record.status === 'error' ? t('操作失败', 'Failed') : t('正在执行…', 'Running…'))}</span></div>
      <button className="icon-button" type="button" aria-label={t('关闭', 'Close')} onClick={onClose}><X size={14} /></button>
    </div>
  )
}
