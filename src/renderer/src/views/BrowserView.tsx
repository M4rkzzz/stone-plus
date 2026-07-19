import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Archive,
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
  AccountImportProgress,
  BrowserImportQueueState,
  BrowserJsonCacheState,
  ChatGptAccountImportProxyMode,
  GatewayApi,
} from '@shared/types'
import { Badge, ImportProgress, Modal } from '../ui'

const DEFAULT_URL = 'https://aiprobe.top/'
const SHORTCUTS_KEY = 'stone.builtin-browser.shortcuts.v1'
const ZOOM_KEY = 'stone.builtin-browser.zoom.v1'
const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
const EMPTY_QUEUE: BrowserImportQueueState = { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
const EMPTY_CACHE: BrowserJsonCacheState = { items: [], totalBytes: 0 }

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
  const [cache, setCache] = useState<BrowserJsonCacheState>(EMPTY_CACHE)
  const [cacheOpen, setCacheOpen] = useState(false)
  const [cacheBusyId, setCacheBusyId] = useState<string | null>(null)
  const [cacheError, setCacheError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [tagId, setTagId] = useState<string | null>(null)
  const [poolId, setPoolId] = useState<string | null>(null)
  const [proxyMode, setProxyMode] = useState<ChatGptAccountImportProxyMode>('preserve')
  const [proxyId, setProxyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<AccountImportProgress | null>(null)
  const importProgressId = useRef<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  const readyItems = useMemo(() => queue.items.filter((item) => item.status === 'ready'), [queue.items])
  const selectedReadyIds = useMemo(() => selectedIds.filter((id) => readyItems.some((item) => item.id === id)), [readyItems, selectedIds])
  const compatiblePools = useMemo(
    () => snapshot.pools.filter((pool) => pool.kind === 'standard' && pool.protocol === 'openai-responses'),
    [snapshot.pools],
  )

  useEffect(() => {
    let active = true
    const refreshCache = () => api.getBrowserJsonCache()
      .then((next) => { if (active) setCache(next) })
      .catch(() => undefined)
    void api.getBrowserImportQueue().then((next) => { if (active) setQueue(next) }).catch(() => undefined)
    void refreshCache()
    const unsubscribe = api.onBrowserImportQueue((next) => {
      if (active) setQueue(next)
      void refreshCache()
    })
    return () => { active = false; unsubscribe() }
  }, [api])

  useEffect(() => api.onAccountImportProgress((progress) => {
    if (progress.progressId === importProgressId.current) setImportProgress(progress)
  }), [api])

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
    if (!selectedReadyIds.length) { setError('请至少选择一个已下载完成的 JSON。'); return }
    const progressId = crypto.randomUUID()
    importProgressId.current = progressId
    setImportProgress({ progressId, phase: 'importing', completed: 0, total: selectedReadyIds.length, percent: 0, message: '正在准备批量导入…' })
    setBusy(true)
    setError('')
    try {
      const result = await api.importBrowserJsonQueue({
        itemIds: selectedReadyIds,
        tagId,
        poolId,
        proxyMode,
        proxyId: proxyMode === 'proxy' ? proxyId : undefined,
        progressId,
      })
      const succeeded = result.fileResults.filter((item) => item.status === 'imported').length
      const failed = result.fileResults.filter((item) => item.status === 'failed')
      const modelsRefreshed = result.detectionResults.filter((item) => item.availableModelCount !== undefined).length
      const modelFailures = result.detectionResults.filter((item) => item.modelRefreshError)
      setNotice(`批量导入完成：文件成功 ${succeeded} 个、失败 ${failed.length} 个；新增 ${result.createdAccountIds.length} 个账号、更新 ${result.updatedAccountIds.length} 个账号；检测成功 ${result.detectionResults.filter((item) => item.ok).length} 个，Tag 覆盖 ${result.assignmentSummary.tagUpdatedAccountCount} 个，加入号池 ${result.assignmentSummary.poolMembersAdded} 个；模型刷新成功 ${modelsRefreshed} 个、失败 ${modelFailures.length} 个。${result.assignmentSummary.poolAppendError ? ` 号池追加失败：${result.assignmentSummary.poolAppendError}。` : ''}${failed[0]?.error ? ` ${failed[0].fileName}：${failed[0].error}` : modelFailures[0]?.modelRefreshError ? ` ${modelFailures[0].accountName}：${modelFailures[0].modelRefreshError}` : ''}`)
      setImportOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '挂起 JSON 批量导入失败')
    } finally {
      importProgressId.current = null
      setImportProgress(null)
      setBusy(false)
    }
  }

  const removeQueueItem = async (id: string): Promise<void> => {
    setQueue(await api.removeBrowserImportItem(id))
    setSelectedIds((current) => current.filter((candidate) => candidate !== id))
  }

  const openCache = async (): Promise<void> => {
    setCacheError('')
    setCacheOpen(true)
    try {
      setCache(await api.getBrowserJsonCache())
    } catch (cause) {
      setCacheError(cause instanceof Error ? cause.message : '无法读取下载缓存')
    }
  }

  const saveCachedItem = async (id: string): Promise<void> => {
    setCacheBusyId(id)
    setCacheError('')
    try {
      const result = await api.saveBrowserJsonCacheItem(id)
      if (!result.cancelled) setNotice('缓存 JSON 已另存。')
    } catch (cause) {
      setCacheError(cause instanceof Error ? cause.message : '缓存 JSON 另存失败')
    } finally {
      setCacheBusyId(null)
    }
  }

  const removeCachedItem = async (id: string): Promise<void> => {
    setCacheBusyId(id)
    setCacheError('')
    try {
      setCache(await api.removeBrowserJsonCacheItem(id))
    } catch (cause) {
      setCacheError(cause instanceof Error ? cause.message : '删除缓存失败')
    } finally {
      setCacheBusyId(null)
    }
  }

  const clearCache = async (): Promise<void> => {
    if (!window.confirm('确定清空全部已下载 JSON 缓存吗？此操作不会删除已导入的账号。')) return
    setCacheBusyId('clear')
    setCacheError('')
    try {
      setCache(await api.clearBrowserJsonCache())
    } catch (cause) {
      setCacheError(cause instanceof Error ? cause.message : '清空缓存失败')
    } finally {
      setCacheBusyId(null)
    }
  }

  const proxyValue = proxyMode === 'preserve' ? '__preserve__' : proxyMode === 'direct' ? '__direct__' : proxyId

  return <div className="page-stack builtin-browser-page">
    <section className={`browser-import-banner ${queue.readyCount ? 'browser-import-banner--active' : ''}`}>
      <span className="browser-import-banner__icon"><FileJson size={20} /></span>
      <div>
        <strong>{queue.readyCount ? `已挂起 ${queue.readyCount} 个 JSON` : '暂无挂起 JSON'}</strong>
        <span>{queue.items.some((item) => item.status === 'downloading') ? '仍有文件正在下载；可继续下载，完成后一次导入。' : '在网页中下载 JSON 后会自动加入这里，可稍后统一确认。'}</span>
      </div>
      <div className="browser-import-banner__actions">
        <button type="button" className="text-button browser-cache-button" disabled={busy} onClick={() => void openCache()}><Archive size={14} />缓存{cache.items.length ? ` ${cache.items.length}` : ''}</button>
        {queue.items.length > 0 && <button type="button" className="text-button button--danger-text" disabled={busy} onClick={() => void api.clearBrowserImportQueue().then(setQueue)}>清空</button>}
        <button type="button" className="button button--primary" disabled={!queue.readyCount || busy} onClick={openImport}><Download size={16} />确认导入</button>
      </div>
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

    <Modal open={cacheOpen} title={`下载缓存（${cache.items.length}）`} description="内置浏览器下载过的有效 JSON 会保存在本机缓存，导入或清空挂起队列后仍可另存。" width="large" onClose={() => setCacheOpen(false)} footer={<>
      <span className="modal-selection-count">共 {formatBytes(cache.totalBytes)}</span>
      {cache.items.length > 0 && <button type="button" className="button button--secondary button--danger-text" disabled={cacheBusyId !== null} onClick={() => void clearCache()}><Trash2 size={15} />清空缓存</button>}
      <button type="button" className="button button--secondary" disabled={cacheBusyId !== null} onClick={() => setCacheOpen(false)}>关闭</button>
    </>}>
      <div className="browser-cache-modal">
        {cacheError && <div className="client-config-message error-banner"><XCircle size={16} /><span>{cacheError}</span></div>}
        {cache.items.length ? <div className="browser-import-list">
          {cache.items.map((item) => <div className="browser-cache-item" key={item.id}>
            <FileJson size={18} />
            <div><strong>{item.fileName}</strong><span>{formatCacheTime(item.receivedAt)} · {formatBytes(item.sizeBytes)}</span></div>
            <button type="button" className="button button--secondary" disabled={cacheBusyId !== null} onClick={() => void saveCachedItem(item.id)}>{cacheBusyId === item.id ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}另存为</button>
            <button type="button" className="icon-button button--danger-text" disabled={cacheBusyId !== null} title="删除缓存" onClick={() => void removeCachedItem(item.id)}><Trash2 size={15} /></button>
          </div>)}
        </div> : <div className="browser-cache-empty"><Archive size={24} /><strong>暂无下载缓存</strong><span>在内置浏览器下载有效 JSON 后会自动保留一份。</span></div>}
      </div>
    </Modal>

    <Modal open={importOpen} title={`导入 Sub2API / CPA（${selectedReadyIds.length}/${readyItems.length}）`} description="粘贴、文件和 Browser Queue 共用同一套 Tag、号池与出口设置。成功导入的文件会自动从挂起队列移除。" width="large" closable={!busy} onClose={() => setImportOpen(false)} footer={<>
      <span className="modal-selection-count">已选 {selectedReadyIds.length} 个，共 {formatBytes(readyItems.filter((item) => selectedReadyIds.includes(item.id)).reduce((total, item) => total + item.sizeBytes, 0))}</span>
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => setImportOpen(false)}>继续下载</button>
      <button type="button" className="button button--primary" disabled={busy || !selectedReadyIds.length || (proxyMode === 'proxy' && !proxyId)} onClick={() => void importSelected()}>{busy ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}{busy ? '正在导入并检测…' : '导入所选 JSON'}</button>
    </>}>
      <div className="browser-import-modal">
        <div className="form-grid">
          <label className="field"><span>本批次 Tag</span><select value={tagId ?? ''} onChange={(event) => setTagId(event.target.value || null)}><option value="">未标记（同时清空重复账号的 Tag）</option>{snapshot.accountTags.map((tag) => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select></label>
          <label className="field"><span>导入后加入号池（可选）</span><select value={poolId ?? ''} onChange={(event) => setPoolId(event.target.value || null)}><option value="">不加入号池</option>{compatiblePools.map((pool) => <option value={pool.id} key={pool.id}>{pool.name} · {pool.members.length} 个成员 · {pool.strategy}</option>)}</select></label>
          <label className="field field--full"><span>批量出口代理</span><select value={proxyValue} onChange={(event) => {
            const value = event.target.value
            if (value === '__preserve__') { setProxyMode('preserve'); setProxyId('') }
            else if (value === '__direct__') { setProxyMode('direct'); setProxyId('') }
            else { setProxyMode('proxy'); setProxyId(value) }
          }}><option value="__preserve__">不指定 / 沿用 JSON 配置</option><option value="__direct__">直连（清除 JSON 代理）</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}</select><small>{proxyMode === 'proxy' ? '本批账号统一使用所选代理，导入后的状态刷新与模型查询也走该代理。' : proxyMode === 'direct' ? '本批账号全部直连，并清除 JSON 中的代理设置。' : '保留 JSON 内仍有效的 proxyId；没有有效代理时使用直连。'}</small></label>
        </div>
        {busy && importProgress && <ImportProgress progress={importProgress} />}
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

function formatCacheTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
