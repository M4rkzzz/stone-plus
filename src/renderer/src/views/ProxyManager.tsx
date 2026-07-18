import { useState } from 'react'
import { CheckCircle2, Edit3, Gauge, LoaderCircle, Network, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AppSnapshot, GatewayApi, ProxyInput, ProxyProtocol, PublicProxyDefinition } from '@shared/types'
import type { ActionRunner } from '../App'
import { Badge, ConfirmDialog, durationLabel, EmptyState, FieldError, Modal, relativeTime } from '../ui'

const protocolLabels: Record<ProxyProtocol, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
}

const emptyProxy: ProxyInput = {
  name: '',
  protocol: 'http',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  password: '',
}

export function ProxyManager({
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
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<ProxyInput>(emptyProxy)
  const [existingHasPassword, setExistingHasPassword] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<PublicProxyDefinition | null>(null)

  const closeProxy = () => {
    setModalOpen(false)
    setDraft({ ...emptyProxy })
    setExistingHasPassword(false)
    setErrors({})
  }

  const openProxy = (proxy?: PublicProxyDefinition) => {
    setDraft(proxy ? {
      id: proxy.id,
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username ?? '',
      password: '',
      clearPassword: false,
    } : { ...emptyProxy })
    setExistingHasPassword(Boolean(proxy?.hasPassword))
    setErrors({})
    setModalOpen(true)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!draft.name.trim()) nextErrors.name = '请输入代理名称'
    if (!validProxyHost(draft.host)) nextErrors.host = '请输入不含协议和端口的主机名或 IP 地址'
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) nextErrors.port = '端口范围为 1–65535'
    if (draft.protocol === 'socks4' && draft.password) nextErrors.password = 'SOCKS4 仅支持 User ID，不支持密码'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const success = await runAction('save-proxy', () => api.saveProxy({
      ...draft,
      name: draft.name.trim(),
      host: draft.host.trim(),
      username: draft.username?.trim() || undefined,
      password: draft.password || undefined,
    }))
    if (success) closeProxy()
  }

  const remove = async () => {
    if (!deleteTarget) return
    const success = await runAction('delete-proxy', () => api.deleteProxy(deleteTarget.id))
    if (success) setDeleteTarget(null)
  }

  return (
    <>
      <div className="proxy-toolbar">
        <div><strong>可复用出口</strong><span>账号覆盖优先于号池默认；未选择时直连</span></div>
        <button className="button button--primary" type="button" onClick={() => openProxy()}><Plus size={16} />添加代理</button>
      </div>

      {snapshot.proxies.length ? (
        <section className="panel panel--flush">
          <div className="table-wrap">
            <table className="data-table proxy-table">
              <thead><tr><th>代理</th><th>状态</th><th>入口</th><th>出口 IP</th><th>延迟</th><th>最近检测</th><th aria-label="操作" /></tr></thead>
              <tbody>{snapshot.proxies.map((proxy) => {
                const checking = busyKeys.has(`check-proxy-${proxy.id}`)
                return <tr key={proxy.id}>
                  <td><div className="proxy-name-cell"><span className="proxy-protocol-icon"><Network size={16} /></span><div><strong>{proxy.name}</strong><span>{protocolLabels[proxy.protocol]} · {proxy.hasPassword || proxy.username ? '已配置认证' : '无认证'}</span></div></div></td>
                  <td><Badge tone={proxy.status === 'available' ? 'success' : proxy.status === 'error' ? 'danger' : 'neutral'}>{proxy.status === 'available' ? '可用' : proxy.status === 'error' ? '异常' : '未检测'}</Badge>{proxy.lastError && <span className="row-note row-note--danger">{proxy.lastError}</span>}</td>
                  <td><code className="proxy-entry">{entryAddress(proxy)}</code></td>
                  <td>{proxy.exitIp ? <span className="mono proxy-exit-ip">{proxy.exitIp}</span> : <span className="muted">未知</span>}</td>
                  <td>{proxy.latencyMs === undefined ? '—' : durationLabel(proxy.latencyMs)}</td>
                  <td>{relativeTime(proxy.lastCheckedAt)}</td>
                  <td className="actions-cell"><button className="icon-button" type="button" title="检测出口 IP" disabled={checking} onClick={() => void runAction(`check-proxy-${proxy.id}`, () => api.checkProxy(proxy.id))}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button><button className="icon-button" type="button" title="编辑代理" onClick={() => openProxy(proxy)}><Edit3 size={16} /></button><button className="icon-button icon-button--danger" type="button" title="删除代理" onClick={() => setDeleteTarget(proxy)}><Trash2 size={16} /></button></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </section>
      ) : <section className="panel"><EmptyState icon={<Network size={25} />} title="尚未配置出口代理" description="添加本地 HTTP、HTTPS、SOCKS4 或 SOCKS5 代理" action={<button className="button button--primary" type="button" onClick={() => openProxy()}><Plus size={16} />添加代理</button>} /></section>}

      <Modal
        open={modalOpen}
        title={draft.id ? '编辑出口代理' : '添加出口代理'}
        description="入口地址仅保存在本机；检测后显示代理的公网出口 IP"
        onClose={closeProxy}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={closeProxy}>取消</button><button className="button button--primary" type="submit" form="proxy-form" disabled={busyKeys.has('save-proxy')}>{busyKeys.has('save-proxy') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}保存代理</button></>}
      >
        <form id="proxy-form" className="form-grid" onSubmit={(event) => void submit(event)}>
          <label className="field field--full"><span>显示名称</span><input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：Clash 本地出口" /><FieldError>{errors.name}</FieldError></label>
          <label className="field"><span>协议</span><select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProxyProtocol, password: event.target.value === 'socks4' ? '' : draft.password, clearPassword: event.target.value === 'socks4' && existingHasPassword ? true : draft.clearPassword })}>{(Object.keys(protocolLabels) as ProxyProtocol[]).map((protocol) => <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>)}</select></label>
          <label className="field"><span>端口</span><input className="mono" type="number" min={1} max={65_535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
          <label className="field field--full"><span>主机 / IP</span><input className="mono" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="127.0.0.1" /><FieldError>{errors.host}</FieldError></label>
          <label className="field"><span>{draft.protocol === 'socks4' ? 'User ID（可选）' : '用户名（可选）'}</span><input autoComplete="off" value={draft.username ?? ''} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
          <label className="field"><span>密码（可选）</span><input type="password" autoComplete="new-password" disabled={draft.protocol === 'socks4'} value={draft.password ?? ''} onChange={(event) => setDraft({ ...draft, password: event.target.value, clearPassword: false })} placeholder={existingHasPassword ? '留空表示保留现有密码' : ''} /><FieldError>{errors.password}</FieldError></label>
          {existingHasPassword && draft.protocol !== 'socks4' && <label className="proxy-clear-auth field--full"><input type="checkbox" checked={Boolean(draft.clearPassword)} onChange={(event) => setDraft({ ...draft, clearPassword: event.target.checked, password: event.target.checked ? '' : draft.password })} /><span>清除已保存的代理密码</span></label>}
          <div className="form-context field--full"><Gauge size={16} /><span>入口</span><code>{draft.host ? entryAddress(draft as Pick<PublicProxyDefinition, 'protocol' | 'host' | 'port'>) : '—'}</code></div>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title="删除出口代理" message={`确定删除“${deleteTarget?.name ?? ''}”吗？被账号或号池引用时无法删除。`} busy={busyKeys.has('delete-proxy')} onCancel={() => setDeleteTarget(null)} onConfirm={() => void remove()} />
    </>
  )
}

function entryAddress(proxy: Pick<PublicProxyDefinition, 'protocol' | 'host' | 'port'>): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${host}:${proxy.port}`
}

function validProxyHost(value: string): boolean {
  const raw = value.trim()
  if (!raw || raw.includes('://') || /[\s/@?#]/.test(raw)) return false
  const candidate = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
  try {
    return Boolean(new URL(`http://${candidate}:1`).hostname)
  } catch {
    return false
  }
}
