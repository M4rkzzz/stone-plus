import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  Globe2,
  Home,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  ZoomIn,
  XCircle,
} from 'lucide-react'
import type {
  AppSnapshot,
  BrowserImportQueueState,
  ChatGptAccountImportProxyMode,
  GatewayApi,
} from '@shared/types'
import { Badge, Modal } from '../ui'

const DEFAULT_URL = 'https://aiprobe.top/'
const SHORTCUTS_KEY = 'stone.builtin-browser.shortcuts.v1'
const ZOOM_KEY = 'stone.builtin-browser.zoom.v1'
const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
const EMPTY_QUEUE: BrowserImportQueueState = { items: [], readyCount: 0, totalBytes: 0, revision: 0 }

interface BrowserShortcut {
  id: string
  name: string
  url: string
}

interface EmbeddedWebview extends HTMLElement {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getWebContentsId(): number
  setZoomFactor(factor: number): void
}

interface BrowserTab {
  id: string
  title: string
  url: string
  address: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type NavigationEvent = Event & { url?: string }
type PageTitleEvent = Event & { title?: string }

export function BrowserView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [createBrowserTab(DEFAULT_URL)])
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)
  const webviewsRef = useRef(new Map<string, EmbeddedWebview>())
  const [zoom, setZoom] = useState(loadZoom)
  const [shortcuts, setShortcuts] = useState<BrowserShortcut[]>(loadShortcuts)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [shortcutDraft, setShortcutDraft] = useState({ name: '', url: '' })
  const [queue, setQueue] = useState<BrowserImportQueueState>(EMPTY_QUEUE)
  const [importOpen, setImportOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [providerId, setProviderId] = useState(
    snapshot.providers.find((provider) => provider.kind === 'openai' && provider.protocol === 'openai-responses')?.id ?? '',
  )
  const [proxyMode, setProxyMode] = useState<ChatGptAccountImportProxyMode>('preserve')
  const [proxyId, setProxyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  const readyItems = useMemo(() => queue.items.filter((item) => item.status === 'ready'), [queue.items])
  const selectedReadyIds = useMemo(() => selectedIds.filter((id) => readyItems.some((item) => item.id === id)), [readyItems, selectedIds])
  const openAiProviders = useMemo(
    () => snapshot.providers.filter((provider) => provider.kind === 'openai' && provider.protocol === 'openai-responses'),
    [snapshot.providers],
  )

  useEffect(() => {
    void api.getBrowserImportQueue().then(setQueue).catch(() => undefined)
    return api.onBrowserImportQueue(setQueue)
  }, [api])

  const updateTab = useCallback((id: string, patch: Partial<BrowserTab>): void => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab))
  }, [])

  const registerWebview = useCallback((id: string, webview: EmbeddedWebview | null): void => {
    if (webview) webviewsRef.current.set(id, webview)
    else webviewsRef.current.delete(id)
  }, [])

  const openTab = useCallback((value = DEFAULT_URL): void => {
    if (!isHttpUrl(value)) return
    const tab = createBrowserTab(value)
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
  }, [])

  useEffect(() => api.onBrowserOpenTab((request) => {
    const belongsToThisBrowser = [...webviewsRef.current.values()]
      .some((webview) => webview.getWebContentsId() === request.guestId)
    if (belongsToThisBrowser && isHttpUrl(request.url)) openTab(request.url)
  }), [api, openTab])

  useEffect(() => {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts))
  }, [shortcuts])

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(zoom))
  }, [zoom])

  const navigate = (value: string): void => {
    try {
      const url = normalizeUrl(value)
      updateTab(activeTab.id, { address: url, url })
      setError('')
      void webviewsRef.current.get(activeTab.id)?.loadURL(url).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '网址无效')
    }
  }

  const submitAddress = (event: FormEvent): void => {
    event.preventDefault()
    navigate(activeTab.address)
  }

  const closeTab = (id: string): void => {
    if (tabs.length <= 1) return
    const closingIndex = tabs.findIndex((tab) => tab.id === id)
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    if (activeTabId === id) {
      setActiveTabId(remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)].id)
    }
  }

  const saveShortcut = (event: FormEvent): void => {
    event.preventDefault()
    try {
      const url = normalizeUrl(shortcutDraft.url)
      const name = shortcutDraft.name.trim() || new URL(url).hostname
      setShortcuts((current) => [...current, { id: crypto.randomUUID(), name: name.slice(0, 30), url }])
      setShortcutDraft({ name: '', url: '' })
      setShortcutOpen(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '快捷入口网址无效')
    }
  }

  const openImport = (): void => {
    setSelectedIds(readyItems.map((item) => item.id))
    setError('')
    setImportOpen(true)
  }

  const importSelected = async (): Promise<void> => {
    if (!providerId) { setError('请选择 OpenAI Responses Provider。'); return }
    if (!selectedReadyIds.length) { setError('请至少选择一个已下载完成的 JSON。'); return }
    setBusy(true)
    setError('')
    try {
      const result = await api.importBrowserJsonQueue({
        itemIds: selectedReadyIds,
        providerId,
        proxyMode,
        proxyId: proxyMode === 'proxy' ? proxyId : undefined,
      })
      const succeeded = result.fileResults.filter((item) => item.status === 'imported').length
      const failed = result.fileResults.filter((item) => item.status === 'failed')
      setNotice(`批量导入完成：文件成功 ${succeeded} 个、失败 ${failed.length} 个；新增 ${result.createdAccountIds.length} 个账号、更新 ${result.updatedAccountIds.length} 个账号。${failed[0]?.error ? ` ${failed[0].fileName}：${failed[0].error}` : ''}`)
      setImportOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '挂起 JSON 批量导入失败')
    } finally {
      setBusy(false)
    }
  }

  const removeQueueItem = async (id: string): Promise<void> => {
    setQueue(await api.removeBrowserImportItem(id))
    setSelectedIds((current) => current.filter((candidate) => candidate !== id))
  }

  const proxyValue = proxyMode === 'preserve' ? '__preserve__' : proxyMode === 'direct' ? '__direct__' : proxyId

  return <div className="page-stack builtin-browser-page">
    <section className={`browser-import-banner ${queue.readyCount ? 'browser-import-banner--active' : ''}`}>
      <span className="browser-import-banner__icon"><FileJson size={20} /></span>
      <div>
        <strong>{queue.readyCount ? `已挂起 ${queue.readyCount} 个 JSON` : '暂无挂起 JSON'}</strong>
        <span>{queue.items.some((item) => item.status === 'downloading') ? '仍有文件正在下载；可继续下载，完成后一次导入。' : '在网页中下载 JSON 后会自动加入这里，可稍后统一确认。'}</span>
      </div>
      {queue.items.length > 0 && <button type="button" className="text-button button--danger-text" disabled={busy} onClick={() => void api.clearBrowserImportQueue().then(setQueue)}>清空</button>}
      <button type="button" className="button button--primary" disabled={!queue.readyCount || busy} onClick={openImport}><Download size={16} />确认导入</button>
    </section>

    {notice && <div className="client-config-notice"><CheckCircle2 size={16} /><span>{notice}</span></div>}
    {error && !importOpen && <div className="client-config-message error-banner"><XCircle size={16} /><span>{error}</span></div>}

    <section className="builtin-browser panel panel--flush">
      <div className="builtin-browser__shortcuts">
        {shortcuts.map((shortcut) => <div className="browser-shortcut" key={shortcut.id}>
          <button type="button" className={activeTab.url.startsWith(shortcut.url) ? 'active' : ''} onClick={() => navigate(shortcut.url)} title={shortcut.url}>
            <Globe2 size={14} /><span>{shortcut.name}</span>
          </button>
          <button type="button" className="browser-shortcut__remove" aria-label={`删除 ${shortcut.name}`} onClick={() => setShortcuts((current) => current.filter((item) => item.id !== shortcut.id))}><XCircle size={13} /></button>
        </div>)}
        <button type="button" className="browser-shortcut-add" onClick={() => setShortcutOpen(true)}><Plus size={14} />添加</button>
      </div>
      <div className="builtin-browser__tabs" role="tablist" aria-label="浏览器标签页">
        {tabs.map((tab) => <button
          type="button"
          role="tab"
          aria-selected={tab.id === activeTab.id}
          className={`browser-tab ${tab.id === activeTab.id ? 'browser-tab--active' : ''}`}
          key={tab.id}
          onClick={() => setActiveTabId(tab.id)}
          title={`${tab.title}\n${tab.url}`}
        >
          {tab.loading ? <LoaderCircle size={13} className="spin" /> : <Globe2 size={13} />}
          <span>{tab.title}</span>
          <span
            role="button"
            aria-label={`关闭 ${tab.title}`}
            aria-disabled={tabs.length <= 1}
            className={`browser-tab__close ${tabs.length <= 1 ? 'disabled' : ''}`}
            onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
          ><XCircle size={13} /></span>
        </button>)}
        <button type="button" className="browser-tab-add" title="新建标签页" aria-label="新建标签页" onClick={() => openTab()}><Plus size={15} /></button>
      </div>
      <div className="builtin-browser__toolbar">
        <button type="button" className="icon-button" disabled={!activeTab.canGoBack} title="后退" onClick={() => webviewsRef.current.get(activeTab.id)?.goBack()}><ArrowLeft size={17} /></button>
        <button type="button" className="icon-button" disabled={!activeTab.canGoForward} title="前进" onClick={() => webviewsRef.current.get(activeTab.id)?.goForward()}><ArrowRight size={17} /></button>
        <button type="button" className="icon-button" title="主页" onClick={() => navigate(DEFAULT_URL)}><Home size={16} /></button>
        <button type="button" className="icon-button" title={activeTab.loading ? '停止' : '刷新'} onClick={() => activeTab.loading ? webviewsRef.current.get(activeTab.id)?.stop() : webviewsRef.current.get(activeTab.id)?.reload()}>{activeTab.loading ? <XCircle size={16} /> : <RotateCw size={16} />}</button>
        <form className="builtin-browser__address" onSubmit={submitAddress}>
          <Globe2 size={15} />
          <input aria-label="网址" value={activeTab.address} onChange={(event) => updateTab(activeTab.id, { address: event.target.value })} spellCheck={false} />
          {activeTab.loading && <LoaderCircle size={15} className="spin" />}
        </form>
        <button type="button" className="icon-button" title="转到" onClick={() => navigate(activeTab.address)}><ExternalLink size={16} /></button>
        <label className="browser-zoom" title="页面显示比例"><ZoomIn size={15} /><select aria-label="页面显示比例" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{ZOOM_LEVELS.map((level) => <option value={level} key={level}>{level}%</option>)}</select></label>
      </div>
      <div className="builtin-browser__viewport">
        {tabs.map((tab) => <BrowserTabPane
          key={tab.id}
          tab={tab}
          active={tab.id === activeTab.id}
          zoom={zoom}
          onUpdate={updateTab}
          onReady={registerWebview}
        />)}
      </div>
    </section>

    <Modal open={shortcutOpen} title="添加快捷入口" description="保存常用网站，之后可在浏览器顶部一键打开。" onClose={() => setShortcutOpen(false)} footer={<>
      <button type="button" className="button button--secondary" onClick={() => setShortcutOpen(false)}>取消</button>
      <button type="submit" form="browser-shortcut-form" className="button button--primary"><Plus size={16} />添加</button>
    </>}>
      <form id="browser-shortcut-form" className="form-grid" onSubmit={saveShortcut}>
        <label className="field field--full"><span>名称</span><input value={shortcutDraft.name} maxLength={30} placeholder="例如 AIProbe" onChange={(event) => setShortcutDraft({ ...shortcutDraft, name: event.target.value })} /></label>
        <label className="field field--full"><span>网址</span><input required value={shortcutDraft.url} placeholder="https://example.com/" onChange={(event) => setShortcutDraft({ ...shortcutDraft, url: event.target.value })} /></label>
      </form>
    </Modal>

    <Modal open={importOpen} title={`批量导入挂起 JSON（${selectedReadyIds.length}/${readyItems.length}）`} description="可选择部分文件，并为本批账号统一指定出口代理。成功导入的文件会自动从挂起队列移除。" width="large" closable={!busy} onClose={() => setImportOpen(false)} footer={<>
      <span className="modal-selection-count">已选 {selectedReadyIds.length} 个，共 {formatBytes(readyItems.filter((item) => selectedReadyIds.includes(item.id)).reduce((total, item) => total + item.sizeBytes, 0))}</span>
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => setImportOpen(false)}>继续下载</button>
      <button type="button" className="button button--primary" disabled={busy || !selectedReadyIds.length || !providerId || (proxyMode === 'proxy' && !proxyId)} onClick={() => void importSelected()}>{busy ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}{busy ? '正在导入并检测…' : '导入所选 JSON'}</button>
    </>}>
      <div className="browser-import-modal">
        <div className="form-grid">
          <label className="field field--full"><span>OpenAI Responses Provider</span><select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">选择 Provider</option>{openAiProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select><small>导入后的 ChatGPT / Codex 账号归属到该 Provider。</small></label>
          <label className="field field--full"><span>批量出口代理</span><select value={proxyValue} onChange={(event) => {
            const value = event.target.value
            if (value === '__preserve__') { setProxyMode('preserve'); setProxyId('') }
            else if (value === '__direct__') { setProxyMode('direct'); setProxyId('') }
            else { setProxyMode('proxy'); setProxyId(value) }
          }}><option value="__preserve__">不指定 / 沿用 JSON 配置</option><option value="__direct__">直连（清除 JSON 代理）</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}</select><small>{proxyMode === 'proxy' ? '本批账号统一使用所选代理，导入后的账号检测也走该代理。' : proxyMode === 'direct' ? '本批账号全部直连，并清除 JSON 中的代理设置。' : '保留 JSON 内仍有效的 proxyId；没有有效代理时使用直连。'}</small></label>
        </div>
        {error && <div className="client-config-message error-banner"><XCircle size={16} /><span>{error}</span></div>}
        <div className="browser-import-list">
          <div className="browser-import-list__head"><label><input type="checkbox" checked={readyItems.length > 0 && selectedReadyIds.length === readyItems.length} onChange={(event) => setSelectedIds(event.target.checked ? readyItems.map((item) => item.id) : [])} />全选已完成文件</label><span>{queue.items.length} 个记录</span></div>
          {queue.items.map((item) => <div className={`browser-import-item browser-import-item--${item.status}`} key={item.id}>
            <input type="checkbox" disabled={item.status !== 'ready' || busy} checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            <FileJson size={18} />
            <div><strong>{item.fileName}</strong><span>{item.sourceUrl || '未知来源'} · {formatBytes(item.sizeBytes)}</span>{item.error && <small>{item.error}</small>}</div>
            <Badge tone={item.status === 'ready' ? 'success' : item.status === 'failed' ? 'danger' : 'warning'}>{item.status === 'ready' ? '待导入' : item.status === 'failed' ? '失败' : '下载中'}</Badge>
            <button type="button" className="icon-button button--danger-text" disabled={busy} title="移除" onClick={() => void removeQueueItem(item.id)}><Trash2 size={15} /></button>
          </div>)}
        </div>
      </div>
    </Modal>
  </div>
}

