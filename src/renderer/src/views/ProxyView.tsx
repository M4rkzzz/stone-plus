import type { AppSnapshot, GatewayApi } from '@shared/types'
import type { ActionRunner } from '../App'
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
  return (
    <div className="page-stack">
      <PageHeader
        title="出口代理"
        description="统一管理账号与号池可复用的 HTTP、HTTPS 和 SOCKS 网络出口"
      />
      <ProxyManager snapshot={snapshot} api={api} runAction={runAction} busyKeys={busyKeys} />
    </div>
  )
}
