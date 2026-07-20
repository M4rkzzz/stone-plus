import { useState } from 'react'
import { CheckCircle2, Edit3, Gauge, LoaderCircle, Network, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AppSnapshot, GatewayApi, ProxyInput, ProxyProtocol, PublicProxyDefinition } from '@shared/types'
import type { ActionRunner } from '../App'
import { localizeBackendMessage } from '../backend-message'
import { useI18n } from '../i18n'
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
  const { t, language, locale } = useI18n()
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
    if (!draft.name.trim()) nextErrors.name = t('请输入代理名称', 'Enter a proxy name.')
    if (!validProxyHost(draft.host)) nextErrors.host = t('请输入不含协议和端口的主机名或 IP 地址', 'Enter a hostname or IP address without a protocol or port.')
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) nextErrors.port = t('端口范围为 1–65535', 'Port must be between 1 and 65535.')
    if (draft.protocol === 'socks4' && draft.password) nextErrors.password = t('SOCKS4 仅支持 User ID，不支持密码', 'SOCKS4 supports a User ID only, not a password.')
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
        <div><strong>{t('可复用出口', 'Reusable proxies')}</strong></div>
        <button className="button button--primary" type="button" onClick={() => openProxy()}><Plus size={16} />{t('添加代理', 'Add proxy')}</button>
      </div>

      {snapshot.proxies.length ? (
        <section className="panel panel--flush">
          <div className="table-wrap">
            <table className="data-table proxy-table">
              <thead><tr><th>{t('代理', 'Proxy')}</th><th>{t('状态', 'Status')}</th><th>{t('入口', 'Endpoint')}</th><th>{t('出口 IP', 'Exit IP')}</th><th>{t('延迟', 'Latency')}</th><th>{t('最近检测', 'Last checked')}</th><th aria-label={t('操作', 'Actions')} /></tr></thead>
              <tbody>{snapshot.proxies.map((proxy) => {
                const checking = busyKeys.has(`check-proxy-${proxy.id}`)
                return <tr key={proxy.id}>
                  <td><div className="proxy-name-cell"><span className="proxy-protocol-icon"><Network size={16} /></span><div><strong>{proxy.name}</strong><span>{protocolLabels[proxy.protocol]} · {proxy.hasPassword || proxy.username ? t('已配置认证', 'Authentication configured') : t('无认证', 'No authentication')}</span></div></div></td>
                  <td><Badge tone={proxy.status === 'available' ? 'success' : proxy.status === 'error' ? 'danger' : 'neutral'}>{proxy.status === 'available' ? t('可用', 'Available') : proxy.status === 'error' ? t('异常', 'Error') : t('未检测', 'Not checked')}</Badge>{proxy.lastError && <span className="row-note row-note--danger">{localizeBackendMessage(proxy.lastError, language, t('代理检测失败', 'Proxy check failed.'))}</span>}</td>
                  <td><code className="proxy-entry">{entryAddress(proxy)}</code></td>
                  <td>{proxy.exitIp ? <span className="mono proxy-exit-ip">{proxy.exitIp}</span> : <span className="muted">{t('未知', 'Unknown')}</span>}</td>
                  <td>{proxy.latencyMs === undefined ? '—' : durationLabel(proxy.latencyMs)}</td>
                  <td>{relativeTime(proxy.lastCheckedAt, locale)}</td>
                  <td className="actions-cell"><button className="icon-button" type="button" title={t('检测出口 IP', 'Check exit IP')} disabled={checking} onClick={() => void runAction(`check-proxy-${proxy.id}`, () => api.checkProxy(proxy.id))}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button><button className="icon-button" type="button" title={t('编辑代理', 'Edit proxy')} onClick={() => openProxy(proxy)}><Edit3 size={16} /></button><button className="icon-button icon-button--danger" type="button" title={t('删除代理', 'Delete proxy')} onClick={() => setDeleteTarget(proxy)}><Trash2 size={16} /></button></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </section>
      ) : <section className="panel"><EmptyState icon={<Network size={25} />} title={t('尚未配置出口代理', 'No exit proxies configured')} action={<button className="button button--primary" type="button" onClick={() => openProxy()}><Plus size={16} />{t('添加代理', 'Add proxy')}</button>} /></section>}

      <Modal
        open={modalOpen}
        title={draft.id ? t('编辑出口代理', 'Edit exit proxy') : t('添加出口代理', 'Add exit proxy')}
        description={t('入口地址仅保存在本机；检测后显示代理的公网出口 IP', 'The endpoint is stored only on this device. A check reveals the proxy\'s public exit IP.')}
        onClose={closeProxy}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={closeProxy}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" form="proxy-form" disabled={busyKeys.has('save-proxy')}>{busyKeys.has('save-proxy') ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{t('保存代理', 'Save proxy')}</button></>}
      >
        <form id="proxy-form" className="form-grid" onSubmit={(event) => void submit(event)}>
          <label className="field field--full"><span>{t('显示名称', 'Display name')}</span><input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例如：Clash 本地出口', 'e.g. Local Clash proxy')} /><FieldError>{errors.name}</FieldError></label>
          <label className="field"><span>{t('协议', 'Protocol')}</span><select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProxyProtocol, password: event.target.value === 'socks4' ? '' : draft.password, clearPassword: event.target.value === 'socks4' && existingHasPassword ? true : draft.clearPassword })}>{(Object.keys(protocolLabels) as ProxyProtocol[]).map((protocol) => <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>)}</select></label>
          <label className="field"><span>{t('端口', 'Port')}</span><input className="mono" type="number" min={1} max={65_535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
          <label className="field field--full"><span>{t('主机 / IP', 'Host / IP')}</span><input className="mono" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="127.0.0.1" /><FieldError>{errors.host}</FieldError></label>
          <label className="field"><span>{draft.protocol === 'socks4' ? t('User ID（可选）', 'User ID (optional)') : t('用户名（可选）', 'Username (optional)')}</span><input autoComplete="off" value={draft.username ?? ''} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
          <label className="field"><span>{t('密码（可选）', 'Password (optional)')}</span><input type="password" autoComplete="new-password" disabled={draft.protocol === 'socks4'} value={draft.password ?? ''} onChange={(event) => setDraft({ ...draft, password: event.target.value, clearPassword: false })} placeholder={existingHasPassword ? t('留空表示保留现有密码', 'Leave blank to keep the current password') : ''} /><FieldError>{errors.password}</FieldError></label>
          {existingHasPassword && draft.protocol !== 'socks4' && <label className="proxy-clear-auth field--full"><input type="checkbox" checked={Boolean(draft.clearPassword)} onChange={(event) => setDraft({ ...draft, clearPassword: event.target.checked, password: event.target.checked ? '' : draft.password })} /><span>{t('清除已保存的代理密码', 'Clear the saved proxy password')}</span></label>}
          <div className="form-context field--full"><Gauge size={16} /><span>{t('入口', 'Endpoint')}</span><code>{draft.host ? entryAddress(draft as Pick<PublicProxyDefinition, 'protocol' | 'host' | 'port'>) : '—'}</code></div>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title={t('删除出口代理', 'Delete exit proxy')} message={t(`确定删除“${deleteTarget?.name ?? ''}”吗？被账号或号池引用时无法删除。`, `Delete “${deleteTarget?.name ?? ''}”? A proxy referenced by an account or pool cannot be deleted.`)} busy={busyKeys.has('delete-proxy')} onCancel={() => setDeleteTarget(null)} onConfirm={() => void remove()} />
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