function BrowserTabPane({
  tab,
  active,
  zoom,
  onUpdate,
  onReady,
}: {
  tab: BrowserTab
  active: boolean
  zoom: number
  onUpdate: (id: string, patch: Partial<BrowserTab>) => void
  onReady: (id: string, webview: EmbeddedWebview | null) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<EmbeddedWebview | null>(null)
  const webviewReadyRef = useRef(false)
  const initialUrlRef = useRef(tab.url)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!window.stone) {
      host.innerHTML = '<div class="builtin-browser__preview"><strong>内置浏览器仅在桌面应用中运行</strong><span>桌面版会在这里加载独立沙箱浏览器。</span></div>'
      return
    }

    const webview = document.createElement('webview') as EmbeddedWebview
    webview.className = 'builtin-browser__webview'
    webview.setAttribute('partition', 'persist:stone-browser')
    webview.setAttribute('allowpopups', 'true')
    webview.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes')

    const syncNavigation = (event?: NavigationEvent): void => {
      const nextUrl = event?.url || webview.getURL() || initialUrlRef.current
      onUpdate(tab.id, {
        url: nextUrl,
        address: nextUrl,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      })
    }
    const startLoading = (): void => onUpdate(tab.id, { loading: true })
    const stopLoading = (): void => {
      onUpdate(tab.id, { loading: false })
      syncNavigation()
    }
    const updateTitle = (event: PageTitleEvent): void => {
      const title = event.title?.trim()
      if (title) onUpdate(tab.id, { title: title.slice(0, 80) })
    }
    const applyZoom = (): void => {
      webviewReadyRef.current = true
      webview.setZoomFactor(zoomRef.current / 100)
    }

    webview.addEventListener('did-navigate', syncNavigation as EventListener)
    webview.addEventListener('did-navigate-in-page', syncNavigation as EventListener)
    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    webview.addEventListener('did-fail-load', stopLoading)
    webview.addEventListener('page-title-updated', updateTitle as EventListener)
    webview.addEventListener('did-attach', applyZoom)
    webview.addEventListener('dom-ready', applyZoom)
    webview.setAttribute('src', initialUrlRef.current)
    host.replaceChildren(webview)
    webviewRef.current = webview
    onReady(tab.id, webview)

    return () => {
      onReady(tab.id, null)
      webviewReadyRef.current = false
      webviewRef.current = null
      webview.remove()
    }
  }, [onReady, onUpdate, tab.id])

  useEffect(() => {
    if (webviewReadyRef.current) webviewRef.current?.setZoomFactor(zoom / 100)
  }, [zoom])

  return <div
    ref={hostRef}
    className={`builtin-browser__tab-pane ${active ? 'builtin-browser__tab-pane--active' : ''}`}
    aria-hidden={!active}
  />
}

