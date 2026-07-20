import type { AppSnapshot, GatewayApi } from '@shared/types'
import type { ActionRunner } from '../App'
import { useI18n } from '../i18n'
import { PageHeader } from '../ui'
import { ProxyManager } from './ProxyManager'

export function ProxyView({
  snapshot,
  api,
  runAction,
  busyKeys,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
}) {
  const { t } = useI18n()
  return (
    <div className="page-stack">
      <PageHeader
        title={t('出口代理', 'Exit proxies')}
      />
      <ProxyManager snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
    </div>
  )
}
