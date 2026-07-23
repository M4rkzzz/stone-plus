import { useCallback, useEffect, useState } from 'react'
import { FolderCog, LoaderCircle, Play, Plus, Square, Trash2 } from 'lucide-react'
import type { AppSnapshot, GatewayApi, ManagedClientInstance, ManagedClientInstanceInput, RouteClient } from '@shared/types'
import { clientBrandMeta } from './brand-icons'
import { useI18n } from './i18n'
import { Modal } from './ui'

const defaultManagedLaunchMode = !window.stone || window.stonePlatform === 'win32' ? 'terminal' : 'background'

export function ManagedClientInstancesPanel({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const { t } = useI18n()
  const [instances, setInstances] = useState<ManagedClientInstance[]>([])
  const [draft, setDraft] = useState<ManagedClientInstanceInput | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { void api.listManagedClientInstances().then(setInstances).catch(() => undefined) }, [api])
  useEffect(() => {
    load()
    const unsubscribe = api.onManagedClientInstancesChanged(setInstances)
    const timer = setInterval(load, 2_000)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [api, load])

  const perform = async (key: string, operation: () => Promise<ManagedClientInstance[]>) => {
    setBusy(key); setError(null)
    try { setInstances(await operation()); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false }
    finally { setBusy(null) }
  }
  const create = (client: RouteClient = 'codex') => setDraft({
    name: t('新客户端实例', 'New client instance'), client, configDirectory: '', launchArgs: [], launchMode: defaultManagedLaunchMode,
    routeId: snapshot.routes.find((route) => route.client === client)?.id,
    profileId: snapshot.clientProfiles.find((profile) => profile.client === client)?.id
  })

  return <section className="managed-instances panel">
    <header className="managed-instances__header">
      <div><FolderCog size={18} /><span><strong>{t('客户端实例', 'Client instances')}</strong><small>{t('独立配置、工作目录和启动进程', 'Isolated configuration, workspace, and process')}</small></span></div>
      <button className="button button--secondary" type="button" onClick={() => create()}><Plus size={15} />{t('添加实例', 'Add instance')}</button>
    </header>
    {error && <div className="client-preview-error">{error}</div>}
    <div className="managed-instances__list">
      {instances.length === 0 ? <span className="muted">{t('尚未创建受管实例', 'No managed instances')}</span> : instances.map((instance) => {
        const brand = clientBrandMeta[instance.client]
        return <article key={instance.id}>
          <img className="managed-instance-brand" src={brand.icon} alt="" /><span><strong>{instance.name}</strong><small>{instance.stopError ?? instance.workingDirectory ?? instance.configDirectory}</small></span>
          <i className={`managed-instance-status is-${instance.status}`}>{instance.status}{instance.pid ? ` · ${instance.pid}` : ''}</i>
          {instance.processAlive || instance.status === 'running' || instance.status === 'stopping'
            ? <button className="icon-button" type="button" title={t('停止', 'Stop')} disabled={Boolean(busy)} onClick={() => void perform(`stop-${instance.id}`, () => api.stopManagedClientInstance(instance.id))}>{busy === `stop-${instance.id}` ? <LoaderCircle className="spin" size={15} /> : <Square size={15} />}</button>
            : <button className="icon-button" type="button" title={t('启动', 'Start')} disabled={Boolean(busy)} onClick={() => void perform(`start-${instance.id}`, () => api.startManagedClientInstance(instance.id))}>{busy === `start-${instance.id}` ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}</button>}
          <button className="icon-button" type="button" title={t('编辑', 'Edit')} disabled={Boolean(busy) || Boolean(instance.processAlive)} onClick={() => setDraft(instance)}>•••</button>
          <button className="icon-button" type="button" title={t('删除定义', 'Delete definition')} disabled={Boolean(busy) || Boolean(instance.processAlive)} onClick={() => void perform(`delete-${instance.id}`, () => api.deleteManagedClientInstance(instance.id))}><Trash2 size={15} /></button>
        </article>
      })}
    </div>
    <Modal open={Boolean(draft)} title={draft?.id ? t('编辑客户端实例', 'Edit client instance') : t('添加客户端实例', 'Add client instance')} onClose={() => setDraft(null)}>
      {draft && <form className="managed-instance-form" onSubmit={(event) => {
        event.preventDefault()
        void perform('save-instance', () => api.saveManagedClientInstance(draft)).then((saved) => { if (saved) setDraft(null) })
      }}>
        <label><span>{t('名称', 'Name')}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>{t('客户端', 'Client')}</span><select value={draft.client} onChange={(event) => { const client = event.target.value as RouteClient; setDraft({ ...draft, client, routeId: snapshot.routes.find((route) => route.client === client)?.id, profileId: snapshot.clientProfiles.find((profile) => profile.client === client)?.id }) }}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option></select></label>
        <label><span>{t('独立配置目录', 'Isolated config directory')}</span><input value={draft.configDirectory} disabled={Boolean(draft.profileId && snapshot.clientProfiles.find((profile) => profile.id === draft.profileId)?.directory)} onChange={(event) => setDraft({ ...draft, configDirectory: event.target.value })} /></label>
        <label><span>{t('工作目录', 'Working directory')}</span><input value={draft.workingDirectory ?? ''} onChange={(event) => setDraft({ ...draft, workingDirectory: event.target.value })} /></label>
        <label><span>{t('可执行文件', 'Executable')}</span><input value={draft.executablePath ?? ''} onChange={(event) => setDraft({ ...draft, executablePath: event.target.value })} /></label>
        <label><span>{t('启动方式', 'Launch mode')}</span><select value={draft.launchMode ?? defaultManagedLaunchMode} onChange={(event) => setDraft({ ...draft, launchMode: event.target.value as 'terminal' | 'background' })}><option value="terminal">{t('可见交互终端', 'Visible interactive terminal')}</option><option value="background">{t('后台非交互', 'Background non-interactive')}</option></select></label>
        <label><span>{t('启动参数（每行一个）', 'Launch arguments (one per line)')}</span><textarea value={draft.launchArgs?.join('\n') ?? ''} onChange={(event) => setDraft({ ...draft, launchArgs: event.target.value.split('\n') })} /></label>
        <label><span>{t('绑定路由', 'Bound route')}</span><select value={draft.routeId ?? ''} onChange={(event) => setDraft({ ...draft, routeId: event.target.value || undefined })}><option value="">—</option>{snapshot.routes.filter((route) => route.client === draft.client).map((route) => <option key={route.id} value={route.id}>{route.client}</option>)}</select></label>
        <label><span>{t('绑定配置', 'Bound profile')}</span><select value={draft.profileId ?? ''} onChange={(event) => { const profile = snapshot.clientProfiles.find((candidate) => candidate.id === event.target.value); setDraft({ ...draft, profileId: profile?.id, configDirectory: profile?.directory ?? draft.configDirectory }) }}><option value="">—</option>{snapshot.clientProfiles.filter((profile) => profile.client === draft.client).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" disabled={busy === 'save-instance'}>{busy === 'save-instance' && <LoaderCircle className="spin" size={15} />}{t('保存实例', 'Save instance')}</button></footer>
      </form>}
    </Modal>
  </section>
}