function createBrowserTab(url: string): BrowserTab {
  let title = '新标签页'
  try {
    title = new URL(url).hostname || title
  } catch {
    // URL is validated before tabs are created.
  }
  return {
    id: crypto.randomUUID(),
    title,
    url,
    address: url,
    loading: true,
    canGoBack: false,
    canGoForward: false,
  }
}

function loadZoom(): number {
  const value = Number(localStorage.getItem(ZOOM_KEY))
  return ZOOM_LEVELS.includes(value) ? value : 100
}

function loadShortcuts(): BrowserShortcut[] {
  const fallback = [{ id: 'aiprobe-default', name: 'AIProbe', url: DEFAULT_URL }]
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '') as unknown
    if (!Array.isArray(parsed)) return fallback
    const valid = parsed.filter((item): item is BrowserShortcut => Boolean(
      item && typeof item === 'object' && typeof (item as BrowserShortcut).id === 'string'
      && typeof (item as BrowserShortcut).name === 'string' && isHttpUrl((item as BrowserShortcut).url),
    )).slice(0, 30)
    return valid.length ? valid : fallback
  } catch {
    return fallback
  }
}

function normalizeUrl(value: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  if (!isHttpUrl(candidate)) throw new Error('仅支持 http:// 或 https:// 网址。')
  return new URL(candidate).toString()
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
