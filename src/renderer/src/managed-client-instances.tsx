import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderCog, LoaderCircle, Play, Plus, Square, Trash2 } from 'lucide-react'
import type { AppSnapshot, GatewayApi, ManagedClientInstance, ManagedClientInstanceInput, ManagedClientInstanceStatus, RouteClient } from '@shared/types'
import { clientBrandMeta } from './brand-icons'
import { useI18n } from './i18n'
import { Modal } from './ui'
import { ExclusiveAsyncOperation, StartOrderedAsyncValue } from './async-operation'

const defaultManagedLaunchMode = typeof window === 'undefined' || !window.stone || window.stonePlatform === 'win32' ? 'terminal' : 'background'

type Translator = <T>(chinese: T, english: T) => T

export function managedInstanceStatusLabel(status: ManagedClientInstanceStatus, t: Translator): string {
  const labels: Record<ManagedClientInstanceStatus, readonly [string, string]> = {
    stopped: ['已停止', 'Stopped'],
    starting: ['正在启动', 'Starting'],
    running: ['运行中', 'Running'],
    stopping: ['正在停止', 'Stopping'],
    failed: ['操作失败', 'Failed'],
  }
  return t(...labels[status])
}

function managedInstanceError(cause: unknown, t: Translator): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/timed?\s*out|timeout/i.test(message)) return t('客户端实例未在预期时间内响应，请检查进程状态后重试。', 'The client instance did not respond in time. Check its process state, then try again.')
  return message || t('客户端实例操作失败，请重试。', 'The client instance operation failed. Try again.')
}

export function ManagedClientInstancesPanel({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const { t } = useI18n()
  const [instances, setInstances] = useState<ManagedClientInstance[]>([])
  const [draft, setDraft] = useState<ManagedClientInstanceInput | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const instanceUpdates = useRef<StartOrderedAsyncValue<ManagedClientInstance[]> | null>(null)
  const instanceMutation = useRef(new ExclusiveAsyncOperation())
  if (!instanceUpdates.current) {
    instanceUpdates.current = new StartOrderedAsyncValue<ManagedClientInstance[]>((next) => setInstances(next))
  }
  const load = useCallback(() => {
    if (instanceMutation.current.busy) return
    void instanceUpdates.current?.run(() => api.listManagedClientInstances())
      .then(() => setLoadError(null))
      .catch((cause) => setLoadError(managedInstanceError(cause, t)))
  }, [api, t])
  useEffect(() => {
    load()
    const unsubscribe = api.onManagedClientInstancesChanged((next) => {
      instanceUpdates.current?.push(next)
    })
    const timer = setInterval(load, 2_000)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [api, load])

  useEffect(() => {
    setDraft((current) => {
      if (!current?.profileId) return current
      const profile = snapshot.clientProfiles.find((candidate) => candidate.id === current.profileId && candidate.client === current.client)
      if (!profile) return { ...current, profileId: undefined }
      if (profile.directory && profile.directory !== current.configDirectory) {
        return { ...current, configDirectory: profile.directory }
      }
      return current
    })
  }, [snapshot.clientProfiles])

  const perform = async (key: string, operation: () => Promise<ManagedClientInstance[]>) => {
    const outcome = await instanceMutation.current.run(async () => {
      setBusy(key); setError(null); setNotice(null)
      try {
        return await instanceUpdates.current!.run(operation)
      } catch (cause) { setError(managedInstanceError(cause, t)); return false }
      finally { setBusy(null) }
    })
    return outcome.started ? outcome.value : false
  }
  const create = (client: RouteClient = 'codex') => {
    const profile = snapshot.clientProfiles.find((candidate) => candidate.client === client)
    setDraft({
      name: t('新客户端实例', 'New client instance'), client, configDirectory: profile?.directory ?? '', launchArgs: [], launchMode: defaultManagedLaunchMode,
      routeId: snapshot.routes.find((route) => route.client === client)?.id,
      profileId: profile?.id,
    })
  }
  const startInstance = async (instance: ManagedClientInstance) => {
    const next = await perform(`start-${instance.id}`, () => api.startManagedClientInstance(instance.id))
    if (!next) return
    const updated = next.find((candidate) => candidate.id === instance.id)
    if (updated?.processAlive || updated?.status === 'running') {
      setNotice(t(`${instance.name} 已启动`, `${instance.name} started`))
    } else {
      setError(t(`${instance.name} 的启动调用已完成，但未检测到运行进程。`, `The start request for ${instance.name} completed, but no running process was detected.`))
    }
  }
  const stopInstance = async (instance: ManagedClientInstance) => {
    const next = await perform(`stop-${instance.id}`, () => api.stopManagedClientInstance(instance.id))
    if (!next) return
    const updated = next.find((candidate) => candidate.id === instance.id)
    if (updated && !updated.processAlive && updated.status === 'stopped') {
      setNotice(t(`${instance.name} 已停止`, `${instance.name} stopped`))
    } else {
      setError(t(`${instance.name} 的停止调用已完成，但进程仍在运行。`, `The stop request for ${instance.name} completed, but its process is still running.`))
    }
  }

  return <section className="managed-instances panel">
    <header className="managed-instances__header">
      <div><FolderCog size={18} /><span><strong>{t('客户端实例', 'Client instances')}</strong><small>{t('独立配置、工作目录和启动进程', 'Isolated configuration, workspace, and process')}</small></span></div>
      <button className="button button--secondary" type="button" onClick={() => create()}><Plus size={15} />{t('添加实例', 'Add instance')}</button>
    </header>
    {(error || loadError) && <div className="client-preview-error" role="alert">{error || loadError}</div>}
    {notice && <div className="client-config-notice" role="status">{notice}</div>}
    <div className="managed-instances__list">
      {instances.length === 0 ? <span className="muted">{t('尚未创建受管实例', 'No managed instances')}</span> : instances.map((instance) => {
        const brand = clientBrandMeta[instance.client]
        return <article key={instance.id}>
          <img className="managed-instance-brand" src={brand.icon} alt="" /><span><strong>{instance.name}</strong><small>{instance.stopError ?? instance.workingDirectory ?? instance.configDirectory}</small></span>
          <i className={`managed-instance-status is-${instance.status}`}>{managedInstanceStatusLabel(instance.status, t)}{instance.pid ? ` · PID ${instance.pid}` : ''}</i>
          {instance.processAlive || instance.status === 'running' || instance.status === 'stopping'
            ? <button className="icon-button" type="button" title={t('停止', 'Stop')} aria-label={t(`停止 ${instance.name}`, `Stop ${instance.name}`)} disabled={Boolean(busy)} onClick={() => void stopInstance(instance)}>{busy === `stop-${instance.id}` ? <LoaderCircle className="spin" size={15} /> : <Square size={15} />}</button>
            : <button className="icon-button" type="button" title={t('启动', 'Start')} aria-label={t(`启动 ${instance.name}`, `Start ${instance.name}`)} disabled={Boolean(busy) || instance.status === 'starting'} onClick={() => void startInstance(instance)}>{busy === `start-${instance.id}` ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}</button>}
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
        <label><span>{t('名称', 'Name')}</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>{t('客户端', 'Client')}</span><select value={draft.client} onChange={(event) => { const client = event.target.value as RouteClient; const profile = snapshot.clientProfiles.find((candidate) => candidate.client === client); setDraft({ ...draft, client, configDirectory: profile?.directory ?? '', routeId: snapshot.routes.find((route) => route.client === client)?.id, profileId: profile?.id }) }}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option><option value="grokbuild">Grok Build</option></select></label>
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
